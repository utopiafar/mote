import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {ProcessingRuntime} from '../src/processing-runtime.js';
import {formatArtifactRef} from '@mote/shared';

function draft(text='Generated session evidence'):MaterialDraft {
  const sourceId='synthetic-source',externalId='session-1';
  return {id:materialId(sourceId,externalId),kind:'coding.session',schemaVersion:1,title:'Generated session',
    origin:{sourceId,externalId,firstAt:'2026-09-24T01:00:00.000Z',lastAt:'2026-09-24T01:05:00.000Z'},
    blocks:[{id:'message-1',kind:'text',format:'plain',text,memberIds:[]}],members:[],
    coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
}
function fixture(t:import('node:test').TestContext,dailyInputCharacters=1200000){
  const directory=mkdtempSync(join(tmpdir(),'mote-material-processing-'));
  const store=new Store(directory),materials=new MaterialStore(store),sources=new SourceStore(store);
  const reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials);
  const runtime=new ProcessingRuntime(store,[],{semantic:{concurrency:1,dailyCalls:100,dailyInputCharacters}},Date.now,undefined,materials);
  t.after(async()=>{await runtime.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,materials,sources,reader,runtime};
}

test('a material-only processor reads a pinned page and its output follows revision lineage',async t=>{
  const {store,materials,runtime}=fixture(t),first=materials.publish(draft());
  let called=0,expectedRef=first.ref;
  runtime.registry.register({id:'fixture.material-page',version:'1',lane:'semantic',async process(input){
    called++;assert.deepEqual(input.observations,[]);assert.deepEqual(input.artifacts,[]);
    assert.equal(input.materials.length,1);assert.equal(input.materials[0]!.material.ref,expectedRef);
    assert.equal(input.materials[0]!.text,'Generated');
    return [{kind:'generated',text:input.materials[0]!.text,metadata:{coverage:'fixture'}}];
  }});
  const id=runtime.enqueue([{name:'page',processor:'fixture.material-page',materialInputs:[{ref:first.ref,offset:0,length:9}]}]).page;
  await runtime.tick();
  assert.equal(called,1);assert.equal(runtime.view().jobs.find(job=>job.id===id)?.state,'succeeded');
  const outputId=runtime.view().jobs.find(job=>job.id===id)!.outputs[0]!;
  const output=store.archive.get(outputId)!;
  assert.equal(output.text,'Generated');assert.deepEqual(output.materialInputs,[{ref:first.ref,offset:0,length:9}]);
  assert.equal(output.firstAt,'2026-09-24T01:00:00.000Z');
  assert.equal(store.db.prepare('SELECT revision FROM artifact_material_inputs WHERE artifact_id=?').get(outputId)?.revision,first.revision);
  assert.equal(store.db.prepare("SELECT input_characters FROM processing_usage WHERE lane='semantic'").get()?.input_characters,9);
  const child=store.archive.save('generated-child',outputId,'revision-1',{kind:'generated-child',text:'Derived page',metadata:{}},[],'fixture.child','1','fixture',[],[{id:outputId,revision:output.revision}]);
  assert.equal(store.archive.get(child.id)?.text,'Derived page');
  const revised=materials.publish(draft('Generated session evidence, revised'),{expectedRevision:first.revision});expectedRef=revised.ref;
  assert.equal(store.archive.get(outputId),undefined);assert.equal(store.archive.get(child.id),undefined);
  assert.throws(()=>runtime.enqueue([{name:'old',processor:'fixture.material-page',materialInputs:[{ref:first.ref}]}]),{statusCode:409});
  const next=runtime.enqueue([{name:'new',processor:'fixture.material-page',materialInputs:[{ref:revised.ref,offset:0,length:9}]}]).new;
  await runtime.tick();assert.equal(runtime.view().jobs.find(job=>job.id===next)?.state,'succeeded');
  materials.retire(revised.id,{expectedRevision:revised.revision});
  assert.equal(store.archive.get(runtime.view().jobs.find(job=>job.id===next)!.outputs[0]!),undefined);
});

test('material page characters are charged to the lane budget before processor execution',async t=>{
  const {store,materials,runtime}=fixture(t,5),record=materials.publish(draft());
  let called=0;runtime.registry.register({id:'fixture.budget',version:'1',lane:'semantic',async process(){called++;return [{kind:'generated',text:'never',metadata:{}}];}});
  const id=runtime.enqueue([{name:'page',processor:'fixture.budget',materialInputs:[{ref:record.ref,offset:0,length:9}]}]).page;
  await runtime.tick();
  assert.equal(called,0);assert.equal(runtime.view().jobs.find(job=>job.id===id)?.state,'blocked');
  assert.equal(store.db.prepare("SELECT count(*) n FROM processing_usage WHERE lane='semantic'").get()!.n,0);
});

test('a material revision that changes during processing cannot commit stale output',async t=>{
  const {store,materials,runtime}=fixture(t),first=materials.publish(draft());
  let start!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{start=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  runtime.registry.register({id:'fixture.revision-race',version:'1',lane:'semantic',async process(input){
    start();await gate;return [{kind:'generated',text:input.materials[0]!.text,metadata:{}}];
  }});
  const id=runtime.enqueue([{name:'race',processor:'fixture.revision-race',materialInputs:[{ref:first.ref,offset:0,length:9}]}]).race;
  const running=runtime.tick();await started;
  materials.publish(draft('Generated changed while processing'),{expectedRevision:first.revision});
  release();await running;
  assert.deepEqual(runtime.view().jobs.find(job=>job.id===id)?.outputs,[]);
  assert.equal(store.db.prepare("SELECT count(*) n FROM context_artifacts WHERE json_extract(json,'$.processor')='fixture.revision-race'").get()!.n,0);
});

test('material lineage makes material-only artifacts visible and rejects mixed cross-scope disclosure',async t=>{
  const {store,materials,sources,reader,runtime}=fixture(t);
  for(const sourceId of ['generated-a','generated-b'])sources.register({id:sourceId,name:sourceId,kind:'custom',deviceId:'generated-device',platform:'import'});
  const at='2026-09-24T01:00:00.000Z';
  const a=await sources.upsert('generated-a',{externalId:'a',revision:'1',observedAt:at,title:'Generated A',text:'Generated A content',kind:'message',layer:'snapshot'});
  const b=await sources.upsert('generated-b',{externalId:'b',revision:'1',observedAt:at,title:'Generated B',text:'Generated B content',kind:'message',layer:'snapshot'});
  const materialDraft=(text:string):MaterialDraft=>({id:materialId('generated-b','b'),kind:'mote.note',schemaVersion:1,title:'Generated B',
    origin:{sourceId:'generated-b',externalId:'b',deviceId:'generated-device',firstAt:at,lastAt:at},
    blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:['b']}],
    members:[{id:'b',kind:'capture',ref:`capture:${b.id}`}],coverage:{state:'complete'},
    fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
  const first=materials.publish(materialDraft('Generated B private content'));
  runtime.registry.register({id:'fixture.material-lineage',version:'1',lane:'semantic',async process(input){
    return [{kind:'generated',text:input.materials[0]!.text,metadata:{}}];
  }});
  const materialOnly=runtime.enqueue([{name:'only',processor:'fixture.material-lineage',materialInputs:[{ref:first.ref}]}]).only;
  await runtime.tick();
  const onlyOutputId=runtime.view().jobs.find(job=>job.id===materialOnly)!.outputs[0]!;
  const onlyOutput=store.archive.get(onlyOutputId)!;
  assert.equal(onlyOutput.source,'message');
  assert.equal(onlyOutput.appId,'mote.source.custom');
  assert.equal(reader.artifact(formatArtifactRef(onlyOutput.id,onlyOutput.revision),{sourceId:'generated-b'})?.text,'Generated B private content\n');
  assert.deepEqual(reader.segments({id:onlyOutputId,sourceId:'generated-b'}).items[0]?.members,[b.id]);
  assert.equal(reader.segments({id:onlyOutputId,source:'message',appId:'mote.source.custom'}).items.length,1);
  assert.equal(reader.segments({id:onlyOutputId,source:'generated-b'}).items.length,0);
  assert.equal(reader.segments({id:onlyOutputId,sourceId:'generated-a'}).items.length,0);

  const mixed=runtime.enqueue([{name:'mixed',processor:'fixture.material-lineage',inputs:[a.id],materialInputs:[{ref:first.ref}]}]).mixed;
  await runtime.tick();
  const mixedOutputId=runtime.view().jobs.find(job=>job.id===mixed)!.outputs[0]!;
  assert.deepEqual(new Set(reader.segments({id:mixedOutputId}).items[0]?.members),new Set([a.id,b.id]));
  assert.equal(reader.segments({id:mixedOutputId,sourceId:'generated-a'}).items.length,0);
  assert.equal(reader.segments({id:mixedOutputId,sourceId:'generated-b'}).items.length,0);
  assert.equal(reader.segments({id:mixedOutputId,after:'2026-09-24T01:01:00.000Z'}).items.length,0);
  const mixedOutput=store.archive.get(mixedOutputId)!;
  assert.equal(reader.artifact(formatArtifactRef(mixedOutput.id,mixedOutput.revision),{sourceId:'generated-a'}),undefined);
  const child=store.archive.save('fixture-material-child','fixture-material-child','1',
    {kind:'generated',text:'Generated child from B',metadata:{}},[{id:a.id,fingerprint:store.archive.fingerprint(a.id)!}],
    'fixture.material-child','1','fixture',[a.id],[{id:onlyOutputId,revision:onlyOutput.revision}]);
  assert.deepEqual(new Set(reader.segments({id:child.id}).items[0]?.members),new Set([a.id,b.id]));
  assert.equal(reader.segments({id:child.id,sourceId:'generated-a'}).items.length,0);

  const revised=materials.publish(materialDraft('Generated B revised content'),{expectedRevision:first.revision});
  assert.equal(reader.segments({id:onlyOutputId}).items.length,0);
  assert.equal(reader.segments({id:mixedOutputId}).items.length,0);
  assert.equal(reader.segments({id:child.id}).items.length,0);
  const latest=runtime.enqueue([{name:'latest',processor:'fixture.material-lineage',materialInputs:[{ref:revised.ref}]}]).latest;
  await runtime.tick();
  const latestOutputId=runtime.view().jobs.find(job=>job.id===latest)!.outputs[0]!;
  assert.equal(reader.segments({id:latestOutputId,sourceId:'generated-b'}).items.length,1);
  store.delete(b.id);
  assert.equal(reader.segments({id:latestOutputId}).items.length,0);
});

test('activity material artifacts retain the original activity collection index',async t=>{
  const {store,materials,reader,runtime}=fixture(t),at='2026-09-24T01:00:00.000Z',captureId=randomUUID();
  await store.ingest({id:captureId,deviceId:'generated-device',deviceName:'Generated device',platform:'macos',
    source:'activity',appId:'fixture.activity',appName:'Generated activity',capturedAt:at,durationMs:1000,
    privacy:{excluded:false,redacted:false,mode:'none',collection:'activity'}});
  const record=materials.publish({id:materialId('generated-activity','one'),kind:'mote.state-series',schemaVersion:1,title:'Generated activity',
    origin:{sourceId:'generated-activity',externalId:'one',deviceId:'generated-device',firstAt:at,lastAt:at},
    blocks:[{id:'sample',kind:'text',format:'plain',text:'Generated activity sample',memberIds:['sample']}],
    members:[{id:'sample',kind:'capture',ref:`capture:${captureId}`}],coverage:{state:'complete'},
    fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
  runtime.registry.register({id:'fixture.activity-material',version:'1',lane:'semantic',async process(input){
    return [{kind:'generated',text:input.materials[0]!.text,metadata:{}}];
  }});
  const job=runtime.enqueue([{name:'activity',processor:'fixture.activity-material',materialInputs:[{ref:record.ref}]}]).activity;
  await runtime.tick();
  const outputId=runtime.view().jobs.find(item=>item.id===job)!.outputs[0]!;
  assert.equal(store.archive.get(outputId)?.source,'activity');
  assert.equal(reader.segments({id:outputId,source:'activity',appId:'fixture.activity',collection:'activity'}).items.length,1);
  assert.equal(reader.segments({id:outputId,collection:'content'}).items.length,0);
});

test('activity-only media material is found by activity collection despite media source',async t=>{
  const {store,materials,reader,runtime}=fixture(t),at='2026-09-24T01:00:00.000Z',captureId=randomUUID();
  await store.ingest({id:captureId,deviceId:'generated-device',deviceName:'Generated device',platform:'android',
    source:'media',appId:'fixture.player',appName:'Generated player',capturedAt:at,durationMs:1000,ocrText:'',windowTitle:'',
    privacy:{collection:'activity'},metadata:{version:1,observedAt:at,media:{status:'available',sessions:[{
      sessionId:'generated-session',appId:'fixture.player',appName:'Generated player',playbackState:'playing',
      appVisibility:'background',playbackType:'local'}]}}});
  const record=materials.publish({id:materialId('generated-media','one'),kind:'mote.state-series',schemaVersion:1,title:'Generated playback state',
    origin:{sourceId:'generated-media',externalId:'one',deviceId:'generated-device',firstAt:at,lastAt:at},
    blocks:[{id:'sample',kind:'text',format:'plain',text:'Generated playback state',memberIds:['sample']}],
    members:[{id:'sample',kind:'capture',ref:`capture:${captureId}`}],coverage:{state:'complete'},
    fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
  runtime.registry.register({id:'fixture.media-material',version:'1',lane:'semantic',async process(input){
    return [{kind:'generated',text:input.materials[0]!.text,metadata:{}}];
  }});
  const job=runtime.enqueue([{name:'media',processor:'fixture.media-material',materialInputs:[{ref:record.ref}]}]).media;
  await runtime.tick();
  const outputId=runtime.view().jobs.find(item=>item.id===job)!.outputs[0]!;
  assert.equal(store.archive.get(outputId)?.source,'media');
  assert.equal(reader.segments({id:outputId,source:'media',appId:'fixture.player',collection:'activity'}).items.length,1);
  assert.equal(reader.segments({id:outputId,source:'media',collection:'content'}).items.length,0);
});

test('material-only artifacts with more than 1,000 distinct originals fail closed in model artifact views',async t=>{
  const {store,materials,reader,runtime}=fixture(t);
  const at='2026-09-24T01:00:00.000Z';
  const originals=Array.from({length:2000},(_,index)=>({id:randomUUID(),deviceId:'generated-device',deviceName:'Generated device',
    platform:'import' as const,source:'note' as const,capturedAt:at,durationMs:0,ocrText:`Generated member ${index}`}));
  for(let start=0;start<originals.length;start+=500)await store.ingestBatch(originals.slice(start,start+500));
  const record=materials.publish({id:materialId('generated-many','all'),kind:'mote.note',schemaVersion:1,title:'Generated many',
    origin:{sourceId:'generated-many',externalId:'all',deviceId:'generated-device',firstAt:at,lastAt:at},
    blocks:[{id:'body',kind:'text',format:'plain',text:'Generated summary',memberIds:['member-0']}],
    members:originals.map((capture,index)=>({id:`member-${index}`,kind:'capture',ref:`capture:${capture.id}`})),
    coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
  runtime.registry.register({id:'fixture.large-material',version:'1',lane:'semantic',async process(input){
    return [{kind:'generated',text:input.materials[0]!.text,metadata:{}}];
  }});
  const job=runtime.enqueue([{name:'many',processor:'fixture.large-material',materialInputs:[{ref:record.ref}]}]).many;
  await runtime.tick();
  const outputId=runtime.view().jobs.find(item=>item.id===job)!.outputs[0]!;
  assert.equal(store.archive.get(outputId)?.text,'Generated summary\n');
  assert.equal(reader.materialRead({ref:record.ref,deviceId:'generated-device'}).text,'Generated summary\n');
  assert.equal(reader.segments({id:outputId,deviceId:'generated-device'}).items.length,0);
});
