import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import sharp from 'sharp';
import type {ModelSettings} from '@mote/shared/models';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {FileProcessing} from '../src/file-processing.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {MaterialMemoryWork} from '../src/material-memory-work.js';
import {installCaptureMemoryIntake} from '../src/capture-memory-intake.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';
import {createImageProcessingRoutes,createImageProcessingService} from '../src/plugins/image-processing-service.js';

const model:ModelSettings={provider:'custom',protocol:'openai-completions',model:'generated-image-model',baseUrl:'http://127.0.0.1:1234/v1',apiKey:'',headers:{},extraBody:{},reasoningEffort:'auto',allowUnauthenticatedLocal:true};

async function fixture(t:import('node:test').TestContext,options:{hold?:boolean;prepare?:boolean;beforePrepare?:(processing:FileProcessing)=>void}={}){
 const directory=mkdtempSync(join(tmpdir(),'mote-image-plugin-')),store=new Store(directory),materials=new MaterialStore(store);
 const memoryWork=new MaterialMemoryWork(store,materials,()=>Date.now(),()=>true);
 const sources=new SourceStore(store,undefined,memoryWork.inputs),files=new FileStore(store,sources);
 new ArchivedFileStore(store);
 const engine=new ExecutionEngine(store),processing=new FileProcessing(files,undefined,undefined,{executor:engine,builtinContributions:false});
 await processing.runtime.ready;processing.installContributions(undefined,{imageRecipes:false});
 const disposeCaptureMemoryIntake=installCaptureMemoryIntake(store,memoryWork),organizer=new MaterialOrganizerRuntime(store,materials,[],engine,memoryWork);
 const outcomes:string[]=[],calls={ocr:0,understanding:0};let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
 processing.runtime.registry.get('image.http').process=async()=>{calls.ocr++;return {durationMs:0,segments:[{startMs:0,endMs:0,text:'Generated plugin OCR text'}]};};
 const modelSettings={select:()=>({id:'generated-file',name:'Generated file',settings:{...model}}),view:()=>({revision:1})} as unknown as import('../src/model-settings.js').ModelSettingsStore;
 const service=createImageProcessingService({
  store,processing,executor:engine,materials,modelSettings,
  resolveFileModel:()=>({settings:{...model},identity:{kind:'profile',id:'generated-file'}}),
  factory:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
   calls.understanding++;await reader.readImage!({id:input.directImages![0].id});
   if(options.hold){entered();await held;}
   return {answer:JSON.stringify({text:'Generated plugin interpretation',regions:[]}),citations:[],trace:[],runId:randomUUID()};
  }}),
  admittedUsage:(..._args)=>({
   run:async task=>task(),update(){},completed(){outcomes.push('completed');return undefined;},failed(){outcomes.push('failed');return undefined;},
  }),
  configuredFor:()=>true,probeOcr:async()=>false,
 });
 options.beforePrepare?.(processing);
 if(options.prepare!==false){await service.prepare();service.start();}
 sources.register({id:'generated-import',name:'Generated import',kind:'upload',deviceId:'generated-device',platform:'import',retention:'archive'});
 const upload=async(mimeType='image/png')=>{
  const bytes=mimeType==='text/plain'?Buffer.from('Generated non-image processing input.'):await sharp({create:{width:16,height:16,channels:3,background:'#aabbcc'}}).png().toBuffer();
  const begun=files.begin({sourceId:'generated-import',item:{externalId:randomUUID(),revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'file',layer:'original',title:'Generated image',mimeType,text:''},sha256:sha256(bytes),sizeBytes:bytes.length},()=>{});
  files.part(begun.uploadId,0,bytes,()=>{});return {id:String((await files.commit(begun.uploadId,()=>{})).id),bytes};
 };
 const organize=async()=>{for(let index=0;index<20;index++)if(await organizer.tick(200)===0)return;throw Error('Generated organizer did not settle');};
 t.after(async()=>{disposeCaptureMemoryIntake();await service.close();await organizer.close();await engine.close();await processing.close();await files.close();store.close();rmSync(directory,{recursive:true,force:true});});
 return {store,files,processing,engine,materials,memoryWork,organizer,service,upload,organize,calls,outcomes,started,release:()=>release()};
}

test('image plugin publishes matching original revision, output name and evidence range into Material and Memory candidates',async t=>{
 const f=await fixture(t),{id,bytes}=await f.upload();await f.service.tick();await f.organize();
 const material=f.materials.get(materialId('generated-import',f.files.detail(id).item.externalId))!;
 const artifact=material.artifacts!.find(item=>item.key==='image-understanding')!;
 const input=f.store.db.prepare('SELECT revision,hash FROM image_inputs WHERE capture_id=?').get(id) as {revision:number;hash:string};
 const product=f.store.db.prepare("SELECT id,name,json FROM image_products WHERE capture_id=? AND kind='understanding' AND current=1").get(id) as {id:string;name:string;json:string};
 const value=JSON.parse(product.json);
 assert.equal(product.name,'understanding','the plugin contribution publishes the recipe output name');
 assert.equal(artifact.revision,product.id,'the Material artifact pins the published output revision');
 assert.equal(value.input.captureId,id);assert.equal(value.input.revision,input.revision);assert.equal(value.input.hash,input.hash);
 assert.equal(value.evidence.ref,'capture:'+id);assert.equal(value.evidence.revision,input.revision);
 assert.equal(value.evidence.original.sha256,sha256(bytes));
 assert.equal(value.evidence.original.sha256,input.hash);
 assert.ok(artifact.blockIds.length,'the evidence range is projected into Material blocks');
 const candidate=f.store.db.prepare('SELECT * FROM material_memory_requests WHERE material_id=?').get(material.id) as {revision:string;required_json:string;source_required_json:string;input_fingerprint:string};
 assert.equal(candidate.revision,material.revision,'the Memory candidate pins the same Material revision');
 const required=JSON.parse(candidate.required_json) as string[];
 assert.ok(required.includes('extracted-text'),'the Memory candidate requires the OCR output');
 assert.equal(candidate.input_fingerprint,f.materials.input(material.ref,required)!.fingerprint);
 const understanding=f.materials.input(material.ref,['image-understanding'])!;
 assert.equal(understanding.ready,true,'Memory can select the plugin output by its declared name');
 assert.deepEqual(understanding.evidenceIds,f.materials.evidenceIds(material.ref,artifact.blockIds),'the selected output resolves the exact evidence range');
 assert.equal(understanding.fingerprint,f.materials.input(material.ref,['image-understanding'])!.fingerprint);
 assert.deepEqual(f.outcomes,['completed']);
});

test('quiesce rejects new image writes, stop leaves non-image processing live and a fresh activation reuses the same routes',async t=>{
 const f=await fixture(t),{id}=await f.upload();await f.service.tick();await f.organize();
 assert.equal((await f.service.port.detail(id)).products.some(product=>product.kind==='understanding'),true);
 const routes=createImageProcessingRoutes(),app=Fastify();t.after(async()=>{await app.close();});
 routes.activate(f.service.port);routes.mount(app,{});
 assert.equal((await app.inject({url:'/api/perception'})).statusCode,200);
 assert.equal((await app.inject({url:'/api/images/'+id})).statusCode,200);
 f.service.quiesce('disabled');
 assert.equal(f.service.port.phase,'quiescing');
 assert.equal((await app.inject({url:'/api/perception'})).statusCode,200,'reads remain available while quiescing');
 assert.equal((await app.inject({method:'POST',url:'/api/images/'+id+'/retry',payload:{mode:'complete'}})).statusCode,503);
 assert.throws(()=>f.service.port.retry(id),{statusCode:503});
 assert.equal((await f.service.port.detail(id)).id,id);
 await f.service.stop('disabled');
 assert.equal(f.service.port.phase,'stopped');
 assert.equal(f.processing.imageControl,undefined,'the image control is detached before non-image work continues');
 assert.equal((await app.inject({url:'/api/perception'})).statusCode,503);
 const text=await f.upload('text/plain');await f.processing.tick();
 assert.equal(f.files.detail(text.id).job?.state,'succeeded','non-image processing continues after the image plugin stops');
 await f.service.prepare();f.service.start();
 assert.equal(f.service.port.phase,'active');
 assert.equal((await app.inject({url:'/api/perception'})).statusCode,200,'the same route table resumes against the new activation');
 assert.equal((await f.service.port.detail(id)).id,id,'the same profile retains the earlier product');
 const next=await f.upload();await f.service.tick();await f.organize();
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM image_products WHERE capture_id=? AND kind='understanding' AND current=1").get(next.id)!.n,1,'new image work is admitted after re-enable');
 assert.throws(()=>routes.mount(app,{}),{statusCode:409},'re-enabling never mounts a second route table');
});

test('a late understanding after the original is deleted is not published or metered as success',async t=>{
 const f=await fixture(t,{hold:true}),{id}=await f.upload(),running=f.service.tick();
 await f.started;f.files.forget(id);f.release();await running;
 assert.equal(f.calls.understanding,1);assert.equal(f.store.db.prepare("SELECT count(*) n FROM image_products WHERE capture_id=? AND kind='understanding'").get(id)!.n,0);
 assert.equal(f.store.evidence([id]).length,0);
 assert.deepEqual(f.outcomes,['failed'],'the issued request remains recorded as a failure, never a success');
});

test('a failed image plugin prepare rolls back its recipes and leaves the profile available for non-image work',async t=>{
 const f=await fixture(t,{prepare:false,beforePrepare:processing=>{
  processing.runtime.imageRecipes.registerStage({id:'mote.image-ocr',version:'1',kind:'ocr',run:async()=>({durationMs:0,segments:[]})});
 }});
 await assert.rejects(f.service.prepare(),/Invalid image stage/);
 assert.equal(f.service.port.phase,'disposed');
 assert.equal(f.processing.imageControl,undefined);
 assert.equal(f.store.db.isTransaction,false,'a failed prepare leaves no database transaction open');
 assert.equal(f.processing.runtime.imageRecipes.list().recipes.length,0,'the failed contribution installed no recipe');
 assert.equal(f.processing.runtime.imageRecipes.list().stages.length,1,'the pre-existing stage was not replaced or duplicated');
 const text=await f.upload('text/plain');await f.processing.tick();
 assert.equal(f.files.detail(text.id).job?.state,'succeeded','the same profile still processes non-image work');
});
