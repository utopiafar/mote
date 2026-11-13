import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import type {AssistantDraft} from '@mote/shared';
import type {Api} from '../src/api';
import {AssistantDraftActions} from '../src/plugins/ask/AssistantDraftActions';
import {AnswerView} from '../src/shell-components';
import {featuresReady} from '../src/features/bootstrap';
import {ownerQuestionRoute} from '../src/owner-question-route';

configureLocale(()=> 'zh-CN');
const conversationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',turnId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',taskId='dddddddd-dddd-4ddd-8ddd-dddddddddddd',evidenceId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const draft:AssistantDraft={requestId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',revision:1,goal:'Generated task',scope:{kind:'all'},capabilities:['assistant.task.start','assistant.task.preview']};
const task=(state:string)=>({task:{id:taskId,state,revision:3,...(state==='stale'?{}:{requestId:draft.requestId,goal:draft.goal,scope:draft.scope,evidenceDependencies:{version:1,complete:true,ids:[]}})}});
const answer={answer:'Generated grounded result',runId:'generated',trace:[],citations:[{id:evidenceId,capturedAt:'2026-11-01T00:00:00Z',appName:'Generated file',excerpt:'Generated quotation'}]};
async function fixture(t:any){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/ask'}),prior=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){
  prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 }
 Object.assign(dom.window.HTMLElement.prototype,{attachEvent:()=>{},detachEvent:()=>{}});
 const root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,value] of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
 return {root,d:dom.window.document};
}
const render=(root:ReturnType<typeof createRoot>,api:Api,opened:string[])=>act(async()=>root.render(React.createElement(AssistantDraftActions,{api,conversationId,turnId,draft,onOpen:ref=>opened.push(ref),renderAnswer:(value,open)=>React.createElement(AnswerView,{answer:value,onOpen:open,compact:true})})));

test('the original turn restores a persisted result and rechecks its citation before opening',async t=>{
 const {root,d}=await fixture(t),opened:string[]=[];let current=true,reads=0;
 const api={request:async(path:string)=>{assert.match(path,/assistant-tasks\?scope=/);reads++;return {items:[current?{...task('completed'),result:answer}:task('stale')]};}} as Api;
 await render(root,api,opened);
 assert.match(d.body.textContent!,/Generated grounded result/);assert.match(d.body.textContent!,/Generated quotation/);assert.match(d.body.textContent!,/已完成/);
 assert.equal(d.querySelector<HTMLButtonElement>('.assistant-draft-actions .primary')!.disabled,true,'a recovered task is not started again');
 const citation=d.querySelector<HTMLButtonElement>('.citation')!;await act(async()=>citation.click());
 assert.deepEqual(opened,['capture:'+evidenceId]);assert.equal(reads,2,'opening rechecks the task result');
 current=false;await act(async()=>citation.click());
 assert.deepEqual(opened,['capture:'+evidenceId]);assert.match(d.body.textContent!,/资料已变化/);assert.doesNotMatch(d.body.textContent!,/Generated grounded result/);
});

test('starting with no readable material shows the durable gap rather than an invented result',async t=>{
 const {root,d}=await fixture(t),opened:string[]=[];let started=false;
 const api={request:async(_path:string,init?:RequestInit)=>{
  if(init?.method==='POST'){started=true;return {requestId:draft.requestId,taskId};}
  return {items:started?[{...task('needs_input'),error:'no_usable_evidence'}]:[]};
 }} as Api;
 await render(root,api,opened);
 await act(async()=>d.querySelector<HTMLButtonElement>('.assistant-draft-actions .primary')!.click());
 assert.match(d.body.textContent!,/当前范围没有可用正文，任务尚未执行/);assert.doesNotMatch(d.body.textContent!,/Generated grounded result/);
});

test('a task needing owner input opens the existing question inbox with its exact work identity',async t=>{
 await featuresReady;
 const {root,d}=await fixture(t),opened:string[]=[],workId='assistant.task:'+draft.requestId;
 const api={request:async(path:string)=>{
  if(path==='/api/features')return {schemaVersion:1,capabilities:[{id:'http:GET:/api/owner-questions',version:'1',surface:'data',featureId:'mote.owner-questions',state:'active'}]};
  if(path.startsWith('/api/owner-questions?')){
   assert.equal(new URLSearchParams(path.split('?')[1]).get('workId'),workId);
   return {items:[{id:'11111111-1111-4111-8111-111111111111',title:'Generated missing choice',state:'open'}],nextCursor:null};
  }
  return {items:[{...task('needs_input'),workId}]};
 }} as Api;
 await render(root,api,opened);
 const link=d.querySelector<HTMLAnchorElement>('.owner-question-links a');assert.ok(link);
 assert.match(link.textContent!,/Generated missing choice/);assert.equal(link.getAttribute('href'),ownerQuestionRoute('11111111-1111-4111-8111-111111111111'));
 assert.equal(d.querySelectorAll('.owner-question-form').length,0,'task results reuse the question entry instead of creating another reply form');
 assert.doesNotMatch(d.body.textContent!,/Generated grounded result/);
});

test('a delayed citation check from a previous connection cannot open or restore its result',async t=>{
 const {root,d}=await fixture(t),opened:string[]=[];let reads=0,release!:(value:unknown)=>void;
 const old={request:async()=>{reads++;if(reads===1)return {items:[{...task('completed'),result:answer}]};return new Promise(resolve=>{release=resolve;});}} as Api;
 const next={request:async()=>({items:[]})} as Api;
 await render(root,old,opened);assert.match(d.body.textContent!,/Generated grounded result/);
 await act(async()=>d.querySelector<HTMLButtonElement>('.citation')!.click());assert.equal(reads,2);
 await render(root,next,opened);assert.doesNotMatch(d.body.textContent!,/Generated grounded result/);
 await act(async()=>release({items:[{...task('completed'),result:answer}]}));
 assert.deepEqual(opened,[]);assert.doesNotMatch(d.body.textContent!,/Generated grounded result/);
});

test('a restored edited task advances the next command version',async t=>{
 const {root,d}=await fixture(t),opened:string[]=[],commands:any[]=[];
 const saved={...task('needs_input'),expectedRevision:2,task:{...task('needs_input').task,requestId:'ffffffff-ffff-4fff-8fff-ffffffffffff',goal:'Generated previous edit'},error:'no_usable_evidence'};
 const api={request:async(_path:string,init?:RequestInit)=>{if(init?.method==='POST'){const body=JSON.parse(String(init.body));commands.push(body);return {requestId:body.requestId};}return {items:[saved]};}} as Api;
 await render(root,api,opened);const area=d.querySelector<HTMLTextAreaElement>('textarea')!;
 await act(async()=>{area.focus();Object.getOwnPropertyDescriptor(d.defaultView!.HTMLTextAreaElement.prototype,'value')!.set!.call(area,'Generated next edit');area.dispatchEvent(new d.defaultView!.Event('input',{bubbles:true}));area.dispatchEvent(new d.defaultView!.KeyboardEvent('keyup',{bubbles:true,key:'a'}));});
 await act(async()=>d.querySelector<HTMLButtonElement>('.assistant-draft-actions .primary')!.click());
 assert.equal(commands[0].expectedRevision,3);assert.notEqual(commands[0].requestId,saved.task.requestId);assert.equal(commands[0].goal,'Generated next edit');
});
