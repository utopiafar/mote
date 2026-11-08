import {DEPLOYMENT_MODEL_PROFILE_ID,MODEL_FEATURES,type ModelFeature,type ModelSettingsView} from '@mote/shared/models';
export function modelView():ModelSettingsView {
 const settings={provider:'custom',protocol:'openai-completions' as const,baseUrl:'https://fixture.example/v1',model:'fixture-model',reasoningEffort:'auto' as const,maxTokens:4096,modelRequestTimeoutMs:120000,agentTimeoutMs:120000,allowUnauthenticatedLocal:false,apiKeyConfigured:false,headersConfigured:false,extraBodyConfigured:false};
 return {version:1,revision:1,source:'file',settings,profiles:[{id:DEPLOYMENT_MODEL_PROFILE_ID,name:'Fixture deployment',readOnly:true,settings}],defaults:Object.fromEntries(MODEL_FEATURES.map(feature=>[feature,DEPLOYMENT_MODEL_PROFILE_ID])) as ModelSettingsView['defaults'],defaultModels:{}};
}
/** Serialized GET /api/agent-runtime-settings body matching a settings view. */
export function runtimeReceipt(view:{revision:number;profiles:{id:string;name:string;settings:{provider?:string;model?:string}}[];defaults:Record<string,string>;defaultModels:Record<string,string|undefined>},overrides:{configured?:boolean;domainStatus?:'applied'|'restart-required'|'invalid'}={}) {
 const configured=overrides.configured??true;
 const features=Object.fromEntries(MODEL_FEATURES.map((feature:ModelFeature)=>{const profile=view.profiles.find(p=>p.id===view.defaults[feature]);return [feature,{profileId:view.defaults[feature],provider:profile?.settings.provider??'custom',model:view.defaultModels[feature]||profile?.settings.model||'',configured}];}));
 const domain={id:'models',saved:{},effective:{},fields:[],status:overrides.domainStatus??'applied'};
 return {revision:view.revision,saved:view,features,
  runtime:{closed:false,configured,generation:1,activeRuns:0,retiringGenerations:0,releasedGenerations:0,preparedGenerations:0,closeErrors:0,preparedAgents:configured?1:0,pendingPreparations:0,pendingCleanupFailures:0,shuttingDown:false},
  configuration:{version:1,revision:view.revision,configFile:'/private/tmp/mote-fixture/mote.yaml',domains:[domain],lastError:null,domain}};
}
