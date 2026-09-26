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
import type {Context} from '@deepseek-ai/cordis';

const event=(id:string,text:string)=>({externalId:id,revision:'1',observedAt:'2026-09-24T01:00:00Z',kind:'message',layer:'snapshot',text,
  document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:'shared-session',projectKey:'generated',eventId:id,role:'user',part:0,parts:1}}});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};};
const codingV5=(ctx:Context)=>{
  codingSourcePlugin(ctx);
  const prior=ctx.moteSourceRecipes.registry.listRecipes().find(recipe=>recipe.definition.id==='mote.coding')!;
  ctx.effect(()=>ctx.moteSourceRecipes.installRecipe({...prior.definition,version:'6'}));
  const pipeline=ctx.moteSourcePipelines.get('mote.coding')!;
  pipeline.version='6';pipeline.recipe={id:'mote.coding',version:'6'};
};

test('archive group is an engine step that survives a runtime restart',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-source-engine-restart-'));
  let store=new Store(directory),materials=new MaterialStore(store),runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);await runtime.ready;
  const sources=new SourceStore(store,runtime);sources.register({id:'coding',name:'Generated',kind:'coding-agent',deviceId:'device',platform:'macos'});
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  await sources.upsert('coding',event('one','Generated restart proof'));
  const pending=store.db.prepare("SELECT id,operation_id,state,input FROM execution_steps WHERE kind='source.archive-group'").get()!;
  assert.equal(pending.state,'waiting');assert.equal(JSON.parse(String(pending.input)).checkpoint,store.db.prepare('SELECT archive_checkpoint FROM source_pipeline_work').get()!.archive_checkpoint);
  await runtime.close();store.close();
  store=new Store(directory);materials=new MaterialStore(store);runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);await runtime.ready;
  await runtime.tick();
  assert.equal(runtime.engine.get(String(pending.id))?.state,'succeeded');
  assert.equal(materials.list({query:'restart proof'}).items.length,1);
  assert.equal(store.db.prepare('SELECT state FROM source_pipeline_work').get()!.state,'complete');
  await runtime.close();store.close();
});

test('a newer committed receipt revokes an old worker before material publication',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-source-engine-fence-'));
  const oldStore=new Store(directory),oldMaterials=new MaterialStore(oldStore),oldRuntime=new SourcePipelineRuntime(oldStore,oldMaterials,[codingSourcePlugin]);await oldRuntime.ready;
  const oldSources=new SourceStore(oldStore,oldRuntime);oldSources.register({id:'coding',name:'Generated',kind:'coding-agent',deviceId:'device',platform:'macos'});
  const entered=deferred(),release=deferred();
  const original=oldRuntime.recipes.snapshot.bind(oldRuntime.recipes);
  oldRuntime.recipes.snapshot=(async(...args:Parameters<typeof original>)=>{const snapshot=original(...args);entered.resolve();await release.promise;return snapshot;}) as unknown as typeof original;
  t.after(async()=>{release.resolve();await oldRuntime.close();oldStore.close();rmSync(directory,{recursive:true,force:true});});
  await oldSources.upsert('coding',event('one','Old generated body'));
  const oldStep=String(oldStore.db.prepare("SELECT id FROM execution_steps WHERE kind='source.archive-group'").get()!.id);
  const running=oldRuntime.tick();await entered.promise;

  const nextStore=new Store(directory),nextMaterials=new MaterialStore(nextStore),nextRuntime=new SourcePipelineRuntime(nextStore,nextMaterials,[codingSourcePlugin]);await nextRuntime.ready;
  t.after(async()=>{await nextRuntime.close();nextStore.close();});
  const nextSources=new SourceStore(nextStore,nextRuntime);
  await nextSources.upsert('coding',event('two','New generated body'));
  assert.equal(nextRuntime.engine.get(oldStep)?.state,'stale');
  await nextRuntime.tick();
  release.resolve();await running;
  assert.equal(nextRuntime.engine.get(oldStep)?.state,'stale');
  const material=nextMaterials.list().items[0];assert.ok(material);
  const text=nextMaterials.read(material.ref,{length:12000}).text;
  assert.match(text,/New generated body/);
  assert.equal(material.sequence,1,'revoked worker did not create an intermediate material revision');
});

test('installed deterministic Coding recipe upgrades persisted groups without a new receipt',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-source-recipe-upgrade-'));
  let store=new Store(directory),materials=new MaterialStore(store),runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);await runtime.ready;
  const sources=new SourceStore(store,runtime);sources.register({id:'coding',name:'Generated',kind:'coding-agent',deviceId:'device',platform:'macos'});
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  await sources.upsert('coding',event('one','Generated deterministic upgrade'));
  await runtime.tick();const prior=store.db.prepare('SELECT id,generation,recipe_version,state FROM source_pipeline_work').get()!;
  assert.equal(prior.recipe_version,'5');assert.equal(prior.state,'complete');
  await runtime.close();store.close();

  store=new Store(directory);materials=new MaterialStore(store);runtime=new SourcePipelineRuntime(store,materials,[codingV5]);await runtime.ready;
  await runtime.tick();const upgraded=store.db.prepare('SELECT generation,recipe_version,state FROM source_pipeline_work').get()!;
  assert.equal(upgraded.generation,Number(prior.generation)+1);
  assert.equal(upgraded.recipe_version,'6');assert.equal(upgraded.state,'complete');
  assert.equal(runtime.engine.get(`source.archive-group:${prior.id}:${upgraded.generation}`)?.state,'succeeded');
  assert.equal(materials.list({query:'deterministic upgrade'}).items.length,1);
  await runtime.close();store.close();
});

test('recipe upgrade does not silently replay after out-of-band configuration drift',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-source-recipe-config-'));
  let store=new Store(directory),materials=new MaterialStore(store),runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);await runtime.ready;
  const sources=new SourceStore(store,runtime);sources.register({id:'coding',name:'Generated',kind:'coding-agent',deviceId:'device',platform:'macos'});
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  await sources.upsert('coding',event('one','Generated configuration drift'));
  await runtime.tick();
  store.db.prepare('INSERT INTO source_pipeline_config VALUES(?,?)').run('coding',JSON.stringify({settleSeconds:0}));
  await runtime.close();store.close();

  store=new Store(directory);materials=new MaterialStore(store);runtime=new SourcePipelineRuntime(store,materials,[codingV5]);await runtime.ready;
  await runtime.tick();const blocked=store.db.prepare('SELECT generation,recipe_version,state,error FROM source_pipeline_work').get()!;
  assert.equal(blocked.recipe_version,'5');assert.equal(blocked.state,'blocked');assert.equal(blocked.error,'recipe_config_changed');
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM execution_steps WHERE kind='source.archive-group'").get()!.n,1);
  await runtime.close();store.close();
});
