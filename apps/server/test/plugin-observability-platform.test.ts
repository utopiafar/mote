import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,mkdtempSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import type {ReleaseManifest} from '@mote/shared/release';
import {PluginHost} from '@mote/plugin-host';
import type {PluginScope,ScopeIdentity,ServiceBinding} from '@mote/plugin-api/contracts';
import {Store} from '../src/store.js';
import {ExecutionEngine,ExecutionFailure} from '../src/execution-engine.js';
import {EXECUTION_POLICIES} from '../src/execution-policy.js';
import {ServerDiagnostics,safeError} from '../src/diagnostics.js';
import {centralServices} from '../src/plugins/central-contracts.js';
import {
  createObservabilityPlatform,createObservabilityPlatformFactory,observabilityPlatformContribution,
  observabilityPlatformDeclaration,observabilityPlatformReplacement,
} from '../src/plugins/observability-platform.js';
import {register as registerUsage} from '../src/features/usage.js';
import {register as registerDiagnostics} from '../src/features/diagnostics.js';
import {registerBootstrapHealth,registerSystemUpdate,registerSystemView} from '../src/features/system.js';
import type {ReleaseCheck} from '../src/updates.js';

const secret='GENERATED_OBSERVABILITY_PRIVATE_BODY_AND_TOKEN';
const release:ReleaseManifest={schemaVersion:1,version:'0.4.1',tag:'v0.4.1',channel:'stable',publishedAt:new Date().toISOString(),repository:'utopiafar/mote',notesUrl:'https://github.com/utopiafar/mote/releases/tag/v0.4.1',assets:[],images:[]};
const tokens={requests:1,reportedRequests:1,inputTokens:120,outputTokens:30,totalTokens:150};

function consumer(name='generated-consumer'){
  const controller=new AbortController(),cleanups:(()=>unknown)[]=[];
  const scope:PluginScope={identity:{packageId:'generated.consumer',installationId:'generated-install',instanceId:name,activationId:'generated-activation',host:{kind:'central',id:'generated-host'}},signal:controller.signal,
    assertCurrent(){controller.signal.throwIfAborted();},defer(dispose){cleanups.push(dispose);}};
  return {scope,close(){controller.abort();for(const dispose of cleanups)dispose();}};
}
function fixture(t:import('node:test').TestContext,checkRelease:ReleaseCheck = async()=>({manifest:release,available:false})){
  const directory=mkdtempSync(join(tmpdir(),'mote-observability-platform-')),store=new Store(directory),logs=join(directory,'logs');
  const platform=createObservabilityPlatform({logDirectory:logs,diagnostics:{level:'info',maxEntries:500},update:{currentVersion:'0.4.0',runtime:'native',profile:'generated'},updateDependencies:{checkRelease}},
    {store});
  const owner=consumer();
  t.after(async()=>{owner.close();await platform.close().catch(()=>{});store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,logs,store,platform,owner};
}
const today=()=>new Date().toISOString().slice(0,10);

test('restart contribution publishes only the frozen usage port and releases its writer on host close',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-observability-host-')),store=new Store(directory),logs=join(directory,'logs');
  const host=new PluginHost({kind:'central',id:'generated-host'});
  t.after(async()=>{await host.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const identity:ScopeIdentity={packageId:'generated.observability',installationId:'generated-install',instanceId:'generated-observability',activationId:'generated-activation',host:{kind:'central',id:'generated-host'}};
  let usageBinding:ServiceBinding|undefined;
  const factory=createObservabilityPlatformFactory({logDirectory:logs,update:{currentVersion:'0.4.0',runtime:'native'},updateDependencies:{checkRelease:async()=>({manifest:release,available:false})}},{store});
  const handle=await host.install({identity,restartRequired:true,contributions:[observabilityPlatformDeclaration],factory:context=>factory({...context,
    provide:(id,contract,value,revision)=>{const binding=context.provide(id,contract,value,revision);if(contract.id===centralServices.usage.id)usageBinding=binding;return binding;}})});
  assert.ok(usageBinding);assert.equal(host.snapshot().contributions[0].restartRequired,true);
  assert.deepEqual(observabilityPlatformContribution.provides.map(service=>service.id),[centralServices.usage.id]);
  assert.equal(observabilityPlatformContribution.requires[0].id,'mote.vault-platform');assert.equal(observabilityPlatformReplacement,'restart');
  const lease=await host.acquire(centralServices.usage,usageBinding!);
  assert.deepEqual(Object.keys(lease.value).sort(),['operation','start']);
  for(const key of ['summary','setPrice','prices','diagnostics','snapshot','events','forAssembly','close'] as const)assert.equal(key in lease.value,false,key);
  const meter=lease.value.start('fixture','fixture-model','generated-operation',{operationId:'generated-operation',agentId:'generated-agent',moduleId:'generated-module',skillId:null});
  assert.equal(lease.value.operation('missing-operation').items.length,0);
  meter.update(tokens);const receipt=meter.finish('completed');assert.equal(receipt.status,'completed');
  assert.equal(lease.value.operation('generated-operation').items.length,1);
  await handle.close('disabled');assert.throws(()=>lease.assertCurrent());
  const reopened=new ServerDiagnostics({directory:logs});try{await reopened.init();assert.equal(reopened.snapshot().enabled,true);assert.equal(reopened.snapshot().writeFailures,0,'the closed writer released its log lock');}finally{await reopened.close();}
});

test('real SQLite execution writes one admitted receipt and HTTP readers see the same job/attempt identity',async t=>{
  const f=await fixture(t);
  await f.platform.prepare();await f.platform.start();
  const assembly=f.platform.forAssembly(f.owner.scope),diagnostics=assembly.diagnostics;
  const engine=new ExecutionEngine(f.store),meters=new Map<string,ReturnType<typeof assembly.admittedUsage>>();
  t.after(()=>engine.close());
  engine.bindObserver(value=>assembly.observer.lease(value),()=>assembly.observer.enabled());
  engine.register({kind:'generated.observation',pool:'generated.observation',policy:EXECUTION_POLICIES.deterministic,concurrency:()=>1,validate:()=>true,
    execute:async step=>{
      const operationId='generated-operation:'+step.id,meter=assembly.admittedUsage('fixture','fixture-model',operationId,{operationId,jobId:step.id,agentId:'generated-agent',moduleId:'generated-module',skillId:null});
      meters.set(step.id,meter);meter.modelStarted();meter.modelStarted();
      // Real observer producer: the 110ms archive read crosses the observed latency floor.
      assembly.observer.sync('reader_evidence',{taskId:step.id,attempt:step.attempts,phase:'extract',...{prompt:secret,token:secret}} as never,()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,110);return step.id;});
      meter.update(tokens);return step.id;
    },commit:(step,value)=>{assert.equal(value,step.id);}});
  engine.register({kind:'generated.queued',pool:'generated.queued',policy:EXECUTION_POLICIES.deterministic,concurrency:()=>1,validate:()=>true,
    admit:()=>new ExecutionFailure('waiting','generated_hold',60000),execute:async()=>{throw Error('queued work must not execute');},commit:()=>{}});
  engine.register({kind:'generated.lease',pool:'generated.lease',policy:EXECUTION_POLICIES.deterministic,concurrency:()=>1,validate:()=>true,
    admit:()=>new ExecutionFailure('waiting','generated_lease_hold',60000),execute:async()=>null,commit:()=>{}});
  const operationId='generated-operation:'+randomUUID(),id=engine.enqueue(operationId,'generated.observation',{}),operation='generated-operation:'+id;
  await engine.drain([id]);meters.get(id)!.complete();
  assert.equal(engine.get(id)!.state,'succeeded');
  assert.equal(assembly.usage.operation(operation).items.length,1,'two modelStarted calls still produce one admitted receipt');

  // A queued-admission step and a cancelled-before-start step never create a receipt.
  const queued=engine.enqueue('generated-queued-operation','generated.queued',{}),cancelled=engine.enqueue('generated-cancelled-operation','generated.queued',{});
  engine.cancel(cancelled);await engine.drain([queued,cancelled]);await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(assembly.usage.operation('generated-queued-operation').items.length,0);
  assert.equal(assembly.usage.operation('generated-cancelled-operation').items.length,0);
  assert.equal(f.store.db.prepare('SELECT count(*) count FROM model_usage').get()!.count,1);
  const leaseId=engine.enqueue('generated-lease-operation','generated.lease',{});
  f.store.db.prepare("UPDATE execution_steps SET state='running',attempts=1,lease_until=0 WHERE id=?").run(leaseId);
  await engine.tick();
  assert.equal(assembly.usage.operation('generated-lease-operation').items.length,0,'an interrupted lease is not model usage');

  const app=Fastify();
  app.setErrorHandler((error,_request,reply)=>{const failure=safeError(error);reply.code(failure.status).send({error:failure.category,message:failure.message,requestId:'generated'});});
  registerUsage(app,{usageLedger:assembly.usage});
  registerDiagnostics(app,{diagnostics,diagnosticSnapshot:()=>({version:1,scope:'central-safe-diagnostics',...diagnostics.snapshot()})});
  const day=today(),usage=await app.inject(`/api/usage?from=${day}&to=${day}&timeZone=UTC&agentId=generated-agent&moduleId=generated-module`);
  assert.equal(usage.statusCode,200,usage.body);const summary=usage.json();
  assert.equal(summary.itemsTotal,1);assert.equal(summary.items[0].attribution.jobId,id);assert.equal(summary.items[0].status,'completed');
  const eventPage=await app.inject('/api/diagnostics/events?afterSeq=0&limit=200');assert.equal(eventPage.statusCode,200,eventPage.body);
  const observed=eventPage.json().items.find((event:{name?:string;taskKey?:string})=>event.name==='reader_evidence');
  assert.ok(observed,'the real execution observer output is consumed by diagnostics');assert.equal(observed.taskKey,id);assert.equal(observed.attempt,1);
  const recovered=eventPage.json().items.find((event:{event?:string;taskKey?:string})=>event.event==='task.lease_recovered');
  assert.ok(recovered,'the real engine recovery is consumed by diagnostics');assert.equal(recovered.taskKey,leaseId);assert.equal(recovered.attempt,1);
  assert.equal((await app.inject('/api/diagnostics/logs?file=99')).statusCode,400,'diagnostic HTTP errors keep their validation mapping');
  await diagnostics.flush();const persisted=readdirSync(f.logs).filter(name=>name.endsWith('.ndjson')).map(name=>readFileSync(join(f.logs,name),'utf8')).join('');
  assert.ok(persisted.includes('reader_evidence'));assert.ok(!persisted.includes(secret));
  await app.close();
});

test('sanitized reads stay flat, a write failure is visible, and disposal still stops timers and the updater',async t=>{
  const f=await fixture(t);
  await f.platform.prepare();await f.platform.start();
  const assembly=f.platform.forAssembly(f.owner.scope),read=f.platform.read(f.owner.scope);
  const snapshot=read.snapshot();
  assert.ok(Object.values(snapshot).every(value=>value===null||['string','number','boolean'].includes(typeof value)));
  assert.equal(Object.hasOwn(snapshot,'limits'),false);assert.equal(typeof snapshot.instanceId,'string');
  assembly.diagnostics.record('server.started');
  assembly.observer.sync('reader_evidence',{jobId:randomUUID(),attempt:1,phase:'extract',...{prompt:secret}} as never,()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,110);});
  const page=read.events(0,200);
  assert.ok(page.items.length>=2);for(const item of page.items){assert.equal(Object.hasOwn(item,'trace'),false);assert.ok(Object.values(item).every(value=>value===null||['string','number','boolean'].includes(typeof value)));}
  assert.ok(!JSON.stringify(page).includes(secret));

  const observer=assembly.observer;
  let disabled=0;const eventLoop=assembly.eventLoop,disable=eventLoop.disable.bind(eventLoop);eventLoop.disable=()=>{disabled++;disable();};
  chmodSync(f.logs,0o500);
  try{assembly.diagnostics.record('server.started');await assembly.diagnostics.flush();assert.ok(assembly.diagnostics.snapshot().writeFailures>=1,'the failed writer is observable');}
  finally{chmodSync(f.logs,0o700);}
  await f.platform.stop('shutdown');assert.ok(disabled>=1,'the event loop watcher is disabled during disposal');
  assert.equal(observer.enabled(),false);
  const reopened=new ServerDiagnostics({directory:f.logs});try{await reopened.init();assert.equal(reopened.snapshot().writeFailures,0,'the failed writer still released its log lock');}finally{await reopened.close();}
});

test('minimal health, composition view and update service remain separable route contributions',async t=>{
  const f=await fixture(t);await f.platform.prepare();await f.platform.start();
  const assembly=f.platform.forAssembly(f.owner.scope),app=Fastify();
  registerBootstrapHealth(app,{serverVersion:'0.4.0'} as never);
  registerSystemUpdate(app,{softwareUpdate:assembly.softwareUpdate});
  registerSystemView(app,{serverVersion:'0.4.0',webVersion:'0.4.0'} as never);
  const health=await app.inject('/api/health');assert.deepEqual(health.json(),{ok:true,version:'0.4.0',protocol:health.json().protocol});
  const update=await app.inject('/api/software-update');assert.equal(update.statusCode,200);assert.equal(update.json().currentVersion,'0.4.0');assert.equal(update.json().state,'idle');
  assert.deepEqual((await app.inject('/api/build-info')).json(),{serverVersion:'0.4.0',webVersion:'0.4.0',consistent:true});
  const isolated=Fastify();registerBootstrapHealth(isolated,{serverVersion:'0.4.0'} as never);
  assert.equal((await isolated.inject('/api/status')).statusCode,404,'health bootstrap exposes no business view');
  await app.close();await isolated.close();
});

test('closing the update service aborts an in-flight check before disposal returns',async t=>{
  let aborted=false;
  const f=await fixture(t,async options=>new Promise((_resolve,reject)=>{options?.signal?.addEventListener('abort',()=>{aborted=true;reject(new Error('generated check aborted'));},{once:true});}));
  await f.platform.prepare();await f.platform.start();
  const assembly=f.platform.forAssembly(f.owner.scope),pending=assembly.softwareUpdate.check();
  await f.platform.stop('shutdown');
  const status=await pending;assert.equal(aborted,true);assert.equal(status.state,'error');assert.equal(status.error,'release_check_failed');
});

test('a failing updater close stays observable without blocking the rest of scope cleanup',async t=>{
  const f=await fixture(t);
  await f.platform.prepare();await f.platform.start();
  const assembly=f.platform.forAssembly(f.owner.scope),observer=assembly.observer;
  let disabled=0;const eventLoop=assembly.eventLoop,disable=eventLoop.disable.bind(eventLoop);eventLoop.disable=()=>{disabled++;disable();};
  assembly.softwareUpdate.close=async()=>{throw new Error('generated updater close failure');};
  await assert.rejects(f.platform.stop('disabled'),/Observability platform disposal failed/);
  assert.ok(disabled>=1,'diagnostics and timer cleanup continue after an updater failure');
  assert.equal(observer.enabled(),false);
  const reopened=new ServerDiagnostics({directory:f.logs});try{await reopened.init();assert.ok(reopened.snapshot());}finally{await reopened.close();}
});
