import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale,getLocale} from '@mote/shared/i18n';
import {Overview} from '../src/Overview';
import {type Api,type Status} from '../src/api';
import {affectedResource} from '../src/operation-feed';
import {resources} from '../src/resource-cache';
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
 return {d:dom.window.document,render};
}
function countingApi(runs:()=>{items:unknown[]}){
 const reads:string[]=[],api={request:async(path:string)=>{
  reads.push(path);
  if(path==='/api/features')return inventory;
  if(path==='/api/insight-runs')return runs();
  if(path==='/api/devices/first-data')return {state:'ready',originalAvailable:false,checkedDevices:1,checkedRecords:1,windowLimited:false};
  if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};
  return {items:[],nextCursor:null};
 },setAgentTimeout:()=>{}} as Api;
 return {api,reads};
}
const runReads=(reads:string[])=>reads.filter(path=>path==='/api/insight-runs');

test('an idle Home never repolls insight runs and never reads captures',async t=>{
 const {render}=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});
 const {api,reads}=countingApi(()=>({items:[]}));
 await render(api);assert.equal(runReads(reads).length,1);
 await act(async()=>t.mock.timers.tick(60000));
 assert.equal(runReads(reads).length,1,'without a running review the run list stays on its first read');
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

test('an insight change notification rereads the run list exactly once',async t=>{
 const {render}=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});
 const {api,reads}=countingApi(()=>({items:[]}));
 await render(api);assert.equal(runReads(reads).length,1);
 await act(async()=>resources(api).invalidate(key=>affectedResource(key,new Set(['insight:generated-run']),false)));
 assert.equal(runReads(reads).length,2,'the notification is a hint that coalesces into one re-read');
 await act(async()=>t.mock.timers.tick(60000));
 assert.equal(runReads(reads).length,2,'no polling resumes afterwards');
});
