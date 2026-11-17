import {StoreError,type EvidenceStore as Store} from './evidence-store.js';
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
 pipeline:Pick<MemoryPipeline,'cancel'>;
 lifecycle:Pick<MemoryLifecycle,'view'|'cancel'|'resumeAutomaticBacklog'|'revokeAutomaticRounds'>;
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
   const windows=lifecycle.view().extensions.filter(extension=>['extraction','consolidation'].includes(extension.id)&&(extension.active||(extension.drainThrough??0)>extension.cursor)&&extension.status!=='cancelled').length;
   return jobs+windows+publication.pending()+cancelledWork();
  },
  resume:()=>{lifecycle.resumeAutomaticBacklog();},
  stop:()=>executor.deferLocalEffects(()=>{
   db.prepare('UPDATE memory_input_authorizations SET revoked_at=? WHERE authorized=1 AND revoked_at IS NULL').run(now());
   lifecycle.revokeAutomaticRounds();
   for(const row of db.prepare("SELECT id FROM memory_jobs WHERE (json_extract(json,'$.automaticGrant') IS NOT NULL OR json_array_length(json_extract(json,'$.automaticGrants'))>0) AND json_extract(json,'$.status') NOT IN ('completed','cancelled')").all())pipeline.cancel(String(row.id),{cause:'authority'});
   for(const extension of lifecycle.view().extensions)if(['extraction','consolidation'].includes(extension.id)&&extension.active&&!extension.active.manual)lifecycle.cancel(extension.id,extension.active.id,{cause:'authority'});
  }),
  counts:()=>{
   const authorizations=db.prepare("SELECT count(*) total,count(nullif(job_id,'')) claimed FROM memory_input_authorizations WHERE authorized=1 AND revoked_at IS NULL").get()!;
   const counts:MemoryAutomaticWorkCounts={queued:Number(authorizations.total)-Number(authorizations.claimed),running:0,checkpointed:0,resultUnknown:0};
   // This projection is also read while admitting model work during startup.
   // Full job details decrypt every batch and compute each queue position by
   // scanning all jobs. The transaction-maintained counters retain the same
   // effective status without opening private bodies or rebuilding that queue.
   const jobs=Number(authorizations.claimed)===0?[]:db.prepare(`SELECT j.id,c.completed,
     CASE WHEN json_extract(j.json,'$.status')='completed' AND c.failed+c.invalidated>0 THEN 'failed'
       WHEN json_extract(j.json,'$.status')='queued' AND c.running>0 THEN 'running'
       ELSE json_extract(j.json,'$.status') END status
     FROM (SELECT DISTINCT job_id FROM memory_input_authorizations WHERE authorized=1 AND revoked_at IS NULL AND job_id IS NOT NULL AND job_id!='') a
     LEFT JOIN memory_jobs j ON j.id=a.job_id LEFT JOIN memory_job_counts c ON c.job_id=j.id`).all();
   for(const job of jobs){
    if(!job.id)throw new StoreError('Memory job not found',404);
    if(['completed','cancelled'].includes(String(job.status)))continue;
    if(job.status==='running')counts.running++;else if(Number(job.completed)>0)counts.checkpointed++;else counts.queued++;
   }
   for(const extension of lifecycle.view().extensions)if(['extraction','consolidation'].includes(extension.id)){
    const admitted=(extension.drainThrough??0)>extension.cursor;
    if(extension.active?.manual){if(admitted)counts.queued++;continue;}
    if(extension.status==='cancelled'||!extension.active&&!admitted)continue;
    if(extension.status==='running')counts.running++;else if(extension.active?.checkpoint)counts.checkpointed++;else counts.queued++;
   }
   counts.running+=cancelledWork(true);counts.resultUnknown=publication.pending(true);return counts;
  },
 };
}
