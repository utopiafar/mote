import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {randomUUID} from 'node:crypto';
import {configureLocale} from '@mote/shared/i18n';
import type {FeatureInventory,FeedItem,NavState} from '@mote/shared';
import type {Api} from '../src/api.js';
import {FeedPage} from '../src/plugins/assistant/FeedPage.js';
import {NavStateContext} from '../src/use-nav-state.js';

configureLocale(()=> 'zh-CN');
const inventory:FeatureInventory={schemaVersion:1,revision:1,features:[],capabilities:[
  {id:'http:GET:/api/assistant-cards',featureId:'mote.assistant',version:'1',surface:'data',state:'active'},
  {id:'http:POST:/api/assistant-cards/:id/feedback',featureId:'mote.assistant',version:'1',surface:'data',state:'active'},
]};
const navState=(cards:string):NavState=>({revisions:{library:'generated-library',cards,commitments:'generated-commitments',matters:'generated-matters',memory:'generated-memory',sources:'generated-sources',plugins:'generated-plugins'},badges:{}});
const evidence=()=>randomUUID();

function item(overrides:Partial<FeedItem>&{title:string}):FeedItem{
  const id=overrides.id??randomUUID(),at=overrides.createdAt??'2026-11-20T09:00:00+08:00';
  return {
    id,kind:'activity',matterId:null,version:id,state:'open',revision:1,title:overrides.title,
    body:'生成的动态正文。',evidence:[{id:evidence(),quote:'生成的原文依据'}],
    evidenceDependencies:{version:1,complete:true,ids:[]},feedback:[],readAt:null,acceptedTaskId:null,
    taskScope:null,taskEvidence:[],evidenceOrigins:[],createdAt:at,updatedAt:at,...overrides,
  };
}

async function fixture(t:import('node:test').TestContext){
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/feed',pretendToBeVisual:true});
  const before=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,location:dom.window.location,document:dom.window.document,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){
    before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  Object.assign(dom.window.HTMLElement.prototype,{attachEvent:()=>{},detachEvent:()=>{}});
  const root=createRoot(dom.window.document.getElementById('root')!);
  t.after(async()=>{
    await act(async()=>root.unmount());
    for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}
    dom.window.close();
  });
  return {root,d:dom.window.document,w:dom.window};
}

type FeedFixture={items:FeedItem[];categories?:{name:string;count:number}[]};
function fakeApi(state:FeedFixture,requests:string[]){
  return {
    request:async(path:string,init?:{method?:string;body?:string})=>{
      requests.push(path);
      if(path==='/api/features')return inventory;
      if(path.startsWith('/api/assistant-cards?')||path==='/api/assistant-cards')return {items:state.items,nextCursor:null,categories:state.categories??[],revision:'generated-feed-1'};
      const feedback=/^\/api\/assistant-cards\/([^/]+)\/feedback\?/.exec(path);
      if(feedback&&init?.method==='POST'){
        const id=decodeURIComponent(feedback[1]),current=state.items.find(value=>value.id===id);
        assert.ok(current,'feedback targets a returned card');
        const body=JSON.parse(init.body!);
        assert.equal(body.action,'read');
        assert.equal(body.expectedRevision,current.revision,'read feedback carries the card revision');
        current.readAt='2026-11-20T09:05:00+08:00';
        return current;
      }
      throw new Error('Unexpected fixture request: '+path);
    },
    setAgentTimeout:()=>{},
  } as unknown as Api;
}
const settle=async(w:JSDOM['window'])=>{await act(async()=>{await new Promise(resolve=>w.setTimeout(resolve,0));await Promise.resolve();});};
const button=(d:Document,label:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(value=>value.textContent?.trim()===label||value.getAttribute('aria-label')===label);
const feedReads=(requests:string[])=>requests.filter(path=>path.startsWith('/api/assistant-cards?'));
const queryOf=(path:string)=>new URLSearchParams(path.split('?')[1]??'');
const tree=(api:Api,onOpen:(ref:string)=>void,revision='generated-cards-1')=>React.createElement(NavStateContext.Provider,{value:navState(revision)},React.createElement(FeedPage,{api,onOpen}));

test('FE2-01 the feed opens with the default three-day window and server-side discovery kinds',async t=>{
  const {root,d,w}=await fixture(t),requests:string[]=[],api=fakeApi({items:[item({title:'生成的工作动态',category:'工作',subject:'发布小组',action:'周知',gist:'冻结时间改到周五'})],categories:[{name:'工作',count:1}]},requests);
  await act(async()=>root.render(tree(api,()=>{})));
  await settle(w);
  const reads=feedReads(requests);
  assert.equal(reads.length,1);
  const query=queryOf(reads[0]!);
  assert.equal(query.get('window'),'3d');
  assert.equal(query.get('kinds'),'activity,briefing,artifact,discovery');
  assert.equal(query.get('unread'),null);
  assert.deepEqual(JSON.parse(query.get('scope')!),{kind:'all'});
  assert.equal(d.querySelector('.feed-window button.active')!.textContent,'3 天');
  assert.match(d.body.textContent!,/发布小组/);
  assert.match(d.body.textContent!,/冻结时间改到周五/);
  assert.match(d.body.textContent!,/工作 1/);
  assert.equal(d.querySelector('.feed-row')!.getAttribute('data-unread'),'true');
  await act(async()=>button(d,'工作 1')!.click());
  await settle(w);
  assert.equal(queryOf(feedReads(requests).at(-1)!).get('category'),'工作','the category count label is also its server filter');
});

test('FE2-02 opening a row opens its source, records read and removes the unread mark',async t=>{
  const card=item({title:'生成的未读动态',subject:'陈默',action:'回复你',gist:'同步超时问题已修复'}),requests:string[]=[],api=fakeApi({items:[card]},requests);
  const {root,d,w}=await fixture(t),opened:string[]=[];
  await act(async()=>root.render(tree(api,ref=>opened.push(ref))));
  await settle(w);
  const proof=card.evidence[0]!;
  await act(async()=>d.querySelector<HTMLButtonElement>('.feed-row-button')!.click());
  await settle(w);
  assert.deepEqual(opened,[`capture:${proof.id}`]);
  assert.ok(requests.some(path=>path.includes(`/api/assistant-cards/${card.id}/feedback?`)));
  assert.equal(d.querySelector('.feed-row')!.getAttribute('data-unread'),'false');
});

test('FE2-03 group view orders groups and rows by time',async t=>{
  const {root,d,w}=await fixture(t),requests:string[]=[];
  const api=fakeApi({items:[
    item({title:'甲的上午动态',subject:'甲组',createdAt:'2026-11-20T11:00:00+08:00'}),
    item({title:'乙的上午动态',subject:'乙组',createdAt:'2026-11-20T10:00:00+08:00'}),
    item({title:'甲的早晨动态',subject:'甲组',createdAt:'2026-11-20T09:00:00+08:00'}),
  ]},requests);
  await act(async()=>root.render(tree(api,()=>{})));
  await settle(w);
  await act(async()=>button(d,'按组织')!.click());
  const groups=Array.from(d.querySelectorAll<HTMLElement>('.feed-group'));
  assert.deepEqual(groups.map(group=>group.getAttribute('data-feed-group')),['甲组','乙组']);
  assert.deepEqual(Array.from(groups[0]!.querySelectorAll('time')).map(time=>time.getAttribute('datetime')),['2026-11-20T11:00:00+08:00','2026-11-20T09:00:00+08:00']);
  assert.equal(groups[1]!.querySelectorAll('.feed-row').length,1);
  assert.equal(d.querySelector('.feed-list'),null);
});

test('FE2-04 an empty feed shows only the single empty sentence',async t=>{
  const {root,d,w}=await fixture(t),requests:string[]=[],api=fakeApi({items:[]},requests);
  await act(async()=>root.render(tree(api,()=>{})));
  await settle(w);
  assert.equal(d.querySelectorAll('.feed-row').length,0);
  assert.equal(d.querySelector('.feed-empty')!.textContent,'没有新动态');
});

test('FE2-06 a discovery row opens the existing discovery detail route',async t=>{
  const discovery=item({kind:'discovery',title:'本周回顾：发布占了一半的时间',evidence:[],readAt:null,createdAt:'2026-11-19T18:00:00+08:00'});
  const {root,d,w}=await fixture(t),requests:string[]=[],api=fakeApi({items:[discovery]},requests);
  await act(async()=>root.render(tree(api,()=>{})));
  await settle(w);
  assert.equal(d.querySelector('.feed-row')!.getAttribute('data-unread'),'false');
  await act(async()=>d.querySelector<HTMLButtonElement>('.feed-row-button')!.click());
  assert.equal(w.location.hash,'#/library/insights?'+new URLSearchParams({insight:discovery.id}));
  assert.ok(!requests.some(path=>path.includes('/feedback?')),'a discovery is not a readonly card');
});

test('search and unread stay server filters and the cards revision revalidates the current filter',async t=>{
  const {root,d,w}=await fixture(t),requests:string[]=[],api=fakeApi({items:[item({title:'生成的搜索目标'})]},requests);
  const render=(revision:string)=>root.render(tree(api,()=>{},revision));
  await act(async()=>render('generated-cards-1'));
  await settle(w);
  const input=d.querySelector<HTMLInputElement>('.feed-search input')!;
  const setter=Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value')!.set!;
  setter.call(input,'冻结');
  await act(async()=>{input.focus();input.dispatchEvent(new w.Event('input',{bubbles:true}));input.dispatchEvent(new w.KeyboardEvent('keyup',{bubbles:true,key:'a'}));});
  await act(async()=>{await new Promise(resolve=>w.setTimeout(resolve,320));});
  assert.ok(feedReads(requests).some(path=>queryOf(path).get('q')==='冻结'),'typing sends a server search after the short delay');
  await act(async()=>button(d,'未读')!.click());
  await settle(w);
  assert.equal(queryOf(feedReads(requests).at(-1)!).get('unread'),'1');
  const before=feedReads(requests).length;
  await act(async()=>render('generated-cards-2'));
  await settle(w);
  assert.ok(feedReads(requests).length>before,'a changed cards revision re-reads the current filter');
  assert.equal(queryOf(feedReads(requests).at(-1)!).get('q'),'冻结');
});

test('the feed page owns the feed nav item while discovery keeps only its detail route',async()=>{
  const {featuresReady}=await import('../src/features/bootstrap.js');
  const {readPage,workspaceNavigation}=await import('../src/navigation.js');
  const {webFeatures}=await import('../src/features/registry.js');
  await featuresReady;
  assert.equal(readPage('#/feed'),'assistantFeed');
  const feed=webFeatures.page('assistantFeed')!;
  assert.equal(feed.route,'feed');
  assert.equal(feed.navItem,'feed');
  assert.ok(workspaceNavigation().daily.some(value=>'id' in value&&value.id==='feed'&&value.page==='assistantFeed'));
  const discovery=webFeatures.page('insights')!;
  assert.equal(discovery.route,'library/insights');
  assert.equal(discovery.navItem,undefined);
  assert.equal(discovery.section,undefined);
});
