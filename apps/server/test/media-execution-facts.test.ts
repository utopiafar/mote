import {authorizeFixtureModels} from './fixtures/model-authorization.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {MEDIA_CATALOG} from '../src/media-assets.js';
import {readMediaExecutionFact} from '../src/media-execution-facts.js';

async function until(check:()=>Promise<boolean>,label:string,diagnostics?:()=>unknown){const deadline=Date.now()+15000;while(!await check()){if(Date.now()>deadline)throw Error('Generated media journey did not reach '+label+(diagnostics?' '+JSON.stringify(diagnostics()):''));await delay(10);}}
async function fixture(t:TestContext,mode='fail2',hold=true){
 const root=await mkdtemp(join(tmpdir(),'mote-media-facts-')),modelDirectory=join(root,'models'),models=join(modelDirectory,'ocr'),secret='generated-media-worker-'+randomUUID();
 const cleanup:(()=>Promise<unknown>)[]=[()=>rm(root,{recursive:true,force:true})];t.after(async()=>{const errors:unknown[]=[];for(const action of cleanup.reverse())try{await action();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Generated media cleanup failed');});
 for(const name of ['det','rec']){await mkdir(join(models,name),{recursive:true});for(const file of ['inference.onnx','inference.yml'])await writeFile(join(models,name,file),'generated model marker');}
 await writeFile(join(models,'complete.json'),JSON.stringify({version:MEDIA_CATALOG.ocr.version}));
 await mkdir(join(root,'paddlex/inference'),{recursive:true});
 await writeFile(join(root,'paddlex/inference/pipelines.py'),`def load_pipeline_config(name): return {'SubModules':{'TextDetection':{},'TextRecognition':{}}}
class Pipeline:
    def predict(self, image): pass
def create_pipeline(**kwargs): return Pipeline()
`);
 await writeFile(join(root,'mote_ocr.py'),`from pathlib import Path
import time
class UnsupportedImage(Exception): pass
def recognize_image(image, predict):
    root=Path(__file__).parent
    count=int((root/'count').read_text())+1 if (root/'count').exists() else 1
    (root/'count').write_text(str(count))
    while (root/'hold').exists(): time.sleep(0.005)
    mode=(root/'mode').read_text()
    if mode=='unsupported': raise UnsupportedImage('generated unsupported input')
    if mode=='fail' or (mode=='fail2' and count<=2): raise RuntimeError('generated transient recognizer failure')
    return {'durationMs':0,'segments':[{'startMs':0,'endMs':0,'text':'Generated retained OCR proof'}]}
`);
 for(const file of ['ocr-server.py','mote_execution_facts.py'])await writeFile(join(root,file),await readFile(new URL('../../../scripts/'+file,import.meta.url)));
 await writeFile(join(root,'mode'),mode);if(hold)await writeFile(join(root,'hold'),'');
 let child:ChildProcess|undefined,workerUrl='',closed:Promise<unknown>|undefined;
 const stopWorker=async()=>{if(child){child.kill('SIGKILL');await closed;child=undefined;}};
 const startWorker=async()=>{
  const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=(reservation.address() as {port:number}).port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  child=spawn('python3',[join(root,'ocr-server.py'),'--model-root',models,'--port',String(port)],{cwd:root,env:{PATH:process.env.PATH,PYTHONPATH:root,MOTE_MEDIA_WORKER_TOKEN:secret},stdio:'ignore'});closed=once(child,'close');workerUrl='http://127.0.0.1:'+port;
  await until(async()=>{try{return (await fetch(workerUrl+'/health',{headers:{Authorization:'Bearer '+secret},signal:AbortSignal.timeout(500)})).ok;}catch{return false;}},'actual copied Python worker startup');
 };
 await startWorker();cleanup.push(stopWorker);
 const posts:string[]=[],drop=new Set([1,2]);let probes=0;
 const proxy=createServer((req,res)=>{void(async()=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  const headers=Object.fromEntries(Object.entries(req.headers).filter(([key,value])=>value!==undefined&&['authorization','content-type','x-mote-request-id','x-mote-request-scope','x-mote-media-type'].includes(key))) as Record<string,string>;
  const index=req.method==='POST'?posts.push(String(req.headers['x-mote-request-id'])):0;if(req.method==='GET')probes++;
  const response=await fetch(workerUrl+req.url,{method:req.method,headers,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})});
  const bytes=Buffer.from(await response.arrayBuffer());
  if(index&&drop.has(index)){res.destroy();return;}
  res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')??'application/json',...(response.headers.get('x-mote-receipt-id')?{'X-Mote-Receipt-Id':response.headers.get('x-mote-receipt-id')!}:{}),'Content-Length':String(bytes.length)});res.end(bytes);
 })().catch(()=>res.destroy());});
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const endpoint='http://127.0.0.1:'+(proxy.address() as {port:number}).port+'/ocr';
 cleanup.push(async()=>{proxy.closeAllConnections();await new Promise<void>(resolve=>proxy.close(()=>resolve()));});
 const config:Config={dataDir:join(root,'archive'),token:'generated-owner-'+randomUUID(),tokenPath:'generated-only',host:'127.0.0.1',port:0,profile:'test',tokenFromEnvironment:true,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'https://example.invalid',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent',media:{modelDirectory,python:'python3',ocrPort:Number(new URL(endpoint).port),asrPort:1,ocrEndpoint:endpoint,asrEndpoint:'http://127.0.0.1:1/transcribe',workerToken:secret}};
 let node:Awaited<ReturnType<typeof buildApp>>|undefined,centralUrl='',initialOwnerApproval=true;
 const start=async()=>{node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model belongs in this media fixture');},close:async()=>{}}});centralUrl=await node.app.listen({host:'127.0.0.1',port:0});const settings=node.perception.settings();await node.perception.save({revision:node.configService.revision,settings:{...settings,enabled:true,understandingEnabled:false}});if(initialOwnerApproval){await authorizeFixtureModels(node);initialOwnerApproval=false;}return node;};
 const close=async()=>{await node?.app.close();node=undefined;};cleanup.push(close);
 const intake=async()=>{const id=randomUUID(),bytes=await sharp({create:{width:8,height:8,channels:3,background:'#aabbcc'}}).png().toBuffer();const response=await fetch(centralUrl+'/api/captures',{method:'POST',headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json','x-mote-ingress-version':'2'},body:JSON.stringify({id,deviceId:'generated-android',deviceName:'Generated phone',platform:'android',source:'screen',capturedAt:new Date().toISOString(),durationMs:0,appId:'generated',appName:'Generated',ocrText:'',ocr:{status:'disabled'},privacy:{excluded:false,redacted:false,mode:'local'},imageMime:'image/png',imageBase64:bytes.toString('base64')})});assert.equal(response.status,201,await response.text());return id;};
 return {root,config,posts,drop,start,close,intake,startWorker,stopWorker,probes:()=>probes,get node(){return node!;},release:()=>rm(join(root,'hold'),{force:true}),worker:()=>workerUrl,headers:{Authorization:'Bearer '+secret},request:(path:string,method:string)=>fetch(centralUrl+path,{method,headers:{Authorization:'Bearer '+config.token}})};
}

test('actual Central and copied Python worker recover a lost response and refunded attempt through restart, then succeed on the third call',async t=>{
 const f=await fixture(t),node=await f.start(),id=await f.intake();
 const running=node.perception.tick().catch(()=>{});await until(async()=>await readFile(join(f.root,'count'),'utf8').catch(()=>null)==='1','issued recognizer before shutdown');
 const call=node.processing.mediaCalls.pending()[0];assert.ok(call);assert.equal(node.executor.get(call.stepId)!.attempts,1);
 const transport={endpoint:f.config.media!.ocrEndpoint,apiKey:f.config.media!.workerToken,requestId:call.requestId,scope:call.scope,signal:new AbortController().signal};
 assert.equal((await readMediaExecutionFact(transport))?.state,'running');assert.equal((await readMediaExecutionFact(transport))?.state,'running');
 assert.equal(node.executor.get(call.stepId)!.attempts,1,'status reads do not create attempts');
 await f.close();await running;await f.release();
 const restarted=await f.start();assert.equal(restarted.executor.get(call.stepId)!.attempts,0,'ordinary host shutdown refunded the interrupted local frame');
 await until(async()=>{await restarted.processing.tick();return Number(restarted.store.db.prepare("SELECT count(*) n FROM image_products WHERE capture_id=? AND kind='ocr'").get(id)!.n)===1;},'authenticated failed settlement and third-attempt OCR',()=>({
  posts:f.posts.length,probes:f.probes(),
  steps:restarted.store.db.prepare('SELECT kind,state,attempts,error,available_at FROM execution_steps WHERE id=?').all(call.stepId),
  calls:restarted.processing.mediaCalls.pending().map(({state,issuedAttempt,supported,fact})=>({state,issuedAttempt,supported,factState:fact?.state,failureCode:fact?.failureCode})),
  waits:restarted.store.db.prepare('SELECT state,count(*) n FROM file_processor_waits GROUP BY state').all(),
 }));
 assert.equal(f.posts.length,3);assert.equal(new Set(f.posts).size,3);assert.equal(restarted.executor.get(call.stepId)!.attempts,3,'each genuine failed issuance is restored exactly once');
 assert.match(restarted.store.evidence([id])[0].ocrText,/Generated retained OCR proof/);
 await restarted.materialOrganizer.tick(200);assert.ok(restarted.materials.list().items.length>0,'real intake reaches Material');
 assert.equal(restarted.store.db.prepare('SELECT count(*) n FROM model_usage').get()!.n,0,'status GETs and OCR do not fabricate model usage');
 await f.close();const again=await f.start();await again.processing.tick();assert.equal(f.posts.length,3,'a committed successful stage is reused after restart');
});

test('successful worker facts cannot replace a lost body, and authenticated status cannot cross scopes',async t=>{
 const f=await fixture(t,'success',false),node=await f.start(),id=await f.intake();await node.perception.tick();
 const call=node.processing.mediaCalls.pending()[0];assert.ok(call);
 const url=f.worker()+'/executions/'+call.requestId;
 assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{method:'DELETE'})).status,401);
 assert.equal((await(await fetch(url,{headers:{...f.headers,'X-Mote-Request-Scope':'b'.repeat(64)}})).json()).state,'unknown');
 await until(async()=>{await node.processing.tick();return node.processing.mediaCalls.get(call.requestId)?.fact?.state==='succeeded';},'succeeded fact without result body');
 node.store.logicalBytes();const savedCall=node.store.db.prepare('SELECT input,fact FROM media_execution_calls WHERE request_id=?').get(call.requestId)!;
 assert.equal(node.store.db.prepare("SELECT bytes FROM storage_ledger WHERE name='media_execution_calls'").get()!.bytes,Buffer.byteLength(String(savedCall.input))+Buffer.byteLength(String(savedCall.fact))+1024,'issued input and authenticated execution fact count against the vault quota');
 assert.ok(Number(node.store.db.prepare("SELECT bytes FROM storage_ledger WHERE name='media_execution_instance'").get()!.bytes)>128);
 const pinned=node.processing.mediaCalls.get(call.requestId)!.fact!;
 assert.equal(node.processing.mediaCalls.observe(call.requestId,{...pinned,incarnation:randomUUID()}),false,'another physical incarnation cannot substitute its outcome');
 assert.equal(node.processing.mediaCalls.observe(call.requestId,{...pinned,stage:'diarize'}),false);
 const probes=f.probes();assert.equal(await readMediaExecutionFact({endpoint:f.config.media!.ocrEndpoint,apiKey:'',requestId:call.requestId,scope:call.scope,signal:new AbortController().signal}),undefined);assert.equal(f.probes(),probes,'missing credentials do not send a status request');
 const metadata=JSON.stringify(node.store.db.prepare('SELECT * FROM media_execution_calls').all());assert.ok(!metadata.includes(f.config.media!.workerToken));assert.ok(!metadata.includes('Generated retained OCR proof'));assert.ok(!metadata.includes(f.root));
 for(let i=0;i<3;i++)await node.processing.tick();assert.equal(f.posts.length,1);assert.equal(node.store.db.prepare('SELECT count(*) n FROM image_products WHERE capture_id=?').get(id)!.n,0);
 await f.close();const restarted=await f.start();for(let i=0;i<3;i++)await restarted.processing.tick();assert.equal(f.posts.length,1,'success without body remains guarded through restart');
});

for(const mode of ['fail','unsupported'])test(`authenticated ${mode} facts preserve finite failure budgets without replaying terminal work`,async t=>{
 const f=await fixture(t,mode,false),node=await f.start();await f.intake();
 await until(async()=>{await node.processing.tick();return node.executor.list({kind:'images.ocr'}).items.some(step=>step.state==='failed');},'terminal OCR failure');
 const step=node.executor.list({kind:'images.ocr'}).items[0],expected=mode==='fail'?3:1;
 assert.equal(f.posts.length,expected);assert.equal(step.attempts,expected);assert.equal(step.state,'failed');
 for(let i=0;i<5;i++)await node.processing.tick();await f.close();const restarted=await f.start();for(let i=0;i<3;i++)await restarted.processing.tick();
 assert.equal(f.posts.length,expected,'restart and repeated status reads never reset an exhausted or permanent budget');
});

for(const action of ['cancel','delete'])test(`a ${action} during real recognition permits only terminal receipt cleanup, with no late artifact`,async t=>{
 const f=await fixture(t,'success',true),node=await f.start(),id=await f.intake();const running=node.perception.tick().catch(()=>{});
 await until(async()=>await readFile(join(f.root,'count'),'utf8').catch(()=>null)==='1','held physical recognition');
 const call=node.processing.mediaCalls.pending()[0];assert.ok(call);
 const response=await f.request(action==='delete'?'/api/captures/'+id:'/api/images/'+id+'/cancel',action==='delete'?'DELETE':'POST');assert.equal(response.status,200,await response.text());
 await f.release();await running;
 await until(async()=>{await node.processing.tick();return !node.processing.mediaCalls.get(call.requestId);},'terminal-only exact receipt cleanup');
 node.store.logicalBytes();assert.equal(node.store.db.prepare("SELECT bytes FROM storage_ledger WHERE name='media_execution_calls'").get()!.bytes,0,'terminal receipt cleanup releases its accounted bytes');
 assert.equal(node.store.db.prepare('SELECT count(*) n FROM file_processor_waits WHERE token=?').get(call.requestId)!.n,0);
 assert.equal(node.store.db.prepare('SELECT count(*) n FROM image_products WHERE capture_id=?').get(id)!.n,0);assert.equal(f.posts.length,1);
 const status=await(await fetch(f.worker()+'/executions/'+call.requestId,{headers:{...f.headers,'X-Mote-Request-Scope':call.scope}})).json();assert.equal(status.state,'unknown');
 const replay=await fetch(f.worker()+'/ocr',{method:'POST',headers:{...f.headers,'X-Mote-Request-Id':call.requestId,'X-Mote-Request-Scope':call.scope},body:'generated replay'});assert.equal(replay.status,409,'cleanup retains the consumed request identity');
 assert.equal(await readFile(join(f.root,'count'),'utf8'),'1');
 await f.close();const restarted=await f.start();await restarted.processing.tick();assert.equal(f.posts.length,1);
});

test('a worker process restart retains an unknown physical outcome and does not resend its accepted request',async t=>{
 const f=await fixture(t,'success',true),node=await f.start();await f.intake();const running=node.perception.tick().catch(()=>{});
 await until(async()=>await readFile(join(f.root,'count'),'utf8').catch(()=>null)==='1','worker active before process loss');
 const call=node.processing.mediaCalls.pending()[0];assert.ok(call);await f.stopWorker();await running;await f.startWorker();
 await until(async()=>{await node.processing.tick();return node.processing.mediaCalls.get(call.requestId)?.fact?.state==='unknown';},'new worker incarnation reports unknown');
 for(let i=0;i<3;i++)await node.processing.tick();assert.equal(f.posts.length,1);assert.equal(node.processing.mediaCalls.get(call.requestId)!.fact!.outcome,'worker_restarted');
 assert.equal((await fetch(f.worker()+'/executions/'+call.requestId,{method:'DELETE',headers:{...f.headers,'X-Mote-Request-Scope':call.scope}})).status,409,'unknown facts cannot be erased to permit replay');
});
