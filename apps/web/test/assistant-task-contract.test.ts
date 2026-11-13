import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {configureLocale} from '@mote/shared/i18n';
import {buildApp} from '../../server/src/app';
import type {Config} from '../../server/src/config';
import {AssistantDraftActions} from '../src/plugins/ask/AssistantDraftActions';
import {AnswerView} from '../src/shell-components';
import type {Api} from '../src/api';
import {assistantQuestionFixture} from '../../server/test/fixtures/assistant-owner-question';
import {AssistantTaskResults} from '../src/plugins/ask/AssistantTaskResults';
import {OwnerQuestionConversation} from '../src/plugins/memory/OwnerQuestions';
import {featuresReady} from '../src/features/bootstrap';
import {ownerQuestionRoute} from '../src/owner-question-route';

configureLocale(()=> 'zh-CN');
const token='generated-task-web-contract',headers={authorization:'Bearer '+token};
async function until(check:()=>boolean){const end=Date.now()+10000;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Timed out waiting for generated task');}

test('the actual server task response is rendered by the conversation result component',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-task-web-contract-')),evidenceId=randomUUID();
 const config:Config={dataDir:directory,dataKey:'32'.repeat(32),contentEncryptionEnabled:true,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,
  retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelBaseUrl:'https://generated.invalid',apiKey:'generated-only',allowUnauthenticatedLocal:false,
  embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent'};
 const query=async(input:QueryInput)=>({answer:input.executionLane==='background'?'Generated persisted task result':'Generated initial answer',
  citations:input.executionLane==='background'?[{id:evidenceId,capturedAt:'2026-10-01T00:00:00Z',appName:'Generated source',excerpt:'Generated original content'}]:[],
  trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[...(input.contextEvidenceDependencies?.ids??[])]},
  ...(input.assistantDraft?{draftProposal:{goal:'Generated follow-up task'}}:{})} as QueryResult);
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,query,close:async()=>{}}});
 // A controlled in-process fake is used only for this producer/consumer
 // contract; the assembled production budget guard is verified separately.
 (node.batchProcessing as unknown as {modelAdmission:()=>undefined}).modelAdmission=()=>undefined;
 await node.app.ready();t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const created=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id:evidenceId,deviceId:'generated-device',deviceName:'Generated',platform:'android',capturedAt:'2026-10-01T00:00:00Z',text:'Generated original content'}});assert.equal(created.statusCode,201,created.body);
 const initial=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated question'}});assert.equal(initial.statusCode,200,initial.body);const turn=initial.json();assert.ok(turn.draft.capabilities.includes('assistant.task.start'));
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/ask'}),prior=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){
  prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 }
 const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,value] of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
 const api={request:async(path:string,options?:RequestInit)=>{
  const response=await node.app.inject({method:(options?.method??'GET') as 'GET'|'POST',url:path,headers,...(options?.body?{payload:JSON.parse(String(options.body))}:{})});
  assert.equal(response.statusCode,200,response.body);const value=response.json();
  if(options?.method==='POST'&&path==='/api/assistant/commands')await until(()=>node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(value.taskId)?.state==='succeeded');
  return value;
 }} as Api;
 const opened:string[]=[];
 await act(async()=>root.render(React.createElement(AssistantDraftActions,{api,conversationId:turn.conversationId,turnId:turn.turnId,draft:turn.draft,onOpen:ref=>opened.push(ref),renderAnswer:(answer,open)=>React.createElement(AnswerView,{answer,onOpen:open,compact:true})})));
 await act(async()=>{dom.window.document.querySelector<HTMLButtonElement>('.assistant-draft-actions .primary')!.click();
  await until(()=>Boolean(node.store.db.prepare("SELECT 1 FROM task_records WHERE kind='assistant.task' AND state='succeeded'").get()));});
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
 assert.match(dom.window.document.body.textContent!,/Generated follow-up task/);assert.match(dom.window.document.body.textContent!,/Generated persisted task result/);
 assert.match(dom.window.document.body.textContent!,/Generated original content/);assert.match(dom.window.document.body.textContent!,/已完成/);
 await act(async()=>dom.window.document.querySelector<HTMLButtonElement>('.citation')!.click());assert.deepEqual(opened,['capture:'+evidenceId]);
});

test('the actual assistant question projection reaches the existing inbox and reply UI',async t=>{
 const f=await assistantQuestionFixture(t),taskId=await f.start(),question=await f.question();await featuresReady;
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/ask'}),prior=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){
  prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 }
 const root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,value] of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
 const api={request:async(path:string,options?:RequestInit)=>{
  const response=await f.api(options?.method==='POST'?'POST':'GET',path,options?.body?JSON.parse(String(options.body)):undefined);
  assert.equal(response.statusCode,200,response.body);return response.json();
 }} as Api;
 await act(async()=>root.render(React.createElement(AssistantTaskResults,{api,conversationId:f.command.conversationId,turnId:f.command.turnId,scope:f.command.scope,
  refresh:0,onFound:()=>{},onOpen:()=>{},renderAnswer:()=>null})));
 const link=dom.window.document.querySelector<HTMLAnchorElement>('.owner-question-links a');assert.ok(link);assert.equal(link.getAttribute('href'),ownerQuestionRoute(question.id));
 await act(async()=>root.render(React.createElement(OwnerQuestionConversation,{api,id:question.id,onOpen:()=>{}})));
 const d=dom.window.document;assert.match(d.body.textContent!,/资料范围和行动授权保持不变/);
 await act(async()=>Array.from(d.querySelectorAll('button')).find(button=>button.textContent==='Generated first option')!.click());
 await act(async()=>{d.querySelector<HTMLButtonElement>('button[aria-label="回答并继续"]')!.click();
  await until(()=>f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(taskId)?.state==='succeeded');});
 assert.match(d.body.textContent!,/回答已记录/);assert.doesNotMatch(d.body.textContent!,/成果审核完成后才会保存/);
 assert.equal((await f.read(taskId)).result.answer,'Generated continued task result');
});
