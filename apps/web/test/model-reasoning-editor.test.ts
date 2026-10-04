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


test('Codex editor saves Fast, blocks unsupported models and clears speed when switching providers',async t=>{
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true});
  const saved=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  dom.window.localStorage.setItem('mote.language','zh-CN');
  const root=createRoot(dom.window.document.getElementById('root')!);
  t.after(async()=>{await act(async()=>root.unmount());for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
  let view:ModelSettingsView={version:1,revision:1,source:'saved',settings:{provider:'codex',protocol:'codex-app-server',baseUrl:'',model:'first',reasoningEffort:'max',maxTokens:8192,modelRequestTimeoutMs:null,agentTimeoutMs:120000,allowUnauthenticatedLocal:false,apiKeyConfigured:false,headersConfigured:false,extraBodyConfigured:false}};
  const bodies:any[]=[];
  const api={request:async(path:string,init?:RequestInit)=>{
    if(init?.method==='PUT'){const body=JSON.parse(String(init.body));bodies.push(body);view={...view,revision:view.revision+1,settings:{...view.settings,...body.settings}};return view;}
    return path==='/api/model-settings'?view:{items:[{id:'first',name:'First',serviceTiers:['default','fast']},{id:'second',name:'Second',serviceTiers:['default']},{id:'legacy',name:'Legacy'}]};
  },setAgentTimeout:()=>{}} as Api;
  await act(async()=>root.render(React.createElement(ModelSettingsEditor,{api,revision:1,onApplied:()=>{}})));
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,550));});
  const select=(label:string)=>dom.window.document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  const change=async(label:string,value:string)=>act(async()=>{const node=select(label);node.value=value;node.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  const submit=async()=>act(async()=>{dom.window.document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));});
  assert.equal(select('速度模式').value,'default');
  await change('速度模式','fast');await submit();
  assert.equal(bodies[0].settings.serviceTier,'fast');assert.equal(bodies[0].settings.reasoningEffort,'max');
  assert.equal(select('速度模式').value,'fast');assert.match(dom.window.document.querySelector('.model-effective-settings')!.textContent!,/Fast/);
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,550));});
  await change('可用模型','second');assert.equal(select('速度模式').querySelector<HTMLOptionElement>('option[value="fast"]')!.disabled,true);
  await submit();assert.equal(bodies.length,1);assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!,/不支持 Fast/);
  await change('可用模型','legacy');assert.equal(select('速度模式').querySelector<HTMLOptionElement>('option[value="fast"]')!.disabled,false);
  assert.match(dom.window.document.body.textContent!,/尚未取得速度档位/);
  await change('服务商类型','openai');assert.equal(dom.window.document.querySelector('select[aria-label="速度模式"]'),null);
  await change('服务商类型','codex');assert.equal(select('速度模式').value,'default');
  await submit();assert.equal(bodies.length,2);assert.equal(bodies[1].settings.serviceTier,'default');
});
