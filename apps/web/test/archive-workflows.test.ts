import {test} from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM,ResourceLoader} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {InsightReport,reportDocument} from '../src/InsightReport.js';
import {MemoryProgress,type MemoryJob} from '../src/plugins/memory/index.js';
import {SourceDocumentDetails} from '../src/plugins/reader/index.js';
import {createApi,type Answer} from '../src/api.js';
import designTokens from '../../../packages/shared/design-tokens.light.json';

configureLocale(()=> 'zh-CN');
const evidenceId='11111111-1111-4111-8111-111111111111';
test('snapshot metadata describes central text retention and partial coverage without offering a legacy lightweight mode',()=>{
 const document={fileIndex:{version:1 as const,fileId:evidenceId,contentVersion:'generated',mode:'index' as const,coverage:'lightweight' as const,parser:'generated-central-processor',status:'ready' as const,totalCharacters:120000,offset:0,length:100000,allowRead:true}};
 const html=renderToStaticMarkup(React.createElement(SourceDocumentDetails,{api:{} as any,document}));
 assert.match(html,/部分索引就绪/);assert.match(html,/100000 \/ 120000/);assert.match(html,/允许中央保留提取出的完整正文，设备离线仍可查阅/);assert.doesNotMatch(html,/需要设备在线|轻量索引/);
 const full=renderToStaticMarkup(React.createElement(SourceDocumentDetails,{api:{} as any,document:{fileIndex:{...document.fileIndex,coverage:'full',length:120000}}}));assert.match(full,/索引处理完成/);
});
const answer:Answer={runId:'fixture-run',answer:`合成资料中的项目进展 [${evidenceId}]`,citations:[{id:evidenceId,appName:'合成笔记',capturedAt:'2026-09-15T02:00:00Z',excerpt:'项目在等待一次合成评审'}],trace:[],artifact:{id:'fixture-report',title:'项目进展',html:'<h1>合成报告</h1><style>h1{color:green}</style><p>等待评审。</p>',createdAt:'2026-09-15T03:00:00Z',skillId:'insight',skillVersion:'1'}};

test('a generated report isolates untrusted content and keeps evidence controls in the host',()=>{
  const html=renderToStaticMarkup(React.createElement(InsightReport,{answer,onOpen:()=>{}}));
  assert.match(html,/<iframe[^>]+sandbox="allow-scripts"[^>]+referrerPolicy="no-referrer"/);
  assert.match(html,/srcDoc="&lt;!doctype html/);
  assert.doesNotMatch(html,/<h1>合成报告<\/h1>/);
  assert.match(html,/<details class="report-evidence"/);
  assert.match(html,/<button[^>]+class="evidence-card"/);
  assert.match(html,/项目在等待一次合成评审/);
  assert.match(html,/aria-haspopup="menu" aria-expanded="false"/);
  assert.match(html,/更多/);
  assert.doesNotMatch(html,/role="menuitemradio"/);
});

test('report reading choices stay under More and switching preserves the answer, citations and keyboard focus',async t=>{
  const dom=new JSDOM('<!doctype html><div id="root"></div><button id="outside">Outside</button>',{url:'http://localhost/',pretendToBeVisual:true});
  const before=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,Node:dom.window.Node,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){
    before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!),d=dom.window.document,opened:string[]=[],stored=JSON.stringify(answer);
  t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of before){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
  await act(async()=>root.render(React.createElement(InsightReport,{answer,onOpen:id=>opened.push(id)})));
  const more=d.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  assert.ok(d.querySelector('.report-frame'));assert.equal(d.querySelector('[role="menu"]'),null);
  await act(async()=>more.click());
  let choices=d.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
  assert.deepEqual(Array.from(choices,item=>[item.textContent,item.getAttribute('aria-checked')]),[['排版结果','true'],['标准阅读','false']]);
  assert.equal(d.activeElement,choices[0]);
  await act(async()=>choices[0].dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})));assert.equal(d.activeElement,choices[1]);
  await act(async()=>choices[1].click());
  assert.equal(d.querySelector('.report-frame'),null);assert.match(d.querySelector('.report-markdown')!.textContent!,/合成资料中的项目进展/);assert.equal(more.getAttribute('aria-expanded'),'false');assert.equal(d.activeElement,more);
  await act(async()=>d.querySelector<HTMLButtonElement>('.evidence-card')!.click());assert.deepEqual(opened,['capture:'+evidenceId]);
  await act(async()=>more.click());choices=d.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');assert.equal(d.activeElement,choices[1]);
  await act(async()=>choices[1].dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Home',bubbles:true})));assert.equal(d.activeElement,choices[0]);
  await act(async()=>choices[0].click());assert.ok(d.querySelector('.report-frame'));assert.equal(d.querySelector('.report-markdown'),null);
  await act(async()=>more.click());await act(async()=>d.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(d.querySelector('[role="menu"]'),null);assert.equal(d.activeElement,more);
  await act(async()=>more.click());await act(async()=>d.getElementById('outside')!.dispatchEvent(new dom.window.Event('pointerdown',{bubbles:true})));assert.equal(d.querySelector('[role="menu"]'),null);
  assert.equal(JSON.stringify(answer),stored,'display changes never rewrite the archived result');
});

test('report document places the restrictive resource policy before any generated content',()=>{
  const html=reportDocument('<html><head><style>p{color:green}</style></head><body><p>fixture</p></body></html>');
  assert.ok(html.indexOf('Content-Security-Policy')<html.indexOf('<style>p'));
  for(const directive of ["default-src 'none'","script-src 'none'","connect-src 'none'","frame-src 'none'","object-src 'none'","base-uri 'none'","form-action 'none'"])assert.ok(html.includes(directive));
  assert.ok(html.includes("img-src data:"));
  assert.ok(!html.includes('allow-scripts'));
});

test('unstyled report links use the shared accent while authored link presentation wins',()=>{
  const stored='<style>.authored{color:rgb(98, 37, 131)}</style><a href="#source">Generated source</a><a class="authored" href="#source">Authored source</a>';
  const rendered=new JSDOM(reportDocument(stored));
  const [plain,authored]=rendered.window.document.querySelectorAll('a');
  const expected=designTokens.accent.slice(1).match(/.{2}/g)!.map(part=>parseInt(part,16));
  assert.equal(rendered.window.getComputedStyle(plain).color,`rgb(${expected.join(', ')})`);
  assert.equal(rendered.window.getComputedStyle(authored).color,'rgb(98, 37, 131)');
  assert.equal(rendered.window.getComputedStyle(plain).pointerEvents,'none');
  assert.ok(reportDocument(stored).includes(stored),'authored markup and styles stay intact');
  rendered.window.close();
});

test('full-document reports without citations keep one effective host policy and retain authored presentation',()=>{
  const dom=new JSDOM('<!doctype html><body></body>');
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:dom.window.document});
  try{
    const stored='<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><style>p{color:green}</style></head><body><h1>Generated report</h1><p>Uncited facts still need review.</p></body></html>';
    const result=reportDocument(stored,[]),rendered=new JSDOM(result);
    const policies=rendered.window.document.querySelectorAll('meta[http-equiv="content-security-policy" i]');
    assert.equal(policies.length,1);
    assert.equal(policies[0].parentElement?.tagName,'HEAD');
    assert.match(policies[0].getAttribute('content')??'',/script-src 'none';.*connect-src 'none'/);
    assert.match(result,/<style>p\{color:green\}<\/style>/);
    assert.match(result,/<h1>Generated report<\/h1><p>Uncited facts still need review\.<\/p>/);
    assert.ok(stored.includes('Content-Security-Policy'),'the stored artifact remains unchanged');
    rendered.window.close();
  }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');dom.window.close();}
});

test('report display shortens only verified visible citation text in an inert copy',()=>{
  const other='22222222-2222-4222-8222-222222222222';
  const requests:string[]=[];
  class WatchResources extends ResourceLoader {fetch(url:string){requests.push(url);return null;}}
  const dom=new JSDOM('<!doctype html><body></body>',{url:'https://fixture.invalid/',resources:new WatchResources(),runScripts:'dangerously'});
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:dom.window.document});
  try{
    const stored=`<html><head><title>Hidden [${evidenceId}]</title><style>p:before{content:'[${evidenceId}]'}</style></head><body><p>First [${evidenceId}][${other}] [unknown]</p><a href="https://example.invalid/[${evidenceId}]">Read [${evidenceId}]</a><code>[${evidenceId}]</code><pre>[${evidenceId}]</pre><textarea>[${evidenceId}]</textarea><noscript>[${evidenceId}]</noscript><template>[${evidenceId}]</template><svg><text>[${evidenceId}]</text></svg><script>window.fixtureExecuted=true</script><img src="https://example.invalid/pixel"></body></html>`;
    const html=reportDocument(stored,[answer.citations[0],{...answer.citations[0],id:other},answer.citations[0]]);
    assert.match(html,/First （来源 3）（来源 2） \[unknown\]/);
    assert.match(html,/<a href="https:\/\/example.invalid\/\[11111111-1111-4111-8111-111111111111\]">Read （来源 3）<\/a>/);
    for(const tag of ['title','code','pre','textarea','noscript','template','text'])assert.match(html,new RegExp(`<${tag}[^>]*>[^<]*\\[${evidenceId}\\]`));
    assert.match(html,/<style>p:before\{content:'\[11111111-1111-4111-8111-111111111111\]'\}<\/style>/);
    assert.match(html,/<script>window.fixtureExecuted=true<\/script>/);
    assert.match(html,/<img src="https:\/\/example.invalid\/pixel">/);
    assert.match(html,/First/);assert.match(html,/p:before/);
    assert.ok(html.indexOf('Content-Security-Policy')<html.indexOf('p:before'));
    assert.match(html,/script-src 'none'/);
    assert.equal((dom.window as unknown as {fixtureExecuted?:boolean}).fixtureExecuted,undefined);
    assert.deepEqual(requests,[]);
    assert.ok(stored.includes(`[${evidenceId}]`),'the archived HTML value stays untouched');
  }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');dom.window.close();}
});

test('a narrow Insight coverage block has its own layout hook while iframe isolation remains',()=>{
  const snapshot:NonNullable<Answer['snapshot']>={schemaVersion:1,id:'fixture-snapshot',seriesId:'fixture-series',version:1,asOf:'2026-09-15T03:00:00Z',scope:{before:'2026-09-15T03:00:00Z',timeZone:'Asia/Shanghai'},watermark:1,scopeFingerprint:'fixture',coverage:{records:5,materialRecords:5,referenceOnlyRecords:0,pendingProcessing:0,sourceStates:[],measured:{observedDurationMs:0,deviceDurationMs:0,overlapDurationMs:0,unobservedDurationMs:null,accounting:'union_across_devices',coverage:'observed_intervals_only'},limitations:[]}};
  const html=renderToStaticMarkup(React.createElement(InsightReport,{answer:{...answer,snapshot},onOpen:()=>{}}));
  assert.match(html,/<div class="report-coverage"/);
  assert.equal((html.match(/<div class="report-coverage"[\s\S]*?<\/div>/)?.[0].match(/<p>/g)||[]).length,3);
  assert.match(html,/<iframe[^>]+sandbox="allow-scripts"/);
});

test('legacy reports remain readable as markdown with clickable evidence when no HTML artifact exists',()=>{
  const html=renderToStaticMarkup(React.createElement(InsightReport,{answer:{...answer,artifact:undefined},onOpen:()=>{}}));
  assert.doesNotMatch(html,/<iframe/);
  assert.match(html,/查看证据：来源 1/);
  assert.match(html,/合成资料中的项目进展/);
});
test('report evidence uses source content time instead of its later import observation',()=>{
  const html=renderToStaticMarkup(React.createElement(InsightReport,{answer:{...answer,citations:[{...answer.citations[0],contentAt:'2020-02-03T08:00:00Z'}]},onOpen:()=>{}}));
  assert.match(html,/资料时间 · 2020年2月3日/);
});

const job:MemoryJob={id:'fixture-memory',status:'running',createdAt:'2026-09-15T03:00:00Z',updatedAt:'2026-09-15T03:00:00Z',evidenceIds:[evidenceId],totalBatches:5,completedBatches:2,failedBatches:1,skippedChunks:1,memoryIds:['candidate-1'],skillVersion:'1',memoryCount:['candidate-1'].length,inputPlans:{total:5,waiting:2,blocked:1,stale:0,completed:2},recipeProgress:[]};
test('memory progress reports actual partial completion and does not label archive success as completed memory',()=>{
  const html=renderToStaticMarkup(React.createElement(MemoryProgress,{job}));
  assert.match(html,/正在分批提取记忆/);assert.match(html,/已生成的批次：2 \/ 5 完成/);assert.match(html,/1 批失败/);
  assert.match(html,/有 1 个片段已处理过或没有可提取的正文/);assert.doesNotMatch(html,/记忆提取完成/);
  assert.match(html,/<progress[^>]+max="5"[^>]+value="2"/);
});
test('failed and unconfigured batches offer a resumable operation',()=>{
  for(const status of ['failed','waiting_for_model'] as const){
    const html=renderToStaticMarkup(React.createElement(MemoryProgress,{job:{...job,status},onRetry:()=>{}}));
    assert.match(html,/重新检查未完成方案/);assert.doesNotMatch(html,/记忆提取完成/);
  }
});
test('an internal planner failure is actionable failure rather than a missing-material wait',()=>{
 const html=renderToStaticMarkup(React.createElement(MemoryProgress,{job:{...job,status:'failed',errorCode:'memory_feedback_planning_failed'},onRetry:()=>{}}));
 assert.match(html,/内部规划失败，未完成范围已保留/);assert.match(html,/请查看失败原因后决定是否重试/);assert.doesNotMatch(html,/等待资料处理|其余方案等待所需资料/);
 const stop=renderToStaticMarkup(React.createElement(MemoryProgress,{job:{...job,status:'waiting_for_input',errorCode:'memory_context_required'}}));assert.match(stop,/当前授权资料不能提供所需语境/);assert.doesNotMatch(stop,/内部规划失败/);
});
test('document evidence retains original metadata and authenticated download controls without embedding a token',()=>{
  const html=renderToStaticMarkup(React.createElement(SourceDocumentDetails,{api:createApi({token:'fixture-secret-token'}),document:{fileId:'file-1',path:'export/notes.json',recordedAt:'2020-01-02T00:00:00Z',contentRole:'authored',attachments:[{id:'attachment-1',name:'photo.png'}],originalMetadata:{author:'合成人物',text:'<script>fixture</script>'}}}));
  assert.match(html,/原文记录时间/);assert.match(html,/notes.json/);assert.match(html,/关联附件（1）/);
  assert.match(html,/&lt;script&gt;fixture&lt;\/script&gt;/);assert.doesNotMatch(html,/fixture-secret-token/);
  assert.doesNotMatch(html,/href="\/api\/files/);
});

test('memory status exposes admission waits, idle review, exact rejection and batch-boundary controls',()=>{
 const html=renderToStaticMarkup(React.createElement(MemoryProgress,{job:{...job,runningBatches:1,pendingBatches:2,batches:[{id:'batch',index:1,status:'running',attempts:1,memoryIds:[],phase:'review',stage:'等待模型执行名额',startedAt:'2020-01-01T00:00:00Z',lastActivityAt:'2020-01-01T00:00:00Z',validationFailures:[{at:'2020-01-01T00:00:00Z',code:'quote_offset_mismatch',phase:'review',attempt:1,details:{candidateIndex:0,spanIndex:1}}]}]},onAction:()=>{}}));
 for(const text of ['执行中 1 批','等待 2 批','独立审核','等待模型执行名额','较长时间未收到新活动','quote_offset_mismatch','当前批次结束后暂停','取消未完成方案'])assert.ok(html.includes(text),text);
 const paused=renderToStaticMarkup(React.createElement(MemoryProgress,{job:{...job,status:'paused'},onAction:()=>{}}));assert.match(paused,/继续整理/);
 const completed=renderToStaticMarkup(React.createElement(MemoryProgress,{job:{...job,status:'completed',memoryIds:[]}}));assert.match(completed,/本次没有发现需要新增的记忆/);
});


test('Memory invalidated inputs are separated from failures without offering a misleading retry',()=>{
 const invalid:MemoryJob={...job,status:'failed',outcome:'input_invalidated',failedBatches:0,invalidatedBatches:2,inputPlans:{total:2,waiting:0,blocked:0,stale:2,completed:0},recipeProgress:[{recipe:{id:'mote.personal-memory',version:'3'},inputs:{total:2,waiting:0,blocked:0,stale:2,completed:0},completedBatches:0,failedBatches:0,invalidatedBatches:2,reasons:[{code:'evidence_changed',materialRef:'material:generated'}]}]};
 const html=renderToStaticMarkup(React.createElement(MemoryProgress,{job:invalid,onRetry:()=>{},onAction:()=>{},onOpen:()=>{}}));
 assert.match(html,/资料已更新，本次结果失效/);assert.match(html,/2 批输入已失效/);assert.match(html,/2 项输入已失效/);assert.match(html,/查看来源与处理/);
 assert.doesNotMatch(html,/重新检查未完成方案|部分记忆提取需要重试|取消未完成方案|2 批失败|记忆提取完成/);
 const mixed=renderToStaticMarkup(React.createElement(MemoryProgress,{job:{...invalid,outcome:'processing_failed',failedBatches:1},onRetry:()=>{}}));
 assert.match(mixed,/1 批失败/);assert.match(mixed,/2 批输入已失效/);assert.match(mixed,/重新检查未完成方案/);
 for(const status of ['paused','cancelled'] as const){const stopped=renderToStaticMarkup(React.createElement(MemoryProgress,{job:{...invalid,status,outcome:undefined},onRetry:()=>{},onAction:()=>{}}));assert.doesNotMatch(stopped,/资料已更新，本次结果失效|重新检查未完成方案/);}
});
