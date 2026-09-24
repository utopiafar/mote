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
  assert.deepEqual(read.originalRefs,[ids[0]]);
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
