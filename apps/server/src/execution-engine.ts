import {observationClock,observationGap,type ExecutionLeaseObservation} from './execution-observability.js';
import {ProviderFailure} from '@mote/shared';
import {installOperationProjection,linkOperation,type OperationMembership} from './operation-projection.js';
import {randomUUID,createHash} from 'node:crypto';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {StoreError,type Store} from './store.js';
import {withExecutionCancellation} from './execution-cancellation.js';
import {failureContext,retainFailureContext,safeFailureContext,type FailureContext} from './execution-failures.js';
import {EXECUTION_POLICIES,type ExecutionPolicy} from './execution-policy.js';

export type ExecutionState='waiting'|'running'|'blocked'|'succeeded'|'failed'|'cancelled'|'stale';
export type ExecutionLane='background'|'interactive';
/** Trusted host configuration. Lane is derived from existing product identity,
 * never from model-authored input or a new persistent authority field. */
export type ExecutionPoolAdmission={concurrency:Record<ExecutionLane,()=>number>;lane:(step:ExecutionStep)=>ExecutionLane};
export type ExecutionStep={id:string;operationId:string;kind:string;pool:string;input:Record<string,unknown>;state:ExecutionState;attempts:number;availableAt:number;error?:string};
export type ExecutionFailureReceipt=FailureContext&{stepId:string;operationId:string;kind:string;state:ExecutionState;category:ExecutionFailure['category'];code:string;attempt:number;at:string;executionStarted?:false;admissionWaiting?:true;availableAt?:number};
/** A running handler can publish incremental progress only through its current lease. */
export interface ExecutionGrant {
 assert():void;
 commit<T>(write:()=>T):T;
}
export class ExecutionFailure extends Error {
 constructor(readonly category:'transient'|'permanent'|'blocked'|'stale'|'waiting',readonly code:string,readonly retryAfterMs?:number){super(code);}
}
export interface ExecutionHandler {
 kind:string;pool:string;concurrency:()=>number;
 policy?:ExecutionPolicy;
 validate:(step:ExecutionStep)=>boolean;
 /** Extra authority check for a running parent's dependent publication. */
 validateGrant?:(step:ExecutionStep)=>boolean;
 resourceKeys?:(step:ExecutionStep)=>string[];
 admit?:(step:ExecutionStep)=>ExecutionFailure|undefined;
 execute:(step:ExecutionStep,signal:AbortSignal,grant:ExecutionGrant)=>Promise<unknown>;
 /** Host-only, synchronous commit runs in the engine's fenced transaction. */
 commit:(step:ExecutionStep,result:unknown)=>void;
 /** Compatibility views are projections, never used to claim a running step. */
 project?:(step:ExecutionStep)=>void;
 classify?:(error:unknown)=>ExecutionFailure;
 timeoutMs?:number|null|((step:ExecutionStep)=>number|null);
 maxAttempts?:number;
 maxRecoveryWindowMs?:number|null;
 /** Trusted identities/stage only; the engine never persists arbitrary errors. */
 failureContext?:(step:ExecutionStep)=>FailureContext;
}
type ProgramStep<T>=OperationMembership&{id:string;operationId:string;kind:string;pool:string;input:Record<string,unknown>;signal:AbortSignal;validate:()=>boolean;resourceKeys?:string[];admit?:()=>ExecutionFailure|undefined;execute:(signal:AbortSignal)=>Promise<unknown>;commit:(result:unknown)=>void;read:()=>T|undefined;project:(step:ExecutionStep)=>void;cached?:boolean;requireDurableResult?:boolean;initialAttempts?:number;policy?:ExecutionPolicy;timeoutMs?:number|null;maxAttempts?:number;maxRecoveryWindowMs?:number|null;classify?:(error:unknown)=>ExecutionFailure};
type Row={id:string;operation_id:string;kind:string;pool:string;input:string;state:ExecutionState;attempts:number;available_at:number;error:string|null;fence:string|null;lease_until:number;recovery_deadline?:number};
const view=(row:Row):ExecutionStep=>({id:row.id,operationId:row.operation_id,kind:row.kind,pool:row.pool,input:JSON.parse(row.input),state:row.state,attempts:row.attempts,availableAt:row.available_at,...(row.error?{error:row.error}:{})});
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)])):value;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const interrupted=new Error('Execution interrupted');

/** The host owns admission, retry, cancellation, leases and commit fences. */
export class ExecutionEngine {
 private modelAuthority?:{captureStep(step:ExecutionStep):void;assertStep(step:ExecutionStep):void;commitStep<T>(step:ExecutionStep,task:()=>T):T;runStep<T>(step:ExecutionStep,task:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal):Promise<T>};
 bindModelAuthority(authority:NonNullable<ExecutionEngine['modelAuthority']>){if(this.modelAuthority)throw Error('Model authority is already installed');this.modelAuthority=authority;}
 private programs=new Map<string,Promise<unknown>>();
 private handlers=new Map<string,ExecutionHandler>();
 private admissions=new Map<string,ExecutionPoolAdmission>();
 private active=new Map<string,{controller:AbortController;task:Promise<void>;pool:string;kind:string;lane:ExecutionLane}>();
 private stopping=false;
 private pumping=false;
 private pumpAgain=false;
 private scheduled:ReturnType<typeof setImmediate>|undefined;
 private failureReceiptWriteFailures=0;
 private observer:((value:ExecutionLeaseObservation)=>void)|undefined;
 private observerEnabled:(()=>boolean)|undefined;
 /** Trusted observation only; no task input, lease, grant or retry authority. */
 bindObserver(observer:((value:ExecutionLeaseObservation)=>void)|undefined,enabled?:()=>boolean){this.observer=observer;this.observerEnabled=enabled;}
 private observing(){try{return Boolean(this.observer)&&(this.observerEnabled?.()??true);}catch{return false;}}
 private observe(value:ExecutionLeaseObservation){try{if(this.observing())this.observer?.(value);}catch{/* Observation cannot abort or authorize execution. */}}
 constructor(readonly store:Store,private now=Date.now){
  store.db.exec(`CREATE TABLE IF NOT EXISTS execution_steps(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,kind TEXT NOT NULL,pool TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,fence TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,recovery_deadline INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS execution_resources(step_id TEXT NOT NULL REFERENCES execution_steps(id) ON DELETE CASCADE,resource_key TEXT NOT NULL,PRIMARY KEY(step_id,resource_key));
   CREATE INDEX IF NOT EXISTS execution_resource_owners ON execution_resources(resource_key,step_id);
   CREATE TABLE IF NOT EXISTS execution_dependencies(step_id TEXT NOT NULL REFERENCES execution_steps(id) ON DELETE CASCADE,dependency_id TEXT NOT NULL REFERENCES execution_steps(id),PRIMARY KEY(step_id,dependency_id));
   CREATE INDEX IF NOT EXISTS execution_dependents ON execution_dependencies(dependency_id,step_id);
   CREATE TABLE IF NOT EXISTS execution_cancellation_aliases(alias_id TEXT PRIMARY KEY,step_id TEXT NOT NULL REFERENCES execution_steps(id) ON DELETE CASCADE,cancelled INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS execution_operation_steps(operation_id TEXT NOT NULL,step_id TEXT NOT NULL REFERENCES execution_steps(id) ON DELETE CASCADE,slot TEXT NOT NULL DEFAULT '',generation TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1,optional INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(operation_id,step_id));
   CREATE INDEX IF NOT EXISTS execution_membership_step ON execution_operation_steps(step_id,active,operation_id);
   CREATE INDEX IF NOT EXISTS execution_ready ON execution_steps(pool,state,available_at,created_at);
   CREATE INDEX IF NOT EXISTS execution_operations ON execution_steps(operation_id,created_at);
   CREATE TABLE IF NOT EXISTS execution_sequence(pool TEXT PRIMARY KEY,next INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS execution_fairness(pool TEXT NOT NULL,operation_id TEXT NOT NULL,last_started INTEGER NOT NULL,PRIMARY KEY(pool,operation_id));`);
  store.db.exec('CREATE TABLE IF NOT EXISTS execution_failures(step_id TEXT PRIMARY KEY REFERENCES execution_steps(id) ON DELETE CASCADE,json TEXT NOT NULL)');
  store.db.exec('CREATE INDEX IF NOT EXISTS execution_recovery_deadline ON execution_steps(state,recovery_deadline)');
  installOperationProjection(store);
 }
 get closed(){return this.stopping;}
 private policy(handler:ExecutionHandler,step:ExecutionStep){const base=handler.policy??EXECUTION_POLICIES.orchestration;return {timeoutMs:handler.timeoutMs===undefined?base.timeoutMs:typeof handler.timeoutMs==='function'?handler.timeoutMs(step):handler.timeoutMs,maxAttempts:handler.maxAttempts??base.maxAttempts,maxRecoveryWindowMs:handler.maxRecoveryWindowMs===undefined?base.maxRecoveryWindowMs:handler.maxRecoveryWindowMs};}
 configurePool(pool:string,admission:ExecutionPoolAdmission){this.admissions.set(pool,admission);}
 private lane(step:ExecutionStep):ExecutionLane{return this.admissions.get(step.pool)?.lane(step)==='interactive'?'interactive':'background';}
 private limit(pool:string,lane:ExecutionLane){
  const admission=this.admissions.get(pool),configured=admission?admission.concurrency[lane]():Math.min(...[...this.handlers.values()].filter(handler=>handler.pool===pool).map(handler=>handler.concurrency()));
  return Math.max(1,Math.min(lane==='background'?32:Number.MAX_SAFE_INTEGER,Math.floor(configured)));
 }
 private running(pool:string,lane:ExecutionLane,now=this.now()){
  return (this.store.db.prepare("SELECT * FROM execution_steps WHERE pool=? AND state='running' AND lease_until>?").all(pool,now) as Row[]).filter(row=>this.lane(view(row))===lane).length;
 }
 /** Safe resource projection: no goals, evidence, provider credentials or prose. */
 poolSnapshot(pool:string){
  const lanes=this.admissions.has(pool)?['background','interactive'] as const:['background'] as const;
  const waiting=this.store.db.prepare("SELECT * FROM execution_steps WHERE pool=? AND state='waiting'").all(pool) as Row[];
  return Object.fromEntries(lanes.map(lane=>[lane,{limit:this.limit(pool,lane),running:this.running(pool,lane),waiting:waiting.filter(row=>this.lane(view(row))===lane).length}]));
 }
 register(handler:ExecutionHandler){if(this.handlers.has(handler.kind))throw Error('Duplicate execution handler');this.handlers.set(handler.kind,handler);return async()=>{if(this.handlers.get(handler.kind)!==handler)return;this.handlers.delete(handler.kind);const running=[...this.active.values()].filter(value=>value.kind===handler.kind);for(const value of running)value.controller.abort(interrupted);await Promise.allSettled(running.map(value=>value.task));};}
 enqueue(operationId:string,kind:string,input:Record<string,unknown>,options:OperationMembership&{id?:string;dependencies?:string[];initial?:{state:ExecutionState;attempts:number;availableAt:number;error?:string}}={}){
  if(this.stopping)throw new StoreError('Execution engine is closed',503);
  const handler=this.handlers.get(kind);if(!handler)throw new StoreError('Execution handler unavailable',409);
  input=canonical(input) as Record<string,unknown>;
  const json=JSON.stringify(input);
  const id=options.id??hash([operationId,kind,input]),now=this.now(),db=this.store.db;
  const own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
  try{
   const existing=db.prepare('SELECT 1 FROM execution_steps WHERE id=?').get(id);
   if(!existing){this.store.reserveMetadata(Buffer.byteLength(json)+1024);db.prepare("INSERT INTO execution_steps(id,operation_id,kind,pool,input,state,created_at,updated_at) VALUES(?,?,?,?,?,'waiting',?,?)").run(id,operationId,kind,handler.pool,json,now,now);}
   const step=this.get(id)!;if(step.kind!==kind||JSON.stringify(step.input)!==json)throw new StoreError('Execution identity conflict',409);
   if(!existing)this.modelAuthority?.captureStep(step);
   if(options.initial&&!existing){const seed=options.initial;db.prepare('UPDATE execution_steps SET state=?,attempts=?,available_at=?,error=? WHERE id=?').run(seed.state==='running'?'waiting':seed.state,seed.attempts,seed.availableAt,seed.state==='running'?'interrupted':seed.error??null,id);}
   for(const key of new Set(handler.resourceKeys?.(step)??[]))if(!db.prepare('SELECT 1 FROM execution_resources WHERE step_id=? AND resource_key=?').get(id,key)){this.store.reserveMetadata(Buffer.byteLength(key)+64);db.prepare('INSERT INTO execution_resources VALUES(?,?)').run(id,key);}
   for(const dep of options.dependencies??[])db.prepare('INSERT OR IGNORE INTO execution_dependencies VALUES(?,?)').run(id,dep);
   linkOperation(this.store,operationId,id,options);handler.project?.(this.get(id)!);if(own)db.exec('COMMIT');return id;
  }catch(error){if(own)db.exec('ROLLBACK');throw error;}
 }
 get(id:string){const row=this.store.db.prepare('SELECT * FROM execution_steps WHERE id=?').get(id) as Row|undefined;return row?view(row):undefined;}
 failure(id:string):ExecutionFailureReceipt|undefined {const row=this.store.db.prepare('SELECT json FROM execution_failures WHERE step_id=?').get(id);return row?JSON.parse(String(row.json)):undefined;}
 failureDiagnostics(){return {writeFailures:this.failureReceiptWriteFailures};}
 private retainFailure(step:ExecutionStep,state:ExecutionState,failure:ExecutionFailure,error?:unknown){
  // One bounded receipt per retained step follows that step's existing deletion
  // lifecycle. A full disk must not turn failure reporting into another run.
  let hostContext:FailureContext={};try{hostContext=this.handlers.get(step.kind)?.failureContext?.(step)??{};}catch{/* Retired inputs cannot remove the fixed execution receipt. */}
  try{const context={...hostContext,...failureContext(error)},receipt:ExecutionFailureReceipt={...safeFailureContext(context),stepId:step.id,operationId:step.operationId,kind:step.kind,state,category:failure.category,code:/^[a-z][a-z0-9_.:-]{0,99}$/.test(failure.code)?failure.code:'execution_failed',attempt:step.attempts,at:new Date(this.now()).toISOString(),...(error instanceof ProviderFailure&&error.details.executionStarted===false?{executionStarted:false as const}:{}),...(error instanceof ProviderFailure&&error.details.admissionWaiting===true?{admissionWaiting:true as const}:{}),...(state==='waiting'&&step.availableAt>0?{availableAt:step.availableAt}:{})},json=JSON.stringify(receipt),prior=this.store.db.prepare('SELECT length(json) bytes FROM execution_failures WHERE step_id=?').get(step.id);this.store.reserveMetadata(Math.max(0,Buffer.byteLength(json)-Number(prior?.bytes??0))+(!prior?Buffer.byteLength(step.id)+128:0));this.store.db.prepare('INSERT INTO execution_failures VALUES(?,?) ON CONFLICT(step_id) DO UPDATE SET json=excluded.json').run(step.id,json);}catch{this.failureReceiptWriteFailures++;}
 }
 list(args:{operationId?:string;kind?:string;state?:ExecutionState;cursor?:number;limit?:number}={}){
  const clauses:string[]=[],values:(string|number)[]=[];
  if(args.operationId){clauses.push('EXISTS(SELECT 1 FROM execution_operation_steps o WHERE o.step_id=execution_steps.id AND o.operation_id=?)');values.push(args.operationId);}
  for(const [key,column] of [['kind','kind'],['state','state']] as const)if(args[key]){clauses.push(column+'=?');values.push(args[key]!);}
  if(args.cursor!==undefined){clauses.push('rowid<?');values.push(args.cursor);}
  const limit=Math.max(1,Math.min(args.limit??50,100)),rows=this.store.db.prepare(`SELECT rowid,* FROM execution_steps ${clauses.length?'WHERE '+clauses.join(' AND '):''} ORDER BY rowid DESC LIMIT ?`).all(...values,limit+1) as (Row&{rowid:number})[];
  return {items:rows.slice(0,limit).map(view),nextCursor:rows.length>limit?rows[limit-1].rowid:null};
 }
 project(id:string){const step=this.get(id);if(step)this.handlers.get(step.kind)?.project?.(step);}
 /** Transactional callers may defer local abort; lease renewal observes committed revocation. */
 cancel(id:string,abortLocal=true,reason='cancelled'){
  if(!/^[a-z][a-z0-9_]{0,80}$/.test(reason))throw new StoreError('Invalid cancellation reason',400);
  const alias=this.store.db.prepare('SELECT step_id FROM execution_cancellation_aliases WHERE alias_id=?').get(id);
  if(alias){this.store.db.prepare('UPDATE execution_cancellation_aliases SET cancelled=1 WHERE alias_id=?').run(id);id=String(alias.step_id);}
  const db=this.store.db;db.prepare("UPDATE execution_steps SET state='cancelled',fence=NULL,error=?,updated_at=? WHERE id=? AND state!='succeeded'").run(reason,this.now(),id);if(abortLocal)this.active.get(id)?.controller.abort();this.project(id);
 }
 /** Stable operation identities can revoke the currently active resumable
  * fragment from another host without depending on its revision number. */
 bindCancellationAlias(aliasId:string,stepId:string){
  if(this.cancellationAliasRevoked(aliasId))throw new ExecutionFailure('stale','cancelled');
  this.store.db.prepare('INSERT INTO execution_cancellation_aliases(alias_id,step_id) VALUES(?,?) ON CONFLICT(alias_id) DO UPDATE SET step_id=excluded.step_id').run(aliasId,stepId);
 }
 cancellationAliasRevoked(aliasId:string){return Boolean(this.store.db.prepare('SELECT 1 FROM execution_cancellation_aliases WHERE alias_id=? AND cancelled=1').get(aliasId));}
 /** Revoke an unfinished run after a host deadline without pretending the user cancelled. */
 fail(id:string,code:string,context?:FailureContext){
  if(!/^[a-z][a-z0-9_]{0,80}$/.test(code))throw new StoreError('Invalid execution failure code',400);
  const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
  try{if(db.prepare("UPDATE execution_steps SET state='failed',fence=NULL,error=?,updated_at=? WHERE id=? AND state NOT IN ('succeeded','failed','cancelled','stale')").run(code,this.now(),id).changes){const step=this.get(id)!;this.retainFailure(step,'failed',new ExecutionFailure('permanent',code),context?retainFailureContext(new Error(),context):undefined);}this.project(id);if(own)db.exec('COMMIT');}
  catch(error){if(own)db.exec('ROLLBACK');throw error;}
  this.active.get(id)?.controller.abort();
 }
 cancelKind(kind:string){for(;;){const rows=this.store.db.prepare("SELECT id FROM execution_steps WHERE kind=? AND state NOT IN ('succeeded','cancelled','stale') LIMIT 500").all(kind);if(!rows.length)return;for(const row of rows)this.cancel(String(row.id));}}
 retry(id:string,resetAttempts=false){
  if(this.get(id)?.state==='running')throw new StoreError('Cancel the active step before retrying',409);
  this.active.get(id)?.controller.abort();this.store.db.prepare("UPDATE execution_steps SET state='waiting',attempts=CASE WHEN ? THEN 0 ELSE attempts END,available_at=0,lease_until=0,fence=NULL,error=NULL,recovery_deadline=CASE WHEN ? THEN 0 ELSE recovery_deadline END,updated_at=? WHERE id=? AND state!='running'").run(Number(resetAttempts),Number(resetAttempts),this.now(),id);this.project(id);
 }
 /** Restore an issued attempt refunded by shutdown, without granting execution.
  * The domain settles its exact authenticated receipt in this same transaction. */
 recoverAttemptCount(id:string,expectedInput:Record<string,unknown>,issuedAttempt:number){
  if(!Number.isSafeInteger(issuedAttempt)||issuedAttempt<1)throw new StoreError('Invalid recovered execution attempt',400);
  if(!this.store.db.isTransaction)throw new StoreError('Recovered execution settlement needs a transaction',409);
  if(this.active.has(id))return false;
  return Boolean(this.store.db.prepare("UPDATE execution_steps SET attempts=max(attempts,?),updated_at=? WHERE id=? AND input=? AND state IN ('waiting','blocked')").run(issuedAttempt,this.now(),id,JSON.stringify(expectedInput)).changes);
 }
 /** Stop only this host's work after another writer revoked its durable grant. */
 abortLocal(id:string){this.active.get(id)?.controller.abort();}
 isCurrentGrant(id:string,fence:string){return Boolean(this.store.db.prepare("SELECT 1 FROM execution_steps WHERE id=? AND fence=? AND state='running' AND lease_until>?").get(id,fence,this.now()));}
 /** A child publication must retain both its parent's lease and input authority. */
 isCurrentInputGrant(id:string,fence:string){const step=this.get(id),handler=step&&this.handlers.get(step.kind);return Boolean(step&&handler&&this.isCurrentGrant(id,fence)&&handler.validate(step)&&(handler.validateGrant?.(step)??true));}
 /** A queued child retains durable input authority while its parent yields a
  * worker slot. Cancellation, paused admission and changed inputs still revoke
  * it. A temporary execution lease is not the authorization for derived work. */
 isCurrentInputAuthority(id:string){const step=this.get(id),handler=step&&this.handlers.get(step.kind);return Boolean(step&&handler&&['running','waiting'].includes(step.state)&&handler.validate(step)&&(handler.validateGrant?.(step)??true));}
 hasActive(kind:string){return [...this.active.keys()].some(id=>this.get(id)?.kind===kind);}
 /** Cancellation revokes the durable grant before local transport cleanup ends. */
 isActiveStep(id:string){return this.active.has(id);}
 /** Several completions in one turn need only one admission pass. */
 private scheduleTick(){
  if(this.stopping||this.scheduled)return;
  this.scheduled=setImmediate(()=>{this.scheduled=undefined;if(!this.stopping)void this.tick().catch(()=>{});});
 }
 async drain(ids:string[]){
  void this.tick().catch(()=>{});
  for(;;){const tasks=ids.flatMap(id=>{const task=this.active.get(id)?.task;return task?[task]:[];});if(!tasks.length)return;await Promise.all(tasks);void this.tick().catch(()=>{});}
 }
 private recover(){
  const db=this.store.db,now=this.now();
  for(const row of db.prepare("SELECT * FROM execution_steps WHERE state='waiting' AND recovery_deadline>0 AND recovery_deadline<=?").all(now) as Row[]){
   const handler=this.handlers.get(row.kind);
   // A retired dynamic definition cannot invent a recovery policy. Current
   // tasks with no elapsed recovery budget also retire old generic deadlines.
   if(!handler)continue;
   if(this.policy(handler,view(row)).maxRecoveryWindowMs===null){db.prepare('UPDATE execution_steps SET recovery_deadline=0 WHERE id=?').run(row.id);continue;}
   if(handler&&!handler.validate(view(row))){db.prepare("UPDATE execution_steps SET state='stale',fence=NULL,error='input_changed',updated_at=? WHERE id=? AND state='waiting'").run(now,row.id);this.project(row.id);}
   else this.fail(row.id,'recovery_window_exhausted');
  }
  for(const row of db.prepare("SELECT * FROM execution_steps WHERE state='running' AND lease_until<=?").all(now) as Row[]){
   // An expired host lease proves interruption, not a completed processing
   // failure. Issued external calls remain protected by their domain ledger.
   const recovered=db.prepare("UPDATE execution_steps SET state='waiting',attempts=max(0,attempts-1),fence=NULL,error='interrupted',available_at=0,updated_at=? WHERE id=? AND state='running' AND lease_until<=?").run(now,row.id,now).changes;
   if(recovered)this.observe({type:'recover',taskId:row.id,attempt:row.attempts,leaseOverdueMs:Math.max(0,now-row.lease_until)});
   this.project(row.id);
  }
 }
 /** Start available slots. Return only work admitted by this call; slow older work is independent. */
 tick(){
  if(this.stopping)return Promise.resolve();
  if(this.pumping){this.pumpAgain=true;return Promise.resolve();}
  this.pumping=true;const started:Promise<void>[]=[];
  try{
   this.recover();
   const blocked=this.store.db.prepare("WITH RECURSIVE blocked(id) AS (SELECT id FROM execution_steps WHERE state IN ('failed','blocked','cancelled','stale') UNION SELECT d.step_id FROM execution_dependencies d JOIN blocked b ON b.id=d.dependency_id) SELECT e.id FROM execution_steps e JOIN blocked b ON b.id=e.id WHERE e.state='waiting'").all();
   for(const row of blocked){this.store.db.prepare("UPDATE execution_steps SET state='blocked',error='dependency_failed',updated_at=? WHERE id=? AND state='waiting'").run(this.now(),String(row.id));this.project(String(row.id));}
   const pools=[...new Set([...this.handlers.values()].map(h=>h.pool))];
   for(const pool of pools){
    const handlers=[...this.handlers.values()].filter(h=>h.pool===pool),lanes:ExecutionLane[]=this.admissions.has(pool)?['background','interactive']:['background'];
    for(const lane of lanes){const limit=this.limit(pool,lane);
    while([...this.active.values()].filter(a=>a.pool===pool&&a.lane===lane).length<limit){
     if(this.running(pool,lane)>=limit)break;
     const candidates=this.store.db.prepare(`SELECT e.* FROM execution_steps e LEFT JOIN execution_fairness f ON f.pool=e.pool AND f.operation_id=e.operation_id WHERE e.pool=? AND e.state='waiting' AND e.available_at<=? AND e.kind IN (SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM execution_dependencies d JOIN execution_steps parent ON parent.id=d.dependency_id WHERE d.step_id=e.id AND parent.state!='succeeded') AND NOT EXISTS(SELECT 1 FROM execution_resources requested JOIN execution_resources held ON held.resource_key=requested.resource_key JOIN execution_steps owner ON owner.id=held.step_id WHERE requested.step_id=e.id AND owner.id!=e.id AND owner.state='running' AND owner.lease_until>?) ORDER BY coalesce(f.last_started,0),e.created_at,e.rowid`).iterate(pool,this.now(),JSON.stringify(handlers.map(h=>h.kind)),this.now());
     let row:Row|undefined;for(const candidate of candidates){if(!this.active.has(String(candidate.id))&&this.lane(view(candidate as Row))===lane){row=candidate as Row;break;}}
     if(!row)break;
     const handler=this.handlers.get(row.kind)!;if(!handler.validate(view(row))){this.store.db.prepare("UPDATE execution_steps SET state='stale',error='input_changed',updated_at=? WHERE id=? AND state='waiting'").run(this.now(),row.id);this.project(row.id);continue;}
     const controller=new AbortController();let completed=true;const task=this.execute(row,handler,controller).catch(error=>{completed=false;throw error;}).finally(()=>{if(this.active.get(row.id)?.controller===controller)this.active.delete(row.id);if(completed)this.scheduleTick();});
     this.active.set(row.id,{controller,task,pool,kind:row.kind,lane});started.push(task);
    }
    }
   }
  }finally{this.pumping=false;if(this.pumpAgain){this.pumpAgain=false;this.scheduleTick();}}
  return Promise.all(started).then(()=>{});
 }
 private async execute(row:Row,handler:ExecutionHandler,controller:AbortController){
  const db=this.store.db,now=this.now(),fence=randomUUID(),policy=this.policy(handler,view(row)),timeout=policy.timeoutMs;
  db.exec('BEGIN IMMEDIATE');
  try{
   const lane=this.lane(view(row)),limit=this.limit(row.pool,lane);
   if(db.prepare("SELECT state FROM execution_steps WHERE id=?").get(row.id)?.state!=='waiting'){db.exec('COMMIT');return;}
   if(this.running(row.pool,lane,now)>=limit){db.exec('COMMIT');return;}
   if(db.prepare("SELECT 1 FROM execution_resources requested JOIN execution_resources held ON held.resource_key=requested.resource_key JOIN execution_steps owner ON owner.id=held.step_id WHERE requested.step_id=? AND owner.id!=? AND owner.state='running' AND owner.lease_until>? LIMIT 1").get(row.id,row.id,now)){db.exec('COMMIT');return;}
   if(!handler.validate(view(row))){db.prepare("UPDATE execution_steps SET state='stale',error='input_changed',updated_at=? WHERE id=? AND state='waiting'").run(now,row.id);this.project(row.id);db.exec('COMMIT');return;}
   const admission=handler.admit?.(view(row));
   if(admission){
    db.prepare("UPDATE execution_steps SET state=?,available_at=?,error=?,recovery_deadline=CASE WHEN ? THEN 0 ELSE recovery_deadline END,updated_at=? WHERE id=? AND state='waiting'").run(admission.category==='waiting'?'waiting':'blocked',admission.category==='waiting'?this.now()+Math.max(1,admission.retryAfterMs??1000):0,admission.code,Number(admission.category==='waiting'),now,row.id);this.project(row.id);db.exec('COMMIT');
    // A short retry can become due again while the backlog is being checked.
    // Yield after the durable decision, with no transaction or running lease,
    // so both background completion wakes and explicit drains allow timers.
    if(admission.category==='waiting')await yieldTurn();return;
   }
   if(this.get(row.id)!.attempts>=policy.maxAttempts){
    db.prepare("UPDATE execution_steps SET state='failed',error='retry_budget_exhausted',updated_at=? WHERE id=? AND state='waiting'").run(now,row.id);
    this.retainFailure(this.get(row.id)!,'failed',new ExecutionFailure('permanent','retry_budget_exhausted'));this.project(row.id);db.exec('COMMIT');return;
   }
   const claimed=db.prepare("UPDATE execution_steps SET state='running',attempts=attempts+1,fence=?,lease_until=?,error=NULL,updated_at=? WHERE id=? AND state='waiting'").run(fence,now+(timeout===null?30000:Math.min(timeout+10000,30000)),now,row.id).changes;
   if(!claimed){db.exec('COMMIT');return;}
   const sequence=Number(db.prepare('INSERT INTO execution_sequence(pool,next) VALUES(?,1) ON CONFLICT(pool) DO UPDATE SET next=next+1 RETURNING next').get(row.pool)!.next);
   db.prepare('INSERT INTO execution_fairness(pool,operation_id,last_started) VALUES(?,?,?) ON CONFLICT(pool,operation_id) DO UPDATE SET last_started=excluded.last_started').run(row.pool,row.operation_id,sequence);
   this.project(row.id);db.exec('COMMIT');
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');db.prepare("UPDATE execution_steps SET state='blocked',error=?,updated_at=? WHERE id=? AND state='waiting'").run(error instanceof StoreError&&error.statusCode===507?'storage_full':'admission_failed',this.now(),row.id);this.project(row.id);return;}
  // Dispose deadlines when work settles. Composed AbortSignal.timeout sources
  // can remain strongly retained by Node until a long deadline actually fires.
  const step=this.get(row.id)!,signal=controller.signal;
  const deadline=timeout===null?undefined:setTimeout(()=>controller.abort(new DOMException('The operation was aborted due to timeout','TimeoutError')),timeout);deadline?.unref();
  let previousRenewal=this.observing()?observationClock():undefined,knownLeaseUntil=now+(timeout===null?30000:Math.min(timeout+10000,30000));
  const renewal=setInterval(()=>{
   if(this.stopping)return;
   const started=this.observing()?observationClock():undefined,priorLeaseUntil=knownLeaseUntil;
   let outcome:'renewed'|'cas_missed'|'renew_exception'='renew_exception',renewedAt:number|undefined;
   // The original CAS/abort boundary is unchanged. Observation runs afterward.
   try{const at=this.now();renewedAt=at;if(!db.prepare("UPDATE execution_steps SET lease_until=? WHERE id=? AND state='running' AND fence=? AND lease_until>?").run(at+30000,row.id,fence,at).changes){outcome='cas_missed';controller.abort();}else{outcome='renewed';knownLeaseUntil=at+30000;}}catch{controller.abort();}
   try{const ended=started?observationClock():undefined;
    if(started)this.observe({type:'renew',taskId:row.id,attempt:step.attempts,outcome,...observationGap(previousRenewal,started,10000),...(ended&&ended.monotonic>=started.monotonic?{durationMs:ended.monotonic-started.monotonic}:{}),...(renewedAt===undefined?{}:{leaseRemainingMs:Math.max(0,priorLeaseUntil-renewedAt),leaseOverdueMs:Math.max(0,renewedAt-priorLeaseUntil)})});
    previousRenewal=started;
   }catch{/* Logging failure cannot replace the original CAS outcome. */}
  },10000);renewal.unref();
  try{
   const assertGrant=()=>{
    if(signal.aborted)throw new ExecutionFailure('stale','grant_revoked');
    if(!this.isCurrentGrant(row.id,fence))throw new ExecutionFailure('stale','grant_revoked');
    if(!handler.validate(step))throw new ExecutionFailure('stale','input_changed');
    this.modelAuthority?.assertStep(step);
   };
   const grant:ExecutionGrant=Object.freeze({assert:assertGrant,commit:<T>(write:()=>T):T=>{
    if(db.isTransaction)throw new Error('Execution grant commit requires its own transaction');
    db.exec('BEGIN IMMEDIATE');
    try{assertGrant();const result=write();assertGrant();db.exec('COMMIT');return result;}
    catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
   }});
   const result=await withExecutionCancellation(signal,()=>this.modelAuthority?this.modelAuthority.runStep(step,authorizedSignal=>handler.execute(step,authorizedSignal,grant),signal):handler.execute(step,signal,grant));
   signal.throwIfAborted();
   db.exec('BEGIN IMMEDIATE');
   try{
    if(!this.isCurrentGrant(row.id,fence)){db.exec('ROLLBACK');return;}
    if(!handler.validate(step))throw new ExecutionFailure('stale','input_changed');
    this.modelAuthority?.assertStep(step);
    const commit=()=>{
     handler.commit(step,result);
     const at=this.now();
     if(!db.prepare("UPDATE execution_steps SET state='succeeded',fence=NULL,error=NULL,updated_at=? WHERE id=? AND fence=? AND state='running' AND lease_until>?").run(at,row.id,fence,at).changes)return false;
     // Terminal projection may enqueue a dependent continuation. It must retain
     // this step's admission, independent of whichever caller woke the executor.
     this.project(row.id);return true;
    };
    if(!(this.modelAuthority?this.modelAuthority.commitStep(step,commit):commit())){db.exec('ROLLBACK');return;}
    db.exec('COMMIT');
   }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  }catch(error){
   const classified=error instanceof ExecutionFailure?error:error instanceof ProviderFailure?new ExecutionFailure(error.details.category,error.details.code,error.details.retryAfterMs):handler.classify?.(error)??new ExecutionFailure('permanent','processor_failed');
   // A fixed transport/admission fact is a capacity wait, never evidence that
   // the input failed processing. Domain issued-call guards still decide if a
   // physical request may be sent; this does not clear an unknown outcome.
   const admissionWait=error instanceof ProviderFailure&&error.details.admissionWaiting===true;
   const failure=admissionWait||classified.code==='rate_limited'&&classified.category==='transient'?new ExecutionFailure('waiting',classified.code,classified.retryAfterMs):classified;
   const stopping=this.stopping||signal.reason===interrupted;
   const capacityWait=failure.category==='waiting',attempts=Math.max(0,step.attempts-Number(capacityWait||stopping));
   let state:ExecutionState=stopping?'waiting':failure.category==='blocked'?'blocked':failure.category==='stale'?'stale':capacityWait?'waiting':failure.category==='permanent'||attempts>=policy.maxAttempts?'failed':'waiting';
   const at=this.now(),availableAt=stopping?0:at+Math.max(capacityWait?1:0,failure.retryAfterMs??(capacityWait?1000:Math.min(3600000,1000*2**(attempts-1))));
   const recoveryDeadline=capacityWait||policy.maxRecoveryWindowMs===null?0:failure.category==='transient'&&!stopping?(Number(row.recovery_deadline)||at+Math.max(1,policy.maxRecoveryWindowMs)):Number(row.recovery_deadline)||0;
   let code=stopping?'interrupted':failure.code;
   if(!stopping&&state==='waiting'&&failure.category==='transient'&&recoveryDeadline&&availableAt>=recoveryDeadline){state='failed';code='recovery_window_exhausted';}
   const own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');let changed=false;
   try{changed=Boolean(db.prepare("UPDATE execution_steps SET state=?,attempts=?,error=?,available_at=?,recovery_deadline=?,fence=NULL,updated_at=? WHERE id=? AND fence=? AND state='running' AND lease_until>?").run(state,attempts,code,availableAt,recoveryDeadline,at,row.id,fence,at).changes);if(changed)this.retainFailure(this.get(row.id)!,state,new ExecutionFailure(failure.category,code),error);if(own)db.exec('COMMIT');}catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}
   if(changed)handler.project?.(this.get(row.id)!);
  }finally{clearTimeout(deadline);clearInterval(renewal);}
  await yieldTurn();
 }
 /** Replayable host programs define a substep when reached. State and its artifact
  * commit still belong to this engine; a restart reconstructs the definition. */
 async runStep<T>(options:ProgramStep<T>):Promise<T>{
  const prior=this.programs.get(options.id);
  const task=(async()=>{if(prior)await withExecutionCancellation(options.signal,()=>prior.catch(()=>{}));return this.replayStep(options);})();
  this.programs.set(options.id,task);
  try{return await task;}finally{if(this.programs.get(options.id)===task)this.programs.delete(options.id);}
 }
 private async replayStep<T>(options:ProgramStep<T>):Promise<T>{
  options.signal.throwIfAborted();
  const kind=options.kind+'.'+options.id;let failure:unknown;
  const unregister=this.register({kind,pool:options.pool,concurrency:()=>1,validate:()=>options.validate(),resourceKeys:()=>options.resourceKeys??[],admit:options.admit,policy:options.policy,timeoutMs:options.timeoutMs,maxAttempts:options.maxAttempts,maxRecoveryWindowMs:options.maxRecoveryWindowMs,
   execute:async(_step,signal)=>{try{return await options.execute(AbortSignal.any([signal,options.signal]));}catch(error){failure=error;throw error;}},
   commit:(_step,result)=>{try{options.commit(result);}catch(error){failure=error;throw error;}},project:options.project,
   // The child owns retries; a replayed parent only observes durable progress.
   classify:options.classify??(()=>new ExecutionFailure('permanent','step_failed')),
  });
  const abort=()=>{if(this.stopping||options.signal.reason===interrupted)this.active.get(options.id)?.controller.abort(interrupted);else this.cancel(options.id);};options.signal.addEventListener('abort',abort,{once:true});
  try{
   this.enqueue(options.operationId,kind,options.input,{id:options.id,generation:options.generation,optional:options.optional,initial:{state:options.cached?'succeeded':'waiting',attempts:options.initialAttempts??0,availableAt:0}});
   const current=this.get(options.id)!;
   // Reaching a blocked prerequisite again rechecks the current handler's
   // admission (including an issued-call guard). It never reopens cancelled,
   // stale or failed work, whose explicit retry belongs to the domain owner.
   if(current.state==='succeeded'&&options.requireDurableResult&&options.read()===undefined)throw new ExecutionFailure('permanent','memory_phase_output_missing');
   if(current.state==='blocked'||current.state==='succeeded'&&options.read()===undefined)this.retry(options.id,false);
   await this.drain([options.id]);options.signal.throwIfAborted();
   const step=this.get(options.id)!,value=step.state==='succeeded'?options.read():undefined;
   if(value!==undefined)return value;
   if(step.state==='succeeded'&&options.requireDurableResult)throw new ExecutionFailure('permanent','memory_phase_output_missing');
   // The child owns its real retry budget. A replayable parent yields its slot
   // and budget while that child waits, including across host restarts.
   if(step.state==='waiting')throw retainFailureContext(new ExecutionFailure('waiting',step.error??'step_pending',Math.max(1,step.availableAt-this.now())),{causeStepId:step.id,causeCode:step.error??'step_pending',causeState:step.state});
   if(step.state==='stale')throw new ExecutionFailure('stale','input_changed');
   if(step.state==='cancelled')throw new ExecutionFailure('permanent','cancelled');
   if(step.state==='blocked')throw new ExecutionFailure('blocked',step.error??'step_blocked');
   if(step.state==='failed')throw retainFailureContext(new ExecutionFailure('permanent',step.error??'step_failed',options.requireDurableResult?Math.max(0,step.availableAt-this.now()):undefined),{...failureContext(failure),causeStepId:step.id,causeCode:step.error??'step_failed',causeState:step.state});
   if(failure)throw failure;
   throw new ExecutionFailure('waiting','step_pending',Math.max(1000,step.availableAt-this.now()));
  }finally{options.signal.removeEventListener('abort',abort);await unregister();}
 }
 async close(){this.stopping=true;if(this.scheduled){clearImmediate(this.scheduled);this.scheduled=undefined;}for(const active of this.active.values())active.controller.abort(interrupted);await Promise.allSettled([...this.active.values()].map(a=>a.task));await Promise.allSettled([...this.programs.values()]);}
}
