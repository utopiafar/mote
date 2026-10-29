import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale,getLocale} from '@mote/shared/i18n';
import {Overview} from '../src/Overview';
import {ApiError,type Api,type Status} from '../src/api';
import {affectedResource} from '../src/operation-feed';
import {resources} from '../src/resource-cache';
import {webFeatures} from '../src/features/registry';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',when='2026-10-20T09:20:00.000Z';
const candidate={id,deviceId:'generated-phone',deviceName:'Generated phone',source:'note',capturedAt:'2026-01-01T01:00:00.000Z',receivedAt:when};
const result=(state='ready')=>({state,originalAvailable:state==='ready',checkedDevices:1,checkedRecords:1,windowLimited:false,...(state==='ready'||state==='received_unavailable'?{candidate}:{})});
const button=(d:Document,label:string)=>[...d.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.getAttribute('aria-label')===label||item.textContent?.trim()===label)!;
async function fixture(t:TestContext){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/today',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>(),locale=getLocale();configureLocale(()=>'zh-CN');
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});}
 const root=createRoot(dom.window.document.querySelector('#root')!);
 t.after(async()=>{await act(async()=>root.unmount());configureLocale(()=>locale);for(const [key,value] of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 const opened:string[]=[],pages:string[]=[];
 const render=async(api:Api)=>{await act(async()=>root.render(React.createElement(Overview,{api,status:{agent:{configured:false},storage:{captures:0}} as Status,devices:[],activity:{apps:[],devices:[],totalDurationMs:0,captures:0},recent:[],insights:[],range:{},onMedia:()=>{},onPage:page=>pages.push(page),onOpen:ref=>opened.push(ref)})));};
 return {root,d:dom.window.document,render,opened,pages,tick:async()=>{await act(async()=>new Promise(done=>setTimeout(done,0)));}};
}
function apiWith(first:()=>unknown,other?:(path:string)=>unknown){return {request:async(path:string)=>path==='/api/devices/first-data'?first():path.startsWith('/api/operations/changes')?{ids:[],cursor:0,hasMore:false,reset:false}:other?.(path)??{items:[]},setAgentTimeout:()=>{}} as Api;}

test('pairing, arbitrary catalog content and MCP grant do not complete onboarding; loading is not success',async t=>{
 const f=await fixture(t);let finish!:(value:unknown)=>void;
 const pending=new Promise(done=>finish=done),api=apiWith(()=>pending,path=>path==='/api/connections'?{items:[{scope:'mcp-read'}]}:path.startsWith('/api/library/catalog')?{items:[{id:'unrelated-web-material'}]}:{items:[{id:'source-only'}]});
 await f.render(api);
 assert.equal(f.d.querySelector('[data-onboarding-state]')!.getAttribute('data-onboarding-state'),'loading');assert.equal(f.d.querySelector('.central-first-steps .completed'),null);assert.match(f.d.querySelector('[role=status]')!.textContent!,/正在读取采集记录/);
 await act(async()=>finish(result('unverified')));
 assert.equal(f.d.querySelector('[data-onboarding-state]')!.getAttribute('data-onboarding-state'),'unverified');assert.match(f.d.querySelector('.central-first-data')!.textContent!,/最近记录.*尚未验证/);assert.doesNotMatch(f.d.querySelector('.central-first-data')!.textContent!,/原件已保留/);
 await act(async()=>button(f.d,'连接设备').click());assert.deepEqual(f.pages,['deviceConnections']);
 await act(async()=>button(f.d,'打开资料库').click());assert.equal(f.pages.at(-1),'archive');assert.deepEqual(f.opened,[]);
});

test('retained exact device original needs no model or MCP, uses Central receive time, and refresh failure removes success',async t=>{
 const f=await fixture(t);let fail=false,reads=0;
 const api=apiWith(()=>{reads++;if(fail)throw new ApiError('Generated offline connection',503);return result();},path=>{if(path==='/api/connections'||path==='/api/sources')throw new ApiError('Generated optional service',503);return {items:[]};});
 await f.render(api);assert.equal(f.d.querySelector('[data-onboarding-state]')!.getAttribute('data-onboarding-state'),'ready');assert.equal(f.d.querySelector('.central-first-steps'),null);assert.match(f.d.querySelector('.central-first-data')!.textContent!,/原件已保留/);
 assert.equal(f.d.querySelector('.central-onboarding')!.closest('details')?.className,'home-extensions');assert.equal(f.d.querySelector<HTMLDetailsElement>('.home-extensions')!.open,false);
 assert.equal(f.d.querySelector('.central-first-data time')!.getAttribute('dateTime'),when);
 await act(async()=>button(f.d,'查看原文').click());await act(async()=>button(f.d,'查看原文').click());assert.deepEqual(f.opened,['capture:'+id,'capture:'+id]);assert.equal(reads,1,'opening is navigation, not upload or model work');
 fail=true;await act(async()=>button(f.d,'刷新').click());await f.tick();assert.equal(f.d.querySelector('[data-onboarding-state]')!.getAttribute('data-onboarding-state'),'error');assert.equal(f.d.querySelector('.central-first-data time'),null);assert.doesNotMatch(f.d.querySelector('.central-first-data')!.textContent!,/原件已保留/);assert.ok(f.d.querySelector('[role=alert]'));
 assert.equal(f.d.querySelector('.central-onboarding')!.closest('.home-extensions'),null,'failed verification is visible in the primary Home area');
 fail=false;await act(async()=>button(f.d,'刷新').click());await f.tick();assert.equal(f.d.querySelector('[data-onboarding-state]')!.getAttribute('data-onboarding-state'),'ready');
});

test('Home totals require complete catalog facets and never sum a truncated or failed response',async t=>{
 const f=await fixture(t);
 const total=()=>f.d.querySelector('.home-summary strong')!.firstChild!.textContent;
 for(const [catalog,expected] of [
  [{items:[],sources:[{count:4},{count:3}],sourcesTruncated:false},'7'],
  [{items:[],sources:[{count:4}],sourcesTruncated:true},'—'],
  [{items:[],sources:[{count:4}]},'—'],
  [{items:[],sources:[{count:-1}],sourcesTruncated:false},'—'],
  [{items:[],sources:[],sourcesTruncated:false},'0'],
 ] as const){await f.render(apiWith(()=>result(),path=>path.startsWith('/api/library/catalog')?catalog:{items:[]}));assert.equal(total(),expected);}
 await f.render(apiWith(()=>result(),path=>{if(path.startsWith('/api/library/catalog'))throw new ApiError('Generated unavailable catalog',503);return {items:[]};}));
 assert.equal(total(),'—');assert.match(f.d.querySelector('.home-read-error')!.textContent!,/Generated unavailable catalog/);
});

test('Home only reads optional feature routes while both the local page and exact server capability exist',async t=>{
 const f=await fixture(t),reads:string[]=[];
 const registration=await webFeatures.install({id:'fixture.home-capabilities',version:'1',components:[]},['ask','actions','insights'].map(id=>({surface:'page' as const,entry:{id,route:id==='insights'?'library/insights':id,featureId:'fixture.home-capabilities',render:()=>null}})));
 t.after(()=>registration.dispose());
 const optional=['/api/conversations','/api/owner-questions','/api/actions','/api/todos'];
 const api=(enabled:boolean)=>apiWith(()=>result(),path=>{
  reads.push(path);
  if(path==='/api/features')return {schemaVersion:1,revision:1,features:[],capabilities:enabled?optional.map(path=>({id:'http:GET:'+path,version:'1',state:'active',featureId:'fixture.server',surface:'data'})):[]};
  return {items:[],nextCursor:null};
 });
 await f.render(api(false));assert.equal(reads.some(path=>optional.some(prefix=>path.startsWith(prefix))),false);assert.equal(f.d.querySelector('.home-conversations'),null);assert.equal(f.d.querySelector('.home-action-entry'),null);
 reads.length=0;await f.render(api(true));assert.ok(optional.every(prefix=>reads.some(path=>path.startsWith(prefix))));assert.ok(f.d.querySelector('.home-conversations'));assert.ok(f.d.querySelector('.home-action-entry'));
 assert.ok(f.d.querySelector('a[href="#/library/insights?insight=new"]'));
 await act(async()=>registration.dispose());assert.equal(f.d.querySelector('.home-conversations'),null);assert.equal(f.d.querySelector('.home-action-entry'),null);assert.equal(f.d.querySelector('a[href="#/library/insights?insight=new"]'),null,'unloaded report entry cannot silently route to a different page');
});

test('missing originals remain unavailable; another node cannot inherit a pending or retained result',async t=>{
 const f=await fixture(t);let settle!:(value:unknown)=>void;
 const oldApi=apiWith(()=>new Promise(done=>settle=done));await f.render(oldApi);
 const nextApi=apiWith(()=>result('received_unavailable'));await f.render(nextApi);
 await act(async()=>settle(result()));assert.equal(f.d.querySelector('[data-onboarding-state]')!.getAttribute('data-onboarding-state'),'received_unavailable');assert.match(f.d.querySelector('.central-first-data')!.textContent!,/中央已接收.*原件不可用/s);assert.ok(button(f.d,'查看原文').closest('.central-first-steps'),'unavailable originals retain Library navigation but no success action');
 const emptyApi=apiWith(()=>({...result('unverified'),checkedDevices:0,checkedRecords:0,windowLimited:true}));await f.render(emptyApi);assert.equal(f.d.querySelector('.central-first-data time'),null);assert.doesNotMatch(f.d.querySelector('.central-first-data')!.textContent!,/Generated phone/);
});

test('capture/file changes recheck exact availability without polling model/plugin events',async t=>{
 assert.equal(affectedResource('/api/devices/first-data',new Set(['capture:'+id]),false),true);
 assert.equal(affectedResource('/api/devices/first-data',new Set(['file:'+id]),false),true);
 assert.equal(affectedResource('/api/devices/first-data',new Set(['memory:unrelated']),false),false);
 const f=await fixture(t);let available=true;
 const api=apiWith(()=>result(available?'ready':'received_unavailable'));await f.render(api);available=false;
 await act(async()=>resources(api).invalidate(key=>affectedResource(key,new Set(['capture:'+id]),false)));
 assert.equal(f.d.querySelector('[data-onboarding-state]')!.getAttribute('data-onboarding-state'),'received_unavailable');
});
