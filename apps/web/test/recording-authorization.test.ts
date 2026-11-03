import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {randomUUID} from 'node:crypto';
import {configureLocale} from '@mote/shared/i18n';
import {RecordingAuthorization} from '../src/RecordingAuthorization.js';
import {ProviderAuthorization} from '../src/plugins/agent-access/ProviderAuthorization.js';
import type {Api} from '../src/api.js';
configureLocale(()=> 'zh-CN');
async function fixture(t:import('node:test').TestContext){const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>();for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,value] of before)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);});return {root,document:dom.window.document};}
function state(url:string){return {connected:false,authorization:{revision:randomUUID(),task:{id:randomUUID(),kind:'login',state:'waiting',authorizationUrl:url}}};}
test('switching the current API aborts pending authorization requests and ignores late old errors or QR content',async t=>{
 const f=await fixture(t),old=state('https://accounts.feishu.cn/generated-old?opaque=a%2Bb&x=a+b'),next=state('https://login.dingtalk.com/generated-new?opaque=a%2Fb');let rejectOld!:(reason:unknown)=>void,oldSignal:AbortSignal|undefined;
 const a={request:async(_url:string,init?:RequestInit)=>{if(init?.method==='POST'){oldSignal=init.signal as AbortSignal;return new Promise((_resolve,reject)=>rejectOld=reject);}return old;},raw:async()=>{throw Error('unused');}} as Api,b={request:async()=>next,raw:async()=>{throw Error('unused');}} as Api;
 await act(async()=>{f.root.render(React.createElement(RecordingAuthorization,{api:a,provider:'feishu'}));});assert.equal(f.document.querySelector('a')?.getAttribute('href'),old.authorization.task.authorizationUrl);
 await act(async()=>{[...f.document.querySelectorAll('button')].find(button=>button.textContent==='取消当前操作')!.click();});assert.ok(oldSignal);
 await act(async()=>{f.root.render(React.createElement(RecordingAuthorization,{api:b,provider:'dingtalk'}));});assert.equal(oldSignal.aborted,true);await act(async()=>{rejectOld(Error('Generated late old failure'));});assert.equal(f.document.querySelector('a')?.getAttribute('href'),next.authorization.task.authorizationUrl);assert.ok(!f.document.body.textContent?.includes('Generated late old failure'));assert.ok(!f.document.body.innerHTML.includes('generated-old'));
});
test('invalid or expired provider authorization never creates a clickable external link',async t=>{const f=await fixture(t);for(const value of [{url:'https://example.com/generated'},{url:'https://accounts.feishu.cn/generated',expiresAt:'2026-01-01T00:00:00Z'}]){await act(async()=>{f.root.render(React.createElement(ProviderAuthorization,value));});assert.equal(f.document.querySelector('a'),null);assert.ok(f.document.querySelector('[role=alert]'));}});
