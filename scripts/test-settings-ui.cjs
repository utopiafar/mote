require('./fixture-language.cjs');
/** Real browser + isolated central node. All providers and 400 tasks are generated fixtures. */
const {app,BrowserWindow}=require('electron');
const {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os'),{resolve,join}=require('node:path'),{spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const repo=resolve(__dirname,'..'),root=mkdtempSync(join(tmpdir(),'mote-settings-ui-')),out=join(repo,'.mote/settings-ui');
mkdirSync(out,{recursive:true});app.setPath('userData',join(root,'browser'));app.on('window-all-closed',()=>{});
let server,window;const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+25000;while(Date.now()<end){if(await fn())return;await delay(80);}throw Error('Timed out: '+label);}
async function run(){
 await app.whenReady();const connectionFile=join(root,'connection.json');
 server=spawn(process.execPath,[join(repo,'scripts/operations-fixture-server.mjs'),connectionFile],{cwd:repo,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','ignore','pipe']});let failure='';server.stderr.on('data',b=>failure+=b);
 await until(()=>{if(server.exitCode!==null)throw Error(failure);return existsSync(connectionFile);},'fixture node');
 const {url,token}=JSON.parse(readFileSync(connectionFile,'utf8'));
 const read=async path=>{const response=await fetch(url+path,{headers:{Authorization:'Bearer '+token}});assert(response.ok);return response.json();};
 for(let i=0;i<15;i++){
  const view=await read('/api/model-settings'),id=view.profiles[0].id;
  const response=await fetch(url+'/api/model-settings/profiles/'+encodeURIComponent(id)+'/copy',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({revision:view.revision,id:'generated-provider-'+i,name:'合成预设 '+(i+1)+' · 日常整理',includeCredentials:false})});assert(response.ok);
 }
 window=new BrowserWindow({width:1360,height:1000,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
 const wc=window.webContents,errors=[];wc.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message);});
 const js=code=>wc.executeJavaScript(code);
 const click=label=>until(()=>js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&(b.textContent.trim()===${JSON.stringify(label)}||b.querySelector('strong')?.textContent===${JSON.stringify(label)}));if(!b||b.disabled)return false;b.click();return true;})()`),'button '+label);
 const select=async(label,value)=>js(`(()=>{const s=document.querySelector('select[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');if(!s)throw Error('Missing select '+${JSON.stringify(label)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(value)});s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 const screenshot=async name=>{await delay(100);await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');assert(await js('document.documentElement.scrollWidth<=innerWidth'),'page overflow: '+name);writeFileSync(join(out,name+'.png'),(await wc.capturePage()).toPNG());};
 const backCount=()=>js(`[...document.querySelectorAll('.content .back-link')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden').length`);
 const open=async(route,title)=>{await js(`location.hash=${JSON.stringify('#/'+route)}`);await until(()=>js(`document.querySelector('.content h1')?.textContent===${JSON.stringify(title)}&&!document.querySelector('.content [role="status"]')?.textContent.includes('正在读取')`),'route '+route);};
 await window.loadURL(url);await js(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({token,viewScope:require('node:crypto').randomUUID()}))});location.reload()`);await until(()=>js(`document.body.innerText.includes('已登录 ·')`),'generated login');
 const routes=[['preferences','设置','settings'],['system/models','模型与服务','models'],['system/processing','处理任务','processing'],['system','统计中心','statistics'],['system/usage','用量与费用','usage'],['system/storage','存储与索引','storage'],['system/diagnostics','诊断与更新','diagnostics'],['system/extensions','功能插件','extensions'],['connections/lark','飞书','lark'],['connections/recordings','录音归档','recordings'],['help','帮助与反馈','help']];
 for(const [route,title,name] of routes){
  await open(route,title);await delay(250);
  assert.equal(await backCount(),route==='preferences'?0:1,'one parent control: '+name);
  assert.equal(await js(`document.querySelectorAll('.content h1').length`),1,'one page heading: '+name);
  await screenshot(name+'-desktop');window.setSize(390,844);await screenshot(name+'-mobile');window.setSize(1360,1000);
 }
 await open('system/models','模型与服务');
 for(const [title,name] of [['模型 Provider','providers'],['模块与模型','assignments'],['文件与语音','files'],['保留与容量','retention'],['检索索引','index'],['来源与外部应用','connectors']]){
  await click(title);await until(()=>js(`document.querySelector('.server-settings h1')?.textContent===${JSON.stringify(title)}`),'category '+title);await delay(250);
  assert.equal(await backCount(),1,'single category parent control');
  if(name==='providers')assert(await js(`getComputedStyle(document.querySelector('.provider-card[aria-pressed=true]')).backgroundColor===getComputedStyle(document.documentElement).getPropertyValue('--mote-tint').trim()||getComputedStyle(document.querySelector('.provider-card[aria-pressed=true]')).backgroundColor==='rgb(232, 238, 252)'`),'provider uses workspace tint');
  await screenshot(name+'-desktop');window.setSize(390,844);await screenshot(name+'-mobile');window.setSize(320,760);await screenshot(name+'-narrow');window.setSize(1360,1000);
  await click('返回上级');await until(()=>js(`document.querySelector('.server-settings h1')?.textContent==='模型与服务'`),'category parent');
 }
 await click('返回上级');await until(()=>js(`location.hash==='#/preferences'`),'models parent is settings');
 await open('system/processing','处理任务');await until(()=>js(`document.querySelectorAll('.operation-row').length===10`),'ten initial tasks');
 const ids=()=>js(`[...document.querySelectorAll('.operation-title code')].map(e=>e.textContent)`);
 const first=await ids();await click('下一页');await until(()=>js(`document.querySelector('[aria-label="任务分页"]').textContent.includes('第 2 页')&&document.querySelectorAll('.operation-row').length===10`),'second page');const second=await ids();assert(first.every(id=>!second.includes(id)));
 await click('下一页');await until(()=>js(`document.querySelector('[aria-label="任务分页"]').textContent.includes('第 3 页')&&document.querySelectorAll('.operation-row').length===10`),'third page');await click('上一页');await until(async()=>JSON.stringify(await ids())===JSON.stringify(second),'previous returns to page two');
 await select('任务状态','blocked');await until(()=>js(`document.querySelectorAll('.operation-row').length===1&&document.querySelector('[aria-label="任务分页"]').textContent.includes('第 1 页')`),'filter resets cursor');
 await js(`document.querySelector('.operation-row button').focus();document.querySelector('.operation-row button').click()`);await until(()=>js(`!!document.querySelector('[role="dialog"] .processing-row')`),'on-demand detail');
 assert(await js(`document.querySelector('[role="dialog"]').contains(document.activeElement)`),'detail owns focus');await screenshot('processing-detail-desktop');window.setSize(390,844);await screenshot('processing-detail-mobile');window.setSize(1360,1000);
 await js(`document.querySelector('[role="dialog"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);await until(()=>js(`!document.querySelector('[role="dialog"]')`),'escape dismisses detail');assert(await js(`document.activeElement.matches('.operation-row button')`),'close restores row focus');
 await select('任务状态','');await select('每页条数','20');await until(()=>js(`document.querySelectorAll('.operation-row').length===20&&document.querySelector('[aria-label="任务分页"]').textContent.includes('第 1 页')`),'page size resets cursor');
 await select('任务类型','capture');await until(()=>js(`document.querySelector('.empty h2')?.textContent==='没有符合条件的任务'`),'empty filtered view');window.setSize(390,844);await screenshot('processing-empty-mobile');window.setSize(1360,1000);await select('任务类型','');await select('每页条数','10');await until(()=>js(`document.querySelectorAll('.operation-row').length===10`),'restore list');
 window.setSize(390,844);await screenshot('processing-mobile');window.setSize(1360,1000);wc.setZoomFactor(2);await screenshot('processing-200-percent');wc.setZoomFactor(1);
 await js(`document.querySelector('.processing-advanced').open=true`);await until(()=>js(`!!document.querySelector('[aria-label="上下文任务状态"]')`),'lazy advanced view');assert.equal(await js(`document.querySelectorAll('.content h1').length`),1,'advanced steps have no duplicate page title');
 await js(`window.confirm=()=>true;true;`);await select('界面语言','en');
 await until(()=>js(`document.querySelector('.content h1')?.textContent==='Processing tasks'`),'English processing');await until(()=>js(`document.querySelectorAll('.operation-row').length===10`),'English tasks');
 await screenshot('processing-english-desktop');window.setSize(390,844);await screenshot('processing-english-mobile');
 await open('system/models','Models & services');await click('Model providers');await until(()=>js(`!!document.querySelector('.provider-sidebar')`),'English providers');await screenshot('providers-english-mobile');window.setSize(1360,1000);
 assert.equal(errors.length,0,'renderer console errors: '+errors.join('\n'));
 const report={ok:true,fixtureTasks:400,generatedProviders:16,routes:routes.map(r=>r[0]),categories:6,checks:['single parent navigation','shared palette','320/390/1360px layouts','200% zoom','ten row default','previous page cursor history','filter and size reset','empty state','detail focus/Escape/restore','lazy advanced steps','English layout'],screenshots:out};
 writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
run().catch(async error=>{console.error(error);if(window){writeFileSync(join(out,'failure.png'),(await window.webContents.capturePage()).toPNG());console.error((await window.webContents.executeJavaScript('document.body.innerText')).slice(-2500));}process.exitCode=1;}).finally(async()=>{window?.destroy();if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('exit',r)),delay(2000)]);if(server.exitCode===null)server.kill('SIGKILL');}rmSync(root,{recursive:true,force:true});app.exit(process.exitCode||0);});
