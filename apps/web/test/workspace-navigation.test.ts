import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM} from 'jsdom';
import {isSettingsContext,primaryDestination,parentDestination,WorkspaceNavigation,SettingsLanding} from '../src/WorkspaceNavigation.js';
import {webFeatures} from '../src/features/registry.js';
import {configureLocale} from '@mote/shared/i18n';

test('the complete directory belongs to Home while installed settings keep their own task context',async t=>{
 configureLocale(()=> 'zh-CN');
 const featureId='generated.settings-context';
 const registration=await webFeatures.install({id:featureId,version:'1',components:[]},[
  ...[{id:'overview',route:'today',label:'今天'},{id:'featureGuide',route:'guide',label:'全部功能'},
    {id:'about',route:'preferences',label:'设置'},{id:'settings',route:'system/models',label:'模型与服务',section:'system'},
    {id:'vault',route:'system/storage',label:'存储',section:'system'},{id:'generated-setting',route:'system/generated',label:'Generated settings',section:'system'}]
    .map(entry=>({surface:'page' as const,entry:{...entry,featureId,render:()=>null}})),
 ]);
 t.after(()=>registration.dispose());
 for(const page of ['about','settings','vault','generated-setting'])assert.equal(isSettingsContext(page),true,page);
 assert.equal(isSettingsContext('featureGuide'),false);assert.equal(isSettingsContext('archive'),false);
 assert.equal(primaryDestination('featureGuide'),'overview');assert.equal(parentDestination('featureGuide'),'overview');
 const document=new JSDOM(renderToStaticMarkup(React.createElement(WorkspaceNavigation,{page:'featureGuide',onPage:()=>{}}))).window.document;
 assert.equal(document.querySelector('button'),null,'the final directory owns its context return in its heading instead of duplicating a Home-only back link');
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
 const modelCard=()=>Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>('.settings-link-grid button')).find(button=>button.querySelector('strong')?.textContent==='模型与服务')!;
 await act(async()=>root.render(React.createElement(SettingsLanding,{onPage:page=>destinations.push(page)})));
 assert.equal(modelCard().disabled,false);await act(async()=>modelCard().click());assert.deepEqual(destinations,['settings']);
 await act(async()=>registration.dispose());
 assert.equal(modelCard().disabled,true);assert.equal(modelCard().querySelector('strong')?.textContent,'模型与服务');assert.match(modelCard().textContent??'',/当前服务未提供此入口/);
 await act(async()=>modelCard().click());assert.deepEqual(destinations,['settings']);assert.equal(dom.window.location.hash,'#/preferences');
 await act(async()=>{registration=await install();});
 assert.equal(modelCard().disabled,false);assert.doesNotMatch(modelCard().textContent??'',/当前服务未提供此入口/);
 await act(async()=>modelCard().click());assert.deepEqual(destinations,['settings','settings']);
});
