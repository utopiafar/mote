require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');
const {app,BrowserWindow}=require('electron');
const {spawn,execFileSync}=require('node:child_process');
const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=require('node:fs');
const {join,resolve}=require('node:path');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');
const repo=resolve(__dirname,'../../..'),out=join(repo,'.mote/assistant-suggestion-scope-ui'),directory=mkdtempSync(join(tmpdir(),'mote-suggestion-scope-ui-'));
mkdirSync(out,{recursive:true});app.setPath('userData',join(directory,'browser'));app.on('window-all-closed',()=>{});
let server,window;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={head:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),tree:execFileSync('git',['write-tree'],{cwd:repo,encoding:'utf8'}).trim(),generatedOnly:true,hidden:true,realProduct:true,realHttp:true,liveModel:false,physicalDevice:false,libraryRecords:1003,unrelatedMaterialBlocks:1002,screenshots:[],checks:[]};
async function run(){
 await app.whenReady();const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('MOTE_'))delete env[key];
 server=spawn(process.env.MOTE_FIXTURE_NODE||'node',['--import','tsx','apps/web/test/assistant-suggestion-scope-server.ts',directory],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
 const fixture=await new Promise((done,reject)=>{let output='',errors='';const timer=setTimeout(()=>reject(Error('Generated server startup timed out: '+errors.slice(-1500))),30000);server.stderr.on('data',chunk=>errors+=chunk);server.stdout.on('data',chunk=>{output+=chunk;for(const line of output.split('\n'))try{const value=JSON.parse(line);if(value.generatedOnly){clearTimeout(timer);done(value);}}catch{}});server.once('exit',()=>{clearTimeout(timer);reject(Error('Generated server exited: '+errors.slice(-1500)));});});
 const base='http://127.0.0.1:'+fixture.server.port,starts=[];
 window=new BrowserWindow({width:1380,height:1000,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const wc=window.webContents,js=code=>wc.executeJavaScript(code);
 wc.session.webRequest.onBeforeRequest({urls:[base+'/api/assistant/tasks']},(details,done)=>{if(details.method==='POST'){const body=Buffer.concat((details.uploadData??[]).map(item=>item.bytes??Buffer.alloc(0))).toString();starts.push(JSON.parse(body));}done({});});
 const until=async(fn,label)=>{const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await pause(40);}throw Error('Timed out: '+label);};
 const click=async(selector)=>{await until(()=>js(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});return !!b&&!b.disabled})()`),selector);await js(`document.querySelector(${JSON.stringify(selector)}).click()`);};
 const text=async(label,root='document')=>{await until(()=>js(`!![...${root}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`),label);await js(`[...${root}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled).click()`);};
 const field=async(selector,value,type='HTMLInputElement')=>{await js(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});b.focus();Object.getOwnPropertyDescriptor(${type}.prototype,'value').set.call(b,${JSON.stringify(value)});b.dispatchEvent(new Event('input',{bubbles:true}));})()`);};
 const shot=async(name)=>{const target='[data-card-id="'+fixture.cardId+'"]';await js(`document.querySelector(${JSON.stringify(target)}).scrollIntoView({block:'start'})`);await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');assert.equal(await js('document.documentElement.scrollWidth>innerWidth'),false,'no horizontal overflow');const file=name+'.png';writeFileSync(join(out,file),(await wc.capturePage()).toPNG());report.screenshots.push(file);};
 await window.loadURL(base+'/#/today');await text('登录 Mote');await until(()=>js(`!!document.querySelector('.connect-modal input[type=password]')`),'owner login');await field('.connect-modal input[type=password]',fixture.token);await text('登录并继续');
 await until(()=>js(`!!document.querySelector('[data-card-id="${fixture.cardId}"] [data-task-scope]')`),'actual suggestion scope');
 const root=`document.querySelector('[data-card-id="${fixture.cardId}"]')`;
 assert.ok(await js(`${root}.querySelector('[data-task-scope]').textContent.includes('仅使用此建议的完整证据与原始依赖')`));
 await click('[data-task-scope] summary');
 const preview=await js(`${root}.querySelector('[data-task-scope]').textContent`);for(let index=0;index<2;index++){assert.match(preview,new RegExp('Generated selected document '+index));assert.match(preview,new RegExp('Generated selected source '+index));}assert.doesNotMatch(preview,/unrelated/);
 await shot('scope-wide');window.setSize(390,844);await shot('scope-phone');window.setSize(1380,1000);
 await text('编辑',root);const goal='Generated UI owner edited goal: produce a result only inside Mote; do not contact anyone or create external tasks.';await field('[data-card-id="'+fixture.cardId+'"] textarea',goal,'HTMLTextAreaElement');
 await js(`(()=>{const b=[...${root}.querySelectorAll('button')].find(b=>b.textContent.trim()==='开始');b.click();b.click();})()`);
 await until(()=>js(`document.querySelector('.home-assistant-task')?.textContent.includes('Generated bounded task result')`),'grounded task result');
 assert.equal(starts.length,1);assert.equal(starts[0].goal,goal);assert.deepEqual(starts[0].scope,{kind:'selection',evidenceIds:fixture.ids});assert.equal(starts[0].cardId,fixture.cardId);assert.equal(starts[0].expectedRevision,1);
 assert.equal(await js(`document.querySelectorAll('.home-assistant-task .citation').length`),2);
 await click('.home-assistant-task .citation');await until(()=>js(`document.querySelector('.evidence-modal')?.textContent.includes('GENERATED_UI_ALLOWED_')`),'original citation back-link');
 const status=await (await fetch(base+'/__fixture/status',{headers:{Authorization:'Bearer '+fixture.token}})).json();assert.equal(status.providerCalls,2);assert.equal(status.originalsRead,true);assert.equal(status.leaked,false);assert.equal(status.tasks.length,1);assert.equal(status.tasks[0].state,'succeeded');
 report.checks.push('Actual hidden Home reviews two sources, edits the goal and starts one task beside 1003 records and a 1002-block unrelated Material.','The HTTP command and real batch use the canonical evidence selection. A generated provider attempts an outside read; only selected originals reach its response.','The saved result has two original citations, and the actual citation opens the original evidence reader.');
 report.passed=true;writeFileSync(join(out,'result.json'),JSON.stringify(report,null,2));console.log('PASS: hidden generated Home bounded suggestion start, original citations and outside-read isolation.');
}
async function finish(code){
 if(window&&!window.isDestroyed())window.destroy();
 if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('exit',resolve)),pause(5000).then(()=>{throw Error('Generated fixture did not close');})]);}
 rmSync(directory,{recursive:true,force:true});app.exit(code);
}
run().then(()=>finish(0),error=>{console.error(error.stack);writeFileSync(join(out,'result.json'),JSON.stringify({...report,error:error.message},null,2));void finish(1);});
