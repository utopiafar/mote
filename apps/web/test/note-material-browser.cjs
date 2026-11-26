require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');
const {app,BrowserWindow,nativeTheme}=require('electron');
const {createHash}=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync}=require('node:fs');
const {tmpdir}=require('node:os');const {join,resolve}=require('node:path');const assert=require('node:assert/strict');
const repo=resolve(__dirname,'../../..'),out=resolve(process.env.MOTE_NOTE_MATERIAL_OUT||join(repo,'.mote/note-material-browser')),webRoot=resolve(process.env.MOTE_NOTE_MATERIAL_WEB_ROOT||join(repo,'.mote/note-material-web')),temporary=mkdtempSync(join(tmpdir(),'mote-memory-final-'));
mkdirSync(out,{recursive:true});app.setPath('userData',join(temporary,'browser'));app.on('window-all-closed',()=>{});nativeTheme.themeSource='light';
const report={revision:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),workingTree:!!execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).trim(),generatedOnly:true,actualCentralHttp:true,actualBuiltWeb:true,modelCalls:null,screenshots:[],checks:[],failures:[]};
let server,window;const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function run(){
 await app.whenReady();const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('MOTE_'))delete env[key];
 server=spawn(process.env.MOTE_FIXTURE_NODE||'node',['--import','tsx','apps/web/test/note-material-server.ts',temporary,webRoot],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
 const fixture=await new Promise((resolve,reject)=>{let stdout='',stderr='';const timer=setTimeout(()=>reject(Error('Fixture startup: '+stderr.slice(-2500))),30000);server.stderr.on('data',c=>stderr+=c);server.stdout.on('data',c=>{stdout+=c;for(const line of stdout.split('\n'))try{const x=JSON.parse(line);if(x.generatedOnly){clearTimeout(timer);resolve(x);}}catch{}});server.once('exit',()=>{clearTimeout(timer);reject(Error('Fixture exited: '+stderr.slice(-2500)));});});
 const base='http://127.0.0.1:'+fixture.server.port,requests=[],responses=[];
 window=new BrowserWindow({width:1440,height:1000,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const wc=window.webContents;wc.debugger.attach('1.3');
 const js=async s=>{
  const result=await wc.executeJavaScript(`(async()=>{try{return {value:await (${s})};}catch(error){return {error:error.stack||String(error)};}})()`);
  if(result.error)throw Error(result.error);
  return result.value;
 };
 wc.session.webRequest.onBeforeRequest({urls:[base+'/api/*']},(d,done)=>{requests.push({method:d.method,path:new URL(d.url).pathname,query:new URL(d.url).search,body:d.uploadData?.map(part=>part.bytes?Buffer.from(part.bytes).toString('utf8'):'').join('')});done({});});
 wc.session.webRequest.onCompleted({urls:[base+'/api/*']},d=>responses.push({method:d.method,path:new URL(d.url).pathname,status:d.statusCode}));
 const until=async(fn,label,timeout=15000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await delay(60);}throw Error('Timed out '+label);};
 const click=async label=>{assert.ok(await js(`(()=>{const b=[...document.querySelectorAll('button,a')].find(b=>b.getClientRects().length&&b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`),'Visible enabled '+label);await delay(80);};
 const field=async(selector,value)=>{await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing field');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(60);};
 const toggle=async selector=>{assert.ok(await js(`(()=>{const d=document.querySelector(${JSON.stringify(selector)});if(!d||!d.getClientRects().length)return false;d.querySelector(':scope > summary').click();return true})()`),'Visible details '+selector);await delay(60);};
 const snap=async name=>{await delay(140);const state=await js(`({width:innerWidth,theme:document.documentElement.dataset.theme,overflow:document.documentElement.scrollWidth>innerWidth,route:location.hash})`);assert.equal(state.overflow,false,'Overflow '+name);writeFileSync(join(out,name+'.png'),(await wc.capturePage()).toPNG());report.screenshots.push({file:name+'.png',...state,theme:nativeTheme.shouldUseDarkColors?'dark':'light'});};
 const scroll=async selector=>{await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'start'})`);await delay(80);};
 const http=async path=>{const response=await fetch(base+path,{headers:{authorization:'Bearer '+fixture.token}});return {status:response.status,value:await response.json()};};
 const viewport=async width=>{window.setSize(width,width===390?844:1000);await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height:width===390?844:1000,deviceScaleFactor:1,mobile:width===390});};
 const select=async ref=>{await js(`location.hash='#/library?selected='+encodeURIComponent(${JSON.stringify(ref)})`);await until(()=>js(`document.querySelector('.note-material-body')?.getClientRects().length>0`),'public Note Material owner route');};
 const ready=()=>js(`document.querySelector('.content')?.dataset.session==='ready'&&!!document.querySelector('.note-material-record pre')`);
 await window.loadURL(base+'/#/library?selected='+encodeURIComponent(fixture.short.material.ref));
 await until(()=>js('[...document.querySelectorAll("button")].some(button=>button.getClientRects().length&&!button.disabled&&button.textContent.trim()==="登录 Mote")'),'anonymous workspace ready');
 assert.equal(await js('document.querySelectorAll(".topbar,.workspace-sidebar").length'),0,'signed-out workspace has only the usable login entry');
 await click('登录 Mote');await until(()=>js(`!!document.querySelector('.connect-modal input[type=password]')`),'login form');await field('.connect-modal input[type=password]',fixture.token);await click('登录并继续');await until(ready,'actual owner Note reader');await viewport(1440);
 assert.equal(await js(`document.querySelector('.note-material-record pre').textContent`),fixture.literal+'\n');assert.equal(await js(`document.querySelector('.note-material-technical').open`),false);assert.equal(await js(`document.querySelector('.note-material-description').open`),false);assert.equal(await js(`document.querySelector('.note-material-body').innerText.includes('captureId')`),false);assert.equal(await js(`!!document.querySelector('.note-material-record script')`),false);await until(()=>js(`document.querySelector('.note-material-assets').innerText.includes('generated-note-attachment.txt')`),'same asset hash/mime metadata');await snap('note-literal-default-light');nativeTheme.themeSource='dark';await snap('note-literal-default-dark');await toggle('.note-material-description');await snap('note-description-dark');await toggle('.note-material-description');await toggle('.note-material-technical');await snap('note-technical-explicit-dark');await toggle('.note-material-technical');
 for(const width of [1440,390]){
  await viewport(width);
  await click('来源与处理');
  await until(()=>js('document.querySelector(".reader-details-panel[role=dialog] .reader-source-details")?.getClientRects().length>0'),'reader details');
  await until(()=>js('[...document.querySelectorAll(".reader-details-backdrop,.reader-details-panel")].every(node=>node.getAnimations().length===0)'),'reader at rest');
  const geometry=await js('(()=>{const r=document.querySelector(".reader-details-panel").getBoundingClientRect();return {width:r.width,left:r.left,right:r.right,bottom:r.bottom,viewportWidth:document.documentElement.clientWidth,viewportHeight:document.documentElement.clientHeight};})()');
  assert.ok(Math.abs(geometry.right-geometry.viewportWidth)<1,'details align to the viewport edge '+JSON.stringify(geometry));
  if(width===390){
   assert.ok(Math.abs(geometry.left)<1&&Math.abs(geometry.bottom-geometry.viewportHeight)<1,'narrow details are a bottom sheet');
  }else assert.ok(geometry.width<geometry.viewportWidth/2,'wide details occupy a right drawer');
  await snap('details-'+width);
  wc.sendInputEvent({type:'keyDown',keyCode:'Escape'});
  await until(()=>js('!document.querySelector(".reader-details-panel[role=dialog]") && document.activeElement?.classList.contains("reader-details-trigger")'),'Escape returns to the reader');
  assert.equal(await js('document.querySelector(".note-material-record pre").textContent'),fixture.literal+'\n');
 }
 await viewport(390);
 await js('document.querySelector(".shell-mobile-menu summary").click()');
 assert.equal(await js('document.querySelector(".shell-mobile-menu").open'),true);
 assert.equal(await js('[...document.querySelectorAll(".shell-mobile-menu button")].some(button=>/登录 Mote|刷新资料/.test(button.textContent))'),false);
 await js(`(()=>{
   document.querySelector('.shell-mobile-menu [aria-current="page"]').focus();
   document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
 })()`);
 assert.equal(await js('!document.querySelector(".shell-mobile-menu").open&&document.activeElement.tagName==="SUMMARY"'),true);
 await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await click('来源与处理');
 await until(()=>js('!!document.querySelector(".reader-details-panel[role=dialog]")'),'reduced-motion reader opens');
 assert.equal(await js('[...document.querySelectorAll(".reader-details-backdrop,.reader-details-panel")].some(node=>node.getAnimations().length>0)'),false);
 await js('document.querySelector(".reader-details-panel[role=dialog] > header button").click()');
 await until(()=>js('document.querySelector(".reader-details-backdrop").hidden&&document.activeElement?.classList.contains("reader-details-trigger")'),'reduced-motion close restores focus');
 await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
 await viewport(1440);
 let downloaded;wc.session.on('will-download',(_event,item)=>{item.setSavePath(join(temporary,'generated-attachment.txt'));item.once('done',(_event,state)=>{downloaded={state,path:item.getSavePath()};});});await click('下载原件');await until(()=>!!downloaded,'existing archive download completes');assert.equal(downloaded.state,'completed');const bytes=readFileSync(downloaded.path);assert.equal(createHash('sha256').update(bytes).digest('hex'),fixture.short.file.hash);assert.equal(bytes.length,fixture.short.file.sizeBytes);await snap('note-attachment-return-dark');
 await select(fixture.shared.material.ref);await until(()=>js(`!!document.querySelector('.note-material-quote')`),'actual saved quote span');assert.equal(await js(`document.querySelector('.note-material-quote').open`),true);assert.equal(await js(`document.querySelector('.note-material-quote pre').textContent`),fixture.quoted+'\n');assert.equal(await js(`!!(document.querySelector('.note-material-quote').compareDocumentPosition(document.querySelector('.note-material-record'))&4)`),true);nativeTheme.themeSource='light';await snap('saved-quote-and-addition-light');await toggle('.note-material-quote');await snap('saved-quote-collapsed-light');assert.equal(await js(`document.querySelector('.note-material-description').open`),false);await toggle('.note-material-quote');nativeTheme.themeSource='dark';await viewport(390);await snap('saved-quote-narrow-dark');
 await select(fixture.paged.ref);await until(()=>js(`document.querySelector('.note-material-body')?.innerText.includes('本页暂无文字正文')`),'metadata-only current page');assert.equal(await js(`!!document.querySelector('.note-material-record')`),false);await snap('metadata-only-page-narrow-dark');await click('继续展开');await until(()=>js(`document.querySelector('.note-material-record pre')?.textContent.includes('Generated body on the following page.')`),'server continuation reaches real body');assert.equal(await js(`document.querySelector('.note-material-record pre').textContent`),'Generated body on the following page.\n');await snap('metadata-next-body-narrow-dark');
 await viewport(1440);nativeTheme.themeSource='light';await select(fixture.long.material.ref);await until(()=>js(`document.querySelector('.note-material-record pre')?.textContent.startsWith('Generated long original')`),'long original first page');assert.equal(await js(`document.querySelector('.note-material-record pre').textContent.length>3900`),true);await snap('long-original-page-light');await click('继续展开');await until(()=>js(`(()=>{const text=document.querySelector('.note-material-record pre')?.textContent;return typeof text==='string'&&text.length>3000&&!text.startsWith('Generated long original');})()`),'long continuation replaces current page');assert.equal(await js(`document.querySelector('.note-material-record pre').textContent.length>3000`),true);await snap('long-original-next-light');
 report.motion=[];
 for(const width of [1440,390])for(const theme of ['light','dark']){
  await viewport(width);nativeTheme.themeSource=theme;await delay(180);
  const stats=await js(`(async()=>{
   const samples=[];
   let previous=0;
   const frames=async count=>{while(count--)await new Promise(resolve=>requestAnimationFrame(time=>{
    if(previous)samples.push(time-previous);
    previous=time;
    resolve();
   }));};
   const opener=document.querySelector('.reader-details-trigger');
   const backdrop=document.querySelector('.reader-details-backdrop');
   const close=backdrop.querySelector('button');
   const reader=document.querySelector('.note-material-record pre');
   const y=window.scrollY;
   let sawExit=false;
   for(let repeat=0;repeat<8;repeat++){
    opener.click(); await frames(4);
    close.click(); await frames(2);
    if(!backdrop.hidden||!backdrop.inert||document.activeElement!==opener)throw Error('Closed panel still owns interaction');
    sawExit ||= backdrop.getAnimations().some(animation=>animation.transitionProperty==='opacity');
    opener.click(); await frames(8);
    if(backdrop.hidden||backdrop.inert||!backdrop.contains(document.activeElement))throw Error('Panel failed to reopen during exit');
    close.click(); await frames(12);
   }
   if(document.querySelector('.note-material-record pre')!==reader||window.scrollY!==y)throw Error('Reader lost its place');
   samples.sort((a,b)=>a-b);
   return {sawExit,samples:samples.length,p95Ms:samples[Math.floor(samples.length*.95)],maxMs:samples.at(-1),over25Ms:samples.filter(ms=>ms>25).length};
  })()`);
  assert.equal(stats.sawExit,true,'closing keeps the visual transition while releasing interaction');
  report.motion.push({width,theme,...stats});
 }
 await viewport(1440);nativeTheme.themeSource='light';
 writeFileSync(join(temporary,'publish-generated-head'),'generated controlled publication');await select(fixture.short.material.ref);await until(()=>js(`document.querySelector('.material-detail').innerText.includes('这是历史版本')`),'actual old revision with changed host-published head');assert.equal(await js(`document.querySelector('.note-material-record pre').textContent`),fixture.literal+'\n');assert.equal(await js(`document.querySelector('.note-material-body').innerText.includes('NEW GENERATED HEAD')`),false);assert.equal(await js(`!!document.querySelector('.material-reader-ask')`),false);await snap('historical-note-exact-light');await click('来源与处理');await until(()=>js(`[...document.querySelectorAll('.reader-source-details button')].some(b=>b.textContent==='查看原始记录')`),'historical revision exact members');await click('查看原始记录');await until(()=>js(`document.querySelector('.evidence-text')?.innerText.includes('literal owner prose')`),'existing exact raw original reader');assert.ok(requests.some(x=>x.path==='/api/capture-browser/'+fixture.short.id));await snap('existing-original-reader-light');
 assert.equal(requests.some(x=>x.method==='POST'&&['/api/query-runs','/api/insight-runs','/api/memory-jobs','/api/memory-integrations'].includes(x.path)),false);report.checks.push('Actual owner Note Material/read spans: literal JSON/HTML-shaped original remains literal, quote before personal addition, separate pinned description, explicit technical disclosure, real archived attachment bytes hash/size download, current-page-only empty/continuation, complete 4000-range long text, historical immutable revision and existing exact raw original route. Controlled metadata-first and changed-head publications are fixture inputs, no model outputs. Owner late-response coverage uses the real HTTP React focused tests.');report.passed=true;
}
async function finish(code){if(window&&!window.isDestroyed()){window.webContents.session.flushStorageData();await window.webContents.session.closeAllConnections();window.destroy();}if(server&&server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('exit',r)),delay(5000)]);if(server.exitCode===null&&server.signalCode===null){server.kill('SIGKILL');await new Promise(r=>server.once('exit',r));}}if(existsSync(join(temporary,'model-calls.json')))report.modelCalls=JSON.parse(readFileSync(join(temporary,'model-calls.json'),'utf8')).modelCalls;if(report.passed&&report.modelCalls!==0){report.failures.push({fatal:'Model call counter unavailable or nonzero'});report.passed=false;code=1;}if(existsSync(join(temporary,'last-http-error.json')))report.lastControlledHttpError=JSON.parse(readFileSync(join(temporary,'last-http-error.json'),'utf8'));rmSync(temporary,{recursive:true,force:true,maxRetries:15,retryDelay:100});report.cleanup={windowDestroyed:!window||window.isDestroyed(),serverStopped:!server||server.exitCode!==null||server.signalCode!==null,temporaryRemoved:!existsSync(temporary)};writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));app.exit(code);}
run().then(()=>finish(0)).catch(async e=>{report.passed=false;report.failures.push({fatal:String(e)});console.error(e);if(window&&!window.isDestroyed()){writeFileSync(join(out,'failure.png'),(await window.webContents.capturePage()).toPNG());writeFileSync(join(out,'failure.txt'),await window.webContents.executeJavaScript('document.body.innerText').catch(()=>''));}await finish(1);});
