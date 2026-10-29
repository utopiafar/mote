import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {GlobalRetrieval,SearchWorkspace} from '../src/GlobalRetrieval';
import {MemoryTopics} from '../src/MemoryTopics';
import type {Api} from '../src/api';
configureLocale(()=> 'zh-CN');
async function fixture(t:any){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/search?query=generated',pretendToBeVisual:true}),previous=new Map<string,PropertyDescriptor|undefined>();
 // React was imported before jsdom; its fallback input listener expects these legacy hooks.
 Object.assign(dom.window.HTMLElement.prototype,{attachEvent:()=>{},detachEvent:()=>{}});
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});return {root,d:dom.window.document,w:dom.window};
}
test('global retrieval keyboard focuses search without opening a modal or issuing an empty query',async t=>{
 const {root,d,w}=await fixture(t),pages:string[]=[];
 await act(async()=>root.render(React.createElement(GlobalRetrieval,{onPage:page=>pages.push(page)})));
 w.dispatchEvent(new w.KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}));assert.equal(d.activeElement,d.querySelector('input'));
 await act(async()=>d.querySelector('form')!.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true})));assert.equal(w.location.hash,'#/search?query=generated');assert.deepEqual(pages,[]);assert.equal(d.querySelector('[role=dialog]'),null);
});
test('search opens a pinned result with evidence then returns to its result list',async t=>{
 const {root,d}=await fixture(t),reads:string[]=[];
 const api={request:async(path:string)=>{reads.push(path);if(path.startsWith('/api/context/search?'))return {items:[{ref:'memory:generated',title:'Generated result',snippet:'Generated evidence preview',kind:'memory'}],nextCursor:null};if(path==='/api/context/read')return {items:[{id:'generated',ref:'memory:generated',kind:'memory',title:'Generated result',text:'Generated original evidence',textRange:{offset:0,total:27,nextOffset:null}}],missingRefs:[]};throw Error(path);}} as Api;
 await act(async()=>root.render(React.createElement(SearchWorkspace,{api,onOpen:()=>{}})));
 await act(async()=>d.querySelector<HTMLButtonElement>('.library-record')!.click());assert.match(d.querySelector('.library-detail')!.textContent!,/Generated original evidence/);
 await act(async()=>d.querySelector<HTMLButtonElement>('.library-back')!.click());assert.equal(d.querySelector('.library-browser')!.classList.contains('has-selection'),false);assert.match(d.querySelector('.library-master')!.textContent!,/Generated result/);assert.equal(reads.filter(path=>path.startsWith('/api/context/search?')).length,1);
});
test('plugin topic dimensions use supplied exact IDs without replacing or guessing membership',async t=>{
 const {root,d}=await fixture(t),selections:string[][]=[];
 const api={request:async()=>({items:[{id:'topics',version:'1',label:'主题',nodes:[{id:'generated-topic',label:'Generated topic'}]},{id:'plugin-dimension',version:'1',label:'Generated dimension',nodes:[{id:'plugin-node',label:'Generated node'}]}]})} as unknown as Api;
 await act(async()=>root.render(React.createElement(MemoryTopics,{api,treeId:'plugin-dimension',nodeId:'',onChange:(tree,node)=>selections.push([tree,node])})));
 await act(async()=>Array.from(d.querySelectorAll('button')).find(node=>node.textContent==='Generated node')!.click());assert.deepEqual(selections,[['plugin-dimension','plugin-node']]);assert.equal(d.querySelector('select')!.value,'plugin-dimension');
});

test('saving a conversation requires editor confirmation and keeps quoted model output separate from the owner comment',async t=>{
 const {root,d}=await fixture(t),writes:any[]=[];
 const {SaveConversationRecord}=await import('../src/SaveConversationRecord');
 const api={request:async(path:string,init:RequestInit)=>{writes.push({path,body:JSON.parse(String(init.body))});return {id:'11111111-1111-4111-8111-111111111111'};}} as unknown as Api;
 await act(async()=>root.render(React.createElement(SaveConversationRecord,{api,conversationId:'generated-conversation',messageId:'generated-message',question:'Generated question',answer:'Generated untrusted model output',onOpen:()=>{}})));
 assert.equal(writes.length,0);await act(async()=>d.querySelector<HTMLButtonElement>('button')!.click());assert.equal(writes.length,0);assert.match(d.querySelector('details')!.textContent!,/Generated untrusted model output/);
 await act(async()=>d.querySelector('form')!.dispatchEvent(new d.defaultView!.Event('submit',{bubbles:true,cancelable:true})));
 assert.equal(writes.length,1);assert.equal(writes[0].path,'/api/notes');assert.equal(writes[0].body.text,'');assert.equal(writes[0].body.metadata.noteOrigin.kind,'conversation');assert.equal(writes[0].body.metadata.noteOrigin.text,'Generated question\n\nGenerated untrusted model output');assert.deepEqual(writes[0].body.metadata.noteOrigin.messageIds,['generated-message']);assert.match(d.body.textContent!,/查看已保存记录/);
});

test('shared content remains attributed as a quote and safely rendered',async()=>{
 const {renderToStaticMarkup}=await import('react-dom/server');const {NoteOrigin}=await import('../src/NoteOrigin');
 const html=renderToStaticMarkup(React.createElement(NoteOrigin,{capture:{metadata:{version:1,observedAt:'2026-10-01T00:00:00Z',noteOrigin:{kind:'share',text:'Generated <script>quoted assertion</script>',app:'Generated external app'}},ocrText:'Generated owner comment'} as any}));
 assert.match(html,/分享内容/);assert.match(html,/&lt;script&gt;quoted assertion&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/Generated external app/);assert.doesNotMatch(html,/Generated owner comment/);
});

test('clearing Ask scope changes only the next submitted turn and history navigation resets the pending override',async t=>{
 const {root,d,w}=await fixture(t);w.HTMLElement.prototype.scrollIntoView=()=>{};
 const {Conversations}=await import('../src/Conversations');const {modelView}=await import('./fixtures/model-settings');
 const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',evidence='33333333-3333-4333-8333-333333333333',when='2026-10-01T00:00:00Z';
 const summary=(value:string)=>({id:value,title:value===id?'Generated scoped conversation':'Generated other conversation',createdAt:when,updatedAt:when,turnCount:0,scope:value===id?{evidenceIds:[evidence]}:{},status:'completed'});
 const scopedRecord={...summary(id),revision:1,turns:[],nextCursor:null},otherRecord={...summary(other),revision:1,turns:[],nextCursor:null};
 const writes:any[]=[];const api={request:async(path:string,init?:RequestInit)=>{
  if(path==='/api/model-settings')return modelView();
  if(path==='/api/conversations?limit=30')return {items:[summary(id),summary(other)],nextCursor:null};
  if(path.startsWith('/api/conversations/'))return path.split('/').pop()===id?scopedRecord:otherRecord;
  if(path==='/api/query-runs'&&init?.method==='POST'){writes.push(JSON.parse(String(init.body)));return {id:'generated-pending-run',status:'running',createdAt:when,updatedAt:when,events:[]};}
  if(path==='/api/query-runs')return {items:[]};
  if(path==='/api/query-runs/generated-pending-run')return new Promise(()=>{});
  if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};
  if(path.startsWith('/api/owner-questions'))return {items:[],nextCursor:null};
  throw Error('Unexpected generated scope fixture path '+path);
 },setAgentTimeout:()=>{}} as Api;
 await act(async()=>root.render(React.createElement(Conversations,{api,configured:true,devices:[],onOpen:()=>{},renderAnswer:()=>null})));
 const choose=async(title:string)=>act(async()=>Array.from(d.querySelectorAll<HTMLButtonElement>('.conversation-item')).find(button=>button.querySelector('strong')?.textContent===title)!.click());
 await choose('Generated scoped conversation');
 assert.match(d.querySelector('[aria-label="查询范围"]')!.textContent!,/1 条证据/);
 await act(async()=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='清除范围')!.click());
 assert.match(d.querySelector('[aria-label="查询范围"]')!.textContent!,/全部资料/);assert.equal(writes.length,0,'clear is a pending selection, not an API mutation');assert.deepEqual(scopedRecord.scope.evidenceIds,[evidence]);
 await choose('Generated other conversation');await choose('Generated scoped conversation');
 assert.match(d.querySelector('[aria-label="查询范围"]')!.textContent!,/1 条证据/,'opening history resets the unsent clear override');
 await act(async()=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='清除范围')!.click());
 await act(async()=>{const input=d.querySelector<HTMLTextAreaElement>('textarea[aria-label="向 Mote 提问"]')!;Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,'value')!.set!.call(input,'Generated next unscoped question');input.dispatchEvent(new w.Event('input',{bubbles:true}));});
 await act(async()=>d.querySelector<HTMLTextAreaElement>('textarea[aria-label="向 Mote 提问"]')!.closest('form')!.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true})));
 assert.equal(writes.length,1);assert.equal(writes[0].input.conversationId,id);assert.equal(writes[0].input.evidenceIds,null,'the actual public transport explicitly clears inherited scope');assert.equal(writes[0].input.question,'Generated next unscoped question');assert.deepEqual(scopedRecord.scope.evidenceIds,[evidence],'historical scope remains unchanged');
 assert.equal(d.querySelector<HTMLTextAreaElement>('textarea[aria-label="向 Mote 提问"]')!.disabled,true,'running submission freezes its composer');
});
