import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import type {Commitment,MatterDetail,Routine} from '@mote/shared';
import {ApiError,type Api} from '../src/api';
import {AssistantMatters} from '../src/plugins/assistant/AssistantMatters';

const id='11111111-1111-4111-8111-111111111111',evidenceId='22222222-2222-4222-8222-222222222222',taskId='33333333-3333-4333-8333-333333333333',questionId='44444444-4444-4444-8444-444444444444';
const at='2026-11-01T10:00:00Z',all={kind:'all' as const};
const detail=():MatterDetail=>({matter:{id,goal:'Generated meeting preparation and follow-up',scope:all,state:'active',revision:1,taskIds:[],evidenceIds:[evidenceId],correction:null,createdAt:at,updatedAt:at,archivedAt:null},
 linkedTasks:[],linkedEvidence:[{id:evidenceId,title:'Generated original evidence',at}],coverage:{tasks:'complete',evidence:'complete'}});
const routine=():Routine=>({id,revision:1,enabled:true,nextDue:'2026-11-14T01:00:00Z',goal:'Generated daily review',scope:{kind:'selection',sourceIds:[]},schedule:{revision:1,timeZone:'Asia/Shanghai',trigger:{kind:'daily',localTime:'09:00'}},matterId:null,event:null});
const commitment=():Commitment=>({id,revision:1,title:'Generated commitment',status:'confirmed',deadline:{text:'when the generated plan is ready',at:null},dueState:'unknown',matterId:id,personMemoryId:null,todoId:null,
 timeline:[{commitmentId:id,eventId:questionId,origin:'proposal',kind:'commitment',occurredAt:null,summary:'Generated evidence-backed commitment',evidence:[{id:evidenceId,offset:0,quote:'Generated original quote'}],evidenceDependencies:{version:1,complete:true,ids:[evidenceId]},changes:{title:'Generated commitment'},createdAt:at}],evidenceDependencies:{version:1,complete:true,ids:[evidenceId]},sourceContextDependencies:[],createdAt:at,updatedAt:at});
type Call={path:string;method:string;body?:any};
function client(read:(path:string,init?:RequestInit)=>unknown,capabilities=['http:POST:/api/assistant/matter-commands','http:POST:/api/assistant/routines/:id']){
 const calls:Call[]=[];
 const api={request:async(path:string,init?:RequestInit)=>{
  calls.push({path,method:init?.method??'GET',...(init?.body?{body:JSON.parse(String(init.body))}:{})});
  if(path==='/api/features')return {schemaVersion:1,capabilities:capabilities.map(id=>({id,version:'1',surface:'command',state:'active',featureId:'mote.ask'}))};
  if(path==='/api/model-authorization')return {authorization:{state:'off',excludedSourceIds:[]}};
  return read(path,init);
 }} as Api;
 return {api,calls};
}
async function fixture(t:import('node:test').TestContext,kind='matter'){
 configureLocale(()=> 'zh-CN');const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/assistant/matters?'+kind+'='+id,pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>();
 let hidden=false;Object.defineProperty(dom.window.document,'hidden',{get:()=>hidden,configurable:true});
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 Object.assign(dom.window.HTMLElement.prototype,{attachEvent:()=>{},detachEvent:()=>{},scrollIntoView:()=>{}});dom.window.scrollTo=()=>{};dom.window.confirm=()=>true;
 const root=createRoot(dom.window.document.getElementById('root')!),opened:string[]=[];
 const render=(api:Api)=>act(async()=>root.render(React.createElement(AssistantMatters,{api,onOpen:ref=>opened.push(ref)})));
 const foreground=()=>act(async()=>{hidden=true;dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));hidden=false;dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));});
 t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of prior)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);dom.window.close();});
 return {root,d:dom.window.document,opened,render,foreground};
}
async function click(d:Document,label:string){await act(async()=>{const button=[...d.querySelectorAll('button')].find(item=>item.textContent===label);assert.ok(button,label);button.click();});}
async function input(d:Document,selector:string,value:string){await act(async()=>{const area=d.querySelector<HTMLTextAreaElement|HTMLInputElement>(selector)!;assert.ok(area);area.focus();Object.getOwnPropertyDescriptor(Object.getPrototypeOf(area),'value')!.set!.call(area,value);area.dispatchEvent(new d.defaultView!.Event('input',{bubbles:true}));area.dispatchEvent(new d.defaultView!.KeyboardEvent('keyup',{bubbles:true,key:'a'}));});}

test('an old matter editor conflicts after another client edits instead of silently adopting its revision',async t=>{
 const ui=await fixture(t),current=detail();const remote=client((path,init)=>{
  if(init?.method==='POST')throw new ApiError('Generated stale revision',409);
  if(path.startsWith('/api/assistant/matters/'))return structuredClone(current);return {items:[],nextCursor:null};
 });
 await ui.render(remote.api);await click(ui.d,'编辑');await input(ui.d,'textarea','Generated unsaved owner goal');
 current.matter.goal='Generated other-client goal';current.matter.revision=2;await ui.foreground();
 assert.equal(ui.d.querySelector('textarea')!.value,'Generated unsaved owner goal');await click(ui.d,'保存');
 assert.equal(remote.calls.find(call=>call.method==='POST')!.body.expectedRevision,1);assert.match(ui.d.body.textContent!,/内容已在其他地方修改或失效/);assert.match(ui.d.body.textContent!,/Generated other-client goal/);
 assert.equal(ui.d.querySelector('textarea')!.value,'Generated unsaved owner goal');
});

test('pausing a matter and reopening its card preserves separate matter and background states',async t=>{
 const ui=await fixture(t),current=detail();const remote=client((path,init)=>{
  if(init?.method==='POST'){current.matter.state='paused';current.matter.revision++;return current.matter;}
  if(path.startsWith('/api/assistant/matters/'))return structuredClone(current);return {items:[],nextCursor:null};
 });
 await ui.render(remote.api);await click(ui.d,'暂停事项');assert.match(ui.d.querySelector('.assistant-matter-detail')!.textContent!,/事项已暂停/);assert.match(ui.d.body.textContent!,/后台模型已关闭/);assert.doesNotMatch(ui.d.querySelector('.assistant-matter-detail')!.textContent!,/正在进行/);
 assert.deepEqual(remote.calls.filter(call=>call.method==='POST').map(call=>[call.path,call.body.type]),[['/api/assistant/matter-commands','pause']]);
 await act(async()=>ui.root.render(React.createElement('div')));await ui.render(remote.api);
 assert.match(ui.d.querySelector('.assistant-matter-detail')!.textContent!,/事项已暂停/);assert.ok([...ui.d.querySelectorAll('button')].some(item=>item.textContent==='恢复事项'));
});

test('unsupported matter commands are absent and a withdrawn original disappears on foreground refresh',async t=>{
 const ui=await fixture(t),current=detail();const remote=client(path=>path.startsWith('/api/assistant/matters/')?structuredClone(current):{items:[],nextCursor:null},[]);
 await ui.render(remote.api);assert.equal([...ui.d.querySelectorAll('button')].some(item=>item.textContent==='编辑'||item.textContent==='暂停事项'),false);
 current.linkedEvidence=[];current.coverage.evidence='partial';
 await click(ui.d,'Generated original evidence');assert.deepEqual(ui.opened,[]);assert.doesNotMatch(ui.d.body.textContent!,/Generated original evidence/);assert.match(ui.d.body.textContent!,/部分关联资料已不可用/);
 current.linkedEvidence=[{id:evidenceId,title:'Generated newly readable evidence',at}];await ui.foreground();assert.match(ui.d.body.textContent!,/Generated newly readable evidence/);
 current.linkedEvidence=[];await ui.foreground();assert.doesNotMatch(ui.d.body.textContent!,/Generated newly readable evidence/);
});

test('a late original check cannot open evidence after changing the API connection',async t=>{
 const ui=await fixture(t);let reads=0,release!:(value:unknown)=>void;
 const old=client(path=>{if(path.startsWith('/api/assistant/matters/')){if(++reads===1)return detail();return new Promise(done=>release=done);}return {items:[],nextCursor:null};});
 await ui.render(old.api);await click(ui.d,'Generated original evidence');assert.ok(release);
 const next=client(()=>{throw new ApiError('Generated current access denied',403);},[]);await ui.render(next.api);
 await act(async()=>release(detail()));assert.deepEqual(ui.opened,[]);assert.doesNotMatch(ui.d.body.textContent!,/Generated original evidence/);
});

test('a failed detail read cannot revive old evidence while the next permission check is pending',async t=>{
 const ui=await fixture(t);let stage='initial',release!:(value:unknown)=>void;
 const remote=client(path=>{if(path.startsWith('/api/assistant/matters/')){
  if(stage==='failed')throw new ApiError('Generated transient unavailable',503);
  if(stage==='pending')return new Promise(done=>release=done);
  return detail();
 }return {items:[],nextCursor:null};});
 await ui.render(remote.api);assert.match(ui.d.body.textContent!,/Generated original evidence/);
 stage='failed';await ui.foreground();assert.doesNotMatch(ui.d.body.textContent!,/Generated original evidence/);
 stage='pending';await ui.foreground();assert.ok(release);assert.doesNotMatch(ui.d.body.textContent!,/Generated original evidence/);
 await act(async()=>release(detail()));assert.match(ui.d.body.textContent!,/Generated original evidence/);
});

test('vague commitment deadlines and event times remain unknown and revoked timeline text is cleared',async t=>{
 const ui=await fixture(t,'commitment');let withdrawn=false;
 const remote=client(path=>{if(path.startsWith('/api/assistant/commitments/')){if(withdrawn)throw new ApiError('Generated withdrawn commitment',404);return commitment();}return {items:[],nextCursor:null};},[]);
 await ui.render(remote.api);assert.match(ui.d.body.textContent!,/期限 · 未知/);assert.match(ui.d.body.textContent!,/发生时间 · 未知/);assert.match(ui.d.body.textContent!,/已确认/);assert.doesNotMatch(ui.d.body.textContent!,/已完成/);
 withdrawn=true;await click(ui.d,'查看原文');assert.deepEqual(ui.opened,[]);assert.doesNotMatch(ui.d.body.textContent!,/Generated original quote|Generated evidence-backed commitment/);assert.match(ui.d.body.textContent!,/Generated withdrawn commitment/);
});

test('routine edits keep the displayed revision and preview the saved wall clock and explicit empty selection',async t=>{
 const ui=await fixture(t,'routine'),current=routine();const remote=client((path,init)=>{
  if(init?.method==='POST'){const body=JSON.parse(String(init.body));assert.equal(body.expectedRevision,1);current.goal=body.goal;current.schedule.timeZone=body.timeZone;current.schedule.trigger=body.trigger;current.revision++;return current;}
  if(path.startsWith('/api/assistant/routines/'))return structuredClone(current);return {items:[],nextCursor:null};
 });
 await ui.render(remote.api);assert.match(ui.d.body.textContent!,/Asia\/Shanghai|09:00/);assert.match(ui.d.body.textContent!,/未选择资料/);assert.match(ui.d.body.textContent!,/规则已启用/);assert.match(ui.d.body.textContent!,/后台模型已关闭/);assert.doesNotMatch(ui.d.body.textContent!,/正在进行/);
 await click(ui.d,'编辑');await input(ui.d,'input[type=time]','10:30');await click(ui.d,'保存');
 assert.equal(remote.calls.find(call=>call.method==='POST')!.body.trigger.localTime,'10:30');assert.match(ui.d.body.textContent!,/10:30/);assert.equal(remote.calls.some(call=>call.body?.scope),false,'editing the clock does not silently widen the source scope');
});

test('a paused parent keeps a new rule view from offering resume or claiming that work is running',async t=>{
 const ui=await fixture(t,'routine'),current=routine(),parent=detail();current.enabled=false;current.matterId=id;parent.matter.state='paused';
 const remote=client(path=>path.startsWith('/api/assistant/routines/')?current:path.startsWith('/api/assistant/matters/')?parent:{items:[],nextCursor:null});
 await ui.render(remote.api);const resume=[...ui.d.querySelectorAll('button')].find(button=>button.textContent==='恢复规则')!;
 assert.ok(resume);assert.equal(resume.disabled,true);assert.match(ui.d.body.textContent!,/事项已暂停或归档/);assert.doesNotMatch(ui.d.body.textContent!,/正在进行/);
 await act(async()=>resume.click());assert.equal(remote.calls.some(call=>call.method==='POST'),false);assert.equal([...ui.d.querySelectorAll('button')].some(button=>button.textContent==='归档'),false,'rules expose no unsupported archive command');
});

test('narrow source scope survives list, tabs, rule selection and its parent detail request',async t=>{
 const ui=await fixture(t),scope={kind:'selection',evidenceIds:[evidenceId]},current=routine();current.scope=scope as Routine['scope'];current.matterId=id;
 window.history.replaceState(null,'','#/assistant/matters?'+new URLSearchParams({tab:'routine',scope:JSON.stringify(scope)}));
 const remote=client(path=>{
  if(path.startsWith('/api/assistant/'))assert.deepEqual(JSON.parse(new URLSearchParams(path.split('?')[1]).get('scope')!),scope);
  if(path.startsWith('/api/assistant/routines?'))return {items:[current],nextCursor:null};
  if(path.startsWith('/api/assistant/routines/'))return current;
  throw new ApiError('Generated parent outside the selected scope',404);
 },['http:GET:/api/assistant/routines']);
 await ui.render(remote.api);for(const link of ui.d.querySelectorAll<HTMLAnchorElement>('.segmented-nav a'))assert.deepEqual(JSON.parse(new URLSearchParams(link.hash.split('?')[1]).get('scope')!),scope);
 const href=ui.d.querySelector<HTMLAnchorElement>('.assistant-object-list a')!.hash;assert.deepEqual(JSON.parse(new URLSearchParams(href.split('?')[1]).get('scope')!),scope);
 await act(async()=>ui.root.render(React.createElement('div')));window.history.replaceState(null,'',href);await ui.render(remote.api);
 assert.ok(remote.calls.some(call=>call.path.startsWith('/api/assistant/matters/'+id+'?')));assert.match(ui.d.body.textContent!,/当前事项状态无法确认/);
 const back=[...ui.d.querySelectorAll<HTMLAnchorElement>('a')].find(link=>link.textContent==='返回事项')!;assert.deepEqual(JSON.parse(new URLSearchParams(back.hash.split('?')[1]).get('scope')!),scope);
});

test('an invalid scope deep link fails closed instead of falling back to all sources',async t=>{
 const ui=await fixture(t);window.history.replaceState(null,'','#/assistant/matters?matter='+id+'&scope=invalid');
 const remote=client(()=>assert.fail('invalid scope must not read assistant content'));
 await ui.render(remote.api);assert.ok(ui.d.querySelector('[role=alert]'));assert.equal(remote.calls.some(call=>call.path.startsWith('/api/assistant/')),false);
});

test('an action draft with read capability alone cannot offer an executable product command',async t=>{
 const ui=await fixture(t),current=detail();current.matter.taskIds=[taskId];current.linkedTasks=[{id:taskId,state:'succeeded',revision:3,updatedAt:at}];
 const draft={kind:'todo.create',todo:{title:'Generated next step',description:'Generated only',dueAt:null},evidence:[]};
 const remote=client(path=>{
  if(path.startsWith('/api/assistant/matters/'))return current;
  if(path.includes('/actions?'))return {taskId,revision:3,matterId:id,drafts:[{index:0,draft,targets:[]}]};
  if(path.startsWith('/api/assistant/tasks/'))return {task:{id:taskId,state:'completed',revision:3},result:{answer:'Generated product',citations:[],runId:'generated',trace:[]},actionDrafts:[draft]};
  return {items:[],nextCursor:null};
 },['http:GET:/api/assistant/tasks/:id/actions']);
 await ui.render(remote.api);const button=[...ui.d.querySelectorAll('button')].find(button=>button.textContent==='记为待办')!;assert.ok(button);assert.equal(button.disabled,true);
 await act(async()=>button.click());assert.equal(remote.calls.some(call=>call.method==='POST'),false);
});

test('question and uncertain action links return to the same matter without claiming action success',async t=>{
 const ui=await fixture(t),current=detail();current.matter.taskIds=[taskId];current.linkedTasks=[{id:taskId,state:'succeeded',revision:3,updatedAt:at}];
 const capabilities=['http:GET:/api/owner-questions','http:GET:/api/assistant/tasks/:id/actions'];
 const remote=client(path=>{
  if(path.startsWith('/api/assistant/matters/'))return current;
  if(path.startsWith('/api/owner-questions?')){assert.equal(new URLSearchParams(path.split('?')[1]).get('workId'),'assistant.task:generated-request');return {items:[{id:questionId,title:'Generated missing choice',state:'answered',updatedAt:at}],nextCursor:null};}
  if(path.includes('/actions?'))return {taskId,revision:3,matterId:id,drafts:[{index:0,draft:{kind:'message.send',message:{conversationId:'generated-conversation',text:'Generated message',mentions:[]},evidence:[]},targets:[],linked:{id:evidenceId,kind:'message.send',status:'uncertain'}}]};
  if(path.startsWith('/api/assistant/tasks/'))return {task:{id:taskId,state:'completed',revision:3,goal:'Generated result task'},workId:'assistant.task:generated-request',result:{answer:'Generated task product',citations:[],runId:'generated',trace:[]},actionDrafts:[{kind:'message.send'}]};
  return {items:[],nextCursor:null};
 },capabilities);
 await ui.render(remote.api);const question=ui.d.querySelector<HTMLAnchorElement>('.owner-question-links a')!;assert.ok(question);assert.equal(new URLSearchParams(question.hash.split('?')[1]).get('question'),questionId);
 const action=ui.d.querySelector<HTMLAnchorElement>('.related-action-results a')!;assert.ok(action);assert.equal(new URLSearchParams(action.hash.split('?')[1]).get('action'),evidenceId);assert.equal(new URLSearchParams(action.hash.split('?')[1]).get('returnTo'),window.location.hash);
 assert.match(ui.d.querySelector('.related-action-results')!.textContent!,/保存结果待核实/);assert.doesNotMatch(ui.d.querySelector('.related-action-results')!.textContent!,/已完成/);
});
