import type {MemoryIntegrationSettings} from './memory-integration-settings.js';
import {MemoryIntegrationSelectionError,requestMemoryIntegration} from './memory-integration.js';
import {memoryRecipeSettingsQuery,type MemoryRecipeSettings} from './memory-recipe-settings.js';
import type {FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {sourceContentTime,type QueryResult} from '@mote/shared';
import type {QueryInput} from '@mote/agent';
import {scopeFields,validRange} from './query-scope.js';
import {modelProfileIdSchema,type ModelSettingsStore} from './model-settings.js';
import {modelConfiguration} from './model-configuration.js';
import {MemoryOutputValidationError,MEMORY_EXTRACTION_PROMPT,memoryEvidenceFingerprint,type MemoryStore} from './memory.js';
import {memoryStrategyRefSchema} from './memory-strategy-contract.js';
import {memoryReviewReceipt} from './memory-review.js';
import type {MemoryPipeline} from './memory-pipeline.js';
import type {MemoryLifecycle} from './memory-lifecycle.js';
import type {EvidenceReader} from './evidence-reader.js';
import type {FileStore} from './files.js';
import {StoreError,type Store} from './store.js';
import type {ModelAuthorizationHost} from './model-authorization-host.js';
import type {ModelConnection} from './background-model-authorization.js';
import {EvidenceExposurePolicy} from './evidence-exposure.js';
import type {ManualMemoryInputPlanRequest} from './memory-input-plans.js';
export function registerMemoryRoutes(app:FastifyInstance,{modelAuthorizationHost,availableModelConnections,memoryIntegrationSettings,memoryRecipeSettings,store,files,evidenceReader,memories,memoryPipeline,lifecycle,modelSettings,query,reviewExtraction}:{modelAuthorizationHost:ModelAuthorizationHost;availableModelConnections:()=>ModelConnection[];memoryIntegrationSettings:MemoryIntegrationSettings;memoryRecipeSettings:MemoryRecipeSettings;store:Store;files:FileStore;evidenceReader:EvidenceReader;memories:MemoryStore;memoryPipeline:MemoryPipeline;lifecycle:MemoryLifecycle;modelSettings:ModelSettingsStore;query:(input:QueryInput)=>Promise<QueryResult>;reviewExtraction:(input:QueryInput,result:QueryResult,strategy?:import('./memory-strategy-contract.js').MemoryReviewStrategy,draftOrigin?:import('./memory-review.js').MemoryDraftOrigin)=>Promise<QueryResult>}){
 const jobId=(params:unknown)=>z.object({id:z.string().uuid()}).parse(params).id;
  app.post('/api/memories/:id/publish',async req=>{const body=z.object({version:z.number().int().positive().optional()}).strict().parse(req.body??{});return memoryPipeline.publication?memoryPipeline.publication.withOwnerWork(()=>memoryPipeline.publication!.publish((req.params as {id:string}).id,body.version)):memories.publish((req.params as {id:string}).id,body.version);});
  app.post('/api/memories/:id/correct',async req=>memoryPipeline.publication?memoryPipeline.publication.withOwnerWork(()=>memoryPipeline.publication!.correct((req.params as {id:string}).id,req.body)):memories.correct((req.params as {id:string}).id,req.body));
  app.delete('/api/memories/:id',async req=>memoryPipeline.publication?memoryPipeline.publication.delete((req.params as {id:string}).id):memories.delete((req.params as {id:string}).id));
  app.get('/api/memory-settings',async()=>lifecycle.view());
  app.put('/api/memory-settings',{bodyLimit:8192},async req=>lifecycle.save(req.body));
  app.post('/api/memory-settings/extraction/:id/retry',async(req,reply)=>{
    const id=jobId(req.params),extraction=lifecycle.view().extensions.find(extension=>extension.id==='extraction');
    if(extraction?.status!=='failed'||extraction.active?.id!==id)throw new StoreError('Failed extraction window not found',409);
    const result=lifecycle.retry('extraction',id,window=>{
      if(!extraction.manualRetryRequired)return;
      if(window.checkpoint){
        const child=memoryPipeline.get(window.checkpoint);
        // Only this exact durable backlink authorizes restarting the failed
        // checkpoint; unrelated jobs retain their terminal receipts.
        if(child.status==='failed'&&child.importJobId==='lifecycle:'+window.id){const accepted=memoryPipeline.acceptRetry(child.id,true);void accepted.completion.catch(()=>{});}
      }
      if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='processing_jobs'").get())return;
      const rows=store.db.prepare("SELECT e.id,j.json FROM operation_parents p JOIN execution_steps e ON e.operation_id=p.child_id JOIN processing_jobs j ON j.id=e.id WHERE p.parent_id=? AND e.kind='context-dag.semantic' AND e.state IN ('failed','blocked')").all('workflow:lifecycle:'+window.id) as {id:string;json:string}[];
      if(!rows.length)return;
      const selected=modelSettings.select('memory'),fingerprint=modelConfiguration(selected.id,selected.settings,modelSettings.view().revision).fingerprint,inputs=new Set(window.ids);
      for(const row of rows){
        const job=JSON.parse(row.json) as {processor?:string;config?:{artifactId?:string;modelFingerprint?:string};artifactInputs?:{id:string;revision:string}[]};
        const artifactId=job.config?.artifactId,source=job.artifactInputs?.[0];
        if(job.processor!=='mote.segment-understanding'||!artifactId||!inputs.has(artifactId)||job.config?.modelFingerprint!==fingerprint||!source||source.id!==artifactId||store.archive.revision(source.id)!==source.revision)continue;
        memoryPipeline.engine.retry(row.id,true);
      }
    });
    void lifecycle.tick().catch(()=>{});return reply.code(202).send(result);
  });
  app.get('/api/memory-recipe-settings',async req=>{const query=memoryRecipeSettingsQuery.parse(req.query);return memoryRecipeSettings.view(query.sourceId,query.scope);});
  app.put('/api/memory-recipe-settings',{bodyLimit:8192},async req=>memoryRecipeSettings.configure(req.body));
  app.get('/api/memory-integration-recipes',async()=>({items:memoryPipeline.strategies.listIntegrations()}));
  app.get('/api/memory-integration-settings',async()=>memoryIntegrationSettings.view());
  app.put('/api/memory-integration-settings',{bodyLimit:4096},async req=>memoryIntegrationSettings.configure(req.body));
  app.post('/api/memory-integrations',{bodyLimit:8192},async(req,reply)=>{
    try{const result=requestMemoryIntegration(req.body,{lifecycle,memories,pipeline:memoryPipeline});modelAuthorizationHost.control.manual('owner-integration:'+result.id,'manual',[],availableModelConnections());void lifecycle.tick().catch(()=>{});return reply.code(202).send(result);}
    catch(error){if(error instanceof MemoryIntegrationSelectionError)return reply.code(error.statusCode).send({error:error.code,message:error.message,requestId:req.id});throw error;}
  });
  app.post('/api/memory-integrations/:id/cancel',async req=>lifecycle.cancel('consolidation',jobId(req.params)));
  app.post('/api/memory-integrations/:id/retry',async(req,reply)=>{const result=lifecycle.retry('consolidation',jobId(req.params));void lifecycle.tick().catch(()=>{});return reply.code(202).send(result);});
  app.get('/api/memory-recipes',async()=>({items:memoryPipeline.strategies.list()}));
  app.get('/api/memory-jobs',async req=>memoryPipeline.page(z.object({
    limit:z.coerce.number().int().min(1).max(100).default(30),
    cursor:z.string().min(1).max(1000).optional(),
  }).strict().parse(req.query)));
  app.get('/api/memory-jobs/:id',async req=>memoryPipeline.get(jobId(req.params)));
  app.post('/api/memory-jobs',async(req,reply)=>{
    memoryPipeline.assertNewManualWork();
    const scope=z.object({...scopeFields,contextTime:z.string().datetime({offset:true}).optional(),recipes:z.array(memoryStrategyRefSchema).min(1).max(10).optional(),modelProfileId:modelProfileIdSchema.optional(),evidenceIds:z.array(z.string().uuid()).min(1).max(20000).optional()}).strict().refine(validRange,{message:'Invalid time range'}).parse(req.body??{});
    const profile=modelSettings.select('memory',scope.modelProfileId);
    const policy=new EvidenceExposurePolicy();
    const bindings=scope.recipes?.map(ref=>{try{return memoryPipeline.strategies.resolve(ref).binding;}catch{throw new StoreError('Memory recipe is unavailable',409);}});
    const create=(ids:string[],manualPlans?:ManualMemoryInputPlanRequest[],selection?:unknown)=>modelAuthorizationHost.manual('owner-memory:'+randomUUID(),availableModelConnections(),async()=>{
      const job=memoryPipeline.create({contextTime:scope.contextTime,recipes:scope.recipes,evidenceIds:ids,...(manualPlans?.length?{manualPlans}:{}),timeZone:scope.timeZone,batchCharacters:lifecycle.settings().batchCharacters,modelProfileId:profile.id,modelOverride:scope.modelProfileId?undefined:modelSettings.view().defaultModels?.memory});
      void memoryPipeline.run(job.id).catch(()=>{});return reply.code(202).send({...job,...(selection?{selection}:{})});
    });
    if(bindings&&!scope.evidenceIds){
      const selected=evidenceReader.memoryPlanSelection(scope,bindings,policy);
      if(!selected.evidenceIds.length&&!selected.manualPlans.length)throw new StoreError('No evidence in this range',409);
      return create(selected.evidenceIds,selected.manualPlans,{unavailable:selected.unavailable});
    }
    const requirements=bindings?.map(binding=>binding.requires);
    const selection=scope.evidenceIds?undefined:evidenceReader.memorySelection(scope,undefined,new EvidenceExposurePolicy(),requirements);
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
    if(bindings){
      const selected=evidenceReader.memoryPlanSelection(scope,bindings,policy,ids);
      if(!selected.evidenceIds.length&&!selected.manualPlans.length)throw new StoreError('No allowed evidence in this range',409);
      return create(selected.evidenceIds,selected.manualPlans,{unavailable:selected.unavailable});
    }
    return create(ids,undefined,selection?{waiting:selection.waiting,unavailable:selection.unavailable}:undefined);
  });
  app.post('/api/memory-jobs/:id/pause',async req=>memoryPipeline.pause(jobId(req.params)));
  app.post('/api/memory-jobs/:id/resume',async req=>{const id=jobId(req.params);memoryPipeline.resume(id);return memoryPipeline.get(id);});
  app.post('/api/memory-jobs/:id/cancel',async req=>memoryPipeline.cancel(jobId(req.params)));
  app.post('/api/memory-jobs/:id/retry',async(req,reply)=>{const accepted=memoryPipeline.acceptRetry(jobId(req.params),true);void accepted.completion.catch(()=>{});return reply.code(202).send(accepted.job);});
  app.post('/api/memories/extract',async req=>{
    const execute=async()=>{
    memoryPipeline.assertNewManualWork();
    const operationId='owner-extract:'+randomUUID();
    const {modelProfileId,...scope}=z.object({...scopeFields,modelProfileId:modelProfileIdSchema.optional()}).strict().refine(validRange).parse(req.body??{}),profile=modelSettings.select('memory',modelProfileId);
    const selected=evidenceReader.memorySelection(scope,undefined,new EvidenceExposurePolicy());
    if(!selected.evidenceIds.length)throw new StoreError('No processed evidence in this range',409);
    const records=memories.readEvidence(selected.evidenceIds),expectedFingerprints=Object.fromEntries(records.map(record=>[record.id,memoryEvidenceFingerprint(record)]));
    const evidenceRanges=records.map(record=>({id:record.id,offset:0,length:record.ocrText.length}));
    const input:QueryInput={...scope,evidenceRanges,evidenceIds:selected.evidenceIds,modelProfileId:profile.id,modelOverride:profile.settings.model,skill:'memory-extraction',responseMode:'memory-extraction',question:MEMORY_EXTRACTION_PROMPT};
    input.validateOutput=result=>{try{memoryPipeline.assertAdmissibleEvidence(result.citations.map(c=>c.id),profile.id);memories.extract(result,profile.settings.model,{requireAdmission:true,validateOnly:true,expectedFingerprints});}catch(error){if(!(error instanceof MemoryOutputValidationError))throw error;return {code:error.code,feedback:error.repairInstruction};}};
    const context={phase:'extract' as const,opId:operationId,evidenceIds:selected.evidenceIds,assertAuthority:()=>memoryPipeline.assertAdmissibleEvidence(selected.evidenceIds,profile.id)};
    try{
    const native=await memoryPipeline.engineDraft(input,context),draft=native??await query(input);
    memoryPipeline.assertAdmissibleEvidence(draft.citations.map(c=>c.id),profile.id);
    if(!native)memories.extract(draft,profile.settings.model,{requireAdmission:true,validateOnly:true,expectedFingerprints});
    const result=await reviewExtraction(input,draft,undefined,native?'native-engine':'mote');
    const options={requireAdmission:true,expectedFingerprints,reviewRunId:memoryReviewReceipt(result)?.reviewRunId,reviewReceipt:memoryReviewReceipt(result)};
    const assert=()=>memoryPipeline.assertAdmissibleEvidence(result.citations.map(c=>c.id),profile.id);
    assert();memoryPipeline.publication?.retainOutput(operationId,{result,reviewReceipt:memoryReviewReceipt(result)},{evidenceIds:selected.evidenceIds});
    if(native&&memoryPipeline.publication?.retainedOutput(operationId))await memoryPipeline.settleEngineDraft(context);
    const publication=await memoryPipeline.publication?.stageExtract(operationId,result,profile.settings.model,options,assert);
    return memoryPipeline.withAdmissibleEvidence(result.citations.map(c=>c.id),()=>{
      memoryPipeline.publication?.assert(publication,result);const saved=memories.extract(result,profile.settings.model,{...options,prepared:publication?.prepared});memoryPipeline.publication?.committed(publication);return saved;
    },profile.id);
    }catch(error){memoryPipeline.abandonEngineDraft(context);throw error;}
    };return modelAuthorizationHost.manual('owner-extract:'+randomUUID(),availableModelConnections(),()=>memoryPipeline.publication?memoryPipeline.publication.withOwnerWork(execute):execute());
  });
}
