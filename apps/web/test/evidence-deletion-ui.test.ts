import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {EvidenceDialog} from '../src/shell-components.js';
import type {Api,Capture} from '../src/api.js';

const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const original:Capture={id,source:'note',platform:'macos',capturedAt:'2026-10-29T01:00:00Z',appName:'Generated note',windowTitle:'Generated original',deviceId:'generated-device',deviceName:'Generated',ocrText:'  Literal generated note\nNo deletion claim without a receipt.  ',durationMs:0,blobHash:null,indexingStatus:'indexed',privacy:{redacted:false,mode:'none'},deletion:{available:true,kind:'capture'}};
async function fixture(t:any,remove:()=>Promise<unknown>,capture=original,embeddedBackground=false){
 const dom=new JSDOM('<!doctype html>'+(embeddedBackground?'<main class="embedded-evidence"><section class="evidence-modal evidence-reader" role="region"><button>Generated embedded original</button></section></main>':'')+'<div id="root"></div>',{url:'http://localhost/#/library',pretendToBeVisual:true}),backups=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){backups.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 dom.window.localStorage.setItem('mote.language','zh-CN');dom.window.HTMLElement.prototype.getClientRects=()=>[{}] as unknown as DOMRectList;
 const root=createRoot(dom.window.document.querySelector('#root')!),writes:string[]=[],events={closed:0,deleted:0};
 const api={request:async(path:string,init?:RequestInit)=>{if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};if(init?.method==='DELETE'){writes.push(path);return remove();}if(path.startsWith('/api/capture-browser/'))return {...capture,id:path.split('/').at(-1)};throw Error('Unexpected generated path '+path);},setAgentTimeout:()=>{}} as Api;
 async function render(nextApi=api,nextId=id){await act(async()=>root.render(React.createElement(EvidenceDialog,{api:nextApi,id:'capture:'+nextId,onOpen:()=>{},onClose:()=>{events.closed++;},onDeleted:()=>{events.deleted++;}})));}
 await render();t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor]of backups){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
 const d=dom.window.document;
 async function confirm(){await act(async()=>d.querySelector<HTMLButtonElement>('.reader-more-button')!.click());await act(async()=>d.querySelector<HTMLButtonElement>('.danger-text')!.click());await act(async()=>d.querySelector<HTMLButtonElement>('.evidence-footer .danger')!.click());}
 return {d,api,root,render,writes,events,confirm,unmountReader:async()=>{await act(async()=>root.render(null));}};
}

test('a virtual original without a unique deletion capability stays readable with no delete control',async t=>{
 const {d,writes}=await fixture(t,async()=>({deleted:1}),{...original,deletion:{available:false,kind:null}});
 await act(async()=>d.querySelector<HTMLButtonElement>('.reader-more-button')!.click());assert.equal(d.querySelector('.danger-text'),null);assert.match(d.body.textContent!,/此引用不能直接删除原始记录/);assert.equal(d.querySelector('.evidence-text pre')!.textContent,original.ocrText);assert.deepEqual(writes,[]);
});

for(const receipt of [undefined,null,{}, {deleted:0},{deleted:-1},{deleted:1.5},{deleted:'1'},{deleted:Number.NaN}] )test('an unconfirmed deletion receipt '+JSON.stringify(receipt)+' preserves the exact original and does not close',async t=>{
 const f=await fixture(t,async()=>receipt);await f.confirm();assert.equal(f.writes.length,1);assert.deepEqual(f.events,{closed:0,deleted:0});assert.equal(f.d.querySelector('.evidence-text pre')!.textContent,original.ocrText);assert.match(f.d.body.textContent!,/删除待确认.*刷新/);assert.equal(f.d.querySelector<HTMLDetailsElement>('.deletion-diagnostic')!.open,false);assert.equal(f.d.querySelector<HTMLButtonElement>('.evidence-footer .danger')!.disabled,false);
 await act(async()=>{});assert.equal(f.writes.length,1,'rendering never repeats the write');
});

test('a transport-unknown response keeps the original and retries only after another explicit confirmation',async t=>{
 let calls=0;const f=await fixture(t,async()=>{if(++calls===1)throw Error('Generated connection lost after commit');return {deleted:1};});await f.confirm();assert.deepEqual(f.events,{closed:0,deleted:0});assert.equal(f.writes.length,1);assert.equal(f.d.querySelector('.evidence-text pre')!.textContent,original.ocrText);assert.match(f.d.querySelector('.deletion-diagnostic')!.textContent!,/connection lost after commit/);
 await act(async()=>f.d.querySelector<HTMLButtonElement>('.evidence-footer .danger')!.click());assert.equal(f.writes.length,2);assert.deepEqual(f.events,{closed:1,deleted:1});assert.deepEqual(f.writes,['/api/captures/'+id,'/api/captures/'+id]);
});

test('a positive file deletion uses the existing file confirmation without exposing a raw target',async t=>{
 const f=await fixture(t,async()=>({deleted:2}),{...original,deletion:{available:true,kind:'file'}});await act(async()=>f.d.querySelector<HTMLButtonElement>('.reader-more-button')!.click());await act(async()=>f.d.querySelector<HTMLButtonElement>('.danger-text')!.click());assert.match(f.d.querySelector('.evidence-footer')!.textContent!,/删除中央文件原件和解析正文/);assert.match(f.d.querySelector('.evidence-footer')!.textContent!,/来源设备上的原文件保留/);await act(async()=>f.d.querySelector<HTMLButtonElement>('.evidence-footer .danger')!.click());assert.deepEqual(f.events,{closed:1,deleted:1});assert.deepEqual(f.writes,['/api/captures/'+id]);
});

for(const outcome of ['success','failure'] as const)test('a late '+outcome+' for the old original cannot close or report an error in the next reader',async t=>{
 let resolve!:(value:unknown)=>void,reject!:(error:Error)=>void;const pending=new Promise((yes,no)=>{resolve=yes;reject=no;}),f=await fixture(t,()=>pending);await f.confirm();await f.render(f.api,other);assert.equal(f.d.querySelector('.evidence-heading h2')!.textContent,'Generated original');
 await act(async()=>{if(outcome==='success')resolve({deleted:1});else reject(Error('Generated old read failure'));await pending.catch(()=>{});});assert.deepEqual(f.events,{closed:0,deleted:0});assert.equal(f.d.querySelector('.notice.error'),null);assert.equal(f.d.querySelector('.deletion-diagnostic'),null);assert.equal(f.d.querySelector('.evidence-text pre')!.textContent,original.ocrText);assert.equal(f.writes.length,1);
});

for(const outcome of ['success','failure'] as const)test('an unmounted reader cannot affect a newly opened reader after a late '+outcome,async t=>{
 let resolve!:(value:unknown)=>void,reject!:(error:Error)=>void;const pending=new Promise((yes,no)=>{resolve=yes;reject=no;}),f=await fixture(t,()=>pending);await f.confirm();await f.unmountReader();await f.render(f.api,other);
 await act(async()=>{if(outcome==='success')resolve({deleted:1});else reject(Error('Generated unmounted reader failure'));await pending.catch(()=>{});});assert.deepEqual(f.events,{closed:0,deleted:0});assert.equal(f.d.querySelector('.deletion-diagnostic'),null);assert.equal(f.d.querySelector('.evidence-text pre')!.textContent,original.ocrText);assert.equal(f.writes.length,1);
});

test('a modal original over an embedded reader owns its own focus boundary and keeps the background inert',async t=>{
 const f=await fixture(t,async()=>({deleted:1}),original,true);
 const foreground=f.d.querySelector<HTMLElement>('.evidence-reader-backdrop')!,background=f.d.querySelector<HTMLElement>('.embedded-evidence')!;
 assert.equal(foreground.closest('[inert]')===null,true,'the current modal must remain interactive');assert.ok(background.closest('[inert]'),'background embedded reader must be inert');assert.ok(foreground.contains(f.d.activeElement));
});
