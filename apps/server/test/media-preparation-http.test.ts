import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,utimes,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {MEDIA_CATALOG,MediaAssets} from '../src/media-assets.js';
import {authorizeFixtureModels} from './fixtures/model-authorization.js';

async function installGeneratedOcr(t:TestContext,directory:string,modelDirectory:string){
 const prior=MEDIA_CATALOG.ocr,bundle=join(directory,'bundle'),tree=join(directory,'tree'),files=[];
 t.after(()=>{MEDIA_CATALOG.ocr=prior;});
 await mkdir(bundle);
 for(const kind of ['det','rec']){
  const folder=`generated-${kind}`;await mkdir(join(tree,folder),{recursive:true});
  for(const name of ['inference.onnx','inference.yml'])await writeFile(join(tree,folder,name),`Generated OCR ${kind} ${name}`);
  execFileSync('tar',['-cf',join(bundle,kind+'.tar'),'-C',tree,folder]);const bytes=await readFile(join(bundle,kind+'.tar'));
  files.push({name:kind+'.tar',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),official:'https://fixture.invalid/'+kind+'.tar',extract:{kind:'tar' as const,entry:folder+'/inference.onnx',destination:kind+'/inference.onnx'}});
 }
 MEDIA_CATALOG.ocr={version:'generated-ocr-http',files};
 // The installer produces the receipt consumed by a fresh Central instance.
 // Only the model bytes and unavailable recognizer boundary are generated.
 const assets=new MediaAssets(modelDirectory);
 try{await assets.importBundle('ocr',bundle);assert.equal(assets.ready('ocr'),true);}
 finally{await assets.close();}
}

test('preparation HTTP requires owner authority and cannot turn installation into automatic processing consent',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-prepare-http-'));
 const config:Config={dataDir:directory,token:'generated-media-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelBaseUrl:'https://fixture.invalid',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async()=>({configured:false,close:async()=>{},query:async()=>{throw Error('No model call expected');}})});
 t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+config.token},before=node.modelAuthorization.view(),initialPerception=node.perception.settings();
 assert.equal((await node.app.inject({url:'/api/media-preparation'})).statusCode,401);
 const invitation=node.connections.invite({serverUrl:'https://fixture.invalid',label:'Generated collector'},'collector');
 const collector=await node.connections.redeem({code:invitation.invitation.code,deviceId:'generated-collector',deviceName:'Generated collector',platform:'android'}),collectorHeaders={authorization:'Bearer '+collector.token};
 for(const [method,url] of [['GET','/api/media-preparation'],['POST','/api/media-preparation/ocr'],['POST','/api/media-preparation/ocr/cancel']] as const)assert.equal((await node.app.inject({method,url,headers:collectorHeaders,...(method==='POST'?{payload:{}}:{})})).statusCode,403);
 const status=await node.app.inject({url:'/api/media-preparation',headers});assert.equal(status.statusCode,200);assert.equal(status.json().ocr.error,'runtime_unknown');
 assert.equal((await node.app.inject({method:'POST',url:'/api/media-preparation/ocr',headers,payload:{}})).statusCode,409);
 assert.equal((await node.app.inject({method:'POST',url:'/api/media-preparation/unlisted',headers,payload:{}})).statusCode,400);
 assert.equal((await node.app.inject({method:'POST',url:'/api/media-preparation/ocr',headers,payload:{source:'https://untrusted.invalid'}})).statusCode,400);
 assert.deepEqual(node.modelAuthorization.view(),before);assert.deepEqual(node.perception.settings(),initialPerception);
});


for(const mode of ['ready','missing','unreachable','marker-only','modified'] as const)test(`real ${mode} preparation HTTP state gates OCR processing consistently`,async t=>{
 const directory=await mkdtemp(join(tmpdir(),`mote-prepare-${mode}-`)),modelDirectory=join(directory,'models'),models=join(modelDirectory,'ocr'),secret='generated-'+mode+'-worker';
 const modelMissing=mode==='missing'||mode==='marker-only'||mode==='modified';
 let posts=0,node:Awaited<ReturnType<typeof buildApp>>|undefined;
 const worker=createServer((req,res)=>{
  if(req.headers.authorization!=='Bearer '+secret){res.writeHead(401);res.end();return;}
  if(req.method==='POST'&&req.url==='/ocr'){posts++;req.resume();req.on('end',()=>{res.writeHead(200,{'content-type':'application/json','x-mote-execution':'local'});res.end(JSON.stringify({durationMs:0,segments:[{startMs:0,endMs:0,text:'Generated readiness OCR'}]}));});return;}
  res.writeHead(mode==='unreachable'?503:200,{'content-type':'application/json'});res.end(JSON.stringify({version:1,execution:'local',ocr:mode!=='unreachable'}));
 });
 t.after(async()=>{try{await node?.app.close();}finally{worker.closeAllConnections();await new Promise<void>(resolve=>worker.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}});
 if(mode==='marker-only'){
  for(const name of ['det','rec']){await mkdir(join(models,name),{recursive:true});for(const file of ['inference.onnx','inference.yml'])await writeFile(join(models,name,file),'generated model marker');}
  await writeFile(join(models,'complete.json'),JSON.stringify({version:MEDIA_CATALOG.ocr.version}));
 }else if(mode!=='missing'){
  await installGeneratedOcr(t,directory,modelDirectory);
  if(mode==='modified'){
   const path=join(models,'det/inference.onnx'),bytes=await readFile(path);
   await writeFile(path,Buffer.alloc(bytes.length));
   await utimes(path,0,0);
  }
 }
 worker.listen(0,'127.0.0.1');await once(worker,'listening');const port=(worker.address() as {port:number}).port,endpoint=`http://127.0.0.1:${port}/ocr`;
 const config:Config={dataDir:join(directory,'archive'),token:'generated-'+mode+'-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'https://fixture.invalid',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',configuration:{runtime:'docker'},media:{modelDirectory,python:'python3',ocrPort:port,asrPort:port,ocrEndpoint:endpoint,asrEndpoint:`http://127.0.0.1:${port}/transcribe`,workerToken:secret}};
 node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,close:async()=>{},query:async()=>{throw Error('No model call expected');}}});
 const headers={authorization:'Bearer '+config.token},status=await node.app.inject({url:'/api/media-preparation',headers});assert.equal(status.statusCode,200,status.body);
 const ocr=status.json().ocr;
 if(mode==='ready'){assert.equal(ocr.state,'ready');assert.equal(ocr.runtimeReady,true);assert.equal(ocr.model.state,'ready');}
 else{assert.equal(ocr.state,'idle');assert.equal(ocr.runtimeReady,false);assert.equal(ocr.model.state,modelMissing?'not_installed':'ready');}
 const settings=node.perception.settings();await node.perception.save({revision:node.configService.revision,settings:{...settings,enabled:true,understandingEnabled:false}});
 if(mode==='ready')await authorizeFixtureModels(node);
 const id=randomUUID(),bytes=await sharp({create:{width:8,height:8,channels:3,background:'#aabbcc'}}).png().toBuffer();
 await node.store.ingest({id,deviceId:'generated-'+mode,deviceName:'Generated',platform:'macos',capturedAt:new Date().toISOString(),durationMs:0,source:'screen',appId:'generated',appName:'Generated',ocrText:'',ocr:{status:'disabled'},privacy:{excluded:false,redacted:false,mode:'local'},imageMime:'image/png',imageBase64:bytes.toString('base64')});
 for(let index=0;index<100;index++){
  await node.perception.tick();const step=node.executor.list({operationId:'image:'+id,kind:'images.ocr'}).items[0];
  if(mode==='ready'&&step?.state==='succeeded'||modelMissing&&step?.error==='model_missing'||mode==='unreachable'&&step?.error==='ocr_worker_unavailable')break;
  await delay(10);
 }
 const step=node.executor.list({operationId:'image:'+id,kind:'images.ocr'}).items[0];
 if(mode==='ready'){assert.equal(posts,1,'a ready worker receives the OCR task');assert.equal(step?.state,'succeeded');assert.match(node.store.evidence([id])[0].ocrText,/Generated readiness OCR/);}
 else{assert.equal(posts,0,'an unready worker never receives the OCR task');assert.equal(step?.error,modelMissing?'model_missing':'ocr_worker_unavailable');}
});
