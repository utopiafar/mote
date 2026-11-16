import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {MediaPreparation} from '../src/MediaPreparation.js';
import {ApiError,type Api} from '../src/api.js';
import {readResource,resources} from '../src/resource-cache.js';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {LocalImageSettings} from '../src/LocalImageSettings.js';
import {generatedLocalImageSetup} from '../../server/test/fixtures/media-setup.js';
import {buildApp} from '../../server/src/app.js';
import {MEDIA_CATALOG} from '../../server/src/media-assets.js';
configureLocale(()=> 'zh-CN');
async function fixture(t:import('node:test').TestContext){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'}),prior=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor]of prior){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
 const button=(label:string)=>{const node=[...dom.window.document.querySelectorAll('button')].find(node=>node.textContent===label);assert.ok(node,label);return node;};return {root,dom,button};
}
test('prepare does not enable processing, prevents duplicate clicks and offers cancel/retry after dependency failure',async t=>{
 const f=await fixture(t),calls:string[]=[];let state='idle';
 const api={request:async(path:string,init?:RequestInit)=>{if(init?.method==='POST'){calls.push(path);state=path.endsWith('/cancel')?'cancelled':'dependencies';return {};}assert.equal(path,'/api/media-preparation');return {ocr:{state,runtimeReady:false,model:{state:'not_installed',bytes:0,totalBytes:100}}};}} as Api;
 await act(async()=>f.root.render(React.createElement(MediaPreparation,{api,role:'ocr',title:'图片文字识别'})));assert.equal(calls.length,0);
 await act(async()=>f.button('一键安装').click());assert.deepEqual(calls,['/api/media-preparation/ocr']);assert.equal(f.button('安装中…').disabled,true);assert.match(f.dom.window.document.body.textContent!,/正在准备运行依赖/);
 await act(async()=>f.button('取消').click());assert.match(f.dom.window.document.body.textContent!,/安装已取消/);await act(async()=>f.button('重试').click());assert.equal(calls.length,3);
 state='failed';await act(async()=>resources(api).invalidate(()=>true));assert.match(f.dom.window.document.body.textContent!,/网络和可用空间/);assert.ok(f.button('重试'));assert.ok(calls.every(path=>path.startsWith('/api/media-preparation/')));
});
test('missing permission withdraws stale installation controls and a changed node ignores late preparation replies',async t=>{
 const f=await fixture(t);let release!:()=>void,denied=false;const pending=new Promise<void>(resolve=>release=resolve),oldCalls:string[]=[];
 const old={request:async(path:string,init?:RequestInit)=>{oldCalls.push(path);if(init?.method==='POST'){await pending;return {};}if(denied)throw new ApiError('generated revoked',403);return {ocr:{state:'idle',runtimeReady:false,model:{state:'not_installed',bytes:0,totalBytes:1}}};}} as Api;
 await act(async()=>f.root.render(React.createElement(MediaPreparation,{api:old,role:'ocr',title:'图片文字识别'})));
 await act(async()=>f.button('一键安装').click());let nextReads=0;const next={request:async()=>{nextReads++;return {ocr:{state:'unsupported',error:'platform_unsupported',runtimeReady:false,model:{state:'not_installed',bytes:0,totalBytes:1}}};}} as unknown as Api;
 await act(async()=>f.root.render(React.createElement(MediaPreparation,{api:next,role:'ocr',title:'图片文字识别'})));await act(async()=>release());assert.equal(nextReads,1);assert.equal(f.button('一键安装').disabled,true);assert.match(f.dom.window.document.body.textContent!,/暂不支持自动安装/);
 denied=true;await act(async()=>f.root.render(React.createElement(MediaPreparation,{api:old,role:'ocr',title:'图片文字识别'})));assert.match(f.dom.window.document.body.textContent!,/generated revoked/);assert.equal(f.button('一键安装').disabled,true);
});
test('a ready service exposes explicit verification through preparation while ordinary status reads remain read-only',async t=>{
 const f=await fixture(t);let ready=true,reads=0;const writes:string[]=[];
 const api={request:async(path:string,init?:RequestInit)=>{if(init?.method==='POST'){assert.equal(path,'/api/media-preparation/ocr');assert.equal(init.body,'{}');writes.push(path);return {};}assert.equal(path,'/api/media-preparation');reads++;return {ocr:{state:ready?'ready':'idle',runtimeReady:ready,model:{state:'ready',bytes:100,totalBytes:100}}};}} as Api;
 await act(async()=>f.root.render(React.createElement(MediaPreparation,{api,role:'ocr',title:'图片文字识别'})));assert.match(f.dom.window.document.body.textContent!,/可使用/);
 assert.deepEqual(writes,[]);ready=false;await act(async()=>f.button('验证并修复').click());assert.equal(reads,2);assert.deepEqual(writes,['/api/media-preparation/ocr']);assert.match(f.dom.window.document.body.textContent!,/服务尚未就绪/);assert.ok(f.button('重试'));
});

test('local-image Web setup prepares actual runtime receipts and verified assets; only explicit plugin control starts its owned worker',async t=>{
 const f=await fixture(t),setup=await generatedLocalImageSetup(t),writes:string[]=[],pendingReads=new Set<Promise<unknown>>();
 const api={request:async(path:string,init?:RequestInit)=>{if(init?.method)writes.push(path);const pending=setup.request(path,init);pendingReads.add(pending);try{return await pending;}finally{pendingReads.delete(pending);}}} as Api;
 const drain=async()=>{do{await Promise.all([...pendingReads]);await new Promise(resolve=>setImmediate(resolve));}while(pendingReads.size);};
 const before=()=>({authorization:setup.node.modelAuthorization.view(),models:setup.node.modelSettings.view(),perception:setup.node.perception.settings(),processing:setup.node.processing.currentSettings()});
 const initial=before(),preparation=React.createElement(MediaPreparation,{api,role:'local-image',title:'Generated local image'});
 await act(async()=>f.root.render(React.createElement(LocalImageSettings,{api,control:{instanceId:'local-image',selection:{packageId:'mote.local-image-processing',version:'1.0.0',configurationRevision:0},statePath:'/api/local-image-processing'},modelName:'Generated local image',copy:{title:'本地图片解析',scope:'Generated intake selection',preparationNote:'Preparation is separate from enablement.',disabled:'Generated disabled selection',ready:'Generated ready',waiting:'Generated waiting',stopping:'Generated stopping',unavailable:'Generated unavailable',reasons:{}},preparation})));
 const status=()=>setup.node.featureServices.mediaPreparation.status('local-image');
 const paths=['/api/media-preparation','/api/plugin-builds','/api/media-models','/api/local-image-processing','/api/model-authorization'];
 const refresh=async()=>{await act(async()=>{resources(api).invalidate(()=>true);do{await Promise.all(paths.map(path=>readResource(api,path,new AbortController().signal)));await drain();}while(paths.some(path=>resources(api).get(path).getSnapshot().loading));});};
 await refresh();
 assert.deepEqual(writes,[]);
 if(!setup.supported){
  assert.equal((await status()).state,'unsupported');assert.equal((await status()).error,'platform_unsupported');
  assert.equal(f.button('一键安装').disabled,true);assert.match(f.dom.window.document.body.textContent!,/暂不支持自动安装/);assert.deepEqual(setup.counts,{prepare:0,pip:0,probe:0});return;
 }
 const held=setup.holdDependencies();await act(async()=>{f.button('一键安装').click();await drain();});await held.entered;
 const first=await status(),duplicate=await setup.request('/api/media-preparation/local-image',{method:'POST',body:'{}'});
 assert.equal(first.id,duplicate.id);assert.equal(setup.counts.prepare,1);assert.equal(setup.counts.pip,1);assert.equal(f.button('安装中…').disabled,true);
 await act(async()=>{f.button('取消').click();await new Promise(resolve=>setImmediate(resolve));held.release();await setup.until(async()=>(await status()).state==='cancelled','setup cancellation completes');await drain();});
 assert.equal((await status()).runtimeReady,false);assert.equal(setup.node.featureServices.mediaAssets.status('local-image').state,'not_installed');
 await assert.rejects(readFile(setup.pidPath),{code:'ENOENT'});assert.deepEqual(before(),initial);
 await refresh();await act(async()=>{f.button('重试').click();await setup.until(async()=>(await status()).state==='prepared','setup verifies the generated environment and assets');await drain();});await refresh();
 const prepared=await status();assert.equal(prepared.runtimeReady,false);assert.equal(prepared.model.state,'ready');
 assert.match(f.dom.window.document.body.textContent!,/运行依赖和模型已准备/);assert.doesNotMatch(f.dom.window.document.body.textContent!,/服务尚未就绪|准备未完成/);
 assert.match(f.dom.window.document.body.textContent!,/安装模型不会启用本地识图/);assert.equal(f.dom.window.document.querySelector('[role=switch]')!.getAttribute('aria-checked'),'false');
 assert.deepEqual((await setup.request('/api/local-image-processing')),{enabled:false,state:'stopped'});await assert.rejects(readFile(setup.pidPath),{code:'ENOENT'});
 const marker=JSON.parse(await readFile(join(setup.config.media!.modelDirectory,'runtime/local-image/current.json'),'utf8'));
 assert.equal(marker.role,'local-image');assert.match(marker.generation,/^environment-/);assert.equal(setup.counts.pip,2);assert.ok(setup.counts.probe>0);assert.deepEqual(before(),initial);
 await writeFile(setup.installed,Buffer.alloc(setup.bytes.length,1));assert.equal(setup.node.featureServices.mediaAssets.ready('local-image'),true,'same-size image corruption remains the strict worker boundary during normal status');
 await act(async()=>{f.button('启用').click();await setup.until(async()=>(await setup.request('/api/local-image-processing')).state==='failed','the production byte verifier rejects changed weights before publishing worker health');await drain();});await refresh();
 assert.equal((await status()).runtimeReady,false);await assert.rejects(readFile(setup.pidPath),{code:'ENOENT'});
 assert.deepEqual(await setup.request('/api/local-image-processing'),{enabled:true,state:'failed',reason:'worker_unavailable'});
 const prepareRetry=[...f.dom.window.document.querySelectorAll<HTMLButtonElement>('.media-preparation button')].find(button=>button.textContent==='重试');assert.ok(prepareRetry);
 await act(async()=>{prepareRetry.click();await setup.until(async()=>(await readFile(setup.installed)).equals(setup.bytes)&&(await status()).state==='prepared','explicit setup repairs verified assets');await drain();});await refresh();
 assert.equal(setup.counts.pip,2,'valid dependency receipts are probed and reused');assert.deepEqual(before(),initial);await assert.rejects(readFile(setup.pidPath),{code:'ENOENT'});
 assert.deepEqual(await setup.request('/api/local-image-processing'),{enabled:true,state:'failed',reason:'worker_unavailable'},'setup keeps the existing selected plugin waiting for its explicit retry');
 await act(async()=>{f.button('重试').click();await setup.until(async()=>(await status()).runtimeReady&&(await setup.request('/api/local-image-processing')).state==='ready'&&(await setup.request('/api/plugin-builds')).find((build:{id:string})=>build.id==='local-image')?.observed==='active','the existing explicit plugin retry starts the physical Python worker');await drain();});await refresh();
 const pid=await setup.pid();assert.ok(pid>0);assert.equal(f.dom.window.document.querySelector('[role=switch]')!.getAttribute('aria-checked'),'true');
 assert.deepEqual(await setup.request('/api/local-image-processing'),{enabled:true,state:'ready'});assert.deepEqual(before(),initial,'plugin selection does not grant background processing authority');
 assert.equal((await fetch(new URL('/health',setup.endpoint))).status,401);
 await act(async()=>{f.button('停用').click();await setup.until(async()=>(await setup.request('/api/local-image-processing')).state==='stopped','disable stops the optional worker');await drain();});await refresh();
 assert.equal((await status()).runtimeReady,false);await assert.rejects(fetch(setup.endpoint));assert.throws(()=>process.kill(pid,0),(error:NodeJS.ErrnoException)=>error.code==='ESRCH');
 const counts={...setup.counts};await setup.restart();await refresh();
 assert.equal((await status()).state,'idle');assert.equal((await status()).model.state,'ready');assert.equal((await status()).runtimeReady,false);
 assert.match(f.dom.window.document.body.textContent!,/模型已安装；运行依赖待验证/);assert.doesNotMatch(f.dom.window.document.body.textContent!,/服务尚未就绪|准备未完成|尚未安装/);
 assert.equal(f.dom.window.document.querySelector('[role=switch]')!.getAttribute('aria-checked'),'false');assert.deepEqual(setup.counts,counts,'status and restart do not install or launch optional inference');
 await act(async()=>{f.button('验证并修复').click();await setup.until(async()=>(await status()).state==='prepared','setup reuses the durable native environment after restart');await drain();});await refresh();
 assert.equal(setup.counts.pip,counts.pip);assert.ok(setup.counts.probe>counts.probe);assert.equal((await status()).runtimeReady,false);assert.deepEqual(before(),initial);
 assert.ok(writes.includes('/api/media-preparation/local-image/cancel'));assert.equal(writes.filter(path=>path==='/api/media-models/local-image/install').length,0);
 assert.equal(writes.filter(path=>path==='/api/plugin-builds/local-image').length,3,'only explicit enable, retry and disable commands reach plugin control');
});

test('switching media roles withdraws a late install error even on the same Central connection',async t=>{
 const f=await fixture(t);let reject!:(error:Error)=>void;
 const pending=new Promise((_resolve,failed)=>reject=failed);
 const api={request:async(path:string,init?:RequestInit)=>{
  if(init?.method)return pending;
  return {ocr:{state:'idle',runtimeReady:false,model:{state:'not_installed',bytes:0,totalBytes:1}},'local-image':{state:'prepared',runtimeReady:false,model:{state:'ready',bytes:1,totalBytes:1}}};
 }} as Api;
 await act(async()=>f.root.render(React.createElement(MediaPreparation,{api,role:'ocr',title:'OCR'})));await act(async()=>f.button('一键安装').click());
 await act(async()=>f.root.render(React.createElement(MediaPreparation,{api,role:'local-image',title:'Generated local image'})));
 await act(async()=>reject(Error('Generated stale OCR error')));assert.doesNotMatch(f.dom.window.document.body.textContent!,/stale OCR/);assert.equal(f.button('验证并修复').disabled,false);
});

test('the ready OCR verification button consumes real preparation HTTP and restores corrupted files and worker health',async t=>{
 const f=await fixture(t),directory=await mkdtemp(join(tmpdir(),'mote-ready-repair-ui-')),prior=MEDIA_CATALOG.ocr,bytes=Buffer.from('Generated OCR repair bytes'),modelDirectory=join(directory,'models'),bundle=join(directory,'bundle');
 MEDIA_CATALOG.ocr={version:'generated-ocr-repair-ui',files:[{name:'model.bin',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),official:'https://fixture.invalid/ocr'}]};
 await mkdir(bundle);await writeFile(join(bundle,'model.bin'),bytes);
 let node:Awaited<ReturnType<typeof buildApp>>|undefined;
 const worker=createServer(async(req,response)=>{
  assert.equal(req.headers.authorization,'Bearer generated-ready-ocr-worker');
  const current=await readFile(join(modelDirectory,'ocr/model.bin'));response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({version:1,execution:'local',ocr:current.equals(bytes)}));
 });worker.listen(0,'127.0.0.1');await once(worker,'listening');const port=(worker.address() as {port:number}).port,token='generated-ready-ocr-owner';
 t.after(async()=>{await node?.app.close();worker.closeAllConnections();await new Promise<void>(resolve=>worker.close(()=>resolve()));MEDIA_CATALOG.ocr=prior;await rm(directory,{recursive:true,force:true});});
 node=await buildApp({dataDir:join(directory,'archive'),token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',configuration:{runtime:'docker'},media:{modelDirectory,python:'python3',workerToken:'generated-ready-ocr-worker',ocrEndpoint:`http://127.0.0.1:${port}/ocr`,asrEndpoint:`http://127.0.0.1:${port}/transcribe`,ocrPort:port,asrPort:port}},{backgroundWorker:false});
 const central=node;await central.featureServices.mediaAssets.importBundle('ocr',bundle);
 const before={authorization:central.modelAuthorization.view(),perception:central.perception.settings(),processing:central.processing.currentSettings()},writes:string[]=[];
 const api={request:async(path:string,init?:RequestInit)=>{
  if(init?.method)writes.push(path);
  const response=await central.app.inject({url:path,method:(init?.method??'GET') as 'GET'|'POST',headers:{authorization:'Bearer '+token},...(init?.body?{payload:JSON.parse(String(init.body))}:{})});
  assert.equal(response.statusCode,init?.method?202:200,response.body);return response.json();
 }} as Api;
 await act(async()=>f.root.render(React.createElement(MediaPreparation,{api,role:'ocr',title:'Generated OCR'})));
 await act(async()=>{await readResource(api,'/api/media-preparation',new AbortController().signal);});assert.match(f.dom.window.document.body.textContent!,/可使用/);assert.deepEqual(writes,[]);
 await writeFile(join(modelDirectory,'ocr/model.bin'),Buffer.alloc(bytes.length,1));
 await act(async()=>{
  f.button('验证并修复').click();const until=Date.now()+5000;
  for(;;){const status=await central.featureServices.mediaPreparation.status('ocr');if(status.state==='ready'&&status.runtimeReady)break;assert.ok(Date.now()<until,'actual preparation repairs files before worker health becomes ready');await new Promise(resolve=>setTimeout(resolve,5));}
 });
 await act(async()=>{resources(api).invalidate(path=>path==='/api/media-preparation');await readResource(api,'/api/media-preparation',new AbortController().signal);});
 assert.deepEqual(writes,['/api/media-preparation/ocr']);assert.deepEqual(await readFile(join(modelDirectory,'ocr/model.bin')),bytes);assert.match(f.dom.window.document.body.textContent!,/可使用/);
 assert.deepEqual({authorization:central.modelAuthorization.view(),perception:central.perception.settings(),processing:central.processing.currentSettings()},before);
});
