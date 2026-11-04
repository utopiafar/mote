import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {ProcessingServicesDependencies,ProcessingServicesPort} from '../../plugins/processing-services.js';

export interface ProcessingJobRouteDependencies {
  readonly store:ProcessingServicesDependencies['store'];
  readonly processing:()=>ProcessingServicesPort;
  readonly semanticFingerprint:()=>string;
}

/** C17 job submission and receipts. The contribution resolves the current
 * plugin activation per request, so a stopped owner answers 503 without
 * installing a second route table. */
export function registerProcessingJobRoutes(app:FastifyInstance,{store,processing,semanticFingerprint}:ProcessingJobRouteDependencies){
  app.get('/api/processing',async req=>{
    const query=z.object({state:z.enum(['waiting','running','blocked','failed','cancelled','succeeded','stale']).optional(),cursor:z.coerce.number().int().positive().optional(),limit:z.coerce.number().int().min(1).max(100).optional()}).strict().parse(req.query);
    return {archive:store.archive.stats(),...processing().view(query)};
  });
  app.put('/api/processing/settings',async req=>processing().save(req.body));
  app.post('/api/processing/workflows',async(req,reply)=>{
    const {steps}=z.object({steps:z.array(z.any()).min(1).max(32)}).strict().parse(req.body);
    return reply.code(202).send(processing().enqueue(steps.map(step=>step.processor==='mote.segment-understanding'
      ?{...step,artifactInputs:[{id:step.config?.artifactId,revision:store.archive.get(step.config?.artifactId)?.revision}],config:{...step.config,modelFingerprint:semanticFingerprint()}}
      :step)));
  });
  app.post('/api/processing/:id/retry',async req=>{processing().retry((req.params as {id:string}).id);return {queued:true};});
  app.post('/api/processing/:id/cancel',async req=>{processing().cancel((req.params as {id:string}).id);return {cancelled:true};});
}
