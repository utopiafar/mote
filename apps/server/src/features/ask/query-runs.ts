import {AgentNotConfiguredError} from '@mote/agent';
import type {FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {conversationMessageInputSchema} from '@mote/shared';
import {StoreError} from '../../store.js';
import {agentModelConnection} from '../../model-authorization-host.js';
import type {ModelConnection} from '../../background-model-authorization.js';
import type {ModelAuthorizationHost} from '../../model-authorization-host.js';
import type {ModelSettingsStore} from '../../model-settings.js';
import type {AgentRuntimeRegistry} from '../../agent-runtime-registry.js';
import {queryWithAttachmentsSchema} from '../../query-request.js';
import type {QueryRunsPort} from '../../plugins/query-runs.js';
import type {ConversationQueue} from '../../conversation-queue.js';
import type {ConversationRepository} from '../../plugins/central-contracts.js';

export interface QueryRunRouteDependencies {
  readonly queryRuns:()=>QueryRunsPort;
  readonly modelAuthorizationHost:Pick<ModelAuthorizationHost,'manual'>;
  readonly availableModelConnections:()=>ModelConnection[];
  readonly modelSettings:Pick<ModelSettingsStore,'select'>;
  readonly agent:Pick<AgentRuntimeRegistry,'configured'>;
  readonly conversations:Pick<ConversationRepository,'main'|'hasMessage'>;
  readonly conversationQueue:()=>ConversationQueue;
}

/** Ask command receipts dispatch through the current plugin activation; a
 * stopped activation answers 503 without remounting this table. */
export function registerQueryRunRoutes(app:FastifyInstance,dependencies:QueryRunRouteDependencies){
  const queryRuns=()=>dependencies.queryRuns();
  const queue=()=>dependencies.conversationQueue();
  // A one-turn model choice is explicit owner intent. Snapshot its exact resolved
  // connection as well as the defaults; never add it to background approval.
  const queryConnections=(input:{modelProfileId?:string;modelOverride?:string})=>{
    const profile=dependencies.modelSettings.select('chat',input.modelProfileId);
    return [...dependencies.availableModelConnections(),agentModelConnection({kind:'profile',id:profile.id},{...profile.settings,model:input.modelOverride??profile.settings.model})];
  };
  app.post('/api/query',async req=>{if(!dependencies.agent.configured)throw new AgentNotConfiguredError();const id=randomUUID(),requested=queryWithAttachmentsSchema.parse(req.body),input={...requested,conversationId:requested.conversationId??dependencies.conversations.main().id};return dependencies.modelAuthorizationHost.manual('owner-query:'+id,queryConnections(input),()=>queryRuns().perform(id,input));});
  app.post('/api/query-runs/:id/cancel',async req=>queryRuns().cancel(z.object({id:z.string().uuid()}).parse(req.params).id));
  app.get('/api/query-runs',async()=>({items:queryRuns().list()}));
  app.get('/api/query-runs/:id',async req=>queryRuns().get(z.object({id:z.string().uuid()}).parse(req.params).id));
  app.post('/api/query-runs',async(req,reply)=>{
    const {id,input:requested}=z.object({id:z.string().uuid(),input:queryWithAttachmentsSchema}).strict().parse(req.body);
    if(dependencies.conversations.hasMessage(id))throw new StoreError('Run ID belongs to a conversation message',409);
    if(!dependencies.agent.configured)throw new AgentNotConfiguredError();
    // Resolve the default once per receipt: a retry must still target the
    // original conversation if the owner has since chosen another main.
    let conversationId=requested.conversationId;
    if(!conversationId){
      try{conversationId=queryRuns().get(id).conversationId;}catch(error){if(!(error instanceof StoreError)||error.statusCode!==404)throw error;}
      conversationId??=dependencies.conversations.main().id;
    }
    const input={...requested,conversationId};
    return dependencies.modelAuthorizationHost.manual('owner-query:'+id,queryConnections(input),async()=>reply.code(202).send(queryRuns().start(id,input)));
  });
  app.get('/api/conversations/main',async()=>dependencies.conversations.main());
  app.post('/api/conversations/messages',async(req,reply)=>reply.code(202).send(queue().admit(conversationMessageInputSchema.parse(req.body))));
  app.get('/api/conversations/:id/messages/:messageId',async req=>{const params=z.object({id:z.string().uuid(),messageId:z.string().uuid()}).parse(req.params);return queue().get(params.id,params.messageId);});
  app.post('/api/conversations/:id/messages/:messageId/cancel',async req=>{const params=z.object({id:z.string().uuid(),messageId:z.string().uuid()}).parse(req.params);return queue().cancel(params.id,params.messageId);});
}
