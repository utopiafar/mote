import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {parse,stringify} from 'yaml';
import {z} from 'zod';
import {PluginHost} from '@mote/plugin-host';
import type {ScopeIdentity} from '@mote/plugin-api/contracts';
import {createConfigurationPlatform,createConfigurationPlatformFactory,configurationPlatformDeclaration,configurationServices} from '../src/plugins/configuration-platform.js';
import {defaultModelSettings} from '../src/model-settings.js';
import {ExecutionSettings} from '../src/execution-settings.js';

const owner='generated-configuration-owner-token';
const seed=()=>({version:1 as const,revision:0,server:{token:owner},models:{deployment:{...defaultModelSettings(),model:'generated-model',apiKey:'generated-private-key',headers:{'X-Generated':'generated-private-header'},extraBody:{credential:'generated-private-body'}}}});
function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
async function fixture(t:TestContext,watch=false){
  const directory=await mkdtemp(join(tmpdir(),'mote-configuration-platform-')),path=join(directory,'mote.yaml');
  const platform=createConfigurationPlatform({path,initialDocument:seed(),watch});
  t.after(async()=>{await platform.close();await rm(directory,{recursive:true,force:true});});
  await platform.prepare();return {platform,path};
}
async function edit(path:string,change:(document:any)=>void){const document=parse(await readFile(path,'utf8'));change(document);await writeFile(path,stringify(document));}
const modelDependencies=()=>({prepare:async()=>({activate(){},dispose:async()=>{}}),probe:async()=>({ok:true as const,code:'ok' as const,message:'generated external boundary',durationMs:1})});

test('real ExecutionSettings consumes detached domain values, saves once and restarts at the persisted revision',async t=>{
  const {platform,path}=await fixture(t),events:unknown[]=[];
  platform.execution.subscribe(value=>events.push(JSON.parse(JSON.stringify(value))));
  const settings=new ExecutionSettings({execution:platform.execution,diagnostics:platform.diagnostics});
  const saved=await settings.saveExecution({revision:0,interactiveConcurrency:1,agentConcurrency:5,llmConcurrency:2,memoryConcurrency:2});
  assert.equal(saved.agentConcurrency,5);assert.equal(saved.revision,1);assert.equal(events.length,1);
  assert.deepEqual(events[0],{revision:1,value:settings.execution()});
  const copy=platform.execution.snapshot();copy.value.agentConcurrency=64;
  assert.equal(settings.execution().agentConcurrency,5);
  await platform.configService.reload();
  await platform.configService.update('diagnostics',{debug:true},1);
  assert.equal(events.length,1,'unrelated domains and no-op reloads do not publish execution changes');
  await platform.close();const restarted=createConfigurationPlatform({path,watch:false});t.after(()=>restarted.close());
  await restarted.prepare();assert.equal(restarted.runtimeSettings.execution().agentConcurrency,5);assert.equal(restarted.execution.snapshot().revision,2);
  assert.equal((await stat(path)).mode&0o777,0o600);
});

test('public domain patches cannot reach hidden deployment fields and watcher startup can be cancelled',async t=>{
  const {platform,path}=await fixture(t,true);
  await assert.rejects(platform.execution.update({insightIntervalHours:24} as never,0),{code:'config_invalid'});
  await assert.rejects(platform.diagnostics.update({directory:'/generated/not-used'} as never,0),{code:'config_invalid'});
  assert.equal(platform.execution.snapshot().revision,0);
  const started=platform.start(),observed=assert.rejects(started,{code:'config_unavailable'});
  const closed=platform.close();await observed;
  await closed;
  assert.throws(()=>platform.execution.snapshot(),{code:'config_unavailable'});
  // close is idempotent, including its observable startup cancellation result.
  assert.equal(platform.close(),closed);
  const restarted=createConfigurationPlatform({path,watch:true});t.after(()=>restarted.close());await restarted.prepare();await restarted.start();
});

test('actual file watcher publishes one registered-domain change and unsubscribed consumers stay silent',async t=>{
  const {platform,path}=await fixture(t,true),seen:number[]=[],changed=barrier();
  const unsubscribe=platform.execution.subscribe(({revision,value})=>{seen.push(revision);assert.equal(value.memoryConcurrency,4);changed.release();});
  await platform.start();
  await edit(path,document=>{document.execution.memoryConcurrency=4;});
  await changed.promise;
  await platform.configService.reload();assert.deepEqual(seen,[1]);
  unsubscribe();await platform.runtimeSettings.saveExecution({...platform.runtimeSettings.execution(),revision:1,memoryConcurrency:5});
  assert.deepEqual(seen,[1]);
});

test('close removes callbacks before held accepted configuration work drains and same profile reopens',async t=>{
  const {platform,path}=await fixture(t),entered=barrier(),finish=barrier(),events:unknown[]=[];
  const service=platform.configService;
  service.setHandler('execution',async()=>{entered.release();await finish.promise;return {apply(){}};});
  platform.execution.subscribe(value=>events.push(value));
  const pending=platform.execution.update({agentConcurrency:6},0);
  // Observe rejection immediately so node:test does not mistake the controlled close fence for an unhandled rejection.
  const rejected=assert.rejects(pending,{code:'config_unavailable'});
  await entered.promise;const closing=platform.close();
  assert.throws(()=>platform.execution.snapshot(),{code:'config_unavailable'});
  assert.throws(()=>platform.execution.subscribe(()=>{}),{code:'config_unavailable'});
  finish.release();await closing;await rejected;assert.deepEqual(events,[]);
  assert.equal(parse(await readFile(path,'utf8')).execution.agentConcurrency,6,'accepted file transaction drains before shutdown completes');
  await service.reload().then(()=>assert.fail('closed service accepted reload'),error=>assert.equal(error.code,'config_unavailable'));
  const restarted=createConfigurationPlatform({path,watch:false});t.after(()=>restarted.close());await restarted.prepare();
  assert.equal(restarted.runtimeSettings.execution().agentConcurrency,6);
});

test('declared plugin domains validate values, reject unknown schemas and publish only their own changes',async t=>{
  const {platform}=await fixture(t),events:unknown[]=[];
  assert.throws(()=>platform.configService.current('plugin.missing'),{code:'config_invalid'});
  const domain=await platform.registerDomain({id:'generated',schema:z.object({enabled:z.boolean()}).strict(),defaultValue:{enabled:false}});
  domain.subscribe(value=>events.push(value));
  await domain.update({enabled:true},0);assert.deepEqual(events,[{revision:1,value:{enabled:true}}]);
  await assert.rejects(domain.update({enabled:'bad'} as never,1),{code:'config_invalid'});assert.equal(events.length,1);
  await assert.rejects(platform.registerDomain({id:'secret',schema:z.object({key:z.string()}),defaultValue:{key:'generated-private'},fields:[{path:'key',sensitive:true}]}),{code:'config_invalid'});
  await assert.rejects(platform.registerDomain({id:'generated',schema:z.object({enabled:z.boolean()}),defaultValue:{enabled:false}}),{code:'config_conflict'});
  await platform.quiesce('restart');assert.deepEqual(domain.snapshot(),{revision:1,value:{enabled:true}});
  await assert.rejects(domain.update({enabled:false},1),{code:'config_unavailable'});
});

test('model selection fails closed until AGENT binding and returns no credentials or endpoint',async t=>{
  const {platform}=await fixture(t);
  assert.throws(()=>platform.selection.select('chat'),{code:'model_settings_unavailable'});
  assert.throws(()=>platform.modelSettings,{code:'model_settings_unavailable'});
  await platform.bindModels(modelDependencies());
  const selected=platform.selection.select('chat');assert.equal(selected.settings.model,'generated-model');assert.equal(selected.settings.apiKeyConfigured,true);
  const serialized=JSON.stringify(selected);
  for(const forbidden of ['generated-private','baseUrl','api.deepseek','X-Generated','credential'])assert.equal(serialized.includes(forbidden),false);
  assert.throws(()=>platform.selection.select('chat','missing'),{code:'model_profile_missing'});
  selected.settings.model='changed-copy';assert.equal(platform.selection.select('chat').settings.model,'generated-model');
  await platform.modelSettings.update({revision:0,settings:{...platform.modelSettings.current(),model:'changed-model'}});
  assert.equal(platform.selection.select('chat').settings.model,'changed-model');assert.equal(platform.selection.select('chat').revision,1);
});

test('restart-only saved values stay pinned until restart and owner token conflicts remain rejected',async t=>{
  const {platform,path}=await fixture(t);
  await platform.configService.update('server',{port:49101},0);
  assert.equal(platform.configService.current<{port:number}>('server').port,47832);
  assert.equal(platform.configService.view().domains.find(domain=>domain.id==='server')!.status,'restart-required');
  await assert.rejects(platform.configService.update('connectors',{mcpReadToken:owner},1),{code:'config_invalid'});
  assert.equal(JSON.stringify(platform.configService.view()).includes(owner),false);
  await platform.close();const restarted=createConfigurationPlatform({path,watch:false});t.after(()=>restarted.close());await restarted.prepare();
  assert.equal(restarted.configService.current<{port:number}>('server').port,49101);
});

test('real H04 factory owns watcher and stores, exact leases fence after provider shutdown',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-configuration-host-')),path=join(directory,'mote.yaml'),hostId={kind:'central' as const,id:'generated-host'};
  const host=new PluginHost(hostId),identity:ScopeIdentity={packageId:'generated.configuration',installationId:'generated-build',instanceId:'default',activationId:'first',host:hostId};
  t.after(async()=>{await host.close();await rm(directory,{recursive:true,force:true});});
  const provider=await host.install({identity,contributions:[configurationPlatformDeclaration],restartRequired:true,factory:createConfigurationPlatformFactory({path,initialDocument:seed(),watch:true},modelDependencies())});
  const binding={provider:{scope:identity,contributionId:configurationPlatformDeclaration.id},service:configurationServices.execution,revision:0};
  const lease=await host.acquire(configurationServices.execution,binding),events:unknown[]=[];
  lease.value.subscribe(value=>events.push(value));await lease.value.update({agentConcurrency:3},0);
  assert.equal(lease.value.snapshot().value.agentConcurrency,3);assert.equal(events.length,1);
  const selection=await host.acquire(configurationServices.modelSelection,{...binding,service:configurationServices.modelSelection});
  assert.equal(selection.value.select('chat').settings.model,'generated-model');
  await provider.close('restart');assert.equal(lease.signal.aborted,true);assert.throws(()=>lease.value.snapshot());
  assert.equal(host.snapshot().contributions.length,0);
  const restarted=createConfigurationPlatform({path,watch:false});t.after(()=>restarted.close());await restarted.prepare();
  await restarted.execution.update({agentConcurrency:4},1);await setImmediate();assert.equal(events.length,1);
});
