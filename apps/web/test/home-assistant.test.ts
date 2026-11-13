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
  if(path.startsWith('/api/assistant'))return handler(path,init);
  return {items:[],nextCursor:null};
 },setAgentTimeout:()=>{}} as Api;
}

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
 withdrawn=true;await act(async()=>home(d).querySelector<HTMLButtonElement>('.citation')!.click());assert.deepEqual(opened,[],'withdrawn result cannot open its old evidence');
 for(const next of ['cancelled','needs_input']){
  await act(async()=>{d.defaultView!.location.hash='#/today';d.defaultView!.dispatchEvent(new d.defaultView!.HashChangeEvent('hashchange'));});state=next;
  await act(async()=>button(row(d,suggestion.id),'查看任务').click());
  await act(async()=>button(home(d).querySelector('.home-assistant-task')!,'刷新状态').click());
  assert.match(home(d).textContent!,next==='cancelled'?/已取消/:/需要你补充/);assert.doesNotMatch(home(d).textContent!,/Generated saved outcome/);
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
 const task=await node.app.inject({url:'/api/assistant/tasks/'+accepted+'?'+new URLSearchParams({scope:JSON.stringify(scope)}),headers});assert.equal(task.json().task.state,'needs_input');assert.equal(task.json().error,'model_context_budget_unavailable');
 await act(async()=>button(home(d).querySelector('.home-assistant-task')!,'刷新状态').click());await act(async()=>until(()=>home(d).querySelector('.home-assistant-task')?.textContent?.includes('模型上下文预算尚未就绪')??false));
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
