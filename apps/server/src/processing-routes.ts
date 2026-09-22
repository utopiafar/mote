import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {Store} from './store.js';
import type {ProcessingRuntime} from './processing-runtime.js';
import type {Perception} from './perception.js';
/** Routes admit work; the shared execution engine remains the only executor. */
export function registerProcessingRoutes(app:FastifyInstance,{store,workflows,perception,semanticFingerprint}:{store:Store;workflows:ProcessingRuntime;perception:Perception;semanticFingerprint:()=>string}){
  app.get('/api/processing',async req=>{const q=z.object({state:z.enum(['waiting','running','blocked','failed','cancelled','succeeded','stale']).optional(),cursor:z.coerce.number().int().positive().optional(),limit:z.coerce.number().int().min(1).max(100).optional()}).strict().parse(req.query);return {archive:store.archive.stats(),...workflows.view(q)};});
  app.put('/api/processing/settings',async req=>workflows.configure(req.body));
  app.post('/api/processing/workflows',async(req,reply)=>{const {steps}=z.object({steps:z.array(z.any()).min(1).max(32)}).strict().parse(req.body);return reply.code(202).send(workflows.enqueue(steps.map(step=>step.processor==='mote.segment-understanding'?{...step,artifactInputs:[{id:step.config?.artifactId,revision:store.archive.get(step.config?.artifactId)?.revision}],config:{...step.config,modelFingerprint:semanticFingerprint()}}:step)));});
  app.post('/api/processing/:id/retry',async req=>{workflows.retry((req.params as {id:string}).id);return {queued:true};});
  app.post('/api/processing/:id/cancel',async req=>{workflows.cancel((req.params as {id:string}).id);return {cancelled:true};});
  app.get('/api/perception',async()=>perception.view());
  app.put('/api/perception',async req=>perception.configure(req.body));
  app.post('/api/perception/:id/retry',async req=>{const {id}=z.object({id:z.string().uuid()}).parse(req.params);const {kind}=z.object({kind:z.enum(['ocr','semantic'])}).parse(req.body);return perception.retry(id,kind);});
}
