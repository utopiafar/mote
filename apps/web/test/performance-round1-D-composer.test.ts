import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {unified} from 'unified';
import {configureLocale} from '@mote/shared/i18n';
import type {Answer,Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';

const when='2026-10-20T00:00:00Z',citation='11111111-1111-4111-8111-111111111111';
const summary=(id='A')=>({id,title:'Generated '+id,createdAt:when,updatedAt:when,turnCount:1,scope:{},status:'completed'});
const answer=(id:string):Answer=>({answer:`## Generated ${id}\n\n**Verified** [${citation}]\n\n| Item | State |\n| --- | --- |\n| Generated | Ready |`,runId:id,citations:[{id:citation,appName:'Generated source',capturedAt:when,excerpt:'Generated evidence'}],trace:[]});
const turn=(id:string)=>({id,question:'Generated question '+id,status:'completed',createdAt:when,result:answer(id)});
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(done=>resolve=done);return {promise,resolve};};
function apiWith(read:(path:string,init?:RequestInit)=>unknown,owner?:string):Api {
 return {connection:owner?{mode:'web',origin:'http://localhost',deploymentId:'generated',userId:owner,credentialId:owner,viewScope:owner,csrfToken:'generated',username:owner,administrator:false}:undefined,
  request:async(path:string,init?:RequestInit)=>{
   if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};
   if(path==='/api/models')return {personal:[],shared:[],selections:{}};
   return read(path,init);
  }} as Api;
}
async function fixture(t:any){
 let locale:'zh-CN'|'en'='zh-CN';configureLocale(()=>locale);
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/ask',pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
 const {createRoot}=await import('react-dom/client'),{Conversations}=await import('../src/Conversations.js'),{AnswerView}=await import('../src/shell-components.js');
 const root=createRoot(dom.window.document.getElementById('root')!),d=dom.window.document,opened:string[]=[],onOpen=(ref:string)=>opened.push(ref);
 let renders=0;
 const renderAnswer=(value:Answer)=>{renders++;return React.createElement(AnswerView,{answer:value,onOpen});};
 const render=(api:Api)=>act(async()=>root.render(React.createElement(Conversations,{api,configured:true,devices:[],renderAnswer,onOpen})));
 const input=()=>d.querySelector<HTMLTextAreaElement>('textarea')!;
 const type=async(value:string)=>act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value')!.set!.call(input(),value);input().dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 const press=async(key:string,options:KeyboardEventInit={})=>{const event=new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options});await act(async()=>input().dispatchEvent(event));return event;};
 const click=async(text:string)=>{const button=[...d.querySelectorAll('button')].find(button=>button.textContent===text);assert.ok(button,'button '+text);await act(async()=>button.click());};
 t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,value]of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}configureLocale(()=> 'zh-CN');});
 return {dom,d,root,render,input,type,press,click,opened,get renders(){return renders;},locale:(next:'zh-CN'|'en')=>locale=next};
}

for(const count of [1,20,100])test(`typing 10 updates with ${count} loaded answers adds no AnswerView renders or Markdown parses`,async t=>{
 const f=await fixture(t),api=apiWith(path=>path==='/api/conversations?limit=30'?{items:[summary()]}:path==='/api/conversations/A'?{...summary(),turns:Array.from({length:count},(_,i)=>turn('turn-'+i)),revision:1,nextCursor:null}:{items:[]},'A');
 // Observe the real unified parse method; retain its exact implementation.
 const prototype=Object.getPrototypeOf(unified()),parse=prototype.parse;let parses=0;
 t.mock.method(prototype,'parse',function(this:unknown,...args:unknown[]){parses++;return parse.apply(this,args);});
 await f.render(api);await act(async()=>f.d.querySelector<HTMLButtonElement>('.conversation-item')!.click());
 const loaded=f.d.querySelectorAll('.conversation-turn');assert.equal(loaded.length,count);assert.equal(f.d.querySelectorAll('.answer-table-scroll').length,count);assert.ok(parses>=count,'actual Markdown parser instrumentation is active');
 const rendersBefore=f.renders,parsesBefore=parses,textarea=f.input(),first=loaded[0],citationButton=f.d.querySelector<HTMLButtonElement>('.inline-citation')!;
 textarea.focus();
 for(let i=0;i<10;i++)await f.type('Generated draft '+i);
 const measured={loaded:count,inputUpdates:10,answerRenders:f.renders-rendersBefore,markdownParses:parses-parsesBefore};t.diagnostic(JSON.stringify(measured));
 assert.equal(f.input(),textarea);assert.equal(f.input().value,'Generated draft 9');assert.equal(first.isConnected,true);assert.equal(citationButton.isConnected,true);assert.equal(f.d.activeElement,textarea);
 assert.equal(f.renders-rendersBefore,0);assert.equal(parses-parsesBefore,0);
});

test('composer keeps current controlled input, IME, Shift+Enter, submit, pending draft and terminal timing',async t=>{
 const f=await fixture(t),poll=deferred(),admission=deferred(),posts:any[]=[];let run:any;
 const api=apiWith((path,init)=>{
  if(path==='/api/query-runs'&&init?.method==='POST'){posts.push(JSON.parse(String(init.body)));return admission.promise;}
  if(path.startsWith('/api/query-runs/'))return poll.promise;
  if(path==='/api/conversations/A')return {...summary(),turns:[turn('new')],revision:1,nextCursor:null};
  return {items:[]};
 },'A');
 await f.render(api);await f.type('  Generated 草稿  ');
 assert.equal(f.d.querySelector<HTMLButtonElement>('.send-button')!.disabled,false);
 assert.equal((await f.press('Enter',{isComposing:true})).defaultPrevented,false);assert.equal(posts.length,0);
 assert.equal((await f.press('Enter',{shiftKey:true})).defaultPrevented,false);assert.equal(posts.length,0);
 assert.equal((await f.press('Enter')).defaultPrevented,true);assert.equal(posts.length,1);assert.equal(posts[0].input.question,'Generated 草稿');assert.equal(f.input().value,'  Generated 草稿  ');assert.equal(f.input().disabled,true);
 run={id:posts[0].id,status:'running',createdAt:when,updatedAt:when,events:[]};await act(async()=>admission.resolve(run));assert.equal(f.input().value,'  Generated 草稿  ');
 await act(async()=>poll.resolve({...run,status:'completed',conversationId:'A'}));assert.equal(f.input().value,'');assert.equal(f.input().disabled,false);
});

test('failed admission, failed run and cancellation preserve the existing draft and retry behavior',async t=>{
 const f=await fixture(t),poll=deferred(),posts:any[]=[];let mode='admission-failure',run:any;
 const api=apiWith((path,init)=>{
  if(path==='/api/query-runs'&&init?.method==='POST'){posts.push(JSON.parse(String(init.body)));if(mode==='admission-failure')throw Error('Generated admission failure');run={id:posts.at(-1).id,status:'running',createdAt:when,updatedAt:when,events:[]};return run;}
  if(path.endsWith('/cancel'))return {...run,status:'cancelled'};
  if(path.startsWith('/api/query-runs/'))return poll.promise;
  if(path==='/api/conversations/A')return {...summary(),turns:[turn('new')],revision:1,nextCursor:null};
  return {items:[]};
 },'A');
 await f.render(api);await f.type('  Generated retry draft  ');await act(async()=>f.d.querySelector('form.ask-form')!.dispatchEvent(new f.dom.window.Event('submit',{bubbles:true,cancelable:true})));
 assert.equal(posts.length,2);assert.equal(posts[0].id,posts[1].id);assert.equal(f.input().value,'Generated retry draft');assert.equal(f.input().disabled,false);
 mode='run-failure';await f.press('Enter');assert.equal(posts.length,3);await act(async()=>poll.resolve({...run,status:'failed',conversationId:'A'}));assert.equal(f.input().value,'Generated retry draft');assert.equal(f.input().disabled,false);
 // A separate deferred run lets the actual cancel command race its in-flight poll.
 const cancelPoll=deferred();let cancelRun:any;const cancelApi=apiWith((path,init)=>{
  if(path==='/api/query-runs'&&init?.method==='POST'){cancelRun={id:JSON.parse(String(init.body)).id,status:'running',createdAt:when,updatedAt:when,events:[]};return cancelRun;}
  if(path.endsWith('/cancel'))return {...cancelRun,status:'cancelled'};
  if(path.startsWith('/api/query-runs/'))return cancelPoll.promise;
  return {items:[]};
 },'A-cancel');
 await f.render(cancelApi);await f.type('Generated cancellation draft');await f.press('Enter');await f.click('停止生成');assert.equal(f.input().value,'Generated cancellation draft');
 await act(async()=>cancelPoll.resolve({...cancelRun,status:'cancelled'}));assert.equal(f.input().value,'Generated cancellation draft');assert.equal(f.input().disabled,false);
});

test('failed historical turn retry submits its original question and restores it on failure',async t=>{
 const f=await fixture(t),poll=deferred(),posts:any[]=[];let run:any;
 const api=apiWith((path,init)=>{
  if(path==='/api/conversations?limit=30')return {items:[summary()]};
  if(path==='/api/conversations/A')return {...summary(),turns:[{...turn('failed'),question:'Generated original retry',status:'failed',result:undefined,error:{code:'generated',message:'Generated failure'}}],revision:1,nextCursor:null};
  if(path==='/api/query-runs'&&init?.method==='POST'){posts.push(JSON.parse(String(init.body)));run={id:posts[0].id,status:'running',createdAt:when,updatedAt:when,events:[]};return run;}
  if(path.startsWith('/api/query-runs/'))return poll.promise;
  return {items:[]};
 },'A');
 await f.render(api);await act(async()=>f.d.querySelector<HTMLButtonElement>('.conversation-item')!.click());await f.type('Generated different draft');await f.click('再次提问');
 assert.equal(posts[0].input.question,'Generated original retry');assert.equal(f.input().value,'Generated different draft');assert.equal(f.input().disabled,true);
 await act(async()=>poll.resolve({...run,status:'failed',conversationId:'A'}));assert.equal(f.input().value,'Generated original retry');assert.equal(f.input().disabled,false);
});

test('draft survives background/locale refresh and supplemental routing, while new/select/delete/API/account reset it',async t=>{
 const f=await fixture(t);let revision=1;
 const read=(path:string)=>path==='/api/conversations?limit=30'?{items:[summary()]}:path==='/api/conversations/A'?{...summary(),revision,turns:[{...turn('new'),evidenceDeleted:revision>1}],nextCursor:'old'}:path.includes('?cursor=')?{...summary(),revision,turns:[turn('old')],nextCursor:null}:{items:[]};
 const api=apiWith(read,'A');await f.render(api);await act(async()=>f.d.querySelector<HTMLButtonElement>('.conversation-item')!.click());
 await f.click('加载更早的对话');assert.equal(f.d.querySelectorAll('.conversation-turn').length,2);
 await f.type('Generated preserved draft');const input=f.input(),cite=f.d.querySelector<HTMLButtonElement>('.inline-citation')!;cite.focus();await act(async()=>resources(api).invalidate(path=>path==='/api/conversations/A'));
 assert.equal(f.input(),input);assert.equal(input.value,'Generated preserved draft');assert.equal(cite.isConnected,true);assert.equal(f.d.activeElement,cite);
 f.locale('en');await f.render(api);assert.equal(f.input().value,'Generated preserved draft');assert.match(f.d.querySelector('.inline-citation')!.textContent!,/Source/);f.locale('zh-CN');await f.render(api);
 // The existing owner-question route temporarily unmounts the ordinary composer.
 await act(async()=>{f.dom.window.history.replaceState(null,'','#/ask?question=generated-question');f.dom.window.dispatchEvent(new f.dom.window.HashChangeEvent('hashchange'));});
 assert.equal(f.input(),null);await act(async()=>{f.dom.window.history.replaceState(null,'','#/ask');f.dom.window.dispatchEvent(new f.dom.window.HashChangeEvent('hashchange'));});assert.equal(f.input().value,'Generated preserved draft');
 revision=2;await act(async()=>resources(api).invalidate(path=>path==='/api/conversations/A'));assert.equal(f.d.querySelectorAll('.conversation-turn').length,1);assert.equal(f.d.querySelectorAll('.inline-citation').length,0);assert.match(f.d.body.textContent!,/相关证据已删除/);assert.equal(f.input().value,'Generated preserved draft');
 await f.click('新对话');assert.equal(f.input().value,'');await f.type('Generated new draft');await act(async()=>f.d.querySelector<HTMLButtonElement>('.conversation-item')!.click());assert.equal(f.input().value,'');
 await f.type('Generated deleted draft');await act(async()=>f.d.querySelector<HTMLButtonElement>('[aria-label="删除此对话"]')!.click());await f.click('确认删除对话');assert.equal(f.input().value,'');
 await f.type('Generated old API draft');await f.render(apiWith(read,'A'));assert.equal(f.input().value,'');await f.type('Generated old account draft');await f.render(apiWith(read,'B'));assert.equal(f.input().value,'');assert.doesNotMatch(f.d.body.textContent!,/Generated old account draft/);
});

for(const phase of ['admission','poll'])test(`late old-account ${phase} cannot overwrite the new account draft`,async t=>{
 const f=await fixture(t),late=deferred();let signal:AbortSignal|undefined,run:any;
 const old=apiWith((path,init)=>{
  if(path==='/api/query-runs'&&init?.method==='POST'){
   run={id:JSON.parse(String(init.body)).id,status:'running',createdAt:when,updatedAt:when,events:[]};
   if(phase==='admission'){signal=init.signal as AbortSignal;return late.promise;}return run;
  }
  if(path.startsWith('/api/query-runs/')){signal=init?.signal as AbortSignal;return late.promise;}
  return {items:[]};
 },'old-account');
 await f.render(old);await f.type('Generated old draft');await f.press('Enter');assert.ok(signal);
 const current=apiWith(()=>({items:[]}),'new-account');await f.render(current);assert.equal(signal!.aborted,true);assert.equal(f.input().value,'');await f.type('Generated current account draft');
 await act(async()=>late.resolve({...run,status:'failed',conversationId:'old-conversation'}));assert.equal(f.input().value,'Generated current account draft');assert.equal(f.input().disabled,false);assert.doesNotMatch(f.d.body.textContent!,/Generated old draft/);
});
