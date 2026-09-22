import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {changeEvidenceRoute,evidenceRoute,readEvidenceRoute} from '../src/evidence-route.js';
import {containDialogFocus} from '../src/dialog-focus.js';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
test('detail history preserves the exact origin filters, replaces nested evidence and closes with one back',async()=>{
 const dom=new JSDOM('<!doctype html>',{url:'http://localhost/#/library?source=generated&after=2020-01-01'}),w=dom.window;
 const before=w.history.length,origin=w.location.hash;
 changeEvidenceRoute(w as unknown as Window,id.toUpperCase());assert.equal(w.history.length,before+1);assert.equal(readEvidenceRoute(w.location.hash),'capture:'+id);assert.match(w.location.hash,/source=generated/);
 changeEvidenceRoute(w as unknown as Window,'memory:'+id);assert.equal(w.history.length,before+1);assert.equal(readEvidenceRoute(w.location.hash),'memory:'+id);
 const closed=new Promise(resolve=>w.addEventListener('popstate',resolve,{once:true}));changeEvidenceRoute(w as unknown as Window,null);await closed;assert.equal(w.location.hash,origin);
 const reopened=new Promise(resolve=>w.addEventListener('popstate',resolve,{once:true}));w.history.forward();await reopened;assert.equal(readEvidenceRoute(w.location.hash),'memory:'+id);w.close();
});
test('a direct evidence link closes in place and oversized refs cannot enter the reader',()=>{
 const dom=new JSDOM('<!doctype html>',{url:'http://localhost/#/library/memories?filter=published&evidence=memory%3A'+id});const before=dom.window.history.length;
 changeEvidenceRoute(dom.window as unknown as Window,null);assert.equal(dom.window.history.length,before);assert.equal(dom.window.location.hash,'#/library/memories?filter=published');
 assert.equal(readEvidenceRoute('#/library?evidence='+'x'.repeat(4097)),null);assert.equal(evidenceRoute('#/memories?x=1',null),'#/memories?x=1');dom.window.close();
});
test('detail focus contains outside keyboard focus, skips hidden controls and restores the opener',()=>{
 const dom=new JSDOM('<button id="origin">open</button><section id="dialog"><button id="first">close</button><div hidden><button id="hidden">hidden</button></div><button id="last">read</button></section>');
 const d=dom.window.document;for(const element of Array.from(d.querySelectorAll<HTMLElement>('button')))element.getClientRects=()=>[{}] as unknown as DOMRectList;
 const origin=d.querySelector<HTMLElement>('#origin')!,panel=d.querySelector<HTMLElement>('#dialog')!;origin.focus();const close=containDialogFocus(panel,origin);assert.equal(d.activeElement?.id,'first');
 origin.focus();d.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,cancelable:true}));assert.equal(d.activeElement?.id,'last');
 d.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Tab',cancelable:true}));assert.equal(d.activeElement?.id,'first');close();assert.equal(d.activeElement,origin);dom.window.close();
});
