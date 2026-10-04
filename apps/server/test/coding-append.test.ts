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

test('the Coding conversation projection excludes tool bodies and host envelopes from catalog, reads and evidence',async t=>{
  const {materials,runtime,sources}=await fixture(t);
  const withRole=(i:number,role:string,text:string,metadata:Record<string,unknown>={})=>{const item=event(i,text);return {...item,document:{...item.document,coding:{...item.document.coding,role,...metadata}}};};
  await sources.upsertBatch('coding',[
    withRole(0,'user','Generated decision: retain the workspace.',{attribution:'human'}),
    withRole(1,'tool_call','PRIVATE_TOOL_CALL_FIXTURE'),withRole(2,'tool_result','PRIVATE_TOOL_RESULT_FIXTURE'),withRole(3,'tool_call_delta','PRIVATE_TOOL_DELTA_FIXTURE'),
    withRole(4,'user','PRIVATE_STRUCTURED_HOST_FIXTURE',{attribution:'host'}),
    withRole(5,'user','# AGENTS.md instructions for /generated/project\n\n<INSTRUCTIONS>PRIVATE_LEGACY_HOST_FIXTURE</INSTRUCTIONS>'),
    withRole(6,'user','<external_codex_apps_open_page>{"page_id":"PRIVATE_PAGE_FIXTURE"}</external_codex_apps_open_page>'),
    withRole(7,'assistant','Generated report: completed; device validation unknown.',{attribution:'agent',channel:'final'}),
    withRole(8,'user','Explain the string tool_call and AGENTS.md.'),
  ]);await runtime.tick();
  const record=materials.list().items[0]!;assert.equal(record.schemaVersion,5);
  const text=materials.read(record.ref,{length:12000}).text;
  for(const secret of ['PRIVATE_TOOL_CALL_FIXTURE','PRIVATE_TOOL_RESULT_FIXTURE','PRIVATE_TOOL_DELTA_FIXTURE','PRIVATE_STRUCTURED_HOST_FIXTURE','PRIVATE_LEGACY_HOST_FIXTURE','PRIVATE_PAGE_FIXTURE']){
    assert.equal(materials.list({query:secret}).items.length,0);assert.ok(!text.includes(secret));
    assert.ok(materials.evidence(materials.evidenceIds(record.ref)).every(evidence=>!evidence.ocrText?.includes(secret)));
  }
  assert.match(text,/Generated decision: retain the workspace/);assert.match(text,/Generated report: completed; device validation unknown/);
  assert.match(text,/Explain the string tool_call and AGENTS.md/);assert.match(text,/Attribution: human/);assert.match(text,/Attribution: agent · Channel: final/);assert.match(text,/Attribution: unknown/);
  assert.equal(record.origin.firstAt,event(0).observedAt);assert.equal(record.origin.lastAt,event(8).observedAt);
});

test('tool-only appends advance the private archive checkpoint without changing conversation revision, times or anchors',async t=>{
  const {materials,runtime,sources}=await fixture(t);
  await sources.upsert('coding',event(0,'Generated visible request'));await runtime.tick();
  const before=materials.list().items[0]!,anchors=materials.evidenceIds(before.ref),checkpoint=materials.codingBase(before.id)!;
  const tool=event(1,'PRIVATE_APPENDED_TOOL_FIXTURE');await sources.upsert('coding',{...tool,document:{...tool.document,coding:{...tool.document.coding,role:'tool_result',branch:'tool-only-metadata'}}});await runtime.tick();
  const after=materials.list().items[0]!,current=materials.codingBase(after.id)!;
  assert.equal(after.revision,before.revision);assert.equal(after.origin.lastAt,before.origin.lastAt);assert.deepEqual(materials.evidenceIds(after.ref),anchors);
  assert.equal(current.headCount,checkpoint.headCount+1);assert.notEqual(current.archiveCheckpoint,checkpoint.archiveCheckpoint);
  assert.equal(materials.list({query:'PRIVATE_APPENDED_TOOL_FIXTURE'}).items.length,0);
  await sources.upsert('coding',event(2,'Generated next visible request'));await runtime.tick();
  const visible=materials.list().items[0]!;assert.notEqual(visible.revision,before.revision);assert.equal(visible.origin.lastAt,event(2).observedAt);
  assert.match(materials.read(visible.ref,{length:12000}).text,/Generated next visible request/);
});

test('a private tool revision rebuild after visible append preserves the exact conversation and its evidence',async t=>{
  const {materials,runtime,sources}=await fixture(t);
  const rawTool=event(1,'PRIVATE_TOOL_FIRST_REVISION'),tool={...rawTool,document:{...rawTool.document,coding:{...rawTool.document.coding,role:'tool_result'}}};
  await sources.upsertBatch('coding',[event(0,'Generated initial request'),tool]);await runtime.tick();
  await sources.upsert('coding',event(2,'Generated later response'));await runtime.tick();
  const before=materials.list().items[0]!,anchors=materials.evidenceIds(before.ref),base=materials.codingBase(before.id)!;
  await sources.upsert('coding',{...tool,revision:'2',text:'PRIVATE_TOOL_REPLACEMENT',observedAt:'2026-09-25T01:00:00Z'});await runtime.tick();
  const after=materials.list().items[0]!,current=materials.codingBase(after.id)!;
  assert.equal(after.revision,before.revision);assert.deepEqual(after.artifacts,before.artifacts);assert.deepEqual(materials.evidenceIds(after.ref),anchors);
  assert.equal(after.origin.lastAt,before.origin.lastAt);assert.notEqual(current.appendEpoch,base.appendEpoch);
  assert.equal(materials.list({query:'PRIVATE_TOOL_REPLACEMENT'}).items.length,0);
});

test('multi-part host envelopes and streamed assistant text keep exact provenance without admitting tools',async t=>{
  const {materials,runtime,sources}=await fixture(t);
  const host='<environment_context><cwd>/generated/project</cwd></environment_context>',parts=[host.slice(0,25),host.slice(25)];
  const hostItems=parts.map((text,part)=>{const item=event(part,text);return {...item,document:{...item.document,coding:{...item.document.coding,eventId:'legacy-host',part,parts:2}}};});
  const delta=(i:number,text:string)=>{const item=event(i,text);return {...item,document:{...item.document,recordedAt:`2026-06-01T00:00:0${i}.000Z`,coding:{...item.document.coding,provider:'kimi',projectKey:'kimi-project',sessionId:'streamed-session',role:'assistant_delta',attribution:'agent'}}};};
  await sources.upsertBatch('coding',[...hostItems,delta(2,'Hel'),delta(3,'lo 🌱')]);await runtime.tick();
  const codexRecord=materials.list().items.find(record=>record.origin.provider==='codex')!,kimiRecord=materials.list().items.find(record=>record.origin.provider==='kimi')!;
  assert.doesNotMatch(materials.read(codexRecord.ref,{length:12000}).text,/<environment_context>|generated\/project/);
  const text=materials.read(kimiRecord.ref,{length:12000}).text;
  assert.match(text,/Event: event-2 · Part: 0\/1 · Attribution: agent\n\nHel/);assert.match(text,/Event: event-3 · Part: 0\/1 · Attribution: agent\n\nlo 🌱/);
  assert.match(text,/Recorded: 2026-06-01T00:00:02.000Z/);assert.match(text,/Recorded: 2026-06-01T00:00:03.000Z/);
  assert.equal(kimiRecord.origin.firstAt,'2026-06-01T00:00:02.000Z');assert.equal(kimiRecord.origin.lastAt,'2026-06-01T00:00:03.000Z');
});

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

test('Coding blocks retain observation context through append without assigning one event date to the conversation',async t=>{
  const {store,materials,runtime,sources}=await fixture(t);
  const original=event(0,'Generated multi-block conversation. '.repeat(750));
  await sources.upsert('coding',{...original,document:{...original.document,recordedAt:'2026-05-01T08:00:00+08:00',timeBasis:'recorded'}});
  await runtime.tick();
  const before=materials.list().items[0]!,old=materials.evidence(materials.evidenceIds(before.ref));
  assert.ok(old.length>2);
  for(const record of old){
    assert.equal(record.capturedAt,original.observedAt);
    assert.equal(record.provenance?.document?.contentRole,'transcript');
    assert.equal(record.provenance?.document?.recordedAt,undefined);
    assert.equal(record.provenance?.document?.timeBasis,'unknown');
  }
  assert.match(old[0]!.ocrText!,/Recorded: 2026-05-01T08:00:00\+08:00/,'event-specific dates stay in the labeled event text');
  const oldTailContext=materials.codingBase(before.id)!.lastBlock!.evidenceContext;
  const added=event(1,'Generated appended message. '.repeat(600));
  await sources.upsert('coding',{...added,document:{...added.document,recordedAt:'2026-05-02T08:00:00+08:00',timeBasis:'recorded'}});
  await runtime.tick();
  const after=materials.list().items[0]!,current=materials.evidence(materials.evidenceIds(after.ref));
  assert.equal(current[0]!.id,old[0]!.id,'unchanged prefix keeps its evidence and context');
  assert.deepEqual(materials.evidence([old.at(-1)!.id])[0],old.at(-1),'the replaced tail keeps its historical context');
  assert.equal(current[old.length-1]!.capturedAt,oldTailContext!.observedAt,'a reused tail keeps the earlier observation');
  assert.equal(current.at(-1)!.capturedAt,added.observedAt,'new-only blocks use the appended event observation');
  assert.equal(current.at(-1)!.provenance?.document?.recordedAt,undefined);
  assert.equal(materials.codingBase(after.id)!.lastBlock!.evidenceContext?.observedAt,added.observedAt);
  materials.forget(after.id);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM material_evidence_context').get()!.n,0);
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

test('an exact tombstone replay keeps the rebuilt Material visible while a mixed new deletion revokes its own group',async t=>{
  const {store,materials,runtime,sources}=await fixture(t);
  const other=(i:number,text:string)=>{const item=event(i,text);return {...item,externalId:'other-'+i,document:{...item.document,coding:{...item.document.coding,sessionId:'other-generated-session',eventId:'other-'+i}}};};
  await sources.upsertBatch('coding',[event(0,'FIRST_DELETED_BODY'),event(1,'First surviving event'),other(0,'SECOND_DELETED_BODY'),other(1,'Second surviving event')]);await runtime.tick();
  const firstId=materialId('coding',group),secondId=materialId('coding',JSON.stringify(['codex','generated-project','other-generated-session']));
  const deletion={...event(0,''),revision:'2',observedAt:'2026-09-25T01:00:00.000Z',deleted:true};await sources.upsert('coding',deletion);assert.equal(materials.get(firstId),undefined);await runtime.tick();
  const first=materials.get(firstId)!,second=materials.get(secondId)!,work=store.db.prepare('SELECT * FROM source_pipeline_work ORDER BY id').all();assert.ok(first&&second);
  assert.equal((await sources.upsert('coding',deletion)).duplicate,true);assert.equal(materials.get(firstId)?.revision,first.revision);await runtime.tick();
  assert.equal(materials.get(firstId)?.revision,first.revision);assert.deepEqual(store.db.prepare('SELECT * FROM source_pipeline_work ORDER BY id').all(),work);assert.match(materials.read(first.ref,{length:12000}).text,/First surviving event/);
  const nextDeletion={...other(0,''),revision:'2',observedAt:'2026-09-25T01:00:00.000Z',deleted:true};const mixed=await sources.upsertBatch('coding',[deletion,nextDeletion]);assert.deepEqual(mixed.receipts.map(receipt=>receipt.duplicate),[true,false]);
  assert.equal(materials.get(firstId)?.revision,first.revision,'the already processed tombstone does not re-redact an unrelated unchanged group');assert.equal(materials.get(secondId),undefined,'the new tombstone hides its old Material before background work');assert.equal(materials.get(second.ref),undefined);
  await runtime.tick();assert.equal(materials.get(firstId)?.revision,first.revision);const current=materials.get(secondId)!;assert.ok(current);assert.notEqual(current.revision,second.revision);assert.match(materials.read(current.ref,{length:12000}).text,/Second surviving event/);assert.equal(materials.list({query:'SECOND_DELETED_BODY'}).items.length,0);
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
