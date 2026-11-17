import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {MemoryLifecycle} from '../src/memory-lifecycle.js';
import {MemoryAutomation} from '../src/memory-automation.js';
import {MemoryInputAuthorization,DEFAULT_MEMORY_INPUT_SCOPE} from '../src/memory-input-authorization.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {createMemoryControl} from '../src/memory-control.js';
import {seedMemoryControlBacklog} from './fixtures/memory-control-backlog.js';

test('Memory control counts real receipt claims separately from manual queued jobs and stop preserves the manual tail',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-control-')),store=new Store(directory),executor=new ExecutionEngine(store),automation=new MemoryAutomation(store);
 let automatic=true;
 const grants=new MemoryInputAuthorization(store,()=>automatic),sources=new SourceStore(store,undefined,grants),memories=new MemoryStore(store);
 const pipeline=new MemoryPipeline({store,memories,executor,models:{model:()=> 'generated',configured:()=>true},phases:{query:async()=>{throw Error('Control projections must not start models');}}}),lifecycle=new MemoryLifecycle(store,()=>true,Date.now,executor);
 t.after(async()=>{await lifecycle.close();await pipeline.close();await executor.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const control=createMemoryControl({store,pipeline,lifecycle,executor,publication:{pending:()=>0}});
 automation.onStop=control.stop;automation.onResume=control.resume;automation.counts=control.counts;
 sources.register({id:'generated',name:'Generated originals',kind:'custom',deviceId:'generated-device',platform:'import'});
 const receive=(id:string)=>sources.upsert('generated',{externalId:id,revision:'1',observedAt:'2026-09-15T01:00:00Z',text:'Generated original '+id,kind:'message',layer:'original'});
 await receive('unclaimed');const admitted=await receive('admitted');automatic=false;const historical=await receive('manual');automatic=true;
 const job=pipeline.create({evidenceIds:[admitted.id],automaticGrant:{sourceId:'generated',inputKey:admitted.id,scope:DEFAULT_MEMORY_INPUT_SCOPE}}),manual=pipeline.create({evidenceIds:[historical.id]});
 store.db.exec('BEGIN IMMEDIATE');assert.equal(grants.claim('generated',admitted.id,job.id),true);store.db.exec('COMMIT');
 assert.deepEqual(control.counts(),{queued:2,running:0,checkpointed:0,resultUnknown:0});
 assert.equal(control.pendingTail(),2,'the binding tail retains both durable jobs, not unclaimed receipt count');
 const stop={expectedRevision:automation.state().revision,operationId:randomUUID()};
 assert.equal(automation.command('stop',stop).state,'paused');
 assert.equal(pipeline.get(job.id).status,'cancelled');assert.equal(pipeline.get(job.id).cancellationCause,'authority');
 assert.equal(pipeline.get(manual.id).status,'queued','automatic stop must retain independent manual work');
 assert.deepEqual(control.counts(),{queued:0,running:0,checkpointed:0,resultUnknown:0});assert.equal(control.pendingTail(),1);
 const revision=automation.state().revision;automation.command('stop',stop);assert.equal(automation.state().revision,revision);assert.equal(pipeline.get(manual.id).status,'queued');
});

test('automatic lifecycle tail remains visible beside independent manual work and stop revokes only that tail',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-control-round-')),store=new Store(directory),executor=new ExecutionEngine(store),automation=new MemoryAutomation(store);
 new MemoryInputAuthorization(store,()=>automation.accepting());
 const lifecycle=new MemoryLifecycle(store,()=>true,Date.now,executor),seen:string[]=[];
 lifecycle.register({id:'extraction',version:'generated-round',stream:'evidence',async run(window){seen.push(...window.ids);}});
 lifecycle.configure({...lifecycle.settings(),drainWindows:2,extraction:{...lifecycle.settings().extraction,minChanges:1,maxItems:1}});
 t.after(async()=>{await lifecycle.close();await executor.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const control=createMemoryControl({store,pipeline:{cancel(){assert.fail('No pipeline job was created');}},lifecycle,executor,publication:{pending:()=>0}});
 automation.onStop=control.stop;automation.onResume=control.resume;automation.counts=control.counts;lifecycle.automaticAdmission=()=>automation.accepting();
 for(let index=0;index<3;index++)store.db.prepare("INSERT INTO changes(id,operation,changed_at) VALUES(?,'upsert',?)").run(randomUUID(),new Date().toISOString());
 await lifecycle.tick();assert.equal(seen.length,1);assert.equal(control.pendingTail(),1);assert.equal(control.counts().queued,1);
 const manual=lifecycle.request('extraction',[randomUUID()],'generated-manual');assert.equal(control.counts().queued,1,'manual work cannot hide the admitted automatic round');
 const before=String(store.db.prepare("SELECT json FROM memory_lifecycle_state WHERE id='extraction'").get()!.json);
 automation.onStop=()=>{control.stop();throw Error('Generated stop participant failure');};
 assert.throws(()=>automation.command('stop',{expectedRevision:automation.state().revision,operationId:randomUUID()}),/Generated stop participant failure/);
 assert.equal(store.db.prepare("SELECT json FROM memory_lifecycle_state WHERE id='extraction'").get()!.json,before,'a failed command cannot revoke the persisted round');assert.equal(automation.accepting(),true);
 automation.onStop=control.stop;
 automation.command('stop',{expectedRevision:automation.state().revision,operationId:randomUUID()});
 assert.equal(control.counts().queued,0);assert.equal(control.pendingTail(),1,'manual work retains its independent authority');
 assert.equal(lifecycle.view().extensions[0].active!.id,manual);assert.equal(lifecycle.view().extensions[0].drainThrough,undefined);assert.notEqual(lifecycle.view().extensions[0].status,'cancelled');
});

test('automatic control stays readable with 540 persisted jobs and keeps partial, running and terminal counts current',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-control-backlog-')),store=new Store(directory),executor=new ExecutionEngine(store);
 const grants=new MemoryInputAuthorization(store,()=>true),sources=new SourceStore(store,undefined,grants),memories=new MemoryStore(store);
 const pipeline=new MemoryPipeline({store,memories,executor,models:{model:()=> 'generated',configured:()=>true},phases:{query:async()=>assert.fail('Reading automatic state must never call a model')}});
 const lifecycle=new MemoryLifecycle(store,()=>true,Date.now,executor);
 t.after(async()=>{await lifecycle.close();await pipeline.close();await executor.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const {ids}=await seedMemoryControlBacklog({store,sources,pipeline,grants});
 const control=createMemoryControl({store,pipeline,lifecycle,executor,publication:{pending:()=>0}});
 const began=performance.now();
 assert.deepEqual(control.counts(),{queued:540,running:0,checkpointed:0,resultUnknown:0});
 const elapsed=performance.now()-began;
 assert.ok(elapsed<1000,`Reading automatic state blocked the event loop for ${elapsed.toFixed(0)} ms with 540 jobs`);
 const status=(id:string,value:string)=>store.db.prepare("UPDATE memory_jobs SET json=json_set(json,'$.status',?) WHERE id=?").run(value,id);
 const batchStatus=(id:string,value:string)=>store.db.prepare("UPDATE memory_batches SET json=json_set(json,'$.status',?) WHERE job_id=?").run(value,id);
 status(ids[0],'running');
 batchStatus(ids[1],'running'); // Queued job with an admitted batch projects running.
 status(ids[2],'paused');store.db.prepare("UPDATE memory_batches SET json=json_set(json,'$.status','completed') WHERE id=(SELECT id FROM memory_batches WHERE job_id=? ORDER BY idx LIMIT 1)").run(ids[2]);
 status(ids[3],'completed');batchStatus(ids[3],'completed');
 status(ids[4],'cancelled');
 status(ids[5],'completed');batchStatus(ids[5],'invalidated'); // A revoked completed job is failed, not silently dropped.
 status(ids[7],'completed');batchStatus(ids[7],'completed');store.db.prepare("UPDATE memory_batches SET json=json_set(json,'$.status','failed') WHERE id=(SELECT id FROM memory_batches WHERE job_id=? ORDER BY idx LIMIT 1)").run(ids[7]);
 status(ids[8],'waiting_for_model');status(ids[9],'waiting_for_input');status(ids[10],'pausing');status(ids[11],'failed');
 store.db.prepare('UPDATE memory_input_authorizations SET revoked_at=1 WHERE job_id=?').run(ids[6]);
 // Multiple receipt claims for the same job count once.
 store.db.exec('BEGIN IMMEDIATE');grants.receive({sourceId:'generated',inputKey:'duplicate-claim',scope:DEFAULT_MEMORY_INPUT_SCOPE});assert.equal(grants.claim('generated','duplicate-claim',ids[0]),true);store.db.exec('COMMIT');
 assert.deepEqual(control.counts(),{queued:533,running:2,checkpointed:2,resultUnknown:0});
 store.db.exec('BEGIN IMMEDIATE');status(ids[0],'completed');batchStatus(ids[0],'completed');
 assert.deepEqual(control.counts(),{queued:533,running:1,checkpointed:2,resultUnknown:0});
 store.db.exec('ROLLBACK');
 assert.deepEqual(control.counts(),{queued:533,running:2,checkpointed:2,resultUnknown:0},'a rolled-back batch transition cannot change control counts');
 t.diagnostic(`540 jobs, 261 frozen ranges per job: automatic state ${elapsed.toFixed(0)} ms`);
});
