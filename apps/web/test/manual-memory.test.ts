import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {Memories} from '../src/Memories.js';
import {MemoryProgress,type MemoryJob} from '../src/MemoryProgress.js';
import type {Api} from '../src/api.js';

async function fixture(t:import('node:test').TestContext){
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),backups=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){backups.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
  dom.window.localStorage.setItem('mote.language','zh-CN');const root=createRoot(dom.window.document.getElementById('root')!);
  t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of backups){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
  return {root,d:dom.window.document};
}
const personal={id:'mote.personal-memory',version:'2'},coding={id:'mote.coding-memory',version:'2'};
const summary={total:2,waiting:1,blocked:0,stale:0,completed:1};
const job:MemoryJob={id:'generated-memory',status:'waiting_for_input',createdAt:'2026-09-27T00:00:00Z',updatedAt:'2026-09-27T00:00:00Z',evidenceIds:[],totalBatches:1,completedBatches:1,failedBatches:0,skippedChunks:0,memoryIds:['generated-complete'],skillVersion:'fixture',inputPlans:summary,recipeProgress:[{recipe:personal,inputs:{...summary,total:1,waiting:0},completedBatches:1,failedBatches:0,reasons:[]},{recipe:coding,inputs:{...summary,total:1,completed:0},completedBatches:0,failedBatches:0,reasons:[{code:'memory_input_pending',required:['extracted-text'],materialRef:'material:generated'}]}]};

test('manual recipe choices travel only with this extraction request and survive an unsuccessful submission',async t=>{
  const {root,d}=await fixture(t),writes:{path:string;body:Record<string,unknown>}[]=[];
  const api={request:async(path:string,init?:RequestInit)=>{
    if(init?.method==='POST'){writes.push({path,body:JSON.parse(String(init.body))});throw Error('Generated request failure');}
    if(path==='/api/memory-recipes')return {items:[{...personal,available:true},{...coding,available:true}]};
    if(path==='/api/model-settings')return {settings:{agentTimeoutMs:120000},profiles:[]};
    if(path.startsWith('/api/memories?'))return {items:[],nextCursor:null};
    if(path==='/api/memory-jobs')return {items:[]};
    if(path==='/api/execution-settings')return {queues:{agents:{active:0,waiting:0,limit:1},llm:{active:0,waiting:0,limit:1}}};
    if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};
    assert.fail('Unexpected request '+path);
  },setAgentTimeout:()=>{}} as Api;
  await act(async()=>root.render(React.createElement(Memories,{api,range:{after:'2026-09-01T00:00:00Z'},onOpen:()=>{}})));
  for(const input of d.querySelectorAll<HTMLInputElement>('.manual-memory-recipes input'))await act(async()=>input.click());
  const submit=()=>act(async()=>Array.from(d.querySelectorAll('button')).find(button=>button.textContent==='提取当前范围的记忆')!.click());
  await submit();assert.deepEqual(writes[0].body.recipes,[personal,coding]);assert.equal(writes[0].body.after,'2026-09-01T00:00:00Z');assert.equal(writes[0].path,'/api/memory-jobs');
  assert.equal(d.querySelectorAll('.manual-memory-recipes input:checked').length,2);assert.match(d.body.textContent!,/Generated request failure/);
  await act(async()=>Array.from(d.querySelectorAll('button')).find(button=>button.textContent==='恢复默认提取方式')!.click());
  await submit();assert.equal(writes[1].body.recipes,undefined);assert.ok(writes.every(write=>write.path==='/api/memory-jobs'));
});

test('waiting recipes retain result access, processing links and pause/cancel controls; paused jobs cannot bypass resume',async t=>{
  const {root,d}=await fixture(t),actions:string[]=[],opened:string[]=[];let viewed=0,retried=0;
  const render=(value:MemoryJob)=>act(async()=>root.render(React.createElement(MemoryProgress,{job:value,onAction:action=>actions.push(action),onOpen:ref=>opened.push(ref),onView:()=>viewed++,onRetry:()=>retried++})));
  const click=(text:string)=>act(async()=>Array.from(d.querySelectorAll('button')).find(button=>button.textContent===text)!.click());
  await render(job);assert.match(d.body.textContent!,/等待资料处理/);assert.equal(d.querySelector('progress')?.value,1);assert.equal(d.querySelector('progress')?.max,2);
  await click('查看记忆');await click('查看来源与处理');await click('暂停等待与后续批次');await click('取消未完成方案');
  assert.equal(viewed,1);assert.deepEqual(opened,['material:generated']);assert.deepEqual(actions,['pause','cancel']);
  const blocked={...job,inputPlans:{...summary,waiting:0,blocked:1}};
  await render({...blocked,status:'failed'});await click('重新检查未完成方案');assert.equal(retried,1);
  await render({...blocked,status:'paused'});assert.doesNotMatch(d.body.textContent!,/重新检查未完成方案/);await click('继续整理');assert.equal(actions.at(-1),'resume');
  await render({...job,status:'cancelled'});assert.doesNotMatch(d.body.textContent!,/重新检查未完成方案|取消未完成方案|继续整理/);await click('查看记忆');assert.equal(viewed,2);
});
