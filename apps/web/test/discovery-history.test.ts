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
import {buildApp} from '../../server/src/app.js';
import type {Config} from '../../server/src/config.js';
import {ApiError,createApi,INSIGHT_HISTORY_PATH,type Api,type Answer} from '../src/api.js';
import {Insights} from '../src/Insights.js';

const when='2026-10-01T00:00:00.000Z';
const report=(runId:string,answer:string):Answer=>({runId,answer,citations:[],trace:[],createdAt:when});
async function fixture(t:import('node:test').TestContext,hash='#/library/insights'){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/'+hash,pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>(),locale=getLocale();configureLocale(()=> 'zh-CN');
 for(const [key,value] of Object.entries({window:dom.window,location:dom.window.location,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 dom.window.HTMLElement.prototype.scrollIntoView=()=>{};const root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}configureLocale(()=>locale);dom.window.close();});
 const tick=async()=>{await act(async()=>new Promise(resolve=>setTimeout(resolve,5)));};
 const until=async(check:()=>boolean)=>{const deadline=Date.now()+10000;while(!check()){assert.ok(Date.now()<deadline,'UI did not reach expected state');await tick();}};
 const view=(api:Api)=>React.createElement(Insights,{api,range:{},configured:false,onOpen:()=>{},onSettings:()=>{},onChanged:()=>{}});
 return {root,d:dom.window.document,win:dom.window,tick,until,view};
}
const button=(d:Document,label:string)=>[...d.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent?.trim()===label)!;
function fake(read:(path:string,init?:RequestInit)=>unknown):Api{return {request:async(path:string,init?:RequestInit)=>path.startsWith('/api/operations/changes')?{ids:[],cursor:0,hasMore:false,reset:false}:read(path,init),setAgentTimeout:()=>{}} as Api;}

test('real owner HTTP history reaches older pages and exact reports, then removes a report invalidated by original deletion',async t=>{
 const {root,d,win,until,view}=await fixture(t),dataDir=await mkdtemp(join(tmpdir(),'mote-discovery-renderer-'));
 const config:Config={dataDir,token:'generated-history-renderer-owner',tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('Reading history must not call a model');},close:async()=>{}}});
 t.after(async()=>{await node.app.close();await rm(dataDir,{recursive:true,force:true});});
 await node.app.listen({host:'127.0.0.1',port:0});const address=node.app.server.address();assert.ok(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
 const nativeFetch=globalThis.fetch;globalThis.fetch=(input,init)=>nativeFetch(typeof input==='string'?new URL(input,origin):input,init);
 t.after(()=>{globalThis.fetch=nativeFetch;});
 const api=createApi({token:config.token}),ids=Array.from({length:67},()=>randomUUID()).sort().reverse(),noteId=randomUUID();
 await api.request('/api/notes',{method:'POST',body:JSON.stringify({id:noteId,deviceId:'generated-renderer-device',deviceName:'Generated device',platform:'android',capturedAt:when,text:'Generated cited original'})});
 for(const [index,id] of ids.entries())node.store.saveInsight({...report(id,'Generated finding '+index),citations:[{id:noteId,appName:'Generated note',capturedAt:when,excerpt:'Generated cited original'}]},id);
 node.store.db.prepare('UPDATE insights SET created_at=?').run(when);
 await act(async()=>{win.location.hash='#/library/insights?insight='+ids[66];root.render(view(api));});
 await until(()=>(d.querySelector('.insight-report')?.textContent?.includes('Generated finding 66')??false)&&d.querySelectorAll('.workspace-list .workspace-select').length===30);
 assert.equal(d.querySelectorAll('.workspace-list .workspace-select').length,30);assert.ok(!d.querySelector('.workspace-list')!.textContent!.includes('Generated finding 66'));
 await act(async()=>button(d,'加载更多').click());await until(()=>d.querySelectorAll('.workspace-list .workspace-select').length===60);
 await act(async()=>button(d,'加载更多').click());await until(()=>d.querySelectorAll('.workspace-list .workspace-select').length===67);assert.equal(button(d,'加载更多'),undefined);
 assert.match(d.querySelector('.insight-report')!.textContent!,/Generated finding 66/,'history reads cannot replace the exact selected result');
 await api.request('/api/notes/'+noteId,{method:'DELETE'});
 // Deletion has no execution-event guarantee. The mounted report's bounded
 // revalidation must withdraw it and refresh history without a manual reload.
 await until(()=>!d.querySelector('.insight-report')&&d.body.textContent!.includes('这份洞察当前不可用'));
 await until(()=>d.querySelectorAll('.workspace-list .workspace-select').length===0);
 assert.equal(win.location.hash,'#/library/insights?insight='+ids[66],'a disappeared report never silently selects another result');
});

test('late exact reads, unavailable selections and a different owner session cannot substitute another report',async t=>{
 const {root,d,win,until,tick,view}=await fixture(t,'#/library/insights?insight=first');let finish!:(value:Answer)=>void;
 const held=new Promise<Answer>(resolve=>finish=resolve),second=report('second','Generated second report');
 const api=fake(path=>path===INSIGHT_HISTORY_PATH?{items:[second],nextCursor:null}:path==='/api/insights/first'?held:path==='/api/insights/second'?second:path==='/api/insights/missing'?Promise.reject(new ApiError('Generated report missing',404)):{items:[]});
 await act(async()=>root.render(view(api)));assert.equal(d.querySelector('.insight-report'),null);
 await act(async()=>{win.location.hash='#/library/insights?insight=second';win.dispatchEvent(new win.HashChangeEvent('hashchange'));});await until(()=>!!d.querySelector('.insight-report'));
 await act(async()=>finish(report('first','Generated stale first report')));assert.match(d.querySelector('.insight-report')!.textContent!,/Generated second report/);assert.doesNotMatch(d.body.textContent!,/Generated stale first report/);
 await act(async()=>{win.location.hash='#/library/insights?insight=missing';win.dispatchEvent(new win.HashChangeEvent('hashchange'));});await until(()=>d.body.textContent!.includes('这份洞察当前不可用'));assert.equal(d.querySelector('.insight-report'),null);
 await act(async()=>{win.location.hash='#/library/insights?insight=second';win.dispatchEvent(new win.HashChangeEvent('hashchange'));});await until(()=>!!d.querySelector('.insight-report'));
 const denied=fake(path=>path.startsWith('/api/insights')?Promise.reject(new ApiError('Generated owner session denied',403)):{items:[]});
 await act(async()=>root.render(view(denied)));await tick();assert.equal(d.querySelector('.insight-report'),null);assert.doesNotMatch(d.body.textContent!,/Generated second report/);
});

test('a changed history cursor discards older rows and reloads the first page; transient page failures remain retryable',async t=>{
 const {root,d,until,view}=await fixture(t,'#/library/insights?insight=first'),first=report('first','Generated current finding'),old=report('old','Generated older finding');let stage=0,firstReads=0;
 const api=fake(path=>{
  if(path===INSIGHT_HISTORY_PATH){firstReads++;return {items:stage===3?[]:[first],nextCursor:stage===3?null:'page-two'};}
  if(path.includes('cursor=page-two')){stage++;if(stage===1)throw new TypeError('Generated network failure');if(stage===2)return {items:[old],nextCursor:'page-three'};}
  if(path.includes('cursor=page-three')){stage=3;throw new ApiError('Generated history cursor changed',409);}
  if(path==='/api/insights/first'){if(stage===3)throw new ApiError('Generated result invalidated',404);return first;}
  return {items:[]};
 });
 await act(async()=>root.render(view(api)));await until(()=>!!d.querySelector('.workspace-select'));
 await act(async()=>button(d,'加载更多').click());assert.match(d.body.textContent!,/连接暂时中断，请检查网络/);assert.equal(d.querySelectorAll('.workspace-list .workspace-select').length,1);
 await act(async()=>button(d,'加载更多').click());assert.equal(d.querySelectorAll('.workspace-list .workspace-select').length,2);
 await act(async()=>button(d,'加载更多').click());await until(()=>d.querySelectorAll('.workspace-list .workspace-select').length===0);assert.ok(firstReads>=2);assert.doesNotMatch(d.querySelector('.workspace-list')!.textContent!,/Generated older finding/);
 await until(()=>!d.querySelector('.insight-report'));assert.match(d.body.textContent!,/这份洞察当前不可用/,'cursor invalidation also revalidates the explicitly selected report');
});

test('an old owner pagination response cannot enter a different Central session even if transport ignores cancellation',async t=>{
 const {root,d,until,view}=await fixture(t);let finish!:(value:unknown)=>void,signal:AbortSignal|undefined;
 const held=new Promise(resolve=>finish=resolve),old=report('old-owner','Generated old owner finding'),current=report('current-owner','Generated current owner finding');
 const oldApi=fake((path,init)=>{if(path===INSIGHT_HISTORY_PATH)return {items:[old],nextCursor:'held'};if(path.includes('cursor=held')){signal=init?.signal??undefined;return held;}if(path==='/api/insights/old-owner')return old;return {items:[]};});
 const currentApi=fake(path=>path===INSIGHT_HISTORY_PATH?{items:[current],nextCursor:null}:path==='/api/insights/current-owner'?current:{items:[]});
 await act(async()=>root.render(view(oldApi)));await until(()=>!!button(d,'加载更多'));
 await act(async()=>button(d,'加载更多').click());await act(async()=>root.render(view(currentApi)));assert.equal(signal?.aborted,true);
 await act(async()=>finish({items:[report('old-private-page','Generated old private page')],nextCursor:null}));
 await until(()=>d.querySelector('.insight-report')?.textContent?.includes('Generated current owner finding')??false);
 assert.doesNotMatch(d.body.textContent!,/Generated old owner finding|Generated old private page/);
});
