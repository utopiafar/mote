import {formatEvidenceRef} from '@mote/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { navigationScopeSchema } from '../context-navigation.js';
import type { FeatureServices } from '../feature-services.js';
import { registerImportUploads } from '../import-uploads.js';
import { ImportInputError } from '../imports.js';
import { StoreError } from '../store.js';
import type {ServerFeatureScope} from '../feature-host.js';

/** imports: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{archivedFiles,config,evidenceReader,importTasks,imports,jobId,launchImport,store}:Pick<FeatureServices,"archivedFiles"|"config"|"evidenceReader"|"importTasks"|"imports"|"jobId"|"launchImport"|"store">,scope?:ServerFeatureScope){
scope?.defer(()=>imports.stop());
const uploads=registerImportUploads(app,store,archivedFiles);scope?.defer(()=>uploads.close());
app.get('/api/import-capabilities',async()=>imports.intake.list());
app.get('/api/imports',async()=>({items:imports.list()}));
app.get('/api/import-source-packs',async()=>({items:(config.importPythonPacks??[]).map(({id,version,description})=>({id,version,...(description?{description}:{})}))}));
app.post('/api/imports',{bodyLimit:360*1024*1024,config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(req,reply)=>{
  try{const job=await imports.create(req.body);if(job.status==='queued')launchImport(job.id,()=>imports.prepare(job.id));return reply.code(202).send(imports.get(job.id));}
  catch(error){if(error instanceof ImportInputError)return reply.code(error.statusCode).send({error:error.code,message:error.message,requestId:req.id});throw error;}
});
app.post('/api/imports/:id/cancel',async req=>imports.cancel(jobId(req.params)));
app.get('/api/imports/:id',async req=>imports.get(jobId(req.params)));
app.delete('/api/imports/:id',async req=>{const id=jobId(req.params);if(importTasks.has(id))throw new StoreError('Import is already processing',409);return imports.delete(id);});
app.post('/api/imports/:id/prepare',async(req,reply)=>{const id=jobId(req.params),body=z.object({instruction:z.string().max(12000).optional()}).strict().parse(req.body??{});if(importTasks.has(id))return reply.code(202).send(imports.get(id));if(body.instruction!==undefined)imports.updateInstruction(id,body.instruction);imports.get(id);launchImport(id,()=>imports.prepare(id));return reply.code(202).send(imports.get(id));});
app.post('/api/imports/:id/confirm',async(req,reply)=>{
  const id=jobId(req.params);let job=imports.get(id);
  if(job.status==='completed'||job.status==='importing')return reply.code(202).send(job);
  if(job.status!=='awaiting_confirmation')throw new StoreError('Review an import preview before confirming',409);
  // A preview can be visible before its prepare task finishes orchestration cleanup.
  // Do not acknowledge a confirmation that launchImport would silently discard.
  const previewIdentity=imports.confirmationIdentity(id);
  const finishing=()=>reply.code(409).send({error:'import_finishing',message:'Parsing is finishing. Please confirm again shortly.',requestId:req.id});
  const preparing=importTasks.get(id);
  if(preparing){
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{const finished=await Promise.race([preparing.then(()=>true),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),1000);})]);if(!finished)return finishing();}
    finally{if(timer)clearTimeout(timer);}
  }
  job=imports.get(id);
  if(imports.confirmationIdentity(id)!==previewIdentity)throw new StoreError('The preview changed; review it before confirming',409);
  if(job.status==='completed'||job.status==='importing')return reply.code(202).send(job);
  if(job.status!=='awaiting_confirmation')throw new StoreError('Review an import preview before confirming',409);
  if(imports.hasActiveWorker(id))return finishing();
  launchImport(id,()=>imports.confirm(id));return reply.code(202).send(imports.get(id));
});
app.post('/api/imports/:id/retry',async(req,reply)=>{const id=jobId(req.params);imports.get(id);if(importTasks.has(id)||imports.hasActiveWorker(id))return reply.code(409).send({error:'import_stopping',message:'Import processing is still stopping. Retry shortly.',requestId:req.id});launchImport(id,()=>imports.retry(id));return reply.code(202).send(imports.get(id));});
app.get('/api/archived-files/:id',async req=>archivedFiles.get(jobId(req.params)));
app.get('/api/archived-files/:id/content',async(req,reply)=>{const id=jobId(req.params),file=archivedFiles.get(id);return reply.type('application/octet-stream').header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g,'%27')}`).header('Content-Security-Policy',"default-src 'none'; sandbox").send(archivedFiles.stream(id));});
app.get('/api/captures/:id/archived-files',async req=>{const record=evidenceReader.evidence([formatEvidenceRef('capture',z.string().uuid().parse((req.params as {id:string}).id))],navigationScopeSchema.parse(req.query))[0];if(!record)throw new StoreError('Capture not found',404);return {items:archivedFiles.listForCapture(record.id)};});
}
