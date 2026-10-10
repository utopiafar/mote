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
import {featuresReady,webFeatures,FeaturePanels} from '../src/features/runtime.js';
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
 assert.equal(d.querySelector('details')?.open,true);await act(async()=>button(d,'查看原始记录').click());assert.equal(opens[0],generated.evidence[0].ref);
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
 await act(async()=>button(d,'我也不知道，结束这次追问').click());assert.equal(writes[1].action,'unknown');assert.equal(writes[1].expectedRevision,2);assert.equal(d.querySelector('textarea'),null);assert.match(d.body.textContent!,/本次不再追问/);
 await act(async()=>button(d,'我有新信息了').click());assert.ok(d.querySelector('textarea'));assert.equal(writes.length,2);
 await act(async()=>button(d,'我是讲述者').click());await act(async()=>send(d).click());assert.equal(writes[2].expectedRevision,3);assert.equal(writes[2].action,'answer');assert.equal(d.querySelector('textarea'),null);
});
test('an ambiguous transport failure reuses the same admission UUID; stale revisions refresh instead',async t=>{
 const {root,d}=await fixture(t),writes:any[]=[];let current=structuredClone(generated),failure:unknown=new Error('Generated transport failure');
 const api={request:async(_path:string,init?:RequestInit)=>{if(init?.method==='POST'){writes.push(JSON.parse(String(init.body)));throw failure;}return current;}} as Api;
 await act(async()=>root.render(React.createElement(OwnerQuestionConversation,{api,id:generated.id,onOpen:()=>{}})));
 await act(async()=>button(d,'我是讲述者').click());await act(async()=>send(d).click());await act(async()=>send(d).click());assert.equal(writes[0].requestId,writes[1].requestId);
 failure=new ApiError('Generated stale version',409);current={...current,revision:2,prompt:'更新后的合成问题',messages:[{role:'assistant',text:'更新后的合成问题',createdAt:when}]};await act(async()=>send(d).click());assert.match(d.body.textContent!,/这个问题已更新/);assert.match(d.body.textContent!,/更新后的合成问题/);
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
test('answered replies stay reachable from Material and Activity context without returning to the pending Ask queue',async t=>{
 const {root,d}=await fixture(t),reads:string[]=[],answered:OwnerQuestion={...generated,state:'answered',revision:2,continuationId:'memory:generated-continuation',messages:[...generated.messages,{role:'user',text:generated.choices[0].answer,createdAt:when}]};
 const api={request:async(path:string)=>{reads.push(path);if(!path.includes('?'))return answered;const states=new URLSearchParams(path.split('?')[1]).get('state')!.split(',');return {items:states.includes(answered.state)?[answered]:[],nextCursor:null};}} as Api;
 for(const scope of [{materialId:answered.materialId},{operationIds:[answered.operationId]}]){
  await act(async()=>root.render(React.createElement(OwnerQuestionLinks,{api,...scope})));
  const link=d.querySelector<HTMLAnchorElement>('a')!;assert.ok(link);assert.equal(link.getAttribute('href'),ownerQuestionRoute(answered.id));assert.match(link.textContent!,/已回答/);
 }
 await act(async()=>root.render(React.createElement(OwnerQuestionConversation,{api,id:answered.id,onOpen:()=>{}})));
 assert.match(d.querySelector('.conversation-messages')!.textContent!,/这份资料里，讲述工作压力的是我/);assert.equal(d.querySelector('textarea'),null);
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
  if(path==='/api/conversations/fixture-chat')return {id:'fixture-chat',title:'已有合成对话',turns:[{id:'turn',question:'合成提问',result:{answer:'合成回答'},status:'completed',createdAt:when}]};
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
