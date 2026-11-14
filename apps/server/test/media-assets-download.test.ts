import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MEDIA_CATALOG,MediaAssets} from '../src/media-assets.js';

const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(condition:()=>boolean,message:string){
 const deadline=performance.now()+2000;
 while(!condition()){assert.ok(performance.now()<deadline,message);await turn();}
}
type Request={source:string;offset:number;response:ServerResponse};
function headers(request:Request,data:Buffer){
 const {offset,response}=request;
 response.writeHead(offset?206:200,{'content-length':data.length-offset,...(offset?{'content-range':`bytes ${offset}-${data.length-1}/${data.length}`}:{})});
}
async function fixture(t:import('node:test').TestContext,respond:(request:Request,data:Buffer,index:number)=>void){
 const root=await mkdtemp(join(tmpdir(),'mote-download-progress-')),prior=MEDIA_CATALOG.dialogue,data=Buffer.alloc(8192,37);
 MEDIA_CATALOG.dialogue={version:'generated-download-progress',files:[{name:'asr/model.pt',size:data.length,sha256:createHash('sha256').update(data).digest('hex'),official:'https://official.fixture.invalid/model',mirror:'https://mirror.fixture.invalid/model'}]};
 const requests:Request[]=[],assets=new MediaAssets(root),originalFetch=fetch;
 const server=createServer((req,res)=>{
  const request={source:req.url!.slice(1),offset:Number(req.headers.range?.match(/^bytes=(\d+)-$/)?.[1]??0),response:res};
  requests.push(request);respond(request,data,requests.length-1);
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;
 t.mock.method(globalThis,'fetch',(input:Parameters<typeof fetch>[0],init?:RequestInit)=>originalFetch(`http://127.0.0.1:${port}/${new URL(String(input)).hostname.split('.')[0]}`,init));
 t.after(async()=>{await assets.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));MEDIA_CATALOG.dialogue=prior;await rm(root,{recursive:true,force:true});});
 t.mock.timers.enable({apis:['setTimeout']});
 const clean=async()=>{
  assert.deepEqual((await readdir(root)).filter(name=>name.endsWith('.install')||name.endsWith('.lock')),[]);
 };
 return {root,data,assets,requests,clean,partial:join(root,'dialogue.downloads/asr/model.pt.part')};
}

test('a stalled official model stream automatically resumes its exact prefix and publishes verified bytes',async t=>{
 const f=await fixture(t,(request,data,index)=>{headers(request,data);if(index===0)request.response.write(data.subarray(0,1024));else request.response.end(data.subarray(request.offset));});
 const pending=f.assets.installAsync('dialogue','official');void pending.catch(()=>{});
 await until(()=>f.assets.status('dialogue').bytes===1024,'the first real HTTP prefix must reach disk');
 assert.equal(f.assets.ready('dialogue'),false);
 t.mock.timers.tick(60_001);
 await until(()=>f.requests.length===2,'a stalled stream must issue a fresh Range request without manual cancellation');
 await pending;
 assert.deepEqual(f.requests.map(request=>[request.source,request.offset]),[['official',0],['official',1024]]);
 await until(()=>f.requests[0].response.destroyed,'the stalled connection must close');
 assert.equal(f.assets.status('dialogue').state,'ready');assert.equal(f.assets.status('dialogue').bytes,f.data.length);
 assert.deepEqual(await readFile(join(f.assets.path('dialogue'),'asr/model.pt')),f.data);
 await assert.rejects(readFile(f.partial),{code:'ENOENT'});await f.clean();
 t.mock.timers.tick(120_000);await turn();assert.equal(f.requests.length,2,'completed downloads leave no retry timer');
});

test('a source that stalls before sending headers is retried without inventing received bytes',async t=>{
 const f=await fixture(t,(request,data,index)=>{if(index){headers(request,data);request.response.end(data);}});
 const pending=f.assets.installAsync('dialogue','official');void pending.catch(()=>{});
 await until(()=>f.requests.length===1,'the initial request must reach the local server');
 t.mock.timers.tick(60_001);
 await pending;
 assert.deepEqual(f.requests.map(request=>request.offset),[0,0]);assert.equal(f.assets.ready('dialogue'),true);
 await until(()=>f.requests[0].response.destroyed,'the stalled header request must close');await f.clean();
});

test('automatic source fallback resumes bytes retained across a bounded retry of a stalled mirror',async t=>{
 const f=await fixture(t,(request,data)=>{headers(request,data);if(request.source==='mirror')request.response.write(data.subarray(request.offset,request.offset+512));else request.response.end(data.subarray(request.offset));});
 const pending=f.assets.installAsync('dialogue','auto');void pending.catch(()=>{});
 await until(()=>f.assets.status('dialogue').bytes===512,'the mirror prefix must reach disk');
 t.mock.timers.tick(60_001);
 await until(()=>f.assets.status('dialogue').bytes===1024,'the mirror retry must retain and extend the prefix');
 t.mock.timers.tick(60_001);await pending;
 assert.deepEqual(f.requests.map(request=>[request.source,request.offset]),[['mirror',0],['mirror',512],['official',1024]]);
 assert.equal(f.assets.ready('dialogue'),true);assert.equal(f.assets.status('dialogue').source,'official.fixture.invalid');
 assert.deepEqual(await readFile(join(f.assets.path('dialogue'),'asr/model.pt')),f.data);
 await until(()=>f.requests.slice(0,2).every(request=>request.response.destroyed),'both stalled mirror connections must close');await f.clean();
});

test('repeated official stalls fail after one retry and leave a resumable cache for a fresh installer',async t=>{
 let recover=false;
 const f=await fixture(t,(request,data,index)=>{headers(request,data);if(recover)request.response.end(data.subarray(request.offset));else if(index===0)request.response.write(data.subarray(0,1024));else request.response.flushHeaders();});
 const pending=f.assets.installAsync('dialogue','official');void pending.catch(()=>{});
 await until(()=>f.assets.status('dialogue').bytes===1024,'the initial prefix must reach disk');
 t.mock.timers.tick(60_001);await until(()=>f.requests.length===2,'the stalled official request gets one retry');
 t.mock.timers.tick(60_001);await assert.rejects(pending,/no progress/);
 assert.equal(f.assets.status('dialogue').state,'failed');assert.equal(f.assets.status('dialogue').error,'model_install_failed');
 assert.equal(f.assets.ready('dialogue'),false);assert.deepEqual(await readFile(f.partial),f.data.subarray(0,1024));await f.clean();
 t.mock.timers.tick(120_000);await turn();assert.equal(f.requests.length,2,'retry exhaustion must be finite');
 recover=true;const next=new MediaAssets(f.root);t.after(()=>next.close());await next.installAsync('dialogue','official');
 assert.deepEqual(f.requests.map(request=>request.offset),[0,1024,1024]);assert.equal(next.ready('dialogue'),true);
 assert.deepEqual(await readFile(join(next.path('dialogue'),'asr/model.pt')),f.data);await f.clean();
});

test('a very slow model stream keeps its connection while individual bytes continue to arrive',async t=>{
 const f=await fixture(t,(request,data)=>{headers(request,data);request.response.write(data.subarray(0,1));});
 const pending=f.assets.installAsync('dialogue','official');void pending.catch(()=>{});
 await until(()=>f.assets.status('dialogue').bytes===1,'the first byte must reach disk');
 for(let received=2;received<=5;received++){
  t.mock.timers.tick(45_000);f.requests[0].response.write(f.data.subarray(received-1,received));
  await until(()=>f.assets.status('dialogue').bytes===received,'each slow byte must reset the no-progress deadline');
  assert.equal(f.requests.length,1);
 }
 f.requests[0].response.end(f.data.subarray(5));await pending;
 assert.equal(f.assets.ready('dialogue'),true);assert.equal(f.requests.length,1);
 assert.deepEqual(await readFile(join(f.assets.path('dialogue'),'asr/model.pt')),f.data);await f.clean();
});

test('cancel and close stop a resumed stalled download without scheduling more requests or publishing partial data',async t=>{
 for(const action of ['cancel','close'] as const)await t.test(action,async child=>{
  const f=await fixture(child,(request,data)=>{headers(request,data);request.response.write(data.subarray(request.offset,request.offset+512));});
  const pending=f.assets.installAsync('dialogue','official');void pending.catch(()=>{});
  await until(()=>f.assets.status('dialogue').bytes===512,'the first prefix must reach disk');
  child.mock.timers.tick(60_001);await until(()=>f.assets.status('dialogue').bytes===1024,'cancellation must occur during the resumed request');
  if(action==='cancel')await f.assets.cancel('dialogue');else await f.assets.close();
  await assert.rejects(pending);assert.equal(f.assets.status('dialogue').state,'cancelled');assert.equal(f.assets.ready('dialogue'),false);
  assert.deepEqual(await readFile(f.partial),f.data.subarray(0,1024));await f.clean();
  await until(()=>f.requests.every(request=>request.response.destroyed),'cancellation must close all download connections');
  child.mock.timers.tick(120_000);await turn();assert.equal(f.requests.length,2);
  if(action==='close')assert.throws(()=>f.assets.install('dialogue'),{statusCode:503});
 });
});

test('stall recovery still rejects invalid ranges, lengths, hashes, oversized bodies and unsafe redirects before publication',async t=>{
 for(const fault of ['range','length','hash','oversize','redirect'] as const)await t.test(fault,async child=>{
  const f=await fixture(child,(request,data,index)=>{
   if(!index){headers(request,data);request.response.write(data.subarray(0,1024));return;}
   const {offset,response}=request;
   if(fault==='redirect'){response.writeHead(302,{location:'http://127.0.0.1/unsafe'});response.end();return;}
   const remaining=Buffer.from(data.subarray(offset));if(fault==='hash')remaining[0]^=1;
   response.writeHead(206,{'content-range':`bytes ${fault==='range'?0:offset}-${data.length-1}/${data.length}`,...(fault==='oversize'?{}:{'content-length':remaining.length+(fault==='length'?1:0)})});
   response.end(fault==='oversize'?Buffer.concat([remaining,Buffer.from([1])]):remaining);
  });
  const pending=f.assets.installAsync('dialogue','official');void pending.catch(()=>{});
  await until(()=>f.assets.status('dialogue').bytes===1024,'the original stream must stop after a real prefix');
  child.mock.timers.tick(60_001);await assert.rejects(pending);
  assert.deepEqual(f.requests.map(request=>request.offset),[0,1024]);assert.equal(f.assets.status('dialogue').state,'failed');assert.equal(f.assets.ready('dialogue'),false);
  await assert.rejects(readFile(join(f.assets.path('dialogue'),'complete.json')),{code:'ENOENT'});await f.clean();
  child.mock.timers.tick(120_000);await turn();assert.equal(f.requests.length,2,'integrity and source failures must not trigger more retries');
 });
});
