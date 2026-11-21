import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {act} from 'react';
import {JSDOM} from 'jsdom';

type Read={path:string;status:number;ifNoneMatch?:string};

test('PF1 Web entry reads NV2 once, renders before configuration, and invalidates only changed collections',{timeout:30_000},async t=>{
 const dom=new JSDOM(readFileSync(new URL('../index.html',import.meta.url),'utf8'),{url:'http://localhost/#/chat',pretendToBeVisual:true}),d=dom.window.document;
 for(const key of ['window','document','navigator','location','history','localStorage','sessionStorage','HTMLElement','HTMLInputElement','HTMLTextAreaElement','Element','Node','Event','MutationObserver'] as const)Object.defineProperty(globalThis,key,{value:key==='window'?dom.window:(dom.window as any)[key],configurable:true});
 Object.assign(globalThis,{__MOTE_WEB_VERSION__:'generated-pf1-reads',IS_REACT_ACT_ENVIRONMENT:true});
 dom.window.localStorage.setItem('mote.language','zh-CN');
 dom.window.sessionStorage.setItem('mote.connection',JSON.stringify({token:'generated-pf1-owner',viewScope:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}));
 let visible=true,navRevision=1,configSettled=false,releaseConfig!:()=>void;
 const configGate=new Promise<void>(resolve=>{releaseConfig=()=>{configSettled=true;resolve();};});
 Object.defineProperties(d,{visibilityState:{get:()=>visible?'visible':'hidden'},hidden:{get:()=>!visible}});
 const reads:Read[]=[],count=(path:string)=>reads.filter(read=>read.path===path).length,countPrefix=(path:string)=>reads.filter(read=>read.path===path||read.path.startsWith(path+'?')||read.path.startsWith(path+'/')).length;
 const capabilities=['/api/library/browse','/api/capture-browser/timeline','/api/capture-browser/timeline/members'].map(path=>({id:'http:GET:'+path,version:'1',state:'active',surface:'data',featureId:'mote.capture'}));
 const status={profile:'generated-pf1',agent:{configured:true,model:'generated-model',provider:'generated'},storage:{captures:0,blobs:0,bytes:0,imageBytes:0,logicalBytes:0,imagesEncrypted:false,indexing:[]},index:{mode:'text',model:null},insightIntervalHours:0,serverTime:'2026-11-21T00:00:00Z'};
 const navBody=JSON.stringify({revisions:{library:'library-1',cards:'cards-1',commitments:'commitments-1',matters:'matters-1',memory:'memory-1',sources:'sources-1',plugins:'plugins-1'},badges:{ideas:3,connections:false}});
 const priorFetch=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{
  const path=String(input),headers=init?.headers as Record<string,string>|undefined,ifNoneMatch=headers?.['If-None-Match'];
  const send=(value:unknown,statusCode=200,extra:Record<string,string>={})=>{
   reads.push({path,status:statusCode,...(ifNoneMatch?{ifNoneMatch}:{})});
   return new Response(statusCode===304?null:JSON.stringify(value),{status:statusCode,headers:{'content-type':'application/json',...extra}});
  };
  if(path==='/api/nav-state'){
   const body=navRevision===1?navBody:JSON.stringify({...JSON.parse(navBody),revisions:{...JSON.parse(navBody).revisions,library:'library-'+navRevision}}),etag='"nav-'+navRevision+'"';
   return ifNoneMatch===etag?send(undefined,304,{ETag:etag}):send(JSON.parse(body),200,{ETag:etag});
  }
  if(path==='/api/configuration'){reads.push({path,status:200,...(ifNoneMatch?{ifNoneMatch}:{})});await configGate;return new Response(JSON.stringify({domains:[]}),{status:200,headers:{'content-type':'application/json'}});}
  if(path==='/api/status')return send(status);
  if(path==='/api/devices')return send({items:[]});
  if(path==='/api/features')return send({schemaVersion:1,revision:1,features:[],capabilities});
  if(path.startsWith('/api/operations/changes?'))return send({cursor:1,ids:[],reset:false,hasMore:false});
  if(path==='/api/conversations/main')return send({id:'10000000-0000-4000-8000-000000000001'});
  if(/^\/api\/conversations\/[^/?]+$/.test(path))return send({id:decodeURIComponent(path.slice('/api/conversations/'.length)),title:'',createdAt:'2026-11-21T00:00:00Z',updatedAt:'2026-11-21T00:00:00Z',turnCount:0,scope:{},status:'completed',revision:1,nextCursor:null,turns:[]});
  if(path==='/api/query-runs')return send({items:[]});
  if(path==='/api/model-settings')return send({version:1,revision:1,profiles:[],defaults:{},defaultModels:{}});
  if(path.startsWith('/api/library/browse'))return send({schemaVersion:1,types:[],sources:[],items:[],nextCursor:null});
  return send({items:[],nextCursor:null});
 };
 const hook=registerHooks({load(url,context,next){return url.endsWith('.css')?{format:'module',source:'export {};',shortCircuit:true}:next(url,context);}});
 const realTimeout=globalThis.setTimeout;
 const until=async(ready:()=>boolean,label:string)=>{const deadline=Date.now()+15_000;while(!ready()){assert.ok(Date.now()<deadline,'generated PF1 read never settled: '+label+' / '+reads.map(read=>read.path).join(', '));await act(async()=>new Promise(resolve=>realTimeout(resolve,10)));}};
 const tick=async(ms:number)=>{await act(async()=>{mock.timers.tick(ms);await new Promise(resolve=>realTimeout(resolve,10));});};
 mock.timers.enable({apis:['setTimeout','setInterval']});
 try{
  await act(async()=>{await import('../src/boot');});
  await until(()=>d.querySelector('.content')?.getAttribute('data-session')==='ready','owner verification from NV2');
  await until(()=>Boolean(d.querySelector('textarea[aria-label="向 Mote 提问"]')),'chat composer');
  await until(()=>count('/api/configuration')>=1,'page configuration read');

  await t.test('PF1-04 configuration is slow while the chat page renders',()=>{
   assert.equal(configSettled,false,'chat renders while the configuration response is still pending');
   assert.ok(d.querySelector('textarea[aria-label="向 Mote 提问"]'));
  });

  await t.test('PF1-01 entry reads only the allowlisted first-screen endpoints',()=>{
   const allowed=[/^\/api\/nav-state$/,/^\/api\/status$/,/^\/api\/devices$/,/^\/api\/features$/,/^\/api\/configuration$/,/^\/api\/plugins(\/|\?|$)/,/^\/api\/sources(\/|\?|$)/,/^\/api\/conversations(\/|\?|$)/,/^\/api\/query-runs(\/|\?|$)/,/^\/api\/operations\/changes\?/,/^\/api\/model-settings(\/|\?|$)/,/^\/api\/model-authorization(\/|\?|$)/,/^\/api\/connectors\/status$/];
   for(const read of reads)assert.ok(allowed.some(pattern=>pattern.test(read.path)),'unexpected first-screen read '+read.path);
   for(const path of ['/api/memories','/api/assistant-cards','/api/assistant/commitments','/api/assistant/matters','/api/library/browse','/api/capture-browser'])assert.equal(reads.filter(read=>read.path===path||read.path.startsWith(path+'?')||read.path.startsWith(path+'/')).length,0,path+' is not a chat entry read');
  });

  await t.test('PF1-02 one visible NV2 tick per 30 seconds is a bodyless 304 without reloading the page',async()=>{
   const mainDetail='/api/conversations/10000000-0000-4000-8000-000000000001';
   const firstStatus=count('/api/status'),firstDevices=count('/api/devices'),firstMain=count('/api/conversations/main'),firstDetail=count(mainDetail),firstNav=count('/api/nav-state');
   assert.ok(firstDetail>0,'chat initially reads the main conversation detail');
   await tick(29_999);
   assert.equal(count('/api/nav-state'),firstNav,'no NV2 read before 30 seconds');
   await tick(1);
   await until(()=>count('/api/nav-state')===firstNav+1,'conditional NV2 tick');
   const conditional=reads.filter(read=>read.path==='/api/nav-state').at(-1)!;
   assert.equal(conditional.status,304);
   assert.equal(conditional.ifNoneMatch,'"nav-1"');
   assert.equal(count('/api/status'),firstStatus,'the 30-second tick does not reread shell status');
   assert.equal(count('/api/devices'),firstDevices,'the 30-second tick does not reread devices');
   assert.equal(count('/api/conversations/main'),firstMain,'the 30-second tick does not reread the conversation');
   assert.equal(count(mainDetail),firstDetail,'the 30-second tick does not reread the main conversation detail');
  });

  await t.test('PF1-03 a page switch keeps shell reads and a library revision rereads only material resources',async()=>{
   const statusBefore=count('/api/status'),devicesBefore=count('/api/devices');
   await act(async()=>{dom.window.location.hash='#/library?view=materials';dom.window.dispatchEvent(new dom.window.Event('hashchange'));});
   await until(()=>countPrefix('/api/library/browse')>0,'material collection read');
   assert.equal(count('/api/status'),statusBefore,'page switch does not reread status');
   assert.equal(count('/api/devices'),devicesBefore,'page switch does not reread devices');
   const browseBefore=countPrefix('/api/library/browse'),memoriesBefore=countPrefix('/api/memories'),cardsBefore=countPrefix('/api/assistant-cards'),pluginsBefore=count('/api/plugins'),commitmentsBefore=countPrefix('/api/assistant/commitments'),mattersBefore=countPrefix('/api/assistant/matters');
   navRevision=2;
   await tick(30_000);
   await until(()=>countPrefix('/api/library/browse')>browseBefore,'material read after library revision');
   assert.equal(countPrefix('/api/memories'),memoriesBefore,'memory collection is untouched by a library revision');
   assert.equal(countPrefix('/api/assistant-cards'),cardsBefore,'cards are untouched by a library revision');
   assert.equal(count('/api/plugins'),pluginsBefore,'plugins are untouched by a library revision');
   assert.equal(countPrefix('/api/assistant/commitments'),commitmentsBefore,'commitments are untouched by a library revision');
   assert.equal(countPrefix('/api/assistant/matters'),mattersBefore,'matters are untouched by a library revision');
  });

  await t.test('PF1-05 a hidden tab does not read NV2',async()=>{
   visible=false;
   await act(async()=>{d.dispatchEvent(new dom.window.Event('visibilitychange'));});
   const hiddenNav=count('/api/nav-state');
   await tick(60_000);
   assert.equal(count('/api/nav-state'),hiddenNav,'hidden tabs do not read NV2');
  });
 }finally{
  releaseConfig();
  await act(async()=>new Promise(resolve=>realTimeout(resolve,10)));
  mock.timers.reset();hook.deregister();globalThis.fetch=priorFetch;dom.window.close();
 }
});
