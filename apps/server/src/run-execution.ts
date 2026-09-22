import {ExecutionEngine,ExecutionFailure,type ExecutionStep} from './execution-engine.js';
import {withExecutionCancellation} from './execution-cancellation.js';
import {executionEnvelope,type ExecutionEnvelope} from '@mote/shared/execution';
import {randomUUID} from 'node:crypto';
import {StoreError,type Store} from './store.js';

export type RunExecutionOptions={executor?:ExecutionEngine;concurrency?:()=>number};
export type RunDeadline={timeoutMs?:number|null};
export type RunExecutionContext={signal:AbortSignal;operationId:string;jobId:string;commit:<T>(write:()=>T)=>T};
type Pending={work:(signal:AbortSignal,execution:RunExecutionContext)=>Promise<unknown>;done:Promise<void>;finish:()=>void;timer?:ReturnType<typeof setTimeout>};
/** Non-replayable interactive work uses the same claims and commit fences as
 * background work. Only identifiers enter durable inputs; prompts stay in their
 * existing vault. A restart records interruption, never resubmits a model call. */
export class RunExecution {
 readonly engine:ExecutionEngine;
 private pending=new Map<string,Pending>();
 private started=new Set<string>();
 private unregister:()=>void;
 private ownerId=randomUUID();
 private heartbeat?:ReturnType<typeof setInterval>;
 private observed=new Set<string>();
 private renewedAt=0;
 constructor(private store:Store,readonly kind:'query'|'insight',private callbacks:{exists?:(id:string)=>boolean;project:(id:string,step:ExecutionStep)=>void;commit:(id:string,result:unknown)=>void;failure:(id:string,error:unknown)=>void},options:RunExecutionOptions={}){
  this.engine=options.executor??new ExecutionEngine(store);
  store.db.exec('CREATE TABLE IF NOT EXISTS run_execution_owners(id TEXT PRIMARY KEY,lease_until INTEGER NOT NULL)');
  this.unregister=this.engine.register({kind:`${kind}.run.${this.ownerId}`,pool:kind==='query'?'interactive-query':'personal-insight',concurrency:options.concurrency??(()=>kind==='query'?4:1),maxAttempts:1,timeoutMs:2147483647,
   validate:step=>this.pending.has(String(step.input.runId))&&(this.callbacks.exists?.(String(step.input.runId))??true),
   execute:async(step,signal)=>{const id=String(step.input.runId),pending=this.pending.get(id)!;
    const fence=String(store.db.prepare('SELECT fence FROM execution_steps WHERE id=?').get(step.id)?.fence??'');
    const commit=<T>(write:()=>T):T=>{signal.throwIfAborted();const db=store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');try{if(!fence||!this.engine.isCurrentGrant(step.id,fence))throw new StoreError('Run execution grant expired',409);const result=write();if(own)db.exec('COMMIT');return result;}catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}};
    try{return await withExecutionCancellation(signal,()=>pending.work(signal,{signal,operationId:step.operationId,jobId:id,commit}));}
    catch(error){if(!signal.aborted){try{commit(()=>this.callbacks.failure(id,error));}catch{/* A revoked/deleted run cannot write failure history. */}}throw error;}
   },
   commit:(step,result)=>this.callbacks.commit(String(step.input.runId),result),
   classify:error=>error&&typeof error==='object'&&(error as {reason?:string}).reason==='snapshot_changed'?new ExecutionFailure('stale','snapshot_changed'):new ExecutionFailure('permanent',error instanceof ExecutionFailure?error.code:'run_failed'),
   project:step=>{const id=String(step.input.runId);if(this.engine.closed&&step.state==='waiting'){this.engine.fail(step.id,'interrupted');return;}this.callbacks.project(id,step);if(!['waiting','running'].includes(step.state))this.finish(id);},
  });
 }
 id(id:string){return `${this.kind}:${id}`;}
 step(id:string){return this.engine.get(this.id(id));}
 /** Install legacy receipts without running old work or trusting legacy prompts. */
 restore(id:string,input:{state:ExecutionStep['state'];attempts?:number;createdAt:string;updatedAt:string;error?:string;availableAt?:number}){
  const stepId=this.id(id),prior=this.engine.get(stepId);
  if(prior){
   if(['waiting','running'].includes(prior.state)){
    const owner=typeof prior.input.ownerId==='string'?this.store.db.prepare('SELECT lease_until FROM run_execution_owners WHERE id=?').get(prior.input.ownerId):undefined;
    if(owner&&Number(owner.lease_until)>Date.now()){this.observed.add(id);this.startHeartbeat();this.callbacks.project(id,prior);}
    else{this.engine.fail(stepId,'interrupted');this.callbacks.project(id,this.engine.get(stepId)!);}
   }else this.callbacks.project(id,prior);
   return;
  }
  this.engine.enqueue(this.id(id),`${this.kind}.run.${this.ownerId}`,{runId:id,ownerId:this.ownerId},{id:stepId,initial:{state:input.state==='running'||input.state==='waiting'?'failed':input.state,attempts:input.attempts??1,availableAt:input.availableAt??0,error:input.state==='running'||input.state==='waiting'?'interrupted':input.error}});
  const created=Date.parse(input.createdAt),updated=Date.parse(input.updatedAt);
  if(Number.isFinite(created)&&Number.isFinite(updated)){this.store.db.prepare('UPDATE execution_steps SET created_at=?,updated_at=? WHERE id=?').run(created,updated,stepId);this.store.db.prepare('UPDATE operation_progress SET created_at=?,updated_at=? WHERE id=?').run(created,updated,this.id(id));this.engine.project(stepId);}
 }
 start(id:string,work:Pending['work'],options:RunDeadline={},journal?:()=>void){
  this.renewOwner();this.startHeartbeat();this.started.add(this.id(id));let finish!:()=>void;const done=new Promise<void>(resolve=>finish=resolve),pending:Pending={work,done,finish};this.pending.set(id,pending);
  const own=!this.store.db.isTransaction;if(own)this.store.db.exec('BEGIN IMMEDIATE');
  try{journal?.();
   this.engine.enqueue(this.id(id),`${this.kind}.run.${this.ownerId}`,{runId:id,ownerId:this.ownerId,...(options.timeoutMs!==undefined&&options.timeoutMs!==null?{deadlineAt:Date.now()+Math.max(1,options.timeoutMs)}:{})},{id:this.id(id)});
   if(own)this.store.db.exec('COMMIT');
   if(options.timeoutMs!==undefined&&options.timeoutMs!==null){
    const delay=Math.max(1,Math.min(2147483647,options.timeoutMs));
    pending.timer=setTimeout(()=>this.engine.fail(this.id(id),'timeout'),delay);pending.timer.unref();
   }
   void this.engine.tick().catch(error=>{this.callbacks.failure(id,error);this.engine.fail(this.id(id),'run_failed');});
  }catch(error){if(own&&this.store.db.isTransaction)this.store.db.exec('ROLLBACK');this.pending.delete(id);this.started.delete(this.id(id));finish();throw error;}
 }
 cancel(id:string){this.engine.cancel(this.id(id));}
 private renewOwner(){this.renewedAt=Date.now();this.store.db.prepare('INSERT INTO run_execution_owners VALUES(?,?) ON CONFLICT(id) DO UPDATE SET lease_until=excluded.lease_until').run(this.ownerId,Date.now()+30000);}
 /** Reconcile external cancellation/deletion without waiting for provider cooperation. */
 sync(id:string){
  let step=this.step(id);
  if(this.pending.has(id)&&this.callbacks.exists?.(id)===false&&step&&['waiting','running'].includes(step.state)){this.engine.cancel(step.id);step=this.step(id);}
  if(step)this.callbacks.project(id,step);
  if(!step||!['waiting','running'].includes(step.state)){this.engine.abortLocal(this.id(id));this.finish(id);this.observed.delete(id);}
  return step;
 }
 private startHeartbeat(){if(this.heartbeat)return;this.heartbeat=setInterval(()=>{
  if(this.pending.size&&Date.now()-this.renewedAt>=10000)this.renewOwner();
  for(const id of [...this.pending.keys()])this.sync(id);
  for(const id of [...this.observed]){const step=this.sync(id);if(!step||!['waiting','running'].includes(step.state))continue;const owner=this.store.db.prepare('SELECT lease_until FROM run_execution_owners WHERE id=?').get(String(step.input.ownerId));if(!owner||Number(owner.lease_until)<=Date.now()){this.engine.fail(step.id,'interrupted');this.sync(id);}}
  if(!this.pending.size&&!this.observed.size){clearInterval(this.heartbeat);this.heartbeat=undefined;}
 },250);this.heartbeat.unref();}
 private finish(id:string){const pending=this.pending.get(id);if(!pending)return;clearTimeout(pending.timer);this.pending.delete(id);pending.finish();queueMicrotask(()=>{void this.engine.drain([this.id(id)]).finally(()=>this.started.delete(this.id(id))).catch(()=>{});});}
 async wait(id:string){this.sync(id);await this.pending.get(id)?.done;await this.engine.drain([this.id(id)]);}
 async close(){for(const id of [...this.pending.keys()])this.sync(id);await Promise.all([...this.pending.values()].map(value=>value.done));await this.engine.drain([...this.started]);this.started.clear();clearInterval(this.heartbeat);this.heartbeat=undefined;this.store.db.prepare('DELETE FROM run_execution_owners WHERE id=?').run(this.ownerId);}
 /** Teardown only after close; shared engines retain the same lifetime as the app. */
 dispose(){this.unregister();}
}
export function runEnvelope(step:ExecutionStep):ExecutionEnvelope{
 const status=step.state==='waiting'?'queued':step.state==='succeeded'?'completed':step.state==='blocked'||step.state==='stale'?'failed':step.state;
 return executionEnvelope({status,attempts:step.attempts,errorCode:step.error,availableAt:step.availableAt});
}
