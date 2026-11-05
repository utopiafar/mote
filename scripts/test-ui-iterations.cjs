require('./fixture-background.cjs');
/**
 * Actual Central renderer, isolated loopback server, generated evidence only.
 * Build first: npm run build:central
 * Run: node_modules/.bin/electron scripts/test-ui-iterations.cjs --round baseline
 * Add --review to retain the synthetic node for an independent browser evaluator.
 * This records UI journey evidence. It does not assign model/human quality scores.
 */
require('./fixture-language.cjs');
const {controlCaptionPresentation}=require('./control-caption-probe.cjs');
const { app, BrowserWindow } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const net = require('node:net');
const assert = require('node:assert/strict');
const {rolloutPresentation}=require('./rollout-presentation-probe.cjs');

const args = process.argv.slice(2);
const roundIndex = args.indexOf('--round');
const round = roundIndex >= 0 ? args[roundIndex + 1] : 'baseline';
assert.match(round || '', /^[a-z0-9][a-z0-9_-]{0,40}$/i, 'Use a simple round label');
const review = args.includes('--review') || args.includes('--review-hold');
const reviewBootstrapOnly = args.includes('--review-bootstrap-only');
assert(!reviewBootstrapOnly || review, 'A review bootstrap must retain its isolated fixture');
const artRoundIndex=args.indexOf('--art-round'),artRound=artRoundIndex>=0?Number(args[artRoundIndex+1]):undefined;
const rollout=args.includes('--rollout');
assert(!(rollout&&artRound),'Selected R5 rollout evidence is separate from historical art candidates');
if(artRound!==undefined)assert.ok(Number.isInteger(artRound)&&artRound>=1&&artRound<=5,'A sequential art round is 1 through 5');
const repo = resolve(__dirname, '..');
const captureScriptCommit=spawnSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).stdout.trim();
const captureSourceIdentity=Object.fromEntries(spawnSync('git',['ls-files','apps/web','scripts/test-ui-iterations.cjs','packages/shared/design-tokens.json','packages/shared/src/i18n-en.ts'],{cwd:repo,encoding:'utf8'}).stdout.trim().split('\n').filter(Boolean).map(file=>[file,createHash('sha256').update(readFileSync(join(repo,file))).digest('hex')]));
const captureBuildIdentity=Object.fromEntries(readdirSync(join(repo,'apps/web/dist/assets')).map(file=>[file,createHash('sha256').update(readFileSync(join(repo,'apps/web/dist/assets',file))).digest('hex')]));
const root = mkdtempSync(join(tmpdir(), 'mote-ui-eval-'));
const outputIndex = args.indexOf('--output');
const output = outputIndex >= 0 ? resolve(repo, args[outputIndex + 1]) : join(repo, '.mote', 'ui-iterations', round);
assert(output.startsWith(join(repo, '.mote') + require('node:path').sep), 'Keep generated UI evidence under the ignored .mote directory');
mkdirSync(output, { recursive: true, mode: 0o700 });
writeFileSync(join(output, 'result.json'), JSON.stringify({ round, passed: null, phase: 'running', generatedOnly: true }, null, 2), { mode: 0o600 });
app.setPath('userData', join(root, 'browser'));
app.on('window-all-closed', () => {});
let server, window, endpoint, request;
const errors = [], journeys = [], captures = [];
let savedArtOriginal;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await delay(80);
  }
  throw Error('Timed out: ' + label);
}
async function freePort() {
  return new Promise((resolvePort, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const selected = listener.address().port;
      listener.close(() => resolvePort(selected));
    });
  });
}
const js = code => window.webContents.executeJavaScript(code);
// Private generated-fixture controls, never imported by the product application.
if (review) {
  const zoom = factor => {
    if (!window || window.isDestroyed()) return;
    window.webContents.setZoomFactor(factor);
    console.log(JSON.stringify({fixtureZoomFactor:window.webContents.getZoomFactor(),fixturePid:process.pid}));
  };
  process.on('SIGUSR2', () => zoom(2));
  process.on('SIGWINCH', () => zoom(1));
}
async function holdReview() {
  console.log('REVIEW READY: ' + endpoint + ' private bootstrap ' + join(root, 'connection.json'));
  await new Promise(resolveHold => { process.once('SIGTERM', resolveHold); process.once('SIGINT', resolveHold); });
}
// Observe actual renderer requests and their JSON bodies, without reading a personal profile.
const observeFixtureRequests = `(() => {
 if(window.__moteUiFetchObserved)return true;window.__moteUiFetchObserved=true;
 window.__moteUiPendingApi=0;window.__moteUiApiSettledAt=performance.now();
 const original=window.fetch.bind(window);
 window.fetch=async(input,init)=>{
  const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;
  if(!path.startsWith('/api/'))return original(input,init);
  window.__moteUiPendingApi++;
  try {
   const slow=window.__moteUiSlow;
   if(slow&&slow.path===path){slow.hits++;await new Promise(resolve=>setTimeout(resolve,slow.delayMs));}
   const response=await original(input,init);
   if(response.headers.get('content-type')?.includes('application/json'))await response.clone().arrayBuffer();
   return response;
  } finally {window.__moteUiPendingApi--;window.__moteUiApiSettledAt=performance.now();}
 };return true;
})()`;
function rendererReadiness() {
 const visible=element=>!!element&&element.getClientRects().length>0&&getComputedStyle(element).visibility!=='hidden';
 const route=location.hash||'#/today',path=route.replace(/^#\/?/,'').split('?')[0];
 const expectedPage=({'today':'overview','preferences':'about','system/models':'settings','system/storage':'vault','system':'statistics','guide':'featureGuide','ask':'ask','library':'archive','library/notes':'notes','library/import':'imports','library/insights':'insights','activity':'activity','connections/add':'sourceCatalog','connections/devices':'devices','connections':'sources','connections/access':'connections','connections/lark':'lark','connections/recordings':'recordings','system/plugins':'extensions','system/processing':'processing','agent':'agentView','system/diagnostics':'developer','system/usage':'usage','help':'help','actions':'actions'})[path];
 const content=document.querySelector('.content[data-page]'),page=content?.dataset.page;
 const base={ready:false,route,page,expectedPage,pendingApi:window.__moteUiPendingApi??0};
 if(!expectedPage||!visible(content)||page!==expectedPage)return {...base,reason:'requested consumer is not mounted'};
 const busy=[...document.querySelectorAll('[data-page-loading],.loading,.load-more .spin,[aria-busy="true"]')].filter(visible);
 if(busy.length||base.pendingApi||performance.now()-(window.__moteUiApiSettledAt??0)<120)return {...base,reason:'consumer or requests still loading',busy:busy.map(element=>element.getAttribute('data-page-loading')||element.className||element.tagName)};
 const login=document.querySelector('.connect-modal[role="dialog"]');
 if(visible(login)){
  const input=login.querySelector('input[type=password]');
  if(!visible(input)||input.disabled)return {...base,reason:'Actual login consumer is not ready'};
  return {...base,ready:true,page:'connection',expectedPage:'connection',state:'restriction',marker:'.connect-modal input[type=password]',visibleMarker:{tag:input.tagName,text:login.querySelector('h2').textContent},busyExcluded:true};
 }
 const reader=document.querySelector('.evidence-modal');
 if(visible(reader)){
  const original=reader.querySelector('.evidence-text pre');
  if(!visible(original)||!original.textContent.trim())return {...base,reason:'Actual original text is not ready'};
  return {...base,ready:true,page:'reader',expectedPage:'reader',state:'content',marker:'.evidence-modal .evidence-text pre',visibleMarker:{tag:original.tagName,text:original.textContent.trim().slice(0,180)},busyExcluded:true};
 }
 const query=new URLSearchParams(route.split('?')[1]||''),collection=query.get('view')||'materials';
 const markers={overview:'.home-page',about:'.settings-destinations',settings:'.server-settings',vault:'#content-storage-title',statistics:'.storage-chart',featureGuide:'.feature-guide [data-guide-group]',notes:'#note-text',imports:content.querySelector('.import-detail')?'.imports-page .import-detail':'.imports-page .import-form',ask:'.conversation-layout .ask-form',insights:'.insights-page .insight-compose',activity:'.activity-centre .activity-list',sourceCatalog:'.discovery-source-catalog',devices:'.device-overview',sources:'.sources-page',connections:'.connections',lark:'.lark-settings',recordings:'.lark-settings',extensions:'.plugin-center',processing:'.processing-centre .operation-list',agentView:'.agent-inspector',developer:'.diagnostics-panel',usage:'.usage-metrics',help:'.feedback-panel',actions:'.action-grid',archive:content.querySelector('.library-browser.has-selection')?'.material-detail,.library-capture-detail':collection==='memories'?'.memories-page':'.archive-page .library-workspace'};
 const marker=content.dataset.session==='verification-failed'?'.notice.error':content.dataset.session==='signed-out'?(content.classList.contains('settings-surface')?'.settings-sign-in':'.simple-welcome'):markers[page];
 const element=content.querySelector(marker);
 if(!visible(element))return {...base,reason:'expected loaded, empty or restricted consumer marker is missing',marker};
 const error=[...content.querySelectorAll('[role="alert"]')].some(visible),restriction=content.dataset.session==='signed-out'||error||[...content.querySelectorAll('.model-notice,.review-notes')].some(visible);
 const empty=[...content.querySelectorAll('.empty,.home-empty,.workspace-empty')].some(visible);
 return {...base,ready:true,state:restriction?'restriction':empty?'empty':'content',marker,visibleMarker:{tag:element.tagName,text:element.textContent.trim().slice(0,180)},busyExcluded:true};
}
async function readyConsumer(label) {
 let readiness;
 await until(async()=>{readiness=await js('('+rendererReadiness.toString()+')()');return readiness.ready;},'actual consumer '+label);
 return readiness;
}
const confirmFixtureScript = `(() => {
  let history=[];try {history=JSON.parse(sessionStorage.getItem('mote.fixtureConfirmHistory')||'[]');}catch{}
  window.__moteUiConfirmHistory=history;window.__moteUiConfirmDecision=false;
  window.confirm=message=>{
    const decision=window.__moteUiConfirmDecision===true;
    history.push({message:String(message),decision,simulated:true});
    sessionStorage.setItem('mote.fixtureConfirmHistory',JSON.stringify(history));
    return decision;
  };return true;
})()`;
async function chooseLanguage(next, accept, selector) {
  const before = await js("({locale:document.documentElement.lang,preference:localStorage.getItem('mote.language'),hash:location.hash,confirmations:JSON.parse(sessionStorage.getItem('mote.fixtureConfirmHistory')||'[]').length})");
  await js(confirmFixtureScript);
  await js(`(() => {
    const select=[...document.querySelectorAll('.language-selector select')].find(item=>item.getClientRects().length);
    if(!select)throw Error('Visible language selector is missing');
    window.__moteUiConfirmDecision=${accept};select.value=${JSON.stringify(next)};
    select.dispatchEvent(new Event('change',{bubbles:true}));return true;
  })()`);
  if (accept) await until(() => js(`document.documentElement.lang===${JSON.stringify(next)}&&!!document.querySelector(${JSON.stringify(selector)})`), 'actual language chooser reload');
  else {
    await delay(60);
    assert.equal(await js('document.documentElement.lang'), before.locale, 'Cancelling retains the rendered locale');
    assert.equal(await js("localStorage.getItem('mote.language')"), before.preference, 'Cancelling retains the saved locale');
    assert.equal(await js('location.hash'), before.hash, 'Cancelling retains the current route');
  }
  const history = await js("JSON.parse(sessionStorage.getItem('mote.fixtureConfirmHistory')||'[]')");
  assert.equal(history.length, before.confirmations + 1, 'The actual change handler requests confirmation');
  assert.equal(history.at(-1).decision, accept);
  assert.ok(history.at(-1).message.length > 0);
  journeys.push({ name: 'language ' + next + (accept ? ' accept' : ' cancel'),
    action: 'actual React language selector; fixture-only confirmation decision and prompt recorded',
    route: await js('location.hash'), status: accept ? 'reloaded-language' : 'locale-and-route-preserved' });
}
async function route(path, selector = '.content h1, .content h2') {
  await js(`location.hash=${JSON.stringify('#/' + path)};window.scrollTo(0,0);true`);
  await until(() => js(`location.hash===${JSON.stringify('#/'+path)} && !!document.querySelector(${JSON.stringify(selector)})`), 'route ' + path);
  await readyConsumer(path);
}
async function click(selector, expectedRoute, name) {
  await until(() => js(`(() => {
    const item = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
    if (!item || item.disabled || item.getAttribute('aria-disabled') === 'true') return false;
    item.scrollIntoView({block:'center'}); item.click(); return true;
  })()`), 'click ' + name);
  await until(() => js(`location.hash.startsWith(${JSON.stringify('#/' + expectedRoute)})`), 'destination ' + name);
  await readyConsumer(name);
  journeys.push({ name, action: 'clicked actual product control', route: await js('location.hash'), status: 'route-reached' });
}
async function clickLabel(labels, expectedRoute, name) {
  await until(() => js(`(() => {
    const labels=${JSON.stringify(labels)};
    const item=[...document.querySelectorAll('button,a[href]')].find(e => e.getClientRects().length && getComputedStyle(e).visibility!=='hidden' && labels.some(label => e.textContent.trim()===label || e.querySelector('strong')?.textContent.trim()===label));
    if(!item || item.disabled || item.getAttribute('aria-disabled')==='true') return false;
    item.scrollIntoView({block:'center'}); item.click(); return true;
  })()`), 'control ' + name);
  await until(() => js(`location.hash.startsWith(${JSON.stringify('#/' + expectedRoute)})`), 'destination ' + name);
  await readyConsumer(name);
  journeys.push({ name, action: 'clicked actual product control', route: await js('location.hash'), status: 'route-reached' });
}
async function capture(name, context = {}) {
  const readiness = await readyConsumer(name);
  if(rollout){const presentation=await js('('+rolloutPresentation.toString()+')()');assert.ok(presentation.checks.every(check=>check.pass),'Actual rollout presentation: '+name+' '+JSON.stringify(presentation.checks.filter(check=>!check.pass)));journeys.push({name:'presentation '+name,action:'actual renderer named-role/full-selection/focus/panel-lane guards',checks:presentation.checks,status:'guard-passed',visualAcceptance:false});}
  await js((context.preserveScroll ? '' : 'window.scrollTo(0,0); ')+'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const state = await js(`(() => {
    const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
    const controls=[...document.querySelectorAll('button,a[href],input,textarea,select,summary')].filter(visible);
    const firstScreenText=[];
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    while(walker.nextNode()) {
      const node=walker.currentNode, parent=node.parentElement, text=node.textContent.trim();
      if(!text||!parent||!visible(parent)||parent.closest('script,style')) continue;
      const range=document.createRange();range.selectNodeContents(node);
      const box=range.getBoundingClientRect();
      if(box.bottom>0&&box.top<innerHeight&&box.right>0&&box.left<innerWidth) firstScreenText.push(text);
    }
    return {hash:location.hash,locale:document.documentElement.lang,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},
      overflow:document.documentElement.scrollWidth>innerWidth,
      headings:[...document.querySelectorAll('h1,h2,h3')].filter(visible).map(e=>({level:e.tagName,text:e.textContent.trim()})),
      firstScreenText,pageTextSummary:document.body.innerText.split('\\n').filter(Boolean).slice(0,65),
      controls:controls.map(e=>{const box=e.getBoundingClientRect();return {tag:e.tagName,text:(e.getAttribute('aria-label')||e.textContent||e.getAttribute('placeholder')||'').trim().slice(0,180),href:e.getAttribute('href'),disabled:e.disabled||e.getAttribute('aria-disabled')==='true',aboveFold:box.top>=0&&box.bottom<=innerHeight,box:{x:box.x,y:box.y,width:box.width,height:box.height}};})};
  })()`);
  state.viewport.browserZoom = window.webContents.getZoomFactor();
  const finalReadiness=await js('('+rendererReadiness.toString()+')()');assert.equal(finalReadiness.ready,true,'Capture remains ready: '+name);
  const png=(await window.webContents.capturePage()).toPNG();writeFileSync(join(output, name + '.png'),png);
  state.readiness=finalReadiness;
  writeFileSync(join(output, name + '.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
  const pageScenes={overview:'home',about:'settings',settings:'models',vault:'storage',statistics:'storage',featureGuide:'guide',notes:'note',imports:'import',ask:'ask',insights:'insights',activity:'activity',sourceCatalog:'sources',archive:new URLSearchParams(state.hash.split('?')[1]||'').get('view')==='memories'?'memory':'content'};
  const variant=context.variant??({1440:'normal',820:'tablet',390:'compact',320:'minimum'})[state.viewport.width]??'normal';
  captures.push({ name, hash: state.hash, locale: state.locale, language:state.locale==='en'?'en':'zh', scene:context.scene??pageScenes[readiness.page],variant,viewport: state.viewport,bitmap:{width:png.readUInt32BE(16),height:png.readUInt32BE(20),unit:'pixels'},overflow: state.overflow, readiness:finalReadiness,sha256:createHash('sha256').update(png).digest('hex'),notes:context.notes??'',reviewSelection:context.reviewSelection===true });
  assert.equal(state.overflow, false, 'No horizontal page overflow: ' + name);
}
async function homeMatrix(state, language = 'zh') {
  for (const [width, height] of [[1440, 1000], [820, 620], [390, 844], [320, 740]]) {
    window.setSize(width, height);
    await until(() => js(`innerWidth === ${width}`), 'viewport ' + width);
    await delay(120);
    if (state === 'populated-home') {
      const visibleRecent = await js(`(() => {
        const rows=[...document.querySelectorAll('.home-record-list .capture-card')];
        return {total:rows.length,visible:rows.filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden').length};
      })()`);
      assert.deepEqual(visibleRecent, { total: 4, visible: 4 }, 'All four recent records remain visible at ' + width);
    }
    await capture(state + '-' + language + '-' + width,{scene:state==='signed-out'?'signedout':state==='empty-home'?'empty':'home',reviewSelection:true});
  }
  window.setSize(1440, 1000);
  await until(() => js('innerWidth === 1440'), 'desktop viewport');
}
async function assertSettingsTask(label) {
  assert.equal(await js(`!!document.querySelector('.topbar .quick-note,.content .library-home,.content .discovery-intake-card,.content .guide-start,.content .welcome-archive-flow')`),false,'Settings excludes creation/home content: '+label);
  assert.equal(await js(`!!document.querySelector('.content.settings-surface')`),true,'Settings retains its own navigation context: '+label);
}
async function settingsJourneys() {
  await route('preferences','.settings-destinations');await assertSettingsTask('settings hub');
  await clickLabel(['全部功能'],'guide','settings to complete directory');
  assert.equal(await js(`!!document.querySelector('.guide-start,.topbar .quick-note')`),false,'The directory lists capabilities without a new-record start panel');
  assert.equal(await js(`document.querySelector('.sidebar nav button:first-child').getAttribute('aria-current')`),'page','Directory belongs to Home');
  await js('history.back();true');await readyConsumer('real browser back to settings');
  assert.equal(await js(`document.querySelector('.content').dataset.page`),'about','Browser Back returns to the actual settings origin');
  await clickLabel(['模型与服务'],'system/models','pure model settings');await assertSettingsTask('models');
  assert.equal(await js(`!!document.querySelector('.discovery-model-start a[href="#/ask"]')`),false,'Direct settings do not invent an Ask task');
  assert.equal(await js(`document.querySelector('.model-setup-help').open`),false,'Supplementary setup help starts collapsed');
  assert.equal(await js(`Array.from(document.querySelectorAll('.discovery-model-start nav a')).every(e=>e.getClientRects().length>0)`),true,'Actual setup steps stay directly visible outside supplementary help');
  await js(`document.querySelector('.model-setup-help summary').click();true`);
  assert.equal(await js(`document.querySelector('.model-setup-help').open&&Array.from(document.querySelectorAll('.model-setup-help p,.model-setup-help small')).every(e=>e.getClientRects().length>0)`),true,'The full setup explanation remains available through its real summary');
  await js(`document.querySelector('.model-setup-help summary').click();true`);
  const askOrigin='#/ask';
  await route(askOrigin.slice(2),'.conversation-layout');
  await click('.model-notice button','system/models','actual Ask restriction to model providers');
  assert.equal(await js(`new URLSearchParams(location.hash.split('?')[1]).get('category')`),'providers','The actual Ask control starts at the connection step');
  assert.equal(await js(`new URLSearchParams(location.hash.split('?')[1]).get('returnTo')`),askOrigin,'The actual Ask control preserves its exact origin');
  await assertSettingsTask('Ask model providers');
  await capture('actual-ask-model-setup-origin',{scene:'providers',notes:'Actual Ask missing-model CTA, preserving its real origin. Journey evidence only; the final matrix remains the selected visual comparison.'});
  await click('.discovery-model-start a:nth-of-type(2)','system/models','actual Ask setup to module assignment');
  assert.equal(await js(`new URLSearchParams(location.hash.split('?')[1]).get('category')`),'model','The second setup step is the module assignment');
  assert.equal(await js(`new URLSearchParams(location.hash.split('?')[1]).get('returnTo')`),askOrigin,'The module step retains the exact Ask origin');
  await click('.discovery-model-start a:nth-of-type(3)','ask','return to actual Ask task');
  assert.equal(await js('location.hash'),askOrigin,'The actual task return preserves the Ask origin');
  await route('library/insights','.insight-compose');
  await click('.review-notes button','system/models','actual Insights restriction to model providers');
  assert.equal(await js(`new URLSearchParams(location.hash.split('?')[1]).get('returnTo')`),'#/library/insights','Insights preserves its real origin');
  await click('.discovery-model-start a:nth-of-type(3)','library/insights','return to actual Insights task');
  // Generated file passes the real browser upload and import queue lifecycle, then waits for model configuration.
  await route('library/import','.import-form');
  const importName='generated-model-setup-origin.txt',instruction='Generated ownership context; use the existing model setup task return.';
  await js(`(()=>{const files=new DataTransfer();files.items.add(new File(['Generated scoped archive fixture'],${JSON.stringify(importName)},{type:'text/plain'}));const input=document.querySelector('.import-form input[type=file]');input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));const note=document.querySelector('.import-form textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(note,${JSON.stringify(instruction)});note.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(()=>js(`(()=>{const item=[...document.querySelectorAll('.import-form button')].find(item=>item.textContent.trim()==='加入导入队列');if(!item||item.disabled)return false;item.click();return true;})()`),'actual import admission');
  let importJob;
  await until(async()=>{importJob=(await request('/api/imports')).items.find(item=>item.instruction===instruction);return importJob?.status==='needs_configuration';},'actual import waits for model configuration');
  assert.equal(importJob.progress.imported,0,'No model output or imported semantic records are fabricated');
  await clickLabel([importName],'library/import','actual import queue detail');
  await clickLabel(['打开模型设置'],'system/models','actual Import restriction to model providers');
  assert.equal(await js(`new URLSearchParams(location.hash.split('?')[1]).get('returnTo')`),'#/library/import','Import preserves its real route origin');
  await click('.discovery-model-start a:nth-of-type(3)','library/import','return to actual Import task');
  await route('today','.home-page');await click('.topbar .quick-note','library/notes','ordinary page retains notes');
  const draft='Generated settings-focus draft; must remain through settings and return.';
  await js(`(()=>{const input=document.querySelector('#note-text');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(draft)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('.settings-nav,.mobile-settings','preferences','note draft to settings');await assertSettingsTask('saved note draft in settings');
  await route('today','.home-page');await click('.topbar .quick-note','library/notes','return to existing note draft');
  assert.equal(await js(`document.querySelector('#note-text').value`),draft,'Removing the settings shortcut preserves the existing note draft lifecycle');
  await js(`(()=>{const input=document.querySelector('#note-text');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  if(artRound||rollout){
    savedArtOriginal='Generated '+(rollout?'selected R5 rollout':('art direction candidate '+artRound))+' original · 生成资料 🐾\nA saved note retains its exact source and time.';
    await js(`(()=>{const input=document.querySelector('#note-text');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(savedArtOriginal)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await js("document.querySelector('.note-composer').requestSubmit();true");
    await until(()=>js(`document.querySelector('#note-text').value===''&&[...document.querySelectorAll('.note-card p')].some(item=>item.textContent===${JSON.stringify(savedArtOriginal)})`),'actual art candidate note save');
    journeys.push({name:'actual candidate note save',verified:true,original:savedArtOriginal});
  }
  // A failed real consumer fetch is a known limitation, never a home/creation fallback.
  await route('today','.home-page');
  await js(`window.__moteUiFailStorage=true;const previous=window.fetch.bind(window);window.fetch=async(input,init)=>{const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;if(path==='/api/content-storage'&&window.__moteUiFailStorage)return new Response(JSON.stringify({error:'generated_storage_failure'}),{status:503,headers:{'Content-Type':'application/json'}});return previous(input,init);};true`);
  await route('system/storage','#content-storage-title');await assertSettingsTask('storage failure');
  await until(()=>js(`!!document.querySelector('.content [role="alert"]')`),'explicit storage request failure');
  await capture('storage-known-failure',{scene:'storage-failure',reviewSelection:true,notes:'Controlled generated 503 from the storage consumer; its alert is an actual known failure, with no home/creation fallback.'});
  await js('window.__moteUiFailStorage=false;true');await route('today','.home-page');
  journeys.push({name:'settings responsibility, task return and draft lifecycle',status:'verified',checks:['no record shortcut/home block in settings','full directory is Home with browser origin preserved','no invented default Ask return','actual Ask restriction to providers/module preserves exact origin','actual Insights and Import setup controls preserve their real route origins','note draft survives settings and return','storage failure remains explicit']});
}
async function consumerMatrix() {
  for(const language of ['zh-CN','en']){
    window.setSize(1440,1000);await route('today','.home-page');await chooseLanguage(language,true,'.home-page');
    for(const [path,scene,selector] of [
      ['preferences','settings','.settings-destinations'],['system/models','models','.server-settings .preference-menu'],
      ['system/models?category=providers','providers','.provider-workspace'],['system/models?category=model','modules','.module-assignments'],
      ['system/models?category=connectors','privacy','.server-settings .config-draft-footer'],
      ['system/storage','storage','#content-storage-title'],['guide','guide','.feature-guide'],
      ['library/notes','note','#note-text'],['library/import','import','.import-form'],['ask','ask','.ask-form'],
      ['library?view=memories','memory','.memories-page'],['library/insights','insights','.insights-page'],['activity','activity','.activity-centre'],
      ['library','content','.archive-page .library-workspace'],
      ...(rollout?[
        ['system/models?category=images','image-settings','.perception-settings'],['system/models?category=file-processing','file-settings','.file-processing-settings'],
        ['system/models?category=storage','retention-settings','.config-draft-footer'],['system/models?category=embedding','index-settings','.config-draft-footer'],
        ['connections/devices','devices','.device-overview'],['connections/add','source-catalog','.discovery-source-catalog'],
        ['connections','source-management','.sources-page'],['connections/access','authorization','.connections'],
        ['connections/lark','lark','.lark-settings'],['connections/recordings','recorders','.lark-settings'],
        ['system/plugins','plugins','.plugin-center'],['system/processing','operations','.operation-list'],
        ['system','statistics','.storage-chart'],['system/diagnostics','diagnostics','.diagnostics-panel'],['system/usage','usage','.usage-metrics'],
        ['agent','agent-view','.agent-inspector'],
        ...['records','segments','sources','files','activity','media','work-activity'].map(view=>['library?view='+view,'collection-'+view,'.library-workspace'])
      ]:[])
    ]){
      await route(path,selector);
      if(['settings','models','providers','modules','privacy','storage'].includes(scene))await assertSettingsTask(scene);
      for(const [width,height,variant] of [[1440,1000,'normal'],[820,900,'tablet'],[390,844,'compact'],[320,740,'minimum']]){
        window.setSize(width,height);await until(()=>js(`innerWidth===${width}`),'consumer viewport '+width);
        if((artRound>=5||rollout)&&scene==='note'){
          const catalog=JSON.parse(readFileSync(join(repo,'apps/android/app/src/main/assets/i18n-en.json'),'utf8'));
          const boundaryKey='已有文件 · 不现场录音 · 附件先归档 · 每个附件最多 50 MiB。';
          const helpKey='文字识别与音频转写按中央处理设置进行；可在资料库核对各阶段状态。';
          const boundary=language==='en'?catalog[boundaryKey]:boundaryKey,help=language==='en'?catalog[helpKey]:helpKey;
          assert.equal(await js("document.querySelector('.note-attachment-boundary').textContent"),boundary,'Attachment consequences remain directly visible');
          assert.equal(await js("document.querySelector('.note-attachment-help').open"),false,'Processing teaching starts in a named disclosure');
          await js("document.querySelector('.note-attachment-help summary').click();true");
          await until(()=>js(`(()=>{const d=document.querySelector('.note-attachment-help');return d.open&&d.querySelector('p').getClientRects().length>0&&d.querySelector('p').textContent===${JSON.stringify(help)}})()`),'complete attachment processing teaching');
          await js("document.querySelector('.note-attachment-help summary').click();true");
          journeys.push({name:'attachment consequences and complete named processing help',language,width,verified:true});
        }
        if(rollout&&path==='library'&&width<=800){
          assert.equal(await js("document.querySelector('.library-navigation').getClientRects().length"),0,'Compact library has one category control');
          assert.equal(await js("document.querySelectorAll('.library-compact-categories select').length"),1);
          assert.equal(await js("document.querySelector('.library-compact-categories select').value"),'materials');
        }
        if(rollout&&scene==='agent-view'&&width<=760){
          const presentation=await js('('+controlCaptionPresentation.toString()+')(".agent-inspector .section-tabs")');
          assert.equal(presentation.controls.length,4,'All four Agent tabs remain present');
          assert.ok(presentation.controls.every(control=>control.complete&&control.hit&&control.words.every(word=>word.lines===1)),'Agent captions retain whole words and reachable bounds');
          assert.deepEqual(presentation.after,presentation.before,'Caption inspection preserves labels');
          assert.ok(presentation.scrollRestored,'Caption inspection preserves document and inner scroll positions');
          journeys.push({name:'Agent compact tabs retain full natural words',language,width,presentation});
          if(language==='en'&&width===390){
            await js("[...document.querySelectorAll('.agent-inspector .section-tabs button')].find(button=>button.textContent==='Published materials').click();true");
            await until(()=>js("document.querySelectorAll('.materials-browser .source-item').length>0"),'actual Agent published material cards');
            assert.ok(await js("[...document.querySelectorAll('.materials-browser .source-item p')].every(element=>/\\d+\\s+characters\\b/.test(element.textContent))"),'Material counts retain English word boundaries');
            await js("document.querySelector('.agent-inspector .section-tabs button').click();true");
            await readyConsumer('Agent scope restored after published material count check');
            await js('window.scrollTo(0,0);true');
          }
        }
        await capture(scene+'-'+(language==='en'?'en':'zh')+'-'+width,{scene,variant,reviewSelection:true,notes:scene==='privacy'?'Existing Sources and external apps settings, including write scopes; this is not a newly invented standalone privacy page.':''});
      }
      window.setSize(1440,1000);
    }
  }
}
async function rolloutExpandedFitJourney() {
  for(const language of ['zh-CN','en']){
    window.setSize(1440,1000);await route('today','.home-page');
    if(await js('document.documentElement.lang')!==language)await chooseLanguage(language,true,'.home-page');
    await route('preferences','.settings-destinations');window.setSize(820,900);
    await until(()=>js('innerWidth===820'),'session caption tablet viewport');
    const caption=await js(`(()=>{
      const select=document.querySelector('.session-lifetime-control select');select.scrollIntoView({block:'center'});
      const style=getComputedStyle(select),canvas=document.createElement('canvas'),context=canvas.getContext('2d');context.font=style.font;
      return {label:select.selectedOptions[0].textContent,width:select.getBoundingClientRect().width,required:context.measureText(select.selectedOptions[0].textContent).width+parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)+18};
    })()`);
    assert.ok(caption.width>=caption.required,'The selected session lifetime remains fully readable: '+caption.label);
    await capture('settings-session-fit-'+language,{scene:'settings-session-fit',variant:'tablet',preserveScroll:true,reviewSelection:true});
    for(const [path,selector,scene]of [['system/models?category=model','.memory-settings','modules-expanded-fit'],['system/models?category=file-processing','.file-processing-settings','file-settings-expanded-fit']]){
      window.setSize(1440,1000);await route(path,'.server-settings');
      await js(`document.querySelectorAll('.server-settings details:not([open])').forEach(detail=>detail.querySelector('summary')?.click());true`);
      await until(()=>js(`!!document.querySelector(${JSON.stringify(selector)})`),'actual expanded '+scene);await readyConsumer(scene);
      window.setSize(320,740);await until(()=>js('innerWidth===320'),'expanded minimum viewport');
      assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector(${JSON.stringify(selector)}).scrollWidth<=document.querySelector(${JSON.stringify(selector)}).clientWidth`),true,'Expanded settings and controls fit the minimum viewport: '+scene);
      const target=scene==='modules-expanded-fit'?'.memory-settings .discovery-inline-guidance':'.file-processing-settings .policy-card';
      await js(`document.querySelector(${JSON.stringify(target)}).scrollIntoView({block:'center'});true`);
      await capture(scene+'-'+language,{scene,variant:'minimum',preserveScroll:true,reviewSelection:true});
    }
    await route('system/storage','#content-storage-title');
    for(const width of [390,320]){
      window.setSize(width,844);await until(()=>js('innerWidth==='+width),'compact export fit');
      const description=await js(`(()=>{const p=document.querySelector('.transfer-export p'),r=p.getBoundingClientRect();return {text:p.textContent,width:r.width,viewport:innerWidth,buttons:document.querySelectorAll('.transfer-export button').length}})()`);
      assert.ok(description.width>=description.viewport*.55,'Export exclusions keep a readable compact paragraph width');assert.equal(description.buttons,3,'All original export ranges remain available');
      await js("document.querySelector('.transfer-export').scrollIntoView({block:'center'});true");
      for(let index=0;index<3;index++){
        const fit=await js(`(()=>{const e=document.querySelectorAll('.transfer-export button')[${index}];e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),n=document.getElementById('primary-navigation').getBoundingClientRect();return r.top>=0&&r.bottom<n.top&&r.left>=0&&r.right<=innerWidth&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===e})()`);
        assert.ok(fit,'Each unchanged export range is reachable above compact dock');
      }
      await capture('storage-export-fit-'+language+'-'+width,{scene:'storage-export-fit',variant:'minimum',preserveScroll:true,reviewSelection:false});
      journeys.push({name:'readable compact export exclusions and all range actions',language,width,description,status:'verified'});
    }
    journeys.push({name:'expanded settings and complete session caption',language,status:'verified',checks:['selected lifetime caption at820','expanded module guidance at320','expanded file plan actions and fields at320']});
  }
  window.setSize(1440,1000);await route('today','.home-page');
}
async function rolloutAskFitJourney(){
  for(const language of ['zh-CN','en']){
    window.setSize(1440,1000);await route('today','.home-page');if(await js('document.documentElement.lang')!==language)await chooseLanguage(language,true,'.home-page');await route('ask','.ask-form');
    for(const width of [390,320]){
      window.setSize(width,844);await until(()=>js('innerWidth==='+width),'compact Ask fit');
      const caption=await js(`(()=>{const select=document.querySelector('.model-selector select'),summary=document.querySelector('.model-selector-selection');return {native:select.selectedOptions[0].textContent,visible:summary.textContent,shown:!!summary.getClientRects().length,fit:summary.scrollWidth<=summary.clientWidth}})()`);
      assert.equal(caption.visible,caption.native,'Compact caption retains the complete actual model option');assert.ok(caption.shown&&caption.fit,'Complete selected model caption wraps in compact layout');
      const observations=[];
      for(const[control,selector]of[['model caption','.model-selector-selection'],['attachment','.chat-image-button'],['send','.send-button']]){
        await js('document.querySelector('+JSON.stringify(selector)+').scrollIntoView({block:"center"});true');await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
        const bounds=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),n=document.getElementById('primary-navigation').getBoundingClientRect(),form=document.querySelector('.ask-form').getBoundingClientRect(),summary=document.querySelector('.model-selector-selection').getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,dockTop:n.top,width:innerWidth,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest(${JSON.stringify(selector)})===e,captionOverlap:form.top<summary.bottom&&form.bottom>summary.top}})()`);
        assert.ok(bounds.top>=0&&bounds.bottom<bounds.dockTop&&bounds.left>=0&&bounds.right<=bounds.width&&bounds.hit&&!bounds.captionOverlap,'Complete Ask control and model caption remain reachable without dock/composer overlap: '+language+' '+width+' '+control);observations.push({control,...bounds});
        await capture('ask-'+control.replace(' ','-')+'-fit-'+language+'-'+width,{scene:'ask-reachable-control',variant:'minimum',preserveScroll:true,reviewSelection:false});
      }
      journeys.push({name:'compact Ask complete model and dock-safe Send',language,width,caption,observations,status:'verified'});
    }
  }
  window.setSize(1440,1000);await route('today','.home-page');
}
async function authenticate(token) {
  await js("document.querySelector('.simple-welcome button').click();true");
  await until(() => js('!!document.querySelector(".connect-modal input[type=password]")'), 'real login dialog');
  assert.equal(await js("document.querySelector('.connect-modal input').type"), 'password', 'Credential field is masked');
  await capture('generated-login-dialog',{scene:'login',reviewSelection:true});
  await js(`(() => {
    const input=document.querySelector('.connect-modal input[type=password]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(token)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await until(() => js("!!document.querySelector('.connect-modal form .button.primary:not(:disabled)')"), 'login submit enabled');
  await js("document.querySelector('.connect-modal form .button.primary').click();true");
  await until(() => js('!!document.querySelector(".home-page")'), 'authenticated home');
  assert.equal(await js('!!document.querySelector(".connect-modal")'), false, 'Successful login closes dialog');
  journeys.push({ name: 'generated central login', action: 'opened real login dialog, populated masked field and submitted actual form', route: await js('location.hash'), status: 'authenticated' });
  // The evaluator uses the real login UI in its own browser. Values never go to stdout.
  if (review) writeFileSync(join(root, 'connection.json'), JSON.stringify({ generatedOnly: true, endpoint, token, output }, null, 2), { mode: 0o600 });
}
async function artReaderMatrix(){
  for(const language of ['zh-CN','en']){
    window.setSize(1440,1000);await until(()=>js('innerWidth===1440'),'language selector desktop viewport');
    await route('today','.home-page');if(await js('document.documentElement.lang')!==language)await chooseLanguage(language,true,'.home-page');
    await route('library/notes','#note-text');
    await until(()=>js(`(()=>{const item=[...document.querySelectorAll('.note-card')].find(item=>item.querySelector('p')?.textContent===${JSON.stringify(savedArtOriginal)});if(!item)return false;item.focus();if(document.activeElement!==item)return false;item.click();return true;})()`),'same saved candidate opens original');
    await readyConsumer('actual candidate reader');
    assert.equal(await js("document.querySelector('.evidence-modal .evidence-text pre').textContent"),savedArtOriginal,'Real saved original is exact');
    for(const [variant,width,height] of [['normal',1440,1000],['compact',390,844]]){
      window.setSize(width,height);await until(()=>js('innerWidth==='+width),'reader width');
      await capture('reader-'+(language==='en'?'en':'zh')+'-'+variant,{scene:'detail',variant,reviewSelection:true});
    }
    if(artRound>=4||rollout){
      assert.equal(await js("!!(document.querySelector('.evidence-text pre').compareDocumentPosition(document.querySelector('.evidence-source-actions')) & Node.DOCUMENT_POSITION_FOLLOWING)"),true,'Actual original precedes its extraction actions');
      assert.equal(await js("document.querySelector('.evidence-processing-help').open"),false,'Full processing explanation starts collapsed');
      const helpKey='OCR、索引和记忆分别处理；处理进度请在任务中心查看。';
      const fullHelp=language==='en'?JSON.parse(readFileSync(join(repo,'apps/android/app/src/main/assets/i18n-en.json'),'utf8'))[helpKey]:helpKey;
      await js("document.querySelector('.evidence-processing-help summary').scrollIntoView({block:'center'});document.querySelector('.evidence-processing-help summary').click();true");
      await until(()=>js(`(()=>{const d=document.querySelector('.evidence-processing-help'),p=d.querySelector('p');return d.open&&p.getClientRects().length>0&&p.textContent===${JSON.stringify(fullHelp)};})()`),'actual complete named processing explanation');
      await js("document.querySelector('.evidence-processing-help summary').click();true");
    }
    await js("document.querySelector('.evidence-modal .icon-button').click();true");
    await until(()=>js("!document.querySelector('.evidence-modal')"),'reader returns to actual note origin');
    await until(()=>js(`document.activeElement.closest('.note-card')?.querySelector('p')?.textContent===${JSON.stringify(savedArtOriginal)}`),'Close restores the exact original source focus');
    journeys.push({name:'actual saved note original, complete processing help and close focus',language,verified:true,processingHelpVerified:artRound>=4||rollout});
  }
  window.setSize(1440,1000);
}
async function mobileNoteFocusJourney(){
  window.setSize(1440,1000);await route('today','.home-page');
  if(await js('document.documentElement.lang')!=='en')await chooseLanguage('en',true,'.home-page');
  await route('library/notes','#note-text');window.setSize(390,844);
  await until(()=>js('innerWidth===390'),'real narrow note viewport');
  window.webContents.focus();
  await until(()=>js('document.hasFocus()'),'hidden fixture renderer receives actual keyboard focus');
  const original='Generated '+(rollout?'selected R5 rollout':('candidate '+artRound))+' keyboard focus original.';
  await js(`(()=>{const e=document.querySelector('#note-text');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(original)});e.dispatchEvent(new Event('input',{bubbles:true}));e.focus();})()`);
  const observations=[];
  for(const [label,selector] of [['attachment','.note-composer input[type=file]'],['save','.note-composer-actions .button.primary']]){
    await key('Tab');await until(()=>js(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`),'actual Tab reaches '+label);
    let bounds;
    await until(async()=>{bounds=await js(`(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),s=getComputedStyle(e),n=document.getElementById('primary-navigation').getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,dockTop:n.top,width:innerWidth,ring:parseFloat(s.outlineWidth)||0,offset:parseFloat(s.outlineOffset)||0,outlineStyle:s.outlineStyle};})()`);return bounds.bottom+bounds.ring+Math.max(0,bounds.offset)<bounds.dockTop;},'complete '+label+' focus ring above the dock');
    assert(bounds.top>=0&&bounds.left>=0&&bounds.right<=bounds.width,'Entire focused control is inside the narrow viewport');assert(bounds.ring>0&&bounds.outlineStyle!=='none','Keyboard focus is actually visible');
    observations.push({label,...bounds});
  }
  await capture('actual-keyboard-save-focus-'+(rollout?'rollout':'r'+artRound),{scene:'focus-regression',variant:'compact',reviewSelection:false,notes:'Real Tab from note text through attachment to Save; complete focused control and ring above the actual fixed dock.'});
  await key('Enter');await until(()=>js(`document.querySelector('#note-text').value===''&&Array.from(document.querySelectorAll('.note-card p')).some(e=>e.textContent===${JSON.stringify(original)})`),'real keyboard Enter saves the exact original');
  journeys.push({name:'narrow keyboard note save and unobscured focus',verified:true,original,observations});
  window.setSize(1440,1000);
}
async function key(keyCode) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  if (keyCode === 'Enter') window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  await delay(15);
}
async function verifyGuideKeyboard(sections) {
  const placement = await js(`(() => {
    const index=document.querySelector('.guide-section-nav'), model=document.querySelector('.guide-model-start');
    return !!(index&&model&&(index.compareDocumentPosition(model)&Node.DOCUMENT_POSITION_FOLLOWING));
  })()`);
  assert.equal(placement, true, 'Purpose index is before optional AI setup');
  for (let index = 0; index < sections.length; index++) {
    await js("(() => {window.scrollTo(0,0);const heading=document.querySelector('.guide-heading h1');heading.tabIndex=-1;heading.focus();return true;})()");
    let reachable = false;
    for (let step = 0; step < 120; step++) {
      if (await js(`document.activeElement===document.querySelectorAll('.guide-section-nav button')[${index}]`)) { reachable = true; break; }
      await key('Tab');
    }
    assert.equal(reachable, true, 'Function index is keyboard reachable: ' + sections[index].id);
    await key('Enter');
    const target = 'guide-heading-' + sections[index].id;
    await until(() => js(`document.activeElement?.id===${JSON.stringify(target)}`), 'function section receives focus');
    await until(() => js(`(() => {const box=document.getElementById(${JSON.stringify(target)}).getBoundingClientRect();return box.top>=0&&box.top<innerHeight;})()`), 'section heading is in viewport');
    assert.equal(await js('location.hash'), '#/guide', 'Index scroll does not change route');
    journeys.push({ name: 'function index ' + sections[index].id, action: 'native Chromium Tab and Enter; destination heading focus and viewport verified', route: '#/guide', status: 'keyboard-reached' });
  }
}
async function run() {
  if(artRound){
    const dirty=spawnSync('git',['status','--porcelain','--','apps/web','scripts/test-ui-iterations.cjs','packages/shared/design-tokens.json','scripts/generate-design-tokens.mjs'],{cwd:repo,encoding:'utf8'}).stdout;
    assert.equal(dirty,'','Capture requires the committed Web source and token build');
  }
  await app.whenReady();
  endpoint = 'http://127.0.0.1:' + await freePort();
  const token = randomBytes(32).toString('hex');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('MOTE_')) delete env[key];
  server = spawn('node', [join(repo, 'apps/server/dist/index.js')], {
    cwd: repo, env: { ...env, MOTE_PROFILE: 'test', MOTE_HOST: '127.0.0.1', MOTE_PORT: new URL(endpoint).port,
      MOTE_DATA_DIR: join(root, 'data'), MOTE_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let startupError = '';
  server.stderr.on('data', value => { startupError += value; });
  await until(async () => {
    if (server.exitCode !== null) throw Error('Generated node exited: ' + startupError.slice(-1600));
    try { return (await fetch(endpoint + '/api/health')).ok; } catch { return false; }
  }, 'isolated Central startup');
  request = async (path, body) => {
    const response = await fetch(endpoint + path, { method: body ? 'POST' : 'GET', headers: {
      Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Mote-Ingress-Version': '2',
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, 'Fixture API ' + path + ': ' + response.status);
    return response.json();
  };
  window = new BrowserWindow({ width: 1440, height: 1000, show: false, webPreferences: {
    contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  // Simulated confirmation avoids native system dialogs in this background-only fixture.
  window.webContents.on('did-finish-load', () => { void js(confirmFixtureScript).then(()=>js(observeFixtureRequests)).catch(() => {}); });
  await window.loadURL(endpoint);
  if(process.env.MOTE_TEST_SHOW_UI!=='1'){
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  }

  await until(() => js('!!document.querySelector(".simple-welcome")'), 'signed-out welcome');
  if (reviewBootstrapOnly) {
    await authenticate(token);
    window.setSize(1440,1000);
    await until(() => js('innerWidth===1440'), 'review bootstrap actual viewport');
    await route('today','.home-page');
    await readyConsumer('review bootstrap Home');
    writeFileSync(join(output,'result.json'),JSON.stringify({round,sourceCommit:captureScriptCommit,generatedOnly:true,phase:'review-ready',bootstrapOnly:true,boundary:'Fresh isolated authenticated Home for independent operations. No candidate matrix or score is asserted.'},null,2));
    await holdReview();
    return;
  }
  await homeMatrix('signed-out');
  await chooseLanguage('en', false, '.simple-welcome');
  await chooseLanguage('en', true, '.simple-welcome');
  await homeMatrix('signed-out', 'en');
  await chooseLanguage('zh-CN', true, '.simple-welcome');
  await route('preferences','.settings-sign-in');await assertSettingsTask('signed-out settings');
  await capture('settings-signedout-zh',{scene:'settings-signedout',reviewSelection:true,notes:'No session: actual settings login restriction, without the Home archive onboarding flow.'});
  await route('today','.simple-welcome');
  await authenticate(token);
  await homeMatrix('empty-home');
  await chooseLanguage('en', true, '.home-page');
  await homeMatrix('empty-home', 'en');
  await chooseLanguage('zh-CN', true, '.home-page');

  // Route entry journeys run from first use through the current user-facing controls.
  for (const [labels, path, name] of [
    [['新增数据源'], 'connections/add', 'add source'],
    [['导入资料', '导入文件'], 'library/import', 'import existing files'],
    [['写记录', '记录'], 'library/notes', 'quick note'],
    [['全部功能'], 'guide', 'all features and settings'],
  ]) {
    await route('today', '.home-page');
    const started=Date.now();
    if(name==='quick note')await js("window.__moteUiSlow={path:'/api/notes',delayMs:900,hits:0};true");
    await clickLabel(labels, path, name);
    await capture(name.replaceAll(' ', '-'),{reviewSelection:name==='add source'});
    if(name==='quick note'){
      assert.ok((await js('window.__moteUiSlow.hits'))>0,'Slow-loading scenario delays the actual notes request');
      assert.ok(Date.now()-started>=900,'Readiness excludes the loading shell until the actual delayed response arrives');
      journeys.push({name:'controlled slow notes response',route:await js('location.hash'),status:'loaded-consumer-only',elapsedMs:Date.now()-started,delayMs:900});
      await js('window.__moteUiSlow=null;true');
    }
  }
  await until(() => js('document.querySelectorAll("[data-guide-group]").length>0'), 'function catalog');
  const catalog = await js(`({groups:[...document.querySelectorAll('[data-guide-group]')].map(e=>e.dataset.guideGroup),units:[...document.querySelectorAll('[data-capability-id]')].map(e=>e.dataset.capabilityId),links:[...document.querySelectorAll('.feature-guide a[href]')].map(e=>({text:e.textContent.trim(),href:e.getAttribute('href')})),unavailable:[...document.querySelectorAll('.feature-guide [aria-disabled="true"]')].map(e=>e.textContent.trim())})`);
  const catalogSource = readFileSync(join(repo, 'apps/web/src/feature-guide-catalog.ts'), 'utf8');
  const catalogMatch = catalogSource.match(/export const guideSections:GuideSection\[\] = (\[[\s\S]*?\n\]);/);
  assert.ok(catalogMatch, 'Authored feature catalog is readable');
  const expectedCatalog = JSON.parse(catalogMatch[1]);
  assert.equal(catalog.groups.length, expectedCatalog.flatMap(section => section.groups).length, 'Every authored group is rendered');
  assert.equal(catalog.units.length, expectedCatalog.flatMap(section => section.groups.flatMap(group => group.units)).length, 'Every authored function is retained');
  writeFileSync(join(output, 'feature-coverage.json'), JSON.stringify(catalog, null, 2), { mode: 0o600 });
  await verifyGuideKeyboard(expectedCatalog);

  for (const [href, name] of [
    ['#/ask', 'ask'],
    ['#/library?view=memories', 'memory'],
    ['#/library/insights', 'insights'],
  ]) {
    await route('today', '.home-page');
    await click(`.home-page a[href="${href}"]`, href.slice(2), name);
    await capture(name);
  }
  await route('today', '.home-page');
  await clickLabel(['Mote 后台工作', '活动'], 'activity', 'background work');
  await capture('activity');
  await route('today', '.home-page');
  await click('.settings-nav,.mobile-settings', 'preferences', 'settings');
  await capture('settings');
  await clickLabel(['模型与服务'], 'system/models', 'model services');
  await capture('model-services');

  // Seed only after empty state evidence. Real ingress and publication are used.
  const seedTime = Date.now() - 60000;
  await request('/api/devices/heartbeat', { deviceId: 'generated-ui-phone', deviceName: 'Generated phone', platform: 'android', status: 'paused', queueDepth: 0,
    sync: { mode: 'manual', state: 'idle', intervalMinutes: 15, batchSize: 20, pendingRecords: 0, lastUploadAt: new Date().toISOString() } });
  await request('/api/sources', { id: 'generated-ui-coding', name: 'Generated Coding session', kind: 'coding-agent', deviceId: 'generated-ui-mac', platform: 'macos' });
  await request('/api/sources/generated-ui-coding/items/batch', { items: [0, 1].map(i => ({ externalId: 'event-' + i, revision: '1', observedAt: new Date(seedTime - 60000 + i * 10).toISOString(), kind: 'message', layer: 'original',
    text: i ? 'Generated assistant: the archive retains readable source evidence.' : 'Generated user: make a simple personal archive.',
    document: { contentRole: 'transcript', coding: { version: 1, provider: 'codex', projectKey: 'generated-project', sessionId: 'generated-session', eventId: 'event-' + i,
      role: i ? 'assistant' : 'user', attribution: i ? 'agent' : 'human', ...(i ? { channel: 'final' } : {}), part: 0, parts: 1 } } })) });
  await until(async () => (await request('/api/materials')).items.length > 0, 'generated material publication');
  for (let index = 0; index < 4; index++) {
    await request('/api/notes', { id: randomUUID(), deviceId: 'generated-ui-phone', deviceName: 'Generated phone', platform: 'android',
      capturedAt: new Date(seedTime + index * 10).toISOString(), text: `生成资料 ${index + 1}：周末在河边读书，计划整理旅行照片。Generated UI evaluation note ${index + 1}.` });
  }
  await js("location.hash='#/today';location.reload();true");
  await until(() => js('!!document.querySelector(".home-page")'), 'populated reload');
  await route('today', '.home-page');
  await until(() => js('document.querySelectorAll(".home-record-list .capture-card").length===4'), 'four generated recent rows');
  await homeMatrix('populated-home');
  await click('.sidebar nav button:nth-child(2)', 'library', 'library');
  await until(() => js('!!document.querySelector(".library-record")'), 'generated published material');
  await capture('library');
  await click('.library-record', 'library', 'read generated evidence');
  await until(() => js('!!document.querySelector(".material-detail")'), 'material body');
  await capture('material-detail',{scene:'detail',reviewSelection:!artRound&&!rollout});
  await route('today', '.home-page');
  await chooseLanguage('en', true, '.home-page');
  await homeMatrix('populated-home', 'en');
  window.webContents.setZoomFactor(2); await delay(150); await capture('populated-home-en-200-percent',{scene:'home',variant:'zoom200',reviewSelection:true,notes:'Actual 200% browser zoom; viewport dimensions are CSS pixels, bitmap dimensions are captured image pixels.'});
  window.webContents.setZoomFactor(1);
  await chooseLanguage('zh-CN', true, '.home-page');
  await js(confirmFixtureScript);
  const confirmations = await js("JSON.parse(sessionStorage.getItem('mote.fixtureConfirmHistory')||'[]')");
  writeFileSync(join(output, 'language-confirmations.json'), JSON.stringify({ generatedOnly: true, simulatedConfirmations: true, confirmations }, null, 2), {mode: 0o600});
  await settingsJourneys();
  await consumerMatrix();
  if(rollout){await rolloutExpandedFitJourney();await rolloutAskFitJourney();}
  if(artRound>=2||rollout)await mobileNoteFocusJourney();
  if(artRound||rollout)await artReaderMatrix();
  await route('today','.home-page');
  assert.deepEqual(errors, [], 'No renderer errors');
  const selectedCoordinates=new Set();
  for(const record of captures.filter(item=>item.reviewSelection)){
    const key=JSON.stringify([record.scene,record.variant,record.language]);
    assert.equal(selectedCoordinates.has(key),false,'Each selected comparison scene is unique: '+key);selectedCoordinates.add(key);
  }
  const sourceCommit=captureScriptCommit;
  const coreScenes=['home','content','note','detail','ask','settings','providers','import'];
  const coreCaptures=artRound||rollout?captures.filter(item=>coreScenes.includes(item.scene)&&['normal','compact'].includes(item.variant)&&item.reviewSelection):[];
  if(artRound||rollout){assert.equal(coreCaptures.length,32);assert.equal(new Set(coreCaptures.map(item=>[item.scene,item.language,item.variant].join(':'))).size,32);for(const item of coreCaptures){if(artRound)item.artDirectionCore=true;else item.rolloutCore=true;item.sceneKey=item.scene;item.sourceCommit=sourceCommit;}}
  assert.deepEqual(Object.fromEntries(Object.keys(captureSourceIdentity).map(file=>[file,createHash('sha256').update(readFileSync(join(repo,file))).digest('hex')])),captureSourceIdentity,'Capture source unchanged through all journeys');
  assert.deepEqual(Object.fromEntries(readdirSync(join(repo,'apps/web/dist/assets')).map(file=>[file,createHash('sha256').update(readFileSync(join(repo,'apps/web/dist/assets',file))).digest('hex')])),captureBuildIdentity,'Capture build unchanged through all journeys');
  const sourceIdentity=captureSourceIdentity,buildIdentity=captureBuildIdentity;
  writeFileSync(join(output, 'result.json'), JSON.stringify({ round, artRound, rollout, sourceCommit,sourceIdentity,buildIdentity,tokensSha256:createHash('sha256').update(readFileSync(join(repo,'packages/shared/design-tokens.json'))).digest('hex'),coreCaptures,passed: true, phase: 'completed', generatedOnly: true, captures, journeys,
    featureGroups: catalog.groups.length, featureUnits: catalog.units.length,
    validationBoundary: 'Actual renderer and generated ingress/publication. Language selector uses simulated confirmation decisions with the real change handler and reload; native modal handling is not validated. Route entry is not complete feature use. No physical capture, external account, or live model.' }, null, 2), { mode: 0o600 });
  console.log('PASS: UI journey evidence ' + round + ' → ' + output);
  if (review) {
    await holdReview();
  }
}
async function finish(code) {
  if (window && !window.isDestroyed()) window.destroy();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolveExit => server.once('exit', resolveExit)), delay(5000)]);
  }
  rmSync(root, { recursive: true, force: true });
  app.exit(code);
}
run().then(() => finish(0)).catch(async error => {
  console.error(error);
  writeFileSync(join(output, 'result.json'), JSON.stringify({ round, passed: false, phase: 'failed', generatedOnly: true, captures, journeys, message: error.message }, null, 2), { mode: 0o600 });
  if (window && !window.isDestroyed()) {
    writeFileSync(join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG());
    writeFileSync(join(output, 'failure.json'), JSON.stringify({ message: error.message, hash: await js('location.hash'), errors }, null, 2));
  }
  await finish(1);
});
