import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JSDOM} from 'jsdom';
import {buildApp} from '../../server/src/app.js';
import {ApiError,type Api} from '../src/api.js';
import {createHomePlugin} from '../src/plugins/home/index.js';
import {createHomeController,type HomeCatalogPage} from '../src/plugins/home/controller.js';

const when='2026-11-04T04:00:00.000Z';

async function fixture(t: import('node:test').TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-plugin-home-contract-')),token='generated-plugin-home-'+randomUUID();
  const node=await buildApp({
    dataDir:join(directory,'data'),token,tokenPath:'generated',host:'127.0.0.1',port:0,
    maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,
    allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,
    embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',
  },{
    backgroundWorker:false,
    agent:{configured:false,query:async()=>{throw Error('No model in generated home contract fixture');},close:async()=>{}},
  });
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
  return {node,token,headers:{authorization:'Bearer '+token}};
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

const until=async(check:()=>boolean,label:string)=>{
  const end=Date.now()+5000;
  while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}
  throw Error('Generated Home did not settle: '+label);
};

test('the Home consumer keeps real browse entry id and revision for first use and existing data',async t=>{
  const {node,token,headers}=await fixture(t),{api,calls}=apiFor(node,token);
  const plugin=createHomePlugin({api});
  plugin.activate();
  const controller=plugin.controller;
  t.after(()=>plugin.dispose());
  await until(()=>controller.getSnapshot().firstData.data!==undefined&&controller.getSnapshot().catalog.data!==undefined,'first reads');
  const first=controller.getSnapshot();
  assert.ok(['waiting','unverified'].includes(first.firstData.data!.state),'an empty store is recognised as first use');
  assert.equal(first.catalog.data!.items.length,0);
  assert.equal(first.firstUse,true);
  assert.equal(calls.some(path=>path.startsWith('/api/capture-browser/')),false,'no preview is read before a candidate exists');

  const noteId=randomUUID();
  const created=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id:noteId,deviceId:'generated-home-device',deviceName:'Generated Home device',platform:'android',capturedAt:when,text:'Generated Home contract original text.'}});
  assert.equal(created.statusCode,201,created.body);
  await node.materialOrganizer.tick();
  controller.refresh('catalog');controller.refresh('firstData');
  await until(()=>controller.getSnapshot().catalog.data!.items.length>0,'catalog after the real note');
  await until(()=>controller.getSnapshot().firstData.data!.candidate?.id===noteId,'first receipt candidate');

  const browse=await node.app.inject({method:'GET',url:'/api/library/browse?limit=3',headers});
  assert.equal(browse.statusCode,200,browse.body);
  const server=(browse.json() as HomeCatalogPage).items.find(item=>item.entryType==='material')!;
  const consumed=controller.getSnapshot().catalog.data!.items.find(item=>item.entryType==='material')!;
  assert.equal(consumed.ref,server.ref);
  assert.equal(consumed.entryType,'material');
  if(consumed.entryType==='material'&&server.entryType==='material'){
    assert.equal(consumed.material.id,server.material.id,'the exact Material id is preserved');
    assert.equal(consumed.material.revision,server.material.revision,'the exact Material revision is preserved');
  }
  assert.equal(controller.getSnapshot().catalog.data!.revision,(browse.json() as HomeCatalogPage).revision);
  await until(()=>controller.getSnapshot().firstPreview.data?.id===noteId,'first-use preview');
  assert.equal(controller.getSnapshot().firstPreview.data!.ocrText,'Generated Home contract original text.');
});

test('the consumer passes entry fields through without dropping action permissions',async t=>{
  const browse={schemaVersion:1 as const,revision:'generated-catalog-revision',items:[{entryType:'material' as const,ref:'material:generated@generated-revision',contentAt:when,material:{id:'generated-material',revision:'generated-revision',kind:'mote.file',title:'Generated',textLength:1,origin:{sourceId:'generated-source'},allowedActions:['read','preview']}}],nextCursor:null};
  const api={request:async(path:string)=>{
    if(path==='/api/features')return {schemaVersion:1,revision:1,features:[],capabilities:[]};
    if(path==='/api/devices/first-data')return {state:'unverified',originalAvailable:false,checkedDevices:1,checkedRecords:1,windowLimited:false};
    if(path==='/api/library/browse?limit=3')return browse;
    return {items:[],nextCursor:null};
  },setAgentTimeout:()=>{}} as Api;
  const controller=createHomeController({api});
  controller.start();
  t.after(()=>controller.dispose());
  await until(()=>controller.getSnapshot().catalog.data!==undefined,'generated catalog');
  const item=controller.getSnapshot().catalog.data!.items[0] as unknown as {material:{id:string;revision:string;allowedActions:string[]}};
  assert.equal(item.material.id,'generated-material');
  assert.equal(item.material.revision,'generated-revision');
  assert.deepEqual(item.material.allowedActions,['read','preview']);
});

test('hiding Home stops every read and resuming validates each current key exactly once',async t=>{
  const dom=new JSDOM('<!doctype html>',{url:'http://localhost/#/today',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
  t.after(()=>{for(const [key,value]of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
  const calls:string[]=[],inventory={schemaVersion:1,revision:1,features:[],capabilities:[]};
  const api={request:async(path:string)=>{
    calls.push(path);
    if(path==='/api/features')return inventory;
    if(path==='/api/devices/first-data')return {state:'unverified',originalAvailable:false,checkedDevices:1,checkedRecords:1,windowLimited:false};
    if(path==='/api/library/browse?limit=3')return {schemaVersion:1,revision:'generated',items:[],nextCursor:null};
    if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:1,hasMore:false,reset:false};
    return {items:[],nextCursor:null};
  },setAgentTimeout:()=>{}} as Api;
  const controller=createHomeController({api});
  controller.start();
  t.after(()=>controller.dispose());
  const paths=['/api/features','/api/sources','/api/connections','/api/library/browse?limit=3','/api/devices/first-data'];
  await until(()=>paths.every(path=>calls.some(value=>value===path)),'initial reads');
  await until(()=>calls.some(value=>value.startsWith('/api/operations/changes')),'change feed');
  const before=new Map(paths.map(path=>[path,calls.filter(value=>value===path).length])),feedBefore=calls.filter(value=>value.startsWith('/api/operations/changes')).length;

  Object.defineProperty(dom.window.document,'hidden',{configurable:true,get:()=>true});
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  await new Promise(resolve=>setTimeout(resolve,120));
  for(const path of paths)assert.equal(calls.filter(value=>value===path).length,before.get(path),'hidden Home stops '+path);
  assert.equal(calls.filter(value=>value.startsWith('/api/operations/changes')).length,feedBefore,'hidden Home stops the change feed');

  Object.defineProperty(dom.window.document,'hidden',{configurable:true,get:()=>false});
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  await new Promise(resolve=>setTimeout(resolve,120));
  for(const path of paths)assert.equal(calls.filter(value=>value===path).length,before.get(path)!+1,'resuming validates '+path+' exactly once');
  assert.equal(calls.filter(value=>value.startsWith('/api/operations/changes')).length,feedBefore+1,'resuming reconnects the feed exactly once');
});

test('starting on a hidden document does not read until it becomes visible',async t=>{
  const dom=new JSDOM('<!doctype html>',{url:'http://localhost/#/today',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
  Object.defineProperty(dom.window.document,'hidden',{configurable:true,get:()=>true});
  t.after(()=>{for(const [key,value]of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
  let calls=0;
  const api={request:async(path:string)=>{if(path.startsWith('/api/'))calls++;return path==='/api/features'?{schemaVersion:1,revision:1,features:[],capabilities:[]}:{items:[],nextCursor:null};},setAgentTimeout:()=>{}} as Api;
  const controller=createHomeController({api});
  controller.start();
  t.after(()=>controller.dispose());
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(calls,0,'a hidden first render issues no reads');
  Object.defineProperty(dom.window.document,'hidden',{configurable:true,get:()=>false});
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  await until(()=>calls>0,'foreground read');
});
