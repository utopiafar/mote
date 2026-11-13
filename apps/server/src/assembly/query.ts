import {randomUUID} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Context} from '@deepseek-ai/cordis';
import type {bootstrapCentral,CentralDomainPlugin} from '../bootstrap.js';
import {centralServices} from '../plugins/central-contracts.js';
import {contributeDomainRoutes} from '../plugins/domain-routes.js';
import {createConversations,createConversationsFactory,createConversationRoutes,conversationsContribution,conversationsDeclaration,conversationsReplacement,type ConversationsBindings} from '../plugins/conversations.js';
import {createQueryRuntimeFactory,createQueryRuntimePlatform,queryRuntimeContribution,queryRuntimeDeclaration,queryRuntimeReplacement,type QueryRuntimeDependencies,type QueryRuntimeServices,type QueryRuntimeStarted} from '../plugins/query-runtime.js';
import {createQueryRunsFactory,createQueryRunsPlatform,queryRunsContribution,queryRunsDeclaration,queryRunsReplacement,type QueryRunDependencies,type QueryRunsStarted} from '../plugins/query-runs.js';
import {registerQueryRunRoutes} from '../features/ask/query-runs.js';
import {registerAssistantCommandRoutes} from '../features/ask/assistant-commands.js';
import type {AssistantDrafts} from '../assistant-drafts.js';
import type {AssistantTasks} from '../assistant-tasks.js';
import type {ModelConnection} from '../background-model-authorization.js';
import type {ModelAuthorizationHost} from '../model-authorization-host.js';
import type {ServerResources} from '../server-resources.js';
import type {ConversationSettings} from '@mote/shared';

export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
  {contribution:conversationsContribution,declaration:conversationsDeclaration,replacement:conversationsReplacement},
  {contribution:queryRuntimeContribution,declaration:queryRuntimeDeclaration,replacement:queryRuntimeReplacement},
  {contribution:queryRunsContribution,declaration:queryRunsDeclaration,replacement:queryRunsReplacement},
]);

export interface ConversationInputDependencies {
  readonly bootstrap:Awaited<ReturnType<typeof bootstrapCentral>>;
  readonly store:Parameters<typeof createConversations>[0];
  readonly resources:ServerResources;
  readonly backendContext:Context;
  readonly modelAuthorizationHost:Pick<ModelAuthorizationHost,'conversation'>;
}

/** Install the conversation owner and lend its gated repository to the remaining
 * query, Memory and evidence-authority consumers through one host lease. */
export async function prepareConversations(dependencies:ConversationInputDependencies){
  const platform=createConversations(dependencies.store,dependencies.modelAuthorizationHost),routes=createConversationRoutes(()=>dependencies.bootstrap.configService.current<ConversationSettings>('conversations').multipleConversations);
  let bindings:ConversationsBindings|undefined;
  const handle=await dependencies.bootstrap.host.install({
    identity:{host:dependencies.bootstrap.snapshot().host,packageId:'mote.conversations',installationId:'build:conversations@1.0.0',instanceId:'query',activationId:randomUUID()},
    contributions:[conversationsDeclaration],factory:createConversationsFactory(platform,value=>{bindings=value;routes.activate(platform.conversations);}),
  });
  dependencies.resources.defer(()=>handle.close('shutdown'));
  const lease=await dependencies.bootstrap.host.acquire(centralServices.conversations,bindings!.conversations);
  dependencies.resources.defer(()=>lease.release());
  contributeDomainRoutes(dependencies.backendContext,{'mote.ask':routes});
  return Object.freeze({conversations:lease.value});
}

export interface QueryRuntimeAssemblyDependencies extends QueryRuntimeDependencies {
  readonly bootstrap:Awaited<ReturnType<typeof bootstrapCentral>>;
  readonly resources:ServerResources;
}

/** Install the admitted query runtime and lend its lifecycle-gated facade to
 * the remaining assembly and the Ask routes. */
export async function prepareQueryRuntime(dependencies:QueryRuntimeAssemblyDependencies){
  const platform=createQueryRuntimePlatform(dependencies);
  let started:QueryRuntimeStarted|undefined;
  const handle=await dependencies.bootstrap.host.install({
    identity:{host:dependencies.bootstrap.snapshot().host,packageId:'mote.query-runtime',installationId:'build:query-runtime@1.0.0',instanceId:'query',activationId:randomUUID()},
    contributions:[queryRuntimeDeclaration],factory:createQueryRuntimeFactory(platform,value=>{started=value;}),
  });
  dependencies.resources.defer(()=>handle.close('shutdown'));
  const lease=await dependencies.bootstrap.host.acquire(centralServices.query,started!.query);
  dependencies.resources.defer(()=>lease.release());
  return Object.freeze({queryServices:platform satisfies QueryRuntimeServices,query:lease.value});
}

export interface QueryRunsAssemblyDependencies extends QueryRunDependencies {
  readonly bootstrap:Awaited<ReturnType<typeof bootstrapCentral>>;
  readonly backendContext:Context;
  readonly resources:ServerResources;
  readonly availableModelConnections:()=>ModelConnection[];
  readonly assistantDrafts:Pick<AssistantDrafts,'command'>;
  readonly assistantTasks:Pick<AssistantTasks,'byTurn'|'get'>;
  readonly assistantOwner:(request:FastifyRequest)=>void;
}

/** Install C27's delegation runtime and replayable Ask receipts, then mount
 * its command routes once against the current activation. The durable journal,
 * execution slots and model profile of an accepted run are owned inside the
 * plugin scope; a stopped activation fences late commits. */
export async function prepareQueryRuns(dependencies:QueryRunsAssemblyDependencies){
  const platform=createQueryRunsPlatform(dependencies);
  let started:QueryRunsStarted|undefined;
  const handle=await dependencies.bootstrap.host.install({
    identity:{host:dependencies.bootstrap.snapshot().host,packageId:'mote.query-runs',installationId:'build:query-runs@1.0.0',instanceId:'query',activationId:randomUUID()},
    contributions:[queryRunsDeclaration],factory:createQueryRunsFactory(platform,value=>{started=value;}),
  });
  dependencies.resources.defer(()=>handle.close('shutdown'));
  contributeDomainRoutes(dependencies.backendContext,{'mote.ask':{mount:(app:FastifyInstance)=>registerQueryRunRoutes(app,{
    queryRuns:()=>platform.port,modelAuthorizationHost:dependencies.modelAuthorizationHost,
    availableModelConnections:dependencies.availableModelConnections,modelSettings:dependencies.modelSettings,agent:dependencies.agent,
    conversations:dependencies.conversations,conversationQueue:()=>platform.conversationQueue,
  })}});
  contributeDomainRoutes(dependencies.backendContext,{'mote.ask':{mount:(app:FastifyInstance)=>registerAssistantCommandRoutes(app,dependencies.assistantDrafts,dependencies.assistantTasks,dependencies.assistantOwner)}});
  return Object.freeze({delegation:started!.delegation,queryRuns:started!.queryRuns,queryRunServices:platform});
}
