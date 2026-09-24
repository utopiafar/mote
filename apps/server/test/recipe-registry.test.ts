import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {parseRecipeDefinition} from '../src/recipe-contract.js';
import {RecipeRegistry,type RecipeComponentKind} from '../src/recipe-registry.js';

const component=(kind:RecipeComponentKind)=>({id:`fixture.${kind}`,version:'1',kind});
const ref=(kind:RecipeComponentKind)=>({id:`fixture.${kind}`});
const definition=()=>({
  schemaVersion:1,id:'fixture.coding',version:'1',accepts:{sourceKind:'coding-agent'},
  raw:{writer:ref('raw-writer'),reader:ref('raw-reader'),retention:ref('raw-retention')},
  trigger:{policy:ref('trigger')},group:{policy:ref('group')},
  window:{policy:{...ref('window'),config:{seconds:5}}},
  steps:[
    {id:'project',use:ref('step'),dependsOn:['assemble']},
    {id:'assemble',use:ref('step'),dependsOn:[]},
  ],
  publish:{use:ref('publish')},index:{use:ref('index')},
  exposure:{use:ref('exposure'),routes:[
    {audience:'query',operation:'ask',phase:'ready',readProjection:'material'},
    {audience:'query',operation:'ask',phase:'raw',readProjection:'metadata'},
    {audience:'memory',operation:'derive',phase:'ready',readProjection:'material'},
  ]},
});
const registry=()=>{
  const registry=new RecipeRegistry();
  for(const kind of ['raw-writer','raw-reader','raw-retention','trigger','group','step','publish','index','exposure'] as const)registry.installComponent(component(kind));
  registry.installComponent({...component('window'),configSchema:z.object({seconds:z.number().int().min(0).max(3600)}).strict()});
  return registry;
};

test('a pure recipe pins component versions, sorts the DAG, and declares distinct read surfaces',()=>{
  const recipes=registry();
  const input=definition();
  const installed=recipes.installRecipe(input);
  assert.deepEqual(installed.stepOrder,['assemble','project']);
  assert.equal(installed.definition.accepts.sourceKind,'coding-agent');
  assert.deepEqual(installed.definition.exposure.routes,input.exposure.routes);
  assert.equal(installed.componentPins.find(pin=>pin.path==='window.policy')?.version,'1');
  assert.match(installed.definitionFingerprint,/^[a-f0-9]{64}$/);
  assert.match(installed.configFingerprint,/^[a-f0-9]{64}$/);
  assert.equal(recipes.resolveRecipe('fixture.coding','1'),installed);
  assert.equal(recipes.installRecipe(JSON.parse(JSON.stringify(input))),installed);
  input.steps[0]!.id='mutated';
  assert.equal(installed.definition.steps[0]!.id,'project');
  assert.ok(Object.isFrozen(installed.definition.steps[0]));
});

test('recipe validation rejects duplicate steps, unknown dependencies, cycles and duplicate exposure routes',()=>{
  const duplicate=definition();duplicate.steps[1]!.id='project';
  assert.throws(()=>parseRecipeDefinition(duplicate),/Duplicate recipe step/);
  const missing=definition();missing.steps[0]!.dependsOn=['missing'];
  assert.throws(()=>parseRecipeDefinition(missing),/Unknown recipe step dependency/);
  const cyclic=definition();cyclic.steps[1]!.dependsOn=['project'];
  assert.throws(()=>parseRecipeDefinition(cyclic),/Recipe step cycle/);
  const duplicateDependency=definition();duplicateDependency.steps[0]!.dependsOn=['assemble','assemble'];
  assert.throws(()=>parseRecipeDefinition(duplicateDependency),/Duplicate dependency/);
  const duplicateRoute=definition();duplicateRoute.exposure.routes.push({...duplicateRoute.exposure.routes[0]!});
  assert.throws(()=>parseRecipeDefinition(duplicateRoute),/Duplicate recipe exposure route/);
});

test('recipes cannot carry scripts, functions or unregistered component references',()=>{
  const recipes=registry();
  const script=definition();(script.window.policy.config as Record<string,unknown>).script='return process.env';
  assert.throws(()=>recipes.installRecipe(script),/not executable text/);
  const functionValue=definition();(functionValue.window.policy.config as Record<string,unknown>).callback=()=>{};
  assert.throws(()=>recipes.installRecipe(functionValue),/declarative JSON/);
  const unknown=definition();unknown.steps[0]!.use={id:'fixture.absent'};
  assert.throws(()=>recipes.installRecipe(unknown),/Unknown recipe component/);
  const wrongKind=definition();wrongKind.steps[0]!.use=ref('publish');
  assert.throws(()=>recipes.installRecipe(wrongKind),/cannot serve/);
  const badConfig=definition();(badConfig.window.policy.config as Record<string,unknown>).seconds=9999;
  assert.throws(()=>recipes.installRecipe(badConfig),/Invalid recipe component config/);
});

test('a recipe version is immutable after uninstall, and missing or upgraded components fail closed',()=>{
  const recipes=registry();const first=recipes.installRecipe(definition());
  recipes.uninstallComponent('fixture.step');
  assert.throws(()=>recipes.resolveRecipe('fixture.coding','1'),/unavailable component/);
  recipes.installComponent({...component('step'),version:'2'});
  assert.throws(()=>recipes.resolveRecipe('fixture.coding','1'),/unavailable component/);
  assert.throws(()=>recipes.installRecipe(definition()),/different immutable definition or component version/);
  recipes.uninstallRecipe('fixture.coding','1');
  assert.throws(()=>recipes.resolveRecipe('fixture.coding','1'),/is not installed/);
  assert.throws(()=>recipes.installRecipe(definition()),/different immutable definition or component version/);
  recipes.uninstallComponent('fixture.step');
  recipes.installComponent(component('step'));
  const changed=definition();changed.window.policy.config.seconds=10;
  assert.throws(()=>recipes.installRecipe(changed),/different immutable definition or component version/);
  assert.equal(recipes.installRecipe(definition()).configFingerprint,first.configFingerprint);
});
