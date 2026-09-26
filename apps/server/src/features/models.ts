import type { FastifyInstance } from 'fastify';
import { serverConfiguration } from '../configuration.js';
import { registerExecutionSettingsRoutes } from '../execution-settings-routes.js';
import type { FeatureServices } from '../feature-services.js';
import { moteText } from '../i18n.js';
import { registerModelSettingsRoutes } from '../model-settings-routes.js';

/** models: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{agentGate,codex,config,diagnostics,interactiveGate,interactiveModelGate,lifecycle,llmGate,maintenanceWorker,memoryPipeline,modelBudgets,modelSettings,providerAdmission,runtimeSettings}:Pick<FeatureServices,"agentGate"|"codex"|"config"|"diagnostics"|"interactiveGate"|"interactiveModelGate"|"lifecycle"|"llmGate"|"maintenanceWorker"|"memoryPipeline"|"modelBudgets"|"modelSettings"|"providerAdmission"|"runtimeSettings">){
registerModelSettingsRoutes(app,modelSettings,codex);
app.get('/api/configuration',async()=>{const d=runtimeSettings.diagnostics(),view=serverConfiguration({...config,...runtimeSettings.execution(),diagnosticsEnabled:d.enabled,diagnosticsDebug:d.debug,agentTraceEnabled:d.traceEnabled,logLevel:d.level},{modelSource:modelSettings.view().source}),policy=lifecycle.settings().insights,field=view.groups.flatMap(g=>g.fields).find(f=>f.key==='insightIntervalHours');for(const f of view.groups.flatMap(g=>g.fields))if(['agentConcurrency','llmConcurrency','memoryConcurrency','diagnosticsEnabled','diagnosticsDebug','agentTraceEnabled','logLevel'].includes(f.key)){f.source='derived';f.restartRequired=false;}if(field){field.value=policy.enabled?policy.intervalHours:0;field.source='derived';field.description=moteText("已保存的洞察策略：周期到达并且至少 {0} 次增量变化时运行。在记忆设置中直接修改。", policy.minChanges);delete field.envVar;}return view;});
registerExecutionSettingsRoutes(app,{modelBudgets,runtimeSettings,agentGate,llmGate,interactiveGate,interactiveModelGate,diagnostics,providerAdmission,maintenanceSnapshot:()=>maintenanceWorker?.snapshot()??null,wakeMemory:()=>memoryPipeline.wake()});
}
