import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {LibraryMaterialRow} from '../src/LibraryBrowse';
import {HomeMaterialRow,type RecentMaterial} from '../src/HomeMaterialRow';
import {type Api,ApiError} from '../src/api';
const capture='11111111-1111-4111-8111-111111111111';
const item={id:'generated-material',ref:'material:generated-material@revision-one',revision:'revision-one',kind:'mote.file',schemaVersion:1,title:'Generated original image',textLength:20,createdAt:'2026-10-29T00:00:00Z',updatedAt:'2026-10-29T00:00:00Z',origin:{sourceId:'generated-source'}} as RecentMaterial;

async function fixture(t:TestContext){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>(),opened:string[]=[],urls:Blob[]=[],revoked:string[]=[],commits:(string|null)[]=[];
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const create=URL.createObjectURL,revoke=URL.revokeObjectURL;URL.createObjectURL=blob=>{urls.push(blob);return 'blob:generated-'+urls.length;};URL.revokeObjectURL=url=>revoked.push(url);
 const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());URL.createObjectURL=create;URL.revokeObjectURL=revoke;for(const [key,value] of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 function ObserveCommit(){React.useLayoutEffect(()=>{commits.push(dom.window.document.querySelector('img')?.getAttribute('src')??null);});return null;}
 const render=async(api:Api,canPreview=true,material=item,canRead=true)=>{await act(async()=>root.render(React.createElement(React.Fragment,null,React.createElement(HomeMaterialRow,{api,item:material,canPreview,canRead,onOpen:ref=>opened.push(ref)}),React.createElement(ObserveCommit))));};
 return {d:dom.window.document,root,render,opened,urls,revoked,commits};
}
function apiFor(reads:string[],options:{size?:number;retained?:boolean;capabilities?:string[];featuresError?:boolean;raw?:Api['raw']}={}){
 const capabilities=(options.capabilities??['http:GET:/api/files/:id/thumbnail']).map(id=>({id,version:'1',state:'active' as const,surface:'data' as const,featureId:'mote.files'}));
 return {request:async(path:string)=>{
  reads.push(path);
  if(path==='/api/features'){if(options.featuresError)throw new ApiError('generated inventory failure',503);return {schemaVersion:1,revision:1,features:[],capabilities};}
  if(path.includes('/read?'))return {material:{ref:item.ref},text:'Generated exact original excerpt',spans:[{kind:'text',format:'plain',pageRange:{start:0,end:32}}]};
  if(path.includes('/members?'))return {items:[{kind:'capture',ref:'capture:'+capture}]};
  if(path==='/api/files/'+capture)return {hasOriginal:options.retained??true,sizeBytes:options.size??4,item:{mimeType:'image/png'}};
  return {items:[],ids:[],cursor:0,hasMore:false,reset:false};
 },raw:options.raw??(async(path:string)=>{reads.push(path);return new Response(new Uint8Array([1,2,3,4]),{headers:{'Content-Type':'image/jpeg'}});})} as Api;
}

test('Home preview pins membership and text to the visible revision and opens the canonical material',async t=>{
 const f=await fixture(t),reads:string[]=[];await f.render(apiFor(reads));
 assert.ok(reads.includes('/api/materials/generated-material/members?revision=revision-one&offset=0&limit=1'));
 assert.ok(reads.includes('/api/materials/generated-material/read?revision=revision-one&offset=0&length=240'));
 assert.ok(reads.includes('/api/files/'+capture+'/thumbnail'));assert.equal(reads.some(path=>path.endsWith('/content')),false);assert.equal(f.urls[0].type,'image/jpeg');assert.equal(f.d.querySelector('img')?.getAttribute('src'),'blob:generated-1');assert.match(f.d.querySelector('.home-material-excerpt')!.textContent!,/Generated exact original excerpt/);
 await act(async()=>f.d.querySelector('button')!.click());assert.deepEqual(f.opened,[item.ref]);
 await f.render(apiFor([], {retained:false}));assert.equal(f.d.querySelector('img'),null);assert.deepEqual(f.revoked,['blob:generated-1']);
});

test('missing originals and server-rejected thumbnails never fetch an original for Home',async t=>{
 const f=await fixture(t);
 const missing:string[]=[];await f.render(apiFor(missing,{retained:false}));
 assert.equal(missing.some(path=>path.endsWith('/content')||path.endsWith('/thumbnail')),false);assert.equal(f.d.querySelector('img'),null);assert.ok(f.d.querySelector('button'));
 for(const [size,status] of [[33*1024*1024,413],[0,404]] as const){const reads:string[]=[];await f.render(apiFor(reads,{size,raw:async(path)=>{reads.push(path);throw new ApiError('generated rejection',status);}}));assert.ok(reads.some(path=>path.endsWith('/thumbnail')),'the client still asks and lets the server decide');assert.equal(reads.some(path=>path.endsWith('/content')),false);assert.equal(f.d.querySelector('img'),null);assert.ok(f.d.querySelector('button'));}
 const reads:string[]=[];await f.render(apiFor(reads),false);assert.equal(reads.some(path=>path.includes('/members?')||path.startsWith('/api/files/')),false);
});

test('a late thumbnail from the previous node cannot populate the new node Home thumbnail',async t=>{
 const f=await fixture(t);let resolve!: (response:Response)=>void,signal:AbortSignal|undefined;
 const old=apiFor([],{raw:async(_path,init)=>{signal=init?.signal??undefined;return new Promise(done=>resolve=done);}});
 await f.render(old);await f.render(apiFor([],{retained:false}));assert.equal(signal?.aborted,true);
 await act(async()=>resolve(new Response(new Uint8Array([1,2,3,4]))));assert.equal(f.urls.length,0);assert.equal(f.d.querySelector('img'),null);
});

test('the first committed render withdraws an old image when its permission, revision or node changes',async t=>{
 const f=await fixture(t),api=apiFor([]);await f.render(api);assert.ok(f.d.querySelector('img'));
 let next=f.commits.length;await f.render(api,false);assert.equal(f.commits[next],null,'permission withdrawal is synchronous, before passive cleanup');
 await f.render(api);assert.ok(f.d.querySelector('img'));
 next=f.commits.length;const changed={...item,revision:'revision-two',ref:'material:generated-material@revision-two'};await f.render(api,true,changed);assert.equal(f.commits[next],null,'an old revision is never committed as the new original');
 next=f.commits.length;await f.render(apiFor([],{retained:false}),true,changed);assert.equal(f.commits[next],null,'the old authenticated node cannot render into the new one');
});

test('authored note previews honor typed spans and keep owner JSON body literal while excluding metadata and late revisions',async t=>{
 const f=await fixture(t),body='{"captureId":"This JSON is owner-authored body"}',note={...item,kind:'mote.note',schemaVersion:2,ref:'material:generated-material@note-one',revision:'note-one',title:'Generated short note'};
 const response=(ref:string,text:string)=>({material:{ref},text:text+'{"captureId":"generated-storage-metadata"}',spans:[{kind:'text',format:'plain',pageRange:{start:0,end:text.length}},{kind:'text',format:'json',pageRange:{start:text.length,end:text.length+42}}]});
 let finish!:(value:unknown)=>void;const old={request:async()=>new Promise(resolve=>finish=resolve)} as Api;await f.render(old,false,note);
 const reads:string[]=[],current={request:async(path:string)=>{reads.push(path);return response(note.ref,body);}}as Api;await f.render(current,false,note);assert.equal(f.d.querySelector('.home-material-excerpt')!.textContent,body);assert.doesNotMatch(f.d.body.textContent!,/generated-storage-metadata/);assert.ok(reads[0].includes('revision=note-one&offset=0&length=240'));
 await act(async()=>finish(response(note.ref,'Generated old owner body')));assert.equal(f.d.querySelector('.home-material-excerpt')!.textContent,body);
 const replacement={...note,ref:'material:generated-material@note-two',revision:'note-two'};await f.render(current,false,replacement);assert.equal(f.d.querySelector('.home-material-excerpt'),null,'a mismatched response ref cannot stand in for the replacement');
});

test('Home and Library reuse exact declared file source presentation and discard late owner or changed-ref excerpts',async t=>{
 const f=await fixture(t),file={...item,coverage:{state:'complete' as const},retention:{original:'retained' as const},id:'mat_'+'a'.repeat(64),revision:'b'.repeat(64),ref:'material:mat_'+'a'.repeat(64)+'@'+'b'.repeat(64),schemaVersion:2},body='{"captureId":"This JSON is original text, not host metadata"}';
 const inventory={schemaVersion:1,revision:1,features:[],capabilities:[{id:'http:GET:/api/materials/:id/source-view',version:'1',state:'active',surface:'data',featureId:'mote.sources'}]};
 const response=(ref:string,text:string)=>({material:{...file,ref,blockCount:2},items:[{type:'source',blockId:'source-metadata',text:''},{type:'text',blockId:'body',text}],next:null});let finish!:(value:unknown)=>void,aborted=false;
 const old={request:async(path:string,init?:RequestInit)=>path==='/api/features'?inventory:path.includes('/source-view?')?new Promise(resolve=>{finish=resolve;init?.signal?.addEventListener('abort',()=>aborted=true);}):{material:{ref:file.ref},text:'host envelope',spans:[{kind:'text',format:'json',pageRange:{start:0,end:13}}]}} as Api;
 await f.render(old,false,file);assert.equal(f.d.querySelector('.home-material-excerpt'),null);const reads:string[]=[],current={request:async(path:string)=>{reads.push(path);return path==='/api/features'?inventory:path.includes('/source-view?')?response(file.ref,body):{material:{ref:file.ref},text:'host envelope',spans:[{kind:'text',format:'json',pageRange:{start:0,end:13}}]};}} as Api;await f.render(current,false,file);assert.equal(f.d.querySelector('.home-material-excerpt')!.textContent,body);assert.equal(aborted,true);await act(async()=>finish(response(file.ref,'Old owner body')));assert.equal(f.d.querySelector('.home-material-excerpt')!.textContent,body);
 await act(async()=>f.root.render(React.createElement(LibraryMaterialRow,{api:current,item:file,selected:false,onSelect:()=>{},preview:{read:true,image:false}})));assert.equal(f.d.querySelector('.library-record-preview')!.textContent,body);assert.ok(reads.some(path=>path.includes('/source-view?revision='+file.revision)));
 await f.render(current,false,{...file,ref:file.ref+'changed',revision:'c'.repeat(64)});assert.equal(f.d.querySelector('.home-material-excerpt'),null);
});

function viewport(){
 const visible=new Set<Element>(),observers=new Set<{els:Set<Element>;cb:IntersectionObserverCallback}>();
 class MockIntersectionObserver{
  els=new Set<Element>();
  constructor(private cb:IntersectionObserverCallback){observers.add(this);}
  observe(el:Element){this.els.add(el);this.cb([{isIntersecting:visible.has(el),target:el}] as IntersectionObserverEntry[],this as unknown as IntersectionObserver);}
  unobserve(el:Element){this.els.delete(el);}
  disconnect(){this.els.clear();observers.delete(this);}
 }
 const set=(el:Element,on:boolean)=>{
  if(on)visible.add(el);else visible.delete(el);
  for(const observer of [...observers])if(observer.els.has(el))observer.cb([{isIntersecting:on,target:el}] as IntersectionObserverEntry[],observer as unknown as IntersectionObserver);
 };
 return {IO:MockIntersectionObserver,set};
}
function installViewport(t:TestContext){
 const vp=viewport(),prior=Object.getOwnPropertyDescriptor(globalThis,'IntersectionObserver');
 Object.defineProperty(globalThis,'IntersectionObserver',{value:vp.IO,configurable:true,writable:true});
 t.after(()=>{if(prior)Object.defineProperty(globalThis,'IntersectionObserver',prior);else Reflect.deleteProperty(globalThis,'IntersectionObserver');});
 return vp;
}
const fileItem=(index:number)=>({id:'generated-material-'+index,ref:'material:generated-material-'+index+'@revision-'+index,revision:'revision-'+index,kind:'mote.file',schemaVersion:1,title:'Generated image '+index,textLength:0,createdAt:'2026-10-29T00:00:00Z',updatedAt:'2026-10-29T00:00:00Z',origin:{sourceId:'generated-source'}}) as RecentMaterial;
const fileCapture=(index:number)=>'10000000-1000-4000-8000-'+String(100000000000+index);

test('image rows fetch members, files and bounded thumbnails only near the viewport, and every pending or in-flight read is withdrawn off-screen',async t=>{
 const f=await fixture(t),vp=installViewport(t),items=Array.from({length:24},(_,index)=>fileItem(index)),reads:string[]=[],rawCalls:string[]=[],pending=new Map<string,()=>void>();let inFlight=0,peak=0;
 const api={request:async(path:string)=>{
  reads.push(path);
  if(path==='/api/features')return {schemaVersion:1,revision:1,features:[],capabilities:[{id:'http:GET:/api/files/:id/thumbnail',version:'1',state:'active',surface:'data',featureId:'mote.files'}]};
  const members=/\/api\/materials\/generated-material-(\d+)\/members\?/.exec(path);if(members)return {items:[{kind:'capture',ref:'capture:'+fileCapture(Number(members[1]))}]};
  if(/^\/api\/files\/[0-9a-f-]{36}$/.test(path))return {hasOriginal:true,sizeBytes:4,item:{mimeType:'image/png'}};
  return {items:[],ids:[],cursor:0,hasMore:false,reset:false};
 },raw:async(path:string,init?:RequestInit)=>{
  rawCalls.push(path);inFlight++;peak=Math.max(peak,inFlight);
  return new Promise<Response>((resolve,reject)=>{
   pending.set(path,()=>{pending.delete(path);inFlight--;resolve(new Response(new Uint8Array([1,2,3,4]),{headers:{'Content-Type':'image/jpeg'}}));});
   init?.signal?.addEventListener('abort',()=>{if(pending.delete(path)){inFlight--;reject(init.signal!.reason??new DOMException('Aborted','AbortError'));}});
  });
 }} as Api;
 await act(async()=>f.root.render(React.createElement(React.Fragment,null,items.map(material=>React.createElement(HomeMaterialRow,{key:material.ref,api,item:material,canRead:true,canPreview:true,onOpen:()=>{}})))));
 assert.equal(reads.filter(path=>path.includes('/members?')).length,0,'off-screen rows never start preview reads');
 assert.equal(rawCalls.length,0);
 const rows=Array.from(f.d.querySelectorAll('.home-material-row'));assert.equal(rows.length,24);
 await act(async()=>{for(const el of rows.slice(0,6))vp.set(el,true);});
 assert.equal(new Set(reads.filter(path=>path.includes('/members?'))).size,6);
 assert.equal(new Set(reads.filter(path=>/^\/api\/files\/[0-9a-f-]{36}$/.test(path))).size,6);
 assert.equal(rawCalls.length,4,'only the four admitted thumbnails are in flight');
 assert.equal(peak,4);
 await act(async()=>vp.set(rows[4],false));
 assert.equal(rawCalls.length,4,'a queued thumbnail is dropped when its row leaves the viewport');
 await act(async()=>vp.set(rows[4],true));
 await act(async()=>vp.set(rows[0],false));
 assert.equal(rawCalls.length,5,'an in-flight abort frees exactly one slot for the oldest queued row');
 assert.equal(pending.size,4);
 await act(async()=>{for(const release of [...pending.values()])release();});
 assert.equal(rawCalls.length,6);assert.equal(peak,4);
 await act(async()=>{for(const release of [...pending.values()])release();});
 assert.equal(f.d.querySelectorAll('img').length,5,'the scrolled-out row keeps no image');
 assert.equal(reads.filter(path=>path.endsWith('/content')).length,0);
 await act(async()=>vp.set(rows[0],true));await act(async()=>{for(const release of [...pending.values()])release();});
 assert.equal(f.d.querySelectorAll('img').length,6);
 const replaced=items.map((material,index)=>index===2?fileItem(200):material);
 await act(async()=>f.root.render(React.createElement(React.Fragment,null,replaced.map(material=>React.createElement(HomeMaterialRow,{key:material.ref,api,item:material,canRead:true,canPreview:true,onOpen:()=>{}})))));
 const nextRows=Array.from(f.d.querySelectorAll('.home-material-row'));
 await act(async()=>vp.set(nextRows[2],true));await act(async()=>{for(const release of [...pending.values()])release();});
 assert.equal(f.d.querySelectorAll('img').length,6);
 const created=f.urls.length;
 await act(async()=>f.root.unmount());
 assert.equal(f.revoked.length,created,'every created object URL is revoked once all rows unmount');
 assert.equal(inFlight,0);assert.equal(pending.size,0);
 assert.equal(reads.filter(path=>path.endsWith('/content')).length,0);
});

test('file rows without the thumbnail capability or with a failed inventory keep the type icon and never fetch an original',async t=>{
 const f=await fixture(t);
 for(const options of [{capabilities:[]},{featuresError:true}] as const){
  const reads:string[]=[],rawCalls:string[]=[];
  await f.render(apiFor(reads,{...options,raw:async(path)=>{rawCalls.push(path);return new Response(new Uint8Array([1]));}}));
  assert.equal(rawCalls.length,0);assert.equal(reads.some(path=>path.endsWith('/content')||path.endsWith('/thumbnail')),false);
  assert.equal(f.d.querySelector('img'),null);assert.ok(f.d.querySelector('.home-material-icon svg'),'the type icon stands in for the image');
 }
});

test('image-only permission still reaches the shared inventory for thumbnails without enabling text reads',async t=>{
 const f=await fixture(t),reads:string[]=[],rawCalls:string[]=[];
 await f.render(apiFor(reads,{raw:async(path)=>{rawCalls.push(path);return new Response(new Uint8Array([1]),{headers:{'Content-Type':'image/jpeg'}});}}),true,item,false);
 assert.ok(rawCalls.some(path=>path.endsWith('/thumbnail')),'thumbnail access does not depend on the material-read capability');
 assert.ok(f.d.querySelector('img'));
 assert.equal(reads.some(path=>path.includes('/read?')||path.includes('/source-view?')),false,'text reads stay gated on canRead');
});
