import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store} from '../src/store.js';import {ExecutionEngine} from '../src/execution-engine.js';import {readProcessorJson} from '../src/file-processors.js';
test('processor HTTP facts reach the durable executor; auth blocks, 429 waits and bad input stops',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-provider-failure-')),store=new Store(dir);let now=Date.now(),calls=0,cancelled=0;const engine=new ExecutionEngine(store,()=>now);
 t.after(async()=>{await engine.close();store.close();rmSync(dir,{recursive:true,force:true});});
 engine.register({kind:'fixture',pool:'fixture',concurrency:()=>1,validate:()=>true,execute:async step=>{calls++;if(step.input.status===200)return null;return readProcessorJson(new Response(new ReadableStream({cancel(){cancelled++;}}),{status:Number(step.input.status),headers:{'Retry-After':'12'}}));},commit:()=>{}});
 const auth=engine.enqueue('file:auth','fixture',{status:401});await engine.drain([auth]);assert.equal(engine.get(auth)!.state,'blocked');assert.equal(engine.get(auth)!.error,'provider_authentication');await engine.drain([auth]);assert.equal(calls,1);
 const rate=engine.enqueue('file:rate','fixture',{status:429});await engine.drain([rate]);assert.equal(engine.get(rate)!.state,'waiting');assert.equal(engine.get(rate)!.availableAt,now+12000);await engine.drain([rate]);assert.equal(calls,2);now+=12000;await engine.drain([rate]);assert.equal(engine.get(rate)!.attempts,2);
 const invalid=engine.enqueue('file:invalid','fixture',{status:413});await engine.drain([invalid]);assert.equal(engine.get(invalid)!.state,'failed');assert.equal(engine.get(invalid)!.attempts,1);assert.equal(cancelled,4);
 const independent=engine.enqueue('file:independent','fixture',{status:200});await engine.drain([independent]);assert.equal(engine.get(independent)!.state,'succeeded');
});
