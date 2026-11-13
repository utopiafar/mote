import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {PluginHost} from '@mote/plugin-host';
import {ProviderFailure,type Transcript,type UsageReceipt} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {ModelAgentFactory} from '../src/model-agent.js';
import {Store,sha256} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {MEDIA_CATALOG} from '../src/media-assets.js';
import {LOCAL_IMAGE_MODEL,LOCAL_IMAGE_PROTOCOL,localImageRequestSchema,parseLocalImageResponse,type LocalImageRequest,type LocalImageSuccess} from '../src/local-image-contract.js';
import {LOCAL_IMAGE_ADAPTER} from '../src/local-image-understanding.js';
import {createLocalImageProcessing,LOCAL_IMAGE_PROCESSING_INSTANCE,localImageProcessingSelection} from '../src/plugins/local-image-processing.js';
import {createImageProcessingService,imageProcessingServiceForAssembly} from '../src/plugins/image-processing-service.js';
import {createPluginControlPlatform,pluginControlDeclaration,type PluginCenter} from '../src/plugin-center.js';
import {GitHubPluginReleases} from '../src/plugin-release.js';
import {PluginControlStore} from '../src/plugins/plugin-control-store.js';
import {authorizeFixtureModels,withFixtureOwnerModelWork} from './fixtures/model-authorization.js';

const scripts=fileURLToPath(new URL('../../../scripts/',import.meta.url));
const token='generated-img03-worker-token-at-least-32-characters',revision='generated-img03-weights';
const producer=`import sys,json
import mote_vlm as v
data=json.load(sys.stdin)
r=v.parse_request(v.serialize(data['request'],v.MAX_REQUEST_BYTES))
if data['fault'] in v.ERROR_CODES:
 result=v.failure(r,data['fault'])
else:
 image,geometry=v.prepare_pixels(r)
 image.close()
 result={**v.correlation(r),'status':'ok','execution':'local','result':v.interpretation(json.dumps({'text':'Generated visual observation, with uncertain author and purpose.','regions':[{'x':.125,'y':.25,'width':.5,'height':.25,'description':'Generated inspected region'}]}),geometry),'model':{'id':v.MODEL_ID,'quantization':'4bit','revision':data['revision'],'engine':'mlx','engineVersion':'generated-python-engine','promptVersion':v.PROMPT_VERSION},'elapsedMs':17,'usage':{'outputTokens':23}}
 if data['fault']=='wrong-original': result['originalSha256']='0'*64
 if data['fault']=='wrong-view': result['imageViewId']='0'*64
 if data['fault']=='wrong-revision': result['model']['revision']='another-generated-revision'
 if data['fault']=='out-of-bounds': result['result']['regions'][0]['width']=r['image']['imageView']['original']['width']+1
sys.stdout.buffer.write(v.serialize(result))`;

function gate(){let enter!:()=>void,release!:()=>void;const started=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);return {started,enter,release,async wait(){enter();await held;}};}
async function listen(server:Server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
async function close(server:Server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
type Node=Awaited<ReturnType<typeof buildApp>>;
type Image={bytes:Buffer;mime:'image/png'|'image/jpeg';ocr:Transcript};

/** Real Central, intake HTTP, Store, plugin lifecycle and Material publication.
 * The two independent loopback model spies distinguish phase/operation. Local
 * HTTP uses IMG-01's actual Python serializer, decoder and coordinate adapter;
 * only model loading/generation and its managed process are generated. */
async function fixture(t:TestContext,options:{enabled?:boolean;authorize?:boolean;cloudConfigured?:boolean;timeoutMs?:number}={}){
 const directory=await mkdtemp(join(tmpdir(),'mote-img03-')),prior=MEDIA_CATALOG['local-image'];
 const weights=Buffer.from('Generated image model bytes, never real weights.');
 MEDIA_CATALOG['local-image']={version:'generated-img03',models:{image:{id:LOCAL_IMAGE_MODEL.id,repository:'generated',revision,license:'generated',directory:'.'}},files:[{name:'model.bin',size:weights.length,sha256:sha256(weights),official:'https://example.invalid/model.bin'}]};
 const images:Image[]=[],localCalls:LocalImageRequest[]=[],responses:LocalImageSuccess[]=[],cloudCalls:{operationId:string;phase:string;model:string}[]=[],errors:unknown[]=[],gates:ReturnType<typeof gate>[]=[];
 let fault='',localGate:ReturnType<typeof gate>|undefined,cloudGate:ReturnType<typeof gate>|undefined,ocrGate:ReturnType<typeof gate>|undefined,queuedGate:ReturnType<typeof gate>|undefined,statusGate:ReturnType<typeof gate>|undefined,failOcr=false,ocrCalls=0,runtimeReady=false;
 const localServer=createServer((req,res)=>{void(async()=>{
  assert.equal(req.headers.authorization,'Bearer '+token);
  if(req.url==='/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({version:1,execution:'local',ocr:true}));return;}
  assert.equal(req.url,LOCAL_IMAGE_PROTOCOL.path);
  const parts:Buffer[]=[];for await(const part of req)parts.push(Buffer.from(part));
  const request=localImageRequestSchema.parse(JSON.parse(Buffer.concat(parts).toString()));localCalls.push(request);
  const held=localGate;localGate=undefined;if(held)await held.wait();
  res.setHeader('X-Mote-Execution','local');res.setHeader('Content-Type','application/json');
  if(fault==='invalid-json'){res.end('{generated invalid JSON');return;}
  const output=spawnSync('python3',['-c',producer],{cwd:scripts,input:JSON.stringify({request,fault,revision}),encoding:'utf8',timeout:10000,maxBuffer:LOCAL_IMAGE_PROTOCOL.maxResponseBytes});
  assert.equal(output.status,0,output.stderr);const response=JSON.parse(output.stdout);
  if(response.status==='ok'&&!fault)responses.push(parseLocalImageResponse(response,request) as LocalImageSuccess);
  res.end(output.stdout);
 })().catch(error=>{errors.push(error);res.writeHead(500).end();});});
 const cloudServer=createServer((req,res)=>{void(async()=>{
  const parts:Buffer[]=[];for await(const part of req)parts.push(Buffer.from(part));const call=JSON.parse(Buffer.concat(parts).toString());cloudCalls.push(call);
  const held=cloudGate;cloudGate=undefined;if(held)await held.wait();
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({text:'Generated configured-model observation',regions:[]}));
 })().catch(error=>{errors.push(error);res.writeHead(500).end();});});
 const localUrl=await listen(localServer),cloudUrl=await listen(cloudServer);
 let node:Node|undefined,controlHandle:Awaited<ReturnType<PluginHost['install']>>|undefined,controlStore:Store|undefined,controlExecutor:ExecutionEngine|undefined;
 const host=new PluginHost({kind:'central',id:randomUUID()});
 t.after(async()=>{for(const held of gates)held.release();try{await controlHandle?.close('shutdown');await host.close();await controlExecutor?.close();controlStore?.close();await node?.app.close();}finally{await close(localServer);await close(cloudServer);MEDIA_CATALOG['local-image']=prior;await rm(directory,{recursive:true,force:true});}assert.deepEqual(errors,[]);});
 const factory:ModelAgentFactory=async(settings,reader,hooks)=>({configured:options.cloudConfigured!==false,close:async()=>{},query:async input=>{
  if(input.directImages?.length){const trace=input.onTrace;input.onTrace=event=>{trace?.(event);if(event.type==='model.queued')queuedGate?.enter();};}
  const run=async()=>{
   await hooks?.authorizeModelRequest?.();input.signal?.throwIfAborted();input.assertContextAuthority?.();
   if(input.directImages?.length)await reader.readImage!({id:input.directImages[0].id});
   const response=await fetch(cloudUrl+'/model',{method:'POST',headers:{'content-type':'application/json'},signal:input.signal,body:JSON.stringify({operationId:input.traceContext?.operationId??'generated-followup',phase:(input.taskContext as {fixturePhase?:string})?.fixturePhase??(input.directImages?.length?'image-understanding':'ask'),model:settings.model})});
   return {answer:JSON.stringify(await response.json()),citations:[],trace:[],runId:randomUUID()};
  };return hooks?.runModel?hooks.runModel(run,input.signal):run();
 }});
 const config:Config={dataDir:join(directory,'data'),token:'generated-img03-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:40_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:options.cloudConfigured===false?'':'generated-file-cloud',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:cloudUrl+'/v1',apiKey:'',allowUnauthenticatedLocal:true,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent',llmConcurrency:1,
  media:{modelDirectory:join(directory,'models'),python:'python3',workerToken:token,ocrEndpoint:localUrl+'/ocr',asrEndpoint:localUrl+'/transcribe',ocrPort:Number(new URL(localUrl).port),asrPort:Number(new URL(localUrl).port)}};
 node=await buildApp(config,{backgroundWorker:false,createModelAgent:factory});const central=node,headers={authorization:'Bearer '+config.token};
 if(options.cloudConfigured!==false){const view=central.modelSettings.view();await central.modelSettings.updateDefaults({revision:view.revision,defaults:view.defaults,defaultModels:{file:'generated-file-cloud',memory:'generated-memory-cloud',chat:'generated-chat-cloud'}});}
 await central.processing.saveImageDefault({endpoint:cloudUrl+'/ocr'});
 central.processing.runtime.registry.get('image.http').process=async input=>{
  ocrCalls++;const held=ocrGate;ocrGate=undefined;if(held)await held.wait();if(failOcr)throw new ProviderFailure({category:'permanent',code:'generated_ocr_failed'});
  const parts:Buffer[]=[];for await(const part of input.readOriginal())parts.push(part);const image=images.find(image=>sha256(image.bytes)===sha256(Buffer.concat(parts)));assert.ok(image);return structuredClone(image.ocr);
 };
 const snapshot=central.processing.configurationSnapshot();if(options.timeoutMs)snapshot.settings.timeoutMs=options.timeoutMs;
 await central.processing.save({revision:central.processing.view().revision,...snapshot});
 const bundle=join(directory,'bundle');await mkdir(bundle);await writeFile(join(bundle,'model.bin'),weights);await central.featureServices.mediaAssets.importBundle('local-image',bundle);
 let plugins:PluginCenter|undefined;
 const local=createLocalImageProcessing({desired:()=>plugins?.control.build(LOCAL_IMAGE_PROCESSING_INSTANCE)?.desired,modelStatus:async()=>{const held=statusGate;statusGate=undefined;if(held)await held.wait();return {...central.featureServices.mediaAssets.status('local-image'),runtimeReady};},createWorker:()=>({prepare(){},start(){runtimeReady=true;},quiesce(){},stop(){runtimeReady=false;},dispose(){}})});
 // CORE-03 owns the default control assembly. Compose the existing hosted
 // control in its own private profile here, and bind its real selection port.
 controlStore=new Store(join(directory,'control'));controlExecutor=new ExecutionEngine(controlStore);
 const control=createPluginControlPlatform({store:controlStore,executor:controlExecutor,host,releases:new GitHubPluginReleases(join(directory,'packages'))},[local.build]);
 controlHandle=await host.install({identity:{host:host.identity,packageId:'mote.plugin-control',installationId:'generated-img03-control',instanceId:'control',activationId:randomUUID()},contributions:[pluginControlDeclaration],factory:control.factory});
 plugins=control.assembly;await control.startBuilds();imageProcessingServiceForAssembly(central.processing).bindLocalImages({selection:local.selection,media:{localImageEndpoint:localUrl+LOCAL_IMAGE_PROTOCOL.path,workerToken:token},usage:central.observabilityAssembly.usage});
 const enable=async(enabled:boolean)=>{
  await plugins!.selectBuild(LOCAL_IMAGE_PROCESSING_INSTANCE,{selection:enabled?localImageProcessingSelection:null,operationId:randomUUID(),expectedRevision:plugins!.control.build(LOCAL_IMAGE_PROCESSING_INSTANCE)?.revision??plugins!.revision()});
  central.perception.configurationChanged();
 };
 if(options.enabled!==false)await enable(true);
 if(options.authorize!==false)await authorizeFixtureModels(central);
 for(const sourceId of ['generated-import','generated-sync','generated-parent'])central.sources.register({id:sourceId,name:sourceId,kind:sourceId==='generated-sync'?'local-files':'upload',deviceId:'generated-img03-device',platform:'import',retention:'archive'});
 const image=async(text=true,orientation=1):Promise<Image>=>{
  const base=sharp({create:{width:160,height:80,channels:3,background:images.length%2?'#aabbcc':'#bbccdd'}});
  const result:Image={bytes:orientation===1?await base.png().toBuffer():await base.withMetadata({orientation}).jpeg().toBuffer(),mime:orientation===1?'image/png':'image/jpeg',ocr:{durationMs:0,segments:text?[{startMs:0,endMs:0,text:'Generated searchable OCR text with independent evidence.'}]:[]}};images.push(result);return result;
 };
 const upload=async(value:Image,sourceId='generated-import',profile?:string,externalId=randomUUID(),previousRevision:string|null=null,rev='1')=>{
  const start=await central.app.inject({method:'POST',url:'/api/file-sync/v1/uploads',headers,payload:{sourceId,previousRevision,processingProfileId:profile,item:{externalId,revision:rev,observedAt:'2026-11-01T00:00:00Z',kind:'file',layer:'original',title:'Generated image',mimeType:value.mime,text:'',document:{contentRole:'reference',timeBasis:'unknown'}},sha256:sha256(value.bytes),sizeBytes:value.bytes.length}});
  assert.equal(start.statusCode,200,start.body);let ack=start.json().ack;
  if(!ack){const id=start.json().uploadId;assert.equal((await central.app.inject({method:'PUT',url:`/api/file-sync/v1/uploads/${id}/parts/0`,headers:{...headers,'content-type':'application/octet-stream'},payload:value.bytes})).statusCode,200);const finish=await central.app.inject({method:'POST',url:`/api/file-sync/v1/uploads/${id}/commit`,headers,payload:{}});assert.equal(finish.statusCode,200,finish.body);ack=finish.json();}
  assert.equal(ack.receipt.state,'received');return String(ack.id);
 };
 const screen=async(value:Image)=>{
  const id=randomUUID(),response=await central.app.inject({method:'POST',url:'/api/captures',headers,payload:{id,deviceId:'generated-img03-screen',deviceName:'Generated screen',platform:'android',source:'screen',capturedAt:'2026-11-01T00:00:00Z',durationMs:0,ocrText:'',ocr:{status:'disabled'},privacy:{excluded:false,redacted:false,mode:'local'},imageMime:value.mime,imageBase64:value.bytes.toString('base64')}});assert.equal(response.statusCode,201,response.body);return id;
 };
 const settle=async()=>{await central.perception.tick();for(let i=0;i<30;i++)if(await central.materialOrganizer.tick(100)===0)return;assert.fail('Material organizer did not settle');};
 const held=(kind:'local'|'cloud'|'ocr'|'queued'|'status')=>{const value=gate();gates.push(value);if(kind==='local')localGate=value;else if(kind==='cloud')cloudGate=value;else if(kind==='ocr')ocrGate=value;else if(kind==='queued')queuedGate=value;else statusGate=value;return value;};
 const product=(id:string,kind='understanding')=>{const row=central.store.db.prepare('SELECT json FROM image_products WHERE capture_id=? AND kind=? AND current=1').get(id,kind);return row?JSON.parse(String(row.json)):undefined;};
 const retry=async(id:string)=>withFixtureOwnerModelWork(central,async()=>central.perception.retry(id,false),{identities:['capture:'+id],connections:[...central.featureServices.availableModelConnections(),...central.perception.modelConnections()]});
 return {node:central,headers,directory,controlStore,local,plugins,enable,image,upload,screen,settle,held,product,retry,localCalls,cloudCalls,responses,ocrCalls:()=>ocrCalls,setFault:(value:string)=>{fault=value;},failOcr:()=>{failOcr=true;},intakeCloud:()=>cloudCalls.filter(call=>call.phase==='image-understanding'),usage:()=>central.store.db.prepare('SELECT json FROM model_usage').all().map(row=>JSON.parse(String(row.json)) as UsageReceipt)};
}

test('screenshots, import, sync and retained attachments call the selected local worker and publish current products with independent searchable OCR',async t=>{
 const f=await fixture(t),image=await f.image(),screen=await f.screen(image),imported=await f.upload(image),synced=await f.upload(image,'generated-sync');
 const attachment=f.node.archivedFiles.put({name:'generated.png',mimeType:image.mime,bytes:image.bytes});
 const parent=await f.node.sources.upsert('generated-parent',{externalId:'generated-caption',revision:'1',observedAt:'2026-11-01T00:00:00Z',kind:'message',layer:'original',title:'Generated caption',text:'Generated retained attachment',document:{contentRole:'reference',timeBasis:'unknown',attachments:[{id:attachment.id,mimeType:image.mime}]}});f.node.archivedFiles.attach(parent.id,[attachment.id]);
 await f.settle();const ids=f.node.store.db.prepare('SELECT capture_id FROM image_inputs').all().map(row=>String(row.capture_id));assert.equal(ids.length,4);assert.ok(ids.includes(screen)&&ids.includes(imported)&&ids.includes(synced));
 assert.equal(f.localCalls.length,4);assert.equal(f.intakeCloud().length,0);assert.ok(f.node.files.search({query:'searchable OCR'}).length>0);
 for(const id of ids){const product=f.product(id);assert.equal(product.input.captureId,id);assert.equal(product.input.hash,sha256(image.bytes));assert.equal(product.evidence.original.sha256,sha256(image.bytes));assert.deepEqual(product.payload.regions,[{x:20,y:20,width:80,height:20,description:'Generated inspected region'}]);assert.equal(product.model.provider,'local');assert.equal(product.model.model,LOCAL_IMAGE_MODEL.id);assert.equal(product.model.engineVersion,'generated-python-engine');assert.deepEqual(product.model.adapter,LOCAL_IMAGE_ADAPTER);assert.equal(product.model.elapsedMs,17);assert.deepEqual(product.model.usage,{outputTokens:23});assert.ok(f.product(id,'ocr'));}
 assert.equal(f.usage().filter(item=>item.operation==='image-understanding').length,4);assert.ok(f.usage().filter(item=>item.operation==='image-understanding').every(item=>item.provider==='local'&&item.tokens===undefined&&item.estimatedCost===null));
 assert.ok(f.node.materials.list({sourceId:'generated-import'}).items.some(item=>item.artifacts?.some(a=>a.key==='image-understanding'&&a.state==='ready')));
 if(process.env.MOTE_IMG03_EXAMPLE_PATH)await writeFile(process.env.MOTE_IMG03_EXAMPLE_PATH,JSON.stringify({request:f.localCalls[0],response:f.responses[0],product:f.product(imported),usage:f.usage().filter(item=>item.operation==='image-understanding')},null,2));
});

test('a ready local model needs no configured cloud image model and accepts wordless EXIF images and failed OCR independently',async t=>{
 const f=await fixture(t,{cloudConfigured:false}),wordless=await f.image(false,6),id=await f.upload(wordless);await f.settle();assert.equal(f.product(id,'ocr').payload.segments.length,0);assert.ok(f.product(id));assert.deepEqual(f.product(id).payload.regions,[{x:40,y:30,width:40,height:40,description:'Generated inspected region'}]);
 f.failOcr();const second=await f.upload(await f.image());await f.settle();assert.ok(f.product(second));assert.equal(f.product(second,'ocr'),undefined);assert.equal(f.localCalls.at(-1)!.ocr,undefined);assert.equal(f.intakeCloud().length,0);
});

test('source and batch model overrides remain saved while local intake takes precedence, then disable restores the selected configured model',async t=>{
 const f=await fixture(t),snapshot=f.node.processing.configurationSnapshot();
 for(const id of ['source-image','batch-image']){snapshot.policy.services.push({id,name:id,kind:'model',execution:'local',endpoint:'http://127.0.0.1:1234/v1',model:id});snapshot.policy.profiles.push({...snapshot.policy.profiles.find(p=>p.id==='central-image')!,id,name:id,modelServiceId:id});}
 snapshot.policy.rules.unshift({sourceId:'generated-sync',type:'image/*',profileId:'source-image'});await f.node.processing.save({revision:f.node.processing.view().revision,...snapshot});
 const before=f.node.processing.configurationSnapshot(),models=f.node.modelSettings.view(),perception=f.node.perception.settings(),authorization=f.node.modelAuthorization.view();
 await f.upload(await f.image(),'generated-sync');await f.upload(await f.image(),'generated-import','batch-image');await f.settle();assert.equal(f.localCalls.length,2);assert.equal(f.intakeCloud().length,0);
 await f.enable(false);assert.equal(new PluginControlStore(f.controlStore).build(LOCAL_IMAGE_PROCESSING_INSTANCE)!.desired,null);
 await f.upload(await f.image(),'generated-sync');await f.upload(await f.image(),'generated-import','batch-image');await f.settle();assert.deepEqual(f.intakeCloud().map(call=>call.model).sort(),['batch-image','source-image']);
 await f.enable(true);assert.deepEqual(new PluginControlStore(f.controlStore).build(LOCAL_IMAGE_PROCESSING_INSTANCE)!.desired,localImageProcessingSelection);assert.deepEqual(f.node.processing.configurationSnapshot(),before);assert.deepEqual(f.node.modelSettings.view(),models);assert.deepEqual(f.node.perception.settings(),perception);assert.deepEqual(f.node.modelAuthorization.view(),authorization);
});

for(const [fault,code] of [['model_missing','model_missing'],['worker_unavailable','image_worker_unavailable'],['busy','rate_limited'],['invalid_request','invalid_image_request'],['version_mismatch','image_protocol_version_mismatch'],['inference_failed','image_processing_failed'],['invalid-json','invalid_image_product'],['wrong-original','invalid_image_product'],['wrong-view','invalid_image_product'],['wrong-revision','invalid_image_product'],['out-of-bounds','invalid_image_region']] as const)test(`local ${fault} never calls intake cloud or discards searchable OCR`,async t=>{
 const f=await fixture(t);f.setFault(fault);const id=await f.upload(await f.image());await f.settle();assert.equal(f.product(id),undefined);assert.ok(f.product(id,'ocr'));assert.equal(f.node.perception.detail(id).jobs.find(j=>j.name==='understanding')!.error,code);assert.equal(f.intakeCloud().length,0);assert.ok(f.node.files.search({query:'searchable OCR'}).length>0);assert.equal(f.node.files.detail(id).hasOriginal,true);
 if(fault==='busy'||fault==='model_missing')assert.equal(f.node.perception.detail(id).jobs.find(j=>j.name==='understanding')!.attempts,0);
 if(fault==='invalid_request'||fault==='version_mismatch'){assert.equal(f.node.perception.detail(id).jobs.find(j=>j.name==='understanding')!.state,'failed');assert.equal(f.usage().filter(item=>item.operation==='image-understanding').length,0);}
 if(fault==='worker_unavailable'){const receipts=f.usage().filter(item=>item.operation==='image-understanding');assert.equal(receipts.length,1);assert.equal(receipts[0].status,'failed');}
 if(fault==='model_missing'){const before=f.ocrCalls();f.setFault('');await f.retry(id);await f.settle();assert.ok(f.product(id));assert.equal(f.ocrCalls(),before);}
});

test('local timeout retains OCR and cannot change the destination to cloud',async t=>{
 const f=await fixture(t,{timeoutMs:1000}),held=f.held('local'),id=await f.upload(await f.image()),running=f.node.perception.tick();await held.started;await running;held.release();assert.equal(f.node.perception.detail(id).jobs.find(j=>j.name==='understanding')!.error,'provider_timeout');assert.equal(f.product(id),undefined);assert.ok(f.product(id,'ocr'));assert.equal(f.intakeCloud().length,0);
});

test('missing installed weights retain the enabled selection and block before any model HTTP or usage receipt',async t=>{
 const f=await fixture(t);await rm(join(f.node.featureServices.mediaAssets.path('local-image'),'model.bin'));
 const id=await f.upload(await f.image());await f.settle();assert.deepEqual(f.local.port.state(),{enabled:true,state:'waiting',reason:'model_missing'});assert.equal(f.node.perception.detail(id).jobs.find(j=>j.name==='understanding')!.attempts,0);assert.equal(f.localCalls.length,0);assert.equal(f.intakeCloud().length,0);assert.equal(f.usage().filter(item=>item.operation==='image-understanding').length,0);assert.ok(f.product(id,'ocr'));
});

test('stopping background authorization during the local readiness wait prevents pixel upload and usage issuance',async t=>{
 const f=await fixture(t),held=f.held('status'),id=await f.upload(await f.image()),running=f.node.perception.tick();await held.started;
 const response=await f.node.app.inject({method:'POST',url:'/api/model-authorization/commands',headers:f.headers,payload:{revision:f.node.modelAuthorization.view().revision,operationId:randomUUID(),action:'stop'}});assert.equal(response.statusCode,200,response.body);
 held.release();await running;assert.equal(f.localCalls.length,0);assert.equal(f.intakeCloud().length,0);assert.equal(f.product(id),undefined);assert.equal(f.usage().filter(item=>item.operation==='image-understanding').length,0);
});

test('manual completion checks the actual local connection rather than inheriting a cloud connection grant',async t=>{
 const f=await fixture(t);f.setFault('model_missing');const id=await f.upload(await f.image());await f.settle();
 const off=await f.node.app.inject({method:'POST',url:'/api/model-authorization/commands',headers:f.headers,payload:{revision:f.node.modelAuthorization.view().revision,operationId:randomUUID(),action:'off'}});assert.equal(off.statusCode,200,off.body);f.setFault('');
 await withFixtureOwnerModelWork(f.node,async()=>f.node.perception.retry(id,false),{identities:['capture:'+id]});await f.settle();assert.equal(f.localCalls.length,1);assert.equal(f.product(id),undefined);assert.equal(f.node.perception.detail(id).jobs.find(j=>j.name==='understanding')!.error,'background_model_authorization_required');
 await f.retry(id);await f.settle();assert.equal(f.localCalls.length,2);assert.ok(f.product(id));assert.equal(f.intakeCloud().length,0);assert.equal(f.node.modelAuthorization.view().state,'off');
});

for(const mutation of ['cancel','delete','replace','source'] as const)test(`${mutation} while local HTTP is in flight cannot publish its late interpretation`,async t=>{
 const f=await fixture(t),image=await f.image(),externalId=randomUUID(),id=await f.upload(image,'generated-import',undefined,externalId),held=f.held('local'),running=f.node.perception.tick();await held.started;
 if(mutation==='cancel')f.node.perception.cancel(id);
 else if(mutation==='delete')f.node.files.forget(id);
 else if(mutation==='replace'){const version=f.node.files.version(id);await f.upload(await f.image(),'generated-import',undefined,externalId,String(version.revision),'2');}
 else {const response=await f.node.app.inject({method:'PATCH',url:'/api/sources/generated-import',headers:f.headers,payload:{ownerRelation:'third_party'}});assert.equal(response.statusCode,200,response.body);}
 held.release();await running;assert.equal(f.product(id),undefined);assert.equal(f.intakeCloud().length,0);
});

for(const initialLocal of [false,true])test(`switching ${initialLocal?'off':'on'} leaves unfinished admitted tasks fixed until an explicit retry`,async t=>{
 const f=await fixture(t,{enabled:initialLocal}),image=await f.image(),id=await f.upload(image),held=f.held('ocr'),running=f.node.perception.tick();await held.started;
 await f.enable(!initialLocal);held.release();await running;await f.settle();assert.equal(f.product(id),undefined);assert.equal(f.localCalls.length,0);assert.equal(f.intakeCloud().length,0);assert.equal(f.node.perception.detail(id).jobs.find(j=>j.name==='understanding')!.error,'input_changed');
 const ocr=f.ocrCalls();await f.retry(id);await f.settle();assert.ok(f.product(id));assert.equal(f.ocrCalls(),ocr);assert.equal(f.localCalls.length,initialLocal?0:1);assert.equal(f.intakeCloud().length,initialLocal?1:0);
});

test('archive-only, disabled understanding, authorization off and excluded sources cannot be overridden by the local plugin',async t=>{
 const f=await fixture(t,{authorize:false}),first=await f.upload(await f.image());await f.settle();assert.equal(f.localCalls.length,0);assert.equal(f.ocrCalls(),0);
 await authorizeFixtureModels(f.node,{excludedSourceIds:['generated-sync']});const excluded=await f.upload(await f.image(),'generated-sync'),archived=await f.upload(await f.image(),'generated-import','archive');await f.settle();assert.equal(f.localCalls.length,0);assert.equal(f.product(first),undefined);assert.equal(f.product(excluded),undefined);assert.equal(f.node.files.detail(archived).job.stage,'archive');
 await f.node.perception.save({revision:f.node.configService.revision,settings:{...f.node.perception.settings(),understandingEnabled:false,allowQueryImages:false}});const disabled=await f.upload(await f.image());await f.settle();assert.ok(f.product(disabled,'ocr'));assert.equal(f.product(disabled),undefined);assert.equal(f.localCalls.length,0);await assert.rejects(f.node.featureServices.archiveReader.readImage!({id:disabled}),{code:'image_disclosure_disabled'});
});

test('an issued cloud interpretation may finish its transport after enable but its stale result cannot become current',async t=>{
 const f=await fixture(t,{enabled:false}),held=f.held('cloud'),id=await f.upload(await f.image()),running=f.node.perception.tick();await held.started;assert.equal(f.intakeCloud().length,1);await f.enable(true);held.release();await running;await f.settle();assert.equal(f.product(id),undefined);assert.equal(f.localCalls.length,0);assert.equal(f.intakeCloud().length,1);await f.retry(id);await f.settle();assert.ok(f.product(id));assert.equal(f.localCalls.length,1);
});

test('enabling local intake cancels an old cloud image queued behind the model gate before its first send',async t=>{
 const f=await fixture(t,{enabled:false}),occupied=f.held('cloud'),queued=f.held('queued');
 const blocker=withFixtureOwnerModelWork(f.node,()=>f.node.agent.query({question:'Generated occupied model slot'}));await occupied.started;
 const id=await f.upload(await f.image()),running=f.node.perception.tick();await queued.started;assert.equal(f.intakeCloud().length,0);
 await f.enable(true);occupied.release();await blocker;await running;await f.settle();assert.equal(f.intakeCloud().length,0);assert.equal(f.localCalls.length,0);assert.equal(f.product(id),undefined);assert.equal(f.usage().filter(item=>item.operation==='image-understanding').length,0);
 await f.retry(id);await f.settle();assert.ok(f.product(id));assert.equal(f.localCalls.length,1);
});

test('selected cloud Memory and Ask model calls remain available and are counted by their own operation phases',async t=>{
 const f=await fixture(t),id=await f.upload(await f.image());await f.settle();
 for(const feature of ['memory','chat'] as const){const selected=f.node.modelSettings.select(feature);await withFixtureOwnerModelWork(f.node,()=>f.node.agent.query({question:'Generated follow-up model call',modelProfileId:selected.id,modelOverride:selected.settings.model,taskContext:{fixturePhase:feature==='chat'?'ask':'memory'} as never}));}
 assert.ok(f.product(id));assert.equal(f.intakeCloud().length,0);assert.equal(f.cloudCalls.find(call=>call.phase==='ask')!.model,'generated-chat-cloud');assert.equal(f.cloudCalls.find(call=>call.phase==='memory')!.model,'generated-memory-cloud');assert.equal(f.localCalls.length,1);
});

test('constructing another image service preserves an unrelated running model usage receipt',async t=>{
 const f=await fixture(t),meter=f.node.observabilityAssembly.usage.start('generated-other-module','generated-other-model','generated-running-call');
 const service=createImageProcessingService({store:f.node.store,processing:f.node.processing,executor:f.node.executor,modelSettings:f.node.modelSettings,
  resolveFileModel:()=>({settings:f.node.modelSettings.select('file').settings,identity:{kind:'profile',id:f.node.modelSettings.select('file').id}}),
  factory:async()=>{throw Error('Constructing a service must not invoke a model');},admittedUsage:()=>{throw Error('Constructing a service must not issue usage');}});
 try{assert.equal(f.usage().find(row=>row.model==='generated-other-model')!.status,'running');}
 finally{await service.close();meter.finish('completed');}
});
