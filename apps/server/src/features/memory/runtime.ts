import type {FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {sourceContentTime,type QueryResult} from '@mote/shared';
import type {QueryInput} from '@mote/agent';
import {MemoryIntegrationSelectionError,requestMemoryIntegration} from '../../memory-integration.js';
import {scopeFields,validRange} from '../../query-scope.js';
import {modelProfileIdSchema,type ModelSettingsStore} from '../../model-settings.js';
import {modelConfiguration} from '../../model-configuration.js';
import type {MemoryStore} from '../../memory.js';
import {memoryStrategyRefSchema} from '../../memory-strategy-contract.js';
import type {MemoryPipeline} from '../../memory-pipeline.js';
import type {MemoryLifecycle} from '../../memory-lifecycle.js';
import type {MemoryInputSelection} from '../../evidence-read-ports.js';
import type {FileStore} from '../../files.js';
import {StoreError,type Store} from '../../store.js';
import type {ModelAuthorizationHost} from '../../model-authorization-host.js';
import type {ModelConnection} from '../../background-model-authorization.js';
import {EvidenceExposurePolicy} from '../../evidence-exposure.js';
import type {ManualMemoryInputPlanRequest} from '../../memory-input-plans.js';

export interface MemoryRuntimeRouteDependencies {
  readonly pipeline:()=>MemoryPipeline;
  readonly lifecycle:()=>MemoryLifecycle;
  readonly store:Store;
  readonly files:FileStore;
  readonly evidenceReader:MemoryInputSelection;
  readonly memories:MemoryStore;
  readonly modelSettings:ModelSettingsStore;
  readonly modelAuthorizationHost:ModelAuthorizationHost;
  readonly availableModelConnections:()=>ModelConnection[];
  readonly readable:()=>boolean;
  readonly writable:()=>boolean;
}

const jobId=(params:unknown)=>z.object({id:z.string().uuid()}).parse(params).id;

/** C22's settings, durable jobs and owner integration windows. Every handler
 * resolves the current pipeline/lifecycle activation; a stopped owner answers
 * 503 without installing another route table. */
export function registerMemoryRuntimeRoutes(app:FastifyInstance,dependencies:MemoryRuntimeRouteDependencies){
  app.register(async child=>{
    child.addHook('onRequest',async(request,reply)=>{
      const write=request.method!=='GET'&&request.method!=='HEAD';
      if(write?!dependencies.writable():!dependencies.readable())return reply.code(503).send({error:'feature_unavailable'});
    });
    child.get('/api/memory-settings',async()=>dependencies.lifecycle().view());
    child.put('/api/memory-settings',{bodyLimit:8192},async req=>dependencies.lifecycle().save(req.body));
    child.post('/api/memory-settings/extraction/:id/retry',async(req,reply)=>{
      const id=jobId(req.params),lifecycle=dependencies.lifecycle(),pipeline=dependencies.pipeline(),extraction=lifecycle.view().extensions.find(extension=>extension.id==='extraction');
      if(extraction?.status!=='failed'||extraction.active?.id!==id)throw new StoreError('Failed extraction window not found',409);
      const result=lifecycle.retry('extraction',id,window=>{
        if(!extraction.manualRetryRequired)return;
        if(window.checkpoint){
          const child=pipeline.get(window.checkpoint);
          // Only this exact durable backlink authorizes restarting the failed
          // checkpoint; unrelated jobs retain their terminal receipts.
          if(child.status==='failed'&&child.importJobId==='lifecycle:'+window.id){const accepted=pipeline.acceptRetry(child.id,true);void accepted.completion.catch(()=>{});}
        }
        if(!dependencies.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='processing_jobs'").get())return;
        const rows=dependencies.store.db.prepare("SELECT e.id,j.json FROM operation_parents p JOIN execution_steps e ON e.operation_id=p.child_id JOIN processing_jobs j ON j.id=e.id WHERE p.parent_id=? AND e.kind='context-dag.semantic' AND e.state IN ('failed','blocked')").all('workflow:lifecycle:'+window.id) as {id:string;json:string}[];
        if(!rows.length)return;
        const selected=dependencies.modelSettings.select('memory'),fingerprint=modelConfiguration(selected.id,selected.settings,dependencies.modelSettings.view().revision).fingerprint,inputs=new Set(window.ids);
        for(const row of rows){
          const job=JSON.parse(row.json) as {processor?:string;config?:{artifactId?:string;modelFingerprint?:string};artifactInputs?:{id:string;revision:string}[]};
          const artifactId=job.config?.artifactId,source=job.artifactInputs?.[0];
          if(job.processor!=='mote.segment-understanding'||!artifactId||!inputs.has(artifactId)||job.config?.modelFingerprint!==fingerprint||!source||source.id!==artifactId||dependencies.store.archive.revision(source.id)!==source.revision)continue;
          pipeline.engine.retry(row.id,true);
        }
      });
      void lifecycle.tick().catch(()=>{});return reply.code(202).send(result);
    });
    child.post('/api/memory-integrations',{bodyLimit:8192},async(req,reply)=>{
      try{const result=requestMemoryIntegration(req.body,{lifecycle:dependencies.lifecycle(),memories:dependencies.memories,pipeline:dependencies.pipeline()});dependencies.modelAuthorizationHost.control.manual('owner-integration:'+result.id,'manual',[],dependencies.availableModelConnections());void dependencies.lifecycle().tick().catch(()=>{});return reply.code(202).send(result);}
      catch(error){if(error instanceof MemoryIntegrationSelectionError)return reply.code(error.statusCode).send({error:error.code,message:error.message,requestId:req.id});throw error;}
    });
    child.post('/api/memory-integrations/:id/cancel',async req=>dependencies.lifecycle().cancel('consolidation',jobId(req.params)));
    child.post('/api/memory-integrations/:id/retry',async(req,reply)=>{const result=dependencies.lifecycle().retry('consolidation',jobId(req.params));void dependencies.lifecycle().tick().catch(()=>{});return reply.code(202).send(result);});
    child.get('/api/memory-jobs',async req=>dependencies.pipeline().page(z.object({
      limit:z.coerce.number().int().min(1).max(100).default(30),
      cursor:z.string().min(1).max(1000).optional(),
    }).strict().parse(req.query)));
    child.get('/api/memory-jobs/:id',async req=>dependencies.pipeline().get(jobId(req.params)));
    child.post('/api/memory-jobs',async(req,reply)=>{
      const pipeline=dependencies.pipeline();
      pipeline.assertNewManualWork();
      const scope=z.object({...scopeFields,contextTime:z.string().datetime({offset:true}).optional(),recipes:z.array(memoryStrategyRefSchema).min(1).max(10).optional(),modelProfileId:modelProfileIdSchema.optional(),evidenceIds:z.array(z.string().uuid()).min(1).max(20000).optional()}).strict().refine(validRange,{message:'Invalid time range'}).parse(req.body??{});
      const profile=dependencies.modelSettings.select('memory',scope.modelProfileId);
      const policy=new EvidenceExposurePolicy();
      const bindings=scope.recipes?.map(ref=>{try{return pipeline.strategies.resolve(ref).binding;}catch{throw new StoreError('Memory recipe is unavailable',409);}});
      const create=(ids:string[],manualPlans?:ManualMemoryInputPlanRequest[],selection?:unknown)=>dependencies.modelAuthorizationHost.manual('owner-memory:'+randomUUID(),dependencies.availableModelConnections(),async()=>{
        const job=pipeline.create({contextTime:scope.contextTime,recipes:scope.recipes,evidenceIds:ids,...(manualPlans?.length?{manualPlans}:{}),timeZone:scope.timeZone,batchCharacters:dependencies.lifecycle().settings().batchCharacters,modelProfileId:profile.id,modelOverride:scope.modelProfileId?undefined:dependencies.modelSettings.view().defaultModels?.memory});
        void pipeline.run(job.id).catch(()=>{});return reply.code(202).send({...job,...(selection?{selection}:{})});
      });
      if(bindings&&!scope.evidenceIds){
        const selected=dependencies.evidenceReader.memoryPlanSelection(scope,bindings,policy);
        if(!selected.evidenceIds.length&&!selected.manualPlans.length)throw new StoreError('No evidence in this range',409);
        return create(selected.evidenceIds,selected.manualPlans,{unavailable:selected.unavailable});
      }
      const requirements=bindings?.map(binding=>binding.requires);
      const selection=scope.evidenceIds?undefined:dependencies.evidenceReader.memorySelection(scope,undefined,new EvidenceExposurePolicy(),requirements);
      let ids=scope.evidenceIds??selection!.evidenceIds;
      if(!ids.length)throw new StoreError('No evidence in this range',409);
      ids=[...new Set(ids)];
      for(let offset=0;offset<ids.length;offset+=200){
        const selected=ids.slice(offset,offset+200),records=dependencies.memories.readEvidence(selected);
        if(selected.some(id=>!records.some(record=>record.id===id)))throw new StoreError('Selected evidence is missing',409);
        for(const record of records){const at=Date.parse(sourceContentTime(record));if((scope.deviceId&&record.deviceId!==scope.deviceId)||(scope.after&&at<Date.parse(scope.after))||(scope.before&&at>=Date.parse(scope.before)))throw new StoreError('Evidence is outside the selected range',409);}
      }
      // Typed originals have their text in separately archived transcript chunks.
      // Expand their preferred artifacts deterministically before creating batches.
      const expanded=new Set<string>();
      for(const id of ids){
        if(dependencies.store.db.prepare('SELECT 1 FROM file_versions WHERE capture_id=?').get(id)&&dependencies.store.evidence([id])[0]?.provenance?.document?.fileIndex?.mode!=='index'){
          if(!dependencies.store.db.prepare('SELECT 1 FROM file_heads WHERE capture_id=?').get(id))throw new StoreError('Selected file revision is superseded',409);
          for(let offset=0;;offset+=200){const chunks=dependencies.files.chunks(id,offset,200);for(const chunk of chunks)if(dependencies.files.isCurrentEvidence(chunk.id))expanded.add(chunk.id);if(expanded.size>20000)throw new StoreError('Choose a smaller range for memory extraction',413);if(chunks.length<200)break;}
        }else expanded.add(id);
        if(expanded.size>20000)throw new StoreError('Choose a smaller range for memory extraction',413);
      }
      ids=[...expanded];if(!ids.length)throw new StoreError('No processed evidence in this range',409);
      if(bindings){
        const selected=dependencies.evidenceReader.memoryPlanSelection(scope,bindings,policy,ids);
        if(!selected.evidenceIds.length&&!selected.manualPlans.length)throw new StoreError('No allowed evidence in this range',409);
        return create(selected.evidenceIds,selected.manualPlans,{unavailable:selected.unavailable});
      }
      return create(ids,undefined,selection?{waiting:selection.waiting,unavailable:selection.unavailable}:undefined);
    });
    child.post('/api/memory-jobs/:id/pause',async req=>dependencies.pipeline().pause(jobId(req.params)));
    child.post('/api/memory-jobs/:id/resume',async req=>{const pipeline=dependencies.pipeline(),id=jobId(req.params);pipeline.resume(id);return pipeline.get(id);});
    child.post('/api/memory-jobs/:id/cancel',async req=>dependencies.pipeline().cancel(jobId(req.params)));
    child.post('/api/memory-jobs/:id/retry',async(req,reply)=>{
      const pipeline=dependencies.pipeline(),id=jobId(req.params),operationId='memory:'+id,control=dependencies.modelAuthorizationHost.control;
      // This owner action covers only the selected job. Existing steps retain
      // their original authority; previously denied steps have none to resume.
      const accepted=control.manualCommand('owner-memory-retry:'+randomUUID(),[operationId],dependencies.availableModelConnections(),()=>{
        for(const row of dependencies.store.db.prepare("SELECT id FROM execution_steps WHERE operation_id=? AND (kind='memory.batch' OR kind LIKE 'memory.phase.%' OR kind='memory.input') AND state IN ('waiting','blocked','failed')").all(operationId)){
          const step=pipeline.engine.get(String(row.id));
          if(step&&!control.stepAuthority(step.id))control.bindCurrentStep(step);
        }
        return pipeline.acceptRetry(id,true);
      });
      void accepted.completion.catch(()=>{});return reply.code(202).send(accepted.job);
    });
  });
}
