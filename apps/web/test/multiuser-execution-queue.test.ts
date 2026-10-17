import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {fixture} from '../../server/test/fixtures/scoped-actions.js';
import {EXECUTION_POLICIES} from '../../server/src/execution-policy.js';
import {ApiError,type Api} from '../src/api.js';
import {ExecutionQueueOverview} from '../src/RuntimeSettings.js';
import {configureLocale} from '@mote/shared/i18n';
configureLocale(()=> 'zh-CN');

test('original queue summary displays the current account pool facts and discards a held A response before B',async t=>{
 const f=await fixture(t);let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);t.after(()=>release());
 f.node.execution!.register({kind:'generated.web-queue',pool:'GENERATED_A_POOL',concurrency:()=>1,policy:EXECUTION_POLICIES.deterministic,parseInput:raw=>z.object({}).strict().parse(raw),execute:async()=>{enter();await gate;return null;}});await f.ok(f.a.token,'/api/tasks','POST',{operationId:'generated-a-held',kind:'generated.web-queue',input:{}});await entered;
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>();for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!),d=dom.window.document,calls:string[]=[];let hold=false,readEnter!:()=>void,readRelease!:()=>void;const readEntered=new Promise<void>(r=>readEnter=r),readGate=new Promise<void>(r=>readRelease=r);t.after(async()=>{release();readRelease();await act(async()=>root.unmount());for(const [key,value]of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 function api(user:any,label:string):Api{return {connection:{mode:'web',origin:'http://localhost',deploymentId:f.node.deploymentId,userId:user.userId,credentialId:label,csrfToken:'generated',username:label,administrator:false},request:async<T>(path:string)=>{calls.push(path);const result=await f.request(user.token,path);if(result.statusCode>=400)throw new ApiError(result.body,result.statusCode);if(hold&&label==='A'){readEnter();await readGate;}return result.json<T>();},raw:async()=>{throw Error('No raw queue transport');}};}
 const a=api(f.a,'A'),b=api(f.b,'B'),render=async(value:Api)=>act(async()=>{root.render(React.createElement(React.StrictMode,null,React.createElement(ExecutionQueueOverview,{api:value})));await delay(10);}),wait=async(check:()=>boolean,label:string)=>{for(let n=0;n<300&&!check();n++)await act(async()=>delay(10));assert.ok(check(),label+' '+d.body.textContent);};
 await render(a);await wait(()=>d.body.textContent!.includes('个人任务：执行中 1，排队 0'),'actual account queue');assert.ok(d.body.textContent!.includes('GENERATED_A_POOL'));assert.doesNotMatch(d.body.textContent!,/scope_unavailable/);
 hold=true;const late=api(f.a,'A');await render(late);await readEntered;await render(b);readRelease();await wait(()=>d.body.textContent!.includes('个人任务：执行中 0，排队 0'),'B positive empty queue');assert.doesNotMatch(d.body.textContent!,/GENERATED_A_POOL/);assert.ok(calls.every(path=>path==='/api/tasks/queues'),'Web does not read global execution settings');release();
});
