import {DEPLOYMENT_MODEL_PROFILE_ID,MODEL_FEATURES,type ModelSettingsView} from '@mote/shared/models';
export function modelView():ModelSettingsView {
 const settings={provider:'custom',protocol:'openai-completions' as const,baseUrl:'https://fixture.example/v1',model:'fixture-model',reasoningEffort:'auto' as const,maxTokens:4096,modelRequestTimeoutMs:120000,agentTimeoutMs:120000,allowUnauthenticatedLocal:false,apiKeyConfigured:false,headersConfigured:false,extraBodyConfigured:false};
 return {version:1,revision:1,source:'environment',settings,profiles:[{id:DEPLOYMENT_MODEL_PROFILE_ID,name:'Fixture deployment',readOnly:true,settings}],defaults:Object.fromEntries(MODEL_FEATURES.map(feature=>[feature,DEPLOYMENT_MODEL_PROFILE_ID])) as ModelSettingsView['defaults'],defaultModels:{}};
}
