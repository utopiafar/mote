import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

async function fixture(t:TestContext){
 const dataDir=await mkdtemp(join(tmpdir(),'mote-insight-history-'));
 const config:Config={dataDir,token:'generated-discovery-history-owner',tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
 const value=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('Read-only history cannot call a model');},close:async()=>{}}});
 t.after(async()=>{await value.app.close();await rm(dataDir,{recursive:true,force:true});});
 const ids=Array.from({length:67},()=>randomUUID());
 for(const [index,id] of ids.entries())value.store.saveInsight({runId:id,answer:'Generated saved finding '+index,citations:[],trace:[]},id);
 value.store.db.prepare('UPDATE insights SET created_at=?').run('2026-10-01T00:00:00.000Z');
 return {...value,ids,headers:{authorization:'Bearer '+config.token}};
}

test('saved discovery history visits every same-time result exactly once and reads an old result directly',async t=>{
 const {app,ids,headers,store}=await fixture(t),seen:string[]=[];let cursor:string|null=null;
 do{
  const response=await app.inject({url:'/api/insights?limit=13'+(cursor?'&cursor='+cursor:''),headers});assert.equal(response.statusCode,200,response.body);
  const page=response.json();assert.ok(page.items.length<=13);seen.push(...page.items.map((item:any)=>item.runId));cursor=page.nextCursor;
 }while(cursor);
 assert.deepEqual(seen,[...ids].sort().reverse());assert.equal(new Set(seen).size,67);
 const first=(await app.inject({url:'/api/insights',headers})).json();assert.equal(first.items.length,30);assert.ok(first.nextCursor);
 const oldest=seen.at(-1)!;assert.ok(!first.items.some((item:any)=>item.runId===oldest));
 const exact=await app.inject({url:'/api/insights/'+oldest,headers});assert.equal(exact.statusCode,200,exact.body);assert.equal(exact.json().runId,oldest);assert.equal(exact.json().createdAt,'2026-10-01T00:00:00.000Z');
 const inserted=randomUUID();store.saveInsight({runId:inserted,answer:'Generated later finding',citations:[],trace:[]},inserted);
 const continuation=(await app.inject({url:'/api/insights?cursor='+first.nextCursor,headers})).json();assert.ok(continuation.items.every((item:any)=>!first.items.some((before:any)=>before.runId===item.runId)));
 for(const query of ['limit=0','limit=101','cursor=not-json','limit=1&unknown=true'])assert.equal((await app.inject({url:'/api/insights?'+query,headers})).statusCode,400,query);
});

test('published result reads reject collector and MCP credentials while preserving owner access',async t=>{
 const {app,connections,headers,ids}=await fixture(t);
 const {invitation}=connections.invite({serverUrl:'https://fixture.invalid',label:'Generated collector'},'collector');
 const collector=await connections.redeem({code:invitation.code,deviceId:'generated-discovery-collector',deviceName:'Generated device',platform:'android'});
 const tokens=[collector.token];
 for(const access of ['read','write'] as const){
  const grant=await connections.mintMcp({serverUrl:'https://fixture.invalid',label:'Generated '+access,access},{mcpEnabled:true,mcpWriteEnabled:true,mcpWriteSourceIds:['generated-source'],directory:'unused'});
  tokens.push(grant.config.mcpServers.mote.headers.Authorization.slice(7));
 }
 const owner=await connections.session('https://fixture.invalid','Generated owner browser');
 for(const path of ['/api/insights?limit=1','/api/insights/'+ids[0]]){
  assert.equal((await app.inject({url:path})).statusCode,401);
  for(const token of tokens)assert.equal((await app.inject({url:path,headers:{authorization:'Bearer '+token}})).statusCode,403);
  for(const authorization of [headers.authorization,'Bearer '+owner.token])assert.equal((await app.inject({url:path,headers:{authorization}})).statusCode,200);
 }
});

test('deleting an original invalidates history cursors and exact reports without changing the existing deletion policy',async t=>{
 const {app,ids,headers}=await fixture(t),id=randomUUID();
 const saved=await app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-note-device',deviceName:'Generated device',platform:'android',capturedAt:'2026-10-01T00:00:00.000Z',text:'Generated original for deletion'}});assert.equal(saved.statusCode,201,saved.body);
 const first=(await app.inject({url:'/api/insights?limit=2',headers})).json();assert.ok(first.nextCursor);
 assert.equal((await app.inject({method:'DELETE',url:'/api/notes/'+id,headers})).statusCode,200);
 assert.equal((await app.inject({url:'/api/insights?cursor='+first.nextCursor,headers})).statusCode,409);
 assert.equal((await app.inject({url:'/api/insights/'+ids[0],headers})).statusCode,404);
 assert.deepEqual((await app.inject({url:'/api/insights',headers})).json(),{items:[],nextCursor:null});
});
