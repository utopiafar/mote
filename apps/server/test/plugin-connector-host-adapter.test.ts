import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import type {SourceCapabilityDescriptor} from '@mote/shared';
import {PluginResourceScope} from '@mote/plugin-host';
import type {HostScope} from '@mote/plugin-host';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {createDynamicHttpDispatcher} from '../src/plugins/dynamic-http-dispatcher.js';
import {createConnectorHostAdapter,type ConnectorInstanceScope} from '../src/plugins/connector-host-adapter.js';
import type {ConnectorManifest} from '../src/connectors/registry.js';
import type {ConnectorContext} from '../src/connectors/types.js';

const capabilities:SourceCapabilityDescriptor={lifecycle:'one-shot',discovery:'explicit-selection',listening:'none',readOriginal:'none',synchronization:'import-only',externalWrite:false};
type TestScope=ConnectorInstanceScope&{resources:PluginResourceScope};
function instanceScope(name:string):TestScope {
  const resources=new PluginResourceScope(undefined,'generated connector scope disposal failed');
  const scope:HostScope=Object.freeze({
    identity:{packageId:'generated.connector',installationId:'generated-install',instanceId:name,activationId:'generated-'+name,host:{kind:'central' as const,id:'generated-host'}},
    signal:resources.signal,
    assertCurrent:()=>resources.assertCurrent(),
    defer:dispose=>resources.defer(dispose),
    run:work=>resources.run(work),
    every:(ms,work)=>resources.every(ms,work),
    retire:dispose=>resources.retire(dispose),
  });
  return {resources,scope,fence:()=>resources.stop(),close:()=>resources.close()};
}
function manifest(id:string,options:{prefix?:string;statusKey?:string;onClose?:()=>void|Promise<void>;onInit?:()=>void|Promise<void>;kind?:string;stringKind?:boolean;capabilities?:SourceCapabilityDescriptor}={}):ConnectorManifest {
  const kind=options.kind??'generated.connector';
  return {apiVersion:1,id,sourceKinds:[options.stringKind?kind:{kind,capabilities:options.capabilities??capabilities}],...(options.statusKey?{statusKey:options.statusKey}:{}),
    create:()=>({
      ...(options.onInit?{init:options.onInit}:{}),
      status:()=>({id}),
      configure:host=>{
        host.ownerRoute({method:'GET',path:`/api/connectors/${id}`,handler:()=>id});
        host.oauthCallback({path:'/oauth/shared/callback',...(options.prefix?{statePrefix:options.prefix}:{}),complete:async()=>{},successMessage:id,failureMessage:`${id}-fail`});
      },
      close:()=>options.onClose?.(),
    })};
}
async function fixture(t:import('node:test').TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-connector-adapter-')),store=new Store(directory),sources=new SourceStore(store);
  const context:ConnectorContext={sources,store,config:{dataDir:directory,token:'generated-owner-token',allowedOrigins:[],connectors:{directory:join(directory,'connectors')}}};
  const app=Fastify(),dispatcher=createDynamicHttpDispatcher({authorize:request=>request.headers.authorization==='Bearer generated-owner'});
  dispatcher.attach(app);
  t.after(async()=>{await app.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,store,sources,context,app,dispatcher};
}
const headers={authorization:'Bearer generated-owner'};

test('adapter registers routes/OAuth/status through the dispatcher and releases per-instance scopes',async t=>{
  const f=await fixture(t),closed:string[]=[],scopes:TestScope[]=[];
  const statusScope=instanceScope('status');scopes.push(statusScope);
  const adapter=createConnectorHostAdapter({manifests:[manifest('generated-a',{statusKey:'a',onClose:()=>closed.push('a')}),manifest('generated-b',{statusKey:'b',prefix:'b.',stringKind:true,onClose:()=>closed.push('b')})],
    context:f.context,dispatcher:f.dispatcher,statusScope:statusScope.scope,
    scopeFor:m=>{const scope=instanceScope(m.id);scopes.push(scope);return scope;}});
  t.after(async()=>{for(const scope of scopes)await scope.close().catch(()=>{});});
  await adapter.start();
  assert.equal(f.sources.capabilities.has('generated.connector'),true);
  assert.deepEqual(adapter.inventory().map(item=>item.id),['generated-a','generated-b']);
  assert.equal((await f.app.inject({url:'/api/connectors/generated-a',headers})).body,'generated-a');
  assert.deepEqual((await f.app.inject({url:'/api/connectors/status',headers})).json(),{a:{id:'generated-a'},b:{id:'generated-b'}});
  assert.equal((await f.app.inject(`/oauth/shared/callback?state=b.${'a'.repeat(24)}&code=generated-code`)).body,'generated-b');
  assert.equal((await f.app.inject(`/oauth/shared/callback?state=${'a'.repeat(24)}&code=generated-code`)).body,'generated-a');
  await adapter.stop('generated-a');
  assert.equal((await f.app.inject({url:'/api/connectors/generated-a',headers})).statusCode,404);
  assert.equal((await f.app.inject({url:'/api/connectors/generated-b',headers})).body,'generated-b');
  assert.deepEqual((await f.app.inject({url:'/api/connectors/status',headers})).json(),{b:{id:'generated-b'}});
  assert.equal(f.sources.capabilities.has('generated.connector'),true,'the sibling install keeps the capability');
  await adapter.stop('generated-b');
  assert.equal(f.sources.capabilities.has('generated.connector'),false);
  assert.equal((await f.app.inject({url:'/api/connectors/generated-b',headers})).statusCode,404);
  assert.deepEqual((await f.app.inject({url:'/api/connectors/status',headers})).json(),{});
  await adapter.close();
  assert.deepEqual(closed.sort(),['a','b']);
});

test('hot install/restart adds and removes one connector with shared OAuth',async t=>{
  const f=await fixture(t),scopes:TestScope[]=[],statusScope=instanceScope('status');scopes.push(statusScope);
  const adapter=createConnectorHostAdapter({manifests:[manifest('generated-hot-a',{statusKey:'a'})],context:f.context,dispatcher:f.dispatcher,statusScope:statusScope.scope,
    scopeFor:m=>{const scope=instanceScope(m.id);scopes.push(scope);return scope;}});
  t.after(async()=>{for(const scope of scopes)await scope.close().catch(()=>{});});
  await adapter.start();
  await adapter.install(manifest('generated-hot-b',{statusKey:'b',prefix:'hot-b.'}));
  assert.equal((await f.app.inject({url:'/api/connectors/generated-hot-b',headers})).body,'generated-hot-b');
  assert.equal((await f.app.inject(`/oauth/shared/callback?state=hot-b.${'a'.repeat(24)}&code=generated-code`)).body,'generated-hot-b');
  assert.deepEqual((await f.app.inject({url:'/api/connectors/status',headers})).json(),{a:{id:'generated-hot-a'},b:{id:'generated-hot-b'}});
  await adapter.stop('generated-hot-b');
  assert.equal((await f.app.inject({url:'/api/connectors/generated-hot-b',headers})).statusCode,404);
  assert.equal((await f.app.inject({url:'/api/connectors/generated-hot-a',headers})).body,'generated-hot-a');
  await adapter.restart('generated-hot-b');
  assert.equal((await f.app.inject({url:'/api/connectors/generated-hot-b',headers})).body,'generated-hot-b');
  assert.equal((await f.app.inject(`/oauth/shared/callback?state=hot-b.${'a'.repeat(24)}&code=generated-code`)).body,'generated-hot-b');
  await adapter.close();
});

test('hot install init failure rolls back only its instance and siblings serve',async t=>{
  const f=await fixture(t),scopes:TestScope[]=[],statusScope=instanceScope('status');scopes.push(statusScope);
  let releaseInit!:()=>void,enteredInit!:()=>void;
  const held=new Promise<void>(resolve=>{releaseInit=resolve;}),entered=new Promise<void>(resolve=>{enteredInit=resolve;});
  const adapter=createConnectorHostAdapter({manifests:[manifest('generated-hot-ok',{statusKey:'ok'})],context:f.context,dispatcher:f.dispatcher,statusScope:statusScope.scope,
    scopeFor:m=>{const scope=instanceScope(m.id);scopes.push(scope);return scope;}});
  t.after(async()=>{releaseInit();for(const scope of scopes)await scope.close().catch(()=>{});});
  await adapter.start();
  const installing=adapter.install(manifest('generated-hot-init-fail',{statusKey:'fail',prefix:'init.' ,onInit:async()=>{enteredInit();await held;throw new Error('generated init failure');}}));
  await entered;
  assert.equal((await f.app.inject({url:'/api/connectors/generated-hot-ok',headers})).body,'generated-hot-ok');
  releaseInit();
  await assert.rejects(installing,/generated init failure/);
  assert.equal((await f.app.inject({url:'/api/connectors/generated-hot-init-fail',headers})).statusCode,404);
  assert.equal((await f.app.inject({url:'/api/connectors/generated-hot-ok',headers})).body,'generated-hot-ok');
  assert.deepEqual((await f.app.inject({url:'/api/connectors/status',headers})).json(),{ok:{id:'generated-hot-ok'}});
  await adapter.close();
});

test('hot stop close failure removes only that instance and siblings serve',async t=>{
  const f=await fixture(t),scopes:TestScope[]=[],statusScope=instanceScope('status');scopes.push(statusScope);
  const adapter=createConnectorHostAdapter({manifests:[manifest('generated-close-ok',{statusKey:'ok'})],context:f.context,dispatcher:f.dispatcher,statusScope:statusScope.scope,
    scopeFor:m=>{const scope=instanceScope(m.id);scopes.push(scope);return scope;}});
  t.after(async()=>{for(const scope of scopes)await scope.close().catch(()=>{});});
  await adapter.start();
  await adapter.install(manifest('generated-close-fail',{statusKey:'fail',prefix:'close-fail.',onClose:()=>{throw new Error('generated close failure');}}));
  await assert.rejects(adapter.stop('generated-close-fail'),/Connector instance stop failed/);
  assert.equal((await f.app.inject({url:'/api/connectors/generated-close-fail',headers})).statusCode,404);
  assert.equal((await f.app.inject({url:'/api/connectors/generated-close-ok',headers})).body,'generated-close-ok');
  assert.deepEqual((await f.app.inject({url:'/api/connectors/status',headers})).json(),{ok:{id:'generated-close-ok'}});
  await adapter.close();
});

test('hot restart while old scope close is held keeps the replacement route and OAuth',async t=>{
  const f=await fixture(t),scopes:TestScope[]=[],statusScope=instanceScope('status');scopes.push(statusScope);
  let releaseOld!:()=>void,enteredOld!:()=>void,firstClose=true;
  const held=new Promise<void>(resolve=>{releaseOld=resolve;}),started=new Promise<void>(resolve=>{enteredOld=resolve;});
  const adapter=createConnectorHostAdapter({manifests:[manifest('generated-replace',{statusKey:'r',onClose:()=>{if(firstClose){firstClose=false;enteredOld();return held;}}})],context:f.context,dispatcher:f.dispatcher,statusScope:statusScope.scope,
    scopeFor:m=>{const scope=instanceScope(m.id);scopes.push(scope);return scope;}});
  t.after(async()=>{releaseOld();for(const scope of scopes)await scope.close().catch(()=>{});});
  await adapter.start();
  const stopping=adapter.stop('generated-replace');await started;
  await adapter.restart('generated-replace');
  assert.equal((await f.app.inject({url:'/api/connectors/generated-replace',headers})).body,'generated-replace');
  assert.equal((await f.app.inject(`/oauth/shared/callback?state=${'a'.repeat(24)}&code=generated-code`)).body,'generated-replace');
  releaseOld();await stopping;
  assert.equal((await f.app.inject({url:'/api/connectors/generated-replace',headers})).body,'generated-replace','old scope cleanup must not delete the replacement route');
  assert.equal((await f.app.inject(`/oauth/shared/callback?state=${'a'.repeat(24)}&code=generated-code`)).body,'generated-replace','old cleanup must not delete the replacement callback');
  await adapter.close();
});

test('initial start init failure leaves siblings serving',async t=>{
  const f=await fixture(t),scopes:TestScope[]=[],statusScope=instanceScope('status');scopes.push(statusScope);
  const adapter=createConnectorHostAdapter({manifests:[
    manifest('generated-start-ok',{statusKey:'ok'}),
    manifest('generated-start-fail',{statusKey:'fail',prefix:'start-fail.',onInit:async()=>{throw new Error('generated initial init failure');}}),
  ],context:f.context,dispatcher:f.dispatcher,statusScope:statusScope.scope,
    scopeFor:m=>{const scope=instanceScope(m.id);scopes.push(scope);return scope;}});
  t.after(async()=>{for(const scope of scopes)await scope.close().catch(()=>{});});
  await assert.rejects(adapter.start(),/Connector host adapter startup failures/);
  assert.equal((await f.app.inject({url:'/api/connectors/generated-start-ok',headers})).body,'generated-start-ok');
  assert.equal((await f.app.inject({url:'/api/connectors/generated-start-fail',headers})).statusCode,404);
  assert.deepEqual((await f.app.inject({url:'/api/connectors/status',headers})).json(),{ok:{id:'generated-start-ok'}});
  await adapter.close();
});

test('adapter rejects conflicting source capability descriptors before instances start',async t=>{
  const f=await fixture(t),scopes:TestScope[]=[],statusScope=instanceScope('status');scopes.push(statusScope);
  const conflict={...capabilities,synchronization:'revisions' as const};
  const adapter=createConnectorHostAdapter({manifests:[manifest('generated-conflict-a',{kind:'generated.conflict'}),manifest('generated-conflict-b',{kind:'generated.conflict',capabilities:conflict})],
    context:f.context,dispatcher:f.dispatcher,statusScope:statusScope.scope,
    scopeFor:m=>{const scope=instanceScope(m.id);scopes.push(scope);return scope;}});
  t.after(async()=>{for(const scope of scopes)await scope.close().catch(()=>{});});
  await assert.rejects(adapter.start(),/Connector source capability conflict/);
  assert.equal(f.sources.capabilities.has('generated.conflict'),false);
  await adapter.close();
});

test('adapter rejects a descriptor conflicting with a preinstalled capability',async t=>{
  const f=await fixture(t),scopes:TestScope[]=[],statusScope=instanceScope('status');scopes.push(statusScope);
  f.sources.capabilities.register('generated.preinstalled-conflict',capabilities);
  const adapter=createConnectorHostAdapter({manifests:[manifest('generated-pre-conflict',{kind:'generated.preinstalled-conflict',capabilities:{...capabilities,synchronization:'revisions'}})],context:f.context,dispatcher:f.dispatcher,statusScope:statusScope.scope,
    scopeFor:m=>{const scope=instanceScope(m.id);scopes.push(scope);return scope;}});
  t.after(async()=>{for(const scope of scopes)await scope.close().catch(()=>{});});
  await assert.rejects(adapter.start(),/Connector source capability conflict/);
  assert.equal(f.sources.capabilities.has('generated.preinstalled-conflict'),true,'the externally owned capability remains');
  await adapter.close();
});

test('adapter never unregisters a preinstalled capability it did not create',async t=>{
  const f=await fixture(t),scopes:TestScope[]=[],statusScope=instanceScope('status');scopes.push(statusScope);
  f.sources.capabilities.register('generated.preinstalled',capabilities);
  const adapter=createConnectorHostAdapter({manifests:[manifest('generated-pre',{kind:'generated.preinstalled'})],context:f.context,dispatcher:f.dispatcher,statusScope:statusScope.scope,
    scopeFor:m=>{const scope=instanceScope(m.id);scopes.push(scope);return scope;}});
  t.after(async()=>{for(const scope of scopes)await scope.close().catch(()=>{});});
  await adapter.start();await adapter.stop('generated-pre');await adapter.close();
  assert.equal(f.sources.capabilities.has('generated.preinstalled'),true);
});

test('stop fences admission before awaiting connector shutdown',async t=>{
  const f=await fixture(t),scopes:TestScope[]=[],statusScope=instanceScope('status');scopes.push(statusScope);
  const order:string[]=[];let fenced=false;
  const adapter=createConnectorHostAdapter({manifests:[manifest('generated-fence',{onClose:()=>{order.push('close');assert.equal(fenced,true);}})],context:f.context,dispatcher:f.dispatcher,statusScope:statusScope.scope,
    scopeFor:m=>{const scope=instanceScope(m.id),fence=scope.fence!;scope.fence=()=>{fenced=true;order.push('fence');return fence();};scopes.push(scope);return scope;}});
  t.after(async()=>{for(const scope of scopes)await scope.close().catch(()=>{});});
  await adapter.start();await adapter.stop('generated-fence');await adapter.close();
  assert.deepEqual(order,['fence','close']);
});

test('stop rejects new admission while connector shutdown is pending and keeps siblings',async t=>{
  const f=await fixture(t),scopes:TestScope[]=[],statusScope=instanceScope('status');scopes.push(statusScope);
  let releaseClose!:()=>void,enteredClose!:()=>void;
  const held=new Promise<void>(resolve=>{releaseClose=resolve;}),started=new Promise<void>(resolve=>{enteredClose=resolve;});
  const adapter=createConnectorHostAdapter({manifests:[
    manifest('generated-pending-a',{onClose:async()=>{enteredClose();await held;}}),
    manifest('generated-pending-b',{prefix:'pending-b.'}),
  ],context:f.context,dispatcher:f.dispatcher,statusScope:statusScope.scope,
    scopeFor:m=>{const scope=instanceScope(m.id);scopes.push(scope);return scope;}});
  t.after(async()=>{releaseClose();for(const scope of scopes)await scope.close().catch(()=>{});});
  await adapter.start();
  const stopping=adapter.stop('generated-pending-a');await started;
  const aScope=scopes.find(scope=>scope.scope.identity.instanceId==='generated-pending-a')!;
  assert.equal(aScope.scope.signal.aborted,true,'scope cancellation starts before connector teardown');
  assert.ok([404,503].includes((await f.app.inject({url:'/api/connectors/generated-pending-a',headers})).statusCode),'owner route admission is fenced while connector close is pending');
  assert.ok([400,404].includes((await f.app.inject(`/oauth/shared/callback?state=${'a'.repeat(24)}&code=generated-code`)).statusCode),'OAuth admission is fenced while connector close is pending');
  assert.equal((await f.app.inject({url:'/api/connectors/generated-pending-b',headers})).body,'generated-pending-b');
  releaseClose();await stopping;
  assert.equal((await f.app.inject({url:'/api/connectors/generated-pending-a',headers})).statusCode,404);
  assert.equal((await f.app.inject({url:'/api/connectors/generated-pending-b',headers})).body,'generated-pending-b');
  await adapter.close();
});

test('close during a pending connector create disposes the late instance without init',async t=>{
  const f=await fixture(t),scopes:TestScope[]=[],statusScope=instanceScope('status');scopes.push(statusScope);
  let resolveCreate!:()=>void,enteredCreate!:()=>void,releaseLate!:()=>void;
  const held=new Promise<void>(resolve=>{resolveCreate=resolve;}),entered=new Promise<void>(resolve=>{enteredCreate=resolve;}),lateClose=new Promise<void>(resolve=>{releaseLate=resolve;});
  let initialized=0,closed=0;
  const late:ConnectorManifest={apiVersion:1,id:'generated-late',sourceKinds:[{kind:'generated.late',capabilities}],create:async()=>{enteredCreate();await held;return {init:()=>{initialized++;},close:()=>{closed++;return lateClose;}};}};
  const adapter=createConnectorHostAdapter({manifests:[late],context:f.context,dispatcher:f.dispatcher,statusScope:statusScope.scope,
    scopeFor:m=>{const scope=instanceScope(m.id);scopes.push(scope);return scope;}});
  t.after(async()=>{releaseLate();resolveCreate();for(const scope of scopes)await scope.close().catch(()=>{});});
  const starting=adapter.start();await entered;
  const startResult=starting.then(()=>({error:undefined}),error=>({error}));
  const closing=adapter.close();let closeSettled=false;void closing.then(()=>{closeSettled=true;},()=>{closeSettled=true;});
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(closeSettled,false,'close joins the pending factory');
  resolveCreate();
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(closeSettled,false,'close joins the held late instance cleanup');
  releaseLate();
  await closing;
  assert.ok((await startResult).error,'start rejects after the closed registry');
  assert.equal(initialized,0,'a late instance must not initialize after close');
  assert.equal(closed,1,'the late instance is disposed and awaited by close');
});

test('teardown rejection during pending init is handled and aggregated',async t=>{
  const f=await fixture(t),scopes:TestScope[]=[],statusScope=instanceScope('status');scopes.push(statusScope);
  let resolveInit!:()=>void,enteredInit!:()=>void;
  const held=new Promise<void>(resolve=>{resolveInit=resolve;}),entered=new Promise<void>(resolve=>{enteredInit=resolve;});
  let initCalls=0;
  const initializing:ConnectorManifest={apiVersion:1,id:'generated-init-cleanup',sourceKinds:[{kind:'generated.init-cleanup',capabilities}],create:()=>({init:async()=>{initCalls++;enteredInit();await held;},close:()=>{}})};
  const adapter=createConnectorHostAdapter({manifests:[initializing],context:f.context,dispatcher:f.dispatcher,statusScope:statusScope.scope,
    scopeFor:m=>{const scope=instanceScope(m.id);scopes.push(scope);return scope;}});
  t.after(async()=>{resolveInit();for(const scope of scopes)await scope.close().catch(()=>{});});
  const starting=adapter.start();await entered;
  const startResult=starting.then(()=>({error:undefined}),error=>({error}));
  scopes.find(scope=>scope.scope.identity.instanceId==='generated-init-cleanup')!.resources.defer(()=>{throw new Error('generated cleanup failure');});
  const closing=adapter.close();const closingResult=closing.then(()=>({error:undefined}),error=>({error}));
  await new Promise<void>(resolve=>setImmediate(resolve));
  resolveInit();
  const result=await closingResult;
  assert.ok(result.error instanceof AggregateError,'teardown failure is aggregated');
  assert.ok((await startResult).error,'startup still rejects after init');
  assert.equal(initCalls,1);
});

test('an early close-only scope rejection is handled and aggregated',async t=>{
  const f=await fixture(t),scopes:TestScope[]=[],statusScope=instanceScope('status');scopes.push(statusScope);
  let releaseClose!:()=>void,enteredClose!:()=>void;
  const held=new Promise<void>(resolve=>{releaseClose=resolve;}),started=new Promise<void>(resolve=>{enteredClose=resolve;});
  const noFence=instanceScope('generated-unhandled');delete (noFence as {fence?:unknown}).fence;scopes.push(noFence);
  const adapter=createConnectorHostAdapter({manifests:[manifest('generated-unhandled',{onClose:async()=>{enteredClose();await held;}})],context:f.context,dispatcher:f.dispatcher,statusScope:statusScope.scope,
    scopeFor:()=>noFence});
  t.after(async()=>{releaseClose();for(const scope of scopes)await scope.close().catch(()=>{});});
  await adapter.start();
  noFence.resources.defer(()=>{throw new Error('generated cleanup failure');});
  const closing=adapter.close();await started;
  await new Promise<void>(resolve=>setImmediate(resolve));
  releaseClose();
  await assert.rejects(closing,/Connector host adapter disposal failed/);
});

test('close during connector init closes the instance only once',async t=>{
  const f=await fixture(t),scopes:TestScope[]=[],statusScope=instanceScope('status');scopes.push(statusScope);
  let resolveInit!:()=>void,enteredInit!:()=>void;
  const held=new Promise<void>(resolve=>{resolveInit=resolve;}),entered=new Promise<void>(resolve=>{enteredInit=resolve;});
  let initCalls=0,closeCalls=0;
  const initializing:ConnectorManifest={apiVersion:1,id:'generated-init',sourceKinds:[{kind:'generated.init',capabilities}],create:()=>({init:async()=>{initCalls++;enteredInit();await held;},close:()=>{closeCalls++;}})};
  const adapter=createConnectorHostAdapter({manifests:[initializing],context:f.context,dispatcher:f.dispatcher,statusScope:statusScope.scope,
    scopeFor:m=>{const scope=instanceScope(m.id);scopes.push(scope);return scope;}});
  t.after(async()=>{resolveInit();for(const scope of scopes)await scope.close().catch(()=>{});});
  const starting=adapter.start();await entered;
  const startResult=starting.then(()=>({error:undefined}),error=>({error}));
  const closing=adapter.close();let closeSettled=false;void closing.then(()=>{closeSettled=true;},()=>{closeSettled=true;});
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(closeSettled,false,'close joins the pending init');
  resolveInit();await closing;
  assert.ok((await startResult).error,'start rejects after the closed registry');
  assert.equal(initCalls,1);assert.equal(closeCalls,1,'registry owns the single shutdown');
});

test('adapter close fences every instance before connector shutdown',async t=>{
  const f=await fixture(t),scopes:TestScope[]=[],statusScope=instanceScope('status');scopes.push(statusScope);
  const order:string[]=[];let fenced=false;
  const adapter=createConnectorHostAdapter({manifests:[manifest('generated-close-fence',{onClose:()=>{order.push('close');assert.equal(fenced,true);}})],context:f.context,dispatcher:f.dispatcher,statusScope:statusScope.scope,
    scopeFor:m=>{const scope=instanceScope(m.id),fence=scope.fence!;scope.fence=()=>{fenced=true;order.push('fence');return fence();};scopes.push(scope);return scope;}});
  t.after(async()=>{for(const scope of scopes)await scope.close().catch(()=>{});});
  await adapter.start();await adapter.close();
  assert.deepEqual(order,['fence','close']);
});

test('adapter startup installs capability once and close is idempotent',async t=>{
  const f=await fixture(t),closed:string[]=[],scopes:TestScope[]=[];
  const statusScope=instanceScope('status');scopes.push(statusScope);
  const adapter=createConnectorHostAdapter({manifests:[manifest('generated-c',{statusKey:'c',onClose:()=>closed.push('c')})],context:f.context,dispatcher:f.dispatcher,statusScope:statusScope.scope,
    scopeFor:m=>{const scope=instanceScope(m.id);scopes.push(scope);return scope;}});
  t.after(async()=>{for(const scope of scopes)await scope.close().catch(()=>{});});
  await adapter.start();
  await adapter.close();await adapter.close();
  assert.equal((await f.app.inject({url:'/api/connectors/generated-c',headers})).statusCode,404);
  assert.equal((await f.app.inject({url:'/api/connectors/status',headers})).statusCode,404,'status registration is released even while its shared scope stays open');
  const replacement=createConnectorHostAdapter({manifests:[manifest('generated-c',{statusKey:'c',onClose:()=>closed.push('c')})],context:f.context,dispatcher:f.dispatcher,statusScope:statusScope.scope,
    scopeFor:m=>{const scope=instanceScope(m.id);scopes.push(scope);return scope;}});
  await replacement.start();
  assert.deepEqual((await f.app.inject({url:'/api/connectors/status',headers})).json(),{c:{id:'generated-c'}});
  await replacement.close();await statusScope.close();
  assert.equal((await f.app.inject({url:'/api/connectors/status',headers})).statusCode,404);
  assert.deepEqual(closed,['c','c']);
  assert.equal(f.sources.capabilities.has('generated.connector'),false);
});
