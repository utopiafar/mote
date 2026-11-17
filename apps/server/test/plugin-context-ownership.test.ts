import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import type {HostScope} from '@mote/plugin-host';
import type {StateStore} from '@mote/plugin-api';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {ConnectorManifest} from '../src/connectors/registry.js';

const token='generated-context-owner',headers={authorization:'Bearer '+token};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const contains=(error:unknown,wanted:unknown):boolean=>error===wanted||error instanceof AggregateError&&error.errors.some(child=>contains(child,wanted));
async function bounded<T>(promise:Promise<T>):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Generated ownership event did not arrive')),5000);})]);}
  finally{clearTimeout(timer);}
}
function config(dataDir:string):Config{
  return {dataDir,token,tokenPath:'generated-fixture',host:'127.0.0.1',port:0,maxExportBytes:1_000_000,insightIntervalHours:0,
    allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',
    connectors:{directory:join(dataDir,'connectors'),mcpEnabled:false,mcpReadToken:'',mcpWriteEnabled:false,mcpWriteToken:'',mcpWriteSourceIds:[],
      googleClientId:'',googleClientSecret:'',googleRedirectUri:'',syncIntervalMs:900_000,allowLocalMcp:false}};
}
interface Activation {
  id:string;scope:HostScope;state:StateStore;child:Context;ticks:number;closed:number;released:number;childClosed:number;launches:number;
  started:ReturnType<typeof deferred>;held:ReturnType<typeof deferred>;release:ReturnType<typeof deferred>;
  nextTick?:ReturnType<typeof deferred>;lateError?:unknown;
}
async function fixture(t:TestContext){
  const directory=await mkdtemp(join(tmpdir(),'mote-context-ownership-')),activations:Activation[]=[],timers=new Map<ReturnType<typeof setInterval>,Activation>();
  const originalSetInterval=globalThis.setInterval,originalClearInterval=globalThis.clearInterval;
  let recording:Activation|undefined,node:Awaited<ReturnType<typeof buildApp>>|undefined;
  // Count real timers belonging to the generated connectors. No clock is faked.
  globalThis.setInterval=((...args:Parameters<typeof setInterval>)=>{
    const handle=originalSetInterval(...args);if(recording)timers.set(handle,recording);return handle;
  }) as typeof setInterval;
  globalThis.clearInterval=((handle:ReturnType<typeof setInterval>)=>{timers.delete(handle);originalClearInterval(handle);}) as typeof clearInterval;
  t.after(async()=>{
    for(const value of activations)value.release.resolve();
    try{await node?.app.close();}
    finally{globalThis.setInterval=originalSetInterval;globalThis.clearInterval=originalClearInterval;await rm(directory,{recursive:true,force:true});}
  });
  const manifest=(id:string,fail?:()=>unknown):ConnectorManifest=>({apiVersion:1,id,sourceKinds:[],
    async create(context,scope){
      const state=context.state!,prior=await state.get('launches');
      const launches=Number(prior?.value??0)+1;await state.compareAndSet('launches',prior?.revision??null,launches);
      const child=scope.cordis.plugin(()=>{});
      await child;
      const value:Activation={id,scope,state,child:child.ctx,ticks:0,closed:0,released:0,childClosed:0,launches,started:deferred(),held:deferred(),release:deferred()};
      activations.push(value);
      child.ctx.effect(()=>()=>{value.childClosed++;});
      scope.defer(()=>{value.released++;});
      recording=value;
      try{scope.every(5,()=>{value.ticks++;value.started.resolve();value.nextTick?.resolve();});}
      finally{recording=undefined;}
      return {
        configure(host){
          host.ownerRoute({method:'GET',path:`/api/connectors/${id}`,handler:()=>({id,launches})});
          host.ownerRoute({method:'GET',path:`/api/connectors/${id}/held`,async handler(){
            value.held.resolve();await value.release.promise;
            try{await state.compareAndSet('late',null,'generated-late-publication');}
            catch(error){value.lateError=error;throw error;}
            return {published:true};
          }});
          const failure=fail?.();if(failure)throw failure;
        },
        close(){value.closed++;},
      };
    },
  });
  return {
    directory,activations,manifest,timers,
    activeTimers:(value:Activation)=>[...timers.values()].filter(owner=>owner===value).length,
    async open(manifests:ConnectorManifest[]){node=await buildApp(config(directory),{backgroundWorker:false,connectorManifests:manifests});return node;},
  };
}

test('real connector scopes share the bootstrap root, stop independently and reject late publication across hot restart',async t=>{
  const f=await fixture(t),node=await f.open([f.manifest('generated-owner-a'),f.manifest('generated-owner-b')]);
  await node.app.listen({host:'127.0.0.1',port:0});
  const address=node.app.server.address() as {port:number},url='http://127.0.0.1:'+address.port;
  const request=async(path:string)=>{const response=await fetch(url+path,{headers});return {status:response.status,body:await response.json()};};
  const [a,b]=f.activations,root=node.bootstrap.host.context,connectors=node.featureServices.connectors;
  assert.equal(a.scope.cordis.root,root);assert.equal(b.scope.cordis.root,root);assert.equal(a.child.root,root);assert.equal(b.child.root,root);
  assert.notEqual(a.scope.cordis,b.scope.cordis);assert.notEqual(a.scope.cordis,root);
  const backend=a.scope.cordis.fiber.parent;
  assert.equal(b.scope.cordis.fiber.parent,backend);assert.notEqual(backend,root);assert.equal(backend.fiber.parent,root);
  for(const context of [node.sourcePipelines.context,node.workflows.context,node.processing.runtime.context]){
    assert.equal(context.root,root);assert.notEqual(context,root,'runtime registrations retain the plugin owner');
  }
  for(const name of ['moteMaterials','moteConfig','moteExecution','moteMemoryStrategies'])assert.equal(root.get(name,false),undefined);
  await bounded(Promise.all([a.started.promise,b.started.promise]));
  assert.equal(f.activeTimers(a),1);assert.equal(f.activeTimers(b),1);
  const pending=request('/api/connectors/generated-owner-a/held');await bounded(a.held.promise);
  const stopping=connectors.stop(a.id);
  assert.equal(a.scope.signal.aborted,true);assert.equal(f.activeTimers(a),0);
  assert.equal((await request('/api/connectors/generated-owner-a')).status,404,'new requests cannot enter a stopped scope');
  assert.equal((await request('/api/connectors/generated-owner-b')).status,200);
  assert.equal((await request('/api/features')).status,200,'owner HTTP stays usable while a sibling drains');
  b.nextTick=deferred();await bounded(b.nextTick.promise);assert.equal(f.activeTimers(b),1);
  a.release.resolve();assert.equal((await bounded(pending)).status,502);await bounded(stopping);
  assert.equal((a.lateError as {code:string}).code,'stale_scope');
  assert.equal(node.store.db.prepare("SELECT count(*) n FROM plugin_instance_state WHERE key='late'").get()!.n,0);
  await assert.rejects(a.state.compareAndSet('after-stop',null,1),{code:'stale_scope'});
  assert.equal(a.scope.cordis.fiber.uid,null);assert.equal(a.child.fiber.uid,null);
  assert.deepEqual([a.closed,a.released,a.childClosed],[1,1,1]);assert.deepEqual([b.closed,b.released,b.childClosed],[0,0,0]);
  await connectors.stop(a.id);assert.deepEqual([a.closed,a.released,a.childClosed],[1,1,1]);
  await connectors.restart(a.id);
  const replacement=f.activations[2];await bounded(replacement.started.promise);
  assert.equal(replacement.scope.cordis.root,root);assert.equal(replacement.scope.cordis.fiber.parent,backend);
  assert.notEqual(replacement.scope.identity.activationId,a.scope.identity.activationId);assert.equal(replacement.launches,2);
  assert.equal(f.activeTimers(replacement),1);assert.equal((await request('/api/connectors/generated-owner-a')).body.launches,2);
  assert.equal((await request('/api/connectors/generated-owner-b')).status,200);
  await backend.fiber.dispose();
  for(const value of [a,b,replacement]){
    assert.equal(value.scope.signal.aborted,true);assert.equal(f.activeTimers(value),0);
    assert.equal(value.scope.cordis.fiber.uid,null);assert.equal(value.child.fiber.uid,null);
    assert.deepEqual([value.closed,value.released,value.childClosed],[1,1,1]);
    await assert.rejects(value.state.get('launches'),{code:'stale_scope'});
  }
  assert.ok(root.fiber.getEffects().length>0,'withdrawing the backend child retains the bootstrap owners');
  assert.equal((await request('/api/connectors/generated-owner-b')).status,404);
  const closing=connectors.close();assert.equal(connectors.close(),closing);await bounded(closing);
  await node.app.close();assert.deepEqual(root.fiber.getEffects(),[]);assert.deepEqual(node.bootstrap.snapshot().contributions,[]);assert.equal(f.timers.size,0);
});

test('a declared connector startup failure rolls back child scopes once and a fresh build can reuse the profile',async t=>{
  const f=await fixture(t),failure=Error('Generated connector configure failure');let shouldFail=true;
  const manifests=[f.manifest('generated-started'),f.manifest('generated-failure',()=>shouldFail?failure:undefined)];
  await assert.rejects(f.open(manifests),error=>contains(error,failure));
  assert.equal(f.activations.length,2);const originalRoot=f.activations[0].scope.cordis.root;
  assert.deepEqual(originalRoot.fiber.getEffects(),[]);assert.equal(f.timers.size,0);
  for(const value of f.activations){
    assert.equal(value.scope.cordis.root,originalRoot);assert.equal(value.scope.signal.aborted,true);
    assert.equal(value.scope.cordis.fiber.uid,null);assert.equal(value.child.fiber.uid,null);
    assert.deepEqual([value.closed,value.released,value.childClosed],[1,1,1]);
    await assert.rejects(value.state.compareAndSet('after-failure',null,1),{code:'stale_scope'});
  }
  shouldFail=false;const node=await f.open(manifests),restarted=f.activations.slice(2);
  assert.notEqual(node.bootstrap.host.context,originalRoot);
  for(const value of restarted){assert.equal(value.scope.cordis.root,node.bootstrap.host.context);assert.equal(value.launches,2);assert.equal(f.activeTimers(value),1);}
  const response=await node.app.inject({url:'/api/connectors/generated-failure',headers});assert.equal(response.statusCode,200);
  assert.equal(response.json().launches,2);
  await node.app.close();await node.app.close();assert.equal(f.timers.size,0);
  for(const value of f.activations)assert.deepEqual([value.closed,value.released,value.childClosed],[1,1,1]);
});
