require('./fixture-language.cjs');
/** Real renderer + isolated server; generated Coding events only, no personal capture. */
const {app,BrowserWindow}=require('electron');
const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');const {join,resolve}=require('node:path');
const {spawn}=require('node:child_process');const {randomBytes}=require('node:crypto');const net=require('node:net');const assert=require('node:assert/strict');
app.on('window-all-closed',()=>{});
const root=mkdtempSync(join(tmpdir(),'mote-feature-browser-')),repo=resolve(__dirname,'..'),output=join(repo,'.mote/feature-packs');mkdirSync(output,{recursive:true});app.setPath('userData',join(root,'browser'));
let server,window;const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await delay(100);}throw Error('Timed out: '+label);}
async function port(){return new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
async function run(){
 await app.whenReady();const endpoint='http://127.0.0.1:'+await port(),token=randomBytes(32).toString('hex'),env={...process.env};for(const k of Object.keys(env))if(k.startsWith('MOTE_'))delete env[k];
 server=spawn('node',[join(repo,'apps/server/dist/index.js')],{cwd:repo,env:{...env,MOTE_PROFILE:'test',MOTE_HOST:'127.0.0.1',MOTE_PORT:new URL(endpoint).port,MOTE_DATA_DIR:join(root,'data'),MOTE_TOKEN:token},stdio:['ignore','ignore','pipe']});
 await until(async()=>{if(server.exitCode!==null)throw Error('Fixture server stopped');try{return(await fetch(endpoint+'/api/health')).ok;}catch{return false;}},'server');
 const request=async(path,body)=>{const r=await fetch(endpoint+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Mote-Ingress-Version':'2'},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,`${path}: ${r.status}`);return r.json();};
 await request('/api/sources',{id:'fixture-coding',name:'Generated Coding upload',kind:'coding-agent',deviceId:'fixture-device',platform:'macos'});
 const event=i=>({externalId:'event-'+i,revision:'1',observedAt:new Date(Date.now()+i).toISOString(),kind:'message',layer:'original',text:'Generated transcript '+i+': test the everyday plugin flow.',document:{contentRole:'transcript',coding:{version:1,provider:'codex',projectKey:'generated-project',sessionId:'generated-session',eventId:'event-'+i,role:i?'assistant':'user',part:0,parts:1}}});
 await request('/api/sources/fixture-coding/items/batch',{items:[event(0),event(1),event(2)]});
 await until(async()=>(await request('/api/materials')).items.length===1,'published transcript');
 window=new BrowserWindow({width:1360,height:1000,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false}});const wc=window.webContents,errors=[];wc.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message);});const js=code=>wc.executeJavaScript(code);
 await window.loadURL(endpoint);await js(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({url:'',token}))});location.reload()`);
 const route=async(path,selector)=>{await js(`location.hash=${JSON.stringify('#/'+path)}`);await until(()=>js(`!!document.querySelector(${JSON.stringify(selector)})`),path);};
 const click=async label=>{await until(()=>js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&b.textContent.trim()===${JSON.stringify(label)});if(!b)return false;b.click();return true})()`),label);};
 await request('/api/captures',{id:require('node:crypto').randomUUID(),deviceId:'fixture-activity',deviceName:'Generated',platform:'macos',source:'activity',capturedAt:new Date().toISOString(),durationMs:60000,appId:'generated.activity',appName:'Generated Activity Browser',privacy:{excluded:false,redacted:false,mode:'none',collection:'activity'}});
 await route('library','.segmented-nav');await click('应用活动');await until(()=>js(`document.querySelector('.activity-panel')?.textContent.includes('Generated Activity Browser')`),'library activity fetch without overview');
 await route('library/coding','.coding-uploads');await until(()=>js(`document.querySelector('.coding-uploads').textContent.includes('Generated Coding upload')`),'upload counts');
 assert.match(await js(`document.querySelector('.coding-uploads').textContent`),/已接收事件3/);
 await click('查看聚合正文');await until(()=>js(`!!document.querySelector('.materials-browser .source-item')`),'material card');await js(`document.querySelector('.materials-browser .source-item').click()`);
 await until(()=>js(`document.querySelector('.material-detail')?.textContent.includes('Generated transcript 2')`),'actual published body');
 writeFileSync(join(output,'coding-desktop.png'),(await wc.capturePage()).toPNG());
 await route('system/agent','.agent-inspector');await until(()=>js(`document.querySelector('.agent-inspector').textContent.includes('/context/memory')`),'model directory');
 await click('正式资料');await until(()=>js(`!!document.querySelector('.agent-inspector .source-item')`),'Agent materials');await js(`document.querySelector('.agent-inspector .source-item').click()`);await until(()=>js(`document.querySelector('.material-detail')?.textContent.includes('Generated transcript 2')`),'Agent read');
 await click('实际输入与读取轨迹');await until(()=>js(`document.querySelector('.agent-inspector').textContent.includes('输入追踪未开启')`),'honest unavailable input');
 await click('可访问范围');window.setSize(430,1000);await delay(200);assert.ok(await js('document.documentElement.scrollWidth<=window.innerWidth'),'mobile directory fits');writeFileSync(join(output,'agent-mobile.png'),(await wc.capturePage()).toPNG());window.setSize(1360,1000);
 await route('system/extensions','.feature-inventory');await until(()=>js(`document.querySelector('.feature-inventory')?.textContent.includes('mote.coding')`),'inventory');await js(`document.querySelectorAll('.feature-inventory details').forEach(d=>d.open=true)`);assert.match(await js(`document.querySelector('.feature-inventory').textContent`),/http:POST:\/api\/sources\/:id\/items\/batch/);
 // Every contributed page must load without a thrown renderer error.
 for(const path of ['today','library','library/materials','library/segments','library/files','library/notes','library/memories','library/insights','library/import','ask','actions','connections','connections/devices','connections/access','connections/lark','system','system/processing','system/models','system/usage','system/storage','system/diagnostics','preferences','help']){await js(`location.hash=${JSON.stringify('#/'+path)}`);await delay(150);assert.equal(await js(`document.body.textContent.includes('专用视图暂不可用')`),false,path);}
 assert.deepEqual(errors,[]);
 // A transient capability fetch failure must expose a retry, not permanently hide the page.
 let failedCapability=false;wc.session.webRequest.onBeforeRequest({urls:[endpoint+'/api/features']},(_details,callback)=>{if(!failedCapability){failedCapability=true;callback({cancel:true});}else callback({});});
 await window.loadURL(endpoint+'/#/library/coding');await until(()=>js(`!!document.querySelector('.notice.error button')`),'capability retry');
 await js(`document.querySelector('.notice.error button').click()`);await until(()=>js(`document.querySelector('.coding-uploads')?.textContent.includes('Generated Coding upload')`),'capability retry recovery');
 wc.session.webRequest.onBeforeRequest(null);
writeFileSync(join(output,'result.json'),JSON.stringify({passed:true,generatedOnly:true,codingEvents:3,pages:26,checks:['upload counts','assembled body','Agent permissions','honest missing traces','registered capabilities','all pages','mobile layout','library activity fetch','capability error retry']},null,2));console.log('PASS: feature packs, Coding upload, model directory and 26 browser pages with generated fixtures.');
}
async function finish(code){if(window&&!window.isDestroyed())window.destroy();if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('exit',r)),delay(5000)]);}rmSync(root,{recursive:true,force:true});app.exit(code);}
run().then(()=>finish(0)).catch(error=>{console.error(error);finish(1);});
