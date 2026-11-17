import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {ExecutionEngine,ExecutionFailure} from '../src/execution-engine.js';
import {retainFailureContext} from '../src/execution-failures.js';
import {ProviderFailure} from '@mote/shared';
import {EXECUTION_POLICIES} from '../src/execution-policy.js';

test('a safe failure receipt survives restart, excludes private prose and follows step deletion',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-safe-failure-')),store=new Store(directory);let engine=new ExecutionEngine(store);
 t.after(async()=>{await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
 engine.register({kind:'fixture',pool:'fixture',concurrency:()=>1,validate:()=>true,failureContext:()=>({workId:'generated-work',jobId:'generated-job',batchId:'generated-batch',phase:'review'}),execute:async()=>{const error=new ExecutionFailure('permanent','provider_failed');error.message='Generated private original and secret credential';throw retainFailureContext(error,{runId:'generated-run',phase:'contains private prose and cannot be a fixed phase'});},commit:()=>{}});
 const id=engine.enqueue('generated-operation','fixture',{private:'Generated personal input'});await engine.drain([id]);const receipt=engine.failure(id)!;assert.equal(engine.get(id)?.state,'failed');assert.equal(receipt.attempt,1);assert.equal(receipt.code,'provider_failed');assert.equal(receipt.workId,'generated-work');assert.equal(receipt.jobId,'generated-job');assert.equal(receipt.batchId,'generated-batch');assert.equal(receipt.runId,'generated-run');assert.equal(receipt.phase,'review');assert.doesNotMatch(JSON.stringify(receipt),/private|credential|personal input/);
 await engine.close();engine=new ExecutionEngine(store);assert.deepEqual(engine.failure(id),receipt);store.db.prepare('DELETE FROM execution_steps WHERE id=?').run(id);assert.equal(engine.failure(id),undefined);
});

test('failure receipt storage errors do not retry or block the failed execution',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-safe-failure-disk-')),store=new Store(directory),engine=new ExecutionEngine(store);t.after(async()=>{await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});let calls=0;
 store.db.exec("CREATE TRIGGER generated_failure_disk BEFORE INSERT ON execution_failures BEGIN SELECT RAISE(ABORT,'Generated unavailable receipt storage'); END;");
 engine.register({kind:'fixture',pool:'fixture',concurrency:()=>1,validate:()=>true,execute:async()=>{calls++;throw new ExecutionFailure('permanent','provider_failed');},commit:()=>{}});const id=engine.enqueue('generated-operation','fixture',{});await engine.drain([id]);assert.equal(engine.get(id)?.state,'failed');assert.equal(calls,1);assert.equal(engine.failure(id),undefined);assert.equal(engine.failureDiagnostics().writeFailures,1);
});

test('retired optional context still leaves the fixed execution failure receipt',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-safe-failure-retired-')),store=new Store(directory),engine=new ExecutionEngine(store);t.after(async()=>{await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
 engine.register({kind:'fixture',pool:'fixture',concurrency:()=>1,validate:()=>true,failureContext:()=>{throw Error('Generated retired payload');},execute:async()=>{throw new ExecutionFailure('permanent','provider_failed');},commit:()=>{}});const id=engine.enqueue('generated-operation','fixture',{});await engine.drain([id]);assert.equal(engine.failure(id)?.code,'provider_failed');assert.equal(engine.failure(id)?.operationId,'generated-operation');assert.equal(engine.failureDiagnostics().writeFailures,0);
});

test('a busy receipt persists only trusted execution facts and its actual durable retry time across restart',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-safe-busy-receipt-')),store=new Store(directory);let engine=new ExecutionEngine(store,()=>10000),now=10000;
 t.after(async()=>{await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
 engine.register({kind:'fixture',pool:'fixture',policy:EXECUTION_POLICIES.localProcessing,concurrency:()=>1,validate:()=>true,execute:async()=>{
  const failure=new ProviderFailure({category:'transient',code:'rate_limited',retryAfterMs:23000,executionStarted:false,admissionWaiting:true},'Generated private response and credential');
  Object.assign(failure,{headers:{authorization:'Generated secret bearer'},body:'Generated private original'});throw failure;
 },commit:()=>{}});
 const id=engine.enqueue('generated:busy','fixture',{});await engine.drain([id]);const receipt=engine.failure(id)!;
 assert.equal(receipt.executionStarted,false);assert.equal(receipt.admissionWaiting,true);assert.equal(receipt.availableAt,engine.get(id)!.availableAt);assert.equal(receipt.availableAt,now+23000);assert.equal(receipt.attempt,0);assert.equal(receipt.category,'waiting');
 assert.doesNotMatch(JSON.stringify(receipt),/response|credential|authorization|secret|body|original/);
 await engine.close();engine=new ExecutionEngine(store,()=>now);assert.deepEqual(engine.failure(id),receipt);
});

test('an arbitrary error cannot impersonate the trusted not-started or admission facts',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-safe-false-receipt-')),store=new Store(directory),engine=new ExecutionEngine(store);t.after(async()=>{await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
 engine.register({kind:'fixture',pool:'fixture',policy:EXECUTION_POLICIES.localProcessing,concurrency:()=>1,validate:()=>true,execute:async()=>{throw Object.assign(Error('Generated private evidence'),{details:{executionStarted:false,admissionWaiting:true},executionStarted:false,admissionWaiting:true});},commit:()=>{}});
 const id=engine.enqueue('generated:untrusted','fixture',{});await engine.drain([id]);const receipt=engine.failure(id)!;assert.equal(receipt.executionStarted,undefined);assert.equal(receipt.admissionWaiting,undefined);assert.equal(receipt.availableAt,undefined);assert.equal(receipt.category,'permanent');
});

test('an exhausted local retry retains its last fixed cause across restart without issuing a fourth call',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-exhausted-cause-')),store=new Store(directory);let now=10000,calls=0,engine=new ExecutionEngine(store,()=>now);
 t.after(async()=>{await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const handler={kind:'fixture',pool:'fixture',policy:EXECUTION_POLICIES.localProcessing,concurrency:()=>1,validate:()=>true,execute:async()=>{calls++;throw new ProviderFailure({category:'transient' as const,code:'provider_unavailable',executionStarted:false as const},'Generated private provider prose');},commit:()=>{}};
 engine.register(handler);const id=engine.enqueue('generated:exhausted','fixture',{});
 for(let cycle=0;cycle<3;cycle++){await engine.drain([id]);now+=5000;}
 assert.equal(engine.get(id)!.state,'failed');assert.equal(engine.get(id)!.error,'provider_unavailable');assert.equal(calls,3);
 engine.retry(id,false);await engine.close();engine=new ExecutionEngine(store,()=>now);engine.register(handler);
 for(let cycle=0;cycle<2;cycle++){
  await engine.drain([id]);const receipt=engine.failure(id)!;
  assert.equal(engine.get(id)!.error,'retry_budget_exhausted');assert.equal(receipt.causeCode,'provider_unavailable');
  assert.equal(receipt.attempt,3);assert.equal(calls,3);assert.doesNotMatch(JSON.stringify(receipt),/private|provider prose/);
  if(cycle===0)engine.retry(id,false);
 }
});

test('a seeded exhausted step reports an unavailable cause instead of inventing prior provider failures',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-exhausted-unknown-')),store=new Store(directory),engine=new ExecutionEngine(store);
 t.after(async()=>{await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});let calls=0;
 engine.register({kind:'fixture',pool:'fixture',policy:EXECUTION_POLICIES.localProcessing,concurrency:()=>1,validate:()=>true,execute:async()=>{calls++;},commit:()=>{}});
 const id=engine.enqueue('generated:unknown-cause','fixture',{}, {initial:{state:'waiting',attempts:3,availableAt:0}});await engine.drain([id]);
 assert.equal(engine.get(id)!.state,'failed');assert.equal(engine.failure(id)!.code,'retry_budget_exhausted');
 assert.equal(engine.failure(id)!.causeCode,'retry_cause_unavailable');assert.equal(calls,0);
});
