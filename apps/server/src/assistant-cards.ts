import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {evidenceDependenciesSchema,ownerQuestionEvidenceSchema,queryScopeSchema,sourceContextDeclarationSchema,type QueryScope,type SourceContextDeclaration} from '@mote/shared';
import {StoreError,sha256,type Store} from './store.js';
import {type EvidenceReader,withinEvidenceScope} from './evidence-reader.js';
import {taskEvidenceIds,validateTaskDependencies} from './task-evidence.js';
import {TaskRecords,type AssertTaskCurrent} from './task-records.js';
import {encodeMemoryPrivate,decodeMemoryPrivate} from './plugins/memory-private-storage.js';
import {canonicalRecipeJson} from './recipe-contract.js';
import {assertSourceContextDependencies,sourceContextDependenciesCurrent} from './source-context-lineage.js';

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
type Body=Pick<AssistantCardPublication,'title'|'body'|'evidence'|'sourceContextDependencies'|'reminderReason'>;
type FeedbackRow={seq:number;version:string;action:Exclude<AssistantCardFeedback['action'],'read'>;stale:number;private_json:string|null;created_at:string};

/** Only the domain caller chooses object identity and semantic updates. This
 * store handles conditional publication and disclosure; it never generates a
 * proposal, task, notification or authorization. */
export class AssistantCards {
 constructor(private readonly store:Store,private readonly reader:EvidenceReader,private readonly now=()=>new Date().toISOString()){}
 private transaction<T>(run:()=>T):T{
  this.store.db.exec('SAVEPOINT assistant_cards_write');
  try{const result=run();this.store.db.exec('RELEASE assistant_cards_write');return result;}
  catch(error){this.store.db.exec('ROLLBACK TO assistant_cards_write; RELEASE assistant_cards_write');throw error;}
 }
 /** Keep a multi-page derived read on one SQLite snapshot. */
 readSnapshot<T>(read:()=>T):T{return this.transaction(read);}
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
 private valid(ids:readonly string[],scope:QueryScope,historical=false,sourceIds:readonly string[]=[]):boolean{
  // Empty selections remain empty, including cards with no evidence.
  if(scope.kind==='selection'&&((scope.sourceIds&&scope.sourceIds.length===0)||(scope.evidenceIds&&scope.evidenceIds.length===0)))return false;
  if(!this.reader.contextDependenciesAllowed(ids,undefined,historical))return false;
  if(!historical&&this.store.db.prepare(`SELECT 1 FROM memories WHERE id IN (SELECT value FROM json_each(?))
   AND (coalesce(json_extract(json,'$.status'),'')!='published' OR json_extract(json,'$.supersededBy') IS NOT NULL) LIMIT 1`).get(JSON.stringify(ids)))return false;
  const records=this.reader.memories.readEvidence([...ids]);
  const scoped=scope.kind==='selection'||scope.deviceId!==undefined||scope.after!==undefined||scope.before!==undefined||scope.evidenceIds!==undefined;
  if(ids.length>0&&!records.length)return false;
  if(scoped&&!records.length&&(!sourceIds.length||scope.deviceId!==undefined||scope.after!==undefined||scope.before!==undefined||scope.evidenceIds!==undefined))return false;
  let selected:Set<string>|undefined;
  if(scope.evidenceIds!==undefined)selected=new Set(taskEvidenceIds(this.store,{version:1,complete:true,ids:scope.evidenceIds}));
  for(const record of records){
   if((!historical&&!this.reader.memories.isCurrentEvidence(record.id))||record.privacy?.excluded||!withinEvidenceScope(record,scope))return false;
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
 private assertValid(ids:readonly string[],scope:QueryScope,sourceIds:readonly string[]=[]){if(!this.valid(ids,scope,false,sourceIds))throw new StoreError('Assistant card evidence or scope changed',409);}
 private payload(row:VersionRow):Body{
  if(row.private_json===null)throw new StoreError('Assistant card version is unavailable',409);
  return decodeMemoryPrivate<Body>(this.store,row.private_json);
 }
 private visibleVersion(row:VersionRow,scope:QueryScope){
  if(!row.private_json)return false;
  const pins=this.payload(row).sourceContextDependencies??[];
  return this.valid(this.ids(row.card_id,row.version),scope,Boolean(row.stale),pins.map(pin=>pin.sourceId))&&
   (Boolean(row.stale)||sourceContextDependenciesCurrent(this.reader.sources.contexts,pins));
 }
 private current(row:CardRow,scope:QueryScope){
  const snapshot=this.versionRow(row.id,row.current_version);
  if(!snapshot||!this.visibleVersion(snapshot,scope))throw new StoreError('Assistant card not found',404);
  return snapshot;
 }
 private acceptedTask(row:CardRow,scope:QueryScope){
  if(!row.accepted_task_id)return null;
  const task=this.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(row.accepted_task_id);
  if(!task||task.state==='stale')return null;
  const ids=this.store.db.prepare('SELECT evidence_id FROM task_evidence WHERE task_id=? ORDER BY evidence_id').all(row.accepted_task_id).map(value=>String(value.evidence_id));
  return this.valid(ids,scope)?row.accepted_task_id:null;
 }
 private view(row:CardRow,scope:QueryScope){
  const snapshot=this.current(row,scope),body=this.payload(snapshot),ids=this.ids(row.id,row.current_version);
  const feedback=(this.store.db.prepare('SELECT seq,version,action,stale,private_json,created_at FROM assistant_card_feedback WHERE card_id=? ORDER BY seq').all(row.id) as FeedbackRow[]).flatMap(entry=>{
   const prior=this.versionRow(row.id,entry.version);
   const ids=this.store.db.prepare('SELECT evidence_id FROM assistant_card_feedback_evidence WHERE feedback_seq=? ORDER BY evidence_id').all(entry.seq).map(value=>String(value.evidence_id));
   const sources=this.store.db.prepare('SELECT source_id FROM assistant_card_feedback_context WHERE feedback_seq=? ORDER BY source_id').all(entry.seq).map(value=>String(value.source_id));
   if(!prior?.private_json||!this.valid(ids,scope,Boolean(entry.stale),sources))return [];
   const detail=entry.private_json?decodeMemoryPrivate<{note?:string;until?:string}>(this.store,entry.private_json):{};
   return [{version:entry.version,action:entry.action,...detail,...(entry.stale?{evidenceStale:true}:{}),createdAt:entry.created_at}];
  });
  return {id:row.id,kind:row.kind,matterId:row.matter_id,version:row.current_version,state:row.state,revision:row.revision,...(snapshot.stale?{evidenceStale:true}:{}),
   ...body,evidenceDependencies:{version:1 as const,complete:true as const,ids},readAt:row.read_at,acceptedTaskId:this.acceptedTask(row,scope),
   feedback,createdAt:row.created_at,updatedAt:row.updated_at};
 }
 private expect(row:CardRow,expectedRevision:number){if(row.revision!==revision.parse(expectedRevision))throw new StoreError('Assistant card changed; reload before continuing',409);}

 /** Replaying the same explicitly assigned id/version and complete payload is
  * idempotent. Hashes detect conflicting retries only; no text similarity is used. */
 publish(raw:AssistantCardPublication,expectedRevision:number|undefined,rawScope:QueryScope,assertCurrent:AssertTaskCurrent){
  const input=publishSchema.parse(raw),scope=queryScopeSchema.parse(rawScope),dependencies=validateTaskDependencies(input.evidenceDependencies),pins=input.sourceContextDependencies??[];
  if(input.evidence.some(entry=>!dependencies.ids.includes(entry.id)))throw new StoreError('Card evidence is outside its disclosure dependencies',409);
  const hash=sha256(canonicalRecipeJson({...input,evidenceDependencies:dependencies}));
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
   const ids=taskEvidenceIds(this.store,dependencies),sourceIds=[...new Set(pins.map(pin=>pin.sourceId))];this.assertValid(ids,scope,sourceIds);assertSourceContextDependencies(this.reader.sources.contexts,pins);
   assertPublicationCurrent(assertCurrent,ids);this.assertValid(ids,scope,sourceIds);assertSourceContextDependencies(this.reader.sources.contexts,pins);
   if(existing)this.expect(this.row(input.id),expectedRevision!);
   const at=this.now(),body=encodeMemoryPrivate(this.store,{title:input.title,body:input.body,evidence:input.evidence,...(input.reminderReason?{reminderReason:input.reminderReason}:{}),...(pins.length?{sourceContextDependencies:pins}:{})});
   if(existing)this.store.db.prepare('UPDATE assistant_cards SET matter_id=?,current_version=?,state=?,revision=revision+1,updated_at=? WHERE id=?').run(input.matterId,input.version,input.state,at,input.id);
   else this.store.db.prepare('INSERT INTO assistant_cards(id,cursor_key,kind,matter_id,revision,current_version,state,accepted_task_id,read_at,created_at,updated_at) VALUES(?,?,?,?,1,?,?,NULL,NULL,?,?)').run(input.id,randomBytes(32).toString('hex'),input.kind,input.matterId,input.version,input.state,at,at);
   this.store.db.prepare('INSERT INTO assistant_card_versions(card_id,version,request_hash,state,private_json,created_at) VALUES(?,?,?,?,?,?)').run(input.id,input.version,hash,input.state,body,at);
   const insert=this.store.db.prepare('INSERT INTO assistant_card_evidence(card_id,version,evidence_id) VALUES(?,?,?)');for(const id of ids)insert.run(input.id,input.version,id);
   const insertSource=this.store.db.prepare('INSERT INTO assistant_card_context(card_id,version,source_id) VALUES(?,?,?)');for(const sourceId of sourceIds)insertSource.run(input.id,input.version,sourceId);
   this.store.reserveMetadata(0);return this.view(this.row(input.id),scope);
  });
 }
 get(id:string,rawScope:QueryScope){return this.transaction(()=>this.view(this.row(id),queryScopeSchema.parse(rawScope)));}
 /** Find when the current run of reminder proposals began. An inaccessible
  * previous version cannot be used to infer a new reminder. */
 notificationTiming(id:string,rawScope:QueryScope){
  return this.transaction(()=>{
   const scope=queryScopeSchema.parse(rawScope),row=this.row(id),current=this.current(row,scope);
   if(!this.payload(current).reminderReason)return null;
   let origin=current.created_at,before=current.seq;
   for(;;){
    const versions=this.store.db.prepare('SELECT * FROM assistant_card_versions WHERE card_id=? AND seq<? ORDER BY seq DESC LIMIT 100').all(id,before) as VersionRow[];
    if(!versions.length)break;
    for(const previous of versions){
     if(!this.visibleVersion(previous,scope))return null;
     if(!this.payload(previous).reminderReason)return {origin,currentVersionAt:current.created_at};
     origin=previous.created_at;before=previous.seq;
    }
   }
   return {origin,currentVersionAt:current.created_at};
  });
 }
 /** A hidden historical reminder decision must not accidentally become an
  * authorization to remind again. Do not disclose the hidden feedback itself. */
 notificationFeedbackVisible(id:string,rawScope:QueryScope){
  return this.transaction(()=>{
   const card=this.view(this.row(id),queryScopeSchema.parse(rawScope));
   const total=this.store.db.prepare("SELECT count(*) AS n FROM assistant_card_feedback WHERE card_id=? AND action IN ('later','ignore','never_remind')").get(id) as {n:number};
   return total.n===card.feedback.filter(entry=>entry.action==='later'||entry.action==='ignore'||entry.action==='never_remind').length;
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
    this.store.db.prepare('UPDATE assistant_cards SET revision=revision+1,updated_at=? WHERE id=?').run(at,id);
   }
   this.store.reserveMetadata(0);return this.view(this.row(id),scope);
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
   this.store.reserveMetadata(0);return this.view(this.row(id),scope);
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
 page(args:{scope:QueryScope;limit?:number;cursor?:string}){
  const selected=z.object({scope:queryScopeSchema,limit:z.number().int().min(1).max(100).default(30),cursor:z.string().max(1000).optional()}).strict().parse(args);
  return this.transaction(()=>{
   let before=Number.MAX_SAFE_INTEGER;
   if(selected.cursor)before=this.cursorRow(selected.cursor,selected.scope).seq;
   const found:ReturnType<AssistantCards['view']>[]=[],batch=Math.max(30,selected.limit+1);
   while(found.length<=selected.limit){
    const rows=this.store.db.prepare("SELECT * FROM assistant_cards WHERE seq<? AND state!='stale' ORDER BY seq DESC LIMIT ?").all(before,batch) as CardRow[];
    if(!rows.length)break;
    for(const row of rows){before=row.seq;const snapshot=this.versionRow(row.id,row.current_version);if(snapshot&&this.visibleVersion(snapshot,selected.scope))found.push(this.view(row,selected.scope));if(found.length>selected.limit)break;}
    if(found.length>selected.limit||rows.length<batch)break;
   }
   const items=found.slice(0,selected.limit),last=items.at(-1);
   return {items,nextCursor:found.length>selected.limit&&last?this.cursor(selected.scope,last.id):null};
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
   const found:{version:string;state:'open'|'resolved';title:string;body:string;evidence:Body['evidence'];sourceContextDependencies?:SourceContextDeclaration[];evidenceDependencies:{version:1;complete:true;ids:string[]};evidenceStale?:true;createdAt:string}[]=[],batch=Math.max(30,selected.limit+1);
   while(found.length<=selected.limit){
    const rows=this.store.db.prepare('SELECT * FROM assistant_card_versions WHERE card_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(id,before,batch) as VersionRow[];
    if(!rows.length)break;
    for(const row of rows){before=row.seq;const ids=this.ids(id,row.version);if(this.visibleVersion(row,selected.scope))found.push({version:row.version,state:row.state,...this.payload(row),evidenceDependencies:{version:1,complete:true,ids},...(row.stale?{evidenceStale:true as const}:{}),createdAt:row.created_at});if(found.length>selected.limit)break;}
    if(found.length>selected.limit||rows.length<batch)break;
   }
   const items=found.slice(0,selected.limit),last=items.at(-1);
   return {items,nextCursor:found.length>selected.limit&&last?this.historyCursor(card,selected.scope,last.version):null};
  });
 }
}
