import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {createHash} from 'node:crypto';
import {configureLocale} from '@mote/shared/i18n';
import {importQueue} from '../src/import-queue.js';
import {Imports} from '../src/Imports.js';
import {ApiError,type Api} from '../src/api.js';
configureLocale(()=> 'zh-CN');
const fixtureApis=new Set<Api>();
async function fixture(t:any){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),before=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const {createRoot}=await import('react-dom/client');
 const root=createRoot(dom.window.document.getElementById('root')!);
 t.after(async()=>{await act(async()=>{root.unmount();for(const api of fixtureApis)importQueue(api).close();fixtureApis.clear();});for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
 return {root,d:dom.window.document};
}
const button=(d:Document,label:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent?.trim()===label)!;
const now='2026-09-01T08:00:00Z';
function importJob(extra:Record<string,unknown>={}){return {id:'import-generated',name:'Generated originals',status:'completed',createdAt:now,updatedAt:now,instruction:'',archive:{files:1,bytes:9},warnings:[],files:[],captureIds:['cccccccc-cccc-4ccc-8ccc-cccccccccccc'],progress:{total:1,processed:1,imported:1,duplicates:0},...extra};}
function apiWith(read:(path:string,init?:RequestInit)=>unknown):Api{const api={request:async(path:string,init?:RequestInit)=>path.startsWith('/api/operations/changes')?{ids:[],cursor:0,hasMore:false,reset:false}:read(path,init),setAgentTimeout:()=>{}} as Api;fixtureApis.add(api);return api;}
function view(api:Api,extra:Record<string,unknown>={}){return React.createElement(Imports,{api,onOpen:()=>{},onMemories:()=>{},onSettings:()=>{},onChanged:()=>{},...extra});}
async function select(d:Document,files:File[]){const input=d.querySelector<HTMLInputElement>('input[type=file]')!;Object.defineProperty(input,'files',{value:files,configurable:true});await act(async()=>input.dispatchEvent(new window.Event('change',{bubbles:true})));}
async function submit(d:Document){await act(async()=>d.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));}
async function until(check:()=>boolean){for(let i=0;i<100;i++){if(check())return;await act(async()=>new Promise(resolve=>setTimeout(resolve,10)));}assert.ok(check(),'Generated UI operation did not settle');}

test('media admission distinguishes extraction, search and Memory and retries the existing file',async t=>{
 const {root,d}=await fixture(t),writes:string[]=[],opened:string[]=[];
 const job=importJob({files:[{id:'generated-media',name:'generated.mp3',relativePath:'generated.mp3',sizeBytes:9}],media:[{fileId:'generated-media',captureId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',format:{id:'mote.media-format',version:'1',mimeType:'audio/mpeg',reason:'Generated format'},processing:{state:'failed',stage:'extract',error:'unsupported_format'},searchable:false,memory:{state:'failed',jobIds:[]}}]});
 const api=apiWith((path,init)=>{
  if(init?.method==='POST'){writes.push(path);return {queued:true};}
  if(path==='/api/imports')return {items:[job]};if(path==='/api/imports/'+job.id)return job;return {items:[]};
 });
 await act(async()=>root.render(view(api,{onOpen:(id:string)=>opened.push(id)})));await act(async()=>d.querySelector<HTMLButtonElement>('.workspace-select')!.click());
 assert.match(d.body.textContent!,/媒体已接入/);assert.match(d.body.textContent!,/内容提取失败/);assert.match(d.body.textContent!,/尚无可搜索片段/);assert.match(d.body.textContent!,/记忆整理失败/);assert.doesNotMatch(d.body.textContent!,/记录已保存到中央归档/);
 await act(async()=>button(d,'重试处理').click());assert.deepEqual(writes,['/api/files/cccccccc-cccc-4ccc-8ccc-cccccccccccc/retry']);
 await act(async()=>button(d,'查看记录').click());assert.deepEqual(opened,['capture:cccccccc-cccc-4ccc-8ccc-cccccccccccc']);
});

test('import history failures recover without false empty state, and revoked history is removed',async t=>{
 const {root,d}=await fixture(t);let failure=503;
 const api=apiWith(()=>{if(failure)throw new ApiError('Generated read failure',failure);return {items:[importJob()]};});
 await act(async()=>root.render(view(api)));assert.match(d.body.textContent!,/Generated read failure/);assert.doesNotMatch(d.body.textContent!,/你的第一份导入/);
 failure=0;await act(async()=>button(d,'刷新状态').click());assert.equal(d.querySelector('[role=alert]'),null);assert.match(d.body.textContent!,/Generated originals/);
 failure=403;await act(async()=>d.querySelector<HTMLButtonElement>('[aria-label="刷新导入记录"]')!.click());assert.doesNotMatch(d.body.textContent!,/Generated originals/);assert.match(d.body.textContent!,/Generated read failure/);
});

test('uploads freeze a batch while the next form stays available, and resume into one import',async t=>{
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
 assert.equal(button(d,'新建导入').disabled,false);assert.equal(button(d,'服务器目录').disabled,false);assert.equal(d.querySelector<HTMLTextAreaElement>('textarea')!.disabled,false);assert.equal(d.querySelectorAll('.selected-files .file-row').length,0);
 await act(async()=>button(d,'暂停上传').click());assert.equal(signal!.aborted,true);assert.match(d.body.textContent!,/上传已暂停/);assert.equal(d.querySelectorAll('.import-queue-item').length,1);assert.equal(writes.length,0);
 await select(d,[new File(['generated next draft'],'next-draft.txt')]);await act(async()=>button(d,'继续上传').click());await until(()=>writes.length===1);assert.equal(d.querySelectorAll('.selected-files .file-row').length,1);assert.equal(writes.length,1);assert.deepEqual(writes[0].archivedFileIds,['archived-generated']);assert.equal(writes[0].processing,'automatic');assert.equal(uploads[0],uploads[1]);assert.match(writes[0].requestId,/^[0-9a-f-]{36}$/);assert.match(d.body.textContent!,/记录已保存/);assert.equal(d.querySelector('[role=alert]'),null);
});

test('page navigation keeps uploads alive and returning shows the same batch',async t=>{
 const {root,d}=await fixture(t);let resolve!:(value:unknown)=>void,upload:any,signal:AbortSignal|undefined;
 const api=apiWith((path,init)=>{if(path==='/api/imports')return {items:[]};if(path==='/api/import-source-packs')return {items:[]};upload=JSON.parse(String(init?.body));signal=init?.signal??undefined;return new Promise(r=>resolve=r);});
 await act(async()=>root.render(view(api)));await select(d,[new File(['generated'],'original.txt')]);await submit(d);await act(async()=>root.render(null));assert.equal(signal!.aborted,false);
 await act(async()=>root.render(view(api)));assert.equal(d.querySelectorAll('.import-queue-item').length,1);assert.match(d.body.textContent!,/original.txt/);
 await act(async()=>importQueue(api).close());assert.equal(signal!.aborted,true);await act(async()=>resolve({id:upload.id,partBytes:4,parts:[]}));assert.equal(importQueue(api).getSnapshot().entries.length,0);
});

test('lost import-create response retries its frozen request while another batch remains independent',async t=>{
 const {root,d}=await fixture(t),writes:any[]=[];
 const api=apiWith((path,init)=>{
  if(path==='/api/imports'&&init?.method==='POST'){writes.push(JSON.parse(String(init.body)));throw Error('Generated lost response');}
  if(path==='/api/imports'||path==='/api/import-source-packs')return {items:[]};
  if(path==='/api/import-uploads'){const data=JSON.parse(String(init?.body));return {id:data.id,fileId:'archive:'+data.id,partBytes:4,parts:[]};}
  throw Error('Unexpected '+path);
 });
 await act(async()=>root.render(view(api)));await select(d,[new File(['one'],'one.txt')]);await submit(d);
 await until(()=>writes.length===1);await act(async()=>button(d,'重试提交').click());await until(()=>writes.length===2);assert.equal(writes[0].requestId,writes[1].requestId);
 await select(d,[new File(['two'],'two.txt')]);await submit(d);await until(()=>writes.length===3);assert.notEqual(writes[1].requestId,writes[2].requestId);
 assert.equal(d.querySelectorAll('.import-queue-item').length,2);assert.equal(d.querySelector('.imports-page > [role=alert]'),null);
});

test('import detail exposes memory pause, resume and cancel and keeps original evidence navigation',async t=>{
 const {root,d}=await fixture(t),actions:string[]=[],opened:string[]=[];let status='running';
 const job={id:'memory-generated',status,createdAt:now,updatedAt:now,evidenceIds:[],totalBatches:3,completedBatches:1,failedBatches:0,skippedChunks:0,memoryIds:[],skillVersion:'fixture',memoryCount:[].length,inputPlans:{total:0,waiting:0,blocked:0,stale:0,completed:0},recipeProgress:[]};
 const api=apiWith((path,init)=>{if(path==='/api/imports')return {items:[importJob({memoryJobId:job.id})]};if(init?.method==='POST'){const action=path.split('/').at(-1)!;actions.push(action);status=action==='pause'?'paused':action==='resume'?'running':'cancelled';}return {...job,status};});
 await act(async()=>root.render(view(api,{onOpen:(id:string)=>opened.push(id)})));await act(async()=>d.querySelector<HTMLButtonElement>('.workspace-select')!.click());
 await act(async()=>button(d,'当前批次结束后暂停').click());await act(async()=>button(d,'继续整理').click());await act(async()=>button(d,'取消未完成方案').click());assert.deepEqual(actions,['pause','resume','cancel']);assert.match(d.body.textContent!,/记忆提取已停止/);
 await act(async()=>button(d,'查看记录 1').click());assert.deepEqual(opened,['capture:cccccccc-cccc-4ccc-8ccc-cccccccccccc']);
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

test('confirmation locks only its own job and late completion never steals the next form or another selection',async t=>{
 const {root,d}=await fixture(t),resolvers=new Map<string,(value:unknown)=>void>();
 const jobs=['first','second'].map(id=>importJob({id,name:id,status:'awaiting_confirmation',captureIds:[],preview:{count:1,samples:[]}}));
 const api=apiWith((path,init)=>{if(init?.method==='POST')return new Promise(resolve=>resolvers.set(path,resolve));return {items:jobs};});
 await act(async()=>root.render(view(api)));
 const choose=async(name:string)=>act(async()=>Array.from(d.querySelectorAll<HTMLButtonElement>('.workspace-select')).find(item=>item.querySelector('strong')!.textContent===name)!.click());
 await choose('first');await act(async()=>button(d,'确认并开始导入').click());assert.equal(button(d,'确认并开始导入').disabled,true);
 await choose('second');assert.equal(button(d,'确认并开始导入').disabled,false);await act(async()=>button(d,'确认并开始导入').click());
 await act(async()=>button(d,'新建导入').click());assert.ok(d.querySelector('form'));assert.equal(d.querySelector<HTMLInputElement>('input[type=file]')!.disabled,false);
 jobs[0]=importJob({id:'first',name:'first'});await act(async()=>resolvers.get('/api/imports/first/confirm')!(jobs[0]));assert.ok(d.querySelector('form'),'Completion keeps the next form visible');
 await choose('second');assert.equal(button(d,'确认并开始导入').disabled,true);jobs[1]=importJob({id:'second',name:'second'});
 await act(async()=>resolvers.get('/api/imports/second/confirm')!(jobs[1]));assert.equal(d.querySelector('.import-detail h2')!.textContent,'second');assert.match(d.body.textContent!,/记录已保存到中央归档/);
});

test('directory failure stays in its own queue entry and edit restores settings without blocking file intake',async t=>{
 const {root,d}=await fixture(t);
 const api=apiWith((path,init)=>{if(init?.method==='POST')throw new ApiError('Generated path missing',422,undefined,'import_directory_missing');return {items:[]};});
 await act(async()=>root.render(view(api)));await act(async()=>button(d,'服务器目录').click());
 const input=d.querySelector<HTMLInputElement>('input[placeholder="/data/imports/my-notes"]')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(input,'/generated/missing');input.dispatchEvent(new window.Event('input',{bubbles:true}));});
 await submit(d);await until(()=>Boolean(button(d,'修改目录')));
 assert.equal(d.querySelector('.imports-page > [role=alert]'),null);assert.equal(button(d,'选择文件').disabled,false);assert.match(d.querySelector('.import-queue-item')!.textContent!,/目录不存在/);
 await act(async()=>button(d,'修改目录').click());assert.equal(d.querySelector<HTMLInputElement>('input[placeholder="/data/imports/my-notes"]')!.value,'/generated/missing');assert.equal(d.querySelectorAll('.import-queue-item').length,0);
});

test('folder drop expands entries before admission, blocks partial submission and displays relative paths',async t=>{
 const {root,d}=await fixture(t),names:string[]=[],writes:any[]=[];let read!:(entries:unknown[])=>void;
 const api=apiWith((path,init)=>{
  if(path==='/api/imports'&&init?.method==='POST'){writes.push(JSON.parse(String(init.body)));return importJob();}
  if(path==='/api/import-uploads'){const input=JSON.parse(String(init!.body));names.push(input.name);return {id:input.id,fileId:'archived:'+input.id,partBytes:4,parts:[]};}
  return {items:[]};
 });
 await act(async()=>root.render(view(api)));
 const folder={name:'generated-folder',isDirectory:true,isFile:false,createReader:()=>{let first=true;return {readEntries:(done:typeof read)=>{if(first){first=false;read=done;}else done([]);}};}};
 const event=new window.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{items:[{kind:'file',webkitGetAsEntry:()=>folder,getAsFile:()=>new File(['placeholder'],'generated-folder')}],files:[]}});
 await act(async()=>d.querySelector('.file-drop')!.dispatchEvent(event));assert.equal(button(d,'加入导入队列').disabled,true);assert.match(d.body.textContent!,/正在读取所选文件/);assert.equal(names.length,0);
 await act(async()=>read([{name:'nested',isDirectory:true,isFile:false,createReader:()=>{let first=true;return {readEntries:(done:typeof read)=>{done(first?[{name:'note.txt',isDirectory:false,isFile:true,file:(done:(file:File)=>void)=>done(new File(['generated'],'note.txt'))}]:[]);first=false;}};}}]));
 await until(()=>!button(d,'加入导入队列').disabled);assert.match(d.querySelector('.selected-files')!.textContent!,/generated-folder\/nested\/note.txt/);await submit(d);await until(()=>writes.length===1);assert.deepEqual(names,['generated-folder/nested/note.txt']);
});

test('folder picker keeps relative paths and late drop results cannot leak into a different node',async t=>{
 const {root,d}=await fixture(t),api=apiWith(()=>({items:[]}));await act(async()=>root.render(view(api)));
 const picker=d.querySelector<HTMLInputElement>('input[webkitdirectory]')!;const file=new File(['generated'],'same.txt');Object.defineProperty(file,'webkitRelativePath',{value:'picked/nested/same.txt'});Object.defineProperty(picker,'files',{value:[file]});await act(async()=>picker.dispatchEvent(new window.Event('change',{bubbles:true})));
 assert.match(d.querySelector('.selected-files')!.textContent!,/picked\/nested\/same.txt/);
 let read!:(entries:unknown[])=>void;const event=new window.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{items:[{kind:'file',webkitGetAsEntry:()=>({name:'late',isDirectory:true,isFile:false,createReader:()=>({readEntries:(done:typeof read)=>read=done})}),getAsFile:()=>null}],files:[]}});
 await act(async()=>d.querySelector('.file-drop')!.dispatchEvent(event));const nextApi=apiWith(()=>({items:[]}));await act(async()=>root.render(view(nextApi)));await act(async()=>read([]));assert.equal(d.querySelector('.selected-files'),null);assert.equal(d.querySelector('[role=status]'),null);
});
