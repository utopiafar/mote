import {AsyncLocalStorage} from 'node:async_hooks';
import {dirname,join} from 'node:path';
import {AgentYieldError} from '@mote/agent';
import type {QueryInput} from '@mote/agent';
import type {Config} from '../config.js';
import type {Connections} from '../connections.js';
import type {Store} from '../store.js';
import {moteText} from '../i18n.js';
import {defaultLogMaxBytes} from '../log-retention-config.mjs';
import type {ModelConnection} from '../background-model-authorization.js';
import type {ObservationIdentity,ObservationName} from '../execution-observability.js';
import type {ServerResources} from '../server-resources.js';
import type {bootstrapCentral,CentralDomainPlugin} from '../bootstrap.js';
import {createAuthorizationPlatform,authorizationPlatformContribution,authorizationPlatformDeclaration,authorizationPlatformReplacement} from '../plugins/authorization-platform.js';
import {observabilityPlatformContribution,observabilityPlatformDeclaration,observabilityPlatformReplacement} from '../plugins/observability-platform.js';
import {createExecutionPlatform,executionPlatformContribution,executionPlatformDeclaration,executionPlatformReplacement} from '../plugins/execution-platform.js';
import {pluginControlContribution,pluginControlDeclaration} from '../plugin-center.js';

/** Declared build-time domain plugins the platform assembly wires; the
 * distribution concatenates each domain's list into one selected table. */
export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
  {contribution:authorizationPlatformContribution,declaration:authorizationPlatformDeclaration,replacement:authorizationPlatformReplacement},
  {contribution:observabilityPlatformContribution,declaration:observabilityPlatformDeclaration,replacement:observabilityPlatformReplacement},
  {contribution:executionPlatformContribution,declaration:executionPlatformDeclaration,replacement:executionPlatformReplacement},
  {contribution:pluginControlContribution,declaration:pluginControlDeclaration,replacement:'hot'},
]);

export interface PlatformAssemblyDependencies {
  readonly bootstrap:Awaited<ReturnType<typeof bootstrapCentral>>;
  readonly config:Config;
  readonly store:Store;
  readonly resources:ServerResources;
  readonly serverVersion:string;
  readonly availableModelConnections:()=>ModelConnection[];
  readonly connections?:Connections;
  /** Late-bound by the trusted root once the evidence authority exists; the
   * model gates only invoke it inside admitted work, never during assembly. */
  readonly assertModelEvidence:(input:QueryInput|undefined)=>void;
}

/** Authorization, observability and execution platform construction plus the
 * model admission/observation wiring that app.ts previously held inline. */
export async function assemblePlatform(dependencies:PlatformAssemblyDependencies){
  const {bootstrap,config,store,resources}=dependencies;
  const authorizationPlatform=createAuthorizationPlatform({ownerToken:config.token,connectorConfiguration:()=>config.connectors,allowedOrigins:config.allowedOrigins},{
    store,availableModelConnections:()=>dependencies.availableModelConnections(),...(dependencies.connections?{connections:dependencies.connections}:{}),
  });
  resources.defer(()=>authorizationPlatform.close());
  await authorizationPlatform.prepare();
  const modelAuthorization=authorizationPlatform.assembly.modelAuthorization;
  const runtimeSettings=bootstrap.configurationPlatform.runtimeSettings;
  const observability=await bootstrap.installObservabilityPlatform({
    logDirectory:config.logDirectory??join(config.dataDir,'logs'),
    diagnostics:{...runtimeSettings.diagnostics(),maxBytes:config.logMaxBytes??defaultLogMaxBytes(config.profile),maxFiles:config.logMaxFiles,maxEntries:config.logMaxEntries},
    update:{currentVersion:dependencies.serverVersion,profile:config.profile,runtime:config.configuration?.runtime,profileHome:config.configuration?.hostConfigFile?dirname(dirname(config.configuration.hostConfigFile)):undefined,repository:config.updateRepository,channel:config.updateChannel},
    eventLoopResolutionMs:20,
  });
  const observabilityPlatform=observability.platform,observabilityScope=observability.scope,observabilityAssembly=observabilityPlatform.forAssembly(observability.scope);
  const diagnostics=observabilityAssembly.diagnostics,executionObserver=observabilityAssembly.observer,eventLoop=observabilityAssembly.eventLoop,usageLedger=observabilityAssembly.usage,softwareUpdate=observabilityAssembly.softwareUpdate;
  resources.defer(()=>observabilityPlatform.close());
  const executionPlatform=createExecutionPlatform({store,modelAuthorization,settings:runtimeSettings});
  resources.defer(()=>executionPlatform.stop('shutdown'));
  await executionPlatform.prepare();executionPlatform.start();
  const {executor,providerAdmission,agentGate,llmGate,interactiveGate,interactiveModelGate}=executionPlatform.assembly;
  const modelContext=new AsyncLocalStorage<QueryInput>();
  const modelOperation=new AsyncLocalStorage<string>();
  // Accounting observes trusted admission boundaries, independently of model
  // input. A host cooldown or gate cancellation can happen before any call.
  const queryAccounting=new AsyncLocalStorage<{agentStarted:()=>void;modelQueued:()=>void;modelStarted:()=>void}>();
  const assertModelPurpose=(_input?:QueryInput)=>{};
  const authorizeModelRequest=()=>{modelAuthorization.assertCurrent();assertModelPurpose(modelContext.getStore());dependencies.assertModelEvidence(modelContext.getStore());};
  const runModelFor=(settings:import('@mote/shared/models').ModelSettings,connection?:ModelConnection):NonNullable<import('@mote/agent').AgentOptions['runModel']>=>(task,signal)=>{
    const assertAuthority=connection?modelAuthorization.capture(connection):undefined;assertAuthority?.();
    signal?.throwIfAborted();assertModelPurpose(modelContext.getStore());providerAdmission.check(settings);
    const queuedAt=performance.now(),input=modelContext.getStore(),gate=input?.executionLane==='interactive'?interactiveModelGate:llmGate;input?.onTrace?.({type:'model.queued',stage:'model',payload:{...gate.snapshot(),unit:'harness_session',lane:input?.executionLane??'background'}});
    input?.onProgress?.({stage:'model',message:moteText('等待模型执行名额')});
    queryAccounting.getStore()?.modelQueued();
    return gate.run(async()=>{assertAuthority?.();providerAdmission.check(settings);dependencies.assertModelEvidence(input);input?.onProgress?.({stage:'model',message:moteText('模型处理中')});const admittedAt=performance.now(),lane=input?.executionLane??'background',queueWaitMs=admittedAt-queuedAt;input?.onTrace?.({type:'model.admitted',stage:'model',payload:{...gate.snapshot(),unit:'harness_session',lane,queueWaitMs}});let status:'completed'|'failed'|'yielded'='failed';
      try{queryAccounting.getStore()?.modelStarted();const result=await task();status='completed';return result;}
      catch(error){if(error instanceof AgentYieldError)status='yielded';throw error;}
      finally{diagnostics.record('agent.harness_timing',{jobId:input?.traceContext?.jobId,batchId:input?.traceContext?.batchId,lane,unit:'harness_session',queueWaitMs,durationMs:performance.now()-admittedAt,status},'info');}
    },signal??input?.signal,input?.traceContext?.operationId??modelOperation.getStore());
  };
  const observationIdentity=(input:QueryInput):ObservationIdentity=>({jobId:input.traceContext?.jobId,batchId:input.traceContext?.batchId,attempt:input.traceContext?.attempt,
    phase:input.traceContext?.phase==='coding-understanding'?'coding_understanding':input.traceContext?.phase==='review'?'review':'extract'});
  const observeMemory=<T>(input:QueryInput|undefined,name:ObservationName,work:()=>T):T=>input?.responseMode==='memory-extraction'?executionObserver.sync(name,observationIdentity(input),work):work();
  const observeMemoryAsync=<T>(input:QueryInput|undefined,name:ObservationName,work:()=>Promise<T>):Promise<T>=>input?.responseMode==='memory-extraction'?executionObserver.async(name,observationIdentity(input),work):work();
  executor.bindObserver(value=>executionObserver.lease(value),()=>executionObserver.enabled());
  return Object.freeze({authorizationPlatform,modelAuthorization,runtimeSettings,observabilityPlatform,observabilityScope,observabilityAssembly,diagnostics,executionObserver,eventLoop,usageLedger,softwareUpdate,executionPlatform,executor,providerAdmission,agentGate,llmGate,interactiveGate,interactiveModelGate,modelContext,modelOperation,queryAccounting,assertModelPurpose,authorizeModelRequest,runModelFor,observeMemory,observeMemoryAsync});
}
