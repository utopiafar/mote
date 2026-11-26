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
const cold=gate(),firstDetail=gate(),mediaRefresh=gate(),activityRefresh=gate(),recordsRefresh=gate(),gates=[cold,firstDetail,mediaRefresh,activityRefresh,recordsRefresh];
const counts={main:0,detail:0,owner:0,feed:0,media:0,activity:0,records:0},pending=new Set(),hints=[],consumed=[],unexpected=[];
const collectionPaths={media:[],activity:[],records:[]};
const when='2026-10-01T10:00:00.000Z';
const mainId='10000000-0000-4000-8000-000000000001';
const oldId='10000000-0000-4000-8000-000000000002';
const mainPath='/api/conversations/main',detailPath='/api/conversations/'+mainId;
const chatPending=()=>[...pending].some(req=>[mainPath,detailPath].includes(req.url));
const summary=id=>({id,title:'合成主对话',createdAt:when,updatedAt:when,turnCount:1,scope:{},status:'completed'});
const detail=id=>({...summary(id),revision:1,nextCursor:null,turns:[{id:'turn-'+id,question:'合成问题 A',status:'completed',createdAt:when,result:{answer:'合成回答 A',runId:'generated-run-'+id,citations:[],trace:[]}}]});
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
    if(path==='/api/owner-questions')counts.owner++;
    const key=path===mainPath?'main':path===detailPath?'detail':null;
    if(key){counts[key]++;pending.add(req);try{
     if(key==='main')await cold.promise;
     if(key==='detail')await firstDetail.promise;
     await delay(500);
     json(res,key==='main'?{id:mainId}:detail(mainId));
    }finally{pending.delete(req);}return;}
    if(path===detailPath+'/assistant-tasks'){json(res,{items:[]});return;}
    if(path==='/api/captures'){json(res,{items:[],nextCursor:null});return;}
    if(path==='/api/insights'){json(res,{items:[]});return;}
    if(path==='/api/sources'){json(res,{items:[]});return;}
    if(path==='/api/connections'){json(res,{items:[],mcp:{enabled:true,writeEnabled:false,writeSourceIds:[]}});return;}
    if(path==='/api/library/browse'){
     json(res,{schemaVersion:1,revision:'generated-1',types:[],sources:[],items:url.searchParams.has('query')?[{entryType:'capture',ref:'capture:'+record.id,contentAt:when,revision:'generated-1',capture:record}]:[],nextCursor:null});return;
    }
    if(path==='/api/capture-browser/'+record.id){
     json(res,{...record,ocrText:'Generated evidence body for retrieval journey',privacy:{collection:'note',redacted:false},indexingStatus:'text_ready'});return;
    }
    if(path==='/api/actions/by-evidence/'+record.id){json(res,{items:[]});return;}
    if(path==='/api/memories'){json(res,{items:[],nextCursor:null});return;}
    if(path==='/api/nav-state'){json(res,{revisions:{library:'1',cards:'1',commitments:'1',matters:'1',memory:'1',sources:'1',plugins:'1'},badges:{ideas:0,connections:false}});return;}
    if(path==='/api/plugins/presentation'){json(res,{instances:[]});return;}
    if(path==='/api/connectors/status'){json(res,{items:[]});return;}
    if(path==='/api/configuration'){json(res,{profile:'generated-fixture',groups:[]});return;}
    if(path==='/api/status'){json(res,{profile:'generated-fixture',agent:{configured:true,model:'generated-model',provider:'custom',agentTimeoutMs:120000},storage:{captures:0,blobs:0,bytes:0,imageBytes:0,logicalBytes:0,imagesEncrypted:false,indexing:[]},index:{mode:'none',model:null},insightIntervalHours:0,serverTime:when});return;}
    if(path==='/api/devices'){json(res,{items:[]});return;}
    if(path==='/api/devices/first-data'){json(res,{state:'waiting',originalAvailable:false,checkedDevices:0,checkedRecords:0,windowLimited:false});return;}
    if(path==='/api/features'){json(res,{schemaVersion:1,revision:1,features:[],capabilities:['/api/library/browse','/api/capture-browser/timeline','/api/capture-browser/timeline/members','/api/media-activity','/api/activity'].map(path=>({id:'http:GET:'+path,version:'1',surface:'data',featureId:'generated-fixture',state:'active'}))});return;}
    const collection=path==='/api/media-activity'?'media':path==='/api/activity'?'activity':path==='/api/capture-browser/timeline'?'records':null;
    if(collection){
     counts[collection]++;collectionPaths[collection].push(req.url);pending.add(req);
     try{if(counts[collection]>1)await ({media:mediaRefresh,activity:activityRefresh,records:recordsRefresh})[collection].promise;await delay(300);json(res,collection==='media'?media:collection==='activity'?activity:{items:[{type:'record',day:'2026-10-01',record}],nextCursor:null});}
     finally{pending.delete(req);}return;
    }
    if(path==='/api/operations/changes'){counts.feed++;const hint=hints.shift();if(hint){cursor++;consumed.push(hint);}json(res,{ids:hint?[hint]:[],cursor,hasMore:false,reset:Number(url.searchParams.get('since'))>cursor});return;}
    if(path==='/api/model-settings'){const settings={provider:'custom',protocol:'openai-completions',baseUrl:'https://fixture.invalid/v1',model:'generated-model',reasoningEffort:'auto',maxTokens:4096,modelRequestTimeoutMs:120000,agentTimeoutMs:120000,allowUnauthenticatedLocal:false,apiKeyConfigured:false,headersConfigured:false,extraBodyConfigured:false};json(res,{version:1,revision:1,source:'file',settings,profiles:[{id:'env:deployment',name:'Generated provider',readOnly:true,settings}],defaults:{chat:'env:deployment'},defaultModels:{}});return;}
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
 await window.loadURL(endpoint+'/#/chat?conversation='+oldId);
 await until(()=>counts.main,'cold main conversation identity request');
 assert.equal(counts.detail,0,'detail waits for the identity');
 assert.ok(await js(`document.querySelector('.chat-page[aria-busy="true"] .chat-thread .loading')`),'cold chat has a real loading state');
 assert.equal(await js(`document.querySelector('.chat-page .send-button').disabled`),true,'cold identity blocks sending');
 cold.release();await until(()=>counts.detail,'main conversation detail requested');
 assert.ok(await js(`document.querySelector('.chat-page[aria-busy="true"] .chat-thread .loading')`),'cold detail also shows loading');
 assert.equal(await js(`document.querySelector('.chat-page .send-button').disabled`),true,'cold detail blocks sending');
 firstDetail.release();await until(()=>js(`document.querySelector('.chat-thread')?.textContent.includes('合成回答 A')&&document.querySelector('.chat-page[aria-busy="false"]')`),'main conversation ready despite old deep link');
 await until(()=>!chatPending(),'cold refreshes settle');
 const draft='合成草稿：后台更新时继续输入';
 await js(`(()=>{const input=document.querySelector('textarea[aria-label="向 Mote 提问"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(draft)});input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();})()`);
 await delay(80);
 await js(`(()=>{
  const input=document.querySelector('.chat-page textarea'),answer=document.querySelector('.conversation-turn'),thread=document.querySelector('.chat-thread');
  const state=window.__askLoadingCheck={input,answer,thread,violations:[]};
  const check=()=>{
   const reasons=[];
   if(document.querySelector('.chat-page[aria-busy="true"], .chat-thread .loading'))reasons.push('initial loading reappeared');
   if(!input.isConnected||document.querySelector('.chat-page textarea')!==input)reasons.push('composer replaced');
   if(!answer.isConnected||!thread.isConnected)reasons.push('loaded content replaced');
   if(input.disabled||document.querySelector('.chat-page .send-button').disabled)reasons.push('composer disabled');
   if(document.activeElement!==input)reasons.push('draft lost focus');
   if(input.value!==${JSON.stringify(draft)})reasons.push('draft changed');
   if(document.querySelector('.owner-question-history'))reasons.push('question history appeared in chat');
   if(reasons.length)state.violations.push(reasons);
  };
  state.observer=new MutationObserver(check);state.observer.observe(document.body,{subtree:true,childList:true,attributes:true});
  state.timer=setInterval(check,16);check();
 })()`);
 for(const kind of ['capture','file','import','query']){
  const before={...counts},hint=kind+':generated-update';hints.push(hint);
  await until(()=>consumed.includes(hint)&&counts.main>before.main&&counts.detail>before.detail&&chatPending(),'delayed '+kind+' refresh');
  assert.equal(await js(`document.querySelector('.chat-page .send-button').disabled`),false,'background '+kind+' refresh keeps sending available');
  await until(()=>!chatPending(),'completed '+kind+' refresh');
 }
 await delay(80);
 const violations=await js(`(()=>{const check=window.__askLoadingCheck;check.observer.disconnect();clearInterval(check.timer);return check.violations;})()`);
 assert.deepEqual(violations,[],'background refreshes preserve the loaded chat, draft and focus');
 assert.equal(counts.owner,0,'ordinary chat does not request the separate owner question list');

 const requestRefresh=()=>js(`(()=>{
  Object.defineProperty(document,'hidden',{configurable:true,value:true});
  document.dispatchEvent(new Event('visibilitychange'));
  Object.defineProperty(document,'hidden',{configurable:true,value:false});
  document.dispatchEvent(new Event('visibilitychange'));
  delete document.hidden;
 })()`);
 const beforeRefresh={...counts};
 await requestRefresh();
 await until(()=>counts.main>beforeRefresh.main&&counts.detail>beforeRefresh.detail&&chatPending(),'explicit refresh reads main identity and detail');
 assert.equal(await js(`window.__askLoadingCheck.thread===document.querySelector('.chat-thread')&&window.__askLoadingCheck.answer.isConnected`),true);
 assert.equal(await js(`Boolean(document.querySelector('.chat-thread .loading'))`),false,'loaded thread does not return to its initial reading state');
 assert.equal(await js(`document.querySelector('.chat-page textarea').value`),draft);
 await until(()=>!chatPending(),'explicit refresh completes');

 // Exercise returning to a foreground Web window: it invalidates resources and advances both
 // the rolling time URL and timeline revision before the replacement read ends.
 async function checkLibraryRefresh({id,selector,row,text,release,rolling}){
  await js(`location.hash=${JSON.stringify('#/library?view='+id)}`);
  await until(()=>counts[id]&&js(`document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(text)})`),'loaded '+id+' collection');
  const initialPath=collectionPaths[id][0],before=counts[id];
  await js(`(()=>{const panel=document.querySelector(${JSON.stringify(selector)}),row=document.querySelector(${JSON.stringify(row)});if(!panel||!row)throw Error('Missing generated collection content');const state=window.__frontendRefreshCheck={panel,row,violations:[],active:true};const check=()=>{if(!state.active)return;const loading=[...document.querySelectorAll('.library-content [role="status"],.library-content .loading')].filter(element=>element.getClientRects().length&&/正在读取|正在找回/.test(element.textContent)).map(element=>element.textContent);const reasons=[...loading,...!panel.isConnected||document.querySelector(${JSON.stringify(selector)})!==panel?['loaded panel replaced']:[],...!row.isConnected||document.querySelector(${JSON.stringify(row)})!==row?['loaded row replaced']:[]];if(reasons.length)state.violations.push(reasons);};state.observer=new MutationObserver(check);state.observer.observe(document.body,{subtree:true,childList:true,attributes:true});state.timer=setInterval(check,16);check();})()`);await requestRefresh();
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
 await checkLibraryRefresh({id:'activity',selector:'.activity-panel',row:'.special-activity-row',text:'Generated editor',release:activityRefresh,rolling:true});
 await checkLibraryRefresh({id:'records',selector:'.library-captures',row:'.library-record',text:'Generated archived note',release:recordsRefresh,rolling:false});
 // The default route opens the chat and keeps global retrieval available.
 await js(`location.hash=''`);
 await until(()=>js(`document.querySelector('[data-page="ask"][data-session="ready"] .chat-page[aria-busy="false"]')`),'default main chat');
 await delay(80);writeFileSync(join(output,'central-chat.png'),(await wc.capturePage()).toPNG());
 assert.equal(await js(`document.querySelector('.workspace-sidebar [data-nav-item="chat"][aria-current="page"]')?.textContent.trim()`),'聊天');
 assert.equal(await js(`document.querySelector('.chat-page textarea').value`),draft,'navigation retains the earlier chat draft');
 await js(`(()=>{const input=document.querySelector('.chat-page textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
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
 await js(`[...document.querySelectorAll('.search-options button')].find(node=>node.textContent.startsWith('聊天')).click()`);
 await until(()=>js(`document.querySelector('[data-page="ask"] .chat-page[aria-busy="false"]')`),'search handoff opens the main chat');
 await until(()=>js(`document.querySelector('textarea[aria-label="向 Mote 提问"]')?.value==='generated'`),'search handoff sets the draft without sending');
 assert.equal(await js(`document.querySelector('[role="dialog"]')===null`),true);
 assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
 const checks=['Default main chat and global search to exact evidence','Search-to-chat draft handoff','Cold identity and detail loading, including old URL','Capture/file/import/query refreshes preserve answer, draft and focus','Explicit refresh preserves loaded chat','Chat stays free of owner question polling','Media and Activity rolling refresh retains DOM','RecordTimeline refresh retains DOM'];
 writeFileSync(join(output,'result.json'),JSON.stringify({passed:true,generatedOnly:true,actualWebMain:true,hiddenWindow:true,durationMs:Date.now()-startedAt,counts,collectionPaths,checks,liveModel:false,personalNodeRead:false,physicalDevice:false},null,2));
 console.log(JSON.stringify({passed:true,counts,checks}));
}
async function finish(code){gates.forEach(value=>value.release());if(window&&!window.isDestroyed())window.destroy();if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}rmSync(root,{recursive:true,force:true});app.exit(code);}
run().then(()=>finish(0)).catch(async error=>{console.error(error.stack);console.error(JSON.stringify({counts,consumed,unexpected}));if(window&&!window.isDestroyed()){console.error(await window.webContents.executeJavaScript('document.body.innerText'));writeFileSync(join(output,'failure.png'),(await window.webContents.capturePage()).toPNG());}await finish(1);});
