import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {PluginHost} from '@mote/plugin-host';
import {ProviderFailure,unknownAttributionContext,type QueryResult} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {createModelAgent,type ModelAgentFactory} from '../src/model-agent.js';
import {Store,sha256} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {GitHubPluginReleases} from '../src/plugin-release.js';
import {createPluginControlPlatform,pluginControlDeclaration,type PluginCenter} from '../src/plugin-center.js';
import {createLocalImageProcessing,LOCAL_IMAGE_PROCESSING_INSTANCE,localImageProcessingSelection} from '../src/plugins/local-image-processing.js';
import {LOCAL_IMAGE_ERRORS,LOCAL_IMAGE_PROTOCOL,localImageRequestSchema,parseLocalImageResponse} from '../src/local-image-contract.js';
import {requestLocalJson} from '../src/local-http.js';
import {generatedLocalImages,startLocalImageFixtureWorker,type LocalImageFixture,type LocalImageWorkerFault} from './fixtures/local-image.js';
import {authorizeFixtureModels} from './fixtures/model-authorization.js';

type Body={model:string;messages:any[];tools:{function:{name:string}}[]};
type Reply={tool:string;args:unknown}|{answer:string;citationIds:string[]};
type Plan=(body:Body,step:number)=>Reply|Promise<Reply>;
const generated=generatedLocalImages(),sourceId='generated-image-query',askModel='generated-selected-cloud-ask';
const contentText=(content:any):string=>typeof content==='string'?content:Array.isArray(content)?content.filter(part=>part.type==='text').map(part=>part.text).join('\n'):'';
function toolResult(body:Body){
 const message=body.messages.filter(message=>message.role==='tool').at(-1);assert.ok(message,'the model receives the actual tool result');
 // Native image rendering can append an attachment label after the compact
 // Host JSON. Parse that actual first line, without treating a label as data.
 return JSON.parse(contentText(message.content).split('\n')[0]);
}
function pixelPayloads(body:Body):Buffer[]{
 const result:Buffer[]=[];
 const walk=(value:any)=>{
  if(typeof value==='string'&&/^data:image\/(png|jpeg|webp);base64,/.test(value))result.push(Buffer.from(value.slice(value.indexOf(',')+1),'base64'));
  else if(Array.isArray(value))value.forEach(walk);
  else if(value&&typeof value==='object')Object.values(value).forEach(walk);
 };walk(body.messages);return result;
}
function respond(response:ServerResponse,step:number,reply:Reply){
 response.writeHead(200,{'content-type':'text/event-stream'});
 const send=(value:unknown)=>response.write('data: '+JSON.stringify(value)+'\n\n');
 const tool='tool' in reply;
 send({id:'generated-ask-'+step,choices:[{index:0,delta:tool?{role:'assistant',tool_calls:[{index:0,id:'generated-call-'+step,type:'function',function:{name:reply.tool,arguments:JSON.stringify(reply.args)}}]}:{role:'assistant',content:JSON.stringify(reply)},finish_reason:null}]});
 send({id:'generated-ask-'+step,choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:80,completion_tokens:20,total_tokens:100}});
 response.end('data: [DONE]\n\n');
}

/** The actual Ask agent, its native image pack/adapter and HTTP sender execute.
 * Only OCR, inference and CORE's physical readiness boundary are generated.
 * #868 has no IMG-03 intake binding or CORE-03 default plugin registration;
 * the existing model-factory seam feeds serialized IMG-00 results through the
 * real ImageUnderstanding, products, organizer, Store and query routes. */
async function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-local-image-query-')),images=await generated;
 let node:Awaited<ReturnType<typeof buildApp>>|undefined,worker:Awaited<ReturnType<typeof startLocalImageFixtureWorker>>|undefined;
 let plan:Plan|undefined,requests:Body[]=[],fault:LocalImageWorkerFault|undefined;
 const errors:unknown[]=[],counts={local:0,configured:0};
 const endpoint=createServer((request,response)=>{void(async()=>{
  assert.equal(request.url,'/v1/chat/completions');
  assert.equal(request.headers.authorization,'Bearer generated-ask-fixture');
  const parts:Buffer[]=[];for await(const part of request)parts.push(Buffer.from(part));
  const body=JSON.parse(Buffer.concat(parts).toString()) as Body;
  assert.equal(body.model,askModel,'intake selection cannot replace the owner-selected Ask model');
  const step=requests.push(body)-1;assert.ok(plan,'every generated Ask call belongs to an explicit test plan');
  respond(response,step,await plan(body,step));
 })().catch(error=>{errors.push(error);if(!response.headersSent)response.writeHead(400,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'Generated provider assertion failed'}}));});});
 await new Promise<void>(resolve=>endpoint.listen(0,'127.0.0.1',resolve));
 const controlStore=new Store(join(directory,'plugin-control')),executor=new ExecutionEngine(controlStore),host=new PluginHost({kind:'central',id:randomUUID()});
 let plugins:PluginCenter|undefined;
 const local=createLocalImageProcessing({
  desired:()=>plugins?.control.build(LOCAL_IMAGE_PROCESSING_INSTANCE)?.desired,
  modelStatus:()=>({role:'local-image',state:'ready',version:'generated-image-assets',bytes:1,totalBytes:1,source:'generated',runtimeReady:Boolean(worker)}),
  createWorker:()=>({prepare(){},async start(){worker=await startLocalImageFixtureWorker(images);worker.setFault(fault);},quiesce(){},async stop(){const owned=worker;worker=undefined;await owned?.close();},dispose(){}}),
 });
 const control=createPluginControlPlatform({store:controlStore,executor,host,releases:new GitHubPluginReleases(join(directory,'packages'))},[local.build]);
 const handle=await host.install({identity:{host:host.identity,packageId:'mote.plugin-control',installationId:'generated-query-control',instanceId:'control',activationId:randomUUID()},contributions:[pluginControlDeclaration],factory:control.factory});
 plugins=control.assembly;await control.startBuilds();
 t.after(async()=>{
  try{await node?.app.close();await handle.close('shutdown');}
  finally{try{await host.close();await executor.close();controlStore.close();endpoint.closeAllConnections();await new Promise<void>(resolve=>endpoint.close(()=>resolve()));}
   finally{rmSync(directory,{recursive:true,force:true});}}
  assert.deepEqual(errors,[],'provider assertions must not be hidden by query failure handling');
 });
 const factory:ModelAgentFactory=async(settings,reader,hooks)=>{
  if(settings.model!== 'generated-configured-intake')return createModelAgent(settings,reader,undefined,hooks?.runModel,hooks?.authorizeModelRequest);
  return {configured:true,close:async()=>{},query:async input=>{
   assert.deepEqual(input.hostToolSelection,['read_image']);const direct=input.directImages![0],image=images.find(image=>sha256(image.bytes)===direct.hash)!;assert.ok(image);
   const pixels=await reader.readImage!({id:direct.id});assert.equal(pixels.data,image.bytes.toString('base64'));
   const selected=local.selection();let result=image.interpretation;
   if(selected){
    const response=await selected.run(async signal=>{
     assert.ok(worker);counts.local++;
     const record=node!.store.evidence([direct.id])[0],ocr=JSON.parse(String(node!.store.db.prepare("SELECT json FROM image_products WHERE capture_id=? AND kind='ocr' AND current=1").get(direct.id)!.json)).payload;
     const request=localImageRequestSchema.parse({version:LOCAL_IMAGE_PROTOCOL.version,operationId:input.traceContext!.operationId,captureId:direct.id,image:pixels,ocr,context:{capturedAt:record.capturedAt,sourceType:record.source,sourceId,sourceRevision:record.provenance?.revision,document:{contentRole:'reference',timeBasis:'unknown'},attributionContext:unknownAttributionContext()}});
     const bytes=Buffer.from(JSON.stringify(request)),raw=await requestLocalJson(worker.url,{method:LOCAL_IMAGE_PROTOCOL.method,headers:{Authorization:'Bearer '+worker.token,'Content-Type':'application/json','Content-Length':String(bytes.length)},body:(async function*(){yield bytes;})(),signal,limit:LOCAL_IMAGE_PROTOCOL.maxResponseBytes,requireOfflineExecution:true});
     return parseLocalImageResponse(raw,request);
    },input.signal!);
    if(response.status==='error'){const failure=LOCAL_IMAGE_ERRORS[response.error.code];throw new ProviderFailure({category:failure.category,code:failure.hostCode,retryAfterMs:response.error.retryAfterMs});}
    result=response.result;
   }else counts.configured++;
   return {answer:JSON.stringify(result),citations:[],trace:[],runId:randomUUID()};
  }};
 };
 const config:Config={dataDir:join(directory,'archive'),token:'generated-query-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:askModel,modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:`http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/v1`,apiKey:'generated-ask-fixture',modelMaxTokens:8192,allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',agentTimeoutMs:30000,diagnosticsEnabled:false,logLevel:'silent'};
 node=await buildApp(config,{backgroundWorker:false,createModelAgent:factory});const central=node,headers={authorization:'Bearer '+config.token};
 const modelView=central.modelSettings.view();await central.modelSettings.updateDefaults({revision:modelView.revision,defaults:modelView.defaults,defaultModels:{file:'generated-configured-intake',memory:'generated-selected-memory',chat:askModel}});
 await central.processing.saveImageDefault({endpoint:'http://127.0.0.1:9/generated-ocr'});
 central.processing.runtime.registry.get('image.http').process=async input=>{
  const parts:Buffer[]=[];for await(const part of input.readOriginal())parts.push(part);
  const image=images.find(image=>sha256(image.bytes)===sha256(Buffer.concat(parts)));assert.ok(image);return structuredClone(image.ocr);
 };
 await central.perception.save({revision:central.configService.revision,settings:{...central.perception.settings(),allowQueryImages:true}});
 await authorizeFixtureModels(central);
 central.sources.register({id:sourceId,name:'Generated Ask evidence',kind:'upload',deviceId:'generated-query-device',platform:'import',retention:'archive'});
 let serial=0;
 const settle=async()=>{await central.perception.tick();for(let i=0;i<30;i++)if(await central.materialOrganizer.tick(100)===0)return;assert.fail('Material organizer did not settle');};
 const query=async(question:string,next:Plan,extra:Record<string,unknown>={})=>{
  assert.deepEqual(errors,[]);plan=next;requests=[];
  const response=await central.app.inject({method:'POST',url:'/api/query',headers,payload:{question,...extra}});
  assert.deepEqual(errors,[]);return {response,requests:[...requests]};
 };
 return {node:central,headers,images,local,counts,
  setFault(value?:LocalImageWorkerFault){fault=value;worker?.setFault(value);},
  async enable(enabled:boolean){
   if(!enabled&&!plugins!.control.build(LOCAL_IMAGE_PROCESSING_INSTANCE)){assert.equal(local.selection(),undefined);return;}
   const receipt=await plugins!.selectBuild(LOCAL_IMAGE_PROCESSING_INSTANCE,{operationId:randomUUID(),expectedRevision:plugins!.control.build(LOCAL_IMAGE_PROCESSING_INSTANCE)?.revision??plugins!.revision(),selection:enabled?localImageProcessingSelection:null});
   assert.equal(Boolean(JSON.parse(JSON.stringify(receipt)).desired),enabled);assert.equal(local.port.state().enabled,enabled);
  },
  async upload(image:LocalImageFixture){
   const begun=await central.app.inject({method:'POST',url:'/api/file-sync/v1/uploads',headers,payload:{sourceId,item:{externalId:`${++serial}-${image.id}`,revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'file',layer:'original',mimeType:image.mimeType,title:'Generated handoff exhibit',text:'',document:{contentRole:'reference',timeBasis:'unknown'}},sha256:sha256(image.bytes),sizeBytes:image.bytes.length}});assert.equal(begun.statusCode,200,begun.body);
   const session=begun.json();let ack=session.ack;
   if(!ack){
    const part=await central.app.inject({method:'PUT',url:`/api/file-sync/v1/uploads/${session.uploadId}/parts/0`,headers:{...headers,'content-type':'application/octet-stream'},payload:image.bytes});assert.equal(part.statusCode,200,part.body);
    const committed=await central.app.inject({method:'POST',url:`/api/file-sync/v1/uploads/${session.uploadId}/commit`,headers,payload:{}});assert.equal(committed.statusCode,200,committed.body);ack=committed.json();
   }
   await settle();return String(ack.id);
  },settle,
  async ask(question:string,next:Plan,extra:Record<string,unknown>={}){
   const {response,requests}=await query(question,next,extra);assert.equal(response.statusCode,200,response.body);
   return {result:response.json() as QueryResult&{conversationId:string},requests};
  },
 };
}

test('local intake on and off preserve model-selected search, original pixels, crop lineage and Ask citations',async t=>{
 const f=await fixture(t),image=f.images.find(image=>image.id==='small-text')!,before=f.node.modelSettings.view();
 const runs:{enabled:boolean;result:QueryResult;tools:string[];originalId:string;originalHash:string;cropHash:string;product:unknown;modelRequests:Body[]}[]=[];
 for(const enabled of [true,false]){
  await f.enable(enabled);const captureId=await f.upload(image);
  const product=f.node.perception.detail(captureId).products.find(product=>product.kind==='understanding');assert.equal(product?.text,image.interpretation.text);
  let id='',hash='',region=image.interpretation.regions![0];
  const cropRegion={x:region.x,y:region.y,width:region.width,height:region.height};
  const {result,requests}=await f.ask('What supports the handoff decision?',(body,step)=>{
   if(step<4)assert.deepEqual(pixelPayloads(body),[],'text discovery and metadata never send pixels');
   if(step===0)return {tool:'search_context',args:{query:'rising blue line'}};
   if(step===1){const found=toolResult(body).data;assert.equal(found.length,1);id=found[0].id;assert.notEqual(id,captureId);return {tool:'evidence',args:{ids:[id]}};}
   if(step===2){const evidence=toolResult(body).data[0];assert.equal(JSON.parse(evidence.ocrText).imageInterpretation,image.interpretation.text);assert.equal(JSON.parse(evidence.ocrText).evidenceKind,'model_interpretation');assert.equal(evidence.provenance.layer,'derived');assert.equal(evidence.provenance.document.contentRole,'reference');return {tool:'read_image',args:{id,view:'metadata'}};}
   if(step===3){const meta=toolResult(body);hash=meta.imageView.original.sha256;assert.equal(hash,sha256(image.bytes));assert.equal(meta.imageView.original.width,image.width);assert.equal(meta.imageView.original.height,image.height);assert.equal(meta.imageView.output,undefined);return {tool:'read_image',args:{id,expectedImageSha256:hash}};}
   if(step===4){assert.deepEqual(pixelPayloads(body),[image.bytes]);return {tool:'read_image',args:{id,expectedImageSha256:hash,region:cropRegion}};}
   assert.equal(step,5);const cropped=toolResult(body);assert.ok(cropped.imageView,JSON.stringify(cropped));assert.deepEqual(cropped.imageView.region,cropRegion);return {answer:`The exhibit contains a rising blue line. [${id}]`,citationIds:[id]};
  });
  assert.equal(requests.length,6);const crop=pixelPayloads(requests[5]).at(-1);assert.ok(crop,'the next model request receives the crop bytes');
  assert.deepEqual(await sharp(crop).raw().toBuffer(),await sharp(image.bytes).extract({left:region.x,top:region.y,width:region.width,height:region.height}).toColourspace('srgb').raw().toBuffer());
  assert.equal(result.citations.length,1);assert.equal(result.citations[0].id,id);
  assert.deepEqual(result.trace.filter(row=>row.tool==='read_image').map(row=>row.imageView?.delivery),['metadata','prepared','prepared'],'tool traces describe preparation; HTTP payloads and final receipts separately prove delivery');
  const receipts=result.imageReadReceipts!;assert.equal(receipts.length,2);assert.ok(receipts.every(receipt=>receipt.id===id&&receipt.imageView.original.sha256===hash));assert.deepEqual(receipts[1].imageView.region,cropRegion);
  const citation=(await f.node.app.inject({url:'/api/captures/'+id,headers:f.headers}));assert.equal(citation.statusCode,200,citation.body);assert.equal(citation.json().id,id);assert.ok(citation.json().provenance.uri.endsWith('#image:understanding'));
  await f.enable(!enabled);
  const followup=await f.ask('Check that same detail once more.',(body,step)=>step===0?{tool:'search_context',args:{query:'rising blue line'}}:step===1?{tool:'evidence',args:{ids:[id]}}:step===2?{tool:'read_image',args:{id,expectedImageSha256:hash,region:cropRegion}}:{answer:`The same exhibit remains available. [${id}]`,citationIds:[id]},{conversationId:result.conversationId});
  assert.equal(followup.result.citations[0].id,id,'toggling the intake plugin does not rewrite the existing image citation');assert.equal(pixelPayloads(followup.requests.at(-1)!).length,1,'a new turn sends its pixels again');
  const tools=requests[0].tools.map(tool=>tool.function.name).sort();assert.ok(tools.includes('read_image'));assert.ok(tools.includes('search_context'));
  runs.push({enabled,result,tools,originalId:captureId,originalHash:hash,cropHash:sha256(crop),product:JSON.parse(String(f.node.store.db.prepare("SELECT json FROM image_products WHERE capture_id=? AND kind='understanding' AND current=1").get(captureId)!.json)),modelRequests:[requests[0],requests[4],requests[5]]});
  assert.deepEqual(f.node.modelSettings.view(),before);
  // Retire the first generated source before the next arm, so discovery cannot
  // accidentally pass by finding the previous arm's still-readable result.
  if(enabled)f.node.store.delete(captureId);
 }
 assert.deepEqual(f.counts,{local:1,configured:1});assert.deepEqual(runs[0].tools,runs[1].tools);
 assert.equal(runs[0].originalHash,runs[1].originalHash);assert.equal(runs[0].cropHash,runs[1].cropHash);
 assert.equal(f.node.modelSettings.select('chat').settings.model,askModel);assert.equal(f.node.modelSettings.select('memory').settings.model,'generated-selected-memory');
 if(process.env.MOTE_IMG06_EXAMPLE_PATH)writeFileSync(process.env.MOTE_IMG06_EXAMPLE_PATH,JSON.stringify({kind:'generated-fixture',runs},null,2)+'\n');
});

test('image source lists, raw-match search and timeline use the same interpretation or metadata card',async t=>{
 const f=await fixture(t),image=f.images.find(image=>image.id==='empty-ocr')!;
 for(const understandingEnabled of [true,false]){
  await f.node.perception.save({revision:f.node.configService.revision,settings:{...f.node.perception.settings(),understandingEnabled}});
  const id=await f.upload(image),reader=f.node.featureServices.archiveReader;
  const source=(await reader.sourceItems!({sourceId}) as {items:any[]}).items;
  const search=await reader.search({query:'Generated handoff exhibit'}),timeline=await reader.timeline({source:'file'});
  for(const rows of [source,search,Array.isArray(timeline)?timeline:timeline.items]){
   const card=rows.find(row=>row.provenance?.externalId===f.node.store.evidence([id])[0].provenance!.externalId);assert.ok(card);
   assert.notEqual(card.id,id,'formal image navigation suppresses the raw file card');
   assert.equal(card.provenance.uri.split('#')[1],understandingEnabled?'image:understanding':'source-metadata');
   assert.doesNotMatch(card.ocrText,/originalImage/,'a locator never replaces the visible item body');
   if(understandingEnabled)assert.equal(JSON.parse(card.ocrText).imageInterpretation,image.interpretation.text);
   else assert.equal(JSON.parse(card.ocrText).captureId,id);
  }
  f.node.store.delete(id);
 }
});

test('Ask combines text and attached pixels, retains attachments on follow-up and respects archive allowQueryImages in both intake modes',async t=>{
 const f=await fixture(t),image=f.images.find(image=>image.id==='small-text')!,id=await f.upload(image);
 await f.node.sources.upsert(sourceId,{externalId:'handoff-note',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',title:'Generated handoff schedule',text:'The handoff gate opens at 16:00.',document:{contentRole:'authored',timeBasis:'unknown'}});await f.settle();
 let noteId='';
 const first=await f.ask('Compare the exhibit with the handoff schedule.',(body,step)=>{
  if(step===0){assert.deepEqual(pixelPayloads(body),[]);return {tool:'search_context',args:{query:'handoff gate'}};}
  if(step===1){const found=toolResult(body).data;assert.equal(found.length,1);noteId=found[0].id;return {tool:'evidence',args:{ids:[noteId]}};}
  if(step===2){assert.ok(toolResult(body).data[0].ocrText.includes('16:00'));assert.deepEqual(pixelPayloads(body),[]);return {tool:'read_image',args:{id}};}
  assert.equal(step,3);assert.deepEqual(pixelPayloads(body),[image.bytes]);return {answer:`The gate opens at 16:00. [${noteId}] The exhibit contains a blue line. [${id}]`,citationIds:[noteId,id]};
 },{attachmentIds:[id]});
 assert.deepEqual(first.result.citations.map(citation=>citation.id),[noteId,id]);
 const followup=await f.ask('Inspect the supplied exhibit again.',(body,step)=>{
  if(step===0){assert.deepEqual(pixelPayloads(body),[]);return {tool:'read_image',args:{id}};}
  assert.equal(step,1);assert.deepEqual(pixelPayloads(body),[image.bytes]);return {answer:`The same exhibit remains readable. [${id}]`,citationIds:[id]};
 },{conversationId:first.result.conversationId});
 assert.equal(followup.result.citations[0].id,id);assert.equal(followup.result.imageReadReceipts!.length,1);
 for(const enabled of [false,true]){
  await f.enable(enabled);
  await f.node.perception.save({revision:f.node.configService.revision,settings:{...f.node.perception.settings(),allowQueryImages:false}});
  await assert.rejects(f.node.featureServices.archiveReader.readImage!({id}),{code:'image_disclosure_disabled',recovery:'stop'});
  let archiveId='';
  const blocked=await f.ask('Inspect the archived exhibit.',(body,step)=>{
   assert.equal(body.tools.some(tool=>tool.function.name==='read_image'),false,'the existing archive image setting removes on-demand read_image');
   if(step===0)return {tool:'search_context',args:{query:'rising blue line'}};
   if(step===1){archiveId=toolResult(body).data[0].id;assert.notEqual(archiveId,id);return {tool:'evidence',args:{ids:[archiveId]}};}
   assert.equal(step,2);assert.equal(JSON.parse(toolResult(body).data[0].ocrText).evidenceKind,'model_interpretation');
   return {answer:`The stored interpretation mentions a blue line; original-image access is off. [${archiveId}]`,citationIds:[archiveId]};
  });
  assert.equal(blocked.requests.length,3);assert.ok(blocked.requests.every(body=>pixelPayloads(body).length===0));assert.equal(blocked.result.imageReadReceipts?.length??0,0);assert.equal(blocked.result.citations[0].id,archiveId,'the setting adds no separate gate on interpretation text');
  await f.node.perception.save({revision:f.node.configService.revision,settings:{...f.node.perception.settings(),allowQueryImages:true}});
  const restored=await f.ask('Inspect the archived exhibit.',(body,step)=>{
   assert.ok(body.tools.some(tool=>tool.function.name==='read_image'));
   if(step===0)return {tool:'search_context',args:{query:'rising blue line'}};
   if(step===1)return {tool:'evidence',args:{ids:[archiveId]}};
   if(step===2)return {tool:'read_image',args:{id:archiveId}};
   assert.equal(step,3);return {answer:`The original exhibit is available. [${archiveId}]`,citationIds:[archiveId]};
  });
  assert.deepEqual(pixelPayloads(restored.requests.at(-1)!),[image.bytes]);
 }
});

test('failed local interpretation still permits the selected Ask model to inspect a directly attached original',async t=>{
 const f=await fixture(t),image=f.images.find(image=>image.id==='empty-ocr')!;await f.enable(true);f.setFault('inference_failed');
 const id=await f.upload(image),detail=f.node.perception.detail(id);
 assert.equal(detail.products.some(product=>product.kind==='understanding'),false);assert.equal(detail.jobs.find(job=>job.name==='understanding')?.error,'image_processing_failed');
 const {result,requests}=await f.ask('Describe the supplied exhibit.',(body,step)=>{
  if(step===0){assert.deepEqual(pixelPayloads(body),[]);return {tool:'read_image',args:{id}};}
  assert.equal(step,1);assert.deepEqual(pixelPayloads(body),[image.bytes]);return {answer:`A golden sphere appears above an oval shadow. [${id}]`,citationIds:[id]};
 },{attachmentIds:[id]});
 assert.equal(requests.length,2);assert.equal(result.citations[0].id,id);assert.equal(result.imageReadReceipts![0].imageView.original.sha256,sha256(image.bytes));assert.equal(f.counts.configured,0);
});
