import type {ServerFeatureScope} from '../feature-host.js';
import { captureSchema,rangeSchema } from '@mote/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertExternalCaptures } from '../capture-admission.js';
import { registerCaptureBrowser } from '../capture-browser.js';
import { safeError } from '../diagnostics.js';
import type { FeatureServices } from '../feature-services.js';
import { StoreError } from '../store.js';

/** capture: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{perception,executor,maintenanceWorker,connections,credential,diagnostics,evidenceReader,files,ingress,parseCaptureBundle,store}:Pick<FeatureServices,"perception"|"executor"|"maintenanceWorker"|"connections"|"credential"|"diagnostics"|"evidenceReader"|"files"|"ingress"|"parseCaptureBundle"|"store">,scope?:ServerFeatureScope){
 scope?.every(5000,()=>{if(!maintenanceWorker)store.archive.aggregate(1,Date.now()-15000);perception.prepare();return executor.tick();});scope?.defer(()=>perception.close());scope?.defer(()=>maintenanceWorker?.close());
registerCaptureBrowser(app,{store,connections,credential,evidenceReader});
app.post('/api/captures',async(req,reply)=>{const input=captureSchema.parse(req.body),c=credential(req);assertExternalCaptures([input]);if(c)connections.assertCapture(c,input);const result=await diagnostics.measure('ingest','capture',()=>ingress.capture(input,c?()=>connections.assertCapture(c,input):undefined),r=>({count:r.duplicate?0:1}));return reply.code(result.duplicate?200:201).send(result);});
app.post('/api/captures/bundle',{bodyLimit:12*1024*1024},async req=>{
    const captures=parseCaptureBundle(req.body);assertExternalCaptures(captures);
    if(new Set(captures.map(c=>c.id)).size!==captures.length)throw new StoreError('Duplicate IDs in bundle');
    const c=credential(req);
    if(c)for(const input of captures)connections.assertCapture(c,input);
    const committed=await ingress.captureSettled(captures,c?()=>{for(const input of captures)connections.assertCapture(c,input);}:undefined);
    return {results:committed.map(item=>{if(item.result)return {...item.result,status:item.result.duplicate?200:201};const failure=safeError(item.error);return {id:item.id,status:failure.status,error:failure.category};})};
  });
app.post('/api/captures/batch',{bodyLimit:12*1024*1024},async req=>{
    const {captures}=z.object({captures:z.array(captureSchema).min(1).max(25)}).strict().parse(req.body);assertExternalCaptures(captures);
    if(new Set(captures.map(c=>c.id)).size!==captures.length)throw new StoreError('Duplicate IDs in batch');
    const c=credential(req);
    if(c)for(const input of captures)connections.assertCapture(c,input);
    const committed=await ingress.captureSettled(captures,c?()=>{for(const input of captures)connections.assertCapture(c,input);}:undefined);
    return {results:committed.map(item=>{if(item.result)return {...item.result,status:item.result.duplicate?200:201};const failure=safeError(item.error);return {id:item.id,status:failure.status,error:failure.category};})};
  });
app.get('/api/captures',async req=>{
    const raw=req.query as Record<string,string>;const args=rangeSchema.parse(raw);
    return diagnostics.measure('source','timeline',()=>store.list({...args,cursor:raw.cursor}),page=>({count:page.items.length}));
  });
app.delete('/api/captures/:id',async req=>{const id=(req.params as {id:string}).id;const file=store.db.prepare('SELECT capture_id FROM file_versions WHERE capture_id=? UNION SELECT capture_id FROM file_chunks WHERE id=? LIMIT 1').get(id,id) as {capture_id:string}|undefined;return file?files.forget(file.capture_id):store.delete(id);});
app.get('/api/activity',async req=>store.activity(rangeSchema.parse(req.query)));
}
