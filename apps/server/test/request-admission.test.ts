import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp, type QueryAgent} from '../src/app.js';
import type {Config} from '../src/config.js';
import {sha256} from '../src/store.js';

const inactive:QueryAgent={configured:false,query:async()=>{throw Error('No model call permitted');},close:async()=>{}};
async function fixture(t:TestContext, agent=inactive){
  const dataDir=await mkdtemp(join(tmpdir(),'mote-request-admission-'));
  const config:Config={dataDir,token:'generated-request-admission-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:200_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
  const node=await buildApp(config,{agent,backgroundWorker:false});
  t.after(async()=>{await node.app.close();await rm(dataDir,{recursive:true,force:true});});
  return {...node,config,headers:{authorization:`Bearer ${config.token}`}};
}

test('real HTTP capture bursts and foreground reads have no request quota; authorization remains enforced',async t=>{
  const {app,store,headers}=await fixture(t);
  const base=await app.listen({host:'127.0.0.1',port:0});
  for(let i=0;i<220;i++){
    const captured=await fetch(base+'/api/captures',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),deviceId:'generated-device',deviceName:'Generated device',platform:'macos',source:'activity',capturedAt:new Date().toISOString(),durationMs:1000,appId:'fixture.app',appName:'Generated app',privacy:{excluded:false,redacted:false,mode:'none',collection:'activity'}})});
    assert.equal(captured.status,201,await captured.text());
    assert.equal(captured.headers.get('x-ratelimit-limit'),null);
    const read=await fetch(base+'/api/status',{headers});assert.equal(read.status,200);await read.arrayBuffer();
  }
  assert.equal(store.stats().captures,220);
  for(let i=0;i<200;i++){
    const health=await fetch(base+'/api/health');assert.equal(health.status,200);await health.arrayBuffer();
  }
  const denied=await fetch(base+'/api/status');assert.equal(denied.status,401);await denied.arrayBuffer();
  const note=await fetch(base+'/api/notes',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),deviceId:'generated-ui',deviceName:'Generated UI',platform:'import',capturedAt:new Date().toISOString(),text:'Generated note after capture and read bursts.'})});
  assert.equal(note.status,201,await note.text());
});

test('former per-route quotas never replace validation or model configuration errors',async t=>{
  const {app,headers}=await fixture(t);
  for(const [url,payload,status] of [
    ['/api/query',{question:'Generated question'},503],
    ['/api/query-runs',{id:randomUUID(),input:{question:'Generated question'}},503],
    ['/api/imports',{},400],
    ['/api/model-settings/test',{},400],
    ['/api/insight-runs',{requestId:randomUUID()},503],
  ] as const){
    for(let i=0;i<25;i++){
      const result=await app.inject({method:'POST',url,headers,payload});assert.equal(result.statusCode,status,result.body);
      assert.equal(result.headers['retry-after'],undefined);
    }
  }
  for(let i=0;i<130;i++)assert.equal((await app.inject({method:'POST',url:'/api/login/ticket',headers,payload:{}})).statusCode,200);
});

test('more than 64 pending browser uploads survive restart, and more than 600 part replays preserve exact original bytes',async t=>{
  const {app,store,config,headers}=await fixture(t),bytes=Buffer.from('Generated durable original');
  let selected:{id:string}|undefined;
  for(let i=0;i<70;i++){
    const begun=await app.inject({method:'POST',url:'/api/import-uploads',headers,payload:{name:`generated-${i}.txt`,sizeBytes:bytes.length}});
    assert.equal(begun.statusCode,200,begun.body);selected=begun.json();
  }
  assert.equal(store.db.prepare('SELECT count(*) n FROM import_uploads').get()!.n,70);
  for(let i=0;i<620;i++){
    const part=await app.inject({method:'PUT',url:`/api/import-uploads/${selected!.id}/parts/0`,headers:{...headers,'content-type':'application/octet-stream'},payload:bytes});
    assert.equal(part.statusCode,200,part.body);assert.equal(part.json().hash,sha256(bytes));
  }
  await app.close();
  const restarted=await buildApp(config,{agent:inactive,backgroundWorker:false});
  try{
    const replay=await restarted.app.inject({method:'POST',url:'/api/import-uploads',headers,payload:{id:selected!.id,name:'generated-69.txt',sizeBytes:bytes.length}});
    assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().parts.length,1);
    assert.equal(restarted.store.db.prepare('SELECT count(*) n FROM import_uploads').get()!.n,70);
    const committed=await restarted.app.inject({method:'POST',url:`/api/import-uploads/${selected!.id}/commit`,headers});assert.equal(committed.statusCode,200,committed.body);
    const read=await restarted.app.inject({url:`/api/archived-files/${committed.json().id}/content`,headers});assert.equal(read.statusCode,200);assert.deepEqual(read.rawPayload,bytes);
  }finally{await restarted.app.close();}
});

test('more than 1000 pending queries are accepted through the API while execution stays within configured concurrency',{timeout:120000},async t=>{
  let active=0,maxActive=0;
  const agent:QueryAgent={configured:true,close:async()=>{},query:async input=>{
    active++;maxActive=Math.max(maxActive,active);
    try{await new Promise<void>(resolve=>{if(input.signal?.aborted)resolve();else input.signal!.addEventListener('abort',()=>resolve(),{once:true});});input.signal!.throwIfAborted();throw Error('Generated query should be interrupted');}
    finally{active--;}
  }};
  const {app,store,headers,featureServices}=await fixture(t,agent);
  const id=randomUUID(),payload={id,input:{question:'Generated queued query'}};
  for(let i=0;i<1001;i++){
    const admitted=await app.inject({method:'POST',url:'/api/query-runs',headers,payload:i===0?payload:{...payload,id:randomUUID()}});
    assert.equal(admitted.statusCode,202,admitted.body);
  }
  assert.equal(store.db.prepare("SELECT count(*) n FROM query_runs WHERE json_extract(json,'$.status')='running'").get()!.n,1001);
  assert.ok(maxActive>0);assert.ok(maxActive<=featureServices.runtimeSettings.execution().interactiveConcurrency);
  assert.equal((await app.inject({method:'POST',url:'/api/query-runs',headers,payload})).statusCode,202);
  assert.equal((await app.inject({method:'POST',url:'/api/query-runs',headers,payload:{...payload,input:{question:'Changed identity'}}})).statusCode,409);
  const cancelled=await app.inject({method:'POST',url:`/api/query-runs/${id}/cancel`,headers});assert.equal(cancelled.statusCode,200);assert.equal(cancelled.json().status,'cancelled');
});
