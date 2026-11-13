import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderFailure,type AttributionContext} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {fileAttachmentChildren} from '../src/file-attachments.js';
import {sha256} from '../src/store.js';
import {materialId,type MaterialDraft,type MaterialRecord} from '../src/materials.js';
import {imageMaterialProjection,projectImageMaterial,imageMaterialSections,type ImageMaterialSnapshot} from '../src/image-materials.js';
import {memoryImageGrants,memoryImageInterpretation} from '../src/memory-image-grants.js';
import {requestLocalJson} from '../src/local-http.js';
import {LOCAL_IMAGE_ERRORS,LOCAL_IMAGE_PROTOCOL,localImageRequestSchema,parseLocalImageResponse,type LocalImageRequest,type LocalImageSuccess} from '../src/local-image-contract.js';
import {generatedLocalImages,generatedLocalImageResponse,type LocalImageFixture} from './fixtures/local-image.js';
import {authorizeFixtureModels} from './fixtures/model-authorization.js';

type Node=Awaited<ReturnType<typeof buildApp>>;
const observedAt='2026-10-01T00:00:00Z';
const sourceIds={import:'generated-image-import',sync:'generated-image-sync',parent:'generated-image-parent'};

/** Only OCR/model inference is generated. IMG-03 owns the production local
 * adapter; this existing ModelAgentFactory seam does not pretend to install it.
 * Requests retain each entrance's actual context (including screen/attachment).
 * Archive ingress, authorization, ImageProcessing serialization, SQLite,
 * organizers, named outputs, Material HTTP and original-image reads stay real. */
async function fixture(t:TestContext){
 const directory=await mkdtemp(join(tmpdir(),'mote-local-image-materials-')),images=await generatedLocalImages();
 const requests:LocalImageRequest[]=[],responses:LocalImageSuccess[]=[],errors:unknown[]=[];
 type Gate={entered:()=>void;waiting:Promise<void>;release:()=>void};
 let nextGate:Gate|undefined;const gates:Gate[]=[];
 let fail=false,local=true,configuredCalls=0,serial=0,node:Node|undefined;
 const worker=createServer((req,res)=>{void (async()=>{
  assert.equal(req.headers.authorization,'Bearer generated-material-worker');
  assert.equal(req.url,LOCAL_IMAGE_PROTOCOL.path);
  const parts:Buffer[]=[];for await(const part of req)parts.push(Buffer.from(part));
  const request=localImageRequestSchema.parse(JSON.parse(Buffer.concat(parts).toString('utf8')));
  requests.push(request);
  const image=images.find(image=>sha256(image.bytes)===request.image.imageView.original.sha256);assert.ok(image);
  assert.deepEqual(Buffer.from(request.image.data,'base64'),image.bytes);
  assert.deepEqual(request.ocr,image.ocr);
  if(nextGate){const gate=nextGate;nextGate=undefined;gate.entered();await gate.waiting;}
  const response=generatedLocalImageResponse(request,image);
  const value=fail?{version:1,execution:'local',status:'error',operationId:request.operationId,captureId:request.captureId,originalSha256:response.originalSha256,imageViewId:response.imageViewId,error:{code:'inference_failed'}}:response;
  res.setHeader('Content-Type','application/json');res.setHeader('X-Mote-Execution','local');res.end(JSON.stringify(value));
 })().catch(error=>{errors.push(error);res.writeHead(500).end();});});
 await new Promise<void>(resolve=>worker.listen(0,'127.0.0.1',resolve));
 const workerUrl=`http://127.0.0.1:${(worker.address() as AddressInfo).port}${LOCAL_IMAGE_PROTOCOL.path}`;
 t.after(async()=>{for(const gate of gates)gate.release();try{await node?.app.close();}finally{await new Promise<void>((resolve,reject)=>{worker.close(error=>error?reject(error):resolve());worker.closeAllConnections();});await rm(directory,{recursive:true,force:true});}assert.deepEqual(errors,[]);});
 const config:Config={dataDir:directory,token:'generated-material-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-configured-image',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'https://generated.invalid/v1',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent'};
 node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
  const direct=input.directImages?.[0];assert.ok(direct,'this card does not run a Memory/chat inference');
  const image=images.find(image=>sha256(image.bytes)===direct.hash);assert.ok(image);
  const pixels=await reader.readImage!({id:direct.id}),record=node!.store.evidence([direct.id])[0];
  let result=image.interpretation;
  if(local){
   const row=node!.store.db.prepare("SELECT json FROM image_products WHERE capture_id=? AND kind='ocr' AND current=1").get(direct.id);
   const document=record.provenance?.document;
   const request=localImageRequestSchema.parse({version:1,operationId:input.traceContext!.operationId,captureId:direct.id,image:pixels,ocr:row?JSON.parse(String(row.json)).payload:undefined,
    context:{capturedAt:record.capturedAt,sourceType:record.source,sourceId:record.provenance?.sourceId,sourceRevision:record.provenance?.revision,title:record.windowTitle,appName:record.appName,
     attributionContext:(input.taskContext?.imageEvidence as {attributionContext?:AttributionContext}|undefined)?.attributionContext,
     document:document?{contentRole:document.contentRole,timeBasis:document.timeBasis,recordedAt:document.recordedAt,occurredAt:document.occurredAt,attachmentOf:document.attachmentOf}:undefined}});
   const bytes=Buffer.from(JSON.stringify(request));
   const raw=await requestLocalJson(workerUrl,{method:'POST',headers:{authorization:'Bearer generated-material-worker','content-type':'application/json','content-length':String(bytes.length)},body:(async function*(){yield bytes;})(),signal:input.signal!,limit:LOCAL_IMAGE_PROTOCOL.maxResponseBytes,requireOfflineExecution:true});
   const response=parseLocalImageResponse(raw,request);
   if(response.status==='error'){const failure=LOCAL_IMAGE_ERRORS[response.error.code];throw new ProviderFailure({category:failure.category,code:failure.hostCode});}
   responses.push(response);result=response.result;
  }else configuredCalls++;
  return {answer:JSON.stringify(result),citations:[],trace:[],runId:randomUUID()};
 }})});
 const central=node,headers={authorization:`Bearer ${config.token}`},archived=new ArchivedFileStore(central.store);
 await central.processing.saveImageDefault({endpoint:new URL('/ocr',workerUrl).toString()});
 central.processing.runtime.registry.get('image.http').process=async input=>{
  const parts:Buffer[]=[];for await(const part of input.readOriginal())parts.push(part);
  const image=images.find(image=>sha256(image.bytes)===sha256(Buffer.concat(parts)));assert.ok(image);return structuredClone(image.ocr);
 };
 await central.perception.save({revision:central.configService.revision,settings:{...central.perception.settings(),allowQueryImages:true}});
 await authorizeFixtureModels(central);
 for(const [kind,id] of Object.entries(sourceIds))central.sources.register({id,name:id,kind:kind==='sync'?'local-files':'upload',deviceId:'generated-image-device',platform:'import',retention:'archive'});
 const command=async(method:'POST'|'PATCH'|'DELETE',url:string,payload?:unknown)=>{
  const response=await central.app.inject({method,url,headers,...(payload===undefined?{}:{payload})});assert.ok(response.statusCode>=200&&response.statusCode<300,response.body);return response.json();
 };
 const upload=async(image:LocalImageFixture,sourceId=sourceIds.import,externalId=`image-${++serial}`,revision='1',previousRevision:string|null=null)=>{
  const response=await command('POST','/api/file-sync/v1/uploads',{sourceId,previousRevision,item:{externalId,revision,observedAt,kind:'file',layer:'original',title:'Generated retained reference',mimeType:image.mimeType,text:'',document:{contentRole:'reference',timeBasis:'unknown'}},sha256:sha256(image.bytes),sizeBytes:image.bytes.length});
  if(response.ack)return String(response.ack.id);
  const part=await central.app.inject({method:'PUT',url:`/api/file-sync/v1/uploads/${response.uploadId}/parts/0`,headers:{...headers,'content-type':'application/octet-stream'},payload:image.bytes});assert.equal(part.statusCode,200,part.body);
  return String((await command('POST',`/api/file-sync/v1/uploads/${response.uploadId}/commit`,{})).id);
 };
 const screen=async(image:LocalImageFixture,deviceId='generated-screen')=>{
  const id=randomUUID();await command('POST','/api/captures',{id,deviceId,deviceName:'Generated screen device',platform:'android',source:'screen',capturedAt:observedAt,durationMs:1000,appId:'generated.reader',appName:'Generated Reference Reader',windowTitle:'Generated screen context',ocrText:'',ocr:{status:'disabled'},privacy:{excluded:false,redacted:false,mode:'local'},imageMime:image.mimeType,imageBase64:image.bytes.toString('base64')});return id;
 };
 const organize=async()=>{for(let i=0;i<30;i++)if(await central.materialOrganizer.tick(100)===0)return;assert.fail('real organizer did not settle');};
 const material=(id:string,kind?:string)=>{
  const found=central.materials.list({limit:100}).items.find(item=>(!kind||item.kind===kind)&&central.materials.members(item.ref,{limit:100}).items.some(member=>member.ref==='capture:'+id));assert.ok(found,'real organizer must publish this source');return found;
 };
 return {node:central,headers,images,requests,responses,command,upload,screen,organize,material,setLocal(value:boolean){local=value;},setFailure(value:boolean){fail=value;},calls:()=>({local:requests.length,configured:configuredCalls}),holdNext(){
  assert.equal(nextGate,undefined);let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),waiting=new Promise<void>(resolve=>release=resolve);
  nextGate={entered,waiting,release};gates.push(nextGate);return {started,release};
 },async settle(){await central.perception.tick();await organize();},async attachment(image:LocalImageFixture){
  const file=archived.put({name:'generated-reference.png',mimeType:image.mimeType,bytes:image.bytes});
  const parent=await central.sources.upsert(sourceIds.parent,{externalId:`parent-${++serial}`,revision:'1',observedAt,title:'Generated parent document',text:'Generated author caption belongs to the parent.',kind:'message',layer:'original',document:{contentRole:'authored',timeBasis:'recorded',recordedAt:'2026-09-30T10:00:00Z',attachments:[{id:file.id,mimeType:image.mimeType}]}});
  archived.attach(parent.id,[file.id]);await central.perception.tick();
  const child=fileAttachmentChildren(central.store,parent.id).find(child=>child.fileId===file.id);assert.ok(child);
  return {parentId:parent.id,id:child.record.id,fileId:file.id};
 }};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;

async function readMaterial(f:Fixture,material:MaterialRecord){
 let text='',offset=0;
 do{const response=await f.node.app.inject({url:`/api/materials/${material.id}/read?revision=${material.revision}&offset=${offset}&length=12000`,headers:f.headers});assert.equal(response.statusCode,200,response.body);
  const page=response.json();text+=page.text;if(page.textRange.nextOffset===null)break;offset=page.textRange.nextOffset;
 }while(true);
 return text;
}
function originalReader(f:Fixture,material:MaterialRecord,key='image-original'){
 const pin=f.node.materials.input(material.ref,[key]);assert.equal(pin?.ready,true);
 const grants=memoryImageGrants(f.node.store,[pin!]);assert.equal(grants.length,1);
 const reader=f.node.featureServices.evidenceReader.agent({diagnostics:f.node.diagnostics,allowQueryImages:()=>f.node.perception.settings().allowQueryImages,currentGrantContext:()=>({processingImages:grants})});
 return {pin:pin!,grants,reader,id:grants[0].id};
}
async function assertOriginal(f:Fixture,material:MaterialRecord,image:LocalImageFixture,key='image-original'){
 const selected=originalReader(f,material,key),metadata=await selected.reader.readImage!({id:selected.id,view:'metadata'});
 assert.equal(metadata.imageView!.original.sha256,sha256(image.bytes));assert.equal(metadata.imageView!.original.width,image.width);assert.equal(metadata.imageView!.original.height,image.height);
 const original=await selected.reader.readImage!({id:selected.id,expectedImageSha256:sha256(image.bytes)});assert.equal(original.data,image.bytes.toString('base64'));return selected;
}
function snapshot(f:Fixture,id:string):ImageMaterialSnapshot{
 const projection=imageMaterialProjection(f.node.store,id)!;
 return {input:f.node.store.db.prepare('SELECT * FROM image_inputs WHERE capture_id=?').get(id) as ImageMaterialSnapshot['input'],originalAvailable:!!projection.original,understandingEnabled:f.node.perception.settings().understandingEnabled,
  products:f.node.store.db.prepare('SELECT id,name,kind,json FROM image_products WHERE capture_id=? AND current=1').all(id) as ImageMaterialSnapshot['products'],
  jobs:f.node.store.db.prepare('SELECT kind AS name,state,error FROM perception_jobs WHERE capture_id=?').all(id).map(row=>({name:String(row.name),state:String(row.state),error:row.error?String(row.error):null,kind:projection.jobs.find(job=>job.name===row.name)?.kind}))};
}

test('local and configured interpretations publish the same current Material outputs at all four image entrances',async t=>{
 const f=await fixture(t),image=f.images.find(image=>image.id==='small-text')!,models=f.node.modelSettings.view();
 for(const local of [true,false]){
  f.setLocal(local);
  const screen=await f.screen(image,`generated-screen-${local}`),imported=await f.upload(image),synced=await f.upload(image,sourceIds.sync),attachment=await f.attachment(image);
  await f.settle();
  const entries=[{id:screen,material:f.material(screen,'mote.screen-segment'),prefix:`frame/${screen}`,key:`frame/${screen}/original-image`},
   {id:imported,material:f.material(imported,'mote.file'),prefix:'image',key:'image-original'},
   {id:synced,material:f.material(synced,'mote.file'),prefix:'image',key:'image-original'},
   {id:attachment.id,material:f.material(attachment.parentId,'mote.message'),prefix:`attachment/${attachment.fileId}`,key:`attachment/${attachment.fileId}/original-image`}];
  for(const entry of entries){
   const projection=imageMaterialProjection(f.node.store,entry.id)!;
   assert.deepEqual(projectImageMaterial(snapshot(f,entry.id)),projection);
   const text=await readMaterial(f,entry.material);assert.ok(text.includes(image.interpretation.text));
   const ocrKey=entry.prefix==='image'?'extracted-text':entry.prefix+'/ocr',attachmentOcr=entry.prefix.startsWith('attachment/');
   const ocrPin=f.node.materials.input(entry.material.ref,[attachmentOcr?entry.prefix+'/text':ocrKey]);assert.equal(ocrPin?.ready,true);
   const ocrText=f.node.materials.evidence(ocrPin!.evidenceIds).map(record=>attachmentOcr?JSON.parse(record.ocrText).text:record.ocrText).join('\n');
   assert.equal(ocrText,image.ocr.segments.map(segment=>segment.text).join('\n'),'serialized Material text decodes to the exact OCR, never interpretation');
   const key=entry.prefix==='image'?'image-understanding':entry.prefix+'/understanding';
   const artifact=entry.material.artifacts!.find(artifact=>artifact.key===key)!;assert.equal(artifact.state,'ready');
   assert.equal(artifact.revision,projection.products.find(product=>product.kind==='understanding')!.revision);
   const evidence=f.node.materials.evidence(f.node.materials.input(entry.material.ref,[key])!.evidenceIds);
   assert.ok(evidence.every(record=>memoryImageInterpretation(f.node.store,record.id)));
   assert.ok(evidence.every(record=>record.provenance?.document?.contentRole==='summary'));
   assert.ok(!text.includes('generated-weights-revision')&&!text.includes('generated-engine-version'),'model diagnostics are not original or interpretation text');
   await assertOriginal(f,entry.material,image,entry.key);
   // Exercise the pure helper through the real serializer/publisher/HTTP reader,
   // without altering the CORE-03-owned organizer. States come from real products.
   const record=f.node.store.evidence([entry.id])[0],sections=imageMaterialSections(record,projection,entry.prefix);
   const projectionSource=record.provenance?.sourceId??entry.material.origin.sourceId,externalId='projection/'+entry.id;
   const draft:MaterialDraft={id:materialId(projectionSource,externalId),kind:'generated.image-projection',schemaVersion:1,title:'Generated image projection',origin:{sourceId:projectionSource,externalId},members:[{id:entry.id,kind:'capture',ref:'capture:'+entry.id}],blocks:sections.flatMap(section=>section.blocks),artifacts:sections.map(section=>({...section.artifact,blockIds:section.blocks.map(block=>block.id)})),coverage:{state:sections.some(section=>section.artifact.state!=='ready')?'partial':'complete'},fidelity:{state:'derived'},retention:{original:projection.original?'retained':'unavailable',policy:'keep'}};
   const published=f.node.materials.publish(JSON.parse(JSON.stringify(draft)));assert.ok((await readMaterial(f,published)).includes(image.interpretation.text));
   assert.ok(f.node.materials.list({query:'resigned',limit:100}).items.some(item=>item.id===entry.material.id),'the published entrance participates in actual Material search');
   if(local&&entry.id===imported&&process.env.MOTE_IMG04_EXAMPLE_PATH){
    const response=await f.node.app.inject({url:`/api/materials/${entry.material.id}`,headers:f.headers});assert.equal(response.statusCode,200);
    await writeFile(process.env.MOTE_IMG04_EXAMPLE_PATH,JSON.stringify({evidence:'generated fixture; no real model',request:f.requests.find(request=>request.captureId===entry.id),response:f.responses.find(response=>response.captureId===entry.id),products:snapshot(f,entry.id).products.map(product=>({...product,json:JSON.parse(product.json)})),projection,sections,material:response.json(),text},null,2)+'\n');
   }
  }
  assert.notEqual(entries[1].material.id,entries[2].material.id,'identical bytes cannot merge source identity');
  const projectionIds=entries.map(entry=>imageMaterialProjection(f.node.store,entry.id)!.products.find(product=>product.kind==='understanding')!.revision);assert.equal(new Set(projectionIds).size,4);
  const parentText=await readMaterial(f,entries[3].material);assert.match(parentText,/Generated author caption belongs to the parent/);
  const attachmentContext=f.requests.find(request=>request.captureId===attachment.id)?.context.document;
  if(local){assert.deepEqual(attachmentContext?.attachmentOf,{captureId:attachment.parentId,fileId:attachment.fileId});assert.equal(attachmentContext?.recordedAt,'2026-09-30T10:00:00Z');}
  assert.equal(entries[0].material.origin.deviceId,`generated-screen-${local}`);assert.match(await readMaterial(f,entries[0].material),/Generated Reference Reader/);
 }
 assert.deepEqual(f.calls(),{local:4,configured:4});assert.deepEqual(f.node.modelSettings.view(),models);
});

test('empty OCR and failed local interpretation retain independently readable originals and available OCR',async t=>{
 const f=await fixture(t),empty=f.images.find(image=>image.id==='empty-ocr')!,textImage=f.images.find(image=>image.id==='small-text')!;
 const id=await f.upload(empty);await f.settle();const material=f.material(id,'mote.file');
 assert.equal(material.artifacts!.find(artifact=>artifact.key==='extracted-text')!.state,'ready');assert.equal(imageMaterialProjection(f.node.store,id)!.products.find(product=>product.kind==='ocr')!.text,'');
 await assertOriginal(f,material,empty);
 f.setFailure(true);const failed=await f.upload(textImage);await f.settle();const partial=f.material(failed,'mote.file'),text=await readMaterial(f,partial);
 assert.equal(partial.artifacts!.find(artifact=>artifact.key==='extracted-text')!.state,'ready');assert.equal(partial.artifacts!.find(artifact=>artifact.key==='image-understanding')!.state,'failed');
 assert.ok(text.includes(textImage.ocr.segments[0].text));assert.ok(!text.includes(textImage.interpretation.text));await assertOriginal(f,partial,textImage);
 assert.equal(f.calls().configured,0);assert.ok(f.node.materials.list({query:'resigned',limit:100}).items.some(item=>item.id===partial.id));
 const before=snapshot(f,id),missing=structuredClone(before);missing.products=missing.products.filter(product=>product.kind!=='ocr');
 assert.equal(projectImageMaterial(missing).jobs.find(job=>job.kind==='ocr')!.state,'unavailable','a succeeded job without its serialized product is not ready');
});

test('current producer envelopes reject wrong original, revision, geometry and interpretation-as-OCR without losing other outputs',async t=>{
 const f=await fixture(t),image=f.images.find(image=>image.id==='small-text')!,id=await f.upload(image);await f.settle();
 const original=snapshot(f,id);
 const mutations=[(value:any)=>value.input.captureId=randomUUID(),(value:any)=>value.input.revision='obsolete',
  (value:any)=>value.evidence.original.sha256='0'.repeat(64),(value:any)=>value.evidence.original.width=0,
  (value:any)=>value.evidence.coordinateSpace='relative',(value:any)=>value.payload.regions[0].x=image.width];
 for(const mutate of mutations){
  const changed=structuredClone(original),row=changed.products.find(product=>product.kind==='understanding')!,value=JSON.parse(row.json);mutate(value);row.json=JSON.stringify(value);
  const projection=projectImageMaterial(changed);assert.equal(projection.jobs.find(job=>job.kind==='understanding')!.state,'failed');assert.equal(projection.jobs.find(job=>job.kind==='ocr')!.state,'ready');assert.deepEqual(projection.original,{captureId:id,sha256:sha256(image.bytes)});
 }
 const badOcr=structuredClone(original),ocr=badOcr.products.find(product=>product.kind==='ocr')!;ocr.json=JSON.stringify({...JSON.parse(ocr.json),payload:image.interpretation});
 const rejected=projectImageMaterial(badOcr);assert.equal(rejected.jobs.find(job=>job.kind==='ocr')!.state,'failed');assert.equal(rejected.jobs.find(job=>job.kind==='understanding')!.state,'ready');
 const diagnostic=structuredClone(original),semantic=diagnostic.products.find(product=>product.kind==='understanding')!,value=JSON.parse(semantic.json);value.model=f.responses[0].model;value.elapsedMs=f.responses[0].elapsedMs;semantic.json=JSON.stringify(value);
 assert.deepEqual(projectImageMaterial(diagnostic),projectImageMaterial(original),'actual serialized worker receipts remain diagnostic fields');
 const record=f.node.store.evidence([id])[0],frame=imageMaterialSections({...record,ocrText:'stale capture text'},projectImageMaterial(original),'frame/'+id);
 assert.equal(frame.find(section=>section.artifact.key.endsWith('/ocr'))!.blocks[0].text,image.ocr.segments.map(segment=>segment.text).join('\n'),'frame OCR uses the current serialized OCR product');
});

test('recompute publishes new semantic versions; source correction, source replacement and deletion cannot revive old image evidence',async t=>{
 const f=await fixture(t),image=f.images.find(image=>image.id==='small-text')!,id=await f.upload(image,sourceIds.import,'versioned');await f.settle();
 const before=f.material(id,'mote.file'),oldKey=before.artifacts!.find(artifact=>artifact.key==='image-understanding')!.revision,oldIds=f.node.materials.input(before.ref,['image-understanding'])!.evidenceIds;
 image.interpretation={...image.interpretation,text:'Generated revised interpretation with explicit uncertainty.'};
 await f.command('POST',`/api/images/${id}/retry`,{mode:'recompute'});await f.settle();
 const after=f.material(id,'mote.file');assert.notEqual(after.revision,before.revision);assert.notEqual(after.artifacts!.find(artifact=>artifact.key==='image-understanding')!.revision,oldKey);
 assert.ok(oldIds.every(id=>!f.node.materials.isCurrentEvidence(id)));await assertOriginal(f,after,image);
 const currentIds=f.node.materials.input(after.ref,['image-understanding'])!.evidenceIds,calls=f.calls();
 await f.command('PATCH',`/api/materials/${after.id}/context`,{expectedRevision:after.revision,ownerRelation:'third_party'});await f.settle();
 const corrected=f.material(id,'mote.file');assert.ok(currentIds.every(id=>!f.node.materials.isCurrentEvidence(id)));assert.ok(!(await readMaterial(f,corrected)).includes(image.interpretation.text));assert.deepEqual(f.calls(),calls);
 const projection=imageMaterialProjection(f.node.store,id)!;assert.ok(projection.products.every(product=>product.kind==='ocr'));await assertOriginal(f,corrected,image);
 const replacement=await f.upload(image,sourceIds.import,'versioned','2','1');await f.settle();assert.equal(imageMaterialProjection(f.node.store,id),undefined);
 const latest=f.material(replacement,'mote.file'),selected=await assertOriginal(f,latest,image);
 await f.node.perception.save({revision:f.node.configService.revision,settings:{...f.node.perception.settings(),allowQueryImages:false}});
 await assert.rejects(selected.reader.readImage!({id:selected.id}),{code:'image_disclosure_disabled'});
 await f.command('DELETE',`/api/files/${replacement}`);await f.organize();assert.equal(imageMaterialProjection(f.node.store,replacement),undefined);
 assert.ok(selected.pin.evidenceIds.every(id=>!f.node.materials.isCurrentEvidence(id)));assert.equal(f.node.materials.get(latest.id),undefined);
});

test('a retained original is ready before interpretation and late products never renew its automatic Memory grant',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=await fixture(t),image=f.images.find(image=>image.id==='small-text')!,id=await f.screen(image);await f.organize();
 const early=f.material(id,'mote.screen-segment');assert.equal(early.artifacts!.find(artifact=>artifact.key==='image-original')!.state,'ready');assert.equal(early.artifacts!.find(artifact=>artifact.key==='image-understanding')!.state,'pending');
 await assertOriginal(f,early,image,`frame/${id}/original-image`);
 const earlySections=imageMaterialSections(f.node.store.evidence([id])[0],imageMaterialProjection(f.node.store,id),`frame/${id}`);
 assert.equal(earlySections.find(section=>section.artifact.key.endsWith('/original-image'))!.artifact.state,'ready');assert.equal(earlySections.find(section=>section.artifact.key.endsWith('/understanding'))!.artifact.state,'pending');
 assert.deepEqual(f.calls(),{local:0,configured:0});
 let calls=0;const created:unknown[]=[];const runner={create:(input:unknown)=>{created.push(structuredClone(input));return {id:randomUUID(),count:++calls};},get:()=>({status:'completed'}),run:async()=>{},cancel:()=>{}};
 t.mock.timers.tick(20000);f.node.sourcePipelines.memoryWork.drain(runner,true);assert.equal(calls,1);
 const authorizations=()=>f.node.store.db.prepare('SELECT source_id,input_key,scope,capture_id,authorized,received_at,binding_json,revoked_at FROM memory_input_authorizations WHERE capture_id=?').all(id);
 const receipts=authorizations();
 const first=structuredClone(created[0]);
 const held=f.holdNext(),running=f.node.perception.tick();
 try{
  await Promise.race([held.started,running.then(()=>assert.fail('local interpretation must reach the controlled HTTP boundary'))]);
  await f.organize();const pending=f.material(id,'mote.screen-segment');
  assert.equal(pending.artifacts!.find(artifact=>artifact.key==='image-understanding')!.state,'pending');
  await assertOriginal(f,pending,image,`frame/${id}/original-image`);
  t.mock.timers.tick(70000);f.node.sourcePipelines.memoryWork.drain(runner,true);assert.equal(calls,1);
 }finally{held.release();await running;}
 await f.organize();t.mock.timers.tick(70000);f.node.sourcePipelines.memoryWork.drain(runner,true);
 // The existing default also has a distinct daily-event recipe. It may consume
 // its own intake authorization once, but cannot renew the personal recipe's
 // claimed original-image scope or acquire a new authorization on late output.
 assert.equal(calls,2);assert.deepEqual(created[0],first);
 assert.equal(new Set(created.map(input=>JSON.stringify((input as {automaticGrant:unknown}).automaticGrant))).size,2);
 assert.deepEqual(authorizations(),receipts);
 const claims=f.node.store.db.prepare('SELECT * FROM memory_input_authorizations WHERE capture_id=?').all(id);
 const late=f.material(id,'mote.screen-segment');assert.equal(late.artifacts!.find(artifact=>artifact.key==='image-understanding')!.state,'ready');
 await f.command('POST',`/api/images/${id}/retry`,{mode:'recompute'});await f.settle();t.mock.timers.tick(70000);f.node.sourcePipelines.memoryWork.drain(runner,true);
 assert.equal(calls,2);assert.deepEqual(created[0],first);assert.deepEqual(authorizations(),receipts);assert.deepEqual(f.node.store.db.prepare('SELECT * FROM memory_input_authorizations WHERE capture_id=?').all(id),claims);
});

test('withdrawing an attachment declaration retires its Material locators while the retained same-content source stays readable',async t=>{
 const f=await fixture(t),image=f.images.find(image=>image.id==='small-text')!,other=await f.upload(image),attached=await f.attachment(image);await f.settle();
 const parent=f.material(attached.parentId,'mote.message'),selected=await assertOriginal(f,parent,image,`attachment/${attached.fileId}/original-image`),before=f.calls();
 const parentRecord=f.node.store.evidence([attached.parentId])[0];
 await f.node.sources.upsert(sourceIds.parent,{externalId:parentRecord.provenance!.externalId,revision:'2',observedAt,kind:'message',layer:'original',title:'Generated parent without attachment',text:'Generated retained caption.'});
 await f.settle();assert.equal(imageMaterialProjection(f.node.store,attached.id),undefined);assert.ok(selected.pin.evidenceIds.every(id=>!f.node.materials.isCurrentEvidence(id)));
 await assert.rejects(selected.reader.readImage!({id:selected.id}));assert.deepEqual(f.calls(),before);await assertOriginal(f,f.material(other,'mote.file'),image);
});
