import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act,useState} from 'react';
import {JSDOM} from 'jsdom';
import {setTimeout as delay} from 'node:timers/promises';
import {configureLocale} from '@mote/shared/i18n';
import {scopedFilesFixture} from '../../server/test/fixtures/scoped-files.js';
import {createApi,type Api} from '../src/api.js';
import {Files} from '../src/Files.js';
import {LibraryBrowseLayout} from '../src/LibraryBrowse.js';
configureLocale(()=> 'zh-CN');

test('the original Files card opens its owned original controls through the actual Library capture reader',async t=>{
 const f=await scopedFilesFixture(t),capture=await f.upload(f.a.token,'Generated entry original','GENERATED_ORIGINAL_ENTRY_A');
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/library?view=files',pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>();let cookie='',current:Api|undefined;
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,IS_REACT_ACT_ENVIRONMENT:true,fetch:async(path:string,init:RequestInit={})=>{const headers=new Headers(init.headers);headers.set('cookie',cookie);const r=await f.host.app.inject({url:path,method:init.method as any??'GET',headers:Object.fromEntries(headers),...(init.body?{payload:String(init.body)}:{})});return new Response(r.rawPayload,{status:r.statusCode,headers:r.headers as Record<string,string>});}})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!),d=dom.window.document;
 t.after(async()=>{current?.close?.();await act(async()=>root.unmount());for(const [key,value]of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 const response=await f.request(undefined,'/api/auth/login','POST',{username:'generated-a',password:'Generated-joint-files-password',mode:'web'});assert.equal(response.statusCode,200,response.body);cookie=String(response.headers['set-cookie']).split(';')[0];const api=createApi({mode:'web',origin:'http://localhost',...response.json()},undefined,()=>current===api);current=api;
 function Archive(){const [selected,setSelected]=useState<string>();return React.createElement(LibraryBrowseLayout,{api,reference:selected,onClose:()=>setSelected(undefined),onOpen:setSelected,children:React.createElement(Files,{api,onOpen:setSelected})});}
 await act(async()=>{root.render(React.createElement(React.StrictMode,null,React.createElement(Archive)));await delay(20);});
 for(let n=0;n<200&&!d.querySelector('.file-card');n++)await act(async()=>delay(10));const card=d.querySelector<HTMLButtonElement>('.file-card');assert.ok(card,d.body.textContent!);await act(async()=>{card.click();await delay(20);});for(let n=0;n<200&&!d.querySelector('.library-capture-detail');n++)await act(async()=>delay(10));assert.ok(d.querySelector('.library-capture-detail'),d.body.textContent!);
 assert.ok(Array.from(d.querySelectorAll('button')).some(value=>value.textContent==='加载原件 / 回听'),'the actual original Files→capture reader must retain FileDetail original controls: '+d.body.textContent);
 assert.ok(d.querySelector('.library-capture-detail')!.textContent!.includes('Generated entry original'));assert.equal((await f.request(f.b.token,'/api/capture-browser/'+capture.id)).statusCode,404);
 const other=await f.upload(f.b.token,'Generated entry original','GENERATED_ORIGINAL_ENTRY_B');assert.equal(other.id,capture.id);assert.deepEqual((await f.checked(f.b.token,'/api/capture-browser/'+other.id)).fileArchive,{captureId:other.id});
 const reference=(await f.checked(f.a.token,'/api/ingress/sources/same-source/items','POST',{batchId:'generated-reference',items:[{externalId:'only-reference',revision:'same-r1',observedAt:'2026-10-16T00:00:00Z',title:'Generated reference',text:'',kind:'file',layer:'reference',mimeType:'text/plain',uri:'nas://generated/original.txt'}]})).captures[0];assert.equal((await f.checked(f.a.token,'/api/capture-browser/'+reference.id)).fileArchive,undefined,'file-kind metadata alone cannot assert an original reader');
 await f.checked(f.a.token,'/api/sources/same-source','PATCH',{enabled:false});assert.equal((await f.checked(f.a.token,'/api/capture-browser/'+capture.id)).fileArchive,undefined,'paused source cannot advertise a currently unavailable original reader');assert.deepEqual((await f.checked(f.b.token,'/api/capture-browser/'+other.id)).fileArchive,{captureId:other.id});
});
