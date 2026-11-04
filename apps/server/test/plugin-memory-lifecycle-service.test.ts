import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setImmediate as flushImmediate} from 'node:timers/promises';
import {PluginHost} from '@mote/plugin-host';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {Conversations} from '../src/conversations.js';
import {MemoryStore} from '../src/memory.js';
import type {MemoryPipeline} from '../src/memory-pipeline.js';
import type {MemoryIntegrationSettings} from '../src/memory-integration-settings.js';
import type {FileStore} from '../src/files.js';
import {centralServices,checkCentralServiceDeclarations} from '../src/plugins/central-contracts.js';
import {
  createMemoryLifecycleService,createMemoryLifecycleServiceFactory,memoryLifecycleServiceContribution,
  memoryLifecycleServiceDeclaration,type MemoryLifecycleServiceBindings,
} from '../src/plugins/memory-lifecycle-service.js';

const flush=()=>flushImmediate();

async function fixture(t:test.TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-lifecycle-plugin-')),store=new Store(directory);
  const engine=new ExecutionEngine(store);
  const conversations=new Conversations(store),memories=new MemoryStore(store),runs:string[]=[];
  const pending=new Map<string,(value:unknown)=>void>();
  const integrationSettings={
    fail:false,
    selection(){if(this.fail)throw Error('Generated lifecycle registration failure');return {afterSequence:0};},
    eligible:()=>[],
    onApplied:undefined,
  } as unknown as MemoryIntegrationSettings&{fail:boolean};
  const pipeline={
    run(id:string){runs.push(id);return new Promise(resolve=>pending.set(id,resolve));},
  } as unknown as MemoryPipeline;
  const platform=createMemoryLifecycleService({
    store,executor:engine,configured:()=>true,conversations,files:{} as FileStore,memories,pipeline,integrationSettings,
    query:async()=>({answer:'Generated fixture',citations:[],trace:[],runId:randomUUID()}),
    model:()=> 'generated-model',pollIntervalMs:60000,recoveryIntervalMs:5000,
  });
  t.after(async()=>{
    for(const resolve of pending.values())resolve(undefined);
    await platform.close();
    await engine.close();
    if(store.db.isOpen)store.close();
    rmSync(directory,{recursive:true,force:true});
  });
  return {directory,store,engine,platform,runs,integrationSettings,resolve:(id:string)=>{pending.get(id)?.(undefined);pending.delete(id);}};
}

function recoverableJob(store:Store,id:string,status='queued'){
  store.db.exec('CREATE TABLE IF NOT EXISTS memory_jobs(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,json TEXT NOT NULL)');
  store.db.prepare('INSERT INTO memory_jobs VALUES(?,?,?)').run(id,new Date().toISOString(),JSON.stringify({id,status,activationRequired:false}));
  return id;
}

test('repeated start/quiesce keeps one extension set and one owned poll',async t=>{
  const f=await fixture(t);
  t.mock.timers.enable({apis:['setInterval']});
  let ticks=0;
  f.platform.prepare();
  f.platform.lifecycle.tick=async()=>{ticks++;};
  assert.deepEqual(f.platform.lifecycle.view().extensions.map(extension=>extension.id),['extraction','consolidation','working','insights']);
  f.platform.start();f.platform.start();await flush();
  t.mock.timers.tick(60000);await flush();
  assert.equal(ticks,1,'a second start must not install a second poll');
  f.platform.quiesce('disabled');t.mock.timers.tick(180000);await flush();
  assert.equal(ticks,1,'quiesce stops the activation poll');
  await f.platform.stop('disabled');
  f.platform.start();t.mock.timers.tick(60000);await flush();
  assert.equal(ticks,2,'re-enable resumes the same single extension set');
  assert.equal(f.platform.lifecycle.view().extensions.length,4);
  await f.platform.stop('disabled');
  assert.equal(f.platform.lifecycle.view().extensions.length,4,'stop keeps exactly the registered defaults');
});

test('stop fences an executing extension and its late commit never advances the window',async t=>{
  const f=await fixture(t);
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
  f.platform.prepare();
  f.platform.lifecycle.replace({id:'extraction',version:'generated',stream:'evidence',async run(_window,checkpoint,execution){
    checkpoint('generated-child');entered();await held;
    execution!.commit(()=>f.store.db.prepare("INSERT INTO settings VALUES('generated-late-result','1')").run());
  }});
  f.platform.start();
  f.platform.lifecycle.request('extraction',[randomUUID()],'generated-window');
  const running=f.platform.tick();await started;
  const stopping=f.platform.stop('disabled');release();
  await Promise.all([running,stopping]);
  const state=f.platform.lifecycle.view().extensions.find(extension=>extension.id==='extraction')!;
  assert.equal(state.cursor,0);assert.equal(state.active?.checkpoint,'generated-child');
  assert.equal(f.store.db.prepare("SELECT 1 FROM settings WHERE key='generated-late-result'").get(),undefined);
});

test('recovery observes each durable job once while in flight and never replays a completed one',async t=>{
  const f=await fixture(t);
  const job=recoverableJob(f.store,randomUUID());
  f.platform.prepare();f.platform.start();await flush();
  assert.deepEqual(f.runs,[job]);
  f.platform.start();await flush();
  assert.deepEqual(f.runs,[job],'an active activation does not recover the same job twice');
  await f.platform.stop('disabled');f.platform.start();await flush();
  assert.deepEqual(f.runs,[job],'re-enable coalesces an already accepted recovery run');
  f.resolve(job);
  f.store.db.prepare("UPDATE memory_jobs SET json=json_set(json,'$.status','completed') WHERE id=?").run(job);
  await flush();await f.platform.stop('disabled');f.platform.start();await flush();
  assert.deepEqual(f.runs,[job],'a completed job is not replayed after restart');
  assert.equal(f.platform.lifecycle.view().extensions.length,4);
});

test('mid-prepare failure releases the partial lifecycle and a retry installs one clean registration set',async t=>{
  const f=await fixture(t);
  f.integrationSettings.fail=true;
  assert.throws(()=>f.platform.prepare(),/Generated lifecycle registration failure/);
  assert.throws(()=>f.platform.start(),{statusCode:503});
  f.integrationSettings.fail=false;
  f.platform.prepare();
  assert.equal(f.platform.lifecycle.view().extensions.length,4);
  assert.doesNotThrow(()=>f.platform.start());
});

test('the host factory provides the lifecycle port and withdraws it on close',async t=>{
  const f=await fixture(t);
  const issues=checkCentralServiceDeclarations(
    [{service:{id:memoryLifecycleServiceContribution.provides[0].id,apiVersion:memoryLifecycleServiceContribution.provides[0].apiVersion},provider:{scope:{host:{kind:'central',id:'generated'},packageId:'mote.memory-lifecycle-service',installationId:'generated',instanceId:'memory-lifecycle-service',activationId:'generated'},contributionId:memoryLifecycleServiceContribution.id}}],
    [{consumer:'mote.memory',service:{id:centralServices.memoryLifecycle.id,apiVersion:centralServices.memoryLifecycle.apiVersion}}]);
  assert.deepEqual(issues,[]);
  const host=new PluginHost({kind:'central',id:'generated-memory-lifecycle-host'});
  t.after(()=>host.close());
  let bindings:MemoryLifecycleServiceBindings|undefined;
  const handle=await host.install({identity:{host:host.identity,packageId:'mote.memory-lifecycle-service',installationId:randomUUID(),instanceId:randomUUID(),activationId:randomUUID()},contributions:[memoryLifecycleServiceDeclaration],factory:createMemoryLifecycleServiceFactory(f.platform,value=>{bindings=value;})});
  const lease=await host.acquire(centralServices.memoryLifecycle,bindings!.memoryLifecycle);
  assert.equal(lease.value.lifecycle.view().extensions.length,4);
  await handle.quiesce('upgrade');
  assert.throws(()=>lease.value.lifecycle.request('insights',[randomUUID()],'generated-checkpoint'),{statusCode:503});
  await handle.close('disabled');
  assert.throws(()=>lease.value.lifecycle,{code:'dependency_unavailable'});
  await lease.release();
});
