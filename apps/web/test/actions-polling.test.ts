import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {Actions} from '../src/plugins/work/Actions.js';
import {ApiError,type Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';
configureLocale(()=> 'zh-CN');
const id='71e38cca-8f55-4f2c-b450-c0dc0dc0dc01';
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(done=>resolve=done);return {promise,resolve};};
const proposal=(patch:any={})=>({id,version:3,kind:'calendar.update',status:'proposed',event:{title:'Generated original schedule',start:'2099-01-01T10:00:00Z',end:'2099-01-01T11:00:00Z',timeZone:'UTC',allDay:false,location:'',description:''},related:{event:{title:'Generated prior',start:null,end:null},target:{deviceId:'generated-device',calendarId:'generated-calendar'}},evidence:[],...patch});
const page=(items:any[]=[],patch:any={})=>({revision:1,authorizationRevision:1,items,total:items.length,nextCursor:null,targets:[],settings:{enabled:true,timeZone:'UTC',reviewDeviceIds:[]},progress:{configured:true,running:false,jobs:[],error:null},...patch});
function client(read:(path:string,init?:RequestInit)=>unknown){
 const calls:{path:string;init?:RequestInit}[]=[],hints:string[]=[];let feedCursor=0;
 const api={request:async(path:string,init?:RequestInit)=>{calls.push({path,init});
  if(path.startsWith('/api/operations/changes?'))return {ids:hints.splice(0),cursor:++feedCursor,reset:false,hasMore:false};
  if(path==='/api/devices')return {items:[]};
  if(path==='/api/action-capabilities')return {providers:[],declarations:[],sources:[],drafts:[],grants:[],deviceCapabilities:[]};
  return read(path,init);
 },setAgentTimeout:()=>{}} as Api;
 return {api,calls,hints,count:(path:string)=>calls.filter(call=>call.path===path&&!call.init?.method).length,feed:()=>calls.filter(call=>call.path.startsWith('/api/operations/changes?')).length};
}
async function fixture(t:any,selected=false){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/actions'+(selected?'?action='+id:''),pretendToBeVisual:true}),w=dom.window,d=w.document;
 let hidden=false;Object.defineProperty(d,'hidden',{get:()=>hidden,configurable:true});w.scrollTo=()=>{};
 const before=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:w,document:d,HTMLElement:w.HTMLElement,localStorage:w.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const root=createRoot(d.getElementById('root')!);t.mock.timers.enable({apis:['setTimeout']});
 t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 const render=async(api:Api)=>act(async()=>{root.render(React.createElement(Actions,{api,onOpen:()=>{}}));await turn();});
 const visibility=async(value:boolean)=>act(async()=>{hidden=value;d.dispatchEvent(new w.Event('visibilitychange'));if(!hidden)w.dispatchEvent(new w.Event('focus'));await turn();});
 const advance=async(ms:number)=>{for(let left=ms;left>0;){const step=Math.min(500,left);await act(async()=>{t.mock.timers.tick(step);await turn();});left-=step;}};
 return {root,d,w,render,visibility,advance};
}
const button=(d:Document,label:string)=>{const found=Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(item=>item.textContent===label);assert.ok(found,label);return found;};

test('Actions keeps list/detail 15s reads, pauses hidden timers for 60s and coalesces foreground visibility/focus',async t=>{
 const {d,w,render,visibility,advance}=await fixture(t,true),remote=client(path=>path.includes('?')?page():proposal());
 await render(remote.api);assert.equal(remote.count('/api/actions?cursor=0'),1);assert.equal(remote.count('/api/actions/'+id),1);assert.equal(remote.feed(),1);
 await advance(15000);assert.equal(remote.count('/api/actions?cursor=0'),2);assert.equal(remote.count('/api/actions/'+id),2);assert.equal(remote.feed(),11);
 await visibility(true);const feedBefore=remote.feed();await advance(60000);
 assert.equal(remote.count('/api/actions?cursor=0'),2);assert.equal(remote.count('/api/actions/'+id),2);assert.equal(remote.feed(),feedBefore,'feed GET is counted separately and also pauses while hidden');
 await visibility(false);assert.equal(remote.count('/api/actions?cursor=0'),3,'foreground fresh list');assert.equal(remote.count('/api/actions/'+id),3,'foreground fresh exact detail');
 await act(async()=>{w.dispatchEvent(new w.Event('focus'));d.dispatchEvent(new w.Event('visibilitychange'));await turn();});assert.equal(remote.count('/api/actions?cursor=0'),3,'paired/duplicate foreground notifications do not duplicate reads');
 await advance(60000);assert.equal(remote.count('/api/actions?cursor=0'),7);assert.equal(remote.count('/api/actions/'+id),7);assert.equal(remote.feed()-feedBefore,40);
 t.diagnostic('initial list/detail 1/1; visible15s +1/+1 and feed +10; hidden60000ms timer GET 0/0 and feed0; foreground +1/+1; visible60000ms +4/+4 and feed+40');
});

test('visible idle fallback discovers remote analysis, and workflow hints still refresh the current list',async t=>{
 const {d,render,advance}=await fixture(t);let items:any[]=[],running=false;
 const remote=client(()=>page(items,{progress:{configured:true,running,jobs:running?[{status:'running',count:2}]:[],error:null}}));
 await render(remote.api);assert.match(d.body.textContent!,/这里暂时没有日程/);
 items=[proposal()];running=true;await advance(14999);assert.equal(d.querySelector('.calendar-final-row'),null);
 await advance(1);assert.match(d.querySelector('.calendar-final-row')!.textContent!,/Generated original schedule/);assert.equal(remote.count('/api/actions?cursor=0'),2,'idle polling is retained even without an operation hint');
 items=[proposal({event:{...proposal().event,title:'Generated remote analysis update'}})];remote.hints.push('workflow:actions:generated');await advance(1500);
 assert.match(d.querySelector('.calendar-final-row')!.textContent!,/Generated remote analysis update/);assert.equal(remote.count('/api/actions?cursor=0'),3);assert.equal(remote.feed(),12);
});

test('foreground changes cannot silently replace an edited proposal or confirm its newer version',async t=>{
 const {d,w,render,visibility,advance}=await fixture(t,true);let current=proposal();const writes:any[]=[];
 const remote=client((path,init)=>{if(init?.method==='POST'){writes.push(JSON.parse(String(init.body)));return {...current,status:'approved'};}return path.includes('?')?page():current;});
 await render(remote.api);await act(async()=>button(d,'核对变更').click());
 const input=d.querySelector<HTMLInputElement>('[role="dialog"] input[required]')!;Object.assign(input,{attachEvent:()=>{},detachEvent:()=>{}});
 await act(async()=>{input.focus();Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value')!.set!.call(input,'Generated owner draft');input.dispatchEvent(new w.Event('input',{bubbles:true}));input.dispatchEvent(new w.KeyboardEvent('keyup',{bubbles:true,key:'t'}));});
 assert.equal(input.value,'Generated owner draft');await visibility(true);current=proposal({version:4,event:{...current.event,title:'Generated remote version'}});await advance(60000);await visibility(false);
 assert.equal(input.value,'Generated owner draft');assert.equal(button(d,'确认变更').disabled,true);assert.match(d.body.textContent!,/建议已更新，请重新核对后确认/);
 await act(async()=>d.querySelector<HTMLFormElement>('[role="dialog"]')!.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true})));assert.equal(writes.length,0);
 await act(async()=>button(d,'重新核对最新建议').click());assert.equal(input.value,'Generated remote version');await act(async()=>button(d,'确认变更').click());assert.equal(writes.length,1);assert.equal(writes[0].version,4);assert.equal(writes[0].event.title,'Generated remote version');
});

test('off-page ACK and later revocation revalidate the selected identity and withdraw its review',async t=>{
 const {d,render,visibility,advance}=await fixture(t,true);let current=proposal({status:'executing'}),denied=false;
 const remote=client(path=>{if(path.includes('?'))return page();if(denied)throw new ApiError('Generated revocation',403);return current;});
 await render(remote.api);current=proposal({status:'succeeded',version:4,externalId:'generated-device-receipt'});await advance(15000);
 assert.match(d.querySelector('.calendar-final-detail')!.textContent!,/已收到目标设备的写入回执/);assert.equal(d.querySelector('.calendar-final-row'),null,'selected detail is not in the current page');
 current=proposal({version:5});await visibility(true);await visibility(false);await act(async()=>button(d,'核对变更').click());assert.ok(d.querySelector('[role="dialog"]'));
 await visibility(true);denied=true;await advance(60000);await visibility(false);
 assert.equal(d.querySelector('[role="dialog"]'),null);assert.equal(d.querySelector('.calendar-final-detail'),null);assert.match(d.body.textContent!,/这条日程暂不可用/);
});

test('shared readers retain queued hidden follow-ups but add no hidden timer reads or duplicate held foreground reads',async t=>{
 const {d,render,visibility,advance}=await fixture(t),first=deferred(),foreground=deferred();let reads=0;
 const remote=client(()=>{reads++;if(reads===1)return first.promise;if(reads===3)return foreground.promise;return page([proposal({event:{...proposal().event,title:'Generated current shared result'}})]);});
 const shared=resources(remote.api).get('/api/actions?cursor=0'),off=shared.subscribe(()=>{});t.after(off);
 await render(remote.api);assert.equal(reads,1,'component joins the same in-flight resource');
 await visibility(true);await act(async()=>{shared.invalidate();first.resolve(page());await turn();});assert.equal(reads,2,'an already queued invalidation can finish its follow-up while hidden');
 const feedBefore=remote.feed();await advance(60000);assert.equal(reads,2);assert.equal(remote.feed(),feedBefore);
 await visibility(false);assert.equal(reads,3);assert.equal(remote.calls.find(call=>call.path==='/api/actions?cursor=0')!.init!.signal!.aborted,false,'foreground does not abort another shared reader');
 await act(async()=>{foreground.resolve(page([proposal({event:{...proposal().event,title:'Generated foreground shared result'}})]));await turn();});assert.equal(reads,3);assert.match(d.body.textContent!,/Generated foreground shared result/);
});

test('two mounted Actions readers coalesce their foreground revisions for the same shared key',async t=>{
 const {root,visibility}=await fixture(t),remote=client(()=>page());
 await act(async()=>{root.render(React.createElement(React.Fragment,null,React.createElement(Actions,{api:remote.api,onOpen:()=>{}}),React.createElement(Actions,{api:remote.api,onOpen:()=>{}})));await turn();});
 assert.equal(remote.count('/api/actions?cursor=0'),1);assert.equal(remote.feed(),1);
 await visibility(true);await visibility(false);assert.equal(remote.count('/api/actions?cursor=0'),2,'both components share one fresh foreground read');
});

test('foreground refreshes only the current page/detail; API changes reset scope and fence late responses',async t=>{
 const {d,w,render,visibility,advance}=await fixture(t),lateList=deferred(),lateDetail=deferred();let hold=false;
 const old=client(path=>{if(hold&&(path==='/api/actions?cursor=7'||path==='/api/actions/'+id))return path.includes('?')?lateList.promise:lateDetail.promise;if(path==='/api/actions?cursor=0')return page([],{nextCursor:7});return path.includes('?')?page([proposal()]):proposal();});
 const unrelated=resources(old.api).get('/api/actions?cursor=99').subscribe(()=>{});t.after(unrelated);
 await render(old.api);await act(async()=>button(d,'更早建议').click());await act(async()=>d.querySelector<HTMLButtonElement>('.calendar-final-row')!.click());await act(async()=>button(d,'核对变更').click());
 await visibility(true);hold=true;await visibility(false);
 assert.equal(old.count('/api/actions?cursor=0'),1);assert.equal(old.count('/api/actions?cursor=99'),1,'unrelated observed scope is not refreshed');assert.equal(old.count('/api/actions?cursor=7'),2);assert.equal(old.count('/api/actions/'+id),2);
 const late=old.calls.filter(call=>call.path==='/api/actions?cursor=7'||call.path==='/api/actions/'+id).filter(call=>!call.init!.signal!.aborted).slice(-2);
 const fresh=client(path=>{assert.equal(path,'/api/actions?cursor=0','new API must not receive the prior page cursor or selected identity');return page([proposal({event:{...proposal().event,title:'Generated new API'}})]);});
 await render(fresh.api);assert.equal(d.querySelector('[role="dialog"]'),null);assert.ok(late.every(call=>call.init!.signal!.aborted));assert.equal(new URLSearchParams(w.location.hash.split('?')[1]).has('action'),false);
 await act(async()=>{lateList.resolve(page([proposal({event:{...proposal().event,title:'PRIVATE OLD API'}})]));lateDetail.resolve(proposal({event:{...proposal().event,title:'PRIVATE OLD DETAIL'}}));await turn();});assert.doesNotMatch(d.body.textContent!,/PRIVATE OLD/);assert.match(d.body.textContent!,/Generated new API/);
 const oldCount=old.calls.length;await visibility(true);await advance(60000);await visibility(false);assert.equal(old.calls.length,oldCount);assert.equal(fresh.count('/api/actions?cursor=0'),2);
});
