import test from 'node:test';
import assert from 'node:assert/strict';
import {startBridge} from '../dist/bridge.js';
import {taskTools,buildContextEnvelope} from '../dist/task-context.js';
import {TaskRegistry,prepareTaskContext} from '../dist/index.js';
import {installImportProcedurePack} from '../dist/tasks/import-procedure.js';
const id='11111111-1111-4111-8111-111111111111',actionId='22222222-2222-4222-8222-222222222222';
const record={id,deviceId:'selected',capturedAt:'2026-09-16T01:00:00Z',appName:'Generated',ocrText:'Generated original change evidence'};
const reader={evidence:async()=>[record],search:async()=>[],timeline:async()=>({items:([]),nextCursor:null}),activity:async()=>({}),devices:async()=>[]};
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
test('action comparison output uses normal pagination without an unrelated response byte quota',async t=>{
 const {call}=await fixture(t,{question:'Generated extraction',skill:'calendar-extraction',evidenceIds:[id],actionCatalog:async()=>({items:[{id:actionId,text:'x'.repeat(150000)}],nextCursor:null})});const value=await call('action_catalog');assert.equal(value.status,200);assert.equal(value.body.data.items[0].text.length,150000);
});
test('ordinary queries refuse the import procedure while the dedicated import runtime resolves its versioned descriptor',()=>{
 const query={question:'Generated ordinary query',skill:'document-import'};
 assert.throws(()=>prepareTaskContext(query),error=>error?.code==='skill_unavailable');
 assert.throws(()=>buildContextEnvelope(query,[]),error=>error?.code==='skill_unavailable');
 const registry=new TaskRegistry(),dispose=installImportProcedurePack(registry);
 try{
  const skill=registry.skill('document-import');
  assert.equal(skill.version,'1.0.6');assert.equal(skill.availability,'import');assert.match(skill.content,/name: document-import/);
  assert.throws(()=>prepareTaskContext({...query,taskRegistry:registry}),error=>error?.code==='skill_unavailable');
 }finally{dispose();}
 assert.throws(()=>registry.skill('document-import'),error=>error?.code==='unknown_skill');
});
test('real calendar actions input selects the proposal task and exposes no calendar mutation capability',async t=>{
 const input={question:'Generated extraction from host scheduling',skill:'calendar-extraction',responseMode:'calendar-extraction',evidenceIds:[id],evidenceRanges:[{id,offset:0,length:record.ocrText.length}],deviceId:'selected',after:'2026-09-01T00:00:00Z',timeZone:'Asia/Shanghai',actionCatalog:async()=>({items:[],nextCursor:null})};
 const prepared=prepareTaskContext(input);assert.equal(prepared.id,'calendar');assert.equal(prepared.version,'1');assert.equal(prepared.responseMode,'calendar-extraction');assert.equal(prepared.skill.version,'1.0.3');
 const envelope=buildContextEnvelope(input,[record]);assert.equal(envelope.taskId,'calendar');assert.deepEqual(envelope.taskProfile,{output:'calendar-extraction',retrieval:'evidence'});assert.equal(envelope.actionCatalog.tool,'action_catalog');assert.match(envelope.procedure,/Propose personal calendar events/);
 assert.deepEqual(taskTools(input),['evidence','action_catalog']);assert.ok(!taskTools(input).some(name=>['calendar_create','create_event','write','bash'].includes(name)));
 const {call}=await fixture(t,input);assert.equal((await call('calendar_create',{})).status,404);assert.equal((await call('write',{})).status,404);
});
test('insight accepts a partial host snapshot as bounded context without claiming complete coverage',()=>{
 const sourceStates=Array.from({length:35},(_,i)=>({sourceId:'generated-source-'+i,state:'ready'})),snapshot={version:2,seriesId:'generated-series',asOf:'2026-10-01T00:00:00Z',scope:{after:'2026-09-01T00:00:00Z',before:'2026-10-01T00:00:00Z',timeZone:'UTC'},coverage:{sourceStates,limitations:['generated_partial']}};
 const input={question:'Generated review',skill:'personal-insight',responseMode:'personal-insight',insightSnapshot:snapshot},prepared=prepareTaskContext(input);
 assert.equal(prepared.id,'insight');assert.equal(prepared.version,'1');assert.equal(prepared.responseMode,'personal-insight');assert.equal(prepared.skill.version,'1.0.5');
 const envelope=buildContextEnvelope(input,[]);assert.equal(envelope.taskId,'insight');assert.deepEqual(envelope.taskProfile,{output:'personal-insight',retrieval:'archive'});
 assert.equal(envelope.hostInsightSnapshot.coverage.sourceStates.length,30);assert.equal(envelope.hostInsightSnapshot.coverage.sourceStatesTotal,35);assert.equal(envelope.hostInsightSnapshot.coverage.sourceStatesTruncated,true);assert.match(envelope.snapshotInstruction,/do not claim complete coverage/);
 assert.equal(snapshot.coverage.sourceStates.length,35,'the host snapshot is not mutated by assembly');
});
