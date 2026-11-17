import {isDeepStrictEqual} from 'node:util';
import type {QueryInput} from '@mote/agent';
import {ProviderFailure,type QueryResult,type QueryScope} from '@mote/shared';
import type {ConversationRepository} from './plugins/central-contracts.js';
import {conversationInputIdentity,type ConversationMessage,type ConversationTaskSteering,type TaskSteeringReference} from './conversations.js';
import {ConversationRuntimeControls} from './conversation-runtime-controls.js';
import {conversationSteeringScopeContains} from './conversation-steering.js';
import {ExecutionFailure,type ExecutionStep} from './execution-engine.js';
import {sha256,StoreError,type Store} from './store.js';
import type {TaskRecord} from './task-records.js';

export type AssistantTaskSteeringAuthority={workState(id:string):'missing'|'current'|'revoked';isCurrentGrant(id:string,fence:string):boolean;abortLocal(id:string):void};
export type AssistantTaskSteeringWork={task:TaskRecord;goal:string;scope:QueryScope;origin?:{conversationId:string;turnId:string}};
export type AssistantTaskSteeringOwner={work(id:string):AssistantTaskSteeringWork;forOperation(id:string):TaskRecord|undefined;result(id:string):QueryResult|undefined;continue(work:AssistantTaskSteeringWork,message:ConversationMessage):string};
type Proof={taskId:string;revision:number;stepId:string;fence:string;keys:string[]};

/** An adapter for the existing Task owner and Batch executor. Messages and
 * receipts remain in Conversations; no second task or scheduling state lives here. */
export class AssistantTaskSteering {
 private readonly controls=new ConversationRuntimeControls();
 private readonly selections=new Map<string,{registrationId:string;profileId?:string;model?:string}>();
 private readonly proofs=new WeakMap<QueryResult,Proof>();
 constructor(private readonly store:Store,private readonly conversations:ConversationRepository,private readonly owner:AssistantTaskSteeringOwner,private readonly authority:AssistantTaskSteeringAuthority){}
 private inputHash(id:string){return String(this.store.db.prepare("SELECT request_hash FROM task_records WHERE id=? AND kind='assistant.task' AND input_json IS NOT NULL").get(id)?.request_hash??'');}
 private transaction<T>(write:()=>T):T{
  const db=this.store.db,own=!db.isTransaction;db.exec(own?'BEGIN IMMEDIATE':'SAVEPOINT assistant_task_steering');
  try{const value=write();db.exec(own?'COMMIT':'RELEASE assistant_task_steering');return value;}
  catch(error){if(db.isTransaction)db.exec(own?'ROLLBACK':'ROLLBACK TO assistant_task_steering; RELEASE assistant_task_steering');throw error;}
 }
 private messages(id:string){return this.store.db.prepare("SELECT id FROM conversation_turns WHERE json_extract(json,'$.taskSteering.targetTaskId')=? ORDER BY conversation_id,idx").all(id).map(row=>this.conversations.message(String(row.id)));}
 private amendmentKey(message:ConversationMessage){const value=message.taskSteering!;return sha256(JSON.stringify([message.id,conversationInputIdentity(message),value.targetTaskId,value.targetOperationId,value.targetRevision,value.taskInputHash,value.target,value.receipt,value.continuationBatchId]));}
 private visible(message:ConversationMessage,work:AssistantTaskSteeringWork){return conversationSteeringScopeContains(message.scope,work.scope)&&conversationSteeringScopeContains(work.scope,message.scope)&&!message.attachments?.length&&!message.scope.anchorEvidenceIds?.length&&!message.scope.anchorMaterialRef;}
 candidates(message:ConversationMessage,input:QueryInput){
  return this.store.db.prepare("SELECT id FROM task_records WHERE kind='assistant.task' AND state IN ('waiting','running','blocked') ORDER BY created_at,id").all().flatMap(row=>{
   try{const work=this.owner.work(String(row.id));if(!this.visible(message,work))return [];
    const control=this.controls.get(work.task.operationId),native=control?.current(),selection=this.selections.get(work.task.operationId);
    if(native&&(!selection||selection.registrationId!==control?.registrationId||selection.profileId!==input.modelProfileId||selection.model!==input.modelOverride||native.identity.model.modelId!==selection.model))return [];
    return [{kind:'assistant.task' as const,id:work.task.id,operationId:work.task.operationId,revision:work.task.revision,goal:work.goal,status:work.task.state,
     reference:{targetTaskId:work.task.id,targetOperationId:work.task.operationId,targetRevision:work.task.revision,taskInputHash:this.inputHash(work.task.id)} satisfies TaskSteeringReference}];
   }catch{return [];}
  });
 }
 private current(reference:TaskSteeringReference,exact=false){
  const work=this.owner.work(reference.targetTaskId);
  if(work.task.operationId!==reference.targetOperationId||!reference.taskInputHash||this.inputHash(work.task.id)!==reference.taskInputHash||exact&&work.task.revision!==reference.targetRevision)throw new StoreError('Assistant task steering target changed',409);
  return work;
 }
 private amendments(work:AssistantTaskSteeringWork){
  return this.messages(work.task.id).flatMap(message=>{
   const receipt=message.taskSteering,decision=message.disposition;
   if(message.status==='cancelled'||receipt?.state==='cancelled')return [];
   if(receipt?.state==='pending'||receipt?.state==='unknown')throw new ExecutionFailure('blocked','steering_delivery_unknown');
   if(decision?.kind!=='task-supplement'||!receipt||!['accepted','continuation'].includes(receipt.state)||!['running','completed'].includes(message.status)||!this.visible(message,work)||decision.taskInputHash!==this.inputHash(work.task.id)||receipt.taskInputHash!==decision.taskInputHash||receipt.targetOperationId!==work.task.operationId||
    this.authority.workState('owner-query:'+message.runId)!=='current'||this.store.db.prepare('SELECT request_hash FROM query_runs WHERE id=?').get(message.runId??'')?.request_hash!==sha256(JSON.stringify(conversationInputIdentity(message)))||
    receipt.state==='accepted'&&(!receipt.receipt||!isDeepStrictEqual(receipt.target,receipt.receipt)))throw new StoreError('Assistant task amendment is no longer permitted',409);
   return [{messageId:message.id,question:message.question,hostRunId:receipt.receipt?.identity.runId,key:this.amendmentKey(message)}];
  });
 }
 prepare(input:QueryInput,work:AssistantTaskSteeringWork){
  const amendments=this.amendments(work);if(!amendments.length)return input;
  return {...input,taskContext:{...input.taskContext,turns:input.taskContext?.turns??[],ownerAmendments:amendments.map(({messageId,question})=>({messageId,question}))}};
 }
 async execute(input:QueryInput,query:(input:QueryInput)=>Promise<QueryResult>){
  const task=input.traceContext?.operationId&&this.owner.forOperation(input.traceContext.operationId);if(!task)return query(input);
  const work=this.owner.work(task.id),stepId=input.traceContext?.batchId,step=stepId&&this.store.db.prepare("SELECT operation_id,fence FROM execution_steps WHERE id=? AND kind='batch.item' AND state='running'").get(stepId);
  if(!step||step.operation_id!==task.operationId||typeof step.fence!=='string')throw new StoreError('Assistant task execution is no longer current',409);
  const fence=step.fence,amendments=this.amendments(work),keys=amendments.map(item=>item.key);
  if(keys.length&&!isDeepStrictEqual(input.taskContext?.ownerAmendments,amendments.map(({messageId,question})=>({messageId,question}))))throw new StoreError('Assistant task preparation missed current owner input',409);
  const assert=()=>{input.signal?.throwIfAborted();input.assertContextAuthority?.();const current=this.owner.work(task.id);if(current.task.revision!==task.revision||!this.authority.isCurrentGrant(stepId!,fence))throw new StoreError('Assistant task execution changed',409);};
  assert();const previous=input.onRuntimeControl;
  const result=await query({...input,onRuntimeControl:control=>{
   const release=this.controls.register(task.operationId,control,assert);let other:(()=>void)|void;
   const selection={registrationId:this.controls.get(task.operationId)!.registrationId,profileId:input.modelProfileId,model:input.modelOverride};this.selections.set(task.operationId,selection);
   try{other=previous?.(control);}catch(error){release();if(this.selections.get(task.operationId)===selection)this.selections.delete(task.operationId);throw error;}
   return()=>{release();if(this.selections.get(task.operationId)===selection)this.selections.delete(task.operationId);other?.();};
  }});assert();this.proofs.set(result,{taskId:task.id,revision:task.revision,stepId:stepId!,fence,keys});return result;
 }
 assertCommit(step:ExecutionStep,result:QueryResult,task:TaskRecord){
  const proof=this.proofs.get(result);
  if(!proof||proof.taskId!==task.id||proof.revision!==task.revision||proof.stepId!==step.id||!this.authority.isCurrentGrant(step.id,proof.fence))throw new StoreError('Assistant task result has no current execution receipt',409);
  if(this.messages(task.id).some(message=>message.taskSteering?.state==='cancelled'&&(message.taskSteering.target?.identity.runId===result.runId||proof.keys.includes(this.amendmentKey(message)))))throw new StoreError('Assistant task result used a withdrawn amendment',409);
  if(this.amendments(this.owner.work(task.id)).some(item=>item.hostRunId!==result.runId&&!proof.keys.includes(item.key)))throw new StoreError('A late task result missed an accepted owner amendment',409);
 }
 async apply(message:ConversationMessage,input:QueryInput,assertCurrent:()=>ConversationMessage):Promise<QueryResult>{
  const decision=message.disposition;if(decision?.kind!=='task-supplement')throw new StoreError('Assistant task disposition is unavailable',409);
  let work=this.current(decision);if(!this.visible(message,work))throw new StoreError('Assistant task is outside the owner message scope',409);
  if(message.taskSteering?.state==='pending'){this.conversations.recordTaskSteering(message.id,{...message.taskSteering,state:'unknown'});throw new ExecutionFailure('permanent','steering_delivery_unknown');}
  if(message.taskSteering?.state==='unknown'||message.taskSteering?.state==='cancelled')throw new ExecutionFailure('permanent','steering_delivery_unknown');
  if(message.taskSteering?.state==='accepted')return decision.acknowledgement;
  if(!message.taskSteering){
   work=this.current(decision,true);const control=this.controls.get(work.task.operationId),native=control?.current();
   if(control?.supported&&!native)throw new ExecutionFailure('waiting','steering_turn_pending',100);
   if(control&&native){
    const selection=this.selections.get(work.task.operationId);
    if(!selection||selection.registrationId!==control.registrationId||selection.profileId!==input.modelProfileId||selection.model!==input.modelOverride||native.identity.model.modelId!==selection.model)throw new StoreError('Assistant task model selection changed',409);
    const step=this.store.db.prepare("SELECT id,fence FROM execution_steps WHERE operation_id=? AND kind='batch.item' AND state='running'").get(work.task.operationId);
    if(!step||typeof step.fence!=='string'||!this.authority.isCurrentGrant(String(step.id),step.fence))throw new StoreError('Assistant task native attempt expired',409);
    const pending:ConversationTaskSteering={targetTaskId:decision.targetTaskId,targetOperationId:decision.targetOperationId,targetRevision:decision.targetRevision,taskInputHash:decision.taskInputHash,state:'pending',stepId:String(step.id),stepFence:step.fence,registrationId:control.registrationId,target:native};
    this.conversations.recordTaskSteering(message.id,pending);
    try{assertCurrent();await control.steer(native,message.question,receipt=>{
     assertCurrent();this.current(decision,true);if(this.controls.get(work.task.operationId)!==control||!this.authority.isCurrentGrant(pending.stepId!,pending.stepFence!))throw new StoreError('Assistant task native attempt changed',409);
     this.conversations.recordTaskSteering(message.id,{...pending,state:'accepted',receipt});
    });assertCurrent();return decision.acknowledgement;}
    catch(error){try{const current=this.conversations.message(message.id);if(current.status==='running'&&current.taskSteering?.state==='pending')this.conversations.recordTaskSteering(message.id,{...pending,state:'unknown'});}catch{/* Retain the durable pending record if this write also fails. */}
     throw Object.assign(new ExecutionFailure('permanent','steering_delivery_unknown'),{cause:error});}
   }
   message=this.transaction(()=>{
    assertCurrent();this.current(decision,true);
    const reference={targetTaskId:decision.targetTaskId,targetOperationId:decision.targetOperationId,targetRevision:decision.targetRevision,taskInputHash:decision.taskInputHash};
    this.conversations.recordTaskSteering(message.id,{...reference,state:'continuation'});
    const continuation=this.owner.continue(work,message);
    return this.conversations.recordTaskSteering(message.id,{...reference,state:'continuation',continuationBatchId:continuation});
   });
  }
  assertCurrent();const result=this.owner.result(work.task.id);if(result)return result;
  throw new ExecutionFailure('waiting','assistant_task_continuation',1000);
 }
 cancel(message:ConversationMessage){
  return this.transaction(()=>{
   message=this.conversations.message(message.id);if(message.status==='cancelled')return message;
   const decision=message.disposition;if(decision?.kind!=='task-supplement'||!message.taskSteering)throw new StoreError('Assistant task amendment is unavailable',409);
   const work=this.current(decision);if(['succeeded','cancelled','stale'].includes(work.task.state))throw new StoreError('Assistant task has already finished',409);
   const cancelled=this.conversations.cancel(message.id);
   try{this.owner.continue(work,cancelled);}
   catch(error){if(!(error instanceof ProviderFailure)||error.details.category!=='blocked')throw error;
    const stepId=message.taskSteering.stepId;if(stepId)queueMicrotask(()=>{if(this.conversations.message(message.id).status==='cancelled')this.authority.abortLocal(stepId);});
   }
   return cancelled;
  });
 }
}
