require('../../../scripts/fixture-language.cjs');
const {app}=require('electron');
const {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync}=require('node:fs');
const {join,resolve}=require('node:path');const {tmpdir}=require('node:os');const assert=require('node:assert/strict');
const profile=mkdtempSync(join(tmpdir(),'mote-language-ui-'));
app.setPath('userData',profile);process.env.MOTE_PROFILE='legacy';delete process.env.MOTE_URL;delete process.env.MOTE_TOKEN;delete process.env.MOTE_ENV_FILE;
writeFileSync(join(profile,'config.json'),JSON.stringify({version:1,config:{...require('../dist/config').defaultConfig(),serverUrl:'',deviceName:'Synthetic Mac',ocrEnabled:false,metadataEnabled:false}}));
const output=resolve(__dirname,'../release/i18n-fixture');mkdirSync(output,{recursive:true});
const timeout=setTimeout(()=>app.exit(1),45000);let started=false;
app.on('browser-window-created',(_event,window)=>{
 if(started)return;started=true;
 window.webContents.once('did-finish-load',()=>void(async()=>{
 const js=s=>window.webContents.executeJavaScript(s),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(fn,label)=>{for(let i=0;i<200;i++){if(await fn())return;await pause(50)}throw Error('Timed out: '+label+' '+JSON.stringify(await js(`({lang:document.documentElement.lang,last:document.querySelector('#last-capture')?.textContent,feedback:document.querySelector('#feedback')?.textContent,select:document.querySelector('#language')?.value})`)))};
 await until(()=>js(`document.querySelector('#last-capture').textContent.includes('尚无')`),'initial Chinese');
 assert.equal((await js('window.mote.language()')).locale,'zh-CN');
 await js(`document.querySelector('[data-nav="settings"]').click(); window.confirm=()=>true; const s=document.querySelector('#language');s.value='en';s.dispatchEvent(new Event('change',{bubbles:true}));`);
 await until(()=>js(`document.documentElement.lang==='en' && document.querySelector('#last-capture').textContent==='None yet'`).catch(()=>false),'English reload');
 assert.equal(JSON.parse(readFileSync(join(profile,'language.json'),'utf8')),'en');
 for(const page of ['overview','notes','sources','settings','stats','about']){
  const available=await js(`!!document.querySelector('[data-nav="${page}"]')`);if(!available)continue;
  await js(`document.querySelector('[data-nav="${page}"]').click()`);await pause(180);
  const residual=await js(`Array.from(document.querySelectorAll('[data-page="${page}"] *')).filter(e=>!e.children.length&&e.getClientRects().length&&/\\p{Script=Han}/u.test(e.textContent)&&e.textContent.trim()!=='中文').map(e=>e.textContent)`);
  assert.deepEqual(residual,[],page+' English residuals');
  assert(await js('document.documentElement.scrollWidth<=innerWidth'),page+' overflow');
 }
 await js(`document.querySelector('[data-nav="settings"]').click()`);await pause(150);
 writeFileSync(join(output,'english.png'),(await window.webContents.capturePage()).toPNG());
 assert.equal((await js('window.mote.status()')).running,false);
 await js(`window.confirm=()=>true;const s=document.querySelector('#language');s.value='zh-CN';s.dispatchEvent(new Event('change',{bubbles:true}));`);
 await until(()=>js(`document.documentElement.lang==='zh-CN'`).catch(()=>false),'Chinese reload');
 assert.equal(JSON.parse(readFileSync(join(profile,'language.json'),'utf8')),'zh-CN');
 console.log('PASS: desktop Chinese/English switch, persisted preference, authored UI coverage, LTR and stopped capture; synthetic profile only.');
 clearTimeout(timeout);app.exit(0);
 })().catch(error=>{console.error(error);clearTimeout(timeout);app.exit(1)}));
});
require('../dist/main.js');
