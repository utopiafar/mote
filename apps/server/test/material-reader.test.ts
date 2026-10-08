import {formatEvidenceRef} from '@mote/shared';
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
import {ServerDiagnostics} from '../src/diagnostics.js';
import {Conversations} from '../src/conversations.js';

test('model material view requires every original member to remain in the selected scope',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-material-reader-'));
  const store=new Store(directory);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const materials=new MaterialStore(store),reader=new EvidenceReader(store,new SourceStore(store),undefined,undefined,undefined,materials);
  const ids=[randomUUID(),randomUUID()];
  for(const [index,id] of ids.entries())await store.ingest({id,deviceId:index?'other-device':'selected-device',deviceName:'Generated device',platform:'import',source:'note',
    capturedAt:`2026-09-24T0${index+1}:00:00.000Z`,durationMs:0,ocrText:`Generated member ${index}`});
  const single:MaterialDraft={id:materialId('generated-source','single'),kind:'mote.note',schemaVersion:1,title:'Generated single',
    origin:{sourceId:'generated-source',externalId:'single',deviceId:'selected-device',firstAt:'2026-09-24T01:00:00.000Z',lastAt:'2026-09-24T01:00:00.000Z'},
    blocks:[{id:'body',kind:'text',format:'plain',text:'Generated member 0',memberIds:['member-0']}],
    members:[{id:'member-0',kind:'capture',ref:`capture:${ids[0]}`}],coverage:{state:'complete'},
    fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}};
  const published=materials.publish(single);
  const selected={deviceId:'selected-device',after:'2026-09-24T00:00:00.000Z',before:'2026-09-24T02:00:00.000Z'};
  assert.deepEqual(reader.materialCatalog(selected).items.map(m=>m.ref),[published.ref]);
  assert.deepEqual(reader.materialCatalog({...selected,sourceId:'generated-source'}).items.map(m=>m.ref),[published.ref]);
  assert.throws(()=>reader.materialRead({...selected,sourceId:'different-source',ref:published.ref}),{statusCode:404});
  const read=reader.materialRead({...selected,ref:published.ref});
  assert.equal(read.text,'Generated member 0\n');
  assert.deepEqual(read.originalRefs,[formatEvidenceRef('capture',ids[0])]);
  assert.equal(reader.materialCatalog({...selected,deviceId:'other-device'}).items.length,0);
  assert.throws(()=>reader.materialRead({...selected,after:'2026-09-24T01:30:00.000Z',ref:published.ref}),{statusCode:404});
  const mixed:MaterialDraft={...single,id:materialId('generated-source','mixed'),origin:{...single.origin,externalId:'mixed',lastAt:'2026-09-24T02:00:00.000Z'},
    blocks:[...single.blocks,{id:'other',kind:'text',format:'plain',text:'Generated member 1',memberIds:['member-1']}],
    members:[...single.members,{id:'member-1',kind:'capture',ref:`capture:${ids[1]}`}],title:'Generated mixed'};
  const mixedPublished=materials.publish(mixed);
  assert.equal(reader.materialCatalog(selected).items.some(m=>m.id===mixed.id),false);
  assert.throws(()=>reader.materialRead({...selected,ref:mixedPublished.ref}),{statusCode:404});
  store.delete(ids[0]);
  assert.equal(reader.materialCatalog({}).items.length,0);
  assert.throws(()=>reader.materialRead({ref:published.ref}),{statusCode:404});
});

test('host material disclosure receipts retain scoped answers during unrelated processing but erase on actual dependency change',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-material-lineage-')),store=new Store(directory),materials=new MaterialStore(store);
  const diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:false});await diagnostics.init();
  t.after(async()=>{await diagnostics.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const sources=new SourceStore(store),reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials),agent=reader.agent({diagnostics});
  const captures=[randomUUID(),randomUUID()],refs=[];
  for(const [index,id] of captures.entries()){
    await store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-09-24T00:00:00.000Z',durationMs:0,ocrText:'Generated source '+index});
    const sourceId='generated-lineage-'+index;
    refs.push(materials.publish({id:materialId(sourceId,'item'),kind:'mote.note',schemaVersion:1,title:'Generated title '+index,
      origin:{sourceId,externalId:'item',deviceId:'generated'},blocks:[{id:'body',kind:'text',format:'plain',text:'Generated body '+index,memberIds:[id]}],
      members:[{id,kind:'capture',ref:`capture:${id}`}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}}).ref);
  }
  assert.equal(Object.hasOwn(reader.materialCatalog({}),'disclosureDependencies'),false,'private receipts are not public catalog fields');
  const catalog=await agent.materialCatalog!({sourceId:'generated-lineage-0'}),receipt=catalog.disclosureDependencies!;
  assert.equal(receipt.complete,true);assert.ok(receipt.ids.includes(captures[0]));assert.equal(receipt.ids.includes(captures[1]),false);
  assert.ok(materials.evidenceIds(refs[0]).every(id=>receipt.ids.includes(id)));
  const page=await agent.materialRead!({ref:refs[0],length:4});assert.deepEqual(page.disclosureDependencies,receipt);
  const conversations=new Conversations(store),saved=conversations.append(undefined,{question:'Generated metadata-only query'},
    {answer:'Generated title',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:receipt});
  store.invalidateMemoryEvidence(materials.evidenceIds(refs[1])[0]);
  assert.equal(conversations.get(saved.conversationId).turns[0].evidenceDeleted,undefined);
  store.delete(captures[0]);
  assert.equal(conversations.get(saved.conversationId).turns[0].evidenceDeleted,true);
});

test('oversized material metadata lineage retains a bounded conservative receipt',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-material-lineage-bound-')),store=new Store(directory),materials=new MaterialStore(store);
  const diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:false});await diagnostics.init();
  t.after(async()=>{await diagnostics.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const id=randomUUID();await store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-09-24T00:00:00.000Z',durationMs:0,ocrText:'Generated large original'});
  const material=materials.publish({id:materialId('generated-bound','item'),kind:'mote.note',schemaVersion:1,title:'Generated large material',origin:{sourceId:'generated-bound',externalId:'item',deviceId:'generated'},
    blocks:Array.from({length:1001},(_,i)=>({id:'body-'+i,kind:'text' as const,format:'plain',text:'Generated '+i,memberIds:[id]})),
    members:[{id,kind:'capture',ref:`capture:${id}`}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
  const agent=new EvidenceReader(store,new SourceStore(store),undefined,undefined,undefined,materials).agent({diagnostics});
  const page=await agent.materialCatalog!({});assert.equal(page.items[0].ref,material.ref);
  assert.equal(page.disclosureDependencies!.complete,false);assert.equal(page.disclosureDependencies!.ids.length,1000);
});
