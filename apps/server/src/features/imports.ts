import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { navigationScopeSchema } from '../context-navigation.js';
import type { FeatureServices } from '../feature-services.js';
import { registerImportUploads } from '../import-uploads.js';
import { StoreError } from '../store.js';

/** imports: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{archivedFiles,config,evidenceReader,importTasks,imports,jobId,launchImport,store}:Pick<FeatureServices,"archivedFiles"|"config"|"evidenceReader"|"importTasks"|"imports"|"jobId"|"launchImport"|"store">){
registerImportUploads(app,store,archivedFiles);
app.get('/api/imports',async()=>({items:imports.list()}));
app.get('/api/import-source-packs',async()=>({items:(config.importPythonPacks??[]).map(({id,version,description})=>({id,version,...(description?{description}:{})}))}));
app.post('/api/imports',{bodyLimit:360*1024*1024,config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(req,reply)=>{const job=await imports.create(req.body);if(job.status==='queued')launchImport(job.id,()=>imports.prepare(job.id));return reply.code(202).send(imports.get(job.id));});
app.get('/api/imports/:id',async req=>imports.get(jobId(req.params)));
app.delete('/api/imports/:id',async req=>{const id=jobId(req.params);if(importTasks.has(id))throw new StoreError('Import is already processing',409);return imports.delete(id);});
app.post('/api/imports/:id/prepare',async(req,reply)=>{const id=jobId(req.params),body=z.object({instruction:z.string().max(12000).optional()}).strict().parse(req.body??{});if(importTasks.has(id))return reply.code(202).send(imports.get(id));if(body.instruction!==undefined)imports.updateInstruction(id,body.instruction);imports.get(id);launchImport(id,()=>imports.prepare(id));return reply.code(202).send(imports.get(id));});
app.post('/api/imports/:id/confirm',async(req,reply)=>{const id=jobId(req.params),job=imports.get(id);if(job.status!=='awaiting_confirmation'&&job.status!=='completed')throw new StoreError('Review an import preview before confirming',409);launchImport(id,()=>imports.confirm(id));return reply.code(202).send(imports.get(id));});
app.post('/api/imports/:id/retry',async(req,reply)=>{const id=jobId(req.params);imports.get(id);launchImport(id,()=>imports.retry(id));return reply.code(202).send(imports.get(id));});
app.get('/api/archived-files/:id',async req=>archivedFiles.get(jobId(req.params)));
app.get('/api/archived-files/:id/content',async(req,reply)=>{const id=jobId(req.params),file=archivedFiles.get(id);return reply.type('application/octet-stream').header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g,'%27')}`).header('Content-Security-Policy',"default-src 'none'; sandbox").send(archivedFiles.stream(id));});
app.get('/api/captures/:id/archived-files',async req=>{const record=evidenceReader.evidence([(req.params as {id:string}).id],navigationScopeSchema.parse(req.query))[0];if(!record)throw new StoreError('Capture not found',404);return {items:archivedFiles.listForCapture(record.id)};});
}
