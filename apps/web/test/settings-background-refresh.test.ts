import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {Sources} from '../src/plugins/sources/Sources.js';
import {FileProcessingSettings} from '../src/FileProcessingSettings.js';
import {ModelProfiles} from '../src/ModelProfiles.js';
import {Diagnostics} from '../src/Diagnostics.js';
import {ApiError,type Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';
import {modelView} from './fixtures/model-settings.js';

configureLocale(()=> 'zh-CN');
function deferred(){let resolve!:(value:any)=>void,reject!:(error:unknown)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function fixture(t:import('node:test').TestContext){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 return {root,d:dom.window.document};
}
function apiWith(read:(path:string,init?:RequestInit)=>unknown):Api{return {request:async(path:string,init?:RequestInit)=>path.startsWith('/api/operations/changes')?{ids:[],cursor:0,hasMore:false,reset:false}:path==='/api/connectors/status'?{}:read(path,init)} as Api;}
const item=(id:string)=>({captureId:id,sourceId:'generated-source',externalId:id,layer:'snapshot',title:'Generated source '+id,text:'Generated evidence '+id,observedAt:'2026-01-01T00:00:00Z',receivedAt:'2026-01-01T00:00:00Z',current:true});
const button=(d:Document,label:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent===label)!;
const library=(d:Document)=>d.querySelector<HTMLElement>('.source-grid > div')!;

test('source library and version records remain mounted while the same reads refresh; revocation withdraws them',async t=>{
 const {root,d}=await fixture(t),initial=deferred(),refresh=deferred(),historyRefresh=deferred();let refreshing=false,revoked=false;
 const api=apiWith(path=>{if(revoked)throw new ApiError('generated revoked',403);return path==='/api/sources'?{items:[]}:path.startsWith('/api/source-items?')?(refreshing?refresh.promise:initial.promise):path.includes('/history?')?(refreshing?historyRefresh.promise:{items:[item('A')]}):{items:[]};});
 await act(async()=>root.render(React.createElement(Sources,{api,mode:'library',onOpen:()=>{},onImport:()=>{}})));
 assert.match(library(d).textContent!,/正在读取/);
 await act(async()=>initial.resolve({items:[item('A')],nextCursor:null}));
 const card=library(d).querySelector('article')!;assert.match(card.textContent!,/Generated evidence A/);
 await act(async()=>button(d,'查看版本').click());const history=d.querySelector('.source-history')!;
 refreshing=true;await act(async()=>resources(api).invalidate(path=>path.startsWith('/api/source-items?')||path.includes('/history?')));
 assert.equal(library(d).querySelector('article'),card);assert.equal(d.querySelector('.source-history'),history);assert.doesNotMatch(d.body.textContent!,/正在读取/);
 await act(async()=>{refresh.reject(new Error('generated refresh unavailable'));historyRefresh.reject(new Error('generated history unavailable'));});
 assert.equal(library(d).querySelector('article'),card);assert.match(d.querySelector('[role=alert]')!.textContent!,/状态读取失败，请重试。/);
 revoked=true;await act(async()=>resources(api).invalidate(path=>path.startsWith('/api/source-items?')||path.includes('/history?')));
 assert.equal(library(d).querySelector('article'),null);assert.equal(d.querySelector('.source-history'),null);assert.match(d.body.textContent!,/generated revoked/);
});

test('local audio models share one poll, pause while hidden, and never abort slow reads',async t=>{
 const {root,d}=await fixture(t),refresh=deferred(),pendingSettings=deferred();
 const timers=new Map<number,()=>void>();let timerId=0;
 t.mock.method(globalThis,'setTimeout',((callback:()=>void,delay:number)=>{assert.ok([2000,10000].includes(delay));timers.set(++timerId,callback);return timerId;}) as typeof setTimeout);
 t.mock.method(globalThis,'clearTimeout',((id:number)=>timers.delete(id)) as typeof clearTimeout);
 const advance=async()=>act(async()=>{const pending=Array.from(timers.values());timers.clear();pending.forEach(callback=>callback());});
 let ready=false;const mediaReads:AbortSignal[]=[];
 const media=()=>({dialogue:{state:ready?'ready':'starting',runtimeReady:ready,model:{state:'ready',bytes:1,totalBytes:1}},'speaker-wespeaker':{state:ready?'ready':'models',runtimeReady:ready,model:{state:ready?'ready':'downloading',bytes:1,totalBytes:2}}});
 const api=apiWith((path,init)=>{if(path==='/api/sources')return {items:[]};if(path==='/api/file-processing')return pendingSettings.promise;assert.equal(path,'/api/media-preparation');mediaReads.push(init!.signal as AbortSignal);return mediaReads.length===2?refresh.promise:media();});
 await act(async()=>root.render(React.createElement(FileProcessingSettings,{api})));
 assert.equal(timers.size,1,'two updating model states must not create independent timers');
 Object.defineProperty(d,'hidden',{value:true,configurable:true});await advance();assert.equal(mediaReads.length,1,'hidden pages pause polling');
 Object.defineProperty(d,'hidden',{value:false,configurable:true});await advance();
 assert.equal(mediaReads.length,2,'one initial read and one shared refresh');assert.equal(mediaReads[1].aborted,false,'a sibling model refresh must not abort the in-flight read');
 await advance();await advance();assert.equal(mediaReads.length,2,'a read slower than multiple polling intervals must finish before another starts');assert.equal(mediaReads[1].aborted,false);
 await act(async()=>refresh.resolve(media()));assert.equal(timers.size,1,'polling continues while either runtime is preparing');
 ready=true;await advance();
 assert.equal(mediaReads.length,3);assert.equal(timers.size,1,'visible readiness checks continue after installation so a stopped worker is not shown as permanently ready');
});

test('entering model profiles with an existing settings revision reads once and later revisions refresh once',async t=>{
 const {root,d}=await fixture(t),initial=deferred(),refresh=deferred(),nextNode=deferred(),reads:AbortSignal[]=[],nextReads:AbortSignal[]=[];
 const api=apiWith((path,init)=>{assert.equal(path,'/api/model-settings');reads.push(init!.signal as AbortSignal);return reads.length===1?initial.promise:refresh.promise;});
 const render=(revision:number,selectedApi=api)=>root.render(React.createElement(ModelProfiles,{api:selectedApi,revision,onApplied:()=>{}}));
 await act(async()=>render(5));assert.equal(reads.length,1);assert.equal(reads[0].aborted,false);
 await act(async()=>initial.resolve(modelView()));await act(async()=>d.querySelector<HTMLButtonElement>('[data-model-profile]')!.click());const details=d.querySelector('.deployment-provider')!;assert.ok(details);
 await act(async()=>render(6));assert.equal(reads.length,2);assert.equal(reads[1].aborted,false);assert.equal(d.querySelector('.deployment-provider'),details);
 await act(async()=>refresh.resolve({...modelView(),revision:2}));assert.equal(reads.length,2);
 const next=apiWith((path,init)=>{assert.equal(path,'/api/model-settings');nextReads.push(init!.signal as AbortSignal);return nextNode.promise;});
 await act(async()=>render(6,next));assert.equal(nextReads.length,1);assert.equal(nextReads[0].aborted,false);assert.equal(d.querySelector('.deployment-provider'),null);
 await act(async()=>nextNode.resolve(modelView()));assert.equal(d.querySelector('.deployment-provider'),null,'a new owner begins at the connections list');await act(async()=>d.querySelector<HTMLButtonElement>('[data-model-profile]')!.click());assert.ok(d.querySelector('.deployment-provider'));
});

test('an empty source library keeps its explanation through source-list and item-page revalidation',async t=>{
 const {root,d}=await fixture(t),sourceRefresh=deferred(),pageRefresh=deferred();let refreshing=false;
 const api=apiWith(path=>path==='/api/sources'?(refreshing?sourceRefresh.promise:{items:[]}):path.startsWith('/api/source-items?')?(refreshing?pageRefresh.promise:{items:[],nextCursor:null}):{items:[]});
 await act(async()=>root.render(React.createElement(Sources,{api,mode:'library',onOpen:()=>{},onImport:()=>{}})));
 const explanation=library(d).querySelector('p')!;assert.match(explanation.textContent!,/还没有资料/);
 refreshing=true;await act(async()=>resources(api).invalidate(path=>path==='/api/sources'||path.startsWith('/api/source-items?')));
 assert.equal(library(d).querySelector('p'),explanation);assert.doesNotMatch(library(d).textContent!,/正在读取/);
 await act(async()=>{sourceRefresh.resolve({items:[]});pageRefresh.resolve({items:[],nextCursor:null});});
 assert.equal(library(d).querySelector('p'),explanation);
});

test('requesting another source page still shows its initial loading state and guards repeated pagination',async t=>{
 const {root,d}=await fixture(t),next=deferred();const paths:string[]=[];
 const api=apiWith(path=>{paths.push(path);return path==='/api/sources'?{items:[]}:path.includes('cursor=older')?next.promise:{items:[item('A')],nextCursor:'older'};});
 await act(async()=>root.render(React.createElement(Sources,{api,mode:'library',onOpen:()=>{},onImport:()=>{}})));
 await act(async()=>button(d,'更多资料').click());
 assert.match(library(d).textContent!,/正在读取/);assert.equal(library(d).querySelector('article'),null);
 assert.equal(paths.filter(path=>path.includes('cursor=older')).length,1);
 await act(async()=>next.resolve({items:[item('B')],nextCursor:null}));
 assert.equal(library(d).querySelectorAll('article').length,2);assert.doesNotMatch(library(d).textContent!,/正在读取/);
});

test('diagnostic polls keep loaded log filters usable while a new filter fences old log replies',async t=>{
 const {root,d}=await fixture(t),statusRefresh=deferred(),oldLogs=deferred(),newLogs=deferred();let refreshing=false;
 const status={enabled:true,level:'info',runtime:{uptimeMs:1000,rssBytes:100},queue:{reportedPending:0,index:{pending:0,failed:0}},services:{activeQueries:0},limits:{maxFiles:2,maxFileBytes:1000},retainedEvents:1,writeFailures:0,readFailures:0,droppedEvents:0};
 const page=(value:string)=>({items:[value],page:1,pageSize:100,totalLines:1,totalPages:1,hasPrevious:false,hasNext:false});
 const signals:AbortSignal[]=[];
 const api=apiWith((path,init)=>{if(path==='/api/diagnostics')return refreshing?statusRefresh.promise:status;if(path.endsWith('stage=agent'))return newLogs.promise;assert.match(path,/^\/api\/diagnostics\/log-pages\?/);signals.push(init!.signal as AbortSignal);return refreshing?oldLogs.promise:page('Generated original log');});
 await act(async()=>root.render(React.createElement(Diagnostics,{api})));
 const selects=Array.from(d.querySelectorAll<HTMLSelectElement>('[aria-label="日志文件"],[aria-label="日志阶段"],[aria-label="每页条数"]'));
 assert.equal(selects.length,3);const output=d.querySelector<HTMLTextAreaElement>('[aria-label="原始日志"]')!;
 refreshing=true;await act(async()=>resources(api).invalidate(path=>path==='/api/diagnostics'));
 assert.ok(selects.every(select=>!select.disabled),'an unrelated status poll must leave log filters usable');assert.equal(output.value,'Generated original log\n');
 await act(async()=>resources(api).invalidate(path=>path.startsWith('/api/diagnostics/log-pages?')));
 assert.ok(selects.every(select=>!select.disabled),'same log selection keeps its loaded controls usable while refreshing');
 await act(async()=>{const stage=selects[1];stage.value='agent';stage.dispatchEvent(new window.Event('change',{bubbles:true}));});
 assert.ok(selects.every(select=>select.disabled),'an explicit uncached log selection keeps its initial-read guard');assert.equal(signals[1].aborted,true);
 await act(async()=>oldLogs.resolve(page('Generated stale previous filter')));
 assert.doesNotMatch(output.value,/Generated stale/);
 await act(async()=>newLogs.resolve(page('Generated current agent log')));
 assert.equal(output.value,'Generated current agent log\n');assert.ok(selects.every(select=>!select.disabled));
 await act(async()=>statusRefresh.resolve(status));assert.equal(output.value,'Generated current agent log\n');
});
