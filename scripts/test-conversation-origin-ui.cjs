require('./fixture-background.cjs');
require('./fixture-language.cjs');
const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const {join}=require('node:path');const {tmpdir}=require('node:os');const {randomUUID}=require('node:crypto');const assert=require('node:assert/strict');
const f=JSON.parse(fs.readFileSync(process.env.MOTE_J5_CONNECTION,'utf8')),out=process.env.MOTE_J5_OUTPUT;fs.mkdirSync(out,{recursive:true});const profile=fs.mkdtempSync(join(tmpdir(),'mote-j5-ui-'));app.setPath('userData',profile);app.on('window-all-closed',()=>{});let win;const headers={authorization:'Bearer '+f.token,'content-type':'application/json'};
const request=async(path,body)=>{const r=await fetch(f.url+path,{headers,method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,path+' HTTP'+r.status);return r.json();};const notes=()=>request('/api/notes');const delay=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,label)=>{const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await delay(60);}throw Error('Timed out '+label);};
async function run(){await app.whenReady();win=new BrowserWindow({show:false,width:1320,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});const wc=win.webContents,js=c=>wc.executeJavaScript(c);
const click=label=>until(()=>js(`(()=>{const b=[...document.querySelectorAll('button,summary')].find(b=>b.getClientRects().length&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b||b.disabled)return false;b.click();return true})()`),'button '+label);
const session=await request('/api/login/session',{serverUrl:f.url,deviceId:randomUUID(),deviceName:'Generated J5 browser',platform:'other',durationMs:0});await win.loadURL(f.url);await js(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({token:session.token,viewScope:randomUUID()}))});location.reload()`);await until(()=>js(`document.querySelector('[data-session=ready]')`),'ready');
assert.equal((await request('/api/conversations/main')).id,f.conversationId);
const originRoute='#/chat?'+new URLSearchParams({conversation:f.conversationId,turn:f.messageId});
await js(`location.hash=${JSON.stringify(originRoute)}`);
await until(()=>js(`document.querySelector('[data-source-turn=true]')?.id===${JSON.stringify('conversation-turn-'+f.messageId)}`),'older saved source turn in main');
const oldNotes=(await notes()).items;const count=oldNotes.length;const before=await request('/api/conversations/'+f.conversationId);assert.equal((await notes()).items.length,count);assert.equal(await js(`document.querySelectorAll('[data-source-turn=true] .chat-answer .citation').length`),1);
await js(`document.querySelector('[data-source-turn=true] .chat-answer .citation').click()`);await until(()=>js(`document.querySelector('[role=dialog]')?.innerText.includes(${JSON.stringify(f.sourceText)})`),'actual cited original');await click('关闭证据详情');
const openSave=async()=>{
 await js("document.querySelector('[data-source-turn=true] .chat-answer-more').open=true");
 await click('保存为记录');
};
const preview=()=>js(`document.querySelector('[role=dialog] .conversation-save-origin').innerText`);
await openSave();assert.ok((await preview()).includes(f.question));assert.ok((await preview()).includes(f.answer.replace(' [1]','')));assert.equal((await notes()).items.length,count,'opening review does not save');
const comment='My generated comment '+randomUUID()+': I have not adopted the AI suggestion; ask Alex first.';
const fill=()=>js(`(()=>{const e=document.querySelector('[role=dialog] .conversation-save form>label textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(comment)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await fill();await click('取消');assert.equal((await notes()).items.length,count,'cancel does not save');await openSave();assert.equal(await js(`document.querySelector('[role=dialog] .conversation-save form>label textarea').value`),comment,'cancel and reopen retains comment');
await request('/fixture/fail-note',{});await click('保存');await until(()=>js(`document.querySelector('[role=dialog] .conversation-save [role=alert]')`),'controlled failure');assert.equal((await notes()).items.length,count);assert.equal(await js(`document.querySelector('[role=dialog] .conversation-save form>label textarea').value`),comment);assert.ok((await preview()).includes(f.question)&& (await preview()).includes(f.answer.replace(' [1]','')));
fs.writeFileSync(join(out,'retry-preserves-review.png'),(await wc.capturePage()).toPNG());
await js(`(()=>{const form=document.querySelector('[role=dialog] .conversation-save form');form.requestSubmit();form.requestSubmit();})()`);await until(()=>js(`[...document.querySelectorAll('button')].some(b=>b.textContent==='查看已保存记录')`),'saved');const saved=(await notes()).items.filter(n=>!oldNotes.some(old=>old.id===n.id));assert.equal(saved.length,1,'one explicit save after retry');const note=saved[0];assert.equal(note.ocrText,comment);assert.deepEqual(note.metadata.noteOrigin,{kind:'conversation',text:f.question+'\n\n'+f.answer,conversationId:f.conversationId,messageIds:[f.messageId]});
assert.deepEqual(await request('/api/conversations/'+f.conversationId),before,'saving note does not mutate source conversation');
await click('查看已保存记录');await until(()=>js(`document.querySelector('[role=dialog] .note-origin')`),'saved original reader');assert.equal(await js(`document.querySelector('[role=dialog] .note-origin h3').textContent`),'引用原文');await until(()=>js(`document.querySelector('[role=dialog] .note-origin a')`),'origin resolved');assert.equal(await js(`document.querySelector('[role=dialog] .note-origin pre').textContent`),f.question);
assert.ok((await js(`document.querySelector('[role=dialog] .quoted-answer-markdown').innerText`)).includes(f.answer.replace(' [1]','')));assert.ok(await js(`document.querySelector('[role=dialog]').innerText.includes('我的补充')&&document.querySelector('[role=dialog]').innerText.includes(${JSON.stringify(comment)})`));
const controls=await js(`[...document.querySelector('[role=dialog]').querySelectorAll('a,button')].map(e=>({text:e.textContent,href:e.getAttribute('href'),label:e.getAttribute('aria-label')}))`);const sourceLinks=controls.filter(c=>(c.href||'').includes('conversation=')||(c.href||'').includes(f.sourceId)||(c.text||'').match(/回到.*对话|查看.*对话|原始对话/));
const originText=await js(`document.querySelector('[role=dialog] .note-origin').innerText`);fs.writeFileSync(join(out,'saved-note.png'),(await wc.capturePage()).toPNG());
assert.ok(sourceLinks.length,'saved record must expose exact source conversation');
assert.deepEqual(await js(`[...document.querySelectorAll('.note-origin h4')].map(e=>e.textContent)`),['用户问题','AI 回答']);
const originHref=await js(`document.querySelector('.note-origin a').getAttribute('href')`);assert.equal(originHref,originRoute);
await js(`document.querySelector('.note-origin nav button').click()`);await until(()=>js(`document.querySelector('[role=dialog]')?.innerText.includes(${JSON.stringify(f.sourceText)})`),'saved quote opens actual original');
await click('关闭证据详情');
// Reopen the saved capture independently of the chat after a renderer reload.
const recordRoute='#/library?'+new URLSearchParams({view:'materials',selected:'capture:'+note.id});
const openRecord=()=>js(`location.hash=${JSON.stringify(recordRoute)}`);
await openRecord();
await until(()=>js(`document.querySelector('.library-detail .note-origin a')`),'saved note through Library');
wc.reload();
await until(()=>js(`document.querySelector('.note-origin a')`),'source link after refresh');await js(`document.querySelector('.note-origin a').click()`);
await until(()=>js(`document.querySelector('[data-source-turn=true]')?.id===${JSON.stringify('conversation-turn-'+f.messageId)}`),'exact source turn targeted');
assert.ok(await js(`document.querySelector('[data-source-turn=true]').innerText.includes(${JSON.stringify(f.answer.replace(' [1]',''))})`));
await wc.reload();await until(()=>js(`document.querySelector('[data-source-turn=true]')?.id===${JSON.stringify('conversation-turn-'+f.messageId)}`),'source turn survives reload');
await js(`document.querySelector('[data-source-turn=true] .chat-answer .citation').click()`);await until(()=>js(`document.querySelector('[role=dialog]')?.innerText.includes(${JSON.stringify(f.sourceText)})`),'returned source citation reads original');await click('关闭证据详情');
// Refuse only the source-conversation HTTP boundary. The separately authorized saved note remains readable.
await openRecord();
await until(()=>js(`document.querySelector('.note-origin a')`),'origin available before revoke');await request('/fixture/deny-origin',{});
await until(()=>js(`document.querySelector('.note-origin')?.innerText.includes('原始对话或轮次暂不可读')`),'denied source status');
assert.equal(await js(`document.querySelectorAll('.note-origin a,.note-origin nav button').length`),0,'no invented source links after denial');
assert.ok(await js(`document.querySelector('.note-origin').innerText.includes(${JSON.stringify(f.answer)})`),'authorized saved snapshot preserved');
fs.writeFileSync(join(out,'denied.png'),(await wc.capturePage()).toPNG());
console.log('PASS: saved roles, exact turn, actual original, independent records/reload and source denial; generated HTTP/SQLite, no model');}

run().then(()=>finish(0)).catch(async e=>{console.error(e);if(win){console.error(await win.webContents.executeJavaScript('document.body.innerText'));fs.writeFileSync(join(out,'failure.png'),(await win.webContents.capturePage()).toPNG());}finish(1);});function finish(code){if(win&&!win.isDestroyed())win.destroy();fs.rmSync(profile,{recursive:true,force:true});app.exit(code);}
