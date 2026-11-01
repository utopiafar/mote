import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale,getLocale} from '@mote/shared/i18n';
import {Overview} from '../src/Overview';
import {type Api,type Status} from '../src/api';
import {featuresReady} from '../src/features/bootstrap.js';

const when='2026-10-31T00:00:00Z';
const run=(status:string)=>({id:'generated-run',status,scope:{},createdAt:when,updatedAt:when,events:[]});
const inventory={schemaVersion:1,revision:1,features:[],capabilities:[{id:'http:GET:/api/insight-runs',version:'1',state:'active',surface:'data',featureId:'generated.insights'}]};

async function fixture(t:TestContext){
 await featuresReady;
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/today',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>(),locale=getLocale();configureLocale(()=>'zh-CN');
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});}
 const root=createRoot(dom.window.document.querySelector('#root')!);
 t.after(async()=>{await act(async()=>root.unmount());configureLocale(()=>locale);for(const [key,value] of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 const render=async(api:Api)=>{await act(async()=>root.render(React.createElement(Overview,{api,status:{agent:{configured:false},storage:{captures:0}} as Status,devices:[],insights:[],range:{},onMedia:()=>{},onPage:()=>{},onOpen:()=>{}})));};
 return {d:dom.window.document,root,render};
}
function countingApi(runs:()=>{items:unknown[]}){
 const reads:string[]=[],changes:string[]=[];let pending:string[]=[],cursor=0;
 const api={request:async(path:string)=>{
  reads.push(path);
  if(path==='/api/features')return inventory;
  if(path==='/api/insight-runs')return runs();
  if(path==='/api/devices/first-data')return {state:'ready',originalAvailable:false,checkedDevices:1,checkedRecords:1,windowLimited:false};
  if(path.startsWith('/api/operations/changes')){changes.push(path);const ids=pending;pending=[];return {ids,cursor:++cursor,hasMore:false,reset:false};}
  return {items:[],nextCursor:null};
 },setAgentTimeout:()=>{}} as Api;
 return {api,reads,changes,deliver:(ids:string[])=>{pending.push(...ids);}};
}
const runReads=(reads:string[])=>reads.filter(path=>path==='/api/insight-runs');

test('an idle Home never repolls insight runs and never reads captures',async t=>{
 const {render}=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});
 const {api,reads,changes}=countingApi(()=>({items:[]}));
 await render(api);assert.equal(runReads(reads).length,1);assert.ok(changes.length>=1,'mounting Home starts the shared change subscription');
 await act(async()=>t.mock.timers.tick(60000));
 assert.equal(runReads(reads).length,1,'without a running review the run list stays on its first read');
 assert.ok(changes.length>=2,'the change feed keeps polling so foreign runs can arrive');
 assert.equal(reads.some(path=>path.startsWith('/api/captures')),false,'Home no longer reads recent captures');
});

test('a running review polls every five seconds and stops once it completes',async t=>{
 const {render}=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});
 let status='running';const {api,reads}=countingApi(()=>({items:[run(status)]}));
 await render(api);assert.equal(runReads(reads).length,1);
 for(let index=0;index<3;index++)await act(async()=>t.mock.timers.tick(5000));
 assert.equal(runReads(reads).length,4,'one read per five seconds while a review is running');
 status='completed';
 await act(async()=>t.mock.timers.tick(5000));assert.equal(runReads(reads).length,5);
 for(let index=0;index<6;index++)await act(async()=>t.mock.timers.tick(5000));
 assert.equal(runReads(reads).length,5,'a completed review stops the polling');
});

test('an insight change delivered by the operation feed rereads the run list exactly once',async t=>{
 const {render}=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});
 const {api,reads,deliver}=countingApi(()=>({items:[]}));
 await render(api);assert.equal(runReads(reads).length,1);
 deliver(['insight:generated-run']);
 await act(async()=>t.mock.timers.tick(1500));
 assert.equal(runReads(reads).length,2,'the delivered change is a hint that coalesces into one re-read');
 await act(async()=>t.mock.timers.tick(60000));
 assert.equal(runReads(reads).length,2,'no polling resumes afterwards');
});

test('a review started on another device enters running polls and stops on completion',async t=>{
 const {render}=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});
 let status:'none'|'running'|'completed'='none';
 const {api,reads,deliver}=countingApi(()=>({items:status==='none'?[]:[run(status)]}));
 await render(api);assert.equal(runReads(reads).length,1);
 status='running';deliver(['insight:other-device-run']);
 await act(async()=>t.mock.timers.tick(1500));assert.equal(runReads(reads).length,2,'the feed discovers the run started elsewhere');
 await act(async()=>t.mock.timers.tick(5000));assert.equal(runReads(reads).length,3,'the discovered run enters the five-second poll');
 status='completed';await act(async()=>t.mock.timers.tick(5000));assert.equal(runReads(reads).length,4);
 await act(async()=>t.mock.timers.tick(30000));assert.equal(runReads(reads).length,4,'the completed run stops the polling');
});

test('unmount releases the change feed and a hidden Home pauses it without duplicating subscriptions',async t=>{
 const {d,root,render}=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});
 const {api,reads,changes}=countingApi(()=>({items:[]}));
 await render(api);
 await act(async()=>t.mock.timers.tick(1500));const live=changes.length;assert.ok(live>=2);
 Object.defineProperty(d,'hidden',{configurable:true,value:true});
 await act(async()=>t.mock.timers.tick(10000));assert.equal(changes.length,live,'a hidden Home issues no feed requests');
 Object.defineProperty(d,'hidden',{configurable:true,value:false});
 await act(async()=>t.mock.timers.tick(1500));assert.ok(changes.length>live,'recovery resumes the feed');
 assert.ok(changes.length-live<=2,'recovery does not duplicate subscriptions');
 await act(async()=>root.unmount());
 const stopped=changes.length;await act(async()=>t.mock.timers.tick(30000));
 assert.equal(changes.length,stopped,'unmounting Home releases the shared subscription');
 assert.equal(runReads(reads).length,1,'unmounting also ends the run list resource');
});
