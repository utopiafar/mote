import test from 'node:test';
import assert from 'node:assert/strict';
import {heartbeatSchema} from '../dist/index.js';
const beat={deviceId:'synthetic-sync',deviceName:'Synthetic',platform:'macos',status:'capturing',queueDepth:7};
test('older heartbeat remains valid and optional sync snapshot preserves independent state and planned time',()=>{
 assert.deepEqual(heartbeatSchema.parse(beat),beat);
 const sync={mode:'interval',state:'waiting',intervalMinutes:15,batchSize:20,pendingRecords:7,nextUploadAt:'2026-09-14T13:00:00.000Z'};
 assert.deepEqual(heartbeatSchema.parse({...beat,sync}).sync,sync);
 assert.equal(heartbeatSchema.parse({...beat,sync}).status,'capturing');
});
test('sync snapshot rejects invalid policy limits, invented states and extra personal content',()=>{
 const sync={mode:'manual',state:'manual',intervalMinutes:15,batchSize:20,pendingRecords:0};
 for(const invalid of [{mode:'unknown'},{state:'syncing'},{intervalMinutes:14},{batchSize:0},{pendingRecords:-1},{nextUploadAt:'bad'},{text:'must not be in heartbeat'}])assert.equal(heartbeatSchema.safeParse({...beat,sync:{...sync,...invalid}}).success,false);
});
