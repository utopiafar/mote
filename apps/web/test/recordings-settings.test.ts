import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import type {RecordingStatus} from '@mote/shared';
import type {Api} from '../src/api.js';
configureLocale(()=> 'zh-CN');
const dom=new JSDOM('<html><body></body></html>',{url:'http://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
const {createRoot}=await import('react-dom/client');
const {RecordingConnection,RecordingsSettings}=await import('../src/RecordingsSettings.js');
const tick=()=>new Promise(r=>setTimeout(r,20));
const button=(name:string)=>{const found=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===name);assert.ok(found);return found;};
test('recording journey connects an existing account, explicitly enables import, preserves draft range and offers failure retry',async t=>{
 const calls:{path:string;init?:RequestInit}[]=[],status:RecordingStatus={provider:'feishu',connected:false,selection:{enabled:false,start:'2026-09-01T00:00:00Z',autoSync:true,backupAudio:true},steps:[],counts:{transcripts:0,audio:0,pending:0,failed:0}};
 const api={request:async(path:string,init?:RequestInit)=>{calls.push({path,init});if(path.endsWith('/items'))return {items:[]};if(path.endsWith('/connect'))status.connected=true;if(path.endsWith('/selection')){status.selection=JSON.parse(String(init?.body));status.counts.failed=1;}return structuredClone(status);}} as unknown as Api;
 const element=document.createElement('div');document.body.appendChild(element);const root=createRoot(element);t.after(async()=>{await act(async()=>root.unmount());element.remove();});
 await act(async()=>{root.render(React.createElement(RecordingConnection,{api,provider:'feishu',onOpen:()=>{}}));await tick();});
 assert.equal(calls.filter(c=>c.init?.method==='POST').length,0,'mounting never starts collection');assert.ok(element.textContent?.includes('首次授权帮助'));
 await act(async()=>{button('连接已授权账号').click();await tick();});const enabled=[...document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(e=>e.parentElement?.textContent?.includes('启用录音同步'))!;
 await act(async()=>{enabled.click();await tick();});assert.equal(button('立即同步').disabled,true,'unsaved edits must not sync');
 await act(async()=>{button('保存并开始同步').click();await tick();});const body=JSON.parse(String(calls.find(c=>c.path.endsWith('/selection'))?.init?.body));assert.equal(body.enabled,true);assert.equal(body.backupAudio,true);assert.equal(body.start,'2026-09-01T00:00:00Z');assert.equal(button('立即同步').disabled,false);
 await act(async()=>{button('重试失败步骤').click();await tick();});assert.ok(calls.some(c=>c.path.endsWith('/retry')));
});

test('the recording page discovers third-party providers from the connector registry without a core provider list',async t=>{
 const status:RecordingStatus={category:'recordings',label:'Generated recorder plugin',provider:'generated',connected:false,setup:{description:'Generated authorization instructions',command:'generated login'},selection:{enabled:false,start:'2026-09-01T00:00:00Z',autoSync:true,backupAudio:true},steps:[],counts:{transcripts:0,audio:0,pending:0,failed:0}};
 const calls:string[]=[],api={request:async(path:string)=>{calls.push(path);return path==='/api/connectors/status'?{'generated-recordings':status,unrelated:null}:structuredClone(status);}} as unknown as Api;
 const element=document.createElement('div');document.body.appendChild(element);const root=createRoot(element);t.after(async()=>{await act(async()=>root.unmount());element.remove();});
 await act(async()=>{root.render(React.createElement(RecordingsSettings,{api,onBack:()=>{},onSources:()=>{},onOpen:()=>{}}));await tick();});
 await act(async()=>{await tick();});assert.ok(element.textContent?.includes(status.label!));assert.ok(element.textContent?.includes(status.setup!.description!));assert.ok(calls.includes('/api/connectors/generated-recordings'));assert.ok(!calls.includes('/api/connectors/feishu-recordings'));
});
