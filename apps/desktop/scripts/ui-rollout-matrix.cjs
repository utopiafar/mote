// The entry point is ui-smoke.cjs, which loads fixture-background before Electron.
// This fixture uses the real product renderer, preload, main and generated profile.
const {readFileSync,writeFileSync} = require('node:fs');
const {join,resolve} = require('node:path');
const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');

module.exports = async function({window,js,navigate,outputDirectory,profile,ipcMain}) {
  const repo=resolve(__dirname,'../../..');
  const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
  const sourceFiles=['apps/desktop/src/index.html','apps/desktop/src/styles.css','apps/desktop/src/art-direction.css','apps/desktop/src/design-tokens.css','apps/desktop/src/ui.ts','packages/shared/design-tokens.json','packages/shared/src/i18n-en.ts','packages/shared/src/i18n.ts'];
  const sourceIdentity=Object.fromEntries(sourceFiles.map(file=>[file,digest(join(repo,file))]));
  const buildIdentity=Object.fromEntries(['main.js','ui-bundle.js','index.html','styles.css','design-tokens.css','art-direction.css'].map(file=>[file,digest(join(__dirname,'../dist',file))]));
  const nativeIdentity=Object.fromEntries(['mote-helper','mote-updater','mote.icns'].map(file=>[file,digest(join(__dirname,'../native/bin',file))]));
  const parentCommit=spawnSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).stdout.trim();
  const workingTreeChanges=spawnSync('git',['status','--porcelain','--','apps/desktop','packages/shared/design-tokens.json'],{cwd:repo,encoding:'utf8'}).stdout;
  const captures=[],journeys=[];
  const supplement=process.env.MOTE_UI_ROLLOUT_SUPPLEMENT==='1',observations=[],coverage=[];
  const fixtureIdentity=Object.fromEntries(['apps/desktop/scripts/ui-rollout-matrix.cjs','apps/desktop/scripts/ui-smoke.cjs','scripts/fixture-background.cjs','scripts/fixture-language.cjs'].map(file=>[file,digest(join(repo,file))]));
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function until(read,label) { const end=Date.now()+15000; while(Date.now()<end){if(await read())return;await delay(30);}throw Error('Rollout readiness: '+label); }
  const frames=()=>js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  async function ready(page) {
    await until(()=>js('!document.querySelector("#settings-fields").disabled&&Array.from(document.querySelectorAll("[data-page]")).filter(e=>!e.hidden).every(e=>e.dataset.page==='+JSON.stringify(page)+')'),page+' initialized');
    const gates={overview:'#home-recent .content-row',records:'#content-feed .content-row',notes:'#note-text:not(:disabled)',ask:'#ask-disconnected:not([hidden])',settings:'[data-page=settings] .settings-menu',connection:'#connection-onboarding',permissions:'#permission-screen.permission-badge',statistics:'#storage-statistics h2',compression:'#compression-before[src]',about:'#update-version',activity:'#collection-statistics',sources:'#source-list',uploads:'#upload-received',sync:'#sync-policy-help',capture:'#capture-advanced',privacy:'#default-collection',developer:'[data-page=developer] .advanced-settings>summary',screen:'#collection-workbench:not([hidden]),#setup-prompt:not([hidden])'};
    await until(()=>js('(()=>{const e=document.querySelector('+JSON.stringify(gates[page])+');return !!e&&e.getClientRects().length>0;})()'),page+' consumer');
    if(['overview','records'].includes(page))await until(()=>js('document.querySelector("#content-status").getAttribute("aria-busy")==="false"'),page+' content loaded');
    if(page==='compression')await until(()=>js('!document.querySelector("#compression-apply").disabled'),'compression generated');
    return {page,marker:gates[page],ready:true,locale:await js('document.documentElement.lang')};
  }
  function geometry() {
    const footer=document.querySelector('#settings-save-bar'),r=footer.getBoundingClientRect();
    const visible=e=>e.getClientRects().length>0&&!e.closest('[hidden]')&&!e.closest('details:not([open])');
    const bounds=e=>{const b=e.getBoundingClientRect();return {left:b.left,top:b.top,right:b.right,bottom:b.bottom,width:b.width,height:b.height};};
    // Inputs intentionally scroll long values and textareas scroll full drafts;
    // their outer bounds must fit, while button labels must fit their controls.
    const clipped=Array.from(document.querySelectorAll('main button,main input,main select,main textarea,dialog[open] button')).filter(visible).filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&(b.left<-.5||b.right>innerWidth+.5||(e.tagName==='BUTTON'&&e.scrollWidth>e.clientWidth+2));}).map(e=>({id:e.id,text:e.textContent.slice(0,80),bounds:bounds(e),scroll:e.scrollWidth,client:e.clientWidth}));
    const sidebarControls=Array.from(document.querySelectorAll('.sidebar .nav-item')).map(e=>({name:e.getAttribute('aria-label')||e.textContent.trim(),...bounds(e)}));
    const toolbar=document.querySelector('.workspace-toolbar'),readingTop=getComputedStyle(toolbar).position==='sticky'?Math.max(0,toolbar.getBoundingClientRect().bottom):0,readingBottom=!footer.hidden&&getComputedStyle(footer).position==='fixed'?r.top:innerHeight;
    // A settings journey spans a heading shell plus form and migration sections.
    // Cover their union; measuring only the first shell would miss long form bodies.
    const activePages=Array.from(document.querySelectorAll('[data-page]:not([hidden])')).filter(visible),pageRects=activePages.map(bounds);
    const pageBounds={top:Math.min(...pageRects.map(r=>r.top)),bottom:Math.max(...pageRects.map(r=>r.bottom))};
    const dialogs=Array.from(document.querySelectorAll('dialog[open]')).map(e=>({...bounds(e),id:e.id,scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,reading:{top:e.scrollTop,bottom:e.scrollTop+e.clientHeight},readerOriginalThrough:e.id==='content-detail-dialog'?document.querySelector('#content-processing summary').getBoundingClientRect().bottom-e.getBoundingClientRect().top+e.scrollTop:null}));
    return {viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},document:{scrollY,scrollHeight:document.documentElement.scrollHeight,reading:{top:scrollY+readingTop,bottom:scrollY+readingBottom},readingTop,readingBottom,pageBounds:{top:pageBounds.top+scrollY,bottom:pageBounds.bottom+scrollY}},dialogs,horizontalOverflow:document.documentElement.scrollWidth>innerWidth,clipped,sidebarControls,footer:footer.hidden?null:{...bounds(footer),position:getComputedStyle(footer).position,reserved:parseFloat(document.documentElement.style.getPropertyValue('--settings-save-height')),buttons:Array.from(footer.querySelectorAll('button')).map(e=>({text:e.textContent,bounds:bounds(e)}))}};
  }
  function uncovered(region,intervals) {
    const sorted=intervals.map(x=>({top:Math.max(region.top,x.top),bottom:Math.min(region.bottom,x.bottom)})).filter(x=>x.bottom>x.top).sort((a,b)=>a.top-b.top);
    const gaps=[];let cursor=region.top;for(const x of sorted){if(x.top>cursor+1)gaps.push({top:cursor,bottom:x.top});cursor=Math.max(cursor,x.bottom);}if(cursor<region.bottom-1)gaps.push({top:cursor,bottom:region.bottom});return gaps;
  }
  async function fillCoverage(name,page,items,selector,dialogId,readerChanged,consumer) {
    const saved=await js('({y:scrollY,dialogs:Array.from(document.querySelectorAll("dialog[open]")).map(e=>({id:e.id,top:e.scrollTop}))})');
    const region=dialogId?{top:0,bottom:items.at(-1).layout.dialogs.find(x=>x.id===dialogId).scrollHeight}:selector?await js('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {top:r.top+scrollY,bottom:r.bottom+scrollY};})()'):items.at(-1).layout.document.pageBounds;
    const intervals=items.map((item,index)=>{const r=dialogId?item.layout.dialogs.find(x=>x.id===dialogId).reading:item.layout.document.reading;return readerChanged&&index===0?{top:r.top,bottom:Math.min(r.bottom,item.layout.dialogs.find(x=>x.id===dialogId).readerOriginalThrough)}:r;});
    const plan={name,page,region,baseline:items.map((x,i)=>({referenceFile:x.file,reading:intervals[i]})),uncoveredBefore:uncovered(region,intervals),supplementalFiles:[]};
    let count=0;
    while(uncovered(region,intervals).length) {
      const gap=uncovered(region,intervals)[0],before=gap.top;
      if(++count>150)throw Error('Coverage did not converge '+name);
      if(dialogId)await js('document.querySelector('+JSON.stringify('#'+dialogId)+').scrollTop='+Math.max(0,gap.top-24)+';true;');
      else await js('window.scrollTo({top:'+Math.max(0,gap.top-items.at(-1).layout.document.readingTop-24)+',behavior:"instant"});true;');
      const item=await capture(name+'-middle-'+count,page,consumer,true);const range=dialogId?item.layout.dialogs.find(x=>x.id===dialogId).reading:item.layout.document.reading;
      intervals.push(range);plan.supplementalFiles.push({file:item.file,reading:range});
      const remaining=uncovered(region,intervals);if(remaining[0]?.top===before&&remaining[0]?.bottom===gap.bottom)throw Error('Unreachable visual region '+name);
    }
    plan.uncoveredAfter=uncovered(region,intervals);coverage.push(plan);
    await js('window.scrollTo({top:'+saved.y+',behavior:"instant"});'+saved.dialogs.map(x=>'document.querySelector('+JSON.stringify('#'+x.id)+').scrollTop='+x.top+';').join('')+'true;');await frames();
  }
  async function supplementAt(item) {
    const byName=name=>observations.find(x=>x.name===name),name=item.name;
    if(/^(overview|records|notes|ask|settings|connection|sync|capture|privacy|permissions|activity|statistics|developer|about|sources|uploads|screen|compression)-(zh|en)-(normal|compact|large)-end$/.test(name))await fillCoverage(name,item.page,[byName(name.replace(/-end$/,'-top')),item]);
    if(/^.+-(zh|en)-zoom200$/.test(name)&&!name.startsWith('keyboard-save'))await fillCoverage(name,item.page,[item]);
    if(/^import-end-/.test(name))await fillCoverage(name,item.page,[byName(name.replace('import-end-','import-')),item],'#source-confirmation');
    if(/^add-chooser-end-/.test(name))await fillCoverage(name,item.page,[byName(name.replace('add-chooser-end-','add-chooser-')),item],null,'add-dialog');
    if(/^reader-status-/.test(name))await fillCoverage(name,item.page,[byName(name.replace('reader-status-','reader-')),item],null,'content-detail-dialog',true);
    if(/^dirty-footer-end-/.test(name))await fillCoverage(name,item.page,[byName(name.replace('dirty-footer-end-','dirty-footer-')),item]);
    if(/^ask-evidence-(zh|en)-/.test(name))await fillCoverage(name,item.page,[byName(name.replace('ask-evidence-','ask-evidence-start-')),item],'.ask-evidence',null,false,'.ask-excerpt');
    if(/^ask-reference-focus-/.test(name))await fillCoverage(name,item.page,[byName(name.replace('ask-reference-focus-','ask-connected-')),byName(name.replace('ask-reference-focus-','ask-answer-')),byName(name.replace('ask-reference-focus-','ask-answer-end-')),item],null,null,false,'.ask-answer');
  }
  async function capture(name,page,consumer,forceWrite=false) {
    const readiness=consumer?{page,marker:consumer,ready:true,locale:await js('document.documentElement.lang'),state:'generated connected answer'}:await ready(page);await frames();
    if(consumer)assert.equal(await js('!!document.querySelector('+JSON.stringify(consumer)+')'),true,'Actual connected answer consumer');
    const layout=await js('('+geometry.toString()+')()');
    assert.equal(layout.horizontalOverflow,false,'No horizontal overflow '+name);
    assert.deepEqual(layout.clipped,[],'Complete controls '+name);
    assert.deepEqual(layout.sidebarControls.map(e=>e.name),['首页','资料库','来源','问一问','设置'],'Sidebar order '+name);
    assert(layout.sidebarControls.every(e=>e.top>=0&&e.bottom<=layout.viewport.height+1),'All navigation actions visible '+name);
    if(layout.footer){assert(Math.abs((layout.footer.position==='fixed'?layout.footer.height:0)-layout.footer.reserved)<1,'Only fixed footer is reserved '+name);assert(layout.footer.buttons.every(x=>x.bounds.top>=layout.footer.top&&x.bounds.bottom<=layout.footer.bottom+1),'Footer actions inside '+name);}
    const item={file:name+'.png',name,page,generatedOnly:true,readiness,layout,zoom:window.webContents.getZoomFactor()};
    if(!supplement||forceWrite){const png=(await window.webContents.capturePage()).toPNG();item.bitmap={width:png.readUInt32BE(16),height:png.readUInt32BE(20)};item.sha256=createHash('sha256').update(png).digest('hex');writeFileSync(join(outputDirectory,item.file),png);captures.push(item);}
    if(supplement&&!forceWrite){observations.push(item);await supplementAt(item);}return item;
  }
  async function changeLanguage(language) {
    if(await js('document.documentElement.lang')===language)return;
    await navigate('settings');const reload=new Promise(resolve=>window.webContents.once('did-finish-load',resolve));
    await js('window.confirm=()=>true;document.querySelector("#language").value='+JSON.stringify(language)+';document.querySelector("#language").dispatchEvent(new Event("change"));true;');
    await reload;await until(()=>js('document.documentElement.lang==='+JSON.stringify(language)+'&&!!document.querySelector("#workspace-location").textContent.trim()'),'locale reload');
    await js('window.confirm=()=>true;true;');
  }
  const fixtureMetadata={productVersion:require('../package.json').version,appVersionAdapter:true,developmentMetadataAdapter:process.env.MOTE_UI_ROLLOUT_DEV_ABOUT==='1'};
  function finish() {
    const manifest={platform:'mac',generatedOnly:true,passed:true,parentCommit,workingTreeChanges,sourceIdentity,buildIdentity,nativeIdentity,fixtureIdentity,fixtureMetadata,captures,journeys,supplement,coverage,observations,boundary:'Hidden real Electron product / temporary generated profile. Native picker and permission responses are generated. Product appVersion adapter; DEV-only branch uses package metadata adapter. Real Electron zoom and key events with explicit hidden renderer focus emulation; no foreground OS focus, personal capture, account, live model or physical device. Supplement mode replays reference checkpoints in fresh generated profiles on the identical product source/dist; actual scroll reading intervals identify missing spans with24CSSpx overlap. Reference equivalence is based on matching viewport/generated states and exact product hashes, not byte-identical dynamic IDs/times.',profile};
    writeFileSync(join(outputDirectory,'rollout-manifest.json'),JSON.stringify(manifest,null,2));return manifest;
  }
  if(fixtureMetadata.developmentMetadataAdapter) {
    for(const language of ['zh-CN','en']) {
      window.webContents.setZoomFactor(1);await changeLanguage(language);
      for(const [variant,width,height,zoom] of [['normal',1140,840,1],['compact',820,620,1],['large',820,620,1.3]]) {
        window.setSize(width,height);window.webContents.setZoomFactor(zoom);await navigate('about');await ready('about');
        await until(()=>js('window.mote.updateStatus().then(s=>s.manualDownload===true&&s.currentVersion==='+JSON.stringify(fixtureMetadata.productVersion)+')'),'real DEV update branch');
        assert.equal(await js('document.querySelector("#update-check").hidden&&document.querySelector("#update-progress").hidden&&document.querySelector("#update-notes").textContent.includes("DEV")'),true,'DEV manual download controls');
        await js('Array.from(document.querySelectorAll("[data-page=about] details")).forEach(e=>e.open=true);window.scrollTo(0,0);true;');await capture(['about-dev',language==='en'?'en':'zh',variant,'top'].join('-'),'about');
        await js('window.scrollTo(0,document.documentElement.scrollHeight);true;');await capture(['about-dev',language==='en'?'en':'zh',variant,'end'].join('-'),'about');
        journeys.push({name:'real main DEV metadata manual-download About branch',language,variant,verified:true,packageMetadataAdapter:true,liveUpdateNetwork:false});
      }
    }
    assert.equal((await js('window.mote.status()')).running,false,'No real collection');return finish();
  }
  if(process.env.MOTE_UI_ROLLOUT_MASK_PROBE==='1') {
    await navigate('privacy');await ready('privacy');await js('document.querySelector("[data-mask=notification]").click();document.querySelector("#mask-preview").scrollIntoView({block:"center",behavior:"instant"});true;');await frames();
    const probe=await js('(()=>{const g=document.querySelector("#mask-preview-regions"),r=g.querySelector("rect"),b=r?.getBoundingClientRect();return {groupNamespace:g.namespaceURI,groupOwnerSvg:g.ownerSVGElement?.id??null,rectOwnerSvg:r?.ownerSVGElement?.id??null,rectBounds:b?{width:b.width,height:b.height}:null,rectFill:r?getComputedStyle(r).fill:null,logicalMask:JSON.parse(document.querySelector("#masks").value)};})()');
    writeFileSync(join(outputDirectory,'mask-probe.json'),JSON.stringify(probe,null,2));await capture('privacy-mask-probe','privacy');
    assert.equal(probe.groupNamespace,'http://www.w3.org/2000/svg','Mask group stays in SVG namespace');assert.equal(probe.rectOwnerSvg,'mask-preview','Configured mask paints inside actual SVG');assert(probe.rectBounds.width>1&&probe.rectBounds.height>1,'Configured mask has actual visible bounds');return finish();
  }
  if(process.env.MOTE_UI_ROLLOUT_ROLES==='1') {
    // Explicit handler roles, not semantic label inference. These generated
    // platform adapters prevent enumerating or reading real agents/calendars.
    const calls=[];
    for(const [channel,response] of [
      ['mote:coding-agents',[{provider:'codex',name:'Generated Codex',path:'/generated/codex',available:true}]],
      ['mote:calendar-authorize',[{id:'generated-calendar',title:'Generated calendar'}]],
      ['mote:source-coding',undefined],['mote:source-calendar',undefined]
    ]) { ipcMain.removeHandler(channel);ipcMain.handle(channel,(_event,...args)=>{calls.push({channel,args});return response;}); }
    const reference=JSON.parse(readFileSync(join(repo,'.mote/ui-rollout/mac/canonical-final/rollout-manifest.json'),'utf8'));
    const files=spawnSync('git',['ls-files','apps/desktop/src','apps/desktop/native','packages/shared/src','packages/shared/design-tokens.json'],{cwd:repo,encoding:'utf8'}).stdout.trim().split('\n');
    const current=Object.fromEntries(files.map(f=>[f,digest(join(repo,f))]));
    const referenceSources=Object.fromEntries(files.map(f=>{const blob=spawnSync('git',['show',reference.parentCommit+':'+f],{cwd:repo});assert.equal(blob.status,0);return[f,createHash('sha256').update(blob.stdout).digest('hex')];}));
    const changedSources=files.filter(f=>current[f]!==referenceSources[f]);
    const changedBuild=Object.keys(buildIdentity).filter(f=>buildIdentity[f]!==reference.buildIdentity[f]);
    assert.deepEqual(changedSources,['apps/desktop/src/index.html','apps/desktop/src/sync-history-ui.ts','apps/desktop/src/ui.ts'],'Reviewed markup/receipt role, mask caption and formatter deltas only');
    assert.deepEqual(changedBuild,['ui-bundle.js','index.html'],'Reviewed renderer deltas only');
    assert.deepEqual(nativeIdentity,reference.nativeIdentity,'Native inputs unchanged');
    fixtureMetadata.roleOnly=true;
    fixtureMetadata.unchangedReferenceProducer=reference.parentCommit;
    fixtureMetadata.sourceEquivalence={current,reference:referenceSources,changedSources,changedBuild,referenceBuild:reference.buildIdentity};
    for(const language of ['zh-CN','en']) {
      window.webContents.setZoomFactor(1);await changeLanguage(language);
      for(const [variant,width,height,zoom] of [['normal',1140,840,1],['compact',820,620,1],['large',820,620,1.3]]) {
        window.setSize(width,height);window.webContents.setZoomFactor(zoom);
        const condition=(language==='en'?'en':'zh')+'-'+variant;
        await js('localStorage.removeItem("mote-desktop-collection-reviewed");true;');
        const reload=new Promise(r=>window.webContents.once('did-finish-load',r));window.webContents.reload();await reload;await navigate('screen');await ready('screen');
        assert.equal(await js('!document.querySelector("#setup-prompt").hidden&&document.querySelector("#setup-primary").classList.contains("secondary")'),true,'First-use scope chooser uses secondary role');
        await js('window.scrollTo(0,0);true;');await capture('setup-role-'+condition+'-top','screen');
        await js('window.scrollTo(0,document.documentElement.scrollHeight);true;');await capture('setup-role-'+condition+'-end','screen');
        await js('document.querySelector("#setup-primary").click();true;');await ready('privacy');
        await js('document.querySelector("#workspace-back").click();true;');await ready('screen');
        assert.equal(await js('!document.querySelector("#collection-workbench").hidden'),true,'Chooser returns to original screen task');
        await navigate('ask');await ready('ask');
        assert.equal(await js('document.querySelector("#ask-disconnected [data-nav=connection]").classList.contains("secondary")'),true,'Offline Ask settings navigation is secondary');
        await js('window.scrollTo(0,0);true;');await capture('ask-role-'+condition+'-top','ask');
        await js('window.scrollTo(0,document.documentElement.scrollHeight);true;');await capture('ask-role-'+condition+'-end','ask');
        await js('document.querySelector("#ask-disconnected [data-nav=connection]").click();true;');await ready('connection');
        await js('document.querySelector("#workspace-back").click();true;');await ready('ask');
        await navigate('sources');await ready('sources');
        await js('document.querySelector("#source-agent-discover").closest("details").open=true;document.querySelector("#source-agent-discover").click();true;');
        await until(()=>js('!document.querySelector("#source-agent-choice").hidden&&!document.querySelector("#source-agent-add").disabled'),'generated agent choices');
        assert.equal(await js('document.querySelector("#source-agent-add").classList.contains("primary")'),true,'Actual selected agent collection is primary');
        await js('document.querySelector("#source-agent-add").closest(".actions").scrollIntoView({block:"end",behavior:"instant"});true;');
        const agentRole=await capture('source-agent-role-'+condition,'sources');
        if(process.env.MOTE_UI_ROLLOUT_ROLE_COVERAGE==='1')await fillCoverage('source-agent-role-'+condition,'sources',[agentRole]);
        await js('document.querySelector("#source-calendar-connect").click();true;');
        await until(()=>js('!document.querySelector("#source-calendars").hidden&&!document.querySelector("#source-calendar-add").disabled'),'generated calendar choices');
        assert.equal(await js('document.querySelector("#source-calendar-add").classList.contains("primary")'),true,'Actual selected calendar sync is primary');
        await js('document.querySelector("#source-calendar-add").scrollIntoView({block:"end",behavior:"instant"});true;');
        const pickerRole=await capture('source-picker-role-'+condition,'sources');
        if(process.env.MOTE_UI_ROLLOUT_ROLE_COVERAGE==='1')await fillCoverage('source-picker-role-'+condition,'sources',[pickerRole]);
        await js('document.querySelector("#source-agent-add").click();true;');await until(()=>Promise.resolve(calls.some(c=>c.channel==='mote:source-coding'&&c.args[0]==='codex')),'actual coding IPC');
        await until(()=>js('!document.querySelector("#source-calendar-add").disabled'),'agent action done');
        await js('document.querySelector("#source-calendar-add").click();true;');await until(()=>Promise.resolve(calls.some(c=>c.channel==='mote:source-calendar'&&c.args[0]==='generated-calendar')),'actual calendar IPC');
        await until(()=>js('!document.querySelector("#source-calendar-add").disabled'),'calendar action done');
        await navigate('privacy');await ready('privacy');
        await js('document.querySelector("[data-mask=notification]").click();document.querySelector("#mask-preview").scrollIntoView({block:"center",behavior:"instant"});true;');
        assert.equal(await js('(()=>{const r=document.querySelector("#mask-preview-regions rect"),b=r?.getBoundingClientRect();return r?.ownerSVGElement?.id==="mask-preview"&&b.width>1&&b.height>1;})()'),true,'Configured privacy mask actually paints');
        await capture('privacy-mask-role-'+condition,'privacy');
        await js('document.querySelector("#mask-editor").scrollIntoView({block:"center",behavior:"instant"});true;');
        const expectedRemove=language==='en'?'Remove mask 1':'移除遮挡区域 1';
        assert.equal(await js('document.querySelector("#mask-editor button").textContent'),expectedRemove,'Visible mask caption names the enabled Remove action');
        assert.equal(await js('document.querySelector("#mask-editor button").getAttribute("aria-label")'),expectedRemove,'Visible and accessible action agree');
        const maskControls=await capture('privacy-mask-controls-role-'+condition,'privacy');
        await fillCoverage('privacy-mask-controls-role-'+condition,'privacy',[maskControls],'#mask-editor');
        await js('document.querySelector("#mask-editor button").click();true;');
        assert.equal(await js('document.querySelectorAll("#mask-preview-regions rect").length'),0,'Actual Remove removes only draft mask');
        await js('document.querySelector("#settings-reset").click();true;');
        journeys.push({name:'explicit navigation/chooser secondary and collection primary roles through real handlers',language,variant,verified:true,platformSelectionAndCommitAdapters:true,personalContentRead:false});
      }
    }
    assert.equal(calls.filter(c=>c.channel==='mote:source-coding'&&c.args[0]==='codex').length,6,'Each selected Agent action uses its real IPC');
    assert.equal(calls.filter(c=>c.channel==='mote:source-calendar'&&c.args[0]==='generated-calendar').length,6,'Each selected calendar action uses its real IPC');
    assert.equal((await js('window.mote.status()')).running,false,'No collection');return finish();
  }
  const original='Generated rollout original  双空格 🐾\n\nA note keeps its exact original, source and time.';
  await navigate('notes');await until(()=>js('!document.querySelector("#note-text").disabled'),'draft');
  await js('document.querySelector("#note-text").value='+JSON.stringify(original)+';document.querySelector("#note-text").dispatchEvent(new Event("input"));document.querySelector("#note-form").requestSubmit();true;');
  await until(()=>js('document.querySelector("#note-text").value===""'),'real note save');
  await navigate('overview');await ready('overview');
  const key=await js('Array.from(document.querySelectorAll("#home-recent .content-row")).find(e=>e.textContent.includes("Generated rollout original")).dataset.contentKey');
  await until(()=>js('window.mote.status().then(s=>!(s.operations??[]).some(j=>j.state==="running"))'),'note finished');
  const pages=['overview','records','notes','ask','settings','connection','sync','capture','privacy','permissions','activity','statistics','developer','about','sources','uploads','screen','compression'];
  // Explicit generated platform selections; these actions must never enumerate
  // personal app/session/calendar data while auditing controls.
  const sourcePickerHandlers=new Map(['mote:coding-agents','mote:calendar-authorize'].map(channel=>[channel,ipcMain._invokeHandlers.get(channel)]));
  ipcMain.removeHandler('mote:coding-agents');ipcMain.handle('mote:coding-agents',()=>[{provider:'codex',name:'Generated Codex',path:'/generated/codex',available:true}]);
  ipcMain.removeHandler('mote:calendar-authorize');ipcMain.handle('mote:calendar-authorize',()=>[{id:'generated-calendar',title:'Generated calendar'}]);
  async function reloadCleanUi(page) {
    const reload=new Promise(resolve=>window.webContents.once('did-finish-load',resolve));window.webContents.reload();await reload;await js('window.confirm=()=>true;true;');await navigate(page);await ready(page);
  }
  for(const language of ['zh-CN','en']) {
    window.webContents.setZoomFactor(1);await changeLanguage(language);
    for(const [variant,width,height,zoom] of [['normal',1140,840,1],['compact',820,620,1],['large',820,620,1.3]]) {
      window.setSize(width,height);window.webContents.setZoomFactor(zoom);await frames();
      for(const page of pages) {
        if(page==='compression')await navigate('capture');
        await navigate(page);await ready(page);
        await js('Array.from(document.querySelectorAll("[data-page]:not([hidden]) details")).forEach(e=>{if(!["home-sync-details","capture-library-tools"].includes(e.id))e.open=true;});window.scrollTo(0,0);true;');
        if(page==='developer')await js('document.querySelector("[data-page=developer] .advanced-settings").open=true;true;');
        if(page==='settings')assert.equal(await js('document.querySelector("#note-action").hidden&&document.querySelector("#settings-save-bar").hidden'),true,'Settings only configuration');
        if(page==='ask') {
          await js('document.querySelector("#ask-disconnected [data-nav=connection]").click();true;');await ready('connection');
          assert.equal(await js('document.querySelector("#workspace-location").textContent.startsWith(document.querySelector("[data-page=ask] h1").textContent.trim())'),true,'Ask origin breadcrumb');
          await js('document.querySelector("#workspace-back").click();true;');await ready('ask');
          journeys.push({name:'actual Ask configuration and original task return',language,variant,verified:true});
        }
        await capture([page,language==='en'?'en':'zh',variant,'top'].join('-'),page);
        await js('window.scrollTo(0,document.documentElement.scrollHeight);true;');await frames();
        const last=await js('(()=>{const els=Array.from(document.querySelectorAll("[data-page]:not([hidden]) button,[data-page]:not([hidden]) input,[data-page]:not([hidden]) select,[data-page]:not([hidden]) textarea")).filter(e=>e.getClientRects().length&&!e.closest("[hidden]")&&!e.closest("details:not([open])"));const e=els.at(-1);if(!e)return null;const b=e.getBoundingClientRect(),f=document.querySelector("#settings-save-bar");return {id:e.id,bottom:b.bottom,footerTop:f.hidden||getComputedStyle(f).position!=="fixed"?innerHeight:f.getBoundingClientRect().top};})()');
        if(last)assert(last.bottom<=last.footerTop+1,'Final configuration control is scrollable above footer '+page+' '+variant);
        await capture([page,language==='en'?'en':'zh',variant,'end'].join('-'),page);
        if(page==='sources') {
          await js('document.querySelector("#source-calendar-permissions").closest("details").open=true;document.querySelector("#source-calendar-permissions").closest("details").scrollIntoView({block:"start",behavior:"instant"});true;');
          await capture(['source-scope',language==='en'?'en':'zh',variant].join('-'),page);
          await js('document.querySelector("#source-retention").closest(".form-grid").scrollIntoView({block:"center",behavior:"instant"});true;');await capture(['source-policy',language==='en'?'en':'zh',variant].join('-'),page);
          await js('document.querySelector("#source-agent-discover").closest("details").open=true;document.querySelector("#source-agent-discover").click();true;');await until(()=>js('!document.querySelector("#source-agent-choice").hidden&&!document.querySelector("#source-agent-add").disabled'),'generated agent picker');
          await js('document.querySelector("#source-agent-add").closest(".actions").scrollIntoView({block:"end",behavior:"instant"});true;');await capture(['source-agent-picker',language==='en'?'en':'zh',variant].join('-'),page);
          await js('document.querySelector("#source-calendar-connect").click();true;');await until(()=>js('!document.querySelector("#source-calendars").hidden&&!document.querySelector("#source-calendar-add").disabled'),'generated calendar picker');
          await js('document.querySelector("#source-calendar-add").scrollIntoView({block:"end",behavior:"instant"});true;');await capture(['source-picker',language==='en'?'en':'zh',variant].join('-'),page);
          journeys.push({name:'actual generated Coding Agent and calendar selection controls',language,variant,verified:true,platformSelectionAdapters:true,sourceCommitted:false});await reloadCleanUi(page);
        }
        if(page==='privacy') {
          await js('document.querySelector("#add-app-rule").click();true;');await until(()=>js('document.querySelector("#installed-app-choice").options.length===1&&!document.querySelector("#use-installed-app").disabled'),'generated installed app picker');
          await js('document.querySelector("#app-picker").scrollIntoView({block:"center",behavior:"instant"});true;');await capture(['privacy-app-picker',language==='en'?'en':'zh',variant].join('-'),page);
          await js('document.querySelector("#exclude-installed-app").click();document.querySelector("#app-collection-rules").scrollIntoView({block:"center",behavior:"instant"});true;');assert.equal(await js('Array.from(document.querySelectorAll("#app-collection-rules [data-channel]")).every(input=>!input.checked)'),true,'Exact app exclusion scope');await capture(['privacy-app-rule',language==='en'?'en':'zh',variant].join('-'),page);
          await js('document.querySelector("#settings-reset").click();true;');await navigate('connection');await navigate('privacy');await ready(page);
          await js('document.querySelector("[data-mask=notification]").click();document.querySelector("#mask-preview").scrollIntoView({block:"center",behavior:"instant"});true;');
          assert.equal(await js('(()=>{const g=document.querySelector("#mask-preview-regions"),r=g.querySelector("rect"),b=r?.getBoundingClientRect();return g.namespaceURI==="http://www.w3.org/2000/svg"&&r?.ownerSVGElement?.id==="mask-preview"&&b.width>1&&b.height>1;})()'),true,'Configured mask stays in actual SVG and paints visible region');
          await capture(['privacy-mask',language==='en'?'en':'zh',variant].join('-'),page);
          assert.equal(await js('document.querySelectorAll("#mask-editor input[type=range]").length'),4,'Full generated mask controls');await js('document.querySelector("#mask-editor").scrollIntoView({block:"center",behavior:"instant"});true;');await capture(['privacy-mask-controls',language==='en'?'en':'zh',variant].join('-'),page);
          await js('document.querySelector("#settings-reset").click();true;');journeys.push({name:'generated installed-app picker, exact exclusion rule, mask diagram/sliders and Reset',language,variant,verified:true,settingsCommitted:false,personalScreenRead:false});await reloadCleanUi(page);
        }
      }
      await navigate('overview');await js('document.querySelector("#note-action").click();true;');
      assert.equal(await js('document.querySelector("#add-dialog").open&&document.querySelectorAll("#add-dialog [data-add-choice]").length===5'),true,'Shared five-action chooser');
      await capture(['add-chooser',language==='en'?'en':'zh',variant].join('-'),'overview');
      await js('document.querySelector("#add-dialog").scrollTop=document.querySelector("#add-dialog").scrollHeight;true;');await capture(['add-chooser-end',language==='en'?'en':'zh',variant].join('-'),'overview');
      await js('document.querySelector("#add-dialog [data-add-choice=file]").click();true;');await ready('sources');
      await until(()=>js('!document.querySelector("#source-confirmation").hidden&&document.querySelector("#source-selected-names").textContent.includes("synthetic-source.md")'),'generated import selected range');
      await capture(['import',language==='en'?'en':'zh',variant].join('-'),'sources');
      await js('document.querySelector("#source-selection-cancel").scrollIntoView({block:"end",behavior:"instant"});true;');await capture(['import-end',language==='en'?'en':'zh',variant].join('-'),'sources');
      assert.equal(await js('document.querySelector("#source-continuous").checked'),false,'Single file preserves one-time default');
      await js('document.querySelector("#source-selection-cancel").click();true;');assert.equal((await js('window.mote.sources()')).length,0,'Cancel does not create a source');
      journeys.push({name:'shared Add, generated import range and Cancel',language,variant,verified:true});
      await navigate('records');await ready('records');
      await js('document.querySelector('+JSON.stringify('#content-feed [data-content-key="'+key+'"]')+').click();true;');
      await until(()=>js('document.querySelector("#content-detail-dialog").open&&document.querySelector("#content-detail-status").getAttribute("aria-busy")==="false"'),'exact reader');
      window.webContents.debugger.attach('1.3');await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});window.webContents.focus();
      assert.equal(await js('getComputedStyle(document.querySelector("#content-detail-title")).outlineColor'),await js('getComputedStyle(document.querySelector(".nav-item.selected")).color'),'Reader heading uses shared blue focus role');
      assert.equal(await js('document.querySelector("#content-detail-body").textContent'),original,'Exact note original');
      await capture(['reader',language==='en'?'en':'zh',variant].join('-'),'records');
      await js('document.querySelector("#content-processing summary").click();true;');assert.equal(await js('document.querySelectorAll("#content-detail-stages li").length'),4,'Full processing help');
      await js('document.querySelector("#content-detail-metadata").closest("details").open=true;document.querySelector("#content-detail-dialog").scrollTop=document.querySelector("#content-detail-dialog").scrollHeight;true;');await capture(['reader-status',language==='en'?'en':'zh',variant].join('-'),'records');
      await js('document.querySelector("#content-detail-close").click();true;');assert.equal(await js('document.activeElement.dataset.contentKey'),key,'Same opener focus');
      await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:false});window.webContents.debugger.detach();
      journeys.push({name:'exact original, full processing help and Close focus',language,variant,verified:true});
      await navigate('connection');await js('document.querySelector("#device-name").value="Generated unsaved device";document.querySelector("#device-name").dispatchEvent(new Event("input"));true;');await frames();
      await capture(['dirty-footer',language==='en'?'en':'zh',variant].join('-'),'connection');
      await js('window.scrollTo(0,document.documentElement.scrollHeight);true;');await capture(['dirty-footer-end',language==='en'?'en':'zh',variant].join('-'),'connection');
      await js('window.confirm=()=>false;document.querySelector("#workspace-back").click();true;');assert.equal(await js('document.querySelector("#device-name").value'),'Generated unsaved device','Keep settings draft');
      await js('window.confirm=()=>true;document.querySelector("#workspace-back").click();true;');await navigate('connection');assert.equal(await js('document.querySelector("#device-name").value'),'Synthetic Mac','Discard restores saved config');
      journeys.push({name:'dirty footer, Keep and Discard',language,variant,verified:true});
    }
    window.webContents.setZoomFactor(2);window.setSize(820,620);await frames();
    window.webContents.debugger.attach('1.3');await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});window.webContents.focus();
    try {
    for(const page of ['overview','notes','connection','privacy','developer']) {
      await navigate(page);await ready(page);await js('Array.from(document.querySelectorAll("[data-page]:not([hidden]) details")).forEach(e=>e.open=true);true;');
      const target={overview:'.home-add-grid [data-add-choice=folder]',notes:'#note-text',connection:'#device-name',privacy:'#default-collection',developer:'#diagnostic-interval-preset'}[page];
      await js('document.querySelector('+JSON.stringify(target)+').scrollIntoView({block:"center"});document.querySelector('+JSON.stringify(target)+').focus();true;');await frames();
      const lane=await js('(()=>{const e=document.querySelector('+JSON.stringify(target)+'),r=e.getBoundingClientRect(),t=document.querySelector(".workspace-toolbar"),f=document.querySelector("#settings-save-bar");const top=getComputedStyle(t).position==="sticky"?t.getBoundingClientRect().bottom:0,bottom=!f.hidden&&getComputedStyle(f).position==="fixed"?f.getBoundingClientRect().top:innerHeight;return {target:'+JSON.stringify(target)+',top,bottom,fieldTop:r.top,fieldBottom:r.bottom,fieldHeight:r.height,focused:document.activeElement===e&&e.matches(":focus"),outlineColor:getComputedStyle(e).outlineColor,borderColor:getComputedStyle(e).borderColor,hiddenRendererFocusEmulated:true};})()');
      const focusRole=await js('(()=>{const e=document.querySelector('+JSON.stringify(target)+'),s=getComputedStyle(e),blue=getComputedStyle(document.querySelector(".nav-item.selected")).color;return s.borderColor===blue||(s.outlineStyle!=="none"&&s.outlineColor===blue);})()');assert(focusRole,'Actual focused field paints sharedblue role '+page);
      if(!(lane.focused&&lane.fieldTop>=lane.top+6&&lane.fieldBottom<=lane.bottom-6))writeFileSync(join(outputDirectory,'failed-reading-lane.json'),JSON.stringify({page,language,lane},null,2));
      assert(lane.focused&&lane.fieldTop>=lane.top+6&&lane.fieldBottom<=lane.bottom-6,'Full focused field and outline visible in reading lane '+page+' '+language);
      const captured=await capture([page,language==='en'?'en':'zh','zoom200'].join('-'),page);captured.readingLane=lane;
      journeys.push({name:'true200% full focused input and readable document lane',page,language,verified:true,lane});
    }
    } finally {await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:false});window.webContents.debugger.detach();}
    await navigate('notes');await ready('notes');
    const keyboardText='Generated real keyboard save '+language;
    await js('document.querySelector("#note-text").value="";document.querySelector("#note-text").dispatchEvent(new Event("input"));document.querySelector("#note-text").scrollIntoView({block:"center"});document.querySelector("#note-text").focus();true;');
    // Emulate renderer focus only for this exact hidden generated window.
    // No native app activation or physical keyboard focus is claimed.
    window.webContents.debugger.attach('1.3');
    try {
      await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
      window.webContents.focus();assert.equal(await js('document.activeElement.id'),'note-text','Actual input keyboard target');
      for(const character of keyboardText)window.webContents.sendInputEvent({type:'char',keyCode:character});
      await until(()=>js('document.querySelector("#note-text").value==='+JSON.stringify(keyboardText)),'Real character input at200%');
      window.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
      await until(()=>js('document.activeElement.id==="save-note"'),'Actual Tab reaches Save');
      await js('document.querySelector("#save-note").scrollIntoView({block:"center"});true;');await frames();
      assert.equal(await js('(()=>{const r=document.querySelector("#save-note").getBoundingClientRect();return r.top>=6&&r.bottom<=innerHeight-6;})()'),true,'Keyboard Save and outline fully visible');
      await capture(['keyboard-save',language==='en'?'en':'zh','zoom200'].join('-'),'notes');
      window.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
      window.webContents.sendInputEvent({type:'char',keyCode:'\r'});
      window.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
      await until(()=>js('document.querySelector("#note-text").value===""'),'200% keyboard Save');
    } finally { await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:false});window.webContents.debugger.detach(); }
    journeys.push({name:'true Electron 200% zoom keyboard Save',language,verified:true,zoom:2,hiddenRendererFocusEmulated:true});
  }
  for(const [channel,handler] of sourcePickerHandlers){ipcMain.removeHandler(channel);ipcMain.handle(channel,handler);}
  window.webContents.setZoomFactor(1);window.setSize(820,620);await changeLanguage('zh-CN');
  await navigate('notes');await ready('notes');
  const draft='Generated reload draft · 生成草稿';await js('document.querySelector("#note-text").value='+JSON.stringify(draft)+';document.querySelector("#note-text").dispatchEvent(new Event("input"));true;');await delay(400);
  const reload=new Promise(resolve=>window.webContents.once('did-finish-load',resolve));window.webContents.reload();await reload;await navigate('notes');await ready('notes');assert.equal(await js('document.querySelector("#note-text").value'),draft,'Actual renderer reload retains draft');
  await js('document.querySelector("#note-text").value="字".repeat(20001);document.querySelector("#note-text").dispatchEvent(new Event("input"));document.querySelector("#note-form").requestSubmit();true;');
  await until(()=>js('document.querySelector("#note-feedback").textContent.length>0'),'oversize error');await capture('note-validation-error','notes');
  assert.equal(await js('document.querySelector("#note-text").value.length'),20001,'Failed note input retained');
  await js('document.querySelector("#note-text").value="";document.querySelector("#note-text").dispatchEvent(new Event("input"));true;');
  ipcMain.removeHandler('mote:connection-preview');ipcMain.handle('mote:connection-preview',()=>{throw Error('Generated connection preview failure');});
  await navigate('connection');await js('document.querySelector("#connection-input").value="Generated invalid invitation";document.querySelector("#connection-preview").click();true;');
  await until(()=>js('document.querySelector("#feedback").textContent.includes("Generated connection preview failure")&&!document.querySelector("#settings-fields").disabled'),'preview error');await capture('connection-preview-error','connection');
  const {Collector}=require('../dist/collector'),originalStatus=Collector.prototype.status;
  Collector.prototype.status=function(){const value=originalStatus.call(this);assert.equal(value.running,false);return {...value,running:true,state:'capturing'};};
  try{window.webContents.send('mote:status',{...(await js('window.mote.status()')),running:true,state:'capturing'});await navigate('capture');await capture('generated-running-settings','capture');assert.equal(await js('document.querySelector("#save-hint").textContent.includes("自动恢复")'),true,'Running save consequence visible');}
  finally{Collector.prototype.status=originalStatus;window.webContents.send('mote:status',await js('window.mote.status()'));}
  await navigate('about');const updateStatus=await js('window.mote.updateStatus()');
  ipcMain.removeHandler('mote:update-check');ipcMain.handle('mote:update-check',()=>({...updateStatus,state:'error',message:'Generated update source unavailable',installReason:'Generated validation error; installation disabled',canInstall:false}));
  await js('document.querySelector("#update-check").click();true;');await until(()=>js('document.querySelector("#update-message").textContent.includes("Generated")'),'generated update error');
  await capture('update-error','about');assert.equal(await js('document.querySelector("#update-install").disabled'),true,'Failed update cannot install');
  await navigate('developer');await js('document.querySelector("[data-page=developer] .advanced-settings").open=true;true;');
  ipcMain.removeHandler('mote:diagnostics-sample');ipcMain.handle('mote:diagnostics-sample',()=>{throw Error('Generated diagnostic sample failure');});
  await js('document.querySelector("#diagnostics-sample").click();true;');await until(()=>js('!document.querySelector("#feedback").hidden'),'generated diagnostic error');await capture('diagnostics-error','developer');
  // Exercise the connected answer through the real history action and IPC.
  // Auth/answer data are generated adapters, and evidence opens are recorded.
  const baseStatus=await js('window.mote.status()');
  const authenticateStatus=status=>({...status,config:{...status.config,serverUrl:'http://127.0.0.1:47999',tokenConfigured:true}});
  const citationId='11111111-2222-4333-8444-555555555555',conversationId='22222222-3333-4444-8555-666666666666';
  const excerpt='Generated original  双空格 🐾\n'.repeat(24)+'Original final line stays readable.';
  const conversation={id:conversationId,title:'Generated connected answer',turns:[{question:'Generated long answer with evidence',status:'completed',result:{answer:'**Generated answer** ['+citationId+']\n\n'+Array.from({length:6},(_,i)=>'- Complete generated finding '+(i+1)+' ['+citationId+']').join('\n'),citations:[{id:citationId,appName:'Generated source',capturedAt:'2026-10-14',excerpt}]}}]};
  const previousAsk=ipcMain._invokeHandlers.get('mote:ask'),previousStatus=ipcMain._invokeHandlers.get('mote:get-status'),previousCentral=ipcMain._invokeHandlers.get('mote:central'),previousSend=window.webContents.send;
  const openedEvidence=[];
  ipcMain.removeHandler('mote:get-status');ipcMain.handle('mote:get-status',async event=>authenticateStatus(await previousStatus(event)));
  ipcMain.removeHandler('mote:ask');ipcMain.handle('mote:ask',(_event,command)=>command==='history'?{items:[{id:conversationId,title:conversation.title}]}:command==='conversation'?conversation:{items:[]});
  ipcMain.removeHandler('mote:central');ipcMain.handle('mote:central',(_event,page,id)=>{openedEvidence.push({page,id});});
  window.webContents.send=function(channel,...args){return previousSend.call(this,channel,...(channel==='mote:status'?[authenticateStatus(args[0])]:args));};
  try {
    window.webContents.send('mote:status',authenticateStatus(baseStatus));
    for(const language of ['zh-CN','en']) {
      window.webContents.setZoomFactor(1);await changeLanguage(language);
      await navigate('ask');await until(()=>js('document.querySelector("#ask-history button")&&!document.querySelector("#ask-history button").disabled'),'connected generated history');
      await js('document.querySelector("#ask-history button").click();true;');await until(()=>js('document.querySelectorAll(".ask-inline-citation").length===7&&!document.querySelector("#ask-refresh").disabled'),'connected full answer');
      for(const [variant,zoom] of [['normal',1],['compact',1],['large',1.3]]) {
        window.setSize(variant==='normal'?1140:820,variant==='normal'?840:620);window.webContents.setZoomFactor(zoom);await frames();
        await js('window.scrollTo(0,0);true;');await capture(['ask-connected',language==='en'?'en':'zh',variant].join('-'),'ask','.ask-answer');
        await js('document.querySelector(".ask-answer").scrollIntoView({block:"start",behavior:"instant"});true;');await capture(['ask-answer',language==='en'?'en':'zh',variant].join('-'),'ask','.ask-answer');
        await js('document.querySelector(".ask-evidence").scrollIntoView({block:"end",behavior:"instant"});true;');await capture(['ask-answer-end',language==='en'?'en':'zh',variant].join('-'),'ask','.ask-answer');
        const references=await js('Array.from(document.querySelectorAll(".ask-inline-citation")).map(e=>({text:e.textContent,height:e.getBoundingClientRect().height,minHeight:getComputedStyle(e).minHeight,client:e.clientWidth,scroll:e.scrollWidth,complete:e.scrollWidth<=e.clientWidth+1}))');
        if(!references.every(e=>e.height>=23.5&&e.height<=32&&e.minHeight==="24px"&&e.complete))writeFileSync(join(outputDirectory,'inline-reference-diagnostic.json'),JSON.stringify({language,variant,references},null,2));
        assert(references.every(e=>e.height>=23.5&&e.height<=32&&e.minHeight==="24px"&&e.complete),'Compact complete inline references');
        assert.equal(await js('getComputedStyle(document.querySelector(".ask-evidence button")).minHeight'),'48px','Full original action retains control role');
        await js('document.querySelector(".ask-evidence summary").click();true;');assert.equal(await js('document.querySelector(".ask-excerpt").textContent'),excerpt,'Full generated evidence excerpt');
        await js('document.querySelector(".ask-excerpt").scrollIntoView({block:"start",behavior:"instant"});true;');await capture(['ask-evidence-start',language==='en'?'en':'zh',variant].join('-'),'ask','.ask-excerpt');
        await js('document.querySelector(".ask-excerpt").scrollIntoView({block:"end"});true;');await capture(['ask-evidence',language==='en'?'en':'zh',variant].join('-'),'ask','.ask-excerpt');
        await js('document.querySelector(".ask-evidence summary").click();document.querySelector(".ask-inline-citation").scrollIntoView({block:"center"});document.querySelector(".ask-inline-citation").focus();true;');
        window.webContents.debugger.attach('1.3');
        try{await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});window.webContents.focus();window.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});window.webContents.sendInputEvent({type:'char',keyCode:'\r'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});await until(()=>openedEvidence.at(-1)?.id===citationId,'real citation IPC');await capture(['ask-reference-focus',language==='en'?'en':'zh',variant].join('-'),'ask','.ask-inline-citation');}
        finally{await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:false});window.webContents.debugger.detach();}
        assert.equal(await js('document.activeElement.classList.contains("ask-inline-citation")'),true,'Citation keyboard focus remains on source action');
        openedEvidence.length=0;await js('document.querySelector(".ask-evidence button").click();true;');await until(()=>openedEvidence.at(-1)?.id===citationId,'full original IPC');
        assert.deepEqual(openedEvidence.at(-1),{page:'ask',id:citationId});openedEvidence.length=0;
        journeys.push({name:'connected long answer, complete excerpt, citation keyboard focus and original evidence IPC',language,variant,verified:true,generatedResponse:true,browserOpenStubbed:true});
      }
    }
  } finally {
    window.webContents.send=previousSend;
    for(const [channel,handler] of [['mote:get-status',previousStatus],['mote:ask',previousAsk],['mote:central',previousCentral]]){ipcMain.removeHandler(channel);ipcMain.handle(channel,handler);}
    window.webContents.send('mote:status',await js('window.mote.status()'));
  }
  journeys.push({name:'renderer reload, failed note input, connection error and synthetic running status',verified:true,collectionStarted:false});
  assert.equal((await js('window.mote.status()')).running,false,'No real collection');
  assert.equal((await js('window.mote.sources()')).length,0,'No source import committed');
  await navigate('overview');window.setSize(1140,840);await frames();
  return finish();
};
