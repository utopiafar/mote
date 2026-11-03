import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {ApiError,type Api} from '../src/api.js';
import {SourceContextEditor,SourceContextFields,useSourceContextDraft,type SourceContextDraft} from '../src/plugins/sources/SourceContextEditor.js';
import {Sources} from '../src/plugins/sources/Sources.js';
configureLocale(()=> 'zh-CN');
async function fixture(t:any){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),backups=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){backups.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of backups){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 return {root,d:dom.window.document,w:dom.window};
}
const button=(d:Document,label:string)=>{const found=Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(item=>item.textContent===label);assert.ok(found,label);return found;};
const edit=async(d:Document,w:JSDOM['window'],value:string)=>act(async()=>{const input=d.querySelector('textarea')!;Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new w.Event('input',{bubbles:true}));});
function Harness({api,sourceId,expose}:{api:Api;sourceId?:string;expose:(draft:SourceContextDraft)=>void}){const draft=useSourceContextDraft(api,sourceId);expose(draft);return React.createElement(SourceContextFields,{draft});}
const snapshot=(sourceId:string,version=0,description='')=>({sourceId,version,description});

test('source management saves optional exact prose independently, keeps it across list refresh, and versions clearing',async t=>{
 const {root,d,w}=await fixture(t),sourceId='generated-source',calls:{path:string;init?:RequestInit}[]=[];
 let value=snapshot(sourceId),getCount=0;
 const api={request:async(path:string,init?:RequestInit)=>{
  calls.push({path,init});
  if(path==='/api/sources')return {items:[{id:sourceId,name:'Generated source',kind:'custom',deviceId:sourceId,platform:'import',enabled:true,retention:'archive'}]};
  if(path==='/api/connectors/status')return {};
  if(path==='/api/sources/'+sourceId+'/context'){
   if(init?.method==='PATCH'){const body=JSON.parse(String(init.body));assert.equal(body.expectedVersion,value.version);value=snapshot(sourceId,value.version+1,body.description);}
   else getCount++;
   return structuredClone(value);
  }
  throw Error('Unexpected generated request: '+path);
 }} as unknown as Api;
 await act(async()=>root.render(React.createElement(Sources,{api,onOpen:()=>{},onImport:()=>{}})));
 assert.equal(d.querySelector('textarea'),null,'management opens an exact selected source before editing its context');
 await act(async()=>d.querySelector<HTMLButtonElement>('.source-select')!.click());
 assert.equal(d.querySelector('textarea')?.maxLength,12000);assert.ok(button(d,'保存说明').classList.contains('primary'));assert.equal(button(d,'保存说明').disabled,true);
 const description='  Generated diary\n作者：Generated owner；引用和导航不属于我。\n  ';
 await edit(d,w,description);assert.equal(button(d,'保存说明').disabled,false);
 await act(async()=>button(d,'刷新').click());assert.equal(d.querySelector('textarea')?.value,description);assert.equal(getCount,1,'source-list refresh neither discards nor reloads prose draft');
 await act(async()=>button(d,'保存说明').click());
 assert.equal(value.description,description);assert.match(d.body.textContent!,/资料说明已获中央确认，版本 1/);
 assert.deepEqual(calls.filter(call=>call.init?.method).map(call=>({path:call.path,body:JSON.parse(String(call.init!.body))})),[{path:'/api/sources/generated-source/context',body:{expectedVersion:0,description}}]);
 await edit(d,w,'');await act(async()=>button(d,'保存说明').click());
 assert.equal(value.description,'');assert.equal(value.version,2);assert.match(d.body.textContent!,/资料说明已获中央确认，版本 2/);assert.equal(button(d,'保存说明').disabled,true);
});

test('source reading has no source-wide configuration editor and retains an exact management destination',async t=>{
 const {root,d}=await fixture(t),reads:string[]=[];
 const api={request:async(path:string)=>{reads.push(path);if(path==='/api/sources')return {items:[{id:'generated-read',name:'Generated read source',kind:'custom',enabled:true}]};if(path.startsWith('/api/source-items?'))return {items:[],nextCursor:null};if(path==='/api/connectors/status')return {};throw Error('Unexpected reader request: '+path);}} as unknown as Api;
 await act(async()=>root.render(React.createElement(Sources,{api,onOpen:()=>{},onImport:()=>{},mode:'library'})));
 await act(async()=>d.querySelector<HTMLButtonElement>('.source-select')!.click());
 assert.equal(d.querySelector('textarea'),null);assert.ok(!Array.from(d.querySelectorAll('button')).some(item=>item.textContent==='保存说明'));assert.equal(d.querySelector<HTMLAnchorElement>('.source-grid aside a')?.getAttribute('href'),'#/connections?sourceId=generated-read');
 assert.ok(!reads.some(path=>path.endsWith('/context')),'reading does not fetch source configuration');
});

test('refresh preserves edited prose and CAS version; conflicts retain the draft until explicit reload',async t=>{
 const {root,d,w}=await fixture(t),sourceId='generated-conflict',writes:any[]=[];let value=snapshot(sourceId,1,'Generated original'),reads=0,draft!:SourceContextDraft;
 const api={request:async(_path:string,init?:RequestInit)=>{
  if(init?.method==='PATCH'){const body=JSON.parse(String(init.body));writes.push(body);if(body.expectedVersion!==value.version)throw new ApiError('Generated version changed',409);value=snapshot(sourceId,value.version+1,body.description);}else reads++;
  return structuredClone(value);
 }} as unknown as Api;
 await act(async()=>root.render(React.createElement(Harness,{api,sourceId,expose:next=>{draft=next;}})));
 await edit(d,w,'Generated local draft');value=snapshot(sourceId,2,'Generated other page');
 await act(async()=>{await draft.refresh();});assert.equal(d.querySelector('textarea')?.value,'Generated local draft');assert.equal(draft.version,1);
 await act(async()=>{await assert.rejects(draft.save(),/Generated version changed/);});
 assert.deepEqual(writes,[{expectedVersion:1,description:'Generated local draft'}]);assert.equal(reads,2,'CAS failure does not silently obtain a new expected version');assert.equal(draft.dirty,true);assert.equal(draft.saved,false);assert.match(d.querySelector('[role=alert]')!.textContent!,/草稿已保留/);
 await act(async()=>button(d,'放弃修改并重新加载').click());assert.equal(d.querySelector('textarea')?.value,'Generated other page');assert.equal(draft.version,2);assert.equal(draft.error,'');assert.equal(draft.dirty,false);
 await edit(d,w,'Generated reconciled draft');await act(async()=>{await draft.save();});assert.deepEqual(writes[1],{expectedVersion:2,description:'Generated reconciled draft'});assert.equal(draft.saved,true);
});

test('failed initial read remains unavailable and explicit reload recovers without writing',async t=>{
 const {root,d}=await fixture(t),sourceId='generated-read-failure',calls:string[]=[];let fail=true;
 const api={request:async(_path:string,init?:RequestInit)=>{calls.push(init?.method??'GET');if(fail)throw new ApiError('Generated unavailable',503);return snapshot(sourceId,4,'Generated recovered');}} as unknown as Api;
 await act(async()=>root.render(React.createElement(SourceContextEditor,{api,sourceId})));
 assert.equal(d.querySelector('textarea')?.disabled,true);assert.equal(button(d,'保存说明').disabled,true);assert.match(d.querySelector('[role=alert]')!.textContent!,/Generated unavailable/);
 fail=false;await act(async()=>button(d,'重新加载').click());assert.equal(d.querySelector('textarea')?.value,'Generated recovered');assert.equal(d.querySelector('textarea')?.disabled,false);assert.deepEqual(calls,['GET','GET']);
});

test('lost save response keeps exact draft and expected version for a safe retry',async t=>{
 const {root,d,w}=await fixture(t),sourceId='generated-lost-ack',writes:any[]=[];let value=snapshot(sourceId),fail=true;
 const api={request:async(_path:string,init?:RequestInit)=>{
  if(init?.method==='PATCH'){const body=JSON.parse(String(init.body));writes.push(body);if(fail){value=snapshot(sourceId,1,body.description);fail=false;throw Error('Generated response lost');}}
  return structuredClone(value);
 }} as unknown as Api;
 await act(async()=>root.render(React.createElement(SourceContextEditor,{api,sourceId})));await edit(d,w,'  Generated exact retry\n');await act(async()=>button(d,'保存说明').click());
 assert.match(d.querySelector('[role=alert]')!.textContent!,/Generated response lost/);assert.equal(d.querySelector('textarea')?.value,'  Generated exact retry\n');assert.doesNotMatch(d.body.textContent!,/已获中央确认/);assert.equal(button(d,'保存说明').disabled,false);
 await act(async()=>button(d,'保存说明').click());assert.deepEqual(writes,[{expectedVersion:0,description:'  Generated exact retry\n'},{expectedVersion:0,description:'  Generated exact retry\n'}]);assert.match(d.body.textContent!,/资料说明已获中央确认，版本 1/);
});

for(const swap of ['source','node'] as const)test('late source-context read cannot populate another '+swap,async t=>{
 const {root,d}=await fixture(t);let release!:(value:unknown)=>void,signal!:AbortSignal;
 const api={request:async(path:string,init?:RequestInit)=>{if(path.includes('generated-new'))return snapshot('generated-new',3,'Generated current source');signal=init!.signal as AbortSignal;return new Promise(resolve=>{release=resolve;});}} as unknown as Api;
 const nextApi={request:async()=>snapshot(swap==='source'?'generated-new':'generated-old',3,'Generated current source')} as unknown as Api;
 await act(async()=>root.render(React.createElement(SourceContextEditor,{api,sourceId:'generated-old'})));
 await act(async()=>root.render(React.createElement(SourceContextEditor,{api:swap==='source'?api:nextApi,sourceId:swap==='source'?'generated-new':'generated-old'})));
 assert.equal(signal.aborted,true);await act(async()=>release(snapshot('generated-old',8,'Generated stale private prose')));
 assert.equal(d.querySelector('textarea')?.value,'Generated current source');assert.doesNotMatch(d.body.textContent!,/Generated stale private prose/);
});

test('node changes abort in-flight save, reject its continuation, and ignore an old ACK',async t=>{
 const {root,d,w}=await fixture(t),sourceId='generated-binding';let draft!:SourceContextDraft,release!:(value:unknown)=>void,signal!:AbortSignal;
 const api={request:async(_path:string,init?:RequestInit)=>{if(init?.method==='PATCH'){signal=init.signal as AbortSignal;return new Promise(resolve=>{release=resolve;});}return snapshot(sourceId,1,'Generated old node');}} as unknown as Api;
 const nextApi={request:async()=>snapshot(sourceId,6,'Generated new node')} as unknown as Api;
 await act(async()=>root.render(React.createElement(Harness,{api,sourceId,expose:next=>{draft=next;}})));await edit(d,w,'Generated pending old edit');
 let rejected!:Promise<void>;
 await act(async()=>{rejected=assert.rejects(draft.save(),{name:'AbortError'});});
 await act(async()=>root.render(React.createElement(Harness,{api:nextApi,sourceId,expose:next=>{draft=next;}})));assert.equal(signal.aborted,true);
 await act(async()=>{release(snapshot(sourceId,2,'Generated pending old edit'));await rejected;});
 assert.equal(draft.description,'Generated new node');assert.equal(draft.version,6);assert.equal(draft.saved,false);assert.equal(draft.busy,false);assert.equal(draft.error,'');
});

test('caller cancellation releases saving state and preserves the draft for retry',async t=>{
 const {root,d,w}=await fixture(t),sourceId='generated-cancel';let draft!:SourceContextDraft,release!:(value:unknown)=>void,requestSignal!:AbortSignal,writes=0;
 const api={request:async(_path:string,init?:RequestInit)=>{if(init?.method==='PATCH'){writes++;requestSignal=init.signal as AbortSignal;return new Promise(resolve=>{release=resolve;});}return snapshot(sourceId);}} as unknown as Api;
 await act(async()=>root.render(React.createElement(Harness,{api,sourceId,expose:next=>{draft=next;}})));await edit(d,w,'Generated retained draft');
 const scope=new AbortController();let rejected!:Promise<void>;
 await act(async()=>{rejected=assert.rejects(draft.save(scope.signal),{name:'AbortError'});});assert.equal(draft.busy,true);
 await act(async()=>{scope.abort();release(snapshot(sourceId,1,'Generated retained draft'));await rejected;});
 assert.equal(requestSignal.aborted,true);assert.equal(draft.busy,false);assert.equal(draft.saved,false);assert.equal(draft.dirty,true);assert.equal(draft.version,0);assert.equal(d.querySelector('textarea')?.value,'Generated retained draft');
 const early=new AbortController();await act(async()=>{const pending=draft.save(early.signal);early.abort();await assert.rejects(pending,{name:'AbortError'});});
 assert.equal(writes,1,'a request cancelled before dispatch never calls the old owner transport');assert.equal(draft.busy,false);assert.equal(draft.dirty,true);
});

test('programmatic over-limit edits are rejected without truncating exact prose or writing',async t=>{
 const {root}=await fixture(t),sourceId='generated-length';let draft!:SourceContextDraft,writes=0;
 const api={request:async(_path:string,init?:RequestInit)=>{if(init?.method==='PATCH')writes++;return snapshot(sourceId);}} as unknown as Api;
 await act(async()=>root.render(React.createElement(Harness,{api,sourceId,expose:next=>{draft=next;}})));
 await act(async()=>draft.setDescription('x'.repeat(12001)));await act(async()=>{await assert.rejects(draft.save(),/资料说明最多 12000 字符/);});assert.equal(writes,0);assert.equal(draft.description.length,12001);assert.equal(draft.dirty,true);
});
