/** Source-only browser regression: generated Markdown, no archive or model service. */
const {app,BrowserWindow}=require('electron');
const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const repo=resolve(__dirname,'..'),root=mkdtempSync(join(tmpdir(),'mote-markdown-'));
const out=join(repo,'.mote/markdown-ui');mkdirSync(out,{recursive:true});
app.setPath('userData',join(root,'browser'));app.on('window-all-closed',()=>{});
let server,window;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await delay(60);}throw Error('Timeout: '+label);}
async function run(){
 await app.whenReady();
 const id='11111111-1111-4111-8111-111111111111';
 const markdown=`| Item | Original evidence | Outcome |\n| --- | --- | --- |\n| **Generated plan** | An intentionally synthetic record with a long description [${id}] | Not confirmed |\n| Escaped \\| delimiter | Literal citation in code: \`[${id}]\` | Pending |\n\n| A | B | C | D | E | F |\n| --- | --- | --- | --- | --- | --- |\n| one | two | three | four | five | six |`;
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {AnswerView} from '/src/shell-components.tsx';import '/src/styles.css';const answer=${JSON.stringify({answer:markdown,runId:'generated',trace:[],citations:[{id,appName:'Generated',capturedAt:'2026-01-01T00:00:00Z',excerpt:'Synthetic only'}]})};createRoot(document.getElementById('root')).render(React.createElement('main',{style:{maxWidth:900,margin:'auto',padding:20,minWidth:0}},React.createElement('div',{className:'conversation-content'},React.createElement('div',{className:'conversation-messages'},React.createElement('section',{className:'answer-panel'},React.createElement(AnswerView,{answer,onOpen:ref=>{document.querySelector('output').textContent=ref}})))),React.createElement('output',{'aria-live':'polite',style:{overflowWrap:'anywhere'}})));`;
 const ready=join(root,'ready.json'),runner=join(root,'server.mjs');
 writeFileSync(runner,`import {createServer} from ${JSON.stringify(join(repo,'node_modules/vite/dist/node/index.js'))};import {writeFileSync} from 'node:fs';const id='virtual:mote-markdown-fixture',resolved='\\0'+id;const server=await createServer({configFile:false,root:${JSON.stringify(join(repo,'apps/web'))},cacheDir:${JSON.stringify(join(root,'vite-cache'))},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0},plugins:[{name:'generated-markdown',resolveId(source){if(source===id)return resolved;},load(source){if(source===resolved)return ${JSON.stringify(entry)};},configureServer(s){s.middlewares.use('/__markdown_fixture',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Generated Markdown regression</title></head><body><div id="root"></div><script type="module" src="/@id/virtual:mote-markdown-fixture"></script></body></html>');});}}]});await server.listen();writeFileSync(${JSON.stringify(ready)},JSON.stringify({url:server.resolvedUrls.local[0]+'__markdown_fixture'}));process.on('SIGTERM',async()=>{await server.close();process.exit(0);});`);
 server=spawn('node',[runner],{cwd:repo,stdio:['ignore','ignore','pipe']});let stderr='';server.stderr.on('data',b=>stderr+=b);
 await until(()=>{if(server.exitCode!==null)throw Error(stderr);return existsSync(ready);},'source fixture');
 window=new BrowserWindow({width:430,height:800,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 const wc=window.webContents,js=code=>wc.executeJavaScript(code),errors=[];wc.on('console-message',(_event,level,message)=>{if(level>=3){errors.push(message);console.error(message);}});
 await window.loadURL(JSON.parse(readFileSync(ready)).url);
 await until(()=>js(`document.querySelectorAll('table').length===2`),'semantic tables');
 const measurements=[];
 for(const width of [430,320,1280]){
  window.setContentSize(width,800);await delay(150);
  const geometry=await js(`({width:innerWidth,page:document.documentElement.scrollWidth,regions:[...document.querySelectorAll('.answer-table-scroll')].map(e=>({client:e.clientWidth,scroll:e.scrollWidth,right:e.getBoundingClientRect().right}))})`);
  assert.ok(geometry.page<=geometry.width+1,JSON.stringify(geometry));
  assert.ok(geometry.regions.every(r=>r.right<=geometry.width+1));
  if(width<500)assert.ok(geometry.regions.every(r=>r.scroll>r.client),'wide content scrolls locally');
  measurements.push(geometry);
  await js(`document.querySelector('.answer-table-scroll').focus()`);
  wc.sendInputEvent({type:'keyDown',keyCode:'Right'});wc.sendInputEvent({type:'keyUp',keyCode:'Right'});await delay(180);
  if(width<500)assert.ok(await js(`document.querySelector('.answer-table-scroll').scrollLeft>0`),'keyboard scroll');
 }
 window.setContentSize(430,800);await delay(150);
 const point=await js(`(()=>{const b=document.querySelector('td .inline-citation');b.scrollIntoView({block:'center',inline:'center'});const r=b.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
 wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
 await until(()=>js(`document.querySelector('output').textContent===${JSON.stringify(id)}`),'pointer citation opens original');
 assert.equal(await js(`document.querySelectorAll('td .inline-citation').length`),1,'literal code reference stays code');
 assert.deepEqual(errors,[]);
 writeFileSync(join(out,'mobile.png'),(await wc.capturePage()).toPNG());
 writeFileSync(join(out,'result.json'),JSON.stringify({passed:true,generatedOnly:true,sourceOnly:true,liveModel:false,measurements,checks:['semantic GFM table','no document overflow at 320/430/1280','keyboard local scroll','real pointer citation activation','code and escaped pipes']},null,2));
 console.log('PASS generated Markdown tables: mobile overflow containment, keyboard scrolling and citation activation.');
}
run().catch(async error=>{console.error(error);if(window)writeFileSync(join(out,'failure.png'),(await window.webContents.capturePage()).toPNG());process.exitCode=1;}).finally(async()=>{window?.destroy();if(server?.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('close',r)),delay(3000)]);}rmSync(root,{recursive:true,force:true});app.exit(process.exitCode||0);});
