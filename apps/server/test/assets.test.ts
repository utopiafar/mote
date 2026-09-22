import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {FILE_PART_BYTES} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {ImportUploads} from '../src/import-uploads.js';
import {legacyAsset} from './fixtures/legacy-asset.js';
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),'mote-assets-')),store=new Store(dir,{dataKey:'fc'.repeat(32),contentEncryptionEnabled:true});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}

test('hundreds of long-period observations, import and directory original share one asset without sharing identity or deletion',async t=>{
 const store=fixture(t),archived=new ArchivedFileStore(store),sources=new SourceStore(store),files=new FileStore(store,sources);
 const bytes=await sharp({create:{width:24,height:24,channels:3,background:'#225588'}}).png().toBuffer(),hash=sha256(bytes);
 const inputs=Array.from({length:400},(_,i)=>({id:randomUUID(),deviceId:`fixture-${i%2}`,deviceName:'Generated',platform:'import',capturedAt:new Date(Date.UTC(2024,0,i+1)).toISOString(),source:'screen',imageBase64:bytes.toString('base64'),imageMime:'image/png',ocrText:'Generated observation '+i,durationMs:0}));
 await store.ingestBatch(inputs.slice(0,200));for(const item of inputs.slice(200))await store.ingest(item);
 const imported=archived.put({name:'generated.png',bytes});sources.register({id:'fixture-files',name:'Generated files',kind:'local-files',deviceId:'fixture-files',platform:'macos',retention:'archive'});
 const session=files.begin({sourceId:'fixture-files',previousRevision:null,item:{externalId:'generated.png',revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'file',layer:'original',mimeType:'image/png'},relativePath:'generated.png',sizeBytes:bytes.length,sha256:hash},()=>{});
 files.part(session.uploadId,0,bytes,()=>{});const ack=await files.commit(session.uploadId,()=>{});
 assert.equal(store.db.prepare('SELECT count(*) n FROM assets').get()!.n,1);assert.equal(store.db.prepare('SELECT count(*) n FROM asset_references').get()!.n,402);
 for(const item of inputs)store.delete(item.id);
 assert.deepEqual(archived.read(imported.id),bytes);assert.deepEqual(Buffer.concat([...files.bytes(ack.id)]),bytes);
 archived.removeUnreferenced([imported.id],new Set());assert.deepEqual(Buffer.concat([...files.bytes(ack.id)]),bytes);
 files.forget(ack.id);assert.equal(store.db.prepare('SELECT count(*) n FROM assets').get()!.n,0);
});

test('64 MiB import commit and streaming read are bounded by parts, resume and verify every part',async t=>{
 const store=fixture(t),archived=new ArchivedFileStore(store),uploads=new ImportUploads(store,archived),id=randomUUID();
 const manifest={id,name:'generated-long.bin',sizeBytes:16*FILE_PART_BYTES},expected=createHash('sha256');
 uploads.begin(manifest);for(let part=0;part<16;part++){const bytes=Buffer.alloc(FILE_PART_BYTES,part);expected.update(bytes);uploads.part(id,part,bytes);}
 assert.equal(new ImportUploads(store,archived).begin(manifest).parts.length,16);
 const originalConcat=Buffer.concat;let largest=0;
 Buffer.concat=((list:readonly Uint8Array[],totalLength?:number)=>{largest=Math.max(largest,totalLength??list.reduce((n,b)=>n+b.length,0));return originalConcat(list,totalLength);}) as typeof Buffer.concat;
 let file:ReturnType<ArchivedFileStore['get']>;
 try{file=await uploads.commit(id);}finally{Buffer.concat=originalConcat;}
 assert.ok(largest<=FILE_PART_BYTES+128,`whole-file allocation: ${largest}`);assert.equal(file!.hash,expected.digest('hex'));assert.equal((await uploads.commit(id)).id,file!.id);
 const actual=createHash('sha256');let total=0;for(const part of archived.bytes(file!.id)){assert.ok(part.length<=FILE_PART_BYTES);actual.update(part);total+=part.length;}
 assert.equal(total,manifest.sizeBytes);assert.equal(actual.digest('hex'),file!.hash);
 store.contentEncryption.write(join(store.assets.directory,file!.hash,'15'),Buffer.alloc(FILE_PART_BYTES,66));
 assert.throws(()=>[...store.assets.bytes(file!.hash,15*FILE_PART_BYTES)],/checksum mismatch/);
});

test('durable pins protect uncommitted and streaming assets from another store sweep; released assets can be collected',t=>{
 const store=fixture(t),asset=store.assets.put(Buffer.from('Generated in-flight asset'));
 const peer=new Store(store.directory,{dataKey:'fc'.repeat(32)});t.after(()=>peer.close());
 peer.assets.sweep();assert.deepEqual(peer.assets.read(asset.hash),Buffer.from('Generated in-flight asset'));
 const reader=store.assets.bytes(asset.hash);assert.equal(reader.next().done,false);asset.release();peer.assets.sweep();assert.equal(peer.assets.get(asset.hash).hash,asset.hash);
 reader.return(undefined);peer.assets.sweep();assert.throws(()=>store.assets.get(asset.hash),{statusCode:404});
});

test('legacy bytes migrate with stable original hashes and independent reference identities after restart',t=>{
 const store=fixture(t),archived=new ArchivedFileStore(store),file=archived.put({name:'old.txt',bytes:Buffer.from('Generated legacy original')});
 legacyAsset(store,file.hash,'archive-legacy');assert.equal(store.assets.get(file.hash).format,'archive-legacy');
 const before=archived.get(file.id);store.assets.migrate(file.hash);assert.equal(store.assets.get(file.hash).format,'chunks');assert.deepEqual(archived.get(file.id),before);
 const reopened=new Store(store.directory,{dataKey:'fc'.repeat(32)});t.after(()=>reopened.close());assert.equal(new ArchivedFileStore(reopened).read(file.id).toString(),'Generated legacy original');
 assert.equal(reopened.db.prepare('SELECT count(*) n FROM asset_references WHERE hash=?').get(file.hash)!.n,1);
});
