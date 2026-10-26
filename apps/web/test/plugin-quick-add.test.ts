import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import React,{act,useState} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import type {PluginCenterView,PluginInstanceView,PluginPackageView,PluginReleasePreview,MemoryBindingView} from '@mote/shared';
import {ApiError,type Api} from '../src/api.js';
import {quickAddStorageKey,quickConfiguration,readQuickAdd,saveQuickAdd,type QuickAdd} from '../src/plugin-quick-add.js';
import {clearSession} from '../src/session.js';

configureLocale(()=> 'zh-CN');
const dom=new JSDOM('<html><body></body></html>',{url:'http://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,sessionStorage:dom.window.sessionStorage,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true});
dom.window.confirm=()=>true;
const {createRoot}=await import('react-dom/client');
const {PluginQuickAdd}=await import('../src/PluginQuickAdd.js');
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
const scope=randomUUID();
function preview():PluginReleasePreview{return {id:randomUUID(),name:'Hindsight (Mote adapter)',version:'0.10.2',source:{repository:'vectorize-io/hindsight',tag:'v0.10.2',commit:'a'.repeat(40),digest:'b'.repeat(64)},runtime:'service',restartRequired:false,capabilities:[{id:'engine',state:'unknown'}],dependencies:['Generated Docker boundary'],access:['Configured provider endpoints'],issues:[],installable:true};}
function checkpoint():QuickAdd{return {version:1,scope,recipe:'hindsight',preview:preview(),stage:'preview'};}
function button(host:Element,text:string){const found=[...host.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent===text);assert.ok(found,text);return found;}
async function click(host:Element,text:string){await act(async()=>{button(host,text).click();await tick();});}
function fixture(){
 const source=preview(),packageId='mote.hindsight@'+source.source.digest;
 const pkg:PluginPackageView={id:packageId,name:source.name,version:source.version,source:source.source,runtime:'service',state:'installed',desired:false,observed:'installed',issues:[],instanceIds:[],configurationSchema:[{id:'modelProfileId',label:'Model profile',type:'model-profile',required:true}],allowedActions:['configure','uninstall']};
 const inventory:PluginCenterView={revision:1,installation:{supported:true,runtime:'worker',restartRequired:false},packages:[],instances:[],catalog:[]};
 const calls:{path:string;body:string}[]=[],instances=new Map<string,PluginInstanceView>();let loseCreate=false,denied=false,conflict=false;
 const api={request:async(path:string,init?:RequestInit)=>{
  if(denied)throw new ApiError('Generated permission refusal',403);
  if(!init?.method){if(path==='/api/model-settings')return {profiles:[{id:'generated-model',name:'Generated model'}]};throw Error('Unexpected read '+path);}
  calls.push({path,body:String(init.body)});const body=JSON.parse(String(init.body));
  if(path.endsWith('/resolve'))return source;
  if(conflict)throw new ApiError('Generated revision conflict',409);
  if(path.endsWith('/install')){inventory.packages=[pkg];inventory.revision++;return structuredClone(inventory);}
  if(path==='/api/plugin-instances'){
   if(!instances.has(body.operationId)){const instance:PluginInstanceView={id:body.operationId,packageId,name:body.name,scope:'default',revision:1,configurationSchema:pkg.configurationSchema!,configuration:body.configuration,secretStatus:{},capabilities:[{id:'engine',state:'unknown'}],desired:false,observed:'configured',issues:[],allowedActions:['configure','check']};instances.set(instance.id,instance);inventory.instances=[instance];inventory.revision++;}
   if(loseCreate){loseCreate=false;throw new TypeError('Generated committed create with lost response');}return structuredClone(instances.get(body.operationId));
  }
  if(path.endsWith('/check')){const instance=inventory.instances[0];assert.equal(body.expectedRevision,instance.revision);instance.revision++;instance.observed='checking';instance.allowedActions=[];return structuredClone(instance);}
  throw Error('Unexpected mutation '+path);
 }} as unknown as Api;
 return {api,inventory,calls,instances,lose:()=>{loseCreate=true;},deny:()=>{denied=true;},conflict:()=>{conflict=true;},pkg};
}
async function mount(f:ReturnType<typeof fixture>,selectedScope=scope){
 const element=document.createElement('div');document.body.appendChild(element);const root=createRoot(element);
 function Harness(){const [view,setView]=useState(structuredClone(f.inventory));return React.createElement(PluginQuickAdd,{api:f.api,viewScope:selectedScope,view,refresh:()=>setView(structuredClone(f.inventory)),onManage:()=>{}});}
 await act(async()=>{root.render(React.createElement(Harness));await tick();});
 return {element,async close(){await act(async()=>root.unmount());element.remove();}};
}
async function install(f:ReturnType<typeof fixture>,element:Element){await click(element,'添加 Hindsight');assert.equal(f.calls.length,1,'selection only resolves the pinned source');assert.ok(element.textContent?.includes('v0.10.2'));await click(element,'安装此版本');assert.equal(f.calls.some(call=>call.path==='/api/plugin-instances'),false);}
async function configure(element:Element){await act(async()=>{const select=element.querySelector('select')!;assert.ok(select);Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype,'value')!.set!.call(select,'generated-model');select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});await click(element,'保存配置');}

test('the adding journal survives reload only in its owner session and never accepts arbitrary commands or secret fields',()=>{
 sessionStorage.clear();const state=checkpoint();assert.equal(saveQuickAdd(state),true);assert.deepEqual(readQuickAdd(scope),state);assert.equal(readQuickAdd(randomUUID()),undefined);assert.equal(sessionStorage.getItem(quickAddStorageKey),null);
 assert.throws(()=>quickConfiguration('mem0',{embeddingBaseUrl:'https://user:password@example.com',embeddingModel:'generated',embeddingDimension:4}));
 assert.deepEqual(quickConfiguration('mem0',{embeddingBaseUrl:'http://127.0.0.1:1',embeddingModel:'generated',embeddingDimension:4,embeddingSecretReference:''}),{embeddingBaseUrl:'http://127.0.0.1:1',embeddingModel:'generated',embeddingDimension:4});
 assert.throws(()=>quickConfiguration('hindsight',{modelProfileId:'generated',apiKey:'must-not-be-saved'}));
 assert.equal(saveQuickAdd({...state,pending:{phase:'check',path:'/api/memory-spaces/default/binding/activate',method:'POST',body:JSON.stringify({expectedRevision:1,operationId:randomUUID()})}}),false);
 assert.equal(saveQuickAdd({...state,preview:{...state.preview,source:{...state.preview.source,repository:'another/untrusted'}}}),false);
 assert.equal(saveQuickAdd(state),true);clearSession();assert.equal(sessionStorage.getItem(quickAddStorageKey),null,'sign-out removes the private checkpoint');
});

test('guided install leads to configuration; paid verification, enabling and binding stay explicit',async()=>{
 sessionStorage.clear();const f=fixture(),ui=await mount(f);
 try{await install(f,ui.element);assert.ok(ui.element.textContent?.includes('保存不会运行核验'));await configure(ui.element);
  assert.equal(f.inventory.instances.length,1);assert.equal(f.inventory.instances[0].desired,false);assert.equal(f.calls.some(call=>call.path.endsWith('/check')),false);
  assert.equal(button(ui.element,'核验能力').disabled,true);assert.ok(ui.element.textContent?.includes('可能产生模型与 Embedding 费用'));
  await act(async()=>ui.element.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());await click(ui.element,'核验能力');
  assert.equal(f.calls.filter(call=>call.path.endsWith('/check')).length,1);assert.equal(f.calls.some(call=>/\/(enable|prepare|activate)$/.test(call.path)),false);
  await click(ui.element,'返回');assert.ok(ui.element.textContent?.includes('继续添加'));assert.equal(f.inventory.instances[0].observed,'checking','leaving does not undo registered work');
 }finally{await ui.close();}
});

test('a lost create response survives remount and retries exactly one original intent instead of duplicating the instance',async()=>{
 sessionStorage.clear();const f=fixture();let ui=await mount(f);
 try{await install(f,ui.element);f.lose();await configure(ui.element);assert.ok(ui.element.textContent?.includes('请求结果尚未确认'));
  const original=f.calls.find(call=>call.path==='/api/plugin-instances')!;assert.ok(readQuickAdd(scope)?.pending);await ui.close();ui=await mount(f);
  assert.equal(f.instances.size,1);await click(ui.element,'重试同一请求');const creates=f.calls.filter(call=>call.path==='/api/plugin-instances');assert.equal(creates.length,2);assert.equal(creates[1].body,original.body);assert.equal(f.instances.size,1);assert.equal(readQuickAdd(scope)?.pending,undefined);assert.equal(f.calls.some(call=>call.path.endsWith('/check')),false);
 }finally{await ui.close();}
});

test('permission refusal clears the journal and a revision conflict stops the chain without broadening the request',async()=>{
 sessionStorage.clear();const f=fixture();let ui=await mount(f);
 try{await click(ui.element,'添加 Hindsight');f.conflict();await click(ui.element,'安装此版本');assert.equal(readQuickAdd(scope)?.conflict,true);assert.equal(f.calls.some(call=>call.path==='/api/plugin-instances'),false);assert.equal(ui.element.querySelector('form'),null);await ui.close();sessionStorage.clear();const g=fixture();ui=await mount(g);await click(ui.element,'添加 Hindsight');g.deny();await click(ui.element,'安装此版本');assert.equal(readQuickAdd(scope),undefined);assert.ok(ui.element.textContent?.includes('Generated permission refusal'));}
 finally{await ui.close();}
});

test('blocked checkpoint storage sends no installation or configuration request',async()=>{
 sessionStorage.clear();const f=fixture(),ui=await mount(f),prototype=dom.window.Storage.prototype,setItem=prototype.setItem;prototype.setItem=()=>{throw Error('Generated storage denied');};
 try{await click(ui.element,'添加 Hindsight');assert.ok(ui.element.textContent?.includes('无法保存添加进度'));assert.equal(f.calls.filter(call=>call.path.endsWith('/resolve')).length,1);assert.equal(f.calls.some(call=>call.path.endsWith('/install')),false);}
 finally{prototype.setItem=setItem;await ui.close();}
});

test('a restored verified checkpoint needs the exact current server instance, configuration, revision and capability',async()=>{
 for(const change of ['unchanged','configuration','blocked','missing','disabled','package','capability'] as const){
  sessionStorage.clear();const f=fixture();f.inventory.packages=[f.pkg];const instanceId=randomUUID(),configuration={modelProfileId:'generated-model'};
  const instance:PluginInstanceView={id:instanceId,packageId:f.pkg.id,name:'Generated',scope:'default',revision:3,configurationSchema:f.pkg.configurationSchema!,configuration,secretStatus:{},capabilities:[{id:'engine',state:'verified'}],desired:false,observed:'ready',issues:[],allowedActions:['configure','check']};
  const flow:QuickAdd={...checkpoint(),preview:{...preview(),source:f.pkg.source!},stage:'verified',instanceId,viewRevision:3,instanceSnapshot:{revision:3,configuration:{...configuration}}};
  assert.equal(saveQuickAdd(flow),true);f.inventory.revision=4;f.inventory.instances=[instance];
  if(change==='configuration'){instance.configuration={modelProfileId:'different-model'};instance.revision++;}
  if(change==='blocked'){instance.observed='blocked';instance.issues=['Generated unavailable worker'];}
  if(change==='missing')f.inventory.instances=[];
  if(change==='disabled'){instance.observed='disabled';instance.revision++;}
  if(change==='package')instance.packageId='mote.hindsight@'+'c'.repeat(64);
  if(change==='capability')instance.capabilities=[{id:'engine',state:'unknown'}];
  const ui=await mount(f);
  try{assert.equal(ui.element.textContent?.includes('能力已核验。'),change==='unchanged',change);assert.equal(f.calls.length,0,'reload never pays for another check');if(change!=='unchanged'){assert.equal(readQuickAdd(scope)?.conflict,true,change);assert.ok(ui.element.textContent?.includes('配置或方案已变化'));await click(ui.element,'取消');assert.equal(readQuickAdd(scope),undefined);assert.equal(f.calls.length,0,'ending a conflicted guide never rolls back server work');}}
  finally{await ui.close();}
 }
});
