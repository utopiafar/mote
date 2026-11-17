import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {RunExecution} from '../src/run-execution.js';

const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
const deferred=<T=void>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};};

test('interactive execution starts an explicit processing budget after pool admission',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-task-budget-')),store=new Store(directory),engine=new ExecutionEngine(store),held=deferred(),entered=deferred(),outputs:string[]=[];
 const runs=new RunExecution(store,'insight',{project:()=>{},commit:(_id,value)=>outputs.push(String(value)),failure:()=>{}},{executor:engine,concurrency:()=>1});
 t.after(async()=>{held.resolve();await runs.stop();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
 t.mock.timers.enable({apis:['setTimeout']});
 runs.start('first',async()=>{entered.resolve();await held.promise;return 'first';});await entered.promise;
 runs.start('second',async()=> 'second',{timeoutMs:50});
 assert.equal(runs.step('second')!.state,'waiting');
 t.mock.timers.tick(1000);await turn();
 assert.equal(runs.step('second')!.state,'waiting','waiting for another task is not expired processing');
 assert.equal(runs.step('second')!.attempts,0);
 held.resolve();await runs.wait('first');await runs.wait('second');
 assert.equal(runs.step('second')!.state,'succeeded');assert.deepEqual(outputs,['first','second']);
});

test('a task-specific active execution timeout still fences an uncooperative late result',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-active-budget-')),store=new Store(directory),engine=new ExecutionEngine(store),entered=deferred(),late=deferred<string>(),outputs:string[]=[];
 const runs=new RunExecution(store,'insight',{project:()=>{},commit:(_id,value)=>outputs.push(String(value)),failure:()=>{}},{executor:engine});
 t.after(async()=>{late.resolve('late');await runs.stop();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
 t.mock.timers.enable({apis:['setTimeout']});
 runs.start('bounded',async()=>{entered.resolve();return late.promise;},{timeoutMs:50});await entered.promise;
 t.mock.timers.tick(51);await turn();await turn();
 assert.equal(runs.step('bounded')!.state,'failed');assert.equal(runs.step('bounded')!.error,'timeout');
 late.resolve('late');await runs.wait('bounded');await turn();assert.deepEqual(outputs,[]);
});
