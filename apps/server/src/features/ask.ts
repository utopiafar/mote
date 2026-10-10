import { AgentNotConfiguredError } from '@mote/agent';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FeatureServices } from '../feature-services.js';
import type {ServerFeatureScope} from '../feature-host.js';

/** ask: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{agent,conversations,modelSettings,queryRuns,queryWithAttachmentsSchema}:Pick<FeatureServices,"agent"|"conversations"|"modelSettings"|"queryRuns"|"queryWithAttachmentsSchema">,scope?:ServerFeatureScope){
scope?.defer(()=>queryRuns.stop());
app.get('/api/conversations',async req=>conversations.list(z.object({limit:z.coerce.number().int().min(1).max(100).default(50),cursor:z.string().max(1000).optional()}).strict().parse(req.query)));
app.get('/api/conversations/:id',async req=>conversations.page(z.object({id:z.string().uuid()}).parse(req.params).id,z.object({limit:z.coerce.number().int().min(1).max(50).default(20),cursor:z.string().optional()}).parse(req.query)));
app.delete('/api/conversations/:id',async req=>conversations.delete(z.object({id:z.string().uuid()}).parse(req.params).id));
app.post('/api/query',async req=>{if(!agent.configured)throw new AgentNotConfiguredError();const id=randomUUID(),input=queryWithAttachmentsSchema.parse(req.body);return queryRuns.perform(id,input,{timeoutMs:modelSettings.select('chat',input.modelProfileId).settings.agentTimeoutMs});});
app.post('/api/query-runs/:id/cancel',async req=>queryRuns.cancel(z.object({id:z.string().uuid()}).parse(req.params).id));
app.get('/api/query-runs',async()=>({items:queryRuns.list()}));
app.get('/api/query-runs/:id',async req=>queryRuns.get(z.object({id:z.string().uuid()}).parse(req.params).id));
app.post('/api/query-runs',async(req,reply)=>{
    const {id,input}=z.object({id:z.string().uuid(),input:queryWithAttachmentsSchema}).strict().parse(req.body);
    if(!agent.configured)throw new AgentNotConfiguredError();
    return reply.code(202).send(queryRuns.start(id,input,{timeoutMs:modelSettings.select('chat',input.modelProfileId).settings.agentTimeoutMs}));
  });
}
