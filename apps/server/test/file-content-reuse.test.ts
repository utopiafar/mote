import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FILE_PART_BYTES,type FileRevision} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {sha256} from '../src/store.js';

async function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-file-reuse-')),token='generated-file-reuse-owner';
 const config:Config={dataDir:directory,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',contentEncryptionEnabled:true,dataKey:'53'.repeat(32)};
 const start=()=>buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model expected');},close:async()=>{}}});
 let node=await start();
 await node.app.ready();
 for(const [id,deviceId,retention] of [['visible','device-a','archive'],['visible-other','device-a','archive'],['private','device-b','archive'],['snapshot','device-a','snapshot']] as const)
  node.sources.register({id,name:'Generated '+id,kind:'local-files',deviceId,platform:'android',retention});
 const {invitation}=node.connections.invite({serverUrl:'http://127.0.0.1:57569',label:'Generated collector',deviceId:'device-a'},'collector');
 const collector=await node.connections.redeem({code:invitation.code,deviceId:'device-a',deviceName:'Generated device',platform:'android'});
 const ownerHeaders={authorization:'Bearer '+token,'x-mote-ingress-version':'2'},collectorHeaders={authorization:'Bearer '+collector.token,'x-mote-ingress-version':'2'};
 const request=(method:'GET'|'POST'|'PUT',url:string,payload?:unknown,headers=ownerHeaders)=>node.app.inject({method,url,headers,payload:payload as any});
 const begin=(input:FileRevision,headers=ownerHeaders)=>request('POST','/api/file-sync/v1/uploads',input,headers);
 const restart=async()=>{await node.app.close();node=await start();await node.app.ready();};
 const upload=async(input:FileRevision,bytes:Buffer,headers=ownerHeaders)=>{
  const response=await begin(input,headers);assert.equal(response.statusCode,200,response.body);const session=response.json();
  if(session.ack)return session.ack;
  for(let n=0;n<Math.ceil(bytes.length/FILE_PART_BYTES);n++){
   const part=await request('PUT',`/api/file-sync/v1/uploads/${session.uploadId}/parts/${n}`,bytes.subarray(n*FILE_PART_BYTES,(n+1)*FILE_PART_BYTES),{...headers,'content-type':'application/octet-stream'});
   assert.equal(part.statusCode,200,part.body);
  }
  const committed=await request('POST',`/api/file-sync/v1/uploads/${session.uploadId}/commit`,{},headers);assert.equal(committed.statusCode,200,committed.body);return committed.json();
 };
 const cleanup=new Set<()=>void>();
 t.after(async()=>{for(const release of cleanup)release();await node.app.close();rmSync(directory,{recursive:true,force:true});});
 return {get node(){return node;},collector,ownerHeaders,collectorHeaders,request,begin,upload,restart,cleanup};
}
function manifest(sourceId:string,key:string,bytes:Buffer,layer:'original'|'snapshot'='original',revision='v1',previousRevision:string|null=null):FileRevision{
 const hash=sha256(bytes);
 return {sourceId,previousRevision,relativePath:key+'.txt',sizeBytes:bytes.length,sha256:hash,item:{externalId:key,revision,observedAt:'2026-10-01T00:00:00Z',title:'Generated '+key,kind:'file',layer,text:'',mimeType:'text/plain',deleted:false,...(layer==='snapshot'?{document:{fileIndex:{version:1,fileId:key,contentVersion:hash,mode:'index',coverage:'none',parser:'central-pending',status:'pending',totalCharacters:0,offset:0,length:0,maxIndexCharacters:8000,allowRead:false}}}:{})}};
}

test('authorized current file content is received without retransmission and keeps independent origins',async t=>{
 const f=await fixture(t),bytes=Buffer.from('Generated shared file content'),first=await f.upload(manifest('visible','first',bytes),bytes,f.collectorHeaders);await f.restart();
 const next=manifest('visible-other','second',bytes),response=await f.begin(next,f.collectorHeaders);assert.equal(response.statusCode,200,response.body);
 const received=response.json().ack;assert.ok(received,'the existing upload response contains a received ACK');assert.equal(received.receipt.state,'received');assert.equal(received.duplicate,false);assert.notEqual(received.id,first.id);assert.equal(received.sha256,sha256(bytes));
 assert.deepEqual(Buffer.concat([...f.node.files.bytes(received.id)]),bytes);
 await f.restart();
 const retry=await f.begin(next,f.collectorHeaders);assert.equal(retry.json().ack.id,received.id);assert.equal(retry.json().ack.duplicate,true);
 f.node.files.forget(first.id);assert.deepEqual(Buffer.concat([...f.node.files.bytes(received.id)]),bytes);assert.equal(f.node.sources.getItem('visible-other','second')?.captureId,received.id);
 const revised=await f.begin(manifest('visible-other','second',bytes,'original','v2','v1'),f.collectorHeaders);assert.equal(revised.statusCode,200,revised.body);assert.ok(revised.json().ack);assert.notEqual(revised.json().ack.id,received.id);assert.equal(f.node.sources.getItem('visible-other','second')?.revision,'v2');
});

test('collector cannot distinguish a private hash from an absent hash; metadata and old versions do not authorize reuse',async t=>{
 const f=await fixture(t),bytes=Buffer.from('Generated private hash'),privateFile=await f.upload(manifest('private','private-file',bytes),bytes);
 const guess=await f.begin(manifest('visible','guess',bytes),f.collectorHeaders),absentInput=manifest('visible','absent',bytes);absentInput.sha256='a'.repeat(64);
 const absent=await f.begin(absentInput,f.collectorHeaders);assert.equal(guess.statusCode,200,guess.body);assert.equal(absent.statusCode,200,absent.body);
 const shape=(body:any)=>({partBytes:body.partBytes,parts:body.parts,ack:body.ack});assert.deepEqual(shape(guess.json()),shape(absent.json()));assert.deepEqual(shape(guess.json()),{partBytes:FILE_PART_BYTES,parts:[],ack:null});
 assert.equal((await f.request('POST',`/api/file-sync/v1/uploads/${guess.json().uploadId}/commit`,{},f.collectorHeaders)).statusCode,409);
 const seed=await f.upload(manifest('visible','versioned',bytes),bytes,f.collectorHeaders),changed=Buffer.from('Generated different current bytes');
 await f.upload(manifest('visible','versioned',changed,'original','v2','v1'),changed,f.collectorHeaders);
 const stale=await f.begin(manifest('visible','stale-candidate',bytes),f.collectorHeaders);assert.equal(stale.json().ack,null);
 const sizeMismatch=manifest('private','wrong-size',bytes);sizeMismatch.sizeBytes++;assert.equal((await f.begin(sizeMismatch)).json().ack,null);
 assert.deepEqual(Buffer.concat([...f.node.files.bytes(privateFile.id)]),bytes);assert.deepEqual(Buffer.concat([...f.node.files.bytes(seed.id)]),bytes);
 const removedBytes=Buffer.from('Generated removed source content');f.node.sources.register({id:'removed',name:'Generated removed',kind:'local-files',deviceId:'device-b',platform:'android',retention:'archive'});
 await f.upload(manifest('removed','removed-file',removedBytes),removedBytes);f.node.store.db.prepare('DELETE FROM source_connections WHERE id=?').run('removed');
 const removed=await f.begin(manifest('visible','removed-source-probe',removedBytes));assert.equal(removed.statusCode,200,removed.body);assert.equal(removed.json().ack,null);
});

test('snapshot reuse keeps only temporary processing inputs and batch manifests reuse the same protocol',async t=>{
 const f=await fixture(t),bytes=Buffer.from('Generated temporary snapshot input');
 const archive=await f.upload(manifest('visible','archive',bytes),bytes,f.collectorHeaders);
 const snapshot=manifest('snapshot','snapshot-one',bytes,'snapshot'),start=await f.begin(snapshot,f.collectorHeaders);assert.equal(start.json().ack,null,'an archive is not a snapshot reuse grant');
 for(let n=0;n<Math.ceil(bytes.length/FILE_PART_BYTES);n++)assert.equal((await f.request('PUT',`/api/file-sync/v1/uploads/${start.json().uploadId}/parts/${n}`,bytes,{...f.collectorHeaders,'content-type':'application/octet-stream'})).statusCode,200);
 const firstResponse=await f.request('POST',`/api/file-sync/v1/uploads/${start.json().uploadId}/commit`,{},f.collectorHeaders);assert.equal(firstResponse.statusCode,200,firstResponse.body);const first=firstResponse.json();
 const second=manifest('snapshot','snapshot-two',bytes,'snapshot'),batch=await f.request('POST','/api/file-sync/v1/manifests',{items:[second]},f.collectorHeaders);assert.equal(batch.statusCode,200,batch.body);
 const result=batch.json().results[0];assert.equal(result.state,'accepted');assert.equal(result.ack.receipt.state,'received');assert.notEqual(result.ack.id,first.id);
 f.node.files.releaseSnapshotInput(first.id);
 const recovery=await f.request('POST',`/api/file-sync/v1/recovery/${first.id}/uploads`,{},f.collectorHeaders);assert.equal(recovery.statusCode,200,recovery.body);assert.equal(recovery.json().ack.id,first.id);assert.equal(recovery.json().ack.receipt.state,'received');
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM file_versions WHERE source_id='snapshot'").get()!.n,2);
 for(const id of [first.id,result.ack.id]){assert.equal(f.node.files.detail(id).hasOriginal,false);assert.throws(()=>[...f.node.files.bytes(id)],{statusCode:404});assert.deepEqual(Buffer.concat([...f.node.files.processingBytes(id)]),bytes);}
 await f.node.processing.tick();
 for(const id of [first.id,result.ack.id]){assert.equal(f.node.files.detail(id).job?.state,'succeeded');assert.equal(f.node.files.chunks(id).map(chunk=>chunk.ocrText).join(''),bytes.toString());assert.throws(()=>[...f.node.files.processingBytes(id)],{statusCode:410});}
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM file_snapshot_inputs').get()!.n,0);
 // The archive remains only because its separate authorized origin still retains it.
 assert.deepEqual(Buffer.concat([...f.node.files.bytes(archive.id)]),bytes);f.node.files.forget(archive.id);assert.throws(()=>f.node.store.assets.get(sha256(bytes)),{statusCode:404});
});

async function heldReuse(f:Awaited<ReturnType<typeof fixture>>,input:FileRevision,bytes:Buffer,headers=f.collectorHeaders){
 let unblock!:()=>void,locked!:()=>void,pinned!:()=>void;
 const gate=new Promise<void>(resolve=>unblock=resolve),entered=new Promise<void>(resolve=>locked=resolve),pinnedPromise=new Promise<void>(resolve=>pinned=resolve);
 const lock=f.node.files.serialize('item:'+input.sourceId+':'+input.item.externalId,async()=>{locked();await gate;});await entered;
 const hold=f.node.store.assets.hold.bind(f.node.store.assets);f.node.store.assets.hold=hash=>{const release=hold(hash);if(hash===sha256(bytes))pinned();return release;};
 const cancel=()=>{f.node.store.assets.hold=hold;unblock();};f.cleanup.add(cancel);
 const response=f.begin(input,headers);
 try{await Promise.race([pinnedPromise,response.then(result=>{throw Error('Reuse did not reach its asset hold: '+result.body);})]);}
 catch(error){cancel();f.cleanup.delete(cancel);await lock;throw error;}
 return {response,release:async()=>{cancel();f.cleanup.delete(cancel);await lock;}};
}

test('revoking the collector while reused content waits prevents publication',async t=>{
 const f=await fixture(t),bytes=Buffer.from('Generated revocation race');await f.upload(manifest('visible','revocation-seed',bytes),bytes,f.collectorHeaders);
 const held=await heldReuse(f,manifest('visible','revoked-target',bytes),bytes);
 await f.node.connections.revoke(f.collector.credentialId);await held.release();const response=await held.response;
 assert.equal(response.statusCode,401,response.body);assert.equal(f.node.sources.getItem('visible','revoked-target'),undefined);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM asset_pins').get()!.n,0);
});

test('a candidate changed while reuse waits falls back to a regular upload on retry',async t=>{
 const f=await fixture(t),bytes=Buffer.from('Generated candidate before change');await f.upload(manifest('visible','changing-seed',bytes),bytes,f.collectorHeaders);
 const target=manifest('visible','changing-target',bytes),held=await heldReuse(f,target,bytes);
 const changed=Buffer.from('Generated candidate after change');await f.upload(manifest('visible','changing-seed',changed,'original','v2','v1'),changed,f.collectorHeaders);
 await held.release();const rejected=await held.response;assert.equal(rejected.statusCode,409,rejected.body);assert.equal(f.node.sources.getItem('visible','changing-target'),undefined);
 const retry=await f.begin(target,f.collectorHeaders);assert.equal(retry.statusCode,200,retry.body);assert.equal(retry.json().ack,null);assert.deepEqual(retry.json().parts,[]);
 const received=await f.upload(target,bytes,f.collectorHeaders);assert.deepEqual(Buffer.concat([...f.node.files.bytes(received.id)]),bytes);
});

test('parts submitted while reuse waits cannot bypass ordinary digest validation',async t=>{
 const f=await fixture(t),bytes=Buffer.from('Generated expected content');await f.upload(manifest('visible','parts-seed',bytes),bytes,f.collectorHeaders);
 const target=manifest('visible','parts-target',bytes),session=f.node.files.begin(target,()=>{}),held=await heldReuse(f,target,bytes);
 const wrong=Buffer.alloc(bytes.length,42),part=await f.request('PUT',`/api/file-sync/v1/uploads/${session.uploadId}/parts/0`,wrong,{...f.collectorHeaders,'content-type':'application/octet-stream'});assert.equal(part.statusCode,200,part.body);
 await held.release();const rejected=await held.response;assert.equal(rejected.statusCode,409,rejected.body);
 const retry=await f.begin(target,f.collectorHeaders);assert.equal(retry.statusCode,200,retry.body);assert.equal(retry.json().ack,null);assert.equal(retry.json().parts.length,1);
 const commit=await f.request('POST',`/api/file-sync/v1/uploads/${session.uploadId}/commit`,{},f.collectorHeaders);assert.equal(commit.statusCode,409,commit.body);assert.equal(f.node.sources.getItem('visible','parts-target'),undefined);
});

test('deletion and GC during reuse cannot leave a dangling published file',async t=>{
 const f=await fixture(t),bytes=Buffer.from('Generated deletion race'),seed=await f.upload(manifest('visible','gc-seed',bytes),bytes,f.collectorHeaders),held=await heldReuse(f,manifest('visible','gc-target',bytes),bytes);
 f.node.files.forget(seed.id);assert.equal(f.node.store.assets.retained(sha256(bytes)),true,'the existing hold protects bytes until the pending receive settles');
 await held.release();const response=await held.response;assert.equal(response.statusCode,409,response.body);assert.equal(f.node.sources.getItem('visible','gc-target'),undefined);
 f.node.files.sweep();assert.throws(()=>f.node.store.assets.get(sha256(bytes)),{statusCode:404});assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM asset_pins').get()!.n,0);
});
