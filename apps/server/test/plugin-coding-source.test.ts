import {testScope,createTestScope} from './fixtures/plugin-scope.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {Context,type Plugin} from '@deepseek-ai/cordis';
import {PluginHost} from '@mote/plugin-host';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {MaterialStore} from '../src/materials.js';
import {SourcePipelineRuntime} from '../src/source-pipelines.js';
import {SourceStore} from '../src/sources.js';
import {FeatureRoutes,installFeatureRoutes} from '../src/features/index.js';
import {codingSourceContribution,codingSourceDeclaration,codingSourceReplacement,createCodingSource,createCodingSourceFactory,createCodingSourceRoutes,type CodingSourceOptions} from '../src/coding-source-plugin.js';

const identity=()=>({packageId:'generated.coding-source',installationId:randomUUID(),instanceId:'coding',activationId:randomUUID(),host:{kind:'central' as const,id:'generated-coding-host'}});
const codingEvent=(id:string)=>({externalId:id,revision:'1',observedAt:'2026-11-03T01:00:00.000Z',kind:'message',layer:'snapshot',text:'Generated coding requirement '+id,document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:'generated-session',projectKey:'generated-project',eventId:id,role:'user',attribution:'human',part:0,parts:1}}});
const otherEvent=(id:string)=>({externalId:id,revision:'1',observedAt:'2026-11-03T01:00:00.000Z',kind:'message',layer:'original',text:'Generated unrelated source '+id});

async function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-coding-source-'));
  const open=async()=>{
    const store=new Store(directory),materials=new MaterialStore(store),runtime=new SourcePipelineRuntime(store,materials,undefined,testScope(t));await runtime.ready;
    const sources=new SourceStore(store,runtime),host=new PluginHost({kind:'central',id:'generated-coding-host'}),routes=createCodingSourceRoutes(runtime);
    const app=Fastify(),root=new Context(),featureRoutes=new FeatureRoutes(root,app);
    await installFeatureRoutes(featureRoutes,[{id:'mote.coding',mount:app=>routes.mount(app)}]);await app.ready();
    return {store,materials,runtime,sources,host,routes,app,root,featureRoutes};
  };
  let current=await open(),owner:Awaited<ReturnType<PluginHost['install']>>|undefined;
  const startCoding=async(options:CodingSourceOptions={})=>{
    const s=current;
    owner=await s.host.install({identity:identity(),contributions:[codingSourceDeclaration],factory:createCodingSourceFactory({runtime:s.runtime,sources:s.sources,store:s.store},s.routes,options)});
  };
  const close=async()=>{
    const s=current;await s.featureRoutes.close();await s.app.close();await s.host.close();await s.runtime.close();await s.materials.index?.close();s.store.close();await s.root.fiber.dispose();owner=undefined;
  };
  t.after(async()=>{await close();rmSync(directory,{recursive:true,force:true});});
  await startCoding();
  return {
    get state(){return current;},
    startCoding,
    async quiesceCoding(){await owner!.quiesce('upgrade');},
    async stopCoding(){await owner!.close('disabled');owner=undefined;},
    async restart(){await close();current=await open();await startCoding();},
  };
}

test('coding source disable fences only its routes and intake, then hot re-enable and restart retain the real conversation',async t=>{
  const f=await fixture(t),s=f.state;
  s.sources.register({id:'coding',name:'Generated Coding',kind:'coding-agent',deviceId:'generated-device',platform:'macos'});
  s.sources.register({id:'other',name:'Generated other source',kind:'custom',deviceId:'generated-device',platform:'import'});
  await s.sources.upsert('coding',codingEvent('one'));await s.runtime.tick();
  const initial=await s.app.inject('/api/coding/uploads');assert.equal(initial.statusCode,200,initial.body);assert.equal(initial.json().items[0].received.events,1);
  assert.match(s.materials.read(s.materials.list().items[0]!.ref,{length:12000}).text,/Generated coding requirement one/);

  await f.quiesceCoding();
  assert.equal((await s.app.inject('/api/coding/uploads')).statusCode,503);
  assert.equal((await s.app.inject({method:'PUT',url:'/api/source-pipelines/coding',payload:{settleSeconds:0}})).statusCode,503);
  await assert.rejects(s.sources.upsert('coding',codingEvent('quiesced')),{statusCode:409});
  await s.sources.upsert('other',otherEvent('quiesced'));
  await f.stopCoding();
  assert.equal((await s.app.inject('/api/coding/uploads')).statusCode,503);
  await assert.rejects(s.sources.upsert('coding',codingEvent('stopped')),{statusCode:409});
  await s.sources.upsert('other',otherEvent('stopped'));assert.equal(s.runtime.registry.get('mote.coding'),undefined);assert.equal(s.store.db.isOpen,true);

  await f.startCoding();
  const restored=await s.app.inject('/api/coding/uploads');assert.equal(restored.statusCode,200,restored.body);assert.equal(restored.json().items[0].received.events,1);
  await s.sources.upsert('coding',codingEvent('two'));await s.runtime.tick();
  assert.equal((await s.app.inject('/api/coding/uploads')).json().items[0].received.events,2);
  assert.match(s.materials.read(s.materials.list().items[0]!.ref,{length:12000}).text,/Generated coding requirement two/);

  await f.restart();const restarted=f.state;
  const afterRestart=await restarted.app.inject('/api/coding/uploads');assert.equal(afterRestart.statusCode,200,afterRestart.body);assert.equal(afterRestart.json().items[0].received.events,2);
  const text=restarted.materials.read(restarted.materials.list().items[0]!.ref,{length:12000}).text;
  assert.match(text,/Generated coding requirement one/);assert.match(text,/Generated coding requirement two/);
  assert.deepEqual(codingSourceContribution.provides,[]);assert.equal(codingSourceReplacement,'hot');
});

test('coding prepare failure releases its recipe scope and an invalid real item cannot enter the archive',async t=>{
  const f=await fixture(t),s=f.state;
  s.sources.register({id:'coding',name:'Generated Coding',kind:'coding-agent',deviceId:'generated-device',platform:'macos'});
  s.sources.register({id:'other',name:'Generated other source',kind:'custom',deviceId:'generated-device',platform:'import'});
  await f.stopCoding();
  const fail:Plugin=()=>{throw Error('Generated coding prepare failure');};
  await assert.rejects(f.startCoding({plugins:[fail]}),/Generated coding prepare failure/);
  assert.equal(s.runtime.registry.get('mote.coding'),undefined);assert.equal(s.store.db.isOpen,true);
  await s.sources.upsert('other',otherEvent('after-failure'));
  assert.equal((await s.app.inject('/api/coding/uploads')).statusCode,503);

  await f.startCoding();
  const invalid={...codingEvent('invalid'),document:{contentRole:'transcript'}};
  await assert.rejects(s.sources.upsert('coding',invalid),/Coding source requires explicit session identity/);
  assert.equal(s.store.db.prepare('SELECT count(*) n FROM source_archive_versions').get()!.n,0);
  await s.sources.upsert('other',otherEvent('after-invalid'));assert.equal(s.store.db.isOpen,true);
});

test('coding stop drains an accepted archive read before unregistering the recipe',async t=>{
  const f=await fixture(t),s=f.state;
  s.sources.register({id:'coding',name:'Generated Coding',kind:'coding-agent',deviceId:'generated-device',platform:'macos'});
  let entered!:()=>void,release!:()=>void;
  const reading=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
  const snapshot=s.runtime.recipes.snapshot.bind(s.runtime.recipes);
  t.mock.method(s.runtime.recipes,'snapshot',async(...args:Parameters<typeof snapshot>)=>{const result=await snapshot(...args);entered();await held;return result;});
  t.after(()=>release());
  await s.sources.upsert('coding',codingEvent('accepted'));const tick=s.runtime.tick();await reading;
  await f.quiesceCoding();
  let stopped=false;const stopping=f.stopCoding().then(()=>{stopped=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);
  release();await Promise.all([tick,stopping]);
  assert.equal(s.runtime.registry.get('mote.coding'),undefined);
  assert.match(s.materials.read(s.materials.list().items[0]!.ref,{length:12000}).text,/Generated coding requirement accepted/);
  assert.equal(s.store.db.prepare("SELECT state FROM source_pipeline_work").get()!.state,'complete');
});

for(const failure of [false,true])test(`coding close publishes its promise before route withdrawal ${failure?'throws':'synchronously reenters'}`,async t=>{
  const f=await fixture(t),s=f.state;await f.stopCoding();
  const root=createTestScope(),first=Error('Generated coding route withdrawal failure');
  let source!:ReturnType<typeof createCodingSource>,nested:Promise<void>|undefined,calls=0;
  const routes={...s.routes,deactivate(activation:Parameters<typeof s.routes.deactivate>[0]){
    calls++;s.routes.deactivate(activation);if(failure)throw first;if(calls===1)nested=source.close();
  }};
  source=createCodingSource({runtime:s.runtime,sources:s.sources,store:s.store},routes,root.scope);await source.prepare();source.start();
  try{
    const closing=source.close();assert.equal(source.close(),closing);
    if(failure)await assert.rejects(closing,error=>error===first);
    else{await closing;assert.equal(nested,closing);}
    assert.equal(calls,1);assert.equal(s.runtime.registry.get('mote.coding'),undefined);assert.equal(s.store.db.isOpen,true);
    assert.equal((await s.app.inject('/api/coding/uploads')).statusCode,503);assert.throws(()=>source.start(),{statusCode:503});
    await f.startCoding();assert.equal((await s.app.inject('/api/coding/uploads')).statusCode,200);
  }finally{await source.close().catch(()=>{});await root.close();}
});

test('coding preparation released after close cannot reactivate an old scope or retain a recipe',async t=>{
  const f=await fixture(t),s=f.state;await f.stopCoding();
  const root=createTestScope();let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
  const plugin:Plugin=async()=>{entered();await held;};
  const source=createCodingSource({runtime:s.runtime,sources:s.sources,store:s.store},s.routes,root.scope,{plugins:[plugin]});
  const preparing=source.prepare();await started;
  try{
    const closing=source.close(),rejected=assert.rejects(preparing,{statusCode:503});release();await Promise.all([closing,rejected]);
    assert.throws(()=>source.start(),{statusCode:503});assert.equal(s.runtime.registry.get('mote.coding'),undefined);
    await f.startCoding();assert.equal((await s.app.inject('/api/coding/uploads')).statusCode,200);
  }finally{release();await Promise.allSettled([preparing,source.close()]);await root.close();}
});
