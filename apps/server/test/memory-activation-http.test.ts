import {withFixtureOwnerModelWork} from './fixtures/model-authorization.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {startBridge} from '../../../packages/agent/dist/bridge.js';
import {buildApp} from '../src/app.js';
import {materialId} from '../src/materials.js';
import type {Config} from '../src/config.js';

for(const transition of ['create-only','activated-restart','cancelled-restart','deleted-restart'] as const)test(`formal app startup preserves ${transition} Memory activation authority`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-activation-')),calls:string[]=[];
 const config:Config={dataDir:directory,token:'generated-memory-activation',tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'https://generated.invalid/v1',apiKey:'generated-unused',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,agentTraceEnabled:false,logLevel:'silent'};
 let node:Awaited<ReturnType<typeof buildApp>>,hold=transition!=='create-only',entered!:()=>void;
 const started=new Promise<void>(resolve=>entered=resolve);
 const open=async()=>{node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
  calls.push(input.traceContext?.phase??'unknown');const bridge=await startBridge(reader,input);
  try{
   assert.equal(bridge.seedEvidence.length,1);
   if(hold){entered();await new Promise<void>((_,reject)=>{input.signal!.throwIfAborted();input.signal!.addEventListener('abort',()=>reject(input.signal!.reason),{once:true});});}
   const members=(input.taskContext!.memoryWork as {members:{key:string}[]}).members;
   return {runId:randomUUID(),answer:JSON.stringify({memories:[],coverage:members.map(member=>({key:member.key,state:'no_candidates',candidateIndexes:[]}))}),citations:[],trace:bridge.trace,evidenceReadRanges:bridge.deliveredRanges,evidenceDependencies:bridge.evidenceDependencies};
  }finally{await bridge.close();}
 }})});await node.app.ready();};await open();t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const id=randomUUID(),sourceId='generated-activation-source';node.sources.register({id:sourceId,name:'Generated activation source',kind:'custom',deviceId:'generated',platform:'import'});
 await node.store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'Generated original for explicit Memory activation.'});
 const material=node.materials.publish({id:materialId(sourceId,'generated'),kind:'mote.note',schemaVersion:1,title:'Generated activation original',origin:{sourceId,externalId:'generated',deviceId:'generated'},members:[{id,kind:'capture',ref:'capture:'+id}],blocks:[{id:'body',kind:'text',format:'plain',text:'Generated original for explicit Memory activation.',memberIds:[id]}],artifacts:[{key:'source-body',state:'ready',blockIds:['body']}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
 const job=node.memoryPipeline.create({evidenceIds:node.materials.input(material.ref,['source-body'])!.evidenceIds,recipes:[{id:'mote.personal-memory',version:'5'}]});assert.equal(job.activationRequired,true);
 let interrupted:Promise<unknown>|undefined;
 if(transition!=='create-only'){interrupted=withFixtureOwnerModelWork(node,()=>node.memoryPipeline.run(job.id)).catch(error=>{assert.equal(error.name,'AbortError','closing the app interrupts the active owner model operation');});await started;assert.equal(node.memoryPipeline.get(job.id).activationRequired,false,'explicit start persists activation before provider work');}
 const api=(method:'GET'|'POST'|'DELETE',url:string)=>node.app.inject({method,url,headers:{authorization:'Bearer '+config.token},...(method==='POST'?{payload:{}}:{})});
 if(transition==='cancelled-restart')assert.equal((await api('POST','/api/memory-jobs/'+job.id+'/cancel')).statusCode,200);
 if(transition==='deleted-restart')assert.equal((await api('DELETE','/api/captures/'+id)).statusCode,200);
 await node.app.close();await interrupted;hold=false;const before=calls.length;await open();
 if(transition==='create-only'){
  await delay(30);assert.equal(calls.length,0);assert.equal(node.memoryPipeline.get(job.id).activationRequired,true);
  const start=await api('POST','/api/memory-jobs/'+job.id+'/resume');assert.equal(start.statusCode,200);
  assert.equal(calls.length,0,'resume is not a grant to activate a never-started queued task');
  const done=await withFixtureOwnerModelWork(node,()=>node.memoryPipeline.run(job.id));assert.equal(done.status,'completed');assert.equal(done.activationRequired,false);assert.deepEqual(calls,['extract','review']);return;
 }
 if(transition==='activated-restart'){
  const done=await node.memoryPipeline.run(job.id);assert.equal(done.status,'completed');assert.equal(done.activationRequired,false);assert.equal(calls.length,before+2);assert.equal(node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,1);return;
 }
 await delay(30);assert.equal(calls.length,before,'prior activation never overrides current cancellation or original deletion');
 const read=await api('GET','/api/memory-jobs/'+job.id);if(transition==='cancelled-restart')assert.equal(read.json().status,'cancelled');
});
