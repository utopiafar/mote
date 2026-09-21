import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {MemoryLifecycle} from '../src/memory-lifecycle.js';
import {Conversations} from '../src/conversations.js';
import {WorkingMemory} from '../src/working-memory.js';
import {seedMemoryFixtures} from '../../../scripts/memory-fixtures.js';
const empty=()=>({answer:'{"memories":[]}',citations:[],trace:[],runId:randomUUID()});
function fixture(t:TestContext){const directory=mkdtempSync(join(tmpdir(),'mote-lifecycle-fixture-')),store=new Store(directory);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return store;}
function event(store:Store,id=randomUUID()){store.db.prepare("INSERT INTO changes(id,operation,changed_at) VALUES(?,'upsert',?)").run(id,new Date().toISOString());return id;}

test('durable AND admission, immutable window, arrivals during work, no empty repeats and coalesced ticks',async t=>{
  const store=fixture(t);let now=0,calls=0,release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
  const lifecycle=new MemoryLifecycle(store,()=>true,()=>now);t.after(()=>lifecycle.close());
  lifecycle.register({id:'extraction',version:'fixture',stream:'evidence',async run(w){calls++;assert.equal(w.ids.length,25);entered();await new Promise<void>(r=>release=r);}});
  for(let i=0;i<25;i++)event(store);await lifecycle.tick();assert.equal(calls,0);
  now=6*3600000;const running=lifecycle.tick();await ready;const coalesced=lifecycle.tick();void coalesced;assert.equal(calls,1);event(store);release();await running;
  assert.equal(lifecycle.view().extensions[0].pendingChanges,1);assert.equal(lifecycle.view().extensions[0].cursor,25);now+=24*3600000;await lifecycle.tick();assert.equal(calls,1);
  assert.throws(()=>lifecycle.configure({...lifecycle.settings(),summaryCharacters:12000,contextCharacters:4000}));
});

test('restart preserves failed window, snapshot settings and backoff; success alone advances cursor',async t=>{
  const store=fixture(t);let now=0;let lifecycle=new MemoryLifecycle(store,()=>true,()=>now);
  lifecycle.register({id:'extraction',version:'fixture',stream:'evidence',async run(_w,checkpoint){checkpoint('durable-child');throw Error('fixture failure');}});
  for(let i=0;i<25;i++)event(store);now=6*3600000;await lifecycle.tick();assert.equal(lifecycle.view().extensions[0].cursor,0);await lifecycle.close();
  lifecycle=new MemoryLifecycle(store,()=>true,()=>now);t.after(()=>lifecycle.close());let seen=0;
  lifecycle.register({id:'extraction',version:'fixture',stream:'evidence',async run(w){seen++;assert.equal(w.checkpoint,'durable-child');assert.equal(w.settings.batchCharacters,12000);}});
  lifecycle.configure({...lifecycle.settings(),batchCharacters:500});await lifecycle.tick();assert.equal(seen,0);now+=121000;await lifecycle.tick();assert.equal(seen,1);assert.equal(lifecycle.view().extensions[0].cursor,25);
});

test('480 originals across six months replay all current segments; FTS finds old scoped Chinese/English; pagination and deletion stay correct',async t=>{
  const store=fixture(t),data=await seedMemoryFixtures(store),memories=new MemoryStore(store),seen=new Set<string>();
  assert.equal(data.currentIds.length,472);assert.equal(store.list({limit:1}).totalCount,472);
  assert.equal(store.search({query:'离线索引实验',after:'2026-03-01T00:00:00Z',before:'2026-04-01T00:00:00Z'})[0].id,data.anchors.late);
  assert.ok(store.search({query:'uncertain outcome',deviceId:'fixture-device-0',limit:200}).every(e=>e.deviceId==='fixture-device-0'));
  for(const query of ['林岚 清晨','清晨 开会','林岚 喜欢 清晨 开会'])assert.deepEqual(store.search({query}).map(r=>r.id),[data.anchors['other-person']],query+' finds embedded short Chinese words');
  const pipeline=new MemoryPipeline({store,memories,configured:()=>true,model:()=> 'fixture-only',query:async input=>{for(const id of input.evidenceIds)seen.add(id);assert.ok(input.evidenceRanges.reduce((n,r)=>n+r.length,0)<=12000);return empty();}});t.after(()=>pipeline.close());
  const job=await pipeline.run(pipeline.create({evidenceIds:data.currentIds}).id);assert.equal(job.status,'completed');assert.equal(seen.size,472);assert.equal(pipeline.create({evidenceIds:data.currentIds}).totalBatches,0);
  for(const id of data.currentIds.slice(0,160)){const record=store.evidence([id])[0];memories.extract({answer:JSON.stringify({memories:[{title:'索引候选 '+id,statement:`原文记录 [${id}]`,uncertainty:'合成验证',evidenceIds:[id],evidence:[{id,offset:0,quote:record.ocrText}]}]}),citations:[{id,capturedAt:record.capturedAt,appName:'Generated',excerpt:record.ocrText}],trace:[],runId:randomUUID()},'fixture-only');}
  const all:string[]=[];let cursor:string|undefined;do{const page=memories.page({query:'索引候选',limit:17,cursor});all.push(...page.items.map(m=>m.id));cursor=page.nextCursor??undefined;}while(cursor);assert.equal(new Set(all).size,160);
  const oldest=memories.get(all.at(-1)!);assert.equal(memories.page({id:oldest.id,level:'detail'}).items[0].id,oldest.id);assert.match(memories.text(oldest.id),/Provenance/);
  store.delete(oldest.evidenceIds[0]);assert.equal(memories.page({id:oldest.id,includeStale:true}).items.length,0);assert.equal(store.db.prepare('SELECT id FROM memories_fts WHERE id=?').get(oldest.id),undefined);
});

test('working summary preserves prefix, discloses recent turns and cannot survive source deletion or conversation deletion',async t=>{
  const store=fixture(t),conversations=new Conversations(store),working=new WorkingMemory(store,conversations),lifecycle=new MemoryLifecycle(store,()=>true),settings=lifecycle.settings();t.after(()=>lifecycle.close());
  let id:string|undefined;for(let i=0;i<20;i++){const result=conversations.append(id?conversations.get(id):undefined,{question:'合成问题 '+i},{answer:'合成回答 '+i,citations:[],trace:[],runId:randomUUID()});id=result.conversationId;}
  assert.equal(working.context(conversations.get(id!),settings).turns.length,20,'Retain available context while periodic compaction is pending');
  await working.compact(id!,settings,async input=>{assert.equal(input.skill,'working-memory');return {...empty(),answer:'早期决定：只处理合成资料；待办：验证分页。'};});
  const context=working.context(conversations.get(id!),settings);assert.equal(context.turns.length,8);assert.equal(context.workingMemory?.coveredTurns,12);assert.equal(context.omittedTurns,0);
  store.invalidateMemoryEvidence(randomUUID());assert.equal(working.get(conversations.get(id!)),undefined,'A source revision retires derived working context');
  await working.compact(id!,settings,async()=>({...empty(),answer:'合成工作摘要'}));
  store.invalidateConversationAnswers();assert.equal(working.get(conversations.get(id!)),undefined);
  await working.compact(id!,settings,async()=>{conversations.delete(id!);return {...empty(),answer:'禁止复活'};}).then(()=>assert.fail('Deleted conversation resurrected'),()=>{});
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM working_memories').get()!.n,0);
});

test('lexical scope is applied before the former 500-candidate global limit',async t=>{
  const store=fixture(t);const {SourceStore}=await import('../src/sources.js');const sources=new SourceStore(store);sources.register({id:'scope-fixture',name:'Generated scope boundary',kind:'custom',deviceId:'generated',platform:'import'});
  for(let i=0;i<501;i++)await sources.upsert('scope-fixture',{externalId:String(i),revision:'1',observedAt:'2026-08-01T00:00:00Z',text:'shared lexical fixture',kind:'file',layer:'original'});
  const late=await sources.upsert('scope-fixture',{externalId:'late',revision:'1',observedAt:'2026-08-02T00:00:00Z',text:'shared lexical fixture',kind:'file',layer:'original',document:{recordedAt:'2026-03-01T00:00:00Z',timeBasis:'recorded',contentRole:'authored'}});
  assert.deepEqual(store.search({query:'shared',after:'2026-03-01T00:00:00Z',before:'2026-04-01T00:00:00Z'}).map(r=>r.id),[late.id]);
});

test('pressure compacts unsummarized dialogue immediately using separate task context',async t=>{
  const store=fixture(t),conversations=new Conversations(store),working=new WorkingMemory(store,conversations),lifecycle=new MemoryLifecycle(store,()=>true);t.after(()=>lifecycle.close());
  let id:string|undefined;
  for(let i=0;i<10;i++)id=conversations.append(id?conversations.get(id):undefined,{question:i===0?'Explicitly reject cloud upload':'Continue '+i},{...empty(),answer:'Generated lengthy reply. '.repeat(200)}).conversationId;
  let calls=0;
  const context=await working.prepare(conversations.get(id!),lifecycle.settings(),'Continue',async input=>{
    calls++;assert.ok(input.question.length<20000);assert.ok(JSON.stringify(input.taskContext).length>20000);assert.equal(input.taskContext?.turns[0].question,'Explicitly reject cloud upload');return {...empty(),answer:'User explicitly rejected cloud upload (first turn); this remains a constraint.'};
  });
  assert.equal(calls,1);assert.equal(context.omittedTurns,0);assert.match(context.workingMemory!.text,/rejected cloud/);assert.ok(context.turns.length>0);
});

test('failed compaction cannot silently discard dialogue and oversized latest turn is summarized',async t=>{
  const store=fixture(t),conversations=new Conversations(store),working=new WorkingMemory(store,conversations),lifecycle=new MemoryLifecycle(store,()=>true);t.after(()=>lifecycle.close());
  const {conversationId}=conversations.append(undefined,{question:'x'.repeat(19000)},{...empty(),answer:'y'.repeat(19000)});
  await assert.rejects(working.prepare(conversations.get(conversationId),lifecycle.settings(),'continue',async()=>{throw Error('provider unavailable');}),/provider unavailable/);
  const context=await working.prepare(conversations.get(conversationId),lifecycle.settings(),'continue',async()=>({...empty(),answer:'Explicit generated constraint preserved'}));
  assert.equal(context.omittedTurns,0);assert.equal(context.workingMemory?.coveredTurns,1);
});

test('a single huge turn is summarized in bounded spans and partial failure never advances the cursor',async t=>{
 const store=fixture(t),conversations=new Conversations(store),working=new WorkingMemory(store,conversations),lifecycle=new MemoryLifecycle(store,()=>true);t.after(()=>lifecycle.close());
 const text='generated🌱'.repeat(10000),{conversationId}=conversations.append(undefined,{question:'Preserve all spans'},{...empty(),answer:text});
 let calls=0;
 await assert.rejects(working.prepare(conversations.get(conversationId),lifecycle.settings(),'continue',async()=>{if(++calls===3)throw Error('synthetic failure');return {...empty(),answer:'partial'};}));
 assert.equal(working.get(conversations.get(conversationId)),undefined);
 const pieces:string[]=[];
 await working.prepare(conversations.get(conversationId),lifecycle.settings(),'continue',async input=>{assert.ok(JSON.stringify(input.taskContext).length<80000);for(const span of input.taskContext!.turns)if(span.field==='answer')pieces.push(String(span.text));return {...empty(),answer:'complete generated summary'};});
 assert.equal(pieces.join(''),text);assert.equal(working.get(conversations.get(conversationId))?.coveredTurns,1);
});

test('a slow insight does not block subsequent extraction windows or overlap itself',async t=>{
  const store=fixture(t);let now=0,extractions=0,insights=0,release!:()=>void;
  const lifecycle=new MemoryLifecycle(store,()=>true,()=>now);t.after(()=>lifecycle.close());
  lifecycle.register({id:'extraction',version:'fixture',stream:'evidence',async run(){extractions++;}});
  lifecycle.register({id:'insights',version:'fixture',stream:'evidence',async run(){insights++;await new Promise<void>(r=>release=r);}});
  const settings=lifecycle.settings();lifecycle.configure({...settings,extraction:{...settings.extraction,minChanges:1,maxItems:1},insights:{...settings.insights,minChanges:1}});
  event(store);event(store);now=24*3600000;
  const first=lifecycle.tick();await new Promise(r=>setImmediate(r));
  assert.equal(extractions,1);assert.equal(insights,1);
  const second=lifecycle.tick();await new Promise(r=>setImmediate(r));
  assert.equal(extractions,2);assert.equal(insights,1);assert.equal(lifecycle.view().extensions.find(e=>e.id==='insights')!.cursor,0);
  release();await Promise.all([first,second]);assert.ok(lifecycle.view().extensions.find(e=>e.id==='insights')!.cursor>0);
});

test('startup recovers detached queued jobs without bypassing active retry or disabled extraction',async t=>{
  const {recoverableMemoryJobs}=await import('../src/lifecycle-extensions.js');
  const store=fixture(t),lifecycle=new MemoryLifecycle(store,()=>true);t.after(()=>lifecycle.close());
  lifecycle.register({id:'extraction',version:'fixture',stream:'evidence',async run(){}});
  store.db.exec('CREATE TABLE IF NOT EXISTS memory_jobs(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,json TEXT NOT NULL)');
  for(const [id,status,importJobId] of [['manual','queued',null],['orphan','queued','lifecycle:old'],['active','queued','lifecycle:current'],['paused','paused','lifecycle:paused'],['cancelled','cancelled',null]])store.db.prepare('INSERT INTO memory_jobs VALUES(?,?,?)').run(id,new Date().toISOString(),JSON.stringify({id,status,importJobId}));
  store.db.prepare('UPDATE memory_lifecycle_state SET json=? WHERE id=?').run(JSON.stringify({cursor:0,lastSuccess:0,failures:1,retryAt:Date.now()+60000,active:{checkpoint:'active',ids:[]}}),'extraction');
  assert.deepEqual(recoverableMemoryJobs(store,lifecycle),['manual','orphan']);
  const settings=lifecycle.settings();lifecycle.configure({...settings,extraction:{...settings.extraction,enabled:false}});
  assert.deepEqual(recoverableMemoryJobs(store,lifecycle),['manual']);
});

test('shutdown preserves the checkpoint without counting interrupted work as another failure',async t=>{
  const store=fixture(t);let now=0,reject!:(error:Error)=>void;
  const lifecycle=new MemoryLifecycle(store,()=>true,()=>now);
  lifecycle.register({id:'extraction',version:'fixture',stream:'evidence',async run(_window,checkpoint){checkpoint('resume-after-restart');await new Promise<void>((_resolve,r)=>reject=r);}});
  for(let i=0;i<25;i++)event(store);now=6*3600000;
  const running=lifecycle.tick();await new Promise(r=>setImmediate(r));const closing=lifecycle.close();reject(Error('shutdown'));
  await Promise.all([running,closing]);const state=lifecycle.view().extensions[0];assert.equal(state.failures,0);assert.equal(state.retryAt,undefined);assert.equal(state.cursor,0);assert.equal(state.active?.checkpoint,'resume-after-restart');
});
