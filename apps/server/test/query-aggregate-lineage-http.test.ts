import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startBridge} from '../../../packages/agent/dist/bridge.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

for(const transition of ['heartbeat','delete-before-followup','delete-during-query'] as const)test(`formal Ask aggregate lineage survives ${transition} with precise original and device scope`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-aggregate-query-')),token='generated-aggregate-owner',headers={authorization:'Bearer '+token},id=randomUUID();let node!:Awaited<ReturnType<typeof buildApp>>,calls=0,fixtureFailure:unknown;
 const cfg:Config={dataDir:directory,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 node=await buildApp(cfg,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async input=>{
  calls++;const bridge=await startBridge(node.featureServices.archiveReader,input);
  try{
   const call=async(tool:string,args:unknown)=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
   const capability=async(name:string)=>{const found=await call('capability_discover',{name});return call('capability_execute',{name,version:found.data.version,argumentsJson:'{}'});};
   const activity=await capability('activity'),devices=await capability('devices');assert.equal(devices.data.length,1);assert.equal(devices.data[0].deviceId,'generated-selected');assert.ok(devices.data[0].directoryObservedAt);assert.equal(devices.data[0].metadata.observedAt,'2026-10-01T00:00:00Z');
   assert.ok(!JSON.stringify({activity,devices}).includes('disclosureDependencies'));assert.equal(bridge.records.size,0,'aggregate and device metadata do not grant original body citations');assert.equal(bridge.evidenceDependencies.complete,true);
   if(calls===1){assert.ok(bridge.evidenceDependencies.ids.includes(id));if(transition==='delete-during-query')node.store.delete(id);else node.store.heartbeat({deviceId:'generated-selected',deviceName:'Generated updated heartbeat',platform:'android',status:'offline',queueDepth:0,metadata:{version:1,observedAt:'2026-10-01T00:00:00Z'}});}
   if(calls===2){assert.ok(input.conversation);assert.equal(input.conversation.turns[0].evidenceDeleted,undefined);if(transition==='delete-before-followup'){assert.equal(input.conversation.turns[0].evidenceUnavailable,true);assert.equal(input.conversation.turns[0].answer,'Generated aggregate snapshot only.');assert.equal(activity.data.captures,0);assert.ok(bridge.evidenceDependencies.ids.includes(id),'saved dialogue retains its original lineage so privacy revocation still invalidates derived answers');assert.deepEqual(node.store.evidence([id]),[]);}else assert.ok(bridge.evidenceDependencies.ids.includes(id));}
   return {answer:'Generated aggregate snapshot only.',citations:[],trace:bridge.trace,runId:randomUUID(),evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies};
  }catch(error){fixtureFailure=error;throw error;}finally{await bridge.close();}
 }}});t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 node.store.heartbeat({deviceId:'generated-selected',deviceName:'Generated selected',platform:'android',status:'online',queueDepth:0,metadata:{version:1,observedAt:'2026-10-01T00:00:00Z'}});node.store.heartbeat({deviceId:'generated-hidden',deviceName:'Generated outside device',platform:'android',status:'online',queueDepth:0});
 await node.store.ingest({id,deviceId:'generated-selected',deviceName:'Generated selected',platform:'android',source:'activity',capturedAt:'2026-10-01T01:00:00Z',durationMs:30000,ocrText:'',appId:'generated.app',appName:'Generated app',privacy:{excluded:false,redacted:false,mode:'none',collection:'activity'}});
 const first=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated aggregate question',deviceId:'generated-selected'}});
 if(fixtureFailure)throw fixtureFailure;
 if(transition==='delete-during-query'){assert.equal(first.statusCode,409,first.body);assert.ok(node.conversations.list().items.every(item=>item.status==='failed'));return;}
 assert.equal(first.statusCode,200,first.body);assert.equal(first.json().evidenceDependencies.complete,true);if(transition==='delete-before-followup')node.store.delete(id);
 const second=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated aggregate follow-up',conversationId:first.json().conversationId,deviceId:'generated-selected'}});if(fixtureFailure)throw fixtureFailure;assert.equal(second.statusCode,200,second.body);assert.equal(second.json().evidenceDependencies.complete,true);assert.equal(calls,2);
});
