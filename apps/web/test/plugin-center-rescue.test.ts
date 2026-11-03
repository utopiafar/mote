import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import type {Api} from '../src/api.js';
import type {PageProps} from '../src/features/types.js';
import {readPage} from '../src/navigation.js';
import {FeaturePage} from '../src/features/runtime.js';

configureLocale(()=> 'zh-CN');
const dom=new JSDOM('<html><body></body></html>',{url:'http://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
const {createRoot}=await import('react-dom/client');

test('the plugin-center route stays reachable through the host rescue entry without its contribution',async t=>{
 assert.equal(readPage('#/system/plugins'),'extensions');
 assert.equal(readPage('#/system/extensions'),'extensions');
 const destination:string[]=[],element=document.createElement('div');document.body.appendChild(element);const root=createRoot(element);
 t.after(async()=>{await act(async()=>root.unmount());element.remove();});
 const props={api:{} as Api,onPage:(page:string)=>destination.push(page)} as unknown as PageProps;
 await act(async()=>{root.render(React.createElement(FeaturePage,{page:'extensions',props}));await new Promise(resolve=>setTimeout(resolve,15));});
 assert.match(element.textContent!,/自动记忆与插件/);assert.match(element.textContent!,/插件中心暂时不可用/);
 const back=[...element.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='返回设置');assert.ok(back);
 await act(async()=>{back.click();});assert.deepEqual(destination,['about']);
});

test('a failed plugin-center mount leaves the shell bootstrap and rescue route available',async()=>{
 const {webFeatures}=await import('../src/features/registry.js'),original=webFeatures.install.bind(webFeatures);
 webFeatures.install=async(manifest,...rest)=>{if(manifest.id==='mote.features')throw new Error('Generated plugin center mount failure');return original(manifest,...rest);};
 try{
  const {featuresReady,featuresTeardown}=await import('../src/features/bootstrap.js');
  await featuresReady;
  assert.equal(webFeatures.page('extensions'),undefined);
  assert.equal(readPage('#/system/plugins'),'extensions');
  const result=await featuresTeardown();assert.equal(result.errors.length,0);
 }finally{webFeatures.install=original;}
});
