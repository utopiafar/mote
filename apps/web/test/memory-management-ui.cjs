require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');
// Generated archive and actual renderer/API. No personal data, model calls or device capture.
const {app,BrowserWindow}=require('electron');
const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os'),{join,resolve}=require('node:path'),{pathToFileURL}=require('node:url');
const {spawn}=require('node:child_process'),{randomBytes}=require('node:crypto'),assert=require('node:assert/strict');
const repo=resolve(__dirname,'../../..'),root=mkdtempSync(join(tmpdir(),'mote-memory-management-ui-'));
const out=join(repo,'.mote/memory-management-ui');mkdirSync(out,{recursive:true});
app.setPath('userData',join(root,'browser'));app.on('window-all-closed',()=>{});
let server,window;
const report={passed:false,actualRenderer:true,actualHttpApi:true,personalDataUsed:false,liveModel:false,physicalDevicesTested:false,checks:[],screenshots:out};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await delay(80);}throw Error('Timeout: '+label);}
function check(name,value){assert.ok(value,name);report.checks.push(name);}
async function run(){
 await app.whenReady();const token=randomBytes(32).toString('hex'),runner=join(root,'server.mjs'),ready=join(root,'ready');
 const config={dataDir:join(root,'data'),token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent'};
 writeFileSync(runner,`import {buildApp} from ${JSON.stringify(pathToFileURL(join(repo,'apps/server/dist/app.js')).href)};import {writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const node=await buildApp(${JSON.stringify(config)},{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('Fixture must not invoke a model');},close:async()=>{}}});
const lifecycle=node.lifecycle.settings();for(const name of ['consolidation','working','insights'])lifecycle[name].enabled=false;await node.lifecycle.save({revision:node.configService.revision,settings:lifecycle});
node.sources.register({id:'generated',name:'Generated source',kind:'custom',deviceId:'fixture',platform:'import'});
const at=new Date().toISOString(),text='Generated owner: use a written checklist for batch changes.',r=await node.sources.upsert('generated',{externalId:'one',revision:'1',observedAt:at,kind:'message',layer:'original',text});
const answer=JSON.stringify({memories:[{title:'Generated checklist preference',statement:text+' ['+r.id+']',uncertainty:'Generated fixture only',admission:{layer:'memory',reason:'Explicit owner preference',scope:'Fixture',attribution:'user'},evidenceIds:[r.id],evidence:[{id:r.id,quote:text}]}]});
node.memories.extract({answer,citations:[{id:r.id,capturedAt:at,appName:'Generated source',excerpt:text}],trace:[],runId:'fixture-review'},'fixture',{reviewReceipt:{policy:'bounded-exact-review@1',decision:'independent',draftRunId:'fixture-draft',reviewRunId:'fixture-review',checkedAt:at,resultHash:createHash('sha256').update(answer).digest('hex'),deletionSnapshot:node.memories.deletions.snapshot()}});
let failDelete=false;node.app.addHook('onRequest',async(req,reply)=>{if(failDelete&&req.method==='DELETE'&&req.url.startsWith('/api/memories/')){failDelete=false;return reply.code(503).send({error:'Generated transient delete failure'});}});
node.app.post('/api/fixture/fail-delete',async()=>{failDelete=true;return {ok:true};});
node.app.get('/api/fixture/state',async()=>({captureId:r.id,originalAvailable:node.memories.readEvidence([r.id]).length===1,jobs:node.memoryPipeline.list()}));
await node.app.listen({host:'127.0.0.1',port:0});writeFileSync(${JSON.stringify(ready)},String(node.app.server.address().port));process.once('SIGTERM',async()=>{await node.app.close();process.exit(0);});`,{mode:0o600});
 server=spawn(process.env.MOTE_FIXTURE_NODE||process.execPath,[runner],{cwd:repo,env:{...Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]])),ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','ignore','pipe']});
 let stderr='';server.stderr.on('data',c=>stderr=(stderr+c).slice(-12000));
 await until(()=>{if(server.exitCode!==null)throw Error(stderr);return existsSync(ready);},'fixture server');const url='http://127.0.0.1:'+readFileSync(ready,'utf8');
 const request=async(path,body)=>{const response=await fetch(url+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});assert.equal(response.ok,true,`${path}: ${response.status}`);return response.json();};
 window=new BrowserWindow({width:1280,height:1000,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const wc=window.webContents,js=s=>wc.executeJavaScript(s);
 const visible=s=>js(`(()=>{const e=document.querySelector(${JSON.stringify(s)});return !!e&&!!e.getClientRects().length&&e.checkVisibility();})()`);
 const click=text=>until(()=>js(`(()=>{const e=[...document.querySelectorAll('button,summary')].find(e=>e.checkVisibility()&&e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)return false;e.scrollIntoView({block:'center',behavior:'instant'});e.click();return true;})()`),'visible control '+text);
 const screenshot=async name=>{check('no horizontal overflow: '+name,await js('document.documentElement.scrollWidth<=innerWidth'));writeFileSync(join(out,name+'.png'),(await wc.capturePage()).toPNG());};
 await window.loadURL(url);await click('登录 Mote');await until(()=>visible('.connect-modal input[type=password]'),'login field');
 await js(`(()=>{const e=document.querySelector('.connect-modal input[type=password]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(token)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await until(()=>js(`(()=>{const e=document.querySelector('.connect-modal form .button.primary');if(!e||e.disabled)return false;e.scrollIntoView({block:'center',behavior:'instant'});e.click();return true;})()`),'login submit');
 await until(()=>js(`document.querySelector('.content')?.dataset.session==='ready'&&!document.querySelector('.connect-modal')`),'authenticated session');
 await click('资料库');await click('我的记忆');await until(()=>visible('.workspace-select'),'generated memory');
 check('reading appears before optional tools',await js(`!!(document.querySelector('.workspace-layout').compareDocumentPosition(document.querySelector('.memory-management'))&Node.DOCUMENT_POSITION_FOLLOWING)`));
 check('ordinary reading hides model controls and queues',!(await visible('.model-selector'))&&!(await visible('.execution-queue-overview')));
 await screenshot('reading-desktop');
 const sourceRef='capture:'+(await request('/api/fixture/state')).captureId;await js(`location.hash='#/library?view=memories&'+new URLSearchParams({memorySource:${JSON.stringify(sourceRef)}})`);await until(()=>visible('.memory-source-selection'),'explicit source selection');
 check('explicit extraction keeps source and opened controls before browsing',await visible('.model-selector')&&await js(`document.querySelector('.memory-management').open&&!!(document.querySelector('.memory-management').compareDocumentPosition(document.querySelector('.workspace-layout'))&Node.DOCUMENT_POSITION_FOLLOWING)`));
 await click('清除资料选择，恢复时间范围');await until(()=>js(`!document.querySelector('.memory-source-selection')`),'clear source selection');await js(`if(document.querySelector('.memory-management').open)document.querySelector('.memory-management>summary').click()`);
 check('clearing source selection restores the normal browsing order',await js(`!!(document.querySelector('.workspace-layout').compareDocumentPosition(document.querySelector('.memory-management'))&Node.DOCUMENT_POSITION_FOLLOWING)`));
 await click('高级设置');await until(()=>visible('.model-selector'),'advanced model choice');
 check('advanced settings expose extraction without developer queues',await visible('.memory-actions .primary')&&!(await js(`document.querySelector('.memory-developer-tools').open`)));
 await js(`(()=>{const e=document.querySelector('.model-selector select');e.value=e.options[e.options.length-1].value;e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 const chosen=await js(`document.querySelector('.model-selector select').value`);await click('高级设置');await click('高级设置');
 check('collapsing advanced settings retains unsaved model selection',chosen===await js(`document.querySelector('.model-selector select').value`));
 await click('提取当前范围的记忆');await until(()=>visible('.memory-progress'),'actual manual extraction progress');
 check('manual extraction creates one actual backend job',(await request('/api/fixture/state')).jobs.length===1);
 await click('高级设置');await click('开发者选项');await until(()=>js(`!!document.querySelector('.memory-job-history')`),'job history');
 await click(await js(`document.querySelector('.memory-job-history>summary').textContent`));
 const jobCaption=await js(`document.querySelector('.memory-job-history button').textContent`);await click(jobCaption);
 check('history selection reveals the actual progress and controls',await visible('.memory-progress')&&await js(`document.querySelector('.memory-management').open`));
 await click('取消未完成方案');await until(async()=>{const state=await request('/api/fixture/state');return state.jobs[0]?.status==='cancelled';},'cancelled extraction');check('cancellation reaches the actual backend job',(await request('/api/fixture/state')).jobs[0].status==='cancelled');
 await click('高级设置');await click('开发者选项');
 await js(`(()=>{const e=[...document.querySelectorAll('.workspace-select')].find(e=>e.checkVisibility()&&e.querySelector('strong')?.textContent==='Generated checklist preference');if(!e)throw Error('Missing visible generated memory');e.click();})()`);await until(()=>visible('.memory-detail'),'memory detail');
 check('source evidence and existing data controls stay in reading view',await visible('.memory-evidence')&&await js(`[...document.querySelectorAll('.memory-detail button')].some(e=>e.textContent==='删除记忆'&&e.checkVisibility())`));
 await click('删除记忆');await request('/api/fixture/fail-delete',{});await click('确认删除');
 await until(()=>js(`document.querySelector('.memory-feedback>[role=alert]')?.textContent.includes('中央服务暂不可用')`),'visible failed deletion');
 check('deletion failure remains visible with both tool sections closed',await visible('.memory-feedback>[role=alert]')&&await js(`!document.querySelector('.memory-management').open&&!document.querySelector('.memory-developer-tools').open`));
 check('failed deletion retains memory and confirmation controls',await visible('.memory-detail')&&await js(`[...document.querySelectorAll('.memory-detail button')].some(e=>e.textContent==='确认删除'&&!e.disabled)`));
 await until(()=>js(`(()=>{const r=document.querySelector('.memory-feedback').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})()`),'mutation failure in viewport');check('explicit mutation failure scrolls into view',true);await screenshot('delete-failure-visible');await click('确认删除');await until(()=>js(`!document.querySelector('.memory-detail')&&!!document.querySelector('.memory-feedback>.notice')`),'visible deletion receipt');
 check('deletion receipt stays visible without opening technical controls',await visible('.memory-feedback>.notice')&&await js(`!document.querySelector('.memory-management').open&&!document.querySelector('.memory-developer-tools').open`));
 check('existing deletion semantics retain original evidence',(await request('/api/fixture/state')).originalAvailable);
 check('empty reading state is visible after the only memory is removed',await visible('.workspace-list .muted')&&await js(`!document.querySelector('.workspace-select')`));
 for(const width of [390,320]){window.setSize(width,1000);await until(()=>js(`innerWidth===${width}`),'narrow viewport');await screenshot('reading-'+width);check('both tool entrypoints remain discoverable at '+width,await visible('.memory-management>summary')&&await visible('.memory-developer-tools>summary'));}
 await js(`localStorage.setItem('mote.language','en');location.reload()`);await click('Library');await click('My memories');await until(()=>visible('.memory-management>summary'),'English memories');
 check('English tools retain existing translated labels',await js(`document.querySelector('.memory-management>summary').textContent==='Advanced settings'&&document.querySelector('.memory-developer-tools>summary').textContent==='Developer options'`));
 await screenshot('reading-english');report.passed=true;writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
run().catch(async error=>{report.error=String(error);console.error(error);if(window){writeFileSync(join(out,'failure.png'),(await window.webContents.capturePage()).toPNG());console.error((await window.webContents.executeJavaScript('document.body.innerText')).slice(-6500));}writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');process.exitCode=1;}).finally(async()=>{
 window?.destroy();if(server?.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('close',r)),delay(3000)]);if(server.exitCode===null)server.kill('SIGKILL');}
 rmSync(root,{recursive:true,force:true});app.exit(process.exitCode||0);
});
