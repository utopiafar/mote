import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {AttributionEditor,AttributionSummary} from '../src/AttributionContext.js';
import {MaterialDetail,type Material} from '../src/Materials.js';
import {MemoryRecipeSelection} from '../src/MemoryRecipeSelection.js';
import type {Api} from '../src/api.js';
configureLocale(()=> 'zh-CN');
async function fixture(t:any){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),backups=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){backups.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of backups){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 return {root,d:dom.window.document,w:dom.window};
}
const button=(d:Document,text:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent===text)!;
const change=async(d:Document,w:JSDOM['window'],value:string)=>act(async()=>{const select=d.querySelector('select')!;select.value=value;select.dispatchEvent(new w.Event('change',{bubbles:true}));});
test('optional declaration distinguishes declared provenance and unknown; reset restores source inheritance',async t=>{
 const {root,d,w}=await fixture(t),writes:any[]=[],saved:any[]=[];
 const api={request:async(path:string,init:RequestInit)=>{writes.push({path,body:JSON.parse(String(init.body))});return {ref:'generated-current'};}} as Api;
 await act(async()=>root.render(React.createElement(AttributionEditor,{api,path:'/api/materials/generated/context',revision:'a'.repeat(64),value:'mixed',onSaved:r=>saved.push(r)})));
 await change(d,w,'unknown');await act(async()=>button(d,'保存归属声明').click());
 assert.deepEqual(writes[0].body,{ownerRelation:'unknown',expectedRevision:'a'.repeat(64)});assert.equal(saved.length,1);
 await change(d,w,'');await act(async()=>button(d,'保存归属声明').click());assert.equal(writes[1].body.ownerRelation,null);
 await act(async()=>root.render(React.createElement(AttributionSummary,{context:{version:1,ownerRelation:'third_party',basis:'owner_source',sourceDeclaration:{sourceId:'generated',version:2,ownerRelation:'third_party'}}})));
 assert.match(d.body.textContent!,/你对来源的声明/);assert.match(d.body.textContent!,/第三方内容/);assert.match(d.body.textContent!,/版本 2/);
 await act(async()=>root.render(React.createElement(AttributionSummary,{context:{version:1,ownerRelation:'unknown',basis:'default',sourceDeclaration:{sourceId:'generated',version:3,ownerRelation:null}}})));assert.match(d.body.textContent!,/不声明/);assert.match(d.body.textContent!,/版本 3/);
});
test('late declaration save cannot open old material after node or selected record changes',async t=>{
 const {root,d,w}=await fixture(t);let resolve!:(value:any)=>void,signal:AbortSignal|undefined;const saved:any[]=[];
 const api={request:async(_path:string,init:RequestInit)=>{signal=init.signal as AbortSignal;return new Promise(done=>{resolve=done;});}} as Api;
 await act(async()=>root.render(React.createElement(AttributionEditor,{api,path:'/api/materials/old/context',revision:'a'.repeat(64),onSaved:r=>saved.push(r)})));
 await change(d,w,'owner');await act(async()=>button(d,'保存归属声明').click());
 const other={request:async()=>({})} as Api;
 await act(async()=>root.render(React.createElement(AttributionEditor,{api:other,path:'/api/materials/new/context',revision:'b'.repeat(64),onSaved:r=>saved.push(r)})));
 assert.equal(signal?.aborted,true);await act(async()=>resolve({ref:'old'}));assert.deepEqual(saved,[]);assert.equal(d.querySelector('select')?.value,'');
});
test('library material attribution stays in existing origin tab and historical or agent views have no editor',async t=>{
 const {root,d}=await fixture(t),id='mat_'+'a'.repeat(64),revision='b'.repeat(64),material:Material={id,ref:`material:${id}@${revision}`,revision,kind:'generated',schemaVersion:1,title:'Generated interview',sequence:1,textLength:5,blockCount:1,coverage:{state:'complete'},origin:{sourceId:'generated'},retention:{original:'retained'},attributionContext:{version:1,ownerRelation:'unknown',basis:'default'}};
 let historical=false;
 const api={request:async(path:string)=>path==='/api/library/descriptor'?{types:[]}:path.includes('/members?')?{items:[],nextOffset:null}:path.includes('/read?')?{material,text:'hello',textRange:{offset:0,total:5,nextOffset:null}}:path.startsWith('/api/agent-view/')?{material,text:'hello',textRange:{offset:0,total:5,nextOffset:null}}:{...material,...(historical?{revision:'c'.repeat(64),ref:`material:${id}@${'c'.repeat(64)}`}:{})}} as Api;
 await act(async()=>root.render(React.createElement(MaterialDetail,{api,material,onOpen:()=>{}})));assert.equal(d.querySelector('select'),null);
 await act(async()=>button(d,'来源与处理').click());assert.match(d.body.textContent!,/归属未知/);assert.ok(d.querySelector('select'));
 historical=true;await act(async()=>root.render(React.createElement(MaterialDetail,{key:'history',api:{...api} as Api,material,onOpen:()=>{}})));await act(async()=>button(d,'来源与处理').click());assert.equal(d.querySelector('select'),null);assert.match(d.body.textContent!,/查看当前版本/);
 await act(async()=>root.render(React.createElement(MaterialDetail,{key:'agent',api,material,onOpen:()=>{},agent:true})));await act(async()=>button(d,'来源与处理').click());assert.equal(d.querySelector('select'),null);
});
test('strategy selection never offers an empty automatic combination',async t=>{
 const {root,d}=await fixture(t),personal={id:'mote.personal-memory',version:'2'};
 const api={request:async(path:string)=>path==='/api/sources'?{items:[]}:path==='/api/memory-recipes'?{items:[{...personal,available:true}]}:{sourceId:null,inherited:false,items:[{binding:{recipe:personal},available:true}]}} as Api;
 await act(async()=>root.render(React.createElement(MemoryRecipeSelection,{api})));
 const last=d.querySelector<HTMLInputElement>('input[type=checkbox]')!;assert.equal(last.checked,true);assert.equal(last.disabled,true);await act(async()=>last.click());assert.equal(last.checked,true);
});
test('stale revision and revoked permission errors stay visible without claiming a saved declaration',async t=>{
 const {root,d,w}=await fixture(t),saved:any[]=[];
 const {ApiError}=await import('../src/api.js');let status=409;
 const api={request:async()=>{throw new ApiError(status===409?'Generated stale revision':'Generated revoked access',status);}} as Api;
 await act(async()=>root.render(React.createElement(AttributionEditor,{api,path:'/api/materials/generated/context',revision:'a'.repeat(64),onSaved:r=>saved.push(r)})));
 await change(d,w,'mixed');await act(async()=>button(d,'保存归属声明').click());assert.match(d.querySelector('[role=alert]')!.textContent!,/Generated stale revision/);assert.equal(saved.length,0);
 status=403;await act(async()=>button(d,'保存归属声明').click());assert.match(d.querySelector('[role=alert]')!.textContent!,/Generated revoked access/);assert.equal(saved.length,0);
});
