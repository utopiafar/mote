import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {MemoryTopics} from '../src/MemoryTopics.js';
import {useOperationUpdates} from '../src/useOperationUpdates.js';
import {resources} from '../src/resource-cache.js';
import {ApiError,type Api} from '../src/api.js';
async function fixture(t:any){const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),backups=new Map<string,PropertyDescriptor|undefined>();for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){backups.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}dom.window.localStorage.setItem('mote.language','zh-CN');const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());for(const [key,descriptor] of backups){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});return {root,document:dom.window.document};}

test('topic loading, offline retry, untrusted labels and unavailable selection remain explicit',async t=>{
 const {root,document:d}=await fixture(t);let resolve!:(x:any)=>void,mode='loading';const selected:string[][]=[];
 const data={classification:{state:'ready'},items:[{id:'auto.fixture',version:'1',label:'<script>untrusted()</script>',nodes:[{id:'one',label:'<img onerror=untrusted()>',parentId:undefined}]}]};
 const api={request:async()=>{if(mode==='loading')return new Promise(r=>resolve=r);if(mode==='offline')throw new ApiError('Offline fixture',503);if(mode==='revoked')throw new ApiError('Revoked fixture',403);return data;}} as unknown as Api;
 const render=()=>root.render(React.createElement(MemoryTopics,{api,treeId:'auto.fixture',nodeId:'one',onChange:(...args:string[])=>selected.push(args)}));
 await act(async()=>render());assert.match(d.body.textContent!,/正在加载/);assert.equal(d.querySelector('select')?.disabled,true);
 await act(async()=>resolve(data));assert.equal(d.querySelector('script'),null);assert.equal(d.querySelector('img'),null);assert.ok(d.querySelector('[aria-current="page"]')?.textContent?.includes('<img'));
 mode='offline';await act(async()=>resources(api).get('/api/context-trees').refresh());assert.match(d.querySelector('[role=alert]')!.textContent!,/Offline fixture|中央服务暂不可用/);
 mode='ready';await act(async()=>d.querySelector<HTMLButtonElement>('[role=alert] button')!.click());assert.equal(d.querySelector('[role=alert]'),null);
 mode='revoked';await act(async()=>resources(api).get('/api/context-trees').refresh());assert.equal(d.querySelector('.memory-topic-nodes'),null);
 mode='ready';data.items=[];await act(async()=>resources(api).get('/api/context-trees').refresh());assert.match(d.body.textContent!,/此主题已不可用/);
 await act(async()=>Array.from(d.querySelectorAll('button')).find(x=>x.textContent==='全部记忆')!.click());assert.deepEqual(selected,[['topics','']]);
});

// The Memories page holds the shared change subscription for the mounted topic
// browser; this harness subscribes through the same real entrypoint so tests
// deliver serialized /api/operations/changes responses, never direct cache hints.
function LiveTopics({api,treeId,nodeId}:{api:Api;treeId:string;nodeId:string}){useOperationUpdates(api);return React.createElement(MemoryTopics,{api,treeId,nodeId,onChange:()=>{}});}
function countingApi(catalog:()=>unknown){
 const reads:string[]=[],changes:string[]=[];let pending:string[]=[],cursor=0;
 const api={request:async(path:string)=>{
  if(path==='/api/context-trees'){reads.push(path);return JSON.parse(JSON.stringify(catalog()));}
  if(path.startsWith('/api/operations/changes')){changes.push(path);const ids=pending;pending=[];return {ids,cursor:++cursor,hasMore:false,reset:false};}
  return {items:[]};
 }} as unknown as Api;
 return {api,reads,changes,push:(ids:string[])=>{pending.push(...ids);}};
}
const catalogReads=(reads:string[])=>reads.filter(path=>path==='/api/context-trees').length;

test('a ready topic catalog revalidates automatic topics every ten seconds and hides withdrawn topics once',async t=>{
 const {root,document:d}=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});
 const data={classification:{state:'ready'},items:[{id:'auto.fixture',version:'1',label:'Generated auto',nodes:[{id:'one',label:'Generated node'}]}]};
 const {api,reads,changes,push}=countingApi(()=>data);
 await act(async()=>root.render(React.createElement(LiveTopics,{api,treeId:'auto.fixture',nodeId:'one'})));
 assert.equal(catalogReads(reads),1);assert.ok(changes.length>=1,'mounting starts the shared change subscription');
 for(let i=0;i<6;i++)await act(async()=>t.mock.timers.tick(10000));assert.equal(catalogReads(reads),7,'provider-backed topics revalidate once per ten seconds while visible');
 push(['capture:generated']);await act(async()=>t.mock.timers.tick(1500));assert.equal(catalogReads(reads),7,'unrelated capture changes never reread the catalog');
 data.items=[];push(['memory:job-1']);await act(async()=>t.mock.timers.tick(1500));
 assert.equal(catalogReads(reads),8,'the delivered memory change coalesces into one re-read');
 assert.match(d.body.textContent!,/此主题已不可用/,'the withdrawn topic becomes hidden');
 await act(async()=>t.mock.timers.tick(60000));assert.equal(catalogReads(reads),8,'a catalog without automatic topics issues no periodic reads');
 Object.defineProperty(d,'hidden',{configurable:true,value:true});d.dispatchEvent(new d.defaultView!.Event('visibilitychange'));
 Object.defineProperty(d,'hidden',{configurable:true,value:false});await act(async()=>d.dispatchEvent(new d.defaultView!.Event('visibilitychange')));
 assert.equal(catalogReads(reads),9,'returning to the view revalidates the ready catalog once');
 await act(async()=>t.mock.timers.tick(60000));assert.equal(catalogReads(reads),9,'the revalidation does not restart periodic reads');
});

test('a provider failure surfaces while the view stays visible and recovers on the next revalidation',async t=>{
 const {root,document:d}=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});
 let status=0;const {api,reads}=countingApi(()=>{if(status)throw new ApiError('Generated provider failure',status);return {classification:{state:'ready'},items:[{id:'auto.fixture',version:'1',label:'Generated auto',nodes:[{id:'one',label:'Generated node'}]}]}});
 await act(async()=>root.render(React.createElement(LiveTopics,{api,treeId:'auto.fixture',nodeId:'one'})));
 assert.equal(catalogReads(reads),1);assert.ok(d.querySelector('.memory-topic-nodes'));
 // The current server contract returns an explicit 502 for a pinned-body
 // mismatch and 503 when the provider is offline; neither suppresses a batch
 // into a successful catalog, so retained data keeps revalidating to recovery.
 for(const failure of [502,503]){
  status=failure;await act(async()=>t.mock.timers.tick(10000));
  assert.ok(d.querySelector('[role=alert]'),'the '+failure+' transition surfaces without leaving the view');assert.ok(d.querySelector('.memory-topic-nodes'),'the failure retains the last delivered topics');
  status=0;await act(async()=>t.mock.timers.tick(10000));
  assert.equal(d.querySelector('[role=alert]'),null,'the next revalidation recovers from '+failure);assert.ok(d.querySelector('.memory-topic-nodes'));
 }
 assert.equal(catalogReads(reads),5,'each ten-second revalidation issues exactly one read');
});

test('running classification polls every five seconds and stops when the delivered catalog is ready',async t=>{
 const {root}=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});
 let state='running';const data={classification:{state:'running'},items:[{id:'auto.fixture',version:'1',label:'Generated auto',nodes:[]}]};
 const {api,reads,changes,push}=countingApi(()=>({...data,classification:{state}}));
 await act(async()=>root.render(React.createElement(LiveTopics,{api,treeId:'auto.fixture',nodeId:''})));
 assert.equal(catalogReads(reads),1);
 for(let index=0;index<2;index++){await act(async()=>t.mock.timers.tick(5000));assert.equal(catalogReads(reads),index+2,'one re-read per five seconds while classification runs');}
 state='ready';data.items=[];push(['memory:job-2']);await act(async()=>t.mock.timers.tick(1500));assert.equal(catalogReads(reads),4,'a memory change rereads once and observes the ready state');
 await act(async()=>t.mock.timers.tick(30000));assert.equal(catalogReads(reads),4,'the ready state without automatic topics stops the timer entirely');
 assert.ok(changes.length>0,'the shared subscription remains live for later changes');
});

test('a hidden view pauses both catalog reads and the feed, and unmounting cleans every subscription',async t=>{
 const {root,document:d}=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});
 let state='running';const {api,reads,changes}=countingApi(()=>({classification:{state},items:[]}));
 await act(async()=>root.render(React.createElement(LiveTopics,{api,treeId:'auto.fixture',nodeId:''})));
 await act(async()=>t.mock.timers.tick(5000));assert.ok(changes.length>=2,'the feed keeps polling while visible');
 Object.defineProperty(d,'hidden',{configurable:true,value:true});d.dispatchEvent(new d.defaultView!.Event('visibilitychange'));
 const catalogBase=catalogReads(reads),feedBase=changes.length;await act(async()=>t.mock.timers.tick(15000));
 assert.equal(catalogReads(reads),catalogBase,'a hidden page issues no catalog reads');assert.equal(changes.length,feedBase,'a hidden page issues no feed requests');
 Object.defineProperty(d,'hidden',{configurable:true,value:false});
 await act(async()=>d.dispatchEvent(new d.defaultView!.Event('visibilitychange')));
 assert.equal(catalogReads(reads),catalogBase+1,'a visible return revalidates the catalog once');
 await act(async()=>t.mock.timers.tick(5000));assert.equal(catalogReads(reads),catalogBase+2,'the running poll resumes afterwards');
 assert.ok(changes.length>feedBase&&changes.length-feedBase<=2,'recovery resumes the feed without duplicating subscriptions');
 await act(async()=>root.unmount());
 const finalCatalog=catalogReads(reads),finalFeed=changes.length;await act(async()=>t.mock.timers.tick(30000));
 assert.equal(catalogReads(reads),finalCatalog,'unmount stops the catalog timer');assert.equal(changes.length,finalFeed,'unmount releases the shared subscription');
});
