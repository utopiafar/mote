require('./fixture-language.cjs');
/** Real full application during generated ingress. Default preserves the legacy 20→631 profile. */
const {app,BrowserWindow}=require('electron');
const {mkdtempSync,mkdirSync,appendFileSync,writeFileSync,readFileSync,existsSync,rmSync,statSync}=require('node:fs');
const {tmpdir,release,arch,platform}=require('node:os');
const {join,resolve,relative}=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {randomBytes}=require('node:crypto');
const assert=require('node:assert/strict');
const {makeFixture,sha}=require('./material-load-fixture.cjs');
const {startArrivals,publicationOverlap}=require('./material-load-arrivals.cjs');
const repo=resolve(__dirname,'..'),profile=process.env.MOTE_MATERIAL_UI_PROFILE||'legacy-631',interactive=profile==='interactive-400';
const independent=process.env.MOTE_MATERIAL_UI_ARRIVALS==='independent';
const keepVault=process.env.MOTE_MATERIAL_UI_KEEP_VAULT==='1';
assert.ok(!process.env.MOTE_MATERIAL_UI_ARRIVALS||independent,'Unknown arrival mode');
assert.ok(!independent||interactive,'Independent arrivals require interactive-400');
const fixture=makeFixture(profile),root=mkdtempSync(join(tmpdir(),'mote-material-ui-'));
const outputRoot=resolve(process.env.MOTE_MATERIAL_UI_OUTPUT||join(repo,'.mote/material-load-ui'));
if(interactive)assert.ok(relative(repo,outputRoot).startsWith('..'),'Interactive reports must be outside the repository');
mkdirSync(outputRoot,{recursive:true});const out=mkdtempSync(join(outputRoot,'run-'));
const fixturePath=process.env.MOTE_MATERIAL_UI_FIXTURE||join(out,'fixture.json');
const fixtureJson=JSON.stringify(fixture,null,2)+'\n';
if(process.env.MOTE_MATERIAL_UI_FIXTURE)assert.equal(readFileSync(fixturePath,'utf8'),fixtureJson,'Frozen fixture matches generator');
writeFileSync(join(out,'fixture.json'),fixtureJson,{mode:0o600});
app.setPath('userData',join(root,'browser'));app.on('window-all-closed',()=>{});
const report={status:'running',profile,fixtureRoot:root,vault:{root,dataDir:join(root,'vault'),keepOnSuccessRequested:keepVault,retainOnFailure:true,retained:null},scope:'Full production Web app and loopback server in Electron, generated sources and controlled processing stub',personalDataUsed:false,modelInvoked:false,physicalDevicesTested:false,actualElectronRenderer:true,initialRecords:fixture.initial,targetRecords:fixture.total,fixtureSha256:sha(fixtureJson),actions:[],requests:[],backgroundWrites:[],checks:[],screenshots:[],crashes:[],httpErrors:[],consoleErrors:[],blockedRequests:[],startedAt:new Date().toISOString(),environment:{platform:platform(),release:release(),arch:arch(),versions:process.versions,concurrentSystemLoad:process.env.MOTE_MATERIAL_UI_CONCURRENT_LOAD||'Not controlled; other system activity is unknown'}};
const save=()=>writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
const delay=ms=>new Promise(r=>setTimeout(r,ms));let server,window,deadline,arrivalRun,producerProxy,drainTimer,outageTimer,recoveryTimer,inspectFixture;
function check(name,value){assert.ok(value,name);report.checks.push(name);}
function observe(name,value){if(value)report.checks.push(name);else{report.observationFailures??=[];report.observationFailures.push(name);}save();}
async function until(work,label,timeout=25000){const started=Date.now();while(Date.now()-started<timeout){if(await work())return;await delay(50);}throw Error('Timeout: '+label);}
const js=code=>window.webContents.executeJavaScript(code);
async function click(text,scope='document'){
 await until(()=>js(`(()=>{const root=${scope};const b=root&&[...root.querySelectorAll('button')].find(b=>b.getClientRects().length&&b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.focus();b.click();return true;})()`),'button '+text);
}
async function frames(){await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');}
async function measure(phase,name,work){const action={phase,name,start:Date.now()};try{const result=await work();await frames();action.outcome='passed';return result;}catch(error){action.outcome='failed';throw error;}finally{action.end=Date.now();action.durationMs=action.end-action.start;report.actions.push(action);save();}}
const listSelector='.materials-browser > .feature-cards > button.source-item';
const listTitles=()=>js(`[...document.querySelectorAll(${JSON.stringify(listSelector)})].map(e=>e.querySelector('strong').textContent)`);
const listScope="document.querySelector('.materials-browser > .processing-actions')";
async function materials(){await js("location.hash='/library/materials'");await until(async()=> (await listTitles()).length===12,'bounded Material list');}
async function firstPage(){if(await js(`!!${listScope}&&[...${listScope}.querySelectorAll('button')].some(b=>b.textContent==='返回第一页')`)){const before=(await listTitles()).join('|');await click('返回第一页',listScope);await until(async()=>{const titles=await listTitles();return titles.length===12&&titles.join('|')!==before;},'first Material page');}}
async function nextPage(){const before=(await listTitles()).join('|');await click('下一页',listScope);await until(async()=>{const now=await listTitles();return now.length>0&&now.join('|')!==before;},'new Material page');check('list DOM remains bounded',await js(`document.querySelectorAll(${JSON.stringify(listSelector)}).length<=12`));}
async function allHistory(){await until(()=>js(`(()=>{const select=document.querySelector('[aria-label=\"选择时间范围\"]');if(!select)return false;select.value='all';select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`),'all-history selector');await frames();}
const sourceScope="document.querySelector('.material-detail .source-material-view')";
const sourceText=()=>js(`[...document.querySelectorAll('.material-detail .source-material-blocks .file-text')].map(e=>e.textContent).join('')`);
function sliceBody(text,offset){let end=Math.min(offset+4000,text.length);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1])&&/[\uDC00-\uDFFF]/.test(text[end]))end--;return {text:text.slice(offset,end),end};}
async function openLong(){
 const titles=await listTitles(),record=fixture.records.find(r=>r.long&&titles.includes(r.title));assert.ok(record,'Current UI page includes a generated long source');
 await js(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(listSelector)})].find(e=>e.querySelector('strong').textContent===${JSON.stringify(record.title)});b.focus();b.click();})()`);
 await until(async()=>await sourceText()===sliceBody(record.item.text,0).text,'exact first decoded body range '+record.title);return record;
}
async function readLong(record,full=false){let offset=0,page=sliceBody(record.item.text,0),seen=page.text;const pages=[{offset:0,...page}];
 assert.equal(await sourceText(),page.text);
 do{offset=page.end;await click('继续展开',sourceScope);page=sliceBody(record.item.text,offset);await until(async()=>await sourceText()===page.text,'exact next decoded body range');seen+=page.text;pages.push({offset,...page});}while(full&&page.end<record.item.text.length);
 if(full){assert.equal(sha(seen),record.sha256);check('full long source including tail reconstructed from visible bounded pages',true);}
 await click('上一页',sourceScope);await until(async()=>await sourceText()===pages.at(-2).text,'previous decoded page');
 if(pages.at(-2).offset>0)await click('返回第一页',sourceScope);
 await until(async()=>await sourceText()===sliceBody(record.item.text,0).text,'source first page restored');
}
async function wheel(phase){
 await js("document.querySelector('.material-detail').scrollIntoView({block:'start',behavior:'instant'})");await frames();
 const before=await js('scrollY'),start=Date.now();window.focus();window.webContents.focus();
 for(let i=0;i<6;i++){window.webContents.sendInputEvent({type:'mouseWheel',x:Math.min(600,window.getBounds().width-80),y:450,deltaY:-160,deltaX:0,canScroll:true});await delay(80);}
 await until(()=>js(`scrollY>${before}+100`),'actual wheel scroll displacement');
 const after=await js('scrollY');report.wheelSamples??=[];report.wheelSamples.push({phase,start,end:Date.now(),events:6,before,after});check('real wheel moves viewport',after-before>100);
}
async function originalFromBody(record){
 await js(`(()=>{window.fixtureOrigin=location.hash;window.fixtureOpener=[...document.querySelectorAll('.material-detail .source-material-view button')].find(b=>b.textContent==='查看原始记录');if(!window.fixtureOpener)throw Error('No original button');window.fixtureOpener.focus();window.fixtureOpener.click();})()`);
 await until(()=>js(`document.querySelector('.evidence-modal')?.textContent.includes(${JSON.stringify('HEAD '+String(record.index).padStart(4,'0'))})`),'original evidence text');
 check('original route identifies capture',await js(`new URLSearchParams(location.hash.split('?')[1]).get('evidence')?.startsWith('capture:')`));await closeEvidence();
}
async function closeEvidence(){window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await until(()=>js('!document.querySelector(".evidence-modal")&&location.hash===window.fixtureOrigin'),'restore origin route');check('exact original opener regains focus',await js('window.fixtureOpener.isConnected&&document.activeElement===window.fixtureOpener'));}
async function screenshot(name,selector){if(selector)await js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'start',behavior:'instant'})`);await frames();check('no horizontal overflow: '+name,await js('document.documentElement.scrollWidth<=innerWidth'));const path=join(out,name+'.png');writeFileSync(path,(await window.webContents.capturePage()).toPNG());report.screenshots.push(path);save();}
async function rateWindowBreak(label){const wait={label,start:Date.now(),durationMs:61000,reason:'Separate automated journeys across the production owner 180/minute request window; excluded from interaction timing'};report.phaseBreaks??=[];report.phaseBreaks.push(wait);await js("location.hash='/notes'");save();while(Date.now()-wait.start<wait.durationMs)await delay(Math.min(500,wait.durationMs-(Date.now()-wait.start)));wait.end=Date.now();save();}
async function beginMetrics(label){await js(`(()=>{window.uiMetrics={label:${JSON.stringify(label)},start:Date.now(),frames:[],longTasks:[],running:true};const m=window.uiMetrics;m.observer=new PerformanceObserver(list=>m.longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration}))));m.observer.observe({entryTypes:['longtask']});let previous;function frame(at){if(previous)m.frames.push(at-previous);previous=at;if(m.running)requestAnimationFrame(frame);}requestAnimationFrame(frame);})()`);}
async function endMetrics(){const value=await js(`(()=>{const m=window.uiMetrics;m.running=false;m.observer.disconnect();return {label:m.label,start:m.start,end:Date.now(),sampleCount:m.frames.length,maxGapMs:Math.max(0,...m.frames),over50ms:m.frames.filter(n=>n>50).length,frames:m.frames,longTasks:m.longTasks};})()`);report.frameWindows??=[];report.frameWindows.push(value);check('frame sampling active: '+value.label,value.sampleCount>10);}
async function run(){
 report.gitHead=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();report.gitStatus=execFileSync('git',['status','--short'],{cwd:repo,encoding:'utf8'}).trim();
 report.code=Object.fromEntries(['scripts/test-material-load-ui.cjs','scripts/material-load-fixture.cjs','scripts/material-load-arrivals.cjs','scripts/journey-network-proxy.mjs','scripts/material-load-fixture-server.mjs','apps/server/dist/app.js','apps/server/dist/material-organizers.js','apps/web/dist/index.html','packages/agent/dist/index.js','packages/shared/dist/index.js'].map(p=>[p,{sha256:sha(readFileSync(join(repo,p))),mtime:statSync(join(repo,p)).mtime.toISOString()}]));save();
 await app.whenReady();const token=randomBytes(32).toString('hex'),ready=join(root,'ready.json'),configPath=join(root,'server-config.json');
 const config={dataDir:join(root,'vault'),token,tokenPath:join(root,'token'),host:'127.0.0.1',port:0,maxStorageBytes:150000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'http://127.0.0.1:1/v1',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',diagnosticsEnabled:false};
 writeFileSync(configPath,JSON.stringify({config,fixturePath,ready}),{mode:0o600});
 server=spawn(process.execPath,[join(repo,'scripts/material-load-fixture-server.mjs'),configPath],{cwd:repo,env:{...Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]])),ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','pipe']});
 let stderr='',stdout='';server.stderr.on('data',chunk=>{stderr+=chunk;writeFileSync(join(out,'server-stderr.log'),stderr);});server.stdout.on('data',chunk=>{stdout+=chunk;writeFileSync(join(out,'server-stdout.log'),stdout);});
 await until(()=>{if(server.exitCode!==null)throw Error(stderr);return existsSync(ready);},'fixture server');const endpoint=JSON.parse(readFileSync(ready,'utf8')).url;
 const request=async(path,body)=>{const start=Date.now();const r=await fetch(endpoint+path,{...(independent?{signal:AbortSignal.timeout(8000)}:{}),method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json','x-mote-ingress-version':'2'},...(body?{body:JSON.stringify(body)}:{})});const result=await r.json();report.requests.push({origin:'harness',path,start,end:Date.now(),status:r.status});assert.ok(r.ok,`${path}: ${r.status} ${JSON.stringify(result)}`);return result;};
 if(independent)inspectFixture=()=>request('/api/fixture/state');
 await request('/api/sources',{id:'generated-load',name:'合成批量资料',kind:'coding-agent',deviceId:'fixture-load',platform:'import'});await request('/api/fixture/configure',{});
 if(interactive)await request('/api/sources',{id:'generated-long',name:'生成长文资料',kind:'custom',deviceId:'fixture-long',platform:'import'});
 let received=interactive?1:0;
 async function batch(start,end){const entry={start:Date.now(),from:start,to:end,requests:[]};
  for(const sourceId of ['generated-load','generated-long']){const items=fixture.records.slice(start,end).filter(r=>r.sourceId===sourceId).map(r=>r.item);if(!items.length)continue;const at=Date.now(),ack=await request('/api/sources/'+sourceId+'/items/batch',{items});entry.requests.push({sourceId,start:at,end:Date.now()});assert.equal(ack.receipts.length,items.length);check('source batch receipts accepted',ack.receipts.every(r=>r.receipt.state==='received'));received+=items.length;}
  let state=await request('/api/fixture/drain',{});await until(async()=>{if(state.count===received)return true;state=await request('/api/fixture/drain',{});return state.count===received;},'batch publication '+received);
  Object.assign(entry,{end:Date.now(),received,published:state.count});report.backgroundWrites.push(entry);save();return state;
 }
 for(let start=0;start<fixture.initialIngress;start+=fixture.batchSize)await batch(start,Math.min(start+fixture.batchSize,fixture.initialIngress));
 let initial=await request('/api/fixture/state');assert.equal(initial.count,fixture.initial);
 window=new BrowserWindow({width:1280,height:1000,show:interactive,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});const wc=window.webContents;
 wc.on('render-process-gone',(_e,data)=>report.crashes.push(data.reason));wc.on('console-message',(_e,level,message)=>{if(level>=3)report.consoleErrors.push(message);});
 const pending=new Map();wc.session.webRequest.onBeforeRequest((details,callback)=>{const u=new URL(details.url),allowed=!['http:','https:'].includes(u.protocol)||u.origin===endpoint;if(!allowed)report.blockedRequests.push({url:details.url,at:Date.now()});pending.set(details.id,{origin:'renderer',path:u.pathname+u.search,start:Date.now(),method:details.method});callback({cancel:!allowed});});
 wc.session.webRequest.onCompleted(details=>{const entry=pending.get(details.id);if(entry){pending.delete(details.id);report.requests.push({...entry,end:Date.now(),status:details.statusCode});}if(details.statusCode>=400)report.httpErrors.push({path:new URL(details.url).pathname,status:details.statusCode});});
 await window.loadURL(endpoint);await js(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({token}))});location.reload()`);await click('资料库');await click('正式资料');await until(async()=> (await listTitles()).length===12,'initial list');
 if(!interactive){
  await measure('20','next-page',async()=>{await nextPage();assert.equal((await listTitles()).length,8);});await firstPage();await beginMetrics('legacy-ingress');
  const background=(async()=>{for(let start=20;start<631;start+=25){await batch(start,Math.min(start+25,631));await delay(80);}})();background.catch(()=>{});
  for(let round=0;round<4;round++){await measure('ingress','open',async()=>{await js(`document.querySelector(${JSON.stringify(listSelector)}).click()`);await until(()=>js(`!!document.querySelector('.material-detail .fine-print')`),'detail');});await measure('ingress','scroll',async()=>{await js("document.querySelector('.material-detail').scrollIntoView({behavior:'instant'})");assert.ok(await js('scrollY>0'));await js('scrollTo(0,0)');});await measure('ingress','next-page',nextPage);await firstPage();}
  await background;await endMetrics();await measure('631','open',async()=>{await js(`document.querySelector(${JSON.stringify(listSelector)}).click()`);await until(()=>js(`!!document.querySelector('.material-detail .fine-print')`),'final detail');});const writes=report.backgroundWrites.filter(b=>b.from>=20);report.actionsDuringIngestion=report.actions.filter(a=>a.phase==='ingress'&&a.start<writes.at(-1).end&&a.end>writes[0].start).length;check('legacy actions overlap ingestion',report.actionsDuringIngestion>=3);await screenshot('legacy-desktop','.material-detail');window.setSize(430,1000);await screenshot('legacy-mobile','.material-detail');window.setSize(1280,1000);await click('刷新',"document.querySelector('.materials-browser')");await until(async()=> (await listTitles()).length===12,'bounded final page');
 }else{
  await beginMetrics('160-idle');await delay(1000);await endMetrics();await beginMetrics('160-interactive');
  const firstTitles=await listTitles();for(let i=0;i<3;i++){await measure('160','next-page',nextPage);const second=await listTitles();assert.equal(second.length,12);assert.equal(second.filter(t=>firstTitles.includes(t)).length,0);await firstPage();const record=await measure('160','open-long',openLong);await measure('160','read-long',()=>readLong(record,i===0));if(i===0){await measure('160','wheel',()=>wheel('160'));await measure('160','original',()=>originalFromBody(record));}}
  await endMetrics();await screenshot('160-long-desktop','.material-detail');window.setSize(430,1000);await screenshot('160-long-mobile','.material-detail');window.setSize(1280,1000);await rateWindowBreak('after-160-before-memory');
  const job=await request('/api/memory-jobs',{deviceId:fixture.control.deviceId,recipes:[{id:'fixture.body-memory',version:'1'},{id:'fixture.transcript-memory',version:'1'}],timeZone:'UTC'});
  let waiting;await until(async()=>{waiting=(await request('/api/fixture/state')).jobs.find(j=>j.id===job.id);return waiting?.status==='waiting_for_input'&&waiting.memoryIds.length===1;},'body complete / transcript waiting');
  check('actual input plans are one complete and one waiting',waiting.inputPlans.completed===1&&waiting.inputPlans.waiting===1&&waiting.operation.state==='waiting');
  await js("location.hash='/library/memories'");await allHistory();await until(()=>js(`document.querySelector('.memory-progress')?.textContent.includes('等待资料处理')`),'waiting progress UI');check('progress displays 1/2',await js(`document.querySelector('.memory-input-progress progress')?.value===1&&document.querySelector('.memory-input-progress progress')?.max===2`));
  await screenshot('waiting-desktop','.memory-progress');window.setSize(430,1000);await screenshot('waiting-mobile','.memory-progress');window.setSize(1280,1000);await click('查看记忆',"document.querySelector('.memory-progress')");await until(()=>js(`document.querySelector('.memory-detail .status-label')?.textContent==='已生效'`),'active saved body Memory');check('completed result is immediately readable',await js(`document.querySelector('.memory-detail')?.textContent.includes('written checklists')`));
  const citationRecord=fixture.records.find(r=>r.long);const citation=await request('/api/fixture/conversation',{index:citationRecord.index});
  await materials();await beginMetrics('ingress-interactive');const firstIncremental=report.backgroundWrites.length;
  if(independent){
   const {startProxy,command}=await import('./journey-network-proxy.mjs');
   const control=join(root,'producer-proxy','control.json');producerProxy=await startProxy({upstream:endpoint,control,timeoutMs:5000});
   report.arrivalMode='independent';report.generatedScope='Generated text source protocol load only; no image/audio decoding or native capture';
   let drainActive=false,drainFailure;
   drainTimer=setInterval(()=>{if(drainActive)return;drainActive=true;request('/api/fixture/drain',{}).then(state=>{report.backlogSamples.push({at:Date.now(),pending:arrivalRun?.snapshot().pending??0,published:state.count,tick:state.ticks.at(-1)});report.peakServerRssBytes=state.peakRss;report.serverCpuUsageMicroseconds=state.cpuUsage;}).catch(e=>{drainFailure=e;}).finally(()=>{drainActive=false;});},2000);
   const uiScheduleStart=performance.now();report.arrivalsStartWall=Date.now();report.backlogSamples=[];
   arrivalRun=startArrivals({records:fixture.records.slice(fixture.initialIngress),ledgerPath:join(out,'arrivals.jsonl'),send:async(sourceId,items)=>{
    const entry={start:Date.now(),requests:[],accepted:false};
    try{const r=await fetch(producerProxy.url+'/api/sources/'+sourceId+'/items/batch',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','x-mote-ingress-version':'2'},body:JSON.stringify({items}),signal:AbortSignal.timeout(6000)});if(!r.ok){const error=Error('Producer HTTP '+r.status);error.fatal=r.status<500;throw error;}const result=await r.json();entry.accepted=true;return result;}
    finally{if(existsSync(producerProxy.statePath)){const state=JSON.parse(readFileSync(producerProxy.statePath,'utf8'));if(state.mode==='offline'&&!report.producerOutage.firstOfflineObservedAt){report.producerOutage.firstOfflineObservedAt=Date.now();report.producerOutage.offlineAppliedAt=state.appliedAt;}if(state.mode==='online'&&report.producerOutage.firstOfflineObservedAt&&!report.producerOutage.firstRecoveredObservedAt){report.producerOutage.firstRecoveredObservedAt=Date.now();report.producerOutage.recoverAppliedAt=state.appliedAt;}}entry.end=Date.now();entry.requests.push({sourceId,start:entry.start,end:entry.end,accepted:entry.accepted});report.backgroundWrites.push(entry);}
   }});
   report.producerOutage={plannedStartMs:20000,plannedEndMs:35000,scope:'producer proxy only; renderer and controlled drain direct'};
   outageTimer=setTimeout(()=>{command(control,'offline').then(()=>{report.producerOutage.offlineCommandWrittenAt=Date.now();}).catch(e=>{drainFailure=e;});},20000);
   recoveryTimer=setTimeout(()=>{command(control,'recover').then(()=>{report.producerOutage.recoverCommandWrittenAt=Date.now();}).catch(e=>{drainFailure=e;});},35000);
   report.uiRoundSchedule=[0,15000,30000,36000].map(plannedMs=>({plannedMs}));
   for(let round=0;round<4;round++){
    const slot=report.uiRoundSchedule[round],target=uiScheduleStart+slot.plannedMs;
    slot.waitStartedAt=Date.now();await delay(Math.max(0,target-performance.now()));slot.startedAt=Date.now();slot.waitMs=slot.startedAt-slot.waitStartedAt;slot.latenessMs=Math.max(0,performance.now()-target);
    // Waiting is outside measure(): action latency does not include scheduled idle time.
    if(drainFailure)throw drainFailure;
    await measure('ingress','next-page',nextPage);await firstPage();const record=await measure('ingress','open-long',openLong);await measure('ingress','wheel',()=>wheel('ingress'));await measure('ingress','read-long',()=>readLong(record));await measure('ingress','original',()=>originalFromBody(record));
    if(round===0){await measure('ingress','save-generated-note',async()=>{
     const text='GENERATED LOAD FOREGROUND NOTE\nSeparate from the fixed 400 source materials.';
     await js("location.hash='/notes'");await until(()=>js("!!document.querySelector('#note-text')"),'Notes input');
     await js(`(()=>{const e=document.querySelector('#note-text');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
     await click('保存并同步');await until(()=>js(`document.body.innerText.includes('随手记已同步到你的中央节点。')`),'foreground note synchronized');report.frontendNote={textSha256:sha(text),savedAt:Date.now(),additionalToPlanned400:true};await materials();
    });}
    slot.endedAt=Date.now();
   }
   report.arrivals=await arrivalRun.done;if(drainFailure)throw drainFailure;
   const offlineStart=Date.parse(report.producerOutage.offlineAppliedAt),recovered=Date.parse(report.producerOutage.recoverAppliedAt);
   report.offlineOverlappingActions=report.actions.filter(a=>a.phase==='ingress'&&a.start<recovered&&a.end>offlineStart).map(a=>({name:a.name,start:a.start,end:a.end}));
   observe('foreground action overlaps observed producer offline interval',report.offlineOverlappingActions.length>0);
   const ledger=readFileSync(join(out,'arrivals.jsonl'),'utf8').trim().split('\n').map(JSON.parse),enqueued=new Map(ledger.filter(e=>e.event==='enqueued').map(e=>[e.key,e]));
   const distribution=values=>{values.sort((a,b)=>a-b);return {count:values.length,p50:values[Math.floor((values.length-1)*.5)],p95:values[Math.floor((values.length-1)*.95)],max:values.at(-1)};};
   report.arrivals.latenessMs=distribution([...enqueued.values()].map(e=>e.latenessMs));report.arrivals.ackLatencyMs=distribution(ledger.filter(e=>e.event==='acknowledged').map(e=>e.elapsedMs-enqueued.get(e.key).plannedMs));
   report.arrivals.plannedDuringOutage=[...enqueued.values()].filter(e=>e.plannedMs>=20000&&e.plannedMs<35000).length;assert.equal(report.arrivals.plannedDuringOutage,60);observe('producer outage observed and recovered with at least 60 queued arrivals',!!report.producerOutage.firstOfflineObservedAt&&!!report.producerOutage.firstRecoveredObservedAt&&report.arrivals.peakPending>=60);

   clearInterval(drainTimer);await until(()=>!drainActive,'controlled drain finishes');
   try{await until(async()=>{const s=await request('/api/fixture/drain',{});return s.count===401;},'independent terminal publication');}catch(error){if(error.message!=='Timeout: independent terminal publication')throw error;observe('independent terminal publication reaches 401 before bounded drain timeout',false);report.finalDrainError=error.message;}
   const terminal=await request('/api/fixture/state');
   report.recoveryPublicationAudit=publicationOverlap({ledger,publications:terminal.publications,actions:report.actions.filter(a=>a.phase==='ingress'),recoveredAt:recovered});
   report.recoveryBacklogOverlappingActions=report.recoveryPublicationAudit.overlappingActions;
   observe('foreground action overlaps post-recovery publication while backlog remains',report.recoveryBacklogOverlappingActions.length>0);
   const expected=fixture.records.slice(fixture.initialIngress).map(r=>r.materialId);
   observe('all 240 incremental Material identities published',JSON.stringify(terminal.catalog.filter(r=>expected.includes(r.id)).map(r=>r.id).sort())===JSON.stringify(expected.sort()));
   const initialById=new Map(initial.catalog.map(r=>[r.id,r]));assert.deepEqual(terminal.catalog.filter(r=>initialById.has(r.id)).sort((a,b)=>a.id.localeCompare(b.id)),[...initialById.values()].sort((a,b)=>a.id.localeCompare(b.id)));
   report.frontendNote.materials=terminal.catalog.filter(r=>!initialById.has(r.id)&&!expected.includes(r.id));assert.equal(report.frontendNote.materials.length,1);
   report.arrivalTerminals=terminal.catalog.filter(r=>expected.includes(r.id)).map(r=>({id:r.id,revision:r.revision,observedAt:Date.now()}));
   for(const entry of report.arrivalTerminals)appendFileSync(join(out,'arrivals.jsonl'),JSON.stringify({event:'terminal_material',...entry})+'\n');
   check('240 unique planned inputs acknowledged and published with initial 160 unchanged',report.arrivals.uniqueAcknowledged===240&&arrivalRun.snapshot().pending===0);
  }else{
  for(let round=0;round<4;round++){
   // Three paced, real ingress batches run beside each complete UI journey. No synthetic busy loop.
   const producer=(async()=>{for(let k=0;k<3;k++){const at=Date.now(),start=fixture.initialIngress+(round*3+k)*20;await batch(start,start+20);await delay(Math.max(0,500-(Date.now()-at)));}})();producer.catch(()=>{});
   await measure('ingress','next-page',nextPage);await firstPage();const record=await measure('ingress','open-long',openLong);await measure('ingress','wheel',()=>wheel('ingress'));await measure('ingress','read-long',()=>readLong(record));await measure('ingress','original',()=>originalFromBody(record));await producer;
  }
  }
  await endMetrics();const state=await request('/api/fixture/state');if(independent)observe('final count is 400 load Materials plus one Note',state.count===401);else assert.equal(state.count,400);assert.equal(state.jobs.find(j=>j.id===job.id).status,'waiting_for_input');
  const intervals=independent?[...report.backgroundWrites.slice(firstIncremental).filter(b=>b.accepted).flatMap(b=>b.requests),...state.publications.map(e=>({start:Date.parse(e.publishedAt),end:Date.parse(e.publishedAt),sourceId:'publication-timestamp'})).filter(e=>e.start>=report.arrivals.wallStart)]:report.backgroundWrites.slice(firstIncremental).flatMap(b=>[...b.requests,...state.ticks.filter(t=>t.start>=b.start&&t.end<=b.end&&t.afterCount>t.beforeCount)]);
  for(const action of report.actions.filter(a=>a.phase==='ingress'))action.actualWorkOverlap=intervals.filter(b=>action.start<b.end&&action.end>b.start).map(b=>({start:b.start,end:b.end,sourceId:b.sourceId??'publication'}));
  report.actualWorkOverlapMeaning='Successful receipt HTTP intervals or persisted publication transaction timestamps; not instantaneous CPU execution';
  report.actionsDuringActualWork=report.actions.filter(a=>a.phase==='ingress'&&a.actualWorkOverlap.length).length;(independent?observe:check)('at least three actions overlap actual ingress or publication',report.actionsDuringActualWork>=3);
  await rateWindowBreak('after-ingress-before-cancel');await citationJourney(citation,citationRecord,'400');
  await js("location.hash='/library/memories'");await allHistory();await until(()=>js(`document.querySelector('.memory-progress')?.textContent.includes('等待资料处理')`),'waiting after navigation');
  const beforeCancel=await request('/api/fixture/state');await measure('400','cancel',async()=>{await click('取消未完成方案',"document.querySelector('.memory-progress')");await until(()=>js(`document.querySelector('.memory-progress')?.textContent.includes('记忆提取已停止')`),'cancelled progress');});
  const late=await request('/api/fixture/transcript',{});await delay(300);const cancelled=(await request('/api/fixture/state')).jobs.find(j=>j.id===job.id);
  check('late input cannot restart cancelled job',late.calls.length===beforeCancel.calls.length&&cancelled.status==='cancelled'&&cancelled.operation.state==='cancelled'&&cancelled.memoryIds.length===1);
  await screenshot('cancelled-desktop','.memory-progress');window.setSize(430,1000);await screenshot('cancelled-mobile','.memory-progress');window.setSize(1280,1000);
  await js("location.hash='/system/processing'");await until(()=>js(`!!document.querySelector('.processing-row')`),'processing centre');await click('已取消',"document.querySelector('[aria-label=\"任务状态\"]')");await until(()=>js(`document.querySelector('.processing-row')?.textContent.includes(${JSON.stringify('memory:'+job.id)})`),'cancelled operation in actual UI');check('operation list bounded',await js("document.querySelectorAll('.processing-list > .processing-row').length<=20"));await click('查看详情',"document.querySelector('.processing-row')");await until(()=>js(`document.querySelector('[aria-label="任务详情"] .badge')?.textContent==='已取消'`),'cancelled operation detail');await click('打开来源与处理操作',"document.querySelector('[aria-label=\"任务详情\"]')");await until(()=>js(`!!document.querySelector('.memory-job-history')`),'Memory destination');
  await js('location.reload()');await allHistory();await until(()=>js(`!!document.querySelector('.memory-job-history')`),'job history after reload');await js(`document.querySelector('.memory-job-history').open=true`);await until(()=>js(`(()=>{const b=[...document.querySelectorAll('.memory-job-history button')].find(b=>b.textContent.includes('记忆提取已停止'));if(!b)return false;b.click();return true;})()`),'select cancelled job history');await until(()=>js(`document.querySelector('.memory-progress')?.textContent.includes('记忆提取已停止')`),'cancelled persists after reload');await click('查看记忆',"document.querySelector('.memory-progress')");await until(()=>js(`document.querySelector('.memory-detail .status-label')?.textContent==='已生效'`),'saved result remains after cancel and reload');
  await rateWindowBreak('after-cancel-before-400');await materials();await click('刷新',"document.querySelector('.materials-browser')");await until(async()=> (await listTitles()).length===12,'400 refreshed first page');
  await beginMetrics('400-interactive');for(let i=0;i<3;i++){await measure('400','next-page',nextPage);await firstPage();const record=await measure('400','open-long',openLong);await measure('400','read-long',()=>readLong(record,i===0));if(i===0)await measure('400','wheel',()=>wheel('400'));}await endMetrics();
  await firstPage();const all=[];let pages=0;for(;;){const titles=await listTitles();if(independent)observe('UI page '+pages+' preserves frozen expected size',titles.length===(pages===33?5:12));else assert.equal(titles.length,pages===33?4:12);all.push(...titles);pages++;if(!await js(`[...${listScope}.querySelectorAll('button')].some(b=>b.textContent==='下一页')`))break;await measure('400-enumeration','next-page',nextPage);assert.ok(pages<35,'Pagination terminates');}
  if(independent){observe('all 400 load Materials plus 1 foreground Note enumerated across 34 bounded UI pages',pages===34&&new Set(all).size===401&&JSON.stringify([...all].sort())===JSON.stringify([...fixture.records.map(r=>r.title),fixture.control.title,...report.frontendNote.materials.map(r=>r.title)].sort()));}else{assert.equal(pages,34);assert.equal(new Set(all).size,400);assert.deepEqual([...all].sort(),[...fixture.records.map(r=>r.title),fixture.control.title].sort());check('all 400 Materials enumerated exactly across 34 bounded UI pages',true);}report.enumeratedTitles=all;
  const lists=report.requests.filter(r=>r.origin==='renderer'&&r.path.startsWith('/api/materials?'));check('renderer list requests explicitly bounded at 12',lists.length>0&&lists.every(r=>new URLSearchParams(r.path.split('?')[1]).get('limit')==='12'));
  await firstPage();await openLong();await screenshot('400-long-desktop','.material-detail');window.setSize(430,1000);await screenshot('400-long-mobile','.material-detail');await citationJourney(citation,citationRecord,'mobile');window.setSize(1280,1000);
  await beginMetrics('400-idle');await delay(1000);await endMetrics();
  report.stubCalls=(await request('/api/fixture/state')).calls;check('stub calls bounded and no transcript run',report.stubCalls.length<=4&&report.stubCalls.every(c=>c.recipe==='fixture.body-memory'));
 }
 const final=await request('/api/fixture/state');report.publishedRecords=final.count;report.peakServerRssBytes=final.peakRss;report.serverCpuUsageMicroseconds=final.cpuUsage;report.finalState=final;if(independent)observe('complete planned material and foreground Note count',final.count===fixture.total+1);else assert.equal(final.count,fixture.total);
 for(const name of ['crashes','httpErrors','consoleErrors','blockedRequests'])assert.deepEqual(report[name],[],name);
 report.timingSummary=Object.fromEntries([...new Set(report.actions.map(a=>a.phase+':'+a.name))].map(key=>{const values=report.actions.filter(a=>a.phase+':'+a.name===key).map(a=>a.durationMs).sort((a,b)=>a-b);return [key,{samples:values.length,medianMs:(values[Math.floor((values.length-1)/2)]+values[Math.floor(values.length/2)])/2,maxMs:values.at(-1)}];}));
 report.status=report.observationFailures?.length?'failed':'passed';if(report.status==='failed'){report.failure='Observation checks failed: '+report.observationFailures.join('; ');process.exitCode=1;}
 async function citationJourney(citation,record,phase){
  await js("location.hash='/ask?fixture=material-load'");await until(()=>js(`!!document.querySelector('.conversation-item')`),'generated conversation');await js(`document.querySelector('.conversation-item').click()`);await until(()=>js(`!!document.querySelector('.inline-citation')`),'generated citation');
  await measure(phase,'citation',async()=>{await js(`(()=>{window.fixtureOrigin=location.hash;window.fixtureOpener=document.querySelector('.inline-citation');window.fixtureOpener.focus();window.fixtureOpener.click();})()`);await until(async()=>await sourceText()===sliceBody(record.item.text,0).text,'citation opens exact Material range');assert.equal(await js(`new URLSearchParams(location.hash.split('?')[1]).get('evidence')`),citation.materialRef);check('citation focus enters actual dialog',await js(`document.querySelector('.evidence-modal').contains(document.activeElement)`));await screenshot('citation-'+phase,'.evidence-modal');await click('查看原始记录',"document.querySelector('.evidence-modal .source-material-view')");await until(()=>js(`new URLSearchParams(location.hash.split('?')[1]).get('evidence')===${JSON.stringify('capture:'+citation.recordId)}&&document.querySelector('.evidence-modal')?.textContent.includes(${JSON.stringify('HEAD '+String(record.index).padStart(4,'0'))})`),'citation original identity and text');await screenshot('original-'+phase,'.evidence-modal');await closeEvidence();});
 }
}
deadline=setTimeout(()=>{report.failure='Frozen ten-minute run deadline exceeded';report.status='failed';save();server?.kill('SIGTERM');window?.destroy();app.exit(1);},fixture.expectations.runTimeoutMs);
run().catch(async error=>{report.status='failed';report.failure=error.stack;process.exitCode=1;if(window&&!window.isDestroyed()){writeFileSync(join(out,'failure.png'),(await window.webContents.capturePage()).toPNG());writeFileSync(join(out,'failure-dom.txt'),await js('document.body.innerText'));}}).finally(async()=>{clearInterval(drainTimer);clearTimeout(outageTimer);clearTimeout(recoveryTimer);arrivalRun?.stop();await producerProxy?.close();await arrivalRun?.settled();if(inspectFixture&&server?.exitCode===null){try{const state=await inspectFixture();report.finalState=state;report.publishedRecords=state.count;report.peakServerRssBytes=state.peakRss;report.serverCpuUsageMicroseconds=state.cpuUsage;}catch(error){report.finalInspectionError=error.message;}}if(independent&&window&&!window.isDestroyed()){try{if(await js('!!window.uiMetrics?.running'))await endMetrics();}catch(error){report.finalMetricsError=error.message;}}clearTimeout(deadline);report.endedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,report:join(out,'report.json'),failure:report.failure}));window?.destroy();if(server?.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('close',r)),delay(3000)]);if(server.exitCode===null)server.kill('SIGKILL');}if(report.status==='passed'&&!keepVault)rmSync(root,{recursive:true,force:true});report.vault.retained=existsSync(root);report.vault.reason=report.status!=='passed'?'failure':keepVault?'explicit_success_retention':'default_success_cleanup';save();app.exit(process.exitCode||0);});
