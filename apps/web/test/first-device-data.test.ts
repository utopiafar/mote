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
 assert.equal(f.d.querySelector('.central-first-data time')!.getAttribute('dateTime'),when);
 await act(async()=>button(f.d,'查看原文').click());await act(async()=>button(f.d,'查看原文').click());assert.deepEqual(f.opened,['capture:'+id,'capture:'+id]);assert.equal(reads,1,'opening is navigation, not upload or model work');
 fail=true;await act(async()=>button(f.d,'刷新').click());await f.tick();assert.equal(f.d.querySelector('[data-onboarding-state]')!.getAttribute('data-onboarding-state'),'error');assert.equal(f.d.querySelector('.central-first-data time'),null);assert.doesNotMatch(f.d.querySelector('.central-first-data')!.textContent!,/原件已保留/);assert.ok(f.d.querySelector('[role=alert]'));
 fail=false;await act(async()=>button(f.d,'刷新').click());await f.tick();assert.equal(f.d.querySelector('[data-onboarding-state]')!.getAttribute('data-onboarding-state'),'ready');
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
