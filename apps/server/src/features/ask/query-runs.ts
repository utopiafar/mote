import {AgentNotConfiguredError} from '@mote/agent';
import type {FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {agentModelConnection} from '../../model-authorization-host.js';
import type {ModelConnection} from '../../background-model-authorization.js';
import type {ModelAuthorizationHost} from '../../model-authorization-host.js';
import type {ModelSettingsStore} from '../../model-settings.js';
import type {ReloadableAgent} from '../../model-agent.js';
import {queryWithAttachmentsSchema} from '../../query-request.js';
import type {QueryRunsPort} from '../../plugins/query-runs.js';

export interface QueryRunRouteDependencies {
  readonly queryRuns:()=>QueryRunsPort;
  readonly modelAuthorizationHost:Pick<ModelAuthorizationHost,'manual'>;
  readonly availableModelConnections:()=>ModelConnection[];
  readonly modelSettings:Pick<ModelSettingsStore,'select'>;
  readonly agent:Pick<ReloadableAgent,'configured'>;
}

/** Ask command receipts dispatch through the current plugin activation; a
 * stopped activation answers 503 without remounting this table. */
export function registerQueryRunRoutes(app:FastifyInstance,dependencies:QueryRunRouteDependencies){
  const queryRuns=()=>dependencies.queryRuns();
  // A one-turn model choice is explicit owner intent. Snapshot its exact resolved
  // connection as well as the defaults; never add it to background approval.
  const queryConnections=(input:{modelProfileId?:string;modelOverride?:string})=>{
    const profile=dependencies.modelSettings.select('chat',input.modelProfileId);
    return [...dependencies.availableModelConnections(),agentModelConnection({kind:'profile',id:profile.id},{...profile.settings,model:input.modelOverride??profile.settings.model})];
  };
  app.post('/api/query',async req=>{if(!dependencies.agent.configured)throw new AgentNotConfiguredError();const id=randomUUID(),input=queryWithAttachmentsSchema.parse(req.body);return dependencies.modelAuthorizationHost.manual('owner-query:'+id,queryConnections(input),()=>queryRuns().perform(id,input));});
  app.post('/api/query-runs/:id/cancel',async req=>queryRuns().cancel(z.object({id:z.string().uuid()}).parse(req.params).id));
  app.get('/api/query-runs',async()=>({items:queryRuns().list()}));
  app.get('/api/query-runs/:id',async req=>queryRuns().get(z.object({id:z.string().uuid()}).parse(req.params).id));
  app.post('/api/query-runs',async(req,reply)=>{
    const {id,input}=z.object({id:z.string().uuid(),input:queryWithAttachmentsSchema}).strict().parse(req.body);
    if(!dependencies.agent.configured)throw new AgentNotConfiguredError();
    return dependencies.modelAuthorizationHost.manual('owner-query:'+id,queryConnections(input),async()=>reply.code(202).send(queryRuns().start(id,input)));
  });
}
