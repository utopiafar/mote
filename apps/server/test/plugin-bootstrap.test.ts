import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {bootstrapCentral,type CentralDistribution,type FoundationProvider} from '../src/bootstrap.js';
import {defaultDistribution,configurationProvider,storageProvider} from '../src/distribution/default.js';
import {Store} from '../src/store.js';
import {ServerDiagnostics} from '../src/diagnostics.js';
import type {Config} from '../src/config.js';
import {executionSettingsSchema} from '../src/execution-settings.js';

function fixture(t:{after(fn:()=>void):void}){
  const dataDir=mkdtempSync(join(tmpdir(),'mote-bootstrap-fixture-'));
  t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
  const config:Config={dataDir,token:'generated-bootstrap-owner-token',tokenPath:'fixture-only',host:'127.0.0.1',port:0,
    maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
    model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
  return {config,headers:{authorization:`Bearer ${config.token}`}};
}
function note(){return {id:randomUUID(),deviceId:'generated-bootstrap-device',deviceName:'Generated bootstrap fixture',platform:'android',capturedAt:'2026-11-01T12:00:00.000Z',text:'Generated original note for the native loader.'};}
const agent={configured:false,query:async()=>{throw Error('No model in bootstrap fixture');},close:async()=>{}};

test('default loader preserves the complete product, owner checks and original note write/read, then closes its vault',async t=>{
  const {config,headers}=fixture(t),node=await buildApp(config,{agent,backgroundWorker:false});
  t.after(()=>node.app.close());
  assert.equal(node.executor,node.executionPlatform.assembly.executor,'buildApp must use the execution platform engine');
  const execution=node.featureServices.runtimeSettings.execution();
  assert.deepEqual({agent:node.executionPlatform.assembly.agentGate.snapshot().limit,llm:node.executionPlatform.assembly.llmGate.snapshot().limit,interactive:node.executionPlatform.assembly.interactiveGate.snapshot().limit,interactiveModel:node.executionPlatform.assembly.interactiveModelGate.snapshot().limit},
    {agent:execution.agentConcurrency,llm:execution.llmConcurrency,interactive:execution.interactiveConcurrency,interactiveModel:execution.interactiveConcurrency});
  assert.deepEqual(node.featureHost.registry.inventory().features.map(feature=>feature.id),[
    'mote.activity','mote.files','mote.actions','mote.connections','mote.system','mote.storage','mote.capture','mote.context','mote.materials',
    'mote.coding','mote.sources','mote.models','mote.processing','mote.notes','mote.devices','mote.media','mote.owner-questions','mote.memory',
    'mote.imports','mote.ask','mote.insights','mote.agent-view','mote.features',
  ]);
  assert.equal(node.bootstrap.snapshot().contributions.length,10);
  assert.deepEqual(node.bootstrap.hostDependencies,[...defaultDistribution.foundations.map(provider=>({id:provider.id,version:provider.version})),{id:'observability-platform',version:'1.0.0'},{id:'source-integration',version:'1.0.0'}]);
  assert.equal(node.configurationPlatform,node.bootstrap.configurationPlatform);
  assert.equal(node.configurationPlatform.configService,node.configService);
  assert.equal(node.configurationPlatform.modelSettings,node.modelSettings);
  const input=note();
  assert.equal((await node.app.inject({method:'POST',url:'/api/notes',payload:input})).statusCode,401);
  const created=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:input});
  assert.equal(created.statusCode,201,created.body);assert.equal(created.json().receipt.state,'received');
  const read=await node.app.inject({url:`/api/notes/${input.id}`,headers});
  assert.equal(read.statusCode,200,read.body);assert.equal(read.json().ocrText,input.text);
  assert.equal(node.diagnostics,node.observabilityAssembly.diagnostics);
  assert.equal((await node.app.inject({url:'/api/diagnostics',headers})).statusCode,200);
  const usage=await node.app.inject({url:'/api/usage?from=2026-11-01&to=2026-11-03',headers});
  assert.equal(usage.statusCode,200,usage.body);
  await node.app.close();await node.app.close();
  assert.equal(node.executor.closed,true);
  assert.throws(()=>node.configurationPlatform.configService);
  assert.throws(()=>node.executionPlatform.assembly);
  assert.throws(()=>node.observabilityPlatform.forAssembly(node.observabilityScope));
  assert.equal(node.bootstrap.snapshot().contributions.length,0);
  assert.throws(()=>node.store.stats());
});

test('shutdown drains a held execution configuration transaction before stopping execution',async t=>{
  const {config,headers}=fixture(t),node=await buildApp(config,{agent,backgroundWorker:false});
  t.after(()=>node.app.close());
  const initial=(await node.app.inject({url:'/api/execution-settings',headers})).json();
  let entered!:()=>void,release!:()=>void;const running=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  node.configService.setHandler('execution',async(next)=>{entered();await gate;return {apply(){},publish:()=>node.executionPlatform.refreshSettings(executionSettingsSchema.strip().parse(next))};});
  const request=node.app.inject({method:'PUT',url:'/api/execution-settings',headers,payload:{revision:initial.revision,interactiveConcurrency:1,agentConcurrency:2,llmConcurrency:2,memoryConcurrency:1}});
  await running;
  const closing=node.app.close();
  await new Promise(resolve=>setImmediate(resolve));
  const quiescing=node.configurationPlatform.quiesce('shutdown');
  await assert.rejects(node.configService.update('execution',{interactiveConcurrency:1,agentConcurrency:2,llmConcurrency:2,memoryConcurrency:1},initial.revision),{code:'config_unavailable'});
  release();
  const response=await request;assert.equal(response.statusCode,200,response.body);
  assert.equal(node.featureServices.agentGate.snapshot().limit,2,'the held execution refresh ran against a live platform');
  await closing;await quiescing;
});

test('configuration drain failure does not abort shutdown cleanup',async t=>{
  const {config}=fixture(t),node=await buildApp(config,{agent,backgroundWorker:false});
  (node.configurationPlatform as any).quiesce=async()=>{throw new Error('generated configuration unavailable');};
  await node.app.close();
  assert.equal(node.executor.closed,true);
  assert.throws(()=>node.store.stats());
});

test('configuration drain failure is retained by enabled diagnostics',async t=>{
  const {config}=fixture(t),node=await buildApp({...config,logLevel:'error',diagnosticsEnabled:true},{agent,backgroundWorker:false});
  (node.configurationPlatform as any).quiesce=async()=>{throw new Error('generated configuration unavailable');};
  await node.app.close();
  const events=node.diagnostics.events(0,100).items;
  assert.ok(events.some(event=>event.event==='config.shutdown_drain_failed'),'the shutdown drain failure must survive the diagnostics allowlist');
});

test('observability startup failure rolls back the bootstrap vault for a clean reopen',async t=>{
  const {config}=fixture(t),failure=new Error('generated observability init failure'),init=ServerDiagnostics.prototype.init;
  ServerDiagnostics.prototype.init=async function(){throw failure;};
  try{await assert.rejects(buildApp(config,{agent,backgroundWorker:false}),error=>error===failure||(error as AggregateError).errors?.includes?.(failure)||(error as {cause?:unknown}).cause===failure);}
  finally{ServerDiagnostics.prototype.init=init;}
  const reopened=new Store(config.dataDir);try{assert.equal(reopened.stats().captures,0);}finally{reopened.close();}
});

test('missing or duplicate foundation providers reject before any factory or HTTP app is created',async t=>{
  const {config}=fixture(t);let opened=0;
  const configuration:FoundationProvider<'configuration'>={...configurationProvider,create(context,input){opened++;return configurationProvider.create(context,input);}};
  for(const missing of ['authorization','storage'] as const){
    const distribution:CentralDistribution={...defaultDistribution,foundations:defaultDistribution.foundations.filter(provider=>provider.kind!==missing).map(provider=>provider.kind==='configuration'?configuration:provider)};
    await assert.rejects(buildApp(config,{distribution}),{code:'MOTE_BOOTSTRAP_INVALID'});
  }
  await assert.rejects(buildApp(config,{distribution:{...defaultDistribution,foundations:[configuration,...defaultDistribution.foundations]}}),{code:'MOTE_BOOTSTRAP_INVALID'});
  const wrongApi:FoundationProvider<'storage'>={...storageProvider,contribution:{...storageProvider.contribution,provides:[{kind:'service',id:'mote.platform.storage',apiVersion:'2',cardinality:'single'}]}};
  await assert.rejects(buildApp(config,{distribution:{...defaultDistribution,foundations:defaultDistribution.foundations.map(provider=>provider.kind==='storage'?wrongApi:provider.kind==='configuration'?configuration:provider)}}),{code:'MOTE_BOOTSTRAP_INVALID'});
  assert.equal(opened,0);
});

test('failure after storage preparation rolls back the owned vault and publishes no running app',async t=>{
  const {config}=fixture(t);let prepared:Store|undefined;
  const storage:FoundationProvider<'storage'>={...storageProvider,async create(context,input){const value=await storageProvider.create(context,input);prepared=value.store;return value;}};
  const primary=Error('generated authorization startup failure');
  const distribution:CentralDistribution={...defaultDistribution,foundations:defaultDistribution.foundations.map(provider=>provider.kind==='storage'?storage:provider.kind==='authorization'?{...provider,create(){throw primary;}}:provider)};
  await assert.rejects(buildApp(config,{distribution}),error=>error===primary);
  assert.ok(prepared);assert.throws(()=>prepared!.stats());
  // Actual same-profile reopen proves rollback released the SQLite resource.
  const reopened=new Store(config.dataDir);reopened.close();
});

test('restart replacement sends real HTTP writes to the newly selected provider and retains the same-profile original',async t=>{
  const {config,headers}=fixture(t);const writes={first:0,second:0};
  const provider=(which:'first'|'second'):FoundationProvider<'storage'>=>({...storageProvider,id:`fixture.vault-${which}`,async create(context,input){
    const value=await storageProvider.create(context,input);
    const ingest=value.store.ingest.bind(value.store);
    value.store.ingest=async(...args)=>{writes[which]++;return ingest(...args);};return value;
  }});
  const distribution=(which:'first'|'second'):CentralDistribution=>({...defaultDistribution,foundations:defaultDistribution.foundations.map(entry=>entry.kind==='storage'?provider(which):entry)});
  const first=await buildApp(config,{agent,backgroundWorker:false,distribution:distribution('first')});t.after(()=>first.app.close());
  const input=note();assert.equal((await first.app.inject({method:'POST',url:'/api/notes',headers,payload:input})).statusCode,201);
  const originalHost=first.bootstrap.snapshot().host.id;
  await first.app.close();assert.throws(()=>first.store.stats());
  const second=await buildApp(config,{agent,backgroundWorker:false,distribution:distribution('second')});t.after(()=>second.app.close());
  assert.notEqual(second.bootstrap.snapshot().host.id,originalHost);
  assert.ok(second.bootstrap.hostDependencies.some(provider=>provider.id==='fixture.vault-second'));
  assert.ok(!second.bootstrap.hostDependencies.some(provider=>provider.id==='fixture.vault-first'));
  assert.equal((await second.app.inject({url:`/api/notes/${input.id}`,headers})).json().ocrText,input.text);
  assert.equal((await second.app.inject({method:'POST',url:'/api/notes',headers,payload:note()})).statusCode,201);
  assert.deepEqual(writes,{first:1,second:1});
  await second.app.close();assert.equal(second.bootstrap.snapshot().contributions.length,0);
});

test('a borrowed vault remains owned by its caller after bootstrap closes',async t=>{
  const {config}=fixture(t),store=new Store(config.dataDir);t.after(()=>store.close());
  const boot=await bootstrapCentral({config,store});
  await boot.close();assert.equal(store.stats().captures,0);
});
