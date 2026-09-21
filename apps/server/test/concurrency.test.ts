import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConcurrencyGate} from '../src/concurrency.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('capacity updates admit FIFO waiters, cancellation releases queue and lowering never interrupts active work',async()=>{
 const gate=new ConcurrencyGate(1),started:number[]=[],release:(()=>void)[]=[];
 const work=(i:number,signal?:AbortSignal)=>gate.run(async()=>{started.push(i);await new Promise<void>(r=>release[i]=r);return i;},signal);
 const a=work(0),controller=new AbortController(),b=work(1,controller.signal),c=work(2);
 await tick();assert.deepEqual(gate.snapshot(),{active:1,waiting:2,limit:1});
 controller.abort();await assert.rejects(b,{name:'AbortError'});gate.configure(2);await tick();assert.deepEqual(started,[0,2]);
 gate.configure(1);const d=work(3);release[0]();await a;await tick();assert.deepEqual(started,[0,2]);
 release[2]();await c;await tick();assert.deepEqual(started,[0,2,3]);release[3]();await d;await tick();assert.equal(gate.snapshot().active,0);gate.close();await assert.rejects(gate.run(async()=>1));
});
test('rejected work releases a slot for the next task',async()=>{const gate=new ConcurrencyGate(1);const a=gate.run(async()=>{throw Error('fixture');}),b=gate.run(async()=>42);await assert.rejects(a);assert.equal(await b,42);gate.close();});
