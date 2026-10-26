require('../../../scripts/fixture-background.cjs');
const {app,BrowserWindow}=require('electron');
const {mkdtempSync,rmSync,mkdirSync,writeFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const assert=require('node:assert/strict');
const root=mkdtempSync(join(tmpdir(),'mote-calendar-browser-')),repo=resolve(__dirname,'../../..');
app.setPath('userData',join(root,'browser'));app.on('window-all-closed',()=>{});
const id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',evidenceId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const plugin={packageId:'fixture.calendar',releaseDigest:'a'.repeat(64),instanceId:'fixture-instance',instanceRevision:1,capabilityDigest:'b'.repeat(64)};
let inventory={providers:[],declarations:[],sources:[],drafts:[],grants:[]},actions=[],writes=[],failSave=false,failRead=false;
let server,window;const errors=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function js(code){return window.webContents.executeJavaScript(code);}
async function until(code,label){const end=Date.now()+12000;while(Date.now()<end){if(await js(code))return;await pause(35);}throw Error('Timed out: '+label);}
async function click(text){await js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)});if(!b||b.disabled)throw Error('Missing enabled button');b.click();})()`);}
async function openSettings(){await js("document.querySelector('.action-settings:has(summary)').open=true");}
async function refresh(){await js("[...document.querySelectorAll('button')].filter(b=>b.textContent==='刷新'&&!b.disabled).forEach(b=>b.click())");await pause(150);}
async function run(){
 await app.whenReady();const {createServer}=await import('vite'),react=(await import('@vitejs/plugin-react')).default;
 server=await createServer({root:join(repo,'apps/web'),configFile:false,plugins:[react(),{name:'generated-calendar-api',configureServer(s){s.middlewares.use(async(req,res,next)=>{
  if(!req.url.startsWith('/api/'))return next();const path=new URL(req.url,'http://generated.invalid').pathname;
  if(req.headers.authorization!=='Bearer generated-browser-fixture'){res.statusCode=401;return res.end('{}');}
  let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):undefined;
  const send=(value,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  if(path==='/api/action-capabilities')return send(failRead?{error:'Generated unavailable'}:inventory,failRead?503:200);
  if(path==='/api/action-capability-drafts'){writes.push({path,body});if(failSave)return send({error:'Generated offline'},503);const draft={...body,revision:1,state:'draft',executionEnabled:false,updatedAt:'2099-01-01T00:00:00Z'};inventory.drafts=[draft];return send(draft);}
  if(path==='/api/action-capability-grants'){writes.push({path,body});assert.equal(body.acknowledgeCalendarWrites,true);inventory.grants=[{...inventory.drafts[0],...body,revision:1,state:'active',available:true,executionEnabled:true}];actions=[{id,version:1,kind:'calendar.create',status:'approved',managed:{state:'waiting_device'},operationId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',event:{title:'Generated scoped event',start:'2099-09-18T15:00:00Z',end:'2099-09-18T16:00:00Z',timeZone:'UTC',allDay:false,location:'',description:''},evidence:[{id:evidenceId,quote:'Generated evidence',source:'Generated input'}]}];return send(inventory.grants[0]);}
  if(path.endsWith('/revoke')){inventory.grants[0].state='revoked';return send(inventory.grants[0]);}
  if(path.startsWith('/api/managed-calendar/')&&path.endsWith('/cancel')){actions[0].status='dismissed';actions[0].managed.state='cancelled';return send(actions[0]);}
  if(path.startsWith('/api/actions/by-evidence/'))return send({items:actions.map(a=>({...a,title:a.event.title})),hasMore:false});
  if(path==='/api/actions')return send({items:actions,total:actions.length,nextCursor:null,revision:1,authorizationRevision:1,settings:{enabled:true,timeZone:'UTC',reviewDeviceIds:[]},targets:[],progress:{configured:true,running:false,jobs:[],error:null}});
  if(path==='/api/devices'||path==='/api/todos')return send({items:[],nextCursor:null});
  if(path==='/api/operations/changes')return send({ids:[],cursor:0,hasMore:false,reset:false});
  return send({});
 });}}],server:{host:'127.0.0.1',port:0},logLevel:'error'});await server.listen();
 window=new BrowserWindow({width:1200,height:1100,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});window.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message);});
 const url=server.resolvedUrls.local[0]+'test/fixtures/calendar-ui.html';await window.loadURL(url);await until("document.body.textContent.includes('暂无已连接的可写日历。')",'empty inventory');assert.equal(writes.length,0);
 inventory={...inventory,providers:[{identity:plugin,name:'Generated calendar plugin'}],declarations:[{deviceId:'fixture-device',connectionActive:true,permission:'granted',revision:1,calendars:[{id:'fixture-calendar',title:'Generated calendar'}]}],sources:[{sourceId:'fixture-source',kind:'custom',deviceId:'fixture-input',platform:'import',name:'Generated input source'}]};
 await openSettings();await refresh();await until("document.querySelector('select option[value*=fixture-calendar]')",'loaded calendar');
 await js("(()=>{const s=document.querySelector('.action-settings select');s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}));[...document.querySelectorAll('label')].find(l=>l.textContent.includes('Generated input source')).querySelector('input').click();})()");
 await js("document.getElementById('fixture-navigation').click()");await js("document.getElementById('fixture-navigation').click()");await openSettings();assert.ok(await js("document.querySelector('.action-settings select').value.includes('fixture-calendar')"),'unsaved scope survives navigation return');
 failSave=true;await click('保存范围草稿');await until("document.querySelector('.action-settings [role=alert]')",'save error');assert.equal(inventory.grants.length,0);const attempted=writes.at(-1).body;
 failSave=false;await click('保存范围草稿');await until("document.body.textContent.includes('继续草稿')",'saved draft');assert.deepEqual(writes.at(-1).body,attempted,'retry retains exact operation identity');
 await window.loadURL(url);await until("document.body.textContent.includes('继续草稿')",'draft after browser restart');await openSettings();await js("[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('继续草稿')).click()");
 await js("(()=>{const s=[...document.querySelectorAll('label')].find(l=>l.textContent.startsWith('日历能力插件')).querySelector('select');s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}));})()");
 assert.ok(await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='确认范围授权').disabled"),'explicit acknowledgement required');
 await js("[...document.querySelectorAll('label')].find(l=>l.textContent.includes('我允许此插件')).querySelector('input').click()");await click('确认范围授权');await until("document.body.textContent.includes('范围授权有效')",'grant active');assert.equal(writes.filter(w=>w.path==='/api/action-capability-grants').length,1);
 await refresh();await click('待写入');await until("document.querySelector('.action-card')?.textContent.includes('等待已授权设备')",'offline pending state');
 await click('取消待执行行动');await click('全部');await until("document.querySelector('.action-card')?.textContent.includes('已取消等待执行')",'cancel before execution');
 actions[0].status='succeeded';actions[0].managed={state:'succeeded',cancelRequestedAt:'2099-01-01T00:00:00Z'};await window.loadURL(url);await until("document.querySelector('.related-action-results [data-action-id]')",'nearby result');await click('全部');
 assert.equal(await js("document.querySelector('.related-action-results [data-action-id]').dataset.actionId"),id);assert.equal(await js("document.querySelector('.action-card').dataset.actionId"),id);assert.ok(await js("document.body.textContent.includes('取消请求后收到成功回执')"));
 const output=join(repo,'.mote/calendar-managed');mkdirSync(output,{recursive:true});await js("document.querySelector('.action-card').scrollIntoView({block:'start'})");writeFileSync(join(output,'browser.png'),(await window.webContents.capturePage()).toPNG());await openSettings();await js("document.querySelector('.action-settings').scrollIntoView({block:'start'})");writeFileSync(join(output,'authorization.png'),(await window.webContents.capturePage()).toPNG());
 failRead=true;await openSettings();await refresh();await until("document.querySelector('.action-settings [role=alert]')",'inventory unavailable');
 assert.deepEqual(errors.filter(e=>!e.includes('503')&&!e.includes('Failed to load resource')),[]);console.log('PASS hidden Chromium: empty, draft return/reload, failed save retry, explicit grant, offline waiting, cancellation, shared action result, read failure');
}
run().then(async()=>{window?.destroy();await server?.close();rmSync(root,{recursive:true,force:true});app.exit(0);}).catch(async error=>{console.error(error);window?.destroy();await server?.close();rmSync(root,{recursive:true,force:true});app.exit(1);});
