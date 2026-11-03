import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import type {ActionProposal,OperationChanges} from '@mote/shared';
import {configureLocale} from '@mote/shared/i18n';
import {ApiError,type Api} from '../src/api.js';

configureLocale(()=> 'zh-CN');
const dom=new JSDOM('<html><body></body></html>',{url:'http://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
const {createRoot}=await import('react-dom/client');
const {ActionResults}=await import('../src/plugins/work/ActionResults.js');
const evidence='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',otherEvidence='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const pathFor=(id=evidence)=>'/api/actions/by-evidence/'+encodeURIComponent(id);
type Row=Pick<ActionProposal,'id'|'status'|'managed'|'resolution'|'kind'>&{title:string};
type Page={items:Row[];hasMore:boolean};
const row=(status:ActionProposal['status']='proposed'):Row=>({id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',kind:'calendar.create',status,title:'Generated private action'});
function generatedActionApi(initial:Page={items:[],hasMore:false}){
 const pages=new Map([[pathFor(),initial]]),reads:{path:string;signal?:AbortSignal|null}[]=[],feeds:{path:string;signal?:AbortSignal|null}[]=[];
 let changes:OperationChanges={cursor:0,ids:[],reset:false,hasMore:false};
 let readHook:((path:string,value:Page,init?:RequestInit)=>unknown)|undefined,feedHook:((value:OperationChanges,init?:RequestInit)=>unknown)|undefined;
 const api={request:async(path:string,init?:RequestInit)=>{
  assert.ok(!init?.method||init.method==='GET','read-only results never issue commands');
  if(path.startsWith('/api/operations/changes?')){feeds.push({path,signal:init?.signal});const value=structuredClone(changes);changes.ids=[];return feedHook?.(value,init)??value;}
  assert.ok(path.startsWith('/api/actions/by-evidence/'),'only the exact evidence resource is requested');reads.push({path,signal:init?.signal});const value=structuredClone(pages.get(path)??{items:[],hasMore:false});return readHook?.(path,value,init)??value;
 }} as Api;
 return{api,pages,reads,feeds,count:(id=evidence)=>reads.filter(read=>read.path===pathFor(id)).length,emit:(ids:string[])=>{changes={...changes,cursor:changes.cursor+1,ids};},read:(hook:typeof readHook)=>readHook=hook,feed:(hook:typeof feedHook)=>feedHook=hook};
}
async function actionClock(t:import('node:test').TestContext,api:Api,id=evidence,copies=1){
 const previous=Object.getOwnPropertyDescriptor(document,'hidden');let hidden=false;Object.defineProperty(document,'hidden',{get:()=>hidden,configurable:true});
 dom.window.history.replaceState(null,'','#/materials?generated=origin');t.mock.timers.enable({apis:['setTimeout']});
 const element=document.createElement('div');document.body.appendChild(element);const root=createRoot(element);
 t.after(async()=>{t.mock.timers.reset();await act(async()=>root.unmount());element.remove();if(previous)Object.defineProperty(document,'hidden',previous);else Reflect.deleteProperty(document,'hidden');});
 const tick=async(ms=0)=>act(async()=>{t.mock.timers.tick(ms);await new Promise<void>(resolve=>setImmediate(resolve));});
 const render=(owner:Api,selected=id,count=copies)=>act(async()=>root.render(React.createElement(React.Fragment,null,...Array.from({length:count},(_,key)=>React.createElement(ActionResults,{key,api:owner,evidenceId:selected})))));
 await render(api);await tick();
 return{element,render,tick,leave:()=>act(async()=>root.render(null)),visibility:async(value:boolean)=>{hidden=value;await act(async()=>document.dispatchEvent(new dom.window.Event('visibilitychange')));}};
}

test('empty shared action results pause hidden60s and read the exact evidence once on foreground, retaining visible15s',async t=>{
 const f=generatedActionApi(),ui=await actionClock(t,f.api,evidence,2);assert.equal(f.count(),1);assert.equal(f.feeds.length,1,'one feed for both observers');
 await ui.visibility(true);f.pages.set(pathFor(),{items:[row()],hasMore:true});await ui.tick(60000);assert.equal(f.count(),1,'no new hidden resource timer GET');assert.equal(f.feeds.length,1,'no new hidden feed timer GET');assert.doesNotMatch(ui.element.textContent!,/Generated private action/);
 await ui.visibility(false);await ui.visibility(false);await ui.tick();assert.equal(f.count(),2,'duplicate foreground events and observers coalesce');assert.equal(ui.element.querySelectorAll('[data-action-id]').length,2);assert.match(ui.element.textContent!,/查看全部行动/);
 await ui.tick(14999);assert.equal(f.count(),2);await ui.tick(1);assert.equal(f.count(),3,'empty/idle correctness does not remove the15s fallback');assert.ok(f.feeds.length>1,'feed GETs counted separately');
});

test('action results subscribe to the existing workflow feed without claiming unrelated events cover ACK or withdrawal',async t=>{
 const f=generatedActionApi(),ui=await actionClock(t,f.api);f.pages.set(pathFor(),{items:[row('approved')],hasMore:false});f.emit(['workflow:actions:generated-analysis']);await ui.tick(1500);assert.equal(f.count(),2);assert.match(ui.element.textContent!,/等待客户端写入/);
 f.pages.set(pathFor(),{items:[row('succeeded')],hasMore:false});f.emit(['workflow:generated-other']);await ui.tick(1500);assert.equal(f.count(),2,'public feed mapping is not broadened');assert.doesNotMatch(ui.element.textContent!,/已完成/);
 await ui.tick(12000);assert.equal(f.count(),3);assert.match(ui.element.textContent!,/已完成/);
});

for(const [status,label] of [['proposed','待确认'],['approved','等待客户端写入'],['executing','正在写入 / 等待回执'],['uncertain','保存结果待核实'],['succeeded','已完成'],['stale','原文已更新或删除'],['dismissed','已忽略']] as const)test(`action ${status} retains the15s no-event recheck and withdraws a remotely removed row`,async t=>{
 const f=generatedActionApi({items:[row(status)],hasMore:false}),ui=await actionClock(t,f.api);assert.match(ui.element.textContent!,new RegExp(label));f.pages.set(pathFor(),{items:[],hasMore:false});await ui.tick(14999);assert.equal(f.count(),1);await ui.tick(1);assert.equal(f.count(),2);assert.equal(ui.element.querySelectorAll('[data-action-id]').length,0);assert.match(ui.element.textContent!,/记为待办/);
});

for(const [state,label] of [['waiting_device','等待客户端写入'],['cancel_requested','已请求取消，写入结果仍待核实']] as const)test(`managed ${state} remains pending until a no-event ACK read`,async t=>{
 const pending={...row('approved'),managed:{grantId:'generated-grant',grantRevision:1,connectionId:'generated-connection',state}},f=generatedActionApi({items:[pending],hasMore:false}),ui=await actionClock(t,f.api);assert.match(ui.element.textContent!,new RegExp(label));f.pages.set(pathFor(),{items:[{...pending,status:'succeeded',managed:{...pending.managed,state:'succeeded'}}],hasMore:false});await ui.tick(15000);assert.equal(f.count(),2);assert.match(ui.element.textContent!,/已完成/);
});

test('foreground hints let a held read finish and coalesce one fresh late-ACK follow-up',async t=>{
 const old={items:[row('uncertain')],hasMore:false},f=generatedActionApi(old);let release!:(value:Page)=>void;f.read(()=>new Promise<Page>(resolve=>release=resolve));const ui=await actionClock(t,f.api);assert.match(ui.element.textContent!,/正在读取行动结果/);await ui.visibility(true);await ui.tick(60000);await ui.visibility(false);await ui.visibility(false);assert.equal(f.count(),1);assert.equal(f.reads[0].signal?.aborted,false);
 f.read(undefined);f.pages.set(pathFor(),{items:[row('succeeded')],hasMore:false});await act(async()=>release(structuredClone(old)));await ui.tick();assert.equal(f.count(),2,'one queued foreground refresh after completion');assert.match(ui.element.textContent!,/已完成/);assert.doesNotMatch(ui.element.textContent!,/保存结果待核实/);
});

for(const status of [401,403,404])test(`foreground action ${status} removes private action links instead of showing a known empty result`,async t=>{
 const f=generatedActionApi({items:[row()],hasMore:true}),ui=await actionClock(t,f.api);await ui.visibility(true);f.read(()=>{throw new ApiError('Generated action read denied '+status,status);});await ui.visibility(false);await ui.tick();assert.equal(Boolean(ui.element.querySelector('[role=alert]')),true,'foreground denial must become visible');assert.match(ui.element.querySelector('[role=alert]')!.textContent!,/Generated action read denied/);assert.equal(ui.element.querySelectorAll('a').length,0,'denial exposes neither cached titles nor create-todo navigation');
 f.read(undefined);f.pages.set(pathFor(),{items:[],hasMore:false});await ui.visibility(true);await ui.visibility(false);await ui.tick();assert.equal(Boolean(ui.element.querySelector('[role=alert]')),false);assert.match(ui.element.textContent!,/记为待办/);
});

for(const failure of ['503','offline','malformed'])test(`action ${failure} remains unavailable through15s rather than claiming no results and then recovers`,async t=>{
 const f=generatedActionApi({items:[row()],hasMore:false}),ui=await actionClock(t,f.api);f.read(()=>{if(failure==='malformed')return{items:null,hasMore:false};if(failure==='offline')throw new TypeError('Generated action offline');throw new ApiError('Generated action unavailable',503);});await ui.tick(15000);assert.equal(Boolean(ui.element.querySelector('[role=alert]')),true);assert.equal(ui.element.querySelectorAll('a').length,0);f.read(undefined);f.pages.set(pathFor(),{items:[row('succeeded')],hasMore:false});await ui.tick(15000);assert.equal(Boolean(ui.element.querySelector('[role=alert]')),false);assert.match(ui.element.textContent!,/已完成/);
});

test('a replaced Api aborts old action and feed reads, ignoring their late private rows and workflow hints',async t=>{
 const first=generatedActionApi();let readDone!:(value:Page)=>void,feedDone!:(value:OperationChanges)=>void;first.read(()=>new Promise<Page>(resolve=>readDone=resolve));first.feed(()=>new Promise<OperationChanges>(resolve=>feedDone=resolve));const ui=await actionClock(t,first.api),second=generatedActionApi({items:[{...row(),title:'Generated new owner action'}],hasMore:false});await ui.visibility(true);await ui.render(second.api);await ui.visibility(false);await ui.tick();assert.equal(first.reads[0].signal?.aborted,true);assert.equal(first.feeds.length,1,'old scope owns a real feed read');assert.equal(first.feeds[0].signal?.aborted,true);
 const count=second.count();await act(async()=>{readDone({items:[row()],hasMore:false});feedDone({cursor:1,ids:['workflow:actions:generated-old'],reset:true,hasMore:false});});await ui.tick();assert.equal(second.count(),count);assert.match(ui.element.textContent!,/Generated new owner action/);assert.doesNotMatch(ui.element.textContent!,/Generated private action/);assert.equal(first.count(),1);
});

test('a changed evidence ID reads the new exact key and fences the old evidence response',async t=>{
 const f=generatedActionApi();let release!:(value:Page)=>void;f.read(path=>path===pathFor()?new Promise<Page>(resolve=>release=resolve):undefined);f.pages.set(pathFor(otherEvidence),{items:[{...row(),title:'Generated other evidence'}],hasMore:false});const ui=await actionClock(t,f.api);await ui.render(f.api,otherEvidence);await ui.tick();assert.equal(f.reads[0].signal?.aborted,true);assert.equal(f.count(otherEvidence),1);await act(async()=>release({items:[row()],hasMore:false}));await ui.tick();assert.doesNotMatch(ui.element.textContent!,/Generated private action/);
 await ui.visibility(true);await ui.visibility(false);await ui.tick();assert.equal(f.count(),1,'old unobserved key is not rechecked');assert.equal(f.count(otherEvidence),2);assert.match(ui.element.textContent!,/Generated other evidence/);
 const todo=ui.element.querySelector<HTMLAnchorElement>('a[href*="todoEvidence"]')!;assert.equal(new URLSearchParams(todo.hash.split('?')[1]).get('todoEvidence'),otherEvidence);assert.equal(new URLSearchParams(todo.hash.split('?')[1]).get('returnTo'),'#/materials?generated=origin');await ui.leave();const reads=f.reads.length,feeds=f.feeds.length;await ui.tick(60000);assert.equal(f.reads.length,reads);assert.equal(f.feeds.length,feeds,'unmounted view releases its feed subscription');
});
