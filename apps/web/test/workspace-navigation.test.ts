import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM} from 'jsdom';
import {isSettingsContext,primaryDestination,parentDestination,WorkspaceNavigation,SettingsLanding} from '../src/WorkspaceNavigation.js';
import {webFeatures} from '../src/features/registry.js';
import {configureLocale} from '@mote/shared/i18n';
import {pageRoutes} from '@mote/shared';
import {readPage} from '../src/navigation';
import {readWorkspaceRoute} from '../src/workspace-route';
import {assistantEntrypoints} from '../src/assistant-entrypoints';

test('the root resolves to Chat while retired pages stay unavailable', async t=>{
 const featureId='mote.ask';
 const registration=await webFeatures.install({id:featureId,version:'1',components:[]},[
  {surface:'page',entry:{id:'ask',route:pageRoutes.chat,navItem:'chat',featureId,render:()=>null}},
 ]);
 t.after(()=>registration.dispose());
 for(const hash of ['', '#', '#/', '#/'+pageRoutes.chat]){
  assert.equal(readWorkspaceRoute(hash,readPage,[]).page,'ask',hash);
 }
 for(const hash of ['#/today','#/ask','#/guide','#ask','#/ask?question=generated']){
  assert.equal(readWorkspaceRoute(hash,readPage,[]).page,'unavailable',hash);
  assert.equal(parentDestination('unavailable'),undefined);
 }
});

test('registered assistant pages keep their workspace return and stay outside Settings',async t=>{
 const featureId='mote.assistant';
 const fiber=await webFeatures.install({id:featureId,version:'1',components:[]},
  assistantEntrypoints.map(entry=>({surface:'page' as const,entry:{id:entry.pageId,route:entry.href.slice(2),label:entry.title,
    ...(entry.pageId==='assistantMemory'?{navItem:'memory' as const}:{}),featureId,render:()=>null}})),
 );
 t.after(()=>fiber.dispose());
 for(const entry of assistantEntrypoints){
  const ownWorkspace=entry.pageId==='assistantMemory';
  assert.equal(primaryDestination(entry.pageId),ownWorkspace?entry.pageId:'ask');
  assert.equal(parentDestination(entry.pageId),ownWorkspace?undefined:'ask');
  assert.equal(isSettingsContext(entry.pageId),false,entry.pageId);
 }
 const settings=renderToStaticMarkup(React.createElement(SettingsLanding,{onPage:()=>{}}));
 for(const entry of assistantEntrypoints)assert.equal(settings.includes(entry.title),false,entry.pageId);
});

test('the legacy Coding page stays under Library and has a Library parent without a Settings card',async t=>{
 configureLocale(()=> 'zh-CN');
 const featureId='generated.legacy-coding-navigation';
 const fiber=await webFeatures.install({id:featureId,version:'1',components:[]},[
  {surface:'page',entry:{id:'archive',route:'library',label:'资料库',section:'library',featureId,render:()=>null}},
  {surface:'page',entry:{id:'coding',route:'library/coding',label:'Generated Coding status',featureId,render:()=>null}},
 ]);
 t.after(()=>fiber.dispose());
 assert.equal(webFeatures.page('coding')?.route,'library/coding','the legacy route remains registered');
 assert.equal(primaryDestination('coding'),'archive');assert.equal(parentDestination('coding'),'archive');
 const d=new JSDOM(renderToStaticMarkup(React.createElement(WorkspaceNavigation,{page:'coding',onPage:()=>{}}))).window.document;
 assert.equal(d.querySelector('button[aria-label="返回资料库"]')?.textContent,'返回上级');
 assert.equal(d.querySelector('select'),null,'a legacy-only route does not add a new tool dropdown');
 const settings=renderToStaticMarkup(React.createElement(SettingsLanding,{onPage:()=>{}}));
 assert.doesNotMatch(settings,/Generated Coding status/);
});

test('AI access keeps its own route while source setup retains its parent',async t=>{
 configureLocale(()=> 'zh-CN');
 const featureId='generated.ai-access-navigation';
 const fiber=await webFeatures.install({id:featureId,version:'1',components:[]},[
  {surface:'page',entry:{id:'sources',route:pageRoutes.connections,label:'来源',navItem:'connections',section:'connections',featureId,render:()=>null}},
  {surface:'page',entry:{id:'connections',route:'connections/access',label:'AI 接入',section:'connections',featureId,render:()=>null}},
  {surface:'page',entry:{id:'gmail',route:'sources/gmail',label:'Gmail',section:'connections',featureId,render:()=>null}},
 ]);
 t.after(()=>fiber.dispose());
 assert.equal(primaryDestination('connections'),'sources');
 assert.equal(parentDestination('connections'),undefined);
 const access=new JSDOM(renderToStaticMarkup(React.createElement(WorkspaceNavigation,{page:'connections',onPage:()=>{}}))).window.document;
 assert.equal(access.querySelector('button'),null,'the AI access component owns its detail/new-connection return without an unrelated source parent');
 assert.equal(parentDestination('gmail'),'sources');
 const source=new JSDOM(renderToStaticMarkup(React.createElement(WorkspaceNavigation,{page:'gmail',onPage:()=>{}}))).window.document;
 assert.equal(source.querySelector('button[aria-label="返回来源"]')?.textContent,'返回上级');
});


test('fixed Settings cards react to page disposal and restoration without invoking an unavailable destination',async t=>{
 configureLocale(()=> 'zh-CN');
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/preferences'}),previous=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){
  previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 }
 const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!),destinations:string[]=[];
 const install=()=>webFeatures.install({id:'generated.settings-destination',version:'1',components:[]},[{surface:'page',entry:{id:'settings',route:'system/models',label:'Generated models',featureId:'generated.settings-destination',render:()=>null}}]);
 let registration=await install();
 t.after(async()=>{await act(async()=>root.unmount());await registration.dispose();for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 const modelCard=()=>Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>('.settings-directory-rows button')).find(button=>button.querySelector('strong')?.textContent==='模型与服务')!;
 await act(async()=>root.render(React.createElement(SettingsLanding,{onPage:page=>destinations.push(page)})));
 assert.equal(modelCard().disabled,false);await act(async()=>modelCard().click());assert.deepEqual(destinations,['settings']);
 await act(async()=>registration.dispose());
 assert.equal(modelCard().disabled,true);assert.equal(modelCard().querySelector('strong')?.textContent,'模型与服务');assert.match(modelCard().textContent??'',/当前服务未提供此入口/);
 await act(async()=>modelCard().click());assert.deepEqual(destinations,['settings']);assert.equal(dom.window.location.hash,'#/preferences');
 await act(async()=>{registration=await install();});
 assert.equal(modelCard().disabled,false);assert.doesNotMatch(modelCard().textContent??'',/当前服务未提供此入口/);
 await act(async()=>modelCard().click());assert.deepEqual(destinations,['settings','settings']);
});
