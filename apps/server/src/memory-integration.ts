import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import type {MemoryLifecycle} from './memory-lifecycle.js';
import {memoryEngineDraftPin,type MemoryPipeline,type MemoryEngineDraftContext,type MemoryEngineDraftPin} from './memory-pipeline.js';
import {MemoryStore,MemoryOutputValidationError} from './memory.js';
import {StoreError,sha256} from './store.js';
import {MemoryIntegrationSettings,memoryIntegrationSelectionSchema} from './memory-integration-settings.js';
import {MEMORY_CANDIDATE_OUTPUT_CONTRACT,memoryStrategyRefSchema} from './memory-strategy-contract.js';
import {reviewMemory,memoryReviewReceipt} from './memory-review.js';
import type {MemoryReviewReceipt} from './memory-schema.js';
import {moteText} from '@mote/shared/i18n';
import {ExecutionFailure} from './execution-engine.js';

const modelSchema=z.object({model:z.string(),configuration:z.object({owner:z.literal('models'),fingerprint:z.string(),revision:z.number(),profileId:z.string(),provider:z.string(),model:z.string()}).strict().optional()}).strict();
const checkpointSchema=z.object({selection:memoryIntegrationSelectionSchema,model:modelSchema,inputs:z.array(z.object({id:z.string().uuid(),hash:z.string().length(64)}).strict()).max(50),completed:z.array(z.enum(['personal','coding'])).max(2)}).strict();
export class MemoryIntegrationSelectionError extends StoreError {
  readonly code='memory_selection_changed';
  constructor(){super(moteText('所选记忆已变化，请刷新后重新选择。'),409);}
}

export function requestMemoryIntegration(raw:unknown,{lifecycle,memories,pipeline}:{lifecycle:MemoryLifecycle;memories:MemoryStore;pipeline:MemoryPipeline}){
  const input=z.object({recipe:memoryStrategyRefSchema,inputs:z.array(z.object({id:z.string().uuid(),version:z.number().int().positive(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(50).refine(inputs=>new Set(inputs.map(item=>item.id)).size===inputs.length,'Duplicate Memory input')}).strict().parse(raw);
  pipeline.assertNewManualWork();
  // The owner's selection and the executor's frozen input must describe the
  // same cards. Lock before reading, and hold the lock through journal admission.
  const db=memories.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
  try{
    let binding;try{binding=pipeline.strategies.resolveIntegration(input.recipe).binding;}catch{throw new StoreError('Memory integration recipe is unavailable',409);}
    const inputs=input.inputs.map(selected=>{const m=memories.get(selected.id);if(m.version!==selected.version||m.fingerprint!==selected.fingerprint)throw new MemoryIntegrationSelectionError();if(m.status==='stale'||m.supersededBy||m.admission?.layer!=='memory')throw new StoreError('Integration requires current selected Memory',409);pipeline.assertAdmissibleEvidence(m.evidenceIds);return {id:selected.id,hash:sha256(JSON.stringify(m))};});
    const saved={selection:{activation:randomUUID(),afterSequence:0,binding},model:pipeline.modelSnapshot(),inputs,completed:[]};
    const id=lifecycle.request('consolidation',inputs.map(item=>item.id),JSON.stringify(saved));if(own)db.exec('COMMIT');return {id,operationId:'workflow:lifecycle:'+id};
  }catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}
}

/** Integration is a consumer of the existing journal/executor/store. Strategies
 * can change their judgment, never these evidence and publication guarantees. */
export function registerMemoryIntegration({lifecycle,memories,pipeline,settings,query}:{
  lifecycle:MemoryLifecycle;memories:MemoryStore;pipeline:MemoryPipeline;settings:MemoryIntegrationSettings;
  query:(input:QueryInput)=>Promise<QueryResult>;
}){
  // Private host receipts contain identities only; an input grant or model-authored
  // trace can never manufacture one. Failed attempts retain their diagnostic gap.
  memories.store.db.exec('CREATE TABLE IF NOT EXISTS memory_integration_deliveries(operation_id TEXT NOT NULL,inputs_hash TEXT NOT NULL,step_id TEXT REFERENCES execution_steps(id) ON DELETE CASCADE,json TEXT NOT NULL,PRIMARY KEY(operation_id,inputs_hash))');
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
    return pipeline.withIntegrationAuthority(window.id,Boolean(window.manual),[...new Set(all.flatMap(card=>card.evidenceIds))],async()=>{
    const failures:unknown[]=[];
    for(const profile of ['personal','coding'] as const){
      if(state.completed.includes(profile))continue;
      const candidates=all.filter(m=>m.domain===profile);if(!candidates.length)continue;
      const selected=assertInputs(),evidence=[...new Set(candidates.flatMap(m=>m.evidenceIds))];
      let nativeContext:MemoryEngineDraftContext|undefined;
      try{
      pipeline.assertAdmissibleEvidence(evidence);
      const assertReadable=()=>{try{assertInputs();pipeline.assertIntegrationReadable(candidates);}catch{throw new ExecutionFailure('blocked','memory_integration_unreadable');}};
      assertReadable();
      const readInput=pipeline.integrationReadInput(candidates),readInputIdentity=JSON.stringify(readInput);
      const assertReadInput=()=>{assertReadable();if(JSON.stringify(pipeline.integrationReadInput(candidates))!==readInputIdentity)throw new ExecutionFailure('blocked','memory_integration_unreadable');};
      const inputsHash=sha256(JSON.stringify(candidates.map(card=>({id:card.id,version:card.version,fingerprint:card.fingerprint}))));
      const delivery={version:1 as const,inputsHash,memoryIds:[] as string[],evidenceIds:[] as string[]};
      const assertDelivered=(receipt:typeof delivery|undefined)=>{if(!receipt||receipt.version!==1||receipt.inputsHash!==inputsHash||receipt.memoryIds.some(id=>!candidates.some(card=>card.id===id))||receipt.evidenceIds.some(id=>!evidence.includes(id))||!receipt.memoryIds.length&&!receipt.evidenceIds.length)throw new ExecutionFailure('blocked','memory_integration_no_delivery');};
      const deliveryOperationId=`${execution?.operationId??window.id}:integration:${profile}`,deliveryStepId=execution?'lifecycle:'+window.id:null;
      const persistDelivery=()=>{
        assertInputs();const db=memories.store.db,json=JSON.stringify(delivery),prior=db.prepare('SELECT json,step_id FROM memory_integration_deliveries WHERE operation_id=? AND inputs_hash=?').get(deliveryOperationId,inputsHash) as {json:string;step_id:string|null}|undefined;
        const bytes=(value:string,stepId:string|null)=>Buffer.byteLength(value)+Buffer.byteLength(deliveryOperationId)+Buffer.byteLength(inputsHash)+Buffer.byteLength(stepId??'')+128;
        memories.store.reserveMetadata(Math.max(0,bytes(json,deliveryStepId)-(prior?bytes(prior.json,prior.step_id):0)));
        db.prepare('INSERT INTO memory_integration_deliveries VALUES(?,?,?,?) ON CONFLICT(operation_id,inputs_hash) DO UPDATE SET step_id=excluded.step_id,json=excluded.json').run(deliveryOperationId,inputsHash,deliveryStepId,json);
      };

      const expected=Object.fromEntries(candidates.flatMap(m=>(m.evidence??[]).map(e=>[e.id,e.contentHash])));
      const generationModel=state.model.model,contract='This integration output uses domain='+profile+' and admission.layer=memory. Every output must declare relatedMemoryIds chosen only from the supplied input cards; each chosen parent must contribute direct original proof. Relations may use contradicts or supersedes with an exact retrieved memoryId, fingerprint and version. Preserve applicability and owner corrections. Reviewed relationships apply automatically and atomically after host validation, without owner confirmation. Read the originals before relying on either a card or a relationship target. Host-supplied card IDs (untrusted derived navigation, not original evidence):\n'+JSON.stringify(candidates.map(m=>m.id));
      const validation={integration:binding,profile,tier:'consolidated' as const,relatedMemoryIds:candidates.map(m=>m.id),requireAdmission:true,expectedFingerprints:expected};
      const input:QueryInput={...readInput,...(execution?{signal:execution.signal,traceContext:{operationId:execution.operationId,jobId:execution.jobId,phase:'extract'}}:{}),contextTime:window.contextTime,modelProfileId:state.model.configuration?.profileId,modelOverride:generationModel,skill:'memory-integration',responseMode:'memory-extraction',question:selected.integrate.prompt+'\n'+MEMORY_CANDIDATE_OUTPUT_CONTRACT+'\n'+contract,
        assertContextAuthority:()=>{assertInputs();pipeline.assertAdmissibleEvidence(evidence);assertReadInput();},
        onMemoryBodies:cards=>{for(const card of cards)if(candidates.some(selected=>selected.id===card.id&&selected.version===card.version&&selected.fingerprint===card.fingerprint)&&!delivery.memoryIds.includes(card.id))delivery.memoryIds.push(card.id);persistDelivery();},
        onEvidence:records=>{for(const record of records)if(evidence.includes(record.id)&&record.ocrText.length>0&&!delivery.evidenceIds.includes(record.id))delivery.evidenceIds.push(record.id);persistDelivery();},
      };
      input.validateOutput=result=>{try{assertInputs();pipeline.assertAdmissibleEvidence(result.citations.map(c=>c.id));memories.extract(result,generationModel,{...validation,validateOnly:true});}catch(error){if(!(error instanceof MemoryOutputValidationError))throw error;return {code:error.code,feedback:error.repairInstruction};}};
      const operationId=`${execution?.operationId??window.id}:integration:${profile}`;
      const retained=pipeline.publication?.retainedOutput<{result:QueryResult;reviewReceipt?:MemoryReviewReceipt;engineDraft?:MemoryEngineDraftPin;delivery?:typeof delivery}>(operationId);
      let result:QueryResult,receipt:MemoryReviewReceipt|undefined;
      let nativePin=retained?.engineDraft;
      if(retained){
        result=retained.result;receipt=retained.reviewReceipt;assertDelivered(retained.delivery);Object.assign(delivery,retained.delivery);
        assertInputs();pipeline.assertAdmissibleEvidence(result.citations.map(c=>c.id));memories.extract(result,generationModel,{...validation,validateOnly:true});
      }else{
        persistDelivery();
        const context:MemoryEngineDraftContext=nativeContext={phase:'integrate',opId:operationId,evidenceIds:evidence,relatedMemories:candidates,assertAuthority:()=>{const check=()=>{assertInputs();pipeline.assertAdmissibleEvidence(evidence);};if(execution)execution.commit(check);else check();}};
        const native=await pipeline.engineDraft(input,context),draft=native??await query(input);if(native)nativePin=memoryEngineDraftPin(context);assertInputs();pipeline.assertAdmissibleEvidence(draft.citations.map(c=>c.id));if(!native)memories.extract(draft,generationModel,{...validation,validateOnly:true});
        assertDelivered(delivery);
        result=await reviewMemory(input,draft,query,{draftOrigin:native?'native-engine':'mote',strategy:selected.review,taskInstructions:contract,deletions:memories.deletions,authorizeDeletionEvidence:ids=>pipeline.assertDeletionEvidenceAllowed(ids,state.model.configuration?.profileId)});
        receipt=memoryReviewReceipt(result);
      }
      const completed=[...state.completed,profile];let refreshedInputs=state.inputs;
      const extractOptions={
        ...validation,reviewRunId:receipt?.reviewRunId,reviewReceipt:receipt,skillVersion:selected.integrate.id+'@'+selected.integrate.version,
      };
      const evidenceIds=[...new Set([...evidence,...result.citations.map(c=>c.id)])];
      // Staging may write to the provider, but never grants publication. Each
      // boundary retains the same lifecycle lease, exact input and privacy proof.
      const assertAuthority=()=>{
        const assert=()=>{pipeline.assertIntegrationAuthority();assertInputs();pipeline.assertAdmissibleEvidence(evidenceIds);assertReadInput();};
        if(execution)execution.commit(assert);else assert();
      };
      assertAuthority();assertReadInput();assertDelivered(delivery);
      pipeline.publication?.retainOutput(operationId,{result,reviewReceipt:receipt,engineDraft:nativePin,delivery},{evidenceIds:evidence,memoryIds:candidates.map(memory=>memory.id)});
      if(nativePin&&pipeline.publication?.retainedOutput(operationId))await pipeline.settleEngineDraft(nativePin);
      const publication=await pipeline.publication?.stageExtract(operationId,result,generationModel,extractOptions,assertAuthority,!window.manual);
      const commit=()=>{
        pipeline.assertIntegrationAuthority();assertInputs();assertReadInput();
        pipeline.withAdmissibleEvidence(evidenceIds,()=>{
          pipeline.publication?.assert(publication,result);
          memories.extract(result,generationModel,{
            ...extractOptions,prepared:publication?.prepared,
            onSaved:()=>{refreshedInputs=state.inputs.map(input=>({id:input.id,hash:sha256(JSON.stringify(memories.get(input.id)))}));checkpoint(JSON.stringify({...state,inputs:refreshedInputs,completed}));},
          });
          pipeline.publication?.committed(publication);
        });
      };if(execution)execution.commit(commit);else commit();
      state.inputs=refreshedInputs;state.completed=completed;
      }catch(error){if(nativeContext)pipeline.abandonEngineDraft(nativeContext);failures.push(error);}
    }
    if(failures.length)throw failures[0];
    checkpoint('completed');
    });
  }});
  settings.onApplied=through=>lifecycle.retirePending('consolidation',through);
  lifecycle.retirePending('consolidation',settings.selection().afterSequence);
}
