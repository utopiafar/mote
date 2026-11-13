import {randomUUID} from 'node:crypto';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,ServiceBinding,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import {AgentNotConfiguredError,AgentYieldError,prepareTaskContext,type AgentProgress,type AgentTraceEvent,type QueryInput} from '@mote/agent';
import {ProviderFailure,type ConversationSettings,type InsightSnapshot,type QueryResult} from '@mote/shared';
import type {QueryScope as ReaderQueryScope} from '../query-scope.js';
import type {DelegationRuntime} from '../delegation-runtime.js';
import type {AgentRunFinalizer,QueryRunLease} from '../query-agent.js';
import {StoreError} from '../store.js';
import type {ExecutionEngine} from '../execution-engine.js';
import {ExecutionFailure} from '../execution-engine.js';
import {modelConfiguration} from '../model-configuration.js';
import {queryModelBudget} from '../query-model-budget.js';
import {createMemoryModelAuthorityJobReader} from '../memory-model-authority.js';
import {createHostRunUsageObserver} from '../agent-runtime-events.js';
import {agentDeadline} from '../agent-deadline.js';
import {retainFailureContext} from '../execution-failures.js';
import {resolveDependencies,combineDependencies} from '../conversation-lineage.js';
import {assertSourceContextDependencies,combineSourceContextDependencies} from '../source-context-lineage.js';
import {moteText,requestLocale} from '../i18n.js';
import {insightResult,validateInsightOutput} from '../insights.js';
import {contextFailure} from '../model-evidence-authority.js';
import type {QueryScope} from '../query-scope.js';
import type {ServerDiagnostics,AgentTraceContext} from '../diagnostics.js';
import type {ServerLifecycle} from '../assembly/lifecycle.js';
import type {ConcurrencyGate} from '../concurrency.js';
import type {ModelSettingsStore} from '../model-settings.js';
import type {AgentRuntimeRegistry} from '../agent-runtime-registry.js';
import type {BackgroundModelAuthorization,AutomaticModelPurpose} from '../background-model-authorization.js';
import {sourceModelIdentity} from '../model-authorization-host.js';
import type {ModelAuthorizationHost} from '../model-authorization-host.js';
import type {createModelEvidenceAuthority} from '../model-evidence-authority.js';
import type {SourceContextStore} from '../source-context.js';
import type {Conversations} from '../conversations.js';
import type {ObservabilityAssembly} from './observability-platform.js';
import {assistantDraftScope,type AssistantDrafts} from '../assistant-drafts.js';
import {centralServices,type QueryDomain} from './central-contracts.js';

/** C27 owns admitted model runs and the insight entry. Routes and preparation
 * are contributed by the same query domain activation. */
export const queryRuntimeContribution={
  id:'query-runtime',version:'1.0.0',surface:'data',runtime:'host',
  requires:[],
  provides:[{kind:'service' as const,id:centralServices.query.id,apiVersion:centralServices.query.apiVersion,cardinality:'single' as const}],
} as const satisfies ManifestContribution;
export const queryRuntimeDeclaration={id:queryRuntimeContribution.id,apiVersion:'1'} as const;
export const queryRuntimeReplacement='hot' as const;

/** Installed SQLite owned by the vault. Query preparation and publication read
 * evidence revisions and execution fences through this borrowed repository. */
export type QueryRuntimeStore=ConstructorParameters<typeof DelegationRuntime>[0];

export interface QueryRuntimeDependencies {
  readonly store:QueryRuntimeStore;
  readonly lifecycle:ServerLifecycle;
  readonly diagnostics:ServerDiagnostics;
  readonly modelAuthorization:Pick<BackgroundModelAuthorization,'bindCurrentStep'>;
  readonly modelAuthorizationHost:Pick<ModelAuthorizationHost,'automatic'|'evidenceTriggers'|'queryTriggers'>;
  readonly executor:Pick<ExecutionEngine,'get'>;
  readonly agentGate:Pick<ConcurrencyGate,'snapshot'>;
  readonly modelSettings:Pick<ModelSettingsStore,'select'|'view'>;
  readonly conversationSettings:()=>ConversationSettings;
  readonly agent:Pick<AgentRuntimeRegistry,'configured'|'query'>;
  readonly observabilityAssembly:Pick<ObservabilityAssembly,'admittedUsage'>;
  readonly modelEvidenceAuthority:Pick<ReturnType<typeof createModelEvidenceAuthority>,'contextDependencies'|'sourceContextDependencies'|'pinProcessingEvidence'>;
  readonly assertModelEvidence:(input:QueryInput|undefined)=>void;
  readonly sourceContexts:SourceContextStore;
  readonly conversations:Pick<Conversations,'assertHistoryContext'>;
  readonly assistantDrafts:Pick<AssistantDrafts,'capabilities'|'issue'>;
}

export interface QueryRuntime {
  readonly activeQueries:ReadonlySet<Promise<QueryResult>>;
  withQueryModelAuthority:<T>(input:QueryInput,moduleId:string,task:(signal:AbortSignal)=>Promise<T>)=>Promise<T>;
  queryAgent:(input:QueryInput,operation?:'query'|'insight',moduleId?:string,usageOwner?:'query'|'caller')=>Promise<QueryResult>;
  insight:(range:QueryScope&{prompt?:string;modelProfileId?:string},onProgress?:QueryInput['onProgress'],signal?:AbortSignal,operationId?:string,snapshot?:InsightSnapshot)=>Promise<ReturnType<typeof insightResult>>;
  /** Settle every accepted model run before the owning activation is released. */
  close():Promise<void>;
}

/** The admitted query path: automatic model authority, per-query run
 * accounting, trace/usage observation and the insight entry. Preparation and
 * receipts enter through the same plugin activation. */
export function createQueryRuntime(dependencies:QueryRuntimeDependencies):QueryRuntime {
  const {store,lifecycle,diagnostics,modelAuthorization,modelAuthorizationHost,executor,agentGate,modelSettings,agent,observabilityAssembly,assertModelEvidence,sourceContexts,assistantDrafts,conversations}=dependencies;
  const {contextDependencies,sourceContextDependencies,pinProcessingEvidence}=dependencies.modelEvidenceAuthority;
  const memoryModelAuthorityJobs=createMemoryModelAuthorityJobReader(store);
  const activeQueries=new Set<Promise<QueryResult>>();
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
    // A draft is a host-issued answer attachment, never a tool or model
    // capability. Only ordinary interactive conversation answers can carry one.
    let draftScope:ReturnType<typeof assistantDraftScope>;
    if(operation==='query'&&moduleId==='conversations'&&input.executionLane!=='background'&&assistantDrafts.capabilities().length){
      const scope=assistantDraftScope(input);
      if(scope){
        const prepared=prepareTaskContext({...input,assistantDraft:true});
        if(prepared.responseMode==='answer'&&Object.hasOwn((prepared.outputSchema.properties??{}) as Record<string,unknown>,'draft')){
          draftScope=scope;input={...input,assistantDraft:true};
        }
      }
    }
    const profile=modelSettings.select(input.responseMode==='memory-extraction'||input.skill==='memory-extraction'||input.skill==='coding-memory'||moduleId==='memories'?'memory':input.skill==='personal-insight'?'insight':'chat',input.modelProfileId);
    if(!input.modelBudget&&moduleId==='conversations')input={...input,modelBudget:queryModelBudget(profile.settings.maxTokens,dependencies.conversationSettings().context)};
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
    const runState:{mode?:AgentRunFinalizer;runId?:string;hostTerminal:boolean;violation?:string}={hostTerminal:false};
    // The Host run session owns usage through one C06 receipt; capture its
    // terminal receipt so the response reports the finalized sample without a
    // second finalize. Constructing this meter writes nothing until a model starts.
    const hostMeterBase=usageOwner==='query'?observabilityAssembly.admittedUsage(profile.settings.provider,input.modelOverride??profile.settings.model,input.skill??operation,usageAttribution):undefined;
    let hostReceipt:import('@mote/shared').UsageReceipt|undefined;
    const hostMeter=hostMeterBase&&{...hostMeterBase,complete:()=>hostReceipt=hostMeterBase.complete(),fail:()=>hostReceipt=hostMeterBase.fail()};
    let hostObserver:ReturnType<typeof createHostRunUsageObserver>|undefined;
    // Latch violations always reject. A missing Host terminal is only a success
    // gap: an early failure or pre-cancel must keep its original error instead
    // of being rewritten into a terminal gap.
    const runViolation=()=>runState.violation?new StoreError('Agent run accounting contradiction',409):undefined;
    const runSuccessGap=()=>runState.mode==='host'&&!runState.hostTerminal?new StoreError('Agent run terminal is missing',409):undefined;
    const runLease:QueryRunLease={onFinalizer:()=>{runState.mode='host';}};
    // Agent implementations account admitted model/tool/repair work. A second
    // wall-clock deadline here would charge host resource-gate waiting again.
    const deadline=agentDeadline(input.signal,null),taskSignal=deadline.signal;
    let disclosedSourcePins=sourceContextDependencies(input);
    const disclosedProcessingIds:string[]=[],processingIds=new Set<string>();
    const memoryPins=new Map<string,{version?:number;fingerprint:string}>();
    const assertMemoryPins=()=>{for(const [id,pin] of memoryPins){const row=store.db.prepare('SELECT json FROM memories WHERE id=?').get(id);if(!row)throw contextFailure('context_evidence_restricted');const current=JSON.parse(String(row.json));if(current.fingerprint!==pin.fingerprint||pin.version!==undefined&&current.version!==pin.version)throw contextFailure('context_evidence_restricted');}};
    const observed:QueryInput&{processingDisclosedEvidenceIds?:string[]}={...input,contextSourceContextDependencies:disclosedSourcePins,signal:taskSignal,traceContext,
      assertContextAuthority:()=>{input.assertContextAuthority?.();assertMemoryPins();},
      onMemoryBodies:cards=>{assertMemoryPins();for(const card of cards){const prior=memoryPins.get(card.id);if(prior&&(prior.fingerprint!==card.fingerprint||prior.version!==card.version))throw contextFailure('context_evidence_restricted');memoryPins.set(card.id,{version:card.version,fingerprint:card.fingerprint});}assertMemoryPins();input.onMemoryBodies?.(cards);},
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
      onProgress:(event:AgentProgress)=>{trace({type:'progress',stage:event.stage,phase:event.phase,step:event.step,tool:event.tool,payload:event});input.onProgress?.(event);},
      onTrace:(event:AgentTraceEvent)=>{
        // The Host session owns the actual model-start boundary; an attempt that
        // fails before reporting usage still owns its one failed receipt.
        if(event.type==='model.started')hostMeter?.modelStarted();
        trace(event);
      },
      onUsage:(tokens:import('@mote/shared').TokenUsage)=>{input.onUsage?.(tokens);},
      onHostRunEvent:(envelope)=>{
        // Bind from the first trusted Host identity only; never infer it from
        // an event. Every runtime now meters through its Host run session.
        const identity=envelope?.identity;
        const runId=identity&&typeof identity==='object'&&typeof identity.runId==='string'?identity.runId:undefined;
        if(!runId){runState.violation??='invalid_host_identity';return;}
        if(runState.runId===undefined)runState.runId=runId;
        else if(runState.runId!==runId){runState.violation??='run_identity_contradiction';return;}
        if(envelope.event.type==='run.terminal')runState.hostTerminal=true;
        if(hostMeter)(hostObserver??=createHostRunUsageObserver({runId,meter:hostMeter,diagnostics}))(envelope);
      }};
    observed.assertContextAuthority=()=>{
      input.assertContextAuthority?.();
      assertMemoryPins();
      if(observed.conversation?.historyContext)conversations.assertHistoryContext(observed.conversation.historyContext);
    };
    const heartbeat=setInterval(()=>diagnostics.record('agent.heartbeat',{jobId:input.traceContext?.jobId,elapsedMs:Date.now()-startedAt,idleMs:Date.now()-lastActivity,activeQueries:agentGate.snapshot().active},'info'),30000);heartbeat.unref();
    const promise=diagnostics.measure('agent',operation,()=>agent.query(observed,runLease).then(result=>{
      taskSignal?.throwIfAborted();
      assertModelEvidence(observed);
      if(observed.executionLane==='interactive'&&observed.evidenceIds&&result.citations.some(citation=>![...observed.evidenceIds!,...(observed.directImages?.map(image=>image.id)??[])].includes(citation.id)))throw contextFailure('context_evidence_restricted');
      const selectedDependencies=observed.executionLane==='interactive'&&observed.evidenceIds?{version:1 as const,complete:true,ids:[...observed.evidenceIds,...(observed.directImages?.map(image=>image.id)??[])]}:undefined;
      const evidenceDependencies=resolveDependencies(store,combineDependencies([contextDependencies(input),result.evidenceDependencies??selectedDependencies,
        ...(input.directImages?.length?[{version:1 as const,complete:true,ids:input.directImages.map(image=>image.id)}]:[])]));
      // Metadata/declaration reads also pin their original Material lineage.
      // They need correction fences even when no original quote was expanded.
      if(evidenceDependencies){
        const historicalIds=new Set([...(input.conversation?.historyContext?input.conversation.evidenceDependencies?.ids??[]:[]),...(input.historyContext?input.contextEvidenceDependencies?.ids??[]:[])]);
        assertModelEvidence({question:'',...((input as ReaderQueryScope).sourceIds!==undefined?{sourceIds:(input as ReaderQueryScope).sourceIds}:{}),contextEvidenceDependencies:{...evidenceDependencies,ids:evidenceDependencies.ids.filter(id=>!historicalIds.has(id))}});
      }
      const sourcePins=combineSourceContextDependencies([disclosedSourcePins,result.sourceContextDependencies]);
      assertSourceContextDependencies(sourceContexts,sourcePins);
      const selectedSources=(input as ReaderQueryScope).sourceIds;
      if(selectedSources!==undefined)assertModelEvidence({question:'',...{sourceIds:selectedSources},executionLane:'interactive',evidenceIds:result.citations.map(citation=>citation.id),contextSourceContextDependencies:sourcePins});
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
      if(accounting)throw accounting;
      trace({type:'query.completed',stage:'validating',phase:'completed',status:'succeeded',payload:{answer:result.answer,citations:result.citations,trace:result.trace,contextUsage:(result as QueryResult & {contextUsage?:unknown}).contextUsage}});
      const completedUsage=runState.mode==='host'?hostReceipt:undefined;
      // A goal-only model proposal becomes a host-bound draft only inside this
      // ordinary conversation answer. The proposal itself is never persisted.
      const {draftProposal,...answerResult}=result as QueryResult & {draftProposal?:{goal:string}};
      let draft:import('@mote/shared').AssistantDraft|undefined;
      if(draftProposal&&input.assistantDraft&&draftScope)try{draft=assistantDrafts.issue({goal:draftProposal.goal,scope:draftScope});}catch{/* A malformed proposal cannot fail a valid answer. */}
      return {...answerResult,...(draft?{draft}:{}),...(evidenceDependencies?{evidenceDependencies}:{}),...(sourcePins.length?{sourceContextDependencies:sourcePins}:{}),configuration,...(completedUsage?{usage:completedUsage}:{})};
    }).catch(error=>{
      // The Host run session finalizes only through its observer's run terminal.
      // A latched contradiction replaces the outcome after the Host has settled.
      if(error instanceof AgentYieldError){
        const accounting=runViolation();
        if(accounting)throw accounting;
        const gap=runSuccessGap();
        if(gap)throw gap;
        trace({type:'query.yielded',status:'waiting'});throw error;
      }
      const wait=error instanceof ProviderFailure&&(error.details.admissionWaiting===true||error.details.category==='transient'&&error.details.code==='rate_limited')?{code:error.details.code,retryAfterMs:error.details.retryAfterMs}:error instanceof ExecutionFailure&&error.category==='waiting'?{code:error.code,retryAfterMs:error.retryAfterMs}:undefined;
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
  const close=async()=>{await Promise.allSettled([...activeQueries]);};
  return Object.freeze({activeQueries,withQueryModelAuthority,queryAgent,insight,close});
}

const unavailable=()=>new StoreError('Query runtime is unavailable',503);

export interface QueryRuntimePlatform extends Omit<PluginLifecycle,'start'> {
  /** Stable facade; a later activation services the same routes and port. */
  readonly query:QueryDomain;
  readonly runtime:QueryRuntime;
  start():void;
  quiesce(reason?:StopReason):void;
  stop(reason?:StopReason):Promise<void>;
  dispose():Promise<void>;
  close():Promise<void>;
}

/** The admitted query activation. A stop settles accepted runs and a later
 * start opens a fresh runtime over the same durable evidence and receipts. */
export function createQueryRuntimePlatform(dependencies:QueryRuntimeDependencies):QueryRuntimePlatform{
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopped'|'disposed'='created';
  let current:QueryRuntime|undefined,closing:Promise<void>|undefined,stopping:Promise<void>|undefined;
  const read=()=>{
    if(!current||!['prepared','active','quiescing'].includes(phase))throw unavailable();
    return current;
  };
  const active=()=>{
    if(!current||phase!=='active')throw unavailable();
    return current;
  };
  const query:QueryDomain=Object.freeze({
    activeQueries:()=>current&&['prepared','active','quiescing'].includes(phase)?current.activeQueries.size:0,
    withQueryModelAuthority:<T>(input:QueryInput,moduleId:string,task:(signal:AbortSignal)=>Promise<T>)=>active().withQueryModelAuthority(input,moduleId,task),
    queryAgent:(input:QueryInput,operation?:'query'|'insight',moduleId?:string,usageOwner?:'query'|'caller')=>active().queryAgent(input,operation,moduleId,usageOwner),
    insight:(range:QueryScope&{prompt?:string;modelProfileId?:string},onProgress:QueryInput['onProgress'],signal:AbortSignal|undefined,operationId:string|undefined,snapshot:InsightSnapshot|undefined)=>active().insight(range,onProgress,signal,operationId,snapshot),
  });
  const stop=async()=>{
    if(phase==='stopped'||phase==='disposed')return;
    if(phase==='created'){phase='stopped';return;}
    phase='quiescing';
    const owned=current;current=undefined;
    const errors:unknown[]=[];
    if(owned)try{await owned.close();}catch(error){errors.push(error);}
    phase='stopped';
    if(errors.length)throw new AggregateError(errors,'Query runtime stop failed');
  };
  const close=()=>closing??=(async()=>{
    const errors:unknown[]=[];
    try{await stop();}catch(error){errors.push(error);}
    phase='disposed';
    if(errors.length)throw new AggregateError(errors,'Query runtime disposal failed');
  })();
  return Object.freeze({
    query,
    get runtime(){return read();},
    prepare(){
      if(phase!=='created')throw unavailable();
      current=createQueryRuntime(dependencies);phase='prepared';
    },
    start(){
      if(phase==='active')return;
      if(phase==='prepared'){phase='active';return;}
      if(phase==='stopped'){current=createQueryRuntime(dependencies);phase='active';return;}
      throw unavailable();
    },
    quiesce(_reason?:StopReason){if(phase==='active')phase='quiescing';},
    stop:(reason?:StopReason)=>{stopping??=stop().then(()=>{stopping=undefined;});void reason;return stopping;},
    dispose:close,
    close,
  });
}
export type QueryRuntimeServices=QueryRuntimePlatform;

export interface QueryRuntimeStarted {readonly query:ServiceBinding}

export function createQueryRuntimeFactory(platform:QueryRuntimePlatform,onStarted?:(value:QueryRuntimeStarted)=>void){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(()=>platform.close());
    return {
      prepare:platform.prepare,
      start(){platform.start();const query=context.provide(queryRuntimeContribution.id,centralServices.query,platform.query);onStarted?.({query});},
      quiesce:(reason:StopReason)=>platform.quiesce(reason),stop:(reason:StopReason)=>platform.stop(reason),dispose:platform.dispose,
    };
  };
}
