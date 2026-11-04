import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Context} from '@deepseek-ai/cordis';
import type {bootstrapCentral,CentralDomainPlugin} from '../bootstrap.js';
import {centralServices} from '../plugins/central-contracts.js';
import {contributeDomainRoutes} from '../plugins/domain-routes.js';
import {createConversations,createConversationsFactory,createConversationRoutes,conversationsContribution,conversationsDeclaration,conversationsReplacement,type ConversationsBindings} from '../plugins/conversations.js';
import {createQueryRunsFactory,createQueryRunsPlatform,queryRunsContribution,queryRunsDeclaration,queryRunsReplacement,type QueryRunDependencies,type QueryRunsStarted} from '../plugins/query-runs.js';
import {registerQueryRunRoutes} from '../features/ask/query-runs.js';
import {AgentNotConfiguredError,AgentYieldError,type AgentProgress,type AgentTraceEvent,type ContextReader,type QueryInput} from '@mote/agent';
import {ProviderFailure,type InsightSnapshot,type QueryResult} from '@mote/shared';
import type {AgentRunFinalizer,QueryRunLease} from '../query-agent.js';
import type {Store} from '../store.js';
import {StoreError} from '../store.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {AgentTraceContext} from '../diagnostics.js';
import type {ServerResources} from '../server-resources.js';
import type {ServerLifecycle} from './lifecycle.js';
import type {ExecutionEngine} from '../execution-engine.js';
import {ExecutionFailure} from '../execution-engine.js';
import type {ConcurrencyGate} from '../concurrency.js';
import type {ModelSettingsStore} from '../model-settings.js';
import {modelConfiguration} from '../model-configuration.js';
import type {ReloadableAgent} from '../model-agent.js';
import type {BackgroundModelAuthorization,AutomaticModelPurpose,ModelConnection} from '../background-model-authorization.js';
import {sourceModelIdentity,type ModelAuthorizationHost} from '../model-authorization-host.js';
import type {SourceContextStore} from '../source-context.js';
import type {createModelEvidenceAuthority} from '../model-evidence-authority.js';
import {contextFailure} from '../model-evidence-authority.js';
import {createMemoryModelAuthorityJobReader} from '../memory-model-authority.js';
import {createHostRunUsageObserver} from '../agent-runtime-events.js';
import {agentDeadline} from '../agent-deadline.js';
import {retainFailureContext} from '../execution-failures.js';
import {resolveDependencies,combineDependencies} from '../conversation-lineage.js';
import {assertSourceContextDependencies,combineSourceContextDependencies} from '../source-context-lineage.js';
import {moteText,requestLocale} from '../i18n.js';
import {insightResult,validateInsightOutput} from '../insights.js';
import type {QueryScope} from '../query-scope.js';
import type {ObservabilityAssembly} from '../plugins/observability-platform.js';
import type {AdmittedUsageMeter as ObservabilityUsageMeter} from '../plugins/observability-platform.js';
import type {AdmittedUsageMeter} from './processing.js';

export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
  {contribution:conversationsContribution,declaration:conversationsDeclaration,replacement:conversationsReplacement},
  {contribution:queryRunsContribution,declaration:queryRunsDeclaration,replacement:queryRunsReplacement},
]);

export interface ConversationInputDependencies {
  readonly bootstrap:Awaited<ReturnType<typeof bootstrapCentral>>;
  readonly store:Store;
  readonly resources:ServerResources;
  readonly backendContext:Context;
  readonly modelAuthorizationHost:Pick<ModelAuthorizationHost,'conversation'>;
}

/** Install the conversation owner and lend its gated repository to the remaining
 * query, Memory and evidence-authority consumers through one host lease. */
export async function prepareConversations(dependencies:ConversationInputDependencies){
  const platform=createConversations(dependencies.store,dependencies.modelAuthorizationHost),routes=createConversationRoutes();
  let bindings:ConversationsBindings|undefined;
  const handle=await dependencies.bootstrap.host.install({
    identity:{host:dependencies.bootstrap.snapshot().host,packageId:'mote.conversations',installationId:'build:conversations@1.0.0',instanceId:'query',activationId:randomUUID()},
    contributions:[conversationsDeclaration],factory:createConversationsFactory(platform,value=>{bindings=value;routes.activate(platform.conversations);}),
  });
  dependencies.resources.defer(()=>handle.close('shutdown'));
  const lease=await dependencies.bootstrap.host.acquire(centralServices.conversations,bindings!.conversations);
  dependencies.resources.defer(()=>lease.release());
  contributeDomainRoutes(dependencies.backendContext,{'mote.ask':routes});
  return Object.freeze({conversations:lease.value});
}

/** The query metering factory app.ts wires over the shared admitted-usage
 * meter; the optional route delegates host-run accounting to the Host meter. */
export type QueryUsageFactory=(route?:{mode:()=>AgentRunFinalizer|undefined;host?:()=>ObservabilityUsageMeter|undefined})=>AdmittedUsageMeter;

export interface QueryRuntimeDependencies {
  readonly store:Store;
  readonly resources:ServerResources;
  readonly lifecycle:ServerLifecycle;
  readonly diagnostics:ServerDiagnostics;
  readonly modelAuthorization:Pick<BackgroundModelAuthorization,'bindCurrentStep'>;
  readonly modelAuthorizationHost:Pick<ModelAuthorizationHost,'automatic'|'evidenceTriggers'|'queryTriggers'>;
  readonly executor:Pick<ExecutionEngine,'get'>;
  readonly agentGate:Pick<ConcurrencyGate,'snapshot'>;
  readonly modelSettings:ModelSettingsStore;
  readonly agent:Pick<ReloadableAgent,'configured'|'query'>;
  readonly observabilityAssembly:Pick<ObservabilityAssembly,'admittedUsage'>;
  readonly admittedUsageFactory:QueryUsageFactory;
  readonly modelEvidenceAuthority:Pick<ReturnType<typeof createModelEvidenceAuthority>,'contextDependencies'|'sourceContextDependencies'|'pinProcessingEvidence'>;
  readonly assertModelEvidence:(input:QueryInput|undefined)=>void;
  readonly sourceContexts:SourceContextStore;
}

/** The admitted query path: automatic model authority, per-query run
 * accounting, trace/usage observation and the insight entry — plus the
 * shutdown drain that settles accepted queries before the agent closes. */
export function assembleQueryRuntime(dependencies:QueryRuntimeDependencies){
  const {store,resources,lifecycle,diagnostics,modelAuthorization,modelAuthorizationHost,executor,agentGate,modelSettings,agent,observabilityAssembly,admittedUsageFactory,assertModelEvidence,sourceContexts}=dependencies;
  const {contextDependencies,sourceContextDependencies,pinProcessingEvidence}=dependencies.modelEvidenceAuthority;
  const memoryModelAuthorityJobs=createMemoryModelAuthorityJobReader(store);
  const activeQueries=new Set<Promise<QueryResult>>();
  resources.defer(async()=>{lifecycle.markClosing();await Promise.allSettled([...activeQueries]);});
  function withQueryModelAuthority<T>(input:QueryInput,moduleId:string,task:(signal:AbortSignal)=>Promise<T>){
    const job=input.traceContext?.jobId?memoryModelAuthorityJobs.modelAuthorityJob(input.traceContext.jobId):undefined;
    const grants=job?.automaticGrants??[];
    const candidates=()=>grants.length?grants.map(grant=>sourceModelIdentity(grant.sourceId,grant.inputKey)):job?modelAuthorizationHost.evidenceTriggers(job.evidenceIds):modelAuthorizationHost.queryTriggers(input);
    // Each owner-selected recipe is an independent prospective consumer. Its
    // immutable input grant scope prevents one sibling from consuming another's
    // trigger, without letting retries mint a new purpose from their job ID.
    const memoryScope=grants[0]?.scope;
    if(memoryScope&&grants.some(grant=>grant.scope!==memoryScope))throw new StoreError('Memory job mixes recipe authorization scopes',409);
    const purpose:AutomaticModelPurpose=moduleId==='memories'&&memoryScope?`memory:${memoryScope}`:moduleId==='activity'?'activity':moduleId==='actions'?'actions':moduleId==='insights'?'insight':moduleId==='memories'?'memory':moduleId==='semantic'?'semantic':'working';
    const id=job?'automatic-memory:'+job.id:'automatic-'+moduleId+':'+(input.traceContext?.operationId??randomUUID());
    return modelAuthorizationHost.automatic(id,purpose,candidates,signal=>{
      const batch=input.traceContext?.batchId?executor.get(input.traceContext.batchId):undefined;
      if(job&&batch?.kind==='memory.batch'&&batch.input.jobId===job.id)modelAuthorization.bindCurrentStep(batch);
      return task(signal);
    },input.signal);
  }
  function queryAgent(input:QueryInput,operation:'query'|'insight'='query',moduleId='conversations',usageOwner:'query'|'caller'='query') {
    return withQueryModelAuthority(input,moduleId,signal=>queryAgentAuthorized({...input,signal},operation,moduleId,usageOwner));
  }
  function queryAgentAuthorized(input:QueryInput,operation:'query'|'insight'='query',moduleId='conversations',usageOwner:'query'|'caller'='query') {
    if(lifecycle.isClosing())throw new StoreError('Central node is shutting down',503);
    input=pinProcessingEvidence(input);
    if(input.skill==='personal-insight'&&!input.validateOutput)input={...input,validateOutput:validateInsightOutput};
    const profile=modelSettings.select(input.responseMode==='memory-extraction'||input.skill==='memory-extraction'||input.skill==='coding-memory'||moduleId==='memories'?'memory':input.skill==='personal-insight'?'insight':'chat',input.modelProfileId);
    input={...input,language:input.language??requestLocale.getStore()??'zh-CN',modelProfileId:profile.id,modelOverride:input.modelOverride??profile.settings.model};
    if(input.contextEvidenceDependencies)input={...input,contextEvidenceDependencies:resolveDependencies(store,input.contextEvidenceDependencies)};
    const configuration=modelConfiguration(profile.id,{...profile.settings,model:input.modelOverride!},modelSettings.view().revision);
    const traceContext:AgentTraceContext={...input.traceContext,traceId:randomUUID(),requestId:diagnostics.requestId(),operation,moduleId,profileId:profile.id,provider:profile.settings.provider,protocol:profile.settings.protocol,model:input.modelOverride??profile.settings.model};
    const startedAt=Date.now();let lastActivity=startedAt,failureRunId:string|undefined;
    const trace=(event:AgentTraceEvent)=>{
      if(event.runId)failureRunId=event.runId;
      lastActivity=Date.now();diagnostics.agentTrace(event,traceContext);
      if(event.type==='tool.rejected'){
        const payload=(event.payload??{}) as Record<string,unknown>;
        diagnostics.record('agent.tool_rejected',{requestId:traceContext.requestId,jobId:traceContext.jobId,batchId:traceContext.batchId,batchIndex:traceContext.batchIndex,attempt:traceContext.attempt,runId:event.runId,
          toolErrorCode:typeof payload.code==='string'?payload.code:undefined,
          remainingCalls:typeof payload.remainingCalls==='number'?payload.remainingCalls:undefined,
          remainingCharacters:typeof payload.remainingCharacters==='number'?payload.remainingCharacters:undefined,
          repeatCount:typeof payload.repeatCount==='number'?payload.repeatCount:undefined},'warn');
      }
      input.onTrace?.(event);
    };
    trace({type:'query.started',stage:'starting',payload:{question:input.question,taskContext:input.taskContext??null,conversation:input.conversation??null,evidenceIds:input.evidenceIds??null,evidenceRanges:input.evidenceRanges??null,evidenceReadRanges:input.evidenceReadRanges??null,scope:{after:input.after??null,before:input.before??null,deviceId:input.deviceId??null,timeZone:input.timeZone??null},skill:input.skill??null,responseMode:input.responseMode??'answer'}});
    const revision=store.deletionRevision();
    const usageAttribution={agentId:'context-query',moduleId,skillId:input.skill??null,operationId:input.traceContext?.operationId,jobId:input.traceContext?.jobId,requestId:diagnostics.requestId()};
    // Trusted per-query run accounting. Only app callbacks mutate this state and
    // none of them throw: observation isolation must not govern execution.
    const runState:{mode?:AgentRunFinalizer;runId?:string;hostEvents:boolean;hostTerminal:boolean;violation?:string}={hostEvents:false,hostTerminal:false};
    // The Host path owns usage through one C06 receipt; capture its terminal
    // receipt so the response reports the finalized sample without a second
    // finalize. Constructing this meter writes nothing until a model starts.
    const hostMeterBase=usageOwner==='query'?observabilityAssembly.admittedUsage(profile.settings.provider,input.modelOverride??profile.settings.model,input.skill??operation,usageAttribution):undefined;
    let hostReceipt:import('@mote/shared').UsageReceipt|undefined;
    const hostMeter=hostMeterBase&&{...hostMeterBase,complete:()=>hostReceipt=hostMeterBase.complete(),fail:()=>hostReceipt=hostMeterBase.fail()};
    const meter=usageOwner==='query'?admittedUsageFactory({mode:()=>runState.mode,host:()=>hostMeterBase})(profile.settings.provider,input.modelOverride??profile.settings.model,input.skill??operation,usageAttribution):undefined;
    let hostObserver:ReturnType<typeof createHostRunUsageObserver>|undefined;
    // Latch violations always reject. A missing Host terminal is only a success
    // gap: the leaf reports host before any Host session exists, so an early
    // failure or pre-cancel must keep its original error instead of being
    // rewritten into a terminal gap.
    const runViolation=()=>runState.violation?new StoreError('Agent run accounting contradiction',409):undefined;
    const runSuccessGap=()=>runState.mode==='host'&&!runState.hostTerminal?new StoreError('Agent run terminal is missing',409):undefined;
    const runLease:QueryRunLease={onFinalizer:mode=>{
      if(runState.mode!==undefined&&runState.mode!==mode){runState.violation??='finalizer_mode_contradiction';return;}
      runState.mode=mode;
    }};
    // Agent implementations account admitted model/tool/repair work. A second
    // wall-clock deadline here would charge host resource-gate waiting again.
    const deadline=agentDeadline(input.signal,null),taskSignal=deadline.signal;
    let disclosedSourcePins=sourceContextDependencies(input);
    const disclosedProcessingIds:string[]=[],processingIds=new Set<string>();
    const observed:QueryInput&{processingDisclosedEvidenceIds?:string[]}={...input,contextSourceContextDependencies:disclosedSourcePins,signal:taskSignal,traceContext,
      ...(input.responseMode==='memory-extraction'&&input.evidenceIds!==undefined?{processingDisclosedEvidenceIds:disclosedProcessingIds,onEvidence:(records:readonly import('@mote/agent').ContextRecord[])=>{
        for(const record of records)if(!processingIds.has(record.id)){processingIds.add(record.id);disclosedProcessingIds.push(record.id);}
        input.onEvidence?.(records);
      }}:{}),
      onSourceContextDependencies:pins=>{
        const next=combineSourceContextDependencies([disclosedSourcePins,pins]);
        assertSourceContextDependencies(sourceContexts,next);
        disclosedSourcePins=next;observed.contextSourceContextDependencies=next;
        input.onSourceContextDependencies?.(pins);
      },
      onProgress:(event:AgentProgress)=>{trace({type:'progress',stage:event.stage,phase:event.phase,step:event.step,tool:event.tool,payload:event});input.onProgress?.(event);},onTrace:trace,
      onUsage:(tokens:import('@mote/shared').TokenUsage)=>{if(runState.mode!=='host')meter?.update(tokens);input.onUsage?.(tokens);},
      onHostRunEvent:(envelope)=>{
        // Bind only after the chosen leaf declared host and only from the first
        // trusted Host identity; never infer the mode from an event.
        if(runState.mode!=='host'){runState.violation??='host_event_without_host_mode';return;}
        const identity=envelope?.identity;
        const runId=identity&&typeof identity==='object'&&typeof identity.runId==='string'?identity.runId:undefined;
        if(!runId){runState.violation??='invalid_host_identity';return;}
        if(runState.runId===undefined)runState.runId=runId;
        else if(runState.runId!==runId){runState.violation??='run_identity_contradiction';return;}
        runState.hostEvents=true;
        if(envelope.event.type==='run.terminal')runState.hostTerminal=true;
        if(hostMeter)(hostObserver??=createHostRunUsageObserver({runId,meter:hostMeter,diagnostics}))(envelope);
      }};
    const heartbeat=setInterval(()=>diagnostics.record('agent.heartbeat',{jobId:input.traceContext?.jobId,elapsedMs:Date.now()-startedAt,idleMs:Date.now()-lastActivity,activeQueries:agentGate.snapshot().active},'info'),30000);heartbeat.unref();
    const promise=diagnostics.measure('agent',operation,()=>(meter?meter.run(()=>agent.query(observed,runLease)):agent.query(observed,runLease)).then(result=>{
      taskSignal?.throwIfAborted();
      assertModelEvidence(observed);
      if(observed.executionLane==='interactive'&&observed.evidenceIds&&result.citations.some(citation=>![...observed.evidenceIds!,...(observed.directImages?.map(image=>image.id)??[])].includes(citation.id)))throw contextFailure('context_evidence_restricted');
      const selectedDependencies=observed.executionLane==='interactive'&&observed.evidenceIds?{version:1 as const,complete:true,ids:[...observed.evidenceIds,...(observed.directImages?.map(image=>image.id)??[])]}:undefined;
      const evidenceDependencies=resolveDependencies(store,combineDependencies([contextDependencies(input),result.evidenceDependencies??selectedDependencies]));
      // Metadata/declaration reads also pin their original Material lineage.
      // They need correction fences even when no original quote was expanded.
      if(evidenceDependencies){
        const historicalIds=new Set([...(input.conversation?.historyContext?input.conversation.evidenceDependencies?.ids??[]:[]),...(input.historyContext?input.contextEvidenceDependencies?.ids??[]:[])]);
        assertModelEvidence({question:'',contextEvidenceDependencies:{...evidenceDependencies,ids:evidenceDependencies.ids.filter(id=>!historicalIds.has(id))}});
      }
      const sourcePins=combineSourceContextDependencies([disclosedSourcePins,result.sourceContextDependencies]);
      assertSourceContextDependencies(sourceContexts,sourcePins);
      // A long-running review may overlap routine imports and derived-layer updates.
      // Only an original actually disclosed to this run being deleted can make
      // its answer unsafe to publish; other archive changes belong to later runs.
      if(store.deletionRevision()!==revision){
        const used=new Set([...(input.derivedContextEvidenceIds??[]),...(contextDependencies(input)?.ids??[]),...(evidenceDependencies?.ids??[]),...result.citations.map(citation=>citation.id)]);
        for(const row of store.db.prepare("SELECT id FROM changes WHERE seq>? AND operation='delete'").iterate(revision)){
          if(!evidenceDependencies?.complete||used.has(String(row.id)))throw new StoreError('Evidence used by this answer was deleted during the run',409);
        }
      }
      // A contradiction or a Host success without its terminal latches before
      // any success finalize or product commit.
      const accounting=runViolation()??runSuccessGap();
      if(accounting){if(runState.mode!=='host')meter?.failed(accounting);throw accounting;}
      trace({type:'query.completed',stage:'validating',phase:'completed',status:'succeeded',payload:{answer:result.answer,citations:result.citations,trace:result.trace,contextUsage:(result as QueryResult & {contextUsage?:unknown}).contextUsage}});
      const completedUsage=runState.mode==='host'?hostReceipt:meter?.completed();
      return {...result,...(evidenceDependencies?{evidenceDependencies}:{}),...(sourcePins.length?{sourceContextDependencies:sourcePins}:{}),configuration,...(completedUsage?{usage:completedUsage}:{})};
    }).catch(error=>{
      // The Host path finalizes only through its observer's run terminal; the
      // legacy path keeps its existing finalizers. A latched contradiction
      // replaces the outcome after the legacy finalizer has settled its row.
      if(error instanceof AgentYieldError){
        // Accounting is decided before the yield finalizer: a contradiction
        // must fail the started legacy receipt rather than complete it.
        const accounting=runViolation();
        if(accounting){if(runState.mode!=='host')meter?.failed(accounting);throw accounting;}
        const gap=runSuccessGap();
        if(gap){if(runState.mode!=='host')meter?.failed(gap);throw gap;}
        if(runState.mode!=='host')meter?.completed();
        trace({type:'query.yielded',status:'waiting'});throw error;
      }
      const wait=error instanceof ProviderFailure&&(error.details.admissionWaiting===true||error.details.category==='transient'&&error.details.code==='rate_limited')?{code:error.details.code,retryAfterMs:error.details.retryAfterMs}:error instanceof ExecutionFailure&&error.category==='waiting'?{code:error.code,retryAfterMs:error.retryAfterMs}:undefined;
      if(runState.mode!=='host')meter?.failed(error);
      const accounting=runViolation();
      if(accounting)throw accounting;
      retainFailureContext(error,{runId:failureRunId,phase:input.traceContext?.phase,jobId:input.traceContext?.jobId,batchId:input.traceContext?.batchId});
      trace(wait?{type:'query.waiting',status:'waiting',payload:wait}:{type:'query.failed',status:'failed',payload:{errorName:error instanceof Error?error.name:'UnknownError',reason:typeof (error as {reason?:unknown})?.reason==='string'?(error as {reason:string}).reason:undefined}});throw error;
    }),result=>({citations:result.citations.length,toolCalls:result.trace.length,activeQueries:activeQueries.size}));
    activeQueries.add(promise);void promise.finally(()=>{deadline.dispose();clearInterval(heartbeat);activeQueries.delete(promise);}).catch(()=>{});return promise;
  }

  async function insight(range:QueryScope&{prompt?:string;modelProfileId?:string},onProgress?:QueryInput['onProgress'],signal?:AbortSignal,operationId='insight:'+randomUUID(),snapshot?:InsightSnapshot) {
    if(!agent.configured)throw new AgentNotConfiguredError();
    const {prompt,...scope}=range;
    const result=insightResult(await queryAgent({question:prompt||moteText("请回顾这段时间的个人上下文，选择有证据支撑的发现。区分事实、推断与信息缺口，保留来源引用，用 personal-insight Skill 生成完整文字报告和静态 HTML 展示。"),skill:'personal-insight',...scope,...(snapshot?{...snapshot.scope,contextTime:snapshot.asOf,insightSnapshot:snapshot}:{}),onProgress,signal,traceContext:{operationId}},'insight','insights'));
    signal?.throwIfAborted();return {...result,...(snapshot?{snapshot}:{})};
  }

  return Object.freeze({activeQueries,withQueryModelAuthority,queryAgent,insight});
}

export interface QueryRunsAssemblyDependencies extends QueryRunDependencies {
  readonly bootstrap:Awaited<ReturnType<typeof bootstrapCentral>>;
  readonly backendContext:Context;
  readonly resources:ServerResources;
  readonly modelAuthorizationHost:Pick<ModelAuthorizationHost,'manual'>;
  readonly availableModelConnections:()=>ModelConnection[];
}

/** Install C27's delegation runtime and replayable Ask receipts, then mount its
 * command routes once against the current activation. The durable journal,
 * execution slots and model profile of an accepted run are owned inside the
 * plugin scope; a stopped activation fences late commits. */
export async function prepareQueryRuns(dependencies:QueryRunsAssemblyDependencies){
  const platform=createQueryRunsPlatform(dependencies);
  let started:QueryRunsStarted|undefined;
  const handle=await dependencies.bootstrap.host.install({
    identity:{host:dependencies.bootstrap.snapshot().host,packageId:'mote.query-runs',installationId:'build:query-runs@1.0.0',instanceId:'query',activationId:randomUUID()},
    contributions:[queryRunsDeclaration],factory:createQueryRunsFactory(platform,value=>{started=value;}),
  });
  dependencies.resources.defer(()=>handle.close('shutdown'));
  contributeDomainRoutes(dependencies.backendContext,{'mote.ask':{mount:(app:FastifyInstance)=>registerQueryRunRoutes(app,{
    queryRuns:()=>platform.port,modelAuthorizationHost:dependencies.modelAuthorizationHost,
    availableModelConnections:dependencies.availableModelConnections,modelSettings:dependencies.modelSettings,agent:dependencies.agent,
  })}});
  return Object.freeze({delegation:started!.delegation,queryRuns:started!.queryRuns,queryRunServices:platform});
}
