import {randomUUID} from 'node:crypto';
import {AgentNotConfiguredError,AgentYieldError,type AgentProgress,type AgentTraceEvent,type ContextReader,type QueryInput} from '@mote/agent';
import {ProviderFailure,formatEvidenceRef,type InsightSnapshot,type QueryResult} from '@mote/shared';
import type {AgentRunFinalizer,QueryRunLease} from '../query-agent.js';
import type {Store} from '../store.js';
import {StoreError} from '../store.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import {safeError,type AgentTraceContext} from '../diagnostics.js';
import type {ServerResources} from '../server-resources.js';
import type {ServerLifecycle} from './lifecycle.js';
import type {ExecutionEngine} from '../execution-engine.js';
import {ExecutionFailure} from '../execution-engine.js';
import type {ExecutionObservability} from '../execution-observability.js';
import type {ConcurrencyGate} from '../concurrency.js';
import type {UsageLedger} from '../usage.js';
import type {ModelSettingsStore} from '../model-settings.js';
import type {ExecutionSettings} from '../execution-settings.js';
import {modelConfiguration} from '../model-configuration.js';
import type {ReloadableAgent} from '../model-agent.js';
import type {BackgroundModelAuthorization,AutomaticModelPurpose} from '../background-model-authorization.js';
import {sourceModelIdentity,type ModelAuthorizationHost} from '../model-authorization-host.js';
import type {EvidenceReader} from '../evidence-reader.js';
import {EvidenceExposurePolicy} from '../evidence-exposure.js';
import type {SourceContextStore} from '../source-context.js';
import type {FileStore} from '../files.js';
import type {Conversations} from '../conversations.js';
import type {WorkingMemory} from '../working-memory.js';
import {freezeSemanticContextTime,type LifecycleSettings} from '../memory-lifecycle.js';
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
import {DelegationRuntime} from '../delegation-runtime.js';
import {DelegatedQueryRuns} from '../delegated-query-runs.js';
import {createQueryPreparation,type SavedQuery} from '../query-preparation.js';
import {queryWithAttachmentsSchema} from '../query-request.js';
import type {QueryScope} from '../query-scope.js';
import {runQueryQualityExperiment,type QueryQualityStrategy,type QueryQualityCheckpoint} from '../query-quality-experiment.js';
import type {ObservabilityAssembly} from '../plugins/observability-platform.js';
import type {AdmittedUsageMeter as ObservabilityUsageMeter} from '../plugins/observability-platform.js';
import type {AdmittedUsageMeter} from './processing.js';

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

export interface DelegationAssemblyDependencies {
  readonly store:Store;
  readonly resources:ServerResources;
  readonly executor:ExecutionEngine;
  readonly executionObserver:Pick<ExecutionObservability,'hostTick'>;
  readonly runtimeSettings:Pick<ExecutionSettings,'execution'>;
  readonly evidenceReader:EvidenceReader;
  readonly sourceContexts:SourceContextStore;
  readonly assertModelEvidence:(input:QueryInput|undefined)=>void;
  readonly files:FileStore;
  readonly conversations:Conversations;
  readonly working:Pick<WorkingMemory,'prepare'>;
  readonly lifecycleSettings:()=>LifecycleSettings;
  readonly archiveReader:ContextReader;
  readonly agent:Pick<ReloadableAgent,'configured'>;
  readonly modelEvidenceAuthority:Pick<ReturnType<typeof createModelEvidenceAuthority>,'assert'|'contextDependencies'|'selectedQueryEvidence'|'selectedQueryMaterial'>;
  readonly modelSettings:Pick<ModelSettingsStore,'select'|'view'>;
  readonly queryAgent:(input:QueryInput,operation?:'query'|'insight',moduleId?:string,usageOwner?:'query'|'caller')=>Promise<QueryResult>;
  readonly qualityStrategy?:QueryQualityStrategy;
  readonly semanticContextTime?:()=>string;
  readonly usageLedger:UsageLedger;
}

/** DelegationRuntime, delegated query preparation and the durable
 * DelegatedQueryRuns — construction and close hooks app.ts previously held
 * inline. */
export function assembleDelegation(dependencies:DelegationAssemblyDependencies){
  const {store,resources,executor,executionObserver,runtimeSettings,evidenceReader,sourceContexts,assertModelEvidence,files,conversations,working,lifecycleSettings,archiveReader,agent,modelEvidenceAuthority,modelSettings,queryAgent,qualityStrategy,semanticContextTime,usageLedger}=dependencies;
  const delegation=new DelegationRuntime(store,executor,{observePump:()=>executionObserver.hostTick(),concurrency:()=>runtimeSettings.execution().agentConcurrency,interactiveConcurrency:()=>runtimeSettings.execution().interactiveConcurrency,
    validateDependencies:ids=>assertModelEvidence({question:'',contextEvidenceDependencies:{version:1,complete:true,ids:[...ids]}}),
    validateSourceContextDependencies:pins=>assertSourceContextDependencies(sourceContexts,pins),
    revalidateEvidence:async receipts=>{
      const ids=[...new Set(receipts.map(receipt=>receipt.id))],policy=new EvidenceExposurePolicy();
      if(ids.some(id=>!evidenceReader.deletionContextAllowed(id,policy)))throw contextFailure('context_evidence_restricted');
      const originals=evidenceReader.context(evidenceReader.evidence(ids.map(id=>formatEvidenceRef('capture',id))));
      if(originals.length!==ids.length)throw contextFailure('context_evidence_restricted');
      return originals;
    },
  });
  resources.defer(()=>delegation.close());
  const {prepare:prepareDelegatedQuery}=createQueryPreparation({store,files,conversations,delegation,executor,modelSettings,working,lifecycleSettings,archiveReader,configured:()=>agent.configured,authority:modelEvidenceAuthority,
    query:input=>queryAgent(input,'query','conversations'),qualityStrategy});
  function qualityCheckpoint(input:QueryInput):QueryQualityCheckpoint|undefined{
    if(!qualityStrategy||!input.hostControlChannel)return;
    const work=delegation.get(input.traceContext!.operationId!),stepId=work.id+':coordinator:'+work.revision,fence=String(store.db.prepare('SELECT fence FROM execution_steps WHERE id=?').get(stepId)?.fence??'');
    const assertCurrent=()=>{
      input.signal?.throwIfAborted();
      if(!fence||!executor.isCurrentInputGrant(stepId,fence))throw new StoreError('Query stage grant expired',409);
      const saved=delegation.journal.payload<SavedQuery>(work.id);
      if(saved.qualityStrategy!==qualityStrategy)throw new StoreError('Query experiment strategy changed',409);
      const selected=modelSettings.select('chat',saved.prepared!.modelProfileId),current=modelConfiguration(selected.id,{...selected.settings,model:saved.prepared!.modelOverride??selected.settings.model},modelSettings.view().revision);
      if(saved.configurationFingerprint!==current.fingerprint)throw new StoreError('Query model configuration changed',409);
      assertModelEvidence(saved.prepared);
    };
    const assertResult=(result:QueryResult)=>{assertModelEvidence({...delegation.journal.payload<SavedQuery>(work.id).prepared!,contextEvidenceDependencies:result.evidenceDependencies});assertSourceContextDependencies(sourceContexts,result.sourceContextDependencies);};
    return {assertCurrent,read:stage=>{
      assertCurrent();const result=delegation.journal.payload<SavedQuery>(work.id).qualityStages?.[stage];if(result)assertResult(result);return result;
    },write:(stage,result)=>{
      const own=!store.db.isTransaction;if(own)store.db.exec('BEGIN IMMEDIATE');
      try{
        assertCurrent();assertResult(result);
        delegation.recordEvidence(work.id,[...(result.evidenceDependencies?.ids??[]),...result.citations.map(citation=>citation.id)]);
        delegation.recordSourceContextDependencies(work.id,result.sourceContextDependencies??[]);
        const saved=delegation.journal.payload<SavedQuery>(work.id);saved.qualityStages={...saved.qualityStages,[stage]:result};delegation.journal.savePayload(work.id,saved);
        if(own)store.db.exec('COMMIT');
      }catch(error){if(own&&store.db.isTransaction)store.db.exec('ROLLBACK');throw error;}
    }};
  }
  const queryRuns=new DelegatedQueryRuns(store,delegation,{
    contextTime:()=>freezeSemanticContextTime(semanticContextTime),
    resolveInput:raw=>{
      const input=queryWithAttachmentsSchema.parse(raw);
      const previous=input.conversationId?conversations.get(input.conversationId).scope:undefined;
      // Freeze resolved selection in the accepted run, before asynchronous preparation.
      const selected=input.evidenceIds?{...input,anchorEvidenceIds:null,anchorMaterialRef:null}:
        input.anchorEvidenceIds?{...input,evidenceIds:null,anchorMaterialRef:null}:
        input.anchorMaterialRef?{...input,evidenceIds:null,anchorEvidenceIds:null}:
        {...input,...(input.evidenceIds===undefined&&previous?.evidenceIds?{evidenceIds:[...previous.evidenceIds]}:{}),...(input.anchorEvidenceIds===undefined&&previous?.anchorEvidenceIds?{anchorEvidenceIds:[...previous.anchorEvidenceIds]}:{}),...(input.anchorMaterialRef===undefined&&previous?.anchorMaterialRef?{anchorMaterialRef:previous.anchorMaterialRef}:{})};
      if(selected.anchorMaterialRef&&!evidenceReader.queryMaterialReference(selected.anchorMaterialRef,{
        ...(selected.after?{after:selected.after}:{}),...(selected.before?{before:selected.before}:{}),...(selected.deviceId?{deviceId:selected.deviceId}:{})
      }))throw Object.assign(new StoreError(moteText('参考原件暂不可用，请清除参考后继续。'),409),{code:'context_evidence_restricted'});
      return selected;
    },
    prepare:prepareDelegatedQuery,
    query:input=>runQueryQualityExperiment(input,qualityStrategy??'base',(next,stage)=>queryAgent({...next,traceContext:{...next.traceContext,phase:'quality.'+stage}},'query',stage==='base'?'conversations':'query.'+stage),qualityCheckpoint(input)),
    operationUsage:(operationId,createdAt,finishedAt)=>usageLedger.operation(operationId,createdAt,finishedAt),
    commit:(body,result,work)=>{
      const {conversationId,question,attachmentIds=[]}=queryWithAttachmentsSchema.parse(body),saved=delegation.journal.payload<SavedQuery>(work.id),prepared=saved.prepared!;
      assertModelEvidence(prepared);
      assertSourceContextDependencies(sourceContexts,result.sourceContextDependencies);
      delegation.recordEvidence(work.id,[...(result.evidenceDependencies?.ids??[]),...result.citations.map(citation=>citation.id)]);
      const previous=conversationId?conversations.get(conversationId):undefined,scope:QueryScope={};for(const key of ['after','before','deviceId','timeZone','evidenceIds','anchorEvidenceIds','anchorMaterialRef'] as const)if(prepared[key]!==undefined)Object.assign(scope,{[key]:prepared[key]});
      if(prepared.historicalSelection)Object.assign(scope,prepared.historicalSelection);
      return conversations.append(previous,{question,...scope,attachments:prepared.directImages?.filter(image=>attachmentIds.includes(image.id)).map(({id,name,mimeType})=>({id,name,mimeType}))},result);
    },
    failure:(body,error)=>{
      const {conversationId,question,evidenceIds,anchorEvidenceIds,anchorMaterialRef,...selected}=queryWithAttachmentsSchema.parse(body),scope:QueryScope={...(evidenceIds?{evidenceIds}:{}),...(anchorEvidenceIds?{anchorEvidenceIds}:{}),...(anchorMaterialRef?{anchorMaterialRef}:{})};for(const key of ['after','before','deviceId','timeZone'] as const)if(selected[key]!==undefined&&selected[key]!==null)scope[key]=selected[key]!;
      const failure=safeError(error);return conversations.appendFailure(conversationId?conversations.get(conversationId):undefined,{question,...scope},{code:failure.category,message:failure.message});
    },
  });
  resources.defer(()=>queryRuns.close());
  return Object.freeze({delegation,queryRuns});
}
