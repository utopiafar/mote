import test from 'node:test';
import assert from 'node:assert/strict';
import {createHook} from 'node:async_hooks';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {Store} from '../src/store.js';
import {ExecutionEngine,ExecutionFailure} from '../src/execution-engine.js';

test('completed, failed and cancelled steps release their long host deadline timers',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-deadline-cleanup-')),store=new Store(directory),engine=new ExecutionEngine(store),deadline=2147483647;
 const pendingTimers=new Set<number>(),hook=createHook({init(id,type,_parent,resource){if(type==='Timeout'&&(resource as {_idleTimeout?:number})._idleTimeout===deadline)pendingTimers.add(id);},destroy(id){pendingTimers.delete(id);}});
 hook.enable();
 try{
  let started!:()=>void;const held=new Promise<void>(resolve=>started=resolve);
  engine.register({kind:'fixture.deadline',pool:'fixture.deadline',concurrency:()=>1,timeoutMs:deadline,validate:()=>true,
   execute:async step=>{if(step.input.fail)throw new ExecutionFailure('permanent','fixture_failure');if(step.input.hold){started();await new Promise(()=>{});}return null;},commit:()=>{}});
  for(let i=0;i<8;i++){const id=engine.enqueue('query:deadline-'+i,'fixture.deadline',{fail:i%2===1});await engine.drain([id]);assert.equal(engine.get(id)?.state,i%2?'failed':'succeeded');}
  const heldId=engine.enqueue('query:deadline-held','fixture.deadline',{hold:true}),drained=engine.drain([heldId]);await held;engine.cancel(heldId);await drained;assert.equal(engine.get(heldId)?.state,'cancelled');
  await yieldTurn();await yieldTurn();assert.equal(pendingTimers.size,0,'Finished work must not keep deadline timers for another 24 days');
 }finally{hook.disable();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});}
});

test('a host deadline still aborts an uncooperative processor with TimeoutError',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-deadline-expiry-')),store=new Store(directory),engine=new ExecutionEngine(store);let reason:unknown;
 try{
  engine.register({kind:'fixture.expiry',pool:'fixture.expiry',concurrency:()=>1,timeoutMs:15,validate:()=>true,execute:async()=>new Promise(()=>{}),commit:()=>assert.fail('Expired work cannot commit'),classify:error=>{reason=error;return new ExecutionFailure('permanent','fixture_timeout');}});
  const id=engine.enqueue('query:expiry','fixture.expiry',{}),keepAlive=setTimeout(()=>{},1000);try{await engine.drain([id]);}finally{clearTimeout(keepAlive);}
  assert.equal(engine.get(id)?.state,'failed');assert.equal((reason as Error).name,'TimeoutError');
 }finally{await engine.close();store.close();rmSync(directory,{recursive:true,force:true});}
});
