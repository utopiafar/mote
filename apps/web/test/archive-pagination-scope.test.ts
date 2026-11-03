import test from 'node:test';
import {httpStatusMessage} from '@mote/shared';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {Sources} from '../src/Sources.js';
import {Files} from '../src/plugins/intake/Files.js';
import {ApiError,type Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';

configureLocale(()=> 'zh-CN');
type View='sources'|'files';
function deferred(){let resolve!:(value:any)=>void;const promise=new Promise<any>(a=>{resolve=a;});return {promise,resolve};}
async function fixture(t:import('node:test').TestContext,view:View){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 const d=dom.window.document,render=async(api:Api)=>act(async()=>root.render(view==='sources'?React.createElement(Sources,{api,mode:'library',onOpen:()=>{},onImport:()=>{}}):React.createElement(Files,{api,onOpen:()=>{}})));
 const rows=()=>Array.from(d.querySelectorAll(view==='sources'?'.source-grid > div > article':'.source-list .file-card'));
 const next=()=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent===(view==='sources'?'更多资料':'继续加载'))!;
 return {d,render,rows,next};
}
const prefix=(view:View)=>view==='sources'?'/api/source-items?':'/api/files?';
const row=(view:View,id:string)=>view==='sources'?{captureId:id,sourceId:'generated-source',externalId:id,layer:'snapshot',title:'Generated '+id,text:'Generated evidence '+id,observedAt:'2026-01-01T00:00:00Z',receivedAt:'2026-01-01T00:00:00Z',current:true}:{captureId:id,sourceId:'generated-source',sizeBytes:1,hasOriginal:true,originMissing:false,item:{title:'Generated '+id,layer:'original',observedAt:'2026-01-01T00:00:00Z'},job:null,artifacts:[]};
const page=(view:View,id:string,nextCursor:string|null=null)=>({revision:1,items:[row(view,id)],nextCursor});
function apiWith(view:View,read:(path:string,init?:RequestInit)=>unknown,withSource=false):Api{return {request:async(path:string,init?:RequestInit)=>{
 if(path.startsWith(prefix(view)))return read(path,init);
 if(path==='/api/sources')return {items:withSource?[{id:'generated-filter',name:'Generated filter source',kind:'custom',enabled:true}]:[]};
 if(path==='/api/sources/generated-filter/context')return {sourceId:'generated-filter',version:1,description:''};
 if(path==='/api/connectors/status')return {};
 if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};
 throw new Error('Unexpected generated archive request '+path);
 }} as Api;}

for(const view of ['sources','files'] as const){
 test(view+' overlapping cursor pages retain first-seen records and continue once while a page is pending',async t=>{
  const f=await fixture(t,view),last=deferred(),paths:string[]=[],overlap=row(view,'A');
  if(overlap.item)overlap.item.title='Generated overlapping replacement';else overlap.title='Generated overlapping replacement';
  const api=apiWith(view,path=>{paths.push(path);return path.includes('cursor=last')?last.promise:path.includes('cursor=older')?{items:[overlap,row(view,'B')],nextCursor:'last'}:page(view,'A','older');});
  await f.render(api);await act(async()=>f.next().click());
  assert.deepEqual(f.rows().map(row=>row.querySelector('strong')!.textContent),['Generated A','Generated B']);
  await act(async()=>{f.next().click();f.next().click();});
  assert.equal(paths.filter(path=>path.includes('cursor=last')).length,1,'two clicks cannot dispatch duplicate cursor reads');
  await act(async()=>last.resolve({items:[row(view,'B'),row(view,'C')],nextCursor:null}));
  assert.deepEqual(f.rows().map(row=>row.querySelector('strong')!.textContent),['Generated A','Generated B','Generated C']);
  assert.equal(f.next(),undefined,'the null continuation ends the accumulated list');
 });

 test(view+' background refresh keeps accumulated row identity, focus and local browsing drafts',async t=>{
  const f=await fixture(t,view),pending=deferred(),paths:string[]=[];let refreshing=false;
  const api=apiWith(view,path=>{paths.push(path);return path.includes('cursor=older')?(refreshing?pending.promise:page(view,'B')):page(view,'A','older');},true),read=api.request;
  api.request=async(path,init)=>path.includes('/history?')?{items:[row(view,'Historical')]} as any:read(path,init);
  await f.render(api);await act(async()=>f.next().click());const rows=f.rows();assert.equal(rows.length,2);
  let focused:HTMLElement,historyPanel:Element|null=null;
  if(view==='files'){
   const select=f.d.querySelector<HTMLSelectElement>('[aria-label="文件来源"]')!;
   await act(async()=>{select.value='generated-filter';select.dispatchEvent(new window.Event('change',{bubbles:true}));});
   focused=select;
  }else{
   const history=rows[0].querySelectorAll('button')[1];await act(async()=>history.click());
   historyPanel=f.d.querySelector('.source-history');assert.ok(historyPanel);focused=history;
  }
  focused.focus();assert.equal(f.d.activeElement,focused);
  refreshing=true;await act(async()=>resources(api).invalidate(path=>path.startsWith(prefix(view))&&path.includes('cursor=older')));
  assert.deepEqual(f.rows(),rows);assert.equal(f.d.activeElement,focused);
  await act(async()=>pending.resolve(page(view,'B')));
  assert.deepEqual(f.rows(),rows);assert.equal(f.d.activeElement,focused);
  if(view==='files'){
   assert.equal((focused as HTMLSelectElement).value,'generated-filter','the unapplied file filter draft survives refresh');
   assert.ok(paths.every(path=>!path.includes('sourceId=generated-filter')),'background reads stay on the applied filter');
  }else{assert.equal(f.d.querySelector('.source-history'),historyPanel,'the opened version history stays selected');assert.equal(historyPanel!.querySelectorAll('p').length,1);}
 });

 for(const status of [401,403,404,410])test(view+' copied pages are withdrawn after '+status+' and do not return on a same-revision retry',async t=>{
  const f=await fixture(t,view);let denied=false;
  const api=apiWith(view,path=>{if(denied)throw new ApiError('Generated revoked archive',status);return path.includes('cursor=older')?page(view,'B'):page(view,'A','older');});
  await f.render(api);await act(async()=>f.next().click());assert.equal(f.rows().length,2);
  denied=true;await act(async()=>resources(api).invalidate(path=>path.startsWith(prefix(view))&&path.includes('cursor=older')));
  assert.equal(f.rows().length,0);if(view==='sources'){assert.equal(f.d.querySelector('[role=alert]')!.textContent,httpStatusMessage(status));assert.match(f.d.querySelector('.source-final-failure details')!.textContent!,/Generated revoked archive/);}else assert.match(f.d.querySelector('[role=alert]')!.textContent!,/Generated revoked archive/);
  denied=false;await act(async()=>resources(api).invalidate(path=>path.startsWith(prefix(view))&&path.includes('cursor=older')));
  assert.equal(f.rows().length,1);assert.match(f.rows()[0].textContent!,/Generated B/);assert.doesNotMatch(f.d.body.textContent!,/Generated A/);
 });

 test(view+' copied pages retain their records through a transient page read failure',async t=>{
  const f=await fixture(t,view);let failed=false;
  const api=apiWith(view,path=>{if(failed)throw new ApiError('Generated transient archive failure',503);return path.includes('cursor=older')?page(view,'B'):page(view,'A','older');});
  await f.render(api);await act(async()=>f.next().click());const rows=f.rows();assert.equal(rows.length,2);
  failed=true;await act(async()=>resources(api).invalidate(path=>path.startsWith(prefix(view))&&path.includes('cursor=older')));
  assert.deepEqual(f.rows(),rows);if(view==='sources'){assert.equal(f.d.querySelector('[role=alert]')!.textContent,httpStatusMessage(503));assert.match(f.d.querySelector('.source-final-failure details')!.textContent!,/Generated transient archive failure/);}else assert.match(f.d.querySelector('[role=alert]')!.textContent!,/Generated transient archive failure/);
 });

 test(view+' API changes reset pagination immediately and ignore late old-node reads',async t=>{
  const f=await fixture(t,view),oldRead=deferred(),newRead=deferred();let refreshing=false;let oldSignal:AbortSignal|undefined;
  const oldApi=apiWith(view,(path,init)=>{if(path.includes('cursor=older')&&refreshing){oldSignal=init!.signal as AbortSignal;return oldRead.promise;}return path.includes('cursor=older')?page(view,'B'):page(view,'A','older');});
  await f.render(oldApi);await act(async()=>f.next().click());assert.equal(f.rows().length,2);
  refreshing=true;await act(async()=>resources(oldApi).invalidate(path=>path.startsWith(prefix(view))&&path.includes('cursor=older')));
  const nextPaths:string[]=[],newApi=apiWith(view,path=>{nextPaths.push(path);return newRead.promise;});
  await f.render(newApi);assert.equal(f.rows().length,0);assert.equal(oldSignal!.aborted,true);assert.ok(nextPaths.every(path=>!path.includes('cursor=')));
  await act(async()=>oldRead.resolve(page(view,'Late old node')));assert.equal(f.rows().length,0);
  await act(async()=>newRead.resolve(page(view,'New node')));assert.equal(f.rows().length,1);assert.match(f.rows()[0].textContent!,/Generated New node/);assert.doesNotMatch(f.d.body.textContent!,/Generated A|Generated B|Late old node/);
  refreshing=false;await f.render(oldApi);assert.equal(f.rows().length,1);assert.match(f.rows()[0].textContent!,/Generated A/);
 });

 test(view+' explicit source filters reset copied pages while preserving their loading controls',async t=>{
  const f=await fixture(t,view),filtered=deferred();
  const api=apiWith(view,path=>path.includes('sourceId=generated-filter')?filtered.promise:path.includes('cursor=older')?page(view,'B'):page(view,'A','older'),true);
  await f.render(api);await act(async()=>f.next().click());assert.equal(f.rows().length,2);
  if(view==='sources')await act(async()=>f.d.querySelector<HTMLButtonElement>('.source-select')!.click());
  else{
   const select=f.d.querySelector<HTMLSelectElement>('[aria-label="文件来源"]')!;
   await act(async()=>{select.value='generated-filter';select.dispatchEvent(new window.Event('change',{bubbles:true}));});assert.equal(f.rows().length,2,'editing a filter stays a draft until Find is submitted');
   await act(async()=>f.d.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
   const search=Array.from(f.d.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='查找 / 刷新')!;assert.equal(search.disabled,true);
  }
  assert.equal(f.rows().length,0);assert.equal(f.next(),undefined);
  await act(async()=>filtered.resolve(page(view,'Filtered')));assert.equal(f.rows().length,1);assert.match(f.rows()[0].textContent!,/Generated Filtered/);
 });
}

test('an empty file archive keeps its settled explanation during background operation refresh',async t=>{
 const f=await fixture(t,'files'),refresh=deferred();let refreshing=false;
 const api=apiWith('files',()=>refreshing?refresh.promise:{items:[],nextCursor:null});
 await f.render(api);const explanation=f.d.querySelector('p.muted')!;assert.match(explanation.textContent!,/尚无匹配文件/);
 refreshing=true;await act(async()=>resources(api).invalidate(path=>path.startsWith('/api/files?')));
 assert.equal(f.d.querySelector('p.muted'),explanation);assert.equal(f.rows().length,0);
 await act(async()=>refresh.resolve({items:[],nextCursor:null}));assert.equal(f.d.querySelector('p.muted'),explanation);
});
