import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale,getLocale} from '@mote/shared/i18n';
import {ManualMemoryWorkspace,type MemoryWorkLaunch} from '../src/plugins/memory/index';
import {MemoryDetailPage,Memories} from '../src/plugins/memory/index';
import {MemoryWorkChoices} from '../src/plugins/memory/index';
import type {MemoryJob} from '../src/plugins/memory/index';
import {ApiError,type Api} from '../src/api';
import {resources} from '../src/resource-cache';
import {useResource} from '../src/useResource';
import {modelView} from './fixtures/model-settings';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',at='2026-10-29T00:00:00.000Z',recipe={id:'mote.personal-memory',version:'2'};
const choice={kind:'capture' as const,ref:'capture:'+id,title:'Generated original',revision:'pin-one'};
const memory=(id:string)=>({id,title:'Generated Memory '+id[0],statement:'Complete generated statement '+id[0],uncertainty:'Generated only',status:'published',version:1,fingerprint:id[0].repeat(64),createdAt:at,evidence:[],evidenceIds:[],admission:{layer:'memory'}});
const job=(id:string,status:MemoryJob['status']='cancelled'):MemoryJob=>({id,status,createdAt:at,updatedAt:at,evidenceIds:[id],totalBatches:1,completedBatches:0,failedBatches:0,skippedChunks:0,memoryIds:[],memoryCount:0,skillVersion:'fixture',inputPlans:{total:1,waiting:0,blocked:1,stale:0,completed:0},recipeProgress:[]});
async function fixture(t:import('node:test').TestContext){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/search?q=generated',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>(),locale=getLocale();configureLocale(()=> 'zh-CN');
 for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});}
 Object.assign(dom.window.HTMLElement.prototype,{scrollIntoView:()=>{},attachEvent:()=>{},detachEvent:()=>{}});dom.window.scrollTo=()=>{};
 const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());configureLocale(()=>locale);for(const[key,value]of prior)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);dom.window.close();});return{root,d:dom.window.document};
}
type Seen={path:string;method:string;body?:string};
function owner(override:(path:string,init?:RequestInit)=>unknown=()=>undefined,seen:Seen[]=[]):Api{return{request:async(path:string,init?:RequestInit)=>{
 seen.push({path,method:init?.method??'GET',body:init?.body as string|undefined});const result=override(path,init);if(result!==undefined)return result;
 if(path==='/api/model-settings')return modelView();
 if(path==='/api/memory-settings')return{settings:{consolidation:{enabled:false,maxItems:5}},extensions:[]};
 if(path==='/api/memory-recipes')return{items:[{...recipe,available:true}]};
 if(path==='/api/memory-integration-recipes')return{items:[{id:'mote.memory-integration',version:'1',available:true}]};
 if(path.startsWith('/api/capture-browser/'))return{id,source:'note',text:'Complete literal original',libraryVersion:'pin-one'};
 if(/^\/api\/memory-jobs\/[^/?]+$/.test(path))return job(path.split('/').at(-1)!);
 if(/^\/api\/memories\/[^/?]+/.test(path))return memory(path.split('/')[3].split('?')[0]);
 if(path==='/api/execution-settings')return{queues:{agents:{active:0,waiting:0,limit:1},llm:{active:0,waiting:0,limit:1}}};
 return{items:[],nextCursor:null,ids:[],cursor:0,hasMore:false,reset:false};
 }} as Api;}
async function click(d:Document,label:string,scope:ParentNode=d){await act(async()=>{const button=[...scope.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===label&&!button.closest('[hidden]'));assert.ok(button,'button '+label);assert.equal(button.disabled,false,'enabled '+label);button.click();});}
const props=(api:Api,launch:Partial<MemoryWorkLaunch>={})=>({api,launch:{api,token:1,kind:'extract' as const,choice,...launch},range:{deviceId:'generated-device',after:at,before:at},onClose:()=>{},onOpen:()=>{},onViewMemory:()=>{}});
test('own cancelled extraction retries as a new admission with its exact frozen body, retaining old results',async t=>{
 const{root,d}=await fixture(t),seen:Seen[]=[];let count=0;const api=owner((path,init)=>path==='/api/memory-jobs'&&init?.method==='POST'?{id:++count===1?'cancelled-old':'queued-new'}:path.endsWith('/queued-new')?job('queued-new','queued'):undefined,seen);
 await act(async()=>root.render(React.createElement(ManualMemoryWorkspace,props(api))));const options=d.querySelector<HTMLDetailsElement>('.memory-work-scope .memory-processing-options')!;assert.equal(options.open,false);
 await act(async()=>options.querySelector('summary')!.click());await act(async()=>d.querySelector<HTMLInputElement>('.manual-memory-recipes input')!.click());await act(async()=>options.querySelector('summary')!.click());
 await click(d,'开始提取');assert.match(d.querySelector('.memory-work-job')!.textContent!,/已取消任务和已有成果保留/);await click(d,'重试');const writes=seen.filter(read=>read.method==='POST');assert.equal(writes.length,2);assert.equal(writes[0].body,writes[1].body);assert.deepEqual(JSON.parse(writes[1].body!).recipes,[recipe]);assert.deepEqual(JSON.parse(writes[1].body!).evidenceIds,[id]);assert.equal(writes.some(read=>read.path.endsWith('/retry')),false);assert.match(d.querySelector('.memory-work-job')!.textContent!,/queued-new/);
});
for(const failure of ['pin','revoked','model'] as const)test('cancelled retry does not write after '+failure+' changes',async t=>{
 const{root,d}=await fixture(t),seen:Seen[]=[];let changed=false;const api=owner((path,init)=>{if(path==='/api/memory-jobs'&&init?.method==='POST')return{id:'cancelled-old'};if(changed&&path.startsWith('/api/capture-browser/')){if(failure==='revoked')throw new ApiError('generated forbidden',403);if(failure==='pin')return{id,libraryVersion:'pin-two'};}if(changed&&failure==='model'&&path==='/api/model-settings'){const view=modelView();view.profiles[0].settings.model='changed-model';return view;}},seen);
 await act(async()=>root.render(React.createElement(ManualMemoryWorkspace,props(api))));await click(d,'开始提取');changed=true;await click(d,'重试');assert.equal(seen.filter(read=>read.method==='POST').length,1);assert.match(d.querySelector('.memory-work-job')!.textContent!,/cancelled-old/);assert.equal(Boolean(d.querySelector('[role="alert"]')),true);assert.equal(seen.some(read=>read.path.endsWith('/retry')),false);
});
test('an adopted cancelled job cannot reconstruct or offer a new admission retry',async t=>{
 const{root,d}=await fixture(t),seen:Seen[]=[],api=owner(undefined,seen);await act(async()=>root.render(React.createElement(ManualMemoryWorkspace,props(api,{kind:'current',choice:undefined,jobId:'adopted'}))));assert.equal([...d.querySelectorAll('button')].some(button=>button.textContent==='重试'),false);assert.match(d.querySelector('.memory-work-scope-details')!.textContent!,/未记录/);await click(d,'← 返回');assert.equal(Boolean(d.querySelector('.memory-work-choices')),true);assert.equal(seen.some(read=>read.method==='POST'),false);
});
test('back navigation during source revalidation and owner changes cannot admit or display a late task',async t=>{
 const{root,d}=await fixture(t),seen:Seen[]=[];let resolve!:(value:unknown)=>void,reads=0;const api=owner(path=>path.startsWith('/api/capture-browser/')&&++reads===2?new Promise(done=>resolve=done):undefined,seen),next=owner();
 await act(async()=>root.render(React.createElement(ManualMemoryWorkspace,props(api))));await click(d,'开始提取');await click(d,'← 返回');await act(async()=>resolve({id,libraryVersion:'pin-one'}));assert.equal(seen.some(read=>read.method==='POST'),false);
 reads=1;await act(async()=>root.render(React.createElement(ManualMemoryWorkspace,props(api,{token:2}))));await click(d,'开始提取');await act(async()=>root.render(React.createElement(ManualMemoryWorkspace,props(next,{token:3,choice:undefined}))));await act(async()=>resolve({id,libraryVersion:'pin-one'}));assert.equal(seen.some(read=>read.method==='POST'),false);assert.equal(Boolean(d.querySelector('.memory-work-job')),false);
});
test('choosing date scope after an original returns to date inputs rather than retaining the original',async t=>{
 const{root,d}=await fixture(t),api=owner();await act(async()=>root.render(React.createElement(ManualMemoryWorkspace,props(api))));await click(d,'← 返回');await click(d,'按时间范围提取');assert.equal(d.querySelectorAll('input[type="date"]').length,2);assert.equal(Boolean(d.querySelector('.memory-work-scope-notice')),false);
});
test('Search Memory More opens the real integration scope without POST and returns to the same detail before Search',async t=>{
 const{root,d}=await fixture(t),seen:Seen[]=[],api=owner(undefined,seen);let back=0;await act(async()=>root.render(React.createElement(MemoryDetailPage,{api,id,onOpen:()=>{},onBack:()=>back++})));await click(d,'更多');await click(d,'从这条记忆开始整理');assert.match(d.querySelector('.memory-workspace-final h1')!.textContent!,/整理这条记忆/);assert.match(d.querySelector('.memory-integration-workspace')!.textContent!,/Generated Memory a/);assert.equal(d.querySelector<HTMLDetailsElement>('.memory-integration-workspace .memory-processing-options')!.open,false);assert.equal(Boolean(d.querySelector('.memory-integration-workspace a[href="#/system/models"]')?.closest('details')),true);assert.equal(seen.some(read=>read.method==='POST'),false);await click(d,'← 返回');assert.equal(d.querySelector('.memory-detail-heading h2')?.textContent,'Generated Memory a');assert.equal(back,0);await click(d,'返回');await click(d,'返回');assert.equal(back,1);assert.equal(window.location.hash,'#/search?q=generated');
});
test('chooser 503 preserves its cursor page, 409 withdraws it, and a new device never receives the old cursor',async t=>{
 const{root,d}=await fixture(t),seen:Seen[]=[];let status=0;const api=owner(path=>{if(path.startsWith('/api/library/browse?')){if(status)throw new ApiError('generated failure',status);return{items:[{entryType:'capture',ref:'capture:'+id,revision:'pin-one',contentAt:at,capture:{windowTitle:'Generated chooser'}}],nextCursor:'cursor-A'};}},seen);
 const render=(deviceId:string)=>act(async()=>root.render(React.createElement(MemoryWorkChoices,{api,kind:'extract',deviceId,onMaterial:()=>{},onMemory:()=>{}})));await render('A');await click(d,'下一页');const path=seen.at(-1)!.path;status=503;await act(async()=>resources(api).invalidate(key=>key===path));assert.match(d.querySelector('.memory-work-choice-list')!.textContent!,/Generated chooser/);status=409;await click(d,'重新读取');assert.equal(Boolean(d.querySelector('.memory-work-choice-list button')),false);status=0;await render('B');assert.equal(seen.filter(read=>read.path.includes('deviceId=B')).every(read=>!read.path.includes('cursor=')),true);assert.match(d.querySelector('.memory-work-choice-list')!.textContent!,/Generated chooser/);
});
test('a completed integration opened from Search returns to the selected Memory and never invents a result route',async t=>{
 const{root,d}=await fixture(t),seen:Seen[]=[];let completed=false,back=0;const api=owner((path,init)=>{
  if(path==='/api/memory-integrations'&&init?.method==='POST'){completed=true;return{id:'generated-integration'};}
  if(path==='/api/memory-settings')return{settings:{consolidation:{enabled:false,maxItems:5}},extensions:[{id:'consolidation',status:'waiting_for_increment',failures:0,...(completed?{lastRun:{id:'generated-integration',completedAt:Date.parse(at)}}:{})}]};
 },seen);
 await act(async()=>root.render(React.createElement(MemoryDetailPage,{api,id,onOpen:()=>{},onBack:()=>back++})));await click(d,'更多');await click(d,'从这条记忆开始整理');await click(d,'开始整理');assert.match(d.querySelector('.memory-integration-workspace')!.textContent!,/本次手动整理已完成.*零条新记忆也是有效结果/);assert.equal(seen.filter(read=>read.method==='POST').length,1);await click(d,'← 返回');assert.equal(d.querySelector('.memory-detail-heading h2')?.textContent,'Generated Memory a');assert.equal(back,0);assert.equal(window.location.hash,'#/search?q=generated');
});

test('a selected capture without a current opaque pin stays disabled and cannot admit a request',async t=>{
 const{root,d}=await fixture(t),seen:Seen[]=[],api=owner(path=>path.startsWith('/api/capture-browser/')?{id,source:'note',windowTitle:'Generated missing pin',ocrText:'Literal generated text'}:undefined,seen);
 await act(async()=>root.render(React.createElement(ManualMemoryWorkspace,props(api))));const button=[...d.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='开始提取')!;assert.equal(button.disabled,true);await act(async()=>button.click());assert.equal(seen.some(read=>read.method==='POST'),false);
});
test('a hidden integration view never polls memory settings and resumes exactly while visible',async t=>{
 const{root,d}=await fixture(t);t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const seen:Seen[]=[],api=owner(undefined,seen),reads=()=>seen.filter(read=>read.path==='/api/memory-settings'&&read.method==='GET').length;
 await act(async()=>root.render(React.createElement(ManualMemoryWorkspace,props(api,{kind:'integrate'}))));
 assert.equal(reads(),0,'a hidden integration cannot initiate even its first settings read');
 await act(async()=>resources(api).invalidate(path=>path==='/api/memory-settings'));
 for(let step=0;step<20;step++)await act(async()=>t.mock.timers.tick(3000));
 assert.equal(reads(),0,'hidden subscriptions cannot read on invalidation or over sixty seconds');
 await click(d,'查看最近的处理');assert.equal(reads(),1,'activation reads immediately');const visible=reads();
 for(let step=0;step<20;step++)await act(async()=>t.mock.timers.tick(3000));
 assert.equal(reads()-visible,20,'the visible integration view polls once every three seconds over sixty seconds');
 await click(d,'← 返回');const folded=reads();
 await act(async()=>resources(api).invalidate(path=>path==='/api/memory-settings'));
 for(let step=0;step<20;step++)await act(async()=>t.mock.timers.tick(3000));
 assert.equal(reads(),folded,'leaving the view stops all its active reads again without losing mounted state');
});

test('integration activates with a fresh shared read without treating another subscriber as hidden polling',async t=>{
 const{root,d}=await fixture(t);t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const seen:Seen[]=[],reads=()=>seen.filter(read=>read.path==='/api/memory-settings').length;
 const api=owner(path=>path==='/api/memory-settings'?{settings:{consolidation:{enabled:false,maxItems:5}},extensions:[],marker:reads()}:undefined,seen);
 function SharedReader(){const state=useResource<{marker:number}>(api,'/api/memory-settings');return React.createElement('output',{'data-shared-settings':true},state.data?.marker);}
 const render=(shared:boolean)=>act(async()=>root.render(React.createElement(React.Fragment,null,shared&&React.createElement(SharedReader,{key:'shared'}),React.createElement(ManualMemoryWorkspace,{...props(api,{kind:'integrate'}),key:'work'}))));
 await render(true);assert.equal(reads(),1,'the other reader owns the initial request');
 await render(false);await act(async()=>resources(api).invalidate(path=>path==='/api/memory-settings'));
 assert.equal(reads(),1,'after the other subscriber leaves, the hidden integration is not a reader');
 await render(true);const cached=reads();assert.equal(cached,2);
 await click(d,'查看最近的处理');assert.equal(reads(),cached+1,'an already observed, warm cache still gets a fresh activation read');
 await act(async()=>t.mock.timers.tick(3000));assert.equal(reads(),cached+2);
 await click(d,'← 返回');const hidden=reads();
 await act(async()=>t.mock.timers.tick(60000));assert.equal(reads(),hidden,'the remaining shared reader has no integration polling timer');
 await act(async()=>resources(api).invalidate(path=>path==='/api/memory-settings'));
 assert.equal(reads(),hidden+1,'the other visible subscriber can still revalidate its shared resource');
 assert.equal(d.querySelector('[data-shared-settings]')!.textContent,String(reads()));
});

test('closing the actual Memories integration workspace stops reads while retaining recipe draft and action error',async t=>{
 const{root,d}=await fixture(t);t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const seen:Seen[]=[],api=owner((path,init)=>{
  if(path.startsWith('/api/memories?'))return{items:[memory(id)],nextCursor:null};
  if(path==='/api/memory-integration-recipes')return{items:[{id:'generated.first',version:'1',available:true},{id:'generated.second',version:'2',available:true}]};
  if(path==='/api/memory-integrations'&&init?.method==='POST')throw Error('Generated integration action failed');
 },seen),reads=()=>seen.filter(read=>read.path==='/api/memory-settings').length;
 await act(async()=>root.render(React.createElement(Memories,{api,range:{},onOpen:()=>{}})));
 await act(async()=>d.querySelector<HTMLButtonElement>('.workspace-select')!.click());await click(d,'更多');await click(d,'从这条记忆开始整理');
 const panel=d.querySelector('#manual-memory-integration')!,select=panel.querySelector<HTMLSelectElement>('select')!;
 await act(async()=>{select.value='generated.second@2';select.dispatchEvent(new d.defaultView!.Event('change',{bubbles:true}));});
 await click(d,'开始整理',panel);assert.match(panel.textContent!,/Generated integration action failed/);
 await click(d,'← 返回');assert.equal(d.querySelector('.memory-work-stage')!.hasAttribute('hidden'),true);
 assert.equal(d.querySelector('#manual-memory-integration'),panel,'the hidden work page retains the actual integration component');
 const hidden=reads();await act(async()=>resources(api).invalidate(path=>path==='/api/memory-settings'));
 for(let step=0;step<20;step++)await act(async()=>t.mock.timers.tick(3000));
 assert.equal(reads(),hidden,'closing the outer workspace also stops integration reads for sixty seconds');
 await click(d,'从这条记忆开始整理');assert.equal(reads(),hidden+1);
 assert.equal(d.querySelector('#manual-memory-integration'),panel);
 assert.equal(panel.querySelector('select')!.value,'generated.second@2');
 assert.match(panel.textContent!,/Generated integration action failed/,'visibility alone does not discard the existing action error');
});

test('hiding or switching owner aborts integration reads and late old results cannot cross the API generation',async t=>{
 const{root,d}=await fixture(t);let finish!:(value:unknown)=>void,oldSignal:AbortSignal|undefined;
 const oldSeen:Seen[]=[],old=owner((path,init)=>path==='/api/memory-settings'?(oldSignal=init?.signal as AbortSignal,new Promise(resolve=>finish=resolve)):undefined,oldSeen);
 await act(async()=>root.render(React.createElement(ManualMemoryWorkspace,{...props(old,{kind:'integrate',candidate:memory(id)}),active:true})));
 assert.ok(oldSignal);assert.equal(oldSignal.aborted,false);
 await act(async()=>root.render(React.createElement(ManualMemoryWorkspace,{...props(old,{kind:'integrate',candidate:memory(id)}),active:false})));
 assert.equal(oldSignal.aborted,true,'the hidden integration releases its last subscription');
 let forbidden=true;const nextId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',next=owner(path=>{if(path==='/api/memory-settings'&&forbidden)throw new ApiError('Generated next-owner denial',403);});
 await act(async()=>root.render(React.createElement(ManualMemoryWorkspace,{...props(next,{kind:'integrate',candidate:memory(nextId)}),active:true})));
 await act(async()=>finish({settings:{consolidation:{enabled:false,maxItems:5}},extensions:[{id:'consolidation',status:'running',active:{id:'old-private-run',manual:true,items:1}}]}));
 assert.match(d.querySelector('#manual-memory-integration')!.textContent!,/Generated next-owner denial/);
 assert.doesNotMatch(d.querySelector('.memory-workspace-final')!.textContent!,/Generated Memory a|old-private-run/);
 assert.equal([...d.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='开始整理')!.disabled,true);
 forbidden=false;await act(async()=>resources(next).invalidate(path=>path==='/api/memory-settings'));
 assert.equal([...d.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='开始整理')!.disabled,false);
 assert.equal(oldSeen.some(read=>read.method==='POST'),false);
});

test('a candidate revalidation completed after hiding cannot submit an integration',async t=>{
 const{root,d}=await fixture(t);let finish!:(value:unknown)=>void;
 const seen:Seen[]=[],api=owner(path=>path==='/api/memories/'+id?new Promise(resolve=>finish=resolve):undefined,seen);
 const render=(active:boolean)=>act(async()=>root.render(React.createElement(ManualMemoryWorkspace,{...props(api,{kind:'integrate',candidate:memory(id)}),active})));
 await render(true);await click(d,'开始整理');await render(false);
 await act(async()=>finish(memory(id)));
 assert.equal(seen.some(read=>read.method==='POST'),false,'a hidden candidate check cannot become a late admission');
});

test('an admitted integration receipt can arrive while hidden without initiating a settings read',async t=>{
 const{root,d}=await fixture(t);let finish!:(value:unknown)=>void,completed=false;
 const seen:Seen[]=[],api=owner((path,init)=>{
  if(path==='/api/memory-integrations'&&init?.method==='POST')return new Promise(resolve=>finish=resolve);
  if(path==='/api/memory-settings')return{settings:{consolidation:{enabled:false,maxItems:5}},extensions:completed?[{id:'consolidation',status:'waiting_for_increment',lastRun:{id:'generated-late-admission',completedAt:Date.parse(at)}}]:[]};
 },seen),reads=()=>seen.filter(read=>read.path==='/api/memory-settings').length;
 const render=(active:boolean)=>act(async()=>root.render(React.createElement(ManualMemoryWorkspace,{...props(api,{kind:'integrate',candidate:memory(id)}),active})));
 await render(true);await click(d,'开始整理');await render(false);const hidden=reads();
 completed=true;await act(async()=>finish({id:'generated-late-admission'}));
 assert.equal(reads(),hidden,'the admitted action completion does not refresh an inactive resource');
 await render(true);assert.equal(reads(),hidden+1);
 assert.match(d.querySelector('#manual-memory-integration')!.textContent!,/本次手动整理已完成/);
 assert.equal(seen.filter(read=>read.method==='POST').length,1);
});
