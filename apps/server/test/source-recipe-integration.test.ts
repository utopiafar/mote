import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {MaterialStore} from '../src/materials.js';
import {SourceStore} from '../src/sources.js';
import {SourcePipelineRuntime} from '../src/source-pipelines.js';
import {codingSourcePlugin} from '../src/coding-source-plugin.js';

const event=(id:string,text:string)=>({
  externalId:id,revision:'1',observedAt:'2026-09-24T01:00:00.000Z',kind:'message',layer:'snapshot',text,
  document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:'fixture-session',projectKey:'fixture-project',eventId:id,role:'user',part:0,parts:1}},
});

async function fixture(t:import('node:test').TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-recipe-'));
  const store=new Store(directory),materials=new MaterialStore(store);
  const runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);await runtime.ready;
  const sources=new SourceStore(store,runtime);
  sources.register({id:'coding',name:'Generated Coding',kind:'coding-agent',deviceId:'fixture-device',platform:'macos'});
  t.after(async()=>{await runtime.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,materials,runtime,sources};
}

test('Coding receipts pin a recipe and execute its registered handlers instead of the legacy organizer',async t=>{
  const {store,materials,runtime,sources}=await fixture(t);
  await sources.upsert('coding',event('one','Generated recipe evidence'));
  const row=store.db.prepare('SELECT recipe_id,recipe_version,recipe_definition_fingerprint,recipe_config_fingerprint,recipe_component_pins FROM source_pipeline_work').get()!;
  assert.equal(row.recipe_id,'mote.coding');assert.equal(row.recipe_version,'5');
  assert.match(String(row.recipe_definition_fingerprint),/^[a-f0-9]{64}$/);
  assert.match(String(row.recipe_config_fingerprint),/^[a-f0-9]{64}$/);
  assert.ok(JSON.parse(String(row.recipe_component_pins)).some((pin:{id:string;version:string})=>pin.id==='mote.coding-assemble'&&pin.version==='4'));
  const pipeline=runtime.registry.get('mote.coding')!;
  pipeline.organize=()=>{throw Error('Legacy callback must not run for a recipe');};
  await runtime.tick();
  const material=materials.list({query:'Generated recipe evidence'}).items[0];
  assert.ok(material);assert.equal(material.coverage.state,'complete');
  assert.equal(store.db.prepare('SELECT count(*) n FROM captures').get()!.n,0);
  assert.equal(store.db.prepare('SELECT state FROM source_pipeline_work').get()!.state,'complete');
});

test('missing or changed components block pinned work and reject fresh Coding receipts',async t=>{
  const {store,materials,runtime,sources}=await fixture(t);
  await sources.upsert('coding',event('one','Generated blocked evidence'));
  runtime.recipes.registry.uninstallComponent('mote.coding-assemble');
  await runtime.tick();
  assert.equal(store.db.prepare('SELECT state,error FROM source_pipeline_work').get()!.state,'blocked');
  assert.equal(materials.list().items.length,0);
  await assert.rejects(sources.upsert('coding',event('two','New evidence')),/recipe or component unavailable/);
  runtime.recipes.registry.installComponent({id:'mote.coding-assemble',version:'5',kind:'step'});
  await runtime.tick();
  assert.equal(store.db.prepare('SELECT state FROM source_pipeline_work').get()!.state,'blocked');
  assert.equal(materials.list().items.length,0);
});

test('component removal during a recipe step cannot publish its computed draft',async t=>{
  const {store,materials,runtime,sources}=await fixture(t);
  await sources.upsert('coding',event('one','Generated concurrent removal'));
  const organize=runtime.recipes.organize.bind(runtime.recipes);
  runtime.recipes.organize=(...args)=>{
    const draft=organize(...args);
    runtime.recipes.registry.uninstallComponent('mote.coding-assemble');
    return draft;
  };
  await runtime.tick();
  assert.equal(materials.list().items.length,0);
  assert.equal(store.db.prepare('SELECT state FROM source_pipeline_work').get()!.state,'blocked');
  await runtime.tick();
  assert.equal(store.db.prepare('SELECT state FROM source_pipeline_work').get()!.state,'blocked');
});

test('source configuration changes create a new pinned config fingerprint before replay',async t=>{
  const {store,materials,runtime,sources}=await fixture(t);
  await sources.upsert('coding',event('one','Generated configurable evidence'));
  const before=store.db.prepare('SELECT recipe_config_fingerprint FROM source_pipeline_work').get()!.recipe_config_fingerprint;
  runtime.configure('coding',{index:false,memory:false,settleSeconds:0});
  const after=store.db.prepare('SELECT recipe_config_fingerprint,state FROM source_pipeline_work').get()!;
  assert.notEqual(after.recipe_config_fingerprint,before);assert.equal(after.state,'pending');
  await runtime.tick();
  assert.equal(materials.list().items.length,1);
  assert.equal(materials.list({query:'Generated configurable evidence'}).items.length,0);
});
