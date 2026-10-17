import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures/scoped-actions.js';
import {defaultModelSettings} from '../src/model-settings.js';

test('an empty personal default map exposes authoritative feature choices and saves only an explicit owned reference through M04 CAS',async t=>{
 const f=await fixture(t),initial=await f.ok(f.a.token,'/api/models');assert.deepEqual(initial.selections,{});assert.ok(Array.isArray(initial.features),'empty selections still expose the actual supported feature registry');assert.ok(initial.features.includes('chat'));assert.ok(initial.features.includes('memory'));assert.equal(new Set(initial.features).size,initial.features.length);
 const bBefore=await f.ok(f.b.token,'/api/models'),view=await f.ok(f.a.token,'/api/configuration'),value={profiles:[{id:'generated-feature-model',name:'Generated feature default',settings:{...defaultModelSettings(),provider:'custom',model:'generated-only'}}],selections:{[initial.features.find((value:string)=>value==='chat')]:{kind:'personal',id:'generated-feature-model'}}},saved=await f.ok(f.a.token,'/api/configuration/models','PUT',{revision:view.revision,value});
 const result=await f.ok(f.a.token,'/api/models');assert.deepEqual(result.features,initial.features);assert.deepEqual(result.selections,{chat:{kind:'personal',id:'generated-feature-model'}});assert.deepEqual(await f.ok(f.b.token,'/api/models'),bBefore);
 assert.equal((await f.request(f.a.token,'/api/configuration/models','PUT',{revision:saved.revision,value:{...value,selections:{'generated-unknown-feature':{kind:'personal',id:'generated-feature-model'}}}})).statusCode,400,'metadata does not widen the authoritative model schema');
 assert.equal((await f.ok(f.a.token,'/api/tasks')).items.length,0);assert.equal((await f.ok(f.a.token,'/api/query-runs')).items.length,0);
});
