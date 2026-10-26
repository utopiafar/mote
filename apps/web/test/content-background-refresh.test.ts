import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {Memories} from '../src/Memories.js';
import {Insights} from '../src/Insights.js';
import {Imports} from '../src/Imports.js';
import {ApiError,type Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';
import {importQueue} from '../src/import-queue.js';
import {modelView} from './fixtures/model-settings.js';

configureLocale(()=> 'zh-CN');
const when='2026-10-01T00:00:00Z',id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function deferred(){let resolve!:(value:any)=>void,reject!:(error:unknown)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function fixture(t:any){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>(),apis:Api[]=[];
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
 const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>{root.unmount();for(const api of apis)importQueue(api).close();});for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 function apiWith(read:(path:string,init?:RequestInit)=>unknown):Api{
  const api={request:async(path:string,init?:RequestInit)=>{
   if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};
   if(path==='/api/model-settings')return modelView();
   if(path==='/api/execution-settings')return {queues:{agents:{active:0,waiting:0,limit:1},llm:{active:0,waiting:0,limit:1}}};
   if(path==='/api/memory-settings')return {settings:{consolidation:{enabled:false,maxItems:3}},extensions:[]};
   if(path==='/api/file-processing')return {policy:{profiles:[]},processors:[]};
   return read(path,init);
  },setAgentTimeout:()=>{}} as Api;apis.push(api);return api;
 }
 return {root,d:dom.window.document,apiWith};
}
const button=(d:Document,label:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(value=>value.textContent?.trim()===label)!;
const memory={id,title:'Generated memory',statement:'Generated evidence',status:'published',createdAt:when,evidenceIds:[]};
const report={id:'generated-report',runId:'generated-report',answer:'Generated report body',citations:[],trace:[],createdAt:when};
const importJob={id:'generated-import',name:'Generated import',status:'completed',createdAt:when,updatedAt:when,instruction:'',archive:{files:1,bytes:9},warnings:[],files:[],captureIds:[],progress:{total:1,processed:1,imported:1,duplicates:0}};
const memoryView=(api:Api,extra:Record<string,unknown>={})=>React.createElement(Memories,{api,range:{},onOpen:()=>{},...extra});
const insightView=(api:Api,extra:Record<string,unknown>={})=>React.createElement(Insights,{api,range:{},configured:true,onOpen:()=>{},onSettings:()=>{},onChanged:()=>{},...extra});
const importView=(api:Api,extra:Record<string,unknown>={})=>React.createElement(Imports,{api,onOpen:()=>{},onMemories:()=>{},onSettings:()=>{},onChanged:()=>{},...extra});

for(const populated of [false,true])test(`Memory ${populated?'populated':'empty'} history preserves its settled view during background reads`,async t=>{
 const {root,d,apiWith}=await fixture(t),first=deferred(),refresh=deferred();let refreshing=false;
 const api=apiWith(path=>path.startsWith('/api/memories?')?(refreshing?refresh.promise:first.promise):path.startsWith('/api/memories/')?memory:{items:[]});
 await act(async()=>root.render(memoryView(api)));assert.match(d.querySelector('.workspace-list')!.textContent!,/正在读取/);
 await act(async()=>first.resolve({items:populated?[memory]:[],nextCursor:null}));
 if(populated)await act(async()=>d.querySelector<HTMLButtonElement>('.workspace-select')!.click());
 const list=d.querySelector('.workspace-list')!,settled=populated?list.querySelector('.workspace-select'):list.querySelector('p.muted'),detail=d.querySelector('.memory-detail');
 refreshing=true;await act(async()=>resources(api).invalidate(path=>path.startsWith('/api/memories?')));
 assert.doesNotMatch(list.textContent!,/正在读取/);assert.equal(list.querySelector(populated?'.workspace-select':'p.muted'),settled);assert.equal(d.querySelector('.memory-detail'),detail);assert.equal(d.querySelector('.memories-page')!.getAttribute('aria-busy'),'false');
 await act(async()=>refresh.resolve({items:populated?[memory]:[],nextCursor:null}));assert.equal(list.querySelector(populated?'.workspace-select':'p.muted'),settled);
});

test('Memory pagination still reads a new page and a revoked refresh removes saved content',async t=>{
 const {root,d,apiWith}=await fixture(t),next=deferred(),revocation=deferred();let revoking=false;
 const api=apiWith(path=>path.startsWith('/api/memories?')?(path.includes('cursor=older')?next.promise:revoking?revocation.promise:{items:[memory],nextCursor:'older'}):{items:[]});
 await act(async()=>root.render(memoryView(api,{rangeSelectionKey:'week'})));await act(async()=>button(d,'下一页').click());
 assert.match(d.querySelector('.workspace-list')!.textContent!,/正在读取/);assert.doesNotMatch(d.querySelector('.workspace-list')!.textContent!,/Generated memory/);
 await act(async()=>next.resolve({items:[],nextCursor:null}));await act(async()=>button(d,'返回第一页').click());
 revoking=true;await act(async()=>resources(api).invalidate(path=>path.startsWith('/api/memories?')&&!path.includes('cursor=')));
 assert.match(d.querySelector('.workspace-list')!.textContent!,/Generated memory/);
 await act(async()=>revocation.reject(new ApiError('Generated permission revoked',403)));
 assert.doesNotMatch(d.querySelector('.workspace-list')!.textContent!,/Generated memory|当前筛选下没有匹配/);assert.match(d.body.textContent!,/Generated permission revoked/);
});

test('Memory rolling range keeps its list and detail while reading the latest window, then withdraws a revoked list',async t=>{
 const {root,d,apiWith}=await fixture(t),refresh=deferred(),reads:string[]=[];
 const api=apiWith(path=>{
  if(path.startsWith('/api/memories?')){reads.push(path);return reads.length===1?{items:[memory],nextCursor:null}:refresh.promise;}
  return path.startsWith('/api/memories/')?memory:{items:[]};
 });
 const range=(before:string)=>({after:'2026-10-01T00:00:00Z',before});
 await act(async()=>root.render(memoryView(api,{range:range('2026-10-07T00:00:00Z'),rangeSelectionKey:'week'})));
 await act(async()=>d.querySelector<HTMLButtonElement>('.workspace-select')!.click());const row=d.querySelector('.workspace-select'),detail=d.querySelector('.memory-detail');
 await act(async()=>root.render(memoryView(api,{range:range('2026-10-07T00:00:30Z'),rangeSelectionKey:'week',refreshVersion:1})));
 assert.equal(reads.length,2);assert.match(reads[1],/before=2026-10-07T00%3A00%3A30Z/);assert.equal(d.querySelector('.workspace-select'),row);assert.equal(d.querySelector('.memory-detail'),detail);assert.doesNotMatch(d.querySelector('.workspace-list')!.textContent!,/正在读取/);
 await act(async()=>refresh.reject(new ApiError('Generated rolling list revoked',403)));
 assert.equal(d.querySelector('.workspace-select'),null);assert.match(d.body.textContent!,/Generated rolling list revoked/);assert.doesNotMatch(d.querySelector('.workspace-list')!.textContent!,/当前筛选下没有匹配/);
});

for(const change of ['period','device','unkeyed-range','filter'] as const)test(`Memory continuity cannot carry list rows across a changed ${change}`,async t=>{
 const {root,d,apiWith}=await fixture(t),pending=deferred();let reads=0;
 const api=apiWith(path=>path.startsWith('/api/memories?')?(++reads===1?{items:[memory],nextCursor:null}:pending.promise):{items:[]});
 const initial={range:{after:'2026-10-01T00:00:00Z'},...(change==='unkeyed-range'?{}:{rangeSelectionKey:'week'})};
 await act(async()=>root.render(memoryView(api,initial)));
 if(change==='filter')await act(async()=>button(d,'需要重验').click());
 else await act(async()=>root.render(memoryView(api,{...initial,range:{...initial.range,...(change==='device'?{deviceId:'generated-other-device'}:{after:'2026-09-01T00:00:00Z'})},...(change==='period'?{rangeSelectionKey:'month'}:{})})));
 assert.equal(d.querySelector('.workspace-select'),null);assert.match(d.querySelector('.workspace-list')!.textContent!,/正在读取/);assert.equal(reads,2);
 await act(async()=>pending.resolve({items:[],nextCursor:null}));assert.match(d.querySelector('.workspace-list')!.textContent!,/当前筛选下没有匹配/);
});

for(const kind of ['capture','material'] as const)test(`Memory selected ${kind} stays readable while its current version is revalidated`,async t=>{
 const {root,d,apiWith}=await fixture(t),first=deferred(),refresh=deferred();let refreshing=false;
 const ref=kind==='capture'?'capture:'+id:'material:mat_'+'a'.repeat(64)+'@'+'b'.repeat(64),path=kind==='capture'?'/api/capture-browser/'+id:'/api/materials/mat_'+'a'.repeat(64);
 d.defaultView!.location.hash='#/library?view=memories&'+new URLSearchParams({[kind==='capture'?'memorySource':'memoryMaterial']:ref});
 const value=kind==='capture'?{id,windowTitle:'Generated chosen source',capturedAt:when,ocrText:'Generated text'}:{ref,title:'Generated chosen source',memorySource:{status:'ready',evidenceIds:[id]}};
 const api=apiWith(key=>key===path?(refreshing?refresh.promise:first.promise):{items:[],nextCursor:null});
 await act(async()=>root.render(memoryView(api)));assert.match(d.querySelector('.memory-source-selection')!.textContent!,/正在读取/);
 await act(async()=>first.resolve(value));const card=d.querySelector('.memory-source-selection')!,title=card.querySelector('strong');
 refreshing=true;await act(async()=>resources(api).get(path).refresh());
 assert.equal(card.querySelector('strong'),title);assert.doesNotMatch(card.textContent!,/正在读取|所选正式资料已变化/);assert.equal(button(d,'提取所选资料的记忆').disabled,true,'version-dependent extraction waits for verification');
 await act(async()=>refresh.reject(new ApiError('Generated selected source revoked',403)));
 assert.doesNotMatch(card.textContent!,/Generated chosen source/);assert.match(card.textContent!,/Generated selected source revoked/);assert.equal(button(d,'提取所选资料的记忆').disabled,true);
});

for(const populated of [false,true])test(`Insight ${populated?'populated':'empty'} history and compose stay stable during background reads`,async t=>{
 const {root,d,apiWith}=await fixture(t),first=deferred(),refresh=deferred();let refreshing=false;
 const api=apiWith(path=>path==='/api/insights?limit=30'?(refreshing?refresh.promise:first.promise):{items:[]});
 await act(async()=>root.render(insightView(api)));assert.match(d.querySelector('.workspace-list')!.textContent!,/正在读取/);
 await act(async()=>first.resolve({items:populated?[report]:[]}));await act(async()=>button(d,'新建洞察').click());const list=d.querySelector('.workspace-list')!,settled=list.querySelector(populated?'.workspace-select':'p.muted'),compose=d.querySelector('textarea');
 refreshing=true;await act(async()=>resources(api).invalidate(path=>path==='/api/insights?limit=30'));
 assert.doesNotMatch(list.textContent!,/正在读取/);assert.equal(list.querySelector(populated?'.workspace-select':'p.muted'),settled);assert.equal(d.querySelector('textarea'),compose);assert.equal(compose!.disabled,false);assert.equal(d.querySelector('.insights-page')!.getAttribute('aria-busy'),'false');
 await act(async()=>refresh.resolve({items:populated?[report]:[]}));assert.equal(list.querySelector(populated?'.workspace-select':'p.muted'),settled);
});

test('an Insight completion refreshes history and notifies its shell once',async t=>{
 const {root,d,apiWith}=await fixture(t),completion=deferred(),historyRefresh=deferred();let historyReads=0,runReads=0,changes=0;
 const running={id:'generated-run',status:'running',createdAt:when,updatedAt:when,scope:{},events:[]};
 const api=apiWith(path=>{
  if(path==='/api/insights?limit=30')return ++historyReads===1?{items:[]}:historyRefresh.promise;
  if(path==='/api/insights/'+report.runId)return report;
  if(path==='/api/insight-runs')return {items:[running]};
  if(path==='/api/insight-runs/generated-run'){runReads++;return completion.promise;}
  return {items:[]};
 });
 await act(async()=>root.render(insightView(api,{onChanged:()=>changes++})));assert.equal(runReads,1);
 await act(async()=>completion.resolve({...running,status:'completed',result:report}));
 assert.equal(runReads,1,'the running-to-completed effect transition cannot replay the terminal read');assert.equal(historyReads,2);assert.equal(changes,1);assert.doesNotMatch(d.querySelector('.workspace-list')!.textContent!,/正在读取/);
 await act(async()=>historyRefresh.resolve({items:[report]}));assert.match(d.querySelector('.insight-report')!.textContent!,/Generated report body/);assert.equal(changes,1);
});

for(const kind of ['Memory','Insight'] as const)test(`${kind} mounts once at a nonzero shell revision and refreshes once for a later revision`,async t=>{
 const {root,apiWith}=await fixture(t),counts=new Map<string,number>();
 const api=apiWith(path=>{counts.set(path,(counts.get(path)??0)+1);return {items:[],nextCursor:null};});
 const view=kind==='Memory'?memoryView:insightView;
 await act(async()=>root.render(view(api,{refreshVersion:14})));
 const paths=[...counts.keys()].filter(path=>kind==='Memory'?path.startsWith('/api/memories?')||path==='/api/memory-jobs':path==='/api/insights?limit=30'||path==='/api/insight-runs');
 assert.equal(paths.length,2);for(const path of paths)assert.equal(counts.get(path),1);
 await act(async()=>root.render(view(api,{refreshVersion:15})));for(const path of paths)assert.equal(counts.get(path),2);
});

test('a Memory shell revision still refreshes the selected card and active extraction job once',async t=>{
 const {root,d,apiWith}=await fixture(t),counts=new Map<string,number>();
 const job={id:'generated-job',status:'waiting_for_model',createdAt:when,updatedAt:when,evidenceIds:[],memoryIds:[],memoryCount:0,totalBatches:0,completedBatches:0,failedBatches:0,skippedChunks:0,skillVersion:'generated',inputPlans:{total:0,waiting:0,blocked:0,stale:0,completed:0},recipeProgress:[]};
 const api=apiWith(path=>{
  counts.set(path,(counts.get(path)??0)+1);
  if(path==='/api/memory-jobs')return {items:[job]};
  if(path==='/api/memory-jobs/'+job.id)return job;
  return path.startsWith('/api/memories?')?{items:[memory],nextCursor:null}:path.startsWith('/api/memories/')?memory:{items:[]};
 });
 await act(async()=>root.render(memoryView(api,{refreshVersion:14})));await act(async()=>d.querySelector<HTMLButtonElement>('.workspace-select')!.click());
 const detailPath=[...counts.keys()].find(path=>path.startsWith('/api/memories/'))!,jobPath='/api/memory-jobs/'+job.id;
 assert.equal(counts.get(detailPath),1);assert.equal(counts.get(jobPath),1);
 await act(async()=>root.render(memoryView(api,{refreshVersion:15})));assert.equal(counts.get(detailPath),2);assert.equal(counts.get(jobPath),2);
});

for(const populated of [false,true])test(`Import ${populated?'populated':'empty'} history does not replay its initial loader on shell revisions`,async t=>{
 const {root,d,apiWith}=await fixture(t),first=deferred(),refresh=deferred();let refreshing=false;
 const api=apiWith(path=>path==='/api/imports'?(refreshing?refresh.promise:first.promise):{items:[]});
 await act(async()=>root.render(importView(api)));assert.match(d.querySelector('.workspace-list')!.textContent!,/正在读取/);
 await act(async()=>first.resolve({items:populated?[importJob]:[]}));
 if(populated)await act(async()=>d.querySelector<HTMLButtonElement>('.workspace-select')!.click());
 const list=d.querySelector('.workspace-list')!,settled=list.querySelector(populated?'.workspace-select':'p.muted'),detail=d.querySelector('.import-detail');
 refreshing=true;await act(async()=>root.render(importView(api,{refreshVersion:1})));
 assert.doesNotMatch(list.textContent!,/正在读取/);assert.equal(list.querySelector(populated?'.workspace-select':'p.muted'),settled);assert.equal(d.querySelector('.import-detail'),detail);assert.equal(d.querySelector('.imports-page')!.getAttribute('aria-busy'),'false');
 await act(async()=>refresh.reject(new ApiError('Generated import refresh unavailable',503)));
 assert.match(d.body.textContent!,/Generated import refresh unavailable/);assert.equal(d.querySelector('.import-detail'),detail);
});

test('Import revocation removes archived content and a different node keeps its first-read loader',async t=>{
 const {root,d,apiWith}=await fixture(t),revocation=deferred(),next=deferred();let revoked=false;
 const api=apiWith(path=>path==='/api/imports'?(revoked?revocation.promise:{items:[importJob]}):{items:[]});
 await act(async()=>root.render(importView(api)));await act(async()=>d.querySelector<HTMLButtonElement>('.workspace-select')!.click());
 revoked=true;await act(async()=>root.render(importView(api,{refreshVersion:1})));await act(async()=>revocation.reject(new ApiError('Generated imports revoked',403)));
 assert.equal(d.querySelector('.import-detail'),null);assert.doesNotMatch(d.body.textContent!,/Generated import(?!s)/);assert.match(d.body.textContent!,/Generated imports revoked/);
 const nextApi=apiWith(path=>path==='/api/imports'?next.promise:{items:[]});await act(async()=>root.render(importView(nextApi)));
 assert.match(d.querySelector('.workspace-list')!.textContent!,/正在读取/);assert.doesNotMatch(d.querySelector('.workspace-list')!.textContent!,/你的第一份导入/);
 await act(async()=>next.resolve({items:[]}));assert.match(d.querySelector('.workspace-list')!.textContent!,/你的第一份导入/);
});
