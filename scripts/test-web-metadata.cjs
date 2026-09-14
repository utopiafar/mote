// Real central and Chromium UI, using generated records only; no personal screen capture.
const {app,BrowserWindow}=require('electron');
// Keep Electron alive until asynchronous fixture cleanup sets the intended exit code.
app.on('window-all-closed', () => {});
const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const assert=require('node:assert/strict');
const root=mkdtempSync(join(tmpdir(),'mote-web-metadata-')),repository=resolve(__dirname,'..');
const output=join(repository,'.mote/privacy-metadata-validation');mkdirSync(output,{recursive:true,mode:0o700});
app.setPath('userData',join(root,'browser'));
let server,window;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){const end=Date.now()+25000;while(Date.now()<end){if(await fn())return;await delay(100);}throw Error('Timed out: '+label);}
async function run(){
  await app.whenReady();
  const connectionFile=join(root,'connection.json');
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('MOTE_'))delete env[key];
  server=spawn('node',[join(repository,'scripts/test-client-connections-fixture.mjs'),'--connection-file',connectionFile],{cwd:repository,env,stdio:['ignore','pipe','pipe']});
  server.stdout.resume();server.stderr.resume();
  await until(()=>{if(server.exitCode!==null)throw Error('Fixture node exited');return existsSync(connectionFile);},'node startup');
  const {serverUrl:url,token}=JSON.parse(readFileSync(connectionFile,'utf8'));
  async function request(path,body){const response=await fetch(url+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});assert.ok(response.ok,'HTTP '+response.status);return response.json();}
  const at=new Date(Date.now()-60000).toISOString(),deviceId='fixture-metadata-device';
  const metadata={version:1,observedAt:at,collector:{version:'fixture',method:'accessibility'},device:{model:'合成设备',osVersion:'15',timeZone:'Asia/Shanghai'},state:{batteryPercent:0,charging:false,networkType:'none',screenLocked:false,availableStorageBytes:1048576},capture:{intervalMs:15000}};
  const identity={deviceId,deviceName:'合成手机',platform:'android',capturedAt:at};
  const activity={...identity,id:randomUUID(),source:'activity',appId:'dev.fixture.reader',appName:'合成阅读器',durationMs:15000,metadata,privacy:{excluded:false,redacted:false,mode:'none',collection:'activity'}};
  await request('/api/captures',activity);
  await request('/api/captures',{...identity,id:randomUUID(),source:'screen',appId:'dev.fixture.writer',appName:'合成编辑器',ocrText:'这是已允许的合成内容采样。',durationMs:0,privacy:{excluded:false,redacted:false,mode:'local',collection:'content'},metadata});
  await request('/api/devices/heartbeat',{deviceId,deviceName:identity.deviceName,platform:identity.platform,status:'capturing',queueDepth:0,metadata});
  const activityStats=await request('/api/activity');assert.equal(activityStats.activityEvents,1);assert.equal(activityStats.contentCaptures,1);assert.equal(activityStats.totalDurationMs,15000);
  window=new BrowserWindow({width:1360,height:1050,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
  const wc=window.webContents,errors=[],imageRequests=[];wc.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message);});
  wc.session.webRequest.onBeforeRequest({urls:[url+'/*']},(details,callback)=>{if(new URL(details.url).pathname.endsWith('/image'))imageRequests.push(details.url);callback({});});
  const js=code=>wc.executeJavaScript(code);
  const click=label=>js(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true;})()`);
  await window.loadURL(url);await js(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({url:'',token}))});location.reload()`);
  await until(()=>js(`document.body.innerText.includes('已登录 ·')`),'connected UI');
  assert.ok(await click('采集记录'));
  await until(()=>js(`document.querySelectorAll('.capture-card').length===2`),'two records');
  await js(`(()=>{const s=document.querySelector('[aria-label="筛选采集级别"]');s.value='activity';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(()=>js(`document.querySelectorAll('.capture-card').length===1&&document.querySelector('.capture-card').innerText.includes('合成阅读器')`),'activity filter');
  await js(`document.querySelector('.capture-card').click()`);
  await until(()=>js(`document.querySelector('.evidence-modal')?.innerText.includes('没有采集截图')`),'activity detail');
  assert.equal(await js(`document.querySelectorAll('.evidence-modal img').length`),0);
  assert.equal(await js(`document.querySelector('.evidence-modal').innerText.includes('启用本地 OCR')`),false);
  await js(`document.querySelector('.evidence-modal .metadata-details').open=true`);
  assert.ok(await js(`document.querySelector('.metadata-details').innerText.includes('0%')`));
  assert.ok(await js(`document.querySelector('.metadata-details').innerText.includes('缺失不代表否或零')`));
  writeFileSync(join(output,'web-metadata-desktop.png'),(await wc.capturePage()).toPNG());
  window.setSize(430,1000);await delay(150);assert.ok(await js(`document.documentElement.scrollWidth<=window.innerWidth`));
  writeFileSync(join(output,'web-metadata-mobile.png'),(await wc.capturePage()).toPNG());
  await js(`document.querySelector('[aria-label="关闭证据详情"]').click()`);assert.ok(await click('设备'));
  await until(()=>js(`!!document.querySelector('.device-card .metadata-details')`),'device metadata');
  await js(`document.querySelector('.device-card .device-details').open=true;document.querySelector('.device-card .metadata-details').open=true`);
  assert.ok(await js(`document.querySelector('.device-card').innerText.includes('合成设备')`));
  assert.deepEqual(errors,[]);assert.deepEqual(imageRequests,[]);
  writeFileSync(join(output,'web-result.json'),JSON.stringify({passed:true,generatedOnly:true,checks:['activity HTTP ingestion','separate sample counts','activity filter','content-free evidence','zero and false state','device metadata','no image fetch','desktop/mobile layout']},null,2));
  console.info('PASS: generated activity → central → real web timeline/filter/evidence/device metadata; no screen or image requests.');
}
async function finish(code){if(window&&!window.isDestroyed())window.destroy();if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('close',resolve)),delay(5000)]);}rmSync(root,{recursive:true,force:true});app.exit(code);}
run().then(()=>finish(0),error=>{console.error(error.message);void finish(1);});
