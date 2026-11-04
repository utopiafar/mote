import { AgentNotConfiguredError } from '@mote/agent';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import {agentModelConnection} from '../model-authorization-host.js';
import { z } from 'zod';
import type { FeatureServices } from '../feature-services.js';
import type {ServerFeatureScope} from '../feature-host.js';
import type {ServerFeatureAdapter} from './index.js';

/** ask: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{modelAuthorizationHost,availableModelConnections,modelSettings,agent,queryRuns,queryWithAttachmentsSchema}:Pick<FeatureServices,'modelAuthorizationHost'|'availableModelConnections'|'modelSettings'|"agent"|"queryRuns"|"queryWithAttachmentsSchema">,scope?:ServerFeatureScope){
scope?.defer(()=>queryRuns.stop());
// A one-turn model choice is explicit owner intent. Snapshot its exact resolved
// connection as well as the defaults; never add it to background approval.
const queryConnections=(input:{modelProfileId?:string;modelOverride?:string})=>{
  const profile=modelSettings.select('chat',input.modelProfileId);
  return [...availableModelConnections(),agentModelConnection({kind:'profile',id:profile.id},{...profile.settings,model:input.modelOverride??profile.settings.model})];
};
app.post('/api/query',async req=>{if(!agent.configured)throw new AgentNotConfiguredError();const id=randomUUID(),input=queryWithAttachmentsSchema.parse(req.body);return modelAuthorizationHost.manual('owner-query:'+id,queryConnections(input),()=>queryRuns.perform(id,input));});
app.post('/api/query-runs/:id/cancel',async req=>queryRuns.cancel(z.object({id:z.string().uuid()}).parse(req.params).id));
app.get('/api/query-runs',async()=>({items:queryRuns.list()}));
app.get('/api/query-runs/:id',async req=>queryRuns.get(z.object({id:z.string().uuid()}).parse(req.params).id));
app.post('/api/query-runs',async(req,reply)=>{
    const {id,input}=z.object({id:z.string().uuid(),input:queryWithAttachmentsSchema}).strict().parse(req.body);
    if(!agent.configured)throw new AgentNotConfiguredError();
    return modelAuthorizationHost.manual('owner-query:'+id,queryConnections(input),async()=>reply.code(202).send(queryRuns.start(id,input)));
  });
}

export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.ask',version:'1',surface:'data',runtime:'host'},
  factory:(app,scope,services,host)=>{
    scope.retire(()=>services.agentFeatures.dispose('mote.ask'));
    host.mountDomainRoutes('mote.ask',app);
    register(app,services,scope);
  },
};
