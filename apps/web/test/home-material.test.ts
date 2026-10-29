import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {HomeMaterialRow,type RecentMaterial} from '../src/HomeMaterialRow';
import type {Api} from '../src/api';
const capture='11111111-1111-4111-8111-111111111111';
const item={id:'generated-material',ref:'material:generated-material@revision-one',revision:'revision-one',kind:'mote.file',schemaVersion:1,title:'Generated original image',textLength:20,createdAt:'2026-10-29T00:00:00Z',updatedAt:'2026-10-29T00:00:00Z',origin:{sourceId:'generated-source'}} as RecentMaterial;

async function fixture(t:TestContext){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>(),opened:string[]=[],urls:Blob[]=[],revoked:string[]=[];
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const create=URL.createObjectURL,revoke=URL.revokeObjectURL;URL.createObjectURL=blob=>{urls.push(blob);return 'blob:generated-'+urls.length;};URL.revokeObjectURL=url=>revoked.push(url);
 const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());URL.createObjectURL=create;URL.revokeObjectURL=revoke;for(const [key,value] of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 const render=async(api:Api,canPreview=true)=>{await act(async()=>root.render(React.createElement(HomeMaterialRow,{api,item,canPreview,canRead:true,onOpen:ref=>opened.push(ref)})));};
 return {d:dom.window.document,render,opened,urls,revoked};
}
function apiFor(reads:string[],options:{size?:number;retained?:boolean;raw?:Api['raw']}={}){
 return {request:async(path:string)=>{
  reads.push(path);
  if(path.includes('/read?'))return {text:'Generated exact original excerpt'};
  if(path.includes('/members?'))return {items:[{kind:'capture',ref:'capture:'+capture}]};
  if(path==='/api/files/'+capture)return {hasOriginal:options.retained??true,sizeBytes:options.size??4,item:{mimeType:'image/png'}};
  return {items:[],ids:[],cursor:0,hasMore:false,reset:false};
 },raw:options.raw??(async(path:string)=>{reads.push(path);return new Response(new Uint8Array([1,2,3,4]));})} as Api;
}

test('Home preview pins membership and text to the visible revision and opens the canonical material',async t=>{
 const f=await fixture(t),reads:string[]=[];await f.render(apiFor(reads));
 assert.ok(reads.includes('/api/materials/generated-material/members?revision=revision-one&offset=0&limit=1'));
 assert.ok(reads.includes('/api/materials/generated-material/read?revision=revision-one&offset=0&length=240'));
 assert.ok(reads.includes('/api/files/'+capture+'/content'));assert.equal(f.urls[0].type,'image/png');assert.equal(f.d.querySelector('img')?.getAttribute('src'),'blob:generated-1');assert.match(f.d.querySelector('.home-material-excerpt')!.textContent!,/Generated exact original excerpt/);
 await act(async()=>f.d.querySelector('button')!.click());assert.deepEqual(f.opened,[item.ref]);
 await f.render(apiFor([], {retained:false}));assert.equal(f.d.querySelector('img'),null);assert.deepEqual(f.revoked,['blob:generated-1']);
});

test('missing originals, large files and absent file capabilities never fetch an original for Home',async t=>{
 const f=await fixture(t);
 for(const options of [{retained:false},{size:8*1024*1024+1},{size:0}]){const reads:string[]=[];await f.render(apiFor(reads,options));assert.equal(reads.some(path=>path.endsWith('/content')),false);assert.equal(f.d.querySelector('img'),null);assert.ok(f.d.querySelector('button'));}
 const reads:string[]=[];await f.render(apiFor(reads),false);assert.equal(reads.some(path=>path.includes('/members?')||path.startsWith('/api/files/')),false);
});

test('a late original from the previous node cannot populate the new node Home thumbnail',async t=>{
 const f=await fixture(t);let resolve!: (response:Response)=>void,signal:AbortSignal|undefined;
 const old=apiFor([],{raw:async(_path,init)=>{signal=init?.signal??undefined;return new Promise(done=>resolve=done);}});
 await f.render(old);await f.render(apiFor([],{retained:false}));assert.equal(signal?.aborted,true);
 await act(async()=>resolve(new Response(new Uint8Array([1,2,3,4]))));assert.equal(f.urls.length,0);assert.equal(f.d.querySelector('img'),null);
});
