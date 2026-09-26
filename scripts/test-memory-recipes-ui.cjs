require('./fixture-language.cjs');
/** Real renderer and owner API; generated sources, no personal data or model. */
const {app,BrowserWindow}=require('electron');
const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os'),{join,resolve}=require('node:path'),{pathToFileURL}=require('node:url');
const {spawn}=require('node:child_process'),{randomBytes}=require('node:crypto'),assert=require('node:assert/strict');
const repo=resolve(__dirname,'..'),root=mkdtempSync(join(tmpdir(),'mote-memory-recipes-ui-'));
const out=resolve(process.env.MOTE_RECIPE_UI_OUTPUT||join(repo,'.mote/memory-recipes-ui'));mkdirSync(out,{recursive:true});
app.setPath('userData',join(root,'browser'));app.on('window-all-closed',()=>{});
let server,window;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await delay(80);}throw Error('Timeout: '+label);}
async function run(){
  await app.whenReady();const token=randomBytes(32).toString('hex'),runner=join(root,'server.mjs'),ready=join(root,'ready');
  const config={dataDir:join(root,'data'),token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
  writeFileSync(runner,`import {buildApp} from ${JSON.stringify(pathToFileURL(join(repo,'apps/server/dist/app.js')).href)};import {writeFileSync} from 'node:fs';
const node=await buildApp(${JSON.stringify(config)},{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('Fixture must not invoke a model');},close:async()=>{}}});
for(const id of ['diary','coding'])node.sources.register({id,name:'Generated '+id,kind:'custom',deviceId:'fixture',platform:'import'});
await node.app.listen({host:'127.0.0.1',port:0});writeFileSync(${JSON.stringify(ready)},node.app.server.address().port.toString());process.once('SIGTERM',async()=>{await node.app.close();process.exit(0);});`,{mode:0o600});
  server=spawn(process.execPath,[runner],{cwd:repo,env:{...Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]])),ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','ignore','pipe']});
  let stderr='';server.stderr.on('data',c=>stderr+=c);
  await until(()=>{if(server.exitCode!==null)throw Error(stderr);return existsSync(ready);},'fixture server');
  const url='http://127.0.0.1:'+readFileSync(ready,'utf8');
  const request=async path=>{const response=await fetch(url+path,{headers:{Authorization:'Bearer '+token}});assert.equal(response.ok,true);return response.json();};
  const view=source=>request('/api/memory-recipe-settings'+(source?'?sourceId='+source:''));
  window=new BrowserWindow({width:1280,height:1000,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  const wc=window.webContents,js=s=>wc.executeJavaScript(s);
  const click=text=>until(()=>js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true;})()`),'button '+text);
  const checkbox=label=>js(`(()=>{const l=[...document.querySelectorAll('.memory-recipe-selection label')].find(l=>l.textContent.includes(${JSON.stringify(label)}));const e=l?.querySelector('input');if(!e||e.disabled)throw Error('Unavailable checkbox');e.click();})()`);
  const selected=label=>js(`(()=>{const l=[...document.querySelectorAll('.memory-recipe-selection label')].find(l=>l.textContent.includes(${JSON.stringify(label)}));return l?.querySelector('input')?.checked;})()`);
  const source=value=>js(`(()=>{const e=document.querySelector('.memory-recipe-selection select');if(!e||e.disabled)throw Error('Unavailable source selector');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const open=async()=>{await click('系统管理');await click('模型与服务');await until(()=>js(`!![...document.querySelectorAll('.preference-menu-row')].find(b=>b.querySelector('strong')?.textContent==='模块与模型')`),'modules entry');await js(`[...document.querySelectorAll('.preference-menu-row')].find(b=>b.querySelector('strong')?.textContent==='模块与模型').click()`);await until(()=>js(`!!document.querySelector('.memory-recipe-selection form')`),'recipe editor');};
  const screenshot=async name=>{await js(`document.querySelector('.memory-recipe-selection').scrollIntoView({block:'start',behavior:'instant'})`);await delay(150);assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true,'horizontal overflow');writeFileSync(join(out,name+'.png'),(await wc.capturePage()).toPNG());};
  await window.loadURL(url);await js(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({token}))});location.reload()`);await open();
  assert.equal(await selected('个人记忆 · 版本 2'),true);assert.equal(await selected('编码经验'),false);
  await checkbox('编码经验');assert.equal(await js(`document.querySelector('.memory-recipe-selection select').disabled`),true,'dirty selection prevents losing edits');
  await click('保存组合');await until(async()=> (await view()).items.length===2,'saved default');await until(()=>js(`!document.querySelector('.memory-recipe-selection select').disabled`),'save settled');
  await source('coding');await until(()=>selected('跟随默认组合'),'inherited selection');await checkbox('跟随默认组合');await checkbox('个人记忆 · 版本 2');await click('保存组合');
  await until(async()=>{const v=await view('coding');return !v.inherited&&v.items.length===1&&v.items[0].binding.recipe.id==='mote.coding-memory';},'source override');
  assert.equal((await view()).items.length,2,'source override preserves default');await screenshot('source-override-desktop');window.setSize(430,1000);await screenshot('source-override-mobile');window.setSize(1280,1000);
  await window.loadURL(url);await open();await source('coding');await until(()=>js(`!![...document.querySelectorAll('.memory-recipe-selection label')].find(l=>l.textContent.includes('跟随默认组合'))&&!document.querySelector('.memory-recipe-selection input').checked`),'persisted override');
  assert.equal(await selected('个人记忆 · 版本 2'),false);assert.equal(await selected('编码经验'),true);
  await checkbox('跟随默认组合');await click('保存组合');await until(async()=> (await view('coding')).inherited,'restored inheritance');await until(()=>js(`!document.querySelector('.memory-recipe-selection select').disabled`),'inheritance settled');
  await source('');await until(()=>js(`![...document.querySelectorAll('.memory-recipe-selection label')].some(l=>l.textContent.includes('跟随默认组合'))`),'default editor');
  await checkbox('个人记忆 · 版本 2');await checkbox('编码经验');await click('保存组合');await until(async()=> (await view()).items.length===0,'disabled automatic recipes');
  assert.equal((await request('/api/memory-jobs')).items.length,0,'settings changes never create historical work');
  assert.equal((await view('diary')).items.length,0,'untouched source inherits default');
  const result={passed:true,checks:['default multi-selection','unsaved edits protected','source override','reload persistence','restore inheritance','empty selection','no history jobs','desktop and mobile layout'],personalDataUsed:false,liveModel:false,screenshots:out};
  writeFileSync(join(out,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
run().catch(async error=>{console.error(error);if(window){writeFileSync(join(out,'failure.png'),(await window.webContents.capturePage()).toPNG());console.error((await window.webContents.executeJavaScript('document.body.innerText')).slice(-4500));}process.exitCode=1;}).finally(async()=>{
  window?.destroy();if(server?.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('close',r)),delay(3000)]);if(server.exitCode===null)server.kill('SIGKILL');}
  rmSync(root,{recursive:true,force:true});app.exit(process.exitCode||0);
});
