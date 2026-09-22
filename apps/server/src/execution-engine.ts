import {randomUUID,createHash} from 'node:crypto';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {StoreError,type Store} from './store.js';
import {withExecutionCancellation} from './execution-cancellation.js';

export type ExecutionState='waiting'|'running'|'blocked'|'succeeded'|'failed'|'cancelled'|'stale';
export type ExecutionStep={id:string;operationId:string;kind:string;pool:string;input:Record<string,unknown>;state:ExecutionState;attempts:number;availableAt:number;error?:string};
export class ExecutionFailure extends Error {
 constructor(readonly category:'transient'|'permanent'|'blocked'|'stale',readonly code:string,readonly retryAfterMs?:number){super(code);}
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
 timeoutMs?:number;
 maxAttempts?:number;
}
type Row={id:string;operation_id:string;kind:string;pool:string;input:string;state:ExecutionState;attempts:number;available_at:number;error:string|null;fence:string|null;lease_until:number};
const view=(row:Row):ExecutionStep=>({id:row.id,operationId:row.operation_id,kind:row.kind,pool:row.pool,input:JSON.parse(row.input),state:row.state,attempts:row.attempts,availableAt:row.available_at,...(row.error?{error:row.error}:{})});
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)])):value;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The host owns admission, retry, cancellation, leases and commit fences. */
export class ExecutionEngine {
 private handlers=new Map<string,ExecutionHandler>();
 private active=new Map<string,{controller:AbortController;task:Promise<void>;pool:string}>();
 private stopping=false;
 private pumping=false;
 private pumpAgain=false;
 constructor(readonly store:Store,private now=Date.now){
  store.db.exec(`CREATE TABLE IF NOT EXISTS execution_steps(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,kind TEXT NOT NULL,pool TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,fence TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS execution_ready ON execution_steps(pool,state,available_at,created_at);
   CREATE INDEX IF NOT EXISTS execution_operations ON execution_steps(operation_id,created_at);
   CREATE TABLE IF NOT EXISTS execution_sequence(pool TEXT PRIMARY KEY,next INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS execution_fairness(pool TEXT NOT NULL,operation_id TEXT NOT NULL,last_started INTEGER NOT NULL,PRIMARY KEY(pool,operation_id));`);
 }
 get closed(){return this.stopping;}
 register(handler:ExecutionHandler){if(this.handlers.has(handler.kind))throw Error('Duplicate execution handler');this.handlers.set(handler.kind,handler);return ()=>{this.handlers.delete(handler.kind);};}
 enqueue(operationId:string,kind:string,input:Record<string,unknown>){
  const handler=this.handlers.get(kind);if(!handler)throw new StoreError('Execution handler unavailable',409);
  input=canonical(input) as Record<string,unknown>;
  const json=JSON.stringify(input);if(json.length>32768)throw new StoreError('Execution input exceeds metadata limit',413);
  const id=hash([operationId,kind,input]),now=this.now(),db=this.store.db;
  const own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
  try{
   if(!db.prepare('SELECT 1 FROM execution_steps WHERE id=?').get(id)){this.store.reserveMetadata(Buffer.byteLength(json)+1024);db.prepare("INSERT INTO execution_steps(id,operation_id,kind,pool,input,state,created_at,updated_at) VALUES(?,?,?,?,?,'waiting',?,?)").run(id,operationId,kind,handler.pool,json,now,now);}
   const step=this.get(id)!;handler.project?.(step);if(own)db.exec('COMMIT');return id;
  }catch(error){if(own)db.exec('ROLLBACK');throw error;}
 }
 get(id:string){const row=this.store.db.prepare('SELECT * FROM execution_steps WHERE id=?').get(id) as Row|undefined;return row?view(row):undefined;}
 list(args:{operationId?:string;kind?:string;state?:ExecutionState;cursor?:number;limit?:number}={}){
  const clauses:string[]=[],values:(string|number)[]=[];
  for(const [key,column] of [['operationId','operation_id'],['kind','kind'],['state','state']] as const)if(args[key]){clauses.push(column+'=?');values.push(args[key]!);}
  if(args.cursor!==undefined){clauses.push('rowid<?');values.push(args.cursor);}
  const limit=Math.max(1,Math.min(args.limit??50,100)),rows=this.store.db.prepare(`SELECT rowid,* FROM execution_steps ${clauses.length?'WHERE '+clauses.join(' AND '):''} ORDER BY rowid DESC LIMIT ?`).all(...values,limit+1) as (Row&{rowid:number})[];
  return {items:rows.slice(0,limit).map(view),nextCursor:rows.length>limit?rows[limit-1].rowid:null};
 }
 project(id:string){const step=this.get(id);if(step)this.handlers.get(step.kind)?.project?.(step);}
 cancel(id:string){
  const db=this.store.db;db.prepare("UPDATE execution_steps SET state='cancelled',fence=NULL,error='cancelled',updated_at=? WHERE id=? AND state!='succeeded'").run(this.now(),id);this.active.get(id)?.controller.abort();this.project(id);
 }
 cancelKind(kind:string){for(const row of this.store.db.prepare("SELECT id FROM execution_steps WHERE kind=? AND state NOT IN ('succeeded','cancelled','stale')").all(kind))this.cancel(String(row.id));}
 retry(id:string){
  if(this.get(id)?.state==='running')throw new StoreError('Cancel the active step before retrying',409);
  this.active.get(id)?.controller.abort();this.store.db.prepare("UPDATE execution_steps SET state='waiting',attempts=0,available_at=0,lease_until=0,fence=NULL,error=NULL,updated_at=? WHERE id=? AND state!='running'").run(this.now(),id);this.project(id);
 }
 hasActive(kind:string){return [...this.active.keys()].some(id=>this.get(id)?.kind===kind);}
 async drain(ids:string[]){
  void this.tick().catch(()=>{});
  for(;;){const tasks=ids.flatMap(id=>{const task=this.active.get(id)?.task;return task?[task]:[];});if(!tasks.length)return;await Promise.allSettled(tasks);void this.tick().catch(()=>{});}
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
   const pools=[...new Set([...this.handlers.values()].map(h=>h.pool))];
   for(const pool of pools){
    const handlers=[...this.handlers.values()].filter(h=>h.pool===pool),limit=Math.max(1,Math.min(32,...handlers.map(h=>h.concurrency())));
    while([...this.active.values()].filter(a=>a.pool===pool).length<limit){
     if(Number(this.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE pool=? AND state='running' AND lease_until>?").get(pool,this.now())!.n)>=limit)break;
     const row=this.store.db.prepare(`SELECT e.* FROM execution_steps e LEFT JOIN execution_fairness f ON f.pool=e.pool AND f.operation_id=e.operation_id WHERE e.pool=? AND e.state='waiting' AND e.available_at<=? AND e.kind IN (SELECT value FROM json_each(?)) ORDER BY coalesce(f.last_started,0),e.created_at,e.rowid LIMIT 1`).get(pool,this.now(),JSON.stringify(handlers.map(h=>h.kind))) as Row|undefined;
     if(!row)break;
     const handler=this.handlers.get(row.kind)!;if(!handler.validate(view(row))){this.store.db.prepare("UPDATE execution_steps SET state='stale',error='input_changed',updated_at=? WHERE id=? AND state='waiting'").run(this.now(),row.id);this.project(row.id);continue;}
     const admission=handler.admit?.(view(row));
     if(admission){this.store.db.prepare("UPDATE execution_steps SET state='blocked',error=?,updated_at=? WHERE id=? AND state='waiting'").run(admission.code,this.now(),row.id);this.project(row.id);continue;}
     const controller=new AbortController(),task=this.execute(row,handler,controller).finally(()=>{this.active.delete(row.id);if(!this.stopping)queueMicrotask(()=>{void this.tick().catch(()=>{});});});
     this.active.set(row.id,{controller,task,pool});started.push(task);
    }
   }
  }finally{this.pumping=false;if(this.pumpAgain){this.pumpAgain=false;queueMicrotask(()=>{void this.tick().catch(()=>{});});}}
  return Promise.all(started).then(()=>{});
 }
 private async execute(row:Row,handler:ExecutionHandler,controller:AbortController){
  const db=this.store.db,now=this.now(),fence=randomUUID(),timeout=handler.timeoutMs??120000;
  db.exec('BEGIN IMMEDIATE');
  try{
   const limit=Math.max(1,Math.min(32,...[...this.handlers.values()].filter(h=>h.pool===row.pool).map(h=>h.concurrency())));
   if(Number(db.prepare("SELECT count(*) n FROM execution_steps WHERE pool=? AND state='running' AND lease_until>?").get(row.pool,now)!.n)>=limit){db.exec('COMMIT');return;}
   const claimed=db.prepare("UPDATE execution_steps SET state='running',attempts=attempts+1,fence=?,lease_until=?,error=NULL,updated_at=? WHERE id=? AND state='waiting'").run(fence,now+timeout+10000,now,row.id).changes;
   if(!claimed){db.exec('COMMIT');return;}
   const sequence=Number(db.prepare('INSERT INTO execution_sequence(pool,next) VALUES(?,1) ON CONFLICT(pool) DO UPDATE SET next=next+1 RETURNING next').get(row.pool)!.next);
   db.prepare('INSERT INTO execution_fairness(pool,operation_id,last_started) VALUES(?,?,?) ON CONFLICT(pool,operation_id) DO UPDATE SET last_started=excluded.last_started').run(row.pool,row.operation_id,sequence);
   this.project(row.id);db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
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
   const state:ExecutionState=this.stopping?'waiting':failure.category==='blocked'?'blocked':failure.category==='stale'?'stale':failure.category==='permanent'||step.attempts>=(handler.maxAttempts??4)?'failed':'waiting';
   db.prepare('UPDATE execution_steps SET state=?,error=?,available_at=?,fence=NULL,updated_at=? WHERE id=? AND fence=?').run(state,this.stopping?'interrupted':failure.code,this.stopping?0:this.now()+(failure.retryAfterMs??Math.min(3600000,1000*2**(step.attempts-1))),this.now(),row.id,fence);this.project(row.id);
  }
  await yieldTurn();
 }
 async close(){this.stopping=true;for(const active of this.active.values())active.controller.abort();await Promise.allSettled([...this.active.values()].map(a=>a.task));}
}
