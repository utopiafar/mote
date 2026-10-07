import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

test('production routing accepts generated composite work IDs and maximum source IDs',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-router-parameters-')),token='generated-router-owner-token';
 const web=join(dir,'generated-web');mkdirSync(join(web,'assets'),{recursive:true});
 writeFileSync(join(web,'index.html'),'<!doctype html><title>Generated router fixture</title>');
 writeFileSync(join(web,'assets','fixture.js'),'/* Generated asset */');
 writeFileSync(join(web,'build-info.json'),JSON.stringify({version:JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version}));
 const config:Config={dataDir:dir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:10000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
 const node=await buildApp(config,{webRoot:web,agent:{configured:false,query:async()=>{throw Error('No model in fixtures');},close:async()=>{}}});
 t.after(async()=>{await node.app.close();rmSync(dir,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+token},sourceId='generated:'+ 's'.repeat(118);
 assert.equal((await node.app.inject('/assets/fixture.js')).statusCode,200);
 const spa=await node.app.inject('/activity');assert.equal(spa.statusCode,200);assert.match(spa.body,/Generated router fixture/);
 const missingAsset=await node.app.inject('/assets/missing.js');assert.equal(missingAsset.statusCode,404);assert.equal(missingAsset.json().error,'not_found');
 const missingApi=await node.app.inject({url:'/api/generated-missing',headers});assert.equal(missingApi.statusCode,404);assert.equal(missingApi.json().error,'not_found');
 assert.equal(sourceId.length,128);
 node.sources.register({id:sourceId,name:'Generated maximum-length source',kind:'custom',deviceId:'generated',platform:'import'});
 node.executor.register({kind:'fixture.router',pool:'fixture.router',concurrency:()=>1,validate:()=>true,execute:async()=>null,commit:()=>{}});
 const ids=[`source:local-${'a'.repeat(36)}:${'b'.repeat(64)}`,`source:${sourceId}:${'c'.repeat(64)}`];
 for(const id of ids)node.executor.enqueue(id,'fixture.router',{}, {initial:{state:'succeeded',attempts:1,availableAt:0}});
 const page=await node.app.inject({url:'/api/work-activity?state=completed',headers});
 assert.equal(page.statusCode,200);
 for(const id of ids){
  assert.ok(page.json().items.some((item:{id:string})=>item.id===id));
  for(const encoded of [id,encodeURIComponent(id)]){
   const url='/api/work-activity/'+encoded;
   const detail=await node.app.inject({url,headers});assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().id,id);
   assert.equal((await node.app.inject({url})).statusCode,401);
   const operation=await node.app.inject({url:'/api/operations/'+encoded,headers});assert.equal(operation.statusCode,200,operation.body);assert.equal(operation.json().operation.id,id);
  }
 }
 for(const [route,limit] of [['work-activity',512],['operations',256]] as const){
  const id='source:'+ '界'.repeat(limit-7);
  node.executor.enqueue(id,'fixture.router',{}, {initial:{state:'succeeded',attempts:1,availableAt:0}});
  const response=await node.app.inject({url:`/api/${route}/${encodeURIComponent(id)}`,headers});
  assert.equal(response.statusCode,200,response.body);
  assert.equal(route==='work-activity'?response.json().id:response.json().operation.id,id);
 }
 for(const url of [`/api/sources/${encodeURIComponent(sourceId)}/items`,`/api/sources/${encodeURIComponent(sourceId)}/catalog`,`/api/sources/${encodeURIComponent(sourceId)}/read-requests`,`/api/source-pipelines/${encodeURIComponent(sourceId)}`]){
  assert.equal((await node.app.inject({url,headers})).statusCode,200,url);
 }
 const {invitation}=node.connections.invite({label:'Generated paired owner',serverUrl:'http://127.0.0.1',deviceId:'generated'});
 const pairedOwner=await node.connections.redeem({code:invitation.code,deviceId:'generated',deviceName:'Generated',platform:'android'});
 for(const route of ['work-activity','operations'])assert.equal((await node.app.inject({url:`/api/${route}/${encodeURIComponent(ids[0])}`,headers:{authorization:'Bearer '+pairedOwner.token}})).statusCode,200);
 for(const [route,limit] of [['work-activity',512],['operations',256]] as const){
  assert.equal((await node.app.inject({url:`/api/${route}/${'x'.repeat(limit)}`,headers})).statusCode,404,'valid but missing ID');
  assert.equal((await node.app.inject({url:`/api/${route}/${'x'.repeat(limit+1)}`,headers})).statusCode,400,'business validation remains active');
 }
 for(const encoded of ['x'.repeat(1025),encodeURIComponent('界'.repeat(1025))]){
  const response=await node.app.inject({url:'/api/work-activity/'+encoded,headers:{...headers,'accept-language':'en'}});
  assert.equal(response.statusCode,414);assert.equal(response.json().error,'request_path_too_long');
  assert.equal(response.json().message,'The request path is too long. Check the link.');
  assert.equal(response.json().requestId,response.headers['x-request-id']);
  assert.equal(response.headers['content-language'],'en');assert.equal(response.headers['cache-control'],'no-store');
  assert.ok(!response.body.includes(encoded),'rejected IDs are not disclosed');
 }
 assert.equal((await node.app.inject({url:'/api/work-activity/'+ 'x'.repeat(1024),headers})).statusCode,400,'routing boundary reaches business validation');
 assert.equal((await node.app.inject({url:'/api/work-activity/%ZZ',headers})).statusCode,400,'malformed URL handling is preserved');
 const address=await node.app.listen({host:'127.0.0.1',port:0});
 const detail=await fetch(address+'/api/work-activity/'+encodeURIComponent(ids[0]),{headers});
 assert.equal(detail.status,200);assert.equal((await detail.json()).id,ids[0]);
 const oversized=await fetch(address+'/api/work-activity/'+ 'x'.repeat(1025),{headers});
 assert.equal(oversized.status,414);assert.equal((await oversized.json()).error,'request_path_too_long');
});
