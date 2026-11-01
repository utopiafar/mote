import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import React,{act,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import type {WorkActivity,WorkState} from '@mote/shared';
import {ActivityMemoryResults} from '../src/ActivityMemoryResults.js';
import {Activity} from '../src/Activity.js';
import {ApiError,type Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';

configureLocale(()=> 'zh-CN');
const id=(index:number)=>'00000000-0000-4000-8000-'+String(index).padStart(12,'0');
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
async function fixture(t:import('node:test').TestContext){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/activity?work=memory%3Agenerated',pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,location:dom.window.location,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 dom.window.scrollTo=()=>{};
 const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});return {root,d:dom.window.document};
}
function client(initial:string[]){
 let ids=[...initial],failure=0,pageFailure=0,gate:ReturnType<typeof deferred<unknown>>|undefined;const reads:string[]=[],titles=new Map<string,string>();
 const api={request:async(path:string,init?:RequestInit)=>{reads.push(path);assert.ok(init?.signal,'all private reads are abortable');if(path.includes('/memory-results')){if(pageFailure)throw new ApiError('Generated page denied',pageFailure);const cursor=new URL('http://localhost'+path).searchParams.get('cursor'),after=cursor?ids.findIndex(x=>x===cursor)+1:0,selected=ids.slice(after,after+20);return {ids:selected,total:ids.length,nextCursor:after+20<ids.length?selected.at(-1):null};}if(path.startsWith('/api/memories/')){const current=decodeURIComponent(path.split('/').at(-1)!);if(gate){const waiting=gate;gate=undefined;return waiting.promise;}if(failure)throw new ApiError('Generated read denied',failure);return {id:current,title:titles.get(current)??('Generated '+current),status:'published',createdAt:'2026-09-20T01:00:00Z'};}throw Error('Unexpected '+path);}} as Api;
 return {api,reads,remove:(value:string)=>{ids=ids.filter(x=>x!==value);},retitle:(value:string,title:string)=>titles.set(value,title),fail:(status:number)=>{failure=status;},failPage:(status:number)=>{pageFailure=status;},block:()=>{gate=deferred<unknown>();return gate;}};
}
function View({api,opened,live=true,version='2026-11-01T00:00:00Z',active=true}:{api:Api;opened:string[];live?:boolean;version?:string;active?:boolean}){const[cursors,setCursors]=useState<(string|undefined)[]>([undefined]);return React.createElement(ActivityMemoryResults,{api,workId:'memory:generated',cursors,onCursors:setCursors,revision:0,live,version,active,onOpen:value=>opened.push(value),onSettled:()=>{}});}
const click=(d:Document,text:string)=>{const element=[...d.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent?.trim()===text);assert.ok(element,text);element.click();};
test('a bounded second page opens the selected result after fresh membership and Memory reads',async t=>{
 const {root,d}=await fixture(t),client1=client(Array.from({length:22},(_,i)=>id(i+1))),opened:string[]=[];
 await act(async()=>root.render(React.createElement(View,{api:client1.api,opened})));assert.equal(d.querySelectorAll('[data-activity-memory-id]').length,20);assert.match(d.body.textContent!,/22 项/);
 await act(async()=>click(d,'下一页'));assert.equal(d.querySelectorAll('[data-activity-memory-id]').length,2);assert.match(d.body.textContent!,/第 2 页/);
 await act(async()=>d.querySelector<HTMLButtonElement>(`[data-activity-memory-id="${id(22)}"]`)!.click());assert.deepEqual(opened,[id(22)]);assert.ok(client1.reads.filter(path=>path.startsWith('/api/memories/'+id(22))).length>=2);
 await act(async()=>click(d,'上一页'));assert.equal(d.querySelectorAll('[data-activity-memory-id]').length,20);
});
test('membership changed while initial Memory read is pending never publishes a stale title',async t=>{
 const {root,d}=await fixture(t),c=client([id(1)]),opened:string[]=[],gate=c.block();
 await act(async()=>root.render(React.createElement(View,{api:c.api,opened})));assert.equal(d.querySelectorAll('[data-activity-memory-id]').length,0);c.remove(id(1));
 await act(async()=>gate.resolve({id:id(1),title:'Late private title',status:'published'}));assert.doesNotMatch(d.body.textContent!,/Late private title/);assert.match(d.body.textContent!,/状态已变化/);assert.deepEqual(opened,[]);
});
test('removing membership or withdrawing permission while a click is pending prevents navigation and removes the old title',async t=>{
 const {root,d}=await fixture(t),c=client([id(1)]),opened:string[]=[];await act(async()=>root.render(React.createElement(View,{api:c.api,opened})));
 const gate=c.block();await act(async()=>d.querySelector<HTMLButtonElement>('[data-activity-memory-id]')!.click());c.remove(id(1));await act(async()=>gate.resolve({id:id(1),title:'Previously readable',status:'published'}));assert.deepEqual(opened,[]);assert.equal(d.querySelector('[data-activity-memory-id]'),null);assert.match(d.body.textContent!,/暂不可用/);
 await act(async()=>root.unmount());
});
test('403, 404 and 503 never retain a title; retry obtains a fresh readable object',async t=>{
 for(const status of [403,404,503]){
  const {root,d}=await fixture(t),c=client([id(status)]),opened:string[]=[];c.fail(status);await act(async()=>root.render(React.createElement(View,{api:c.api,opened})));assert.equal(d.querySelector('[data-activity-memory-id]'),null);assert.match(d.body.textContent!,/暂不可用/);
  c.fail(0);await act(async()=>click(d,'重试'));assert.match(d.body.textContent!,new RegExp('Generated '+id(status)));await act(async()=>root.unmount());
 }
});
test('late responses from another owner cannot restore an old result',async t=>{
 const {root,d}=await fixture(t),first=client([id(1)]),second=client([id(2)]),opened:string[]=[],gate=first.block();await act(async()=>root.render(React.createElement(View,{api:first.api,opened})));
 await act(async()=>root.render(React.createElement(View,{api:second.api,opened})));assert.match(d.body.textContent!,new RegExp('Generated '+id(2)));await act(async()=>gate.resolve({id:id(1),title:'Old owner private title',status:'published'}));assert.doesNotMatch(d.body.textContent!,/Old owner private title/);assert.equal(d.querySelectorAll('[data-activity-memory-id]').length,1);
});
test('an already visible title disappears on the next actual authorization refresh',async t=>{
 const {root,d}=await fixture(t),c=client([id(1)]),opened:string[]=[];await act(async()=>root.render(React.createElement(View,{api:c.api,opened})));const focused=d.querySelector<HTMLButtonElement>('[data-activity-memory-id]')!;focused.focus();c.fail(403);
 await act(async()=>new Promise(resolve=>setTimeout(resolve,3200)));assert.equal(d.querySelector('[data-activity-memory-id]'),null);assert.equal(d.activeElement,focused,'withdrawal keeps focus on the same non-opening result row');assert.match(d.body.textContent!,/暂不可用/);assert.deepEqual(opened,[]);
});
test('automatic refresh preserves a focused result and does not cancel a slow intentional open',async t=>{
 const {root,d}=await fixture(t),c=client([id(1)]),opened:string[]=[];await act(async()=>root.render(React.createElement(View,{api:c.api,opened})));const focused=d.querySelector<HTMLButtonElement>('[data-activity-memory-id]')!;focused.focus();
 await act(async()=>new Promise(resolve=>setTimeout(resolve,3200)));assert.equal(d.activeElement,focused);assert.ok(d.querySelector('[data-activity-memory-id]'));
 const gate=c.block();await act(async()=>focused.click());await act(async()=>new Promise(resolve=>setTimeout(resolve,3200)));await act(async()=>gate.resolve({id:id(1),title:'Generated '+id(1),status:'published'}));assert.deepEqual(opened,[id(1)],'opening is not aborted by an unrelated refresh timer');
});
test('a failed activity result-page refresh moves focus to Retry and removes the old private titles',async t=>{
 const {root,d}=await fixture(t),c=client([id(1)]),opened:string[]=[];await act(async()=>root.render(React.createElement(View,{api:c.api,opened})));d.querySelector<HTMLButtonElement>('[data-activity-memory-id]')!.focus();c.failPage(503);
 await act(async()=>new Promise(resolve=>setTimeout(resolve,3200)));assert.doesNotMatch(d.body.textContent!,/Generated 00000000/);assert.equal(d.activeElement?.textContent,'重试');assert.ok(d.querySelector('[role=alert]'));assert.deepEqual(opened,[]);
});
test('a removed focused result returns focus to the results heading',async t=>{
 const {root,d}=await fixture(t),c=client([id(1),id(2)]),opened:string[]=[];await act(async()=>root.render(React.createElement(View,{api:c.api,opened})));d.querySelector<HTMLButtonElement>(`[data-activity-memory-id="${id(1)}"]`)!.focus();c.remove(id(1));
 await act(async()=>new Promise(resolve=>setTimeout(resolve,3200)));assert.equal(d.querySelector(`[data-activity-memory-id="${id(1)}"]`),null);assert.equal(d.activeElement?.textContent,'已保存成果');assert.ok(d.querySelector(`[data-activity-memory-id="${id(2)}"]`));
});

test('completed work reads twenty authorized results once and stays idle for sixty seconds',async t=>{
 const {root,d}=await fixture(t),c=client(Array.from({length:20},(_,i)=>id(i+1))),opened:string[]=[];
 t.mock.timers.enable({apis:['setTimeout']});
 await act(async()=>root.render(React.createElement(View,{api:c.api,opened,live:false})));
 assert.equal(c.reads.length,22);assert.equal(d.querySelectorAll('[data-activity-memory-id]').length,20);
 await act(async()=>t.mock.timers.tick(60000));assert.equal(c.reads.length,22,'completed work never schedules another authorization round');
 await act(async()=>d.dispatchEvent(new d.defaultView!.Event('visibilitychange')));assert.equal(c.reads.length,22,'visibility alone does not refresh completed work');
 c.fail(403);await act(async()=>d.querySelector<HTMLButtonElement>('[data-activity-memory-id]')!.click());
 assert.deepEqual(opened,[]);assert.equal(d.querySelector(`[data-activity-memory-id="${id(1)}"]`),null,'opening still performs a fresh authorization read');
});

test('a completed work version change reads exactly one new twenty-result round',async t=>{
 const {root,d}=await fixture(t),c=client(Array.from({length:20},(_,i)=>id(i+1))),opened:string[]=[];
 t.mock.timers.enable({apis:['setTimeout']});
 const render=(version:string)=>act(async()=>root.render(React.createElement(View,{api:c.api,opened,live:false,version})));
 await render('one');assert.equal(c.reads.length,22);
 await render('two');assert.equal(c.reads.length,44);assert.equal(d.querySelectorAll('[data-activity-memory-id]').length,20);
 await render('two');await act(async()=>t.mock.timers.tick(60000));assert.equal(c.reads.length,44,'the same version and elapsed time add no reads');
});

test('live results poll every three seconds, pause while hidden and refresh once when visible',async t=>{
 const {root,d}=await fixture(t),c=client(Array.from({length:20},(_,i)=>id(i+1))),opened:string[]=[];
 t.mock.timers.enable({apis:['setTimeout']});
 await act(async()=>root.render(React.createElement(View,{api:c.api,opened})));assert.equal(c.reads.length,22);
 await act(async()=>t.mock.timers.tick(2999));assert.equal(c.reads.length,22);
 await act(async()=>t.mock.timers.tick(1));assert.equal(c.reads.length,44);
 await act(async()=>t.mock.timers.tick(3000));assert.equal(c.reads.length,66);
 Object.defineProperty(d,'hidden',{configurable:true,value:true});await act(async()=>d.dispatchEvent(new d.defaultView!.Event('visibilitychange')));
 await act(async()=>t.mock.timers.tick(9000));assert.equal(c.reads.length,66,'hidden pages issue no periodic result or Memory reads');
 Object.defineProperty(d,'hidden',{configurable:true,value:false});await act(async()=>d.dispatchEvent(new d.defaultView!.Event('visibilitychange')));assert.equal(c.reads.length,88);
 await act(async()=>t.mock.timers.tick(3000));assert.equal(c.reads.length,110,'only one timer survives visibility recovery');
 await act(async()=>root.unmount());await act(async()=>{d.dispatchEvent(new d.defaultView!.Event('visibilitychange'));t.mock.timers.tick(60000);});assert.equal(c.reads.length,110,'unmount removes polling and the visibility listener');
});

test('visibility recovery does not restart a pending round or interrupt an intentional open',async t=>{
 const {root,d}=await fixture(t),c=client([id(1)]),opened:string[]=[],initial=c.block();
 t.mock.timers.enable({apis:['setTimeout']});
 const show=()=>{Object.defineProperty(d,'hidden',{configurable:true,value:true});d.dispatchEvent(new d.defaultView!.Event('visibilitychange'));Object.defineProperty(d,'hidden',{configurable:true,value:false});d.dispatchEvent(new d.defaultView!.Event('visibilitychange'));};
 await act(async()=>root.render(React.createElement(View,{api:c.api,opened})));await act(async()=>{show();t.mock.timers.tick(9000);});assert.equal(c.reads.length,2);
 await act(async()=>initial.resolve({id:id(1),title:'Generated result',status:'published'}));assert.equal(c.reads.length,3);
 const opening=c.block();await act(async()=>d.querySelector<HTMLButtonElement>('[data-activity-memory-id]')!.click());assert.equal(c.reads.length,5);
 await act(async()=>{show();t.mock.timers.tick(9000);});assert.equal(c.reads.length,5);
 await act(async()=>opening.resolve({id:id(1),title:'Generated result',status:'published'}));assert.deepEqual(opened,[id(1)]);assert.equal(c.reads.length,6);
});

test('Activity passes work state and updatedAt to result refreshes without rereading unchanged receipts',async t=>{
 const {root,d}=await fixture(t),c=client(Array.from({length:20},(_,i)=>id(i+1)));
 let work:WorkActivity={id:'memory:generated',kind:'memory',goal:'Generated Memory work',state:'completed',createdAt:'2026-11-01T00:00:00Z',updatedAt:'one',progress:{mode:'semantic',stage:'finished'},branches:[],artifacts:[],evidence:{count:0,refs:[]},events:[],destination:'memories',technical:{operationIds:[]}};
 const path='/api/work-activity/memory%3Agenerated?limit=20',api={request:async(url:string,init?:RequestInit)=>url===path?work:url.startsWith('/api/operations/changes')?new Promise(()=>{}):c.api.request(url,init),setAgentTimeout:()=>{}} as Api;
 t.mock.timers.enable({apis:['setTimeout']});
 await act(async()=>root.render(React.createElement(Activity,{api,onOpen:()=>{},onNavigate:()=>{}})));assert.equal(c.reads.length,22);
 const update=(value:Partial<WorkActivity>)=>act(async()=>{work={...work,...value};resources(api).get(path).refresh();});
 await update({updatedAt:'two'});assert.equal(c.reads.length,44,'the parent propagates updatedAt');
 for(const state of ['needs_input','completed','failed','cancelled','stale','excluded'] satisfies WorkState[]){await update({state});const count=c.reads.length;await act(async()=>t.mock.timers.tick(60000));assert.equal(c.reads.length,count,state+' does not poll results');}
 for(const state of ['running','waiting'] satisfies WorkState[]){await update({state});const count=c.reads.length;await act(async()=>t.mock.timers.tick(3000));assert.equal(c.reads.length,count+22,state+' polls results');}
 await update({state:'completed',updatedAt:'three'});const count=c.reads.length;await act(async()=>t.mock.timers.tick(60000));assert.equal(c.reads.length,count,'entering a terminal state clears an existing live timer');assert.equal(d.querySelectorAll('[data-activity-memory-id]').length,20);
});

test('the manual refresh button rereads Memory results while the work receipt stays unchanged',async t=>{
 const {root,d}=await fixture(t),c=client([id(1),id(2),id(3)]);
 const work:WorkActivity={id:'memory:generated',kind:'memory',goal:'Generated Memory work',state:'completed',createdAt:'2026-11-01T00:00:00Z',updatedAt:'one',progress:{mode:'semantic',stage:'finished'},branches:[],artifacts:[],evidence:{count:0,refs:[]},events:[],destination:'memories',technical:{operationIds:[]}};
 let receipts=0;const path='/api/work-activity/memory%3Agenerated?limit=20',api={request:async(url:string,init?:RequestInit)=>{if(url===path){receipts++;return work;}return url.startsWith('/api/operations/changes')?new Promise(()=>{}):c.api.request(url,init);},setAgentTimeout:()=>{}} as Api;
 t.mock.timers.enable({apis:['setTimeout']});
 await act(async()=>root.render(React.createElement(Activity,{api,onOpen:()=>{},onNavigate:()=>{}})));
 assert.equal(receipts,1);assert.equal(c.reads.length,5,'the initial round reads one page, three members and one verifying page');assert.equal(d.querySelectorAll('[data-activity-memory-id]').length,3);
 // Another client edits one result and deletes another while the receipt is
 // byte-identical, so neither updatedAt nor a live timer can drive the reread.
 c.retitle(id(1),'Edited on another client');c.remove(id(3));
 await act(async()=>click(d,'刷新'));
 assert.equal(receipts,2,'the button still rereads the unchanged receipt');
 assert.equal(c.reads.length,9,'the manual refresh adds one page, two members and one verifying page');
 assert.equal(d.querySelectorAll('[data-activity-memory-id]').length,2,'the deleted result leaves the list');assert.match(d.body.textContent!,/Edited on another client/);assert.doesNotMatch(d.body.textContent!,new RegExp('Generated '+id(3)));
 c.fail(403);await act(async()=>click(d,'刷新'));
 assert.equal(d.querySelectorAll('[data-activity-memory-id]').length,0);assert.doesNotMatch(d.body.textContent!,/Edited on another client/);assert.match(d.body.textContent!,/暂不可用/,'a failed manual round never keeps a delivered title');
 c.fail(0);await act(async()=>click(d,'刷新'));assert.equal(d.querySelectorAll('[data-activity-memory-id]').length,2);assert.match(d.body.textContent!,/Edited on another client/);
});

// Contract: the Web consumer and the real Central serialization. The server
// runs in-process with generated rows only; every web read below goes through
// the real route handlers and response shapes (inject = the same payloads a
// remote client parses).
test('a real Central receipt stays unchanged while the manual button rereads a deleted and retitled result',async t=>{
 const {buildApp}=await import('../../server/src/app.js'),{memoryEvidenceFingerprint}=await import('../../server/src/memory.js');
 const directory=mkdtempSync(join(tmpdir(),'mote-activity-refresh-')),token='generated-refresh-contract';
 const node=await buildApp({dataDir:join(directory,'data'),token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const at='2026-11-01T00:00:00Z',captureId=randomUUID(),text='Generated Activity refresh original.';
 const note=await node.app.inject({method:'POST',url:'/api/notes',headers:{authorization:'Bearer '+token},payload:{id:captureId,deviceId:'generated-activity',deviceName:'Generated fixture',platform:'import',capturedAt:at,text}});
 assert.equal(note.statusCode,201,note.body);
 const evidence=node.memories.readEvidence([captureId])[0],memoryIds=[id(1),id(2),id(3)].sort();
 for(const [index,memoryId] of memoryIds.entries()){
  const memory={version:1,domain:'personal',tier:'episode',kind:'episodic',id:memoryId,title:'Generated contract result '+(index+1),statement:'Generated fixture statement.',uncertainty:'Generated fixture only.',status:'published',createdAt:at,model:'controlled-fixture',runId:'controlled-fixture',fingerprint:createHash('sha256').update(memoryId).digest('hex'),evidenceIds:[captureId],evidence:[{id:captureId,deviceId:evidence.deviceId,capturedAt:evidence.capturedAt,receivedAt:evidence.receivedAt,offset:0,length:text.length,quote:text,contentHash:memoryEvidenceFingerprint(evidence)}],admission:{layer:'memory',reason:'Generated contract fixture',scope:'Generated UI contract',attribution:'user'}};
  node.store.db.prepare('INSERT INTO memories(id,created_at,json) VALUES(?,?,?)').run(memoryId,at,JSON.stringify(memory));node.store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(memoryId,captureId);
 }
 const jobId='generated-refresh-job',job={id:jobId,createdAt:at,updatedAt:at,status:'completed',evidenceIds:[captureId],memoryIds,materialInputs:[],materialRefs:{},workPackage:{goal:'Generated refresh contract',instruction:'Generated controlled receipts'}};
 node.store.db.prepare('INSERT INTO memory_jobs VALUES(?,?,?)').run(jobId,at,JSON.stringify(job));
 const api={request:async(path:string,init?:RequestInit)=>{const response=await node.app.inject({method:(init?.method as 'GET'|'POST'|'DELETE'|undefined)??'GET',url:path,headers:{authorization:'Bearer '+token}}),body=response.json();if(response.statusCode>=400)throw new ApiError(typeof body?.message==='string'?body.message:response.body,response.statusCode);return body;},setAgentTimeout:()=>{}} as Api;
 const {root,d}=await fixture(t);location.hash='#/activity?work=memory%3A'+jobId;
 t.mock.timers.enable({apis:['setTimeout']});
 await act(async()=>root.render(React.createElement(Activity,{api,onOpen:()=>{},onNavigate:()=>{}})));
 const first=(await node.app.inject({method:'GET',url:'/api/work-activity/memory%3A'+jobId+'?limit=20',headers:{authorization:'Bearer '+token}})).json().updatedAt;
 assert.equal(d.querySelectorAll('[data-activity-memory-id]').length,3,'the serialized page feeds the real consumer');assert.match(d.body.textContent!,/Generated contract result 1/);
 // A second client deletes one result through the real route and another
 // write retitles a second; neither touches the memory_jobs receipt row.
 const removed=await api.request('/api/memories/'+memoryIds[2],{method:'DELETE'});assert.equal(removed.deleted,1);
 const row=node.store.db.prepare('SELECT json FROM memories WHERE id=?').get(memoryIds[0])!;node.store.db.prepare('UPDATE memories SET json=? WHERE id=?').run(JSON.stringify({...JSON.parse(String(row.json)),title:'Retitled by another client'}),memoryIds[0]);
 await act(async()=>click(d,'刷新'));
 assert.equal((await node.app.inject({method:'GET',url:'/api/work-activity/memory%3A'+jobId+'?limit=20',headers:{authorization:'Bearer '+token}})).json().updatedAt,first,'the reread happens against an identical receipt');
 assert.equal(d.querySelectorAll('[data-activity-memory-id]').length,2,'the real delete removes the rendered row');assert.match(d.body.textContent!,/Retitled by another client/,'the current serialization reaches the rendered list');
});
