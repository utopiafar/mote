import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale,getLocale,type Locale} from '@mote/shared/i18n';
import type {FeatureCapability,FeatureInventory} from '@mote/shared';
import {CodingReceiptPanel} from '../src/CodingReceiptPanel.js';
import {resolveDiscoveryTarget} from '../src/discovery-availability.js';
import {webFeatures} from '../src/features/registry.js';
import {resources} from '../src/resource-cache.js';
import {createApi} from '../src/api.js';

const activityId='http:GET:/api/work-activity',codingId='http:GET:/api/coding/uploads';
const capability=(id:string,version='1',state:FeatureCapability['state']='active'):FeatureCapability=>({id,version,state,featureId:'generated.receipt-server',surface:'data'});
const inventory=(capabilities:FeatureCapability[]):FeatureInventory=>({schemaVersion:1,revision:1,features:[],capabilities});
const workTarget={pageId:'archive',collectionId:'work-activity',href:'#/library?view=work-activity'};
const uploadsPath='/api/coding/uploads?offset=0&limit=20';
type Upload={source:{id:string;name:string;deviceId:string;enabled:boolean};received:{events:number;lastObservedAt:string|null};archiveBytes:number;materials:number;indexedMaterials:number;work:{state:string;count:number}[];memory:{state:string;count:number}[];pipeline:string|null};
const upload=(id:string,events:number,materials:number,work:Upload['work']=[],memory:Upload['memory']=[]):Upload=>({
  source:{id:'generated-'+id,name:'Generated '+id,deviceId:'generated-device',enabled:true},
  received:{events,lastObservedAt:events?'2026-10-14T01:00:00Z':null},archiveBytes:events*100,
  materials,indexedMaterials:materials,work,memory,pipeline:'generated-pipeline',
});

async function fixture(t:import('node:test').TestContext,capabilities:FeatureCapability[],locale:Locale='zh-CN'){
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/library?view=work-activity',pretendToBeVisual:true});
  const previousLocale=getLocale(),previous=new Map<string,PropertyDescriptor|undefined>();
  configureLocale(()=>locale);
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  const root=createRoot(dom.window.document.getElementById('root')!);
  const disposals:(()=>unknown)[]=[],reads:string[]=[],requests:{path:string;headers:Headers;signal:AbortSignal|null|undefined}[]=[];
  let currentInventory=inventory(capabilities);
  let uploads:{items:Upload[];nextOffset:number|null}={items:[],nextOffset:null},uploadStatus=200;
  const fetch=t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    reads.push(path);
    requests.push({path,headers:new Headers(init?.headers),signal:init?.signal});
    if(path==='/api/features')return Response.json(currentInventory);
    if(path===uploadsPath)return Response.json(uploadStatus===200?uploads:{message:'Generated receipt read failed'},{status:uploadStatus});
    throw new Error('Unexpected generated fixture read '+path);
  });
  const api=createApi({token:'generated-receipt-token'});
  const shell=await webFeatures.install({id:'generated.receipt-shell',version:'1',components:[]},[
    {surface:'page',entry:{id:'archive',route:'library',featureId:'generated.receipt-shell',render:()=>null}},
    {surface:'collection',entry:{id:'work-activity',featureId:'generated.receipt-shell',label:'Generated work',order:1,requires:[activityId],render:()=>null}},
  ]);
  disposals.push(()=>shell.dispose());
  t.after(async()=>{
    try{
      await act(async()=>root.unmount());
      for(const dispose of disposals.reverse())await dispose();
      assert.equal(resources(api).get('/api/features').observed,false);
      assert.equal(resources(api).get(uploadsPath).observed,false);
    }finally{
      fetch.mock.restore();
      for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}
      configureLocale(()=>previousLocale);
      dom.window.close();
    }
  });
  const workAvailable=()=>{
    const result=resolveDiscoveryTarget(workTarget,{pages:webFeatures.pages(),collections:webFeatures.collections(),inventory:currentInventory});
    assert.equal(result.state,'available');
    assert.equal(result.href,'#/library?view=work-activity');
  };
  const installCoding=async()=>{
    const fiber=await webFeatures.install({id:'generated.receipt-coding',version:'1',components:[]},[
      {surface:'collection',entry:{id:'coding-status',featureId:'generated.receipt-coding',label:'Generated Coding status',order:2,requires:[codingId],render:()=>null}},
    ]);
    disposals.push(()=>fiber.dispose());
    return fiber;
  };
  const mount=async()=>{await act(async()=>root.render(React.createElement(CodingReceiptPanel,{api})));};
  const updateInventory=async(next:FeatureCapability[])=>{
    currentInventory=inventory(next);
    await act(async()=>resources(api).invalidate(key=>key==='/api/features'));
  };
  const setUploads=(items:Upload[])=>{uploads={items,nextOffset:null};uploadStatus=200;};
  const failUploads=()=>{uploadStatus=503;};
  const refreshUploads=async()=>{await act(async()=>resources(api).get(uploadsPath).refresh());};
  return {d:dom.window.document,reads,requests,mount,installCoding,updateInventory,workAvailable,setUploads,failUploads,refreshUploads};
}

test('an absent local Coding contribution does not read Coding uploads even when the server advertises support',async t=>{
  const f=await fixture(t,[capability(activityId),capability(codingId)]);
  await f.mount();
  assert.ok(f.reads.includes('/api/features'));
  assert.equal(f.reads.some(path=>path.startsWith('/api/coding/uploads')),false);
  assert.equal(f.d.querySelector('.coding-receipt-summary'),null);
  f.workAvailable();
});

for(const [name,coding] of [
  ['missing',undefined],
  ['unavailable',capability(codingId,'1','unavailable')],
  ['version-mismatched',capability(codingId,'2')],
] as const)test('a remote Coding capability that is '+name+' leaves unrelated work available and never reads Coding uploads',async t=>{
  const f=await fixture(t,[capability(activityId),...(coding?[coding]:[])]);
  await f.installCoding();
  await f.mount();
  assert.equal(f.reads.some(path=>path.startsWith('/api/coding/uploads')),false);
  assert.equal(f.d.querySelector('.coding-receipt-summary'),null);
  f.workAvailable();
});

test('compatible Coding support renders its receipt and withdraws when remote support or its local contribution is removed',async t=>{
  const f=await fixture(t,[capability(activityId),capability(codingId)]),coding=await f.installCoding();
  await f.mount();
  assert.ok(f.d.querySelector('.coding-receipt-summary'));
  assert.match(f.d.body.textContent!,/当前页 0 个来源/);
  assert.equal(f.reads.filter(path=>path.startsWith('/api/coding/uploads')).length,1,'summary and detail share the same read resource');
  await f.updateInventory([capability(activityId)]);
  assert.equal(f.d.querySelector('.coding-receipt-summary'),null);
  assert.equal(f.reads.filter(path=>path.startsWith('/api/coding/uploads')).length,1);
  f.workAvailable();
  await f.updateInventory([capability(activityId),capability(codingId)]);
  assert.ok(f.d.querySelector('.coding-receipt-summary'));
  const readsBeforeDisposal=f.reads.filter(path=>path.startsWith('/api/coding/uploads')).length;
  await act(async()=>coding.dispose());
  assert.equal(f.d.querySelector('.coding-receipt-summary'),null);
  assert.equal(f.reads.filter(path=>path.startsWith('/api/coding/uploads')).length,readsBeforeDisposal);
  f.workAvailable();
});

for(const locale of ['en','zh-CN'] as const)test('Coding receipts render zero, one and mixed counts with work and memory attention in '+locale,async t=>{
  const f=await fixture(t,[capability(activityId),capability(codingId)],locale);
  await f.installCoding();
  await f.mount();
  const status=()=>f.d.querySelector('.coding-receipt-summary > p[role="status"]')!.textContent;
  const scenarios=[
    {items:[],en:'Current page · Sources: 0 · Received increments: 0 · Published conversations: 0',zh:'当前页 0 个来源 · 已接收 0 条增量 · 已发布 0 份会话'},
    {items:[upload('new-source',0,0)],en:'Current page · Sources: 1 · Received increments: 0 · Published conversations: 0',zh:'当前页 1 个来源 · 已接收 0 条增量 · 已发布 0 份会话'},
    {items:[upload('one-conversation',1,1)],en:'Current page · Sources: 1 · Received increments: 1 · Published conversations: 1',zh:'当前页 1 个来源 · 已接收 1 条增量 · 已发布 1 份会话'},
    {items:[upload('waiting-model',3,0,[{state:'waiting_for_model',count:3}]),upload('running',2,0,[{state:'running',count:2}],[{state:'waiting',count:1}])],en:'Current page · Sources: 2 · Received increments: 5 · Published conversations: 0',zh:'当前页 2 个来源 · 已接收 5 条增量 · 已发布 0 份会话'},
    {items:[upload('blocked-work',7,1,[{state:'blocked',count:2}])],en:'Current page · Sources: 1 · Received increments: 7 · Published conversations: 1 · Processing needs attention',zh:'当前页 1 个来源 · 已接收 7 条增量 · 已发布 1 份会话 · 有处理事项需关注'},
    {items:[upload('failed-memory',1,1,[],[{state:'failed',count:1}]),upload('another-source',1,0),upload('published',6,3,[{state:'complete',count:3}])],en:'Current page · Sources: 3 · Received increments: 8 · Published conversations: 4 · Processing needs attention',zh:'当前页 3 个来源 · 已接收 8 条增量 · 已发布 4 份会话 · 有处理事项需关注'},
    {items:[upload('completed',2,1,[{state:'complete',count:1}],[{state:'completed',count:1}]),upload('published-more',5,2)],en:'Current page · Sources: 2 · Received increments: 7 · Published conversations: 3',zh:'当前页 2 个来源 · 已接收 7 条增量 · 已发布 3 份会话'},
  ];
  assert.equal(status(),locale==='en'?scenarios[0]!.en:scenarios[0]!.zh);
  for(const scenario of scenarios.slice(1)){
    const before=f.reads.length;
    f.setUploads(scenario.items);
    await f.refreshUploads();
    assert.equal(status(),locale==='en'?scenario.en:scenario.zh);
    assert.deepEqual(f.reads.slice(before),[uploadsPath],'each refresh reads the shared summary/detail resource once');
  }
  assert.deepEqual(f.reads,['/api/features',...scenarios.map(()=>uploadsPath)]);
  for(const request of f.requests){
    assert.equal(request.headers.get('Accept-Language'),locale);
    assert.equal(request.headers.get('Authorization'),'Bearer generated-receipt-token');
    assert.ok(request.signal instanceof AbortSignal);
  }
  const details=f.d.querySelector<HTMLDetailsElement>('.coding-receipt-summary > details')!;
  assert.equal(details.open,false);
  const beforeOpening=f.reads.length;
  await act(async()=>details.querySelector('summary')!.click());
  assert.equal(details.open,true);
  assert.equal(f.reads.length,beforeOpening,'opening details uses the already fetched receipt');
  const detail=f.d.querySelector('.coding-uploads[role="region"]')!;
  assert.equal(detail.getAttribute('aria-label'),locale==='en'?'Coding conversation sync status':'Coding 会话同步状态');
  assert.deepEqual(Array.from(detail.querySelectorAll('article > h3'),heading=>heading.textContent),['Generated completed','Generated published-more']);
  assert.deepEqual(Array.from(detail.querySelectorAll('article a'),link=>link.getAttribute('href')),['#/library?view=materials&sourceId=generated-completed','#/library?view=materials&sourceId=generated-published-more']);
});

for(const locale of ['en','zh-CN'] as const)test('Coding receipt request failures replace counts and recover on a real API refresh in '+locale,async t=>{
  const f=await fixture(t,[capability(activityId),capability(codingId)],locale);
  await f.installCoding();
  f.setUploads([upload('before-error',3,1)]);
  await f.mount();
  const status=()=>f.d.querySelector('.coding-receipt-summary > p[role="status"]')!.textContent;
  assert.equal(status(),locale==='en'?'Current page · Sources: 1 · Received increments: 3 · Published conversations: 1':'当前页 1 个来源 · 已接收 3 条增量 · 已发布 1 份会话');
  f.failUploads();
  await f.refreshUploads();
  assert.equal(status(),locale==='en'?'Receipt status unavailable. Expand to retry.':'接收状态暂不可用，请展开重试。');
  assert.equal(f.d.querySelector('.coding-uploads [role="alert"]')!.textContent,locale==='en'?'The central service is temporarily unavailable (503). Check the node status and try again.':'中央服务暂不可用（503），请检查节点状态后重试。');
  f.setUploads([upload('after-error',1,0),upload('recovered',4,2)]);
  await f.refreshUploads();
  assert.equal(status(),locale==='en'?'Current page · Sources: 2 · Received increments: 5 · Published conversations: 2':'当前页 2 个来源 · 已接收 5 条增量 · 已发布 2 份会话');
  assert.equal(f.d.querySelector('.coding-uploads [role="alert"]'),null);
  assert.deepEqual(f.reads,['/api/features',uploadsPath,uploadsPath,uploadsPath]);
});
