import {fixtureCaptureRefs} from './fixtures/evidence-refs.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {materialId,type MaterialDraft} from '../src/materials.js';

const owner='synthetic-owner-token-for-browser-tests';
const auth=(token=owner)=>({authorization:`Bearer ${token}`,'x-mote-ingress-version':'2'});
async function fixture(t:TestContext){
  const dir=await mkdtemp(join(tmpdir(),'mote-capture-browser-'));
  const config:Config={dataDir:dir,token:owner,tokenPath:join(dir,'token'),host:'127.0.0.1',port:0,
    dataKey:'31'.repeat(32),maxStorageBytes:20_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,
    allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
  const value=await buildApp(config,{agent:{configured:false,query:async()=>{throw Error('No model calls in fixtures');},close:async()=>{}}});
  t.after(async()=>{await value.app.close();await rm(dir,{recursive:true,force:true});});
  const image=await sharp({create:{width:960,height:640,channels:3,background:'#4e8060'}}).jpeg().toBuffer();
  const capture=(deviceId='phone')=>({id:randomUUID(),deviceId,deviceName:'Generated device',platform:'android',capturedAt:'2026-09-13T12:00:00.000Z',
    durationMs:0,appId:'',appName:'',windowTitle:'',source:'screen',imageMime:'image/jpeg',imageBase64:image.toString('base64'),ocrText:'',ocr:{status:'pending'}});
  const paired=async(deviceId='phone')=>{
    const invite=await value.app.inject({method:'POST',url:'/api/connections/invitations',headers:auth(),payload:{serverUrl:'https://fixture.invalid',label:'Generated phone'}});
    const redeem=await value.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invite.json().invitation.code,deviceId,deviceName:'Generated device',platform:'android'}});
    assert.equal(redeem.statusCode,200);return redeem.json() as {token:string;credentialId:string};
  };
  return {...value,capture,paired,image};
}

test('capture details declare native file storage for import sources without exposing foreign records',async t=>{
  const {app,files,sources,capture,paired}=await fixture(t);
  sources.register({id:'generated-import',name:'Generated import',kind:'local-files',deviceId:'importer',platform:'import',retention:'archive'});
  const ack=await files.revision({sourceId:'generated-import',previousRevision:null,item:{externalId:'generated.wav',revision:'1',observedAt:'2026-09-13T12:00:00.000Z',title:'Generated recording',kind:'file',layer:'reference',text:'',mimeType:'audio/wav',deleted:false},relativePath:'generated.wav',sizeBytes:10},()=>{});
  const url=`/api/capture-browser/${ack.id}`;
  const detail=await app.inject({url,headers:auth()});assert.equal(detail.statusCode,200,detail.body);
  assert.equal(detail.json().platform,'import');assert.deepEqual(detail.json().fileArchive,{captureId:ack.id});
  assert.equal(detail.json().requiresMaterialForMemory,true);
  assert.match(detail.json().memoryMaterialRef,/^material:mat_[a-f0-9]{64}@[a-f0-9]{64}$/,
    'the organizer may already have published a current Material; owner navigation uses its stored relationship');
  const phone=await paired();assert.equal((await app.inject({url,headers:auth(phone.token)})).statusCode,200);
  const ordinary=capture();await app.inject({method:'POST',url:'/api/captures',headers:auth(),payload:ordinary});
  assert.equal((await app.inject({url:`/api/capture-browser/${ordinary.id}`,headers:auth()})).json().fileArchive,undefined);
  assert.equal((await app.inject({url:`/api/capture-browser/${ordinary.id}`,headers:auth()})).json().requiresMaterialForMemory,false);
});

test('scoped owner Memory and evidence views retain corrected formal quotes without admitting them to model reads',async t=>{
  const node=await fixture(t),{app,store,materials,memories,featureServices}=node,reader=featureServices.evidenceReader;
  node.materialOrganizer.tick=async()=>0;
  const externalId='generated-note',at='2026-09-13T12:00:00.000Z';
  node.sources.register({id:'generated-materials',name:'Generated source',kind:'custom',deviceId:'generated-owner',platform:'import'});
  const {id}=await node.sources.upsert('generated-materials',{externalId,revision:'1',observedAt:at,title:'Generated original',kind:'message',layer:'snapshot',text:'Generated original',deleted:false});
  const draft:MaterialDraft={id:materialId('generated-materials',externalId),kind:'mote.note',schemaVersion:1,title:'Generated corrected material',origin:{sourceId:'generated-materials',externalId,deviceId:'generated-owner',firstAt:at,lastAt:at},blocks:[{id:'body',kind:'text',format:'plain',text:'Generated old claim',memberIds:['original'],evidenceContext:{observedAt:at,document:{timeBasis:'unknown',contentRole:'other'}}}],members:[{id:'original',kind:'capture',ref:'capture:'+id}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}};
  const initial=materials.publish(draft),anchor=materials.evidence(materials.evidenceIds(initial.ref))[0];
  const originalDetail=await app.inject({url:`/api/capture-browser/${id}`,headers:auth()});
  const anchorDetail=await app.inject({url:`/api/capture-browser/${anchor.id}`,headers:auth()});
  assert.equal(originalDetail.json().requiresMaterialForMemory,true);
  assert.equal(originalDetail.json().memoryMaterialRef,initial.ref,'trusted current source head maps raw original to published Material');
  assert.equal(anchorDetail.json().memoryMaterialRef,initial.ref,'formal anchor maps to its current Material');
  const memory=memories.publish(memories.extract(fixtureMemoryResult(memories,{answer:JSON.stringify({memories:[{title:'Generated memory',statement:`Generated old claim [${anchor.id}]`,uncertainty:'Generated fixture',admission:{layer:'memory',reason:'Generated explicit claim',scope:'Generated fixture',attribution:'user'},evidenceIds:[anchor.id],evidence:[{id:anchor.id,quote:anchor.ocrText}]}]}),citations:[{id:anchor.id,capturedAt:at,appName:'Generated',excerpt:anchor.ocrText}],trace:[],runId:'generated'}),'fixture').items[0].id);
  assert.equal(reader.evidence(fixtureCaptureRefs([anchor.id])).length,1);
  materials.publish({...draft,blocks:[{...draft.blocks[0],text:'Generated new claim'}]},{expectedRevision:initial.revision});assert.equal(memories.get(memory.id).status,'stale');assert.deepEqual(reader.evidence(fixtureCaptureRefs([anchor.id])),[]);
  const scope=new URLSearchParams({deviceId:'generated-owner',after:'2026-09-13T00:00:00.000Z',before:'2026-09-14T00:00:00.000Z'});
  const list=await app.inject({url:'/api/memories?includeStale=true&'+scope,headers:auth()});assert.deepEqual(list.json().items.map((m:any)=>m.id),[memory.id]);
  assert.equal((await app.inject({url:`/api/memories/${memory.id}?${scope}`,headers:auth()})).json().status,'stale');
  const retained=await app.inject({url:`/api/capture-browser/${anchor.id}?${scope}`,headers:auth()});assert.equal(retained.statusCode,200,retained.body);assert.equal(retained.json().ocrText,anchor.ocrText);assert.equal(retained.json().revisionState,'historical');
  assert.equal(retained.json().provenance.externalId,externalId);assert.equal(retained.json().provenance.revision,'1');assert.equal(retained.json().source,'message');
  assert.equal((await app.inject({url:`/api/memories/${memory.id}/evidence?${scope}`,headers:auth()})).json().items[0].ocrText,anchor.ocrText);
  for(const query of ['deviceId=other','after=2026-09-14T00%3A00%3A00.000Z','sourceId=other','source=screen']){
    assert.equal((await app.inject({url:'/api/memories?includeStale=true&'+query,headers:auth()})).json().items.length,0);
    assert.equal((await app.inject({url:`/api/capture-browser/${anchor.id}?${query}`,headers:auth()})).statusCode,404);
  }
  assert.equal(reader.memoryPage({...Object.fromEntries(scope),includeStale:true}).items.length,0,'default/model-facing scope does not widen to historical evidence');
  store.delete(id);assert.equal((await app.inject({url:`/api/capture-browser/${anchor.id}`,headers:auth()})).statusCode,404,'removing originals still prevents archive disclosure');
});

test('paired clients browse the full archive and preserve explicit view filters',async t=>{
  const {app,capture,paired}=await fixture(t),phone=await paired(),own=capture(),foreign=capture('other');
  for(const record of [own,foreign])assert.equal((await app.inject({method:'POST',url:'/api/captures',headers:auth(),payload:record})).statusCode,201);
  for(const url of ['/api/capture-browser',`/api/capture-browser/${own.id}`,`/api/capture-browser/${own.id}/image?thumbnail=1`])assert.equal((await app.inject(url)).statusCode,401);
  const list=await app.inject({url:'/api/capture-browser?deviceId=phone&after=2026-09-13T00:00:00Z&before=2026-09-14T00:00:00Z',headers:auth(phone.token)});
  assert.equal(list.statusCode,200);assert.equal(list.json().totalCount,1);assert.equal(list.json().items[0].id,own.id);
  assert.deepEqual(list.json().items[0].ocr,{status:'pending'});assert.equal(list.json().items[0].hasImage,true);
  assert.equal('ocrText' in list.json().items[0],false);assert.equal(list.headers['cache-control'],'no-store');
  assert.equal((await app.inject({url:'/api/capture-browser?deviceId=other',headers:auth(phone.token)})).statusCode,200);
  for(const suffix of ['', '/image', '/image?thumbnail=1'])assert.equal((await app.inject({url:`/api/capture-browser/${foreign.id}${suffix}`,headers:auth(phone.token)})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:`/api/capture-browser/${foreign.id}/ocr`,headers:auth(phone.token),payload:{status:'completed',ocrText:'Generated owner access'}})).statusCode,200);
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
  for(const [status,id] of [['unknown',legacy.id],['pending',disabled.id],['completed',empty.id]]){
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
  assert.equal((await app.inject({method:'POST',url:'/api/captures',headers,payload:{...notification,id:randomUUID(),deviceId:'foreign'}})).statusCode,201);
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
  assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,deviceId:'other'}})).statusCode,200);
  const response=await app.inject({method:'POST',url,headers,payload});assert.equal(response.statusCode,200,response.body);
  assert.deepEqual(response.json().items,payload.ids.map((id,index)=>({id,state:index===0?'present':'unavailable'})));
  assert.equal(store.evidence([deleted.id]).length,0);
  assert.equal((await app.inject({method:'POST',url:'/api/captures',headers,payload:deleted})).statusCode,410,'Full replay cannot undo a central deletion');
  assert.equal((await app.inject({method:'POST',url:'/api/captures',headers,payload:own})).statusCode,200,'Lost acknowledgement safely replays the same event');
  assert.equal((await app.inject({method:'POST',url:'/api/captures',headers,payload:{...own,appName:'Changed content'}})).statusCode,409);
  assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,ids:Array(101).fill(own.id)}})).statusCode,400);
});

test('album and grid browsing use the lightweight projection, scope devices and keep clock boundaries',async t=>{
  const {app,store,capture,paired}=await fixture(t),phone=await paired();
  const records=[
    {...capture(),appId:'a',appName:'Generated A',capturedAt:'2026-09-13T12:14:59Z'},
    {...capture(),appId:'a',appName:'Generated A',capturedAt:'2026-09-13T12:15:00Z'},
    {...capture(),appId:'b',appName:'Generated B',capturedAt:'2026-09-13T12:15:01Z'},
    {...capture('other'),appId:'a',appName:'Other generated device'},
  ];
  for(const record of records) assert.equal((await app.inject({method:'POST',url:'/api/captures',headers:auth(),payload:record})).statusCode,201);
  const originalEvidence=store.evidence.bind(store),originalImage=store.image.bind(store);
  store.evidence=()=>{throw Error('Album/grid must not load evidence');};
  store.image=()=>{throw Error('Album/grid must not read image bytes');};
  const range='deviceId=phone&after=2026-09-13T00:00:00Z&before=2026-09-14T00:00:00Z',headers=auth(phone.token);
  const first=await app.inject({url:`/api/capture-browser/albums?${range}&limit=2`,headers});
  assert.equal(first.statusCode,200,first.body);assert.equal(first.json().albumCount,3);assert.equal(first.json().totalCount,3);
  assert.equal(first.json().items.length,2);assert.ok(first.json().nextCursor);
  assert.equal((await app.inject({url:`/api/capture-browser/albums?${range}&limit=2&cursor=${first.json().nextCursor}`,headers})).json().items.length,1);
  const album=first.json().items.find((item:{appId:string})=>item.appId==='a');
  const query=new URLSearchParams({after:album.after,before:album.before,appId:album.appId});
  const grid=await app.inject({url:`/api/capture-browser/album-images?${query}`,headers});
  assert.equal(grid.statusCode,200,grid.body);assert.equal(grid.json().items[0].id,records[1].id);assert.equal(grid.json().totalCount,1);
  assert.equal(grid.json().items[0].hasImage,true);
  for(const key of ['ocr','ocrText','metadata','blobHash','textPreview']) assert.equal(key in grid.json().items[0],false);
  for(const path of ['albums','album-images']) {
    assert.equal((await app.inject({url:`/api/capture-browser/${path}?${range}&appId=a`})).statusCode,401);
    assert.equal((await app.inject({url:`/api/capture-browser/${path}?${range.replace('deviceId=phone','deviceId=other')}&appId=a`,headers})).statusCode,200);
  }
  assert.equal((await app.inject({url:`/api/capture-browser/albums?${range}&cursor=-1`,headers})).statusCode,400);
  assert.equal((await app.inject({url:`/api/capture-browser/album-images?${range}`,headers})).statusCode,400);
  store.evidence=originalEvidence;store.image=originalImage;
  assert.equal((await app.inject({method:'DELETE',url:`/api/captures/${records[1].id}`,headers:auth()})).statusCode,200);
  assert.equal((await app.inject({url:`/api/capture-browser/album-images?${query}`,headers})).json().totalCount,0);
  await app.inject({method:'DELETE',url:`/api/connections/${phone.credentialId}`,headers:auth()});
  assert.equal((await app.inject({url:`/api/capture-browser/albums?${range}`,headers})).statusCode,401);
});

test('sessions split app returns and five-minute gaps, cross clock buckets, and preserve explicit device filters',async t=>{
  const {app,capture,paired}=await fixture(t),phone=await paired();
  const rows=[['a',899000],['a',900000],['a',1200000],['a',1500001],['b',1500002],['a',1500003]] as const;
  for(const [appId,ms] of rows)assert.equal((await app.inject({method:'POST',url:'/api/captures',headers:auth(),payload:{...capture(),appId,appName:appId,capturedAt:new Date(Date.UTC(2026,8,13)+ms).toISOString()}})).statusCode,201);
  assert.equal((await app.inject({method:'POST',url:'/api/captures',headers:auth(),payload:{...capture('foreign'),appId:'a',appName:'Generated A'}})).statusCode,201);
  const url='/api/capture-browser/sessions?deviceId=phone&after=2026-09-13T00:00:00Z&before=2026-09-14T00:00:00Z';
  assert.equal((await app.inject(url)).statusCode,401);
  const response=await app.inject({url,headers:auth(phone.token)});assert.equal(response.statusCode,200,response.body);
  const result=response.json();assert.equal(result.sessionCount,4);assert.equal(result.totalCount,6);assert.deepEqual(result.items.map((s:any)=>s.count),[1,1,1,3]);
  assert.ok(result.items.every((s:any)=>s.deviceId==='phone'));
  const images=await app.inject({url:url+'&sessionId='+result.items[3].id,headers:auth(phone.token)});
  assert.equal(images.statusCode,200,images.body);assert.equal(images.json().items.length,3);assert.ok(!images.body.includes('ocrText'));
  assert.equal((await app.inject({url:url.replace('deviceId=phone','deviceId=foreign'),headers:auth(phone.token)})).statusCode,200);
  const other=(await app.inject({url:url.replace('deviceId=phone','deviceId=foreign'),headers:auth()})).json().items[0];
  assert.equal((await app.inject({url:url+'&sessionId='+other.id,headers:auth(phone.token)})).statusCode,404);
  const first=(await app.inject({url:url+'&limit=2',headers:auth(phone.token)})).json();
  const second=(await app.inject({url:url+'&limit=2&cursor='+first.nextCursor,headers:auth(phone.token)})).json();
  assert.deepEqual([...first.items,...second.items].map(s=>s.id),result.items.map((s:any)=>s.id));
  assert.equal((await app.inject({url:url+'&cursor=invalid',headers:auth(phone.token)})).statusCode,400);
  await app.inject({method:'DELETE',url:`/api/connections/${phone.credentialId}`,headers:auth()});
  assert.equal((await app.inject({url,headers:auth(phone.token)})).statusCode,401);
});

test('session members sharing a timestamp stay separate and pages do not include a returned app',async t=>{
  const {app,capture}=await fixture(t),at='2026-09-13T12:00:00.000Z';
  const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
  for(let i=0;i<ids.length;i++)assert.equal((await app.inject({method:'POST',url:'/api/captures',headers:auth(),payload:{...capture(),id:ids[i],appId:i===1?'b':'a',appName:i===1?'Generated B':'Generated A',capturedAt:at}})).statusCode,201);
  const url='/api/capture-browser/sessions?deviceId=phone&after=2026-09-13T00:00:00Z&before=2026-09-14T00:00:00Z';
  assert.equal((await app.inject({url,headers:auth()})).json().sessionCount,3);
  for(const id of ids){const page=(await app.inject({url:url+'&sessionId='+id,headers:auth()})).json();assert.deepEqual(page.items.map((r:any)=>r.id),[id]);}
});

 test('derived update cursor is device scoped and paired clients share perception permissions',async t=>{
 const {app,capture,paired}=await fixture(t),phone=await paired(),own=capture(),other=capture('other');
 for(const payload of [own,other])assert.equal((await app.inject({method:'POST',url:'/api/captures',headers:auth(),payload})).statusCode,201);
 const response=await app.inject({url:'/api/capture-browser/updates?deviceId=phone&limit=20',headers:auth(phone.token)});
 assert.equal(response.statusCode,200);const page=response.json();assert.deepEqual(page.items.map((i:any)=>i.id),[own.id]);assert(page.nextCursor>0);assert.equal(JSON.stringify(page).includes('imageBase64'),false);
 assert.equal((await app.inject({url:'/api/capture-browser/updates?deviceId=other',headers:auth(phone.token)})).statusCode,200);
 for(const method of ['GET','PUT'] as const){const a=await app.inject({method,url:'/api/perception',headers:auth(phone.token),...(method==='PUT'?{payload:{}}:{})}),b=await app.inject({method,url:'/api/perception',headers:auth(),...(method==='PUT'?{payload:{}}:{})});assert.equal(a.statusCode,b.statusCode);}
 assert.equal((await app.inject({url:'/api/perception',headers:auth()})).json().settings.allowQueryImages,false);
 assert.equal((await app.inject({method:'POST',url:`/api/perception/${own.id}/retry`,headers:auth(),payload:{kind:'semantic'}})).statusCode,400);
 });

test('UUID resource paths keep permissions and filters; typed refs are rejected before original or cached image reads',async t=>{
 const {app,capture,paired,image}=await fixture(t),phone=await paired(),record=capture();
 await app.inject({method:'POST',url:'/api/captures',headers:auth(),payload:record});
 const ref=record.id;
 for(const root of ['captures','capture-browser'])for(const suffix of ['', '/image']){
  for(const typed of ['capture:'+record.id,'memory:'+record.id])assert.equal((await app.inject({url:`/api/${root}/${encodeURIComponent(typed)}${suffix}`,headers:auth()})).statusCode,400,'resource URLs require bare UUIDs');
 }
 for(const root of ['captures','capture-browser']){
  for(const suffix of ['', '/image']){
   const url=`/api/${root}/${ref}${suffix}`;
   assert.equal((await app.inject({url,headers:auth()})).statusCode,200);
   for(const scope of ['deviceId=other','source=note','after=2027-01-01T00:00:00Z'])assert.equal((await app.inject({url:url+'?'+scope,headers:auth()})).statusCode,404);
  }
 }
 const url=`/api/capture-browser/${ref}/image?thumbnail=1`;
 assert.equal((await app.inject({url,headers:auth(phone.token)})).statusCode,200);
 assert.equal((await app.inject({url:url+'&after=2027-01-01T00:00:00Z',headers:auth(phone.token)})).statusCode,404);
 await app.inject({method:'DELETE',url:`/api/connections/${phone.credentialId}`,headers:auth()});
 assert.equal((await app.inject({url,headers:auth(phone.token)})).statusCode,401);
 assert.deepEqual((await app.inject({url:`/api/captures/${ref}/image`,headers:auth()})).rawPayload,image);
});
