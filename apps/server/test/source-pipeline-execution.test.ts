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
import {EvidenceReader} from '../src/evidence-reader.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import type {Context} from '@deepseek-ai/cordis';

const event=(id:string,text:string)=>({externalId:id,revision:'1',observedAt:'2026-09-24T01:00:00Z',kind:'message',layer:'snapshot',text,
  document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:'shared-session',projectKey:'generated',eventId:id,role:'user',part:0,parts:1}}});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};};
const installedCodingVersion=(runtime:SourcePipelineRuntime)=>{
  const recipe=runtime.registry.get('mote.coding')!.recipe!;
  return runtime.recipes.resolve(recipe.id,recipe.version).definition.version;
};
const codingNextVersion=(ctx:Context)=>{
  codingSourcePlugin(ctx);
  const prior=ctx.moteSourceRecipes.registry.listRecipes().find(recipe=>recipe.definition.id==='mote.coding')!;
  const version=`${prior.definition.version}.fixture-next`;
  ctx.effect(()=>ctx.moteSourceRecipes.installRecipe({...prior.definition,version}));
  const pipeline=ctx.moteSourcePipelines.get('mote.coding')!;
  pipeline.version=version;pipeline.recipe={id:'mote.coding',version};
};

test('exact archive retransmission preserves the published Coding revision and input fingerprint',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-source-duplicate-complete-'));
  const store=new Store(directory),materials=new MaterialStore(store),runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);await runtime.ready;
  t.after(async()=>{await runtime.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const sources=new SourceStore(store,runtime);sources.register({id:'coding',name:'Generated',kind:'coding-agent',deviceId:'device',platform:'macos'});
  const first=event('one','Generated first event'),second=event('two','Generated continuation');
  const receipt=await sources.upsert('coding',first);await runtime.tick();const initial=materials.list().items[0];
  await sources.upsert('coding',second);await runtime.tick();const appended=materials.list().items[0];
  assert.notEqual(appended.revision,initial.revision);assert.equal(appended.sequence,initial.sequence+1);
  const before=materials.input(appended.ref,['conversation']),work=store.db.prepare('SELECT * FROM source_pipeline_work').all(),steps=store.db.prepare("SELECT * FROM execution_steps WHERE kind='source.archive-group' ORDER BY id").all();
  const repeated=await sources.upsert('coding',first);assert.equal(repeated.id,receipt.id);assert.equal(repeated.duplicate,true);await runtime.tick();
  const after=materials.list().items[0];assert.equal(after.revision,appended.revision);assert.equal(after.sequence,appended.sequence);assert.deepEqual(materials.input(after.ref,['conversation']),before);
  assert.deepEqual(store.db.prepare('SELECT * FROM source_pipeline_work').all(),work);assert.deepEqual(store.db.prepare("SELECT * FROM execution_steps WHERE kind='source.archive-group' ORDER BY id").all(),steps);
  assert.equal(store.db.prepare('SELECT count(*) n FROM source_archive_versions').get()!.n,2);
});

test('exact retransmission does not revoke a running archive worker',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-source-duplicate-running-'));
  const store=new Store(directory),materials=new MaterialStore(store),runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);await runtime.ready;
  const entered=deferred(),release=deferred(),snapshot=runtime.recipes.snapshot.bind(runtime.recipes);
  runtime.recipes.snapshot=(async(...args:Parameters<typeof snapshot>)=>{const result=snapshot(...args);entered.resolve();await release.promise;return result;}) as unknown as typeof snapshot;
  t.after(async()=>{release.resolve();await runtime.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const sources=new SourceStore(store,runtime);sources.register({id:'coding',name:'Generated',kind:'coding-agent',deviceId:'device',platform:'macos'});
  const original=event('one','Generated running retransmission fixture');await sources.upsert('coding',original);
  const running=runtime.tick();await entered.promise;const work=store.db.prepare('SELECT * FROM source_pipeline_work').get()!,step=runtime.engine.get(`source.archive-group:${work.id}:${work.generation}`)!;assert.equal(step.state,'running');
  assert.equal((await sources.upsert('coding',original)).duplicate,true);assert.deepEqual(store.db.prepare('SELECT * FROM source_pipeline_work').get(),work);assert.equal(runtime.engine.get(step.id)?.fence,step.fence);assert.equal(runtime.engine.get(step.id)?.state,'running');
  release.resolve();await running;assert.equal(runtime.engine.get(step.id)?.state,'succeeded');assert.equal(materials.list().items[0].sequence,1);
});

test('an exact retransmission preserves failure backoff while an explicit retry remains available',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-source-duplicate-failed-'));
  const store=new Store(directory),materials=new MaterialStore(store),runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);await runtime.ready;
  t.after(async()=>{await runtime.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const sources=new SourceStore(store,runtime);sources.register({id:'coding',name:'Generated',kind:'coding-agent',deviceId:'device',platform:'macos'});
  let calls=0;const snapshot=runtime.recipes.snapshot.bind(runtime.recipes);runtime.recipes.snapshot=(()=>{calls++;throw Error('Generated transient fixture failure');}) as typeof runtime.recipes.snapshot;
  const original=event('one','Generated failed retransmission fixture');await sources.upsert('coding',original);await runtime.tick();const work=store.db.prepare('SELECT * FROM source_pipeline_work').get()!,step=runtime.engine.get(`source.archive-group:${work.id}:${work.generation}`)!;assert.equal(work.error,'organization_failed');assert.equal(step.state,'waiting');assert.ok(step.availableAt>Date.now());
  assert.equal((await sources.upsert('coding',original)).duplicate,true);await runtime.tick();assert.deepEqual(store.db.prepare('SELECT * FROM source_pipeline_work').get(),work);assert.deepEqual(runtime.engine.get(step.id),step);assert.equal(calls,1);
  runtime.recipes.snapshot=snapshot;runtime.engine.retry(step.id);await runtime.tick();assert.equal(runtime.engine.get(step.id)?.state,'succeeded');assert.equal(materials.list().items.length,1);
});

test('explicit config reprocessing with an empty Coding delta keeps the same Material',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-source-empty-append-'));
  const store=new Store(directory),materials=new MaterialStore(store),runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);await runtime.ready;
  t.after(async()=>{await runtime.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const sources=new SourceStore(store,runtime);sources.register({id:'coding',name:'Generated',kind:'coding-agent',deviceId:'device',platform:'macos'});
  await sources.upsert('coding',event('one','Generated config reprocessing fixture'));await runtime.tick();const before=materials.list().items[0],input=materials.input(before.ref,['conversation']);
  runtime.configure('coding',{memory:false});await runtime.tick();const after=materials.list().items[0];assert.equal(after.revision,before.revision);assert.equal(after.sequence,before.sequence);assert.deepEqual(materials.input(after.ref,['conversation']),input);
  assert.equal(runtime.memoryAllowed('coding'),false);assert.equal(store.db.prepare('SELECT generation FROM source_pipeline_work').get()!.generation,1,'configuration change still executes its new pinned work');
});

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
  const priorVersion=installedCodingVersion(runtime);
  const sources=new SourceStore(store,runtime);sources.register({id:'coding',name:'Generated',kind:'coding-agent',deviceId:'device',platform:'macos'});
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  await sources.upsert('coding',event('one','Generated deterministic upgrade'));
  await runtime.tick();const prior=store.db.prepare('SELECT id,generation,recipe_version,state FROM source_pipeline_work').get()!;
  assert.equal(prior.recipe_version,priorVersion);assert.equal(prior.state,'complete');
  await runtime.close();store.close();

  store=new Store(directory);materials=new MaterialStore(store);runtime=new SourcePipelineRuntime(store,materials,[codingNextVersion]);await runtime.ready;
  const currentVersion=installedCodingVersion(runtime);assert.notEqual(currentVersion,priorVersion);
  await runtime.tick();const upgraded=store.db.prepare('SELECT generation,recipe_version,state FROM source_pipeline_work').get()!;
  assert.equal(upgraded.generation,Number(prior.generation)+1);
  assert.equal(upgraded.recipe_version,currentVersion);assert.equal(upgraded.state,'complete');
  assert.equal(runtime.engine.get(`source.archive-group:${prior.id}:${upgraded.generation}`)?.state,'succeeded');
  assert.equal(materials.list({query:'deterministic upgrade'}).items.length,1);
  await runtime.close();store.close();
});

test('recipe upgrade does not silently replay after out-of-band configuration drift',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-source-recipe-config-'));
  let store=new Store(directory),materials=new MaterialStore(store),runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);await runtime.ready;
  const priorVersion=installedCodingVersion(runtime);
  const sources=new SourceStore(store,runtime);sources.register({id:'coding',name:'Generated',kind:'coding-agent',deviceId:'device',platform:'macos'});
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  await sources.upsert('coding',event('one','Generated configuration drift'));
  await runtime.tick();
  store.db.prepare('INSERT INTO source_pipeline_config VALUES(?,?)').run('coding',JSON.stringify({settleSeconds:0}));
  await runtime.close();store.close();

  store=new Store(directory);materials=new MaterialStore(store);runtime=new SourcePipelineRuntime(store,materials,[codingNextVersion]);await runtime.ready;
  assert.notEqual(installedCodingVersion(runtime),priorVersion);
  await runtime.tick();const blocked=store.db.prepare('SELECT generation,recipe_version,state,error FROM source_pipeline_work').get()!;
  assert.equal(blocked.recipe_version,priorVersion);assert.equal(blocked.state,'blocked');assert.equal(blocked.error,'recipe_config_changed');
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM execution_steps WHERE kind='source.archive-group'").get()!.n,1);
  await runtime.close();store.close();
});

test('Coding recipe upgrade reuses the common queue without paying for historical extraction; explicit work remains available',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-source-upgrade-memory-'));
  let store=new Store(directory),materials=new MaterialStore(store),runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);await runtime.ready;
  const priorVersion=installedCodingVersion(runtime);
  let sources=new SourceStore(store,runtime);sources.register({id:'coding',name:'Generated',kind:'coding-agent',deviceId:'device',platform:'macos'});
  let calls=0;
  const pipeline=()=>{const reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials,runtime);
    return new MemoryPipeline({store,memories:reader.memories,materialAllowedForMemory:ref=>reader.materialAllowedForMemory(ref),configured:()=>true,model:()=> 'fixture',query:async()=>{
      calls++;return {answer:'{"memories":[]}',citations:[],trace:[],runId:'fixture'};
    }});};
  let memory=pipeline();
  t.after(async()=>{await memory.close();await runtime.close();store.close();rmSync(directory,{recursive:true,force:true});});
  runtime.configure('coding',{settleSeconds:0});
  await sources.upsert('coding',event('one','Generated authorization boundary'));await runtime.tick();
  const first=materials.list().items[0];
  assert.equal(runtime.drainMemory(memory,true),1);
  const jobId=String(store.db.prepare('SELECT job_id FROM material_memory_requests').get()!.job_id);
  assert.equal((await memory.run(jobId)).status,'completed');assert.equal(calls,1);
  await memory.close();await runtime.close();store.close();

  store=new Store(directory);materials=new MaterialStore(store);runtime=new SourcePipelineRuntime(store,materials,[codingNextVersion]);await runtime.ready;
  const currentVersion=installedCodingVersion(runtime);assert.notEqual(currentVersion,priorVersion);
  sources=new SourceStore(store,runtime);memory=pipeline();
  const snapshot=runtime.recipes.snapshot.bind(runtime.recipes);
  // The generated replacement renderer needs a full rebuild of the same raw
  // input. Exercise a changed output, not an idempotent no-op append.
  runtime.recipes.snapshot=(recipe,reader,source,group,signal)=>snapshot(recipe,reader,source,group,signal);
  const organize=runtime.recipes.organize.bind(runtime.recipes);
  runtime.recipes.organize=(...args)=>{const draft=organize(...args);return draft?{...draft,title:'Generated new rendering version'}:draft;};
  await runtime.tick();
  assert.equal(store.db.prepare('SELECT recipe_version FROM source_pipeline_work').get()!.recipe_version,currentVersion);
  const upgraded=materials.get(first.id)!;assert.notEqual(upgraded.revision,first.revision,'the deterministic upgrade really changed the material');
  assert.equal(runtime.memoryWork.readyForMemory(upgraded.ref),true);
  assert.equal(runtime.drainMemory(memory,true),0);assert.equal(calls,1);
  const oldJob=memory.get(jobId);assert.equal(oldJob.id,jobId,'the historical receipt is retained');
  assert.ok(oldJob.batches.every(batch=>batch.status==='invalidated'),'changed evidence keeps the existing stale-input guarantee');
  const explicit=memory.create({evidenceIds:materials.evidenceIds(upgraded.ref)});
  await memory.run(explicit.id);assert.equal(calls,2,'a separate explicit request can use the new revision');
  // Changing enablement/configuration on this same input cannot manufacture a grant.
  runtime.configure('coding',{memory:false,settleSeconds:0});await runtime.tick();
  runtime.configure('coding',{memory:true,settleSeconds:0});await runtime.tick();
  assert.equal(runtime.drainMemory(memory,true),0);assert.equal(calls,2);
  await sources.upsert('coding',event('two','Generated newly received evidence'));await runtime.tick();
  assert.equal(runtime.drainMemory(memory,true),1);
  const next=String(store.db.prepare('SELECT job_id FROM material_memory_requests').get()!.job_id);
  await memory.run(next);assert.equal(calls,3,'new raw input retains automatic intake behavior');
});
