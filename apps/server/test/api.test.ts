import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';

export const testConfig=(dataDir:string):Config=>({dataDir,token:'fixture-token-never-use-in-production',tokenPath:'fixture-only',host:'127.0.0.1',port:47832,dataKey:undefined,maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''});
test('authenticated ingestion, source history, export/import and unavailable AI are honest',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-api-test-'));const config=testConfig(dir);
  const {app}=await buildApp(config,{agent:{configured:false,query:async()=>{throw Error('should not run');},close:async()=>{}}});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${config.token}`};
  assert.equal((await app.inject('/api/health')).statusCode,200);
  assert.equal((await app.inject('/api/captures')).statusCode,401);
  assert.equal((await app.inject('/api/software-update')).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/api/software-update/check'})).statusCode,401);
  const update=(await app.inject({url:'/api/software-update',headers})).json();
  assert.equal(update.state,'idle');assert.equal(update.verified,false);
  assert.equal((await app.inject({method:'POST',url:'/api/software-update/check',headers,payload:{url:'https://attacker.invalid'}})).statusCode,400);
  assert.equal((await app.inject({url:'/api/status',headers:{authorization:'Bearer wrong'}})).statusCode,401);
  const f={id:randomUUID(),deviceId:'test',deviceName:'Synthetic',platform:'import',capturedAt:'2026-09-12T12:00:00Z',durationMs:0,ocrText:'测试导入资料',source:'note'};
  assert.equal((await app.inject({method:'POST',url:'/api/captures',headers,payload:f})).statusCode,201);
  assert.equal((await app.inject({method:'POST',url:'/api/captures',headers,payload:f})).statusCode,200);
  assert.equal((await app.inject({url:'/api/captures',headers})).json().items.length,1);
  assert.equal((await app.inject({url:'/api/captures?after=oops',headers})).statusCode,400);
  assert.equal((await app.inject({url:'/api/captures?cursor=bad',headers})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/query',headers,payload:{question:'有待办吗'}})).statusCode,503);
  const archive=(await app.inject({url:'/api/export',headers})).json();
  assert.equal((await app.inject({method:'POST',url:'/api/import',headers,payload:archive})).json().duplicates,1);
  assert.equal((await app.inject({method:'DELETE',url:`/api/captures/${f.id}`,headers})).json().deleted,1);
});
test('arbitrary user questions pass unmodified to the agent, no keyword routing',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-agent-api-test-'));const config=testConfig(dir);const questions:string[]=[];
  const {app}=await buildApp(config,{agent:{configured:true,query:async args=>{questions.push(args.question);return {answer:'synthetic agent fixture',citations:[],trace:[],runId:randomUUID()};},close:async()=>{}}});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${config.token}`};
  for(const question of ['检索待办','What changed about my plan?','昨天我在想什么，依据在哪'])assert.equal((await app.inject({method:'POST',url:'/api/query',headers,payload:{question}})).statusCode,200);
  assert.deepEqual(questions,['检索待办','What changed about my plan?','昨天我在想什么，依据在哪']);
});
test('deleting evidence during an insight run cannot recreate a saved private insight',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-delete-race-test-'));const config=testConfig(dir);
  let resolveAnswer!:(value:any)=>void;let started!:()=>void;
  const begun=new Promise<void>(r=>{started=r;});
  const {app}=await buildApp(config,{agent:{configured:true,query:async()=>{started();return new Promise(r=>{resolveAnswer=r;});},close:async()=>{}}});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${config.token}`};const id=randomUUID();
  const record={id,deviceId:'test',deviceName:'Synthetic',platform:'import',capturedAt:'2026-09-12T12:00:00Z',durationMs:0,ocrText:'synthetic private fact',source:'note'};
  await app.inject({method:'POST',url:'/api/captures',headers,payload:record});
  const running=app.inject({method:'POST',url:'/api/insights',headers,payload:{}}).then(r=>r);await begun;
  await app.inject({method:'DELETE',url:`/api/captures/${id}`,headers});
  resolveAnswer({answer:'obsolete synthetic fact',citations:[{id,capturedAt:record.capturedAt,appName:'',excerpt:record.ocrText}],trace:[],runId:randomUUID()});
  assert.equal((await running).statusCode,409);assert.equal((await app.inject({url:'/api/insights',headers})).json().items.length,0);
  assert.equal((await app.inject({method:'POST',url:'/api/captures',headers,payload:record})).statusCode,410);
});

test('queries and insights validate and preserve device and display time zone scope',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-query-scope-'));const config=testConfig(dir);const seen:any[]=[];
  const {app}=await buildApp(config,{agent:{configured:true,query:async args=>{seen.push(args);return {answer:'synthetic scope',citations:[],trace:[],runId:randomUUID()};},close:async()=>{}}});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${config.token}`};
  for(const url of ['/api/query','/api/insights']){
    const payload={...(url==='/api/query'?{question:'arbitrary input'}:{}),deviceId:'synthetic-device',timeZone:'Asia/Shanghai',after:'2026-06-01T00:00:00+08:00',before:'2026-06-12T00:00:00+08:00'};
    assert.equal((await app.inject({method:'POST',url,headers,payload})).statusCode,200);
    assert.equal(seen.at(-1).deviceId,payload.deviceId);assert.equal(seen.at(-1).timeZone,payload.timeZone);
    assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,timeZone:'Invalid/Zone'}})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,before:payload.after}})).statusCode,400);
  }
  assert.equal(seen.length,2);
});
