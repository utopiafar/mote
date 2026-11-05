import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {Archive} from '../src/plugins/library/Archive.js';
import { featuresReady } from '../src/features/bootstrap.js';
import { webFeatures } from '../src/features/registry.js';
import {type Api,type Capture,type Activity} from '../src/api.js';
import {type Material} from '../src/Materials.js';
import {LibraryMaterials} from '../src/plugins/library/LibraryBrowse.js';

configureLocale(()=> 'zh-CN');
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const when='2026-09-01T10:00:00Z',activity:Activity={apps:[],devices:[],totalDurationMs:0,captures:0};
const row=(value=id)=>({id:value,deviceId:'fixture-device',deviceName:'Generated device',platform:'macos',capturedAt:when,source:'note',appName:'Generated note',windowTitle:'Generated '+value[0],durationMs:0,hasImage:false,ocr:{status:'not_applicable'},textPreview:'Generated original text'});
const timeline=(rows:ReturnType<typeof row>[],nextCursor:string|null=null)=>({revision:'generated-current',items:rows.map(record=>({type:'record',id:'projection-'+record.id,day:'2026-10-29',firstAt:when,lastAt:when,sampleCount:null,record})),nextCursor});
const capture=(value=id):Capture=>({...row(value),source:'note',ocrText:'<script>Generated untrusted evidence</script>',blobHash:null,indexingStatus:'text_ready',privacy:{redacted:false,mode:'none'},deletion:{available:true,kind:'capture'},provenance:{sourceId:'fixture-source',externalId:'fixture-original',revision:'fixture-version',layer:'snapshot',document:{recordedAt:when,path:'generated/note.txt',contentRole:'authored'}}} as Capture);
function deferred(){let resolve!:(value:unknown)=>void;const promise=new Promise<unknown>(done=>{resolve=done;});return {promise,resolve};}

async function fixture(t:any){
  await featuresReady;
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/#/library',pretendToBeVisual:true});
  const previous=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
  const root=createRoot(dom.window.document.getElementById('root')!);
  t.after(async()=>{await act(async()=>root.unmount());for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
  return {root,d:dom.window.document,w:dom.window};
}
function apiWith(read:(path:string,init?:RequestInit)=>unknown):Api{return {request:async(path:string,init?:RequestInit)=>{if(path.startsWith('/api/actions/by-evidence/'))return {items:[],hasMore:false};
  if(path==='/api/library/descriptor')return {schemaVersion:1,revision:1,types:[]};
  if(path==='/api/features')return {schemaVersion:1,revision:1,features:[],capabilities:['/api/capture-browser','/api/capture-browser/timeline','/api/capture-browser/timeline/members','/api/library/browse','/api/coding/uploads'].map(path=>({id:'http:GET:'+path,version:'1',state:'active'}))};
  const result=await read(path,init);return path.startsWith('/api/library/browse?')?{schemaVersion:1,types:[],sources:[],noteOrigin:{origin:'notes',label:'记录'},...result as object,items:((result as any).items??[]).map((material:any)=>material.entryType?material:{entryType:'material',ref:material.ref,contentAt:material.origin?.lastAt??material.updatedAt??when,material})}:result;
},setAgentTimeout:()=>{}} as Api;}
function view(api:Api,extras:Partial<React.ComponentProps<typeof Archive>>={}){return React.createElement(Archive,{api,devices:[{deviceId:'fixture-device',deviceName:'Generated device',platform:'macos',status:'capturing',queueDepth:0,lastSeenAt:when}],range:{},activity,revision:0,onOpen:()=>{},tab:'records',setTab:()=>{},...extras});}
const button=(d:Document,text:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(item=>item.textContent===text)!;

test('an invalid date deep link keeps filters recoverable without widening or crashing the library',async t=>{
  const {root,d,w}=await fixture(t),reads:string[]=[];
  const api=apiWith(path=>{reads.push(path);return {items:[],sources:[],nextCursor:null};});
  for(const value of ['2026-13-01','2026-02-30','not-a-date']){
    w.location.hash='#/library?view=materials&sourceId=generated-source&after='+value;
    await act(async()=>{root.render(React.createElement(LibraryMaterials,{key:value,api,revision:0,onSelect:()=>{}}));});
    assert.match(d.querySelector('[role=alert]')!.textContent!,/请选择有效日期/);
    assert.equal(reads.filter(path=>path.startsWith('/api/library/browse?')).length,0,'invalid scope must not silently become an unfiltered request');
  }
  await act(async()=>button(d,'清除筛选').click());
  assert.equal(d.querySelector('[role=alert]'),null);
  assert.ok(reads.some(path=>path.startsWith('/api/library/browse?')),'clearing the invalid filter restores a normal catalog read');
  w.location.hash='#/library?view=materials&after=2028-02-29';
  await act(async()=>w.dispatchEvent(new w.Event('hashchange')));
  assert.ok(reads.some(path=>new URL('http://localhost'+path).searchParams.has('after')),'valid leap day remains a usable explicit range');
});

test('explicit library navigation leads directly into rows and source details without nested record-view tabs',async t=>{
  const {root,d}=await fixture(t),reads:string[]=[],opened:string[]=[];
  const api=apiWith(path=>{reads.push(path);if(path.startsWith('/api/capture-browser/timeline?'))return timeline([row()]);if(path.startsWith('/api/capture-browser/'))return capture();throw Error('Unexpected generated request '+path);});
  await act(async()=>root.render(view(api,{onOpen:ref=>opened.push(ref)})));
  assert.deepEqual(new Set(Array.from(d.querySelectorAll('[data-collection-id]'),node=>node.getAttribute('data-collection-id'))),new Set(webFeatures.collections().filter(entry=>entry.id!=='memories').map(entry=>entry.id)),'all registered collections remain reachable in the primary, context or More links');
  assert.equal(d.querySelector('[data-collection-id="coding-status"]')?.textContent,'Coding 同步状态','the accepted source exposes the existing receipt view as a contextual link');
  assert.ok(webFeatures.collections().some(entry=>entry.id==='coding-status'));
  assert.equal(d.querySelector('[data-collection-id="segments"]')?.textContent,'片段与应用相册');assert.equal(d.querySelector('select[aria-label="资料类型"]'),null);assert.equal(d.querySelector('[aria-label="记录视图"]'),null);
  assert.equal(d.querySelector('.library-detail h3')?.textContent,'选择一条资料');
  assert.equal(d.querySelector<HTMLElement>('.library-detail')!.hidden,true,'unselected detail is absent from the visible list');
  const record=d.querySelector<HTMLButtonElement>('.library-record')!;record.focus();
  await act(async()=>record.click());
  assert.equal(d.querySelector('.library-browser')?.classList.contains('has-selection'),true);
  assert.equal(d.querySelector<HTMLElement>('.library-master')!.hidden,true,'the reader replaces the visible list at every viewport');
  assert.match(d.querySelector('.library-detail')!.textContent!,/Generated a/);
  assert.match(d.querySelector('.library-detail')!.textContent!,/Generated device/);
  assert.match(d.querySelector('.library-detail')!.textContent!,/generated\/note.txt/);
  assert.match(d.querySelector('.library-detail')!.textContent!,/Generated untrusted evidence/);
  assert.equal(d.querySelector('.library-detail script'),null);
  assert.ok(reads.includes('/api/capture-browser/'+id));
  await act(async()=>button(d,'更多').click());
  assert.ok(button(d,'删除这条记录'),'the shared reader retains original deletion in More');
  await act(async()=>d.querySelector<HTMLButtonElement>('[aria-label="关闭资料操作"]')!.click());
  assert.ok(d.querySelector('.reader-source-details'),'provenance stays available in the shared reader');
  assert.deepEqual(opened,[],'opening list detail no longer requires a second nested reader');
  await act(async()=>button(d,'返回资料列表').click());
  assert.equal(d.querySelector('.library-browser')?.classList.contains('has-selection'),false);
  assert.equal(d.activeElement,record,'return preserves the original list and keyboard opener');
});

test('two primary library tabs keep registered specialized views secondary and unavailable links recoverable',async t=>{
 const {root,d}=await fixture(t),selected:string[]=[];
 const api=apiWith(path=>path.startsWith('/api/library/browse?')?{items:[],nextCursor:null}:timeline([row()]));
 await act(async()=>root.render(view(api,{setTab:tab=>selected.push(tab)})));
 assert.deepEqual(Array.from(d.querySelectorAll('.library-primary-tabs button'),node=>node.textContent),['我的资料','我的记忆']);
 assert.equal(d.querySelector('.library-secondary-views')?.hasAttribute('open'),false);
 assert.equal(d.querySelector('[data-collection-id="coding-status"]')?.textContent,'Coding 同步状态');
 await act(async()=>button(d,'我的记忆').click());assert.deepEqual(selected,['memories']);
 await act(async()=>root.render(view(api,{tab:'generated-removed-collection'})));
 assert.equal(d.querySelector('.library-secondary-views summary')?.textContent,'更多');
 assert.match(d.querySelector('.library-content')?.textContent??'',/当前不可用/);
});

test('record pagination and explicit device filters keep their request scope while returning from detail',async t=>{
  const {root,d,w}=await fixture(t),paths:string[]=[];
  const api=apiWith(path=>{paths.push(path);if(path.startsWith('/api/capture-browser/timeline?')){const params=new URL('http://localhost'+path).searchParams;return timeline([row(params.get('cursor')?other:id)],params.has('cursor')?null:'generated-next');}if(path.startsWith('/api/capture-browser/'))return capture(other);throw Error(path);});
  await act(async()=>root.render(view(api)));
  const filter=d.querySelector<HTMLSelectElement>('select[aria-label="筛选设备"]')!;
  await act(async()=>{filter.value='fixture-device';filter.dispatchEvent(new w.Event('change',{bubbles:true}));});
  await act(async()=>button(d,'下一页').click());
  const latest=new URL('http://localhost'+paths.filter(path=>path.startsWith('/api/capture-browser/timeline?')).at(-1)!);
  assert.equal(latest.searchParams.get('deviceId'),'fixture-device');assert.equal(latest.searchParams.get('cursor'),'generated-next');
  await act(async()=>d.querySelector<HTMLButtonElement>('.library-record')!.click());
  await act(async()=>button(d,'返回资料列表').click());
  assert.equal(filter.value,'fixture-device');assert.match(d.querySelector('.library-pagination')!.textContent!,/第 2 页/);
  assert.match(d.querySelector('.library-record')!.textContent!,/Generated b/);
});

test('switching collections or authenticated nodes cannot retain an old selected object or a late page',async t=>{
  const {root,d}=await fixture(t),oldPage=deferred();let signal:AbortSignal|undefined;
  const oldApi=apiWith((path,init)=>{signal=init?.signal as AbortSignal;return oldPage.promise;});
  const newApi=apiWith(path=>path.startsWith('/api/library/browse?')?{items:[],nextCursor:null}:path.startsWith('/api/capture-browser/timeline?')?timeline([row(other)]):capture(other));
  await act(async()=>root.render(view(oldApi)));
  await act(async()=>root.render(view(newApi)));
  assert.equal(signal?.aborted,true);
  await act(async()=>d.querySelector<HTMLButtonElement>('.library-record')!.click());
  await act(async()=>oldPage.resolve(timeline([row(id)])));
  assert.match(d.querySelector('.library-master')!.textContent!,/Generated b/);assert.doesNotMatch(d.querySelector('.library-master')!.textContent!,/Generated a/);
  assert.match(d.querySelector('.library-detail')!.textContent!,/Generated b/);
  await act(async()=>root.render(view(newApi,{tab:'materials'})));
  assert.equal(d.querySelector('.library-browser')?.classList.contains('has-selection'),false);
  await act(async()=>root.render(view(newApi)));
  assert.equal(d.querySelector('.library-browser')?.classList.contains('has-selection'),false,'returning to an earlier collection does not resurrect its old choice');
  await act(async()=>d.querySelector<HTMLButtonElement>('.library-record')!.click());
  const emptyApi=apiWith(()=>(timeline([])));
  await act(async()=>root.render(view(emptyApi)));
  assert.equal(d.querySelector('.library-browser')?.classList.contains('has-selection'),false);
  assert.doesNotMatch(d.querySelector('.library-detail')!.textContent!,/Generated b/);
});

test('formal material selection reads its pinned version through full ReferenceDetail and expands remaining text',async t=>{
  const {root,d}=await fixture(t),materialId='mat_'+'c'.repeat(64),revision='d'.repeat(64),ref='material:'+materialId+'@'+revision,paths:string[]=[];
  const material:Material={id:materialId,ref,revision,kind:'mote.note',schemaVersion:1,title:'Generated formal material',sequence:2,textLength:4500,blockCount:1,coverage:{state:'complete'},origin:{sourceId:'generated-source'},retention:{original:'kept'}};
  const api=apiWith(path=>{paths.push(path);if(path.startsWith('/api/library/browse?'))return {items:[material],nextCursor:path.includes('cursor=')?null:'generated-next'};if(path.endsWith('/revisions/'+revision)||path==='/api/materials/'+materialId)return material;if(path.includes('/members?'))return {items:[],nextOffset:null};if(path.includes('/read?')){const offset=new URL('http://localhost'+path).searchParams.get('offset');return {material,text:offset==='4000'?'Generated remainder':'Generated first portion',textRange:{offset:offset==='4000'?4000:0,total:4500,nextOffset:offset==='4000'?null:4000}};}throw Error('Unexpected generated request '+path);});
  await act(async()=>root.render(view(api,{tab:'materials'})));
  await act(async()=>d.querySelector<HTMLButtonElement>('.library-record')!.click());
  assert.ok(paths.includes('/api/materials/'+materialId+'/revisions/'+revision));
  assert.match(d.querySelector('.library-detail')!.textContent!,/Generated first portion/);
  await act(async()=>button(d,'继续展开').click());
  assert.ok(paths.some(path=>path.includes('/read?revision='+revision+'&offset=4000')));
  assert.match(d.querySelector('.library-detail')!.textContent!,/Generated remainder/);
  await act(async()=>button(d,'来源与处理').click());
  assert.match(d.querySelector('.library-detail')!.textContent!,/generated-source/);
  await act(async()=>d.querySelector<HTMLButtonElement>('.library-master .library-pagination button')!.click());
  assert.ok(paths.some(path=>path.includes('/api/library/browse?limit=24&cursor=generated-next')));
  assert.equal(d.querySelector('.library-browser')?.classList.contains('has-selection'),false,'the next list page clears its previous pinned object');
  const nextPaths:string[]=[],nextApi=apiWith(path=>{nextPaths.push(path);return {items:[],nextCursor:null};});
  await act(async()=>root.render(view(nextApi,{tab:'materials'})));
  assert.ok(nextPaths.includes('/api/library/browse?limit=24'),'a new authenticated node starts at its own first page');
  assert.equal(nextPaths.some(path=>path.includes('generated-next')),false);
});

test('type and source filters remain explicit across chips, pagination and node changes; previews use the pinned original',async t=>{
 const {root,d,w}=await fixture(t),paths:string[]=[],materialId='mat_'+'1'.repeat(64),revision='2'.repeat(64),ref='material:'+materialId+'@'+revision;
 const material:Material={id:materialId,ref,revision,kind:'mote.note',schemaVersion:1,title:'Generated preview',sequence:1,textLength:26,blockCount:1,coverage:{state:'complete'},origin:{sourceId:'generated-source'},retention:{original:'kept'}};
 const api=apiWith(path=>{paths.push(path);if(path.startsWith('/api/library/browse?'))return {items:[material],types:[{id:'mote.note',kind:'mote.note',schemaVersion:1,label:'记录'}],sources:[{id:'generated-source',label:'Generated source',count:1}],nextCursor:path.includes('cursor=')?null:'next'};if(path.includes('/read?'))return {material:{ref},text:'Generated exact original',spans:[{kind:'text',format:'plain',pageRange:{start:0,end:24}}]};throw Error(path);});
 await act(async()=>root.render(React.createElement(LibraryMaterials,{api,revision:0,onSelect:()=>{},materialPreview:{read:true,image:false}})));
 assert.equal(d.querySelector<HTMLElement>('#library-catalog-filters')!.hidden,true);
 assert.equal(d.querySelector('.library-record-preview')?.textContent,'Generated exact original');
 assert.ok(paths.includes('/api/materials/'+materialId+'/read?revision='+revision+'&offset=0&length=240'));
 await act(async()=>d.querySelector<HTMLButtonElement>('.library-filter-actions button')!.click());
 const selects=d.querySelectorAll<HTMLSelectElement>('.library-catalog-filters select');
 assert.deepEqual(Array.from(selects[2]!.options).map(option=>option.value),['','note','document','image','coding','transcript','email','calendar','reference']);
 await act(async()=>{selects[0]!.value='generated-source';selects[0]!.dispatchEvent(new w.Event('change',{bubbles:true}));});
 await act(async()=>{selects[2]!.value='note';selects[2]!.dispatchEvent(new w.Event('change',{bubbles:true}));});
 await act(async()=>button(d,'下一页').click());
 let query=new URL('http://localhost'+paths.filter(path=>path.startsWith('/api/library/browse?')).at(-1)!).searchParams;
 assert.equal(query.get('sourceId'),'generated-source');assert.equal(query.get('type'),'note');assert.equal(query.get('cursor'),'next');
 await act(async()=>d.querySelector<HTMLButtonElement>('.library-filter-chips button[aria-label="清除记录筛选"]')!.click());
 query=new URLSearchParams(w.location.hash.split('?')[1]);assert.equal(query.get('sourceId'),'generated-source');assert.equal(query.has('type'),false);assert.equal(query.has('cursor'),false);
 await act(async()=>{selects[3]!.value='mote.note';selects[3]!.dispatchEvent(new w.Event('change',{bubbles:true}));});
 query=new URL('http://localhost'+paths.filter(path=>path.startsWith('/api/library/browse?')).at(-1)!).searchParams;
 assert.equal(query.get('kind'),'mote.note','the advanced exact wire-kind filter remains available independently');assert.equal(query.has('type'),false);
 const otherPaths:string[]=[],otherApi=apiWith(path=>{otherPaths.push(path);return {items:[],nextCursor:null};});
 await act(async()=>root.render(React.createElement(LibraryMaterials,{api:otherApi,revision:0,onSelect:()=>{},materialPreview:{read:false,image:false}})));
 assert.deepEqual(otherPaths,['/api/library/browse?limit=24']);assert.equal(d.querySelector('.library-filter-chips'),null);assert.equal(d.querySelector('.library-record-preview'),null);
});

test('a deployed type adds card, detail, panel and action without changing the library; disposal keeps generic history readable',async t=>{
  const {root,d}=await fixture(t),materialId='mat_'+'e'.repeat(64),revision='f'.repeat(64),ref='material:'+materialId+'@'+revision;
  const material:Material={id:materialId,ref,revision,kind:'fixture.journal',schemaVersion:1,title:'Generated custom journal',sequence:1,textLength:22,blockCount:1,coverage:{state:'complete'},origin:{sourceId:'journal'},retention:{original:'kept'}};
  const type={id:'fixture.journal',kind:material.kind,schemaVersion:1,label:'Generated journal',card:'fixture.journal-card',detail:'fixture.journal-detail',panels:['fixture.journal-panel'],actions:['fixture.journal-action']};
  const api={request:async(path:string)=>{
    if(path==='/api/features')return {schemaVersion:1,revision:1,features:[],capabilities:[{id:'http:GET:/api/library/browse',version:'1',state:'active'}]};
    if(path==='/api/library/descriptor')return {schemaVersion:1,revision:1,types:[type]};
    if(path.startsWith('/api/library/browse?'))return {schemaVersion:1,types:[type],sources:[{id:'journal',label:'Generated journal source',count:1}],items:[{entryType:'material',ref,contentAt:when,material}],nextCursor:null};
    if(path.includes('/members?'))return {items:[],nextOffset:null};
    if(path.includes('/read?'))return {material,text:'Generated generic body',textRange:{offset:0,total:22,nextOffset:null}};
    if(path.startsWith('/api/materials/'))return material;
    throw Error(path);
  }} as unknown as Api;
  const contract={kind:material.kind,schemaVersion:1,representation:'owner-material'};
  const span=(text:string)=>React.createElement('span',null,text);
  const fiber=await webFeatures.install({id:'fixture.journal-ui',version:'1',components:[]},[
    {surface:'card',entry:{id:type.card,...contract,render:()=>span('Custom journal card')}},
    {surface:'renderer',entry:{id:type.detail,...contract,render:()=>span('Custom journal detail')}},
    {surface:'panel',entry:{id:type.panels[0],...contract,render:()=>span('Custom journal panel')}},
    {surface:'action',entry:{id:type.actions[0],...contract,position:'detail',render:({onOpen,value})=>React.createElement('button',{onClick:()=>onOpen(value.ref)},'Custom journal command')}},
  ]);
  t.after(()=>fiber.dispose());
  await act(async()=>root.render(view(api,{tab:'materials'})));
  assert.match(d.querySelector('.library-master')!.textContent!,/Custom journal card/);
  await act(async()=>d.querySelector<HTMLButtonElement>('.library-record')!.click());
  assert.match(d.querySelector('.library-detail')!.textContent!,/Custom journal detail/);
  assert.match(d.querySelector('.library-detail')!.textContent!,/Custom journal panel/);
  assert.ok(button(d,'Custom journal command'));
  await act(async()=>fiber.dispose());
  assert.match(d.querySelector('.library-master')!.textContent!,/Generated custom journal/);
  assert.match(d.querySelector('.library-detail')!.textContent!,/Generated generic body/);
  assert.equal(button(d,'Custom journal command'),undefined);
});

test('an explicit missing collection shows unavailable and never reads the first collection',async t=>{
 const {root,d}=await fixture(t),reads:string[]=[];
 const api=apiWith(path=>{reads.push(path);throw Error('Unexpected generated request '+path);});
 await act(async()=>root.render(view(api,{tab:'generated-removed-collection'})));
 assert.match(d.querySelector('.library-content')!.textContent!,/此资料库分类当前不可用/);
 assert.equal(d.querySelector('.library-content .library-record'),null);
 assert.deepEqual(reads,[]);
 assert.equal(d.querySelector('.library-type-filters button[aria-current=page]'),null);
});

test('owner browse real note producer reaches the current original reader and ignores a cancelled earlier owner page',async t=>{
 const {root,d}=await fixture(t);
 const {buildApp}=await import('../../server/src/app.js');
 const {mkdtempSync,rmSync}=await import('node:fs'),{join}=await import('node:path'),{tmpdir}=await import('node:os');
 const directory=mkdtempSync(join(tmpdir(),'mote-web-owner-browse-')),token='generated-web-owner-browse-token-123456';
 const node=await buildApp({dataDir:directory,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:3_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+token};
 const intake=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-web',deviceName:'Generated Web',platform:'import',capturedAt:when,text:'Actual generated original note, without invented publication.'}});assert.equal(intake.statusCode,201,intake.body);
 const original=await node.app.inject({url:'/api/library/browse?limit=24',headers});assert.equal(original.statusCode,200);assert.equal(original.json().items[0].ref,'capture:'+id);
 const pending=deferred();let signal:AbortSignal|undefined;
 const oldApi=apiWith((_path,init)=>{signal=init?.signal as AbortSignal;return pending.promise;});
 const opened:string[]=[],currentApi={request:async(path:string)=>{const response=await node.app.inject({url:path,headers});assert.equal(response.statusCode,200,response.body);return response.json();}} as Api;
 await act(async()=>root.render(React.createElement(LibraryMaterials,{api:oldApi,revision:0,onSelect:ref=>opened.push(ref)})));
 await act(async()=>root.render(React.createElement(LibraryMaterials,{api:currentApi,revision:0,onSelect:ref=>opened.push(ref)})));
 assert.equal(signal?.aborted,true);assert.equal(d.querySelector('.library-record-preview')?.textContent,'Actual generated original note, without invented publication.');
 await act(async()=>d.querySelector<HTMLButtonElement>('.original-note-row')!.click());assert.deepEqual(opened,['capture:'+id]);
 await act(async()=>pending.resolve({...original.json(),items:[{...original.json().items[0],ref:'capture:'+other,capture:{...original.json().items[0].capture,textPreview:'STALE OWNER RESPONSE'}}]}));assert.doesNotMatch(d.body.textContent!,/STALE OWNER RESPONSE/);
 const reader=await currentApi.request<Capture>('/api/capture-browser/'+id);assert.equal(reader.ocrText,'Actual generated original note, without invented publication.');
 assert.equal(d.querySelector('.original-note-row')?.getAttribute('data-reference'),'capture:'+id);
});
