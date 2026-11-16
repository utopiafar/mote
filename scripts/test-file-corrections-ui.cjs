require('./fixture-background.cjs');
require('./fixture-language.cjs');
/** Two real renderers and owner APIs, generated PCM/transcripts and a proposal stub. */
const {app,BrowserWindow}=require('electron'),{mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os'),{join,resolve}=require('node:path'),{spawn,execFileSync}=require('node:child_process'),{randomBytes,createHash}=require('node:crypto'),assert=require('node:assert/strict');
const {diarizationPresentation,englishFileBoundaries,selectedCorrectionCaption}=require('./file-presentation-probe.cjs');
const {rolloutPresentation}=require('./rollout-presentation-probe.cjs');
const presentationOnly=process.argv.includes('--presentation-only');
const repo=resolve(__dirname,'..'),root=mkdtempSync(join(tmpdir(),'mote-file-correction-ui-'));
const outputRoot=process.env.MOTE_UI_OUTPUT_DIR||join(repo,'.mote/file-corrections-ui');mkdirSync(outputRoot,{recursive:true});const out=mkdtempSync(join(outputRoot,'run-'));
app.setPath('userData',join(root,'browser'));app.on('window-all-closed',()=>{});
const report={status:'running',head:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),personalDataUsed:false,modelInvoked:false,transcriptionStub:true,proposalStub:true,presentationOnly,physicalDevicesTested:false,checks:[],httpErrors:[],crashes:[]};
report.codeHashes=Object.fromEntries(['scripts/test-file-corrections-ui.cjs','scripts/file-corrections-fixture.mjs','scripts/file-presentation-fixture.mjs','scripts/file-presentation-probe.cjs','apps/server/dist/capture-browser.js','apps/server/dist/materials.js','apps/server/dist/source-material-view.js','apps/server/dist/evidence-reader.js','apps/server/dist/evidence-routes.js','apps/server/dist/evidence-scope-record.js','apps/web/dist/index.html'].map(path=>[path,createHash('sha256').update(readFileSync(join(repo,path))).digest('hex')]));
const webSourceIdentity=()=>Object.fromEntries(execFileSync('git',['ls-files','apps/web','packages/shared/design-tokens.json','packages/shared/src/i18n-en.ts'],{cwd:repo,encoding:'utf8'}).trim().split('\n').filter(Boolean).map(path=>[path,createHash('sha256').update(readFileSync(join(repo,path))).digest('hex')]));
const webBuildIdentity=()=>Object.fromEntries(readdirSync(join(repo,'apps/web/dist/assets')).map(path=>[path,createHash('sha256').update(readFileSync(join(repo,'apps/web/dist/assets',path))).digest('hex')]));
report.sourceIdentity=webSourceIdentity();report.buildIdentity=webBuildIdentity();
const save=()=>writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));let server;const windows=[];
async function until(fn,label,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await delay(100);}throw Error('Timeout: '+label);}
function check(name,pass){report.checks.push({name,pass:Boolean(pass)});save();}
function controls(window){const wc=window.webContents,js=code=>wc.executeJavaScript(code);return {wc,js,click:async text=>until(()=>js(`(()=>{const e=[...document.querySelectorAll('button,summary')].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)return false;e.click();return true;})()`),text)};}
async function run(){
 await app.whenReady();const token=randomBytes(32).toString('hex'),ready=join(root,'ready.json'),configPath=join(root,'config.json');
 const config={dataDir:join(root,'vault'),token,tokenPath:join(root,'token'),host:'127.0.0.1',port:0,maxExportBytes:1000000,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 writeFileSync(configPath,JSON.stringify({config,ready}),{mode:0o600});
 server=spawn('node',[join(repo,presentationOnly?'scripts/file-presentation-fixture.mjs':'scripts/file-corrections-fixture.mjs'),configPath],{cwd:repo,env:Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]])),stdio:['ignore','ignore','pipe']});let stderr='';server.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-12000);report.fixtureStderr=stderr;});
 await until(()=>{if(server.exitCode!==null)throw Error(stderr);return existsSync(ready);},'fixture server');
 const info=JSON.parse(readFileSync(ready,'utf8')),endpoint='http://127.0.0.1:'+info.port;
 const request=async(path,body)=>{const r=await fetch(endpoint+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,`${path}: ${r.status} ${await(r.ok?Promise.resolve(''):r.text())}`);return r.json();};
 const presentationFetchObserver=`(()=>{if(window.__filePresentationObserved)return true;window.__filePresentationObserved=true;window.__filePresentationPending=0;window.__filePresentationLastSettled=performance.now();const previous=window.fetch.bind(window);window.fetch=async(input,init)=>{const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;if(![${JSON.stringify('/api/files/'+info.fileId)},${JSON.stringify('/api/files/'+info.fileId+'/reviews')}].includes(path)||init?.method&&init.method!=='GET')return previous(input,init);window.__filePresentationPending++;try{const result=await previous(input,init);if(result.headers.get('content-type')?.includes('application/json'))await result.clone().arrayBuffer();return result;}finally{window.__filePresentationPending--;window.__filePresentationLastSettled=performance.now();}};return true})()`;
 async function open(){const win=new BrowserWindow({width:1180,height:950,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});windows.push(win);const ui=controls(win);ui.wc.on('render-process-gone',(_e,data)=>report.crashes.push(data.reason));await win.loadURL(endpoint);ui.wc.debugger.attach('1.3');await ui.wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});await until(()=>ui.js("!!document.querySelector('.simple-welcome button')"),'generated signed-out entry');assert.equal(await ui.js("document.querySelector('.simple-welcome button').classList.contains('primary')"),false,'Login opener retains the secondary navigation role');await ui.js("document.querySelector('.simple-welcome button').click();true");await until(()=>ui.js("!!document.querySelector('.connect-modal input[type=password]')"),'actual masked login');await ui.js(`(()=>{const input=document.querySelector('.connect-modal input[type=password]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(token)});input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);await until(()=>ui.js("!!document.querySelector('.connect-modal .button.primary:not(:disabled)')"),'actual login enabled');await ui.js("document.querySelector('.connect-modal .button.primary').click();true");await until(()=>ui.js("!!document.querySelector('.home-page')"),'authenticated generated Home');await ui.js(presentationFetchObserver);await ui.click('资料库');return {win,...ui};}
 const material=presentationOnly?null:await open();if(!presentationOnly){material.wc.session.webRequest.onCompleted(data=>{if(data.statusCode>=400)report.httpErrors.push({path:new URL(data.url).pathname,status:data.statusCode});});
 await material.click('正式资料');await until(()=>material.js(`!!document.querySelector('.materials-browser .source-item')`),'material row');await material.js(`([...document.querySelectorAll('.materials-browser .source-item')].find(e=>e.textContent.includes(${JSON.stringify(info.name)}))).click()`);await until(()=>material.js(`document.querySelector('.material-detail')?.textContent.includes('周三')`),'initial material');
 check('formal file view shows confirmed names and readable speech',await material.js(`document.querySelector('.source-material-view')?.textContent.includes('已确认说话人：林工（生成）')&&document.querySelector('.source-material-view .file-text')?.textContent.includes('我修好了旧相框')`));
 check('formal reading view hides storage fields',await material.js(`!document.querySelector('.source-material-view')?.textContent.includes('confirmationId')`));
 await material.click('查看原始结构');check('raw material structure remains available',await material.js(`document.querySelector('.material-detail')?.textContent.includes('confirmationId')`));await material.click('返回阅读视图');await until(()=>material.js(`document.querySelector('.source-material-view')?.textContent.includes('周三')`),'readable material returns');
 material.win.show();material.win.focus();for(const width of [1180,430]){material.win.setSize(width,950);await material.js(`document.querySelector('.source-material-view').scrollIntoView({block:'start',behavior:'instant'})`);await delay(200);check('readable material has no horizontal overflow at '+width,await material.js(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.source-material-view').scrollWidth<=document.querySelector('.source-material-view').clientWidth`));writeFileSync(join(out,'source-material-'+width+'.png'),(await material.wc.capturePage()).toPNG());}material.win.setSize(1180,950);
 writeFileSync(join(out,'before-material.png'),(await material.wc.capturePage()).toPNG());
 }
 const file=await open();if(presentationOnly)await file.js("document.querySelector('.library-navigation button[data-collection-id=files]').click();true");else await file.click('文件与录音');await until(()=>file.js(`!!document.querySelector('.file-card')`),'file row');await file.js(`document.querySelector('.file-card').click()`);await file.click('展开转写 / 原文片段');await until(()=>file.js(`document.querySelectorAll('.file-text').length===2`),'file transcript');
 check('confirmed names visible beside transcript',await file.js(`[...document.querySelectorAll('.file-text')].some(e=>e.parentElement.textContent.includes('林工（生成）'))`));
 // The actual language control reloads the same file, then native controls drive all count modes.
 async function reopenFile(locale){
  file.win.setSize(1440,950);await until(()=>file.js('innerWidth===1440'),'visible language control viewport');
  if(await file.js('document.documentElement.lang')!==locale){
   await file.js(`(()=>{window.confirm=()=>true;const s=[...document.querySelectorAll('.language-selector select')].find(e=>e.getClientRects().length);s.value=${JSON.stringify(locale)};s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
   await until(()=>file.js(`document.documentElement.lang===${JSON.stringify(locale)}&&!!document.querySelector('.file-card')`),'actual file language reload');
   await file.js(presentationFetchObserver);
   await file.js("document.querySelector('.file-card').click();true");
   await until(()=>file.js("!!document.querySelector('.file-detail')"),'file detail restored');
  }
 }
 for(const locale of ['zh-CN','en']){
  await reopenFile(locale);
  await file.js("document.querySelectorAll('.file-detail details:not([open])').forEach(e=>e.querySelector('summary').click());true");
  for(const width of [1440,1101,1100,820,801,800,390,320])for(const mode of ([800,801,1100,1101].includes(width)?['unknown']:['unknown','exact','range'])){
   file.win.setSize(width,950);await until(()=>file.js(`innerWidth===${width}`),'diarization viewport');
   if(presentationOnly&&width===1440&&mode!=='unknown'){
    await file.js("(()=>{const select=document.querySelectorAll('.file-diarization-fields select')[1];select.scrollIntoView({block:'center',behavior:'instant'});select.focus();return true})()");
    check('native count mode owns focus before '+locale+'/'+mode,await file.js("(()=>{const s=document.querySelectorAll('.file-diarization-fields select')[1],r=s.getBoundingClientRect();return document.activeElement===s&&r.width>0&&r.height>0})()"));
    // A closed macOS menu-list supports native typeahead without opening an OS popup.
    // Separate choices need the normal typeahead reset interval; this is input timing, not a layout fallback.
    await file.js("(()=>{window.__fileNativeCountEvents=[];const s=document.querySelectorAll('.file-diarization-fields select')[1];s.addEventListener('change',event=>window.__fileNativeCountEvents.push({trusted:event.isTrusted,value:event.target.value}),{once:true});return true})()");
    if(mode==='range')await delay(1200);
    const prefix=await file.js(`([...document.querySelectorAll('.file-diarization-fields select')[1].options].find(option=>option.value===${JSON.stringify(mode)}).textContent.trim()[0])`);
    await file.wc.debugger.sendCommand('Input.dispatchKeyEvent',{type:'char',text:prefix});
    await until(()=>file.js(`document.querySelectorAll('.file-diarization-fields select')[1].value===${JSON.stringify(mode)}`),'native keyboard count mode '+locale+'/'+mode);
    const nativeEvents=await file.js('window.__fileNativeCountEvents');check('native keyboard selects count mode '+locale+'/'+mode,nativeEvents.some(event=>event.trusted&&event.value===mode));report.nativeCountGestures??=[];report.nativeCountGestures.push({locale,mode,prefix,method:'Chromium trusted native typeahead',resetMs:mode==='range'?1200:0,nativeEvents});
   }else await file.js(`(()=>{const select=document.querySelectorAll('.file-diarization-fields select')[1];select.value=${JSON.stringify(mode)};select.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
   await until(()=>file.js(`document.querySelectorAll('.file-diarization-fields input[type=number]').length===${mode==='unknown'?0:mode==='exact'?1:2}`),'original count fields');
   const appearance=await file.js('('+diarizationPresentation.toString()+')()');
   const roles=await file.js('('+rolloutPresentation.toString()+')()');check('Actual named file execution roles '+locale+'/'+width+'/'+mode,roles.checks.every(item=>item.pass));report.rolePresentation??=[];report.rolePresentation.push({locale,width,mode,...roles});
   check(`per-file selected values and whole primary action remain readable ${locale}/${width}/${mode}`,appearance.border==='solid'&&appearance.radius>0&&appearance.primary&&appearance.buttonComplete&&appearance.hit&&appearance.limit&&appearance.fit&&appearance.selections.every(s=>s.complete)&&appearance.words.every(w=>w.lines===1)&&appearance.mediumLayout.masterHidden===(width<=1100));
   report.presentation??=[];report.presentation.push({locale,width,mode,appearance});
   writeFileSync(join(out,`file-diarization-${locale}-${width}-${mode}.png`),(await file.wc.capturePage()).toPNG());
  }
  file.win.setSize(820,950);await until(()=>file.js('innerWidth===820'),'medium Back viewport');
  await file.js("document.querySelector('.library-back').scrollIntoView({block:'center',behavior:'instant'});document.querySelector('.library-back').click();true");
  await until(()=>file.js("!document.querySelector('.file-detail')&&!!document.querySelector('.file-card')"),'original Back returns current file list');
  check('medium selected detail preserves real Back to list '+locale,true);
  await file.js("document.querySelector('.file-card').click();true");await until(()=>file.js("!!document.querySelector('.file-detail')"),'original file can reopen after Back');
  await file.js("document.querySelectorAll('.file-detail details:not([open])').forEach(e=>e.querySelector('summary').click());true");
  if(locale==='en'){
   const boundaries=await file.js('('+englishFileBoundaries.toString()+')()');
   check('English file status and policy labels retain word boundaries',Object.values(boundaries).every(Boolean));report.englishBoundaries=boundaries;
  }
 }
 await reopenFile('zh-CN');file.win.setSize(1180,950);
 await file.js("document.querySelectorAll('.file-detail details[open]').forEach(e=>e.querySelector('summary').click());true");
 await file.click('场次关联与术语复核');await file.click('检查可能的识别错误');await until(()=>file.js(`!!document.querySelector('.file-detail input[type="checkbox"]:not(:disabled)')`),'proposal');
 if(presentationOnly){
  await reopenFile('en');
  await file.js("document.querySelectorAll('.file-detail details:not([open])').forEach(e=>e.querySelector('summary').click());true");
  await until(()=>file.js("!!document.querySelector('.file-detail input[type=checkbox]:not(:disabled)')"),'persisted generated proposal');
  await file.js("document.querySelector('.file-detail input[type=checkbox]:not(:disabled)').click();true");
  for(const width of [1440,390,320]){file.win.setSize(width,950);await until(()=>file.js('innerWidth==='+width),'confirmation width');const caption=await file.js('('+selectedCorrectionCaption.toString()+')()');check('English selected correction action is complete and reachable at '+width,caption.present&&caption.enabled&&caption.complete&&caption.hit);writeFileSync(join(out,'selected-correction-en-'+width+'.png'),(await file.wc.capturePage()).toPNG());}
  await file.click('Confirm selected corrections');
  await until(async()=>{const state=await request('/api/fixture/state');return state.chunks.some(chunk=>chunk.ocrText.includes('周六'));},'real English correction confirmation');
  await until(()=>file.js('window.__filePresentationPending===0&&performance.now()-window.__filePresentationLastSettled>180'),'real renderer correction fetch settled');
  await file.click('Expand transcript / source segments');
  await until(()=>file.js("[...document.querySelectorAll('.file-text')].some(element=>element.textContent.includes('周六'))"),'corrected English reading consumer');
  check('English confirmation updates the actual readable transcript',true);
  check('only the generated proposal was used',(await request('/api/fixture/state')).proposalStubCalls===1);
  assert.ok(report.checks.every(check=>check.pass),JSON.stringify(report.checks.filter(check=>!check.pass)));assert.deepEqual(webSourceIdentity(),report.sourceIdentity,'Web source unchanged through presentation journey');assert.deepEqual(webBuildIdentity(),report.buildIdentity,'Web assets unchanged through presentation journey');report.status='passed';return;
 }
 await file.js(`document.querySelector('.file-detail input[type="checkbox"]:not(:disabled)').click()`);await file.click('确认所选校正');await until(async()=>{const s=await request('/api/fixture/state');return s.chunks.some(c=>c.ocrText.includes('周六'));},'confirmed source change');
 await file.click('展开转写 / 原文片段');await until(()=>file.js(`document.querySelector('.file-detail')?.textContent.includes('下一次讨论安排在周六')`),'updated transcript');
 const pending=await request('/api/fixture/state');report.pending={coverage:pending.material.coverage,memories:pending.memories.map(m=>({title:m.title,status:m.status}))};
 check('only changed memory is stale before rebuild',pending.memories[0].status==='published'&&pending.memories[1].status==='stale');
 material.win.show();material.win.focus();file.win.hide();await until(()=>report.httpErrors.some(e=>e.path.endsWith('/read')&&e.status===409),'pending material read');await delay(200);
 check('pending material hides old cached prose',await material.js(`!document.querySelector('.material-detail')?.textContent.includes('下一次讨论安排在周三')`));
 check('pending material has a readable status',await material.js(`document.querySelector('.material-detail [role="status"]')?.textContent.includes('正在重新整理')`));
 await material.js(`document.querySelector('.material-detail').scrollIntoView({block:'start'})`);writeFileSync(join(out,'pending-material.png'),(await material.wc.capturePage()).toPNG());
 const rebuilt=await request('/api/fixture/rebuild',{});assert.notEqual(rebuilt.material.ref,pending.material.ref);
 await until(()=>material.js(`!document.querySelector('.material-detail [role="alert"]')`),'historical read resumes');await delay(5500);
 const history=await material.js(`document.querySelector('.material-detail')?.textContent.includes('历史版本')`);check('old revision is explicitly historical',history);
 const hasCurrent=await material.js(`[...document.querySelectorAll('.material-detail button')].some(e=>e.textContent==='查看当前版本')`);check('current revision is reachable from history',hasCurrent);
 if(hasCurrent){await material.click('查看当前版本');await until(()=>material.js(`document.body.innerText.includes('下一次讨论安排在周六')`),'current reference');}
 else {await material.click('刷新');await until(()=>material.js(`!!document.querySelector('.materials-browser .source-item')`),'new material row');await material.js(`document.querySelector('.materials-browser .source-item').click()`);await until(()=>material.js(`document.querySelector('.material-detail')?.textContent.includes('周六')`),'rebuilt material');}
 writeFileSync(join(out,'current-material.png'),(await material.wc.capturePage()).toPNG());
 file.win.show();file.win.focus();await file.click('说话人试听与命名');
 await file.js(`(()=>{const label=[...document.querySelectorAll('.file-detail label')].find(e=>e.textContent.includes('SPEAKER_1')&&e.querySelector('input:not([type="checkbox"])'));const input=label.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'陈工（生成）');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await file.click('确认说话人名称');
 await until(async()=>{const s=await request('/api/fixture/state');return s.chunks.some(c=>c.fileEvidence.speakerAttribution?.name==='陈工（生成）');},'name correction');
 await file.click('展开转写 / 原文片段');await until(()=>file.js(`document.querySelectorAll('.file-text').length===2`),'renamed chunks');
 check('corrected name visible beside transcript',await file.js(`[...document.querySelectorAll('.file-text')].some(e=>e.parentElement.textContent.includes('陈工（生成）'))`));
 const final=await request('/api/fixture/rebuild',{});check('unrelated memory survives text and name corrections',final.memories[0].status==='published');check('only the proposal stub was used',final.proposalStubCalls===1);
 for(const width of [1180,430]){file.win.setSize(width,950);await file.js(`([...document.querySelectorAll('.file-text')].at(-1)).scrollIntoView({block:'center'})`);await delay(200);check('no horizontal overflow at '+width,await file.js(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.evidence-modal').scrollWidth<=document.querySelector('.evidence-modal').clientWidth`));check('transcript is reachable by scrolling at '+width,await file.js(`(()=>{const r=[...document.querySelectorAll('.file-text')].at(-1).getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})()`));writeFileSync(join(out,'file-'+width+'.png'),(await file.wc.capturePage()).toPNG());}
 material.win.show();material.win.focus();await material.js(`document.querySelector('button[aria-label="关闭证据详情"]')?.click()`);await material.click('记忆');
 await until(()=>material.js(`document.querySelectorAll('.workspace-select').length===2`),'memory list');
 for(const [title,status] of [['合成计划记忆','需要重验'],['合成相框经历','已生效']]){
   await material.js(`([...document.querySelectorAll('.workspace-select')].find(e=>e.textContent.includes(${JSON.stringify(title)}))).click()`);
   await until(()=>material.js(`document.querySelector('.memory-detail h2')?.textContent===${JSON.stringify(title)}`),'memory detail '+title);
   check(title+' displays its correct status',await material.js(`document.querySelector('.memory-detail .status-label')?.textContent===${JSON.stringify(status)}`));
   if(status==='需要重验'){
     check('stale memory explains the correction and retains the original quote',await material.js(`document.querySelector('.memory-detail')?.textContent.includes('证据发生了变化')&&document.querySelector('.memory-evidence')?.textContent.includes('周三')`));
     await material.js(`document.querySelector('.memory-detail').scrollIntoView({block:'start',behavior:'instant'})`);await delay(200);check('stale memory detail is visible after scrolling',await material.js(`(()=>{const r=document.querySelector('.memory-detail h2').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})()`));writeFileSync(join(out,'stale-memory.png'),(await material.wc.capturePage()).toPNG());
     await material.js(`document.querySelector('.memory-evidence .evidence-card').click()`);await until(()=>material.js(`document.querySelector('.evidence-modal')?.textContent.includes('下一次讨论安排在周三')`),'historical memory evidence');
     check('changed memory opens its historical quote with an explicit label',await material.js(`document.querySelector('.evidence-modal [role="status"]')?.textContent.includes('历史证据')`));
     writeFileSync(join(out,'historical-evidence.png'),(await material.wc.capturePage()).toPNG());await material.js(`document.querySelector('button[aria-label="关闭证据详情"]').click()`);
   }
 }
 await material.js(`document.querySelector('.memory-evidence .evidence-card').click()`);await until(()=>material.js(`document.querySelector('.evidence-modal')?.textContent.includes('我修好了旧相框，当时很开心')`),'preserved memory evidence');
 check('unaffected memory evidence remains reachable',await material.js(`!document.querySelector('.evidence-modal [role="alert"]')`));writeFileSync(join(out,'memory-evidence.png'),(await material.wc.capturePage()).toPNG());
 await material.js(`document.querySelector('button[aria-label="关闭证据详情"]').click()`);await material.click('正式资料');await until(()=>material.js(`[...document.querySelectorAll('.materials-browser .source-item')].some(e=>e.textContent.includes(${JSON.stringify(info.diary.title)}))`),'authored material row');
 await material.js(`([...document.querySelectorAll('.materials-browser .source-item')].find(e=>e.textContent.includes(${JSON.stringify(info.diary.title)}))).click()`);await until(()=>material.js(`document.querySelector('.source-material-view')?.textContent.includes(${JSON.stringify(info.diary.text)})`),'authored reading view');
 check('authored source renders readable original through the same plugin',await material.js(`document.querySelector('.source-material-view .file-text')?.textContent===${JSON.stringify(info.diary.text)}`));
 check('recorded, occurred and collected times have separate labels',await material.js(`(()=>{const text=document.querySelector('.source-material-view').textContent;return ['记录时间：','发生时间：','采集于'].every(label=>text.includes(label))&&!text.includes('documentTime');})()`));
 for(const width of [1180,430]){material.win.setSize(width,950);await material.js(`document.querySelector('.source-material-view').scrollIntoView({block:'start',behavior:'instant'})`);await delay(200);check('authored material has no horizontal overflow at '+width,await material.js(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.source-material-view').scrollWidth<=document.querySelector('.source-material-view').clientWidth`));writeFileSync(join(out,'authored-material-'+width+'.png'),(await material.wc.capturePage()).toPNG());}
 await material.click('查看原始记录');await until(()=>material.js(`document.querySelector('.evidence-modal')?.textContent.includes(${JSON.stringify(info.diary.text)})`),'authored original evidence');check('authored reading view links to its preserved original',await material.js(`!document.querySelector('.evidence-modal [role="alert"]')`));
 check('renderer stays alive',report.crashes.length===0);report.finalMemories=final.memories.map(m=>({title:m.title,status:m.status}));
 assert.ok(report.checks.every(c=>c.pass),JSON.stringify(report.checks.filter(c=>!c.pass)));report.status='passed';
}
run().catch(async error=>{report.status='failed';report.failure=error.stack;process.exitCode=1;for(const [i,w] of windows.entries())if(!w.isDestroyed()){writeFileSync(join(out,'failure-'+i+'.png'),(await w.webContents.capturePage()).toPNG());writeFileSync(join(out,'failure-'+i+'.txt'),await w.webContents.executeJavaScript('document.body.innerText'));}}).finally(async()=>{save();console.log(JSON.stringify({status:report.status,report:join(out,'report.json'),failure:report.failure}));for(const w of windows)w.destroy();if(server?.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('close',r)),delay(3000)]);}if(report.status==='passed')rmSync(root,{recursive:true,force:true});app.exit(process.exitCode||0);});
