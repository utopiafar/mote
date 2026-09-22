import type {FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {sourceContentTime,type QueryResult} from '@mote/shared';
import type {QueryInput} from '@mote/agent';
import {scopeFields,validRange} from './query-scope.js';
import {modelProfileIdSchema,type ModelSettingsStore} from './model-settings.js';
import {MemoryOutputValidationError,MEMORY_EXTRACTION_PROMPT,type MemoryStore} from './memory.js';
import {memoryReviewReceipt} from './memory-review.js';
import type {MemoryPipeline} from './memory-pipeline.js';
import type {MemoryLifecycle} from './memory-lifecycle.js';
import type {FileStore} from './files.js';
import {StoreError,type Store} from './store.js';
export function registerMemoryRoutes(app:FastifyInstance,{store,files,memories,memoryPipeline,lifecycle,modelSettings,query,reviewExtraction}:{store:Store;files:FileStore;memories:MemoryStore;memoryPipeline:MemoryPipeline;lifecycle:MemoryLifecycle;modelSettings:ModelSettingsStore;query:(input:QueryInput)=>Promise<QueryResult>;reviewExtraction:(input:QueryInput,result:QueryResult)=>Promise<QueryResult>}){
 const jobId=(params:unknown)=>z.object({id:z.string().uuid()}).parse(params).id;
  app.post('/api/memories/:id/publish',async req=>{const body=z.object({version:z.number().int().positive().optional()}).strict().parse(req.body??{});return memories.publish((req.params as {id:string}).id,body.version);});
  app.post('/api/memories/:id/correct',async req=>memories.correct((req.params as {id:string}).id,req.body));
  app.delete('/api/memories/:id',async req=>memories.delete((req.params as {id:string}).id));
  app.get('/api/memory-settings',async()=>{const view=lifecycle.view();return {...view,extensions:view.extensions.map(extension=>({...extension,status:extension.retryAt&&extension.retryAt>Date.now()?'retry_wait':extension.id==='extraction'&&extension.active?.checkpoint?memoryPipeline.get(extension.active.checkpoint).status:extension.status}))};});
  app.put('/api/memory-settings',{bodyLimit:8192},async req=>lifecycle.configure(req.body));
  app.get('/api/memory-jobs',async()=>({items:memoryPipeline.list()}));
  app.get('/api/memory-jobs/:id',async req=>memoryPipeline.get(jobId(req.params)));
  app.post('/api/memory-jobs',async(req,reply)=>{
    const scope=z.object({...scopeFields,modelProfileId:modelProfileIdSchema.optional(),evidenceIds:z.array(z.string().uuid()).min(1).max(20000).optional()}).strict().refine(validRange,{message:'Invalid time range'}).parse(req.body??{});
    const profile=modelSettings.select('memory',scope.modelProfileId);
    let ids=scope.evidenceIds;
    if(!ids){ids=[];let cursor:string|undefined;do{const page=store.list({...scope,limit:200,cursor});ids.push(...page.items.map(record=>record.id));cursor=page.nextCursor??undefined;if(ids.length>20000)throw new StoreError('Choose a smaller range for memory extraction',413);}while(cursor);}
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
    const job=memoryPipeline.create({evidenceIds:ids,timeZone:scope.timeZone,modelProfileId:profile.id,modelOverride:scope.modelProfileId?undefined:modelSettings.view().defaultModels?.memory});void memoryPipeline.run(job.id).catch(()=>{});return reply.code(202).send(job);
  });
  app.post('/api/memory-jobs/:id/pause',async req=>memoryPipeline.pause(jobId(req.params)));
  app.post('/api/memory-jobs/:id/resume',async req=>{const id=jobId(req.params);memoryPipeline.resume(id);return memoryPipeline.get(id);});
  app.post('/api/memory-jobs/:id/cancel',async req=>memoryPipeline.cancel(jobId(req.params)));
  app.post('/api/memory-jobs/:id/retry',async(req,reply)=>{const id=jobId(req.params);memoryPipeline.get(id);void memoryPipeline.retry(id).catch(()=>{});return reply.code(202).send(memoryPipeline.get(id));});
  app.post('/api/memories/extract',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async req=>{
    const {modelProfileId,...scope}=z.object({...scopeFields,modelProfileId:modelProfileIdSchema.optional()}).strict().refine(validRange).parse(req.body??{}),profile=modelSettings.select('memory',modelProfileId);
    const input:QueryInput={...scope,modelProfileId:profile.id,modelOverride:profile.settings.model,skill:'memory-extraction',responseMode:'memory-extraction',question:MEMORY_EXTRACTION_PROMPT};
    input.validateOutput=result=>{try{memories.extract(result,profile.settings.model,{requireAdmission:true,validateOnly:true});}catch(error){if(!(error instanceof MemoryOutputValidationError))throw error;return {code:error.code,feedback:error.repairInstruction};}};
    const draft=await query(input);
    memories.extract(draft,profile.settings.model,{requireAdmission:true,validateOnly:true});
    const result=await reviewExtraction(input,draft);
    return memories.extract(result,profile.settings.model,{requireAdmission:true,reviewRunId:memoryReviewReceipt(result)?.reviewRunId,reviewReceipt:memoryReviewReceipt(result)});
  });
}
