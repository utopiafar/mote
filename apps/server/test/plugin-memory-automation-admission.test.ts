import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PluginHost} from '@mote/plugin-host';
import {Store} from '../src/store.js';
import {centralServices,type MemoryAdmission} from '../src/plugins/central-contracts.js';
import {
  createMemoryAutomationAdmission,createMemoryAutomationAdmissionFactory,
  memoryAutomationAdmissionContribution,memoryAutomationAdmissionDeclaration,
  type MemoryAutomationAdmissionBindings,
} from '../src/plugins/memory-automation-admission.js';
import type {MemoryAutomationStore} from '../src/memory-automation.js';

function profile(t:test.TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-admission-')),store=new Store(directory);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,store};
}

async function install(host:PluginHost,store:Store){
  const platform=createMemoryAutomationAdmission(store);let bindings:MemoryAutomationAdmissionBindings|undefined;
  const handle=await host.install({
    identity:{host:host.identity,packageId:'generated.memory-automation-admission',installationId:randomUUID(),instanceId:randomUUID(),activationId:randomUUID()},
    contributions:[memoryAutomationAdmissionDeclaration],factory:createMemoryAutomationAdmissionFactory(platform,value=>{bindings=value;}),
  });
  const lease=await host.acquire(centralServices.memoryAdmission,bindings!.admission);
  return {platform,handle,admission:lease.value as MemoryAdmission,async close(){await lease.release();await handle.close('disabled');}};
}

test('quiesce rejects new admission while reads survive, and a fresh activation or host restart restores the durable setting',async t=>{
  const f=profile(t),holder=randomUUID();
  let host=new PluginHost({kind:'central',id:'generated-memory-admission-host'});
  t.after(async()=>{await host.close();});
  let current=await install(host,f.store);t.after(()=>current.close());
  assert.equal(current.admission.accepting(),true);
  current.admission.freeze(holder);
  assert.equal(current.admission.accepting(),false);
  assert.throws(()=>current.admission.release(randomUUID()),{statusCode:409},'a foreign holder cannot release the cutover fence');
  assert.equal(current.admission.state().barrier,holder);
  current.admission.release(holder);
  assert.equal(current.admission.accepting(),true);
  const pause={operationId:randomUUID(),expectedRevision:current.admission.state().revision};
  current.admission.command('pause',pause);assert.equal(current.admission.view().state,'paused');
  await current.handle.quiesce('disabled');
  assert.equal(current.admission.accepting(),false);
  assert.equal(current.admission.view().state,'paused','reads keep the durable projection while quiescing');
  assert.throws(()=>current.admission.command('resume',{operationId:randomUUID(),expectedRevision:current.admission.state().revision}),{statusCode:503});
  await current.handle.close('disabled');

  current=await install(host,f.store);
  assert.equal(current.admission.state().desired,false,'re-enabling without a process restart reads the same durable state');
  current.admission.command('resume',{operationId:randomUUID(),expectedRevision:current.admission.state().revision});
  assert.equal(current.admission.accepting(),true);

  await host.close();
  host=new PluginHost({kind:'central',id:'generated-memory-admission-restarted-host'});
  current=await install(host,f.store);
  assert.equal(current.admission.state().desired,true);
  assert.equal(current.admission.accepting(),true);
  assert.equal(current.admission.state().barrier,undefined);
});

test('a prepare failure leaves no acquirable admission object and close remains idempotent',async t=>{
  const failure=new Error('Generated Memory automation DDL failure');
  const broken:MemoryAutomationStore={
    db:{exec(){throw failure;},prepare(){throw failure;},get isTransaction(){return false;}} as unknown as MemoryAutomationStore['db'],
    reserveMetadata(){},
  };
  const platform=createMemoryAutomationAdmission(broken);
  assert.throws(()=>platform.automationForAssembly,{statusCode:503});
  assert.throws(()=>platform.prepare(),failure);
  assert.throws(()=>platform.automationForAssembly,{statusCode:503});
  await platform.close();await platform.close();
  assert.deepEqual(memoryAutomationAdmissionContribution.provides.map(service=>service.id),[centralServices.memoryAdmission.id]);
});
