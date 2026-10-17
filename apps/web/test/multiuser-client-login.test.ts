import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {setTimeout as delay} from 'node:timers/promises';
import {randomBytes,createHash} from 'node:crypto';
import {configureLocale} from '@mote/shared/i18n';
import {scopedCaptureFixture} from '../../server/test/fixtures/scoped-capture-host.js';
import {createApi,type Api} from '../src/api.js';
import {ClientLoginApproval} from '../src/ClientLoginApproval.js';
configureLocale(()=> 'zh-CN');

async function harness(t:TestContext){
 const f=await scopedCaptureFixture(t),dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost',pretendToBeVisual:true});
 const login=await f.request(undefined,'/api/auth/login','POST',{username:'generated-a',password:'Generated-M13-archive-only-01',mode:'web'});assert.equal(login.statusCode,200,login.body);
 let cookie=String(login.headers['set-cookie']).split(';')[0];const before=new Map<string,PropertyDescriptor|undefined>();let hold:string|undefined,release:(()=>void)|undefined;
 const posts:string[]=[],clients:Api[]=[],verifiers=new Map<string,string>();let current:Api|undefined,done=0,mounted=true;
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true,fetch:async(path:string,init:RequestInit={})=>{
  const headers=new Headers(init.headers);headers.set('cookie',cookie);const response=await f.host.app.inject({url:path,method:init.method as any??'GET',headers:Object.fromEntries(headers),...(init.body?{payload:String(init.body)}:{})});
  if(init.method==='POST')posts.push(path);
  if(path===hold)await new Promise<void>(resolve=>release=resolve);
  return new Response(response.rawPayload,{status:response.statusCode,headers:response.headers as Record<string,string>});
 }})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!);
 const client=(value:unknown)=>{const api=createApi({mode:'web',origin:'http://localhost',...value as object},undefined,()=>current===api);clients.push(api);return api;},api=client(login.json());current=api;
 const unmount=async()=>{if(mounted){mounted=false;await act(async()=>root.unmount());}};
 t.after(async()=>{release?.();for(const api of clients)api.close?.();await unmount();for(const[key,value]of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 const request=async(name:string,purpose?:'central')=>{const verifier=randomBytes(32).toString('base64url'),result=await f.request(undefined,'/api/login/requests','POST',{serverUrl:'https://fixture.invalid',deviceId:'same-device',deviceName:name,platform:'android',challenge:createHash('sha256').update(verifier).digest('hex'),...(purpose?{purpose}:{})});assert.equal(result.statusCode,200,result.body);const id=result.json().id as string;verifiers.set(id,verifier);return id;};
 // Mirror main.tsx's account-keyed private Suspense tree. An unkeyed render
 // would reuse the DOM button as B's live control, rather than retire A's node.
 const render=(id:string,value=api)=>act(async()=>{const scope=JSON.stringify([value.connection?.deploymentId,value.connection?.userId,value.connection?.credentialId]);root.render(React.createElement(React.StrictMode,null,React.createElement(React.Suspense,{key:scope,fallback:null},React.createElement(ClientLoginApproval,{id,api:value,done:()=>done++}))));await delay(15);});
 const wait=async(predicate:()=>boolean)=>{for(let i=0;i<100&&!predicate();i++)await act(async()=>delay(10));assert.ok(predicate(),dom.window.document.body.textContent??'');};
 const button=()=>dom.window.document.querySelector<HTMLButtonElement>('button')!;
 const useB=async()=>{await api.request('/api/auth/logout',{method:'POST',body:'{}'});const login=await f.request(undefined,'/api/auth/login','POST',{username:'generated-b',password:'Generated-M13-archive-only-01',mode:'web'});assert.equal(login.statusCode,200,login.body);cookie=String(login.headers['set-cookie']).split(';')[0];api.close?.();current=client(login.json());return current;};
 const grant=async(id:string)=>{const r=await f.request(undefined,'/api/login/poll','POST',{id,verifier:verifiers.get(id)});assert.equal(r.statusCode,200,r.body);return r.json();};
 return {request,render,wait,button,document:dom.window.document,posts,unmount,useB,grant,A:f.a.userId,B:f.b.userId,done:()=>done,hold:(id:string)=>{hold='/api/login/requests/'+id;},holdApproval:(id:string)=>{hold='/api/login/requests/'+id+'/approve';},release:()=>release?.()};
}

test('browser approval distinguishes device collection from explicit native central access',async t=>{
 const h=await harness(t);await h.render(await h.request('Generated collector'));await h.wait(()=>!h.button().disabled);
 assert.doesNotMatch(h.document.body.textContent!,/所有中央功能/,'device approval must not promise private archive access');
 await h.render(await h.request('Generated central','central'));await h.wait(()=>!h.button().disabled);assert.match(h.document.body.textContent!,/所有中央功能/);
});

test('browser approval retires the old request before the next device details resolve',async t=>{
 const h=await harness(t);await h.render(await h.request('Generated first'));await h.wait(()=>!h.button().disabled);const old=h.button();
 const next=await h.request('Generated next');h.hold(next);await h.render(next);
 assert.equal(h.button().disabled,true,'new request cannot reuse the previous device description');
 await act(async()=>{old.click();await delay(10);});assert.deepEqual(h.posts,[],'a retired approval button cannot admit its old request');
 h.release();await h.wait(()=>!h.button().disabled);assert.match(h.document.body.textContent!,/Generated next/);
});

test('an already approved native grant cannot navigate a retired browser approval component',async t=>{
 const h=await harness(t),id=await h.request('Generated central','central');await h.render(id);await h.wait(()=>!h.button().disabled);h.holdApproval(id);
 await act(async()=>{h.button().click();await delay(10);});await h.wait(()=>h.posts.length===1);await h.unmount();
 await act(async()=>{h.release();await delay(15);});assert.equal(h.done(),0,'late approved fact must not reopen the retired UI');
});

test('StrictMode A approval committed before logout cannot publish into B while both original native grants retain their owners',async t=>{
 const h=await harness(t),a=await h.request('Generated A central','central');await h.render(a);await h.wait(()=>!h.button().disabled);h.holdApproval(a);const oldButton=h.button();
 await act(async()=>{oldButton.click();await delay(10);});await h.wait(()=>h.posts.some(path=>path.endsWith('/approve')));
 const bApi=await h.useB(),b=await h.request('Generated B central','central');await h.render(b,bApi);await h.wait(()=>!h.button().disabled);assert.doesNotMatch(h.document.body.textContent!,/Generated A central/);
 const before=h.posts.length;await act(async()=>{oldButton.click();h.release();await delay(15);});assert.equal(h.posts.length,before,'retired A button cannot borrow B Cookie');assert.equal(h.done(),0,'held committed A response cannot navigate B');
 const aGrant=await h.grant(a);assert.equal(aGrant.ready,true);assert.equal(aGrant.userId,h.A);assert.equal(aGrant.purpose,'central','already admitted native grant survives browser logout');
 await act(async()=>{h.button().click();await delay(10);});await h.wait(()=>h.done()===1);const bGrant=await h.grant(b);assert.equal(bGrant.userId,h.B);assert.equal(bGrant.purpose,'central');
});
