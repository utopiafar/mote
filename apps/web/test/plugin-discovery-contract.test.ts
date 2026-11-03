import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {configureLocale,getLocale} from '@mote/shared/i18n';
import type {InsightSnapshot} from '@mote/shared';
import {buildApp} from '../../server/src/app.js';
import type {Config} from '../../server/src/config.js';
import {createApi,dateTime,type Api,type Answer} from '../src/api.js';
import {modelView} from './fixtures/model-settings.js';
import {Insights} from '../src/plugins/discovery/Insights.js';
import {InsightReport} from '../src/plugins/discovery/InsightReport.js';

const when='2026-09-15T03:00:00.000Z';
async function fixture(t:import('node:test').TestContext,hash='#/library/insights?insight=new'){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/'+hash,pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>(),locale=getLocale();configureLocale(()=> 'zh-CN');
 for(const [key,value] of Object.entries({window:dom.window,location:dom.window.location,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 dom.window.HTMLElement.prototype.scrollIntoView=()=>{};dom.window.scrollTo=()=>{};const root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}configureLocale(()=>locale);dom.window.close();});
 const tick=async()=>{await act(async()=>new Promise(resolve=>setTimeout(resolve,5)));};
 const until=async(check:()=>boolean)=>{const deadline=Date.now()+10000;while(!check()){assert.ok(Date.now()<deadline,'UI did not reach expected state');await tick();}};
 return {root,d:dom.window.document,win:dom.window,tick,until};
}
const button=(d:Document,label:string)=>[...d.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent?.trim()===label)!;
function fake(read:(path:string,init?:RequestInit)=>unknown):Api{return {request:async(path:string,init?:RequestInit)=>path.startsWith('/api/operations/changes')?{ids:[],cursor:0,hasMore:false,reset:false}:read(path,init),setAgentTimeout:()=>{}} as Api;}

test('the real owner response keeps the report snapshot asOf, exact scope and citations visible',async t=>{
 const {root,d,until}=await fixture(t),dataDir=await mkdtemp(join(tmpdir(),'mote-discovery-contract-'));
 const config:Config={dataDir,token:'generated-discovery-contract-owner',tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('Reading a stored report must not call a model');},close:async()=>{}}});
 t.after(async()=>{await node.app.close();await rm(dataDir,{recursive:true,force:true});});
 await node.app.listen({host:'127.0.0.1',port:0});const address=node.app.server.address();assert.ok(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
 const nativeFetch=globalThis.fetch;globalThis.fetch=(input,init)=>nativeFetch(typeof input==='string'?new URL(input,origin):input,init);t.after(()=>{globalThis.fetch=nativeFetch;});
 const api=createApi({token:config.token}),runId=randomUUID(),citation={id:randomUUID(),appName:'Generated contract original',capturedAt:when,contentAt:when,excerpt:'Generated contract citation excerpt'};
 const snapshot:InsightSnapshot={schemaVersion:1,id:randomUUID(),seriesId:randomUUID(),version:3,previousRunId:randomUUID(),asOf:when,scope:{after:'2026-09-01T00:00:00.000Z',before:when,timeZone:'Asia/Shanghai'},watermark:7,scopeFingerprint:'generated-contract',coverage:{records:5,materialRecords:2,referenceOnlyRecords:0,pendingProcessing:0,sourceStates:[],measured:{observedDurationMs:0,deviceDurationMs:0,overlapDurationMs:0,unobservedDurationMs:null,accounting:'union_across_devices',coverage:'observed_intervals_only'},limitations:[]}};
 node.store.saveInsight({runId,answer:'Generated contract report ['+citation.id+']',citations:[citation],trace:[],createdAt:when,snapshot,artifact:{id:randomUUID(),title:'Generated contract report',html:'<h1>Generated contract report</h1><p>Generated body ['+citation.id+']</p>',createdAt:when,skillId:'generated-contract-skill',skillVersion:'1'}},runId);
 const answer=await api.request<Answer>('/api/insights/'+runId);
 assert.deepEqual(answer.snapshot,snapshot,'the exact stored snapshot is the response the consumer renders');
 assert.deepEqual(answer.citations,[citation]);
 const opened:string[]=[];
 await act(async()=>{root.render(React.createElement(InsightReport,{answer,onOpen:ref=>opened.push(ref)}));});
 await until(()=>!!d.querySelector('.report-coverage'));
 const coverage=d.querySelector('.report-coverage')!.textContent!;
 assert.match(coverage,/版本 3/);assert.ok(coverage.includes('资料截止时间 '+dateTime(snapshot.asOf)),coverage);assert.match(coverage,new RegExp(dateTime(snapshot.scope.after!)+' — '+dateTime(snapshot.scope.before).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 assert.match(coverage,/5 条记录 · 2 正式资料/);assert.match(coverage,/0 秒/);assert.match(coverage,/同一范围的新版本/);
 const card=d.querySelector<HTMLElement>('.report-evidence .evidence-card')!;assert.match(card.textContent!,/Generated contract original/);assert.match(card.textContent!,/Generated contract citation excerpt/);
 await act(async()=>card.click());assert.deepEqual(opened,['capture:'+citation.id]);
});

test('a running discovery left and reopened restores server progress without launching another run',async t=>{
 const {root,d,win,until}=await fixture(t);let posts=0,details=0;
 const running={id:'generated-restored-run',status:'running',createdAt:when,updatedAt:when,scope:{},events:[{stage:'model',at:when}]};
 const api=fake((path,init)=>{
  if(path==='/api/model-settings')return modelView();
  if(path==='/api/insights?limit=30')return {items:[],nextCursor:null};
  if(path==='/api/insight-runs'&&init?.method==='POST'){posts++;return running;}
  if(path==='/api/insight-runs')return {items:[running]};
  if(path==='/api/insight-runs/'+running.id){details++;return running;}
  return {items:[]};
 });
 const view=()=>React.createElement(Insights,{api,range:{},configured:true,onOpen:()=>{},onSettings:()=>{},onChanged:()=>{}});
 await act(async()=>root.render(view()));await until(()=>!!d.querySelector('.insight-progress')&&details>=1);
 assert.match(d.querySelector('.insight-progress')!.textContent!,/模型正在分析资料并生成报告/);
 await act(async()=>button(d,'发现历史').click());assert.equal(d.querySelector('.insight-progress'),null,'leaving the report stops showing live progress');
 await act(async()=>root.render(null));await act(async()=>root.render(view()));await until(()=>!!d.querySelector('.workspace-list'));
 const readsAfterReturn=details;await act(async()=>button(d,'生成回顾').click());
 await until(()=>!!d.querySelector('.insight-progress')&&details>readsAfterReturn);
 assert.match(d.querySelector('.insight-progress')!.textContent!,/模型正在分析资料并生成报告/);assert.equal(posts,0,'reopening never submits a second run');assert.equal(win.location.hash,'#/library/insights?insight=new');
});
