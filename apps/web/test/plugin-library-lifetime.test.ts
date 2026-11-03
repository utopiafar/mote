import '@mote/shared/i18n-all';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import type {CaptureTimelinePage} from '@mote/shared';
import {buildApp} from '../../server/src/app.js';
import {ApiError,type Api,type Capture} from '../src/api.js';
import {captureDateRange,localDateInput} from '../src/capture-presentation.js';
import {featuresReady} from '../src/features/bootstrap.js';
import {Archive,LibraryTimeline,builtinCollections,library} from '../src/plugins/library/index.js';

configureLocale(()=> 'zh-CN');
const when='2026-10-20T10:00:00.000Z';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',C='cccccccc-cccc-4ccc-8ccc-cccccccccccc',D='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const row=(value:string)=>({id:value,deviceId:'fixture-device',deviceName:'Generated device',platform:'macos',capturedAt:when,source:'note' as const,appName:'Generated app',windowTitle:'Generated '+value,durationMs:0,hasImage:false,ocr:{status:'not_applicable' as const},textPreview:'Generated text '+value});
const capture=(value:string):Capture=>({...row(value),ocrText:'Generated evidence '+value,blobHash:null,indexingStatus:'text_ready',privacy:{redacted:false,mode:'none'},deletion:{available:true,kind:'capture'}} as Capture);
const timeline=(items:string[],nextCursor:string|null,revision='generated-revision'):CaptureTimelinePage=>({revision,items:items.map(id=>({type:'record' as const,id:'projection-'+id,day:'2026-10-20',firstAt:when,lastAt:when,sampleCount:null,record:row(id)})),nextCursor});
function deferred<T=unknown>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
async function until(check:()=>boolean,label:string){const end=Date.now()+8000;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Generated library contract did not settle: '+label);}

async function domFixture(t:import('node:test').TestContext,hash='#/library?view=records'){
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/'+hash,pretendToBeVisual:true});
  const previous=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,sessionStorage:dom.window.sessionStorage,IS_REACT_ACT_ENVIRONMENT:true})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  const root=createRoot(dom.window.document.getElementById('root')!);
  t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
  return {root,d:dom.window.document,w:dom.window};
}

async function centralFixture(t:import('node:test').TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-plugin-library-')),token='generated-plugin-library-owner-123456789';
  const node=await buildApp({dataDir:directory,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:3_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No models in library contract');},close:async()=>{}}});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
  return {node,headers:{authorization:'Bearer '+token,'x-mote-ingress-version':'2'}};
}
function centralApi(node:Awaited<ReturnType<typeof centralFixture>>['node'],headers:Record<string,string>){
  const calls:string[]=[];const pages:CaptureTimelinePage[]=[];
  const api={request:async<T>(path:string):Promise<T>=>{
    calls.push(path);
    const response=await node.app.inject({url:path,headers});
    if(response.statusCode>=400)throw new ApiError(response.body,response.statusCode);
    const value=response.body?JSON.parse(response.body):undefined;
    if(path.startsWith('/api/capture-browser/timeline?'))pages.push(value);
    return value as T;
  },setAgentTimeout:()=>{}} as Api;
  return {api,calls,pages};
}

test('the library package owns the archive page and every collection it renders',()=>{
  assert.equal(library.id,'mote.library');
  assert.equal(library.pages?.find(page=>page.id==='archive')?.route,'library');
  const ids=builtinCollections.map(entry=>entry.id);
  for(const id of ['materials','records','segments','sources','files','activity','media','memories','coding-status'])assert.ok(ids.includes(id),id);
  assert.deepEqual(library.collections?.map(entry=>entry.id),ids);
});

test('real Central timeline pagination keeps the exact server cursor and scope across pages and filters',async t=>{
  const {node,headers}=await centralFixture(t);
  for(let index=0;index<25;index++){
    const at=new Date();at.setHours(10,0,index,0);
    const response=await node.app.inject({method:'POST',url:'/api/captures',headers,payload:{id:crypto.randomUUID(),deviceId:'generated-device-'+index,deviceName:'Generated device '+index,platform:'macos',capturedAt:at.toISOString(),durationMs:1000,appId:'generated.app',appName:'Generated exact activity '+index,windowTitle:'',source:'activity',ocrText:'',metadata:{version:1,observedAt:at.toISOString()},privacy:{collection:'activity',mode:'none'}}});
    assert.equal(response.statusCode,201,response.body);
  }
  const {api,calls,pages}=centralApi(node,headers);
  const {root,d,w}=await domFixture(t);
  const devices=Array.from({length:25},(_,index)=>({deviceId:'generated-device-'+index,deviceName:'Generated device '+index,platform:'macos',status:'capturing',queueDepth:0,lastSeenAt:when}));
  await act(async()=>root.render(React.createElement(LibraryTimeline,{api,devices,onOpen:()=>{},revision:0})));
  await until(()=>d.querySelectorAll('.library-time-group').length===24,'first timeline page');
  const firstPath=calls.find(path=>path.startsWith('/api/capture-browser/timeline?'))!;
  const firstQuery=new URL('http://localhost'+firstPath).searchParams,day=localDateInput(new Date()),expected=captureDateRange(day,day);
  assert.equal(firstQuery.get('after'),expected.after);
  assert.equal(firstQuery.get('before'),expected.before);
  assert.equal(firstQuery.get('limit'),'24');
  assert.equal(firstQuery.has('cursor'),false);
  assert.ok(firstQuery.get('timeZone'));
  const firstPage=pages[0]!;
  assert.ok(firstPage.nextCursor);
  assert.equal(firstPage.items.length,24);
  assert.match(d.querySelector('.library-time-count')!.textContent!,/1 条记录/);
  const pagination=d.querySelector('.library-pagination')!;
  assert.equal(Array.from(pagination.querySelectorAll('button')).find(button=>button.textContent==='下一页')!.disabled,false);
  await act(async()=>Array.from(pagination.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='下一页')!.click());
  await until(()=>d.querySelectorAll('.library-time-group').length===1,'second timeline page');
  const secondPath=calls.filter(path=>path.startsWith('/api/capture-browser/timeline?')).at(-1)!;
  const secondQuery=new URL('http://localhost'+secondPath).searchParams;
  assert.equal(secondQuery.get('cursor'),firstPage.nextCursor,'the consumer sends the exact server cursor');
  assert.equal(secondQuery.get('after'),firstQuery.get('after'));
  assert.equal(secondQuery.get('before'),firstQuery.get('before'));
  assert.equal(secondQuery.get('timeZone'),firstQuery.get('timeZone'));
  assert.equal(secondQuery.get('limit'),'24');
  assert.equal(pages[1]!.items.length,1);
  assert.match(d.querySelector('.library-pagination')!.textContent!,/第 2 页/);
  await act(async()=>{const select=d.querySelector<HTMLSelectElement>('[aria-label="筛选设备"]')!;select.value='generated-device-0';select.dispatchEvent(new w.Event('change',{bubbles:true}));});
  await until(()=>calls.filter(path=>path.startsWith('/api/capture-browser/timeline?')).length===3,'device scope read');
  const scoped=new URL('http://localhost'+calls.filter(path=>path.startsWith('/api/capture-browser/timeline?')).at(-1)!).searchParams;
  assert.equal(scoped.get('deviceId'),'generated-device-0');
  assert.equal(scoped.has('cursor'),false,'a new scope never reuses the previous page cursor');
  assert.equal(scoped.get('after'),firstQuery.get('after'));
  assert.match(d.querySelector('.library-pagination')!.textContent!,/第 1 页/);
});

test('returning from a detail restores the mounted cursor page and scroll while a background refresh cannot interrupt reading',async t=>{
  await featuresReady;
  const {root,d,w}=await domFixture(t);
  let scrollTop=0;Object.defineProperty(w,'scrollY',{get:()=>scrollTop,set:value=>{scrollTop=value;},configurable:true});Object.defineProperty(w,'scrollTo',{value:(value:number|{top?:number})=>{scrollTop=typeof value==='number'?value:value.top??0;},configurable:true});
  const reads:string[]=[],refresh=deferred<CaptureTimelinePage>();
  let refreshing=false;
  const api={request:async(path:string)=>{
    reads.push(path);
    if(path==='/api/features')return {schemaVersion:1,revision:1,features:[],capabilities:['/api/capture-browser/timeline','/api/capture-browser/timeline/members','/api/library/browse','/api/coding/uploads'].map(resource=>({id:'http:GET:'+resource,version:'1',state:'active'}))};
    if(path.startsWith('/api/actions/by-evidence/'))return {items:[],hasMore:false};
    if(path.startsWith('/api/operations/changes?'))return {ids:[],cursor:0,hasMore:false,reset:false};
    if(path.startsWith('/api/capture-browser/timeline?')){
      const query=new URL('http://localhost'+path).searchParams;
      if(query.has('cursor'))return refreshing?refresh.promise:timeline([C,D],null);
      return timeline([A,B],'generated-page-2');
    }
    const detail=/^\/api\/capture-browser\/([^?/]+)$/.exec(path);
    if(detail)return capture(detail[1]!);
    throw Error('Unexpected generated library request '+path);
  },setAgentTimeout:()=>{}} as Api;
  const render=(revision:number)=>act(async()=>root.render(React.createElement(Archive,{api,devices:[{deviceId:'fixture-device',deviceName:'Generated device',platform:'macos',status:'capturing',queueDepth:0,lastSeenAt:when}],range:{},activity:{apps:[],devices:[],totalDurationMs:0,captures:0},revision,onOpen:()=>{},tab:'records',setTab:()=>{}})));
  await render(0);
  await until(()=>d.querySelectorAll('.library-record').length===2,'first generated page');
  await act(async()=>Array.from(d.querySelector('.library-pagination')!.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='下一页')!.click());
  await until(()=>d.querySelectorAll('.library-record').length===2&&d.querySelector('.library-pagination')!.textContent!.includes('第 2 页'),'second generated page');
  const opener=d.querySelector<HTMLButtonElement>('.library-record[data-reference="capture:'+C+'"]')!;opener.focus();scrollTop=512;
  await act(async()=>opener.click());
  await until(()=>Boolean(d.querySelector('.library-detail')?.textContent?.includes('Generated '+C)),'detail reader');
  refreshing=true;await render(1);
  assert.ok(d.querySelector('.library-detail')!.textContent!.includes('Generated '+C),'a pending background refresh never replaces the detail');
  assert.equal((d.querySelector('.library-master') as HTMLElement).hidden,true);
  await act(async()=>refresh.resolve(timeline([C,D],null,'next-revision')));
  assert.ok(d.querySelector('.library-detail')!.textContent!.includes('Generated '+C),'the completed refresh leaves the open reader untouched');
  await act(async()=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='返回资料列表')!.click());
  assert.equal(d.activeElement,opener,'return preserves the exact list opener');
  assert.equal(scrollTop,512,'return restores the reader entry scroll position');
  assert.match(d.querySelector('.library-pagination')!.textContent!,/第 2 页/,'return keeps the mounted cursor page');
  assert.equal(d.querySelector('.library-record[data-reference="capture:'+C+'"]'),opener);
  assert.equal(reads.filter(path=>path.startsWith('/api/capture-browser/timeline?')&&!new URL('http://localhost'+path).searchParams.has('cursor')).length,1,'returning does not restart at the first page');
});
