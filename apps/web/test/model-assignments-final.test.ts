import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {MODEL_FEATURES} from '@mote/shared/models';
import {ModelAssignments} from '../src/plugins/models-processing/ModelAssignments';
import {ApiError,type Api} from '../src/api';
import {resources} from '../src/resource-cache';
import {modelView} from './fixtures/model-settings';
function deferred<T>(){let resolve!:(value:T)=>void;return{promise:new Promise<T>(done=>resolve=done),resolve};}
async function fixture(t:import('node:test').TestContext){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/system/models?category=model',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>();configureLocale(()=> 'zh-CN');
 for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});}
 const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());for(const[key,value]of prior)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);dom.window.close();});
 const d=dom.window.document,select=(index:number)=>d.querySelectorAll<HTMLSelectElement>('.module-assignment-row select')[index],save=()=>d.querySelector<HTMLButtonElement>('button[aria-label="保存模块分配"]')!,click=(label:string)=>{const b=[...d.querySelectorAll('button')].find(b=>b.textContent===label);assert.ok(b,label);b.click();};
 const change=async(index:number,value:string)=>act(async()=>{select(index).value=value;select(index).dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 const input=async(value:string)=>act(async()=>{const field=d.querySelector<HTMLInputElement>('.module-selection input')!;field.focus();Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new dom.window.Event('input',{bubbles:true}));field.dispatchEvent(new dom.window.Event('change',{bubbles:true}));field.dispatchEvent(new dom.window.KeyboardEvent('keyup',{bubbles:true,key:'t'}));});
 const render=(api:Api,revision=0,onManage=()=>{})=>act(async()=>root.render(React.createElement(ModelAssignments,{api,revision,onApplied:()=>{},onManage})));
 const state=(revision=1)=>{const view=modelView();return{...view,revision,profiles:[...view.profiles,{...view.profiles[0],id:'generated-second',name:'Generated second',readOnly:false}]};};
 return{root,d,select,save,change,input,click,render,state};
}
test('custom empty model is an unsaved invalid choice, never silently saves inherited default, and changing connection clears only its custom draft',async t=>{
 const f=await fixture(t),writes:any[]=[],view=f.state();const api={request:async(path:string,init?:RequestInit)=>{if(init?.method==='PUT'){writes.push(JSON.parse(String(init.body)));return{...view,...writes.at(-1),revision:2};}return path.endsWith('/models')?{items:[]}:view;}} as Api;
 await f.render(api);assert.equal(f.save().disabled,true);await f.change(0,'generated-second');await f.change(1,'custom');assert.equal(f.save().disabled,true);assert.match(f.d.body.textContent!,/有未保存的修改/);assert.equal(writes.length,0);
 await f.input('exact-generated-model');assert.equal(f.save().disabled,false);await act(async()=>f.save().click());assert.equal(writes.length,1);assert.equal(writes[0].revision,1);assert.equal(writes[0].defaultModels[MODEL_FEATURES[0]],'exact-generated-model');
 await f.change(0,view.profiles[0].id);assert.equal(f.select(1).value,'inherit');assert.equal(f.d.querySelector('.module-selection input'),null);
});
test('503 and true revision conflicts retain choices until explicit reload is confirmed and succeeds, without automatic rebase',async t=>{
 const f=await fixture(t);let view=f.state(),failSave=503,failRead=false,reads=0,held:Promise<ReturnType<typeof f.state>>|undefined;const writes:any[]=[];
 const api={request:async(_path:string,init?:RequestInit)=>{if(init?.method==='PUT'){writes.push(JSON.parse(String(init.body)));throw new ApiError('Generated safe failure',failSave,undefined,failSave===409?'model_settings_conflict':'service_unavailable');}reads++;if(failRead)throw new ApiError('Generated read failure',503);return held??view;}} as Api;
 await f.render(api);await f.change(0,'generated-second');await act(async()=>f.save().click());assert.equal(f.select(0).value,'generated-second');assert.equal(writes[0].revision,1);assert.doesNotMatch(f.d.querySelector('.module-assignment-error [role=alert]')!.textContent!,/Generated|service_unavailable/);assert.equal(f.d.querySelector<HTMLDetailsElement>('.module-assignment-error details')!.open,false);
 view=f.state(2);failSave=409;await act(async()=>resources(api).invalidate(path=>path==='/api/model-settings'));assert.equal(f.select(0).value,'generated-second');await act(async()=>f.save().click());assert.equal(writes[1].revision,1);
 let confirms=0;window.confirm=()=>{confirms++;return false;};const before=reads;await act(async()=>f.click('重新读取'));assert.equal(confirms,1);assert.equal(reads,before);assert.equal(f.select(0).value,'generated-second');
 window.confirm=()=>true;failRead=true;await act(async()=>f.click('重新读取'));assert.equal(f.select(0).value,'generated-second');assert.match(f.d.querySelector('.module-assignment-error [role=alert]')!.textContent!,/503/);failRead=false;const reloaded=deferred<ReturnType<typeof f.state>>();held=reloaded.promise;await act(async()=>f.click('重新读取'));assert.equal(f.select(0).disabled,true,'confirmed reload cannot overwrite new edits made while pending');assert.equal(f.save().disabled,true);await act(async()=>reloaded.resolve(view));held=undefined;assert.equal(f.select(0).value,view.profiles[0].id);assert.equal(f.save().disabled,true);
 await f.change(0,'generated-second');await act(async()=>f.save().click());assert.equal(writes.at(-1).revision,2);assert.equal(writes.length,3);
});
test('manage navigation cancel keeps draft, missing saved connection is explicit, and late old-owner save cannot replace new owner',async t=>{
 const f=await fixture(t),late=deferred<any>(),view=f.state();let managed=0;const a={request:async(_path:string,init?:RequestInit)=>init?.method==='PUT'?late.promise:view} as Api;
 await f.render(a,0,()=>managed++);await f.change(0,'generated-second');window.confirm=()=>false;await act(async()=>f.click('管理模型连接'));assert.equal(managed,0);assert.equal(f.select(0).value,'generated-second');await act(async()=>f.save().click());
 const bView=f.state(5);bView.defaults[MODEL_FEATURES[0]]='missing-exact-connection';const b={request:async()=>bView} as Api;await f.render(b);assert.equal(f.select(0).value,'missing-exact-connection');assert.match(f.select(0).selectedOptions[0].textContent!,/不存在/);await act(async()=>late.resolve({...view,revision:2}));assert.equal(f.select(0).value,'missing-exact-connection');assert.equal(f.save().disabled,true);assert.doesNotMatch(f.d.body.textContent!,/模块分配已保存/);
});
test('current permission withdrawal removes drafts and fences an already pending same-owner save receipt',async t=>{
 const f=await fixture(t),pending=deferred<any>(),view=f.state();let revoked=false;const api={request:async(_path:string,init?:RequestInit)=>{if(init?.method==='PUT')return pending.promise;if(revoked)throw new ApiError('denied',403);return view;}} as Api;
 await f.render(api);await f.change(0,'generated-second');await act(async()=>f.save().click());revoked=true;await act(async()=>resources(api).invalidate(()=>true));assert.equal(f.d.querySelector('.module-assignment-row'),null);await act(async()=>pending.resolve({...view,revision:2}));assert.equal(f.d.querySelector('.module-assignment-row'),null);assert.doesNotMatch(f.d.body.textContent!,/模块分配已保存/);
});
test('a pending assignment save rejected as forbidden withdraws the former owner controls without a false saved receipt',async t=>{
 const f=await fixture(t),view=f.state();let reject!:(error:unknown)=>void;const pending=new Promise<any>((_resolve,rejectValue)=>{reject=rejectValue;});const api={request:async(_path:string,init?:RequestInit)=>init?.method==='PUT'?pending:view} as Api;
 await f.render(api);await f.change(0,'generated-second');await act(async()=>f.save().click());await act(async()=>reject(new ApiError('Generated pending save forbidden',403)));assert.equal(Boolean(f.d.querySelector('.module-assignment-row')),false,'Forbidden save withdraws assignment controls');assert.doesNotMatch(f.d.body.textContent!,/模块分配已保存/);assert.match(f.d.body.textContent!,/权限|拒绝|403/);
});
