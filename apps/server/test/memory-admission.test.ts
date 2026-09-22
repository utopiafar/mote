import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {MemoryLifecycle} from '../src/memory-lifecycle.js';
import {reviewMemory} from '../src/memory-review.js';
const admission={layer:'memory',reason:'Explicit project constraint for future scheduling',scope:'Generated project',attribution:'user'};
function fixture(t:TestContext){const dir=mkdtempSync(join(tmpdir(),'mote-admission-')),store=new Store(dir),sources=new SourceStore(store),memories=new MemoryStore(store);sources.register({id:'generated',name:'Generated',kind:'custom',deviceId:'fixture',platform:'import'});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,sources,memories};}
const result=(id:string,extra:Record<string,unknown>={})=>({answer:JSON.stringify({memories:[{title:'Explicit scheduling constraint',statement:`Afternoon meetings only [${id}]`,uncertainty:'Project scoped',admission,evidenceIds:[id],evidence:[{id,quote:'Afternoon meetings only'}],...extra}]}),citations:[{id,capturedAt:'2026-09-18T00:00:00Z',appName:'Generated',excerpt:'Afternoon meetings only'}],trace:[],runId:randomUUID()});
async function original(sources:SourceStore,key='a'){return sources.upsert('generated',{externalId:key,text:'Afternoon meetings only',revision:'1',observedAt:'2026-09-18T00:00:00Z',title:'Generated',kind:'file',layer:'original'});}

test('strict admission requires exact provenance; legacy and observations remain separate and deletion cascades',async t=>{
 const {sources,memories,store}=fixture(t),a=await original(sources);
 assert.throws(()=>memories.extract(result(a.id,{admission:undefined}),'fixture',{requireAdmission:true}),/Admission/);
 assert.throws(()=>memories.extract(result(a.id,{evidence:undefined}),'fixture',{requireAdmission:true}),/Admission/);
 const observation=memories.extract(result(a.id,{admission:{...admission,layer:'observation'}}),'fixture',{requireAdmission:true}).items[0];
 const selected=memories.extract(result(a.id),'fixture',{requireAdmission:true}).items[0];
 memories.extract(result(a.id,{admission:undefined}),'legacy');
 assert.deepEqual(memories.list({layer:'memory'}).map(m=>m.id),[selected.id]);
 assert.deepEqual(memories.list({layer:'observation'}).map(m=>m.id),[observation.id]);assert.equal(memories.list({layer:'legacy'}).length,1);
 assert.equal(selected.evidence![0].offset,0);store.delete(a.id);assert.equal(memories.list({includeStale:true}).length,0);
});

test('independent review can reject a valid draft without saving it; empty completion still checkpoints',async t=>{
 const {sources,memories,store}=fixture(t),a=await original(sources);let reviews=0;
 const pipeline=new MemoryPipeline({store,memories,requireAdmission:true,configured:()=>true,model:()=> 'fixture',query:async()=>result(a.id),review:async(input,draft)=>reviewMemory(input,draft,async request=>{reviews++;assert.ok(request.taskContext?.untrustedMemoryDraft);return {answer:'{"memories":[]}',citations:[],trace:[],runId:'review-rejected'};})});t.after(()=>pipeline.close());
 const job=await pipeline.run(pipeline.create({evidenceIds:[a.id]}).id);assert.equal(job.status,'completed');assert.equal(reviews,1);assert.equal(memories.list().length,0);assert.equal(pipeline.create({evidenceIds:[a.id]}).totalBatches,0);
});

test('review cannot escape ranges; failed validation details survive successful retry',async t=>{
 const {sources,memories,store}=fixture(t),a=await original(sources),b=await original(sources,'b');let reviews=0;
 const pipeline=new MemoryPipeline({store,memories,requireAdmission:true,configured:()=>true,model:()=> 'actual-model',query:async()=>result(a.id),review:async()=>result(++reviews===1?b.id:a.id)});t.after(()=>pipeline.close());
 const job=await pipeline.run(pipeline.create({evidenceIds:[a.id]}).id);assert.equal(job.status,'completed');assert.equal(job.batches[0].validationFailures?.[0].phase,'review');assert.equal(job.batches[0].validationFailures?.[0].code,'scope');
 const m=memories.get(job.memoryIds[0]);assert.equal(m.model,'actual-model');assert.ok(m.reviewRunId);assert.deepEqual(m.evidenceIds,[a.id]);
});

test('consolidation rejects copied input, observations and unrelated parent links',async t=>{
 const {sources,memories}=fixture(t),a=await original(sources),b=await original(sources,'b');
 const ma=memories.extract(result(a.id),'fixture').items[0],mb=memories.extract(result(b.id),'fixture').items[0];
 const options={requireAdmission:true,tier:'consolidated' as const,relatedMemoryIds:[ma.id,mb.id]};
 assert.throws(()=>memories.extract(result(a.id,{relatedMemoryIds:[ma.id]}),'fixture',options),/not copy/);
 assert.throws(()=>memories.extract(result(a.id,{statement:`New synthesis [${a.id}]`,relatedMemoryIds:[mb.id]}),'fixture',options),/contribute/);
 assert.throws(()=>memories.extract(result(a.id,{admission:{...admission,layer:'observation'},relatedMemoryIds:[ma.id]}),'fixture',options),/Consolidation/);
 const saved=memories.extract(result(a.id,{statement:`Project meeting constraint applies to future planning [${a.id}]`,relatedMemoryIds:[ma.id]}),'fixture',options).items[0];assert.deepEqual(saved.relatedMemoryIds,[ma.id]);
});

test('backlog drains bounded frozen rounds across restart, including small tail, without consuming later arrivals',async t=>{
 const {store}=fixture(t);let now=0,calls=0;
 const register=(l:MemoryLifecycle)=>l.register({id:'extraction',version:'fixture',stream:'evidence',async run(){calls++;}});
 let l=new MemoryLifecycle(store,()=>true,()=>now);register(l);l.configure({...l.settings(),drainWindows:3,extraction:{enabled:true,intervalHours:6,minChanges:25,maxItems:100}});
 const add=()=>store.db.prepare("INSERT INTO changes(id,operation,changed_at) VALUES(?,'upsert',?)").run(randomUUID(),new Date().toISOString());
 for(let i=0;i<205;i++)add();await l.tick();assert.equal(calls,1);assert.equal(l.view().extensions[0].cursor,100);await l.close();
 add();l=new MemoryLifecycle(store,()=>true,()=>now);register(l);t.after(()=>l.close());await l.tick();await l.tick();assert.equal(calls,3);assert.equal(l.view().extensions[0].cursor,205);await l.tick();assert.equal(calls,3);assert.equal(l.view().extensions[0].pendingChanges,1);
});


test('generation receipt wins over stale configured model metadata',async t=>{
 const {sources,memories}=fixture(t),a=await original(sources);
 const value={...result(a.id),usage:{id:randomUUID(),provider:'codex',model:'actual-generation-model',operation:'memory-consolidation',createdAt:new Date().toISOString(),durationMs:10,status:'completed' as const,estimatedCost:null,currency:'USD'}};
 assert.equal(memories.extract(value,'obsolete-config-model',{requireAdmission:true}).items[0].model,'actual-generation-model');
});

test('bounded rounds keep draining on threshold while disabled extraction pauses safely',async t=>{
 const {store}=fixture(t);let now=0;const l=new MemoryLifecycle(store,()=>true,()=>now);t.after(()=>l.close());
 l.register({id:'extraction',version:'fixture',stream:'evidence',async run(){}});
 l.configure({...l.settings(),drainWindows:2,extraction:{enabled:true,intervalHours:6,minChanges:1,maxItems:2}});
 for(let i=0;i<7;i++)store.db.prepare("INSERT INTO changes(id,operation,changed_at) VALUES(?,'upsert',?)").run(randomUUID(),new Date().toISOString());
 now=6*3600000;await l.tick();assert.equal(l.view().extensions[0].cursor,2);
 l.configure({...l.settings(),extraction:{...l.settings().extraction,enabled:false}});await l.tick();assert.equal(l.view().extensions[0].cursor,2);
 l.configure({...l.settings(),extraction:{...l.settings().extraction,enabled:true}});await l.tick();assert.equal(l.view().extensions[0].cursor,4);await l.tick();assert.equal(l.view().extensions[0].cursor,6);
 now+=6*3600000;await l.tick();await l.tick();assert.equal(l.view().extensions[0].cursor,7);
});
