import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {createHash} from 'node:crypto';
import {configureLocale} from '@mote/shared/i18n';
import {Imports} from '../src/Imports.js';
import {ApiError,type Api} from '../src/api.js';
configureLocale(()=> 'zh-CN');
async function fixture(t:any){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 return {root,d:dom.window.document};
}
const button=(d:Document,label:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent?.trim()===label)!;
const now='2026-09-01T08:00:00Z';
function importJob(extra:Record<string,unknown>={}){return {id:'import-generated',name:'Generated originals',status:'completed',createdAt:now,updatedAt:now,instruction:'',archive:{files:1,bytes:9},warnings:[],files:[],captureIds:['generated-record'],progress:{total:1,processed:1,imported:1,duplicates:0},...extra};}
function apiWith(read:(path:string,init?:RequestInit)=>unknown):Api{return {request:async(path:string,init?:RequestInit)=>path.startsWith('/api/operations/changes')?{ids:[],cursor:0,hasMore:false,reset:false}:read(path,init),setAgentTimeout:()=>{}} as Api;}
function view(api:Api,extra:Record<string,unknown>={}){return React.createElement(Imports,{api,onOpen:()=>{},onMemories:()=>{},onSettings:()=>{},onChanged:()=>{},...extra});}
async function select(d:Document,files:File[]){const input=d.querySelector<HTMLInputElement>('input[type=file]')!;Object.defineProperty(input,'files',{value:files,configurable:true});await act(async()=>input.dispatchEvent(new window.Event('change',{bubbles:true})));}
async function submit(d:Document){await act(async()=>d.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));}
async function until(check:()=>boolean){for(let i=0;i<100;i++){if(check())return;await act(async()=>new Promise(resolve=>setTimeout(resolve,10)));}assert.ok(check(),'Generated UI operation did not settle');}

test('media admission distinguishes extraction, search and Memory and retries the existing file',async t=>{
 const {root,d}=await fixture(t),writes:string[]=[],opened:string[]=[];
 const job=importJob({files:[{id:'generated-media',name:'generated.mp3',relativePath:'generated.mp3',sizeBytes:9}],media:[{fileId:'generated-media',captureId:'generated-record',format:{id:'mote.media-format',version:'1',mimeType:'audio/mpeg',reason:'Generated format'},processing:{state:'failed',stage:'extract',error:'unsupported_format'},searchable:false,memory:{state:'failed',jobIds:[]}}]});
 const api=apiWith((path,init)=>{
  if(init?.method==='POST'){writes.push(path);return {queued:true};}
  if(path==='/api/imports')return {items:[job]};if(path==='/api/imports/'+job.id)return job;return {items:[]};
 });
 await act(async()=>root.render(view(api,{onOpen:(id:string)=>opened.push(id)})));await act(async()=>d.querySelector<HTMLButtonElement>('.workspace-select')!.click());
 assert.match(d.body.textContent!,/媒体已接入/);assert.match(d.body.textContent!,/内容提取失败/);assert.match(d.body.textContent!,/尚无可搜索片段/);assert.match(d.body.textContent!,/记忆整理失败/);assert.doesNotMatch(d.body.textContent!,/记录已保存到中央归档/);
 await act(async()=>button(d,'重试处理').click());assert.deepEqual(writes,['/api/files/capture%3Agenerated-record/retry']);
 await act(async()=>button(d,'查看记录').click());assert.deepEqual(opened,['generated-record']);
});

test('import history failures recover without false empty state, and revoked history is removed',async t=>{
 const {root,d}=await fixture(t);let failure=503;
 const api=apiWith(()=>{if(failure)throw new ApiError('Generated read failure',failure);return {items:[importJob()]};});
 await act(async()=>root.render(view(api)));assert.match(d.body.textContent!,/Generated read failure/);assert.doesNotMatch(d.body.textContent!,/你的第一份导入/);
 failure=0;await act(async()=>button(d,'刷新状态').click());assert.equal(d.querySelector('[role=alert]'),null);assert.match(d.body.textContent!,/Generated originals/);
 failure=403;await act(async()=>d.querySelector<HTMLButtonElement>('[aria-label="刷新导入记录"]')!.click());assert.doesNotMatch(d.body.textContent!,/Generated originals/);assert.match(d.body.textContent!,/Generated read failure/);
});

test('uploads freeze the selected intent, pause with files retained, and resume into one import',async t=>{
 const {root,d}=await fixture(t);const uploads:string[]=[],writes:any[]=[];let first=true,signal:AbortSignal|undefined;
 const api=apiWith((path,init)=>{
  if(path==='/api/imports'&&init?.method==='POST'){writes.push(JSON.parse(String(init.body)));return importJob();}
  if(path==='/api/imports')return {items:writes.length?[importJob()]:[]};
  if(path==='/api/import-uploads'){const input=JSON.parse(String(init?.body));uploads.push(input.id);if(first){first=false;signal=init?.signal??undefined;return new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true}));}return {id:input.id,partBytes:4*1024*1024,parts:[]};}
  if(path.includes('/parts/')){const body=init!.body as ArrayBuffer;return {part:0,bytes:body.byteLength,hash:createHash('sha256').update(new Uint8Array(body)).digest('hex')};}
  if(path.endsWith('/commit'))return {id:'archived-generated'};
  throw Error('Unexpected '+path);
 });
 await act(async()=>root.render(view(api)));await select(d,[new File(['generated'],'original.txt')]);await submit(d);
 assert.equal(button(d,'新建导入').disabled,true);assert.equal(button(d,'服务器目录').disabled,true);assert.equal(d.querySelector<HTMLTextAreaElement>('textarea')!.disabled,true);
 await act(async()=>button(d,'暂停上传').click());assert.equal(signal!.aborted,true);assert.match(d.body.textContent!,/上传已暂停/);assert.equal(d.querySelectorAll('.selected-files .file-row').length,1);assert.equal(writes.length,0);
 await submit(d);await until(()=>writes.length===1);assert.equal(writes.length,1);assert.deepEqual(writes[0].archivedFileIds,['archived-generated']);assert.equal(writes[0].processing,'automatic');assert.equal(uploads[0],uploads[1]);assert.match(writes[0].requestId,/^[0-9a-f-]{36}$/);assert.match(d.body.textContent!,/记录已保存/);assert.equal(d.querySelector('[role=alert]'),null);
});

test('leaving an import aborts upload and an uncooperative late response cannot create a job',async t=>{
 const {root,d}=await fixture(t);let resolve!:(value:unknown)=>void,upload:any,signal:AbortSignal|undefined,writes=0;
 const api=apiWith((path,init)=>{if(path==='/api/imports'){if(init?.method==='POST')writes++;return {items:[]};}upload=JSON.parse(String(init?.body));signal=init?.signal??undefined;return new Promise(r=>resolve=r);});
 await act(async()=>root.render(view(api)));await select(d,[new File(['generated'],'original.txt')]);await submit(d);await act(async()=>root.render(null));assert.equal(signal!.aborted,true);
 await act(async()=>resolve({id:upload.id,partBytes:4,parts:[]}));assert.equal(writes,0);
});

test('lost import-create response reuses its request ID and intent changes rotate it',async t=>{
 const {root,d}=await fixture(t),writes:any[]=[];
 const api=apiWith((path,init)=>{
  if(path==='/api/imports'&&init?.method==='POST'){writes.push(JSON.parse(String(init.body)));throw Error('Generated lost response');}
  if(path==='/api/imports')return {items:[]};
  if(path==='/api/import-uploads'){const data=JSON.parse(String(init?.body));return {id:data.id,fileId:'archive:'+data.id,partBytes:4,parts:[]};}
  throw Error('Unexpected '+path);
 });
 await act(async()=>root.render(view(api)));await select(d,[new File(['one'],'one.txt')]);
 await submit(d);await submit(d);assert.equal(writes.length,2);assert.equal(writes[0].requestId,writes[1].requestId);
 await select(d,[new File(['two'],'two.txt')]);await submit(d);assert.notEqual(writes[1].requestId,writes[2].requestId);
});

test('import detail exposes memory pause, resume and cancel and keeps original evidence navigation',async t=>{
 const {root,d}=await fixture(t),actions:string[]=[],opened:string[]=[];let status='running';
 const job={id:'memory-generated',status,createdAt:now,updatedAt:now,evidenceIds:[],totalBatches:3,completedBatches:1,failedBatches:0,skippedChunks:0,memoryIds:[],skillVersion:'fixture'};
 const api=apiWith((path,init)=>{if(path==='/api/imports')return {items:[importJob({memoryJobId:job.id})]};if(init?.method==='POST'){const action=path.split('/').at(-1)!;actions.push(action);status=action==='pause'?'paused':action==='resume'?'running':'cancelled';}return {...job,status};});
 await act(async()=>root.render(view(api,{onOpen:(id:string)=>opened.push(id)})));await act(async()=>d.querySelector<HTMLButtonElement>('.workspace-select')!.click());
 await act(async()=>button(d,'当前批次结束后暂停').click());await act(async()=>button(d,'继续整理').click());await act(async()=>button(d,'取消剩余批次').click());assert.deepEqual(actions,['pause','resume','cancel']);assert.match(d.body.textContent!,/记忆提取已停止/);
 await act(async()=>button(d,'查看记录 1').click());assert.deepEqual(opened,['generated-record']);
});

test('running import exposes cancellation, keeps originals and requires explicit retry',async t=>{
 const {root,d}=await fixture(t);let status='preparing';const actions:string[]=[];
 const job=()=>importJob({status,captureIds:[],files:[{id:'original',name:'generated.custom',relativePath:'generated.custom',sizeBytes:9}],progress:{total:0,processed:0,imported:0,duplicates:0}});
 const api=apiWith((path,init)=>{if(init?.method==='POST'){actions.push(path);status=path.endsWith('/cancel')?'cancelled':'preparing';return job();}return {items:[job()]};});
 await act(async()=>root.render(view(api)));
 await act(async()=>d.querySelector<HTMLButtonElement>('.workspace-select')!.click());
 assert.ok(button(d,'取消处理'));await act(async()=>button(d,'取消处理').click());
 assert.match(d.body.textContent!,/处理已取消，已归档的原件和记录仍保留/);assert.match(d.body.textContent!,/generated.custom/);
 assert.equal(button(d,'取消处理'),undefined);assert.deepEqual(actions,['/api/imports/import-generated/cancel']);
 await act(async()=>button(d,'重试导入').click());assert.deepEqual(actions,['/api/imports/import-generated/cancel','/api/imports/import-generated/retry']);
});

test('retry while cancelled parser is stopping shows an actionable error without claiming resumed work',async t=>{
 const {root,d}=await fixture(t);let writes=0;
 const api=apiWith((_path,init)=>{if(init?.method==='POST'){writes++;throw new ApiError('Import is stopping',409,'generated-request','import_stopping');}return {items:[importJob({status:'cancelled',captureIds:[]})]};});
 await act(async()=>root.render(view(api)));await act(async()=>d.querySelector<HTMLButtonElement>('.workspace-select')!.click());
 await act(async()=>button(d,'重试导入').click());
 assert.equal(writes,1);assert.match(d.body.textContent!,/上一次处理仍在结束，请稍后再点击重试/);assert.ok(button(d,'重试导入'));assert.equal(button(d,'取消处理'),undefined);
});

test('preview finishing conflict keeps confirmation available with localized guidance',async t=>{
 const {root,d}=await fixture(t);let writes=0,resolve!:(value:unknown)=>void;
 const api=apiWith((_path,init)=>{if(init?.method==='POST'){if(++writes===1)throw new ApiError('Parsing is finishing',409,'generated-request','import_finishing');return new Promise(r=>resolve=r);}return {items:[importJob({status:'awaiting_confirmation',captureIds:[],preview:{count:1,samples:[]}})]};});
 await act(async()=>root.render(view(api)));await act(async()=>d.querySelector<HTMLButtonElement>('.workspace-select')!.click());
 await act(async()=>button(d,'确认并开始导入').click());
 assert.equal(writes,1);assert.match(d.body.textContent!,/解析正在收尾，请稍后再确认。/);
 assert.ok(button(d,'确认并开始导入'));assert.doesNotMatch(d.body.textContent!,/Parsing is finishing|上一次处理仍在结束/);
 const confirm=button(d,'确认并开始导入'),alert=confirm.previousElementSibling!;
 assert.equal(alert.getAttribute('role'),'alert');assert.equal(alert.parentElement,confirm.parentElement);
 assert.equal(d.querySelectorAll('[role=alert]').length,1);assert.equal(d.querySelector('.imports-page > [role=alert]'),null);
 await act(async()=>confirm.click());assert.equal(d.querySelector('[role=alert]'),null);assert.equal(confirm.disabled,true);
 await act(async()=>resolve(importJob()));assert.equal(d.querySelector('[role=alert]'),null);assert.equal(writes,2);
});

test('confirmation guidance belongs only to its selected import and is cleared on leaving it',async t=>{
 const {root,d}=await fixture(t);
 const jobs=['first','second'].map(id=>importJob({id,name:id,status:'awaiting_confirmation',captureIds:[],preview:{count:1,samples:[]}}));
 const api=apiWith((_path,init)=>{if(init?.method==='POST')throw new ApiError('Parsing is finishing',409,'generated-request','import_finishing');return {items:jobs};});
 await act(async()=>root.render(view(api)));
 const choose=async(index:number)=>act(async()=>d.querySelectorAll<HTMLButtonElement>('.workspace-select')[index].click());
 await choose(0);await act(async()=>button(d,'确认并开始导入').click());assert.ok(d.querySelector('.confirm-import [role=alert]'));
 await choose(1);assert.equal(d.querySelector('[role=alert]'),null);
 await choose(0);assert.equal(d.querySelector('[role=alert]'),null);
});

test('a late confirmation rejection from the previous node cannot restore stale guidance',async t=>{
 const {root,d}=await fixture(t);let reject!:(reason:unknown)=>void;
 const job=importJob({status:'awaiting_confirmation',captureIds:[],preview:{count:1,samples:[]}});
 const oldApi=apiWith((_path,init)=>init?.method==='POST'?new Promise((_resolve,r)=>reject=r):{items:[job]});
 const newApi=apiWith(()=>({items:[job]}));
 await act(async()=>root.render(view(oldApi)));await act(async()=>d.querySelector<HTMLButtonElement>('.workspace-select')!.click());
 await act(async()=>button(d,'确认并开始导入').click());
 await act(async()=>root.render(view(newApi)));await act(async()=>d.querySelector<HTMLButtonElement>('.workspace-select')!.click());
 await act(async()=>reject(new ApiError('Parsing is finishing',409,'generated-request','import_finishing')));
 assert.equal(d.querySelector('[role=alert]'),null);assert.ok(button(d,'确认并开始导入'));
});

test('a late confirmation success cannot replace the new node or release its pending button',async t=>{
 const {root,d}=await fixture(t);let resolveOld!:(value:unknown)=>void,resolveNew!:(value:unknown)=>void,changed=0;
 const waiting={status:'awaiting_confirmation',captureIds:[],preview:{count:1,samples:[]}};
 const oldJob=importJob({...waiting,name:'Old node generated import'}),newJob=importJob({...waiting,name:'New node generated import'});
 let newStored=newJob;
 const oldApi=apiWith((_path,init)=>init?.method==='POST'?new Promise(r=>resolveOld=r):{items:[oldJob]});
 const newApi=apiWith((_path,init)=>init?.method==='POST'?new Promise(r=>resolveNew=r):{items:[newStored]});
 await act(async()=>root.render(view(oldApi,{onChanged:()=>changed++})));await act(async()=>d.querySelector<HTMLButtonElement>('.workspace-select')!.click());
 await act(async()=>button(d,'确认并开始导入').click());
 await act(async()=>root.render(view(newApi,{onChanged:()=>changed++})));await act(async()=>d.querySelector<HTMLButtonElement>('.workspace-select')!.click());
 await act(async()=>button(d,'确认并开始导入').click());assert.equal(button(d,'确认并开始导入').disabled,true);
 await act(async()=>resolveOld(importJob({name:oldJob.name})));
 assert.match(d.body.textContent!,/New node generated import/);assert.doesNotMatch(d.body.textContent!,/Old node generated import/);
 assert.equal(button(d,'确认并开始导入').disabled,true);assert.equal(changed,0);
 newStored=importJob({name:newJob.name});await act(async()=>resolveNew(newStored));assert.equal(changed,1);assert.match(d.body.textContent!,/记录已保存到中央归档/);
});
