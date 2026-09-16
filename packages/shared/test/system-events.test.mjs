import test from 'node:test';
import assert from 'node:assert/strict';
import {captureSchema} from '../dist/index.js';
const at='2026-09-15T01:00:00.000Z';
const event={id:'11111111-1111-4111-8111-111111111111',deviceId:'fixture',deviceName:'Fixture',platform:'android',capturedAt:at,durationMs:0,source:'notification',appId:'fixture.app',appName:'Generated app',privacy:{collection:'content'},metadata:{version:1,observedAt:at,collector:{method:'notification_listener'},observation:{sessionId:'22222222-2222-4222-8222-222222222222',elapsedRealtimeMs:1},notification:{action:'posted',notificationKey:'ab'.repeat(32),postedAt:at,ongoing:true,groupSummary:false,title:'Generated notification'}}};

test('notifications require a name for their source app',()=>{
  for(const appName of [undefined,'',' \t\n']) assert.equal(captureSchema.safeParse({...event,appName}).success,false);
});
test('notification content is bounded and cannot enter activity-only or removal records',()=>{
  assert.equal(captureSchema.safeParse(event).success,true);
  for(const change of [{durationMs:1},{imageMime:'image/png',imageBase64:'abc'},{privacy:{collection:'activity'}},{ocrText:'not OCR'}])assert.equal(captureSchema.safeParse({...event,...change}).success,false);
  for(const change of [{action:'removed'},{title:'x'.repeat(4001)},{inventedIntent:'navigation'},{notificationKey:'raw-private-key'}])assert.equal(captureSchema.safeParse({...event,metadata:{...event.metadata,notification:{...event.metadata.notification,...change}}}).success,false);
  const {title,...n}=event.metadata.notification;
  assert.equal(captureSchema.safeParse({...event,privacy:{collection:'activity'},metadata:{...event.metadata,notification:n}}).success,true);
});
test('device screen and keyguard facts remain independent',()=>{
  const {notification,...metadata}=event.metadata;
  const device={...event,appId:'',appName:'',source:'device_event',metadata:{...metadata,deviceEvent:{action:'screen_off',keyguardLocked:false,screenInteractive:false}}};
  assert.equal(captureSchema.safeParse(device).success,true);
  assert.equal(captureSchema.safeParse({...device,durationMs:1000}).success,false);
  assert.equal(captureSchema.safeParse({...device,metadata:{...device.metadata,notification}}).success,false);
  assert.equal(captureSchema.safeParse({...device,source:'note',ocrText:'text'}).success,false);
});
