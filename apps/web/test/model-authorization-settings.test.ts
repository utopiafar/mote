import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {ApiError,type Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';
configureLocale(()=>'zh-CN');
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
const {createRoot}=await import('react-dom/client');
const {ModelAuthorizationSettings}=await import('../src/ModelAuthorizationSettings.js');
const path='/api/model-authorization',connection={id:'profile:fixture:generated-model',fingerprint:'a'.repeat(64)};
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
async function setup(t:any){
 let state={revision:0,state:'unapproved',connections:[] as typeof connection[],scope:{sourceIds:[] as string[]|null,dataKinds:[] as string[]}},fail=false,offline=false;
 const writes:any[]=[];
 const api={request:async(url:string,init?:RequestInit)=>{
  if(offline)throw Error('generated offline');
  if(url==='/api/model-settings')return {profiles:[{id:'fixture',name:'Generated provider'}]};
  if(url==='/api/file-processing')return {policy:{services:[]},processors:[]};
  if(url==='/api/sources')return {items:[{id:'fixture-source',name:'Generated source'}]};
  if(url==='/api/devices')return {items:[]};
  if(init?.method==='POST'){
   const body=JSON.parse(String(init.body));writes.push(body);if(fail)throw Error('generated uncertain write');
   state={...state,revision:state.revision+1,state:body.action==='authorize'?'enabled':body.action==='pause'?'paused':'stopped',...(body.action==='authorize'?{connections:body.connections,scope:body.scope}:{})};return structuredClone(state);
  }
  return {authorization:structuredClone(state),connections:[connection]};
 }} as unknown as Api;
 const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);
 const render=async(current=api)=>{await act(async()=>{root.render(React.createElement(ModelAuthorizationSettings,{api:current}));await tick();});};
 await render();t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 return {api,container,writes,render,set fail(value:boolean){fail=value;},set offline(value:boolean){offline=value;}};
}
const button=(c:HTMLElement,label:string)=>[...c.querySelectorAll('button')].find(b=>b.textContent===label)!;
async function click(c:HTMLElement,label:string){await act(async()=>{button(c,label).click();await tick();});}
async function check(c:HTMLElement,label:string){await act(async()=>{const input=[...c.querySelectorAll('label')].find(x=>x.textContent===label)?.querySelector('input');assert.ok(input,label);input.click();await tick();});}
async function select(c:HTMLElement){for(const text of ['Generated provider · generated-model','Generated source','文字','我已核对数据范围、模型服务与可能产生的费用'])await check(c,text);}

test('approval requires explicit model, source, representation and cost consent; pause and stop remain distinct',async t=>{
 const f=await setup(t);assert.equal(f.writes.length,0);assert.equal(button(f.container,'授权后续后台处理').disabled,true);
 await select(f.container);await click(f.container,'授权后续后台处理');
 assert.equal(f.writes.length,1);assert.deepEqual(f.writes[0].connections,[connection]);assert.deepEqual(f.writes[0].scope,{sourceIds:['fixture-source'],dataKinds:['text']});
 await click(f.container,'暂停新任务');assert.equal(f.writes.at(-1).action,'pause');assert.equal('scope' in f.writes.at(-1),false);assert.match(f.container.textContent!,/已受理任务继续完成/);
 await click(f.container,'立即停止并撤销自动任务');assert.equal(f.writes.at(-1).action,'stop');assert.match(f.container.textContent!,/已撤销在途自动任务/);
});

test('uncertain save retries reuse the operation, refresh and offline errors retain the draft without claiming success',async t=>{
 const f=await setup(t);await select(f.container);f.fail=true;await click(f.container,'授权后续后台处理');
 assert.match(f.container.textContent!,/generated uncertain write/);assert.equal(f.writes.length,1);
 await act(async()=>{resources(f.api).invalidate(k=>k===path);await tick();});
 assert.equal(button(f.container,'授权后续后台处理').disabled,false);
 f.fail=false;await click(f.container,'授权后续后台处理');assert.equal(f.writes[0].operationId,f.writes[1].operationId);
 await check(f.container,'音频原件');f.offline=true;await act(async()=>{resources(f.api).invalidate(k=>k===path);await tick();});
 assert.match(f.container.textContent!,/generated offline/);assert.equal(button(f.container,'授权后续后台处理').disabled,true);
 assert.equal([...f.container.querySelectorAll('label')].find(x=>x.textContent==='音频原件')!.querySelector('input')!.checked,true);
});

test('cancel draft never sends authority and switching owner clears the previous selection',async t=>{
 const f=await setup(t);await select(f.container);await click(f.container,'重新读取并还原草稿');assert.equal(f.writes.length,0);assert.equal(button(f.container,'授权后续后台处理').disabled,true);
 await select(f.container);
 const other={request:async(url:string)=>url===path?{authorization:{revision:8,state:'unapproved',connections:[],scope:{sourceIds:[],dataKinds:[]}},connections:[]}:url==='/api/model-settings'?{profiles:[]}:{items:[]}} as unknown as Api;
 await f.render(other);assert.doesNotMatch(f.container.textContent!,/Generated provider/);assert.match(f.container.textContent!,/请先配置模型连接/);assert.equal(f.writes.length,0);
});
