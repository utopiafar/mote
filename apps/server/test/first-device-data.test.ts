import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import sharp from 'sharp';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

const owner='generated-first-data-owner';
const headers={authorization:'Bearer '+owner,'x-mote-ingress-version':'2'};
const old='2026-09-01T10:00:00.000Z';
async function fixture(t:TestContext){
 const dataDir=mkdtempSync(join(tmpdir(),'mote-first-device-data-'));
 const config:Config={dataDir,token:owner,tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
 const start=()=>buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('First data does not require a model');},close:async()=>{}}});
 let node=await start();
 t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
 const state=async()=>{const res=await node.app.inject({url:'/api/devices/first-data',headers});assert.equal(res.statusCode,200,res.body);assert.equal(res.headers['cache-control'],'no-store');return res.json();};
 const pair=async(id='generated-phone')=>{
  const invite=await node.app.inject({method:'POST',url:'/api/connections/collector-invitations',headers,payload:{serverUrl:'https://generated.invalid',label:'Generated phone'}});
  assert.equal(invite.statusCode,200,invite.body);
  const res=await node.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invite.json().invitation.code,deviceId:id,deviceName:'Generated phone',platform:'android'}});
  assert.equal(res.statusCode,200,res.body);return {authorization:'Bearer '+res.json().token,'x-mote-ingress-version':'2'};
 };
 return {get node(){return node;},state,pair,restart:async()=>{await node.app.close();node=await start();}};
}

test('first data requires a device original, not pairing, web notes, MCP or model configuration; ACK retries and restart retain identity',async t=>{
 const f=await fixture(t);
 assert.equal((await f.state()).state,'waiting');
 assert.equal((await f.node.app.inject('/api/devices/first-data')).statusCode,401);
 const mcp=await f.node.connections.mintMcp({serverUrl:'https://generated.invalid',label:'Generated read-only Agent',access:'read'},{directory:join(f.node.store.directory,'connectors'),mcpEnabled:true});
 assert.equal((await f.node.app.inject({url:'/api/devices/first-data',headers:{authorization:mcp.config.mcpServers.mote.headers.Authorization}})).statusCode,403,'MCP tokens do not acquire Central onboarding access');
 const collector=await f.pair();
 assert.equal((await f.node.app.inject({url:'/api/devices/first-data',headers:collector})).statusCode,403);
 assert.equal((await f.state()).state,'waiting','an issued invitation is not device contact');
 const webNote={id:randomUUID(),deviceId:'generated-web',deviceName:'Generated Web',platform:'import',client:'web',capturedAt:old,text:'Generated web-only original'};
 assert.equal((await f.node.app.inject({method:'POST',url:'/api/notes',headers,payload:webNote})).statusCode,201);
 assert.equal((await f.state()).state,'waiting','web records cannot substitute for collector delivery');
 assert.equal((await f.node.app.inject({method:'POST',url:'/api/devices/heartbeat',headers:collector,payload:{deviceId:'generated-phone',deviceName:'Generated phone',platform:'android',status:'paused',queueDepth:0}})).statusCode,200);
 assert.equal((await f.state()).state,'unverified','a heartbeat proves contact, not a readable original');
 const note={id:randomUUID(),deviceId:'generated-phone',deviceName:'Generated phone',platform:'android',capturedAt:old,text:'Generated original: first collector record'};
 const send=()=>f.node.app.inject({method:'POST',url:'/api/notes',headers:collector,payload:note});
 const first=await send();assert.equal(first.statusCode,201,first.body);
 assert.deepEqual(first.json().receipt,{version:2,id:note.id,kind:'capture',state:'received',duplicate:false});
 const retry=await send();assert.equal(retry.statusCode,200,retry.body);assert.equal(retry.json().receipt.duplicate,true);
 const ready=await f.state();assert.equal(ready.state,'ready');assert.equal(ready.originalAvailable,true);assert.equal(ready.candidate.id,note.id);assert.equal(ready.candidate.deviceId,note.deviceId);assert.notEqual(ready.candidate.receivedAt,old);
 assert.equal(ready.candidate.receivedAt,f.node.store.db.prepare('SELECT received_at FROM captures WHERE id=?').get(note.id)!.received_at);
 assert.equal(Object.hasOwn(ready.candidate,'text'),false,'overview returns an identity, not original body');
 assert.equal((await f.node.app.inject({url:'/api/capture-browser/'+note.id,headers})).json().ocrText,note.text);
 await f.restart();assert.deepEqual((await f.state()).candidate,ready.candidate);
 assert.equal((await f.node.app.inject({url:'/api/capture-browser/'+note.id,headers})).json().ocrText,note.text);
});

test('image availability does not read payloads; original opening verifies complete bytes and disappearance never stays ready',async t=>{
 const f=await fixture(t),collector=await f.pair();
 const bytes=await sharp({create:{width:48,height:32,channels:3,background:'#725482'}}).png().toBuffer();
 const record={id:randomUUID(),deviceId:'generated-phone',deviceName:'Generated phone',platform:'android',source:'screen',capturedAt:old,durationMs:0,ocrText:'',ocr:{status:'disabled'},imageMime:'image/png',imageBase64:bytes.toString('base64')};
 const sent=await f.node.app.inject({method:'POST',url:'/api/captures',headers:collector,payload:record});assert.equal(sent.statusCode,201,sent.body);
 const read=f.node.store.assets.read,readBytes=f.node.store.assets.bytes;
 f.node.store.assets.read=()=>{throw Error('Overview must not load image payloads');};
 f.node.store.assets.bytes=function*(){throw Error('Overview must not read a whole physical part');};
 assert.equal((await f.state()).state,'ready');f.node.store.assets.read=read;f.node.store.assets.bytes=readBytes;
 const original=await f.node.app.inject({url:'/api/capture-browser/'+record.id+'/image',headers});assert.equal(original.statusCode,200,original.body);assert.deepEqual(original.rawPayload,bytes);
 const hash=f.node.store.imageReference(record.id)!.blobHash,path=join(f.node.store.assets.directory,hash,'0.plain');
 for(let n=0;n<6;n++)await sendMedia(f,collector,n);
 renameSync(path,path+'.fixture-missing');assert.equal((await f.state()).state,'received_unavailable');
 assert.notEqual((await f.node.app.inject({url:'/api/capture-browser/'+record.id+'/image',headers})).statusCode,200);
 renameSync(path+'.fixture-missing',path);assert.equal((await f.state()).state,'ready');
 const removed=await f.node.app.inject({method:'DELETE',url:'/api/captures/'+record.id,headers});assert.equal(removed.statusCode,200,removed.body);
 assert.equal((await f.state()).state,'unverified');
});

async function sendMedia(f:Awaited<ReturnType<typeof fixture>>,collector:Record<string,string>,n:number){
 const capturedAt=new Date(Date.parse(old)+1000+n).toISOString();
 const media={id:randomUUID(),deviceId:'generated-phone',deviceName:'Generated phone',platform:'android',source:'media',appId:'generated.player',appName:'Generated player',capturedAt,durationMs:0,ocrText:'',privacy:{collection:'content'},metadata:{version:1,observedAt:capturedAt,media:{status:'available',sessions:[{sessionId:'generated-session',appId:'generated.player',appName:'Generated player',playbackState:'playing',appVisibility:'background',playbackType:'local',title:'Generated chapter',positionMs:0}]}}};
 const response=await f.node.app.inject({method:'POST',url:'/api/captures',headers:collector,payload:media});assert.equal(response.statusCode,201,response.body);
}

test('media observations do not claim an original is missing or hide an older device original',async t=>{
 const f=await fixture(t),collector=await f.pair();
 for(let n=0;n<6;n++)await sendMedia(f,collector,n);
 const mediaOnly=await f.state();assert.equal(mediaOnly.state,'unverified');assert.equal(mediaOnly.originalAvailable,false);assert.equal(mediaOnly.candidate,undefined);
 const note={id:randomUUID(),deviceId:'generated-phone',deviceName:'Generated phone',platform:'android',capturedAt:old,text:'Generated older readable note'};
 assert.equal((await f.node.app.inject({method:'POST',url:'/api/notes',headers:collector,payload:note})).statusCode,201);
 for(let n=0;n<6;n++){
  const activity={id:randomUUID(),deviceId:note.deviceId,deviceName:note.deviceName,platform:'android',source:'activity',appId:'generated.activity',appName:'Generated activity',capturedAt:new Date(Date.parse(old)+2000+n).toISOString(),durationMs:1000,ocrText:'',privacy:{excluded:false,redacted:false,mode:'none',collection:'activity'}};
  const response=await f.node.app.inject({method:'POST',url:'/api/captures',headers:collector,payload:activity});assert.equal(response.statusCode,201,response.body);
 }
 const result=await f.state();assert.equal(result.state,'ready');assert.equal(result.candidate.id,note.id);
 assert.equal((await f.node.app.inject({url:'/api/capture-browser/'+note.id,headers})).json().ocrText,note.text);
});

test('a staged file is not received; committed file and its original bytes share identity; reference-only retention remains unchanged',async t=>{
 const f=await fixture(t),collector=await f.pair();
 await f.node.app.inject({method:'POST',url:'/api/devices/heartbeat',headers:collector,payload:{deviceId:'generated-phone',deviceName:'Generated phone',platform:'android',status:'paused',queueDepth:0}});
 const source={id:'generated-files',name:'Generated file source',kind:'local-files',deviceId:'generated-phone',platform:'android',retention:'archive'};
 assert.equal((await f.node.app.inject({method:'POST',url:'/api/sources',headers:collector,payload:source})).statusCode,200);
 const bytes=Buffer.from('Generated original file bytes, without a configured model.'),sha256=createHash('sha256').update(bytes).digest('hex');
 const manifest={sourceId:source.id,relativePath:'generated.txt',previousRevision:null,item:{externalId:'generated.txt',revision:'1',observedAt:old,title:'Generated original',kind:'file',layer:'original',text:'',mimeType:'text/plain',deleted:false},sha256,sizeBytes:bytes.length};
 const begin=await f.node.app.inject({method:'POST',url:'/api/file-sync/v1/uploads',headers:collector,payload:manifest});assert.equal(begin.statusCode,200,begin.body);
 assert.equal((await f.state()).state,'unverified');
 const part=await f.node.app.inject({method:'PUT',url:'/api/file-sync/v1/uploads/'+begin.json().uploadId+'/parts/0',headers:{...collector,'content-type':'application/octet-stream'},payload:bytes});assert.equal(part.statusCode,200,part.body);
 assert.equal((await f.state()).state,'unverified','uploaded parts are not a committed receipt');
 const commit=await f.node.app.inject({method:'POST',url:'/api/file-sync/v1/uploads/'+begin.json().uploadId+'/commit',headers:collector});assert.equal(commit.statusCode,200,commit.body);
 const id=commit.json().id;assert.equal(commit.json().receipt.state,'received');assert.equal((await f.state()).candidate.id,id);
 const original=await f.node.app.inject({url:'/api/files/'+id+'/content',headers});assert.equal(original.statusCode,200,original.body);assert.deepEqual(original.rawPayload,bytes);
 const version=f.node.files.version(id),stored=JSON.parse(version.manifest);
 f.node.store.db.prepare('UPDATE file_versions SET manifest=? WHERE capture_id=?').run(JSON.stringify({...stored,sizeBytes:bytes.length+1}),id);
 assert.equal((await f.state()).state,'received_unavailable','manifest and authoritative original size must agree');
 f.node.store.db.prepare('UPDATE file_versions SET manifest=? WHERE capture_id=?').run(version.manifest,id);
 assert.equal((await f.state()).state,'ready');
 const reference={...manifest,item:{...manifest.item,externalId:'reference.txt',revision:'1',layer:'reference'},relativePath:'reference.txt'};delete (reference as Partial<typeof manifest>).sha256;
 const ref=await f.node.app.inject({method:'PUT',url:'/api/file-sync/v1/revisions',headers:collector,payload:reference});assert.equal(ref.statusCode,200,ref.body);
 assert.equal(f.node.files.detail(ref.json().id).hasOriginal,false,'onboarding does not change source retention');
});

test('checks at most four eligible records without claiming the whole archive is empty',async t=>{
 const f=await fixture(t),collector=await f.pair();
 const note={id:randomUUID(),deviceId:'generated-phone',deviceName:'Generated phone',platform:'android',capturedAt:old,text:'Generated older readable note'};
 assert.equal((await f.node.app.inject({method:'POST',url:'/api/notes',headers:collector,payload:note})).statusCode,201);
 const bytes=await sharp({create:{width:48,height:32,channels:3,background:'#725482'}}).png().toBuffer();
 let imageId='';
 for(let n=0;n<6;n++){
  const capturedAt=new Date(Date.parse(old)+1000+n).toISOString();
  const image={id:randomUUID(),deviceId:note.deviceId,deviceName:note.deviceName,platform:'android',source:'screen',capturedAt,durationMs:0,ocrText:'',ocr:{status:'disabled'},imageMime:'image/png',imageBase64:bytes.toString('base64')};
  const response=await f.node.app.inject({method:'POST',url:'/api/captures',headers:collector,payload:image});assert.equal(response.statusCode,201,response.body);imageId=image.id;
 }
 const hash=f.node.store.imageReference(imageId)!.blobHash,path=join(f.node.store.assets.directory,hash,'0.plain');renameSync(path,path+'.fixture-missing');
 const result=await f.state();assert.equal(result.state,'received_unavailable');assert.equal(result.windowLimited,true);assert.equal(result.checkedRecords,4);assert.ok(result.candidate);
 assert.equal((await f.node.app.inject({url:'/api/capture-browser/'+note.id,headers})).statusCode,200,'the older record remains reachable through Library');
 for(let n=0;n<12;n++)f.node.store.heartbeat({deviceId:'generated-'+n,deviceName:'Generated bounded device',platform:'android',status:'paused',queueDepth:0});
 const bounded=await f.state();assert.equal(bounded.checkedDevices,8);assert.ok(bounded.checkedRecords<=32);assert.equal(bounded.windowLimited,true);
});
