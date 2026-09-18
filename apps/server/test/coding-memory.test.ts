import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline,type MemoryPipelineQuery} from '../src/memory-pipeline.js';
import {MemoryLifecycle} from '../src/memory-lifecycle.js';
import {registerMemoryExtensions} from '../src/lifecycle-extensions.js';
import {FileStore} from '../src/files.js';
import {WorkingMemory} from '../src/working-memory.js';
import {Conversations} from '../src/conversations.js';
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
test('coding uploads share durable interval AND increment admission; legacy queued originals and replay remain safe',async t=>{
 const {store,sources,memories}=fixture(t);let configured=false,now=0;const calls:MemoryPipelineQuery[]=[];
 const pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>configured,query:async input=>{calls.push(input);assert.equal(input.responseMode,'memory-extraction');return empty;}});
 const a=await sources.upsert('coding',item('a'));
 store.db.exec('CREATE TABLE coding_memory_inbox(evidence_id TEXT PRIMARY KEY,group_key TEXT,ready_at INTEGER)');
 store.db.prepare('INSERT INTO coding_memory_inbox VALUES(?,?,?)').run(a.id,'legacy-session',0);
 const lifecycle=new MemoryLifecycle(store,()=>configured,()=>now),files=new FileStore(store,sources),working=new WorkingMemory(store,new Conversations(store));
 registerMemoryExtensions({lifecycle,store,files,memories,pipeline,working,model:()=> 'fixture',query:async()=>empty});
 const settings=lifecycle.settings();for(const key of ['consolidation','working','insights'] as const)settings[key].enabled=false;settings.extraction.minChanges=2;lifecycle.configure(settings);
 now=6*3600000;await lifecycle.tick();assert.equal(calls.length,0,'wait for model');configured=true;await lifecycle.tick();assert.equal(calls.length,0,'wait for increments');
 const before=store.db.prepare('SELECT count(*) n FROM changes').get()!.n;
 await assert.rejects(sources.upsert('coding',item('rollback'),undefined,()=>{throw Error('fixture rollback');}),/fixture rollback/);assert.equal(store.db.prepare('SELECT count(*) n FROM changes').get()!.n,before);
 await sources.upsert('coding',item('b','s2'));now=0;await lifecycle.tick();assert.equal(calls.length,0,'uploads do not bypass the interval');now=6*3600000;await lifecycle.tick();
 assert.equal(calls.length,2);assert.ok(calls.some(c=>c.evidenceIds.includes(a.id)));assert.ok(calls.every(c=>c.skill==='coding-memory'));
 await sources.upsert('coding',item('a'));now+=6*3600000;await lifecycle.tick();assert.equal(calls.length,2,'duplicate acknowledgements do not generate work');
 await lifecycle.close();await pipeline.close();
});

test('consolidation retains coding contracts and checkpoints each domain across a failed mixed window',async t=>{
 const {store,sources,memories}=fixture(t);let now=0,failCoding=true;const calls:string[]=[];
 const personal=(await sources.upsert('coding',item('personal','s1',false))).id,coding=(await sources.upsert('coding',item('coding'))).id;
 const result=(id:string,isCoding:boolean,consolidated=false)=>({...empty,answer:JSON.stringify({memories:[{admission:{layer:'memory',reason:'Reusable transaction invariant',scope:'Generated project',attribution:'user'},...(consolidated?{relatedMemoryIds:[originals.find(m=>m.evidenceIds.includes(id))!.id]}:{}),title:consolidated?'Consolidated':'Episode',statement:`${consolidated?'Consolidated':'Observed'} transaction [${id}]`,uncertainty:'Generated evidence only',evidenceIds:[id],evidence:[{id,offset:0,quote:item('a').text}],...(isCoding?{coding:{kind:'pitfall',scope:'project',applicability:'Atomic writes',validation:'tested'}}:{})}]}),citations:[{id,capturedAt:'2026-09-15T01:00:00Z',appName:'Generated',excerpt:item('a').text}]});
 const lifecycle=new MemoryLifecycle(store,()=>true,()=>now),pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>true,query:async()=>empty});
 const files=new FileStore(store,sources),working=new WorkingMemory(store,new Conversations(store));
 registerMemoryExtensions({lifecycle,store,files,memories,pipeline,working,model:()=> 'fixture',query:async input=>{assert.equal(input.responseMode,'memory-extraction');const isCoding=input.question.includes('host-selected coding');calls.push(isCoding?'coding':'personal');if(isCoding&&failCoding)throw Error('temporary fixture failure');return result(isCoding?coding:personal,isCoding,true);}});
 const settings=lifecycle.settings();for(const key of ['extraction','working','insights'] as const)settings[key].enabled=false;settings.consolidation.minChanges=2;lifecycle.configure(settings);
 const originals=[memories.extract(result(personal,false),'fixture').items[0],memories.extract(result(coding,true),'fixture',{profile:'coding'}).items[0]];
 now=24*3600000;await lifecycle.tick();assert.deepEqual(calls,['personal','personal','coding']);assert.equal(memories.page({tier:'consolidated'}).items.length,1);
 failCoding=false;now+=121000;await lifecycle.tick();assert.deepEqual(calls,['personal','personal','coding','coding','coding'],'completed personal generation is not repeated');
 const consolidated=memories.page({tier:'consolidated',level:'detail'}).items;assert.equal(consolidated.length,2);
 const code=consolidated.find(m=>m.domain==='coding')!;assert.equal(code.coding?.scope,'project');assert.deepEqual(code.scopeRefs,[{provider:'codex',sessionId:'s1',projectKey:'project-a'}]);assert.deepEqual(memories.get(code.id).relatedMemoryIds,[originals[1].id]);
 store.delete(coding);assert.throws(()=>memories.get(code.id));assert.equal(memories.page({tier:'consolidated'}).items.length,1);
 await lifecycle.close();await pipeline.close();
});
