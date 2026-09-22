import {randomUUID,createHash} from 'node:crypto';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {StoreError,type Store} from './store.js';
import {withExecutionCancellation} from './execution-cancellation.js';

export type ExecutionState='waiting'|'running'|'blocked'|'succeeded'|'failed'|'cancelled'|'stale';
export type ExecutionStep={id:string;operationId:string;kind:string;pool:string;input:Record<string,unknown>;state:ExecutionState;attempts:number;availableAt:number;error?:string};
export class ExecutionFailure extends Error {
 constructor(readonly category:'transient'|'permanent'|'blocked'|'stale'|'waiting',readonly code:string,readonly retryAfterMs?:number){super(code);}
}
export interface ExecutionHandler {
 kind:string;pool:string;concurrency:()=>number;
 validate:(step:ExecutionStep)=>boolean;
 admit?:(step:ExecutionStep)=>ExecutionFailure|undefined;
 execute:(step:ExecutionStep,signal:AbortSignal)=>Promise<unknown>;
 /** Host-only, synchronous commit runs in the engine's fenced transaction. */
 commit:(step:ExecutionStep,result:unknown)=>void;
 /** Compatibility views are projections, never used to claim a running step. */
 project?:(step:ExecutionStep)=>void;
 classify?:(error:unknown)=>ExecutionFailure;
 timeoutMs?:number|(()=>number);
 maxAttempts?:number;
}
type ProgramStep<T>={id:string;operationId:string;kind:string;pool:string;input:Record<string,unknown>;signal:AbortSignal;validate:()=>boolean;execute:(signal:AbortSignal)=>Promise<unknown>;commit:(result:unknown)=>void;read:()=>T|undefined;project:(step:ExecutionStep)=>void;cached?:boolean;initialAttempts?:number;timeoutMs?:number};
type Row={id:string;operation_id:string;kind:string;pool:string;input:string;state:ExecutionState;attempts:number;available_at:number;error:string|null;fence:string|null;lease_until:number};
const view=(row:Row):ExecutionStep=>({id:row.id,operationId:row.operation_id,kind:row.kind,pool:row.pool,input:JSON.parse(row.input),state:row.state,attempts:row.attempts,availableAt:row.available_at,...(row.error?{error:row.error}:{})});
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)])):value;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The host owns admission, retry, cancellation, leases and commit fences. */
export class ExecutionEngine {
 private programs=new Map<string,Promise<unknown>>();
 private handlers=new Map<string,ExecutionHandler>();
 private active=new Map<string,{controller:AbortController;task:Promise<void>;pool:string}>();
 private stopping=false;
 private pumping=false;
 private pumpAgain=false;
 constructor(readonly store:Store,private now=Date.now){
  store.db.exec(`CREATE TABLE IF NOT EXISTS execution_steps(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,kind TEXT NOT NULL,pool TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,fence TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS execution_dependencies(step_id TEXT NOT NULL REFERENCES execution_steps(id) ON DELETE CASCADE,dependency_id TEXT NOT NULL REFERENCES execution_steps(id),PRIMARY KEY(step_id,dependency_id));
   CREATE INDEX IF NOT EXISTS execution_dependents ON execution_dependencies(dependency_id,step_id);
   CREATE TABLE IF NOT EXISTS execution_operation_steps(operation_id TEXT NOT NULL,step_id TEXT NOT NULL REFERENCES execution_steps(id) ON DELETE CASCADE,PRIMARY KEY(operation_id,step_id));
   CREATE INDEX IF NOT EXISTS execution_ready ON execution_steps(pool,state,available_at,created_at);
   CREATE INDEX IF NOT EXISTS execution_operations ON execution_steps(operation_id,created_at);
   CREATE TABLE IF NOT EXISTS execution_sequence(pool TEXT PRIMARY KEY,next INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS execution_fairness(pool TEXT NOT NULL,operation_id TEXT NOT NULL,last_started INTEGER NOT NULL,PRIMARY KEY(pool,operation_id));`);
 }
 get closed(){return this.stopping;}
 register(handler:ExecutionHandler){if(this.handlers.has(handler.kind))throw Error('Duplicate execution handler');this.handlers.set(handler.kind,handler);return ()=>{this.handlers.delete(handler.kind);};}
 enqueue(operationId:string,kind:string,input:Record<string,unknown>,options:{id?:string;dependencies?:string[];initial?:{state:ExecutionState;attempts:number;availableAt:number;error?:string}}={}){
  const handler=this.handlers.get(kind);if(!handler)throw new StoreError('Execution handler unavailable',409);
  input=canonical(input) as Record<string,unknown>;
  const json=JSON.stringify(input);if(json.length>32768)throw new StoreError('Execution input exceeds metadata limit',413);
  const id=options.id??hash([operationId,kind,input]),now=this.now(),db=this.store.db;
  const own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
  try{
   const existing=db.prepare('SELECT 1 FROM execution_steps WHERE id=?').get(id);
   if(!existing){this.store.reserveMetadata(Buffer.byteLength(json)+1024);db.prepare("INSERT INTO execution_steps(id,operation_id,kind,pool,input,state,created_at,updated_at) VALUES(?,?,?,?,?,'waiting',?,?)").run(id,operationId,kind,handler.pool,json,now,now);}
   const step=this.get(id)!;if(step.kind!==kind||JSON.stringify(step.input)!==json)throw new StoreError('Execution identity conflict',409);
   if(options.initial&&!existing){const seed=options.initial;db.prepare('UPDATE execution_steps SET state=?,attempts=?,available_at=?,error=? WHERE id=?').run(seed.state==='running'?'waiting':seed.state,seed.attempts,seed.availableAt,seed.state==='running'?'interrupted':seed.error??null,id);}
   for(const dep of options.dependencies??[])db.prepare('INSERT OR IGNORE INTO execution_dependencies VALUES(?,?)').run(id,dep);
   db.prepare('INSERT OR IGNORE INTO execution_operation_steps VALUES(?,?)').run(operationId,id);handler.project?.(this.get(id)!);if(own)db.exec('COMMIT');return id;
  }catch(error){if(own)db.exec('ROLLBACK');throw error;}
 }
 get(id:string){const row=this.store.db.prepare('SELECT * FROM execution_steps WHERE id=?').get(id) as Row|undefined;return row?view(row):undefined;}
 list(args:{operationId?:string;kind?:string;state?:ExecutionState;cursor?:number;limit?:number}={}){
  const clauses:string[]=[],values:(string|number)[]=[];
  if(args.operationId){clauses.push('EXISTS(SELECT 1 FROM execution_operation_steps o WHERE o.step_id=execution_steps.id AND o.operation_id=?)');values.push(args.operationId);}
  for(const [key,column] of [['kind','kind'],['state','state']] as const)if(args[key]){clauses.push(column+'=?');values.push(args[key]!);}
  if(args.cursor!==undefined){clauses.push('rowid<?');values.push(args.cursor);}
  const limit=Math.max(1,Math.min(args.limit??50,100)),rows=this.store.db.prepare(`SELECT rowid,* FROM execution_steps ${clauses.length?'WHERE '+clauses.join(' AND '):''} ORDER BY rowid DESC LIMIT ?`).all(...values,limit+1) as (Row&{rowid:number})[];
  return {items:rows.slice(0,limit).map(view),nextCursor:rows.length>limit?rows[limit-1].rowid:null};
 }
 project(id:string){const step=this.get(id);if(step)this.handlers.get(step.kind)?.project?.(step);}
 cancel(id:string){
  const db=this.store.db;db.prepare("UPDATE execution_steps SET state='cancelled',fence=NULL,error='cancelled',updated_at=? WHERE id=? AND state!='succeeded'").run(this.now(),id);this.active.get(id)?.controller.abort();this.project(id);
 }
 cancelKind(kind:string){for(;;){const rows=this.store.db.prepare("SELECT id FROM execution_steps WHERE kind=? AND state NOT IN ('succeeded','cancelled','stale') LIMIT 500").all(kind);if(!rows.length)return;for(const row of rows)this.cancel(String(row.id));}}
 retry(id:string,resetAttempts=true){
  if(this.get(id)?.state==='running')throw new StoreError('Cancel the active step before retrying',409);
  this.active.get(id)?.controller.abort();this.store.db.prepare("UPDATE execution_steps SET state='waiting',attempts=CASE WHEN ? THEN 0 ELSE attempts END,available_at=0,lease_until=0,fence=NULL,error=NULL,updated_at=? WHERE id=? AND state!='running'").run(Number(resetAttempts),this.now(),id);this.project(id);
 }
 hasActive(kind:string){return [...this.active.keys()].some(id=>this.get(id)?.kind===kind);}
 async drain(ids:string[]){
  void this.tick().catch(()=>{});
  for(;;){const tasks=ids.flatMap(id=>{const task=this.active.get(id)?.task;return task?[task]:[];});if(!tasks.length)return;await Promise.all(tasks);void this.tick().catch(()=>{});}
 }
 private recover(){
  const db=this.store.db,now=this.now();
  for(const row of db.prepare("SELECT * FROM execution_steps WHERE state='running' AND lease_until<=?").all(now) as Row[]){
   const max=this.handlers.get(row.kind)?.maxAttempts??4;
   db.prepare("UPDATE execution_steps SET state=?,fence=NULL,error='interrupted',available_at=0,updated_at=? WHERE id=? AND state='running' AND lease_until<=?").run(row.attempts>=max?'failed':'waiting',now,row.id,now);this.project(row.id);
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
    const handlers=[...this.handlers.values()].filter(h=>h.pool===pool),limit=Math.max(1,Math.min(32,...handlers.map(h=>h.concurrency())));
    while([...this.active.values()].filter(a=>a.pool===pool).length<limit){
     if(Number(this.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE pool=? AND state='running' AND lease_until>?").get(pool,this.now())!.n)>=limit)break;
     const row=this.store.db.prepare(`SELECT e.* FROM execution_steps e LEFT JOIN execution_fairness f ON f.pool=e.pool AND f.operation_id=e.operation_id WHERE e.pool=? AND e.state='waiting' AND e.available_at<=? AND e.kind IN (SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM execution_dependencies d JOIN execution_steps parent ON parent.id=d.dependency_id WHERE d.step_id=e.id AND parent.state!='succeeded') ORDER BY coalesce(f.last_started,0),e.created_at,e.rowid LIMIT 1`).get(pool,this.now(),JSON.stringify(handlers.map(h=>h.kind))) as Row|undefined;
     if(!row)break;
     const handler=this.handlers.get(row.kind)!;if(!handler.validate(view(row))){this.store.db.prepare("UPDATE execution_steps SET state='stale',error='input_changed',updated_at=? WHERE id=? AND state='waiting'").run(this.now(),row.id);this.project(row.id);continue;}
     const controller=new AbortController();let completed=true;const task=this.execute(row,handler,controller).catch(error=>{completed=false;throw error;}).finally(()=>{this.active.delete(row.id);if(!this.stopping&&completed)queueMicrotask(()=>{void this.tick().catch(()=>{});});});
     this.active.set(row.id,{controller,task,pool});started.push(task);
    }
   }
  }finally{this.pumping=false;if(this.pumpAgain){this.pumpAgain=false;queueMicrotask(()=>{void this.tick().catch(()=>{});});}}
  return Promise.all(started).then(()=>{});
 }
 private async execute(row:Row,handler:ExecutionHandler,controller:AbortController){
  const db=this.store.db,now=this.now(),fence=randomUUID(),timeout=(typeof handler.timeoutMs==='function'?handler.timeoutMs():handler.timeoutMs)??120000;
  db.exec('BEGIN IMMEDIATE');
  try{
   const limit=Math.max(1,Math.min(32,...[...this.handlers.values()].filter(h=>h.pool===row.pool).map(h=>h.concurrency())));
   if(db.prepare("SELECT state FROM execution_steps WHERE id=?").get(row.id)?.state!=='waiting'){db.exec('COMMIT');return;}
   if(Number(db.prepare("SELECT count(*) n FROM execution_steps WHERE pool=? AND state='running' AND lease_until>?").get(row.pool,now)!.n)>=limit){db.exec('COMMIT');return;}
   if(!handler.validate(view(row))){db.prepare("UPDATE execution_steps SET state='stale',error='input_changed',updated_at=? WHERE id=? AND state='waiting'").run(now,row.id);this.project(row.id);db.exec('COMMIT');return;}
   const admission=handler.admit?.(view(row));
   if(admission){
    db.prepare("UPDATE execution_steps SET state=?,available_at=?,error=?,updated_at=? WHERE id=? AND state='waiting'").run(admission.category==='waiting'?'waiting':'blocked',admission.category==='waiting'?now+Math.max(1,admission.retryAfterMs??1000):0,admission.code,now,row.id);this.project(row.id);db.exec('COMMIT');return;
   }
   const claimed=db.prepare("UPDATE execution_steps SET state='running',attempts=attempts+1,fence=?,lease_until=?,error=NULL,updated_at=? WHERE id=? AND state='waiting'").run(fence,now+timeout+10000,now,row.id).changes;
   if(!claimed){db.exec('COMMIT');return;}
   const sequence=Number(db.prepare('INSERT INTO execution_sequence(pool,next) VALUES(?,1) ON CONFLICT(pool) DO UPDATE SET next=next+1 RETURNING next').get(row.pool)!.next);
   db.prepare('INSERT INTO execution_fairness(pool,operation_id,last_started) VALUES(?,?,?) ON CONFLICT(pool,operation_id) DO UPDATE SET last_started=excluded.last_started').run(row.pool,row.operation_id,sequence);
   this.project(row.id);db.exec('COMMIT');
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');db.prepare("UPDATE execution_steps SET state='blocked',error=?,updated_at=? WHERE id=? AND state='waiting'").run(error instanceof StoreError&&error.statusCode===507?'storage_full':'admission_failed',this.now(),row.id);this.project(row.id);return;}
  const step=this.get(row.id)!,signal=AbortSignal.any([controller.signal,AbortSignal.timeout(timeout)]);
  try{
   const result=await withExecutionCancellation(signal,()=>handler.execute(step,signal));
   signal.throwIfAborted();
   db.exec('BEGIN IMMEDIATE');
   try{
    if(db.prepare("SELECT fence FROM execution_steps WHERE id=? AND state='running'").get(row.id)?.fence!==fence){db.exec('ROLLBACK');return;}
    if(!handler.validate(step))throw new ExecutionFailure('stale','input_changed');
    handler.commit(step,result);
    db.prepare("UPDATE execution_steps SET state='succeeded',fence=NULL,error=NULL,updated_at=? WHERE id=? AND fence=?").run(this.now(),row.id,fence);this.project(row.id);db.exec('COMMIT');
   }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  }catch(error){
   const failure=error instanceof ExecutionFailure?error:handler.classify?.(error)??new ExecutionFailure('transient','processor_failed');
   const state:ExecutionState=this.stopping?'waiting':failure.category==='blocked'?'blocked':failure.category==='stale'?'stale':failure.category==='waiting'?'waiting':failure.category==='permanent'||step.attempts>=(handler.maxAttempts??4)?'failed':'waiting';
   db.prepare('UPDATE execution_steps SET state=?,error=?,available_at=?,fence=NULL,updated_at=? WHERE id=? AND fence=?').run(state,this.stopping?'interrupted':failure.code,this.stopping?0:this.now()+(failure.retryAfterMs??Math.min(3600000,1000*2**(step.attempts-1))),this.now(),row.id,fence);this.project(row.id);
  }
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
  const unregister=this.register({kind,pool:options.pool,concurrency:()=>1,validate:()=>options.validate(),timeoutMs:options.timeoutMs,
   execute:async(_step,signal)=>{try{return await options.execute(AbortSignal.any([signal,options.signal]));}catch(error){failure=error;throw error;}},
   commit:(_step,result)=>{try{options.commit(result);}catch(error){failure=error;throw error;}},project:options.project,
   // The program retries the failed step on replay; only it consumes a retry slot.
   classify:()=>new ExecutionFailure('permanent','step_failed'),
  });
  const abort=()=>this.cancel(options.id);options.signal.addEventListener('abort',abort,{once:true});
  try{
   this.enqueue(options.operationId,kind,options.input,{id:options.id,initial:{state:options.cached?'succeeded':'waiting',attempts:options.initialAttempts??0,availableAt:0}});
   const current=this.get(options.id)!;
   if(['failed','blocked','cancelled','stale'].includes(current.state)||current.state==='succeeded'&&options.read()===undefined)this.retry(options.id,false);
   await this.drain([options.id]);options.signal.throwIfAborted();
   const step=this.get(options.id)!,value=step.state==='succeeded'?options.read():undefined;
   if(value!==undefined)return value;
   if(failure)throw failure;
   if(step.state==='stale')throw new ExecutionFailure('stale','input_changed');
   if(step.state==='cancelled')throw new ExecutionFailure('permanent','cancelled');
   if(step.state==='blocked')throw new ExecutionFailure('blocked',step.error??'step_blocked');
   if(step.state==='failed')throw new ExecutionFailure('transient',step.error??'step_failed');
   throw new ExecutionFailure('waiting','step_pending',Math.max(1000,step.availableAt-this.now()));
  }finally{options.signal.removeEventListener('abort',abort);unregister();}
 }
 async close(){this.stopping=true;for(const active of this.active.values())active.controller.abort();await Promise.allSettled([...this.active.values()].map(a=>a.task));await Promise.allSettled([...this.programs.values()]);}
}
