import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {buildApp} from '../../server/src/app.js';
import {ApiError,type Api} from '../src/api.js';
import {AnswerView} from '../src/shell-components.js';
import {Conversations} from '../src/plugins/ask/Conversations.js';
import {AskController,createAskController} from '../src/plugins/ask/controller.js';

configureLocale(()=> 'zh-CN');
const when='2026-11-04T04:00:00.000Z';

async function fixture(t:import('node:test').TestContext,options:{
  readonly agentQuery?:import('../../server/src/app.js').QueryAgent['query'];
}={}){
  const directory=mkdtempSync(join(tmpdir(),'mote-plugin-ask-contract-')),token='generated-plugin-ask-'+randomUUID();
  const node=await buildApp({
    dataDir:join(directory,'data'),token,tokenPath:'generated',host:'127.0.0.1',port:0,
    maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,
    allowedOrigins:[],model:options.agentQuery?'generated-model':'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,
    embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',
  },{
    backgroundWorker:false,
    agent:options.agentQuery?{configured:true,query:options.agentQuery,close:async()=>{}}:{configured:false,query:async()=>{throw Error('No model in generated Ask contract fixture');},close:async()=>{}},
  });
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
  return {node,token};
}

function apiFor(node:Awaited<ReturnType<typeof buildApp>>,token:string,log:(path:string,init:RequestInit)=>void=()=>{}){
  const request=async <T>(path:string,init:RequestInit={}):Promise<T>=>{
    log(path,init);
    if(init.signal?.aborted)throw new DOMException('Aborted','AbortError');
    const method=(init.method??'GET').toUpperCase(),headers=new Headers(init.headers);
    headers.set('authorization','Bearer '+token);
    if(typeof init.body==='string'&&!headers.has('content-type'))headers.set('content-type','application/json');
    const response=await node.app.inject({
      method:method as 'GET'|'POST'|'PUT'|'PATCH'|'DELETE',url:path,headers:Object.fromEntries(headers),
      ...(typeof init.body==='string'?{payload:init.body}:{}),
    });
    if(init.signal?.aborted)throw new DOMException('Aborted','AbortError');
    if(response.statusCode>=400)throw new ApiError(response.body||`HTTP ${response.statusCode}`,response.statusCode);
    return (response.body?JSON.parse(response.body):undefined) as T;
  };
  return {api:{request,setAgentTimeout:()=>{}} as Api};
}

const until=async(check:()=>boolean,label:string,timeout=5000)=>{
  const end=Date.now()+timeout;
  while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}
  throw Error('Generated Ask did not settle: '+label);
};

async function render(t:import('node:test').TestContext,api:Api,controller?:AskController){
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/ask',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>(),opened:string[]=[];
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){
    prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  Object.assign(dom.window.HTMLElement.prototype,{scrollIntoView:()=>{}});
  const root=createRoot(dom.window.document.querySelector('#root')!),d=dom.window.document;
  t.after(async()=>{
    await act(async()=>root.unmount());
    controller?.dispose();
    for(const[key,descriptor]of prior){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
    dom.window.close();
  });
  await act(async()=>root.render(React.createElement(Conversations,{
    api,configured:true,devices:[],controller,
    onOpen:(ref:string)=>opened.push(ref),
    renderAnswer:(answer,open)=>React.createElement(AnswerView,{answer,onOpen:open,compact:true}),
  })));
  return {d,root,opened};
}

const capture=(id:string)=>({id,deviceId:'generated-ask-device',deviceName:'Generated Ask device',platform:'import' as const,source:'note' as const,capturedAt:when,durationMs:0,ocrText:'Generated Ask citation source.',windowTitle:'Generated Ask citation source.'});

test('a real query run enters the Ask plugin with progress, its final answer and an exact citation reader',async t=>{
  let release!:()=>void,started!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve),running=new Promise<void>(resolve=>started=resolve),citation=randomUUID();
  let answerRunId='';
  const {node,token}=await fixture(t,{agentQuery:async input=>{
    input.onProgress?.({stage:'tool',tool:'search_context',phase:'started'});
    started();await gate;
    input.onProgress?.({stage:'tool',tool:'search_context',phase:'completed',count:1});
    answerRunId=randomUUID();
    return {answer:'Generated plugin answer ['+citation+']',citations:[{id:citation,capturedAt:when,appName:'Generated Ask source',excerpt:'Generated Ask citation source.'}],trace:[{tool:'search_context',arguments:{query:'generated'},count:1}],runId:answerRunId,evidenceDependencies:{version:1,complete:true,ids:[citation]}};
  }});
  await node.store.ingest(capture(citation));
  const {api}=apiFor(node,token),runId=randomUUID();
  const accepted=await node.app.inject({method:'POST',url:'/api/query-runs',headers:{authorization:'Bearer '+token},payload:{id:runId,input:{question:'Generated plugin question',timeZone:'UTC'}}});
  assert.equal(accepted.statusCode,202,accepted.body);
  await running;
  const controller=createAskController({api,intervalMs:10,retryMs:10});
  controller.start();
  const {d,opened}=await render(t,api,controller);
  await until(()=>d.body.textContent?.includes('正在回答')===true,'running progress');
  assert.ok(d.querySelector('.query-progress-compact'),'the plugin renders the real run progress');
  release();
  await until(()=>d.body.textContent?.includes('Generated plugin answer')===true,'final answer');
  const conversation=(await node.app.inject({url:'/api/conversations',headers:{authorization:'Bearer '+token}})).json().items[0];
  assert.ok(conversation,'the terminal run created its conversation');
  const detail=(await node.app.inject({url:'/api/conversations/'+conversation.id,headers:{authorization:'Bearer '+token}})).json();
  assert.equal(detail.turns[0].question,'Generated plugin question');
  assert.equal(detail.turns[0].result.answer,'Generated plugin answer ['+citation+']');
  assert.equal(detail.turns[0].result.runId,answerRunId);
  const inline=d.querySelector<HTMLButtonElement>('.inline-citation');
  assert.ok(inline,'the final answer exposes its verified citation');
  await act(async()=>inline.click());
  await until(()=>opened.length===1,'exact citation reader');
  assert.deepEqual(opened,['capture:'+citation]);
});

test('a real per-turn save keeps the server note receipt and the exact turn relationship',async t=>{
  const {node,token}=await fixture(t),citation=randomUUID();
  await node.store.ingest(capture(citation));
  const saved=node.featureServices.conversations.append(undefined,{question:'Generated saved question'},{
    answer:'Generated saved answer ['+citation+']',citations:[{id:citation,capturedAt:when,appName:'Generated Ask source',excerpt:'Generated Ask citation source.'}],
    trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[citation]},
  });
  const notes:{path:string;body:any}[]=[],{api}=apiFor(node,token,(path,init)=>{if(path==='/api/notes'&&init.method==='POST')notes.push({path,body:JSON.parse(String(init.body))});});
  const {d,opened}=await render(t,api);
  await until(()=>d.querySelector('.conversation-item')!==null,'conversation history');
  await act(async()=>d.querySelector<HTMLButtonElement>('.conversation-item')!.click());
  await until(()=>d.body.textContent?.includes('Generated saved answer')===true,'saved turn');
  await act(async()=>{
    const button=Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(value=>value.textContent==='保存为记录');assert.ok(button);button.click();
  });
  await act(async()=>{
    const dialog=d.querySelector<HTMLElement>('[role=dialog]')!;assert.ok(dialog);
    const save=Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find(value=>value.textContent==='保存');assert.ok(save);save.click();
  });
  await until(()=>d.body.textContent?.includes('查看已保存记录')===true,'server save receipt');
  assert.equal(notes.length,1);
  assert.equal(notes[0].body.metadata.noteOrigin.messageIds[0],saved.turnId);
  const note=(await node.app.inject({url:'/api/notes/'+notes[0].body.id,headers:{authorization:'Bearer '+token}})).json();
  assert.equal(note.id,notes[0].body.id);
  assert.deepEqual(note.metadata.noteOrigin.messageIds,[saved.turnId]);
  await act(async()=>{
    const view=Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(value=>value.textContent==='查看已保存记录');assert.ok(view);view.click();
  });
  assert.deepEqual(opened,['capture:'+notes[0].body.id]);
});

test('the plugin-owned run poller stops hidden reads and resumes with one current read',async t=>{
  const dom=new JSDOM('<!doctype html>',{url:'http://localhost/#/ask',pretendToBeVisual:true}),doc=dom.window.document;
  let hidden=false,reads=0,applied=0;
  Object.defineProperty(doc,'hidden',{configurable:true,get:()=>hidden});
  Object.defineProperty(doc,'visibilityState',{configurable:true,get:()=>hidden?'hidden':'visible'});
  const api={request:async(path:string)=>{assert.equal(path,'/api/query-runs/generated-hidden-run');reads++;return {id:'generated-hidden-run',status:'running',createdAt:when,updatedAt:when,events:[]};},setAgentTimeout:()=>{}} as Api;
  const controller=createAskController({api,document:doc,intervalMs:5,retryMs:5});
  t.after(()=>{controller.dispose();dom.window.close();});
  controller.start();
  controller.poll('generated-hidden-run',{onRun:()=>{applied++;},onError:()=>{throw Error('Generated hidden read failed');}});
  await until(()=>reads>0,'visible polling');
  const before=reads;
  hidden=true;await act(async()=>doc.dispatchEvent(new dom.window.Event('visibilitychange')));
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(reads,before,'hidden Ask stops the run read');
  hidden=false;await act(async()=>doc.dispatchEvent(new dom.window.Event('visibilitychange')));
  await until(()=>reads>before,'foreground resumes the run read');
  assert.ok(applied>0);
});
