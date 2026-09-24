import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ContextReader} from '@mote/agent';
import type {Config} from '../src/config.js';
import {Store} from '../src/store.js';
import {Indexer} from '../src/indexer.js';
import {buildApp} from '../src/app.js';

const at=(second:number)=>new Date(Date.UTC(2026,8,12,1,0,second)).toISOString();
const session=(overrides:Record<string,unknown>={})=>({sessionId:'generated-session',appId:'fixture.player',appName:'Generated player',playbackState:'playing',appVisibility:'background',playbackType:'local',title:'虚构海边故事',artist:'Generated narrator',album:'Generated album',...overrides});
const record=(overrides:Record<string,unknown>={},mediaSession:Record<string,unknown>=session())=>({id:randomUUID(),deviceId:'phone',deviceName:'Generated phone',platform:'android',capturedAt:at(20),durationMs:20000,source:'media',appId:mediaSession.appId,appName:mediaSession.appName,ocrText:'',windowTitle:'',privacy:{collection:'content'},metadata:{version:1,observedAt:at(20),state:{screenLocked:true},media:{status:'available',sessions:[mediaSession]}},...overrides});
function fixture(t:TestContext,embeddingEnabled=false){const directory=mkdtempSync(join(tmpdir(),'mote-media-fixture-')),store=new Store(directory,{embeddingEnabled});t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return store;}

test('media is searchable original metadata, has a useful preview, and survives retries and archive restore',async t=>{
  const store=fixture(t,true),restored=fixture(t),value=record();
  const inserted=await store.ingest(value);assert.equal(inserted.duplicate,false);assert.equal((await store.ingest(value)).duplicate,true);
  const saved=store.evidence([value.id])[0];assert.equal(saved.blobHash,null);assert.equal(saved.ocrText,'');assert.equal(saved.windowTitle,'');assert.equal(saved.indexingStatus,'text_ready');
  for(const query of ['海边','narrator','Generated album','fixture.player'])assert.equal(store.search({query,source:'media'})[0]?.id,value.id);
  const preview=store.previews({source:'media'}).items[0];assert.deepEqual(preview.media,value.metadata.media);assert.match(preview.textPreview,/虚构海边故事/);assert.equal(preview.hasImage,false);assert.equal(preview.ocr.status,'not_applicable');
  assert.equal(store.stats().mediaEvents,1);assert.equal(store.stats().activityEvents,0);assert.equal(store.pending().length,0);assert.equal(store.retryIndex().queued,0);
  const indexer=new Indexer(store,{embeddingModel:'generated',embeddingBaseUrl:'https://fixture.invalid',embeddingApiKey:''});t.after(()=>indexer.close());
  indexer.embed=async()=>{throw new Error('Media lexical retrieval must not invoke a model');};
  assert.equal((await indexer.search({source:'media',query:'海边'}))[0].id,value.id);
  await assert.rejects(store.ingest({...value,metadata:{...value.metadata,media:{status:'available',sessions:[session({title:'Changed'})]}}}),{statusCode:409});
  await restored.importArchive(store.exportArchive(1000000));assert.deepEqual(restored.evidence([value.id])[0],saved);assert.equal(restored.search({query:'海边'})[0].id,value.id);
  assert.deepEqual(restored.mediaActivity(),store.mediaActivity());
  store.delete(value.id);assert.equal(store.mediaActivity().totalDurationMs,0);assert.equal(store.search({query:'海边'}).length,0);
});

test('existing vault search migration rebuilds media terms atomically without changing immutable evidence',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-media-migration-'));let store=new Store(directory);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const value=record();await store.ingest(value);const saved=store.evidence([value.id])[0];
  store.db.prepare('UPDATE captures_fts SET text=? WHERE id=?').run('Legacy app-only index',value.id);
  store.db.prepare('DELETE FROM settings WHERE key=?').run('search_text_version');store.close();store=new Store(directory);
  assert.deepEqual(store.evidence([value.id])[0],saved);assert.equal((await store.ingest(value)).duplicate,true);
  assert.equal(store.db.prepare('SELECT id FROM captures_fts WHERE captures_fts MATCH ?').get('"Generated narrator"')?.id,value.id);
  assert.equal(store.db.prepare('SELECT value FROM settings WHERE key=?').get('search_text_version')?.value,'2');
  store.close();store=new Store(directory);assert.equal(store.previews().totalCount,1);assert.equal(store.search({query:'海边'})[0].id,value.id);
});

test('multi-session point snapshots match media app filters while screenshot app filters keep foreground meaning',async t=>{
  const store=fixture(t),sessions=[session(),session({sessionId:'other-session',appId:'fixture.other'})];
  const point=record({durationMs:0,appId:'',appName:'',metadata:{version:1,observedAt:at(20),media:{status:'available',sessions}}});
  await store.ingest(point);await store.ingest(record({source:'screen',appId:'fixture.foreground',ocrText:'Generated screen text'}));
  assert.equal(store.list({appId:'fixture.other',source:'media'}).totalCount,1);assert.equal(store.search({appId:'fixture.other',query:'narrator'})[0].id,point.id);
  assert.equal(store.previews({appId:'fixture.player'}).totalCount,1,'Background media must not change the meaning of screenshot app filters');
  assert.equal(store.mediaActivity({appId:'fixture.other'}).observations,1);assert.equal(store.mediaActivity({appId:'fixture.other'}).totalDurationMs,0);
});

test('screen metadata can be searched and remains in previews after OCR completion without adding media time',async t=>{
  const sharp=(await import('sharp')).default;
  const image=await sharp({create:{width:20,height:20,channels:3,background:'#669977'}}).jpeg().toBuffer();
  const store=fixture(t),value=record({source:'screen',durationMs:15000,imageBase64:image.toString('base64'),imageMime:'image/jpeg',ocr:{status:'pending'}});
  await store.ingest(value);assert.equal(store.search({query:'海边'})[0].id,value.id);assert.equal(store.mediaActivity().observations,0);assert.equal(store.activity().totalDurationMs,15000);
  store.completeOcr(value.id,{status:'completed',ocrText:'Generated screenshot text'});
  assert.equal(store.search({query:'海边'})[0].ocrText,'Generated screenshot text');assert.ok(store.previews().items[0].media);
});

test('measured playback unions overlapping sessions per app and device, clips boundaries, and stays separate from screen time',async t=>{
  const store=fixture(t);
  const values=[record(),record({capturedAt:at(25)},session({sessionId:'second-session'})),record({capturedAt:at(30),metadata:{version:1,observedAt:at(30),state:{screenLocked:false},media:{status:'available',sessions:[session({appId:'fixture.other',appVisibility:'foreground',playbackType:'remote'})]}}},session({appId:'fixture.other'})),record({deviceId:'second-phone'}),record({capturedAt:at(60),durationMs:0},session({playbackState:'paused'}))];
  for(const value of values)await store.ingest(value);
  await store.ingest(record({source:'screen',capturedAt:at(40),durationMs:15000,ocrText:'Generated screen'}));
  const all=store.mediaActivity();assert.equal(all.totalDurationMs,50000);assert.equal(all.playingSamples,4);assert.equal(all.observations,5);
  assert.deepEqual(all.apps.map(app=>[app.appId,app.durationMs]),[['fixture.player',45000],['fixture.other',20000]]);
  assert.deepEqual(all.devices.map(device=>[device.deviceId,device.durationMs]),[['phone',30000],['second-phone',20000]]);
  assert.deepEqual(all.visibility,{foreground:20000,background:45000,unknown:0});assert.deepEqual(all.screenLock,{locked:45000,unlocked:20000,unknown:0});assert.deepEqual(all.playbackType,{local:45000,remote:20000,unknown:0});
  assert.equal(all.accounting,'union_per_device_sum_across_devices');assert.equal(all.breakdownsMayOverlap,true);
  assert.equal(store.mediaActivity({after:at(12),before:at(18)}).totalDurationMs,12000);
  assert.equal(store.mediaActivity({after:at(12),before:at(18),deviceId:'phone',appId:'fixture.other'}).totalDurationMs,6000,'An interval captured after before still overlaps the requested range');
  assert.equal(store.mediaActivity({appVisibility:'foreground'}).totalDurationMs,20000);assert.equal(store.mediaActivity({screenLocked:true}).totalDurationMs,45000);assert.equal(store.mediaActivity({playbackType:'remote'}).totalDurationMs,20000);
  assert.equal(store.mediaActivity({source:'screen'}).totalDurationMs,0);assert.equal(store.activity().totalDurationMs,15000);
  assert.deepEqual(new Set(all.evidenceIds),new Set(values.map(value=>value.id)));assert.equal(all.evidenceTruncated,false);
});

test('streamed unions handle containing intervals, arrival disorder and exact exclusive boundaries',async t=>{
  const store=fixture(t);
  await store.ingest(record({capturedAt:at(50),durationMs:10000}));
  await store.ingest(record({capturedAt:at(60),durationMs:60000}));
  await store.ingest(record({capturedAt:at(20),durationMs:0}));
  assert.equal(store.mediaActivity().totalDurationMs,60000);
  assert.equal(store.mediaActivity({after:at(20),before:at(50)}).totalDurationMs,30000);
  assert.equal(store.mediaActivity({before:at(0)}).observations,0);
  assert.equal(store.mediaActivity({after:at(60)}).totalDurationMs,0);
});

test('pause, missing permissions and long gaps remain observations with no invented listening time',async t=>{
  const store=fixture(t);
  for(const state of ['playing','paused','stopped','buffering','unknown'])await store.ingest(record({durationMs:0},session({playbackState:state})));
  for(const status of ['disabled','permission_required','unavailable'])await store.ingest(record({durationMs:0,appId:'',appName:'',metadata:{version:1,observedAt:at(20),media:{status,sessions:[]}}}));
  const values=store.mediaActivity();assert.equal(values.totalDurationMs,0);assert.equal(values.playingSamples,0);assert.equal(values.observations,8);assert.deepEqual(values.availability,{available:5,disabled:1,permission_required:1,unavailable:1});
  assert.equal(store.mediaActivity({before:at(20)}).observations,0);assert.equal(store.mediaActivity({appId:'fixture.player'}).observations,5);
  assert.ok(store.previews().items.every(value=>value.textPreview.length>0));
  await store.ingest(record({capturedAt:at(600),durationMs:15000}));assert.equal(store.mediaActivity().totalDurationMs,15000,'No interval is inferred between distant state observations');
});

test('activity-only media remains content-free and queryable while invalid duration/content combinations cannot persist',async t=>{
  const store=fixture(t),{title:_title,artist:_artist,album:_album,...privateSession}=session();
  const value=record({privacy:{collection:'activity'}},privateSession);await store.ingest(value);
  assert.equal(store.list({collection:'activity',source:'media'}).totalCount,1);assert.equal(store.list({collection:'content',source:'media'}).totalCount,0);
  assert.equal(store.mediaActivity({collection:'activity'}).totalDurationMs,20000);assert.equal(store.mediaActivity({collection:'content'}).totalDurationMs,0);assert.equal(store.search({query:'海边'}).length,0);
  for(const patch of [{privacy:{collection:'activity'}},{durationMs:60001},{durationMs:1000,metadata:{version:1,observedAt:at(20),media:{status:'available',sessions:[session({playbackState:'paused'})]}}},{ocrText:'Injected content'},{windowTitle:'Injected title'},{appId:'wrong-app'}])await assert.rejects(store.ingest(record(patch)));
  assert.equal(store.stats().captures,1);
});

test('media evidence references are bounded without truncating interval totals or observation counts',async t=>{
  const store=fixture(t);for(let i=0;i<101;i++)await store.ingest(record({capturedAt:at(i),durationMs:1000}));
  const result=store.mediaActivity();assert.equal(result.totalDurationMs,101000);assert.equal(result.observations,101);assert.equal(result.evidenceIds.length,100);assert.equal(result.evidenceTruncated,true);assert.equal(result.apps[0].evidenceTruncated,true);
});

test('media API scopes collector reads and writes to its device and exposes a read-only agent reader',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-media-api-')),token='generated-media-owner-token';
  const config:Config={dataDir:directory,token,tokenPath:join(directory,'token'),host:'127.0.0.1',port:0,maxStorageBytes:10000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
  let reader:ContextReader|undefined;
  const {app}=await buildApp(config,{createModelAgent:async(_settings,value)=>{reader=value;return {configured:false,query:async()=>{throw new Error('No live model');},close:async()=>{}};}});
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const owner={authorization:`Bearer ${token}`};
  const invitation=(await app.inject({method:'POST',url:'/api/connections/invitations',headers:owner,payload:{serverUrl:'https://fixture.invalid',label:'Generated phone'}})).json();
  const paired=(await app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invitation.invitation.code,deviceId:'phone',deviceName:'Generated phone',platform:'android'}})).json();
  const collector={authorization:`Bearer ${paired.token}`,'x-mote-ingress-version':'2'},own=record(),foreign=record({deviceId:'another-phone'});
  assert.equal((await app.inject({method:'POST',url:'/api/captures',headers:collector,payload:own})).statusCode,201);
  assert.equal((await app.inject({method:'POST',url:'/api/captures',headers:collector,payload:foreign})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/captures',headers:owner,payload:foreign})).statusCode,201);
  assert.equal((await app.inject('/api/media-activity')).statusCode,401);
  const all=(await app.inject({url:'/api/media-activity',headers:owner})).json();assert.equal(all.totalDurationMs,40000);
  const scoped=(await app.inject({url:'/api/media-activity',headers:collector})).json();assert.equal(scoped.totalDurationMs,20000);assert.deepEqual(scoped.evidenceIds,[own.id]);
  assert.equal((await app.inject({url:'/api/media-activity?deviceId=another-phone',headers:collector})).statusCode,403);
  assert.equal((await app.inject({url:'/api/capture-browser?source=media',headers:collector})).json().items[0].media.sessions[0].title,'虚构海边故事');
  for(const query of ['screenLocked=maybe','after=bad','appVisibility=guess','after='+at(20)+'&before='+at(10)])assert.equal((await app.inject({url:'/api/media-activity?'+query,headers:owner})).statusCode,400);
  assert.equal((await app.inject({url:'/api/media-activity?screenLocked=false',headers:owner})).json().totalDurationMs,0);
  assert.deepEqual(await reader!.mediaActivity!({deviceId:'phone'}),scoped);
  await app.inject({method:'DELETE',url:'/api/connections/'+paired.credentialId,headers:owner});
  assert.equal((await app.inject({url:'/api/media-activity',headers:collector})).statusCode,401);
});
