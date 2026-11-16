import {rejectSqliteWrites} from './fixtures/sqlite-writer.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderFailure} from '@mote/shared';
import {Store} from '../src/store.js';
import {ProcessorAdmission,PROCESSOR_BUSY_RECHECK_MS} from '../src/processor-admission.js';

test('worker busy is shared by stages and connections, persists restart and isolates independent workers',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-processor-admission-')),store=new Store(dir),other=new Store(dir);let now=10000,calls=0;
 t.after(()=>{other.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const first=new ProcessorAdmission(store,()=>now),second=new ProcessorAdmission(other,()=>now);
 const endpoint='http://127.0.0.1:19009/transcribe';
 await assert.rejects(first.run(endpoint,async()=>{calls++;throw new ProviderFailure({category:'transient',code:'rate_limited',executionStarted:false});}),e=>e instanceof ProviderFailure&&e.details.retryAfterMs===PROCESSOR_BUSY_RECHECK_MS);
 await assert.rejects(second.run('http://localhost:19009/diarize',async()=>{calls++;}),e=>e instanceof ProviderFailure&&e.details.executionStarted===false&&e.details.retryAfterMs===PROCESSOR_BUSY_RECHECK_MS);
 assert.equal(calls,1);
 assert.equal(await second.run('http://127.0.0.1:19010/transcribe',async()=>42),42);
 const saved=JSON.stringify(store.db.prepare('SELECT * FROM processor_cooldowns').all());assert.ok(!saved.includes(endpoint));assert.ok(!saved.includes('localhost'));
 now+=PROCESSOR_BUSY_RECHECK_MS;
 assert.equal(await new ProcessorAdmission(store,()=>now).run(endpoint,async()=>42),42);
});

test('a late success cannot erase shared busy, and longer concurrent Retry-After wins',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-processor-racing-')),store=new Store(dir),admission=new ProcessorAdmission(store,()=>10000);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 let release!:()=>void;const held=new Promise<void>(r=>release=r),endpoint='http://127.0.0.1:19009';
 const success=admission.run(endpoint,async()=>{await held;return 42;});
 let rejectLate!:(e:unknown)=>void;const late=admission.run(endpoint,()=>new Promise((_r,reject)=>rejectLate=reject));
 const observed=assert.rejects(late,e=>e instanceof ProviderFailure&&e.details.retryAfterMs===60000);
 await assert.rejects(admission.run(endpoint,async()=>{throw new ProviderFailure({category:'transient',code:'rate_limited',executionStarted:false,retryAfterMs:60000});}),ProviderFailure);
 rejectLate(new ProviderFailure({category:'transient',code:'rate_limited',executionStarted:false,retryAfterMs:1000}));await observed;
 release();assert.equal(await success,42);
 assert.throws(()=>admission.check(endpoint),e=>e instanceof ProviderFailure&&e.details.retryAfterMs===60000);
});

test('unknown responses and model/input failures do not manufacture a service-wide busy condition',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-processor-unknown-')),store=new Store(dir),admission=new ProcessorAdmission(store);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const endpoint='http://127.0.0.1:19009';
 for(const details of [{category:'transient',code:'rate_limited'},{category:'transient',code:'provider_timeout'},{category:'transient',code:'provider_unavailable',executionStarted:false},{category:'permanent',code:'unsupported_format'}] as const){
  await assert.rejects(admission.run(endpoint,async()=>{throw new ProviderFailure(details);}),ProviderFailure);
  assert.doesNotThrow(()=>admission.check(endpoint));
 }
 assert.equal(store.db.prepare('SELECT COUNT(*) n FROM processor_cooldowns').get()!.n,0);
});

test('processor cooldowns preserve transactional write failure and expiry accounting',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-processor-quota-')),options={},store=new Store(dir,options);let now=10000;
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const admission=new ProcessorAdmission(store,()=>now),endpoint='http://127.0.0.1:19009',scope=admission.resourceKey(endpoint),baseline=store.logicalBytes(),bytes=Buffer.byteLength(scope)+128;
 const busy=()=>admission.run(endpoint,async()=>{throw new ProviderFailure({category:'transient',code:'rate_limited',executionStarted:false});});
 const recover=rejectSqliteWrites(store,'processor_cooldowns');
 await assert.rejects(busy(),/Generated SQLite write failure/);assert.equal(store.logicalBytes(),baseline);assert.equal(store.db.prepare('SELECT count(*) n FROM processor_cooldowns').get()!.n,0);
 recover();await assert.rejects(busy(),ProviderFailure);assert.equal(store.logicalBytes()-baseline,bytes);
 const reopened=new Store(dir);assert.equal(reopened.logicalBytes(),store.logicalBytes());reopened.close();
 store.db.exec('BEGIN IMMEDIATE');store.db.prepare('DELETE FROM processor_cooldowns').run();assert.equal(store.logicalBytes(),baseline);store.db.exec('ROLLBACK');assert.equal(store.logicalBytes(),baseline+bytes);
 now+=PROCESSOR_BUSY_RECHECK_MS;store.db.prepare('DELETE FROM processor_cooldowns WHERE until<=?').run(now);assert.equal(store.logicalBytes(),baseline);
});
