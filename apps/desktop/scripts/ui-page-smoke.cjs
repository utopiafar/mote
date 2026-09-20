require('../../../scripts/fixture-language.cjs');
const {app}=require('electron');
const {mkdtempSync,writeFileSync,rmSync}=require('node:fs');
const {join}=require('node:path');const {tmpdir}=require('node:os');const assert=require('node:assert/strict');
const {defaultConfig}=require('../dist/config');
const profile=mkdtempSync(join(tmpdir(),'mote-page-ui-'));
app.setPath('userData',profile);process.env.MOTE_PROFILE='legacy';delete process.env.MOTE_URL;delete process.env.MOTE_TOKEN;delete process.env.MOTE_ENV_FILE;
writeFileSync(join(profile,'config.json'),JSON.stringify({version:1,config:{...defaultConfig(),serverUrl:'',deviceName:'Generated UI page fixture'}}));
const timer=setTimeout(()=>{console.error('UI page smoke timeout');app.exit(1);},45000);
app.on('browser-window-created',(_,w)=>{
 w.webContents.setBackgroundThrottling(false);
 w.webContents.once('did-finish-load',()=>void(async()=>{
  const js=code=>w.webContents.executeJavaScript(code);
      await js("window.confirm=()=>true;true;");
  for(let i=0;i<100;i++){if(await js('!!window.mote'))break;await new Promise(r=>setTimeout(r,50));}
  await js("document.querySelector('[data-nav=privacy]').click()");
  assert.equal(await js("document.querySelector('#ui-page-mode').value"),'screen_only');
  await js("document.querySelector('#ui-page-builtins').click()");
  assert.equal(await js("JSON.parse(document.querySelector('#ui-page-rules').value).length"),5);
  const rules=await js("JSON.parse(document.querySelector('#ui-page-rules').value)");
  assert(rules.every(r=>r.complete===false));
  const before=await js('window.mote.status()');
  const saved=await js(`window.mote.configure({...${JSON.stringify(before.config)},uiPageMode:'page_only',uiPageRules:${JSON.stringify(rules)}})`);
  assert.equal(saved.config.uiPageMode,'page_only');assert.equal(saved.running,false);
  await js("document.querySelector('[data-nav=records]').click();document.querySelector('#records-source').value='ui_page';document.querySelector('#records-source').dispatchEvent(new Event('change'))");
  await new Promise(r=>setTimeout(r,200));
  assert.equal(await js("document.querySelector('#records-status').getAttribute('aria-busy')"),'false');
  assert((await js("document.querySelector('#records-status').textContent")).includes('0'));
  clearTimeout(timer);console.log('Generated UI page settings / browse smoke passed; capture stayed stopped.');app.exit(0);
 })().catch(error=>{console.error(error);clearTimeout(timer);app.exit(1);}));
});
process.on('exit',()=>rmSync(profile,{recursive:true,force:true}));
require('../dist/main');
