import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {configureLocale} from '@mote/shared/i18n';
import {DEPLOYMENT_MODEL_PROFILE_ID,MODEL_FEATURES,type ModelSettingsView} from '@mote/shared/models';
import {buildApp} from '../../server/src/app.js';
import type {ModelAgentFactory} from '../../server/src/model-agent.js';
import {ApiError,type Api} from '../src/api.js';
import {ModelAssignments} from '../src/plugins/models-processing/ModelAssignments.js';

const feature=MODEL_FEATURES[0],profileId='generated-prepared-connection',model='generated-next-model';
const settings=(name:string)=>({provider:'custom',protocol:'openai-completions' as const,baseUrl:'https://generated.invalid/v1',model:name,reasoningEffort:'auto' as const,maxTokens:4096,modelRequestTimeoutMs:120000,agentTimeoutMs:120000,allowUnauthenticatedLocal:false,apiKey:'',headers:{},extraBody:{}});

async function fixture(t:import('node:test').TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-models-processing-contract-')),token='generated-models-processing-'+randomUUID();
 let reject=false;
 const factory:ModelAgentFactory=async selected=>{
  if(reject)throw new Error('Generated prepare rejection');
  return {configured:true,query:async()=>({answer:selected.model,citations:[],trace:[],runId:randomUUID()}),close:async()=>{}};
 };
 const node=await buildApp({dataDir:directory,token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:3_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-original-model',modelBaseUrl:'https://generated.invalid/v1',apiKey:'generated-key',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'},{backgroundWorker:false,createModelAgent:factory});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const call=async(path:string,init?:RequestInit)=>{
  const body=typeof init?.body==='string'?JSON.parse(init.body):undefined;
  const response=await node.app.inject({url:path,method:(init?.method??'GET') as 'GET'|'PUT'|'POST',headers:{authorization:'Bearer '+token},...(body!==undefined?{payload:body}:{})});
  if(response.statusCode>=400){const failure=response.json();throw new ApiError(failure.message??response.body,response.statusCode,failure.requestId,failure.error);}
  return response.json();
 };
 const api={request:call} as Api;
 const initial=(await call('/api/model-settings')) as ModelSettingsView;
 const created=await call('/api/model-settings/profiles/'+profileId,{method:'PUT',body:JSON.stringify({revision:initial.revision,name:'Generated prepared connection',settings:settings(model)})}) as ModelSettingsView;
 assert.ok(created.profiles.some(profile=>profile.id===profileId));
 return {node,api,call,reject:(value:boolean)=>{reject=value;}};
}

async function ui(t:import('node:test').TestContext){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/system/models?category=model',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>();
 configureLocale(()=> 'zh-CN');
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});}
 dom.window.HTMLElement.prototype.scrollIntoView=()=>{};dom.window.scrollTo=()=>{};
 const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of prior)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);dom.window.close();});
 const until=async(check:()=>boolean,label:string)=>{const deadline=Date.now()+15000;while(Date.now()<deadline){if(check())return;await act(async()=>new Promise(resolve=>setTimeout(resolve,5)));}throw Error('Timed out '+label);};
 return {d:dom.window.document,root,until};
}

test('a real prepare failure keeps the effective module combination visible and never reports a switch',async t=>{
 const f=await fixture(t),{d,root,until}=await ui(t);
 const save=()=>d.querySelector<HTMLButtonElement>('button[aria-label="保存模块分配"]')!;
 await act(async()=>root.render(React.createElement(ModelAssignments,{api:f.api,revision:0,onApplied:()=>{},onManage:()=>{}})));
 await until(()=>!!d.querySelector('.module-assignment-row'),'module rows');
 const select=d.querySelector<HTMLSelectElement>('.module-assignment-row select')!;
 await act(async()=>{select.value=profileId;select.dispatchEvent(new d.defaultView!.Event('change',{bubbles:true}));});
 assert.equal(save().disabled,false);
 f.reject(true);
 await act(async()=>save().click());
 await until(()=>!!d.querySelector('.module-assignment-error [role=alert]'),'real prepare failure');
 assert.match(d.querySelector('.module-assignment-error [role=alert]')!.textContent!,/503/);
 assert.equal(select.value,profileId,'the unsaved assignment remains in the draft');
 assert.equal(d.querySelector('.module-assignment-footer [role=status]')!.textContent,'有未保存的修改');
 assert.doesNotMatch(d.body.textContent!,/已切换/);
 await until(()=>!!d.querySelector('.module-assignment-effective'),'effective combination');
 const effective=d.querySelector('.module-assignment-effective')!;
 assert.ok(effective,'the page shows the effective combination');
 assert.match(effective.textContent!,/generated-original-model/);
 assert.doesNotMatch(effective.textContent!,/generated-next-model/);
 const committed=await f.call('/api/model-settings') as ModelSettingsView;
 assert.equal(committed.defaults[feature],DEPLOYMENT_MODEL_PROFILE_ID,'the failed prepare did not commit the requested defaults');
 f.reject(false);
 await act(async()=>save().click());
 await until(()=>d.querySelector('.module-assignment-footer [role=status]')!.textContent?.includes('模块分配已保存')===true,'saved assignment');
 await until(()=>d.querySelector('.module-assignment-effective')!.textContent!.includes('generated-next-model'),'receipt shows the new effective combination');
 assert.match(d.querySelector('.module-assignment-effective')!.textContent!,/Generated prepared connection · generated-next-model/);
 assert.doesNotMatch(d.body.textContent!,/已切换/);
 assert.equal((await f.call('/api/model-settings') as ModelSettingsView).defaults[feature],profileId);
});

test('a real revision conflict keeps the unsaved module draft and the committed combination',async t=>{
 const f=await fixture(t),{d,root,until}=await ui(t);
 const save=()=>d.querySelector<HTMLButtonElement>('button[aria-label="保存模块分配"]')!;
 await act(async()=>root.render(React.createElement(ModelAssignments,{api:f.api,revision:0,onApplied:()=>{},onManage:()=>{}})));
 await until(()=>!!d.querySelector('.module-assignment-row'),'module rows');
 const select=d.querySelector<HTMLSelectElement>('.module-assignment-row select')!;
 await act(async()=>{select.value=profileId;select.dispatchEvent(new d.defaultView!.Event('change',{bubbles:true}));});
 const view=await f.call('/api/model-settings') as ModelSettingsView;
 const concurrentFeature=MODEL_FEATURES.at(-1)!;
 const concurrent=await f.call('/api/model-settings/defaults',{method:'PUT',body:JSON.stringify({revision:view.revision,defaults:{...view.defaults,[concurrentFeature]:profileId},defaultModels:view.defaultModels})}) as ModelSettingsView;
 assert.equal(concurrent.defaults[concurrentFeature],profileId);
 await act(async()=>save().click());
 await until(()=>!!d.querySelector('.module-assignment-error [role=alert]'),'real revision conflict');
 assert.equal(select.value,profileId,'the unsaved draft survives the conflict');
 assert.equal(d.querySelector('.module-assignment-footer [role=status]')!.textContent,'有未保存的修改');
 assert.doesNotMatch(d.body.textContent!,/模块分配已保存|已切换/);
 const committed=await f.call('/api/model-settings') as ModelSettingsView;
 assert.equal(committed.defaults[feature],DEPLOYMENT_MODEL_PROFILE_ID);
 assert.equal(committed.defaults[concurrentFeature],profileId);
});
