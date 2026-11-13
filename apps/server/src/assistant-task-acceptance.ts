import {isDeepStrictEqual} from 'node:util';
import {assistantTaskInputSchema,type AssistantTaskInput} from '@mote/shared';
import {z} from 'zod';
import {AssistantCards} from './assistant-cards.js';
import {AssistantMatters,type MatterAuthority} from './assistant-matters.js';
import {withinEvidenceScope} from './evidence-reader.js';
import {StoreError,type Store} from './store.js';
import {TaskRecords,type AssertTaskCurrent,type TaskRecord} from './task-records.js';

const referenceSchema=z.object({cardId:z.string().uuid(),expectedRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict();
type Reference=z.infer<typeof referenceSchema>;
type FrozenAcceptance={request:AssistantTaskInput;card:Reference;cardVersion:string;matterId:string|null};
export type FrozenDraftTask={request:AssistantTaskInput;conversationId:string;turnId:string;draftRevision:number;evidenceIds:string[]};
type FrozenBatchItem={question:string;evidenceIds:string[]};

/** A domain admission callback must synchronously enqueue work in this same
 * transaction. It cannot do model I/O or make an external effect. */
export type EnqueueAcceptedTask=(task:TaskRecord,request:AssistantTaskInput)=>void;
type SuggestionHooks={validate:(request:AssistantTaskInput,ids:string[])=>void;accepted:(task:TaskRecord,request:AssistantTaskInput,ids:string[])=>void};

/** The only writer for accepting a suggestion and linking its task. The
 * execution adapter and its existing model authority are supplied by the
 * product host, so a receipt by itself never grants execution permission. */
export class AssistantTaskAcceptance {
 private readonly tasks:TaskRecords;
 constructor(private readonly store:Store,private readonly cards:AssistantCards,private readonly matters:AssistantMatters,private readonly suggestionHooks?:SuggestionHooks){
  this.tasks=new TaskRecords(store);
 }
 private transaction<T>(write:()=>T):T{
  const db=this.store.db;db.exec('SAVEPOINT assistant_task_acceptance');
  try{const result=write();db.exec('RELEASE assistant_task_acceptance');return result;}
  catch(error){db.exec('ROLLBACK TO assistant_task_acceptance; RELEASE assistant_task_acceptance');throw error;}
 }

 /** The same acceptance owner handles a conversation draft. Its origin and
  * exact read set are private immutable input, not model-granted authority. */
 acceptDraft(rawRequest:AssistantTaskInput,origin:{conversationId:string;turnId:string;draftRevision:number},evidenceIds:string[],
  dependencies:string[],assertCurrent:AssertTaskCurrent,link:(task:TaskRecord)=>void,enqueue:EnqueueAcceptedTask):TaskRecord{
  const parsed=assistantTaskInputSchema.parse(rawRequest),request={...parsed,goal:parsed.goal.trim()};
  const ref=z.object({conversationId:z.string().uuid(),turnId:z.string().uuid(),draftRevision:z.number().int().nonnegative().safe()}).strict().parse(origin);
  return this.transaction(()=>{
   const previous=this.store.db.prepare('SELECT id FROM task_records WHERE request_id=?').get(request.requestId);
   if(previous){
    const task=this.tasks.get(String(previous.id));
    if(task.kind!=='assistant.task')throw new StoreError('Task request ID was reused with different content',409);
    const frozen=this.tasks.input<FrozenDraftTask>(task.id,task.revision,assertCurrent);
    if(!isDeepStrictEqual(frozen.request,request)||frozen.conversationId!==ref.conversationId||frozen.turnId!==ref.turnId||frozen.draftRevision!==ref.draftRevision)
     throw new StoreError('Task request ID was reused with different content',409);
    return task;
   }
   const frozen:FrozenDraftTask={request,...ref,evidenceIds:[...evidenceIds]};
   const task=this.tasks.create({operationId:'assistant.task:'+request.requestId,kind:'assistant.task',requestId:request.requestId,
    input:frozen,evidenceDependencies:{version:1,complete:true,ids:[...new Set([...dependencies,...evidenceIds])]}},assertCurrent);
   link(task);
   if(!evidenceIds.length)return this.tasks.setState(task.id,task.revision,'blocked');
   const result:unknown=enqueue(task,request);
   if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw new StoreError('Task enqueue must complete synchronously',409);}
   const batches=this.store.db.prepare("SELECT id FROM task_records WHERE operation_id=? AND kind='batch'").all(task.operationId);
   const items=this.store.db.prepare("SELECT id FROM task_records WHERE operation_id=? AND kind='batch.item'").all(task.operationId);
   if(batches.length!==1||items.length!==1||!this.store.db.prepare(`SELECT 1 FROM execution_steps WHERE operation_id=? AND kind='batch.item'
    AND json_extract(input,'$.batchId')=? AND json_extract(input,'$.itemId')=?`).get(task.operationId,batches[0].id,items[0].id))
    throw new StoreError('Task execution was not enqueued',409);
   const item=this.tasks.get(String(items[0].id)),work=this.tasks.input<FrozenBatchItem>(item.id,item.revision,assertCurrent);
   if(work.question!==request.goal||!isDeepStrictEqual(work.evidenceIds,evidenceIds))throw new StoreError('Task execution does not match the owner command',409);
   return task;
  });
 }

 acceptSuggestion(rawRequest:AssistantTaskInput,rawCard:Reference,authority:MatterAuthority,assertCurrent:AssertTaskCurrent,enqueue:EnqueueAcceptedTask,
  options?:{noUsableEvidence:boolean}):TaskRecord{
  const parsed=assistantTaskInputSchema.parse(rawRequest),request={...parsed,goal:parsed.goal.trim()};
  const cardRef=referenceSchema.parse(rawCard);
  return this.transaction(()=>{
   const previous=this.store.db.prepare('SELECT id FROM task_records WHERE request_id=?').get(request.requestId);
   if(previous){
    const task=this.tasks.get(String(previous.id));
    if(task.kind!=='assistant.task')throw new StoreError('Task request ID was reused with different content',409);
    const frozen=this.tasks.input<FrozenAcceptance>(task.id,task.revision,assertCurrent);
    if(!isDeepStrictEqual(frozen.request,request)||!isDeepStrictEqual(frozen.card,cardRef))
     throw new StoreError('Task request ID was reused with different content',409);
    const card=this.cards.get(cardRef.cardId,request.scope);
    if(card.state==='stale'||card.version!==frozen.cardVersion||card.acceptedTaskId!==task.id)
     throw new StoreError('Suggestion is no longer current',409);
    return task;
   }
   const card=this.cards.get(cardRef.cardId,request.scope);
   if(card.kind!=='suggestion'||card.state!=='open'||card.revision!==cardRef.expectedRevision||card.acceptedTaskId)
    throw new StoreError('Suggestion changed; reload before continuing',409);
   const frozen:FrozenAcceptance={request,card:cardRef,cardVersion:card.version,matterId:card.matterId};
   const task=this.tasks.create({operationId:'assistant.task:'+request.requestId,kind:'assistant.task',requestId:request.requestId,
    input:frozen,evidenceDependencies:{version:1,complete:true,ids:[...new Set([...card.evidenceDependencies.ids,...(request.scope.evidenceIds??[])])]}},assertCurrent);
   if(card.matterId){
    const matter=this.matters.get(card.matterId);
    if(!isDeepStrictEqual(matter.scope,request.scope))throw new StoreError('Suggestion and matter scopes differ',409);
    this.matters.attachTask(matter.id,matter.revision,task.id,authority);
   }
   if(options?.noUsableEvidence){
    if(!this.suggestionHooks)throw new StoreError('Task execution was not enqueued',409);
    this.suggestionHooks.validate(request,[]);this.cards.associateTask(card.id,cardRef.expectedRevision,task.id,request.scope);
    this.suggestionHooks.accepted(task,request,[]);return this.tasks.setState(task.id,task.revision,'blocked');
   }
   // Reject an asynchronous adapter: releasing the savepoint before enqueue
   // settles would permit a half-accepted suggestion and an orphaned task.
   const result:unknown=enqueue(task,request);
   if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw new StoreError('Task enqueue must complete synchronously',409);}
   const batches=this.store.db.prepare("SELECT id FROM task_records WHERE operation_id=? AND kind='batch'").all(task.operationId);
   const items=this.store.db.prepare("SELECT id FROM task_records WHERE operation_id=? AND kind='batch.item'").all(task.operationId);
   if(batches.length!==1||items.length!==1||!this.store.db.prepare(`SELECT 1 FROM execution_steps WHERE operation_id=? AND kind='batch.item'
    AND json_extract(input,'$.batchId')=? AND json_extract(input,'$.itemId')=?`).get(task.operationId,batches[0].id,items[0].id))
    throw new StoreError('Task execution was not enqueued',409);
   const item=this.tasks.get(String(items[0].id));
   const work=this.tasks.input<FrozenBatchItem>(item.id,item.revision,assertCurrent);
   if(work.question!==request.goal||!Array.isArray(work.evidenceIds))throw new StoreError('Task execution does not match the owner command',409);
   if(this.suggestionHooks)this.suggestionHooks.validate(request,work.evidenceIds);
   else{
    const records=this.store.evidence(work.evidenceIds),scope=request.scope;
    if(records.length!==work.evidenceIds.length||records.some(record=>record.privacy.excluded||!withinEvidenceScope(record,scope)||
     scope.evidenceIds!==undefined&&!scope.evidenceIds.includes(record.id)||scope.kind==='selection'&&scope.sourceIds!==undefined&&
     (!record.provenance?.sourceId||!scope.sourceIds.includes(record.provenance.sourceId))))
     throw new StoreError('Task execution is outside the owner scope',409);
   }
   this.cards.associateTask(card.id,cardRef.expectedRevision,task.id,request.scope);
   this.suggestionHooks?.accepted(task,request,work.evidenceIds);
   return task;
  });
 }
}
