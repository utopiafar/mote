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
import {MaterialProcessing} from '../src/MaterialProcessing';
import {AutomaticProcessing} from '../src/AutomaticProcessing';
import {automaticProcessingPlan,type ProcessingAuthority} from '../src/automatic-processing-plan';
import {buildApp} from '../../server/src/app.js';
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
const freshAutomaticReview=(d:Document)=>!!d.querySelector<HTMLButtonElement>('.automatic-review-dialog footer .primary')&&!d.querySelector<HTMLButtonElement>('.automatic-review-dialog footer .primary')!.disabled;
async function click(d:Document,label:string){assert.ok(button(d,label),label);await act(async()=>button(d,label).click());}
const label=(d:Document,text:string)=>[...d.querySelectorAll<HTMLLabelElement>('.material-processing-form label')].find(value=>value.childNodes[0]?.textContent===text)!;
async function select(d:Document,text:string,value:string){await act(async()=>{const control=label(d,text).querySelector('select')!;control.value=value;control.dispatchEvent(new window.Event('change',{bubbles:true}));});}
const view=(api:Api,kind:'images'|'audio'|'documents'='images')=>React.createElement(MaterialProcessing,{api,kind});

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

test('the ordinary automatic-processing control requires a real review, cancel sends nothing, and pause and stop keep their distinct commands',async t=>{
 const f=await fixture(t);await act(async()=>f.root.render(React.createElement(AutomaticProcessing,{api:f.api})));await until(()=>!!button(f.d,'开启自动处理')&&!button(f.d,'开启自动处理').disabled,'automatic control');
 assert.equal(f.writes.length,0);await click(f.d,'开启自动处理');assert.ok(f.d.querySelector('[role=dialog]'));await click(f.d,'暂不开启');assert.equal(f.writes.length,0);assert.equal(f.node.modelAuthorization.view().state,'unapproved');
 await click(f.d,'开启自动处理');await until(()=>freshAutomaticReview(f.d),'fresh automatic review');await act(async()=>f.d.querySelector<HTMLButtonElement>('[role=dialog] footer .primary')!.click());await until(()=>f.node.modelAuthorization.view().state==='enabled','explicit authority');
 assert.equal(f.writes.length,1);assert.equal(f.writes[0].path,'/api/model-authorization/commands');assert.ok(f.writes[0].body.operationId);assert.ok(f.writes[0].body.scope.sourceIds.includes('mote.conversations'));
 await until(()=>!!button(f.d,'暂停新任务'),'enabled status');await click(f.d,'暂停新任务');assert.equal(f.writes.at(-1)!.body.action,'pause');assert.equal('scope' in f.writes.at(-1)!.body,false);
 await until(()=>!!button(f.d,'恢复自动处理'),'paused status');await click(f.d,'立即停止全部自动任务');await until(()=>f.node.modelAuthorization.view().state==='stopped','stop acknowledged');assert.equal(f.writes.at(-1)!.body.action,'stop');assert.equal(f.node.modelAuthorization.view().state,'stopped');
});

test('an unconfirmed automatic-processing command retries the identical operation and review without granting on an error',async t=>{
 const f=await fixture(t),real=f.api.request.bind(f.api),attempts:any[]=[];let fail=true;
 f.api.request=async(path,init)=>{if(path==='/api/model-authorization/commands'&&init?.method==='POST'){attempts.push(JSON.parse(String(init.body)));if(fail)throw new ApiError('Generated command response unavailable',503);}return real(path,init);};
 await act(async()=>f.root.render(React.createElement(AutomaticProcessing,{api:f.api})));await until(()=>!!button(f.d,'开启自动处理')&&!button(f.d,'开启自动处理').disabled,'automatic control');await click(f.d,'开启自动处理');
 await until(()=>freshAutomaticReview(f.d),'fresh automatic review');await act(async()=>f.d.querySelector<HTMLButtonElement>('.automatic-review-dialog footer .primary')!.click());await until(()=>!!f.d.querySelector('.automatic-review-dialog [role=alert]')&&!f.d.querySelector<HTMLButtonElement>('.automatic-review-dialog footer .primary')!.disabled,'unconfirmed command');
 assert.equal(f.node.modelAuthorization.view().state,'unapproved');fail=false;await act(async()=>f.d.querySelector<HTMLButtonElement>('.automatic-review-dialog footer .primary')!.click());await until(()=>f.node.modelAuthorization.view().state==='enabled','command retry');assert.equal(attempts.length,2);assert.deepEqual(attempts[1],attempts[0]);
});

test('withdrawn owner authority immediately removes the open processing review and cannot submit its former source scope',async t=>{
 const f=await fixture(t),real=f.api.request.bind(f.api);let denied=false;
 f.api.request=async(path,init)=>{if(denied&&path==='/api/model-authorization')throw new ApiError('Generated authority withdrawn',403);return real(path,init);};
 await act(async()=>f.root.render(React.createElement(AutomaticProcessing,{api:f.api})));await until(()=>!!button(f.d,'开启自动处理')&&!button(f.d,'开启自动处理').disabled,'automatic control');await click(f.d,'开启自动处理');assert.ok(f.d.querySelector('.automatic-review-dialog'));
 denied=true;await act(async()=>resources(f.api).invalidate(path=>path==='/api/model-authorization'));await until(()=>!f.d.querySelector('.automatic-review-dialog'),'revoked review cleared');assert.equal(button(f.d,'开启自动处理').disabled,true);assert.equal(f.writes.length,0);assert.equal(f.node.modelAuthorization.view().state,'unapproved');
});

test('a committed automatic command with lost ACK remains explicitly recoverable by the identical operation after revision refresh',async t=>{
 const f=await fixture(t),real=f.api.request.bind(f.api),attempts:any[]=[];let lose=true;
 f.api.request=async(path,init)=>{if(path==='/api/model-authorization/commands'&&init?.method==='POST'){attempts.push(JSON.parse(String(init.body)));const result=await real(path,init);if(lose){lose=false;throw new ApiError('Generated ACK lost after actual commit',503);}return result;}return real(path,init);};
 await act(async()=>f.root.render(React.createElement(AutomaticProcessing,{api:f.api})));await until(()=>!!button(f.d,'开启自动处理')&&!button(f.d,'开启自动处理').disabled,'automatic control');await click(f.d,'开启自动处理');
 await until(()=>freshAutomaticReview(f.d),'fresh automatic review');await act(async()=>{const submit=f.d.querySelector<HTMLButtonElement>('.automatic-review-dialog footer .primary')!;submit.click();submit.click();});await until(()=>f.node.modelAuthorization.view().state==='enabled'&&!!f.d.querySelector('.automatic-review-dialog [role=alert]'),'actual commit but no ACK');
 const revision=f.node.modelAuthorization.view().revision;assert.equal(attempts.length,1);assert.ok(button(f.d,'重试'),'The frozen command remains explicitly recoverable after the authoritative revision advances');assert.equal(button(f.d,'重试').disabled,false);await click(f.d,'重试');await until(()=>!f.d.querySelector('.automatic-review-dialog'),'same operation acknowledged');assert.equal(attempts.length,2);assert.deepEqual(attempts[1],attempts[0]);assert.equal(f.node.modelAuthorization.view().revision,revision);assert.match(f.d.body.textContent!,/已保存后续任务的授权范围/);
});

test('a real historical image preview can be cancelled without granting or scheduling its original',async t=>{
 const f=await fixture(t),bytes=await sharp({create:{width:12,height:12,channels:3,background:'#eadfcf'}}).png().toBuffer(),id=randomUUID();
 await f.node.store.ingest({id,deviceId:'generated-preview',deviceName:'Generated preview',platform:'import',source:'screen',capturedAt:'2026-10-29T00:00:00Z',durationMs:0,ocrText:'',ocr:{status:'disabled'},privacy:{excluded:false,redacted:false,mode:'local'},imageMime:'image/png',imageBase64:bytes.toString('base64')});
 const grant=structuredClone(f.node.modelAuthorization.view());await act(async()=>f.root.render(React.createElement(PerceptionSettings,{api:f.api})));await until(()=>!!button(f.d,'预览处理范围'),'historical controls');await click(f.d,'预览处理范围');await until(()=>f.d.body.textContent!.includes('范围内共 1 张图片'),'real one-image preview');assert.ok(button(f.d,'取消'));await click(f.d,'取消');assert.doesNotMatch(f.d.body.textContent!,/范围内共 1 张图片/);assert.equal(f.writes.filter(write=>write.path==='/api/perception/ocr/historical-process').length,0);assert.equal(f.node.store.db.prepare('SELECT COUNT(*) n FROM image_backfills').get()!.n,0);assert.deepEqual(f.node.modelAuthorization.view(),grant);assert.ok(f.node.store.evidence([id])[0]);
});
test('a late historical preview for the previous Api cannot become the new owner confirmation',async t=>{
 const f=await fixture(t),real=f.api.request.bind(f.api);let release!:(value:any)=>void,previous:any;f.api.request=async(path,init)=>{const value=await real(path,init);if(path==='/api/perception/ocr/historical-preview'){previous=value;return new Promise(resolve=>{release=resolve;});}return value;};await act(async()=>f.root.render(React.createElement(PerceptionSettings,{api:f.api})));await until(()=>!!button(f.d,'预览处理范围'),'historical controls');await click(f.d,'预览处理范围');await until(()=>Boolean(release),'actual previous preview pending');const next={request:real} as Api;await act(async()=>f.root.render(React.createElement(PerceptionSettings,{api:next})));await until(()=>!!button(f.d,'预览处理范围'),'new owner controls');await act(async()=>release(previous));assert.equal(f.d.body.textContent!.includes('范围内共'),false,'Previous owner preview must not become a new confirmation');
});

const automaticKeys=['/api/model-authorization','/api/model-settings','/api/file-processing','/api/perception','/api/sources','/api/devices'];
async function automaticClockFixture(t:import('node:test').TestContext){
 const f=await fixture(t),reads:{path:string;signal?:AbortSignal|null}[]=[];let hidden=false;
 let hold:((path:string,value:any,init?:RequestInit)=>Promise<any>|undefined)|undefined;
 Object.defineProperty(f.d,'hidden',{get:()=>hidden,configurable:true});
 f.api.request=async(path,init)=>{if(!init?.method||init.method==='GET')reads.push({path,signal:init?.signal});const value=await f.call(path,init);return hold?.(path,value,init)??value;};
 t.mock.timers.enable({apis:['setTimeout']});
 const restoreClock=()=>t.mock.timers.reset();
 const tick=async(ms=0)=>act(async()=>{t.mock.timers.tick(ms);await new Promise<void>(resolve=>setImmediate(resolve));});
 const settle=async(check:()=>boolean,label:string)=>{const deadline=Date.now()+15000;while(Date.now()<deadline){if(check())return;await tick();}throw Error('Timed out '+label);};
 const render=async(owner=f.api)=>{await act(async()=>f.root.render(React.createElement(AutomaticProcessing,{api:owner})));await tick();};
 const visibility=async(value:boolean)=>{hidden=value;await act(async()=>f.d.dispatchEvent(new f.d.defaultView!.Event('visibilitychange')));};
 const count=(path:string)=>reads.filter(value=>value.path===path).length;
 const ready=()=>!!f.d.querySelector<HTMLButtonElement>('.automatic-control-main button')&&!f.d.querySelector<HTMLButtonElement>('.automatic-control-main button')!.disabled;
 const authorize=async()=>{await click(f.d,'开启自动处理');await settle(()=>!!f.d.querySelector<HTMLButtonElement>('.automatic-review-dialog footer .primary')&&!f.d.querySelector<HTMLButtonElement>('.automatic-review-dialog footer .primary')!.disabled,'fresh automatic review');await act(async()=>f.d.querySelector<HTMLButtonElement>('.automatic-review-dialog footer .primary')!.click());await settle(()=>f.node.modelAuthorization.view().state==='enabled'&&!f.d.querySelector('.automatic-review-dialog'),'automatic authorization acknowledged');};
 return {...f,reads,tick,settle,render,visibility,count,ready,authorize,restoreClock,hold:(next:typeof hold)=>hold=next};
}

test('automatic processing keeps visible 5s authority, no hidden timer GETs for 60s, and one exact foreground dependency refresh',async t=>{
 const f=await automaticClockFixture(t);let unsubscribe:(()=>void)|undefined;
 try{
  await f.render();await f.settle(f.ready,'initial automatic dependencies');automaticKeys.forEach(path=>assert.equal(f.count(path),1,path));
  const unrelated='/api/sources?generated=unrelated',resource=resources(f.api).get(unrelated);unsubscribe=resource.subscribe(()=>{});await f.settle(()=>!resource.getSnapshot().loading,'unrelated observed resource');
  await f.tick(4999);assert.equal(f.count(automaticKeys[0]),1);await f.tick(1);await f.settle(()=>!resources(f.api).get(automaticKeys[0]).getSnapshot().loading,'visible 5s authority');assert.equal(f.count(automaticKeys[0]),2);
  const before=automaticKeys.map(f.count);await f.visibility(true);for(let i=0;i<12;i++)await f.tick(5000);assert.deepEqual(automaticKeys.map(f.count),before,'hidden 60s creates no timer resource GET');
  await f.visibility(false);await f.visibility(false);await f.tick();await f.settle(()=>automaticKeys.every(path=>!resources(f.api).get(path).getSnapshot().loading),'foreground dependencies settled');
  assert.deepEqual(automaticKeys.map(f.count),before.map(value=>value+1),'duplicate visible events merge one fresh read for every exact dependency');assert.equal(f.count(unrelated),1,'foreground does not invalidate a prefix-related resource');
  await f.tick(4999);assert.equal(f.count(automaticKeys[0]),before[0]+1);await f.tick(1);assert.equal(f.count(automaticKeys[0]),before[0]+2,'the original visible authority interval continues');
 }finally{unsubscribe?.();f.restoreClock();}
});

test('opening automatic review rereads all dependencies and cannot authorize while a real fresh model response is held',async t=>{
 const f=await automaticClockFixture(t);
 try{
  await f.render();await f.settle(f.ready,'initial automatic dependencies');
  const media=await f.call('/api/file-processing');media.policy.services.find((value:any)=>value.id==='central-image-ocr').name='Generated refreshed OCR';await f.call('/api/file-processing',{method:'PUT',body:JSON.stringify({revision:media.revision,settings:media.settings,policy:media.policy})});f.writes.length=0;
  let release!:(value:any)=>void,held:any;f.hold((path,value)=>{if(path==='/api/model-settings'){held=value;return new Promise(resolve=>release=resolve);}});
  const before=automaticKeys.map(f.count);await click(f.d,'开启自动处理');await f.tick();assert.ok(release,'opening review starts an actual fresh model-settings read');
  assert.deepEqual(automaticKeys.map(f.count),before.map(value=>value+1));assert.equal(f.d.querySelector<HTMLButtonElement>('.automatic-review-dialog footer .primary')!.disabled,true);assert.equal(f.writes.length,0);
  f.hold(undefined);await act(async()=>release(held));await f.settle(()=>!!f.d.querySelector<HTMLButtonElement>('.automatic-review-dialog footer .primary')&&!f.d.querySelector<HTMLButtonElement>('.automatic-review-dialog footer .primary')!.disabled,'fresh review ready');
  assert.match(f.d.querySelector('.automatic-review-dialog')!.textContent!,/Generated refreshed OCR/);await click(f.d,'暂不开启');assert.equal(f.writes.length,0);assert.equal(f.node.modelAuthorization.view().state,'unapproved');
 }finally{f.restoreClock();}
});

test('opening the saved automatic scope rereads dependencies and closing a held review cannot reopen or change its grant',async t=>{
 const f=await automaticClockFixture(t);
 try{
  await f.render();await f.settle(f.ready,'initial automatic dependencies');await f.authorize();const grant=structuredClone(f.node.modelAuthorization.view());f.writes.length=0;
  let release!:(value:any)=>void,held:any;f.hold((path,value)=>{if(path==='/api/devices'){held=value;return new Promise(resolve=>release=resolve);}});
  const before=automaticKeys.map(f.count);await act(async()=>f.d.querySelector<HTMLElement>('.automatic-control-more > summary')!.click());await click(f.d,'资料处理范围');await f.tick();assert.ok(release,'saved-scope review also rereads devices');assert.deepEqual(automaticKeys.map(f.count),before.map(value=>value+1));
  assert.match(f.d.querySelector('.automatic-review-dialog')!.textContent!,/当前自动处理范围/);assert.equal(Boolean(f.d.querySelector('.automatic-review-dialog footer .primary')),false);assert.equal(button(f.d,'调整资料范围').disabled,true,'fresh review cannot edit the old dependency snapshot');
  await click(f.d,'关闭');f.hold(undefined);await act(async()=>release(held));await f.tick();assert.equal(Boolean(f.d.querySelector('.automatic-review-dialog')),false);assert.equal(f.writes.length,0);assert.deepEqual(f.node.modelAuthorization.view(),grant);
 }finally{f.restoreClock();}
});

test('foreground observes a real remote processing connection change without approving the new provider',async t=>{
 const f=await automaticClockFixture(t);
 try{
  const image=await f.call('/api/perception');await f.call('/api/perception',{method:'PUT',body:JSON.stringify({revision:image.revision,settings:{...image.settings,enabled:true}})});
  const initial=await f.call('/api/file-processing');await f.call('/api/file-processing',{method:'PUT',body:JSON.stringify({revision:initial.revision,settings:{...initial.settings,enabled:true},policy:initial.policy})});
  await f.render();await f.settle(f.ready,'initial automatic dependencies');await f.authorize();const grant=structuredClone(f.node.modelAuthorization.view());
  const media=await f.call('/api/file-processing');media.policy.services.push({id:'generated-foreground-ocr',name:'Generated changed provider',kind:'image',execution:'remote',endpoint:'https://generated.invalid/new-ocr',model:''});media.policy.profiles.find((value:any)=>value.id==='central-image').serviceId='generated-foreground-ocr';await f.call('/api/file-processing',{method:'PUT',body:JSON.stringify({revision:media.revision,settings:media.settings,policy:media.policy})});f.writes.length=0;
  await f.visibility(true);await f.visibility(false);await f.tick();await f.settle(()=>automaticKeys.every(path=>!resources(f.api).get(path).getSnapshot().loading),'changed provider dependencies');assert.equal(f.d.querySelector('.automatic-control-main button')?.textContent,'确认新设置');assert.deepEqual(f.node.modelAuthorization.view().connections,grant.connections,'fresh reads never authorize the replacement provider');
  await click(f.d,'确认新设置');await f.settle(()=>freshAutomaticReview(f.d),'fresh changed-provider review');assert.match(f.d.querySelector('.automatic-review-dialog')!.textContent!,/Generated changed provider/);assert.match(f.d.querySelector('.automatic-review-dialog')!.textContent!,/https:\/\/generated.invalid\/new-ocr/);await click(f.d,'取消');assert.equal(f.writes.length,0);assert.deepEqual(f.node.modelAuthorization.view().scope,grant.scope);
 }finally{f.restoreClock();}
});

test('remote pause and stop remain observable on the original visible five-second authority fallback',async t=>{
 const f=await automaticClockFixture(t);
 try{
  await f.render();await f.settle(f.ready,'initial automatic dependencies');await f.authorize();
  for(const [action,label] of [['pause','恢复自动处理'],['stop','重新开启']] as const){
   const current=f.node.modelAuthorization.view(),reads=f.count(automaticKeys[0]);await f.call(automaticKeys[0]+'/commands',{method:'POST',body:JSON.stringify({revision:current.revision,action,operationId:randomUUID()})});
   await f.tick(4999);assert.equal(f.count(automaticKeys[0]),reads);await f.tick(1);await f.settle(()=>f.d.querySelector('.automatic-control-main button')?.textContent===label,'remote '+action);assert.equal(f.count(automaticKeys[0]),reads+1);
  }
 }finally{f.restoreClock();}
});

test('a remote stop advances authority without replacing an edited automatic scope or bypassing its review revision',async t=>{
 const f=await automaticClockFixture(t);
 try{
  await f.render();await f.settle(f.ready,'initial automatic dependencies');await f.authorize();await click(f.d,'资料处理范围');await f.settle(()=>!!button(f.d,'调整资料范围')&&!button(f.d,'调整资料范围').disabled,'fresh saved scope');await click(f.d,'调整资料范围');
  const all=f.d.querySelector<HTMLInputElement>('.automatic-source-options input')!;assert.equal(all.checked,false);await act(async()=>all.click());assert.equal(all.checked,true);const selected=[...f.d.querySelectorAll<HTMLInputElement>('.automatic-source-options input')].map(value=>value.checked);
  const grant=f.node.modelAuthorization.view();await f.call(automaticKeys[0]+'/commands',{method:'POST',body:JSON.stringify({revision:grant.revision,action:'stop',operationId:randomUUID()})});f.writes.length=0;
  await f.tick(5000);await f.settle(()=>f.d.querySelector('.automatic-review-dialog [role=alert]')?.textContent?.includes('设置已变化')===true,'remote revision in open review');
  assert.deepEqual([...f.d.querySelectorAll<HTMLInputElement>('.automatic-source-options input')].map(value=>value.checked),selected,'the owner draft is not silently replaced by remote scope');const submit=f.d.querySelector<HTMLButtonElement>('.automatic-review-dialog footer .primary')!;assert.equal(submit.disabled,true);await act(async()=>submit.click());assert.equal(f.writes.length,0);assert.equal(f.node.modelAuthorization.view().state,'stopped');assert.deepEqual(f.node.modelAuthorization.view().scope,grant.scope);
 }finally{f.restoreClock();}
});

for(const status of [403,503])test('automatic foreground '+status+' cannot leave a confirmable stale review or claim success',async t=>{
 const f=await automaticClockFixture(t);
 try{
  await f.render();await f.settle(f.ready,'initial automatic dependencies');await click(f.d,'开启自动处理');await f.settle(()=>!!f.d.querySelector<HTMLButtonElement>('.automatic-review-dialog footer .primary')&&!f.d.querySelector<HTMLButtonElement>('.automatic-review-dialog footer .primary')!.disabled,'initial review');
  f.hold((path)=>{if(path==='/api/model-authorization')throw new ApiError('Generated authority response unavailable',status);});
  await f.visibility(true);await f.visibility(false);await f.tick();await f.settle(()=>!resources(f.api).get(automaticKeys[0]).getSnapshot().loading,'foreground authority response');
  if(status===403)assert.equal(Boolean(f.d.querySelector('.automatic-review-dialog')),false,'withdrawal closes the former source-scope review');
  else assert.equal(f.d.querySelector<HTMLButtonElement>('.automatic-review-dialog footer .primary')!.disabled,true,'a provider outage cannot confirm the stale grant');
  assert.equal(f.d.querySelector<HTMLButtonElement>('.automatic-control-main button')!.disabled,true);assert.equal(f.writes.length,0);assert.equal(f.node.modelAuthorization.view().state,'unapproved');assert.doesNotMatch(f.d.body.textContent!,/已保存后续任务的授权范围/);
  if(status===503){
   let release!:(value:any)=>void,held:any;f.hold((path,value)=>{if(path===automaticKeys[0]){held=value;return new Promise(resolve=>release=resolve);}});
   await f.visibility(true);await f.visibility(false);await f.tick();assert.ok(release,'outage recovery starts a real fresh authority read');assert.equal(f.d.querySelector<HTMLButtonElement>('.automatic-review-dialog footer .primary')!.disabled,true,'clearing the old error while a recovery read is held is not success');
   f.hold(undefined);await act(async()=>release(held));await f.settle(()=>freshAutomaticReview(f.d),'authoritative recovery completed');assert.equal(f.writes.length,0);assert.equal(f.node.modelAuthorization.view().state,'unapproved');
  }
 }finally{f.restoreClock();}
});

test('foreground hints coalesce behind a held authority HTTP response without aborting it or missing a remote pause',async t=>{
 const f=await automaticClockFixture(t);
 try{
  await f.render();await f.settle(f.ready,'initial automatic dependencies');await f.authorize();
  let release!:(value:any)=>void,held:any,signal:AbortSignal|null|undefined;f.hold((path,value,init)=>{if(path===automaticKeys[0]){held=value;signal=init?.signal;return new Promise(resolve=>release=resolve);}});
  await f.tick(5000);await f.settle(()=>!!release,'held actual authority response');const reads=f.count(automaticKeys[0]);
  const current=f.node.modelAuthorization.view();await f.call(automaticKeys[0]+'/commands',{method:'POST',body:JSON.stringify({revision:current.revision,action:'pause',operationId:randomUUID()})});f.hold(undefined);
  await f.visibility(true);await f.visibility(false);await f.visibility(false);assert.equal(f.count(automaticKeys[0]),reads,'foreground does not replace the held read');assert.equal(signal?.aborted,false);
  await act(async()=>release(held));await f.tick();await f.settle(()=>!resources(f.api).get(automaticKeys[0]).getSnapshot().loading,'coalesced authority followup');assert.equal(f.count(automaticKeys[0]),reads+1,'one actual followup follows the held read');assert.equal(f.d.querySelector('.automatic-control-main button')?.textContent,'恢复自动处理');
 }finally{f.restoreClock();}
});

test('a late previous Api dependency cannot publish after owner replacement or receive its foreground reads',async t=>{
 const f=await automaticClockFixture(t);
 try{
  let release!:(value:any)=>void,held:any;f.hold((path,value)=>{if(path==='/api/model-settings'){held=value;return new Promise(resolve=>release=resolve);}});await f.render();await f.settle(()=>!!release,'old owner model HTTP held');
  const nextReads:string[]=[],next={request:async(path:string,init?:RequestInit)=>{nextReads.push(path);return f.call(path,init);}} as Api;
  await f.render(next);await f.settle(f.ready,'new Api dependencies');const oldReads=f.reads.length;
  await f.visibility(true);await f.visibility(false);await f.tick();await f.settle(()=>automaticKeys.every(path=>!resources(next).get(path).getSnapshot().loading),'current Api foreground');
  automaticKeys.forEach(path=>assert.equal(nextReads.filter(value=>value===path).length,2,path));assert.equal(f.reads.length,oldReads,'old Api receives no foreground GET');
  await act(async()=>release(held));await f.tick();assert.equal(f.ready(),true);assert.equal(f.writes.length,0);assert.equal(Boolean(f.d.querySelector('.automatic-review-dialog')),false);assert.doesNotMatch(f.d.body.textContent!,/已保存后续任务的授权范围/);
 }finally{f.restoreClock();}
});
