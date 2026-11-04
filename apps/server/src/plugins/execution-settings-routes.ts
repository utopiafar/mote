import type {FastifyInstance} from 'fastify';
import type {ExecutionSettings} from '../execution-settings.js';
import type {ConcurrencyGate} from '../concurrency.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {ProviderAdmission} from '../provider-admission.js';
import type {MaintenanceWorker} from '../maintenance.js';
import type {ExecutionEngine} from '../execution-engine.js';
export function registerExecutionSettingsRoutes(app:FastifyInstance,{runtimeSettings,agentGate,llmGate,interactiveGate,interactiveModelGate,diagnostics,providerAdmission,maintenanceSnapshot,delegatedSnapshot,wakeMemory}:{runtimeSettings:ExecutionSettings;agentGate:ConcurrencyGate;llmGate:ConcurrencyGate;interactiveGate:ConcurrencyGate;interactiveModelGate:ConcurrencyGate;diagnostics:ServerDiagnostics;providerAdmission:ProviderAdmission;maintenanceSnapshot:()=>ReturnType<MaintenanceWorker['snapshot']>|null;delegatedSnapshot?:()=>ReturnType<ExecutionEngine['poolSnapshot']>;wakeMemory:()=>void}){
  app.get('/api/execution-settings',async()=>({...runtimeSettings.executionView(),queues:{agents:agentGate.snapshot(),llm:llmGate.snapshot(),interactive:interactiveGate.snapshot(),interactiveHarness:interactiveModelGate.snapshot(),delegated:delegatedSnapshot?.(),maintenance:maintenanceSnapshot()},modelQuotaUnit:'harness_session',providers:providerAdmission.snapshot()}));
  app.put('/api/execution-settings',async req=>runtimeSettings.saveExecution(req.body));
  app.get('/api/diagnostics-settings',async()=>runtimeSettings.diagnosticsView());
  app.put('/api/diagnostics-settings',async req=>runtimeSettings.saveDiagnostics(req.body));
}
