import { AgentNotConfiguredError } from '@mote/agent';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FeatureServices } from '../feature-services.js';
import { modelProfileIdSchema } from '../model-settings.js';
import { scopeFields,validRange } from '../query-scope.js';
import { StoreError } from '../store.js';

/** insights: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{agent,isClosing,diagnostics,insight,insightRequestSchema,insightRuns,modelSettings,store}:Pick<FeatureServices,"agent"|"isClosing"|"diagnostics"|"insight"|"insightRequestSchema"|"insightRuns"|"modelSettings"|"store">){
app.post('/api/insight-runs',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async(req,reply)=>{
    const body=z.object({...scopeFields,modelProfileId:modelProfileIdSchema.optional(),prompt:z.string().trim().max(8000).optional(),requestId:z.string().uuid()}).strict().refine(validRange,{message:'Invalid time range'}).parse(req.body);
    const {requestId,...input}=body;
    if(!agent.configuredFor(modelSettings.select('insight',input.modelProfileId).id))throw new AgentNotConfiguredError();
    if(isClosing())throw new StoreError('Central node is shutting down',503);
    const run=insightRuns.start(requestId,input,(observe,signal,snapshot)=>diagnostics.run(requestId,()=>insight(input,observe,signal,'insight:'+requestId,snapshot)),{timeoutMs:modelSettings.select('insight',input.modelProfileId).settings.agentTimeoutMs});
    return reply.code(202).send(run);
  });
app.get('/api/insight-runs',async()=>({items:insightRuns.list()}));
app.get('/api/insight-runs/:id',async req=>insightRuns.detail(z.string().uuid().parse((req.params as {id:string}).id)));
app.post('/api/insights',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async req=>{const id=randomUUID(),input=insightRequestSchema.parse(req.body??{});return insightRuns.perform(id,input,(observe,signal,snapshot)=>insight(input,observe,signal,'insight:'+id,snapshot),{timeoutMs:modelSettings.select('insight',input.modelProfileId).settings.agentTimeoutMs});});
app.get('/api/insights',async()=>({items:store.insights()}));
}
