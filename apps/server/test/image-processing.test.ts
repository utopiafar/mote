import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {Store,sha256} from '../src/store.js';
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
import {planGeneratedMemory,generatedMemoryOutput} from './fixtures/memory-planning.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';

async function fixture(t:import('node:test').TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-unified-images-')),store=new Store(directory),materials=new MaterialStore(store);let clock=Date.now();const memoryWork=new MaterialMemoryWork(store,materials,()=>clock,()=>true);
 const sources=new SourceStore(store,undefined,memoryWork.inputs),files=new FileStore(store,sources),archived=new ArchivedFileStore(store),engine=new ExecutionEngine(store),processing=new FileProcessing(files,undefined,undefined,{executor:engine});await processing.runtime.ready;
 let ocrCalls=0,visualCalls=0,empty=false,failVisual=false;
 processing.runtime.registry.get('image.http').process=async()=>{ocrCalls++;return {durationMs:0,segments:empty?[]:[{startMs:0,endMs:0,text:'Generated third-party article: I resigned.'}]};};
 const images=new ImageProcessing(store,processing,engine,{memoryWork,understanding:{selection:()=>({fingerprint:'fixture-model-1',configured:true,receipt:{model:'fixture'}}),run:async input=>{visualCalls++;if(failVisual)throw Error('Generated visual failure');const image=await input.readImage({id:input.record.id});assert.equal(image.imageView!.original.sha256,input.original.hash);return {text:'A third-party article says its author resigned. The owner is not identified as that author.',regions:[]};}}});
 const organizer=new MaterialOrganizerRuntime(store,materials,[],engine,memoryWork);
 const bytes=await sharp({create:{width:16,height:16,channels:3,background:'#aabbcc'}}).png().toBuffer();
 for(const id of ['generated-import','generated-sync','generated-parent'])sources.register({id,name:id,kind:'upload',deviceId:'generated-device',platform:'import',retention:'archive'});
 const screen=async()=>{const id=randomUUID();await store.ingest({id,deviceId:'generated-android',deviceName:'Fixture Android',platform:'android',source:'screen',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,appId:'fixture',appName:'Fixture',ocrText:'',ocr:{status:'disabled'},privacy:{excluded:false,redacted:false,mode:'local'},imageMime:'image/png',imageBase64:bytes.toString('base64')});return id;};
 const upload=async(sourceId='generated-import',override?:string,mimeType='image/png')=>{
  const begun=files.begin({sourceId,processingProfileId:override,item:{externalId:randomUUID(),revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'file',layer:'original',title:'Generated image',mimeType,text:''},sha256:sha256(bytes),sizeBytes:bytes.length},()=>{});files.part(begun.uploadId,0,bytes,()=>{});return String((await files.commit(begun.uploadId,()=>{})).id);
 };
 const organize=async()=>{for(let i=0;i<20;i++)if(await organizer.tick(200)===0)return;throw Error('Organizer did not settle');};
 t.after(async()=>{await engine.close();await images.close();await organizer.close();await processing.close();await files.close();store.close();rmSync(directory,{recursive:true,force:true});});
 return {store,sources,files,archived,processing,images,engine,bytes,materials,organizer,memoryWork,advance:(ms:number)=>{clock+=ms;},screen,upload,organize,calls:()=>({ocr:ocrCalls,visual:visualCalls}),empty:()=>{empty=true;},failVisual:()=>{failVisual=true;}};
}

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
