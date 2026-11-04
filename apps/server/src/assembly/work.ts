import type {Context} from '@deepseek-ai/cordis';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {ContextReader,QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import type {Store} from '../store.js';
import type {FeatureServices} from '../feature-services.js';
import type {ServerResources} from '../server-resources.js';
import type {ConfigService} from '../config-service.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {FileStore} from '../files.js';
import type {MaterialStore} from '../materials.js';
import type {Operations} from '../operations.js';
import type {DelegationRuntime} from '../delegation-runtime.js';
import type {ModelSettingsStore} from '../model-settings.js';
import type {AgentRuntimeRegistry} from '../agent-runtime-registry.js';
import {modelConfiguration} from '../model-configuration.js';
import type {ProcessingRuntime} from '../processing-runtime.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {EvidenceReader} from '../evidence-reader.js';
import {requestLocale} from '../i18n.js';
import type {ModelConnection} from '../background-model-authorization.js';
import type {ModelAuthorizationHost} from '../model-authorization-host.js';
import {createOwnerQuestionServices} from '../plugins/owner-question-services.js';
import {openInsightRuns} from '../plugins/insight-services.js';
import type {Connections,ConnectionCredential} from '../connections.js';
import type {PluginCenter} from '../plugin-center.js';
import type {SourceStore} from '../sources.js';
import type {CentralDomainPlugin} from '../bootstrap.js';
import {actionsServicesContribution,actionsServicesDeclaration,actionsServicesReplacement,createActionsServices} from '../plugins/actions-services.js';
import {contributeDomainRoutes} from '../plugins/domain-routes.js';
import {createActivityServices} from '../plugins/activity-services.js';

/** ACT01's declared build-time domain plugin. The pre-H14 feature bridge mounts
 * the same route contribution until app.ts construction moves behind K04. */
export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
  {contribution:actionsServicesContribution,declaration:actionsServicesDeclaration,replacement:actionsServicesReplacement},
]);

export interface WorkInputDependencies {
  readonly store:Store;
  readonly backendContext:Context;
  readonly resources:ServerResources;
  readonly credential:(request:FastifyRequest)=>unknown;
  readonly modelAuthorization:Pick<ModelAuthorizationHost,'manual'>;
  readonly availableModelConnections:()=>ModelConnection[];
}

/** C26C's owner-question plugin plus its route contribution. The feature
 * bridge mounts the table before listen; Memory still registers its provider
 * on the same ledger through the current assembly bridge. */
export function workInputs(dependencies:WorkInputDependencies){
  const ownerQuestionServices=createOwnerQuestionServices({store:dependencies.store,credential:dependencies.credential,modelAuthorization:dependencies.modelAuthorization,availableModelConnections:dependencies.availableModelConnections});
  dependencies.resources.defer(()=>ownerQuestionServices.close());
  ownerQuestionServices.prepare();ownerQuestionServices.start();
  const routes=dependencies.backendContext.get('moteDomainRoutes');
  const merged=Object.freeze({...(routes??{}),'mote.owner-questions':Object.freeze({mount:(app:FastifyInstance)=>ownerQuestionServices.routes(app)})});
  if(routes)dependencies.backendContext.set('moteDomainRoutes',merged);
  else dependencies.backendContext.provide('moteDomainRoutes',merged);
  const ownerQuestions=ownerQuestionServices.questions;
  return Object.freeze({ownerQuestions,ownerQuestionServices,featureServices:Object.freeze({ownerQuestions}) satisfies Partial<FeatureServices>});
}

export interface InsightRunsAssemblyDependencies {
  readonly store:Store;
  readonly resources:ServerResources;
  readonly executor:ExecutionEngine;
  readonly evidenceReader:EvidenceReader;
}

/** Durable insight run manager — the insight feature borrows it through
 * FeatureServices until its own domain unit takes ownership. */
export function assembleInsightRuns(dependencies:InsightRunsAssemblyDependencies){
  const insightRuns=openInsightRuns(dependencies.store,{executor:dependencies.executor,evidenceReader:dependencies.evidenceReader});
  dependencies.resources.defer(()=>insightRuns.close());
  return Object.freeze({insightRuns,featureServices:Object.freeze({insightRuns}) satisfies Partial<FeatureServices>});
}

export interface ActionsAssemblyDependencies {
  readonly store:Store;
  readonly resources:ServerResources;
  readonly backendContext:Context;
  readonly files:FileStore;
  readonly sources:SourceStore;
  readonly connections:Connections;
  readonly pluginCenter:Pick<PluginCenter,'actionProviders'>;
  readonly agent:Pick<AgentRuntimeRegistry,'configured'>;
  readonly executor:ExecutionEngine;
  readonly configService:ConfigService;
  readonly semanticArtifacts:(ids:string[],operationId?:string,mode?:'lifecycle')=>Promise<string[]>;
  readonly credential:(request:FastifyRequest)=>ConnectionCredential|undefined;
  readonly connectionIdentity:(request:FastifyRequest)=>ConnectionCredential|undefined;
  /** Late-bound: the admitted query path assembles after Actions; the callback
   * is only invoked by accepted work. */
  readonly queryAgent:(input:QueryInput,operation?:'query'|'insight',moduleId?:string,usageOwner?:'query'|'caller')=>Promise<QueryResult>;
}

/** The actions-services plugin owns the domain objects, poll and route table;
 * the assembly only binds its dependencies, lifecycle and route contribution. */
export async function assembleActions(dependencies:ActionsAssemblyDependencies){
  const {store,files,resources,backendContext,agent,executor,configService,semanticArtifacts,sources,connections,pluginCenter,credential,connectionIdentity,queryAgent}=dependencies;
  const services=createActionsServices({store,files,sources,connections,executor,configService,semanticArtifacts,
    actionProviders:()=>pluginCenter.actionProviders(),
    query:input=>queryAgent({...input,language:requestLocale.getStore()??'zh-CN'},'query','actions'),
    configured:()=>agent.configured,
    authorization:{credential,connectionIdentity}});
  resources.defer(()=>services.close());
  await services.prepare();services.start();
  contributeDomainRoutes(backendContext,{'mote.actions':Object.freeze({mount:(app:Parameters<typeof services.routes>[0])=>services.routes(app)})});
  return Object.freeze({actions:services.actionsForAssembly,featureServices:Object.freeze({}) satisfies Partial<FeatureServices>});
}

export interface ActivityAssemblyDependencies {
  readonly store:Store;
  readonly resources:ServerResources;
  readonly operations:Operations;
  readonly delegation:DelegationRuntime;
  readonly materials:MaterialStore;
  readonly executor:ExecutionEngine;
  readonly configService:ConfigService;
  readonly modelSettings:ModelSettingsStore;
  readonly agent:Pick<AgentRuntimeRegistry,'configuredFor'>;
  readonly workflows:Pick<ProcessingRuntime,'settings'>;
  readonly queryAgent:(input:QueryInput,operation?:'query'|'insight',moduleId?:string,usageOwner?:'query'|'caller')=>Promise<QueryResult>;
  readonly backendContext:Context;
  readonly isCollector:(request:FastifyRequest)=>boolean;
  readonly archiveReader:ContextReader;
  readonly diagnostics:ServerDiagnostics;
  readonly evidenceReader:Pick<EvidenceReader,'artifact'>;
}

/** C26A's activity plugin plus its owned route contribution. Construction and
 * disposal live in the plugin; this assembly only wires the current profile and
 * exposes the feature bridge's domain route table. */
export function assembleActivity(dependencies:ActivityAssemblyDependencies){
  const {store,resources,operations,delegation,materials,executor,configService,modelSettings,agent,workflows,queryAgent,backendContext,isCollector,archiveReader,diagnostics,evidenceReader}=dependencies;
  const activityServices=createActivityServices({store,operations,delegation,materials,executor,config:configService,isCollector,
    agentView:{archiveReader,diagnostics,evidenceReader},
    options:{query:input=>queryAgent(input,'query','activity'),selection:profileId=>{const selected=modelSettings.select('chat',profileId);return {...modelConfiguration(selected.id,selected.settings,modelSettings.view().revision),configured:agent.configuredFor(selected.id)};},lane:()=>workflows.settings().semantic}});
  resources.defer(()=>activityServices.close());
  activityServices.prepare();activityServices.start();
  const routes=backendContext.get('moteDomainRoutes');
  const merged=Object.freeze({...(routes??{}),
    'mote.activity':Object.freeze({mount:(app:Parameters<typeof activityServices.routes>[0])=>activityServices.routes(app)}),
    'mote.agent-view':Object.freeze({mount:(app:Parameters<typeof activityServices.agentViewRoutes>[0])=>activityServices.agentViewRoutes(app)})});
  if(routes)backendContext.set('moteDomainRoutes',merged);
  else backendContext.provide('moteDomainRoutes',merged);
  return Object.freeze({activity:activityServices.activity,automaticActivity:activityServices.automaticActivity,activityServices});
}
