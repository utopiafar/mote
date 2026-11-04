import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {ApiError,type Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';
import {AutomaticProcessing} from '../src/plugins/models-processing/AutomaticProcessing.js';
import {createApi} from '../src/api.js';
import {buildApp} from '../../server/src/app.js';
import {defaultModelSettings} from '../../server/src/model-settings.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
configureLocale(()=>'zh-CN');
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
const {createRoot}=await import('react-dom/client');
const {ModelAuthorizationSettings}=await import('../src/plugins/models-processing/ModelAuthorizationSettings.js');
const path='/api/model-authorization',connection={id:'profile:fixture:generated-model',fingerprint:'a'.repeat(64)};
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
async function setup(t:any){
 let state={revision:0,state:'unapproved',connections:[] as typeof connection[],scope:{sourceIds:[] as string[]|null,dataKinds:[] as string[]}},fail=false,offline=false;
 const writes:any[]=[];
 const api={request:async(url:string,init?:RequestInit)=>{
  if(offline)throw Error('generated offline');
  if(url==='/api/model-settings')return {profiles:[{id:'fixture',name:'Generated provider'}]};
  if(url==='/api/file-processing')return {policy:{services:[]},processors:[]};
  if(url==='/api/sources')return {items:[{id:'fixture-source',name:'Generated source'}]};
  if(url==='/api/devices')return {items:[]};
  if(init?.method==='POST'){
   const body=JSON.parse(String(init.body));writes.push(body);if(fail)throw Error('generated uncertain write');
   state={...state,revision:state.revision+1,state:body.action==='authorize'?'enabled':body.action==='pause'?'paused':'stopped',...(body.action==='authorize'?{connections:body.connections,scope:body.scope}:{})};return structuredClone(state);
  }
  return {authorization:structuredClone(state),connections:[connection]};
 }} as unknown as Api;
 const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);
 const render=async(current=api)=>{await act(async()=>{root.render(React.createElement(ModelAuthorizationSettings,{api:current}));await tick();});};
 await render();t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 return {api,container,writes,render,set fail(value:boolean){fail=value;},set offline(value:boolean){offline=value;}};
}
const button=(c:HTMLElement,label:string)=>[...c.querySelectorAll('button')].find(b=>b.textContent===label)!;
async function click(c:HTMLElement,label:string){await act(async()=>{button(c,label).click();await tick();});}
async function check(c:HTMLElement,label:string){await act(async()=>{const input=[...c.querySelectorAll('label')].find(x=>x.textContent===label)?.querySelector('input');assert.ok(input,label);input.click();await tick();});}
async function select(c:HTMLElement){for(const text of ['Generated provider · generated-model','Generated source','文字','我已核对数据范围、模型服务与可能产生的费用'])await check(c,text);}

test('approval requires explicit model, source, representation and cost consent; pause and stop remain distinct',async t=>{
 const f=await setup(t);assert.equal(f.writes.length,0);assert.equal(button(f.container,'授权后续后台处理').disabled,true);
 await select(f.container);await click(f.container,'授权后续后台处理');
 assert.equal(f.writes.length,1);assert.deepEqual(f.writes[0].connections,[connection]);assert.deepEqual(f.writes[0].scope,{sourceIds:['fixture-source'],dataKinds:['text']});
 await click(f.container,'暂停新任务');assert.equal(f.writes.at(-1).action,'pause');assert.equal('scope' in f.writes.at(-1),false);assert.match(f.container.textContent!,/已受理任务继续完成/);
 await click(f.container,'立即停止并撤销自动任务');assert.equal(f.writes.at(-1).action,'stop');assert.match(f.container.textContent!,/已撤销在途自动任务/);
});

test('uncertain save retries reuse the operation, refresh and offline errors retain the draft without claiming success',async t=>{
 const f=await setup(t);await select(f.container);f.fail=true;await click(f.container,'授权后续后台处理');
 assert.match(f.container.textContent!,/generated uncertain write/);assert.equal(f.writes.length,1);
 await act(async()=>{resources(f.api).invalidate(k=>k===path);await tick();});
 assert.equal(button(f.container,'授权后续后台处理').disabled,false);
 f.fail=false;await click(f.container,'授权后续后台处理');assert.equal(f.writes[0].operationId,f.writes[1].operationId);
 await check(f.container,'音频原件');f.offline=true;await act(async()=>{resources(f.api).invalidate(k=>k===path);await tick();});
 assert.match(f.container.textContent!,/generated offline/);assert.equal(button(f.container,'授权后续后台处理').disabled,true);
 assert.equal([...f.container.querySelectorAll('label')].find(x=>x.textContent==='音频原件')!.querySelector('input')!.checked,true);
});

test('cancel draft never sends authority and switching owner clears the previous selection',async t=>{
 const f=await setup(t);await select(f.container);await click(f.container,'重新读取并还原草稿');assert.equal(f.writes.length,0);assert.equal(button(f.container,'授权后续后台处理').disabled,true);
 await select(f.container);
 const other={request:async(url:string)=>url===path?{authorization:{revision:8,state:'unapproved',connections:[],scope:{sourceIds:[],dataKinds:[]}},connections:[]}:url==='/api/model-settings'?{profiles:[]}:{items:[]}} as unknown as Api;
 await f.render(other);assert.doesNotMatch(f.container.textContent!,/Generated provider/);assert.match(f.container.textContent!,/请先配置模型连接/);assert.equal(f.writes.length,0);
});

const authorityKeys=[path,'/api/model-settings','/api/file-processing','/api/sources','/api/devices'];
type WireRead={path:string;method:string;owner:'current'|'replacement';signal?:AbortSignal|null;status:number;delivered:number;body?:any};
async function httpAuthorityFixture(t:import('node:test').TestContext){
 const local=new JSDOM('<div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:local.window,document:local.window.document,HTMLElement:local.window.HTMLElement,localStorage:local.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const root=createRoot(local.window.document.getElementById('root')!),container=local.window.document.getElementById('root')!;
 const directory=mkdtempSync(join(tmpdir(),'mote-authorization-ui-')),token='generated-model-authorization-owner-1234567890';
 let node:Awaited<ReturnType<typeof buildApp>>|undefined,clock=false,restoreFetch=()=>{};
 t.after(async()=>{if(clock)t.mock.timers.reset();await act(async()=>root.unmount());restoreFetch();try{await node?.app.close();}finally{rmSync(directory,{recursive:true,force:true});local.window.close();for(const [key,value] of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}}});
 node=await buildApp({dataDir:directory,token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:3_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false});
 const direct=async(url:string,init:RequestInit={})=>{const response=await node!.app.inject({url,method:(init.method??'GET') as 'GET'|'PUT'|'POST',headers:{authorization:'Bearer '+token,'accept-language':'zh-CN',...(init.body?{'content-type':'application/json'}:{})},...(init.body?{payload:String(init.body)}:{})});assert.equal(response.statusCode,200,'generated remote request '+url);return response.json();};
 const generatedSettings={...defaultModelSettings(),baseUrl:'https://generated.invalid/v1',model:'generated-authority-model',apiKey:'generated-model-key'};
 const initial=await direct('/api/model-settings');await direct('/api/model-settings',{method:'PUT',body:JSON.stringify({revision:initial.revision,settings:generatedSettings})});
 const available=(await direct(path)).connections as {id:string;fingerprint:string}[];
 const modelConnection=available.find(value=>value.id.endsWith(':generated-authority-model'))!;assert.ok(modelConnection,'the generated production provider is configured');
 const settings=await direct('/api/model-settings'),profile=settings.profiles.find((value:any)=>modelConnection.id.startsWith('profile:'+value.id+':'));
 const providerTitle=profile.name+' · generated-authority-model',reads:WireRead[]=[],writes:WireRead[]=[];
 let fault:403|503|undefined,lostAck=false,hold:((read:WireRead,response:Response)=>Promise<Response>|undefined)|undefined,hidden=false;
 Object.defineProperty(local.window.document,'hidden',{get:()=>hidden,configurable:true});
 const mock=t.mock.method(globalThis,'fetch',async(input:any,init:RequestInit={})=>{
  const url=String(input);assert.ok(url.startsWith('/api/'),'the generated transport never calls an external provider');
  const record:WireRead={path:url,method:(init.method??'GET').toUpperCase(),owner:new Headers(init.headers).get('authorization')==='Bearer '+token?'current':'replacement',signal:init.signal,status:0,delivered:0,...(init.body?{body:JSON.parse(String(init.body))}:{})};
  (record.method==='GET'?reads:writes).push(record);
  const wire=await node!.app.inject({url,method:record.method as 'GET'|'PUT'|'POST',headers:Object.fromEntries(new Headers(init.headers)),...(init.body?{payload:String(init.body)}:{})});record.status=wire.statusCode;
  let response=new Response(wire.body,{status:wire.statusCode,headers:{'content-type':'application/json'}});
  if(record.owner==='current'&&url===path&&record.method==='GET'&&fault)response=new Response(JSON.stringify({error:'generated_unavailable'}),{status:fault,headers:{'content-type':'application/json'}});
  if(lostAck&&url===path+'/commands'&&record.method==='POST'&&response.ok){lostAck=false;response=new Response(JSON.stringify({error:'generated_ack_lost'}),{status:503,headers:{'content-type':'application/json'}});}
  record.delivered=response.status;return hold?.(record,response)??response;
 });restoreFetch=()=>mock.mock.restore();
 const api=createApi({token}),replacement=createApi({token:'generated-replacement-denied-1234567890'});
 t.mock.timers.enable({apis:['setTimeout']});clock=true;
 const advance=async(ms=0)=>act(async()=>{t.mock.timers.tick(ms);await new Promise<void>(resolve=>setImmediate(resolve));});
 const settle=async(check:()=>boolean,label:string)=>{const deadline=Date.now()+15000;while(Date.now()<deadline){if(check())return;await advance();}throw Error('Timed out '+label);};
 const settled=(owner=api)=>authorityKeys.every(key=>!resources(owner).get(key).getSnapshot().loading);
 const render=async(owner=api,copies=1)=>{await act(async()=>root.render(React.createElement(React.Fragment,null,...Array.from({length:copies},(_,key)=>React.createElement(ModelAuthorizationSettings,{api:owner,key})))));await advance();};
 const visibility=async(value:boolean)=>{hidden=value;await act(async()=>local.window.document.dispatchEvent(new local.window.Event('visibilitychange')));};
 const count=(key:string,owner:WireRead['owner']='current')=>reads.filter(read=>read.path===key&&read.owner===owner).length;
 const toggle=async(label:string)=>{const input=[...container.querySelectorAll('label')].find(value=>value.textContent?.trim()===label)?.querySelector('input');assert.ok(input,label);await act(async()=>input.click());await advance();};
 const press=async(label:string)=>{assert.ok(button(container,label),label);await act(async()=>button(container,label).click());await advance();};
 const checked=(label:string)=>[...container.querySelectorAll('label')].find(value=>value.textContent?.trim()===label)?.querySelector('input')?.checked;
 const choose=async()=>{for(const label of [providerTitle,'已提交对话','文字','我已核对数据范围、模型服务与可能产生的费用'])await toggle(label);};
 const remote=async(action:'authorize'|'pause'|'stop',scope={sourceIds:['mote.conversations'] as string[]|null,dataKinds:['text']})=>{const current=(await direct(path)).authorization;return direct(path+'/commands',{method:'POST',body:JSON.stringify({revision:current.revision,operationId:randomUUID(),action,...(action==='authorize'?{connections:[modelConnection],scope}:{})})});};
 return {api,replacement,node,container,root,reads,writes,direct,generatedSettings,modelConnection,providerTitle,advance,settle,settled,render,visibility,count,toggle,press,checked,choose,remote,fault:(value:typeof fault)=>fault=value,hold:(value:typeof hold)=>hold=value,loseAck:()=>lostAck=true};
}

test('two real authorization components share initial and foreground reads, preserve visible 5s and stop hidden timer GETs for 60s',async t=>{
 const f=await httpAuthorityFixture(t);await f.render(f.api,2);await f.settle(()=>f.settled()&&f.container.querySelectorAll('form').length===2,'two current authorization forms');
 authorityKeys.forEach(key=>assert.equal(f.count(key),1,key));assert.equal(f.count('/api/perception'),0,'authorization does not add an unrelated processing dependency');
 const unrelated='/api/sources?generated=unrelated',resource=resources(f.api).get(unrelated),unsubscribe=resource.subscribe(()=>{});t.after(unsubscribe);await f.settle(()=>!resource.getSnapshot().loading,'unrelated observed query');
 await f.advance(4999);assert.equal(f.count(path),1);await f.advance(1);await f.settle(f.settled,'visible authorization fallback');assert.equal(f.count(path),2);
 const before=authorityKeys.map(key=>f.count(key));await f.visibility(true);for(let i=0;i<12;i++)await f.advance(5000);assert.deepEqual(authorityKeys.map(key=>f.count(key)),before,'60s hidden starts no timer resource GET');
 await f.visibility(false);await f.visibility(false);await f.advance();await f.settle(f.settled,'foreground resources');assert.deepEqual(authorityKeys.map(key=>f.count(key)),before.map(value=>value+1),'both components and duplicate visible events merge one read per exact resource');assert.equal(f.count(unrelated),1);
 await f.advance(4999);assert.equal(f.count(path),before[0]+1);await f.advance(1);assert.equal(f.count(path),before[0]+2,'visible fallback remains five seconds');
});

test('the actual automatic-processing parent and nested authorization share one foreground read per dependency',async t=>{
 const f=await httpAuthorityFixture(t),keys=[...authorityKeys,'/api/perception'];
 await act(async()=>f.root.render(React.createElement(AutomaticProcessing,{api:f.api})));await f.advance();await f.settle(()=>keys.every(key=>!resources(f.api).get(key).getSnapshot().loading)&&Boolean(f.container.querySelector('.automatic-control-main button:not([disabled])')),'actual parent and child ready');
 assert.equal(f.container.querySelectorAll('.model-authorization-settings').length,1);keys.forEach(key=>assert.equal(f.count(key),1,key));const before=keys.map(key=>f.count(key));
 await f.visibility(true);await f.visibility(false);await f.visibility(false);await f.advance();await f.settle(()=>keys.every(key=>!resources(f.api).get(key).getSnapshot().loading),'actual composition foreground');
 assert.deepEqual(keys.map(key=>f.count(key)),before.map(value=>value+1),'parent-only perception proves the parent listener runs while shared resources coalesce with the nested listener');assert.equal(f.writes.length,0);assert.equal(Boolean(f.container.querySelector('.automatic-review-dialog')),false);assert.equal(f.node!.modelAuthorization.view().state,'unapproved');
});

test('a clean foreground authorization form adopts the actual remote scope and revision without adding cost consent',async t=>{
 const f=await httpAuthorityFixture(t);await f.remote('authorize');await f.render();await f.settle(()=>f.settled()&&Boolean(f.container.querySelector('form')),'initial saved authority');
 assert.equal(f.checked('已提交对话'),true);assert.equal(f.checked('文字'),true);assert.equal(f.checked('我已核对数据范围、模型服务与可能产生的费用'),false);
 const scope={sourceIds:null,dataKinds:['text','audio']},remote=await f.remote('authorize',scope);await f.visibility(true);await f.visibility(false);await f.advance();await f.settle(f.settled,'remote scope foreground');
 assert.equal(f.checked('所有来源（包括之后新增的来源）'),true);assert.equal(f.checked('音频原件'),true);assert.equal(f.checked('我已核对数据范围、模型服务与可能产生的费用'),false);assert.equal(f.writes.length,0,'reading another window never approves it again');assert.equal(button(f.container,'授权后续后台处理').disabled,true);
 await f.toggle('我已核对数据范围、模型服务与可能产生的费用');await f.press('授权后续后台处理');await f.settle(()=>f.writes.length===1&&f.writes[0].status===200&&f.container.textContent!.includes('已保存后续任务的授权范围'),'explicit current-revision approval');assert.equal(f.writes[0].body.revision,remote.revision);assert.deepEqual(f.writes[0].body.scope,remote.scope);assert.equal(f.checked('我已核对数据范围、模型服务与可能产生的费用'),false);
});

test('a dirty consent-bound draft keeps its original revision for a real CAS rejection and requires explicit restore',async t=>{
 const f=await httpAuthorityFixture(t);await f.render();await f.settle(()=>f.settled()&&Boolean(f.container.querySelector('form')),'initial authority');const original=(await f.direct(path)).authorization;await f.choose();
 const scope={sourceIds:null,dataKinds:['image']},remote=await f.remote('authorize',scope);await f.advance(5000);await f.settle(()=>f.settled()&&f.container.textContent!.includes('已启用'),'remote revision on visible fallback');
 assert.equal(f.checked('已提交对话'),true);assert.equal(f.checked('文字'),true);assert.equal(f.checked('图片原件'),false);assert.equal(f.checked('我已核对数据范围、模型服务与可能产生的费用'),true,'the old draft consent is not silently applied to the remote scope');
 await f.press('授权后续后台处理');await f.settle(()=>f.writes.length===1&&f.writes[0].status===409&&Boolean(f.container.querySelector('[role=alert]')),'actual HTTP CAS rejection');assert.equal(f.writes[0].body.revision,original.revision);assert.deepEqual(f.writes[0].body.scope,{sourceIds:['mote.conversations'],dataKinds:['text']});assert.equal(f.node!.modelAuthorization.view().revision,remote.revision);assert.deepEqual(f.node!.modelAuthorization.view().scope,scope);assert.doesNotMatch(f.container.textContent!,/已保存后续任务的授权范围/);
 await f.press('重新读取并还原草稿');await f.settle(()=>f.settled()&&Boolean(f.container.querySelector('form')),'explicit restore');assert.equal(f.checked('所有来源（包括之后新增的来源）'),true);assert.equal(f.checked('图片原件'),true);assert.equal(f.checked('文字'),false);assert.equal(f.checked('我已核对数据范围、模型服务与可能产生的费用'),false);assert.equal(button(f.container,'授权后续后台处理').disabled,true);assert.equal(f.writes.length,1);
});

test('foreground discovers a real replacement provider while preserving the old grant and blocking its unavailable selection',async t=>{
 const f=await httpAuthorityFixture(t);await f.remote('authorize');await f.render();await f.settle(()=>f.settled()&&Boolean(f.container.querySelector('form')),'initial saved grant');const grant=structuredClone(f.node!.modelAuthorization.view());
 const settings=await f.direct('/api/model-settings');await f.direct('/api/model-settings',{method:'PUT',body:JSON.stringify({revision:settings.revision,settings:{...f.generatedSettings,baseUrl:'https://generated.invalid/replacement-v1',model:'generated-replacement-model'}})});
 await f.visibility(true);await f.visibility(false);await f.advance();await f.settle(f.settled,'replacement provider foreground');assert.match(f.container.textContent!,/原授权模型已更改或不可用/);assert.match(f.container.textContent!,/generated-replacement-model/);assert.equal(f.checked(f.providerTitle),undefined,'the former selection is explicitly marked unavailable instead of relabeled as the new provider');assert.equal(button(f.container,'授权后续后台处理').disabled,true);assert.equal(f.writes.length,0);assert.deepEqual(f.node!.modelAuthorization.view().connections,grant.connections);
});

test('foreground HTTP 403 removes the dirty authorization draft and recovery starts without former consent',async t=>{
 const f=await httpAuthorityFixture(t);await f.render();await f.settle(()=>f.settled()&&Boolean(f.container.querySelector('form')),'initial authority');await f.choose();f.fault(403);
 await f.visibility(true);await f.visibility(false);await f.advance();await f.settle(f.settled,'withdrawn authority');assert.equal(Boolean(f.container.querySelector('form')),false);assert.equal(f.checked('我已核对数据范围、模型服务与可能产生的费用'),undefined);assert.equal(f.writes.length,0);assert.equal(f.node!.modelAuthorization.view().state,'unapproved');
 f.fault(undefined);await f.visibility(true);await f.visibility(false);await f.advance();await f.settle(()=>f.settled()&&Boolean(f.container.querySelector('form')),'authorization read restored');assert.equal(f.checked(f.providerTitle),false);assert.equal(f.checked('文字'),false);assert.equal(f.checked('我已核对数据范围、模型服务与可能产生的费用'),false);assert.equal(button(f.container,'授权后续后台处理').disabled,true);assert.equal(f.writes.length,0);
});

test('a foreground 503 retains the draft but a held recovery response cannot falsely unlock authorization',async t=>{
 const f=await httpAuthorityFixture(t);await f.render();await f.settle(()=>f.settled()&&Boolean(f.container.querySelector('form')),'initial authority');await f.choose();f.fault(503);
 await f.visibility(true);await f.visibility(false);await f.advance();await f.settle(f.settled,'authority unavailable');assert.ok(f.container.querySelector('[role=alert]'));assert.equal(button(f.container,'授权后续后台处理').disabled,true);assert.equal(f.checked('文字'),true);assert.equal(f.checked('我已核对数据范围、模型服务与可能产生的费用'),true);assert.doesNotMatch(f.container.textContent!,/已保存后续任务的授权范围/);
 let release!:(response:Response)=>void,response!:Response;f.fault(undefined);f.hold((read,value)=>{if(read.path===path){response=value;return new Promise(resolve=>release=resolve);}});await f.visibility(true);await f.visibility(false);await f.advance();await f.settle(()=>Boolean(release),'held actual recovery HTTP');assert.equal(button(f.container,'授权后续后台处理').disabled,true,'starting a recovery GET is not a successful authority check');
 f.hold(undefined);await act(async()=>release(response));await f.settle(()=>f.settled()&&!button(f.container,'授权后续后台处理').disabled,'recovery confirmed');assert.equal(f.checked('文字'),true);assert.equal(f.writes.length,0);assert.equal(f.node!.modelAuthorization.view().state,'unapproved');
});

test('an actual committed authorization with a lost HTTP ACK retries the same operation after a newer revision read',async t=>{
 const f=await httpAuthorityFixture(t);await f.render();await f.settle(()=>f.settled()&&Boolean(f.container.querySelector('form')),'initial authority');await f.choose();f.loseAck();await f.press('授权后续后台处理');
 await f.settle(()=>f.writes.length===1&&f.writes[0].delivered===503&&Boolean(f.container.querySelector('[role=alert]'))&&f.settled(),'lost actual command ACK');const grant=structuredClone(f.node!.modelAuthorization.view());assert.equal(grant.state,'enabled');assert.equal(f.writes[0].status,200);assert.equal(button(f.container,'授权后续后台处理').disabled,false);assert.doesNotMatch(f.container.textContent!,/已保存后续任务的授权范围/);
 await f.press('授权后续后台处理');await f.settle(()=>f.writes.length===2&&f.container.textContent!.includes('已保存后续任务的授权范围'),'same operation acknowledged');assert.deepEqual(f.writes[1].body,f.writes[0].body);assert.deepEqual(f.node!.modelAuthorization.view(),grant);assert.equal(f.checked('我已核对数据范围、模型服务与可能产生的费用'),false);
});

test('visible authority remains a five-second fallback after real remote pause and stop',async t=>{
 const f=await httpAuthorityFixture(t);await f.remote('authorize');await f.render();await f.settle(()=>f.settled()&&Boolean(f.container.querySelector('form')),'initial saved authority');
 for(const [action,label] of [['pause','已暂停新任务'],['stop','已停止并撤销自动任务']] as const){const reads=f.count(path);await f.remote(action);await f.advance(4999);assert.equal(f.count(path),reads);await f.advance(1);await f.settle(()=>f.settled()&&[...f.container.querySelectorAll('[role=status]')].some(value=>value.textContent===label),'remote '+action);assert.equal(f.count(path),reads+1);}
 const reads=f.count(path);await f.advance(5000);assert.equal(f.count(path),reads+1,'stopped authority is not a complete task signal and still revalidates');authorityKeys.filter(key=>key!==path).forEach(key=>assert.equal(f.count(key),1,key));assert.equal(f.writes.length,0);
});

test('a held previous Api authority cannot republish its private grant or consume the replacement foreground checks',async t=>{
 const f=await httpAuthorityFixture(t);const grant=await f.remote('authorize');let release!:(response:Response)=>void,response!:Response,signal:AbortSignal|null|undefined;
 f.hold((read,value)=>{if(read.path===path&&read.owner==='current'){response=value;signal=read.signal;return new Promise(resolve=>release=resolve);}});await f.render();await f.settle(()=>Boolean(release),'old Api authority HTTP held');
 await f.render(f.replacement);await f.settle(()=>f.settled(f.replacement),'replacement denied');assert.equal(signal?.aborted,true);assert.equal(Boolean(f.container.querySelector('form')),false);
 f.hold(undefined);await act(async()=>release(response));await f.advance();assert.equal(Boolean(f.container.querySelector('form')),false,'the late old response cannot restore its draft or consent');assert.equal(f.writes.length,0);assert.deepEqual(f.node!.modelAuthorization.view().scope,grant.scope);
 const old=f.reads.filter(value=>value.owner==='current').length,before=authorityKeys.map(key=>f.count(key,'replacement'));await f.visibility(true);await f.visibility(false);await f.advance();await f.settle(()=>f.settled(f.replacement),'current Api foreground denied');assert.deepEqual(authorityKeys.map(key=>f.count(key,'replacement')),before.map(value=>value+1));assert.equal(f.reads.filter(value=>value.owner==='current').length,old);
});
