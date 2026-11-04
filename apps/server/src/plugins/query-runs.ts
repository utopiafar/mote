import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {ContextReader,QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {formatEvidenceRef} from '@mote/shared';
import {DelegationRuntime,type DelegationWork} from '../delegation-runtime.js';
import {DelegatedQueryRuns} from '../delegated-query-runs.js';
import type {RunDeadline} from '../run-execution.js';
import {StoreError} from '../store.js';
import {ExecutionFailure,type ExecutionEngine} from '../execution-engine.js';
import type {ExecutionObservability} from '../execution-observability.js';
import type {ExecutionSettings} from '../execution-settings.js';
import type {EvidenceReader} from '../evidence-reader.js';
import {EvidenceExposurePolicy} from '../evidence-exposure.js';
import type {SourceContextStore} from '../source-context.js';
import type {FileStore} from '../files.js';
import type {ConversationRepository} from './central-contracts.js';
import type {WorkingMemory} from '../working-memory.js';
import {freezeSemanticContextTime,type LifecycleSettings} from '../memory-lifecycle.js';
import type {createModelEvidenceAuthority} from '../model-evidence-authority.js';
import {contextFailure} from '../model-evidence-authority.js';
import type {ModelSettingsStore} from '../model-settings.js';
import type {BackgroundModelAuthorization} from '../background-model-authorization.js';
import type {ModelAuthorizationHost} from '../model-authorization-host.js';
import type {AgentRuntimeRegistry} from '../agent-runtime-registry.js';
import {modelConfiguration} from '../model-configuration.js';
import {createQueryPreparation,type SavedQuery} from '../query-preparation.js';
import {queryWithAttachmentsSchema} from '../query-request.js';
import type {QueryScope} from '../query-scope.js';
import {runQueryQualityExperiment,type QueryQualityStrategy,type QueryQualityCheckpoint} from '../query-quality-experiment.js';
import {assertSourceContextDependencies} from '../source-context-lineage.js';
import {safeError} from '../diagnostics.js';
import {moteText} from '../i18n.js';
import type {UsageLedger} from '../usage.js';

/** C27 owns the durable delegation journal and its replayable Ask receipts. */
export const queryRunsContribution={
  id:'query-runs',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.vault-platform',version:'1.0.0'},{kind:'host',id:'mote.owner-authorization',version:'1.0.0'}],
  provides:[],
} as const satisfies ManifestContribution;
export const queryRunsDeclaration={id:queryRunsContribution.id,apiVersion:'1'} as const;
/** Accepted query receipts and delegated work survive a stopped activation. */
export const queryRunsReplacement='hot' as const;

export type QueryRunsPort=Pick<DelegatedQueryRuns,'list'|'get'|'start'|'cancel'|'perform'> & {quiesce():void;interrupt():void};

export interface QueryRunDependencies {
  readonly store:ConstructorParameters<typeof DelegationRuntime>[0];
  readonly executor:ExecutionEngine;
  readonly executionObserver:Pick<ExecutionObservability,'hostTick'>;
  readonly runtimeSettings:Pick<ExecutionSettings,'execution'>;
  readonly evidenceReader:EvidenceReader;
  readonly sourceContexts:SourceContextStore;
  readonly assertModelEvidence:(input:QueryInput|undefined)=>void;
  readonly files:FileStore;
  readonly conversations:Pick<ConversationRepository,'get'|'append'|'appendFailure'|'context'|'historyContext'|'retiredSelection'>;
  readonly working:Pick<WorkingMemory,'prepare'>;
  readonly lifecycleSettings:()=>LifecycleSettings;
  readonly archiveReader:ContextReader;
  readonly agent:Pick<AgentRuntimeRegistry,'configured'>;
  readonly modelEvidenceAuthority:Pick<ReturnType<typeof createModelEvidenceAuthority>,'assert'|'contextDependencies'|'selectedQueryEvidence'|'selectedQueryMaterial'>;
  readonly modelSettings:Pick<ModelSettingsStore,'select'|'view'>;
  readonly queryAgent:(input:QueryInput,operation?:'query'|'insight',moduleId?:string,usageOwner?:'query'|'caller')=>Promise<QueryResult>;
  readonly qualityStrategy?:QueryQualityStrategy;
  readonly semanticContextTime?:()=>string;
  readonly usageLedger:UsageLedger;
  readonly modelAuthorizationHost:Pick<ModelAuthorizationHost,'manual'> & {readonly control:Pick<BackgroundModelAuthorization,'workState'>};
}

interface Generation {readonly runtime:DelegationRuntime;readonly runs:DelegatedQueryRuns}

export interface QueryRunsPlatform extends Omit<PluginLifecycle,'start'> {
  /** Stable facade; a later activation services the same routes and port. */
  readonly port:QueryRunsPort;
  readonly delegation:DelegationRuntime;
  readonly queryRuns:DelegatedQueryRuns;
  start():void|Promise<void>;
  quiesce(reason?:StopReason):void;
  stop(reason?:StopReason):Promise<void>;
  dispose():Promise<void>;
  close():Promise<void>;
}

const unavailable=()=>new StoreError('Query runs are unavailable',503);

function delegationOptions(dependencies:QueryRunDependencies){
  const {executionObserver,runtimeSettings,evidenceReader,sourceContexts,assertModelEvidence}=dependencies;
  return {
    observePump:()=>executionObserver.hostTick(),
    concurrency:()=>runtimeSettings.execution().agentConcurrency,
    interactiveConcurrency:()=>runtimeSettings.execution().interactiveConcurrency,
    validateDependencies:(ids:readonly string[])=>assertModelEvidence({question:'',contextEvidenceDependencies:{version:1 as const,complete:true,ids:[...ids]}}),
    validateSourceContextDependencies:(pins:Parameters<typeof assertSourceContextDependencies>[1])=>assertSourceContextDependencies(sourceContexts,pins),
    revalidateEvidence:async(receipts:readonly import('@mote/agent').ContextRecord[])=>{
      const ids=[...new Set(receipts.map(receipt=>receipt.id))],policy=new EvidenceExposurePolicy();
      if(ids.some(id=>!evidenceReader.deletionContextAllowed(id,policy)))throw contextFailure('context_evidence_restricted');
      const originals=evidenceReader.context(evidenceReader.evidence(ids.map(id=>formatEvidenceRef('capture',id))));
      if(originals.length!==ids.length)throw contextFailure('context_evidence_restricted');
      return originals;
    },
  };
}

/** Callbacks captured by one DelegatedQueryRuns generation. A stopped
 * activation never installs another runtime's callbacks as its own. */
function createRunCallbacks(dependencies:QueryRunDependencies,runtime:DelegationRuntime):ConstructorParameters<typeof DelegatedQueryRuns>[2]{
  const {store,files,conversations,executor,modelSettings,working,lifecycleSettings,archiveReader,agent,modelEvidenceAuthority,queryAgent,qualityStrategy,semanticContextTime,usageLedger,sourceContexts,assertModelEvidence,evidenceReader,modelAuthorizationHost}=dependencies;
  const pinnedConfigurationCurrent=(prepared:QueryInput,fingerprint:string)=>{
    const profile=modelSettings.select('chat',prepared.modelProfileId),model=prepared.modelOverride??profile.settings.model;
    return modelConfiguration(profile.id,{...profile.settings,model},modelSettings.view().revision).fingerprint===fingerprint;
  };
  const assertModelWork=(work:DelegationWork)=>{
    const id=work.id.slice('query:'.length),states=['owner-query:'+id,'automatic-conversations:'+work.operationId].map(workId=>modelAuthorizationHost.control.workState(workId));
    if(states.includes('revoked'))throw new ExecutionFailure('stale','ask_revoked');
  };
  const prepareDelegatedQuery=createQueryPreparation({store,files,conversations,delegation:runtime,executor,modelSettings,working,lifecycleSettings,archiveReader,configured:()=>agent.configured,authority:modelEvidenceAuthority,
    query:input=>queryAgent(input,'query','conversations'),qualityStrategy});
  function qualityCheckpoint(input:QueryInput):QueryQualityCheckpoint|undefined{
    if(!qualityStrategy||!input.hostControlChannel)return;
    const work=runtime.get(input.traceContext!.operationId!),stepId=work.id+':coordinator:'+work.revision,fence=String(store.db.prepare('SELECT fence FROM execution_steps WHERE id=?').get(stepId)?.fence??'');
    const assertCurrent=()=>{
      input.signal?.throwIfAborted();
      if(!fence||!executor.isCurrentInputGrant(stepId,fence))throw new StoreError('Query stage grant expired',409);
      const saved=runtime.journal.payload<SavedQuery>(work.id);
      if(saved.qualityStrategy!==qualityStrategy)throw new StoreError('Query experiment strategy changed',409);
      const selected=modelSettings.select('chat',saved.prepared!.modelProfileId),current=modelConfiguration(selected.id,{...selected.settings,model:saved.prepared!.modelOverride??selected.settings.model},modelSettings.view().revision);
      if(saved.configurationFingerprint!==current.fingerprint)throw new StoreError('Query model configuration changed',409);
      assertModelEvidence(saved.prepared);
    };
    const assertResult=(result:QueryResult)=>{assertModelEvidence({...runtime.journal.payload<SavedQuery>(work.id).prepared!,contextEvidenceDependencies:result.evidenceDependencies});assertSourceContextDependencies(sourceContexts,result.sourceContextDependencies);};
    return {assertCurrent,read:stage=>{
      assertCurrent();const result=runtime.journal.payload<SavedQuery>(work.id).qualityStages?.[stage];if(result)assertResult(result);return result;
    },write:(stage,result)=>{
      const own=!store.db.isTransaction;if(own)store.db.exec('BEGIN IMMEDIATE');
      try{
        assertCurrent();assertResult(result);
        runtime.recordEvidence(work.id,[...(result.evidenceDependencies?.ids??[]),...result.citations.map(citation=>citation.id)]);
        runtime.recordSourceContextDependencies(work.id,result.sourceContextDependencies??[]);
        const saved=runtime.journal.payload<SavedQuery>(work.id);saved.qualityStages={...saved.qualityStages,[stage]:result};runtime.journal.savePayload(work.id,saved);
        if(own)store.db.exec('COMMIT');
      }catch(error){if(own&&store.db.isTransaction)store.db.exec('ROLLBACK');throw error;}
    }};
  }
  return {
    contextTime:()=>freezeSemanticContextTime(semanticContextTime),
    resolveInput:(raw:unknown)=>{
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
    prepare:prepareDelegatedQuery.prepare,
    query:(input:QueryInput)=>runQueryQualityExperiment(input,qualityStrategy??'base',(next,stage)=>queryAgent({...next,traceContext:{...next.traceContext,phase:'quality.'+stage}},'query',stage==='base'?'conversations':'query.'+stage),qualityCheckpoint(input)),
    operationUsage:(operationId:string,createdAt:string,finishedAt:string)=>usageLedger.operation(operationId,createdAt,finishedAt),
    pinnedConfigurationCurrent,
    assertModelWork,
    commit:(body:unknown,result:QueryResult,work:DelegationWork)=>{
      const {conversationId,question,attachmentIds=[]}=queryWithAttachmentsSchema.parse(body),saved=runtime.journal.payload<SavedQuery>(work.id),prepared=saved.prepared!;
      assertModelEvidence(prepared);
      assertSourceContextDependencies(sourceContexts,result.sourceContextDependencies);
      runtime.recordEvidence(work.id,[...(result.evidenceDependencies?.ids??[]),...result.citations.map(citation=>citation.id)]);
      const previous=conversationId?conversations.get(conversationId):undefined,scope:QueryScope={};for(const key of ['after','before','deviceId','timeZone','evidenceIds','anchorEvidenceIds','anchorMaterialRef'] as const)if(prepared[key]!==undefined)Object.assign(scope,{[key]:prepared[key]});
      if(prepared.historicalSelection)Object.assign(scope,prepared.historicalSelection);
      return conversations.append(previous,{question,...scope,attachments:prepared.directImages?.filter(image=>attachmentIds.includes(image.id)).map(({id,name,mimeType})=>({id,name,mimeType}))},result);
    },
    failure:(body:unknown,error:unknown)=>{
      const {conversationId,question,evidenceIds,anchorEvidenceIds,anchorMaterialRef,...selected}=queryWithAttachmentsSchema.parse(body),scope:QueryScope={...(evidenceIds?{evidenceIds}:{}),...(anchorEvidenceIds?{anchorEvidenceIds}:{}),...(anchorMaterialRef?{anchorMaterialRef}:{})};for(const key of ['after','before','deviceId','timeZone'] as const)if(selected[key]!==undefined&&selected[key]!==null)scope[key]=selected[key]!;
      const failure=safeError(error);return conversations.appendFailure(conversationId?conversations.get(conversationId):undefined,{question,...scope},{code:failure.category,message:failure.message});
    },
  };
}

/** DelegationRuntime and its durable Ask receipts live only inside this plugin
 * scope. Each activation constructs them over the same store; a stop fences
 * late commits and a later start reopens the same durable work. */
export function createQueryRunsPlatform(dependencies:QueryRunDependencies):QueryRunsPlatform{
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopped'|'disposed'='created';
  let current:Generation|undefined,closing:Promise<void>|undefined,stopping:Promise<void>|undefined,starting:Promise<void>|undefined;
  const read=()=>{
    if(!current||!['prepared','active','quiescing'].includes(phase))throw unavailable();
    return current.runs;
  };
  const write=()=>{
    if(!current||phase!=='active')throw unavailable();
    return current.runs;
  };
  const open=async():Promise<Generation>=>{
    const runtime=new DelegationRuntime(dependencies.store,dependencies.executor,delegationOptions(dependencies));
    try{return {runtime,runs:new DelegatedQueryRuns(dependencies.store,runtime,createRunCallbacks(dependencies,runtime))};}
    catch(error){
      try{await runtime.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Query runs preparation and disposal failed',{cause:error});}
      throw error;
    }
  };
  const port:QueryRunsPort=Object.freeze({
    list:()=>read().list(),
    get:(id:string)=>read().get(id),
    start:(id:string,input:unknown,deadline:RunDeadline={})=>write().start(id,input,deadline),
    cancel:(id:string)=>read().cancel(id),
    perform:((id:string,input:unknown,deadline:RunDeadline={})=>write().perform(id,input,deadline)) as QueryRunsPort['perform'],
    quiesce:()=>{current?.runs.quiesce();},
    interrupt:()=>{current?.runs.interrupt();},
  });
  const stop=async(reason?:StopReason)=>{
    if(phase==='stopped'||phase==='disposed')return;
    if(phase==='created'){phase='stopped';return;}
    phase='quiescing';
    const owned=current;current=undefined;
    const errors:unknown[]=[];
    try{owned?.runtime.quiesce();}catch(error){errors.push(error);}
    if(owned){
      try{
        if(reason==='shutdown'){owned.runs.interrupt();await owned.runs.close();}
        else await owned.runs.stop();
      }catch(error){errors.push(error);}
      try{await owned.runtime.close();}catch(error){errors.push(error);}
    }
    phase='stopped';
    if(errors.length)throw new AggregateError(errors,'Query runs stop failed');
  };
  const close=()=>closing??=(async()=>{
    const errors:unknown[]=[];
    try{await stop('shutdown');}catch(error){errors.push(error);}
    phase='disposed';
    if(errors.length)throw new AggregateError(errors,'Query runs disposal failed');
  })();
  return Object.freeze({
    port,
    get delegation(){if(!current)throw unavailable();return current.runtime;},
    get queryRuns(){if(!current)throw unavailable();return current.runs;},
    async prepare(){
      if(phase!=='created')throw unavailable();
      try{current=await open();phase='prepared';}
      catch(error){current=undefined;throw error;}
    },
    start(){
      if(phase==='active')return;
      if(phase==='prepared'){phase='active';return;}
      if(phase==='stopped'){
        // Reopen over the same durable receipts; routes and the facade stay mounted.
        return starting ??=open().then(generation=>{current=generation;phase='active';}).finally(()=>{starting=undefined;});
      }
      throw unavailable();
    },
    quiesce(_reason?:StopReason){if(phase==='active'){phase='quiescing';current?.runtime.quiesce();current?.runs.quiesce();}},
    stop:(reason?:StopReason)=>{stopping ??= stop(reason);return stopping.then(()=>{stopping=undefined;});},
    dispose:close,
    close,
  });
}
export interface QueryRunsStarted {readonly delegation:DelegationRuntime;readonly queryRuns:DelegatedQueryRuns}

export function createQueryRunsFactory(platform:QueryRunsPlatform,onStarted?:(value:QueryRunsStarted)=>void){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(()=>platform.close());
    return {
      prepare:platform.prepare,
      async start(){await platform.start();onStarted?.({delegation:platform.delegation,queryRuns:platform.queryRuns});},
      quiesce:(reason:StopReason)=>platform.quiesce(reason),stop:(reason:StopReason)=>platform.stop(reason),dispose:platform.dispose,
    };
  };
}
