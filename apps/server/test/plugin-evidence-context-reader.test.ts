import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {formatEvidenceRef} from '@mote/shared';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {ServerDiagnostics} from '../src/diagnostics.js';
import type {MemoryBindings} from '../src/memory-bindings.js';
import {createEvidenceContextReader} from '../src/plugins/evidence-context-reader.js';

async function fixture(t:test.TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-evidence-context-reader-')),store=new Store(directory),sources=new SourceStore(store),materials=new MaterialStore(store);
  const diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:false});await diagnostics.init();
  t.after(async()=>{await diagnostics.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const captureId=randomUUID();
  await store.ingest({id:captureId,deviceId:'generated-device',deviceName:'Generated device',platform:'import',source:'note',capturedAt:'2026-09-24T01:00:00.000Z',durationMs:0,ocrText:'Generated member 0'});
  const draft:MaterialDraft={id:materialId('generated-source','item'),kind:'mote.note',schemaVersion:1,title:'Generated material',
    origin:{sourceId:'generated-source',externalId:'item',deviceId:'generated-device',firstAt:'2026-09-24T01:00:00.000Z',lastAt:'2026-09-24T01:00:00.000Z'},
    blocks:[{id:'body',kind:'text',format:'plain',text:'Generated member 0',memberIds:['member-0']}],
    members:[{id:'member-0',kind:'capture',ref:`capture:${captureId}`}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}};
  const published=materials.publish(draft);
  return {directory,store,sources,materials,diagnostics,captureId,draft,published};
}

test('the unique reader serves a real Material through agent view and read ports',async t=>{
  const {store,sources,materials,diagnostics,captureId,published}=await fixture(t);
  const service=createEvidenceContextReader({store,sources,materials});
  t.after(()=>service.dispose());
  const view=service.agent({diagnostics});
  const page=await view.materialRead!({ref:published.ref,length:9});
  assert.match(page.text,/^Generated/);
  assert.ok(page.originalRefs.includes(formatEvidenceRef('capture',captureId)));
  assert.equal(page.disclosureDependencies?.complete,true);
  const portPage=service.ports.materialRead.materialRead({ref:published.ref});
  assert.equal(portPage.text,'Generated member 0\n');
  assert.deepEqual(portPage.originalRefs,[formatEvidenceRef('capture',captureId)]);
  assert.equal(service.ports.materialRead.materialCatalog({}).items.length,1);
  assert.equal(typeof service.assembly.reader.fileCatalog,'function');
  const trees=await service.ports.contextTreesRead.catalog();
  assert.ok(trees.items.some(tree=>tree.id==='topics'));
});

test('agent material reads follow revision changes and source deletion',async t=>{
  const {store,sources,materials,diagnostics,captureId,draft,published}=await fixture(t);
  const service=createEvidenceContextReader({store,sources,materials});
  t.after(()=>service.dispose());
  const view=service.agent({diagnostics});
  const revised=materials.publish({...draft,title:'Generated material revised',blocks:[{id:'body',kind:'text',format:'plain',text:'Generated revised text',memberIds:['member-0']}]},{expectedRevision:published.revision});
  assert.notEqual(revised.ref,published.ref);
  await assert.rejects(view.materialRead!({ref:published.ref}),{statusCode:404});
  const current=await view.materialRead!({ref:revised.ref});
  assert.match(current.text,/Generated revised text/);
  store.delete(captureId);
  await assert.rejects(view.materialRead!({ref:revised.ref}),{statusCode:404});
});

test('dispose revokes views and ports, releases retained snapshots, and leaves borrowed repositories open',async t=>{
  const {store,sources,materials,diagnostics,published}=await fixture(t);
  const released:{count:number}[]=[];
  const binding={
    retainSnapshot:()=>{const state={count:0};released.push(state);return {binding:{namespace:{ownerId:'mote-owner',instanceId:'generated-instance',bindingRevision:1}},catalog:{generated:{memoryId:'generated'}},recordDigests:{},metadata:{},lineage:{},records:undefined,release:()=>{state.count++;}};},
  } as unknown as MemoryBindings;
  const service=createEvidenceContextReader({store,sources,materials,memoryBindings:binding});
  const view=service.agent({diagnostics}),snapshot=service.ports.memorySnapshots.retainMemorySnapshot({}),retain=service.ports.memorySnapshots.memoryBindings!.retainSnapshot;
  assert.ok(snapshot);
  assert.equal(released[0]!.count,0);
  const owned=retain();owned.release();
  assert.equal(released[1]!.count,1,'a normal caller release removes its tracking');
  retain();
  assert.equal(released[2]!.count,0);
  service.dispose();
  assert.equal(released[0]!.count,1);
  assert.equal(released[1]!.count,1,'dispose does not double-release a caller-released snapshot');
  assert.equal(released[2]!.count,1,'dispose releases an outstanding capability snapshot');
  assert.throws(()=>retain(),{statusCode:503});
  assert.throws(()=>service.ports.memorySnapshots.memoryBindings!.retainSnapshot(),{statusCode:503});
  assert.equal(service.disposed,true);
  assert.equal(service.assembly.reader.disposed,true);
  assert.equal(released[0]!.count,1);
  service.dispose();
  assert.equal(released[0]!.count,1);
  assert.throws(()=>service.agent({diagnostics}),{statusCode:503});
  assert.throws(()=>service.ports.materialRead.materialRead({ref:published.ref}),{statusCode:503});
  assert.throws(()=>service.ports.contextTreesRead.catalog(),{statusCode:503});
  assert.throws(()=>view.materialRead!({ref:published.ref}),{statusCode:503});
  assert.equal(materials.get(published.ref)?.ref,published.ref,'borrowed MaterialStore stays open');
  const reopened=createEvidenceContextReader({store,sources,materials});
  t.after(()=>reopened.dispose());
  assert.equal(reopened.ports.materialRead.materialRead({ref:published.ref}).text,'Generated member 0\n');
});

test('dispose rejects a held agent read after its await boundary',async t=>{
  const {store,sources,materials,diagnostics}=await fixture(t);
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  const binding={
    retainSnapshot:()=>({binding:{namespace:{ownerId:'mote-owner',instanceId:'generated-instance',bindingRevision:1}},catalog:{generated:{memoryId:'generated'}},recordDigests:{},metadata:{},lineage:{},records:undefined,release:()=>{}}),
    provider:()=>({search:async()=>{entered();await gate;return [];}}),
  } as unknown as MemoryBindings;
  const service=createEvidenceContextReader({store,sources,materials,memoryBindings:binding});
  t.after(()=>service.dispose());
  const reading=service.agent({diagnostics}).memories!({query:'generated'});
  await started;
  service.dispose();
  release();
  await assert.rejects(reading,{statusCode:503});
});

test('a mismatched borrowed repository is rejected instead of falling back to a second reader',async t=>{
  const {store,sources,materials}=await fixture(t);
  const otherDirectory=mkdtempSync(join(tmpdir(),'mote-evidence-context-reader-other-')),other=new Store(otherDirectory);
  t.after(()=>{other.close();rmSync(otherDirectory,{recursive:true,force:true});});
  assert.throws(()=>createEvidenceContextReader({store,sources:new SourceStore(other),materials}),{statusCode:503});
  assert.throws(()=>createEvidenceContextReader({store,sources,materials:new MaterialStore(other)}),{statusCode:503});
});
