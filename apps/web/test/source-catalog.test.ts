import '@mote/shared/i18n-all';
import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale,getLocale} from '@mote/shared/i18n';
import type {FeatureCapability,FeatureInventory,RecordingStatus} from '@mote/shared';
import type {Api} from '../src/api.js';
import {SourceCatalog} from '../src/plugins/sources/SourceCatalog.js';
import {Sources} from '../src/plugins/sources/Sources.js';
import {FeatureGuide} from '../src/FeatureGuide.js';
import {webFeatures} from '../src/features/registry.js';
import {resolveDiscoveryTarget} from '../src/discovery-availability.js';
import {resources} from '../src/resource-cache.js';

const activityId='http:GET:/api/work-activity',codingId='http:GET:/api/coding/uploads';
const capability=(id:string,version='1',state:FeatureCapability['state']='active'):FeatureCapability=>({id,version,state,featureId:id.startsWith('connector:')?'mote.connector.'+id.slice(10):'generated.catalog-server',surface:id.startsWith('connector:')?'ingress':'data'});
const inventory=(capabilities:FeatureCapability[]):FeatureInventory=>({schemaVersion:1,revision:1,features:[],capabilities});
const routes={activity:'activity',overview:'today',archive:'library',recordings:'generated/recordings',connections:'connections/access',deviceConnections:'connections/pair',imports:'library/import',lark:'connections/lark',sources:'connections',featureGuide:'guide'};
const provider='generated-recorder',recorderKey=provider+'-recordings';
const providerDetailId='connector:'+recorderKey;
const recorder:RecordingStatus={provider,category:'recordings',label:'Generated recording provider',connected:false,selection:{enabled:false,start:'2026-01-01T00:00:00Z',autoSync:false,backupAudio:true},steps:[],counts:{transcripts:0,audio:0,pending:0,failed:0}};

async function fixture(t:import('node:test').TestContext,options:{capabilities:FeatureCapability[];pageIds?:string[];coding?:boolean;statusKey?:string;emptyStatus?:boolean;statusError?:boolean;recorderStatus?:RecordingStatus}){
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/connections/add',pretendToBeVisual:true});
  const previousLocale=getLocale(),previous=new Map<string,PropertyDescriptor|undefined>();
  let locale:'zh-CN'|'en'='zh-CN';
  configureLocale(()=>locale);
  for(const [key,value] of Object.entries({window:dom.window,location:dom.window.location,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  const root=createRoot(dom.window.document.getElementById('root')!);
  const disposals:(()=>unknown)[]=[],reads:string[]=[],pageCalls:string[]=[];
  let currentInventory=inventory(options.capabilities);
  const api={request:async(path:string)=>{
    reads.push(path);
    if(path==='/api/features')return structuredClone(currentInventory);
    if(path==='/api/connectors/status'){if(options.statusError)throw new Error('Generated connector status read failed');return options.emptyStatus?{}:{[options.statusKey??recorderKey]:structuredClone(options.recorderStatus??recorder),gmail:{category:'mail',provider:'gmail'}};}
    if(path==='/api/connectors/lark')return {installed:false,configured:false,connected:false,missingScopes:[],selection:{documents:[],calendarIds:[],pastDays:30,futureDays:90,timeZone:'Asia/Shanghai',autoSync:false}};
    if(path==='/api/sources')return {items:[]};
    if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};
    throw new Error('Unexpected generated catalog read '+path);
  }} as Api;
  const pageIds=options.pageIds??Object.keys(routes);
  const shell=await webFeatures.install({id:'generated.catalog-shell',version:'1',components:[]},[
    ...pageIds.map(id=>({surface:'page' as const,entry:{id,route:routes[id as keyof typeof routes],featureId:'generated.catalog-shell',render:()=>null}})),

  ]);
  disposals.push(()=>shell.dispose());
  if(options.coding){
    const coding=await webFeatures.install({id:'generated.catalog-coding',version:'1',components:[]},[
      {surface:'collection',entry:{id:'coding-status',featureId:'generated.catalog-coding',label:'Generated Coding',order:2,requires:[codingId],render:()=>null}},
    ]);
    disposals.push(()=>coding.dispose());
  }
  t.after(async()=>{
    await act(async()=>root.unmount());
    for(const dispose of disposals.reverse())await dispose();
    for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}
    configureLocale(()=>previousLocale);
    dom.window.close();
  });
  const render=async(view:'catalog'|'guide'|'sources'='catalog')=>{await act(async()=>root.render(view==='sources'?React.createElement(Sources,{api,onOpen:()=>{},onImport:()=>{}}):React.createElement(view==='catalog'?SourceCatalog:FeatureGuide,{api,onPage:(page:string)=>pageCalls.push(page)})));};
  const updateInventory=async(capabilities:FeatureCapability[])=>{
    currentInventory=inventory(capabilities);
    await act(async()=>resources(api).invalidate(key=>key==='/api/features'));
  };
  const workAvailable=()=>assert.equal(resolveDiscoveryTarget({pageId:'activity',href:'#/activity',requires:[activityId]},{pages:webFeatures.pages(),collections:webFeatures.collections(),inventory:currentInventory}).state,'available');
  const refreshSources=async()=>{await act(async()=>resources(api).invalidate(key=>key==='/api/sources'||key==='/api/connectors/status'));};
  const openRecorders=async()=>{await act(async()=>card(dom.window.document,'录音与转写').click());};
  return {d:dom.window.document,reads,pageCalls,render,openRecorders,updateInventory,workAvailable,refreshSources,setLocale:(value:'zh-CN'|'en')=>{locale=value;}};
}

function card(d:Document,title:string){
  const heading=Array.from(d.querySelectorAll('h3')).find(element=>element.textContent===title);
  assert.ok(heading,title);
  const found=heading.closest<HTMLElement>('.discovery-source-card');
  assert.ok(found,title);
  return found;
}
function disabled(element:HTMLElement){
  assert.equal(element.getAttribute('aria-disabled'),'true');
  assert.equal(element.hasAttribute('href'),false);
  assert.equal(element.querySelector('a[href]'),null);
}

test('recording discovery does not fetch connector status when its local page is missing',async t=>{
 const f=await fixture(t,{capabilities:[capability(activityId)],pageIds:Object.keys(routes).filter(id=>id!=='recordings')});
 await f.render();
 assert.ok(f.reads.includes('/api/features'));
 assert.equal(f.reads.includes('/api/connectors/status'),false);
 assert.equal(f.d.querySelector('a[href*="provider="]'),null);f.workAvailable();
});

test('the global status transport is read without fictional HTTP capabilities and an empty registry is legitimate',async t=>{
 const f=await fixture(t,{capabilities:[capability(activityId)],emptyStatus:true});
 await f.render();await f.openRecorders();assert.equal(f.reads.filter(path=>path==='/api/connectors/status').length,1);
 assert.equal(f.d.querySelector('a[href*="provider="]'),null);
 assert.equal(f.d.querySelector('section[aria-label="录音数据源"] [role=alert]'),null);
});

test('a failed global status read shows its actual read error',async t=>{
 const f=await fixture(t,{capabilities:[capability(activityId)],statusError:true});
 await f.render();await f.openRecorders();assert.equal(f.reads.filter(path=>path==='/api/connectors/status').length,1);
 assert.match(f.d.querySelector('section[aria-label="录音数据源"] [role=alert]')?.textContent??'',/Generated connector status read failed/);
 assert.equal(f.d.querySelector('a[href*="provider="]'),null);
});

test('registered recording providers link to the actual recording route with their exact provider query',async t=>{
  const f=await fixture(t,{capabilities:[capability(activityId),capability(providerDetailId)]});
  await f.render();
  assert.equal(f.reads.filter(path=>path==='/api/connectors/status').length,1);
  await f.openRecorders();
  const link=card(f.d,recorder.label!) as HTMLAnchorElement;
  assert.equal(link.tagName,'A');
  assert.equal(link.getAttribute('href'),'#/generated/recordings?provider='+encodeURIComponent(provider));
  assert.equal(new URLSearchParams(link.hash.split('?')[1]).get('provider'),provider);
  assert.equal(f.d.querySelectorAll('a[href*="provider="]').length,1,'unrelated connector categories do not become recording cards');
  await act(async()=>link.click());
  assert.equal(location.hash,'#/generated/recordings?provider='+encodeURIComponent(provider));
  assert.deepEqual(f.pageCalls,[]);
  await f.updateInventory([capability(activityId)]);
  assert.equal(f.d.querySelector('a[href*="provider="]'),null,'an unavailable recording target has no link');
  assert.equal(f.reads.filter(path=>path==='/api/connectors/status').length,1,'changing a connector capability does not invent a new transport endpoint');
});

for(const [name,detail] of [
  ['missing',undefined],
  ['inactive',capability(providerDetailId,'1','unavailable')],
  ['version-mismatched',capability(providerDetailId,'2')],
] as const)test('a registered provider whose connector capability is '+name+' has no destination link after a successful global status read',async t=>{
  const f=await fixture(t,{capabilities:[capability(activityId),...(detail?[detail]:[])]});
  await f.render();
  assert.equal(f.reads.filter(path=>path==='/api/connectors/status').length,1);
  await f.openRecorders();disabled(card(f.d,recorder.label!));
  assert.equal(f.d.querySelector('a[href*="provider="]'),null);
});

test('a custom status key that differs from recordingManifest identity is not treated as a supported provider detail route',async t=>{
 const statusKey='generated-custom-status';
 const f=await fixture(t,{capabilities:[capability(activityId),capability('connector:'+statusKey)],statusKey});
 await f.render();await f.openRecorders();disabled(card(f.d,recorder.label!));
 assert.equal(f.d.querySelector('a[href*="provider="]'),null);
});

for(const scenario of ['local Coding missing','remote Coding missing','remote Coding inactive','remote Coding version mismatch'] as const)test('the Coding source card stays disabled when '+scenario+' while unrelated Activity stays available',async t=>{
  const endpoint=scenario==='remote Coding missing'?[]:[capability(codingId,scenario==='remote Coding version mismatch'?'2':'1',scenario==='remote Coding inactive'?'unavailable':'active')];
  const f=await fixture(t,{capabilities:[capability(activityId),...endpoint],coding:scenario!=='local Coding missing'});
  await f.render();
  disabled(card(f.d,'Coding Agent 会话'));
  assert.equal(f.reads.some(path=>path.startsWith('/api/coding/uploads')),false,'catalog discovery only reads capability inventory');
  f.workAvailable();
  await f.render('guide');
  const guide=f.d.querySelector<HTMLElement>('[data-capability-id="A15"]')!;
  assert.equal(guide.querySelector('a[href]'),null,'The full Guide preserves the same Coding availability boundary');
  assert.ok(guide.querySelector('[aria-disabled="true"]'));
});

test('compatible Coding discovery opens Coding sync status and every internal link names a registered destination',async t=>{
  const f=await fixture(t,{capabilities:[capability(activityId),capability(codingId),capability(providerDetailId)],coding:true});
  await f.render();
  const coding=card(f.d,'Coding Agent 会话') as HTMLAnchorElement;
  assert.equal(coding.getAttribute('href'),'#/library?view=coding-status');
  for(const link of f.d.querySelectorAll<HTMLAnchorElement>('a[href]')){
    const href=link.getAttribute('href')!;
    assert.match(href,/^#\//);
    const route=href.slice(2).split('?')[0];
    assert.ok(webFeatures.pages().some(page=>(page.route??page.id)===route),href);
    assert.notEqual(href,'#/today');
  }
  await act(async()=>coding.click());
  assert.equal(location.hash,'#/library?view=coding-status');
  assert.deepEqual(f.pageCalls,[]);
  await f.render('guide');
  const guide=f.d.querySelector<HTMLAnchorElement>('[data-capability-id="A15"] a.guide-unit-link')!;
  assert.ok(guide,'The full Guide exposes the installed Coding destination');
  await act(async()=>guide.click());
  assert.equal(location.hash,coding.getAttribute('href'),'Both entrypoints reach the same specific status view');
});

test('unregistered source destinations render disabled cards with no Today fallback',async t=>{
  const f=await fixture(t,{capabilities:[capability(activityId),capability(codingId)],pageIds:['overview']});
  await f.render();
  assert.equal(f.d.querySelectorAll('.discovery-source-catalog a[href]').length,0);
  for(const element of f.d.querySelectorAll<HTMLElement>('.discovery-source-card'))disabled(element);
  assert.deepEqual(f.pageCalls,[]);
});

test('SourceCatalog and the full Guide render English after a locale switch without changing capability or group identities',async t=>{
  const f=await fixture(t,{capabilities:[capability(activityId),capability(codingId),capability(providerDetailId)],coding:true});
  await f.render();
  assert.match(f.d.body.textContent!,/添加来源/);
  f.setLocale('en');
  await f.render();
  assert.doesNotMatch(f.d.body.textContent!,/\p{Script=Han}/u);
  await f.render('guide');
  assert.equal(f.d.querySelectorAll('[data-guide-group]').length,16);
  assert.equal(f.d.querySelectorAll('[data-capability-id]').length,77);
  assert.equal(f.d.querySelector('[data-capability-id="A01"]'),null,'server-directory import is retired from the guide');
  assert.doesNotMatch(f.d.body.textContent!,/\p{Script=Han}/u);
  f.setLocale('zh-CN');
  await f.render('guide');
  assert.match(f.d.body.textContent!,/全部功能/);
});

for(const [title,setup,component] of [
 ['Gmail 邮件','gmail','.gmail-connector'],['Google Calendar','google','.google-connector'],['MCP 资料服务','mcp','.mcp-import-connector'],
] as const)test('the '+setup+' setup opens its actual primary form and neither data refresh nor returning to Sources reopens closed UI',async t=>{
 const f=await fixture(t,{capabilities:[capability(activityId)]});await f.render();await act(async()=>card(f.d,title).click());assert.equal(location.hash,'#/connections?setup='+setup);await f.render('sources');
 assert.equal(f.d.querySelector<HTMLElement>('.add-source-panel')!.hidden,false);const panel=f.d.querySelector<HTMLElement>(component)!;assert.ok(panel);assert.equal(panel.hidden,false);assert.ok(panel.querySelector('form,section'));
 const details=panel.querySelector<HTMLDetailsElement>('details')!;assert.ok(details);await act(async()=>{details.open=true;details.dispatchEvent(new f.d.defaultView!.Event('toggle'));});await act(async()=>{details.open=false;details.dispatchEvent(new f.d.defaultView!.Event('toggle'));});
 const before=f.reads.filter(path=>path==='/api/connectors/status').length;await f.refreshSources();assert.ok(f.reads.filter(path=>path==='/api/connectors/status').length>before);assert.equal(details.open,false,'refresh preserves owner-closed preparation/auth fields');
 const back=f.d.querySelector<HTMLButtonElement>('.connector-back')!;await act(async()=>back.click());assert.equal(f.d.querySelector<HTMLElement>('.add-source-panel')!.hidden,true);assert.equal(new URLSearchParams(location.hash.split('?')[1]).get('setup'),null);await f.refreshSources();assert.equal(f.d.querySelector<HTMLElement>('.add-source-panel')!.hidden,true,'source refresh cannot reopen owner-closed setup');
});

test('recording discovery shows a saved binding and disabled sync with known runtime failure without probing credentials',async t=>{
 const status=structuredClone(recorder);status.connected=true;status.authorization={revision:'generated',environment:{installed:false,configured:false,error:'generated_cli_missing'}};
 const f=await fixture(t,{capabilities:[capability(providerDetailId)],recorderStatus:status});await f.render();
 await f.openRecorders();const recording=card(f.d,status.label!);
 assert.equal(recording.querySelector('small')?.textContent,'已保存账号绑定 · 录音同步未启用 · 运行环境需要处理');assert.equal(recording.querySelector('.badge.green'),null);
 assert.ok(!f.reads.some(path=>/\/(check|login|sync|connect)$/.test(path)));
});


test('the default catalog is nine compact entries with recording providers one explicit level below and More folded',async t=>{
 const f=await fixture(t,{capabilities:[capability(activityId),capability(providerDetailId)]});await f.render();
 const entries=()=>[...f.d.querySelectorAll('.source-catalog-final>.discovery-source-grid>.source-catalog-entry h3')].map(node=>node.textContent);
 assert.deepEqual(entries(),['手机与电脑','Coding Agent 会话','文件与文件夹','飞书文档与日历','录音与转写','Gmail 邮件','Google Calendar','外部文件 / NAS 引用','MCP 资料服务']);
 assert.equal(f.d.querySelector<HTMLDetailsElement>('.source-catalog-more')!.open,false);assert.equal(f.d.querySelector('a[href*="provider="]'),null);
 await f.openRecorders();assert.ok(f.d.querySelector('a[href*="provider=generated-recorder"]'));
 await act(async()=>f.d.querySelector<HTMLButtonElement>('.source-catalog-back')!.click());assert.equal(entries().length,9);assert.equal(f.d.querySelector('a[href*="provider="]'),null);
});
