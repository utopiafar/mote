import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {bootstrapCentral} from '../src/bootstrap.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {GitHubPluginReleases} from '../src/plugin-release.js';
import {createPluginControlPlatform,pluginControlDeclaration} from '../src/plugin-center.js';
import type {StateStore} from '@mote/plugin-api';
import {PluginHost,type HostScope} from '@mote/plugin-host';
import {Store} from '../src/store.js';
import {createVaultPlatformAssembly} from '../src/plugins/vault-platform.js';
import {bindInstanceStateCommit} from '../src/plugin-instance-state-storage.js';

async function fixture(t:{after(fn:()=>unknown):void}){
  const dataDir=mkdtempSync(join(tmpdir(),'mote-plugin-state-boundary-'));
  const configuration:ConfigurationPlatformOptions={path:join(dataDir,'mote.yaml'),privateCredential:{token:'generated-state-boundary-owner',tokenPath:'generated-only'},
    initialDocument:{version:1,revision:0,storage:{dataDir,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},
      models:{deployment:{model:'',baseUrl:'',apiKey:'',allowUnauthenticatedLocal:false},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'}}};
  const boot=await bootstrapCentral({configuration,backgroundWorker:false});
  t.after(async()=>{await boot.close();rmSync(dataDir,{recursive:true,force:true});});
  return {boot,dataDir};
}

test('real bootstrap StateStore cannot reveal the vault or rewrite a sibling namespace',async t=>{
  const {boot}=await fixture(t),states:StateStore[]=[];
  for(const instanceId of ['one','two'])await boot.host.install({
    identity:{host:boot.host.identity,packageId:'generated.state-boundary',installationId:'generated-install',instanceId,activationId:randomUUID()},
    contributions:[],factory:context=>{states.push(context.state);return {prepare(){},start(){},quiesce(){},stop(){},dispose(){}};},
  });
  await states[0].compareAndSet('value',null,{ownedBy:'one'});await states[1].compareAndSet('value',null,{ownedBy:'two'});
  const escaped=Reflect.get(states[0],'store');
  if(escaped){const json=JSON.stringify({ownedBy:'foreign-plugin'});escaped.db.prepare('UPDATE plugin_instance_state SET json=?,bytes=? WHERE instance_id=?').run(json,Buffer.byteLength(json),'two');}
  assert.deepEqual((await states[1].get('value'))?.value,{ownedBy:'two'},'an ordinary plugin must not obtain SQL that bypasses its fixed namespace');
  assert.deepEqual(Object.keys(states[0]).sort(),['checkpoint','compareAndSet','get','list']);assert.equal(Object.isFrozen(states[0]),true);
  for(const field of ['store','db','scope','namespace','bindCommit'])assert.equal(Reflect.get(states[0],field),undefined);
});

test('PluginCenter control capability cannot reveal raw storage or bypass its intent revision',async t=>{
  const {boot,dataDir}=await fixture(t),executor=new ExecutionEngine(boot.store);
  const platform=createPluginControlPlatform({store:boot.store,executor,host:boot.host,releases:new GitHubPluginReleases(join(dataDir,'packages')),
    controlForScope:scope=>boot.pluginStorage.controlForScope(scope)});
  const handle=await boot.host.install({identity:{host:boot.host.identity,packageId:'generated.control-boundary',installationId:'generated-control-install',instanceId:'control',activationId:randomUUID()},
    contributions:[pluginControlDeclaration],factory:platform.factory});
  t.after(async()=>{await handle.close('shutdown');await executor.close();});
  const control=platform.assembly.control,before=control.revision(),escaped=Reflect.get(control,'store');
  if(escaped)escaped.db.prepare('UPDATE plugin_center SET revision=999 WHERE id=1').run();
  assert.equal(control.revision(),before,'control clients must not obtain SQL that bypasses the command CAS and receipt');
  assert.deepEqual(Object.keys(control).sort(),['build','builds','bump','command','receipt','revision','saveBuild']);assert.equal(Object.isFrozen(control),true);
  for(const field of ['store','db','namespace'])assert.equal(Reflect.get(control,field),undefined);
});

for(const stopped of ['owner','consumer','vault'] as const)test(`Vault plugin storage rejects retained state and control after ${stopped} stops`,async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'mote-plugin-storage-stop-')),store=new Store(dataDir);
  const vault=createVaultPlatformAssembly({dataDir},{store});
  let owner!:HostScope,consumer!:HostScope,state!:StateStore;
  const host=new PluginHost({kind:'central',id:randomUUID()},undefined,undefined,{stateFor:scope=>vault.instanceStateForAssembly(owner,scope)});
  t.after(async()=>{try{await host.close();}finally{try{await vault.close();}finally{store.close();rmSync(dataDir,{recursive:true,force:true});}}});
  await vault.prepare();
  const identity=(instanceId:string)=>({host:host.identity,packageId:'generated.storage-stop',installationId:'generated-storage-stop',instanceId,activationId:randomUUID()});
  const lifecycle=()=>({prepare(){},start(){},quiesce(){},stop(){},dispose(){}});
  const ownerHandle=await host.install({identity:identity('owner'),contributions:[],factory:context=>{owner=context.scope;return lifecycle();}});
  const consumerHandle=await host.install({identity:identity('consumer'),contributions:[],factory:context=>{consumer=context.scope;state=context.state;return lifecycle();}});
  const control=vault.pluginControlForAssembly(owner,consumer),revision=control.revision();
  await state.compareAndSet('control',null,{step:1});
  assert.deepEqual((await state.get('control'))?.value,{step:1});assert.equal((await state.list()).length,1);assert.equal((await state.checkpoint()).records,1);
  const commit=bindInstanceStateCommit(state,'control'),rows=()=>store.db.prepare('SELECT * FROM plugin_instance_state').all(),before=rows();
  if(stopped==='owner')await ownerHandle.close('disabled');
  else if(stopped==='consumer')await consumerHandle.close('disabled');
  else await vault.close();
  assert.equal(store.db.isOpen,true,'the borrowed vault stays open so stale views cannot rely on a closed database');
  if(stopped!=='consumer')assert.doesNotThrow(()=>consumer.assertCurrent(),'the consumer remains live when its storage owner stops');
  const results=await Promise.allSettled([state.get('control'),state.list(),state.checkpoint(),state.compareAndSet('control',1,{step:2})]);
  assert.deepEqual(rows(),before);
  assert.deepEqual(results.map(result=>result.status==='rejected'?result.reason.code:result.status),['stale_scope','stale_scope','stale_scope','stale_scope']);
  store.db.exec('BEGIN IMMEDIATE');
  try{assert.throws(()=>commit(1,{step:2}),{code:'stale_scope'});}finally{store.db.exec('ROLLBACK');}
  for(const operation of [()=>control.revision(),()=>control.bump(),()=>control.command('generated-stop',{operationId:'generated-stop',expectedRevision:revision},()=>revision,()=>{throw Error('stale apply must not run');}),()=>control.receipt('generated-stop'),()=>control.build('generated-stop'),()=>control.builds(),()=>control.saveBuild({id:'generated-stop',packageId:'generated.storage-stop',installationId:'generated-storage-stop',revision:1,desired:null,retired:false,observed:'stopped',blockers:[],operationId:'generated-stop'})])assert.throws(operation,{statusCode:503});
  assert.deepEqual(rows(),before);assert.equal(store.db.prepare('SELECT revision FROM plugin_center WHERE id=1').get()?.revision,revision);
});
