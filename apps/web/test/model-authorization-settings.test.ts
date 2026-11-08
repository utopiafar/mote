import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {createApi} from '../src/api.js';
import {buildApp} from '../../server/src/app.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
configureLocale(()=>'zh-CN');
const path='/api/model-authorization';
type Wire={path:string;method:string;body:any;status:number};
const switchOf=(container:HTMLElement)=>container.querySelector<HTMLButtonElement>('.automatic-control-main [role=switch]');
const actionButton=(container:HTMLElement,label:string)=>[...container.querySelectorAll<HTMLButtonElement>('button')].find(value=>value.textContent===label);
const sourceInput=(container:HTMLElement,name:string)=>[...container.querySelectorAll<HTMLLabelElement>('.automatic-source-options label')].find(value=>value.textContent?.startsWith(name))?.querySelector<HTMLInputElement>('input');

async function fixture(t:import('node:test').TestContext){
 const local=new JSDOM('<div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:local.window,document:local.window.document,HTMLElement:local.window.HTMLElement,localStorage:local.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const {createRoot}=await import('react-dom/client'),root=createRoot(local.window.document.getElementById('root')!),container=local.window.document.getElementById('root')!;
 const directory=mkdtempSync(join(tmpdir(),'mote-authorization-switch-')),token='generated-model-authorization-switch-owner-1234567890';
 let node:Awaited<ReturnType<typeof buildApp>>|undefined,restoreFetch=()=>{};
 t.after(async()=>{t.mock.timers.reset();await act(async()=>root.unmount());restoreFetch();try{await node?.app.close();}finally{rmSync(directory,{recursive:true,force:true});local.window.close();for(const [key,value] of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}}});
 node=await buildApp({dataDir:directory,token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:3_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false});
 node.sources.register({id:'generated-source',name:'Generated source',kind:'custom',deviceId:'generated-import',platform:'import'});
 node.sources.register({id:'generated-other',name:'Generated other source',kind:'custom',deviceId:'generated-import',platform:'import'});
 const direct=async(url:string,init:RequestInit={})=>{const response=await node!.app.inject({url,method:(init.method??'GET') as 'GET'|'POST',headers:{authorization:'Bearer '+token,...(init.body?{'content-type':'application/json'}:{})},...(init.body?{payload:String(init.body)}:{})});assert.ok(response.statusCode<400,'generated remote request '+url+' '+response.body);return response.json();};
 const reads:Wire[]=[],writes:Wire[]=[];let hold=false,release:(()=>void)|undefined;
 const mock=t.mock.method(globalThis,'fetch',async(input:any,init:RequestInit={})=>{
  const url=String(input),record:Wire={path:url,method:(init.method??'GET').toUpperCase(),body:init.body?JSON.parse(String(init.body)):undefined,status:0};
  (record.method==='GET'?reads:writes).push(record);
  if(hold&&url===path+'/commands')await new Promise<void>(resolve=>release=resolve);
  const wire=await node!.app.inject({url,method:record.method as 'GET'|'POST',headers:Object.fromEntries(new Headers(init.headers)),...(init.body?{payload:String(init.body)}:{})});
  record.status=wire.statusCode;
  return new Response(wire.body,{status:wire.statusCode,headers:{'content-type':'application/json'}});
 });
 restoreFetch=()=>mock.mock.restore();
 const api=createApi({token});
 t.mock.timers.enable({apis:['setTimeout']});
 const advance=async(ms=0)=>act(async()=>{t.mock.timers.tick(ms);await new Promise<void>(resolve=>setImmediate(resolve));});
 const settle=async(check:()=>boolean,label:string)=>{const deadline=Date.now()+15000;while(Date.now()<deadline){if(check())return;await advance();}throw Error('Timed out '+label);};
 const render=async()=>{await act(async()=>root.render(React.createElement(AutomaticProcessing,{api})));await advance();await settle(()=>Boolean(node!.modelAuthorization)&&Boolean(switchOf(container)),'authorization switch');};
 const clickSwitch=async()=>{assert.ok(switchOf(container),'switch');await act(async()=>switchOf(container)!.click());await advance();};
 const click=async(label:string)=>{const target=actionButton(container,label);assert.ok(target,label);await act(async()=>target.click());await advance();};
 const {AutomaticProcessing}=await import('../src/plugins/models-processing/AutomaticProcessing.js');
 return {node,container,reads,writes,render,clickSwitch,click,settle,advance,direct,hold:(value:boolean)=>{hold=value;},release:()=>{hold=false;release?.();}};
}

test('A2-01 opening the switch sends one on command with the current revision and reads it back',async t=>{
 const f=await fixture(t);await f.render();
 assert.equal(f.container.querySelectorAll('[role=switch]').length,1);assert.equal(switchOf(f.container)!.getAttribute('aria-checked'),'false');assert.match(f.container.textContent!,/已关闭/);assert.equal(f.writes.length,0);
 assert.ok(f.container.querySelector('.automatic-source-options'));assert.equal(f.container.querySelector('[role=dialog]'),null);assert.doesNotMatch(f.container.textContent!,/授权范围|内容类型|新设置|费用/);assert.equal(f.reads.some(read=>read.path==='/api/model-settings'),false,'model settings no longer gate the one switch');
 await f.clickSwitch();await f.settle(()=>f.writes.length===1&&switchOf(f.container)!.getAttribute('aria-checked')==='true','on receipt');
 const body=f.writes[0].body;assert.deepEqual(Object.keys(body).sort(),['action','operationId','revision']);assert.equal(body.action,'on');assert.equal(body.revision,0);assert.match(body.operationId,/^[0-9a-f-]{36}$/);
 assert.equal(f.node.modelAuthorization.view().state,'on');assert.equal((await f.direct(path)).authorization.state,'on');
 assert.ok(f.reads.some(read=>read.path===path&&read.method==='GET'&&read.status===200),'the component re-reads the confirmed state');
});

test('A2-02 closing the switch sends one off command and shows off',async t=>{
 const f=await fixture(t);f.node.modelAuthorization.command({revision:0,operationId:randomUUID(),action:'on'});await f.render();
 assert.equal(switchOf(f.container)!.getAttribute('aria-checked'),'true');
 await f.clickSwitch();await f.settle(()=>f.writes.length===1&&switchOf(f.container)!.getAttribute('aria-checked')==='false','off receipt');
 assert.deepEqual(Object.keys(f.writes[0].body).sort(),['action','operationId','revision']);assert.equal(f.writes[0].body.action,'off');assert.equal(f.node.modelAuthorization.view().state,'off');
});

test('A2-03 a held command cannot be sent twice by a second switch click',async t=>{
 const f=await fixture(t);await f.render();f.hold(true);
 await act(async()=>{const control=switchOf(f.container)!;control.click();control.click();});await f.advance();
 await f.settle(()=>f.writes.length===1,'held command');
 assert.equal(f.writes.length,1,'only one command leaves the page');f.release();await f.settle(()=>switchOf(f.container)!.getAttribute('aria-checked')==='true','held command receipt');
 assert.equal(f.writes.length,1);
});

test('A2-04 a stale revision is rejected once, re-read from Central and never automatically resent',async t=>{
 const f=await fixture(t);await f.render();f.node.modelAuthorization.command({revision:0,operationId:randomUUID(),action:'on'});
 await f.clickSwitch();await f.settle(()=>f.writes.length===1&&f.writes[0].status===409&&switchOf(f.container)!.getAttribute('aria-checked')==='true','stale revision recovery');
 assert.equal(f.node.modelAuthorization.view().state,'on');assert.match(f.container.querySelector('[role=alert]')!.textContent!,/操作未完成，请重试/);assert.match(f.container.textContent!,/资料状态已变化或当前配置不支持此操作，请刷新后重试。/);
 assert.equal(f.writes.length,1,'a conflict is not retried automatically');
});

test('A2-05 excluding a source sends the exact exclusion list and re-including sends an empty one',async t=>{
 const f=await fixture(t);await f.render();
 const source=sourceInput(f.container,'Generated source')!;assert.ok(source);assert.equal(source.checked,false);
 await act(async()=>source.click());await f.advance();
 await f.settle(()=>f.writes.length===1&&sourceInput(f.container,'Generated source')!.checked,'source excluded');
 assert.equal(f.writes[0].body.action,'exclude');assert.deepEqual(f.writes[0].body.excludedSourceIds,['generated-source']);assert.deepEqual(Object.keys(f.writes[0].body).sort(),['action','excludedSourceIds','operationId','revision']);
 assert.deepEqual(f.node.modelAuthorization.view().excludedSourceIds,['generated-source']);
 await act(async()=>sourceInput(f.container,'Generated source')!.click());await f.advance();
 await f.settle(()=>f.writes.length===2&&!sourceInput(f.container,'Generated source')!.checked,'source re-included');
 assert.equal(f.writes[1].body.action,'exclude');assert.deepEqual(f.writes[1].body.excludedSourceIds,[]);assert.deepEqual(f.node.modelAuthorization.view().excludedSourceIds,[]);
});

test('A2-06 immediate stop is behind More, asks nothing and sends one stop command',async t=>{
 const f=await fixture(t);await f.render();await f.clickSwitch();await f.settle(()=>switchOf(f.container)!.getAttribute('aria-checked')==='true','switch on');
 assert.equal(f.container.querySelector('[role=dialog]'),null);
 await act(async()=>f.container.querySelector<HTMLElement>('.automatic-control-more summary')!.click());await f.advance();
 assert.equal(f.container.querySelector('[role=dialog]'),null);
 await f.click('立即停止全部自动任务');await f.settle(()=>f.writes.at(-1)?.body.action==='stop'&&switchOf(f.container)!.getAttribute('aria-checked')==='false','stop receipt');
 assert.equal(f.writes.at(-1)!.body.action,'stop');assert.deepEqual(Object.keys(f.writes.at(-1)!.body).sort(),['action','operationId','revision']);assert.equal(f.node.modelAuthorization.view().state,'off');assert.equal(f.container.querySelector('[role=dialog]'),null);
});
