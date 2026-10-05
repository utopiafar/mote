import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {Actions} from '../src/Actions.js';
import {Processing} from '../src/Processing.js';
import {affectedResource} from '../src/operation-feed.js';
import type {Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';
configureLocale(()=> 'zh-CN');
async function fixture(t:any){const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>();for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});return {root,d:dom.window.document};}
const button=(d:Document,label:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent===label)!;
test('calendar confirmation pins the reviewed version and requires a new review after another client updates it',async t=>{
 const {root,d}=await fixture(t);let version=1,title='Generated original schedule';const writes:{version:number;event:{title:string}}[]=[];
 const api={request:async(path:string,options?:{body?:string})=>{
  if(path.startsWith('/api/operations/changes'))return new Promise(()=>{});
  if(path.endsWith('/confirm')){writes.push(JSON.parse(options!.body!));return {status:'approved'};}
  if(path.startsWith('/api/actions?'))return {items:[{id:'generated',version,kind:'calendar.update',status:'proposed',event:{title,start:'2099-01-01T10:00:00Z',end:'2099-01-01T11:00:00Z',timeZone:'UTC',allDay:false,location:'',description:''},related:{event:{title:'Generated prior',start:null,end:null},target:{deviceId:'fixture',calendarId:'generated'}},evidence:[]}],total:1,nextCursor:null,targets:[],settings:{enabled:false,timeZone:'UTC',reviewDeviceIds:[]},progress:{configured:true,running:false,jobs:[],error:null}};
  return {items:[]};
 },setAgentTimeout:()=>{}} as Api;
 await act(async()=>root.render(React.createElement(Actions,{api,onOpen:()=>{}})));
 await act(async()=>button(d,'核对变更').click());
 const dialog=()=>d.querySelector<HTMLFormElement>('[role="dialog"]')!;
 assert.equal(dialog().querySelector<HTMLInputElement>('input[required]')!.value,title);
 version=2;title='Generated correction from another client';await act(async()=>resources(api).get('/api/actions?cursor=0').refresh());
 assert.equal(dialog().querySelector<HTMLInputElement>('input[required]')!.value,'Generated original schedule','polling must not silently replace reviewed fields');
 assert.equal(button(d,'确认变更').disabled,true);
 await act(async()=>dialog().dispatchEvent(new d.defaultView!.Event('submit',{bubbles:true,cancelable:true})));
 assert.equal(writes.length,0,'a stale review cannot send the newer version with older fields');
 await act(async()=>button(d,'重新核对最新建议').click());
 assert.equal(dialog().querySelector<HTMLInputElement>('input[required]')!.value,title);
 await act(async()=>dialog().dispatchEvent(new d.defaultView!.Event('submit',{bubbles:true,cancelable:true})));
 assert.equal(writes.length,1);assert.equal(writes[0].version,2);assert.equal(writes[0].event.title,title);
});
test('Actions consumes operation changes through the shared resource and explains blocked/cancelled analysis safely',async t=>{
 const {root,d}=await fixture(t);let resolve!:(value:unknown)=>void,reads=0,changed=false;const change=new Promise(r=>{resolve=r;});
 const api={request:async(path:string)=>{if(path.startsWith('/api/operations/changes'))return change;if(path.startsWith('/api/actions?')){reads++;return {items:[],total:0,nextCursor:null,targets:[],settings:{enabled:true,timeZone:'UTC',reviewDeviceIds:[]},progress:{configured:true,running:false,jobs:changed?[{status:'blocked',count:3},{status:'cancelled',count:2}]:[{status:'pending',count:5}],error:changed?'PRIVATE ENGINE RAW ERROR':null,errorCode:changed?'action_analysis_failed':null}};}return {items:[],nextCursor:null};},setAgentTimeout:()=>{}} as Api;
 await act(async()=>root.render(React.createElement(Actions,{api,onOpen:()=>{}})));assert.equal(reads,1);assert.match(d.body.textContent!,/待分析 5 批/);
 changed=true;await act(async()=>resolve({ids:['workflow:actions:generated'],cursor:1,reset:false,hasMore:false}));assert.equal(reads,2);assert.match(d.body.textContent!,/等待条件满足 3 批.*已停止分析 2 批/);assert.match(d.body.textContent!,/日程分析未完成，请查看批次状态后重试/);assert.doesNotMatch(d.body.textContent!,/PRIVATE ENGINE RAW ERROR|blocked|cancelled/);
});
test('Operation detail identifies Actions and both embedding steps, routes to Actions and counts optional issues as settled',async t=>{
 const {root,d}=await fixture(t),navigations:string[]=[];const operation={id:'workflow:actions:generated',kind:'workflow',state:'succeeded',total:4,notScheduled:0,optionalIssues:1,counts:{waiting:0,running:0,blocked:0,failed:0,cancelled:0,succeeded:3,stale:0,skipped:0},updatedAt:Date.now()};
 const api={request:async(path:string)=>{if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:1,reset:false,hasMore:false};if(path.startsWith('/api/processing?'))return {jobs:[],processors:[],limit:30};if(path.startsWith('/api/operations?'))return {items:[operation]};return {operation,steps:['actions.extract','embedding.capture','embedding.file','embedding.query.generated'].map((kind,i)=>({id:kind,kind,state:i===2?'failed':'succeeded',reason:i===2?'embedding_http':null,attempts:1,dependencies:[],current:true,optional:i>0})),nextCursor:null};},setAgentTimeout:()=>{}} as Api;
 await act(async()=>root.render(React.createElement(Processing,{api,onNavigate:page=>navigations.push(page)})));assert.match(d.body.textContent!,/已完成 3 \/ 3 步.*1 个可选步骤未完成/);assert.equal(d.querySelector('progress')!.value,d.querySelector('progress')!.max);
 await act(async()=>button(d,'查看详情').click());const detail=d.querySelector('[aria-label="任务详情"]')!;assert.match(detail.textContent!,/日程分析/);assert.match(detail.textContent!,/记录向量索引/);assert.match(detail.textContent!,/文件片段向量索引/);assert.match(detail.textContent!,/检索向量计算/);assert.match(detail.textContent!,/embedding_http/);await act(async()=>button(d,'打开来源与处理操作').click());assert.deepEqual(navigations,['actions']);
});
test('Actions and optional Indexer operation IDs invalidate affected domains without reloading unrelated settings',()=>{
 const actions=new Set(['workflow:actions:generated']);assert.equal(affectedResource('/api/actions?cursor=4',actions,false),true);assert.equal(affectedResource('/api/actions',new Set(['workflow:lifecycle:generated']),false),false);assert.equal(affectedResource('/api/actions',new Set(),true),true);
 for(const id of ['capture:generated','file:generated']){for(const path of ['/api/files/generated','/api/capture-browser/generated','/api/conversations/generated','/api/conversations?limit=30','/api/query-runs/generated','/api/operations/'+encodeURIComponent(id)])assert.equal(affectedResource(path,new Set([id]),false),true);assert.equal(affectedResource('/api/model-settings',new Set([id]),false),false);}
 const index=new Set(['material-index:generated']);for(const path of ['/api/materials/generated','/api/materials?limit=12','/api/agent-view/material-read?ref=generated'])assert.equal(affectedResource(path,index,false),true);assert.equal(affectedResource('/api/model-settings',index,false),false);
});
test('failed material index operations offer an index-only retry and route to the library',async t=>{
 const {root,d}=await fixture(t),writes:string[]=[],navigation:string[]=[];
 const operation={id:'material-index:generated',kind:'material-index',state:'failed',total:1,notScheduled:0,counts:{waiting:0,running:0,blocked:0,failed:1,cancelled:0,succeeded:0,stale:0,skipped:0},updatedAt:Date.now()};
 const api={request:async(path:string,init?:RequestInit)=>{if(init?.method==='POST'){writes.push(path);return {indexing:{state:'pending'}};}if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:1,reset:false,hasMore:false};if(path.startsWith('/api/processing?'))return {jobs:[],processors:[],limit:30};if(path.startsWith('/api/operations?'))return {items:[operation]};return {operation,steps:[{id:'generated',kind:'material.index',state:'failed',attempts:1,dependencies:[],current:true}],nextCursor:null};},setAgentTimeout:()=>{}} as Api;
 await act(async()=>root.render(React.createElement(Processing,{api,onNavigate:page=>navigation.push(page)})));
 await act(async()=>button(d,'查看详情').click());assert.match(d.querySelector('[aria-label="任务详情"]')!.textContent!,/资料检索索引/);
 await act(async()=>button(d,'仅重试检索索引').click());assert.deepEqual(writes,['/api/materials/generated/index/retry']);
 await act(async()=>button(d,'打开来源与处理操作').click());assert.deepEqual(navigation,['library']);
});

test('task pagination returns from page three to two and resets boundaries when filters or page size change',async t=>{
 const {root,d}=await fixture(t),reads:string[]=[];
 const api={request:async(path:string)=>{
  reads.push(path);if(path.startsWith('/api/operations/changes'))return new Promise(()=>{});
  const query=new URL('http://fixture'+path).searchParams,offset=Number(query.get('cursor')??0),limit=Number(query.get('limit'));
  const state=query.get('state');return {items:state?[]:Array.from({length:limit},(_,i)=>({id:'file:generated-'+(offset+i),kind:'file',state:'succeeded',total:1,notScheduled:0,counts:{succeeded:1},updatedAt:1})),nextCursor:offset+limit,changeCursor:0};
 },setAgentTimeout:()=>{}} as Api;
 await act(async()=>root.render(React.createElement(Processing,{api,onNavigate:()=>{}})));
 const paging=()=>d.querySelector('[aria-label="任务分页"]')!,ids=()=>Array.from(d.querySelectorAll('.operation-title code')).map(e=>e.textContent);
 assert.equal(d.querySelectorAll('.operation-row').length,10);assert.equal(button(d,'上一页').disabled,true);
 await act(async()=>button(d,'下一页').click());const second=ids();assert.match(paging().textContent!,/第 2 页/);
 await act(async()=>button(d,'下一页').click());assert.match(paging().textContent!,/第 3 页/);
 await act(async()=>button(d,'上一页').click());assert.deepEqual(ids(),second);assert.match(paging().textContent!,/第 2 页/);
 async function select(label:string,value:string){await act(async()=>{const field=d.querySelector<HTMLSelectElement>('select[aria-label="'+label+'"]')!;field.value=value;field.dispatchEvent(new d.defaultView!.Event('change',{bubbles:true}));});}
 await select('任务状态','blocked');assert.match(paging().textContent!,/第 1 页/);assert.equal(d.querySelectorAll('.operation-row').length,0);assert.equal(button(d,'上一页').disabled,true);
 assert(reads.some(path=>path.includes('state=blocked')&&!path.includes('cursor=')));
 await select('任务状态','');await select('每页条数','20');assert.equal(d.querySelectorAll('.operation-row').length,20);assert.match(paging().textContent!,/第 1 页/);
 await select('任务类型','capture');assert(reads.at(-1)?.includes('kind=capture'));assert(!reads.at(-1)?.includes('cursor='));
 assert(!reads.some(path=>path.startsWith('/api/processing')),'closed advanced list does not fetch or render another task centre');
});
