import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import Fastify,{type FastifyRequest} from 'fastify';
import {captureSchema,type CaptureInput} from '@mote/shared';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {MaterialMemoryWork} from '../src/material-memory-work.js';
import {installCaptureMemoryIntake} from '../src/capture-memory-intake.js';
import {modelConnection} from '../src/background-model-authorization.js';
import {DEFAULT_MEMORY_INPUT_SCOPE,automaticMemoryGrantSchema} from '../src/memory-input-authorization.js';
import {MemoryStrategies} from '../src/memory-strategies.js';
import {MemoryRecipeSettings} from '../src/memory-recipe-settings.js';
import type {ConnectorConfig} from '../src/connectors/types.js';
import {PluginHost} from '@mote/plugin-host';
import {Connections} from '../src/connections.js';
import {centralServices} from '../src/plugins/central-contracts.js';
import {createAuthorizationPlatform,createAuthorizationPlatformFactory,authorizationPlatformDeclaration,authorizationPlatformContribution} from '../src/plugins/authorization-platform.js';
import type {CommitAuthority,RequestAuthority} from '../src/plugins/central-contracts.js';

const ownerToken='generated-owner-authorization-token';
const capture=(deviceId='generated-phone-a'):CaptureInput=>captureSchema.parse({id:randomUUID(),deviceId,deviceName:'Generated phone',platform:'android',source:'note',capturedAt:new Date().toISOString(),durationMs:0,ocrText:'Generated evidence only'});
const item=(externalId=randomUUID())=>({externalId,revision:'1',observedAt:new Date().toISOString(),title:'Generated source input',text:'Generated source body',kind:'file',layer:'snapshot',deleted:false});
async function fixture(t:import('node:test').TestContext,withRecipes=false){
  const directory=mkdtempSync(join(tmpdir(),'mote-authorization-platform-')),store=new Store(directory),materials=new MaterialStore(store);
  let now=Date.now();const recipes=withRecipes?new MemoryRecipeSettings(store,new MemoryStrategies()):undefined;
  const memory=new MaterialMemoryWork(store,materials,()=>now,()=>true,recipes),sources=new SourceStore(store,undefined,memory.inputs),files=new FileStore(store,sources);
  let models=[modelConnection('generated-model',{model:'generated-original',apiKey:'fixture-only'})];
  const connectorConfig:ConnectorConfig={directory:join(directory,'connectors'),mcpEnabled:true,mcpReadToken:'generated-static-read-token',mcpWriteEnabled:true,mcpWriteToken:'generated-static-write-token',mcpWriteSourceIds:['generated-source-a']};
  const options={ownerToken,connectorConfiguration:()=>connectorConfig,allowedOrigins:['https://generated.invalid'],clock:()=>now};
  const dependencies={store,availableModelConnections:()=>models};
  let platform=createAuthorizationPlatform(options,dependencies);
  const prepare=async()=>{await platform.prepare();platform.bindRepositories({sources,files,materials,memoryInputs:memory.inputs,memoryWork:memory});await platform.start();};await prepare();
  const disposeCapture=installCaptureMemoryIntake(store,memory,input=>platform.assembly.modelAuthorizationHost!.capture(input));
  for(const [id,deviceId] of [['generated-source-a','generated-phone-a'],['generated-source-b','generated-phone-b']])sources.register({id,name:id,kind:'custom',deviceId,platform:'android',enabled:true,retention:'snapshot'});
  const connections=()=>platform.assembly.connections!;
  const app=Fastify(),requests=new WeakMap<FastifyRequest,RequestAuthority>();
  app.setErrorHandler((error,_request,reply)=>{const value=error as Error&{code?:string;statusCode?:number};reply.code(value.statusCode??500).send({error:value.code??'authorization_unavailable'});});
  app.addHook('onRequest',async request=>{requests.set(request,platform.bindRequest({authorization:request.headers.authorization,method:request.method,route:request.routeOptions.url!,params:request.params as {id?:string},origin:request.headers.origin}));});
  app.addHook('onResponse',async request=>{const pin=requests.get(request);if(pin)platform.releaseRequest(pin);});
  app.post('/api/captures',async request=>{const input=captureSchema.parse(request.body),pin=requests.get(request)!;return platform.withCapture(pin,input,()=>platform.captureIntake.capture(input,platform.commits.capture()));});
  app.post('/api/model-authorization/commands',async request=>{return platform.assembly.modelAuthorization.command(request.body);});
  app.put('/api/sources/:id/items',async request=>{const sourceId=(request.params as {id:string}).id,pin=requests.get(request)!;return platform.withSource(pin,sourceId,request.body,()=>platform.sourceIntake.sourceItem(sourceId,request.body,platform.commits.capture()));});
  // Scope/authorization HTTP boundary, not a replacement MCP protocol implementation.
  // The actual target is committed by the same SourceIntake/Ingress/SourceStore producer.
  app.post('/mcp',async request=>{const input=request.body as {sourceId:string;item:unknown},pin=requests.get(request)!;return platform.withSource(pin,input.sourceId,input.item,()=>platform.sourceIntake.sourceItem(input.sourceId,input.item,platform.commits.capture()));});
  await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();assert.ok(address&&typeof address==='object');const url='http://127.0.0.1:'+address.port;
  const http=async(path:string,token:string,body:unknown,method='POST')=>{const response=await fetch(url+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,value:await response.json() as {error?:string;id?:string;receipt?:{version:number;state:string}}};};
  const collector=async()=>{const invitation=connections().invite({serverUrl:'https://generated.invalid',label:'Generated collector',deviceId:'generated-phone-a'},'collector');return connections().redeem({code:invitation.invitation.code,deviceId:'generated-phone-a',deviceName:'Generated phone',platform:'android'});};
  t.after(async()=>{await app.close();disposeCapture();await platform.close();await files.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,sources,files,memory,materials,recipes,http,collector,connections,connectorConfig,
    get platform(){return platform;},get model(){return models[0];},advance(ms:number){now+=ms;},
    addModel(){models=[...models,modelConnection('generated-replacement',{model:'generated-new',apiKey:'fixture-only'})];},
    withdrawOriginalModel(){models=models.slice(1);},
    async restart(){await platform.close();platform=createAuthorizationPlatform(options,dependencies);await prepare();},
  };
}

test('loopback owner, collector and MCP HTTP boundaries retain the existing route/device/source rules',async t=>{
  const f=await fixture(t),paired=await f.collector();
  const accepted=await f.http('/api/captures',paired.token,capture());assert.equal(accepted.status,200);assert.equal(accepted.value.receipt?.version,2);assert.equal(f.store.evidence([accepted.value.id!]).length,1);
  assert.equal((await f.http('/api/captures',paired.token,capture('generated-phone-b'))).status,403);
  assert.equal((await f.http('/api/model-authorization/commands',paired.token,{})).status,403);assert.equal(f.platform.assembly.modelAuthorization.view().revision,0);
  const owner=await f.http('/api/captures',ownerToken,capture('generated-phone-b'));assert.equal(owner.status,200);
  assert.equal((await f.http('/api/sources/generated-source-a/items',paired.token,item(),'PUT')).status,200);
  assert.equal((await f.http('/api/sources/generated-source-b/items',paired.token,item(),'PUT')).status,403);
  const read=await f.connections().mintMcp({serverUrl:'https://generated.invalid',label:'Generated read',access:'read'},f.connectorConfig);
  const write=await f.connections().mintMcp({serverUrl:'https://generated.invalid',label:'Generated write',access:'write'},f.connectorConfig);
  const token=(grant:typeof read)=>grant.config.mcpServers.mote.headers.Authorization.slice(7);
  assert.equal((await f.http('/mcp',token(read),{sourceId:'generated-source-a',item:item()})).status,403);
  assert.equal((await f.http('/mcp',token(write),{sourceId:'generated-source-a',item:item()})).status,200);
  assert.equal((await f.http('/mcp',token(write),{sourceId:'generated-source-b',item:item()})).status,403);
  assert.equal((await f.http('/api/captures',token(write),capture())).status,403);
  assert.equal((await f.http('/mcp',f.connectorConfig.mcpWriteToken!,{sourceId:'generated-source-a',item:item()})).status,200);
  assert.equal((await f.http('/mcp',f.connectorConfig.mcpReadToken!,{sourceId:'generated-source-a',item:item()})).status,403);
  const originalWriteToken=f.connectorConfig.mcpWriteToken;f.connectorConfig.mcpWriteToken=token(read);try{assert.equal((await f.http('/mcp',token(read),{sourceId:'generated-source-a',item:item()})).status,200,'explicit static-write token follows the existing MCP precedence');}finally{f.connectorConfig.mcpWriteToken=originalWriteToken;}
  assert.equal((await f.http('/api/captures','generated-wrong-token',capture())).status,401);
  assert.deepEqual(authorizationPlatformContribution.provides,[],'ordinary plugins get no issuer or controls');
});

test('actual Ingress target checks reject mutable, forged, expired and cross-admission commit references',async t=>{
  const f=await fixture(t),p=f.platform,input=capture(),request=p.bindRequest({authorization:'Bearer '+ownerToken,method:'POST',route:'/api/captures'});
  let expired:CommitAuthority|undefined;
  assert.throws(()=>p.commits.capture(),{code:'commit_authority_invalid'});
  let invoked=false;assert.throws(()=>Reflect.apply(p.commits.assertCurrent,undefined,[{assertCurrent(){invoked=true;}}]),{code:'commit_authority_invalid'});assert.equal(invoked,false);
  const foreign=await fixture(t);
  await p.withCapture(request,input,async()=>{
    const grant=p.commits.capture();expired=grant;assert.throws(()=>p.commits.assertCurrent(request),{code:'commit_authority_invalid'});
    const text=input.ocrText;input.ocrText='Generated changed after admission';await assert.rejects(p.captureIntake.capture(input,grant),{code:'commit_target_mismatch'});input.ocrText=text;
    const foreignRequest=foreign.platform.bindRequest({authorization:'Bearer '+ownerToken,method:'POST',route:'/api/captures'});
    try{await foreign.platform.withCapture(foreignRequest,input,async()=>{await assert.rejects(foreign.platform.captureIntake.capture(input,grant),{code:'commit_authority_invalid'});});}finally{foreign.platform.releaseRequest(foreignRequest);}
    await assert.rejects(p.captureIntake.capture({...input,id:randomUUID()},grant),{code:'commit_target_mismatch'});
    await assert.rejects(p.captureIntake.capture(input,JSON.parse(JSON.stringify(grant)) as CommitAuthority),{code:'commit_authority_invalid'});
    const other=p.bindRequest({authorization:'Bearer '+ownerToken,method:'POST',route:'/api/captures'});
    try{await p.withCapture(other,input,async()=>{await assert.rejects(p.captureIntake.capture(input,grant),{code:'commit_authority_invalid'});});}finally{p.releaseRequest(other);}
    const result=await p.captureIntake.capture(input,grant);assert.equal(result.receipt.state,'received');
  });
  await assert.rejects(p.captureIntake.capture(input,expired!),{code:'commit_authority_invalid'});p.releaseRequest(request);
  assert.equal(f.store.stats().captures,1);
  const sourceRequest=p.bindRequest({authorization:'Bearer '+ownerToken,method:'PUT',route:'/api/sources/:id/items',params:{id:'generated-source-a'}}),raw=item();
  try{await p.withSource(sourceRequest,'generated-source-a',raw,async()=>{const pin=p.commits.capture();await assert.rejects(p.sourceIntake.sourceItem('generated-source-b',raw,pin),{code:'commit_target_mismatch'});const received=await p.sourceIntake.sourceItem('generated-source-a',raw,pin);assert.equal(received.receipt.sourceId,'generated-source-a');});}finally{p.releaseRequest(sourceRequest);}
});

for(const cause of ['credential-revocation','request-release','platform-stop'] as const)test(`actual intake rechecks ${cause} while real preparation is paused`,async t=>{
  const f=await fixture(t),paired=await f.collector(),p=f.platform,raw=capture(),request=p.bindRequest({authorization:'Bearer '+paired.token,method:'POST',route:'/api/captures'});
  const prepare=f.store.prepare.bind(f.store);let release!:()=>void,entered!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  f.store.prepare=async input=>{const prepared=await prepare(input);entered();await held;return prepared;};
  let stop:Promise<void>|undefined;const signal=p.requestSignal(request);
  const result=p.withCapture(request,raw,()=>p.captureIntake.capture(raw,p.commits.capture()));
  const rejected=assert.rejects(result);
  try{
    await started;
    if(cause==='credential-revocation')await f.connections().revoke(paired.credentialId);
    else if(cause==='request-release')p.releaseRequest(request);
    else stop=p.stop('revoked');
    assert.equal(signal.aborted,true);
  }finally{release();f.store.prepare=prepare;}
  await rejected;await stop;assert.equal(f.store.evidence([raw.id]).length,0,'late preparation must not commit');
  if(cause==='credential-revocation'){await f.restart();assert.equal(f.connections().authenticate('Bearer '+paired.token),undefined);}
});

test('serialized Memory pins are consumed by their exact real SQLite claim and source withdrawal is not revived',async t=>{
  const f=await fixture(t),p=f.platform,control=p.assembly.modelAuthorization;
  control.command({action:'on',revision:0,operationId:randomUUID()});
  const request=p.bindRequest({authorization:'Bearer '+ownerToken,method:'PUT',route:'/api/sources/:id/items',params:{id:'generated-source-a'}}),raw=item();
  const receipt=await p.withSource(request,'generated-source-a',raw,()=>p.sourceIntake.sourceItem('generated-source-a',raw,p.commits.capture()));p.releaseRequest(request);
  const pin=JSON.parse(JSON.stringify({sourceId:'generated-source-a',inputKey:receipt.id,scope:DEFAULT_MEMORY_INPUT_SCOPE}));
  const material=f.materials.publish({id:materialId(pin.sourceId,'generated-memory-input'),kind:'mote.file',schemaVersion:1,title:'Generated Memory input',origin:{sourceId:pin.sourceId,externalId:'generated-memory-input'},members:[{id:'original',kind:'capture',ref:'capture:'+receipt.id}],blocks:[{id:'body',kind:'text',format:'plain',text:'Generated Memory source text',memberIds:['original']}],coverage:{state:'complete'},artifacts:[{key:'source-body',state:'ready'}],fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
  f.memory.observe(material.id,['source-body'],{inputKey:receipt.id,change:'source'});
  const engine=new ExecutionEngine(f.store);engine.bindModelAuthority(control);let jobId='',executed=0;
  t.after(()=>engine.close());
  engine.register({kind:'generated.c04-memory',pool:'generated-c04',concurrency:()=>1,validate:step=>f.memory.authorized({id:step.id,automaticGrant:pin}),
    execute:async step=>p.withMemoryGrant(step.input.pin,step.id,async(_signal,assertCurrent)=>{assertCurrent();control.assertCurrent(f.model);executed++;return 'generated accepted Memory result';}),
    commit:step=>{assert.equal(f.memory.authorized({id:step.id,automaticGrant:pin}),true);}});
  assert.equal(f.memory.drain({create:input=>{jobId=engine.enqueue('generated-memory-job','generated.c04-memory',{pin,evidenceIds:input.evidenceIds});return {id:jobId};},get:id=>({status:engine.get(id)?.state==='succeeded'?'completed':'queued'}),run:id=>engine.drain([id]),cancel:id=>{engine.cancel(id);}},true),1);
  await engine.drain([jobId]);assert.equal(engine.get(jobId)?.state,'succeeded');assert.equal(executed,1);await engine.close();
  await p.withMemoryGrant(pin,jobId,async(signal,assertCurrent)=>{f.store.db.exec('BEGIN IMMEDIATE');try{f.memory.inputs.forgetSource(pin.sourceId);}finally{f.store.db.exec('ROLLBACK');}await Promise.resolve();assert.equal(signal.aborted,false,'rolled-back source withdrawal must not revoke the accepted grant');assertCurrent();});
  let uses=0;await p.withMemoryGrant(pin,jobId,async(_signal,assertCurrent)=>{assertCurrent();control.assertCurrent(f.model);uses++;});assert.equal(uses,1);
  assert.throws(()=>p.withMemoryGrant({...pin,scope:'forged.scope'},jobId,async()=>{}));
  assert.throws(()=>p.withMemoryGrant(pin,'forged-job',async()=>{}));
  let release!:()=>void,entered!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});let published=false,aborted=false;
  const work=p.withMemoryGrant(pin,jobId,async(signal,assertCurrent)=>{entered();await held;aborted=signal.aborted;assertCurrent();published=true;});const rejected=assert.rejects(work);
  await started;f.memory.inputs.forgetSource(pin.sourceId);await Promise.resolve();release();await rejected;assert.equal(aborted,true);assert.equal(published,false);
  await f.restart();assert.throws(()=>f.platform.withMemoryGrant(pin,jobId,async()=>{published=true;}));assert.equal(published,false);
});

test('automatic work keeps running across model connection changes while platform close fences a captured relay',async t=>{
  const f=await fixture(t),control=f.platform.assembly.modelAuthorization,original=f.model;
  control.command({action:'on',revision:0,operationId:randomUUID()});
  f.store.db.exec('BEGIN IMMEDIATE');control.receive('generated-pinned',{sourceId:'generated-source-a'});f.store.db.exec('COMMIT');control.automatic('generated-pinned-work',['generated-pinned']);let captured:(()=>void)|undefined;
  await control.run('generated-pinned-work',async()=>{captured=control.capture(original);control.assertCurrent(original);f.addModel();f.platform.refreshFences();control.assertCurrent(original);});
  captured!();await f.platform.close();assert.throws(()=>captured!());
  await f.restart();const replacement=f.platform.assembly.modelAuthorization;
  replacement.command({action:'on',revision:replacement.view().revision,operationId:randomUUID()});
  f.store.db.exec('BEGIN IMMEDIATE');replacement.receive('generated-original',{sourceId:'generated-source-a'});f.store.db.exec('COMMIT');replacement.automatic('generated-automatic',['generated-original']);
  await replacement.run('generated-automatic',async()=>{replacement.assertCurrent(original);f.withdrawOriginalModel();replacement.assertCurrent(original);},undefined);
});


test('expired real connection sessions and opaque handles remain rejected across platform restart',async t=>{
  const f=await fixture(t),session=await f.connections().session('https://generated.invalid','Generated expiring session',undefined,86400000);
  const request=f.platform.bindRequest({authorization:'Bearer '+session.token,method:'POST',route:'/api/captures'}),signal=f.platform.requestSignal(request);
  f.advance(86400001);f.platform.refreshFences();assert.equal(signal.aborted,true);assert.throws(()=>f.platform.requests.assertCurrent(request));
  const old=f.platform;await f.restart();assert.equal(f.connections().authenticate('Bearer '+session.token),undefined);
  assert.throws(()=>f.platform.requests.assertCurrent(request));assert.throws(()=>old.bindRequest({authorization:'Bearer '+ownerToken,method:'POST',route:'/api/captures'}));
});


test('failed credential initialization disposes authorization hooks without closing the borrowed vault',async t=>{
  const f=await fixture(t);await f.platform.close();
  const path=join(f.store.directory,'connectors');mkdirSync(path,{recursive:true,mode:0o700});writeFileSync(join(path,'client-connections.json'),'generated invalid JSON',{mode:0o600});
  const previous=f.memory.inputs.onOriginalInput,platform=createAuthorizationPlatform({ownerToken},{store:f.store,availableModelConnections:()=>[f.model]});
  await platform.prepare();platform.bindRepositories({sources:f.sources,files:f.files,materials:f.materials,memoryInputs:f.memory.inputs,memoryWork:f.memory});
  await assert.rejects(platform.start(),{code:'connection_storage_invalid'});await platform.close();
  assert.equal(f.store.db.isOpen,true);assert.ok(f.store.stats());assert.equal(f.memory.inputs.onOriginalInput,previous);assert.equal(platform.validOwnerBearer('Bearer '+ownerToken),false);
});

test('closing a pending real login approval revokes its persisted credential before connection disposal',async t=>{
  const f=await fixture(t),platform=f.platform,connections=f.connections(),handoffs=platform.assembly.handoffs!,session=connections.session.bind(connections);
  const verifier=randomBytes(32).toString('base64url'),request=handoffs.create({serverUrl:'https://generated.invalid',deviceId:'generated-login-device',deviceName:'Generated login',platform:'android',challenge:createHash('sha256').update(verifier).digest('hex')});
  let release!:()=>void,entered!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),persisted=new Promise<void>(resolve=>{entered=resolve;});
  connections.session=async(...args)=>{const grant=await session(...args);entered();await held;return grant;};
  const approval=handoffs.approve(request.id,()=>{if(!platform.validOwnerBearer('Bearer '+ownerToken))throw Error('Generated owner context ended');});const rejected=assert.rejects(approval);
  try{await persisted;const closing=platform.close();release();await rejected;await closing;}
  finally{release();connections.session=session;}
  const reloaded=new Connections(f.store,f.sources);try{await reloaded.init();const records=reloaded.inventory().items;assert.equal(records.length,1);assert.ok(records[0].revokedAt);assert.throws(()=>handoffs.poll({id:request.id,verifier}),{code:'connection_closed'});}finally{await reloaded.close();}
});

test('H04 owns the actual authorization factory and exposes no ordinary issuer or writer service',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-authorization-host-')),store=new Store(directory),sources=new SourceStore(store),files=new FileStore(store,sources),materials=new MaterialStore(store),host=new PluginHost({kind:'central',id:'generated-auth-host'});
  t.after(async()=>{await host.close();await files.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const identity={packageId:'generated.authorization',installationId:'generated-install',instanceId:'generated-instance',activationId:'generated-activation',host:{kind:'central' as const,id:'generated-auth-host'}};
  const handle=await host.install({identity,contributions:[authorizationPlatformDeclaration],restartRequired:true,factory:createAuthorizationPlatformFactory({ownerToken},{store,availableModelConnections:()=>[]},{sources,files,materials})});
  assert.equal(host.snapshot().contributions[0].restartRequired,true);assert.deepEqual(authorizationPlatformContribution.provides,[]);
  await assert.rejects(host.acquire(centralServices.commitAuthorization,{service:centralServices.commitAuthorization,provider:{scope:identity,contributionId:authorizationPlatformDeclaration.id},revision:0}),{code:'dependency_unavailable'});
  await handle.close('disabled');assert.equal(store.db.isOpen,true);assert.ok(store.stats());
});


for(const committed of [false,true])test(`source invalidation after a real transaction ${committed?'commits':'rolls back'} respects the pending target fence`,async t=>{
  const f=await fixture(t),platform=f.platform,raw=item(),request=platform.bindRequest({authorization:'Bearer '+ownerToken,method:'PUT',route:'/api/sources/:id/items',params:{id:'generated-source-a'}}),signal=platform.requestSignal(request);
  const prepare=f.store.prepare.bind(f.store);let release!:()=>void,entered!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  f.store.prepare=async input=>{const prepared=await prepare(input);entered();await held;return prepared;};
  const operation=platform.withSource(request,'generated-source-a',raw,()=>platform.sourceIntake.sourceItem('generated-source-a',raw,platform.commits.capture()));
  const outcome=operation.then(value=>({value,error:undefined}),error=>({value:undefined,error}));
  try{
    await started;f.store.db.exec('BEGIN IMMEDIATE');try{f.sources.update('generated-source-a',{enabled:false});f.memory.inputs.forgetSource('generated-source-a');f.store.db.exec(committed?'COMMIT':'ROLLBACK');}catch(error){if(f.store.db.isTransaction)f.store.db.exec('ROLLBACK');throw error;}
    await Promise.resolve();assert.equal(signal.aborted,committed);
  }finally{release();f.store.prepare=prepare;}
  const result=await outcome;if(committed){assert.ok(result.error);assert.equal(f.sources.getItem('generated-source-a',raw.externalId),undefined);}else{assert.equal(result.error,undefined);assert.equal(result.value?.receipt.state,'received');}
});


test('partial binding rejects a foreign-vault Connections without taking ownership of it',async t=>{
  const f=await fixture(t),foreign=await fixture(t),connections=foreign.connections(),session=await connections.session('https://generated.invalid','Generated foreign owner',undefined,0);
  const platform=createAuthorizationPlatform({ownerToken},{store:f.store,availableModelConnections:()=>[f.model],connections});
  try{await platform.prepare();assert.throws(()=>platform.bindRepositories({sources:f.sources,files:f.files,materials:f.materials,memoryInputs:f.memory.inputs,memoryWork:f.memory}),{code:'authorization_repository_mismatch'});}
  finally{await platform.close();}
  assert.equal(connections.authenticate('Bearer '+session.token)?.id,session.credentialId,'rejected foreign dependencies remain with their original owner');
});


test('two selected recipe scopes independently consume the same original through real Memory jobs',async t=>{
  const f=await fixture(t,true),p=f.platform,control=p.assembly.modelAuthorization;
  f.recipes!.configure({sourceId:'generated-source-a',recipes:[{id:'mote.personal-memory',version:'5'},{id:'mote.coding-memory',version:'3'}]});
  control.command({action:'on',revision:0,operationId:randomUUID()});
  const request=p.bindRequest({authorization:'Bearer '+ownerToken,method:'PUT',route:'/api/sources/:id/items',params:{id:'generated-source-a'}}),raw=item();
  const receipt=await p.withSource(request,'generated-source-a',raw,()=>p.sourceIntake.sourceItem('generated-source-a',raw,p.commits.capture()));p.releaseRequest(request);
  const material=f.materials.publish({id:materialId('generated-source-a','generated-sibling-recipes'),kind:'mote.file',schemaVersion:1,title:'Generated sibling recipe input',origin:{sourceId:'generated-source-a',externalId:'generated-sibling-recipes'},members:[{id:'original',kind:'capture',ref:'capture:'+receipt.id}],blocks:[{id:'body',kind:'text',format:'plain',text:'Generated shared original',memberIds:['original']}],coverage:{state:'complete'},artifacts:[{key:'source-body',state:'ready'}],fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
  f.memory.observe(material.id,['source-body'],{inputKey:receipt.id,change:'source'});
  const engine=new ExecutionEngine(f.store),jobs:string[]=[],executed:string[]=[];engine.bindModelAuthority(control);t.after(()=>engine.close());
  engine.register({kind:'generated.c04-sibling-memory',pool:'generated-c04-siblings',concurrency:()=>2,
    validate:step=>f.memory.authorized({id:step.id,automaticGrant:automaticMemoryGrantSchema.parse(step.input.pin)}),
    execute:async step=>p.withMemoryGrant(step.input.pin,step.id,async(_signal,assertCurrent)=>{assertCurrent();control.assertCurrent(f.model);executed.push(automaticMemoryGrantSchema.parse(step.input.pin).scope);return 'generated recipe result';}),
    commit:step=>{assert.equal(f.memory.authorized({id:step.id,automaticGrant:automaticMemoryGrantSchema.parse(step.input.pin)}),true);}});
  assert.equal(f.memory.drain({create:input=>{const id=engine.enqueue('generated-sibling-memory-job','generated.c04-sibling-memory',{pin:input.automaticGrant,evidenceIds:input.evidenceIds});jobs.push(id);return {id};},get:id=>({status:engine.get(id)?.state==='succeeded'?'completed':'queued'}),run:id=>engine.drain([id]),cancel:id=>{engine.cancel(id);}},true),2);
  await engine.drain(jobs);
  assert.deepEqual(jobs.map(id=>engine.get(id)?.state),['succeeded','succeeded']);
  assert.equal(new Set(executed).size,2,'both independently selected scopes execute once');
  assert.deepEqual(executed.sort(),f.memory.inputs.list('generated-source-a',receipt.id).map(grant=>grant.scope).sort());
  for(const id of jobs)await p.withMemoryGrant(engine.get(id)!.input.pin,id,async(_signal,assertCurrent)=>{assertCurrent();control.assertCurrent(f.model);});
});


test('a pruned expired login approval still drains and revokes before Connections closes',async t=>{
  const f=await fixture(t),platform=f.platform,connections=f.connections(),handoffs=platform.assembly.handoffs!,session=connections.session.bind(connections);
  const verifier=randomBytes(32).toString('base64url'),input={serverUrl:'https://generated.invalid',deviceId:'generated-expiring-login',deviceName:'Generated expired login',platform:'android',challenge:createHash('sha256').update(verifier).digest('hex')},request=handoffs.create(input);
  let release!:()=>void,entered!:()=>void,issued:Awaited<ReturnType<Connections['session']>>|undefined;
  const held=new Promise<void>(resolve=>{release=resolve;}),persisted=new Promise<void>(resolve=>{entered=resolve;});
  connections.session=async(...args)=>{const grant=await session(...args);issued=grant;entered();await held;return grant;};
  const approval=handoffs.approve(request.id,()=>{}),rejected=assert.rejects(approval);
  try{
    await persisted;f.advance(10*60000+1);handoffs.create({...input,deviceId:'generated-next-login'});
    assert.throws(()=>handoffs.detail(request.id),{code:'login_expired'});
    const closing=platform.close();
    try{await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(connections.authenticate('Bearer '+issued!.token)?.id,issued!.credentialId,'Connections stays open until the detached approval can revoke');}
    finally{release();await rejected;await closing;}
  }finally{release();connections.session=session;}
  const reloaded=new Connections(f.store,f.sources);
  try{await reloaded.init();const records=reloaded.inventory().items;assert.equal(records.length,1);assert.ok(records[0].revokedAt);assert.equal(reloaded.authenticate('Bearer '+issued!.token),undefined,'expired pending approval must not leave an active credential after restart');}finally{await reloaded.close();}
});

test('fixed request platform checks preserve owner and collector rules and reject released or MCP pins',async t=>{
  const f=await fixture(t),platform=f.platform,paired=await f.collector();
  const bind=(token:string)=>platform.bindRequest({authorization:'Bearer '+token,method:'POST',route:'/api/devices/heartbeat'});
  const collector=bind(paired.token);
  try{platform.requests.assertOwnPlatform(collector,'android');assert.throws(()=>platform.requests.assertOwnPlatform(collector,'macos'),{statusCode:403});}
  finally{platform.releaseRequest(collector);}
  assert.throws(()=>platform.requests.assertOwnPlatform(collector,'android'),{statusCode:401});

  const owner=bind(ownerToken);
  try{platform.requests.assertOwnPlatform(owner,'macos');platform.requests.assertOwnPlatform(owner,'import');}
  finally{platform.releaseRequest(owner);}
  assert.throws(()=>platform.requests.assertOwnPlatform(owner,'macos'),{statusCode:401},'an owner token does not revive a released request');

  const invitation=f.connections().invite({serverUrl:'https://generated.invalid',label:'Generated other collector',deviceId:'generated-phone-other'},'collector');
  const other=await f.connections().redeem({code:invitation.invitation.code,deviceId:'generated-phone-other',deviceName:'Generated other phone',platform:'other'}),otherPin=bind(other.token);
  try{platform.requests.assertOwnPlatform(otherPin,'import');assert.throws(()=>platform.requests.assertOwnPlatform(otherPin,'other'),{statusCode:403});}
  finally{platform.releaseRequest(otherPin);}

  const ownerInvitation=f.connections().invite({serverUrl:'https://generated.invalid',label:'Generated owner connection',deviceId:'generated-owner-device'},'owner');
  const ownerConnection=await f.connections().redeem({code:ownerInvitation.invitation.code,deviceId:'generated-owner-device',deviceName:'Generated owner device',platform:'android'}),ownerPin=bind(ownerConnection.token);
  try{platform.requests.assertOwnPlatform(ownerPin,'macos');}finally{platform.releaseRequest(ownerPin);}

  const mcp=platform.bindRequest({authorization:'Bearer '+f.connectorConfig.mcpReadToken,method:'POST',route:'/mcp'});
  try{assert.throws(()=>platform.requests.assertOwnPlatform(mcp,'android'),{statusCode:403});}finally{platform.releaseRequest(mcp);}
});
