import type { FastifyInstance } from 'fastify';
import { serverConfiguration } from '../configuration.js';
import { registerExecutionSettingsRoutes } from '../execution-settings-routes.js';
import type { FeatureServices } from '../feature-services.js';
import { moteText } from '../i18n.js';
import { registerModelSettingsRoutes } from '../model-settings-routes.js';
import {registerModelAuthorizationRoutes} from '../model-authorization-routes.js';
import {z} from 'zod';
import {ModelSettingsError,type ModelDomain} from '../model-settings.js';

function retainedCredential(current:unknown,patch:unknown):boolean {
  if(!current)return false;
  if(current&&typeof current==='object'&&!Array.isArray(current)){
    if(!patch||typeof patch!=='object'||Array.isArray(patch))return Object.keys(current).length>0;
    return Object.entries(current).some(([key,value])=>!Object.hasOwn(patch,key)||retainedCredential(value,(patch as Record<string,unknown>)[key]));
  }
  return patch===undefined;
}
/** Generic model edits preserve the same credential-reuse decision as the dedicated model editor. */
function checkModelCredentialReuse(saved:ModelDomain,patch:Record<string,unknown>,allow:boolean):void {
  if(allow)return;
  const deployment=patch.deployment;
  if(deployment&&typeof deployment==='object'&&!Array.isArray(deployment)){
    const next=deployment as Record<string,unknown>,current=saved.deployment;
    const changed=['provider','protocol','baseUrl'].some(key=>Object.hasOwn(next,key)&&next[key]!==current[key as keyof typeof current]);
    if(changed&&['apiKey','headers','extraBody'].some(key=>retainedCredential(current[key as keyof typeof current],next[key])))throw new ModelSettingsError('model_settings_credential_reuse');
  }
  const embedding=patch.embedding;
  if(embedding&&typeof embedding==='object'&&!Array.isArray(embedding)){
    const next=embedding as Record<string,unknown>;
    if(Object.hasOwn(next,'baseUrl')&&next.baseUrl!==saved.embedding.baseUrl&&saved.embedding.apiKey&&!Object.hasOwn(next,'apiKey'))throw new ModelSettingsError('model_settings_credential_reuse');
  }
}

/** models: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{modelAuthorization,availableModelConnections,credential,agentGate,codex,config,configService,diagnostics,executor,interactiveGate,interactiveModelGate,lifecycle,llmGate,maintenanceWorker,memoryPipeline,modelSettings,providerAdmission,runtimeSettings}:Pick<FeatureServices,'modelAuthorization'|'availableModelConnections'|'credential'|"agentGate"|"codex"|"config"|"configService"|"diagnostics"|"executor"|"interactiveGate"|"interactiveModelGate"|"lifecycle"|"llmGate"|"maintenanceWorker"|"memoryPipeline"|"modelSettings"|"providerAdmission"|"runtimeSettings">){
registerModelSettingsRoutes(app,modelSettings,codex);
registerModelAuthorizationRoutes(app,modelAuthorization,availableModelConnections,credential);
const configurationView=()=>{const d=runtimeSettings.diagnostics(),view=serverConfiguration({...config,...runtimeSettings.execution(),diagnosticsEnabled:d.enabled,diagnosticsDebug:d.debug,agentTraceEnabled:d.traceEnabled,logLevel:d.level},{modelSource:modelSettings.view().source,service:configService.view()}),policy=lifecycle.settings().insights,field=view.groups.flatMap(g=>g.fields).find(f=>f.key==='insightIntervalHours');if(field){field.value=policy.enabled?policy.intervalHours:0;field.source='derived';field.description=moteText("已保存的洞察策略：周期到达并且至少 {0} 次增量变化时运行。在记忆设置中直接修改。", policy.minChanges);delete field.envVar;}return view;};
app.get('/api/configuration',async()=>configurationView());
app.put('/api/configuration/:id',{bodyLimit:1048576},async req=>{const {id}=z.object({id:z.string().min(1).max(128)}).parse(req.params),body=z.object({revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),value:z.record(z.unknown()),allowCredentialReuse:z.boolean().optional()}).strict().parse(req.body);if(id==='models')checkModelCredentialReuse(configService.saved<ModelDomain>('models'),body.value,body.allowCredentialReuse===true);await configService.update(id,body.value,body.revision);return configurationView();});
registerExecutionSettingsRoutes(app,{runtimeSettings,agentGate,llmGate,interactiveGate,interactiveModelGate,diagnostics,providerAdmission,maintenanceSnapshot:()=>maintenanceWorker?.snapshot()??null,delegatedSnapshot:()=>executor.poolSnapshot('delegated-agents'),wakeMemory:()=>memoryPipeline.wake()});
}
