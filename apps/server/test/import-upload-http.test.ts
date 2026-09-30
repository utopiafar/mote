import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import sharp from 'sharp';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {sha256} from '../src/store.js';

test('HTTP binary import archives exact generated image without a model, enforcing owner access and part limits',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-import-http-'));
 const config:Config={dataDir:directory,token:'generated-import-owner-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let modelCalls=0;
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,close:async()=>{},query:async()=>{modelCalls++;throw Error('Generated fixture must not query a model');}}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 await node.app.ready();
 const headers={authorization:'Bearer '+config.token};
 const bytes=await sharp({create:{width:32,height:24,channels:3,background:'#426789'}}).jpeg().toBuffer();
 const begin=await node.app.inject({method:'POST',url:'/api/import-uploads',headers,payload:{name:'generated.jpg',mimeType:'image/jpeg',sizeBytes:bytes.length}});
 assert.equal(begin.statusCode,200,begin.body);
 const upload=begin.json(),url=`/api/import-uploads/${upload.id}/parts/0`;
 const put=await node.app.inject({method:'PUT',url,headers:{...headers,'content-type':'application/octet-stream'},payload:bytes});
 assert.equal(put.statusCode,200,put.body);
 assert.equal(put.json().hash,sha256(bytes));
 const {invitation}=node.connections.invite({serverUrl:'http://127.0.0.1:3456',label:'Generated collector'});
 const collector=await node.connections.redeem({code:invitation.code,deviceId:'generated-collector',deviceName:'Generated',platform:'macos'});
 for(const [authorization,status] of [['',401],['Bearer '+collector.token,403]] as const){
  const denied=await node.app.inject({method:'PUT',url,headers:{authorization,'content-type':'application/octet-stream'},payload:bytes});
  assert.equal(denied.statusCode,status,denied.body);
 }
 const oversized=await node.app.inject({method:'PUT',url,headers:{...headers,'content-type':'application/octet-stream'},payload:Buffer.alloc(upload.partBytes+1)});
 assert.equal(oversized.statusCode,413,oversized.body);
 const replay=await node.app.inject({method:'PUT',url,headers:{...headers,'content-type':'application/octet-stream'},payload:bytes});
 assert.equal(replay.statusCode,200,replay.body);
 const committed=await node.app.inject({method:'POST',url:`/api/import-uploads/${upload.id}/commit`,headers});
 assert.equal(committed.statusCode,200,committed.body);
 const file=committed.json();
 const content=await node.app.inject({method:'GET',url:`/api/archived-files/${file.id}/content`,headers});
 assert.equal(content.statusCode,200);assert.equal(sha256(content.rawPayload),sha256(bytes));
 const created=await node.app.inject({method:'POST',url:'/api/imports',headers,payload:{name:'Generated archive without model',archivedFileIds:[file.id],processing:'automatic'}});
 assert.equal(created.statusCode,202,created.body);
 let job=created.json();
 for(let attempt=0;attempt<100&&!['needs_configuration','failed','completed'].includes(job.status);attempt++){
  await setTimeout(10);const response=await node.app.inject({method:'GET',url:`/api/imports/${job.id}`,headers});assert.equal(response.statusCode,200);job=response.json();
 }
 assert.equal(job.status,'needs_configuration');assert.equal(job.processingStatus,'blocked');
 assert.equal(job.files[0].id,file.id);assert.equal(job.preview,undefined);
 assert.equal(node.store.list().items.length,0);assert.equal(modelCalls,0);
 for(const table of ['model_usage','processing_usage'])assert.equal(node.store.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,0);
 const retained=await node.app.inject({method:'GET',url:`/api/archived-files/${file.id}/content`,headers});
 assert.equal(retained.statusCode,200);assert.equal(sha256(retained.rawPayload),sha256(bytes));
});
