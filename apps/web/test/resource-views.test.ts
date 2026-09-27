import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {Memories} from '../src/Memories.js';
import {Files,FileDetail} from '../src/Files.js';
import {Sources} from '../src/Sources.js';
import {ReferenceDetail} from '../src/ReferenceDetail.js';
import {MaterialDetail,type Material} from '../src/Materials.js';
import {SourceMaterialView} from '../src/features/source-material.js';
import {resources} from '../src/resource-cache.js';
import {ApiError,dateTime,type Api} from '../src/api.js';
const ids=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
function deferred(){let resolve!:(value:any)=>void,reject!:(value:unknown)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function fixture(t:any){const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),backups=new Map<string,PropertyDescriptor|undefined>();for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){backups.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}dom.window.localStorage.setItem('mote.language','zh-CN');const root=createRoot(dom.window.document.getElementById('root')!);t.after(async()=>{await act(async()=>root.unmount());for(const [key,descriptor] of backups){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});return {root,document:dom.window.document};}
function apiWith(read:(path:string,init?:RequestInit)=>unknown):Api{return {request:async(path:string,init?:RequestInit)=>{if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};if(path==='/api/model-settings')return {settings:{agentTimeoutMs:120000},profiles:[]};if(path==='/api/memory-jobs')return {items:[]};if(path==='/api/execution-settings')return {queues:{agents:{active:0,waiting:0,limit:1},llm:{active:0,waiting:0,limit:1}}};if(path==='/api/file-processing')return null;if(path==='/api/connectors/status')return {};return await read(path,init);},setAgentTimeout:()=>{}} as Api;}
const memory=(id:string)=>({id,title:'Generated '+id[0],statement:'Current evidence '+id[0],status:'published',createdAt:'2020-01-01T00:00:00Z',evidenceIds:[]});
test('material corrections hide cached prose while pending and explicitly link historical revisions to the current one',async t=>{
 const {root,document:d}=await fixture(t);let state='ready';const opened:string[]=[];
 const material:Material={id:ids[0],ref:'material:generated@v1',revision:'v1',kind:'generated',schemaVersion:1,title:'Generated material',sequence:1,textLength:20,blockCount:1,coverage:{state:'full'},origin:{sourceId:'generated'},retention:{original:'retained'}};
 const next={...material,ref:'material:generated@v2',revision:'v2',sequence:2};
 const api=apiWith(path=>{
   if(path.includes('/read?')){assert.match(path,/revision=v1/);if(state==='pending')throw new ApiError('Generated rebuild',409);return {material,text:'旧的生成正文',textRange:{offset:0,total:7,nextOffset:null}};}
   if(state==='revoked')throw new ApiError('Generated revoked',403);
   return state==='rebuilt'?next:state==='pending'?{...material,coverage:{state:'pending',reason:'source_evidence_changed'}}:material;
 });
 await act(async()=>root.render(React.createElement(MaterialDetail,{api,material,onOpen:ref=>opened.push(ref)})));
 assert.match(d.body.textContent!,/旧的生成正文/);
 state='pending';await act(async()=>resources(api).invalidate(()=>true));
 assert.doesNotMatch(d.body.textContent!,/旧的生成正文/);assert.match(d.querySelector('[role=status]')!.textContent!,/正在重新整理/);
 state='rebuilt';await act(async()=>resources(api).invalidate(()=>true));
 assert.match(d.body.textContent!,/旧的生成正文/);assert.match(d.body.textContent!,/历史版本/);
 await act(async()=>Array.from(d.querySelectorAll('button')).find(b=>b.textContent==='查看当前版本')!.click());assert.deepEqual(opened,[next.ref]);
 state='revoked';await act(async()=>resources(api).invalidate(()=>true));assert.doesNotMatch(d.body.textContent!,/旧的生成正文|查看当前版本/);assert.match(d.body.textContent!,/Generated revoked/);
});
test('current multi-block Material offers one bounded extraction route; stale and agent views do not',async t=>{
 const {root,document:d}=await fixture(t),id='mat_'+'a'.repeat(64),revision='b'.repeat(64),ref=`material:${id}@${revision}`;
 const material:Material={id,ref,revision,kind:'mote.file',schemaVersion:1,title:'Generated two-block material',sequence:1,textLength:30,blockCount:2,coverage:{state:'complete'},origin:{sourceId:'generated'},retention:{original:'retained'}};
 const anchors=[ids[0],ids[1]];let current={...material,memorySource:{status:'ready' as const,evidenceIds:anchors}};
 const api=apiWith(path=>path.includes('/read?')?{material,text:'Generated formal body',textRange:{offset:0,total:21,nextOffset:null}}:current);
 await act(async()=>root.render(React.createElement(MaterialDetail,{api,material,onOpen:()=>{}})));
 const link=d.querySelector<HTMLAnchorElement>('.material-detail a[href*="memoryMaterial="]');assert.ok(link);
 assert.match(link.href,/memoryMaterial=material%3Amat_[a-f0-9]{64}%40[b]{64}/);
 current={...current,coverage:{state:'pending'},memorySource:{status:'waiting',evidenceIds:[]}} as typeof current;
 await act(async()=>resources(api).invalidate(key=>key===`/api/materials/${id}`));
 assert.equal(d.querySelector('.material-detail a[href*="memoryMaterial="]'),null);
 assert.match(d.querySelector('.material-detail')!.textContent!,/暂不能单独提取记忆/);
 const old={...material,ref:`material:${id}@${'c'.repeat(64)}`,revision:'c'.repeat(64)};
 await act(async()=>root.render(React.createElement(MaterialDetail,{api,material:old,onOpen:()=>{}})));
 assert.equal(d.querySelector('.material-detail a[href*="memoryMaterial="]'),null,'historical pinned version cannot borrow the current link');
});
test('agent material views cannot fall back to owner routes when a corrected reference becomes unavailable',async t=>{
 const {root,document:d}=await fixture(t);let unavailable=false;const paths:string[]=[];
 const material:Material={id:ids[0],ref:'material:generated@v1',revision:'v1',kind:'mote.file',schemaVersion:1,title:'Generated agent material',sequence:1,textLength:6,blockCount:1,coverage:{state:'full'},origin:{sourceId:'generated'},retention:{original:'retained'}};
 const api=apiWith(path=>{paths.push(path);assert.ok(path.startsWith('/api/agent-view/'));if(unavailable)throw new ApiError('Generated unavailable',404);return {material,text:'生成的原文',textRange:{offset:0,total:6,nextOffset:null}};});
 await act(async()=>root.render(React.createElement(MaterialDetail,{api,material,agent:true,onOpen:()=>{}})));assert.match(d.body.textContent!,/生成的原文/);
 unavailable=true;await act(async()=>resources(api).invalidate(()=>true));assert.doesNotMatch(d.body.textContent!,/生成的原文/);assert.match(d.body.textContent!,/Generated unavailable/);assert.ok(paths.length>=2);
});
test('source presentation pages decoded text, preserves raw fallback, escapes content and hides pending cached bodies',async t=>{
 const {root,document:d}=await fixture(t),paths:string[]=[];let pending=false;
 const value={kind:'mote.file',schemaVersion:1,representation:'owner-material',ref:'material:mat_'+'a'.repeat(64)+'@'+'b'.repeat(64),revision:'b'.repeat(64),title:'Generated recording',text:'Raw original'};
 const api=apiWith(path=>{paths.push(path);if(pending)throw new ApiError('Generated pending',409);const next=path.includes('offset=4000');return {items:[{blockId:'generated',type:'text',text:next?'Generated continuation':'<img src=x onerror=bad()>\nGenerated first page',speaker:'SPEAKER_0',confirmedName:'Generated owner',offset:next?4000:0,total:8000,continued:!next,startMs:3000}],next:next?null:{block:1,offset:4000}};});
 await act(async()=>root.render(React.createElement(SourceMaterialView,{api,value,onOpen:()=>{},fallback:React.createElement('pre',null,'Raw original')})));
 assert.match(d.body.textContent!,/已确认说话人：Generated owner/);assert.match(d.body.textContent!,/Generated first page/);assert.equal(d.querySelector('img'),null);
 const click=async(label:string)=>act(async()=>Array.from(d.querySelectorAll('button')).find(b=>b.textContent===label)!.click());
 await click('继续展开');assert.match(d.body.textContent!,/接上一页/);assert.match(d.body.textContent!,/Generated continuation/);assert.doesNotMatch(d.body.textContent!,/Generated first page/);assert.ok(paths.some(path=>path.includes('block=1&offset=4000')));
 await click('上一页');assert.match(d.body.textContent!,/Generated first page/);
 await click('查看原始结构');assert.match(d.body.textContent!,/Raw original/);assert.doesNotMatch(d.body.textContent!,/Generated first page/);
 await click('返回阅读视图');pending=true;await act(async()=>resources(api).invalidate(()=>true));assert.match(d.body.textContent!,/正在重新整理/);assert.doesNotMatch(d.body.textContent!,/Generated first page/);
});
test('the source plugin renders imported messages and distinguishes recorded, occurred and collected times',async t=>{
 const {featuresReady}=await import('../src/features/runtime.js');await featuresReady;
 const {root,document:d}=await fixture(t),opened:string[]=[];
 const material:Material={id:'mat_'+'c'.repeat(64),ref:'material:mat_'+'c'.repeat(64)+'@'+'d'.repeat(64),revision:'d'.repeat(64),kind:'mote.message',schemaVersion:1,title:'Generated diary',sequence:1,textLength:40,blockCount:1,coverage:{state:'complete'},origin:{sourceId:'generated'},retention:{original:'retained'}};
 const item={blockId:'source-record',type:'source',sourceType:'message',sourceRef:'capture:'+ids[0],text:'Readable generated diary',appName:'Generated archive',recordedAt:'2026-05-07T00:15:00+08:00',occurredAt:'2026-05-01T12:00:00+08:00',capturedAt:'2026-09-27T02:00:00+08:00',offset:0,total:24,continued:false};
 const api=apiWith(path=>path.includes('/source-view?')?{items:[item],next:null}:path.includes('/read?')?{material,text:'Raw storage fields',textRange:{offset:0,total:18,nextOffset:null}}:material);
 await act(async()=>root.render(React.createElement(MaterialDetail,{api,material,onOpen:ref=>opened.push(ref)})));
 assert.match(d.body.textContent!,/Readable generated diary/);assert.doesNotMatch(d.body.textContent!,/Raw storage fields/);
 for(const label of ['记录时间：'+dateTime(item.recordedAt),'发生时间：'+dateTime(item.occurredAt),'采集于 '+dateTime(item.capturedAt)])assert.ok(d.body.textContent!.includes(label),label);
 await act(async()=>Array.from(d.querySelectorAll('button')).find(button=>button.textContent==='查看原始记录')!.click());assert.deepEqual(opened,[item.sourceRef]);
});
test('formal material links open their pinned revision through the material API',async t=>{
 const {root,document:d}=await fixture(t),id='mat_'+'a'.repeat(64),revision='b'.repeat(64),ref=`material:${id}@${revision}`,paths:string[]=[];
 const material:Material={id,revision,ref,kind:'generated',schemaVersion:1,title:'Pinned generated material',sequence:1,textLength:4,blockCount:1,coverage:{state:'full'},origin:{sourceId:'generated'},retention:{original:'retained'}};
 const api=apiWith(path=>{paths.push(path);assert.ok(path.startsWith('/api/materials/'));return path.includes('/read?')?{material,text:'固定正文',textRange:{offset:0,total:4,nextOffset:null}}:material;});
 await act(async()=>root.render(React.createElement(ReferenceDetail,{api,reference:ref,onOpen:()=>{}})));
 assert.match(d.querySelector('.reference-detail')!.textContent!,/固定正文/);assert.ok(paths.includes(`/api/materials/${id}/revisions/${revision}`));assert.ok(paths.some(path=>path.includes('revision='+revision)));
});
test('Memory selection and scope changes fence uncooperative late detail replies and errors do not look empty',async t=>{
 const {root,document:d}=await fixture(t),a=deferred(),b=deferred();let failure=false;const api=apiWith(path=>{if(path.startsWith('/api/memories?')){if(failure)throw new ApiError('generated offline',503);return {items:ids.map(memory),nextCursor:null};}return path.split('?')[0].endsWith(ids[0])?a.promise:b.promise;});
 await act(async()=>root.render(React.createElement(Memories,{api,range:{},onOpen:()=>{}})));const buttons=d.querySelectorAll<HTMLButtonElement>('.workspace-select');
 await act(async()=>buttons[0].click());await act(async()=>buttons[1].click());await act(async()=>b.resolve(memory(ids[1])));await act(async()=>a.resolve(memory(ids[0])));
 assert.equal(d.querySelector('.memory-detail h2')?.textContent,'Generated b');assert.doesNotMatch(d.querySelector('.workspace-content')!.textContent!,/Current evidence a/);
 failure=true;await act(async()=>root.render(React.createElement(Memories,{api,range:{after:'2025-01-01T00:00:00Z'},onOpen:()=>{}})));assert.match(d.body.textContent!,/generated offline/);assert.doesNotMatch(d.body.textContent!,/当前筛选下没有匹配的记忆/);assert.equal(d.querySelector('.memory-detail'),null);
});
test('Files session changes and failed reads cannot publish an old list or a false empty state',async t=>{
 const {root,document:d}=await fixture(t),old=deferred(),fresh=deferred();const reader=(pending:ReturnType<typeof deferred>)=>apiWith(path=>path==='/api/sources'?{items:[]}:pending.promise);
 await act(async()=>root.render(React.createElement(Files,{api:reader(old),onOpen:()=>{}})));assert.doesNotMatch(d.body.textContent!,/尚无匹配文件/);
 await act(async()=>root.render(React.createElement(Files,{api:reader(fresh),onOpen:()=>{}})));await act(async()=>fresh.reject(new ApiError('generated unavailable',503)));await act(async()=>old.resolve({items:[{captureId:ids[0],sizeBytes:1,item:{title:'OLD LIST',observedAt:'2020-01-01T00:00:00Z'}}],nextCursor:null}));
 assert.match(d.body.textContent!,/generated unavailable/);assert.doesNotMatch(d.body.textContent!,/OLD LIST|尚无匹配文件/);
});
test('Source history selections do not display a previously requested version list',async t=>{
 const {root,document:d}=await fixture(t),a=deferred(),b=deferred();const api=apiWith(path=>path==='/api/sources'?{items:[]}:path.startsWith('/api/source-items?')?{items:ids.map((captureId,i)=>({captureId,sourceId:'generated',externalId:String(i),title:'Source '+i,layer:'original',observedAt:'2020-01-01T00:00:00Z',text:''})),nextCursor:null}:path.endsWith('externalId=0')?a.promise:b.promise);
 await act(async()=>root.render(React.createElement(Sources,{api,mode:'library',onOpen:()=>{},onImport:()=>{}})));const history=Array.from(d.querySelectorAll<HTMLButtonElement>('button')).filter(x=>x.textContent==='查看版本');await act(async()=>history[0].click());await act(async()=>history[1].click());
 await act(async()=>b.resolve({items:[{captureId:ids[1],observedAt:'2024-02-02T00:00:00Z',current:true}]}));await act(async()=>a.resolve({items:[{captureId:ids[0],observedAt:'2020-01-01T00:00:00Z',deleted:true}]}));assert.match(d.querySelector('.source-history')!.textContent!,/当前版本/);assert.doesNotMatch(d.querySelector('.source-history')!.textContent!,/来源报告已移除/);
});
test('File details show read failure and never silently disappear',async t=>{const {root,document:d}=await fixture(t);const api=apiWith(()=>{throw new ApiError('generated forbidden',403);});await act(async()=>root.render(React.createElement(FileDetail,{api,id:ids[0],onOpen:()=>{}})));assert.match(d.querySelector('[role=alert]')!.textContent!,/generated forbidden/);assert.match(d.body.textContent!,/重新读取/);});
test('pinned derived refs retain the same identity through text continuation and deletion',async t=>{
 const {root,document:d}=await fixture(t),ref='artifact:generated:revision-1',bodies:any[]=[];let deleted=false;const api=apiWith((_path,init)=>{const body=JSON.parse(String(init?.body));bodies.push(body);return deleted?{items:[],missingRefs:[ref]}:{items:[{ref,id:'generated',kind:'artifact',text:body.offset?'tail':'head',textRange:{offset:body.offset,total:8,nextOffset:body.offset?null:4},evidenceRefs:[ids[0]]}],missingRefs:[]};});
 await act(async()=>root.render(React.createElement(ReferenceDetail,{api,reference:ref,onOpen:()=>{}})));await act(async()=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent==='继续展开')!.click());assert.match(d.body.textContent!,/headtail/);assert.deepEqual(bodies.map(b=>b.refs),[[ref],[ref]]);
 deleted=true;await act(async()=>root.render(React.createElement(ReferenceDetail,{key:'reload',api,reference:ref,onOpen:()=>{}})));assert.match(d.body.textContent!,/资料不存在或已删除/);assert.doesNotMatch(d.body.textContent!,/headtail/);
});

test('budget editor preserves a stale draft on conflict and reloads before saving its new revision',async t=>{
 const {ModelBudgets}=await import('../src/ModelBudgets.js');const {root,document:d}=await fixture(t);let revision=7,conflict=true;const writes:any[]=[];
 const value=()=>({revision,limits:{dailyTokens:null,dailyCost:null,operationTokens:null,operationCost:null,providerDailyTokens:{},providerDailyCost:{},currency:'USD'},day:'2026-09-22',timeZone:'UTC',usage:[{provider:'generated',currency:'USD',tokens:100,cost:null,active:1,unknown:1,runs:2}]});
 const api=apiWith((_path,init)=>{if(init?.method==='PUT'){writes.push(JSON.parse(String(init.body)));if(conflict){revision=8;throw new ApiError('stale',409);}return {...value(),revision:++revision,limits:writes.at(-1).limits};}return value();});
 await act(async()=>root.render(React.createElement(ModelBudgets,{api})));assert.match(d.body.textContent!,/未知用量保留预留额度/);assert.match(d.body.textContent!,/Codex 内置循环/);assert.match(d.body.textContent!,/未估算/);
 const change=async()=>{const select=d.querySelector<HTMLSelectElement>('select')!;await act(async()=>{select.value='CNY';select.dispatchEvent(new window.Event('change',{bubbles:true}));});};
 const submit=async()=>{await act(async()=>d.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));};
 await change();await submit();assert.equal(writes[0].revision,7);assert.equal(d.querySelector('select')!.value,'CNY');assert.match(d.querySelector('[role=alert]')!.textContent!,/当前修改已保留/);
 await act(async()=>Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent==='放弃修改并重新加载')!.click());assert.equal(d.querySelector('select')!.value,'USD');conflict=false;await change();await submit();assert.equal(writes[1].revision,8);assert.equal(writes[1].limits.currency,'CNY');assert.deepEqual(Object.keys(writes[1]).sort(),['limits','revision']);assert.match(d.body.textContent!,/已保存，立即生效/);
});

test('model selectors share configuration reads and fence late provider catalogs',async t=>{
 const {ModelSelector}=await import('../src/ModelSelector.js');const {root,document:d}=await fixture(t),old=deferred(),fresh=deferred();let settingsReads=0;
 const api={request:async(path:string)=>{if(path==='/api/model-settings'){settingsReads++;return {settings:{agentTimeoutMs:120000},profiles:[{id:'a',name:'A',settings:{agentTimeoutMs:120000,model:'model-a'}},{id:'b',name:'B',settings:{agentTimeoutMs:120000,model:'model-b'}}],defaults:{query:'a'}};}return path.includes('/a/')?old.promise:fresh.promise;},setAgentTimeout:()=>{}} as Api;
 const render=(value:string)=>React.createElement(React.Fragment,null,...[0,1].map(key=>React.createElement(ModelSelector,{key,api,feature:'query',value,onChange:()=>{},onModelChange:()=>{}})));
 await act(async()=>root.render(render('a')));assert.equal(settingsReads,1);assert.equal(new Set(Array.from(d.querySelectorAll('datalist')).map(x=>x.id)).size,2);
 await act(async()=>root.render(render('b')));await act(async()=>fresh.resolve({items:[{id:'fresh',name:'Fresh generated model'}]}));await act(async()=>old.resolve({items:[{id:'stale',name:'STALE generated model'}]}));
 assert.match(d.body.textContent!,/Fresh generated model/);assert.doesNotMatch(d.body.textContent!,/STALE generated model/);
});
test('file processing settings preserve edited drafts on refresh, show source errors and clear revoked data',async t=>{
 const {FileProcessingSettings}=await import('../src/FileProcessingSettings.js'),{resources}=await import('../src/resource-cache.js');const {root,document:d}=await fixture(t);let forbidden=false,revision=1;
 const api={request:async(path:string)=>{if(path==='/api/sources')throw new ApiError('generated source unavailable',503);if(forbidden)throw new ApiError('generated permission revoked',403);return {revision,settings:{enabled:true,maxAudioMinutes:60,timeoutMs:1000},policy:{profiles:[],rules:[],services:[]},processors:[]};},setAgentTimeout:()=>{}} as Api;
 await act(async()=>root.render(React.createElement(FileProcessingSettings,{api})));assert.match(d.body.textContent!,/generated source unavailable/);
 const checkbox=d.querySelector<HTMLInputElement>('input[type=checkbox]')!;await act(async()=>checkbox.click());assert.equal(checkbox.checked,false);
 revision++;await act(async()=>resources(api).invalidate(key=>key==='/api/file-processing'));assert.equal(d.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,false);assert.match(d.body.textContent!,/有未保存修改/);
 forbidden=true;await act(async()=>resources(api).invalidate(key=>key==='/api/file-processing'));assert.match(d.body.textContent!,/generated permission revoked/);assert.equal(d.querySelector('form'),null);
});
test('processing controls use plugin capabilities independently of built-in names',async t=>{
 const {FileProcessingSettings}=await import('../src/FileProcessingSettings.js'),{root,document:d}=await fixture(t);
 const processors=[
  {id:'extension.private',name:'Private alias',stage:'extract',mediaTypes:['audio/'],serviceKind:'asr',localOnly:true,contentPolicy:'local-only',dialogue:true,allowSummary:false},
  {id:'extension.analysis',name:'Analysis alias',stage:'extract',mediaTypes:['audio/'],serviceKind:'asr',localOnly:true,dialogue:true,allowSummary:true},
  {id:'extension.text',name:'Text alias',stage:'extract',mediaTypes:['text/'],localOnly:true},
  {id:'extension.local-speaker',name:'Local speaker',stage:'diarize',mediaTypes:['audio/'],localOnly:true},
  {id:'extension.remote-speaker',name:'Remote speaker',stage:'diarize',mediaTypes:['audio/']},
 ];
 const view={revision:'generated',settings:{enabled:true,maxAudioMinutes:60,timeoutMs:1000},processors,policy:{rules:[],
  profiles:processors.slice(0,3).map(processor=>({id:processor.id,name:processor.name,processorId:processor.id,parameters:{},diarizationProcessor:'extension.local-speaker',summarize:false})),
  services:[{id:'asr-local',kind:'asr',execution:'local',name:'Local ASR',endpoint:'http://localhost/transcribe'},{id:'asr-remote',kind:'asr',execution:'remote',name:'Remote ASR',endpoint:'https://example.test/transcribe'},
   {id:'model-local',kind:'model',execution:'local',name:'Local model',endpoint:'http://localhost/v1',model:'generated'},{id:'model-remote',kind:'model',execution:'remote',name:'Remote model',endpoint:'https://example.test/v1',model:'generated'}]}};
 const api={request:async(path:string)=>path==='/api/sources'?{items:[]}:path==='/api/media-models'?{dialogue:{state:'ready',runtimeReady:true}}:view,setAgentTimeout:()=>{}} as Api;
 await act(async()=>root.render(React.createElement(FileProcessingSettings,{api})));
 const card=(name:string)=>Array.from(d.querySelectorAll('details.policy-card')).find(element=>element.querySelector('summary')?.textContent?.startsWith(name))!;
 const options=(element:Element,label:string)=>Array.from(element.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!.options).map(option=>option.value);
 const privateCard=card('Private alias'),analysisCard=card('Analysis alias'),textCard=card('Text alias');
 assert.deepEqual(options(privateCard,'说话人分离插件'),['extension.local-speaker']);
 assert.deepEqual(options(privateCard,'处理服务'),['','asr-local']);assert.deepEqual(options(privateCard,'分析语言模型'),['','model-local']);
 assert.equal(privateCard.querySelector('input[type=checkbox]'),null);
 assert.deepEqual(options(analysisCard,'处理服务'),['','asr-local']);assert.deepEqual(options(analysisCard,'分析语言模型'),['','model-local','model-remote']);assert.ok(analysisCard.querySelector('input[type=checkbox]'));
 assert.equal(textCard.querySelector('select[aria-label="说话人分离插件"]'),null);assert.ok(textCard.querySelector('input[type=checkbox]'));
});
test('successful evidence read displays archival presence independently of unknown processing',async t=>{
 const {EvidenceState}=await import('../src/EvidenceState.js');const {root,document:d}=await fixture(t);await act(async()=>root.render(React.createElement(EvidenceState)));
 assert.equal(d.querySelector('[data-archive-state]')?.getAttribute('data-archive-state'),'acknowledged');assert.equal(d.querySelector('[data-processing-state]')?.getAttribute('data-processing-state'),'unknown');assert.doesNotMatch(d.body.textContent!,/记忆已完成/);
});

test('budget settings explain reservations and remove editable drafts after revocation or session change',async t=>{
 const {ModelBudgets}=await import('../src/ModelBudgets.js'),{resources}=await import('../src/resource-cache.js'),{root,document:d}=await fixture(t);let revoked=false;
 const value=(currency='USD')=>({minimumInputReservationTokens:128000,revision:1,limits:{dailyTokens:300000,dailyCost:null,operationTokens:null,operationCost:null,providerDailyTokens:{},providerDailyCost:{},currency},day:'2026-09-23',timeZone:'UTC',usage:[]});
 const api=apiWith(()=>{if(revoked)throw new ApiError('Generated budget revoked',403);return value();});
 await act(async()=>root.render(React.createElement(ModelBudgets,{api})));assert.match(d.body.textContent!,/128,000 个输入 token/);
 await act(async()=>{const input=d.querySelector('select')!;input.value='CNY';input.dispatchEvent(new window.Event('change',{bubbles:true}));});
 revoked=true;await act(async()=>resources(api).invalidate(key=>key==='/api/model-budgets'));assert.equal(d.querySelector('form'),null);assert.match(d.body.textContent!,/Generated budget revoked/);
 const next=apiWith(()=>value());await act(async()=>root.render(React.createElement(ModelBudgets,{api:next})));assert.equal(d.querySelector('select')!.value,'USD');assert.doesNotMatch(d.body.textContent!,/Generated budget revoked/);
});


test('full record uses a visible heading and unnamed text content without losing whitespace or interpreting markup',async t=>{
 const {EvidenceDialog}=await import('../src/shell-components.js');const {root,document:d}=await fixture(t);
 const text=Array.from({length:6},(_,index)=>`生成段落 ${index+1}：  保留空格与原文 🌉 <b>plain evidence</b> & text.\n<img src=x onerror="window.__evidenceExecuted=true"><script>window.__evidenceExecuted=true</script>`).join('\n\n');
 const capture={id:ids[0],source:'note',platform:'macos',capturedAt:'2026-09-27T00:00:00Z',appName:'Generated note',deviceName:'Fixture Mac',ocrText:text,durationMs:0,indexingStatus:'indexed',privacy:{excluded:false,redacted:false}};
 const api=apiWith(path=>{assert.equal(path,`/api/capture-browser/${ids[0]}`);return capture;});
 await act(async()=>root.render(React.createElement(EvidenceDialog,{id:ids[0],api,onClose:()=>{},onDeleted:()=>{},onOpen:()=>{}})));
 const body=d.querySelector('.evidence-text pre')!;
 assert.match(d.querySelector<HTMLAnchorElement>('.evidence-text a')!.href,/library\/memories\?memorySource=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/);
 assert.equal(body.previousElementSibling?.tagName,'H4');assert.equal(body.previousElementSibling?.textContent,'记录全文');
 assert.equal(body.textContent,text);assert.equal(body.getAttribute('aria-label'),null);assert.equal(body.getAttribute('aria-labelledby'),null);
 assert.equal(body.querySelector('b, img, script'),null);assert.equal(body.closest('[aria-hidden=true], [inert]'),null);
 assert.equal((d.defaultView as unknown as {__evidenceExecuted?:boolean}).__evidenceExecuted,undefined);
});
test('registered source originals navigate through verified Material mapping and never offer raw Memory input',async t=>{
 const {EvidenceDialog}=await import('../src/shell-components.js');const {root,document:d}=await fixture(t),opened:string[]=[];
 const ref=`material:mat_${'a'.repeat(64)}@${'b'.repeat(64)}`;
 const capture={id:ids[0],source:'file',platform:'import',capturedAt:'2026-09-27T00:00:00Z',appName:'Generated upload',deviceName:'Fixture',ocrText:'Generated original',durationMs:0,indexingStatus:'indexed',privacy:{excluded:false,redacted:false},revisionState:'current',requiresMaterialForMemory:true,memoryMaterialRef:ref};
 let mapped=true;const api=apiWith(path=>{assert.equal(path,`/api/capture-browser/${ids[0]}`);return mapped?capture:{...capture,memoryMaterialRef:undefined};});
 await act(async()=>root.render(React.createElement(EvidenceDialog,{id:ids[0],api,onClose:()=>{},onDeleted:()=>{},onOpen:ref=>opened.push(ref)})));
 assert.equal(d.querySelector('.evidence-text a[href*="memorySource="]'),null);
 await act(async()=>Array.from(d.querySelectorAll('button')).find(button=>button.textContent==='查看正式资料并提取记忆')!.click());
 assert.deepEqual(opened,[ref]);
 mapped=false;await act(async()=>resources(api).invalidate(key=>key===`/api/capture-browser/${ids[0]}`));
 assert.equal(d.querySelector('.evidence-text a[href*="memorySource="]'),null);
 assert.match(d.querySelector<HTMLAnchorElement>('.evidence-text a[href="#/library/materials"]')!.textContent!,/查看正式资料/);
});

for(const legacy of [false,true])test(`failed speaker separation keeps raw transcript readable with ${legacy?'legacy':'applied'} summary-disabled policy`,async t=>{
 const {root,document:d}=await fixture(t),mutations:any[]=[];let dialogue=false;
 const value=()=>({captureId:ids[0],sourceId:'generated',sizeBytes:100,hasOriginal:false,originMissing:false,item:{title:'Generated recording',mimeType:'audio/wav',observedAt:'2026-09-27T00:00:00Z'},job:{state:dialogue?'succeeded':'failed',error:dialogue?'cancelled':'provider_failed',summary_state:dialogue?'cancelled':'waiting',local_only:1},processingPolicy:{applied:legacy?null:{revision:'generated',profile:{name:'Generated local',processorId:'generated',summarize:false},rule:{type:'audio/*'}},current:{profile:{name:'Generated local',summarize:false},rule:{type:'audio/*'}},legacyRevision:legacy?'generated-config-fingerprint':null},steps:[{step:'extract',state:'succeeded',attempts:1},{step:'diarize',state:dialogue?'succeeded':'failed',attempts:dialogue?5:4}],artifacts:[{id:'raw-generated',kind:'transcript'},...(dialogue?[{id:'dialogue-generated',kind:'dialogue'}]:[])]});
 const api=apiWith((path,init)=>{if(path.endsWith('/reviews'))return {items:[]};if(path.endsWith('/retry')){mutations.push(JSON.parse(String(init?.body)));return {};}if(path.includes('/chunks?'))return {items:[{id:'generated-chunk',ocrText:dialogue?'Generated dialogue':'Generated raw <b>words</b>',fileEvidence:{startMs:0}}],nextOffset:null};assert.equal(path,'/api/files/'+ids[0]);return value();});
 await act(async()=>root.render(React.createElement(FileDetail,{api,id:ids[0],onOpen:()=>{}})));
 const click=async(label:string)=>act(async()=>Array.from(d.querySelectorAll('button')).find(b=>b.textContent===label)!.click());
 assert.match(d.body.textContent!,/整体处理：处理失败/);assert.match(d.body.textContent!,/摘要：未启用/);assert.doesNotMatch(d.body.textContent!,/转写服务未完成/);
 assert.match(d.body.textContent!,/转写 \/ 提取：已完成/);assert.match(d.body.textContent!,/说话人分离：处理失败/);
 await click('展开原始转写（未校正）');assert.match(d.body.textContent!,/Generated raw <b>words<\/b>/);assert.equal(d.querySelector('.file-text b'),null);assert.match(d.body.textContent!,/原始转写 · 未校正/);
 await click('重新分离说话人（保留转写）');assert.deepEqual(mutations,[{stage:'diarize'}]);
 dialogue=true;await act(async()=>resources(api).invalidate(key=>key==='/api/files/'+ids[0]));
 assert.match(d.body.textContent!,/整体处理：已完成；摘要：未启用/);assert.doesNotMatch(d.body.textContent!,/处理未完成/);
 assert.doesNotMatch(d.body.textContent!,/Generated raw/);await click('展开转写 / 原文片段');assert.match(d.body.textContent!,/Generated dialogue/);
});


test('summary failure is attributed to summary after extraction succeeds',async t=>{
 const {root,document:d}=await fixture(t);
 const api=apiWith(()=>({captureId:ids[0],sourceId:'generated',sizeBytes:100,hasOriginal:false,originMissing:false,item:{title:'Generated recording',mimeType:'audio/wav',observedAt:'2026-09-27T00:00:00Z'},job:{state:'succeeded',error:'summary_failed',summary_state:'failed',local_only:0},artifacts:[]}));
 await act(async()=>root.render(React.createElement(FileDetail,{api,id:ids[0],onOpen:()=>{}})));
 assert.match(d.body.textContent!,/整体处理：已完成；摘要：处理失败（摘要生成失败，可单独重试）/);
});

test('late raw reply cannot repopulate dialogue view',async t=>{
 const {root,document:d}=await fixture(t),raw=deferred();let dialogue=false;
 const value=()=>({captureId:ids[0],sourceId:'generated',sizeBytes:100,hasOriginal:false,originMissing:false,item:{title:'Generated',mimeType:'audio/wav',observedAt:'2026-09-27T00:00:00Z'},job:{state:dialogue?'succeeded':'failed',error:dialogue?'cancelled':'provider_failed',summary_state:'cancelled',local_only:1},artifacts:[{id:'raw-generated',kind:'transcript'},...(dialogue?[{id:'dialogue-generated',kind:'dialogue'}]:[])]});
 const api=apiWith(path=>path.endsWith('/reviews')?{items:[]}:path.includes('/chunks?')?raw.promise:value());
 await act(async()=>root.render(React.createElement(FileDetail,{api,id:ids[0],onOpen:()=>{}})));
 await act(async()=>Array.from(d.querySelectorAll('button')).find(b=>b.textContent==='展开原始转写（未校正）')!.click());
 dialogue=true;await act(async()=>resources(api).invalidate(key=>key==='/api/files/'+ids[0]));
 assert.match(d.body.textContent!,/展开转写 \/ 原文片段/);
 await act(async()=>raw.resolve({items:[{id:'raw-chunk',ocrText:'STALE GENERATED RAW',fileEvidence:{startMs:0}}],nextOffset:null}));
 assert.doesNotMatch(d.body.textContent!,/STALE GENERATED RAW/);
});

for(const change of ['artifact','session','unmount'] as const)for(const outcome of ['success','error'] as const)test(`chunk read ignores late ${outcome} after ${change} and prevents duplicate requests`,async t=>{
 const {root,document:d}=await fixture(t),pending=deferred();let artifact='raw-generated',reads=0,signal:AbortSignal|undefined;
 const value=()=>({captureId:ids[0],sourceId:'generated',sizeBytes:100,hasOriginal:false,originMissing:false,item:{title:'Generated recording',observedAt:'2026-09-27T00:00:00Z'},job:null,artifacts:[{id:artifact,kind:artifact==='raw-generated'?'transcript':'dialogue'}]});
 const api=apiWith((path,init)=>{if(path.endsWith('/reviews'))return {items:[]};if(path.includes('/chunks?')){reads++;signal=init?.signal as AbortSignal;return pending.promise;}return value();});
 const render=(client:Api)=>root.render(React.createElement(FileDetail,{api:client,id:ids[0],onOpen:()=>{}}));
 await act(async()=>render(api));
 await act(async()=>{const button=Array.from(d.querySelectorAll('button')).find(b=>b.textContent==='展开原始转写（未校正）')!;button.click();button.click();});assert.equal(reads,1);
 if(change==='artifact'){artifact='dialogue-generated';await act(async()=>resources(api).invalidate(key=>key==='/api/files/'+ids[0]));}
 if(change==='session'){const next=apiWith(path=>path.endsWith('/reviews')?{items:[]}:value());await act(async()=>render(next));}
 if(change==='unmount')await act(async()=>root.render(null));
 assert.equal(signal?.aborted,true);
 await act(async()=>{if(outcome==='success')pending.resolve({items:[{id:'stale',ocrText:'STALE GENERATED CONTENT'}],nextOffset:null});else pending.reject(new Error('STALE GENERATED ERROR'));});
 assert.doesNotMatch(d.body.textContent!,/STALE GENERATED/);
 if(change!=='unmount'){const button=Array.from(d.querySelectorAll('button')).find(b=>b.textContent===(change==='artifact'?'展开转写 / 原文片段':'展开原始转写（未校正）'));assert.ok(button);assert.equal(button.disabled,false);}
});

test('manual segment editor preserves literal speaker prefix, cancels without mutation and submits exact identity',async t=>{
 const {root,document:d}=await fixture(t),writes:any[]=[];
 // React was imported before this fixture's DOM; support its legacy input-event probe.
 (window.HTMLElement.prototype as any).attachEvent=()=>{};(window.HTMLElement.prototype as any).detachEvent=()=>{};
 const original='[SPEAKER_0] Literal original\n  second line';
 const api=apiWith((path,init)=>{if(path.endsWith('/reviews'))return {items:[]};if(path.endsWith('/corrections')){writes.push(JSON.parse(String(init?.body)));throw new ApiError('Generated stale segment',409);}if(path.includes('/chunks?'))return {items:[{id:ids[1],ocrText:'[SPEAKER_0] '+original,fileEvidence:{artifactId:ids[0],speaker:'SPEAKER_0',startMs:0}}],nextOffset:null};return {captureId:ids[0],sourceId:'generated',sizeBytes:100,hasOriginal:false,originMissing:false,item:{title:'Generated recording',observedAt:'2026-09-27T00:00:00Z'},job:{state:'succeeded',summary_state:'cancelled',local_only:1},artifacts:[{id:ids[0],kind:'dialogue'}]};});
 await act(async()=>root.render(React.createElement(FileDetail,{api,id:ids[0],onOpen:()=>{}})));
 const click=async(label:string)=>act(async()=>Array.from(d.querySelectorAll('button')).find(b=>b.textContent===label)!.click());
 await click('展开转写 / 原文片段');await click('纠正此段');assert.equal(d.querySelector('textarea')!.value,original);
 await click('取消');assert.equal(writes.length,0);await click('纠正此段');
 await act(async()=>{const input=d.querySelector('textarea')!;Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(input,'Owner corrected text');input.dispatchEvent(new window.Event('input',{bubbles:true}));input.dispatchEvent(new window.Event('change',{bubbles:true}));input.dispatchEvent(new window.KeyboardEvent('keyup',{bubbles:true,key:'t'}));});
 await act(async()=>d.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
 assert.deepEqual(writes,[{artifactId:ids[0],chunkId:ids[1],originalText:original,correctedText:'Owner corrected text'}]);
 assert.match(d.querySelector('[role=alert]')!.textContent!,/Generated stale segment/);assert.equal(d.querySelector('textarea')!.value,'Owner corrected text');
});


test('Memory rolling-window polling retains selected detail while real scope and session changes fence late replies',async t=>{
 const {root,document:d}=await fixture(t),late=deferred();let delayDetail=false;
 t.mock.timers.enable({apis:['setInterval','Date'],now:Date.parse('2026-09-28T00:00:00Z')});
 const api=apiWith(path=>path.startsWith('/api/memories?')?{items:[memory(ids[0])],nextCursor:null}:delayDetail?late.promise:memory(ids[0]));
 // Reproduce the shell's revision-driven rolling range calculation: a poll
 // moves both endpoints, but the owner's selected period remains "week".
 function PollingShell({period,client,deviceId}:{period:string;client:Api;deviceId?:string}){
  const [revision,setRevision]=React.useState(0);
  React.useEffect(()=>{const timer=setInterval(()=>setRevision(value=>value+1),30000);return()=>clearInterval(timer);},[]);
  const range=React.useMemo(()=>{const now=Date.now();return {after:new Date(now-(period==='week'?7:30)*86400000).toISOString(),before:new Date(now).toISOString(),...(deviceId?{deviceId}:{})};},[period,revision,deviceId]);
  return React.createElement(Memories,{api:client,rangeSelectionKey:period,range,onOpen:()=>{}});
 }
 const render=(period='week',client=api,deviceId?:string)=>root.render(React.createElement(PollingShell,{period,client,deviceId}));
 const open=()=>act(async()=>d.querySelector<HTMLButtonElement>('.workspace-select')!.click());
 await act(async()=>render());await open();assert.match(d.querySelector('.memory-detail')!.textContent!,/Current evidence a/);
 await act(async()=>t.mock.timers.tick(30000));assert.match(d.querySelector('.memory-detail')!.textContent!,/Current evidence a/);
 delayDetail=true;await act(async()=>t.mock.timers.tick(30000));assert.match(d.querySelector('.workspace-content')!.textContent!,/正在读取/);
 await act(async()=>render('month'));await act(async()=>late.resolve({...memory(ids[0]),statement:'STALE WINDOW DETAIL'}));
 assert.equal(d.querySelector('.memory-detail'),null);assert.doesNotMatch(d.body.textContent!,/STALE WINDOW DETAIL/);
 delayDetail=false;await open();assert.ok(d.querySelector('.memory-detail'));
 await act(async()=>render('month',api,'generated-device'));assert.equal(d.querySelector('.memory-detail'),null);
 await open();assert.ok(d.querySelector('.memory-detail'));
 await act(async()=>{const select=d.querySelector<HTMLSelectElement>('[aria-label="内容分类"]')!;select.value='observation';select.dispatchEvent(new window.Event('change',{bubbles:true}));});assert.equal(d.querySelector('.memory-detail'),null);
 await open();assert.ok(d.querySelector('.memory-detail'));
 const next=apiWith(path=>path.startsWith('/api/memories?')?{items:[memory(ids[0])],nextCursor:null}:{...memory(ids[0]),statement:'NEW SESSION DETAIL'});
 await act(async()=>render('month',next,'generated-device'));assert.equal(d.querySelector('.memory-detail'),null);assert.doesNotMatch(d.body.textContent!,/NEW SESSION DETAIL|Current evidence a/);
});

test('single-record memory extraction uses explicit evidence and chosen recipe without rolling range',async t=>{
 const {root,document:d}=await fixture(t),writes:any[]=[];
 const source={id:ids[0],source:'note',capturedAt:'2026-09-28T00:00:00Z',windowTitle:'Generated chosen record',ocrText:'Generated isolated content'};
 window.history.replaceState(null,'','#/library/memories?memorySource='+ids[0]);
 const api=apiWith((path,init)=>{if(init?.method==='POST'){writes.push(JSON.parse(String(init.body)));throw Error('Generated submit retained for inspection');}if(path.startsWith('/api/capture-browser/'))return source;if(path==='/api/memory-recipes')return {items:[{id:'mote.personal-memory',version:'2',available:true}]};if(path.startsWith('/api/memories?'))return {items:[],nextCursor:null};throw Error('Unexpected fixture path '+path);});
 const read=api.request;api.request=async(path,init)=>{if(init?.method==='POST'){writes.push(JSON.parse(String(init.body)));throw Error('Generated submit retained for inspection');}return read(path,init);};
 await act(async()=>root.render(React.createElement(Memories,{api,range:{after:'2020-01-01T00:00:00Z',before:'2020-01-02T00:00:00Z',deviceId:'other-device'},rangeSelectionKey:'today',onOpen:()=>{}})));
 assert.match(d.querySelector('.memory-source-selection')!.textContent!,/Generated chosen record/);
 await act(async()=>d.querySelector<HTMLInputElement>('.manual-memory-recipes input')!.click());
 await act(async()=>Array.from(d.querySelectorAll('button')).find(b=>b.textContent==='提取所选资料的记忆')!.click());
 assert.deepEqual(writes[0].evidenceIds,[ids[0]]);assert.deepEqual(writes[0].recipes,[{id:'mote.personal-memory',version:'2'}]);assert.equal(writes[0].after,undefined);assert.equal(writes[0].before,undefined);assert.equal(writes[0].deviceId,undefined);
 await act(async()=>{Array.from(d.querySelectorAll('button')).find(b=>b.textContent==='清除资料选择，恢复时间范围')!.click();window.dispatchEvent(new window.HashChangeEvent('hashchange'));});
 assert.equal(d.querySelector('.memory-source-selection'),null);await act(async()=>Array.from(d.querySelectorAll('button')).find(b=>b.textContent==='提取当前范围的记忆')!.click());assert.equal(writes[1].evidenceIds,undefined);assert.equal(writes[1].after,'2020-01-01T00:00:00Z');
});
test('single-Material selection sends only its current anchors and refuses a stale pinned revision',async t=>{
 const {root,document:d}=await fixture(t),materialId='mat_'+'a'.repeat(64),revision='b'.repeat(64),ref=`material:${materialId}@${revision}`,writes:any[]=[];
 window.history.replaceState(null,'','#/library/memories?memoryMaterial='+encodeURIComponent(ref));
 let current={id:materialId,ref,revision,title:'Generated two-block R09',memorySource:{status:'ready',evidenceIds:ids}};
 const api=apiWith(path=>{if(path===`/api/materials/${materialId}`)return current;if(path==='/api/memory-recipes')return {items:[{id:'mote.coding-memory',version:'2',available:true}]};if(path.startsWith('/api/memories?'))return {items:[],nextCursor:null};throw Error('Unexpected fixture path '+path);});
 const read=api.request;api.request=async(path,init)=>{if(init?.method==='POST'){writes.push(JSON.parse(String(init.body)));throw Error('Generated submit retained for inspection');}return read(path,init);};
 await act(async()=>root.render(React.createElement(Memories,{api,range:{after:'2020-01-01T00:00:00Z',before:'2020-01-02T00:00:00Z',deviceId:'other-device'},rangeSelectionKey:'today',onOpen:()=>{}})));
 assert.match(d.querySelector('.memory-source-selection')!.textContent!,/Generated two-block R09/);
 await act(async()=>d.querySelector<HTMLInputElement>('.manual-memory-recipes input')!.click());
 const submit=Array.from(d.querySelectorAll('button')).find(button=>button.textContent==='提取所选资料的记忆')!;
 assert.equal(submit.disabled,false,d.querySelector('.memory-source-selection')!.textContent!);
 await act(async()=>submit.click());
 assert.deepEqual(writes[0].evidenceIds,ids);assert.deepEqual(writes[0].recipes,[{id:'mote.coding-memory',version:'2'}]);
 assert.equal(writes[0].after,undefined);assert.equal(writes[0].before,undefined);assert.equal(writes[0].deviceId,undefined);
 current={...current,revision:'c'.repeat(64),ref:`material:${materialId}@${'c'.repeat(64)}`};
 await act(async()=>resources(api).invalidate(key=>key===`/api/materials/${materialId}`));
 const button=Array.from(d.querySelectorAll('button')).find(b=>b.textContent==='提取所选资料的记忆')!;
 assert.equal(button.disabled,true);assert.match(d.querySelector('.memory-source-selection')!.textContent!,/已变化或暂不可提取/);
 await act(async()=>button.click());assert.equal(writes.length,1);
});

test('explicit memory source rejects invalid or revoked records and fences a late previous preview',async t=>{
 const {root,document:d}=await fixture(t),late=deferred();let writes=0;
 const api=apiWith((path,init)=>{if(init?.method==='POST'){writes++;return {};}if(path.includes('/api/capture-browser/'+ids[0]))return late.promise;if(path.includes('/api/capture-browser/'+ids[1]))throw new ApiError('Generated access revoked',403);if(path.startsWith('/api/memories?'))return {items:[],nextCursor:null};if(path==='/api/memory-recipes')return {items:[]};return {};});
 const change=(value:string)=>{window.history.replaceState(null,'','#/library/memories?memorySource='+value);window.dispatchEvent(new window.HashChangeEvent('hashchange'));};
 change(ids[0]);await act(async()=>root.render(React.createElement(Memories,{api,range:{},onOpen:()=>{}})));
 const button=()=>Array.from(d.querySelectorAll('button')).find(b=>b.textContent==='提取所选资料的记忆')!;assert.equal(button().disabled,true);
 await act(async()=>change(ids[1]));await act(async()=>late.resolve({id:ids[0],windowTitle:'STALE SOURCE',ocrText:'STALE BODY',capturedAt:'2026-09-28T00:00:00Z'}));
 assert.doesNotMatch(d.body.textContent!,/STALE SOURCE|STALE BODY/);assert.match(d.body.textContent!,/Generated access revoked/);assert.equal(button().disabled,true);
 await act(async()=>change('material:unsupported'));assert.match(d.body.textContent!,/所选资料无效/);assert.equal(button().disabled,true);await act(async()=>button().click());assert.equal(writes,0);
});

test('generated archived JPEG renders after authorized load and supports native-size reading',async t=>{
 const {root,document:d}=await fixture(t);let loads=0;
 const api=apiWith(path=>{if(path.endsWith('/playback')){loads++;return {url:'/api/files/'+ids[0]+'/content'};}return {captureId:ids[0],item:{title:'Generated diagram.jpg',mimeType:'image/jpeg'},sizeBytes:100,hasOriginal:true,job:null,artifacts:[]};});
 await act(async()=>root.render(React.createElement(FileDetail,{api,id:ids[0],onOpen:()=>{}})));
 await act(async()=>Array.from(d.querySelectorAll('button')).find(b=>/加载原件|查看原图/.test(b.textContent!))!.click());
 const img=d.querySelector('img');assert.ok(img,'authorized image original must be visible');assert.equal(img.getAttribute('src'),'/api/files/'+ids[0]+'/content');assert.equal(img.getAttribute('alt'),'Generated diagram.jpg');
 await act(async()=>Array.from(d.querySelectorAll('button')).find(b=>b.textContent==='原始尺寸')!.click());assert.ok(d.querySelector('.native-size'));assert.equal(loads,1,'resizing reuses authorized URL');
 await act(async()=>img.dispatchEvent(new d.defaultView!.Event('error')));assert.ok(d.querySelector('[role=alert]'));
});

for(const outcome of ['resolve','reject'] as const)test('archived image ignores late '+outcome+' after API session changes',async t=>{
 const {root,document:d}=await fixture(t),pending=deferred();let oldSignal:AbortSignal|undefined;
 const file={captureId:ids[0],item:{title:'Generated image.jpg',mimeType:'image/jpeg'},sizeBytes:100,hasOriginal:true,job:null,artifacts:[]};
 const oldApi=apiWith((path,init)=>{if(path.endsWith('/playback')){oldSignal=init?.signal as AbortSignal;return pending.promise;}return file;});
 const newApi=apiWith(path=>path.endsWith('/playback')?{url:'/generated-current.jpg'}:file);
 const render=(api:Api)=>root.render(React.createElement(FileDetail,{api,id:ids[0],onOpen:()=>{}}));
 await act(async()=>render(oldApi));await act(async()=>Array.from(d.querySelectorAll('button')).find(b=>b.textContent==='查看原图')!.click());
 await act(async()=>render(newApi));assert.equal(oldSignal?.aborted,true);
 await act(async()=>{if(outcome==='resolve')pending.resolve({url:'/generated-stale.jpg'});else pending.reject(new Error('generated stale failure'));});
 assert.equal(d.querySelector('img'),null);assert.doesNotMatch(d.body.textContent!,/generated stale failure/);
 await act(async()=>Array.from(d.querySelectorAll('button')).find(b=>b.textContent==='查看原图')!.click());assert.equal(d.querySelector('img')!.getAttribute('src'),'/generated-current.jpg');
});

test('source drawer decodes only declared organizer text once and separates actions from the body heading',async t=>{
 const {EvidenceDialog}=await import('../src/shell-components.js');const {root,document:d}=await fixture(t);
 const text='Generated first line\n\n{"text":"literal inner JSON"}\n<SCRIPT>untrusted</SCRIPT> [SPEAKER_0] tail';
 const envelope=JSON.stringify({captureId:ids[1],capturedAt:'2026-09-27T00:00:00Z',source:'file',text});
 let declaration:string|undefined='source-record-json-v1',raw=envelope;
 const api=apiWith(()=>({id:ids[0],source:'file',platform:'import',capturedAt:'2026-09-27T00:00:00Z',appName:'Generated',ocrText:raw,evidencePresentation:declaration,privacy:{},revisionState:'current',requiresMaterialForMemory:true,memoryMaterialRef:`material:mat_${'a'.repeat(64)}@${'b'.repeat(64)}`}));
 await act(async()=>root.render(React.createElement(EvidenceDialog,{id:ids[0],api,onClose:()=>{},onDeleted:()=>{},onOpen:()=>{}})));
 const body=()=>d.querySelector('.evidence-text>pre')!;
 assert.equal(body().textContent,text);assert.equal(body().querySelector('script'),null);
 const action=d.querySelector('.evidence-source-actions')!;assert.ok(action.querySelector('button'));assert.equal(action.nextElementSibling?.className,'eyebrow');assert.equal(body().previousElementSibling?.tagName,'H4');
 declaration=undefined;await act(async()=>resources(api).invalidate(key=>key.startsWith('/api/capture-browser/')));assert.equal(body().textContent,envelope,'ordinary JSON prose is never unwrapped heuristically');
 declaration='source-record-json-v1';raw='{"text":"not a valid organizer envelope"}';await act(async()=>resources(api).invalidate(key=>key.startsWith('/api/capture-browser/')));assert.equal(body().textContent,raw,'invalid declarations retain the supplied evidence');
});
