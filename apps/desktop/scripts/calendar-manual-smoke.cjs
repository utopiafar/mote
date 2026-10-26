require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');
const {app,ipcMain}=require('electron');
const {mkdtempSync,writeFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');const {join}=require('node:path');const assert=require('node:assert/strict');
const calendar=require('../dist/calendar-actions');const {defaultConfig}=require('../dist/config');
const profile=mkdtempSync(join(tmpdir(),'mote-calendar-click-'));app.setPath('userData',profile);
process.env.MOTE_PROFILE='default';delete process.env.MOTE_URL;delete process.env.MOTE_TOKEN;delete process.env.MOTE_ENV_FILE;
writeFileSync(join(profile,'config.json'),JSON.stringify({version:4,config:{...defaultConfig(),serverUrl:'',deviceName:'Generated manual Mac',metadataEnabled:false,syncMode:'manual'}}),{mode:0o600});
writeFileSync(join(profile,'storage-format.json'),JSON.stringify({version:4}),{mode:0o600});
const disk=new Map();let declaration,connects=0,deliveries=0,release;const hold=new Promise(r=>release=r);
const client=new calendar.CalendarActions({deviceId:'generated-mac',deviceName:'Generated'}, {read:async k=>disk.get(k),write:async(k,v)=>{disk.set(k,v);},native:async command=>{assert.ok(['calendar-permission','calendar-list'].includes(command),'fixture must never invoke a system calendar write');if(command==='calendar-permission'){connects++;await hold;}return {permission:'granted',calendars:[{id:'fixture',title:'Generated',writable:true}]};},request:async(path,body)=>{if(path==='/api/connections/self')return {credential:{scope:'collector',deviceId:'generated-mac'}};if(path==='/api/device-action-capabilities'){if(body)declaration={...body,connectionId:'generated',revision:body.expectedRevision+1};return body?declaration:{connectionId:'generated',declaration:declaration??null};}if(path==='/api/managed-calendar-deliveries'){deliveries++;return {items:[],manualReviewAllowed:false};}throw Error('Unexpected fixture route '+path);}});
calendar.nativeCalendarActions=config=>{assert.equal(config.syncMode,'manual');return client;};
let opened=0;let done=false;const timer=setTimeout(()=>{console.error('Calendar click fixture timeout');app.exit(1);},25000);
app.on('browser-window-created',(_event,window)=>{if(done)return;done=true;window.webContents.once('did-finish-load',()=>{void(async()=>{
 ipcMain.removeHandler('mote:central');ipcMain.handle('mote:central',(_event,page)=>{assert.equal(page,'actions');opened++;}); // External browser login is outside this isolated calendar trigger fixture.
 const js=code=>window.webContents.executeJavaScript(code);const until=async check=>{for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,25));}throw Error('Fixture condition timed out');};
 await until(()=>js("!!window.mote&&!!document.getElementById('calendar-actions-connect')"));
 assert.equal(await js("document.getElementById('calendar-actions-connect').textContent.trim()"),'连接并同步已授权日程');
 await js("document.getElementById('calendar-actions-connect').click();document.getElementById('calendar-actions-connect').click();");
 await until(async()=>connects===1);assert.equal(await js("document.getElementById('calendar-actions-connect').disabled"),true);assert.equal(deliveries,0);
 release();await until(async()=>deliveries===1);await until(()=>js("!document.getElementById('calendar-actions-connect').disabled"));assert.equal(connects,1);assert.equal(opened,1);
 console.log('PASS hidden Mac renderer/preload/main IPC: manual-mode click, disabled duplicate click, connect before delivery, no grant no write');clearTimeout(timer);window.destroy();app.exit(0);
 })().catch(error=>{console.error(error);app.exit(1);});});});
app.on('quit',()=>rmSync(profile,{recursive:true,force:true}));
require('../dist/main');
