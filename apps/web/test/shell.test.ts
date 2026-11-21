import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {EvidenceDialog} from '../src/shell-components.js';
import {type Api,type Capture} from '../src/api.js';

const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const capture:Capture={deletion:{available:true,kind:'capture'},id,source:'note',platform:'import',capturedAt:'2026-10-13T00:00:00Z',appName:'Generated note app',windowTitle:'Generated first line',deviceId:'generated-device',deviceName:'Generated device',ocrText:'Generated first line\n',durationMs:0,blobHash:null,indexingStatus:'pending',privacy:{redacted:false,mode:'standard'}};

test('the evidence reader has no conversation history or referencing-conversation entry',async t=>{
 const dom=new JSDOM('<!doctype html><main><button id="origin">Open generated original</button></main><div id="root"></div>',{url:'http://localhost/#/library?source=note',pretendToBeVisual:true}),backups=new Map<string,PropertyDescriptor|undefined>();
 for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){backups.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 dom.window.localStorage.setItem('mote.language','zh-CN');dom.window.HTMLElement.prototype.getClientRects=()=>[{}] as unknown as DOMRectList;
 const root=createRoot(dom.window.document.querySelector('#root')!),calls:string[]=[],origin=dom.window.document.querySelector<HTMLButtonElement>('#origin')!;
 const oldConversations={items:[{id:'11111111-1111-4111-8111-111111111111',title:'Generated old one',scope:{evidenceIds:[id]}},{id:'22222222-2222-4222-8222-222222222222',title:'Generated old two',scope:{}},{id:'33333333-3333-4333-8333-333333333333',title:'Generated old three',scope:{}}],nextCursor:null};
 const api={request:async(path:string,init?:RequestInit)=>{calls.push(path);if(path==='/api/capture-browser/'+capture.id)return capture;if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};if(path.startsWith('/api/conversations'))return oldConversations;if(init?.method==='DELETE')return {deleted:1};throw Error('Unexpected generated path '+path);},raw:async()=>new Response(new Blob([new Uint8Array([137,80,78,71,13,10,26,10])],{type:'image/png'})),setAgentTimeout:()=>{}} as unknown as Api;
 origin.focus();await act(async()=>root.render(React.createElement(EvidenceDialog,{api,id:'capture:'+capture.id,onOpen:()=>{},onClose:()=>root.render(null),onDeleted:()=>{}})));
 await act(async()=>{for(let turn=0;turn<8;turn++)await new Promise(resolve=>setTimeout(resolve,0));});
 t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of backups){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
 assert.equal(dom.window.document.querySelector('.evidence-conversations'),null);
 const labels=Array.from(dom.window.document.querySelectorAll('.evidence-aside .evidence-facts dt')).map(item=>item.textContent);
 assert.equal(labels.includes('引用它的对话'),false);
 assert.ok(calls.every(path=>!path.startsWith('/api/conversations')),'the reader never lists saved conversations');
});
