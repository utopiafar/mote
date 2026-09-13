import test from 'node:test';
import assert from 'node:assert/strict';
import {startBridge} from '../dist/bridge.js';
import {displayTime} from '../dist/time.js';

test('display timestamps include offsets, midnight rollover and DST without changing UTC',()=>{
 assert.equal(displayTime('2026-06-10T17:35:00Z','Asia/Shanghai'),'2026-06-11T01:35:00+08:00');
 assert.equal(displayTime('2026-06-10T17:35:00Z'),'2026-06-10T17:35:00+00:00');
 assert.equal(displayTime('2026-07-10T17:35:00Z','America/New_York'),'2026-07-10T13:35:00-04:00');
 assert.equal(displayTime('2026-01-10T17:35:00Z','America/New_York'),'2026-01-10T12:35:00-05:00');
 assert.throws(()=>displayTime('2026-01-10T17:35:00Z','Not/AZone'));
});

test('selected device is enforced on every range tool and cannot be broadened',async()=>{
 const seen=[];const record={id:'synthetic',deviceId:'selected',capturedAt:'2026-06-10T17:35:00Z',appName:'Diary',ocrText:'Generated evidence'};
 const reader={search:async r=>{seen.push(r);return [record];},timeline:async r=>{seen.push(r);return [record];},activity:async r=>{seen.push(r);return {};},evidence:async()=>[record],devices:async()=>[{deviceId:'selected'},{deviceId:'other'}]};
 const bridge=await startBridge(reader,{question:'Generated',deviceId:'selected',timeZone:'Asia/Shanghai'},16);
 const call=async(tool,body={})=>{const r=await fetch(`${bridge.url}/${tool}`,{method:'POST',headers:{Authorization:`Bearer ${bridge.token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 try {
  for(const tool of ['search_context','timeline','activity']){assert.equal((await call(tool,{deviceId:'other'})).status,400);assert.equal((await call(tool)).status,200);}
  assert.equal(seen.length,3);assert.ok(seen.every(r=>r.deviceId==='selected'));
  assert.deepEqual((await call('devices')).body.data,[{deviceId:'selected'}]);
  const evidence=(await call('evidence',{ids:['synthetic']})).body.data[0];
  assert.equal(evidence.capturedAt,record.capturedAt);assert.equal(evidence.displayCapturedAt,'2026-06-11T01:35:00+08:00');
 }finally{await bridge.close();}
});
