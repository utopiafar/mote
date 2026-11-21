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
import {startBridge} from '../../../packages/agent/dist/bridge.js';
import {configureLocale} from '@mote/shared/i18n';
import {buildApp} from '../../server/src/app';
import type {ConfigurationPlatformOptions} from '../../server/src/config';
import {createApi} from '../src/api';
import {MaterialDetail,type Material} from '../src/Materials';
import {Conversations} from '../src/plugins/ask/Conversations';
import {AnswerView} from '../src/shell-components';
import {unsentDrafts} from '../src/plugins/ask/chat-drafts';
import {featuresReady} from '../src/features/bootstrap';
const prompt='请只根据这份资料开始认识我，说明资料里明确呈现的事实、仍不确定的部分，以及需要我补充的问题。';
const deferred=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
async function until(check:()=>boolean,label:string){const end=Date.now()+10000;while(Date.now()<end){if(check())return;await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});}assert.fail('Generated Light DOM did not settle: '+label);}
async function fixture(t:any,hold=false){
 await featuresReady;configureLocale(()=> 'zh-CN');
 const directory=mkdtempSync(join(tmpdir(),'mote-web-light-entry-')),token='generated-light-dom-owner',headers={authorization:'Bearer '+token},entered=deferred(),held=deferred(),seen:QueryInput[]=[],calls:{path:string;method:string;body?:any}[]=[];
 const config:ConfigurationPlatformOptions={path:join(directory,'mote.yaml'),privateCredential:{token,tokenPath:'fixture'},initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:2_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'generated-light-dom',baseUrl:'https://generated.invalid',apiKey:'generated-only',allowUnauthenticatedLocal:false},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'}}};
 const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
  seen.push(input);const bridge=await startBridge(reader,input);
  try{
   const response=await fetch(bridge.url+'/material_read',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify({ref:input.anchorMaterialRef,length:12000})});assert.equal(response.status,200);const page=(await response.json() as any).data;
   assert.match(page.text,/GENERATED_LIGHT_SELECTED_BODY/);entered.release();if(hold)await held.promise;
   return {answer:'Generated Light acquaintance from the selected Material.',citations:[],trace:bridge.trace,runId:randomUUID(),evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies};
  }finally{await bridge.close();}
 }})});
 const address=await node.app.listen({host:'127.0.0.1',port:0});
 const sourceId='generated-light-dom-source';
 const source=await node.app.inject({method:'POST',url:'/api/sources',headers,payload:{id:sourceId,name:'Generated Light source',kind:'custom',deviceId:'generated-device',platform:'import',retention:'archive'}});assert.equal(source.statusCode,200,source.body);
 const publish=async(revision:string,text:string)=>{const response=await node.app.inject({method:'PUT',url:`/api/sources/${sourceId}/items`,headers,payload:{externalId:'selected',revision,observedAt:'2026-10-01T00:00:00Z',title:'Generated Light notes',text,kind:'file',layer:'snapshot',document:{path:'selected.txt',contentRole:'other',timeBasis:'unknown'}}});assert.equal(response.statusCode,200,response.body);await node.materialOrganizer.tick();};
 await publish('v1','GENERATED_LIGHT_SELECTED_BODY: Generated source facts and an unresolved question.');
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/library?view=materials',pretendToBeVisual:true}),prior=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 Object.assign(dom.window.HTMLElement.prototype,{scrollIntoView:()=>{},attachEvent:()=>{},detachEvent:()=>{}});dom.window.scrollTo=()=>{};
 const root=createRoot(dom.window.document.getElementById('root')!),actualFetch=globalThis.fetch;
 t.mock.method(globalThis,'fetch',async(url:RequestInfo|URL,init?:RequestInit)=>{
  const path=String(url);if(path.startsWith('/')){calls.push({path,method:init?.method??'GET',...(init?.body?{body:JSON.parse(String(init.body))}:{})});return actualFetch(address+path,init);}
  assert.match(path,/^http:\/\/127\.0\.0\.1:/,'all model/HTTP fixture transports stay on loopback');return actualFetch(url,init);
 });
 const api=createApi({token}),list=await api.request<{items:Material[]}>('/api/materials?sourceId='+sourceId),material=list.items[0];assert.ok(material);
 t.after(async()=>{held.release();await act(async()=>root.unmount());await node.app.close();for(const[key,descriptor]of prior)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);dom.window.close();rmSync(directory,{recursive:true,force:true});});
 const renderDetail=()=>act(async()=>root.render(React.createElement(MaterialDetail,{api,material,onOpen:()=>{}})));
 const renderChat=()=>act(async()=>root.render(React.createElement(Conversations,{api,configured:true,devices:[],renderAnswer:(answer,open)=>React.createElement(AnswerView,{answer,onOpen:open,compact:true})})));
 const open=async()=>{await renderDetail();await until(()=>Boolean(dom.window.document.querySelector('.material-reader-acquaintance')),'current Material read');await act(async()=>dom.window.document.querySelector<HTMLButtonElement>('.material-reader-acquaintance')!.click());await renderChat();await until(()=>Boolean(dom.window.document.querySelector<HTMLTextAreaElement>('textarea')?.value===prompt),'exact questionDraft handoff');};
 const send=()=>act(async()=>dom.window.document.querySelector('form.ask-form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));
 return {node,api,material,sourceId,calls,seen,entered,held,publish,renderDetail,renderChat,open,send,d:dom.window.document,w:dom.window};
}

test('a real selected Material prepares a guarded acquaintance draft and the main conversation consumes its exact pin through owner HTTP',async t=>{
 const f=await fixture(t);await f.renderDetail();await until(()=>Boolean(f.d.querySelector('.material-reader-acquaintance')),'Material entry');
 unsentDrafts.set(f.api,{question:'Generated unsent owner text',attachments:[]});f.w.confirm=()=>false;
 await act(async()=>f.d.querySelector<HTMLButtonElement>('.material-reader-acquaintance')!.click());assert.match(f.w.location.hash,/^#\/library/);assert.equal(unsentDrafts.get(f.api)?.question,'Generated unsent owner text');
 f.w.confirm=()=>true;await act(async()=>f.d.querySelector<HTMLButtonElement>('.material-reader-acquaintance')!.click());const route=new URLSearchParams(f.w.location.hash.split('?')[1]);assert.equal(route.get('fromMaterial'),f.material.ref);assert.equal(route.get('materialOnly'),'1');
 await f.renderChat();await until(()=>f.d.querySelector<HTMLTextAreaElement>('textarea')?.value===prompt,'prepared owner text');await until(()=>!f.d.querySelector<HTMLButtonElement>('.send-button')!.disabled,'fresh pin verification');
 assert.equal(f.calls.some(call=>call.method==='POST'),false,'navigation has not started a task or model request');await f.send();
 await until(()=>f.d.body.textContent!.includes('Generated Light acquaintance from the selected Material.'),'actual completed answer DOM');
 const posts=f.calls.filter(call=>call.path==='/api/conversations/messages'&&call.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].body.anchorMaterialRef,f.material.ref);assert.equal(posts[0].body.scope.kind,'selection');assert.deepEqual(posts[0].body.scope.sourceIds,[f.sourceId]);
 assert.equal(f.seen.length,1);assert.deepEqual(f.seen[0].hostToolSelection,['material_read','evidence']);assert.equal(f.calls.some(call=>call.path==='/api/assistant/onboarding'&&call.method==='POST'),false);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='assistant.onboarding'").get()!.n,0);
});

test('a Material revision change before the draft is sent leaves the reference unavailable and does not replace the pin',async t=>{
 const f=await fixture(t);await f.renderDetail();await until(()=>Boolean(f.d.querySelector('.material-reader-acquaintance')),'original Material entry');
 await f.publish('v2','GENERATED_LIGHT_SELECTED_BODY changed version');await act(async()=>f.d.querySelector<HTMLButtonElement>('.material-reader-acquaintance')!.click());await f.renderChat();
 await until(()=>Boolean(f.d.querySelector('.ask-original-reference [role=alert]')),'stale reference rejection');assert.equal(f.d.querySelector<HTMLButtonElement>('.send-button')!.disabled,true);assert.equal(new URLSearchParams(f.w.location.hash.split('?')[1]).get('fromMaterial'),f.material.ref);
 assert.equal(f.calls.some(call=>call.method==='POST'),false);assert.equal(f.seen.length,0);
});

test('the real pending acquaintance can be cancelled in Conversations and a late controlled answer is not published',async t=>{
 const f=await fixture(t,true);await f.open();await until(()=>!f.d.querySelector<HTMLButtonElement>('.send-button')!.disabled,'verified Material draft');await f.send();await f.entered.promise;
 await until(()=>[...f.d.querySelectorAll('button')].some(button=>button.getAttribute('aria-label')==='停止这条回答'),'durable pending message');
 await act(async()=>[...f.d.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.getAttribute('aria-label')==='停止这条回答')!.click());
 const accepted=f.calls.find(call=>call.path==='/api/conversations/messages'&&call.method==='POST')!.body;
 await until(()=>f.node.conversations.messageByClientRequestId(accepted.clientRequestId)?.status==='cancelled','actual owner cancel receipt');
 f.held.release();
 await until(()=>Boolean(f.d.querySelector('.chat-message[data-state=cancelled]')),'cancelled receipt DOM');
 assert.equal(f.d.body.textContent!.includes('Generated Light acquaintance from the selected Material.'),false);assert.equal(f.seen.length,1);assert.equal(f.calls.filter(call=>call.path.endsWith('/cancel')&&call.method==='POST').length,1);
});
