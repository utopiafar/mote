import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startBridge} from '../dist/bridge.js';
const record={id:'fixture-evidence',capturedAt:'2026-09-12T10:00:00Z',appName:'合成日历',deviceId:'allowed',ocrText:'计划讨论，实际参加未知',provenance:{sourceId:'calendar',layer:'snapshot',revision:'v1',calendar:{start:'2026-11-01T10:00:00+08:00',end:'2026-11-01T11:00:00+08:00'},uri:'file:///private/original'}};
function reader(overrides={}){return {search:async()=>[],timeline:async()=>[],evidence:async()=>[record],activity:async()=>({}),devices:async()=>[],...overrides};}
async function request(b,tool,body={}){const r=await fetch(b.url+'/'+tool,{method:'POST',headers:{Authorization:'Bearer '+b.token,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
test('source discovery passes scope and planned event provenance without disclosing local URI',async t=>{
 let received;const b=await startBridge(reader({sourceItems:async args=>{received=args;return {items:[record],nextCursor:'1'};}}),{question:'calendar',deviceId:'allowed'},12);t.after(()=>b.close());
 const r=await request(b,'source_items',{kind:'calendar',after:'2026-11-01T00:00:00Z'});assert.equal(r.status,200);assert.equal(received.deviceId,'allowed');assert.equal(r.body.data[0].provenance.calendar.start,record.provenance.calendar.start);assert.equal(r.body.data[0].provenance.uri,undefined);assert.equal((await request(b,'evidence',{ids:[record.id]})).status,200);
 assert.equal((await request(b,'source_items',{deviceId:'other'})).status,400);
});
test('memory details authorize only delivered in-scope original evidence and never synthetic memory ids',async t=>{
 const b=await startBridge(reader({memories:async()=>({items:[{id:'memory-card',title:'derived'}],evidence:[record,{...record,id:'private-other',deviceId:'other'}]})}),{question:'memory',deviceId:'allowed'},12);t.after(()=>b.close());
 const r=await request(b,'memories',{id:'memory-card'});assert.equal(r.status,200);assert.equal(r.body.data.evidence.length,1);assert.equal((await request(b,'evidence',{ids:[record.id]})).status,200);assert.equal((await request(b,'evidence',{ids:['memory-card']})).status,400);assert.equal((await request(b,'evidence',{ids:['private-other']})).status,400);
});
test('rejected oversized memory result cannot authorize evidence',async t=>{
 const b=await startBridge(reader({memories:async()=>({items:[{text:'x'.repeat(1_600_000)}],evidence:[record]})}),{question:'memory'},12);t.after(()=>b.close());assert.equal((await request(b,'memories')).status,400);assert.equal((await request(b,'evidence',{ids:[record.id]})).status,400);
});
