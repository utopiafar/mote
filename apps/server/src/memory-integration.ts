import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import type {MemoryLifecycle} from './memory-lifecycle.js';
import type {MemoryPipeline} from './memory-pipeline.js';
import {MemoryStore,MemoryOutputValidationError} from './memory.js';
import {StoreError,sha256} from './store.js';
import {MemoryIntegrationSettings,memoryIntegrationSelectionSchema} from './memory-integration-settings.js';
import {MEMORY_CANDIDATE_OUTPUT_CONTRACT,memoryStrategyRefSchema} from './memory-strategy-contract.js';
import {reviewMemory,memoryReviewReceipt} from './memory-review.js';

const modelSchema=z.object({model:z.string(),configuration:z.object({owner:z.literal('models'),fingerprint:z.string(),revision:z.number(),profileId:z.string(),provider:z.string(),model:z.string()}).strict().optional()}).strict();
const checkpointSchema=z.object({selection:memoryIntegrationSelectionSchema,model:modelSchema,inputs:z.array(z.object({id:z.string().uuid(),hash:z.string().length(64)}).strict()).max(50),completed:z.array(z.enum(['personal','coding'])).max(2)}).strict();

export function requestMemoryIntegration(raw:unknown,{lifecycle,memories,pipeline}:{lifecycle:MemoryLifecycle;memories:MemoryStore;pipeline:MemoryPipeline}){
  const input=z.object({recipe:memoryStrategyRefSchema,memoryIds:z.array(z.string().uuid()).min(1).max(50).refine(ids=>new Set(ids).size===ids.length,'Duplicate Memory input')}).strict().parse(raw);
  let binding;try{binding=pipeline.strategies.resolveIntegration(input.recipe).binding;}catch{throw new StoreError('Memory integration recipe is unavailable',409);}
  const inputs=input.memoryIds.map(id=>{const m=memories.get(id);if(m.status==='stale'||m.supersededBy||m.admission?.layer!=='memory')throw new StoreError('Integration requires current selected Memory',409);pipeline.assertAdmissibleEvidence(m.evidenceIds);return {id,hash:sha256(JSON.stringify(m))};});
  const saved={selection:{activation:randomUUID(),afterSequence:0,binding},model:pipeline.modelSnapshot(),inputs,completed:[]};
  const id=lifecycle.request('consolidation',input.memoryIds,JSON.stringify(saved));return {id,operationId:'workflow:lifecycle:'+id};
}

/** Integration is a consumer of the existing journal/executor/store. Strategies
 * can change their judgment, never these evidence and publication guarantees. */
export function registerMemoryIntegration({lifecycle,memories,pipeline,settings,query}:{
  lifecycle:MemoryLifecycle;memories:MemoryStore;pipeline:MemoryPipeline;settings:MemoryIntegrationSettings;
  query:(input:QueryInput)=>Promise<QueryResult>;
}){
  lifecycle.register({id:'consolidation',version:'2.0.0',stream:'memory',maxAttempts:3,async run(window,checkpoint,execution){
    if(window.checkpoint==='completed')return;
    let saved=window.checkpoint?checkpointSchema.parse(JSON.parse(window.checkpoint)):undefined;
    if(!saved){
      const selection=settings.selection();if(!selection.binding){checkpoint('completed');return;}
      const inputs=settings.eligible(window.ids,selection.afterSequence,window.through).flatMap(id=>{
        try{const m=memories.get(id);return m.status==='stale'||m.supersededBy||m.tier==='consolidated'||m.admission?.layer!=='memory'?[]:[{id,hash:sha256(JSON.stringify(m))}];}catch{return [];}
      });
      if(!inputs.length){checkpoint('completed');return;}
      saved={selection,model:pipeline.modelSnapshot(),inputs,completed:[]};checkpoint(JSON.stringify(saved));
    }
    const state=saved,binding=state.selection.binding;if(!binding){checkpoint('completed');return;}
    const assertInputs=()=>{
      execution?.signal.throwIfAborted();
      if(!window.manual&&!settings.current(state.selection))throw new StoreError('Memory integration selection changed',409);
      const current=pipeline.modelSnapshot();
      if(current.model!==state.model.model||current.configuration?.fingerprint!==state.model.configuration?.fingerprint)throw new StoreError('Memory integration model configuration changed',409);
      let selected;try{selected=pipeline.strategies.resolvePinnedIntegration(binding);}catch{throw new StoreError('Memory integration definition is unavailable or changed',409);}
      for(const input of state.inputs)if(sha256(JSON.stringify(memories.get(input.id)))!==input.hash)throw new StoreError('Integration input memories changed',409);
      return selected;
    };
    assertInputs();
    const all=state.inputs.map(input=>memories.get(input.id));
    const failures:unknown[]=[];
    for(const profile of ['personal','coding'] as const){
      if(state.completed.includes(profile))continue;
      const candidates=all.filter(m=>(m.domain??'personal')===profile);if(!candidates.length)continue;
      const selected=assertInputs(),evidence=[...new Set(candidates.flatMap(m=>m.evidenceIds))];
      try{
      pipeline.assertAdmissibleEvidence(evidence);
      const expected=Object.fromEntries(candidates.flatMap(m=>(m.evidence??[]).map(e=>[e.id,e.contentHash])));
      const generationModel=state.model.model,contract='This integration output uses domain='+profile+' and admission.layer=memory. Every output must declare relatedMemoryIds chosen only from the supplied input cards; each chosen parent must contribute direct original proof. Relations may use contradicts or supersedes with an exact retrieved memoryId, fingerprint and version. Preserve applicability and owner corrections. Relationships remain proposals pending explicit owner confirmation. Read the originals before relying on either a card or a relationship target. Host-supplied card IDs (untrusted derived navigation, not original evidence):\n'+JSON.stringify(candidates.map(m=>m.id));
      const validation={integration:binding,profile,tier:'consolidated' as const,relatedMemoryIds:candidates.map(m=>m.id),requireAdmission:true,expectedFingerprints:expected};
      const input:QueryInput={...(execution?{signal:execution.signal,traceContext:{operationId:execution.operationId,jobId:execution.jobId,phase:'extract'}}:{}),contextTime:new Date(window.startedAt).toISOString(),modelProfileId:state.model.configuration?.profileId,modelOverride:generationModel,skill:'memory-integration',responseMode:'memory-extraction',question:selected.integrate.prompt+'\n'+MEMORY_CANDIDATE_OUTPUT_CONTRACT+'\n'+contract};
      input.validateOutput=result=>{try{assertInputs();pipeline.assertAdmissibleEvidence(result.citations.map(c=>c.id));memories.extract(result,generationModel,{...validation,validateOnly:true});}catch(error){if(!(error instanceof MemoryOutputValidationError))throw error;return {code:error.code,feedback:error.repairInstruction};}};
      const draft=await query(input);assertInputs();pipeline.assertAdmissibleEvidence(draft.citations.map(c=>c.id));memories.extract(draft,generationModel,{...validation,validateOnly:true});
      const result=await reviewMemory(input,draft,query,{strategy:selected.review,taskInstructions:contract});
      const completed=[...state.completed,profile];
      const commit=()=>{
        assertInputs();
        pipeline.withAdmissibleEvidence([...new Set([...evidence,...result.citations.map(c=>c.id)])],()=>memories.extract(result,generationModel,{
          ...validation,reviewRunId:memoryReviewReceipt(result)?.reviewRunId,reviewReceipt:memoryReviewReceipt(result),skillVersion:selected.integrate.id+'@'+selected.integrate.version,
          onSaved:()=>checkpoint(JSON.stringify({...state,completed})),
        }));
      };if(execution)execution.commit(commit);else commit();
      state.completed=completed;
      }catch(error){failures.push(error);}
    }
    if(failures.length)throw failures[0];
    checkpoint('completed');
  }});
  settings.onApplied=through=>lifecycle.retirePending('consolidation',through);
  lifecycle.retirePending('consolidation',settings.selection().afterSequence);
}
