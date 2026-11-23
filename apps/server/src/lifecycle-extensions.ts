import {modelPrompt} from './model-prompt.js';
import {randomUUID} from 'node:crypto';
import {InsightRuns} from './insight-runs.js';
import {linkOperationParent} from './operation-projection.js';
import type {QueryInput} from '@mote/agent';
import {ProviderFailure,type QueryResult} from '@mote/shared';
import {MemoryLifecycle} from './memory-lifecycle.js';
import {ExecutionFailure} from './execution-engine.js';
import {MemoryPipeline} from './memory-pipeline.js';
import {MemoryStore} from './memory.js';
import {FileStore} from './files.js';
import {EvidenceStore as Store,StoreError} from './evidence-store.js';
import {WorkingMemory} from './working-memory.js';
import {insightResult} from './insights.js';
import {registerMemoryIntegration} from './memory-integration.js';
import {MemoryIntegrationSettings} from './memory-integration-settings.js';

export function registerMemoryExtensions({integrationSettings,lifecycle,store,files,memories,pipeline,working,query,model,semanticArtifacts,providerCooldownCheck,insights}:{
  integrationSettings?:MemoryIntegrationSettings;
  semanticArtifacts?:(ids:string[],operationId?:string,mode?:'lifecycle')=>Promise<string[]>;
  providerCooldownCheck?:()=>void;
  insights?:InsightRuns|false;insightTimeout?:()=>number|null;
  lifecycle:MemoryLifecycle;store:Store;files:FileStore;memories:MemoryStore;pipeline:MemoryPipeline;working:WorkingMemory;
  query:(input:QueryInput,module:'memories'|'insights'|'conversations')=>Promise<QueryResult>;model:()=>string;
}){
  lifecycle.register({id:'extraction',version:'3.3.0',stream:'artifact',maxAttempts:3,cancel(window,cause){
    if(!window.checkpoint)return;
    let child;try{child=pipeline.get(window.checkpoint);}catch(error){if(error instanceof StoreError&&error.statusCode===404)return;throw error;}
    // The checkpoint and exact persisted backlink are host identities. A raw
    // import label or similar source text never identifies an automatic child.
    if(child.importJobId!=='lifecycle:'+window.id)return;
    pipeline.cancel(child.id,cause==='authority'?{cause:'authority'}:undefined);
  },async run(window,checkpoint,execution){
    let job=window.checkpoint?pipeline.get(window.checkpoint):undefined;
    if(!job){
      if(!semanticArtifacts)return;
      const artifactIds=await semanticArtifacts(pipeline.intakeArtifactIds(window.ids),execution?.operationId,'lifecycle');
      const admit=()=>{const created=pipeline.createFromArtifacts(artifactIds,'lifecycle:'+window.id,window.settings.batchCharacters);if(created){if(execution)linkOperationParent(store,execution.operationId,'memory:'+created.id);checkpoint(created.id);}return created;};
      job=execution?execution.commit(admit):admit();if(!job)return;
    }
    // A saved terminal child is an observation, never authorization to reopen
    // its complete attempt budget. Only the owner's retry entry point does that.
    if(job.status==='failed')throw new ExecutionFailure('permanent',job.errorCode??'memory_extraction_failed');
    if(job.status!=='completed'&&providerCooldownCheck)try{providerCooldownCheck();}catch(error){if(error instanceof ProviderFailure)throw new ExecutionFailure('waiting',error.details.code,error.details.retryAfterMs);throw error;}
    const abort=()=>{if(!execution?.interrupted()&&pipeline.get(job!.id).status!=='cancelled')pipeline.cancel(job!.id);};execution?.signal.addEventListener('abort',abort,{once:true});let result;try{execution?.signal.throwIfAborted();result=await pipeline.run(job.id);}finally{execution?.signal.removeEventListener('abort',abort);}
    if(result.status==='waiting_for_model'||result.status==='waiting_for_input'||result.status==='paused'||result.status==='pausing')throw new ExecutionFailure('waiting',result.errorCode??'extraction_input_pending',result.availableAt?Math.max(0,result.availableAt-Date.now()):undefined);
    // Deleted/superseded inputs are intentionally retired; their new revisions
    // are later journal entries. Other failures retain this window for retry.
    if(result.batches.some(b=>b.status!=='completed'&&b.status!=='invalidated')){
      if(result.availableAt)throw new ExecutionFailure('waiting',result.errorCode??'provider_unavailable',Math.max(0,result.availableAt-Date.now()));
      throw new StoreError('Scheduled extraction is incomplete',503);
    }
  }});
  registerMemoryIntegration({lifecycle,memories,pipeline,settings:integrationSettings??new MemoryIntegrationSettings(store,pipeline.strategies),query:input=>query(input,'memories')});
  lifecycle.register({id:'working',version:'1.0.0',stream:'conversation',async run(window,_checkpoint,execution){
    for(const id of window.ids)await working.compact(id,window.settings,input=>query({...input,...(execution?{signal:execution.signal,traceContext:{operationId:execution.operationId,jobId:execution.jobId}}:{})},'conversations'),undefined,execution);
  }});
  if(insights!==false)lifecycle.register({id:'insights',version:'2.0.0',stream:'artifact',async run(window,checkpoint,execution){
    if(store.db.prepare('SELECT id FROM insights WHERE id=?').get(window.id))return;
    const current=window.ids.filter(id=>store.archive.get(id)?.kind==='semantic');
    if(!current.length)return;
    const coverage=store.db.prepare("SELECT sum(json_extract(json,'$.status') IN ('pending','running')) pendingBatches,sum(json_extract(json,'$.status')='failed') failedBatches FROM memory_batches").get() as {pendingBatches:number;failedBatches:number};
    const lastSavedAt=(store.db.prepare('SELECT max(created_at) at FROM memories').get() as {at:string|null}).at;
    const runs=insights??new InsightRuns(store,{executor:pipeline.engine});
    try{
    if(window.checkpoint?.startsWith('insight:')){try{
      const prior=runs.get(window.checkpoint.slice(8));if(prior.status==='completed')return;if(prior.status==='running')throw new ExecutionFailure('waiting','insight_running',1000);
      // Only the window's finite typed recovery decision can replace its own
      // failed observation. Keep that receipt terminal; startup/parent replay,
      // cancellation and unclassified outcomes cannot authorize a new call.
      const childId='insight:'+prior.id,replayable=prior.status==='failed'&&execution?.recovery==='transient'&&pipeline.engine.failure(childId)?.category==='transient'&&store.db.prepare('SELECT 1 FROM operation_parents WHERE parent_id=? AND child_id=?').get(execution.operationId,childId);
      if(!replayable)throw new ExecutionFailure('permanent',prior.error?.code??(prior.status==='cancelled'?'insight_cancelled':'insight_failed'));
    }catch(error){if(!(error instanceof StoreError&&error.statusCode===404))throw error;}}
    const id=randomUUID(),prompt=modelPrompt('scheduledInsight');
    execution?.signal.throwIfAborted();checkpoint('insight:'+id);if(execution)execution.commit(()=>linkOperationParent(store,execution.operationId,'insight:'+id));
    const abort=()=>{try{runs.cancel(id);}catch(error){if(!(error instanceof StoreError&&error.statusCode===404))throw error;}};execution?.signal.addEventListener('abort',abort,{once:true});
    try{await runs.perform(id,{prompt,timeZone:'UTC'},async(observe,signal,snapshot)=>{
      const result=insightResult(await query({...snapshot.scope,contextTime:snapshot.asOf,insightSnapshot:snapshot,signal,traceContext:{operationId:'insight:'+id,jobId:window.id},onProgress:observe,memoryCoverage:{scope:'archive',pendingBatches:coverage.pendingBatches??0,failedBatches:coverage.failedBatches??0,lastSavedAt},skill:'personal-insight',responseMode:'personal-insight',question:'Completed semantic artifact IDs (expand selectively using segments): '+JSON.stringify(current.slice(0,30))+'\n'+prompt},'insights'));
      signal.throwIfAborted();execution?.signal.throwIfAborted();return {...result,snapshot};
    },{beforeCommit:execution?()=>execution.commit(()=>{}):undefined});}finally{execution?.signal.removeEventListener('abort',abort);}
    }finally{if(!insights)await runs.stop();}

  }});
}

/** Active windows own their retry schedule. Creation alone never activates a
 * manual task; only an explicitly started detached job may recover on startup. */
export function recoverableMemoryJobs(store:Store,_lifecycle:MemoryLifecycle):string[]{
  // Material work and lifecycle windows retain recovery authority over their
  // children. Poll only the scheduling metadata, without opening job bodies.
  return (store.db.prepare(`SELECT id FROM memory_jobs
    WHERE json_extract(json,'$.activationRequired')=0
      AND json_extract(json,'$.status') IN ('queued','running','waiting_for_input')
      AND (json_extract(json,'$.status')!='waiting_for_input' OR json_extract(json,'$.inputPlanVersion')=1)
      AND coalesce(json_extract(json,'$.originKey'),'') NOT GLOB 'material:*'
      AND coalesce(json_extract(json,'$.importJobId'),'') NOT GLOB 'lifecycle:*'
    ORDER BY rowid`).all() as {id:string}[]).map(row=>row.id);
}
