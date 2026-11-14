import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import Fastify from 'fastify';
import {mediaAssetStatusSchema,mediaModelsViewSchema,mediaRoleSchema,type MediaRole} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {MEDIA_CATALOG,MediaAssets} from '../src/media-assets.js';
import {mediaModelsFeature} from '../src/features/media.js';
import {FUNASR_PROTOCOL} from '../src/funasr-contract.js';

/** Only model bytes and worker health are generated. Central startup, asset
 * verification/publication, auth, SQLite, loopback HTTP and schemas are real. */
test('actual authenticated model HTTP separates downloading, complete files and worker health, and does not create analysis work',async t=>{
 const native=JSON.parse(execFileSync('python3',[fileURLToPath(new URL('../../../scripts/test_mote_asr_contract.py',import.meta.url)),'--emit'],{encoding:'utf8',timeout:30_000,maxBuffer:4*1024*1024}));
 const readyHealth={version:1,protocol:FUNASR_PROTOCOL,execution:'local',ocr:true,asr:true,diarization:true,identity:native.request.identity,missingDependencies:[]};
 const directory=await mkdtemp(join(tmpdir(),'mote-models-http-')),bundle=join(directory,'bundle'),prior={...MEDIA_CATALOG};
 const data=Buffer.from('Generated HTTP model asset bytes'),hash=createHash('sha256').update(data).digest('hex');
 for(const role of mediaRoleSchema.options)MEDIA_CATALOG[role]={version:'generated-http-'+role,files:[{name:'component/model.bin',size:data.length,sha256:hash,official:'https://fixture.invalid/'+role}]};
 await mkdir(join(bundle,'component'),{recursive:true});await writeFile(join(bundle,'component/model.bin'),data);
 let health:Record<string,unknown>={protocol:FUNASR_PROTOCOL,execution:'local',asr:false,diarization:false,missingDependencies:['funasr','torch','torchaudio']},healthCalls=0,hold=true;
 const healthBytes:string[]=[];
 const worker=createServer((req,res)=>{
  if(req.url==='/model'){
   const offset=Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1]??0);
   res.writeHead(offset?206:200,{'content-length':data.length-offset,...(offset?{'content-range':`bytes ${offset}-${data.length-1}/${data.length}`}:{})});
   if(hold)res.write(data.subarray(offset,offset+4));else res.end(data.subarray(offset));return;
  }
  assert.equal(req.headers.authorization,'Bearer generated-model-worker');healthCalls++;
  const body=JSON.stringify(health);healthBytes.push(body);res.writeHead(200,{'content-type':'application/json'});res.end(body);
 });
 worker.listen(0,'127.0.0.1');await once(worker,'listening');const workerPort=(worker.address() as {port:number}).port;
 const config:Config={dataDir:join(directory,'archive'),token:'generated-models-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'https://example.invalid',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',diagnosticsEnabled:false,configuration:{runtime:'docker'},
  media:{modelDirectory:join(directory,'models'),workerToken:'generated-model-worker',ocrEndpoint:`http://127.0.0.1:${workerPort}/ocr`,asrEndpoint:`http://127.0.0.1:${workerPort}/transcribe`,ocrPort:workerPort,asrPort:workerPort,python:'python3'}};
 const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async()=>({configured:false,close:async()=>{},query:async()=>{throw Error('Installing assets must not invoke a model');}})});
 t.after(async()=>{await node.app.close();worker.closeAllConnections();await new Promise<void>(resolve=>worker.close(()=>resolve()));Object.assign(MEDIA_CATALOG,prior);await rm(directory,{recursive:true,force:true});});
 const url=await node.app.listen({host:'127.0.0.1',port:0}),headers={authorization:'Bearer '+config.token},originalFetch=fetch;
 t.mock.method(globalThis,'fetch',(input:Parameters<typeof fetch>[0],init?:RequestInit)=>String(input).startsWith('https://fixture.invalid/')?originalFetch(`http://127.0.0.1:${workerPort}/model`,init):originalFetch(input,init));
 const view=async()=>{const response=await fetch(url+'/api/media-models',{headers});assert.equal(response.status,200);const bytes=await response.text();assert.equal(bytes.includes(directory),false);return mediaModelsViewSchema.parse(JSON.parse(bytes));};
 const post=async(path:string,auth=headers)=>fetch(url+path,{method:'POST',headers:{...auth,'content-type':'application/json'},body:'{}'});
 const before=node.modelAuthorization.view(),perception=node.perception.settings(),steps=()=>node.store.db.prepare('SELECT COUNT(*) AS count FROM execution_steps').get()!.count;
 const initialSteps=steps();
 assert.equal((await fetch(url+'/api/media-models')).status,401);assert.equal((await post('/api/media-models/local-image/install',{} as typeof headers)).status,401);
 const invitation=node.connections.invite({serverUrl:'https://fixture.invalid',label:'Generated collector'},'collector');
 const collector=await node.connections.redeem({code:invitation.invitation.code,deviceId:'generated-models-collector',deviceName:'Generated',platform:'android'});
 assert.equal((await post('/api/media-models/local-image/install',{authorization:'Bearer '+collector.token})).status,403);
 assert.equal((await post('/api/media-models/local-image/cancel',{authorization:'Bearer '+collector.token})).status,403);
 const initial=await view();assert.deepEqual(Object.keys(initial).sort(),[...mediaRoleSchema.options].sort());assert.equal(initial['local-image']!.state,'not_installed');assert.equal(healthCalls,0);
 const started=await post('/api/media-models/local-image/install');assert.equal(started.status,202);assert.equal(mediaAssetStatusSchema.parse(await started.json()).state,'downloading');
 for(let index=0;node.featureServices.mediaAssets.status('local-image').bytes!==4;index++){assert.ok(index<100);await new Promise(resolve=>setTimeout(resolve,10));}
 const downloading=await view();assert.equal(downloading['local-image']!.state,'downloading');assert.equal(downloading['local-image']!.runtimeReady,false);
 assert.equal((await post('/api/media-models/local-image/install')).status,409);
 const cancelled=await post('/api/media-models/local-image/cancel');assert.equal(cancelled.status,200);assert.equal(mediaAssetStatusSchema.parse(await cancelled.json()).state,'cancelled');
 hold=false;await node.featureServices.mediaAssets.installAsync('local-image');
 for(const role of ['ocr','dialogue','speaker-wespeaker'] as const)await node.featureServices.mediaAssets.importBundle(role,bundle);
 const installed=await view();assert.equal(installed.dialogue!.state,'ready');assert.equal(installed.dialogue!.runtimeReady,false);
 assert.ok(healthCalls>0,'the declared sidecar runtime must reach actual authenticated worker health');
 assert.deepEqual(installed.dialogue!.missingDependencies,JSON.parse(healthBytes.at(-1)!).missingDependencies,'the actual worker JSON supplies current dependency names');
 assert.equal(installed.dialogue!.missingDependencies!.includes('faster_whisper'),false);
 assert.equal(installed['local-image']!.state,'ready');assert.equal(installed['local-image']!.runtimeReady,false,'asset installation cannot fabricate an image process');
 health={...readyHealth,wespeaker:true};
 const running=await view();for(const role of ['ocr','dialogue'] as const)assert.equal(running[role]!.runtimeReady,true);
 assert.equal(running['speaker-wespeaker']!.state,'ready');assert.equal(running['speaker-wespeaker']!.runtimeReady,false,'installed retired speaker assets cannot claim a worker even when an endpoint advertises wespeaker');
 assert.equal((await post('/api/media-preparation/speaker-wespeaker')).status,409,'the retired worker cannot be started');
 health={...readyHealth,asr:'true'};assert.equal((await view()).dialogue!.runtimeReady,false,'truthy non-boolean fields cannot claim worker health');
 health={...readyHealth,identity:undefined};assert.equal((await view()).dialogue!.runtimeReady,false,'a current protocol without loaded native identity cannot claim worker health');
 health={...readyHealth,missingDependencies:['funasr']};assert.equal((await view()).dialogue!.runtimeReady,false,'missing execution code prevents readiness');
 health={version:2,execution:'local',asr:true,diarization:true,missingDependencies:['faster_whisper','sherpa_onnx']};
 const oldWorker=await view();assert.equal(oldWorker.dialogue!.runtimeReady,false);assert.deepEqual(oldWorker.dialogue!.missingDependencies,[],'an old worker cannot label the new ASR as missing old dependencies');
 await rm(join(node.featureServices.mediaAssets.path('dialogue'),'component/model.bin'));health=readyHealth;
 const missing=await view();assert.equal(missing.dialogue!.state,'not_installed');assert.equal(missing.dialogue!.runtimeReady,false,'a healthy endpoint cannot hide a required missing weight');
 assert.equal((await post('/api/media-models/unlisted/install')).status,400);
 assert.equal(steps(),initialSteps);assert.deepEqual(node.modelAuthorization.view(),before);assert.deepEqual(node.perception.settings(),perception);
});

test('an actual loopback image health producer can supply the asset feature seam without enabling a plugin or starting a worker',async t=>{
 const root=await mkdtemp(join(tmpdir(),'mote-image-model-health-')),prior=MEDIA_CATALOG['local-image'],data=Buffer.from('Generated image weights');
 MEDIA_CATALOG['local-image']={version:'generated-image-health',files:[{name:'model.bin',size:data.length,sha256:createHash('sha256').update(data).digest('hex'),official:'https://fixture.invalid/model'}]};
 const bundle=join(root,'bundle');await mkdir(bundle);await writeFile(join(bundle,'model.bin'),data);const assets=new MediaAssets(join(root,'models'));
 const health=Fastify(),app=Fastify();let ready=false;
 health.get('/health',async()=>({runtimeReady:ready,missingDependencies:ready?[]:['mlx_vlm']}));
 const healthUrl=await health.listen({host:'127.0.0.1',port:0});
 mediaModelsFeature({mediaAssets:assets,runtimeStatus:async(role:MediaRole)=>role==='local-image'?await(await fetch(healthUrl+'/health')).json() as {runtimeReady:boolean;missingDependencies:string[]}:{runtimeReady:false}}).mount(app,{} as never);
 t.after(async()=>{await app.close();await health.close();await assets.close();MEDIA_CATALOG['local-image']=prior;await rm(root,{recursive:true,force:true});});
 await assets.importBundle('local-image',bundle);
 const status=async()=>mediaModelsViewSchema.parse(JSON.parse((await app.inject('/api/media-models')).body))['local-image']!;
 assert.deepEqual((await status()).missingDependencies,['mlx_vlm']);assert.equal((await status()).runtimeReady,false);
 ready=true;assert.equal((await status()).runtimeReady,true);
 await rm(join(assets.path('local-image'),'model.bin'));assert.equal((await status()).runtimeReady,false);
});
