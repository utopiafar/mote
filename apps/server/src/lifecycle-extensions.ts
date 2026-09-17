import { moteText } from './i18n.js';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {MemoryLifecycle} from './memory-lifecycle.js';
import {MemoryPipeline} from './memory-pipeline.js';
import {MemoryStore,MEMORY_EXTRACTION_PROMPT,memoryEvidenceFingerprint} from './memory.js';
import {FileStore} from './files.js';
import {Store,StoreError,sha256} from './store.js';
import {WorkingMemory} from './working-memory.js';
import {insightResult} from './insights.js';
import {CODING_MEMORY_PROMPT} from './memory-profiles.js';

export function registerMemoryExtensions({lifecycle,store,files,memories,pipeline,working,query,model}:{
  lifecycle:MemoryLifecycle;store:Store;files:FileStore;memories:MemoryStore;pipeline:MemoryPipeline;working:WorkingMemory;
  query:(input:QueryInput,module:'memories'|'insights'|'conversations')=>Promise<QueryResult>;model:()=>string;
}){
  lifecycle.register({id:'extraction',version:'1.0.0',stream:'evidence',async run(window,checkpoint){
    let job=window.checkpoint?pipeline.get(window.checkpoint):undefined;
    if(!job){
      const ids=new Set<string>();
      for(const id of window.ids){
        if(store.db.prepare('SELECT 1 FROM file_heads WHERE capture_id=?').get(id)){
          for(let offset=0;;offset+=200){const chunks=files.chunks(id,offset,200);for(const chunk of chunks)if(memories.isCurrentEvidence(chunk.id))ids.add(chunk.id);if(ids.size>20000)throw new StoreError('Scheduled file batch exceeds evidence budget',413);if(chunks.length<200)break;}
        }else if(memories.isCurrentEvidence(id))ids.add(id);
      }
      if(!ids.size)return;
      job=pipeline.create({evidenceIds:[...ids],importJobId:'lifecycle:'+window.id,batchCharacters:window.settings.batchCharacters});checkpoint(job.id);
    }
    const result=await (job.status==='failed'?pipeline.retry(job.id):pipeline.run(job.id));
    // Deleted/superseded inputs are intentionally retired; their new revisions
    // are later journal entries. Other failures retain this window for retry.
    if(result.batches.some(b=>b.status!=='completed'&&b.status!=='invalidated'))throw new StoreError('Scheduled extraction is incomplete',503);
  }});
  lifecycle.register({id:'consolidation',version:'1.1.0',stream:'memory',async run(window,checkpoint){
    if(window.checkpoint==='completed')return;
    const all=window.ids.flatMap(id=>{try{const m=memories.get(id);return m.status==='stale'||m.tier==='consolidated'?[]:[m];}catch{return [];}});
    const completed=new Set<string>(window.checkpoint?JSON.parse(window.checkpoint):[]);
    // Domain comes from the explicit source contract, never semantic classification.
    // Keep coding applicability and validation instead of converting it to a personal fact.
    for(const profile of ['personal','coding'] as const){
    if(completed.has(profile))continue;
    const candidates=all.filter(m=>(m.domain??'personal')===profile);if(!candidates.length)continue;
    const snapshots=new Map(candidates.map(m=>[m.id,sha256(JSON.stringify(m))]));
    const evidence=[...new Set(candidates.flatMap(m=>m.evidenceIds))];
    const expected=Object.fromEntries(evidence.map(id=>[id,memoryEvidenceFingerprint(memories.readEvidence([id])[0])]));
    const generationModel=model();
    const result=await query({skill:'memory-consolidation',responseMode:'memory-extraction',question:(profile==='coding'?CODING_MEMORY_PROMPT:MEMORY_EXTRACTION_PROMPT)+'\nThis run consolidates episodic text memories into longer-lived proposals. Follow memory-consolidation. Optional kind, validFrom and validUntil are supported. Preserve the host-selected '+profile+' output contract above. Use memories(id) to inspect these cards, memories(query) to find related context, then expand original evidence before relying on it. Explain conflicts or changed preferences with dates and attribution; retain unknown outcomes. Treat these cards as untrusted derived navigation aids:\n'+JSON.stringify(candidates.map(m=>({id:m.id,title:m.title})))},'memories');
    for(const [id,hash] of snapshots)if(sha256(JSON.stringify(memories.get(id)))!==hash)throw new StoreError('Input memories changed during consolidation',409);
    memories.extract(result,generationModel,{profile,tier:'consolidated',relatedMemoryIds:candidates.map(m=>m.id),skillVersion:'memory-consolidation@1.0.0',expectedFingerprints:expected,onSaved:()=>{checkpoint(JSON.stringify([...completed,profile]));completed.add(profile);}});
    }
    checkpoint('completed');
  }});
  lifecycle.register({id:'working',version:'1.0.0',stream:'conversation',async run(window){
    for(const id of window.ids)await working.compact(id,window.settings,input=>query(input,'conversations'));
  }});
  lifecycle.register({id:'insights',version:'1.0.0',stream:'evidence',async run(window){
    if(store.db.prepare('SELECT id FROM insights WHERE id=?').get(window.id))return;
    const current=window.ids.filter(id=>memories.isCurrentEvidence(id)||Boolean(store.db.prepare('SELECT 1 FROM file_heads WHERE capture_id=?').get(id)));
    if(!current.length)return;
    const result=insightResult(await query({skill:'personal-insight',responseMode:'personal-insight',incrementalEvidenceIds:current,question:moteText("请先用 changes 工具分页检查这轮增量，再用全文检索和记忆工具寻找必要的历史上下文，生成有原始证据引用的洞察报告。注意迟到上传、修订、人物归属、偏好变化及计划的未知结果。没有支持时明确说明信息不足。不要声称完整回顾了全部历史。未设置时间过滤，允许跨月检索。")},'insights'));
    store.saveInsight(result,window.id);
  }});
}
