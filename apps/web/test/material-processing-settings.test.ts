import sharp from 'sharp';
import {randomUUID} from 'node:crypto';
import {PerceptionSettings} from '../src/PerceptionSettings';
import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configureLocale} from '@mote/shared/i18n';
import {ApiError,type Api} from '../src/api';
import {MaterialProcessing} from '../src/plugins/models-processing/MaterialProcessing';
import {FileProcessingSettings} from '../src/FileProcessingSettings';
import {automaticProcessingPlan,type ProcessingAuthority} from '../src/plugins/models-processing/automatic-processing-plan';
import {buildApp} from '../../server/src/app.js';
import {sha256} from '../../server/src/store.js';
import type {FileSettingsView} from '../src/processing-settings-view';
import type {ModelSettingsView} from '@mote/shared/models';
import {resources} from '../src/resource-cache';

async function fixture(t:import('node:test').TestContext){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),previous=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 dom.window.scrollTo=()=>{};configureLocale(()=>'zh-CN');const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());for(const [key,value]of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 const directory=mkdtempSync(join(tmpdir(),'mote-processing-ui-')),token='generated-processing-token-1234567890';
 const node=await buildApp({dataDir:directory,token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:3_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const writes:{path:string;body:any}[]=[];let failedImage=false;
 const call=async(path:string,init?:RequestInit)=>{
  const body=typeof init?.body==='string'?JSON.parse(init.body):undefined;
  if(init?.method&&init.method!=='GET'){writes.push({path,body});if(path==='/api/perception'&&failedImage)throw new ApiError('Generated image save unavailable',503);}
  const response=await node.app.inject({url:path,method:(init?.method??'GET') as 'GET'|'PUT'|'POST',headers:{authorization:'Bearer '+token},...(body!==undefined?{payload:body}:{})});
  if(response.statusCode>=400)throw new ApiError(response.json().message??response.body,response.statusCode,undefined,response.json().error);
  return response.json();
 };
 const api={request:call} as unknown as Api;
 return {root,d:dom.window.document,node,api,call,writes,set failedImage(value:boolean){failedImage=value;}};
}
async function until(check:()=>boolean,label:string){const deadline=Date.now()+15000;while(Date.now()<deadline){if(check())return;await act(async()=>new Promise(resolve=>setTimeout(resolve,5)));}throw Error('Timed out '+label);}
const button=(d:Document,label:string)=>[...d.querySelectorAll<HTMLButtonElement>('button')].find(value=>value.textContent?.trim()===label)!;
async function click(d:Document,label:string){assert.ok(button(d,label),label);await act(async()=>button(d,label).click());}
const label=(d:Document,text:string)=>[...d.querySelectorAll<HTMLLabelElement>('.material-processing-form label')].find(value=>value.childNodes[0]?.textContent===text)!;
async function select(d:Document,text:string,value:string){await act(async()=>{const control=label(d,text).querySelector('select')!;control.value=value;control.dispatchEvent(new window.Event('change',{bubbles:true}));});}
const view=(api:Api,kind:'images'|'audio'|'documents'='images')=>React.createElement(MaterialProcessing,{api,kind});

test('ordinary image settings reach the default optional build without granting background models or changing processing policy',async t=>{
 const f=await fixture(t),authority=structuredClone(f.node.modelAuthorization.view()),policy=structuredClone(f.node.processing.view());
 await act(async()=>f.root.render(view(f.api)));
 const toggle=()=>f.d.querySelector<HTMLButtonElement>('.local-image-settings [role=switch]');
 await until(()=>!!toggle()&&!toggle()!.disabled,'local image setting on the ordinary image page');
 assert.equal(toggle()!.getAttribute('aria-checked'),'false');
 assert.match(f.d.querySelector('.local-image-settings')!.textContent!,/InternVL3-14B-4bit/);
 assert.equal((await f.call('/api/plugin-builds/local-image')).desired,null);
 await act(async()=>toggle()!.click());
 await until(()=>toggle()!.getAttribute('aria-checked')==='true'&&!toggle()!.disabled,'acknowledged local image selection');
 assert.deepEqual(await f.call('/api/local-image-processing'),{enabled:true,state:'waiting',reason:'model_missing'});
 assert.deepEqual(f.node.modelAuthorization.view(),authority);
 assert.deepEqual(f.node.processing.view(),policy);
 await act(async()=>toggle()!.click());
 await until(()=>toggle()!.getAttribute('aria-checked')==='false'&&!toggle()!.disabled,'local image selection stopped');
 assert.deepEqual(await f.call('/api/local-image-processing'),{enabled:false,state:'stopped'});
 assert.deepEqual(f.node.modelAuthorization.view(),authority);
 assert.deepEqual(f.writes.map(value=>value.path),['/api/plugin-builds/local-image','/api/plugin-builds/local-image']);
});

test('image edits use real policy and perception CAS, report a partial save and retry only the unconfirmed image settings',async t=>{
 const f=await fixture(t),first=await f.call('/api/file-processing');
 first.policy.services.push({id:'generated-image',name:'Generated OCR',kind:'image',execution:'remote',endpoint:'https://generated.invalid/ocr',model:''});
 await f.call('/api/file-processing',{method:'PUT',body:JSON.stringify({revision:first.revision,settings:first.settings,policy:first.policy})});f.writes.length=0;
 const authority=structuredClone(f.node.modelAuthorization.view());await act(async()=>f.root.render(view(f.api)));await until(()=>!!f.d.querySelector('.material-processing-form'),'image settings');
 await select(f.d,'OCR 服务','generated-image');f.failedImage=true;await click(f.d,'保存设置');
 await until(()=>f.d.querySelector('.material-processing [data-processing-main] > [role=alert]')?.textContent?.includes('处理方案已保存，图片设置尚未确认')===true,'partial save result');assert.equal(f.writes.filter(value=>value.path==='/api/file-processing').length,1);
 assert.equal((await f.call('/api/file-processing')).policy.profiles.find((value:any)=>value.id==='central-image').serviceId,'generated-image');
 assert.equal(label(f.d,'OCR 服务').querySelector('select')!.value,'generated-image');assert.equal(button(f.d,'保存设置').disabled,false);
 f.failedImage=false;await click(f.d,'保存设置');await until(()=>f.d.querySelector('.material-processing-form [role=status]')?.textContent?.includes('设置已保存')===true,'complete image settings');assert.equal(f.writes.filter(value=>value.path==='/api/file-processing').length,1,'the completed first save is not blindly repeated');assert.equal(f.writes.filter(value=>value.path==='/api/perception').length,2);
 assert.equal((await f.call('/api/perception')).settings.ocrEndpoint,'https://generated.invalid/ocr');assert.match(f.d.querySelector('.material-processing-form [role=status]')!.textContent!,/设置已保存/);assert.deepEqual(f.node.modelAuthorization.view(),authority,'saving a service/profile does not authorize background work');
});

test('file processing settings never offer a legacy-configuration migration hint',async t=>{
 const f=await fixture(t),view=await f.call('/api/file-processing');
 const api={request:async(path:string,init?:RequestInit)=>path==='/api/file-processing'?{...view,policyConfigured:false}:f.api.request(path,init)} as Api;
 await act(async()=>f.root.render(React.createElement(FileProcessingSettings,{api})));await until(()=>!!f.d.querySelector('form'),'file processing settings');
 assert.match(f.d.body.textContent!,/已保存类型方案/);assert.doesNotMatch(f.d.body.textContent!,/旧配置/);
});

test('file maintenance settings show released snapshot input and cancel the real preview without starting processing',async t=>{
 const f=await fixture(t),bytes=Buffer.from('Generated preview file');
 f.node.sources.register({id:'generated-files',name:'Generated files',kind:'local-files',deviceId:'generated-device',platform:'macos',retention:'snapshot'});
 const hash=sha256(bytes),input=f.node.files.begin({sourceId:'generated-files',item:{externalId:'generated',revision:'1',observedAt:new Date().toISOString(),title:'Generated preview file',kind:'file',layer:'snapshot',text:'',mimeType:'text/plain',deleted:false,document:{fileIndex:{version:1,fileId:'generated',contentVersion:hash,mode:'index',coverage:'none',parser:'central-pending',status:'pending',totalCharacters:0,offset:0,length:0,maxIndexCharacters:8000,allowRead:false}}},sizeBytes:bytes.length,sha256:hash},()=>{});
 f.node.files.part(input.uploadId,0,bytes,()=>{});const file=(await f.node.files.commit(input.uploadId,()=>{})).id;
 await f.node.processing.tick();assert.equal(f.node.files.detail(file).job!.state,'succeeded');
 const pixels=await sharp({create:{width:4,height:4,channels:3,background:'#aabbcc'}}).png().toBuffer(),imageHash=sha256(pixels);
 const image=f.node.files.begin({sourceId:'generated-files',item:{externalId:'generated-image',revision:'1',observedAt:new Date().toISOString(),title:'Generated preview image',kind:'file',layer:'snapshot',text:'',mimeType:'image/png',deleted:false,document:{fileIndex:{version:1,fileId:'generated-image',contentVersion:imageHash,mode:'index',coverage:'none',parser:'central-pending',status:'pending',totalCharacters:0,offset:0,length:0,maxIndexCharacters:8000,allowRead:false}}},sizeBytes:pixels.length,sha256:imageHash},()=>{});
 f.node.files.part(image.uploadId,0,pixels,()=>{});const imageId=(await f.node.files.commit(image.uploadId,()=>{})).id;assert.equal(f.node.processing.imageControl?.owns(imageId),true);
 f.writes.length=0;await act(async()=>f.root.render(React.createElement(FileProcessingSettings,{api:f.api})));await until(()=>!!f.d.querySelector('form'),'file processing settings');
 await click(f.d,'预览已有文件重处理');await until(()=>!!f.d.querySelector('.policy-preview'),'maintenance preview');
 assert.match(f.d.querySelector('.policy-preview')!.textContent!,/需由来源设备重新上传/);
 assert.match(f.d.querySelector('.policy-preview')!.textContent!,/图片理解可能将原图发送给所选模型服务/);
 const posted=f.writes.find(value=>value.path==='/api/file-processing/preview')!;assert.deepEqual(posted.body.scope,{kind:'all'});
 const cancel=[...f.d.querySelectorAll<HTMLButtonElement>('.policy-preview button')].find(value=>value.textContent==='取消')!;
 await act(async()=>cancel.click());await until(()=>!f.d.querySelector('.policy-preview'),'preview cancellation');
 const deleted=f.writes.find(value=>value.path.startsWith('/api/file-processing/preview/'))!;assert.ok(deleted);
 assert.ok(!f.writes.some(value=>value.path==='/api/file-processing/reprocess'));
 await assert.rejects(f.call('/api/file-processing/reprocess',{method:'POST',body:JSON.stringify({token:deleted.path.split('/').at(-1)})}),{status:409});
 f.node.processing.cancel(imageId);await f.node.processing.tick();assert.equal(f.node.files.detail(file).job!.state,'succeeded');assert.equal(f.node.store.db.prepare("SELECT COUNT(*) n FROM task_records WHERE kind='file-reprocess'").get()!.n,0);
});

test('a concurrent settings change rejects the original image draft without overwriting another owner window',async t=>{
 const f=await fixture(t);await act(async()=>f.root.render(view(f.api)));await until(()=>!!f.d.querySelector('.material-processing-form'),'image settings');
 const checks=f.d.querySelectorAll<HTMLInputElement>('.material-processing-form input[type=checkbox]');await act(async()=>checks[1].click());
 const actual=await f.call('/api/perception');actual.settings.providerRevision='generated-other-window';await f.call('/api/perception',{method:'PUT',body:JSON.stringify({revision:actual.revision,settings:actual.settings})});f.writes.length=0;
 await click(f.d,'保存设置');await until(()=>!!f.d.querySelector('.material-processing [data-processing-main] > [role=alert]')&&!button(f.d,'保存设置').disabled,'concurrent save rejected');assert.equal((await f.call('/api/perception')).settings.providerRevision,'generated-other-window');assert.equal(checks[1].checked,!actual.settings.understandingEnabled);assert.equal(button(f.d,'保存设置').disabled,false);
});

test('the exact service and feature-model pages return to the same unsaved image draft without publishing it',async t=>{
 const f=await fixture(t);await act(async()=>f.root.render(view(f.api)));await until(()=>!!f.d.querySelector('.material-processing-form'),'image settings');
 const check=f.d.querySelector<HTMLInputElement>('.material-processing-form input[type=checkbox]')!,before=check.checked;await act(async()=>check.click());
 await click(f.d,'管理这个服务 →');await until(()=>!!f.d.querySelector('.processing-services.is-detail form'),'exact selected service');
 assert.equal(f.d.querySelector('[data-processing-main]')!.hasAttribute('hidden'),true);assert.equal([...f.d.querySelectorAll('.processing-services label')].find(value=>value.firstChild?.textContent==='服务名称')!.querySelector('input')!.value,'Central OCR');
 await click(f.d,'图片');assert.equal(f.d.querySelector('[data-processing-main]')!.hasAttribute('hidden'),false);assert.equal(check.checked,!before);assert.equal(f.writes.length,0);
 await click(f.d,'更改功能模型 →');await until(()=>!!f.d.querySelector('.module-assignments'),'feature models');assert.equal(f.d.querySelector('[data-processing-main]')!.hasAttribute('hidden'),true);await click(f.d,'← 图片');assert.equal(check.checked,!before);assert.equal(f.d.querySelector('[data-processing-main]')!.hasAttribute('hidden'),false);assert.equal(f.writes.length,0);
});

test('a confirmed edit to the same service advances only its known revision and keeps the parent image draft saveable',async t=>{
 const f=await fixture(t);await act(async()=>f.root.render(view(f.api)));await until(()=>!!f.d.querySelector('.material-processing-form'),'image settings');
 const enabled=f.d.querySelector<HTMLInputElement>('.material-processing-form input[type=checkbox]')!;await act(async()=>enabled.click());const expected=enabled.checked;
 await click(f.d,'管理这个服务 →');await until(()=>!!f.d.querySelector('.processing-services.is-detail form'),'exact selected service');
 const name=[...f.d.querySelectorAll('.processing-services label')].find(value=>value.firstChild?.textContent==='服务名称')!.querySelector('input')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(f.d.defaultView!.HTMLInputElement.prototype,'value')!.set!.call(name,'Generated edited local OCR');name.dispatchEvent(new window.Event('input',{bubbles:true}));});
 await act(async()=>f.d.querySelector<HTMLButtonElement>('.processing-services .model-save-footer .primary')!.click());await until(()=>f.d.querySelector('.processing-services [role=status]')?.textContent?.includes('服务已保存')===true,'actual service save');
 await click(f.d,'图片');assert.equal(enabled.checked,expected);await click(f.d,'保存设置');await until(()=>f.d.querySelector('.material-processing-form [role=status]')?.textContent?.includes('设置已保存')===true,'parent draft save after exact child receipt');
 assert.equal((await f.call('/api/perception')).settings.enabled,expected);assert.equal(f.writes.filter(value=>value.path==='/api/file-processing').length,1,'the child service write is not repeated by the parent');assert.equal((await f.call('/api/file-processing')).policy.services.find((value:any)=>value.id==='central-image-ocr').name,'Generated edited local OCR');
});

test('opening a removed exact service never exposes the previous service write target and keeps that separate draft for an explicit return',async t=>{
 const f=await fixture(t),initial=await f.call('/api/file-processing');initial.policy.services.push({id:'generated-b',name:'Generated service B',kind:'image',execution:'remote',endpoint:'https://generated.invalid/b',model:''});await f.call('/api/file-processing',{method:'PUT',body:JSON.stringify({revision:initial.revision,settings:initial.settings,policy:initial.policy})});
 await act(async()=>f.root.render(view(f.api)));await until(()=>!!f.d.querySelector('.material-processing-form'),'image settings');await click(f.d,'管理这个服务 →');await until(()=>!!f.d.querySelector('.processing-services.is-detail form'),'service A');
 const name=[...f.d.querySelectorAll('.processing-services label')].find(value=>value.firstChild?.textContent==='服务名称')!.querySelector('input')!;await act(async()=>{Object.getOwnPropertyDescriptor(f.d.defaultView!.HTMLInputElement.prototype,'value')!.set!.call(name,'Unsaved separate A');name.dispatchEvent(new window.Event('input',{bubbles:true}));});await click(f.d,'图片');await select(f.d,'OCR 服务','generated-b');
 const changed=await f.call('/api/file-processing');changed.policy.services=changed.policy.services.filter((value:any)=>value.id!=='generated-b');await f.call('/api/file-processing',{method:'PUT',body:JSON.stringify({revision:changed.revision,settings:changed.settings,policy:changed.policy})});await act(async()=>resources(f.api).invalidate(path=>path==='/api/file-processing'));await until(()=>!resources(f.api).get('/api/file-processing').getSnapshot().loading,'current service catalog');f.writes.length=0;
 await click(f.d,'管理这个服务 →');await until(()=>f.d.querySelector('.processing-services [role=alert]')?.textContent?.includes('所选服务已不可用')===true,'removed exact service');assert.equal(f.d.querySelector('.processing-services.is-detail form'),null);assert.equal(f.writes.length,0);
 await click(f.d,'← 图片');await select(f.d,'OCR 服务','central-image-ocr');await click(f.d,'管理这个服务 →');await until(()=>!!f.d.querySelector('.processing-services.is-detail form'),'explicit service A return');assert.equal([...f.d.querySelectorAll('.processing-services label')].find(value=>value.firstChild?.textContent==='服务名称')!.querySelector('input')!.value,'Unsaved separate A');assert.equal(f.writes.length,0);
});

test('an old owner save cannot repaint a different owner or trigger its second image write',async t=>{
 const f=await fixture(t);await act(async()=>f.root.render(view(f.api)));await until(()=>!!f.d.querySelector('.material-processing-form'),'image settings');
 await select(f.d,'文字识别','archive');let release!:(value:any)=>void;const pending=new Promise(resolve=>release=resolve),real=f.api.request.bind(f.api);let held=false;
 f.api.request=async(path,init)=>{if(path==='/api/file-processing'&&init?.method==='PUT'){held=true;return pending as any;}return real(path,init);};
 await act(async()=>button(f.d,'保存设置').click());assert.equal(held,true);
 const other={request:async()=>{throw new ApiError('Generated other owner denied',403);}} as Api;await act(async()=>f.root.render(view(other)));await act(async()=>release(await f.call('/api/file-processing')));
 assert.equal(f.d.querySelector('.material-processing-form'),null);assert.equal(f.writes.filter(value=>value.path==='/api/perception').length,0);assert.doesNotMatch(f.d.body.textContent!,/设置已保存；/);
});

for(const state of ['enabled','paused','stopped'] as const)test('saved '+state+' empty source scope is deny-all and is preserved in a new settings proposal',()=>{
 const connection={id:'profile:generated:new',fingerprint:'a'.repeat(64)},authority={revision:3,state,connections:[],scope:{sourceIds:[],dataKinds:['text']}} as ProcessingAuthority;
 const models={profiles:[{id:'generated',settings:{model:'new'}}],defaults:{chat:'generated',memory:'generated',insight:'generated',import:'generated',file:'generated'},defaultModels:{}} as ModelSettingsView;
 const media={settings:{enabled:false},policy:{rules:[],profiles:[],services:[]},processors:[]} as unknown as FileSettingsView;
 const {plan,covered}=automaticProcessingPlan(authority,[connection],models,media,true,['generated-source','device:new']);assert.deepEqual(plan.scope.sourceIds,[]);assert.equal(covered,false);assert.deepEqual(plan.connections,[connection]);
 assert.deepEqual(automaticProcessingPlan({...authority,state:'unapproved'},[connection],models,media,true,['generated-source']).plan.scope.sourceIds,['generated-source']);
});

test('a real historical image preview can be cancelled without granting or scheduling its original',async t=>{
 const f=await fixture(t),bytes=await sharp({create:{width:12,height:12,channels:3,background:'#eadfcf'}}).png().toBuffer(),id=randomUUID();
 await f.node.store.ingest({id,deviceId:'generated-preview',deviceName:'Generated preview',platform:'import',source:'screen',capturedAt:'2026-10-29T00:00:00Z',durationMs:0,ocrText:'',ocr:{status:'disabled'},privacy:{excluded:false,redacted:false,mode:'local'},imageMime:'image/png',imageBase64:bytes.toString('base64')});
 const grant=structuredClone(f.node.modelAuthorization.view());await act(async()=>f.root.render(React.createElement(PerceptionSettings,{api:f.api})));await until(()=>!!button(f.d,'预览处理范围'),'historical controls');await click(f.d,'预览处理范围');await until(()=>f.d.body.textContent!.includes('范围内共 1 张图片'),'real one-image preview');assert.ok(button(f.d,'取消'));await click(f.d,'取消');assert.doesNotMatch(f.d.body.textContent!,/范围内共 1 张图片/);assert.equal(f.writes.filter(write=>write.path==='/api/perception/ocr/historical-process').length,0);assert.equal(f.node.store.db.prepare('SELECT COUNT(*) n FROM image_backfills').get()!.n,0);assert.deepEqual(f.node.modelAuthorization.view(),grant);assert.ok(f.node.store.evidence([id])[0]);
});
test('a late historical preview for the previous Api cannot become the new owner confirmation',async t=>{
 const f=await fixture(t),real=f.api.request.bind(f.api);let release!:(value:any)=>void,previous:any;f.api.request=async(path,init)=>{const value=await real(path,init);if(path==='/api/perception/ocr/historical-preview'){previous=value;return new Promise(resolve=>{release=resolve;});}return value;};await act(async()=>f.root.render(React.createElement(PerceptionSettings,{api:f.api})));await until(()=>!!button(f.d,'预览处理范围'),'historical controls');await click(f.d,'预览处理范围');await until(()=>Boolean(release),'actual previous preview pending');const next={request:real} as Api;await act(async()=>f.root.render(React.createElement(PerceptionSettings,{api:next})));await until(()=>!!button(f.d,'预览处理范围'),'new owner controls');await act(async()=>release(previous));assert.equal(f.d.body.textContent!.includes('范围内共'),false,'Previous owner preview must not become a new confirmation');
});
