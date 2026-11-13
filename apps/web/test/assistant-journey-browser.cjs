require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');
const {app,BrowserWindow}=require('electron');
const {spawn}=require('node:child_process');
const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const assert=require('node:assert/strict');

const repo=resolve(__dirname,'../../..'),temp=mkdtempSync(join(tmpdir(),'mote-q2-ui-'));
const output=join(repo,'.mote/pa-q2-ui');mkdirSync(output,{recursive:true});
app.setPath('userData',join(temp,'browser'));app.on('window-all-closed',()=>{});
 let server,window;const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={passed:false,generatedOnly:true,hidden:true,actualBuiltWeb:true,actualCentralHttp:true,controlledModel:true,checks:[]};
async function run(){
 await app.whenReady();
 server=spawn(process.env.MOTE_UI_NODE||'node',['--import','tsx','apps/web/test/assistant-journey-server.ts',temp],{cwd:repo,env:process.env,stdio:['ignore','pipe','pipe']});
 const fixture=await new Promise((resolve,reject)=>{
  let out='',err='';const timer=setTimeout(()=>reject(Error('Generated UI Central did not start: '+err)),30000);
  server.stderr.on('data',value=>err+=value);server.stdout.on('data',value=>{out+=value;for(const line of out.split('\n'))try{const parsed=JSON.parse(line);if(parsed.generatedOnly){clearTimeout(timer);resolve(parsed);}}catch{}});
  server.once('exit',()=>{clearTimeout(timer);reject(Error('Generated UI Central exited: '+err));});
 });
 window=new BrowserWindow({width:1380,height:1000,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const wc=window.webContents,js=code=>wc.executeJavaScript(code);
 const until=async(read,label)=>{const end=Date.now()+15000;while(!await read()){assert.ok(Date.now()<end,'Timed out: '+label);await pause(50);}};
 const click=label=>until(()=>js(`(()=>{const scope=document.querySelector('[role=dialog]')??document;const target=[...scope.querySelectorAll('button,a')].find(value=>value.getClientRects().length&&(value.textContent.trim()===${JSON.stringify(label)}||value.getAttribute('aria-label')===${JSON.stringify(label)}));if(!target||target.disabled)return false;target.click();return true;})()`),label);
 const field=(selector,value)=>js(`(()=>{const target=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(target.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(target,${JSON.stringify(value)});target.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 const request=async path=>{const response=await fetch(fixture.url+path,{headers:{authorization:'Bearer '+fixture.token}});assert.ok(response.ok,path+': '+response.status);return response.json();};
 const shot=async name=>{await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true,name+' has no horizontal overflow');writeFileSync(join(output,name+'.png'),(await wc.capturePage()).toPNG());};
 const guide=async()=>{await js(`document.querySelector('.workspace-node-menu').open=true`);await click('全部功能');await until(()=>js(`Boolean(document.querySelector('[data-assistant-guide]'))`),'assistant directory');await js(`document.querySelector('[data-assistant-guide]').open=true`);};
 await window.loadURL(fixture.url+'/#/ask');await until(()=>js(`Boolean(document.querySelector('.workspace-node-menu'))`),'connection menu');await js(`document.querySelector('.workspace-node-menu').open=true`);await click('登录 Mote');
 await field('.connect-modal input[type=password]',fixture.token);await click('登录并继续');
 await until(()=>js(`Boolean(document.querySelector('textarea[aria-label="向 Mote 提问"]'))&&!document.querySelector('.connect-modal')`),'authenticated main conversation');
 await until(()=>js(`document.querySelectorAll('.conversation-turn').length===20`),'latest history page');
 await click('加载更早的对话');await until(()=>js(`document.querySelectorAll('.conversation-turn').length===21`),'older page');
 assert.equal(new Set(await js(`[...document.querySelectorAll('.conversation-turn')].map(value=>value.querySelector('.conversation-question')?.textContent??value.textContent)`)).size,21);
 report.checks.push('21 short accepted messages load through the real paged main-conversation UI');
 await click('首页');await until(()=>js(`document.body.innerText.includes('Generated browser review')`),'the actual A14 card on Home');
 await shot('generated-home');report.checks.push('the production A14 card is shown on Home');
 await guide();
 for(const [id,heading] of [['assistantMemory','记忆'],['assistantWorkbench','工作台'],['assistantMatters','事项与规则']]){
  await until(()=>js(`Boolean(document.querySelector('[data-assistant-entry="${id}"] a'))`),id+' executable directory entry');
  await js(`document.querySelector('[data-assistant-entry="${id}"] a').click()`);
  await until(()=>js(`[...document.querySelectorAll('h1,h2')].some(value=>value.textContent===${JSON.stringify(heading)})`),id+' mounted page');
  assert.equal(await js(`document.body.innerText.includes('当前服务未提供此入口')`),false,id+' has its server capabilities');
  if(id==='assistantWorkbench')for(const label of ['项目','人物','旅行','阅读']){
   await click(label);await until(()=>js(`Boolean(document.querySelector('.declarative-list,.declarative-status,.declarative-detail'))`),label+' real template consumer');
  }
  await shot(id);report.checks.push(id+' is reachable through the real directory and active capabilities');await guide();
 }
 await js(`document.querySelector('[data-assistant-entry="assistantMatters"] a').click()`);
 await until(()=>js(`Boolean(document.querySelector('a[href*="tab=routine"]'))`),'routine tab');
 await js(`document.querySelector('a[href*="tab=routine"]').click()`);
 await until(()=>js(`Boolean([...document.querySelectorAll('a')].find(value=>value.textContent.includes('Generated UI daily review')))`),'saved routine');
 await js(`[...document.querySelectorAll('a')].find(value=>value.textContent.includes('Generated UI daily review')).click()`);
 await click('暂停规则');await until(async()=>!(await request('/api/assistant/routines/'+fixture.ruleId+'?'+new URLSearchParams({scope:JSON.stringify({kind:'all'})}))).enabled,'pause reaches real rule');
 await shot('paused-rule');report.checks.push('pause updates the persisted rule through its real detail command');
 await click('问一问');await until(()=>js(`Boolean(document.querySelector('textarea[aria-label="向 Mote 提问"]'))`),'Ask return');
 await field('textarea[aria-label="向 Mote 提问"]','Generated UI prepare');await click('发送问题');
 await until(()=>js(`Boolean(document.querySelector('.assistant-draft'))`),'host-issued draft');
 await js(`document.querySelector('.assistant-draft .assistant-draft-actions button').scrollIntoView({block:'center'})`);
 await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 assert.equal(await js(`(()=>{const box=document.querySelector('.assistant-draft .assistant-draft-actions button').getBoundingClientRect();return box.top>=0&&box.bottom<innerHeight;})()`),true,'the draft start button is in the viewport');
 await js(`document.querySelector('.assistant-draft .assistant-draft-actions button').click()`);
 await until(()=>js(`Boolean(document.querySelector('.assistant-draft-status'))`),'draft acceptance');
 await until(async()=>Boolean((await request('/api/owner-questions')).items.find(value=>value.prompt==='Generated browser choice: which review option?')),'task question');
 const question=(await request('/api/owner-questions')).items.find(value=>value.prompt==='Generated browser choice: which review option?');
 assert.ok(question);assert.equal(question.state,'open');
 const conversation=await request('/api/conversations/'+fixture.conversationId);assert.equal(conversation.turnCount,22);
 assert.equal(conversation.turns.at(-1).result.draft.goal,'Generated UI review task');
 const turn=conversation.turns.at(-1),tasks=await request('/api/conversations/'+fixture.conversationId+'/messages/'+turn.id+'/assistant-tasks?'+new URLSearchParams({scope:JSON.stringify(turn.result.draft.scope)}));
 assert.equal(tasks.items.length,1);assert.equal(tasks.items[0].task.state,'needs_input');assert.equal(tasks.items[0].result,undefined);
 await js(`document.querySelector('.assistant-draft').scrollIntoView({block:'center'})`);
 await shot('accepted-draft-question');report.checks.push('clicking a host-bound draft starts one real task and persists an unanswered owner question');
 report.passed=true;writeFileSync(join(output,'result.json'),JSON.stringify(report,null,2));
 console.log('PASS: hidden generated assistant navigation, paged conversation, rule pause and draft-to-question commands. No live model or device.');
}
async function finish(code){
 if(window&&!window.isDestroyed())window.destroy();
 if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('exit',resolve)),pause(5000).then(()=>{throw Error('Generated UI Central did not close');})]);}
 rmSync(temp,{recursive:true,force:true});app.exit(code);
}
run().then(()=>finish(0),error=>{console.error(error.stack);writeFileSync(join(output,'result.json'),JSON.stringify({...report,error:error.message},null,2));void finish(1);});
