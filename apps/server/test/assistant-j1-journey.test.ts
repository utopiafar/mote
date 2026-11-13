import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as proxyRequest} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {estimateSerializedTokens} from '@mote/agent';
import {createApi} from '../../web/src/api.js';
import {AssistantDraftActions} from '../../web/src/plugins/ask/AssistantDraftActions.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {sha256} from '../src/store.js';
import {fixtureFilePolicy} from './fixtures/file-policy.js';

const token='generated-j1-owner';
const allowedText='GENERATED BLUE ORCHID: the release needs a named reviewer.';
const excludedText='GENERATED PRIVATE OUTSIDE THE SELECTED SOURCE';
const goal='Generated reviewer task';
const pause=()=>new Promise(resolve=>setTimeout(resolve,15));
async function until<T>(read:()=>T|Promise<T>,label:string):Promise<NonNullable<T>>{
 const deadline=Date.now()+10000;let value:T;
 do{value=await read();if(value)return value as NonNullable<T>;await pause();}while(Date.now()<deadline);
 throw Error(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
}

test('J1 uploaded evidence reaches a clicked draft once after lost replies and a restart',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-j1-'));
 let evidenceId='',taskCalls=0,taskWire='',releaseHeld!:()=>void,enteredHeld!:()=>void;
 let hold=true;
 const held=new Promise<void>(resolve=>{releaseHeld=resolve;}),entered=new Promise<void>(resolve=>{enteredHeld=resolve;});
 const provider=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  const parsed=JSON.parse(body) as {messages:{role:string}[]};
  assert.ok(estimateSerializedTokens(parsed).tokens+512<=32000,'the controlled fixture request fits its declared 32k test window');
  const messages=parsed.messages;
  let delta:unknown,finish='stop';
  if(!body.includes(goal))delta={role:'assistant',content:JSON.stringify({answer:'Generated draft ready',citationIds:[],draft:{goal}})};
  else if(!messages.some(message=>message.role==='tool')){
   taskCalls++;delta={role:'assistant',tool_calls:[{index:0,id:'j1-evidence',type:'function',function:{name:'evidence',arguments:JSON.stringify({ids:[evidenceId]})}}]};finish='tool_calls';
  }else{
   taskWire=body;if(hold){enteredHeld();await held;}
   delta={role:'assistant',content:JSON.stringify({answer:JSON.stringify({answer:'Generated reviewer result',actions:[]}),citationIds:[evidenceId]})};
  }
  if(res.destroyed)return;
  res.writeHead(200,{'content-type':'text/event-stream'});
  const send=(value:unknown)=>res.write('data: '+JSON.stringify(value)+'\n\n');
  send({id:'generated-j1',choices:[{index:0,delta,finish_reason:null}]});
  send({id:'generated-j1',choices:[{index:0,delta:{},finish_reason:finish}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}});res.end('data: [DONE]\n\n');
 });
 await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const config:Config={dataDir:dir,dataKey:'64'.repeat(32),contentEncryptionEnabled:true,token,tokenPath:'generated-fixture',host:'127.0.0.1',port:0,
  maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',
  modelProtocol:'openai-completions',modelBaseUrl:`http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,modelMaxTokens:512,apiKey:'generated-only',
  allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent'};
 let node:Awaited<ReturnType<typeof buildApp>>,central='';
 const start=async()=>{
  node=await buildApp(config,{backgroundWorker:false});
  // C5 is not merged: bypass its deliberate production batch block only in this
  // controlled-provider fixture. This does not establish a production budget.
  (node.batchProcessing as unknown as {modelAdmission:()=>undefined}).modelAdmission=()=>undefined;
  central=await node.app.listen({host:'127.0.0.1',port:0});
 };
 await start();
 const trace:{path:string;body:string}[]=[],dropped=new Map<string,{status:number;body:any}>(),drop=new Set(['/api/conversations/messages','/api/assistant/commands']);
 const proxy=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks);
  const path=req.url??'/';if(req.method==='POST'&&['/api/conversations/messages','/api/assistant/commands'].includes(path))trace.push({path,body:body.toString()});
  const upstream=proxyRequest(central+path,{method:req.method,headers:req.headers},response=>{
   const result:Buffer[]=[];response.on('data',chunk=>result.push(Buffer.from(chunk)));response.on('end',()=>{
    if(drop.delete(path)){dropped.set(path,{status:response.statusCode??502,body:JSON.parse(Buffer.concat(result).toString())});res.destroy();return;}
    res.writeHead(response.statusCode??502,response.headers);res.end(Buffer.concat(result));
   });
  });upstream.on('error',()=>res.destroy());upstream.end(body);
 });
 await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
 const nativeFetch=globalThis.fetch;
 const request=async(path:string,init:RequestInit={})=>{
  const response=await nativeFetch(base+path,{...init,headers:{authorization:'Bearer '+token,...(init.body?{'content-type':'application/json'}:{}),...init.headers}});
  const value=await response.json();assert.ok(response.ok,`${path}: ${response.status} ${JSON.stringify(value)}`);return value as any;
 };
 const post=(path:string,payload:unknown)=>request(path,{method:'POST',body:JSON.stringify(payload)});
 let dom:JSDOM|undefined,root:ReturnType<typeof createRoot>|undefined;
 const prior=new Map<string,PropertyDescriptor|undefined>();
 t.after(async()=>{
  releaseHeld();if(root)await act(async()=>root!.unmount());dom?.window.close();
  for(const [key,value] of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}
  await node.app.close();proxy.closeAllConnections();provider.closeAllConnections();
  await Promise.all([new Promise<void>(resolve=>proxy.close(()=>resolve())),new Promise<void>(resolve=>provider.close(()=>resolve()))]);
  rmSync(dir,{recursive:true,force:true});
 });
 await post('/api/sources',{id:'j1-files',name:'Generated allowed files',kind:'local-files',deviceId:'j1-device',platform:'macos',retention:'archive'});
 const bytes=Buffer.from(allowedText),manifest={sourceId:'j1-files',item:{externalId:'review.txt',revision:'1',observedAt:'2026-11-01T00:00:00Z',title:'Generated review.txt',kind:'file',layer:'original',text:'',mimeType:'text/plain',deleted:false},sizeBytes:bytes.length,sha256:sha256(bytes)};
 const upload=await post('/api/file-sync/v1/uploads',manifest);
 const part=await nativeFetch(base+`/api/file-sync/v1/uploads/${upload.uploadId}/parts/0`,{method:'PUT',headers:{authorization:'Bearer '+token,'content-type':'application/octet-stream'},body:bytes});assert.equal(part.status,200);
 const saved=await post(`/api/file-sync/v1/uploads/${upload.uploadId}/commit`,{}),fileId=saved.id;
 const settings={...node.processing.view().settings,enabled:true,summarize:false};
 await node.processing.save({revision:node.processing.view().revision,settings,policy:fixtureFilePolicy(settings,node.processing.runtime.registry)});await node.processing.tick();
 const chunk=node.files.chunks(fileId).find(item=>item.ocrText.includes(allowedText));assert.ok(chunk,'the uploaded bytes were extracted');evidenceId=chunk.id;
 await post('/api/notes',{id:randomUUID(),deviceId:'j1-other',deviceName:'Generated',platform:'android',capturedAt:'2026-11-01T00:00:00Z',text:excludedText});
 const conversation=await request('/api/conversations/main'),clientRequestId=randomUUID();
 const message={conversationId:conversation.id,clientRequestId,question:'Please prepare the generated reviewer work',scope:{kind:'selection',evidenceIds:[fileId]}};
 await assert.rejects(post('/api/conversations/messages',message),'the first accepted reply is lost');
 const firstReceipt=dropped.get('/api/conversations/messages')!;assert.equal(firstReceipt.status,202);assert.equal(firstReceipt.body.status,'accepted');
 const accepted=await post('/api/conversations/messages',message);assert.equal(accepted.id,firstReceipt.body.id);
 await until(async()=>{const value=await request(`/api/conversations/${conversation.id}/messages/${accepted.id}`);return value.status==='completed'?value:value.status==='failed'?Promise.reject(Error(JSON.stringify(value))):undefined;},'queued conversation query');
 const turn=(await request(`/api/conversations/${conversation.id}`)).turns.find((item:any)=>item.id===accepted.id);
 assert.ok(turn.result.draft.capabilities.includes('assistant.task.start'));
 assert.deepEqual(turn.result.draft.scope,message.scope);
 dom=new JSDOM('<div id="root"></div>',{url:base+'/#/ask'});
 let pendingCommand:Promise<Response>|undefined,pendingTaskRead:Promise<Response>|undefined;
 const webFetch=(path:string,init:RequestInit)=>{const pending=nativeFetch(base+path,init);if(path==='/api/assistant/commands')pendingCommand=pending;if(path.includes('/assistant-tasks?'))pendingTaskRead=pending;return pending;};
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true,fetch:webFetch})){
  prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 }
 configureLocale(()=> 'zh-CN');root=createRoot(dom.window.document.getElementById('root')!);const api=createApi({token});
 const props={api,conversationId:conversation.id,turnId:accepted.id,draft:turn.result.draft};
 await act(async()=>root!.render(React.createElement(AssistantDraftActions,props)));
 const button=()=>[...dom!.window.document.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent?.includes('开始'))!;
 await act(async()=>{button().click();await pendingCommand?.catch(()=>{});await pause();});
 assert.ok(dom.window.document.querySelector('[role=alert]'),'the lost command reply is visible');
 await act(async()=>{button().click();await pendingCommand?.then(response=>response.clone().json());await pause();});
 assert.ok(dom.window.document.querySelector('.assistant-draft-status[role=status]'),'the same command can be retried');
 assert.equal(dropped.get('/api/assistant/commands')!.status,200);
 await Promise.race([entered,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('Provider did not read evidence')),10000))]);
 const messages=trace.filter(item=>item.path==='/api/conversations/messages').map(item=>JSON.parse(item.body));
 const commands=trace.filter(item=>item.path==='/api/assistant/commands').map(item=>JSON.parse(item.body));
 assert.equal(messages.length,2);assert.deepEqual(messages[0],messages[1]);assert.equal(commands.length,2);assert.deepEqual(commands[0],commands[1]);
 assert.equal(commands[0].requestId,turn.result.draft.requestId);assert.equal(commands[0].turnId,accepted.id);
 assert.match(taskWire,new RegExp(allowedText));assert.doesNotMatch(taskWire,new RegExp(excludedText));
 const readPath=`/api/conversations/${conversation.id}/messages/${accepted.id}/assistant-tasks?`+new URLSearchParams({scope:JSON.stringify(message.scope)});
 const pending=await request(readPath);assert.equal(pending.items.length,1);const taskId=pending.items[0].task.id;
 await node.app.close();hold=false;releaseHeld();await start();
 const completed=await until(async()=>{const page=await request(readPath),item=page.items[0];return item?.task.state==='completed'?item:item?.task.state==='failed'?Promise.reject(Error(JSON.stringify(item))):undefined;},'resumed durable task');
 assert.equal(completed.task.id,taskId);assert.equal(completed.task.requestId,turn.result.draft.requestId);
 assert.equal(completed.result.answer,'Generated reviewer result');assert.deepEqual(completed.result.citations.map((item:any)=>item.id),[evidenceId]);
 assert.ok(node.store.db.prepare('SELECT 1 FROM task_evidence WHERE task_id=? AND evidence_id=?').get(taskId,fileId));
 assert.equal(node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='assistant.task'").get()!.n,1);
 assert.equal((await request(`/api/conversations/${conversation.id}`)).turns.length,1);
 assert.equal(taskCalls,2,'only the interrupted queue item is retried');
 await act(async()=>{root!.render(React.createElement(AssistantDraftActions,{...props,renderAnswer:(answer:any)=>React.createElement('p',null,answer.answer),onOpen:()=>{}}));});
 await act(async()=>{await pendingTaskRead?.then(response=>response.clone().json());await pause();});
 assert.match(dom.window.document.body.textContent!,/Generated reviewer result/,'the real draft component reads the durable result');
 const hidden=await request(`/api/conversations/${conversation.id}/messages/${accepted.id}/assistant-tasks?`+new URLSearchParams({scope:JSON.stringify({kind:'selection',evidenceIds:[]})}));assert.deepEqual(hidden,{items:[]});
});
