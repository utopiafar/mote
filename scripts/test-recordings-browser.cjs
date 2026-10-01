require('./fixture-language.cjs');
const {app,BrowserWindow}=require('electron');const {spawn}=require('node:child_process');const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=require('node:fs');const {join,resolve}=require('node:path');const {tmpdir}=require('node:os');const assert=require('node:assert/strict');
const directory=mkdtempSync(join(tmpdir(),'mote-recording-browser-')),repo=resolve(__dirname,'..'),out=join(repo,'.mote/recordings');mkdirSync(out,{recursive:true});app.setPath('userData',join(directory,'browser'));app.on('window-all-closed',()=>{});
let child,window;const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function run(){await app.whenReady();
 const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('MOTE_'))delete env[key];
 child=spawn(process.env.MOTE_FIXTURE_NODE||'node',['--import','tsx','scripts/recordings-browser-fixture.ts',directory],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
 const fixture=await new Promise((resolve,reject)=>{let text='',errors='';child.stderr.on('data',b=>errors+=b);child.stdout.on('data',b=>{text+=b;for(const line of text.split('\n'))try{const v=JSON.parse(line);if(v.generatedOnly)resolve(v);}catch{}});child.on('exit',()=>reject(Error('Fixture exited: '+errors)));});
 const endpoint='http://127.0.0.1:'+fixture.server.port,errors=[],requests=[];
 window=new BrowserWindow({width:1360,height:1000,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});const wc=window.webContents,js=code=>wc.executeJavaScript(code);
 wc.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message);});wc.session.webRequest.onBeforeRequest({urls:[endpoint+'/api/*']},(d,done)=>{requests.push(new URL(d.url).pathname);done({});});
 const until=async(fn,label)=>{const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await delay(20);}writeFileSync(join(out,'failure.json'),JSON.stringify({label,errors,body:await js('document.body.innerText')},null,2));throw Error('Timed out: '+label);};
 const click=async text=>until(()=>js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true})()`),text);
 await window.loadURL(endpoint+'/__fixture-bootstrap');await js(`localStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({url:'',token:fixture.token}))});true`);await window.loadURL(endpoint+'/#/connections/recordings');
 await until(()=>js(`!!document.querySelector('.lark-settings .lark-step')`),'recording plugin page');await click('连接已授权账号');
 await until(()=>js(`!!document.querySelector('.lark-step input[type=checkbox]')`),'connected selection');assert.equal(requests.some(p=>p.endsWith('/content')),false,'opening settings must not fetch audio');
 await js(`document.querySelector('.lark-step input[type=checkbox]').click()`);await click('保存并开始同步');await until(()=>js(`document.querySelector('.lark-step [role=status]')?.textContent.includes('已归档转写 1 条，音频 1 条')`),'background text and media intake');
 await until(()=>js(`!!document.querySelector('.source-item .text-button')`),'recent archive');assert.equal(requests.some(p=>p.endsWith('/content')),false,'background backup is separate from browser audio reads');
 await js(`[...document.querySelectorAll('summary')].find(s=>s.textContent==='最近归档的录音').click()`);await click('回听原始录音');await until(()=>js(`document.querySelector('audio')?.readyState>=2`),'archived audio decoder');const duration=await js('document.querySelector("audio").duration');assert.equal(duration,1);
 assert.ok(requests.some(p=>p.startsWith('/api/archived-files/')&&p.endsWith('/content')));window.setSize(430,1000);await delay(150);assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'),'mobile layout');writeFileSync(join(out,'mobile.png'),(await wc.capturePage()).toPNG());
 assert.deepEqual(errors,[]);const result={passed:true,generatedOnly:true,modelCalls:0,physicalDeviceTested:false,audioDuration:duration,lazyBrowserAudio:true,mobileWidth:430};writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
async function finish(code){if(window&&!window.isDestroyed())window.destroy();if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(5000)]);}rmSync(directory,{recursive:true,force:true});app.exit(code);}
run().then(()=>finish(0)).catch(error=>{console.error(error);finish(1);});
