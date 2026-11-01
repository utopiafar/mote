import {fixtureMemoryResult,fixtureMemoryPipeline} from './fixtures/memory-result.js';
import {fixtureMemoryWorkResult} from './fixtures/memory-planning.js';
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {setImmediate as nextTurn,setTimeout as delay} from 'node:timers/promises';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {authorizeFixtureModels} from './fixtures/model-authorization.js';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {MemoryStore,MemoryOutputValidationError,memoryEvidenceFingerprint} from '../src/memory.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {MemoryPipeline,type MemoryPipelineQuery} from '../src/memory-pipeline.js';
import {AgentTimeoutError} from '@mote/agent';
import {ProviderFailure} from '@mote/shared';

function fixture(t:TestContext,beforeStoreClose?:()=>Promise<void>){
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-generated-')),store=new Store(directory),sources=new SourceStore(store),memories=new MemoryStore(store);
  sources.register({id:'generated',name:'Generated archive',kind:'custom',deviceId:'generated-device',platform:'import'});
  t.after(async()=>{try{await beforeStoreClose?.();}finally{store.close();rmSync(directory,{recursive:true,force:true});}});
  return {directory,store,sources,memories};
}
const item=(externalId='a',text='合成原文：我计划学习 TypeScript，尚未开始。',revision='1',observedAt='2026-09-15T01:00:00Z')=>({externalId,text,revision,observedAt,title:'Generated record',kind:'file',layer:'original'});
const result=(id:string,quote?:{offset:number;quote:string})=>({answer:JSON.stringify({memories:[{title:'合成候选',statement:`尚未开始的计划 [${id}]`,uncertainty:'没有完成证据',evidenceIds:[id],...(quote?{evidence:[{id,...quote}]}:{})}]}),citations:[{id,capturedAt:'2026-09-15T01:00:00Z',appName:'Generated',excerpt:'合成'}],trace:[],runId:'generated-run'});
const empty=()=>({answer:'{"memories":[]}',citations:[],trace:[],runId:'generated-empty'});
test('unchanged authorization-wait wakes do not rewrite jobs or reorder Activity',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-unchanged-wake-'));
 const config:Config={dataDir:directory,token:'generated-memory-wake-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,agentTraceEnabled:false,logLevel:'silent',contentEncryptionEnabled:true,dataKey:randomBytes(32).toString('hex')};
 let calls=0;
 const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async()=>({configured:true,close:async()=>{},query:async()=>{calls++;throw Error('Unauthorized originals must not reach the model');}})});
 t.after(async()=>{try{await node.app.close();}finally{rmSync(directory,{recursive:true,force:true});}});
 await node.app.ready();await authorizeFixtureModels(node,{sourceIds:['generated-approved'],dataKinds:['text']});
 node.sources.register({id:'generated-denied',name:'Generated denied source',kind:'custom',deviceId:'generated',platform:'import'});
 // Each original exceeds half the transport budget, so the real intake creates
 // 20 independent jobs rather than combining the generated members into one.
 for(let i=0;i<20;i++)await node.sources.upsert('generated-denied',item('wait-'+i,'Generated private original '+i+' x'.repeat(3200)));
 await node.materialOrganizer.tick();await node.sourcePipelines.tick();node.store.db.prepare('UPDATE material_memory_requests SET ready_at=0').run();
 assert.equal(await node.sourcePipelines.drainMemory(node.memoryPipeline,true,20),20);
 const jobs=node.memoryPipeline.list(30);assert.equal(jobs.length,20);
 const waiting=()=>node.store.db.prepare("SELECT state,error,attempts,available_at FROM execution_steps WHERE kind='memory.batch'").all();
 const deadline=Date.now()+10000;
 while(Date.now()<deadline){const steps=waiting();if(steps.length===20&&steps.every(step=>step.state==='waiting'&&step.error==='background_model_authorization_required'))break;await delay(20);}
 assert.equal(waiting().length,20);assert.ok(waiting().every(step=>step.state==='waiting'&&step.error==='background_model_authorization_required'&&step.attempts===0&&Number(step.available_at)>Date.now()));
 const flush=async()=>{await nextTurn();await node.executor.tick();await nextTurn();};
 await flush();
 const snapshot=()=>node.store.db.prepare('SELECT j.id,j.json,a.updated_at FROM memory_jobs j JOIN activity_memory_jobs a ON a.id=j.id ORDER BY j.id').all().map(row=>({...row}));
 const before=snapshot();assert.equal(before.length,20);assert.ok(before.every(row=>typeof JSON.parse(String(row.json)).private==='string'),'exercise encrypted work packages as well as logical job state');
 const updated:string[]=[],prepare=node.store.db.prepare.bind(node.store.db);
 const spy=t.mock.method(node.store.db,'prepare',(sql:string)=>{
  const statement=prepare(sql);
  if(sql==='UPDATE memory_jobs SET json=? WHERE id=?'){
   const run=statement.run.bind(statement);
   statement.run=((...args:unknown[])=>{updated.push(String(args[1]));return run(...args as Parameters<typeof run>);}) as typeof statement.run;
  }
  return statement;
 });
 for(let i=0;i<10;i++){node.memoryPipeline.wake();await flush();}
 t.diagnostic(`20 authorization-wait jobs, 10 unchanged wakes: ${updated.length} job UPDATEs`);
 assert.equal(updated.length,0,'unchanged wakes must not write any Memory job');assert.deepEqual(snapshot(),before);assert.equal(calls,0);
 const selected=jobs[0].id,completion=node.memoryPipeline.run(selected);
 node.memoryPipeline.cancel(selected);assert.equal((await completion).status,'cancelled');await flush();
 assert.deepEqual([...new Set(updated)],[selected],'cancellation must write only the selected job');
 const after=snapshot(),old=before.find(row=>row.id===selected)!,stopped=after.find(row=>row.id===selected)!;
 assert.equal(JSON.parse(String(stopped.json)).status,'cancelled');assert.equal(JSON.parse(String(stopped.json)).cancellationCause,'owner');
 assert.notEqual(JSON.parse(String(stopped.json)).updatedAt,JSON.parse(String(old.json)).updatedAt);assert.notEqual(stopped.updated_at,old.updated_at);
 assert.deepEqual(after.filter(row=>row.id!==selected),before.filter(row=>row.id!==selected));assert.equal(calls,0);assert.equal(node.memories.list().length,0);
 spy.mock.restore();
});

test('a second batch starting while one already runs still rewrites the job and advances Activity ordering',async t=>{
 const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item('derived-a','a'.repeat(600))),b=await sources.upsert('generated',item('derived-b','b'.repeat(600)));
 let slots=1;const releases:(()=>void)[]=[];
 const pipeline=fixtureMemoryPipeline({store,memories,batchCharacters:256,concurrency:()=>slots,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async()=>{if(releases.length>=2)return empty();await new Promise<void>(r=>releases.push(r));return empty();}}});t.after(()=>pipeline.close());
 const job=pipeline.create({evidenceIds:[a.id,b.id]}),done=pipeline.run(job.id);
 const storedStatus=()=>String(JSON.parse(String((store.db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(job.id) as {json:string}).json)).status);
 while(releases.length<1||storedStatus()!=='running')await nextTurn();
 assert.equal(pipeline.get(job.id).runningBatches,1,'the first batch occupies the only slot while the second waits');
 const snapshot=()=>store.db.prepare('SELECT j.json,a.updated_at FROM memory_jobs j JOIN activity_memory_jobs a ON a.id=j.id WHERE j.id=?').get(job.id) as {json:string;updated_at:string};
 const before=snapshot();assert.equal(JSON.parse(before.json).status,'running');
 const updated:string[]=[],prepare=store.db.prepare.bind(store.db);
 const spy=t.mock.method(store.db,'prepare',(sql:string)=>{
  const statement=prepare(sql);
  if(sql==='UPDATE memory_jobs SET json=? WHERE id=?'){
   const run=statement.run.bind(statement);
   statement.run=((...args:unknown[])=>{updated.push(String(args[0]));return run(...args as Parameters<typeof run>);}) as typeof statement.run;
  }
  return statement;
 });
 await delay(5);slots=2;pipeline.wake();
 while(releases.length<2)await nextTurn();
 for(let i=0;i<3;i++)await nextTurn();
 assert.equal(updated.length,1,'a pending->running batch with unchanged job aggregates must still write the job row once');
 const after=snapshot(),afterJson=JSON.parse(after.json);
 assert.notEqual(afterJson.updatedAt,JSON.parse(before.json).updatedAt);assert.notEqual(after.updated_at,before.updated_at);
 assert.equal(afterJson.runningBatches,2);assert.equal(pipeline.get(job.id).runningBatches,2);
 for(const release of releases)release();const finished=await done;assert.equal(finished.status,'completed');assert.equal(finished.completedBatches,finished.totalBatches);
 spy.mock.restore();
});

test('the first refresh of a job persisted without derived counters does not write or reorder it',async t=>{
 const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item('baseline-a','a'.repeat(600)));
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const pipeline=fixtureMemoryPipeline({store,memories,batchCharacters:256,concurrency:()=>1,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async()=>{await gate;return empty();}}});t.after(()=>pipeline.close());
 const job=pipeline.create({evidenceIds:[a.id]}),done=pipeline.run(job.id);
 const storedStatus=()=>String(JSON.parse(String((store.db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(job.id) as {json:string}).json)).status);
 while(storedStatus()!=='running')await nextTurn();
 const snapshot=()=>store.db.prepare('SELECT j.json,a.updated_at FROM memory_jobs j JOIN activity_memory_jobs a ON a.id=j.id WHERE j.id=?').get(job.id) as {json:string;updated_at:string};
 // Simulate a job row persisted before the derived counters existed; the first
 // refresh afterwards must not count as job activity.
 store.db.prepare("UPDATE memory_jobs SET json=json_remove(json,'$.runningBatches','$.pendingBatches') WHERE id=?").run(job.id);
 const before=snapshot();
 const updated:string[]=[],prepare=store.db.prepare.bind(store.db);
 const spy=t.mock.method(store.db,'prepare',(sql:string)=>{
  const statement=prepare(sql);
  if(sql==='UPDATE memory_jobs SET json=? WHERE id=?'){
   const run=statement.run.bind(statement);
   statement.run=((...args:unknown[])=>{updated.push(String(args[0]));return run(...args as Parameters<typeof run>);}) as typeof statement.run;
  }
  return statement;
 });
 for(let i=0;i<3;i++){pipeline.wake();await nextTurn();await nextTurn();}
 assert.equal(updated.length,0,'an unchanged first refresh must not write the job row');
 assert.deepEqual(snapshot(),before,'Activity ordering must not move on an unchanged refresh');
 release();const finished=await done;assert.equal(finished.status,'completed');
 spy.mock.restore();
});

test('a batch update rolled back with its transaction leaves no transition signal for an unchanged refresh',async t=>{
 const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item('rollback-a','a'.repeat(600)));
 let allowed=true;
 const pipeline=fixtureMemoryPipeline({store,memories,admission:{evidenceAllowedForMemory:()=>allowed},models:{model:()=> 'fixture',configured:()=>true},phases:{query:async()=>{throw new ProviderFailure({category:'permanent',code:'provider_timeout',retryAfterMs:0});}}});t.after(()=>pipeline.close());
 const job=pipeline.create({evidenceIds:[a.id]}),failed=await pipeline.run(job.id);
 assert.equal(failed.status,'failed');assert.equal(failed.failedBatches,1);
 // acceptRetry invalidates the failed batch inside its transaction; failing the job
 // write then rolls the batch update back while an in-memory signal would linger.
 allowed=false;
 const prepare=store.db.prepare.bind(store.db);let thrown=false;
 const spy=t.mock.method(store.db,'prepare',(sql:string)=>{
  const statement=prepare(sql);
  if(sql==='UPDATE memory_jobs SET json=? WHERE id=?'){
   const run=statement.run.bind(statement);
   statement.run=((...args:unknown[])=>{if(!thrown){thrown=true;throw new Error('generated write failure');}return run(...args as Parameters<typeof run>);}) as typeof statement.run;
  }
  return statement;
 });
 assert.throws(()=>pipeline.acceptRetry(job.id,true));
 spy.mock.restore();
 const batchStatus=()=>String(JSON.parse(String((store.db.prepare('SELECT json FROM memory_batches WHERE job_id=?').get(job.id) as {json:string}).json)).status);
 assert.equal(batchStatus(),'failed','the rollback must restore the persisted batch status');
 const snapshot=()=>store.db.prepare('SELECT j.json,a.updated_at FROM memory_jobs j JOIN activity_memory_jobs a ON a.id=j.id WHERE j.id=?').get(job.id) as {json:string;updated_at:string};
 const before=snapshot();
 const updated:string[]=[];
 const spy2=t.mock.method(store.db,'prepare',(sql:string)=>{
  const statement=prepare(sql);
  if(sql==='UPDATE memory_jobs SET json=? WHERE id=?'){
   const run=statement.run.bind(statement);
   statement.run=((...args:unknown[])=>{updated.push(String(args[0]));return run(...args as Parameters<typeof run>);}) as typeof statement.run;
  }
  return statement;
 });
 const settled=await pipeline.run(job.id);assert.equal(settled.status,'failed');
 assert.equal(updated.length,0,'an unchanged refresh after a rolled-back batch update must not write the job row');
 assert.deepEqual(snapshot(),before,'Activity ordering must not move after a rolled-back transition');
 spy2.mock.restore();
});

test('job summaries count distinct surviving batch memories without exposing their IDs',async t=>{
 const {store,sources,memories}=fixture(t),record=await sources.upsert('generated',item());
 const pipeline=fixtureMemoryPipeline({store,memories,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async()=>result(record.id)}});t.after(()=>pipeline.close());
 const completed=await pipeline.run(pipeline.create({evidenceIds:[record.id]}).id),id=completed.memoryIds[0];
 assert.ok(id);const summary=()=>pipeline.list().find(job=>job.id===completed.id)!;
 assert.deepEqual(summary().evidenceIds,[]);assert.deepEqual(summary().memoryIds,[]);
 assert.equal(summary().memoryCount,1);assert.equal(pipeline.get(completed.id).memoryCount,1);
 const row=store.db.prepare('SELECT json FROM memory_batches WHERE id=?').get(completed.batches[0].id)!,batch=JSON.parse(String(row.json));
 batch.memoryIds=[id,id,'00000000-0000-4000-8000-000000000000'];
 store.db.prepare('UPDATE memory_batches SET json=? WHERE id=?').run(JSON.stringify(batch),batch.id);
 assert.equal(summary().memoryCount,1,'duplicates and missing memories do not inflate the summary');
 assert.equal(summary().memoryCount,pipeline.get(completed.id).memoryIds.length);
 memories.delete(id);
 assert.equal(summary().memoryCount,0);assert.equal(pipeline.get(completed.id).memoryCount,0);
});
test('model deadlines remain typed and retryable without committing a checkpoint',async t=>{
 const {store,sources,memories}=fixture(t),record=await sources.upsert('generated',item());let calls=0;
 const pipeline=fixtureMemoryPipeline({store,memories,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async()=>{if(++calls===1)throw new AgentTimeoutError();return empty();}}});t.after(()=>pipeline.close());
 const job=pipeline.create({evidenceIds:[record.id]}),failed=await pipeline.run(job.id);
 assert.equal(failed.status,'failed');assert.equal(failed.batches[0].errorCode,'provider_timeout');assert.equal(store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
 await assert.rejects(pipeline.retry(job.id));await new Promise(resolve=>setTimeout(resolve,Math.max(0,failed.availableAt!-Date.now())+10));
 assert.equal((await pipeline.retry(job.id)).status,'completed');assert.equal(calls,2);
});
test('manual timeout retry keeps exact ranges across restart and concurrent retries share one job',async t=>{
 const {store,sources,memories}=fixture(t),ids:string[]=[],seen:string[]=[];
 for(let i=0;i<20;i++)ids.push((await sources.upsert('generated',item(String(i),'前缀🌱合成原文内容'))).id);
 const ranges=ids.map(id=>({id,offset:2,length:6}));let fail=true;
 const query=async(input:MemoryPipelineQuery)=>{assert.deepEqual(input.evidenceRanges,ranges);if(fail)throw new ProviderFailure({category:'permanent',code:'provider_timeout',retryAfterMs:0});seen.push(...input.evidenceIds);return empty();};
 let pipeline=fixtureMemoryPipeline({store,memories,models:{model:()=> 'fixture',configured:()=>true},phases:{query}});
 try{const job=pipeline.create({evidenceIds:ids,evidenceRanges:ranges});assert.equal((await pipeline.run(job.id)).failedBatches,1);await pipeline.close();pipeline=fixtureMemoryPipeline({store,memories,models:{model:()=> 'fixture',configured:()=>true},phases:{query}});fail=false;
 const [done,duplicate]=await Promise.all([pipeline.retry(job.id),pipeline.retry(job.id)]);assert.equal(done.status,'completed');assert.equal(done.totalBatches,1);assert.equal(duplicate.totalBatches,1);assert.deepEqual(new Set(seen),new Set(ids));assert.equal(seen.length,20);
 assert.equal((await pipeline.retry(job.id)).totalBatches,1);assert.equal(seen.length,20);
 }finally{await pipeline.close();}
});

test('late progress and validation from a failed attempt cannot overwrite its reclaimed exact batch',async t=>{
 const {store,sources,memories}=fixture(t),ids:string[]=[];for(let i=0;i<4;i++)ids.push((await sources.upsert('generated',item(String(i)))).id);
 let oldInput!:MemoryPipelineQuery,calls=0,release!:()=>void,entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
 const pipeline=fixtureMemoryPipeline({store,memories,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async input=>{if(++calls===1){oldInput=input;throw new ProviderFailure({category:'permanent',code:'provider_timeout',retryAfterMs:0});}if(calls===2){entered();await new Promise<void>(resolve=>release=resolve);}return empty();}}});
 try{const job=pipeline.create({evidenceIds:ids});await pipeline.run(job.id);const retry=pipeline.retry(job.id);await started;
 const before=store.db.prepare('SELECT json FROM memory_batches WHERE id=?').get(job.batches[0].id)!.json;
 oldInput.onProgress?.({stage:'model',message:'Generated late callback'});oldInput.onTrace?.({type:'generated.late'});
 assert.throws(()=>oldInput.validateOutput!(empty()));
 assert.equal(store.db.prepare('SELECT json FROM memory_batches WHERE id=?').get(job.batches[0].id)!.json,before);
 release();assert.equal((await retry).status,'completed');
 }finally{release?.();await pipeline.close();}
});

test('memory references preserve source versions, authored time and exact UTF-16 quotes',async t=>{
  const {store,sources,memories}=fixture(t),text='开头🌱\n合成原文：我计划学习 TypeScript，尚未开始。';
  const document={fileId:'generated-file',path:'diary/day.md',recordedAt:'2021-01-02T08:00:00+08:00',timeBasis:'recorded',contentRole:'authored',originalMetadata:{tags:['generated'],author:'fixture'}};
  const ack=await sources.upsert('generated',{...item('a',text),document}),offset=text.indexOf('我计划'),quote=text.slice(offset);
  const saved=memories.extract(fixtureMemoryResult(memories,result(ack.id,{offset,quote})),'fixture-model',{skillVersion:'test-v1'}).items[0];
  assert.equal(saved.skillVersion,'test-v1');assert.equal(saved.evidence![0].sourceId,'generated');assert.equal(saved.evidence![0].externalId,'a');assert.equal(saved.evidence![0].revision,'1');
  assert.equal(saved.evidence![0].recordedAt,document.recordedAt);assert.equal(saved.evidence![0].capturedAt,'2026-09-15T01:00:00.000Z');assert.equal(saved.evidence![0].fileId,'generated-file');
  assert.equal(saved.evidence![0].offset,offset);assert.equal(saved.evidence![0].quote,quote);
  assert.throws(()=>memories.extract(fixtureMemoryResult(memories,result(ack.id,{offset:offset+1,quote})),'fixture-model'),/quote does not match/);
  assert.throws(()=>memories.extract(fixtureMemoryResult(memories,result(ack.id,{offset,quote})),'fixture-model',{evidenceRanges:[{id:ack.id,offset:0,length:2}]}),/outside the supplied segment/);
  assert.equal(store.list({after:'2021-01-01T00:00:00Z',before:'2021-01-03T00:00:00Z'}).totalCount,1);
  assert.equal(store.list({after:'2026-09-01T00:00:00Z'}).totalCount,0);
  assert.equal(sources.listItems({after:'2021-01-01T00:00:00Z',before:'2021-01-03T00:00:00Z'}).items.length,1);
  assert.equal(memories.list({after:'2021-01-01T00:00:00Z',before:'2021-01-03T00:00:00Z'}).length,1);
  assert.deepEqual(sources.getItem('generated','a')?.document,document);
});

test('source revisions and privacy deletion affect only dependent memory cards',async t=>{
  const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item('a')),b=await sources.upsert('generated',item('b'));
  const ma=memories.extract(fixtureMemoryResult(memories,result(a.id)),'fixture').items[0],mb=memories.extract(fixtureMemoryResult(memories,result(b.id)),'fixture').items[0];memories.publish(mb.id);
  await sources.upsert('generated',item('a','更正后的合成原文','2','2026-09-15T02:00:00Z'));
  assert.equal(memories.get(ma.id).status,'stale');assert.equal(memories.get(mb.id).status,'published');
  store.delete(a.id);assert.throws(()=>memories.get(ma.id),{statusCode:404});assert.equal(memories.get(mb.id).status,'published');
  assert.throws(()=>memories.extract(fixtureMemoryResult(memories,result(a.id,{offset:0,quote:item().text})),'fixture'),{statusCode:409});
});

test('pipeline covers all long-text segments within a character budget, checkpoints zero results and replays imports idempotently',async t=>{
  const {store,sources,memories}=fixture(t),text='🌱'.repeat(430),a=await sources.upsert('generated',item('long',text)),b=await sources.upsert('generated',item('short','合成短文'));
  const calls:MemoryPipelineQuery[]=[];const pipeline=fixtureMemoryPipeline({store,memories,batchCharacters:257,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async input=>{calls.push(input);return empty();}}});
  t.after(()=>pipeline.close());
  const job=pipeline.create({evidenceIds:[a.id,b.id],importJobId:'generated-import'});
  assert.equal(pipeline.create({evidenceIds:[a.id,b.id],importJobId:'generated-import'}).id,job.id);
  const completed=await pipeline.run(job.id);assert.equal(completed.status,'completed');assert.equal(completed.completedBatches,completed.totalBatches);assert.deepEqual(completed.memoryIds,[]);
  const ranges=calls.flatMap(c=>c.evidenceRanges).filter(r=>r.id===a.id).sort((x,y)=>x.offset-y.offset);let end=0;
  for(const range of ranges){assert.equal(range.offset,end);end+=range.length;assert.equal(range.length%2,0);}
  assert.equal(end,text.length);assert.ok(calls.every(c=>c.skill==='memory-extraction'&&c.evidenceRanges.reduce((sum,r)=>sum+r.length,0)<=257));
  assert.ok(calls.some(c=>c.evidenceIds.includes(b.id)));
  const repeated=pipeline.create({evidenceIds:[a.id,b.id]});assert.equal(repeated.totalBatches,0);assert.equal(repeated.status,'completed');assert.equal(repeated.skippedChunks,ranges.length+1);
});

test('unconfigured models stay retryable, and retry reruns only failed batches',async t=>{
  const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item('long','文'.repeat(600)));
  let configured=false,failed=false;const calls:number[]=[];
  const pipeline=fixtureMemoryPipeline({store,memories,batchCharacters:256,models:{model:()=> 'fixture',configured:()=>configured},phases:{query:async input=>{const offset=input.evidenceRanges[0].offset;calls.push(offset);if(offset===256&&!failed){failed=true;throw new Error('generated transport failure');}return empty();}}});t.after(()=>pipeline.close());
  const job=pipeline.create({evidenceIds:[a.id]});assert.equal((await pipeline.run(job.id)).status,'waiting_for_model');assert.deepEqual(calls,[]);
  configured=true;const partial=await pipeline.retry(job.id);assert.equal(partial.status,'failed');assert.equal(partial.completedBatches,2);assert.equal(partial.failedBatches,1);
  const done=await pipeline.retry(job.id);assert.equal(done.status,'completed');assert.deepEqual(calls,[0,256,512,256]);
});

test('memory batches retain the selected profile through recovery and wait if it disappears',async t=>{
  const {store,sources,memories}=fixture(t),record=await sources.upsert('generated',item('long','文'.repeat(600)));
  let available=true;const calls:string[]=[];
  const options={store,memories,batchCharacters:256,models:{model:(id?:string)=>{assert.equal(id,'selected');if(!available)throw Error('deleted profile');return 'fixture';},configured:(id?:string)=>id==='selected'&&available},phases:{query:async(input:MemoryPipelineQuery)=>{calls.push(input.modelProfileId!);available=false;return empty();}}};
  let pipeline=fixtureMemoryPipeline(options);
  const job=pipeline.create({evidenceIds:[record.id],modelProfileId:'selected'});
  const paused=await pipeline.run(job.id);assert.equal(paused.status,'waiting_for_model');assert.equal(paused.completedBatches,1);assert.equal(paused.batches[1].status,'pending');
  await pipeline.close();pipeline=fixtureMemoryPipeline({...options,phases:{...options.phases,query:async(input)=>{calls.push(input.modelProfileId!);return empty();}}});t.after(()=>pipeline.close());
  assert.equal(pipeline.get(job.id).modelProfileId,'selected');assert.equal((await pipeline.retry(job.id)).status,'waiting_for_model');
  available=true;assert.equal((await pipeline.retry(job.id)).status,'completed');assert.deepEqual(calls,['selected','selected','selected']);
});

test('privacy deletion during a model run cannot resurrect memory or create a completed checkpoint',async t=>{
  const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item());
  let enter!:()=>void,finish!:(value:ReturnType<typeof result>)=>void;const entered=new Promise<void>(resolve=>enter=resolve);
  const pipeline=fixtureMemoryPipeline({store,memories,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async()=>{enter();return new Promise(resolve=>finish=resolve);}}});t.after(()=>pipeline.close());
  const job=pipeline.create({evidenceIds:[a.id]}),running=pipeline.run(job.id);await entered;store.delete(a.id);finish(result(a.id));
  const done=await running;assert.equal(done.status,'failed');assert.equal(done.batches[0].status,'invalidated');assert.equal(memories.list({includeStale:true}).length,0);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_checkpoints').get()!.n,0);
});

test('recovery retries interrupted batches and commits memory with its checkpoint atomically',async t=>{
  const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item());
  let pipeline=fixtureMemoryPipeline({store,memories,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async()=>result(a.id)}});
  assert.throws(()=>pipeline.create({evidenceIds:[a.id],timeZone:'generated/invalid-zone'}));
  const job=pipeline.create({evidenceIds:[a.id],timeZone:'Asia/Shanghai'});
  const batch=JSON.parse(String(store.db.prepare('SELECT json FROM memory_batches WHERE job_id=?').get(job.id)!.json));
  pipeline.engine.enqueue('memory:'+job.id,'memory.batch',{jobId:job.id,batchId:batch.id,evidenceIds:batch.resourceEvidenceIds??[...new Set(batch.chunks.map((chunk:{id:string})=>chunk.id))]},{id:batch.id});
  await pipeline.close();
  store.db.prepare("UPDATE memory_jobs SET json=json_set(json,'$.status','running') WHERE id=?").run(job.id);
  store.db.prepare("UPDATE memory_batches SET json=json_set(json,'$.status','running') WHERE job_id=?").run(job.id);
  store.db.prepare("UPDATE execution_steps SET state='running',lease_until=1,fence='generated-crashed-grant',recovery_deadline=0 WHERE id=?").run(batch.id);
  pipeline=fixtureMemoryPipeline({store,memories,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async input=>{assert.equal(input.timeZone,'Asia/Shanghai');return result(a.id);}}});t.after(()=>pipeline.close());
  assert.equal(pipeline.get(job.id).timeZone,'Asia/Shanghai');
  await pipeline.engine.tick();assert.equal(pipeline.get(job.id).status,'queued');assert.equal(pipeline.get(job.id).batches[0].status,'pending');assert.equal(pipeline.engine.get(batch.id)?.error,'awaiting_activation');
  const completed=await pipeline.run(job.id);assert.equal(completed.status,'completed');assert.equal(completed.memoryIds.length,1);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_checkpoints').get()!.n,1);
  assert.throws(()=>memories.extract(fixtureMemoryResult(memories,{...result(a.id),answer:JSON.stringify({memories:[{title:'另一候选',statement:`另一条陈述 [${a.id}]`,uncertainty:'生成测试',evidenceIds:[a.id]}]})}),'fixture',{onSaved:()=>{throw new Error('checkpoint transaction failed');}}),/checkpoint transaction failed/);
  assert.equal(memories.list().length,1);
});

test('new revisions are queued and completed old batches become visibly invalidated',async t=>{
  const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item());
  const pipeline=fixtureMemoryPipeline({store,memories,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async()=>empty()}});t.after(()=>pipeline.close());
  const job=pipeline.create({evidenceIds:[a.id]});await pipeline.run(job.id);
  const b=await sources.upsert('generated',item('a','新的合成版本','2','2026-09-15T02:00:00Z'));
  const invalid=pipeline.get(job.id);assert.equal(invalid.status,'failed');assert.equal(invalid.outcome,'input_invalidated');assert.equal(invalid.failedBatches,0);assert.equal(invalid.invalidatedBatches,1);assert.equal(invalid.execution?.status,'skipped');
  const summary=pipeline.page().items.find(row=>row.id===job.id)!;assert.equal(summary.outcome,invalid.outcome);assert.equal(summary.failedBatches,0);assert.equal(summary.invalidatedBatches,1);assert.equal(summary.execution?.status,'skipped');assert.equal(summary.errorCode,'evidence_changed');
  assert.equal(pipeline.create({evidenceIds:[b.id]}).totalBatches,1);
  assert.throws(()=>memories.extract(fixtureMemoryResult(memories,result(a.id)),'fixture',{expectedFingerprints:{[a.id]:memoryEvidenceFingerprint(store.evidence([a.id])[0])}}),{statusCode:409});
});

test('document metadata and source receipts survive roundtrip; throwing receipt callbacks roll back',async t=>{
  const {store,sources}=fixture(t),files=new ArchivedFileStore(store),attachment=files.put({name:'diagram.png',bytes:Buffer.from('generated attachment fixture'),mimeType:'application/x-fixture'}),document={recordedAt:'2019-02-01T10:00:00Z',timeBasis:'recorded',contentRole:'authored',attachments:[{id:attachment.id,name:'diagram.png'}],originalMetadata:{nested:{flags:[true,null,3]}}};
  let callbackId='';const a=await sources.upsert('generated',{...item(),document},undefined,ack=>{callbackId=ack.id;});assert.equal(callbackId,a.id);
  await assert.rejects(sources.upsert('generated',item('rollback'),undefined,()=>{throw new Error('generated receipt failure');}));assert.equal(sources.getItem('generated','rollback'),undefined);
  const restored=fixture(t);await restored.store.importArchive(store.exportArchive(1_000_000));assert.deepEqual(restored.sources.getItem('generated','a')?.document,document);
  await assert.rejects(sources.upsert('generated',{...item('invalid'),document:{originalMetadata:{text:'x'.repeat(32001)}}}));
});

test('invalid inner memory schema regenerates once with trusted feedback and unchanged evidence scope',async t=>{
  const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item());const calls:MemoryPipelineQuery[]=[];
  const untrusted='UNTRUSTED_BAD_OUTPUT_DO_NOT_REPLAY_AS_INSTRUCTIONS';
  const pipeline=fixtureMemoryPipeline({store,memories,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async input=>{
    calls.push(input);assert.equal(memories.list().length,0);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_checkpoints').get()!.n,0);
    if(calls.length===1)return {...result(a.id),answer:JSON.stringify({memories:[{title:'合成',statement:untrusted,evidenceIds:[a.id]}]})};
    assert.match(input.question,/Host validation rejected/);assert.match(input.question,/string uncertainty/);assert.ok(!input.question.includes(untrusted));return result(a.id);
  }}});t.after(()=>pipeline.close());
  const job=pipeline.create({evidenceIds:[a.id],timeZone:'Asia/Shanghai'}),done=await pipeline.run(job.id);
  assert.equal(done.status,'completed');assert.equal(done.batches[0].attempts,2);assert.equal(calls.length,2);assert.equal(done.memoryIds.length,1);
  for(const key of ['evidenceIds','evidenceRanges','skill','timeZone'] as const)assert.deepEqual(calls[1][key],calls[0][key]);
});

test('quote offset errors are model validation failures and repair keeps exact UTF-16 evidence bounds',async t=>{
  const {store,sources,memories}=fixture(t),text='🌱开头\n合成原文：我计划学习。',a=await sources.upsert('generated',item('quote',text));
  const offset=text.indexOf('我计划'),quote=text.slice(offset),calls:MemoryPipelineQuery[]=[];
  assert.throws(()=>memories.extract(fixtureMemoryResult(memories,result(a.id,{offset:offset+1,quote})),'fixture'),error=>error instanceof MemoryOutputValidationError&&error.code==='quote_offset_mismatch'&&error.statusCode===502);
  const pipeline=fixtureMemoryPipeline({store,memories,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async input=>{
    calls.push(input);if(calls.length===1)return result(a.id,{offset:offset+1,quote});assert.equal(memories.list().length,0);assert.match(input.question,/absolute UTF-16 offset/);return result(a.id,{offset,quote});
  }}});t.after(()=>pipeline.close());
  const done=await pipeline.run(pipeline.create({evidenceIds:[a.id]}).id);assert.equal(done.status,'completed');assert.equal(done.batches[0].attempts,2);assert.deepEqual(calls[1].evidenceRanges,calls[0].evidenceRanges);
  assert.equal(done.batches[0].validationFailures?.[0].code,'quote_offset_mismatch');assert.equal(done.batches[0].validationFailures?.[0].details?.spanIndex,0);
  const saved=memories.get(done.memoryIds[0]);assert.equal(saved.evidence![0].offset,offset);assert.equal(saved.evidence![0].quote,quote);
});

test('schema repair is bounded and final invalid output remains visible without partial memories',async t=>{
  const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item());let calls=0;
  const pipeline=fixtureMemoryPipeline({store,memories,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async()=>{calls++;return {...empty(),answer:'not valid inner JSON'};}}});t.after(()=>pipeline.close());
  const done=await pipeline.run(pipeline.create({evidenceIds:[a.id]}).id);assert.equal(done.status,'failed');assert.equal(done.errorCode,'invalid_model_output');assert.equal(done.batches[0].attempts,2);assert.equal(calls,2);assert.equal(memories.list().length,0);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_checkpoints').get()!.n,0);
});

test('source changes prevent a second model call even when the first inner output is malformed',async t=>{
  const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item());let calls=0;
  const pipeline=fixtureMemoryPipeline({store,memories,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async()=>{
    calls++;await sources.upsert('generated',item('a','已变更的合成资料','2','2026-09-15T02:00:00Z'));return {...empty(),answer:'malformed output'};
  }}});t.after(()=>pipeline.close());
  const done=await pipeline.run(pipeline.create({evidenceIds:[a.id]}).id);assert.equal(done.status,'failed');assert.equal(done.batches[0].status,'invalidated');assert.equal(done.batches[0].errorCode,'evidence_changed');assert.equal(done.batches[0].attempts,1);assert.equal(calls,1);assert.equal(memories.list().length,0);
});

test('quote diagnostics distinguish exact failure modes without retaining source or model text',async t=>{
  const {sources,memories}=fixture(t),text='🌱prefix\nrepeat repeat\nunique-secret-fixture',a=await sources.upsert('generated',item('quote-codes',text));
  const base=result(a.id),candidate=JSON.parse(base.answer).memories[0];
  const check=(span:Record<string,unknown>,code:string,ranges?:{id:string;offset:number;length:number}[])=>{
    assert.throws(()=>memories.extract(fixtureMemoryResult(memories,{...base,answer:JSON.stringify({memories:[{...candidate,evidence:[{id:a.id,...span}]}]})}),'fixture',{evidenceRanges:ranges}),error=>{
      assert.ok(error instanceof MemoryOutputValidationError);assert.equal(error.code,code);assert.equal(error.details.candidateIndex,0);assert.equal(error.details.spanIndex,0);
      assert.ok(!JSON.stringify(error.details).includes('unique-secret-fixture'));return true;
    });
    assert.equal(memories.list().length,0);
  };
  check({quote:'repeat',offset:0},'quote_offset_mismatch');
  check({quote:'repeat',length:2},'quote_length_mismatch');
  check({quote:'not-present'},'quote_not_found');
  check({quote:'not-present',offset:0},'quote_not_found');
  check({quote:'repeat'},'quote_ambiguous');
  check({quote:'unique-secret-fixture'},'quote_range',[{id:a.id,offset:0,length:8}]);
  check({quote:'repeat',id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},'quote_evidence_undeclared');
  const saved=memories.extract(fixtureMemoryResult(memories,{...base,answer:JSON.stringify({memories:[{...candidate,evidence:[{id:a.id,quote:'repeat'}]}]})}),'fixture',{evidenceRanges:[{id:a.id,offset:text.indexOf('repeat'),length:6}]}).items[0];
  assert.equal(saved.evidence![0].offset,text.indexOf('repeat'));
});

test('review quote failure persists run and attempt locations and emits an ordinary safe diagnostic',async t=>{
  const {directory,store,sources,memories}=fixture(t),a=await sources.upsert('generated',item('review-diagnostic','synthetic exact source'));
  const {ServerDiagnostics}=await import('../src/diagnostics.js');
  const diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),traceEnabled:false});await diagnostics.init();t.after(()=>diagnostics.close());
  const runId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const pipeline=fixtureMemoryPipeline({store,memories,models:{model:()=> 'fixture',configured:()=>true},phases:{
    query:async()=>{const draft=result(a.id,{offset:0,quote:'synthetic exact source'}),value=JSON.parse(draft.answer);value.memories[0].admission={layer:'memory',reason:'Explicit fixture instruction',scope:'Fixture only',attribution:'user'};return {...draft,answer:JSON.stringify(value)};},
    review:async()=>({...result(a.id,{offset:1,quote:'synthetic exact source'}),runId}),
    onValidationFailure:event=>diagnostics.record('agent.memory_validation_failed',{jobId:event.jobId,batchId:event.batchId,batchIndex:event.batchIndex,runId:event.runId,attempt:event.attempt,validationCode:event.code,validationPhase:event.phase,...event.details},'warn')}});t.after(()=>pipeline.close());
  const done=await pipeline.run(pipeline.create({evidenceIds:[a.id]}).id);
  assert.equal(done.status,'failed');assert.equal(done.errorCode,'invalid_model_output');
  assert.deepEqual(done.batches[0].validationFailures?.map(f=>[f.phase,f.code,f.attempt,f.runId]),[['review','quote_offset_mismatch',1,runId],['review','quote_offset_mismatch',2,runId]]);
  const persisted=JSON.parse(String(store.db.prepare('SELECT json FROM memory_batches WHERE id=?').get(done.batches[0].id)!.json));
  assert.equal(persisted.validationFailures[1].details.declaredOffset,1);
  await diagnostics.flush();const events=diagnostics.events().items;
  assert.equal(events.length,2);assert.equal(events[1].jobId,done.id);assert.equal(events[1].batchId,done.batches[0].id);assert.equal(events[1].validationCode,'quote_offset_mismatch');assert.equal(events[1].validationPhase,'review');assert.equal(events[1].candidateIndex,0);assert.equal(events[1].quoteLength,22);
  assert.ok(!JSON.stringify(events).includes('synthetic exact source'));assert.equal(memories.list().length,0);
});

test('independent memory batches overlap; same evidence is serialized and pause finishes only in-flight work',async t=>{
 const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item('parallel-a','a'.repeat(600))),b=await sources.upsert('generated',item('parallel-b','b'.repeat(300)));
 const running=new Set<string>(),releases:(()=>void)[]=[];let peak=0;
 const pipeline=fixtureMemoryPipeline({store,memories,batchCharacters:256,concurrency:()=>3,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async input=>{const id=input.evidenceIds[0];assert.ok(!running.has(id));running.add(id);peak=Math.max(peak,running.size);await new Promise<void>(r=>releases.push(r));running.delete(id);return empty();}}});t.after(()=>pipeline.close());
 const job=pipeline.create({evidenceIds:[a.id,b.id]}),done=pipeline.run(job.id);await new Promise(r=>setImmediate(r));assert.equal(peak,2);assert.equal(pipeline.get(job.id).runningBatches,2);
 assert.equal(pipeline.pause(job.id).status,'pausing');for(const release of releases.splice(0))release();const paused=await done;assert.equal(paused.status,'paused');assert.equal(paused.completedBatches,2);assert.ok(paused.pendingBatches!>0);
 pipeline.resume(job.id);await new Promise(r=>setImmediate(r));pipeline.cancel(job.id);for(const release of releases.splice(0))release();await pipeline.run(job.id);assert.equal(pipeline.get(job.id).status,'cancelled');
});

test('host quote feedback is delivered before query session closes and successful repair does not restart extraction',async t=>{
 const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item()),failures:unknown[]=[];let calls=0;
 const pipeline=fixtureMemoryPipeline({store,memories,models:{model:()=> 'fixture',configured:()=>true},phases:{onValidationFailure:e=>failures.push(e),query:async input=>{
   calls++;const bad=fixtureMemoryResult(memories,result(a.id,{offset:0,quote:'不存在的合成引文'})),issue=await input.validateOutput!(bad);assert.equal(issue?.code,'quote_not_found');assert.match(issue!.feedback,/quote/);assert.equal(memories.list({}).length,0);
   const fixed=empty();assert.equal(await input.validateOutput!(fixed),undefined);return fixed;
 }}});t.after(()=>pipeline.close());const job=await pipeline.run(pipeline.create({evidenceIds:[a.id]}).id);assert.equal(calls,1);assert.equal(job.status,'completed');assert.equal(job.batches[0].attempts,1);assert.equal(failures.length,1);
});

test('cancelling extraction or review fences late models and saves no memory or checkpoint',async t=>{
 for(const phase of ['extract','review'] as const){
  const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item('cancel-'+phase));
  let enter!:()=>void,release!:(value:ReturnType<typeof result>)=>void,signal:AbortSignal|undefined;
  const entered=new Promise<void>(r=>{enter=r;}),held=new Promise<ReturnType<typeof result>>(r=>{release=r;});
  const pipeline=new MemoryPipeline({store,memories,
   models:{model:()=> 'fixture',configured:()=>true},phases:{...(phase==='review'?{review:async()=>{enter();return held;}}:{}),
   query:async input=>{signal=input.signal;if(phase==='extract'){enter();return held;}const draft=result(a.id,{offset:0,quote:item().text}),value=JSON.parse(draft.answer);value.memories[0].admission={layer:'memory',reason:'Explicit fixture instruction',scope:'Fixture only',attribution:'user'};return fixtureMemoryWorkResult(input,{...draft,answer:JSON.stringify(value)});}}});
  const job=pipeline.create({evidenceIds:[a.id]}),running=pipeline.run(job.id);t.after(()=>pipeline.close());await Promise.race([entered,running.then(()=>assert.fail(phase+' completed without entering its selected callback'))]);
  pipeline.cancel(job.id);release(result(a.id));const done=await running;
  assert.equal(done.status,'cancelled');assert.equal(memories.list().length,0,phase+' saved a late candidate');
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
  assert.equal(signal?.aborted,true);await pipeline.close();
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_extraction_drafts').get()!.n,0);
 }
});

test('closing a memory pipeline releases an uncooperative model and restart can recover the batch',async t=>{
 const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item('uncooperative'));
 let enter!:()=>void,release!:(value:ReturnType<typeof result>)=>void;
 const entered=new Promise<void>(r=>{enter=r;}),held=new Promise<ReturnType<typeof result>>(r=>{release=r;});
 const pipeline=fixtureMemoryPipeline({store,memories,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async()=>{enter();return held;}}});
 const job=pipeline.create({evidenceIds:[a.id]}),running=pipeline.run(job.id);await entered;
 try{await Promise.race([pipeline.close(),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Shutdown waited on an uncooperative model')),1000);timer.unref();})]);}
 finally{release(result(a.id));}
 await running;await new Promise(r=>setImmediate(r));assert.equal(memories.list().length,0);
 const restarted=fixtureMemoryPipeline({store,memories,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async()=>result(a.id)}});t.after(()=>restarted.close());
 assert.equal((await restarted.run(job.id)).status,'completed');assert.equal(memories.list().length,1);
});


// Functional allowance includes 400-source preparation and 800 durable batches;
// it is not a product execution deadline.
test('400 generated days imported individually and in batches share one durable memory executor',{timeout:240000},async t=>{
 let engine:ExecutionEngine|undefined,pipeline:MemoryPipeline|undefined,work:Promise<void>|undefined;
 const {store,sources,memories}=fixture(t,async()=>{
  // The runner can cancel while the body is still awaiting work. Owners must
  // settle before the fixture's one Store teardown, including timeout paths.
  await engine?.close();await pipeline?.close();
  await work?.catch(error=>{if(!t.signal.aborted)throw error;});
 });
 work=(async()=>{
  const ids:string[]=[],inputs=Array.from({length:400},(_,i)=>item('engine-day-'+i,'Synthetic bounded source '+i+' '+'.'.repeat(256),'1',new Date(Date.UTC(2024,0,1+i)).toISOString()));
  for(const input of inputs.slice(0,200)){const record=await sources.upsert('generated',input);t.signal.throwIfAborted();ids.push(record.id);}
  for(let offset=200;offset<400;offset+=100){await sources.upsertBatch('generated',inputs.slice(offset,offset+100));t.signal.throwIfAborted();for(const input of inputs.slice(offset,offset+100))ids.push(sources.getItem('generated',input.externalId)!.captureId);}
  engine=new ExecutionEngine(store);const calls:string[]=[];let peak=0,active=0;
  pipeline=fixtureMemoryPipeline({executor:engine,store,memories,batchCharacters:256,concurrency:()=>3,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async input=>{calls.push(input.traceContext!.jobId!);active++;peak=Math.max(peak,active);await new Promise(r=>setImmediate(r));active--;return empty();}}});
  const a=pipeline.create({evidenceIds:ids.slice(0,200)}),b=pipeline.create({evidenceIds:ids.slice(200)});
  const completed=await Promise.all([pipeline.run(a.id),pipeline.run(b.id)]);t.signal.throwIfAborted();assert.ok(completed.every(job=>job.status==='completed'));
  assert.equal(calls.length,800);assert.equal(peak,3);assert.ok(calls.slice(0,6).includes(a.id)&&calls.slice(0,6).includes(b.id));
  assert.equal(store.db.prepare("SELECT count(*) n FROM execution_steps WHERE kind='memory.batch' AND state='succeeded'").get()!.n,800);
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,800);
  assert.equal(pipeline.create({evidenceIds:ids}).totalBatches,0);
 })();
 await work;
});

test('memory, checkpoint and engine success commit roll back together when the host commit fails',async t=>{
 const {store,sources,memories}=fixture(t),ack=await sources.upsert('generated',item('commit-rollback'));
 const pipeline=fixtureMemoryPipeline({store,memories,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async()=>result(ack.id)}});t.after(()=>pipeline.close());
 store.db.exec("CREATE TRIGGER generated_checkpoint_failure BEFORE INSERT ON memory_checkpoints BEGIN SELECT RAISE(ABORT,'generated checkpoint failure'); END");
 const job=pipeline.create({evidenceIds:[ack.id]}),failed=await pipeline.run(job.id);
 assert.equal(failed.status,'failed');assert.equal(memories.list().length,0);assert.equal(store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
 assert.equal(pipeline.engine.get(job.batches[0].id)!.state,'failed');assert.equal(failed.batches[0].memoryIds.length,0);
 store.db.exec('DROP TRIGGER generated_checkpoint_failure');assert.equal((await pipeline.retry(job.id)).status,'completed');assert.equal(memories.list().length,1);
});


test('shared engine cannot bypass explicit lifecycle activation after recovery',async t=>{
 const {store,sources,memories}=fixture(t),ack=await sources.upsert('generated',item('activation'));
 const options={store,memories,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async()=>empty()}};
 const initial=fixtureMemoryPipeline(options),job=initial.create({evidenceIds:[ack.id]});await initial.close();
 const engine=new ExecutionEngine(store),pipeline=fixtureMemoryPipeline({...options,executor:engine});
 const batchId=job.batches[0].id;
 assert.equal(pipeline.get(job.id).activationRequired,true);
 engine.enqueue('memory:'+job.id,'memory.batch',{jobId:job.id,batchId,evidenceIds:[ack.id]},{id:batchId});
 await engine.tick();assert.equal(engine.get(batchId)!.error,'awaiting_activation');assert.equal(engine.get(batchId)!.attempts,0);assert.equal(pipeline.get(job.id).completedBatches,0);
 const execution=pipeline.run(job.id);
 assert.equal(JSON.parse(String(store.db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(job.id)!.json)).activationRequired,false);
 assert.equal((await execution).status,'completed');await engine.close();await pipeline.close();
});

test('typed provider authentication failures remain actionable without hanging or saving checkpoints',async t=>{
 const {ProviderFailure}=await import('@mote/shared');const {store,sources,memories}=fixture(t);const capture=await sources.upsert('generated',item());let calls=0,repaired=false;
 const pipeline=fixtureMemoryPipeline({store,memories,models:{configured:()=>true,model:()=> 'fixture'},phases:{query:async()=>{calls++;if(!repaired)throw new ProviderFailure({category:'blocked',code:'provider_authentication'});return empty();}}});
 try{const job=pipeline.create({evidenceIds:[capture.id]}),blocked=await pipeline.run(job.id);assert.equal(blocked.status,'waiting_for_model');assert.equal(blocked.errorCode,'provider_authentication');assert.equal(calls,1);assert.equal(store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
 repaired=true;const complete=await pipeline.retry(job.id);assert.equal(complete.status,'completed');assert.equal(calls,2);
 }finally{await pipeline.close();}
});

test('memory keeps provider retry deadlines and refuses premature manual retry',async t=>{
 const {ProviderFailure}=await import('@mote/shared');const {store,sources,memories}=fixture(t),capture=await sources.upsert('generated',item());let calls=0;
 const pipeline=fixtureMemoryPipeline({store,memories,models:{configured:()=>true,model:()=> 'fixture'},phases:{query:async()=>{calls++;throw new ProviderFailure({category:'permanent',code:'rate_limited',retryAfterMs:12000});}}});
 try{const job=pipeline.create({evidenceIds:[capture.id]}),failed=await pipeline.run(job.id);assert.equal(failed.status,'failed');assert.equal(failed.errorCode,'rate_limited');assert.ok(failed.availableAt!>Date.now());assert.ok(failed.execution!.failure!.retryAfterMs!>0);await assert.rejects(pipeline.retry(job.id),error=>error instanceof ProviderFailure&&error.details.code==='rate_limited');assert.equal(calls,1);assert.equal(store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);}finally{await pipeline.close();}
});


test('Memory count migration separates invalidated batches without changing scheduling or replaying model work',async t=>{
 const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item());let calls=0;
 const options={store,memories,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async()=>{calls++;return empty();}}};
 let pipeline=fixtureMemoryPipeline(options);const job=pipeline.create({evidenceIds:[a.id]});await pipeline.run(job.id);
 await sources.upsert('generated',item('a','Generated changed evidence','2'));
 await pipeline.close();
 const batch=JSON.parse(String(store.db.prepare('SELECT json FROM memory_batches WHERE job_id=?').get(job.id)!.json));
 const clone={...batch,id:crypto.randomUUID(),index:1,status:'failed',errorCode:'memory_capacity_saturated',attempts:2};
 store.db.prepare('INSERT INTO memory_batches(id,job_id,idx,json) VALUES(?,?,?,?)').run(clone.id,job.id,1,JSON.stringify(clone));
 const batchRows=()=>store.db.prepare('SELECT id,json FROM memory_batches ORDER BY id').all().map(row=>({id:row.id,body:JSON.parse(String(row.json))}));
 const before=batchRows(),jobBefore=JSON.parse(String(store.db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(job.id)!.json));
 store.db.exec(`DROP TRIGGER batch_count_insert; DROP TRIGGER batch_count_delete; DROP TRIGGER batch_count_update;
  DROP TABLE memory_job_counts; CREATE TABLE memory_job_counts(job_id TEXT PRIMARY KEY,total INTEGER,completed INTEGER,failed INTEGER,running INTEGER,pending INTEGER,attempts INTEGER);
  DELETE FROM settings WHERE key='memory-job-counts-version';`);
 store.db.prepare('INSERT INTO memory_job_counts VALUES(?,2,0,2,0,0,3)').run(job.id);
 pipeline=fixtureMemoryPipeline(options);t.after(()=>pipeline.close());
 const mixed=pipeline.get(job.id),summary=pipeline.page().items.find(row=>row.id===job.id)!;
 assert.equal(mixed.status,'failed');assert.equal(mixed.outcome,'processing_failed');assert.equal(mixed.failedBatches,1);assert.equal(mixed.invalidatedBatches,1);assert.equal(mixed.errorCode,'memory_capacity_saturated');assert.equal(mixed.execution?.status,'failed');
 assert.equal(summary.failedBatches,1);assert.equal(summary.invalidatedBatches,1);assert.equal(summary.outcome,mixed.outcome);assert.equal(summary.execution?.status,'failed');assert.equal(summary.errorCode,mixed.errorCode);
 assert.deepEqual(batchRows(),before);assert.deepEqual(JSON.parse(String(store.db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(job.id)!.json)),jobBefore);assert.equal(calls,1);
 await pipeline.close();pipeline=fixtureMemoryPipeline(options);assert.equal(pipeline.get(job.id).invalidatedBatches,1);assert.equal(calls,1,'repeat restart does not replay');
 // Counters stay transactional for subsequent state transitions and deletion.
 store.db.exec('BEGIN');store.db.prepare("UPDATE memory_batches SET json=json_set(json,'$.status','completed') WHERE id=?").run(clone.id);store.db.exec('ROLLBACK');assert.equal(pipeline.get(job.id).failedBatches,1);
 store.db.prepare("UPDATE memory_batches SET json=json_set(json,'$.status','completed') WHERE id=?").run(clone.id);assert.equal(pipeline.get(job.id).failedBatches,0);assert.equal(pipeline.get(job.id).outcome,'input_invalidated');
 store.db.prepare('DELETE FROM memory_batches WHERE id=?').run(clone.id);assert.equal(pipeline.get(job.id).totalBatches,1);
 for(const status of ['paused','cancelled']){store.db.prepare("UPDATE memory_jobs SET json=json_set(json,'$.status',?) WHERE id=?").run(status,job.id);assert.equal(pipeline.get(job.id).status,status);assert.equal(pipeline.get(job.id).outcome,undefined);}
});
