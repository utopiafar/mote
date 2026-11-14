import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {authorizeFixtureModels} from './fixtures/model-authorization.js';
import {seedSourceMemoryBacklog} from './fixtures/source-memory-backlog.js';

test('source-owned Memory drain and resumed claims observe state without repeatedly opening frozen job details',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-memory-background-state-'));
 const config:Config={dataDir:directory,token:'generated-memory-background-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:1024**3,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async()=>assert.fail('Queued metadata must not dispatch a model')}});
 t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
 await node.app.ready();await authorizeFixtureModels(node);
 const {ids}=await seedSourceMemoryBacklog(node,12),pipeline=node.memoryPipeline;
 const payload=node.store.db.prepare('SELECT sum(length(json)) bytes FROM memory_jobs').get()!.bytes;
 t.diagnostic(`12 source jobs retain ${Number(payload)} frozen job bytes plus their batches`);
 const detail=t.mock.method(pipeline,'get',pipeline.get.bind(pipeline));
 // Pause one durable request, let drain park it, then resume its existing claim.
 node.store.db.prepare("UPDATE memory_jobs SET json=json_set(json,'$.status','paused') WHERE id=?").run(ids[0]);
 node.store.db.prepare('UPDATE material_memory_requests SET ready_at=0').run();
 const run=t.mock.method(pipeline,'run',async()=>new Promise<never>(()=>{}));
 await node.sourcePipelines.drainMemory(pipeline,true);await yieldTurn();
 assert.equal(node.store.db.prepare('SELECT error FROM material_memory_requests WHERE job_id=?').get(ids[0])!.error,'memory_job_paused');
 node.store.db.prepare("UPDATE memory_jobs SET json=json_set(json,'$.status','queued') WHERE id=?").run(ids[0]);
 for(let index=0;index<4;index++){node.store.db.prepare('UPDATE material_memory_requests SET ready_at=0 WHERE error IS NULL').run();await node.sourcePipelines.drainMemory(pipeline,true);await yieldTurn();}
 assert.equal(node.store.db.prepare('SELECT error FROM material_memory_requests WHERE job_id=?').get(ids[0])!.error,null,'an explicitly resumed product rejoins its original request');
 assert.equal(new Set(run.mock.calls.map(call=>call.arguments[0])).size,12,'drain reaches every source-owned claim, including the resumed one');
 assert.equal(Number(node.store.db.prepare('SELECT count(*) n FROM memory_jobs').get()!.n),12,'resumption never creates a replacement job');
 assert.equal(detail.mock.callCount(),0,'periodic source drain/rejoin must not load frozen job details or queue positions');
});

test('Memory waiting for its existing semantic preparation keeps frozen batches unchanged across executor polls',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-memory-preparation-state-'));
 const config:Config={dataDir:directory,token:'generated-memory-preparation-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:1024**3,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let calls=0;
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async input=>{
  calls++;assert.ok(input.signal);input.signal.throwIfAborted();
  return new Promise((_resolve,reject)=>input.signal!.addEventListener('abort',()=>reject(input.signal!.reason),{once:true}));
 }}});
 t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
 await node.app.ready();await authorizeFixtureModels(node);await seedSourceMemoryBacklog(node,12);
 node.store.db.prepare('UPDATE material_memory_requests SET ready_at=0').run();
 await node.sourcePipelines.drainMemory(node.memoryPipeline,true);
 const waiting=()=>node.store.db.prepare("SELECT id FROM execution_steps WHERE kind='memory.batch' AND state='waiting' AND error='semantic_processing_pending'").all().map(row=>String(row.id));
 const deadline=Date.now()+10000;
 while(waiting().length<10&&Date.now()<deadline)await yieldTurn();
 assert.equal(waiting().length,10,'two admitted parents hold their generated model work while ten await already queued preparation');assert.ok(calls>0);
 const ids=waiting(),selected=new Set(ids),snapshot=()=>ids.map(id=>String(node.store.db.prepare('SELECT json FROM memory_batches WHERE id=?').get(id)!.json)),before=snapshot();
 const prepare=node.store.db.prepare.bind(node.store.db);let rewrites=0;
 const spy=t.mock.method(node.store.db,'prepare',(sql:string)=>{
  const statement=prepare(sql);
  if(sql==='UPDATE memory_batches SET json=? WHERE id=?'){
   const run=statement.run.bind(statement);statement.run=((...args:Parameters<typeof run>)=>{if(selected.has(String(args[1])))rewrites++;return run(...args);}) as typeof statement.run;
  }
  return statement;
 });
 for(let poll=0;poll<3;poll++){
  for(const id of ids)node.store.db.prepare('UPDATE execution_steps SET available_at=0,error=? WHERE id=?').run(poll===0?'interrupted':'semantic_processing_pending',id);
  void node.executor.tick();
  const end=Date.now()+10000;
  while(Date.now()<end&&ids.some(id=>Number(node.executor.get(id)?.availableAt)===0))await yieldTurn();
  assert.ok(ids.every(id=>node.executor.get(id)?.state==='waiting'&&Number(node.executor.get(id)?.availableAt)>Date.now()),'every due parent is observed and deferred against its existing child');
 }
 assert.equal(rewrites,0,'waiting for queued/running preparation must not repeatedly rewrite every frozen batch');assert.deepEqual(snapshot(),before);
 assert.equal(Number(node.store.db.prepare('SELECT count(*) n FROM processing_jobs').get()!.n),12,'polling never creates replacement preparation');
 spy.mock.restore();
 // The queued child's execution fence is intentionally from an older parent
 // attempt: durable input authority, rather than that lease, permits the wait.
 const batchId=ids[0],parent=node.store.db.prepare('SELECT job_id FROM memory_batches WHERE id=?').get(batchId)!;
 const child=node.store.db.prepare("SELECT id,json_extract(json,'$.parentGrant.fence') fence FROM processing_jobs WHERE json_extract(json,'$.parentGrant.stepId')=?").get(batchId)!;
 assert.ok(child.fence);assert.notEqual(child.fence,node.executor.get(batchId)?.fence);
 // A different input generation sharing the same parent ID must take the real
 // preparation/rejoin path instead of waiting forever behind an old child.
 node.store.db.prepare("UPDATE processing_jobs SET json=json_set(json,'$.config.generationContract',?) WHERE id=?").run('0'.repeat(64),child.id);
 node.store.db.prepare('UPDATE execution_steps SET available_at=0 WHERE id=?').run(batchId);void node.executor.tick();
 const repaired=()=>node.store.db.prepare("SELECT 1 FROM processing_jobs p JOIN memory_batches b ON b.id=? WHERE p.id=? AND json_extract(p.json,'$.config.generationContract')=json_extract(b.json,'$.generationContract')").get(batchId,child.id);
 const repairUntil=Date.now()+10000;while(!repaired()&&Date.now()<repairUntil)await yieldTurn();
 assert.ok(repaired(),'a previous-generation queued child cannot permanently park its current parent');
 assert.equal(Number(node.store.db.prepare('SELECT count(*) n FROM processing_jobs').get()!.n),12,'rejoin retains the exact original preparation identity');
 node.memoryPipeline.cancel(String(parent.job_id),{cause:'authority'});
 assert.equal(node.memoryPipeline.state(String(parent.job_id)).status,'cancelled');assert.equal(node.executor.isCurrentInputAuthority(batchId),false,'withdrawal revokes a waiting child even when its old execution fence remains persisted');
});
