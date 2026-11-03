import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {PluginHost} from '@mote/plugin-host';
import {serviceContract,type ScopeIdentity,type ServiceBinding} from '@mote/plugin-api/contracts';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {GitHubPluginReleases} from '../src/plugin-release.js';
import {createPluginControlPlatform,pluginControlDeclaration,type TrustedPluginBuild} from '../src/plugin-center.js';

const command=(expectedRevision:number)=>({operationId:randomUUID(),expectedRevision});
function directory(t:TestContext){const path=mkdtempSync(join(tmpdir(),'mote-s05-'));t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}
const read=serviceContract<{read():number;hold():Promise<string>}>('fixture.read','1');
function build(overrides:Partial<TrustedPluginBuild>={}):TrustedPluginBuild{
  return {packageId:'fixture.build',version:'1.0.0',replacement:'hot',
    contribution:{id:'fixture.build.port',version:'1.0.0',surface:'data',runtime:'host',provides:[{kind:'service',id:read.id,apiVersion:'1',cardinality:'single'}]},
    factory:context=>({prepare(){},start(){context.provide('fixture.build.port',read,{read:()=>7,hold:async()=>'unused'});},quiesce(){},stop(){},dispose(){}}),
    ...overrides};
}
// The registry stays open until the next-start selection is consumed, so a
// dependent can pin a provider activation that only exists after selection.
async function platform(path:string,builds:TrustedPluginBuild[]=[]){
  const store=new Store(path),executor=new ExecutionEngine(store),host=new PluginHost({kind:'central',id:randomUUID()});
  const control=createPluginControlPlatform({store,executor,host,releases:new GitHubPluginReleases(join(path,'packages'))},builds);
  const identity:ScopeIdentity={host:host.identity,packageId:'mote.control',installationId:'control-install',instanceId:'control-instance',activationId:randomUUID()};
  const handle=await host.install({identity,contributions:[pluginControlDeclaration],factory:control.factory});
  return {store,executor,host,control,handle,plugins:control.assembly,async close(){await handle.close('shutdown');await host.close();await executor.close();store.close();}};
}
const selection={packageId:'fixture.build',version:'1.0.0',configurationRevision:0};
function binding(identity:ScopeIdentity):ServiceBinding{return {service:read,provider:{scope:identity,contributionId:'fixture.build.port'},revision:0};}
async function until(check:()=>boolean){const deadline=Date.now()+5000;while(!check()){assert.ok(Date.now()<deadline,'controlled operation settles');await delay(5);}}

// User failure: a hot replacement that cannot start must not take the running
// activation down with it; the failed candidate is a blocker, not an outage.
test('a rejected candidate keeps the running activation, its leases and an idempotent command',async t=>{
  const path=directory(t);let prepares=0;
  const rejected=build({version:'1.1.0',contribution:{...build().contribution,version:'1.1.0'},
    factory:()=>({prepare(){prepares++;throw Error('generated candidate rejection');},start(){},quiesce(){},stop(){},dispose(){}})});
  const f=await platform(path,[build(),rejected]);t.after(()=>f.close());
  const first=await f.plugins.selectBuild('one',{...command(f.plugins.revision()),selection});assert.equal(first.observed,'active');
  const lease=await f.host.acquire(read,binding(first.active!.identity));assert.equal(lease.value.read(),7);
  const input={...command(first.revision),selection:{...selection,version:'1.1.0'}};
  const result=await f.plugins.selectBuild('one',input);
  assert.equal(prepares,1);assert.equal(result.observed,'blocked');assert.deepEqual(result.blockers,['activation_requires_attention']);
  assert.equal(result.active!.version,'1.0.0');assert.equal(result.active!.identity.activationId,first.active!.identity.activationId,'the failed candidate never unregistered the live activation');
  assert.equal(f.plugins.control.build('one')!.observed,'active','the persisted record keeps the surviving activation active');
  assert.equal(lease.value.read(),7);assert.equal(lease.signal.aborted,false,'accepted leases keep serving the pinned provider');
  const replay=await f.plugins.selectBuild('one',input);
  assert.deepEqual(replay,result);assert.equal(prepares,1,'a replayed operation never retries the rejected candidate');
  await lease.release();
});

// A successful upgrade registers v2 active while v1's accepted work still
// drains; v1 only stops after its in-flight lease call completes.
test('a hot upgrade registers the new activation while accepted work drains out of the old one',async t=>{
  const path=directory(t),order:string[]=[];
  let release!:()=>void;const gate=new Promise<void>(done=>release=done);
  const v1=build({factory:context=>({prepare(){},start(){context.provide('fixture.build.port',read,{read:()=>7,hold:async()=>{order.push('v1-call-accepted');await gate;order.push('v1-call-completed');return 'drained';}});},
    quiesce(){order.push('v1-quiesced');},stop(){order.push('v1-stopped');},dispose(){order.push('v1-disposed');}})});
  const v2=build({version:'1.1.0',contribution:{...build().contribution,version:'1.1.0'},
    factory:context=>({prepare(){},start(){order.push('v2-started');context.provide('fixture.build.port',read,{read:()=>11,hold:async()=>'unused'});},quiesce(){},stop(){},dispose(){}})});
  const f=await platform(path,[v1,v2]);t.after(()=>f.close());
  const first=await f.plugins.selectBuild('one',{...command(f.plugins.revision()),selection});assert.equal(first.observed,'active');
  const lease=await f.host.acquire(read,binding(first.active!.identity));
  const draining=lease.value.hold();await until(()=>order.includes('v1-call-accepted'));
  const upgrading=f.plugins.selectBuild('one',{...command(first.revision),selection:{...selection,version:'1.1.0'}});
  await until(()=>order.includes('v1-quiesced'));
  const mid=f.plugins.buildView('one');
  assert.equal(mid.observed,'active');assert.equal(mid.active!.version,'1.1.0','the replacement is registered active before the outgoing activation retires');
  assert.equal(lease.value.read(),7);assert.equal(lease.signal.aborted,false,'the pinned v1 lease still serves while the upgrade drains');
  release();assert.equal(await draining,'drained');
  const result=await upgrading;assert.equal(result.observed,'active');assert.equal(result.active!.version,'1.1.0');
  assert.notEqual(result.active!.identity.activationId,first.active!.identity.activationId);
  assert.deepEqual(order,['v1-call-accepted','v2-started','v1-quiesced','v1-call-completed','v1-stopped','v1-disposed'],'accepted work drains before the outgoing lifecycle stops');
  const scopes=f.host.snapshot().contributions.filter(value=>value.identity.scope.instanceId==='one');
  assert.equal(scopes.length,1,'the control surface shows only the replacement activation');
  assert.equal(scopes[0]!.availability.state,'active');assert.equal(scopes[0]!.identity.scope.activationId,result.active!.identity.activationId);
  await assert.rejects(f.host.acquire(read,binding(first.active!.identity)),{code:'dependency_unavailable'});
  await lease.release();
});

// A dependent pinned to the outgoing activation is retired by the provider's
// graceful close and reports an explicit blocker instead of looking active.
test('a provider hot upgrade retires dependents pinned to the outgoing activation',async t=>{
  const path=directory(t),order:string[]=[];
  const f=await platform(path,[build()]);t.after(()=>f.close());
  const provider=await f.plugins.selectBuild('provider',{...command(f.plugins.revision()),selection});assert.equal(provider.observed,'active');
  const dependent:TrustedPluginBuild={packageId:'fixture.dependent',version:'1.0.0',replacement:'hot',
    contribution:{id:'fixture.dependent.port',version:'1.0.0',surface:'data',runtime:'host',requires:[{kind:'service',id:read.id,version:'1'}]},
    requires:[binding(provider.active!.identity)],
    factory:()=>({prepare(){},start(){},quiesce(){},stop(){order.push('dependent-stopped');},dispose(){}})};
  f.plugins.registerBuild(dependent);
  const consumer=await f.plugins.selectBuild('consumer',{...command(f.plugins.revision()),selection:{packageId:'fixture.dependent',version:'1.0.0',configurationRevision:0}});
  assert.equal(consumer.observed,'active');
  f.plugins.registerBuild(build({version:'1.1.0',contribution:{...build().contribution,version:'1.1.0'}}));
  const result=await f.plugins.selectBuild('provider',{...command(provider.revision),selection:{...selection,version:'1.1.0'}});
  assert.equal(result.observed,'active');assert.equal(result.active!.version,'1.1.0');
  assert.deepEqual(order,['dependent-stopped'],'the dependent retires before the provider close resolves');
  assert.ok(!f.host.snapshot().contributions.some(value=>value.identity.scope.instanceId==='consumer'));
  const blocked=f.plugins.buildView('consumer');
  assert.equal(blocked.active,null);assert.equal(blocked.observed,'blocked');
  assert.deepEqual(blocked.blockers,['activation_unavailable'],'a dependent pinned to the retired activation reports an explicit blocker');
});
