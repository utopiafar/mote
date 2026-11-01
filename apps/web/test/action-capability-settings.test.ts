import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {ActionCapabilitySettings} from '../src/ActionCapabilitySettings.js';
import {ApiError,type Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';
configureLocale(()=> 'zh-CN');
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve!:(value:any)=>void,reject!:(error:unknown)=>void;const promise=new Promise<any>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const identity={packageId:'generated.calendar',releaseDigest:'a'.repeat(64),instanceId:'generated-instance',instanceRevision:1,capabilityDigest:'b'.repeat(64)};
const source={sourceId:'generated-source',kind:'capture',deviceId:'generated-device',platform:'macos'};
const capability={id:'calendar.manage',version:1},target={deviceId:'generated-device',calendarId:'generated-calendar',declarationRevision:1};
const draft=(patch:any={})=>({id:'61e38cca-8f55-4f2c-b450-c0dc0dc0dc01',revision:1,capability,target,inputs:{sources:[source],existingArchived:false,futureInputs:true},state:'draft',executionEnabled:false,createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-01T00:00:00Z',...patch});
const inventory=(patch:any={})=>({providers:[{identity,name:'Generated calendar provider'}],declarations:[{capability,deviceId:target.deviceId,connectionActive:true,permission:'granted',revision:1,calendars:[{id:target.calendarId,title:'Generated calendar'}]}],sources:[{...source,name:'Generated source'}],drafts:[draft()],grants:[],...patch});
const empty=()=>({providers:[],declarations:[],sources:[],drafts:[],grants:[]});
function client(read:(path:string,init?:RequestInit)=>unknown){const calls:{path:string;init?:RequestInit}[]=[];const api={request:async(path:string,init?:RequestInit)=>{calls.push({path,init});return read(path,init);}} as Api;return {api,calls,gets:()=>calls.filter(call=>!call.init?.method&&call.path==='/api/action-capabilities').length,feed:()=>calls.filter(call=>call.path.startsWith('/api/operations/changes')).length};}
async function fixture(t:any){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),w=dom.window,d=w.document;let hidden=false;
 Object.defineProperty(d,'hidden',{get:()=>hidden,configurable:true});const before=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:w,document:d,HTMLElement:w.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const root=createRoot(d.getElementById('root')!);t.mock.timers.enable({apis:['setTimeout']});
 t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 const render=async(api:Api)=>act(async()=>{root.render(React.createElement(ActionCapabilitySettings,{api}));await turn();});
 const visibility=async(value:boolean)=>act(async()=>{hidden=value;d.dispatchEvent(new w.Event('visibilitychange'));if(!hidden)w.dispatchEvent(new w.Event('focus'));await turn();});
 const advance=async(ms:number)=>{for(let left=ms;left>0;){const step=Math.min(500,left);await act(async()=>{t.mock.timers.tick(step);await turn();});left-=step;}};
 return {root,d,w,render,visibility,advance};
}
const findButton=(d:Document,label:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(item=>item.textContent===label);
const button=(d:Document,label:string)=>{const found=findButton(d,label);assert.ok(found,label);return found;};
async function select(d:Document,index:number,value:string){await act(async()=>{const field=d.querySelectorAll<HTMLSelectElement>('fieldset select')[index];assert.ok(field);field.value=value;field.dispatchEvent(new d.defaultView!.Event('change',{bubbles:true}));});}
const ack=(d:Document)=>Array.from(d.querySelectorAll<HTMLLabelElement>('label')).find(label=>label.textContent?.startsWith('我允许此插件'))?.querySelector<HTMLInputElement>('input');
async function review(d:Document){await act(async()=>{const item=Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(item=>item.textContent?.startsWith('继续草稿 ·'));assert.ok(item);item.click();});await select(d,1,JSON.stringify(identity));await act(async()=>ack(d)!.click());assert.equal(button(d,'确认范围授权').disabled,false);}
function noGrant(d:Document){assert.ok(!findButton(d,'确认范围授权')||button(d,'确认范围授权').disabled,'stale scope/consent cannot authorize');}

test('inventory keeps its 15s fallback with empty grants, pauses hidden60s, and refreshes once on foreground',async t=>{
 const {d,w,render,visibility,advance}=await fixture(t);let current=empty() as any;const remote=client(()=>structuredClone(current));
 await render(remote.api);assert.equal(remote.gets(),1);assert.match(d.body.textContent!,/暂无已连接的可写日历/);
 await advance(15000);assert.equal(remote.gets(),2,'empty grants and idle are not reliable stop signals');await visibility(true);current=inventory();await advance(60000);assert.equal(remote.gets(),2);assert.equal(remote.feed(),0);
 await visibility(false);assert.equal(remote.gets(),3);assert.equal(d.querySelectorAll('select option').length,2,'remote declaration is visible immediately');
 await act(async()=>{w.dispatchEvent(new w.Event('focus'));d.dispatchEvent(new w.Event('visibilitychange'));await turn();});assert.equal(remote.gets(),3);
 current=inventory({providers:[],declarations:[]});await advance(60000);assert.equal(remote.gets(),7);assert.match(d.body.textContent!,/暂无已检查并启用的日历能力插件/);assert.match(d.body.textContent!,/暂无已连接的可写日历/);assert.equal(remote.feed(),0);
 t.diagnostic('inventory initial1; visible15s+1; hidden60000ms timer0; foreground+1; visible60000ms+4; component feed GET0 throughout');
});

test('remote draft revocation cannot reuse local saved consent, and explicit current revision review is required',async t=>{
 const {d,render,visibility,advance}=await fixture(t);let current=inventory();const writes:any[]=[];
 const remote=client((_path,init)=>{if(init?.method){writes.push(JSON.parse(String(init.body)));return {};}return structuredClone(current);});
 await render(remote.api);await review(d);await visibility(true);current=inventory({drafts:[draft({state:'revoked',revision:2})]});await advance(60000);await visibility(false);noGrant(d);assert.equal(writes.length,0);
 current=inventory({drafts:[draft({revision:3})]});await visibility(true);await visibility(false);noGrant(d);
 await review(d);await act(async()=>button(d,'确认范围授权').click());assert.equal(writes.length,1);assert.equal(writes[0].draftRevision,3);
});

test('provider removal and return invalidate consent, and a replacement provider requires its current identity',async t=>{
 const {d,render,advance,visibility}=await fixture(t);let current=inventory();const writes:any[]=[];
 const remote=client((_path,init)=>{if(init?.method){writes.push(JSON.parse(String(init.body)));return {};}return structuredClone(current);});
 await render(remote.api);await review(d);current=inventory({providers:[]});await advance(15000);noGrant(d);
 current=inventory();await advance(15000);noGrant(d);assert.equal(ack(d)?.checked??false,false,'returning the same provider cannot restore old consent');
 const replacement={...identity,instanceRevision:2,releaseDigest:'c'.repeat(64)};current=inventory({providers:[{identity:replacement,name:'Generated replacement provider'}]});await visibility(true);await visibility(false);noGrant(d);
 await select(d,1,JSON.stringify(replacement));await act(async()=>ack(d)!.click());await act(async()=>button(d,'确认范围授权').click());assert.equal(writes.length,1);assert.deepEqual(writes[0].plugin,replacement);
});

test('a changed source identity or device declaration cannot authorize an older saved scope',async t=>{
 const {d,render,advance}=await fixture(t);let current=inventory();const remote=client(()=>structuredClone(current));
 await render(remote.api);await review(d);
 current=inventory({sources:[{...source,deviceId:'generated-other-device',name:'Generated rebound source'}]});await advance(15000);noGrant(d);
 current=inventory({declarations:[{...inventory().declarations[0],revision:2}]});await advance(15000);noGrant(d);assert.equal(ack(d)?.checked??false,false);
});

test('a partial saved draft cannot offer authorization with no original source or input range',async t=>{
 const {d,render}=await fixture(t),remote=client(()=>inventory({drafts:[draft({inputs:{sources:[],existingArchived:false,futureInputs:false}})]}));
 await render(remote.api);await act(async()=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(item=>item.textContent?.startsWith('继续草稿 ·'))!.click());
 noGrant(d);assert.equal(Boolean(findButton(d,'确认范围授权')),false);
});

test('commands keep visible polling, recheck exact inventory after503/success/409, and preserve unknown-delivery identities',async t=>{
 const {d,render,visibility,advance}=await fixture(t);let current=inventory({drafts:[]}),saveCalls=0;const pending=deferred(),writes:{path:string;body:any}[]=[];
 const remote=client((path,init)=>{
  if(!init?.method)return path==='/api/action-capabilities'?structuredClone(current):{};
  const body=JSON.parse(String(init.body));writes.push({path,body});
  if(path==='/api/action-capability-drafts'){saveCalls++;if(saveCalls===1)return pending.promise;const saved=draft({...body,revision:1});current={...current,drafts:[saved]};return saved;}
  if(path==='/api/action-capability-grants'){const saved=current.drafts[0],grant={...saved,...body,revision:1,state:'active',available:true};current={...current,grants:[grant]};return grant;}
  current={...current,grants:current.grants.map((grant:any)=>({...grant,revision:2,state:'revoked'}))};throw new ApiError('Generated conflict',409,undefined,'config_conflict');
 });
 const unrelated=resources(remote.api).get('/api/model-settings').subscribe(()=>{});t.after(unrelated);
 await render(remote.api);await select(d,0,JSON.stringify(target));await act(async()=>d.querySelector<HTMLInputElement>('fieldset input[type="checkbox"]')!.click());await act(async()=>button(d,'保存范围草稿').click());
 assert.equal(button(d,'保存范围草稿').matches(':disabled'),true);await advance(15000);assert.equal(remote.gets(),2,'busy does not disable visible inventory fallback');
 await visibility(true);await advance(60000);assert.equal(remote.gets(),2);await act(async()=>{pending.reject(new ApiError('Generated uncertain delivery',503,undefined,'config_unavailable'));await turn();});
 assert.equal(remote.gets(),3,'command completion fresh is separate from hidden timer reads');assert.ok(d.querySelector('[role="alert"]'));assert.equal(d.querySelector<HTMLSelectElement>('fieldset select')!.value,JSON.stringify(target));assert.equal(d.querySelector<HTMLInputElement>('fieldset input[type="checkbox"]')!.checked,true);
 await act(async()=>button(d,'保存范围草稿').click());assert.deepEqual(writes[1].body,writes[0].body,'503 retry retains the same id and operationId');assert.equal(remote.gets(),4);
 await select(d,1,JSON.stringify(identity));await act(async()=>ack(d)!.click());await act(async()=>button(d,'确认范围授权').click());assert.equal(remote.gets(),5);assert.match(d.body.textContent!,/范围授权有效/);
 await act(async()=>button(d,'撤销范围授权').click());assert.equal(remote.gets(),6,'409 also revalidates the authoritative grant');assert.match(d.body.textContent!,/已撤销/);assert.ok(d.querySelector('[role="alert"]'));
 assert.equal(remote.calls.filter(call=>call.path==='/api/model-settings').length,1,'commands refresh exact inventory only');
});

test('shared held inventory reads coalesce foreground revisions without aborting another reader',async t=>{
 const {root,visibility}=await fixture(t),pending=deferred();let reads=0;
 const remote=client(()=>++reads===1?pending.promise:inventory()),off=resources(remote.api).get('/api/action-capabilities').subscribe(()=>{});t.after(off);
 await act(async()=>{root.render(React.createElement(React.Fragment,null,React.createElement(ActionCapabilitySettings,{api:remote.api}),React.createElement(ActionCapabilitySettings,{api:remote.api})));await turn();});assert.equal(reads,1);
 await visibility(true);await visibility(false);assert.equal(reads,1);assert.equal(remote.calls[0].init!.signal!.aborted,false);
 await act(async()=>{pending.resolve(empty());await turn();});assert.equal(reads,2,'both foreground consumers share one follow-up after the old in-flight read');assert.equal(remote.calls[0].init!.signal!.aborted,false);
});

test('switching APIs aborts old commands and fences late responses even after returning to the same API',async t=>{
 const {d,render}=await fixture(t),first=deferred(),second=deferred();let saves=0,current=inventory({drafts:[]});const writes:any[]=[];
 const old=client((_path,init)=>{if(init?.method){writes.push(JSON.parse(String(init.body)));return ++saves===1?first.promise:second.promise;}return structuredClone(current);}),fresh=client(()=>empty());
 await render(old.api);await select(d,0,JSON.stringify(target));await act(async()=>d.querySelector<HTMLInputElement>('fieldset input[type="checkbox"]')!.click());await act(async()=>button(d,'保存范围草稿').click());const original=old.calls.find(call=>call.init?.method)!;
 await render(fresh.api);assert.equal(original.init!.signal?.aborted,true);assert.match(d.body.textContent!,/暂无已连接的可写日历/);
 await render(old.api);await act(async()=>button(d,'保存范围草稿').click());assert.deepEqual(writes[1],writes[0]);const before=old.gets();
 await act(async()=>{first.resolve(draft({id:writes[0].id,revision:99}));await turn();});assert.equal(old.gets(),before,'late old command cannot force a new GET');assert.equal(button(d,'保存范围草稿').matches(':disabled'),true,'late completion cannot release the current command');
 current=inventory({drafts:[draft({id:writes[1].id})]});await act(async()=>{second.resolve(current.drafts[0]);await turn();});assert.equal(old.gets(),before+1);assert.equal(button(d,'保存范围草稿').matches(':disabled'),false);assert.equal(fresh.gets(),1);assert.equal(d.querySelectorAll('fieldset select').length,2);
});
