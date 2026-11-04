import type {Store} from './store.js';
import type {MemoryPipeline,MemoryJob} from './memory-pipeline.js';
import type {MemoryLifecycle} from './memory-lifecycle.js';
import type {ExecutionEngine} from './execution-engine.js';
import type {MemoryPublication} from './plugins/memory-publication.js';
import type {MemoryAutomaticWorkCounts} from './memory-automation.js';

export interface MemoryControl {
 pendingTail():number;
 resume():void;
 /** Durable participant writes return local effects for the command's commit. */
 stop():()=>void;
 counts():MemoryAutomaticWorkCounts;
}
export interface MemoryControlDependencies {
 store:Pick<Store,'db'>;
 pipeline:Pick<MemoryPipeline,'get'|'cancel'>;
 lifecycle:Pick<MemoryLifecycle,'view'|'cancel'|'skipAutomaticBacklog'>;
 executor:Pick<ExecutionEngine,'isActiveStep'|'deferLocalEffects'>;
 publication:Pick<MemoryPublication,'pending'>;
 now?:()=>number;
}
/** Memory owns its control projections and stop participants. MemoryAutomation
 * remains the command/transaction owner; ExecutionEngine owns local aborts. */
export function createMemoryControl({store,pipeline,lifecycle,executor,publication,now=Date.now}:MemoryControlDependencies):MemoryControl {
 const {db}=store;
 const cancelledWork=(automaticOnly=false)=>{
  let active=0;
  const automaticParents=new Set(lifecycle.view().extensions.filter(extension=>['extraction','consolidation'].includes(extension.id)&&extension.active&&!extension.active.manual).map(extension=>'lifecycle:'+extension.active!.id));
  for(const row of db.prepare("SELECT b.id,j.json FROM memory_batches b JOIN memory_jobs j ON j.id=b.job_id WHERE json_extract(j.json,'$.status')='cancelled'").all()){
   const job=JSON.parse(String(row.json)) as MemoryJob;
   if(executor.isActiveStep(String(row.id))&&(!automaticOnly||job.automaticGrant||job.automaticGrants?.length||automaticParents.has(job.importJobId!)))active++;
  }
  for(const extension of lifecycle.view().extensions)if(['extraction','consolidation'].includes(extension.id)&&extension.active&&extension.status==='cancelled'&&(!automaticOnly||!extension.active.manual)&&executor.isActiveStep('lifecycle:'+extension.active.id))active++;
  return active;
 };
 return {
  pendingTail:()=>{
   const jobs=Number(db.prepare("SELECT count(*) n FROM memory_jobs WHERE json_extract(json,'$.status') NOT IN ('completed','cancelled')").get()!.n);
   const windows=lifecycle.view().extensions.filter(extension=>['extraction','consolidation'].includes(extension.id)&&extension.active&&extension.status!=='cancelled').length;
   return jobs+windows+publication.pending()+cancelledWork();
  },
  resume:()=>{lifecycle.skipAutomaticBacklog();},
  stop:()=>executor.deferLocalEffects(()=>{
   db.prepare('UPDATE memory_input_authorizations SET revoked_at=? WHERE authorized=1 AND revoked_at IS NULL').run(now());
   for(const row of db.prepare("SELECT id FROM memory_jobs WHERE (json_extract(json,'$.automaticGrant') IS NOT NULL OR json_array_length(json_extract(json,'$.automaticGrants'))>0) AND json_extract(json,'$.status') NOT IN ('completed','cancelled')").all())pipeline.cancel(String(row.id),{cause:'authority'});
   for(const extension of lifecycle.view().extensions)if(['extraction','consolidation'].includes(extension.id)&&extension.active&&!extension.active.manual)lifecycle.cancel(extension.id,extension.active.id,{cause:'authority'});
  }),
  counts:()=>{
   const counts:MemoryAutomaticWorkCounts={queued:0,running:0,checkpointed:0,resultUnknown:0},jobs=new Set<string>();
   for(const row of db.prepare('SELECT job_id FROM memory_input_authorizations WHERE authorized=1 AND revoked_at IS NULL').all()){
    if(!row.job_id){counts.queued++;continue;}jobs.add(String(row.job_id));
   }
   for(const id of jobs){const job=pipeline.get(id);if(['completed','cancelled'].includes(job.status))continue;
    if(job.status==='running')counts.running++;else if(job.batches.some(batch=>batch.status==='completed'))counts.checkpointed++;else counts.queued++;
   }
   for(const extension of lifecycle.view().extensions)if(['extraction','consolidation'].includes(extension.id)&&extension.active&&!extension.active.manual&&extension.status!=='cancelled'){
    if(extension.status==='running')counts.running++;else if(extension.active.checkpoint)counts.checkpointed++;else counts.queued++;
   }
   counts.running+=cancelledWork(true);counts.resultUnknown=publication.pending(true);return counts;
  },
 };
}
