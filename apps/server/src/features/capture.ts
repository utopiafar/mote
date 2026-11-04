import {MaterialNoteDeletion} from '../material-note-deletion.js';
import {EvidenceDeletion} from '../evidence-deletion.js';
import type {ServerFeatureScope} from '../feature-host.js';
import { captureSchema,rangeSchema } from '@mote/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertExternalCaptures,assertCaptureAttachments } from '../capture-admission.js';
import { registerCaptureBrowser } from '../capture-browser.js';
import { safeError } from '../diagnostics.js';
import type { FeatureServices } from '../feature-services.js';
import { StoreError } from '../store.js';
import type {ServerFeatureAdapter} from './index.js';

/** capture: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{executor,maintenanceWorker,assertRequestActive,connections,credential,diagnostics,evidenceReader,files,ingress,parseCaptureBundle,store,materials}:Pick<FeatureServices,"executor"|"maintenanceWorker"|"assertRequestActive"|"connections"|"credential"|"diagnostics"|"evidenceReader"|"files"|"ingress"|"parseCaptureBundle"|"store"|"materials">,scope?:ServerFeatureScope){
 scope?.every(5000,()=>{if(!maintenanceWorker)store.archive.aggregate(1,Date.now()-15000);return executor.tick();});scope?.defer(()=>maintenanceWorker?.close());
const deletion=new EvidenceDeletion(store,files,new MaterialNoteDeletion(store,materials));
registerCaptureBrowser(app,{store,connections,credential,evidenceReader,deletion});
app.post('/api/captures',async(req,reply)=>{const input=captureSchema.parse(req.body),c=credential(req);assertExternalCaptures([input],!c);assertCaptureAttachments([input],files,c);if(c)connections.assertCapture(c,input);const result=await diagnostics.measure('ingest','capture',()=>ingress.capture(input,()=>{assertRequestActive(req);assertCaptureAttachments([input],files,c);if(c)connections.assertCapture(c,input);}),r=>({count:r.duplicate?0:1}));return reply.code(result.duplicate?200:201).send(result);});
app.post('/api/captures/bundle',{bodyLimit:12*1024*1024},async req=>{
    const captures=parseCaptureBundle(req.body);assertExternalCaptures(captures,!credential(req));
    if(new Set(captures.map(c=>c.id)).size!==captures.length)throw new StoreError('Duplicate IDs in bundle');
    const c=credential(req);
    assertCaptureAttachments(captures,files,c);
    if(c)for(const input of captures)connections.assertCapture(c,input);
    const committed=await ingress.captureSettled(captures,()=>{assertRequestActive(req);assertCaptureAttachments(captures,files,c);if(c)for(const input of captures)connections.assertCapture(c,input);});
    return {results:committed.map(item=>{if(item.result)return {...item.result,status:item.result.duplicate?200:201};const failure=safeError(item.error);return {id:item.id,status:failure.status,error:failure.category};})};
  });
app.post('/api/captures/batch',{bodyLimit:12*1024*1024},async req=>{
    const {captures}=z.object({captures:z.array(captureSchema).min(1).max(25)}).strict().parse(req.body);assertExternalCaptures(captures,!credential(req));
    if(new Set(captures.map(c=>c.id)).size!==captures.length)throw new StoreError('Duplicate IDs in batch');
    const c=credential(req);
    assertCaptureAttachments(captures,files,c);
    if(c)for(const input of captures)connections.assertCapture(c,input);
    const committed=await ingress.captureSettled(captures,()=>{assertRequestActive(req);assertCaptureAttachments(captures,files,c);if(c)for(const input of captures)connections.assertCapture(c,input);});
    return {results:committed.map(item=>{if(item.result)return {...item.result,status:item.result.duplicate?200:201};const failure=safeError(item.error);return {id:item.id,status:failure.status,error:failure.category};})};
  });
app.get('/api/captures',async req=>{
    const raw=req.query as Record<string,string>;const args=rangeSchema.parse(raw);
    return diagnostics.measure('source','timeline',()=>store.list({...args,cursor:raw.cursor}),page=>({count:page.items.length}));
  });
app.delete('/api/captures/:id',async req=>deletion.delete((req.params as {id:string}).id));
app.get('/api/activity',async req=>store.activity(rangeSchema.parse(req.query)));
}

export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.capture',version:'1',surface:'data',runtime:'host'},
  factory:(app,scope,services)=>{
    scope.retire(()=>services.agentFeatures.dispose('mote.capture'));
    register(app,services,scope);
  },
};
