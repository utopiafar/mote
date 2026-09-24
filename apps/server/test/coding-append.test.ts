import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {SourcePipelineRuntime} from '../src/source-pipelines.js';
import {SourceArchiveRawReader} from '../src/source-archive-reader.js';
import {codingSourcePlugin} from '../src/coding-source-plugin.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import type {MaterialDraft,MaterialAppendDraft} from '../src/materials.js';

const group=JSON.stringify(['codex','generated-project','generated-session']);
const event=(i:number,text=`Generated Coding event ${i}. ${'x'.repeat(200)}`)=>({
  externalId:`event-${i}`,revision:'1',observedAt:new Date(Date.parse('2026-09-24T01:00:00.000Z')+i*1000).toISOString(),
  kind:'message',layer:'original',text,document:{contentRole:'transcript',coding:{version:1,provider:'codex',
    projectKey:'generated-project',sessionId:'generated-session',eventId:`event-${i}`,role:'user',part:0,parts:1}},
});
async function fixture(t:import('node:test').TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-coding-append-')),store=new Store(directory),materials=new MaterialStore(store);
  const runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);await runtime.ready;
  const sources=new SourceStore(store,runtime);sources.register({id:'coding',name:'Generated Coding',kind:'coding-agent',deviceId:'fixture-device',platform:'macos'});
  t.after(async()=>{await runtime.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,materials,runtime,sources};
}

test('append reads only new refs, reuses prefix blocks and anchors, and keeps the pinned old revision',async t=>{
  const {store,materials,runtime,sources}=await fixture(t);
  await sources.upsertBatch('coding',Array.from({length:301},(_,i)=>event(i)));
  await runtime.tick();
  const before=materials.list().items[0]!;assert.ok(before.blockCount>2);
  const base=materials.codingBase(materialId('coding',group))!;assert.ok(base.lastBlock!.text.length<11999);
  const oldIds=materials.evidenceIds(before.ref),oldTail=materials.read(before.ref,{offset:before.textLength-200,length:200}).text;
  const blockRows=Number(store.db.prepare('SELECT count(*) n FROM material_block_versions').get()!.n);
  const originalPage=SourceArchiveRawReader.prototype.page,originalRead=SourceArchiveRawReader.prototype.read;
  let pages=0,reads=0;
  SourceArchiveRawReader.prototype.page=async function(request){pages++;return originalPage.call(this,request);};
  SourceArchiveRawReader.prototype.read=async function(ref,request){reads++;return originalRead.call(this,ref,request);};
  try{await sources.upsertBatch('coding',Array.from({length:10},(_,i)=>event(301+i,`New append marker ${i}`)));await runtime.tick();}
  finally{SourceArchiveRawReader.prototype.page=originalPage;SourceArchiveRawReader.prototype.read=originalRead;}
  const after=materials.list().items[0]!;assert.notEqual(after.revision,before.revision);
  assert.equal(pages,1);assert.equal(reads,10);
  assert.ok(Number(store.db.prepare('SELECT count(*) n FROM material_block_versions').get()!.n)-blockRows<=2);
  assert.equal(materials.read(before.ref,{offset:before.textLength-200,length:200}).text,oldTail);
  assert.equal(materials.evidenceIds(after.ref)[0],oldIds[0]);assert.equal(materials.isCurrentEvidence(oldIds[0]!),true);
  assert.equal(materials.isCurrentEvidence(oldIds.at(-1)!),false);
  assert.equal(materials.list({query:'New append marker 9'}).items[0]?.revision,after.revision);
  const reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials,runtime);
  const currentIds=materials.evidenceIds(after.ref);
  assert.equal(reader.memories.isCurrentEvidence(oldIds[0]!),true,'reused prefix stays admissible to Memory');
  assert.equal(reader.memories.isCurrentEvidence(oldIds.at(-1)!),false,'replaced tail cannot support Memory');
  const pipeline=new MemoryPipeline({store,memories:reader.memories,model:()=> 'fixture-model',configured:()=>true,
    materialAllowedForMemory:ref=>reader.materialAllowedForMemory(ref),query:async()=>{throw Error('No model request expected');}});
  t.after(()=>pipeline.close());
  const job=pipeline.create({evidenceIds:[oldIds[0]!,currentIds.at(-1)!],originKey:after.ref});
  assert.equal(job.evidenceIds.length,2);
  assert.throws(()=>pipeline.create({evidenceIds:[oldIds.at(-1)!]}),/superseded|changed|ready/i);
});

test('one thousand generated Coding events form one complete searchable Material for model reads',async t=>{
  const {store,materials,runtime,sources}=await fixture(t);
  for(let first=0;first<1000;first+=500)
    await sources.upsertBatch('coding',Array.from({length:500},(_,i)=>event(first+i)));
  await runtime.tick();
  const reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials,runtime);
  const initial=reader.materialCatalog({query:'Generated Coding event 999'}).items;
  assert.equal(initial.length,1);
  assert.equal(materials.list({sourceId:'coding'}).items.length,1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM captures').get()!.n,0);
  const readAll=(ref:string)=>{let text='',offset=0;
    for(;;){const page=reader.materialRead({ref,offset,length:12000});text+=page.text;
      if(page.textRange.nextOffset===null)return text;offset=page.textRange.nextOffset;}
  };
  const first=initial[0]!;
  const initialText=readAll(first.ref);
  assert.equal((initialText.match(/Event: event-\d+/g)??[]).length,1000);
  for(let i=0;i<1000;i++)assert.ok(initialText.includes(`Generated Coding event ${i}. ${'x'.repeat(200)}`));
  await sources.upsertBatch('coding',Array.from({length:50},(_,i)=>event(1000+i,`Added final marker ${i}`)));
  await runtime.tick();
  const current=reader.materialCatalog({query:'Added final marker 49'}).items;
  assert.equal(current.length,1);assert.equal(current[0]!.id,first.id);
  assert.notEqual(current[0]!.revision,first.revision);
  const currentText=readAll(current[0]!.ref);
  assert.equal((currentText.match(/Event: event-\d+/g)??[]).length,1050);
  assert.ok(currentText.startsWith(initialText));
  for(let i=0;i<50;i++)assert.ok(currentText.includes(`Added final marker ${i}`));
  assert.equal(materials.list({sourceId:'coding'}).items.length,1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM captures').get()!.n,0);
  const prefix=reader.materialRead({ref:current[0]!.ref,offset:0,length:4000});
  assert.ok(prefix.originalRefs.length>0);
  assert.equal(materials.isCurrentEvidence(prefix.originalRefs[0]!),true);
});

test('a second append after restart keeps pinned revisions and reuses the stable prefix',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-coding-reopen-'));
  let store=new Store(directory),materials=new MaterialStore(store),runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);
  await runtime.ready;
  let sources=new SourceStore(store,runtime);
  sources.register({id:'coding',name:'Generated Coding',kind:'coding-agent',deviceId:'fixture-device',platform:'macos'});
  t.after(async()=>{await runtime.close();store.close();rmSync(directory,{recursive:true,force:true});});
  await sources.upsertBatch('coding',Array.from({length:301},(_,i)=>event(i)));
  await runtime.tick();
  await sources.upsertBatch('coding',Array.from({length:10},(_,i)=>event(301+i,`First append marker ${i}`)));
  await runtime.tick();
  const first=materials.list().items[0]!,firstText=materials.read(first.ref,{offset:first.textLength-300,length:300}).text;
  const firstAnchors=materials.evidenceIds(first.ref);
  const prefix=firstAnchors[0]!,tail=firstAnchors.at(-1)!;
  await runtime.close();store.close();
  store=new Store(directory);materials=new MaterialStore(store);runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);
  await runtime.ready;sources=new SourceStore(store,runtime);
  const oldRead=SourceArchiveRawReader.prototype.read;let reads=0;
  SourceArchiveRawReader.prototype.read=async function(ref,request){reads++;return oldRead.call(this,ref,request);};
  try{await sources.upsertBatch('coding',Array.from({length:10},(_,i)=>event(311+i,`Second append marker ${i}`)));await runtime.tick();}
  finally{SourceArchiveRawReader.prototype.read=oldRead;}
  const second=materials.list().items[0]!;
  assert.equal(reads,10);
  assert.equal(materials.read(first.ref,{offset:first.textLength-300,length:300}).text,firstText);
  assert.equal(materials.isCurrentEvidence(prefix),true);
  assert.equal(materials.isCurrentEvidence(tail),false);
  assert.equal(materials.list({query:'First append marker 9'}).items[0]?.revision,second.revision);
  assert.equal(materials.list({query:'Second append marker 9'}).items[0]?.revision,second.revision);
});

test('revision replacement rejects the append epoch and rebuilds the current text',async t=>{
  const {materials,runtime,sources}=await fixture(t);
  await sources.upsertBatch('coding',Array.from({length:120},(_,i)=>i===0?event(0,'OLD_BODY_MARKER_0'):event(i)));
  await runtime.tick();const before=materials.list().items[0]!;
  const originalRead=SourceArchiveRawReader.prototype.read;let reads=0;
  SourceArchiveRawReader.prototype.read=async function(ref,request){reads++;return originalRead.call(this,ref,request);};
  try{await sources.upsert('coding',{...event(0,'Replaced original event'),revision:'2',observedAt:'2026-09-25T01:00:00.000Z'});await runtime.tick();}
  finally{SourceArchiveRawReader.prototype.read=originalRead;}
  const after=materials.list().items[0]!;assert.ok(reads>=120);
  assert.equal(materials.list({query:'Replaced original event'}).items[0]?.revision,after.revision);
  assert.equal(materials.list({query:'OLD_BODY_MARKER_0'}).items.length,0);
  assert.match(materials.read(before.ref,{length:12000}).text,/OLD_BODY_MARKER_0/);
});

test('bounded raw pages yield to pause timers while accepted work still publishes',async t=>{
  const {materials,runtime,sources}=await fixture(t);
  await sources.upsertBatch('coding',Array.from({length:250},(_,i)=>event(i)));
  const originalPage=SourceArchiveRawReader.prototype.page;
  let pages=0,revoked=false;
  SourceArchiveRawReader.prototype.page=async function(request){
    const result=await originalPage.call(this,request);pages++;
    if(pages===1)setTimeout(()=>{sources.update('coding',{enabled:false});revoked=true;},0);
    return result;
  };
  try{await runtime.tick();}finally{SourceArchiveRawReader.prototype.page=originalPage;}
  assert.equal(revoked,true);assert.equal(materials.list().items.length,1);
  assert.ok(pages>=1);
});

test('a tombstone revokes stale Material and Memory anchors before reorganization',async t=>{
  const {materials,runtime,sources,store}=await fixture(t);
  await sources.upsertBatch('coding',[event(0,'SECRET_DELETE_ME'),event(1,'Surviving generated event')]);await runtime.tick();
  const before=materials.list().items[0]!,anchor=materials.evidenceIds(before.ref)[0]!,reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials);
  assert.equal(reader.memories.isCurrentEvidence(anchor),true);
  await sources.upsert('coding',{...event(0,''),revision:'2',observedAt:'2026-09-25T01:00:00.000Z',deleted:true});
  assert.equal(materials.get(before.ref),undefined);assert.equal(materials.list({query:'SECRET_DELETE_ME'}).items.length,0);
  assert.equal(materials.evidence([anchor]).length,0);assert.equal(reader.memories.isCurrentEvidence(anchor),false);
  assert.throws(()=>reader.materialRead({ref:before.ref}),{statusCode:404});
  await runtime.tick();
  assert.equal(materials.list({query:'SECRET_DELETE_ME'}).items.length,0);
  assert.equal(materials.list({query:'Surviving generated event'}).items.length,1);
  assert.equal(materials.get(before.ref),undefined);
});

test('repeated tombstone republishes an unchanged visible projection at a fresh privacy sequence',async t=>{
  const {materials,runtime,sources}=await fixture(t);
  await sources.upsertBatch('coding',[{...event(0,''),deleted:true},event(1,'Surviving event')]);await runtime.tick();
  const before=materials.list().items[0]!;
  await sources.upsert('coding',{...event(0,''),revision:'2',observedAt:'2026-09-25T01:00:00.000Z',deleted:true});
  assert.equal(materials.get(before.ref),undefined);
  await runtime.tick();const after=materials.list().items[0]!;
  assert.ok(after);assert.notEqual(after.revision,before.revision);
  assert.equal(materials.get(before.ref),undefined);
  assert.equal(materials.list({query:'Surviving event'}).items[0]?.revision,after.revision);
});

test('pausing a source preserves previously published Material',async t=>{
  const {materials,runtime,sources}=await fixture(t);
  await sources.upsert('coding',event(0));await runtime.tick();const before=materials.list().items[0]!;
  sources.update('coding',{enabled:false});
  assert.equal(materials.get(before.ref)?.revision,before.revision);
  assert.equal(materials.list({query:'Generated Coding event 0'}).items[0]?.revision,before.revision);
  await assert.rejects(sources.upsert('coding',event(1)),/paused/i);
});

test('a paused archive source completes already accepted work without changing its recipe pin',async t=>{
  const {materials,runtime,sources,store}=await fixture(t);
  await sources.upsert('coding',event(0));
  const before=store.db.prepare('SELECT recipe_version,recipe_config_fingerprint,archive_checkpoint FROM source_pipeline_work').get() as
    {recipe_version:string;recipe_config_fingerprint:string;archive_checkpoint:string};
  sources.update('coding',{enabled:false});
  await runtime.tick();
  assert.equal(materials.list({query:'Generated Coding event 0'}).items.length,1);
  assert.equal(store.db.prepare("SELECT count(*) n FROM execution_steps WHERE kind='source.archive-group' AND state='succeeded'").get()!.n,1);
  await assert.rejects(sources.upsert('coding',event(1)),/paused/i);
  sources.update('coding',{enabled:true});
  await runtime.tick();
  assert.equal(materials.list({query:'Generated Coding event 0'}).items.length,1);
  const after=store.db.prepare('SELECT recipe_version,recipe_config_fingerprint,archive_checkpoint FROM source_pipeline_work').get();
  assert.deepEqual(after,before);
});

test('changing intake retention preserves interpretation of an already accepted archive receipt',async t=>{
  const {materials,runtime,sources,store}=await fixture(t);
  await sources.upsert('coding',event(0,'Original body accepted before retention changed'));
  const before=store.db.prepare('SELECT recipe_version,recipe_config_fingerprint,archive_checkpoint FROM source_pipeline_work').get();
  sources.update('coding',{retention:'reference'});
  await runtime.tick();
  const material=materials.list({query:'Original body accepted'}).items[0]!;
  assert.match(materials.read(material.ref).text,/Original body accepted before retention changed/);
  assert.deepEqual(store.db.prepare('SELECT recipe_version,recipe_config_fingerprint,archive_checkpoint FROM source_pipeline_work').get(),before);
  await assert.rejects(sources.upsert('coding',event(1)),/references only/i);
});

test('chunk search finds boundary text and excludes superseded tails while pinned reads remain exact',async t=>{
  const {materials,store}=await fixture(t),id=materialId('coding','boundary-session');
  const draft:MaterialDraft={id,kind:'mote.coding-session',schemaVersion:2,title:'Generated boundary',
    origin:{sourceId:'coding',externalId:'boundary-session'},members:[{id:'archive',kind:'archive',ref:'archive:generated'}],
    blocks:[{id:'section-0',kind:'text',format:'markdown-fragment',text:'abc',memberIds:['archive']},
      {id:'section-1',kind:'text',format:'markdown-fragment',text:'def',memberIds:['archive']}],
    coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}};
  const first=materials.publish(draft,{codingSnapshot:{checkpoint:'first',appendEpoch:0,headCount:2}});
  materials.setSearchable(id,true);
  assert.equal(materials.list({query:'cde'}).items[0]?.revision,first.revision);
  const append:MaterialAppendDraft={...draft,mode:'append',baseRevision:first.revision,reuseBlocks:1,
    blocks:[{id:'section-1',kind:'text',format:'markdown-fragment',text:'xyz',memberIds:['archive']}]};
  const second=materials.publish(append,{expectedRevision:first.revision,codingSnapshot:{checkpoint:'second',appendEpoch:0,headCount:3}});
  assert.throws(()=>materials.publish(append,{expectedRevision:first.revision,
    codingSnapshot:{checkpoint:'stale',appendEpoch:0,headCount:4}}),{statusCode:409});
  assert.equal(materials.read(first.ref).text,'abcdef');assert.equal(materials.read(second.ref).text,'abcxyz');
  assert.equal(materials.list({query:'cde'}).items.length,0);
  assert.equal(materials.list({query:'cxy'}).items[0]?.revision,second.revision);
  materials.forget(id);
  assert.equal(store.db.prepare('SELECT count(*) n FROM material_fts_blocks').get()!.n,0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM material_block_payloads').get()!.n,0);
});
