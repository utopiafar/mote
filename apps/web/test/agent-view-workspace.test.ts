import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {AgentInspector} from '../src/plugins/agent-access/AgentInspector';
import {RecordedInput} from '../src/plugins/agent-access/agent-view-input';
import {ApiError,type Api} from '../src/api';
configureLocale(()=> 'zh-CN');
const evidence='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const events=(label:string)=>({items:[
 {seq:1,at:'2026-10-01T00:00:00Z',trace:{type:'context.assembled',payload:{prompt:JSON.stringify({request:label+' question',timeZone:'UTC',selectedTimeRange:{},untrustedMemoryLeads:[]})}}},
 {seq:2,at:'2026-10-01T00:00:01Z',trace:{type:'tool.completed',tool:'evidence',status:'succeeded',payload:{result:{data:{items:[{id:evidence,ocrText:label+' exact <img src=x onerror=untrusted> original'}]}}}}},
 {seq:3,at:'2026-10-01T00:00:02Z',trace:{type:'model.completed',payload:{response:label+' output <script>untrusted</script>'}}},
 {seq:4,at:'2026-10-01T00:00:03Z',trace:{type:'run.completed',status:'succeeded',payload:{citations:[evidence]}}}
 ],nextSeq:4,oldestSeq:1,recording:{enabled:true}});
async function fixture(t:any,hash='#/agent?tab=input'){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'+hash}),prior=new Map<string,PropertyDescriptor|undefined>();
 for(const[k,value]of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{value,writable:true,configurable:true});}
 Object.assign(dom.window.HTMLElement.prototype,{scrollIntoView:()=>{},attachEvent:()=>{},detachEvent:()=>{}});
 const root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());for(const[k,value]of prior)if(value)Object.defineProperty(globalThis,k,value);else Reflect.deleteProperty(globalThis,k);dom.window.close();});return{root,d:dom.window.document};
}
function api(read:(path:string)=>unknown,seen:string[]=[]):Api{return{request:async(path:string,init?:RequestInit)=>{assert.equal(init?.method,undefined,'Inspector only reads recorded events');seen.push(path);if(path==='/api/agent-view/runs')return{items:['run-A','run-B'].map(runId=>({runId,at:'2026-10-01T00:00:00Z',firstSeq:1,type:'run.completed'})),recording:{enabled:true}};if(path.startsWith('/api/agent-view/events?'))return read(path);if(path.startsWith('/api/agent-view/catalog?'))return{entries:[],nextCursor:null};throw Error('Unexpected recorded-read path '+path);}} as Api;}
async function click(d:Document,label:string){await act(async()=>{const button=[...d.querySelectorAll('button')].find(button=>button.textContent===label);assert.ok(button,label);button.click();});}
async function select(d:Document,id:string){await act(async()=>{const input=d.querySelector<HTMLSelectElement>('.agent-run-selection select')!;input.value=id;input.dispatchEvent(new d.defaultView!.Event('change',{bubbles:true}));});}
function View({owner,onOpen}:{owner:Api;onOpen:(ref:string)=>void}){const[id,setId]=useState('run-A');return React.createElement(RecordedInput,{api:owner,runId:id,setRunId:setId,onOpen});}
test('recorded run selection requires an explicit read and preserves exact input, tool and output tabs',async t=>{
 const{root,d}=await fixture(t),seen:string[]=[],opened:string[]=[];const owner=api(()=>events('A'),seen);
 await act(async()=>root.render(React.createElement(View,{owner,onOpen:ref=>opened.push(ref)})));
 assert.equal(seen.some(path=>path.startsWith('/api/agent-view/events')),false);
 assert.match(d.body.textContent!,/尚未读取这次运行/);
 await click(d,'读取运行记录');assert.equal(seen.filter(path=>path.startsWith('/api/agent-view/events')).length,1);assert.match(d.querySelector('.agent-recorded-content')!.textContent!,/A question/);
 await click(d,'工具读取');assert.match(d.querySelector('.agent-recorded-content')!.textContent!,/A exact <img/);assert.equal(d.querySelector('.agent-recorded-content img'),null);
 await click(d,'输出');assert.match(d.querySelector('.agent-recorded-content')!.textContent!,/A output <script>/);assert.equal(d.querySelector('.agent-recorded-content script'),null);
 await click(d,'打开这次回答的原始依据 1');assert.deepEqual(opened,['capture:'+evidence]);
 await select(d,'run-B');assert.equal(d.querySelector('.agent-recorded-tabs'),null);assert.equal(seen.filter(path=>path.startsWith('/api/agent-view/events')).length,1);
});
test('changing run or owner cannot render a late previous run and missing records are not reconstructed',async t=>{
 const{root,d}=await fixture(t);let resolve!:(value:unknown)=>void;const pending=new Promise(done=>resolve=done),seen:string[]=[];
 const owner=api(path=>new URLSearchParams(path.split('?')[1]).get('runId')==='run-A'?pending:events('B'),seen);
 await act(async()=>root.render(React.createElement(View,{owner,onOpen:()=>{}})));await click(d,'读取运行记录');await select(d,'run-B');await click(d,'读取运行记录');
 await act(async()=>resolve(events('PRIVATE-A')));assert.match(d.querySelector('.agent-recorded-content')!.textContent!,/B question/);assert.doesNotMatch(d.body.textContent!,/PRIVATE-A/);
 const next=api(()=>{throw new ApiError('Generated inaccessible trace',403);});await act(async()=>root.render(React.createElement(RecordedInput,{api:next,runId:'run-B',setRunId:()=>{}})));
 assert.equal(d.querySelector('.agent-recorded-tabs'),null);await click(d,'读取运行记录');assert.ok(d.querySelector('[role=alert]'));assert.equal(d.querySelector('.agent-recorded-content'),null);
});
test('the catalog keeps directory and scope disclosure folded and a direct recorded-run route opens that workflow',async t=>{
 const{root,d}=await fixture(t,'#/agent'),seen:string[]=[],owner=api(()=>events('A'),seen);
 await act(async()=>root.render(React.createElement(AgentInspector,{api:owner,onOpen:()=>{}})));
 assert.equal(d.querySelector<HTMLDetailsElement>('.agent-directory-options')!.open,false);assert.equal(seen.length,0);
 const details=d.querySelector<HTMLDetailsElement>('.agent-directory-options')!;
 await act(async()=>{details.open=true;details.dispatchEvent(new d.defaultView!.Event('toggle'));});assert.equal(seen.some(path=>path.startsWith('/api/agent-view/catalog?')),false);
 const browser=d.querySelector<HTMLDetailsElement>('.agent-catalog-browser')!;
 await act(async()=>{browser.open=true;browser.dispatchEvent(new d.defaultView!.Event('toggle'));});assert.ok(seen.some(path=>path.startsWith('/api/agent-view/catalog?')));
 await act(async()=>{window.location.hash='#/agent?tab=input';window.dispatchEvent(new d.defaultView!.Event('hashchange'));});assert.ok(d.querySelector('.agent-run-selection'));assert.equal(d.querySelector('.section-tabs'),null);assert.equal(seen.some(path=>path.startsWith('/api/agent-view/events')),false);
});
