require('./fixture-language.cjs');
/** Real renderer + generated central storage only; no personal content or screen capture APIs. */
const {app,BrowserWindow}=require('electron');
const {mkdtempSync,writeFileSync,readFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const {randomBytes,randomUUID}=require('node:crypto');
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const net=require('node:net');
const root=mkdtempSync(join(tmpdir(),'mote-content-web-')),repository=resolve(__dirname,'..');
app.setPath('userData',join(root,'browser'));app.on('window-all-closed',()=>{});
let server,window;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const deadline=Date.now()+20000;while(Date.now()<deadline){if(await fn())return;await sleep(50);}throw Error('Timed out: '+label);}
async function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});}
(async()=>{
  await app.whenReady();const port=await freePort(),url=`http://127.0.0.1:${port}`,token=randomBytes(32).toString('hex');
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('MOTE_'))delete env[key];
  const envFile=join(root,'fixture.env');writeFileSync(envFile,`MOTE_DATA_DIR=${join(root,'data')}\nMOTE_HOST=127.0.0.1\nMOTE_PORT=${port}\nMOTE_TOKEN=${token}\nMOTE_DATA_KEY=${'af'.repeat(32)}\nMOTE_LOG_LEVEL=silent\n`);
  server=spawn('node',[join(repository,'apps/server/dist/index.js')],{cwd:repository,env:{...env,MOTE_ENV_FILE:envFile},stdio:['ignore','pipe','pipe']});
  let failure='';server.stderr.on('data',c=>failure+=c);
  await until(async()=>{if(server.exitCode!==null)throw Error('Generated central failed: '+failure.slice(0,200));try{return(await fetch(url+'/api/health')).ok;}catch{return false;}},'central health');
  window=new BrowserWindow({width:1100,height:900,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false}});
  const wc=window.webContents;await window.loadURL(url);
  await wc.executeJavaScript(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({token}))});location.reload()`);
  await until(()=>wc.executeJavaScript(`document.body.innerText.includes('已登录 ·')`),'login');
  await wc.executeJavaScript(`Array.from(document.querySelectorAll('.sidebar button')).find(b=>b.innerText==='设置').click()`);
  await until(()=>wc.executeJavaScript(`!!document.querySelector('.preference-menu')`),'settings');
  await wc.executeJavaScript(`Array.from(document.querySelectorAll('.preference-menu button')).find(b=>b.querySelector('strong')?.textContent==='开发者选项').click()`);
  const checkbox=`document.querySelector('[aria-labelledby="content-storage-title"] input')`;
  await until(()=>wc.executeJavaScript(`!!${checkbox}&&!${checkbox}.disabled`),'storage controls');
  assert.equal(await wc.executeJavaScript(`${checkbox}.checked`),false);
  await wc.executeJavaScript(`${checkbox}.click()`);
  await until(()=>wc.executeJavaScript(`${checkbox}.checked&&!${checkbox}.disabled`),'enabled policy');
  const image=await require('sharp')({create:{width:32,height:32,channels:3,background:'#246789'}}).png().toBuffer();
  const response=await fetch(url+'/api/captures',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),deviceId:'generated',deviceName:'Generated fixture',platform:'import',capturedAt:new Date().toISOString(),durationMs:0,source:'screen',ocrText:'generated content',imageMime:'image/png',imageBase64:image.toString('base64')})});
  assert.equal(response.status,201);const saved=await response.json(),path=join(root,'data','blobs',saved.blobHash);
  assert.equal(readFileSync(path).subarray(0,5).toString(),'MOTE1');
  await wc.executeJavaScript(`${checkbox}.click()`);
  await until(()=>wc.executeJavaScript(`!${checkbox}.checked&&!${checkbox}.disabled`),'disabled policy');
  assert.equal(readFileSync(path).subarray(0,5).toString(),'MOTE1');
  await wc.executeJavaScript(`Array.from(document.querySelectorAll('[aria-labelledby="content-storage-title"] button')).find(b=>b.innerText==='一次性批量解密').click()`);
  await until(()=>wc.executeJavaScript(`document.querySelector('[aria-labelledby="content-storage-title"]').innerText.includes('处理完成')`),'background conversion');
  assert.deepEqual(readFileSync(path),image);
  assert.ok(await wc.executeJavaScript(`document.querySelector('[aria-labelledby="content-storage-title"]').innerText.includes('已转换 1 项')`));
  window.setSize(430,900);await sleep(100);
  assert.equal(await wc.executeJavaScript('document.documentElement.scrollWidth<=window.innerWidth'),true);
  console.log('PASS: real developer UI defaults off, saves optional encryption, preserves old files until explicit decryption, renders background results and fits mobile. Generated content only.');
})().then(()=>finish(0),error=>{console.error(error);finish(1);});
async function finish(code){if(window&&!window.isDestroyed())window.destroy();if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('exit',r)),sleep(5000)]);}rmSync(root,{recursive:true,force:true});app.exit(code);}
