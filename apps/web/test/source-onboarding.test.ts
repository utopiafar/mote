import {pageHash} from '@mote/shared';
import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {ApiError,type Api} from '../src/api';
import {Sources} from '../src/plugins/sources/Sources';
import {resources} from '../src/resource-cache';

configureLocale(()=> 'zh-CN');
const at='2026-11-13T01:00:00Z',runId='11111111-1111-4111-8111-111111111111';
const ref='material:mat_'+'a'.repeat(64)+'@'+'b'.repeat(64);
type Call={path:string;method:string;body?:Record<string,unknown>};
type State={sources:Record<string,unknown>[];materials:Record<string,unknown>[];authority:'on'|'off';view:Record<string,unknown>;cancelledView?:Record<string,unknown>;startError?:ApiError};
const source=(patch:Record<string,unknown>={})=>({id:'generated-files',name:'Generated files',kind:'local-files',deviceId:'generated-mac',platform:'macos',retention:'snapshot',enabled:true,status:{state:'idle'},...patch});
const material=(patch:Record<string,unknown>={})=>({id:'mat_'+'a'.repeat(64),ref,revision:'b'.repeat(64),kind:'mote.file',schemaVersion:1,title:'Generated notes.txt',sequence:1,textLength:24,blockCount:1,coverage:{state:'complete'},origin:{sourceId:'generated-files',externalId:'generated-notes'},retention:{original:'retained'},artifacts:[{key:'extracted-text',state:'ready'}],...patch});
const item=(state:'pending'|'completed'|'cancelled',semantic:'pending'|'ready'|'partial'='pending',value:{ref:string;title:string}={ref,title:'Generated notes.txt'})=>({material:{...value,sourceId:'generated-files'},state,coverage:{sync:{status:'ready'},extraction:{status:'ready'},semantic:{status:semantic}}});
const view=(state:'pending'|'completed'|'cancelled',patch:Record<string,unknown>={})=>({id:runId,revision:state==='pending'?1:2,state,
 coverage:{sync:{completed:1,total:1},extraction:{completed:1,total:1,pending:0},semantic:state==='completed'?{completed:1,total:1}:{completed:0,total:1,pending:1}},
 completed:state==='completed'?1:0,pending:state==='pending'?1:0,failed:0,cancelled:state==='cancelled'?1:0,
 items:[item(state,state==='completed'?'ready':'pending')],...patch});
const capabilities=['http:POST:/api/assistant/onboarding','http:GET:/api/assistant/onboarding/:id','http:POST:/api/assistant/onboarding/:id/cancel'].map(id=>({id,version:'1',surface:'command',featureId:'mote.insights',state:'active'}));
function owner(state:State,calls:Call[]):Api{return {request:async(path:string,init?:RequestInit)=>{
 calls.push({path,method:init?.method??'GET',...(init?.body?{body:JSON.parse(String(init.body))}:{})});
 if(path==='/api/features')return {schemaVersion:1,revision:1,features:[],capabilities};
 if(path==='/api/sources')return {items:state.sources};
 if(path.startsWith('/api/materials?'))return {items:state.materials,nextCursor:null};
 if(path==='/api/library/browse?limit=1')return {sources:[],sourcesTruncated:false};
 if(path==='/api/connectors/status')return {};
 if(path==='/api/model-authorization')return {authorization:{state:state.authority,excludedSourceIds:[]}};
 if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};
 if(path==='/api/assistant/onboarding'&&init?.method==='POST'){if(state.startError)throw state.startError;return structuredClone(state.view);}
 if(path.startsWith('/api/assistant/onboarding/')&&path.includes('/cancel')){state.view=state.cancelledView??view('cancelled');return structuredClone(state.view);}
 if(path.startsWith('/api/assistant/onboarding/'))return structuredClone(state.view);
 if(path.endsWith('/context'))return {sourceId:path.split('/')[3],version:0,description:''};
 throw Error('Unexpected generated request '+path);
 }} as Api;}
async function fixture(t:any){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/connections',pretendToBeVisual:true}),previous=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 dom.window.scrollTo=()=>{};
 const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());for(const [key,value]of previous)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);dom.window.close();});
 return {root,d:dom.window.document};
}
const button=(d:Document,action:string)=>d.querySelector<HTMLButtonElement>(`button[data-onboarding-action="${action}"]`);
const stage=(panel:Element,name:string)=>panel.querySelector(`[data-stage="${name}"]`)!;
const itemStates=(panel:Element)=>[...panel.querySelectorAll('[data-item-state]')].map(item=>item.getAttribute('data-item-state'));
async function flush(){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});}
const render=(root:ReturnType<typeof import('react-dom/client').createRoot>,api:Api,onAdd?:()=>void)=>act(async()=>root.render(React.createElement(Sources,{api,onOpen:()=>{},onImport:()=>{},onAdd})));

test('empty connection shows separate stages, upload policies and an add action without another permission switch',async t=>{
 const {root,d}=await fixture(t);let added=0;const state:State={sources:[],materials:[],authority:'off',view:view('pending')};
 await render(root,owner(state,[]),()=>{added++;});
 const panel=d.querySelector('.source-onboarding')!;assert.ok(panel);
 assert.equal(stage(panel,'sync').getAttribute('data-state'),'empty');
 assert.equal(stage(panel,'extraction').getAttribute('data-state'),'unsupported');
 assert.equal(stage(panel,'semantic').getAttribute('data-state'),'unsupported');
 assert.ok(panel.querySelector('[role=status][data-model-state=off]'));
 assert.ok(panel.querySelector('.source-onboarding-retention'));
 assert.ok(panel.querySelector('.source-onboarding-empty [data-onboarding-action=add]'));
 assert.equal(panel.querySelector('input[type=checkbox]'),null);
 assert.equal(panel.querySelector('[role=switch]'),null);
 assert.equal(panel.querySelector('.file-retention-settings'),null,'retention stays in the existing source settings');
 assert.equal(button(d,'start')!.disabled,true);
 await act(async()=>button(d,'add')!.click());assert.equal(added,1);
});

test('revoked and syncing sources, partial extraction and a closed background model stay separate',async t=>{
 const {root,d}=await fixture(t);const state:State={sources:[source({status:{state:'permission_required'}}),source({id:'generated-sync',name:'Generated syncing',status:{state:'syncing'}}),source({id:'generated-error',name:'Generated error',status:{state:'error'}})],
  materials:[material({coverage:{state:'partial'},artifacts:[{key:'extracted-text',state:'unavailable'}]})],authority:'off',view:view('pending')};
 await render(root,owner(state,[]));
 const panel=d.querySelector('.source-onboarding')!;
 const syncDetails=stage(panel,'sync').querySelector('small[data-syncing]')!;
 assert.equal(stage(panel,'sync').getAttribute('data-state'),'pending');
 assert.equal(syncDetails.getAttribute('data-syncing'),'1');
 assert.equal(syncDetails.getAttribute('data-revoked'),'1');
 assert.equal(syncDetails.getAttribute('data-attention'),'1');
 assert.equal(stage(panel,'extraction').getAttribute('data-state'),'pending');
 assert.equal(stage(panel,'extraction').querySelector('small')?.getAttribute('data-partial'),'1');
 assert.match(stage(panel,'extraction').textContent!,/0 \/ 1/);
 assert.equal(stage(panel,'semantic').getAttribute('data-state'),'unsupported');
 assert.ok(panel.querySelector('[role=status][data-model-state=off]'));
 assert.equal(panel.querySelector('[role=switch]'),null);
 const checkbox=panel.querySelector<HTMLInputElement>('input[type=checkbox]')!;assert.equal(checkbox.disabled,false);
 await act(async()=>checkbox.click());assert.equal(button(d,'start')!.disabled,false);
});

test('owner start, cancellation and continuation use the real onboarding route and keep completed coverage',async t=>{
 const {root,d}=await fixture(t),calls:Call[]=[];const second={ref:'material:mat_'+'c'.repeat(64)+'@'+'d'.repeat(64),title:'Generated second.txt'};
 const pending={...view('pending'),coverage:{sync:{completed:2,total:2},extraction:{completed:2,total:2,pending:0},semantic:{completed:1,total:2,pending:1}},completed:1,pending:1,items:[item('completed','ready'),item('pending','pending',second)]};
 const cancelled={...pending,state:'cancelled',revision:2,cancelled:1,pending:0,items:[item('completed','ready'),item('cancelled','pending',second)]};
 const state:State={sources:[source()],materials:[material(),material({id:'mat_'+'c'.repeat(64),ref:second.ref,revision:'d'.repeat(64),title:second.title,origin:{sourceId:'generated-files',externalId:'generated-second'}})],authority:'off',view:pending,cancelledView:cancelled};
 const api=owner(state,calls);await render(root,api);
 const checkboxes=[...d.querySelectorAll<HTMLInputElement>('.source-onboarding input[type=checkbox]')];assert.equal(checkboxes.length,2);for(const checkbox of checkboxes)await act(async()=>checkbox.click());
 await act(async()=>button(d,'start')!.click());await flush();
 const start=calls.find(call=>call.method==='POST'&&call.path==='/api/assistant/onboarding')!;assert.ok(start);assert.match(String(start.body!.requestId),/^[0-9a-f-]{36}$/);
 assert.deepEqual(start.body!.scope,{kind:'selection',sourceIds:['generated-files']});assert.deepEqual(start.body!.materialRefs,[ref,second.ref]);
 assert.ok(d.querySelector('.source-onboarding-stage[data-stage=semantic]')!.textContent!.includes('1 / 2'));
 assert.deepEqual(itemStates(d.querySelector('.source-onboarding-items')!),['completed','pending']);
 assert.ok(button(d,'cancel'));
 assert.equal(button(d,'continue'),null,'an active run offers cancel, not a duplicate continue start');
 assert.equal(calls.some(call=>call.path==='/api/model-authorization/commands'),false,'starting onboarding does not flip another permission switch');
 await act(async()=>button(d,'cancel')!.click());await flush();
 const cancel=calls.find(call=>call.method==='POST'&&call.path.endsWith('/cancel'))!;assert.ok(cancel);assert.equal(cancel.body!.expectedRevision,1);assert.deepEqual(cancel.body!.scope,{kind:'selection',sourceIds:['generated-files']});
 assert.deepEqual(itemStates(d.querySelector('.source-onboarding-items')!),['completed','cancelled']);
 const continueButton=button(d,'continue')!;assert.ok(continueButton);
 state.view=pending;await act(async()=>continueButton.click());await flush();
 const starts=calls.filter(call=>call.method==='POST'&&call.path==='/api/assistant/onboarding');assert.equal(starts.length,2);assert.notEqual(starts[1].body!.requestId,start.body!.requestId);
 assert.deepEqual(starts[1].body!.materialRefs,[second.ref]);
 assert.deepEqual(starts[1].body!.scope,{kind:'selection',sourceIds:['generated-files']});
 state.view={...view('completed'),coverage:{sync:{completed:2,total:2},extraction:{completed:2,total:2,pending:0},semantic:{completed:2,total:2}},completed:2,pending:0,items:[item('completed','ready'),item('completed','ready',second)]};const runPath=calls.find(call=>call.method==='GET'&&call.path.startsWith('/api/assistant/onboarding/'))!.path;
 await act(async()=>resources(api).get(runPath).refresh());await flush();
 const completed=d.querySelector('[data-onboarding-panel][data-run-state=completed]')!;
 assert.ok(completed.querySelector('.source-onboarding-complete[role=status]'));
 assert.deepEqual(itemStates(completed),['completed','completed']);
 assert.equal(stage(completed,'semantic').getAttribute('data-state'),'ready');
 assert.equal(button(d,'cancel'),null);
});

test('late material appears as a new selectable update without claiming it was already understood',async t=>{
 const {root,d}=await fixture(t),calls:Call[]=[];const state:State={sources:[source()],materials:[material()],authority:'on',view:view('pending')};
 const api=owner(state,calls);await render(root,api);
 assert.ok(d.querySelector('.source-onboarding [role=status][data-model-state=on]'));
 state.materials=[material(),material({id:'mat_'+'c'.repeat(64),ref:'material:mat_'+'c'.repeat(64)+'@'+'d'.repeat(64),revision:'d'.repeat(64),title:'Generated late note.txt',origin:{sourceId:'generated-files',externalId:'generated-late'}})];
 await act(async()=>resources(api).get('/api/materials?limit=100').refresh());await flush();
 const panel=d.querySelector('.source-onboarding')!;
 const arrived=panel.querySelector<HTMLInputElement>('[data-material-ref^="material:mat_cc"] input')!;
 assert.equal(arrived.disabled,false);
 assert.equal(arrived.checked,false);
 assert.ok(panel.querySelector('.source-onboarding-arrival[role=status]'));
 assert.equal(stage(panel,'semantic').getAttribute('data-state'),'unsupported');
});

test('a failed start keeps the chosen material and shows a recovery path',async t=>{
 const {root,d}=await fixture(t);const state:State={sources:[source()],materials:[material()],authority:'off',view:view('pending'),startError:new ApiError('Memory model is unavailable',409)};
 await render(root,owner(state,[]));
 const checkbox=d.querySelector<HTMLInputElement>('.source-onboarding input[type=checkbox]')!;await act(async()=>checkbox.click());
 await act(async()=>button(d,'start')!.click());await flush();
 const panel=d.querySelector('.source-onboarding')!;
 assert.ok(panel.querySelector('.source-onboarding-error [role=alert]'));
 assert.ok(panel.querySelector('a[href="#/system/models"]'));
 assert.equal(panel.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,true);
 assert.equal(button(d,'start')!.disabled,false);
});

test('partial acquaintance shows available results and a concrete owner question without completing or answering it',async t=>{
 const {root,d}=await fixture(t),calls:Call[]=[],questionId='22222222-2222-4222-8222-222222222222';
 const partial={...item('pending','partial'),reason:'memory_owner_input_required',memory:{id:runId,status:'waiting_for_input',completedBatches:1,totalBatches:1},
  result:{reason:'Generated release checklist is available; participant identity is unknown.',cardIds:[runId],commitmentIds:[]},
  ownerQuestions:[{id:questionId,revision:1,state:'open',prompt:'Generated question: are you the participant describing work pressure?',reason:'Generated source does not establish the participant identity.'}]};
 const state:State={sources:[source()],materials:[material()],authority:'off',view:view('pending',{items:[partial],coverage:{sync:{completed:1,total:1},extraction:{completed:1,total:1},semantic:{completed:0,total:1,partial:1,pending:0,failed:0}}})};
 const api=owner(state,calls);await render(root,api);await act(async()=>d.querySelector<HTMLInputElement>('.source-onboarding-material input')!.click());await act(async()=>button(d,'start')!.click());await flush();
 const panel=d.querySelector('.source-onboarding')!;
 assert.ok(panel.querySelector('[data-item-state=pending] [role=status]'));
 assert.ok(panel.querySelector('[data-item-state=pending] [data-onboarding-question]'));
 assert.match(panel.querySelector('[data-onboarding-result]')!.textContent!,/release checklist is available/);
 assert.equal(panel.querySelector('[data-onboarding-result] a'),null);
 const question=panel.querySelector<HTMLAnchorElement>('[data-onboarding-question] a')!;assert.ok(question);assert.equal(question.getAttribute('href'),pageHash('chat',{question:questionId}));
 assert.match(question.textContent!,/are you the participant/);assert.match(panel.querySelector('[data-onboarding-question]')!.textContent!,/does not establish/);
 assert.equal(panel.querySelector('[data-stage="semantic"]')?.getAttribute('data-state'),'partial');assert.match(panel.querySelector('[data-stage="semantic"]')!.textContent!,/0 \/ 1/);
 assert.equal(panel.querySelector('.source-onboarding-complete'),null);assert.equal(panel.querySelector('a[href="#/system/models"]'),null);
 assert.ok(button(d,'cancel'));assert.equal(button(d,'continue'),null);
 await act(async()=>question.click());await flush();assert.equal(d.defaultView!.location.hash,pageHash('chat',{question:questionId}));
 assert.equal(calls.some(call=>call.method==='POST'&&(call.path.includes('/reply')||call.path.includes('/cancel'))),false);
});
