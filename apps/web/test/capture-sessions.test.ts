import '@mote/shared/i18n-all';
import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import type {CaptureSession} from '@mote/shared';
import {configureLocale,getLocale,type Locale} from '@mote/shared/i18n';
import {CaptureSessions} from '../src/plugins/library/CaptureSessions.js';
import {captureDateRange} from '../src/capture-presentation.js';
import {createApi,type Device} from '../src/api.js';

type ImageRef={id:string;capturedAt:string;hasImage:boolean;appName:string};
type Page={items:(CaptureSession|ImageRef)[];totalCount:number;sessionCount?:number;albumCount?:number;nextCursor:string|null};
const group=(id:string):CaptureSession=>({id,deviceId:'generated-device-2',appId:'generated.app',appName:'Generated app',firstAt:'2026-10-14T01:00:00Z',capturedAt:'2026-10-14T01:02:00Z',after:'2026-10-14T01:00:00.000Z',before:'2026-10-14T01:02:00.001Z',count:2,imageCount:0});
const image=(id:string):ImageRef=>({id,capturedAt:'2026-10-14T01:01:00Z',hasImage:false,appName:'Generated app'});
const devices:Device[]=[1,2].map(n=>({deviceId:'generated-device-'+n,deviceName:'Generated device '+n,platform:'generated',status:'online',queueDepth:0,lastSeenAt:'2026-10-14T01:00:00Z'}));

async function fixture(t:import('node:test').TestContext,locale:Locale){
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true});
  const previousLocale=getLocale(),previous=new Map<string,PropertyDescriptor|undefined>();
  configureLocale(()=>locale);
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  const d=dom.window.document,root=createRoot(d.getElementById('root')!);
  const requests:{url:URL;headers:Headers;signal:AbortSignal|null|undefined}[]=[],opened:string[]=[];
  let revision=0,respond:(url:URL)=>Page=()=>({items:[],totalCount:0,sessionCount:0,nextCursor:null});
  const fetch=t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input),'http://localhost/');
    assert.ok(['/api/capture-browser/sessions','/api/capture-browser/albums','/api/capture-browser/album-images'].includes(url.pathname),'only generated capture browsing reads are allowed');
    assert.equal(init?.method,undefined);
    requests.push({url,headers:new Headers(init?.headers),signal:init?.signal});
    return Response.json(respond(url));
  });
  const api=createApi({token:'generated-capture-session-token'});
  const render=()=>act(async()=>root.render(React.createElement(CaptureSessions,{api,devices,onOpen:id=>opened.push(id),revision})));
  t.after(async()=>{
    try{await act(async()=>root.unmount());}
    finally{
      fetch.mock.restore();
      for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}
      configureLocale(()=>previousLocale);dom.window.close();
    }
  });
  const select=async(control:HTMLSelectElement,value:string)=>act(async()=>{control.value=value;control.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  const click=async(control:HTMLElement)=>act(async()=>control.click());
  const status=()=>d.querySelector('[role="status"]')!.textContent;
  const pagination=()=>Array.from(d.querySelectorAll<HTMLButtonElement>('.form-footer > button'));
  const filters=()=>Array.from(d.querySelectorAll<HTMLSelectElement>('.capture-session-filters select'));
  const refresh=()=>d.querySelector<HTMLButtonElement>('.capture-session-filters button')!;
  const last=()=>requests.at(-1)!.url;
  return {d,requests,opened,status,pagination,filters,refresh,last,click,select,render,
    mode:async(value:string)=>click(d.querySelector<HTMLElement>('.capture-group-tabs [data-mode="'+value+'"]')!),
    respond:(handler:(url:URL)=>Page)=>{respond=handler;},
    revise:async()=>{revision++;await render();},
  };
}

for(const locale of ['en','zh-CN'] as const)test('capture grouping renders zero, one and multiple server counts in '+locale,async t=>{
  const f=await fixture(t,locale);
  await f.render();
  const scenarios=[
    {groups:0,records:0,items:[]},
    {groups:1,records:1,items:[group('generated-one')]},
    {groups:7,records:41,items:[group('generated-first-page')]},
  ];
  for(const mode of ['sessions','albums'] as const){
    await f.mode(mode);
    for(const scenario of scenarios){
      f.respond(()=>({items:scenario.items,totalCount:scenario.records,...(mode==='sessions'?{sessionCount:scenario.groups}:{albumCount:scenario.groups}),nextCursor:null}));
      const before=f.requests.length;
      await f.click(f.refresh());
      assert.equal(f.requests.length,before+1,'the Refresh widget reads the current grouping once');
      assert.equal(f.last().pathname,'/api/capture-browser/'+mode);
      assert.equal(f.status(),locale==='en'
        ?`${mode==='sessions'?'Sessions':'Albums'}: ${scenario.groups} · Records: ${scenario.records} · Page 1`
        :`${mode==='sessions'?'会话':'相册'}：${scenario.groups} · ${scenario.records} 条记录 · 第 1 页`);
      assert.equal(f.d.querySelectorAll('.session-card').length,scenario.items.length,'aggregate counts are independent of the current page size');
      assert.equal(f.pagination()[0]!.disabled,true);
      assert.equal(f.pagination()[1]!.disabled,true);
      assert.equal(!!f.d.querySelector('.workspace-empty'),scenario.records===0);
    }
  }
  for(const request of f.requests){
    assert.equal(request.headers.get('Accept-Language'),locale);
    assert.equal(request.headers.get('Authorization'),'Bearer generated-capture-session-token');
    assert.ok(request.signal instanceof AbortSignal);
  }
});

for(const locale of ['en','zh-CN'] as const)test('capture grouping selection, filtering and pagination preserve session and album scopes in '+locale,async t=>{
  const f=await fixture(t,locale);
  let selectedTotal=3;
  f.respond(url=>{
    if(url.searchParams.has('sessionId'))return {items:selectedTotal?[image('11111111-1111-4111-8111-111111111111')]:[],totalCount:selectedTotal,nextCursor:selectedTotal>1&&!url.searchParams.has('cursor')?'generated-image-page-2':null};
    if(url.pathname.endsWith('/album-images'))return {items:[image('22222222-2222-4222-8222-222222222222')],totalCount:1,nextCursor:null};
    const mode=url.pathname.endsWith('/sessions')?'sessions':'albums',second=url.searchParams.has('cursor');
    return {items:[group('generated-'+mode+(second?'-second':'-first'))],totalCount:mode==='sessions'?41:12,...(mode==='sessions'?{sessionCount:7}:{albumCount:3}),nextCursor:second?null:'generated-'+mode+'-page-2'};
  });
  await f.render();
  const expected=(prefix:'sessions'|'albums'|null,records:number,page:number)=>locale==='en'
    ?`${prefix?`${prefix==='sessions'?'Sessions: 7':'Albums: 3'} · `:''}Records: ${records} · Page ${page}`
    :`${prefix?`${prefix==='sessions'?'会话：7':'相册：3'} · `:''}${records} 条记录 · 第 ${page} 页`;
  assert.equal(f.status(),expected('sessions',41,1));
  const day=f.d.querySelector<HTMLInputElement>('input[type="date"]')!.value,range=captureDateRange(day,day);
  assert.equal(f.last().searchParams.get('after'),range.after);
  assert.equal(f.last().searchParams.get('before'),range.before);
  await f.select(f.filters()[0]!,'generated-device-2');
  assert.equal(f.last().searchParams.get('deviceId'),'generated-device-2');
  await f.click(f.pagination()[1]!);
  assert.equal(f.last().searchParams.get('cursor'),'generated-sessions-page-2');
  assert.equal(f.status(),expected('sessions',41,2));
  await f.click(f.pagination()[0]!);
  assert.equal(f.last().searchParams.has('cursor'),false);
  assert.equal(f.status(),expected('sessions',41,1));
  await f.click(f.pagination()[1]!);
  await f.click(f.d.querySelector<HTMLButtonElement>('.session-card')!);
  assert.equal(f.last().searchParams.get('sessionId'),'generated-sessions-second');
  assert.equal(f.last().searchParams.get('deviceId'),'generated-device-2');
  assert.equal(f.last().searchParams.has('cursor'),false,'opening a group resets its internal page');
  assert.equal(f.status(),expected(null,3,1),'selected records omit the outer session count');
  await f.click(f.d.querySelector<HTMLButtonElement>('.session-image')!);
  assert.deepEqual(f.opened,['capture:11111111-1111-4111-8111-111111111111']);
  await f.click(f.pagination()[1]!);
  assert.equal(f.last().searchParams.get('cursor'),'generated-image-page-2');
  assert.equal(f.last().searchParams.get('sessionId'),'generated-sessions-second');
  assert.equal(f.status(),expected(null,3,2));
  await f.click(f.pagination()[0]!);
  for(const count of [0,1,3]){
    selectedTotal=count;await f.revise();
    assert.equal(f.status(),expected(null,count,1),'zero, one and multiple selected records retain the selected scope without a group prefix');
    assert.equal(f.last().searchParams.get('sessionId'),'generated-sessions-second');
  }
  await f.click(f.d.querySelector<HTMLButtonElement>('.section-heading > button')!);
  assert.equal(f.status(),expected('sessions',41,1));
  assert.equal(f.last().searchParams.has('sessionId'),false);
  assert.equal(f.filters()[0]!.value,'generated-device-2');
  assert.equal(f.d.querySelector<HTMLInputElement>('input[type="date"]')!.value,day);
  await f.click(f.pagination()[1]!);
  await f.mode('albums');
  assert.equal(f.last().pathname,'/api/capture-browser/albums');
  assert.equal(f.last().searchParams.has('cursor'),false,'changing aggregation resets the outer page');
  assert.equal(f.status(),expected('albums',12,1));
  await f.click(f.pagination()[1]!);
  assert.equal(f.last().searchParams.get('cursor'),'generated-albums-page-2');
  assert.equal(f.status(),expected('albums',12,2));
  const selected=group('generated-albums-second');
  await f.click(f.d.querySelector<HTMLButtonElement>('.session-card')!);
  assert.equal(f.last().pathname,'/api/capture-browser/album-images');
  assert.equal(f.last().searchParams.get('deviceId'),selected.deviceId);
  assert.equal(f.last().searchParams.get('appId'),selected.appId);
  assert.equal(f.last().searchParams.get('after'),selected.after);
  assert.equal(f.last().searchParams.get('before'),selected.before);
  assert.equal(f.last().searchParams.has('cursor'),false);
  assert.equal(f.status(),expected(null,1,1),'selected album records omit the outer album count');
  await f.click(f.d.querySelector<HTMLButtonElement>('.section-heading > button')!);
  assert.equal(f.status(),expected('albums',12,1));
  assert.equal(f.d.querySelector('.capture-group-tabs [aria-selected=true]')?.getAttribute('data-mode'),'albums');
  assert.equal(f.last().searchParams.get('deviceId'),'generated-device-2');
  assert.equal(f.last().searchParams.get('after'),range.after);
  assert.equal(f.last().searchParams.get('before'),range.before);
  await f.click(f.pagination()[1]!);
  await f.select(f.filters()[0]!,'');
  assert.equal(f.last().searchParams.has('deviceId'),false,'the actual device filter clears the request scope');
  assert.equal(f.last().searchParams.has('cursor'),false,'filter changes reset pagination');
  assert.equal(f.status(),expected('albums',12,1));
  assert.equal(f.d.querySelector('[role="alert"]'),null);
});
