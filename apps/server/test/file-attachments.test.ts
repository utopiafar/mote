import {fixtureFilePolicy} from './fixtures/file-policy.js';
import {readAgentCredential} from './login-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import type {QueryInput} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {sha256} from '../src/store.js';
import {materialId} from '../src/materials.js';
import {fileAttachmentParent} from '../src/file-attachments.js';

const token='generated-attachment-owner',headers={authorization:'Bearer '+token};
const caption='I saved a generated engineering discussion because I wanted to revisit it.';
const words='Generated participant described testing idempotent writes; implementation by the owner is unknown.';
const location={width:8,height:8,polygon:[[1,1],[7,1],[7,5],[1,5]]};
async function fixture(t:import('node:test').TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-attachment-composition-')),config:Config={dataDir:directory,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'http://127.0.0.1:1234/v1',apiKey:'',allowUnauthenticatedLocal:true,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let node:Awaited<ReturnType<typeof buildApp>>,ocrCalls=0;const modelCalls:QueryInput[]=[],failed=new Set<string>();
 const start=async()=>{
  node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
   modelCalls.push(input);const visible=await reader.evidence({ids:input.evidenceIds!});assert.equal(visible.length,input.evidenceIds!.length);
   const text=visible.map(r=>r.ocrText).join('\n');assert.ok(text.includes(caption)&&text.includes(words),'both strategies receive actual caption and attachment evidence');
   const evidence=visible.map(r=>({id:r.id,quote:r.ocrText.trim()})),common={uncertainty:'Generated fixture; speaker identity and owner implementation are unknown.',admission:{layer:'memory',reason:'Generated supported record',scope:'Generated discussion',attribution:'user'},evidenceIds:visible.map(r=>r.id),evidence};
   let memories=[{...common,domain:'personal',title:'Generated saved discussion',statement:'Saved a discussion to revisit it.'},{...common,domain:'coding',title:'Generated engineering reference',statement:'Retained a referenced idempotency design.',coding:{kind:'principle',scope:'session',applicability:'Generated discussion',validation:'unverified'}}];
   if(input.traceContext?.phase==='review'){const batch=node.memoryPipeline.get(input.traceContext.jobId!).batches.find(b=>b.id===input.traceContext!.batchId)!;memories=[memories[batch.strategy!.recipe.id.endsWith('coding')?1:0]];}
   return {answer:JSON.stringify({memories}),citations:visible.map(r=>({id:r.id,capturedAt:r.capturedAt,appName:r.appName,excerpt:''})),trace:[],runId:randomUUID()};
  }})});
  await node.processing.runtime.ready;node.processing.runtime.registry.get('image.http').process=async input=>{ocrCalls++;if(failed.has(input.file.id))throw Error('Generated processing failure');return {durationMs:0,segments:[{startMs:0,endMs:0,text:words,imageLocation:location}]};};
  const settings=node.lifecycle.settings();for(const key of ['extraction','consolidation','insights','working'] as const)settings[key].enabled=false;node.lifecycle.configure(settings);
  node.perception.configure({...node.perception.settings(),allowQueryImages:true});await node.app.ready();
 };
 await start();node.processing.update({revision:node.processing.view().revision,settings:{...node.processing.view().settings,enabled:true,imageProcessor:'image.http',imageEndpoint:'http://127.0.0.1:9008/ocr',summarize:false},policy:fixtureFilePolicy({...node.processing.view().settings,enabled:true,imageProcessor:'image.http',imageEndpoint:'http://127.0.0.1:9008/ocr',summarize:false},node.processing.runtime.registry)});
 const bytes=await sharp({create:{width:8,height:8,channels:3,background:'#abcdef'}}).png().toBuffer();
 for(const sourceId of ['generated-images','generated-notes'])node.sources.register({id:sourceId,name:sourceId,kind:'upload',deviceId:'generated-attachments',platform:'import',retention:'archive'});
 const upload=async(key:string)=>{const begun=node.files.begin({sourceId:'generated-images',item:{externalId:key,revision:'1',observedAt:'2026-09-27T00:00:00Z',kind:'file',layer:'original',title:key,mimeType:'image/png',text:''},sha256:sha256(bytes),sizeBytes:bytes.length},()=>{});node.files.part(begun.uploadId,0,bytes,()=>{});return (await node.files.commit(begun.uploadId,()=>{})).id as string;};
 const author=async(key:string,count=1)=>{
  const originals=Array.from({length:count},(_,i)=>node.archivedFiles.put({name:key+'-'+i+'.png',mimeType:'application/octet-stream',bytes}));
  const item={externalId:key,revision:'1',kind:'message',layer:'original',text:caption,observedAt:'2026-09-27T00:00:00Z',document:{contentRole:'authored',recordedAt:'2026-04-13T13:18:00+08:00',timeBasis:'recorded',attachments:originals.map(f=>({id:f.id,mimeType:f.mimeType,name:f.name}))}};
  const parent=await node.sources.upsert('generated-notes',item);node.archivedFiles.attach(parent.id,originals.map(f=>f.id));return {id:parent.id,originals,item,materialId:materialId('generated-notes',key)};
 };
 const request=(parentId:string,fileId:string,body:unknown={mimeType:'image/png'},selectedHeaders=headers)=>node.app.inject({method:'POST',url:`/api/records/${parentId}/attachments/${fileId}/processing`,headers:selectedHeaders,payload:body as any});
 const prepare=async(parentId:string,fileId:string)=>{const response=await request(parentId,fileId);assert.equal(response.statusCode,200,response.body);return response.json().captureId as string;};
 const organize=async()=>{for(let i=0;i<20;i++)if(await node.materialOrganizer.tick(100)===0)return;throw Error('Organizer failed to settle');};
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 return {get node(){return node;},bytes,failed,modelCalls,upload,author,request,prepare,organize,ocrCalls:()=>ocrCalls,async restart(){await node.app.close();await start();}};
}

test('an archived image reuses one extraction and composes with its caption for independent Memory recipes',async t=>{
 const f=await fixture(t),donor=await f.upload('prepared');await f.node.processing.tick();assert.equal(f.ocrCalls(),1);
 const authored=await f.author('caption'),image=authored.originals[0];await f.organize();
 const initial=f.node.materials.input(authored.materialId,['source-body'])!;assert.equal(initial.ready,true);
 const child=await f.prepare(authored.id,image.id);assert.notEqual(child,donor);assert.equal((await f.request(authored.id,image.id)).json().duplicate,true);
 assert.equal(f.node.files.version(child).object_hash,f.node.files.version(donor).object_hash);
 await f.organize();const requirement=`attachment/${image.id}/text`;
 assert.equal(f.node.materials.input(authored.materialId,[requirement])!.ready,false);
 assert.equal(f.node.materials.input(authored.materialId,['source-body'])!.fingerprint,initial.fingerprint);
 await f.node.processing.tick();await f.organize();assert.equal(f.ocrCalls(),1,'the second view reuses raw OCR under the exact processor/input fingerprint');
 const current=f.node.materials.get(authored.materialId)!;assert.equal(current.memberCount,2);assert.equal(current.coverage.state,'complete');
 assert.equal(f.node.materials.get(materialId('generated-notes',f.node.files.detail(child).item.externalId)),undefined,'the attachment belongs to the parent composition');
 const pin=f.node.materials.input(current.ref,['source-body',requirement])!;assert.equal(pin.ready,true);assert.equal(pin.evidenceIds.length,2);
 const records=f.node.materials.evidence(pin.evidenceIds);assert.ok(records.some(r=>r.ocrText.includes(caption)));assert.deepEqual(JSON.parse(records.find(r=>r.ocrText.includes(words))!.ocrText).imageLocation,location);
 const artifact=f.node.files.detail(child).artifacts.find((a:any)=>a.kind==='image-text')!;assert.equal((artifact as any).reuse.captureId,donor);
 const recipes=[{id:'fixture.attachment-personal',version:'1'},{id:'fixture.attachment-coding',version:'1'}];
 for(const [i,recipe] of recipes.entries())f.node.memoryStrategies.registerRecipe({...recipe,requires:['source-body',requirement],extract:{id:'mote.context-extraction',version:'3.4.0'},review:{id:i?'mote.coding-review':'mote.personal-review',version:'2'}});
 const job=f.node.memoryPipeline.create({evidenceIds:pin.evidenceIds,recipes});const done=await f.node.memoryPipeline.run(job.id);assert.equal(done.status,'completed',JSON.stringify(f.node.memoryPipeline.get(job.id)));
 assert.equal(done.memoryIds.length,2);assert.equal(f.modelCalls.filter(c=>c.traceContext?.phase==='extract').length,1);assert.equal(f.modelCalls.filter(c=>c.traceContext?.phase==='review').length,2);assert.equal(f.ocrCalls(),1);
 const reader=f.node.featureServices.archiveReader,result=await reader.timeline({after:'2026-04-13T00:00:00+08:00',before:'2026-04-14T00:00:00+08:00'}),found=Array.isArray(result)?result:result.items;assert.equal(found.length,1);
 assert.equal((await reader.readImage!({id:found[0].id,attachmentId:image.id})).data,f.bytes.toString('base64'));
 await f.restart();await f.organize();await f.node.processing.tick();assert.equal(f.ocrCalls(),1);assert.equal(f.node.memoryPipeline.list().length,1);
 f.node.store.delete(authored.id);await f.organize();assert.equal(f.node.memories.list({includeStale:true}).length,0);
 assert.equal(f.node.files.version(donor).object_hash,sha256(f.bytes),'independently retained original survives removal of the caption');
 await assert.rejects(f.node.featureServices.archiveReader.readImage!({id:child}));
});

test('processing one selected attachment does not block its caption or another ready attachment',async t=>{
 const f=await fixture(t),authored=await f.author('two-images',2),one=await f.prepare(authored.id,authored.originals[0].id),two=await f.prepare(authored.id,authored.originals[1].id);
 // Explicit forced processing bypasses the shared extraction cache.
 f.node.processing.retry(two);f.failed.add(two);await f.organize();const body=f.node.materials.input(authored.materialId,['source-body'])!;
 await f.node.processing.tick();await f.organize();assert.equal(f.node.files.detail(one).job.state,'succeeded');assert.equal(f.node.files.detail(two).job.state,'failed');
 assert.equal(f.node.materials.input(authored.materialId,['source-body'])!.fingerprint,body.fingerprint);
 const ready=`attachment/${authored.originals[0].id}/text`,waiting=`attachment/${authored.originals[1].id}/text`;
 assert.equal(f.node.materials.input(authored.materialId,['source-body',ready])!.ready,true);assert.equal(f.node.materials.input(authored.materialId,[waiting])!.ready,false);
 const before=f.node.materials.input(authored.materialId,[ready])!.fingerprint;
 assert.equal(f.node.processing.cancellation(two).wait,'unknown');assert.throws(()=>f.node.processing.retry(two,'transcribe',true),{statusCode:409});
 f.failed.delete(two);f.node.processing.retry(two,'transcribe',true,true);await f.node.processing.tick();await f.organize();
 assert.equal(f.node.materials.input(authored.materialId,[waiting])!.ready,true);assert.equal(f.node.materials.input(authored.materialId,[ready])!.fingerprint,before);assert.equal(f.ocrCalls(),2,'recovery reuses the already valid independent image extraction');
});

test('attachment admission requires owner authorization and exact retained parent linkage',async t=>{
 const f=await fixture(t),authored=await f.author('authorized'),other=await f.author('foreign');
 assert.equal((await f.request(authored.id,authored.originals[0].id,{},{})).statusCode,401);
 const {invitation}=f.node.connections.invite({label:'Generated collector',serverUrl:'http://127.0.0.1:57569',deviceId:'generated-attachments'});
 const collector=await readAgentCredential(f.node.connections);
 assert.equal((await f.request(authored.id,authored.originals[0].id,{mimeType:'image/png'},{authorization:'Bearer '+collector.token})).statusCode,403);
 assert.equal((await f.request(authored.id,other.originals[0].id)).statusCode,404);
 assert.equal((await f.request(authored.id,authored.originals[0].id,{})).statusCode,400);
 const child=await f.prepare(authored.id,authored.originals[0].id);assert.equal(fileAttachmentParent(f.node.store,child)?.record.id,authored.id);
 f.node.store.db.prepare('DELETE FROM capture_files WHERE capture_id=? AND file_id=?').run(authored.id,authored.originals[0].id);
 assert.equal(fileAttachmentParent(f.node.store,child),undefined);assert.equal((await f.request(authored.id,authored.originals[0].id)).statusCode,404);
 await assert.rejects(f.node.featureServices.archiveReader.readImage!({id:child}));await f.node.processing.tick();assert.equal(f.ocrCalls(),0);
 await f.organize();assert.equal(f.node.materials.get(materialId('generated-notes',f.node.files.detail(child).item.externalId)),undefined);
});

test('content reuse is opt-in and exact processor settings and versions are required',async t=>{
 const f=await fixture(t),processor=f.node.processing.runtime.registry.get('image.http');processor.reuseByContent=false;
 await f.upload('first');await f.node.processing.tick();await f.upload('second');await f.node.processing.tick();assert.equal(f.ocrCalls(),2);
 processor.reuseByContent=true;await f.upload('third');await f.node.processing.tick();assert.equal(f.ocrCalls(),2);
 f.node.processing.update({revision:f.node.processing.view().revision,settings:{...f.node.processing.view().settings,imageEndpoint:'http://127.0.0.1:9008/changed'},policy:fixtureFilePolicy({...f.node.processing.view().settings,imageEndpoint:'http://127.0.0.1:9008/changed'},f.node.processing.runtime.registry)});
 await f.upload('different-settings');await f.node.processing.tick();assert.equal(f.ocrCalls(),3);
 processor.version='generated-next-version';await f.upload('different-version');await f.node.processing.tick();assert.equal(f.ocrCalls(),4);
});

test('retaining attachments and restarting never admits historical extraction automatically',async t=>{
 const f=await fixture(t),authored=await f.author('unrequested');await f.organize();await f.node.processing.tick();
 await f.restart();await f.organize();await f.node.processing.tick();assert.equal(f.ocrCalls(),0);
 assert.equal(f.node.store.db.prepare('SELECT COUNT(*) n FROM file_versions').get()!.n,0);
 assert.equal(f.node.materials.input(authored.materialId,['source-body'])!.ready,true);
});

test('partial OCR remains visibly partial while the authored body stays independently ready',async t=>{
 const f=await fixture(t),authored=await f.author('partial'),child=await f.prepare(authored.id,authored.originals[0].id);
 f.node.processing.runtime.registry.get('image.http').process=async()=>({durationMs:0,coverage:'partial',segments:[{startMs:0,endMs:0,text:words,imageLocation:location}]});
 await f.node.processing.tick();await f.organize();assert.equal(f.node.files.detail(child).job.state,'succeeded');
 assert.equal(f.node.materials.get(authored.materialId)!.coverage.state,'partial');
 assert.equal(f.node.materials.input(authored.materialId,['source-body'])!.ready,true);
 assert.equal(f.node.materials.input(authored.materialId,[`attachment/${authored.originals[0].id}/text`])!.ready,true,'available partial text can be explicitly selected without claiming full coverage');
});

test('deleting a parent while OCR is running prevents late attachment evidence from being published',async t=>{
 const f=await fixture(t),authored=await f.author('in-flight'),child=await f.prepare(authored.id,authored.originals[0].id);
 let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);
 f.node.processing.runtime.registry.get('image.http').process=async()=>{enter();await held;return {durationMs:0,segments:[{startMs:0,endMs:0,text:words,imageLocation:location}]};};
 const running=f.node.processing.tick();await entered;
 try{f.node.store.delete(authored.id);}finally{release();}
 await running;await f.organize();assert.equal(fileAttachmentParent(f.node.store,child),undefined);
 assert.equal(f.node.store.db.prepare('SELECT COUNT(*) n FROM file_artifacts WHERE capture_id=?').get(child)!.n,0);
 await assert.rejects(f.node.featureServices.archiveReader.readImage!({id:child}));
});
