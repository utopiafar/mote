// G4 manual Mac stage acceptance:
//   npm run build -w @mote/desktop
//   cd apps/desktop && npx electron test/plugin-stage-smoke.cjs
// The hidden generated-profile journey writes screenshots and result.json to
// .mote/plugin-stage-smoke (override with MOTE_PLUGIN_STAGE_OUTPUT).
require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');
const {app,BrowserWindow,dialog,ipcMain,safeStorage}=require('electron');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');

require('../package.json').moteDevelopment=true;
const repo=path.resolve(__dirname,'../../..');
const profile=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mote-plugin-stage-')));
const directory=path.join(profile+'-profiles/dev');
const output=path.resolve(process.env.MOTE_PLUGIN_STAGE_OUTPUT||path.join(repo,'.mote/plugin-stage-smoke'));
const generatedSource=path.join(profile,'generated-source');
const exportedQueue=path.join(profile,'generated-queue-export.json');
fs.mkdirSync(directory,{recursive:true,mode:0o700});
fs.mkdirSync(output,{recursive:true,mode:0o700});
fs.mkdirSync(generatedSource,{recursive:true,mode:0o700});
fs.writeFileSync(path.join(generatedSource,'stage-note.md'),'Generated plugin-stage source.\nOnly this generated file is read.\n',{mode:0o600});
app.setPath('userData',profile);
process.env.MOTE_PROFILE='dev';
for(const key of ['MOTE_URL','MOTE_TOKEN','MOTE_ENV_FILE'])delete process.env[key];
safeStorage.isEncryptionAvailable=()=>{throw Error('Dev stage fixture must not access safeStorage');};
const {defaultConfig}=require('../dist/config');
const config={...defaultConfig(),serverUrl:'',deviceName:'Generated Stage Mac',metadataEnabled:false,syncPaused:true,syncMode:'manual'};
fs.writeFileSync(path.join(directory,'config.json'),JSON.stringify({version:4,config}),{mode:0o600});
fs.writeFileSync(path.join(directory,'storage-format.json'),JSON.stringify({version:4}),{mode:0o600});

const native=require('../dist/native');
native.readInstalledApplications=async()=>[];
native.runHelper=async()=>{throw Error('Stage fixture refuses native capture and permission requests');};
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[generatedSource]});
dialog.showSaveDialog=async()=>({canceled:false,filePath:exportedQueue});
const calls=new Map(),scopes=new Map(),registeredChannels=new Map(),disposedChannels=new Map(),captures=[],checks=[],observedPages=new Set(),errors=[];
let stageHost,main,finished=false,currentPhase='startup';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(check,label,attempts=400)=>{for(let index=0;index<attempts;index++){if(await check())return;await delay(25);}throw Error('Timed out: '+label);};

// Public host seams only: record every plugin scope the production composition
// creates, and observe actual IPC calls. No product code is patched.
const {DesktopPluginHost,PluginScopeHandle}=require('../dist/plugin-host/desktop-host');
const {IpcScope}=require('../dist/plugin-host/ipc-registry');
const originalCreateScope=DesktopPluginHost.prototype.createScope;
DesktopPluginHost.prototype.createScope=function(options){
  stageHost=this;
  const scope=originalCreateScope.call(this,options);
  scopes.set(options.instanceId,scope);
  return scope;
};
const originalRegisterIpc=PluginScopeHandle.prototype.registerIpc;
PluginScopeHandle.prototype.registerIpc=function(spec,handler){
  const channels=registeredChannels.get(this.instanceId)??new Set();
  channels.add(spec.channel);
  registeredChannels.set(this.instanceId,channels);
  return originalRegisterIpc.call(this,spec,handler);
};
const originalDispose=IpcScope.prototype.dispose;
IpcScope.prototype.dispose=function(){
  const channels=[...this.channels];
  if(channels.length)disposedChannels.set(this.access.instanceId,channels.sort());
  return originalDispose.call(this);
};
const originalHandle=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,listener)=>originalHandle(channel,async(...args)=>{
  calls.set(channel,(calls.get(channel)??0)+1);
  return listener(...args);
});

const timeout=setTimeout(()=>{
  console.error('Plugin stage smoke timed out during '+currentPhase);
  app.exit(1);
},180000);
app.on('browser-window-created',(_event,window)=>{
  window.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message);});
  if(main)return;
  main=window;
  window.webContents.once('did-finish-load',()=>void run().catch(error=>{
    console.error(error.stack??error);
    console.error(JSON.stringify({phase:currentPhase,errors}));
    clearTimeout(timeout);
    app.exit(1);
  }));
});
app.on('window-all-closed',()=>{if(!finished)app.exit(1);});
app.on('quit',()=>{
  fs.rmSync(profile,{recursive:true,force:true});
  fs.rmSync(profile+'-profiles',{recursive:true,force:true});
});

const breadcrumbs={
  overview:[],records:[],sources:[],ask:[],work:[],settings:[],
  screen:['settings'],sync:['settings'],privacy:['settings'],permissions:['settings'],connection:['settings'],
  uploads:['work'],
  'mac-options':['settings'],preferences:['settings','mac-options'],
  capture:['settings','mac-options'],chrome:['settings','mac-options'],developer:['settings','mac-options'],about:['settings','mac-options'],
  compression:['settings','mac-options','capture'],
  activity:['settings','mac-options'],statistics:['settings','mac-options'],
  storage:['settings','connection'],backup:['settings','connection'],restore:['settings','connection','backup'],
};
const pageChecks={
  overview:'[data-page=overview] #home-first-title',
  records:'[data-page=records] #content-feed',
  sources:'[data-page=sources] #source-list',
  ask:'[data-page=ask] #ask-disconnected',
  work:'[data-page=work] #work-local-state',
  settings:'#settings-fields',
  screen:'[data-page=screen] #start',
  sync:'[data-page=sync] #sync-mode',
  privacy:'[data-page=privacy] .page-header',
  permissions:'[data-page=permissions] #permission-screen',
  connection:'[data-page=connection] #connection-input',
  capture:'[data-page=capture] #interval',
  chrome:'[data-page=chrome] #chrome-check-result',
  about:'[data-page=about] #about-version',
  activity:'[data-page=activity] #collection-statistics',
  statistics:'[data-page=statistics] #storage-statistics',
  developer:'[data-page=developer] #diagnostics-enabled',
  'mac-options':'[data-page=mac-options] .settings-menu',
  preferences:'[data-page=preferences] #appearance',
  storage:'[data-page=storage] #capture-directory',
  backup:'[data-page=backup] #backup-facts',
  restore:'[data-page=restore] #restore-selection',
  uploads:'[data-page=uploads] #upload-run-list',
  compression:'[data-page=compression] #compression-quality',
};
const expectedScopes=[
  'mote.notes','mote.library-workspace','mote.device-settings','mote.work-history-workspace',
  'mote.sources','mote.chrome','mote.capture','mote.local-storage-backup','mote.system-tools','mote.ask',
  'mote.capability-publisher',
];
const hostScopes=['mote.host'];

async function run(){
  const js=code=>main.webContents.executeJavaScript(code);
  const quick=()=>BrowserWindow.getAllWindows().find(window=>window!==main&&window.webContents.getURL().endsWith('#quick-note'));
  const closeQuick=async()=>{
    const note=quick();
    if(!note)return;
    note.close();
    await until(()=>!quick(),'quick note closes');
  };
  const clickVisible=selector=>js(`(()=>{const node=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(value=>value.getClientRects().length>0);if(!node)return false;node.click();return true;})()`);
  const shot=async(name,window=main)=>{
    await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const image=await window.webContents.capturePage();
    const file=path.join(output,name+'.png');
    fs.writeFileSync(file,image.toPNG());
    captures.push({name,file,pixels:image.getSize(),viewport:await window.webContents.executeJavaScript('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})'),at:new Date().toISOString()});
  };
  const visiblePage=page=>`Array.from(document.querySelectorAll('[data-page="${page}"]')).some(element=>element.getClientRects().length>0&&!element.hidden)`;
  const navigate=async page=>{
    currentPhase='navigate '+page;
    await closeQuick();
    for(const crumb of breadcrumbs[page]??[]){
      if(!await clickVisible(`[data-nav="${crumb}"]`))throw Error('No route to '+crumb+' while opening '+page);
      await delay(140);
    }
    if(!await clickVisible(`[data-nav="${page}"]`))throw Error('No visible route to '+page);
    await until(()=>js(visiblePage(page)),'page '+page);
    assert(await js(`Array.from(document.querySelectorAll('[data-page]')).filter(element=>!element.hidden).every(element=>element.dataset.page===${JSON.stringify(page)})`),'only '+page+' should be visible');
    assert(await js('document.activeElement.matches("[data-page-title]")'),'navigation focuses the '+page+' heading');
    observedPages.add(page);
  };
  const assertChannelWorks=async(code,label)=>{
    const value=await js(code);
    assert.notEqual(value,undefined,label+' returns a value');
    return value;
  };

  currentPhase='startup';
  await until(()=>js('!document.querySelector("#settings-fields").disabled'),'settings ready');
  assert.equal(main.isVisible(),false,'the stage fixture stays hidden');
  assert.equal(await js('document.visibilityState'),'visible','hidden fixture still runs a real renderer');
  assert.equal(await js('typeof window.require==="undefined"&&typeof window.process==="undefined"'),true,'renderer has no Node access');
  assert.equal(await js('Boolean(window.mote)&&Object.keys(window.mote).length>0'),true,'preload exposes only the owner API');
  assert.equal(await js('typeof window.mote.ask==="function"&&typeof window.mote.noteDraft==="function"&&typeof window.mote.localContent==="function"'),true,'declared plugin services reach the renderer');
  assert.equal(await js('typeof window.mote.env==="undefined"&&typeof window.mote.fs==="undefined"'),true,'no raw host objects are exposed');
  checks.push('hidden renderer, preload-only owner API and no Node/raw host access');

  for(const page of Object.keys(pageChecks)){
    await navigate(page);
    assert(await js(`document.querySelector(${JSON.stringify(pageChecks[page])})!==null`),'missing landmark for '+page);
    await shot('page-'+page);
  }
  assert.deepEqual([...observedPages].sort(),Object.keys(pageChecks).sort(),'every primary and secondary page is reachable');
  checks.push('traversed the '+Object.keys(pageChecks).length+' routed pages and captured hidden screenshots');

  // Every built-in business plugin must own exactly one host scope; the shell
  // host primitive is separate and owns only the declared host channels.
  for(const id of expectedScopes)assert(scopes.has(id),'missing plugin scope '+id);
  for(const id of hostScopes)assert(scopes.has(id),'missing host primitive scope '+id);
  assert.deepEqual([...scopes.keys()].filter(id=>!hostScopes.includes(id)).sort(),expectedScopes.slice().sort(),'unexpected or missing plugin scopes');
  const scopeChannels=Object.fromEntries([...registeredChannels].map(([id,channels])=>[id,[...channels].sort()]));
  assert(scopeChannels['mote.notes'].includes('mote:note-draft')&&scopeChannels['mote.notes'].includes('mote:note'),'notes owns its draft/save IPC');
  assert(scopeChannels['mote.sources'].includes('mote:sources'),'sources owns source reads');
  assert(scopeChannels['mote.capture'].includes('mote:start'),'capture owns collection control');
  assert(scopeChannels['mote.host'].includes('mote:get-status')&&scopeChannels['mote.host'].includes('mote:set-appearance'),'the explicit host primitive owns shell transport');
  checks.push('all '+expectedScopes.length+' business plugin scopes plus the explicit host primitive own their declared IPC channels');

  // Quick-note draft is durable across window close/reopen; saving it produces
  // local content that the library plugin reads through the real preload IPC.
  currentPhase='note draft and content reader';
  const openNote=async()=>{
    await clickVisible('#note-action');
    await until(async()=>{
      const note=quick();
      return Boolean(note)&&!note.webContents.isLoading()&&await note.webContents.executeJavaScript('!document.querySelector("#note-text").disabled');
    },'quick note ready');
    return quick();
  };
  let note=await openNote();
  assert.equal(note.isVisible(),false,'quick note also stays hidden');
  assert(await note.webContents.executeJavaScript(visiblePage('notes')),'quick note shows its page');
  assert.equal(await note.webContents.executeJavaScript('window.mote.noteDraft().then(value=>typeof value.text==="string")'),true,'quick note may use its declared notes service');
  await assert.rejects(note.webContents.executeJavaScript('window.mote.localContent(0)'),'quick note may not read library content');
  observedPages.add('notes');
  const draft='Generated stage note draft\nwith a durable second line.';
  await note.webContents.executeJavaScript(`document.querySelector('#note-text').value=${JSON.stringify(draft)};document.querySelector('#note-text').dispatchEvent(new Event('input',{bubbles:true}))`);
  await until(()=>note.webContents.executeJavaScript(`window.mote.noteDraft().then(value=>value.text===${JSON.stringify(draft)})`),'durable note draft');
  await note.webContents.executeJavaScript('document.querySelector("#note-collapse").click()');
  await until(()=>!quick(),'note collapses');
  note=await openNote();
  assert.equal(await note.webContents.executeJavaScript('document.querySelector("#note-text").value'),draft,'draft survives close/reopen');
  await shot('quick-note-draft',note);
  const savedNote='Generated saved stage note\nwith a second line.';
  await note.webContents.executeJavaScript(`document.querySelector('#note-text').value=${JSON.stringify(savedNote)};document.querySelector('#note-text').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#note-form').requestSubmit()`);
  await until(()=>!quick(),'note saves and closes');
  await navigate('records');
  await until(()=>js('document.querySelectorAll("#content-feed .content-row").length>0'),'local content row');
  const contentKey=await js('document.querySelector("#content-feed .content-row").dataset.contentKey');
  await js('document.querySelector("#content-feed .content-row").click()');
  await until(()=>js(visiblePage('content-reader')+'&&document.querySelector("#content-detail-body").textContent.includes("Generated saved stage note")'),'content reader');
  observedPages.add('content-reader');
  await shot('content-reader');
  await js('document.querySelector("#content-detail-close").click()');
  await until(()=>js(visiblePage('records')),'content reader returns to records');
  assert.equal(await js('document.activeElement.dataset.contentKey'),contentKey,'closing the reader returns focus to the selected row');
  checks.push('quick-note draft survives close/reopen; its window is denied the main-only library service; save opens the local content reader and returns focus');

  // Source add/read/back and the two source-specific workspaces.
  currentPhase='source flow';
  await navigate('sources');
  await js('document.querySelector("#source-add").click()');
  assert.equal(await js('document.querySelectorAll("#source-add-dialog .source-choice").length'),5,'all default source choices are present');
  await js('document.querySelector("#source-directory").click()');
  await until(()=>js(visiblePage('source-editor')),'source editor');
  observedPages.add('source-editor');
  await js('document.querySelector("#source-change-selection").click()');
  await until(()=>js('document.querySelector("#source-selected-names").textContent.includes("generated-source")'),'generated folder selection');
  await shot('source-editor');
  assert.equal(await js('document.querySelector("#source-confirm").disabled'),false,'generated folder can be confirmed');
  await js('document.querySelector("#source-confirm").click()');
  await until(()=>js(visiblePage('sources')+'&&document.querySelectorAll("#source-list button").length===1'),'source saved');
  await until(()=>js('window.mote.sources().then(rows=>rows.length===1&&rows[0].source.name==="generated-source")'),'source status');
  await js('document.querySelector("#source-list button").click()');
  await until(()=>js(visiblePage('source-detail')+'&&document.querySelector("#source-detail-body").textContent.includes("generated-source")'),'source detail');
  observedPages.add('source-detail');
  await shot('source-detail');
  await js('document.querySelector("[data-page=source-detail] [data-nav=sources]").click()');
  await until(()=>js(visiblePage('sources')),'source detail returns to sources');
  await js('document.querySelector("#source-add").click();document.querySelector("#source-calendar-choice-open").click()');
  await until(()=>js(visiblePage('source-connect')+'&&!document.querySelector("#source-calendar-connect").hidden'),'source connect page');
  observedPages.add('source-connect');
  await shot('source-connect');
  await js('document.querySelector("[data-page=source-connect] [data-nav=sources]").click()');
  await until(()=>js(visiblePage('sources')),'source connect returns to sources');
  checks.push('source editor/detail/connect pages reachable; source add and back use the real sources plugin');

  // Export result is the last default page surface, owned by local storage/backup.
  currentPhase='queue export and result page';
  await navigate('backup');
  await js('document.querySelector("#export").click()');
  await until(()=>js(visiblePage('export-result')+'&&document.querySelector("#backup-operation").dataset.phase==="complete"'),'queue export result');
  observedPages.add('export-result');
  await shot('export-result');
  assert(fs.existsSync(exportedQueue),'generated queue export was written');
  assert(JSON.parse(fs.readFileSync(exportedQueue,'utf8')).records.length>0,'export contains the generated local records');
  checks.push('queue export result page is reachable and writes the generated backup');

  // MAC04 stop-read contract: a hidden renderer starts no new content reads,
  // and its first visible moment catches up exactly once.
  currentPhase='stop reading while hidden';
  await navigate('records');
  await until(()=>js('document.querySelectorAll("#content-feed .content-row").length>0'),'content rows for stop-read');
  await delay(400);
  const baselineReads=calls.get('mote:content-local')??0;
  const status=await js('window.mote.status()');
  await js('window.__stageVisibility={hidden:true};Object.defineProperty(document,"hidden",{configurable:true,get:()=>window.__stageVisibility.hidden});document.dispatchEvent(new Event("visibilitychange"));true');
  main.webContents.send('mote:status',{...status,queueDepth:(status.queueDepth??0)+1});
  await delay(3400);
  assert.equal(calls.get('mote:content-local')??0,baselineReads,'hidden renderer starts no new content read');
  await js('window.__stageVisibility.hidden=false;document.dispatchEvent(new Event("visibilitychange"));delete document.hidden;delete window.__stageVisibility;true');
  await until(()=> (calls.get('mote:content-local')??0)>=baselineReads+1,'visible catch-up read');
  await delay(300);
  assert.equal(calls.get('mote:content-local'),baselineReads+1,'visible renderer performs one catch-up read');
  checks.push('hidden content surface defers reads; first visible moment catches up once');

  // Runtime replacement: withdraw one plugin scope and register a replacement
  // plugin that declares only the content list contribution. Unrelated plugin
  // services and the durable queue stay intact.
  currentPhase='replace the library plugin';
  await navigate('records');
  await until(()=>js('document.querySelectorAll("#content-feed .content-row").length>0'),'content before replacement');
  const beforeReplacement=await js('window.mote.localContent(0)');
  assert(beforeReplacement.items.length>0,'original library reads local content');
  const queueDepthBefore=await js('window.mote.status().then(value=>value.queueDepth)');
  const library=scopes.get('mote.library-workspace');
  assert(library,'library scope exists');
  assert.deepEqual(stageHost.stopScope('mote.library-workspace'),[],'library scope stops without cleanup errors');
  assert.deepEqual(disposedChannels.get('mote.library-workspace'),[...registeredChannels.get('mote.library-workspace')].sort(),'the stopped plugin disposed exactly its declared IPC channels');
  await assert.rejects(js('window.mote.localContent(0)'),'stopped library contribution is gone');
  await assert.rejects(js('window.mote.memoryTopics()'),'other contributions from the stopped plugin are gone');
  const replacementTitle='阶段替换内容';
  const replacement={
    id:'stage.library-replacement',
    async register({host,pageUrl}){
      const scope=host.createScope({instanceId:'stage.library-replacement',capabilities:['library.read']});
      const outcome=await host.startPlugin(scope,plugin=>{
        plugin.registerIpc({
          channel:'mote:content-local',capability:'library.read',windowRoles:['main'],
          callerCapability:'library.read',roleFrameUrls:{main:[pageUrl]},
        },()=>({items:[{key:'local:stage-replacement',source:'note',title:replacementTitle,observedAt:new Date().toISOString(),preview:'Generated replacement contribution'}],total:1}));
      });
      if(!outcome.started)throw outcome.error;
      return scope;
    },
  };
  await replacement.register({host:stageHost,pageUrl:main.webContents.getURL()});
  const replaced=await js('window.mote.localContent(0)');
  assert.equal(replaced.items.length,1,'replacement declares one local content row');
  assert.equal(replaced.items[0].title,replacementTitle);
  await js('document.querySelector("#content-refresh").click()');
  await until(()=>js(`document.querySelector("#content-feed").textContent.includes(${JSON.stringify(replacementTitle)})`),'replacement contribution renders');
  assert.equal(await js('window.mote.status().then(value=>value.queueDepth)'),queueDepthBefore,'replacement leaves the durable queue untouched');
  await assertChannelWorks('window.mote.noteDraft().then(value=>typeof value.text==="string")','notes plugin after replacement');
  await assertChannelWorks('window.mote.sources().then(value=>Array.isArray(value))','sources plugin after replacement');
  await assertChannelWorks('window.mote.language().then(value=>Boolean(value))','device-settings plugin after replacement');
  await assertChannelWorks('window.mote.updateStatus().then(value=>Boolean(value.state))','system-tools plugin after replacement');
  checks.push('withdrawing one plugin removes only its declared IPC; a replacement contribution works and other plugins remain live');

  assert.deepEqual(errors,[],'no renderer console errors');
  assert.equal(main.isVisible(),false,'the main window stayed hidden through the whole journey');
  const domPages=await js('Array.from(new Set(Array.from(document.querySelectorAll("[data-page]")).map(element=>element.dataset.page)))');
  assert.deepEqual([...observedPages].sort(),domPages.slice().sort(),'every page present in the default package was observed');
  checks.push('observed all '+domPages.length+' pages present in the default package');
  const assets={};
  for(const name of ['main.js','ui-bundle.js','index.html','styles.css'])assets[name]=createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../dist',name))).digest('hex');
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({
    passed:true,
    revision:execFileSync('git',['rev-parse','HEAD'],{cwd:repo}).toString().trim(),
    workingTree:execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:repo}).toString().trim().length>0,
    generatedOnly:true,
    hidden:true,
    electron:process.versions.electron,
    liveModel:false,
    nativePermissions:false,
    realCentral:false,
    pages:[...observedPages].sort(),
    pluginScopes:scopeChannels,
    replacement:{plugin:'mote.library-workspace',replacement:'stage.library-replacement',contribution:'mote:content-local',removedChannels:disposedChannels.get('mote.library-workspace'),otherPluginsStillLive:true,queueUntouched:true},
    visibility:{hiddenReads:0,visibleCatchUpReads:1,method:'renderer document.hidden transition; native tray hide/show is unverified'},
    checks,
    captures,
    assets,
    unverified:[
      'native tray hide/show visibility (the renderer visibility transition was simulated)',
      'native screen/calendar permissions and screen capture',
      'real Central HTTP responses (the stage fixture is offline)',
      'live model answers and semantic quality',
      'manual visual comparison against external prototypes',
    ],
  },null,2));
  clearTimeout(timeout);
  console.log(JSON.stringify({passed:true,output,pages:observedPages.size,scopes:expectedScopes.length,captures:captures.length,generatedOnly:true,hidden:true}));
  finished=true;
  app.quit();
}

require('../dist/main');
