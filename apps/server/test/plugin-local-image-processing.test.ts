import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {PluginHost} from '@mote/plugin-host';
import type {PluginLifecycle} from '@mote/plugin-api/contracts';
import {ProviderFailure,unknownAttributionContext,type ImageReadResult,type MediaAssetStatus,type MediaModelStatus,type PluginBuildView} from '@mote/shared';
import {Store,StoreError,sha256} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {GitHubPluginReleases} from '../src/plugin-release.js';
import {createPluginControlPlatform,pluginControlDeclaration,type PluginCenter} from '../src/plugin-center.js';
import {registerPluginControlHttp} from '../src/plugins/plugin-control-http.js';
import {createLocalImageProcessing,LOCAL_IMAGE_PROCESSING_INSTANCE,localImageProcessingSelection,localImageProcessingDeclaration,localImageProcessingService} from '../src/plugins/local-image-processing.js';
import {localImagePluginStateSchema,LOCAL_IMAGE_PROTOCOL,LOCAL_IMAGE_ERRORS,localImageRequestSchema,parseLocalImageResponse} from '../src/local-image-contract.js';
import {imageOutput} from '../src/evidence-image.js';
import {requestLocalJson} from '../src/local-http.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {ModelAgentFactory} from '../src/model-agent.js';
import {generatedLocalImages,startLocalImageFixtureWorker} from './fixtures/local-image.js';
import {authorizeFixtureModels} from './fixtures/model-authorization.js';

const generated=generatedLocalImages();
const command=(expectedRevision:number)=>({operationId:randomUUID(),expectedRevision});
function gate(){
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),waiting=new Promise<void>(resolve=>release=resolve);
  return {started,release,async wait(){entered();await waiting;}};
}
type Gate=ReturnType<typeof gate>;

/** Real private Store, PluginCenter control/HTTP and PluginHost installation.
 * Only CORE-01/02's not-yet-integrated model/process boundary is controlled.
 * The worker executes IMG-00's actual serialized HTTP protocol on an OS port;
 * it does not load models or contact an existing Central. */
async function fixture(t:TestContext,options:{installed?:boolean;prepareFailure?:boolean;stopFailure?:boolean}={}){
  const directory=await mkdtemp(join(tmpdir(),'mote-plugin-local-image-')),images=await generated;
  const weights=join(directory,'models','local-image','generated-weights.bin'),weightBytes=Buffer.from('Generated weight placeholder; never real model data.');
  const counts={created:0,prepared:0,started:0,stopped:0,disposed:0,live:0,maxLive:0,resources:0};
  let assetState:MediaAssetStatus['state']='not_installed',prepareFailure=options.prepareFailure??false;
  let stopGate:Gate|undefined,prepareGate:Gate|undefined,statusGate:Gate|undefined;
  const allGates:Gate[]=[],workers:ControlledWorker[]=[],cleanups:(()=>unknown|Promise<unknown>)[]=[];
  type FixtureWorker=Awaited<ReturnType<typeof startLocalImageFixtureWorker>>;
  type ControlledWorker={transport?:FixtureWorker;alive:boolean;close():Promise<void>};
  const install=async()=>{await mkdir(join(directory,'models','local-image'),{recursive:true});await writeFile(weights,weightBytes);assetState='ready';};
  if(options.installed)await install();
  let runtime:Awaited<ReturnType<typeof open>>|undefined;
  const status=async():Promise<MediaModelStatus>=>{
    const held=statusGate;statusGate=undefined;if(held)await held.wait();
    return {role:'local-image',state:assetState,version:'generated-weights-v1',bytes:assetState==='ready'?weightBytes.length:0,totalBytes:weightBytes.length,source:'generated',runtimeReady:workers.some(worker=>worker.alive)};
  };
  const createWorker=(signal:AbortSignal):PluginLifecycle=>{
    counts.created++;
    let closing:Promise<void>|undefined,prepared=false,disposed=false;
    const owned:ControlledWorker={alive:false,close:()=>closing??=(async()=>{
      // Publish loss of readiness before disconnecting the accepted HTTP call;
      // retain the physical count until shutdown joins the actual server.
      const live=owned.alive;owned.alive=false;
      if(owned.transport)await owned.transport.close();
      if(live)counts.live--;
    })()};workers.push(owned);
    return {
      async prepare(){
        counts.prepared++;counts.resources++;prepared=true;
        const held=prepareGate;prepareGate=undefined;
        if(held)await held.wait();signal.throwIfAborted();
        assert.deepEqual(await readFile(weights),weightBytes);
        if(prepareFailure)throw Error('Generated preparation failure with no model invocation');
      },
      async start(){
        signal.throwIfAborted();owned.transport=await startLocalImageFixtureWorker(images);
        owned.alive=true;counts.started++;counts.live++;counts.maxLive=Math.max(counts.maxLive,counts.live);
      },
      quiesce(){},
      async stop(){
        counts.stopped++;const held=stopGate;stopGate=undefined;if(held)await held.wait();
        await owned.close();if(options.stopFailure)throw Error('Generated unproven termination');
      },
      async dispose(){if(disposed)return;disposed=true;counts.disposed++;await owned.close();if(prepared)counts.resources--;},
    };
  };
  async function open(){
    const store=new Store(join(directory,'control')),executor=new ExecutionEngine(store),host=new PluginHost({kind:'central',id:randomUUID()});
    let plugins:PluginCenter|undefined;
    const local=createLocalImageProcessing({desired:()=>plugins?.control.build(LOCAL_IMAGE_PROCESSING_INSTANCE)?.desired,modelStatus:status,createWorker});
    const control=createPluginControlPlatform({store,executor,host,releases:new GitHubPluginReleases(join(directory,'packages'))},[local.build]);
    const handle=await host.install({identity:{host:host.identity,packageId:'mote.plugin-control',installationId:'generated-control-build',instanceId:'control',activationId:randomUUID()},contributions:[pluginControlDeclaration],factory:control.factory});
    plugins=control.assembly;await control.startBuilds();
    const app=Fastify();
    app.setErrorHandler((error,_req,reply)=>reply.code(error instanceof StoreError?error.statusCode:500).send({error:error.message}));
    registerPluginControlHttp(app,{plugins,bindings:{} as never,automation:{} as never,owner:req=>{
      if(req.headers.authorization!=='Bearer generated-owner')throw new StoreError('Owner authorization required',401);
    }});
    await app.ready();
    let closed=false;
    return {store,executor,host,plugins,local,app,async close(){
      if(closed)return;closed=true;
      try{await app.close();await handle.close('shutdown');}
      finally{try{await host.close();}finally{await executor.close();store.close();}}
    }};
  }
  runtime=await open();
  t.after(async()=>{
    for(const held of allGates)held.release();
    try{while(cleanups.length)await cleanups.pop()!();await runtime?.close();}
    finally{await Promise.all(workers.map(worker=>worker.close()));await rm(directory,{recursive:true,force:true});}
  });
  const desired=()=>runtime!.plugins.control.build(LOCAL_IMAGE_PROCESSING_INSTANCE);
  const request=async(enabled:boolean,input={...command(desired()?.revision??runtime!.plugins.revision()),selection:enabled?localImageProcessingSelection:null})=>{
    const response=await runtime!.app.inject({method:'PATCH',url:'/api/plugin-builds/'+LOCAL_IMAGE_PROCESSING_INSTANCE,headers:{authorization:'Bearer generated-owner'},payload:input});
    assert.equal(response.statusCode,200,response.body);return {body:response.json() as PluginBuildView,input};
  };
  const send=async(signal:AbortSignal,image=images[1],pixels?:ImageReadResult,captureId=randomUUID(),operationId='image:'+randomUUID())=>{
    const transport=workers.at(-1)?.transport;assert.ok(transport);
    const request=localImageRequestSchema.parse({version:LOCAL_IMAGE_PROTOCOL.version,captureId,operationId,image:pixels??await imageOutput(image.bytes,image.mimeType,{id:captureId},()=>true),ocr:image.ocr,
      context:{capturedAt:'2026-10-01T00:00:00Z',sourceType:'file',document:{contentRole:'reference',timeBasis:'unknown'},attributionContext:unknownAttributionContext()}});
    const bytes=Buffer.from(JSON.stringify(request));
    const raw=await requestLocalJson(transport.url,{method:LOCAL_IMAGE_PROTOCOL.method,headers:{Authorization:`Bearer ${transport.token}`,'Content-Type':'application/json','Content-Length':String(bytes.length)},body:(async function*(){yield bytes;})(),signal,limit:LOCAL_IMAGE_PROTOCOL.maxResponseBytes,requireOfflineExecution:true});
    const response=parseLocalImageResponse(raw,request);
    if(response.status==='error'){const failure=LOCAL_IMAGE_ERRORS[response.error.code];throw new ProviderFailure({category:failure.category,code:failure.hostCode,retryAfterMs:response.error.retryAfterMs});}
    return response;
  };
  return {directory,images,counts,weights,weightBytes,install,send,request,desired,defer:(cleanup:()=>unknown|Promise<unknown>)=>{cleanups.push(cleanup);},get runtime(){return runtime!;},get worker(){return workers.at(-1)!;},
    setAssetState(value:MediaAssetStatus['state']){assetState=value;},setPrepareFailure(value:boolean){prepareFailure=value;},
    holdStop(){const held=gate();allGates.push(held);stopGate=held;return held;},holdPrepare(){const held=gate();allGates.push(held);prepareGate=held;return held;},
    holdStatus(){const held=gate();allGates.push(held);statusGate=held;return held;},
    async restart(){await runtime!.close();assert.equal(counts.live,0);runtime=await open();},
  };
}
const localFailure=(code:string)=>(error:unknown)=>error instanceof ProviderFailure&&error.details.category==='blocked'&&error.details.code===code;
const call=(f:Awaited<ReturnType<typeof fixture>>)=>f.runtime.local.port.run(signal=>f.send(signal),new AbortController().signal);

test('a bundled registration stays off; owner enable/disable and response replay keep one worker and retain model bytes',async t=>{
  const f=await fixture(t,{installed:true});
  assert.equal(f.runtime.local.selection(),undefined);assert.deepEqual(f.runtime.local.port.state(),{enabled:false,state:'stopped'});assert.equal(f.counts.created,0);
  assert.equal((await f.runtime.app.inject({url:'/api/plugin-builds'})).statusCode,401);
  assert.equal((await f.runtime.app.inject({url:'/api/plugin-builds',headers:{authorization:'Bearer generated-owner'}})).body,'[]');
  const first=await f.request(true),lease=await f.runtime.host.acquire(localImageProcessingService,{service:localImageProcessingService,provider:{scope:first.body.active!.identity as never,contributionId:'local-image-processing'},revision:0});
  const enabledState=localImagePluginStateSchema.parse(JSON.parse(JSON.stringify(lease.value.state())));assert.deepEqual(enabledState,{enabled:true,state:'ready'});
  const response=await lease.value.run(signal=>f.send(signal),new AbortController().signal);
  assert.equal(response.model.id,'InternVL3-14B-4bit');assert.equal(response.result.text,f.images[1].interpretation.text);
  await f.request(true,first.input);assert.equal(f.counts.created,1,'replayed control acknowledgement does not repeat prepare');
  await f.request(true);assert.equal(f.counts.created,1,'a fresh repeated enable adopts the running worker');
  assert.equal(f.runtime.host.snapshot().contributions.filter(entry=>entry.identity.scope.instanceId===LOCAL_IMAGE_PROCESSING_INSTANCE).length,1);
  await lease.release();
  const stopped=await f.request(false);await f.request(false,stopped.input);await f.request(false);
  const disabledState=localImagePluginStateSchema.parse(JSON.parse(JSON.stringify(f.runtime.local.port.state())));
  assert.equal(f.runtime.local.selection(),undefined);assert.equal(f.counts.live,0);assert.equal(f.counts.stopped,1);assert.equal(f.counts.disposed,1);assert.equal(f.counts.resources,0);
  assert.deepEqual(await readFile(f.weights),f.weightBytes);
  await f.request(true);assert.equal(f.counts.started,2);assert.equal(f.counts.maxLive,1);
  t.diagnostic('IMG02_INTERFACE '+JSON.stringify({enabledBuild:first.body,enabledState,disabledBuild:stopped.body,disabledState,response}));
});

test('desired enablement survives missing or damaged weights and discovers installation without turning failure into configured-model selection',async t=>{
  const f=await fixture(t),enabled=await f.request(true);
  assert.ok(enabled.body.desired);assert.ok(f.runtime.local.selection());
  const missing=localImagePluginStateSchema.parse(JSON.parse(JSON.stringify(f.runtime.local.port.state())));
  assert.deepEqual(missing,{enabled:true,state:'waiting',reason:'model_missing'});
  await assert.rejects(call(f),localFailure('model_missing'));assert.equal(f.counts.created,0);
  await f.restart();assert.ok(f.runtime.local.selection());assert.equal(f.runtime.local.port.state().reason,'model_missing');assert.equal(f.counts.created,0);
  await f.install();await f.runtime.local.port.refresh();assert.equal(f.runtime.local.port.state().state,'ready');assert.equal(f.counts.started,1);
  await call(f);f.setAssetState('failed');await assert.rejects(call(f),localFailure('model_missing'));
  const damaged=localImagePluginStateSchema.parse(JSON.parse(JSON.stringify(f.runtime.local.port.state())));
  assert.deepEqual(damaged,{enabled:true,state:'failed',reason:'model_failed'});assert.equal(f.counts.live,0);
  f.setAssetState('ready');await f.runtime.local.port.refresh();assert.equal(f.counts.started,2);assert.equal(f.counts.maxLive,1);
  t.diagnostic('IMG02_AVAILABILITY '+JSON.stringify({enabledBuild:enabled.body,missing,damaged,recovered:f.runtime.local.port.state()}));
});

test('worker preparation failure disposes partial resources, retains local intent and retries only on explicit refresh',async t=>{
  const f=await fixture(t,{installed:true,prepareFailure:true});await f.request(true);
  assert.deepEqual(f.runtime.local.port.state(),{enabled:true,state:'failed',reason:'worker_unavailable'});
  assert.ok(f.runtime.local.selection());assert.ok(f.desired()!.desired);assert.equal(f.counts.resources,0);assert.equal(f.counts.disposed,1);assert.equal(f.counts.live,0);
  await assert.rejects(call(f),localFailure('image_worker_unavailable'));assert.equal(f.counts.created,1);
  f.setPrepareFailure(false);await f.runtime.local.port.refresh();await call(f);
  assert.equal(f.counts.created,2);assert.equal(f.counts.live,1);assert.equal(f.counts.maxLive,1);
});

test('re-enable during stop waits for physical cleanup, cancels accepted calls and rejects a late successful response',async t=>{
  const f=await fixture(t,{installed:true});await f.request(true);
  const held=f.worker.transport!.holdNext();t.after(()=>held.release());
  const pending=call(f),rejected=assert.rejects(pending);await held.started;
  const stopped=f.holdStop(),disabling=f.request(false);await stopped.started;
  // selectBuild commits synchronously before its first lifecycle await. Hold
  // that exact committed state instead of racing Fastify's request dispatch.
  const enabling=f.runtime.plugins.selectBuild(LOCAL_IMAGE_PROCESSING_INSTANCE,{...command(f.desired()!.revision),selection:localImageProcessingSelection});await rejected;
  assert.equal(f.runtime.local.port.state().enabled,true,'the newly committed intent is distinct from the still-stopping worker');
  assert.equal(f.counts.started,1);assert.equal(f.counts.live,1);
  await assert.rejects(call(f),localFailure('image_worker_unavailable'));
  held.release();stopped.release();await disabling;await enabling;
  assert.equal(f.runtime.local.port.state().state,'ready');assert.equal(f.counts.started,2);assert.equal(f.counts.maxLive,1);
  await call(f);
});

test('host shutdown cancels accepted HTTP work before worker disposal',async t=>{
  const f=await fixture(t,{installed:true});await f.request(true);
  const held=f.worker.transport!.holdNext();t.after(()=>held.release());const accepted=call(f);await held.started;
  const closing=f.runtime.host.close();
  // Host shutdown is cancellation, so it must never publish the held response.
  await assert.rejects(accepted);held.release();await closing;
  assert.equal(f.counts.live,0);assert.equal(f.counts.resources,0);assert.equal(f.counts.stopped,1);
});

test('a task ignoring cancellation drains before worker disposal and its late value is rejected',async t=>{
  const f=await fixture(t,{installed:true});await f.request(true);
  const held=gate();f.defer(()=>held.release());let aborted!:()=>void;const revoked=new Promise<void>(resolve=>aborted=resolve);
  const pending=f.runtime.local.port.run(async signal=>{
    signal.addEventListener('abort',aborted,{once:true});await held.wait();return 'Generated late success';
  },new AbortController().signal),rejected=assert.rejects(pending);
  await held.started;const disabling=f.runtime.plugins.selectBuild(LOCAL_IMAGE_PROCESSING_INSTANCE,{...command(f.desired()!.revision),selection:null});await revoked;
  assert.equal(f.counts.live,1);assert.equal(f.counts.disposed,0);
  held.release();await rejected;await disabling;
  assert.equal(f.counts.live,0);assert.equal(f.counts.disposed,1);assert.equal(f.runtime.local.selection(),undefined);
});

test('graceful replacement withdraws admission and drains accepted HTTP work before releasing the worker',async t=>{
  const f=await fixture(t,{installed:true}),{control}=f.runtime.plugins;
  // Seed the same real control record, then retain the actual PluginHandle for
  // the host's graceful restart API (the public disable route cancels instead).
  const installationId=randomUUID(),input=command(control.revision());
  control.command('generated-graceful-selection',input,()=>control.revision(),()=>control.saveBuild({id:LOCAL_IMAGE_PROCESSING_INSTANCE,packageId:localImageProcessingSelection.packageId,installationId,revision:1,desired:localImageProcessingSelection,retired:false,observed:'active',blockers:[],operationId:input.operationId}));
  const handle=await f.runtime.host.install({identity:{host:f.runtime.host.identity,packageId:localImageProcessingSelection.packageId,installationId,instanceId:LOCAL_IMAGE_PROCESSING_INSTANCE,activationId:randomUUID()},contributions:[localImageProcessingDeclaration],factory:f.runtime.local.factory});
  const held=f.worker.transport!.holdNext();t.after(()=>held.release());const accepted=call(f);await held.started;
  await handle.quiesce('upgrade');await assert.rejects(call(f),localFailure('image_worker_unavailable'));
  let closed=false;const closing=handle.close('upgrade').then(()=>{closed=true;});
  assert.equal(f.counts.live,1);assert.equal(f.counts.stopped,0);assert.equal(closed,false);
  held.release();assert.equal((await accepted).status,'ok');await closing;
  assert.equal(f.counts.live,0);assert.equal(f.counts.stopped,1);assert.equal(f.counts.disposed,1);
});

test('shutdown during preparation disposes the partial activation and cannot launch a late worker',async t=>{
  const f=await fixture(t,{installed:true}),held=f.holdPrepare(),enabling=f.request(true);
  await held.started;const closing=f.runtime.host.close();held.release();await enabling;await closing;
  assert.equal(f.counts.started,0);assert.equal(f.counts.resources,0);assert.equal(f.counts.disposed,1);
  assert.equal(f.runtime.local.port.state().enabled,true);assert.notEqual(f.runtime.local.port.state().state,'ready');
});

test('a stopped Central restores the durable choice exactly once, and a dead worker stays locally unavailable until explicit recovery',async t=>{
  const f=await fixture(t,{installed:true});await f.request(true);const installation=f.desired()!.installationId;
  await f.restart();assert.equal(f.desired()!.installationId,installation);assert.equal(f.counts.started,2);assert.equal(f.counts.maxLive,1);
  await f.worker.close();await assert.rejects(call(f),localFailure('image_worker_unavailable'));
  assert.deepEqual(f.runtime.local.port.state(),{enabled:true,state:'failed',reason:'worker_unavailable'});assert.ok(f.runtime.local.selection());
  await assert.rejects(call(f),localFailure('image_worker_unavailable'));assert.equal(f.counts.started,2);
  await f.runtime.local.port.refresh();await call(f);assert.equal(f.counts.started,3);assert.equal(f.counts.maxLive,1);
  await f.request(false);await f.restart();assert.equal(f.runtime.local.selection(),undefined);assert.equal(f.counts.started,3);
  assert.deepEqual(await readFile(f.weights),f.weightBytes);
});

test('unproven worker termination blocks replacement instead of creating a second worker',async t=>{
  const f=await fixture(t,{installed:true,stopFailure:true});await f.request(true);
  assert.equal((await f.request(false)).body.observed,'blocked');
  const next=await f.request(true);assert.equal(next.body.observed,'blocked');assert.equal(f.counts.created,1);assert.equal(f.counts.maxLive,1);
  assert.equal(f.runtime.local.port.state().enabled,true);assert.equal(f.runtime.local.port.state().reason,'worker_stop_failed');
});

test('cancelling one caller during health inspection keeps the healthy shared worker available',async t=>{
  const f=await fixture(t,{installed:true});await f.request(true);
  const held=f.holdStatus(),controller=new AbortController(),pending=f.runtime.local.port.run(signal=>f.send(signal),controller.signal),rejected=assert.rejects(pending);
  await held.started;controller.abort(new Error('Generated caller cancellation'));held.release();await rejected;
  assert.deepEqual(f.runtime.local.port.state(),{enabled:true,state:'ready'});assert.equal(f.counts.live,1);assert.equal(f.counts.disposed,0);
  await call(f);assert.equal(f.counts.created,1);
});

test('a worker crash during an accepted HTTP call reports local unavailability without starting a replacement',async t=>{
  const f=await fixture(t,{installed:true});await f.request(true);
  const held=f.worker.transport!.holdNext();f.defer(()=>held.release());const pending=call(f),rejected=assert.rejects(pending,localFailure('image_worker_unavailable'));
  await held.started;await f.worker.close();held.release();await rejected;
  assert.deepEqual(f.runtime.local.port.state(),{enabled:true,state:'failed',reason:'worker_unavailable'});assert.ok(f.runtime.local.selection());assert.equal(f.counts.created,1);
  await f.runtime.local.port.refresh();await call(f);assert.equal(f.counts.created,2);assert.equal(f.counts.maxLive,1);
});

/** The test supplies the future IMG-03 inference adapter at the existing model
 * boundary. Real image ingress, authorization, OCR, publication and consumers
 * remain production code. This is not a claim that CORE-03's default wiring or
 * IMG-03's production intake adapter is already installed on this baseline. */
async function intake(t:TestContext,options:{installed?:boolean;authorize?:boolean}={}){
  const f=await fixture(t,options);let node:Awaited<ReturnType<typeof buildApp>>|undefined,configuredCalls=0,ocrCalls=0,localCalls=0;
  const factory:ModelAgentFactory=async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
    const direct=input.directImages![0],image=f.images.find(image=>sha256(image.bytes)===direct.hash)!;
    const pixels=await reader.readImage!({id:direct.id}),local=f.runtime.local.selection();let result=image.interpretation;
    if(local){const response=await local.run(signal=>{localCalls++;return f.send(signal,image,pixels,direct.id,input.traceContext!.operationId);},input.signal!);result=response.result;}
    else configuredCalls++;
    return {answer:JSON.stringify(result),citations:[],trace:[],runId:randomUUID()};
  }});
  const config:Config={dataDir:join(f.directory,'central'),token:'generated-intake-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-configured-image',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'https://generated.example.invalid/v1',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent'};
  node=await buildApp(config,{backgroundWorker:false,createModelAgent:factory});const central=node;
  f.defer(()=>central.app.close());
  const models=central.modelSettings.view();await central.modelSettings.updateDefaults({revision:models.revision,defaults:models.defaults,defaultModels:{file:'generated-configured-image',memory:'generated-memory-model',chat:'generated-chat-model'}});
  await central.processing.saveImageDefault({endpoint:'http://127.0.0.1:1/ocr'});
  central.processing.runtime.registry.get('image.http').process=async input=>{
    ocrCalls++;const parts:Buffer[]=[];for await(const part of input.readOriginal())parts.push(part);
    const image=f.images.find(image=>sha256(image.bytes)===sha256(Buffer.concat(parts)))!;assert.ok(image);return structuredClone(image.ocr);
  };
  const sourceId='generated-local-image-plugin';central.sources.register({id:sourceId,name:'Generated image plugin input',kind:'upload',deviceId:'generated-device',platform:'import',retention:'archive'});
  if(options.authorize!==false)await authorizeFixtureModels(central);
  return {...f,get worker(){return f.worker;},get runtime(){return f.runtime;},node:central,calls:()=>({configured:configuredCalls,local:localCalls,ocr:ocrCalls}),async upload(image=f.images[1]){
    const headers={authorization:'Bearer '+config.token};
    const begun=await central.app.inject({method:'POST',url:'/api/file-sync/v1/uploads',headers,payload:{sourceId,item:{externalId:randomUUID()+'.png',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'file',layer:'original',mimeType:image.mimeType,title:'Generated plugin image',text:'',document:{contentRole:'reference',timeBasis:'unknown'}},sha256:sha256(image.bytes),sizeBytes:image.bytes.length}});
    assert.equal(begun.statusCode,200,begun.body);const upload=begun.json();if(upload.ack)return String(upload.ack.id);
    const part=await central.app.inject({method:'PUT',url:`/api/file-sync/v1/uploads/${upload.uploadId}/parts/0`,headers:{...headers,'content-type':'application/octet-stream'},payload:image.bytes});assert.equal(part.statusCode,200,part.body);
    const committed=await central.app.inject({method:'POST',url:`/api/file-sync/v1/uploads/${upload.uploadId}/commit`,headers,payload:{}});assert.equal(committed.statusCode,200,committed.body);return String(committed.json().id);
  },async settle(){await central.perception.tick();for(let i=0;i<30;i++)if(await central.materialOrganizer.tick(100)===0)return;assert.fail('Generated Material publication did not settle');}};
}

test('local enable, unavailability and disable preserve archive/OCR/products and all Memory, Ask, ASR and image settings',async t=>{
  const f=await intake(t,{installed:true}),models=f.node.modelSettings.view(),settings=f.node.perception.settings(),processing=f.node.processing.currentSettings(),authorization=f.node.modelAuthorization.view();
  const prior=await f.upload();await f.settle();assert.equal(f.calls().configured,1);
  const priorProducts=f.node.perception.detail(prior).products;await f.request(true);
  const local=await f.upload();await f.settle();assert.equal(f.calls().local,1);assert.equal(f.calls().configured,1);
  const localProducts=f.node.perception.detail(local).products;assert.ok(localProducts.some(product=>product.kind==='understanding'));
  await f.worker.close();const failed=await f.upload();await f.settle();
  assert.equal(f.node.perception.detail(failed).jobs.find(job=>job.name==='understanding')?.error,'image_worker_unavailable');
  assert.equal(f.calls().configured,1,'failed local availability never falls back to the configured model');
  assert.ok(f.node.perception.detail(failed).products.some(product=>product.kind==='ocr'));assert.equal(f.node.files.detail(failed).hasOriginal,true);
  await f.request(false);const configured=await f.upload();await f.settle();assert.equal(f.calls().configured,2);
  assert.ok(f.node.perception.detail(configured).products.some(product=>product.kind==='understanding'));
  assert.deepEqual(f.node.perception.detail(prior).products,priorProducts);assert.deepEqual(f.node.perception.detail(local).products,localProducts);
  for(const id of [prior,local,failed,configured]){
    assert.equal(f.node.files.detail(id).hasOriginal,true);assert.equal(f.node.files.detail(id).sha256,sha256(f.images[1].bytes));
    assert.equal(f.node.perception.detail(id).products.find(product=>product.kind==='ocr')?.text,f.images[1].ocr.segments.map(segment=>segment.text).join('\n'));
  }
  assert.deepEqual(f.node.modelSettings.view(),models);assert.deepEqual(f.node.perception.settings(),settings);assert.deepEqual(f.node.processing.currentSettings(),processing);assert.deepEqual(f.node.modelAuthorization.view(),authorization);
  assert.equal(f.node.modelSettings.select('memory').settings.model,'generated-memory-model');assert.equal(f.node.modelSettings.select('chat').settings.model,'generated-chat-model');
  assert.equal(f.node.memories.list().length,0);
  assert.equal(f.calls().ocr,1,'the existing same-original OCR cache is reused across all four uploads and plugin toggles');
});

test('disabling in-flight local intake rejects its late interpretation and leaves original/OCR available for the next configured-model upload',async t=>{
  const f=await intake(t,{installed:true});await f.request(true);
  const held=f.worker.transport!.holdNext();f.defer(()=>held.release());const id=await f.upload(),running=f.node.perception.tick();
  await held.started;await f.request(false);await running;held.release();await f.settle();
  const detail=f.node.perception.detail(id);
  assert.equal(detail.products.some(product=>product.kind==='understanding'),false);assert.ok(detail.products.some(product=>product.kind==='ocr'));
  assert.notEqual(detail.jobs.find(job=>job.name==='understanding')?.state,'succeeded');assert.equal(f.node.files.detail(id).hasOriginal,true);
  assert.equal(f.calls().configured,0);assert.equal(f.counts.live,0);
  const next=await f.upload();await f.settle();assert.equal(f.calls().configured,1);assert.ok(f.node.perception.detail(next).products.some(product=>product.kind==='understanding'));
  assert.equal(f.node.perception.detail(id).products.some(product=>product.kind==='understanding'),false,'new uploads do not automatically rerun the interrupted original');
});

test('missing weights keep new intake locally blocked; an enabled ready plugin cannot open background authorization or original-image access',async t=>{
  const f=await intake(t,{authorize:false});await f.request(true);const id=await f.upload();await f.settle();
  assert.deepEqual(f.calls(),{configured:0,local:0,ocr:0});assert.equal(f.node.modelAuthorization.view().state,'off');
  assert.equal(f.node.perception.settings().allowQueryImages,false);assert.equal(f.node.files.detail(id).hasOriginal,true);
  await assert.rejects(f.node.featureServices.archiveReader.readImage!({id}),{code:'image_disclosure_disabled'});
  await authorizeFixtureModels(f.node);const missing=await f.upload();await f.settle();
  assert.equal(f.node.perception.detail(missing).jobs.find(job=>job.name==='understanding')?.error,'model_missing');
  assert.equal(f.calls().configured,0);assert.equal(f.calls().local,0);assert.equal(f.calls().ocr,1);
  await f.install();await f.runtime.local.port.refresh();const ready=await f.upload();await f.settle();assert.equal(f.calls().local,1);
  assert.equal(f.node.perception.settings().allowQueryImages,false);assert.equal(f.node.files.detail(ready).hasOriginal,true);
});
