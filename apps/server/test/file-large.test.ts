import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,realpath,open,writeFile,stat,readdir,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import React from 'react';
import {FILE_PART_BYTES,FILE_PART_RECEIPTS,filePartReceipts,type FilePartPage,type FileRevision} from '@mote/shared';
import {serializeConfigDocument} from '@mote/shared/config-file';
import {buildApp} from '../src/app.js';
import {configFromFile} from '../src/config.js';
import {SourceSync} from '../../desktop/src/source-sync.js';
import {spoolOriginal} from '../../desktop/src/original-spool.js';
import type {ScannedItem,SourceDefinition,SourceRequest} from '../../desktop/src/source-types.js';
import {advancedBrowser} from '../../web/test/advanced-web-contract.js';
import {ImportQueue} from '../../web/src/plugins/intake/import-queue.js';
import {ImportQueueDetail} from '../../web/src/plugins/intake/ImportQueueEntry.js';
import {createApi,ApiError} from '../../web/src/api.js';
import {verifiedBackup,restoreProfile,repository} from '../../../scripts/profile-lib.mjs';

const run=promisify(execFile),PART=FILE_PART_BYTES;
async function digest(parts:AsyncIterable<Uint8Array>|Iterable<Uint8Array>){const hash=createHash('sha256');let size=0;for await(const part of parts){size+=part.length;hash.update(part);}return {size,sha256:hash.digest('hex')};}
async function fixture(t:TestContext){
 const directory=await realpath(await mkdtemp(join(tmpdir(),'mote-large-original-'))),token='generated-large-original-owner',source:SourceDefinition={id:'generated-large-source',name:'Generated large source',kind:'local-files',deviceId:'generated-large-device',platform:'macos',retention:'archive',enabled:true};let data=join(directory,'data'),active=false,partZero=0,modelCalls=0;
 const config=join(directory,'mote.yaml');let node:Awaited<ReturnType<typeof buildApp>>,origin='';
 const start=async()=>{await writeFile(config,serializeConfigDocument({version:1,revision:0,server:{profile:'test',token},storage:{dataDir:data},models:{deployment:{model:''}},diagnostics:{level:'silent'}}),{mode:0o600});node=await buildApp(configFromFile(config),{backgroundWorker:false,agent:{configured:false,async query(){modelCalls++;throw Error('No model in large original fixture');},async close(){}}});node.app.addHook('onRequest',async req=>{if(req.method==='PUT'&&req.url.startsWith('/api/file-sync/v1/uploads/')&&req.url.endsWith('/parts/0'))partZero++;});origin=await node.app.listen({host:'127.0.0.1',port:0});active=true;};await start();
 const stop=async()=>{if(active){active=false;await node.app.close();}};t.after(async()=>{await stop();await rm(directory,{recursive:true,force:true});});
 const owner={authorization:'Bearer '+token,'x-mote-ingress-version':'2'};
 const raw=(path:string,init:RequestInit={},headers:Record<string,string>=owner)=>fetch(origin+path,{...init,headers:{...headers,...Object.fromEntries(new Headers(init.headers))}});
 const post=async(path:string,body:unknown,headers=owner)=>{const response=await raw(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)},headers);assert.equal(response.status,200,await response.clone().text());return response.json() as Promise<any>;};
 await post('/api/sources',source);
 const invitation=await post('/api/connections/collector-invitations',{serverUrl:origin,label:'Generated large collector',deviceId:source.deviceId}),collector=await post('/api/connections/redeem',{code:invitation.invitation.code,deviceId:source.deviceId,deviceName:'Generated large device',platform:'macos'}),collectorHeaders={authorization:'Bearer '+collector.token,'x-mote-ingress-version':'2'};
 return {directory,token,source,owner,collectorHeaders,raw,post,get node(){return node;},get origin(){return origin;},get data(){return data;},get partZero(){return partZero;},get modelCalls(){return modelCalls;},stop,async restart(restored?:string){await stop();if(restored)data=restored;await start();}};
}
test('generated receipt metadata is paged by the actual owner and collector status routes with current grants',async t=>{
 const f=await fixture(t),size=299*PART+17,input:FileRevision={sourceId:f.source.id,previousRevision:null,item:{externalId:'generated-page-metadata',revision:'v1',observedAt:'2026-11-17T00:00:00Z',kind:'file',layer:'original',title:'Generated metadata only',text:'',mimeType:'application/octet-stream',deleted:false},sha256:'b'.repeat(64),sizeBytes:size,relativePath:'generated.bin'};
 // Only receipt metadata is generated here. The separate boundary case below
 // establishes actual uploaded bytes; this case makes no archive/ACK claim.
 for(const domain of ['file','import'] as const){
  const route=domain==='file'?'/api/file-sync/v1/uploads':'/api/import-uploads',headers=domain==='file'?f.collectorHeaders:f.owner;
  const began=await f.post(route,domain==='file'?input:{name:'generated-metadata.bin',sizeBytes:size},headers),id=domain==='file'?began.uploadId:began.id,table=domain==='file'?'file_parts':'import_upload_parts';
  const insert=f.node.store.db.prepare(domain==='file'?'INSERT INTO file_parts(upload_id,part,hash,bytes) VALUES(?,?,?,?)':'INSERT INTO import_upload_parts(upload_id,part,hash,bytes) VALUES(?,?,?,?)');
  for(let part=0;part<300;part++)insert.run(id,part,'a'.repeat(64),part===299?17:PART);
  const first=await f.raw(route+'/'+id,{},headers);assert.equal(first.status,200);const page=await first.json() as FilePartPage;assert.equal(page.parts.length,FILE_PART_RECEIPTS);assert.equal(page.nextPart,255);let received=0,reads=0;
  for await(const part of filePartReceipts(page,async after=>{reads++;const response=await f.raw(route+'/'+id+'?afterPart='+after,{},headers);assert.equal(response.status,200);return response.json() as Promise<FilePartPage>;},size))assert.equal(part.part,received++);
  assert.equal(received,300);assert.equal(reads,1);assert.equal((await f.raw(route+'/'+id+'?afterPart=9007199254740992',{},headers)).status,400);
  f.node.store.db.prepare('UPDATE '+table+' SET bytes=18 WHERE upload_id=? AND part=299').run(id);
  await assert.rejects(async()=>{for await(const ignored of filePartReceipts(page,async after=>(await f.raw(route+'/'+id+'?afterPart='+after,{},headers)).json() as Promise<FilePartPage>,size))void ignored;},/receipt/);
  if(domain==='file'){f.node.sources.resetCoverage(f.source.id);assert.equal((await f.raw(route+'/'+id+'?afterPart=255',{},headers)).status,409,'continuation cannot promote the old source grant');}
 }
 assert.equal(f.modelCalls,0);
});

test('a small archived original remains readable and visible when the controlled preview boundary refuses capacity',async t=>{
 const f=await fixture(t),browser=await advancedBrowser(f.origin+'/#/intake'),file=new File([Buffer.alloc(PART+17,23)],'generated-small.bin',{type:'application/octet-stream'}),api=createApi({token:f.token});let submissions=0;
 const controlled={...api,request:async<T>(path:string,init?:RequestInit):Promise<T>=>{if(path==='/api/imports'){submissions++;throw new ApiError('Generated processing capacity exceeded',413);}return api.request<T>(path,init);}},queue=new ImportQueue(controlled,1);
 try{
  queue.enqueue({source:{kind:'files',files:[file]},name:'Generated retained archive',instruction:'Generated preview',sourcePackId:''});let entry=queue.getSnapshot().entries[0];
  const wait=async()=>{const deadline=Date.now()+15000;while(entry.state!=='failed'){assert.ok(Date.now()<deadline,'small archive admission');await new Promise(resolve=>setTimeout(resolve,5));entry=queue.getSnapshot().entries[0];}};await wait();
  assert.equal(entry.archivedFileIds?.length,1);assert.equal(entry.job,undefined);assert.equal(entry.uploadedBytes,file.size);assert.match(entry.failure!.message,/capacity/);
  await browser.render(React.createElement(ImportQueueDetail,{api,entry,queue,onEdit(){}}));assert.match(browser.d.querySelector('[role="status"]')!.textContent!,/原件已保留/);assert.equal(browser.d.querySelectorAll('.archived-download').length,1);
  const response=await f.raw('/api/archived-files/'+entry.archivedFileIds![0]+'/content');assert.equal(response.status,200);assert.deepEqual(await digest(response.body!),await digest([new Uint8Array(await file.arrayBuffer())]));
  t.mock.method(file,'slice',()=>assert.fail('a retained archive receipt never rereads its original on preview retry'));const ids=entry.archivedFileIds;queue.retry(entry.id);entry=queue.getSnapshot().entries[0];await wait();assert.equal(submissions,2);assert.deepEqual(entry.archivedFileIds,ids);
 }finally{queue.close();await browser.close();}
});

test('one real original above 512 MiB survives Desktop resume, both archive entries, parser refusal and verified backup restore',async t=>{
 const f=await fixture(t),size=512*1024*1024+17,sourcePath=join(f.directory,'generated-large.bin'),tail=Buffer.from('GENERATED-TAIL017');assert.equal(tail.length,17);
 const handle=await open(sourcePath,'wx',0o600);try{await handle.truncate(size);await handle.write(tail,0,tail.length,512*1024*1024);}finally{await handle.close();}
 const expected=await digest(createReadStream(sourcePath)),info=await stat(sourcePath),original=await spoolOriginal(sourcePath,join(f.directory,'spool'),{dev:info.dev,ino:info.ino,size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs});assert.equal(original.sha256,expected.sha256);
 const scanned:ScannedItem={externalId:'generated-large',title:'generated-large.bin',kind:'file',layer:'original',text:'',mimeType:'application/octet-stream',deleted:false,localOriginal:original,metadata:{version:1,file:{sizeBytes:size}},document:{fileIndex:{version:1,fileId:'generated-large',contentVersion:original.sha256,mode:'archive',coverage:'none',parser:'central-pending',status:'pending',totalCharacters:0,offset:0,length:0,allowRead:false}}};
 let lost=false;const request:SourceRequest=async(path,body,method,signal)=>{const response=await f.raw(path,{method,signal,...(body===undefined?{}:{headers:{'content-type':Buffer.isBuffer(body)?'application/octet-stream':'application/json'},body:Buffer.isBuffer(body)?body:JSON.stringify(body)})},f.collectorHeaders),value=await response.json();if(!response.ok)throw Object.assign(Error('Generated HTTP '+response.status),{httpStatus:response.status});if(!lost&&path.endsWith('/parts/0')){lost=true;throw Error('Generated lost part ACK');}return value;};
 const state=join(f.directory,'source-state.json'),first=new SourceSync(state);await first.initialize();await first.stage({items:[scanned],seen:[scanned.externalId],skipped:0,complete:true},false,'2026-11-17T00:00:00Z');await assert.rejects(first.flush(f.source,request),/lost part ACK/);await f.restart();
 const resumed=new SourceSync(state);await resumed.initialize();await resumed.flush(f.source,request);assert.equal(resumed.status().pending,0);assert.equal(f.partZero,1);
 const archived=f.node.sources.getItem(f.source.id,scanned.externalId)!;assert.ok(archived);assert.equal(f.node.files.version(archived.captureId).object_hash,expected.sha256);assert.throws(()=>f.node.store.assets.read(expected.sha256),{statusCode:413},'Buffer-only consumers retain a distinct memory budget');
 const range=await f.raw('/api/files/'+archived.captureId+'/content',{headers:{range:`bytes=${512*1024*1024-5}-${size-1}`}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),Buffer.concat([Buffer.alloc(5),tail]));
 const complete=await f.raw('/api/files/'+archived.captureId+'/content');assert.equal(complete.status,200);assert.deepEqual(await digest(complete.body!),expected);
 const browser=await advancedBrowser(f.origin+'/#/intake');let queue:ImportQueue|undefined;
 try{
  const file=new File([],'generated-large.bin',{type:'application/octet-stream'});Object.defineProperty(file,'size',{value:size});Object.defineProperty(file,'arrayBuffer',{value:()=>assert.fail('a large original must never be read as one ArrayBuffer')});
  Object.defineProperty(file,'slice',{value:(start=0,end=size)=>({async arrayBuffer(){end=Math.min(size,end);assert.ok(end-start<=PART);const bytes=new Uint8Array(end-start),input=await open(sourcePath,'r');try{let read=0;while(read<bytes.length){const result=await input.read(bytes,read,bytes.length-read,start+read);assert.ok(result.bytesRead>0);read+=result.bytesRead;}}finally{await input.close();}return bytes.buffer;}})});
  const api=createApi({token:f.token});queue=new ImportQueue(api,1);queue.enqueue({source:{kind:'files',files:[file]},name:'Generated large archive',instruction:'Generated preview',sourcePackId:''});
  let entry=queue.getSnapshot().entries[0];const deadline=Date.now()+60000;while(entry.state!=='failed'){assert.ok(Date.now()<deadline,'large owner admission must settle inside the existing test budget');await new Promise(resolve=>setTimeout(resolve,5));entry=queue.getSnapshot().entries[0];}
  assert.equal(entry.archivedFileIds?.length,1);assert.equal(entry.job,undefined);assert.match(entry.failure!.message,/大小|size/i);assert.equal(entry.uploadedBytes,size);
  await browser.render(React.createElement(ImportQueueDetail,{api,entry,queue,onEdit(){}}));assert.match(browser.d.querySelector('[role="status"]')!.textContent!,/原件已保留/);assert.ok(browser.d.querySelector('.error-banner'));assert.equal(browser.d.querySelectorAll('.archived-download').length,1);
  const saved=await f.raw('/api/archived-files/'+entry.archivedFileIds![0]+'/content');assert.equal(saved.status,200);assert.deepEqual(await digest(saved.body!),expected);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM assets WHERE hash=?').get(expected.sha256)!.n,1);
 }finally{queue?.close();await browser.close();}
 assert.ok((await readdir(join(f.node.store.assets.directory,expected.sha256))).every(name=>/^\d+\.(plain|aes)$/.test(name)),'worker metadata is not part of the persistent asset format');assert.equal((await stat(sourcePath)).size,size);assert.equal(f.modelCalls,0);
 const data=f.data,backup=join(f.directory,'backup'),restored=join(f.directory,'restored');await f.stop();
 await run(process.execPath,[fileURLToPath(new URL('../../../scripts/backup.ts',import.meta.url)),'--data',data,'--out',backup],{timeout:30000});await verifiedBackup(backup);await restoreProfile({meta:{runtime:'native',release:repository},env:{},dataDir:restored,processFile:join(f.directory,'absent-process.json')},backup);await f.restart(restored);
 const response=await f.raw('/api/files/'+archived.captureId+'/content');assert.equal(response.status,200);assert.deepEqual(await digest(response.body!),expected);assert.equal(f.modelCalls,0);
});
