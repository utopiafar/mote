import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {codingNextStepSchema,evidenceDependenciesSchema,ownerQuestionEvidenceSchema,parseEvidenceId,queryScopeSchema,sourceContextDeclarationSchema,type AssistantEvidenceOrigin,type CaptureRecord,type QueryScope,type SourceContextDeclaration} from '@mote/shared';
import {StoreError,sha256,type EvidenceStore as Store} from './evidence-store.js';
import {type EvidenceReader,withinEvidenceScope} from './evidence-reader.js';
import {retireTaskRecordsSql,taskEvidenceIds,validateTaskDependencies} from './task-evidence.js';
import {TaskRecords,type AssertTaskCurrent} from './task-records.js';
import {encodeMemoryPrivate,decodeMemoryPrivate} from './plugins/memory-private-storage.js';
import {canonicalRecipeJson} from './recipe-contract.js';
import {assertSourceContextDependencies,sourceContextDependenciesCurrent} from './source-context-lineage.js';
import {codingMessageProof} from './coding-session-context.js';

const cardKind=z.enum(['activity','suggestion','briefing','artifact','question']);
const cardState=z.enum(['open','resolved']);
const uuid=z.string().uuid();
const version=z.string().min(1).max(200);
const revision=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text=z.string().min(1).max(32000).refine(value=>value.trim().length>0,'Text cannot be blank');
function assertPublicationCurrent(check:AssertTaskCurrent,ids:readonly string[]){
 if(typeof check!=='function')throw new StoreError('Card publication requires current-state validation',409);
 const result:unknown=check(ids);
 if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw new StoreError('Card current-state validation must complete synchronously',409);}
}
const publishSchema=z.object({
 id:uuid,kind:cardKind,matterId:uuid.nullable(),version,state:cardState,
 title:z.string().min(1).max(500),body:text,
 reminderReason:z.string().min(1).max(2000).refine(value=>value.trim().length>0).optional(),
 codingNextStep:codingNextStepSchema.optional(),
 evidence:z.array(ownerQuestionEvidenceSchema.extend({id:uuid})).max(100),
 evidenceDependencies:evidenceDependenciesSchema,sourceContextDependencies:z.array(sourceContextDeclarationSchema).optional(),
}).strict();
export type AssistantCardPublication=z.infer<typeof publishSchema>;
export const assistantCardFeedbackSchema=z.object({
 expectedRevision:revision,action:z.enum(['read','later','ignore','correct','never_remind']),
 note:z.string().min(1).max(8000).refine(value=>value.trim().length>0).optional(),
 until:z.string().datetime({offset:true}).optional(),
}).strict().superRefine((value,ctx)=>{
 if(value.action==='correct'&&!value.note)ctx.addIssue({code:z.ZodIssueCode.custom,message:'A correction needs an explanation'});
 if(value.action==='read'&&(value.note||value.until)||value.until&&value.action!=='later')ctx.addIssue({code:z.ZodIssueCode.custom,message:'Feedback fields do not match the action'});
});
export type AssistantCardFeedback=z.infer<typeof assistantCardFeedbackSchema>;
type CardRow={seq:number;id:string;cursor_key:string;kind:z.infer<typeof cardKind>;matter_id:string|null;revision:number;current_version:string;state:'open'|'resolved'|'stale';accepted_task_id:string|null;read_at:string|null;created_at:string;updated_at:string};
type VersionRow={seq:number;card_id:string;version:string;request_hash:string;state:'open'|'resolved';stale:number;private_json:string|null;created_at:string};
type Body=Pick<AssistantCardPublication,'title'|'body'|'evidence'|'sourceContextDependencies'|'reminderReason'|'codingNextStep'>&{historicalEvidenceIds?:string[]};
type VisibleVersion={snapshot:VersionRow;body:Body;ids:string[]};
type ReviewEvidence={current:Map<string,CaptureRecord[]>;historical:Map<string,CaptureRecord[]>;selection?:Set<string>};
type FeedbackRow={seq:number;version:string;action:Exclude<AssistantCardFeedback['action'],'read'>;stale:number;private_json:string|null;created_at:string};
type NotificationCandidate={id:string;revision:number;title:string;reason:string;state:CardRow['state'];readAt:string|null;
 feedback:{action:FeedbackRow['action'];until?:string;createdAt:string}[];origin:string;currentVersionAt:string};

/** Only the domain caller chooses object identity and semantic updates. This
 * store handles conditional publication and disclosure; it never generates a
 * proposal, task, notification or authorization. */
export class AssistantCards {
 constructor(private readonly store:Store,private readonly reader:EvidenceReader,private readonly now=()=>new Date().toISOString()){}
 private transaction<T>(run:()=>T):T{
  this.store.db.exec('SAVEPOINT assistant_cards_write');
  try{const result=run();this.store.db.exec('RELEASE assistant_cards_write');return result;}
  catch(error){if(this.store.db.isTransaction){this.store.db.exec('ROLLBACK TO assistant_cards_write; RELEASE assistant_cards_write');}throw error;}
 }
 private row(id:string):CardRow{
  const row=this.store.db.prepare('SELECT * FROM assistant_cards WHERE id=?').get(uuid.parse(id)) as CardRow|undefined;
  if(!row)throw new StoreError('Assistant card not found',404);return row;
 }
 private versionRow(id:string,selected:string):VersionRow|undefined{
  return this.store.db.prepare('SELECT * FROM assistant_card_versions WHERE card_id=? AND version=?').get(id,selected) as VersionRow|undefined;
 }
 private ids(id:string,selected:string):string[]{
  return this.store.db.prepare('SELECT evidence_id FROM assistant_card_evidence WHERE card_id=? AND version=? ORDER BY evidence_id').all(id,selected).map(row=>String(row.evidence_id));
 }
 private readEvidence(ids:readonly string[],historical:boolean,review?:ReviewEvidence){
  const read=(selection:readonly string[])=>historical?this.reader.memories.readEvidence([...selection]):this.reader.memories.readEvidenceIfCurrent(selection);
  if(!review)return read(ids);
  const records=historical?review.historical:review.current,missing=ids.filter(id=>!records.has(id));
  if(missing.length){
   const loaded=read(missing);
   if(!loaded)return;
   for(const id of missing)records.set(id,[]);
   for(const record of loaded)records.get(record.id)?.push(record);
  }
  return ids.flatMap(id=>records.get(id)??[]);
 }
 private valid(ids:readonly string[],scope:QueryScope,historical=false,sourceIds:readonly string[]=[],review?:ReviewEvidence):boolean{
  // Empty selections remain empty, including cards with no evidence.
  if(scope.kind==='selection'&&((scope.sourceIds&&scope.sourceIds.length===0)||(scope.evidenceIds&&scope.evidenceIds.length===0)))return false;
  if(!this.reader.contextDependenciesAllowed(ids,undefined,historical))return false;
  if(!historical&&this.store.db.prepare(`SELECT 1 FROM memories WHERE id IN (SELECT value FROM json_each(?))
   AND (coalesce(json_extract(json,'$.status'),'')!='published' OR json_extract(json,'$.supersededBy') IS NOT NULL) LIMIT 1`).get(JSON.stringify(ids)))return false;
  const records=this.readEvidence(ids,historical,review);
  if(!records)return false;
  const scoped=scope.kind==='selection'||scope.deviceId!==undefined||scope.after!==undefined||scope.before!==undefined||scope.evidenceIds!==undefined;
  if(ids.length>0&&!records.length)return false;
  if(scoped&&!records.length&&(!sourceIds.length||scope.deviceId!==undefined||scope.after!==undefined||scope.before!==undefined||scope.evidenceIds!==undefined))return false;
  let selected:Set<string>|undefined;
  if(scope.evidenceIds!==undefined){
   selected=review?.selection??new Set(taskEvidenceIds(this.store,{version:1,complete:true,ids:scope.evidenceIds}));
   if(review)review.selection=selected;
  }
  for(const record of records){
   if(record.privacy?.excluded||!withinEvidenceScope(record,scope))return false;
   if(scope.kind==='selection'&&scope.sourceIds!==undefined&&(!record.provenance?.sourceId||!scope.sourceIds.includes(record.provenance.sourceId)))return false;
   if(selected&&!selected.has(record.id))return false;
  }
  for(const sourceId of sourceIds){
   try{this.reader.sources.getSource(sourceId);}catch{return false;}
   if(scope.kind==='selection'&&scope.sourceIds!==undefined&&!scope.sourceIds.includes(sourceId))return false;
   if((scope.deviceId!==undefined||scope.after!==undefined||scope.before!==undefined||scope.evidenceIds!==undefined)&&!records.some(record=>record.provenance?.sourceId===sourceId))return false;
  }
  return true;
 }
 private assertValid(ids:readonly string[],scope:QueryScope,sourceIds:readonly string[]=[],historicalIds:readonly string[]=[]){
  const historical=new Set(historicalIds);
  if(historicalIds.some(id=>!ids.includes(id))||!this.valid(ids.filter(id=>!historical.has(id)),scope,false,sourceIds)||
   historicalIds.length>0&&!this.valid(historicalIds,scope,true,sourceIds))throw new StoreError('Assistant card evidence or scope changed',409);
 }
 private payload(row:VersionRow):Body{
  if(row.private_json===null)throw new StoreError('Assistant card version is unavailable',409);
  return decodeMemoryPrivate<Body>(this.store,row.private_json);
 }
 private publicBody(body:Body){const {historicalEvidenceIds:_,...visible}=body;return visible;}
 private evidenceOrigins(evidence:Body['evidence'],historical=false):AssistantEvidenceOrigin[]{
  const ids=[...new Set(evidence.map(proof=>proof.id))];
  const originals=historical?this.readEvidence(ids,true)??[]:this.reader.memories.readCurrentEvidence(ids);
  const records=new Map(originals.map(record=>[record.id,record]));
  return evidence.flatMap(proof=>{
   const record=records.get(proof.id);
   if(!record)return [];
   const source=record.provenance,provider=source?.document?.coding?.provider,message=codingMessageProof(record,proof);
   const speaker=message?.speaker==='user'&&record.attributionContext?.ownerRelation==='owner'?'owner':message?.speaker;
   const recordedAt=message?.recordedAt??source?.document?.recordedAt;
   return [{id:proof.id,offset:proof.offset,...(source?{sourceId:source.sourceId}:{}),...(provider?{provider}:{}),
    ...(speaker?{speaker}:{}),...(recordedAt?{recordedAt}:{}),...(record.appName&&!provider?{appName:record.appName}:{})}];
  });
 }
 /** Leave earlier Coding suggestions accessible as history. A previously
  * accepted card remains visible so a running task keeps its home. */
 private feedEligible(row:CardRow,body:Body){
  if(row.kind!=='suggestion'||row.accepted_task_id||body.codingNextStep||!body.evidence.length)return true;
  return !this.reader.hasCodingOriginals(body.evidence.map(item=>item.id));
 }
 private visibleVersion(row:VersionRow,scope:QueryScope,requireReminder=false,review?:ReviewEvidence):VisibleVersion|undefined{
  if(!row.private_json)return;
  const body=this.payload(row);
  if(requireReminder&&!body.reminderReason)return;
  const pins=body.sourceContextDependencies??[],historical=new Set(body.historicalEvidenceIds??[]),ids=this.ids(row.card_id,row.version);
  const sources=pins.map(pin=>pin.sourceId);
  if(!this.valid(ids.filter(id=>!historical.has(id)),scope,Boolean(row.stale),sources,review)||
   historical.size&&!this.valid([...historical],scope,true,sources,review)||
   !row.stale&&!sourceContextDependenciesCurrent(this.reader.sources.contexts,pins))return;
  return {snapshot:row,body,ids};
 }
 private current(row:CardRow,scope:QueryScope){
  const snapshot=this.versionRow(row.id,row.current_version),visible=snapshot&&this.visibleVersion(snapshot,scope);
  if(!visible)throw new StoreError('Assistant card not found',404);
  return visible;
 }
 private acceptedTask(row:CardRow,scope:QueryScope){
  if(!row.accepted_task_id)return null;
  const task=this.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(row.accepted_task_id);
  if(!task||task.state==='stale')return null;
  const ids=this.store.db.prepare('SELECT evidence_id FROM task_evidence WHERE task_id=? ORDER BY evidence_id').all(row.accepted_task_id).map(value=>String(value.evidence_id));
  return this.valid(ids,scope)?row.accepted_task_id:null;
 }
 /** A suggestion lends only its complete retained lineage to a new task. The
  * feed scope is a disclosure filter, never a request to read the whole feed.
  * Resolve canonical originals/anchors without browsing unrelated Materials. */
 private taskInput(row:CardRow,snapshot:VersionRow,ids:string[]){
  if(row.kind!=='suggestion'||row.state==='stale'||snapshot.stale)return {taskScope:null,taskEvidence:[]};
  const records=this.reader.memories.readCurrentEvidence(ids).sort((a,b)=>a.id.localeCompare(b.id));
  const taskScope:QueryScope={kind:'selection',evidenceIds:records.map(record=>record.id)};
  if(!records.length||!this.valid(ids,taskScope))return {taskScope:null,taskEvidence:[]};
  return {taskScope,taskEvidence:records.map(record=>({id:record.id,title:record.windowTitle||record.appName||'',
   ...(record.provenance?.sourceId?{sourceId:record.provenance.sourceId}:{}),deviceId:record.deviceId,at:record.capturedAt}))};
 }
 private visibleFeedback(id:string,scope:QueryScope,review?:ReviewEvidence){
  return (this.store.db.prepare('SELECT seq,version,action,stale,private_json,created_at FROM assistant_card_feedback WHERE card_id=? ORDER BY seq').all(id) as FeedbackRow[]).flatMap(entry=>{
   const prior=this.versionRow(id,entry.version);
   const ids=this.store.db.prepare('SELECT evidence_id FROM assistant_card_feedback_evidence WHERE feedback_seq=? ORDER BY evidence_id').all(entry.seq).map(value=>String(value.evidence_id));
   const sources=this.store.db.prepare('SELECT source_id FROM assistant_card_feedback_context WHERE feedback_seq=? ORDER BY source_id').all(entry.seq).map(value=>String(value.source_id));
   if(!prior?.private_json||!this.valid(ids,scope,Boolean(entry.stale),sources,review))return [];
   const detail=entry.private_json?decodeMemoryPrivate<{note?:string;until?:string}>(this.store,entry.private_json):{};
   return [{ids,sources,item:{version:entry.version,action:entry.action,...detail,...(entry.stale?{evidenceStale:true}:{}),createdAt:entry.created_at}}];
  });
 }
 private cardContent(row:CardRow,visible:VisibleVersion,feedback:ReturnType<AssistantCards['visibleFeedback']>){
  return {id:row.id,kind:row.kind,matterId:row.matter_id,version:row.current_version,state:row.state,revision:row.revision,...(visible.snapshot.stale?{evidenceStale:true}:{}),
   ...this.publicBody(visible.body),evidenceDependencies:{version:1 as const,complete:true as const,ids:visible.ids.filter(id=>Boolean(parseEvidenceId(id)))},
   feedback:feedback.map(entry=>entry.item),readAt:row.read_at,createdAt:row.created_at,updatedAt:row.updated_at};
 }
 private view(row:CardRow,scope:QueryScope,visible=this.current(row,scope)){
  const task=this.feedEligible(row,visible.body)?this.taskInput(row,visible.snapshot,visible.ids):{taskScope:null,taskEvidence:[]};
  return {...this.cardContent(row,visible,this.visibleFeedback(row.id,scope)),...task,
   evidenceOrigins:this.evidenceOrigins(visible.body.evidence),acceptedTaskId:this.acceptedTask(row,scope)};
 }
 private expect(row:CardRow,expectedRevision:number){if(row.revision!==revision.parse(expectedRevision))throw new StoreError('Assistant card changed; reload before continuing',409);}

 /** Replaying the same explicitly assigned id/version and complete payload is
  * idempotent. Hashes detect conflicting retries only; no text similarity is used. */
 publish(raw:AssistantCardPublication,expectedRevision:number|undefined,rawScope:QueryScope,assertCurrent:AssertTaskCurrent,internalDependencies:readonly string[]=[],historicalDependencies:readonly string[]=[]){
  const input=publishSchema.parse(raw),scope=queryScopeSchema.parse(rawScope),publicDependencies=validateTaskDependencies(input.evidenceDependencies),pins=input.sourceContextDependencies??[];
  const extra=[...new Set(internalDependencies)].sort(),dependencies=validateTaskDependencies({...publicDependencies,ids:[...publicDependencies.ids,...extra]});
  if(input.evidence.some(entry=>!dependencies.ids.includes(entry.id)))throw new StoreError('Card evidence is outside its disclosure dependencies',409);
  const historical=[...new Set(historicalDependencies)].sort();
  const hash=sha256(canonicalRecipeJson({...input,evidenceDependencies:publicDependencies,...(extra.length?{internalDependencies:extra}:{}),...(historical.length?{historicalEvidenceIds:historical}:{})}));
  return this.transaction(()=>{
   const prior=this.versionRow(input.id,input.version);
   if(prior){
    if(prior.request_hash!==hash||!this.visibleVersion(prior,scope))throw new StoreError('Card version was reused or retired',409);
    const row=this.row(input.id);return this.view(row,scope);
   }
   const existing=this.store.db.prepare('SELECT * FROM assistant_cards WHERE id=?').get(input.id) as CardRow|undefined;
   if(existing){
    if(expectedRevision===undefined||existing.kind!==input.kind)throw new StoreError('Assistant card changed; reload before continuing',409);
    this.current(existing,scope);
    this.expect(existing,expectedRevision);
   }else if(expectedRevision!==undefined)throw new StoreError('Assistant card not found',404);
   const ids=taskEvidenceIds(this.store,dependencies),sourceIds=[...new Set(pins.map(pin=>pin.sourceId))];this.assertValid(ids,scope,sourceIds,historical);assertSourceContextDependencies(this.reader.sources.contexts,pins);
   assertPublicationCurrent(assertCurrent,ids);this.assertValid(ids,scope,sourceIds,historical);assertSourceContextDependencies(this.reader.sources.contexts,pins);
   if(existing)this.expect(this.row(input.id),expectedRevision!);
   const at=this.now(),body=encodeMemoryPrivate(this.store,{title:input.title,body:input.body,evidence:input.evidence,...(input.reminderReason?{reminderReason:input.reminderReason}:{}),
     ...(input.codingNextStep?{codingNextStep:input.codingNextStep}:{}),...(pins.length?{sourceContextDependencies:pins}:{}),...(historical.length?{historicalEvidenceIds:historical}:{})});
   if(existing)this.store.db.prepare('UPDATE assistant_cards SET matter_id=?,current_version=?,state=?,revision=revision+1,updated_at=? WHERE id=?').run(input.matterId,input.version,input.state,at,input.id);
   else this.store.db.prepare('INSERT INTO assistant_cards(id,cursor_key,kind,matter_id,revision,current_version,state,accepted_task_id,read_at,created_at,updated_at) VALUES(?,?,?,?,1,?,?,NULL,NULL,?,?)').run(input.id,randomBytes(32).toString('hex'),input.kind,input.matterId,input.version,input.state,at,at);
   this.store.db.prepare('INSERT INTO assistant_card_versions(card_id,version,request_hash,state,private_json,created_at) VALUES(?,?,?,?,?,?)').run(input.id,input.version,hash,input.state,body,at);
   const insert=this.store.db.prepare('INSERT INTO assistant_card_evidence(card_id,version,evidence_id) VALUES(?,?,?)');for(const id of ids)insert.run(input.id,input.version,id);
   const insertSource=this.store.db.prepare('INSERT INTO assistant_card_context(card_id,version,source_id) VALUES(?,?,?)');for(const sourceId of sourceIds)insertSource.run(input.id,input.version,sourceId);
   return this.view(this.row(input.id),scope);
  });
 }
 get(id:string,rawScope:QueryScope){return this.transaction(()=>this.view(this.row(id),queryScopeSchema.parse(rawScope)));}
 /** Find when the current run of reminder proposals began. An inaccessible
  * previous version cannot be used to infer a new reminder. */
 private notificationTiming(id:string,scope:QueryScope,current:VersionRow){
  let origin=current.created_at,before=current.seq;
  for(;;){
   const versions=this.store.db.prepare('SELECT * FROM assistant_card_versions WHERE card_id=? AND seq<? ORDER BY seq DESC LIMIT 100').all(id,before) as VersionRow[];
   if(!versions.length)break;
   for(const previous of versions){
    const visible=this.visibleVersion(previous,scope);if(!visible)return null;
    if(!visible.body.reminderReason)return {origin,currentVersionAt:current.created_at};
    origin=previous.created_at;before=previous.seq;
   }
  }
  return {origin,currentVersionAt:current.created_at};
 }
 /** Freeze reminder eligibility and its feedback on one read snapshot. The
  * read never needs a suggestion's separate task-input authorization. */
 notificationCandidates(rawScope:QueryScope):NotificationCandidate[]{
  const scope=queryScopeSchema.parse(rawScope);
  return this.transaction(()=>{
   const candidates:NotificationCandidate[]=[];
   const decisionCount=this.store.db.prepare("SELECT count(*) AS n FROM assistant_card_feedback WHERE card_id=? AND action IN ('later','ignore','never_remind')");
   for(const row of this.feedRows(Number.MAX_SAFE_INTEGER,100)){
    const snapshot=this.versionRow(row.id,row.current_version);
    const visible=snapshot&&this.visibleVersion(snapshot,scope,true),reason=visible?.body.reminderReason;
    if(!visible||!reason||!this.feedEligible(row,visible.body))continue;
    const timing=this.notificationTiming(row.id,scope,visible.snapshot);
    if(!timing)continue;
    const feedback=this.visibleFeedback(row.id,scope).map(({item})=>item).filter(({action})=>action==='later'||action==='ignore'||action==='never_remind');
    // A hidden decision cannot authorize another reminder.
    if(decisionCount.get(row.id)?.n!==feedback.length)continue;
    candidates.push({id:row.id,revision:row.revision,title:visible.body.title,reason,state:row.state,readAt:row.read_at,feedback,...timing});
   }
   return candidates;
  });
 }
 feedback(id:string,raw:AssistantCardFeedback,rawScope:QueryScope){
  const input=assistantCardFeedbackSchema.parse(raw),scope=queryScopeSchema.parse(rawScope);
  return this.transaction(()=>{
   const row=this.row(id);this.current(row,scope);this.expect(row,input.expectedRevision);
   if(row.state==='stale')throw new StoreError('Assistant card evidence changed',409);
   if(input.action==='read'&&row.read_at!==null)return this.view(row,scope);
   const at=this.now();
   if(input.action==='read')this.store.db.prepare('UPDATE assistant_cards SET read_at=?,revision=revision+1,updated_at=? WHERE id=?').run(at,at,id);
   else {
    const value=encodeMemoryPrivate(this.store,{...(input.note?{note:input.note}:{}),...(input.until?{until:input.until}:{})});
    const stale=this.store.db.prepare('SELECT 1 FROM assistant_card_versions WHERE card_id=? AND private_json IS NOT NULL AND stale=1 LIMIT 1').get(id)?1:0;
    const saved=this.store.db.prepare('INSERT INTO assistant_card_feedback(card_id,version,action,private_json,stale,created_at) VALUES(?,?,?,?,?,?)').run(id,row.current_version,input.action,value,stale,at);
    // A correction can refer to any version the owner has seen. Conservatively
    // retain the lineage of all available versions rather than guessing which
    // part of an explanation was influenced by which prior evidence.
    this.store.db.prepare(`INSERT INTO assistant_card_feedback_evidence(feedback_seq,evidence_id)
     SELECT ?,evidence_id FROM assistant_card_evidence WHERE card_id=? AND version IN
     (SELECT version FROM assistant_card_versions WHERE card_id=? AND private_json IS NOT NULL) GROUP BY evidence_id`).run(saved.lastInsertRowid,id,id);
    this.store.db.prepare(`INSERT INTO assistant_card_feedback_context(feedback_seq,source_id)
     SELECT ?,source_id FROM assistant_card_context WHERE card_id=? AND version IN
     (SELECT version FROM assistant_card_versions WHERE card_id=? AND private_json IS NOT NULL) GROUP BY source_id`).run(saved.lastInsertRowid,id,id);
    // The owner's selected scope is part of this input, not a permission to
    // read the wider card history when a later consumer resumes it.
    this.store.db.prepare('INSERT INTO assistant_card_feedback_scopes VALUES(?,?)').run(saved.lastInsertRowid,encodeMemoryPrivate(this.store,{scope,cardRevision:row.revision+1}));
    // Follow-up snapshots include the visible card and its feedback. Retire
    // their private inputs and batch results when an owner changes that context;
    // shared original evidence may conservatively retire an unrelated review.
    this.store.db.prepare(retireTaskRecordsSql(`SELECT id FROM task_records WHERE operation_id IN (
     SELECT DISTINCT t.operation_id FROM task_records t JOIN task_evidence e ON e.task_id=t.id
     WHERE t.kind='assistant.followup' AND t.operation_id LIKE 'assistant-followup:%'
      AND e.evidence_id IN (SELECT evidence_id FROM assistant_card_evidence WHERE card_id=?))
     AND kind IN ('assistant.followup','batch','batch.item')`)).run(id);
    this.store.db.prepare('UPDATE assistant_cards SET revision=revision+1,updated_at=? WHERE id=?').run(at,id);
   }
   return this.view(this.row(id),scope);
  });
 }
 /** The accepting service wraps this link and task creation in its transaction. */
 associateTask(id:string,expectedRevision:number,taskId:string,rawScope:QueryScope){
  const scope=queryScopeSchema.parse(rawScope);uuid.parse(taskId);
  return this.transaction(()=>{
   const row=this.row(id);this.current(row,scope);this.expect(row,expectedRevision);
   if(row.state==='stale')throw new StoreError('Assistant card evidence changed',409);
   if(row.accepted_task_id&&row.accepted_task_id!==taskId)throw new StoreError('Card already has an accepted task',409);
   const tasks=new TaskRecords(this.store),task=tasks.get(taskId);
   tasks.evidenceDependencies(taskId,task.revision,ids=>this.assertValid(ids,scope));
   if(row.accepted_task_id===taskId)return this.view(row,scope);
   this.store.db.prepare('UPDATE assistant_cards SET accepted_task_id=?,revision=revision+1,updated_at=? WHERE id=?').run(taskId,this.now(),id);
   return this.view(this.row(id),scope);
  });
 }
 private sign(row:CardRow,value:unknown){return createHmac('sha256',Buffer.from(row.cursor_key,'hex')).update(canonicalRecipeJson(value)).digest('hex');}
 private cursor(scope:QueryScope,id:string){
  const row=this.row(id),value={id,scope:sha256(canonicalRecipeJson(scope))};
  return Buffer.from(JSON.stringify({...value,signature:this.sign(row,value)})).toString('base64url');
 }
 private cursorRow(value:string,scope:QueryScope){
  try{
   const {signature,...cursor}=z.object({id:uuid,scope:z.string().length(64),signature:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(JSON.parse(Buffer.from(value,'base64url').toString()));
   if(cursor.scope!==sha256(canonicalRecipeJson(scope)))throw Error();
   const row=this.row(cursor.id),expected=Buffer.from(this.sign(row,cursor),'hex');
   if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))throw Error();return row;
  }catch{throw new StoreError('Invalid assistant card cursor');}
 }
 private historyCursor(row:CardRow,scope:QueryScope,selectedVersion:string){
  const value={id:row.id,version:selectedVersion,scope:sha256(canonicalRecipeJson(scope))};
  return Buffer.from(JSON.stringify({...value,signature:this.sign(row,value)})).toString('base64url');
 }
 private historyCursorVersion(value:string,row:CardRow,scope:QueryScope){
  try{
   const {signature,...cursor}=z.object({id:uuid,version,scope:z.string().length(64),signature:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(JSON.parse(Buffer.from(value,'base64url').toString()));
   if(cursor.id!==row.id||cursor.scope!==sha256(canonicalRecipeJson(scope))||!timingSafeEqual(Buffer.from(this.sign(row,cursor),'hex'),Buffer.from(signature,'hex')))throw Error();
   return cursor.version;
  }catch{throw new StoreError('Invalid assistant card history cursor');}
 }
 private hasVisibleHistory(id:string,scope:QueryScope){
  let before=Number.MAX_SAFE_INTEGER;
  for(;;){
   const rows=this.store.db.prepare('SELECT * FROM assistant_card_versions WHERE card_id=? AND seq<? ORDER BY seq DESC LIMIT 100').all(id,before) as VersionRow[];
   if(!rows.length)return false;
   for(const row of rows){if(this.visibleVersion(row,scope))return true;before=row.seq;}
  }
 }
 private *feedRows(before:number,batch:number){
  for(;;){
   const rows=this.store.db.prepare("SELECT * FROM assistant_cards WHERE seq<? AND state!='stale' ORDER BY seq DESC LIMIT ?").all(before,batch) as CardRow[];
   for(const row of rows)yield row;
   if(rows.length<batch)return;
   before=rows.at(-1)!.seq;
  }
 }
 page(args:{scope:QueryScope;limit?:number;cursor?:string}){
  const selected=z.object({scope:queryScopeSchema,limit:z.number().int().min(1).max(100).default(30),cursor:z.string().max(1000).optional()}).strict().parse(args);
  return this.transaction(()=>{
   let before=Number.MAX_SAFE_INTEGER;
   if(selected.cursor)before=this.cursorRow(selected.cursor,selected.scope).seq;
   const found:ReturnType<AssistantCards['view']>[]=[],batch=Math.max(30,selected.limit+1);
   for(const row of this.feedRows(before,batch)){
    const snapshot=this.versionRow(row.id,row.current_version),visible=snapshot&&this.visibleVersion(snapshot,selected.scope);
    if(visible&&this.feedEligible(row,visible.body))found.push(this.view(row,selected.scope,visible));
    if(found.length>selected.limit)break;
   }
   const items=found.slice(0,selected.limit),last=items.at(-1);
   return {items,nextCursor:found.length>selected.limit&&last?this.cursor(selected.scope,last.id):null};
  });
 }
 /** Internal analysis input. Read all visible cards and feedback in one
  * scoped snapshot unless the caller asks for a bounded preview. Historical
  * versions remain explicitly marked stale. */
 review(scope:QueryScope,limit?:number){
  const selected=queryScopeSchema.parse(scope);
  if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<1||limit>100))throw new StoreError('Invalid assistant review limit');
  return this.transaction(()=>{
   // Cards and earlier feedback often share originals. Keep their canonical
   // reads within this transaction and scope, with separate historical reads.
   const evidence:ReviewEvidence={current:new Map(),historical:new Map()};
   const items:(ReturnType<AssistantCards['cardContent']>&{disclosureDependencies:{version:1;complete:true;ids:string[]};sourceContextDependencies:SourceContextDeclaration[]})[]=[];let before=Number.MAX_SAFE_INTEGER;
   const result=(hasMore:boolean)=>({items:limit===undefined?items:items.slice(0,limit),hasMore,
    disclosureDependencies:{version:1 as const,complete:true as const,ids:[...new Set(items.flatMap(card=>card.disclosureDependencies.ids))].sort()},
    sourceContextDependencies:items.flatMap(card=>card.sourceContextDependencies)});
   for(;;){
    const rows=this.store.db.prepare('SELECT * FROM assistant_cards WHERE seq<? ORDER BY seq DESC LIMIT 100').all(before) as CardRow[];
    if(!rows.length)break;
    for(const row of rows){
     before=row.seq;const snapshot=this.versionRow(row.id,row.current_version),visible=snapshot&&this.visibleVersion(snapshot,selected,false,evidence);
     if(visible){
      // Retain each card's complete lineage, including feedback about earlier
      // versions, so consumers can distinguish evidence from owner constraints.
      const dependencies=new Set(visible.ids),pins=[...(visible.body.sourceContextDependencies??[])],feedback=this.visibleFeedback(row.id,selected,evidence);
      for(const {ids,sources} of feedback){
       for(const id of ids)dependencies.add(id);
       if(sources.length){
        const versions=this.store.db.prepare('SELECT * FROM assistant_card_versions WHERE card_id=? AND private_json IS NOT NULL').all(row.id) as VersionRow[];
        for(const version of versions)for(const pin of this.payload(version).sourceContextDependencies??[])if(sources.includes(pin.sourceId))pins.push(pin);
       }
      }
      items.push({...this.cardContent(row,visible,feedback),disclosureDependencies:{version:1,complete:true,ids:[...dependencies].sort()},sourceContextDependencies:pins});
     }
     if(limit!==undefined&&items.length>limit)return result(true);
    }
    if(rows.length<100)break;
   }
   return result(false);
  });
 }
 history(id:string,args:{scope:QueryScope;limit?:number;cursor?:string}){
  const selected=z.object({scope:queryScopeSchema,limit:z.number().int().min(1).max(100).default(30),cursor:z.string().max(1000).optional()}).strict().parse(args);
  return this.transaction(()=>{
   const card=this.row(id);if(!this.hasVisibleHistory(id,selected.scope))throw new StoreError('Assistant card not found',404);
   let before=Number.MAX_SAFE_INTEGER;
   if(selected.cursor){
    const selectedVersion=this.historyCursorVersion(selected.cursor,card,selected.scope);
    const row=this.versionRow(id,selectedVersion);if(!row)throw new StoreError('Invalid assistant card history cursor');before=row.seq;
   }
   const found:(ReturnType<AssistantCards['publicBody']>&{version:string;state:'open'|'resolved';evidenceOrigins:AssistantEvidenceOrigin[];evidenceDependencies:{version:1;complete:true;ids:string[]};evidenceStale?:true;createdAt:string})[]=[],batch=Math.max(30,selected.limit+1);
   while(found.length<=selected.limit){
    const rows=this.store.db.prepare('SELECT * FROM assistant_card_versions WHERE card_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(id,before,batch) as VersionRow[];
    if(!rows.length)break;
    for(const row of rows){
     before=row.seq;const visible=this.visibleVersion(row,selected.scope);
     if(visible)found.push({version:row.version,state:row.state,...this.publicBody(visible.body),evidenceOrigins:this.evidenceOrigins(visible.body.evidence,Boolean(row.stale)),
      evidenceDependencies:{version:1,complete:true,ids:visible.ids.filter(value=>Boolean(parseEvidenceId(value)))},...(row.stale?{evidenceStale:true as const}:{}),createdAt:row.created_at});
     if(found.length>selected.limit)break;
    }
    if(found.length>selected.limit||rows.length<batch)break;
   }
   const items=found.slice(0,selected.limit),last=items.at(-1);
   return {items,nextCursor:found.length>selected.limit&&last?this.historyCursor(card,selected.scope,last.version):null};
  });
 }
}
