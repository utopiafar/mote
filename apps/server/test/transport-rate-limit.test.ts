import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp,type QueryAgent} from '../src/app.js';
import type {Config} from '../src/config.js';

const inactive:QueryAgent={configured:false,query:async()=>{throw Error('No model call permitted');},close:async()=>{}};
async function fixture(t:TestContext){
 const dataDir=await mkdtemp(join(tmpdir(),'mote-transport-rate-'));
 const config:Config={dataDir,token:'generated-transport-rate-owner',tokenPath:join(dataDir,'token'),host:'127.0.0.1',port:0,maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
 const node=await buildApp(config,{agent:inactive,backgroundWorker:false});t.after(async()=>{await node.app.close();await rm(dataDir,{recursive:true,force:true});});return {...node,headers:{authorization:`Bearer ${config.token}`}};
}

test('owner transport saturation leaves status, files and authored notes available without unbounding ingress',async t=>{
 const {app,headers}=await fixture(t);
 for(let i=0;i<180;i++)assert.equal((await app.inject({method:'POST',url:'/api/sources',headers,payload:{}})).statusCode,400);
 const blocked=await app.inject({method:'POST',url:'/api/sources',headers,payload:{}});
 assert.equal(blocked.statusCode,429);assert.equal(blocked.json().error,'api_rate_limited');assert.ok(Number(blocked.headers['retry-after'])>0);
 // Another default transport endpoint cannot provide a fresh bucket; claimed headers are ignored.
 assert.equal((await app.inject({method:'POST',url:'/api/captures',headers:{...headers,'x-mote-rate-lane':'foreground'},payload:{}})).statusCode,429);
 for(const url of ['/api/status','/api/files','/api/notes'])assert.equal((await app.inject({url,headers})).statusCode,200,url);
 const saved=await app.inject({method:'POST',url:'/api/notes',headers,payload:{id:randomUUID(),deviceId:'generated-ui',deviceName:'Generated UI',platform:'import',capturedAt:new Date().toISOString(),text:'Generated foreground note during transport saturation.'}});
 assert.equal(saved.statusCode,201);
 // Existing expensive-route limits remain independent and strict; no configured model is invoked.
 let query;
 for(let i=0;i<11;i++)query=await app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated no-model request.'}});
 assert.equal(query!.statusCode,429);assert.equal(query!.json().error,'api_rate_limited');
 let imported;
 for(let i=0;i<11;i++)imported=await app.inject({method:'POST',url:'/api/imports',headers,payload:{}});
 assert.equal(imported!.statusCode,429);assert.equal(imported!.json().error,'api_rate_limited');
 assert.equal((await app.inject({url:'/api/status',headers})).statusCode,200);
});

test('unauthenticated traffic cannot gain separate lanes by changing paths, credentials or headers',async t=>{
 const {app,headers}=await fixture(t);
 // Public health requests exercise the actual unauthenticated IP budget; protected
 // routes reject missing/invalid credentials before their route limiter runs.
 for(let i=0;i<180;i++)assert.equal((await app.inject({url:'/api/health',headers:{authorization:`Bearer generated-invalid-${i}`,'x-mote-rate-lane':String(i)}})).statusCode,200);
 assert.equal((await app.inject({url:'/api/health',headers:{'x-mote-rate-lane':'new'}})).statusCode,429);
 for(const url of ['/api/status','/api/files','/api/file-sync/v1/capabilities'])assert.equal((await app.inject({url,headers:{'x-mote-rate-lane':url}})).statusCode,401);
 // Path/header changes cannot reset the public unauthenticated counter.
 assert.equal((await app.inject({url:'/api/health',headers:{authorization:'Bearer another-invalid','x-mote-rate-lane':'transport'}})).statusCode,429);
 assert.equal((await app.inject({url:'/api/status',headers})).statusCode,200,'unauthenticated saturation must not consume owner budget');
});

test('collector transport budgets stay per credential and do not change route authorization',async t=>{
 const {app,headers}=await fixture(t);
 async function pair(deviceId:string){
  const invite=await app.inject({method:'POST',url:'/api/connections/invitations',headers,payload:{serverUrl:'http://127.0.0.1:47832',label:deviceId}});
  assert.equal(invite.statusCode,200);
  const redeemed=await app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invite.json().invitation.code,deviceId,deviceName:deviceId,platform:'android'}});
  assert.equal(redeemed.statusCode,200);return {authorization:`Bearer ${redeemed.json().token}`,'x-mote-ingress-version':'2'};
 }
 const first=await pair('generated-a'),second=await pair('generated-b');
 for(let i=0;i<180;i++)assert.equal((await app.inject({url:'/api/file-sync/v1/capabilities',headers:first})).statusCode,200);
 assert.equal((await app.inject({url:'/api/file-sync/v1/capabilities',headers:first})).statusCode,429);
 assert.equal((await app.inject({url:'/api/file-sync/v1/capabilities',headers:second})).statusCode,200);
 assert.equal((await app.inject({url:'/api/files',headers:first})).statusCode,200);
 assert.equal((await app.inject({url:'/api/status',headers:first})).statusCode,403,'lane selection must not grant owner routes');
 assert.equal((await app.inject({url:'/api/status',headers})).statusCode,200);
});
