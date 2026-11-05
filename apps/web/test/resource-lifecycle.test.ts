import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {CapturePreview,CaptureTimelinePage} from '@mote/shared';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {useResource} from '../src/useResource.js';
import {RecordTimeline} from '../src/plugins/library/Archive.js';
import {ApiError,type Api} from '../src/api.js';

configureLocale(()=> 'zh-CN');
function deferred(){let resolve!:(value:any)=>void,reject!:(error:unknown)=>void;const promise=new Promise<any>((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};}
async function fixture(t:import('node:test').TestContext){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/library',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){
  prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 }
 const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,value] of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
 return {root,d:dom.window.document,w:dom.window};
}
function transport(){
 const reads:{path:string;signal:AbortSignal;reply:ReturnType<typeof deferred>}[]=[];
 const api={request:(path:string,init:RequestInit)=>{const reply=deferred();reads.push({path,signal:init.signal as AbortSignal,reply});return reply.promise;}} as Api;
 return {api,reads};
}
function Probe({api,path,revision,scope}:{api:Api;path:string;revision:number;scope?:string}){
 const read=useResource<{text:string}>(api,path,undefined,revision,scope);
 return React.createElement('div',null,React.createElement('output',null,read.data?.text??'EMPTY'),React.createElement('span',{'data-loading':read.loading},String(read.loading)),read.error!==undefined&&React.createElement('p',{role:'alert'},'read failed'));
}
test('revision reads do not duplicate mount or scope changes and still refresh the selected resource',async t=>{
 const {root,d}=await fixture(t),first=transport(),second=transport();
 const render=(api:Api,path:string,revision:number)=>act(async()=>root.render(React.createElement(Probe,{api,path,revision})));
 await render(first.api,'/generated/A',5);assert.equal(first.reads.length,1);assert.equal(first.reads[0].signal.aborted,false);
 await act(async()=>first.reads[0].reply.resolve({text:'A'}));
 await render(first.api,'/generated/A',6);assert.equal(first.reads.length,2);assert.equal(d.querySelector('output')!.textContent,'A');
 await act(async()=>first.reads[1].reply.resolve({text:'A updated'}));
 await render(first.api,'/generated/B',7);assert.equal(first.reads.length,3);assert.equal(first.reads[2].signal.aborted,false);assert.equal(d.querySelector('output')!.textContent,'EMPTY');
 await render(second.api,'/generated/B',7);assert.equal(second.reads.length,1);assert.equal(first.reads[2].signal.aborted,true);
 await act(async()=>first.reads[2].reply.resolve({text:'OLD NODE'}));assert.equal(d.querySelector('output')!.textContent,'EMPTY');
 await act(async()=>second.reads[0].reply.resolve({text:'new node'}));assert.equal(d.querySelector('output')!.textContent,'new node');
});
test('revision hints let slow reads finish and coalesce their replacements',async t=>{
 const {root,d}=await fixture(t),{api,reads}=transport();
 const render=(revision:number)=>act(async()=>root.render(React.createElement(Probe,{api,path:'/generated/slow',revision})));
 await render(0);await render(1);await render(2);assert.equal(reads.length,1);assert.equal(reads[0].signal.aborted,false);
 await act(async()=>reads[0].reply.resolve({text:'First generation'}));assert.equal(reads.length,2);assert.equal(d.querySelector('output')!.textContent,'First generation');
 await render(3);await render(4);assert.equal(reads.length,2);assert.equal(reads[1].signal.aborted,false);
 await act(async()=>reads[1].reply.resolve({text:'Second generation'}));assert.equal(reads.length,3);assert.equal(d.querySelector('output')!.textContent,'Second generation');
 await act(async()=>reads[2].reply.resolve({text:'Current generation'}));assert.equal(d.querySelector('output')!.textContent,'Current generation');
});
test('switching to an already observed resource still applies a new revision hint',async t=>{
 const {root,d}=await fixture(t),{api,reads}=transport();
 function Shared({path,revision}:{path:string;revision:number}){return React.createElement(React.Fragment,null,React.createElement(Probe,{api,path:'/generated/shared',revision:0}),React.createElement(Probe,{api,path,revision}));}
 await act(async()=>root.render(React.createElement(Shared,{path:'/generated/other',revision:0})));assert.equal(reads.length,2);
 await act(async()=>{reads[0].reply.resolve({text:'Shared old'});reads[1].reply.resolve({text:'Other'});});
 await act(async()=>root.render(React.createElement(Shared,{path:'/generated/shared',revision:1})));assert.equal(reads.length,3,'cached data owned by another observer still revalidates for the revision');
 await act(async()=>reads[2].reply.resolve({text:'Shared current'}));assert.deepEqual(Array.from(d.querySelectorAll('output')).map(node=>node.textContent),['Shared current','Shared current']);
});
test('two mounted consumers coalesce one revision notification for their shared read',async t=>{
 const {root}=await fixture(t),{api,reads}=transport();
 const render=(revision:number)=>act(async()=>root.render(React.createElement(React.Fragment,null,React.createElement(Probe,{api,path:'/generated/shared',revision}),React.createElement(Probe,{api,path:'/generated/shared',revision}))));
 await render(0);assert.equal(reads.length,1);await act(async()=>reads[0].reply.resolve({text:'Initial'}));
 await render(1);assert.equal(reads.length,2);await act(async()=>reads[1].reply.resolve({text:'Current'}));assert.equal(reads.length,2,'sibling notifications do not schedule a redundant follow-up');
});
for(const status of [403,404,503])test('rolling time selection retains display only until current read settles: '+status,async t=>{
 const {root,d}=await fixture(t),{api,reads}=transport();
 const render=(path:string,scope?:string)=>act(async()=>root.render(React.createElement(Probe,{api,path,revision:0,scope})));
 await render('/generated?before=1','week');await act(async()=>reads[0].reply.resolve({text:'Earlier current selection'}));
 await render('/generated?before=2','week');assert.equal(d.querySelector('output')!.textContent,'Earlier current selection');assert.equal(d.querySelector('[data-loading]')!.textContent,'true','retention does not hide transport state');
 await act(async()=>reads[1].reply.reject(new ApiError('Generated failed read',status)));assert.equal(d.querySelector('output')!.textContent,'EMPTY');assert.ok(d.querySelector('[role="alert"]'));
 await render('/generated?before=3','week');assert.equal(d.querySelector('output')!.textContent,'EMPTY','a retry cannot resurrect content withdrawn after an error');
 await act(async()=>reads[2].reply.resolve({text:'Validated replacement'}));
 await render('/generated?before=4','month');assert.equal(d.querySelector('output')!.textContent,'EMPTY','another explicit selection does not retain the prior range');
 await act(async()=>reads[3].reply.resolve({text:'Month result'}));
 await render('/generated?before=5');assert.equal(d.querySelector('output')!.textContent,'EMPTY','unkeyed ranges retain exact-path loading');
});

const when='2026-10-14T01:00:00Z';
const capture=(title:string):CapturePreview=>({id:'aaaaaaaa-aaaa-4aaa-8aaa-'+createHash('sha256').update(title).digest('hex').slice(0,12),capturedAt:when,deviceId:'generated-device',deviceName:'Generated device',platform:'other',source:'note',appName:'记录',windowTitle:title,textPreview:'Generated original',hasImage:false,durationMs:0,ocr:{status:'not_applicable'}});
const page=(title?:string,nextCursor:string|null=null):CaptureTimelinePage=>{const record=title?capture(title):undefined;return {revision:'generated-current-revision',items:record?[{type:'record',id:'opaque-date-row-'+record.id,day:'2026-10-14',firstAt:when,lastAt:when,sampleCount:null,record}]:[],nextCursor};};
const devices=[{deviceId:'generated-device',deviceName:'Generated device',platform:'other',status:'online',queueDepth:0,lastSeenAt:when}];
for(const empty of [false,true])test('record timeline retains '+(empty?'empty':'populated')+' content while its current page refreshes',async t=>{
 const {root,d}=await fixture(t),{api,reads}=transport();
 const render=(revision:number)=>act(async()=>root.render(React.createElement(RecordTimeline,{api,devices,onOpen:()=>{},revision,library:true})));
 await render(0);assert.match(d.body.textContent!,/正在读取…/);assert.ok(reads[0].path.startsWith('/api/capture-browser/timeline?'));const initial=new URL(reads[0].path,'http://fixture').searchParams;for(const key of ['after','before','timeZone'])assert.ok(initial.get(key),'timeline scope includes '+key);
 await act(async()=>reads[0].reply.resolve(page(empty?undefined:'Generated first page',empty?null:'next')));
 const node=d.querySelector(empty?'.empty':'.library-record')!;assert.ok(node);
 await render(1);assert.equal(reads.length,2);assert.equal(d.querySelector(empty?'.empty':'.library-record'),node);assert.doesNotMatch(d.body.textContent!,/正在读取…/);
 await act(async()=>reads[1].reply.resolve(page(empty?undefined:'Generated first page',empty?null:'next')));
 if(empty)return;
 const next=Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='下一页')!;
 await act(async()=>next.click());assert.match(d.body.textContent!,/正在读取…/);assert.equal(new URL(reads[2].path,'http://fixture').searchParams.get('cursor'),'next');
 await render(2);assert.equal(reads[2].signal.aborted,false);assert.equal(reads.length,3,'an update hint lets the requested page finish');assert.match(d.body.textContent!,/正在读取…/);
 await act(async()=>reads[2].reply.resolve(page('Generated second page')));assert.equal(new URL(reads[3].path,'http://fixture').searchParams.get('cursor'),'next','the coalesced refresh keeps the requested page');assert.match(d.body.textContent!,/第 2 页/);assert.doesNotMatch(d.body.textContent!,/正在读取…/);
 await act(async()=>reads[3].reply.resolve(page('Generated second page')));
 const second=d.querySelector('.library-record');await render(3);assert.equal(new URL(reads[4].path,'http://fixture').searchParams.get('cursor'),'next');assert.equal(d.querySelector('.library-record'),second);assert.doesNotMatch(d.body.textContent!,/正在读取…/);
 await act(async()=>reads[4].reply.resolve(page('Generated second page')));assert.match(d.body.textContent!,/第 2 页/);
});
test('record timeline update hints cannot starve a slow page read',async t=>{
 const {root,d}=await fixture(t),{api,reads}=transport();
 const render=(revision:number)=>act(async()=>root.render(React.createElement(RecordTimeline,{api,devices,onOpen:()=>{},revision,library:true})));
 await render(0);await render(1);await render(2);assert.equal(reads.length,1);assert.equal(reads[0].signal.aborted,false);
 await act(async()=>reads[0].reply.resolve(page('Generated completed read')));assert.equal(reads.length,2);assert.match(d.body.textContent!,/Generated completed read/);
 await render(3);await render(4);assert.equal(reads.length,2);assert.equal(reads[1].signal.aborted,false);
 await act(async()=>reads[1].reply.resolve(page('Generated next read')));assert.equal(reads.length,3);assert.match(d.body.textContent!,/Generated next read/);
 await act(async()=>reads[2].reply.resolve(page('Generated current read')));assert.match(d.body.textContent!,/Generated current read/);
});
test('record timeline fences filters and late reads and withdraws revoked data before retry',async t=>{
 const {root,d,w}=await fixture(t),{api,reads}=transport();
 const render=(revision:number)=>act(async()=>root.render(React.createElement(RecordTimeline,{api,devices,onOpen:()=>{},revision,library:true})));
 await render(0);await act(async()=>reads[0].reply.resolve(page('Generated old scope')));await render(1);
 const device=d.querySelector<HTMLSelectElement>('[aria-label="筛选设备"]')!;
 await act(async()=>{device.value='generated-device';device.dispatchEvent(new w.Event('change',{bubbles:true}));});
 assert.equal(reads[1].signal.aborted,true);assert.doesNotMatch(d.body.textContent!,/Generated old scope/);assert.match(d.body.textContent!,/正在读取…/);
 await act(async()=>reads[1].reply.resolve(page('LATE OLD SCOPE')));assert.doesNotMatch(d.body.textContent!,/LATE OLD SCOPE/);
 await act(async()=>reads[2].reply.resolve(page('Generated selected scope')));await render(2);
 await act(async()=>reads[3].reply.reject(new ApiError('Generated permission revoked',403)));assert.doesNotMatch(d.body.textContent!,/Generated selected scope/);assert.match(d.querySelector('[role=alert]')!.textContent!,/请求被拒绝/);assert.match(d.querySelector('.library-time-failure details')!.textContent!,/Generated permission revoked/);
 await act(async()=>d.querySelector<HTMLButtonElement>('[aria-label="刷新记录"]')!.click());assert.doesNotMatch(d.body.textContent!,/Generated selected scope/);assert.match(d.body.textContent!,/正在读取…/);
 await act(async()=>reads[4].reply.resolve(page()));assert.ok(d.querySelector('.empty'));
});
