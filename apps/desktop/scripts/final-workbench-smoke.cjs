require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');
const {app,BrowserWindow,safeStorage,ipcMain,dialog}=require('electron');
const {createServer}=require('node:http');
const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=require('node:fs');
const {join,resolve}=require('node:path');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');
const {defaultConfig}=require('../dist/config');

// Generated loopback data only. The actual renderer, preload, IPC and draft store run.
app.commandLine.appendSwitch('force-device-scale-factor','1');
safeStorage.isEncryptionAvailable=()=>{throw Error('Dev fixture must not access safeStorage');};
const profile=mkdtempSync(join(tmpdir(),'mote-final-workbench-'));
app.setPath('userData',profile);process.env.MOTE_PROFILE='dev';
for(const key of ['MOTE_URL','MOTE_TOKEN','MOTE_ENV_FILE'])delete process.env[key];
const dataDirectory=join(profile+'-profiles','dev');mkdirSync(dataDirectory,{recursive:true,mode:0o700});
const output=resolve(process.env.MOTE_FINAL_UI_OUTPUT||join(__dirname,'../../../.mote/final-ui-product/workbench'));
mkdirSync(output,{recursive:true});
const token='generated-final-workbench-token-'.repeat(3),id='11111111-1111-4111-8111-111111111111';
const requests=[],errors=[],captures=[],nativeReceipts=[];let pickerPaths=[];dialog.showOpenDialog=async()=>({canceled:!pickerPaths.length,filePaths:pickerPaths});const firstFile=join(profile,'generated-first.md'),secondFile=join(profile,'generated-second.md');writeFileSync(firstFile,'Generated first selected original.');writeFileSync(secondFile,'Generated second selected original.');
const summary={id,title:'周五评审需要准备什么？',turnCount:1,updatedAt:'2026-10-28T08:20:00Z'};
let historyFailure=false,localReadFailure=false,historyEmpty=true,finished=false,main;const firstFileUse=process.env.MOTE_FIRST_USE_FILE==='1',multipleFiles=process.env.MOTE_FIRST_USE_MULTIPLE==='1',offlineFirstUse=firstFileUse||process.env.MOTE_FIRST_USE_OFFLINE==='1';
const registerHandler=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,handler)=>registerHandler(channel,(event,...args)=>{if(channel==='mote:content-local'&&localReadFailure)throw Error('Generated local content read failure');const result=handler(event,...args);if(channel==='mote:source-confirm')return Promise.resolve(result).then(receipt=>{nativeReceipts.push(receipt);return receipt;});return result;});
const server=createServer((req,res)=>{
  requests.push({method:req.method,path:req.url});res.setHeader('content-type','application/json');
  assert.equal(req.headers.authorization,'Bearer '+token);
  const path=new URL(req.url,'http://fixture').pathname;
  if(path==='/api/conversations'){
    res.statusCode=historyFailure?503:200;res.end(JSON.stringify({items:historyEmpty?[]:[summary]}));return;
  }
  if(path==='/api/conversations/'+id){res.end(JSON.stringify({...summary,revision:1,turns:[{id:'22222222-2222-4222-8222-222222222222',question:summary.title,status:'completed',result:{answer:'Generated answer for UI verification.',citations:[]}}]}));return;}
  if(path==='/api/query-runs'){res.end(JSON.stringify({items:[]}));return;}
  if(path==='/api/capture-browser'){res.end(JSON.stringify({items:[],totalCount:0,nextCursor:null}));return;}
  if(path==='/api/connections/self'){res.end(JSON.stringify({credential:{id:'generated-owner',scope:'owner',label:'Generated fixture'},node:{version:'fixture',profile:'fixture',protocol:{min:1,max:1}},capabilities:{ingest:true,ownSources:true,archiveRead:true}}));return;}
  res.statusCode=404;res.end('{}');
});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(check,label)=>{for(let i=0;i<400;i++){if(await check())return;await delay(25);}throw Error('Timed out: '+label);};
const timeout=setTimeout(()=>{console.error('Final workbench fixture timed out');app.exit(1);},60000);
app.on('browser-window-created',(_event,window)=>{
  if(main)return;main=window;
  window.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message);});
  window.webContents.once('did-finish-load',()=>void(async()=>{
    const js=code=>window.webContents.executeJavaScript(code);
    const quick=()=>BrowserWindow.getAllWindows().find(candidate=>candidate!==window&&candidate.webContents.getURL().endsWith('#quick-note'));
    const waitQuick=async()=>{await until(async()=>{const note=quick();return note&&!note.webContents.isLoading()&&await note.webContents.executeJavaScript('!document.querySelector("#note-text").disabled');},'quick note');return quick();};
    const shot=async(name)=>{
      window.webContents.sendInputEvent({type:'mouseMove',x:1000,y:12});
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const image=await window.webContents.capturePage();const file=join(output,name+'.png');writeFileSync(file,image.toPNG());
      captures.push({name,file,pixels:image.getSize(),viewport:await js('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})'),at:new Date().toISOString()});
    };
    await until(()=>js('!!document.querySelector("[data-presentation-nav]")&&!document.querySelector("#settings-fields").disabled'),'renderer ready');
    assert.equal(window.isVisible(),false);
    window.setContentSize(1440,936);
    await until(()=>js('!document.querySelector("#home-onboarding").hidden'),'confirmed first-use');
    assert.equal(await js('document.querySelector("#home-first-connect").hidden'),!offlineFirstUse);await shot(offlineFirstUse?'first-use-local':'first-use-connected');window.setContentSize(820,620);assert(await js('document.documentElement.scrollWidth<=innerWidth'));await shot(offlineFirstUse?'first-use-local-compact':'first-use-connected-compact');window.setContentSize(1440,936);
    if(firstFileUse){
      await js('document.querySelector("#home-onboarding [data-add-choice=file]").click()');await until(()=>js('!document.querySelector("[data-page=overview]").hidden'),'first file picker cancellation returns Home');assert.equal((await js('window.mote.sources()')).length,0);await shot('first-file-canceled');
      pickerPaths=multipleFiles?[firstFile,secondFile]:[firstFile];await js('document.querySelector("#home-onboarding [data-add-choice=file]").click()');await until(()=>js('!document.querySelector("[data-page=source-editor]").hidden&&!document.querySelector("#source-confirm").disabled'),'generated native selection');await shot('first-file-selected');await js('document.querySelector("#source-confirm").click()');await until(()=>nativeReceipts.length===1,'actual source ID receipt');const ids=nativeReceipts[0].sourceIds;assert.equal(ids.length,multipleFiles?2:1);assert(!JSON.stringify(nativeReceipts).includes(profile),'Native paths are excluded from save receipts');const statuses=await js('window.mote.sources()');assert(ids.every(id=>statuses.some(row=>row.source.id===id)));
      if(multipleFiles){await until(()=>js('!document.querySelector("[data-page=records]").hidden'),'multiple imports remain owner-selected in Content');assert.equal(await js('document.querySelector("#home-first-record").hidden'),true);await shot('first-file-multiple-content');}
      else{await until(()=>js('document.querySelector("#home-first-record-preview").textContent==="Generated first selected original."'),'exact saved file consumer');const page=await js('window.mote.sourcePendingContent('+JSON.stringify(ids[0])+')');assert.equal(page.total,1);assert(page.items[0].key.startsWith('source:'+ids[0]+':'));await shot('first-file-saved');await js('document.querySelector("#home-first-read").click()');await until(()=>js('document.querySelector("#content-detail-body").textContent==="Generated first selected original."'),'exact selected original reader');await shot('first-file-original');}
      assert.deepEqual(errors,[]);writeFileSync(join(output,'first-file-result.json'),JSON.stringify({passed:true,generatedOnly:true,hidden:true,liveModel:false,nativePermission:false,sourceIds:ids,captures},null,2));finished=true;clearTimeout(timeout);console.log(JSON.stringify({passed:true,output,captures:captures.length,firstFile:true,multipleFiles}));app.quit();return;
    }
    if(offlineFirstUse){await js('document.querySelector("#home-onboarding [data-add-choice=note]").click()');const first=await waitQuick();await first.webContents.executeJavaScript('document.querySelector("#note-text").value="Generated first local note";document.querySelector("#note-text").dispatchEvent(new Event("input"));document.querySelector("#note-form").requestSubmit();true');await until(()=>!quick(),'first local note saved');await until(()=>js('!!document.querySelector("#home-recent .content-row")'),'first local original visible');assert.equal((await js('window.mote.status()')).running,false);await until(()=>js('document.querySelector("#home-first-record-preview").textContent==="Generated first local note"'),'tracked first record original');await shot('first-use-saved-local');await js('document.querySelector("#home-first-read").click()');await until(()=>js('document.querySelector("#content-detail-body").textContent==="Generated first local note"'),'first original reader');await shot('first-use-original');await js('document.querySelector("#content-detail-close").click()');assert.equal(await js('document.querySelector("#home-onboarding").hidden'),false,'Returning from the exact first original keeps this temporary first-use path');await js('document.querySelector("aside [data-nav=records]").click();document.querySelector("aside [data-nav=overview]").click()');assert.equal(await js('document.querySelector("#home-onboarding").hidden'),true,'Leaving the first-use path restores the regular workbench from actual content');assert.deepEqual(errors,[]);writeFileSync(join(output,'first-use-result.json'),JSON.stringify({passed:true,generatedOnly:true,hidden:true,liveModel:false,nativePermission:false,captures},null,2));finished=true;clearTimeout(timeout);console.log(JSON.stringify({passed:true,output,captures:captures.length,firstUse:true}));app.quit();return;}
    historyEmpty=false;await js('document.querySelector("aside [data-nav=records]").click();document.querySelector("aside [data-nav=overview]").click()');await until(()=>js('!!document.querySelector("#home-conversations button")'),'existing history');

    await js('window.confirm=()=>true;document.querySelector("#note-action").click()');
    const note=await waitQuick();assert.equal(note.isVisible(),false);
    await note.webContents.executeJavaScript('document.querySelector("#note-text").value="评审前的提醒";document.querySelector("#note-text").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#note-form").requestSubmit()');
    await until(()=>!quick(),'note saves and closes');
    await until(()=>js('!!document.querySelector("#home-recent .content-row")&&!!document.querySelector("#home-conversations button")'),'home real records and history');
    assert.equal(await js('document.querySelector("[data-page=overview]").hidden'),false);
    assert.deepEqual(await js('Array.from(document.querySelectorAll(".main-nav [data-nav]")).map(b=>b.querySelector("span:not([aria-hidden])").textContent.trim())'),['工作台','内容','来源','问一问']);
    assert.equal(await js('document.querySelector("#home-onboarding").hidden'),true);
    assert.equal(await js('document.querySelector("#note-action").textContent.trim()'),'＋记录');
    assert.equal(await js('document.querySelector("#home-recent .content-state").textContent'),'本机待发送');
    assert.equal(await js('document.querySelector("#home-conversations button").dataset.conversationId'),id);
    assert.equal((await js('window.mote.status()')).running,false);
    await shot('home');

    await js('document.querySelector("#home-question").value="Generated home draft";document.querySelector("#home-question").dispatchEvent(new Event("input"));document.querySelector("#home-ask-form").requestSubmit()');
    await until(()=>js('!document.querySelector("[data-page=ask]").hidden&&!document.querySelector("#ask-new").disabled'),'question enters Ask');
    assert.equal(await js('document.querySelector("#ask-question").value'),'Generated home draft');
    assert.equal(requests.some(r=>r.method==='POST'&&r.path==='/api/query-runs'),false,'Home entry does not silently send a model request');
    await js('document.querySelector("aside [data-nav=overview]").click();window.confirm=()=>false;document.querySelector("#home-question").value="Generated replacement";document.querySelector("#home-question").dispatchEvent(new Event("input"));document.querySelector("#home-ask-form").requestSubmit()');
    assert.equal(await js('document.querySelector("[data-page=overview]").hidden'),false);
    assert.equal(await js('document.querySelector("#home-question").value'),'Generated replacement');
    assert.equal(await js('document.querySelector("#ask-question").value'),'Generated home draft');
    await js('window.confirm=()=>true;document.querySelector("#home-conversations button").click()');
    await until(()=>js('document.querySelectorAll("#ask-messages article").length===1&&!document.querySelector("#ask-new").disabled'),'same conversation opens');
    assert(requests.some(r=>r.path==='/api/conversations/'+id+'?limit=20'));

    await js('document.querySelector("aside [data-nav=settings]").click();document.querySelector("[data-page=settings] [data-nav=mac-options]").click();document.querySelector("[data-page=mac-options] [data-nav=capture]").click();document.querySelector("#interval").value="45";document.querySelector("#interval").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#note-action").click()');
    const draftWindow=await waitQuick();
    await draftWindow.webContents.executeJavaScript('document.querySelector("#note-text").value="Generated persistent note draft";document.querySelector("#note-text").dispatchEvent(new Event("input",{bubbles:true}))');
    await delay(350);draftWindow.close();await until(()=>!quick(),'draft window closes');
    assert.equal(await js('document.querySelector("[data-page=capture]").hidden'),false);
    assert.equal(await js('document.querySelector("#interval").value'),'45');
    assert.equal(await js('document.querySelector("#settings-pending").hidden'),false);
    await js('document.querySelector("#note-action").click()');const restored=await waitQuick();
    assert.equal(await restored.webContents.executeJavaScript('document.querySelector("#note-text").value'),'Generated persistent note draft');restored.close();await until(()=>!quick(),'restored draft closes');
    await js('document.querySelector("#settings-reset").click();document.querySelector("aside [data-nav=overview]").click();document.querySelector("#home-question").value="";document.querySelector("#home-question").dispatchEvent(new Event("input"));window.mote.setSyncPaused(true)');
    await until(()=>js('document.querySelector("#home-collection-summary").textContent.includes("发送已暂停")'),'independent send pause');
    assert.equal((await js('window.mote.status()')).running,false);await shot('home-sending-paused');

    historyFailure=true;await js('document.querySelector("aside [data-nav=records]").click();document.querySelector("aside [data-nav=overview]").click()');
    await until(()=>js('document.querySelector("#home-conversations").textContent.includes("对话暂不可读取")'),'history error');
    assert(await js('!!document.querySelector("#home-recent .content-row")'),'History failure retains local content');await shot('home-history-error');
    historyFailure=false;await js('document.querySelector("#home-conversations button").click()');
    await until(()=>js('!!document.querySelector("#home-conversations button")'),'history retry');
    localReadFailure=true;await js('document.querySelector("aside [data-nav=records]").click();document.querySelector("aside [data-nav=overview]").click()');
    await until(()=>js('document.querySelector("#home-recent").textContent.includes("内容暂不可完整读取")'),'local read error');
    assert(await js('!!document.querySelector("#home-recent .content-row")&&document.querySelector("#home-onboarding").hidden'));
    assert.equal(await js('document.querySelector("#home-recent").textContent.includes("还没有本机内容")'),false);await shot('home-content-error');
    localReadFailure=false;await js('document.querySelector("#home-recent > button.text-button").click()');
    await until(()=>js('!document.querySelector("#home-recent").textContent.includes("内容暂不可完整读取")'),'local read retry');
    window.setContentSize(820,620);await shot('home-compact');assert(await js('document.documentElement.scrollWidth<=innerWidth'));
    assert.deepEqual(errors,[]);
    const result={passed:true,generatedOnly:true,hidden:true,electron:process.versions.electron,sourceComparison:'Source rendered separately through CUA; this fixture captures the product only',realRendererPreloadIpc:true,liveModel:false,palette:'source light #777066 muted; coordinated tokens',sourceReference:'http://127.0.0.1:61985/index.html and first-use.html; separate source comparison',checks:['real local note and conversation summaries','same conversation ID','home input preserved on cancel','home entry does not send','global note preserves settings draft and origin','quick-note draft survives close','capture and send pause independent','history failure/retry preserves local content','compact window has no horizontal overflow'],captures};
    writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));
    finished=true;clearTimeout(timeout);console.log(JSON.stringify({passed:true,output,captures:captures.length}));app.quit();
  })().catch(error=>{console.error(error.stack);console.error(errors);clearTimeout(timeout);app.exit(1);}));
});
app.on('window-all-closed',()=>{if(!finished)app.exit(1);});
app.on('quit',()=>{server.close();rmSync(profile,{recursive:true,force:true});rmSync(profile+'-profiles',{recursive:true,force:true});});
server.listen(0,'127.0.0.1',()=>{
  const config={...defaultConfig(),serverUrl:offlineFirstUse?'':'http://127.0.0.1:'+server.address().port,deviceName:'这台 Mac',metadataEnabled:false,syncMode:'manual',credentialScope:'owner'};
  writeFileSync(join(dataDirectory,'config.json'),JSON.stringify({version:4,...(offlineFirstUse?{}:{developmentToken:token}),config}),{mode:0o600});
  writeFileSync(join(dataDirectory,'storage-format.json'),JSON.stringify({version:4}),{mode:0o600});require('../dist/main');
});
