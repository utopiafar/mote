import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {Conversations} from '../src/Conversations.js';
import {Insights} from '../src/Insights.js';
import {Connections} from '../src/Connections.js';
import {RuntimeSettings,ExecutionQueueOverview} from '../src/RuntimeSettings.js';
import {PerceptionSettings} from '../src/PerceptionSettings.js';
import {ApiError,type Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';
import {configureLocale} from '@mote/shared/i18n';
configureLocale(()=> 'zh-CN');
function deferred(){let resolve!:(value:any)=>void,reject!:(error:unknown)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function fixture(t:any){const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>();for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}dom.window.HTMLElement.prototype.scrollIntoView=()=>{};const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});return {root,d:dom.window.document};}
function apiWith(read:(path:string,init?:RequestInit)=>unknown):Api{return {request:async(path:string,init?:RequestInit)=>{if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};if(path==='/api/model-settings')return {settings:{agentTimeoutMs:120000},profiles:[]};return read(path,init);},setAgentTimeout:()=>{}} as Api;}
const when='2026-01-01T00:00:00Z',summary=(id:string)=>({id,title:'Conversation '+id,createdAt:when,updatedAt:when,turnCount:1,scope:{},status:'completed'}),detail=(id:string)=>({...summary(id),turns:[{id:'turn-'+id,question:'Question '+id,status:'completed',createdAt:when,result:{answer:'Answer '+id,citations:[],trace:[],runId:id}}],nextCursor:'older'});
const button=(d:Document,text:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent===text)!;
test('conversation restore, detail and older-page replies cannot replace later owner selection',async t=>{
 const {root,d}=await fixture(t),restore=deferred(),a=deferred(),old=deferred();
 const api=apiWith(path=>path==='/api/conversations?limit=30'?{items:['A','B'].map(summary)}:path==='/api/query-runs'?restore.promise:path.includes('?cursor=')?old.promise:path.endsWith('/A')?a.promise:detail('B'));
 await act(async()=>root.render(React.createElement(Conversations,{api,configured:true,devices:[],range:{},renderAnswer:a=>a.answer})));
 const rows=d.querySelectorAll<HTMLButtonElement>('.conversation-item');await act(async()=>rows[0].click());await act(async()=>rows[1].click());
 await act(async()=>a.resolve(detail('A')));await act(async()=>restore.resolve({items:[{id:'old-run',status:'completed',conversationId:'A'}]}));
 assert.match(d.querySelector('.conversation-messages')!.textContent!,/Answer B/);assert.doesNotMatch(d.querySelector('.conversation-messages')!.textContent!,/Answer A/);
 await act(async()=>button(d,'加载更早的对话').click());await act(async()=>rows[0].click());await act(async()=>old.resolve({...detail('B'),turns:[{...detail('B').turns[0],id:'older-B',question:'STALE OLDER'}]}));
 assert.doesNotMatch(d.querySelector('.conversation-messages')!.textContent!,/STALE OLDER|Answer B/);
});
test('insight reads isolate sessions and show skills failures without a false empty history',async t=>{
 const {root,d}=await fixture(t),old=deferred();const first=apiWith(path=>path==='/api/skills'?{items:[]}:old.promise),next=apiWith(path=>{if(path==='/api/skills')throw new ApiError('generated abilities failure',503);return {items:[]};});
 const view=(api:Api)=>React.createElement(Insights,{api,range:{},configured:true,onOpen:()=>{},onSettings:()=>{},onChanged:()=>{}});
 await act(async()=>root.render(view(first)));assert.doesNotMatch(d.body.textContent!,/第一份洞察会保存在这里/);
 await act(async()=>root.render(view(next)));await act(async()=>old.resolve({items:[{runId:'old',artifact:{title:'OLD PRIVATE REPORT'},citations:[],answer:'old'}]}));
 assert.match(d.body.textContent!,/generated abilities failure/);assert.doesNotMatch(d.body.textContent!,/OLD PRIVATE REPORT/);
});
test('connection reads share cache and reject stale authenticated inventories',async t=>{
 const {root,d}=await fixture(t),old=deferred();const first=apiWith(path=>path==='/api/configuration'?{groups:[]}:old.promise),next=apiWith(path=>path==='/api/configuration'?Promise.reject(new ApiError('generated configuration unavailable',503)):{items:[],mcp:{enabled:false,writeEnabled:false,writeSourceIds:[]}});
 await act(async()=>root.render(React.createElement(Connections,{api:first,serverUrl:'http://localhost',devices:[]})));await act(async()=>root.render(React.createElement(Connections,{api:next,serverUrl:'https://generated.example',devices:[]})));
 await act(async()=>old.resolve({items:[{id:'old',label:'OLD PRIVATE DEVICE',scope:'collector',createdAt:when}],mcp:{enabled:true}}));
 assert.doesNotMatch(d.body.textContent!,/OLD PRIVATE DEVICE/);assert.match(d.body.textContent!,/generated configuration unavailable/);assert.equal(d.querySelector<HTMLInputElement>('[aria-label="邀请节点地址"]')!.value,'https://generated.example');
});
test('execution overview shares initial settings read; dirty runtime draft survives updates and clears after revocation',async t=>{
 const {root,d}=await fixture(t);let count=0,enabled=true,revoked=false;const value=()=>({enabled,debug:false,traceEnabled:false,level:'info',queues:{agents:{active:0,waiting:0,limit:1},llm:{active:0,waiting:0,limit:1}}});
 const api=apiWith(()=>{count++;if(revoked)throw new ApiError('generated revoked',403);return value();});
 await act(async()=>root.render(React.createElement(React.Fragment,null,React.createElement(RuntimeSettings,{api,kind:'execution'}),React.createElement(ExecutionQueueOverview,{api}))));assert.equal(count,1);
 await act(async()=>d.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());assert.equal(d.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,false);
 await act(async()=>resources(api).invalidate(path=>path==='/api/execution-settings'));assert.equal(d.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,false);
 revoked=true;await act(async()=>resources(api).invalidate(path=>path==='/api/execution-settings'));assert.equal(d.querySelector('form'),null);assert.match(d.body.textContent!,/generated revoked/);
});
test('perception refresh retains owner draft and revoked settings never remain editable',async t=>{
 const {root,d}=await fixture(t);let revoked=false;const api=apiWith(()=>{if(revoked)throw new ApiError('generated permission revoked',403);return {settings:{providerRevision:'1',enabled:true,ocrEndpoint:'',allowExternalProcessing:false,allowQueryImages:false},recent:[],jobs:[]};});
 await act(async()=>root.render(React.createElement(PerceptionSettings,{api})));assert.doesNotMatch(d.body.textContent!,/语义理解 Worker 地址|语义理解时机/);await act(async()=>d.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());await act(async()=>button(d,'刷新').click());assert.equal(d.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,false);
 revoked=true;await act(async()=>button(d,'刷新').click());assert.equal(d.querySelector('form'),null);assert.match(d.body.textContent!,/generated permission revoked/);
});

test('Memory settings preserve edited policy on refresh, save current draft, and isolate a new session',async t=>{
 const {MemorySettings}=await import('../src/MemorySettings.js'),{root,d}=await fixture(t);const policy={enabled:true,intervalHours:6,maxWaitHours:6,minChanges:1,maxItems:10};let revoked=false,writes:any[]=[];
 const settings={drainWindows:5,extraction:policy,consolidation:policy,insights:policy,working:policy,batchCharacters:500,recentTurns:2,contextCharacters:4000,summaryCharacters:1000};let current=structuredClone(settings);
 const api=apiWith((_path,init)=>{if(revoked)throw new ApiError('generated Memory revoked',403);if(init?.method==='PUT'){current=JSON.parse(String(init.body));writes.push(current);}return {settings:structuredClone(current),extensions:[]};});
 await act(async()=>root.render(React.createElement(MemorySettings,{api})));await act(async()=>d.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
 await act(async()=>resources(api).invalidate(key=>key==='/api/memory-settings'));assert.equal(d.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,false);
 await act(async()=>d.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));assert.equal(writes[0].extraction.enabled,false);assert.match(d.body.textContent!,/设置已保存/);
 revoked=true;await act(async()=>resources(api).invalidate(key=>key==='/api/memory-settings'));assert.equal(d.querySelector('form'),null);assert.match(d.body.textContent!,/generated Memory revoked/);
 const next=apiWith(()=>({settings,extensions:[]}));await act(async()=>root.render(React.createElement(MemorySettings,{api:next})));assert.equal(d.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,true);assert.doesNotMatch(d.body.textContent!,/generated Memory revoked/);
});
test('Memory progress readers share pending reads and fence another selected job',async t=>{
 const {useMemoryJob}=await import('../src/MemoryProgress.js'),{root,d}=await fixture(t),a=deferred(),b=deferred();let reads=0;
 const api=apiWith(path=>{reads++;return path.endsWith('/A')?a.promise:b.promise;});
 function View({id}:{id:string}){const state=useMemoryJob(api,id);return React.createElement('p',null,state.job?.id??'loading');}
 const view=(id:string)=>React.createElement(React.Fragment,null,React.createElement(View,{id}),React.createElement(View,{id}));
 await act(async()=>root.render(view('A')));assert.equal(reads,1);await act(async()=>root.render(view('B')));assert.equal(reads,2);
 await act(async()=>b.resolve({id:'B',status:'completed'}));await act(async()=>a.resolve({id:'A',status:'running'}));assert.equal(d.body.textContent,'BB');
});
test('configuration views share reads and discard revoked deployment details',async t=>{
 const {ServerSettings,AdvancedConfiguration}=await import('../src/ServerSettings.js'),{root,d}=await fixture(t);let reads=0,revoked=false;
 const api=apiWith(path=>{if(path==='/api/configuration'){reads++;if(revoked)throw new ApiError('generated configuration revoked',403);return {profile:'fixture',runtime:'node',description:'fixture',storage:{dataDir:'PRIVATE FIXTURE DIRECTORY'},groups:[]};}return {enabled:false,debug:false,traceEnabled:false,level:'info'};});
 await act(async()=>root.render(React.createElement(React.Fragment,null,React.createElement(ServerSettings,{api,onNavigate:()=>{},onModelApplied:()=>{}}),React.createElement(AdvancedConfiguration,{api}))));assert.equal(reads,1);assert.match(d.body.textContent!,/PRIVATE FIXTURE DIRECTORY/);
 revoked=true;await act(async()=>resources(api).invalidate(path=>path==='/api/configuration'));assert.doesNotMatch(d.body.textContent!,/PRIVATE FIXTURE DIRECTORY/);assert.match(d.body.textContent!,/generated configuration revoked/);
});
test('model assignment refresh preserves owner choices and their original revision until save',async t=>{
 const {ModelAssignments}=await import('../src/ModelAssignments.js'),{MODEL_FEATURES}=await import('@mote/shared/models'),{root,d}=await fixture(t);let revision=1,revoked=false;const writes:any[]=[];
 const view=()=>({revision,profiles:[{id:'a',name:'A',settings:{model:'a'}},{id:'b',name:'B',settings:{model:'b'}}],defaults:Object.fromEntries(MODEL_FEATURES.map(feature=>[feature,'a'])),defaultModels:{}});
 const api={request:async(path:string,init?:RequestInit)=>{if(revoked)throw new ApiError('generated models revoked',403);if(init?.method==='PUT'){writes.push(JSON.parse(String(init.body)));throw new ApiError('generated conflict',409);}return view();}} as Api;
 await act(async()=>root.render(React.createElement(ModelAssignments,{api,revision:1,onApplied:()=>{},onManage:()=>{}})));
 const choice=d.querySelector<HTMLSelectElement>('.module-assignment-row select')!;await act(async()=>{choice.value='b';choice.dispatchEvent(new window.Event('change',{bubbles:true}));});revision=2;
 await act(async()=>resources(api).invalidate(key=>key==='/api/model-settings'));assert.equal(d.querySelector<HTMLSelectElement>('.module-assignment-row select')!.value,'b');await act(async()=>button(d,'保存模块分配').click());assert.equal(writes[0].revision,1);assert.equal(writes[0].defaults[MODEL_FEATURES[0]],'b');
 revoked=true;await act(async()=>resources(api).invalidate(key=>key==='/api/model-settings'));assert.equal(d.querySelector('.module-assignment-row'),null);
});

test('Markdown citation renderer retains the exact focused control across parent and cache refreshes',async t=>{
 const {AnswerMarkdown}=await import('../src/AnswerMarkdown.js'),{root,d}=await fixture(t),id='memory:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',onOpen=()=>{};
 const answer=()=>({answer:'Generated citation ['+id+']',runId:'fixture',trace:[],citations:[{id,appName:'Generated',excerpt:'Generated',capturedAt:when}]});
 await act(async()=>root.render(React.createElement(AnswerMarkdown,{answer:answer(),onOpen})));const original=d.querySelector<HTMLButtonElement>('.inline-citation')!;original.focus();
 await act(async()=>root.render(React.createElement(AnswerMarkdown,{answer:answer(),onOpen})));assert.equal(original.isConnected,true);assert.equal(d.activeElement,original);
});
