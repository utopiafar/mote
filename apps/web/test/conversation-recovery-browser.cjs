require('../../../scripts/fixture-background.cjs');require('../../../scripts/fixture-language.cjs');
const{app,BrowserWindow,nativeTheme}=require('electron'),{spawn,execFileSync}=require('node:child_process'),{mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync}=require('node:fs'),{join,resolve}=require('node:path'),{tmpdir}=require('node:os'),assert=require('node:assert/strict');
const {pageHash}=require('@mote/shared');
const repo=resolve(__dirname,'../../..'),temp=mkdtempSync(join(tmpdir(),'mote-query-recovery-')),out=join(repo,'.mote/web-query-recovery');mkdirSync(out,{recursive:true});app.setPath('userData',join(temp,'browser'));nativeTheme.themeSource='light';app.on('window-all-closed',()=>{});let server,window;const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),report={passed:false,revision:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),generatedOnly:true,actualCentralHttp:true,actualResponseDroppingProxy:true,liveModelCalls:0,screenshots:[],checks:[]};
async function run(){await app.whenReady();server=spawn(process.env.MOTE_UI_NODE||'/opt/homebrew/bin/node',['--import','tsx','apps/web/test/conversation-final-server.ts',temp],{cwd:repo,env:{...process.env,MOTE_CONVERSATION_RECOVERY:'1'},stdio:['ignore','pipe','pipe']});const f=await new Promise((resolve,reject)=>{let out='',err='';const timer=setTimeout(()=>reject(Error(err)),20000);server.stderr.on('data',v=>err+=v);server.stdout.on('data',v=>{out+=v;for(const line of out.split('\n'))try{const x=JSON.parse(line);if(x.generatedOnly){clearTimeout(timer);resolve(x);}}catch{}});server.once('exit',()=>reject(Error(err)));});window=new BrowserWindow({width:1440,height:1000,show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});const wc=window.webContents,js=s=>wc.executeJavaScript(s),until=async(fn,label)=>{const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await pause(40);}throw Error('Timed out '+label);},click=label=>until(()=>js(`(()=>{const scope=document.querySelector('[role=dialog]')??document;const b=[...scope.querySelectorAll('button,a,summary')].find(x=>x.getClientRects().length&&(x.textContent.trim()===${JSON.stringify(label)}||x.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b||b.disabled)return false;b.click();return true;})()`),'click '+label),field=async(selector,value)=>{await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await pause(30);},draft=()=>js(`document.querySelector('textarea[aria-label="向 Mote 提问"]').value`),snap=async(name,width)=>{if(width)window.setContentSize(width,width===390?844:1000);await pause(100);assert.equal(await js('document.documentElement.scrollWidth>innerWidth'),false);writeFileSync(join(out,name+'.png'),(await wc.capturePage()).toPNG());report.screenshots.push({name,route:await js('location.hash')});},marker=(name,value='true')=>writeFileSync(join(temp,name),value),remove=name=>rmSync(join(temp,name),{force:true}),trace=()=>readFileSync(join(temp,'admission-trace'),'utf8').trim().split('\n').map(JSON.parse),http=async path=>{const response=await fetch(f.centralUrl+path,{headers:{authorization:'Bearer '+f.token}});assert.ok(response.ok);return response.json();};
wc.debugger.attach('1.3');const upload=async name=>{const path=join(temp,name);writeFileSync(path,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6aCsAAAAASUVORK5CYII=','base64'));const doc=await wc.debugger.sendCommand('DOM.getDocument'),node=await wc.debugger.sendCommand('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'.ask-form input[type=file]'});await wc.debugger.sendCommand('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[path]});await until(()=>js(`[...document.querySelectorAll('.chat-attachment:not(.chat-image-upload)')].some(node=>node.textContent.includes(${JSON.stringify(name)}))`),'real image '+name);};
  const composer='.ask-form textarea';
  const ask=pageHash('chat'), library=pageHash('library');
  const route=hash=>js('location.hash='+JSON.stringify(hash));
  const settle=(question,state='completed')=>until(()=>js(
    'Array.from(document.querySelectorAll('+JSON.stringify('.conversation-turn[data-state="'+state+'"] .asked-question')+
    ')).some(node=>node.firstChild.textContent==='+JSON.stringify(question)+')'),state+' turn for '+question);
  const retainedImage=name=>js('document.querySelector(".chat-attachment-list")?.textContent.includes('+JSON.stringify(name)+')');
  const unknown=()=>js('Boolean(document.querySelector(".chat-error[role=alert] button"))');
  async function leaveAndReturn(){
    await route(library);
    await until(()=>js('!document.querySelector(".chat-page")'),'chat unmounted');
    await route(ask);
    await until(()=>js('Boolean(document.querySelector(".chat-page[aria-busy=false] .ask-form textarea"))'),'main chat remounted');
  }

  await window.loadURL(f.url+'/'+ask);
  await click('登录 Mote');await field('.connect-modal input[type=password]',f.token);await click('登录并继续');
  await until(()=>js('Boolean(document.querySelector(".chat-page[aria-busy=false] .ask-form textarea"))'),'main chat authenticated');
  const {id:conversationId}=await http('/api/conversations/main');
  const path='/api/conversations/'+conversationId;
  const snapshot=()=>http(path);
  assert.equal((await snapshot()).turnCount,0);

  const question='Generated question intentionally repeated';
  await field(composer,question);
  await upload('original-request.png');
  marker('drop-query-acks','2');
  await click('发送');
  await until(unknown,'both real admissions lost their acknowledgement');
  const attempts=trace();
  assert.equal(attempts.length,2);
  const original=attempts[0];
  assert.deepEqual(attempts[1],original);
  assert.equal(original.conversationId,conversationId);
  assert.equal((await snapshot()).turnCount,1);
  assert.equal(await js('document.querySelector(".send-button").disabled'),true);
  await snap('double-ack-loss-unknown');
  await snap('double-ack-loss-unknown-light-narrow',390);
  nativeTheme.themeSource='dark';
  await snap('double-ack-loss-unknown-dark-narrow');
  nativeTheme.themeSource='light';window.setContentSize(1440,1000);

  const later='Generated later question remains';
  await field(composer,later);
  await click('移除图片 original-request.png');
  await upload('later-unsent.png');
  await leaveAndReturn();
  await until(unknown,'unknown admission restored after navigation');
  assert.equal(await draft(),later);
  assert.ok(await retainedImage('later-unsent.png'));
  assert.equal(trace().length,2);
  await snap('unknown-after-workspace-reconstruction');
  await click('重试');
  await until(()=>js('!document.querySelector(".chat-error[role=alert]")'),'same request recovers');
  await settle(question);
  assert.deepEqual(trace(),[original,original,original]);
  assert.equal(await draft(),later);
  assert.ok(await retainedImage('later-unsent.png'));
  const first=await snapshot();
  assert.equal(first.turnCount,1);
  assert.equal(first.turns[0].question,question);
  assert.equal(first.turns[0].attachments[0].id,original.attachmentIds[0]);
  await snap('same-id-recovery-keeps-later-draft-and-image');

  for(let count=2;count<=3;count++){
    await field(composer,question);
    await click('发送');
    await until(()=>js('document.querySelectorAll(".conversation-turn[data-state=completed]").length==='+count),'repeated question '+count);
  }
  assert.deepEqual(await js('Array.from(document.querySelectorAll(".chat-thread .asked-question"), node=>({text:node.firstChild.textContent,visible:node.getClientRects().length>0}))'),
    Array.from({length:3},()=>({text:question,visible:true})));
  await snap('repeated-questions-visible');
  const unsent='Generated chat draft beside saved addition';
  await field(composer,unsent);
  await click('更多');
  await click('保存为记录');
  assert.equal(await js('document.querySelector("[role=dialog]").getAttribute("aria-label")'),'保存为记录');
  assert.ok(await js('document.querySelector(".conversation-save-origin blockquote")?.textContent.includes('+JSON.stringify(question)+')'));
  assert.ok(await js('Boolean(document.querySelector(".conversation-save-origin").compareDocumentPosition(document.querySelector(".conversation-save form > label")) & Node.DOCUMENT_POSITION_FOLLOWING)'));
  const addition='Generated owner independent addition';
  await field('[role=dialog] .conversation-save textarea',addition);
  await snap('save-quoted-original-initially-visible');
  await click('取消');
  await click('保存为记录');
  assert.equal(await js('document.querySelector("[role=dialog] .conversation-save textarea").value'),addition);
  await click('取消');
  assert.equal(await draft(),unsent);

  const held='Generated accepted message with hidden receipt';
  marker('hold-query');
  await field(composer,held);
  await click('发送');
  await settle(held,'running');
  const accepted=(await snapshot()).turns.at(-1);
  assert.equal(accepted.question,held);
  assert.equal(accepted.status,'running');
  marker('hide-message-receipt');
  await until(()=>existsSync(join(temp,'message-receipt-hidden')),'proxy served a receipt 404');
  await until(unknown,'running receipt read failure');
  const beforeCheck=trace().length;
  await snap('running-receipt-404');
  await leaveAndReturn();
  await settle(held,'running');
  await until(unknown,'read failure after remount');
  const retained='Generated draft after missing receipt';
  await field(composer,retained);
  remove('hide-message-receipt');
  await click('重试');
  remove('hold-query');
  await settle(held);
  assert.equal((await snapshot()).turns.at(-1).id,accepted.id);
  assert.equal(trace().length,beforeCheck);
  assert.equal(await draft(),retained);

  const stop='Generated stop with late acknowledgement';
  marker('hold-query');marker('hold-cancel-ack');
  await field(composer,stop);
  await click('发送');
  await settle(stop,'running');
  const stopping=(await snapshot()).turns.at(-1);
  await click('停止这条回答');
  await until(()=>existsSync(join(temp,'cancel-accepted')),'server cancelled while proxy holds its acknowledgement');
  await leaveAndReturn();
  await settle(stop,'cancelled');
  const afterStop='Generated draft after stop workspace return';
  await field(composer,afterStop);
  remove('hold-cancel-ack');remove('hold-query');
  const cancelled=(await snapshot()).turns.at(-1);
  assert.equal(cancelled.id,stopping.id);
  assert.equal(cancelled.status,'cancelled');
  assert.equal(cancelled.result,undefined);
  assert.equal(trace().length,beforeCheck+1);
  assert.equal(await draft(),afterStop);
  await snap('late-stop-keeps-reconstructed-draft');

  report.passed=true;
  report.controlledAgentCalls=Number(readFileSync(join(temp,'controlled-agent-count'),'utf8'));
  report.checks=['Two actual admission responses dropped; identical main-message retry admits one stored turn',
    'Navigation and retry preserve the later draft and attachment without changing the original payload',
    'Three repeated questions stay visible; saved quote and independent addition survive cancel/reopen',
    'Message receipt 404 keeps the original running turn across navigation; read retry sends no new admission',
    'Cancellation persists while the proxy holds the response; returning to the chat preserves the later draft'];
  console.log(JSON.stringify({passed:true,screenshots:report.screenshots.length,liveModelCalls:0}));
}
async function finish(code){window?.destroy();if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('exit',resolve)),pause(5000)]);if(server.exitCode===null)server.kill('SIGKILL');}if(existsSync(join(temp,'admission-trace')))report.admissionTrace=readFileSync(join(temp,'admission-trace'),'utf8').trim().split('\n').map(JSON.parse);if(existsSync(join(temp,'drop-query-acks')))report.acksRemaining=Number(readFileSync(join(temp,'drop-query-acks'),'utf8'));rmSync(temp,{recursive:true,force:true});report.cleanup={temporaryRemoved:!existsSync(temp),serverStopped:!server||server.exitCode!==null||server.signalCode!==null};writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));app.exit(code);}
run().then(()=>finish(0)).catch(async e=>{report.error=String(e);console.error(e);if(window){writeFileSync(join(out,'failure.png'),(await window.webContents.capturePage()).toPNG());writeFileSync(join(out,'failure.txt'),await window.webContents.executeJavaScript('document.body.innerText').catch(()=>''));}await finish(1);});
