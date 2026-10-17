import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {setTimeout as delay} from 'node:timers/promises';
import {ApiError,apiOwnerKey,type Api} from '../src/api.js';
import {configureLocale} from '@mote/shared/i18n';
import {keepFixture} from '../../server/test/fixtures/keep-controls.js';
configureLocale(()=> 'zh-CN');

test('original admin controls use live M04/M05, and split-export choices retire before account switch',async t=>{
 const f=await keepFixture(t),dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/preferences',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>(),nativeFetch=fetch;
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const [{InstanceControls},{FilesExport},{AccountSettings},{ScopedVault}]=await Promise.all([import('../src/InstanceControls.js'),import('../src/FilesExport.js'),import('../src/AccountSettings.js'),import('../src/ScopedVault.js')]);
 const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!),d:Document=dom.window.document,calls:{owner:string;path:string;body?:any}[]=[],downloads:string[]=[];
 const originalClick=dom.window.HTMLAnchorElement.prototype.click;dom.window.HTMLAnchorElement.prototype.click=function(){downloads.push(this.download);};
 t.after(async()=>{await act(async()=>root.unmount());dom.window.HTMLAnchorElement.prototype.click=originalClick;for(const [key,value]of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 let loseIndexAck=true;
 const api=(account:any):Api=>{
  const raw=async(path:string,init:RequestInit={})=>{calls.push({owner:account.userId,path,...(init.body?{body:JSON.parse(String(init.body))}:{})});const response=await nativeFetch(f.origin+path,{...init,headers:{'x-mote-protocol-version':'2','content-type':'application/json',authorization:'Bearer '+account.token,...init.headers}});if(path==='/api/admin/index/rebuild'&&loseIndexAck){loseIndexAck=false;throw Error('GENERATED_RESPONSE_ONLY_ACK_LOSS');}return response;};
  return {connection:{mode:'web',origin:f.origin,deploymentId:f.node.deploymentId,userId:account.userId,credentialId:account.credentialId,username:account.username,administrator:account.userId===f.admin.userId,csrfToken:'generated'},raw,request:async(path:string,init?:RequestInit)=>{const r=await raw(path,init),body=await r.json();if(!r.ok)throw new ApiError(body.error,r.status,undefined,body.error);return body;}} as Api;
 };
 const admin=api(f.admin),a=api(f.a),b=api(f.b),render=(value:React.ReactNode)=>act(async()=>{root.render(value);await delay(30);});
 const until=async(check:()=>boolean)=>{for(let n=0;n<100;n++){if(check())return;await act(async()=>delay(20));}assert.fail(d.body.textContent??'no page');};
 await render(React.createElement(AccountSettings,{api:admin,disconnect:()=>{},onLogin:()=>{}}));await until(()=>!!d.querySelector('.runtime-settings input[type=number]'));
 assert.ok(d.body.textContent!.includes('实例运行设置与索引维护'));assert.doesNotMatch(d.body.textContent!,/记录详细 Agent 过程/);
 const input=d.querySelector<HTMLInputElement>('.runtime-settings input[type=number]')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,'1');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 // Number input change plumbing is characterized by the original component;
 // native form submit here exercises its actual revision-bearing save action.
 const form=d.querySelector<HTMLFormElement>('.runtime-settings form')!;await act(async()=>{form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await delay(40);});
 await until(()=>calls.some(call=>call.path==='/api/admin/execution-settings'&&!!call.body));const saved=calls.find(call=>call.path==='/api/admin/execution-settings'&&!!call.body)!;assert.equal(typeof saved.body.revision,'number');assert.equal(saved.body.interactiveConcurrency,1);assert.ok(!Object.hasOwn(saved.body,'queues'));
 const button=(text:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(value=>value.textContent===text);
 await act(async()=>{button('重建索引')!.click();await delay(30);});await until(()=>!!button('重试原操作'));const originalOperation=calls.find(value=>value.path==='/api/admin/index/rebuild')!.body.operationId;
 await render(React.createElement(AccountSettings,{key:'resume-admin',api:admin,disconnect:()=>{},onLogin:()=>{}}));await until(()=>!!button('重试原操作'));await act(async()=>{button('重试原操作')!.click();await delay(30);});await until(()=>calls.filter(value=>value.path==='/api/admin/index/rebuild').length===2);assert.deepEqual(calls.filter(value=>value.path==='/api/admin/index/rebuild').map(value=>value.body.operationId),[originalOperation,originalOperation]);
 localStorage.setItem('mote.index-rebuild.v1:'+apiOwnerKey(admin),'GENERATED_BROKEN_INTENT');await render(React.createElement(AccountSettings,{key:'invalid-admin',api:admin,disconnect:()=>{},onLogin:()=>{}}));await until(()=>!!button('移除本机待确认提交'));assert.equal(button('重建索引')!.disabled,true);await act(async()=>button('移除本机待确认提交')!.click());
 const staleForm=form;await render(React.createElement(AccountSettings,{key:'B',api:b,disconnect:()=>{},onLogin:()=>{}}));assert.equal(d.querySelector('.runtime-settings'),null);const before=calls.length;await act(async()=>staleForm.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));assert.equal(calls.length,before);
 await render(React.createElement(FilesExport,{key:'A',api:a}));const meta=Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='导出元数据')!;assert.equal(meta.disabled,true);
 await act(async()=>{const select=d.querySelector<HTMLSelectElement>('select')!;select.value='text/*';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});assert.equal(meta.disabled,false);
 await act(async()=>{meta.click();await delay(50);});await until(()=>downloads.includes('mote-files-metadata.tar.gz'));assert.ok(calls.some(call=>call.owner===f.a.userId&&call.path.includes('mode=metadata')&&call.path.includes('type=text%2F*')&&call.path.includes('selection=current')));
 const staleButton=meta;await render(React.createElement(FilesExport,{key:'B',api:b}));const beforeSwitch=calls.length;await act(async()=>staleButton.click());assert.equal(calls.length,beforeSwitch);assert.equal(d.querySelector<HTMLSelectElement>('select')!.value,'');
 await render(React.createElement(ScopedVault,{key:'vaultB',api:b,disconnect:()=>{}}));assert.ok(d.querySelector('.files-export'),'original storage entry mounts both real split-export controls');
 await render(React.createElement(InstanceControls,{key:'ordinary',api:b}));assert.equal(d.body.textContent,'');
});
