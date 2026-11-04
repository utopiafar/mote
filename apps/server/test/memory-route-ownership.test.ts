import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {memoryEvidenceFingerprint} from '../src/memory.js';
import {memorySchema} from '../src/memory-schema.js';

const token='generated-memory-route-owner';
const headers={authorization:'Bearer '+token};
const config=(dataDir:string):Config=>({dataDir,token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'https://generated.invalid/v1',apiKey:'generated-unused',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent'});

async function open(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-routes-'));
  const node=await buildApp(config(directory),{backgroundWorker:false,agent:{configured:false,close:async()=>{},query:async()=>{throw Error('Generated route fixture must not call a model');}}});
  await node.app.ready();
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const request=(method:'GET'|'POST'|'PUT'|'DELETE',url:string,payload?:unknown)=>node.app.inject({method,url,headers,payload:payload as never});
  return {node,request};
}

const snapshot=(value:unknown):unknown=>{
  if(Array.isArray(value))return value.map(snapshot);
  if(value===null)return 'null';
  if(typeof value==='object')return Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([key,item])=>[key,snapshot(item)]));
  return typeof value;
};

test('the transitional feature service bridge is gone and Memory routes stay plugin-owned',()=>{
  assert.equal(existsSync(new URL('../src/feature-services/',import.meta.url)),false);
  assert.equal(existsSync(new URL('../src/feature-services.ts',import.meta.url)),false);
  assert.equal(existsSync(new URL('../src/feature-host.ts',import.meta.url)),false);
  assert.equal(existsSync(new URL('../src/agent-feature-host.ts',import.meta.url)),false);
});

/** [K] These literal shapes are the Web Memory page's current reads. A route
 * that moves owner but changes its serialized envelope fails this snapshot. */
test('Web Memory settings, recipes, integrations and job pages keep their real HTTP response structure',async t=>{
  const {request}=await open(t);
  const lifecycleExtension={id:'string',version:'string',stream:'string',pendingChanges:'number',dueAt:'number',cursor:'number',failures:'number',maxAttempts:'number',manualRetryRequired:'boolean',trigger:'string',status:'string'};
  const lifecycleExtensionWithoutAttempts={id:'string',version:'string',stream:'string',pendingChanges:'number',dueAt:'number',cursor:'number',failures:'number',manualRetryRequired:'boolean',trigger:'string',status:'string'};
  const recipeItem={id:'string',version:'string',extract:{id:'string',version:'string'},review:{id:'string',version:'string'},workContract:'string',available:'boolean',binding:{recipe:{id:'string',version:'string',fingerprint:'string'},extract:{id:'string',version:'string',fingerprint:'string'},review:{id:'string',version:'string',fingerprint:'string'},workContract:'string'}};
  const recipeWithRequires={...recipeItem,requires:['string'],binding:{...recipeItem.binding,requires:['string']}};
  const expected:{
    '/api/memory-settings':unknown;
    '/api/memory-recipes':unknown;
    '/api/memory-integration-recipes':unknown;
    '/api/memory-integration-settings':unknown;
    '/api/memory-recipe-settings':unknown;
    '/api/memory-jobs':unknown;
  }={
    '/api/memory-settings':{revision:'number',settings:{extraction:{enabled:'boolean',intervalHours:'number',minChanges:'number',maxItems:'number'},consolidation:{enabled:'boolean',intervalHours:'number',minChanges:'number',maxItems:'number'},insights:{enabled:'boolean',intervalHours:'number',minChanges:'number',maxItems:'number'},working:{enabled:'boolean',intervalHours:'number',minChanges:'number',maxItems:'number'},drainWindows:'number',batchCharacters:'number',recentTurns:'number',contextCharacters:'number',summaryCharacters:'number'},trigger:'string',storage:'string',extensions:[lifecycleExtension,lifecycleExtension,lifecycleExtensionWithoutAttempts,lifecycleExtensionWithoutAttempts]},
    '/api/memory-recipes':{items:[recipeItem,recipeItem,recipeWithRequires,recipeWithRequires]},
    '/api/memory-integration-recipes':{items:[{id:'string',version:'string',integrate:{id:'string',version:'string'},review:{id:'string',version:'string'},available:'boolean',binding:{recipe:{id:'string',version:'string',fingerprint:'string'},integrate:{id:'string',version:'string',fingerprint:'string'},review:{id:'string',version:'string',fingerprint:'string'}}}]},
    '/api/memory-integration-settings':{activation:'string',afterSequence:'number',binding:{recipe:{id:'string',version:'string',fingerprint:'string'},integrate:{id:'string',version:'string',fingerprint:'string'},review:{id:'string',version:'string',fingerprint:'string'}},available:'boolean'},
    '/api/memory-recipe-settings':{sourceId:'null',inherited:'boolean',items:[{binding:recipeItem.binding,available:'boolean'}]},
    '/api/memory-jobs':{items:[],nextCursor:'null'},
  };
  for(const [url,shape] of Object.entries(expected)){
    const response=await request('GET',url);
    assert.equal(response.statusCode,200,url+' '+response.body);
    assert.deepEqual(snapshot(response.json()),shape,url);
  }
});

/** [M] Publication is one owner. Disabling its activation fences the owner
 * writes while the C21/C22 read owners keep serving the same mounted routes. */
test('disabling the publication plugin returns 503 for write routes while Memory reads remain available',async t=>{
  const {node,request}=await open(t);
  const at='2026-10-12T00:00:00Z',evidenceId=randomUUID();
  await node.store.ingest({id:evidenceId,deviceId:'generated-device',deviceName:'Generated',platform:'import',source:'message',capturedAt:at,durationMs:0,appId:'generated',appName:'Generated',ocrText:'Generated Memory route evidence.',privacy:{excluded:false,redacted:false,mode:'none'}});
  const memory=memorySchema.parse({id:randomUUID(),version:1,title:'Generated route proposal',statement:'Generated route body.',uncertainty:'Generated only',status:'proposed',domain:'personal',tier:'episode',kind:'episodic',createdAt:at,evidenceIds:[evidenceId],evidence:[],model:'fixture',runId:'fixture',fingerprint:memoryEvidenceFingerprint(node.store.evidence([evidenceId])[0]),admission:{layer:'memory',reason:'Generated',scope:'Generated fixture',attribution:'observed'}});
  node.store.db.prepare('INSERT INTO memories(id,created_at,json) VALUES(?,?,?)').run(memory.id,at,JSON.stringify(memory));
  node.store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(memory.id,evidenceId);

  node.memoryPublicationService.quiesce('disabled');
  for(const [method,url,payload] of [
    ['POST','/api/memories/'+memory.id+'/publish',{}],
    ['POST','/api/memories/'+memory.id+'/correct',{version:1,title:'Generated corrected route',statement:'Generated corrected body.'}],
    ['DELETE','/api/memories/'+memory.id,undefined],
    ['POST','/api/memories/extract',{}],
  ] as const){
    const response=await request(method,url,payload);
    assert.equal(response.statusCode,503,`${method} ${url}: ${response.body}`);
  }
  for(const url of ['/api/memory-settings','/api/memory-recipes','/api/memory-integration-settings','/api/memory-jobs']){
    const response=await request('GET',url);
    assert.equal(response.statusCode,200,`${url}: ${response.body}`);
  }

  node.memoryPublicationService.start();
  const published=await request('POST','/api/memories/'+memory.id+'/publish',{});
  assert.equal(published.statusCode,200,published.body);
  assert.equal(published.json().id,memory.id);
  assert.equal(published.json().status,'published');
});
