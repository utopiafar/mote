import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale,getLocale} from '@mote/shared/i18n';
import {MemoryDetailPage} from '../src/plugins/memory/index';
import {ApiError,type Api} from '../src/api';
import {confirmNavigation} from '../src/unsaved';
import {resources} from '../src/resource-cache';
import {modelView} from './fixtures/model-settings';
const at='2026-10-29T00:00:00.000Z',a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const memory=(id:string)=>({id,title:'Generated Memory '+id[0],statement:'Complete generated original statement '+id[0],uncertainty:'Generated evidence only',status:'published',version:1,fingerprint:id[0].repeat(64),createdAt:at,evidence:[],evidenceIds:[],admission:{layer:'memory'}});
async function fixture(t:import('node:test').TestContext){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/search?q=generated',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>(),locale=getLocale();configureLocale(()=> 'zh-CN');
 for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});}
 Object.assign(dom.window.HTMLElement.prototype,{scrollIntoView:()=>{},attachEvent:()=>{},detachEvent:()=>{}});dom.window.scrollTo=()=>{};
 const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());configureLocale(()=>locale);for(const[key,value]of prior)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);dom.window.close();});return{root,d:dom.window.document};
}
function api(overrides:(path:string,init?:RequestInit)=>unknown=()=>undefined,seen:{path:string;method:string}[]=[]):Api{return{request:async(path:string,init?:RequestInit)=>{seen.push({path,method:init?.method??'GET'});const value=overrides(path,init);if(value!==undefined)return value;if(path==='/api/model-settings')return modelView();if(path==='/api/memory-settings')return{settings:{consolidation:{enabled:false,maxItems:5}},extensions:[]};if(/^\/api\/memories\/[^/?]+\?/.test(path))return memory(path.split('/')[3].split('?')[0]);return{items:[],nextCursor:null};}} as Api;}
const click=async(d:Document,label:string)=>act(async()=>{const button=[...d.querySelectorAll('button')].find(button=>button.textContent===label);assert.ok(button,label);button.click();});
test('isolated activity detail refuses a different Memory ID even after an earlier successful selection',async t=>{
 const {root,d}=await fixture(t),owner=api(path=>path.startsWith('/api/memories/'+a+'?')?memory(b):undefined),opened:string[]=[];
 await act(async()=>root.render(React.createElement(MemoryDetailPage,{api:owner,id:a,isolatedSelection:true,onOpen:ref=>opened.push(ref),onBack:()=>{}})));
 assert.equal(d.querySelector('.memory-detail-heading'),null);assert.doesNotMatch(d.body.textContent!,/Generated Memory b/);assert.match(d.body.textContent!,/响应格式无效/);assert.deepEqual(opened,[]);
});
test('isolated activity detail freshly checks Memory permission and exact evidence before opening the original',async t=>{
 const {root,d}=await fixture(t),evidenceId='00000000-0000-4000-8000-000000000123',withEvidence={...memory(a),evidenceIds:[evidenceId],evidence:[{id:evidenceId,capturedAt:at,receivedAt:at,contentHash:'a'.repeat(64)}]},opened:string[]=[];let denied=false;
 const owner=api(path=>{if(path.startsWith('/api/memories/'+a+'?')){if(denied)throw new ApiError('Generated forbidden',403);return withEvidence;}return undefined;});
 await act(async()=>root.render(React.createElement(MemoryDetailPage,{api:owner,id:a,isolatedSelection:true,onOpen:ref=>opened.push(ref),onBack:()=>{}})));
 assert.ok(d.querySelector('.memory-evidence .evidence-card'));denied=true;await act(async()=>d.querySelector<HTMLButtonElement>('.memory-evidence .evidence-card')!.click());assert.deepEqual(opened,[]);assert.equal(d.querySelector('.memory-detail-heading'),null);assert.match(d.body.textContent!,/Generated forbidden/);
});
test('a transient failed detail read cannot revive its old body while a later revalidation is pending',async t=>{
 const {root,d}=await fixture(t),evidenceId='00000000-0000-4000-8000-000000000123',withEvidence={...memory(a),evidenceIds:[evidenceId],evidence:[{id:evidenceId,capturedAt:at,receivedAt:at,contentHash:'a'.repeat(64)}]};let reads=0,release!:(value:unknown)=>void;
 const owner=api(path=>{if(path.startsWith('/api/memories/'+a+'?')){reads++;if(reads===1)return withEvidence;if(reads<=3)throw new ApiError('Generated unavailable',503);return new Promise(done=>release=done);}return undefined;});
 await act(async()=>root.render(React.createElement(MemoryDetailPage,{api:owner,id:a,isolatedSelection:true,onOpen:()=>assert.fail('must not open'),onBack:()=>{}})));await act(async()=>d.querySelector<HTMLButtonElement>('.memory-evidence .evidence-card')!.click());assert.equal(d.querySelector('.memory-detail-heading'),null);
 await act(async()=>new Promise(resolve=>setTimeout(resolve,3200)));assert.ok(release,'later authorized read is actually pending');assert.equal(d.querySelector('.memory-detail-heading'),null,'a retained old cache is not shown while revalidating');await act(async()=>release(withEvidence));assert.equal(d.querySelector('.memory-detail-heading h2')?.textContent,'Generated Memory a');
});
test('an exact external Memory selection reuses its real detail, More and evidence without admitting a task',async t=>{
 const{root,d}=await fixture(t),seen:{path:string;method:string}[]=[],owner=api(undefined,seen);let returned=0;
 await act(async()=>root.render(React.createElement(MemoryDetailPage,{api:owner,id:a,scope:{deviceId:'generated-device',after:at},onOpen:()=>{},onBack:()=>returned++})));
 assert.equal(d.querySelector('.memory-detail-heading h2')?.textContent,'Generated Memory a');assert.match(d.querySelector('.memory-detail')!.textContent!,/Complete generated original statement a/);
 assert.ok(seen.some(read=>read.path.startsWith('/api/memories/'+a+'?')&&read.path.includes('deviceId=generated-device')&&read.path.includes('after=')));
 await click(d,'更多');assert.match(d.querySelector('.memory-detail')!.textContent!,/纠正这条记忆|历史与有效时间|展开证据/);assert.equal(seen.some(read=>read.method!=='GET'),false);
 await click(d,'返回');await click(d,'返回');assert.equal(returned,1);assert.equal(Boolean(d.querySelector('.memory-detail-heading')),false);
});
test('unmounting an exact Memory detail during committed deletion cannot close a new owner or rewrite its query',async t=>{
 const{root,d}=await fixture(t);let resolve!:(value:unknown)=>void,oldBack=0,nextBack=0;
 const old=api((_path,init)=>init?.method==='DELETE'?new Promise(done=>resolve=done):undefined),next=api();
 await act(async()=>root.render(React.createElement(MemoryDetailPage,{api:old,id:a,onOpen:()=>{},onBack:()=>oldBack++})));
 await click(d,'更多');await click(d,'删除记忆');await click(d,'确认删除');
 await act(async()=>root.render(React.createElement(MemoryDetailPage,{api:next,id:b,onOpen:()=>{},onBack:()=>nextBack++})));
 await act(async()=>resolve({externalErase:'acknowledged',physicalEraseVerified:false}));
 assert.equal(d.querySelector('.memory-detail-heading h2')?.textContent,'Generated Memory b');assert.equal(oldBack,0);assert.equal(nextBack,0);assert.equal(window.location.hash,'#/search?q=generated');
});
test('leaving a Memory detail aborts a pending download and a late response cannot create a download',async t=>{
 const {root,d}=await fixture(t);let release!:(value:unknown)=>void,signal:AbortSignal|undefined,clicks=0;
 const owner=api(path=>path==='/api/memories/'+a?memory(a):undefined);owner.raw=(_path,init)=>{signal=init?.signal??undefined;return new Promise(done=>release=done) as any;};
 const original=d.defaultView!.HTMLAnchorElement.prototype.click;d.defaultView!.HTMLAnchorElement.prototype.click=function(){clicks++;};t.after(()=>{d.defaultView!.HTMLAnchorElement.prototype.click=original;});
 await act(async()=>root.render(React.createElement(MemoryDetailPage,{api:owner,id:a,onOpen:()=>{},onBack:()=>{}})));await click(d,'更多');await click(d,'下载文本');assert.ok(signal);assert.equal(signal!.aborted,false);
 await act(async()=>root.render(React.createElement('div',null,'Generated import view')));assert.equal(signal!.aborted,true);await act(async()=>release({blob:async()=>new Blob(['generated'])}));assert.equal(clicks,0);assert.equal(d.body.textContent,'Generated import view');
});
test('an unsaved Memory correction is protected by the shared navigation confirmation',async t=>{
 const {root,d}=await fixture(t),owner=api();let prompts=0;d.defaultView!.confirm=()=>{prompts++;return false;};
 await act(async()=>root.render(React.createElement(MemoryDetailPage,{api:owner,id:a,onOpen:()=>{},onBack:()=>{}})));await click(d,'更多');await click(d,'纠正这条记忆');const area=d.querySelector<HTMLTextAreaElement>('.memory-correction textarea')!;
 await act(async()=>{area.focus();Object.getOwnPropertyDescriptor(d.defaultView!.HTMLTextAreaElement.prototype,'value')!.set!.call(area,'Generated unsaved correction');area.dispatchEvent(new d.defaultView!.Event('input',{bubbles:true}));area.dispatchEvent(new d.defaultView!.KeyboardEvent('keyup',{bubbles:true,key:'n'}));});
 assert.equal(confirmNavigation(),false);assert.equal(prompts,1);assert.equal(area.value,'Generated unsaved correction');await click(d,'返回');assert.equal(prompts,2);assert.equal(d.querySelector<HTMLTextAreaElement>('.memory-correction textarea')?.value,'Generated unsaved correction');
 d.defaultView!.confirm=()=>true;await click(d,'返回');assert.equal(d.querySelector('.memory-correction'),null);
});
test('an ordinary background job refresh does not hide a focused Memory correction',async t=>{
 const {root,d}=await fixture(t);let hold=false,release!:(value:unknown)=>void;const owner=api(path=>path==='/api/memory-jobs'&&hold?new Promise(done=>release=done):undefined);
 await act(async()=>root.render(React.createElement(MemoryDetailPage,{api:owner,id:a,onOpen:()=>{},onBack:()=>{}})));await click(d,'历史与管理');await click(d,'更多');await click(d,'纠正这条记忆');const area=d.querySelector<HTMLTextAreaElement>('.memory-correction textarea')!;
 await act(async()=>{area.focus();Object.getOwnPropertyDescriptor(d.defaultView!.HTMLTextAreaElement.prototype,'value')!.set!.call(area,'Focused correction');area.dispatchEvent(new d.defaultView!.Event('input',{bubbles:true}));area.dispatchEvent(new d.defaultView!.KeyboardEvent('keyup',{bubbles:true,key:'n'}));});
 hold=true;await act(async()=>resources(owner).get('/api/memory-jobs').refresh());assert.ok(release);assert.equal(d.querySelector<HTMLElement>('.memories-page')!.style.visibility,'visible');assert.equal(d.activeElement,area);assert.equal(area.value,'Focused correction');
 await act(async()=>release({items:[],nextCursor:null}));assert.equal(d.activeElement,area);assert.equal(area.value,'Focused correction');
});
test('unmount aborts a pending Memory correction and a late response cannot change the next view',async t=>{
 const {root,d}=await fixture(t);let release!:(value:unknown)=>void,signal:AbortSignal|undefined;
 const owner=api((path,init)=>{if(path.endsWith('/correct')){signal=init?.signal??undefined;return new Promise(done=>release=done);}return undefined;});
 await act(async()=>root.render(React.createElement(MemoryDetailPage,{api:owner,id:a,onOpen:()=>{},onBack:()=>{}})));await click(d,'更多');await click(d,'纠正这条记忆');const area=d.querySelector<HTMLTextAreaElement>('.memory-correction textarea')!;
 await act(async()=>{area.focus();Object.getOwnPropertyDescriptor(d.defaultView!.HTMLTextAreaElement.prototype,'value')!.set!.call(area,'Generated correction');area.dispatchEvent(new d.defaultView!.Event('input',{bubbles:true}));area.dispatchEvent(new d.defaultView!.KeyboardEvent('keyup',{bubbles:true,key:'n'}));});await click(d,'保存纠正');assert.ok(signal);assert.equal(signal!.aborted,false);assert.equal(d.querySelector<HTMLButtonElement>('.memory-detail-back')!.disabled,true);await click(d,'返回');assert.ok(d.querySelector('.memory-correction'),'same-page Back cannot dismiss a correction waiting for acknowledgement');
 await act(async()=>root.render(React.createElement('div',null,'Generated import view')));assert.equal(signal!.aborted,true);await act(async()=>release(memory(b)));assert.equal(d.body.textContent,'Generated import view');assert.equal(window.location.hash,'#/search?q=generated');
});
test('successful detail deletion returns once and does not reinitialize the deleted initial ID',async t=>{
 const{root,d}=await fixture(t);let returned=0;const seen:{path:string;method:string}[]=[],owner=api((_path,init)=>init?.method==='DELETE'?{}:undefined,seen);
 await act(async()=>root.render(React.createElement(MemoryDetailPage,{api:owner,id:a,onOpen:()=>{},onBack:()=>returned++})));
 await click(d,'更多');await click(d,'删除记忆');await click(d,'确认删除');
 assert.equal(returned,1);assert.equal(Boolean(d.querySelector('.memory-detail-heading')),false);const afterDelete=seen.filter(read=>read.path.startsWith('/api/memories/'+a+'?')).length;
 await act(async()=>root.render(React.createElement(MemoryDetailPage,{api:owner,id:a,onOpen:()=>{},onBack:()=>returned++})));
 assert.equal(returned,1);assert.equal(Boolean(d.querySelector('.memory-detail-heading')),false);assert.equal(seen.filter(read=>read.path.startsWith('/api/memories/'+a+'?')).length,afterDelete);
});

test('related Memory read returns to its exact original scope and More before leaving the external search',async t=>{
 const{root,d}=await fixture(t),seen:{path:string;method:string}[]=[],owner=api(path=>path.startsWith('/api/memories/'+a+'?')?{...memory(a),relations:[{kind:'contradicts',memoryId:b,fingerprint:b[0].repeat(64),version:1}]}:undefined,seen);let returned=0;
 await act(async()=>root.render(React.createElement(MemoryDetailPage,{api:owner,id:a,scope:{deviceId:'generated-device',after:at},onOpen:()=>{},onBack:()=>returned++})));await click(d,'更多');await click(d,'存在矛盾的记忆');assert.equal(d.querySelector('.memory-detail-heading h2')!.textContent,'Generated Memory b');assert.ok(seen.some(read=>read.path.startsWith('/api/memories/'+b+'?')&&new URLSearchParams(read.path.split('?')[1]).get('deviceId')==='generated-device'&&new URLSearchParams(read.path.split('?')[1]).get('after')===at));await click(d,'返回');assert.equal(d.querySelector('.memory-detail-heading h2')!.textContent,'Generated Memory a');assert.ok(d.querySelector('.memory-management-view'));assert.equal(d.activeElement?.getAttribute('data-memory-relation'),b);assert.equal(returned,0);assert.equal(window.location.hash,'#/search?q=generated');await click(d,'返回');await click(d,'返回');assert.equal(returned,1);assert.equal(seen.some(read=>read.method!=='GET'),false);
});
test('a related-read return ticket cannot take a new API back into the old owner selection',async t=>{
 const{root,d}=await fixture(t),old=api(path=>path.startsWith('/api/memories/'+a+'?')?{...memory(a),relations:[{kind:'contradicts',memoryId:b,fingerprint:b[0].repeat(64),version:1}]}:undefined),next=api();let oldBack=0,newBack=0;await act(async()=>root.render(React.createElement(MemoryDetailPage,{api:old,id:a,onOpen:()=>{},onBack:()=>oldBack++})));await click(d,'更多');await click(d,'存在矛盾的记忆');await act(async()=>root.render(React.createElement(MemoryDetailPage,{api:next,id:b,onOpen:()=>{},onBack:()=>newBack++})));await click(d,'返回');assert.equal(newBack,1);assert.equal(oldBack,0);assert.equal(d.querySelector('.memory-detail-heading'),null);
});

test('a related read from a historical revision returns to that revision before its original history entry',async t=>{
 const{root,d}=await fixture(t),oldId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',seen:{path:string;method:string}[]=[],current={...memory(a),relations:[{kind:'supersedes',memoryId:oldId}]},old={...memory(oldId),supersededBy:a,relations:[{kind:'contradicts',memoryId:b,fingerprint:b[0].repeat(64),version:1}]},owner=api(path=>path.split('?')[0]==='/api/memories/'+a?current:path.split('?')[0]==='/api/memories/'+oldId?old:undefined,seen);let returned=0;
 await act(async()=>root.render(React.createElement(MemoryDetailPage,{api:owner,id:a,onOpen:()=>{},onBack:()=>returned++})));await click(d,'更多');await click(d,'历史与有效时间');assert.ok(d.querySelector('.memory-version-history'));
 await act(async()=>[...d.querySelectorAll<HTMLButtonElement>('.memory-history-row')].find(button=>button.textContent?.includes('Generated Memory c'))!.click());assert.equal(d.querySelector('.memory-detail-heading h2')?.textContent,'Generated Memory c');assert.ok(d.querySelector('.memory-management-view'));await click(d,'存在矛盾的记忆');assert.equal(d.querySelector('.memory-detail-heading h2')?.textContent,'Generated Memory b');await click(d,'更多');await click(d,'返回');assert.equal(d.querySelector('.memory-detail-heading h2')?.textContent,'Generated Memory b');assert.equal(d.querySelector('.memory-management-view'),null);await click(d,'返回');
 assert.equal(d.querySelector('.memory-detail-heading h2')?.textContent,'Generated Memory c');assert.ok(d.querySelector('.memory-management-view'));assert.equal(d.activeElement?.getAttribute('data-memory-relation'),b);assert.equal(returned,0);await click(d,'返回');assert.ok(d.querySelector('.memory-version-history'));assert.ok([...d.querySelectorAll('.memory-history-row')].some(row=>row.textContent?.includes('Generated Memory a')));await click(d,'← 返回');assert.equal(d.querySelector('.memory-detail-heading h2')?.textContent,'Generated Memory a');await click(d,'返回');await click(d,'返回');assert.equal(returned,1);assert.equal(seen.some(read=>read.method!=='GET'),false);
});
