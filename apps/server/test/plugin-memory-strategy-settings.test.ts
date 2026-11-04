import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PluginHost} from '@mote/plugin-host';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryStrategies,installMemoryStrategyContributions,type MemoryStrategyContribution} from '../src/memory-strategies.js';
import {MaterialMemoryWork} from '../src/material-memory-work.js';
import {fixtureMemoryPipeline} from './fixtures/memory-result.js';
import {centralServices} from '../src/plugins/central-contracts.js';
import {
  createMemoryStrategySettings,createMemoryStrategySettingsFactory,memoryStrategySettingsContribution,
  memoryStrategySettingsDeclaration,type MemoryStrategySettingsBindings,
} from '../src/plugins/memory-strategy-settings.js';

const ref=(name:string,version='1')=>({id:'fixture.'+name,version});
const extraction={...ref('extract'),input:'memory-evidence@1',output:'memory-candidates@1',permissions:['evidence.read'],prompt:'GENERATED_EXTRACTION'};
const review={...ref('review'),input:'memory-candidates@1',output:'memory-candidates@1',permissions:['evidence.read'],policy:'GENERATED_REVIEW'};
const recipe={...ref('recipe'),workContract:'range-evaluation@1' as const,requires:['extracted-text'],extract:ref('extract'),review:ref('review')};
const contribution:MemoryStrategyContribution={id:'fixture.memory-strategy-contribution',extractions:[extraction],reviews:[review],recipes:[recipe]};
const plainExtraction={...ref('plain-extract'),input:'memory-evidence@1',output:'memory-candidates@1',permissions:['evidence.read'],prompt:'GENERATED_PLAIN_EXTRACTION'};
const plainReview={...ref('plain-review'),input:'memory-candidates@1',output:'memory-candidates@1',permissions:['evidence.read'],policy:'GENERATED_PLAIN_REVIEW'};
const plainRecipe={...ref('plain'),workContract:'range-evaluation@1' as const,extract:ref('plain-extract'),review:ref('plain-review')};
const secondPlainRecipe={...ref('plain-second'),workContract:'range-evaluation@1' as const,extract:ref('plain-extract'),review:ref('plain-review')};
const integrate={...ref('integrator'),input:'memory-cards@1',output:'memory-candidates@1',permissions:['memory.read','evidence.read'],prompt:'GENERATED_INTEGRATOR'};
const integrateReview={...ref('integration-review'),input:'memory-candidates@1',output:'memory-candidates@1',permissions:['memory.read','evidence.read'],policy:'GENERATED_INTEGRATION_REVIEW'};
const integrationRecipe={...ref('integration'),integrate:ref('integrator'),review:ref('integration-review')};
const integrationContribution:MemoryStrategyContribution={id:'fixture.integration-contribution',reviews:[integrateReview],integrations:[integrate],integrationRecipes:[integrationRecipe]};

function directory(t:test.TestContext){
  const path=mkdtempSync(join(tmpdir(),'mote-memory-strategy-settings-'));
  t.after(()=>rmSync(path,{recursive:true,force:true}));
  return path;
}

function materialFixture(t:test.TestContext){
  const store=new Store(directory(t)),sources=new SourceStore(store),materials=new MaterialStore(store);
  const memories=new MemoryStore(store,ids=>[...store.evidence(ids),...materials.evidence(ids)],id=>store.isCurrentEvidence(id)||materials.isCurrentEvidence(id));
  sources.register({id:'generated-source',name:'Generated',kind:'custom',deviceId:'fixture',platform:'import'});
  const draft=(text='Generated material body'):MaterialDraft=>({
    id:materialId('generated-source','generated-item'),kind:'mote.file',schemaVersion:1,title:'Generated file',
    origin:{sourceId:'generated-source',externalId:'generated-item'},
    blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:['original']}],
    members:[{id:'original',kind:'archive',ref:'archive:generated'}],
    coverage:{state:'partial',reason:'processing_pending'},artifacts:[{key:'source-body',state:'ready'},{key:'extracted-text',state:'ready'}],
    fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'},
  });
  const material=materials.publish(draft());
  t.after(()=>{if(store.db.isOpen)store.close();});
  return {store,sources,materials,memories,material};
}

function receive(work:MaterialMemoryWork,store:Store,inputKey='raw'){
  store.db.exec('BEGIN IMMEDIATE');
  try{work.inputs.receive({sourceId:'generated-source',inputKey});store.db.exec('COMMIT');}
  catch(error){if(store.db.isTransaction)store.db.exec('ROLLBACK');throw error;}
}

const empty=()=>({answer:'{"memories":[]}',citations:[],trace:[],runId:'generated-empty'});

test('a duplicate id/version with a different definition is rejected and never overwrites the installed recipe',async t=>{
  const {store}=materialFixture(t);
  const strategies=new MemoryStrategies([]),remove=installMemoryStrategyContributions(strategies,[contribution]);
  const before=strategies.resolve(recipe);
  const changed:MemoryStrategyContribution={...contribution,id:'fixture.changed-contribution',extractions:[{...extraction,prompt:'GENERATED_CHANGED_EXTRACTION'}]};
  assert.throws(()=>installMemoryStrategyContributions(strategies,[changed]),/already installed/);
  const after=strategies.resolve(recipe);
  assert.equal(after.extract.prompt,'GENERATED_EXTRACTION');
  assert.deepEqual(after.binding,before.binding,'the original pin remains authoritative');
  remove();

  const platform=createMemoryStrategySettings({store,contributions:[contribution,changed]});
  await assert.rejects(platform.prepare(),/already installed/);
  assert.equal(store.db.isTransaction,false,'a rejected contribution leaves no database lock');
  await platform.close();

  const restarted=createMemoryStrategySettings({store,contributions:[contribution]});
  restarted.prepare();restarted.start();
  assert.equal(restarted.strategies.resolve(recipe).extract.prompt,'GENERATED_EXTRACTION');
  await restarted.close();
});

test('the resolved recipe binding is consumed by MaterialMemoryWork and the pipeline with the same required outputs and strategies',async t=>{
  const {store,materials,memories,material}=materialFixture(t);
  const platform=createMemoryStrategySettings({store,contributions:[contribution]});
  platform.prepare();platform.start();
  t.after(()=>platform.close());
  platform.recipes.configure({recipes:[{id:recipe.id,version:recipe.version}]});

  const work=new MaterialMemoryWork(store,materials,()=>1000,()=>true,platform.recipes);
  receive(work,store);
  work.observe(material.id,['source-body'],{inputKey:'raw',change:'source'});
  const row=store.db.prepare('SELECT required_json,binding_json FROM material_memory_requests').get() as {required_json:string;binding_json:string};
  assert.deepEqual(JSON.parse(row.required_json),['extracted-text'],'MaterialMemoryWork uses the recipe required outputs, not the source defaults');
  const binding=JSON.parse(row.binding_json);
  assert.deepEqual(binding,platform.strategies.resolve(recipe).binding);
  const catalog=work.catalog();
  assert.equal(catalog.length,1);
  assert.deepEqual(catalog[0].recipe,{id:recipe.id,version:recipe.version});
  assert.deepEqual(work.planningInput(catalog[0]).required,['extracted-text']);

  const pipeline=fixtureMemoryPipeline({store,memories,strategies:platform.strategies,
    admission:{materialInput:(value,required)=>materials.input(value,required),materialRequirements:value=>work.sourceRequirements(value),materialAllowedForMemory:()=>true},
    models:{model:()=> 'fixture',configured:()=>true},
    phases:{query:async()=>empty(),review:async(_input,result)=>result}});
  t.after(()=>pipeline.close());
  const evidenceIds=materials.evidenceIds(material.ref);
  const job=pipeline.create({evidenceIds,recipes:[{id:recipe.id,version:recipe.version}]});
  assert.equal(job.batches.length,1);
  assert.deepEqual(job.batches[0].strategy,binding,'the pipeline persists the same resolved pin');
  const pinned=pipeline.strategies.resolvePinned(job.batches[0].strategy!);
  assert.equal(pinned.extract.prompt,'GENERATED_EXTRACTION');
  assert.equal(pinned.review.policy,'GENERATED_REVIEW');
  assert.deepEqual(pinned.binding.requires,['extracted-text']);
});

test('ordinary recipe-setting updates leave an in-flight run alone, while a withdrawn pinned strategy stops queued work before any model call',async t=>{
  const {store,materials,memories,material}=materialFixture(t);
  const platform=createMemoryStrategySettings({store,contributions:[contribution]});
  platform.prepare();platform.start();
  t.after(()=>platform.close());
  platform.strategies.registerExtraction(plainExtraction);platform.strategies.registerReview(plainReview);
  const removePlain=platform.strategies.registerRecipe(plainRecipe),removeSecond=platform.strategies.registerRecipe(secondPlainRecipe);
  platform.recipes.configure({recipes:[{id:plainRecipe.id,version:plainRecipe.version}]});

  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
  let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve});
  const calls:string[]=[];
  const pipeline=fixtureMemoryPipeline({store,memories,strategies:platform.strategies,
    admission:{materialInput:(value,required)=>materials.input(value,required),materialRequirements:()=>['source-body'],materialAllowedForMemory:()=>true},
    models:{model:()=> 'fixture',configured:()=>true},
    phases:{query:async()=>{calls.push('query');entered();await gate;return empty()},review:async(_input,result)=>result}});
  t.after(()=>pipeline.close());
  const evidenceIds=materials.evidenceIds(material.ref);
  const running=pipeline.create({evidenceIds,recipes:[{id:plainRecipe.id,version:plainRecipe.version}]}),completion=pipeline.run(running.id);
  await started;
  platform.recipes.configure({recipes:[{id:secondPlainRecipe.id,version:secondPlainRecipe.version}]});
  assert.equal(pipeline.get(running.id).status,'running','a normal settings update does not cancel accepted work');
  release();
  assert.equal((await completion).status,'completed');
  assert.deepEqual(calls,['query']);

  const queued=pipeline.create({evidenceIds,recipes:[{id:plainRecipe.id,version:plainRecipe.version}]});
  removePlain();removeSecond();
  const blocked=await pipeline.run(queued.id);
  assert.equal(blocked.status,'failed');
  assert.equal(blocked.batches[0].errorCode,'memory_strategy_unavailable');
  assert.deepEqual(calls,['query'],'a withdrawn pin cannot reach the model');
});

test('settings prepare/start/quiesce/stop preserves the durable selections and integration epochs, and the host factory provides the ports',async t=>{
  const {store}=materialFixture(t);
  const platform=createMemoryStrategySettings({store,contributions:[contribution,integrationContribution]});
  platform.prepare();platform.start();
  platform.recipes.configure({recipes:[{id:recipe.id,version:recipe.version}]});
  const firstSelection=platform.recipes.selection();
  const firstIntegration=platform.integration.configure({recipe:{id:integrationRecipe.id,version:integrationRecipe.version}});
  const secondIntegration=platform.integration.configure({recipe:null});
  assert.notEqual(secondIntegration.activation,firstIntegration.activation);
  assert.ok(secondIntegration.afterSequence>=firstIntegration.afterSequence);
  assert.equal(secondIntegration.binding,null);
  assert.deepEqual(platform.strategies.resolvePinnedIntegration(firstIntegration.binding!).integrate,platform.strategies.resolveIntegration(integrationRecipe).integrate,'the old epoch stays pinned and resolvable');
  assert.equal(platform.integration.current(firstIntegration),false);
  assert.equal(platform.integration.current(platform.integration.selection()),true);

  platform.quiesce('disabled');
  assert.throws(()=>platform.ports.recipes.configure({recipes:[{id:recipe.id,version:recipe.version}]}),{statusCode:503});
  assert.throws(()=>platform.ports.integration.configure({recipe:{id:integrationRecipe.id,version:integrationRecipe.version}}),{statusCode:503});
  assert.throws(()=>platform.ports.strategies.registerRecipe(plainRecipe),{statusCode:503});
  assert.deepEqual(platform.ports.recipes.selection(),firstSelection,'reads survive quiesce');
  await platform.stop('disabled');
  assert.throws(()=>platform.ports.strategies.resolve(recipe),{statusCode:503});

  const restarted=createMemoryStrategySettings({store,contributions:[contribution,integrationContribution]});
  restarted.prepare();restarted.start();
  assert.deepEqual(restarted.recipes.selection(),firstSelection,'the selection survives stop and a new activation');
  assert.equal(restarted.integration.view().binding,null);
  await restarted.close();

  const hostPlatform=createMemoryStrategySettings({store,contributions:[contribution]});
  const host=new PluginHost({kind:'central',id:'generated-memory-strategy-settings-host'});
  let bindings:MemoryStrategySettingsBindings|undefined;
  const handle=await host.install({identity:{host:host.identity,packageId:'generated.memory-strategy-settings',installationId:randomUUID(),instanceId:randomUUID(),activationId:randomUUID()},
    contributions:[memoryStrategySettingsDeclaration],factory:createMemoryStrategySettingsFactory(hostPlatform,value=>{bindings=value;})});
  const strategies=await host.acquire(centralServices.memoryStrategies,bindings!.strategies);
  const recipes=await host.acquire(centralServices.memoryRecipeSettings,bindings!.recipes);
  assert.equal(strategies.value.resolve(recipe).extract.prompt,'GENERATED_EXTRACTION');
  assert.deepEqual(recipes.value.selection(),firstSelection);
  await handle.quiesce('upgrade');
  assert.throws(()=>strategies.value.registerRecipe(plainRecipe),{statusCode:503});
  await handle.close('disabled');
  assert.throws(()=>strategies.value.resolve(recipe),{code:'dependency_unavailable'});
  await strategies.release();await recipes.release();await host.close();
  assert.equal(memoryStrategySettingsContribution.provides.length,3);
});
