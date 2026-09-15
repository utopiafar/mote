import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

const owner='synthetic-owner-token-for-browser-tests';
const auth=(token=owner)=>({authorization:`Bearer ${token}`});
async function fixture(t:TestContext){
  const dir=await mkdtemp(join(tmpdir(),'mote-capture-browser-'));
  const config:Config={dataDir:dir,token:owner,tokenPath:join(dir,'token'),host:'127.0.0.1',port:0,
    dataKey:'31'.repeat(32),maxStorageBytes:20_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,
    allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
  const value=await buildApp(config,{agent:{configured:false,query:async()=>{throw Error('No model calls in fixtures');},close:async()=>{}}});
  t.after(async()=>{await value.app.close();await rm(dir,{recursive:true,force:true});});
  const image=await sharp({create:{width:960,height:640,channels:3,background:'#4e8060'}}).jpeg().toBuffer();
  const capture=(deviceId='phone')=>({id:randomUUID(),deviceId,deviceName:'Generated device',platform:'android',capturedAt:'2026-09-13T12:00:00.000Z',
    durationMs:0,appId:'',appName:'',windowTitle:'',source:'screen',imageMime:'image/jpeg',imageBase64:image.toString('base64'),ocrText:'',ocr:{status:'pending',reason:'charging'}});
  const paired=async(deviceId='phone')=>{
    const invite=await value.app.inject({method:'POST',url:'/api/connections/invitations',headers:auth(),payload:{serverUrl:'https://fixture.invalid',label:'Generated phone'}});
    const redeem=await value.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invite.json().invitation.code,deviceId,deviceName:'Generated device',platform:'android'}});
    assert.equal(redeem.statusCode,200);return redeem.json() as {token:string;credentialId:string};
  };
  return {...value,capture,paired,image};
}

test('capture browser isolates collector lists, details, thumbnails and OCR writes',async t=>{
  const {app,capture,paired}=await fixture(t),phone=await paired(),own=capture(),foreign=capture('other');
  for(const record of [own,foreign])assert.equal((await app.inject({method:'POST',url:'/api/captures',headers:auth(),payload:record})).statusCode,201);
  for(const url of ['/api/capture-browser',`/api/capture-browser/${own.id}`,`/api/capture-browser/${own.id}/image?thumbnail=1`])assert.equal((await app.inject(url)).statusCode,401);
  const list=await app.inject({url:'/api/capture-browser?after=2026-09-13T00:00:00Z&before=2026-09-14T00:00:00Z',headers:auth(phone.token)});
  assert.equal(list.statusCode,200);assert.equal(list.json().totalCount,1);assert.equal(list.json().items[0].id,own.id);
  assert.deepEqual(list.json().items[0].ocr,{status:'pending',reason:'charging'});assert.equal(list.json().items[0].hasImage,true);
  assert.equal('ocrText' in list.json().items[0],false);assert.equal(list.headers['cache-control'],'no-store');
  assert.equal((await app.inject({url:'/api/capture-browser?deviceId=other',headers:auth(phone.token)})).statusCode,403);
  for(const suffix of ['', '/image', '/image?thumbnail=1'])assert.equal((await app.inject({url:`/api/capture-browser/${foreign.id}${suffix}`,headers:auth(phone.token)})).statusCode,404);
  assert.equal((await app.inject({method:'POST',url:`/api/capture-browser/${foreign.id}/ocr`,headers:auth(phone.token),payload:{status:'completed',ocrText:'No access'}})).statusCode,404);
  for (const scope of ['deviceId=other', 'source=activity']) assert.equal((await app.inject({url:`/api/capture-browser/${own.id}/image?thumbnail=1&${scope}`,headers:auth()})).statusCode,404);
  const thumb=await app.inject({url:`/api/capture-browser/${own.id}/image?thumbnail=1`,headers:auth(phone.token)});
  assert.equal(thumb.statusCode,200);assert.equal(thumb.headers['content-type'],'image/jpeg');assert.equal(thumb.headers['cache-control'],'no-store');
  const meta=await sharp(thumb.rawPayload).metadata();assert.equal(meta.width,480);assert.equal(meta.height,320);
  await app.inject({method:'DELETE',url:`/api/connections/${phone.credentialId}`,headers:auth()});
  assert.equal((await app.inject({url:`/api/capture-browser/${own.id}/image?thumbnail=1`,headers:auth(phone.token)})).statusCode,401,'Cached thumbnails still require current authorization');
});

test('deferred OCR is idempotent, searchable, preserves image and accepts original delivery retries and exports',async t=>{
  const {app,store,capture,paired,image}=await fixture(t),phone=await paired(),record=capture(),headers=auth(phone.token);
  assert.equal((await app.inject({method:'POST',url:'/api/captures',headers,payload:record})).statusCode,201);
  const url=`/api/capture-browser/${record.id}/ocr`,payload={status:'completed',ocrText:'Generated charging backlog text 充电补识别'};
  const failed=await app.inject({method:'POST',url,headers,payload:{status:'failed',ocrText:''}});
  assert.equal(failed.statusCode,200);assert.equal(failed.json().ocr.status,'failed');
  assert.deepEqual(store.image(record.id).bytes,image,'A failed OCR attempt must preserve the screenshot for retry');
  const completed=await app.inject({method:'POST',url,headers,payload});assert.equal(completed.statusCode,200,completed.body);assert.equal(completed.json().id,record.id);
  const revision=store.deletionRevision();
  assert.equal((await app.inject({method:'POST',url,headers,payload})).json().duplicate,true);assert.equal(store.deletionRevision(),revision);
  assert.equal((await app.inject({method:'POST',url:'/api/captures',headers,payload:record})).statusCode,200,'Original event retry after lost acknowledgement must succeed');
  const detail=(await app.inject({url:`/api/capture-browser/${record.id}`,headers})).json();assert.equal(detail.ocrText,payload.ocrText);assert.equal(detail.ocr.status,'completed');
  assert.equal(store.search({query:'补识别'}).length,1);assert.deepEqual(store.image(record.id).bytes,image);
  assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,ocrText:'Overwrite successful evidence'}})).statusCode,409);
  const archive=(await app.inject({url:'/api/export',headers:auth()})).json();
  const merged=await app.inject({method:'POST',url:'/api/import',headers:auth(),payload:archive});assert.equal(merged.statusCode,200,merged.body);assert.equal(merged.json().duplicates,1);
  const restored=await fixture(t);
  assert.equal((await restored.app.inject({method:'POST',url:'/api/import',headers:auth(),payload:archive})).statusCode,200);
  assert.equal((await restored.app.inject({method:'POST',url:'/api/captures',headers:auth(),payload:record})).statusCode,200,'Portable archive restore accepts unchanged pending delivery');
  assert.equal((await restored.app.inject({method:'POST',url:'/api/captures',headers:auth(),payload:{...record,appName:'Changed identity'}})).statusCode,409);
  assert.equal(restored.store.evidence([record.id])[0].ocrText,payload.ocrText);
  assert.equal((await app.inject({url:'/api/capture-browser?ocrStatus=completed',headers})).json().totalCount,1);
  assert.equal((await app.inject({url:'/api/capture-browser?ocrStatus=pending',headers})).json().totalCount,0);
  await app.inject({method:'DELETE',url:`/api/captures/${record.id}`,headers:auth()});
  const missing=await app.inject({method:'POST',url,headers,payload});assert.equal(missing.statusCode,404);assert.equal(missing.json().error,'capture_not_found');
  assert.equal((await app.inject({method:'POST',url:'/api/captures',headers,payload:record})).statusCode,410);
});

test('OCR body budget accepts the full character limit even with JSON escaping',async t=>{
  const {app,capture}=await fixture(t),record=capture();
  assert.equal((await app.inject({method:'POST',url:'/api/captures',headers:auth(),payload:record})).statusCode,201);
  const url=`/api/capture-browser/${record.id}/ocr`,ocrText='\u0001'.repeat(100000);
  assert.equal((await app.inject({method:'POST',url,headers:auth(),payload:{status:'completed',ocrText:ocrText+'x'}})).statusCode,400);
  const response=await app.inject({method:'POST',url,headers:auth(),payload:{status:'completed',ocrText}});
  assert.equal(response.statusCode,200,response.body);
  assert.equal((await app.inject({url:`/api/capture-browser/${record.id}`,headers:auth()})).json().ocrText,ocrText);
});

test('browser pagination, status fallbacks and empty completed OCR remain honest',async t=>{
  const {app,capture}=await fixture(t),records=[capture(),capture(),capture()];
  const legacy={...records[0],ocr:undefined,ocrText:'\n\t\u3000'},disabled={...records[1],ocr:{status:'disabled'}},empty={...records[2],ocr:{status:'completed'}};
  for(const record of [legacy,disabled,empty])assert.equal((await app.inject({method:'POST',url:'/api/captures',headers:auth(),payload:record})).statusCode,201);
  const seen=new Set<string>();let cursor:string|null=null;
  do {
    const page=(await app.inject({url:'/api/capture-browser?limit=1'+(cursor?'&cursor='+encodeURIComponent(cursor):''),headers:auth()})).json();
    assert.equal(page.totalCount,3);assert.equal(page.items.length,1);assert(!seen.has(page.items[0].id));seen.add(page.items[0].id);cursor=page.nextCursor;
  }while(cursor);
  for(const [status,id] of [['unknown',legacy.id],['disabled',disabled.id],['completed',empty.id]]){
    const result=(await app.inject({url:'/api/capture-browser?ocrStatus='+status,headers:auth()})).json();assert.equal(result.totalCount,1);assert.equal(result.items[0].id,id);
  }
  assert.equal((await app.inject({url:'/api/capture-browser?before=2026-09-13T12:00:00Z',headers:auth()})).json().totalCount,0);
  for(const query of ['limit=61','after=bad','cursor=bad','ocrStatus=guess','after=2026-09-14T00:00:00Z&before=2026-09-13T00:00:00Z'])assert.equal((await app.inject({url:'/api/capture-browser?'+query,headers:auth()})).statusCode,400);
});

test('generated Android system events upload with device scope, idempotency, search and export',async t=>{
  const {app,store,paired}=await fixture(t),phone=await paired(),headers=auth(phone.token);
  const at='2026-09-15T01:02:03.000Z';
  const base={deviceId:'phone',deviceName:'Generated phone',platform:'android',capturedAt:at,durationMs:0,
    privacy:{collection:'content',mode:'none'},metadata:{version:1,observedAt:at,collector:{method:'notification_listener'},observation:{sessionId:randomUUID(),elapsedRealtimeMs:1000}}};
  const notification={id:randomUUID(),...base,source:'notification',appId:'fixture.navigation',appName:'Fixture Navigation',
    metadata:{...base.metadata,notification:{action:'posted',notificationKey:'ab'.repeat(32),postedAt:at,ongoing:true,groupSummary:false,category:'navigation',title:'Generated route 2048',text:'Turn toward fixture park'}}};
  const device={id:randomUUID(),...base,source:'device_event',metadata:{...base.metadata,deviceEvent:{action:'screen_off',keyguardLocked:false,screenInteractive:false}}};
  for(const payload of [notification,device]){
    const created=await app.inject({method:'POST',url:'/api/captures',headers,payload});assert.equal(created.statusCode,201,created.body);
    assert.equal((await app.inject({method:'POST',url:'/api/captures',headers,payload})).statusCode,200);
    const detail=await app.inject({url:`/api/capture-browser/${payload.id}`,headers});assert.deepEqual(detail.json().metadata,payload.metadata);
  }
  assert.equal(store.search({query:'2048'}).length,1);
  assert.equal((await app.inject({url:'/api/capture-browser?source=notification',headers})).json().totalCount,1);
  assert.equal((await app.inject({url:'/api/capture-browser?source=device_event',headers})).json().totalCount,1);
  assert.equal(store.activity({}).totalDurationMs,0,'No inferred activity time from notifications or screen events');
  assert.equal((await app.inject({method:'POST',url:'/api/captures',headers,payload:{...notification,id:randomUUID(),deviceId:'foreign'}})).statusCode,403);
  const invalid=await app.inject({method:'POST',url:'/api/captures',headers,payload:{...notification,id:randomUUID(),privacy:{...base.privacy,collection:'activity'}}});assert.equal(invalid.statusCode,400);
  const exported=(await app.inject({url:'/api/export',headers:auth()})).json();
  const restored=await fixture(t);const imported=await restored.app.inject({method:'POST',url:'/api/import',headers:auth(),payload:exported});assert.equal(imported.statusCode,200,imported.body);
  assert.deepEqual(restored.store.evidence([device.id])[0].metadata,device.metadata);
});

test('sync reconciliation is read-only, device-scoped and cannot acknowledge or resurrect records',async t=>{
  const {app,store,capture,paired}=await fixture(t),phone=await paired(),headers=auth(phone.token);
  const own=capture(),foreign=capture('other'),deleted=capture(),missing=randomUUID();
  for(const payload of [own,foreign,deleted])assert.equal((await app.inject({method:'POST',url:'/api/captures',headers:auth(),payload})).statusCode,201);
  store.delete(deleted.id);
  const url='/api/capture-browser/reconcile',payload={deviceId:'phone',ids:[own.id,foreign.id,deleted.id,missing]};
  assert.equal((await app.inject({method:'POST',url,payload})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,deviceId:'other'}})).statusCode,403);
  const response=await app.inject({method:'POST',url,headers,payload});assert.equal(response.statusCode,200,response.body);
  assert.deepEqual(response.json().items,payload.ids.map((id,index)=>({id,state:index===0?'present':'unavailable'})));
  assert.equal(store.evidence([deleted.id]).length,0);
  assert.equal((await app.inject({method:'POST',url:'/api/captures',headers,payload:deleted})).statusCode,410,'Full replay cannot undo a central deletion');
  assert.equal((await app.inject({method:'POST',url:'/api/captures',headers,payload:own})).statusCode,200,'Lost acknowledgement safely replays the same event');
  assert.equal((await app.inject({method:'POST',url:'/api/captures',headers,payload:{...own,appName:'Changed content'}})).statusCode,409);
  assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,ids:Array(101).fill(own.id)}})).statusCode,400);
});
