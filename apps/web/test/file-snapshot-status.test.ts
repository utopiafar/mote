import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {Files,FileDetail} from '../src/Files.js';
import type {Api} from '../src/api.js';

// Generated metadata only. The visible status must explain why no original was uploaded.
test('snapshot privacy blocks and expired temporary inputs remain visible in the archive',async t=>{
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),backups=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){backups.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 dom.window.localStorage.setItem('mote.language','zh-CN');const root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());for(const [key,descriptor] of backups){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',row={captureId:id,sourceId:'generated',sizeBytes:16,hasOriginal:false,originMissing:false,item:{title:'Generated snapshot',layer:'snapshot',observedAt:'2026-10-01T00:00:00Z',document:{fileIndex:{status:'blocked',coverage:'none'}}},job:null,artifacts:[]};
 const api={request:async(path:string)=>path.startsWith('/api/operations/changes')?{ids:[],cursor:0,hasMore:false,reset:false}:path==='/api/file-processing'?null:path==='/api/sources'?{items:[]}:path.startsWith('/api/files?')?{items:[row],nextCursor:null}:path==='/api/files/'+id?{...row,item:{...row.item,document:{fileIndex:{status:'pending',coverage:'none'}}},job:{state:'blocked',error:'snapshot_input_expired',summary_state:'blocked'}}:{},setAgentTimeout:()=>{}} as Api;
 await act(async()=>root.render(React.createElement(Files,{api,onOpen:()=>{}})));
 assert.match(dom.window.document.body.textContent!,/隐私规则无法应用，输入未上传/);assert.doesNotMatch(dom.window.document.body.textContent!,/已登记目录/);
 await act(async()=>root.render(React.createElement(FileDetail,{api,id,onOpen:()=>{}})));
 assert.match(dom.window.document.body.textContent!,/中央索引待处理，原件不归档/);assert.match(dom.window.document.body.textContent!,/快照的临时输入已清理，请重新同步来源文件后重试/);
});
