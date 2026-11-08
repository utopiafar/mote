import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {startBridge} from '../../../packages/agent/dist/bridge.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {authorizeFixtureModels,fixtureTopicResult} from './fixtures/model-authorization.js';
import {generatedMemoryOutput} from './fixtures/memory-planning.js';
import {readAgentCredential} from './login-fixture.js';

test('A1-30: an excluded source Memory waits durably without invoking a model and completes once after re-inclusion',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-authorization-wait-'));
 const config:Config={dataDir:directory,token:'generated-memory-wait-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let calls=0;const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
  const topic=fixtureTopicResult(input);if(topic)return topic;
  calls++;
  const bridge=await startBridge(reader,input);
  try{return {runId:randomUUID(),answer:generatedMemoryOutput(input),citations:[],trace:bridge.trace,evidenceReadRanges:bridge.deliveredRanges,evidenceDependencies:bridge.evidenceDependencies};}
  finally{await bridge.close();}
 }})});
 await node.app.ready();t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 await authorizeFixtureModels(node,{excludedSourceIds:['generated-other']});
 node.sources.register({id:'generated-other',name:'Generated other source',kind:'custom',deviceId:'generated',platform:'import'});
 await node.sources.upsert('generated-other',{externalId:'generated-one',revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'message',layer:'original',text:'Generated private original'});
 await node.materialOrganizer.tick();await node.sourcePipelines.tick();node.store.db.prepare('UPDATE material_memory_requests SET ready_at=0').run();
 assert.equal(await node.sourcePipelines.drainMemory(node.memoryPipeline,true,10),1);
 const job=node.memoryPipeline.list()[0];assert.ok(job);void node.memoryPipeline.run(job.id).catch(()=>{});
 let step:Record<string,unknown>|undefined;const deadline=Date.now()+10000;
 while(Date.now()<deadline){step=node.store.db.prepare("SELECT id,state,error,attempts,available_at,updated_at FROM execution_steps WHERE kind='memory.batch' AND operation_id=?").get('memory:'+job.id);if(step?.state==='waiting'&&step.error==='background_model_authorization_required')break;await setTimeout(20);}
 assert.equal(step?.state,'waiting');assert.equal(step?.error,'background_model_authorization_required');
 assert.ok(Number(step?.available_at)-Number(step?.updated_at)>=59000,'the parent inherits the child authorization wait');
 assert.equal(step?.attempts,0);assert.equal(calls,0);assert.equal(node.memories.list().length,0);
 // The Memory job still pins its own configuration. The background switch does
 // not replace that pin, and changing defaults parks rather than silently swaps.
 const headers={authorization:'Bearer '+config.token},current=(await node.app.inject({url:'/api/model-settings',headers})).json();
 const changed=await node.app.inject({method:'PUT',url:'/api/model-settings/defaults',headers,payload:{revision:current.revision,defaults:current.defaults,defaultModels:{...current.defaultModels,memory:'generated-new-model'}}});assert.equal(changed.statusCode,200,changed.body);
 node.store.db.prepare('UPDATE execution_steps SET available_at=0 WHERE id=?').run(String(step!.id));await node.executor.drain([String(step!.id)]);
 const mismatch=node.memoryPipeline.get(job.id);assert.equal(mismatch.status,'waiting_for_model');assert.equal(mismatch.errorCode,'configuration_changed');
 node.store.db.prepare('UPDATE material_memory_requests SET ready_at=0 WHERE job_id=?').run(job.id);await node.sourcePipelines.drainMemory(node.memoryPipeline,true,10);
 const row=node.store.db.prepare('SELECT ready_at,error FROM material_memory_requests WHERE job_id=?').get(job.id)!;assert.equal(row.ready_at,Number.MAX_SAFE_INTEGER);assert.equal(row.error,'memory_job_configuration_changed');
 const saved=node.store.db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(job.id)!.json;for(let n=0;n<3;n++)await node.sourcePipelines.drainMemory(node.memoryPipeline,true,10);
 assert.equal(node.store.db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(job.id)!.json,saved);assert.equal(calls,0);
 const latest=(await node.app.inject({url:'/api/model-settings',headers})).json();const restored=await node.app.inject({method:'PUT',url:'/api/model-settings/defaults',headers,payload:{revision:latest.revision,defaults:current.defaults,defaultModels:current.defaultModels}});assert.equal(restored.statusCode,200,restored.body);
 await node.sourcePipelines.drainMemory(node.memoryPipeline,true,10);
 const resumed=node.store.db.prepare('SELECT ready_at,error FROM material_memory_requests WHERE job_id=?').get(job.id)!;assert.notEqual(resumed.ready_at,Number.MAX_SAFE_INTEGER);assert.equal(resumed.error,null);assert.equal(calls,0,'the excluded source still blocks the model');
 await authorizeFixtureModels(node,{excludedSourceIds:[]});
 node.store.db.prepare("UPDATE execution_steps SET available_at=0 WHERE operation_id=? OR json_extract(input,'$.jobId')=?").run('memory:'+job.id,job.id);
 const memorySteps=node.store.db.prepare("SELECT id FROM execution_steps WHERE operation_id=? OR json_extract(input,'$.jobId')=?").all('memory:'+job.id,job.id);
 node.executor.retry(String(step!.id),true);await node.executor.drain(memorySteps.map(row=>String(row.id)));const done=await node.memoryPipeline.run(job.id);assert.equal(done.status,'completed');assert.ok(calls>0);assert.equal(node.memories.list().length,0,'the generated fixture submits no memory candidate');
});

test('an owner retry admits only the selected formerly excluded Memory job with the current model',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-owner-retry-'));
 const config:Config={dataDir:directory,token:'generated-memory-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-old-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'https://generated.invalid/v1',apiKey:'generated-unused',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,agentTraceEnabled:false,logLevel:'silent'};
 const calls:{jobId?:string;model?:string}[]=[];let hold=true,opened=false;
 let node:Awaited<ReturnType<typeof buildApp>>;
 const open=async()=>{node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
  const topic=fixtureTopicResult(input);if(topic)return topic;
  calls.push({jobId:input.traceContext?.jobId,model:input.modelOverride});
  const bridge=await startBridge(reader,input);
  try{
   if(hold)await new Promise<void>((_,reject)=>{input.signal!.throwIfAborted();input.signal!.addEventListener('abort',()=>reject(input.signal!.reason),{once:true});});
   return {runId:randomUUID(),answer:generatedMemoryOutput(input),citations:[],trace:bridge.trace,evidenceReadRanges:bridge.deliveredRanges,evidenceDependencies:bridge.evidenceDependencies};
  }finally{await bridge.close();}
 }})});await node.app.ready();opened=true;};
 await open();t.after(async()=>{if(opened)await node.app.close();rmSync(directory,{recursive:true,force:true});});
 await authorizeFixtureModels(node,{excludedSourceIds:['generated-selected','generated-sibling']});
 for(const externalId of ['selected','sibling']){
  const sourceId='generated-'+externalId;node.sources.register({id:sourceId,name:'Generated excluded source',kind:'custom',deviceId:'generated',platform:'import'});
  await node.sources.upsert(sourceId,{externalId,revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'message',layer:'original',text:'Generated historical original '+externalId+' x'.repeat(3150)});
 }
 await node.materialOrganizer.tick();await node.sourcePipelines.tick();node.store.db.prepare('UPDATE material_memory_requests SET ready_at=0').run();
 assert.equal(await node.sourcePipelines.drainMemory(node.memoryPipeline,true,10),2);
 const jobs=node.memoryPipeline.list();assert.equal(jobs.length,2);for(const job of jobs)void node.memoryPipeline.run(job.id).catch(()=>{});
 const batches=()=>node.store.db.prepare("SELECT id,operation_id,state,error FROM execution_steps WHERE kind='memory.batch' ORDER BY operation_id").all();
 const waitUntil=async(predicate:()=>boolean)=>{const end=Date.now()+10000;while(Date.now()<end){if(predicate())return;await setTimeout(20);}assert.fail('Generated Memory work did not reach the expected state');};
 await waitUntil(()=>batches().length===2&&batches().every(row=>row.state==='waiting'&&row.error==='background_model_authorization_required'));
 assert.equal(calls.length,0);
 const headers={authorization:'Bearer '+config.token},before=(await node.app.inject({url:'/api/model-settings',headers})).json();
 const changed=await node.app.inject({method:'PUT',url:'/api/model-settings/defaults',headers,payload:{revision:before.revision,defaults:before.defaults,defaultModels:{...before.defaultModels,memory:'generated-new-model'}}});assert.equal(changed.statusCode,200,changed.body);
 for(const row of batches()){node.store.db.prepare('UPDATE execution_steps SET available_at=0 WHERE id=?').run(String(row.id));await node.executor.drain([String(row.id)]);}
 await waitUntil(()=>jobs.every(job=>node.memoryPipeline.get(job.id).errorCode==='configuration_changed'));
 await authorizeFixtureModels(node,{excludedSourceIds:[]});
 const selected=jobs[0],sibling=jobs[1],url='/api/memory-jobs/'+selected.id+'/retry',agent=await readAgentCredential(node.connections);
 assert.equal((await node.app.inject({method:'POST',url,headers:{authorization:'Bearer '+agent.token},payload:{}})).statusCode,403);
 assert.equal(calls.length,0,'the parked siblings stay idle without an explicit owner retry');
 const retry=await node.app.inject({method:'POST',url,headers,payload:{}});assert.equal(retry.statusCode,202,retry.body);
 await waitUntil(()=>calls.length>0);assert.equal(node.memoryPipeline.get(selected.id).configuration?.model,'generated-new-model');
 assert.equal(node.memoryPipeline.get(sibling.id).errorCode,'configuration_changed');
 await node.app.close();opened=false;hold=false;await open();
 const done=await node.memoryPipeline.run(selected.id);assert.equal(done.status,'completed');assert.equal(done.configuration?.model,'generated-new-model');assert.ok(calls.length>=3,'the restarted extraction and independent review reached the generated model');
 assert.ok(calls.every(call=>call.jobId===selected.id),'the owner retry must not authorize the sibling');
 assert.equal(node.memoryPipeline.get(sibling.id).errorCode,'configuration_changed');
 const grants=()=>Number(node.store.db.prepare("SELECT count(*) n FROM background_model_work WHERE id LIKE 'owner-memory-retry:%'").get()!.n);
 assert.equal((await node.app.inject({method:'POST',url:'/api/memory-jobs/'+sibling.id+'/cancel',headers,payload:{}})).statusCode,200);
 const beforeRejectedRetry=grants();assert.equal((await node.app.inject({method:'POST',url:'/api/memory-jobs/'+sibling.id+'/retry',headers,payload:{}})).statusCode,409);
 assert.equal(grants(),beforeRejectedRetry,'a rejected retry cannot retain a manual grant');
});
