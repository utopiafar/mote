require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');
/** Real renderer + isolated server; generated Coding events only, no personal capture. */
const {app,BrowserWindow}=require('electron');
const {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync}=require('node:fs');
const {tmpdir}=require('node:os');const {join,resolve}=require('node:path');
const {spawn,execFileSync}=require('node:child_process');const {randomBytes}=require('node:crypto');const net=require('node:net');const assert=require('node:assert/strict');
app.on('window-all-closed',()=>{});
const root=mkdtempSync(join(tmpdir(),'mote-guide-browser-')),repo=resolve(__dirname,'../../..'),output=join(repo,'.mote/feature-guide');mkdirSync(output,{recursive:true});app.setPath('userData',join(root,'browser'));
let server,window;const delay=ms=>new Promise(r=>setTimeout(r,ms));
const evidence={revision:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),workingTree:Boolean(execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).trim()),generatedOnly:true,realBuiltWeb:true,realCentralHttp:true,modelCalls:0,sourceRendered:false,theme:'light',locale:'zh-CN',screenshots:[]};
async function until(fn,label){const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await delay(100);}throw Error('Timed out: '+label);}
async function port(){return new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
async function run(){
 await app.whenReady();const endpoint='http://127.0.0.1:'+await port(),token=randomBytes(32).toString('hex'),env={...process.env};for(const k of Object.keys(env))if(k.startsWith('MOTE_'))delete env[k];
 const configFile=join(root,'mote.yaml');writeFileSync(configFile,JSON.stringify({version:1,revision:0,server:{profile:'test',host:'127.0.0.1',port:Number(new URL(endpoint).port),token},storage:{dataDir:join(root,'data')}}),{mode:0o600});
 server=spawn(process.env.MOTE_FIXTURE_NODE||'node',[join(repo,'apps/server/dist/index.js')],{cwd:repo,env:{...env,MOTE_CONFIG_FILE:configFile},stdio:['ignore','ignore','pipe']});
 let startupError='';server.stderr.on('data',chunk=>{startupError=(startupError+chunk).slice(-12000);});
 await until(async()=>{if(server.exitCode!==null)throw Error('Fixture server stopped: '+startupError);try{return(await fetch(endpoint+'/api/health')).ok;}catch{return false;}},'server');
 const request=async(path,body)=>{const r=await fetch(endpoint+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Mote-Ingress-Version':'2'},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,`${path}: ${r.status}`);return r.json();};
 window=new BrowserWindow({width:1440,height:1000,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false}});const wc=window.webContents,errors=[];wc.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message);});const js=code=>wc.executeJavaScript(code);
 const browserSession=await request('/api/login/session',{serverUrl:endpoint,deviceId:require('node:crypto').randomUUID(),deviceName:'Generated browser',platform:'other',durationMs:0});
 await window.loadURL(endpoint);await js(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({token:browserSession.token,viewScope:require('node:crypto').randomUUID()}))});location.reload()`);
 await until(()=>js(`document.querySelector('.content')?.dataset.session==='ready'`),'authenticated browser');
 wc.debugger.attach('1.3');await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 const route=async(path,selector)=>{await js(`location.hash=${JSON.stringify('#/'+path)}`);await until(()=>js(`!!document.querySelector(${JSON.stringify(selector)})`),path);};
 const click=async label=>{await until(()=>js(`(()=>{const b=[...document.querySelectorAll('button,a[href]')].find(b=>b.getClientRects().length&&b.textContent.trim()===${JSON.stringify(label)});if(!b)return false;b.click();return true})()`),label);};
 const input=async value=>{await js(`(()=>{const input=document.querySelector('.guide-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(50);};
 const snap=async name=>{await delay(70);const meta=await js(`({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth})`);assert.equal(meta.overflow,false,name);const png=(await wc.capturePage()).toPNG();writeFileSync(join(output,name+'.png'),png);evidence.screenshots.push({file:name+'.png',...meta,pngWidth:png.readUInt32BE(16),pngHeight:png.readUInt32BE(20),createdAt:new Date().toISOString()});};

 const openGuideUnit=async(id)=>{
  await route('guide','.feature-guide');
  await input('');
  await js(`(()=>{const unit=document.querySelector('[data-capability-id="${id}"]');const group=unit.closest('details');if(!group.open)group.querySelector('summary').click();unit.scrollIntoView({block:'center'});})()`);
  await until(()=>js(`(()=>{const link=document.querySelector('[data-capability-id="${id}"] a.guide-unit-link');if(!link||!link.getClientRects().length)return false;link.click();link.click();return true})()`),'available Guide destination '+id);
 };
 await route('guide','.feature-guide');await until(()=>js(`document.querySelector('[data-capability-id="A15"] a.guide-unit-link')`),'verified Guide capabilities');
 assert.equal(await js(`document.querySelectorAll('[data-guide-group]').length`),16);assert.equal(await js(`document.querySelectorAll('[data-capability-id]').length`),77);assert.equal(await js(`document.querySelectorAll('.guide-group[open]').length`),0);await snap('guide-wide-default');
 await js(`document.querySelector('[data-guide-group="G05"] summary').click()`);await snap('guide-wide-expanded');
 await input('随手记');await snap('guide-wide-search');await js(`document.querySelector('[data-capability-id="C12"] a').click()`);await until(()=>js(`!!document.querySelector('.quick-note-dialog')`),'Guide note opens existing global editor');
 wc.sendInputEvent({type:'keyDown',keyCode:'Escape'});wc.sendInputEvent({type:'keyUp',keyCode:'Escape'});await until(()=>js(`!document.querySelector('.quick-note-dialog')`),'note folded');assert.equal(await js(`document.querySelector('.guide-search input').value`),'随手记');
 await input('generated-no-such-feature');assert.equal(await js(`document.querySelectorAll('[data-capability-id]').length`),0);assert.ok(await js(`document.querySelector('.guide-empty[role=status]')`));await snap('guide-wide-empty');
 await input('Coding');await js(`document.querySelector('[data-capability-id="A15"] a').click()`);await until(()=>js(`!!document.querySelector('.coding-uploads')`),'exact Coding entry');await js(`document.querySelector('.guide-return').click()`);await until(()=>js(`!!document.querySelector('.feature-guide')`),'explicit return to directory');assert.equal(await js(`document.querySelector('.guide-search input').value`),'Coding','directory search is preserved across destination return');
 await input('');window.setSize(390,844);await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});await js(`scrollTo(0,0)`);await snap('guide-touch-expanded');
 await input('记忆');await snap('guide-touch-search');await input('generated-no-such-feature');await snap('guide-touch-empty');
 await input('正在做的工作');await js(`document.querySelector('[data-capability-id="C28"] a').click()`);await until(()=>js(`!!document.querySelector('.activity-centre')`),'touch activity destination');await js(`scrollTo(0,0)`);await snap('guide-touch-return');await js(`document.querySelector('.guide-return').click()`);await until(()=>js(`!!document.querySelector('.feature-guide')`),'touch directory return');assert.equal(await js(`document.querySelector('.guide-search input').value`),'正在做的工作');await input('');
 window.setSize(1440,1000);await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:false});
 await openGuideUnit('A15');
 await until(()=>js(`document.querySelector('.coding-uploads')?.textContent.includes('还没有收到 Coding 来源。')`),'Guide reaches honest empty Coding status');
 assert.equal(await js(`!!document.querySelector('.activity-centre')`),false,'Coding status is not replaced by general Activity');
 await openGuideUnit('C19');await until(()=>js(`location.hash==='#/library?view=materials'&&!!document.querySelector('.archive-page')`),'Guide C19 reaches the exact Library collection');
 await openGuideUnit('C28');await until(()=>js(`location.hash==='#/activity'&&!!document.querySelector('.activity-centre')`),'Guide C28 reaches current Activity');
 await request('/api/sources',{id:'fixture-coding',name:'Generated Coding upload',kind:'coding-agent',deviceId:'fixture-device',platform:'macos'});
 const event=i=>({externalId:'event-'+i,revision:'1',observedAt:new Date(Date.now()+i).toISOString(),kind:'message',layer:'original',text:'Generated transcript '+i+': test the everyday plugin flow.',document:{contentRole:'transcript',coding:{version:1,provider:'codex',projectKey:'generated-project',sessionId:'generated-session',eventId:'event-'+i,role:i?'assistant':'user',attribution:i?'agent':'human',channel:i?'final':undefined,part:0,parts:1}}});
 await request('/api/sources/fixture-coding/items/batch',{items:[event(0),event(1),event(2)]});
 await until(async()=>(await request('/api/materials')).items.length===1,'published transcript');

 await openGuideUnit('A15');
 await until(()=>js(`location.hash==='#/library?view=coding-status'&&document.querySelector('.coding-uploads')?.textContent.includes('Generated Coding upload')`),'Guide A15 consumes actual Coding sync status');
 assert.match(await js(`document.querySelector('.coding-uploads').textContent`),/已接收增量事件3/);
 await snap('guide-coding-status');
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
 evidence.passed=true;evidence.codingEvents=3;evidence.checks=['77 unique entries and 16 default-collapsed groups','translated search, matching groups and true empty results','global note keeps directory draft','exact destination and explicit directory return preserve query','1440/390 screenshots without overflow','Guide A15 exact Coding status','empty state','Guide C19 exact Library and C28 actual Activity','real source ingress and publication','back and forward','original body','duplicate navigation','HTTP failure','loading','network recovery'];writeFileSync(join(output,'result.json'),JSON.stringify(evidence,null,2));
 console.log('PASS: Guide destinations reach actual registered pages and consume generated Central Coding receipts and originals.');
}
async function finish(code){if(window&&!window.isDestroyed())window.destroy();if(server&&server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('exit',r)),delay(5000)]);if(server.exitCode===null&&server.signalCode===null){server.kill('SIGKILL');await new Promise(r=>server.once('exit',r));}}rmSync(root,{recursive:true,force:true});evidence.cleanup={windowDestroyed:!window||window.isDestroyed(),serverStopped:!server||server.exitCode!==null||server.signalCode!==null,generatedDirectoryRemoved:!existsSync(root)};if(evidence.passed)writeFileSync(join(output,'result.json'),JSON.stringify(evidence,null,2));app.exit(code);}
run().then(()=>finish(0)).catch(async error=>{console.error(error);if(window&&!window.isDestroyed()){console.error(await window.webContents.executeJavaScript(`JSON.stringify({hash:location.hash,headings:[...document.querySelectorAll('h1')].map(e=>e.textContent),alerts:[...document.querySelectorAll('[role=alert],.notice')].map(e=>e.textContent)})`));writeFileSync(join(output,'failure.png'),(await window.webContents.capturePage()).toPNG());}finish(1);});
