require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');
/** Built Web main entry + generated HTTP fixtures. No personal node, captures or model calls. */
const {app,BrowserWindow}=require('electron');
const {createServer}=require('node:http');
const {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve,extname,sep}=require('node:path');
const {randomBytes,randomUUID}=require('node:crypto');
const assert=require('node:assert/strict');
const repo=resolve(__dirname,'../../..'),web=join(repo,'apps/web/dist'),root=mkdtempSync(join(tmpdir(),'mote-ask-loading-')),output=join(repo,'.mote/web-ask-loading');
mkdirSync(output,{recursive:true});app.setPath('userData',join(root,'browser'));app.on('window-all-closed',()=>{});
const delay=ms=>new Promise(done=>setTimeout(done,ms));
const gate=()=>{let release;return {promise:new Promise(done=>release=done),release:()=>release()};};
const startedAt=Date.now(),deadline=startedAt+40000;
async function until(read,label){const end=Math.min(Date.now()+20000,deadline);while(Date.now()<end){if(await read())return;await delay(40);}throw Error('Timed out: '+label);}
let server,window;
const cold=gate(),firstDetail=gate(),ownerRefresh=gate(),otherDetail=gate(),mediaRefresh=gate(),activityRefresh=gate(),recordsRefresh=gate(),gates=[cold,firstDetail,ownerRefresh,otherDetail,mediaRefresh,activityRefresh,recordsRefresh];
const counts={history:0,detail:0,other:0,owner:0,feed:0,media:0,activity:0,records:0},pending=new Set(),hints=[],consumed=[],unexpected=[];
const collectionPaths={media:[],activity:[],records:[]};
const when='2026-10-01T10:00:00.000Z';
const summary=id=>({id,title:'合成对话 '+id,createdAt:when,updatedAt:when,turnCount:1,scope:{},status:'completed'});
const detail=id=>({...summary(id),revision:1,nextCursor:null,turns:[{id:'turn-'+id,question:'合成问题 '+id,status:'completed',createdAt:when,result:{answer:'合成回答 '+id,runId:'generated-run-'+id,citations:[],trace:[]}}]});
const completed={id:'generated-run-A',status:'completed',createdAt:when,updatedAt:when,conversationId:'A',turnId:'turn-A',events:[]};
const media={observations:1,totalDurationMs:1000,screenLock:{locked:0,unlocked:1000,unknown:0},visibility:{foreground:1000,background:0,unknown:0},playbackType:{local:1000,remote:0,unknown:0},apps:[{appId:'generated.player',appName:'Generated player',durationMs:1000,evidenceIds:[]}],devices:[]};
const activity={apps:[{appId:'generated.editor',appName:'Generated editor',durationMs:1000,captures:1}],devices:[],totalDurationMs:1000,captures:1};
const record={id:'11111111-1111-4111-8111-111111111111',deviceId:'generated-device',deviceName:'Generated device',platform:'generated',capturedAt:when,source:'note',appName:'Generated note',windowTitle:'Generated archived note',durationMs:0,hasImage:false,ocr:{status:'not_applicable'},textPreview:'Generated original text'};

async function run(){
 assert.ok(existsSync(join(web,'index.html')),'Build the Web bundle first: npm run build:central');
 await app.whenReady();const token=randomBytes(32).toString('hex');let cursor=0;
 const json=(res,value)=>{if(!res.destroyed){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}};
 server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://fixture.invalid'),path=url.pathname;
  try{
   if(path.startsWith('/api/')){
    if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end();return;}
    const key=path==='/api/conversations'?'history':path==='/api/conversations/A'?'detail':path==='/api/conversations/B'?'other':path==='/api/owner-questions'?'owner':null;
    if(key){counts[key]++;pending.add(req);try{
     if(key==='history'||key==='owner'&&counts.owner===1)await cold.promise;
     if(key==='detail')await firstDetail.promise;
     if(key==='other')await otherDetail.promise;
     if(key==='owner'&&counts.owner>1)await ownerRefresh.promise;
     await delay(500);
     json(res,key==='history'?{items:['A','B'].map(summary),nextCursor:null}:key==='owner'?{items:[],nextCursor:null}:detail(key==='detail'?'A':'B'));
    }finally{pending.delete(req);}return;}
    if(path==='/api/captures'){json(res,{items:[],nextCursor:null});return;}
    if(path==='/api/insights'){json(res,{items:[]});return;}
    if(path==='/api/sources'){json(res,{items:[]});return;}
    if(path==='/api/connections'){json(res,{items:[],mcp:{enabled:true,writeEnabled:false,writeSourceIds:[]}});return;}
    if(path==='/api/library/catalog'){json(res,{schemaVersion:1,types:[],sources:[],items:[],nextCursor:null});return;}
    if(path==='/api/context/search'){json(res,{items:[{ref:'memory:generated-search-result',title:'Generated searchable memory',snippet:'Generated evidence excerpt',kind:'memory'}],nextCursor:null});return;}
    if(path==='/api/context/read'){json(res,{items:[{id:'generated-search-result',ref:'memory:generated-search-result',kind:'memory',title:'Generated searchable memory',text:'Generated evidence body for retrieval journey',textRange:{offset:0,total:43,nextOffset:null}}],missingRefs:[]});return;}
    if(path==='/api/configuration'){json(res,{profile:'generated-fixture',groups:[]});return;}
    if(path==='/api/status'){json(res,{profile:'generated-fixture',agent:{configured:true,model:'generated-model',provider:'custom',agentTimeoutMs:120000},storage:{captures:0,blobs:0,bytes:0,imageBytes:0,logicalBytes:0,imagesEncrypted:false,indexing:[]},index:{mode:'none',model:null},retentionDays:0,insightIntervalHours:0,serverTime:when});return;}
    if(path==='/api/devices'){json(res,{items:[]});return;}
    if(path==='/api/features'){json(res,{schemaVersion:1,revision:1,features:[],capabilities:['/api/owner-questions','/api/capture-browser'].map(path=>({id:'http:GET:'+path,version:'1',surface:'data',featureId:'generated-fixture',state:'active'}))});return;}
    const collection=path==='/api/media-activity'?'media':path==='/api/activity'?'activity':path==='/api/capture-browser'?'records':null;
    if(collection){
     counts[collection]++;collectionPaths[collection].push(req.url);pending.add(req);
     try{if(counts[collection]>1)await ({media:mediaRefresh,activity:activityRefresh,records:recordsRefresh})[collection].promise;await delay(300);json(res,collection==='media'?media:collection==='activity'?activity:{items:[record],totalCount:1,nextCursor:null});}
     finally{pending.delete(req);}return;
    }
    if(path==='/api/query-runs'){await cold.promise;json(res,{items:[completed]});return;}
    if(path==='/api/query-runs/generated-run-A'){json(res,completed);return;}
    if(path==='/api/work-activity/query%3Agenerated-run-A'||decodeURIComponent(path)==='/api/work-activity/query:generated-run-A'){json(res,{id:'query:generated-run-A',branches:[]});return;}
    if(path==='/api/operations/changes'){counts.feed++;const hint=hints.shift();if(hint){cursor++;consumed.push(hint);}json(res,{ids:hint?[hint]:[],cursor,hasMore:false,reset:Number(url.searchParams.get('since'))>cursor});return;}
    if(path==='/api/model-settings'){const settings={provider:'custom',protocol:'openai-completions',baseUrl:'https://fixture.invalid/v1',model:'generated-model',reasoningEffort:'auto',maxTokens:4096,modelRequestTimeoutMs:120000,agentTimeoutMs:120000,allowUnauthenticatedLocal:false,apiKeyConfigured:false,headersConfigured:false,extraBodyConfigured:false};json(res,{version:1,revision:1,source:'environment',settings,profiles:[{id:'env:deployment',name:'Generated provider',readOnly:true,settings}],defaults:{chat:'env:deployment'},defaultModels:{}});return;}
    if(path==='/api/model-settings/profiles/env%3Adeployment/models'){json(res,{items:[]});return;}
    unexpected.push(req.method+' '+req.url);res.writeHead(404);res.end();return;
   }
   if(path==='/__fixture'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Generated frontend refresh fixture</title>');return;}
   if(path==='/favicon.ico'){res.writeHead(204);res.end();return;}
   const file=resolve(web,'.'+decodeURIComponent(path==='/'?'/index.html':path));
   if(!file.startsWith(web+sep)||!existsSync(file)){res.writeHead(404);res.end();return;}
   const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png'};
   res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(readFileSync(file));
  }catch(error){unexpected.push(error.stack);if(!res.headersSent)res.writeHead(500);res.end();}
 });
 await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
 const endpoint='http://127.0.0.1:'+server.address().port;
 window=new BrowserWindow({width:1360,height:1000,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false}});
 const wc=window.webContents,errors=[],js=code=>wc.executeJavaScript(code);
 wc.on('render-process-gone',(_event,details)=>errors.push(details.reason));
 wc.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
 wc.session.webRequest.onBeforeRequest((details,callback)=>{const external=!details.url.startsWith(endpoint+'/')&&!details.url.startsWith('devtools:');if(external)unexpected.push(details.url);callback({cancel:external});});
 await window.loadURL(endpoint+'/__fixture');await js(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({token,viewScope:randomUUID()}))})`);
 await window.loadURL(endpoint+'/#/ask');
 await until(()=>counts.history&&counts.owner,'cold Ask HTTP reads');
 assert.match(await js('document.body.innerText'),/正在读取历史/,'cold history has a real loading state');
 cold.release();await until(()=>counts.detail,'restored completed conversation detail');
 await until(()=>js(`document.querySelector('.conversation-content')?.textContent.includes('正在打开对话')&&document.querySelector('textarea[aria-label="向 Mote 提问"]')?.disabled`),'cold detail blocks composer');
 firstDetail.release();await until(()=>js(`document.querySelector('.conversation-messages')?.textContent.includes('合成回答 A')&&!document.querySelector('textarea[aria-label="向 Mote 提问"]').disabled`),'restored conversation ready');
 await until(()=>!pending.size,'cold refreshes settle');
 const draft='合成草稿：后台更新时继续输入';
 await js(`(()=>{const input=document.querySelector('textarea[aria-label="向 Mote 提问"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(draft)});input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();})()`);
 await delay(80);
 await js(`(()=>{const input=document.querySelector('textarea[aria-label="向 Mote 提问"]'),answer=document.querySelector('.conversation-turn'),history=document.querySelector('.conversation-history');window.__askLoadingCheck={input,answer,history,violations:[]};const check=()=>{const state=window.__askLoadingCheck;if(!state.active)return;const statuses=[...document.querySelectorAll('[role="status"]')].filter(element=>element.getClientRects().length&&/正在读取|正在打开/.test(element.textContent)).map(element=>element.textContent);const reasons=[...statuses,...document.querySelector('.owner-question-history')?['empty question section reappeared']:[],...!input.isConnected||document.querySelector('textarea[aria-label="向 Mote 提问"]')!==input?['composer replaced']:[],...!answer.isConnected||!history.isConnected?['loaded content replaced']:[],...input.disabled?['composer disabled']:[],...document.activeElement!==input?['draft lost focus']:[],...input.value!==${JSON.stringify(draft)}?['draft changed']:[]];if(reasons.length)state.violations.push(reasons);};window.__askLoadingCheck.active=true;window.__askLoadingCheck.observer=new MutationObserver(check);window.__askLoadingCheck.observer.observe(document.body,{subtree:true,childList:true,attributes:true});window.__askLoadingCheck.timer=setInterval(check,16);check();})()`);
 for(const kind of ['capture','file','import','query']){
  const before={...counts},hint=kind+':generated-update';hints.push(hint);
  await until(()=>consumed.includes(hint)&&counts.history>before.history&&counts.detail>before.detail,'delayed '+kind+' refresh');
  assert.equal(await js(`document.querySelector('textarea[aria-label="向 Mote 提问"]').disabled`),false,'background '+kind+' refresh keeps composer enabled');
  await until(()=>![...pending].some(req=>req.url.startsWith('/api/conversations')),'completed '+kind+' refresh');
 }
 await until(()=>counts.owner>1&&[...pending].some(req=>req.url.startsWith('/api/owner-questions')),'real five-second empty-question poll');
 assert.equal(await js(`Boolean(document.querySelector('.owner-question-history'))`),false,'empty question history remains absent while its poll is pending');
 ownerRefresh.release();await until(()=>!pending.size,'empty-question poll completes');await delay(80);
 const violations=await js(`(()=>{const check=window.__askLoadingCheck;check.active=false;check.observer.disconnect();clearInterval(check.timer);return check.violations;})()`);
 assert.deepEqual(violations,[],'background refreshes preserve the loaded Ask page, draft and focus');
 // Explicit refresh remains functional, without replacing the loaded history.
 const beforeRefresh=counts.history;
 await js(`document.querySelector('button[aria-label="刷新对话历史"]').click()`);
 await until(()=>counts.history>beforeRefresh,'explicit history refresh');
 assert.equal(await js(`window.__askLoadingCheck.history===document.querySelector('.conversation-history')`),true);
 assert.equal(await js(`Boolean(document.querySelector('.conversation-history .loading'))`),false,'loaded history does not return to its initial reading state');
 assert.equal(await js(`document.querySelector('textarea[aria-label="向 Mote 提问"]').value`),draft);
 await until(()=>!pending.size,'explicit refresh completes');
 // Selecting an unvisited conversation still waits for its first authorized detail.
 await js(`[...document.querySelectorAll('button.conversation-item')].find(button=>button.textContent.includes('合成对话 B')).click()`);
 await until(()=>counts.other,'new conversation detail request');
 assert.equal(await js(`document.querySelector('textarea[aria-label="向 Mote 提问"]').disabled`),true);
 assert.match(await js(`document.querySelector('.conversation-content').textContent`),/正在打开对话/);
 otherDetail.release();await until(()=>js(`document.querySelector('.conversation-messages')?.textContent.includes('合成回答 B')&&!document.querySelector('textarea[aria-label="向 Mote 提问"]').disabled`),'selected conversation ready');
 // Exercise the real topbar action: it invalidates resources and advances both
 // the rolling time URL and timeline revision before the replacement read ends.
 async function checkLibraryRefresh({id,selector,row,text,release,rolling}){
  await js(`location.hash=${JSON.stringify('#/library?view='+id)}`);
  await until(()=>counts[id]&&js(`document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(text)})`),'loaded '+id+' collection');
  await until(()=>js(`!document.querySelector('button[aria-label="刷新资料"]')?.disabled`),'global refresh available for '+id);
  const initialPath=collectionPaths[id][0],before=counts[id];
  await js(`(()=>{const panel=document.querySelector(${JSON.stringify(selector)}),row=document.querySelector(${JSON.stringify(row)});if(!panel||!row)throw Error('Missing generated collection content');const state=window.__frontendRefreshCheck={panel,row,violations:[],active:true};const check=()=>{if(!state.active)return;const loading=[...document.querySelectorAll('.library-content [role="status"],.library-content .loading')].filter(element=>element.getClientRects().length&&/正在读取|正在找回/.test(element.textContent)).map(element=>element.textContent);const reasons=[...loading,...!panel.isConnected||document.querySelector(${JSON.stringify(selector)})!==panel?['loaded panel replaced']:[],...!row.isConnected||document.querySelector(${JSON.stringify(row)})!==row?['loaded row replaced']:[]];if(reasons.length)state.violations.push(reasons);};state.observer=new MutationObserver(check);state.observer.observe(document.body,{subtree:true,childList:true,attributes:true});state.timer=setInterval(check,16);check();document.querySelector('button[aria-label="刷新资料"]').click();})()`);
  await until(()=>counts[id]>before&&(!rolling||collectionPaths[id].some(path=>path!==initialPath))&&[...pending].some(req=>req.url.startsWith(initialPath.split('?')[0])),'delayed global '+id+' refresh');
  assert.equal(await js(`window.__frontendRefreshCheck.row.isConnected&&window.__frontendRefreshCheck.panel.isConnected`),true,'global '+id+' refresh retains loaded content while pending');
  release.release();
  await until(()=>![...pending].some(req=>req.url.startsWith(initialPath.split('?')[0])),'global '+id+' refresh completes');
  await delay(60);
  const violations=await js(`(()=>{const state=window.__frontendRefreshCheck;state.active=false;state.observer.disconnect();clearInterval(state.timer);return state.violations;})()`);
  assert.deepEqual(violations,[],'global '+id+' refresh keeps DOM identity without initial reading states');
  if(rolling)assert.ok(collectionPaths[id].some(path=>path!==initialPath),'global '+id+' refresh reads the advanced rolling URL');
 }
 await checkLibraryRefresh({id:'media',selector:'.media-activity-panel',row:'.media-app-row',text:'Generated player',release:mediaRefresh,rolling:true});
 await checkLibraryRefresh({id:'activity',selector:'.activity-panel',row:'.app-row',text:'Generated editor',release:activityRefresh,rolling:true});
 await checkLibraryRefresh({id:'records',selector:'.library-captures',row:'.library-record',text:'Generated archived note',release:recordsRefresh,rolling:false});
 // Central IA: the built shell keeps retrieval available and opens the complete Ask workspace.
 await js(`location.hash=''`);
 await until(()=>js(`document.querySelector('[data-page="overview"][data-session="ready"]')`),'default overview');
 await until(()=>js(`document.querySelector('[data-page="overview"] h1')?.textContent==='首页'&&document.querySelector('.central-first-steps')`),'overview onboarding content');
 await delay(80);writeFileSync(join(output,'central-overview.png'),(await wc.capturePage()).toPNG());
 assert.deepEqual(await js(`[...document.querySelectorAll('.sidebar nav button')].map(node=>node.innerText)`),['首页','资料库','来源','AI 接入']);
 await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}))`);
 assert.equal(await js(`document.activeElement===document.querySelector('.global-retrieval input')`),true);
 await js(`(()=>{const input=document.querySelector('.global-retrieval input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'generated');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await delay(60);await js(`document.querySelector('.global-retrieval').requestSubmit()`);
 await until(()=>js(`document.querySelector('[data-page="search"] .library-record')`),'search result');
 await js(`document.querySelector('[data-page="search"] .library-record').click()`);
 await until(()=>js(`document.querySelector('.library-detail')?.textContent.includes('Generated evidence body')`),'search evidence');
 writeFileSync(join(output,'central-search-evidence.png'),(await wc.capturePage()).toPNG());
 await js(`document.querySelector('.library-back').click()`);
 assert.equal(await js(`document.querySelector('.library-browser').classList.contains('has-selection')`),false);
 await js(`[...document.querySelectorAll('.global-retrieval button')].find(node=>node.textContent==='提问').click()`);
 await js(`document.querySelector('.global-retrieval').requestSubmit()`);
 await until(()=>js(`document.querySelector('[data-page="ask"] .conversation-history')&&document.querySelector('textarea[aria-label="向 Mote 提问"]')`),'global Ask full workspace');
 await until(()=>js(`document.querySelector('textarea[aria-label="向 Mote 提问"]')?.value==='generated'`),'global Ask draft handoff without sending');
 assert.equal(await js(`document.querySelector('[role="dialog"]')===null`),true);
 assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
 writeFileSync(join(output,'result.json'),JSON.stringify({passed:true,generatedOnly:true,actualWebMain:true,hiddenWindow:true,durationMs:Date.now()-startedAt,counts,collectionPaths,checks:['Central default overview and four primary destinations','global Cmd-K search to exact evidence and return','global Ask opens complete conversation workspace','Ask cold history and detail loading','restored completed conversation','capture/file/import/query change refreshes','real five-second empty-question poll','preserved Ask draft, DOM identity and focus','explicit history refresh','first load of another conversation','Media global refresh with advanced rolling URL and stable DOM','Activity global refresh with advanced rolling URL and stable DOM','RecordTimeline global refresh with stable DOM'],liveModel:false,personalNodeRead:false,physicalDevice:false},null,2));
 console.log('PASS: generated frontend refresh journeys through built Web main: Ask cold/background loading, empty-question polling, conversation selection, and Media/Activity/RecordTimeline global refresh stability.');
}
async function finish(code){gates.forEach(value=>value.release());if(window&&!window.isDestroyed())window.destroy();if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}rmSync(root,{recursive:true,force:true});app.exit(code);}
run().then(()=>finish(0)).catch(async error=>{console.error(error.stack);console.error(JSON.stringify({counts,consumed,unexpected}));if(window&&!window.isDestroyed()){console.error(await window.webContents.executeJavaScript('document.body.innerText'));writeFileSync(join(output,'failure.png'),(await window.webContents.capturePage()).toPNG());}await finish(1);});
