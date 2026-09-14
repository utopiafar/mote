import test from 'node:test';
import assert from 'node:assert/strict';
import {captureSchema, recordMetadataSchema, captureOcrState} from '../dist/index.js';

const at='2026-09-15T02:00:00.000Z';
const session={sessionId:'generated-session',appId:'test.player',appName:'Fixture Player',playbackState:'playing',appVisibility:'background',playbackType:'local',title:'Generated chapter',artist:'Generated author',positionMs:20000,durationMs:120000,playbackSpeed:1.25};
const metadata={version:1,observedAt:at,collector:{method:'media_session'},state:{screenLocked:true,screenInteractive:false},media:{status:'available',sessions:[session]}};
const record={id:'11111111-1111-4111-8111-111111111111',deviceId:'fixture-phone',deviceName:'Generated phone',platform:'android',capturedAt:at,durationMs:30000,appId:session.appId,appName:session.appName,source:'media',metadata,privacy:{collection:'content',mode:'none'}};

test('locked-screen media carries provider evidence without requiring a screenshot or OCR',()=>{
  const parsed=captureSchema.parse(record);
  assert.equal(parsed.ocrText,'');assert.equal(parsed.windowTitle,'');assert.equal(parsed.metadata.media.sessions[0].title,'Generated chapter');
  assert.deepEqual(captureOcrState(parsed),{status:'not_applicable'});
  assert.equal(captureSchema.safeParse({...record,source:'screen',ocrText:'Generated screenshot text'}).success,true);
});
test('media interval validation refuses unmeasured states, mismatched apps and excessive gaps',()=>{
  for(const patch of [{durationMs:60001},{appId:'another.app'},{appName:'Another Player'},{metadata:undefined},{imageBase64:'AAAA',imageMime:'image/png'},{ocrText:'cannot become OCR'},{windowTitle:'cannot become screen title'},{ocr:{status:'completed'}}])
    assert.equal(captureSchema.safeParse({...record,...patch}).success,false,JSON.stringify(patch));
  for(const playbackState of ['paused','buffering','stopped','unknown']) {
    const changed={...record,metadata:{...metadata,media:{status:'available',sessions:[{...session,playbackState}]}}};
    assert.equal(captureSchema.safeParse(changed).success,false);
    assert.equal(captureSchema.safeParse({...changed,durationMs:0}).success,true);
  }
  assert.equal(captureSchema.safeParse({...record,metadata:{...metadata,media:{status:'available',sessions:[session,{...session,sessionId:'second'}]}}}).success,false);
});
test('permission and unavailable observations remain explicit and cannot contain stale media sessions',()=>{
  for(const status of ['disabled','permission_required','unavailable']) {
    const changed={...metadata,media:{status,sessions:[]}};
    assert.equal(captureSchema.safeParse({...record,durationMs:0,appId:'',appName:'',metadata:changed}).success,true);
    assert.equal(recordMetadataSchema.safeParse({...metadata,media:{status,sessions:[session]}}).success,false);
  }
  assert.equal(recordMetadataSchema.safeParse({...metadata,media:{status:'available',sessions:[]}}).success,true);
  assert.equal(recordMetadataSchema.safeParse({...metadata,media:{status:'available',sessions:[session,session]}}).success,false);
});
test('activity-only privacy rejects media content fields even when attached to a foreground sample',()=>{
  const privacy={collection:'activity',mode:'none'};
  for(const source of ['activity','media']) {
    assert.equal(captureSchema.safeParse({...record,source,privacy}).success,false);
    const stripped={...session};delete stripped.title;delete stripped.artist;
    assert.equal(captureSchema.safeParse({...record,source,privacy,metadata:{...metadata,media:{status:'available',sessions:[stripped]}}}).success,true);
    for(const field of ['title','artist','album','displaySubtitle','mediaId'])
      assert.equal(captureSchema.safeParse({...record,source,privacy,metadata:{...metadata,media:{status:'available',sessions:[{...stripped,[field]:''}]}}}).success,false);
  }
});
test('media has bounded strict metadata and does not accept semantic classifications or arbitrary notification data',()=>{
  for(const patch of [{title:'x'.repeat(1001)},{notificationText:'private'},{genre:'audiobook'},{playbackSpeed:Infinity},{positionMs:-1},{durationMs:Number.MAX_SAFE_INTEGER+1}])
    assert.equal(recordMetadataSchema.safeParse({...metadata,media:{status:'available',sessions:[{...session,...patch}]}}).success,false);
  assert.equal(recordMetadataSchema.safeParse({...metadata,media:{status:'available',sessions:Array.from({length:17},(_,i)=>({...session,sessionId:String(i)}))}}).success,false);
});
