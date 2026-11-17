import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import Fastify from 'fastify';
import {PluginHost,type HostPluginContext} from '@mote/plugin-host';
import {serviceContract,type ServiceBinding} from '@mote/plugin-api/contracts';
import {createDomainActivations,type CentralDomainPlugin} from '../src/domain-activation.js';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {FeatureScope} from '../src/features/index.js';
import {insightServiceInputs} from '../src/insight-service-inputs.js';
import {insightServicesPlugin,insightServicesInputsContribution,insightServicesInputsDeclaration,insightServicesInputsContract,insightServicesContract,type InsightServicesDependencies} from '../src/plugins/insight-services.js';

const lifecycle={prepare(){},start(){},quiesce(){},stop(){},dispose(){}};
const contains=(error:unknown,expected:unknown):boolean=>error===expected||error instanceof AggregateError&&error.errors.some(value=>contains(value,expected));
function declaration(id:string,create:NonNullable<CentralDomainPlugin['activation']>['create'],requires:NonNullable<CentralDomainPlugin['activation']>['requires']={}):CentralDomainPlugin{
  return {contribution:{id,version:'1.0.0',surface:'data',runtime:'host'},declaration:{id,apiVersion:'1'},replacement:'restart',activation:{featureId:'mote.'+id,requires,create}};
}

test('early installation and the final pass share one real provider, consumer and disposal barrier',async t=>{
  const host=new PluginHost({kind:'central',id:randomUUID()});t.after(()=>host.close());
  const contract=serviceContract<{read():string}>('generated.early-provider','1'),events:string[]=[];
  let same:Promise<void>|undefined,registry:ReturnType<typeof createDomainActivations>;
  const provider=declaration('early-provider',context=>{
    events.push('provider:create');same=registry.installDomain('early-provider');
    context.scope.defer(()=>{events.push('provider:release');});
    return {...lifecycle,start(){events.push('provider:start');context.provide('early-provider',contract,{read:()=> 'generated live provider'});},dispose(){events.push('provider:dispose');},route:{id:'mote.early-provider',mount(){}}};
  });
  const consumer=declaration('early-consumer',async(context,bindings)=>{
    events.push('consumer:create');const lease=await context.services.acquire(contract,bindings.input!);
    context.scope.defer(()=>lease.release());
    return {...lifecycle,start(){assert.equal(lease.value.read(),'generated live provider');events.push('consumer:start');},dispose(){events.push('consumer:dispose');},route:{id:'mote.early-consumer',mount(){}}};
  },{input:{provider:'early-provider',service:contract}});
  registry=createDomainActivations(host,[provider,consumer],['mote.early-provider','mote.early-consumer']);
  assert.equal(registry.selectedDomain('early-provider'),provider);
  assert.equal(registry.selectedDomain('missing'),undefined);
  const first=registry.installDomain('early-provider');
  assert.equal(registry.installDomain('early-provider'),first);
  // The consumer is requested while its provider is still installing. The
  // fixed request order, not an implicit provider search, makes its pin ready.
  const second=registry.installDomain('early-consumer');
  const all=registry.activate();assert.equal(registry.activate(),all);
  await Promise.all([first,second]);assert.equal(same,first,'publish the install result before invoking the factory');
  const domains=await all;
  assert.deepEqual(events,['provider:create','provider:start','consumer:create','consumer:start']);
  assert.deepEqual(domains.routes.map(route=>route.id),['mote.early-provider','mote.early-consumer']);
  assert.equal(host.snapshot().contributions.length,2);
  const closing=domains.close();assert.equal(domains.close(),closing);assert.equal(domains.quiesce(),closing);await closing;
  assert.deepEqual(events.slice(4),['consumer:dispose','provider:dispose','provider:release']);
  assert.equal(host.snapshot().contributions.length,0);
  await assert.rejects(registry.installDomain('early-consumer'),{code:'stale_scope'});
});

test('a missing live dependency cannot be satisfied by a selected descriptor and cannot start queued owners',async t=>{
  const host=new PluginHost({kind:'central',id:randomUUID()});t.after(()=>host.close());
  const contract=serviceContract<{read():void}>('generated.unpublished','1');let consumerCreates=0,laterCreates=0,released=0;
  const earlier=declaration('earlier',context=>{context.scope.defer(()=>{released++;});return {...lifecycle,route:{id:'mote.earlier',mount(){}}};});
  const provider:CentralDomainPlugin={contribution:{id:'unpublished',version:'1.0.0',surface:'data',runtime:'host'},declaration:{id:'unpublished',apiVersion:'1'},replacement:'restart'};
  const consumer=declaration('unbound',()=>{consumerCreates++;throw Error('An unbound consumer must not construct resources');},{input:{provider:'unpublished',service:contract}});
  const later=declaration('later',()=>{laterCreates++;return {...lifecycle,route:{id:'mote.later',mount(){}}};});
  const registry=createDomainActivations(host,[earlier,provider,consumer,later],['mote.earlier','mote.unbound','mote.later']);
  await registry.installDomain('earlier');
  const failed=registry.installDomain('unbound'),queued=registry.installDomain('later');
  await Promise.all([assert.rejects(failed,{code:'dependency_unavailable'}),assert.rejects(queued,{code:'dependency_unavailable'})]);
  assert.deepEqual({consumerCreates,laterCreates,released},{consumerCreates:0,laterCreates:0,released:1});
  assert.equal(host.snapshot().contributions.length,0,'failure also closes owners installed before the final pass');
  await assert.rejects(registry.activate(),{code:'dependency_unavailable'});
});

test('an early start failure preserves the cause and genuine cleanup failure without reopening the factory',async t=>{
  const host=new PluginHost({kind:'central',id:randomUUID()});t.after(()=>host.close());
  const primary=Error('generated early start failure'),cleanup=Error('generated earlier disposal failure');let creates=0,releases=0;
  const earlier=declaration('cleanup-failure',context=>{
    context.scope.defer(()=>{releases++;});return {...lifecycle,dispose(){throw cleanup;},route:{id:'mote.cleanup-failure',mount(){}}};
  });
  const failed=declaration('start-failure',context=>{
    creates++;context.scope.defer(()=>{releases++;});return {...lifecycle,start(){throw primary;},route:{id:'mote.start-failure',mount(){}}};
  });
  const registry=createDomainActivations(host,[earlier,failed],['mote.cleanup-failure','mote.start-failure']);
  await registry.installDomain('cleanup-failure');
  const result=registry.installDomain('start-failure');
  await assert.rejects(result,error=>contains(error,primary)&&contains(error,cleanup));
  await assert.rejects(registry.activate(),error=>contains(error,primary)&&contains(error,cleanup));
  await assert.rejects(registry.installDomain('cleanup-failure'),error=>contains(error,primary)&&contains(error,cleanup),'an earlier successful install is no longer usable after startup rollback');
  assert.deepEqual({creates,releases},{creates:1,releases:2});
  assert.equal(host.snapshot().contributions.length,0);
});

test('repeated installation and the final pass join cleanup of a failed early startup',{timeout:15000},async t=>{
  const host=new PluginHost({kind:'central',id:randomUUID()}),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  t.after(async()=>{release.resolve();await host.close();});
  const primary=Error('generated early startup failure during drain');
  const earlier=declaration('draining-owner',()=>({...lifecycle,async dispose(){entered.resolve();await release.promise;},route:{id:'mote.draining-owner',mount(){}}}));
  const failing=declaration('failing-owner',()=>({...lifecycle,start(){throw primary;},route:{id:'mote.failing-owner',mount(){}}}));
  const registry=createDomainActivations(host,[earlier,failing],['mote.draining-owner','mote.failing-owner']);
  await registry.installDomain('draining-owner');
  const pending=registry.installDomain('failing-owner'),rejected=assert.rejects(pending,error=>error===primary);
  await entered.promise;
  const repeated=registry.installDomain('failing-owner');void repeated.catch(()=>{});
  const final=registry.activate();let settled=false;
  const finalRejected=assert.rejects(final,error=>error===primary).then(()=>{settled=true;});
  await setImmediate();
  assert.equal(settled,false,'startup cannot finish while an earlier accepted owner is still disposing');
  assert.equal(repeated,pending,'repeat callers must join the real cleanup result');
  release.resolve();await Promise.all([rejected,finalRejected]);
  assert.equal(host.snapshot().contributions.length,0);
});

async function insightFixture(t:test.TestContext,selection:'selected'|'feature-omitted'|'plugin-omitted'='selected',failStart?:Error){
  const directory=await mkdtemp(join(tmpdir(),'mote-domain-install-insights-')),store=new Store(directory),sources=new SourceStore(store),reader=new EvidenceReader(store,sources),executor=new ExecutionEngine(store);
  const host=new PluginHost({kind:'central',id:randomUUID()}),app=Fastify();
  t.after(async()=>{await app.close();await host.close();await executor.close();reader.dispose();store.close();await rm(directory,{recursive:true,force:true});});
  const counts={opens:0,registered:0,released:0,timers:0,cleared:0,queries:0,authorized:0};
  const register=executor.register.bind(executor);
  t.mock.method(executor,'register',(...args:Parameters<ExecutionEngine['register']>)=>{
    counts.registered++;const release=register(...args);return async()=>{counts.released++;await release();};
  });
  const interval=globalThis.setInterval.bind(globalThis),clear=globalThis.clearInterval.bind(globalThis),timers=new Set<ReturnType<typeof setInterval>>();
  t.mock.method(globalThis,'setInterval',((...args:Parameters<typeof setInterval>)=>{const timer=Reflect.apply(interval,globalThis,args);timers.add(timer);counts.timers++;return timer;}) as typeof setInterval);
  t.mock.method(globalThis,'clearInterval',((timer:ReturnType<typeof setInterval>)=>{if(timers.delete(timer))counts.cleared++;clear(timer);}) as typeof clearInterval);
  const dependencies={
    store,executor,evidenceReader:reader,
    query:async(_scope,_observe,_signal,snapshot)=>{counts.queries++;return {runId:randomUUID(),answer:'Generated selected Insights report',citations:[],trace:[],...(snapshot?{snapshot}:{})};},
    modelAuthorization:{manual:async(_id,_connections,task)=>{counts.authorized++;return task(new AbortController().signal);}} as InsightServicesDependencies['modelAuthorization'],
    availableModelConnections:()=>[],agent:{configuredFor:()=>true},
    modelSettings:{select:()=>({id:'generated-profile',name:'Generated',settings:{}})} as unknown as InsightServicesDependencies['modelSettings'],
    isClosing:()=>false,diagnostics:{run:(_id,task)=>task()},
  } satisfies Parameters<typeof insightServiceInputs>[0];
  const inputs:CentralDomainPlugin={contribution:insightServicesInputsContribution,declaration:insightServicesInputsDeclaration,replacement:'restart'};
  const consumer=failStart?{...insightServicesPlugin,activation:{...insightServicesPlugin.activation!,async create(context:HostPluginContext,bindings:Readonly<Record<string,ServiceBinding>>){
    const service=await insightServicesPlugin.activation!.create(context,bindings);
    return {...service,async start(){await service.start();throw failStart;}};
  }}}:insightServicesPlugin;
  const plugins=selection==='plugin-omitted'?[inputs]:[inputs,consumer],features=selection==='feature-omitted'?[]:['mote.insights'];
  const registry=createDomainActivations(host,plugins,features);
  let inputBinding:ServiceBinding|undefined;
  // This is the real private adapter and publication ABI; constructing the
  // adapter does not acquire the manager or its run handler.
  if(registry.selectedDomain('insight-services'))await host.install({
    identity:{host:host.identity,packageId:inputs.contribution.id,installationId:'build:insight-services-inputs@1.0.0',instanceId:'inputs',activationId:randomUUID()},contributions:[inputs.declaration],restartRequired:true,
    factory(context){const value=insightServiceInputs(dependencies),open=value.openRuns;
      inputBinding=context.provide(inputs.contribution.id,insightServicesInputsContract,{...value,openRuns(){counts.opens++;return open();}});
      registry.register(inputBinding);return lifecycle;
    },
  });
  return {store,host,app,registry,counts,inputBinding,plugins,features};
}

async function completed(read:()=>boolean){
  for(let attempt=0;attempt<500;attempt++){if(read())return;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.fail('Generated real Insights run did not complete');
}

test('the original Insights input factory installs early, publishes one real HTTP report and fences its saved leases',async t=>{
  const f=await insightFixture(t);
  assert.equal(f.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='insight_runs'").get(),undefined);
  assert.deepEqual(f.counts,{opens:0,registered:0,released:0,timers:0,cleared:0,queries:0,authorized:0});
  const install=f.registry.installDomain('insight-services');assert.equal(f.registry.installDomain('insight-services'),install);await install;
  const domains=await f.registry.activate();
  assert.equal(f.counts.opens,1);assert.equal(f.counts.registered,1);assert.equal(domains.routes.length,1);
  const scope=new FeatureScope();t.after(()=>scope.close());
  for(const route of domains.routes)route.mount(f.app,scope);
  const input=await f.host.acquire(insightServicesInputsContract,f.inputBinding!),savedRead=input.value.readHistory;
  await input.release();assert.throws(()=>savedRead({}),{code:'stale_scope'});
  const service=await f.registry.acquire('insight-services',insightServicesContract),savedClose=service.value.close;
  t.after(()=>service.release());
  const id=randomUUID(),payload={requestId:id};
  assert.equal((await f.app.inject({method:'POST',url:'/api/insight-runs',payload})).statusCode,202);
  await completed(()=>service.value.runs.get(id).status==='completed');
  assert.equal((await f.app.inject({url:'/api/insight-runs/'+id})).json().result.answer,'Generated selected Insights report');
  assert.equal((await f.app.inject({method:'POST',url:'/api/insight-runs',payload})).statusCode,202);
  assert.equal(f.counts.queries,1);assert.equal(f.store.insights().items.length,1);assert.ok(f.counts.timers>0,'the real manager started its heartbeat');
  await domains.close();
  assert.equal((await f.app.inject({url:'/api/insight-runs'})).statusCode,503);
  assert.throws(()=>savedClose(),{code:'dependency_unavailable'},'the provider is gone, while the individually released input lease above is stale');
  assert.equal(f.counts.released,1);assert.equal(f.counts.cleared,f.counts.timers);
  assert.equal(f.store.insights().items.length,1,'domain removal retains the original published result');
});

test('omitting the Insights feature or plugin creates no input, exclusive table, run handler or timer',async t=>{
  for(const selection of ['feature-omitted','plugin-omitted'] as const)await t.test(selection,async t=>{
    const f=await insightFixture(t,selection);
    assert.equal(f.registry.selectedDomain('insight-services'),undefined);
    await assert.rejects(f.registry.installDomain('insight-services'),{code:'dependency_unavailable'});
    const domains=await f.registry.activate();assert.deepEqual(domains.routes,[]);
    assert.equal(f.inputBinding,undefined);assert.equal(f.host.snapshot().contributions.length,0);
    assert.equal(f.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='insight_runs'").get(),undefined);
    assert.deepEqual(f.counts,{opens:0,registered:0,released:0,timers:0,cleared:0,queries:0,authorized:0});
    const id=randomUUID();await f.store.ingest({id,deviceId:'generated-shared-owner',deviceName:'Generated',platform:'macos',source:'note',capturedAt:'2026-11-17T00:00:00.000Z',durationMs:0,ocrText:'Generated original remains writable'});
    assert.equal(f.store.evidence([id]).length,1);await domains.close();
  });
});

test('a real Insights start failure releases its handler and the same profile opens through a fresh selected plan',async t=>{
  const primary=Error('generated failure after real Insights start'),f=await insightFixture(t,'selected',primary);
  await assert.rejects(f.registry.installDomain('insight-services'),error=>error===primary);
  assert.equal(f.counts.opens,1);assert.equal(f.counts.registered,1);assert.equal(f.counts.released,1);
  assert.equal(f.host.snapshot().contributions.filter(value=>value.identity.contributionId==='insight-services').length,0);
  const reopened=createDomainActivations(f.host,[f.plugins[0]!,insightServicesPlugin],f.features);reopened.register(f.inputBinding!);
  await reopened.installDomain('insight-services');const domains=await reopened.activate();
  assert.equal(f.counts.opens,2);assert.equal(f.counts.registered,2);
  const scope=new FeatureScope();t.after(()=>scope.close());
  for(const route of domains.routes)route.mount(f.app,scope);
  assert.equal((await f.app.inject({url:'/api/insight-runs'})).statusCode,200);
  await domains.close();assert.equal(f.counts.released,2);
});
