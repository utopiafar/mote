import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {Store,StoreError,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {FileProcessing} from '../src/file-processing.js';
import {imageUnderstanding} from '../src/image-understanding.js';
import {imageOutput} from '../src/evidence-image.js';
import {UsageLedger} from '../src/usage.js';
import type {ModelSettings} from '@mote/shared/models';
import {ImageProcessing} from '../src/image-processing.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {MaterialMemoryWork} from '../src/material-memory-work.js';
import {installCaptureMemoryIntake} from '../src/capture-memory-intake.js';
import {planGeneratedMemory,generatedMemoryOutput} from './fixtures/memory-planning.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';
import {processorContract,processorSettingsFingerprint} from '../src/file-configuration.js';
import {DEFAULT_IMAGE_RECIPE} from '../src/image-recipes.js';
import {MEDIA_CATALOG} from '../src/media-assets.js';

async function fixture(t:import('node:test').TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-unified-images-')),store=new Store(directory),materials=new MaterialStore(store);let clock=Date.now();const memoryWork=new MaterialMemoryWork(store,materials,()=>clock,()=>true);
 const sources=new SourceStore(store,undefined,memoryWork.inputs),files=new FileStore(store,sources),archived=new ArchivedFileStore(store),engine=new ExecutionEngine(store),processing=new FileProcessing(files,undefined,undefined,{executor:engine});await processing.runtime.ready;
 let ocrCalls=0,visualCalls=0,empty=false,failVisual=false;
 processing.runtime.registry.get('image.http').process=async()=>{ocrCalls++;return {durationMs:0,segments:empty?[]:[{startMs:0,endMs:0,text:'Generated third-party article: I resigned.'}]};};
 const disposeCaptureMemoryIntake=installCaptureMemoryIntake(store,memoryWork);
 const images=new ImageProcessing(store,processing,engine,{materials,understanding:{selection:()=>({fingerprint:'fixture-model-1',configured:true,receipt:{model:'fixture'}}),run:async input=>{visualCalls++;if(failVisual)throw Error('Generated visual failure');const image=await input.readImage({id:input.record.id});assert.equal(image.imageView!.original.sha256,input.original.hash);return {text:'A third-party article says its author resigned. The owner is not identified as that author.',regions:[]};}}});
 const organizer=new MaterialOrganizerRuntime(store,materials,[],engine,memoryWork);
 const bytes=await sharp({create:{width:16,height:16,channels:3,background:'#aabbcc'}}).png().toBuffer();
 for(const id of ['generated-import','generated-sync','generated-parent'])sources.register({id,name:id,kind:'upload',deviceId:'generated-device',platform:'import',retention:'archive'});
 const screen=async()=>{const id=randomUUID();await store.ingest({id,deviceId:'generated-android',deviceName:'Fixture Android',platform:'android',source:'screen',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,appId:'fixture',appName:'Fixture',ocrText:'',ocr:{status:'disabled'},privacy:{excluded:false,redacted:false,mode:'local'},imageMime:'image/png',imageBase64:bytes.toString('base64')});return id;};
 const upload=async(sourceId='generated-import',override?:string,mimeType='image/png')=>{
  const begun=files.begin({sourceId,processingProfileId:override,item:{externalId:randomUUID(),revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'file',layer:'original',title:'Generated image',mimeType,text:''},sha256:sha256(bytes),sizeBytes:bytes.length},()=>{});files.part(begun.uploadId,0,bytes,()=>{});return String((await files.commit(begun.uploadId,()=>{})).id);
 };
 const organize=async()=>{for(let i=0;i<20;i++)if(await organizer.tick(200)===0)return;throw Error('Organizer did not settle');};
 t.after(async()=>{disposeCaptureMemoryIntake();await engine.close();await images.close();await organizer.close();await processing.close();await files.close();store.close();rmSync(directory,{recursive:true,force:true});});
 return {store,sources,files,archived,processing,images,engine,bytes,materials,organizer,memoryWork,advance:(ms:number)=>{clock+=ms;},screen,upload,organize,calls:()=>({ocr:ocrCalls,visual:visualCalls}),empty:()=>{empty=true;},failVisual:(failed=true)=>{failVisual=failed;}};
}

test('explicit image completion renews an exhausted execution budget and preserves successful OCR',async t=>{
 const f=await fixture(t),id=await f.upload();f.failVisual();await f.images.tick();
 const step=f.engine.list({operationId:'image:'+id}).items.find(s=>s.kind==='images.understanding')!;
 f.store.db.prepare("UPDATE execution_steps SET state='waiting',attempts=4,recovery_deadline=? WHERE id=?").run(Date.now()-1,step.id);
 await f.engine.tick();assert.equal(f.engine.get(step.id)!.error,'recovery_window_exhausted');
 const original=f.images.detail(id).original,ocr=f.store.db.prepare("SELECT * FROM image_products WHERE capture_id=? AND kind='ocr' AND current=1").get(id),before=f.calls();
 f.failVisual(false);f.images.retry(id,false);
 const retry=f.store.db.prepare('SELECT attempts,recovery_deadline FROM execution_steps WHERE id=?').get(step.id)!;
 assert.equal(retry.attempts,0);assert.equal(retry.recovery_deadline,0);
 await f.images.tick();await f.organize();
 assert.equal(f.engine.get(step.id)!.state,'succeeded');assert.equal(f.calls().ocr,before.ocr);assert.equal(f.calls().visual,before.visual+1);
 assert.deepEqual(f.store.db.prepare("SELECT * FROM image_products WHERE capture_id=? AND kind='ocr' AND current=1").get(id),ocr);
 assert.equal(f.images.detail(id).original.hash,original.hash);assert.equal(f.files.detail(id).job!.state,'succeeded');
 await f.images.tick();assert.equal(f.calls().visual,before.visual+1,'refresh never repeats successful understanding');
});

test('screenshots, imports, synchronization and accepted attachments share OCR and retain independent visual context',async t=>{
 const f=await fixture(t),screen=await f.screen(),imported=await f.upload(),synced=await f.upload('generated-sync');
 const attachment=f.archived.put({name:'generated.png',mimeType:'application/octet-stream',bytes:f.bytes});
 const parent=await f.sources.upsert('generated-parent',{externalId:'caption',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',title:'Generated caption',text:'An article I retained',document:{contentRole:'authored',timeBasis:'unknown',attachments:[{id:attachment.id,mimeType:'image/png'}]}});f.archived.attach(parent.id,[attachment.id]);
 await f.images.tick();assert.deepEqual(f.calls(),{ocr:1,visual:4});
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM image_inputs').get()!.n,4);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM file_evidence_links WHERE parent_id=?').get(parent.id)!.n,1);
 for(const id of [screen,imported,synced])assert.equal(f.store.db.prepare("SELECT state FROM perception_jobs WHERE capture_id=? AND kind='understanding'").get(id)!.state,'succeeded');
 await f.organize();const material=f.materials.get(materialId('generated-import',f.files.detail(imported).item.externalId))!;
 assert.equal(material.artifacts!.find(a=>a.key==='image-understanding')!.state,'ready');
 assert.ok(f.materials.read(material.ref).text.includes('third-party'));
 assert.equal(f.store.evidence([screen])[0].ocrText,'Generated third-party article: I resigned.');
 await f.images.tick();await f.organize();assert.deepEqual(f.calls(),{ocr:1,visual:4},'refreshing products/materials never reruns completed model work');
});

test('successful empty OCR still runs vision; failed vision preserves searchable OCR readiness',async t=>{
 const f=await fixture(t);f.empty();const empty=await f.upload();await f.images.tick();await f.organize();
 const first=f.materials.get(materialId('generated-import',f.files.detail(empty).item.externalId))!;
 assert.equal(first.artifacts!.find(a=>a.key==='extracted-text')!.state,'ready');assert.equal(first.artifacts!.find(a=>a.key==='image-understanding')!.state,'ready');
 assert.equal(f.calls().visual,1);
 const raw=JSON.parse(String(f.store.db.prepare("SELECT json FROM image_products WHERE capture_id=? AND kind='ocr'").get(empty)!.json));assert.equal(raw.payload.segments.length,0);
 // Different bytes force a new OCR computation while the fixture provider now returns text.
 f.processing.runtime.registry.get('image.http').process=async()=>({durationMs:0,segments:[{startMs:0,endMs:0,text:'Generated retained searchable text'}]});
 f.processing.configureImageDefault({endpoint:'http://127.0.0.1:9011/ocr'});f.failVisual();const failed=await f.upload();await f.images.tick();await f.organize();
 const second=f.materials.get(materialId('generated-import',f.files.detail(failed).item.externalId))!;
 assert.equal(second.artifacts!.find(a=>a.key==='extracted-text')!.state,'ready');assert.equal(second.artifacts!.find(a=>a.key==='image-understanding')!.state,'failed');
 assert.ok(f.files.search({query:'retained searchable'}).length>0);
});

test('policy is pinned at intake; source and item overrides precede future defaults',async t=>{
 const f=await fixture(t),old=await f.upload(),view=f.processing.view(),policy=structuredClone(view.policy);
 policy.profiles.push({id:'alternate-image',name:'Alternate image',processorId:'image.http',serviceId:'central-image-ocr',parameters:{},diarizationProcessor:'audio.diarize',summarize:false});
 policy.rules.unshift({sourceId:'generated-sync',type:'image/*',profileId:'central-image'});
 f.processing.update({revision:view.revision,settings:view.settings,policy});f.processing.configureImageDefault({profileId:'alternate-image'});
 const inherited=await f.upload(),overridden=await f.upload('generated-sync'),archive=await f.upload('generated-import','archive');await f.images.tick();
 const profile=(id:string)=>JSON.parse(String(f.store.db.prepare('SELECT policy_json FROM image_inputs WHERE capture_id=?').get(id)!.policy_json)).profile.id;
 assert.equal(profile(old),'central-image');assert.equal(profile(inherited),'alternate-image');assert.equal(profile(overridden),'central-image');assert.equal(profile(archive),'archive');
 assert.equal(f.files.detail(archive).job!.stage,'archive');assert.equal(f.store.db.prepare('SELECT count(*) n FROM image_products WHERE capture_id=?').get(archive)!.n,0);
});

test('references report missing originals and deletion fences a late visual result',async t=>{
 const f=await fixture(t);const ref=await f.files.revision({sourceId:'generated-sync',item:{externalId:'shadow',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'file',layer:'reference',mimeType:'image/png',text:''},sizeBytes:10},()=>{});await f.images.tick();
 assert.equal(f.store.db.prepare("SELECT error FROM perception_jobs WHERE capture_id=? AND kind='ocr'").get(ref.id)!.error,'original_missing');assert.equal(f.store.db.prepare('SELECT count(*) n FROM image_products WHERE capture_id=?').get(ref.id)!.n,0);
 let began!:()=>void,release!:()=>void;const started=new Promise<void>(r=>began=r),held=new Promise<void>(r=>release=r);
 f.processing.runtime.imageRecipes.get({id:'mote.image-understanding',version:'1'}).run=async()=>{began();await held;return {text:'Generated obsolete visual result',regions:[]};};
 const id=await f.upload();const running=f.images.tick();await started;f.files.forget(id);release();await running;
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM image_products WHERE capture_id=?').get(id)!.n,0);
});

test('expired snapshot images request transport recovery and release recovered pixels after OCR and vision',async t=>{
 const f=await fixture(t);f.sources.register({id:'generated-snapshot',name:'Generated snapshot',kind:'local-files',deviceId:'fixture',platform:'macos',retention:'snapshot'});
 const hash=sha256(f.bytes),begun=f.files.begin({sourceId:'generated-snapshot',previousRevision:null,relativePath:'generated.png',sha256:hash,sizeBytes:f.bytes.length,item:{externalId:'generated-snapshot-image',revision:hash,observedAt:'2026-10-01T00:00:00Z',kind:'file',layer:'snapshot',mimeType:'image/png',text:'',document:{fileIndex:{version:1,fileId:'generated-snapshot-image',contentVersion:hash,mode:'index',coverage:'none',parser:'central-pending',status:'pending',totalCharacters:0,offset:0,length:0,maxIndexCharacters:8000,allowRead:true}}}},()=>{});
 f.files.part(begun.uploadId,0,f.bytes,()=>{});const ack=await f.files.commit(begun.uploadId,()=>{});
 f.store.db.prepare('UPDATE file_snapshot_inputs SET expires=0 WHERE capture_id=?').run(ack.id);f.files.sweepSnapshotInputs();await f.images.tick();
 assert.deepEqual(f.calls(),{ocr:0,visual:0});assert.equal(f.files.detail(ack.id).job.error,'snapshot_input_expired');
 assert.equal(f.files.snapshotRecovery('generated-snapshot').items[0].captureId,ack.id);
 const recovery=f.files.beginSnapshotRecovery(ack.id,()=>{});f.files.part(recovery.uploadId,0,f.bytes,()=>{});const restored=await f.files.commit(recovery.uploadId,()=>{});assert.equal(restored.id,ack.id);assert.equal(f.store.db.prepare('SELECT count(*) n FROM file_versions WHERE source_id=?').get('generated-snapshot')!.n,1);
 await f.images.tick();await f.organize();assert.deepEqual(f.calls(),{ocr:1,visual:1});assert.equal(f.files.detail(ack.id).job.state,'succeeded');
 assert.equal(f.files.snapshotRecovery('generated-snapshot').items.length,0);assert.equal(f.store.db.prepare('SELECT 1 FROM file_snapshot_inputs WHERE capture_id=?').get(ack.id),undefined);
 assert.equal(f.files.detail(ack.id).hasOriginal,false);assert.throws(()=>[...f.files.bytes(ack.id)],{statusCode:404});assert.throws(()=>f.store.assets.get(hash),{statusCode:404});
 assert.ok(f.files.search({query:'third-party article'}).length);const material=f.materials.get(materialId('generated-snapshot','generated-snapshot-image'))!;
 assert.equal(material.artifacts!.find(a=>a.key==='image-understanding')!.state,'ready');assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_input_authorizations WHERE capture_id=?').get(ack.id)!.n,1);await f.images.tick();assert.deepEqual(f.calls(),{ocr:1,visual:1});
});

test('one historical request drains more than 100 images and installing a plugin adds no historical work',async t=>{
 const f=await fixture(t);f.images.configure({...f.images.settings(),understandingEnabled:false});
 const ids=[];for(let i=0;i<205;i++)ids.push(await f.upload());f.store.db.exec('UPDATE image_inputs SET auto_eligible=0');
 await f.images.tick();assert.equal(f.calls().ocr,0);
 const preview=f.images.previewHistoricalOcr({sourceId:'generated-import'});assert.equal(preview.count,205);assert.equal(preview.bounded,false);
 f.images.processHistoricalOcr({token:preview.token});for(let i=0;i<5;i++)await f.images.tick();
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM perception_jobs WHERE kind='ocr' AND state='succeeded'").get()!.n,205);assert.equal(f.calls().ocr,1);
});

test('a declared non-screen source and recipe stage extend processing without core branches',async t=>{
 const f=await fixture(t);f.images.configure({...f.images.settings(),understandingEnabled:false});
 await f.processing.runtime.context.plugin({name:'generated-scanner',apply:ctx=>{f.sources.capabilities.register('generated.scanner',{lifecycle:'continuous',discovery:'local-selection',listening:'polling',readOriginal:'none',synchronization:'push-only',externalWrite:false});ctx.effect(()=>()=>f.sources.capabilities.unregister('generated.scanner'));}});
 f.sources.register({id:'generated-scanner',name:'Scanner fixture',kind:'generated.scanner',deviceId:'fixture-scanner',platform:'import',retention:'archive'});
 await f.processing.runtime.context.plugin({name:'generated-image-products',inject:['moteImageRecipes','moteImageInputs'],apply:ctx=>{assert.ok(ctx.moteImageInputs);ctx.effect(()=>ctx.moteImageRecipes.registerStage({id:'generated.receipt',version:'1',kind:'derived',run:async input=>({text:'Generated receipt fields from '+(input.dependencies.ocr as {segments:{text:string}[]}).segments[0].text,regions:[]})}));
 ctx.effect(()=>ctx.moteImageRecipes.registerRecipe({id:'generated.receipts',version:'1',steps:[{name:'ocr',stage:{id:'mote.image-ocr',version:'1'},dependsOn:[]},{name:'receipt',stage:{id:'generated.receipt',version:'1'},dependsOn:['ocr']}]}));}});
 const view=f.processing.view(),policy=structuredClone(view.policy);policy.profiles.push({...policy.profiles.find(p=>p.id==='central-image')!,id:'generated-receipts',name:'Generated receipts',imageRecipe:{id:'generated.receipts',version:'1'}});policy.rules.unshift({sourceId:'generated-scanner',type:'image/*',profileId:'generated-receipts'});f.processing.update({revision:view.revision,settings:view.settings,policy});
 const id=await f.upload('generated-scanner');await f.images.tick();await f.organize();
 assert.equal(f.store.db.prepare("SELECT kind FROM image_products WHERE capture_id=? AND name='receipt'").get(id)!.kind,'derived');
 assert.equal(f.materials.get(materialId('generated-scanner',f.files.detail(id).item.externalId))!.artifacts!.find(a=>a.key==='image-receipt')!.state,'ready');
});


test('OCR failure still allows pixel understanding and keeps extraction failure visible',async t=>{
 const f=await fixture(t);f.processing.runtime.registry.get('image.http').process=async()=>({durationMs:1,segments:[]});
 const id=await f.upload();await f.images.tick();await f.organize();
 const jobs=f.store.db.prepare('SELECT kind,state FROM perception_jobs WHERE capture_id=?').all(id);
 assert.equal(jobs.find(j=>j.kind==='ocr')!.state,'failed');assert.equal(jobs.find(j=>j.kind==='understanding')!.state,'succeeded');
 const material=f.materials.get(materialId('generated-import',f.files.detail(id).item.externalId))!;
 assert.equal(material.artifacts!.find(a=>a.key==='image-understanding')!.state,'ready');assert.notEqual(material.artifacts!.find(a=>a.key==='extracted-text')!.state,'ready');
});

test('screen visual readiness spends one raw Memory grant; rebuild and recompute never mint another',async t=>{
 const f=await fixture(t),id=await f.screen();await f.organize();f.advance(20000);
 let calls=0;const runner={create:()=>({id:'generated-memory-'+(++calls)}),get:()=>({status:'completed'}),run:async()=>{},cancel:()=>{}};
 f.memoryWork.drain(runner,true);assert.equal(calls,0,'Memory waits for visual evidence');
 await f.images.tick();await f.organize();f.advance(70000);f.memoryWork.drain(runner,true);assert.equal(calls,1);
 await f.organize();f.advance(70000);f.memoryWork.drain(runner,true);assert.equal(calls,1);
 f.images.retry(id,true);await f.images.tick();await f.organize();f.advance(70000);f.memoryWork.drain(runner,true);assert.equal(calls,1);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_input_authorizations WHERE capture_id=?').get(id)!.n,1);
});


test('the real harness adapter requires a pixel read, scopes evidence and meters interpretation separately',async t=>{
 const f=await fixture(t),id=await f.upload(),record=f.store.evidence([id])[0],settings:ModelSettings={provider:'custom',protocol:'openai-completions',model:'generated-model',baseUrl:'http://127.0.0.1:1234/v1',apiKey:'',headers:{},extraBody:{},maxTokens:8192,agentTimeoutMs:2000,modelRequestTimeoutMs:1000,reasoningEffort:'auto',allowUnauthenticatedLocal:true};
 let pixels=false;
 const adapter=imageUnderstanding({selection:()=>({fingerprint:'generated-model',configured:true,receipt:{model:settings.model},settings}),usage:new UsageLedger(f.store),factory:async(_settings,reader)=>({configured:true,close:async()=>{},query:async()=>{
  assert.deepEqual(await reader.evidence({ids:[randomUUID()]}),[]);await assert.rejects(reader.readImage!({id:randomUUID()}),{statusCode:404});
  if(pixels){const result=await reader.readImage!({id});assert.equal(result.data,f.bytes.toString('base64'));}
  return {answer:JSON.stringify({text:'Generated visual observation with uncertain ownership',regions:[]}),citations:[],trace:[],runId:randomUUID()};
 }})});
 const input={record,original:{hash:sha256(f.bytes),mimeType:'image/png',sizeBytes:f.bytes.length,read:async function*(){yield f.bytes;}},signal:new AbortController().signal,operationId:'image:'+id,readImage:(args:import('@mote/shared').ImageReadInput)=>imageOutput(f.bytes,'image/png',args,()=>true)};
 await assert.rejects(adapter.run(input),{statusCode:422});pixels=true;assert.match((await adapter.run(input)).text,/uncertain ownership/);
 const receipts=f.store.db.prepare('SELECT json FROM model_usage ORDER BY rowid').all().map(r=>JSON.parse(String(r.json)));
 assert.deepEqual(receipts.map(r=>r.status),['failed','completed']);assert.ok(receipts.every(r=>r.attribution.moduleId==='images'));
});


test('production image intake enters the existing automatic Memory pipeline once and exposes the zero-memory outcome',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-image-memory-app-')),config:Config={dataDir:directory,token:'generated-image-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'http://127.0.0.1:1234/v1',apiKey:'',allowUnauthenticatedLocal:true,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let visual=0,extractions=0;
 const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
  if(input.directImages?.length){visual++;await reader.readImage!({id:input.directImages[0].id});return {answer:JSON.stringify({text:'Generated chart from a third-party reference; owner authorship is unknown.',regions:[]}),citations:[],trace:[],runId:randomUUID()};}
  if(await planGeneratedMemory(input))return {answer:'Generated packages submitted.',citations:[],trace:[],runId:randomUUID()};
  if(input.traceContext?.phase!=='review')extractions++;return {answer:generatedMemoryOutput(input),citations:[],trace:[],runId:randomUUID()};
 }})});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 // This regression isolates the existing zero-outcome personal strategy. Daily
 // event behavior has a separate screenshot+field intake journey.
 node.memoryRecipeSettings.configure({scope:'capture',recipes:[{id:'mote.personal-memory',version:'2'}]});
 node.processing.configureImageDefault({endpoint:'http://127.0.0.1:9011/ocr'});node.processing.runtime.registry.get('image.http').process=async()=>({durationMs:0,segments:[]});
 const settings=node.lifecycle.settings();settings.extraction.enabled=true;node.lifecycle.configure(settings);
 const bytes=await sharp({create:{width:16,height:16,channels:3,background:'#ddeeff'}}).png().toBuffer(),id=randomUUID();
 await node.store.ingest({id,deviceId:'generated-screen',deviceName:'Generated screen',platform:'android',source:'screen',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'',ocr:{status:'disabled'},privacy:{excluded:false,redacted:false,mode:'local'},imageMime:'image/png',imageBase64:bytes.toString('base64')});
 await node.perception.tick();for(let i=0;i<20;i++)if(await node.materialOrganizer.tick(100)===0)break;
 node.store.db.prepare('UPDATE material_memory_requests SET ready_at=0').run();await node.sourcePipelines.drainMemory(node.memoryPipeline,true,10);
 const job=node.memoryPipeline.list()[0];assert.ok(job,'image Material should admit an automatic Memory job');const result=await node.memoryPipeline.run(job.id);assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(result.memoryCount,0);
 const detail=node.perception.detail(id);assert.equal(detail.memory[0].state,'completed');assert.equal(detail.memory[0].count,0);assert.equal(visual,1);assert.equal(extractions,1);
 node.perception.retry(id,true);await node.perception.tick();for(let i=0;i<20;i++)if(await node.materialOrganizer.tick(100)===0)break;
 node.store.db.prepare('UPDATE material_memory_requests SET ready_at=0').run();await node.sourcePipelines.drainMemory(node.memoryPipeline,true,10);assert.equal(node.memoryPipeline.list().length,1);assert.equal(extractions,1);
});

test('attribution correction retires image interpretation immediately, preserves OCR, and awaits explicit historical retry',async t=>{
 const f=await fixture(t),id=await f.upload();await f.images.tick();await f.organize();
 const material=f.materials.get(materialId('generated-import',f.files.detail(id).item.externalId))!,before=f.calls();
 const ocr=f.store.db.prepare("SELECT * FROM image_products WHERE capture_id=? AND kind='ocr' AND current=1").get(id);
 const receipts=f.store.db.prepare('SELECT * FROM memory_input_authorizations WHERE capture_id=?').all(id);
 const corrected=f.materials.correctContext(material.id,material.revision,'third_party');
 assert.notEqual(corrected.revision,material.revision);assert.equal(f.store.db.prepare("SELECT count(*) n FROM image_products WHERE capture_id=? AND kind!='ocr' AND current=1").get(id)!.n,0);
 assert.ok(!f.materials.read(corrected.ref).text.includes('The owner is not identified as that author.'));
 assert.deepEqual(f.store.db.prepare("SELECT * FROM image_products WHERE capture_id=? AND kind='ocr' AND current=1").get(id),ocr);
 assert.deepEqual(f.store.db.prepare('SELECT * FROM memory_input_authorizations WHERE capture_id=?').all(id),receipts);
 await f.images.tick();await f.organize();assert.deepEqual(f.calls(),before,'refresh and deterministic publication cannot bill corrected history');
 f.images.retry(id,false);await f.images.tick();await f.organize();assert.equal(f.calls().ocr,before.ocr);assert.equal(f.calls().visual,before.visual+1,'explicit retry grants current-context understanding');
});

test('attribution correction fences a late image interpretation and a cancelled stage cannot automatically retry',async t=>{
 const f=await fixture(t),id=await f.upload();await f.organize();
 let begin!:()=>void,release!:()=>void,calls=0;const entered=new Promise<void>(resolve=>begin=resolve),held=new Promise<void>(resolve=>release=resolve);t.after(()=>release());
 f.processing.runtime.imageRecipes.get({id:'mote.image-understanding',version:'1'}).run=async()=>{calls++;begin();await held;return {text:'Generated stale interpretation',regions:[]};};
 const running=f.images.tick();await entered;
 const material=f.materials.get(materialId('generated-import',f.files.detail(id).item.externalId))!;f.materials.correctContext(material.id,material.revision,'owner');
 release();await running;await f.images.tick();await f.organize();
 assert.equal(calls,1);assert.equal(f.store.db.prepare("SELECT count(*) n FROM image_products WHERE capture_id=? AND kind!='ocr' AND current=1").get(id)!.n,0);
 assert.equal(f.store.db.prepare("SELECT state FROM perception_jobs WHERE capture_id=? AND kind='understanding'").get(id)!.state,'cancelled');
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM image_products WHERE capture_id=? AND kind='ocr' AND current=1").get(id)!.n,1);
});

test('truly default attribution preserves the prior image interpretation fingerprint',async t=>{
 const f=await fixture(t),id=await f.upload();await f.images.tick();
 const row=f.store.db.prepare('SELECT * FROM image_inputs WHERE capture_id=?').get(id)!,record=f.store.evidence([id])[0];
 assert.deepEqual(f.materials.contextForEvidence(record),{version:1,ownerRelation:'unknown',basis:'default'});
 const binding=f.processing.imageConfiguration(String(row.source_id),String(row.mime),row.override_id?String(row.override_id):undefined,JSON.parse(String(row.policy_json))),processor=f.processing.runtime.registry.get(binding.applied.profile.processorId),settings=f.images.settings();
 const recipe=f.processing.runtime.imageRecipes.resolve(binding.applied.profile.imageRecipe??DEFAULT_IMAGE_RECIPE,true),stage=recipe.steps.find(step=>step.kind==='understanding')!;
 // Frozen pre-attribution identity. Host metadata with no declaration or
 // correction must not turn a cached default-context interpretation into work.
 const legacyContext={id:record.id,source:record.source,capturedAt:record.capturedAt,appName:record.appName,title:record.windowTitle,sourceVersion:record.provenance?{sourceId:record.provenance.sourceId,revision:record.provenance.revision,document:{contentRole:record.provenance.document?.contentRole,timeBasis:record.provenance.document?.timeBasis,recordedAt:record.provenance.document?.recordedAt,attachmentOf:record.provenance.document?.attachmentOf}}:undefined};
 const dependencies=stage.dependsOn.map(name=>f.store.db.prepare('SELECT fingerprint FROM image_products WHERE capture_id=? AND name=? AND current=1').get(id,name)?.fingerprint??null);
 const expected=sha256(JSON.stringify([row.hash,row.mime,processorContract(processor),processor.output?f.processing.runtime.outputs.list():null,processorSettingsFingerprint(processor,binding.settings,binding.applied.profile.parameters),settings.providerRevision,binding.settings.imageEndpoint===(process.env.MOTE_MEDIA_OCR_ENDPOINT??'http://127.0.0.1:9010/ocr')?MEDIA_CATALOG.ocr.version:'',stage.stage,recipe.fingerprint,dependencies,'fixture-model-1',legacyContext]));
 assert.equal(f.store.db.prepare("SELECT fingerprint FROM image_products WHERE capture_id=? AND kind='understanding' AND current=1").get(id)!.fingerprint,expected);
});


test('failed attribution publication preserves the running image grant without abort or extra paid retry',async t=>{
 const f=await fixture(t),id=await f.upload();await f.organize();
 let begin!:()=>void,release!:()=>void,calls=0,signal!:AbortSignal;
 const entered=new Promise<void>(resolve=>begin=resolve),held=new Promise<void>(resolve=>release=resolve);t.after(()=>release());
 f.processing.runtime.imageRecipes.get({id:'mote.image-understanding',version:'1'}).run=async input=>{calls++;signal=input.signal;begin();await held;return {text:'Generated valid unchanged-context interpretation',regions:[]};};
 const running=f.images.tick();await entered;
 const material=f.materials.get(materialId('generated-import',f.files.detail(id).item.externalId))!,publish=f.materials.publish;
 f.materials.publish=()=>{throw new StoreError('Generated publication quota failure',507);};
 try{assert.throws(()=>f.materials.correctContext(material.id,material.revision,'owner'),{statusCode:507});}finally{f.materials.publish=publish;}
 assert.equal(signal.aborted,false,'rolled-back cancellation must not abort the provider');
 assert.equal(f.store.db.prepare('SELECT semantic_withdrawn FROM image_inputs WHERE capture_id=?').get(id)!.semantic_withdrawn,0);
 assert.equal(f.materials.get(material.id)!.revision,material.revision);
 release();await running;await f.images.tick();await f.organize();
 assert.equal(calls,1);assert.equal(f.store.db.prepare("SELECT state FROM perception_jobs WHERE capture_id=? AND kind='understanding'").get(id)!.state,'succeeded');
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM image_products WHERE capture_id=? AND kind='understanding' AND current=1").get(id)!.n,1);
});

for(const outcome of ['rollback','commit'] as const)test(`snapshot image correction ${outcome} releases pixels only after committed completion`,async t=>{
 const f=await fixture(t);f.sources.register({id:'generated-snapshot',name:'Generated snapshot',kind:'local-files',deviceId:'fixture',platform:'macos',retention:'snapshot'});
 const hash=sha256(f.bytes),begun=f.files.begin({sourceId:'generated-snapshot',previousRevision:null,relativePath:'generated.png',sha256:hash,sizeBytes:f.bytes.length,item:{externalId:'generated-snapshot-image',revision:hash,observedAt:'2026-10-01T00:00:00Z',kind:'file',layer:'snapshot',mimeType:'image/png',text:'',document:{fileIndex:{version:1,fileId:'generated-snapshot-image',contentVersion:hash,mode:'index',coverage:'none',parser:'central-pending',status:'pending',totalCharacters:0,offset:0,length:0,maxIndexCharacters:8000,allowRead:true}}}},()=>{});
 f.files.part(begun.uploadId,0,f.bytes,()=>{});const ack=await f.files.commit(begun.uploadId,()=>{}),id=String(ack.id);await f.organize();
 let begin!:()=>void,release!:()=>void,calls=0,signal!:AbortSignal;
 const entered=new Promise<void>(resolve=>begin=resolve),held=new Promise<void>(resolve=>release=resolve);t.after(()=>release());
 f.processing.runtime.imageRecipes.get({id:'mote.image-understanding',version:'1'}).run=async input=>{calls++;signal=input.signal;begin();await held;return {text:'Generated snapshot interpretation',regions:[]};};
 const running=f.images.tick();await entered;
 const material=f.materials.get(materialId('generated-snapshot','generated-snapshot-image'))!,publish=f.materials.publish;
 if(outcome==='rollback'){
  f.materials.publish=()=>{throw new StoreError('Generated publication quota failure',507);};
  try{assert.throws(()=>f.materials.correctContext(material.id,material.revision,'owner'),{statusCode:507});}finally{f.materials.publish=publish;}
  assert.equal(signal.aborted,false);assert.equal(f.materials.get(material.id)!.revision,material.revision);
 }else f.materials.correctContext(material.id,material.revision,'owner');
 assert.deepEqual(Buffer.concat([...f.files.processingBytes(id)]),f.bytes,'transactional publication never physically deletes rollback-capable pixels');
 f.images.prepare();
 if(outcome==='rollback')assert.deepEqual(Buffer.concat([...f.files.processingBytes(id)]),f.bytes,'preparation preserves the restored running input');
 else{assert.equal(f.store.db.prepare('SELECT 1 FROM file_snapshot_inputs WHERE capture_id=?').get(id),undefined);assert.throws(()=>f.store.assets.get(hash),{statusCode:404});}
 release();await running;await f.images.tick();await f.organize();
 assert.equal(calls,1);assert.equal(f.calls().ocr,1);
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM image_products WHERE capture_id=? AND kind='understanding' AND current=1").get(id)!.n,outcome==='rollback'?1:0);
 assert.equal(f.store.db.prepare('SELECT 1 FROM file_snapshot_inputs WHERE capture_id=?').get(id),undefined,'completed snapshot input retention stays unchanged');
 assert.throws(()=>f.store.assets.get(hash),{statusCode:404});
});

for(const timing of ['before preparation','while OCR runs'] as const)test('correction preserves custom named OCR '+timing,async t=>{
 const f=await fixture(t),registry=f.processing.runtime.imageRecipes;
 registry.registerRecipe({id:'fixture.named-ocr',version:'1',steps:[{name:'text-recognition',stage:{id:'mote.image-ocr',version:'1'},dependsOn:[]},{name:'interpretation',stage:{id:'mote.image-understanding',version:'1'},dependsOn:['text-recognition']}]});
 const view=f.processing.view(),policy=structuredClone(view.policy);
 policy.profiles.push({...policy.profiles.find(profile=>profile.id==='central-image')!,id:'named-ocr',name:'Named OCR fixture',imageRecipe:{id:'fixture.named-ocr',version:'1'}});
 f.processing.update({revision:view.revision,settings:view.settings,policy});
 const id=await f.upload('generated-import','named-ocr');await f.organize();
 let begin!:()=>void,release!:()=>void,signal:AbortSignal|undefined;
 const entered=new Promise<void>(resolve=>begin=resolve),held=new Promise<void>(resolve=>release=resolve);t.after(()=>release());
 const stage=registry.get({id:'mote.image-ocr',version:'1'}),original=stage.run;
 stage.run=async input=>{signal=input.signal;begin();await held;return original(input);};
 const running=timing==='while OCR runs'?f.images.tick():undefined;if(running)await entered;
 const material=f.materials.get(materialId('generated-import',f.files.detail(id).item.externalId))!;
 f.materials.correctContext(material.id,material.revision,'third_party');
 if(signal)assert.equal(signal.aborted,false);
 assert.equal(f.store.db.prepare("SELECT state FROM perception_jobs WHERE capture_id=? AND kind='text-recognition'").get(id)!.state,timing==='while OCR runs'?'running':'waiting');
 release();if(running)await running;else await f.images.tick();await f.organize();
 assert.equal(f.calls().ocr,1);assert.equal(f.calls().visual,0);
 assert.equal(f.store.db.prepare("SELECT state FROM perception_jobs WHERE capture_id=? AND kind='text-recognition'").get(id)!.state,'succeeded');
 assert.equal(f.store.db.prepare("SELECT state FROM perception_jobs WHERE capture_id=? AND kind='interpretation'").get(id)!.state,'cancelled');
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM image_products WHERE capture_id=? AND kind='ocr' AND current=1").get(id)!.n,1);
});

test('corrected input with missing pinned recipe remains semantically withdrawn after reinstall until explicit retry',async t=>{
 const f=await fixture(t),registry=f.processing.runtime.imageRecipes,recipe={id:'fixture.unavailable',version:'1',steps:[{name:'ocr',stage:{id:'mote.image-ocr',version:'1'},dependsOn:[]},{name:'semantic',stage:{id:'mote.image-understanding',version:'1'},dependsOn:['ocr']}]};
 const uninstall=registry.registerRecipe(recipe),view=f.processing.view(),policy=structuredClone(view.policy);
 policy.profiles.push({...policy.profiles.find(profile=>profile.id==='central-image')!,id:'unavailable-image',name:'Unavailable fixture',imageRecipe:{id:recipe.id,version:recipe.version}});
 f.processing.update({revision:view.revision,settings:view.settings,policy});
 const id=await f.upload('generated-import','unavailable-image');await f.organize();uninstall();
 const material=f.materials.get(materialId('generated-import',f.files.detail(id).item.externalId))!;f.materials.correctContext(material.id,material.revision,'owner');
 await f.images.tick();registry.registerRecipe(recipe);await f.images.tick();await f.organize();
 assert.equal(f.calls().ocr,1);assert.equal(f.calls().visual,0);assert.equal(f.store.db.prepare("SELECT state FROM perception_jobs WHERE capture_id=? AND kind='semantic'").get(id)!.state,'cancelled');
 f.images.retry(id,false);await f.images.tick();assert.equal(f.calls().visual,1);
});

test('owner source correction before the first image Material withdraws cached and future semantic work through the real API',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-image-source-context-')),config:Config={dataDir:directory,token:'generated-image-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'http://127.0.0.1:1234/v1',apiKey:'',allowUnauthenticatedLocal:true,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let visual=0;
 const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{visual++;await reader.readImage!({id:input.directImages![0].id});return {answer:JSON.stringify({text:'Generated source interpretation',regions:[]}),citations:[],trace:[],runId:randomUUID()};}})});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});await node.app.ready();
 node.processing.configureImageDefault({endpoint:'http://127.0.0.1:9011/ocr'});node.processing.runtime.registry.get('image.http').process=async()=>({durationMs:0,segments:[{startMs:0,endMs:0,text:'Generated original source text'}]});
 const bytes=await sharp({create:{width:16,height:16,channels:3,background:'#ddeeff'}}).png().toBuffer(),id=randomUUID();
 await node.store.ingest({id,deviceId:'generated-screen',deviceName:'Generated screen',platform:'android',source:'screen',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'',ocr:{status:'disabled'},privacy:{excluded:false,redacted:false,mode:'local'},imageMime:'image/png',imageBase64:bytes.toString('base64')});
 await node.perception.tick();assert.equal(visual,1);assert.equal(node.materials.list().items.length,0);
 const sourceId=String(node.store.db.prepare('SELECT source_id FROM image_inputs WHERE capture_id=?').get(id)!.source_id);
 const result=await node.app.inject({method:'PATCH',url:'/api/sources/'+encodeURIComponent(sourceId),headers:{authorization:'Bearer '+config.token},payload:{ownerRelation:'third_party'}});assert.equal(result.statusCode,200,result.body);
 assert.equal(node.store.db.prepare("SELECT count(*) n FROM image_products WHERE capture_id=? AND kind!='ocr' AND current=1").get(id)!.n,0);
 assert.equal(node.store.db.prepare("SELECT count(*) n FROM image_products WHERE capture_id=? AND kind='ocr' AND current=1").get(id)!.n,1);
 await node.perception.tick();assert.equal(visual,1,'source declaration grants no historical rerun');
 node.perception.retry(id,false);await node.perception.tick();assert.equal(visual,2,'owner explicit retry remains available');
});

test('shared image interpretation retires from every Material without withdrawing unrelated image products',async t=>{
 const f=await fixture(t);let calls=0;
 f.processing.runtime.imageRecipes.get({id:'mote.image-understanding',version:'1'}).run=async input=>{calls++;return {text:'Generated image interpretation '+input.record.id,regions:[]};};
 const shared=await f.upload(),unrelated=await f.upload();await f.images.tick();await f.organize();
 const original=f.materials.get(materialId('generated-import',f.files.detail(shared).item.externalId))!;
 const sharedProduct=f.store.db.prepare("SELECT * FROM image_products WHERE capture_id=? AND kind='understanding' AND current=1").get(shared)!;
 const unrelatedProduct=f.store.db.prepare("SELECT * FROM image_products WHERE capture_id=? AND kind='understanding' AND current=1").get(unrelated)!;
 const ocr=f.store.db.prepare("SELECT * FROM image_products WHERE capture_id=? AND kind='ocr' AND current=1").get(shared)!;
 const bundle=f.materials.publish({id:materialId('generated-import','generated-image-bundle'),kind:'mote.message',schemaVersion:1,title:'Generated image bundle',origin:{sourceId:'generated-import',externalId:'generated-image-bundle'},
  members:[{id:shared,kind:'capture',ref:'capture:'+shared},{id:unrelated,kind:'capture',ref:'capture:'+unrelated}],
  blocks:[{id:'shared-interpretation',kind:'text',format:'plain',text:'Generated image interpretation '+shared,memberIds:[shared]},{id:'unrelated-interpretation',kind:'text',format:'plain',text:'Generated image interpretation '+unrelated,memberIds:[unrelated]},{id:'original-ocr',kind:'text',format:'plain',text:'Generated third-party article: I resigned.',memberIds:[shared]}],
  artifacts:[{key:'shared-interpretation',state:'ready',revision:String(sharedProduct.id),blockIds:['shared-interpretation']},{key:'unrelated-interpretation',state:'ready',revision:String(unrelatedProduct.id),blockIds:['unrelated-interpretation']},{key:'extracted-text',state:'ready',revision:String(ocr.id),blockIds:['original-ocr']}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
 f.materials.correctContext(original.id,original.revision,'owner');
 const next=f.materials.get(bundle.id)!;assert.notEqual(next.revision,bundle.revision);assert.deepEqual(next.attributionContext,bundle.attributionContext);
 assert.ok(!f.materials.read(next.ref).text.includes(shared));assert.ok(f.materials.read(next.ref).text.includes(unrelated));assert.ok(f.materials.read(next.ref).text.includes('Generated third-party article: I resigned.'));
 assert.deepEqual(f.store.db.prepare("SELECT * FROM image_products WHERE capture_id=? AND kind='understanding' AND current=1").get(unrelated),unrelatedProduct);
 assert.deepEqual(f.store.db.prepare("SELECT * FROM image_products WHERE capture_id=? AND kind='ocr' AND current=1").get(shared),ocr);
 assert.equal(f.store.db.prepare('SELECT semantic_withdrawn FROM image_inputs WHERE capture_id=?').get(unrelated)!.semantic_withdrawn,0);
 await f.images.tick();await f.organize();assert.equal(calls,2);
});
