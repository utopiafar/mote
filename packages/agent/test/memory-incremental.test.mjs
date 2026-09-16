import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startBridge} from '../dist/bridge.js';
const records=Array.from({length:65},(_,i)=>({id:'generated-'+i,capturedAt:'2026-03-01T00:00:00Z',appName:'Synthetic',ocrText:'原始文本 '+i,deviceId:i===64?'outside':'inside'}));
const reader={evidence:async({ids})=>records.filter(r=>ids.includes(r.id)),search:async()=>[],timeline:async()=>[],activity:async()=>({}),devices:async()=>[]};
async function call(bridge,tool,args){const r=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify(args)});return {status:r.status,body:await r.json()};}
test('incremental disclosure paginates a host snapshot, respects hard scope and authorizes only delivered originals',async t=>{
 const b=await startBridge(reader,{question:'generated',incrementalEvidenceIds:records.map(r=>r.id),deviceId:'inside'},10);t.after(()=>b.close());
 assert.equal((await call(b,'evidence',{ids:['generated-40']})).status,400);
 const first=await call(b,'changes',{});assert.equal(first.body.data.length,30);assert.equal(first.body.pagination.nextCursor,'30');assert.equal(first.body.data[0].textRange.total,records[0].ocrText.length);
 const second=await call(b,'changes',{cursor:first.body.pagination.nextCursor});assert.equal(second.body.data.length,30);assert.equal((await call(b,'evidence',{ids:['generated-40']})).status,200);
 const last=await call(b,'changes',{cursor:second.body.pagination.nextCursor});assert.equal(last.body.data.length,4);assert.equal(last.body.pagination.nextCursor,null);assert.equal((await call(b,'evidence',{ids:['generated-64']})).status,400);
});
test('working memory refuses every context retrieval and normal sessions cannot enumerate an unrelated change journal',async t=>{
 const working=await startBridge(reader,{question:'generated',skill:'working-memory'},5);t.after(()=>working.close());assert.equal((await call(working,'timeline',{})).status,400);assert.equal((await call(working,'memories',{})).status,400);
 const normal=await startBridge(reader,{question:'generated'},5);t.after(()=>normal.close());assert.deepEqual((await call(normal,'changes',{})).body.data,[]);
});
