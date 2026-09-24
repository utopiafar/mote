import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sourceItemSchema} from '@mote/shared';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {CaptureRawReader,captureCollectionRef,captureRawRef} from '../src/capture-raw-reader.js';
import {MAX_RAW_PAGE_ITEMS,MAX_RAW_READ_BYTES} from '../src/raw-reader.js';

const item=(externalId:string,revision='1',text='Generated source content.',observedAt='2026-09-24T01:00:00.000Z',kind:'message'|'file'='message')=>
  sourceItemSchema.parse({externalId,revision,observedAt,kind,layer:'original',text});

function fixture(t:import('node:test').TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-capture-raw-')),store=new Store(directory),sources=new SourceStore(store);
  sources.register({id:'generated-source',name:'Generated Source',kind:'upload',deviceId:'generated-device',platform:'import',retention:'archive',enabled:true});
  let sourceAllowed=true,kindAllowed=true;const groups=new Set(['event-1','event-2']);
  const reader=new CaptureRawReader(store,{
    mayReadSource:id=>sourceAllowed&&id==='generated-source',
    mayReadGroup:(id,externalId)=>id==='generated-source'&&groups.has(externalId),
    mayListKind:(id,kind)=>kindAllowed&&id==='generated-source'&&kind==='message',
  });
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,sources,reader,groups,denySource:()=>{sourceAllowed=false;},allowSource:()=>{sourceAllowed=true;},denyKind:()=>{kindAllowed=false;}};
}

test('current SourceItem refs resolve exact groups, page by kind and read at most 64 KiB',async t=>{
  const {sources,reader,groups}=fixture(t);
  const first=await sources.upsert('generated-source',item('event-1','1','Generated text '.repeat(6000)));
  await sources.upsert('generated-source',item('event-2'));
  const file=await sources.upsert('generated-source',item('other-file','1','Generated file.',undefined,'file'));
  groups.add('other-file');
  const collectionRef=captureCollectionRef('generated-source','message');
  const page1=await reader.page({collectionRef,limit:1});assert.equal(page1.status,'available');if(page1.status!=='available')return;
  assert.equal(page1.total,2);assert.equal(page1.items[0].ref,captureRawRef(first.id));assert.ok(page1.nextCursor);
  const page2=await reader.page({collectionRef,limit:1,cursor:page1.nextCursor!});assert.equal(page2.status,'available');
  if(page2.status==='available'){assert.equal(page2.items.length,1);assert.equal(page2.nextCursor,null);}
  const ref=reader.refForItem('generated-source','event-1');assert.equal(ref,captureRawRef(first.id));
  assert.equal(reader.refForItem('generated-source','other-file'),captureRawRef(file.id));
  assert.equal((await reader.page({collectionRef:captureCollectionRef('generated-source','file')})).status,'unavailable');
  const chunks:Uint8Array[]=[];let offset=0;
  for(;;){const part=await reader.read(ref!,{offset,length:MAX_RAW_READ_BYTES});assert.equal(part.status,'available');if(part.status!=='available')return;
    assert.ok(part.bytes.length<=MAX_RAW_READ_BYTES);assert.equal(part.bytes.buffer.byteLength,part.bytes.length);chunks.push(part.bytes);
    if(part.nextOffset===null)break;offset=part.nextOffset;
  }
  const record=JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(record.captureId,first.id);assert.equal(record.sourceId,'generated-source');assert.equal(record.externalId,'event-1');
  assert.equal(record.revision,'1');assert.equal(record.current,true);assert.equal(record.text,'Generated text '.repeat(6000));
  const next=await sources.upsert('generated-source',item('event-1','2','Generated replacement.','2026-09-24T02:00:00.000Z'));
  assert.equal((await reader.read(ref!,{offset:0,length:100})).status,'unavailable');
  assert.equal((await reader.page({collectionRef,limit:1,cursor:page1.nextCursor!})).status,'stale_cursor');
  assert.equal(reader.refForItem('generated-source','event-1'),captureRawRef(next.id));
});

test('capture reads fail closed on group and source revocation, deletion and invalid ranges',async t=>{
  const {store,sources,reader,groups,denySource,allowSource,denyKind}=fixture(t);
  const first=await sources.upsert('generated-source',item('event-1'));
  const second=await sources.upsert('generated-source',item('event-2'));
  const ref=captureRawRef(first.id),collectionRef=captureCollectionRef('generated-source','message');
  assert.equal((await reader.read('raw-capture:v1:bad',{offset:0,length:10})).status,'missing');
  assert.equal((await reader.read(captureRawRef('00000000-0000-4000-8000-000000000000'),{offset:0,length:10})).status,'missing');
  assert.deepEqual(await reader.read(ref,{offset:0,length:MAX_RAW_READ_BYTES+1}),{status:'limit_exceeded',maxBytes:MAX_RAW_READ_BYTES});
  assert.equal((await reader.read(ref,{offset:-1,length:10})).status,'invalid_range');
  assert.equal((await reader.read(ref,{offset:1_000_000,length:10})).status,'invalid_range');
  assert.deepEqual(await reader.page({collectionRef,limit:MAX_RAW_PAGE_ITEMS+1}),{status:'limit_exceeded',maxItems:MAX_RAW_PAGE_ITEMS});
  assert.equal((await reader.page({collectionRef,cursor:'bad'})).status,'invalid_cursor');
  groups.delete('event-1');assert.equal(reader.refForItem('generated-source','event-1'),undefined);
  assert.equal((await reader.read(ref,{offset:0,length:10})).status,'unavailable');
  const filtered=await reader.page({collectionRef});assert.equal(filtered.status,'available');
  if(filtered.status==='available')assert.deepEqual(filtered.items.map(entry=>entry.ref),[captureRawRef(second.id)]);
  groups.add('event-1');denySource();assert.equal((await reader.read(ref,{offset:0,length:10})).status,'unavailable');
  assert.equal((await reader.page({collectionRef})).status,'unavailable');allowSource();denyKind();
  assert.equal((await reader.page({collectionRef})).status,'unavailable');
  await sources.upsert('generated-source',sourceItemSchema.parse({externalId:'event-1',revision:'2',observedAt:'2026-09-24T02:00:00.000Z',kind:'message',layer:'original',deleted:true}));
  assert.equal(reader.refForItem('generated-source','event-1'),undefined);
  assert.equal((await reader.read(ref,{offset:0,length:10})).status,'unavailable');
  store.delete(second.id);assert.equal((await reader.read(captureRawRef(second.id),{offset:0,length:10})).status,'unavailable');
});

test('a capture payload changed outside its pinned SourceItem revision is unavailable',async t=>{
  const {store,sources,reader}=fixture(t);
  const accepted=await sources.upsert('generated-source',item('event-1'));
  const ref=captureRawRef(accepted.id);
  assert.equal((await reader.read(ref,{offset:0,length:100})).status,'available');
  const row=store.db.prepare('SELECT json FROM captures WHERE id=?').get(accepted.id) as {json:string};
  store.db.prepare('UPDATE captures SET json=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.json),ocrText:'Changed without a source revision'}),accepted.id);
  assert.equal(reader.refForItem('generated-source','event-1'),undefined);
  assert.equal((await reader.read(ref,{offset:0,length:100})).status,'unavailable');
});
