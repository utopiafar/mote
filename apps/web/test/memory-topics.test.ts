import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {MemoryTopics} from '../src/MemoryTopics.js';
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
