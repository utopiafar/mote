import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceItemSchema,type SourceConnection} from '@mote/shared';
import {SourceRecipeExecutor} from '../src/source-recipe-executor.js';
import type {RawReader} from '../src/raw-reader.js';
import type {RecipeComponentKind} from '../src/recipe-registry.js';

const component=(kind:RecipeComponentKind)=>({id:`fixture.${kind}`,version:'1',kind});

test('recipe window and aggregation outputs are not rejected by former item or byte totals',async()=>{
  const executor=new SourceRecipeExecutor(),source={id:'generated-source',name:'Generated',kind:'custom',deviceId:'generated-device',platform:'import'} as SourceConnection;
  const items=Array.from({length:10001},(_,index)=>sourceItemSchema.parse({externalId:`generated-${index}`,revision:'1',observedAt:'2026-09-24T01:00:00.000Z',kind:'message',layer:'original',text:`Generated item ${index}`}));
  executor.registerRawWriter(component('raw-writer'),()=>{throw Error('unused writer');});
  executor.registerRawReader(component('raw-reader'),async()=>({items,checkpoint:'generated-snapshot'}));
  executor.registerGroup(component('group'),()=>'generated-group');
  executor.registerStep(component('step'),()=>({count:items.length}));
  executor.registerWindow(component('window'),input=>input.snapshot.items);
  executor.registerAggregation(component('aggregation'),()=>({generated:'a'.repeat(1024*1024+1)}));
  let published:unknown;
  executor.registerPublisher(component('publish'),input=>{published=input;return {id:'mat_'+'0'.repeat(64)} as never;});
  for(const kind of ['raw-retention','trigger','index','exposure'])executor.registerPolicy(component(kind));
  executor.installRecipe({schemaVersion:1,id:'fixture.large',version:'1',accepts:{sourceKind:'custom'},
    raw:{writer:{id:'fixture.raw-writer'},reader:{id:'fixture.raw-reader'},retention:{id:'fixture.raw-retention'}},
    trigger:{policy:{id:'fixture.trigger'}},group:{policy:{id:'fixture.group'}},window:{policy:{id:'fixture.window'}},aggregation:{policy:{id:'fixture.aggregation'}},
    steps:[{id:'assemble',use:{id:'fixture.step'},dependsOn:[]}],publish:{use:{id:'fixture.publish'}},index:{use:{id:'fixture.index'}},
    exposure:{use:{id:'fixture.exposure'},routes:[]}});
  const recipe=executor.resolve('fixture.large','1');
  const snapshot=await executor.snapshot(recipe,{} as RawReader,source,'generated-group',new AbortController().signal);
  assert.equal(snapshot.items.length,10001);
  executor.organize(recipe,source,'generated-group',snapshot);
  const output=(published as {outputs:{aggregation:{generated:string}}}).outputs.aggregation;
  assert.equal(output.generated.length,1024*1024+1);
});
