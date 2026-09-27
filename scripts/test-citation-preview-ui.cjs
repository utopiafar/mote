require('./fixture-language.cjs');
/** Actual React citation renderers with generated evidence only; no model or private vault. */
const {app,BrowserWindow}=require('electron');
const {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve,relative}=require('node:path');
const {pathToFileURL}=require('node:url');
const {randomUUID,createHash}=require('node:crypto');
const assert=require('node:assert/strict');
const {build}=require('esbuild');
const repo=resolve(__dirname,'..'),output=resolve(process.env.MOTE_CITATION_PREVIEW_OUTPUT||'');
assert.ok(process.env.MOTE_CITATION_PREVIEW_OUTPUT&&relative(repo,output).startsWith('..'),'Set an output directory outside the repository');
mkdirSync(output,{mode:0o700}); // Never overwrite a previous run.
const temporary=mkdtempSync(join(tmpdir(),'mote-citation-preview-'));
app.setPath('userData',join(temporary,'browser'));app.on('window-all-closed',()=>{});
const report={passed:false,personalDataUsed:false,liveModel:false,physicalDevicesTested:false,scope:'Actual AnswerView and InsightReport components with app CSS in an isolated Electron renderer; not full application navigation',checks:[],screenshots:[]};
let window;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function check(name,value){assert.ok(value,name);report.checks.push(name);}
async function run(){
  const {startBridge}=await import(pathToFileURL(join(repo,'packages/agent/dist/bridge.js')).href);
  const {parseAnswer}=await import(pathToFileURL(join(repo,'packages/agent/dist/index.js')).href);
  const texts=['今天先裁米白再生纸做试页，完成四页内页，用蓝线做了两针。\n“封面还可以换。” "quoted" \\ slash 😀👩‍💻。','已经披露的前段。\nUNREAD_GAP_MUST_NOT_APPEAR\n已经披露的后段 😀。\nUNREAD_TAIL_MUST_NOT_APPEAR'];
  const records=texts.map((text,index)=>({id:randomUUID(),capturedAt:'2026-09-27T00:00:00Z',appName:index?'生成的语音转写':'生成的手工记录',sourceType:'message',ocrText:index?JSON.stringify({speaker:'SPEAKER_0',text}):JSON.stringify({captureId:randomUUID(),capturedAt:'2026-09-27T00:00:00Z',source:'message',text}),evidencePresentation:index?'speech-json-v1':'source-record-json-v1'}));
  const first=records[0],second=records[1],start=second.ocrText.indexOf('已经披露的前段'),gap=second.ocrText.indexOf('UNREAD_GAP'),later=second.ocrText.indexOf('已经披露的后段'),tail=second.ocrText.indexOf('UNREAD_TAIL');
  const ranges=[{id:first.id,offset:0,length:first.ocrText.length},{id:first.id,offset:first.ocrText.indexOf('今天'),length:20},{id:second.id,offset:start,length:gap-start},{id:second.id,offset:later,length:tail-later}];
  const reader={search:async()=>records,timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>records,devices:async()=>[],activity:async()=>({})};
  const bridge=await startBridge(reader,{question:'Generated citation display',evidenceIds:records.map(r=>r.id),evidenceRanges:ranges},4);
  let answer;
  try{answer={...parseAnswer(JSON.stringify({answer:`手工记录保留了具体步骤。[${first.id}] 另一条引用只展示已经读过的两段。[${second.id}]`,citationIds:records.map(r=>r.id)}),bridge.records),trace:[],runId:'generated-citation-preview',createdAt:'2026-09-27T00:00:00Z'};}
  finally{await bridge.close();}
  check('decoded first excerpt is exact and not repeated',answer.citations[0].excerpt===texts[0]);
  check('second excerpt marks the unread gap without exposing either sentinel',answer.citations[1].excerpt.includes(' … ')&&!answer.citations[1].excerpt.includes('UNREAD_'));
  writeFileSync(join(output,'fixture.json'),JSON.stringify({records,ranges,answer},null,2)+'\n',{mode:0o600});
  await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {AnswerView} from './apps/web/src/shell-components.tsx';import {InsightReport} from './apps/web/src/InsightReport.tsx';import './apps/web/src/styles.css';const answer=${JSON.stringify(answer)};window.__opened=[];const onOpen=id=>window.__opened.push(id);createRoot(document.getElementById('root')).render(<main style={{maxWidth:1100,margin:'24px auto',padding:16}}><h1>生成数据：引用预览</h1><section id="answer-preview"><AnswerView answer={answer} onOpen={onOpen}/></section><section id="insight-preview"><InsightReport answer={answer} onOpen={onOpen}/></section></main>);`,resolveDir:repo,sourcefile:'generated-citation-preview.tsx',loader:'tsx'},bundle:true,format:'iife',platform:'browser',jsx:'automatic',outfile:join(temporary,'bundle.js'),define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  writeFileSync(join(temporary,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="bundle.css"></head><body><div id="root"></div><script src="bundle.js"></script></body></html>');
  await app.whenReady();window=new BrowserWindow({width:1280,height:1100,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  const js=code=>window.webContents.executeJavaScript(code);await window.loadFile(join(temporary,'index.html'));
  for(let tries=0;tries<100;tries++){if(await js("document.querySelectorAll('#answer-preview .citation p').length===2"))break;await delay(50);}
  const expected=answer.citations.map(c=>c.excerpt);
  assert.deepEqual(await js("[...document.querySelectorAll('#answer-preview .citation p')].map(e=>e.textContent)"),expected);check('AnswerView renders both exact host excerpts',true);
  assert.deepEqual(await js("[...document.querySelectorAll('#insight-preview .evidence-card p')].map(e=>e.textContent)"),expected);check('InsightReport renders both exact host excerpts',true);
  await js("document.querySelector('#answer-preview .citation').click();document.querySelector('#insight-preview .evidence-card').click()");
  assert.deepEqual(await js('window.__opened'),[first.id,first.id]);check('both renderer citation controls retain the original evidence ID',true);
  for(const [label,width] of [['desktop',1280],['mobile',430]]){
    window.setSize(width,1100);await delay(100);
    check(label+' has no horizontal overflow',await js('document.documentElement.scrollWidth<=innerWidth'));
    const path=join(output,label+'.png');writeFileSync(path,(await window.webContents.capturePage()).toPNG());report.screenshots.push(path);
    if(label==='mobile'){
      await js("document.querySelector('#insight-preview .report-evidence').scrollIntoView({block:'start',behavior:'instant'})");await delay(100);
      const bottom=join(output,'mobile-insight.png');writeFileSync(bottom,(await window.webContents.capturePage()).toPNG());report.screenshots.push(bottom);
    }
  }
  report.codeHashes=Object.fromEntries(['packages/agent/dist/evidence-ledger.js','packages/agent/dist/bridge.js','packages/shared/dist/source-presentation.js','apps/web/src/shell-components.tsx','apps/web/src/InsightReport.tsx'].map(p=>[p,createHash('sha256').update(readFileSync(join(repo,p))).digest('hex')]));
  report.passed=true;
}
run().catch(error=>{report.error=String(error);process.exitCode=1;console.error(error);}).finally(()=>{writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({passed:report.passed,report:join(output,'report.json')}));window?.destroy();rmSync(temporary,{recursive:true,force:true});app.exit(process.exitCode||0);});
