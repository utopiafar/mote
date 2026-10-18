import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {ApiError,errorMessage} from '../src/api.js';
import {publicAuth,loginWeb} from '../src/web-auth.js';

const requestId='c919bc95-272d-4094-92a1-7f9c0ae944ca';
for(const [status,code,expected] of [
  [401,'invalid_login',/用户名或密码/],[403,'origin_denied',/公开地址与反向代理/],
  [403,'invalid_identity',/权限/],[403,'csrf_required',/登录校验/],
  [409,'session_changed',/登录会话已改变/],[426,'incompatible_protocol',/协议版本不匹配/],
  [429,'login_throttled',/登录尝试过于频繁/],[429,'login_busy',/其他登录请求/],
] as const)test(`public authentication preserves the server reason: ${status} ${code}`,async t=>{
  configureLocale(()=> 'zh-CN');
  t.mock.method(globalThis,'fetch',async()=>Response.json({error:code,message:'PRIVATE_SERVER_DETAIL',requestId},{status}));
  await assert.rejects(publicAuth('/api/auth/login',{}),error=>{
    assert.ok(error instanceof ApiError);assert.equal(error.code,code);assert.match(errorMessage(error),expected);
    assert.match(errorMessage(error),new RegExp(requestId));assert.doesNotMatch(errorMessage(error),/PRIVATE|请升级中央节点/);return true;
  });
});
test('public login proxy failures preserve status without claiming that credentials expired',async t=>{
  for(const status of [403,413,429,502,503,504,524]){
    const mocked=t.mock.method(globalThis,'fetch',async()=>new Response('<html>PRIVATE_PROXY_BODY</html>',{status}));
    await assert.rejects(publicAuth('/api/auth/login',{}),error=>{
      assert.ok(error instanceof ApiError);assert.equal(error.status,status);assert.equal(error.code,undefined);
      assert.doesNotMatch(errorMessage(error),/PRIVATE|凭据已失效|请升级/);return true;
    });mocked.mock.restore();
  }
});
test('malformed public-authentication success is a response error, not a network or password diagnosis',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response('<html>PRIVATE_SUCCESS_BODY</html>',{status:200}));
  await assert.rejects(publicAuth('/api/auth/login',{}),error=>{assert.ok(error instanceof ApiError);assert.match(errorMessage(error),/响应格式无效/);assert.doesNotMatch(errorMessage(error),/PRIVATE|网络|密码/);return true;});
});
test('an invalid successful login grant fails before session discovery without a TypeError diagnosis',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json(null);});
  await assert.rejects(loginWeb('generated-user','generated-password',0),/响应格式无效/);assert.equal(calls,1);
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
  t.after(async()=>{await act(async()=>root.unmount());for(const[key,value]of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
  return {dom,connected:()=>connected,submit:()=>act(async()=>{dom.window.document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await new Promise(resolve=>setImmediate(resolve));})};
}
test('the login dialog recovers from an origin refusal and a lost session before accepting a matching account',async t=>{
  const h=await dialog(t);let phase=0;const calls:string[]=[];
  const session={mode:'web',origin:'https://fixture.invalid',deploymentId:'generated-deployment',userId:'generated-user',credentialId:'generated-session',csrfToken:'generated-csrf',username:'generated-user',administrator:false};
  t.mock.method(globalThis,'fetch',async(path:unknown)=>{
    calls.push(String(path));
    if(phase===0)return Response.json({error:'origin_denied'},{status:403});
    if(path==='/api/auth/login')return Response.json(session);
    return phase===1?Response.json({error:'invalid_identity'},{status:401}):Response.json(session);
  });
  await h.submit();assert.match(h.dom.window.document.body.textContent!,/公开地址与反向代理/);assert.equal(h.connected(),0);
  phase=1;await h.submit();assert.match(h.dom.window.document.body.textContent!,/无法确认登录会话/);assert.doesNotMatch(h.dom.window.document.body.textContent!,/用户名或密码不正确|请升级/);assert.equal(h.connected(),0);
  phase=2;await h.submit();assert.equal(h.connected(),1);assert.deepEqual(calls,['/api/auth/login','/api/auth/login','/api/auth/self','/api/auth/login','/api/auth/self']);
});
