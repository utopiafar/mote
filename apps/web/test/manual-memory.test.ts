import '@mote/shared/i18n-all';
import {modelView} from './fixtures/model-settings';
import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {Memories} from '../src/plugins/memory/index.js';
import {MemoryProgress,type MemoryJob} from '../src/plugins/memory/index.js';
import type {Api} from '../src/api.js';
import {configureLocale,getLocale} from '@mote/shared/i18n';
import {failureMessage} from '../src/failure-message.js';
import {captureDateRange,localDateInput} from '../src/capture-presentation';
import {resources} from '../src/resource-cache';
import {webFeatures} from '../src/features/registry';

async function fixture(t:import('node:test').TestContext){
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),backups=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){backups.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
  Object.assign(dom.window.HTMLElement.prototype,{attachEvent:()=>{},detachEvent:()=>{}});
  dom.window.localStorage.setItem('mote.language','zh-CN');const root=createRoot(dom.window.document.getElementById('root')!);
  t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of backups){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
  return {root,d:dom.window.document};
}
const personal={id:'mote.personal-memory',version:'2'},coding={id:'mote.coding-memory',version:'2'};
const summary={total:2,waiting:1,blocked:0,stale:0,completed:1};
const job:MemoryJob={id:'generated-memory',status:'waiting_for_input',createdAt:'2026-09-27T00:00:00Z',updatedAt:'2026-09-27T00:00:00Z',evidenceIds:[],totalBatches:1,completedBatches:1,failedBatches:0,skippedChunks:0,memoryIds:['generated-complete'],skillVersion:'fixture',inputPlans:summary,recipeProgress:[{recipe:personal,inputs:{...summary,total:1,waiting:0},completedBatches:1,failedBatches:0,reasons:[]},{recipe:coding,inputs:{...summary,total:1,completed:0},completedBatches:0,failedBatches:0,reasons:[{code:'memory_input_pending',required:['extracted-text'],materialRef:'material:generated'}]}],memoryCount:['generated-complete'].length};

test('manual recipe choices travel only with this extraction request and survive an unsuccessful submission',async t=>{
  const {root,d}=await fixture(t),writes:{path:string;body:Record<string,unknown>}[]=[];
  const api={request:async(path:string,init?:RequestInit)=>{
    if(init?.method==='POST'){writes.push({path,body:JSON.parse(String(init.body))});throw Error('Generated request failure');}
    if(path==='/api/memory-recipes')return {items:[{...personal,available:true},{...coding,available:true}]};
    if(path==='/api/model-settings')return modelView();
    if(path==='/api/memory-settings')return {settings:{consolidation:{enabled:false,maxItems:5}},extensions:[]};
    if(path.startsWith('/api/library/browse?'))return {items:[],nextCursor:null};
    if(path.startsWith('/api/memories?'))return {items:[],nextCursor:null};
    if(path==='/api/memory-jobs')return {items:[]};
    if(path==='/api/execution-settings')return {queues:{agents:{active:0,waiting:0,limit:1},llm:{active:0,waiting:0,limit:1}}};
    if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};
    assert.fail('Unexpected request '+path);
  },setAgentTimeout:()=>{}} as Api;
  await act(async()=>root.render(React.createElement(Memories,{api,range:{after:'2026-09-01T00:00:00Z'},onOpen:()=>{}})));
  await act(async()=>Array.from(d.querySelectorAll('button')).find(button=>button.textContent==='手动提取记忆')!.click());
  await act(async()=>Array.from(d.querySelectorAll('button')).find(button=>button.textContent==='按时间范围提取')!.click());
  const options=d.querySelector<HTMLDetailsElement>('.memory-work-scope .memory-processing-options')!;assert.equal(options.open,false,'processing options start folded independently of the work page');
  await act(async()=>options.querySelector('summary')!.click());assert.equal(options.open,true);
  for(const input of d.querySelectorAll<HTMLInputElement>('.manual-memory-recipes input'))await act(async()=>input.click());
  const submit=()=>act(async()=>Array.from(d.querySelectorAll('button')).find(button=>button.textContent==='开始提取')!.click());
  await act(async()=>options.querySelector('summary')!.click());assert.equal(options.open,false);
  await submit();assert.deepEqual(writes[0].body.recipes,[personal,coding]);assert.equal(writes[0].body.after,captureDateRange(localDateInput(new Date('2026-09-01T00:00:00Z')),localDateInput(new Date())).after);assert.equal(writes[0].path,'/api/memory-jobs');
  assert.equal(options.open,false,'an unsuccessful request does not expose the advanced options');
  await act(async()=>options.querySelector('summary')!.click());
  assert.equal(d.querySelectorAll('.manual-memory-recipes input:checked').length,2);assert.match(d.body.textContent!,/Generated request failure/);
  await act(async()=>Array.from(d.querySelectorAll('button')).find(button=>button.textContent==='恢复默认提取方式')!.click());
  await submit();assert.equal(writes[1].body.recipes,undefined);assert.ok(writes.every(write=>write.path==='/api/memory-jobs'));
});

test('waiting recipes retain result access, processing links and pause/cancel controls; paused jobs cannot bypass resume',async t=>{
  const {root,d}=await fixture(t),actions:string[]=[],opened:string[]=[];let viewed=0,retried=0;
  const render=(value:MemoryJob)=>act(async()=>root.render(React.createElement(MemoryProgress,{job:value,onAction:action=>actions.push(action),onOpen:ref=>opened.push(ref),onView:()=>viewed++,onRetry:()=>retried++})));
  const click=(text:string)=>act(async()=>Array.from(d.querySelectorAll('button')).find(button=>button.textContent===text)!.click());
  await render(job);assert.match(d.body.textContent!,/等待资料处理/);assert.equal(d.querySelector('progress')?.value,1);assert.equal(d.querySelector('progress')?.max,2);
  await click('查看记忆');await click('查看来源与处理');await click('暂停等待与后续批次');await click('取消未完成方案');
  assert.equal(viewed,1);assert.deepEqual(opened,['material:generated']);assert.deepEqual(actions,['pause','cancel']);
  const blocked={...job,inputPlans:{...summary,waiting:0,blocked:1}};
  await render({...blocked,status:'failed'});await click('重新检查未完成方案');assert.equal(retried,1);
  await render({...blocked,status:'paused'});assert.doesNotMatch(d.body.textContent!,/重新检查未完成方案/);await click('继续整理');assert.equal(actions.at(-1),'resume');
  await render({...job,status:'cancelled'});assert.doesNotMatch(d.body.textContent!,/重新检查未完成方案|取消未完成方案|继续整理/);await click('查看记忆');assert.equal(viewed,2);
});

test('a legacy attribution task without published Material retains reviewed results without promising automatic processing',async t=>{
 const {root,d}=await fixture(t),actions:string[]=[];let viewed=0,retried=0;
 const blocked:MemoryJob={...job,errorCode:'memory_owner_material_required',failedBatches:1,inputPlans:{total:0,waiting:0,blocked:0,stale:0,completed:0},recipeProgress:[],availableAt:Date.now()+60000};
 const render=(value:MemoryJob)=>act(async()=>root.render(React.createElement(MemoryProgress,{job:value,onAction:action=>actions.push(action),onOpen:()=>{},onView:()=>viewed++,onRetry:()=>retried++})));
 await render(blocked);
 assert.match(d.querySelector('.workflow-line strong')!.textContent!,/需要正式资料确认归属/);
 assert.match(d.querySelector('.notice')!.textContent!,/不能自动继续.*已审核结果保留.*取消未完成任务/);
 assert.doesNotMatch(d.body.textContent!,/等待资料处理|就绪后会自动继续|已就绪的方案已继续处理|下次可运行时间/);
 await act(async()=>Array.from(d.querySelectorAll('button')).find(button=>button.textContent==='重新检查未完成方案')!.click());assert.equal(retried,1,'explicit manual recheck remains available');
 await act(async()=>Array.from(d.querySelectorAll('button')).find(button=>button.textContent==='查看记忆')!.click());
 await act(async()=>Array.from(d.querySelectorAll('button')).find(button=>button.textContent==='取消未完成方案')!.click());
 assert.equal(viewed,1);assert.deepEqual(actions,['cancel']);
 // Published Material that is still processing retains its normal wait and source link.
 await render({...job,errorCode:'memory_input_pending'});
 assert.match(d.querySelector('.workflow-line strong')!.textContent!,/等待资料处理/);
 assert.match(d.body.textContent!,/就绪后会自动继续/);
 assert.ok(Array.from(d.querySelectorAll('button')).some(button=>button.textContent==='查看来源与处理'));
 const previousLocale=getLocale();t.after(()=>configureLocale(()=>previousLocale));configureLocale(()=>'en');
 await render(blocked);
 assert.match(d.querySelector('.workflow-line strong')!.textContent!,/Published material is required/);
 assert.match(d.querySelector('.notice')!.textContent!,/cannot continue automatically.*Reviewed results are retained/);
 assert.doesNotMatch(failureMessage({code:'memory_owner_material_required',safeMessage:'PRIVATE EXTERNAL DETAIL'}),/PRIVATE EXTERNAL DETAIL/);
});

test('Memory deletion retains accurate external clearing status after the card disappears and clears it on node change',async t=>{
 const {root,d}=await fixture(t);
 const memory={id:'generated-deletion',title:'Generated retained body',statement:'Generated fixture statement',uncertainty:'Fixture only',status:'published',createdAt:'2026-10-12T00:00:00Z',evidenceIds:[],evidence:[]};
 let deleted=false,receipt={deleted:1,externalErase:'pending',physicalEraseVerified:false};
 const api={request:async(path:string,init?:RequestInit)=>{
  if(init?.method==='DELETE'){assert.equal(path,'/api/memories/'+memory.id);deleted=true;return receipt;}
  if(path==='/api/model-settings')return modelView();
  if(path==='/api/memory-recipes')return {items:[]};
  if(path.startsWith('/api/memories?'))return {items:deleted?[]:[memory],nextCursor:null};
  if(path.startsWith('/api/memories/'+memory.id))return memory;
  if(path==='/api/memory-jobs')return {items:[]};
  if(path==='/api/memory-settings')return {settings:{consolidation:{maxItems:30}},extensions:[]};
  if(path==='/api/execution-settings')return {queues:{agents:{active:0,waiting:0,limit:1},llm:{active:0,waiting:0,limit:1}}};
  if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};
  assert.fail('Unexpected request '+path);
 },setAgentTimeout:()=>{}} as Api;
 const render=(owner=api)=>act(async()=>root.render(React.createElement(Memories,{api:owner,range:{},onOpen:()=>{}})));
 const click=(text:string)=>act(async()=>Array.from(d.querySelectorAll('button')).find(button=>button.textContent===text||button.querySelector('strong')?.textContent===text)!.click());
 await render();await click(memory.title);await click('更多');await click('删除记忆');await click('确认删除');
 assert.match(d.querySelector('.notice[role=status]')!.textContent!,/外部清除仍待确认/);
 assert.equal(d.querySelectorAll('.workspace-select').length,0);
 assert.doesNotMatch(d.querySelector('.notice[role=status]')!.textContent!,/已物理擦除/);
 const other={...api,request:api.request.bind(api)} as Api;await render(other);
 assert.equal(d.querySelector('.notice[role=status]'),null,'a previous node receipt does not appear under a new connection');
 deleted=false;receipt={deleted:1,externalErase:'acknowledged',physicalEraseVerified:false};await render(api);await click(memory.title);await click('更多');await click('删除记忆');await click('确认删除');
 assert.match(d.querySelector('.notice[role=status]')!.textContent!,/已确认移除当前记录，物理擦除尚未核验/);
});

test('search remains available with filters collapsed and returning from a memory preserves the exact list and opener',async t=>{
 const {root,d}=await fixture(t),paths:string[]=[],memory={id:'generated-search',title:'Generated searchable lesson',statement:'Generated original statement preview',uncertainty:'Only this generated evidence',status:'published',createdAt:'2026-10-12T00:00:00Z',evidenceIds:[],evidence:[]};
 let query='';const api={request:async(path:string)=>{
  paths.push(path);
  if(path==='/api/model-settings')return modelView();
  if(path==='/api/memory-recipes'||path==='/api/memory-jobs'||path==='/api/context-trees')return {items:[]};
  if(path==='/api/memory-settings')return {settings:{consolidation:{maxItems:30}},extensions:[]};
  if(path.startsWith('/api/memories?')){query=new URL('http://localhost'+path).searchParams.get('query')??'';return {items:[memory],nextCursor:null};}
  if(path.startsWith('/api/memories/'+memory.id))return memory;
  if(path==='/api/execution-settings')return {queues:{agents:{active:0,waiting:0,limit:1},llm:{active:0,waiting:0,limit:1}}};
  if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};
  assert.fail('Unexpected request '+path);
 }} as Api;
 await act(async()=>root.render(React.createElement(Memories,{api,range:{},onOpen:()=>{}})));
 const input=d.querySelector<HTMLInputElement>('#memory-search')!;
 assert.equal(input.closest('[hidden]'),null,'search is available before opening optional filters');
 assert.equal(d.querySelector<HTMLElement>('#memory-filter-panel')!.hidden,true);
 await act(async()=>{input.focus();Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(input,'generated original');input.dispatchEvent(new window.Event('input',{bubbles:true}));input.dispatchEvent(new window.Event('change',{bubbles:true}));input.dispatchEvent(new window.KeyboardEvent('keyup',{bubbles:true,key:'t'}));});
 await act(async()=>input.form!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
 assert.equal(query,'generated original','the request searches the real list scope');
 const row=d.querySelector<HTMLButtonElement>('.workspace-select')!;row.focus();
 assert.match(row.textContent!,/Generated original statement preview/,'the list previews stored statement text');
 await act(async()=>row.click());assert.match(d.querySelector('.memory-detail')!.textContent!,/Generated original statement preview/);
 await act(async()=>d.querySelector<HTMLButtonElement>('.memory-detail-back')!.click());
 assert.equal(d.querySelector('.memory-detail'),null);assert.equal(d.activeElement,row);assert.equal(input.value,'generated original');
 assert.ok(paths.filter(path=>path.startsWith('/api/memories?')).every(path=>new URL('http://localhost'+path).searchParams.get('layer')==='memory'));
 await act(async()=>d.querySelector<HTMLButtonElement>('.memory-filter-chip')!.click());assert.equal(input.value,'');assert.equal(query,'');
});

for(const operation of ['correction','export'] as const)test('a late Memory '+operation+' cannot select, export or read a previous owner record after a node switch',async t=>{
 const {root,d}=await fixture(t),old={id:'generated-old-owner',title:'Generated owner A Memory',statement:'Generated owner A evidence',status:'published',createdAt:'2026-10-12T00:00:00Z',version:1,fingerprint:'a'.repeat(64),evidenceIds:[],evidence:[]},next={...old,id:'generated-new-owner',title:'Generated owner B Memory',statement:'Generated owner B evidence',fingerprint:'b'.repeat(64)};
 let finish!:(value:unknown)=>void,signal:AbortSignal|undefined,rawReads=0,waiting=false;const pending=new Promise(resolve=>finish=resolve),newReads:string[]=[];
 const read=(memory:typeof old,path:string)=>{if(path==='/api/model-settings')return modelView();if(path.startsWith('/api/memories?'))return {items:[memory],nextCursor:null};if(path.startsWith('/api/memories/'))return memory;if(path==='/api/memory-settings')return {settings:{consolidation:{maxItems:30}},extensions:[]};if(path==='/api/execution-settings')return {queues:{agents:{active:0,waiting:0,limit:1},llm:{active:0,waiting:0,limit:1}}};if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};return {items:[]};};
 const firstApi={request:async(path:string,init?:RequestInit)=>{if((operation==='correction'&&init?.method==='POST')||(operation==='export'&&waiting&&path==='/api/memories/'+old.id)){signal=init?.signal as AbortSignal;return pending;}return read(old,path);},raw:async()=>{rawReads++;return new Response('Generated owner A private export');},setAgentTimeout:()=>{}} as Api;
 const secondApi={request:async(path:string)=>{newReads.push(path);return read(next,path);},setAgentTimeout:()=>{}} as Api;const render=(api:Api)=>act(async()=>root.render(React.createElement(Memories,{api,range:{},onOpen:()=>{}}))),click=(text:string)=>act(async()=>Array.from(d.querySelectorAll('button')).find(button=>button.textContent===text||button.querySelector('strong')?.textContent===text)!.click());
 await render(firstApi);await click(old.title);await click('更多');if(operation==='correction'){await click('纠正这条记忆');await act(async()=>{const input=d.querySelector<HTMLTextAreaElement>('.memory-correction textarea')!;input.focus();Object.getOwnPropertyDescriptor(d.defaultView!.HTMLTextAreaElement.prototype,'value')!.set!.call(input,'Generated explicit correction');input.dispatchEvent(new window.Event('input',{bubbles:true}));input.dispatchEvent(new window.KeyboardEvent('keyup',{bubbles:true,key:'a'}));});assert.equal(Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='保存纠正')!.disabled,false);await click('保存纠正');}else{waiting=true;await click('下载文本');}assert.ok(signal);
 await render(secondApi);assert.equal(signal!.aborted,true);assert.equal(newReads.some(path=>path.includes(old.id)),false,'a new API never receives the previous selected UUID');await act(async()=>finish({...old,id:'generated-late-result',title:'STALE OWNER A RESULT'}));assert.equal(rawReads,0,'an aborted export verification never fetches previous owner bytes');assert.doesNotMatch(d.body.textContent!,/STALE OWNER A RESULT|Generated owner A evidence/);await click(next.title);assert.match(d.querySelector('.memory-detail')!.textContent!,/Generated owner B evidence/);
});

for(const outcome of ['success','failure'] as const)test('a late deletion '+outcome+' belongs to its selected Memory when a browser route selects another record',async t=>{
 const {root,d}=await fixture(t),first={id:'generated-delete-first',title:'Generated deletion A',statement:'Generated original A',createdAt:'2026-10-12T00:00:00Z',status:'published',evidenceIds:[],evidence:[]},second={...first,id:'generated-delete-second',title:'Generated deletion B',statement:'Generated original B'};
 let resolve!:(value:unknown)=>void,reject!:(reason:unknown)=>void;const pending=new Promise((ok,no)=>{resolve=ok;reject=no;});
 const api={request:async(path:string,init?:RequestInit)=>{if(init?.method==='DELETE')return pending;if(path==='/api/model-settings')return modelView();if(path.startsWith('/api/memories?'))return {items:[first,second],nextCursor:null};if(path.startsWith('/api/memories/'))return path.includes(second.id)?second:first;if(path==='/api/memory-settings')return {settings:{consolidation:{maxItems:30}},extensions:[]};if(path==='/api/execution-settings')return {queues:{agents:{active:0,waiting:0,limit:1},llm:{active:0,waiting:0,limit:1}}};if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};return {items:[]};},setAgentTimeout:()=>{}} as Api;
 const click=(text:string)=>act(async()=>Array.from(d.querySelectorAll('button')).find(button=>button.textContent===text||button.querySelector('strong')?.textContent===text)!.click());await act(async()=>root.render(React.createElement(Memories,{api,range:{},onOpen:()=>{}})));await click(first.title);await click('更多');await click('删除记忆');await click('确认删除');
 await act(async()=>{window.location.hash='#/library?view=memories&memory='+second.id;window.dispatchEvent(new window.HashChangeEvent('hashchange'));});assert.match(d.querySelector('.memory-detail')!.textContent!,/Generated original B/);assert.equal(d.querySelector('[role=alertdialog]'),null,'route selection closes the previous record confirmation');
 await act(async()=>{if(outcome==='success')resolve({deleted:1,externalErase:'unknown',physicalEraseVerified:false});else reject(Error('Generated old deletion failure'));});assert.match(d.querySelector('.memory-detail')!.textContent!,/Generated original B/);assert.doesNotMatch(d.body.textContent!,/Generated old deletion failure|外部清除仍待确认/);assert.equal(d.querySelector('[role=alertdialog]'),null);
});


test('proposed status filters the current server page and resets its previous cursor without hiding search',async t=>{
 const {root,d}=await fixture(t),paths:string[]=[];
 const api={request:async(path:string)=>{
  if(path.startsWith('/api/memories?')){paths.push(path);const q=new URL('http://localhost'+path).searchParams;return {items:[],nextCursor:q.has('status')?null:'generated-cursor'};}
  if(path==='/api/model-settings')return modelView();
  if(['/api/memory-recipes','/api/memory-jobs','/api/context-trees'].includes(path))return {items:[]};
  if(path==='/api/memory-settings')return {settings:{consolidation:{maxItems:30}},extensions:[]};
  if(path==='/api/execution-settings')return {queues:{agents:{active:0,waiting:0,limit:1},llm:{active:0,waiting:0,limit:1}}};
  if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};
  assert.fail('Unexpected request '+path);
 }} as Api;
 await act(async()=>root.render(React.createElement(Memories,{api,range:{},onOpen:()=>{}})));
 const click=(text:string)=>act(async()=>Array.from(d.querySelectorAll('button')).find(button=>button.textContent?.trim()===text)!.click());
 await click('下一页');assert.equal(new URL('http://localhost'+paths.at(-1)).searchParams.get('cursor'),'generated-cursor');
 await click('筛选 ⌄');await click('待重新处理');
 const selected=new URL('http://localhost'+paths.at(-1)).searchParams;assert.equal(selected.get('status'),'proposed');assert.equal(selected.has('cursor'),false);
 assert.equal(d.querySelector('.workspace-list-heading h2')?.textContent,'待重新处理');assert.match(d.body.textContent!,/当前筛选下没有匹配/);assert.equal(d.querySelector('#memory-search')!.closest('[hidden]'),null);
 await click('待重新处理 ×');assert.equal(new URL('http://localhost'+paths.at(-1)).searchParams.has('status'),false);
});

test('closed developer tools never mount an execution reader and opening starts its five-second reads',async t=>{
 const{root,d}=await fixture(t);t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const paths:string[]=[],api={request:async(path:string)=>{
  paths.push(path);
  if(path==='/api/model-settings')return modelView();
  if(path==='/api/execution-settings')return{queues:{agents:{active:0,waiting:0,limit:1},llm:{active:0,waiting:0,limit:1}}};
  if(path.startsWith('/api/operations/changes'))return{ids:[],cursor:0,hasMore:false,reset:false};
  return{items:[],nextCursor:null};
 }} as Api,reads=()=>paths.filter(path=>path==='/api/execution-settings').length;
 await act(async()=>root.render(React.createElement(Memories,{api,range:{},onOpen:()=>{}})));
 assert.equal(reads(),0);
 for(let step=0;step<12;step++)await act(async()=>t.mock.timers.tick(5000));
 assert.equal(reads(),0,'a closed developer panel performs no execution reads over sixty seconds');
 const toggle=()=>act(async()=>[...d.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='历史与管理')!.click());
 await toggle();assert.equal(reads(),1,'opening the actual developer panel reads immediately');
 assert.equal(d.querySelector<HTMLDetailsElement>('.memory-developer-tools')!.open,true);
 await act(async()=>t.mock.timers.tick(5000));assert.equal(reads(),2);
 const disclosure=d.querySelector<HTMLDetailsElement>('.memory-developer-tools')!;
 const summary=()=>act(async()=>{disclosure.querySelector<HTMLElement>(':scope > summary')!.click();disclosure.dispatchEvent(new window.Event('toggle'));});
 await summary();assert.equal(disclosure.open,false);const collapsed=reads();
 await act(async()=>resources(api).invalidate(path=>path==='/api/execution-settings'));
 for(let step=0;step<12;step++)await act(async()=>t.mock.timers.tick(5000));
 assert.equal(reads(),collapsed,'closing through the native summary also releases the execution reader');
 await summary();assert.equal(disclosure.open,true);assert.equal(reads(),collapsed+1,'reopening through the summary reads immediately');
 await act(async()=>t.mock.timers.tick(5000));assert.equal(reads(),collapsed+2);
 await act(async()=>[...d.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='手动整理记忆')!.click());
 assert.equal(d.querySelector('.memory-browse-stage')!.hasAttribute('hidden'),true);assert.equal(disclosure.open,true,'the disclosure state is retained behind the work page');
 const workspace=reads();await act(async()=>resources(api).invalidate(path=>path==='/api/execution-settings'));
 for(let step=0;step<12;step++)await act(async()=>t.mock.timers.tick(5000));
 assert.equal(reads(),workspace,'the hidden browse stage owns no queue reader during the manual workspace visit');
 await act(async()=>[...d.querySelectorAll<HTMLButtonElement>('.memory-work-stage button')].find(button=>button.textContent==='← 返回')!.click());
 assert.equal(d.querySelector('.memory-browse-stage')!.hasAttribute('hidden'),false);assert.equal(disclosure.open,true);
 assert.equal(reads(),workspace+1,'returning to the still-open disclosure reads fresh immediately');
 await toggle();const closed=reads();
 await act(async()=>resources(api).invalidate(path=>path==='/api/execution-settings'));
 for(let step=0;step<12;step++)await act(async()=>t.mock.timers.tick(5000));
 assert.equal(reads(),closed,'closing unmounts the reader, including change-triggered reads');
});

test('ten actual correction inputs reuse detail JSON and a changed detail updates the consumed formatted value',async t=>{
 const{root,d}=await fixture(t),id='generated-detail-json';
 const initial={id,title:'Generated JSON detail',statement:'Generated initial statement',status:'published',version:1,createdAt:'2026-10-01T00:00:00Z',evidence:[],evidenceIds:[]};
 const updated={...initial,title:'Generated updated JSON detail',statement:'Generated updated statement',version:2};let detail=initial;
 const stringify=JSON.stringify,serialized:{value:unknown;replacer:unknown;space:unknown}[]=[];
 t.mock.method(JSON,'stringify',((value:unknown,replacer?:any,space?:any)=>{if(value===initial||value===updated)serialized.push({value,replacer,space});return stringify(value,replacer,space);}) as typeof JSON.stringify);
 const registration=await webFeatures.install({id:'generated.memo-consumer',version:'1',components:[]},[{surface:'panel',entry:{id:'generated.memo-consumer',kind:'mote.memory',schemaVersion:1,representation:'saved-record',render:({value})=>React.createElement('pre',{'data-detail-json':true},value.text)}}]);
 t.after(()=>registration.dispose());
 const api={request:async(path:string)=>{
  if(path==='/api/model-settings')return modelView();
  if(path.startsWith('/api/memories/'+id))return detail;
  if(path.startsWith('/api/memories?'))return{items:[detail],nextCursor:null};
  if(path.startsWith('/api/operations/changes'))return{ids:[],cursor:0,hasMore:false,reset:false};
  return{items:[],nextCursor:null};
 }} as Api;
 await act(async()=>root.render(React.createElement(Memories,{api,range:{},onOpen:()=>{}})));
 await act(async()=>d.querySelector<HTMLButtonElement>('.workspace-select')!.click());
 await act(async()=>[...d.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='更多')!.click());
 assert.equal(d.querySelector('[data-detail-json]')!.textContent,stringify(initial,null,2));
 assert.equal(serialized.length,1);
 await act(async()=>[...d.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='纠正这条记忆')!.click());
 const input=d.querySelector<HTMLTextAreaElement>('.memory-correction textarea')!;
 await act(async()=>input.focus());
 for(let index=0;index<10;index++)await act(async()=>{
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(input,'Generated correction '+index);
  input.dispatchEvent(new window.Event('input',{bubbles:true}));input.dispatchEvent(new window.Event('change',{bubbles:true}));input.dispatchEvent(new window.KeyboardEvent('keyup',{bubbles:true,key:'x'}));
 });
 assert.equal([...d.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='保存纠正')!.disabled,false,'real correction state received the input events');
 assert.equal(serialized.length,1,'typing ten times does not serialize an unchanged detail');
 detail=updated;await act(async()=>resources(api).invalidate(path=>path.startsWith('/api/memories/'+id)));
 assert.equal(d.querySelector('[data-detail-json]')!.textContent,stringify(updated,null,2));
 assert.equal(serialized.length,2,'a changed detail is serialized once for its real panel consumer');
 assert.ok(serialized.every(call=>call.replacer===null&&call.space===2),'the original JSON format is retained');
 assert.equal(input.value,'Generated correction 9','refreshing detail does not discard the correction draft');
});
