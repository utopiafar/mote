import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {zstdDecompressSync} from 'node:zlib';
import {WebSocketServer} from 'ws';
import sharp from 'sharp';
import {buildApp} from '../src/app.js';
import {configFromDocument} from '../src/config.js';
import {createModelAgent,type ModelAgentFactory} from '../src/model-agent.js';
import {MEDIA_CATALOG} from '../src/media-assets.js';
import {MediaPreparation} from '../src/media-preparation.js';
import {sha256} from '../src/store.js';
import {materialId} from '../src/materials.js';
import {localImageProcessingSelection} from '../src/plugins/local-image-processing.js';
import {LOCAL_IMAGE_MODEL} from '../src/local-image-contract.js';
import {generatedMemoryOutput,planGeneratedMemory} from './fixtures/memory-planning.js';
import {authorizeFixtureModels,fixtureTopicResult} from './fixtures/model-authorization.js';
import {startLocalImageFixtureWorker,type LocalImageFixture} from './fixtures/local-image.js';

test('default Central exposes the existing optional image build without enabling or authorizing it',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-media-acceptance-'));
 const config=configFromDocument({version:1,revision:0,server:{port:0},storage:{dataDir:join(directory,'data')},diagnostics:{enabled:false,level:'silent'}},join(directory,'mote.yaml'),{token:'generated-media-acceptance-owner',tokenPath:join(directory,'token')});
 const node=await buildApp(config,{backgroundWorker:false});
 t.after(async()=>{try{await node.app.close();}finally{await rm(directory,{recursive:true,force:true});}});
 const headers={authorization:'Bearer '+config.token},before=node.modelAuthorization.view();
 const build=await node.app.inject({url:'/api/plugin-builds/local-image',headers});
 assert.equal(build.statusCode,200,build.body);
 assert.equal(build.json().desired,null);
 const off=await node.app.inject({url:'/api/local-image-processing',headers});
 assert.equal(off.statusCode,200,off.body);assert.deepEqual(off.json(),{enabled:false,state:'stopped'});
 assert.equal((await node.app.inject({url:'/api/local-image-processing'})).statusCode,401);
 const enable=await node.app.inject({method:'PATCH',url:'/api/plugin-builds/local-image',headers,payload:{expectedRevision:build.json().revision,operationId:randomUUID(),selection:localImageProcessingSelection}});
 assert.equal(enable.statusCode,200,enable.body);
 assert.deepEqual(enable.json().desired,localImageProcessingSelection);
 const state=await node.app.inject({url:'/api/local-image-processing',headers});
 assert.equal(state.statusCode,200,state.body);
 assert.deepEqual(state.json(),{enabled:true,state:'waiting',reason:'model_missing'});
 assert.deepEqual(node.modelAuthorization.view(),before,'selecting an optional processor never grants model access');
});

type Reply={tool:string;args:unknown}|{answer:string;citationIds:string[]};
type ModelPlan=(items:any[],step:number)=>Reply;
const texts=(parts:any):string=>typeof parts==='string'?parts:Array.isArray(parts)?parts.filter(part=>part.type==='input_text').map(part=>part.text).join('\n'):'';
const lastResult=(items:any[])=>JSON.parse(texts(items.filter(item=>item.type==='function_call_output'||item.type==='custom_tool_call_output').at(-1)?.output).split('\n')[0]);
async function until<T>(check:()=>Promise<T|false>,label:string):Promise<T>{
 const deadline=Date.now()+10000;
 while(Date.now()<deadline){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,20));}
 throw Error('Timed out waiting for '+label);
}
function pixels(items:any[]):Buffer[]{
 const result:Buffer[]=[];
 const visit=(value:any)=>{if(typeof value==='string'&&value.startsWith('data:image/'))result.push(Buffer.from(value.slice(value.indexOf(',')+1),'base64'));else if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')Object.values(value).forEach(visit);};
 visit(items);return result;
}

/** Real bundled Codex and Host tools; the only provider is this loopback fixture. */
async function nativeProvider(directory:string){
 const errors:unknown[]=[],contexts=new Map<string,any[]>();let plan:ModelPlan|undefined,step=0,serial=0,calls=0;
 const reply=(body:any,emit:(event:unknown)=>void)=>{
  try{
   const items=[...(body.previous_response_id?contexts.get(body.previous_response_id)??[]:[]),...body.input],id='generated-media-response-'+(++serial);
   let output:any[]=[];
   if(body.generate!==false){
    assert.ok(plan,'every generated model operation has an explicit fixture plan');assert.equal(body.model,'gpt-6.1-terra');calls++;
    const value=plan(items,step++);
    output='tool' in value?[{id:'generated-call-'+serial,type:'function_call',call_id:'generated-call-'+serial,name:value.tool,arguments:JSON.stringify(value.args),status:'completed'}]:
     [{id:'generated-message-'+serial,type:'message',role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:JSON.stringify(value),annotations:[]}]}];
   }
   contexts.set(id,[...items,...output]);emit({type:'response.created',response:{id,status:'in_progress'}});
   output.forEach((item,output_index)=>{emit({type:'response.output_item.added',output_index,item});emit({type:'response.output_item.done',output_index,item});});
   emit({type:'response.completed',response:{id,status:'completed',output,usage:{input_tokens:100,output_tokens:30,total_tokens:130}}});
  }catch(error){errors.push(error);emit({type:'response.failed',response:{id:'generated-failure',status:'failed',error:{code:'invalid_request_error',message:'Generated media provider assertion failed'}}});}
 };
 const server=createServer((request,response)=>{void(async()=>{
  if(request.method==='GET'&&request.url?.split('?')[0].endsWith('/models')){
   response.setHeader('content-type','application/json');response.end(JSON.stringify({models:[{slug:'gpt-6.1-terra',display_name:'Generated Terra',description:'Generated fixture',model_messages:{instructions_template:'Generated media fixture.'},default_reasoning_level:'medium',supported_reasoning_levels:[{effort:'medium',description:'Generated'}],shell_type:'shell_command',visibility:'list',supported_in_api:true,priority:0,supports_reasoning_summary_parameter:true,support_verbosity:false,tool_mode:'code_mode_only',use_responses_lite:true,truncation_policy:{mode:'tokens',limit:10000},context_window:272000,effective_context_window_percent:95,experimental_supported_tools:[],service_tiers:[{id:'priority',name:'Fast',description:'Generated'}],additional_speed_tiers:['fast']}]}));return;
  }
  assert.equal(request.method,'POST');assert.ok(request.url?.endsWith('/responses'));
  const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));let bytes=Buffer.concat(chunks);if(request.headers['content-encoding']==='zstd')bytes=zstdDecompressSync(bytes);
  response.writeHead(200,{'content-type':'text/event-stream'});reply(JSON.parse(bytes.toString()),event=>response.write('data: '+JSON.stringify(event)+'\n\n'));response.end();
 })().catch(error=>{errors.push(error);response.writeHead(500).end();});});
 const sockets=new WebSocketServer({noServer:true});
 sockets.on('connection',socket=>socket.on('message',bytes=>reply(JSON.parse(bytes.toString()),event=>socket.send(JSON.stringify(event)))));
 server.on('upgrade',(request,socket,head)=>sockets.handleUpgrade(request,socket,head,client=>sockets.emit('connection',client)));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const close=async()=>{for(const client of sockets.clients)client.terminate();await new Promise<void>(resolve=>sockets.close(()=>resolve()));await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});assert.deepEqual(errors,[]);};
 const executable=join(directory,'generated-native-wrapper.mjs'),native=fileURLToPath(new URL('../../../packages/agent/native/codex.mjs',import.meta.url));
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 await writeFile(join(directory,'auth.json'),JSON.stringify({OPENAI_API_KEY:'generated-unused-key'}),{mode:0o600});
 await writeFile(executable,`#!${process.execPath}\nimport{spawn}from'node:child_process';\nconst args=process.argv.slice(2);const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(native)},...args,...(args[0]==='--mote-context-budget-version'?[]:['-c',${JSON.stringify('openai_base_url='+JSON.stringify(origin+'/v1'))}])],{stdio:'inherit',env:{...process.env,NO_PROXY:'*'}});child.on('exit',code=>process.exit(code??1));process.on('SIGTERM',()=>child.kill('SIGTERM'));\n`,{mode:0o700});
 return {executable,close,select(value:ModelPlan){assert.deepEqual(errors,[]);plan=value;step=0;},assert(){assert.deepEqual(errors,[]);},calls:()=>calls};
}

test('generated audio and a 3 MiB image traverse default intake, independent Memory review, native Ask and restart in one private Central',{timeout:120000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-media-complete-')),workerRoot=join(directory,'worker');
 const driver=fileURLToPath(new URL('./fixtures/funasr-journey.py',import.meta.url));
 const generated=JSON.parse(execFileSync('python3',[driver,'--prepare',workerRoot],{encoding:'utf8',timeout:30000}));
 const imageBytes=await sharp(randomBytes(1024*1024*3),{raw:{width:1024,height:1024,channels:3}}).png({compressionLevel:0}).toBuffer();
 assert.ok(imageBytes.length>=3*1024*1024,'keep the original image regression scale');
 const image:LocalImageFixture={id:'media-journey',bytes:imageBytes,width:1024,height:1024,mimeType:'image/png',ocr:{durationMs:0,segments:[]},interpretation:{text:'Generated image fixture; authorship and meaning are unknown.',regions:[]}};
 const weights=Buffer.from('Generated local vision model boundary'),priorAudio=MEDIA_CATALOG.dialogue,priorImage=MEDIA_CATALOG['local-image'],priorOcr=MEDIA_CATALOG.ocr;
 MEDIA_CATALOG.dialogue=generated.catalog;MEDIA_CATALOG['local-image']={version:'generated-media-vision',models:{image:{id:LOCAL_IMAGE_MODEL.id,repository:'generated',revision:'generated-weights-revision',license:'generated',directory:'.'}},files:[{name:'model.bin',size:weights.length,sha256:sha256(weights),official:'https://example.invalid/generated'}]};
 MEDIA_CATALOG.ocr={version:'generated-media-ocr',files:[{name:'model.bin',size:weights.length,sha256:sha256(weights),official:'https://example.invalid/generated-ocr'}]};
 const cleanups:(()=>Promise<unknown>)[]=[];
 let node:Awaited<ReturnType<typeof buildApp>>|undefined,localRunning=false,stderr='',port=0,ocrCalls=0;
 const child=spawn('python3',[join(workerRoot,'transcription-server.py'),'--model-root',join(directory,'models/dialogue'),'--backend','cpu','--threads','1','--timeout','20','--load-timeout','10','--port','0','--temporary-root',workerRoot],{env:{PATH:process.env.PATH,HOME:workerRoot,TMPDIR:workerRoot,PYTHONNOUSERSITE:'1',MOTE_MEDIA_WORKER_TOKEN:'generated-local-image-worker-token'},stdio:['ignore','pipe','pipe']});
 const childClosed=new Promise<number|null>(resolve=>child.once('close',resolve));child.stderr.on('data',part=>{stderr=(stderr+part.toString()).slice(-4000);});
 t.after(async()=>{
  const failures:unknown[]=[];
  for(const close of [async()=>node?.app.close(),...cleanups,async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');assert.equal(await childClosed,0,stderr);}])try{await close();}catch(error){failures.push(error);}
  MEDIA_CATALOG.dialogue=priorAudio;MEDIA_CATALOG['local-image']=priorImage;MEDIA_CATALOG.ocr=priorOcr;
  await rm(directory,{recursive:true,force:true});
  if(failures.length)throw new AggregateError(failures,'Generated media journey cleanup failed');
 });
 const lines=createInterface({input:child.stdout});port=await new Promise<number>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Generated audio worker did not listen: '+stderr)),10000);lines.once('line',line=>{clearTimeout(timeout);resolve(JSON.parse(line).port);});child.once('error',reject);});lines.close();
 const vision=await startLocalImageFixtureWorker([image]);cleanups.push(()=>vision.close());
 const ocr=createServer((request,response)=>{void(async()=>{assert.equal(request.headers.authorization,'Bearer '+vision.token);response.setHeader('content-type','application/json');response.setHeader('X-Mote-Execution','local');if(request.url==='/health'){response.end('{"ocr":true}');return;}assert.equal(request.url,'/ocr');const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));assert.deepEqual(Buffer.concat(chunks),imageBytes);ocrCalls++;response.end(JSON.stringify(image.ocr));})().catch(()=>response.writeHead(500).end());});
 await new Promise<void>(resolve=>ocr.listen(0,'127.0.0.1',resolve));cleanups.push(()=>new Promise<void>(resolve=>{ocr.close(()=>resolve());ocr.closeAllConnections();}));
 // Only the physical VLM runtime is controlled. Default PluginCenter registration,
 // selection, the production intake adapter and serialized inference HTTP run.
 const originalStatus=MediaPreparation.prototype.status,originalStart=MediaPreparation.prototype.start,originalStop=MediaPreparation.prototype.stop;
 t.mock.method(MediaPreparation.prototype,'status',async function(this:MediaPreparation,role:Parameters<MediaPreparation['status']>[0]){const value=await originalStatus.call(this,role);return role==='local-image'?{...value,state:localRunning?'ready':'idle',runtimeReady:localRunning&&value.model.state==='ready',error:undefined}:value;});
 t.mock.method(MediaPreparation.prototype,'start',function(this:MediaPreparation,role:Parameters<MediaPreparation['start']>[0],install=true){if(role!=='local-image')return originalStart.call(this,role,install);localRunning=true;return this.status(role);});
 t.mock.method(MediaPreparation.prototype,'stop',function(this:MediaPreparation,role:Parameters<MediaPreparation['stop']>[0]){if(role!=='local-image')return originalStop.call(this,role);localRunning=false;return this.status(role);});
 const provider=await nativeProvider(directory),deliveries:{phase:string;imageReads:number;runId?:string}[]=[];cleanups.push(()=>provider.close());
 let selectedEvidence='',selectedMemory='',selectedKind:'audio'|'image'='audio';
 const factory:ModelAgentFactory=async(settings,reader,hooks)=>{
  const actual=await createModelAgent(settings,reader,{executable:provider.executable,home:directory},hooks?.runModel,hooks?.authorizeModelRequest);
  return {configured:actual.configured,close:()=>actual.close(),query:async input=>{
   assert.equal(input.directImages?.length??0,0,'enabled local intake must not call the configured language model');
   if(await planGeneratedMemory(input))return {answer:'Generated packages submitted.',citations:[],trace:[],runId:randomUUID()};
   const topic=fixtureTopicResult(input);if(topic)return topic;
   const memory=Boolean(input.taskContext?.memoryWork),phase=memory?input.traceContext?.phase??'extract':'ask';
   const evidence=selectedEvidence,kind=selectedKind;
   provider.select((items,step)=>{
    if(!memory&&step===0)return {tool:'memories',args:{id:selectedMemory}};
    if(!memory&&step===1){assert.equal(lastResult(items).data.items[0].id,selectedMemory);return {tool:'evidence',args:{ids:[evidence]}};}
    if(kind==='image'&&step===(memory?0:2))return {tool:'read_image',args:{id:memory?input.processingImages![0].id:evidence}};
    if(kind==='audio'&&memory&&step===0)return {tool:'evidence',args:{ids:[evidence]}};
    const record=node!.memories.readEvidence([evidence])[0];assert.ok(record);
    let proof:any;
    if(kind==='image'){assert.deepEqual(pixels(items),[imageBytes],'each independent native session receives exact archived pixels');proof={id:evidence,image:{originalSha256:sha256(imageBytes),viewId:lastResult(items).imageView.viewId}};}
    else {assert.ok(JSON.stringify(lastResult(items)).includes('完整尾段保留。'));proof={id:evidence,quote:record.ocrText};}
    const answer=memory?generatedMemoryOutput(input,[{title:'Generated '+kind+' observation',statement:`Generated ${kind} evidence retained. [${evidence}]`,uncertainty:'Synthetic fixture; no owner inference.',admission:{layer:'observation',reason:'Generated end-to-end evidence',scope:'Only this generated source',attribution:'observed'},evidenceIds:[evidence],evidence:[proof]}]):`Generated ${kind} answer supported by the retained original. [${evidence}]`;
    return {answer,citationIds:[evidence]};
   });
   const result=await actual.query(input);provider.assert();deliveries.push({phase:kind+':'+phase,imageReads:result.imageReadReceipts?.length??0,runId:result.runId});
   assert.ok(!JSON.stringify(result.trace).includes(imageBytes.toString('base64')),'traces never retain original image bytes');return result;
  }};
 };
 const config=configFromDocument({version:1,revision:0,server:{port:0},storage:{dataDir:join(directory,'data')},diagnostics:{enabled:false,level:'silent'},models:{deployment:{provider:'codex',protocol:'codex-app-server',model:'gpt-6.1-terra'}},media:{modelDirectory:join(directory,'models'),workerToken:vision.token,asrEndpoint:`http://127.0.0.1:${port}/transcribe`,asrPort:port,ocrEndpoint:`http://127.0.0.1:${(ocr.address() as {port:number}).port}/ocr`,ocrPort:(ocr.address() as {port:number}).port,localImageEndpoint:vision.url,localImagePort:Number(new URL(vision.url).port)}},join(directory,'mote.yaml'),{token:'generated-media-owner',tokenPath:join(directory,'owner-token')});
 const open=async()=>{node=await buildApp(config,{backgroundWorker:false,createModelAgent:factory});await node.app.listen({host:'127.0.0.1',port:0});};await open();
 const api=async(method:string,path:string,payload?:unknown)=>{const address=node!.app.server.address() as {port:number};const response=await fetch(`http://127.0.0.1:${address.port}`+path,{method,headers:{authorization:'Bearer '+config.token,...(payload instanceof Buffer?{'content-type':'application/octet-stream'}:payload===undefined?{}:{'content-type':'application/json'})},body:payload===undefined?undefined:payload instanceof Buffer?payload:JSON.stringify(payload)});const text=await response.text();assert.ok(response.ok,method+' '+path+': '+response.status+' '+text);return JSON.parse(text);};
 await node!.featureServices.mediaAssets.importBundle('dialogue',join(workerRoot,'bundle'));
 await until(async()=>{const response=await fetch(`http://127.0.0.1:${port}/health`,{headers:{authorization:'Bearer '+vision.token}});const health=await response.json() as {asr:boolean};return health.asr&&health;},'generated worker four-component health');
 const bundle=join(directory,'image-bundle');await mkdir(bundle);await writeFile(join(bundle,'model.bin'),weights);await node!.featureServices.mediaAssets.importBundle('local-image',bundle);await node!.featureServices.mediaAssets.importBundle('ocr',bundle);
 const build=await api('GET','/api/plugin-builds/local-image');await api('PATCH','/api/plugin-builds/local-image',{expectedRevision:build.revision,operationId:randomUUID(),selection:localImageProcessingSelection});
 assert.equal((await api('GET','/api/local-image-processing')).state,'ready');
 await node!.processing.saveImageDefault({endpoint:config.media!.ocrEndpoint});
 await node!.perception.save({revision:node!.configService.revision,settings:{...node!.perception.settings(),allowQueryImages:true}});
 await authorizeFixtureModels(node!);
 const audio=await readFile(join(workerRoot,'generated.wav')),originals=new Map<string,Buffer>(),memories:string[]=[];
 const models=node!.modelSettings.view();
 for(const kind of ['audio','image'] as const){
  selectedKind=kind;const sourceId='generated-complete-'+kind,bytes=kind==='audio'?audio:imageBytes,mimeType=kind==='audio'?'audio/wav':'image/png';
  await api('POST','/api/sources',{id:sourceId,name:'Generated '+kind,kind:'upload',deviceId:'generated-media-device',platform:'import',retention:'archive'});
  const upload=await api('POST','/api/file-sync/v1/uploads',{sourceId,sizeBytes:bytes.length,sha256:sha256(bytes),item:{externalId:'generated.'+kind,revision:'1',observedAt:'2026-11-14T00:00:00Z',title:'Generated media',kind:'file',layer:'original',text:'',mimeType,document:{contentRole:'reference',timeBasis:'unknown'}}});
  await api('PUT',`/api/file-sync/v1/uploads/${upload.uploadId}/parts/0`,bytes);const ack=await api('POST',`/api/file-sync/v1/uploads/${upload.uploadId}/commit`,{});originals.set(ack.id,bytes);
  await node!.processing.tick();assert.equal(node!.files.detail(ack.id).job!.state,'succeeded',JSON.stringify(node!.files.detail(ack.id).job));
  for(let i=0;i<30;i++)if(await node!.materialOrganizer.tick(100)===0)break;
  const material=node!.materials.get(materialId(sourceId,'generated.'+kind))!,pin=node!.materials.input(material.ref,kind==='audio'?['extracted-text']:['image-original'])!;assert.ok(pin.ready);
  const records=node!.memories.readEvidence(pin.evidenceIds);selectedEvidence=kind==='image'?pin.evidenceIds[0]:records.find(record=>record.ocrText.includes('完整尾段保留。'))!.id;
  const job=await api('POST','/api/memory-jobs',{evidenceIds:pin.evidenceIds,recipes:[{id:'mote.personal-memory',version:'5'}]});
  const done=await node!.memoryPipeline.run(job.id);assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(done.memoryIds.length,1);selectedMemory=done.memoryIds[0];memories.push(selectedMemory);
  const saved=node!.memories.get(selectedMemory);assert.equal(saved.status,'published');assert.equal(saved.evidence[0].id,selectedEvidence);
  const answer=await api('POST','/api/query',{question:'Inspect the generated '+kind+' original and its retained Memory.',anchorMaterialRef:material.ref});
  assert.equal(answer.citations[0].id,selectedEvidence);assert.ok(answer.evidenceDependencies.ids.includes(selectedEvidence));
  if(kind==='image'){assert.equal(vision.requests.length,1);assert.equal(saved.evidence[0].image!.original.sha256,sha256(imageBytes));assert.equal(answer.imageReadReceipts.length,1);}
 }
 assert.deepEqual(deliveries.map(value=>value.phase),['audio:extract','audio:review','audio:ask','image:extract','image:review','image:ask']);
 assert.equal(new Set(deliveries.map(value=>value.runId)).size,6,'extract, independent review and Ask are distinct actual native runs');
 assert.deepEqual(deliveries.map(value=>value.imageReads),[0,0,0,1,1,1]);assert.equal(ocrCalls,1);assert.deepEqual(node!.modelSettings.view(),models);
 const recognition=(await readFile(join(workerRoot,'calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.deepEqual(recognition.map(value=>value.operation),['recognize','diarize']);
 await node!.app.close();await open();
 for(const id of memories)assert.equal(node!.memories.get(id).status,'published');
 for(const [id,bytes] of originals)assert.deepEqual(Buffer.concat([...node!.files.bytes(id)]),bytes);
 assert.equal((await api('GET','/api/local-image-processing')).state,'ready');assert.deepEqual(node!.modelSettings.view(),models);assert.equal(vision.requests.length,1,'restart does not re-interpret saved images');
 const enabled=await api('GET','/api/plugin-builds/local-image');await api('PATCH','/api/plugin-builds/local-image',{expectedRevision:enabled.revision,operationId:randomUUID(),selection:null});
 assert.equal(localRunning,false,'disabling the build joins its physical runtime stop');
 assert.deepEqual(await api('GET','/api/local-image-processing'),{enabled:false,state:'stopped'});
 assert.equal((await(await fetch(`http://127.0.0.1:${port}/health`,{headers:{authorization:'Bearer '+vision.token}})).json() as {asr:boolean}).asr,true,'stopping image processing leaves ASR available');
 await node!.app.close();await open();
 assert.deepEqual(await api('GET','/api/local-image-processing'),{enabled:false,state:'stopped'});
 for(const id of memories)assert.equal(node!.memories.get(id).status,'published');
 t.diagnostic(JSON.stringify({evidence:'generated model boundaries',imageBytes:imageBytes.length,nativeRuns:deliveries,providerRequests:provider.calls(),audioOperations:recognition.map(value=>value.operation),memories:memories.length,restart:true,disabledRestart:true,realModels:false}));
});
