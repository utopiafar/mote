import test from 'node:test';
import assert from 'node:assert/strict';
import {startBridge} from '../dist/bridge.js';

const at='2026-09-14T01:00:00.000Z';
const sample={id:'generated-activity',capturedAt:at,appName:'Generated',appId:'test.generated',sourceType:'activity',ocrText:'',durationMs:15000,privacy:{collection:'activity'},metadata:{version:1,observedAt:at,state:{batteryPercent:0,charging:false}},deviceId:'fixture-device'};
async function call(bridge,tool,args={}) {const response=await fetch(`${bridge.url}/${tool}`,{method:'POST',headers:{Authorization:`Bearer ${bridge.token}`,'Content-Type':'application/json'},body:JSON.stringify(args)});return {status:response.status,body:await response.json()};}
test('agent chooses exact app/source/collection filters and expands content-free measured evidence',async()=>{
  let seen;
  const reader={search:async()=>[],timeline:async args=>{seen=args;return {items:[sample],nextCursor:null,totalCount:1};},evidence:async()=>[sample],activity:async()=>({}),devices:async()=>[]};
  const bridge=await startBridge(reader,{question:'Generated activity only',deviceId:'fixture-device'},10);
  try {
    const filters={source:'activity',appId:'test.generated',collection:'activity'};
    const result=await call(bridge,'timeline',filters);assert.equal(result.status,200);
    for(const [key,value] of Object.entries(filters))assert.equal(seen[key],value);
    const r=result.body.data[0];assert.equal(r.sourceType,'activity');assert.equal(r.ocrText,'');assert.equal(r.collection,'activity');assert.equal(r.metadata.state.batteryPercent,0);assert.equal(r.sampleInterval.start,'2026-09-14T00:59:45.000Z');
    const evidence=await call(bridge,'evidence',{ids:[r.id]});assert.deepEqual(evidence.body.data[0].metadata,{...sample.metadata,displayObservedAt:'2026-09-14T01:00:00+00:00'});
    for(const bad of [{source:'task-keyword'},{appId:''},{collection:'all'},{deviceId:'outside-scope'}])assert.equal((await call(bridge,'timeline',bad)).status,400);
  } finally {await bridge.close();}
});
test('agent projection preserves bounded source metadata without passing source URLs or arbitrary private fields',async()=>{
  const file={...sample,id:'generated-file',sourceType:'file',privacy:{collection:'content'},durationMs:0,metadata:{version:1,observedAt:at,device:{serialNumber:'never-pass'}},provenance:{sourceId:'files',layer:'reference',revision:'r1',uri:'file:///private/example',modifiedAt:at,metadata:{version:1,file:{sizeBytes:12,accessedAt:at}}}};
  const bridge=await startBridge({search:async()=>[file],timeline:async()=>[],evidence:async()=>[file],activity:async()=>({}),devices:async()=>[]},{question:'generated file metadata'},2);
  try {const result=await call(bridge,'search_context');const r=result.body.data[0];assert.equal(r.metadata,undefined);assert.equal(r.provenance.uri,undefined);assert.equal(r.provenance.originalAvailable,false);assert.equal(r.provenance.metadata.file.sizeBytes,12);assert.equal(r.provenance.modifiedAt,at);assert.ok(!JSON.stringify(result.body).includes('never-pass'));}
  finally {await bridge.close();}
});

test('stale health report timestamps stay distinct from later archive evidence and private device fields',async()=>{
  const reportAt='2026-09-14T00:00:00.000Z';
  const bridge=await startBridge({search:async()=>[],timeline:async()=>[sample],evidence:async()=>[sample],activity:async()=>({}),devices:async()=>[{deviceId:'fixture-device',deviceName:'Generated',platform:'macos',status:'offline',lastSeenAt:reportAt,lastCaptureAt:reportAt,queueDepth:0,metadata:sample.metadata,token:'never-pass',lastError:'private-server-path'}]},{question:'generated health and later archive',deviceId:'fixture-device'},3);
  try {
    const device=(await call(bridge,'devices')).body.data[0];
    assert.equal(device.lastCaptureAt,undefined);assert.equal(device.status,undefined);
    assert.deepEqual(device.healthReport,{statusAsReported:'offline',receivedAt:reportAt,displayReceivedAt:'2026-09-14T00:00:00+00:00',lastCaptureAtAsReported:reportAt,displayLastCaptureAtAsReported:'2026-09-14T00:00:00+00:00',queueDepthAsReported:0});
    assert.deepEqual(device.metadata,{...sample.metadata,displayObservedAt:'2026-09-14T01:00:00+00:00'});
    assert.ok(!JSON.stringify(device).includes('never-pass'));assert.ok(!JSON.stringify(device).includes('private-server-path'));
    const record=(await call(bridge,'timeline')).body.data[0];
    assert.equal(record.capturedAt,at);assert.ok(record.capturedAt>device.healthReport.lastCaptureAtAsReported);
  } finally {await bridge.close();}
});

test('device-state display time uses its own observation instant across a local date boundary',async()=>{
  const observed='2026-09-13T15:59:59.000Z';
  const record={...sample,capturedAt:'2026-09-13T16:00:01.000Z',metadata:{...sample.metadata,observedAt:observed}};
  const bridge=await startBridge({search:async()=>[],timeline:async()=>[record],evidence:async()=>[record],activity:async()=>({}),devices:async()=>[]},{question:'generated distinct observation time',timeZone:'Asia/Shanghai'},1);
  try {
    const r=(await call(bridge,'timeline')).body.data[0];
    assert.equal(r.displayCapturedAt,'2026-09-14T00:00:01+08:00');
    assert.equal(r.metadata.displayObservedAt,'2026-09-13T23:59:59+08:00');
    assert.equal(r.metadata.observedAt,observed);assert.equal(r.metadata.state.batteryPercent,0);
  } finally {await bridge.close();}
});
