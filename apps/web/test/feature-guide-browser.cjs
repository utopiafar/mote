require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');
/** Real renderer + isolated server; generated Coding events only, no personal capture. */
const {app,BrowserWindow}=require('electron');
const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');const {join,resolve}=require('node:path');
const {spawn}=require('node:child_process');const {randomBytes}=require('node:crypto');const net=require('node:net');const assert=require('node:assert/strict');
app.on('window-all-closed',()=>{});
const root=mkdtempSync(join(tmpdir(),'mote-guide-browser-')),repo=resolve(__dirname,'../../..'),output=join(repo,'.mote/feature-guide');mkdirSync(output,{recursive:true});app.setPath('userData',join(root,'browser'));
let server,window;const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await delay(100);}throw Error('Timed out: '+label);}
async function port(){return new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
async function run(){
 await app.whenReady();const endpoint='http://127.0.0.1:'+await port(),token=randomBytes(32).toString('hex'),env={...process.env};for(const k of Object.keys(env))if(k.startsWith('MOTE_'))delete env[k];
 const configFile=join(root,'mote.yaml');writeFileSync(configFile,JSON.stringify({version:1,revision:0,server:{profile:'test',host:'127.0.0.1',port:Number(new URL(endpoint).port),token},storage:{dataDir:join(root,'data')}}),{mode:0o600});
 server=spawn('node',[join(repo,'apps/server/dist/index.js')],{cwd:repo,env:{...env,MOTE_CONFIG_FILE:configFile},stdio:['ignore','ignore','pipe']});
 let startupError='';server.stderr.on('data',chunk=>{startupError=(startupError+chunk).slice(-12000);});
 await until(async()=>{if(server.exitCode!==null)throw Error('Fixture server stopped: '+startupError);try{return(await fetch(endpoint+'/api/health')).ok;}catch{return false;}},'server');
 const request=async(path,body)=>{const r=await fetch(endpoint+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Mote-Ingress-Version':'2'},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,`${path}: ${r.status}`);return r.json();};
 window=new BrowserWindow({width:1360,height:1000,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false}});const wc=window.webContents,errors=[];wc.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message);});const js=code=>wc.executeJavaScript(code);
 const browserSession=await request('/api/login/session',{serverUrl:endpoint,deviceId:require('node:crypto').randomUUID(),deviceName:'Generated browser',platform:'other',durationMs:0});
 await window.loadURL(endpoint);await js(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({token:browserSession.token,viewScope:require('node:crypto').randomUUID()}))});location.reload()`);
 await until(()=>js(`document.body.innerText.includes('已登录 ·')`),'authenticated browser');
 const route=async(path,selector)=>{await js(`location.hash=${JSON.stringify('#/'+path)}`);await until(()=>js(`!!document.querySelector(${JSON.stringify(selector)})`),path);};
 const click=async label=>{await until(()=>js(`(()=>{const b=[...document.querySelectorAll('button,a[href]')].find(b=>b.getClientRects().length&&b.textContent.trim()===${JSON.stringify(label)});if(!b)return false;b.click();return true})()`),label);};

 const openGuideUnit=async(id,related=false)=>{
  await route('guide','.feature-guide');
  await js(`(()=>{const unit=document.querySelector('[data-capability-id="${id}"]');for(let p=unit.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;${related?"unit.querySelector('.guide-related').open=true;":""}unit.scrollIntoView({block:'center'});})()`);
  await until(()=>js(`(()=>{const link=document.querySelector('[data-capability-id="${id}"] ${related?'.guide-related a[href="#/activity"]':'> .guide-unit-links a'}');if(!link||!link.getClientRects().length)return false;link.click();link.click();return true})()`),'available Guide destination '+id);
 };
 await openGuideUnit('A15');
 await until(()=>js(`document.querySelector('.coding-uploads')?.textContent.includes('还没有收到 Coding 来源。')`),'Guide reaches honest empty Coding status');
 assert.equal(await js(`!!document.querySelector('.activity-centre')`),false,'Coding status is not replaced by general Activity');
 for(const id of ['C19','C28']){await openGuideUnit(id,true);await until(()=>js(`location.hash==='#/activity'&&!!document.querySelector('.activity-centre')`),'Guide '+id+' reaches current Activity');}
 await request('/api/sources',{id:'fixture-coding',name:'Generated Coding upload',kind:'coding-agent',deviceId:'fixture-device',platform:'macos'});
 const event=i=>({externalId:'event-'+i,revision:'1',observedAt:new Date(Date.now()+i).toISOString(),kind:'message',layer:'original',text:'Generated transcript '+i+': test the everyday plugin flow.',document:{contentRole:'transcript',coding:{version:1,provider:'codex',projectKey:'generated-project',sessionId:'generated-session',eventId:'event-'+i,role:i?'assistant':'user',attribution:i?'agent':'human',channel:i?'final':undefined,part:0,parts:1}}});
 await request('/api/sources/fixture-coding/items/batch',{items:[event(0),event(1),event(2)]});
 await until(async()=>(await request('/api/materials')).items.length===1,'published transcript');

 await openGuideUnit('A15');
 await until(()=>js(`location.hash==='#/library?view=coding-status'&&document.querySelector('.coding-uploads')?.textContent.includes('Generated Coding upload')`),'Guide A15 consumes actual Coding sync status');
 assert.match(await js(`document.querySelector('.coding-uploads').textContent`),/已接收增量事件3/);
 writeFileSync(join(output,'guide-coding-status.png'),(await wc.capturePage()).toPNG());
 await js('history.back()');await until(()=>js(`location.hash==='#/guide'&&!!document.querySelector('.feature-guide')`),'Guide return path');
 await js('history.forward()');await until(()=>js(`document.querySelector('.coding-uploads')?.textContent.includes('Generated Coding upload')`),'Guide Coding forward path');
 await click('查看此来源的会话正文');await until(()=>js(`!!document.querySelector('.library-master .library-record')`),'Guide-linked published material');
 await js(`document.querySelector('.library-master .library-record').click()`);await until(()=>js(`document.querySelector('.material-detail')?.textContent.includes('Generated transcript 2')`),'Guide journey reads the actual published body');
 assert.equal((await request('/api/materials')).items.length,1,'Repeated directory clicks do not create duplicate content');
 assert.deepEqual(errors,[]);
 // Control only network availability/timing. Data, auth and publication remain the real server.
 let failed=false;
 wc.session.webRequest.onBeforeRequest({urls:[endpoint+'/api/coding/uploads*']},(_details,callback)=>{if(!failed){failed=true;callback({cancel:true});}else callback({});});
 await window.loadURL('about:blank');
 await window.loadURL(endpoint+'/#/library?view=coding-status');
 await until(()=>js(`!!document.querySelector('.coding-uploads [role="alert"]')`),'failed Coding read stays an error');
 assert.equal(await js(`document.querySelectorAll('.coding-uploads article').length`),0,'A failed read has no invented receipt count');
 let releaseRead;
 wc.session.webRequest.onBeforeRequest({urls:[endpoint+'/api/coding/uploads*']},(_details,callback)=>{releaseRead=callback;});
 await window.loadURL('about:blank');
 await window.loadURL(endpoint+'/#/library?view=coding-status');
 await until(()=>js(`document.querySelector('.coding-uploads [role="status"]')?.textContent.includes('正在读取同步状态')`),'pending Coding read shows loading');
 await until(()=>Boolean(releaseRead),'held Coding HTTP read');
 assert(releaseRead,'The fixture holds the actual HTTP read');releaseRead({cancel:false});
 await until(()=>js(`document.querySelector('.coding-uploads')?.textContent.includes('Generated Coding upload')`),'actual Coding read recovers after connection returns');
 wc.session.webRequest.onBeforeRequest(null);
 writeFileSync(join(output,'result.json'),JSON.stringify({passed:true,generatedOnly:true,codingEvents:3,checks:['Guide A15 exact Coding status','empty state','Guide C19 and C28 actual Activity','real source ingress and publication','back and forward','original body','duplicate navigation','HTTP failure','loading','network recovery']},null,2));
 console.log('PASS: Guide destinations reach actual registered pages and consume generated Central Coding receipts and originals.');
}
async function finish(code){if(window&&!window.isDestroyed())window.destroy();if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('exit',r)),delay(5000)]);}rmSync(root,{recursive:true,force:true});app.exit(code);}
run().then(()=>finish(0)).catch(async error=>{console.error(error);if(window&&!window.isDestroyed()){console.error(await window.webContents.executeJavaScript(`JSON.stringify({hash:location.hash,headings:[...document.querySelectorAll('h1')].map(e=>e.textContent),alerts:[...document.querySelectorAll('[role=alert],.notice')].map(e=>e.textContent)})`));writeFileSync(join(output,'failure.png'),(await window.webContents.capturePage()).toPNG());}finish(1);});
