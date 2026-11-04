import {randomUUID} from 'node:crypto';
import type {AsyncLocalStorage} from 'node:async_hooks';
import type {ContextReader,QueryInput} from '@mote/agent';
import type {QueryAgent} from '../query-agent.js';
import {DEPLOYMENT_MODEL_PROFILE_ID} from '@mote/shared/models';
import type {Config} from '../config.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {ServerResources} from '../server-resources.js';
import type {Store} from '../store.js';
import type {EvidenceReader} from '../evidence-reader.js';
import type {ObservationName} from '../execution-observability.js';
import type {ConfigurationPlatform} from '../plugins/configuration-platform.js';
import {Conversations} from '../conversations.js';
import {AgentRuntimeHost,type AgentRuntimeHostDependencies} from '../agent-runtime-host.js';
import type {ModelAuthorizationHost} from '../model-authorization-host.js';
import {agentModelConnection} from '../model-authorization-host.js';
import {ReloadableAgent,applyModelSettings,createModelRegistry,modelSettingsFromConfig,testModelConnection,type ModelAgentFactory,type ModelAgentIdentity} from '../model-agent.js';

export interface AgentInputDependencies {
  readonly store:Store;
  readonly modelAuthorizationHost:Pick<ModelAuthorizationHost,'conversation'>;
}

/** Conversation storage and its turn-authority callback; the query domain and
 * the evidence authority below consume it during their own assembly. */
export function agentInputs(dependencies:AgentInputDependencies){
  const conversations=new Conversations(dependencies.store);
  conversations.onTurnReceived=turnId=>dependencies.modelAuthorizationHost.conversation(turnId);
  return Object.freeze({conversations});
}

export interface AgentAssemblyDependencies extends Omit<AgentRuntimeHostDependencies,'codex'|'archiveImagesEnabled'|'retainSnapshot'|'releaseSnapshot'|'agentStarted'|'recordTiming'> {
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

/** ReloadableAgent, the Host runtime/factory and the AGENT prepare/probe
 * binding that publishes model selection — including their close hooks. */
export async function assembleAgent(dependencies:AgentAssemblyDependencies){
  const {config,resources,diagnostics}=dependencies;
  const agent=new ReloadableAgent(()=>diagnostics.record('agent.failed',{category:'internal'},'error'));
  resources.defer(()=>agent.close());
  const codex={executable:config.codexBin,home:config.codexHome};
  const runtimeHost:AgentRuntimeHost=new AgentRuntimeHost({
    codex,createModelAgent:dependencies.createModelAgent,authorization:dependencies.authorization,admission:dependencies.admission,
    runModelFor:dependencies.runModelFor,authorizeModelRequest:dependencies.authorizeModelRequest,assertPurpose:dependencies.assertPurpose,assertEvidence:dependencies.assertEvidence,assertEvidenceAsync:dependencies.assertEvidenceAsync,pinEvidence:dependencies.pinEvidence,
    agentGate:dependencies.agentGate,interactiveGate:dependencies.interactiveGate,modelContext:dependencies.modelContext,modelOperation:dependencies.modelOperation,archiveImagesEnabled:dependencies.allowQueryImages,
    retainSnapshot:input=>dependencies.observeMemory(input,'catalog_snapshot',()=>dependencies.evidenceReader.retainMemorySnapshot(input)),
    releaseSnapshot:input=>dependencies.evidenceReader.releaseMemorySnapshot(input),agentStarted:()=>dependencies.queryAccounting.getStore()?.agentStarted(),
    recordTiming:(input,timing)=>diagnostics.record('agent.fragment_timing',{jobId:input.traceContext?.jobId,batchId:input.traceContext?.batchId,unit:'agent_fragment',...timing},'info'),
  });
  resources.defer(()=>runtimeHost.close());
  const factory:ModelAgentFactory=runtimeHost.factory;
  let initialAgent=dependencies.agent?runtimeHost.wrap(dependencies.agent,modelSettingsFromConfig(config),{kind:'profile',id:DEPLOYMENT_MODEL_PROFILE_ID}):undefined;
  await dependencies.configurationPlatform.bindModels({
    codex,
    prepare:async (settings,profiles,defaultProfileId,previousSettings)=>{
      const candidate=await createModelRegistry(profiles,dependencies.reader,factory,initialAgent,defaultProfileId);initialAgent=undefined;
      return agent.prepare(candidate,()=>applyModelSettings(config,settings),()=>applyModelSettings(config,previousSettings??settings));
    },
    probe:settings=>testModelConnection(settings,async(selected,reader)=>{
      const id=randomUUID(),identity:ModelAgentIdentity={kind:'probe',id},candidate=await factory(selected,reader,undefined,identity),connection=agentModelConnection(identity,selected);
      return {...candidate,query:input=>dependencies.modelAuthorizationHost.manual('model-probe:'+id,[connection],signal=>candidate.query({...input,signal}),input.signal,'probe')};
    }),
  });
  return Object.freeze({agent,runtimeHost,factory,codex});
}
