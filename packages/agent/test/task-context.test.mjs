import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildContextEnvelope,taskTools} from '../dist/task-context.js';
import {startBridge} from '../dist/bridge.js';
import {parseAnswer} from '../dist/index.js';
const record={id:'generated-evidence',capturedAt:'2026-09-18T00:00:00Z',deviceId:'fixture',appName:'Generated',ocrText:'a'.repeat(9000)+'NEEDLE the gate opens at 14:30. '+'b'.repeat(3000)};
const reader={search:async()=>[record],timeline:async()=>[record],evidence:async()=>[record],activity:async()=>({}),devices:async()=>[],memories:async()=>({items:[{id:'memory',statement:'derived'}],evidence:[record]})};
async function fixture(t,input={question:'fixture'}){const bridge=await startBridge(reader,input,24);t.after(()=>bridge.close());return {bridge,call:async(tool,args)=>{const r=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{Authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});return {status:r.status,body:await r.json()};}};}
test('shared context separates long task input and retains incremental semantics and task authority',()=>{
 const input={question:'Compact',skill:'working-memory',taskContext:{turns:[{turnId:'t1',answer:'x'.repeat(30000)}]},incrementalEvidenceIds:['one']};
 const envelope=buildContextEnvelope(input,[],'2026-09-18T00:00:00Z');
 assert.equal(envelope.request,'Compact');assert.equal(envelope.untrustedTaskContext.turns[0].answer.length,30000);assert.equal(envelope.incrementalContext.count,1);assert.deepEqual(taskTools(input),[]);assert.deepEqual(taskTools({question:'Extract',evidenceIds:['one']}),['evidence']);
 assert.throws(()=>buildContextEnvelope({...input,taskContext:{turns:[{turnId:'t1',answer:'x'.repeat(80000)}]}},[]));
});
test('search localizes late match and separate reads retain both citation spans',async t=>{
 const {bridge,call}=await fixture(t);
 const found=await call('search_context',{query:'NEEDLE'});assert.equal(found.status,200);assert.match(found.body.data[0].ocrText,/14:30/);assert.ok(found.body.data[0].textRange.start>8000);
 await call('evidence',{ids:[record.id],offset:0,length:100});
 const second=await call('evidence',{ids:[record.id],offset:9000,length:100});assert.equal(second.status,200);
 const saved=bridge.records.get(record.id);assert.equal(saved.deliveredRanges.length,3);
 const answer=parseAnswer(JSON.stringify({answer:`14:30 [${record.id}]`,citationIds:[record.id]}),bridge.records);assert.match(answer.citations[0].excerpt,/14:30/);
});
test('memory detail discovers IDs without authorizing unread original citations',async t=>{
 const {bridge,call}=await fixture(t);const memory=await call('memories',{id:'memory'});
 assert.equal(memory.status,200);assert.equal(memory.body.data.evidence[0].ocrText,undefined);assert.equal(bridge.records.has(record.id),false);
 assert.throws(()=>parseAnswer(JSON.stringify({answer:'claim',citationIds:[record.id]}),bridge.records));
 assert.equal((await call('evidence',{ids:[record.id],offset:9000,length:100})).status,200);assert.equal(bridge.records.has(record.id),true);
});
test('working task advertises and enforces no archive tools',async t=>{
 const {call}=await fixture(t,{question:'Compact',skill:'working-memory'});
 assert.equal((await call('_ready',{tools:['skill']})).status,200);
 assert.equal((await call('timeline',{})).status,400);
});

test('revision changes retire prior spans and repeated spans do not duplicate citation state',async t=>{
 const {rememberEvidence}=await import('../dist/evidence-ledger.js');const records=new Map();
 const first={...record,ocrText:'first',evidenceFingerprint:'v1',textRange:{start:0,end:5}};
 rememberEvidence(records,first);rememberEvidence(records,first);assert.equal(records.get(record.id).deliveredRanges.length,1);
 rememberEvidence(records,{...first,ocrText:'new',evidenceFingerprint:'v2',textRange:{start:100,end:103}});
 assert.deepEqual(records.get(record.id).deliveredRanges,[{start:100,end:103,text:'new'}]);
});
test('host context accounts for schema and system input before admitting a task',async()=>{
 const {assembleContext}=await import('../dist/task-context.js');
 const {metrics}=assembleContext({question:'generated'},[],'system',[{name:'evidence'}],4096);
 assert.equal(metrics.system,6);assert.equal(metrics.outputTokenReserve,4096);assert.equal(metrics.unit,'utf16_characters');
 assert.throws(()=>assembleContext({question:'generated'},[],'x'.repeat(180000),[],4096),/input budget/);
});

test('bounded evidence does not silently change an ordinary answer into memory extraction',()=>{
 assert.equal(buildContextEnvelope({question:'Answer this',evidenceIds:['one']},[]).responseMode,'answer');
 assert.equal(buildContextEnvelope({question:'Extract',skill:'memory-extraction',evidenceIds:['one']},[]).responseMode,'memory-extraction');
});
