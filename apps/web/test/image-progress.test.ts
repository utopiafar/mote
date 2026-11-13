import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {ImageProgress} from '../src/ImageProgress.js';
import {readApiJson,readApiError,type Api} from '../src/api.js';
import {resources,readResource} from '../src/resource-cache.js';

configureLocale(()=> 'zh-CN');
async function fixture(t:TestContext){
    const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'}),prior=new Map<string,PropertyDescriptor|undefined>();
    for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){
        prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
    }
    const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!);
    t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,value] of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
    const phase=(name:string)=>{const dt=[...dom.window.document.querySelectorAll('dt')].find(node=>node.textContent===name);assert.ok(dt,name);return dt.nextElementSibling!.textContent;};
    const button=(name:string)=>{const node=[...dom.window.document.querySelectorAll('button')].find(node=>node.textContent===name);assert.ok(node,name);return node;};
    return {dom,root,phase,button};
}
const detail=()=>({original:{state:'ready'},automatic:false,understandingEnabled:true,wait:null as 'running'|'unknown'|null,jobs:[{name:'ocr',state:'succeeded',error:undefined as string|undefined},{name:'understanding',state:'running',error:undefined as string|undefined}],products:[{id:'generated-ocr',name:'ocr',kind:'ocr',text:'',generatedAt:'2026-11-01T00:00:00Z'}],materials:[{id:'generated-material',state:'pending'}],memory:[{state:'not_scheduled',count:0,error:undefined as string|undefined}]});

test('a manual image retry shows its actual running or busy step while original, empty OCR, index and Memory remain independent',async t=>{
    const f=await fixture(t),value=detail(),api={request:async()=>structuredClone(value)} as Api;
    await act(async()=>f.root.render(React.createElement(ImageProgress,{api,id:'generated-image'})));
    assert.equal(f.phase('原件'),'已就绪');assert.equal(f.phase('文字识别'),'已就绪');assert.equal(f.phase('内容理解'),'处理中');assert.equal(f.phase('资料索引'),'等待处理');assert.equal(f.phase('记忆（Memory）'),'未安排');
    value.jobs[1]={name:'understanding',state:'waiting',error:'rate_limited'};
    await act(async()=>resources(api).invalidate(()=>true));
    assert.equal(f.phase('内容理解'),'等待处理');assert.match(f.dom.window.document.body.textContent!,/限流/);
    value.memory=[{state:'failed',count:0,error:'memory_input_failed'}];
    await act(async()=>resources(api).invalidate(()=>true));
    assert.equal(f.phase('资料索引'),'等待处理');assert.equal(f.phase('记忆（Memory）'),'处理失败');assert.match(f.dom.window.document.body.textContent!,/所需资料处理失败/);
});

test('a failed refresh cannot leave stale image retry controls enabled',async t=>{
    const f=await fixture(t);let offline=false;
    const api={request:async()=>{if(offline)throw new TypeError('Generated offline');return detail();}} as Api;
    await act(async()=>f.root.render(React.createElement(ImageProgress,{api,id:'generated-image'})));
    offline=true;await act(async()=>resources(api).invalidate(()=>true));
    assert.ok(f.dom.window.document.querySelector('[role=alert]'));assert.equal(f.button('补齐未完成步骤').disabled,true);assert.equal(f.button('重新计算已有结果').disabled,true);assert.ok(f.button('刷新'));
});

test('unknown-result confirmation is scoped to one image and late commands do not refresh a different image',async t=>{
    const f=await fixture(t);let release!:()=>void;
    const held=new Promise<void>(resolve=>release=resolve),calls:string[]=[];
    const api={request:async(path:string,init?:RequestInit)=>{calls.push(path);if(init?.method){await held;return {};}return {...detail(),wait:'unknown'};}} as Api;
    t.after(()=>release());
    await act(async()=>f.root.render(React.createElement(ImageProgress,{api,id:'generated-a'})));
    assert.equal(f.button('补齐未完成步骤').disabled,true);
    await act(async()=>f.dom.window.document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
    await act(async()=>f.button('补齐未完成步骤').click());
    await act(async()=>f.root.render(React.createElement(ImageProgress,{api,id:'generated-b'})));
    assert.equal(f.button('补齐未完成步骤').disabled,true,'confirmation for A cannot authorize B');
    const before=calls.filter(path=>path==='/api/images/generated-b').length;
    await act(async()=>release());
    assert.equal(calls.filter(path=>path==='/api/images/generated-b').length,before);
    assert.equal(f.button('补齐未完成步骤').disabled,true,'finishing A must not carry its confirmation into B');
});

test('retained interpretation stays readable while recomputation reports its own running or failed state',async t=>{
    const f=await fixture(t),value=detail(),api={request:async()=>structuredClone(value)} as Api;
    value.products.push({id:'generated-understanding',name:'understanding',kind:'understanding',text:'Generated retained interpretation',generatedAt:'2026-11-01T00:00:00Z'});
    await act(async()=>f.root.render(React.createElement(ImageProgress,{api,id:'generated-image'})));
    assert.equal(f.phase('内容理解'),'已就绪 · 处理中');assert.match(f.dom.window.document.body.textContent!,/Generated retained interpretation/);
    value.jobs[1]={name:'understanding',state:'failed',error:'image_processing_failed'};await act(async()=>resources(api).invalidate(()=>true));
    assert.equal(f.phase('内容理解'),'已就绪 · 处理失败');assert.equal(f.phase('文字识别'),'已就绪');assert.match(f.dom.window.document.body.textContent!,/以下为模型解释，原图与 OCR 是原始证据/);
});

test('image authorization waits, unavailable workers and invalid outputs explain the actual recovery cause',async t=>{
    const f=await fixture(t),value=detail(),api={request:async()=>structuredClone(value)} as Api;
    value.jobs[1]={name:'understanding',state:'blocked',error:'background_model_authorization_required'};
    await act(async()=>f.root.render(React.createElement(ImageProgress,{api,id:'generated-image'})));
    assert.match(f.dom.window.document.querySelector('.discovery-step-reason')!.textContent!,/等待开启自动处理/);assert.doesNotMatch(f.dom.window.document.querySelector('.discovery-step-reason')!.textContent!,/校验失败|模型服务未完成/);
    value.jobs[1].error='image_worker_unavailable';await act(async()=>resources(api).invalidate(()=>true));
    assert.match(f.dom.window.document.querySelector('.discovery-step-reason')!.textContent!,/本机处理未能启动，请重试/);assert.ok(f.dom.window.document.querySelector('a[href="#/system/models?category=images"]'));
    value.jobs[1].error='invalid_image_region';value.jobs[1].state='failed';await act(async()=>resources(api).invalidate(()=>true));
    assert.match(f.dom.window.document.querySelector('.discovery-step-reason')!.textContent!,/模型返回的结果未通过校验/);assert.equal(f.phase('原件'),'已就绪');assert.equal(f.phase('文字识别'),'已就绪');
});

test('real archived image HTTP remains consumable in the existing detail reader with original opening and Ask available before understanding',async t=>{
    const f=await fixture(t),{mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{createHash}=await import('node:crypto');
    const {buildApp}=await import('../../server/src/app.js'),{default:sharp}=await import('sharp'),{FileDetail}=await import('../src/plugins/intake/Files.js'),{webFeatures}=await import('../src/features/registry.js');
    const directory=await mkdtemp(join(tmpdir(),'mote-image-progress-consumer-')),token='generated-image-progress-owner',sourceId='generated-progress-images';
    const node=await buildApp({dataDir:directory,token,tokenPath:'generated-only',host:'127.0.0.1',port:0,maxStorageBytes:20e6,maxExportBytes:1e6,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',diagnosticsEnabled:false},{backgroundWorker:false,agent:{configured:false,close:async()=>{},query:async()=>{throw Error('No model belongs in the image detail navigation contract');}}});
    t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
    node.sources.register({id:sourceId,name:'Generated image progress',kind:'upload',deviceId:'generated-image-device',platform:'import',retention:'archive'});
    const bytes=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="red"/></svg>')).png().toBuffer(),headers={authorization:'Bearer '+token};
    const upload=await node.app.inject({method:'POST',url:'/api/file-sync/v1/uploads',headers,payload:{sourceId,item:{externalId:'generated-progress.png',revision:'1',observedAt:'2026-11-01T00:00:00Z',kind:'file',layer:'original',mimeType:'image/png',title:'Generated progress image',text:''},sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length}});
    assert.equal(upload.statusCode,200,upload.body);
    const part=await node.app.inject({method:'PUT',url:'/api/file-sync/v1/uploads/'+upload.json().uploadId+'/parts/0',headers:{...headers,'content-type':'application/octet-stream'},payload:bytes});assert.equal(part.statusCode,200,part.body);
    const commit=await node.app.inject({method:'POST',url:'/api/file-sync/v1/uploads/'+upload.json().uploadId+'/commit',headers,payload:{}});assert.equal(commit.statusCode,200,commit.body);const id=String(commit.json().id);
    const navigation=await webFeatures.install({id:'generated-image-progress-navigation',version:'1',components:[]},[
        ...['ask','archive','search'].map(id=>({surface:'page' as const,entry:{id,route:id==='archive'?'library':id,featureId:'generated-image-progress-navigation',render:()=>null}})),
        {surface:'collection',entry:{id:'files',label:'Generated files',featureId:'generated-image-progress-navigation',order:0,render:()=>null}},
    ]);t.after(()=>navigation.dispose());
    let playbackCookie:string|undefined;
    const api={request:async<T>(path:string,init:RequestInit={})=>{
        const response=await node.app.inject({url:path,method:(init.method??'GET') as 'GET'|'POST',headers:{...headers,...(init.body?{'content-type':'application/json'}:{})},...(init.body?{payload:String(init.body)}:{})});
        if(path.endsWith('/playback'))playbackCookie=String(response.headers['set-cookie']).split(';')[0];
        const wire=new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});if(!wire.ok)throw await readApiError(wire);return readApiJson<T>(wire);
    }} as Api;
    await act(async()=>f.root.render(React.createElement(FileDetail,{api,id,onOpen:()=>{}})));
    await act(async()=>{await Promise.all(['/api/files/'+id,'/api/files/'+id+'/view','/api/images/'+id,'/api/features'].map(path=>readResource(api,path,AbortSignal.timeout(5000))));});
    assert.equal(f.phase('原件'),'已就绪');assert.equal(f.dom.window.document.querySelector('.image-progress')!==null,true);
    assert.equal(f.button('查看原图').disabled,false);assert.equal(f.button('问文件').disabled,false);
    await act(async()=>{f.button('查看原图').click();await new Promise<void>(resolve=>setImmediate(resolve));});
    assert.equal(f.dom.window.document.querySelector('img')?.getAttribute('src'),'/api/files/'+id+'/content');
    const original=await node.app.inject({url:'/api/files/'+id+'/content',headers:{cookie:playbackCookie}});assert.equal(original.statusCode,200,original.body);assert.deepEqual(original.rawPayload,bytes);
    await act(async()=>f.button('问文件').click());assert.equal(new URLSearchParams(f.dom.window.location.hash.split('?')[1]).get('fromCapture'),id);
});
