import test from 'node:test';
import assert from 'node:assert/strict';
import {captureSchema,heartbeatSchema,noteSchema,noteCapture,sourceItemSchema,recordMetadataSchema} from '../dist/index.js';

const at='2026-09-14T01:00:00.000Z';
const identity={id:'fe7269a5-baea-4b3d-85e1-7d68a5d5b72e',deviceId:'fixture-device',deviceName:'Generated device',platform:'android',capturedAt:at};
const metadata={version:1,observedAt:at,collector:{version:'0.7.0',method:'accessibility'},device:{model:'Generated',osVersion:'15'},state:{batteryPercent:0,charging:false,screenLocked:false,networkType:'none',availableStorageBytes:0},capture:{intervalMs:15000}};
const activity={...identity,source:'activity',appId:'test.generated',appName:'Generated app',durationMs:15000,privacy:{collection:'activity',excluded:false,redacted:false,mode:'none'},metadata};

test('an app identifier always travels with a nonblank name, independently of optional device metadata',()=>{
  for (const source of ['screen','activity','note']) {
    const record={...activity,source,durationMs:0,metadata:undefined,...(source==='activity'?{}:{ocrText:'Generated original',privacy:{mode:'none'}})};
    for(const appName of [undefined,'',' \t\n']) assert.equal(captureSchema.safeParse({...record,appName}).success,false);
    assert.equal(captureSchema.parse(record).appName,'Generated app');
    assert.equal(captureSchema.parse({...record,appName:'未知应用'}).appId,record.appId);
  }
  const noApp={...identity,durationMs:0,ocrText:'Generated original'};
  assert.equal(captureSchema.parse(noApp).appName,'','Do not invent an app for an unattributed capture');
});

test('activity-only wire records contain identity and measured metadata without a content placeholder',()=>{
  const parsed=captureSchema.parse(activity);
  assert.equal(parsed.ocrText,'');assert.equal(parsed.windowTitle,'');assert.equal(parsed.imageBase64,undefined);
  assert.deepEqual(parsed.metadata,metadata);
  assert.deepEqual(captureSchema.parse(JSON.parse(JSON.stringify(parsed))),parsed);
});
test('activity source rejects every content-bearing channel and mismatched collection policy',()=>{
  for(const patch of [{appId:''},{imageBase64:'',imageMime:'image/png'},{ocrText:'secret'},{windowTitle:'secret'},{mood:'secret'},{privacy:{...activity.privacy,collection:'content'}},{privacy:{...activity.privacy,excluded:true}},{privacy:{...activity.privacy,redacted:true}},
    {provenance:{sourceId:'a',externalId:'file',revision:'1',layer:'reference'}},
    {metadata:{...metadata,capture:{intervalMs:15000,width:1600}}},{metadata:{...metadata,capture:{ocrEnabled:false}}}])
    assert.equal(captureSchema.safeParse({...activity,...patch}).success,false,JSON.stringify(patch));
  assert.equal(captureSchema.safeParse({...activity,source:'screen',ocrText:'text'}).success,false);
  assert.equal(captureSchema.safeParse({...activity,privacy:{mode:'none'}}).success,false);
});
test('old records stay byte-semantically compatible and notes retain optional observed metadata',()=>{
  const legacy=captureSchema.parse({...identity,source:'screen',durationMs:0,ocrText:'Generated text'});
  assert.equal(legacy.metadata,undefined);assert.equal(legacy.privacy.collection,undefined);
  const note=noteCapture(noteSchema.parse({...identity,text:'Original generated note',metadata:{...metadata,collector:{method:'manual'}}}));
  assert.equal(note.source,'note');assert.equal(note.metadata.collector.method,'manual');
});
test('device metadata omits unavailable facts, preserves false and zero, and disallows identifying freeform fields',()=>{
  assert.deepEqual(recordMetadataSchema.parse({version:1,observedAt:at}),{version:1,observedAt:at});
  for(const patch of [{version:2},{observedAt:'unknown'},{observedAt:'2026-09-14T01:00:00.'+'0'.repeat(100000)+'Z'},{state:{batteryPercent:-1}},{state:{batteryPercent:101}},{state:{availableStorageBytes:1.2}},{device:{serialNumber:'secret'}},{state:{ssid:'private'}},{state:{location:'private'}},{capture:{title:'secret'}}])
    assert.equal(recordMetadataSchema.safeParse({...metadata,...patch}).success,false);
  const heartbeat=heartbeatSchema.parse({deviceId:identity.deviceId,deviceName:identity.deviceName,platform:identity.platform,status:'paused',queueDepth:0,metadata});
  assert.equal(heartbeat.metadata.state.charging,false);assert.equal(heartbeat.metadata.state.batteryPercent,0);
});
test('file system and provider timestamps have distinct fields and deletion observations require tombstones',()=>{
  const item={externalId:'test-file',revision:'1',observedAt:at,modifiedAt:'2026-09-12T00:00:00Z',kind:'file',layer:'reference',metadata:{version:1,file:{sizeBytes:0,createdAt:'2026-09-10T00:00:00Z',accessedAt:'2026-09-13T00:00:00Z',metadataChangedAt:'2026-09-12T12:00:00Z'}}};
  assert.deepEqual(sourceItemSchema.parse(item).metadata,item.metadata);
  assert.equal(sourceItemSchema.safeParse({...item,kind:'event'}).success,false);
  assert.equal(sourceItemSchema.safeParse({...item,metadata:{version:1,file:{deletionObservedAt:at}}}).success,false);
  assert.equal(sourceItemSchema.safeParse({...item,deleted:true,metadata:{version:1,file:{deletionObservedAt:at}}}).success,true);
  assert.equal(sourceItemSchema.safeParse({...item,metadata:{version:1,file:{deletedAt:at}}}).success,false);
  assert.equal(captureSchema.safeParse({...identity,source:'file',durationMs:0,provenance:{sourceId:'files',externalId:'test-file',revision:'1',layer:'reference',metadata:{version:1,file:{deletionObservedAt:at}}}}).success,false);
});
