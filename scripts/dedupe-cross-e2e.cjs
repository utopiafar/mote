/** Dedicated Android fixture AVD -> real node -> desktop client + real web renderer.
 * Build development/androidTest APKs, shared/server/web and desktop TypeScript first.
 * Run: node_modules/.bin/electron scripts/dedupe-cross-e2e.cjs
 * Uses generated bitmaps only; never enables a capture service or a model.
 */
const {app, BrowserWindow, nativeImage} = require('electron');
const {mkdtempSync, mkdirSync, writeFileSync, rmSync} = require('node:fs');
const {tmpdir, homedir} = require('node:os');
const {join, resolve} = require('node:path');
const {randomBytes, randomUUID} = require('node:crypto');
const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const net = require('node:net');
const {defaultConfig} = require('../apps/desktop/dist/config');
const {browseCaptures, captureDetail} = require('../apps/desktop/dist/capture-browser');
const {uploadCapture} = require('../apps/desktop/dist/transport');
const root = resolve(__dirname, '..'), temp = mkdtempSync(join(tmpdir(), 'mote-dedupe-cross-'));
const output = join(root, 'apps/android/app/build/reports/dedupe-cross');
mkdirSync(output, {recursive:true});
app.setPath('userData', join(temp, 'electron'));
app.on('window-all-closed', () => {});
const adbPath = process.env.ANDROID_HOME ? join(process.env.ANDROID_HOME, 'platform-tools/adb') : join(homedir(), 'Library/Android/sdk/platform-tools/adb');
const serial = process.env.MOTE_FIXTURE_SERIAL || 'emulator-5554';
let server, window, port;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout=30000) { const end=Date.now()+timeout; while(Date.now()<end) { if(await fn()) return; await wait(100); } throw Error('Timed out: '+label); }
function command(exe, args, timeout=180000) { return new Promise((resolve,reject)=>{
  const child=spawn(exe,args,{cwd:root,stdio:['ignore','pipe','pipe']}); let stdout='',stderr='';
  const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
  child.stdout.on('data',data=>stdout+=data); child.stderr.on('data',data=>stderr+=data);
  child.on('error',reject); child.on('close',code=>{clearTimeout(timer);code===0?resolve(stdout.trim()):reject(Error(`${exe} failed (${code}): ${stderr.slice(-1000)}`));});
}); }
const adb = (...args) => command(adbPath, ['-s',serial,...args]);
(async()=>{
  await app.whenReady();
  assert.equal(await adb('shell','getprop','ro.boot.qemu.avd_name'),'mote_fixture_api35');
  assert.equal(await adb('shell','getprop','sys.boot_completed'),'1');
  for(const apk of ['development/app-development.apk','androidTest/development/app-development-androidTest.apk'])
    assert.match(await adb('install','-r',join(root,'apps/android/app/build/outputs/apk',apk)),/Success/);
  await adb('shell','input','keyevent','KEYCODE_WAKEUP');
  await adb('shell','wm','dismiss-keyguard');
  port=await new Promise(resolve=>{const listener=net.createServer();listener.listen(0,'127.0.0.1',()=>{const value=listener.address().port;listener.close(()=>resolve(value));});});
  const url=`http://127.0.0.1:${port}`,token=randomBytes(32).toString('hex'),envFile=join(temp,'fixture.env');
  writeFileSync(envFile,`MOTE_PROFILE=test\nMOTE_HOST=127.0.0.1\nMOTE_PORT=${port}\nMOTE_TOKEN=${token}\nMOTE_DATA_DIR=${join(temp,'data')}\n`,{mode:0o600});
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('MOTE_'))delete env[key];
  server=spawn('node',[join(root,'apps/server/dist/index.js')],{cwd:root,env:{...env,MOTE_ENV_FILE:envFile},stdio:['ignore','ignore','pipe']});
  let failure='';server.stderr.on('data',data=>failure+=data);
  await until(async()=>{if(server.exitCode!==null)throw Error(failure.slice(-1000));try{return(await fetch(url+'/api/health')).ok;}catch{return false;}},'central ready');
  await adb('reverse',`tcp:${port}`,`tcp:${port}`);
  console.log('Dedicated emulator and temporary central ready; running generated Android pipeline cases.');
  const log=await adb('shell','am','instrument','-w','-r','-e','class','dev.mote.collector.CaptureRecordsInstrumentedTest#deduplicationAcrossModesSynchronizesToRealCentral',
    '-e','fixtureServer',url,'-e','fixtureToken',token,'dev.mote.collector.dev.test/androidx.test.runner.AndroidJUnitRunner');
  writeFileSync(join(output,'android.log'),log.replaceAll(token,'[fixture-token]'));
  assert.match(log,/OK \(1 test\)/,log.replaceAll(token,'[fixture-token]'));
  const result=JSON.parse(await adb('exec-out','run-as','dev.mote.collector.dev','cat','files/dedupe-cross-result.json'));
  assert.equal(result.generatedOnly,true);assert.equal(result.records.length,23);
  const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  async function api(path, body) {const response=await fetch(url+path,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});assert(response.ok,`${path}: ${response.status}`);return response.json();}
  const duplicates=result.records.filter(r=>r.duplicate);assert.equal(duplicates.length,9);
  const status=await api('/api/status');assert.equal(status.storage.captures,23);assert.equal(status.storage.imageCaptures,14);
  const config={...defaultConfig(),serverUrl:url,token,deviceId:result.deviceId,nsfwEnabled:false};
  const day=new Date().toLocaleDateString('sv-SE');
  const page=await browseCaptures(null,config,{location:'central',day});assert.equal(page.totalCount,23);
  for(const record of result.records) {
    const detail=await captureDetail(null,config,'central',record.id);
    assert.equal(detail.hasImage,!record.duplicate);
    if(record.duplicate) {
      assert.equal(detail.ocrText,'');assert.equal(detail.ocr.status,'disabled');
      assert.equal((await fetch(`${url}/api/capture-browser/${record.id}/image`,{headers})).status,404);
    }
  }
  // A second device uses the production desktop upload transport against the same node.
  const desktopId=randomUUID(), jpeg=nativeImage.createFromBitmap(Buffer.alloc(32*32*4,160),{width:32,height:32}).toJPEG(75);
  await uploadCapture({...config,deviceId:'generated-desktop'}, {id:desktopId,deviceId:'generated-desktop',deviceName:'Generated desktop',platform:'macos',source:'screen',capturedAt:new Date().toISOString(),durationMs:0,appId:'generated.desktop',appName:'Generated desktop',imageMime:'image/jpeg',ocrText:'GENERATED DESKTOP',ocr:{status:'completed'},privacy:{excluded:false,redacted:false,mode:'local'}},jpeg);
  assert.equal((await api('/api/status')).storage.captures,24);
  const archive=await api('/api/export');assert.equal((await api('/api/import',archive)).duplicates,24);
  assert.equal((await api('/api/activity')).totalDurationMs,510000);
  console.log('Android upload/readback, desktop transport/readback, no-image endpoints, activity and archive checks passed.');
  window=new BrowserWindow({width:1360,height:1000,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
  const wc=window.webContents,requests=[],errors=[];
  wc.session.webRequest.onBeforeRequest((details,callback)=>{requests.push(details.url);callback({});});
  wc.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message);});
  const js=code=>wc.executeJavaScript(code);
  await window.loadURL(url);
  await js(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({token}))});location.reload()`);
  await until(()=>js(`document.body.innerText.includes('已登录 ·')`),'web auth');
  await js(`Array.from(document.querySelectorAll('.sidebar button')).find(b=>b.innerText==='采集记录').click()`);
  await until(()=>js(`document.querySelectorAll('.timeline-group .capture-card').length===24`),'web records');
  assert.equal(await js(`document.querySelectorAll('.timeline-group .capture-card .text-image').length`),9);
  await js(`document.querySelector('.timeline-group .capture-card .text-image').closest('.capture-card').click()`);
  await until(()=>js(`document.querySelector('.evidence-ocr-status')?.innerText.includes('图片去重 · 仅元数据')`),'duplicate detail');
  assert.equal(await js(`document.querySelector('[aria-label="OCR 全文"]')?.textContent`),'此记录没有正文。');
  assert(!requests.some(url=>duplicates.some(r=>url.includes(`/${r.id}/image`))),'Web must never request images for deduplicated records');
  writeFileSync(join(output,'web-duplicate-desktop.png'),(await wc.capturePage()).toPNG());
  window.setSize(390,844);await wait(200);
  assert(await js('document.documentElement.scrollWidth<=window.innerWidth'),'mobile detail fits');
  writeFileSync(join(output,'web-duplicate-mobile.png'),(await wc.capturePage()).toPNG());
  assert.deepEqual(errors,[]);
  writeFileSync(join(output,'result.json'),JSON.stringify({...result,duplicates:9,imageRecords:14,desktopRecords:1,web:true,archive:true,activityMs:510000,physicalDevice:false,liveModel:false},null,2));
  console.log('PASS: 23 Android records (9 metadata-only / 14 images), 1 desktop upload, web desktop/mobile rendering, archive and time accounting.');
})().then(()=>finish(0),error=>{console.error(error);finish(1);});
async function finish(code) {
  if(window&&!window.isDestroyed())window.destroy();
  if(port)await adb('reverse','--remove',`tcp:${port}`).catch(()=>{});
  if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('close',resolve)),wait(3000)]);}
  rmSync(temp,{recursive:true,force:true});app.exit(code);
}
