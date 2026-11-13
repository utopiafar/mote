import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {ProviderFailure,type AttributionContext} from '@mote/shared';
import {startBridge} from '../../../packages/agent/dist/bridge.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {ModelAgentFactory} from '../src/model-agent.js';
import {ImageInterpretationError} from '../src/image-recipes.js';
import {imageOutput} from '../src/evidence-image.js';
import {requestLocalJson} from '../src/local-http.js';
import {sha256} from '../src/store.js';
import {memoryImageGrants} from '../src/memory-image-grants.js';
import {LOCAL_IMAGE_ERRORS,LOCAL_IMAGE_PROTOCOL,localImagePluginStateSchema,localImageRequestSchema,parseLocalImageResponse,type LocalImageSuccess} from '../src/local-image-contract.js';
import {generatedLocalImages,startLocalImageFixtureWorker,type LocalImageFixture,type LocalImageWorkerFault} from './fixtures/local-image.js';
import {authorizeFixtureModels} from './fixtures/model-authorization.js';

const generated=generatedLocalImages();
type Node=Awaited<ReturnType<typeof buildApp>>;
const sourceId='generated-local-image-contract';

/** Pre-CORE skeleton: only inference and OCR are generated boundaries. The
 * production startup, authorization, HTTP archive ingress, ImageUnderstanding,
 * ImageProcessing, SQLite, organizer and evidence reader remain real. Routing
 * here is a fixture control, not IMG-02's unimplemented product plugin switch.
 * IMG-03 will replace this model-factory boundary with the local domain port. */
async function fixture(t:import('node:test').TestContext,options:{authorize?:boolean}={}){
 const directory=mkdtempSync(join(tmpdir(),'mote-local-image-contract-'));
 const images=await generated,worker=await startLocalImageFixtureWorker(images);
 let node:Node|undefined,enabled=true,ocrCalls=0,configuredCalls=0,serial=0;
 const responses:LocalImageSuccess[]=[],archivedHashes=new Set<string>();
 t.after(async()=>{try{await node?.app.close();}finally{try{await worker.close();}finally{rmSync(directory,{recursive:true,force:true});}}});
 const factory:ModelAgentFactory=async(settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
  const direct=input.directImages?.[0];assert.ok(direct,'this contract never runs a generated Memory/chat model');
  assert.deepEqual(input.hostToolSelection,['read_image'],'intake interpretation receives only the existing read-only image tool');
  assert.equal(settings.model,'generated-configured-image','local routing does not change the selected model settings');
  const record=node!.store.evidence([direct.id])[0],image=images.find(item=>sha256(item.bytes)===direct.hash);assert.ok(image);
  const pixels=await reader.readImage!({id:direct.id,...(image.region?{expectedImageSha256:direct.hash,region:image.region}:{})});
  let result=image.interpretation;
  if(enabled){
   const ocr=JSON.parse(String(node!.store.db.prepare("SELECT json FROM image_products WHERE capture_id=? AND kind='ocr' AND current=1").get(direct.id)!.json)).payload;
   const document=record.provenance?.document,attributionContext=(input.taskContext?.imageEvidence as {attributionContext?:AttributionContext}|undefined)?.attributionContext;
   const request=localImageRequestSchema.parse({version:LOCAL_IMAGE_PROTOCOL.version,operationId:input.traceContext!.operationId,captureId:direct.id,image:pixels,ocr,context:{capturedAt:record.capturedAt,sourceType:record.source,sourceId:record.provenance?.sourceId,sourceRevision:record.provenance?.revision,title:record.windowTitle,appName:record.appName,attributionContext,document:document?{contentRole:document.contentRole,timeBasis:document.timeBasis,recordedAt:document.recordedAt,occurredAt:document.occurredAt,attachmentOf:document.attachmentOf}:undefined}});
   const bytes=Buffer.from(JSON.stringify(request));let raw:unknown;
   try{raw=await requestLocalJson(worker.url,{method:LOCAL_IMAGE_PROTOCOL.method,headers:{Authorization:`Bearer ${worker.token}`,'Content-Type':'application/json','Content-Length':String(bytes.length)},body:(async function*(){yield bytes;})(),signal:input.signal!,limit:LOCAL_IMAGE_PROTOCOL.maxResponseBytes,requireOfflineExecution:true});}
   catch(error){if(error instanceof SyntaxError)throw new ImageInterpretationError('Local worker returned invalid JSON');throw error;}
   const response=parseLocalImageResponse(raw,request);
   if(response.status==='error'){const failure=LOCAL_IMAGE_ERRORS[response.error.code];throw new ProviderFailure({category:failure.category,code:failure.hostCode,retryAfterMs:response.error.retryAfterMs});}
   responses.push(response);result=response.result;
  }else configuredCalls++;
  // The real configured-model adapter parses this serialized interpretation and
  // checks pixel inspection; the actual product consumer then publishes it.
  return {answer:JSON.stringify(result),citations:[],trace:[],runId:randomUUID()};
 }});
 const config:Config={dataDir:directory,token:'generated-local-image-contract-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-configured-image',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'https://generated.example.invalid/v1',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent'};
 node=await buildApp(config,{backgroundWorker:false,createModelAgent:factory});
 const appNode=node,headers={authorization:`Bearer ${config.token}`};
 const models=appNode.modelSettings.view();
 await appNode.modelSettings.updateDefaults({revision:models.revision,defaults:models.defaults,defaultModels:{file:'generated-configured-image',memory:'generated-memory-model',chat:'generated-chat-model'}});
 await appNode.processing.saveImageDefault({endpoint:new URL('/ocr',worker.url).toString()});
 appNode.processing.runtime.registry.get('image.http').process=async input=>{
  ocrCalls++;const parts:Buffer[]=[];for await(const part of input.readOriginal())parts.push(part);
  const image=images.find(item=>sha256(item.bytes)===sha256(Buffer.concat(parts)));assert.ok(image);
  return structuredClone(image.ocr);
 };
 await appNode.perception.save({revision:appNode.configService.revision,settings:{...appNode.perception.settings(),allowQueryImages:true}});
 if(options.authorize!==false)await authorizeFixtureModels(appNode);
 appNode.sources.register({id:sourceId,name:'Generated image contract',kind:'upload',deviceId:'generated-image-device',platform:'import',retention:'archive'});
 return {node:appNode,headers,worker,responses,images,setEnabled(value:boolean){enabled=value;},calls:()=>({ocr:ocrCalls,configured:configuredCalls,local:worker.requests.length}),async upload(image:LocalImageFixture,profile?:'archive'){
  const response=await appNode.app.inject({method:'POST',url:'/api/file-sync/v1/uploads',headers,payload:{sourceId,processingProfileId:profile,item:{externalId:`${++serial}-${image.id}.png`,revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'file',layer:'original',mimeType:image.mimeType,title:`Generated ${image.id}`,text:'',document:{contentRole:'reference',timeBasis:'unknown'}},sha256:sha256(image.bytes),sizeBytes:image.bytes.length}});
  assert.equal(response.statusCode,200,response.body);const upload=response.json();let ack=upload.ack;
  if(archivedHashes.has(sha256(image.bytes))){
   assert.ok(ack,'the real ingress reuses an already archived content object');assert.equal(ack.sha256,sha256(image.bytes));
  }else{
   assert.equal(ack,null,'a new content object has no receipt until bytes commit');
   const part=await appNode.app.inject({method:'PUT',url:`/api/file-sync/v1/uploads/${upload.uploadId}/parts/0`,headers:{...headers,'content-type':'application/octet-stream'},payload:image.bytes});assert.equal(part.statusCode,200,part.body);
   const committed=await appNode.app.inject({method:'POST',url:`/api/file-sync/v1/uploads/${upload.uploadId}/commit`,headers,payload:{}});assert.equal(committed.statusCode,200,committed.body);ack=committed.json();
   archivedHashes.add(sha256(image.bytes));
  }
  assert.deepEqual(ack.receipt,{version:2,id:ack.id,kind:'file-revision',state:'received',duplicate:false,sourceId,externalId:`${serial}-${image.id}.png`,revision:'1'});
  return String(ack.id);
 },async settle(){
  await appNode.perception.tick();for(let i=0;i<30;i++)if(await appNode.materialOrganizer.tick(100)===0)return;
  assert.fail('real Material organizer did not settle');
 }};
}

function imageMaterial(node:Node,id:string){
 const detail=node.perception.detail(id),material=node.materials.list({sourceId}).items.find(item=>node.materials.members(item.ref,{limit:100}).items.some(member=>member.ref==='capture:'+id));
 assert.ok(material,'real organizer publishes the uploaded original');return {detail,material};
}
function originalAnchor(node:Node,material:ReturnType<typeof imageMaterial>['material']){
 const original=material.artifacts!.find(artifact=>artifact.key==='image-original');assert.equal(original?.state,'ready');
 const anchors=node.materials.evidenceIds(material.ref),anchor=anchors.find(id=>node.store.db.prepare('SELECT block_id FROM material_evidence WHERE id=?').get(id)?.block_id===original!.blockIds[0]);assert.ok(anchor);return anchor;
}
async function readArchivedImage(node:Node,id:string,image:LocalImageFixture){
 const {material}=imageMaterial(node,id),anchor=originalAnchor(node,material),pin=node.materials.input(material.ref,['image-original']);assert.equal(pin?.ready,true);
 const grants=memoryImageGrants(node.store,[pin!]);assert.equal(grants.length,1);assert.equal(grants[0].id,anchor);
 const reader=node.featureServices.evidenceReader.agent({diagnostics:node.diagnostics,allowQueryImages:()=>node.perception.settings().allowQueryImages,currentGrantContext:()=>({processingImages:grants})});
 const bridge=await startBridge(reader,{question:'Inspect this generated original using its Material locator',evidenceIds:pin!.evidenceIds,processingImages:grants,processingMaterialInputs:[pin!],hostToolSelection:['read_image']},8);
 try{
  const call=async(args:unknown)=>{const response=await fetch(bridge.url+'/read_image',{method:'POST',headers:{authorization:`Bearer ${bridge.token}`,'content-type':'application/json'},body:JSON.stringify(args)});const body=await response.json() as any;assert.equal(response.status,200,JSON.stringify(body));return body;};
  const metadata=await call({id:anchor,view:'metadata'});assert.equal(metadata.image,undefined);assert.equal(bridge.imageReadReceipts.length,0);
  assert.equal(metadata.imageView.original.sha256,sha256(image.bytes));assert.equal(metadata.imageView.original.width,image.width);assert.equal(metadata.imageView.original.height,image.height);
  const full=await call({id:anchor,expectedImageSha256:metadata.imageView.original.sha256});assert.equal(full.image.data,image.bytes.toString('base64'),'read_image delivers the archived original, not interpretation/OCR');
  assert.equal(bridge.imageReadReceipts.length,0,'prepared pixels are not yet delivery proof');bridge.imageDelivery(full.imageDelivery,true);assert.equal(bridge.imageReadReceipts.length,1);
  if(image.region){
   const crop=await call({id:anchor,expectedImageSha256:metadata.imageView.original.sha256,region:image.region}),region=image.region;
   assert.deepEqual(crop.imageView.region,region);assert.equal(crop.imageView.original.sha256,sha256(image.bytes));
   assert.deepEqual(await sharp(Buffer.from(crop.image.data,'base64')).raw().toBuffer(),await sharp(image.bytes).extract({left:region.x,top:region.y,width:region.width,height:region.height}).toColourspace('srgb').raw().toBuffer());
   bridge.imageDelivery(crop.imageDelivery,true);assert.equal(bridge.imageReadReceipts.length,2);
  }
  assert.ok(bridge.imageReadReceipts.every(receipt=>receipt.id===anchor));
 }finally{await bridge.close();}
}

test('generated local and configured-model results reach real archive products, Material originals and downstream read_image',async t=>{
 const f=await fixture(t),before=f.node.modelSettings.view();
 for(const enabled of [true,false]){
  f.setEnabled(enabled);
  for(const image of f.images){
   const id=await f.upload(image);await f.settle();const {detail,material}=imageMaterial(f.node,id);
   assert.equal(detail.original.hash,sha256(image.bytes));assert.equal(f.node.files.detail(id).hasOriginal,true);
   assert.equal(detail.products.find(product=>product.kind==='understanding')?.text,image.interpretation.text);
   assert.deepEqual(detail.products.find(product=>product.kind==='understanding')?.regions,image.interpretation.regions);
   assert.equal(material.artifacts!.find(artifact=>artifact.key==='extracted-text')?.state,'ready','successful empty OCR is ready too');
   assert.equal(material.artifacts!.find(artifact=>artifact.key==='image-understanding')?.state,'ready');
   const interpretation=f.node.materials.read(material.ref).text;assert.match(interpretation,/model_interpretation/);assert.ok(interpretation.includes(image.interpretation.text));
   const stored=JSON.parse(String(f.node.store.db.prepare("SELECT json FROM image_products WHERE capture_id=? AND kind='understanding' AND current=1").get(id)!.json));
   assert.equal(stored.evidence.original.sha256,sha256(image.bytes));assert.equal(stored.evidence.coordinateSpace,'encoded-raster-pixels-v1');
   const ocr=JSON.parse(String(f.node.store.db.prepare("SELECT json FROM image_products WHERE capture_id=? AND kind='ocr' AND current=1").get(id)!.json));assert.deepEqual(ocr.payload,image.ocr);
   await readArchivedImage(f.node,id,image);
  }
  assert.deepEqual(f.node.modelSettings.view(),before,'the generated intake route switch preserves all selected models');
 }
 assert.deepEqual({local:f.calls().local,configured:f.calls().configured},{local:6,configured:6});
 assert.ok(f.responses.every(response=>response.model.id==='InternVL3-14B-4bit'&&response.model.quantization==='4bit'&&response.elapsedMs===17));
 assert.ok(f.responses.every(response=>response.usage===undefined),'unavailable usage is absent, never fabricated zero');
 assert.equal(f.node.modelSettings.select('memory').settings.model,'generated-memory-model');assert.equal(f.node.modelSettings.select('chat').settings.model,'generated-chat-model');
 assert.equal(f.node.memories.list().length,0,'interpretations never create Memory by themselves');
});

test('local transport failures never publish interpretation, lose original/OCR or fall back to the configured model',async t=>{
 const cases:[LocalImageWorkerFault,string][]=[['model_missing','model_missing'],['worker_unavailable','image_worker_unavailable'],['busy','rate_limited'],['inference_failed','image_processing_failed'],['invalid-json','invalid_image_product'],['normalized-region','invalid_image_product'],['out-of-bounds','invalid_image_region'],['wrong-version','invalid_image_product'],['wrong-original','invalid_image_product'],['wrong-operation','invalid_image_product'],['wrong-view','invalid_image_product']];
 for(const [fault,code] of cases)await t.test(fault,async child=>{
  const f=await fixture(child),image=f.images.find(image=>image.id==='small-text')!;
  f.worker.setFault(fault);const id=await f.upload(image);await f.settle();const {detail,material}=imageMaterial(f.node,id);
  const job=detail.jobs.find(job=>job.name==='understanding');assert.ok(job);assert.notEqual(job.state,'succeeded');assert.equal(job.error,code);
  assert.equal(detail.products.some(product=>product.kind==='understanding'),false);assert.equal(detail.products.find(product=>product.kind==='ocr')?.text,image.ocr.segments[0].text);
  assert.equal(material.artifacts!.find(artifact=>artifact.key==='extracted-text')?.state,'ready');originalAnchor(f.node,material);
  assert.equal(f.node.files.detail(id).sha256,sha256(image.bytes));assert.equal(f.node.files.detail(id).hasOriginal,true);assert.equal(f.calls().configured,0);
 });
});

test('an explicit retry after local readiness recovery reuses successful OCR and retains the exact original',async t=>{
 const f=await fixture(t),image=f.images.find(image=>image.id==='empty-ocr')!;
 f.worker.setFault('model_missing');const id=await f.upload(image);await f.settle();const before=f.calls();
 assert.equal(imageMaterial(f.node,id).detail.jobs.find(job=>job.name==='understanding')?.state,'blocked');
 f.worker.setFault();const retry=await f.node.app.inject({method:'POST',url:`/api/images/${id}/retry`,headers:f.headers,payload:{mode:'complete'}});assert.equal(retry.statusCode,200,retry.body);
 await f.settle();assert.equal(f.calls().ocr,before.ocr);assert.equal(f.calls().local,before.local+1);assert.equal(f.calls().configured,0);
 assert.equal(imageMaterial(f.node,id).detail.products.find(product=>product.kind==='understanding')?.text,image.interpretation.text);await readArchivedImage(f.node,id,image);
});

test('cancelling an in-flight local request preserves OCR and original while rejecting its late interpretation',async t=>{
 const f=await fixture(t),image=f.images.find(image=>image.id==='small-text')!,held=f.worker.holdNext();
 t.after(()=>held.release());const id=await f.upload(image),running=f.node.perception.tick();
 try{
  await Promise.race([held.started,running.then(()=>assert.fail('The generated local request never reached the worker'))]);
  const cancelled=await f.node.app.inject({method:'POST',url:`/api/images/${id}/cancel`,headers:f.headers,payload:{}});assert.equal(cancelled.statusCode,200,cancelled.body);
  await running;
 }finally{held.release();await running;}
 await f.settle();const {detail,material}=imageMaterial(f.node,id);
 assert.equal(detail.jobs.find(job=>job.name==='understanding')?.state,'cancelled');assert.equal(detail.products.some(product=>product.kind==='understanding'),false);
 assert.equal(detail.products.find(product=>product.kind==='ocr')?.text,image.ocr.segments[0].text);originalAnchor(f.node,material);
 assert.equal(f.calls().local,1);assert.equal(f.calls().configured,0);await readArchivedImage(f.node,id,image);
});

test('local availability cannot force archive-only or disabled understanding, or enable original-image queries',async t=>{
 const f=await fixture(t),photo=f.images.find(image=>image.id==='photo')!;
 const archived=await f.upload(photo,'archive');await f.settle();assert.deepEqual(f.calls(),{ocr:0,configured:0,local:0});
 assert.equal(f.node.files.detail(archived).job.stage,'archive');assert.equal(f.node.files.detail(archived).hasOriginal,true);assert.equal(imageMaterial(f.node,archived).detail.products.length,0);
 await f.node.perception.save({revision:f.node.configService.revision,settings:{...f.node.perception.settings(),understandingEnabled:false,allowQueryImages:false}});
 for(const enabled of [false,true]){
  f.setEnabled(enabled);const id=await f.upload(f.images.find(image=>image.id==='small-text')!);await f.settle();
  const {detail}=imageMaterial(f.node,id);assert.deepEqual(detail.products.map(product=>product.kind),['ocr']);
  assert.equal(f.node.perception.settings().understandingEnabled,false);assert.equal(f.node.perception.settings().allowQueryImages,false);
  await assert.rejects(f.node.featureServices.archiveReader.readImage!({id}),{code:'image_disclosure_disabled'});
 }
 assert.equal(f.calls().local,0);assert.equal(f.calls().configured,0);
});

test('a ready generated local service still obeys the existing background model authorization',async t=>{
 const f=await fixture(t,{authorize:false}),id=await f.upload(f.images[0]);await f.settle();
 assert.deepEqual(f.calls(),{ocr:0,configured:0,local:0});assert.equal(f.node.files.detail(id).hasOriginal,true);
 assert.equal(imageMaterial(f.node,id).detail.products.length,0);
 const view=await f.node.app.inject({url:'/api/model-authorization',headers:f.headers});assert.equal(view.json().authorization.state,'off');
});

test('the single worker contract rejects paths, metadata, tampered pixels, stale versions and ambiguous usage',async()=>{
 const image=(await generated)[0],id=randomUUID(),pixels=await imageOutput(image.bytes,image.mimeType,{id},()=>true);
 const request=localImageRequestSchema.parse({version:1,operationId:'image:'+id,captureId:id,image:pixels,ocr:image.ocr,context:{capturedAt:'2026-10-01T00:00:00Z',sourceType:'file'}});
 for(const change of [{version:2},{archivePath:'/generated/forbidden.png'},{image:{...pixels,data:'@@@='}},{image:{...pixels,data:Buffer.from('tampered').toString('base64')}},{image:{...pixels,imageView:{...pixels.imageView,transform:'metadata@1',output:undefined}}}])assert.equal(localImageRequestSchema.safeParse({...request,...change}).success,false);
 const {generatedLocalImageResponse}=await import('./fixtures/local-image.js'),response=generatedLocalImageResponse(request,image);
 assert.deepEqual(parseLocalImageResponse(JSON.parse(JSON.stringify(response)),request),response);
 assert.throws(()=>parseLocalImageResponse({...response,usage:{}},request),ImageInterpretationError);
 assert.deepEqual(parseLocalImageResponse({...response,usage:{outputTokens:12}},request).status,'ok');
 for(const state of ['ready','waiting','failed','stopped'])assert.equal(localImagePluginStateSchema.parse({enabled:true,state}).enabled,true,'unavailability is never interpreted as disabled');
});
