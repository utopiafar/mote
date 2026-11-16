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
import {mediaModelsViewSchema} from '@mote/shared';
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

test('local-image preparation consumes real model HTTP and installs verified assets without enabling a plugin or starting inference',async t=>{
 const f=await fixture(t),directory=await mkdtemp(join(tmpdir(),'mote-media-preparation-ui-')),prior=MEDIA_CATALOG['local-image'],bytes=Buffer.from('Generated optional image asset');
 const worker=createServer((_request,response)=>response.writeHead(200,{'content-length':bytes.length}).end(bytes));worker.listen(0,'127.0.0.1');await once(worker,'listening');
 const endpoint=`http://127.0.0.1:${(worker.address() as {port:number}).port}`,originalFetch=fetch;
 MEDIA_CATALOG['local-image']={version:'generated-image-ui',files:[{name:'component/model.bin',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),official:'https://generated-core03.invalid/model'}]};
 t.mock.method(globalThis,'fetch',(input:Parameters<typeof fetch>[0],init?:RequestInit)=>String(input).startsWith('https://generated-core03.invalid/')?originalFetch(endpoint,init):originalFetch(input,init));
 const token='generated-core03-media-ui-owner-token';
 const node=await buildApp({dataDir:join(directory,'data'),token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'},{backgroundWorker:false});
 t.after(async()=>{await node.app.close();worker.closeAllConnections();await new Promise<void>(resolve=>worker.close(()=>resolve()));MEDIA_CATALOG['local-image']=prior;await rm(directory,{recursive:true,force:true});});
 const writes:string[]=[],before={authorization:node.modelAuthorization.view(),models:node.modelSettings.view(),perception:node.perception.settings(),processing:node.processing.currentSettings()};
 const api={request:async(path:string,init?:RequestInit)=>{
  if(init?.method)writes.push(path);
  const response=await node.app.inject({url:path,method:(init?.method??'GET') as 'GET'|'POST',headers:{authorization:'Bearer '+token},...(init?.body?{payload:JSON.parse(String(init.body))}:{})});
  assert.equal(response.statusCode,init?.method?202:200,response.body);return path==='/api/media-models'?mediaModelsViewSchema.parse(JSON.parse(response.body)):response.json();
 }} as Api;
 await act(async()=>f.root.render(React.createElement(MediaPreparation,{api,role:'local-image',title:'Generated local image'})));assert.deepEqual(writes,[]);
 await act(async()=>{
  f.button('一键安装').click();
  const until=Date.now()+5000;while(node.featureServices.mediaAssets.status('local-image').state!=='ready'){assert.ok(Date.now()<until,'generated asset download completes');await new Promise(resolve=>setTimeout(resolve,5));}
 });
 await act(async()=>resources(api).invalidate(path=>path==='/api/media-models'));
 assert.match(f.dom.window.document.body.textContent!,/模型已安装/);assert.doesNotMatch(f.dom.window.document.body.textContent!,/可使用/);assert.match(f.dom.window.document.body.textContent!,/安装模型不会启用本地识图/);
 const installed=join(node.featureServices.mediaAssets.path('local-image'),'component/model.bin');await writeFile(installed,Buffer.alloc(bytes.length,1));
 assert.equal(node.featureServices.mediaAssets.ready('local-image'),true,'normal image status delegates same-size corruption to the strict worker');
 await act(async()=>{
  f.button('验证并修复').click();
  const until=Date.now()+5000;while(!(await readFile(installed)).equals(bytes)||node.featureServices.mediaAssets.status('local-image').state!=='ready'){assert.ok(Date.now()<until,'explicit asset repair completes');await new Promise(resolve=>setTimeout(resolve,5));}
 });
 assert.deepEqual(writes,['/api/media-models/local-image/install','/api/media-models/local-image/install']);assert.deepEqual(await readFile(installed),bytes);
 assert.deepEqual(await node.featureServices.mediaAssets.status('local-image').state,'ready');
 assert.deepEqual({authorization:node.modelAuthorization.view(),models:node.modelSettings.view(),perception:node.perception.settings(),processing:node.processing.currentSettings()},before);
 assert.equal((await node.featureServices.mediaPreparation.status('local-image')).runtimeReady,false);
});

test('switching media roles withdraws a late install error even on the same Central connection',async t=>{
 const f=await fixture(t);let reject!:(error:Error)=>void;
 const pending=new Promise((_resolve,failed)=>reject=failed);
 const api={request:async(path:string,init?:RequestInit)=>{
  if(init?.method)return pending;
  return path==='/api/media-models'?{'local-image':{role:'local-image',state:'ready',runtimeReady:false,bytes:1,totalBytes:1}}:{ocr:{state:'idle',runtimeReady:false,model:{state:'not_installed',bytes:0,totalBytes:1}}};
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
