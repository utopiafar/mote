/** Real Electron renderer + isolated central process; generated text only, no screen capture APIs. */
const {app, BrowserWindow} = require('electron');
// Keep Electron alive until asynchronous fixture cleanup sets the intended exit code.
app.on('window-all-closed', () => {});
const {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {randomBytes, randomUUID} = require('node:crypto');
const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const net = require('node:net');
const root = mkdtempSync(join(tmpdir(), 'mote-web-diagnostics-'));
const repository = resolve(__dirname, '..');
const output = join(repository, '.mote/ops-validation'); mkdirSync(output,{recursive:true,mode:0o700});
app.setPath('userData',join(root,'browser'));
let server, window;
const sleep = ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn, label) { const deadline=Date.now()+20000;while(Date.now()<deadline){const value=await fn();if(value)return value;await sleep(100);}throw Error(`Timed out: ${label}`); }
async function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});}
(async()=>{
  await app.whenReady();
  const port=await freePort(),url=`http://127.0.0.1:${port}`,token=randomBytes(32).toString('hex');
  const file=join(root,'mote.env');
  const modelKey='generated-model-secret-'+randomUUID();
  writeFileSync(file,`MOTE_PROFILE=test\nMOTE_PORT=${port}\nMOTE_HOST=127.0.0.1\nMOTE_DATA_DIR=./data\nMOTE_TOKEN=${token}\nMOTE_DEBUG=1\nMOTE_MODEL_API_KEY=${modelKey}\nMOTE_PUBLIC_URL=https://fixture.example.com\n`,{mode:0o600});
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('MOTE_'))delete env[key];
  server=spawn('node',[join(repository,'apps/server/dist/index.js')],{cwd:repository,env:{...env,MOTE_ENV_FILE:file},stdio:['ignore','pipe','pipe']});
  let serverFailure='';server.stderr.on('data',chunk=>{serverFailure+=chunk;});
  await until(async()=>{if(server.exitCode!==null)throw Error('Fixture server exited: '+serverFailure.slice(0,200));try{return(await fetch(url+'/api/health')).ok;}catch{return false;}},'server health');
  const generatedText='DIAGNOSTIC_FIXTURE_PRIVATE_SENTINEL_原始日记不应进入诊断包';
  const created=await fetch(url+'/api/notes',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({id:randomUUID(),deviceId:'synthetic-diagnostics',deviceName:'合成输入',platform:'android',capturedAt:new Date().toISOString(),text:generatedText})});
  assert.equal(created.status,201);const requestId=created.headers.get('X-Request-Id');assert.ok(requestId);
  window=new BrowserWindow({width:1360,height:1100,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false}});
  const wc=window.webContents,errors=[];wc.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message);});
  await window.loadURL(url);
  await wc.executeJavaScript(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({url:'',token}))});location.reload()`);
  await until(()=>wc.executeJavaScript(`document.body.innerText.includes('中央节点已连接')`),'authenticated app');
  await wc.executeJavaScript(`Array.from(document.querySelectorAll('.sidebar button')).find(b=>b.innerText==='设置').click()`);
  await until(()=>wc.executeJavaScript(`!!document.querySelector('.preference-menu')`),'settings hub');
  const feedback = await wc.executeJavaScript(`(()=>{const link=document.querySelector('.preference-menu a.feedback-link');return {href:link.href,target:link.target,rel:link.rel};})()`);
  const feedbackUrl = new URL(feedback.href);
  assert.equal(feedbackUrl.origin,'https://github.com');assert.equal(feedbackUrl.pathname,'/utopiafar/mote/issues/new');
  assert.equal(feedbackUrl.searchParams.get('template'),'bug_report.yml');assert(feedbackUrl.searchParams.get('version').includes('Web'));
  assert.equal(feedback.target,'_blank');assert(feedback.rel.includes('noreferrer'));
  for(const privateValue of [token,modelKey,generatedText,url,root])assert.equal(decodeURIComponent(feedback.href).includes(privateValue),false);
  await wc.executeJavaScript(`Array.from(document.querySelectorAll('.preference-menu button')).find(b=>b.querySelector('strong')?.textContent==='开发者选项').click()`);
  await until(()=>wc.executeJavaScript(`!!document.querySelector('.deployment-details')`),'effective server configuration');
  await wc.executeJavaScript(`document.querySelector('.deployment-details').open=true`);
  const settingsText=await wc.executeJavaScript(`document.querySelector('.deployment-details').innerText`);
  assert.ok(settingsText.includes(join(root,'data','mote.sqlite')));
  assert.ok(settingsText.includes(file));
  assert.ok(settingsText.includes('MOTE_MAX_STORAGE_MB'));
  assert.ok(settingsText.includes('https://fixture.example.com'));
  assert.ok(settingsText.includes('已配置'));
  assert.equal(settingsText.includes(token),false);assert.equal(settingsText.includes(modelKey),false);
  writeFileSync(join(output,'web-settings-desktop.png'),(await wc.capturePage()).toPNG());
  window.setSize(430,1000);await sleep(200);
  assert.equal(await wc.executeJavaScript('document.documentElement.scrollWidth<=window.innerWidth'),true);
  writeFileSync(join(output,'web-settings-mobile.png'),(await wc.capturePage()).toPNG());
  window.setSize(1360,1100);await sleep(100);
  await wc.executeJavaScript(`document.querySelector('.deployment-details').open=false`);
  await until(()=>wc.executeJavaScript(`document.body.innerText.includes('本次运行')`),'diagnostic snapshot');
  assert.equal(await wc.executeJavaScript(`document.querySelector('#diagnostics-title').textContent`),'运行诊断');
  await wc.executeJavaScript(`document.querySelector('.diagnostics-events').open=true;document.querySelector('.diagnostics-panel').scrollIntoView({block:'start'})`);
  await until(()=>wc.executeJavaScript(`document.querySelector('.diagnostics-events tbody').innerText.includes(${JSON.stringify(requestId)})`),'request correlation');
  await wc.executeJavaScript(`(()=>{const input=document.querySelector('[aria-label="诊断请求编号"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(requestId)});input.dispatchEvent(new Event('input',{bubbles:true}));})();`);
  await until(()=>wc.executeJavaScript(`(()=>{const rows=Array.from(document.querySelectorAll('.diagnostics-events tbody tr'));return rows.length>0&&rows.every(row=>row.lastElementChild.textContent===${JSON.stringify(requestId)});})()`),'filtered stage and request events');
  const download=new Promise((resolve,reject)=>{wc.session.once('will-download',(_event,item)=>{const path=join(root,'support.json');item.setSavePath(path);item.once('done',(_e,state)=>{if(state!=='completed')reject(Error('Download failed'));else resolve(path);});});});
  await wc.executeJavaScript(`Array.from(document.querySelectorAll('.diagnostics-actions button')).find(b=>b.innerText==='导出诊断包').click()`);
  const path=await Promise.race([download,sleep(15000).then(()=>{throw Error('Support download timed out');})]);
  const raw=readFileSync(path,'utf8'),bundle=JSON.parse(raw);
  assert.equal(bundle.scope,'central-safe-support');assert.ok(bundle.events.some(e=>e.requestId===requestId));
  assert.equal(raw.includes(generatedText),false);assert.equal(raw.includes(token),false);assert.equal(raw.includes(modelKey),false);assert.equal(raw.includes(root),false);
  await wc.executeJavaScript(`document.querySelector('.diagnostics-panel').scrollIntoView({block:'start'})`);
  await sleep(150);writeFileSync(join(output,'web-diagnostics-desktop.png'),(await wc.capturePage()).toPNG());
  window.setSize(430,1000);await sleep(200);
  assert.equal(await wc.executeJavaScript('document.documentElement.scrollWidth<=window.innerWidth'),true);
  await wc.executeJavaScript(`document.querySelector('.diagnostics-panel').scrollIntoView({block:'start'})`);
  writeFileSync(join(output,'web-diagnostics-mobile.png'),(await wc.capturePage()).toPNG());
  assert.deepEqual(errors,[]);
  console.info('PASS: actual renderer → isolated central node → effective settings/storage paths/secret status/refresh → profile/snapshot → request ID filter → safe support download; desktop/mobile layouts rendered. Generated notes only.');
})().then(()=>finish(0),error=>{console.error(error.stack);finish(1);});
async function finish(code){
  if(window&&!window.isDestroyed())window.destroy();
  if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('close',r)),sleep(5000)]);}
  rmSync(root,{recursive:true,force:true});app.exit(code);
}
