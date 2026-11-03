import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {ApiError,type Api} from '../src/api';
import {Conversations} from '../src/plugins/ask/Conversations';
import {openQuestionDraft} from '../src/open-question-draft';
import {unsentDrafts} from '../src/plugins/ask/chat-drafts';
import {queryRecovery} from '../src/plugins/ask/query-recovery';
import {modelView} from './fixtures/model-settings';

configureLocale(()=> 'zh-CN');
async function fixture(t:any){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/search',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>();
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){
  prior.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{value:v,writable:true,configurable:true});
 }
 Object.assign(dom.window.HTMLElement.prototype,{scrollIntoView:()=>{},attachEvent:()=>{},detachEvent:()=>{}});
 const root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());for(const[k,v]of prior)if(v)Object.defineProperty(globalThis,k,v);else Reflect.deleteProperty(globalThis,k);dom.window.close();});
 return{root,d:dom.window.document,w:dom.window};
}
function owner(write:(path:string,init:RequestInit)=>unknown=()=>{throw Error('Unexpected write');}):Api{
 return{request:async(path:string,init?:RequestInit)=>{if(init?.method)return write(path,init);if(path.startsWith('/api/operations/changes'))return new Promise(()=>{});if(path==='/api/model-settings')return modelView();return{items:[]};}} as Api;
}
const view=(root:ReturnType<typeof createRoot>,api:Api)=>act(async()=>root.render(React.createElement(Conversations,{api,configured:true,devices:[],renderAnswer:()=>null})));
const strictView=(root:ReturnType<typeof createRoot>,api:Api)=>act(async()=>root.render(React.createElement(React.StrictMode,null,React.createElement(Conversations,{api,configured:true,devices:[],renderAnswer:()=>null}))));
async function chooseFile(d:Document,name:string){
 await act(async()=>{const input=d.querySelector<HTMLInputElement>('input[type=file]')!;Object.defineProperty(input,'files',{value:[new File(['generated'],name,{type:'image/png'})],configurable:true});input.dispatchEvent(new d.defaultView!.Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,30));});
}
async function changeHash(d:Document,api:Api,question:string){await act(async()=>{openQuestionDraft(api,question);d.defaultView!.dispatchEvent(new d.defaultView!.Event('hashchange'));});}

test('Home/search replacement keeps cancelled work and submits no image after explicit discard',async t=>{
 const{root,d,w}=await fixture(t),posts:any[]=[],api=owner((path,init)=>{if(path==='/api/query-runs'){posts.push(JSON.parse(String(init.body)));throw new ApiError('Generated rejection',400);}throw Error(path);}),other=owner();
 const old={question:'Old unfinished question',attachments:[{id:'11111111-1111-4111-8111-111111111111',name:'old.png',mimeType:'image/png'}]},otherDraft={question:'Other owner draft',attachments:[]};
 unsentDrafts.set(api,old);unsentDrafts.set(other,otherDraft);let prompts=0;w.confirm=()=>{prompts++;return false;};
 await changeHash(d,api,'Generated new search question');assert.equal(w.location.hash,'#/search');assert.equal(unsentDrafts.get(api),old);assert.equal(prompts,1);
 w.confirm=()=>{prompts++;return true;};await changeHash(d,api,'Generated new search question');await strictView(root,api);
 assert.equal(d.querySelector<HTMLTextAreaElement>('textarea')!.value,'Generated new search question');assert.equal(Boolean(d.querySelector('.chat-attachment')),false);assert.equal(unsentDrafts.get(other),otherDraft);
 await act(async()=>d.querySelector('form.ask-form')!.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true})));
 assert.equal(posts.length,1);assert.equal(posts[0].input.question,'Generated new search question');assert.deepEqual(posts[0].input.attachmentIds,[]);
});

test('a failed image alone is guarded, then discarded from the remounted composer only after confirmation',async t=>{
 const{root,d,w}=await fixture(t),api=owner((path,init)=>{if(path==='/api/sources')return JSON.parse(String(init.body));throw new ApiError('Generated upload failure',503);});
 w.location.hash='#/ask';await view(root,api);await chooseFile(d,'failed-only.png');assert.ok(d.querySelector('.chat-image-upload[data-status=failed]'));
 let prompts=0;w.confirm=()=>{prompts++;return false;};await changeHash(d,api,'New search');assert.equal(prompts,1);assert.equal(w.location.hash,'#/ask');assert.ok(d.querySelector('.chat-image-upload[data-status=failed]'));
 w.confirm=()=>true;await changeHash(d,api,'New search');assert.equal(Boolean(d.querySelector('.chat-attachment')),false);assert.equal(d.querySelector<HTMLTextAreaElement>('textarea')!.value,'New search');
 await act(async()=>root.render(null));await view(root,api);assert.equal(Boolean(d.querySelector('.chat-attachment')),false);assert.equal(d.querySelector<HTMLTextAreaElement>('textarea')!.value,'New search');
});

test('discarding a pending upload fences its late receipt while preserving an unresolved query',async t=>{
 const{root,d,w}=await fixture(t);let finish!:(value:unknown)=>void,manifest:any,signal:AbortSignal|undefined;const upload=new Promise(resolve=>finish=resolve),posts:any[]=[];
 const api=owner((path,init)=>{if(path==='/api/sources')return JSON.parse(String(init.body));if(path==='/api/file-sync/v1/uploads'){manifest=JSON.parse(String(init.body));signal=init.signal as AbortSignal;return upload;}if(path==='/api/query-runs'){posts.push(JSON.parse(String(init.body)));throw new ApiError('Generated rejection',400);}throw Error(path);});
 w.location.hash='#/ask';await view(root,api);await chooseFile(d,'held.png');assert.equal(d.querySelector('.chat-image-upload')?.getAttribute('data-status'),'uploading');assert.ok(signal);
 const retained={kind:'owned' as const,id:'old-run',body:'exact old request',question:'Earlier submitted question',attachments:[],unknown:true,...queryRecovery.versions(api)};await act(async()=>queryRecovery.set(api,retained));
 w.confirm=()=>true;await changeHash(d,api,'New search while old receipt is pending');assert.equal(signal!.aborted,true);assert.equal(queryRecovery.get(api),retained);
 const id='22222222-2222-4222-8222-222222222222';await act(async()=>finish({ack:{id,captureId:id,sourceId:manifest.sourceId,externalId:manifest.item.externalId,revision:manifest.item.revision,sha256:manifest.sha256,sizeBytes:manifest.sizeBytes,receipt:{version:2,id,kind:'file-revision',state:'received',duplicate:false,sourceId:manifest.sourceId,externalId:manifest.item.externalId,revision:manifest.item.revision}}}));
 assert.equal(Boolean(d.querySelector('.chat-attachment')),false);assert.equal(d.querySelector<HTMLTextAreaElement>('textarea')!.value,'New search while old receipt is pending');assert.equal(queryRecovery.get(api),retained);assert.equal(posts.length,0);
});

test('an old pending query cannot reclaim the new Home/search question after its late completion',async t=>{
 const{root,d,w}=await fixture(t);let finish!:(value:unknown)=>void;const pending=new Promise(resolve=>finish=resolve),posts:any[]=[];
 const base=owner((path,init)=>{if(path==='/api/query-runs'){posts.push(JSON.parse(String(init.body)));throw new ApiError('Generated rejection',400);}throw Error(path);});
 const api={...base,request:async(path:string,init?:RequestInit)=>{if(path==='/api/query-runs/old-run')return pending;if(path==='/api/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')return{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'Old conversation',turns:[],scope:{},revision:1};return base.request(path,init);}} as Api;
 const run={id:'old-run',status:'running' as const,conversationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',createdAt:'2026-10-29T01:00:00Z',updatedAt:'2026-10-29T01:00:00Z',events:[]};
 const retained={kind:'owned' as const,id:run.id,body:'old exact body',question:'Old question',attachments:[],unknown:true,run,conversationId:run.conversationId,...queryRecovery.versions(api)};
 queryRecovery.set(api,retained);unsentDrafts.set(api,{question:'Old unsent draft',attachments:[]});w.confirm=()=>true;
 await changeHash(d,api,'New independent search question');await strictView(root,api);assert.equal(d.querySelector<HTMLTextAreaElement>('textarea')!.value,'New independent search question');
 await act(async()=>finish({...run,status:'completed'}));assert.equal(queryRecovery.get(api),undefined);assert.equal(w.location.hash,'#/ask');assert.equal(d.querySelector<HTMLTextAreaElement>('textarea')!.value,'New independent search question');
 await act(async()=>d.querySelector('form.ask-form')!.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true})));
 assert.equal(posts.length,1);assert.equal(posts[0].input.question,'New independent search question');assert.equal(Object.hasOwn(posts[0].input,'conversationId'),false);
});

test('a directly opened questionDraft route replaces old attachments before StrictMode restoration',async t=>{
 const{root,d,w}=await fixture(t),api=owner();unsentDrafts.set(api,{question:'Old draft',attachments:[{id:'11111111-1111-4111-8111-111111111111',name:'old.png',mimeType:'image/png'}]});
 w.location.hash='#/ask?questionDraft=Direct%20new%20question';await strictView(root,api);assert.equal(d.querySelector<HTMLTextAreaElement>('textarea')!.value,'Direct new question');assert.equal(Boolean(d.querySelector('.chat-attachment')),false);assert.deepEqual(unsentDrafts.get(api)?.attachments,[]);
});

test('a search handoff while Ask is already showing history starts a new conversation and drops old scope',async t=>{
 const{root,d,w}=await fixture(t),posts:any[]=[],oldId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',when='2026-10-29T01:00:00Z',base=owner((path,init)=>{if(path==='/api/query-runs'){posts.push(JSON.parse(String(init.body)));throw new ApiError('Generated rejection',400);}throw Error(path);});
 const summary={id:oldId,title:'Previous conversation',createdAt:when,updatedAt:when,turnCount:1,scope:{evidenceIds:['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']},status:'completed'};
 const api={...base,request:async(path:string,init?:RequestInit)=>{if(path==='/api/conversations?limit=30')return{items:[summary]};if(path==='/api/conversations/'+oldId)return{...summary,revision:1,turns:[{id:'old-turn',question:'Previous question',status:'completed',result:{answer:'Previous answer',citations:[],trace:[],runId:'old'}}]};return base.request(path,init);}} as Api;
 w.location.hash='#/ask';await strictView(root,api);await act(async()=>d.querySelector<HTMLButtonElement>('.conversation-item')!.click());assert.ok(d.querySelector('#conversation-turn-old-turn'));assert.ok(d.querySelector('nav[aria-label="查询范围"]'));
 await changeHash(d,api,'A new search question');assert.equal(d.querySelector<HTMLTextAreaElement>('textarea')!.value,'A new search question');assert.equal(Boolean(d.querySelector('#conversation-turn-old-turn')),false);assert.equal(Boolean(d.querySelector('nav[aria-label="查询范围"]')),false);
 await act(async()=>d.querySelector('form.ask-form')!.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true})));assert.equal(posts.length,1);assert.equal(posts[0].input.question,'A new search question');assert.equal(Object.hasOwn(posts[0].input,'conversationId'),false);assert.ok(!posts[0].input.scope?.evidenceIds?.length);
});
