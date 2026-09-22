import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';import {ExecutionEngine,ExecutionFailure} from '../src/execution-engine.js';
test('provider recovery window persists across retry/restart and does not consume a call after expiry',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-recovery-')),store=new Store(dir);let now=10000,calls=0;let engine=new ExecutionEngine(store,()=>now);
 const handler={kind:'fixture',pool:'fixture',concurrency:()=>1,maxAttempts:10,maxRecoveryWindowMs:5000,validate:()=>true,execute:async()=>{calls++;throw new ExecutionFailure('transient','provider_unavailable',2000);},commit:()=>{}};engine.register(handler);
 t.after(async()=>{await engine.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const id=engine.enqueue('fixture:one','fixture',{});await engine.drain([id]);assert.equal(engine.get(id)!.state,'waiting');now+=2000;await engine.drain([id]);assert.equal(calls,2);assert.equal(store.db.prepare('SELECT recovery_deadline deadline FROM execution_steps WHERE id=?').get(id)!.deadline,15000);
 await engine.close();now=15001;engine=new ExecutionEngine(store,()=>now);engine.register(handler);await engine.drain([id]);assert.equal(engine.get(id)!.error,'recovery_window_exhausted');assert.equal(calls,2);
 engine.retry(id);await engine.drain([id]);assert.equal(calls,3);assert.equal(engine.get(id)!.state,'waiting');
});
test('a Retry-After beyond the recovery window stops without sleeping or resending',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-long-retry-')),store=new Store(dir),engine=new ExecutionEngine(store,()=>10000);t.after(async()=>{await engine.close();store.close();rmSync(dir,{recursive:true,force:true});});
 engine.register({kind:'fixture',pool:'fixture',concurrency:()=>1,maxRecoveryWindowMs:1000,validate:()=>true,execute:async()=>{throw new ExecutionFailure('transient','rate_limited',2000);},commit:()=>{}});const id=engine.enqueue('fixture:two','fixture',{});await engine.drain([id]);assert.equal(engine.get(id)!.state,'failed');assert.equal(engine.get(id)!.error,'recovery_window_exhausted');assert.equal(engine.get(id)!.attempts,1);
});
