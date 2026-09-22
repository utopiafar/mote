import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FILE_PART_BYTES} from '@mote/shared';
import {Store,StoreError,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),'mote-commit-worker-')),options={maxStorageBytes:200*1024*1024},store=new Store(dir,options),sources=new SourceStore(store),files=new FileStore(store,sources);sources.register({id:'generated',name:'Generated files',kind:'local-files',deviceId:'generated',platform:'android',retention:'archive'});t.after(async()=>{await files.close();store.close();rmSync(dir,{recursive:true,force:true});});return {store,sources,files,options};}
function upload(files:FileStore,bytes:Buffer,externalId='generated',previousRevision:string|null=null){const input={sourceId:'generated',previousRevision,item:{externalId,revision:previousRevision?'v2':'v1',observedAt:'2026-09-01T08:00:00Z',title:'Generated binary',kind:'file',layer:'original',text:'',mimeType:'application/octet-stream',deleted:false},relativePath:externalId+'.bin',sizeBytes:bytes.length,sha256:sha256(bytes)},session=files.begin(input,()=>{});for(let offset=0;offset<bytes.length;offset+=FILE_PART_BYTES)files.part(session.uploadId,offset/FILE_PART_BYTES,bytes.subarray(offset,offset+FILE_PART_BYTES),()=>{});return session.uploadId;}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
const clean=(store:Store)=>{assert.equal(store.db.prepare('SELECT count(*) n FROM asset_pins').get()!.n,0);assert.equal(readdirSync(store.assets.directory).filter(name=>name.endsWith('.tmp')).length,0);};

test('commit preparation yields, cancellation preserves parts for retry and never leaves a pin or ACK',async t=>{
 const {store,files}=fixture(t),bytes=Buffer.alloc(12*1024*1024,41),id=upload(files,bytes),controller=new AbortController();
 const pending=files.commit(id,()=>{},controller.signal);await turn();assert.equal(store.db.isTransaction,false);controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(files.upload(id,()=>{}).ack,null);assert.equal(files.upload(id,()=>{}).parts.length,3);clean(store);
 const ack=await files.commit(id,()=>{});assert.equal(ack.sha256,sha256(bytes));assert.deepEqual(Buffer.concat([...files.bytes(ack.id)]),bytes);clean(store);
});

test('commit rechecks authorization and forgotten identity after worker preparation',async t=>{
 const {store,files}=fixture(t),bytes=Buffer.alloc(8*1024*1024,43),id=upload(files,bytes);let revoked=false;
 const pending=files.commit(id,()=>{if(revoked)throw new StoreError('Generated revoked',403);});await turn();revoked=true;await assert.rejects(pending,{statusCode:403});assert.equal(files.upload(id,()=>{}).ack,null);assert.equal(files.list().items.length,0);clean(store);
 const first=await files.commit(id,()=>{}),second=upload(files,Buffer.alloc(8*1024*1024,44),'generated','v1');
 const updating=files.commit(second,()=>{});await turn();files.forget(first.id);await assert.rejects(updating,{statusCode:410});assert.equal(files.list().items.length,0);assert.equal(store.db.prepare('SELECT ack FROM file_uploads WHERE id=?').get(second)!.ack,null);clean(store);
});

test('corrupt upload parts, failed storage reservation and policy changes cannot publish an original',async t=>{
 const {store,files,options}=fixture(t),bytes=Buffer.alloc(FILE_PART_BYTES,47),id=upload(files,bytes);
 writeFileSync(join(files.uploads,id,'0.plain'),Buffer.alloc(FILE_PART_BYTES,48));await assert.rejects(files.commit(id,()=>{}),{statusCode:409});clean(store);assert.equal(files.upload(id,()=>{}).ack,null);
 writeFileSync(join(files.uploads,id,'0.plain'),bytes);options.maxStorageBytes=store.logicalBytes()+1;
 await assert.rejects(files.commit(id,()=>{}),{statusCode:507});assert.equal(files.list().items.length,0);clean(store);
 options.maxStorageBytes=200*1024*1024;const pending=files.commit(id,()=>{});await turn();store.contentEncryption.setEnabled(true);await assert.rejects(pending,{statusCode:409});clean(store);
 const ack=await files.commit(id,()=>{});assert.deepEqual(Buffer.concat([...files.bytes(ack.id)]),bytes);clean(store);
});

test('closing the file subsystem drains cancellable workers without publishing late results',async t=>{
 const {store,files}=fixture(t),id=upload(files,Buffer.alloc(8*1024*1024,49));const pending=files.commit(id,()=>{});await turn();const rejected=assert.rejects(pending,{name:'AbortError'});await files.close();await rejected;assert.equal(files.list().items.length,0);clean(store);
});

test('simultaneous originals with one hash serialize publication and keep independent identities',async t=>{
 const {store,files}=fixture(t),bytes=Buffer.alloc(FILE_PART_BYTES,51),a=upload(files,bytes,'generated-a'),b=upload(files,bytes,'generated-b');
 const [first,second]=await Promise.all([files.commit(a,()=>{}),files.commit(b,()=>{})]);assert.notEqual(first.id,second.id);assert.equal(first.sha256,second.sha256);assert.equal(store.db.prepare('SELECT count(*) n FROM assets').get()!.n,1);clean(store);
});
