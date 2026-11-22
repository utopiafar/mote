import '@mote/shared/i18n-all';
import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale,getLocale} from '@mote/shared/i18n';
import {MemoryPage} from '../src/plugins/memory/index.js';
import type {Api} from '../src/api.js';
import {modelView} from './fixtures/model-settings';

const at='2026-11-20T09:00:00+08:00';
const ids={standing:'10000000-0000-4000-8000-000000000001',person:'10000000-0000-4000-8000-000000000002',matter:'10000000-0000-4000-8000-000000000003',preference:'10000000-0000-4000-8000-000000000004',pending:'10000000-0000-4000-8000-000000000005',manual:'10000000-0000-4000-8000-000000000006',pendingStanding:'10000000-0000-4000-8000-000000000007'};
function memory(id:string,title:string,extra:Record<string,unknown>={}){
 return {id,title,statement:title+'：生成内容',uncertainty:'生成夹具',status:'published',version:1,domain:'personal',fingerprint:'a'.repeat(64),createdAt:at,updatedAt:at,evidenceIds:['30000000-0000-4000-8000-000000000001'],evidence:[],admission:{layer:'memory',reason:'生成夹具',scope:'生成范围',attribution:'user'},...extra};
}
const standing=memory(ids.standing,'早上 9 点前不排会',{contextPriority:'standing'});
const person=memory(ids.person,'周雨',{admission:{layer:'memory',reason:'生成夹具',scope:'生成范围',attribution:'observed'}});
const matter=memory(ids.matter,'0.1 发布',{evidenceIds:['30000000-0000-4000-8000-000000000004']});
const preference=memory(ids.preference,'回复短一些',{domain:'coding',coding:{kind:'preference',scope:'session',applicability:'生成范围',validation:'observed'}});
const pending=memory(ids.pending,'周末通常不看工作消息',{status:'proposed',admission:{layer:'memory',reason:'生成夹具',scope:'生成范围',attribution:'inferred'}});
const base=[standing,person,matter,preference,pending];
const commitment={id:'20000000-0000-4000-8000-000000000001',revision:1,title:'周五前给出设计稿',personMemoryId:ids.person,matterId:'20000000-0000-4000-8000-000000000002',status:'pending_confirmation',deadline:{text:'周五',at:null},dueState:'unknown',evidenceDependencies:{version:1,complete:true,ids:['30000000-0000-4000-8000-000000000004']},timeline:[]};

async function fixture(t:import('node:test').TestContext){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/assistant/memory',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>(),locale=getLocale();configureLocale(()=> 'zh-CN');
 for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});}
 Object.assign(dom.window.HTMLElement.prototype,{scrollIntoView:()=>{},attachEvent:()=>{},detachEvent:()=>{}});dom.window.scrollTo=()=>{};
 const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());configureLocale(()=>locale);for(const[key,value]of prior)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);dom.window.close();});return{root,d:dom.window.document,w:dom.window};
}
function api(handler:(path:string,init?:RequestInit)=>unknown,owner:()=>unknown=()=>undefined):Api{
 return {request:async(path:string,init?:RequestInit)=>{const value=handler(path,init);if(value!==undefined)return value;if(path.startsWith('/api/operations/changes'))return{ids:[],cursor:0,hasMore:false,reset:false};if(path==='/api/memory-jobs')return{items:[],nextCursor:null};if(path==='/api/context-trees')return{items:[]};if(path==='/api/execution-settings')return{queues:{agents:{active:0,waiting:0,limit:1},llm:{active:0,waiting:0,limit:1}}};if(path==='/api/model-settings')return modelView();if(path==='/api/memory-settings')return{settings:{consolidation:{enabled:false,maxItems:5}},extensions:[]};if(path.startsWith('/api/memories?'))return{items:owner(),nextCursor:null};if(path.startsWith('/api/assistant/commitments'))return{items:[],nextCursor:null};return{items:[],nextCursor:null};},setAgentTimeout:()=>{}} as Api;
}
const click=async(d:Document,label:string)=>act(async()=>{const buttons=[...d.querySelectorAll('button')];const button=buttons.find(button=>button.textContent?.trim()===label)??buttons.find(button=>button.textContent?.includes(label));assert.ok(button,label);button.click();});
const fill=async(d:Document,input:HTMLInputElement|HTMLTextAreaElement,value:string)=>act(async()=>{
 input.focus();
 const proto=input instanceof d.defaultView!.HTMLTextAreaElement?d.defaultView!.HTMLTextAreaElement.prototype:d.defaultView!.HTMLInputElement.prototype;
 Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(input,value);
 input.dispatchEvent(new d.defaultView!.Event('input',{bubbles:true}));
 input.dispatchEvent(new d.defaultView!.Event('change',{bubbles:true}));
 input.dispatchEvent(new d.defaultView!.KeyboardEvent('keyup',{bubbles:true,key:'a'}));
});
const render=(root:ReturnType<typeof createRoot>,owner:Api)=>act(async()=>root.render(React.createElement(MemoryPage,{api:owner,onOpen:()=>{}})));

test('ME1-01 a remembered sentence is stored as a manual note and appears at the top of the Memory list',async t=>{
 const{root,d}=await fixture(t);let noteId='',jobReads=0,listReads=0,manual:ReturnType<typeof memory>|undefined;
 const owner=api((path,init)=>{
  if(init?.method==='POST'&&path==='/api/notes'){const body=JSON.parse(String(init.body));noteId=body.id;assert.equal(body.metadata.collector.method,'manual');assert.equal(body.deviceId,'mote-web');return{id:body.id};}
  if(init?.method==='POST'&&path==='/api/memory-jobs'){const body=JSON.parse(String(init.body));assert.deepEqual(body.evidenceIds,[noteId]);manual=memory(ids.manual,'周五前交稿',{evidenceIds:[noteId]});return{id:'job-manual'};}
  if(path==='/api/memory-jobs/job-manual'){jobReads++;return{id:'job-manual',status:'completed',createdAt:at,updatedAt:at,evidenceIds:[noteId],totalBatches:1,completedBatches:1,failedBatches:0,skippedChunks:0,memoryIds:[ids.manual],memoryCount:1,skillVersion:'fixture',inputPlans:{total:1,waiting:0,blocked:0,stale:0,completed:1},recipeProgress:[]};}
  if(path.startsWith('/api/memories?')){listReads++;return{items:manual?[manual,...base]:base,nextCursor:null};}
  return undefined;
 },()=>manual?[manual,...base]:base) as Api;
 await render(root,owner);
 const input=d.querySelector<HTMLInputElement>('#memory-remember-input')!;
 await fill(d,input,'周五前交稿');
 await click(d,'记住');
 assert.ok(noteId,'the sentence is saved as a note with a generated identity');
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,50));});
 assert.ok(jobReads>=1,'the existing memory job is read');
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,50));});
 assert.ok(listReads>=2,'the Memory list is revalidated after the job');
 const rows=[...d.querySelectorAll<HTMLElement>('.memory-page-row')];
 assert.equal(rows[0].textContent?.includes('周五前交稿'),true,'the new manual record appears first');
 assert.match(rows[0].textContent!,/手动/);
});

test('ME1-02 searching a term that exists only in chat returns a chat group beside Memory results',async t=>{
 const{root,d}=await fixture(t);const opened:string[]=[];const owner=api((path)=>{
  if(path.startsWith('/api/memories?')&&path.includes('query='))return{items:[],nextCursor:null};
  if(path.startsWith('/api/context/search?'))return{items:[{ref:'capture:30000000-0000-4000-8000-000000000099',title:'林舟说周五冻结',snippet:'只出现在聊天里的词 GEN_ONLY_CHAT',kind:'message'}],nextCursor:null};
  return undefined;
 },()=>base) as Api;
 await act(async()=>root.render(React.createElement(MemoryPage,{api:owner,onOpen:ref=>opened.push(ref)})));
 const input=d.querySelector<HTMLInputElement>('#memory-page-search-input')!;
 await fill(d,input,'GEN_ONLY_CHAT');
 await act(async()=>input.form!.dispatchEvent(new d.defaultView!.Event('submit',{bubbles:true,cancelable:true})));
 assert.match(d.body.textContent!,/聊天/);
 assert.match(d.body.textContent!,/林舟说周五冻结/);
 await click(d,'林舟说周五冻结');
 assert.deepEqual(opened,['capture:30000000-0000-4000-8000-000000000099']);
 assert.match(d.body.textContent!,/记忆/);
});

test('ME1-03 pending 不对 rejects through the existing deletion operation and removes the row',async t=>{
 const{root,d}=await fixture(t);let list=[...base],method='';
 const owner=api((path,init)=>{
  if(init?.method==='DELETE'&&path===`/api/memories/${ids.pending}`){method='DELETE';list=base.filter(item=>item.id!==ids.pending);return{deleted:1,externalErase:'acknowledged',physicalEraseVerified:false};}
  return undefined;
 },()=>list) as Api;
 await render(root,owner);
 assert.equal(d.querySelectorAll('.memory-page-pending').length,1);
 await click(d,'不对');
 assert.equal(method,'DELETE');
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
 assert.match(d.querySelector('.notice[role=status]')!.textContent!,/已标为不对/);
 assert.equal([...d.querySelectorAll('.memory-page-row')].some(row=>row.textContent?.includes(pending.title)),false);
});

test('ME1-04 pending 确认 publishes the stored version and moves a personal preference to 偏好',async t=>{
 const{root,d}=await fixture(t);const pendingStanding=memory(ids.pendingStanding,'生成夹具：晨间专注时间',{status:'proposed',contextPriority:'standing'});
 let list=[...base,pendingStanding];const writes:string[]=[],published=new Map<string,Record<string,unknown>>();
 const owner=api((path,init)=>{
  const match=/^\/api\/memories\/([^/]+)\/publish$/.exec(path);
  if(init?.method==='POST'&&match){
   const current=list.find(item=>item.id===match[1]);assert.ok(current);
   writes.push(String(init.body));
   // The existing owner publish route advances the stored record's status and
   // version and returns it unchanged otherwise: it never adds contextPriority
   // or coding to a proposal that did not already have them.
   const saved={...current,status:'published',version:(current.version??1)+1,updatedAt:at};
   published.set(current.id,saved);list=list.map(item=>item.id===current.id?saved:item);return saved;
  }
  return undefined;
 },()=>list) as Api;
 await render(root,owner);
 const rows=()=>[...d.querySelectorAll<HTMLElement>('.memory-page-row')];
 const row=(title:string)=>rows().find(item=>item.textContent?.includes(title));
 const confirmRow=async(title:string)=>{await act(async()=>{row(title)!.querySelector<HTMLButtonElement>('.memory-page-pending .button')!.click();});await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});};
 assert.equal(row(pending.title)?.dataset.type,'proposed');
 assert.equal(row(pendingStanding.title)?.dataset.type,'proposed');
 await confirmRow(pending.title);
 assert.deepEqual(writes,['{"version":1}']);
 const saved=published.get(pending.id)!;
 assert.equal(saved.status,'published');
 assert.equal(saved.domain,'personal');
 assert.equal(saved.contextPriority,undefined);
 assert.equal(saved.coding,undefined);
 assert.match(d.querySelector('.notice[role=status]')!.textContent!,/已确认/);
 assert.equal(row(pending.title)?.querySelector('.memory-page-pending'),null,'the confirmed record leaves the pending controls');
 await click(d,'偏好');
 assert.equal(row(pending.title)?.dataset.type,'preference','the confirmed personal preference moves to 偏好');
 await click(d,'待确认');
 assert.equal(row(pending.title),undefined,'the confirmed record leaves 待确认');
 await confirmRow(pendingStanding.title);
 await click(d,'常驻');
 assert.equal(row(pendingStanding.title)?.dataset.type,'standing','a proposal that already stored the standing type keeps it');
 assert.equal(row(pending.title),undefined,'the personal preference is not counted as standing');
});

test('ME1-05 the person row retains access to Memory detail and its commitments',async t=>{
 const{root,d,w}=await fixture(t);const owner=api((path)=>{
  if(path.startsWith('/api/memories/'+ids.person+'?'))return person;
  if(path.startsWith('/api/assistant/commitments'))return{items:[commitment],nextCursor:null};
  return undefined;
 },()=>base) as Api;
 await render(root,owner);
 const row=[...d.querySelectorAll<HTMLElement>('.memory-page-row')].find(row=>row.textContent?.includes(person.title))!;
 assert.equal(row.dataset.type,'people');
 await act(async()=>row.querySelector<HTMLButtonElement>('.memory-page-row-detail')!.click());
 assert.equal(w.location.hash,'#/assistant/memory');
 assert.match(d.querySelector('.memory-detail')!.textContent!,/周雨/);
 assert.match(d.querySelector('.memory-detail')!.textContent!,/相关承诺与互动/);
 assert.equal(d.querySelector('.memory-detail-heading h2')?.textContent,'周雨');
});

test('ME1-07 and ME1-08: the retained More menu and all five correction fields save',async t=>{
 const{root,d}=await fixture(t);const writes:{path:string;body:Record<string,unknown>}[]=[];
 const owner=api((path,init)=>{
  if(path.startsWith('/api/memories/'+ids.standing+'?'))return standing;
  if(init?.method==='POST'&&path===`/api/memories/${ids.standing}/correct`){writes.push({path,body:JSON.parse(String(init.body))});return{...standing,id:'10000000-0000-4000-8000-000000000007',title:'生成纠正'};}
  return undefined;
 },()=>base) as Api;
 await render(root,owner);
 const row=[...d.querySelectorAll<HTMLElement>('.memory-page-row')].find(row=>row.textContent?.includes(standing.title))!;
 await act(async()=>row.querySelector<HTMLButtonElement>('.memory-page-row-main')!.click());
 await click(d,'更多');
 for(const label of ['纠正这条记忆','历史与有效时间','生成信息','删除记忆'])assert.match(d.body.textContent!,new RegExp(label));
 await click(d,'纠正这条记忆');
 const form=d.querySelector<HTMLFormElement>('.memory-correction')!;assert.ok(form);
 const fields=form.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('input,textarea');
 assert.equal(fields.length,5,'the correction keeps title, statement, uncertainty and both validity fields');
 const [title,statement,uncertainty,validFrom,validUntil]=fields;
 await fill(d,title,'生成标题');await fill(d,statement,'生成纠正后的内容');await fill(d,uncertainty,'生成边界');await fill(d,validFrom,'2026-11-21T00:00');await fill(d,validUntil,'2026-12-01T00:00');
 await click(d,'保存纠正');
 const write=writes.at(-1)!;assert.equal(write.path,`/api/memories/${ids.standing}/correct`);assert.equal(write.body.title,'生成标题');assert.equal(write.body.statement,'生成纠正后的内容');assert.equal(write.body.uncertainty,'生成边界');assert.equal(typeof write.body.validFrom,'string');assert.equal(typeof write.body.validUntil,'string');
});

test('ME1-08: deletion confirmation keeps the D28 promise and uses the existing delete operation',async t=>{
 const{root,d}=await fixture(t);let deleted=false;
 const owner=api((path,init)=>{
  if(path.startsWith('/api/memories/'+ids.standing+'?'))return standing;
  if(init?.method==='DELETE'&&path===`/api/memories/${ids.standing}`){deleted=true;return{deleted:1,externalErase:'acknowledged',physicalEraseVerified:false};}
  return undefined;
 },()=>base) as Api;
 await render(root,owner);
 const row=[...d.querySelectorAll<HTMLElement>('.memory-page-row')].find(row=>row.textContent?.includes(standing.title))!;
 await act(async()=>row.querySelector<HTMLButtonElement>('.memory-page-row-main')!.click());
 await click(d,'更多');await click(d,'删除记忆');
 assert.match(d.querySelector('.memory-delete-dialog')!.textContent!,/原始资料保留。同一批旧证据不会重新生成这个结论；有新证据时可以重新判断。/);
 await click(d,'确认删除');
 assert.equal(deleted,true);
});
