import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {buildApp} from '../../server/src/app.js';
import {materialId,type MaterialDraft} from '../../server/src/materials.js';
import {ApiError,type Api} from '../src/api.js';
import {SearchController,clearSearchCache} from '../src/plugins/search/index.js';
import {SearchWorkspace} from '../src/plugins/search/SearchWorkspace.js';
import {resources} from '../src/resource-cache.js';

configureLocale(()=> 'zh-CN');

const deferred=<T>()=>{
  let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<T>((ok,fail)=>{resolve=ok;reject=fail;});
  return {promise,resolve,reject};
};
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
const runtime=(url='http://localhost/#/search')=>{
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url,pretendToBeVisual:true});
  return {dom,window:dom.window as unknown as Window,document:dom.window.document};
};

test('a late result from the previous query never replaces the current query',async t=>{
  const {dom,window,document}=runtime();
  const calls:{path:string;signal:AbortSignal;result:ReturnType<typeof deferred<unknown>>}[]=[];
  const api={request:<T>(path:string,init:RequestInit={})=>{const result=deferred<T>();calls.push({path,signal:init.signal as AbortSignal,result:result as ReturnType<typeof deferred<unknown>>});return result.promise;}} as Api;
  const controller=new SearchController({api,adoptHash:false,window,document});
  controller.start();
  t.after(()=>{controller.dispose();dom.window.close();});
  controller.setInput('first query');
  controller.submit();
  const first=calls.filter(call=>call.path.startsWith('/api/library/browse?')).at(-1)!;
  controller.setInput('second query');
  controller.submit();
  const second=calls.filter(call=>call.path.startsWith('/api/library/browse?')).at(-1)!;
  assert.ok(first.signal.aborted,'changing the query cancels the old read');
  second.result.resolve({schemaVersion:1,revision:'second',types:[],sources:[],sourcesTruncated:false,noteOrigin:{origin:'notes',label:'记录'},items:[],nextCursor:null});
  await turn();
  assert.equal(controller.getSnapshot().query,'second query');
  assert.equal(controller.getSnapshot().page.data?.revision,'second');
  first.result.resolve({schemaVersion:1,revision:'first',types:[],sources:[],sourcesTruncated:false,noteOrigin:{origin:'notes',label:'记录'},items:[],nextCursor:null});
  await turn();
  assert.equal(controller.getSnapshot().query,'second query','the current query remains selected');
  assert.equal(controller.getSnapshot().page.data?.revision,'second','a late old response cannot overwrite the new page');
});

test('switching owner clears query state, result handles and the old owner cache',async t=>{
  const {dom,window,document}=runtime();
  const firstApi={request:async(path:string)=>path.startsWith('/api/library/browse?')
    ? {schemaVersion:1,revision:'first-owner',types:[],sources:[],sourcesTruncated:false,noteOrigin:{origin:'notes',label:'记录'},items:[],nextCursor:null}
    : {items:[],nextCursor:null}} as Api;
  const secondApi={request:async(path:string)=>path.startsWith('/api/library/browse?')
    ? {schemaVersion:1,revision:'second-owner',types:[],sources:[],sourcesTruncated:false,noteOrigin:{origin:'notes',label:'记录'},items:[],nextCursor:null}
    : {items:[],nextCursor:null}} as Api;
  const controller=new SearchController({api:firstApi,adoptHash:false,window,document});
  controller.start();
  t.after(()=>{clearSearchCache(firstApi);clearSearchCache(secondApi);controller.dispose();dom.window.close();});
  controller.setInput('generated first owner');
  controller.submit();
  for(let attempt=0;attempt<100&&controller.getSnapshot().page.data?.revision!=='first-owner';attempt++)await turn();
  assert.equal(controller.getSnapshot().page.data?.revision,'first-owner');
  const cached=controller.cachedPaths.find(path=>path.startsWith('/api/library/browse?'))!;
  assert.ok(resources(firstApi).get(cached).getSnapshot().data,'the old owner page is cached before the switch');

  controller.setOwner(secondApi);
  assert.equal(controller.owner,secondApi);
  assert.equal(controller.getSnapshot().query,'');
  assert.equal(controller.getSnapshot().input,'');
  assert.equal(controller.getSnapshot().page.data,undefined,'no previous page crosses the owner switch');
  assert.deepEqual(controller.cachedPaths,[],'the plugin drops every old owner handle');
  assert.equal(window.location.hash,'#/search');
  assert.equal(resources(firstApi).get(cached).getSnapshot().data,undefined,'the old owner resource cache is cleared');

  controller.setInput('generated second owner');
  controller.submit();
  assert.equal(controller.getSnapshot().query,'generated second owner');
});

async function serverFixture(t:import('node:test').TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-plugin-search-contract-')),token='generated-plugin-search-'+randomUUID();
  const node=await buildApp({
    dataDir:join(directory,'data'),token,tokenPath:'generated',host:'127.0.0.1',port:0,
    maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,
    allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,
    embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',
  },{
    backgroundWorker:false,
    agent:{configured:false,query:async()=>{throw Error('No model in generated search contract fixture');},close:async()=>{}},
  });
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
  return {node,token};
}

function apiFor(node:Awaited<ReturnType<typeof buildApp>>,token:string){
  const calls:string[]=[];
  const request=async <T>(path:string,init:RequestInit={}):Promise<T>=>{
    calls.push(path);
    const method=(init.method??'GET').toUpperCase(),headers=new Headers(init.headers);
    headers.set('authorization','Bearer '+token);
    if(typeof init.body==='string'&&!headers.has('content-type'))headers.set('content-type','application/json');
    const response=await node.app.inject({
      method:method as 'GET'|'POST'|'PUT'|'PATCH'|'DELETE',url:path,headers:Object.fromEntries(headers),
      ...(typeof init.body==='string'?{payload:init.body}:{}),
    });
    if(response.statusCode>=400)throw new ApiError(response.body||`HTTP ${response.statusCode}`,response.statusCode);
    return (response.body?JSON.parse(response.body):undefined) as T;
  };
  return {api:{request,setAgentTimeout:()=>{}} as Api,calls};
}

test('a real current Material response opens its exact pinned revision in the search reader',async t=>{
  const {node,token}=await serverFixture(t);
  const sourceId='generated-search-contract';
  const base:MaterialDraft={
    id:materialId(sourceId,'item'),kind:'mote.note',schemaVersion:1,title:'Generated search contract material',
    origin:{sourceId,externalId:'item',deviceId:'generated-device'},
    blocks:[{id:'body',kind:'text',format:'plain',text:'Generated first search body.',memberIds:[]}],members:[],
    coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'},
  };
  const first=node.materials.publish(base);
  const second=node.materials.publish({...base,blocks:[{...base.blocks[0]!,text:'Generated current search body with exact reader token.'}]},{expectedRevision:first.revision});
  node.materials.setSearchable(second.id,true);
  await node.materialOrganizer.tick(100);
  assert.equal(node.materials.indexStatus(second.id).state,'indexed');

  const {api,calls}=apiFor(node,token);
  const {dom}=runtime('http://localhost/#/search?query='+encodeURIComponent('exact reader token'));
  const previous=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  dom.window.scrollTo=()=>{};dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
  const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!);
  t.after(async()=>{
    await act(async()=>root.unmount());
    for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}
    dom.window.close();
  });
  const until=async(check:()=>boolean,label:string)=>{
    const end=Date.now()+5000;
    while(Date.now()<end){if(check())return;await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});}
    throw Error('Generated search did not settle: '+label);
  };

  await act(async()=>root.render(React.createElement(SearchWorkspace,{api,onOpen:()=>{}})));
  await until(()=>Boolean(dom.window.document.querySelector('[data-reference="'+second.ref+'"]')),'current search result');
  const browse=calls.find(path=>path.startsWith('/api/library/browse?'))!;
  assert.equal(new URLSearchParams(browse.split('?')[1]).get('query'),'exact reader token');

  await act(async()=>dom.window.document.querySelector<HTMLButtonElement>('[data-reference="'+second.ref+'"]')!.click());
  await until(()=>Boolean(dom.window.document.querySelector('.material-detail')),'search reader');
  await until(()=>dom.window.document.body.textContent!.includes('Generated current search body with exact reader token.'),'current body');
  assert.ok(calls.includes(`/api/materials/${second.id}/revisions/${second.revision}`),'the reader pins the current Material revision');
  assert.ok(calls.some(path=>path.startsWith(`/api/materials/${second.id}/read?`)&&new URLSearchParams(path.split('?')[1]).get('revision')===second.revision),'the body read uses that exact revision');
  assert.equal(calls.some(path=>path.includes(first.revision)),false,'no reader path falls back to the older revision');
});
