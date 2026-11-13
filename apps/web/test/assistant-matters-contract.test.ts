import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {randomUUID} from 'node:crypto';
import {configureLocale} from '@mote/shared/i18n';
import {ApiError,type Api} from '../src/api';
import {AssistantMatters} from '../src/plugins/assistant/AssistantMatters';
import {CommitmentDetail} from '../src/plugins/assistant/CommitmentDetail';
import {RoutineDetail} from '../src/plugins/assistant/RoutineDetail';
import {MatterDetail} from '../src/plugins/assistant/MatterDetail';
import {OwnerQuestionWorkspace} from '../src/plugins/memory/OwnerQuestions';
import {assistantQuestionFixture} from '../../server/test/fixtures/assistant-owner-question';
import {AssistantCommitments} from '../../server/src/assistant-commitments';

test('real serialized matters, commitments, rules and task questions reach the Web detail and return to their matter',async t=>{
 configureLocale(()=> 'zh-CN');const f=await assistantQuestionFixture(t),taskId=await f.start(),scope=f.command.scope;
 const question=await f.question().catch(async error=>{t.diagnostic(JSON.stringify({task:await f.read(taskId),steps:f.node.store.db.prepare('SELECT kind,state,error FROM execution_steps').all(),providerRequests:f.requests.length}));throw error;});
 const created=await f.api('POST','/api/assistant/matter-commands',{type:'create',requestId:randomUUID(),goal:'Generated shared meeting matter',scope,taskIds:[taskId],evidenceIds:[f.evidenceId]});
 assert.equal(created.statusCode,200,created.body);const matter=created.json(),commitmentId=randomUUID();
 const rule=await f.api('POST','/api/assistant/routines',{requestId:randomUUID(),goal:'Generated meeting review rule',scope,timeZone:'Asia/Shanghai',trigger:{kind:'daily',localTime:'09:15'},matterId:matter.id});
 assert.equal(rule.statusCode,200,rule.body);
 const original=f.node.store.evidence([f.evidenceId])[0].ocrText;
 new AssistantCommitments(f.node.store,f.node.featureServices.evidenceReader).publish({commitmentId,eventId:randomUUID(),kind:'commitment',occurredAt:null,summary:'Generated commitment from the same meeting evidence',
  changes:{title:'Generated meeting follow-up promise',status:'confirmed',deadline:{text:'after the generated review',at:null},matterId:matter.id},
  evidence:[{id:f.evidenceId,quote:original,offset:0}],evidenceDependencies:{version:1,complete:true,ids:[f.evidenceId]}},undefined,scope,()=>{});
 const matterHash='#/assistant/matters?matter='+matter.id,dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'+matterHash,pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 Object.assign(dom.window.HTMLElement.prototype,{attachEvent:()=>{},detachEvent:()=>{},scrollIntoView:()=>{}});dom.window.scrollTo=()=>{};
 const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of prior)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);dom.window.close();});
 const reads:string[]=[];
 const api={request:async(path:string,init?:RequestInit)=>{reads.push(path);const response=await f.api((init?.method??'GET') as 'GET'|'POST',path,init?.body?JSON.parse(String(init.body)):undefined);
  if(response.statusCode>=400)throw new ApiError(response.json().message??'Generated response failure',response.statusCode);return response.json();}} as Api;
 const d=dom.window.document;
 const render=async(element:React.ReactNode,ready:()=>boolean)=>{
  await act(async()=>root.render(element));const end=Date.now()+10000;
  while(!ready()&&Date.now()<end)await act(async()=>{await new Promise(resolve=>setImmediate(resolve));});
  assert.ok(ready(),'the actual response reaches its mounted consumer');
 };
 await render(React.createElement(AssistantMatters,{api,onOpen:()=>{}}),()=>Boolean(d.querySelector('.owner-question-links a'))&&d.body.textContent!.includes('Generated meeting review rule')&&d.body.textContent!.includes('Generated meeting follow-up promise'));
 assert.match(d.body.textContent!,/Generated shared meeting matter/);assert.match(d.body.textContent!,/Generated meeting follow-up promise/);assert.match(d.body.textContent!,/Generated meeting review rule/);
 const link=d.querySelector<HTMLAnchorElement>('.owner-question-links a')!;assert.ok(link);assert.equal(new URLSearchParams(link.hash.split('?')[1]).get('question'),question.id);
 await act(async()=>link.click());await render(React.createElement(OwnerQuestionWorkspace,{api,id:question.id,onOpen:()=>{}}),()=>Boolean(d.querySelector('.owner-question-workspace-header a')));
 assert.equal(d.querySelector<HTMLAnchorElement>('.owner-question-workspace-header a')!.getAttribute('href'),matterHash,'the existing question workspace remembers the exact matter origin');
 await render(React.createElement(CommitmentDetail,{api,id:commitmentId,scope,onOpen:()=>{}}),()=>Boolean(d.querySelector('.assistant-commitment-detail')));assert.match(d.body.textContent!,/期限 · 未知/);assert.match(d.body.textContent!,/Generated commitment from the same meeting evidence/);
 const commitmentBack=new URLSearchParams(d.querySelector<HTMLAnchorElement>('a')!.hash.split('?')[1]);assert.equal(commitmentBack.get('matter'),matter.id);assert.deepEqual(JSON.parse(commitmentBack.get('scope')!),scope);
 await render(React.createElement(RoutineDetail,{api,id:rule.json().id,scope}),()=>Boolean(d.querySelector('.assistant-routine-detail')));assert.match(d.body.textContent!,/09:15/);assert.match(d.body.textContent!,/Asia\/Shanghai/);assert.match(d.body.textContent!,/规则已启用/);
 const removed=await f.api('DELETE','/api/notes/'+f.evidenceId);assert.equal(removed.statusCode,200,removed.body);
 await render(React.createElement(MatterDetail,{api,id:matter.id,scope,onOpen:()=>assert.fail('withdrawn evidence must not open')}),()=>d.body.textContent!.includes('部分关联资料已不可用')&&d.body.textContent!.includes('已失效'));
 assert.doesNotMatch(d.body.textContent!,/Generated meeting follow-up promise|Generated commitment from the same meeting evidence/);assert.equal(d.querySelector('.owner-question-links a'),null);
 assert.ok(reads.some(path=>path.startsWith('/api/assistant/matters/'+matter.id+'?')));assert.ok(reads.some(path=>path.startsWith('/api/assistant/tasks/'+taskId+'?')));assert.ok(reads.some(path=>path.startsWith('/api/assistant/commitments/'+commitmentId+'?')));
});
