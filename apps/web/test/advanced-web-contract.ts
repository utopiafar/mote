import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {consumeLoginTicket} from '../src/login-handoff';
import {readStoredSession,connectionStorageKey} from '../src/session';
import {createApi} from '../src/api';
import {readEvidenceRoute} from '../src/plugins/reader/evidence-route';
import {EvidenceDialog} from '../src/shell-components';
import {pages as modelPages} from '../src/plugins/models-processing';
import {pages as libraryPages} from '../src/plugins/library';
import type {PageProps} from '../src/features/types';

export async function advancedBrowser(url:string){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url,pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>(),fetch=globalThis.fetch,urls:string[]=[],writes:string[]=[];
 for(const [key,value]of Object.entries({React,window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,location:dom.window.location,history:dom.window.history,localStorage:dom.window.localStorage,sessionStorage:dom.window.sessionStorage,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});}
 dom.window.HTMLMediaElement.prototype.pause=()=>{};dom.window.HTMLMediaElement.prototype.load=()=>{};dom.window.HTMLMediaElement.prototype.play=async()=>{};dom.window.HTMLElement.prototype.getClientRects=()=>[{}] as unknown as DOMRectList;
 const create=URL.createObjectURL,revoke=URL.revokeObjectURL;URL.createObjectURL=()=>{const next='blob:generated-'+urls.length;urls.push(next);return next;};URL.revokeObjectURL=()=>{};
 globalThis.fetch=async(input,init)=>{const target=new URL(String(input),dom.window.location.origin);assert.equal(target.origin,dom.window.location.origin,'every management call stays at the selected Central');if(init?.method&&init.method!=='GET')writes.push(target.pathname);return fetch(target,init);};
 configureLocale(()=>'zh-CN');const root=createRoot(dom.window.document.getElementById('root')!);
 return {dom,root,d:dom.window.document,writes,urls,async render(child:React.ReactNode){await act(async()=>root.render(child));},async close(){await act(async()=>root.unmount());dom.window.close();globalThis.fetch=fetch;URL.createObjectURL=create;URL.revokeObjectURL=revoke;for(const [key,value]of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}}};
}
export async function waitFor(check:()=>boolean,label:string){const deadline=Date.now()+10000;while(!check()){assert.ok(Date.now()<deadline,label);await act(async()=>new Promise(resolve=>setTimeout(resolve,5)));}}
export type AdvancedContractOutput={targets:{target:string;url:string}[];public:string;revoked:string;expired:string};

/** Real Kotlin-generated ticket URLs feed the production exchange, evidence
 * reader and settings page renderer. Only browser media playback is replaced. */
export async function consumeAdvancedTargets(output:AdvancedContractOutput){
 assert.equal(output.targets.length,6);
 for(const entry of output.targets){
  const f=await advancedBrowser(entry.url);
  try{
   await consumeLoginTicket();assert.ok(!f.dom.window.location.hash.includes('loginTicket'));assert.equal(f.dom.window.location.hash,entry.target);const connection=readStoredSession(f.dom.window.location.origin);assert.ok(connection,'the actual ticket exchange supplies the browser session');const api=createApi(connection);
   if(entry.target.startsWith('#/library')){
    assert.equal(libraryPages.find(value=>value.id==='archive')?.route,'library');const evidence=readEvidenceRoute(f.dom.window.location.hash);assert.ok(evidence);
    await f.render(React.createElement(EvidenceDialog,{api,id:evidence,onClose(){},onDeleted(){},onOpen(){}}));
    const tool=new URL(entry.url).hash.split('recordingTool=')[1]!.split('&')[0]!;
    await waitFor(()=>Boolean(f.d.querySelector('.recording-dialog')),tool+' reaches actual recording tools');
    if(tool==='speakers'){
     await waitFor(()=>f.d.querySelectorAll('[data-recording-name]').length===2,'actual speaker naming fields');assert.ok(f.d.querySelector('.recording-dialog')?.textContent?.includes('说话人'));
     const sample=[...f.d.querySelectorAll<HTMLButtonElement>('.recording-dialog button')].find(value=>value.textContent?.includes('试听片段'));assert.ok(sample);await act(async()=>sample.click());await waitFor(()=>Boolean(f.d.querySelector('.recording-dialog audio')),'the selected speaker sample is actually consumed');assert.equal(f.urls.length,1);
    }else{await waitFor(()=>Boolean(f.d.querySelector('.recording-raw-line')),tool+' consumes the actual exported original');assert.match(f.d.querySelector('.recording-dialog')!.textContent!,/Generated raw recording/);if(tool==='compare')assert.match(f.d.querySelector('.recording-comparison')!.textContent!,/Generated current recording/);}
    assert.deepEqual(f.writes.filter(path=>path!=='/api/login/exchange'),[],'navigation and sample playback never submit a model or edit');
   }else{
    const page=modelPages.find(value=>value.route==='system/models');assert.ok(page);await f.render(page.render!({api,onPage(){},refresh(){}} as unknown as PageProps));
    const role=new URLSearchParams(f.dom.window.location.hash.split('?')[1]).get('prepare')!;await waitFor(()=>Boolean(f.d.querySelector('[data-advanced-preparation="'+role+'"] .media-preparation')),'the actual settings page mounts the selected preparation role');assert.equal(f.d.activeElement?.getAttribute('data-advanced-preparation'),role);assert.deepEqual(f.writes,['/api/login/exchange'],'opening preparation does not change plans, models or enablement');
   }
  }finally{await f.close();}
 }
 // Replay, revocation and expiration all go through the real Central exchange.
 for(const url of [output.targets[0]!.url,output.revoked,output.expired]){
  const f=await advancedBrowser(url);try{f.dom.window.localStorage.setItem(connectionStorageKey,JSON.stringify({token:'generated-unrelated-old-login'}));await assert.rejects(consumeLoginTicket());assert.equal(readStoredSession(f.dom.window.location.origin),null);assert.ok(!f.dom.window.location.hash.includes('loginTicket'));assert.equal(f.d.querySelector('.recording-dialog'),null);}finally{await f.close();}
 }
 const f=await advancedBrowser(output.public);try{await consumeLoginTicket();assert.equal(readStoredSession(f.dom.window.location.origin),null);assert.equal(f.dom.window.location.hash,new URL(output.public).hash);assert.deepEqual(f.writes,[],'a collector link leaves the normal login in charge');}finally{await f.close();}
}
