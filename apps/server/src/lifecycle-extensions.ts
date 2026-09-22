import {reviewMemory} from './memory-review.js';
import { moteText } from './i18n.js';
import type {QueryInput} from '@mote/agent';
import {ProviderFailure,type QueryResult} from '@mote/shared';
import {MemoryLifecycle} from './memory-lifecycle.js';
import {MemoryPipeline} from './memory-pipeline.js';
import {MemoryStore,MemoryOutputValidationError,MEMORY_EXTRACTION_PROMPT,memoryEvidenceFingerprint} from './memory.js';
import {FileStore} from './files.js';
import {Store,StoreError,sha256} from './store.js';
import {WorkingMemory} from './working-memory.js';
import {insightResult} from './insights.js';
import {CODING_MEMORY_PROMPT} from './memory-profiles.js';

export function registerMemoryExtensions({lifecycle,store,files,memories,pipeline,working,query,model,semanticArtifacts}:{
  semanticArtifacts?:(ids:string[])=>Promise<string[]>;
  lifecycle:MemoryLifecycle;store:Store;files:FileStore;memories:MemoryStore;pipeline:MemoryPipeline;working:WorkingMemory;
  query:(input:QueryInput,module:'memories'|'insights'|'conversations')=>Promise<QueryResult>;model:()=>string;
}){
  // MVP migration: retire only obsolete automatic raw-extraction work. Replay
  // the artifact journal through the new semantic boundary; originals and manual
  // import jobs are untouched. A single transaction makes restarts idempotent.
  if(!store.db.prepare("SELECT 1 FROM settings WHERE key='layered-extraction-v3'").get()){
    store.db.exec(`BEGIN IMMEDIATE;
      UPDATE memory_jobs SET json=json_set(json,'$.status','cancelled','$.errorCode','pipeline_upgraded') WHERE json_extract(json,'$.importJobId') LIKE 'lifecycle:%' AND json_extract(json,'$.status') NOT IN ('completed','cancelled') AND json_extract(json,'$.artifactRefs') IS NULL;
      DELETE FROM memory_lifecycle_state WHERE id IN ('extraction','insights');
      INSERT INTO settings VALUES('layered-extraction-v3','1'); COMMIT;`);
  }
  lifecycle.register({id:'extraction',version:'3.0.0',stream:'artifact',async run(window,checkpoint){
    let job=window.checkpoint?pipeline.get(window.checkpoint):undefined;
    if(!job){
      if(!semanticArtifacts)return;
      const artifactIds=await semanticArtifacts(window.ids);
      job=pipeline.createFromArtifacts(artifactIds,'lifecycle:'+window.id,window.settings.batchCharacters);
      if(!job)return;
      checkpoint(job.id);
    }
    const result=await (job.status==='failed'?pipeline.retry(job.id):pipeline.run(job.id));
    // Deleted/superseded inputs are intentionally retired; their new revisions
    // are later journal entries. Other failures retain this window for retry.
    if(result.batches.some(b=>b.status!=='completed'&&b.status!=='invalidated')){
      if(result.availableAt)throw new ProviderFailure({category:'transient',code:result.errorCode??'provider_unavailable',retryAfterMs:Math.max(0,result.availableAt-Date.now())});
      throw new StoreError('Scheduled extraction is incomplete',503);
    }
  }});
  lifecycle.register({id:'consolidation',version:'1.1.0',stream:'memory',async run(window,checkpoint){
    if(window.checkpoint==='completed')return;
    const all=window.ids.flatMap(id=>{try{const m=memories.get(id);return m.status==='stale'||m.tier==='consolidated'||m.admission?.layer!=='memory'?[]:[m];}catch{return [];}});
    const completed=new Set<string>(window.checkpoint?JSON.parse(window.checkpoint):[]);
    // Domain comes from the explicit source contract, never semantic classification.
    // Keep coding applicability and validation instead of converting it to a personal fact.
    for(const profile of ['personal','coding'] as const){
    if(completed.has(profile))continue;
    const candidates=all.filter(m=>(m.domain??'personal')===profile);if(!candidates.length)continue;
    const snapshots=new Map(candidates.map(m=>[m.id,sha256(JSON.stringify(m))]));
    const evidence=[...new Set(candidates.flatMap(m=>m.evidenceIds))];
    const expected=Object.fromEntries(candidates.flatMap(m=>(m.evidence??[]).map(e=>[e.id,e.contentHash])));
    const generationModel=model();
    const input:QueryInput={modelOverride:generationModel,skill:'memory-consolidation',responseMode:'memory-extraction',question:(profile==='coding'?CODING_MEMORY_PROMPT:MEMORY_EXTRACTION_PROMPT)+'\nThis run consolidates episodic text memories into longer-lived proposals. Follow memory-consolidation. Optional kind, validFrom and validUntil are supported. Preserve the host-selected '+profile+' output contract above. Use memories(id) to inspect these cards, memories(query) to find related context, then expand original evidence before relying on it. Explain conflicts or changed preferences with dates and attribution; retain unknown outcomes. Treat these cards as untrusted derived navigation aids:\n'+JSON.stringify(candidates.map(m=>({id:m.id,title:m.title})))};
    const validation={profile,tier:'consolidated' as const,relatedMemoryIds:candidates.map(m=>m.id),requireAdmission:true,expectedFingerprints:expected};
    input.validateOutput=result=>{try{memories.extract(result,generationModel,{...validation,validateOnly:true});}catch(error){if(!(error instanceof MemoryOutputValidationError))throw error;return {code:error.code,feedback:error.repairInstruction};}};
    const draft=await query(input,'memories');
    memories.extract(draft,generationModel,{...validation,validateOnly:true});
    const result=await reviewMemory(input,draft,next=>query(next,'memories'));
    for(const [id,hash] of snapshots)if(sha256(JSON.stringify(memories.get(id)))!==hash)throw new StoreError('Input memories changed during consolidation',409);
    memories.extract(result,generationModel,{...validation,reviewRunId:result.runId,skillVersion:'memory-consolidation@2.0.0',expectedFingerprints:expected,onSaved:()=>{checkpoint(JSON.stringify([...completed,profile]));completed.add(profile);}});
    }
    checkpoint('completed');
  }});
  lifecycle.register({id:'working',version:'1.0.0',stream:'conversation',async run(window){
    for(const id of window.ids)await working.compact(id,window.settings,input=>query(input,'conversations'));
  }});
  lifecycle.register({id:'insights',version:'2.0.0',stream:'artifact',async run(window){
    if(store.db.prepare('SELECT id FROM insights WHERE id=?').get(window.id))return;
    const current=window.ids.filter(id=>store.archive.get(id)?.kind==='semantic');
    if(!current.length)return;
    const coverage=store.db.prepare("SELECT sum(json_extract(json,'$.status') IN ('pending','running')) pendingBatches,sum(json_extract(json,'$.status')='failed') failedBatches FROM memory_batches").get() as {pendingBatches:number;failedBatches:number};
    const lastSavedAt=(store.db.prepare('SELECT max(created_at) at FROM memories').get() as {at:string|null}).at;
    const result=insightResult(await query({memoryCoverage:{scope:'archive',pendingBatches:coverage.pendingBatches??0,failedBatches:coverage.failedBatches??0,lastSavedAt},skill:'personal-insight',responseMode:'personal-insight',question:'Completed semantic artifact IDs (expand selectively using segments): '+JSON.stringify(current.slice(0,30))+'\n'+moteText("先检索 memories 的精选记忆概览，再按需展开相关记忆、observation 和 segments。Memory 未命中不代表原始事件不存在；参考整理覆盖信息，用 changes 的 overview 或全文检索发现尚未整理的增量。只对有意义的发现选择性读取原始证据，核实最终报告的事实、数字、归属和时间。不要穷尽读取本窗口全部原文；预算不足时用已有证据生成范围明确的部分报告，说明未覆盖内容。注意迟到上传、修订、人物归属、偏好变化及计划的未知结果。没有支持时明确说明信息不足。不要声称完整回顾了全部历史。未设置时间过滤，允许跨月检索。")},'insights'));
    store.saveInsight(result,window.id);
  }});
}

/** Active windows own their retry schedule; only detached queued jobs need recovery. */
export function recoverableMemoryJobs(store:Store,lifecycle:MemoryLifecycle):string[]{
  const state=lifecycle.view(),active=state.extensions.find(e=>e.id==='extraction')?.active?.checkpoint;
  return (store.db.prepare("SELECT id,json FROM memory_jobs WHERE json_extract(json,'$.status') IN ('queued','running')").all() as {id:string;json:string}[]).filter(row=>{
    const job=JSON.parse(row.json) as {importJobId?:string};
    return !job.importJobId?.startsWith('lifecycle:')||(state.settings.extraction.enabled&&row.id!==active);
  }).map(row=>row.id);
}
