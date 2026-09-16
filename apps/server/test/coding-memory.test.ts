import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline,type MemoryPipelineQuery} from '../src/memory-pipeline.js';
import {CodingMemoryQueue} from '../src/coding-memory-queue.js';
const empty={answer:'{"memories":[]}',citations:[],trace:[],runId:'fixture'};
const item=(id:string,session='s1',coding=true)=>({externalId:id,revision:'1',observedAt:'2026-09-15T01:00:00Z',kind:'message',layer:'snapshot',text:'Use a transaction; the rollback test passed.',document:coding?{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:session,projectKey:'project-a',eventId:id,role:'user',part:0,parts:1}}:undefined});
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),'mote-coding-memory-')),store=new Store(dir),sources=new SourceStore(store),memories=new MemoryStore(store);sources.register({id:'coding',name:'Generated coding',kind:'coding-agent',deviceId:'fixture',platform:'macos'});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,sources,memories};}
test('profiles isolate personal material and different coding sessions, zero results checkpoint and origin replay is idempotent',async t=>{
 const {store,sources,memories}=fixture(t),ids=[];for(const input of [item('a'),item('b','s2'),item('c','s1',false)])ids.push((await sources.upsert('coding',input)).id);
 const calls:MemoryPipelineQuery[]=[];const pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>true,query:async input=>{calls.push(input);return empty;}});
 const job=pipeline.create({evidenceIds:ids,originKey:'coding-fixture'});assert.equal(job.totalBatches,3);assert.equal((await pipeline.run(job.id)).status,'completed');assert.deepEqual(calls.map(c=>c.skill),['coding-memory','coding-memory','memory-extraction']);assert.equal(pipeline.create({evidenceIds:ids}).totalBatches,0);assert.equal(pipeline.create({evidenceIds:ids,originKey:'coding-fixture'}).id,job.id);await pipeline.close();
});
test('coding candidates require exact original quotes, typed applicability and host-owned scope references',async t=>{
 const {sources,memories}=fixture(t),ack=await sources.upsert('coding',item('a')),text=item('a').text;
 const claim={title:'Transaction boundary',statement:`Rollback was verified [${ack.id}]`,uncertainty:'Only the recorded test was checked',evidenceIds:[ack.id],evidence:[{id:ack.id,offset:0,quote:text}],coding:{kind:'pitfall',scope:'project',applicability:'When writes must commit together',validation:'tested'}};
 const result={...empty,answer:JSON.stringify({memories:[claim]}),citations:[{id:ack.id,capturedAt:'2026-09-15T01:00:00Z',appName:'Generated',excerpt:text}]};
 const saved=memories.extract(result,'fixture',{profile:'coding'}).items[0];assert.equal(saved.domain,'coding');assert.equal(saved.status,'proposed');assert.deepEqual(saved.scopeRefs,[{provider:'codex',sessionId:'s1',projectKey:'project-a'}]);
 assert.throws(()=>memories.extract({...result,answer:JSON.stringify({memories:[{...claim,coding:{...claim.coding,scope:'shared'}}]})},'fixture',{profile:'coding'}),/Only principles/);
 assert.throws(()=>memories.extract({...result,answer:JSON.stringify({memories:[{...claim,evidence:undefined}]})},'fixture',{profile:'coding'}),/require/);
});
test('a queued coding batch from an older profile cannot checkpoint the new extraction policy',async t=>{
 const {store,sources,memories}=fixture(t),ack=await sources.upsert('coding',item('a'));let calls=0;
 const pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>true,query:async()=>{calls++;return empty;}});
 const job=pipeline.create({evidenceIds:[ack.id]});
 const row=store.db.prepare('SELECT json FROM memory_batches WHERE job_id=?').get(job.id) as {json:string};
 const batch=JSON.parse(row.json);batch.chunks[0].profileVersion='coding-memory@0';
 store.db.prepare('UPDATE memory_batches SET json=? WHERE id=?').run(JSON.stringify(batch),batch.id);
 const failed=await pipeline.run(job.id);assert.equal(failed.status,'failed');assert.equal(failed.errorCode,'skill_changed');assert.equal(calls,0);
 const current=pipeline.create({evidenceIds:[ack.id]});assert.equal(current.totalBatches,1);assert.equal((await pipeline.run(current.id)).status,'completed');assert.equal(calls,1);await pipeline.close();
});
test('host addresses unique exact coding quotes only inside authorized ranges, without repairing supplied offsets',async t=>{
 const {sources,memories}=fixture(t),text='🌱 repeat; unique\\noutput; repeat';
 const ack=await sources.upsert('coding',{...item('quotes'),text});
 const claim={title:'Quoted lesson',statement:`A bounded observation [${ack.id}]`,uncertainty:'Fixture only',evidenceIds:[ack.id],coding:{kind:'pitfall',scope:'session',applicability:'This fixture',validation:'observed'}};
 const extract=(quote:string,offset?:number,ranges?:{id:string;offset:number;length:number}[])=>memories.extract({...empty,citations:[{id:ack.id,capturedAt:'2026-09-15T01:00:00Z',appName:'Fixture',excerpt:text}],answer:JSON.stringify({memories:[{...claim,evidence:[{id:ack.id,quote,offset}]}]})},'fixture',{profile:'coding',evidenceRanges:ranges});
 assert.equal(extract('unique\\noutput').items[0].evidence[0].offset,text.indexOf('unique'));
 assert.throws(()=>extract('repeat'),/unique authorized/);assert.throws(()=>extract('unique\\noutput',0),/unique authorized/);
 assert.throws(()=>extract('unique\noutput'),/unique authorized/);
 assert.throws(()=>extract('unique\\noutput',undefined,[{id:ack.id,offset:0,length:3}]),/unique authorized/);
 const at=text.lastIndexOf('repeat');assert.equal(extract('repeat',undefined,[{id:ack.id,offset:at,length:6}]).items[0].evidence[0].offset,at);
});
test('source ingest and memory inbox commit together, wait for model, survive replay and do not orphan earlier entries',async t=>{
 const {store,sources,memories}=fixture(t);let configured=false;const calls:MemoryPipelineQuery[]=[];
 const pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>configured,query:async input=>{calls.push(input);return empty;}}),queue=new CodingMemoryQueue(store,pipeline,()=>configured,0);
 const a=await sources.upsert('coding',item('a'),undefined,ack=>queue.stage(ack.id));await sources.upsert('coding',item('b','s2'),undefined,ack=>queue.stage(ack.id));assert.deepEqual(queue.drain(),[]);
 configured=true;const jobs=queue.drain(Date.now()+1);assert.equal(jobs.length,2);for(const id of jobs)await pipeline.run(id);assert.equal(calls.length,2);assert.ok(calls.some(c=>c.evidenceIds.includes(a.id)));
 await sources.upsert('coding',item('a'),undefined,ack=>queue.stage(ack.id));assert.deepEqual(queue.drain(Date.now()+1),[]);
 await assert.rejects(sources.upsert('coding',item('rollback'),undefined,ack=>{queue.stage(ack.id);throw Error('fixture rollback');}),/fixture rollback/);assert.equal(Number((store.db.prepare('SELECT COUNT(*) n FROM coding_memory_inbox').get() as any).n),0);queue.close();await pipeline.close();
});
