// G4 manual Web stage acceptance (hidden; not part of ordinary checks):
//   npm run build -w @mote/web
//   cd apps/web && npx electron test/plugin-stage-browser.cjs
// The generated Central fixture is private and loopback-only. Screenshots and
// result.json go to .mote/web-plugin-stage (override with
// MOTE_PLUGIN_STAGE_OUTPUT). No personal archive, source site or model is used.
require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');
const {app,BrowserWindow,nativeTheme}=require('electron');
const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,readdirSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve,extname,sep}=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {createServer,request:httpRequest}=require('node:http');
const assert=require('node:assert/strict');

const repo=resolve(__dirname,'../../..'),web=join(repo,'apps/web/dist');
const profile=mkdtempSync(join(tmpdir(),'mote-web-plugin-stage-'));
const output=resolve(process.env.MOTE_PLUGIN_STAGE_OUTPUT||join(repo,'.mote/web-plugin-stage'));
mkdirSync(output,{recursive:true,mode:0o700});
app.setPath('userData',join(profile,'browser'));
app.on('window-all-closed',()=>{});
nativeTheme.themeSource='light';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let central,proxy,window,finished=false,currentPhase='startup';
const requests=[],captures=[],checks=[],consoleErrors=[];
const report={
  passed:false,revision:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),
  workingTree:execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).split('\n').some(line=>line.trim()),
  generatedOnly:true,actualBuiltWeb:true,actualCentralHttp:true,hidden:true,liveModel:false,
  sourceRendered:false,manualVisualComparison:false,modelCalls:0,checks,captures,
  unverified:['No external prototype was supplied, so every captured page is unverified against a visual prototype.'],
};

if(!existsSync(join(web,'index.html')))throw Error('Build the Web bundle first: npm run build -w @mote/web');

async function until(check,label,timeout=20000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return;await delay(40);}
  throw Error('Timed out: '+label);
}
const js=code=>window.webContents.executeJavaScript(code);
const apiRequests=(method,prefix)=>requests.filter(item=>item.method===method&&item.path.startsWith(prefix)).length;
const centralJson=async path=>{
  const response=await fetch('http://127.0.0.1:'+central.port+path,{headers:{authorization:'Bearer '+central.token}});
  assert.equal(response.status,200,path+' '+await response.clone().text());
  return response.json();
};

function startCentral(){
  const env={...process.env};
  for(const key of Object.keys(env))if(key.startsWith('MOTE_'))delete env[key];
  return new Promise((resolve,reject)=>{
    central={process:spawn(process.env.MOTE_FIXTURE_NODE||'node',['--import','tsx','apps/web/test/home-workspace-server.ts',join(profile,'central'),'workspace'],{cwd:repo,env,stdio:['ignore','pipe','pipe']})};
    let stdout='',stderr='';
    const timer=setTimeout(()=>reject(Error('Generated Central startup: '+stderr.slice(-4000))),40000);
    central.process.stderr.on('data',chunk=>stderr+=chunk);
    central.process.stdout.on('data',chunk=>{
      stdout+=chunk;
      for(const line of stdout.split('\n'))try{
        const value=JSON.parse(line);
        if(value.generatedOnly){
          clearTimeout(timer);
          central={...central,port:value.server.port,token:value.token,fixture:value};
          resolve(central);
        }
      }catch{}
    });
    central.process.once('exit',code=>{clearTimeout(timer);reject(Error('Generated Central exited '+code+': '+stderr.slice(-4000)));});
  });
}

function startProxy(){
  const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
  return new Promise(done=>{
    proxy=createServer((incoming,outgoing)=>{
      const path=new URL(incoming.url,'http://generated.invalid').pathname;
      requests.push({method:incoming.method,path});
      if(path.startsWith('/api/')){
        const upstream=httpRequest({host:'127.0.0.1',port:central.port,path:incoming.url,method:incoming.method,headers:{...incoming.headers,host:'127.0.0.1:'+central.port}},result=>{
          outgoing.writeHead(result.statusCode??502,result.headers);
          result.pipe(outgoing);
        });
        upstream.on('error',()=>{if(!outgoing.headersSent)outgoing.writeHead(502);outgoing.end();});
        incoming.pipe(upstream);
        return;
      }
      if(path==='/favicon.ico'){outgoing.writeHead(204);outgoing.end();return;}
      const file=resolve(web,'.'+(path==='/'?'/index.html':decodeURIComponent(path)));
      if(!file.startsWith(web+sep)||!existsSync(file)){outgoing.writeHead(404);outgoing.end();return;}
      outgoing.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream','cache-control':'no-store'});
      outgoing.end(readFileSync(file));
    });
    proxy.listen(0,'127.0.0.1',()=>done('http://127.0.0.1:'+proxy.address().port));
  });
}

async function run(){
  await app.whenReady();
  currentPhase='generated Central startup';
  await startCentral();
  const base=await startProxy();
  report.base=base;
  window=new BrowserWindow({width:1440,height:1000,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const wc=window.webContents;
  wc.on('console-message',(_event,level,message)=>{if(level>=3)consoleErrors.push(message);});
  wc.on('render-process-gone',(_event,details)=>{report.failure='Renderer exited: '+details.reason;void finish(1);});

  // Public host seam only: capture the real plugin scopes the production
  // bootstrap creates. The test never patches product code.
  await window.loadURL('about:blank');
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Page.enable');
  await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:`
    (()=>{
      window.__stageErrors=[];
      addEventListener('error',event=>window.__stageErrors.push(String(event.message||event.error)));
      addEventListener('unhandledrejection',event=>window.__stageErrors.push(String(event.reason)));
      const set=Map.prototype.set;
      Map.prototype.set=function(key,value){
        try{
          if(value&&typeof value==='object'&&value.instance&&typeof value.mount==='function'&&typeof value.rollback==='function')
            (window.__stageScopes||(window.__stageScopes=new Map)).set(value.instance.instanceId,value);
        }catch{}
        return set.call(this,key,value);
      };
    })();
  `});

  const viewport=async(width,height=1000)=>{
    window.setSize(width,height);
    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<=430});
  };
  const snap=async name=>{
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await delay(100);
    const state=await js(`({width:innerWidth,height:innerHeight,hash:location.hash,page:document.querySelector('.content')?.dataset.page,heading:document.querySelector('.content h1')?.textContent,overflow:document.documentElement.scrollWidth>innerWidth})`);
    assert.equal(state.overflow,false,'horizontal overflow at '+name);
    const file=name+'.png';
    writeFileSync(join(output,file),(await wc.capturePage()).toPNG());
    captures.push({name,...state,prototypeComparison:'unverified'});
  };
  const click=async(label,container='body')=>{
    const ok=await js(`(()=>{const root=document.querySelector(${JSON.stringify(container)});if(!root)return false;const node=[...root.querySelectorAll('button,a')].find(item=>item.getClientRects().length&&!item.disabled&&(item.textContent.trim()===${JSON.stringify(label)}||item.getAttribute('aria-label')===${JSON.stringify(label)}));if(!node)return false;node.click();return true;})()`);
    if(!ok){
      const available=await js(`(()=>{const root=document.querySelector(${JSON.stringify(container)});return root?[...root.querySelectorAll('button,a')].filter(item=>item.getClientRects().length).map(item=>item.textContent.trim()||item.getAttribute('aria-label')).filter(Boolean).slice(0,40):[]})()`);
      assert.fail('Visible action '+label+' not found; available: '+JSON.stringify(available));
    }
    await delay(80);
  };
  const input=async(selector,value)=>{
    await js(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw Error('Missing '+${JSON.stringify(selector)});const proto=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await delay(60);
  };
  const navigate=async(route,expected,selector,label=route)=>{
    currentPhase='navigate '+route;
    await js(`location.hash=${JSON.stringify('#/'+route)};scrollTo(0,0);`);
    await until(()=>js(`document.querySelector('.content')?.dataset.page===${JSON.stringify(expected)}&&!document.querySelector('[data-page-loading]')`),label);
    if(selector)await until(()=>js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),label+' landmark');
    await delay(180);
    assert.equal(await js(`document.querySelector('.content')?.dataset.page`),expected,'unexpected page for '+route);
  };

  currentPhase='login';
  await window.loadURL(base+'/#/today');
  await until(()=>js(`!!document.querySelector('.content button')`),'signed-out entry');
  await click('登录 Mote','.content');
  await until(()=>js(`!!document.querySelector('.connect-modal input[type=password]')`),'login form');
  await input('.connect-modal input[type=password]',central.token);
  await click('登录并继续','.connect-modal');
  await until(()=>js(`document.querySelector('.content')?.dataset.session==='ready'`),'verified owner');
  assert.equal(window.isVisible(),false,'the stage window stays hidden');
  checks.push('hidden window, actual built Web and real generated Central HTTP');

  const mainAsset=readdirSync(join(web,'assets')).find(name=>/^main-.*\.js$/.test(name)&&!name.endsWith('.css'));
  assert.ok(mainAsset,'built main asset exists');
  const hostReady=await js(`(async()=>{const module=await import('/assets/${mainAsset}');window.__stageHost=Object.values(module).find(value=>value&&typeof value==='object'&&typeof value.page==='function'&&typeof value.pages==='function'&&value.registry);return Boolean(window.__stageHost)})()`);
  assert.equal(hostReady,true,'the built feature host is observable');
  const pages=await js(`window.__stageHost.pages().map(page=>({id:page.id,route:page.route??page.id,label:page.label??page.id}))`);
  const catalog=await js(`window.__stageHost.collections().map(entry=>({id:entry.id,label:entry.label}))`);
  const scopes=await js(`[...window.__stageScopes.keys()].sort()`);
  assert.equal(pages.length,29,'default package page count');
  assert.equal(catalog.length,9,'default package collection count');
  assert.ok(scopes.includes('builtin:mote.library'),'library scope mounted');
  report.defaultPackage={pages:pages.map(page=>page.id),collections:catalog.map(entry=>entry.id),scopes};

  const landmarks={
    overview:'.central-overview',archive:'.library-workspace',notes:'.notes-history',agentView:'.agent-inspector',
    ask:'.conversation-layout',devices:'.device-overview',vault:'.content-storage',statistics:'.owner-maintenance-page',
    sourceCatalog:'.discovery-source-catalog',recordings:'.final-source-connector',sources:'.sources-page',lark:'.final-source-connector',
    imports:'.imports-page',activity:'.activity-centre',actions:'.actions-page',processing:'.processing-centre',
    extensions:'.plugin-center',usage:'.usage-page',insights:'.insights-page',settings:'.server-settings',
    coding:'.coding-uploads',connections:'.access-workspace',deviceConnections:'.device-pair-workspace',
    developer:'.diagnostics-panel',featureGuide:'.feature-guide',help:'.version-feedback',
    localPreferences:'.web-preferences',about:'.settings-destinations',search:'.search-workspace',
  };
  const collectionLandmarks={
    materials:'.library-materials',records:'.library-time-final',segments:'.capture-sessions',sources:'.sources-page',
    files:'.source-toolbar',activity:'.activity-panel',media:'.media-activity-panel',memories:'.memories-page',
    'coding-status':'.coding-uploads',
  };
  const observed=new Set();
  currentPhase='default package pages';
  await viewport(1440,1000);
  for(const page of pages){
    await navigate(page.route,page.id,landmarks[page.id]);
    observed.add(page.id);
    await snap('page-'+page.id+'-wide');
    if(['overview','archive','ask','notes','sources','settings','extensions'].includes(page.id)){
      await viewport(390,844);await js('scrollTo(0,0)');await snap('page-'+page.id+'-narrow');await viewport(1440,1000);
    }
  }
  for(const collection of catalog){
    await navigate('library?view='+encodeURIComponent(collection.id),'archive',collectionLandmarks[collection.id]);
    observed.add('collection:'+collection.id);
    await snap('library-'+collection.id+'-wide');
    if(['materials','records','memories'].includes(collection.id)){
      await viewport(390,844);await js('scrollTo(0,0)');await snap('library-'+collection.id+'-narrow');await viewport(1440,1000);
    }
  }
  for(const category of ['providers','model','processing','images','audio','documents','connectors','storage','embedding']){
    await navigate('system/models?category='+category,'settings','.server-settings');
    observed.add('settings:'+category);
    await snap('settings-'+category+'-wide');
  }
  assert.equal(observed.size,pages.length+catalog.length+9,'every default page, collection and settings surface observed');
  checks.push('traversed all '+pages.length+' registered pages, '+catalog.length+' library collections and 9 settings surfaces with hidden screenshots');

  // Draft lifecycle before replacement: a quick-note draft survives leaving
  // and reopening the page.
  currentPhase='quick-note draft';
  await navigate('today','overview','.central-overview');
  await js(`document.querySelector('.quick-note').click()`);
  await until(()=>js(`!!document.querySelector('.quick-note-dialog #note-text')`),'quick-note draft');
  const draft='Generated plugin-stage draft\nKeep this line across plugin replacement.';
  await input('#note-text',draft);
  await click('收起','.quick-note-dialog');
  await until(()=>js(`!document.querySelector('.quick-note-dialog')`),'quick-note closes');
  await navigate('library/notes','notes','.notes-history');
  await navigate('today','overview','.central-overview');
  await js(`document.querySelector('.quick-note').click()`);
  await until(()=>js(`document.querySelector('.quick-note-dialog #note-text')?.value===${JSON.stringify(draft)}`),'draft restored after navigation');
  await click('收起','.quick-note-dialog');
  await until(()=>js(`!document.querySelector('.quick-note-dialog')`),'draft remains closed');
  checks.push('quick-note draft survives leaving and reopening the page');

  // Reader return keeps the selected list row and focus.
  currentPhase='library reader return';
  await navigate('library?view=materials','archive','.library-materials');
  await until(()=>js(`document.querySelectorAll('.library-catalog-row .library-record').length>0`),'generated library materials');
  const reference=await js(`document.querySelector('.library-catalog-row .library-record').dataset.reference`);
  await js(`(()=>{const row=document.querySelector('.library-catalog-row .library-record');row.focus({preventScroll:true});row.click();})()`);
  await until(()=>js(`!document.querySelector('.library-detail').hidden&&!!document.querySelector('.library-detail-heading .library-back')`),'library detail');
  await snap('lifecycle-library-detail');
  await js(`document.querySelector('.library-detail-heading .library-back').click()`);
  await until(()=>js(`document.querySelector('.library-detail').hidden`),'library list return');
  assert.equal(await js(`document.activeElement?.dataset.reference`),reference,'reader back returns focus to the exact row');
  checks.push('library reader Back returns to the mounted list and exact opener');

  // Stop-reading before replacement: hidden Home issues no feature poll and
  // the first visible moment catches up once.
  currentPhase='stop reading before replacement';
  const stopReading=async label=>{
    await navigate('today','overview','.central-overview');
    await delay(900);
    const baseline=apiRequests('GET','/api/features');
    await js(`(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'hidden'});document.dispatchEvent(new Event('visibilitychange'));})()`);
    await delay(300);
    const hiddenStart=apiRequests('GET','/api/features');
    await delay(5600);
    const hiddenEnd=apiRequests('GET','/api/features');
    assert.equal(hiddenEnd,hiddenStart,label+' hidden renderer starts no feature read');
    await js(`(()=>{delete document.hidden;delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'));})()`);
    await until(()=>apiRequests('GET','/api/features')>hiddenEnd,label+' visible catch-up read',5000);
    await delay(300);
    const visible=apiRequests('GET','/api/features');
    assert.ok(visible>hiddenEnd,label+' visible renderer catches up');
    assert.ok(visible-hiddenEnd<=2,label+' visible catch-up is bounded');
    return {baseline,hiddenStart,hiddenEnd,visible,catchUpReads:visible-hiddenEnd};
  };
  const stopBefore=await stopReading('before replacement');
  checks.push('hidden Home starts no new read; returning performs a bounded catch-up read');

  // Replace the library package scope. Its page and every collection are
  // withdrawn; unrelated plugin pages and services stay live.
  currentPhase='replace the library plugin';
  await navigate('today','overview','.central-overview');
  const before=await js(`(()=>{const host=window.__stageHost,scope=window.__stageScopes.get('builtin:mote.library');return {pages:host.pages().map(page=>page.id).sort(),collections:host.collections().map(entry=>entry.id).sort(),contributions:scope.instance.contributions.map(value=>value.surface+':'+value.entry.id).sort()}})()`);
  const rollback=await js(`window.__stageScopes.get('builtin:mote.library').rollback()`);
  assert.deepEqual(rollback.errors,[],'library rollback reports no cleanup errors');
  assert.equal(await js(`window.__stageScopes.get('builtin:mote.library').mounted`),false,'library scope is no longer mounted');
  assert.equal(await js(`Boolean(window.__stageHost.page('archive'))`),false,'library page contribution withdrawn');
  assert.deepEqual(await js(`window.__stageHost.collections().map(entry=>entry.id)`),[],'library collection contributions withdrawn');
  const remainingPages=await js(`window.__stageHost.pages().map(page=>page.id).filter(id=>id!=='archive').sort()`);
  assert.deepEqual(remainingPages,before.pages.filter(id=>id!=='archive'),'no unrelated page disappeared');

  const replacement=await js(`(async()=>{
    const host=window.__stageHost,scope=new (window.__stageScopes.get('builtin:mote.library').constructor)(host,{
      packageId:'stage.library-replacement',installationId:'stage:library-replacement',instanceId:'stage.library-replacement',
      desired:'active',compatible:true,loader:'react',contributions:[
        {surface:'page',entry:{id:'archive',route:'library',label:'阶段替换资料库',featureId:'stage.library-replacement',render:()=> 'Generated replacement library page'}},
        {surface:'collection',entry:{id:'materials',featureId:'stage.library-replacement',label:'阶段替换资料',order:0,render:()=> 'Generated replacement collection'}},
      ],
    });
    window.__stageReplacement=scope;
    const outcome=await scope.mount();
    return {outcome,page:host.pages().find(page=>page.route==='library')?.id,collections:host.collections().map(entry=>entry.id)};
  })()`);
  assert.deepEqual(replacement.outcome,{observed:'mounted'},'replacement plugin mounts');
  assert.equal(replacement.page,'stage.library-replacement/archive');
  assert.deepEqual(replacement.collections,['materials']);
  await navigate('library?view=materials',replacement.page,undefined,'replacement library');
  await until(()=>js(`document.querySelector('.content').textContent.includes('Generated replacement library page')`),'replacement page renders');
  await snap('replacement-library-wide');
  await viewport(390,844);await js('scrollTo(0,0)');await snap('replacement-library-narrow');await viewport(1440,1000);
  checks.push('withdrawing mote.library removes only its page and collections; a replacement page mounts and renders');

  // No remaining default page may go missing after replacement.
  currentPhase='remaining pages after replacement';
  for(const page of pages.filter(item=>item.id!=='archive')){
    await navigate(page.route,page.id,landmarks[page.id]);
    await snap('after-replacement-'+page.id+'-wide');
  }
  assert.equal(await js(`window.__stageHost.page('notes')!==undefined&&window.__stageHost.page('ask')!==undefined&&window.__stageHost.page('sources')!==undefined`),true,'unrelated plugin pages stay registered');
  checks.push('all '+(pages.length-1)+' remaining pages still render after replacement');

  // Draft survives the replacement and still saves through the real notes
  // contribution and owner HTTP route.
  currentPhase='draft across replacement';
  await navigate('today','overview','.central-overview');
  await js(`document.querySelector('.quick-note').click()`);
  await until(()=>js(`document.querySelector('.quick-note-dialog #note-text')?.value===${JSON.stringify(draft)}`),'draft survives replacement');
  await click('保存','.quick-note-dialog');
  await until(()=>js(`!document.querySelector('.quick-note-dialog')`),'saved note closes');
  const notes=await centralJson('/api/notes?limit=30');
  assert.equal(notes.items.filter(note=>note.ocrText===draft).length,1,'draft saves exactly once after replacement');
  await navigate('library/notes','notes','.notes-history');
  await until(()=>js(`document.querySelector('.notes-history')?.textContent.includes(${JSON.stringify(draft.split('\n')[0])})`),'saved note visible in notes history');
  checks.push('quick-note draft survives replacement, saves once and appears in notes history');

  // The replacement must not disable the stop-reading contract.
  currentPhase='stop reading after replacement';
  const stopAfter=await stopReading('after replacement');
  checks.push('stop-reading contract remains after replacement');

  // Another remaining plugin keeps its detail/back lifecycle.
  currentPhase='source return after replacement';
  await navigate('connections','sources','.sources-page');
  await until(()=>js(`!!document.querySelector('.source-select')`),'generated source');
  await js(`document.querySelector('.source-select').click()`);
  await until(()=>js(`!!document.querySelector('.sources-page.source-selected')`),'source detail');
  await snap('lifecycle-source-detail-after-replacement');
  await click('返回来源','.sources-page');
  await until(()=>js(`!document.querySelector('.sources-page.source-selected')`),'source list return');
  checks.push('sources detail Back still returns to the list after replacement');

  const stageErrors=await js(`window.__stageErrors`);
  assert.deepEqual(stageErrors,[],'no unhandled renderer errors');
  const unexpectedConsole=consoleErrors.filter(message=>!/Failed to load resource|net::ERR|404|503/.test(message));
  assert.deepEqual(unexpectedConsole,[],'no unexpected renderer console errors');
  assert.equal(window.isVisible(),false,'the stage window stayed hidden');

  Object.assign(report,{
    passed:true,
    observed:{pages:[...observed].sort(),remainingAfterReplacement:remainingPages.length},
    scopes,
    replacement:{plugin:'mote.library',removed:before.contributions,replacement:'stage.library-replacement',added:['page:stage.library-replacement/archive','collection:materials'],removedPage:true,removedCollections:before.collections,otherPagesLive:true},
    lifecycle:{draft:{survivedNavigation:true,survivedReplacement:true,savedOnce:true},back:{libraryFocusReturned:true,sourceReturnedAfterReplacement:true},stopReading:{before:stopBefore,after:stopAfter}},
    consoleErrors,
  });
  checks.push('generated-only Central data, no model call, no personal archive or source site');
  console.log(JSON.stringify({passed:true,pages:pages.length,collections:catalog.length,settingsSurfaces:9,captures:captures.length,replacement:report.replacement,stopReading:report.lifecycle.stopReading,output}));
}

async function finish(code){
  if(finished)return;
  finished=true;
  if(window&&!window.isDestroyed())window.destroy();
  if(proxy){
    proxy.closeAllConnections?.();
    await new Promise(resolve=>{proxy.close(()=>resolve());setTimeout(resolve,1000).unref();});
  }
  if(central?.process&&central.process.exitCode===null&&central.process.signalCode===null){
    central.process.kill('SIGTERM');
    await Promise.race([new Promise(resolve=>central.process.once('exit',resolve)),delay(5000)]);
    if(central.process.exitCode===null)central.process.kill('SIGKILL');
  }
  rmSync(profile,{recursive:true,force:true});
  report.cleanup={windowDestroyed:!window||window.isDestroyed(),proxyClosed:!proxy||!proxy.listening,centralStopped:!central?.process||central.process.exitCode!==null||central.process.signalCode!==null,profileRemoved:!existsSync(profile)};
  writeFileSync(join(output,'result.json'),JSON.stringify(report,null,2));
  app.exit(code);
}

run().then(()=>finish(report.passed?0:1)).catch(async error=>{
  report.failure=error instanceof Error?(error.stack??error.message):String(error);
  console.error(error);
  if(window&&!window.isDestroyed()){
    try{writeFileSync(join(output,'failure.png'),(await window.webContents.capturePage()).toPNG());}catch{}
    try{writeFileSync(join(output,'failure.txt'),await window.webContents.executeJavaScript('document.body.innerText').catch(()=>''));}catch{}
  }
  await finish(1);
});
