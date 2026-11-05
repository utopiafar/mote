import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {captureStatus,captureStatusRow,captureStatusTable,nativeStatusView} from '../dist/native-status.js';
import {heartbeatSchema} from '../dist/index.js';
import {english} from '../dist/i18n-en.js';
const fixture=JSON.parse(readFileSync(new URL('../../../adapters/ui/fixtures/native-status.json',import.meta.url),'utf8'));
for(const row of fixture)test(row.name,()=>assert.deepEqual(nativeStatusView(row.facts),row.expected));

const captureCases=JSON.parse(readFileSync(new URL('../test-fixtures/capture-status-cases.json',import.meta.url),'utf8'));
const columns=['home','notification','androidOngoing','macIcon','central'];
const stateOrder=['capturing','pending_sync','screen_paused','paused','send_paused','local_only','reconnect','storage_full','interrupted','permission','send_attention','disconnected'];

test('capture status table covers the twelve states and five display columns',()=>{
  assert.equal(captureStatusTable.length,12);
  assert.equal(new Set(captureStatusTable.map(row=>row.id)).size,12);
  assert.deepEqual(captureStatusTable.map(row=>row.id),stateOrder);
  assert.deepEqual([...new Set(captureCases.map(row=>row.expected.id))].sort(),captureStatusTable.map(row=>row.id).sort());
  for(const row of captureStatusTable){
    assert.deepEqual(Object.keys(row),['id','level','home','notification','androidOngoing','macIcon','central']);
    assert.deepEqual(captureStatusRow(row.id),row);
  }
});

for(const row of captureCases)test(`capture status: ${row.name}`,()=>{
  const actual=captureStatus(row.facts);
  assert.equal(actual.id,row.expected.id);
  assert.equal(actual.level,row.expected.level);
  for(const column of columns)assert.deepEqual(actual[column],row.expected[column],`${row.name}: ${column}`);
});

test('every capture status text key is translated',()=>{
  const keys=captureStatusTable.flatMap(row=>[
    row.home?.titleKey,row.notification?.titleKey,row.androidOngoing,row.central?.textKey
  ]).filter(Boolean);
  for(const key of new Set(keys))assert.ok(Object.hasOwn(english,key),`Missing translation: ${key}`);
});

test('heartbeat schema snapshot stays unchanged (C03)',()=>{
  const sync=heartbeatSchema.shape.sync.unwrap();
  assert.deepEqual(Object.keys(heartbeatSchema.shape),['deviceId','deviceName','platform','status','queueDepth','lastCaptureAt','error','metadata','sync']);
  assert.deepEqual(heartbeatSchema.shape.platform.options,['macos','windows','linux','android','import']);
  assert.deepEqual(heartbeatSchema.shape.status.options,['capturing','paused','permission_required','error','offline']);
  assert.deepEqual(Object.keys(sync.shape),['mode','state','intervalMinutes','batchSize','pendingRecords','blockedRecords','awaitingOcrRecords','retainedRecords','lastUploadAt','nextUploadAt']);
  assert.deepEqual(sync.shape.mode.options,['realtime','interval','batch','manual']);
  assert.deepEqual(sync.shape.state.options,['unconfigured','idle','waiting','uploading','error','manual']);
  const beat={deviceId:'synthetic-sync',deviceName:'Synthetic',platform:'macos',status:'capturing',queueDepth:7};
  assert.deepEqual(heartbeatSchema.parse(beat),beat);
  assert.equal(heartbeatSchema.safeParse({...beat,extra:true}).success,false);
  const syncFact={mode:'interval',state:'waiting',intervalMinutes:15,batchSize:20,pendingRecords:7};
  assert.deepEqual(heartbeatSchema.parse({...beat,sync:syncFact}).sync,syncFact);
  assert.equal(heartbeatSchema.safeParse({...beat,sync:{...syncFact,extra:true}}).success,false);
});
