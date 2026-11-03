import { test } from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {JSDOM} from 'jsdom';
import { AnswerMarkdown, answerPreview } from '../src/plugins/ask/AnswerMarkdown.js';
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
  await act(async()=>button.click());assert.deepEqual(opened,['capture:'+id]);
  await act(async()=>root.render(React.createElement(AnswerMarkdown,{answer:{...value,citations:[...value.citations]},onOpen})));
  assert.equal(dom.window.document.querySelector('td .inline-citation'),button);
  assert.equal(dom.window.document.activeElement,button);
});

test('the persisted H04 Chinese bold labels render strong without changing answer or citation bytes',()=>{
 const text=`**会议开始时间：**明天九点\n\n**要带的东西：**蓝色笔记本 [${id}]`,value={...answer,answer:text},before=structuredClone(value),html=renderToStaticMarkup(React.createElement(AnswerMarkdown,{answer:value,onOpen:()=>{}})),dom=new JSDOM(html);try{assert.deepEqual([...dom.window.document.querySelectorAll('strong')].map(e=>e.textContent),['会议开始时间：','要带的东西：']);assert.equal(dom.window.document.querySelectorAll('.inline-citation').length,1);assert.deepEqual(value,before);assert.doesNotMatch(dom.window.document.body.textContent!,/\*\*/);}finally{dom.window.close();}
});
test('CJK attention remains Markdown syntax inside prose and tables, preserving nested emphasis and authored links',()=>{
 const dom=new JSDOM(render(`前**“重要标签”**后\n\n| 要点 | 内容 |\n| --- | --- |\n| **开会时间：**明天 | [**地点：**办公室](https://example.com/path) |\n\n**正常粗体与 *已有斜体*：**后`));try{const d=dom.window.document;assert.deepEqual([...d.querySelectorAll('strong')].map(e=>e.textContent),['“重要标签”','开会时间：','地点：','正常粗体与 已有斜体：']);assert.equal(d.querySelector('em')?.textContent,'已有斜体');assert.equal(d.querySelector('a')?.getAttribute('href'),'https://example.com/path');}finally{dom.window.close();}
});
test('CJK bold extension preserves code, escapes, URL bytes, unmatched markers, identifiers and HTML safety',()=>{
 const url='https://example.com/**网址：**中文?value=**字：**后',text=String.raw`\*\*会议开始时间：\*\*明天九点`+'\n\n&#42;&#42;实体转义：&#42;&#42;中文\n\n`**会议开始时间：**明天九点`\n\n```text\n**要带的东西：**蓝色笔记本\n```\n\n[保留原网址]('+url+')\n\n**未配对中文：明天\n\n[not-a-verified-id]\n\n<script>**不可执行：**内容</script>\n\n<img src=x onerror="alert(1)">',dom=new JSDOM(render(text));try{const d=dom.window.document;assert.equal(d.querySelector('strong'),null);assert.equal(d.querySelector('code')?.textContent,'**会议开始时间：**明天九点');assert.match(d.querySelector('pre code')!.textContent!,/\*\*要带的东西：\*\*/);assert.equal(decodeURI(d.querySelector('a')!.getAttribute('href')!),url);assert.match(d.body.textContent!,/\*\*未配对中文：明天/);assert.match(d.body.textContent!,/\[not-a-verified-id\]/);assert.match(d.body.textContent!,/\*\*会议开始时间：\*\*明天九点/);assert.equal(d.querySelector('script,img'),null);assert.equal(d.querySelector('.inline-citation'),null);}finally{dom.window.close();}
});
