import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import type {ServerConfiguration} from '@mote/shared';
import type {Status} from '../src/api.js';
import type {Api} from '../src/api.js';
import {SettingsDirectory} from '../src/features/system.js';
import {DiagnosticsBackground} from '../src/features/diagnostics.js';
import {Notifications,notificationSettings} from '../src/features/notifications.js';
import {ModelSettingsEditor} from '../src/plugins/models-processing/ModelSettingsEditor.js';
import {AssistantNotifications} from '../../server/src/assistant-notifications.js';
import {modelView} from './fixtures/model-settings.js';

configureLocale(()=> 'zh-CN');
async function fixture(t:import('node:test').TestContext,hash='#/preferences'){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/'+hash,pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,location:dom.window.location,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 return {root,d:dom.window.document,w:dom.window};
}
const button=(d:Document,label:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(value=>value.textContent?.includes(label))!;
const configuration=(notifications:{enabled:boolean;timeZone:string;quietHours:{start:string;end:string}|null},revision=4):ServerConfiguration=>({
 version:1,revision,configFile:'/generated/mote.yaml',lastError:null,
 domains:[{id:'notifications',saved:notifications,effective:notifications,fields:[],status:'applied'}],
 profile:'fixture',runtime:'native',hostConfigFile:null,ownerCredential:{configured:true,source:'programmatic'},baseDir:'/generated',readOnly:false,restartRequired:false,description:'',
 storage:{dataDir:'/generated/data',sqlitePath:'/generated/data/mote.sqlite',assetDir:'/generated/assets',logDir:'/generated/logs',kind:'local-directory',source:null,mountPath:null,description:''},
});
const status={profile:'fixture',agent:{configured:true,model:'generated-model',provider:'generated'},storage:{captures:3,blobs:0,bytes:41200000000,imageBytes:0,logicalBytes:0,imagesEncrypted:false,indexing:[{status:'text_ready',count:3}]},index:{mode:'text',model:null},insightIntervalHours:0,serverTime:'2026-11-21T09:00:00+08:00'} as Status;

test('ST1-01 the settings landing groups destinations without sending a model probe',async t=>{
 const {root,d,w}=await fixture(t),reads:string[]=[],destinations:string[]=[];
 const api={request:async(path:string)=>{reads.push(path);if(path==='/api/configuration')return configuration({enabled:true,timeZone:'Asia/Shanghai',quietHours:{start:'22:00',end:'08:00'}});if(path==='/api/model-authorization')return {authorization:{revision:2,state:'on',excludedSourceIds:[]}};return {};}} as Api;
 await act(async()=>root.render(React.createElement(SettingsDirectory,{api,status,onPage:page=>destinations.push(page)} as never)));
 assert.equal(reads.some(path=>path.endsWith('/models')||path.endsWith('/test')),false,'the landing must not probe model providers');
 const labels=Array.from(d.querySelectorAll('.processing-entry-row strong')).map(value=>value.textContent);
 assert.deepEqual(labels,['模型','后台处理','外观','语言','通知','存储','用量与费用','诊断','关于与更新']);
 assert.match(d.body.textContent!,/22:00–08:00 安静/);
 assert.match(d.body.textContent!,/38\.37 GB/);
 await act(async()=>button(d,'通知').click());assert.deepEqual(destinations,['notifications']);
 await act(async()=>button(d,'诊断').click());assert.deepEqual(destinations,['notifications','developer']);
 await act(async()=>button(d,'后台处理').click());assert.equal(w.location.hash,'#/system/models?category=processing');
});

test('ST1-02 opening the model subpage probes with loading, a bounded failure and retry',async t=>{
 const {root,d}=await fixture(t,'#/system/models'),probes:{signal:AbortSignal|undefined}[]=[];let rejectFirst!:(error:unknown)=>void,resolveRetry!:(value:unknown)=>void;
 const first=new Promise((_,reject)=>{rejectFirst=reject;}),retry=new Promise(resolve=>{resolveRetry=resolve;});
 const api={request:async(path:string,init?:RequestInit)=>{if(path==='/api/model-settings')return modelView();if(path==='/api/model-settings/models'){probes.push({signal:init?.signal as AbortSignal});return probes.length===1?first:retry;}return {};}} as Api;
 await act(async()=>root.render(React.createElement(ModelSettingsEditor,{api,revision:1,onApplied:()=>{}})));
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,650));});
 assert.equal(probes.length,1,'the probe starts only after the model subpage opens');
 const probeButton=()=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(value=>value.textContent?.includes('读取模型列表'))!;
 assert.equal(probeButton().getAttribute('aria-busy'),'true');
 assert.equal(probeButton().disabled,true);
 assert.ok(probes[0].signal,'the probe carries an abortable signal');
 await act(async()=>{rejectFirst(new DOMException('generated timeout','TimeoutError'));await new Promise(resolve=>setTimeout(resolve,0));});
 assert.match(d.querySelector('[role=status]')!.textContent!,/请求等待超时/);
 assert.equal(probeButton().disabled,false);
 await act(async()=>probeButton().click());
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,650));});
 assert.equal(probes.length,2,'retry sends the probe again');
 assert.equal(probeButton().getAttribute('aria-busy'),'true');
 await act(async()=>{resolveRetry({items:[{id:'generated-model',name:'Generated catalog model'}]});await new Promise(resolve=>setTimeout(resolve,0));});
 assert.equal(d.querySelector('datalist option')!.getAttribute('value'),'generated-model');
});

test('ST1-03 diagnostics show background activity and processing status',async t=>{
 const {root,d,w}=await fixture(t,'#/system/diagnostics'),destinations:string[]=[];
 const work=(id:string,goal:string,state:'running'|'needs_input')=>({id,kind:'memory',goal,state,createdAt:'2026-11-21T01:00:00Z',updatedAt:'2026-11-21T01:01:00Z',progress:{mode:'determinate' as const,unit:'records' as const,total:2,completed:1,failed:0,needsInput:0,excluded:0},branches:[],artifacts:[],evidence:{count:0,refs:[]},events:[],destination:'memories',technical:{operationIds:[]}});
 const operation={id:'memory:generated',kind:'memory',state:'running' as const,total:2,notScheduled:0,counts:{waiting:0,running:1,blocked:0,succeeded:1,failed:0,cancelled:0,stale:0},createdAt:1,updatedAt:2};
 const api={request:async(path:string)=>{if(path.startsWith('/api/work-activity?')){if(path.includes('state=attention'))return {items:[work('memory:attention','整理合成日记','needs_input')],nextCursor:null};return {items:[work('memory:active','生成合成回顾','running')],nextCursor:null};}if(path.startsWith('/api/operations?')){return path.includes('state=running')?{items:[operation],nextCursor:null,changeCursor:1}:{items:[],nextCursor:null,changeCursor:1};}return {};}} as Api;
 await act(async()=>root.render(React.createElement(DiagnosticsBackground,{api,onPage:page=>destinations.push(page)})));
 assert.match(d.body.textContent!,/后台活动/);assert.match(d.body.textContent!,/整理合成日记/);assert.match(d.body.textContent!,/生成合成回顾/);
 assert.match(d.body.textContent!,/处理状态/);assert.match(d.body.textContent!,/记忆整理/);
 await act(async()=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(value=>value.textContent?.includes('整理合成日记'))!.click());
 assert.equal(w.location.hash,'#/activity?work=memory%3Aattention');
 await act(async()=>button(d,'全部活动').click());assert.deepEqual(destinations,['activity']);
 await act(async()=>button(d,'处理任务').click());assert.deepEqual(destinations,['activity','processing']);
});

test('ST1-05 ST1-06 the notification subpage writes the existing configuration and quiet hours gate assistant cards',async t=>{
 const writes:{revision:number;value:{enabled?:boolean;timeZone?:string;quietHours?:{start:string;end:string}|null}}[]=[];
 let current=configuration({enabled:true,timeZone:'Asia/Shanghai',quietHours:null});
 const api={request:async(path:string,init?:RequestInit)=>{if(path==='/api/configuration'&&!init?.method)return current;if(path==='/api/configuration/notifications'&&init?.method==='PUT'){const body=JSON.parse(String(init.body));writes.push(body);const saved={...current.domains[0].saved as object,...body.value};current={...current,revision:current.revision+1,domains:[{...current.domains[0],saved,effective:saved}]};return current;}return {};}} as Api;
 const settings={enabled:true,timeZone:'Asia/Shanghai',quietHours:{start:'22:00',end:'08:00'},minIntervalMinutes:60};
 assert.deepEqual(notificationSettings(configuration(settings)).quietHours,{start:'22:00',end:'08:00'});
 const card={id:'generated-card',revision:'generated-revision',title:'Generated card',reason:'Generated reason',origin:'2026-11-20T15:00:00Z',currentVersionAt:'2026-11-20T15:00:00Z',state:'open',readAt:null,feedback:[]};
 const notifications=(candidate:unknown,now:string)=>new AssistantNotifications({notificationCandidates:()=>[candidate]} as never,()=>settings as never,()=>Date.parse(now)).snapshot({});
 assert.deepEqual(notifications(card,'2026-11-20T15:30:00Z').items,[],'a card raised at 23:00 stays quiet until 08:00');
 assert.equal(notifications(card,'2026-11-21T00:00:00Z').items.length,1,'the same card appears when quiet hours end');

 const {root,d}=await fixture(t,'#/preferences/notifications');
 await act(async()=>root.render(React.createElement(Notifications,{api,onPage:()=>{}})));
 await act(async()=>d.querySelector<HTMLInputElement>('input[aria-label="安静时段"]')!.click());
 assert.equal(d.querySelector<HTMLInputElement>('input[aria-label="开始时间"]')!.value,'22:00');
 assert.equal(d.querySelector<HTMLInputElement>('input[aria-label="结束时间"]')!.value,'08:00');
 await act(async()=>button(d,'保存').click());
 assert.deepEqual(writes[0].value.quietHours,{start:'22:00',end:'08:00'});
 assert.match(d.body.textContent!,/已保存/);

 await act(async()=>d.querySelector<HTMLInputElement>('input[aria-label="助理通知"]')!.click());
 await act(async()=>button(d,'保存').click());
 assert.equal(writes.at(-1)!.value.enabled,false);
 const disabled={...settings,enabled:false};
 assert.deepEqual(new AssistantNotifications({notificationCandidates:()=>[card]} as never,()=>disabled as never,()=>Date.parse('2026-11-21T00:00:00Z')).snapshot({}).items,[],'disabling notifications empties the assistant snapshot');
});
