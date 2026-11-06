require('../../../scripts/fixture-background.cjs');
const {app,BrowserWindow}=require('electron');
const {build}=require('esbuild');
const {createServer}=require('node:http');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const assert=require('node:assert/strict');

const repository=resolve(__dirname,'../../..');
const temporary=mkdtempSync(join(tmpdir(),'mote-browser-log-test-'));
app.setPath('userData',join(temporary,'browser'));
let server,window;
async function run(){
  const result=await build({stdin:{resolveDir:join(repository,'apps/web/src'),sourcefile:'log-fixture.tsx',loader:'tsx',contents:`
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {BrowserLogSettings} from './BrowserLogSettings';
    import {RuntimeSettings} from './RuntimeSettings';
    import {initializeBrowserLogging,saveBrowserLogPolicy,readBrowserLogPolicy,log} from './logger';
    import {readStoredBrowserLogs} from './browser-log-store';
    for (const level of ['debug','info','warn','error'] as const) console[level]=()=>{};
    Object.assign(window,{initializeBrowserLogging,saveBrowserLogPolicy,readBrowserLogPolicy,log,readStoredBrowserLogs});
    initializeBrowserLogging('prod');
    createRoot(document.getElementById('root')!).render(<BrowserLogSettings profile="prod"/>);
    let central={enabled:true,debug:true,traceEnabled:true,level:'info',revision:1};
    const api={request:async (_path:string,init?:RequestInit)=>{if(init?.method==='PUT')central={...JSON.parse(String(init.body)),revision:central.revision+1};return central;}};
    Object.assign(window,{readCentral:()=>central});
    createRoot(document.getElementById('central')!).render(<RuntimeSettings api={api as never} kind="diagnostics"/>);
  `},bundle:true,format:'iife',platform:'browser',write:false});
  const script=result.outputFiles[0].text;
  server=createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end('<!doctype html><html><body><div id="root"></div><div id="central"></div><script>'+script+'</script></body></html>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await app.whenReady();
  window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await window.loadURL(`http://127.0.0.1:${server.address().port}/`);
  const runJS=code=>window.webContents.executeJavaScript(code);
  await runJS(`new Promise(resolve=>{const check=()=>document.querySelector('.runtime-settings select')?resolve():setTimeout(check,10);check();})`);
  const central=await runJS(`(async()=>{
    await new Promise(resolve=>{const check=()=>document.querySelector('#central select')?resolve():setTimeout(check,10);check();});
    const select=document.querySelector('#central select');const effective=select.value;
    select.value='warn';select.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(resolve=>requestAnimationFrame(()=>resolve()));
    document.querySelector('#central form').requestSubmit();
    await new Promise(resolve=>{const check=()=>readCentral().level==='warn'?resolve():setTimeout(check,10);check();});
    return {effective,settings:readCentral()};
  })()`);
  assert.equal(central.effective,'debug');
  assert.deepEqual(central.settings,{enabled:true,debug:false,traceEnabled:true,level:'warn',revision:2});
  const first=await runJS(`(async()=>{
    log('api.request_started','debug');
    log('api.request_completed','info',{route:'files',status:200});
    const select=document.querySelector('.runtime-settings select');
    select.value='debug';select.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(resolve=>requestAnimationFrame(()=>resolve()));
    document.querySelector('.runtime-settings button').click();
    log('api.request_started','debug',{route:'files'});
    document.querySelector('.runtime-settings input[type=checkbox]').click();
    await new Promise(resolve=>requestAnimationFrame(()=>resolve()));
    document.querySelector('.runtime-settings button').click();
    log('api.request_failed','error');
    return readStoredBrowserLogs();
  })()`);
  assert.deepEqual(first.map(row=>row.event),['api.request_completed','api.request_started']);
  const loaded=new Promise(resolve=>window.webContents.once('did-finish-load',resolve));
  window.reload();await loaded;
  const reopened=await runJS(`(async()=>{initializeBrowserLogging('prod');return {policy:readBrowserLogPolicy(),rows:await readStoredBrowserLogs()};})()`);
  assert.deepEqual(reopened.policy,{enabled:false,level:'debug'});
  assert.equal(reopened.rows.length,2);
  const rotation=await runJS(`(async()=>{
    saveBrowserLogPolicy({enabled:true,level:'info'});
    for(let i=0;i<2010;i++){log('api.request_completed','info',{elapsedMs:i});if(i%200===199)await readStoredBrowserLogs();}
    return readStoredBrowserLogs();
  })()`);
  assert.equal(rotation.length,2000);
  assert.equal(rotation[0].elapsedMs,10);
  assert.equal(rotation.at(-1).elapsedMs,2009);
  console.log('Browser logging persisted settings and bounded events across reload.');
}
async function finish(code){
  if(window&&!window.isDestroyed())window.destroy();
  if(server)await new Promise(resolve=>server.close(resolve));
  rmSync(temporary,{recursive:true,force:true});
  app.exit(code);
}
run().then(()=>finish(0)).catch(error=>{console.error(error);void finish(1);});
