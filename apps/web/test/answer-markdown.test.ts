import { test } from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {JSDOM} from 'jsdom';
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
test('GFM tables retain semantic cells, formatting and verified evidence controls',()=>{
  const html=render(`| Item | Evidence |\n| --- | --- |\n| **Generated plan** | Pending [${id}] |\n| Escaped \\| pipe | \`[${id}]\` |`);
  const dom=new JSDOM(html),d=dom.window.document;
  try{
    assert.equal(d.querySelectorAll('table').length,1);
    assert.equal(d.querySelectorAll('thead th').length,2);
    assert.equal(d.querySelectorAll('tbody tr').length,2);
    assert.equal(d.querySelector('td strong')?.textContent,'Generated plan');
    assert.equal(d.querySelectorAll('td .inline-citation').length,1);
    assert.equal(d.querySelector('td code')?.textContent,`[${id}]`);
    assert.equal(d.querySelectorAll('tbody tr')[1].firstElementChild?.textContent,'Escaped | pipe');
    assert.equal(d.querySelector('.answer-table-scroll')?.getAttribute('tabindex'),'0');
  }finally{dom.window.close();}
});
test('table citations open the verified original and retain focus across answer rerenders',async t=>{
  const dom=new JSDOM('<!doctype html><div id="mount"></div>',{url:'http://localhost/',pretendToBeVisual:true}),globals=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){globals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
  const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.querySelector('#mount')!),opened:string[]=[],onOpen=(ref:string)=>opened.push(ref),value={...answer,answer:`| Plan | Status |\n| --- | --- |\n| Generated | Unknown [${id}] |`};
  t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,previous]of globals){if(previous)Object.defineProperty(globalThis,key,previous);else Reflect.deleteProperty(globalThis,key);}});
  await act(async()=>root.render(React.createElement(AnswerMarkdown,{answer:value,onOpen})));
  const button=dom.window.document.querySelector<HTMLButtonElement>('td .inline-citation')!;button.focus();
  await act(async()=>button.click());assert.deepEqual(opened,[id]);
  await act(async()=>root.render(React.createElement(AnswerMarkdown,{answer:{...value,citations:[...value.citations]},onOpen})));
  assert.equal(dom.window.document.querySelector('td .inline-citation'),button);
  assert.equal(dom.window.document.activeElement,button);
});
