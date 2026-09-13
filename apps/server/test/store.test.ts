import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Store } from '../src/store.js';

async function fixture(overrides:Record<string,unknown>={}) {
  const image=await sharp({create:{width:60,height:30,channels:3,background:'#83a69b'}}).png().toBuffer();
  return {id:randomUUID(),deviceId:'fixture-device',deviceName:'合成测试设备',platform:'macos',capturedAt:'2026-09-12T01:00:00.000Z',durationMs:15000,appName:'合成笔记',appId:'fixture.notes',ocrText:'Mote 的资料保存在独立中央节点。Synthetic evidence, not personal data.',source:'screen',privacy:{excluded:false,redacted:false,mode:'local'},imageBase64:image.toString('base64'),imageMime:'image/png',...overrides};
}
function vault(t:{after(fn:()=>void):void},options:ConstructorParameters<typeof Store>[1]={}) {
  const directory=mkdtempSync(join(tmpdir(),'mote-store-test-'));const store=new Store(directory,options);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return store;
}
test('retries are idempotent, images deduplicate independently, conflicting event IDs reject',async t=>{
  const store=vault(t);const first=await fixture();
  assert.equal((await store.ingest(first)).duplicate,false);
  assert.equal((await store.ingest(first)).duplicate,true);
  await assert.rejects(store.ingest({...first,ocrText:'conflicting content'}),/different content/);
  await store.ingest({...first,id:randomUUID(),capturedAt:'2026-09-12T01:00:15.000Z'});
  const stats=store.stats() as {captures:number;blobs:number};assert.equal(stats.captures,2);assert.equal(stats.blobs,1);
  assert.equal(store.activity({}).totalDurationMs,30000);
});
test('same-time pagination has no dropped records and Unicode retrieval works',async t=>{
  const store=vault(t);for(let i=0;i<5;i++)await store.ingest(await fixture());
  const ids=new Set<string>();let cursor:string|null=null;
  do {const page=store.list({limit:2,...(cursor?{cursor}:{})});for(const item of page.items){assert.ok(!ids.has(item.id));ids.add(item.id);}cursor=page.nextCursor;}while(cursor);
  assert.equal(ids.size,5);assert.equal(store.search({query:'资料'}).length,5);assert.equal(store.search({query:'Synthetic'}).length,5);
  assert.equal(store.search({query:"' OR 1=1 --"}).length,0);
});
test('privacy-excluded, oversized/mismatched image and invalid events fail before writing',async t=>{
  const store=vault(t);const f=await fixture();
  await assert.rejects(store.ingest({...f,privacy:{excluded:true,redacted:false,mode:'local'}}));
  await assert.rejects(store.ingest({...f,imageMime:'image/jpeg'}),/MIME/);
  await assert.rejects(store.ingest({...f,imageBase64:'<script>alert(1)</script>'}),/base64/);
  await assert.rejects(store.ingest({...f,durationMs:-5}));
  assert.equal((store.stats() as {captures:number}).captures,0);assert.equal(readdirSync(store.blobsDir).length,0);
});
test('bounded capacity rejects new data but still acknowledges already saved retries',async t=>{
  const sample=await fixture();const store=vault(t,{maxStorageBytes:1500});await store.ingest(sample);
  for(let i=0;i<4;i++){try{await store.ingest({...sample,id:randomUUID()});}catch{break;}}
  await assert.rejects(store.ingest({...sample,id:randomUUID(),ocrText:'x'.repeat(2000)}),/storage limit/);
  assert.equal((await store.ingest(sample)).duplicate,true);
});
test('encrypted image blobs round trip; export contains plaintext evidence but never secrets',async t=>{
  const key='a3'.repeat(32);const store=vault(t,{dataKey:key});const f=await fixture();const saved=await store.ingest(f);
  const physical=readFileSync(join(store.blobsDir,saved.blobHash!));assert.equal(physical.subarray(0,5).toString(),'MOTE1');
  assert.equal(store.image(f.id).bytes.toString('base64'),f.imageBase64);
  const archive=store.exportArchive(1000000);assert.equal(archive.captures[0].imageBase64,f.imageBase64);assert.ok(!JSON.stringify(archive).includes(key));
  assert.throws(()=>new Store(store.directory,{dataKey:'b4'.repeat(32)}),/key mismatch/);
});
test('archive import validates checksums and rolls back all entries on a late conflict',async t=>{
  const source=vault(t);const target=vault(t);const f=await fixture();await source.ingest(f);
  const archive=source.exportArchive(1000000);
  assert.deepEqual(await target.importArchive(archive),{imported:1,duplicates:0});
  assert.deepEqual(await target.importArchive(archive),{imported:0,duplicates:1});
  await assert.rejects(target.importArchive({...archive,captures:[{...archive.captures[0],blobHash:'invalid'}]}),/checksum/);
  await assert.rejects(target.importArchive({version:1,captures:[{...f,id:randomUUID()}, {...f,ocrText:'conflict'}]}),/different content/);
  assert.equal((target.stats() as {captures:number}).captures,1);
});
test('deletion respects shared blobs and invalidates derived insights',async t=>{
  const store=vault(t);const a=await fixture(),b={...a,id:randomUUID()};await store.ingest(a);await store.ingest(b);
  store.saveInsight({answer:'fixture'},randomUUID());store.delete(a.id);
  assert.equal((store.stats() as {blobs:number}).blobs,1);assert.equal(store.insights().length,0);
  store.delete(b.id);assert.equal((store.stats() as {blobs:number}).blobs,0);assert.equal(readdirSync(store.blobsDir).length,0);assert.equal(store.search({query:'Mote'}).length,0);
});
test('sampled intervals clip to range, do not overlap within a device, and keep device time separate',async t=>{
  const store=vault(t);
  await store.ingest(await fixture({capturedAt:'2026-09-12T01:00:00.000Z',durationMs:15000}));
  await store.ingest(await fixture({capturedAt:'2026-09-12T01:00:05.000Z',durationMs:15000}));
  await store.ingest(await fixture({capturedAt:'2026-09-12T01:00:05.000Z',durationMs:15000,deviceId:'other'}));
  assert.equal(store.activity({}).totalDurationMs,35000);
  assert.equal(store.activity({after:'2026-09-12T00:59:55Z',before:'2026-09-12T01:00:02Z'}).totalDurationMs,14000);
});
test('out-of-order arrivals preserve event and arrival times and survive reopen',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-reopen-test-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const store=new Store(directory);const f=await fixture();await store.ingest(f);store.close();
  const reopened=new Store(directory);try {const item=reopened.list().items[0];assert.equal(item.capturedAt,f.capturedAt);assert.ok(item.receivedAt>f.capturedAt);assert.equal(reopened.image(f.id).bytes.toString('base64'),f.imageBase64);}finally{reopened.close();}
});
test('export capacity counts each expanded image reference before allocating the archive',async t=>{
  const store=vault(t);const f=await fixture();
  for(let i=0;i<20;i++)await store.ingest({...f,id:randomUUID()});
  assert.equal(store.stats().blobs,1);
  assert.throws(()=>store.exportArchive(1000),/too large/);
});
test('incremental arrival cursor includes late data and deletion tombstones',async t=>{
  const store=vault(t);const newer=await fixture(),older=await fixture({capturedAt:'2026-09-01T01:00:00.000Z'});
  await store.ingest(newer);const initial=store.updates(0);await store.ingest(older);
  const late=store.updates(initial.nextCursor);assert.equal(late.items[0].id,older.id);assert.equal(late.items[0].record?.capturedAt,older.capturedAt);
  store.delete(newer.id);assert.equal(store.updates(late.nextCursor).items[0].operation,'delete');
});
