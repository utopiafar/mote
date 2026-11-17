import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {QueryAgent} from '../src/query-agent.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {defaultDistribution,storageProvider} from '../src/distribution/default.js';
import {actionsServicesContract,actionsServicesInputsContract} from '../src/plugins/actions-services.js';
import {authorizeFixtureModels} from './fixtures/model-authorization.js';
import {hostRun} from './fixtures/host-run.js';

const text='Generated appointment is scheduled on 18 September 2099.';
const event={title:'Generated appointment',start:'2099-09-18T15:00:00Z',end:'2099-09-18T16:00:00Z',timeZone:'UTC',allDay:false,location:'Generated room',description:''};
const inert:QueryAgent={configured:false,close:async()=>{},query:async()=>{throw Error('An unconfigured fixture cannot call a model');}};
function fixture(t:TestContext,unblock=()=>{}){
  const dataDir=mkdtempSync(join(tmpdir(),'mote-actions-domain-')),nodes:Awaited<ReturnType<typeof buildApp>>[]=[];
  const config:Config={dataDir,token:'generated-actions-domain-owner',tokenPath:join(dataDir,'token'),host:'127.0.0.1',port:0,maxExportBytes:1_000_000,
    insightIntervalHours:0,allowedOrigins:[],model:'fixture-model',modelBaseUrl:'https://generated.invalid',apiKey:'generated',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
  t.after(async()=>{unblock();try{for(const node of nodes.reverse())await node.app.close();}finally{rmSync(dataDir,{recursive:true,force:true});}});
  const build=async(options:Parameters<typeof buildApp>[1]={})=>{const node=await buildApp(config,{agent:inert,backgroundWorker:false,...options});nodes.push(node);return node;};
  return {config,build,headers:{authorization:'Bearer '+config.token}};
}
async function http(node:Awaited<ReturnType<typeof buildApp>>,headers:{authorization:string}){
  const origin=await node.app.listen({host:'127.0.0.1',port:0});
  return async(method:string,path:string,body?:unknown)=>{
    const response=await fetch(origin+path,{method,headers:{...headers,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,json:await response.json()};
  };
}
async function until(read:()=>boolean,label:string){for(let i=0;i<500;i++){if(read())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Timed out waiting for '+label);}
function model(hold?:(input:QueryInput)=>Promise<void>):QueryAgent{
  return {configured:true,close:async()=>{},async query(input,lease){
    lease?.onFinalizer?.('host');
    if(input.skill==='calendar-extraction')await hold?.(input);
    hostRun(input);
    const id=input.evidenceIds![0],evidence=[{id,quote:text}];
    const answer=input.skill==='calendar-extraction'
      ?{actions:[{kind:'calendar.create',event,uncertainty:'Generated proposal',sameAs:null,evidence}]}
      :{summary:'Generated appointment',evidence,events:[],memoryCandidates:[],actionCues:[{kind:'calendar.create',event,uncertainty:'Generated proposal',evidence}]};
    return {answer:JSON.stringify(answer),citations:[{id,capturedAt:'2026-01-01T00:00:00Z',appName:'Generated',excerpt:text}],trace:[],runId:randomUUID()};
  }};
}
async function input(node:Awaited<ReturnType<typeof buildApp>>){
  node.sources.register({id:'generated-actions-source',kind:'custom',name:'Generated source',deviceId:'generated-input',platform:'import'});
  return node.sources.upsert('generated-actions-source',{externalId:'one',revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'message',layer:'original',text});
}
async function enable(node:Awaited<ReturnType<typeof buildApp>>,request:Awaited<ReturnType<typeof http>>){
  await authorizeFixtureModels(node);
  const response=await request('PUT','/api/actions/settings',{revision:node.configService.revision,authorizationRevision:node.actions.authorizationRevision(),settings:{enabled:true,timeZone:'UTC',reviewDeviceIds:['generated-input']}});
  assert.equal(response.status,200,JSON.stringify(response.json));
}

test('unselected Actions has no input activation, handler, poll or domain tables while insights and Notes remain usable',async t=>{
  for(const selection of ['feature','plugin'] as const)await t.test(selection,async t=>{
    const f=fixture(t);let handlers=0,polls=0;
    const register=ExecutionEngine.prototype.register,interval=globalThis.setInterval;
    t.mock.method(ExecutionEngine.prototype,'register',function(handler){if(handler.kind==='actions.extract')handlers++;return register.call(this,handler);});
    t.mock.method(globalThis,'setInterval',function(callback,delay,...args){if(delay===15000)polls++;return interval(callback,delay,...args);});
    const distribution={...defaultDistribution,...(selection==='feature'
      ?{features:defaultDistribution.features.filter(id=>id!=='mote.actions')}
      :{plugins:defaultDistribution.plugins.filter(plugin=>plugin.contribution.id!=='actions-services')})};
    const node=await f.build({distribution}),request=await http(node,f.headers);
    assert.deepEqual({handlers,polls},{handlers:0,polls:0});
    assert.deepEqual(node.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name GLOB 'action_*' OR name='assistant_action_links')").all(),[]);
    assert.ok(node.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='todos'").get(),'the pre-existing Vault Todo schema is a separate boundary');
    assert.ok(!node.bootstrap.snapshot().contributions.some(item=>item.identity.contributionId.startsWith('actions-services')));
    assert.throws(()=>node.actions,/Actions plugin is not selected/);
    for(const path of ['/api/actions','/api/todos','/api/action-capabilities'])assert.equal((await request('GET',path)).status,404,path);
    assert.equal((await request('GET','/api/insight-runs')).status,200);
    assert.ok(node.lifecycle.view().extensions.some(extension=>extension.id==='insights'));
    const note={id:randomUUID(),deviceId:'generated-note',deviceName:'Generated',platform:'android',capturedAt:'2026-11-17T00:00:00Z',text:'Generated unaffected original'};
    assert.equal((await request('POST','/api/notes',note)).status,201);
    assert.equal((await request('GET','/api/notes/'+note.id)).json.ocrText,note.text);
  });
});

test('the declared Actions provider publishes through the real HTTP domain and retains proposals and replayable Todos across removal and restart',async t=>{
  const f=fixture(t);let calls=0;
  const node=await f.build({agent:model(async()=>{calls++;})}),request=await http(node,f.headers);
  await enable(node,request);await input(node);
  const service=await node.bootstrap.acquireDomainService('actions-services',actionsServicesContract);
  const factory=await node.bootstrap.acquireDomainService('actions-services-inputs',actionsServicesInputsContract);
  assert.deepEqual(Object.keys(factory.value),['open'],'the published input has no Store, SQL or engine bag');await factory.release();
  await service.value.poll();assert.equal(calls,1);
  const proposals=await request('GET','/api/actions');assert.equal(proposals.status,200);
  const proposal=node.actions.list()[0];assert.ok(proposal);assert.equal(proposal.status,'proposed');
  assert.equal(node.actions.engine,node.executor,'the trusted handoff retains the existing engine identity');
  const todo={id:randomUUID(),title:'Generated durable Todo'};
  assert.equal((await request('POST','/api/todos',todo)).status,201);
  const snapshot=node.bootstrap.snapshot();
  for(const id of ['actions-services-inputs','actions-services'])assert.equal(snapshot.contributions.filter(item=>item.identity.contributionId===id).length,1,id);
  await service.release();await node.app.close();
  const removed=await f.build({distribution:{...defaultDistribution,plugins:defaultDistribution.plugins.filter(plugin=>plugin.contribution.id!=='actions-services')}}),read=await http(removed,f.headers);
  assert.equal((await read('GET','/api/actions')).status,404);
  assert.equal(removed.store.db.prepare('SELECT count(*) n FROM action_proposals').get()!.n,1);
  assert.equal(removed.store.db.prepare('SELECT count(*) n FROM todos').get()!.n,1);
  await removed.app.close();
  const restored=await f.build({agent:model(async()=>{calls++;throw Error('A completed input cannot call the model again');})}),again=await http(restored,f.headers);
  assert.equal(restored.actions.get(proposal.id).id,proposal.id);
  assert.equal((await again('POST','/api/todos',todo)).status,201);
  assert.equal((await again('GET','/api/todos')).json.items.length,1);
  await restored.actionsServices.poll();assert.equal(calls,1);
});

test('an in-flight Actions cancellation fences the late proposal while domain close and App close preserve Notes and the cancelled receipt',async t=>{
  let release!:()=>void,entered!:()=>void,calls=0,signal:AbortSignal|undefined,stepId='';
  const f=fixture(t,()=>release?.());
  const held=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  const node=await f.build({agent:model(async input=>{calls++;signal=input.signal;stepId='actions:'+input.traceContext!.jobId;entered();await held;})}),request=await http(node,f.headers);
  await enable(node,request);await input(node);
  const poll=node.actionsServices.poll();await started;
  assert.equal(node.executor.get(stepId)!.state,'running');node.executor.cancel(stepId);
  await until(()=>signal?.aborted===true,'accepted model cancellation');
  const domains=await node.bootstrap.activateDomains();await domains.quiesce();
  for(const path of ['/api/actions','/api/todos','/api/action-capabilities'])assert.equal((await request('GET',path)).status,503,path);
  const closing=domains.close();release();await Promise.all([poll,closing]);
  await until(()=>node.queryServices.runtime.activeQueries.size===0,'the late controlled model result');
  assert.equal(node.store.db.prepare('SELECT count(*) n FROM action_proposals').get()!.n,0);
  assert.equal(node.executor.get(stepId)!.state,'cancelled');
  const note={id:randomUUID(),deviceId:'generated-note',deviceName:'Generated',platform:'android',capturedAt:'2026-11-17T00:00:00Z',text:'Generated original while Actions is stopped'};
  assert.equal((await request('POST','/api/notes',note)).status,201);
  await node.app.close();
  const restored=await f.build({agent:model(async()=>{calls++;throw Error('A cancelled input cannot be replayed');})}),again=await http(restored,f.headers);
  assert.equal((await again('GET','/api/notes/'+note.id)).json.ocrText,note.text);
  await restored.actionsServices.poll();assert.equal(calls,1);assert.equal(restored.executor.get(stepId)!.state,'cancelled');
});

test('failure after Actions registers its handler closes the partial domain and allows the same profile to reopen',async t=>{
  const f=fixture(t),failure=Error('Generated capability repository failure');let closed=false;
  const distribution={...defaultDistribution,foundations:defaultDistribution.foundations.map(provider=>provider.kind==='storage'?{...provider,async create(context,options){
    const value=await storageProvider.create(context,options),register=value.store.registerStorage.bind(value.store),close=value.store.close.bind(value.store);
    value.store.registerStorage=(id,...args)=>{if(id==='actions-services')throw failure;return register(id,...args);};
    value.store.close=()=>{closed=true;return close();};return value;
  }}:provider)};
  await assert.rejects(f.build({distribution}),error=>error===failure);
  assert.equal(closed,true);
  const restored=await f.build(),request=await http(restored,f.headers);
  assert.equal((await request('GET','/api/actions')).status,200);
  assert.ok(restored.actionsServices.available);
});
