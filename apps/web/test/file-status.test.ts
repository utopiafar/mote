import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {fileViewSchema,type FileView} from '@mote/shared';
import {configureLocale} from '@mote/shared/i18n';
import {Files,FileDetail} from '../src/plugins/intake/Files';
import {Sources} from '../src/plugins/sources/Sources';
import {ApiError,type Api} from '../src/api';
import {resources} from '../src/resource-cache';
import {unsentDrafts} from '../src/plugins/ask/chat-drafts';
import {webFeatures} from '../src/features/registry';

configureLocale(()=> 'zh-CN');
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',at='2026-11-12T01:02:03Z';
const source={id:'generated-files',name:'Generated files',kind:'local-files',deviceId:'generated-mac',platform:'macos',retention:'snapshot',enabled:true,createdAt:at,updatedAt:at};
const projection=(patch:Partial<FileView>={}):FileView=>fileViewSchema.parse({captureId:id,sourceId:source.id,item:{externalId:'generated-file',revision:'generated-v2',observedAt:at,title:'Generated report.txt',text:'',kind:'file',layer:'snapshot',uri:'file:///generated/report.txt',document:{path:'/generated/report.txt'}},retention:'snapshot',hasOriginal:false,originMissing:false,canOpenOriginal:false,coverage:{extraction:{status:'ready',completed:2,total:2},semantic:{status:'partial',reason:'A summary was generated; complete semantic understanding is not established.'},embedding:{status:'unsupported',reason:'Embedding is not configured; lexical search remains available for extracted text.'}},...patch});
function deferred<T>(){let resolve!:(value:T)=>void;return {promise:new Promise<T>(done=>{resolve=done;}),resolve:(value:T)=>resolve(value)};}
async function fixture(t:any){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/connections?sourceId=generated-files',pretendToBeVisual:true}),previous=new Map<string,PropertyDescriptor|undefined>();
 for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 dom.window.HTMLMediaElement.prototype.pause=()=>{};dom.window.HTMLMediaElement.prototype.load=()=>{};
 const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!);
 const navigation=await webFeatures.install({id:'generated-f10-navigation',version:'1',components:[]},[
  ...['ask','archive','search'].map(id=>({surface:'page' as const,entry:{id,route:id==='archive'?'library':id,featureId:'generated-f10-navigation',render:()=>null}})),
  {surface:'collection',entry:{id:'files',label:'Generated files',featureId:'generated-f10-navigation',order:0,render:()=>null}},
 ]);
 t.after(async()=>{await act(async()=>root.unmount());await navigation.dispose();dom.window.close();for(const[key,value]of previous)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);});
 return {root,d:dom.window.document,w:dom.window};
}
function owner(read:(path:string,init?:RequestInit)=>unknown):Api{return {request:async(path:string,init?:RequestInit)=>{
 if(path==='/api/features')return {schemaVersion:1,revision:1,features:[],capabilities:['http:GET:/api/files','http:POST:/api/query-runs','http:POST:/api/assistant/commands','http:PATCH:/api/sources/:id'].map(id=>({id,version:'1',surface:'command',featureId:'generated',state:'active'}))};
 if(path==='/api/file-processing')return null;
 if(path==='/api/sources')return {items:[source]};
 if(path==='/api/connectors/status')return {};
 if(path.startsWith('/api/library/browse?'))return {sources:[],sourcesTruncated:false};
 if(path.startsWith('/api/source-items?'))return {items:[],nextCursor:null};
 if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};
 return read(path,init);
 }} as Api;}
const row=(view:FileView)=>({captureId:id,sourceId:source.id,sizeBytes:24,hasOriginal:true,originMissing:view.originMissing,item:view.item,job:null,artifacts:[{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',kind:'summary',sections:[{answer:'Generated summary',citationIds:[]}]}]});
const button=(d:Document,label:string)=>[...d.querySelectorAll<HTMLButtonElement>('button')].find(value=>value.textContent===label)!;

test('file detail separates offline originals, partial extraction, metadata-only and released snapshot coverage',async t=>{
 const {root,d}=await fixture(t);
 for(const view of [projection({originMissing:true}),projection({coverage:{extraction:{status:'partial',completed:1,total:3,reason:'Generated missing pages'},semantic:{status:'pending'},embedding:{status:'partial',completed:1,total:2}}}),projection({retention:'reference',item:{...projection().item,layer:'reference'},coverage:{extraction:{status:'unsupported'},semantic:{status:'unsupported'},embedding:{status:'unsupported'}}}),projection()]){
  const api=owner(path=>path==='/api/files/'+id?row(view):path==='/api/files/'+id+'/view'?JSON.parse(JSON.stringify(view)):{});
  await act(async()=>root.render(React.createElement(FileDetail,{api,id,onOpen:()=>{}})));
  const status=d.querySelector('.file-status');assert.ok(status,'FileView status must be visible in the existing file reader');
  assert.match(status.textContent!,/generated-v2/);assert.match(status.textContent!,/generated\/report.txt/);
  assert.ok(status.querySelector('time[datetime="'+at+'"]'));
  assert.equal(button(d,'下载原件')?.disabled,true,'a retained flag and summary do not grant original access');
  assert.equal(d.querySelector('progress,[role=progressbar]'),null,'coverage is not simulated job progress');
  if(view.originMissing)assert.match(status.textContent!,/原位置已不可见/);
  if(view.coverage.extraction.status==='partial')assert.match(status.textContent!,/1 \/ 3/);
  if(view.retention==='reference')assert.match(status.textContent!,/仅保留引用与元数据/);
  else assert.match(status.textContent!,/快照原件未保留/);
 }
});

test('source retention drafts survive projection refreshes and save only the explicit choice',async t=>{
 const {root,d,w}=await fixture(t),writes:{path:string;body:unknown}[]=[];let current={...source};
 const api=owner((path,init)=>{if(init?.method==='PATCH'){writes.push({path,body:JSON.parse(String(init.body))});current={...current,...JSON.parse(String(init.body))};return current;}return {};});
 const request=api.request;api.request=async(path,init)=>path==='/api/sources'?{items:[current]} as any:request(path,init);
 await act(async()=>root.render(React.createElement(Sources,{api,onOpen:()=>{},onImport:()=>{}})));
 await act(async()=>button(d,'连接与范围').click());
 const select=d.querySelector<HTMLSelectElement>('.file-retention-settings select');assert.ok(select,'file source retention must be editable through Sources');
 await act(async()=>{select.value='archive';select.dispatchEvent(new w.Event('change',{bubbles:true}));});
 current={...current,retention:'reference'};await act(async()=>resources(api).get('/api/sources').refresh());
 assert.equal(select.value,'archive','background refresh must not replace the owner selection');
 assert.match(d.querySelector('.file-retention-settings')!.textContent!,/上传完整文件/);
 assert.deepEqual(writes,[]);
 await act(async()=>button(d,'保存设置').click());
 assert.deepEqual(writes,[{path:'/api/sources/generated-files',body:{retention:'archive'}}]);
 assert.equal(d.querySelector('.file-retention-settings select')!.getAttribute('disabled'),null);
});

test('processing hints refresh coverage without inferring completion from a summary or interrupting original reads',async t=>{
 const {root,d}=await fixture(t),hint=deferred<unknown>(),pendingView=deferred<unknown>();let reads=0;
 let view=projection({retention:'archive',hasOriginal:true,canOpenOriginal:true,coverage:{extraction:{status:'pending'},semantic:{status:'partial'},embedding:{status:'pending'}}});
 const api=owner(path=>path==='/api/files/'+id?row(view):path==='/api/files/'+id+'/view'?(++reads===2?pendingView.promise:view):{});
 const request=api.request;api.request=async(path,init)=>path.startsWith('/api/operations/changes')?hint.promise as any:request(path,init);
 await act(async()=>root.render(React.createElement(FileDetail,{api,id,onOpen:()=>{}})));
 assert.match(d.querySelector('.file-status')!.textContent!,/正文提取等待处理/);
 assert.equal(button(d,'下载原件').disabled,false);
 view=projection({retention:'archive',hasOriginal:true,canOpenOriginal:true});
 await act(async()=>hint.resolve({ids:['file:'+id],cursor:1,hasMore:false,reset:false}));
 assert.equal(reads,2,'the existing operation feed revalidates the FileView endpoint');
 assert.equal(button(d,'下载原件').disabled,false,'revalidation itself does not revoke a confirmed opening capability');
 await act(async()=>pendingView.resolve(view));
 assert.match(d.querySelector('.file-status')!.textContent!,/正文提取处理完成 · 2 \/ 2/);
 assert.match(d.querySelector('.file-status')!.textContent!,/语义理解部分内容/);
 assert.match(d.querySelector('.file-status')!.textContent!,/向量索引不可用/);
});

test('file work handoff preserves the exact capture and guards existing drafts without creating a task',async t=>{
 const {root,d,w}=await fixture(t),writes:string[]=[],view=projection();
 const api=owner((path,init)=>{if(init?.method)writes.push(path);return path==='/api/files/'+id?row(view):path==='/api/files/'+id+'/view'?view:{};});
 await act(async()=>root.render(React.createElement(FileDetail,{api,id,onOpen:()=>{}})));
 assert.equal(d.querySelector('a[href^="#/library?view=files"]')!.getAttribute('href'),'#/library?view=files&sourceId=generated-files');
 assert.equal(d.querySelector('a[href^="#/search?"]')!.getAttribute('href'),'#/search?sourceId=generated-files');
 await act(async()=>button(d,'问文件').click());
 assert.equal(new URLSearchParams(w.location.hash.split('?')[1]).get('fromCapture'),id);
 w.location.hash='#/library?view=files';unsentDrafts.set(api,{question:'Generated unsent question',attachments:[]});w.confirm=()=>false;
 await act(async()=>button(d,'用于事项').click());assert.equal(w.location.hash,'#/library?view=files');
 w.confirm=()=>true;await act(async()=>button(d,'用于事项').click());
 const query=new URLSearchParams(w.location.hash.split('?')[1]);assert.equal(query.get('fromCapture'),id);assert.match(query.get('questionDraft')!,/可编辑的工作草稿/);
 assert.deepEqual(writes,[],'only the existing Ask draft is prepared; host-validated start remains a later owner operation');
 await act(async()=>root.render(React.createElement(FileDetail,{api,id,historical:true,onOpen:()=>{}})));
 assert.equal(button(d,'问文件').disabled,true);assert.equal(button(d,'用于事项').disabled,true);
});

test('revoked or replaced FileView reads remove stale actions and do not publish a late owner response',async t=>{
 const {root,d}=await fixture(t),late=deferred<unknown>();let failure=false;
 const view=projection({retention:'archive',hasOriginal:true,canOpenOriginal:true});
 const first=owner(path=>path==='/api/files/'+id?row(view):path==='/api/files/'+id+'/view'?late.promise:{});
 await act(async()=>root.render(React.createElement(FileDetail,{api:first,id,onOpen:()=>{}})));
 const current=owner(path=>{if(path==='/api/files/'+id)return row(projection());if(path==='/api/files/'+id+'/view'){if(failure)throw new ApiError('Generated revoked file',403);return projection();}return {};});
 await act(async()=>root.render(React.createElement(FileDetail,{api:current,id,onOpen:()=>{}})));
 await act(async()=>late.resolve(view));assert.equal(button(d,'下载原件').disabled,true);
 failure=true;await act(async()=>resources(current).get('/api/files/'+id+'/view').refresh());
 assert.equal(d.querySelector('.file-status'),null);assert.doesNotMatch(d.body.textContent!,/Generated summary/);assert.equal(button(d,'用于事项'),undefined);
});

test('original opening uses the host grant for this ID; missing query capabilities disable file work buttons',async t=>{
 const {root,d,w}=await fixture(t),requests:string[]=[],opened:string[]=[];
 let view=projection({retention:'archive',hasOriginal:true,canOpenOriginal:true});
 const api=owner((path,init)=>{if(init?.method){requests.push(path);return {url:'/api/files/'+id+'/content'};}return path==='/api/files/'+id?row(view):path==='/api/files/'+id+'/view'?view:{};});
 const request=api.request;api.request=async(path,init)=>path==='/api/features'?{schemaVersion:1,revision:1,features:[],capabilities:[]} as any:request(path,init);
 w.HTMLAnchorElement.prototype.click=function(){opened.push(this.getAttribute('href')!);};
 await act(async()=>root.render(React.createElement(FileDetail,{api,id,onOpen:()=>{}})));
 assert.equal(button(d,'问文件').disabled,true);assert.equal(button(d,'用于事项').disabled,true);
 await act(async()=>button(d,'加载原件 / 回听').click());
 assert.deepEqual(requests,['/api/files/'+id+'/playback']);assert.deepEqual(opened,['/api/files/'+id+'/content']);
 view=projection({retention:'archive',hasOriginal:true,canOpenOriginal:false});await act(async()=>resources(api).get('/api/files/'+id+'/view').refresh());
 assert.equal(button(d,'下载原件').disabled,true);await act(async()=>button(d,'下载原件').click());assert.equal(requests.length,1);
});

test('file browsing honors source links and preserves a filename search while opening a record',async t=>{
 const {root,d,w}=await fixture(t),paths:string[]=[],view=projection();
 const api=owner(path=>{paths.push(path);return path.startsWith('/api/files?')?{items:[row(view)],nextCursor:null}:{};});
 await act(async()=>root.render(React.createElement(Files,{api,onOpen:()=>{w.location.hash='#/library?view=files&sourceId=generated-files&selected=capture%3A'+id;}})));
 assert.equal(new URLSearchParams(paths.find(path=>path.startsWith('/api/files?'))!.split('?')[1]).get('sourceId'),source.id);
 const search=d.querySelector<HTMLInputElement>('input')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value')!.set!.call(search,'Generated report');search.dispatchEvent(new w.Event('input',{bubbles:true}));});
 await act(async()=>d.querySelector('form')!.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true})));
 await act(async()=>d.querySelector<HTMLButtonElement>('.file-card')!.click());
 assert.equal(search.value,'Generated report');assert.equal(new URLSearchParams(paths.filter(path=>path.startsWith('/api/files?')).at(-1)!.split('?')[1]).get('query'),'Generated report');
});

test('real Central file projection reaches the existing reader from an isolated generated profile',async t=>{
 const {root,d}=await fixture(t);
 const [{mkdtempSync,writeFileSync,rmSync},{tmpdir},{join},{buildApp},{configFromFile},{serializeConfigDocument}]=await Promise.all([import('node:fs'),import('node:os'),import('node:path'),import('../../server/src/app'),import('../../server/src/config'),import('@mote/shared/config-file')]);
 const directory=mkdtempSync(join(tmpdir(),'mote-f10-web-')),configPath=join(directory,'mote.yaml');
 writeFileSync(configPath,serializeConfigDocument({version:1,revision:0,server:{profile:'test',token:'generated-f10-owner-token-1234567890'},storage:{dataDir:directory},models:{deployment:{model:''}},diagnostics:{level:'silent'}}),{mode:0o600});
 const config=configFromFile(configPath),{app}=await buildApp(config,{agent:{configured:false,query:async()=>{throw Error('No model expected');},close:async()=>{}}});
 t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+config.token};
 const registered=await app.inject({method:'POST',url:'/api/sources',headers,payload:{...source,retention:'reference',createdAt:undefined,updatedAt:undefined}});assert.equal(registered.statusCode,200,registered.body);
 const ingested=await app.inject({method:'PUT',url:'/api/file-sync/v1/revisions',headers,payload:{sourceId:source.id,previousRevision:null,relativePath:'generated/report.txt',sizeBytes:24,item:{...projection().item,layer:'reference'}}});assert.equal(ingested.statusCode,200,ingested.body);
 const captureId=ingested.json().id,paths:string[]=[];
 const api={request:async(path:string,init?:RequestInit)=>{paths.push(path);const response=await app.inject({method:(init?.method??'GET') as any,url:path,headers,...(init?.body?{payload:JSON.parse(String(init.body))}:{})});if(response.statusCode>=400)throw new ApiError('Generated HTTP failure',response.statusCode);return response.json();}} as Api;
 await act(async()=>root.render(React.createElement(FileDetail,{api,id:captureId,onOpen:()=>{}})));
 assert.ok(paths.includes('/api/files/'+captureId+'/view'));assert.match(d.querySelector('.file-status')!.textContent!,/generated-v2/);assert.match(d.querySelector('.file-status')!.textContent!,/仅保存引用/);assert.match(d.querySelector('.file-status')!.textContent!,/正文提取不可用/);assert.equal(button(d,'下载原件'),undefined);
});
