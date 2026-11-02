import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {parse,stringify} from 'yaml';
import {z} from 'zod';
import {FSWatcher} from 'chokidar';
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

test('hot plugin edits preserve saved restart-only fields and restart applies the pending value',async t=>{
  const {platform,path}=await fixture(t),events:unknown[]=[];
  const registration={id:'restartable',schema:z.object({cold:z.number().int(),hot:z.number().int()}).strict(),defaultValue:{cold:0,hot:0},
    fields:[{path:'cold',effect:'restart' as const},{path:'hot',effect:'immediate' as const}]};
  const domain=await platform.registerDomain(registration);domain.subscribe(value=>events.push(value));
  await domain.update({cold:1},0);
  assert.deepEqual(domain.snapshot(),{revision:1,value:{cold:0,hot:0}});
  assert.deepEqual(platform.configService.saved('plugin.restartable'),{cold:1,hot:0});
  await domain.update({hot:1},1);
  assert.deepEqual(domain.snapshot(),{revision:2,value:{cold:0,hot:1}});
  assert.deepEqual(platform.configService.saved('plugin.restartable'),{cold:1,hot:1});
  assert.deepEqual(parse(await readFile(path,'utf8')).plugins.configuration.restartable,{cold:1,hot:1});
  assert.deepEqual(events,[{revision:2,value:{cold:0,hot:1}}]);
  await platform.close();
  const restarted=createConfigurationPlatform({path,watch:false});t.after(()=>restarted.close());await restarted.prepare();
  const reloaded=await restarted.registerDomain(registration);
  assert.deepEqual(reloaded.snapshot(),{revision:2,value:{cold:1,hot:1}});
});

test('registered transforming schemas publish their validated output without parsing it again',async t=>{
  const {platform,path}=await fixture(t),events:unknown[]=[];let transforms=0;
  const domain=await platform.registerDomain({id:'transformed',schema:z.object({limit:z.string().transform(value=>{transforms++;return Number(value);})}).strict(),defaultValue:{limit:'2'}});
  const afterRegistration=transforms;
  assert.deepEqual(domain.snapshot(),{revision:0,value:{limit:2}});
  domain.subscribe(value=>events.push(value));
  assert.equal(transforms,afterRegistration,'reads and subscriptions do not rerun input parsing');
  await edit(path,document=>{document.plugins.configuration.transformed={limit:'3'};});await platform.configService.reload();
  assert.deepEqual(events,[{revision:1,value:{limit:3}}]);
  const afterReload=transforms,snapshot=domain.snapshot();snapshot.value.limit=99;
  assert.deepEqual(domain.snapshot(),{revision:1,value:{limit:3}});assert.equal(transforms,afterReload);
});

test('public plugin patches reject paths stripped by non-strict schemas without persisting hidden settings',async t=>{
  const {platform,path}=await fixture(t);
  const domain=await platform.registerDomain({id:'nonStrict',schema:z.object({enabled:z.boolean(),nested:z.object({limit:z.number()})}),defaultValue:{enabled:false,nested:{limit:0}}});
  for(const patch of [{enabled:true,typo:7},{enabled:true,nested:{limit:1,typo:7}}]){
    await assert.rejects(domain.update(patch,0),{code:'config_invalid'});
    assert.deepEqual(domain.snapshot(),{revision:0,value:{enabled:false,nested:{limit:0}}});
    assert.equal((await readFile(path,'utf8')).includes('typo'),false);
  }
  await domain.update({enabled:true},0);
  assert.deepEqual(parse(await readFile(path,'utf8')).plugins.configuration.nonStrict,{enabled:true,nested:{limit:0}});
});

test('input paths remain writable when registered transforms rename output keys',async t=>{
  const {platform,path}=await fixture(t);
  const schema=z.object({enabled:z.boolean(),nested:z.object({label:z.string()}).transform(({label})=>({title:label})).optional()})
    .transform(({enabled,nested})=>({active:enabled,detail:nested??null}));
  const domain=await platform.registerDomain({id:'renamed',schema,defaultValue:{enabled:false}});
  // Raw editor input and parsed output intentionally have distinct shapes.
  await domain.update({enabled:true,nested:{label:'generated label'}},0);
  assert.deepEqual(domain.snapshot(),{revision:1,value:{active:true,detail:{title:'generated label'}}});
  const raw=parse(await readFile(path,'utf8')).plugins.configuration.renamed;
  assert.deepEqual(raw,{enabled:true,nested:{label:'generated label'}});
  for(const patch of [{enabled:false,typo:7},{nested:{label:'other',typo:7}}]){
    await assert.rejects(domain.update(patch as never,1),{code:'config_invalid'});
  }
  assert.deepEqual(domain.snapshot(),{revision:1,value:{active:true,detail:{title:'generated label'}}});
});

test('preprocess and catch wrappers reject hidden input keys while intentionally open schemas remain open',async t=>{
  const {platform,path}=await fixture(t),shape=z.object({enabled:z.boolean()});
  for(const [id,schema] of [['preprocessed',z.preprocess(value=>value,shape)],['caught',shape.catch({enabled:false})]] as const){
    const domain=await platform.registerDomain({id,schema,rawInputSchema:shape,defaultValue:{enabled:false}}),revision=domain.snapshot().revision;
    await assert.rejects(domain.update({enabled:true,typo:7} as never,revision),{code:'config_invalid'});
    assert.deepEqual(domain.snapshot(),{revision,value:{enabled:false}});
    assert.equal((await readFile(path,'utf8')).includes('typo'),false);
    await domain.update({enabled:true},revision);assert.equal(domain.snapshot().value.enabled,true);
  }
  const open=await platform.registerDomain({id:'open',schema:z.preprocess(value=>value,shape.passthrough().catch({enabled:false})),rawInputSchema:shape.passthrough(),defaultValue:{enabled:false}});
  await open.update({enabled:true,declaredOpenValue:7} as never,open.snapshot().revision);
  assert.deepEqual(open.snapshot().value,{enabled:true,declaredOpenValue:7});
});

test('declared raw alias inputs are typed and saved without raw-schema defaults or transformed outputs',async t=>{
  const {platform,path}=await fixture(t),events:unknown[]=[];
  const schema=z.preprocess(value=>({enabled:(value as {rawEnabled:boolean}).rawEnabled}),z.object({enabled:z.boolean()}));
  const rawInputSchema=z.object({rawEnabled:z.boolean().transform(value=>!value),rawLabel:z.string().default('generated default must not persist')});
  const domain=await platform.registerDomain({id:'alias',schema,rawInputSchema,defaultValue:{rawEnabled:false}});
  domain.subscribe(snapshot=>events.push(snapshot));
  await domain.update({rawEnabled:true},0);
  const enabled:boolean=domain.snapshot().value.enabled;assert.equal(enabled,true);
  assert.deepEqual(events,[{revision:1,value:{enabled:true}}]);
  assert.deepEqual(parse(await readFile(path,'utf8')).plugins.configuration.alias,{rawEnabled:true});
  for(const patch of [{rawEnabled:false,typo:7},{enabled:false}])await assert.rejects(domain.update(patch as never,1),{code:'config_invalid'});
  assert.deepEqual(domain.snapshot(),{revision:1,value:{enabled:true}});
  await edit(path,document=>{document.plugins.configuration.alias.rawEnabled=false;});await platform.configService.reload();
  assert.deepEqual(domain.snapshot(),{revision:2,value:{enabled:false}});
  assert.deepEqual(parse(await readFile(path,'utf8')).plugins.configuration.alias,{rawEnabled:false});
  await edit(path,document=>{document.plugins.configuration.alias.typo=7;});
  await assert.rejects(platform.configService.reload(),{code:'config_invalid'});
  assert.deepEqual(domain.snapshot(),{revision:2,value:{enabled:false}});
  if(false){
    // @ts-expect-error the parsed output key is not an accepted raw editor input key
    void domain.update({enabled:false},2);
    // @ts-expect-error output values retain their actual schema type
    const wrong:string=domain.snapshot().value.enabled;
    void wrong;
  }
});

test('opaque public preprocessors require an explicit non-opaque raw input declaration',async t=>{
  const {platform}=await fixture(t),schema=z.preprocess(value=>value,z.object({enabled:z.boolean()}));
  await assert.rejects(platform.registerDomain({id:'missingRaw',schema,defaultValue:{enabled:false}}),{code:'config_invalid'});
  await assert.rejects(platform.registerDomain({id:'opaqueRaw',schema,rawInputSchema:z.object({enabled:z.preprocess(value=>value,z.boolean())}),defaultValue:{enabled:false}}),{code:'config_invalid'});
  // Ordinary catch/object inputs keep their existing registration behavior.
  const caught=await platform.registerDomain({id:'ordinaryCatch',schema:z.object({enabled:z.boolean()}).catch({enabled:false}),defaultValue:{enabled:false}});
  await caught.update({enabled:true},0);assert.equal(caught.snapshot().value.enabled,true);
});

test('effective hot and restart-only inputs satisfy cross-field invariants before persistence or publication',async t=>{
  const {platform,path}=await fixture(t);
  for(const transformed of [false,true]){
    const id=transformed?'transformedRange':'range';
    const schema:z.ZodTypeAny=transformed
      ?z.object({min:z.string().transform(Number),max:z.string().transform(Number)}).refine(value=>value.min<=value.max).transform(({min,max})=>({floor:min,ceiling:max}))
      :z.object({min:z.number(),max:z.number()}).refine(value=>value.min<=value.max);
    const value=(min:number,max:number)=>transformed?{floor:min,ceiling:max}:{min,max};
    const raw=(n:number)=>transformed?String(n):n,events:unknown[]=[],prepared:unknown[]=[];
    const domain=await platform.registerDomain({id,schema,defaultValue:{min:raw(5),max:raw(10)},fields:[{path:'min',effect:'restart'},{path:'max',effect:'immediate'}],
      prepare(next){prepared.push(next);return {apply(){}};}});
    prepared.length=0;domain.subscribe(snapshot=>events.push(snapshot));
    const revision=domain.snapshot().revision;await domain.update({min:raw(1)},revision);
    assert.deepEqual(domain.snapshot(),{revision:revision+1,value:value(5,10)});
    const before=await readFile(path,'utf8');
    await assert.rejects(domain.update({max:raw(2)},revision+1),{code:'config_invalid'});
    assert.equal(await readFile(path,'utf8'),before,'an invalid effective combination must not reach disk');
    assert.deepEqual(domain.snapshot(),{revision:revision+1,value:value(5,10)});
    assert.deepEqual(events,[]);assert.deepEqual(prepared,[],'invalid effective values never reach runtime prepare');
    await domain.update({max:raw(6)},revision+1);
    assert.deepEqual(domain.snapshot(),{revision:revision+2,value:value(5,6)});
    assert.deepEqual(events,[{revision:revision+2,value:value(5,6)}]);assert.deepEqual(prepared,[value(5,6)]);
    assert.deepEqual(platform.configService.saved(`plugin.${id}`),value(1,6));
  }
});

test('concurrent platform close waits for the actual watcher teardown started by quiescence',async t=>{
  const {platform}=await fixture(t,true);await platform.start();
  const entered=barrier(),finish=barrier(),original=FSWatcher.prototype.close;
  let quiescing:Promise<void>|undefined,closing:Promise<void>|undefined,closed=false;
  FSWatcher.prototype.close=function(){entered.release();return finish.promise.then(()=>original.call(this));};
  try{
    quiescing=platform.quiesce('restart');await entered.promise;
    closing=platform.close();void closing.then(()=>{closed=true;});
    await setImmediate();assert.equal(closed,false,'close must join the earlier in-flight watcher cleanup');
    finish.release();await quiescing;await closing;assert.equal(closed,true);
  }finally{
    finish.release();FSWatcher.prototype.close=original;
    await Promise.allSettled([quiescing,closing]);
  }
});

test('quiescence cancels startup before watcher readiness and releases the acquired watcher',async t=>{
  const {platform}=await fixture(t,true),original=FSWatcher.prototype.close,retired:FSWatcher[]=[];
  FSWatcher.prototype.close=function(){retired.push(this);return original.call(this);};
  try{
    const starting=platform.start().then(()=>({ok:true,error:undefined}),error=>({ok:false,error}));
    await platform.quiesce('restart');
    const result=await starting;assert.equal(result.ok,false,'startup cannot publish a watcher after quiescence');
    assert.equal(result.error.code,'config_unavailable');
    assert.equal(retired.length,1);assert.deepEqual(retired[0].getWatched(),{});
    assert.throws(()=>platform.start(),{code:'config_unavailable'});
  }finally{FSWatcher.prototype.close=original;}
});

test('stop during a pending watcher restart cancels that startup instead of admitting a new watcher',async t=>{
  const {platform}=await fixture(t,true);await platform.start();const service=platform.configService;
  const original=FSWatcher.prototype.close,entered=barrier(),finish=barrier();
  FSWatcher.prototype.close=function(){entered.release();return finish.promise.then(()=>original.call(this));};
  let stopping:Promise<void>|undefined,quiescing:Promise<void>|undefined,starting:Promise<{ok:boolean;error:any}>|undefined;
  try{
    stopping=service.stopWatching();await entered.promise;
    starting=service.startWatching().then(()=>({ok:true,error:undefined}),error=>({ok:false,error}));
    quiescing=platform.quiesce('restart');finish.release();await quiescing;
    const result=await starting;assert.equal(result.ok,false,'a stop requested during teardown fences the waiting startup');
    assert.equal(result.error.code,'config_unavailable');
  }finally{
    finish.release();FSWatcher.prototype.close=original;await Promise.allSettled([stopping,quiescing,starting]);
  }
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
