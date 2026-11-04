import type {Context} from '@deepseek-ai/cordis';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import type {Store} from '../store.js';
import type {ServerResources} from '../server-resources.js';
import type {ConfigService} from '../config-service.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {FileStore} from '../files.js';
import type {MaterialStore} from '../materials.js';
import type {Operations} from '../operations.js';
import type {DelegationRuntime} from '../delegation-runtime.js';
import type {ModelSettingsStore} from '../model-settings.js';
import type {ReloadableAgent} from '../model-agent.js';
import {modelConfiguration} from '../model-configuration.js';
import type {ProcessingRuntime} from '../processing-runtime.js';
import type {EvidenceReader} from '../evidence-reader.js';
import {requestLocale} from '../i18n.js';
import type {ModelConnection} from '../background-model-authorization.js';
import type {ModelAuthorizationHost} from '../model-authorization-host.js';
import {createOwnerQuestionServices} from '../plugins/owner-question-services.js';
import {InsightRuns} from '../insight-runs.js';
import {Actions} from '../actions.js';
import {ActivityProjection} from '../activity.js';
import {AutomaticActivity} from '../automatic-activity.js';

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
  return Object.freeze({ownerQuestions:ownerQuestionServices.questions,ownerQuestionServices});
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
  const insightRuns=new InsightRuns(dependencies.store,{executor:dependencies.executor,evidenceReader:dependencies.evidenceReader});
  dependencies.resources.defer(()=>insightRuns.close());
  return Object.freeze({insightRuns});
}

export interface ActionsAssemblyDependencies {
  readonly store:Store;
  readonly resources:ServerResources;
  readonly files:FileStore;
  readonly agent:Pick<ReloadableAgent,'configured'>;
  readonly executor:ExecutionEngine;
  readonly configService:ConfigService;
  readonly semanticArtifacts:(ids:string[],operationId?:string,mode?:'lifecycle')=>Promise<string[]>;
  /** Late-bound: the admitted query path assembles after Actions; the callback
   * is only invoked by accepted work. */
  readonly queryAgent:(input:QueryInput,operation?:'query'|'insight',moduleId?:string,usageOwner?:'query'|'caller')=>Promise<QueryResult>;
}

/** Actions service plus its close hook. */
export function assembleActions(dependencies:ActionsAssemblyDependencies){
  const {store,files,resources,agent,executor,configService,semanticArtifacts,queryAgent}=dependencies;
  const actions=new Actions(store,files,input=>queryAgent({...input,language:requestLocale.getStore()??'zh-CN'},'query','actions'),()=>agent.configured,{semanticArtifacts,executor,configService});
  resources.defer(()=>actions.close());
  return Object.freeze({actions});
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
  readonly agent:Pick<ReloadableAgent,'configuredFor'>;
  readonly workflows:Pick<ProcessingRuntime,'settings'>;
  readonly queryAgent:(input:QueryInput,operation?:'query'|'insight',moduleId?:string,usageOwner?:'query'|'caller')=>Promise<QueryResult>;
}

/** Activity projection and the automatic-activity scheduler, plus the
 * scheduler's close hook. */
export function assembleActivity(dependencies:ActivityAssemblyDependencies){
  const {store,resources,operations,delegation,materials,executor,configService,modelSettings,agent,workflows,queryAgent}=dependencies;
  const activity=new ActivityProjection(store,operations,{delegation});
  const automaticActivity=new AutomaticActivity(store,materials,executor,configService,{query:input=>queryAgent(input,'query','activity'),selection:profileId=>{const selected=modelSettings.select('chat',profileId);return {...modelConfiguration(selected.id,selected.settings,modelSettings.view().revision),configured:agent.configuredFor(selected.id)};},lane:()=>workflows.settings().semantic});
  resources.defer(()=>automaticActivity.close());
  return Object.freeze({activity,automaticActivity});
}
