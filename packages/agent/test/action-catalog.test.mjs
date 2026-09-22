import test from 'node:test';
import assert from 'node:assert/strict';
import {startBridge} from '../dist/bridge.js';
import {taskTools,buildContextEnvelope} from '../dist/task-context.js';
const id='11111111-1111-4111-8111-111111111111',actionId='22222222-2222-4222-8222-222222222222';
const record={id,deviceId:'selected',capturedAt:'2026-09-16T01:00:00Z',appName:'Generated',ocrText:'Generated original change evidence'};
const reader={evidence:async()=>[record],search:async()=>[],timeline:async()=>[],activity:async()=>({}),devices:async()=>[]};
async function fixture(t,input){const bridge=await startBridge(reader,input,16);t.after(()=>bridge.close());return {bridge,call:async(tool,body={})=>{const r=await fetch(`${bridge.url}/${tool}`,{method:'POST',headers:{Authorization:`Bearer ${bridge.token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}};}
test('calendar history grants a bounded read-only tool without broadening original evidence or exposing its callback',async t=>{
 const calls=[],input={question:'Generated extraction',skill:'calendar-extraction',evidenceIds:[id],deviceId:'selected',after:'2026-09-01T00:00:00Z',actionCatalog:async args=>{calls.push(args);return {items:[{id:actionId,event:{title:'Previous generated appointment'},evidence:[{id:'old-original',quote:'Untrusted prior quote'}]}],nextCursor:'next-page'};}};
 assert.deepEqual(taskTools(input),['evidence','action_catalog']);assert.equal(JSON.stringify(buildContextEnvelope(input,[record])).includes('async args'),false);
 const {bridge,call}=await fixture(t,input);const result=await call('action_catalog',{query:'generated participant',cursor:'old-page',limit:2});assert.equal(result.status,200);assert.equal(result.body.data.nextCursor,'next-page');assert.equal(calls[0].deviceId,'selected');assert.equal(calls[0].after,'2026-09-01T00:00:00.000Z');assert.equal(calls[0].query,'generated participant');assert.equal(bridge.records.has(actionId),false);assert.equal(bridge.records.has('old-original'),false);
 assert.equal((await call('evidence',{ids:['old-original']})).status,400);assert.equal((await call('action_catalog',{deviceId:'other'})).status,400);assert.equal((await call('action_catalog',{limit:21})).status,400);assert.equal((await call('calendar_create',{})).status,404);
});
test('ordinary queries and extraction without an explicit host action grant cannot call the catalog',async t=>{
 for(const input of [{question:'ordinary',actionCatalog:async()=>({items:[],nextCursor:null})},{question:'extraction',evidenceIds:[id],skill:'calendar-extraction'}]){assert.equal(taskTools(input).includes('action_catalog'),false);const {call}=await fixture(t,input);assert.equal((await call('action_catalog')).status,400);}
});
test('oversized action comparison output fails under the ordinary result budget',async t=>{
 const {call}=await fixture(t,{question:'Generated extraction',skill:'calendar-extraction',evidenceIds:[id],actionCatalog:async()=>({items:[{id:actionId,text:'x'.repeat(150000)}],nextCursor:null})});const value=await call('action_catalog');assert.equal(value.status,400);assert.equal(value.body.toolError.code,'evidence_budget_exceeded');
});
