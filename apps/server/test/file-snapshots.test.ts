import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FILE_PART_BYTES,type FileRevision} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {FileProcessing} from '../src/file-processing.js';
import {FileEvidenceRequests} from '../src/file-evidence.js';
import {fixtureFilePolicy} from './fixtures/file-policy.js';
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),'mote-snapshot-fixture-')),store=new Store(dir,{maxStorageBytes:100*1024*1024}),sources=new SourceStore(store),files=new FileStore(store,sources);sources.register({id:'fixture',name:'Generated',kind:'local-files',deviceId:'fixture',platform:'macos',retention:'snapshot'});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,sources,files};}
async function upload(files:FileStore,bytes:Buffer,allowRead=false,mimeType='text/plain'){
 const hash=sha256(bytes),m:FileRevision={sourceId:'fixture',previousRevision:null,sizeBytes:bytes.length,sha256:hash,relativePath:'generated.txt',item:{externalId:'generated-file',revision:hash,observedAt:'2026-10-01T00:00:00Z',title:'Generated',kind:'file',layer:'snapshot',text:'',mimeType,deleted:false,document:{fileIndex:{version:1,fileId:'generated-file',contentVersion:hash,mode:'index',coverage:'none',parser:'central-pending',status:'pending',totalCharacters:0,offset:0,length:0,maxIndexCharacters:8000,allowRead}}}};
 const s=files.begin(m,()=>{});for(let part=0;part<Math.ceil(bytes.length/FILE_PART_BYTES);part++)files.part(s.uploadId,part,bytes.subarray(part*FILE_PART_BYTES,(part+1)*FILE_PART_BYTES),()=>{});return files.commit(s.uploadId,()=>{});
}
test('central snapshot extraction limits indexing, removes raw bytes, and never grants original access',async t=>{
 const {files,store}=fixture(t),bytes=Buffer.from('Generated '+'x'.repeat(10000)),ack=await upload(files,bytes),processing=new FileProcessing(files);t.after(()=>processing.close());
 assert.equal(files.detail(ack.id).hasOriginal,false);assert.throws(()=>[...files.bytes(ack.id)],{statusCode:404});assert.deepEqual(Buffer.concat([...files.processingBytes(ack.id)]),bytes);
 await processing.tick();assert.equal(files.detail(ack.id).job.state,'succeeded');assert.ok(files.chunks(ack.id).reduce((n,c)=>n+c.ocrText.length,0)<=8000);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_inputs').get()!.n,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_text').get()!.n,0);assert.throws(()=>[...files.processingBytes(ack.id)],{statusCode:410});assert.throws(()=>store.assets.get(sha256(bytes)),{statusCode:404});
});
test('explicit allowRead permits central text ranges and revision/source fences revoke the grant',async t=>{
 const {files,store,sources}=fixture(t),text='Generated '+'x'.repeat(9000)+'TAIL EVIDENCE',ack=await upload(files,Buffer.from(text),true),processing=new FileProcessing(files);t.after(()=>processing.close());await processing.tick();const requests=new FileEvidenceRequests(sources);
 assert.equal(files.search({query:'TAIL'}).length,0);const full=store.assets.read(String(store.db.prepare('SELECT object_hash FROM file_snapshot_text WHERE capture_id=?').get(ack.id)!.object_hash)).toString();const result:any=await requests.read(ack.id,full.indexOf('TAIL'),13);assert.equal(result.status,'ready');assert.equal(result.record.ocrText,'TAIL EVIDENCE');assert.throws(()=>[...files.bytes(ack.id)],{statusCode:404});sources.update('fixture',{enabled:false});await assert.rejects(requests.read(ack.id,0,10),{statusCode:409});files.sweep();assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_text').get()!.n,0);
});
test('generated audio is interpreted by the central provider, and cancellation destroys transient input',async t=>{
 const {files,store}=fixture(t),ack=await upload(files,Buffer.from('generated audio bytes'),false,'audio/wav');let calls=0;const processing=new FileProcessing(files,{transcribe:async()=>{calls++;return {durationMs:1000,segments:[{startMs:0,endMs:1000,text:'Generated central transcript'}]};}});t.after(()=>processing.close());await processing.runtime.ready;processing.update({revision:processing.view().revision,settings:{...processing.view().settings,audioProcessor:'audio.http'},policy:fixtureFilePolicy({...processing.view().settings,audioProcessor:'audio.http'},processing.runtime.registry)});await processing.tick();assert.equal(calls,1);assert.equal(files.chunks(ack.id)[0].ocrText,'Generated central transcript');assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_inputs').get()!.n,0);
});
test('cancelled snapshot input is removed and never interpreted after cancellation',async t=>{
 const {files,store}=fixture(t),bytes=Buffer.from('Generated cancelled input'),ack=await upload(files,bytes),processing=new FileProcessing(files);t.after(()=>processing.close());processing.cancel(ack.id);await processing.tick();assert.equal(files.detail(ack.id).job.state,'cancelled');assert.equal(files.chunks(ack.id).length,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_inputs').get()!.n,0);assert.throws(()=>store.assets.get(sha256(bytes)),{statusCode:404});
});
test('source revocation while central interpretation is in flight cannot publish or retain temporary input',async t=>{
 const {files,store,sources}=fixture(t),bytes=Buffer.from('Generated revocation audio'),ack=await upload(files,bytes,true,'audio/wav');let release!:(value:any)=>void,started!:()=>void;const begun=new Promise<void>(resolve=>started=resolve);const processing=new FileProcessing(files,{transcribe:async()=>{started();return new Promise(resolve=>release=resolve);}});t.after(()=>processing.close());await processing.runtime.ready;processing.update({revision:processing.view().revision,settings:{...processing.view().settings,audioProcessor:'audio.http'},policy:fixtureFilePolicy({...processing.view().settings,audioProcessor:'audio.http'},processing.runtime.registry)});const running=processing.tick();await begun;sources.update('fixture',{enabled:false});release({durationMs:1000,segments:[{startMs:0,endMs:1000,text:'Must never publish'}]});await running;files.sweep();assert.equal(files.chunks(ack.id).length,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_inputs').get()!.n,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_text').get()!.n,0);assert.throws(()=>store.assets.get(sha256(bytes)),{statusCode:404});
});
