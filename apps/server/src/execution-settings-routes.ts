import type {FastifyInstance} from 'fastify';
import type {ExecutionSettings} from './execution-settings.js';
import type {ConcurrencyGate} from './concurrency.js';
import type {ServerDiagnostics} from './diagnostics.js';
import type {ProviderAdmission} from './provider-admission.js';
import type {MaintenanceWorker} from './maintenance.js';
export function registerExecutionSettingsRoutes(app:FastifyInstance,{runtimeSettings,agentGate,llmGate,interactiveGate,interactiveModelGate,diagnostics,providerAdmission,maintenanceSnapshot,wakeMemory}:{runtimeSettings:ExecutionSettings;agentGate:ConcurrencyGate;llmGate:ConcurrencyGate;interactiveGate:ConcurrencyGate;interactiveModelGate:ConcurrencyGate;diagnostics:ServerDiagnostics;providerAdmission:ProviderAdmission;maintenanceSnapshot:()=>ReturnType<MaintenanceWorker['snapshot']>|null;wakeMemory:()=>void}){
  app.get('/api/execution-settings',async()=>({...runtimeSettings.execution(),queues:{agents:agentGate.snapshot(),llm:llmGate.snapshot(),interactive:interactiveGate.snapshot(),interactiveHarness:interactiveModelGate.snapshot(),maintenance:maintenanceSnapshot()},modelQuotaUnit:'harness_session',providers:providerAdmission.snapshot()}));
  app.put('/api/execution-settings',async req=>{const value=runtimeSettings.saveExecution(req.body);interactiveGate.configure(value.interactiveConcurrency);interactiveModelGate.configure(value.interactiveConcurrency);agentGate.configure(value.agentConcurrency);llmGate.configure(value.llmConcurrency);wakeMemory();return value;});
  app.get('/api/diagnostics-settings',async()=>runtimeSettings.diagnostics());
  app.put('/api/diagnostics-settings',async req=>{const value=runtimeSettings.saveDiagnostics(req.body);await diagnostics.configure(value);return value;});
}
