import test from 'node:test';
import assert from 'node:assert/strict';
import {actionSourceIdentitySchema,captureSchema,platformSchema,recordMetadataSchema,sourceConnectionSchema,uiPageText} from '../dist/index.js';

const at='2026-11-06T01:00:00.000Z';
const observation={version:1,observedAt:at,collector:{method:'notification_listener'},observation:{sessionId:'22222222-2222-4222-8222-222222222222',elapsedRealtimeMs:1}};
const page={scope:'visible_window',adapterId:'generated.ios',adapterVersion:'1',appVersion:'1',activity:'GeneratedPage',status:'ok',truncated:false,version:1,nodes:[{id:'1',resourceId:'fixture:text',role:'text',bounds:{x:0,y:0,width:1,height:1},text:'Generated page text'}]};

test('one platform schema admits iOS for captures, sources and action source identities',()=>{
  assert.deepEqual(platformSchema.options,['macos','windows','linux','android','ios','import']);
  assert.deepEqual(sourceConnectionSchema.parse({id:'generated-ios-source',name:'Generated iOS source',kind:'local-files',deviceId:'generated-iphone',platform:'ios'}).platform,'ios');
  assert.deepEqual(actionSourceIdentitySchema.parse({sourceId:'generated-ios-source',kind:'local-files',deviceId:'generated-iphone',platform:'ios'}).platform,'ios');
  assert.equal(captureSchema.safeParse({id:'11111111-1111-4111-8111-111111111111',deviceId:'generated-iphone',deviceName:'Generated iPhone',platform:'ios',capturedAt:at,durationMs:0,source:'notification',appId:'fixture.app',appName:'Generated app',privacy:{collection:'content'},metadata:{...observation,notification:{action:'posted',notificationKey:'ab'.repeat(32),postedAt:at,ongoing:false,groupSummary:false,title:'Generated notification'}}}).success,true);
  assert.equal(captureSchema.safeParse({id:'11111111-1111-4111-8111-111111111112',deviceId:'generated-iphone',deviceName:'Generated iPhone',platform:'ios',capturedAt:at,durationMs:0,source:'device_event',privacy:{mode:'none'},metadata:{...observation,deviceEvent:{action:'screen_off',keyguardLocked:false,screenInteractive:false}}}).success,true);
  assert.equal(captureSchema.safeParse({id:'11111111-1111-4111-8111-111111111114',deviceId:'generated-iphone',deviceName:'Generated iPhone',platform:'ios',capturedAt:at,durationMs:0,source:'ui_page',appId:'fixture.page',appName:'Generated reader',ocrText:uiPageText(page),privacy:{collection:'content'},metadata:{version:1,observedAt:at,collector:{method:'accessibility'},uiPage:page}}).success,true);
});

test('shortcuts is a first-class collector method with the same bounded metadata shape',()=>{
  const metadata={version:1,observedAt:at,collector:{version:'1.0',method:'shortcuts'}};
  assert.deepEqual(recordMetadataSchema.parse(metadata).collector,metadata.collector);
  assert.equal(captureSchema.safeParse({id:'11111111-1111-4111-8111-111111111113',deviceId:'generated-iphone',deviceName:'Generated iPhone',platform:'ios',capturedAt:at,durationMs:0,source:'note',ocrText:'Generated shared original',metadata}).success,true);
});

test('iOS Shortcuts notifications are posted observations and require observer provenance',()=>{
  const notification={action:'posted',notificationKey:'ab'.repeat(32),postedAt:at,ongoing:false,groupSummary:false,title:'Generated notification'};
  const base={id:'11111111-1111-4111-8111-111111111115',deviceId:'generated-iphone',deviceName:'Generated iPhone',platform:'ios',capturedAt:at,durationMs:0,source:'notification',appId:'fixture.app',appName:'Generated app',privacy:{collection:'content'},metadata:{version:1,observedAt:at,collector:{method:'shortcuts'},observation:{sessionId:'22222222-2222-4222-8222-222222222222',elapsedRealtimeMs:0},notification}};
  assert.equal(captureSchema.safeParse(base).success,true);
  for(const action of ['updated','removed'])assert.equal(captureSchema.safeParse({...base,metadata:{...base.metadata,notification:{...notification,action}}}).success,false);
  assert.equal(captureSchema.safeParse({...base,metadata:{...base.metadata,collector:{method:'notification_listener'}}}).success,true,'the existing listener provenance remains valid');
  assert.equal(captureSchema.safeParse({...base,platform:'android'}).success,false,'Shortcuts is not observer provenance on Android');
});
