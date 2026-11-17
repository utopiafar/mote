import test from 'node:test';
import assert from 'node:assert/strict';
import {createHook} from 'node:async_hooks';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderFailure} from '@mote/shared';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {ExecutionEngine,ExecutionFailure,type ExecutionHandler} from '../src/execution-engine.js';
import {EXECUTION_POLICIES} from '../src/execution-policy.js';

function fixture(t:any){
 const dir=mkdtempSync(join(tmpdir(),'mote-task-policy-')),store=new Store(dir);let now=10000,engine=new ExecutionEngine(store,()=>now);
 t.after(async()=>{await engine.close();store.close();rmSync(dir,{recursive:true,force:true});});
 return {store,get engine(){return engine;},advance:(ms:number)=>now+=ms,async restart(){await engine.close();engine=new ExecutionEngine(store,()=>now);}};
}
const base:ExecutionHandler={kind:'generated',pool:'generated',policy:EXECUTION_POLICIES.localProcessing,concurrency:()=>1,validate:()=>true,execute:async()=>null,commit:()=>{}};

test('repeated busy responses survive the historical four-attempt span and restart without failing the input',async t=>{
 const f=fixture(t);let busy=true,calls=0;
 const handler={...base,execute:async()=>{calls++;if(busy)throw new ProviderFailure({category:'transient',code:'rate_limited',retryAfterMs:2000,executionStarted:false});return null;}};
 f.engine.register(handler);const id=f.engine.enqueue('generated:audio','generated',{});
 for(let n=0;n<8;n++){
  await f.engine.drain([id]);assert.equal(f.engine.get(id)!.state,'waiting');assert.equal(f.engine.get(id)!.attempts,0);
  assert.equal(f.engine.failure(id)!.category,'waiting');assert.equal(f.store.db.prepare('SELECT recovery_deadline FROM execution_steps WHERE id=?').get(id)!.recovery_deadline,0);
  const prior=calls;await f.engine.drain([id]);assert.equal(calls,prior,'the persisted busy delay must prevent another request');f.advance(2000);
  if(n===3){await f.restart();f.engine.register(handler);}
 }
 assert.equal(calls,8);busy=false;await f.engine.drain([id]);assert.equal(f.engine.get(id)!.state,'succeeded');assert.equal(f.engine.get(id)!.attempts,1);
});

test('host cooldown for an unavailable provider waits without spending the actual-call budget',async t=>{
 const f=fixture(t);f.engine.register({...base,execute:async()=>{throw new ProviderFailure({category:'transient',code:'provider_unavailable',retryAfterMs:60000,admissionWaiting:true,executionStarted:false});}});
 const id=f.engine.enqueue('generated:cooldown','generated',{});await f.engine.drain([id]);assert.equal(f.engine.get(id)!.attempts,0);assert.equal(f.engine.failure(id)!.category,'waiting');assert.equal(f.engine.get(id)!.availableAt,70000);
});

test('a capacity admission wait retires an old elapsed recovery deadline and revalidates cancellation and input',async t=>{
 const f=fixture(t);let available=false,current=true,calls=0;
 f.engine.register({...base,validate:()=>current,admit:()=>available?undefined:new ExecutionFailure('waiting','rate_limited',2000),execute:async()=>{calls++;}});
 const id=f.engine.enqueue('generated:old-deadline','generated',{});f.store.db.prepare('UPDATE execution_steps SET recovery_deadline=1 WHERE id=?').run(id);
 await f.engine.drain([id]);assert.equal(f.engine.get(id)!.attempts,0);f.advance(100*86400000);await f.restart();
 f.engine.register({...base,validate:()=>current,execute:async()=>{calls++;}});current=false;await f.engine.drain([id]);assert.equal(f.engine.get(id)!.state,'stale');assert.equal(calls,0);
 current=true;const cancelled=f.engine.enqueue('generated:cancelled','generated',{});f.engine.cancel(cancelled);available=true;await f.engine.drain([cancelled]);assert.equal(f.engine.get(cancelled)!.state,'cancelled');assert.equal(calls,0);
});

test('a parent yields while a child retries and never reopens a terminal child',async t=>{
 const f=fixture(t);let calls=0,value:string|undefined;
 const parent:ExecutionHandler={...base,kind:'parent',pool:'parent',policy:EXECUTION_POLICIES.orchestration,
  execute:async(_step,signal)=>f.engine.runStep({id:'generated-child',operationId:'generated:nested',kind:'generated-child',pool:'child',policy:EXECUTION_POLICIES.localProcessing,input:{},signal,validate:()=>true,
   execute:async()=>{calls++;throw new ProviderFailure({category:'transient',code:'provider_unavailable',retryAfterMs:1000,executionStarted:false});},commit:()=>{value='generated';},read:()=>value,project:()=>{}}),commit:()=>{}};
 f.engine.register(parent);const id=f.engine.enqueue('generated:nested','parent',{});
 for(let n=0;n<3;n++){await f.engine.drain([id]);if(n<2){assert.equal(f.engine.get(id)!.state,'waiting');assert.equal(f.engine.get(id)!.attempts,0);assert.equal(f.engine.get(id)!.availableAt,f.engine.get('generated-child')!.availableAt);assert.equal(f.engine.failure(id)!.causeStepId,'generated-child');assert.equal(f.engine.failure(id)!.causeCode,'provider_unavailable');assert.equal(f.engine.failure(id)!.availableAt,f.engine.failure('generated-child')!.availableAt);}f.advance(1000);}
 assert.equal(calls,3);assert.equal(f.engine.get('generated-child')!.state,'failed');assert.equal(f.engine.get('generated-child')!.attempts,3);assert.equal(f.engine.get(id)!.state,'failed');
 f.engine.retry(id);await f.engine.drain([id]);assert.equal(calls,3,'a parent retry cannot silently reopen a terminal child');assert.equal(f.engine.get(id)!.state,'failed');
});

test('an unclassified program error stops after one execution instead of becoming transient',async t=>{
 const f=fixture(t);let calls=0;f.engine.register({...base,execute:async()=>{calls++;throw Error('Generated internal failure');}});
 const id=f.engine.enqueue('generated:internal','generated',{});await f.engine.drain([id]);f.advance(100*86400000);await f.engine.drain([id]);assert.equal(calls,1);assert.equal(f.engine.get(id)!.state,'failed');assert.equal(f.engine.failure(id)!.category,'permanent');
});

test('a healed child prerequisite resumes while an unresolved unknown-call guard prevents another execution',async t=>{
 const f=fixture(t);let blocked=true,calls=0,value:string|undefined;
 f.engine.register({...base,kind:'parent',pool:'parent',policy:EXECUTION_POLICIES.orchestration,
  execute:async(_step,signal)=>f.engine.runStep({id:'guarded-child',operationId:'generated:guarded',kind:'guarded-child',pool:'child',policy:EXECUTION_POLICIES.localProcessing,input:{},signal,validate:()=>true,
   admit:()=>blocked?new ExecutionFailure('blocked','processor_response_unknown'):undefined,
   execute:async()=>{calls++;return 'generated';},commit:result=>{value=String(result);},read:()=>value,project:()=>{}}),commit:()=>{}});
 const id=f.engine.enqueue('generated:guarded','parent',{});await f.engine.drain([id]);assert.equal(f.engine.get(id)!.state,'blocked');assert.equal(calls,0);
 f.engine.retry(id);await f.engine.drain([id]);assert.equal(f.engine.get('guarded-child')!.state,'blocked');assert.equal(calls,0,'replaying a blocked child must recheck its unknown-call admission');
 blocked=false;f.engine.retry(id);await f.engine.drain([id]);assert.equal(calls,1);assert.equal(f.engine.get(id)!.state,'succeeded');assert.equal(f.engine.get('guarded-child')!.attempts,1);
});

test('safe temporary call failures retain their count across a long wait without a generic recovery deadline',async t=>{
 const f=fixture(t);let calls=0;const handler={...base,execute:async()=>{calls++;throw new ProviderFailure({category:'transient',code:'provider_unavailable',retryAfterMs:1000,executionStarted:false});}};
 f.engine.register(handler);const id=f.engine.enqueue('generated:long-recovery','generated',{});await f.engine.drain([id]);f.advance(100*86400000);await f.restart();f.engine.register(handler);await f.engine.drain([id]);
 assert.equal(calls,2);assert.equal(f.engine.get(id)!.state,'waiting');assert.equal(f.engine.get(id)!.attempts,2);assert.equal(f.store.db.prepare('SELECT recovery_deadline FROM execution_steps WHERE id=?').get(id)!.recovery_deadline,0);
});

test('an explicit zero retry delay for a real temporary failure retains its finite execution budget',async t=>{
 const f=fixture(t);let calls=0;f.engine.register({...base,execute:async()=>{calls++;throw new ProviderFailure({category:'transient',code:'provider_network',retryAfterMs:0});}});
 const id=f.engine.enqueue('generated:zero-delay','generated',{});await f.engine.drain([id]);assert.equal(calls,3);assert.equal(f.engine.get(id)!.state,'failed');assert.equal(f.engine.get(id)!.attempts,3);
});

test('orchestration null creates no task deadline while cancellation still fences an uncooperative result',async t=>{
 const f=fixture(t),timers:number[]=[];let entered!:()=>void,release!:()=>void,committed=false;
 const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
 const hook=createHook({init(_id,type,_parent,resource){if(type==='Timeout')timers.push((resource as {_idleTimeout:number})._idleTimeout);}});hook.enable();
 try{
  f.engine.register({...base,policy:EXECUTION_POLICIES.orchestration,execute:async()=>{entered();await held;},commit:()=>{committed=true;}});
  const id=f.engine.enqueue('generated:long','generated',{}),run=f.engine.drain([id]);await started;
  assert.deepEqual(timers,[10000],'the renewable lease remains independent of an absent task deadline');f.engine.cancel(id);await run;release();await new Promise(resolve=>setImmediate(resolve));assert.equal(committed,false);assert.equal(f.engine.get(id)!.state,'cancelled');
 }finally{hook.disable();release?.();}
});

test('an input-specific operation deadline starts after pool admission rather than while queued',async t=>{
 const f=fixture(t);let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
 f.engine.register({...base,timeoutMs:step=>step.input.hold?null:25,
  execute:async step=>{if(step.input.hold){entered();await held;}return null;}});
 const first=f.engine.enqueue('generated:held-slot','generated',{hold:true}),queued=f.engine.enqueue('generated:queued-budget','generated',{}),run=f.engine.drain([first,queued]);
 await started;await new Promise(resolve=>setTimeout(resolve,60));assert.equal(f.engine.get(queued)!.state,'waiting');assert.equal(f.engine.get(queued)!.attempts,0);
 release();await run;await f.engine.drain([queued]);assert.equal(f.engine.get(queued)!.state,'succeeded');assert.equal(f.engine.get(queued)!.attempts,1);
});


test('three failed executions persist through restart and prerequisite reopen; only owner reset renews them',async t=>{
 const f=fixture(t);let calls=0,fail=true;
 const handler={...base,execute:async()=>{calls++;if(fail)throw new ExecutionFailure('transient','provider_network',1000);return null;}};
 f.engine.register(handler);const id=f.engine.enqueue('generated-bounded-round','generated',{});
 await f.engine.drain([id]);assert.equal(calls,1);
 f.engine.retry(id);assert.equal(f.engine.get(id)!.attempts,1,'reopening cannot reset a failed-execution count');
 f.advance(1000);await f.restart();f.engine.register(handler);await f.engine.drain([id]);assert.equal(calls,2);
 f.advance(1000);await f.engine.drain([id]);assert.equal(calls,3);assert.equal(f.engine.get(id)!.state,'failed');
 f.advance(86400000);f.engine.retry(id);await f.engine.drain([id]);assert.equal(calls,3);assert.equal(f.engine.get(id)!.state,'failed');
 await f.restart();f.engine.register(handler);f.engine.retry(id);await f.engine.drain([id]);assert.equal(calls,3);
 fail=false;f.engine.retry(id,true);await f.engine.drain([id]);assert.equal(calls,4);assert.equal(f.engine.get(id)!.state,'succeeded');assert.equal(f.engine.get(id)!.attempts,1);
});
