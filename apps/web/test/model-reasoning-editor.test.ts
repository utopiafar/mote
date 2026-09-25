import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {ModelSettingsEditor} from '../src/ModelSettingsEditor';
import type {Api} from '../src/api';
import type {ModelSettingsView} from '@mote/shared/models';

test('Codex editor renders the selected model effort levels from model/list',async t=>{
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true});
  const saved=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  dom.window.localStorage.setItem('mote.language','zh-CN');
  const root=createRoot(dom.window.document.getElementById('root')!);
  t.after(async()=>{await act(async()=>root.unmount());for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
  const view:ModelSettingsView={version:1,revision:1,source:'saved',settings:{provider:'codex',protocol:'codex-app-server',baseUrl:'',model:'first',reasoningEffort:'medium',maxTokens:8192,modelRequestTimeoutMs:null,agentTimeoutMs:null,allowUnauthenticatedLocal:false,apiKeyConfigured:false,headersConfigured:false,extraBodyConfigured:false}};
  let saves=0;
  const api={request:async(path:string,init?:RequestInit)=>{if(init?.method==='PUT')saves++;return path==='/api/model-settings'?view:{items:[
    {id:'first',name:'First',defaultReasoningEffort:'medium',reasoningEfforts:['low','medium','high','max']},
    {id:'second',name:'Second',defaultReasoningEffort:'low',reasoningEfforts:['low','high']},
  ]};},setAgentTimeout:()=>{}} as Api;
  await act(async()=>root.render(React.createElement(ModelSettingsEditor,{api,revision:1,onApplied:()=>{}})));
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,550));});
  const select=dom.window.document.querySelector<HTMLSelectElement>('select[aria-label="推理强度"]')!;
  assert.deepEqual(Array.from(select.options).filter(option=>!option.disabled).map(option=>option.value),['auto','low','medium','high','max']);
  const model=dom.window.document.querySelector<HTMLSelectElement>('select[aria-label="可用模型"]')!;
  await act(async()=>{model.value='second';model.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  assert.deepEqual(Array.from(select.options).filter(option=>!option.disabled).map(option=>option.value),['auto','low','high']);
  assert.equal(select.value,'medium');
  assert.equal(Array.from(select.options).find(option=>option.value==='medium')?.disabled,true);
  await act(async()=>{dom.window.document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));});
  assert.equal(saves,0);
  assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!,/当前推理强度不受所选 Codex 模型支持/);
});
