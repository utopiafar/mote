import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {AgentResponseError} from '@mote/agent';
import {ProviderFailure} from '@mote/shared';
import {startBridge} from '../../../packages/agent/dist/bridge.js';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import {authorizeFixtureModels,fixtureTopicResult} from './fixtures/model-authorization.js';
import {generatedMemoryOutput} from './fixtures/memory-planning.js';
import {readAgentCredential} from './login-fixture.js';

test('an explicit provider switch clears only the previous provider quota wait for an unfinished extraction',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-quota-fallback-'));
 const token='generated-memory-fallback-owner',headers={authorization:'Bearer '+token,'X-Mote-Ingress-Version':'2'};
 const config:ConfigurationPlatformOptions={path:join(directory,'mote.yaml'),privateCredential:{token,tokenPath:'fixture'},initialDocument:{
  version:1,revision:0,storage:{dataDir:directory,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},
  execution:{insightIntervalHours:0},models:{deployment:{model:'generated-quota-model',provider:'custom',protocol:'openai-completions',
   baseUrl:'https://generated-old.invalid/v1',apiKey:'generated-unused',allowUnauthenticatedLocal:false,reasoningEffort:'high'}},
  diagnostics:{enabled:false,traceEnabled:false,level:'silent'}
 }};
 const calls:{provider:string;phase?:string}[]=[];
 const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
  const topic=fixtureTopicResult(input);if(topic)return topic;
  calls.push({provider:settings.provider,phase:input.traceContext?.phase});
  if(settings.provider==='custom')throw new ProviderFailure({category:'transient',code:'rate_limited',retryAfterMs:3600000,executionStarted:false});
  const bridge=await startBridge(reader,input);
  try{return {runId:randomUUID(),answer:generatedMemoryOutput(input),citations:[],trace:bridge.trace,evidenceReadRanges:bridge.deliveredRanges,evidenceDependencies:bridge.evidenceDependencies};}
  finally{await bridge.close();}
 }})});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 await node.app.ready();
 const readSettings=()=>node.modelSettings.view();
 const save=async(id:string,settings:ReturnType<typeof node.modelSettings.select>['settings'])=>{
  const result=await node.app.inject({method:'PUT',url:'/api/model-settings/profiles/'+id,headers,payload:{revision:readSettings().revision,name:id,settings}});
  assert.equal(result.statusCode,200,result.body);
 };
 const originalSettings=node.modelSettings.select('memory').settings;
 await save('same-provider',{...originalSettings,model:'generated-same-provider-model'});
 await save('fallback-provider',{...originalSettings,provider:'deepseek',protocol:'deepseek',baseUrl:'https://generated-new.invalid/v1',model:'generated-fallback-model'});
 const noteId=randomUUID();
 const note=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id:noteId,deviceId:'generated-provider-switch',deviceName:'Generated',platform:'import',capturedAt:'2026-05-01T00:00:00Z',text:'Generated original with a source identity that survives a provider switch.'}});
 assert.equal(note.statusCode,201,note.body);
 const response=await node.app.inject({method:'POST',url:'/api/memory-jobs',headers,payload:{evidenceIds:[noteId]}});
 assert.equal(response.statusCode,202,response.body);
 const id=response.json().id,path='/api/memory-jobs/'+id;
 const until=Date.now()+8000;
 while(Date.now()<until&&node.memoryPipeline.get(id).batches[0]?.errorCode!=='rate_limited')await setTimeout(20);
 const blocked=node.memoryPipeline.get(id),batch=blocked.batches[0];
 assert.equal(batch.errorCode,'rate_limited');
 assert.ok(batch.availableAt!>Date.now()+1000);
 const pause=await node.app.inject({method:'POST',url:path+'/pause',headers});
 assert.equal(pause.json().status,'paused');
 const retry=(modelProfileId?:string)=>node.app.inject({method:'POST',url:path+'/retry',headers,payload:modelProfileId?{modelProfileId}:{}});
 for(const model of [undefined,'same-provider']){
  const refused=await retry(model);
  assert.equal(refused.json().error,'rate_limited');
  assert.equal(node.memoryPipeline.get(id).batches[0].availableAt,batch.availableAt);
 }
 const accepted=await retry('fallback-provider');
 assert.equal(accepted.statusCode,202,accepted.body);
 const done=await node.memoryPipeline.run(id);
 assert.equal(done.status,'completed');
 assert.equal(done.configuration?.provider,'deepseek');
 assert.equal(done.batches[0].id,batch.id);
 assert.deepEqual(done.batches[0].evidenceRanges,batch.evidenceRanges);
 assert.equal(done.batches[0].reviewReceipt?.decision,'independent');
 assert.deepEqual(calls,[{provider:'custom',phase:'extract'},{provider:'deepseek',phase:'extract'},{provider:'deepseek',phase:'review'}]);
});

test('A1-30: an excluded source Memory waits durably without invoking a model and completes once after re-inclusion',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-authorization-wait-'));
 const config:ConfigurationPlatformOptions={path:(directory)+'/mote.yaml',privateCredential:{token:'generated-memory-wait-owner',tokenPath:'fixture'},initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'fixture',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{enabled:false}}};
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
 const headers={authorization:'Bearer '+config.privateCredential!.token},current=(await node.app.inject({url:'/api/model-settings',headers})).json();
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
 // Re-inclusion can already admit this batch while the owner command yields.
 // Join that work without issuing another retry against its active attempt.
 await node.executor.drain(memorySteps.map(row=>String(row.id)));const done=await node.memoryPipeline.run(job.id);assert.equal(done.status,'completed');assert.equal(calls,2,'extraction and independent review each run once');assert.equal(node.memories.list().length,0,'the generated fixture submits no memory candidate');
});

test('an owner retry admits only the selected formerly excluded Memory job with the current model',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-owner-retry-'));
 const config:ConfigurationPlatformOptions={path:(directory)+'/mote.yaml',privateCredential:{token:'generated-memory-owner',tokenPath:'fixture'},initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'generated-old-model',provider:'custom',protocol:'openai-completions',baseUrl:'https://generated.invalid/v1',apiKey:'generated-unused',allowUnauthenticatedLocal:false,reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{enabled:false,traceEnabled:false,level:'silent'}}};
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
 const headers={authorization:'Bearer '+config.privateCredential!.token},before=(await node.app.inject({url:'/api/model-settings',headers})).json();
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


test('an owner Memory retry renews the selected model on the same parked or failed batch', async t => {
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-owner-model-renewal-'));
 const token='generated-memory-model-renewal-owner';
 const config:ConfigurationPlatformOptions={
  path:join(directory,'mote.yaml'),privateCredential:{token,tokenPath:'fixture'},
  initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:1_000_000},
   server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},
   models:{deployment:{model:'generated-model',provider:'custom',protocol:'openai-completions',baseUrl:'https://generated.invalid/v1',apiKey:'generated-only',maxTokens:16384},
    embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{enabled:false}},
 };
 const calls:{id?:string;phase?:string;budget:number}[]=[];
 const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(settings,reader)=>({
  configured:true,close:async()=>{},
  query:async input=>{
   const topic=fixtureTopicResult(input);if(topic)return topic;
   calls.push({id:input.traceContext?.jobId,phase:input.traceContext?.phase,budget:settings.maxTokens});
   if(settings.maxTokens===16384)throw new AgentResponseError('Generated output exhausted its budget','output_limit');
   const bridge=await startBridge(reader,input);
   try{return {runId:randomUUID(),answer:generatedMemoryOutput(input),citations:[],trace:bridge.trace,
    evidenceReadRanges:bridge.deliveredRanges,evidenceDependencies:bridge.evidenceDependencies};}
   finally{await bridge.close();}
  },
 })});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 await node.app.ready();
 const headers={authorization:'Bearer '+token};
 const create=async(label:string)=>{
  const id=randomUUID();
  const original=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-renewal',
   deviceName:'Generated',platform:'import',capturedAt:'2026-05-01T00:00:00Z',text:'Generated original for '+label}});
  assert.equal(original.statusCode,201,original.body);
  const response=await node.app.inject({method:'POST',url:'/api/memory-jobs',headers,payload:{evidenceIds:[id]}});
  assert.equal(response.statusCode,202,response.body);
  const failed=await node.memoryPipeline.run(response.json().id);
  assert.equal(failed.status,'failed');
  assert.equal(failed.batches.length,1);
  assert.equal(failed.batches[0].errorCode,'model_output_capacity');
  return failed;
 };
 const parked=await create('a previously selected model');
 const failed=await create('an explicit model selection');
 const profileId='generated-new-budget';
 const view=node.modelSettings.view();
 const update=await node.app.inject({method:'PUT',url:'/api/model-settings/profiles/'+profileId,headers,payload:{
  revision:view.revision,name:'Generated new budget',
  settings:{...node.modelSettings.select('memory').settings,contextWindow:1000000,maxTokens:65536},
 }});
 assert.equal(update.statusCode,200,update.body);
 const waitFor=async(jobId:string,expected:string)=>{
  const end=Date.now()+7000;
  while(Date.now()<end){
   const job=node.memoryPipeline.get(jobId);
   if(job.status===expected||job.batches[0].errorCode===expected)return job;
   await setTimeout(20);
  }
  const job=node.memoryPipeline.get(jobId);
  assert.fail('Expected '+expected+', got '+job.status+' / '+job.batches[0].errorCode);
 };
 // Simulate work saved by the old retry path, which selected the profile
 // and left the existing step bound to the old owner model allowance.
 void node.memoryPipeline.acceptRetry(parked.id,true,profileId).completion.catch(()=>{});
 await waitFor(parked.id,'background_model_authorization_required');
 assert.equal(calls.filter(call=>call.id===parked.id).length,1);
 const retry=async(jobId:string,payload:Record<string,unknown>)=>node.app.inject({method:'POST',
   url:'/api/memory-jobs/'+jobId+'/retry',headers,payload});
 const resumed=await retry(parked.id,{});
 assert.equal(resumed.statusCode,202,resumed.body);
 node.store.db.prepare("UPDATE execution_steps SET available_at=0 WHERE operation_id=? AND error='background_model_authorization_required'").run('memory:'+parked.id);
 const resumedJob=await waitFor(parked.id,'completed');
 assert.equal(node.memoryPipeline.get(failed.id).status,'failed');
 const selected=await retry(failed.id,{modelProfileId:profileId});
 assert.equal(selected.statusCode,202,selected.body);
 const selectedJob=await waitFor(failed.id,'completed');
 for(const [before,after] of [[parked,resumedJob],[failed,selectedJob]]){
  assert.equal(after.batches[0].id,before.batches[0].id);
  assert.deepEqual(after.batches[0].evidenceRanges,before.batches[0].evidenceRanges);
  assert.equal(after.batches[0].reviewReceipt?.decision,'independent');
  assert.deepEqual(calls.filter(call=>call.id===before.id).map(({phase,budget})=>[phase,budget]),
   [['extract',16384],['extract',65536],['review',65536]]);
 }
});
