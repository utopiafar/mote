require('./fixture-language.cjs');
/** Real central + browser, generated tokens and notes only; no personal capture or model calls. */
const {app,BrowserWindow}=require('electron');
const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');const {join,resolve}=require('node:path');
const {spawn}=require('node:child_process');const {randomBytes,randomUUID}=require('node:crypto');
const net=require('node:net');const assert=require('node:assert/strict');
const repo=resolve(__dirname,'..'),root=mkdtempSync(join(tmpdir(),'mote-login-')),output=join(repo,'.mote/web-i18n');
mkdirSync(output,{recursive:true,mode:0o700});app.setPath('userData',join(root,'browser'));app.on('window-all-closed',()=>{});
let server,window;const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const deadline=Date.now()+20000;while(Date.now()<deadline){if(await fn())return;await delay(80);}throw Error('Timed out: '+label);}
async function run(){
 await app.whenReady();
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const base='http://127.0.0.1:'+port,owner=randomBytes(32).toString('hex'),envFile=join(root,'mote.env');
 writeFileSync(envFile,`MOTE_PROFILE=test\nMOTE_HOST=127.0.0.1\nMOTE_PORT=${port}\nMOTE_DATA_DIR=./data\nMOTE_TOKEN=${owner}\n`,{mode:0o600});
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('MOTE_')));
 server=spawn('node',[join(repo,'apps/server/dist/index.js')],{env:{...env,MOTE_ENV_FILE:envFile},stdio:'ignore'});
 await until(async()=>{try{return(await fetch(base+'/api/health')).ok;}catch{return false;}},'fixture server');
 const request=(path,token,body)=>fetch(base+path,{method:body?'POST':'GET',headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const invite=await(await request('/api/connections/invitations',owner,{label:'Generated phone',serverUrl:base})).json();
 const collector=await(await request('/api/connections/redeem',null,{code:invite.invitation.code,deviceId:'fixture-phone',deviceName:'Generated phone',platform:'android'})).json();
 window=new BrowserWindow({width:1360,height:1000,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
 const wc=window.webContents,js=code=>wc.executeJavaScript(code);
 const click=async text=>until(()=>js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true;})()`),'button '+text);
 const input=async value=>js(`(()=>{const e=document.querySelector('[aria-label="管理访问令牌"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 async function shot(name){await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');writeFileSync(join(output,name+'.png'),(await wc.capturePage()).toPNG());assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'),'no horizontal overflow: '+name+' '+JSON.stringify(await js(`Array.from(document.querySelectorAll('body *')).filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>({tag:e.tagName,cls:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right})).slice(0,12)`)));}
 await window.loadURL(base);
 await until(()=>js(`!!document.querySelector('.language-selector select')`),'language selector');
 await js(`window.confirm=()=>true;const e=document.querySelector('.language-selector select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'en');e.dispatchEvent(new Event('change',{bubbles:true}));`);
 await until(()=>js(`document.documentElement.lang==='en'`).catch(()=>false),'English reload');
 assert.equal(await js(`localStorage.getItem('mote.language')`),'en');
 assert.equal(await js(`document.documentElement.dir`),'ltr');
 await shot('anonymous-english');
 await js(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({token:owner}))});location.reload();`);
 await until(()=>js(`!!document.querySelector('.archive-page,.welcome,.home-page')`).catch(()=>false),'authenticated page');
 await delay(500);
 const titles=await js(`Array.from(document.querySelectorAll('.sidebar button')).filter(e=>e.getClientRects().length).map(e=>e.textContent.trim())`);
 for(const label of titles){
  if(/sign out|log out/i.test(label)||!label)continue;
  await js(`(()=>{const b=Array.from(document.querySelectorAll('.sidebar button')).find(e=>e.textContent.trim()===${JSON.stringify(label)});b?.click()})()`);await delay(300);
  const text=await js(`document.body.innerText`);
  assert.ok(!/[\u4e00-\u9fff]/u.test(text.replaceAll('中文','').replaceAll('Generated phone','')),label+' untranslated text: '+text.match(/[\u4e00-\u9fff][^\n]*/gu));
 }
 await shot('authenticated-english');
 window.setSize(420,900);await shot('mobile-english');
 await js(`window.confirm=()=>true;const e=document.querySelector('.language-selector select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'zh-CN');e.dispatchEvent(new Event('change',{bubbles:true}));`);
 await until(()=>js(`document.documentElement.lang==='zh-CN'`).catch(()=>false),'Chinese reload');
 assert.equal(await js(`localStorage.getItem('mote.language')`),'zh-CN');
 console.log('PASS: Web Chinese/English switch and persistence, LTR, desktop/mobile layout, generated data only.');
}
async function finish(code){if(window&&!window.isDestroyed())window.destroy();if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('close',r)),delay(5000)]);}rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});app.exit(code);}
run().then(()=>finish(0),e=>{console.error(e);void finish(1);});
