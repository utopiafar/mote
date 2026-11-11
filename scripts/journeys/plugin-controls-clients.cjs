// Explicit generated-profile acceptance for actual Mac IPC, Web and Android.
// Build desktop/Web and debug app/test APKs first; install only on a fresh task-owned
// emulator. Run with MOTE_TEST_ANDROID_SERIAL=emulator-5582 electron scripts/journeys/plugin-controls-clients.cjs.
// ANDROID_HOME chooses adb; PATH or MOTE_NODE_EXECUTABLE must provide matching Node 24+.
// Screenshots and receipts go to ignored .mote/plugin-controls-clients.
require('../../scripts/fixture-background.cjs');
require('../../scripts/fixture-language.cjs');
const {app,BrowserWindow,shell,safeStorage}=require('electron');
const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const repo=path.resolve(__dirname,'../..'),profile=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mote-plugin-cross-mac-'))),adb=process.env.ANDROID_HOME?path.join(process.env.ANDROID_HOME,'platform-tools/adb'):'adb',serial=process.env.MOTE_TEST_ANDROID_SERIAL;
assert.match(serial??'',/^emulator-[0-9]+$/,'Set MOTE_TEST_ANDROID_SERIAL to a task-owned generated emulator');
const output=path.resolve(repo,'.mote/plugin-controls-clients');fs.mkdirSync(output,{recursive:true,mode:0o700});
app.setPath('userData',profile);app.on('window-all-closed',()=>{});require('../../apps/desktop/package.json').moteDevelopment=true;process.env.MOTE_PROFILE='dev';for(const key of ['MOTE_URL','MOTE_TOKEN','MOTE_ENV_FILE'])delete process.env[key];
const delay=ms=>new Promise(r=>setTimeout(r,ms));let server,main,web,macWeb,instrument,port;let snapshotCount=0;const watchdog=setTimeout(()=>{console.error('Plugin client acceptance timed out');app.exit(1);},180000);
const until=async(read,label)=>{const end=Date.now()+40000;while(Date.now()<end){if(await read())return;await delay(60);}throw Error('Timed out '+label);};
const runAdb=(args)=>cp.execFileSync(adb,['-s',serial,...args],{encoding:'utf8',timeout:60000});
const js=(win,code)=>win.webContents.executeJavaScript(code);
const click=(win,label)=>until(()=>js(win,`(()=>{const e=[...document.querySelectorAll('button,a')].find(x=>x.getClientRects().length&&(x.textContent.trim()===${JSON.stringify(label)}||x.getAttribute('aria-label')===${JSON.stringify(label)}));if(!e||e.disabled)return false;e.click();return true;})()`),label);
const switchIs=(win,on)=>js(win,`document.querySelector('[role=switch][aria-label=Gmail]')?.getAttribute('aria-checked')===${JSON.stringify(String(on))}`);
const shot=async(win,name)=>{fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());snapshotCount++;};
(async()=>{
 await app.whenReady();server=cp.spawn(process.env.MOTE_NODE_EXECUTABLE||'node',['--import','tsx','scripts/journeys/plugin-controls-server.ts'],{cwd:repo,stdio:['ignore','pipe','pipe'],env:process.env});
 const f=await new Promise((res,rej)=>{let out='',err='';server.stdout.on('data',x=>{out+=x;for(const line of out.split('\n'))try{const v=JSON.parse(line);if(v.generatedOnly)res(v);}catch{}});server.stderr.on('data',x=>err+=x);server.on('exit',()=>rej(Error(err)));});
 port=new URL(f.url).port;runAdb(['reverse','tcp:'+port,'tcp:'+port]);
 const opts={width:1200,height:1000,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}};
 web=new BrowserWindow({...opts,webPreferences:{...opts.webPreferences,partition:'generated-cross-web'}});macWeb=new BrowserWindow({...opts,webPreferences:{...opts.webPreferences,partition:'generated-cross-mac-handoff'}});
 const opened=[];const handoff=async url=>{opened.push(url);assert.equal(new URL(url).origin,f.url);assert.ok(!url.includes(f.token));await macWeb.loadURL(url);};
 shell.openExternal=handoff;const oldExec=cp.execFile;cp.execFile=function(file,args,...rest){if(file==='/usr/bin/open'&&args?.[0]==='-a'&&args?.[1]==='Google Chrome'){const cb=rest.at(-1);handoff(args[2]).then(()=>cb(null,'',''),cb);return {pid:0};}return oldExec.call(this,file,args,...rest);};
 safeStorage.isEncryptionAvailable=()=>{throw Error('Generated Dev profile must not use OS credentials');};
 const {defaultConfig}=require('../../apps/desktop/dist/config');const d=profile+'-profiles/dev';fs.mkdirSync(d,{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(d,'config.json'),JSON.stringify({version:4,config:{...defaultConfig(),serverUrl:f.url,deviceName:'Generated plugin controls Mac',metadataEnabled:false,syncPaused:true,syncMode:'manual'},developmentToken:f.token}),{mode:0o600});fs.writeFileSync(path.join(d,'storage-format.json'),JSON.stringify({version:4}),{mode:0o600});
 const native=require('../../apps/desktop/dist/native');native.readInstalledApplications=async()=>[];native.runHelper=async()=>{throw Error('No native capture in generated plugin controls');};
 app.on('browser-window-created',(_e,w)=>{if(!main)main=w;});require('../../apps/desktop/dist/main');
 await until(()=>main&&!main.webContents.isLoading()&&js(main,'Boolean(document.querySelector("#settings-fields"))&&!document.querySelector("#settings-fields").disabled'),'actual Mac main startup');
 assert.equal(main.isVisible(),false);await js(main,"document.querySelector('[data-nav=settings]').click()");await until(()=>js(main,"document.querySelector('#settings-central-plugins')?.getClientRects().length>0"),'Mac plugin center settings row');await shot(main,'mac-settings-plugin-center');
 await js(main,"document.querySelector('#settings-central-plugins').click()");await until(()=>js(macWeb,"document.querySelectorAll('.plugin-official-catalog article').length===4"),'Mac IPC login ticket handoff to plugin center');assert.ok(opened[0].includes('#/system/plugins?loginTicket='));await click(macWeb,'已安装插件');await until(()=>switchIs(macWeb,true),'Mac installed list');
 await web.loadURL(f.url+'/#/system/plugins?tab=installed');await click(web,'登录 Mote');await js(web,`(()=>{const e=document.querySelector('.connect-modal input[type=password]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(f.token)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await click(web,'登录并继续');await until(()=>switchIs(web,true),'Web installed list');
 let out='';instrument=cp.spawn(adb,['-s',serial,'shell','am','instrument','-w','-r','-e','class','dev.mote.collector.PluginControlsJourneyInstrumentedTest','-e','pluginControlsOrigin',f.url,'-e','pluginControlsToken',f.token,'-e','pluginControlsGeneratedProfile','true','dev.mote.collector.test.test/androidx.test.runner.AndroidJUnitRunner'],{stdio:['ignore','pipe','pipe']});const record=x=>{out+=x;fs.writeFileSync(path.join(output,'android-instrumentation.txt'),out);};instrument.stdout.on('data',record);instrument.stderr.on('data',record);const finished=new Promise(resolve=>instrument.once('exit',code=>resolve(code)));
 await until(()=>switchIs(web,false),'Web observes Android stopping Gmail');await until(()=>switchIs(macWeb,false),'Mac handoff page observes Android stopping Gmail');await shot(macWeb,'mac-gmail-stopped-from-android');await shot(web,'web-gmail-stopped-from-android');
 await click(web,'Gmail');await until(()=>switchIs(macWeb,true),'Mac observes Web enabling Gmail');await click(web,'Google Calendar');await until(()=>switchIs(web,false),'Web observes recreated Android stopping Gmail again');
 const exit=await finished;fs.writeFileSync(path.join(output,'android-instrumentation.txt'),out);assert.equal(exit,0);assert.match(out,/OK \(1 test\)/);assert.doesNotMatch(out,/FAILURES|INSTRUMENTATION_FAILED/);
 const state=await fetch(f.url+'/api/plugin-builds/'+encodeURIComponent('bundled:gmail'),{headers:{Authorization:'Bearer '+f.token}}).then(r=>r.json());assert.equal(state.observed,'stopped');
 fs.mkdirSync(path.join(output,'android-screens'),{recursive:true});runAdb(['pull','/sdcard/Android/data/dev.mote.collector.test/files/plugin-controls',path.join(output,'android-screens')]);
 const result={passed:true,actualCentral:true,actualMacRendererAndIPC:true,actualBuiltWeb:true,androidEmulator:serial,generatedOnly:true,snapshots:snapshotCount,journeys:['Mac settings → plugin center → owner login ticket','Android off → idle Web and Mac converge','Web on → idle Android and Mac converge','Android recreation → persisted active → off again','core transport has no optional switch','no capture or personal profiles']};fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;}).finally(async()=>{clearTimeout(watchdog);if(instrument&&instrument.exitCode===null)instrument.kill();for(const w of BrowserWindow.getAllWindows())w.destroy();if(port)try{runAdb(['reverse','--remove','tcp:'+port]);}catch{}if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}for(const d of [profile,profile+'-profiles'])fs.rmSync(d,{recursive:true,force:true});app.exit(process.exitCode||0);});
