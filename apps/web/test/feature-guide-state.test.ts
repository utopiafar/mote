import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale,getLocale} from '@mote/shared/i18n';
import {FeatureGuide} from '../src/FeatureGuide';
import {guideVisit,enterGuide,leaveGuide} from '../src/feature-guide-state';
import {QuickNoteContext} from '../src/quick-note-context';
import {webFeatures} from '../src/features/registry';
import type {Api} from '../src/api';

test('directory navigation preserves its query and disclosure by API identity, opens the global note, and retains the live page guard',async t=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/guide',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>(),locale=getLocale();configureLocale(()=>'zh-CN');
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});}
 const registration=await webFeatures.install({id:'fixture.guide-state',version:'1',components:[]},['overview','notes','activity','featureGuide'].map(id=>({surface:'page' as const,entry:{id,route:id==='featureGuide'?'guide':id==='notes'?'library/notes':id==='overview'?'today':id,featureId:'fixture.guide-state',render:()=>null}})));
 const root=createRoot(dom.window.document.querySelector('#root')!);let notes=0;const pages:string[]=[];
 t.after(async()=>{await act(async()=>root.unmount());await registration.dispose();configureLocale(()=>locale);for(const[key,value]of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 const api=()=>({request:async()=>({schemaVersion:1,revision:1,features:[],capabilities:[]}),setAgentTimeout:()=>{}} as unknown as Api),first=api(),second=api();
 const render=async(api:Api)=>act(async()=>root.render(React.createElement(QuickNoteContext.Provider,{value:()=>{notes++;}},React.createElement(FeatureGuide,{api,onPage:page=>pages.push(page)}))));
 enterGuide(first,'#/today');guideVisit(first).query='随手记';guideVisit(first).expanded=['G05'];
 await render(first);const d=dom.window.document;
 assert.equal(d.querySelector<HTMLInputElement>('input')!.value,'随手记');assert.equal(d.querySelectorAll('[data-capability-id]').length,2);
 await act(async()=>d.querySelector<HTMLAnchorElement>('[data-capability-id="C12"] a')!.click());
 assert.equal(notes,1);assert.equal(location.hash,'#/guide','opening the global note leaves the directory underneath');assert.equal(guideVisit(first).returnAvailable,false);
 await render(second);assert.equal(d.querySelector<HTMLInputElement>('input')!.value,'');assert.equal(d.querySelectorAll('[data-capability-id]').length,77);assert.equal(d.querySelectorAll('.guide-group[open]').length,0,'another verified API never inherits prior search/disclosure');
 await render(first);assert.equal(d.querySelector<HTMLInputElement>('input')!.value,'随手记');assert.equal(d.querySelector('.guide-group')?.hasAttribute('open'),true);
 await act(async()=>root.render(null));guideVisit(first).query='正在做的工作';await render(first);
 await act(async()=>d.querySelector<HTMLAnchorElement>('[data-capability-id="C28"] a')!.click());assert.equal(location.hash,'#/activity');assert.equal(guideVisit(first).returnAvailable,true);
 await act(async()=>root.render(null));guideVisit(first).query='no-such-feature-generated';await render(first);assert.ok(d.querySelector('[role="status"]'));assert.equal(d.querySelectorAll('[data-capability-id]').length,0);
 await act(async()=>d.querySelector<HTMLButtonElement>('.guide-heading button')!.click());assert.equal(location.hash,'#/today');assert.equal(guideVisit(first).returnAvailable,false);
 await act(async()=>root.render(null));guideVisit(first).query='随手记';await render(first);
 const oldLink=d.querySelector<HTMLAnchorElement>('[data-capability-id="C12"] a')!;
 await act(async()=>{await registration.dispose();oldLink.click();});
 assert.equal(notes,1,'disposed local page cannot launch a modal through an old link');assert.equal(d.querySelector('[data-capability-id="C12"] a'),null);
 leaveGuide(second);assert.equal(guideVisit(first).returnAvailable,false);assert.equal(guideVisit(second).returnAvailable,true);
});
