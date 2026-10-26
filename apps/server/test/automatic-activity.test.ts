import {authorizeFixtureModels,withFixtureOwnerModelWork} from './fixtures/model-authorization.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {uiPageText,type UiPageV3} from '@mote/shared';
import {DEPLOYMENT_MODEL_PROFILE_ID} from '@mote/shared/models';
import type {ContextReader,QueryInput} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {parseConfigDocument,serializeConfigDocument} from '@mote/shared/config-file';

const token='generated-automatic-activity-owner-token',headers={authorization:`Bearer ${token}`};
function observation(second=0){const at=new Date(Date.parse('2026-10-10T00:00:00Z')+1000*second).toISOString();
  const page:UiPageV3={version:3,scope:'visible_window',adapterId:'generated.order',adapterVersion:'1',appVersion:'1',activity:'generated.Order',status:'ok',truncated:false,observations:{firstAt:at,lastAt:at,count:1},objects:[{kind:'order',fields:[{name:'order_id',values:[{text:'GENERATED-ORDER-41',source:'text'}]},{name:'status',values:[{text:second?'Paid; delivery is not established':'Awaiting payment',source:'state'}]}]}]};
  return {id:randomUUID(),deviceId:'generated-phone',deviceName:'Generated phone',platform:'android',capturedAt:at,source:'ui_page',appId:'generated.store',appName:'Generated shop',durationMs:0,windowTitle:'',ocrText:uiPageText(page),metadata:{version:1,observedAt:at,collector:{method:'accessibility'},uiPage:page},privacy:{excluded:false,redacted:true,mode:'local',collection:'content'}};
}
async function fixture(t:TestContext){const dataDir=mkdtempSync(join(tmpdir(),'mote-automatic-activity-'));
  const config:Config={dataDir,token,tokenPath:join(dataDir,'token'),host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'http://127.0.0.1:1234/v1',apiKey:'',allowUnauthenticatedLocal:true,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
  const calls:QueryInput[]=[],control:{during?:()=>Promise<void>;invalidProof?:boolean;pixelReads:number}={pixelReads:0};
  const dependencies={backgroundWorker:false,createModelAgent:async(_settings:unknown,reader:ContextReader)=>({configured:true,close:async()=>{},query:async(input:QueryInput)=>{
    if(input.directImages?.length){const image=await reader.readImage!({id:input.directImages[0].id});assert.ok(image.data);control.pixelReads++;return {answer:JSON.stringify({text:'Generated screenshot depicts an orange rectangle. Authorship is unknown.',regions:[]}),citations:[],trace:[],runId:randomUUID()};}
    calls.push(input);const records=await reader.evidence({ids:input.evidenceIds!});assert.ok(records.length,'actual bounded Agent reader must expose the accepted original independently of Memory');
    await control.during?.();
    const context=JSON.parse(input.taskContext?.untrustedInterpretations??'{}'),leads=context.activities??[];
    const activities=records.map(record=>{
      const product=context.imageInterpretations?.find((image:{id:string})=>image.id===record.id)?.products.find((product:{kind:string})=>product.kind!=='ocr');
      const quote=record.ocrText||product?.text||context.captureMetadata.find((entry:{id:string})=>entry.id===record.id).text,source=record.ocrText?'text':product?'image-product':'metadata';
      return {existingActivityId:records.length===1?(leads[0]?.id??null):null,title:'Generated order observation',statement:quote,uncertainty:'Display only; receipt and delivery are unknown.',evidence:[{id:record.id,quote:control.invalidProof?'Invented purchase':quote,offset:0,source,...(product?{productId:product.revision}:{})}]};
    });
    return {answer:JSON.stringify({activities,coverage:'complete',limitation:'Only this generated visible window.'}),citations:records.map(record=>({id:record.id,capturedAt:record.capturedAt,appName:record.appName,excerpt:record.ocrText})),trace:[],runId:randomUUID()};
  }})};
  let node=await buildApp(config,dependencies);await node.app.ready();await authorizeFixtureModels(node);
  t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  const save=async(enabled:boolean,profileId:string|null=DEPLOYMENT_MODEL_PROFILE_ID)=>{const view=await node.app.inject({url:'/api/processing/activity',headers});return node.app.inject({method:'PUT',url:'/api/processing/activity',headers,payload:{revision:view.json().revision,settings:{enabled,modelProfileId:profileId}}});};
  const ingest=(payload:unknown,auth=headers)=>node.app.inject({method:'POST',url:'/api/captures',headers:auth,payload});
  return {get node(){return node;},calls,control,save,ingest,async restart(edit?:(path:string)=>void){const path=node.configService.path;await node.app.close();edit?.(path);node=await buildApp(config,dependencies);await node.app.ready();}};
}

test('real prospective HTTP intake survives restart, publishes incremental Activity and remains queryable without Memory',async t=>{
  const f=await fixture(t),old=observation();assert.equal((await f.ingest(old)).statusCode,201);
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM activity_input_grants').get()!.n,0);
  assert.deepEqual({...f.node.store.db.prepare('SELECT authorized,reason FROM activity_intake_receipts WHERE capture_id=?').get(old.id)},{authorized:0,reason:'activity_disabled'},'denied prospective permission is durably recorded');
  assert.equal((await f.save(true,null)).statusCode,400,'explicit model selection is required');
  assert.equal((await f.save(true)).statusCode,200);
  assert.equal((await f.ingest(old)).statusCode,200,'duplicate delivery never turns history into authorized work');
  const first=observation();assert.equal((await f.ingest(first,{} as typeof headers)).statusCode,401);
  assert.equal((await f.ingest(first)).statusCode,201);
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM activity_input_grants').get()!.n,1);
  await f.restart();await f.node.automaticActivity.tick();
  let activities=f.node.materials.list({kind:'mote.activity'}).items;assert.equal(activities.length,1,JSON.stringify({view:f.node.automaticActivity.view(),steps:f.node.executor.list({kind:'activity.understand'}),calls:f.calls.length}));assert.equal(f.calls.length,1);
  assert.match(f.node.materials.read(activities[0].ref).text,/GENERATED-ORDER-41/);
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_jobs').get()!.n,0,'Activity publication never creates a Memory job');
  const second=observation(2);assert.equal((await f.ingest(second)).statusCode,201);await f.node.automaticActivity.tick();
  activities=f.node.materials.list({kind:'mote.activity'}).items;assert.equal(activities.length,1);assert.equal(activities[0].memberCount,2,'the model selected the association');
  assert.equal(activities[0].blockCount,2,'new observations append without rewriting earlier state');
  const material=activities[0],raw=await f.node.app.inject({url:'/api/capture-browser/'+first.id,headers});assert.equal(raw.statusCode,200);assert.equal(raw.json().ocrText,first.ocrText);
  const found=f.node.materials.list({query:'GENERATED-ORDER-41',kind:'mote.activity'}).items;assert.equal(found[0]?.id,material.id);
  const evidenceIds=f.node.materials.evidenceIds(material.ref),records=await withFixtureOwnerModelWork(f.node,()=>f.node.featureServices.archiveReader.evidence({ids:evidenceIds}));assert.ok(records.some(record=>record.ocrText.includes('GENERATED-ORDER-41')),'real query reader discovers the exact derived evidence');
  const deleted=await f.node.app.inject({method:'DELETE',url:'/api/captures/'+first.id,headers});assert.equal(deleted.statusCode,200);
  assert.equal(f.node.materials.get(material.id),undefined,'deleting an original removes its dependent Activity in the deletion transaction');
  assert.deepEqual(await withFixtureOwnerModelWork(f.node,()=>f.node.featureServices.archiveReader.evidence({ids:evidenceIds})),[]);
  await f.restart();assert.equal(f.node.materials.list({kind:'mote.activity'}).items.length,0);assert.equal(f.calls.length,2,'restart cannot revive consumed or deleted inputs');
});

test('disable during the actual model call cancels pending and late Activity publication; enabling admits only future captures',async t=>{
  const f=await fixture(t);assert.equal((await f.save(true)).statusCode,200);
  const input=observation();assert.equal((await f.ingest(input)).statusCode,201);
  f.control.during=async()=>{assert.equal((await f.save(false)).statusCode,200);};
  await f.node.automaticActivity.tick();assert.equal(f.node.materials.list({kind:'mote.activity'}).items.length,0);
  assert.equal(f.node.automaticActivity.view().counts.cancelled,1);
  f.control.during=undefined;assert.equal((await f.save(true)).statusCode,200);await f.node.automaticActivity.tick();assert.equal(f.calls.length,1,'reenabling never renews old authority');
  const next=observation(1);assert.equal((await f.ingest(next)).statusCode,201);await f.node.automaticActivity.tick();assert.equal(f.node.materials.list({kind:'mote.activity'}).items.length,1);
});

test('invented quotes fail the host proof contract and deleting during model work cannot publish',async t=>{
  const f=await fixture(t);assert.equal((await f.save(true)).statusCode,200);f.control.invalidProof=true;
  assert.equal((await f.ingest(observation())).statusCode,201);await f.node.automaticActivity.tick();assert.equal(f.node.materials.list({kind:'mote.activity'}).items.length,0);assert.equal(f.node.automaticActivity.view().counts.failed,1);
  f.control.invalidProof=false;const input=observation(1);f.control.during=async()=>{assert.equal((await f.node.app.inject({method:'DELETE',url:'/api/captures/'+input.id,headers})).statusCode,200);};
  assert.equal((await f.ingest(input)).statusCode,201);await f.node.automaticActivity.tick();assert.equal(f.node.materials.list({kind:'mote.activity'}).items.length,0);
});

test('standalone playback accumulates readable measured intervals without paid semantic work while point observations add no time',async t=>{
  const f=await fixture(t);assert.equal((await f.save(true)).statusCode,200);
  const media=(seconds:number,durationMs:number)=>({id:randomUUID(),deviceId:'generated-phone',deviceName:'Generated phone',platform:'android',capturedAt:new Date(Date.parse('2026-10-10T00:00:00Z')+1000*seconds).toISOString(),source:'media',appId:'generated.player',appName:'Generated player',durationMs,windowTitle:'',ocrText:'',privacy:{collection:'content'},metadata:{version:1,observedAt:new Date(Date.parse('2026-10-10T00:00:00Z')+1000*seconds).toISOString(),media:{status:'available',sessions:[{sessionId:'generated-session',appId:'generated.player',appName:'Generated player',playbackState:'playing',appVisibility:'background',playbackType:'local',title:'Generated chapter',positionMs:seconds*1000}]}}});
  const interval=media(20,20000),point=media(30,0),adjacent=media(25,5000),gap=media(45,5000);
  for(const value of [interval,point,adjacent,gap])assert.equal((await f.ingest(value)).statusCode,201);
  await f.node.materialOrganizer.tick(100);await f.node.automaticActivity.tick();
  const material=f.node.materials.list({kind:'mote.state-series'}).items.find(material=>f.node.materials.members(material.ref).items.some(member=>member.id===interval.id))!;
  const text=f.node.materials.read(material.ref).text;assert.match(text,/Generated chapter/);assert.match(text,/"measuredPlaybackMs":30000/);assert.match(text,/2026-10-10T00:00:00.000Z/);
  const measured=await f.node.app.inject({url:'/api/media-activity',headers});assert.equal(measured.statusCode,200,measured.body);assert.equal(measured.json().totalDurationMs,30000);
  assert.equal(f.node.materials.list({kind:'mote.activity'}).items.length,0,'pure provider playback facts need no model interpretation');
  assert.equal(f.calls.length,0,'provider playback facts and advancing positions create no model calls');
  assert.equal(material.memberCount,4,'exact provider/session/content/state samples accumulate in one deterministic Material');
  const intervalBlock=Array.from({length:material.blockCount},(_,index)=>f.node.materials.block(material.ref,index)!.block).find(block=>block.id==='playback-interval')!;assert.equal(JSON.parse(intervalBlock.text).intervals.length,2,'adjacent measured playback merges but an unobserved gap stays separate');
  assert.equal(f.node.store.evidence([interval.id])[0].ocrText,'','deterministic readability never rewrites the original transport text');
});

test('correlated screenshot and structured partial deliveries coalesce across restart and never repeat structured understanding',async t=>{
  const f=await fixture(t);assert.equal((await f.save(true)).statusCode,200);
  const correlated={id:randomUUID(),selected:{duration:true,screenshots:true,structured:true}},first=observation();
  first.metadata={...first.metadata,captureObservation:correlated} as typeof first.metadata;
  const screen={...first,id:randomUUID(),source:'screen',ocrText:'Generated alternate screenshot text',metadata:{version:1,observedAt:first.capturedAt,captureObservation:correlated}};
  assert.equal((await f.ingest(screen)).statusCode,201);await f.node.automaticActivity.tick();assert.equal(f.calls.length,0,'coalesce grace waits before a paid call');
  await f.restart();assert.equal((await f.ingest(first)).statusCode,201);
  f.node.store.db.prepare("UPDATE execution_steps SET available_at=0 WHERE kind='activity.understand'").run();await f.node.automaticActivity.tick();
  assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].evidenceIds,[first.id],'structured channel is the only semantic target; screenshot remains retained');
  const late={...screen,id:randomUUID()};assert.equal((await f.ingest(late)).statusCode,201);await f.node.automaticActivity.tick();assert.equal(f.calls.length,1,'late screenshot adds no duplicate semantic call');
  assert.equal(f.node.store.evidence([screen.id,first.id,late.id]).length,3);
  const enriched=observation(1);enriched.metadata={...enriched.metadata,captureObservation:correlated} as typeof enriched.metadata;
  assert.equal((await f.ingest(enriched)).statusCode,201);f.node.store.db.prepare("UPDATE execution_steps SET available_at=0 WHERE kind='activity.understand'").run();await f.node.automaticActivity.tick();
  assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1].evidenceIds,[enriched.id],'later structured evidence processes only its new increment');
  await f.restart();await f.node.automaticActivity.tick();assert.equal(f.calls.length,2,'consumed checkpoints survive restart');
});

test('screenshot-only Activity waits for configured image products and consumes an actual pixel-backed interpretation even with empty OCR',async t=>{
  const f=await fixture(t);assert.equal((await f.save(true)).statusCode,200);
  await f.node.processing.saveImageDefault({endpoint:'http://127.0.0.1:9011/generated-ocr'});
  await authorizeFixtureModels(f.node); // The newly configured OCR endpoint needs its own exact approval, before intake.
  f.node.processing.runtime.registry.get('image.http').process=async()=>({durationMs:0,segments:[]});
  const image=await sharp({create:{width:20,height:20,channels:3,background:'#ff8800'}}).png().toBuffer(),base=observation();
  const screen={...base,source:'screen',ocrText:'',ocr:{status:'pending'},imageBase64:image.toString('base64'),imageMime:'image/png',metadata:{version:1,observedAt:base.capturedAt}};
  assert.equal((await f.ingest(screen)).statusCode,201);await f.node.automaticActivity.tick();assert.equal(f.calls.length,0,'no app-metadata substitute for unread image contents');
  await f.node.perception.tick();assert.equal(f.control.pixelReads,1,'real configured image processing reads generated pixels through its own scoped reader');
  f.node.store.db.prepare("UPDATE execution_steps SET available_at=0 WHERE kind='activity.understand'").run();await f.node.automaticActivity.tick();
  assert.equal(f.calls.length,1);const material=f.node.materials.list({kind:'mote.activity'}).items[0];assert.ok(material,JSON.stringify(f.node.automaticActivity.view()));
  const text=f.node.materials.read(material.ref).text;assert.match(text,/orange rectangle/);assert.match(text,/image-product/);assert.match(text,/productId/);
  assert.equal(f.node.store.evidence([screen.id])[0].ocrText,'','empty OCR and original image remain unchanged');
});

test('an unquoted disclosed input still owns Activity lineage and deterministic duration/device states never spend model work',async t=>{
  const f=await fixture(t);assert.equal((await f.save(true)).statusCode,200);
  const correlation={id:randomUUID(),selected:{duration:true,screenshots:false,structured:true}},first=observation(),other=observation(1);
  first.metadata={...first.metadata,captureObservation:correlation} as typeof first.metadata;other.metadata={...other.metadata,captureObservation:correlation} as typeof other.metadata;
  for(const value of [first,other])assert.equal((await f.ingest(value)).statusCode,201);
  f.node.store.db.prepare("UPDATE execution_steps SET available_at=0 WHERE kind='activity.understand'").run();await f.node.automaticActivity.tick();
  const material=f.node.materials.list({kind:'mote.activity'}).items[0];assert.ok(material);assert.equal(material.memberCount,2,'all disclosed originals are attached, independently of displayed proof quotes');
  const quoted=JSON.parse(f.node.materials.block(material.ref,0)!.block.text).evidence[0].id,unquoted=[first.id,other.id].find(id=>id!==quoted)!;
  assert.equal((await f.node.app.inject({method:'DELETE',url:'/api/captures/'+unquoted,headers})).statusCode,200);assert.equal(f.node.materials.get(material.id),undefined);
  const duration={id:randomUUID(),deviceId:'generated-phone',deviceName:'Generated phone',platform:'android',capturedAt:first.capturedAt,source:'activity',appId:'generated.app',appName:'Generated app',durationMs:5000,ocrText:'',privacy:{collection:'activity'}};
  assert.equal((await f.ingest(duration)).statusCode,201);await f.node.automaticActivity.tick();assert.equal(f.calls.length,1,'duration records remain deterministic observations');
  assert.deepEqual({...f.node.store.db.prepare('SELECT authorized,reason FROM activity_intake_receipts WHERE capture_id=?').get(duration.id)},{authorized:0,reason:'deterministic_only'});
});

test('full structured snapshots skip unchanged computation, preserve repeated-object multiplicity and drain all 64 authorized objects in bounded batches',async t=>{
  const f=await fixture(t);assert.equal((await f.save(true)).statusCode,200);
  const first=observation();assert.equal((await f.ingest(first)).statusCode,201);await f.node.automaticActivity.tick();assert.equal(f.calls.length,1);
  const same={...first,id:randomUUID(),capturedAt:'2026-10-10T00:00:01.000Z',metadata:{...first.metadata,observedAt:'2026-10-10T00:00:01.000Z',uiPage:{...first.metadata.uiPage,observations:{firstAt:'2026-10-10T00:00:01.000Z',lastAt:'2026-10-10T00:00:01.000Z',count:1}}}};
  assert.equal((await f.ingest(same)).statusCode,201);await f.node.automaticActivity.tick();assert.equal(f.calls.length,1,'clock changes alone never repeat model work');
  assert.equal(f.node.store.db.prepare('SELECT reason FROM activity_intake_receipts WHERE capture_id=?').get(same.id)!.reason,'structured_snapshot_unchanged');
  const correlation={id:randomUUID(),selected:{duration:false,screenshots:false,structured:true}};
  const repeated=[{...same,id:randomUUID(),metadata:{...same.metadata,captureObservation:correlation}},{...same,id:randomUUID(),metadata:{...same.metadata,captureObservation:correlation}}];
  for(const value of repeated)assert.equal((await f.ingest(value)).statusCode,201);
  f.node.store.db.prepare("UPDATE execution_steps SET available_at=0 WHERE kind='activity.understand'").run();await f.node.automaticActivity.tick();assert.equal(f.calls.length,2);assert.equal(f.calls.at(-1)!.evidenceIds!.length,2,'two structurally identical displayed objects remain two authorized inputs');
  const manyCorrelation={...correlation,id:randomUUID()},many=Array.from({length:64},(_,index)=>{const value=observation(index+2);value.metadata={...value.metadata,captureObservation:manyCorrelation} as typeof value.metadata;value.metadata.uiPage.objects[0].fields[0].values[0].text='GENERATED-OBJECT-'+index;value.ocrText=uiPageText(value.metadata.uiPage);return value;});
  for(const value of many)assert.equal((await f.ingest(value)).statusCode,201);
  f.node.store.db.prepare("UPDATE execution_steps SET available_at=0 WHERE kind='activity.understand'").run();await f.node.automaticActivity.tick();
  const batchCalls=f.calls.slice(2);assert.equal(batchCalls.length,8);assert.ok(batchCalls.every(call=>call.evidenceIds!.length<=8));assert.deepEqual(new Set(batchCalls.flatMap(call=>call.evidenceIds!)),new Set(many.map(value=>value.id)),'every actual accepted object reaches a bounded model call');
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM activity_input_grants WHERE consumed=0').get()!.n,0,'continuations consume only their disclosed batch until every authorized input is finished');
  const outputs=f.node.materials.list({kind:'mote.activity',limit:100}).items.flatMap(material=>Array.from({length:material.blockCount},(_,index)=>JSON.parse(f.node.materials.block(material.ref,index)!.block.text)));
  const expected=new Set(many.map(value=>value.id)),published=outputs.flatMap(output=>output.evidence.map((proof:{id:string})=>proof.id)).filter((id:string)=>expected.has(id));assert.equal(published.length,64);assert.deepEqual(new Set(published),expected,'all64 generated distinct activity claims are actually published, not just delivered to a model');
  await f.restart();await f.node.automaticActivity.tick();assert.equal(f.calls.length,10,'restart preserves completed incremental checkpoints');
});

test('disabled configuration saved while stopped revokes pending authority before a new enable can revive it',async t=>{
  const f=await fixture(t);assert.equal((await f.save(true)).statusCode,200);const input=observation();input.metadata={...input.metadata,captureObservation:{id:randomUUID(),selected:{duration:false,screenshots:false,structured:true}}} as typeof input.metadata;
  assert.equal((await f.ingest(input)).statusCode,201);
  await f.restart(path=>{const document=parseConfigDocument(readFileSync(path,'utf8')).savedDocument;document.activity={enabled:false,modelProfileId:DEPLOYMENT_MODEL_PROFILE_ID};document.revision=Number(document.revision)+1;writeFileSync(path,serializeConfigDocument(document));});
  assert.equal((await f.save(true)).statusCode,200);f.node.store.db.prepare("UPDATE execution_steps SET available_at=0 WHERE kind='activity.understand'").run();await f.node.automaticActivity.tick();assert.equal(f.calls.length,0,'old pending input cannot become future-authorized through restart and enable');
  assert.equal(f.node.materials.list({kind:'mote.activity'}).items.length,0);
});

test('activity-only, removed and content-free notifications stay deterministic while updated visible content can be understood',async t=>{
  const f=await fixture(t);assert.equal((await f.save(true)).statusCode,200);
  const at='2026-10-10T00:00:00Z',make=(action:string,collection='content',content?:string)=>({id:randomUUID(),deviceId:'generated-phone',deviceName:'Generated phone',platform:'android',source:'notification',capturedAt:at,durationMs:0,appId:'generated.notifications',appName:'Generated app',ocrText:'',privacy:{collection},metadata:{version:1,observedAt:at,collector:{method:'notification_listener'},observation:{sessionId:randomUUID(),elapsedRealtimeMs:1000},notification:{action,notificationKey:'42'.repeat(32),postedAt:at,ongoing:false,groupSummary:false,...(content?{text:content}:{})}}});
  const deterministic=[make('posted','activity'),make('removed'),make('posted')];for(const value of deterministic)assert.equal((await f.ingest(value)).statusCode,201);
  await f.node.automaticActivity.tick();assert.equal(f.calls.length,0);for(const value of deterministic)assert.equal(f.node.store.db.prepare('SELECT reason FROM activity_intake_receipts WHERE capture_id=?').get(value.id)!.reason,'deterministic_only');
  assert.equal((await f.ingest(make('updated','content','Generated changed notification body'))).statusCode,201);await f.node.automaticActivity.tick();assert.equal(f.calls.length,1);
});

test('Mac browser observations reach activity in observed order instead of random capture-ID order',async t=>{
  const f=await fixture(t);assert.equal((await f.save(true)).statusCode,200);
  const observationId=randomUUID(),first=observation(),second=observation();
  const make=(record:ReturnType<typeof observation>,objectIndex:number,text:string,id:string)=>{
    const page=record.metadata.uiPage;page.adapterId='chrome.generated.messages';page.appVersion='1';page.activity='';page.objects=[{kind:'message',fields:[{name:'message_visible_body',values:[{text,source:'text'}]}]}];
    return {...record,id,platform:'macos',appId:'com.google.Chrome',appName:'Chrome',ocrText:uiPageText(page),metadata:{...record.metadata,collector:{method:'browser_dom'},captureObservation:{id:observationId,objectIndex,selected:{duration:false,screenshots:false,structured:true}}}};
  };
  const before=make(first,0,'Generated first message','ffffffff-ffff-4fff-8fff-ffffffffffff');
  const after=make(second,1,'Generated second message','00000000-0000-4000-8000-000000000001');
  assert.equal((await f.ingest(after)).statusCode,201);assert.equal((await f.ingest(before)).statusCode,201);
  f.node.store.db.prepare("UPDATE execution_steps SET available_at=0 WHERE kind='activity.understand'").run();await f.node.automaticActivity.tick();
  assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].evidenceIds,[before.id,after.id]);
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_jobs').get()!.n,0);
  assert.equal((await f.ingest(before)).statusCode,200);await f.node.automaticActivity.tick();assert.equal(f.calls.length,1,'retries must not reinterpret accepted content');
});
