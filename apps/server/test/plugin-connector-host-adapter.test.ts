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
  return {resources,scope,close:()=>resources.close()};
}
function manifest(id:string,options:{prefix?:string;statusKey?:string;onClose?:()=>void;kind?:string;stringKind?:boolean}={}):ConnectorManifest {
  const kind=options.kind??'generated.connector';
  return {apiVersion:1,id,sourceKinds:[options.stringKind?kind:{kind,capabilities}],...(options.statusKey?{statusKey:options.statusKey}:{}),
    create:()=>({
      status:()=>({id}),
      configure:host=>{
        host.ownerRoute({method:'GET',path:`/api/connectors/${id}`,handler:()=>id});
        host.oauthCallback({path:'/oauth/shared/callback',...(options.prefix?{statePrefix:options.prefix}:{}),complete:async()=>{},successMessage:id,failureMessage:`${id}-fail`});
      },
      close:()=>{options.onClose?.();},
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

test('adapter never unregisters a preinstalled capability it did not create',async t=>{
  const f=await fixture(t),scopes:TestScope[]=[],statusScope=instanceScope('status');scopes.push(statusScope);
  f.sources.capabilities.register('generated.preinstalled',capabilities);
  const adapter=createConnectorHostAdapter({manifests:[manifest('generated-pre',{kind:'generated.preinstalled'})],context:f.context,dispatcher:f.dispatcher,statusScope:statusScope.scope,
    scopeFor:m=>{const scope=instanceScope(m.id);scopes.push(scope);return scope;}});
  t.after(async()=>{for(const scope of scopes)await scope.close().catch(()=>{});});
  await adapter.start();await adapter.stop('generated-pre');await adapter.close();
  assert.equal(f.sources.capabilities.has('generated.preinstalled'),true);
});

test('adapter startup installs capability once and close is idempotent',async t=>{
  const f=await fixture(t),closed:string[]=[],scopes:TestScope[]=[];
  const statusScope=instanceScope('status');scopes.push(statusScope);
  const adapter=createConnectorHostAdapter({manifests:[manifest('generated-c',{statusKey:'c',onClose:()=>closed.push('c')})],context:f.context,dispatcher:f.dispatcher,statusScope:statusScope.scope,
    scopeFor:m=>{const scope=instanceScope(m.id);scopes.push(scope);return scope;}});
  t.after(async()=>{for(const scope of scopes)await scope.close().catch(()=>{});});
  await adapter.start();
  await adapter.close();await adapter.close();await statusScope.close();
  assert.deepEqual(closed,['c']);
  assert.equal(f.sources.capabilities.has('generated.connector'),false);
  assert.equal((await f.app.inject({url:'/api/connectors/generated-c',headers})).statusCode,404);
  assert.equal((await f.app.inject({url:'/api/connectors/status',headers})).statusCode,404);
});
