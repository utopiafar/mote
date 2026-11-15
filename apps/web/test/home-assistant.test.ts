import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale,getLocale} from '@mote/shared/i18n';
import {Overview} from '../src/Overview';
import {ApiError,type Api,type Status} from '../src/api';
import {featuresReady} from '../src/features/bootstrap';
import type {AssistantCard} from '../src/plugins/home/assistant-cards';
import {buildApp} from '../../server/src/app';

const at='2026-11-12T08:00:00.000Z',evidenceId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const capabilityIds=['GET:/api/assistant-cards','GET:/api/assistant-cards/:id','GET:/api/assistant-cards/:id/history','POST:/api/assistant-cards/:id/feedback','POST:/api/assistant/tasks','GET:/api/assistant/tasks/:id','GET:/api/owner-questions'];
const inventory=(ids=capabilityIds)=>({schemaVersion:1,revision:1,features:[],capabilities:ids.map(id=>({id:'http:'+id,version:'1',state:'active',surface:'data',featureId:'generated.home'}))});
const card=(title='Generated work suggestion'):AssistantCard=>({id:randomUUID(),kind:'suggestion',matterId:null,version:'v1',state:'open',revision:1,title,body:'Generated finding. Relevant to the current plan. Help: prepare a checklist. Uncertain until confirmed.',
 evidence:[{id:evidenceId,quote:'Generated original evidence'}],evidenceDependencies:{version:1,complete:true,ids:[evidenceId]},readAt:null,acceptedTaskId:null,feedback:[],createdAt:at,updatedAt:at});

async function domFixture(t:TestContext){
 await featuresReady;
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/today',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>(),locale=getLocale();configureLocale(()=>'zh-CN');
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){
  prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 }
 const root=createRoot(dom.window.document.getElementById('root')!),opened:string[]=[];
 Object.assign(dom.window.HTMLElement.prototype,{attachEvent:()=>{},detachEvent:()=>{}});
 t.after(async()=>{await act(async()=>root.unmount());dom.window.close();configureLocale(()=>locale);for(const [key,value] of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
 const render=(api:Api)=>act(async()=>root.render(React.createElement(Overview,{api,status:{agent:{configured:false},storage:{captures:0}} as Status,devices:[],insights:[],range:{},onMedia:()=>{},onPage:()=>{},onOpen:ref=>opened.push(ref)})));
 return {d:dom.window.document,root,render,opened};
}
const button=(node:ParentNode,text:string)=>[...node.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent?.trim()===text)!;
const home=(d:Document)=>{const value=d.querySelector<HTMLElement>('.home-assistant');assert.ok(value,'Home exposes the existing assistant feed');return value;};
const row=(d:Document,id:string)=>d.querySelector<HTMLElement>(`[data-card-id="${id}"]`)!;
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(check:()=>boolean){const end=Date.now()+5000;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.ok(check(),'the generated Home response settles');}
function client(handler:(path:string,init?:RequestInit)=>unknown,ids=capabilityIds):Api{
 return {request:async(path:string,init?:RequestInit)=>{
  if(path==='/api/features')return inventory(ids);
  if(path==='/api/devices/first-data')return {state:'ready',originalAvailable:false,checkedDevices:1,checkedRecords:1,windowLimited:false};
  if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:1,hasMore:false,reset:false};
  if(path.startsWith('/api/assistant')||path.startsWith('/api/work-activity')||path==='/api/model-authorization')return handler(path,init);
  return {items:[],nextCursor:null};
 },setAgentTimeout:()=>{}} as Api;
}

const entryCapabilities=[...capabilityIds,'GET:/api/conversations','POST:/api/assistant/onboarding','GET:/api/assistant/onboarding/:id','POST:/api/assistant/onboarding/:id/cancel','GET:/api/model-authorization','GET:/api/work-activity','GET:/api/assistant/matters','GET:/api/memories','GET:/api/context-trees','GET:/api/assistant/commitments','GET:/api/assistant/workbench'];
const assistant=(d:Document)=>{const panel=d.querySelector<HTMLElement>('[aria-label="个人助理"]');assert.ok(panel,'Home always exposes the assistant before its first result');return panel;};

test('an empty first Home exposes acquaintance, the main conversation, tasks and follow-up without starting any work',async t=>{
 const {d,render}=await domFixture(t),calls:{path:string;method:string}[]=[];
 const base=client((path,init)=>{calls.push({path,method:init?.method??'GET'});if(path==='/api/model-authorization')return {authorization:{state:'off',excludedSourceIds:[]}};return {items:[],nextCursor:null};},entryCapabilities);
 const api={...base,request:async(path:string,init?:RequestInit)=>path==='/api/devices/first-data'?{state:'waiting',originalAvailable:false,checkedDevices:0,checkedRecords:0,windowLimited:false}:base.request(path,init)} as Api;
 await render(api);
 const panel=assistant(d);
 assert.ok(d.querySelector('.central-first-use'),'the same entry is visible during the actual first-use Home');
 assert.equal(panel.closest('details'),null,'the entry is visible without expanding a directory');
 assert.equal(d.querySelector('.home-page')!.firstElementChild!.nextElementSibling,panel,'the assistant is the first Home section');
 for(const href of ['#/ask','#/connections','#/activity','#/assistant/matters','#/assistant/memory','#/assistant/workbench'])assert.ok(panel.querySelector('a[href="'+href+'"]'),href);
 assert.match(panel.textContent!,/此浏览器还没有可恢复的初次认识记录/);assert.match(panel.textContent!,/后台模型已关闭/);assert.match(panel.textContent!,/暂无记录/);
 assert.match(home(d).textContent!,/当前页暂无动态或建议/);
 assert.equal(calls.some(call=>call.method!=='GET'),false,'viewing Home never authorizes onboarding or a task');
 const work=calls.find(call=>call.path.startsWith('/api/work-activity?'));assert.ok(work);
 assert.ok(calls.some(call=>call.path.startsWith('/api/assistant/matters?')&&JSON.parse(new URL('http://fixture'+call.path).searchParams.get('scope')!).kind==='all'));
});

test('Home resumes the selected acquaintance scope and shows pending, failed, permission and needs-input states accurately',async t=>{
 const {d,render}=await domFixture(t),scope={kind:'selection',sourceIds:['generated-source']},id=randomUUID();
 d.defaultView!.localStorage.setItem('mote.assistant.onboarding.'+d.defaultView!.location.origin,JSON.stringify({id,scope}));
 let runState='pending',readFails=false,taskState='needs_input';
 const calls:string[]=[];
 const base=client(path=>{
  calls.push(path);
  if(path.includes('/onboarding/')){assert.deepEqual(JSON.parse(new URL('http://fixture'+path).searchParams.get('scope')!),scope);if(readFails)throw new ApiError('Generated onboarding permission denied',403);return {id,revision:1,state:runState,coverage:{sync:{completed:2,total:2},extraction:{completed:2,total:2},semantic:{completed:runState==='completed'?2:1,total:2,pending:runState==='pending'?1:0,failed:runState==='failed'?1:0}},completed:runState==='completed'?2:1,pending:runState==='pending'?1:0,failed:runState==='failed'?1:0,cancelled:0,items:[]};}
  if(path==='/api/model-authorization')return {authorization:{state:'on',excludedSourceIds:[]}};
  if(path.startsWith('/api/work-activity?'))return {items:[{id:'generated-work',goal:'Generated current task',state:taskState,updatedAt:at}],nextCursor:3};
  return {items:[],nextCursor:null};
 },entryCapabilities);
 const api={...base,request:(path:string,init?:RequestInit)=>path==='/api/sources'?Promise.resolve({items:[{id:'generated-source',name:'Generated source',status:{state:'permission_required'}}]}):base.request(path,init)} as Api;
 await render(api);let panel=assistant(d);
 assert.match(panel.textContent!,/处理中/);assert.match(panel.textContent!,/语义理解.*1 \/ 2/);assert.match(panel.textContent!,/需要重新授权/);assert.match(panel.textContent!,/需要处理/);assert.match(panel.textContent!,/Generated current task/);
 assert.ok(panel.querySelector('a[href="#/activity?work=generated-work"]'));
 runState='failed';taskState='failed';await act(async()=>button(panel,'刷新状态').click());
 assert.match(panel.textContent!,/处理失败/);assert.match(panel.textContent!,/未能完成/);assert.doesNotMatch(panel.querySelector('[data-onboarding-summary] [role=status]')!.textContent!,/全库已经理解|正在学习/);
 for(const [next,label]of [['cancelled','已取消'],['completed','本次选择的资料已完成；其他资料未包含。'],['empty','所选资料当前不可读取']]){
  runState=next;await act(async()=>button(panel,'刷新状态').click());assert.ok(panel.querySelector('[data-onboarding-summary] [role=status]')!.textContent!.includes(label));
 }
 runState='unknown-receipt-state';await act(async()=>button(panel,'刷新状态').click());
 assert.match(panel.querySelector('[data-onboarding-summary] [role=alert]')!.textContent!,/中央响应格式无效/);
 assert.doesNotMatch(panel.querySelector('[data-onboarding-summary]')!.textContent!,/本次选择的资料已完成/,'an unknown receipt state is never treated as completion');
 readFails=true;await act(async()=>button(panel,'刷新状态').click());
 assert.match(panel.textContent!,/请求被拒绝（403）/);assert.doesNotMatch(panel.textContent!,/语义理解.*1 \/ 2/,'a denied run cannot disclose its old progress');
 assert.equal(calls.some(path=>path.includes('/onboarding/')&&!path.includes('scope=')),false);
});

test('Home distinguishes a missing assistant capability from an inventory failure and never links an unsupported command',async t=>{
 const {d,render}=await domFixture(t);let denied=false;
 const base=client(()=>({items:[],nextCursor:null}),[]);
 const api={...base,request:async(path:string,init?:RequestInit)=>{if(path==='/api/features'&&denied)throw new ApiError('Generated inventory unavailable',503);return base.request(path,init);}} as Api;
 await render(api);const panel=assistant(d);
 assert.match(panel.textContent!,/当前服务未提供此入口/);assert.equal(panel.querySelector('a[href="#/connections"]'),null);
 denied=true;await act(async()=>button(panel,'刷新状态').click());
 assert.match(panel.textContent!,/当前支持情况暂无法确认/);assert.doesNotMatch(panel.textContent!,/暂无记录|尚未开始/,'unknown availability is not a successful empty read');
});

test('Home distinguishes loading, genuine empty data, read failure and a briefing with partial coverage',async t=>{
 const {d,render}=await domFixture(t);let resolve!:(value:unknown)=>void,fail=false;
 let page:unknown=new Promise(value=>resolve=value);
 const api=client(()=>{if(fail)throw new ApiError('Generated card read unavailable',503);return page;});
 await render(api);assert.ok(home(d).querySelector('.loading'));assert.equal(home(d).querySelectorAll('[data-card-id]').length,0);
 page={items:[],nextCursor:null};await act(async()=>{resolve(page);await settle();});
 assert.match(home(d).textContent!,/当前页暂无动态或建议/);assert.equal(home(d).querySelectorAll('[data-card-id]').length,0);
 fail=true;await act(async()=>button(home(d),'刷新').click());assert.match(home(d).querySelector('[role=alert]')!.textContent!,/Generated card read unavailable/);
 assert.doesNotMatch(home(d).textContent!,/当前页暂无动态或建议/,'failure must not pretend to be an empty feed');
 const brief={...card('Generated briefing'),kind:'briefing',body:'Generated coverage: 1 / 2 documents. The second document is still pending. Authorship is unknown.'};
 page={items:[brief],nextCursor:null};fail=false;await act(async()=>button(home(d),'重新读取').click());
 assert.match(home(d).textContent!,/1 \/ 2 documents/);assert.match(home(d).textContent!,/Authorship is unknown/);assert.match(home(d).textContent!,/简报仅代表/);
 assert.doesNotMatch(home(d).textContent!,/今日简报/,'an older briefing is not relabelled as today’s briefing');
 assert.equal(home(d).querySelector('time')!.dateTime,at);assert.ok(home(d).querySelector('[aria-label="今天要关注"]'));
});

test('Home disables each unsupported command and explains why without dispatching it',async t=>{
 const {d,render}=await domFixture(t),suggestion=card();let mutations=0;
 const api=client((_path,init)=>{if(init?.method==='POST')mutations++;return {items:[suggestion],nextCursor:null};},['GET:/api/assistant-cards','GET:/api/assistant-cards/:id']);
 await render(api);
 for(const label of ['开始','编辑','稍后','忽略','标为已读','后续变化'])assert.equal(button(row(d,suggestion.id),label).disabled,true,label);
 assert.match(row(d,suggestion.id).textContent!,/任务服务尚未接通/);assert.match(row(d,suggestion.id).textContent!,/未提供反馈操作/);assert.match(row(d,suggestion.id).textContent!,/未提供后续变化/);
 await act(async()=>button(row(d,suggestion.id),'开始').click());assert.equal(mutations,0);
});

test('a failed cursor can return to the first real page without retaining the previous card as page two',async t=>{
 const {d,render}=await domFixture(t),suggestion=card();
 const api=client(path=>{if(new URL('http://fixture'+path).searchParams.has('cursor'))throw new ApiError('Generated cursor expired',409);return {items:[suggestion],nextCursor:'generated-cursor'};});
 await render(api);await act(async()=>button(home(d).querySelector('nav')!,'下一页').click());
 assert.match(home(d).querySelector('[role=alert]')!.textContent!,/Generated cursor expired/);assert.equal(home(d).querySelectorAll('[data-card-id]').length,0);
 await act(async()=>button(home(d),'返回第一页').click());assert.ok(row(d,suggestion.id));assert.match(home(d).textContent!,/第 1 页 · 1 条/);
});

test('a lost start response and a double click reuse one frozen edited command',async t=>{
 const {d,render}=await domFixture(t);let suggestion=card(),reject!:(reason:unknown)=>void;
 const calls:any[]=[],taskId=randomUUID();let held=true;
 const api=client((path,init)=>{
  if(path==='/api/assistant/tasks'&&init?.method==='POST'){
   const body=JSON.parse(String(init.body));calls.push(body);
   if(held)return new Promise((_resolve,no)=>reject=no);
   suggestion={...suggestion,revision:2,acceptedTaskId:taskId};return {requestId:body.requestId,taskId};
  }
  if(path.startsWith('/api/assistant/tasks/'))return {task:{id:taskId,state:'waiting',goal:calls.at(-1).goal}};
  return {items:[suggestion],nextCursor:null};
 });
 await render(api);await act(async()=>button(row(d,suggestion.id),'编辑').click());
 const area=row(d,suggestion.id).querySelector<HTMLTextAreaElement>('textarea')!;
 await act(async()=>{area.focus();Object.getOwnPropertyDescriptor(d.defaultView!.HTMLTextAreaElement.prototype,'value')!.set!.call(area,'Generated owner-edited work');area.dispatchEvent(new d.defaultView!.Event('input',{bubbles:true}));area.dispatchEvent(new d.defaultView!.KeyboardEvent('keyup',{bubbles:true,key:'a'}));});
 await act(async()=>{button(row(d,suggestion.id),'开始').click();button(row(d,suggestion.id),'开始').click();});
 assert.equal(calls.length,1,'the synchronous latch prevents double admission');
 assert.equal(calls[0].goal,'Generated owner-edited work');
 await act(async()=>{reject(new ApiError('Generated lost response',503));await settle();});held=false;
 assert.match(row(d,suggestion.id).textContent!,/重复开始会回到同一任务/);
 await act(async()=>button(row(d,suggestion.id),'开始').click());
 assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);assert.deepEqual(calls[1].scope,{kind:'all'});
 assert.ok(home(d).querySelector(`[data-task-id="${taskId}"]`));assert.match(home(d).textContent!,/等待开始/);assert.ok(button(row(d,suggestion.id),'查看任务'));
});

test('another client’s read and version update are rechecked while visible and require review before starting',async t=>{
 const {d,render}=await domFixture(t);t.mock.timers.enable({apis:['setTimeout']});let suggestion=card();
 const api=client(()=>({items:[suggestion],nextCursor:null}));await render(api);assert.match(row(d,suggestion.id).textContent!,/未读/);
 suggestion={...suggestion,readAt:at,revision:2};await act(async()=>t.mock.timers.tick(5000));
 assert.equal(button(row(d,suggestion.id),'标为已读'),undefined);assert.match(row(d,suggestion.id).textContent!,/已读/);
 suggestion={...suggestion,version:'v2',revision:3,title:'Generated updated help',body:'Generated subsequent evidence changed the same suggestion.'};
 await act(async()=>t.mock.timers.tick(5000));assert.equal(home(d).querySelectorAll('[data-card-id]').length,1);assert.match(row(d,suggestion.id).textContent!,/subsequent evidence/);
 assert.equal(button(row(d,suggestion.id),'开始').disabled,true);await act(async()=>button(row(d,suggestion.id),'重新核对最新建议').click());assert.equal(button(row(d,suggestion.id),'开始').disabled,false);
 Object.defineProperty(d,'hidden',{configurable:true,value:true});await act(async()=>d.dispatchEvent(new d.defaultView!.Event('visibilitychange')));
 suggestion={...suggestion,readAt:null,revision:4};await act(async()=>t.mock.timers.tick(10000));assert.equal(button(row(d,suggestion.id),'标为已读'),undefined,'hidden Home does not poll');
 Object.defineProperty(d,'hidden',{configurable:true,value:false});await act(async()=>d.dispatchEvent(new d.defaultView!.Event('visibilitychange')));assert.ok(button(row(d,suggestion.id),'标为已读'),'resuming validates the current page');
});

test('task results preserve completed, cancelled and needs-input states instead of inventing success',async t=>{
 const {d,render,opened}=await domFixture(t),suggestion={...card(),acceptedTaskId:randomUUID()};let state='completed',withdrawn=false;
 const api=client((path)=>{
  if(path.startsWith('/api/assistant/tasks/'))return {task:{id:suggestion.acceptedTaskId,state},...(state==='completed'&&!withdrawn?{result:{answer:'Generated saved outcome',runId:randomUUID(),trace:[],citations:[{id:evidenceId,appName:'Generated source',capturedAt:at,excerpt:'Generated original evidence'}]}}:{}),...(state==='needs_input'?{error:'no_usable_evidence'}:{})};
  return {items:[suggestion],nextCursor:null};
 });
 await render(api);await act(async()=>button(row(d,suggestion.id),'查看任务').click());assert.match(home(d).textContent!,/Generated saved outcome/);assert.match(home(d).textContent!,/已完成/);
 assert.match(assistant(d).querySelector('[data-home-task-id]')!.textContent!,/已完成/,'the fixed task entry reads the same completed task receipt');
 withdrawn=true;await act(async()=>home(d).querySelector<HTMLButtonElement>('.citation')!.click());assert.deepEqual(opened,[],'withdrawn result cannot open its old evidence');
 for(const next of ['cancelled','needs_input']){
  await act(async()=>{d.defaultView!.location.hash='#/today';d.defaultView!.dispatchEvent(new d.defaultView!.HashChangeEvent('hashchange'));});state=next;
  await act(async()=>button(row(d,suggestion.id),'查看任务').click());
  await act(async()=>button(home(d).querySelector('.home-assistant-task')!,'刷新状态').click());
  assert.match(home(d).textContent!,next==='cancelled'?/已取消/:/需要你补充/);assert.doesNotMatch(home(d).textContent!,/Generated saved outcome/);
  assert.match(assistant(d).querySelector('[data-home-task-id]')!.textContent!,next==='cancelled'?/已停止/:/需要处理/);
 }
 assert.match(home(d).textContent!,/当前范围没有可用正文/);
});

test('a withdrawn card stops disclosing cached body, feedback and evidence on revalidation',async t=>{
 const {d,render,opened}=await domFixture(t),suggestion=card();let withdrawn=false;
 const api=client(path=>{
  if(path.startsWith('/api/assistant-cards/')){if(withdrawn)throw new ApiError('Generated original withdrawn',404);return suggestion;}
  return {items:withdrawn?[]:[suggestion],nextCursor:null};
 });await render(api);withdrawn=true;
 await act(async()=>button(row(d,suggestion.id),'来源资料 1').click());assert.deepEqual(opened,[]);
 assert.equal(home(d).querySelectorAll('[data-card-id]').length,0);assert.doesNotMatch(home(d).textContent!,/Generated finding|Generated original evidence/);
});

test('a task blocked by unavailable context budget keeps its distinct budget explanation',async t=>{
 const {d,render}=await domFixture(t),suggestion={...card(),acceptedTaskId:randomUUID()};
 const api=client(path=>path.startsWith('/api/assistant/tasks/')?{task:{id:suggestion.acceptedTaskId,state:'needs_input'},error:'model_context_budget_unavailable'}:{items:[suggestion],nextCursor:null});
 await render(api);await act(async()=>button(row(d,suggestion.id),'查看任务').click());
 assert.match(home(d).querySelector('.home-assistant-task')!.textContent!,/模型上下文预算尚未就绪，任务未执行。/);
 assert.doesNotMatch(home(d).querySelector('.home-assistant-task')!.textContent!,/Agent 未配置|已完成/);
 assert.match(assistant(d).querySelector('[data-home-task-id]')!.textContent!,/需要处理/);
});

test('a source removal hint clears the visible card before the next scheduled feed-page poll',async t=>{
 const {d,render}=await domFixture(t);t.mock.timers.enable({apis:['setTimeout']});const suggestion=card();let withdrawn=false,pending:string[]=[],pageReads=0;
 const base=client(()=>{pageReads++;return {items:withdrawn?[]:[suggestion],nextCursor:null};});
 const api={...base,request:async(path:string,init?:RequestInit)=>{
  if(path.startsWith('/api/operations/changes')){const ids=pending;pending=[];return {ids,cursor:1,hasMore:false,reset:false};}
  return base.request(path,init);
 }} as Api;
 await render(api);assert.ok(row(d,suggestion.id));assert.equal(pageReads,1);
 withdrawn=true;pending=['capture:'+evidenceId];await act(async()=>t.mock.timers.tick(1500));
 assert.equal(pageReads,2);assert.equal(home(d).querySelectorAll('[data-card-id]').length,0);assert.doesNotMatch(home(d).textContent!,/Generated original evidence/);
});

test('a late start response from a previous Api cannot change the replacement Home or its route',async t=>{
 const {d,render}=await domFixture(t),suggestion=card();let complete!:(value:unknown)=>void,requestId='';
 const old=client((path,init)=>{if(path==='/api/assistant/tasks'&&init?.method==='POST'){requestId=JSON.parse(String(init.body)).requestId;return new Promise(resolve=>complete=resolve);}return {items:[suggestion],nextCursor:null};});
 await render(old);await act(async()=>button(row(d,suggestion.id),'开始').click());assert.ok(requestId);
 await render(client(()=>({items:[],nextCursor:null})));
 await act(async()=>{complete({requestId,taskId:randomUUID()});await settle();});
 assert.equal(d.defaultView!.location.hash,'#/today');assert.equal(home(d).querySelectorAll('[data-card-id],[data-task-id]').length,0);assert.doesNotMatch(home(d).textContent!,/Generated work suggestion/);
});

test('real A3 HTTP pages, feedback and history reach Home; real A2 acceptance remains idempotent after a lost response',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-home-assistant-')),token='generated-home-assistant-owner',headers={authorization:'Bearer '+token};
 const node=await buildApp({dataDir:directory,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'},
  {backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model in Home fixture');},close:async()=>{}}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const {d,render}=await domFixture(t),cards=node.featureServices.assistantCards,scope={kind:'all' as const};
 const ids:string[]=[];
 for(const text of ['Generated project requires a checklist.','Generated family trip has an unconfirmed date.']){
  const id=randomUUID(),created=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-home-device',deviceName:'Generated Home',platform:'android',capturedAt:at,text}});assert.equal(created.statusCode,201,created.body);ids.push(id);
 }
 const matter=node.featureServices.assistantMatters.command({type:'create',requestId:randomUUID(),goal:'Generated project goal',scope},{currentEvidence:()=>[],currentTask:()=>undefined});
 const publish=(title:string,body:string,kind:AssistantCard['kind']='activity',id=randomUUID(),version='v1',revision?:number,proof=0,matterId:string|null=null)=>cards.publish({id,kind,matterId,version,state:'open',title,body,evidence:[{id:ids[proof],quote:proof===0?'Generated project requires a checklist.':'Generated family trip has an unconfirmed date.'}],evidenceDependencies:{version:1,complete:true,ids:[ids[proof]]}},revision,scope,()=>{});
 const oldest=publish('Generated earlier activity','Generated original activity');for(let n=0;n<3;n++)publish('Generated activity '+n,'Generated activity evidence');
 let work=publish('Generated project help','Found: checklist is needed. Relevant: current launch. Help: prepare the checklist. Authorship unknown.','suggestion',randomUUID(),'v1',undefined,0,matter.id);
 const life=publish('Generated travel help','Found: travel date is unconfirmed. Relevant: family plan. Help: compare the supplied dates.','suggestion',randomUUID(),'v1',undefined,1);
 publish('Generated partial briefing','Coverage: 1 / 2 sources. One source is pending. These are observations, not verified owner actions.','briefing');
 const starts:any[]=[],reads:string[]=[];let loseStart=true;
 const api={request:async(path:string,init?:RequestInit)=>{
  reads.push(path);const response=await node.app.inject({method:(init?.method??'GET') as 'GET'|'POST',url:path,headers,...(init?.body?{payload:JSON.parse(String(init.body))}:{})});
  if(response.statusCode>=400)throw new ApiError(response.body,response.statusCode);
  if(path==='/api/assistant/tasks'&&init?.method==='POST'){starts.push(JSON.parse(String(init.body)));if(loseStart){loseStart=false;throw new ApiError('Generated lost start response',503);}}
  return response.json();
 },setAgentTimeout:()=>{}} as Api;
 await render(api);await act(async()=>until(()=>Boolean(row(d,work.id))));
 assert.match(home(d).textContent!,/Generated project help/);assert.match(home(d).textContent!,/Generated travel help/);assert.match(home(d).textContent!,/1 \/ 2 sources/);assert.ok(!row(d,oldest.id));
 const pages=home(d).querySelector('nav')!;await act(async()=>button(pages,'下一页').click());await act(async()=>until(()=>Boolean(row(d,oldest.id))));assert.match(home(d).textContent!,/第 2 页 · 1 条/);
 await act(async()=>button(home(d).querySelector('nav')!,'上一页').click());await act(async()=>until(()=>Boolean(row(d,work.id))));
 // A second client writes the same read fact. Home rereads the actual DTO.
 const other=await node.app.inject({method:'POST',url:`/api/assistant-cards/${work.id}/feedback?`+new URLSearchParams({scope:JSON.stringify(scope)}),headers,payload:{expectedRevision:work.revision,action:'read'}});assert.equal(other.statusCode,200,other.body);
 await act(async()=>button(home(d),'刷新').click());await act(async()=>until(()=>!button(row(d,work.id),'标为已读')));assert.match(row(d,work.id).textContent!,/已读/);work=cards.get(work.id,scope);
 for(let n=2;n<=4;n++)work=publish('Generated project help','Generated same-suggestion update '+n,'suggestion',work.id,'v'+n,work.revision,0,matter.id);
 await act(async()=>button(home(d),'刷新').click());await act(async()=>until(()=>row(d,work.id)?.textContent?.includes('update 4')??false));
 assert.equal(home(d).querySelectorAll(`[data-card-id="${work.id}"]`).length,1);assert.match(row(d,work.id).textContent!,/已读/);
 await act(async()=>button(row(d,work.id),'后续变化').click());await act(async()=>until(()=>Boolean(row(d,work.id).querySelector('.home-assistant-history article'))));
 assert.match(row(d,work.id).querySelector('.home-assistant-history')!.textContent!,/update 4/);
 await act(async()=>button(row(d,work.id).querySelector('.home-assistant-history')!,'下一页').click());await act(async()=>until(()=>row(d,work.id).querySelector('.home-assistant-history')?.textContent?.includes('checklist is needed')??false));
 await act(async()=>button(row(d,work.id),'重新核对最新建议').click());
 await act(async()=>{button(row(d,work.id),'开始').click();button(row(d,work.id),'开始').click();});await act(async()=>until(()=>starts.length===1));
 assert.match(row(d,work.id).textContent!,/重复开始会回到同一任务/);
 await act(async()=>button(row(d,work.id),'开始').click());await act(async()=>until(()=>Boolean(home(d).querySelector('[data-task-id]'))));
 assert.deepEqual(starts[0],starts[1]);assert.equal(node.store.db.prepare("SELECT count(*) AS n FROM task_records WHERE kind='assistant.task'").get()!.n,1);
 const accepted=cards.get(work.id,scope).acceptedTaskId!;assert.ok(home(d).querySelector(`[data-task-id="${accepted}"]`));assert.deepEqual(node.featureServices.assistantMatters.get(matter.id).taskIds,[accepted]);
 await until(()=>node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(accepted)?.state==='blocked');
 const task=await node.app.inject({url:'/api/assistant/tasks/'+accepted+'?'+new URLSearchParams({scope:JSON.stringify(scope)}),headers});assert.equal(task.json().task.state,'needs_input');assert.equal(task.json().error,'model_not_configured');
 await act(async()=>button(home(d).querySelector('.home-assistant-task')!,'刷新状态').click());await act(async()=>until(()=>home(d).querySelector('.home-assistant-task')?.textContent?.includes('Agent 未配置')??false));
 assert.ok(home(d).querySelector('.home-assistant-task a[href="#/system/models"]'),'the actual missing-model state has a configuration entry');
 await act(async()=>button(row(d,life.id),'稍后').click());await act(async()=>until(()=>row(d,life.id)?.textContent?.includes('已稍后')??false));
 await act(async()=>button(row(d,life.id),'忽略').click());await act(async()=>until(()=>row(d,life.id)?.textContent?.includes('已忽略')??false));assert.equal(cards.get(life.id,scope).evidence[0].quote,'Generated family trip has an unconfirmed date.');
 assert.ok(reads.some(path=>path.includes('/history?')&&path.includes('cursor=')),'the actual history cursor reaches its consumer');
 assert.equal((await node.app.inject({method:'POST',url:'/api/assistant/tasks',payload:starts[0]})).statusCode,401);
 const {invitation}=node.connections.invite({serverUrl:'https://fixture.invalid',label:'Generated collector'},'collector');
 const collector=await node.connections.redeem({code:invitation.code,deviceId:'generated-home-collector',deviceName:'Generated',platform:'android'});
 assert.equal((await node.app.inject({method:'POST',url:'/api/assistant/tasks',headers:{authorization:'Bearer '+collector.token},payload:starts[0]})).statusCode,403);
 assert.equal((await node.app.inject({method:'POST',url:'/api/assistant/tasks',headers,payload:{...starts[0],capability:'invented'}})).statusCode,400);
 const forbidden={requestId:randomUUID(),goal:'Generated forbidden',scope:{kind:'selection',evidenceIds:[]},cardId:life.id,expectedRevision:cards.get(life.id,scope).revision};
 assert.equal((await node.app.inject({method:'POST',url:'/api/assistant/tasks',headers,payload:forbidden})).statusCode,404);
 assert.equal(node.store.db.prepare("SELECT count(*) AS n FROM task_records WHERE kind='assistant.task'").get()!.n,1);
});

test('Home distinguishes an open owner question from background processing and links its partial acquaintance result',async t=>{
 const {d,render}=await domFixture(t),id=randomUUID(),questionId=randomUUID(),scope={kind:'selection',sourceIds:['generated-source']};
 d.defaultView!.localStorage.setItem('mote.assistant.onboarding.'+d.defaultView!.location.origin,JSON.stringify({id,scope}));
 const calls:{path:string;method:string}[]=[];
 const api=client((path,init)=>{calls.push({path,method:init?.method??'GET'});if(path.includes('/onboarding/'))return {id,revision:2,state:'pending',completed:0,pending:1,failed:0,cancelled:0,
  coverage:{sync:{completed:1,total:1},extraction:{completed:1,total:1},semantic:{completed:0,total:1,partial:1,pending:0,failed:0}},
  items:[{material:{ref:'material:generated@current',title:'Generated diary',sourceId:'generated-source'},state:'pending',reason:'memory_owner_input_required',coverage:{sync:{status:'ready'},extraction:{status:'ready'},semantic:{status:'partial'}},result:{reason:'Generated independent result',cardIds:[],commitmentIds:[]},ownerQuestions:[{id:questionId,revision:1,state:'open',prompt:'Generated question: are you the named participant?'}]}]};return {items:[],nextCursor:null};},entryCapabilities);
 await render(api);const summary=assistant(d).querySelector('[data-onboarding-summary]')!;
 assert.match(summary.textContent!,/需要你补充/);assert.match(summary.textContent!,/已有部分结果；需要你补充的问题只影响相关结论。/);assert.match(summary.textContent!,/语义理解.*0 \/ 1/);
 assert.equal(summary.querySelector('a[href="#/ask?question='+questionId+'"]')?.textContent,'Generated question: are you the named participant?');
 assert.doesNotMatch(summary.textContent!,/本次选择的资料已完成/);assert.equal(calls.some(call=>call.method!=='GET'),false);
});
