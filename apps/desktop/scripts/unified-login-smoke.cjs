require('../../../scripts/fixture-language.cjs');
/** Real native IPC and generated central fixture only. Capture stays stopped throughout. */
const {app,safeStorage,dialog}=require('electron');
const {mkdtempSync,writeFileSync}=require('node:fs');
const {rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');const {join}=require('node:path');
const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const {defaultConfig,ConfigStore}=require('../dist/config');
const root=mkdtempSync(join(tmpdir(),'mote-unified-native-')),origin='http://127.0.0.1:47883',owner='generated-native-central-owner-token-123456';
app.setPath('userData',root);process.env.MOTE_PROFILE='legacy';for(const key of ['MOTE_URL','MOTE_TOKEN','MOTE_ENV_FILE'])delete process.env[key];
const opened=[];const cp=require('node:child_process'),execFile=cp.execFile;
cp.execFile=function(file,args,...rest){if(file==='/usr/bin/open'){opened.push(args.at(-1));queueMicrotask(()=>rest.at(-1)(null,'',''));return {kill:()=>true};}return execFile.call(this,file,args,...rest);};
dialog.showErrorBox=(_title,message)=>{throw Error(message);};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const deadline=Date.now()+45000;while(Date.now()<deadline){if(await fn())return;await pause(100);}throw Error('Timed out: '+label);}
const request=(path,token=owner,body,method=body?'POST':'GET')=>fetch(origin+path,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
let window;
app.on('browser-window-created',(_event,value)=>{window=value;value.webContents.once('did-finish-load',()=>void run(value).then(()=>finish(0),error=>{console.error(error.stack);console.error(JSON.stringify({checkFailures}));void finish(1);}));});
const checkFailures=[];const connection=require('../dist/connection'),testConnection=connection.testConnection;connection.testConnection=async(...args)=>{try{return await testConnection(...args);}catch(e){checkFailures.push(e.code);throw e;}};
const timeout=setTimeout(()=>{console.error('Native login fixture timeout');void finish(1);},90000);
async function run(value){
 const js=code=>value.webContents.executeJavaScript(code),status=()=>js('window.mote.status()');
 await until(async()=>(await status()).config.tokenConfigured,'canonical login restored');
 assert.equal((await status()).running,false);
 assert.equal(await js(`document.querySelector('#node-login-panel').hidden`),true);
 assert.equal(await js(`document.querySelector('#node-token-field').hidden`),true);
 assert.ok(Array.isArray((await js(`window.mote.ask('history')`)).items));
 const id=randomUUID();await js(`window.mote.ask('start',{id:${JSON.stringify(id)},question:'Generated unified Mac login question'})`);
 await until(async()=>(await js(`window.mote.ask('run',{id:${JSON.stringify(id)}})`)).status==='completed','native query without token entry');
 const page=await js(`window.mote.browseCaptures({location:'central',day:${JSON.stringify(new Date().toISOString().slice(0,10))}})`);assert.ok(Array.isArray(page.items));
 await js(`window.mote.openCentral('vault')`);assert.equal(opened.length,1);
 const url=new URL(opened[0]),code=new URLSearchParams(url.hash.split('?')[1]).get('loginTicket');assert.match(code,/^[A-Za-z0-9_-]{43}$/);assert.ok(!url.href.includes(owner));
 const exchange=await request('/api/login/exchange','',{code});assert.equal(exchange.status,200);
 const handed=await exchange.json();assert.notEqual(handed.token,owner);const exported=await request('/api/export',handed.token);assert.equal(exported.status,200);await exported.arrayBuffer();
 await js(`window.mote.ask('logout')`);assert.equal((await status()).config.tokenConfigured,false);
 assert.equal((await request('/api/configuration',handed.token)).status,401);
 assert.equal(await js(`window.mote.ask('history').then(()=>false,()=>true)`),true);
 await js(`window.mote.ask('login',{token:${JSON.stringify(owner)},durationMs:86400000})`);assert.equal((await status()).config.tokenConfigured,true);
 assert.equal(await js(`document.querySelector('#node-login-panel').hidden`),true);assert.equal(await js(`document.querySelector('#node-token-field').hidden`),true);
 const store=new ConfigStore(root,{available:()=>safeStorage.isEncryptionAvailable(),encrypt:v=>safeStorage.encryptString(v),decrypt:v=>safeStorage.decryptString(v)}),saved=await store.load();
 assert.notEqual(saved.token,owner);assert.ok(saved.authExpiresAt>Date.now());
 const self=await(await request('/api/connections/self',saved.token)).json();assert.equal(self.credential.scope,'owner');assert.equal(self.credential.deviceId,saved.deviceId);
 assert.equal((await request('/api/connections/'+self.credential.id,owner,undefined,'DELETE')).status,200);
 assert.equal((await request('/api/configuration',saved.token)).status,401);
 await until(async()=>!(await status()).config.tokenConfigured,'remote revocation clears all native entry points');assert.equal((await status()).running,false);
 // Hold a real freshly minted grant across logout. It must never restore the login or remain active.
 const realFetch=globalThis.fetch;let release,issued=false;
 globalThis.fetch=async(...args)=>{const response=await realFetch(...args);if(String(args[0])===origin+'/api/login/session'){issued=true;await new Promise(r=>{release=r;});}return response;};
 try {
  const late=js(`window.mote.ask('login',{token:${JSON.stringify(owner)}}).then(()=>false,()=>true)`);
  await until(()=>issued,'delayed login grant');await js(`window.mote.ask('logout')`);release();
  assert.equal(await late,true);assert.equal((await status()).config.tokenConfigured,false);
 } finally {globalThis.fetch=realFetch;release?.();}
 const registry=await(await request('/api/connections')).json();
 assert.equal(registry.items.filter(c=>c.deviceId===saved.deviceId&&!c.revokedAt).length,0);
 console.log(JSON.stringify({passed:true,generatedOnly:true,canonicalRestore:true,noRepeatedTokenControls:true,nativeQuery:true,archive:true,export:true,browserTicket:true,sharedLogout:true,reauthorization:true,remoteRevocation:true,lateLoginFencedAndRevoked:true,captureStayedStopped:true}));
}
async function finish(code){clearTimeout(timeout);if(window&&!window.isDestroyed())window.destroy();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});app.exit(code);}
app.whenReady().then(async()=>{
 assert.ok(safeStorage.isEncryptionAvailable());const config={...defaultConfig(),serverUrl:origin,deviceName:'Generated unified Mac',ocrEnabled:false,metadataEnabled:false};
 const grant=await(await request('/api/login/session',owner,{serverUrl:origin,deviceId:config.deviceId,deviceName:config.deviceName,platform:'macos',durationMs:86400000})).json();assert.ok(grant.token);
 writeFileSync(join(root,'config.json'),JSON.stringify({version:1,config:{...config,authExpiresAt:grant.expiresAt},encryptedToken:safeStorage.encryptString(grant.token).toString('base64')}),{mode:0o600});require('../dist/main');
}).catch(error=>{console.error(error.stack);console.error(JSON.stringify({checkFailures}));void finish(1);});
