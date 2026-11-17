import {randomUUID} from 'node:crypto';
import {PluginHostError} from '@mote/plugin-host';
import {StoreError} from '../evidence-store.js';
import type {CentralDomainPlugin,bootstrapCentral} from '../bootstrap.js';
import type {ServerResources} from '../server-resources.js';
import type {ActivityDelegationReader} from '../activity.js';
import {retireActivityMemorySubscriptions} from '../activity-memory-index.js';
import {modelConfiguration} from '../model-configuration.js';
import type {ModelSettingsStore} from '../model-settings.js';
import type {AgentRuntimeRegistry} from '../agent-runtime-registry.js';
import {activityServicesPlugin,activityServicesInputsContribution,activityServicesInputsDeclaration,activityServicesInputsContract,
  createActivityServices,type ActivityServicesDependencies} from '../plugins/activity-services.js';
import {agentViewServicesPlugin,agentViewInputsContribution,agentViewInputsDeclaration,agentViewInputsContract,createAgentViewServices,type AgentViewRouteDependencies} from '../plugins/agent-view-routes.js';
import {ownerQuestionServicesContribution,ownerQuestionServicesDeclaration,ownerQuestionServicesReplacement} from '../plugins/owner-question-services.js';

/** Executable Activity and read-only Agent View declarations. */
export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
  {contribution:activityServicesInputsContribution,declaration:activityServicesInputsDeclaration,replacement:'restart'},activityServicesPlugin,
  {contribution:agentViewInputsContribution,declaration:agentViewInputsDeclaration,replacement:'restart'},agentViewServicesPlugin,
  {contribution:ownerQuestionServicesContribution,declaration:ownerQuestionServicesDeclaration,replacement:ownerQuestionServicesReplacement},
]);
export interface ActivityAssemblyDependencies extends Omit<ActivityServicesDependencies,'options'|'config'|'delegation'> {
  readonly configService:ActivityServicesDependencies['config'];
  readonly modelSettings:ModelSettingsStore;
  readonly agent:Pick<AgentRuntimeRegistry,'configuredFor'>;
  readonly query:ActivityServicesDependencies['options']['query'];
  readonly lane:ActivityServicesDependencies['options']['lane'];
  /** Resolves the formal QueryRuns metadata lease after its normal startup. */
  readonly delegation:()=>ActivityDelegationReader;
  readonly agentView:AgentViewRouteDependencies;
}

/** Private build adapters publish deferred domain factories, not Store/Engine
 * bags. Only selected activations open their domain's resources. */
export async function prepareActivityInputs(bootstrap:Awaited<ReturnType<typeof bootstrapCentral>>,resources:ServerResources,dependencies:ActivityAssemblyDependencies){
  retireActivityMemorySubscriptions(dependencies.store,'main');
  const activity=bootstrap.selectsFeature('mote.activity')&&bootstrap.selectsPlugin(activityServicesPlugin.contribution.id);
  const view=bootstrap.selectsFeature('mote.agent-view')&&bootstrap.selectsPlugin(agentViewServicesPlugin.contribution.id);
  if(activity){
    if(!bootstrap.selectsPlugin(activityServicesInputsContribution.id))throw Error('Activity input provider is not selected');
    if(!bootstrap.selectsPlugin('query-runs'))throw Error('Activity requires the QueryRuns metadata provider');
    const handle=await bootstrap.host.install({
      identity:{host:bootstrap.host.identity,packageId:activityServicesInputsContribution.id,installationId:'build:activity-services-inputs@1.0.0',instanceId:'activity-inputs',activationId:randomUUID()},
      contributions:[activityServicesInputsDeclaration],restartRequired:true,
      factory(context){
        const value=Object.freeze({open:()=>createActivityServices({store:dependencies.store,operations:dependencies.operations,materials:dependencies.materials,executor:dependencies.executor,
          config:dependencies.configService,isCollector:dependencies.isCollector,get delegation(){try{return dependencies.delegation();}catch(error){if(error instanceof PluginHostError)throw new StoreError('Activity work metadata is unavailable',503);throw error;}},
          options:{query:dependencies.query,lane:dependencies.lane,selection:profileId=>{
            const selected=dependencies.modelSettings.select('chat',profileId);
            return {...modelConfiguration(selected.id,selected.settings,dependencies.modelSettings.view().revision),configured:dependencies.agent.configuredFor(selected.id)};
          }}})});
        bootstrap.registerDomainService(context.provide(activityServicesInputsContribution.id,activityServicesInputsContract,value));
        return {prepare(){},start(){},quiesce(){},stop(){},dispose(){}};
      },
    });resources.defer(()=>handle.close('shutdown'));
  }
  if(view){
    if(!bootstrap.selectsPlugin(agentViewInputsContribution.id))throw Error('Agent view input provider is not selected');
    const handle=await bootstrap.host.install({
      identity:{host:bootstrap.host.identity,packageId:agentViewInputsContribution.id,installationId:'build:agent-view-inputs@1.0.0',instanceId:'agent-view-inputs',activationId:randomUUID()},
      contributions:[agentViewInputsDeclaration],restartRequired:true,
      factory(context){
        bootstrap.registerDomainService(context.provide(agentViewInputsContribution.id,agentViewInputsContract,{open:()=>createAgentViewServices(dependencies.agentView)}));
        return {prepare(){},start(){},quiesce(){},stop(){},dispose(){}};
      },
    });resources.defer(()=>handle.close('shutdown'));
  }
}
