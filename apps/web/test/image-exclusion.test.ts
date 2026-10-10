import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {ImageProgress} from '../src/ImageProgress.js';
import {FileProcessingControls} from '../src/FileProcessingControls.js';
import type {Api} from '../src/api.js';

test('metadata exclusion explains retained originals and offers no ineffective image or file retries',async t=>{
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 dom.window.localStorage.setItem('mote.language','zh-CN');const root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 const api={request:async(path:string)=>path.startsWith('/api/files/')?{job:{state:'skipped',summary_state:'skipped'}}:path.startsWith('/api/images/')?{exclusion:'appledouble_metadata',original:{state:'ready'},automatic:false,understandingEnabled:false,wait:null,jobs:[{name:'ocr',state:'skipped',error:'appledouble_metadata'}],products:[],materials:[],memory:[]}:{ids:[],cursor:0,hasMore:false,reset:false}} as Api;
 await act(async()=>root.render(React.createElement(React.Fragment,null,React.createElement(ImageProgress,{api,id:'generated'}),React.createElement(FileProcessingControls,{api,id:'generated'}))));
 const text=dom.window.document.body.textContent!;
 assert.match(text,/AppleDouble 文件系统元数据/);assert.match(text,/原件已保留/);assert.match(text,/已跳过/);
 assert.doesNotMatch(text,/补齐未完成步骤|重新计算已有结果|重新转写|重新生成摘要/);
});
