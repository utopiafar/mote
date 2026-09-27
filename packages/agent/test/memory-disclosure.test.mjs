import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startBridge} from '../dist/bridge.js';

const record={id:'generated-original',capturedAt:'2026-09-20T00:00:00Z',deviceId:'generated-device',appName:'Generated',ocrText:'Preface. Relax shoulders before turning. Other private detail.',filePath:'/private/not-for-disclosure'};
const quote='Relax shoulders before turning.',offset=record.ocrText.indexOf(quote);
const result={items:[{id:'generated-memory',statement:'A scoped training lesson',evidence:[{id:record.id,offset,length:quote.length,quote:'UNVERIFIED SAVED QUOTE'}]}],references:[{id:record.id,capturedAt:record.capturedAt,characters:quote.length}],sourceSpans:[{record,offset,length:quote.length}]};
async function fixture(t,memoryResult=result){
  const reader={memories:async()=>memoryResult,search:async()=>[],timeline:async()=>[],evidence:async({ids})=>ids.includes(record.id)?[record]:[],activity:async()=>({}),devices:async()=>[]};
  const bridge=await startBridge(reader,{question:'Generated training detail',deviceId:record.deviceId,after:'2026-09-01T00:00:00Z',before:'2026-10-01T00:00:00Z'},20);
  t.after(()=>bridge.close());
  const call=async(args)=>{const response=await fetch(bridge.url+'/memories',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});return {status:response.status,body:await response.json()};};
  return {bridge,call};
}

test('memory detail discloses original text only on request and grants only delivered original ranges',async t=>{
  const {bridge,call}=await fixture(t);
  const detail=await call({id:'generated-memory'});assert.equal(detail.status,200);
  assert.equal(JSON.stringify(detail.body).includes('UNVERIFIED SAVED QUOTE'),false);
  assert.equal(detail.body.data.sourceEvidence,undefined);assert.equal(bridge.records.size,0);
  const expanded=await call({id:'generated-memory',includeEvidence:true});assert.equal(expanded.status,200);
  assert.equal(expanded.body.source,'untrusted_personal_context');
  assert.equal(expanded.body.data.sourceEvidence[0].ocrText,quote);
  assert.deepEqual(expanded.body.data.sourceEvidence[0].textRange,{start:offset,end:offset+quote.length,total:record.ocrText.length,nextOffset:offset+quote.length});
  assert.equal(JSON.stringify(expanded.body).includes('/private/not-for-disclosure'),false);
  assert.equal(JSON.stringify(expanded.body).includes('Other private detail'),false);
  assert.deepEqual(bridge.records.get(record.id).deliveredRanges.map(({start,end,text})=>({start,end,text})),[{start:offset,end:offset+quote.length,text:quote}]);
  assert.equal(bridge.records.has('generated-memory'),false,'a Memory cannot cite itself');
});

test('source disclosure rejects broad requests and ignores unrequested, out-of-scope or unreferenced spans',async t=>{
  const outside={...record,id:'outside',deviceId:'another-device'},future={...record,id:'future',capturedAt:'2026-10-01T00:00:00Z'},unlisted={...record,id:'unlisted'};
  const {bridge,call}=await fixture(t,{...result,references:[...result.references,...[outside,future].map(r=>({id:r.id,capturedAt:r.capturedAt,characters:20}))],sourceSpans:[outside,future,unlisted].map(r=>({record:r,offset:0,length:20}))});
  assert.equal((await call({includeEvidence:true})).status,400);
  assert.equal((await call({id:'generated-memory',includeEvidence:'yes'})).status,400);
  const value=await call({id:'generated-memory',includeEvidence:true});assert.equal(value.status,200);
  assert.deepEqual(value.body.data.sourceEvidence,[]);assert.equal(value.body.data.sourceCoverage.partial,true);assert.equal(bridge.records.size,0);
});

test('source ranges are bounded and an oversized response never grants citation authority',async t=>{
  const large={...record,ocrText:'x'.repeat(10000)},spans=Array.from({length:5},(_,i)=>({record:large,offset:i*2000,length:4000}));
  const limited=await fixture(t,{...result,sourceSpans:spans});
  const value=await limited.call({id:'generated-memory',includeEvidence:true});assert.equal(value.status,200);
  assert.equal(value.body.data.sourceEvidence.length,3);assert.equal(value.body.data.sourceEvidence.every(r=>r.ocrText.length===2000),true);
  assert.equal(value.body.data.sourceCoverage.partial,true);
  const denied=await fixture(t,{...result,items:[{...result.items[0],statement:'x'.repeat(17000)}]});
  const rejected=await denied.call({id:'generated-memory',includeEvidence:true});assert.equal(rejected.status,400);assert.match(rejected.body.error,/evidence budget/);
  assert.equal(denied.bridge.records.size,0);assert.deepEqual(denied.bridge.evidenceDependencies.ids,[]);
});

test('disjoint supporting quotes preserve exact offsets in the citation ledger',async t=>{
  const second=record.ocrText.indexOf('Other');
  const {bridge,call}=await fixture(t,{...result,sourceSpans:[...result.sourceSpans,{record,offset:second,length:5}]});
  assert.equal((await call({id:'generated-memory',includeEvidence:true})).status,200);
  assert.deepEqual(bridge.records.get(record.id).deliveredRanges.map(r=>[r.start,r.end]),[[offset,offset+quote.length],[second,second+5]]);
});
