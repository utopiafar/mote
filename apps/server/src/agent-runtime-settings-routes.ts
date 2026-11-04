import type {FastifyInstance} from 'fastify';
import {MODEL_FEATURES,type ModelFeature,type ModelSettingsView} from '@mote/shared/models';
import type {ConfigServiceView} from '@mote/shared';
import type {AgentRuntimeRegistry,AgentRuntimeRegistryStatus} from './agent-runtime-registry.js';
import type {ConfigService} from './config-service.js';
import type {ModelSettingsStore} from './model-settings.js';

export interface AgentRuntimeSettingsView {
  readonly revision:number;
  readonly saved:ModelSettingsView;
  readonly features:Readonly<Record<ModelFeature,{readonly profileId:string;readonly provider:string;readonly model:string;readonly configured:boolean}>>;
  readonly runtime:AgentRuntimeRegistryStatus;
  readonly configuration:ConfigServiceView&{readonly domain?:ConfigServiceView['domains'][number]};
}

export function registerAgentRuntimeSettingsRoutes(app:FastifyInstance,{agent,modelSettings,configService}:{agent:Pick<AgentRuntimeRegistry,'status'|'configuredFor'>;modelSettings:ModelSettingsStore;configService:ConfigService}){
  app.get('/api/agent-runtime-settings',async():Promise<AgentRuntimeSettingsView>=>{
    const saved=modelSettings.view(),configuration=configService.view();
    const features=Object.fromEntries(MODEL_FEATURES.map(feature=>{
      const selected=modelSettings.select(feature);
      return [feature,{profileId:selected.id,provider:selected.settings.provider,model:selected.settings.model,configured:agent.configuredFor(selected.id)}];
    })) as AgentRuntimeSettingsView['features'];
    return {revision:saved.revision,saved,features,runtime:agent.status(),configuration:{...configuration,domain:configuration.domains.find(domain=>domain.id==='models')}};
  });
}
