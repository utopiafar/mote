import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import Fastify from 'fastify';
import {PluginHost} from '@mote/plugin-host';
import {configureLocale} from '@mote/shared/i18n';
import type {MediaModelStatus,PluginBuildView} from '@mote/shared';
import {LocalImageSettings,type LocalImageSettingsProps,type LocalImageSettingsCopy} from '../src/LocalImageSettings.js';
import {MediaPreparation} from '../src/MediaPreparation.js';
import {ApiError,readApiJson,readApiError,type Api} from '../src/api.js';
import {resources,readResource} from '../src/resource-cache.js';
import {Store,StoreError} from '../../server/src/store.js';
import {ExecutionEngine} from '../../server/src/execution-engine.js';
import {GitHubPluginReleases} from '../../server/src/plugin-release.js';
import {createPluginControlPlatform,pluginControlDeclaration,type PluginCenter} from '../../server/src/plugin-center.js';
import {registerPluginControlHttp} from '../../server/src/plugins/plugin-control-http.js';
import {createLocalImageProcessing,LOCAL_IMAGE_PROCESSING_INSTANCE,localImageProcessingSelection} from '../../server/src/plugins/local-image-processing.js';
import {LOCAL_IMAGE_MODEL,localImagePluginStateSchema} from '../../server/src/local-image-contract.js';
import {MediaAssets,MEDIA_CATALOG} from '../../server/src/media-assets.js';
import {mediaModelsFeature} from '../../server/src/features/media.js';

configureLocale(()=> 'zh-CN');
// New copy is supplied by CORE-03's one i18n integration. These generated test
// labels are also the proposed source text in the external handoff.
const copy:LocalImageSettingsCopy={
    title:'本地图片解析',
    scope:'启用后，入库图片解析使用本地 InternVL3-14B-4bit，失败或忙碌时不会自动切换云端。Memory 提取、独立复核与 Ask 看原图仍使用各自所选模型，可以是云端。',
    preparationNote:'准备模型不会开启后台模型授权，也不会重新处理历史图片。',
    disabled:'关闭后，新图片沿用已配置的图片模型；原图、OCR 与已保存的理解结果继续保留。',
    ready:'本地解析已开启',waiting:'已选择本地解析，等待模型或服务就绪。',stopping:'正在停止本地解析…',unavailable:'暂时无法确认本地解析状态，请刷新。',
    reasons:{model_missing:'本地图片模型尚未准备，请在下方准备模型。',model_failed:'本地图片模型校验失败，请重新准备模型。',worker_unavailable:'本地图片服务未就绪，请重试。',worker_stop_failed:'尚未确认本地图片服务已停止，请检查运行记录。',busy:'本地图片解析忙碌，等待当前任务完成。'},
};
const control={instanceId:LOCAL_IMAGE_PROCESSING_INSTANCE,selection:localImageProcessingSelection,statePath:'/api/generated/local-image-state'};
const build=():PluginBuildView=>({id:control.instanceId,packageId:control.selection.packageId,installationId:'generated-local-image-installation',revision:1,desired:null,retired:false,observed:'stopped',blockers:[],operationId:randomUUID(),active:null,restartRequired:false,name:copy.title,version:control.selection.version,runtime:'host',allowedActions:['enable','disable']});
const model=():MediaModelStatus=>({role:'local-image',state:'not_installed',version:'generated-image-model',bytes:0,totalBytes:100,source:'generated',runtimeReady:false});
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return {promise,release};}
async function settleReads(api:Api){
    await Promise.all(['/api/plugin-builds','/api/media-models','/api/model-authorization',control.statePath].map(path=>readResource(api,path,AbortSignal.timeout(5000))));
}
async function domFixture(t:TestContext){
    const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'}),prior=new Map<string,PropertyDescriptor|undefined>();
    for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){
        prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
    }
    const {createRoot}=await import('react-dom/client');let root=createRoot(dom.window.document.getElementById('root')!),mounted=true;
    t.after(async()=>{if(mounted)await act(async()=>root.unmount());dom.window.close();for(const [key,value] of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
    const button=(label:string)=>{const node=[...dom.window.document.querySelectorAll('button')].find(node=>node.textContent===label);assert.ok(node,label);return node;};
    return {dom,button,text:()=>dom.window.document.body.textContent!,toggle:()=>dom.window.document.querySelector<HTMLButtonElement>('[role=switch]')!,
        async render(api:Api,extra:Partial<LocalImageSettingsProps>={}){await act(async()=>root.render(React.createElement(LocalImageSettings,{api,control,modelName:LOCAL_IMAGE_MODEL.id,copy,preparation:null,...extra})));await act(async()=>settleReads(api));},
        async unmount(){if(mounted)await act(async()=>root.unmount());mounted=false;},
        remount(){assert.equal(mounted,false);root=createRoot(dom.window.document.getElementById('root')!);mounted=true;},
    };
}
function unitApi(){
    const value={build:build(),model:model(),local:{enabled:false,state:'stopped',reason:undefined as string|undefined},authorization:'on',offline:false,denied:false,preparation:{state:'idle',runtimeReady:false,model:{state:'not_installed',bytes:0,totalBytes:100}}};
    const calls:{path:string;init:RequestInit}[]=[];
    let command:(intent:Record<string,unknown>)=>Promise<unknown>=async()=>({});
    const api={request:async(path:string,init:RequestInit={})=>{
        if(value.denied)throw new ApiError('Generated permission revoked',403);
        if(value.offline)throw new TypeError('Generated offline');
        if(init.method){calls.push({path,init});return command(JSON.parse(String(init.body)));}
        if(path==='/api/plugin-builds')return [structuredClone(value.build)];
        if(path==='/api/media-models')return {'local-image':structuredClone(value.model)};
        if(path===control.statePath)return structuredClone(value.local);
        if(path==='/api/model-authorization')return {authorization:{state:value.authorization}};
        if(path==='/api/media-preparation')return {'local-image':structuredClone(value.preparation)};
        throw Error('Unexpected local settings read '+path);
    }} as Api;
    return {api,value,calls,onCommand(fn:typeof command){command=fn;},async refresh(){await act(async()=>resources(api).invalidate(()=>true));}};
}

test('installed assets and an active build do not claim the image worker started; background authorization stays independent',async t=>{
    const ui=await domFixture(t),f=unitApi();
    f.value.model={...model(),state:'ready',bytes:100};f.value.build={...build(),desired:control.selection,observed:'active',active:control.selection};
    f.value.local={enabled:true,state:'waiting',reason:'model_missing'};
    await ui.render(f.api);
    assert.equal(ui.toggle().getAttribute('aria-checked'),'true');assert.ok(ui.text().includes(copy.waiting));assert.equal(ui.text().includes(copy.ready),false);
    f.value.model.runtimeReady=true;f.value.local={enabled:true,state:'ready',reason:undefined};f.value.authorization='off';await f.refresh();
    assert.ok(ui.text().includes(copy.ready));assert.match(ui.text(),/后台模型已关闭.*等待开启自动处理/);assert.doesNotMatch(ui.text(),/校验失败|服务未就绪/);
    assert.match(ui.text(),/Memory 提取、独立复核与 Ask 看原图仍使用各自所选模型，可以是云端/);
    assert.equal(ui.dom.window.document.querySelectorAll('input[type=checkbox]').length,0);assert.equal(f.calls.length,0);
});

test('local image settings reuse the preparation view for installation progress, failure, cancellation and retry without enabling processing',async t=>{
    const ui=await domFixture(t),f=unitApi();
    // Runtime props are already supported by MediaPreparation; its shared Role
    // annotation awaits CORE-03's frozen MediaRole import. This cast is confined
    // to this UI contract, never shipped in the feature or a shared entry.
    const preparation=React.createElement(MediaPreparation,{api:f.api,role:'local-image' as Parameters<typeof MediaPreparation>[0]['role'],title:'准备本地图片模型'});
    await ui.render(f.api,{preparation});
    f.onCommand(async()=>{f.value.preparation.state='models';f.value.preparation.model={state:'downloading',bytes:25,totalBytes:100};return {};});
    await act(async()=>ui.button('一键安装').click());
    assert.equal(f.calls[0].path,'/api/media-preparation/local-image');assert.match(ui.text(),/正在下载模型/);assert.equal(ui.button('安装中…').disabled,true);
    const progress=ui.dom.window.document.querySelector('progress')!;assert.equal(progress.value,25);assert.equal(progress.max,100);
    f.value.preparation.model.state='verifying';await f.refresh();assert.match(ui.text(),/正在验证模型/);
    f.value.preparation.model.state='installing';await f.refresh();assert.match(ui.text(),/正在安装模型/);
    f.onCommand(async()=>{f.value.preparation.state='cancelled';return {};});await act(async()=>ui.button('取消').click());assert.match(ui.text(),/安装已取消/);
    f.value.preparation.state='failed';await f.refresh();assert.ok(ui.button('重试'));assert.match(ui.text(),/准备未完成/);
    assert.equal(f.calls.some(call=>call.path.startsWith('/api/plugin-builds')),false);assert.equal(ui.toggle().getAttribute('aria-checked'),'false');
    await ui.unmount();assert.equal(f.calls.length,2,'unmount sends no cancel or authorization command');
});

test('stopping, missing model, busy and offline remain distinct; a revoked read withdraws stale controls',async t=>{
    const ui=await domFixture(t),f=unitApi();f.value.build={...build(),desired:control.selection,active:control.selection,observed:'active'};f.value.local={enabled:true,state:'waiting',reason:'model_missing'};
    await ui.render(f.api);assert.ok(ui.text().includes(copy.reasons.model_missing));
    f.value.local.reason='busy';await f.refresh();assert.ok(ui.text().includes(copy.reasons.busy));
    f.value.build={...f.value.build,desired:null,observed:'draining'};f.value.local={enabled:false,state:'stopped',reason:undefined};await f.refresh();
    assert.ok(ui.text().includes(copy.stopping));assert.equal(ui.toggle().disabled,true);assert.equal(ui.toggle().getAttribute('aria-checked'),'false');
    f.value.offline=true;await f.refresh();assert.ok(ui.text().includes(copy.unavailable));assert.ok(ui.dom.window.document.querySelector('[role=alert]'));assert.equal(ui.toggle().disabled,true);
    f.value.offline=false;f.value.denied=true;await f.refresh();assert.equal(ui.toggle().disabled,true);assert.equal(ui.text().includes('generated-image-model'),false);
});

test('a lost control reply retries exactly the same operation and a revision conflict refreshes without overwriting another session',async t=>{
    const ui=await domFixture(t),f=unitApi();let attempts=0;
    f.onCommand(async()=>{if(++attempts===1)throw new TypeError('Generated lost reply');throw new ApiError('Generated conflict',409);});
    await ui.render(f.api);await act(async()=>ui.toggle().click());
    assert.equal(ui.toggle().getAttribute('aria-checked'),'false','no optimistic enable');assert.equal(ui.toggle().disabled,true);
    assert.ok(ui.button('重试同一请求'));await act(async()=>ui.button('重试同一请求').click());
    assert.equal(f.calls.length,2);assert.equal(f.calls[0].init.body,f.calls[1].init.body);
    assert.match(ui.text(),/配置或方案已变化/);assert.equal(ui.dom.window.document.querySelectorAll('button').length,2);
    f.value.build.revision=9;f.onCommand(async input=>{assert.equal(input.expectedRevision,9);return {};});await f.refresh();await act(async()=>ui.toggle().click());
    assert.notEqual(JSON.parse(String(f.calls[0].init.body)).operationId,JSON.parse(String(f.calls[2].init.body)).operationId);
});

test('retrying failed shutdown keeps the selected stop instead of enabling a replacement worker',async t=>{
    const ui=await domFixture(t),f=unitApi();f.value.build={...build(),observed:'blocked',blockers:['worker_stop_failed']};
    await ui.render(f.api);assert.match(ui.text(),/处理失败/);assert.ok(ui.text().includes(copy.reasons.worker_stop_failed));
    await act(async()=>ui.button('重试').click());
    assert.equal(f.calls.length,1);assert.equal(JSON.parse(String(f.calls[0].init.body)).selection,null);assert.equal(ui.toggle().getAttribute('aria-checked'),'false');
});

test('unmount or owner change does not abort an accepted command or let its late receipt change another node',async t=>{
    const ui=await domFixture(t),first=unitApi(),next=unitApi(),held=gate();t.after(()=>held.release());
    first.onCommand(async()=>{await held.promise;first.value.build.desired=control.selection;return {};});
    await ui.render(first.api);await act(async()=>ui.toggle().click());
    await ui.render(next.api);await act(async()=>held.release());
    assert.equal(ui.toggle().getAttribute('aria-checked'),'false');assert.equal(next.calls.length,0);
    assert.equal(first.calls[0].init.signal,undefined,'page lifetime never owns the persistent command');
    assert.equal(ui.text().includes('请求已登记'),false);
});

/** Actual PluginHost/PluginCenter, private SQLite, asset verification and public
 * route serializers feed the real UI. Only worker lifecycle/model bytes and
 * the future CORE-03 state-route mount are generated boundaries. */
test('real plugin and asset producers drive missing-model recovery, stop drainage and persisted disable in the settings consumer',async t=>{
    const directory=await mkdtemp(join(tmpdir(),'mote-image-settings-contract-')),prior=MEDIA_CATALOG['local-image'];
    const bytes=Buffer.from('Generated local image asset; never model weights.');
    MEDIA_CATALOG['local-image']={version:'generated-settings-v1',files:[{name:'model.bin',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),official:'https://example.invalid/generated-model'}]};
    const assets=new MediaAssets(join(directory,'models')),store=new Store(join(directory,'store')),executor=new ExecutionEngine(store),host=new PluginHost({kind:'central',id:randomUUID()});
    let center:PluginCenter|undefined,running=false,failStart=false,stopGate:ReturnType<typeof gate>|undefined,ui:Awaited<ReturnType<typeof domFixture>>|undefined;
    let stopStarted=gate();
    const local=createLocalImageProcessing({desired:()=>center?.control.build(control.instanceId)?.desired,modelStatus:async()=>({...assets.status('local-image'),runtimeReady:running}),createWorker:()=>({prepare(){if(failStart)throw Error('Generated startup failure');},start(){running=true;},quiesce(){},async stop(){stopStarted.release();await stopGate?.promise;running=false;},dispose(){running=false;}})});
    const platform=createPluginControlPlatform({store,executor,host,releases:new GitHubPluginReleases(join(directory,'releases'))},[local.build]);
    const handle=await host.install({identity:{host:host.identity,packageId:'mote.plugin-control',installationId:'generated-control',instanceId:'control',activationId:randomUUID()},contributions:[pluginControlDeclaration],factory:platform.factory});
    const app=Fastify(),serverErrors:Error[]=[];
    t.after(async()=>{await ui?.unmount();stopGate?.release();await app.close();await handle.close('shutdown');await host.close();await executor.close();store.close();await assets.close();MEDIA_CATALOG['local-image']=prior;await rm(directory,{recursive:true,force:true});});
    center=platform.assembly;
    // CORE-03 seeds the optional registered build's existing stopped record.
    center.control.saveBuild({id:control.instanceId,packageId:control.selection.packageId,version:control.selection.version,installationId:randomUUID(),revision:1,desired:null,retired:false,observed:'stopped',blockers:[],operationId:randomUUID()});
    await platform.startBuilds();
    const owner=(request:{headers:{authorization?:string}})=>{if(request.headers.authorization!=='Bearer generated-image-settings-owner')throw new StoreError('Owner required',401);};
    app.setErrorHandler((error,_request,reply)=>{serverErrors.push(error);return reply.code(error instanceof StoreError?error.statusCode:500).send({error:error.message});});
    app.addHook('onRequest',async request=>owner(request));
    registerPluginControlHttp(app,{plugins:center,bindings:{} as never,automation:{} as never,owner});
    await mediaModelsFeature({mediaAssets:assets,runtimeStatus:async role=>({runtimeReady:role==='local-image'&&running})}).mount(app);
    // Test-only mount of the production state serializer, not a product route
    // introduced by IMG-07. The statePath prop lets CORE-03 choose its own URL.
    const states:unknown[]=[];
    app.get(control.statePath,()=>{const state=localImagePluginStateSchema.parse(local.port.state());states.push(state);return state;});
    app.get('/api/model-authorization',()=>({authorization:{state:'off'}}));
    await app.ready();
    const calls:{path:string;init:RequestInit}[]=[],writes=new Set<Promise<unknown>>(),api={request:async<T>(path:string,init:RequestInit={})=>{
        calls.push({path,init});
        const responsePromise=app.inject({url:path,method:(init.method??'GET') as 'GET'|'PATCH',headers:{authorization:'Bearer generated-image-settings-owner',...(init.body?{'content-type':'application/json'}:{})},...(init.body?{payload:String(init.body)}:{})});
        if(init.method)writes.add(responsePromise);
        const response=await responsePromise;writes.delete(responsePromise);
        const wire=new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
        if(!wire.ok)throw await readApiError(wire);return readApiJson<T>(wire);
    }} as Api;
    ui=await domFixture(t);await ui.render(api);
    const command=async(label?:string)=>{await act(async()=>{(label?ui!.button(label):ui!.toggle()).click();await new Promise<void>(resolve=>setImmediate(resolve));await Promise.all([...writes]);});await act(async()=>settleReads(api));};
    assert.equal(ui.toggle().getAttribute('aria-checked'),'false');assert.equal(running,false);
    assert.equal(ui.toggle().disabled,false,ui.text());
    await command();
    assert.deepEqual(serverErrors,[]);
    assert.equal(center.control.build(control.instanceId)?.desired?.packageId,control.selection.packageId,ui.text());assert.equal(running,false);assert.ok(ui.text().includes(copy.waiting));assert.ok(ui.text().includes(copy.reasons.model_missing));
    const bundle=join(directory,'bundle');await mkdir(bundle);await writeFile(join(bundle,'model.bin'),Buffer.alloc(bytes.length));
    await assert.rejects(assets.importBundle('local-image',bundle));
    await command('重试');assert.ok(ui.text().includes(copy.reasons.model_failed));
    await writeFile(join(bundle,'model.bin'),bytes);await assets.importBundle('local-image',bundle);failStart=true;
    await command('重试');assert.ok(ui.text().includes(copy.reasons.worker_unavailable));assert.equal(running,false);
    failStart=false;await command('重试');assert.ok(ui.text().includes(copy.ready));assert.equal(running,true);
    assert.match(ui.text(),/后台模型已关闭/,'ready worker does not enable background processing');
    stopStarted=gate();stopGate=gate();await act(async()=>{ui!.toggle().click();await stopStarted.promise;});
    assert.equal(center.control.build(control.instanceId)?.desired,null);assert.equal(running,true,'stop waits for the worker boundary');
    await act(async()=>{resources(api).invalidate(()=>true);await settleReads(api);});assert.ok(ui.text().includes(copy.stopping));
    await ui.unmount();stopGate.release();await Promise.all([...writes]);
    // Re-open the persisted control store rather than reusing a hand-written
    // stopped fixture. The production control projects the same durable row.
    const {PluginControlStore}=await import('../../server/src/plugins/plugin-control-store.js');
    const reopened=new Store(join(directory,'store'));
    try{assert.equal(new PluginControlStore(reopened).build(control.instanceId)?.desired,null);}finally{reopened.close();}
    ui.remount();await ui.render(api);assert.equal(ui.toggle().getAttribute('aria-checked'),'false');assert.match(ui.text(),/已关闭/);assert.equal(running,false);assert.equal(assets.ready('local-image'),true);
    assert.ok(states.some(state=>(state as {state:string}).state==='waiting'));assert.ok(states.some(state=>(state as {state:string}).state==='failed'));assert.ok(states.some(state=>(state as {state:string}).state==='ready'));
    assert.ok(calls.filter(call=>call.init.method).every(call=>call.path==='/api/plugin-builds/'+control.instanceId));
    t.diagnostic('IMG07_INTERFACE '+JSON.stringify({states,model:assets.status('local-image'),build:center.buildView(control.instanceId)}));
});
