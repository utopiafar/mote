import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {setTimeout as delay} from 'node:timers/promises';
import {configureLocale} from '@mote/shared/i18n';
import {scopedFilesFixture} from '../../server/test/fixtures/scoped-files.js';
import {pages} from '../src/features/connections.js';
import {createApi,type Api} from '../src/api.js';
configureLocale(()=> 'zh-CN');

test('original Web device invitation pairs through actual QR v2, cancels and retires held A secrets before B',async t=>{
 const f=await scopedFilesFixture(t),dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/connections/access',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>();
 let current:Api|undefined,cookie='',hold=false,entered!:()=>void,release!:()=>void,damaged=false;
 const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r),calls:{path:string;method:string;body:string}[]=[];
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,IS_REACT_ACT_ENVIRONMENT:true,fetch:async(path:string,init:RequestInit={})=>{
  const headers=new Headers(init.headers);headers.set('cookie',cookie);const r=await f.host.app.inject({url:path,method:init.method as any??'GET',headers:Object.fromEntries(headers),...(init.body?{payload:String(init.body)}:{})});calls.push({path,method:init.method??'GET',body:String(init.body??'')});
  if(path==='/api/connections/invitations'&&r.statusCode===200){if(hold){hold=false;entered();await gate;}if(damaged){const value=r.json();value.invitation.userId=f.a.userId;return Response.json(value);}}
  return new Response(r.rawPayload,{status:r.statusCode,headers:r.headers as Record<string,string>});
 }})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!),d=dom.window.document;
 t.after(async()=>{release();current?.close?.();await act(async()=>root.unmount());dom.window.close();for(const [key,value]of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
 const render=async(owner:string)=>{const r=await f.request(undefined,'/api/auth/login','POST',{username:'generated-'+owner,password:'Generated-joint-files-password',mode:'web'});assert.equal(r.statusCode,200,r.body);cookie=String(r.headers['set-cookie']).split(';')[0];const api=createApi({mode:'web',origin:'http://localhost',...r.json()},undefined,()=>current===api);current?.close?.();current=api;await act(async()=>{root.render(React.createElement(React.StrictMode,null,React.createElement(React.Fragment,{key:JSON.stringify(api.connection)},pages[0].render({api,devices:[]} as any))));await delay(10);});};
 const button=(text:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent===text),press=async(text:string)=>act(async()=>{const b=button(text);assert.ok(b,text+' '+d.body.textContent);b.click();await delay(10);}),wait=async(read:()=>boolean,label:string)=>{for(let i=0;i<500&&!read();i++)await act(async()=>delay(10));assert.ok(read(),label+' '+d.body.textContent);};
 const invitation=()=>JSON.parse(d.querySelector<HTMLTextAreaElement>('textarea[aria-label="连接邀请 JSON"]')!.value);
 const claim=async(inv:any,deviceId:string)=>{const verifier='v'.repeat(43),r=await f.request(undefined,'/api/connections/redeem','POST',{code:inv.code,expected:{deploymentId:inv.deploymentId,userId:inv.userId,serverUrl:inv.serverUrl,purpose:'device'},deviceId,deviceName:'Generated phone',platform:'android',challenge:createHash('sha256').update(verifier).digest('hex')});assert.equal(r.statusCode,200,r.body);const grant=await f.checked(undefined,'/api/login/poll','POST',{id:r.json().id,verifier});return {grant,id:r.json().id,verifier};};
 await render('a');await press('生成设备二维码');await wait(()=>!!d.querySelector('textarea[aria-label="连接邀请 JSON"]'),'actual invitation');const a=invitation();assert.equal(a.version,2);assert.equal(a.purpose,'device');assert.equal(a.userId,f.a.userId);assert.ok(!('deviceId'in a));assert.doesNotMatch(d.body.textContent!,/与节点令牌相同的完整权限/);
 const paired=await claim(a,'generated-new-phone');assert.equal(paired.grant.userId,f.a.userId);assert.equal((await f.request(paired.grant.token,'/api/materials')).statusCode,403);assert.equal((await f.checked(paired.grant.token,'/api/connections/self')).credential.deviceId,'generated-new-phone');await f.checked(undefined,'/api/login/ack','POST',{id:paired.id,verifier:paired.verifier});
 await press('重新生成二维码');await wait(()=>invitation().code!==a.code,'new invitation');const cancelled=invitation();await press('取消邀请');assert.equal(d.querySelector('textarea[aria-label="连接邀请 JSON"]'),null);assert.equal((await f.request(undefined,'/api/connections/redeem','POST',{code:cancelled.code,expected:{deploymentId:cancelled.deploymentId,userId:cancelled.userId,serverUrl:cancelled.serverUrl,purpose:'device'},deviceId:'another-phone',deviceName:'Generated',platform:'android',challenge:'a'.repeat(64)})).statusCode,410);
 await wait(()=>!!d.querySelector('select[aria-label="邀请设备身份"] option[value="same-device"]'),'real owned devices');await act(async()=>{const select=d.querySelector<HTMLSelectElement>('select[aria-label="邀请设备身份"]')!;select.value='same-device';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});await press('生成设备二维码');await wait(()=>!!d.querySelector('textarea[aria-label="连接邀请 JSON"]'),'original-device reauthorization');assert.equal(invitation().deviceId,'same-device');
 const oldGenerate=button('重新生成二维码')!;hold=true;await press('重新生成二维码');await ready;await render('b');const before=calls.length;await act(async()=>{oldGenerate.click();release();await delay(30);});assert.equal(calls.slice(before).filter(c=>c.method==='POST').length,0,'old A callback cannot borrow B');assert.equal(d.querySelector('textarea[aria-label="连接邀请 JSON"]'),null,'held A secret cannot refill B');
 await press('生成设备二维码');await wait(()=>!!d.querySelector('textarea[aria-label="连接邀请 JSON"]'),'B positive');assert.equal(invitation().userId,f.b.userId);await press('取消邀请');damaged=true;await press('生成设备二维码');await wait(()=>!!d.querySelector('[role="alert"]'),'malformed same-success response');assert.equal(d.querySelector('textarea[aria-label="连接邀请 JSON"]'),null,'a mismatched owner invitation is never presented');
});
