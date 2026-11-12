import {sanitizeFailureDiagnostics} from '@mote/shared';
import {createHash} from 'node:crypto';
import {AgentYieldError,AgentTimeoutError,type AgentProgress,type QueryInput} from '@mote/agent';
import {executionEnvelope,ProviderFailure,type QueryResult} from '@mote/shared';
import {StoreError,type Store} from './store.js';
import {safeError} from './diagnostics.js';
import {moteText,requestLocale} from './i18n.js';
import {DelegationRuntime,type DelegationWork} from './delegation-runtime.js';
import {createAgentDelegationPlugin} from './agent-delegation-plugin.js';
import type {QueryRun} from './query-run-types.js';
import type {SavedQuery} from './plugins/query-preparation.js';
import type {RunDeadline} from './run-execution.js';
import {ExecutionFailure} from './execution-engine.js';

type Receipt={conversationId:string;turnId:string};
type SavedFailure=ReturnType<typeof safeError>&{kind?:'provider'|'response'};
type SavedInput=QueryInput&{hostRequest:unknown;executionTimeoutMs?:number;lastFailure?:SavedFailure};
const capacityWaiting=(error:unknown)=>error instanceof ExecutionFailure&&error.category==='waiting'||error instanceof ProviderFailure&&(error.details.admissionWaiting===true||error.details.category==='transient'&&error.details.code==='rate_limited');
type QueryCallbacks={
  contextTime?:()=>string;
  initialReceipt?:(id:string)=>Receipt|undefined;
  requestIdentity?:(id:string,input:unknown)=>unknown|undefined;
  resolveInput?:(input:unknown)=>unknown;
  prepare:(body:unknown,work:DelegationWork,signal:AbortSignal,onProgress:QueryInput['onProgress'])=>Promise<QueryInput>;
  query:(input:QueryInput)=>Promise<QueryResult>;
  commit:(body:unknown,result:QueryResult,work:DelegationWork)=>Receipt;
  failure?:(body:unknown,error:unknown,work:DelegationWork)=>Receipt;
  operationUsage?:(operationId:string,createdAt:string,finishedAt:string)=>import('./usage.js').OperationUsage;
  /** A recovered request may resume only while its exact pinned model profile is still installed. */
  pinnedConfigurationCurrent?:(prepared:QueryInput,fingerprint:string)=>boolean;
  /** The final product write rechecks the durable model authorization. */
  assertModelWork?:(work:DelegationWork)=>void;
};

/** Replayable request receipts. Durable coordination owns model fragments;
 * this facade does not hold another execution/model slot while children run. */
export class DelegatedQueryRuns {
  private timer:ReturnType<typeof setInterval>;
  private results=new Map<string,QueryResult&Receipt>();
  private errors=new Map<string,unknown>();
  private foreground=new Set<string>();
  /** Only the current trusted HTTP request; never a cached model context. */
  private foregroundRequests=new Map<string,{hostRequest:unknown;executionTimeoutMs?:number;cancelled?:boolean}>();
  private waiters=new Map<string,Set<()=>void>>();
  private stopped=false;
  private interrupted=false;
  constructor(private store:Store,readonly runtime:DelegationRuntime,private callbacks:QueryCallbacks){
    store.db.exec('CREATE TABLE IF NOT EXISTS query_runs(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,json TEXT NOT NULL)');
    store.installContextHistoryInvalidation();
    createAgentDelegationPlugin(runtime,{
      timeoutMs:input=>(input as SavedInput).executionTimeoutMs??null,
      prepare:async(work,saved,signal)=>{
        const id=work.id.slice('query:'.length),input=saved as SavedInput;
        try{
          const prepared=await callbacks.prepare(input.hostRequest,work,signal,event=>this.observe(id,event));
          runtime.recordEvidence(work.id,[...(prepared.contextEvidenceDependencies?.ids??[]),...(prepared.conversation?.evidenceDependencies?.ids??[]),...(prepared.directImages?.map(image=>image.id)??[])]);
          return prepared;
        }catch(error){if(!signal.aborted)this.rememberFailure(id,error);throw this.executionFailure(error,id);}
      },
      query:async input=>{
        const id=input.hostControlChannel?input.traceContext?.operationId?.replace(/^query:/,''):undefined;
        try{return await callbacks.query(input);}
        catch(error){
          if(input.hostControlChannel&&!(error instanceof AgentYieldError)&&!input.signal?.aborted){
            if(id&&this.exists(id))this.rememberFailure(id,error);
          }
          throw input.hostControlChannel?this.executionFailure(error,id):error;
        }
      },
      commit:(work,answer)=>{
        try{
        callbacks.assertModelWork?.(work);
        const id=work.id.slice('query:'.length),saved=runtime.journal.payload<SavedInput>(work.id),run=this.raw(id),result=answer as QueryResult;
        const receipt=callbacks.commit(saved.hostRequest,result,work);
        Object.assign(run,receipt,{status:'completed',updatedAt:new Date().toISOString(),evidenceDependencies:result.evidenceDependencies,sourceContextDependencies:result.sourceContextDependencies});delete run.error;
        const operationUsage=callbacks.operationUsage?.(work.operationId,run.createdAt,run.updatedAt);
        if(operationUsage)run.operationUsage=operationUsage;
        this.save(run);if(this.foreground.has(id))this.results.set(id,{...result,...receipt,...(operationUsage?{operationUsage}:{})});this.notify(id);
        }catch(error){throw this.executionFailure(error);}
      },
      validate:work=>this.exists(work.id.slice('query:'.length)),
    }).register();
    this.recoverGenerationPins();
    this.timer=setInterval(()=>{for(const id of new Set([...this.waiters.keys(),...this.errors.keys()])){try{if(this.get(id).status!=='running')this.notify(id);}catch{if(!this.exists(id))this.errors.delete(id);this.notify(id);}}},50);this.timer.unref();
  }
  /** A restart cannot rebuild a retired model generation. Resume only when the
   * current profile still matches the request's exact fingerprint; otherwise
   * the durable job is explicitly blocked before any new model attempt. */
  private recoverGenerationPins(){
    for(const row of this.store.db.prepare("SELECT id FROM query_runs WHERE json_extract(json,'$.status')='running'").all() as {id:string}[]){
      const workId='query:'+row.id;
      let work:DelegationWork;try{work=this.runtime.get(workId);}catch{continue;}
      if(!['waiting','running','blocked'].includes(work.status))continue;
      let saved:SavedQuery;try{saved=this.runtime.journal.payload<SavedQuery>(workId);}catch{continue;}
      if(!saved.prepared)continue;
      const fingerprint=saved.configurationFingerprint;let current=false;
      try{current=Boolean(fingerprint)&&this.callbacks.pinnedConfigurationCurrent?.(saved.prepared,fingerprint!)===true;}catch{current=false;}
      if(current)continue;
      this.runtime.block(workId,'model_snapshot_unavailable');
      const run=this.raw(row.id);run.error={code:'model_snapshot_unavailable',message:'model_snapshot_unavailable'};this.save(run);
    }
  }
  private exists(id:string){return Boolean(this.store.db.prepare('SELECT 1 FROM query_runs WHERE id=?').get(id));}
  private raw(id:string):QueryRun{const row=this.store.db.prepare('SELECT json FROM query_runs WHERE id=?').get(id);if(!row)throw new StoreError('Query run not found',404);return JSON.parse(String(row.json));}
  private save(run:QueryRun){this.store.db.prepare('UPDATE query_runs SET json=? WHERE id=?').run(JSON.stringify(run),run.id);}
  private executionFailure(error:unknown,id?:string){
    // Refused capacity has not failed this synchronous request. Preserve the
    // host fact so the shared executor can suspend without spending its budget.
    if(capacityWaiting(error))return error as ProviderFailure|ExecutionFailure;
    // A synchronous query keeps the previous single-attempt HTTP contract;
    // durable background admission can recover structured transient failures.
    if(error instanceof ProviderFailure&&error.details.category==='transient'&&id&&this.foreground.has(id))return new ExecutionFailure('permanent',error.details.code,error.details.retryAfterMs);
    return error instanceof ProviderFailure||error instanceof ExecutionFailure||error instanceof AgentYieldError?error:new ExecutionFailure('permanent',error instanceof AgentTimeoutError?'timeout':error&&typeof error==='object'&&(error as {code?:unknown}).code==='source_context_changed'?'source_context_changed':'query_failed');
  }
  /** Save only a sanitized attempt receipt. A retry has not failed the conversation. */
  private rememberFailure(id:string,error:unknown){
    if(capacityWaiting(error))return;
    const work=this.runtime.get('query:'+id),stepId=work.id+':coordinator:'+work.revision,fence=String(this.store.db.prepare('SELECT fence FROM execution_steps WHERE id=?').get(stepId)?.fence??'');
    if(work.status!=='running'||!fence)return;
    const own=!this.store.db.isTransaction;if(own)this.store.db.exec('BEGIN IMMEDIATE');
    try{
      if(this.runtime.engine.isCurrentInputGrant(stepId,fence)){
        const saved=this.runtime.journal.payload<SavedInput>(work.id),failure=safeError(error),name=error&&typeof error==='object'?(error as {name?:unknown}).name:undefined;
        saved.lastFailure={...failure,...(name==='AgentProviderError'?{kind:'provider' as const}:name==='AgentResponseError'?{kind:'response' as const}:{})};
        this.runtime.journal.savePayload(work.id,saved);this.errors.set(id,error);
      }
      if(own)this.store.db.exec('COMMIT');
    }catch{if(own&&this.store.db.isTransaction)this.store.db.exec('ROLLBACK');}
  }
  private restoredFailure(saved:SavedFailure|undefined,work:DelegationWork):unknown{
    if(work.error==='source_context_changed')return Object.assign(new StoreError('Source context changed; retry with current context',409),{code:'source_context_changed'});
    if(saved?.reason)return saved.kind==='response'?Object.assign(new Error(saved.message),{name:'AgentResponseError',reason:saved.reason}):new ProviderFailure({category:'permanent',code:saved.reason as ProviderFailure['details']['code']});
    if(saved?.kind==='provider')return Object.assign(new Error(saved.message),{name:'AgentProviderError'});
    if(saved?.category==='timeout'||work.error==='timeout')return new AgentTimeoutError();
    if(saved?.category==='model_not_configured')return Object.assign(new Error(saved.message),{name:'AgentNotConfiguredError'});
    return new StoreError(saved?.message??work.error??'Query did not complete',saved?.status??409);
  }
  /** The conversation failure and its receipt share one host transaction. */
  private finishFailure(run:QueryRun,work:DelegationWork){
    const foreground=this.foregroundRequests.get(run.id);
    // A recovery block did not make a model attempt or publish a product; the
    // run receipt stays visible without creating a conversation failure turn.
    if(work.status==='blocked'&&work.error==='model_snapshot_unavailable')return;
    if(!['failed','blocked'].includes(work.status)&&!(work.status==='stale'&&(work.error==='source_context_changed'||work.error==='evidence_deleted'&&foreground)))return;
    const own=!this.store.db.isTransaction;if(own)this.store.db.exec('BEGIN IMMEDIATE');
    try{
      const current=this.runtime.get(work.id),receipt=this.raw(run.id);
      const erasedForeground=current.status==='stale'&&current.error==='evidence_deleted'&&foreground&&!foreground.cancelled&&receipt.status!=='cancelled'&&!this.store.db.prepare('SELECT 1 FROM delegation_payloads WHERE work_id=?').get(work.id);
      if((['failed','blocked'].includes(current.status)||current.status==='stale'&&current.error==='source_context_changed'||erasedForeground)&&(!receipt.turnId||receipt.status==='running')){
        // Source deletion deliberately erases the replay payload. The live user
        // request can still retain its question, without resurrecting derived
        // context or trusting a late provider callback after the grant expired.
        const saved:Pick<SavedInput,'hostRequest'|'lastFailure'>=erasedForeground?foreground!:this.runtime.journal.payload<SavedInput>(work.id);
        const error=erasedForeground?new StoreError('Evidence used by this answer is no longer available',409):this.errors.get(run.id)??this.restoredFailure(saved.lastFailure,current),failure=saved.lastFailure??safeError(error);
        const timedOut=failure.category==='timeout'||current.error==='timeout';
        // A timed-out fragment cannot publish a conversation turn after its grant
        // has expired; waiting time never establishes a timeout.
        const conversation=timedOut?undefined:this.callbacks.failure?.(saved.hostRequest,error,current),finished={...run,...conversation,error:{code:timedOut?'timeout':current.error==='source_context_changed'?'source_context_changed':failure.reason??failure.category,message:failure.message,reason:failure.reason,diagnostic:sanitizeFailureDiagnostics({...failure.diagnostic!,lastTool:[...run.events].reverse().find(e=>e.stage==='tool'&&e.phase==='completed')?.tool})}};
        this.save(finished);
        if(own)this.store.db.exec('COMMIT');
        Object.assign(run,finished);if(conversation&&error&&typeof error==='object')Object.assign(error,{conversation});
        return;
      }
      if(own)this.store.db.exec('COMMIT');
    }catch{if(own&&this.store.db.isTransaction)this.store.db.exec('ROLLBACK');}
  }
  private observe(id:string,event:AgentProgress){
    if(!this.exists(id))return;const run=this.raw(id);if(run.status!=='running'||run.evidenceRevision!==this.store.deletionRevision())return;
    // Model-authored progress prose may repeat private evidence. This public
    // metadata receipt keeps only structured execution observations; semantic
    // delegation progress lives in the private journal.
    const next:AgentProgress&{at:string}={stage:event.stage,at:new Date().toISOString(),...(event.tool?{tool:event.tool.slice(0,80)}:{}),...(event.phase?{phase:event.phase}:{}),...(Number.isSafeInteger(event.step)?{step:event.step}:{}),...(Number.isSafeInteger(event.count)?{count:event.count}:{})};
    run.events.push(next);run.events=run.events.slice(-120);run.updatedAt=next.at;this.save(run);
  }
  private notify(id:string){for(const resolve of this.waiters.get(id)??[])resolve();this.waiters.delete(id);}
  get(id:string):QueryRun{
    const run=this.raw(id);let work:DelegationWork;
    const before=JSON.stringify({...run,operationUsage:undefined}),beforeUsage=JSON.stringify(run.operationUsage);
    work=this.runtime.get('query:'+id);
    const stepId=work.id+':coordinator:'+work.revision,step=this.runtime.engine.get(stepId);
    if(step&&['failed','blocked','stale','cancelled'].includes(step.state)&&['running','waiting'].includes(work.status)){this.runtime.engine.project(stepId);work=this.runtime.get(work.id);}
    if(['failed','blocked','stale','cancelled'].includes(work.status))this.runtime.engine.abortLocal(stepId);
    run.status=work.error==='timeout'||run.error?.code==='timeout'?'failed':work.status==='succeeded'?'completed':work.status==='cancelled'?'cancelled':['running','waiting'].includes(work.status)?'running':'failed';
    run.sourceContextDependencies=this.runtime.sourceContextDependencies(work.id);
    if(work.error==='timeout')run.error={code:'timeout',message:moteText('模型执行超时，请重试。')};
    else if(run.status==='failed'){this.finishFailure(run,work);if(!run.error){const failure=safeError(this.restoredFailure(undefined,work));run.error={code:work.error==='evidence_deleted'?'deleted':work.error==='source_context_changed'?'source_context_changed':failure.category,message:failure.message};}}
    if(run.status!=='running'&&!this.foreground.has(id))this.errors.delete(id);
    run.updatedAt=work.updatedAt;
    if(this.callbacks.operationUsage)run.operationUsage=this.callbacks.operationUsage(work.operationId,run.createdAt,run.status==='running'?new Date().toISOString():run.updatedAt);
    const executionStatus=run.status==='running'&&work.status==='waiting'?(work.wait?'waiting':step?.error?'retry_wait':'queued'):run.status;
    const attempts=Number(this.store.db.prepare("SELECT coalesce(sum(attempts),0) n FROM execution_steps WHERE operation_id=? AND kind='delegation.coordinator.query'").get(work.operationId)?.n??0);
    run.execution=executionEnvelope({status:executionStatus,attempts,errorCode:run.error?.code??step?.error,availableAt:step?.availableAt,updatedAt:run.updatedAt});
    // The returned envelope keeps the live countdown, but retryAfterMs is
    // clock-derived from step.availableAt; persist the deadline as an offset
    // from run creation so unchanged waits compare equal across clock ticks
    // while a moved deadline, status or attempt still writes once.
    const persistedExecution=JSON.parse(JSON.stringify(run.execution)) as typeof run.execution,createdAt=Date.parse(run.createdAt);
    for(const slot of [persistedExecution?.failure,persistedExecution?.waiting])if(slot?.retryAfterMs!==undefined)slot.retryAfterMs=Math.max(0,(step?.availableAt??createdAt)-createdAt);
    const changed=JSON.stringify({...run,operationUsage:undefined,execution:persistedExecution})!==before
      ||run.status!=='running'&&JSON.stringify(run.operationUsage)!==beforeUsage;
    if(changed)this.save({...run,execution:persistedExecution});return run;
  }
  list(){return this.store.db.prepare("SELECT id FROM query_runs ORDER BY json_extract(json,'$.createdAt') DESC,id DESC LIMIT 100").all().map(row=>this.get(String(row.id)));}
  start(id:string,input:unknown,deadline:RunDeadline={}){
    if(this.stopped)throw new StoreError('Feature is closed',503);
    if(typeof (input as {question?:unknown})?.question!=='string')throw new StoreError('Query requires a question',400);
    const identity=this.callbacks.requestIdentity?.(id,input),requestHash=createHash('sha256').update(JSON.stringify(identity??input)).digest('hex'),existing=this.store.db.prepare('SELECT request_hash FROM query_runs WHERE id=?').get(id);
    if(existing){
      if(existing.request_hash!==requestHash)throw new StoreError('Run ID belongs to a different request',409);
      if(identity){const saved=this.runtime.journal.payload<SavedInput>('query:'+id),resolved=this.callbacks.resolveInput?.(input)??input;if(JSON.stringify(saved.hostRequest)!==JSON.stringify(resolved))throw new StoreError('Run ID belongs to a different request',409);}
      return this.get(id);
    }
    input=this.callbacks.resolveInput?.(input)??input;
    const request=input as {anchorEvidenceIds?:string[]|null;evidenceIds?:string[]|null;question:string;conversationId?:string;after?:string;before?:string;deviceId?:string;timeZone?:string;modelProfileId?:string;modelOverride?:string};
    if(request.conversationId&&this.store.db.prepare("SELECT 1 FROM query_runs WHERE json_extract(json,'$.conversationId')=? AND json_extract(json,'$.status')='running'").get(request.conversationId))throw new StoreError('An answer is already running in this conversation',409);
    const at=new Date().toISOString(),contextTime=this.callbacks.contextTime?.()??at,run:QueryRun={id,operationId:'query:'+id,status:'running',createdAt:at,updatedAt:at,events:[],evidenceRevision:this.store.deletionRevision(),...(request.conversationId?{conversationId:request.conversationId}:{}),...this.callbacks.initialReceipt?.(id)};
    const saved:SavedInput={question:request.question,hostRequest:input,language:requestLocale.getStore()??'zh-CN',...(deadline.timeoutMs!==undefined&&deadline.timeoutMs!==null?{executionTimeoutMs:Math.max(1,deadline.timeoutMs)}:{})};
    const foreground=this.foregroundRequests.get(id);if(foreground)foreground.executionTimeoutMs=saved.executionTimeoutMs;
    if(foreground)foreground.hostRequest=structuredClone(input);
    this.store.db.exec('BEGIN IMMEDIATE');
    try{
      this.store.reserveMetadata(32768);this.store.db.prepare('INSERT INTO query_runs VALUES(?,?,?)').run(id,requestHash,JSON.stringify(run));
      this.runtime.start({id:'query:'+id,operationId:'query:'+id,profileId:'query',goal:request.question,input:saved,scope:{...(request.anchorEvidenceIds?{anchorEvidenceIds:request.anchorEvidenceIds}:{}),...(request.evidenceIds?{evidenceIds:request.evidenceIds}:{}),...(request.after?{after:request.after}:{}),...(request.before?{before:request.before}:{}),...(request.deviceId?{deviceId:request.deviceId}:{}),...(request.timeZone?{timeZone:request.timeZone}:{}),contextTime},allowedCapabilities:request.evidenceIds?.length===0?[]:['context.research']});
      this.store.db.exec('COMMIT');
    }catch(error){if(this.store.db.isTransaction)this.store.db.exec('ROLLBACK');throw error;}
    return this.get(id);
  }
  cancel(id:string){const foreground=this.foregroundRequests.get(id);if(foreground)foreground.cancelled=true;this.get(id);this.runtime.cancel('query:'+id);this.notify(id);return this.get(id);}
  /** Observe an existing durable run without turning it into a foreground request. */
  async waitForSettlement(id:string):Promise<QueryRun>{
    for(;;){
      if(this.interrupted)throw new StoreError('Central node is shutting down; the saved work will resume',503);
      const run=this.get(id);if(run.status!=='running')return run;
      await new Promise<void>(resolve=>{const listeners=this.waiters.get(id)??new Set();listeners.add(resolve);this.waiters.set(id,listeners);});
    }
  }
  async perform<T extends Receipt>(id:string,input:unknown,deadline:RunDeadline={}):Promise<T>{
    this.foreground.add(id);
    try{
    if(typeof (input as {question?:unknown})?.question==='string')this.foregroundRequests.set(id,{hostRequest:structuredClone(input)});
    this.start(id,input,deadline);
    const read=()=>{if(!this.exists(id))throw new StoreError('Query was deleted while running',409);return this.get(id);};
    while(read().status==='running'){if(this.interrupted)throw new StoreError('Central node is shutting down; the saved work will resume',503);await new Promise<void>(resolve=>{const listeners=this.waiters.get(id)??new Set();listeners.add(resolve);this.waiters.set(id,listeners);});}
    const run=read(),savedResult=run.status==='completed'?this.runtime.result<QueryResult>('query:'+id):undefined,result=this.results.get(id)??(savedResult&&run.conversationId&&run.turnId?{...savedResult,conversationId:run.conversationId,turnId:run.turnId}:undefined);this.results.delete(id);
    if(run.status==='completed'&&result)return {...result,...(run.operationUsage?{operationUsage:run.operationUsage}:{})} as unknown as T;
    if(run.error?.code==='timeout')throw new AgentTimeoutError();
    const failed=this.errors.get(id);this.errors.delete(id);if(failed!==undefined)throw failed;
    const error=new StoreError(run.error?.message??'Query did not complete',409);if(run.error?.code==='source_context_changed')Object.assign(error,{code:'source_context_changed'});if(run.conversationId&&run.turnId)Object.assign(error,{conversation:{conversationId:run.conversationId,turnId:run.turnId}});throw error;
    }finally{this.foreground.delete(id);this.foregroundRequests.delete(id);this.results.delete(id);this.errors.delete(id);}
  }
  async close(){clearInterval(this.timer);for(const id of this.waiters.keys())this.notify(id);}
  /** Stop admitting new receipts while accepted runs keep their fixed runtime. */
  quiesce(){this.stopped=true;}
  interrupt(){this.interrupted=true;for(const id of this.waiters.keys())this.notify(id);}
  async stop(){this.stopped=true;if(!this.runtime.engine.closed)for(const run of this.list())if(run.status==='running')this.cancel(run.id);await this.close();}
}
