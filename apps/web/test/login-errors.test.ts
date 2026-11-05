import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {ApiError,createApi,errorMessage} from '../src/api.js';

const requestId='c919bc95-272d-4094-92a1-7f9c0ae944ca';
for(const [status,code,expected] of [
  [401,'unauthorized',/凭据已失效/],[403,'origin_denied',/公开地址或反向代理配置/],
  [403,'connection_scope_denied',/连接权限/],[410,'login_expired',/登录请求已失效/],
  [426,'incompatible_protocol',/协议版本不匹配/],
] as const)test(`owner authentication preserves its safe response reason: ${status} ${code}`,async t=>{
  configureLocale(()=> 'zh-CN');
  t.mock.method(globalThis,'fetch',async()=>Response.json({error:code,message:'PRIVATE_SERVER_DETAIL',requestId},{status}));
  await assert.rejects(createApi({token:'generated-owner-token'}).request('/api/login/session'),error=>{
    assert.ok(error instanceof ApiError);assert.equal(error.code,code);assert.match(errorMessage(error),expected);
    assert.match(errorMessage(error),new RegExp(requestId));assert.doesNotMatch(errorMessage(error),/PRIVATE|请升级中央/);return true;
  });
});

async function dialog(t:TestContext){
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://fixture.invalid',pretendToBeVisual:true});
  const before=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,localStorage:dom.window.localStorage,sessionStorage:dom.window.sessionStorage,IS_REACT_ACT_ENVIRONMENT:true})){
    before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  const {createRoot}=await import('react-dom/client'),{LoginDialog}=await import('../src/shell-components.js');
  const root=createRoot(dom.window.document.getElementById('root')!);let connected=0;
  await act(async()=>root.render(React.createElement(LoginDialog,{destination:'资料库',onConnected:()=>connected++,onClose:()=>{}})));
  const input=dom.window.document.querySelector('input')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,'generated-owner-token');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
  t.after(async()=>{await act(async()=>root.unmount());for(const[key,value]of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
  return {dom,connected:()=>connected,submit:()=>act(async()=>{dom.window.document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await new Promise(resolve=>setImmediate(resolve));})};
}

test('owner login recovers from origin refusal and a proxy failure before installing its normal owner session',async t=>{
  const h=await dialog(t);let phase=0;const calls:string[]=[];
  t.mock.method(globalThis,'fetch',async(path:unknown)=>{
    calls.push(String(path));
    if(phase===0)return Response.json({error:'origin_denied',message:'PRIVATE_ORIGIN_DETAIL'},{status:403});
    if(path==='/api/configuration')return Response.json({});
    if(phase===1)return new Response('<html>PRIVATE_PROXY_BODY</html>',{status:503});
    return Response.json({token:'generated-independent-owner-token',expiresAt:Date.now()+86400000});
  });
  await h.submit();assert.match(h.dom.window.document.body.textContent!,/公开地址或反向代理配置/);assert.equal(h.connected(),0);
  phase=1;await h.submit();assert.match(h.dom.window.document.body.textContent!,/503/);assert.doesNotMatch(h.dom.window.document.body.textContent!,/PRIVATE|凭据已失效|请升级/);assert.equal(h.connected(),0);
  phase=2;await h.submit();assert.equal(h.connected(),1);
  assert.deepEqual(calls,['/api/configuration','/api/configuration','/api/login/session','/api/configuration','/api/login/session']);
});
