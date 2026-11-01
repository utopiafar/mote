import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {OwnerQuestionConversation,OwnerQuestionLinks} from '../src/OwnerQuestions.js';
import {ownerQuestionRoute,readOwnerQuestion,ownerQuestionListPath} from '../src/owner-question-route.js';
import {ApiError,type Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';
import type {OwnerQuestion} from '@mote/shared';
import {Conversations} from '../src/Conversations.js';
import { featuresReady } from '../src/features/bootstrap.js';
import { webFeatures } from '../src/features/registry.js';
import { FeaturePanels } from '../src/features/runtime.js';
import {WebFeatureHost} from '../src/features/host.js';
import {ownerQuestionPanels} from '../src/features/owner-questions.js';
import {modelView} from './fixtures/model-settings.js';

configureLocale(()=> 'zh-CN');
const when='2026-01-01T00:00:00Z';
const generated:OwnerQuestion={id:'00000000-0000-4000-8000-000000000001',provider:{id:'fixture.material',version:'1'},operationId:'generated-operation',workId:'fixture-work',materialId:'generated-material',materialRef:'material:generated@revision',title:'合成工作复盘',prompt:'讲述工作压力的是你吗？',reason:'全文没有可靠的身份对应。',evidence:[{id:'fixture-evidence',quote:'说话人1：这周怎么样？我有点工作压力。',ref:'capture:00000000-0000-4000-8000-000000000009'}],choices:[{id:'narrator',label:'我是讲述者',answer:'这份资料里，讲述工作压力的是我。'},{id:'responder',label:'我是回应的人',answer:'这份资料里，我是回应和提问的人。'}],state:'open',revision:1,createdAt:when,updatedAt:when,messages:[{role:'assistant',text:'讲述工作压力的是你吗？',createdAt:when}]};
async function fixture(t:import('node:test').TestContext){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/ask',pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,location:dom.window.location,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const {createRoot}=await import('react-dom/client');
 dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
 const root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 return {root,d:dom.window.document,w:dom.window};
}
const button=(d:Document,label:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent?.trim()===label)!;
const send=(d:Document)=>d.querySelector<HTMLButtonElement>('button[aria-label="回答并继续"]')!;
async function type(d:Document,w:JSDOM['window'],text:string){await act(async()=>{const input=d.querySelector('textarea')!;Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,'value')!.set!.call(input,text);input.dispatchEvent(new w.Event('input',{bubbles:true}));});}
function deferred(){let resolve!:(value:any)=>void;return {promise:new Promise<any>(done=>resolve=done),resolve:(value:any)=>resolve(value)};}
function questionClock(t:import('node:test').TestContext,d:Document){
 let hidden=false;Object.defineProperty(d,'hidden',{get:()=>hidden,configurable:true});t.mock.timers.enable({apis:['setTimeout']});
 return {tick:async(ms=0)=>act(async()=>{t.mock.timers.tick(ms);await new Promise<void>(resolve=>setImmediate(resolve));}),visibility:async(value:boolean)=>{hidden=value;await act(async()=>{d.dispatchEvent(new d.defaultView!.Event('visibilitychange'));});}};
}

test('owner question links keep scope and identifiers separate from answer interpretation',()=>{
 const id='generated question & choice=owner';assert.equal(readOwnerQuestion(ownerQuestionRoute(id)),id);
 const query=new URLSearchParams(ownerQuestionListPath({workId:'fixture-work',materialId:'fixture-material'},'next').split('?')[1]);
 assert.equal(query.get('workId'),'fixture-work');assert.equal(query.get('materialId'),'fixture-material');assert.equal(query.get('state'),'open,deferred');assert.equal(query.get('cursor'),'next');
 assert.deepEqual(JSON.parse(new URLSearchParams(ownerQuestionListPath({operationIds:['memory:generated-one','memory:generated-two']}).split('?')[1]).get('operationIds')!),['memory:generated-one','memory:generated-two']);
});
test('authored choice submits one revisioned answer, prevents double submission and does not claim saved memory',async t=>{
 const {root,d}=await fixture(t),writes:any[]=[],opens:string[]=[],pending=deferred();let current=structuredClone(generated);
 const api={request:async(path:string,init?:RequestInit)=>{if(init?.method==='POST'){writes.push(JSON.parse(String(init.body)));return pending.promise;}return current;}} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionConversation,{api,id:generated.id,onOpen:ref=>opens.push(ref)})));
 assert.equal(d.querySelector('details')?.open,false);await act(async()=>button(d,'查看原始记录').click());assert.equal(opens[0],generated.evidence[0].ref);
 await act(async()=>button(d,'我是讲述者').click());assert.equal(d.querySelector('textarea')!.value,generated.choices[0].answer);
 await act(async()=>{send(d).click();send(d).click();});assert.equal(writes.length,1);
 assert.equal(writes[0].choiceId,'narrator');assert.equal(writes[0].answer,undefined);assert.equal(writes[0].expectedRevision,1);assert.match(writes[0].requestId,/^[a-f0-9-]{36}$/);
 current={...current,state:'answered',revision:2,continuationId:'generated-continuation',outcome:'已继续整理这份资料。',messages:[...current.messages,{role:'user',text:generated.choices[0].answer,createdAt:when}]};
 await act(async()=>pending.resolve(current));assert.equal(d.querySelector('textarea'),null);assert.match(d.body.textContent!,/成果审核完成后才会保存/);assert.doesNotMatch(d.body.textContent!,/已保存.*记忆/);
});
test('editing an authored choice sends literal free text; provider follow-up keeps dialogue open',async t=>{
 const {root,d,w}=await fixture(t),writes:any[]=[];let current=structuredClone(generated);
 const api={request:async(_path:string,init?:RequestInit)=>{if(init?.method==='POST'){writes.push(JSON.parse(String(init.body)));current={...current,revision:2,prompt:'你指的是哪一位？',choices:[],messages:[...current.messages,{role:'user',text:writes[0].answer,createdAt:when},{role:'assistant',text:'你指的是哪一位？',createdAt:when}]};}return current;}} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionConversation,{api,id:generated.id,onOpen:()=>{}})));
 await act(async()=>button(d,'我是讲述者').click());const text='  不是我，yes，也不是回应者；这是虚构样例。\n';await type(d,w,text);
 await act(async()=>send(d).click());assert.equal(writes[0]?.answer,text);assert.equal(writes[0]?.choiceId,undefined);assert.match(d.body.textContent!,/你指的是哪一位/);assert.ok(d.querySelector('textarea'));assert.doesNotMatch(d.body.textContent!,/已回答/);
});
test('unknown closes and defer remains answerable, without attaching a draft to either action',async t=>{
 const {root,d}=await fixture(t),writes:any[]=[];let current=structuredClone(generated);
 const api={request:async(_path:string,init?:RequestInit)=>{if(init?.method==='POST'){const reply=JSON.parse(String(init.body));writes.push(reply);current={...current,state:reply.action==='unknown'?'closed':reply.action==='answer'?'answered':'deferred',revision:current.revision+1};}return current;}} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionConversation,{api,id:generated.id,onOpen:()=>{}})));
 await act(async()=>button(d,'我是回应的人').click());await act(async()=>button(d,'稍后再说').click());assert.equal(writes[0].action,'defer');assert.equal(writes[0].choiceId,undefined);assert.equal(writes[0].answer,undefined);assert.match(d.body.textContent!,/其他工作继续/);assert.ok(d.querySelector('textarea'));
 await act(async()=>button(d,'我也不知道').click());assert.equal(writes[1].action,'unknown');assert.equal(writes[1].expectedRevision,2);assert.equal(d.querySelector('textarea'),null);assert.match(d.body.textContent!,/本次不再追问/);
 await act(async()=>button(d,'我有新信息了').click());assert.ok(d.querySelector('textarea'));assert.equal(writes.length,2);
 await act(async()=>button(d,'我是讲述者').click());await act(async()=>send(d).click());assert.equal(writes[2].expectedRevision,3);assert.equal(writes[2].action,'answer');assert.equal(d.querySelector('textarea'),null);
});
test('an ambiguous transport failure reuses the same admission UUID; stale revisions refresh instead',async t=>{
 const {root,d}=await fixture(t),writes:any[]=[];let current=structuredClone(generated),failure:unknown=new Error('Generated transport failure');
 const api={request:async(_path:string,init?:RequestInit)=>{if(init?.method==='POST'){writes.push(JSON.parse(String(init.body)));throw failure;}return current;}} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionConversation,{api,id:generated.id,onOpen:()=>{}})));
 await act(async()=>button(d,'我是讲述者').click());await act(async()=>send(d).click());await act(async()=>send(d).click());assert.equal(writes[0].requestId,writes[1].requestId);
 failure=new ApiError('Generated stale version',409,undefined,'conflict');current={...current,revision:2,prompt:'更新后的合成问题',messages:[{role:'assistant',text:'更新后的合成问题',createdAt:when}]};await act(async()=>send(d).click());assert.match(d.body.textContent!,/这个问题已更新/);assert.match(d.body.textContent!,/更新后的合成问题/);
 await act(async()=>send(d).click());assert.equal(writes.at(-1).expectedRevision,2);assert.notEqual(writes.at(-1).requestId,writes[0].requestId);
});
test('late replies from a previous identity cannot populate the replacement conversation',async t=>{
 const {root,d}=await fixture(t),pending=deferred();let signal:AbortSignal|undefined;
 const first={request:async(_path:string,init?:RequestInit)=>{if(init?.method==='POST'){signal=init.signal as AbortSignal;return pending.promise;}return generated;}} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionConversation,{api:first,id:generated.id,onOpen:()=>{}})));await act(async()=>button(d,'我是讲述者').click());await act(async()=>send(d).click());
 const other={...generated,id:'00000000-0000-4000-8000-000000000002',title:'另一份合成资料'},second={request:async()=>other} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionConversation,{api:second,id:other.id,onOpen:()=>{}})));assert.equal(signal?.aborted,true);
 await act(async()=>pending.resolve({...generated,state:'answered',revision:2,outcome:'STALE GENERATED RESULT'}));assert.equal(d.querySelector('h2')?.textContent,other.title);assert.doesNotMatch(d.body.textContent!,/STALE GENERATED RESULT/);assert.equal(d.querySelector('textarea')!.value,'');
});
test('revoked detail removes source quotes and prevents further answers',async t=>{
 const {root,d}=await fixture(t);let revoked=false,rechecking=false;const api={request:async(_path:string,init?:RequestInit)=>{if(rechecking)return new Promise(()=>{});if(revoked)throw new ApiError('Generated revoked access',403);return init?.method==='POST'?{...generated,state:'answered',revision:2}:generated;}} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionConversation,{api,id:generated.id,onOpen:()=>{}})));assert.match(d.body.textContent!,/说话人1/);
 await act(async()=>button(d,'我是讲述者').click());await act(async()=>send(d).click());
 revoked=true;await act(async()=>resources(api).get('/api/owner-questions/'+generated.id).refresh());assert.doesNotMatch(d.body.textContent!,/说话人1/);assert.equal(d.querySelector('textarea'),null);assert.match(d.body.textContent!,/Generated revoked access/);
 rechecking=true;await act(async()=>resources(api).get('/api/owner-questions/'+generated.id).refresh());assert.doesNotMatch(d.body.textContent!,/说话人1/);assert.equal(d.querySelector('textarea'),null);
});
test('question entry pagination reads only the requested material and opens Ask detail',async t=>{
 const {root,d}=await fixture(t),reads:string[]=[];const api={request:async(path:string)=>{reads.push(path);return {items:[generated],nextCursor:reads.length===1?'next':null};}} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionLinks,{api,materialId:'generated-material'})));
 assert.equal(new URLSearchParams(reads[0].split('?')[1]).get('materialId'),'generated-material');assert.equal(new URLSearchParams(reads[0].split('?')[1]).get('state'),'open,deferred,closed,answered');assert.equal(d.querySelector('a')!.getAttribute('href'),ownerQuestionRoute(generated.id));
 await act(async()=>button(d,'继续展开').click());assert.equal(new URLSearchParams(reads[1].split('?')[1]).get('cursor'),'next');
});
test('empty question history retains final filters while polling without flashing stale rows',async t=>{
 const {root,d}=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});const reads:ReturnType<typeof deferred>[]=[];
 const api={request:async()=>{const read=deferred();reads.push(read);return read.promise;}} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionLinks,{api,history:true})));
 assert.match(d.querySelector('[role="status"]')!.textContent!,/正在读取/);assert.equal(reads.length,1);
 await act(async()=>reads[0].resolve({items:[],nextCursor:null}));assert.match(d.querySelector('.owner-question-history')!.textContent!,/没有待回答的问题/);
 for(let index=1;index<=2;index++){
  await act(async()=>t.mock.timers.tick(5000));assert.equal(reads.length,index+1);assert.match(d.querySelector('.owner-question-history')!.textContent!,/待回答/);assert.equal(d.querySelector('.owner-question-history a'),null,'a pending empty refresh does not resurrect a stale row');
  await act(async()=>reads[index].resolve({items:[],nextCursor:null}));assert.match(d.querySelector('.owner-question-history')!.textContent!,/没有待回答的问题/);
 }
 await act(async()=>t.mock.timers.tick(5000));assert.match(d.querySelector('.owner-question-history')!.textContent!,/没有待回答的问题/);
 await act(async()=>reads[3].resolve({items:[generated],nextCursor:null}));const link=d.querySelector('.owner-question-history a')!;assert.equal(link.getAttribute('href'),ownerQuestionRoute(generated.id));
 await act(async()=>t.mock.timers.tick(5000));assert.equal(d.querySelector('.owner-question-history a'),link);assert.equal(d.querySelector('[role="status"]'),null,'refreshing a loaded page does not show initial loading');
 await act(async()=>reads[4].resolve({items:[{...generated,title:'更新后的合成问题'}],nextCursor:null}));assert.equal(d.querySelector('.owner-question-history a'),link);assert.match(link.textContent!,/更新后的合成问题/);
 await act(async()=>t.mock.timers.tick(5000));assert.equal(d.querySelector('.owner-question-history a'),link);
 await act(async()=>reads[5].resolve({items:[],nextCursor:null}));assert.equal(d.querySelector('.owner-question-history a'),null,'answered questions leave the pending list after the read completes');assert.match(d.querySelector('.owner-question-history')!.textContent!,/没有待回答的问题/);
});
test('empty question links preserve initial failure retry and background refresh errors',async t=>{
 const {root,d}=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});let fail=true,reads=0,pending:ReturnType<typeof deferred>|undefined;
 const api={request:async()=>{reads++;if(pending)return pending.promise;if(fail)throw new Error('Generated question read failure');return {items:[],nextCursor:null};}} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionLinks,{api,history:true})));
 assert.match(d.querySelector('[role="alert"]')!.textContent!,/Generated question read failure/);assert.equal(reads,1);
 pending=deferred();await act(async()=>button(d,'重试').click());assert.match(d.querySelector('[role="status"]')!.textContent!,/正在读取/);assert.equal(reads,2);
 await act(async()=>pending!.resolve({items:[],nextCursor:null}));pending=undefined;assert.match(d.querySelector('.owner-question-history')!.textContent!,/没有待回答的问题/);
 await act(async()=>t.mock.timers.tick(5000));assert.match(d.querySelector('[role="alert"]')!.textContent!,/Generated question read failure/);assert.equal(reads,3);
 fail=false;pending=deferred();await act(async()=>button(d,'重试').click());assert.equal(d.querySelector('.owner-question-history a'),null,'retrying a known empty page retains its filters without stale rows');assert.equal(reads,4);
 await act(async()=>pending!.resolve({items:[generated],nextCursor:null}));assert.ok(d.querySelector('.owner-question-history a'));assert.equal(d.querySelector('[role="alert"]'),null);
});
test('an empty question page with a next cursor keeps its pagination control during refresh',async t=>{
 const {root,d}=await fixture(t),reads:string[]=[];let pending:ReturnType<typeof deferred>|undefined;
 const api={request:async(path:string)=>{reads.push(path);if(pending)return pending.promise;return {items:[],nextCursor:'next'};}} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionLinks,{api,materialId:'generated-material'})));const next=button(d,'继续展开');assert.ok(next);
 pending=deferred();await act(async()=>resources(api).get(reads[0]).refresh());assert.equal(button(d,'继续展开'),next);assert.equal(d.querySelector('[role="status"]'),null);
 await act(async()=>pending!.resolve({items:[],nextCursor:'next'}));pending=undefined;
 await act(async()=>next.click());assert.equal(new URLSearchParams(reads.at(-1)!.split('?')[1]).get('cursor'),'next');assert.ok(button(d,'返回第一页'));
});
test('answered replies stay reachable from Material and Activity context without returning to the pending Ask queue',async t=>{
 const {root,d}=await fixture(t),reads:string[]=[],answered:OwnerQuestion={...generated,state:'answered',revision:2,continuationId:'memory:generated-continuation',messages:[...generated.messages,{role:'user',text:generated.choices[0].answer,createdAt:when}]};
 const api={request:async(path:string)=>{reads.push(path);if(!path.includes('?'))return answered;const states=new URLSearchParams(path.split('?')[1]).get('state')!.split(',');return {items:states.includes(answered.state)?[answered]:[],nextCursor:null};}} as Api;
 for(const scope of [{materialId:answered.materialId},{operationIds:[answered.operationId]}]){
  await act(async()=>root.render(React.createElement(OwnerQuestionLinks,{api,...scope})));
  const link=d.querySelector<HTMLAnchorElement>('a')!;assert.ok(link);assert.equal(link.getAttribute('href'),ownerQuestionRoute(answered.id));assert.match(link.textContent!,/已回答/);
 }
 await act(async()=>root.render(React.createElement(OwnerQuestionConversation,{api,id:answered.id,onOpen:()=>{}})));
 assert.match(d.querySelector('.owner-question-dialogue')!.textContent!,/这份资料里，讲述工作压力的是我/);assert.equal(d.querySelector('textarea'),null);
 await act(async()=>root.render(React.createElement(OwnerQuestionLinks,{api,history:true})));assert.equal(d.querySelector('a'),null);assert.equal(new URLSearchParams(reads.at(-1)!.split('?')[1]).get('state'),'open,deferred');
});
test('Activity contribution follows operation children across regrouped public work IDs',async t=>{
 const {root,d}=await fixture(t),reads:string[]=[];const api={request:async(path:string)=>{reads.push(path);return {items:[generated],nextCursor:null};}} as Api;
 const contribution=ownerQuestionPanels.find(panel=>panel.id==='owner-questions.work')!,value={kind:'mote.work.activity',schemaVersion:1,representation:'overview',ref:'regrouped-public-work',revision:when,title:'Generated aggregate',text:'',operationIds:['memory:generated-child','memory:generated-sibling']};
 await act(async()=>root.render(contribution.render({api,value,onOpen:()=>{}})));
 const query=new URLSearchParams(reads[0].split('?')[1]);assert.deepEqual(JSON.parse(query.get('operationIds')!),value.operationIds);assert.equal(query.get('workId'),null);assert.equal(d.querySelector('a')!.getAttribute('href'),ownerQuestionRoute(generated.id));
 await act(async()=>root.render(contribution.render({api,value:{...value,ref:'direct-generated-work',operationIds:[]},onOpen:()=>{}})));
 assert.equal(new URLSearchParams(reads.at(-1)!.split('?')[1]).get('workId'),'direct-generated-work');
});
test('Ask host shows waiting questions in existing history and routes back to an ordinary conversation',async t=>{
 const {root,d,w}=await fixture(t);await featuresReady;
 const ids=['http:GET:/api/owner-questions','http:GET:/api/owner-questions/:id','http:POST:/api/owner-questions/:id/reply'];
 const api={request:async(path:string)=>{
  if(path==='/api/features')return {schemaVersion:1,revision:1,features:[],capabilities:ids.map(id=>({id,version:'1',surface:'data',featureId:'mote.owner-questions',state:'active'}))};
  if(path.startsWith('/api/owner-questions?'))return {items:[generated],nextCursor:null};
  if(path.startsWith('/api/owner-questions/'))return generated;
  if(path==='/api/model-settings')return modelView();
  if(path==='/api/conversations?limit=30')return {items:[{id:'fixture-chat',title:'已有合成对话',createdAt:when,updatedAt:when,turnCount:1,scope:{},status:'completed'}]};
  if(path==='/api/conversations/fixture-chat')return {id:'fixture-chat',title:'已有合成对话',createdAt:when,updatedAt:when,turnCount:1,scope:{},status:'completed',revision:1,turns:[{id:'turn',question:'合成提问',scope:{},result:{answer:'合成回答',citations:[],trace:[],runId:'generated-run'},status:'completed',createdAt:when}]};
  if(path.startsWith('/api/operations/changes'))return new Promise(()=>{});
  return {items:[]};
 },setAgentTimeout:()=>{}} as Api;
 await act(async()=>{w.location.hash=ownerQuestionRoute(generated.id);});
 await act(async()=>root.render(React.createElement(Conversations,{api,configured:false,devices:[],renderAnswer:answer=>answer.answer})));
 assert.equal(d.querySelectorAll('.conversation-history').length,1);assert.equal(d.querySelector('.owner-question-conversation h2')?.textContent,generated.title);assert.equal(d.querySelector('.owner-question-history a')?.getAttribute('href'),ownerQuestionRoute(generated.id));
 await act(async()=>d.querySelector<HTMLButtonElement>('.conversation-list button.conversation-item')!.click());
 assert.equal(d.querySelector('.owner-question-conversation'),null);assert.match(d.querySelector('.conversation-messages')?.textContent??'',/合成回答/);assert.equal(readOwnerQuestion(w.location.hash),null);
 assert.ok(webFeatures.views('panel',{kind:'mote.ask.history',schemaVersion:1,representation:'workspace'}).some(entry=>entry.id==='owner-questions.history'));
});
test('owner question contributions dispose as one feature and match only explicit host contexts',async()=>{
 const host=new WebFeatureHost();
 try{const fiber=await host.install({id:'fixture.owner-questions',version:'1',components:[]},ownerQuestionPanels.map(entry=>({surface:'panel' as const,entry})));
  assert.equal(host.views('panel',{kind:'mote.ask.question',schemaVersion:1,representation:'workspace'}).length,1);
  assert.equal(host.views('panel',{kind:'mote.memory',schemaVersion:1,representation:'workspace'}).length,0);
  assert.equal(host.views('panel',{kind:'mote.ask.question',schemaVersion:2,representation:'workspace'}).length,0);
  await fiber.dispose();assert.equal(host.views('panel',{kind:'mote.ask.question',schemaVersion:1,representation:'workspace'}).length,0);
 }finally{await host.close();}
});
test('server capability removal closes the question view and capability fetch errors expose retry',async t=>{
 const {root,d}=await fixture(t);await featuresReady;let mode:'active'|'removed'|'error'='active',detailReads=0;
 const ids=['http:GET:/api/owner-questions/:id','http:POST:/api/owner-questions/:id/reply'];
 const api={request:async(path:string)=>{if(path==='/api/features'){if(mode==='error')throw new Error('Generated feature transport failure');return {schemaVersion:1,revision:1,features:[],capabilities:mode==='active'?ids.map(id=>({id,version:'1',surface:'data',featureId:'mote.owner-questions',state:'active'})):[]};}detailReads++;return generated;}} as Api;
 await act(async()=>root.render(React.createElement(FeaturePanels,{api,onOpen:()=>{},unavailable:React.createElement('p',{},'Generated capability unavailable'),value:{kind:'mote.ask.question',schemaVersion:1,representation:'workspace',ref:generated.id,revision:'1',title:'',text:''}})));
 assert.ok(d.querySelector('textarea'));const before=detailReads;
 mode='removed';await act(async()=>resources(api).get('/api/features').refresh());assert.equal(d.querySelector('textarea'),null);assert.match(d.body.textContent!,/Generated capability unavailable/);assert.equal(detailReads,before);
 mode='error';await act(async()=>resources(api).get('/api/features').refresh());assert.equal(d.querySelector('textarea'),null);assert.match(d.body.textContent!,/Generated feature transport failure/);assert.ok(button(d,'重试'));
 mode='active';await act(async()=>button(d,'重试').click());assert.ok(d.querySelector('textarea'));
});


test('final history filters retain the host scope and reset pending pagination before showing all record states',async t=>{
 const {root,d}=await fixture(t),reads:string[]=[];
 const completed={...generated,id:'00000000-0000-4000-8000-000000000002',title:'Generated answered source',state:'answered' as const},obsolete={...generated,id:'00000000-0000-4000-8000-000000000003',title:'',state:'obsolete' as const};
 const api={request:async(path:string)=>{reads.push(path);const q=new URLSearchParams(path.split('?')[1]);return {items:q.get('state')!.includes('obsolete')?[generated,completed,obsolete]:[generated],nextCursor:q.get('cursor')||q.get('state')!.includes('obsolete')?null:'pending-next'};}} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionLinks,{api,history:true,materialId:'generated-material'})));
 await act(async()=>button(d,'继续展开').click());assert.equal(new URLSearchParams(reads.at(-1)!.split('?')[1]).get('cursor'),'pending-next');
 await act(async()=>button(d,'全部记录').click());const all=new URLSearchParams(reads.at(-1)!.split('?')[1]);assert.equal(all.get('materialId'),'generated-material');assert.equal(all.get('cursor'),null);assert.deepEqual(all.get('state')!.split(','),['open','deferred','answered','closed','obsolete']);
 assert.equal(d.querySelectorAll('.owner-question-history a').length,3);assert.match(d.querySelector('.owner-question-history')!.textContent!,/已失效/);assert.equal(button(d,'全部记录').getAttribute('aria-pressed'),'true');
 await act(async()=>button(d,'待回答').click());assert.equal(new URLSearchParams(reads.at(-1)!.split('?')[1]).get('state'),'open,deferred');assert.equal(d.querySelectorAll('.owner-question-history a').length,1);
});

test('follow-up checks the exact original work before navigation and preserves the question on missing work',async t=>{
 const {root,d,w}=await fixture(t),reads:string[]=[];let missing=true;
 const answered={...generated,state:'answered' as const,revision:2,continuationId:'opaque-provider-continuation'};
 const api={request:async(path:string)=>{reads.push(path);if(path.startsWith('/api/work-activity/')){if(missing)throw new ApiError('Generated missing original work',404);return {id:answered.workId};}return answered;}} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionConversation,{api,id:answered.id,onOpen:()=>{}})));
 const originalHash=w.location.hash;await act(async()=>button(d,'查看后续处理').click());assert.equal(w.location.hash,originalHash);assert.match(d.body.textContent!,/后续活动暂不可读取/);assert.match(d.body.textContent!,/讲述工作压力/);assert.equal(d.querySelector<HTMLAnchorElement>('.owner-question-followup a')!.getAttribute('href'),'#/activity');
 assert.equal(reads.at(-1),'/api/work-activity/'+encodeURIComponent(answered.workId));assert.equal(reads.some(path=>path.includes(answered.continuationId)),false);
 missing=false;await act(async()=>d.querySelector<HTMLButtonElement>('.owner-question-followup button')!.click());assert.equal(new URLSearchParams(w.location.hash.split('?')[1]).get('work'),answered.workId);assert.equal(w.location.hash.split('?')[0],'#/activity');
});

test('late work lookups cannot navigate after the question revision changes',async t=>{
 const {root,d,w}=await fixture(t),read=deferred();let current={...generated,state:'answered' as const,revision:2},signal:AbortSignal|undefined;
 const api={request:async(path:string,init?:RequestInit)=>{if(path.startsWith('/api/work-activity/')){signal=init?.signal as AbortSignal;return read.promise;}return current;}} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionConversation,{api,id:generated.id,onOpen:()=>{}})));await act(async()=>button(d,'查看后续处理').click());
 const hash=w.location.hash;current={...current,state:'obsolete' as any,revision:3};await act(async()=>resources(api).get('/api/owner-questions/'+generated.id).refresh());assert.equal(signal?.aborted,true);assert.equal(d.querySelector('textarea'),null);assert.match(d.body.textContent!,/这个问题已失效/);
 await act(async()=>read.resolve({id:generated.workId}));assert.equal(w.location.hash,hash);assert.equal(d.querySelector('.owner-question-followup'),null);
});

test('supplemental replies use explicit form actions and initially folded evidence without chat-send controls',async t=>{
 const {root,d}=await fixture(t),api={request:async()=>generated} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionConversation,{api,id:generated.id,onOpen:()=>{}})));
 assert.equal(d.querySelector('details')?.open,false);assert.equal(d.querySelector('summary')?.textContent,'相关原文');assert.equal(d.querySelector('.owner-question-role')?.textContent,'Mote');assert.equal(d.querySelector('.ask-form,.send-button'),null);
 assert.ok(button(d,'回答并继续'));assert.ok(button(d,'稍后再说'));assert.ok(button(d,'我也不知道'));assert.equal(d.querySelector('textarea')!.maxLength,6000);
});


test('retired private question renders no empty fallback message',async t=>{
 const {root,d}=await fixture(t),api={request:async()=>({...generated,state:'obsolete',prompt:'',title:'',messages:[],evidence:[]})} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionConversation,{api,id:generated.id,onOpen:()=>{}})));
 assert.equal(d.querySelectorAll('.owner-question-message').length,0);assert.equal(d.querySelector('textarea'),null);assert.match(d.body.textContent!,/这个问题已失效/);
});


test('paging never sends a prior host cursor when work, material, operations or owner changes',async t=>{
 const {root,d}=await fixture(t),reads:{owner:string;query:URLSearchParams}[]=[];
 const makeApi=(owner:string)=>({request:async(path:string)=>{const query=new URLSearchParams(path.split('?')[1]);reads.push({owner,query});return {items:[generated],nextCursor:query.has('cursor')?null:'cursor-'+owner+'-'+reads.length};}} as Api);
 const first=makeApi('first'),second=makeApi('second');
 let props:{api:Api;workId?:string;materialId?:string;operationIds?:string[]}={api:first,workId:'work-a'};
 await act(async()=>root.render(React.createElement(OwnerQuestionLinks,props)));
 for(const next of [{api:first,workId:'work-b'},{api:first,materialId:'material-b'},{api:first,operationIds:['memory:operation-b']},{api:second,operationIds:['memory:operation-b']}]){
  await act(async()=>button(d,'继续展开').click());assert.ok(reads.at(-1)!.query.has('cursor'));
  const boundary=reads.length;props=next;await act(async()=>root.render(React.createElement(OwnerQuestionLinks,props)));
  assert.ok(reads.length>boundary);assert.ok(reads.slice(boundary).every(read=>!read.query.has('cursor')),'new host first reads must not carry the previous host cursor');
 }
});

test('a supplemental draft and unresolved reply identity survive leaving the question without entering another owner',async t=>{
 const {root,d}=await fixture(t),writes:any[]=[],api={request:async(_path:string,init?:RequestInit)=>{if(init?.method==='POST'){writes.push(JSON.parse(String(init.body)));throw new TypeError('Generated lost reply acknowledgement');}return structuredClone(generated);}} as Api;
 const view=(owner:Api)=>React.createElement(OwnerQuestionConversation,{api:owner,id:generated.id,onOpen:()=>{},standalone:true});
 await act(async()=>root.render(view(api)));await act(async()=>button(d,'我是讲述者').click());await act(async()=>send(d).click());assert.equal(writes.length,1);
 await act(async()=>root.render(null));await act(async()=>root.render(view(api)));assert.equal(d.querySelector('textarea')!.value,generated.choices[0].answer);assert.equal(button(d,'我是讲述者').getAttribute('aria-pressed'),'true');await act(async()=>send(d).click());assert.deepEqual(writes[1],writes[0],'remount retries exact UUID, choice and revision');
 const other={request:async()=>structuredClone(generated)} as Api;await act(async()=>root.render(view(other)));assert.equal(d.querySelector('textarea')!.value,'');assert.equal(button(d,'我是讲述者').getAttribute('aria-pressed'),'false');assert.equal(writes.length,2);
 await act(async()=>root.render(view(api)));assert.equal(d.querySelector('textarea')!.value,generated.choices[0].answer);
});

test('standalone Ask questions retain feature capability withdrawal and cannot acquire a replacement material title',async t=>{
 const {root,d,w}=await fixture(t);await featuresReady;const {Ask}=await import('../src/Ask');let enabled=true;
 const capabilities=['http:GET:/api/owner-questions','http:GET:/api/owner-questions/:id','http:POST:/api/owner-questions/:id/reply'];
 const api={request:async(path:string)=>{if(path==='/api/features')return {schemaVersion:1,revision:1,features:[],capabilities:enabled?capabilities.map(id=>({id,version:'1',surface:'data',featureId:'mote.owner-questions',state:'active'})):[]};if(path.startsWith('/api/materials/'))return {material:{ref:'material:replacement@new',title:'Generated replacement title'}};if(path.startsWith('/api/owner-questions?'))return {items:[generated],nextCursor:null};return generated;}} as Api;
 w.history.replaceState(null,'','#/ask?question='+generated.id);await act(async()=>root.render(React.createElement(Ask,{api,status:{agent:{configured:false}} as any,devices:[],onOpen:()=>{},onInsights:()=>{},onSettings:()=>{}})));assert.ok(d.querySelector('.owner-question-workspace h1'));assert.equal(d.querySelector('.conversation-toolbar'),null);assert.equal(d.querySelector('.model-notice'),null);assert.doesNotMatch(d.body.textContent!,/Generated replacement title/);
 enabled=false;await act(async()=>resources(api).get('/api/features').refresh());assert.equal(d.querySelector('.owner-question-form'),null);assert.match(d.body.textContent!,/专用视图暂不可用/);
});

test('a Home supplemental-question visit returns to that Home before a later guide visit gets its own return',async t=>{
 const {root,d,w}=await fixture(t),{OwnerQuestionWorkspace}=await import('../src/OwnerQuestions'),{openOwnerQuestionList}=await import('../src/owner-question-route'),{guideVisit}=await import('../src/feature-guide-state');const api={request:async()=>({items:[],nextCursor:null})} as Api;
 guideVisit(api).returnAvailable=true;w.history.replaceState(null,'','#/today');openOwnerQuestionList(api);await act(async()=>root.render(React.createElement(OwnerQuestionWorkspace,{api,id:'',onOpen:()=>{}})));assert.equal(d.querySelector('.owner-question-workspace-header a')!.getAttribute('href'),'#/today','an old guide visit cannot steal a new Home return');
 await act(async()=>{w.history.replaceState(null,'','#/guide');root.render(null);});await act(async()=>{w.history.replaceState(null,'','#/ask?question=');root.render(React.createElement(OwnerQuestionWorkspace,{api,id:'',onOpen:()=>{}}));});assert.equal(d.querySelector('.owner-question-workspace-header a')!.getAttribute('href'),'#/guide');
});

test('question A then B returns consume their own scroll ticket once and later list polling never jumps back',async t=>{
 const {root,d,w}=await fixture(t),{OwnerQuestionWorkspace}=await import('../src/OwnerQuestions');const other={...generated,id:'00000000-0000-4000-8000-000000000002',title:'Generated question B'},scrolls:number[]=[];
 Object.defineProperty(w,'scrollY',{value:0,configurable:true,writable:true});w.scrollTo=(_x:any,y?:number)=>scrolls.push(y??0);
 const api={request:async(path:string)=>path.startsWith('/api/owner-questions?')?{items:[generated,other],nextCursor:null}:path.includes(other.id)?other:generated}as Api;
 const view=(id='')=>React.createElement(OwnerQuestionWorkspace,{api,id,onOpen:()=>{}}),list=ownerQuestionRoute();
 const trip=async(question:OwnerQuestion,y:number)=>{w.history.replaceState(null,'',list);await act(async()=>root.render(view()));(w as any).scrollY=y;await act(async()=>{const link=[...d.querySelectorAll<HTMLAnchorElement>('.owner-question-history a')].find(link=>link.getAttribute('href')===ownerQuestionRoute(question.id))!;link.focus();link.click();w.history.replaceState(null,'',ownerQuestionRoute(question.id));root.render(view(question.id));});await act(async()=>{d.querySelector<HTMLAnchorElement>('.owner-question-workspace-header a')!.click();w.history.replaceState(null,'',list);root.render(view());});await act(async()=>new Promise(resolve=>setTimeout(resolve,25)));assert.equal(scrolls.at(-1),y);assert.equal((d.activeElement as HTMLAnchorElement).getAttribute('href'),ownerQuestionRoute(question.id));};
 await trip(generated,100);await trip(other,500);const count=scrolls.length;(w as any).scrollY=700;await act(async()=>resources(api).get(ownerQuestionListPath({},undefined,'open,deferred')).refresh());await act(async()=>new Promise(resolve=>setTimeout(resolve,25)));assert.equal(scrolls.length,count,'a fresh poll cannot replay an already consumed return ticket');
});

test('foreground shared question lists discover a remote question once after hidden 60s and keep the 5s fallback',async t=>{
 const {root,d}=await fixture(t),clock=questionClock(t,d),reads:string[]=[];let items:OwnerQuestion[]=[];
 const api={request:async(path:string)=>{reads.push(path);return {items,nextCursor:null};}} as Api;
 await act(async()=>root.render(React.createElement(React.Fragment,null,...[1,2].map(key=>React.createElement(OwnerQuestionLinks,{key,api,history:true,materialId:'generated-material'})))));
 assert.equal(reads.length,1);assert.equal(d.querySelectorAll('.owner-question-history a').length,0);
 await clock.visibility(true);items=[generated];await clock.tick(60000);assert.equal(reads.length,1,'hidden timers do not read lists');
 await clock.visibility(false);await clock.visibility(false);await clock.tick();assert.equal(reads.length,2,'both observers share one foreground read');assert.equal(d.querySelectorAll('.owner-question-history a').length,2);
 await clock.tick(4999);assert.equal(reads.length,2);await clock.tick(1);assert.equal(reads.length,3,'visible empty/open lists retain 5s safety reads');
 assert.ok(reads.every(path=>path===ownerQuestionListPath({materialId:'generated-material'})));
});

test('foreground terminal question recheck observes remote obsolescence and retains 3s polling',async t=>{
 const {root,d}=await fixture(t),clock=questionClock(t,d),reads:string[]=[];let current:OwnerQuestion={...generated,state:'closed',revision:2};
 const api={request:async(path:string)=>{reads.push(path);return current;}} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionConversation,{api,id:generated.id,onOpen:()=>{}})));assert.ok(button(d,'我有新信息了'));
 await clock.visibility(true);await clock.tick(60000);assert.equal(reads.length,1);current={...current,state:'obsolete',revision:3};
 await clock.visibility(false);await clock.tick();assert.equal(reads.length,2);assert.match(d.body.textContent!,/这个问题已失效/);assert.equal(Boolean(button(d,'我有新信息了')),false);assert.equal(Boolean(d.querySelector('textarea')),false);
 await clock.tick(2999);assert.equal(reads.length,2);await clock.tick(1);assert.equal(reads.length,3,'terminal questions still discover remote state changes');
});

for(const status of [401,403,404])test('foreground question '+status+' clears references and remembered draft before authorized recovery',async t=>{
 const {root,d,w}=await fixture(t),clock=questionClock(t,d);let denied=false;
 const api={request:async()=>{if(denied)throw new ApiError('Generated revoked question',status);return generated;}} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionConversation,{api,id:generated.id,onOpen:()=>{}})));
 await act(async()=>button(d,'我是讲述者').click());await type(d,w,'Generated private draft');assert.match(d.body.textContent!,/说话人1/);
 await clock.visibility(true);denied=true;await clock.visibility(false);await clock.tick();assert.match(d.body.textContent!,/Generated revoked question/);assert.doesNotMatch(d.body.textContent!,/说话人1/);assert.equal(Boolean(d.querySelector('textarea')),false);assert.equal(Boolean(button(d,'查看原始记录')),false);
 await clock.visibility(true);denied=false;await clock.visibility(false);await clock.tick();assert.equal(d.querySelector('textarea')!.value,'');assert.equal(send(d).disabled,true);assert.equal(button(d,'我是讲述者').getAttribute('aria-pressed'),'false');
});

test('foreground hints coalesce behind a shared held question read without aborting or starving it',async t=>{
 const {root,d}=await fixture(t),clock=questionClock(t,d),pending=deferred(),reads:{path:string;signal?:AbortSignal|null}[]=[];let held=false;
 const api={request:async(path:string,init?:RequestInit)=>{reads.push({path,signal:init?.signal});return held?pending.promise:{items:[],nextCursor:null};}} as Api;
 await act(async()=>root.render(React.createElement(React.Fragment,null,...[1,2].map(key=>React.createElement(OwnerQuestionLinks,{key,api,history:true})))));
 held=true;await clock.tick(5000);assert.equal(reads.length,2);await clock.visibility(true);await clock.tick(60000);await clock.visibility(false);await clock.visibility(false);assert.equal(reads.length,2);assert.equal(reads[1].signal?.aborted,false);
 held=false;await act(async()=>pending.resolve({items:[generated],nextCursor:null}));await clock.tick();assert.equal(reads.length,3,'one fresh follow-up for the shared exact key');
});

test('foreground question paging refreshes only the current exact host and cursor key',async t=>{
 const {root,d}=await fixture(t),clock=questionClock(t,d),reads:string[]=[];
 const api={request:async(path:string)=>{reads.push(path);return {items:[generated],nextCursor:path.includes('cursor=')?null:'generated-next'};}} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionLinks,{api,history:true,workId:'generated-work',materialId:'generated-material'})));
 await act(async()=>button(d,'继续展开').click());const current=reads.at(-1)!;assert.equal(new URLSearchParams(current.split('?')[1]).get('cursor'),'generated-next');
 await clock.visibility(true);const before=reads.length;await clock.visibility(false);await clock.tick();assert.deepEqual(reads.slice(before),[current]);assert.equal(new URLSearchParams(current.split('?')[1]).get('workId'),'generated-work');
});

test('foreground old-Api question responses and queued refreshes cannot replace the new owner',async t=>{
 const {root,d}=await fixture(t),clock=questionClock(t,d),pending=deferred();let held=false,oldReads=0,signal:AbortSignal|undefined;
 const first={request:async(_path:string,init?:RequestInit)=>{oldReads++;signal=init?.signal as AbortSignal;return held?pending.promise:generated;}} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionConversation,{api:first,id:generated.id,onOpen:()=>{}})));
 held=true;await clock.tick(3000);await clock.visibility(true);await clock.visibility(false);const oldSignal=signal;
 const other={...generated,title:'Generated new owner question'},second={request:async()=>other} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionConversation,{api:second,id:generated.id,onOpen:()=>{}})));assert.equal(oldSignal?.aborted,true);
 await act(async()=>pending.resolve({...generated,title:'LATE OLD QUESTION'}));await clock.tick(60000);assert.equal(oldReads,2);assert.match(d.body.textContent!,/Generated new owner question/);assert.doesNotMatch(d.body.textContent!,/LATE OLD QUESTION/);assert.equal(d.querySelector('textarea')!.value,'');
});

test('foreground checked questions retain literal draft and request identity when the reply provider refuses',async t=>{
 const {root,d,w}=await fixture(t),clock=questionClock(t,d),writes:any[]=[];let gets=0;
 const api={request:async(_path:string,init?:RequestInit)=>{if(init?.method==='POST'){writes.push(JSON.parse(String(init.body)));throw new ApiError('Generated provider unavailable',503);}gets++;return generated;}} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionConversation,{api,id:generated.id,onOpen:()=>{}})));
 await clock.visibility(true);await clock.visibility(false);await clock.tick();assert.equal(gets,2);await type(d,w,'Generated literal reply');
 await act(async()=>send(d).click());assert.match(d.body.textContent!,/Generated provider unavailable/);assert.equal(d.querySelector('textarea')!.value,'Generated literal reply');assert.doesNotMatch(d.body.textContent!,/回答已记录/);
 await act(async()=>send(d).click());assert.equal(writes.length,2);assert.equal(writes[0].requestId,writes[1].requestId);assert.equal(writes[0].answer,'Generated literal reply');
});

test('foreground question list 503 stays visibly incomplete and a later foreground recovers',async t=>{
 const {root,d}=await fixture(t),clock=questionClock(t,d);let failed=false,items:OwnerQuestion[]=[];
 const api={request:async()=>{if(failed)throw new ApiError('Generated list unavailable',503);return {items,nextCursor:null};}} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionLinks,{api,history:true})));await clock.visibility(true);failed=true;await clock.visibility(false);await clock.tick();
 assert.match(d.querySelector('[role=alert]')!.textContent!,/Generated list unavailable/);assert.doesNotMatch(d.body.textContent!,/没有待回答的问题/);
 await clock.visibility(true);failed=false;items=[generated];await clock.visibility(false);await clock.tick();assert.equal(Boolean(d.querySelector('[role=alert]')),false);assert.equal(d.querySelector('a')!.getAttribute('href'),ownerQuestionRoute(generated.id));
});

test('a late provider ACK cannot restore question references after foreground authorization denial',async t=>{
 const {root,d}=await fixture(t),clock=questionClock(t,d),reply=deferred(),recheck=deferred();let mode:'authorized'|'denied'|'held'='authorized',replySignal:AbortSignal|undefined;
 const api={request:async(_path:string,init?:RequestInit)=>{if(init?.method==='POST'){replySignal=init.signal as AbortSignal;return reply.promise;}if(mode==='denied')throw new ApiError('Generated revoked question',403);return mode==='held'?recheck.promise:generated;}} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionConversation,{api,id:generated.id,onOpen:()=>{}})));await act(async()=>button(d,'我是讲述者').click());await act(async()=>send(d).click());
 await clock.visibility(true);mode='denied';await clock.visibility(false);await clock.tick();assert.doesNotMatch(d.body.textContent!,/说话人1/);
 mode='held';await act(async()=>reply.resolve({...generated,state:'answered',revision:2,outcome:'LATE REVOKED ACK'}));
 await clock.visibility(true);await clock.visibility(false);await clock.tick();assert.doesNotMatch(d.body.textContent!,/说话人1|LATE REVOKED ACK/,'clearing the read error while rechecking must not expose a late accepted copy');assert.equal(Boolean(d.querySelector('textarea')),false);assert.equal(replySignal?.aborted,true);
 await act(async()=>recheck.resolve({...generated,revision:3}));assert.equal(d.querySelector('textarea')!.value,'');assert.equal(send(d).disabled,true);
});
