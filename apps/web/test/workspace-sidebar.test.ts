import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import React, {act, useContext, useSyncExternalStore} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {navigationFor, pageHash, type NavItemId, type NavState} from '@mote/shared';
import {WorkspaceSidebar} from '../src/WorkspaceSidebar';
import {featuresReady} from '../src/features/bootstrap';
import {WebFeatureHost} from '../src/features/host';
import {webFeatures} from '../src/features/registry';
import {readPage, workspaceNavigation} from '../src/navigation';
import {NavStateContext, useNavState} from '../src/use-nav-state';
import type {Api} from '../src/api';

const ids=(d:Document,group:'daily'|'manage')=>
  [...d.querySelectorAll(`[data-nav-group="${group}"] [data-nav-item]`)].map(button=>button.getAttribute('data-nav-item'));

test('NV3-01 Chat is selected and the two groups follow the shared manifest and mounted pages',async()=>{
  await featuresReady;
  const groups=workspaceNavigation();
  const markup=renderToStaticMarkup(React.createElement(WorkspaceSidebar,{groups,page:readPage(''),onPage:()=>{}}));
  const dom=new JSDOM(markup);
  try{
    const d=dom.window.document;
    const expected=navigationFor({
      enabledPackages:new Set(webFeatures.registry.inventory().features.map(feature=>feature.id)),
      registered:new Set<NavItemId>(['chat','feed','goals','library','memory','skills','connections','settings']),
    });
    assert.deepEqual(ids(d,'daily'),expected.daily.map(item=>'id' in item?item.id:item.pageId));
    assert.deepEqual(ids(d,'manage'),expected.manage.map(item=>item.id));
    assert.deepEqual(ids(d,'daily'),['chat','feed','goals','library']);
    assert.deepEqual(ids(d,'manage'),['memory','skills','connections','settings']);
    assert.equal(d.querySelector('[data-nav-item="chat"]')?.getAttribute('aria-current'),'page');
    assert.ok(d.querySelector('#primary-navigation .brand svg'));
    assert.equal(d.querySelector('#primary-navigation .brand')?.textContent,'');
    assert.equal(d.querySelector('.node-state, .workspace-node-menu, [data-nav-item="ideas"]'),null);
    for(const button of d.querySelectorAll('[data-nav-item]'))assert.ok(button.querySelector('svg'));
    assert.equal(readPage(pageHash('chat')),'ask');
  }finally{dom.window.close();}
});

async function fixture(t:TestContext){
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true});
  const previous=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  const root=createRoot(dom.window.document.getElementById('root')!);
  const host=new WebFeatureHost();
  t.after(async()=>{
    await act(async()=>root.unmount());
    await host.close();
    for(const [key,value] of previous){
      if(value)Object.defineProperty(globalThis,key,value);
      else Reflect.deleteProperty(globalThis,key);
    }
    dom.window.close();
  });
  const install=(featureId:string,navItem:NavItemId)=>host.install({id:featureId,version:'1',components:[]},[
    {surface:'page',entry:{id:'generated-'+navItem,navItem,featureId,render:()=>null}},
  ]);
  return {root,d:dom.window.document,host,install};
}

test('NV3-02 removing the Feed plugin closes its slot without disturbing neighboring destinations',async t=>{
  const {root,d,host,install}=await fixture(t);
  await install('mote.ask','chat');
  const feed=await install('mote.assistant','feed');
  await install('mote.library','library');
  const destinations:string[]=[];
  function Shell(){
    useSyncExternalStore(host.registry.subscribe,host.registry.getRevision,host.registry.getRevision);
    return React.createElement(WorkspaceSidebar,{groups:workspaceNavigation(host),page:'generated-chat',onPage:page=>destinations.push(page)});
  }
  await act(async()=>root.render(React.createElement(Shell)));
  assert.deepEqual(ids(d,'daily'),['chat','feed','library']);
  await act(async()=>feed.dispose());
  assert.deepEqual(ids(d,'daily'),['chat','library']);
  assert.equal(d.querySelectorAll('[data-nav-group="daily"] button').length,2);
  await act(async()=>d.querySelector<HTMLButtonElement>('[data-nav-item="library"]')!.click());
  assert.deepEqual(destinations,['generated-library']);
});

test('NV3-03 one visible poll updates badges and revisions, and zero removes the badges',async t=>{
  const {root,d,host,install}=await fixture(t);
  await install('mote.assistant','ideas');
  await install('mote.connections','connections');
  t.mock.timers.enable({apis:['setTimeout']});
  let hidden=false;
  Object.defineProperty(d,'hidden',{get:()=>hidden});
  let server:NavState={
    revisions:{library:'l1',cards:'c1',commitments:'g1',matters:'t1',memory:'m1',sources:'s1',plugins:'p1'},
    badges:{ideas:3,connections:true},
  };
  const reads:string[]=[];
  const api={raw:async(path:string,init:RequestInit={})=>{
    reads.push(path);
    assert.equal(init.method,undefined);
    const body=JSON.stringify(server),etag='"'+server.revisions.cards+':'+server.revisions.library+'"';
    if((init.headers as Record<string,string>|undefined)?.['If-None-Match']===etag)return new Response(null,{status:304,headers:{ETag:etag}});
    return new Response(body,{status:200,headers:{ETag:etag}});
  }} as Api;
  function PageRevision(){
    return React.createElement('output',{'data-revision':useContext(NavStateContext)?.revisions.cards});
  }
  function Shell(){
    return React.createElement(NavStateContext.Provider,{value:useNavState(api)},
      React.createElement(WorkspaceSidebar,{groups:workspaceNavigation(host),page:'generated-ideas',onPage:()=>{}}),
      React.createElement(PageRevision));
  }
  await act(async()=>root.render(React.createElement(Shell)));
  assert.equal(d.querySelector('[data-nav-badge="ideas"]')?.textContent,'3');
  assert.ok(d.querySelector('[data-nav-badge="connections"]'));
  assert.equal(d.querySelector('output')?.dataset.revision,'c1');
  assert.deepEqual(reads,['/api/nav-state']);
  server={revisions:{...server.revisions,cards:'c2'},badges:{ideas:0,connections:false}};
  await act(async()=>t.mock.timers.tick(29_999));
  assert.equal(reads.length,1);
  await act(async()=>t.mock.timers.tick(1));
  assert.equal(reads.length,2);
  assert.equal(d.querySelector('[data-nav-badge]'),null);
  assert.equal(d.querySelector('output')?.dataset.revision,'c2');
  await act(async()=>{
    hidden=true;
    d.dispatchEvent(new window.Event('visibilitychange'));
    t.mock.timers.tick(60_000);
  });
  assert.equal(reads.length,2);
  await act(async()=>{
    hidden=false;
    d.dispatchEvent(new window.Event('visibilitychange'));
  });
  assert.deepEqual(reads,Array(3).fill('/api/nav-state'));
});
