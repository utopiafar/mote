require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');
const {app,BrowserWindow}=require('electron');
const {mkdtempSync,writeFileSync,readFileSync,mkdirSync}=require('node:fs');
const {rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const assert=require('node:assert/strict');
const {defaultConfig}=require('../dist/config');
const fixture=JSON.parse(readFileSync(process.argv[2],'utf8'));
assert.equal(new URL(fixture.url).hostname,'127.0.0.1');
const profile=mkdtempSync(join(tmpdir(),'mote-desktop-conversation-ui-'));
app.setPath('userData',profile);process.env.MOTE_PROFILE='dev';
delete process.env.MOTE_URL;delete process.env.MOTE_TOKEN;delete process.env.MOTE_ENV_FILE;
const dataDirectory=join(profile+'-profiles','dev');mkdirSync(dataDirectory,{recursive:true,mode:0o700});
writeFileSync(join(dataDirectory,'config.json'),JSON.stringify({version:4,developmentToken:fixture.token,config:{...defaultConfig(),serverUrl:fixture.url,credentialScope:'owner',metadataEnabled:false,deviceName:'Generated conversation client'}}),{mode:0o600});
writeFileSync(join(dataDirectory,'storage-format.json'),JSON.stringify({version:4}),{mode:0o600});
// Replace only the OS browser launch; the ticket, URL, Web renderer and reader stay real.
const child=require('node:child_process'),nativeExec=child.execFile;let openedUrl;
child.execFile=function(file,args,...rest){if(file==='/usr/bin/open'){openedUrl=args.at(-1);rest.at(-1)(null,'','');return {};}return nativeExec.call(this,file,args,...rest);};
const out=resolve(__dirname,'../.mote/scope-ui');mkdirSync(out,{recursive:true});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));let main;
const timeout=setTimeout(()=>{console.error('Scope UI timed out');app.exit(1);},120000);
app.on('browser-window-created',(_event,window)=>{
 if(main)return;main=window;
 window.webContents.once('did-finish-load',()=>void(async()=>{
 const js=code=>window.webContents.executeJavaScript(code);
 const until=async(condition,label)=>{const deadline=Date.now()+20000;while(!await condition()){assert.ok(Date.now()<deadline,label);await delay(30);}};
 const headers={authorization:'Bearer '+fixture.token,'content-type':'application/json'};
 const api=async(path,body)=>{const r=await fetch(fixture.url+path,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});assert.ok(r.ok,await r.clone().text());return r.json();};
 const read=kind=>api('/api/conversations/'+fixture.ids[kind]);
 const select=async kind=>{
  await js(`document.querySelector('#ask-refresh').click()`);
  await until(()=>js(`!document.querySelector('#ask-new').disabled`),'Mac history ready');
  await js(`([...document.querySelectorAll('#ask-history button')].find(b=>b.textContent==='Generated ${kind}')).click()`);
  await until(()=>js(`!document.querySelector('#ask-new').disabled&&document.querySelectorAll('#ask-messages article').length>0`),'Mac selected '+kind);
 };
 const scope=()=>js(`document.querySelector('#ask-scope').innerText`);
 await until(()=>js(`Boolean(document.querySelector('[data-nav="ask"]'))&&!document.querySelector('#settings-fields').disabled`),'desktop ready');
 await js(`document.querySelector('[data-nav="ask"]').click()`);
 const web=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{partition:'scope-generated-web',contextIsolation:true,sandbox:true,nodeIntegration:false}});
 const wjs=code=>web.webContents.executeJavaScript(code);
 for(const kind of ['anchor','strict']){
  await select(kind);
  const expected=kind==='strict'?'严格范围：只查询以下记录':'参考记录：可自动查找其他已授权内容';
  assert.ok((await scope()).includes(expected));
  await js(`document.querySelector('#ask-question').value='Generated retained draft'`);
  if(kind==='anchor'){
   await js(`document.querySelector('#ask-turns-more').click();document.querySelector('#ask-turns-more').click()`);
   await until(()=>js(`document.querySelectorAll('#ask-messages article').length===21&&!document.querySelector('#ask-new').disabled`),'scope paging');assert.ok((await scope()).includes(expected));
  }
  openedUrl=undefined;await js(`document.querySelector('#ask-scope button').click()`);
  await until(()=>Boolean(openedUrl),'original IPC navigation');
  const parsed=new URL(openedUrl),params=new URLSearchParams(parsed.hash.split('?')[1]);
  assert.equal(params.get('evidence'),'capture:'+fixture.evidenceIds[kind==='anchor'?0:1]);
  await web.loadURL(openedUrl);
  await until(()=>wjs(`document.body.innerText.includes('Generated scope original ${kind==='anchor'?0:1}')`),'real authorized original');
  assert.equal(await js(`document.querySelector('#ask-question').value`),'Generated retained draft');
  await select(kind);
  const before=(await read(kind)).turnCount;
  await js(`document.querySelector('#ask-question').value='Mac ${kind} continuation';document.querySelector('#ask-form').requestSubmit();document.querySelector('#ask-form').requestSubmit()`);
  await until(async()=>(await read(kind)).turnCount===before+1,'Mac '+kind+' committed');
  await until(()=>js(`document.querySelector('#ask-progress').innerText.includes('回答已完成')&&!document.querySelector('#ask-send').disabled`),'Mac completed');
  await wjs(`location.hash='#/ask'`);
  // Close evidence overlay through its real control if the route retains it.
  await wjs(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='关闭');b?.click()})()`);
  await until(()=>wjs(`document.querySelectorAll('.conversation-item').length===3`),'Web history');
  await wjs(`([...document.querySelectorAll('.conversation-item')].find(b=>b.textContent.includes('Generated ${kind}'))).click()`);
  await until(()=>wjs(`document.querySelectorAll('.conversation-turn').length>0&&document.querySelector('[aria-label="向 Mote 提问"]')&&!document.querySelector('[aria-label="向 Mote 提问"]').disabled`),'Web conversation');
  assert.ok(await wjs(`Boolean(document.querySelector('nav[aria-label="${kind==='anchor'?'参考记录':'查询范围'}"]'))`));
  await wjs(`(()=>{const e=document.querySelector('[aria-label="向 Mote 提问"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Web ${kind} continuation');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wjs(`document.querySelector('[aria-label="发送问题"]').click()`);
  await until(async()=>(await read(kind)).turnCount===before+2,'Web '+kind+' committed');
  await js(`document.querySelector('#ask-question').value='Generated retained draft';document.querySelector('#ask-refresh').click()`);
  await until(()=>js(`document.querySelector('#ask-messages').innerText.includes('Web ${kind} continuation')&&!document.querySelector('#ask-new').disabled`),'Mac refresh sees Web');
  assert.ok((await scope()).includes(expected));assert.equal(await js(`document.querySelector('#ask-question').value`),'Generated retained draft');
  await new Promise(resolve=>{web.webContents.once('did-finish-load',resolve);web.webContents.reload();});
  await until(()=>wjs(`Boolean(document.querySelector('nav[aria-label="${kind==='anchor'?'参考记录':'查询范围'}"]'))`),'Web reload scope');
  writeFileSync(join(out,kind+'-mac.png'),(await window.webContents.capturePage()).toPNG());
  writeFileSync(join(out,kind+'-web.png'),(await web.webContents.capturePage()).toPNG());
 }
 const seen=await api('/fixture/seen');
 for(const origin of ['Mac','Web'])for(const kind of ['anchor','strict']){
  const calls=seen.filter(x=>x.question===origin+' '+kind+' continuation');assert.equal(calls.length,1);
  assert.deepEqual(calls[0][kind==='anchor'?'anchorEvidenceIds':'evidenceIds'],[fixture.evidenceIds[kind==='anchor'?0:1]]);
  assert.equal(calls[0][kind==='anchor'?'evidenceIds':'anchorEvidenceIds'],undefined);
 }
 await api('/api/query',{conversationId:fixture.ids.strict,question:'Other client changes scope',anchorEvidenceIds:[fixture.evidenceIds[0]]});
 await js(`document.querySelector('#ask-refresh').click()`);
 await until(()=>js(`document.querySelector('#ask-scope').innerText.includes('参考记录：')&&!document.querySelector('#ask-new').disabled`),'changed snapshot');
 assert.equal(await js(`document.querySelector('#ask-question').value`),'Generated retained draft');
 for(const status of [503,403]){
  await fetch(fixture.url+'/fixture/fail',{method:'POST',headers:{...headers,'x-fixture-status':String(status)}});
  await js(`document.querySelector('#ask-refresh').click()`);
  await until(()=>js(`document.querySelector('#ask-error').innerText.length>0&&!document.querySelector('#ask-new').disabled`),'unavailable read');
  if(status===503)assert.ok((await scope()).includes('暂不可用'));assert.equal(await js(`document.querySelectorAll('#ask-scope button').length`),0);
  assert.equal(await js(`document.querySelector('#ask-question').value`),'Generated retained draft');
  if(status===403){
   await js(`document.querySelector('#ask-token').value=${JSON.stringify(fixture.token)};document.querySelector('#ask-login').click()`);
   await until(()=>js(`document.querySelectorAll('#ask-history button').length===3&&!document.querySelector('#ask-new').disabled`),'explicit relogin');
   await select('strict');
  }else await js(`document.querySelector('#ask-refresh').click()`);
  await until(()=>js(`document.querySelector('#ask-scope').innerText.includes('参考记录：')&&!document.querySelector('#ask-new').disabled`),'scope retry');
 }
 await select('plain');assert.ok((await scope()).includes('未额外限定记录'));
 await select('anchor');await js(`document.querySelector('#ask-new').click()`);assert.equal(await js(`document.querySelectorAll('#ask-scope button').length`),0);
 await select('strict');await js(`document.querySelector('#ask-logout').click()`);
 await until(()=>js(`document.querySelectorAll('#ask-history button').length===0&&!document.querySelector('#ask-new').disabled`),'logout clears');assert.equal(await js(`document.querySelectorAll('#ask-scope button').length`),0);
 writeFileSync(join(out,'result.json'),JSON.stringify({passed:true,actualMacRendererPreloadIpc:true,actualWebRenderer:true,actualHttpSqlite:true,model:'generated only',osBrowserLaunch:'redirected to isolated hidden BrowserWindow',checks:['anchor and strict same-ID Mac-Web continuation','exact original IDs and authorized real reader','one admission after duplicate submit','current scope after older page and other-client change','refresh preserves drafts','Web reload restores scopes','simulated 503/403 clears stale labels and retry restores scope','plain/new/logout removes labels']},null,2));
 web.destroy();clearTimeout(timeout);console.log('PASS Mac/Web current scope, originals, continuation and recovery');app.exit(0);
 })().catch(error=>{console.error(error);clearTimeout(timeout);app.exit(1);}));
});
app.on('quit',()=>{void rm(profile,{recursive:true,force:true});void rm(profile+'-profiles',{recursive:true,force:true});});
require('../dist/main');
