import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {DeviceOverview} from '../src/DeviceOverview';
import {configureLocale,moteText} from '@mote/shared/i18n';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Api,Device} from '../src/api';
const when='2026-10-29T00:00:00Z';
async function fixture(t:import('node:test').TestContext){const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/connections/devices',pretendToBeVisual:true}),previous=new Map<string,PropertyDescriptor|undefined>();for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}configureLocale(()=>'zh-CN');const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());for(const [key,value]of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});return {root,d:dom.window.document};}
const button=(d:Document,label:string)=>[...d.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent?.trim()===label)!;
const devices=[{deviceId:'generated-a',deviceName:'Generated device A',platform:'android',status:'paused',lastSeenAt:when,queueDepth:0},{deviceId:'generated-b',deviceName:'Generated device B',platform:'macos',status:'capturing',lastSeenAt:when,queueDepth:7}] as Device[];
const captureCases=JSON.parse(readFileSync(new URL('../../../packages/shared/test-fixtures/capture-status-cases.json',import.meta.url),'utf8')) as {name:string;facts:{connection:string;syncState:string;captureEnabled:boolean;captureLive:boolean;screenPausedAt?:string;permission?:string;storageFull?:boolean;interrupted?:boolean;pending:number;disconnected?:boolean};expected:{central:{textKey:string;tone:'ok'|'neutral'|'warn'}|null}}[];
function fixtureDevice(row:typeof captureCases[number]):Device{
 const facts=row.facts,status=!facts.captureEnabled?'paused':(facts.interrupted||facts.storageFull||facts.connection==='reconnect')?'error':facts.permission?'permission_required':'capturing';
 return {deviceId:row.name,deviceName:row.name,platform:'android',status,lastSeenAt:when,queueDepth:facts.pending??0,sync:{mode:'realtime',state:facts.syncState as NonNullable<Device['sync']>['state'],intervalMinutes:15,batchSize:20,pendingRecords:facts.pending??0},disconnected:facts.disconnected===true};
}

test('device detail reads its actual current original, keeps one device scope across paging and never invents a received total',async t=>{
 const {root,d}=await fixture(t),directory=mkdtempSync(join(tmpdir(),'mote-device-ui-')),token='generated-device-ui-token-123456789';const {buildApp}=await import('../../server/src/app.js');const node=await buildApp({dataDir:directory,token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:3_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false});t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});const headers={authorization:'Bearer '+token},ids:string[]=[];
 for(let index=0;index<27;index++){const id=randomUUID();ids.push(id);const response=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:devices[0].deviceId,deviceName:devices[0].deviceName,platform:'android',capturedAt:when,text:'Generated A original '+index}});assert.equal(response.statusCode,201,response.body);}const other=randomUUID();await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id:other,deviceId:devices[1].deviceId,deviceName:devices[1].deviceName,platform:'macos',capturedAt:when,text:'Generated B exact original'}});
 const reads:string[]=[],opened:string[]=[],api={request:async(path:string)=>{reads.push(path);const response=await node.app.inject({url:path,headers});assert.equal(response.statusCode,200,response.body);return response.json();}} as Api;const view=(owner:Api)=>React.createElement(DeviceOverview,{api:owner,devices,onOpen:(ref:string)=>opened.push(ref),onConnect:()=>{},onAdd:()=>{},onSources:()=>{},onRefresh:()=>{}});await act(async()=>root.render(view(api)));assert.deepEqual(reads,[],'the device index does not expand every archive');await act(async()=>d.querySelector<HTMLButtonElement>('.device-list button')!.click());assert.match(d.querySelector('.device-original-preview')!.textContent!,/中央已收到/);await act(async()=>button(d,'已收到').click());assert.equal(d.querySelectorAll('.device-first-record').length,24);assert.match(d.querySelector('.device-received .filter-bar')!.textContent!,/本页 24 份资料/);assert.doesNotMatch(d.querySelector('.device-received')!.textContent!,/Generated B/);await act(async()=>d.querySelector<HTMLButtonElement>('.device-first-record')!.click());assert.ok(ids.includes(opened[0].replace('capture:','')));assert.equal(new URLSearchParams(location.hash.split('?')[1]).get('deviceId'),'generated-a');
 await act(async()=>button(d,'下一页').click());assert.equal(d.querySelectorAll('.device-first-record').length,3);assert.ok(reads.filter(path=>path.startsWith('/api/capture-browser?')).every(path=>new URLSearchParams(path.split('?')[1]).get('deviceId')==='generated-a'));
 await act(async()=>button(d,'采集与设备').click());await act(async()=>d.querySelectorAll<HTMLButtonElement>('.device-list button')[1].click());await act(async()=>button(d,'已收到').click());assert.match(d.querySelector('.device-first-record')!.textContent!,/Generated B exact original/);await act(async()=>d.querySelector<HTMLButtonElement>('.device-first-record')!.click());assert.equal(opened.at(-1),'capture:'+other);
 const nextReads:string[]=[],nextApi={request:async(path:string)=>{nextReads.push(path);return {items:[],nextCursor:null};}} as Api;await act(async()=>root.render(view(nextApi)));assert.equal(location.hash,'#/connections/devices');assert.deepEqual(nextReads,[]);assert.equal(d.querySelector('.device-original-preview'),null,'a new owner never inherits an old selected device');assert.equal(d.querySelector('.device-first-record'),null,'a new owner never inherits an old readable receipt');
});

test('device status display uses the shared capture status data for every Central column',async t=>{
 const {root,d}=await fixture(t),api={request:async()=>{throw Error('The device index must not read archives');}} as Api,view=React.createElement(DeviceOverview,{api,devices:captureCases.map(fixtureDevice),onOpen:()=>{},onConnect:()=>{},onAdd:()=>{},onSources:()=>{},onRefresh:()=>{}});
 await act(async()=>root.render(view));
 assert.equal(d.querySelector('.device-list .badge.green'),null,'a normal device never shows a green dot');
 for(const row of captureCases){
  const device=d.querySelector<HTMLButtonElement>(`.device-list button[data-device-id="${row.name}"]`)??[...d.querySelectorAll<HTMLButtonElement>('.device-list>button')].find(item=>item.textContent?.includes(row.name))!,badge=device.querySelector('.device-state');
  if(!row.expected.central)assert.equal(badge,null,row.name);
  else{
   assert.equal(badge?.textContent,moteText(row.expected.central.textKey),row.name);
   assert.equal(badge?.classList.contains('warn'),row.expected.central.tone==='warn',row.name);
   assert.equal(Boolean(badge?.querySelector('.dot')),row.expected.central.tone==='warn',`${row.name}: only attention states show a dot`);
  }
 }
});
