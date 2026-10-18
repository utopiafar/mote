import test from 'node:test';
import assert from 'node:assert/strict';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {ConfigurationBuilder} from '../src/ConfigurationBuilder.js';
import {RuntimeSettings} from '../src/RuntimeSettings.js';
import {MemorySettings} from '../src/MemorySettings.js';
import {ContentStorage} from '../src/ContentStorage.js';
import {PerceptionSettings} from '../src/PerceptionSettings.js';
import {Actions} from '../src/Actions.js';
import {ApiError, type Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';
import {configureLocale} from '@mote/shared/i18n';
import type {ServerConfiguration} from '@mote/shared';
configureLocale(()=> 'zh-CN');

async function fixture(t:any){
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/'}),before=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){
    before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  const root=createRoot(dom.window.document.getElementById('root')!);
  t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
  return {root,d:dom.window.document};
}
function configuration(revision:number,savedDays=30):ServerConfiguration {
  return {version:1,revision,configFile:'/generated/mote.yaml',profile:'test',runtime:'native',envFile:'/generated/mote.yaml',baseDir:'/generated',readOnly:false,restartRequired:savedDays!==0,description:'Generated fixture',storage:{dataDir:'/generated',sqlitePath:'/generated/mote.sqlite',assetDir:'/generated/files',logDir:'/generated/logs',kind:'local-directory',source:'/generated',mountPath:null,description:'Generated'},groups:[{id:'storage',title:'Storage',description:'Generated',fields:[
    {key:'retentionDays',label:'Retention',description:'Generated',value:0,savedValue:savedDays,domain:'storage',path:'retentionDays',source:'config-file',effect:'restart',restartRequired:true},
    {key:'maxStorageBytes',label:'Capacity',description:'Generated',value:1048576,savedValue:1048576,unit:'bytes',domain:'storage',path:'maxStorageBytes',source:'config-file',effect:'restart',restartRequired:true},
  ]}]};
}
const button=(d:Document,label:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(item=>item.textContent===label)!;

test('configuration page saves an edited field into the shared file with its original revision',async t=>{
  const {root,d}=await fixture(t),writes:any[]=[];
  const api={request:async(path:string,init?:RequestInit)=>{writes.push({path,body:JSON.parse(String(init?.body))});return configuration(8,90);}} as Api;
  await act(async()=>root.render(React.createElement(ConfigurationBuilder,{api,config:configuration(7),category:'storage'})));
  const retention=d.querySelector<HTMLSelectElement>('select[aria-label="历史记录保留"]')!;
  assert.equal(retention.value,'30','pending-restart saved value is the editing baseline');
  await act(async()=>{retention.value='90';retention.dispatchEvent(new window.Event('change',{bubbles:true}));});
  await act(async()=>button(d,'保存并应用').click());
  assert.deepEqual(writes,[{path:'/api/configuration/storage',body:{revision:7,value:{retentionDays:90}}}]);
  assert.match(d.body.textContent!,/已保存到配置文件/);assert.doesNotMatch(d.body.textContent!,/下载配置变更|预览环境变量/);
});

test('an external file revision does not silently rebase the owner draft or overwrite it',async t=>{
  const {root,d}=await fixture(t),writes:any[]=[];
  const api={request:async(_path:string,init?:RequestInit)=>{writes.push(JSON.parse(String(init?.body)));throw new ApiError('generated conflict',409,undefined,'config_conflict');}} as Api;
  const render=(config:ServerConfiguration)=>React.createElement(ConfigurationBuilder,{api,config,category:'storage'});
  await act(async()=>root.render(render(configuration(7))));
  const retention=d.querySelector<HTMLSelectElement>('select[aria-label="历史记录保留"]')!;
  await act(async()=>{retention.value='90';retention.dispatchEvent(new window.Event('change',{bubbles:true}));});
  await act(async()=>root.render(render(configuration(8,180))));
  assert.equal(retention.value,'90');await act(async()=>button(d,'保存并应用').click());
  assert.equal(writes[0].revision,7);assert.match(d.body.textContent!,/配置或相关操作状态已变化/);assert.equal(retention.value,'90');
  await act(async()=>button(d,'重新读取并还原草稿').click());assert.equal(retention.value,'180');
});

test('configuration editors preserve an authorization refusal instead of claiming another editor changed the draft',async t=>{
  const {root,d}=await fixture(t);
  const api={request:async()=>{throw new ApiError('generated session replaced',409,undefined,'session_changed');}} as Api;
  await act(async()=>root.render(React.createElement(ConfigurationBuilder,{api,config:configuration(7),category:'storage'})));
  const retention=d.querySelector<HTMLSelectElement>('select[aria-label="历史记录保留"]')!;
  await act(async()=>{retention.value='90';retention.dispatchEvent(new window.Event('change',{bubbles:true}));});
  await act(async()=>button(d,'保存并应用').click());
  assert.match(d.body.textContent!,/登录会话已改变/);assert.doesNotMatch(d.body.textContent!,/其他会话更新|配置或相关操作状态已变化/);assert.equal(retention.value,'90');
});

test('a delayed configuration save from the previous node cannot replace the new node editor',async t=>{
  const {root,d}=await fixture(t);let resolve!:(value:ServerConfiguration)=>void,applied=0;
  const pending=new Promise<ServerConfiguration>(done=>{resolve=done;}),oldApi={request:async()=>pending} as Api,newApi={request:async()=>configuration(1,180)} as Api;
  await act(async()=>root.render(React.createElement(ConfigurationBuilder,{api:oldApi,config:configuration(7),category:'storage',onApplied:()=>{applied++;}})));
  const retention=d.querySelector<HTMLSelectElement>('select[aria-label="历史记录保留"]')!;
  await act(async()=>{retention.value='90';retention.dispatchEvent(new window.Event('change',{bubbles:true}));});
  await act(async()=>button(d,'保存并应用').click());
  await act(async()=>root.render(React.createElement(ConfigurationBuilder,{api:newApi,config:configuration(1,180),category:'storage',onApplied:()=>{applied++;}})));
  await act(async()=>resolve(configuration(8,90)));
  assert.equal(retention.value,'180');assert.equal(applied,0);assert.doesNotMatch(d.body.textContent!,/已保存到配置文件/);
});

test('diagnostics settings retain the original revision on refresh and allow reloading after conflict',async t=>{
  const {root,d}=await fixture(t),writes:any[]=[];let revision=3;
  const api={request:async(_path:string,init?:RequestInit)=>{if(init?.method==='PUT'){writes.push(JSON.parse(String(init.body)));throw new ApiError('generated conflict',409,undefined,'config_conflict');}return {revision,enabled:true,debug:false,traceEnabled:false,level:'info'};}} as Api;
  await act(async()=>root.render(React.createElement(RuntimeSettings,{api,kind:'diagnostics'})));
  await act(async()=>d.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  revision=4;await act(async()=>resources(api).invalidate(path=>path==='/api/diagnostics-settings'));
  await act(async()=>button(d,'保存并应用').click());
  assert.deepEqual(writes[0],{revision:3,enabled:false,debug:false,traceEnabled:false,level:'info'});
  assert.match(d.body.textContent!,/配置或相关操作状态已变化/);
  await act(async()=>button(d,'重新读取并还原草稿').click());assert.equal(d.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,true);
});

test('memory timing settings save their draft with the configuration revision and preserve it on conflict',async t=>{
  const {root,d}=await fixture(t),writes:any[]=[];let revision=3;
  const policy={enabled:true,intervalHours:6,maxWaitHours:6,minChanges:1,maxItems:10},settings={drainWindows:5,extraction:policy,consolidation:policy,insights:policy,working:policy,batchCharacters:500,recentTurns:2,contextCharacters:4000,summaryCharacters:1000};
  const api={request:async(path:string,init?:RequestInit)=>{
    if(path!=='/api/memory-settings')return {items:[]};
    if(init?.method==='PUT'){writes.push(JSON.parse(String(init.body)));throw new ApiError('generated conflict',409,undefined,'config_conflict');}
    return {revision,settings,extensions:[]};
  }} as Api;
  await act(async()=>root.render(React.createElement(MemorySettings,{api})));
  await act(async()=>d.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  revision=4;await act(async()=>resources(api).invalidate(path=>path==='/api/memory-settings'));
  await act(async()=>button(d,'保存记忆设置').click());
  assert.equal(writes[0].revision,3);assert.equal(writes[0].settings.consolidation.enabled,false);assert.equal(writes[0].settings.extraction.enabled,true);
  assert.match(d.body.textContent!,/配置或相关操作状态已变化/);assert.equal(d.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,false);
  await act(async()=>button(d,'重新读取并还原草稿').click());assert.equal(d.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,true);
});

test('content encryption toggle saves with the file revision while decryption remains an explicit command',async t=>{
  const {root,d}=await fixture(t),writes:any[]=[];
  const api={request:async(path:string,init?:RequestInit)=>{if(init?.method){writes.push({path,body:JSON.parse(String(init.body))});}return {revision:6,enabled:false,job:{state:'idle',total:0,processed:0,converted:0,skipped:0,failed:0}};}} as Api;
  await act(async()=>root.render(React.createElement(ContentStorage,{api})));
  await act(async()=>d.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  assert.deepEqual(writes,[{path:'/api/content-storage',body:{revision:6,enabled:true}}]);
  await act(async()=>button(d,'一次性批量解密').click());
  assert.deepEqual(writes[1],{path:'/api/content-storage/decrypt',body:{}});
});

test('saving one clean configuration editor reloads the shared revision in another editor',async t=>{
  const {root,d}=await fixture(t),writes:any[]=[];let revision=2,enabled=true,encrypted=false;
  const api={request:async(path:string,init?:RequestInit)=>{
    if(init?.method==='PUT'){const body=JSON.parse(String(init.body));writes.push({path,body});assert.equal(body.revision,revision);revision++;if(path==='/api/diagnostics-settings')enabled=body.enabled;else encrypted=body.enabled;}
    return path==='/api/diagnostics-settings'?{revision,enabled,debug:false,traceEnabled:false,level:'info'}:{revision,enabled:encrypted,job:{state:'idle',total:0,processed:0,converted:0,skipped:0,failed:0}};
  }} as Api;
  await act(async()=>root.render(React.createElement(React.Fragment,null,React.createElement(RuntimeSettings,{api,kind:'diagnostics'}),React.createElement(ContentStorage,{api}))));
  await act(async()=>d.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());await act(async()=>button(d,'保存并应用').click());
  await act(async()=>d.querySelector<HTMLInputElement>('.check-field input')!.click());
  assert.equal(writes[0].body.revision,2);assert.equal(writes[1].body.revision,3);assert.equal(writes[1].path,'/api/content-storage');
});

test('image settings submit the shared revision and retain their original draft revision after an external update',async t=>{
  const {root,d}=await fixture(t),writes:any[]=[];let revision=7;
  const settings={providerRevision:'1',enabled:true,ocrProcessorId:'image.http',ocrEndpoint:'',allowExternalProcessing:false,allowQueryImages:false,understandingEnabled:true};
  const api={request:async(path:string,init?:RequestInit)=>{
    if(path==='/api/file-processing')return {policy:{profiles:[]},processors:[]};if(path==='/api/media-models')return {ocr:{state:'missing'}};if(path==='/api/sources')return {items:[]};
    if(init?.method==='PUT'){writes.push(JSON.parse(String(init.body)));throw new ApiError('generated conflict',409,undefined,'config_conflict');}
    return {revision,settings,model:null,recent:[],jobs:[],backfills:[]};
  }} as Api;
  await act(async()=>root.render(React.createElement(PerceptionSettings,{api})));
  await act(async()=>d.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  revision=8;await act(async()=>resources(api).invalidate(path=>path==='/api/perception'));
  await act(async()=>button(d,'保存图片设置').click());
  assert.equal(writes[0].revision,7);assert.equal(writes[0].settings.enabled,false);assert.match(d.body.textContent!,/配置或相关操作状态已变化/);
});

const actionView=(revision:number,authorizationRevision:number,enabled=false,reviewDeviceIds:string[]=['generated-phone'])=>({revision,authorizationRevision,items:[],total:0,nextCursor:null,targets:[],settings:{enabled,timeZone:'UTC',reviewDeviceIds},progress:{configured:true,running:false,jobs:[],error:null}});
function actionApi(read:(path:string,init?:RequestInit)=>unknown):Api {
  return {request:async(path:string,init?:RequestInit)=>{
    if(path.startsWith('/api/operations/changes'))return new Promise(()=>{});
    if(path==='/api/devices')return {items:[{deviceId:'generated-phone',deviceName:'Generated phone'}]};
    if(path.startsWith('/api/todos?'))return {items:[],nextCursor:null};
    return read(path,init);
  }} as Api;
}
test('Actions settings read and submit both configuration and device-authorization revisions',async t=>{
  const {root,d}=await fixture(t),writes:any[]=[];let revision=3,authorizationRevision=2,enabled=false;
  const api=actionApi((_path,init)=>{if(init?.method==='PUT'){const body=JSON.parse(String(init.body));writes.push(body);enabled=body.settings.enabled;revision++;}return actionView(revision,authorizationRevision,enabled);});
  await act(async()=>root.render(React.createElement(Actions,{api,onOpen:()=>{}})));
  revision=4;authorizationRevision=3;await act(async()=>resources(api).invalidate(path=>path.startsWith('/api/actions?')));
  await act(async()=>d.querySelector<HTMLInputElement>('.action-settings input[type="checkbox"]')!.click());
  assert.deepEqual(writes,[{revision:4,authorizationRevision:3,settings:{enabled:true,timeZone:'UTC',reviewDeviceIds:['generated-phone']}}]);
});
test('Actions displays actual permission withdrawal after a failed runtime save and reloads both revisions',async t=>{
  const {root,d}=await fixture(t),writes:any[]=[];let authorizationRevision=2,reviewDeviceIds=['generated-phone'];
  const api=actionApi((_path,init)=>{if(init?.method==='PUT'){writes.push(JSON.parse(String(init.body)));reviewDeviceIds=[];authorizationRevision++;throw new ApiError('Generated runtime save failed',503,undefined,'config_unavailable');}return actionView(3,authorizationRevision,false,reviewDeviceIds);});
  await act(async()=>root.render(React.createElement(Actions,{api,onOpen:()=>{}})));
  const phone=()=>d.querySelectorAll<HTMLInputElement>('.action-settings input[type="checkbox"]')[1];
  assert.equal(phone().checked,true);await act(async()=>phone().click());
  assert.equal(writes[0].authorizationRevision,2);assert.deepEqual(writes[0].settings.reviewDeviceIds,[]);
  assert.equal(phone().checked,false);assert.match(d.body.textContent!,/所选设备授权已撤销/);assert.match(d.body.textContent!,/所需服务暂不可用/);
  await act(async()=>button(d,'重新读取并还原草稿').click());
  assert.equal(phone().checked,false);assert.doesNotMatch(d.body.textContent!,/所选设备授权已撤销/);
});

test('Actions timezone edits keep their original dual revisions across refresh and preserve the draft on conflict',async t=>{
  const {root,d}=await fixture(t),writes:any[]=[];let revision=3,authorizationRevision=2;
  const api=actionApi((_path,init)=>{if(init?.method==='PUT'){writes.push(JSON.parse(String(init.body)));throw new ApiError('Generated conflict',409,undefined,'config_conflict');}return actionView(revision,authorizationRevision);});
  await act(async()=>root.render(React.createElement(Actions,{api,onOpen:()=>{}})));
  const input=d.querySelector<HTMLInputElement>('[aria-label="默认时区"]')!;
  Object.assign(input,{attachEvent:()=>{},detachEvent:()=>{}});
  await act(async()=>input.focus());
  await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(input,'Asia/Tokyo');input.dispatchEvent(new window.Event('input',{bubbles:true}));input.dispatchEvent(new window.KeyboardEvent('keyup',{bubbles:true,key:'o'}));});
  revision=4;authorizationRevision=3;await act(async()=>resources(api).invalidate(path=>path.startsWith('/api/actions?')));
  assert.equal(input.value,'Asia/Tokyo');await act(async()=>input.blur());
  assert.equal(writes[0].revision,3);assert.equal(writes[0].authorizationRevision,2);assert.equal(writes[0].settings.timeZone,'Asia/Tokyo');
  assert.match(d.body.textContent!,/配置或相关操作状态已变化/);assert.equal(input.value,'Asia/Tokyo');
  await act(async()=>button(d,'重新读取并还原草稿').click());assert.equal(input.value,'UTC');
});
