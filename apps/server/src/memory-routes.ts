import type {MemoryIntegrationSettings} from './memory-integration-settings.js';
import {requestMemoryIntegration} from './memory-integration.js';
import type {MemoryRecipeSettings} from './memory-recipe-settings.js';
import type {FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {sourceContentTime,type QueryResult} from '@mote/shared';
import type {QueryInput} from '@mote/agent';
import {scopeFields,validRange} from './query-scope.js';
import {modelProfileIdSchema,type ModelSettingsStore} from './model-settings.js';
import {MemoryOutputValidationError,MEMORY_EXTRACTION_PROMPT,memoryEvidenceFingerprint,type MemoryStore} from './memory.js';
import {memoryStrategyRefSchema} from './memory-strategy-contract.js';
import {memoryReviewReceipt} from './memory-review.js';
import type {MemoryPipeline} from './memory-pipeline.js';
import type {MemoryLifecycle} from './memory-lifecycle.js';
import type {EvidenceReader} from './evidence-reader.js';
import type {FileStore} from './files.js';
import {StoreError,type Store} from './store.js';
import {EvidenceExposurePolicy} from './evidence-exposure.js';
import {usesLocalModel} from './model-agent.js';
export function registerMemoryRoutes(app:FastifyInstance,{memoryIntegrationSettings,memoryRecipeSettings,store,files,evidenceReader,memories,memoryPipeline,lifecycle,modelSettings,query,reviewExtraction}:{memoryIntegrationSettings:MemoryIntegrationSettings;memoryRecipeSettings:MemoryRecipeSettings;store:Store;files:FileStore;evidenceReader:EvidenceReader;memories:MemoryStore;memoryPipeline:MemoryPipeline;lifecycle:MemoryLifecycle;modelSettings:ModelSettingsStore;query:(input:QueryInput)=>Promise<QueryResult>;reviewExtraction:(input:QueryInput,result:QueryResult)=>Promise<QueryResult>}){
 const jobId=(params:unknown)=>z.object({id:z.string().uuid()}).parse(params).id;
  app.post('/api/memories/:id/publish',async req=>{const body=z.object({version:z.number().int().positive().optional()}).strict().parse(req.body??{});return memories.publish((req.params as {id:string}).id,body.version);});
  app.post('/api/memories/:id/correct',async req=>memories.correct((req.params as {id:string}).id,req.body));
  app.delete('/api/memories/:id',async req=>memories.delete((req.params as {id:string}).id));
  app.get('/api/memory-settings',async()=>{const view=lifecycle.view();return {...view,extensions:view.extensions.map(extension=>({...extension,status:extension.retryAt&&extension.retryAt>Date.now()?'retry_wait':extension.id==='extraction'&&extension.active?.checkpoint?memoryPipeline.get(extension.active.checkpoint).status:extension.status}))};});
  app.put('/api/memory-settings',{bodyLimit:8192},async req=>lifecycle.configure(req.body));
  app.get('/api/memory-recipe-settings',async req=>memoryRecipeSettings.view(z.object({sourceId:z.string().min(1).max(256).optional()}).strict().parse(req.query).sourceId));
  app.put('/api/memory-recipe-settings',{bodyLimit:8192},async req=>memoryRecipeSettings.configure(req.body));
  app.get('/api/memory-integration-recipes',async()=>({items:memoryPipeline.strategies.listIntegrations()}));
  app.get('/api/memory-integration-settings',async()=>memoryIntegrationSettings.view());
  app.put('/api/memory-integration-settings',{bodyLimit:4096},async req=>memoryIntegrationSettings.configure(req.body));
  app.post('/api/memory-integrations',{bodyLimit:8192},async(req,reply)=>{const result=requestMemoryIntegration(req.body,{lifecycle,memories,pipeline:memoryPipeline});void lifecycle.tick().catch(()=>{});return reply.code(202).send(result);});
  app.post('/api/memory-integrations/:id/cancel',async req=>lifecycle.cancel('consolidation',jobId(req.params)));
  app.post('/api/memory-integrations/:id/retry',async(req,reply)=>{const result=lifecycle.retry('consolidation',jobId(req.params));void lifecycle.tick().catch(()=>{});return reply.code(202).send(result);});
  app.get('/api/memory-recipes',async()=>({items:memoryPipeline.strategies.list()}));
  app.get('/api/memory-jobs',async()=>({items:memoryPipeline.list()}));
  app.get('/api/memory-jobs/:id',async req=>memoryPipeline.get(jobId(req.params)));
  app.post('/api/memory-jobs',async(req,reply)=>{
    const scope=z.object({...scopeFields,contextTime:z.string().datetime({offset:true}).optional(),recipes:z.array(memoryStrategyRefSchema).min(1).max(8).optional(),modelProfileId:modelProfileIdSchema.optional(),evidenceIds:z.array(z.string().uuid()).min(1).max(20000).optional()}).strict().refine(validRange,{message:'Invalid time range'}).parse(req.body??{});
    const profile=modelSettings.select('memory',scope.modelProfileId);
    const requirements=scope.recipes?.map(ref=>{try{return memoryPipeline.strategies.resolve(ref).binding.requires;}catch{throw new StoreError('Memory recipe is unavailable',409);}});
    const selection=scope.evidenceIds?undefined:evidenceReader.memorySelection(scope,undefined,new EvidenceExposurePolicy([],()=>usesLocalModel(profile.settings)),requirements);
    let ids=scope.evidenceIds??selection!.evidenceIds;
    if(!ids.length)throw new StoreError('No evidence in this range',409);
    ids=[...new Set(ids)];
    for(let offset=0;offset<ids.length;offset+=200){
      const selected=ids.slice(offset,offset+200),records=memories.readEvidence(selected);
      if(selected.some(id=>!records.some(record=>record.id===id)))throw new StoreError('Selected evidence is missing',409);
      for(const record of records){const at=Date.parse(sourceContentTime(record));if((scope.deviceId&&record.deviceId!==scope.deviceId)||(scope.after&&at<Date.parse(scope.after))||(scope.before&&at>=Date.parse(scope.before)))throw new StoreError('Evidence is outside the selected range',409);}
    }
    // Typed originals have their text in separately archived transcript chunks.
    // Expand their preferred artifacts deterministically before creating batches.
    const expanded=new Set<string>();
    for(const id of ids){
      if(store.db.prepare('SELECT 1 FROM file_versions WHERE capture_id=?').get(id)&&store.evidence([id])[0]?.provenance?.document?.fileIndex?.mode!=='index'){
        if(!store.db.prepare('SELECT 1 FROM file_heads WHERE capture_id=?').get(id))throw new StoreError('Selected file revision is superseded',409);
        for(let offset=0;;offset+=200){const chunks=files.chunks(id,offset,200);for(const chunk of chunks)if(files.isCurrentEvidence(chunk.id))expanded.add(chunk.id);if(expanded.size>20000)throw new StoreError('Choose a smaller range for memory extraction',413);if(chunks.length<200)break;}
      }else expanded.add(id);
      if(expanded.size>20000)throw new StoreError('Choose a smaller range for memory extraction',413);
    }
    ids=[...expanded];if(!ids.length)throw new StoreError('No processed evidence in this range',409);
    const job=memoryPipeline.create({contextTime:scope.contextTime,recipes:scope.recipes,evidenceIds:ids,timeZone:scope.timeZone,batchCharacters:lifecycle.settings().batchCharacters,modelProfileId:profile.id,modelOverride:scope.modelProfileId?undefined:modelSettings.view().defaultModels?.memory});void memoryPipeline.run(job.id).catch(()=>{});return reply.code(202).send({...job,selection:selection?{waiting:selection.waiting,unavailable:selection.unavailable}:undefined});
  });
  app.post('/api/memory-jobs/:id/pause',async req=>memoryPipeline.pause(jobId(req.params)));
  app.post('/api/memory-jobs/:id/resume',async req=>{const id=jobId(req.params);memoryPipeline.resume(id);return memoryPipeline.get(id);});
  app.post('/api/memory-jobs/:id/cancel',async req=>memoryPipeline.cancel(jobId(req.params)));
  app.post('/api/memory-jobs/:id/retry',async(req,reply)=>{const id=jobId(req.params);memoryPipeline.get(id);void memoryPipeline.retry(id).catch(()=>{});return reply.code(202).send(memoryPipeline.get(id));});
  app.post('/api/memories/extract',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async req=>{
    const {modelProfileId,...scope}=z.object({...scopeFields,modelProfileId:modelProfileIdSchema.optional()}).strict().refine(validRange).parse(req.body??{}),profile=modelSettings.select('memory',modelProfileId);
    const selected=evidenceReader.memorySelection(scope,100,new EvidenceExposurePolicy([],()=>usesLocalModel(profile.settings)));
    if(!selected.evidenceIds.length)throw new StoreError('No processed evidence in this range',409);
    const records=memories.readEvidence(selected.evidenceIds),expectedFingerprints=Object.fromEntries(records.map(record=>[record.id,memoryEvidenceFingerprint(record)]));
    const evidenceRanges=records.map(record=>({id:record.id,offset:0,length:record.ocrText.length}));
    if(evidenceRanges.reduce((sum,range)=>sum+range.length,0)>100000)throw new StoreError('Use a Memory job for this larger range',413);
    const input:QueryInput={...scope,evidenceRanges,evidenceIds:selected.evidenceIds,modelProfileId:profile.id,modelOverride:profile.settings.model,skill:'memory-extraction',responseMode:'memory-extraction',question:MEMORY_EXTRACTION_PROMPT};
    input.validateOutput=result=>{try{memoryPipeline.assertAdmissibleEvidence(result.citations.map(c=>c.id),profile.id);memories.extract(result,profile.settings.model,{requireAdmission:true,validateOnly:true,expectedFingerprints});}catch(error){if(!(error instanceof MemoryOutputValidationError))throw error;return {code:error.code,feedback:error.repairInstruction};}};
    const draft=await query(input);
    memoryPipeline.assertAdmissibleEvidence(draft.citations.map(c=>c.id),profile.id);
    memories.extract(draft,profile.settings.model,{requireAdmission:true,validateOnly:true,expectedFingerprints});
    const result=await reviewExtraction(input,draft);
    return memoryPipeline.withAdmissibleEvidence(result.citations.map(c=>c.id),()=>
      memories.extract(result,profile.settings.model,{requireAdmission:true,expectedFingerprints,reviewRunId:memoryReviewReceipt(result)?.reviewRunId,reviewReceipt:memoryReviewReceipt(result)}),profile.id);
  });
}
