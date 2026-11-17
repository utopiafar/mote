import type {Context} from '@deepseek-ai/cordis';
import type {ServiceLease} from '@mote/plugin-api/contracts';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {ContextReader,QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import type {Store} from '../store.js';
import type {ServerResources} from '../server-resources.js';
import type {ConfigService} from '../config-service.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {FileStore} from '../files.js';
import type {MaterialStore} from '../materials.js';
import type {AgentRuntimeRegistry} from '../agent-runtime-registry.js';
import type {ProcessingRuntime} from '../processing-runtime.js';
import type {EvidenceReader} from '../evidence-reader.js';
import {requestLocale} from '../i18n.js';
import type {ModelConnection} from '../background-model-authorization.js';
import type {ModelAuthorizationHost} from '../model-authorization-host.js';
import {createOwnerQuestionServices} from '../plugins/owner-question-services.js';
import {insightServicesPlugin,insightServicesInputsContribution,insightServicesInputsDeclaration,insightServicesInputsContract,insightServicesContract,type InsightServices} from '../plugins/insight-services.js';
import {insightServiceInputs} from '../insight-service-inputs.js';
import {insightAssistantFeature} from '../features/insights.js';
import {randomUUID} from 'node:crypto';
import type {Connections,ConnectionCredential} from '../connections.js';
import type {PluginCenter} from '../plugin-center.js';
import type {SourceStore} from '../sources.js';
import type {bootstrapCentral,CentralDomainPlugin} from '../bootstrap.js';
import {actionsServicesPlugin,actionsServicesInputsContribution,actionsServicesInputsDeclaration,actionsServicesInputsContract,actionsServicesContract,type ActionsServices} from '../plugins/actions-services.js';
import {createActionsServiceInputs} from '../action-service-inputs.js';
import {contributeDomainRoutes} from '../plugins/domain-routes.js';
import {prepareActivityInputs,type ActivityAssemblyDependencies} from './activity.js';
import {activityServicesContract,type ActivityServices} from '../plugins/activity-services.js';

/** Executable work domains and their private build input providers. */
export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
  {contribution:actionsServicesInputsContribution,declaration:actionsServicesInputsDeclaration,replacement:'restart'},
  actionsServicesPlugin,
  {contribution:insightServicesInputsContribution,declaration:insightServicesInputsDeclaration,replacement:'restart'},
  insightServicesPlugin,
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
  return Object.freeze({ownerQuestions,ownerQuestionServices});
}

export type WorkDomainDependencies=Parameters<typeof insightServiceInputs>[0]&{
  readonly bootstrap:Awaited<ReturnType<typeof bootstrapCentral>>;
  readonly resources:ServerResources;
  readonly actions:ActionsAssemblyDependencies;
  readonly activity:ActivityAssemblyDependencies;
}

/** Publish only the private typed adapter. The selected declaration, common
 * loader and plugin lifecycle create the domain and contribute its routes. */
export async function prepareWorkDomains(dependencies:WorkDomainDependencies){
  const {bootstrap,resources,actions:actionInputs,activity:activityInputs,...inputs}=dependencies;
  await prepareActivityInputs(bootstrap,resources,activityInputs);
  const selected=bootstrap.selectsFeature('mote.insights')&&bootstrap.selectsPlugin(insightServicesPlugin.contribution.id);
  if(selected){
    if(!bootstrap.selectsPlugin(insightServicesInputsContribution.id))throw Error('Insights input provider is not selected');
    const handle=await bootstrap.host.install({
      identity:{host:bootstrap.host.identity,packageId:insightServicesInputsContribution.id,installationId:'build:insight-services-inputs@1.0.0',instanceId:'insight-inputs',activationId:randomUUID()},
      contributions:[insightServicesInputsDeclaration],restartRequired:true,
      factory(context){
        const value=insightServiceInputs(inputs);
        bootstrap.registerDomainService(context.provide(insightServicesInputsContribution.id,insightServicesInputsContract,value));
        return {prepare(){},start(){},quiesce(){},stop(){},dispose(){}};
      },
    });
    resources.defer(()=>handle.close('shutdown'));
  }
  const actionsSelected=bootstrap.selectsFeature('mote.actions')&&bootstrap.selectsPlugin(actionsServicesPlugin.contribution.id);
  let actionsInput:ReturnType<typeof createActionsServiceInputs>|undefined;
  if(actionsSelected){
    if(!bootstrap.selectsPlugin(actionsServicesInputsContribution.id))throw Error('Actions input provider is not selected');
    actionsInput=createActionsServiceInputs({
      store:actionInputs.store,files:actionInputs.files,sources:actionInputs.sources,connections:actionInputs.connections,executor:actionInputs.executor,
      configService:actionInputs.configService,semanticArtifacts:actionInputs.semanticArtifacts,assistantTasks:actionInputs.assistantTasks,
      readEvidence:ids=>actionInputs.evidenceReader.memories.readEvidence(ids),currentEvidence:id=>actionInputs.evidenceReader.memories.isCurrentEvidence(id),
      actionProviders:()=>actionInputs.pluginCenter.actionProviders(),connectorAction:input=>actionInputs.pluginCenter.executeConnectorAction(input),
      query:input=>actionInputs.queryAgent({...input,language:requestLocale.getStore()??'zh-CN'},'query','actions'),configured:()=>actionInputs.agent.configured,
      authorization:{credential:actionInputs.credential,connectionIdentity:actionInputs.connectionIdentity},
    });
    const value=actionsInput.inputs;
    const handle=await bootstrap.host.install({
      identity:{host:bootstrap.host.identity,packageId:actionsServicesInputsContribution.id,installationId:'build:actions-services-inputs@1.0.0',instanceId:'action-inputs',activationId:randomUUID()},
      contributions:[actionsServicesInputsDeclaration],restartRequired:true,
      factory(context){
        bootstrap.registerDomainService(context.provide(actionsServicesInputsContribution.id,actionsServicesInputsContract,value));
        return {prepare(){},start(){},quiesce(){},stop(){},dispose(){}};
      },
    });
    resources.defer(()=>handle.close('shutdown'));
  }
  const domains=await bootstrap.activateDomains();
  let activity:ActivityServices|undefined;
  if(bootstrap.selectsFeature('mote.activity')&&bootstrap.selectsPlugin('activity-services')){
    const lease=await bootstrap.acquireDomainService('activity-services',activityServicesContract);
    resources.defer(()=>lease.release());activity=lease.value;
  }
  resources.beforeClose(()=>domains.quiesce());resources.defer(()=>domains.close());
  let insights:InsightServices|undefined;
  if(selected){
    const lease=await bootstrap.acquireDomainService(insightServicesPlugin.contribution.id,insightServicesContract);
    resources.defer(()=>lease.release());insights=lease.value;
  }
  let actionsLease:ServiceLease<ActionsServices>|undefined;
  if(actionsSelected){
    actionsLease=await bootstrap.acquireDomainService(actionsServicesPlugin.contribution.id,actionsServicesContract);
    resources.defer(()=>actionsLease!.release());
  }
  const current=()=>{if(!insights)throw Error('Insights plugin is not selected');return insights;};
  return Object.freeze({
    get activityServices(){if(!activity)throw Error('Activity plugin is not selected');return activity;},
    get activity(){if(!activity)throw Error('Activity plugin is not selected');return activity.activity;},
    get automaticActivity(){if(!activity)throw Error('Activity plugin is not selected');return activity.automaticActivity;},
    routes:domains.routes,insights,
    get insightServices(){return current();},get insightRuns(){return current().runs;},
    get actions(){if(!actionsLease||!actionsInput)throw Error('Actions plugin is not selected');actionsLease.assertCurrent();return actionsInput.actionsForAssembly;},
    get actionsServices(){if(!actionsLease)throw Error('Actions plugin is not selected');return actionsLease.value;},
    contributeAssistantRoutes(context:Context,cards:Parameters<typeof insightAssistantFeature>[1]){
      if(insights)contributeDomainRoutes(context,{'mote.insights':insightAssistantFeature(insights,cards)});
    },
  });
}

export interface ActionsAssemblyDependencies {
  readonly store:Store;
  readonly assistantTasks:import('../assistant-tasks.js').AssistantTasks;
  readonly evidenceReader:EvidenceReader;
  readonly files:FileStore;
  readonly sources:SourceStore;
  readonly connections:Connections;
  readonly pluginCenter:Pick<PluginCenter,'actionProviders'|'executeConnectorAction'>;
  readonly agent:Pick<AgentRuntimeRegistry,'configured'>;
  readonly executor:ExecutionEngine;
  readonly configService:ConfigService;
  readonly semanticArtifacts:(ids:string[],operationId?:string,mode?:'lifecycle')=>Promise<string[]>;
  readonly credential:(request:FastifyRequest)=>ConnectionCredential|undefined;
  readonly connectionIdentity:(request:FastifyRequest)=>ConnectionCredential|undefined;
  /** The admitted query path is fixed by assembly and invoked only by accepted work. */
  readonly queryAgent:(input:QueryInput,operation?:'query'|'insight',moduleId?:string,usageOwner?:'query'|'caller')=>Promise<QueryResult>;
}
