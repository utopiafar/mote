import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {fixture} from './fixtures/scoped-actions.js';
import {waitForState} from './fixtures/scoped-query-accounts.js';
import {EXECUTION_POLICIES} from '../src/execution-policy.js';

test('the original queue overview can read only its own actual M05 pool occupancy without instance capacity or another owner work',async t=>{
 const f=await fixture(t);let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);t.after(()=>release());
 f.node.execution!.register({kind:'generated.queue',pool:'generated.queue',concurrency:()=>1,policy:EXECUTION_POLICIES.deterministic,parseInput:input=>z.object({label:z.string()}).strict().parse(input),execute:async run=>{if(run.task.input.label==='GENERATED_HOLD_A'){enter();await gate;}return null;}});
 const submit=(token:string,id:string,label:string)=>f.ok(token,'/api/tasks','POST',{operationId:id,kind:'generated.queue',input:{label}});
 try{await submit(f.a.token,'same-owned-operation','GENERATED_HOLD_A');await entered;await submit(f.b.token,'same-owned-operation','GENERATED_B_PRIVATE');await submit(f.a.token,'next-a-operation','GENERATED_NEXT_A');
 const a=await f.request(f.a.token,'/api/tasks/queues');assert.equal(a.statusCode,200,a.body);assert.deepEqual(a.json(),{scope:'account',pools:[{id:'generated.queue',running:1,waiting:1,blocked:0,failed:0,unresolvedExternal:0}]});assert.doesNotMatch(a.body,/GENERATED_B_PRIVATE|limit|userId|credential/);
 const b=await f.ok(f.b.token,'/api/tasks/queues');assert.deepEqual(b,{scope:'account',pools:[{id:'generated.queue',running:0,waiting:1,blocked:0,failed:0,unresolvedExternal:0}]});assert.deepEqual(await f.ok(f.admin.token,'/api/tasks/queues'),{scope:'account',pools:[]},'administrator status does not imply private task aggregation');
 assert.equal((await f.request(f.a.token,'/api/tasks/queues?userId='+f.b.userId)).statusCode,401);assert.equal((await f.request(undefined,'/api/tasks/queues')).statusCode,401);assert.equal((await f.ok(f.a.token,'/api/tasks')).items.length,2,'queue GET never admits or retries anything');
 }finally{release();}
});


test('queue external uncertainty is retained independently of current running occupancy',async t=>{
 const f=await fixture(t);f.node.execution!.register({kind:'generated.unsettled-queue',pool:'generated.unsettled',concurrency:()=>1,policy:EXECUTION_POLICIES.deterministic,parseInput:raw=>z.object({}).strict().parse(raw),execute:async run=>{run.external.begin('generated-issued-call');return null;}});
 const task=await f.ok(f.a.token,'/api/tasks','POST',{operationId:'generated-unsettled',kind:'generated.unsettled-queue',input:{}});await waitForState(()=>f.ok(f.a.token,'/api/tasks/'+task.id),(value:any)=>value.state==='blocked','issued call with no trustworthy outcome');
 assert.deepEqual(await f.ok(f.a.token,'/api/tasks/queues'),{scope:'account',pools:[{id:'generated.unsettled',running:0,waiting:0,blocked:1,failed:0,unresolvedExternal:1}]});assert.deepEqual(await f.ok(f.b.token,'/api/tasks/queues'),{scope:'account',pools:[]});
});
