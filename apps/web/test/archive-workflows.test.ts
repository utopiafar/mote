import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {InsightReport,reportDocument} from '../src/InsightReport.js';
import {MemoryProgress,type MemoryJob} from '../src/MemoryProgress.js';
import {SourceDocumentDetails} from '../src/SourceDocumentDetails.js';
import {createApi,type Answer} from '../src/api.js';

const evidenceId='11111111-1111-4111-8111-111111111111';
const answer:Answer={runId:'fixture-run',answer:`合成资料中的项目进展 [${evidenceId}]`,citations:[{id:evidenceId,appName:'合成笔记',capturedAt:'2026-09-15T02:00:00Z',excerpt:'项目在等待一次合成评审'}],trace:[],artifact:{id:'fixture-report',title:'项目进展',html:'<h1>合成报告</h1><style>h1{color:green}</style><p>等待评审。</p>',createdAt:'2026-09-15T03:00:00Z',skillId:'insight',skillVersion:'1'}};

test('a generated report is isolated in a scriptless iframe while evidence controls remain in the host',()=>{
  const html=renderToStaticMarkup(React.createElement(InsightReport,{answer,onOpen:()=>{}}));
  assert.match(html,/<iframe[^>]+sandbox=""[^>]+referrerPolicy="no-referrer"/);
  assert.match(html,/srcDoc="&lt;!doctype html/);
  assert.doesNotMatch(html,/<h1>合成报告<\/h1>/);
  assert.match(html,/<section class="report-evidence"/);
  assert.match(html,/<button[^>]+class="evidence-card"/);
  assert.match(html,/项目在等待一次合成评审/);
  assert.match(html,/文字/);
});

test('report document places the restrictive resource policy before any generated content',()=>{
  const html=reportDocument('<html><head><style>p{color:green}</style></head><body><p>fixture</p></body></html>');
  assert.ok(html.indexOf('Content-Security-Policy')<html.indexOf('<style>p'));
  for(const directive of ["default-src 'none'","script-src 'none'","connect-src 'none'","frame-src 'none'","object-src 'none'","base-uri 'none'","form-action 'none'"])assert.ok(html.includes(directive));
  assert.ok(html.includes("img-src data:"));
  assert.ok(!html.includes('allow-scripts'));
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

const job:MemoryJob={id:'fixture-memory',status:'running',createdAt:'2026-09-15T03:00:00Z',updatedAt:'2026-09-15T03:00:00Z',evidenceIds:[evidenceId],totalBatches:5,completedBatches:2,failedBatches:1,skippedChunks:1,memoryIds:['candidate-1'],skillVersion:'1'};
test('memory progress reports actual partial completion and does not label archive success as completed memory',()=>{
  const html=renderToStaticMarkup(React.createElement(MemoryProgress,{job}));
  assert.match(html,/正在分批提取记忆/);assert.match(html,/已完成 2 \/ 5 批/);assert.match(html,/1 批失败/);
  assert.match(html,/有 1 个片段已处理过或没有可提取的正文/);assert.doesNotMatch(html,/记忆提取完成/);
  assert.match(html,/<progress[^>]+max="5"[^>]+value="2"/);
});
test('failed and unconfigured batches offer a resumable operation',()=>{
  for(const status of ['failed','waiting_for_model'] as const){
    const html=renderToStaticMarkup(React.createElement(MemoryProgress,{job:{...job,status},onRetry:()=>{}}));
    assert.match(html,/继续提取记忆/);assert.doesNotMatch(html,/记忆提取完成/);
  }
});
test('document evidence retains original metadata and authenticated download controls without embedding a token',()=>{
  const html=renderToStaticMarkup(React.createElement(SourceDocumentDetails,{api:createApi({token:'fixture-secret-token'}),document:{fileId:'file-1',path:'export/notes.json',recordedAt:'2020-01-02T00:00:00Z',contentRole:'authored',attachments:[{id:'attachment-1',name:'photo.png'}],originalMetadata:{author:'合成人物',text:'<script>fixture</script>'}}}));
  assert.match(html,/原文记录时间/);assert.match(html,/notes.json/);assert.match(html,/关联附件（1）/);
  assert.match(html,/&lt;script&gt;fixture&lt;\/script&gt;/);assert.doesNotMatch(html,/fixture-secret-token/);
  assert.doesNotMatch(html,/href="\/api\/files/);
});

test('memory status exposes admission waits, idle review, exact rejection and batch-boundary controls',()=>{
 const html=renderToStaticMarkup(React.createElement(MemoryProgress,{job:{...job,runningBatches:1,pendingBatches:2,batches:[{id:'batch',index:1,status:'running',attempts:1,memoryIds:[],phase:'review',stage:'等待模型执行名额',startedAt:'2020-01-01T00:00:00Z',lastActivityAt:'2020-01-01T00:00:00Z',validationFailures:[{at:'2020-01-01T00:00:00Z',code:'quote_offset_mismatch',phase:'review',attempt:1,details:{candidateIndex:0,spanIndex:1}}]}]},onAction:()=>{}}));
 for(const text of ['执行中 1 批','等待 2 批','独立审核','等待模型执行名额','较长时间未收到新活动','quote_offset_mismatch','当前批次结束后暂停','取消剩余批次'])assert.ok(html.includes(text),text);
 const paused=renderToStaticMarkup(React.createElement(MemoryProgress,{job:{...job,status:'paused'},onAction:()=>{}}));assert.match(paused,/继续整理/);
 const completed=renderToStaticMarkup(React.createElement(MemoryProgress,{job:{...job,status:'completed',memoryIds:[]}}));assert.match(completed,/本次没有发现需要新增的记忆/);
});
