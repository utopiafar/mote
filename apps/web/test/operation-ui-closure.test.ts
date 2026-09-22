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
configureLocale(()=> 'zh-CN');
async function fixture(t:any){const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>();for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});return {root,d:dom.window.document};}
const button=(d:Document,label:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent===label)!;
test('Actions consumes operation changes through the shared resource and explains blocked/cancelled analysis safely',async t=>{
 const {root,d}=await fixture(t);let resolve!:(value:unknown)=>void,reads=0,changed=false;const change=new Promise(r=>{resolve=r;});
 const api={request:async(path:string)=>{if(path.startsWith('/api/operations/changes'))return change;if(path.startsWith('/api/actions?')){reads++;return {items:[],total:0,nextCursor:null,targets:[],settings:{enabled:true,timeZone:'UTC',reviewDeviceIds:[]},progress:{configured:true,running:false,jobs:changed?[{status:'blocked',count:3},{status:'cancelled',count:2}]:[{status:'pending',count:5}],error:changed?'PRIVATE ENGINE RAW ERROR':null,errorCode:changed?'action_analysis_failed':null}};}return {items:[],nextCursor:null};},setAgentTimeout:()=>{}} as Api;
 await act(async()=>root.render(React.createElement(Actions,{api,onOpen:()=>{}})));assert.equal(reads,1);assert.match(d.body.textContent!,/待分析 5 批/);
 changed=true;await act(async()=>resolve({ids:['workflow:actions:generated'],cursor:1,reset:false,hasMore:false}));assert.equal(reads,2);assert.match(d.body.textContent!,/等待条件满足 3 批.*已停止分析 2 批/);assert.match(d.body.textContent!,/日程分析未完成，请查看批次状态后重试/);assert.doesNotMatch(d.body.textContent!,/PRIVATE ENGINE RAW ERROR|blocked|cancelled/);
});
test('Operation detail identifies Actions and both embedding steps, routes to Actions and counts optional issues as settled',async t=>{
 const {root,d}=await fixture(t),navigations:string[]=[];const operation={id:'workflow:actions:generated',kind:'workflow',state:'succeeded',total:4,notScheduled:0,optionalIssues:1,counts:{waiting:0,running:0,blocked:0,failed:0,cancelled:0,succeeded:3,stale:0,skipped:0},updatedAt:Date.now()};
 const api={request:async(path:string)=>{if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:1,reset:false,hasMore:false};if(path.startsWith('/api/processing?'))return {jobs:[],processors:[],limit:30};if(path==='/api/operations')return {items:[operation]};return {operation,steps:['actions.extract','embedding.capture','embedding.file','embedding.query.generated'].map((kind,i)=>({id:kind,kind,state:i===2?'failed':'succeeded',reason:i===2?'embedding_http':null,attempts:1,dependencies:[],current:true,optional:i>0})),nextCursor:null};},setAgentTimeout:()=>{}} as Api;
 await act(async()=>root.render(React.createElement(Processing,{api,onNavigate:page=>navigations.push(page)})));assert.match(d.body.textContent!,/已完成 3 \/ 3 步.*1 个可选步骤未完成/);assert.equal(d.querySelector('progress')!.value,d.querySelector('progress')!.max);
 await act(async()=>button(d,'查看详情').click());const detail=d.querySelector('[aria-label="任务详情"]')!;assert.match(detail.textContent!,/日程分析/);assert.match(detail.textContent!,/记录向量索引/);assert.match(detail.textContent!,/文件片段向量索引/);assert.match(detail.textContent!,/检索向量计算/);assert.match(detail.textContent!,/embedding_http/);await act(async()=>button(d,'打开来源与处理操作').click());assert.deepEqual(navigations,['actions']);
});
test('Actions and optional Indexer operation IDs invalidate affected domains without reloading unrelated settings',()=>{
 const actions=new Set(['workflow:actions:generated']);assert.equal(affectedResource('/api/actions?cursor=4',actions,false),true);assert.equal(affectedResource('/api/actions',new Set(['workflow:lifecycle:generated']),false),false);assert.equal(affectedResource('/api/actions',new Set(),true),true);
 for(const id of ['capture:generated','file:generated']){for(const path of ['/api/files/generated','/api/capture-browser/generated','/api/operations/'+encodeURIComponent(id)])assert.equal(affectedResource(path,new Set([id]),false),true);assert.equal(affectedResource('/api/model-settings',new Set([id]),false),false);}
});
