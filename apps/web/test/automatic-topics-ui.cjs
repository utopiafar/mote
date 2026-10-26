require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');
// Generated archive and actual renderer/API. No personal data, model calls or device capture.
const {app,BrowserWindow}=require('electron');
const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os'),{join,resolve}=require('node:path'),{pathToFileURL}=require('node:url');
const {spawn}=require('node:child_process'),{randomBytes}=require('node:crypto'),assert=require('node:assert/strict');
const repo=resolve(__dirname,'../../..'),root=mkdtempSync(join(tmpdir(),'mote-automatic-topics-ui-'));
const out=join(repo,'.mote/automatic-topics-ui');mkdirSync(out,{recursive:true});
app.setPath('userData',join(root,'browser'));app.on('window-all-closed',()=>{});
let server,window;
const report={passed:false,actualRenderer:true,actualHttpApi:true,personalDataUsed:false,liveModel:false,physicalDevicesTested:false,checks:[],screenshots:out};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await delay(80);}throw Error('Timeout: '+label);}
function check(name,value){assert.ok(value,name);report.checks.push(name);}
async function run(){
 await app.whenReady();const token=randomBytes(32).toString('hex'),runner=join(root,'server.mjs'),ready=join(root,'ready');
 const config={dataDir:join(root,'data'),token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent'};
 writeFileSync(runner,`import {buildApp} from ${JSON.stringify(pathToFileURL(join(repo,'apps/server/dist/app.js')).href)};import {writeFileSync} from 'node:fs';import {createHash,randomUUID} from 'node:crypto';
const node=await buildApp(${JSON.stringify(config)},{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('Fixture must not invoke a model');},close:async()=>{}}});
const lifecycle=node.lifecycle.settings();for(const name of ['consolidation','working','insights'])lifecycle[name].enabled=false;await node.lifecycle.save({revision:node.configService.revision,settings:lifecycle});
node.sources.register({id:'generated',name:'Generated source',kind:'custom',deviceId:'fixture',platform:'import'});
const at=new Date().toISOString(),text='Generated owner: use a written checklist for batch changes.',r={id:randomUUID()};await node.store.ingest({id:r.id,deviceId:'fixture',deviceName:'Generated',platform:'import',capturedAt:at,durationMs:0,source:'note',appId:'mote.note',appName:'Generated note',ocrText:text,privacy:{excluded:false,redacted:false,mode:'none'}});
const answer=JSON.stringify({memories:[{title:'Generated checklist preference',statement:text+' ['+r.id+']',uncertainty:'Generated fixture only',admission:{layer:'memory',reason:'Explicit owner preference',scope:'Fixture',attribution:'user'},evidenceIds:[r.id],evidence:[{id:r.id,quote:text}]}]});
const seeded=node.memories.extract({answer,citations:[{id:r.id,capturedAt:at,appName:'Generated source',excerpt:text}],trace:[],runId:'fixture-review'},'fixture',{reviewReceipt:{policy:'bounded-exact-review@1',decision:'independent',draftRunId:'fixture-draft',reviewRunId:'fixture-review',checkedAt:at,resultHash:createHash('sha256').update(answer).digest('hex'),deletionSnapshot:node.memories.deletions.snapshot()}});
node.memories.publish(seeded.items[0].id);
node.app.post('/api/fixture/remove-topic-input',async()=>{node.memories.delete(seeded.items[0].id);return {ok:true};});
let failTopics=false;node.app.post('/api/fixture/topics-failure',async req=>{failTopics=req.body.fail;return {ok:true};});
let failDelete=false;node.app.addHook('onRequest',async(req,reply)=>{if(failTopics&&req.url==='/api/context-trees')return reply.code(503).send({error:'Generated topic offline'});if(failDelete&&req.method==='DELETE'&&req.url.startsWith('/api/memories/')){failDelete=false;return reply.code(503).send({error:'Generated transient delete failure'});}});
node.app.post('/api/fixture/fail-delete',async()=>{failDelete=true;return {ok:true};});
node.app.get('/api/fixture/state',async()=>({captureId:r.id,originalAvailable:node.memories.readEvidence([r.id]).length===1,jobs:node.memoryPipeline.list()}));
await node.app.listen({host:'127.0.0.1',port:0});const topics=node.featureServices.contextTrees.automatic;topics.register({id:'fixture',version:'1',classify:async()=>({trees:[{id:'planning',label:'Generated planning',nodes:[{id:'checklists',label:'Generated checklists',memoryIds:[seeded.items[0].id]},{id:'review',label:'Generated review',memoryIds:[seeded.items[0].id]}]},{id:'practice',label:'Generated practice',nodes:[{id:'reuse',label:'Generated reuse',memoryIds:[seeded.items[0].id]}]}]})});await topics.classify({operationId:'generated-ui',classifierId:'fixture',memoryIds:[seeded.items[0].id]},{admissionId:'generated-ui-original',signal:new AbortController().signal,assertCurrent:()=>{}});writeFileSync(${JSON.stringify(ready)},String(node.app.server.address().port));process.once('SIGTERM',async()=>{await node.app.close();process.exit(0);});`,{mode:0o600});
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
 const catalog=await request('/api/context-trees'),automatic=catalog.items.filter(x=>x.id.startsWith('auto.'));check('actual API contains two model-output trees',automatic.length===2);
 const choose=async id=>{await js(`(()=>{const select=document.querySelector('.memory-dimension select');select.value=${JSON.stringify(id)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);};
 await choose(automatic[0].id);await click('Generated checklists');await until(()=>visible('.workspace-select'),'first topic references');
 await js(`document.querySelector('.workspace-select').click()`);await until(()=>visible('.memory-detail'),'same Memory detail');
 check('topic view preserves exact Memory detail and evidence',await visible('.memory-evidence'));
 await screenshot('automatic-topics-desktop');
 await choose(automatic[1].id);await click('Generated reuse');await until(()=>visible('.workspace-select'),'second tree same memory');
 check('second tree has same title',await js(`document.querySelector('.workspace-select strong').textContent==='Generated checklist preference'`));
 for(const width of [390,320]){window.setSize(width,1000);await until(()=>js(`innerWidth===${width}`),'narrow viewport');await screenshot('topics-'+width);}
 await request('/api/fixture/topics-failure',{fail:true});await until(()=>visible('.memory-topic-browser [role=alert]'),'topic offline error');check('offline does not show stale topic members as current',await js(`!document.querySelector('.workspace-select')`));await screenshot('topics-offline');await request('/api/fixture/topics-failure',{fail:false});await click('重新读取');await until(()=>visible('.workspace-select'),'topic retry restores membership');
 await request('/api/fixture/remove-topic-input',{});await until(()=>js(`document.querySelector('.memory-topic-browser').textContent.includes('此主题已不可用')`),'removed input invalidates visible labels');
 check('invalidated topic removes stale membership and detail',await js(`!document.querySelector('.workspace-select')&&!document.querySelector('.memory-detail')&&!document.querySelector('.memory-topic-nodes')`));
 await click('全部记忆');await until(()=>js(`!!document.querySelector('.memory-topic-nodes')`),'return to existing dimensions');
 await screenshot('topics-invalidated');
 await js(`localStorage.setItem('mote.language','en');location.reload()`);await click('Library');await click('My memories');await until(()=>visible('.memory-topic-browser'),'English topic view');
 check('empty automatic state translated',await js(`document.querySelector('.memory-topic-browser').textContent.includes('No automatic topics yet')`));
 report.passed=true;writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
run().catch(async error=>{report.error=String(error);console.error(error);if(window){writeFileSync(join(out,'failure.png'),(await window.webContents.capturePage()).toPNG());console.error((await window.webContents.executeJavaScript('document.body.innerText')).slice(-6500));}writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');process.exitCode=1;}).finally(async()=>{
 window?.destroy();if(server?.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('close',r)),delay(3000)]);if(server.exitCode===null)server.kill('SIGKILL');}
 rmSync(root,{recursive:true,force:true});app.exit(process.exitCode||0);
});
