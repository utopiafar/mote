import {legacyAsset} from './fixtures/legacy-asset.js';
import {ImportUploads} from '../src/import-uploads.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,renameSync,rmSync,existsSync,symlinkSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import sharp from 'sharp';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {ContentStorageService} from '../src/content-storage.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

const generatedImage=()=>sharp({create:{width:24,height:24,channels:3,background:'#445566'}}).png().toBuffer();
const capture=(image:Buffer)=>({id:randomUUID(),deviceId:'fixture',deviceName:'Generated fixture',platform:'import',capturedAt:new Date().toISOString(),source:'screen',durationMs:0,ocrText:'Generated text',imageMime:'image/png',imageBase64:image.toString('base64')});
async function finish(service:ContentStorageService){for(let i=0;i<1000&&service.snapshot().job.state==='running';i++)await setImmediate();assert.notEqual(service.snapshot().job.state,'running');return service.snapshot().job;}

test('content encryption is off even with an environment key, and opt-in persists across mixed-library restarts',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-content-option-'));let store=new Store(dir,{dataKey:'ab'.repeat(32)});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const image=await generatedImage(),plain=await store.ingest(capture(image));
  assert.equal(store.contentEncryption.enabled,false);assert.deepEqual(readFileSync(join(store.assets.directory,plain.blobHash!,'0.plain')),image);
  const originals=new ArchivedFileStore(store),raw=originals.put({name:'raw.bin',bytes:Buffer.from('MOTE1 arbitrary plain bytes')});
  assert.equal(readFileSync(join(store.assets.directory,raw.hash,'0.plain'),'utf8'),'MOTE1 arbitrary plain bytes');
  store.contentEncryption.setEnabled(true);
  const secret=originals.put({name:'encrypted.bin',bytes:Buffer.from('generated opt-in content')});
  assert.notEqual(readFileSync(join(store.assets.directory,secret.hash,'0.aes'),'utf8'),'generated opt-in content');
  store.close();store=new Store(dir,{dataKey:'ab'.repeat(32)});
  assert.equal(store.contentEncryption.enabled,true);assert.deepEqual(store.image(plain.id).bytes,image);
  assert.equal(new ArchivedFileStore(store).read(secret.id).toString(),'generated opt-in content');
  store.contentEncryption.setEnabled(false);
  assert.ok(existsSync(join(store.assets.directory,secret.hash,'0.aes')),'Disabling future writes must not silently convert old files');
  assert.throws(()=>new Store(dir,{dataKey:'cd'.repeat(32)}),/key mismatch/);
});

test('one-time decrypt handles legacy images, originals, committed parts and pending uploads; cancellation is resumable',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-content-migrate-')),key='ac'.repeat(32);
  let store=new Store(dir,{dataKey:key,contentEncryptionEnabled:true});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const image=await generatedImage(),saved=await store.ingest(capture(image));
  let archived=new ArchivedFileStore(store);const original=archived.put({name:'old.txt',bytes:Buffer.from('Generated legacy original')});
  let sources=new SourceStore(store),files=new FileStore(store,sources);
  sources.register({id:'fixture',name:'Generated',kind:'local-files',deviceId:'fixture',platform:'android',retention:'archive'});
  const bytes=Buffer.from([12,0,255,5,4,3]);
  const manifest=(externalId:string)=>({sourceId:'fixture',previousRevision:null,item:{externalId,revision:'v1',observedAt:new Date().toISOString(),title:'Generated file',kind:'file',layer:'original',text:'',mimeType:'application/octet-stream',deleted:false},relativePath:'generated.bin',sizeBytes:bytes.length,sha256:sha256(bytes)});
  const completed=files.begin(manifest('completed'),()=>{});files.part(completed.uploadId,0,bytes,()=>{});const ack=await files.commit(completed.uploadId,()=>{});
  const pending=files.begin(manifest('pending'),()=>{});files.part(pending.uploadId,0,bytes,()=>{});
  legacyAsset(store,saved.blobHash!,'image-legacy');legacyAsset(store,original.hash,'archive-legacy');
  // Exact pre-0.0.25 format: unmarked AES-GCM file parts + vault-wide encryption identity.
  for(const base of [join(archived.directory,original.hash),join(files.objects,ack.sha256,'0'),join(files.uploads,pending.uploadId,'0')])renameSync(base+'.aes',base);
  store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(sha256(Buffer.from(key,'hex')),'encryption');
  store.contentEncryption.setEnabled(false);store.close();store=new Store(dir,{dataKey:key});
  archived=new ArchivedFileStore(store);sources=new SourceStore(store);files=new FileStore(store,sources);
  assert.deepEqual(Buffer.concat([...files.bytes(ack.id)]),bytes);assert.deepEqual(store.image(saved.id).bytes,image);
  const service=new ContentStorageService(store,files,archived);
  service.start();service.cancel();assert.equal((await finish(service)).state,'cancelled');
  service.start();const result=await finish(service);assert.equal(result.failed,0);assert.equal(result.converted,4);
  assert.deepEqual(readFileSync(join(store.blobsDir,saved.blobHash!)),image);
  assert.deepEqual(readFileSync(join(files.objects,ack.sha256,'0.plain')),bytes);
  assert.deepEqual(readFileSync(join(files.uploads,pending.uploadId,'0.plain')),bytes);
  assert.equal(readFileSync(join(archived.directory,original.hash+'.plain'),'utf8'),'Generated legacy original');
  service.start();assert.equal((await finish(service)).converted,0);
  store.close();store=new Store(dir);assert.deepEqual(store.image(saved.id).bytes,image);
  assert.deepEqual(Buffer.concat([...new FileStore(store,new SourceStore(store)).bytes(ack.id)]),bytes);
});

test('failed decrypt keeps the original ciphertext and preserves the key requirement',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-content-failure-')),key='ad'.repeat(32),store=new Store(dir,{dataKey:key,contentEncryptionEnabled:true});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const archived=new ArchivedFileStore(store),file=archived.put({name:'broken.bin',bytes:Buffer.from('Generated content')});
  const path=join(store.assets.directory,file.hash,'0.aes'),damaged=readFileSync(path);damaged[15]^=128;writeFileSync(path,damaged);
  store.contentEncryption.setEnabled(false);const service=new ContentStorageService(store,new FileStore(store,new SourceStore(store)),archived);
  service.start();assert.equal((await finish(service)).failed,1);assert.deepEqual(readFileSync(path),damaged);assert.equal(existsSync(join(store.assets.directory,file.hash,'0.plain')),false);
  assert.throws(()=>new Store(dir),/key mismatch/);
});

test('decrypt includes untracked legacy objects and uploads before dropping the key requirement; retry commits remain readable',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-content-orphan-')),key='ae'.repeat(32);
  let store=new Store(dir,{dataKey:key,contentEncryptionEnabled:true});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(sha256(Buffer.from(key,'hex')),'encryption');
  store.contentEncryption.setEnabled(false);store.close();store=new Store(dir,{dataKey:key});
  let sources=new SourceStore(store),files=new FileStore(store,sources);const archived=new ArchivedFileStore(store);
  sources.register({id:'fixture',name:'Generated',kind:'local-files',deviceId:'fixture',platform:'android',retention:'archive'});
  const bytes=Buffer.from('Generated content surviving a crash before the object database transaction'),hash=sha256(bytes);
  const object=join(files.objects,hash),upload=join(files.uploads,randomUUID()),staging=join(files.objects,hash+'.'+randomUUID()+'.tmp');
  for(const directory of [object,upload,staging]){mkdirSync(directory,{mode:0o700});writeFileSync(join(directory,'0'),store.contentEncryption.seal(bytes));}
  writeFileSync(join(archived.directory,hash),store.contentEncryption.seal(bytes));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM file_objects').get()!.n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM file_parts').get()!.n,0);
  const service=new ContentStorageService(store,files,archived);service.start();const job=await finish(service);
  assert.equal(job.failed,0);assert.equal(job.converted,4);
  for(const directory of [object,upload,staging]){assert.deepEqual(readFileSync(join(directory,'0.plain')),bytes);assert.equal(existsSync(join(directory,'0')),false);}
  assert.deepEqual(readFileSync(join(archived.directory,hash+'.plain')),bytes);
  store.close();store=new Store(dir);sources=new SourceStore(store);files=new FileStore(store,sources);
  const manifest=(externalId:string)=>({sourceId:'fixture',previousRevision:null,item:{externalId,revision:'v1',observedAt:new Date().toISOString(),title:'Generated retry',kind:'file',layer:'original',text:'',mimeType:'application/octet-stream',deleted:false},relativePath:'generated.bin',sizeBytes:bytes.length,sha256:hash});
  const retry=files.begin(manifest('retry'),()=>{});files.part(retry.uploadId,0,bytes,()=>{});const ack=await files.commit(retry.uploadId,()=>{});
  assert.deepEqual(Buffer.concat([...files.bytes(ack.id)]),bytes);
  // Existing hash-named storage cannot be trusted solely because its directory exists.
  writeFileSync(join(object,'0.plain'),Buffer.alloc(bytes.length));
  const corrupt=files.begin(manifest('corrupt-reuse'),()=>{});files.part(corrupt.uploadId,0,bytes,()=>{});
  await assert.rejects(files.commit(corrupt.uploadId,()=>{}),/Asset checksum mismatch/);
  assert.equal(files.upload(corrupt.uploadId,()=>{}).ack,null);
});

test('decrypt rejects linked object and upload directories without modifying content outside the vault',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-content-links-')),outside=mkdtempSync(join(tmpdir(),'mote-content-outside-'));
  const store=new Store(dir,{dataKey:'af'.repeat(32),contentEncryptionEnabled:true}),sources=new SourceStore(store),files=new FileStore(store,sources),archived=new ArchivedFileStore(store);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});});
  const bytes=Buffer.from('Generated outside-vault content'),hash=sha256(bytes),sealed=store.contentEncryption.seal(bytes);
  writeFileSync(join(outside,'0.aes'),sealed);symlinkSync(outside,join(files.objects,hash),'dir');symlinkSync(outside,join(files.uploads,randomUUID()),'dir');
  store.db.prepare('INSERT INTO file_objects VALUES(?,?,?)').run(hash,bytes.length,1);
  store.contentEncryption.setEnabled(false);
  const service=new ContentStorageService(store,files,archived);service.start();const job=await finish(service);
  assert.ok(job.failed>=2);assert.equal(job.converted,0);assert.deepEqual(readdirSync(outside),['0.aes']);assert.deepEqual(readFileSync(join(outside,'0.aes')),sealed);
  assert.throws(()=>new Store(dir),/key mismatch/);
});

test('decrypt preserves conflicting retained ciphertext copies for a retry',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-content-conflict-')),store=new Store(dir,{dataKey:'bc'.repeat(32),contentEncryptionEnabled:true});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const files=new FileStore(store,new SourceStore(store)),archived=new ArchivedFileStore(store),original=archived.put({name:'generated.txt',bytes:Buffer.from('Generated canonical content')});
  const base=join(store.assets.directory,original.hash,'0'),sealed=readFileSync(base+'.aes'),conflicting=Buffer.from('Generated different content');
  writeFileSync(base,conflicting);store.contentEncryption.setEnabled(false);
  const service=new ContentStorageService(store,files,archived);service.start();assert.equal((await finish(service)).failed,1);
  assert.deepEqual(readFileSync(base+'.aes'),sealed);assert.deepEqual(readFileSync(base),conflicting);assert.equal(existsSync(base+'.plain'),false);
});

test('retrying a part write after changing encryption policy removes obsolete representations before ACK',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-content-retry-write-')),store=new Store(dir,{dataKey:'bd'.repeat(32)});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const sources=new SourceStore(store),files=new FileStore(store,sources);
  sources.register({id:'fixture',name:'Generated',kind:'local-files',deviceId:'fixture',platform:'android',retention:'archive'});
  for(const enabled of [true,false]){
    const bytes=Buffer.from('Generated retry content '+enabled),stale=Buffer.alloc(bytes.length,42);
    const session=files.begin({sourceId:'fixture',previousRevision:null,item:{externalId:'retry-'+enabled,revision:'v1',observedAt:new Date().toISOString(),title:'Generated retry',kind:'file',layer:'original',text:'',mimeType:'application/octet-stream',deleted:false},relativePath:'generated.bin',sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});
    const path=join(files.uploads,session.uploadId,'0');
    // Simulate a process exit between the durable part write and file_parts INSERT.
    store.contentEncryption.setEnabled(!enabled);store.contentEncryption.write(path,stale);
    writeFileSync(path,stale); // A pre-format retry may also leave an unmarked copy.
    assert.equal(files.upload(session.uploadId,()=>{}).parts.length,0);
    store.contentEncryption.setEnabled(enabled);files.part(session.uploadId,0,bytes,()=>{});
    assert.deepEqual(store.contentEncryption.read(path),bytes);
    assert.equal(existsSync(path),false);assert.equal(existsSync(path+(enabled?'.plain':'.aes')),false);
    assert.equal(existsSync(path+(enabled?'.aes':'.plain')),true);
    const ack=await files.commit(session.uploadId,()=>{});assert.deepEqual(Buffer.concat([...files.bytes(ack.id)]),bytes);
  }
});

test('developer content controls require owner auth and return background progress without exposing keys',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-content-api-'));
  const config:Config={dataDir:dir,token:'generated-content-owner-token-12345',tokenPath:'fixture',host:'127.0.0.1',port:47832,maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',dataKey:undefined,logLevel:'silent'};
  const {app,store,connections}=await buildApp(config,{agent:{configured:false,query:async()=>{throw Error('unused');},close:async()=>{}}});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${config.token}`};
  assert.equal((await app.inject('/api/content-storage')).statusCode,401);
  const {invitation}=connections.invite({serverUrl:'http://127.0.0.1:47832',label:'Generated collector',deviceId:'fixture'});
  const collector=await connections.redeem({code:invitation.code,deviceId:'fixture',deviceName:'Generated',platform:'android'});
  const collectorHeaders={authorization:`Bearer ${collector.token}`};
  assert.equal((await app.inject({url:'/api/content-storage',headers:collectorHeaders})).statusCode,403);
  assert.equal((await app.inject({method:'PUT',url:'/api/content-storage',headers:collectorHeaders,payload:{enabled:true}})).statusCode,403);
  for(const url of ['/api/content-storage/decrypt','/api/content-storage/decrypt/cancel'])assert.equal((await app.inject({method:'POST',url,headers:collectorHeaders,payload:{}})).statusCode,403);
  assert.equal((await app.inject({url:'/api/content-storage',headers})).json().enabled,false);
  assert.equal((await app.inject({method:'PUT',url:'/api/content-storage',headers,payload:{enabled:true}})).json().enabled,true);
  assert.equal((await app.inject({method:'POST',url:'/api/content-storage/decrypt',headers,payload:{}})).statusCode,409);
  assert.equal((await app.inject({method:'PUT',url:'/api/content-storage',headers,payload:{enabled:false}})).json().enabled,false);
  const response=await app.inject({method:'POST',url:'/api/content-storage/decrypt',headers,payload:{}});assert.equal(response.statusCode,202);
  assert.equal(response.json().job.state,'running');assert.ok(!response.body.includes(store.key!.toString('hex')));
  assert.equal((await app.inject({method:'PUT',url:'/api/content-storage',headers,payload:{enabled:'false'}})).statusCode,400);
});

test('binary browser import parts remain readable after bulk decryption and restart',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-import-decrypt-'));let store=new Store(dir,{dataKey:'aa'.repeat(32),contentEncryptionEnabled:true});
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 let archived=new ArchivedFileStore(store),uploads=new ImportUploads(store,archived);const bytes=Buffer.from('generated import bytes'),upload=uploads.begin({name:'fixture.txt',sizeBytes:bytes.length});uploads.part(upload.id,0,bytes);
 store.contentEncryption.setEnabled(false);const service=new ContentStorageService(store,new FileStore(store,new SourceStore(store)),archived);service.start();assert.equal((await finish(service)).failed,0);
 store.close();store=new Store(dir);archived=new ArchivedFileStore(store);uploads=new ImportUploads(store,archived);assert.deepEqual(archived.read((await uploads.commit(upload.id)).id),bytes);
});
