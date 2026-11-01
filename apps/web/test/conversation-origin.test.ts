import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readOriginTurn,conversationTurnRoute} from '../src/conversation-origin';
import type {Api} from '../src/api';
test('saved origin finds exact older turn, never a similar question, and rejects changed/revoked pages',async()=>{
 const wanted={id:'old',question:'same question'},signal=new AbortController().signal;
 const requests:string[]=[];
 const api={request:async(path:string)=>{requests.push(path);return path.includes('?')?{id:'c',revision:1,turns:[wanted]}:{id:'c',revision:1,turns:[{id:'new',question:'same question'}],nextCursor:'older'};}} as Api;
 assert.deepEqual(await readOriginTurn(api,'c','old',signal),wanted);assert.equal(requests.length,2);
 assert.equal(conversationTurnRoute('c','old'),'#/ask?conversation=c&turn=old');
 for(const replacement of [{id:'c',revision:2,turns:[wanted]},{id:'other',revision:1,turns:[wanted]}]){
  const changed={request:async(path:string)=>path.includes('?')?replacement:{id:'c',revision:1,turns:[],nextCursor:'older'}} as Api;
  await assert.rejects(readOriginTurn(changed,'c','old',signal));
 }
 const denied={request:async()=>{throw Error('403');}} as Api;
 await assert.rejects(readOriginTurn(denied,'c','old',signal),/403/);
 const deleted={request:async()=>({id:'c',turns:[{...wanted,evidenceDeleted:true}]})} as Api;
 assert.equal(await readOriginTurn(deleted,'c','old',signal),undefined);
});

test('saved record warns when its authorized source turn is historical without replacing its quote',async()=>{
 const {JSDOM}=await import('jsdom'),React=await import('react'),{createRoot}=await import('react-dom/client');
 const {NoteOrigin}=await import('../src/NoteOrigin.js');
 const {configureLocale,getLocale}=await import('@mote/shared/i18n');
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'}),previous=new Map<string,PropertyDescriptor|undefined>(),locale=getLocale();
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true})){
  previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 }
 configureLocale(()=> 'zh-CN');const root=createRoot(dom.window.document.getElementById('root')!);
 const snapshot='Generated question\n\nGenerated historical answer [1]';
 const capture={id:'saved',metadata:{noteOrigin:{kind:'conversation',text:snapshot,conversationId:'conversation',messageIds:['turn']}}} as import('../src/api').Capture;
 const api={request:async(path:string)=>{assert.equal(path,'/api/conversations/conversation');return {id:'conversation',revision:2,turns:[{id:'turn',question:'Generated question',evidenceStale:true,result:{answer:'Generated historical answer [1]',citations:[{id:'source'}]}}]};}} as Api;
 try{
  await React.act(async()=>root.render(React.createElement(NoteOrigin,{api,capture,onOpen:()=>{}})));
  const notice=dom.window.document.querySelector('[role="status"]');
  assert.equal(notice?.textContent,'这是历史版本，当前资料已更新。');
  assert.match(dom.window.document.querySelector('.note-origin')!.textContent!,/Generated question.*Generated historical answer \[1\]/s);
  assert.equal(dom.window.document.querySelector('a')?.getAttribute('href'),'#/ask?conversation=conversation&turn=turn');
  assert.equal(dom.window.document.querySelectorAll('nav button').length,1);
 }finally{
  await React.act(async()=>root.unmount());dom.window.close();configureLocale(()=>locale);
  for(const [key,value]of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}
 }
});

test('saved origin formats only an exact authorized answer and keeps the literal snapshot on changed or unavailable turns',async()=>{
 const {JSDOM}=await import('jsdom'),React=await import('react'),{createRoot}=await import('react-dom/client');
 const {NoteOrigin}=await import('../src/NoteOrigin.js'),{configureLocale,getLocale}=await import('@mote/shared/i18n');
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'}),previous=new Map<string,PropertyDescriptor|undefined>(),locale=getLocale();
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true})){
  previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 }
 configureLocale(()=> 'zh-CN');const root=createRoot(dom.window.document.getElementById('root')!),opened:string[]=[];
 const citation='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',answer='## Generated heading\n\n**Answer** ['+citation+'] and [authored label]',snapshot='Generated question\n\n'+answer;
 const capture={id:'saved',metadata:{noteOrigin:{kind:'conversation',text:snapshot,conversationId:'conversation',messageIds:['turn']}}} as import('../src/api').Capture;
 let mode:'same'|'changed'|'unavailable'='same';
 const api={request:async(path:string)=>{if(mode==='unavailable')throw Error('Generated forbidden');if(path.includes('/references/'))return{id:citation,available:true};return {id:'conversation',revision:1,turns:[{id:'turn',question:'Generated question',result:{answer:mode==='same'?answer:answer+' changed',citations:[{id:citation}]}}]};}} as Api;
 try{
  const mount=()=>React.act(async()=>root.render(React.createElement(NoteOrigin,{api,capture,onOpen:(ref:string)=>opened.push(ref)})));
  await mount();const origin=dom.window.document.querySelector('.note-origin')!;
  assert.equal(origin.querySelector('strong')?.textContent,'Answer');assert.doesNotMatch(origin.textContent!,/##|\*\*|bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/);assert.match(origin.textContent!,/\[authored label\]/);
  await React.act(async()=>origin.querySelector<HTMLButtonElement>('nav button')!.click());assert.deepEqual(opened,['capture:'+citation]);assert.equal(capture.metadata!.noteOrigin!.text,snapshot);
  await React.act(async()=>root.render(null));mode='changed';await mount();assert.match(dom.window.document.querySelector('[role=status]')!.textContent!,/不同/);assert.equal(dom.window.document.querySelector('pre')!.textContent,snapshot);assert.equal(dom.window.document.querySelector('nav'),null);
  await React.act(async()=>root.render(null));mode='unavailable';await mount();assert.match(dom.window.document.querySelector('[role=status]')!.textContent!,/暂不可读/);assert.equal(dom.window.document.querySelector('pre')!.textContent,snapshot);assert.equal(dom.window.document.querySelector('nav'),null);
 }finally{
  await React.act(async()=>root.unmount());dom.window.close();configureLocale(()=>locale);
  for(const [key,value]of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}
 }
});

test('saved-origin citation checks history availability and ignores late replies after snapshot or owner changes',async()=>{
 const {JSDOM}=await import('jsdom'),React=await import('react'),{createRoot}=await import('react-dom/client');
 const {NoteOrigin}=await import('../src/NoteOrigin.js'),{configureLocale,getLocale}=await import('@mote/shared/i18n');
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'}),previous=new Map<string,PropertyDescriptor|undefined>(),locale=getLocale();
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true})){
  previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 }
 configureLocale(()=> 'zh-CN');const root=createRoot(dom.window.document.getElementById('root')!),opened:string[]=[],citation='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const original='Generated question\n\nGenerated answer ['+citation+']';
 const record=(text=original)=>({id:'saved',metadata:{noteOrigin:{kind:'conversation',text,conversationId:'conversation',messageIds:['turn']}}} as import('../src/api').Capture);
 let mode:'denied'|'allowed'|'held'='denied',finish!:(value:unknown)=>void,signal:AbortSignal|undefined,gateReads=0,withdrawn=false;
 const api={request:async(path:string,init?:RequestInit)=>{if(path.includes('/references/')){gateReads++;signal=init?.signal as AbortSignal;if(mode==='held')return new Promise(resolve=>finish=resolve);return{id:citation,available:mode==='allowed'};}return{id:'conversation',revision:1,turns:[{id:'turn',question:'Generated question',evidenceDeleted:withdrawn,result:{answer:'Generated answer ['+citation+']',citations:[{id:citation}]}}]};}} as Api;
 const mount=(owner:Api,capture=record())=>React.act(async()=>root.render(React.createElement(NoteOrigin,{api:owner,capture,onOpen:(ref:string)=>opened.push(ref)})));
 const click=()=>React.act(async()=>dom.window.document.querySelector<HTMLButtonElement>('.note-origin nav button')!.click());
 try{
  await mount(api);await click();assert.equal(gateReads,1);assert.deepEqual(opened,[]);assert.match(dom.window.document.querySelector('[role=status]')!.textContent!,/引用不可用/);
  mode='allowed';await click();assert.deepEqual(opened,['capture:'+citation]);
  mode='held';await click();withdrawn=true;await React.act(async()=>finish({id:citation,available:true}));assert.deepEqual(opened,['capture:'+citation]);assert.match(dom.window.document.querySelector('[role=status]')!.textContent!,/引用不可用/);withdrawn=false;
  mode='held';await click();assert.ok(finish);await mount(api,record(original+' changed'));assert.equal(signal?.aborted,true);await React.act(async()=>finish({id:citation,available:true}));assert.deepEqual(opened,['capture:'+citation]);
  await mount(api);mode='held';finish=undefined as any;await click();assert.ok(finish);const other={request:async()=>{throw Error('Generated second owner unavailable');}} as Api;await mount(other);assert.equal(signal?.aborted,true);await React.act(async()=>finish({id:citation,available:true}));assert.deepEqual(opened,['capture:'+citation]);
 }finally{
  await React.act(async()=>root.unmount());dom.window.close();configureLocale(()=>locale);
  for(const [key,value]of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}
 }
});

async function originClockFixture(t:import('node:test').TestContext){
 const {JSDOM}=await import('jsdom'),React=await import('react'),{createRoot}=await import('react-dom/client');
 const {NoteOrigin}=await import('../src/NoteOrigin.js'),{createApi}=await import('../src/api.js'),{configureLocale,getLocale}=await import('@mote/shared/i18n');
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>(),locale=getLocale();
 for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});}
 configureLocale(()=> 'zh-CN');const root=createRoot(dom.window.document.getElementById('root')!),opened:string[]=[],base='/api/conversations/generated-conversation',citation='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const question='Generated same question',answer='Generated pinned answer ['+citation+']',snapshot=question+'\n\n'+answer;
 const capture={id:'generated-saved-note',metadata:{noteOrigin:{kind:'conversation',conversationId:'generated-conversation',messageIds:['exact-older-turn'],text:snapshot}}} as import('../src/api').Capture;
 const reads:{path:string;owner:string;signal?:AbortSignal|null}[]=[];let mode:number|'online'|'offline'|'deleted'|'revision'='online',hidden=false;
 let hold:((path:string,response:Response)=>Promise<Response>|undefined)|undefined;
 Object.defineProperty(dom.window.document,'hidden',{get:()=>hidden,configurable:true});
 t.mock.method(globalThis,'fetch',async(path:string,init:RequestInit={})=>{
  if(init.signal?.aborted)throw new DOMException('Aborted','AbortError');
  const owner=new Headers(init.headers).get('authorization')??'';reads.push({path,owner,signal:init.signal});
  if(mode==='offline')throw new TypeError('Generated network unavailable');
  const status=owner!=='Bearer generated-origin-owner'?401:typeof mode==='number'?mode:200;
  const value=status!==200?{error:'generated-unavailable'}:path.includes('/references/')?{id:citation,available:true}:path.includes('?cursor=')?{id:'generated-conversation',revision:mode==='revision'?2:1,turns:[{id:'exact-older-turn',question,evidenceDeleted:mode==='deleted',result:{answer,citations:[{id:citation}]}}]}:{id:'generated-conversation',revision:1,turns:[{id:'similar-newer-turn',question,result:{answer:'Generated similar answer that must never replace the quote',citations:[]}}],nextCursor:'older-page'};
  const response=new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});return hold?.(path,response)??response;
 });
 const api=createApi({token:'generated-origin-owner'}),other=createApi({token:'generated-other-owner'});
 t.after(async()=>{t.mock.timers.reset();await React.act(async()=>root.unmount());configureLocale(()=>locale);dom.window.close();for(const[key,value]of prior)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);});
 t.mock.timers.enable({apis:['setTimeout']});
 const tick=async(ms=0)=>React.act(async()=>{t.mock.timers.tick(ms);await new Promise<void>(resolve=>setImmediate(resolve));});
 const render=(owner=api)=>React.act(async()=>root.render(React.createElement(NoteOrigin,{api:owner,capture,onOpen:(ref:string)=>opened.push(ref)})));
 const visibility=async(value:boolean)=>{hidden=value;await React.act(async()=>dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')));};
 return{d:dom.window.document,api,other,opened,base,citation,snapshot,reads,tick,render,visibility,mode:(value:typeof mode)=>mode=value,hold:(value:typeof hold)=>hold=value,act:React.act};
}

test('saved exact-turn reader stops hidden timer GETs for 60s and coalesces foreground before keeping visible 5s',async t=>{
 const f=await originClockFixture(t);await f.render();await f.tick();assert.ok(f.d.querySelector('.quoted-answer-markdown'));assert.equal(f.d.querySelector('a')!.getAttribute('href'),'#/ask?conversation=generated-conversation&turn=exact-older-turn');
 const count=(path:string)=>f.reads.filter(read=>read.path===path).length;assert.equal(count(f.base),1);assert.equal(count(f.base+'?cursor=older-page'),1);
 await f.visibility(true);await f.tick(60000);assert.equal(count(f.base),1);assert.equal(count(f.base+'?cursor=older-page'),1);
 await f.visibility(false);await f.visibility(false);await f.tick();assert.equal(count(f.base),2);assert.equal(count(f.base+'?cursor=older-page'),2);
 await f.tick(4999);assert.equal(count(f.base),2);await f.tick(1);assert.equal(count(f.base),3);assert.equal(count(f.base+'?cursor=older-page'),3);
 assert.doesNotMatch(f.d.body.textContent!,/similar answer/);assert.deepEqual(f.opened,[]);
});

test('foreground exact-turn refresh coalesces behind a held page read and does not starve it',async t=>{
 const f=await originClockFixture(t);await f.render();await f.tick();let release!:()=>void;
 f.hold((path,response)=>path===f.base?new Promise(done=>release=()=>done(response)):undefined);
 await f.tick(5000);assert.equal(typeof release,'function');await f.visibility(true);await f.tick(60000);await f.visibility(false);await f.visibility(false);
 assert.equal(f.reads.filter(read=>read.path===f.base).length,2);
 f.hold(undefined);await f.act(async()=>release());await f.tick();assert.equal(f.reads.filter(read=>read.path===f.base).length,3,'one fresh read follows the held request');assert.ok(f.d.querySelector('.quoted-answer-markdown'));
});

test('held old-Api source pages cannot publish or run a queued foreground check after owner change',async t=>{
 const f=await originClockFixture(t);await f.render();await f.tick();let release!:()=>void;
 f.hold((path,response)=>path===f.base?new Promise(done=>release=()=>done(response)):undefined);
 await f.tick(5000);await f.visibility(true);await f.visibility(false);const old=f.reads.at(-1)!;assert.equal(typeof release,'function');
 f.hold(undefined);await f.render(f.other);await f.tick();assert.equal(old.signal?.aborted,true);await f.act(async()=>release());await f.tick(60000);
 assert.equal(f.reads.filter(read=>read.owner==='Bearer generated-origin-owner'&&read.path===f.base).length,2);
 assert.equal(Boolean(f.d.querySelector('.quoted-answer-markdown')),false);assert.equal(f.d.querySelector('pre')!.textContent,f.snapshot);assert.match(f.d.body.textContent!,/暂不可读/);assert.deepEqual(f.opened,[]);
});

for(const status of [401,403,404,409,'offline'] as const)test('foreground exact-turn '+status+' clears navigation while preserving the saved literal',async t=>{
 const f=await originClockFixture(t);await f.render();await f.tick();assert.ok(f.d.querySelector('.quoted-answer-markdown'));
 await f.visibility(true);f.mode(status);await f.visibility(false);await f.tick();
 assert.equal(Boolean(f.d.querySelector('.quoted-answer-markdown')),false);assert.equal(Boolean(f.d.querySelector('nav')),false);assert.equal(Boolean(f.d.querySelector('a')),false);assert.equal(f.d.querySelector('pre')!.textContent,f.snapshot);assert.match(f.d.body.textContent!,/暂不可读/);assert.deepEqual(f.opened,[]);
});

for(const change of ['deleted','revision'] as const)test('foreground exact older turn '+change+' never falls back to a similar first-page answer',async t=>{
 const f=await originClockFixture(t);await f.render();await f.tick();assert.ok(f.d.querySelector('.quoted-answer-markdown'));
 await f.visibility(true);f.mode(change);await f.visibility(false);await f.tick();
 assert.equal(Boolean(f.d.querySelector('.quoted-answer-markdown')),false);assert.equal(f.d.querySelector('pre')!.textContent,f.snapshot);assert.match(f.d.body.textContent!,/暂不可读/);assert.doesNotMatch(f.d.body.textContent!,/similar answer/);
});

test('a held citation availability cannot open after foreground discovers exact-turn deletion',async t=>{
 const f=await originClockFixture(t);await f.render();await f.tick();let release!:()=>void;
 f.hold((path,response)=>path.includes('/references/')?new Promise(done=>release=()=>done(response)):undefined);
 await f.act(async()=>f.d.querySelector<HTMLButtonElement>('.note-origin nav button')!.click());assert.equal(typeof release,'function');
 await f.visibility(true);f.mode('deleted');await f.visibility(false);await f.tick();f.hold(undefined);await f.act(async()=>release());await f.tick();
 assert.deepEqual(f.opened,[]);assert.equal(f.d.querySelector('pre')!.textContent,f.snapshot);assert.equal(Boolean(f.d.querySelector('nav')),false);
});
