import test from 'node:test';import assert from 'node:assert/strict';import {ConcurrencyGate} from '../src/concurrency.js';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {Store} from '../src/store.js';import {ExecutionEngine} from '../src/execution-engine.js';
test('a large operation cannot take every newly free slot ahead of a small operation',async()=>{
 const gate=new ConcurrencyGate(1),order:string[]=[],releases:(()=>void)[]=[];const work=(name:string,key:string)=>gate.run(async()=>{order.push(name);await new Promise<void>(r=>releases.push(r));},undefined,key);
 const first=work('bulk-1','bulk');await new Promise(r=>setImmediate(r));const rest=[work('bulk-2','bulk'),work('bulk-3','bulk'),work('small-1','small'),work('small-2','small')];
 for(let i=0;i<5;i++){releases.shift()!();await new Promise(r=>setImmediate(r));}
 await Promise.all([first,...rest]);assert.deepEqual(order,['bulk-1','small-1','bulk-2','small-2','bulk-3']);gate.close();
});
test('cancelled keyed waiters release bookkeeping and unkeyed calls retain FIFO order',async()=>{
 const gate=new ConcurrencyGate(1),order:number[]=[];let release!:()=>void;const first=gate.run(()=>new Promise<void>(r=>release=r));await new Promise(r=>setImmediate(r));const abort=new AbortController(),cancelled=gate.run(async()=>{throw Error('must not execute');},abort.signal,'cancelled');const rejected=assert.rejects(cancelled);abort.abort();
 const jobs=[1,2,3].map(i=>gate.run(async()=>{order.push(i);}));release();await Promise.all([first,rejected,...jobs]);assert.deepEqual(order,[1,2,3]);assert.equal(gate.snapshot().waiting,0);gate.close();
});

test('mixed work kinds refill a free pool slot while a slow step is still running',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-mixed-pools-')),store=new Store(dir),engine=new ExecutionEngine(store),started:string[]=[];
 let release!:()=>void;const held=new Promise<void>(r=>release=r);
 t.after(async()=>{release();await engine.close();store.close();rmSync(dir,{recursive:true,force:true});});
 for(const kind of ['ocr','memory','file','interactive'])engine.register({kind,pool:kind==='interactive'?'interactive':'background',concurrency:()=>2,validate:()=>true,execute:async step=>{started.push(step.kind+':'+step.operationId);if(step.input.slow)await held;return null;},commit:()=>{}});
 const slow=engine.enqueue('large','ocr',{slow:true}),other=engine.enqueue('large','memory',{}),small=engine.enqueue('small','file',{}),query=engine.enqueue('ask','interactive',{});
 const running=engine.tick();
 for(let i=0;i<50&&!['succeeded'].includes(engine.get(other)!.state);i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(engine.get(slow)!.state,'running');
 for(const id of [other,small,query])assert.equal(engine.get(id)!.state,'succeeded','unrelated work must complete without releasing the slow step');
 assert.ok(started.indexOf('file:small')<started.indexOf('memory:large'),'new small operation receives a slot before the large operation repeats');
 release();await running;await engine.drain([slow,other,small,query]);
});
