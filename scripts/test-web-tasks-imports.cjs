require('./fixture-language.cjs');
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
const root=mkdtempSync(join(tmpdir(),'mote-web-tasks-imports-')),repository=resolve(__dirname,'..');
const output=join(repository,'.mote/tasks-import-validation');mkdirSync(output,{recursive:true,mode:0o700});
app.setPath('userData',join(root,'browser'));
let server,window;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){const end=Date.now()+25000;while(Date.now()<end){if(await fn())return;await delay(100);}if(window)console.error(await window.webContents.executeJavaScript('document.body.innerText'));throw Error('Timed out: '+label);}
async function run(){
  await app.whenReady();
  const connectionFile=join(root,'connection.json');
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('MOTE_'))delete env[key];
  server=spawn('node',[join(repository,'scripts/test-client-connections-fixture.mjs'),'--connection-file',connectionFile],{cwd:repository,env,stdio:['ignore','pipe','pipe']});
  server.stdout.resume();server.stderr.resume();
  await until(()=>{if(server.exitCode!==null)throw Error('Fixture node exited');return existsSync(connectionFile);},'node startup');
  const {serverUrl:url,token}=JSON.parse(readFileSync(connectionFile,'utf8'));
  async function request(path,body){const response=await fetch(url+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});assert.ok(response.ok,'HTTP '+response.status);return response.json();}
  window=new BrowserWindow({width:1360,height:1050,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
  const wc=window.webContents,errors=[],imageRequests=[];wc.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message);});
  wc.session.webRequest.onBeforeRequest({urls:[url+'/*']},(details,callback)=>{if(new URL(details.url).pathname.endsWith('/image'))imageRequests.push(details.url);callback({});});
  const js=code=>wc.executeJavaScript(code);
  const click=label=>js(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true;})()`);
  await window.loadURL(url);await js(`localStorage.setItem('mote.record-layout','grid');sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({url:'',token}))});location.reload()`);
  await until(()=>js(`document.body.innerText.includes('已登录 ·')`),'connected UI');
  await js(`location.hash='/actions'`);
  await until(()=>js(`!!document.querySelector('[aria-label="待办"] form')`),'tasks');
  await js(`(()=>{const input=document.querySelector('[aria-label="待办"] input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Generated task without an invented deadline');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  assert.ok(await click('添加待办'));
  await until(()=>js(`document.querySelector('[aria-label="待办"]').innerText.includes('Generated task without an invented deadline')`),'created task');
  let task=(await request('/api/todos')).items[0];assert.equal(task.dueAt,null);assert.equal(task.status,'open');
  assert.ok(await click('标记完成'));
  await until(async()=>{task=(await request('/api/todos')).items[0];return task.status==='completed';},'completed task');
  assert.equal((await request('/api/actions')).items.length,0,'Local task must not create a calendar proposal');
  await js(`location.hash='/library/import'`);
  await until(()=>js(`!!document.querySelector('input[type="file"]')`),'imports');
  await js(`(()=>{const files=new DataTransfer();for(let i=0;i<8;i++)files.items.add(new File(['Generated month '+i+' fixture notes. '.repeat(200)],'synthetic-'+i+'.txt',{type:'text/plain'}));const input=document.querySelector('input[type="file"]');input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(()=>js(`document.querySelectorAll('.selected-files .file-row').length===8`),'selected originals');
  assert.ok(await click('保存原件并处理'));
  await until(async()=>{const jobs=(await request('/api/imports')).items;return jobs.length===1&&jobs[0].status==='completed';},'deterministic import');
  const job=(await request('/api/imports')).items[0];assert.equal(job.archive.files,8);assert.equal(job.progress.imported,8);assert.equal(job.memoryJobId,undefined);
  await until(()=>js(`document.querySelector('.import-detail')?.innerText.includes('记录已保存')`),'saved import UI');
  assert.equal(await js(`document.querySelectorAll('.import-steps .done').length`),3,'Unscheduled memory must not be marked complete');
  // Pause before the first upload acknowledgement, retain the selection, then
  // resume the same generated file through the actual central upload routes.
  assert.ok(await click('新建导入'));
  await js(`(()=>{const files=new DataTransfer();files.items.add(new File(['Generated individual note'], 'single-generated.txt',{type:'text/plain'}));const input=document.querySelector('input[type="file"]');input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));const real=window.fetch.bind(window);window.restoreImportFetch=()=>{window.fetch=real;};let pause=true;window.fetch=(input,init)=>{const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;if(pause&&path==='/api/import-uploads'){pause=false;return new Promise((resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});});}return real(input,init);};})()`);
  assert.ok(await click('保存原件并处理'));
  await until(()=>js(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='暂停上传')`),'pausable upload');
  assert.equal(await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='服务器目录').disabled`),true);
  assert.ok(await click('暂停上传'));
  await until(()=>js(`document.body.innerText.includes('上传已暂停')`),'upload pause acknowledgement');
  assert.equal(await js(`document.querySelectorAll('.selected-files .file-row').length`),1);
  assert.equal((await request('/api/imports')).items.length,1,'Pausing does not create a phantom import');
  assert.ok(await click('保存原件并处理'));
  await until(async()=>{const jobs=(await request('/api/imports')).items;return jobs.length===2&&jobs.every(job=>job.status==='completed');},'individual resumed import');
  await js(`window.restoreImportFetch()`);
  // Gmail OAuth/transport is fixture-driven here; no real account or mail is accessed.
  await js(`(()=>{const real=window.fetch.bind(window);let connected=false,round=0;window.gmailFixture={starts:0,syncs:0,disconnects:0};window.fetch=async(input,init)=>{const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;const json=value=>Promise.resolve(new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}}));if(path==='/api/connectors/status')return json({gmail:{configured:true,connected,account:connected?'generated@example.invalid':undefined,state:'idle',hasMore:connected&&round<2},google:{configured:false},mcp:{enabled:false}});if(path==='/api/connectors/gmail/start'){window.gmailFixture.starts++;connected=true;return json({authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly&state=generated'});}if(path==='/api/connectors/gmail/sync'){window.gmailFixture.syncs++;round++;return json({imported:100,duplicates:0,hasMore:round<2});}if(path==='/api/connectors/gmail'&&init?.method==='DELETE'){window.gmailFixture.disconnects++;connected=false;return json({connected:false});}return real(input,init);};location.hash='/sources';})()`);
  await until(()=>js(`Array.from(document.querySelectorAll('summary')).some(e=>e.textContent.includes('连接 Gmail'))`),'Gmail source');
  assert.ok(await click('添加来源'));assert.ok(await click('连接服务'));
  await js(`Array.from(document.querySelectorAll('summary')).find(e=>e.textContent.includes('连接 Gmail')).click()`);
  const gmailClick=label=>js(`(()=>{const panel=Array.from(document.querySelectorAll('details')).find(e=>e.querySelector('summary')?.textContent.includes('连接 Gmail'));const b=Array.from(panel.querySelectorAll('button')).find(e=>e.textContent===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true;})()`);
  assert.ok(await gmailClick('开始授权'));
  await until(()=>js(`Array.from(document.querySelectorAll('a')).some(e=>e.href.startsWith('https://accounts.google.com/')&&e.href.includes('gmail.readonly'))`),'read-only authorization link');
  await until(()=>gmailClick('继续同步'),'first Gmail page');
  await until(()=>js(`document.body.innerText.includes('后续邮件将在下一轮继续同步')`),'Gmail continuation');
  await until(()=>gmailClick('继续同步'),'second Gmail page');
  await until(()=>gmailClick('断开账户'),'disconnect Gmail');
  await until(()=>js(`!document.body.innerText.includes('generated@example.invalid')`),'disconnected Gmail');
  assert.deepEqual(await js('window.gmailFixture'),{starts:1,syncs:2,disconnects:1});
  assert.deepEqual(errors,[]);assert.deepEqual(imageRequests,[]);
  console.info('PASS: real browser creates/completes a task with no deadline or calendar side effect; batch imports eight generated originals and individually pauses/resumes one upload without a phantom job; unscheduled memory stays separate; Gmail fixture covers read-only authorization, continuation and disconnect.');
}
async function finish(code){if(window&&!window.isDestroyed())window.destroy();if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('close',resolve)),delay(5000)]);}rmSync(root,{recursive:true,force:true});app.exit(code);}
run().then(()=>finish(0),error=>{console.error(error.message);void finish(1);});
