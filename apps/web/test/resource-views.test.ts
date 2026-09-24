import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {Memories} from '../src/Memories.js';
import {Files,FileDetail} from '../src/Files.js';
import {Sources} from '../src/Sources.js';
import {ReferenceDetail} from '../src/ReferenceDetail.js';
import {ApiError,type Api} from '../src/api.js';
const ids=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
function deferred(){let resolve!:(value:any)=>void,reject!:(value:unknown)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function fixture(t:any){const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),backups=new Map<string,PropertyDescriptor|undefined>();for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){backups.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}dom.window.localStorage.setItem('mote.language','zh-CN');const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());for(const [key,descriptor] of backups){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});return {root,document:dom.window.document};}
function apiWith(read:(path:string,init?:RequestInit)=>unknown):Api{return {request:async(path:string,init?:RequestInit)=>{if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};if(path==='/api/model-settings')return {settings:{agentTimeoutMs:120000},profiles:[]};if(path==='/api/memory-jobs')return {items:[]};if(path==='/api/execution-settings')return {queues:{agents:{active:0,waiting:0,limit:1},llm:{active:0,waiting:0,limit:1}}};if(path==='/api/file-processing')return null;if(path==='/api/connectors/status')return {};return await read(path,init);},setAgentTimeout:()=>{}} as Api;}
const memory=(id:string)=>({id,title:'Generated '+id[0],statement:'Current evidence '+id[0],status:'published',createdAt:'2020-01-01T00:00:00Z',evidenceIds:[]});
test('Memory selection and scope changes fence uncooperative late detail replies and errors do not look empty',async t=>{
 const {root,document:d}=await fixture(t),a=deferred(),b=deferred();let failure=false;const api=apiWith(path=>{if(path.startsWith('/api/memories?')){if(failure)throw new ApiError('generated offline',503);return {items:ids.map(memory),nextCursor:null};}return path.split('?')[0].endsWith(ids[0])?a.promise:b.promise;});
 await act(async()=>root.render(React.createElement(Memories,{api,range:{},onOpen:()=>{}})));const buttons=d.querySelectorAll<HTMLButtonElement>('.workspace-select');
 await act(async()=>buttons[0].click());await act(async()=>buttons[1].click());await act(async()=>b.resolve(memory(ids[1])));await act(async()=>a.resolve(memory(ids[0])));
 assert.equal(d.querySelector('.memory-detail h2')?.textContent,'Generated b');assert.doesNotMatch(d.querySelector('.workspace-content')!.textContent!,/Current evidence a/);
 failure=true;await act(async()=>root.render(React.createElement(Memories,{api,range:{after:'2025-01-01T00:00:00Z'},onOpen:()=>{}})));assert.match(d.body.textContent!,/generated offline/);assert.doesNotMatch(d.body.textContent!,/这里还没有记忆/);assert.equal(d.querySelector('.memory-detail'),null);
});
test('Files session changes and failed reads cannot publish an old list or a false empty state',async t=>{
 const {root,document:d}=await fixture(t),old=deferred(),fresh=deferred();const reader=(pending:ReturnType<typeof deferred>)=>apiWith(path=>path==='/api/sources'?{items:[]}:pending.promise);
 await act(async()=>root.render(React.createElement(Files,{api:reader(old),onOpen:()=>{}})));assert.doesNotMatch(d.body.textContent!,/尚无匹配文件/);
 await act(async()=>root.render(React.createElement(Files,{api:reader(fresh),onOpen:()=>{}})));await act(async()=>fresh.reject(new ApiError('generated unavailable',503)));await act(async()=>old.resolve({items:[{captureId:ids[0],sizeBytes:1,item:{title:'OLD LIST',observedAt:'2020-01-01T00:00:00Z'}}],nextCursor:null}));
 assert.match(d.body.textContent!,/generated unavailable/);assert.doesNotMatch(d.body.textContent!,/OLD LIST|尚无匹配文件/);
});
test('Source history selections do not display a previously requested version list',async t=>{
 const {root,document:d}=await fixture(t),a=deferred(),b=deferred();const api=apiWith(path=>path==='/api/sources'?{items:[]}:path.startsWith('/api/source-items?')?{items:ids.map((captureId,i)=>({captureId,sourceId:'generated',externalId:String(i),title:'Source '+i,layer:'original',observedAt:'2020-01-01T00:00:00Z',text:''})),nextCursor:null}:path.endsWith('externalId=0')?a.promise:b.promise);
 await act(async()=>root.render(React.createElement(Sources,{api,mode:'library',onOpen:()=>{},onImport:()=>{}})));const history=Array.from(d.querySelectorAll<HTMLButtonElement>('button')).filter(x=>x.textContent==='查看版本');await act(async()=>history[0].click());await act(async()=>history[1].click());
 await act(async()=>b.resolve({items:[{captureId:ids[1],observedAt:'2024-02-02T00:00:00Z',current:true}]}));await act(async()=>a.resolve({items:[{captureId:ids[0],observedAt:'2020-01-01T00:00:00Z',deleted:true}]}));assert.match(d.querySelector('.source-history')!.textContent!,/当前版本/);assert.doesNotMatch(d.querySelector('.source-history')!.textContent!,/来源报告已移除/);
});
test('File details show read failure and never silently disappear',async t=>{const {root,document:d}=await fixture(t);const api=apiWith(()=>{throw new ApiError('generated forbidden',403);});await act(async()=>root.render(React.createElement(FileDetail,{api,id:ids[0],onOpen:()=>{}})));assert.match(d.querySelector('[role=alert]')!.textContent!,/generated forbidden/);assert.match(d.body.textContent!,/重新读取/);});
test('pinned derived refs retain the same identity through text continuation and deletion',async t=>{
 const {root,document:d}=await fixture(t),ref='artifact:generated:revision-1',bodies:any[]=[];let deleted=false;const api=apiWith((_path,init)=>{const body=JSON.parse(String(init?.body));bodies.push(body);return deleted?{items:[],missingRefs:[ref]}:{items:[{ref,id:'generated',kind:'artifact',text:body.offset?'tail':'head',textRange:{offset:body.offset,total:8,nextOffset:body.offset?null:4},evidenceRefs:[ids[0]]}],missingRefs:[]};});
 await act(async()=>root.render(React.createElement(ReferenceDetail,{api,reference:ref,onOpen:()=>{}})));await act(async()=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent==='继续展开')!.click());assert.match(d.body.textContent!,/headtail/);assert.deepEqual(bodies.map(b=>b.refs),[[ref],[ref]]);
 deleted=true;await act(async()=>root.render(React.createElement(ReferenceDetail,{key:'reload',api,reference:ref,onOpen:()=>{}})));assert.match(d.body.textContent!,/资料不存在或已删除/);assert.doesNotMatch(d.body.textContent!,/headtail/);
});

test('budget editor preserves a stale draft on conflict and reloads before saving its new revision',async t=>{
 const {ModelBudgets}=await import('../src/ModelBudgets.js');const {root,document:d}=await fixture(t);let revision=7,conflict=true;const writes:any[]=[];
 const value=()=>({revision,limits:{dailyTokens:null,dailyCost:null,operationTokens:null,operationCost:null,providerDailyTokens:{},providerDailyCost:{},currency:'USD'},day:'2026-09-22',timeZone:'UTC',usage:[{provider:'generated',currency:'USD',tokens:100,cost:null,active:1,unknown:1,runs:2}]});
 const api=apiWith((_path,init)=>{if(init?.method==='PUT'){writes.push(JSON.parse(String(init.body)));if(conflict){revision=8;throw new ApiError('stale',409);}return {...value(),revision:++revision,limits:writes.at(-1).limits};}return value();});
 await act(async()=>root.render(React.createElement(ModelBudgets,{api})));assert.match(d.body.textContent!,/未知用量保留预留额度/);assert.match(d.body.textContent!,/Codex 内置循环/);assert.match(d.body.textContent!,/未估算/);
 const change=async()=>{const select=d.querySelector<HTMLSelectElement>('select')!;await act(async()=>{select.value='CNY';select.dispatchEvent(new window.Event('change',{bubbles:true}));});};
 const submit=async()=>{await act(async()=>d.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));};
 await change();await submit();assert.equal(writes[0].revision,7);assert.equal(d.querySelector('select')!.value,'CNY');assert.match(d.querySelector('[role=alert]')!.textContent!,/当前修改已保留/);
 await act(async()=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent==='放弃修改并重新加载')!.click());assert.equal(d.querySelector('select')!.value,'USD');conflict=false;await change();await submit();assert.equal(writes[1].revision,8);assert.equal(writes[1].limits.currency,'CNY');assert.deepEqual(Object.keys(writes[1]).sort(),['limits','revision']);assert.match(d.body.textContent!,/已保存，立即生效/);
});

test('model selectors share configuration reads and fence late provider catalogs',async t=>{
 const {ModelSelector}=await import('../src/ModelSelector.js');const {root,document:d}=await fixture(t),old=deferred(),fresh=deferred();let settingsReads=0;
 const api={request:async(path:string)=>{if(path==='/api/model-settings'){settingsReads++;return {settings:{agentTimeoutMs:120000},profiles:[{id:'a',name:'A',settings:{agentTimeoutMs:120000,model:'model-a'}},{id:'b',name:'B',settings:{agentTimeoutMs:120000,model:'model-b'}}],defaults:{query:'a'}};}return path.includes('/a/')?old.promise:fresh.promise;},setAgentTimeout:()=>{}} as Api;
 const render=(value:string)=>React.createElement(React.Fragment,null,...[0,1].map(key=>React.createElement(ModelSelector,{key,api,feature:'query',value,onChange:()=>{},onModelChange:()=>{}})));
 await act(async()=>root.render(render('a')));assert.equal(settingsReads,1);assert.equal(new Set(Array.from(d.querySelectorAll('datalist')).map(x=>x.id)).size,2);
 await act(async()=>root.render(render('b')));await act(async()=>fresh.resolve({items:[{id:'fresh',name:'Fresh generated model'}]}));await act(async()=>old.resolve({items:[{id:'stale',name:'STALE generated model'}]}));
 assert.match(d.body.textContent!,/Fresh generated model/);assert.doesNotMatch(d.body.textContent!,/STALE generated model/);
});
test('file processing settings preserve edited drafts on refresh, show source errors and clear revoked data',async t=>{
 const {FileProcessingSettings}=await import('../src/FileProcessingSettings.js'),{resources}=await import('../src/resource-cache.js');const {root,document:d}=await fixture(t);let forbidden=false,revision=1;
 const api={request:async(path:string)=>{if(path==='/api/sources')throw new ApiError('generated source unavailable',503);if(forbidden)throw new ApiError('generated permission revoked',403);return {revision,settings:{enabled:true,maxAudioMinutes:60,timeoutMs:1000},policy:{profiles:[],rules:[],services:[]},processors:[]};},setAgentTimeout:()=>{}} as Api;
 await act(async()=>root.render(React.createElement(FileProcessingSettings,{api})));assert.match(d.body.textContent!,/generated source unavailable/);
 const checkbox=d.querySelector<HTMLInputElement>('input[type=checkbox]')!;await act(async()=>checkbox.click());assert.equal(checkbox.checked,false);
 revision++;await act(async()=>resources(api).invalidate(key=>key==='/api/file-processing'));assert.equal(d.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,false);assert.match(d.body.textContent!,/有未保存修改/);
 forbidden=true;await act(async()=>resources(api).invalidate(key=>key==='/api/file-processing'));assert.match(d.body.textContent!,/generated permission revoked/);assert.equal(d.querySelector('form'),null);
});
test('successful evidence read displays archival presence independently of unknown processing',async t=>{
 const {EvidenceState}=await import('../src/EvidenceState.js');const {root,document:d}=await fixture(t);await act(async()=>root.render(React.createElement(EvidenceState)));
 assert.equal(d.querySelector('[data-archive-state]')?.getAttribute('data-archive-state'),'acknowledged');assert.equal(d.querySelector('[data-processing-state]')?.getAttribute('data-processing-state'),'unknown');assert.doesNotMatch(d.body.textContent!,/记忆已完成/);
});

test('budget settings explain reservations and remove editable drafts after revocation or session change',async t=>{
 const {ModelBudgets}=await import('../src/ModelBudgets.js'),{resources}=await import('../src/resource-cache.js'),{root,document:d}=await fixture(t);let revoked=false;
 const value=(currency='USD')=>({minimumInputReservationTokens:128000,revision:1,limits:{dailyTokens:300000,dailyCost:null,operationTokens:null,operationCost:null,providerDailyTokens:{},providerDailyCost:{},currency},day:'2026-09-23',timeZone:'UTC',usage:[]});
 const api=apiWith(()=>{if(revoked)throw new ApiError('Generated budget revoked',403);return value();});
 await act(async()=>root.render(React.createElement(ModelBudgets,{api})));assert.match(d.body.textContent!,/128,000 个输入 token/);
 await act(async()=>{const input=d.querySelector('select')!;input.value='CNY';input.dispatchEvent(new window.Event('change',{bubbles:true}));});
 revoked=true;await act(async()=>resources(api).invalidate(key=>key==='/api/model-budgets'));assert.equal(d.querySelector('form'),null);assert.match(d.body.textContent!,/Generated budget revoked/);
 const next=apiWith(()=>value());await act(async()=>root.render(React.createElement(ModelBudgets,{api:next})));assert.equal(d.querySelector('select')!.value,'USD');assert.doesNotMatch(d.body.textContent!,/Generated budget revoked/);
});
