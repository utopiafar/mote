import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {QueryInput} from '@mote/agent';
import {authorizeFixtureModels,fixtureTopicResult} from './fixtures/model-authorization.js';
import {fixtureMemoryWorkResult} from './fixtures/memory-planning.js';
import {PluginHost,type PluginHandle,type HostPluginContext} from '@mote/plugin-host';
import {DEPLOYMENT_MODEL_PROFILE_ID} from '@mote/shared/models';
import {hostRun} from './fixtures/host-run.js';
import {activityServicesInputsContract} from '../src/plugins/activity-services.js';
import {defaultDistribution} from '../src/distribution/default.js';
import type {ServiceBinding,ServiceContract} from '@mote/plugin-api/contracts';
import {ExecutionEngine,type ExecutionHandler} from '../src/execution-engine.js';

function fixture(t:TestContext){
  const dataDir=mkdtempSync(join(tmpdir(),'mote-activity-domain-')),nodes:Awaited<ReturnType<typeof buildApp>>[]=[];
  const config:Config={dataDir,token:'generated-activity-domain-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxExportBytes:1_000_000,
    insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelBaseUrl:'https://generated.invalid',apiKey:'generated',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
  t.after(async()=>{try{for(const node of nodes.reverse())await node.app.close();}finally{rmSync(dataDir,{recursive:true,force:true});}});
  const build=async(options:Parameters<typeof buildApp>[1]={})=>{const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,close:async()=>{},query:async()=>{throw Error('Unconfigured generated model');}},...options});nodes.push(node);return node;};
  return {config,build,headers:{authorization:'Bearer '+config.token}};
}

test('unselected Activity installs no private projection, intake observer, model handler or poll while public domains remain usable',async t=>{
  for(const selection of ['feature','plugin'] as const)await t.test(selection,async t=>{
    const f=fixture(t);let handlers=0,polls=0;
    const register=ExecutionEngine.prototype.register,interval=globalThis.setInterval;
    t.mock.method(ExecutionEngine.prototype,'register',function(this:ExecutionEngine,handler:ExecutionHandler){if(handler.kind==='activity.understand')handlers++;return register.call(this,handler);});
    t.mock.method(globalThis,'setInterval',function(callback:Parameters<typeof setInterval>[0],delay?:number,...args:unknown[]){if(delay===5000&&new Error().stack?.includes('/plugins/activity-services.ts:'))polls++;return interval(callback,delay,...args);});
    const distribution={...defaultDistribution,...(selection==='feature'
      ?{features:defaultDistribution.features.filter(id=>id!=='mote.activity')}
      :{plugins:defaultDistribution.plugins.filter(plugin=>plugin.contribution.id!=='activity-services')})};
    let node:Awaited<ReturnType<typeof buildApp>>,memoryCalls=0;
    node=await f.build({distribution,agent:{configured:true,close:async()=>{},query:async(input:QueryInput)=>{
      const topic=fixtureTopicResult(input);if(topic)return topic;
      memoryCalls++;
      const record=node.memories.readEvidence(input.evidenceIds!)[0];assert.ok(record);
      return fixtureMemoryWorkResult(input,{answer:JSON.stringify({memories:[{title:'Generated still usable Memory',statement:'The generated owner keeps scoped written decisions ['+record.id+']',uncertainty:'Generated evidence only',admission:{layer:'memory',reason:'Generated explicit preference',scope:'Generated project',attribution:'user'},evidenceIds:[record.id],evidence:[{id:record.id,quote:record.ocrText}]}]}),citations:[{id:record.id,capturedAt:record.capturedAt,appName:record.appName,excerpt:record.ocrText}],trace:[],runId:randomUUID()});
    }}});
    assert.deepEqual({handlers,polls},{handlers:0,polls:0});
    assert.deepEqual(node.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'activity_*'").all(),[]);
    assert.ok(!node.bootstrap.snapshot().contributions.some(item=>item.identity.contributionId.startsWith('activity-services')));
    for(const path of ['/api/work-activity','/api/processing/activity'])assert.equal((await node.app.inject({url:path,headers:f.headers})).statusCode,404,path);
    for(const path of ['/api/agent-view/catalog','/api/memory-jobs','/api/query-runs'])assert.equal((await node.app.inject({url:path,headers:f.headers})).statusCode,200,path);
    for(const name of ['operation_progress','execution_steps','memory_jobs','delegation_works'])assert.ok(node.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name),name);
    const note={id:randomUUID(),deviceId:'generated-activity-device',deviceName:'Generated',platform:'android',capturedAt:'2026-11-17T00:00:00Z',text:'Generated public original without Activity'};
    assert.equal((await node.app.inject({method:'POST',url:'/api/notes',headers:f.headers,payload:note})).statusCode,201);
    assert.equal((await node.app.inject({url:'/api/notes/'+note.id,headers:f.headers})).json().ocrText,note.text);
    await authorizeFixtureModels(node);
    const sourceId='generated-memory-without-activity';
    assert.equal((await node.app.inject({method:'POST',url:'/api/sources',headers:f.headers,payload:{id:sourceId,name:'Generated unaffected Memory',kind:'custom',deviceId:'generated-memory-device',platform:'import'}})).statusCode,200);
    assert.equal((await node.app.inject({method:'PUT',url:'/api/memory-recipe-settings',headers:f.headers,payload:{sourceId,recipes:[{id:'mote.personal-memory',version:'5'}]}})).statusCode,200);
    const original=await node.app.inject({method:'PUT',url:'/api/sources/'+sourceId+'/items',headers:f.headers,payload:{externalId:'one',revision:'1',observedAt:'2026-11-17T00:00:00Z',kind:'message',layer:'original',text:'The generated owner keeps scoped written decisions.',document:{contentRole:'authored'}}});
    assert.equal(original.statusCode,200,original.body);
    await node.materialOrganizer.tick();await node.sourcePipelines.tick();
    const material=node.materials.list({sourceId}).items[0];assert.ok(material);
    const start=await node.app.inject({method:'POST',url:'/api/memory-jobs',headers:f.headers,payload:{evidenceIds:node.materials.evidenceIds(material.ref),recipes:[{id:'mote.personal-memory',version:'5'}]}});
    assert.equal(start.statusCode,202,start.body);
    const job=await node.memoryPipeline.run(start.json().id);assert.equal(job.status,'completed',JSON.stringify(job));assert.equal(job.memoryIds.length,1);assert.ok(memoryCalls>0);
    const read=await node.app.inject({url:'/api/memory-jobs/'+job.id,headers:f.headers});assert.equal(read.json().memoryIds[0],job.memoryIds[0]);
    const memory=await node.app.inject({url:'/api/memories/'+job.memoryIds[0],headers:f.headers});assert.equal(memory.statusCode,200,memory.body);assert.match(memory.body,/scoped written decisions/);
    assert.deepEqual(node.store.db.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'activity_*'").all(),[],'real completed Memory and intake never install the optional Activity schema');
    assert.deepEqual({handlers,polls},{handlers:0,polls:0});
    await node.app.close();
    const restored=await f.build();
    const projected=await restored.app.inject({url:'/api/work-activity/memory:'+job.id,headers:f.headers});
    assert.equal(projected.statusCode,200,projected.body);assert.equal(projected.json().state,'completed','first selection rebuilds from canonical work performed without Activity');
    assert.equal(projected.json().progress.completed,1);

  });
});

async function http(node:Awaited<ReturnType<typeof buildApp>>,headers:{authorization:string}){
  const origin=await node.app.listen({host:'127.0.0.1',port:0});
  return async(method:string,path:string,body?:unknown)=>{
    const response=await fetch(origin+path,{method,headers:{...headers,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,json:await response.json()};
  };
}

test('the selected Activity declaration owns its actual routes, factory and projection subscriptions across close and restart',async t=>{
  const f=fixture(t),node=await f.build(),request=await http(node,f.headers);
  const factory=await node.bootstrap.acquireDomainService('activity-services-inputs',activityServicesInputsContract);
  assert.deepEqual(Object.keys(factory.value),['open']);await factory.release();
  for(const id of ['activity-services-inputs','activity-services','agent-view-inputs','agent-view-services'])assert.equal(node.bootstrap.snapshot().contributions.filter(item=>item.identity.contributionId===id).length,1,id);
  assert.equal((await request('GET','/api/work-activity')).status,200);
  assert.equal((await request('GET','/api/processing/activity')).status,200);
  assert.equal((await request('GET','/api/agent-view/runs')).status,200);
  assert.equal(node.store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name GLOB 'activity_*'").get()!.n,13);
  const domains=await node.bootstrap.activateDomains();await domains.quiesce();
  assert.equal(node.store.db.prepare("SELECT count(*) n FROM sqlite_temp_master WHERE type='trigger' AND name GLOB 'activity_memory_*'").get()!.n,0);
  assert.equal((await request('GET','/api/work-activity')).status,503);
  assert.equal((await request('GET','/api/agent-view/runs')).status,503);
  const note={id:randomUUID(),deviceId:'generated-stop-device',deviceName:'Generated',platform:'android',capturedAt:'2026-11-17T00:00:00Z',text:'Generated public original while optional domains stop'};
  assert.equal((await request('POST','/api/notes',note)).status,201);
  await Promise.all([domains.close(),domains.close()]);await node.app.close();
  const removed=await f.build({distribution:{...defaultDistribution,features:defaultDistribution.features.filter(id=>id!=='mote.activity')}});
  assert.equal(removed.store.db.prepare("SELECT count(*) n FROM sqlite_temp_master WHERE type='trigger' AND name GLOB 'activity_memory_*'").get()!.n,0);
  assert.equal((await removed.app.inject({url:'/api/notes/'+note.id,headers:f.headers})).json().ocrText,note.text);
  await removed.app.close();
  const restored=await f.build(),again=await http(restored,f.headers);
  assert.equal((await again('GET','/api/work-activity')).status,200);
  assert.equal((await again('GET','/api/agent-view/runs')).status,200);
  assert.ok(restored.store.db.prepare("SELECT 1 FROM sqlite_temp_master WHERE type='trigger' AND name='activity_memory_job_insert'").get());
});

test('a failed Activity start releases its registered handler, intake hook and projection subscriptions before the profile reopens',async t=>{
  const f=fixture(t),failure=Error('Generated Activity timer failure'),interval=globalThis.setInterval;
  let opens=0,releases=0,closed=false;
  const register=ExecutionEngine.prototype.register;
  t.mock.method(ExecutionEngine.prototype,'register',function(this:ExecutionEngine,handler:ExecutionHandler){const release=register.call(this,handler);if(handler.kind!=='activity.understand')return release;opens++;return async()=>{await release();releases++;};});
  const fail=t.mock.method(globalThis,'setInterval',function(callback:Parameters<typeof setInterval>[0],delay?:number,...args:unknown[]){if(delay===5000&&new Error().stack?.includes('/plugins/activity-services.ts:'))throw failure;return interval(callback,delay,...args);});
  await assert.rejects(f.build({distribution:{...defaultDistribution,foundations:defaultDistribution.foundations.map(provider=>provider.kind==='storage'?{...provider,async create(context,input){const value=await provider.create(context,input);const close=value.store.close.bind(value.store);value.store.close=()=>{closed=true;return close();};return value;}}:provider)}}),error=>error===failure);
  assert.equal(opens,1);assert.equal(releases,1);assert.equal(closed,true);
  fail.mock.restore();const restored=await f.build(),request=await http(restored,f.headers);
  assert.equal((await request('GET','/api/work-activity')).status,200);assert.equal(opens,2);
});

test('closing the Activity owner rejects an accepted late model publication while its Agent View sibling and Notes remain live',async t=>{
  let entered!:()=>void,release!:()=>void,signal:AbortSignal|undefined,activityOwner:PluginHandle|undefined,calls=0;
  const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve),install=PluginHost.prototype.install;
  t.mock.method(PluginHost.prototype,'install',async function(this:PluginHost,definition:Parameters<PluginHost['install']>[0]){const handle=await install.call(this,definition);if(definition.contributions.some(entry=>entry.id==='activity-services'))activityOwner=handle;return handle;});
  t.after(()=>release());const f=fixture(t);
  const node=await f.build({agent:{configured:true,close:async()=>{},query:async(input,lease)=>{
    lease?.onFinalizer?.('host');calls++;signal=input.signal;entered();await held;hostRun(input);
    const record=node.store.evidence(input.evidenceIds!)[0];
    return {answer:JSON.stringify({activities:[{existingActivityId:null,title:'Generated late observation',statement:record.ocrText,uncertainty:'Generated only',evidence:[{id:record.id,quote:record.ocrText,offset:0,source:'text'}]}],coverage:'complete',limitation:'Generated only'}),citations:[{id:record.id,capturedAt:record.capturedAt,appName:record.appName,excerpt:record.ocrText}],trace:[],runId:randomUUID()};
  }}}),request=await http(node,f.headers);
  await authorizeFixtureModels(node);
  const view=await request('GET','/api/processing/activity');assert.equal((await request('PUT','/api/processing/activity',{revision:view.json.revision,settings:{enabled:true,modelProfileId:DEPLOYMENT_MODEL_PROFILE_ID}})).status,200);
  const original={id:randomUUID(),deviceId:'generated-late-activity',deviceName:'Generated',platform:'android',capturedAt:'2026-11-17T00:00:00Z',durationMs:1000,source:'screen',appId:'generated.app',appName:'Generated app',windowTitle:'',ocrText:'Generated visible observation',privacy:{collection:'content'},metadata:{version:1,observedAt:'2026-11-17T00:00:00Z'}};
  assert.equal((await request('POST','/api/captures',original)).status,201);
  const ticking=node.activityServices.tick();await started;
  const closing=activityOwner!.close('disabled');
  for(let i=0;i<200&&!signal?.aborted;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(signal?.aborted,true);
  release();await Promise.allSettled([ticking,closing]);
  assert.equal(calls,1);assert.equal(node.materials.list({kind:'mote.activity'}).items.length,0);
  assert.equal(node.store.db.prepare("SELECT count(*) n FROM sqlite_temp_master WHERE type='trigger' AND name GLOB 'activity_memory_*'").get()!.n,0);
  assert.equal((await request('GET','/api/work-activity')).status,503);
  assert.equal((await request('GET','/api/agent-view/runs')).status,200,'the separately selected read-only sibling retains its owner');
  assert.equal((await request('GET','/api/capture-browser/'+original.id)).status,200);
  await node.app.close();const restored=await f.build();assert.equal(restored.materials.list({kind:'mote.activity'}).items.length,0);
});

test('Activity uses only the current QueryRuns metadata lease and refuses to outlive that provider',async t=>{
  const f=fixture(t),install=PluginHost.prototype.install;let queryOwner:PluginHandle|undefined,metadataBinding:ServiceBinding|undefined;
  t.mock.method(PluginHost.prototype,'install',async function(this:PluginHost,definition:Parameters<PluginHost['install']>[0]){
    if(!definition.contributions.some(entry=>entry.id==='query-runs'))return install.call(this,definition);
    const factory=definition.factory;const handle=await install.call(this,{...definition,factory:(context:HostPluginContext)=>factory({scope:context.scope,services:context.services,get state(){return context.state;},provide<T>(id:string,contract:ServiceContract<T>,value:T,revision?:number){const binding=context.provide(id,contract,value,revision);if(binding.service.id==='mote.central.query-work-metadata')metadataBinding=binding;return binding;}})});
    queryOwner=handle;return handle;
  });
  const node=await f.build(),request=await http(node,f.headers);
  node.delegation.registerCoordinator({id:'generated',execute:async()=>null});
  const work=node.delegation.start({id:'generated-metadata-only',operationId:'query:generated-metadata-only',profileId:'generated',goal:'Generated public work goal',input:{privatePayload:'GENERATED_PRIVATE_PAYLOAD'},allowedCapabilities:[]});
  assert.ok(metadataBinding);
  const {queryWorkMetadataContract}=await import('../src/plugins/query-runs.js');
  const lease=await node.bootstrap.host.acquire(queryWorkMetadataContract,metadataBinding);
  const read=lease.value.get(work.id);assert.equal(read.goal,'Generated public work goal');assert.ok(!JSON.stringify(read).includes('GENERATED_PRIVATE_PAYLOAD'));
  assert.deepEqual(Object.keys(lease.value).sort(),['artifactMetadata','get','list']);
  assert.equal((await request('GET','/api/work-activity')).status,200);
  await queryOwner!.close('disabled');assert.throws(()=>lease.value.get(work.id),{code:'dependency_unavailable'});await lease.release();
  const page=await request('GET','/api/work-activity');assert.equal(page.status,503,'even persisted SQL metadata does not bypass the current provider lease');
  assert.equal((await request('GET','/api/agent-view/runs')).status,200);
});

test('App close joins an already withdrawn Activity owner and retains its original disposal failure',async t=>{
  const f=fixture(t),failure=Error('Generated Activity disposal failure'),install=PluginHost.prototype.install;let owner:PluginHandle|undefined;
  const contains=(error:unknown):boolean=>error===failure||error instanceof AggregateError&&error.errors.some(contains);
  t.mock.method(PluginHost.prototype,'install',async function(this:PluginHost,definition:Parameters<PluginHost['install']>[0]){const handle=await install.call(this,definition);if(definition.contributions.some(entry=>entry.id==='activity-services'))owner=handle;return handle;});
  const distribution={...defaultDistribution,plugins:defaultDistribution.plugins.map(entry=>entry.contribution.id!=='activity-services'?entry:{...entry,activation:{...entry.activation!,async create(context:HostPluginContext,bindings:Readonly<Record<string,ServiceBinding>>){
    const domain=await entry.activation!.create(context,bindings);
    return {...domain,async dispose(){await domain.dispose();throw failure;}};
  }}})};
  const node=await buildApp(f.config,{distribution,backgroundWorker:false,agent:{configured:false,close:async()=>{},query:async()=>{throw Error('No model');}}});
  let closeObserved=false;t.after(async()=>{if(!closeObserved)await node.app.close();});
  const request=await http(node,f.headers);
  await assert.rejects(owner!.close('disabled'),contains);
  assert.equal((await request('GET','/api/work-activity')).status,503);assert.equal((await request('GET','/api/agent-view/runs')).status,200);
  assert.equal(node.store.db.prepare("SELECT count(*) n FROM sqlite_temp_master WHERE type='trigger' AND name GLOB 'activity_memory_*'").get()!.n,0);
  const domains=await node.bootstrap.activateDomains(),closing=domains.close();await assert.rejects(closing,contains);assert.equal(domains.close(),closing);await assert.rejects(domains.close(),contains);
  await assert.rejects(node.app.close(),contains);closeObserved=true;
  assert.throws(()=>node.store.db.prepare('SELECT 1').get(),/database is not open/);
});
