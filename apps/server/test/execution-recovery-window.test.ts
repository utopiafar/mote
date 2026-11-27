import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {EvidenceStore as Store} from '../src/evidence-store.js';import {ExecutionEngine,ExecutionFailure} from '../src/execution-engine.js';
test('provider recovery window persists across retry/restart and does not consume a call after expiry',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-recovery-')),store=new Store(dir);let now=10000,calls=0,capacityWaiting=false;let engine=new ExecutionEngine(store,()=>now);
 const handler={kind:'fixture',pool:'fixture',concurrency:()=>1,maxAttempts:10,maxRecoveryWindowMs:5000,validate:()=>true,admit:()=>capacityWaiting?new ExecutionFailure('waiting','at_capacity',2000):undefined,execute:async()=>{calls++;throw new ExecutionFailure('transient','provider_unavailable',2000);},commit:()=>{}};engine.register(handler);
 t.after(async()=>{await engine.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const id=engine.enqueue('fixture:one','fixture',{});await engine.drain([id]);assert.equal(engine.get(id)!.state,'waiting');now+=2000;await engine.drain([id]);assert.equal(calls,2);assert.equal(store.db.prepare('SELECT recovery_deadline deadline FROM execution_steps WHERE id=?').get(id)!.deadline,15000);
 await engine.close();now=15001;engine=new ExecutionEngine(store,()=>now);engine.register(handler);await engine.tick();assert.equal(engine.get(id)!.error,'recovery_window_exhausted');assert.equal(calls,2);

 for(const waiting of [false,true]){
  capacityWaiting=waiting;
  // Let the scheduler yield after expiring overdue rows and before it scans the pool.
  let schedulerReads=0;
  const clock=t.mock.method(performance,'now',()=>schedulerReads++===0?0:51);
  const scanning=engine.tick();
  clock.mock.restore();
  assert.equal(schedulerReads,2);
  engine.retry(id,false);
  await scanning;
  await engine.drain([id]);assert.equal(calls,2);assert.equal(engine.get(id)!.error,'recovery_window_exhausted');assert.equal(store.db.prepare('SELECT recovery_deadline deadline FROM execution_steps WHERE id=?').get(id)!.deadline,15000);
 }
 capacityWaiting=false;
 engine.retry(id,true);await engine.drain([id]);assert.equal(calls,3);assert.equal(engine.get(id)!.state,'waiting');
});
test('a real failure Retry-After beyond an explicit recovery budget stops without resending',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-long-retry-')),store=new Store(dir),engine=new ExecutionEngine(store,()=>10000);t.after(async()=>{await engine.close();store.close();rmSync(dir,{recursive:true,force:true});});
 engine.register({kind:'fixture',pool:'fixture',concurrency:()=>1,maxAttempts:4,maxRecoveryWindowMs:1000,validate:()=>true,execute:async()=>{throw new ExecutionFailure('transient','provider_unavailable',2000);},commit:()=>{}});const id=engine.enqueue('fixture:two','fixture',{});await engine.drain([id]);assert.equal(engine.get(id)!.state,'failed');assert.equal(engine.get(id)!.error,'recovery_window_exhausted');assert.equal(engine.get(id)!.attempts,1);
});
