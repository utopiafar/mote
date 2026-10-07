import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {Archive} from '../src/Archive.js';
import {featuresReady,webFeatures} from '../src/features/runtime.js';
import {type Api,type Capture,type Activity} from '../src/api.js';
import {type Material} from '../src/Materials.js';

configureLocale(()=> 'zh-CN');
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const when='2026-09-01T10:00:00Z',activity:Activity={apps:[],devices:[],totalDurationMs:0,captures:0};
const row=(value=id)=>({id:value,deviceId:'fixture-device',deviceName:'Generated device',platform:'macos',capturedAt:when,source:'note',appName:'Generated note',windowTitle:'Generated '+value[0],durationMs:0,hasImage:false,ocr:{status:'not_applicable'},textPreview:'Generated original text'});
const capture=(value=id):Capture=>({...row(value),source:'note',ocrText:'<script>Generated untrusted evidence</script>',blobHash:null,indexingStatus:'text_ready',privacy:{redacted:false,mode:'none'},provenance:{sourceId:'fixture-source',externalId:'fixture-original',revision:'fixture-version',layer:'snapshot',document:{recordedAt:when,path:'generated/note.txt',contentRole:'authored'}}} as Capture);
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
function apiWith(read:(path:string,init?:RequestInit)=>unknown):Api{return {request:async(path:string,init?:RequestInit)=>{
  if(path==='/api/library/descriptor')return {schemaVersion:1,revision:1,types:[]};
  if(path==='/api/features')return {schemaVersion:1,revision:1,features:[],capabilities:['/api/capture-browser','/api/library/catalog','/api/coding/uploads'].map(path=>({id:'http:GET:'+path,version:'1',state:'active'}))};
  const result=await read(path,init);return path.startsWith('/api/library/catalog?')?{schemaVersion:1,types:[],sources:[],...result as object}:result;
},setAgentTimeout:()=>{}} as Api;}
function view(api:Api,extras:Partial<React.ComponentProps<typeof Archive>>={}){return React.createElement(Archive,{api,devices:[{deviceId:'fixture-device',deviceName:'Generated device',platform:'macos',status:'capturing',queueDepth:0,lastSeenAt:when}],range:{},activity,revision:0,onOpen:()=>{},tab:'records',setTab:()=>{},...extras});}
const button=(d:Document,text:string)=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(item=>item.textContent===text)!;

test('explicit library navigation leads directly into rows and source details without nested record-view tabs',async t=>{
  const {root,d}=await fixture(t),reads:string[]=[],opened:string[]=[];
  const api=apiWith(path=>{reads.push(path);if(path.startsWith('/api/capture-browser?'))return {items:[row()],nextCursor:null,totalCount:1};if(path.startsWith('/api/capture-browser/'))return capture();throw Error('Unexpected generated request '+path);});
  await act(async()=>root.render(view(api,{onOpen:ref=>opened.push(ref)})));
  assert.deepEqual(Array.from(d.querySelectorAll('.library-navigation button'),button=>button.getAttribute('data-collection-id')),webFeatures.collections().map(entry=>entry.id));
  assert.equal(d.querySelector('[data-collection-id="segments"]')?.textContent,'片段');assert.equal(d.querySelector('select[aria-label="资料类型"]'),null);assert.equal(d.querySelector('[aria-label="记录视图"]'),null);
  assert.equal(d.querySelector('.library-detail h3')?.textContent,'选择一条资料');
  const record=d.querySelector<HTMLButtonElement>('.library-record')!;record.focus();
  await act(async()=>record.click());
  assert.equal(d.querySelector('.library-browser')?.classList.contains('has-selection'),true);
  assert.match(d.querySelector('.library-detail')!.textContent!,/Generated a/);
  assert.match(d.querySelector('.library-detail')!.textContent!,/Generated device/);
  assert.match(d.querySelector('.library-detail')!.textContent!,/generated\/note.txt/);
  assert.match(d.querySelector('.library-detail')!.textContent!,/Generated untrusted evidence/);
  assert.equal(d.querySelector('.library-detail script'),null);
  assert.ok(reads.includes('/api/capture-browser/'+id));
  await act(async()=>button(d,'打开完整详情').click());assert.deepEqual(opened,['capture:'+id]);
  await act(async()=>button(d,'返回资料列表').click());
  assert.equal(d.querySelector('.library-browser')?.classList.contains('has-selection'),false);
  assert.equal(d.activeElement,record,'return preserves the original list and keyboard opener');
});

test('record pagination and explicit device filters keep their request scope while returning from detail',async t=>{
  const {root,d,w}=await fixture(t),paths:string[]=[];
  const api=apiWith(path=>{paths.push(path);if(path.startsWith('/api/capture-browser?')){const params=new URL('http://localhost'+path).searchParams;return {items:[row(params.get('cursor')?'b'.repeat(8)+'-bbbb-4bbb-8bbb-'+ 'b'.repeat(12):id)],nextCursor:params.has('cursor')?null:'generated-next',totalCount:2};}if(path.startsWith('/api/capture-browser/'))return capture(other);throw Error(path);});
  await act(async()=>root.render(view(api)));
  const filter=d.querySelector<HTMLSelectElement>('select[aria-label="筛选设备"]')!;
  await act(async()=>{filter.value='fixture-device';filter.dispatchEvent(new w.Event('change',{bubbles:true}));});
  await act(async()=>button(d,'下一页').click());
  const latest=new URL('http://localhost'+paths.filter(path=>path.startsWith('/api/capture-browser?')).at(-1)!);
  assert.equal(latest.searchParams.get('deviceId'),'fixture-device');assert.equal(latest.searchParams.get('cursor'),'generated-next');
  await act(async()=>d.querySelector<HTMLButtonElement>('.library-record')!.click());
  await act(async()=>button(d,'返回资料列表').click());
  assert.equal(filter.value,'fixture-device');assert.match(d.querySelector('.library-pagination')!.textContent!,/第 2 页/);
  assert.match(d.querySelector('.library-record')!.textContent!,/Generated b/);
});

test('switching collections or authenticated nodes cannot retain an old selected object or a late page',async t=>{
  const {root,d}=await fixture(t),oldPage=deferred();let signal:AbortSignal|undefined;
  const oldApi=apiWith((path,init)=>{signal=init?.signal as AbortSignal;return oldPage.promise;});
  const newApi=apiWith(path=>path.startsWith('/api/library/catalog?')?{items:[],nextCursor:null}:path.startsWith('/api/capture-browser?')?{items:[row(other)],nextCursor:null,totalCount:1}:capture(other));
  await act(async()=>root.render(view(oldApi)));
  await act(async()=>root.render(view(newApi)));
  assert.equal(signal?.aborted,true);
  await act(async()=>d.querySelector<HTMLButtonElement>('.library-record')!.click());
  await act(async()=>oldPage.resolve({items:[row(id)],nextCursor:null,totalCount:1}));
  assert.match(d.querySelector('.library-master')!.textContent!,/Generated b/);assert.doesNotMatch(d.querySelector('.library-master')!.textContent!,/Generated a/);
  assert.match(d.querySelector('.library-detail')!.textContent!,/Generated b/);
  await act(async()=>root.render(view(newApi,{tab:'materials'})));
  assert.equal(d.querySelector('.library-browser')?.classList.contains('has-selection'),false);
  await act(async()=>root.render(view(newApi)));
  assert.equal(d.querySelector('.library-browser')?.classList.contains('has-selection'),false,'returning to an earlier collection does not resurrect its old choice');
  await act(async()=>d.querySelector<HTMLButtonElement>('.library-record')!.click());
  const emptyApi=apiWith(()=>({items:[],nextCursor:null,totalCount:0}));
  await act(async()=>root.render(view(emptyApi)));
  assert.equal(d.querySelector('.library-browser')?.classList.contains('has-selection'),false);
  assert.doesNotMatch(d.querySelector('.library-detail')!.textContent!,/Generated b/);
});

test('formal material selection reads its pinned version through full ReferenceDetail and expands remaining text',async t=>{
  const {root,d}=await fixture(t),materialId='mat_'+'c'.repeat(64),revision='d'.repeat(64),ref='material:'+materialId+'@'+revision,paths:string[]=[];
  const material:Material={id:materialId,ref,revision,kind:'mote.note',schemaVersion:1,title:'Generated formal material',sequence:2,textLength:4500,blockCount:1,coverage:{state:'complete'},origin:{sourceId:'generated-source'},retention:{original:'kept'}};
  const api=apiWith(path=>{paths.push(path);if(path.startsWith('/api/library/catalog?'))return {items:[material],nextCursor:path.includes('cursor=')?null:'generated-next'};if(path.endsWith('/revisions/'+revision)||path==='/api/materials/'+materialId)return material;if(path.includes('/members?'))return {items:[],nextOffset:null};if(path.includes('/read?')){const offset=new URL('http://localhost'+path).searchParams.get('offset');return {material,text:offset==='4000'?'Generated remainder':'Generated first portion',textRange:{offset:offset==='4000'?4000:0,total:4500,nextOffset:offset==='4000'?null:4000}};}throw Error('Unexpected generated request '+path);});
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
  assert.ok(paths.some(path=>path.includes('/api/library/catalog?limit=24&cursor=generated-next')));
  assert.equal(d.querySelector('.library-browser')?.classList.contains('has-selection'),false,'the next list page clears its previous pinned object');
  const nextPaths:string[]=[],nextApi=apiWith(path=>{nextPaths.push(path);return {items:[],nextCursor:null};});
  await act(async()=>root.render(view(nextApi,{tab:'materials'})));
  assert.ok(nextPaths.includes('/api/library/catalog?limit=24'),'a new authenticated node starts at its own first page');
  assert.equal(nextPaths.some(path=>path.includes('generated-next')),false);
});

test('a deployed type adds card, detail, panel and action without changing the library; disposal keeps generic history readable',async t=>{
  const {root,d}=await fixture(t),materialId='mat_'+'e'.repeat(64),revision='f'.repeat(64),ref='material:'+materialId+'@'+revision;
  const material:Material={id:materialId,ref,revision,kind:'fixture.journal',schemaVersion:1,title:'Generated custom journal',sequence:1,textLength:22,blockCount:1,coverage:{state:'complete'},origin:{sourceId:'journal'},retention:{original:'kept'}};
  const type={id:'fixture.journal',kind:material.kind,schemaVersion:1,label:'Generated journal',card:'fixture.journal-card',detail:'fixture.journal-detail',panels:['fixture.journal-panel'],actions:['fixture.journal-action']};
  const api={request:async(path:string)=>{
    if(path==='/api/features')return {schemaVersion:1,revision:1,features:[],capabilities:[{id:'http:GET:/api/library/catalog',version:'1',state:'active'}]};
    if(path==='/api/library/descriptor')return {schemaVersion:1,revision:1,types:[type]};
    if(path.startsWith('/api/library/catalog?'))return {schemaVersion:1,types:[type],sources:[{id:'journal',label:'Generated journal source',count:1}],items:[material],nextCursor:null};
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
