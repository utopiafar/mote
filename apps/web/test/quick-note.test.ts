import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import React,{act,useCallback,useState} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale,getLocale} from '@mote/shared/i18n';
import {Notes} from '../src/Notes';
import {QuickNoteDialog} from '../src/QuickNoteDialog';
import {QuickNoteContext} from '../src/quick-note-context';
import {NoteOutbox} from '../src/notes-state';
import {ApiError,type Api} from '../src/api';

async function fixture(t:TestContext,request:Api['request']){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/library/notes',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>(),locale=getLocale();configureLocale(()=>'zh-CN');
 Object.assign(dom.window.HTMLElement.prototype,{attachEvent:()=>{},detachEvent:()=>{}});
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});}
 const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!);
 const api={request} as Api,outbox=new NoteOutbox(dom.window.localStorage,'generated-node');let saved=0;
 function Harness(){
  const [open,setOpen]=useState(false),[revision,setRevision]=useState(0),close=useCallback(()=>setOpen(false),[]),show=useCallback(()=>setOpen(true),[]),onSaved=useCallback(()=>{saved++;setRevision(value=>value+1);},[]);
  return React.createElement(QuickNoteContext.Provider,{value:show},React.createElement('button',{id:'opener',onClick:show},'Open'),React.createElement(Notes,{api,namespace:'generated-node',revision,onSaved,onOpen:()=>{}}),open&&React.createElement(QuickNoteDialog,{api,namespace:'generated-node',revision,onSaved,onClose:close}));
 }
 t.after(async()=>{await act(async()=>root.unmount());configureLocale(()=>locale);for(const [key,value] of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 await act(async()=>root.render(React.createElement(Harness)));
 const open=async()=>{await act(async()=>{dom.window.document.querySelector<HTMLButtonElement>('#opener')!.focus();dom.window.document.querySelector<HTMLButtonElement>('#opener')!.click();});};
 const close=async()=>{await act(async()=>dom.window.document.querySelector<HTMLButtonElement>('[aria-label="收起随手记"]')!.click());};
 const submit=async()=>{await act(async()=>dom.window.document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));};
 return {d:dom.window.document,w:dom.window,outbox,open,close,submit,get saved(){return saved;}};
}

test('folding an offline global note exposes the same-window pending record in history without a second sync owner',async t=>{
 let posts=0;
 const f=await fixture(t,(async(path:string,init?:RequestInit)=>{if(init?.method==='POST'){posts++;throw new ApiError('Generated offline request',503);}assert.match(path,/^\/api\/notes\?limit=30/);return {items:[],nextCursor:null};}) as Api['request']);
 f.outbox.saveDraft({text:'Generated offline note',description:'Independent generated description',mood:''});
 await f.open();assert.equal(f.d.querySelectorAll('#note-text').length,1);assert.equal(f.d.activeElement?.id,'note-text');
 await f.submit();assert.equal(posts,1);assert.equal(f.outbox.items().length,1);assert.ok(f.d.querySelector('.quick-note-dialog'));
 await f.close();assert.equal(f.d.querySelector('.quick-note-dialog'),null);assert.match(f.d.querySelector('.note-pending')!.textContent!,/Generated offline note/);assert.equal(posts,1,'history observes outbox changes without retrying the composer submission');assert.equal(f.d.activeElement?.id,'opener');assert.equal(f.w.location.hash,'#/library/notes');
});

test('an exact acknowledgement arriving after folding still refreshes history and removes the pending copy',async t=>{
 let acknowledge!:(value:unknown)=>void,note:any,received=false;
 const f=await fixture(t,(async(path:string,init?:RequestInit)=>{
  if(init?.method==='POST'){note=JSON.parse(String(init.body));return new Promise(resolve=>acknowledge=resolve);}
  assert.match(path,/^\/api\/notes\?limit=30/);return {items:received?[{id:note.id,capturedAt:note.capturedAt,ocrText:note.text}]:[],nextCursor:null};
 }) as Api['request']);
 f.outbox.saveDraft({text:'Generated late receipt',mood:''});await f.open();await f.submit();await f.close();
 assert.match(f.d.querySelector('.note-pending')!.textContent!,/Generated late receipt/);
 received=true;await act(async()=>acknowledge({id:note.id}));assert.equal(f.saved,1);assert.equal(f.outbox.items().length,0);assert.equal(f.d.querySelector('.note-pending'),null);assert.match(f.d.querySelector('.notes-history')!.textContent!,/Generated late receipt/);
});

test('drafts and independent descriptions survive closing and Escape keeps the underlying route',async t=>{
 const f=await fixture(t,(async()=>({items:[],nextCursor:null})) as Api['request']);
 f.outbox.saveDraft({text:'Generated draft',description:'Generated description',mood:''});await f.open();
 assert.equal(f.d.querySelector<HTMLTextAreaElement>('#note-description')!.value,'Generated description');
 await act(async()=>f.d.querySelector('#note-text')!.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
 assert.equal(f.d.querySelector('.quick-note-dialog'),null);assert.equal(f.w.location.hash,'#/library/notes');await f.open();assert.equal(f.d.querySelector<HTMLTextAreaElement>('#note-text')!.value,'Generated draft');assert.equal(f.d.querySelector<HTMLTextAreaElement>('#note-description')!.value,'Generated description');
});
