import {registerMemoryFeedbackPlanner} from './memory-feedback-planner.js';
import {z} from 'zod';
import type {ContextRecord,QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {DelegationRuntime,type DelegationWork} from './delegation-runtime.js';
import {ExecutionFailure} from './execution-engine.js';
import {sha256,StoreError} from './store.js';
import type {MemoryPipeline} from './memory-pipeline.js';
import type {MaterialMemoryWork,MemoryWorkCandidate,MemoryWorkProposal} from './material-memory-work.js';
import type {SourcePipelineRuntime} from './source-pipelines.js';
import type {ModelConfiguration} from './model-configuration.js';

const packageInput=z.object({members:z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(8),instruction:z.string().min(1).max(4000)}).strict();
type PlannerInput={catalog:MemoryWorkCandidate[];evidenceIds?:string[];configuration?:ModelConfiguration};
export type MemoryDelegationOptions={runtime:DelegationRuntime;pipeline:MemoryPipeline;work:MaterialMemoryWork;sourcePipelines:SourcePipelineRuntime;query:(input:QueryInput)=>Promise<QueryResult>;configuration?:()=>ModelConfiguration;recoveryAllowed?:()=>boolean;allowCandidate?:(candidate:MemoryWorkCandidate,pin:ReturnType<MaterialMemoryWork['planningInput']>)=>boolean;sample?:(candidate:MemoryWorkCandidate,offset:number,length:number)=>Promise<ContextRecord[]>};

/** Memory uses the same coordinator tools and journal as Ask. Only its handoff
 * and independently authorized product commits differ. Metadata is never a
 * basis for a zero-candidate verdict. */
export function registerMemoryDelegation(options:MemoryDelegationOptions){
 const {runtime,pipeline,work,sourcePipelines}=options;
 const allowCandidate=(candidate:MemoryWorkCandidate,jobId?:string)=>{try{const pin=work.planningInput(candidate,jobId);return options.allowCandidate?.(candidate,pin)??true;}catch{return false;}};
 const accepted=(owner:DelegationWork)=>owner.plannedUnitIds?owner.units.filter(unit=>owner.plannedUnitIds!.includes(unit.id)):owner.units.filter(unit=>unit.status!=='cancelled');
 const catalog=(owner:DelegationWork)=>runtime.journal.payload<PlannerInput>(owner.id).catalog;
 const compatible=(owner:DelegationWork,input:Record<string,unknown>)=>{
  const parsed=packageInput.safeParse(input);if(!parsed.success||new Set(parsed.data.members).size!==parsed.data.members.length)return false;
  const selected=parsed.data.members.map(key=>catalog(owner).find(candidate=>candidate.key===key));
  return selected.every(Boolean)&&new Set(selected.map(candidate=>JSON.stringify(candidate!.recipe))).size===1&&(selected.length===1||selected.reduce((sum,candidate)=>sum+candidate!.characters,0)<=12000);
 };
 const planReceipt=(owner:DelegationWork)=>{
  const units=accepted(owner).filter(unit=>unit.capabilityId==='memory.package');
  if(units.some(unit=>unit.capabilityVersion!=='1'||!compatible(owner,unit.input)))return;
  const expected=catalog(owner).map(candidate=>candidate.key),selected=units.flatMap(unit=>packageInput.parse(unit.input).members);
  if(new Set(selected).size!==selected.length||expected.length!==selected.length||expected.some(key=>!selected.includes(key)))return;
  return {acceptedUnitIds:units.map(unit=>unit.id)};
 };
 runtime.register({id:'memory.package',version:'1',proposal:true,cancel:unit=>{const row=runtime.store.db.prepare("SELECT id FROM memory_jobs WHERE json_extract(json,'$.workPackage.id')=?").get(unit.id);if(row)pipeline.cancel(String(row.id));},retry:unit=>{const row=runtime.store.db.prepare("SELECT id FROM memory_jobs WHERE json_extract(json,'$.workPackage.id')=?").get(unit.id);if(row)void pipeline.retry(String(row.id)).catch(()=>{});},description:'Propose an independently reviewed Memory work package from host catalog member keys. Keep original attribution and dates; each input keeps its own receipt. The host atomically grants the package to the existing Memory executor.',inputSchema:{type:'object',properties:{members:{type:'array',items:{type:'string'},minItems:1,maxItems:8},instruction:{type:'string'}},required:['members','instruction'],additionalProperties:false},validate:(unit,owner)=>compatible(owner,unit.input),execute:async()=>{throw new StoreError('Memory packages use their product executor',409);}});
 if(options.sample)runtime.register({id:'memory.inspect',version:'1',description:'Read a small authorized original sample to understand input structure and select work packages. A sample cannot prove a complete no-candidate verdict.',inputSchema:{type:'object',properties:{member:{type:'string'},offset:{type:'integer'},length:{type:'integer'}},required:['member','offset','length'],additionalProperties:false},validate:(unit,owner)=>Object.keys(unit.input).every(key=>['member','offset','length'].includes(key))&&catalog(owner).some(candidate=>candidate.key===unit.input.member)&&Number.isSafeInteger(unit.input.offset)&&Number(unit.input.offset)>=0&&Number.isSafeInteger(unit.input.length)&&Number(unit.input.length)>0&&Number(unit.input.length)<=2000,execute:async(unit,{work:owner,signal})=>{signal.throwIfAborted();const candidate=catalog(owner).find(candidate=>candidate.key===unit.input.member)!;const evidence=await options.sample!(candidate,Number(unit.input.offset),Number(unit.input.length));signal.throwIfAborted();return {value:{member:candidate.key,sample:evidence},summary:'Authorized input sample',evidence};}});
 runtime.registerCoordinator({id:'memory.plan',awaitExternal:true,recoveryAllowed:options.recoveryAllowed,recoverPlan:planReceipt,
  validate:(owner,input)=>{const selected=input as PlannerInput;return (!selected.configuration||!options.configuration||selected.configuration.fingerprint===options.configuration().fingerprint)&&selected.catalog.every(candidate=>{if(!owner.planningComplete)return allowCandidate(candidate);const unit=accepted(owner).find(unit=>unit.capabilityId==='memory.package'&&packageInput.safeParse(unit.input).success&&(unit.input.members as string[]).includes(candidate.key)),row=unit&&runtime.store.db.prepare("SELECT id FROM memory_jobs WHERE json_extract(json,'$.workPackage.id')=?").get(unit.id);return allowCandidate(candidate,row?String(row.id):undefined);});},
  execute:({work:owner,input,signal,controls})=>{const selected=input as PlannerInput;return options.query({question:'Choose and submit bounded Memory work packages covering every host catalog member exactly once. Use the supplied source identity, reliable times, length and policy metadata for planning; sample originals only when useful. Let the model decide which authorized materials should be understood together. Cross-source grouping is allowed when recipe and privacy authority are compatible. Never infer themes or memory value from dates, titles or lengths. Discover capabilities and submit stable memory.package units with input:{members:[catalog keys],instruction:"focused worker instructions"}. A package permits 1–8 members and 12000 source characters; one long member may be subdivided by the existing executor. Keep member provenance independent. A sample is not full processing. Metadata cannot establish no_candidates or exclude an input from full processing. Preserve all catalog keys; missing members cannot be declared finished. Do not wait for proposal execution or summarize every original; finish the planning fragment after submitting the complete bounded catalog. Existing submitted unit handles are durable and must be reused on restart. Copy the supplied localId exactly when resubmitting; retain existing packages unless they require correction.',hostRetrieval:'none',hostControlChannel:controls,responseMode:'answer',signal,modelProfileId:selected.configuration?.profileId,modelOverride:selected.configuration?.model,contextTime:owner.scope.contextTime,taskContext:{turns:[],memoryWork:{catalog:selected.catalog,units:owner.units.map(({id,capabilityId,title,goal,input,status})=>({id,localId:id.slice(id.lastIndexOf(':unit:')+6),capabilityId,title,goal,input,status})),scope:'Only this bounded catalog, not the full archive'}},traceContext:{operationId:owner.operationId,moduleId:'memories',phase:'planning'}});},
  commit:owner=>{const receipt=planReceipt(owner);if(!receipt)throw new ExecutionFailure('permanent','memory_planning_incomplete');return receipt;},
 });
 const stop=runtime.engine.register({kind:'memory.package-status',pool:'memory.package-status',concurrency:()=>8,maxAttempts:1,
  validate:step=>{try{return Boolean(pipeline.get(String(step.input.jobId)));}catch{return false;}},
  admit:step=>{const job=pipeline.get(String(step.input.jobId));if(!['completed','failed','cancelled','paused','waiting_for_model'].includes(job.status)&&!(job.status==='waiting_for_input'&&job.errorCode==='memory_context_required'))return new ExecutionFailure('waiting','memory_processing',1000);},
  execute:async step=>{const job=pipeline.get(String(step.input.jobId));if(job.status!=='completed')throw new ExecutionFailure(job.status==='waiting_for_model'||job.status==='paused'||job.status==='waiting_for_input'?'blocked':job.status==='cancelled'?'permanent':'stale',job.errorCode??'memory_'+job.status);return {value:{jobId:job.id,memoryIds:job.memoryIds},summary:'Independently reviewed Memory package',coverage:job.batches.filter(batch=>!batch.supersededBy).flatMap(batch=>batch.coverage??[])};},
  commit:(step,product)=>runtime.recordExternalArtifact(String(step.input.workId),String(step.input.unitId),product as Parameters<DelegationRuntime['recordExternalArtifact']>[2]),
 });
 const feedback=registerMemoryFeedbackPlanner({runtime,pipeline,query:options.query});
 const plan=async(candidates:MemoryWorkCandidate[]):Promise<MemoryWorkProposal[]>=>{
  if(!candidates.every(candidate=>allowCandidate(candidate)))throw new StoreError('Memory catalog authorization changed before planning',409);
  const configuration=options.configuration?.(),id='memory-plan:'+sha256(JSON.stringify([candidates.map(candidate=>candidate.key),configuration?.fingerprint])),at=candidates.map(candidate=>candidate.contextTime).sort().at(-1);
  const evidenceIds=pipeline.evidenceDependencies(candidates.flatMap(candidate=>work.planningEvidence(candidate.materialId,candidate.scope)));
  runtime.start({id,operationId:id,profileId:'memory.plan',goal:'Plan and process this authorized input catalog',input:{catalog:candidates,configuration,evidenceIds},scope:{contextTime:at},allowedCapabilities:['memory.package',...(options.sample?['memory.inspect']:[])]});
  const owner=await runtime.waitForPlan(id);
  if(['failed','blocked','cancelled','stale'].includes(owner.status))throw new StoreError('Memory planning requires attention',409);
  return accepted(owner).filter(unit=>unit.capabilityId==='memory.package').map(unit=>({id:unit.id,members:packageInput.parse(unit.input).members,goal:unit.goal,instruction:String(unit.input.instruction)}));
 };
 const onCreated=(proposal:MemoryWorkProposal,job:{id:string})=>{
  const marker=proposal.id?.lastIndexOf(':unit:');if(marker===undefined||marker<0)throw new StoreError('Memory proposal has no durable coordinator identity',409);
  const workId=proposal.id!.slice(0,marker),unitId=proposal.id!;
  const stepId='memory-package-status:'+job.id,unit=runtime.unit(unitId);
  if(unit.stepId===stepId&&runtime.engine.get(stepId))return;
  runtime.engine.enqueue('memory:'+job.id,'memory.package-status',{jobId:job.id,workId,unitId},{id:stepId});
  runtime.linkExternalUnit(workId,unitId,stepId);
 };
 const reconcile=()=>{
  for(const row of runtime.store.db.prepare("SELECT j.id, json_extract(j.json,'$.workPackage.id') unit_id FROM memory_jobs j JOIN delegation_units u ON u.id=json_extract(j.json,'$.workPackage.id') WHERE json_extract(u.json,'$.external')=1 AND (json_extract(u.json,'$.stepId') != ('memory-package-status:' || j.id) OR NOT EXISTS(SELECT 1 FROM execution_steps e WHERE e.id=('memory-package-status:' || j.id))) LIMIT 64").all()){const unit=runtime.unit(String(row.unit_id));if(unit.status==='cancelled'){pipeline.cancel(String(row.id));continue;}onCreated({id:unit.id,members:[],goal:unit.goal,instruction:String(unit.input.instruction)}, {id:String(row.id)});}
  for(const row of runtime.store.db.prepare("SELECT u.id,u.work_id FROM memory_jobs j JOIN delegation_units u ON u.id=json_extract(j.json,'$.workPackage.id') WHERE json_extract(u.json,'$.external')=1 AND json_extract(u.json,'$.status') IN ('failed','blocked','stale') AND json_extract(j.json,'$.status') IN ('queued','running','waiting_for_input','completed') LIMIT 64").all()){
   try{runtime.resumeExternalUnit(String(row.work_id),String(row.id));}catch(error){if(!(error instanceof StoreError&&error.statusCode===409))throw error;}
  }
  // Planning may have committed several groups before a process stopped after
  // claiming only a prefix. Hand the remaining persisted groups to the product
  // queue before constructing a new incremental catalog.
  for(const row of runtime.store.db.prepare("SELECT DISTINCT w.id FROM delegation_works w JOIN delegation_units u ON u.work_id=w.id WHERE json_extract(w.json,'$.profileId')='memory.plan' AND json_extract(w.json,'$.planningComplete')=1 AND json_extract(w.json,'$.status') IN ('waiting','running') AND json_extract(u.json,'$.external')=1 AND json_extract(u.json,'$.status')='waiting' AND json_extract(u.json,'$.stepId')=u.id AND NOT EXISTS(SELECT 1 FROM memory_jobs j WHERE json_extract(j.json,'$.workPackage.id')=u.id) LIMIT 64").all()){
   const owner=runtime.get(String(row.id)),saved=runtime.journal.payload<PlannerInput>(owner.id);
   const pending=accepted(owner).filter(unit=>unit.capabilityId==='memory.package'&&unit.status==='waiting'&&unit.stepId===unit.id&&!runtime.store.db.prepare("SELECT 1 FROM memory_jobs WHERE json_extract(json,'$.workPackage.id')=?").get(unit.id));
   if(saved.configuration&&options.configuration&&saved.configuration.fingerprint!==options.configuration().fingerprint){for(const unit of pending)runtime.cancelUnit(unit.id);continue;}
   const proposals=pending.flatMap(unit=>{const input=packageInput.safeParse(unit.input);return input.success?[{id:unit.id,members:input.data.members,goal:unit.goal,instruction:input.data.instruction}]:[];});
   const ready=proposals.filter(proposal=>{const candidates=proposal.members.map(key=>saved.catalog.find(candidate=>candidate.key===key));try{for(const candidate of candidates){if(!candidate)throw new StoreError('Memory catalog changed',409);work.planningInput(candidate);}}catch{runtime.cancelUnit(proposal.id!);return false;}return candidates.every(candidate=>sourcePipelines.memoryAllowed(candidate!.sourceId)&&allowCandidate(candidate!));});
   if(ready.length)work.acceptPackages(pipeline,saved.catalog,ready,()=>true,onCreated,proposal=>{if(proposal.id)runtime.cancelUnit(proposal.id);},allowCandidate);
  }
 };
 reconcile();sourcePipelines.setMemoryPlanner(plan,onCreated,proposal=>{if(proposal.id)runtime.cancelUnit(proposal.id);},reconcile,allowCandidate);
 return {plan,onCreated,reconcile,async close(){sourcePipelines.setMemoryPlanner(undefined);await feedback.close();await stop();}};
}
