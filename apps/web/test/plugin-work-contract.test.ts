import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {configureLocale} from '@mote/shared/i18n';
import type {ActionProposal} from '@mote/shared';
import {buildApp} from '../../server/src/app.js';
import {authorizeFixtureModels} from '../../server/test/fixtures/model-authorization.js';
import {ApiError,type Api} from '../src/api.js';
import {Actions} from '../src/plugins/work/Actions.js';
import {ActionCapabilitySettings} from '../src/plugins/work/ActionCapabilitySettings.js';

configureLocale(()=> 'zh-CN');

const text='Generated schedule review at 2099-09-18 15:00 to 16:00.';
const deviceId='generated-work-device',calendarId='generated-work-calendar',calendarTitle='Generated work calendar';
const event={title:'Generated schedule',start:'2099-09-18T15:00:00+08:00',end:'2099-09-18T16:00:00+08:00',allDay:false,timeZone:'Asia/Shanghai',location:'Generated room',description:'Generated description'};

interface Recorded {path:string;method:string;body?:string}

function apiFor(node:Awaited<ReturnType<typeof buildApp>>,token:string,intercept?:(call:Recorded)=>Promise<void>|void){
 const calls:Recorded[]=[];
 const request=async<T>(path:string,init:RequestInit={}):Promise<T>=>{
  const method=(init.method??'GET').toUpperCase(),call:Recorded={path,method,...(typeof init.body==='string'?{body:init.body}:{})};
  calls.push(call);
  const response=await node.app.inject({method:method as 'GET'|'POST'|'PUT',url:path,headers:{authorization:'Bearer '+token,...(typeof init.body==='string'?{'content-type':'application/json'}:{})},...(typeof init.body==='string'?{payload:init.body}:{})});
  if(response.statusCode>=400)throw new ApiError(response.body||`HTTP ${response.statusCode}`,response.statusCode);
  await intercept?.(call);
  return (response.body?JSON.parse(response.body):undefined) as T;
 };
 return {api:{request} as Api,calls};
}

async function fixture(t:import('node:test').TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-plugin-work-contract-')),token='generated-plugin-work-'+randomUUID();
 let node:Awaited<ReturnType<typeof buildApp>>;
 node=await buildApp({dataDir:join(directory,'data'),token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture-model',modelBaseUrl:'https://synthetic.invalid',apiKey:'generated',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'},{backgroundWorker:false,agent:{configured:true,query:async input=>{
  const id=input.evidenceIds?.[0];
  if(node.executor.get(input.traceContext?.jobId)?.kind==='context-dag.semantic')return {answer:JSON.stringify({summary:'Generated appointment',evidence:[{id,quote:text}],events:[],memoryCandidates:[],actionCues:[{kind:'calendar.create',event,uncertainty:'',evidence:[{id,quote:text}]}]}),citations:[{id,capturedAt:'2026-11-04T00:00:00Z',appName:'Generated fixture',excerpt:text}],trace:[],runId:randomUUID()};
  return {answer:JSON.stringify({actions:[{kind:'calendar.create',event,uncertainty:'',sameAs:null,evidence:[{id,quote:text}]}]}),citations:[{id,capturedAt:'2026-11-04T00:00:00Z',appName:'Generated fixture',excerpt:text}],trace:[],runId:randomUUID()};
 },close:async()=>{}}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
 await authorizeFixtureModels(node);
 await node.actions.saveSettings({revision:node.configService.revision,authorizationRevision:node.actions.authorizationRevision(),settings:{enabled:true,timeZone:'Asia/Shanghai',reviewDeviceIds:[]}});
 node.sources.register({id:'generated-work-source',kind:'custom',name:'Generated work source',deviceId:'generated-input-device',platform:'import'});
 await node.sources.upsert('generated-work-source',{externalId:'generated-work-1',revision:'1',text,title:'Generated work original',kind:'message',layer:'original',observedAt:'2026-11-04T00:00:00Z'});
 await node.actions.tick();
 const proposal=node.actions.list()[0];
 assert.ok(proposal,'the real action host publishes a validated proposal');
 node.actions.registerTarget({deviceId,deviceName:'Generated Mac',calendars:[{id:calendarId,title:calendarTitle}]});
 return {node,token,proposal};
}

async function ui(t:import('node:test').TestContext,hash:string){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/'+hash,pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,location:dom.window.location,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 dom.window.HTMLElement.prototype.scrollIntoView=()=>{};dom.window.scrollTo=()=>{};const root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 const tick=async()=>{await act(async()=>new Promise(resolve=>setTimeout(resolve,5)));};
 const until=async(check:()=>boolean)=>{const deadline=Date.now()+10000;while(!check()){assert.ok(Date.now()<deadline,'UI did not reach expected state');await tick();}};
 return {root,d:dom.window.document,w:dom.window,tick,until};
}
const button=(d:Document,label:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(item=>item.textContent===label);
const selectTarget=async(d:Document,value:string)=>{const select=d.querySelector<HTMLSelectElement>('.action-dialog select');assert.ok(select);await act(async()=>{select.value=value;select.dispatchEvent(new d.defaultView!.Event('change',{bubbles:true}));});};

test('real action approval preserves the exact proposal, target device and calendar in the work consumer',async t=>{
 const {node,token,proposal}=await fixture(t),{api}=apiFor(node,token),page=await api.request<{items:ActionProposal[];targets:{deviceId:string;deviceName:string;calendars:{id:string;title:string}[]}[]}>('/api/actions?cursor=0');
 assert.deepEqual(page.targets,[{deviceId,deviceName:'Generated Mac',calendars:[{id:calendarId,title:calendarTitle}],updatedAt:page.targets[0]!.updatedAt}]);
 assert.equal(page.items[0]!.id,proposal.id);assert.equal(page.items[0]!.version,proposal.version);assert.equal(page.items[0]!.status,'proposed');
 const approved=await api.request<ActionProposal>('/api/actions/'+proposal.id+'/confirm',{method:'POST',body:JSON.stringify({version:proposal.version,event:proposal.event,target:{deviceId,calendarId}})});
 assert.equal(approved.id,proposal.id);assert.equal(approved.version,proposal.version+1);assert.equal(approved.status,'approved');assert.deepEqual(approved.target,{deviceId,calendarId});assert.match(approved.operationId!,/^[0-9a-f-]{36}$/i);
 const {root,d,until}=await ui(t,'#/actions?action='+proposal.id);
 await act(async()=>root.render(React.createElement(Actions,{api,onOpen:()=>{}})));
 await until(()=>!!d.querySelector('.calendar-final-detail'));
 const detail=d.querySelector('.calendar-final-detail')!.textContent!;
 assert.match(detail,/Generated schedule/);assert.match(detail,/已生效 · 待设备同步/);assert.match(detail,/Generated Mac · Generated work calendar/);
});

test('the work plugin cannot approve a real device whose calendar capability is unavailable',async t=>{
 const {node,token}=await fixture(t),{api}=apiFor(node,token);
 const owner={authorization:'Bearer '+token};
 const invite=await node.app.inject({method:'POST',url:'/api/connections/collector-invitations',headers:owner,payload:{serverUrl:'https://generated.invalid',label:'Generated device'}});
 assert.equal(invite.statusCode,200,invite.body);
 const paired=await node.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invite.json().invitation.code,deviceId:'generated-work-phone',deviceName:'Generated phone',platform:'android'}});
 assert.equal(paired.statusCode,200,paired.body);
 const declaration={operationId:randomUUID(),expectedRevision:0,deviceId:'generated-work-phone',capability:{id:'calendar.manage',version:1},permission:'unavailable',calendars:[]};
 const declared=await node.app.inject({method:'POST',url:'/api/device-action-capabilities',headers:{authorization:'Bearer '+paired.json().token},payload:declaration});
 assert.equal(declared.statusCode,200,declared.body);
 const inventory=await api.request<{declarations:{deviceId:string;permission:string;calendars:{id:string;title:string}[];connectionActive:boolean}[]}>('/api/action-capabilities');
 assert.equal(inventory.declarations[0]!.deviceId,'generated-work-phone');assert.equal(inventory.declarations[0]!.permission,'unavailable');assert.deepEqual(inventory.declarations[0]!.calendars,[]);assert.equal(inventory.declarations[0]!.connectionActive,true);
 const {root,d,until}=await ui(t,'#/actions');
 await act(async()=>root.render(React.createElement(ActionCapabilitySettings,{api})));
 await until(()=>!!d.querySelector('.action-settings select'));
 assert.equal(d.querySelectorAll('.action-settings select option').length,1,'an unavailable declaration contributes no writable calendar');
 assert.match(d.body.textContent!,/暂无已连接的可写日历/);
 assert.equal(button(d,'保存范围草稿')!.disabled,true);assert.equal(button(d,'确认范围授权'),undefined,'no unavailable capability can be approved');
});

test('a lost approval ACK keeps the original operation identity and is never replayed without an explicit review submission',async t=>{
 const {node,token,proposal}=await fixture(t);
 let confirmCalls=0,lose=true;
 const {api,calls}=apiFor(node,token,call=>{
  if(call.path==='/api/actions/'+proposal.id+'/confirm'&&call.method==='POST'){
   confirmCalls++;
   if(lose){lose=false;throw new TypeError('Generated committed approval with lost ACK');}
  }
 });
 const {root,d,until,tick}=await ui(t,'#/actions?action='+proposal.id);
 await act(async()=>root.render(React.createElement(Actions,{api,onOpen:()=>{}})));
 await until(()=>!!d.querySelector('.calendar-final-detail'));
 await act(async()=>{d.querySelector<HTMLDetailsElement>('.action-final-advanced')!.open=true;button(d,'核对并添加')!.click();});
 await until(()=>!!d.querySelector('.action-dialog'));
 await selectTarget(d,JSON.stringify({deviceId,calendarId}));
 await act(async()=>button(d,'确认添加到此日历')!.click());
 await until(()=>!!d.querySelector('[role="alert"]'));
 assert.equal(confirmCalls,1);
 const committed=await api.request<ActionProposal>('/api/actions/'+proposal.id);
 assert.equal(committed.status,'approved');const operationId=committed.operationId;assert.ok(operationId);
 await tick();await new Promise(resolve=>setTimeout(resolve,100));await tick();
 assert.equal(confirmCalls,1,'a lost ACK never triggers an automatic replay');
 await until(()=>button(d,'确认添加到此日历')?.disabled===false);
 await act(async()=>button(d,'确认添加到此日历')!.click());
 await until(()=>!d.querySelector('.action-dialog'));
 const posts=calls.filter(call=>call.path==='/api/actions/'+proposal.id+'/confirm'&&call.method==='POST');
 assert.equal(posts.length,2);assert.equal(posts[1]!.body,posts[0]!.body,'the explicit retry keeps the same reviewed payload');
 const settled=await api.request<ActionProposal>('/api/actions/'+proposal.id);
 assert.equal(settled.operationId,operationId,'the same operation identity is returned, not a new one');
 assert.equal((await api.request<{items:ActionProposal[]}>('/api/actions?cursor=0')).items.filter(item=>item.id===proposal.id).length,1);
 assert.match(d.querySelector('.calendar-final-detail')!.textContent!,/已生效 · 待设备同步/);
});
