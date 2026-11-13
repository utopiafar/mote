import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import type {AssistantDraft} from '@mote/shared';
import {ApiError,type Api} from '../src/api';
import {AssistantDraftActions} from '../src/plugins/ask/AssistantDraftActions';

configureLocale(()=> 'zh-CN');
const conversationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',turnId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const previewDraft:AssistantDraft={requestId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',revision:1,goal:'Generated goal',scope:{kind:'all'},capabilities:['assistant.task.preview']};

async function fixture(t:any){
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/ask'}),prior=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){
    prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  const root=createRoot(dom.window.document.getElementById('root')!);
  Object.assign(dom.window.HTMLElement.prototype,{scrollIntoView:()=>{},attachEvent:()=>{},detachEvent:()=>{}});
  t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,previous] of prior){if(previous)Object.defineProperty(globalThis,key,previous);else Reflect.deleteProperty(globalThis,key);}});
  return {root,d:dom.window.document};
}
const button=(d:Document,text:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(item=>item.textContent?.includes(text));
const field=async(d:Document,value:string)=>act(async()=>{const area=d.querySelector<HTMLTextAreaElement>('textarea[aria-label="工作目标"]')!;area.focus();Object.getOwnPropertyDescriptor(d.defaultView!.HTMLTextAreaElement.prototype,'value')!.set!.call(area,value);area.dispatchEvent(new d.defaultView!.Event('input',{bubbles:true}));area.dispatchEvent(new d.defaultView!.KeyboardEvent('keyup',{bubbles:true,key:'a'}));});
const render=(root:ReturnType<typeof createRoot>,api:Api,draft:AssistantDraft)=>act(async()=>root.render(React.createElement(AssistantDraftActions,{api,conversationId,turnId,draft})));

test('a validated draft exposes an editable goal and a side-effect-free scope command',async t=>{
  const {root,d}=await fixture(t),calls:{path:string;body:any}[]=[];
  const api={request:async(path:string,init?:RequestInit)=>{calls.push({path,body:JSON.parse(String(init?.body))});return {requestId:previewDraft.requestId};}} as Api;
  await render(root,api,previewDraft);
  assert.equal(d.querySelector<HTMLTextAreaElement>('textarea[aria-label="工作目标"]')!.value,'Generated goal');
  assert.equal(button(d,'开始')!.disabled,true);
  assert.match(d.querySelector('.assistant-draft-note')!.textContent!,/任务服务尚未接通/);
  await act(async()=>button(d,'查看将使用的范围')!.click());
  assert.deepEqual(calls,[{path:'/api/assistant/commands',body:{conversationId,turnId,requestId:previewDraft.requestId,expectedRevision:1,capability:'assistant.task.preview',goal:'Generated goal',scope:{kind:'all'}}}]);
  assert.match(d.querySelector('.assistant-draft-status')!.textContent!,/草稿范围已确认/);
});

test('start retries keep the same requestId',async t=>{
  const {root,d}=await fixture(t),calls:any[]=[];let fail=true;
  const startDraft={...previewDraft,capabilities:['assistant.task.start','assistant.task.preview'] as AssistantDraft['capabilities']};
  const api={request:async(_path:string,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));calls.push(body);if(fail){fail=false;throw new ApiError('Generated start unavailable',503);}return {requestId:body.requestId};}} as Api;
  await render(root,api,startDraft);
  await act(async()=>button(d,'开始')!.click());
  assert.match(d.querySelector('[role=alert]')!.textContent!,/草稿提交失败/);
  await act(async()=>button(d,'开始')!.click());
  assert.equal(calls[0].requestId,calls[1].requestId);
  assert.equal(calls[0].requestId,startDraft.requestId);
  assert.match(d.querySelector('[role=status]')!.textContent!,/任务已创建/);
  assert.equal(button(d,'开始')!.disabled,true);
});

test('editing creates one explicit new version; reverting restores the original version',async t=>{
  const {root,d}=await fixture(t),calls:any[]=[];
  const api={request:async(_path:string,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));calls.push(body);return {requestId:body.requestId};}} as Api;
  await render(root,api,previewDraft);
  await field(d,'Generated edited goal');
  await act(async()=>button(d,'查看将使用的范围')!.click());
  assert.equal(calls[0].expectedRevision,2);
  assert.equal(calls[0].goal,'Generated edited goal');
  assert.notEqual(calls[0].requestId,previewDraft.requestId);
  await act(async()=>button(d,'查看将使用的范围')!.click());
  assert.equal(calls[1].requestId,calls[0].requestId,'retrying the same edited content keeps its identity');
  await field(d,'Generated goal');
  await act(async()=>button(d,'查看将使用的范围')!.click());
  assert.equal(calls[2].requestId,previewDraft.requestId,'returning to the original goal restores the original version');
  assert.equal(calls[2].expectedRevision,1);
});

test('stale or deleted drafts keep the goal and explain the retry path',async t=>{
  const {root,d}=await fixture(t);
  const api={request:async()=>{throw new ApiError('Generated draft changed',409);}} as Api;
  await render(root,api,previewDraft);
  await act(async()=>button(d,'查看将使用的范围')!.click());
  assert.match(d.querySelector('[role=alert]')!.textContent!,/这份草稿已失效/);
  assert.equal(d.querySelector<HTMLTextAreaElement>('textarea[aria-label="工作目标"]')!.value,'Generated goal');
});

test('each edit after a started task creates the next immutable command version',async t=>{
  const {root,d}=await fixture(t),calls:any[]=[];
  const startDraft={...previewDraft,capabilities:['assistant.task.start','assistant.task.preview'] as AssistantDraft['capabilities']};
  const api={request:async(_path:string,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));calls.push(body);return {requestId:body.requestId};}} as Api;
  await render(root,api,startDraft);await act(async()=>button(d,'开始')!.click());
  await field(d,'Generated first edit');await act(async()=>button(d,'开始')!.click());
  await field(d,'Generated second edit');await act(async()=>button(d,'开始')!.click());
  await field(d,'Generated goal');await act(async()=>button(d,'开始')!.click());
  assert.deepEqual(calls.map(call=>call.expectedRevision),[1,2,3,4]);
  assert.equal(new Set(calls.map(call=>call.requestId)).size,4);
  assert.deepEqual(calls.map(call=>call.goal),['Generated goal','Generated first edit','Generated second edit','Generated goal']);
});
