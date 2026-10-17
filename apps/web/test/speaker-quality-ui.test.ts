import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {FileDetail} from '../src/Files.js';
import type {Api} from '../src/api.js';

test('generated transcript groups retain child correction/seek controls and scope range submission to one raw artifact',async t=>{
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),backups=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){backups.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 dom.window.localStorage.setItem('mote.language','zh-CN');dom.window.HTMLMediaElement.prototype.pause=()=>{};dom.window.HTMLMediaElement.prototype.load=()=>{};
 const {createRoot}=await import('react-dom/client');
 const root=createRoot(dom.window.document.getElementById('root')!),d=dom.window.document,id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',raw='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',dialogue='cccccccc-cccc-4ccc-8ccc-cccccccccccc',writes:{path:string;body:any}[]=[];
 const chunks=[0,1,2].map(i=>({id:'generated-child-'+i,ocrText:'[SPEAKER_0] Generated '+i,fileEvidence:{artifactId:dialogue,chunkId:'generated-child-'+i,speaker:'SPEAKER_0',startMs:i*500,endMs:(i+1)*500,uncertain:i===1}}));
 const file={captureId:id,sourceId:'generated',sizeBytes:16,hasOriginal:true,originMissing:false,item:{title:'Generated recording',layer:'original',mimeType:'audio/wav',observedAt:'2026-10-01T00:00:00Z'},job:{state:'succeeded',summary_state:'skipped'},cancellation:{canCancel:false,wait:null},processingPolicy:{capabilities:{dialogue:true,summary:false},current:{profile:{name:'Generated profile',processorId:'audio.local-dialogue',parameters:{},summarize:false},rule:{type:'audio/*'}}},artifacts:[{id:raw,kind:'transcript'},{id:dialogue,kind:'dialogue'}]};
 const api={raw:async(path:string)=>{assert.equal(path,'/generated.wav');return new Response('Generated audio bytes',{headers:{'content-type':'audio/wav'}});},request:async(path:string,init?:RequestInit)=>{
  if(init?.method==='POST'){writes.push({path,body:JSON.parse(String(init.body))});return path.endsWith('/playback')?{url:'/generated.wav'}:{queued:true};}
  if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};
  if(path==='/api/files/'+id)return file;
  if(path.includes('/chunks'))return path.endsWith('offset=0')?{items:chunks.slice(0,2),nextOffset:2}:{items:chunks.slice(2),nextOffset:null};
  return {items:[]};
 },setAgentTimeout:()=>{}} as Api;
 t.after(async()=>{await act(async()=>root.unmount());for(const [key,descriptor] of backups){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 const button=(label:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent?.trim()===label)!;
 await act(async()=>root.render(React.createElement(FileDetail,{api,id,onOpen:()=>{}})));
 await act(async()=>button('展开转写 / 原文片段').click());assert.match(d.body.textContent!,/含不确定片段/);assert.match(d.body.textContent!,/展开 2 个原始片段/);
 await act(async()=>button('继续展开').click());assert.match(d.body.textContent!,/展开 3 个原始片段/);assert.equal(d.querySelector('.file-text')!.textContent,'Generated 0Generated 1Generated 2');assert.equal(d.querySelectorAll('.file-text').length,4,'one presentation and all three canonical children');
 await act(async()=>button('加载原件 / 回听').click());const seeks=d.querySelectorAll<HTMLButtonElement>('button.text-button');await act(async()=>seeks[1].click());assert.equal(d.querySelector('audio')!.currentTime,.5);
 const corrections=Array.from(d.querySelectorAll<HTMLButtonElement>('button')).filter(b=>b.textContent==='纠正此段');await act(async()=>corrections[1].click());await act(async()=>button('保存校正').click());assert.equal(writes.find(w=>w.path.endsWith('/corrections'))!.body.chunkId,'generated-child-1');assert.equal(writes.find(w=>w.path.endsWith('/corrections'))!.body.artifactId,dialogue);assert.equal(writes.find(w=>w.path.endsWith('/corrections'))!.body.originalText,'Generated 1');
 const selects=d.querySelectorAll<HTMLSelectElement>('select');await act(async()=>{selects[1].value='range';selects[1].dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 const inputs=d.querySelectorAll<HTMLInputElement>('input[type=number]');await act(async()=>{for(const [input,value] of [[inputs[0],'1'],[inputs[1],'3']] as const){Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));}});
 await act(async()=>button('应用并重新分人').closest('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));
 assert.deepEqual(writes.find(w=>w.path.endsWith('/retry'))!.body,{stage:'diarize',diarization:{artifactId:raw,options:{processor:'audio.diarize-wespeaker',speakerCount:null,range:{min:1,max:3}}}});
 assert.ok(writes.every(w=>w.path.startsWith('/api/files/'+id+'/')));
});
