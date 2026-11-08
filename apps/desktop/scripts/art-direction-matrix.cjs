const {readFileSync,writeFileSync} = require('node:fs');
const {join,resolve} = require('node:path');
const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');
module.exports = async function({window,js,navigate,outputDirectory,round,profile}) {
  assert.match(round,/^[1-5]$/);
  const repo=resolve(__dirname,'../../..');
  const sourceCommit=spawnSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).stdout.trim();
  const dirty=spawnSync('git',['status','--porcelain','--','apps/desktop','packages/shared/design-tokens.json','scripts/generate-design-tokens.mjs'],{cwd:repo,encoding:'utf8'}).stdout;
  assert.equal(dirty,'','Capture requires the committed desktop source and token build');
  const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
  const buildIdentity=Object.fromEntries(['main.js','ui-bundle.js','index.html','styles.css','design-tokens.css'].map(file=>[file,digest(join(__dirname,'../dist',file))]));
  const captures=[],journeys=[],delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function until(read,label) {const end=Date.now()+15000;while(Date.now()<end){try{if(await read())return;}catch{}await delay(40);}throw Error('Mac scene did not become ready: '+label);}
  function ready(scene) {
    const visible=e=>!!e&&e.getClientRects().length>0&&!e.hidden;
    const page=[...document.querySelectorAll('[data-page]')].find(visible)?.dataset.page;
    const expected={home:'overview',content:'records',note:'notes',reader:'records',ask:'ask',settings:'settings',connection:'connection',import:'sources'}[scene];
    const base={ready:false,scene,page,expectedPage:expected};
    if(page!==expected||document.querySelector('#settings-fields').disabled)return {...base,reason:'Requested page is not initialized'};
    const markers={home:'#home-recent .content-row',content:'#content-feed .content-row',note:'#note-text',reader:'#content-detail-dialog[open] #content-detail-body',ask:'#ask-disconnected:not([hidden])',settings:'[data-page=settings] .settings-menu',connection:'#connection-onboarding',import:'#source-confirmation:not([hidden]) #source-selected-names'};
    const marker=markers[scene],element=document.querySelector(marker);
    if(!visible(element))return {...base,marker,reason:'Consumer marker is missing'};
    if(scene==='note'&&element.matches(':disabled'))return {...base,marker,reason:'Draft is still loading'};
    if(['home','content'].includes(scene)&&document.querySelector('#content-status').getAttribute('aria-busy')!=='false')return {...base,marker,reason:'Content is still loading'};
    if(scene==='reader'&&(!element.textContent.trim()||document.querySelector('#content-detail-status').getAttribute('aria-busy')!=='false'))return {...base,marker,reason:'Original text is not loaded'};
    if(scene==='import'&&!element.textContent.includes('synthetic-source.md'))return {...base,marker,reason:'Selected generated range is not loaded'};
    return {...base,ready:true,state:['ask','connection','import'].includes(scene)?'restriction':'content',marker,visibleMarker:{tag:element.tagName,text:element.textContent.trim().slice(0,180)},busyExcluded:true};
  }
  async function readiness(scene){let state;await until(async()=>{state=await js('('+ready.toString()+')('+JSON.stringify(scene)+')');return state.ready;},scene);return state;}
  function completeLabels(){
    return Array.from(document.querySelectorAll('[data-page]:not([hidden]) .content-row')).map(row=>{
      const bounds=row.getBoundingClientRect();
      return Array.from(row.querySelectorAll('.content-type,.content-state')).map(element=>{
        const r=element.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(element);
        const rects=Array.from(range.getClientRects()),textBounds=range.getBoundingClientRect();
        return {text:element.textContent,className:element.className,singleLine:rects.length>0&&Math.max(...rects.map(x=>x.top))-Math.min(...rects.map(x=>x.top))<1,fullyInside:element.scrollWidth<=element.clientWidth+1&&textBounds.left>=r.left-.5&&textBounds.right<=r.right+.5&&r.left>=bounds.left-.5&&r.right<=bounds.right+.5,left:r.left,right:r.right,top:r.top,bottom:r.bottom,textWidth:textBounds.width};
      });
    }).flat();
  }
  function settingsGlyphs(){
    const expected={permissions:'access',connection:'link',sync:'sync',capture:'screen',privacy:'shield',about:'info',activity:'activity',statistics:'storage',developer:'code'};
    return Object.entries(expected).map(([page,glyph])=>{
      const row=document.querySelector('[data-page=settings] .settings-row[data-nav="'+page+'"]'),use=row?.querySelector('.setting-icon use'),href=use?.getAttribute('href');
      return {page,href,valid:href==='#icon-'+glyph&&!!document.querySelector(href)};
    });
  }
  async function capture(scene,language,variant,width,height){
    window.setSize(width,height);await until(()=>js('innerWidth==='+width),'actual viewport');await readiness(scene);
    await js('window.scrollTo(0,0);new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const state=await readiness(scene);assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true,'No overflow: '+scene);
    const labelGeometry=['home','content'].includes(scene)?await js('('+completeLabels.toString()+')()'):undefined;
    if(labelGeometry)assert(labelGeometry.length>0&&labelGeometry.every(item=>item.singleLine&&item.fullyInside),'Complete source and state labels fit: '+scene+' '+language+' '+variant);
    const menuGlyphs=scene==='settings'?await js('('+settingsGlyphs.toString()+')()'):undefined;
    if(menuGlyphs)assert(menuGlyphs.every(item=>item.valid),'Explicit settings page glyphs are present');
    const png=(await window.webContents.capturePage()).toPNG(),name=[scene,language,variant].join('-');
    const viewport=await js('({width:innerWidth,height:innerHeight,devicePixelRatio})');
    const sceneKey=({note:'note-composer',ask:'ask-disconnected'})[scene]??scene;
    const item={name,file:name+'.png',scene:sceneKey,sceneKey,coreScene:scene,language,locale:await js('document.documentElement.lang'),variant,generatedOnly:true,reviewSelection:true,artDirectionCore:true,sourceCommit,viewport,bitmap:{width:png.readUInt32BE(16),height:png.readUInt32BE(20)},readiness:state,labelGeometry,menuGlyphs,sha256:createHash('sha256').update(png).digest('hex')};
    writeFileSync(join(outputDirectory,item.file),png);writeFileSync(join(outputDirectory,name+'.json'),JSON.stringify(item,null,2));captures.push(item);
  }
  async function changeLanguage(language){
    if(await js('document.documentElement.lang')===language)return;
    await navigate('settings');
    const reloaded=new Promise(resolve=>window.webContents.once('did-finish-load',resolve));
    await js('window.confirm=()=>true;document.querySelector("#language").value='+JSON.stringify(language)+';document.querySelector("#language").dispatchEvent(new Event("change"));true;');
    await Promise.race([reloaded,delay(15000).then(()=>{throw Error('Actual locale reload did not finish');})]);
    await until(()=>js('document.documentElement.lang==='+JSON.stringify(language)+'&&!!document.querySelector("#content-refresh")&&!!document.querySelector("#workspace-location").textContent.trim()'),'language reload');
    await js('window.confirm=()=>true;true;');
  }
  const original='Generated art direction candidate '+round+' original · 生成资料 🐾\nA saved note retains its exact source and time.';
  await navigate('notes');await until(()=>js('!document.querySelector("#note-text").matches(":disabled")'),'real draft load');
  const draft='Generated retained draft for candidate '+round;
  await js('document.querySelector("#note-text").value='+JSON.stringify(draft)+';document.querySelector("#note-text").dispatchEvent(new Event("input"));true;');
  await navigate('settings');assert.equal(await js('document.querySelector("#note-action").hidden'),true,'Settings has no generic Add');
  await navigate('notes');assert.equal(await js('document.querySelector("#note-text").value'),draft,'Draft survives actual settings navigation');
  await js('document.querySelector("#note-text").value='+JSON.stringify(original)+';document.querySelector("#note-text").dispatchEvent(new Event("input"));document.querySelector("#note-form").requestSubmit();true;');
  await until(()=>js('document.querySelector("#note-text").value===""'),'actual note save');
  await navigate('overview');await until(()=>js('Array.from(document.querySelectorAll("#home-recent .content-row")).some(e=>e.textContent.includes('+JSON.stringify(original.split('\n')[0])+'))'),'same saved note on Home');
  const key=await js('Array.from(document.querySelectorAll("#home-recent .content-row")).find(e=>e.textContent.includes('+JSON.stringify(original.split('\n')[0])+')).dataset.contentKey');
  await until(()=>js('window.mote.status().then(s=>!(s.operations??[]).some(job=>job.state==="running"))'),'actual note operation completed');
  await until(()=>js('document.querySelector("#background-progress").hidden'),'completed operation no longer displayed on Home');
  assert.equal(await js('document.querySelector("#background-progress").hidden'),true,'Completed work does not persist on an unrelated Home page');
  journeys.push({name:'actual save, retained draft and Home identity',verified:true,contentKey:key});
  for(const language of ['zh-CN','en']){
    await changeLanguage(language);
    for(const scene of ['home','content','note','reader','ask','settings','connection','import']){
      if(scene==='reader'){
        await navigate('records');await readiness('content');await js('document.querySelector('+JSON.stringify('#content-feed [data-content-key="'+key+'"]')+').click();true;');
        await readiness('reader');assert.equal(await js('document.querySelector("#content-detail-body").textContent'),original,'Exact original in real reader');
        assert.equal(await js('document.querySelector("#content-detail-title").textContent.includes('+JSON.stringify(original.split('\n')[0])+')'),false,'Note title does not duplicate original');
        assert.equal(await js('!document.querySelector("#content-processing").open&&document.querySelector("#content-detail-status").textContent.trim().length>0'),true,'Actual status visible, complete process help initially folded');
      }else if(scene==='import'){
        await navigate('overview');await js('document.querySelector("#note-action").click();document.querySelector("#add-dialog [data-add-choice=file]").click();true;');
      }else await navigate({home:'overview',content:'records',note:'notes',ask:'ask',settings:'settings',connection:'connection'}[scene]);
      await readiness(scene);
      for(const [variant,width,height] of [['normal',1140,840],['compact',820,620]])await capture(scene,language==='en'?'en':'zh',variant,width,height);
      if(scene==='reader'){
        await js('document.querySelector("#content-processing summary").click();true;');
        assert.equal(await js('document.querySelector("#content-processing").open&&document.querySelectorAll("#content-detail-stages li").length===4'),true,'Complete processing stages are actually expandable');
        await js('document.querySelector("#content-processing summary").click();true;');
        await js('document.querySelector("#content-detail-close").click();true;');assert.equal(await js('document.activeElement.dataset.contentKey'),key,'Close restores exact source focus');
        journeys.push({name:'actual exact source, note title, expandable processing and Close focus',language,verified:true});
      }
      if(scene==='ask'){
        await js('document.querySelector("#ask-disconnected [data-nav=connection]").click();true;');await readiness('connection');
        assert.equal(await js('document.querySelector("#workspace-location").textContent.startsWith(document.querySelector("[data-page=ask] [data-page-title]").textContent.trim()+" / ")'),true,'Visible connection breadcrumb names the actual Ask origin');
        await js('document.querySelector("#workspace-back").click();true;');await readiness('ask');
        journeys.push({name:'actual offline Ask connection and origin return',language,verified:true});
      }
      if(scene==='import')await js('document.querySelector("#source-selection-cancel").click();true;');
    }
    window.setSize(820,620);
    await navigate('overview');await js('document.querySelector("#note-action").click();true;');
    assert.equal(await js('document.querySelector("#add-dialog").open&&document.querySelectorAll("#add-dialog [data-add-choice]").length===4'),true,'Actual Add retains its four actions');
    await js('document.querySelector("#add-close").click();true;');
    for(const page of ['screen','privacy','sources','sync']){
      await navigate(page);await until(()=>js('!document.querySelector("#settings-fields").disabled'),'supplemental settings idle');
      journeys.push({name:'actual supplemental '+page,language,variant:'compact',verified:true,marker:await js('document.querySelector("[data-page='+page+'] [data-page-title]").textContent.trim()')});
    }
    await navigate('overview');await js('document.querySelector("#home-feature-guide").click();true;');
    await readiness('connection');
    journeys.push({name:'actual complete guide offline limitation',language,variant:'compact',verified:true,boundary:'The full guide belongs to Central Web; this unconnected Mac correctly enters connection settings.'});
  }
  assert.equal(captures.length,32);assert.equal(new Set(captures.map(item=>[item.scene,item.language,item.variant].join(':'))).size,32);
  const status=await js('window.mote.status()');assert.equal(status.running,false);assert.equal((await js('window.mote.sources()')).length,0,'Import confirmation never creates a source');
  const manifest={round:Number(round),platform:'mac',generatedOnly:true,passed:true,sourceCommit,tokensSha256:digest(join(repo,'packages/shared/design-tokens.json')),buildIdentity,captures,coreCaptures:captures,journeys,boundary:'Hidden actual Electron app, generated profile; dialogs and locale confirmation use fixture decisions. No real capture, account, network model or source import confirmation.',profile};
  writeFileSync(join(outputDirectory,'manifest.json'),JSON.stringify(manifest,null,2));
  return manifest;
};
