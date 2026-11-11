import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {storageStatistics} from '@mote/shared/storage-statistics';
import {configureLocale} from '@mote/shared/i18n';
import {Vault} from '../src/plugins/maintenance/Vault';
import {ContentStorage} from '../src/plugins/maintenance/ContentStorage';
import {Diagnostics} from '../src/Diagnostics';
import {ApiError,type Api,type Status} from '../src/api';
configureLocale(()=> 'zh-CN');
const state={storage:{captures:2,blobs:0,imageBytes:0,indexing:[],bytes:0},index:{mode:'text'},agent:{},retentionDays:0} as unknown as Status;
async function fixture(t:any){const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost',pretendToBeVisual:true}),old=new Map();for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){old.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true});}const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());for(const[key,value]of old)value?Object.defineProperty(globalThis,key,value):Reflect.deleteProperty(globalThis,key);dom.window.close();});return{root,d:dom.window.document};}
const click=(d:Document,label:string)=>{const button=Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(x=>x.textContent===label)!;assert.ok(button,label);button.click();};
const api=(raw:Api['raw']=async()=>new Response('{}'))=>({raw,request:async()=>storageStatistics([])}) as unknown as Api;
const render=(root:ReturnType<typeof createRoot>,value:Api,refresh=()=>{})=>act(async()=>root.render(React.createElement(Vault,{api:value,status:state,refresh,disconnect:()=>{}})));
const select=async(d:Document,file:{text():Promise<string>})=>{const input=d.querySelector<HTMLInputElement>('input[type=file]')!;Object.defineProperty(input,'files',{value:[file],configurable:true});await act(async()=>input.dispatchEvent(new window.Event('change',{bubbles:true})));};
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(check:()=>boolean,label:string)=>{for(let i=0;i<200&&!check();i++)await act(async()=>{await delay(15);});assert.ok(check(),label);};
const visibility=(d:Document,hidden:boolean)=>act(async()=>{Object.defineProperty(d,'hidden',{configurable:true,get:()=>hidden});d.dispatchEvent(new window.Event('visibilitychange'));});
test('invalid JSON has a readable prompt, retains complete diagnostics behind closed disclosure and never posts',async t=>{const f=await fixture(t);let writes=0;const value=api();value.request=async(path)=>{if(path==='/api/import')writes++;return storageStatistics([]) as any;};await render(f.root,value);writes=0;await select(f.d,{text:async()=>'{invalid generated JSON'});assert.match(f.d.querySelector('[role=alert]')!.textContent!,/请选择 Mote v2 JSON/);const detail=Array.from(f.d.querySelectorAll('details')).find(x=>x.querySelector('summary')?.textContent==='技术详情')!;assert.ok(detail);assert.equal(detail.open,false);assert.ok(detail.querySelector('pre')!.textContent);assert.equal(writes,0);assert.match(f.d.body.textContent!,/合并记录，跳过重复内容/);});
test('a browser-provided download never claims the user saved the archive, and duplicate clicks do not repeat the fetch',async t=>{const f=await fixture(t);let release!:(r:Response)=>void,calls=0,downloads=0;const value=api(async()=>{calls++;return new Promise(resolve=>release=resolve);}),oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;URL.createObjectURL=()=>{downloads++;return 'blob:generated';};URL.revokeObjectURL=()=>{};f.d.defaultView!.HTMLAnchorElement.prototype.click=function(){};t.after(()=>{URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;});await render(f.root,value);await act(async()=>{click(f.d,'导出');click(f.d,'导出');});assert.equal(calls,1);await act(async()=>release(new Response('{"version":2}')));assert.equal(downloads,1);assert.match(f.d.querySelector('[role=status]')!.textContent!,/浏览器.*确认保存结果/);assert.doesNotMatch(f.d.body.textContent!,/资料已导出/);});
test('a late archive response after changing owner or unmounting cannot download or refresh the new owner',async t=>{const f=await fixture(t);let release!:(r:Response)=>void,downloads=0,refreshes=0;const value=api(async()=>new Promise(resolve=>release=resolve)),other=api(),old=URL.createObjectURL;URL.createObjectURL=()=>{downloads++;return 'blob:old-owner';};t.after(()=>{URL.createObjectURL=old;});await render(f.root,value,()=>refreshes++);await act(async()=>click(f.d,'导出'));await render(f.root,other);await act(async()=>release(new Response('generated old archive')));assert.equal(downloads,0);assert.equal(refreshes,0);assert.equal(f.d.querySelector('[role=status]'),null);await render(f.root,value);await act(async()=>click(f.d,'导出'));await act(async()=>f.root.render(null));await act(async()=>release(new Response('generated closed archive')));assert.equal(downloads,0);});
test('a selected file still being read cannot post into an old owner after navigation',async t=>{const f=await fixture(t);let release!:(s:string)=>void,posts=0;const value=api();value.request=async(path)=>{if(path==='/api/import')posts++;return storageStatistics([]) as any;};await render(f.root,value);await select(f.d,{text:()=>new Promise(resolve=>release=resolve)});await render(f.root,api());await act(async()=>release(JSON.stringify({version:2,captures:[],sources:[],sourceHeads:[],sourceVersions:[],memories:[],memoryDeletions:[],files:[],captureFiles:[],perceptionResults:[],todos:[]})));assert.equal(posts,0);assert.equal(f.d.querySelector('[role=alert]'),null);});
test('support failure preserves the chosen time range and exposes protocol diagnostics only on request',async t=>{const f=await fixture(t);const value=api(async()=>{throw new ApiError('Generated service_unavailable HTTP503',503,undefined,'service_unavailable');});value.request=async(path)=>path.startsWith('/api/diagnostics/log-pages')?{items:[],page:1,totalPages:1,totalLines:0}:{queue:{index:{pending:0,failed:0}},limits:{},retention:{totalBytes:0,maxTotalBytes:1000,files:[],channels:[],lastCleanup:null},runtime:{},services:{}} as any;await act(async()=>f.root.render(React.createElement(Diagnostics,{api:value})));const range=f.d.querySelector<HTMLSelectElement>('[aria-label="导出时间范围"]')!;await act(async()=>{range.value='168';range.dispatchEvent(new window.Event('change',{bubbles:true}));});await act(async()=>click(f.d,'导出'));assert.equal(range.value,'168');assert.doesNotMatch(f.d.querySelector('[role=alert]')!.textContent!,/service_unavailable|HTTP503/);assert.match(f.d.querySelector('pre')!.textContent!,/service_unavailable HTTP503/);assert.equal(f.d.querySelector('details')!.open,false);});

test('an invalid import receipt cannot claim counts or refresh the archive after a request completed',async t=>{const f=await fixture(t);let changed=0,posts=0;const value=api();value.request=async(path)=>{if(path==='/api/import'){posts++;return {imported:-1} as any;}return storageStatistics([]) as any;};await render(f.root,value,()=>changed++);await select(f.d,{text:async()=>JSON.stringify({version:2,captures:[],sources:[],sourceHeads:[],sourceVersions:[],memories:[],memoryDeletions:[],files:[],captureFiles:[],perceptionResults:[],todos:[]})});assert.equal(posts,1);assert.equal(changed,0);assert.equal(f.d.querySelector('[role=status]'),null);assert.ok(f.d.querySelector('[role=alert]'));assert.match(f.d.querySelector('pre')!.textContent!,/invalid_response/);});

test('a hidden maintenance page keeps an authorized export running and restores its real receipt',async t=>{
 const f=await fixture(t);let release!:(response:Response)=>void,downloads=0,refreshes=0;
 const value=api(async()=>new Promise(resolve=>release=resolve)),old=URL.createObjectURL;URL.createObjectURL=()=>{downloads++;return 'blob:hidden-export';};t.after(()=>{URL.createObjectURL=old;});f.d.defaultView!.HTMLAnchorElement.prototype.click=function(){};
 await render(f.root,value,()=>refreshes++);await act(async()=>click(f.d,'导出'));
 await visibility(f.d,true);
 await act(async()=>release(new Response('{"version":2}')));
 assert.equal(downloads,1,'hiding the page does not cancel the authorized transfer');
 assert.equal(refreshes,0,'a hidden page defers its refresh read');
 assert.match(f.d.body.textContent!,/确认保存结果/);
 await visibility(f.d,false);
 assert.equal(refreshes,1,'restoring the page runs the deferred refresh once');
 assert.match(f.d.body.textContent!,/确认保存结果/,'the restored page shows the real transfer receipt');
});

test('hidden ContentStorage suspends polling and resumes at the server real decryption progress',async t=>{
 const f=await fixture(t);let reads=0,job={state:'running' as const,total:10,processed:2,converted:0,skipped:0,failed:0};
 const value={request:async(path:string)=>{assert.equal(path,'/api/content-storage');reads++;return {enabled:false,revision:1,job:{...job}};}} as unknown as Api;
 await act(async()=>f.root.render(React.createElement(ContentStorage,{api:value})));
 await until(()=>f.d.body.textContent!.includes('2/10'),'initial decryption progress');
 await visibility(f.d,true);
 const hiddenReads=reads;
 job={...job,processed:7};
 await act(async()=>{await delay(650);});
 assert.equal(reads,hiddenReads,'hidden ContentStorage stops polling');
 await visibility(f.d,false);
 await until(()=>f.d.body.textContent!.includes('7/10'),'resumed server progress');
 assert.ok(reads>hiddenReads,'restoring the page reads the real progress again');
});
