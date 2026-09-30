import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {containDialogFocus} from '../src/dialog-focus.js';
import {LoginDialog} from '../src/shell-components.js';
function fixture(){
 const dom=new JSDOM('<!doctype html><main><button id="opener">Open generated modal</button></main><aside inert>Already unavailable</aside><div id="mount"><div id="backdrop"><section role="dialog" aria-modal="true"><button id="first">Close</button><input id="token" type="password"><button id="last">Continue</button></section></div></div>',{url:'http://localhost/',pretendToBeVisual:true});
 for(const el of dom.window.document.querySelectorAll<HTMLElement>('button,input'))el.getClientRects=()=>[{}] as unknown as DOMRectList;
 return dom;
}
test('modal makes only background branches inert and restores their prior state before returning focus',()=>{
 const dom=fixture(),d=dom.window.document,opener=d.querySelector<HTMLElement>('#opener')!,panel=d.querySelector<HTMLElement>('[role=dialog]')!;
 try{
  opener.focus();const close=containDialogFocus(panel,opener);
  assert.equal(d.querySelector('main')!.hasAttribute('inert'),true);assert.equal(d.querySelector('aside')!.hasAttribute('inert'),true);assert.equal(panel.closest('[inert]'),null);assert.equal(d.activeElement?.id,'first');
  close();assert.equal(d.querySelector('main')!.hasAttribute('inert'),false);assert.equal(d.querySelector('aside')!.hasAttribute('inert'),true);assert.equal(d.activeElement,opener);
 }finally{dom.window.close();}
});
test('modal preserves an already focused input and contains both keyboard directions',()=>{
 const dom=fixture(),d=dom.window.document,panel=d.querySelector<HTMLElement>('[role=dialog]')!,input=d.querySelector<HTMLElement>('#token')!;
 try{
  input.focus();const close=containDialogFocus(panel,d.querySelector<HTMLElement>('#opener'));
  assert.equal(d.activeElement,input,'an autofocus credential field stays selected');
  d.querySelector<HTMLElement>('#first')!.focus();d.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,cancelable:true}));assert.equal(d.activeElement?.id,'last');
  d.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Tab',cancelable:true}));assert.equal(d.activeElement?.id,'first');close();
 }finally{dom.window.close();}
});
test('real login contains focus and restores its opener without sending credentials',async t=>{
 const dom=new JSDOM('<!doctype html><main><button id="opener">Open login</button></main><div id="mount"></div>',{url:'http://localhost/',pretendToBeVisual:true}),globals=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,sessionStorage:dom.window.sessionStorage,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){globals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 dom.window.HTMLElement.prototype.getClientRects=()=>[{}] as unknown as DOMRectList;
 const {createRoot}=await import('react-dom/client');
 const d=dom.window.document,opener=d.querySelector<HTMLElement>('#opener')!,root=createRoot(d.querySelector('#mount')!);opener.focus();
 t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,previous]of globals){if(previous)Object.defineProperty(globalThis,key,previous);else Reflect.deleteProperty(globalThis,key);}});
 await act(async()=>root.render(React.createElement(LoginDialog,{destination:'Generated destination',onConnected:()=>assert.fail('no login request expected'),onClose:()=>{}})));
 assert.equal(d.querySelector('main')!.hasAttribute('inert'),true);assert.equal(d.querySelector('[role=dialog]')!.contains(d.activeElement),true);
 await act(async()=>root.render(null));assert.equal(d.querySelector('main')!.hasAttribute('inert'),false);assert.equal(d.activeElement,opener);
});
