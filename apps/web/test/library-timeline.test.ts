import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import type {CaptureTimelineGroup,CaptureTimelineMember,CaptureTimelinePage} from '@mote/shared';
import {LibraryTimeline} from '../src/plugins/library/LibraryTimeline.js';
import {ApiError,type Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';
import {affectedResource,OperationFeed} from '../src/plugins/work/operation-feed.js';
import {clearImportReturn,markImportReturn,rememberImportOrigin} from '../src/import-navigation.js';
configureLocale(()=> 'zh-CN');
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const originalAt='2026-10-28T23:59:00.000Z',firstAt='2026-10-29T00:00:10.000Z',lastAt='2026-10-29T00:00:20.000Z';
const member=(value=id):CaptureTimelineMember=>({record:{id:value,deviceId:'generated',deviceName:'Generated Mac',platform:'macos',capturedAt:originalAt,source:'activity',appName:'Generated actual app',windowTitle:'Generated literal record',durationMs:2000,hasImage:false,ocr:{status:'not_applicable'},textPreview:'Generated literal evidence'},firstAt,lastAt,sampleCount:2});
const group=(patch:Partial<CaptureTimelineGroup>={}):CaptureTimelineGroup=>({type:'group',id:'opaque-exact-group',kind:'source',source:'activity',deviceId:'generated',deviceName:'Generated Mac',day:'2026-10-29',firstAt,lastAt,recordCount:71,imageCount:0,sampleCount:null,...patch});
const page=(items:CaptureTimelinePage['items']=[group()],nextCursor:string|null=null):CaptureTimelinePage=>({revision:'exact-revision',items,nextCursor});
const members=(g=group(),items=[member()],nextCursor:string|null=null)=>({revision:'exact-revision',group:g,items,nextCursor});
const apiWith=(request:(path:string,init?:RequestInit)=>unknown)=>({request:async(path:string,init?:RequestInit)=>request(path,init)}) as Api;
const buttons=(d:Document,label:string,scope:ParentNode=d)=>[...scope.querySelectorAll<HTMLButtonElement>('button')].filter(b=>b.textContent===label);
const deferred=()=>{let resolve!:(value:unknown)=>void;return {promise:new Promise<unknown>(done=>resolve=done),resolve:(value:unknown)=>resolve(value)};};
async function fixture(t:any){const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/library?view=records',pretendToBeVisual:true}),previous=new Map();for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());for(const [key,value]of previous)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);dom.window.close();});return {root,d:dom.window.document,w:dom.window};}
const view=(api:Api,onOpen:(ref:string)=>void=()=>{},revision=0)=>React.createElement(LibraryTimeline,{api,devices:[{deviceId:'generated',deviceName:'Generated Mac',platform:'macos',status:'capturing',queueDepth:0,lastSeenAt:firstAt}],onOpen,revision});
async function open(d:Document,w:any){await act(async()=>{const details=d.querySelector<HTMLDetailsElement>('.library-time-group')!;details.open=true;details.dispatchEvent(new w.Event('toggle'));});}
async function change(d:Document,w:any,label:string,value:string){await act(async()=>{const el=d.querySelector<HTMLInputElement|HTMLSelectElement>('[aria-label="'+label+'"]')!;el.value=value;el.dispatchEvent(new w.Event('change',{bubbles:true}));});}

test('full host counts stay truthful while a folded group lazily pages exact projected members',async t=>{
 const {root,d,w}=await fixture(t),paths:string[]=[],opened:string[]=[];
 const api=apiWith(path=>{paths.push(path);return path.startsWith('/api/capture-browser/timeline/members?')?members(group(),[member(path.includes('cursor=')?other:id)],path.includes('cursor=')?null:'member-page-2'):page();});
 await act(async()=>root.render(view(api,ref=>opened.push(ref))));
 assert.equal(d.querySelector('details')!.open,false);assert.equal(paths.length,1);assert.match(d.querySelector('.library-time-count')!.textContent!,/71 条记录/);assert.doesNotMatch(d.querySelector('.library-time-count')!.textContent!,/样本/);
 await open(d,w);let query=new URL('http://localhost'+paths.at(-1)).searchParams;assert.equal(query.get('group'),'opaque-exact-group');assert.ok(query.get('timeZone'));assert.ok(query.get('after'));assert.ok(query.get('before'));
 const projected=new Date(firstAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});assert.ok(d.querySelector('.library-time-observation time')!.textContent!.startsWith(projected));
 await act(async()=>d.querySelector<HTMLButtonElement>('.library-time-observation')!.click());assert.deepEqual(opened,['capture:'+id]);
 await act(async()=>buttons(d,'下一页',d.querySelector('.library-time-member-pagination')!)[0]!.click());query=new URL('http://localhost'+paths.at(-1)).searchParams;assert.equal(query.get('cursor'),'member-page-2');assert.equal(query.get('group'),'opaque-exact-group');assert.match(d.querySelector('.library-time-member-pagination')!.textContent!,/第 2 页/);
 await act(async()=>d.querySelector<HTMLButtonElement>('.library-time-observation')!.click());assert.deepEqual(opened,['capture:'+id,'capture:'+other]);
});

test('dated projection identities never become original IDs and known samples use the host total',async t=>{
 const {root,d}=await fixture(t),opened:string[]=[];
 const note={...member(),record:{...member().record,source:'note' as const,windowTitle:'',appName:'记录',textPreview:'Generated literal note title'}};
 const api=apiWith(()=>page([{type:'record',id:'signed-day-row-not-a-uuid',day:'2026-10-29',...note},group({id:'known-count',sampleCount:305,recordCount:71})]));
 await act(async()=>root.render(view(api,ref=>opened.push(ref))));await act(async()=>d.querySelector<HTMLButtonElement>('.library-time-record')!.click());assert.deepEqual(opened,['capture:'+id]);assert.equal(d.querySelector('.library-time-record strong')!.textContent,'Generated literal note title');assert.equal(d.querySelector('.library-time-record')!.getAttribute('data-reference'),'capture:'+id);assert.match(d.querySelector('.library-time-count')!.textContent!,/305 个样本/);assert.match(d.querySelector('.library-time-count')!.textContent!,/71 条记录/);
});

test('all filters remain scoped and new filters or owners cannot send a prior cursor or publish a late group',async t=>{
 const {root,d,w}=await fixture(t),paths:string[]=[],late=deferred();let lateSignal:AbortSignal|undefined;
 const api=apiWith((path,init)=>{paths.push(path);if(path.includes('cursor=')){lateSignal=init?.signal as AbortSignal;return late.promise;}return page([], 'old-page-2');});
 await act(async()=>root.render(view(api)));await act(async()=>buttons(d,'下一页')[0]!.click());
 await change(d,w,'筛选设备','generated');assert.equal(lateSignal?.aborted,true);let query=new URL('http://localhost'+paths.at(-1)).searchParams;assert.equal(query.get('deviceId'),'generated');assert.equal(query.has('cursor'),false);
 await change(d,w,'筛选记录来源','screen');await change(d,w,'筛选采集级别','content');await change(d,w,'筛选 OCR 状态','completed');
 // React text inputs use the input event, exercised by the real browser journey; set the controlled state through its native event here too.
 const app=d.querySelector<HTMLInputElement>('[aria-label="应用标识"]')!;await act(async()=>{Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value')!.set!.call(app,'generated.app');app.dispatchEvent(new w.Event('input',{bubbles:true}));});
 query=new URL('http://localhost'+paths.at(-1)).searchParams;assert.equal(query.get('deviceId'),'generated');assert.equal(query.get('source'),'screen');assert.equal(query.get('collection'),'content');assert.equal(query.get('ocrStatus'),'completed');
 const nextPaths:string[]=[],nextApi=apiWith(path=>{nextPaths.push(path);return page();});await act(async()=>root.render(view(nextApi)));assert.ok(nextPaths.length);assert.ok(nextPaths.every(path=>!new URL('http://localhost'+path).searchParams.has('cursor')));assert.ok(nextPaths.every(path=>!new URL('http://localhost'+path).searchParams.has('deviceId')));
 await act(async()=>late.resolve(page([group({id:'old-owner',deviceName:'STALE OWNER'})])));assert.doesNotMatch(d.body.textContent!,/STALE OWNER/);
});

test('a changed or forbidden group withdraws its members; explicit reload keeps the same scope and never chooses another group',async t=>{
 const {root,d,w}=await fixture(t),paths:string[]=[];let failure=0;const pending=deferred();
 const api=apiWith(path=>{paths.push(path);if(path.includes('/members?')){if(failure)throw new ApiError('changed',failure,'changed');return members();}if(failure===409)return pending.promise;return page();});
 await act(async()=>root.render(view(api)));await change(d,w,'筛选设备','generated');await open(d,w);assert.ok(d.querySelector('.library-time-observation'));
 const memberPath=paths.at(-1)!;failure=503;await act(async()=>resources(api).get(memberPath).refresh());assert.ok(d.querySelector('.library-time-observation'),'a transient read failure retains this exact known group');
 failure=409;await act(async()=>resources(api).get(memberPath).refresh());assert.equal(d.querySelector('.library-time-observation'),null);assert.match(d.body.textContent!,/重新读取当前范围/);
 await act(async()=>d.querySelector<HTMLButtonElement>('.library-time-members [role="alert"] button')!.click());assert.equal(d.querySelector('.library-time-group')!.hasAttribute('open'),false);const query=new URL('http://localhost'+paths.at(-1)).searchParams;assert.equal(query.get('deviceId'),'generated');assert.equal(query.has('group'),false);assert.equal(query.has('cursor'),false);
 await act(async()=>pending.resolve(page([group({id:'new-signed-group'})])));assert.equal(d.querySelector('.library-time-group')!.getAttribute('data-group-id'),'new-signed-group');assert.equal(d.querySelector('.library-time-group')!.hasAttribute('open'),false);
});

test('wrong group identity or revision never publishes members; denied top-level data stays withdrawn through a slow retry',async t=>{
 const {root,d,w}=await fixture(t),paths:string[]=[];let wrong=true,wrongRevision=false,denied=false,slow=false;const pending=deferred();
 const api=apiWith(path=>{paths.push(path);if(path.includes('/members?'))return {...members(),revision:wrongRevision?'stale-revision':'exact-revision',group:group({id:wrong?'different-group':'opaque-exact-group'})};if(denied)throw new ApiError('denied',403,'denied');if(slow)return pending.promise;return page();});
 await act(async()=>root.render(view(api)));await open(d,w);assert.equal(d.querySelector('.library-time-observation'),null);assert.match(d.body.textContent!,/当前不可用/);
 wrong=false;wrongRevision=true;await act(async()=>resources(api).get(paths.find(path=>path.includes('/members?'))!).refresh());assert.equal(d.querySelector('.library-time-observation'),null,'exact group with stale revision still cannot display members');wrongRevision=false;await act(async()=>resources(api).get(paths.find(path=>path.includes('/members?'))!).refresh());assert.ok(d.querySelector('.library-time-observation'));
 denied=true;const first=paths[0]!;await act(async()=>resources(api).get(first).refresh());assert.equal(d.querySelector('.library-time-group'),null);
 denied=false;slow=true;await act(async()=>resources(api).get(first).refresh());assert.equal(d.querySelector('.library-time-group'),null,'a retry cannot redisplay withdrawn evidence before its response');await act(async()=>pending.resolve(page()));assert.ok(d.querySelector('.library-time-group'));
});

test('real Central grouping reaches the exact original and returning keeps the opened member page',async t=>{
 const {root,d,w}=await fixture(t);
 const {buildApp}=await import('../../server/src/app.js'),{Archive}=await import('../src/plugins/library/Archive.js'),{featuresReady}=await import('../src/features/bootstrap.js');await featuresReady;
 const {mkdtempSync,rmSync}=await import('node:fs'),{join}=await import('node:path'),{tmpdir}=await import('node:os');
 const directory=mkdtempSync(join(tmpdir(),'mote-timeline-consumer-')),token='generated-timeline-consumer-owner-123456';
 const node=await buildApp({dataDir:directory,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:3_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No models in timeline consumer regression');},close:async()=>{}}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+token,'x-mote-ingress-version':'2'};
 for(let index=0;index<25;index++){const at=new Date();at.setHours(10,0,index,0);const response=await node.app.inject({method:'POST',url:'/api/captures',headers,payload:{id:crypto.randomUUID(),deviceId:'generated',deviceName:'Generated Mac',platform:'macos',capturedAt:at.toISOString(),durationMs:1000,appId:'generated.app',appName:'Generated exact activity '+index,windowTitle:'',source:'activity',ocrText:'',metadata:{version:1,observedAt:at.toISOString()},privacy:{collection:'activity',mode:'none'}}});assert.equal(response.statusCode,201,response.body);}
 const paths:string[]=[],api=apiWith(async path=>{paths.push(path);const response=await node.app.inject({url:path,headers});assert.equal(response.statusCode,200,response.body);return response.json();});
 const priorLocation=Object.getOwnPropertyDescriptor(globalThis,'location'),priorStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');Object.defineProperty(globalThis,'location',{value:w.location,configurable:true});Object.defineProperty(globalThis,'localStorage',{value:w.localStorage,configurable:true});t.after(()=>{for(const [key,prior]of [['location',priorLocation],['localStorage',priorStorage]] as const)if(prior)Object.defineProperty(globalThis,key,prior);else Reflect.deleteProperty(globalThis,key);});
 const props={api,devices:[],range:{},activity:{apps:[],devices:[],totalDurationMs:0,captures:0},revision:0,onOpen:()=>{},tab:'records',setTab:()=>{}};
 await act(async()=>root.render(React.createElement(Archive,props)));assert.match(d.querySelector('.library-time-count')!.textContent!,/25 条记录/);await open(d,w);assert.equal(d.querySelectorAll('.library-time-observation').length,24);
 await act(async()=>buttons(d,'下一页',d.querySelector('.library-time-member-pagination')!)[0]!.click());assert.equal(d.querySelectorAll('.library-time-observation').length,1);
 const opener=d.querySelector<HTMLButtonElement>('.library-time-observation')!,exact=opener.getAttribute('data-reference')!;opener.focus();await act(async()=>opener.click());assert.ok(paths.includes('/api/capture-browser/'+exact.slice(8)));assert.ok(d.querySelector('.library-master')!.hasAttribute('hidden'));assert.match(d.querySelector('.library-detail')!.textContent!,/Generated exact activity/);
 await act(async()=>buttons(d,'返回资料列表')[0]!.click());assert.equal(d.querySelector('.library-time-group')!.hasAttribute('open'),true);assert.match(d.querySelector('.library-time-member-pagination')!.textContent!,/第 2 页/);assert.equal(d.activeElement,opener);assert.equal(d.querySelector('.library-time-observation')!.getAttribute('data-reference'),exact);
 const expanded=d.querySelector<HTMLDetailsElement>('.library-time-group')!,oldGroup=expanded.getAttribute('data-group-id');
 const addedAt=new Date();addedAt.setHours(10,0,26,0);const added=await node.app.inject({method:'POST',url:'/api/captures',headers,payload:{id:crypto.randomUUID(),deviceId:'generated',deviceName:'Generated Mac',platform:'macos',capturedAt:addedAt.toISOString(),durationMs:1000,appId:'generated.app',appName:'Generated exact activity 26',windowTitle:'',source:'activity',ocrText:'',metadata:{version:1,observedAt:addedAt.toISOString()},privacy:{collection:'activity',mode:'none'}}});assert.equal(added.statusCode,201,added.body);
 await act(async()=>root.render(React.createElement(Archive,{...props,revision:1})));
 assert.ok(d.querySelector('.library-time-group')===expanded,'a real host revision preserves the mounted conceptual group');assert.equal(expanded.open,true);assert.notEqual(expanded.getAttribute('data-group-id'),oldGroup,'the real producer issued a new sealed locator');
 const freshMembers=new URL('http://localhost'+paths.filter(path=>path.includes('/timeline/members?')).at(-1)).searchParams;
 assert.equal(freshMembers.get('group'),expanded.getAttribute('data-group-id'));assert.equal(freshMembers.has('cursor'),false);assert.match(expanded.textContent!,/第 1 页/);assert.equal(d.querySelectorAll('.library-time-observation').length,24);assert.match(d.querySelector('.library-time-count')!.textContent!,/26 条记录/);
 // JSDOM has no viewport observer. These offscreen images are not part of the
 // session identity contract; keep their lazy image transport unobserved.
 const priorObserver=Object.getOwnPropertyDescriptor(globalThis,'IntersectionObserver');Object.defineProperty(globalThis,'IntersectionObserver',{value:class{observe(){}unobserve(){}disconnect(){}},configurable:true});t.after(()=>{if(priorObserver)Object.defineProperty(globalThis,'IntersectionObserver',priorObserver);else Reflect.deleteProperty(globalThis,'IntersectionObserver');});
 const sharp=(await import('sharp')).default,image=(await sharp({create:{width:8,height:8,channels:3,background:'#718294'}}).png().toBuffer()).toString('base64'),screenAt=new Date();screenAt.setHours(11,0,0,0);
 const screenIds=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','ffffffff-ffff-4fff-8fff-ffffffffffff'];
 const addScreen=async(id:string)=>{const response=await node.app.inject({method:'POST',url:'/api/captures',headers,payload:{id,deviceId:'generated-tied-screens',deviceName:'Generated tied screens',platform:'macos',capturedAt:screenAt.toISOString(),durationMs:0,appId:'',appName:'',windowTitle:'Generated tied screenshot',source:'screen',imageMime:'image/png',imageBase64:image,ocrText:'Generated image text',ocr:{status:'completed'},privacy:{collection:'content',mode:'none'}}});assert.equal(response.statusCode,201,response.body);};
 await addScreen(screenIds[0]!);await addScreen(screenIds[1]!);
 const screenProps={...props,devices:[{deviceId:'generated-tied-screens',deviceName:'Generated tied screens',platform:'macos',status:'capturing',queueDepth:0,lastSeenAt:screenAt.toISOString()}]};
 await act(async()=>root.render(React.createElement(Archive,{...screenProps,revision:2})));await change(d,w,'筛选设备','generated-tied-screens');
 const produced=await api.request<CaptureTimelinePage>(paths.filter(path=>path.startsWith('/api/capture-browser/timeline?')).at(-1)!);
 assert.equal(produced.items.length,2);assert.ok(produced.items.every(item=>item.type==='group'&&item.kind==='screen-session'&&item.appId===''&&item.firstAt===screenAt.toISOString()),'actual empty-app segmentation produces two tied public anchors');
 await open(d,w);const removed=d.querySelector('.library-time-frame')!.getAttribute('data-reference')!.slice(8),remaining=screenIds.slice(0,2).find(id=>id!==removed)!;
 const erased=await node.app.inject({method:'DELETE',url:'/api/captures/'+removed,headers});assert.equal(erased.statusCode,200,erased.body);
 await act(async()=>root.render(React.createElement(Archive,{...screenProps,revision:3})));
 assert.equal(d.querySelectorAll('.library-time-group').length,1);assert.equal((d.querySelector('.library-time-group') as HTMLDetailsElement).open,false,'a real deletion cannot transfer the erased session disclosure to its survivor');
 await open(d,w);assert.equal(d.querySelector('.library-time-frame')!.getAttribute('data-reference'),'capture:'+remaining);
 await addScreen(screenIds[2]!);await act(async()=>root.render(React.createElement(Archive,{...screenProps,revision:4})));
 const reordered=[...d.querySelectorAll<HTMLDetailsElement>('.library-time-group')];assert.equal(reordered.length,2);assert.ok(reordered.every(item=>!item.open),'a new tied session moving the existing session down cannot inherit its expanded ownership');
 await act(async()=>{reordered[0]!.open=true;reordered[0]!.dispatchEvent(new w.Event('toggle'));});assert.equal(d.querySelector('.library-time-frame')!.getAttribute('data-reference'),'capture:'+screenIds[2]);
 // The tied anchors now straddle the actual host's 24-item boundary. A page
 // occurrence count of one must not claim global session uniqueness.
 for(let index=0;index<23;index++){const at=new Date(screenAt);at.setHours(12,0,index,0);const response=await node.app.inject({method:'POST',url:'/api/captures',headers,payload:{id:crypto.randomUUID(),deviceId:'generated-tied-screens',deviceName:'Generated tied screens',platform:'macos',capturedAt:at.toISOString(),durationMs:0,appId:'',appName:'',windowTitle:'Generated newer screenshot '+index,source:'screen',imageMime:'image/png',imageBase64:image,ocrText:'Generated newer screenshot',ocr:{status:'completed'},privacy:{collection:'content',mode:'none'}}});assert.equal(response.statusCode,201,response.body);}
 await act(async()=>root.render(React.createElement(Archive,{...screenProps,revision:5})));
 const boundary=[...d.querySelectorAll<HTMLDetailsElement>('.library-time-group')];assert.equal(boundary.length,24);assert.equal(buttons(d,'下一页',d.querySelector('.library-pagination')!)[0]!.disabled,false);
 await act(async()=>{boundary[23]!.open=true;boundary[23]!.dispatchEvent(new w.Event('toggle'));});assert.equal(boundary[23]!.querySelector('.library-time-frame')!.getAttribute('data-reference'),'capture:'+screenIds[2]);
 const deletedBoundary=await node.app.inject({method:'DELETE',url:'/api/captures/'+screenIds[2],headers});assert.equal(deletedBoundary.statusCode,200,deletedBoundary.body);
 await act(async()=>root.render(React.createElement(Archive,{...screenProps,revision:6})));
 const survivor=[...d.querySelectorAll<HTMLDetailsElement>('.library-time-group')][23]!;assert.ok(survivor);assert.equal(survivor.open,false,'the real 25th session cannot inherit the removed 24th session expansion');assert.equal(survivor.querySelector('.library-time-frame'),null);
 await act(async()=>{survivor.open=true;survivor.dispatchEvent(new w.Event('toggle'));});assert.equal(survivor.querySelector('.library-time-frame')!.getAttribute('data-reference'),'capture:'+remaining);
});


test('unknown protocol failures remain readable by default and retain complete explicit diagnostics',async t=>{const {root,d}=await fixture(t);const api=apiWith(()=>{throw new ApiError('Internal protocol secret_fixture_code',503,'generated-request-id','unrecognized_fixture_read');});await act(async()=>root.render(view(api)));const alert=d.querySelector('[role="alert"]')!;assert.match(alert.querySelector('span')!.textContent!,/中央服务暂不可用/);assert.doesNotMatch(alert.textContent!,/secret_fixture_code|unrecognized_fixture_read/);const diagnostics=d.querySelector<HTMLDetailsElement>('.library-time-failure details')!;assert.equal(diagnostics.open,false);assert.match(diagnostics.textContent!,/503/);assert.match(diagnostics.textContent!,/unrecognized_fixture_read/);assert.match(diagnostics.textContent!,/generated-request-id/);});

test('capture events leave the real timeline alone, a revision reads once, and reset still withdraws forbidden data',async t=>{
 const {root,d,w}=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});
 const paths:string[]=[];let reset=false,forbidden=false;
 const api=apiWith(path=>{paths.push(path);if(path.startsWith('/api/operations/changes?'))return{cursor:1,ids:reset?[]:['capture:generated'],reset,hasMore:false};if(forbidden)throw new ApiError('Generated reset permission withdrawal',403);return path.includes('/members?')?members():page();});
 const timelineReads=()=>paths.filter(path=>path.startsWith('/api/capture-browser/timeline?')).length;
 const memberReads=()=>paths.filter(path=>path.includes('/members?')).length;
 await act(async()=>root.render(view(api)));await open(d,w);assert.equal(timelineReads(),1);assert.equal(memberReads(),1);
 let stop!:()=>void;await act(async()=>{stop=new OperationFeed(api,1500).subscribe(()=>{});});t.after(()=>stop());
 assert.equal(timelineReads(),1,'a real capture change does not recompute the whole timeline');assert.equal(memberReads(),1);
 for(const path of ['/api/capture-browser/timeline?limit=24','/api/capture-browser/timeline/members?group=sealed']){
  for(const kind of ['capture','file','import'])assert.equal(affectedResource(path,new Set([kind+':generated']),false),false,path+' '+kind);
  assert.equal(affectedResource(path,new Set(),true),true,path+' reset');
 }
 await act(async()=>root.render(view(api,()=>{},1)));assert.equal(timelineReads(),2,'the production revision input revalidates exactly once');assert.equal(memberReads(),2);
 forbidden=true;reset=true;await act(async()=>t.mock.timers.tick(1500));
 assert.equal(timelineReads(),3,'reset is still an immediate invalidation');assert.equal(memberReads(),3);
 assert.equal(d.querySelector('.library-time-group'),null);assert.equal(d.querySelector('.library-time-observation'),null);
 assert.ok(d.querySelector('[role="alert"]'),'the reset permission failure is not hidden behind cached evidence');
});

test('a refreshed conceptual group stays expanded while its new sealed identity resets member cursors and fences late old members',async t=>{
 const {root,d,w}=await fixture(t),paths:string[]=[],late=deferred();let refreshed=false,oldSignal:AbortSignal|undefined;
 const initial=group(),next=group({id:'new-sealed-activity',firstAt:'2026-10-28T23:59:50.000Z',lastAt:'2026-10-29T00:00:30.000Z'}),media=group({id:'sealed-media',source:'media'}),nextMedia={...media,id:'new-sealed-media'};
 const api=apiWith((path,init)=>{
  paths.push(path);const query=new URL('http://localhost'+path).searchParams;
  if(path.includes('/members?')){
   if(query.get('group')===initial.id&&refreshed){oldSignal=init?.signal as AbortSignal;return late.promise;}
   if(query.get('group')===next.id){assert.equal(query.has('cursor'),false,'the old member cursor cannot be sent with the new group');return{...members(next,[{...member(other),record:{...member(other).record,windowTitle:'Generated current members'}}]),revision:'next-revision'};}
   return members(initial,[member(query.has('cursor')?other:id)],query.has('cursor')?null:'old-member-page-2');
  }
  return refreshed?{...page([nextMedia,next]),revision:'next-revision'}:page([initial,media]);
 });
 await act(async()=>root.render(view(api)));await open(d,w);
 const expanded=d.querySelector<HTMLDetailsElement>('[data-group-id="'+initial.id+'"]')!,folded=d.querySelector('[data-group-id="'+media.id+'"]');
 await act(async()=>buttons(d,'下一页',expanded.querySelector('.library-time-member-pagination')!)[0]!.click());assert.match(expanded.textContent!,/第 2 页/);
 refreshed=true;await act(async()=>root.render(view(api,()=>{},1)));
 assert.ok(d.querySelector('[data-group-id="'+next.id+'"]')===expanded,'the conceptual source group keeps its actual mounted disclosure despite an earlier first observation');
 assert.equal(expanded.open,true);assert.ok(d.querySelector('[data-group-id="'+nextMedia.id+'"]')===folded,'the other source at the same instant has its own stable identity');
 assert.equal((folded as HTMLDetailsElement).open,false);assert.match(expanded.textContent!,/第 1 页/);assert.match(expanded.textContent!,/Generated current members/);
 assert.equal(oldSignal?.aborted,true,'switching to the new locator releases the old member request');
 await act(async()=>late.resolve(members(initial,[{...member(),record:{...member().record,windowTitle:'STALE SEALED MEMBERS'}}])));
 assert.doesNotMatch(d.body.textContent!,/STALE SEALED MEMBERS/);assert.equal(expanded.querySelector('.library-time-observation')!.getAttribute('data-reference'),'capture:'+other);
});

test('a second timeline page 409 automatically reads the first page and retains the changed-timeline notice through recovery',async t=>{
 const {root,d}=await fixture(t),paths:string[]=[],recovery=deferred();let firstReads=0;
 const api=apiWith(path=>{paths.push(path);if(new URL('http://localhost'+path).searchParams.has('cursor'))throw new ApiError('Generated stale timeline cursor',409,'generated-page-conflict');return ++firstReads===1?page([group()],'stale-page-2'):recovery.promise;});
 await act(async()=>root.render(view(api)));await act(async()=>buttons(d,'下一页',d.querySelector('.library-pagination')!)[0]!.click());
 assert.equal(firstReads,2,'a stale later cursor starts a real new first-page request');assert.match(d.querySelector('.library-pagination')!.textContent!,/第 1 页/);
 assert.match(d.querySelector('[role="alert"]')!.textContent!,/时间回看内容已变化，请重新读取当前范围/);
 assert.equal(d.querySelector('.workspace-empty'),null,'an unresolved recovery is not rendered as an empty successful page');
 await act(async()=>recovery.resolve(page([group({id:'recovered-page',deviceName:'Generated recovered first page'})],'current-page-2')));
 assert.equal(d.querySelector('.library-time-group')!.getAttribute('data-group-id'),'recovered-page');
 assert.match(d.querySelector('[role="alert"]')!.textContent!,/时间回看内容已变化/,'the original conflict remains visible after the successful first page');
 assert.match(d.querySelector('.library-time-failure details')!.textContent!,/generated-page-conflict/);
 assert.equal(paths.filter(path=>new URL('http://localhost'+path).searchParams.has('cursor')).length,1,'the invalid cursor is not retried');
});

test('a transient later-page failure remains on that page and never becomes an empty success',async t=>{
 const {root,d}=await fixture(t);let firstReads=0;
 const api=apiWith(path=>{if(new URL('http://localhost'+path).searchParams.has('cursor'))throw new ApiError('Generated temporary page failure',503);firstReads++;return page([group()],'page-2');});
 await act(async()=>root.render(view(api)));await act(async()=>buttons(d,'下一页',d.querySelector('.library-pagination')!)[0]!.click());
 assert.equal(firstReads,1);assert.match(d.querySelector('.library-pagination')!.textContent!,/第 2 页/);assert.ok(d.querySelector('[role="alert"]'));assert.equal(d.querySelector('.workspace-empty'),null);
});

test('import return refreshes the same shared timeline and members consumed by the real view',async t=>{
 const {root,d,w}=await fixture(t),paths:string[]=[],freshPage=deferred(),freshMembers=deferred();let returning=false,updated=false;
 const currentPage=page([group({recordCount:72})]),currentMembers=members(group({recordCount:72}),[{...member(other),record:{...member(other).record,windowTitle:'Generated import return member'}}]);
 const api=apiWith(path=>{paths.push(path);if(path.includes('/members?'))return returning?updated?{...currentMembers,items:[{...member(),record:{...member().record,windowTitle:'Generated shared member update'}}]}:freshMembers.promise:members();return returning?updated?page([group({recordCount:73})]):freshPage.promise:page();});
 await act(async()=>root.render(view(api)));await open(d,w);
 const origin=rememberImportOrigin(api,w.location.hash,0,null);t.after(()=>clearImportReturn(api,origin));
 await act(async()=>root.render(React.createElement('p',null,'Generated import work')));returning=true;markImportReturn(api,origin);
 await act(async()=>root.render(view(api)));assert.equal(d.querySelector('.library-time-final')!.getAttribute('data-import-return-ready'),'false');assert.equal(d.querySelector('.library-time-group'),null);
 await act(async()=>freshPage.resolve(currentPage));assert.equal((d.querySelector('.library-time-group') as HTMLDetailsElement).open,true);assert.equal(d.querySelector('.library-time-observation'),null,'return waits for this visit\'s member read');
 await act(async()=>freshMembers.resolve(currentMembers));assert.match(d.querySelector('.library-time-observation')!.textContent!,/Generated import return member/);
 assert.equal(d.querySelector('.library-time-group')!.getAttribute('data-import-return-ready'),'true');
 const timelinePath=paths.find(path=>path.startsWith('/api/capture-browser/timeline?'))!,memberPath=paths.find(path=>path.includes('/members?'))!;
 assert.ok(resources(api).get(timelinePath).getSnapshot().data===currentPage);assert.ok(resources(api).get(memberPath).getSnapshot().data===currentMembers);
 clearImportReturn(api,origin);updated=true;await act(async()=>{resources(api).get(timelinePath).invalidate();resources(api).get(memberPath).invalidate();});
 assert.match(d.querySelector('.library-time-count')!.textContent!,/73 条记录/);assert.match(d.querySelector('.library-time-observation')!.textContent!,/Generated shared member update/,'later shared invalidation still reaches the mounted member consumer');
 await act(async()=>d.querySelector<HTMLButtonElement>('[aria-label="刷新记录"]')!.click());assert.match(d.querySelector('.library-time-count')!.textContent!,/73 条记录/);
 const beforeDate=paths.length;await act(async()=>d.querySelector<HTMLButtonElement>('[aria-label="查看前一天"]')!.click());assert.ok(paths.length>beforeDate);assert.notEqual(new URL('http://localhost'+paths.at(-1)).searchParams.get('after'),new URL('http://localhost'+timelinePath).searchParams.get('after'));
});

test('scope and API changes close the retained group and late members cannot cross either boundary',async t=>{
 const {root,d,w}=await fixture(t),lateScope=deferred(),lateOwner=deferred();let scopeSignal:AbortSignal|undefined,ownerSignal:AbortSignal|undefined;
 const api=apiWith((path,init)=>{if(!path.includes('/members?'))return page();if(new URL('http://localhost'+path).searchParams.has('deviceId')){ownerSignal=init?.signal as AbortSignal;return lateOwner.promise;}scopeSignal=init?.signal as AbortSignal;return lateScope.promise;});
 await act(async()=>root.render(view(api)));await open(d,w);await change(d,w,'筛选设备','generated');
 assert.equal(scopeSignal?.aborted,true);assert.equal((d.querySelector('.library-time-group') as HTMLDetailsElement).open,false);await open(d,w);
 const nextPaths:string[]=[],next=apiWith(path=>{nextPaths.push(path);return path.includes('/members?')?members():page();});
 await act(async()=>root.render(view(next)));assert.equal(ownerSignal?.aborted,true);assert.equal((d.querySelector('.library-time-group') as HTMLDetailsElement).open,false);
 await act(async()=>{lateScope.resolve(members(group(),[{...member(),record:{...member().record,windowTitle:'STALE SCOPE MEMBERS'}}]));lateOwner.resolve(members(group(),[{...member(),record:{...member().record,windowTitle:'STALE OWNER MEMBERS'}}]));});
 assert.doesNotMatch(d.body.textContent!,/STALE SCOPE MEMBERS|STALE OWNER MEMBERS/);assert.equal(d.querySelector('.library-time-observation'),null);
 assert.ok(nextPaths.every(path=>!new URL('http://localhost'+path).searchParams.has('deviceId')));await open(d,w);assert.ok(d.querySelector('.library-time-observation'));
});

test('simultaneous screen sessions preserve only unambiguous mounted identities across sealed-locator updates',async t=>{
 const {root,d,w}=await fixture(t),paths:string[]=[],warnings:string[]=[];let refreshed=false;
 const before=[group({id:'screen-one',kind:'screen-session',source:'screen',appId:'generated.one'}),group({id:'screen-two',kind:'screen-session',source:'screen',appId:'generated.two'}),group({id:'screen-tie',kind:'screen-session',source:'screen',appId:'generated.two'})];
 const after=before.map(item=>({...item,id:'next-'+item.id})),originalError=console.error;t.mock.method(console,'error',(...values:unknown[])=>{warnings.push(values.map(String).join(' '));originalError(...values);});
 const api=apiWith(path=>{paths.push(path);if(!path.includes('/members?'))return{...page(refreshed?after:before),revision:refreshed?'next-revision':'exact-revision'};const selected=(refreshed?after:before).find(item=>item.id===new URL('http://localhost'+path).searchParams.get('group'))!;return{...members(selected,[member(refreshed?other:id)]),revision:refreshed?'next-revision':'exact-revision'};});
 await act(async()=>root.render(view(api)));const nodes=[...d.querySelectorAll<HTMLDetailsElement>('.library-time-group')];await open(d,w);
 refreshed=true;await act(async()=>root.render(view(api,()=>{},1)));
 assert.equal(nodes.length,3);assert.ok(d.querySelector('[data-group-id="'+after[0]!.id+'"]')===nodes[0]);assert.equal(nodes[0]!.open,true);
 for(let index=1;index<3;index++){const next=d.querySelector<HTMLDetailsElement>('[data-group-id="'+after[index]!.id+'"]')!;assert.ok(next!==nodes[index],'ambiguous session anchors do not preserve mounted ownership across sealed revisions');assert.equal(next.open,false);}
 assert.equal(nodes[0]!.querySelector('.library-time-frame')!.getAttribute('data-reference'),'capture:'+other);
 assert.ok(paths.some(path=>path.includes('/members?')&&new URL('http://localhost'+path).searchParams.get('group')===after[0]!.id));
 assert.ok(warnings.every(message=>!/same key|unique.*key/i.test(message)),'even tied public session anchors have distinct React keys');
});

for(const changeKind of ['remove','reorder'] as const)test(`tied screen sessions cannot inherit another session's expansion after ${changeKind}`,async t=>{
 const {root,d,w}=await fixture(t),paths:string[]=[];let refreshed=false;
 const before=[group({id:'tied-first',kind:'screen-session',source:'screen',appId:''}),group({id:'tied-second',kind:'screen-session',source:'screen',appId:''})];
 const after=(changeKind==='remove'?[before[1]!]:[before[1]!,before[0]!]).map(item=>({...item,id:'next-'+item.id}));
 const api=apiWith(path=>{paths.push(path);if(!path.includes('/members?'))return{...page(refreshed?after:before),revision:refreshed?'next-revision':'exact-revision'};const requested=new URL('http://localhost'+path).searchParams.get('group');if(refreshed&&before.some(item=>item.id===requested))throw new ApiError('Generated expired session locator',409);const selected=(refreshed?after:before).find(item=>item.id===requested)!;return{...members(selected,[member(refreshed?other:id)]),revision:refreshed?'next-revision':'exact-revision'};});
 await act(async()=>root.render(view(api)));await open(d,w);assert.equal((d.querySelector('.library-time-group') as HTMLDetailsElement).open,true);
 refreshed=true;await act(async()=>root.render(view(api,()=>{},1)));
 assert.ok([...d.querySelectorAll<HTMLDetailsElement>('.library-time-group')].every(node=>!node.open),'an ambiguous public anchor cannot carry an expanded state into a different session');
 assert.ok(paths.every(path=>!path.includes('/members?')||!new URL('http://localhost'+path).searchParams.get('group')?.startsWith('next-')),'new ambiguous sessions wait for an explicit open');
 await open(d,w);assert.equal(d.querySelector('.library-time-frame')!.getAttribute('data-reference'),'capture:'+other);
 assert.equal(new URL('http://localhost'+paths.at(-1)).searchParams.get('group'),after[0]!.id);
});

test('a screen-session anchor seen once on a partial page is not proof of identity after another session moves onto that page',async t=>{
 const {root,d,w}=await fixture(t);let refreshed=false;
 const initial=group({id:'visible-screen',kind:'screen-session',source:'screen',appId:'generated.same-app'}),replacement={...initial,id:'previously-hidden-screen'};
 const newer:CaptureTimelinePage['items']=Array.from({length:23},(_,index)=>({type:'record',id:'generated-newer-'+index,day:initial.day,...member(crypto.randomUUID())}));
 const api=apiWith(path=>path.includes('/members?')?{...members(refreshed?replacement:initial,[member(refreshed?other:id)]),revision:refreshed?'next-revision':'exact-revision'}:{...page([...newer,refreshed?replacement:initial],refreshed?null:'real-hidden-second-anchor'),revision:refreshed?'next-revision':'exact-revision'});
 await act(async()=>root.render(view(api)));await open(d,w);assert.equal((d.querySelector('.library-time-group') as HTMLDetailsElement).open,true);
 refreshed=true;await act(async()=>root.render(view(api,()=>{},1)));
 assert.equal((d.querySelector('.library-time-group') as HTMLDetailsElement).open,false,'a same-app anchor can also be ambiguous beyond the current page');assert.equal(d.querySelector('.library-time-frame'),null);
 await open(d,w);assert.equal(d.querySelector('.library-time-frame')!.getAttribute('data-reference'),'capture:'+other);
});
