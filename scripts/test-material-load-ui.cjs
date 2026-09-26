require('./fixture-language.cjs');
/** Generated source ingress and real Material UI during incremental background publication. */
const {app,BrowserWindow}=require('electron');
const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os'),{join,resolve}=require('node:path'),{pathToFileURL}=require('node:url');
const {spawn}=require('node:child_process'),{randomBytes}=require('node:crypto'),assert=require('node:assert/strict');
const repo=resolve(__dirname,'..'),root=mkdtempSync(join(tmpdir(),'mote-material-ui-')),outputRoot=join(repo,'.mote/material-load-ui');
mkdirSync(outputRoot,{recursive:true});const out=mkdtempSync(join(outputRoot,'run-'));app.setPath('userData',join(root,'browser'));app.on('window-all-closed',()=>{});
const delay=ms=>new Promise(r=>setTimeout(r,ms));let server,window;
const report={status:'running',fixtureRoot:root,personalDataUsed:false,modelInvoked:false,physicalDevicesTested:false,renderer:'Electron',targetRecords:631,initialRecords:20,actions:[],crashes:[],httpErrors:[]};
const save=()=>writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
async function until(work,label,timeout=15000){const started=Date.now();while(Date.now()-started<timeout){if(await work())return;await delay(80);}throw Error('Timeout: '+label);}
async function run(){
 await app.whenReady();const token=randomBytes(32).toString('hex'),runner=join(root,'server.mjs'),ready=join(root,'ready');
 const config={dataDir:join(root,'vault'),token,tokenPath:join(root,'token'),host:'127.0.0.1',port:0,maxStorageBytes:100000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 writeFileSync(runner,`import {buildApp} from ${JSON.stringify(pathToFileURL(join(repo,'apps/server/dist/app.js')).href)};import {writeFileSync} from 'node:fs';
const node=await buildApp(${JSON.stringify(config)},{agent:{configured:false,query:async()=>{throw Error('No live model in UI fixture');},close:async()=>{}}});
const settings=node.lifecycle.settings();for(const key of ['extraction','consolidation','insights','working'])settings[key].enabled=false;node.lifecycle.configure(settings);
let peakRss=0;const sample=setInterval(()=>peakRss=Math.max(peakRss,process.memoryUsage().rss),100);
node.app.post('/api/fixture/configure',async()=>node.sourcePipelines.configure('generated-load',{settleSeconds:0,memory:false}));
node.app.post('/api/fixture/drain',async()=>{await node.sourcePipelines.tick();return {count:Number(node.store.db.prepare('SELECT count(*) n FROM material_heads WHERE retired=0').get().n),peakRss};});
await node.app.listen({host:'127.0.0.1',port:0});writeFileSync(${JSON.stringify(ready)},String(node.app.server.address().port));process.once('SIGTERM',async()=>{clearInterval(sample);await node.app.close();process.exit(0);});`,{mode:0o600});
 server=spawn('node',[runner],{cwd:repo,env:Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]])),stdio:['ignore','ignore','pipe']});let stderr='';server.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-10000));
 await until(()=>{if(server.exitCode!==null)throw Error(stderr);return existsSync(ready);},'server');const endpoint='http://127.0.0.1:'+readFileSync(ready,'utf8');
 const request=async(path,body)=>{const r=await fetch(endpoint+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json','x-mote-ingress-version':'2'},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,`${path}: ${r.status} ${await (r.ok?Promise.resolve(''):r.text())}`);return r.json();};
 await request('/api/sources',{id:'generated-load',name:'合成批量资料',kind:'coding-agent',deviceId:'fixture-load',platform:'import'});
 await request('/api/fixture/configure',{});
 const item=i=>({externalId:String(i),revision:'1',observedAt:new Date(Date.UTC(2026,8,1)+i*60000).toISOString(),kind:'message',layer:'snapshot',text:`生成资料 ${i}。用于验证分页和长正文读取。\n`+('合成文本，不是真实个人数据。\n'.repeat(i%10===9?360:20))+`\n记录 ${i} 结束。`,document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:'session-'+i,projectKey:'generated-load',eventId:'one',role:'user',part:0,parts:1}}});
 let received=0;const writes=[];report.backgroundWrites=writes;
 async function batch(start,end){const at=Date.now(),items=Array.from({length:end-start},(_,offset)=>item(start+offset)),ack=await request('/api/sources/generated-load/items/batch',{items});assert.equal(ack.receipts.length,items.length);assert.ok(ack.receipts.every(r=>r.receipt.state==='received'));received+=items.length;const state=await request('/api/fixture/drain',{});writes.push({start:at,end:Date.now(),received,published:state.count});save();return state;}
 await batch(0,20);
 await until(async()=>{const state=await request('/api/fixture/drain',{});return state.count===20;},'initial publication');
 window=new BrowserWindow({width:1280,height:1000,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const wc=window.webContents,js=code=>wc.executeJavaScript(code);wc.on('render-process-gone',(_e,data)=>report.crashes.push(data.reason));wc.session.webRequest.onCompleted(data=>{if(data.statusCode>=400)report.httpErrors.push({path:new URL(data.url).pathname,status:data.statusCode});});
 async function click(text){await until(()=>js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true;})()`),text);}
 async function measure(name,work){const start=Date.now();await work();report.actions.push({name,start,end:Date.now(),durationMs:Date.now()-start});save();}
 const count=()=>js(`document.querySelectorAll('.materials-browser .source-item').length`);
 await window.loadURL(endpoint);await js(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({token}))});location.reload()`);await click('资料库');await click('正式资料');await until(async()=>await count()===12,'first page');
 await measure('initial next page',async()=>{await click('下一页');await until(async()=>await count()===8,'initial second page');});await click('返回第一页');await until(async()=>await count()===12,'first page again');
 await js(`window.loadMetrics={frames:[],longTasks:[],running:true};window.loadMetrics.observer=new PerformanceObserver(list=>window.loadMetrics.longTasks.push(...list.getEntries().map(e=>e.duration)));window.loadMetrics.observer.observe({entryTypes:['longtask']});let previousFrame;function collectFrame(at){if(previousFrame)window.loadMetrics.frames.push(at-previousFrame);previousFrame=at;if(window.loadMetrics.running)requestAnimationFrame(collectFrame);}requestAnimationFrame(collectFrame);true;`);
 const background=(async()=>{for(let start=20;start<631;start+=25){await batch(start,Math.min(start+25,631));await delay(80);}})();
 // Attach a rejection handler immediately; awaiting it below still propagates failures.
 background.catch(()=>{});
 for(let round=0;round<4;round++){
  await measure('background detail '+round,async()=>{await js(`document.querySelector('.materials-browser .source-item').click()`);await until(()=>js(`!!document.querySelector('.material-detail .fine-print')`),'detail body');});
  await measure('background scroll '+round,async()=>{const position=await js(`(()=>{document.querySelector('.material-detail').scrollIntoView({behavior:'instant'});return scrollY;})()`);assert.ok(position>0,'Detail must scroll into view');await js('scrollTo(0,0)');});
  await measure('background next page '+round,async()=>{const before=await js(`document.querySelector('.source-item strong')?.textContent`);await click('下一页');await until(()=>js(`document.querySelector('.source-item strong')?.textContent!==${JSON.stringify(before)}&&document.querySelectorAll('.materials-browser .source-item').length>0`),'new page');});
  await click('返回第一页');await delay(100);
 }
 await background;let state=await request('/api/fixture/drain',{});await until(async()=>{state=await request('/api/fixture/drain',{});return state.count===631;},'all formal materials');
 report.backgroundWrites=writes;report.peakServerRssBytes=state.peakRss;report.publishedRecords=state.count;
 const backgroundRange={start:writes[1].start,end:writes.at(-1).end};report.actionsDuringIngestion=report.actions.filter(a=>a.start<backgroundRange.end&&a.end>backgroundRange.start).length;assert.ok(report.actionsDuringIngestion>=3,'Actions must overlap actual ingestion');
 await click('刷新');await until(async()=>await count()===12,'bounded page after ingestion');assert.equal(await count(),12);
 await measure('full-set detail',async()=>{await js(`document.querySelector('.source-item').click()`);await until(()=>js(`!!document.querySelector('.material-detail .fine-print')`),'detail');});
 report.frames=await js(`(()=>{window.loadMetrics.running=false;window.loadMetrics.observer.disconnect();const frames=window.loadMetrics.frames;return {sampleCount:frames.length,maxGapMs:Math.max(0,...frames),over50ms:frames.filter(n=>n>50).length,longTasks:window.loadMetrics.longTasks};})()`);
 assert.ok(report.frames.sampleCount>10);assert.deepEqual(report.crashes,[]);assert.deepEqual(report.httpErrors,[]);
 for(const width of [1280,430]){window.setSize(width,1000);await delay(200);assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true,'No horizontal overflow');writeFileSync(join(out,'materials-'+width+'.png'),(await wc.capturePage()).toPNG());}
 report.status='passed';
}
run().catch(async error=>{report.status='failed';report.failure=error.stack;process.exitCode=1;if(window)writeFileSync(join(out,'failure.png'),(await window.webContents.capturePage()).toPNG());}).finally(async()=>{save();console.log(JSON.stringify({status:report.status,report:join(out,'report.json'),failure:report.failure}));window?.destroy();if(server?.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('close',r)),delay(3000)]);}if(report.status==='passed')rmSync(root,{recursive:true,force:true});app.exit(process.exitCode||0);});
