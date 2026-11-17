import {z} from 'zod';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import type {QueryRunDependencies} from './plugins/query-runs.js';
import type {QueryRuntime} from './plugins/query-runtime.js';
import type {DelegationRuntime} from './delegation-runtime.js';
import type {ConversationMessage,ConversationSteering} from './conversations.js';
import {conversationInputIdentity} from './conversations.js';
import {scopeContainsHistory} from './query-scope.js';
import {ExecutionFailure} from './execution-engine.js';
import {StoreError,sha256} from './store.js';
import {isDeepStrictEqual} from 'node:util';

const decisionSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('independent')}).strict(),
  z.object({kind:z.literal('supplement'),targetMessageId:z.string().uuid(),reply:z.string().min(1)}).strict(),
  z.object({kind:z.literal('task-supplement'),targetTaskId:z.string().uuid(),reply:z.string().min(1)}).strict(),
]);
const strictSelection=(scope:ConversationMessage['scope'])=>scope.evidenceIds??(scope.kind==='selection'&&scope.sourceIds?.length===0?[]:undefined);
export const conversationSteeringScopeContains=(current:ConversationMessage['scope'],prior:ConversationMessage['scope'])=>scopeContainsHistory(current,prior)&&
  (strictSelection(current)===undefined||strictSelection(prior)!==undefined&&isDeepStrictEqual([...(strictSelection(current)??[])].sort(),[...(strictSelection(prior)??[])].sort()));
const visibleScope=(current:ConversationMessage,prior:ConversationMessage)=>conversationSteeringScopeContains(current.scope,prior.scope);

export function acceptedConversationAmendments(dependencies:QueryRunDependencies,message:ConversationMessage){
  const amendments=(message.amendedBy??[]).map(id=>dependencies.conversations.message(id)).sort((a,b)=>a.seq-b.seq);
  return amendments.map(amendment=>{
    const steering=amendment.steering,decision=amendment.disposition,inputHash=sha256(JSON.stringify(conversationInputIdentity(amendment)));
    const row=amendment.runId?dependencies.store.db.prepare('SELECT request_hash FROM query_runs WHERE id=?').get(amendment.runId):undefined;
    if(amendment.conversationId!==message.conversationId||amendment.seq<=message.seq||!['running','completed'].includes(amendment.status)||steering?.state!=='accepted'||steering.targetMessageId!==message.id||steering.targetRunId!==message.runId||decision?.kind!=='supplement'||decision.targetRunId!==message.runId||decision.targetVersion>=message.version||!steering.receipt||!isDeepStrictEqual(steering.target,steering.receipt)||row?.request_hash!==inputHash||!visibleScope(message,amendment)||dependencies.modelAuthorizationHost.control.workState('owner-query:'+amendment.runId)!=='current')throw new StoreError('Accepted conversation steering is no longer current',409);
    return {id:amendment.id,question:amendment.question,hostRunId:steering.receipt.identity.runId,key:sha256(JSON.stringify([amendment.id,inputHash,decision.targetVersion,steering.receipt]))};
  });
}

/** One phase of an existing durable query. Semantic disposition uses the
 * selected authorized model; waiting returns to the existing ExecutionEngine.
 * Nothing here holds a model slot while another work item is running. */
export function createConversationSteering(dependencies:QueryRunDependencies,runtime:DelegationRuntime,queryRuntime:QueryRuntime){
  const {store,conversations,executor,assertModelEvidence}=dependencies;
  return async(input:QueryInput,execute:(input:QueryInput)=>Promise<QueryResult>,reprepare:()=>Promise<QueryInput>)=>{
    const perform=async(prepared:QueryInput)=>{
      try{return await execute(prepared);}
      catch(error){if(error instanceof StoreError&&error.statusCode===409&&(error as StoreError&{code?:string}).code==='native_application_busy')throw new ExecutionFailure('waiting','native_application_busy',1000);throw error;}
    };
    // Research children share the operation id and lane, but only the actual
    // Host coordinator owns this control channel and receives owner input.
    if(!input.hostControlChannel||input.executionLane==='background'||input.skill||input.responseMode&&input.responseMode!=='answer')return perform(input);
    const operationId=input.traceContext?.operationId,id=operationId?.startsWith('query:')?operationId.slice(6):undefined;
    const initial=id&&conversations.messageForRun(id);
    if(!initial)return perform(input);
    const work=runtime.get('query:'+id),stepId=work.id+':coordinator:'+work.revision,fence=String(store.db.prepare('SELECT fence FROM execution_steps WHERE id=?').get(stepId)?.fence??'');
    const assertCurrent=()=>{
      input.signal?.throwIfAborted();if(!fence||!executor.isCurrentGrant(stepId,fence))throw new StoreError('Conversation steering admission expired',409);
      const current=conversations.message(initial.id);if(current.status!=='running'||current.runId!==id)throw new StoreError('Conversation steering message changed',409);
      assertModelEvidence(input);return current;
    };
    const compatible=(candidate:ConversationMessage)=>{
      if(candidate.id===initial.id||candidate.conversationId!==initial.conversationId||candidate.seq>=initial.seq||candidate.status!=='running'||!candidate.runId||!visibleScope(initial,candidate))return false;
      if(dependencies.modelAuthorizationHost.control.workState('owner-query:'+candidate.runId)==='revoked')return false;
      try{
        const saved=runtime.journal.payload<{prepared?:QueryInput;configurationFingerprint?:string}>('query:'+candidate.runId),prepared=saved.prepared;if(!prepared)return false;
        if(prepared.modelProfileId!==input.modelProfileId||prepared.modelOverride!==input.modelOverride)return false;
        if(!saved.configurationFingerprint||saved.configurationFingerprint!==runtime.journal.payload<{configurationFingerprint?:string}>(work.id).configurationFingerprint)return false;
        assertModelEvidence(prepared);queryRuntime.controls.get('query:'+candidate.runId)?.current();return true;
      }catch{return false;}
    };
    let message=assertCurrent();
    if(!message.disposition){
      const candidates=conversations.pendingHeads({parallel:true}).filter(compatible);
      const tasks=dependencies.taskSteering?.candidates(message,input,runtime.journal.payload<{configurationFingerprint?:string}>(work.id).configurationFingerprint)??[];
      if(!candidates.length&&!tasks.length){conversations.disposition(message.id,{kind:'independent'});return perform(input);}
      const question=JSON.stringify({task:'mote.conversation-disposition',instruction:'Decide whether this owner message supplements/corrects one listed current work item, or is an independent request. Interpret meaning from the actual message, visible conversation and work. Do not classify by keywords. Return answer as one JSON object: {kind:"independent"}; for a query candidate {kind:"supplement",targetMessageId:exact candidate id,reply:brief acknowledgement}; for an assistant.task candidate {kind:"task-supplement",targetTaskId:exact candidate id,reply:brief acknowledgement}. The acknowledgement is usable only after an actual native steering ACK. Never claim a queued continuation has been applied. Choose only a listed identity; no tools or actions.',message:{id:message.id,question:message.question,scope:message.scope},candidates:[...candidates.map(candidate=>({kind:'query',id:candidate.id,runId:candidate.runId,version:candidate.version,question:candidate.question,status:candidate.status})),...tasks.map(({reference:_,...metadata})=>metadata)]});
      const parse=(result:QueryResult)=>decisionSchema.parse(JSON.parse(result.answer));
      const routed=await perform({...input,question,responseMode:'other',assistantDraft:undefined,hostControlChannel:undefined,hostToolSelection:[],contextCapabilitySnapshot:undefined,onContextCapabilities:undefined,validateOutput:result=>{
        try{const decision=parse(result);if(decision.kind==='supplement'&&!candidates.some(candidate=>candidate.id===decision.targetMessageId)||decision.kind==='task-supplement'&&!tasks.some(candidate=>candidate.id===decision.targetTaskId))throw Error();if(result.citations.length)throw Error();}
        catch{return {code:'conversation_disposition',feedback:'Return only the requested JSON decision in answer, using an exact listed target id and no citations.'};}
      }});
      assertCurrent();const decision=parse(routed);
      if(decision.kind==='independent'){conversations.disposition(message.id,decision);return perform(input);}
      if(decision.kind==='task-supplement')message=conversations.disposition(message.id,{kind:'task-supplement',...tasks.find(candidate=>candidate.id===decision.targetTaskId)!.reference,acknowledgement:{...routed,answer:decision.reply}});
      else{const candidate=candidates.find(candidate=>candidate.id===decision.targetMessageId)!;
       message=conversations.disposition(message.id,{kind:'supplement',targetMessageId:candidate.id,targetRunId:candidate.runId!,targetVersion:candidate.version,acknowledgement:{...routed,answer:decision.reply}});}
    }
    const decision=message.disposition!;if(decision.kind==='independent')return perform(input);
    if(decision.kind==='task-supplement'){
      if(!dependencies.taskSteering)throw new ExecutionFailure('blocked','assistant_task_unavailable');
      return dependencies.taskSteering.apply(message,input,assertCurrent,runtime.journal.payload<{configurationFingerprint?:string}>(work.id).configurationFingerprint);
    }
    const target=conversations.message(decision.targetMessageId),base={targetMessageId:target.id,targetRunId:decision.targetRunId};
    if(message.steering?.state==='pending'){
      conversations.recordSteering(message.id,{...message.steering,state:'unknown'});throw new ExecutionFailure('permanent','steering_delivery_unknown');
    }
    if(message.steering?.state==='unknown'||message.steering?.state==='cancelled')throw new ExecutionFailure('permanent','steering_delivery_unknown');
    if(message.steering?.state==='accepted')return decision.acknowledgement;
    if(!message.steering){
      const control=queryRuntime.controls.get('query:'+target.runId),native=control?.current();
      const canApply=compatible(target)&&visibleScope(target,message)&&!message.attachments?.length&&!message.scope.anchorEvidenceIds?.length&&!message.scope.anchorMaterialRef&&target.version===decision.targetVersion;
      if(canApply&&control?.supported&&!native)throw new ExecutionFailure('waiting','steering_turn_pending',100);
      if(canApply&&native&&control){
        const pending:ConversationSteering={...base,state:'pending',registrationId:control.registrationId,target:native};
        conversations.recordSteering(message.id,pending);
        try{
          assertCurrent();await control.steer(native,message.question,receipt=>{
            assertCurrent();if(queryRuntime.controls.get('query:'+target.runId)!==control)throw new StoreError('Conversation runtime was replaced',409);
            const current=conversations.message(target.id);if(current.status!=='running'||current.runId!==base.targetRunId)throw new StoreError('Conversation target settled before steering',409);
            conversations.recordSteering(message.id,{...pending,state:'accepted',receipt});
          });
          assertCurrent();return decision.acknowledgement;
        }catch(error){
          // pending was durable before I/O. Even when the accepted write fails,
          // the remote input may exist; no retry is allowed to send it again.
          try{const current=conversations.message(message.id);if(current.status==='running'&&current.steering?.state==='pending')conversations.recordSteering(message.id,{...pending,state:'unknown'});}catch{/* Preserve the original failure and durable pending fact. */}
          throw Object.assign(new ExecutionFailure('permanent','steering_delivery_unknown'),{cause:error});
        }
      }
      message=conversations.recordSteering(message.id,{...base,state:'continuation'});
    }
    const current=conversations.message(target.id);
    if(['accepted','queued','running'].includes(current.status))throw new ExecutionFailure('waiting','conversation_continuation',100);
    if(current.status!=='completed')throw new ExecutionFailure('permanent','steering_target_unavailable');
    assertCurrent();const prepared=await reprepare();assertCurrent();return perform(prepared);
  };
}
