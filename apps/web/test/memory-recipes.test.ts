import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {MemoryRecipeSelection} from '../src/MemoryRecipeSelection.js';
import {resources} from '../src/resource-cache.js';
import type {Api} from '../src/api.js';

test('recipe selection saves default combinations, source overrides and inheritance without requesting historical work',async t=>{
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),backups=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){backups.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
  dom.window.localStorage.setItem('mote.language','zh-CN');const root=createRoot(dom.window.document.getElementById('root')!);
  t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of backups){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
  const personal={id:'mote.personal-memory',version:'2'},coding={id:'mote.coding-memory',version:'2'},missing={id:'generated.missing',version:'1'};
  const configurations=new Map<string,typeof personal[]>([['',[personal]]]),writes:unknown[]=[],paths:string[]=[];
  const view=(sourceId:string)=>({sourceId:sourceId||null,inherited:!!sourceId&&!configurations.has(sourceId),items:(configurations.get(sourceId)??configurations.get('')!).map(recipe=>({binding:{recipe},available:recipe.id!==missing.id}))});
  const api={request:async(path:string,init?:RequestInit)=>{
    paths.push(path);
    if(path==='/api/sources')return {items:[{id:'diary',name:'Generated diary'}]};
    if(path==='/api/memory-recipes')return {items:[{...personal,available:true},{...coding,available:true}]};
    assert.ok(path.startsWith('/api/memory-recipe-settings'),'selection must not request extraction or history replay');
    if(init?.method==='PUT'){const value=JSON.parse(String(init.body));writes.push(value);if(value.recipes===null)configurations.delete(value.sourceId);else configurations.set(value.sourceId??'',value.recipes);return view(value.sourceId??'');}
    return view(new URL(path,'http://localhost').searchParams.get('sourceId')??'');
  }} as Api;
  const d=dom.window.document,checkbox=(label:string)=>Array.from(d.querySelectorAll('label')).find(e=>e.textContent?.includes(label))!.querySelector('input')!;
  const submit=()=>act(async()=>{d.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));});
  await act(async()=>root.render(React.createElement(MemoryRecipeSelection,{api})));
  assert.equal(checkbox('个人记忆').checked,true);assert.equal(checkbox('编码经验').checked,false);
  await act(async()=>checkbox('编码经验').click());await submit();assert.deepEqual(writes.at(-1),{recipes:[personal,coding]});
  await act(async()=>{const select=d.querySelector('select')!;select.value='diary';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  assert.equal(checkbox('跟随默认组合').checked,true);assert.equal(checkbox('个人记忆').disabled,true);
  await act(async()=>checkbox('跟随默认组合').click());await act(async()=>checkbox('个人记忆').click());await submit();
  assert.deepEqual(writes.at(-1),{sourceId:'diary',recipes:[coding]});assert.deepEqual(configurations.get(''),[personal,coding]);
  configurations.set('diary',[coding,missing]);await act(async()=>resources(api).invalidate(k=>k.startsWith('/api/memory-recipe-settings')));
  assert.match(d.body.textContent!,/组件暂不可用/);assert.equal(checkbox('generated.missing').checked,true);assert.equal(checkbox('generated.missing').disabled,false);
  await act(async()=>checkbox('generated.missing').click());await submit();assert.deepEqual(writes.at(-1),{sourceId:'diary',recipes:[coding]});
  await act(async()=>checkbox('跟随默认组合').click());await submit();assert.deepEqual(writes.at(-1),{sourceId:'diary',recipes:null});
  assert.equal(checkbox('个人记忆').checked,true);assert.equal(checkbox('个人记忆').disabled,true);
  await act(async()=>{const select=d.querySelector('select')!;select.value='';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  await act(async()=>checkbox('编码经验').click());configurations.set('',[coding]);
  await act(async()=>resources(api).invalidate(k=>k.startsWith('/api/memory-recipe-settings')));
  assert.equal(checkbox('个人记忆').checked,true,'background refresh preserves the unsaved draft');
  await act(async()=>Array.from(d.querySelectorAll('button')).find(b=>b.textContent==='放弃修改并重新加载')!.click());
  assert.equal(checkbox('个人记忆').checked,false,'discard reloads the current server selection');assert.equal(checkbox('编码经验').checked,true);
  assert.ok(paths.every(p=>['/api/sources','/api/memory-recipes'].includes(p)||p.startsWith('/api/memory-recipe-settings')));
});
