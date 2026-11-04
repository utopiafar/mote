import {evidenceDeletionForAssembly} from '../plugins/evidence-deletion.js';
import {captureSchema,rangeSchema} from '@mote/shared';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {assertExternalCaptures,assertCaptureAttachments} from '../capture-admission.js';
import {registerCaptureBrowser} from '../capture-browser.js';
import {safeError,type ServerDiagnostics} from '../diagnostics.js';
import type {EvidenceReader} from '../evidence-reader.js';
import type {FileStore} from '../files.js';
import type {ConnectionCredential,Connections} from '../connections.js';
import type {IngressService} from '../ingress.js';
import {StoreError,type Store} from '../store.js';
import {parseCaptureBundle} from '../plugins/capture-intake.js';
import type {FeatureRoute} from './index.js';

export interface CaptureFeatureDependencies {
  readonly store:Store;
  readonly connections:Connections;
  readonly credential:(request:FastifyRequest)=>ConnectionCredential|undefined;
  readonly assertRequestActive:(request:FastifyRequest)=>void;
  readonly diagnostics:ServerDiagnostics;
  readonly evidenceReader:EvidenceReader;
  readonly files:FileStore;
  readonly ingress:IngressService;
}

/** capture: owns its transport, data and command contributions. */
export function captureFeature(dependencies:CaptureFeatureDependencies):FeatureRoute {
  const {assertRequestActive,connections,credential,diagnostics,evidenceReader,files,ingress,store}=dependencies;
  return Object.freeze({id:'mote.capture',mount(app:FastifyInstance){
    const deletion={capability:(id:string)=>evidenceDeletionForAssembly(store).capability(id),delete:(id:string)=>evidenceDeletionForAssembly(store).delete(id)};
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
  }});
}
