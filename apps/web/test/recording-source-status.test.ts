import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale,getLocale} from '@mote/shared/i18n';
import type {RecordingStatus} from '@mote/shared';
import type {Api} from '../src/api.js';
import {Sources} from '../src/Sources.js';
import {RecordingsSettings} from '../src/RecordingsSettings.js';
import {resources} from '../src/resource-cache.js';

async function fixture(t:import('node:test').TestContext,hash='#/connections?sourceId=generated-recordings'){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'+hash,pretendToBeVisual:true});
 const previous=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){
  previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 }
 const previousLocale=getLocale();configureLocale(()=> 'zh-CN');
 const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}configureLocale(()=>previousLocale);dom.window.close();});
 return {dom,root};
}

const generatedStatus=():RecordingStatus=>({category:'recordings',provider:'generated',connected:true,sourceId:'generated-recordings',selection:{enabled:false,start:'2026-09-01T00:00:00Z',autoSync:false,backupAudio:true},steps:[],counts:{transcripts:0,audio:0,pending:0,failed:0}});

test('restoring recording source intake shows disabled sync and leads to its explicit scope settings without enabling collection',async t=>{
 const {dom,root}=await fixture(t);
 const status=generatedStatus();
 const source={id:status.sourceId,name:'Generated recorder',kind:'generated.recordings',enabled:false,status:{state:'idle'}};
 const writes:{path:string;body:unknown}[]=[],api={request:async(path:string,init?:RequestInit)=>{
  if(init?.method){writes.push({path,body:JSON.parse(String(init.body))});assert.equal(path,'/api/sources/'+source.id);source.enabled=true;return source;}
  if(path==='/api/sources')return {items:[structuredClone(source)]};
  if(path==='/api/connectors/status')return {'generated-recordings':structuredClone(status)};
  if(path.endsWith('/context'))return {sourceId:source.id,version:0,description:''};
  if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};
  throw Error('Unexpected generated request: '+path);
 }} as unknown as Api;
 await act(async()=>root.render(React.createElement(Sources,{api,onOpen:()=>{},onImport:()=>{}})));
 assert.equal(dom.window.document.querySelector('.source-configuration p[role=status]')?.textContent,'来源接入已暂停');
 const button=Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='恢复接入');assert.ok(button);
 await act(async()=>button.click());
 assert.match(dom.window.document.querySelector('aside')!.textContent!,/录音同步未启用/);
 assert.doesNotMatch(dom.window.document.querySelector('aside')!.textContent!,/等待下次同步|已启用/);
 const link=dom.window.document.querySelector<HTMLAnchorElement>('.source-configuration a[href="#/connections/recordings?provider=generated"]');assert.ok(link);
 assert.equal(link.textContent,'录音同步设置');
 assert.match(dom.window.document.querySelector('.source-configuration')!.textContent!,/恢复接入仅允许接收资料；录音同步需在录音同步设置中确认范围并启用/);
 assert.deepEqual(writes,[{path:'/api/sources/'+source.id,body:{enabled:true}}]);
 assert.equal(status.selection.enabled,false);assert.equal(status.selection.autoSync,false);
});

for(const [name,change,expected] of [
 ['automatic sync', (status:RecordingStatus)=>{status.selection.enabled=true;status.selection.autoSync=true;},'自动同步已启用'],
 ['manual sync', (status:RecordingStatus)=>{status.selection.enabled=true;},'仅手动同步'],
 ['missing runtime', (status:RecordingStatus)=>{status.authorization={revision:'generated',environment:{installed:false,configured:false,error:'generated_cli_missing'}};},'录音同步未启用 · 运行环境需要处理'],
 ['pending steps', (status:RecordingStatus)=>{status.selection.enabled=true;status.counts.pending=1;},'有同步步骤待处理'],
 ['running step', (status:RecordingStatus)=>{status.selection.enabled=true;status.steps=[{id:'generated-step',phase:'discover',state:'running',attempts:1}];},'同步中'],
 ['sync failure', (status:RecordingStatus)=>{status.selection.enabled=true;status.error='generated_failure';},'仅手动同步 · 同步需要处理'],
 ['different account', (status:RecordingStatus)=>{status.selection.enabled=true;status.selection.autoSync=true;status.sourceId='generated-new-account';},'此来源未绑定当前录音账号'],
] as const)test('source management reflects '+name+' and refreshes without provider actions',async t=>{
 const {dom,root}=await fixture(t),status=generatedStatus();change(status);
 let unavailable=false;
 const paths:string[]=[],api={request:async(path:string,init?:RequestInit)=>{
  assert.equal(init?.method,undefined,'viewing or refreshing state must not check credentials, connect or sync');paths.push(path);
  if(path==='/api/sources')return {items:[{id:'generated-recordings',name:'Generated recorder',kind:'generated.recordings',enabled:true,status:{state:'idle'}}]};
  if(path==='/api/connectors/status')return unavailable?{}:{'generated-recordings':structuredClone(status)};
  if(path.endsWith('/context'))return {sourceId:'generated-recordings',version:0,description:''};
  if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};
  throw Error('Unexpected generated request: '+path);
 }} as unknown as Api;
 await act(async()=>root.render(React.createElement(Sources,{api,onOpen:()=>{},onImport:()=>{}})));
 assert.equal(dom.window.document.querySelector('.source-configuration p[role=status]')?.textContent,expected);
 assert.ok(dom.window.document.querySelector('aside')!.textContent!.includes(expected));
 unavailable=true;await act(async()=>resources(api).invalidate(path=>path==='/api/connectors/status'));
 assert.equal(dom.window.document.querySelector('.source-configuration p[role=status]')?.textContent,'录音同步状态暂不可用');
 assert.ok(!paths.some(path=>/\/(check|login|sync|connect)$/.test(path)));
});

for(const locale of ['zh-CN','en'] as const)test('recording directory and detail distinguish saved binding, disabled sync and runtime failure in '+locale,async t=>{
 const {dom,root}=await fixture(t,'#/connections/recordings');configureLocale(()=>locale);
 const status=generatedStatus();status.authorization={revision:'generated',environment:{installed:false,configured:false,error:'generated_cli_missing'}};
 const reads:string[]=[],api={request:async(path:string,init?:RequestInit)=>{
  assert.equal(init?.method,undefined,'opening the recording directory/detail never checks or changes provider authorization');reads.push(path);
  if(path==='/api/connectors/status')return {'generated-recordings':structuredClone(status)};
  if(path==='/api/connectors/generated-recordings')return structuredClone(status);
  if(path.endsWith('/items?includeExports=true'))return {items:[]};
  if(path.endsWith('/context'))return {sourceId:status.sourceId,version:0,description:''};
  throw Error('Unexpected generated request: '+path);
 }} as unknown as Api;
 await act(async()=>root.render(React.createElement(RecordingsSettings,{api,onSources:()=>{},onOpen:()=>{}})));
 const binding=locale==='en'?'Account binding saved':'已保存账号绑定',sync=locale==='en'?'Recording sync is not enabled · Runtime needs attention':'录音同步未启用 · 运行环境需要处理';
 assert.ok(dom.window.document.querySelector('.discovery-source-card')!.textContent!.includes(binding));
 assert.equal(dom.window.document.querySelector('.recording-sync-status')?.textContent,sync);
 const link=dom.window.document.querySelector<HTMLAnchorElement>('a[href="#/connections/recordings?provider=generated"]');assert.ok(link);
 await act(async()=>{dom.window.location.hash=link.getAttribute('href')!;dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));});
 assert.equal(dom.window.document.querySelector('.section-heading .badge')?.textContent,binding);
 assert.equal(dom.window.document.querySelector('.section-heading .badge.green'),null);
 assert.equal(dom.window.document.querySelector('.recording-sync-status')?.textContent,sync);
 assert.ok(dom.window.document.body.textContent!.includes(locale==='en'?'does not confirm a valid login or read permissions':'不代表当前登录或读取权限有效'));
 assert.equal(dom.window.document.querySelector<HTMLInputElement>('input[type=checkbox]')?.checked,false);
 assert.ok(reads.includes('/api/connectors/generated-recordings'));
});
