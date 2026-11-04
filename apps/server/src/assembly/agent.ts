import {randomUUID} from 'node:crypto';
import type {AsyncLocalStorage} from 'node:async_hooks';
import type {Context} from '@deepseek-ai/cordis';
import type {FastifyInstance} from 'fastify';
import type {ContextReader,QueryInput} from '@mote/agent';
import type {QueryAgent} from '../query-agent.js';
import {DEPLOYMENT_MODEL_PROFILE_ID} from '@mote/shared/models';
import type {Config} from '../config.js';
import type {ConfigService} from '../config-service.js';
import type {ConcurrencyGate} from '../concurrency.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {ExecutionSettings} from '../execution-settings.js';
import type {ServerResources} from '../server-resources.js';
import type {FeatureServices} from '../feature-services.js';
import type {EvidenceReader} from '../evidence-reader.js';
import type {MaintenanceWorker} from '../maintenance.js';
import type {LifecycleSettings} from '../memory-lifecycle.js';
import type {ObservationName} from '../execution-observability.js';
import type {ProviderAdmission} from '../provider-admission.js';
import type {CentralDomainPlugin,bootstrapCentral} from '../bootstrap.js';
import type {ConfigurationPlatform} from '../plugins/configuration-platform.js';
import type {ModelAuthorizationHost} from '../model-authorization-host.js';
import {agentModelConnection} from '../model-authorization-host.js';
import {applyModelSettings,modelSettingsFromConfig,testModelConnection,type ModelAgentFactory,type ModelAgentIdentity} from '../model-agent.js';
import type {AgentRuntimeRegistryDependencies} from '../agent-runtime-registry.js';
import {contributeDomainRoutes} from '../plugins/domain-routes.js';
import {agentRuntimeContribution,agentRuntimeDeclaration,agentRuntimeReplacement,createAgentRuntimeServices} from '../plugins/agent-runtime.js';

/** A09's declared build-time domain plugin; the distribution concatenates each
 * domain's list into one selected table. */
export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
  {contribution:agentRuntimeContribution,declaration:agentRuntimeDeclaration,replacement:agentRuntimeReplacement},
]);

export interface AgentAssemblyDependencies extends Omit<AgentRuntimeRegistryDependencies,'codex'|'archiveImagesEnabled'|'retainSnapshot'|'releaseSnapshot'|'agentStarted'|'recordTiming'|'agentGate'|'interactiveGate'> {
  readonly config:Config;
  readonly resources:ServerResources;
  readonly diagnostics:ServerDiagnostics;
  readonly backendContext:Context;
  readonly configurationPlatform:Pick<ConfigurationPlatform,'bindModels'|'modelSettings'>;
  readonly configService:ConfigService;
  readonly runtimeSettings:ExecutionSettings;
  readonly agentGate:ConcurrencyGate;
  readonly llmGate:ConcurrencyGate;
  readonly interactiveGate:ConcurrencyGate;
  readonly interactiveModelGate:ConcurrencyGate;
  readonly providerAdmission:ProviderAdmission;
  readonly insightSettings:()=>LifecycleSettings['insights'];
  readonly maintenanceSnapshot:()=>ReturnType<MaintenanceWorker['snapshot']>|null;
  readonly delegatedSnapshot:()=>ReturnType<ExecutionEngine['poolSnapshot']>;
  readonly wakeMemory:()=>void;
  readonly reader:ContextReader;
  readonly modelAuthorizationHost:Pick<ModelAuthorizationHost,'manual'>;
  readonly queryAccounting:AsyncLocalStorage<{agentStarted:()=>void;modelQueued:()=>void;modelStarted:()=>void}>;
  /** Late-bound: perception is assembled after the runtime host and its gate is
   * only read inside admitted agent work. */
  readonly allowQueryImages:()=>boolean;
  readonly observeMemory:<T>(input:QueryInput|undefined,name:ObservationName,work:()=>T)=>T;
  readonly evidenceReader:Pick<EvidenceReader,'retainMemorySnapshot'|'releaseMemorySnapshot'>;
  /** Test injection wraps a supplied agent with the deployment profile identity. */
  readonly agent?:QueryAgent;
}

/** The agent-runtime plugin owns the model factory, every prepared/retired
 * model generation, the AGENT prepare/probe binding that publishes model
 * selection and the mote.models route table — including one close hook. */
export async function assembleAgent(dependencies:AgentAssemblyDependencies){
  const {config,resources,diagnostics}=dependencies;
  const services=createAgentRuntimeServices({
    config,diagnostics,
    agentGate:dependencies.agentGate,llmGate:dependencies.llmGate,interactiveGate:dependencies.interactiveGate,interactiveModelGate:dependencies.interactiveModelGate,
    onCloseError:()=>diagnostics.record('agent.failed',{category:'internal'},'error'),
    registry:{
      createModelAgent:dependencies.createModelAgent,authorization:dependencies.authorization,admission:dependencies.admission,
      runModelFor:dependencies.runModelFor,authorizeModelRequest:dependencies.authorizeModelRequest,assertPurpose:dependencies.assertPurpose,assertEvidence:dependencies.assertEvidence,assertEvidenceAsync:dependencies.assertEvidenceAsync,pinEvidence:dependencies.pinEvidence,
      modelContext:dependencies.modelContext,modelOperation:dependencies.modelOperation,archiveImagesEnabled:dependencies.allowQueryImages,
      retainSnapshot:input=>dependencies.observeMemory(input,'catalog_snapshot',()=>dependencies.evidenceReader.retainMemorySnapshot(input)),
      releaseSnapshot:input=>dependencies.evidenceReader.releaseMemorySnapshot(input),agentStarted:()=>dependencies.queryAccounting.getStore()?.agentStarted(),
      recordTiming:(input,timing)=>diagnostics.record('agent.fragment_timing',{jobId:input.traceContext?.jobId,batchId:input.traceContext?.batchId,unit:'agent_fragment',...timing},'info'),
    },
    routes:{
      modelSettings:()=>dependencies.configurationPlatform.modelSettings,configService:dependencies.configService,runtimeSettings:dependencies.runtimeSettings,
      insightSettings:dependencies.insightSettings,providerAdmission:dependencies.providerAdmission,
      maintenanceSnapshot:dependencies.maintenanceSnapshot,delegatedSnapshot:dependencies.delegatedSnapshot,wakeMemory:dependencies.wakeMemory,
    },
  });
  resources.defer(()=>services.close());
  services.prepare();
  const runtime=services.agent,factory:ModelAgentFactory=runtime.factory,codex=services.codex;
  let initialAgent=dependencies.agent?runtime.wrap(dependencies.agent,modelSettingsFromConfig(config),{kind:'profile',id:DEPLOYMENT_MODEL_PROFILE_ID}):undefined;
  await dependencies.configurationPlatform.bindModels({
    codex,
    prepare:async (settings,profiles,defaultProfileId,previousSettings)=>{
      const initial=initialAgent;initialAgent=undefined;
      return runtime.prepareModels(profiles,dependencies.reader,{defaultProfileId,initialAgent:initial,
        activate:()=>applyModelSettings(config,settings),rollback:()=>applyModelSettings(config,previousSettings??settings)});
    },
    probe:settings=>testModelConnection(settings,async(selected,reader)=>{
      const id=randomUUID(),identity:ModelAgentIdentity={kind:'probe',id},candidate=await factory(selected,reader,undefined,identity),connection=agentModelConnection(identity,selected);
      return {...candidate,query:input=>dependencies.modelAuthorizationHost.manual('model-probe:'+id,[connection],signal=>candidate.query({...input,signal}),input.signal,'probe')};
    }),
  });
  services.start();
  contributeDomainRoutes(dependencies.backendContext,{'mote.models':Object.freeze({mount:(app:FastifyInstance)=>services.routes(app)})});
  return Object.freeze({agent:runtime,factory,codex,featureServices:Object.freeze({agent:runtime}) satisfies Partial<FeatureServices>});
}
