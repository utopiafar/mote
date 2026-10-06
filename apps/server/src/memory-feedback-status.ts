import type {MemoryPipeline,MemoryBatch} from './memory-pipeline.js';
import {memoryFeedbackBatchId,type MemoryFeedbackRequest} from './memory-feedback.js';
import {DelegationRuntime,type DelegationProduct} from './delegation-runtime.js';
import {ExecutionFailure,type ExecutionStep} from './execution-engine.js';

type StatusInput={jobId:string;workId:string;unitId:string;batchId?:string;stop?:boolean};

/** Product observation owns no model slot. Each accepted revision group follows
 * its own child subtree, including later subdivision or bounded replanning. */
export function registerMemoryFeedbackStatus(options:{runtime:DelegationRuntime;pipeline:MemoryPipeline}){
 const {runtime,pipeline}=options;
 const input=(step:ExecutionStep)=>step.input as unknown as StatusInput;
 const valid=(step:ExecutionStep)=>{try{
  const selected=input(step),owner=runtime.get(selected.workId),unit=runtime.unit(selected.unitId),request=runtime.journal.payload<MemoryFeedbackRequest>(owner.id);
  return ['waiting','running','blocked'].includes(owner.status)&&!runtime.engine.cancellationAliasRevoked(owner.id)&&request.jobId===selected.jobId&&unit.workId===owner.id&&unit.external===true&&pipeline.feedbackAllowed(request)&&
   (selected.stop===true?unit.capabilityId==='memory.feedback-stop':unit.capabilityId==='memory.feedback-group'&&(selected.batchId===undefined||selected.batchId===memoryFeedbackBatchId(unit.id)));
 }catch{return false;}};
 const inspect=(step:ExecutionStep):{leaves:MemoryBatch[]}|ExecutionFailure=>{
  const selected=input(step);if(selected.stop)return new ExecutionFailure('blocked','memory_context_required');
  const job=pipeline.get(selected.jobId),byId=new Map(job.batches.map(batch=>[batch.id,batch])),root=byId.get(memoryFeedbackBatchId(selected.unitId));
  if(!root)return new ExecutionFailure('waiting','memory_feedback_pending',1000);
  const leaves:MemoryBatch[]=[],visited=new Set<string>(),visit=(batch:MemoryBatch):boolean=>{if(visited.has(batch.id))return false;visited.add(batch.id);
   if(batch.supersededBy?.length){for(const id of batch.supersededBy){const child=byId.get(id);if(!child||!visit(child))return false;}}else leaves.push(batch);return true;};
  if(!visit(root)||!leaves.length)return new ExecutionFailure('stale','memory_feedback_changed');
  if(leaves.some(batch=>batch.status==='invalidated'))return new ExecutionFailure('stale','evidence_changed');
  if(job.status==='cancelled')return new ExecutionFailure('permanent','memory_cancelled');
  if(leaves.some(batch=>batch.status==='failed'))return new ExecutionFailure(leaves.some(batch=>batch.errorCode==='memory_context_required')?'blocked':'permanent',leaves.some(batch=>batch.errorCode==='memory_context_required')?'memory_context_required':'memory_feedback_failed');
  if(leaves.some(batch=>batch.status!=='completed'))return new ExecutionFailure('waiting','memory_feedback_pending',1000);
  return {leaves};
 };
 return runtime.engine.register({kind:'memory.feedback-status',pool:'memory.feedback-status',concurrency:()=>8,maxAttempts:1,
  validate:valid,
  admit:step=>{const state=inspect(step);return state instanceof ExecutionFailure?state:undefined;},
  execute:async step=>{const state=inspect(step);if(state instanceof ExecutionFailure)throw state;const selected=input(step);
   return {value:{jobId:selected.jobId,batchId:memoryFeedbackBatchId(selected.unitId),batchIds:state.leaves.map(batch=>batch.id),memoryIds:[...new Set(state.leaves.flatMap(batch=>batch.memoryIds))]},summary:'Independently reviewed Memory work group',coverage:state.leaves.flatMap(batch=>batch.coverage??[]),dependencyIds:runtime.dependencyIds(selected.workId)} satisfies DelegationProduct;
  },
  commit:(step,product)=>{const selected=input(step);runtime.recordExternalArtifact(selected.workId,selected.unitId,product as DelegationProduct);},
 });
}
