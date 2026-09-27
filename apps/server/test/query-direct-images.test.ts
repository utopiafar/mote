import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {parseAnswer,type ContextReader} from '@mote/agent';

test('an explicitly attached chat image is readable on demand and remains available to the dialogue',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'mote-query-images-')),token='generated-image-owner-token';
  const config:Config={dataDir,token,tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture-model',modelBaseUrl:'https://fixture.invalid',apiKey:'fixture-key',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
  const seen:string[][]=[];
  const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
    const ids=input.directImages?.map(image=>image.id)??[];seen.push(ids);
    assert.equal(ids.length,1);
    const records=await reader.evidence({ids});assert.equal(records[0].sourceType,'user_attachment');
    const image=await reader.readImage!({id:ids[0]});assert.equal(image.mimeType,'image/png');
    assert.ok(Buffer.from(image.data!,'base64').equals(bytes));
    const meta=await reader.readImage!({id:ids[0],view:'metadata'});assert.equal(meta.data,undefined);assert.equal(meta.imageView!.original.sha256,hash);
    const region=await reader.readImage!({id:ids[0],expectedImageSha256:hash,region:{x:0,y:0,width:1,height:2}});assert.equal(region.imageView!.output!.width,1);assert.equal(region.imageView!.original.sha256,hash);

    return {answer:'Generated image inspected',citations:[],trace:[],runId:randomUUID()};
  }})});
  t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#224466'}}).png().toBuffer();
  const hash=createHash('sha256').update(bytes).digest('hex');
  node.sources.register({id:'fixture-upload',name:'Generated upload',kind:'upload',deviceId:'fixture-device',platform:'import',retention:'archive'});
  const manifest={sourceId:'fixture-upload',item:{externalId:'generated-image',revision:'1',observedAt:'2026-09-24T01:00:00Z',title:'Generated image',kind:'file',layer:'original',text:'',mimeType:'image/png'},sha256:hash,sizeBytes:bytes.length};
  const upload=node.files.begin(manifest,()=>{});node.files.part(upload.uploadId,0,bytes,()=>{});
  const ack=await node.files.commit(upload.uploadId,()=>{});const attachmentId=ack.captureId;
  const headers={authorization:`Bearer ${token}`};
  const first=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Inspect this generated image',attachmentIds:[attachmentId]}});
  assert.equal(first.statusCode,200,first.body);const conversationId=first.json().conversationId;
  const page=(await node.app.inject({url:`/api/conversations/${conversationId}`,headers})).json();
  assert.deepEqual(page.turns[0].attachments,[{id:attachmentId,name:'Generated image',mimeType:'image/png'}]);
  const followup=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Look again',conversationId}});
  assert.equal(followup.statusCode,200,followup.body);
  assert.deepEqual(seen,[[attachmentId],[attachmentId]]);
});

test('the Agent bridge grants only the listed direct image without a screenshot discovery step',async t=>{
  const id=randomUUID(),data=Buffer.from('generated-image-fixture').toString('base64');
  const reader:ContextReader={search:async()=>[],timeline:async()=>[],evidence:async()=>[],activity:async()=>({}),devices:async()=>[],readImage:async()=>({mimeType:'image/png',data})};
  const {startBridge}=await import('../../../packages/agent/dist/bridge.js');
  const bridge=await startBridge(reader,{question:'Inspect this image',directImages:[{id,name:'Generated image',mimeType:'image/png',hash:'a'.repeat(64),sizeBytes:23}]},4);
  t.after(()=>bridge.close());
  const response=await fetch(bridge.url+'/read_image',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify({id})});
  assert.equal(response.status,200,await response.text());
  const citation=parseAnswer(JSON.stringify({answer:`Generated image [${id}]`,citationIds:[id]}),bridge.records).citations[0];
  assert.equal(citation.id,id);
  assert.equal((await fetch(bridge.url+'/read_image',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify({id:randomUUID()})})).status,400);
});

test('direct metadata grants never survive local-only changes or source deletion before a region read',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'mote-query-image-permission-')),token='generated-owner',bytes=await sharp({create:{width:4,height:4,channels:3,background:'#224466'}}).png().toBuffer(),hash=createHash('sha256').update(bytes).digest('hex');
 const config:Config={dataDir,token,tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture-model',modelBaseUrl:'https://fixture.invalid',apiKey:'fixture-key',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
 let revoke=()=>{},blocked=0;
 const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
  const id=input.directImages![0].id,meta=await reader.readImage!({id,view:'metadata'});assert.equal(meta.imageView!.original.sha256,hash);revoke();
  await assert.rejects(reader.readImage!({id,view:'metadata'}));await assert.rejects(reader.readImage!({id,expectedImageSha256:hash,region:{x:0,y:0,width:2,height:2}}));blocked++;
  return {answer:'Generated revoked image unavailable',citations:[],trace:[],runId:randomUUID()};
 }})});t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
 node.sources.register({id:'generated-upload',name:'Generated',kind:'upload',deviceId:'generated',platform:'import',retention:'archive'});
 for(const mode of ['local','deleted']){
  const manifest={sourceId:'generated-upload',item:{externalId:mode,revision:'1',observedAt:'2026-09-27T00:00:00Z',kind:'file',layer:'original',text:'',mimeType:'image/png'},sha256:hash,sizeBytes:bytes.length};
  const upload=node.files.begin(manifest,()=>{});node.files.part(upload.uploadId,0,bytes,()=>{});const ack=await node.files.commit(upload.uploadId,()=>{});
  revoke=()=>{if(mode==='local')node.store.db.prepare('UPDATE file_jobs SET local_only=1 WHERE capture_id=?').run(ack.captureId);else node.store.db.prepare('UPDATE source_heads SET deleted=1 WHERE source_id=? AND external_id=?').run('generated-upload',mode);};
  await node.app.inject({method:'POST',url:'/api/query',headers:{authorization:'Bearer '+token},payload:{question:'Generated revocation',attachmentIds:[ack.captureId]}});
 }
 assert.equal(blocked,2);
});
