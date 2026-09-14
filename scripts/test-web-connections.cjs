/** Generated credentials and content; isolated node and browser, never the daily archive. */
const {app,BrowserWindow}=require('electron');
// Keep Electron alive until asynchronous fixture cleanup sets the intended exit code.
app.on('window-all-closed', () => {});
const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const {spawn}=require('node:child_process');
const {randomBytes,randomUUID}=require('node:crypto');
const assert=require('node:assert/strict');
const net=require('node:net');
const root=mkdtempSync(join(tmpdir(),'mote-web-connections-')),repository=resolve(__dirname,'..');
const output=join(repository,'.mote/connections-validation');mkdirSync(output,{recursive:true,mode:0o700});
app.setPath('userData',join(root,'browser'));
let server,window,reader;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){const end=Date.now()+25000;while(Date.now()<end){if(await fn())return;await delay(100);}throw Error('Timed out: '+label);}
async function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});}
async function run(){
  await app.whenReady();
  const port=await freePort(),url=`http://127.0.0.1:${port}`,owner=randomBytes(32).toString('hex'),legacyRead=randomBytes(32).toString('hex');
  const config=join(root,'node.env');writeFileSync(config,`MOTE_PROFILE=test\nMOTE_HOST=127.0.0.1\nMOTE_PORT=${port}\nMOTE_DATA_DIR=./data\nMOTE_TOKEN=${owner}\nMOTE_MCP_ENABLED=1\nMOTE_MCP_READ_TOKEN=${legacyRead}\n`,{mode:0o600});
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('MOTE_'))delete env[key];
  server=spawn('node',[join(repository,'apps/server/dist/index.js')],{cwd:repository,env:{...env,MOTE_ENV_FILE:config},stdio:['ignore','pipe','pipe']});
  let startupFailure=false;server.stderr.on('data',()=>{startupFailure=true;});
  await until(async()=>{if(server.exitCode!==null)throw Error('Fixture central exited before health'+(startupFailure?' (stderr recorded)':''));try{return(await fetch(url+'/api/health')).ok;}catch{return false;}},'central health');
  window=new BrowserWindow({width:1370,height:1100,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
  const wc=window.webContents,errors=[];wc.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message);});
  const js=code=>wc.executeJavaScript(code);
  const click=label=>js(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true;})()`);
  const input=(label,value)=>js(`(()=>{const e=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  async function request(path,token,body,method=body?'POST':'GET'){return fetch(url+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});}
  await window.loadURL(url);
  await js(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({url:'',token:owner}))});location.reload()`);
  await until(()=>js(`document.body.innerText.includes('中央节点已连接')`),'owner UI');
  assert.ok(await click('设备'));await click('添加设备');await click('连接 Chatbot');await until(()=>js(`document.querySelector('#connections-title')&&Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='生成 MCP JSON'&&!b.disabled)`),'connections panel');
  assert.ok(await js(`document.querySelector('.connection-warning').textContent.includes('手机自己')`));
  assert.equal(await js(`document.querySelector('.connections').innerText.includes(${JSON.stringify(owner)})`),false);
  await click('连接设备');await input('连接名称','合成手机 · QR / JSON');assert.ok(await click('生成连接邀请'));
  await until(()=>js(`!!document.querySelector('.connection-qr img')`),'local QR rendered');
  const invite=JSON.parse(await js(`document.querySelector('[aria-label="连接邀请 JSON"]').value`));
  assert.equal(invite.serverUrl,url);assert.equal(invite.format,'mote.connection');assert.ok(!JSON.stringify(invite).includes(owner));
  const qr=await js(`document.querySelector('.connection-qr img').src`);assert.ok(qr.startsWith('data:image/png;base64,'));
  writeFileSync(join(output,'web-connection-qr.png'),Buffer.from(qr.split(',')[1],'base64'));
  const download=new Promise((resolve,reject)=>{wc.session.once('will-download',(_event,item)=>{const path=join(root,'invitation.json');item.setSavePath(path);item.once('done',(_e,state)=>state==='completed'?resolve(path):reject(Error('Invitation download failed')));});});
  assert.ok(await click('下载 JSON'));const path=await Promise.race([download,delay(15000).then(()=>{throw Error('Invitation download timeout');})]);
  assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),invite);
  const device='synthetic-qr-'+randomUUID(),body={code:invite.code,deviceId:device,deviceName:'合成手机',platform:'android'};
  const redemption=await request('/api/connections/redeem',null,body);assert.equal(redemption.status,200);const connection=await redemption.json();assert.notEqual(connection.token,owner);
  assert.equal((await request('/api/connections/redeem',null,body)).status,410);
  const note={id:randomUUID(),deviceId:device,deviceName:'合成手机',platform:'android',capturedAt:new Date().toISOString(),text:'Generated onboarding diary: today I tested QR, an offline queue and reconnecting. No real user content.'};
  assert.equal((await request('/api/notes',connection.token,note)).status,201);
  assert.equal((await request('/api/devices/heartbeat',connection.token,{deviceId:device,deviceName:'合成手机',platform:'android',status:'paused',queueDepth:0})).status,200);
  assert.equal((await request('/api/configuration',connection.token)).status,403);
  await click('刷新连接');await until(()=>js(`document.querySelector('.connection-list')?.innerText.includes('合成手机 · QR / JSON')`),'paired identity inventory');
  await click('取消邀请');await until(()=>js(`!document.querySelector('.connection-invitation')`),'clear used invitation');
  await click('撤销');await click('确认撤销');await until(()=>js(`document.querySelector('.connection-list').innerText.includes('已撤销')`),'revoked client UI');
  assert.equal((await request('/api/notes',connection.token,{...note,id:randomUUID()})).status,401);
  assert.equal((await request('/api/notes',owner)).status,200);
  await js(`(()=>{const s=document.querySelector('[aria-label="邀请设备身份"]');s.value=${JSON.stringify(device)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await click('生成连接邀请');await until(()=>js(`!!document.querySelector('[aria-label="连接邀请 JSON"]')`),'bound recovery invitation');
  const replacement=JSON.parse(await js(`document.querySelector('[aria-label="连接邀请 JSON"]').value`));
  const recovered=await request('/api/connections/redeem',null,{...body,code:replacement.code});assert.equal(recovered.status,200);
  const newConnection=await recovered.json();assert.notEqual(newConnection.token,connection.token);
  assert.equal((await(await request('/api/connections/self',newConnection.token)).json()).credential.deviceId,device);
  assert.equal((await request('/api/connections/self',connection.token)).status,401);
  await click('取消邀请');await until(()=>js(`!document.querySelector('.connection-invitation')`),'clear recovery invitation');
  await input('连接名称','合成 Chatbot · 只读');await click('连接 Chatbot');assert.ok(await click('生成 MCP JSON'));
  await until(()=>js(`!!document.querySelector('[aria-label="MCP JSON"]')`),'MCP JSON created');
  const mcpConfig=JSON.parse(await js(`document.querySelector('[aria-label="MCP JSON"]').value`)),mcp=mcpConfig.mcpServers.mote;
  assert.equal(mcp.url,url+'/mcp');assert.ok(!JSON.stringify(mcpConfig).includes(owner));
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
  const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  reader=new Client({name:'generated-onboarding-chatbot',version:'1'});await reader.connect(new StreamableHTTPClientTransport(new URL(mcp.url),{requestInit:{headers:mcp.headers}}));
  const tools=(await reader.listTools()).tools.map(t=>t.name);assert.ok(tools.includes('mote_timeline'));assert.ok(!tools.includes('mote_put_item'));
  const timeline=await reader.callTool({name:'mote_timeline',arguments:{}});assert.ok(JSON.stringify(timeline).includes(note.id));
  await click('已保存，隐藏凭据');assert.equal(await js(`!!document.querySelector('[aria-label="MCP JSON"]')`),false);
  assert.equal(await js(`document.querySelector('.connections').textContent.includes(${JSON.stringify(mcp.headers.Authorization)})`),false);
  await js(`document.querySelector('.connections').scrollIntoView({block:'start'})`);await delay(150);writeFileSync(join(output,'web-connections-desktop.png'),(await wc.capturePage()).toPNG());
  window.setSize(430,1000);await delay(200);assert.ok(await js(`document.documentElement.scrollWidth<=window.innerWidth`));writeFileSync(join(output,'web-connections-mobile.png'),(await wc.capturePage()).toPNG());
  assert.deepEqual(errors,[]);
  writeFileSync(join(output,'web-result.json'),JSON.stringify({passed:true,generatedOnly:true,checks:['local QR','download invitation JSON','one-use redemption','collector note/heartbeat','admin isolation','revocation','bound existing-device reauthorization','MCP JSON real SDK read','owner secret absent','desktop/mobile layouts']},null,2));
  console.info('PASS: generated QR/JSON → isolated central → scoped client capture/note ingestion → revoke; MCP JSON → real SDK read; responsive web UI. No live model or personal capture.');
}
async function finish(code){if(reader)await reader.close().catch(()=>{});if(window&&!window.isDestroyed())window.destroy();if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('close',resolve)),delay(5000)]);}rmSync(root,{recursive:true,force:true});app.exit(code);}
run().then(()=>finish(0),error=>{console.error(error.message);void finish(1);});
