import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {evidenceDependenciesSchema,ownerQuestionEvidenceSchema,parseEvidenceId,queryScopeSchema,sourceContextDeclarationSchema,type QueryScope} from '@mote/shared';
import {AssistantMatters} from './assistant-matters.js';
import {withinEvidenceScope,type EvidenceReader} from './evidence-reader.js';
import {decodeMemoryPrivate,encodeMemoryPrivate} from './plugins/memory-private-storage.js';
import {canonicalRecipeJson} from './recipe-contract.js';
import {combineSourceContextDependencies,sourceContextDependenciesCurrent,assertSourceContextDependencies} from './source-context-lineage.js';
import {StoreError,sha256,type Store} from './store.js';
import {taskEvidenceIds,validateTaskDependencies} from './task-evidence.js';
import type {AssertTaskCurrent} from './task-records.js';
import {TodoStore} from './todos.js';

const uuid=z.string().uuid();
const timestamp=z.string().datetime({offset:true});
const text=(max:number)=>z.string().min(1).max(max).refine(value=>value.trim().length>0,'Text cannot be blank');
const status=z.enum(['pending_confirmation','confirmed','completed','cancelled']);
const changes=z.object({
 title:text(500).optional(),status:status.optional(),
 deadline:z.object({text:text(500),at:timestamp.nullable()}).strict().nullable().optional(),
 matterId:uuid.nullable().optional(),personMemoryId:uuid.nullable().optional(),todoId:uuid.nullable().optional(),
}).strict();
const proof=ownerQuestionEvidenceSchema.extend({id:uuid,offset:z.number().int().nonnegative().safe()}).strict();
const common={commitmentId:uuid,eventId:uuid,occurredAt:timestamp.nullable(),summary:text(8000),
 evidence:z.array(proof).min(1).max(100),evidenceDependencies:evidenceDependenciesSchema,
 sourceContextDependencies:z.array(sourceContextDeclarationSchema).max(100).optional(),changes};
export const commitmentProposalSchema=z.object({...common,kind:z.enum(['commitment','progress','status','reminder'])}).strict().superRefine((value,ctx)=>{
 if(value.kind==='commitment'&&(!value.changes.title||value.changes.status==='completed'||value.changes.status==='cancelled'))
  ctx.addIssue({code:z.ZodIssueCode.custom,message:'A new commitment needs a title and cannot start completed or cancelled'});
 if(value.kind==='reminder'&&Object.keys(value.changes).length)
  ctx.addIssue({code:z.ZodIssueCode.custom,message:'A reminder cannot change commitment facts'});
 if(value.changes.status==='completed'&&value.kind!=='progress')
  ctx.addIssue({code:z.ZodIssueCode.custom,message:'Completion requires a progress event'});
});
export const commitmentCorrectionSchema=z.object({...common,targetEventId:uuid}).strict().refine(value=>Object.keys(value.changes).length>0,{message:'A correction needs a changed field'});
export type CommitmentProposal=z.infer<typeof commitmentProposalSchema>;
export type CommitmentCorrection=z.infer<typeof commitmentCorrectionSchema>;
type Body=(CommitmentProposal&{origin:'proposal'})|(CommitmentCorrection&{origin:'owner'});
type Row={seq:number;id:string;cursor_key:string;revision:number;created_at:string;updated_at:string};
type EventRow={seq:number;event_id:string;commitment_id:string;target_event_id:string|null;request_hash:string;stale:number;private_json:string|null;created_at:string};

/** Evidence-backed timeline, with no semantic extraction or effects. The caller
 * supplies the model's constrained interpretation, stable IDs and a fresh
 * authorization check. Owner corrections target a particular assertion, so a
 * later, independently evidenced progress event can still advance the state. */
export class AssistantCommitments {
 constructor(private readonly store:Store,private readonly reader:EvidenceReader,private readonly now=()=>new Date().toISOString()){}
 private transaction<T>(fn:()=>T):T{
  this.store.db.exec('SAVEPOINT assistant_commitments_write');
  try{const result=fn();this.store.db.exec('RELEASE assistant_commitments_write');return result;}
  catch(error){this.store.db.exec('ROLLBACK TO assistant_commitments_write; RELEASE assistant_commitments_write');throw error;}
 }
 private row(id:string):Row{
  const row=this.store.db.prepare('SELECT * FROM assistant_commitments WHERE id=?').get(uuid.parse(id)) as Row|undefined;
  if(!row)throw new StoreError('Commitment not found',404);return row;
 }
 private event(id:string):EventRow|undefined{return this.store.db.prepare('SELECT * FROM assistant_commitment_events WHERE event_id=?').get(id) as EventRow|undefined;}
 private ids(id:string){return this.store.db.prepare('SELECT evidence_id FROM assistant_commitment_evidence WHERE event_id=? ORDER BY evidence_id').all(id).map(row=>String(row.evidence_id));}
 private body(row:EventRow):Body{
  if(!row.private_json)throw new StoreError('Commitment event is unavailable',409);
  const raw=decodeMemoryPrivate<Body>(this.store,row.private_json);
  if(raw.origin==='owner'){const {origin,...input}=raw;return {...commitmentCorrectionSchema.parse(input),origin};}
  if(raw.origin==='proposal'){const {origin,...input}=raw;return {...commitmentProposalSchema.parse(input),origin};}
  throw new StoreError('Commitment event is unavailable',409);
 }
 private selectionAllows(id:string,selected:Set<string>,seen=new Set<string>()):boolean{
  if(selected.has(id))return true;
  if(seen.has(id))return false;seen.add(id);
  const db=this.store.db,parents:string[]=[];
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_evidence_dependencies'").get())
   parents.push(...db.prepare('SELECT evidence_id FROM material_evidence_dependencies WHERE anchor_id=?').all(id).map(row=>String(row.evidence_id)));
  const chunk=db.prepare('SELECT capture_id FROM file_chunks WHERE id=?').get(id);if(chunk)parents.push(String(chunk.capture_id));
  parents.push(...db.prepare('SELECT parent_id FROM file_evidence_links WHERE capture_id=?').all(id).map(row=>String(row.parent_id)));
  return parents.length>0&&parents.every(parent=>this.selectionAllows(parent,selected,new Set(seen)));
 }
 private valid(ids:readonly string[],scope:QueryScope):boolean{
  if(scope.kind==='selection'&&scope.sourceIds?.length===0||scope.evidenceIds?.length===0)return false;
  if(!ids.length||!this.reader.contextDependenciesAllowed(ids))return false;
  const records=this.reader.memories.readEvidence([...ids]);if(!records.length)return false;
  const selected=scope.evidenceIds===undefined?undefined:new Set(scope.evidenceIds);
  for(const record of records){
   if(!this.reader.memories.isCurrentEvidence(record.id)||record.privacy?.excluded||!withinEvidenceScope(record,scope))return false;
   if(scope.kind==='selection'&&scope.sourceIds!==undefined&&(!record.provenance?.sourceId||!scope.sourceIds.includes(record.provenance.sourceId)))return false;
   if(selected&&!this.selectionAllows(record.id,selected))return false;
  }
  const memoryIds=this.store.db.prepare(`SELECT json FROM memories WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids));
  const at=Date.parse(this.now());
  for(const row of memoryIds){const memory=JSON.parse(String(row.json));
   if(memory.status!=='published'||memory.supersededBy||memory.validFrom&&Date.parse(memory.validFrom)>at||memory.validUntil&&Date.parse(memory.validUntil)<=at)return false;
  }
  return true;
 }
 private assertValid(ids:readonly string[],scope:QueryScope){if(!this.valid(ids,scope))throw new StoreError('Commitment evidence or scope changed',409);}
 private referenceIds(value:z.infer<typeof changes>,scope:QueryScope):string[]{
  const ids:string[]=[];
  if(value.personMemoryId){
   let memory:ReturnType<EvidenceReader['memories']['get']>;
   try{memory=this.reader.memories.get(value.personMemoryId);}catch{throw new StoreError('Linked Memory is unavailable',409);}
   this.reader.assertMemoryReadable([memory]);
   ids.push(memory.id,...memory.evidenceIds);
  }
  if(value.todoId){
   let todo:ReturnType<TodoStore['get']>;
   try{todo=new TodoStore(this.store).get(value.todoId);}catch{throw new StoreError('Linked Todo is unavailable',409);}
   if(!todo.evidenceIds.length&&(scope.kind==='selection'||scope.evidenceIds!==undefined||scope.deviceId!==undefined||scope.after!==undefined||scope.before!==undefined))
    throw new StoreError('Linked Todo is outside the selected scope',409);
   ids.push(...todo.evidenceIds);
  }
  return ids;
 }
 private referencesCurrent(value:z.infer<typeof changes>,ids:readonly string[],scope:QueryScope){
  try{
   const required=taskEvidenceIds(this.store,{version:1,complete:true,ids:this.referenceIds(value,scope)});
   if(required.some(id=>!ids.includes(id)))return false;
   if(value.matterId){
    const matter=new AssistantMatters(this.store).get(value.matterId);
    if(!this.valid(ids,matter.scope))return false;
   }
   return true;
  }catch{return false;}
 }
 private visible(row:EventRow,scope:QueryScope){
  if(row.stale||!row.private_json)return false;
  const body=this.body(row),ids=this.ids(row.event_id),pins=body.sourceContextDependencies??[];
  return this.valid(ids,scope)&&this.referencesCurrent(body.changes,ids,scope)&&
   sourceContextDependenciesCurrent(this.reader.sources.contexts,pins)&&this.contextInScope(pins,ids,scope);
 }
 private contextInScope(pins:NonNullable<Body['sourceContextDependencies']>,ids:readonly string[],scope:QueryScope){
  const constrained=scope.deviceId!==undefined||scope.after!==undefined||scope.before!==undefined||scope.evidenceIds!==undefined;
  const records=constrained?this.reader.memories.readEvidence([...ids]):[];
  return pins.every(pin=>(scope.kind!=='selection'||scope.sourceIds===undefined||scope.sourceIds.includes(pin.sourceId))&&
   (!constrained||records.some(record=>record.provenance?.sourceId===pin.sourceId)));
 }
 private assertProof(input:Pick<Body,'evidence'>){
  const originals=new Map(this.reader.memories.readCurrentEvidence(input.evidence.map(item=>item.id)).map(item=>[item.id,item]));
  for(const item of input.evidence){
   const record=originals.get(item.id);
   const material=this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_evidence'").get()?
    this.store.db.prepare('SELECT block_id FROM material_evidence WHERE id=?').get(item.id):undefined;
   if(!record||record.provenance?.layer==='reference'||record.provenance?.document?.contentRole==='summary'||
    material&&['source-metadata','record-metadata'].includes(String(material.block_id))||
    record.ocrText.slice(item.offset,item.offset+item.quote.length)!==item.quote)
    throw new StoreError('Commitment proof does not match current original',409);
  }
 }
 private assertCorrectionsRead(id:string,changed:z.infer<typeof changes>,dependencies:readonly string[],pins:NonNullable<Body['sourceContextDependencies']>){
  const fields=new Set(Object.keys(changed));if(!fields.size)return;
  const provided=new Set(pins.map(pin=>canonicalRecipeJson(pin)));
  const rows=this.store.db.prepare('SELECT * FROM assistant_commitment_events WHERE commitment_id=? AND target_event_id IS NOT NULL AND stale=0 AND private_json IS NOT NULL').all(id) as EventRow[];
  for(const row of rows){
   const body=this.body(row);
   if(body.origin==='owner'&&Object.keys(body.changes).some(field=>fields.has(field))){
    const target=this.event(body.targetEventId),targetPins=target?this.body(target).sourceContextDependencies:undefined;
    if(this.ids(row.event_id).some(evidence=>!dependencies.includes(evidence))||
      combineSourceContextDependencies([body.sourceContextDependencies,targetPins]).some(pin=>!provided.has(canonicalRecipeJson(pin))))
     throw new StoreError('Commitment proposal must include the current owner correction',409);
   }
  }
 }
 private view(row:Row,scope:QueryScope){
  const rows=this.store.db.prepare('SELECT * FROM assistant_commitment_events WHERE commitment_id=? AND stale=0 AND private_json IS NOT NULL ORDER BY seq').all(row.id) as EventRow[];
  // An inaccessible correction can change the meaning of an earlier item. Do
  // not disclose a partial, misleading projection or the hidden item count.
  if(!rows.length||rows.some(item=>!this.visible(item,scope)))throw new StoreError('Commitment not found',404);
  // The public dependency contract contains UUIDs; non-UUID artifact nodes
  // remain in the internal retirement index together with their UUID roots.
  const timeline=rows.map(item=>({...this.body(item),evidenceDependencies:{version:1 as const,complete:true,ids:this.ids(item.event_id).filter(id=>Boolean(parseEvidenceId(id)))},createdAt:item.created_at}));
  const current:{title?:string;status:z.infer<typeof status>;deadline:z.infer<typeof changes>['deadline'];matterId:string|null;personMemoryId:string|null;todoId:string|null}=
   {status:'pending_confirmation',deadline:null,matterId:null,personMemoryId:null,todoId:null};
  // Corrections are timeline assertions too. Apply every event at its own
  // sequence position so a newer owner correction is not overwritten by an
  // earlier proposal that happened to be published after its target.
  for(const item of timeline)Object.assign(current,item.changes);
  if(!current.title)throw new StoreError('Commitment not found',404);
  const dueState=!current.deadline?'none':!current.deadline.at?'unknown':current.status==='completed'||current.status==='cancelled'?'closed':Date.parse(current.deadline.at)<=Date.parse(this.now())?'overdue':'upcoming';
  return {id:row.id,revision:row.revision,title:current.title,status:current.status,deadline:current.deadline,dueState,
   matterId:current.matterId,personMemoryId:current.personMemoryId,todoId:current.todoId,timeline,
   evidenceDependencies:{version:1 as const,complete:true,ids:[...new Set(timeline.flatMap(item=>item.evidenceDependencies.ids))].sort()},
   sourceContextDependencies:combineSourceContextDependencies(timeline.map(item=>item.sourceContextDependencies)),
   createdAt:row.created_at,updatedAt:row.updated_at};
 }
 private write(raw:unknown,origin:'proposal'|'owner',expectedRevision:number|undefined,rawScope:QueryScope,assertCurrent:AssertTaskCurrent,internalDependencies:readonly string[]=[]){
  const input=origin==='proposal'?commitmentProposalSchema.parse(raw):commitmentCorrectionSchema.parse(raw);
  const scope=queryScopeSchema.parse(rawScope),publicDependencies=validateTaskDependencies(input.evidenceDependencies),pins=input.sourceContextDependencies??[];
  const extra=[...new Set(internalDependencies)].sort(),dependencies=validateTaskDependencies({...publicDependencies,ids:[...publicDependencies.ids,...extra]});
  if(input.evidence.some(item=>!dependencies.ids.includes(item.id)))throw new StoreError('Commitment proof is outside its disclosure dependencies',409);
  const hash=sha256(canonicalRecipeJson({origin,...input,evidenceDependencies:publicDependencies,...(extra.length?{internalDependencies:extra}:{})}));
  return this.transaction(()=>{
   const prior=this.event(input.eventId);
   if(prior){if(prior.commitment_id!==input.commitmentId||prior.request_hash!==hash||!this.visible(prior,scope))throw new StoreError('Commitment event was reused or retired',409);return this.view(this.row(input.commitmentId),scope);}
   const existing=this.store.db.prepare('SELECT * FROM assistant_commitments WHERE id=?').get(input.commitmentId) as Row|undefined;
   if(existing){
    if(!Number.isSafeInteger(expectedRevision)||existing.revision!==expectedRevision)throw new StoreError('Commitment changed; reload before continuing',409);
    this.view(existing,scope);
    if(origin==='proposal'&&(input as CommitmentProposal).kind==='commitment')throw new StoreError('Commitment already exists',409);
    if(origin==='proposal')this.assertCorrectionsRead(input.commitmentId,input.changes,taskEvidenceIds(this.store,dependencies),pins);
   }else if(expectedRevision!==undefined||origin!=='proposal'||(input as CommitmentProposal).kind!=='commitment')throw new StoreError('Commitment not found',404);
   let target:EventRow|undefined;
   if(origin==='owner'){
    target=this.event((input as CommitmentCorrection).targetEventId);
    if(!target||target.commitment_id!==input.commitmentId||target.target_event_id||!this.visible(target,scope))throw new StoreError('Correction target is unavailable',409);
    const original=this.body(target);
    if(original.origin!=='proposal'||original.kind==='reminder'&&Object.keys(input.changes).length)throw new StoreError('A reminder cannot change commitment facts',409);
   }
   const ids=taskEvidenceIds(this.store,{version:1,complete:true,ids:[...dependencies.ids,...this.referenceIds(input.changes,scope),...(target?this.ids(target.event_id):[])]});
   this.assertValid(ids,scope);
   if(!this.referencesCurrent(input.changes,ids,scope))throw new StoreError('Commitment reference is unavailable',409);
   assertSourceContextDependencies(this.reader.sources.contexts,pins);
   if(!this.contextInScope(pins,ids,scope))throw new StoreError('Commitment context is outside the selected scope',409);
   this.assertProof(input);
   if(typeof assertCurrent!=='function')throw new StoreError('Commitment publication requires current-state validation',409);
   const checked:unknown=assertCurrent(ids);if(checked!==undefined){void Promise.resolve(checked).catch(()=>{});throw new StoreError('Commitment current-state validation must complete synchronously',409);}
   this.assertValid(ids,scope);assertSourceContextDependencies(this.reader.sources.contexts,pins);this.assertProof(input);
   if(!this.contextInScope(pins,ids,scope)||!this.referencesCurrent(input.changes,ids,scope))throw new StoreError('Commitment reference or context changed',409);
   if(existing&&this.row(input.commitmentId).revision!==expectedRevision)throw new StoreError('Commitment changed; reload before continuing',409);
   if(existing&&origin==='proposal')this.assertCorrectionsRead(input.commitmentId,input.changes,taskEvidenceIds(this.store,dependencies),pins);
   const at=this.now();
   if(existing)this.store.db.prepare('UPDATE assistant_commitments SET revision=revision+1,updated_at=? WHERE id=?').run(at,input.commitmentId);
   else this.store.db.prepare('INSERT INTO assistant_commitments(id,cursor_key,revision,created_at,updated_at) VALUES(?,?,1,?,?)').run(input.commitmentId,randomBytes(32).toString('hex'),at,at);
   this.store.db.prepare('INSERT INTO assistant_commitment_events(event_id,commitment_id,target_event_id,request_hash,private_json,created_at) VALUES(?,?,?,?,?,?)')
    .run(input.eventId,input.commitmentId,target?.event_id??null,hash,encodeMemoryPrivate(this.store,{...input,origin}),at);
   const insert=this.store.db.prepare('INSERT INTO assistant_commitment_evidence(event_id,evidence_id) VALUES(?,?)');for(const id of ids)insert.run(input.eventId,id);
   const insertContext=this.store.db.prepare('INSERT INTO assistant_commitment_context(event_id,source_id) VALUES(?,?)');for(const id of new Set(pins.map(pin=>pin.sourceId)))insertContext.run(input.eventId,id);
   this.store.reserveMetadata(0);return this.view(this.row(input.commitmentId),scope);
  });
 }
 publish(input:CommitmentProposal,expectedRevision:number|undefined,scope:QueryScope,assertCurrent:AssertTaskCurrent,internalDependencies:readonly string[]=[]){return this.write(input,'proposal',expectedRevision,scope,assertCurrent,internalDependencies);}
 correct(input:CommitmentCorrection,expectedRevision:number,scope:QueryScope,assertCurrent:AssertTaskCurrent){return this.write(input,'owner',expectedRevision,scope,assertCurrent);}
 get(id:string,scope:QueryScope){return this.transaction(()=>this.view(this.row(id),queryScopeSchema.parse(scope)));}
 private sign(row:Row,value:unknown){return createHmac('sha256',Buffer.from(row.cursor_key,'hex')).update(canonicalRecipeJson(value)).digest('hex');}
 page(args:{scope:QueryScope;limit?:number;cursor?:string;matterId?:string;personMemoryId?:string}){
  const input=z.object({scope:queryScopeSchema,limit:z.number().int().min(1).max(100).default(30),cursor:z.string().max(1000).optional(),matterId:uuid.optional(),personMemoryId:uuid.optional()}).strict().parse(args);
  return this.transaction(()=>{
   const filter=sha256(canonicalRecipeJson({scope:input.scope,matterId:input.matterId??null,personMemoryId:input.personMemoryId??null}));let before=Number.MAX_SAFE_INTEGER;
   if(input.cursor)try{
    const cursor=z.object({id:uuid,filter:z.string().length(64),signature:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(JSON.parse(Buffer.from(input.cursor,'base64url').toString()));
    const row=this.row(cursor.id),value={id:cursor.id,filter:cursor.filter};
    if(cursor.filter!==filter||!timingSafeEqual(Buffer.from(this.sign(row,value),'hex'),Buffer.from(cursor.signature,'hex')))throw Error();
    before=row.seq;
   }catch{throw new StoreError('Invalid commitment cursor');}
   const found:ReturnType<AssistantCommitments['view']>[]=[],batch=Math.max(input.limit+1,30);
   for(;;){
    const rows=this.store.db.prepare('SELECT * FROM assistant_commitments WHERE seq<? ORDER BY seq DESC LIMIT ?').all(before,batch) as Row[];
    if(!rows.length)break;
    for(const row of rows){before=row.seq;let item:ReturnType<AssistantCommitments['view']>;try{item=this.view(row,input.scope);}catch(error){if(error instanceof StoreError&&error.statusCode===404)continue;throw error;}
     if(input.matterId&&item.matterId!==input.matterId||input.personMemoryId&&item.personMemoryId!==input.personMemoryId)continue;
     found.push(item);if(found.length>input.limit)break;
    }
    if(found.length>input.limit||rows.length<batch)break;
   }
   const items=found.slice(0,input.limit),last=items.at(-1);let nextCursor:string|null=null;
   if(found.length>input.limit&&last){const row=this.row(last.id),value={id:last.id,filter};nextCursor=Buffer.from(JSON.stringify({...value,signature:this.sign(row,value)})).toString('base64url');}
   return {items,nextCursor};
  });
 }
}
