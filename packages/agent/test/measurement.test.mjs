import test from 'node:test';
import assert from 'node:assert/strict';
import {startBridge} from '../dist/bridge.js';

const sample={id:'synthetic-measured',capturedAt:'2026-09-11T00:00:20.000Z',appName:'Synthetic reader',deviceId:'generated-only',sourceType:'screen',ocrText:'Generated interval evidence.',durationMs:20000};
const reader={search:async()=>[sample],timeline:async()=>({items:[sample],nextCursor:null,totalCount:1}),evidence:async()=>[sample],activity:async()=>({}),devices:async()=>[]};
async function call(bridge,tool,args={}) {
  const response=await fetch(`${bridge.url}/${tool}`,{method:'POST',headers:{Authorization:`Bearer ${bridge.token}`,'Content-Type':'application/json'},body:JSON.stringify(args)});
  return {status:response.status,body:await response.json()};
}
test('timeline and evidence expose original finite nonnegative interval duration including zero',async()=>{
  const records=[sample,{...sample,id:'overlapping',capturedAt:'2026-09-11T00:00:30.000Z'},
    {...sample,id:'later',capturedAt:'2026-09-11T00:10:00.000Z',durationMs:10000},
    {...sample,id:'self-report',sourceType:'note',durationMs:0,ocrText:'Synthetic diary self-report: two hours.'}];
  const bridge=await startBridge({...reader,timeline:async()=>({items:records,nextCursor:null,totalCount:4}),evidence:async()=>records},{question:'generated overlap'},8);
  try {
    const page=await call(bridge,'timeline');assert.equal(page.status,200);assert.equal(page.body.pagination.totalCount,4);
    assert.deepEqual(page.body.data.slice(0,3).map(r=>r.sampleInterval.start),['2026-09-11T00:00:00.000Z','2026-09-11T00:00:10.000Z','2026-09-11T00:09:50.000Z']);
    assert.ok(page.body.data.slice(0,3).every(r=>r.sampleInterval.end===r.capturedAt));
    assert.equal(page.body.data[3].sampleInterval,undefined);
    const expanded=await call(bridge,'evidence',{ids:records.map(r=>r.id)});assert.equal(expanded.status,200);
    for(const result of [page,expanded]) assert.deepEqual(result.body.data.map(({id,capturedAt,durationMs,sourceType})=>({id,capturedAt,durationMs,sourceType})),records.map(({id,capturedAt,durationMs,sourceType})=>({id,capturedAt,durationMs,sourceType})));
  } finally {await bridge.close();}
});
test('invalid duration fields are not projected as usable numeric evidence',async()=>{
  const records=[-1,NaN,Infinity,'20000'].map((durationMs,index)=>({...sample,id:`invalid-${index}`,durationMs}));
  const bridge=await startBridge({...reader,search:async()=>records},{question:'invalid synthetic durations'},2);
  try {const result=await call(bridge,'search_context');assert.equal(result.status,200);assert.ok(result.body.data.every(record=>!Object.hasOwn(record,'durationMs')));}
  finally {await bridge.close();}
});
test('pagination carries total scope count on every page and rejects malformed totals',async()=>{
  let invalid;
  const bridge=await startBridge({...reader,timeline:async args=>({items:[sample],nextCursor:args.cursor?null:'next',totalCount:invalid??121})},{question:'generated totals'},10);
  try {
    for(const args of [{},{cursor:'next'}]) {const result=await call(bridge,'timeline',args);assert.equal(result.status,200);assert.equal(result.body.pagination.totalCount,121);}
    for(const value of [-1,0,1.5,NaN,'121']) {invalid=value;assert.equal((await call(bridge,'timeline')).status,400);}
  } finally {await bridge.close();}
});
