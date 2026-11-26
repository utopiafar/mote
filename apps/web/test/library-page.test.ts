import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import type {ImportJob,NavState} from '@mote/shared';
import {featuresReady} from '../src/features/bootstrap.js';
import {webFeatures} from '../src/features/registry.js';
import {FeaturePage} from '../src/features/runtime.js';
import type {PageProps} from '../src/features/types.js';
import {readPage} from '../src/navigation.js';
import {readWorkspaceRoute} from '../src/workspace-route.js';
import {importQueue} from '../src/plugins/intake/import-queue.js';
import {Archive} from '../src/plugins/library/Archive.js';
import {LibraryMaterials} from '../src/plugins/library/LibraryBrowse.js';
import {NavStateContext} from '../src/use-nav-state.js';
import type {Api,Capture} from '../src/api.js';
import type {Material} from '../src/Materials.js';
import type {OwnerBrowsePage} from '../src/plugins/library/owner-library-browse.js';

const when='2026-11-21T09:12:00+08:00',yesterday='2026-11-20T18:00:00+08:00';
const materialId='mat_'+'a'.repeat(64),revision='b'.repeat(64),ref='material:'+materialId+'@'+revision;
const material={id:materialId,ref,revision,kind:'mote.file',schemaVersion:1,title:'同步协议草案 v3.pdf',sequence:1,textLength:24,blockCount:1,coverage:{state:'complete'},origin:{sourceId:'generated-import',deviceId:'generated-device'},retention:{original:'kept'}} as Material;
const transcript={...material,id:'mat_'+'c'.repeat(64),ref:'material:mat_'+'c'.repeat(64)+'@'+revision,title:'Generated recording transcript',sequence:2,kind:'mote.file',origin:{sourceId:'generated-recording',deviceId:'generated-device'}} as Material;
const note=(id:string,at:string):Capture=>({id,deviceId:'generated-device',deviceName:'Generated device',platform:'macos',capturedAt:at,source:'note',appName:'Mote',windowTitle:'Generated note '+id.slice(-1),durationMs:0,hasImage:false,ocr:{status:'not_applicable'},textPreview:'Generated note text'});
const noteEntry=(id:string,at:string)=>({entryType:'capture' as const,ref:'capture:'+id,contentAt:at,revision:'generated-note-'+id.slice(-1),capture:note(id,at)});
const materialEntry=(value:Material,at:string)=>({entryType:'material' as const,ref:value.ref,contentAt:at,material:value});
const page=(items:OwnerBrowsePage['items']):OwnerBrowsePage=>({schemaVersion:1,revision:'generated-library-revision',types:[{id:'mote.file',kind:'mote.file',schemaVersion:1,label:'文件与录音'}],sources:[{id:'generated-import',label:'导入',count:1},{id:'generated-recording',label:'录音来源',count:1}],sourcesTruncated:false,noteOrigin:{origin:'notes',label:'记录',count:1},items,nextCursor:null});
const nav=(library:string):NavState=>({revisions:{library,cards:'cards-1',commitments:'commitments-1',matters:'matters-1',memory:'memory-1',sources:'sources-1',plugins:'plugins-1'},badges:{}});

async function fixture(t:import('node:test').TestContext){
 await featuresReady;
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/library',pretendToBeVisual:true});
 const previous=new Map<string,PropertyDescriptor|undefined>();
 configureLocale(()=> 'zh-CN');
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){
  previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 }
 const root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{
  await act(async()=>root.unmount());
  for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}
  dom.window.close();
 });
 return {root,d:dom.window.document,w:dom.window};
}
function apiWith(read:(path:string,init?:RequestInit)=>unknown):Api{
 return {request:async(path:string,init?:RequestInit)=>{
  if(path.startsWith('/api/actions/by-evidence/'))return {items:[],hasMore:false};
  if(path==='/api/nav-state')return nav('1');
  const value=await read(path,init);
  return path.startsWith('/api/library/browse?')?{...page([]),...value as object,items:((value as {items?:OwnerBrowsePage['items']}).items??[])}:value;
 },setAgentTimeout:()=>{}} as Api;
}
const button=(d:Document,text:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(item=>item.textContent===text)!;
async function settle(check:()=>boolean,label:string){
 for(let attempt=0;attempt<100&&!check();attempt++)await act(async()=>new Promise(resolve=>setTimeout(resolve,5)));
 assert.ok(check(),label);
}
function workspacePage(api:Api,overrides:Partial<PageProps>={}){
 const {page,collection}=readWorkspaceRoute(window.location.hash,readPage,webFeatures.collections().map(entry=>entry.id));
 const props:PageProps={api,status:null,devices:[],activity:{apps:[],devices:[],totalDurationMs:0,captures:0},insights:[],range:{},archiveTab:collection,
  onOpen:()=>{},onPage:()=>{},setArchiveTab:()=>{},timelineRevision:0,refresh:()=>{},disconnect:()=>{},sessionLifetime:'permanent',changeSessionLifetime:()=>{},...overrides};
 return React.createElement(React.Suspense,{fallback:null},React.createElement(FeaturePage,{page,props}));
}

test('LB2-01 the type row reads only the selected existing material type',async t=>{
 const {root,d}=await fixture(t),paths:string[]=[];
 const api=apiWith(path=>{
  paths.push(path);
  if(!path.startsWith('/api/library/browse?'))throw Error('Unexpected generated request '+path);
  const type=new URL(path,'http://localhost').searchParams.get('type');
  return type==='transcript'?page([materialEntry(transcript,when),materialEntry(transcript,yesterday)]):page([noteEntry('00000000-0000-4000-8000-000000000001',when),materialEntry(material,when)]);
 });
 await act(async()=>root.render(React.createElement(LibraryMaterials,{api,revision:0,onSelect:()=>{}})));
 assert.equal(d.querySelectorAll('.library-record').length,2);
 await act(async()=>button(d,'转写').click());
 await settle(()=>d.querySelectorAll('.library-record').length===2,'the transcript type scope renders only its two rows');
 const latest=new URL('http://localhost'+paths.filter(path=>path.startsWith('/api/library/browse?')).at(-1)!);
 assert.equal(latest.searchParams.get('type'),'transcript');
 assert.equal(latest.searchParams.get('limit'),'24');
 for(const row of d.querySelectorAll('.library-record'))assert.match(row.textContent!,/Generated recording transcript/);
 assert.doesNotMatch(d.querySelector('.library-materials')!.textContent!,/同步协议草案|Generated note/);
});

test('LB2-02 the import action opens the existing intake panel and an imported PDF appears under today with its import source',async t=>{
 const {root,d}=await fixture(t),paths:string[]=[];
 let items:OwnerBrowsePage['items']=[],revision=0;
 const api=apiWith(path=>{
  paths.push(path);
  if(path.startsWith('/api/library/browse?'))return page(items);
  if(path==='/api/devices')return {items:[]};
  if(path==='/api/connections')return {items:[]};
  if(path==='/api/sources')return {items:[]};
  if(path==='/api/features')return {schemaVersion:1,revision:1,features:[],capabilities:[{id:'http:GET:/api/library/browse',featureId:'mote.materials',version:'1',surface:'data',state:'active'}]};
  if(path==='/api/imports'||path.startsWith('/api/imports?'))return {items:[],nextCursor:null};
  if(path==='/api/file-processing')return {policy:{profiles:[]},processors:[]};
  if(path==='/api/import-source-packs')return {items:[]};
  throw Error('Unexpected generated request '+path);
 });
 const view=()=>React.createElement(Archive,{api,devices:[],range:{},activity:{apps:[],devices:[],totalDurationMs:0,captures:0},revision,onOpen:()=>{},onPage:()=>{},tab:'materials',setTab:()=>{}});
 await act(async()=>root.render(view()));
 await act(async()=>button(d,'导入').click());
 assert.ok(d.querySelector('[role="dialog"]'));
 assert.match(d.querySelector('[role="dialog"]')!.textContent!,/导入资料/);
 await act(async()=>{d.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="关闭"]')!.click();});
 items=[materialEntry(material,new Date().toISOString())];revision=1;
 await act(async()=>root.render(view()));
 await settle(()=>d.querySelector('.library-day-heading h2')?.textContent==='今天','the imported PDF is grouped under today');
 assert.match(d.querySelector('.library-record')!.textContent!,/同步协议草案 v3\.pdf/);
 assert.match(d.querySelector('.library-record')!.textContent!,/导入/);
 assert.ok(paths.some(path=>path.startsWith('/api/library/browse?')));
});

test('LB2-03 an empty library shows one empty state with device and import actions',async t=>{
 const {root,d}=await fixture(t),opened:HTMLElement[]=[];
 const api=apiWith(path=>{if(path.startsWith('/api/library/browse?'))return page([]);throw Error('Unexpected generated request '+path);});
 await act(async()=>root.render(React.createElement(LibraryMaterials,{api,revision:0,onSelect:()=>{},onAddDevice:()=>{},onImport:opener=>opened.push(opener)})));
 assert.equal(d.querySelector('.empty h3')?.textContent,'还没有资料');
 assert.ok(button(d,'添加设备'));
 await act(async()=>button(d,'导入').click());
 assert.equal(opened.length,1);
 assert.equal(opened[0].textContent,'导入');
});

test('LB2-03 the empty state add-device action opens the existing pairing sheet from the source bar',async t=>{
 const {root,d}=await fixture(t);
 const api=apiWith(path=>{
  if(path.startsWith('/api/library/browse?'))return page([]);
  if(path==='/api/devices')return {items:[],disconnectedDeviceIds:[]};
  if(path==='/api/connections')return {items:[]};
  if(path==='/api/sources')return {items:[]};
  if(path==='/api/configuration')return {domains:[]};
  throw Error('Unexpected generated request '+path);
 });
 await act(async()=>root.render(React.createElement(LibraryMaterials,{api,revision:0,onSelect:()=>{},sourceBar:true})));
 const empty=Array.from(d.querySelectorAll<HTMLButtonElement>('.empty .button-row button')).find(item=>item.textContent==='添加设备');
 assert.ok(empty);
 await act(async()=>empty.click());
 assert.ok(d.querySelector('[role="dialog"]'));
 assert.equal(d.querySelector('[role="dialog"] h2')?.textContent,'添加设备');
});

test('LB2-04 a changed library navigation revision removes material deleted elsewhere',async t=>{
 const {root,d}=await fixture(t);
 let rows:OwnerBrowsePage['items']=[materialEntry(material,when)];
 const api=apiWith(path=>{if(path.startsWith('/api/library/browse?'))return page(rows);throw Error('Unexpected generated request '+path);});
 const view=(current:NavState)=>React.createElement(NavStateContext.Provider,{value:current},React.createElement(LibraryMaterials,{api,revision:0,onSelect:()=>{}}));
 await act(async()=>root.render(view(nav('generated-library-1'))));
 assert.equal(d.querySelectorAll('.library-record').length,1);
 rows=[];
 await act(async()=>root.render(view(nav('generated-library-2'))));
 await settle(()=>d.querySelectorAll('.library-record').length===0,'the deleted material is removed after the navigation revision changes');
 assert.equal(d.querySelector('.empty h3')?.textContent,'还没有资料');
});

test('LB2-06 removed device, recording and coding addresses are not registered pages',async()=>{
 await featuresReady;
 assert.equal(readPage('#/sources/devices'),'unavailable');
 assert.equal(readPage('#/connections/recordings'),'unavailable');
 assert.equal(readPage('#/library/coding'),'unavailable');
 assert.equal(webFeatures.page('devices'),undefined);
 assert.equal(webFeatures.page('recordings'),undefined);
 assert.equal(webFeatures.page('coding'),undefined);
});

test('the library registry has no Memory collection',async()=>{
 await featuresReady;
 assert.equal(webFeatures.collections().find(entry=>entry.id==='memories'),undefined);
});

test('the retired Library Memory hash shows an unavailable collection without mounting Memory',async t=>{
 const {root,d,w}=await fixture(t),paths:string[]=[];
 w.history.replaceState(null,'','#/library?view=memories');
 const api=apiWith(path=>{
  paths.push(path);
  if(path==='/api/features')return {schemaVersion:1,revision:1,features:[],capabilities:[]};
  if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};
  return {items:[],nextCursor:null};
 });
 await act(async()=>root.render(workspacePage(api)));
 await settle(()=>Boolean(d.querySelector('.library-content [role="status"], .memories-page')),'the requested collection settles');
 assert.ok(!d.querySelector('.memories-page'),'the retired hash does not mount the Memory page');
 assert.match(d.querySelector('.library-content [role="status"]')?.textContent??'',/分类不可用/);
 assert.equal(paths.some(path=>/^\/api\/(memories|memory-jobs)([/?]|$)/.test(path)),false);
});

test('a completed import on the standalone page opens the registered Memory page',async t=>{
 const {root,d,w}=await fixture(t),destinations:string[]=[],collections:string[]=[];
 w.history.replaceState(null,'','#/library/import');
 const job:ImportJob={id:'generated-import',name:'Generated PDF import',instruction:'',sourceId:'generated-import',status:'completed',
  processingStatus:'saved',createdAt:when,updatedAt:when,files:[],summary:'',warnings:[],archive:{files:1,bytes:24,expandedFiles:1},
  progress:{total:1,processed:1,imported:1,duplicates:0},captureIds:[]};
 const api=apiWith(path=>{
  if(path==='/api/imports')return {items:[job]};
  if(path==='/api/file-processing')return {policy:{profiles:[]},processors:[]};
  if(path==='/api/import-source-packs')return {items:[]};
  throw Error('Unexpected generated request '+path);
 });
 t.after(()=>importQueue(api).close());
 await act(async()=>root.render(workspacePage(api,{onPage:next=>destinations.push(next),setArchiveTab:next=>collections.push(next)})));
 await settle(()=>Boolean(d.querySelector('.import-job-row')),'the generated completed import is listed');
 await act(async()=>d.querySelector<HTMLButtonElement>('.import-job-row')!.click());
 await act(async()=>button(d,'前往记忆').click());
 assert.deepEqual({destinations,collections},{destinations:['assistantMemory'],collections:[]});
 assert.equal(readPage('#/assistant/memory'),destinations[0]);
});
