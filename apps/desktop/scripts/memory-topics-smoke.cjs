require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');
const {app}=require('electron');
const {mkdtempSync,writeFileSync,mkdirSync}=require('node:fs');
const {rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const assert=require('node:assert/strict');
const {defaultConfig}=require('../dist/config');
const url='http://127.0.0.1:47894',token='generated-native-topics-owner-token';
const profile=mkdtempSync(join(tmpdir(),'mote-mac-topics-'));app.setPath('userData',profile);process.env.MOTE_PROFILE='dev';
for(const key of ['MOTE_URL','MOTE_TOKEN','MOTE_ENV_FILE'])delete process.env[key];
const data=profile+'-profiles/dev';mkdirSync(data,{recursive:true,mode:0o700});
writeFileSync(join(data,'config.json'),JSON.stringify({version:4,developmentToken:token,config:{...defaultConfig(),serverUrl:url,credentialScope:'owner',syncMode:'manual',metadataEnabled:false,deviceName:'Synthetic topics Mac'}}),{mode:0o600});
writeFileSync(join(data,'storage-format.json'),JSON.stringify({version:4}),{mode:0o600});
const out=resolve(__dirname,'../.mote/topic-ui');mkdirSync(out,{recursive:true});
const post=async(path,body={})=>{const response=await fetch(url+'/api/__fixture/'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();};
const timeout=setTimeout(()=>{console.error('Mac topics timeout');app.exit(1);},120000);let main;
app.on('browser-window-created',(_event,window)=>{if(main)return;main=window;window.webContents.once('did-finish-load',()=>void(async()=>{
 const fixture=await post('reset');const js=code=>window.webContents.executeJavaScript(code);
 const wait=async(code,label)=>{const end=Date.now()+15000;while(!await js(code)){assert.ok(Date.now()<end,label);await new Promise(r=>setTimeout(r,40));}};
 const click=label=>js(`[...document.querySelectorAll('#memory-topics-dialog button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
 const tree=label=>js(`{const s=document.querySelector('#memory-topic-tree');s.value=[...s.options].find(o=>o.textContent===${JSON.stringify(label)}).value;s.dispatchEvent(new Event('change'));}`);
 const count=n=>wait(`document.querySelectorAll('#memory-topic-members [data-memory]').length===${n}`,'members '+n);
 const shot=async(name)=>writeFileSync(join(out,name+'.png'),(await window.webContents.capturePage()).toPNG());
 await wait(`Boolean(window.mote)&&!document.querySelector('#settings-fields').disabled`,'ready');
 await js(`document.querySelector('[data-nav="records"]').click();document.querySelector('#content-memories').click()`);await count(30);
 if(process.env.MOTE_TOPICS_DETAIL_REVIEW==='1'){
  const pick=async(f)=>{await click('全部记忆');await count(30);await click('下一页');await count(2);await js(`document.querySelector('[data-memory="${f.firstMemory}"]').click()`);await wait(`document.querySelector('#memory-topics-dialog').textContent.includes('查看原文依据 1')`,'detail');};
  const memoryGet=async(id)=>{const response=await fetch(url+'/api/memories/'+id,{headers:{authorization:'Bearer '+token}});assert.equal(response.status,200);return response.json();};
  const correct=async(id)=>{const row=await memoryGet(id);const response=await fetch(url+'/api/memories/'+id+'/correct',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({version:row.version,title:'Synthetic replacement',statement:'Synthetic changed statement',uncertainty:'Fixture'})});assert.equal(response.status,200);};
  await pick(fixture);await click('查看原文依据 1');await wait(`document.querySelector('#memory-topics-dialog pre')?.textContent.includes('Synthetic native topic original 0')`,'single-route original');
  await post('invalidate');await wait(`Boolean(document.querySelector('#memory-topics-dialog [role=alert]'))`,'deleted original clears');assert(!(await js(`document.querySelector('#memory-topics-dialog').textContent`)).includes('Synthetic native topic original 0'));
  for(const change of ['denied','version']){
   const f=await post('reset');await click('全部记忆');await count(30);await pick(f);
   if(change==='denied')await post('detail-mode',{mode:'denied'});else await correct(f.firstMemory);
   await wait(`!document.querySelector('#memory-topics-dialog').textContent.includes('查看原文依据 1')`,'selected '+change+' clears');
   assert(!(await js(`document.querySelector('#memory-topics-dialog').textContent`)).includes('Synthetic topic memory 0'));
  }
  await shot('detail-invalidation');console.log('PASS selected Memory delete/403/version with live directory and single-route original');clearTimeout(timeout);app.exit(0);return;
 }
 if(process.env.MOTE_TOPICS_LAYOUT_ONLY==='1'){
  window.setSize(820,620);await shot('compact-final');
  assert(await js('document.documentElement.scrollWidth<=innerWidth'));
  await post('mode',{mode:'offline'});await wait(`Boolean(document.querySelector('#memory-topics-dialog [role=alert]'))`,'offline');
  assert(!(await js(`document.querySelector('#memory-topics-dialog [role=alert]').textContent`)).includes('Error invoking remote method'));
  await shot('offline-final');await post('mode',{mode:'online'});await click('重试');await count(30);
  console.log('PASS fresh Mac process, compact layout and clean offline error');clearTimeout(timeout);app.exit(0);return;
 }
 await tree('合成项目');await wait(`Boolean(document.querySelector('[data-topic="review"]'))`,'tree one');
 await js(`document.querySelector('[data-topic="review"]').click()`);await count(1);
 assert.equal(await js(`document.querySelector('[data-memory]').dataset.memory`),fixture.firstMemory);
 await js(`document.querySelector('[data-memory]').click()`);await wait(`document.querySelector('#memory-topics-dialog').textContent.includes('查看原文依据 1')`,'memory detail');await shot('detail');
 await click('查看原文依据 1');await wait(`document.querySelector('#memory-topics-dialog pre')?.textContent.includes('Synthetic native topic original 0')`,'original');await shot('original');
 await click('返回');await wait(`document.querySelector('#memory-topics-dialog').textContent.includes('查看原文依据 1')`,'detail back');await click('返回');await count(1);
 await tree('合成实践');await wait(`Boolean(document.querySelector('[data-topic="reuse"]'))`,'tree two');await js(`document.querySelector('[data-topic="reuse"]').click()`);await count(1);assert.equal(await js(`document.querySelector('[data-memory]').dataset.memory`),fixture.firstMemory);await shot('second-tree');
 await tree('合成项目');await wait(`Boolean(document.querySelector('[data-topic="planning"]'))`,'tree paging');await js(`document.querySelector('[data-topic="planning"]').click()`);await count(30);await click('下一页');await count(2);await click('关闭详情');await js(`document.querySelector('#content-memories').click()`);await count(2);await click('上一页');await count(30);
 await post('mode',{mode:'offline'});await wait(`Boolean(document.querySelector('#memory-topics-dialog [role=alert]'))`,'offline');assert.equal(await js(`document.querySelectorAll('[data-memory]').length`),0);await shot('offline');await post('mode',{mode:'online'});await click('重试');await count(30);
 await post('mode',{mode:'denied'});await wait(`Boolean(document.querySelector('#memory-topics-dialog [role=alert]'))`,'denied');assert.equal(await js(`document.querySelectorAll('[data-topic]').length`),0);await post('mode',{mode:'online'});await click('重试');await count(30);
 await post('invalidate');await wait(`document.querySelector('#memory-topics-dialog').textContent.includes('此主题已不可用')`,'invalidated');assert.equal(await js(`document.querySelectorAll('[data-memory]').length`),0);await shot('invalidated');await click('全部记忆');await count(30);
 await post('empty');await click('刷新');await wait(`document.querySelector('#memory-topics-dialog').textContent.includes('当前筛选下没有匹配')`,'empty');await shot('empty');await click('关闭详情');
 await post('reset');await js(`location.reload()`);await wait(`Boolean(window.mote)&&!document.querySelector('#settings-fields').disabled`,'reload');await js(`document.querySelector('[data-nav="records"]').click();document.querySelector('#content-memories').click()`);await count(30);
 assert.equal((await js('window.mote.status()')).running,false);
 writeFileSync(join(out,'result.json'),JSON.stringify({passed:true,actualMacRendererPreloadIPC:true,actualCentralHTTP:true,generatedClassifier:true,liveModel:false,checks:['multi-tree same Memory','detail/original/return','32 members pagination and close/reopen','offline and 403 clearing/retry','whole-batch dependency invalidation','empty','renderer reload current authority']}));console.log('PASS native Mac topics real UI/IPC/HTTP');clearTimeout(timeout);app.exit(0);
})().catch(error=>{console.error(error);clearTimeout(timeout);app.exit(1);}));});
app.on('quit',()=>{void rm(profile,{recursive:true,force:true});void rm(profile+'-profiles',{recursive:true,force:true});});
require('../dist/main');
