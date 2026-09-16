import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnswerMarkdown, answerPreview } from '../src/AnswerMarkdown.js';
import type { Answer } from '../src/api.js';
const id='11111111-1111-4111-8111-111111111111';
const answer:Answer={answer:'',runId:'fixture',trace:[],citations:[{id,appName:'合成随手记',capturedAt:'2026-09-12T00:00:00Z',excerpt:'合成原文'}]};
const render=(text:string)=>renderToStaticMarkup(React.createElement(AnswerMarkdown,{answer:{...answer,answer:text},onOpen:()=>{}}));
test('verified citations become accessible local evidence controls inside prose and lists',()=>{
  const html=render(`最终决定 [${id}]。\n\n- 复核 [${id}]`);
  assert.equal((html.match(/class="inline-citation"/g)||[]).length,2);
  assert.match(html,/查看证据：来源 1/);assert.ok(!html.includes(id));
});
test('citation formatting preserves quoted code, unverified identifiers and authored links',()=>{
  const html=render(`\`[${id}]\`\n\n[not-a-retrieved-id]\n\n[${id}](https://example.com)\n\n<script>alert(1)</script>\n\n![remote image](https://example.com/pixel)`);
  assert.ok(!html.includes('inline-citation'));
  assert.match(html,/<code>\[11111111/);assert.match(html,/not-a-retrieved-id/);
  assert.match(html,/href="https:\/\/example.com"/);assert.ok(!html.includes('<script'));assert.ok(!html.includes('<img'));
});
test('history previews remove Markdown formatting and only verified citation markers',()=>{
  const text=answerPreview({...answer,answer:`## 合成回顾\n\n- **完成检查** [${id}]\n\n[项目记录](https://example.com) [unverified]`},200);
  assert.equal(text,'合成回顾 完成检查 项目记录 [unverified]');
  assert.ok(!text.includes(id));
  assert.equal(answerPreview({...answer,answer:'一二三四五'},3),'一二三…');
});
