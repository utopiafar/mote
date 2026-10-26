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
  assert.equal([...dom.window.document.querySelectorAll('pre')].map(node=>node.textContent).join('\n\n'),snapshot);
  assert.equal(dom.window.document.querySelector('a')?.getAttribute('href'),'#/ask?conversation=conversation&turn=turn');
  assert.equal(dom.window.document.querySelectorAll('nav button').length,1);
 }finally{
  await React.act(async()=>root.unmount());dom.window.close();configureLocale(()=>locale);
  for(const [key,value]of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}
 }
});
