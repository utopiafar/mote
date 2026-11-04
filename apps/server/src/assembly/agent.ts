import {randomUUID} from 'node:crypto';
import type {AsyncLocalStorage} from 'node:async_hooks';
import type {ContextReader,QueryInput} from '@mote/agent';
import type {QueryAgent} from '../query-agent.js';
import {DEPLOYMENT_MODEL_PROFILE_ID} from '@mote/shared/models';
import type {Config} from '../config.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {ServerResources} from '../server-resources.js';
import type {EvidenceReader} from '../evidence-reader.js';
import type {ObservationName} from '../execution-observability.js';
import type {ConfigurationPlatform} from '../plugins/configuration-platform.js';
import type {ModelAuthorizationHost} from '../model-authorization-host.js';
import {agentModelConnection} from '../model-authorization-host.js';
import {applyModelSettings,modelSettingsFromConfig,testModelConnection,type ModelAgentFactory,type ModelAgentIdentity} from '../model-agent.js';
import {AgentRuntimeRegistry,type AgentRuntimeRegistryDependencies} from '../agent-runtime-registry.js';

export interface AgentAssemblyDependencies extends Omit<AgentRuntimeRegistryDependencies,'codex'|'archiveImagesEnabled'|'retainSnapshot'|'releaseSnapshot'|'agentStarted'|'recordTiming'> {
  readonly config:Config;
  readonly resources:ServerResources;
  readonly diagnostics:ServerDiagnostics;
  readonly configurationPlatform:Pick<ConfigurationPlatform,'bindModels'>;
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

/** The runtime registry owns the model factory, every prepared/retired model
 * generation and the AGENT prepare/probe binding that publishes model
 * selection — including one close hook for all of them. */
export async function assembleAgent(dependencies:AgentAssemblyDependencies){
  const {config,resources,diagnostics}=dependencies;
  const codex={executable:config.codexBin,home:config.codexHome};
  const runtime=new AgentRuntimeRegistry({
    codex,createModelAgent:dependencies.createModelAgent,authorization:dependencies.authorization,admission:dependencies.admission,
    runModelFor:dependencies.runModelFor,authorizeModelRequest:dependencies.authorizeModelRequest,assertPurpose:dependencies.assertPurpose,assertEvidence:dependencies.assertEvidence,assertEvidenceAsync:dependencies.assertEvidenceAsync,pinEvidence:dependencies.pinEvidence,
    agentGate:dependencies.agentGate,interactiveGate:dependencies.interactiveGate,modelContext:dependencies.modelContext,modelOperation:dependencies.modelOperation,archiveImagesEnabled:dependencies.allowQueryImages,
    retainSnapshot:input=>dependencies.observeMemory(input,'catalog_snapshot',()=>dependencies.evidenceReader.retainMemorySnapshot(input)),
    releaseSnapshot:input=>dependencies.evidenceReader.releaseMemorySnapshot(input),agentStarted:()=>dependencies.queryAccounting.getStore()?.agentStarted(),
    recordTiming:(input,timing)=>diagnostics.record('agent.fragment_timing',{jobId:input.traceContext?.jobId,batchId:input.traceContext?.batchId,unit:'agent_fragment',...timing},'info'),
  },()=>diagnostics.record('agent.failed',{category:'internal'},'error'));
  resources.defer(()=>runtime.close());
  const factory:ModelAgentFactory=runtime.factory;
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
  return Object.freeze({agent:runtime,factory,codex});
}
