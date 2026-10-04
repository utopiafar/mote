// Build the web app first; run with: node_modules/.bin/electron scripts/test-import-folder-browser.cjs
require('./fixture-language.cjs');
const {app,BrowserWindow}=require('electron');
const {spawn}=require('node:child_process');
const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=require('node:fs');
const {join,resolve}=require('node:path');
const {tmpdir}=require('node:os');
const {createHash}=require('node:crypto');
const assert=require('node:assert/strict');
const directory=mkdtempSync(join(tmpdir(),'mote-folder-browser-')),repo=resolve(__dirname,'..');
app.setPath('userData',join(directory,'browser'));app.on('window-all-closed',()=>{});
let child,window;const delay=ms=>new Promise(done=>setTimeout(done,ms));
const originals=new Map(),folder=join(directory,'生成日记'),loose=join(directory,'loose.txt');
function original(relative,text){const path=join(directory,relative);mkdirSync(require('node:path').dirname(path),{recursive:true});writeFileSync(path,text);originals.set(relative,Buffer.from(text));}
for(let i=0;i<105;i++)original(`生成日记/entry-${i}.txt`,`Generated diary entry ${i}\n`);
original('生成日记/same.txt','Generated root same name\n');original('生成日记/子目录/same.txt','Generated nested same name\n');original('loose.txt','Generated loose original\n');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function run(){
 await app.whenReady();const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('MOTE_'))delete env[key];
 child=spawn(process.env.MOTE_FIXTURE_NODE||'node',['--import','tsx','scripts/import-folder-browser-fixture.ts',directory],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
 const fixture=await new Promise((resolve,reject)=>{let stdout='',stderr='';const deadline=setTimeout(()=>reject(Error('Fixture startup timed out: '+stderr)),30000);child.stderr.on('data',bytes=>stderr+=bytes);child.stdout.on('data',bytes=>{stdout+=bytes;for(const line of stdout.split('\n'))try{const value=JSON.parse(line);if(value.generatedOnly){clearTimeout(deadline);resolve(value);}}catch{}});child.once('exit',()=>{clearTimeout(deadline);reject(Error('Fixture exited: '+stderr));});});
 const endpoint='http://127.0.0.1:'+fixture.server.port,errors=[],receipts=[];
 const request=async path=>{for(let attempt=0;;attempt++){const response=await fetch(endpoint+path,{headers:{Authorization:'Bearer '+fixture.token}});if(response.status===429&&attempt<2){const seconds=Number(response.headers.get('retry-after'));assert.ok(seconds>0&&seconds<=60);console.info('Respecting central read rate limit:',seconds,'seconds');await delay(seconds*1000);continue;}assert.equal(response.status,200,await response.clone().text());return response;}};
 window=new BrowserWindow({width:1360,height:1000,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const wc=window.webContents,js=code=>wc.executeJavaScript(code);wc.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message);});wc.debugger.attach('1.3');
 const until=async(fn,label,interval=100)=>{const deadline=Date.now()+120000;while(Date.now()<deadline){const value=await fn();if(value)return value;await delay(interval);}throw Error('Timed out: '+label+'; '+await js('document.body.innerText'));};
 const click=async label=>until(()=>js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`),label);
 await window.loadURL(endpoint+'/__fixture-bootstrap');await js(`localStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({url:'',token:fixture.token}))});true`);await window.loadURL(endpoint+'/#/library/import');
 await until(()=>js('!!document.querySelector(".file-drop")'),'import form');
 async function submit(expected){
  const selected=await js('[...document.querySelectorAll(".selected-files .file-row span")].map(e=>e.textContent)');assert.deepEqual(selected.slice().sort(),expected.slice().sort());
  await click('加入导入队列');
  const job=await until(async()=>{const jobs=(await (await request('/api/imports')).json()).items;return jobs.find(job=>!receipts.includes(job.id)&&!['queued','preparing'].includes(job.status));},'parsed original files',500);
  if(job.status==='awaiting_confirmation'){
   await until(()=>js(`(()=>{const b=[...document.querySelectorAll('.workspace-select')].find(b=>b.querySelector('strong')?.textContent===${JSON.stringify(job.name)});if(!b)return false;b.click();return !![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='确认并开始导入'&&!b.disabled)})()`),'review preview');
   await click('确认并开始导入');
  }
  const completed=await until(async()=>{const value=await (await request('/api/imports/'+job.id)).json();if(value.status==='failed')throw Error(value.error);return value.status==='completed'?value:undefined;},'completed import',500);
  assert.equal(completed.files.length,expected.length);assert.equal(completed.captureIds.length,expected.length);assert.equal(completed.progress.imported,expected.length);
  assert.deepEqual(completed.files.map(f=>f.relativePath).sort(),expected.slice().sort());
  for(const file of completed.files){const bytes=Buffer.from(await (await request('/api/archived-files/'+file.id+'/content')).arrayBuffer());assert.equal(hash(bytes),file.hash);assert.deepEqual(bytes,originals.get(file.relativePath));}
  receipts.push(job.id);return {files:completed.files.length,records:completed.captureIds.length,hashesVerified:completed.files.length};
 }
 // Native Chromium drag dispatch grants filesystem entries for a real disk
 // directory. No mocked DataTransfer/FileSystemEntry or File blobs are used.
 const point=await js(`(()=>{const r=document.querySelector('.file-drop').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
 const data={items:[],files:[folder,loose],dragOperationsMask:1};
 for(const type of ['dragEnter','dragOver','drop'])await wc.debugger.sendCommand('Input.dispatchDragEvent',{type,...point,data});
 await until(()=>js('document.querySelectorAll(".selected-files .file-row").length===108'),'native folder drop enumeration');
 const dropped=await submit([...originals.keys()]);
 await click('新建导入');await until(()=>js('!!document.querySelector("input[webkitdirectory]")'),'directory picker');
 const dom=await wc.debugger.sendCommand('DOM.getDocument');const input=await wc.debugger.sendCommand('DOM.querySelector',{nodeId:dom.root.nodeId,selector:'input[webkitdirectory]'});
 await wc.debugger.sendCommand('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[folder]});
 await until(()=>js('document.querySelectorAll(".selected-files .file-row").length===107'),'native directory picker enumeration');
 const picked=await submit([...originals.keys()].filter(path=>path!=='loose.txt'));
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,generatedOnly:true,nativeChromiumDirectoryDrop:true,nativeChromiumDirectoryPicker:true,dropped,picked,modelCalls:0,physicalDeviceTested:false}));
}
async function finish(code){
 if(window&&!window.isDestroyed())window.destroy();
 if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(done=>child.once('exit',done)),delay(5000)]);}
 rmSync(directory,{recursive:true,force:true});app.exit(code);
}
run().then(()=>finish(0)).catch(error=>{console.error(error);finish(1);});
