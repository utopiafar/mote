import {randomUUID} from 'node:crypto';
import {InsightRuns} from './insight-runs.js';
import {linkOperationParent} from './operation-projection.js';
import { moteText } from './i18n.js';
import type {QueryInput} from '@mote/agent';
import {ProviderFailure,type QueryResult} from '@mote/shared';
import {MemoryLifecycle} from './memory-lifecycle.js';
import {ExecutionFailure} from './execution-engine.js';
import {MemoryPipeline} from './memory-pipeline.js';
import {MemoryStore} from './memory.js';
import {FileStore} from './files.js';
import {Store,StoreError} from './store.js';
import {WorkingMemory} from './working-memory.js';
import {insightResult} from './insights.js';
import {registerMemoryIntegration} from './memory-integration.js';
import {MemoryIntegrationSettings} from './memory-integration-settings.js';

export function registerMemoryExtensions({integrationSettings,lifecycle,store,files,memories,pipeline,working,query,model,semanticArtifacts,providerCooldownCheck,insights,insightTimeout}:{
  integrationSettings?:MemoryIntegrationSettings;
  semanticArtifacts?:(ids:string[],operationId?:string,mode?:'lifecycle')=>Promise<string[]>;
  providerCooldownCheck?:()=>void;
  insights?:InsightRuns;insightTimeout?:()=>number|null;
  lifecycle:MemoryLifecycle;store:Store;files:FileStore;memories:MemoryStore;pipeline:MemoryPipeline;working:WorkingMemory;
  query:(input:QueryInput,module:'memories'|'insights'|'conversations')=>Promise<QueryResult>;model:()=>string;
}){
  lifecycle.register({id:'extraction',version:'3.3.0',stream:'artifact',maxAttempts:3,async run(window,checkpoint,execution){
    let job=window.checkpoint?pipeline.get(window.checkpoint):undefined;
    if(!job){
      if(!semanticArtifacts)return;
      const artifactIds=await semanticArtifacts(pipeline.intakeArtifactIds(window.ids),execution?.operationId,'lifecycle');
      const admit=()=>{const created=pipeline.createFromArtifacts(artifactIds,'lifecycle:'+window.id,window.settings.batchCharacters);if(created){if(execution)linkOperationParent(store,execution.operationId,'memory:'+created.id);checkpoint(created.id);}return created;};
      job=execution?execution.commit(admit):admit();if(!job)return;
    }
    // A provider cooldown is admission, not another extraction attempt.
    if(job.status==='failed'&&job.availableAt&&job.availableAt>Date.now())throw new ExecutionFailure('waiting',job.errorCode??'provider_cooldown',job.availableAt-Date.now());
    if(job.status!=='completed'&&providerCooldownCheck)try{providerCooldownCheck();}catch(error){if(error instanceof ProviderFailure)throw new ExecutionFailure('waiting',error.details.code,error.details.retryAfterMs);throw error;}
    const abort=()=>{if(!execution?.interrupted())pipeline.cancel(job!.id);};execution?.signal.addEventListener('abort',abort,{once:true});let result;try{execution?.signal.throwIfAborted();result=await (job.status==='failed'?pipeline.retry(job.id):pipeline.run(job.id));}finally{execution?.signal.removeEventListener('abort',abort);}
    if(result.status==='waiting_for_model'||result.status==='waiting_for_input'||result.status==='paused'||result.status==='pausing')throw new ExecutionFailure('waiting',result.errorCode??'extraction_input_pending',result.availableAt?Math.max(0,result.availableAt-Date.now()):undefined);
    // Deleted/superseded inputs are intentionally retired; their new revisions
    // are later journal entries. Other failures retain this window for retry.
    if(result.batches.some(b=>b.status!=='completed'&&b.status!=='invalidated')){
      if(result.availableAt)throw new ProviderFailure({category:'transient',code:result.errorCode??'provider_unavailable',retryAfterMs:Math.max(0,result.availableAt-Date.now())});
      throw new StoreError('Scheduled extraction is incomplete',503);
    }
  }});
  registerMemoryIntegration({lifecycle,memories,pipeline,settings:integrationSettings??new MemoryIntegrationSettings(store,pipeline.strategies),query:input=>query(input,'memories')});
  lifecycle.register({id:'working',version:'1.0.0',stream:'conversation',async run(window,_checkpoint,execution){
    for(const id of window.ids)await working.compact(id,window.settings,input=>query({...input,...(execution?{signal:execution.signal,traceContext:{operationId:execution.operationId,jobId:execution.jobId}}:{})},'conversations'),undefined,execution);
  }});
  lifecycle.register({id:'insights',version:'2.0.0',stream:'artifact',async run(window,checkpoint,execution){
    if(store.db.prepare('SELECT id FROM insights WHERE id=?').get(window.id))return;
    const current=window.ids.filter(id=>store.archive.get(id)?.kind==='semantic');
    if(!current.length)return;
    const coverage=store.db.prepare("SELECT sum(json_extract(json,'$.status') IN ('pending','running')) pendingBatches,sum(json_extract(json,'$.status')='failed') failedBatches FROM memory_batches").get() as {pendingBatches:number;failedBatches:number};
    const lastSavedAt=(store.db.prepare('SELECT max(created_at) at FROM memories').get() as {at:string|null}).at;
    const runs=insights??new InsightRuns(store,{executor:pipeline.engine});
    if(window.checkpoint?.startsWith('insight:')){try{const prior=runs.get(window.checkpoint.slice(8));if(prior.status==='completed'){if(!insights)await runs.close();return;}if(prior.status==='running')throw new ProviderFailure({category:'transient',code:'insight_running',retryAfterMs:1000});}catch(error){if(!(error instanceof StoreError&&error.statusCode===404))throw error;}}
    const id=randomUUID(),prompt=moteText("先检索 memories 的精选记忆概览，再按需展开相关记忆、observation 和 segments。Memory 未命中不代表原始事件不存在；参考整理覆盖信息，用 changes 的 overview 或全文检索发现尚未整理的增量。只对有意义的发现选择性读取原始证据，核实最终报告的事实、数字、归属和时间。不要穷尽读取本窗口全部原文；预算不足时用已有证据生成范围明确的部分报告，说明未覆盖内容。注意迟到上传、修订、人物归属、偏好变化及计划的未知结果。没有支持时明确说明信息不足。不要声称完整回顾了全部历史。按照宿主固定范围检索，允许范围内跨月检索。");
    execution?.signal.throwIfAborted();checkpoint('insight:'+id);if(execution)execution.commit(()=>linkOperationParent(store,execution.operationId,'insight:'+id));
    const abort=()=>{try{runs.cancel(id);}catch(error){if(!(error instanceof StoreError&&error.statusCode===404))throw error;}};execution?.signal.addEventListener('abort',abort,{once:true});
    try{await runs.perform(id,{prompt,timeZone:'UTC'},async(observe,signal,snapshot)=>{
      const result=insightResult(await query({...snapshot.scope,contextTime:snapshot.asOf,insightSnapshot:snapshot,signal,traceContext:{operationId:'insight:'+id,jobId:window.id},onProgress:observe,memoryCoverage:{scope:'archive',pendingBatches:coverage.pendingBatches??0,failedBatches:coverage.failedBatches??0,lastSavedAt},skill:'personal-insight',responseMode:'personal-insight',question:'Completed semantic artifact IDs (expand selectively using segments): '+JSON.stringify(current.slice(0,30))+'\n'+prompt},'insights'));
      signal.throwIfAborted();execution?.signal.throwIfAborted();return {...result,snapshot};
    },{timeoutMs:insightTimeout?.(),beforeCommit:execution?()=>execution.commit(()=>{}):undefined});}finally{execution?.signal.removeEventListener('abort',abort);if(!insights)await runs.close();}

  }});
}

/** Active windows own their retry schedule; only detached queued jobs need recovery. */
export function recoverableMemoryJobs(store:Store,lifecycle:MemoryLifecycle):string[]{
  const state=lifecycle.view(),active=state.extensions.find(e=>e.id==='extraction')?.active?.checkpoint;
  return (store.db.prepare("SELECT id,json FROM memory_jobs WHERE json_extract(json,'$.status') IN ('queued','running') OR (json_extract(json,'$.inputPlanVersion')=1 AND json_extract(json,'$.status')='waiting_for_input')").all() as {id:string;json:string}[]).filter(row=>{
    const job=JSON.parse(row.json) as {importJobId?:string;originKey?:string};
    // Material work is resumed only by its durable, currently authorized queue.
    if(job.originKey?.startsWith('material:'))return false;
    return !job.importJobId?.startsWith('lifecycle:')||(state.settings.extraction.enabled&&row.id!==active);
  }).map(row=>row.id);
}
