import {isDeepStrictEqual} from 'node:util';
import {assistantTaskRecordSchema,formatEvidenceRef,type AssistantTaskInput,type CaptureRecord,type QueryResult,type QueryScope,type WorkState} from '@mote/shared';
import {AssistantTaskAcceptance,type FrozenDraftTask} from './assistant-task-acceptance.js';
import type {AssistantDraftCommandContext} from './assistant-drafts.js';
import type {AssistantCards} from './assistant-cards.js';
import type {AssistantMatters,MatterAuthority} from './assistant-matters.js';
import type {BatchProcessing,BatchProductProjection} from './batch-processing.js';
import {historyEvidenceDependencies,resolveDependencies} from './conversation-lineage.js';
import type {ConversationRepository} from './plugins/central-contracts.js';
import {EvidenceExposurePolicy} from './evidence-exposure.js';
import {withinEvidenceScope,type EvidenceReader} from './evidence-reader.js';
import type {ExecutionStep} from './execution-engine.js';
import {canonicalRecipeJson} from './recipe-contract.js';
import {assertSourceContextDependencies} from './source-context-lineage.js';
import type {SourceContextStore} from './source-context.js';
import {sha256,StoreError,type Store} from './store.js';
import {TaskRecords,type TaskRecord} from './task-records.js';
import type {ModelConnection} from './background-model-authorization.js';
import {addTaskEvidence,retireTaskRecordsSql,taskEvidenceIds} from './task-evidence.js';
import type {MaterialStore} from './materials.js';
import {decodeMemoryPrivate,encodeMemoryPrivate} from './plugins/memory-private-storage.js';
import type {RoutineInput,RoutineRef} from './assistant-routines.js';
import type {BackgroundModelAuthorization} from './background-model-authorization.js';

/** Product projection over existing task records and batch steps. The link
 * contains no private prose; the immutable scope and read set live in the task record. */
export class AssistantTasks implements BatchProductProjection {
 private readonly tasks:TaskRecords;
 private readonly acceptance:AssistantTaskAcceptance;
 constructor(private readonly store:Store,private readonly cards:AssistantCards,matters:AssistantMatters,
  private readonly reader:EvidenceReader,private readonly materials:MaterialStore,private readonly conversations:Pick<ConversationRepository,'get'>,
  private readonly contexts:SourceContextStore,private readonly batch:()=>BatchProcessing,
  private readonly connections:()=>ModelConnection[],
  private readonly routines?:{input(ref:RoutineRef):RoutineInput;current(ref:RoutineRef):boolean;allows(ids:readonly string[]):boolean;control:BackgroundModelAuthorization}){
  this.tasks=new TaskRecords(store);
  this.acceptance=new AssistantTaskAcceptance(store,cards,matters,{
   validate:(request,ids)=>{if(!isDeepStrictEqual(this.discover(request.scope).ids,ids))throw new StoreError('Task execution is outside the owner scope',409);},
   accepted:(task,request,ids)=>{this.saveScope(task,request.scope,this.discover(request.scope).snapshot);
    const dependencies=taskEvidenceIds(store,{version:1,complete:true,ids});this.assertCurrent(dependencies);addTaskEvidence(store,task.id,dependencies);store.reserveMetadata(0);},
  });
  store.db.exec(`CREATE TABLE IF NOT EXISTS assistant_task_scopes(
   task_id TEXT PRIMARY KEY REFERENCES task_records(id) ON DELETE CASCADE,scope_hash TEXT NOT NULL,snapshot_json TEXT);
   CREATE TABLE IF NOT EXISTS assistant_task_turns(
   task_id TEXT PRIMARY KEY REFERENCES task_records(id) ON DELETE CASCADE,
   conversation_id TEXT NOT NULL,turn_id TEXT NOT NULL,scope_hash TEXT NOT NULL,draft_revision INTEGER NOT NULL,
   UNIQUE(conversation_id,turn_id,draft_revision));
   CREATE INDEX IF NOT EXISTS assistant_task_turns_turn ON assistant_task_turns(conversation_id,turn_id);
   CREATE TRIGGER IF NOT EXISTS assistant_task_scope_stale AFTER UPDATE OF state ON task_records WHEN new.state='stale' AND old.state!='stale' BEGIN
    UPDATE assistant_task_scopes SET snapshot_json=NULL WHERE task_id=new.id;
   END;
   CREATE TRIGGER IF NOT EXISTS assistant_task_turn_deleted BEFORE DELETE ON conversation_turns BEGIN
    ${retireTaskRecordsSql('SELECT task_id FROM assistant_task_turns WHERE turn_id=old.id AND conversation_id=old.conversation_id')}
   END;`);
  store.registerStorage('assistant-task-turns',{
   assistant_task_turns:'length(CAST(task_id AS BLOB))+length(CAST(conversation_id AS BLOB))+length(CAST(turn_id AS BLOB))+length(CAST(scope_hash AS BLOB))+96',
   assistant_task_scopes:'length(CAST(task_id AS BLOB))+length(CAST(scope_hash AS BLOB))+coalesce(length(CAST(snapshot_json AS BLOB)),0)+96',
  });
 }
 private scopeHash(scope:QueryScope){return sha256(canonicalRecipeJson(scope));}
 private saveScope(task:TaskRecord,scope:QueryScope,snapshot:string[]){
  this.store.db.prepare('INSERT INTO assistant_task_scopes VALUES(?,?,?)').run(task.id,this.scopeHash(scope),encodeMemoryPrivate(this.store,snapshot));
  this.store.reserveMetadata(0);
 }
 private assertCurrent=(ids:readonly string[])=>{
  if(!this.reader.contextDependenciesAllowed(ids,new EvidenceExposurePolicy()))throw new StoreError('Assistant task evidence is no longer permitted',409);
 };
 private selected(id:string,scope:QueryScope,seen=new Set<string>()):boolean{
  if(scope.evidenceIds===undefined||scope.evidenceIds.includes(id))return true;
  if(seen.has(id))return false;seen.add(id);
  const parents=resolveDependencies(this.store,{version:1,complete:true,ids:[id]})!.ids.filter(value=>value!==id);
  for(const row of this.store.db.prepare('SELECT evidence_id FROM material_evidence_dependencies WHERE anchor_id=?').all(id))parents.push(String(row.evidence_id));
  // Only original captures establish whether a derived candidate is inside a
  // fixed selection. Intermediate artifacts never add permission.
  const roots=parents.filter(value=>Boolean(this.store.db.prepare('SELECT 1 FROM captures WHERE id=?').get(value)));
  return roots.length>0&&roots.every(root=>this.selected(root,scope,new Set(seen)));
 }
 /** Enumerate the current authorized read catalog, not a semantic ranking.
  * The model still chooses which of these candidates to read. A bounded request
  * fails explicitly instead of presenting a truncated scope as complete. */
 private discover(scope:QueryScope,automatic=false):{ids:string[];snapshot:string[]}{
  if(scope.evidenceIds?.length===0||scope.kind==='selection'&&scope.sourceIds?.length===0)return {ids:[],snapshot:[]};
  const sources=scope.kind==='selection'&&scope.sourceIds!==undefined?new Set(scope.sourceIds):undefined;
  const restriction=sources?new EvidenceExposurePolicy([],value=>sources.has(value.sourceId??'')):undefined;
  const found=new Set<string>(),seen=new Set<string>();let cursor:string|undefined;
  const add=(record:CaptureRecord)=>{
   const block=this.store.db.prepare('SELECT block_id FROM material_evidence WHERE id=?').get(record.id);
   if(record.privacy.excluded||!withinEvidenceScope(record,scope)||
     !this.selected(record.id,scope)||!this.reader.memories.isCurrentEvidence(record.id)||
     !this.reader.contextDependenciesAllowed([record.id])||restriction&&!this.reader.contextDependenciesAllowed([record.id],restriction))return;
   const ancestors=resolveDependencies(this.store,{version:1,complete:true,ids:[record.id]})!.ids;
   if(automatic&&(!this.routines||!this.routines.allows([record.id,...ancestors])))return;
   seen.add(record.id);
   if(block&&['source-metadata','record-metadata'].includes(String(block.block_id))||!record.ocrText?.trim()||record.provenance?.layer==='reference')return;
   if(this.store.evidenceMetadata(ancestors).some(original=>original.provenance?.layer==='reference'))return;
   found.add(record.id);
   if(found.size>1000)throw new StoreError('Choose a smaller scope for this assistant task',413);
  };
  do{
   const page=this.reader.queryPage({after:scope.after,before:scope.before,deviceId:scope.deviceId,cursor,limit:100},'browse');
   for(const record of page.items){
    add(record);
    const ref=record.provenance?.uri?.split('#')[0];
    if(ref?.startsWith('material:')){
     const ids=this.materials.evidenceIds(ref,undefined,1001);
     if(ids.length>1000)throw new StoreError('Choose a smaller scope for this assistant task',413);
     for(const candidate of this.reader.evidence(ids.map(id=>formatEvidenceRef('capture',id)),scope))add(candidate);
    }else{
     if(this.reader.files&&this.store.db.prepare('SELECT 1 FROM file_versions WHERE capture_id=?').get(record.id)){
      for(let offset=0;;offset+=200){const chunks=this.reader.files.chunks(record.id,offset,200);for(const chunk of chunks)add(chunk);if(chunks.length<200)break;}
     }
    }
   }
   cursor=page.nextCursor??undefined;
  }while(cursor);
  return {ids:[...found].sort(),snapshot:[...this.snapshot([...seen]).map(id=>'observed:'+id),
   ...this.snapshot([...found]).map(id=>'readable:'+id)].sort()};
 }
 private taskForOperation(operationId:string):TaskRecord|undefined{
  const row=this.store.db.prepare("SELECT t.id FROM task_records t JOIN assistant_task_scopes s ON s.task_id=t.id WHERE t.operation_id=? AND t.kind='assistant.task'").get(operationId);
  return row?this.tasks.get(String(row.id)):undefined;
 }
 private snapshot(ids:string[]){
  const roots=new Set<string>();
  for(const id of ids){
   const ancestors=resolveDependencies(this.store,{version:1,complete:true,ids:[id]})!.ids;
   for(const row of this.store.db.prepare('SELECT evidence_id FROM material_evidence_dependencies WHERE anchor_id=?').all(id))ancestors.push(String(row.evidence_id));
   const originals=ancestors.filter(value=>Boolean(this.store.db.prepare('SELECT 1 FROM captures WHERE id=?').get(value)));
   if(originals.length)originals.forEach(value=>roots.add(value));else roots.add(id);
  }
  return [...roots].sort();
 }
 private draft(task:TaskRecord):FrozenDraftTask{return this.tasks.input<FrozenDraftTask>(task.id,task.revision,this.assertCurrent);}
 private current(task:TaskRecord):boolean{
  if(task.state==='stale'||task.state==='cancelled')return false;
  const scopeRow=this.store.db.prepare('SELECT snapshot_json FROM assistant_task_scopes WHERE task_id=?').get(task.id);
  if(!scopeRow)return false;
  try{
   const frozen=this.tasks.input<FrozenDraftTask&{card?:{cardId:string};cardVersion?:string;routine?:RoutineRef}>(task.id,task.revision,this.assertCurrent);
   if(frozen.routine){if(!this.routines?.current(frozen.routine))return false;}
   else if(frozen.card){const card=this.cards.get(frozen.card.cardId,frozen.request.scope);if(card.state==='stale'||card.version!==frozen.cardVersion||card.acceptedTaskId!==task.id)return false;}
   else{
    const turn=this.conversations.get(frozen.conversationId).turns.find(item=>item.id===frozen.turnId);
    if(!turn||turn.status!=='completed'||!turn.result?.draft||turn.evidenceDeleted||turn.evidenceUnavailable||turn.evidenceStale)return false;
    assertSourceContextDependencies(this.contexts,turn.result.sourceContextDependencies??[]);
   }
   if(typeof scopeRow.snapshot_json!=='string'||!isDeepStrictEqual(this.discover(frozen.request.scope,Boolean(frozen.routine)).snapshot,decodeMemoryPrivate<string[]>(this.store,scopeRow.snapshot_json)))return false;
   const result=this.tasks.result<QueryResult>(task.id,task.revision,this.assertCurrent);
   if(result)assertSourceContextDependencies(this.contexts,result.sourceContextDependencies??[]);
   return true;
  }catch{return false;}
 }
 private retire(task:TaskRecord){
  if(task.state!=='stale'&&task.state!=='cancelled')this.store.db.prepare(retireTaskRecordsSql('SELECT id FROM task_records WHERE id=?')).run(task.id);
 }
 validateDraftVersion({command,draft}:AssistantDraftCommandContext){
  const prior=this.store.db.prepare('SELECT id FROM task_records WHERE request_id=?').get(command.requestId);
  if(prior){
   const task=this.tasks.get(String(prior.id));if(task.kind!=='assistant.task')throw new StoreError('Task request ID was reused with different content',409);
   const frozen=this.tasks.input<FrozenDraftTask>(task.id,task.revision,this.assertCurrent);
   if(frozen.conversationId!==command.conversationId||frozen.turnId!==command.turnId||frozen.draftRevision!==command.expectedRevision||
     !isDeepStrictEqual(frozen.request,{requestId:command.requestId,goal:command.goal,scope:command.scope}))
    throw new StoreError('Task request ID was reused with different content',409);
   return;
  }
  const latest=this.store.db.prepare('SELECT task_id,draft_revision FROM assistant_task_turns WHERE conversation_id=? AND turn_id=? ORDER BY draft_revision DESC LIMIT 1')
   .get(command.conversationId,command.turnId);
  const expected=latest?Number(latest.draft_revision)+1:command.expectedRevision===draft.revision?draft.revision:draft.revision+1;
  if(command.expectedRevision!==expected)throw new StoreError('Assistant draft changed; reload before continuing',409);
  if(latest){
   const task=this.tasks.get(String(latest.task_id));
   if(task.state!=='stale'&&task.state!=='cancelled'){
    const frozen=this.draft(task);if(frozen.request.goal===command.goal)throw new StoreError('Assistant draft edit must change the goal',409);
   }
  }
 }
 start(context:AssistantDraftCommandContext){
  this.validateDraftVersion(context);
  const {command,turn}=context;
  const request={requestId:command.requestId,goal:command.goal,scope:command.scope};
  const prior=this.store.db.prepare('SELECT id FROM task_records WHERE request_id=?').get(request.requestId);
  if(prior){const task=this.tasks.get(String(prior.id));if(task.kind!=='assistant.task')throw new StoreError('Task request ID was reused with different content',409);
   if(!this.current(task)){this.retire(task);throw new StoreError('Assistant task input is no longer current',409);}}
  const discovered=prior?undefined:this.discover(request.scope);
  const evidenceIds=prior?this.draft(this.tasks.get(String(prior.id))).evidenceIds:discovered!.ids;
  const lineage=[...(turn.result?.evidenceDependencies?.ids??[]),...(turn.historyEvidenceDependencies?.ids??[])];
  if(turn.result?.evidenceDependencies?.complete===false||turn.historyEvidenceDependencies?.complete===false)
   throw new StoreError('Assistant draft evidence lineage is incomplete',409);
  const task=this.acceptance.acceptDraft(request,{conversationId:command.conversationId,turnId:command.turnId,draftRevision:command.expectedRevision},evidenceIds,lineage,this.assertCurrent,
   value=>{this.saveScope(value,request.scope,discovered!.snapshot);this.store.db.prepare('INSERT INTO assistant_task_turns VALUES(?,?,?,?,?)').run(value.id,command.conversationId,command.turnId,this.scopeHash(request.scope),command.expectedRevision);this.store.reserveMetadata(0);},
   (value,input)=>{this.batch().submit({operationId:value.operationId,requestId:input.requestId,items:[{question:input.goal,evidenceIds}]},
    {kind:'manual',identities:[],connections:this.connections()});});
  return {requestId:request.requestId,revision:command.expectedRevision,taskId:task.id};
 }
 acceptSuggestion(request:AssistantTaskInput,card:{cardId:string;expectedRevision:number},authority:MatterAuthority){
  const prior=this.store.db.prepare('SELECT id FROM task_records WHERE request_id=?').get(request.requestId);
  if(prior){const task=this.tasks.get(String(prior.id));if(task.kind!=='assistant.task')throw new StoreError('Task request ID was reused with different content',409);
   if(!this.current(task)){this.retire(task);throw new StoreError('Assistant task input is no longer current',409);}}
  const ids=this.discover(request.scope).ids;
  return this.acceptance.acceptSuggestion(request,card,authority,this.assertCurrent,(task,input)=>{
   this.batch().submit({operationId:task.operationId,requestId:input.requestId,items:[{question:input.goal,evidenceIds:ids}]},
    {kind:'manual',identities:[],connections:this.connections()});
  },{noUsableEvidence:ids.length===0});
 }
 /** Only the routine service can produce a persisted, due occurrence. Its
  * owner intent and scope are re-read inside the same admission transaction. */
 startRoutine(ref:RoutineRef){
  if(!this.store.db.isTransaction||!this.routines)throw new StoreError('Routine admission is unavailable',409);
  const input=this.routines.input(ref),request={requestId:input.requestId,goal:input.goal,scope:input.scope};
  const discovered=this.discover(request.scope,true),ids=discovered.ids;
  const task=this.tasks.create({operationId:'assistant.task:'+request.requestId,kind:'assistant.task',requestId:request.requestId,
   input:{request,routine:ref,coverage:input.coverage,evidenceIds:ids},evidenceDependencies:{version:1,complete:true,ids}},this.assertCurrent);
  this.saveScope(task,request.scope,discovered.snapshot);
  if(!ids.length){
   this.routines.control.automaticCommand('assistant-routine-empty:'+task.id,[input.receipt],'assistant',()=>{});
   return this.tasks.setState(task.id,task.revision,'blocked');
  }
  const question=`${request.goal}\n\nScheduled review occasions from ${input.coverage.from} through ${input.coverage.through} are combined into this review. State limitations of the available evidence separately.`;
  this.batch().submit({operationId:task.operationId,requestId:request.requestId,items:[{question,evidenceIds:ids}]},
   {kind:'automatic',purpose:'assistant',roots:[input.receipt]});
  return task;
 }
 valid(step:ExecutionStep){const task=this.taskForOperation(step.operationId);return !task||this.current(task);}
 project(step:ExecutionStep){
  const task=this.taskForOperation(step.operationId);if(!task||task.state==='stale'||task.state==='cancelled'||task.state==='succeeded')return;
  if(step.state==='stale'){this.retire(task);return;}
  if(['running','blocked','failed','cancelled','waiting'].includes(step.state)&&task.state!==step.state)
   this.tasks.setState(task.id,task.revision,step.state);
 }
 commit(step:ExecutionStep,result:QueryResult){
  const task=this.taskForOperation(step.operationId);if(!task)return;
  if(!this.current(task))throw new StoreError('Assistant task input is no longer current',409);
  this.tasks.saveResult(task.id,task.revision,result,result.evidenceDependencies!,this.assertCurrent);
 }
 private view(task:TaskRecord,expectedRevision?:number){
  if(task.state!=='stale'&&task.state!=='cancelled'&&!this.current(task)){this.retire(task);task=this.tasks.get(task.id);}
  const version=expectedRevision===undefined?{}:{expectedRevision};
  if(task.state==='stale'||task.state==='cancelled')return {task:{id:task.id,revision:task.revision,state:task.state},...version};
  const frozen=this.tasks.input<{request:AssistantTaskInput;coverage?:{from:string;through:string}}>(task.id,task.revision,this.assertCurrent),input=frozen.request;
  const result=this.tasks.result<QueryResult>(task.id,task.revision,this.assertCurrent);
  const step=this.store.db.prepare("SELECT error FROM execution_steps WHERE operation_id=? AND kind='batch.item' ORDER BY rowid LIMIT 1").get(task.operationId);
  const error=step?.error?String(step.error):task.state==='blocked'&&!step?'no_usable_evidence':undefined;
  const state:WorkState=task.state==='succeeded'?'completed':task.state==='blocked'?'needs_input':task.state==='skipped'?'excluded':task.state;
  const dependencies=this.tasks.evidenceDependencies(task.id,task.revision,this.assertCurrent);
  const record=assistantTaskRecordSchema.parse({id:task.id,...input,revision:task.revision,state,
   evidenceDependencies:historyEvidenceDependencies(this.store,dependencies)!,
   ...(result?.sourceContextDependencies?.length?{sourceContextDependencies:result.sourceContextDependencies}:{})});
  return {task:record,...version,...(frozen.coverage?{coverage:frozen.coverage}:{}),...(result?{result}:{}),...(error?{error}:{})};
 }
 byTurn(conversationId:string,turnId:string,scope:QueryScope){
  const hash=this.scopeHash(scope);
  const rows=this.store.db.prepare('SELECT task_id,draft_revision FROM assistant_task_turns WHERE conversation_id=? AND turn_id=? AND scope_hash=? ORDER BY draft_revision').all(conversationId,turnId,hash);
  return {items:rows.map(row=>this.view(this.tasks.get(String(row.task_id)),Number(row.draft_revision)))};
 }
 get(id:string,scope:QueryScope){
  const row=this.store.db.prepare('SELECT scope_hash FROM assistant_task_scopes WHERE task_id=?').get(id);
  if(!row||row.scope_hash!==this.scopeHash(scope))throw new StoreError('Assistant task not found',404);
  const task=this.tasks.get(id);if(task.kind!=='assistant.task')throw new StoreError('Assistant task not found',404);
  const origin=this.store.db.prepare('SELECT draft_revision FROM assistant_task_turns WHERE task_id=?').get(id);
  return this.view(task,origin?Number(origin.draft_revision):undefined);
 }
}
