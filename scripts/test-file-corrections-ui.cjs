require('./fixture-language.cjs');
/** Two real renderers and owner APIs, generated PCM/transcripts and a proposal stub. */
const {app,BrowserWindow}=require('electron'),{mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os'),{join,resolve}=require('node:path'),{spawn,execFileSync}=require('node:child_process'),{randomBytes,createHash}=require('node:crypto'),assert=require('node:assert/strict');
const repo=resolve(__dirname,'..'),root=mkdtempSync(join(tmpdir(),'mote-file-correction-ui-'));
const outputRoot=process.env.MOTE_UI_OUTPUT_DIR||join(repo,'.mote/file-corrections-ui');mkdirSync(outputRoot,{recursive:true});const out=mkdtempSync(join(outputRoot,'run-'));
app.setPath('userData',join(root,'browser'));app.on('window-all-closed',()=>{});
const report={status:'running',head:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),personalDataUsed:false,modelInvoked:false,transcriptionStub:true,proposalStub:true,physicalDevicesTested:false,checks:[],httpErrors:[],crashes:[]};
report.codeHashes=Object.fromEntries(['scripts/test-file-corrections-ui.cjs','scripts/file-corrections-fixture.mjs','apps/server/dist/capture-browser.js','apps/server/dist/evidence-reader.js','apps/server/dist/evidence-routes.js','apps/server/dist/evidence-scope-record.js','apps/web/dist/index.html'].map(path=>[path,createHash('sha256').update(readFileSync(join(repo,path))).digest('hex')]));
const save=()=>writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));let server;const windows=[];
async function until(fn,label,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await delay(100);}throw Error('Timeout: '+label);}
function check(name,pass){report.checks.push({name,pass:Boolean(pass)});save();}
function controls(window){const wc=window.webContents,js=code=>wc.executeJavaScript(code);return {wc,js,click:async text=>until(()=>js(`(()=>{const e=[...document.querySelectorAll('button,summary')].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)return false;e.click();return true;})()`),text)};}
async function run(){
 await app.whenReady();const token=randomBytes(32).toString('hex'),ready=join(root,'ready.json'),configPath=join(root,'config.json');
 const config={dataDir:join(root,'vault'),token,tokenPath:join(root,'token'),host:'127.0.0.1',port:0,maxStorageBytes:30000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 writeFileSync(configPath,JSON.stringify({config,ready}),{mode:0o600});
 server=spawn('node',[join(repo,'scripts/file-corrections-fixture.mjs'),configPath],{cwd:repo,env:Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]])),stdio:['ignore','ignore','pipe']});let stderr='';server.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-12000);report.fixtureStderr=stderr;});
 await until(()=>{if(server.exitCode!==null)throw Error(stderr);return existsSync(ready);},'fixture server');
 const info=JSON.parse(readFileSync(ready,'utf8')),endpoint='http://127.0.0.1:'+info.port;
 const request=async(path,body)=>{const r=await fetch(endpoint+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,`${path}: ${r.status} ${await(r.ok?Promise.resolve(''):r.text())}`);return r.json();};
 async function open(){const win=new BrowserWindow({width:1180,height:950,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});windows.push(win);const ui=controls(win);ui.wc.on('render-process-gone',(_e,data)=>report.crashes.push(data.reason));await win.loadURL(endpoint);await ui.js(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({token}))});location.reload()`);await ui.click('资料库');return {win,...ui};}
 const material=await open();material.wc.session.webRequest.onCompleted(data=>{if(data.statusCode>=400)report.httpErrors.push({path:new URL(data.url).pathname,status:data.statusCode});});
 await material.click('正式资料');await until(()=>material.js(`!!document.querySelector('.materials-browser .source-item')`),'material row');await material.js(`document.querySelector('.materials-browser .source-item').click()`);await until(()=>material.js(`document.querySelector('.material-detail')?.textContent.includes('周三')`),'initial material');
 writeFileSync(join(out,'before-material.png'),(await material.wc.capturePage()).toPNG());
 const file=await open();await file.click('文件与录音');await until(()=>file.js(`!!document.querySelector('.file-card')`),'file row');await file.js(`document.querySelector('.file-card').click()`);await file.click('展开转写 / 原文片段');await until(()=>file.js(`document.querySelectorAll('.file-text').length===2`),'file transcript');
 check('confirmed names visible beside transcript',await file.js(`[...document.querySelectorAll('.file-text')].some(e=>e.parentElement.textContent.includes('林工（生成）'))`));
 await file.click('场次关联与术语复核');await file.click('检查可能的识别错误');await until(()=>file.js(`!!document.querySelector('.file-detail input[type="checkbox"]:not(:disabled)')`),'proposal');
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
 for(const [title,status] of [['合成计划记忆','需要重验'],['合成相框经历','已确认']]){
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
 check('renderer stays alive',report.crashes.length===0);report.finalMemories=final.memories.map(m=>({title:m.title,status:m.status}));
 assert.ok(report.checks.every(c=>c.pass),JSON.stringify(report.checks.filter(c=>!c.pass)));report.status='passed';
}
run().catch(async error=>{report.status='failed';report.failure=error.stack;process.exitCode=1;for(const [i,w] of windows.entries())if(!w.isDestroyed()){writeFileSync(join(out,'failure-'+i+'.png'),(await w.webContents.capturePage()).toPNG());writeFileSync(join(out,'failure-'+i+'.txt'),await w.webContents.executeJavaScript('document.body.innerText'));}}).finally(async()=>{save();console.log(JSON.stringify({status:report.status,report:join(out,'report.json'),failure:report.failure}));for(const w of windows)w.destroy();if(server?.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('close',r)),delay(3000)]);}if(report.status==='passed')rmSync(root,{recursive:true,force:true});app.exit(process.exitCode||0);});
