require('../../../scripts/fixture-language.cjs');
/** Isolated central node + real renderer. Every image and text record is generated here. */
const {app, BrowserWindow} = require('electron');
const {mkdtempSync, mkdirSync, writeFileSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {randomBytes, randomUUID} = require('node:crypto');
const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const net = require('node:net');
const sharp = require('sharp');
const repository = resolve(__dirname, '../../..');
const fixture = mkdtempSync(join(tmpdir(), 'mote-capture-browser-'));
const output = resolve(__dirname, '../artifacts/capture-browser');
mkdirSync(output, {recursive:true});
app.setPath('userData', join(fixture, 'browser'));
app.on('window-all-closed', () => {});
let server, window;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {const deadline=Date.now()+20000;while(Date.now()<deadline){if(await fn())return;await sleep(100);}throw Error(`Timed out: ${label}`);}
async function freePort() {return new Promise((resolve,reject)=>{const socket=net.createServer();socket.once('error',reject);socket.listen(0,'127.0.0.1',()=>{const port=socket.address().port;socket.close(()=>resolve(port));});});}
async function finish(code) {
  if(window&&!window.isDestroyed())window.destroy();
  if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('close',resolve)),sleep(5000)]);}
  rmSync(fixture,{recursive:true,force:true});app.exit(code);
}
(async () => {
  await app.whenReady();
  const port=await freePort(),url=`http://127.0.0.1:${port}`,token=randomBytes(32).toString('hex');
  const config=join(fixture,'mote.env');
  writeFileSync(config,`MOTE_PROFILE=test\nMOTE_HOST=127.0.0.1\nMOTE_PORT=${port}\nMOTE_DATA_DIR=./data\nMOTE_TOKEN=${token}\n`,{mode:0o600});
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('MOTE_'))delete env[key];
  server=spawn('node',[join(repository,'apps/server/dist/index.js')],{cwd:repository,env:{...env,MOTE_ENV_FILE:config},stdio:['ignore','ignore','pipe']});
  let serverError='';server.stderr.on('data',chunk=>{serverError+=chunk;});
  await until(async()=>{if(server.exitCode!==null)throw Error(serverError.slice(0,300));try{return(await fetch(url+'/api/health')).ok;}catch{return false;}},'fixture node');
  const base=new Date();base.setDate(base.getDate()-1);base.setHours(12,0,0,0);
  const selectedDay=`${base.getFullYear()}-${String(base.getMonth()+1).padStart(2,'0')}-${String(base.getDate()).padStart(2,'0')}`;
  const fullText='这是自动生成的截图识别测试文本。'.repeat(30)+'全文末尾_SENTINEL';
  const states=[{status:'pending',reason:'charging'},{status:'completed'},{status:'completed'},{status:'failed'},{status:'disabled'},undefined];
  const ids=[];
  for(let index=0;index<30;index++){
    const id=randomUUID();ids.push(id);
    const image=await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#f2f4e9"/><rect x="70" y="70" width="1060" height="660" rx="24" fill="#ffffff"/><text x="120" y="190" fill="#315e4b" font-size="44">Generated capture ${index+1}</text><text x="120" y="275" fill="#66756c" font-size="25">Synthetic fixture. No personal screenshots.</text></svg>`)).png().toBuffer();
    const event={id,deviceId:'synthetic-capture-browser',deviceName:'合成测试设备',platform:'android',capturedAt:new Date(base.getTime()-index*60000-(index>=26?86400000:0)).toISOString(),durationMs:60000,source:'screen',appId:'fixture.app',appName:`合成应用 ${index+1}`,windowTitle:`合成截图 ${index+1}`,imageMime:'image/png',imageBase64:image.toString('base64'),ocrText:index===1?fullText:index>=6?'合成识别文本':'',privacy:{mode:'none',redacted:false,excluded:false},...(index<states.length&&states[index]?{ocr:states[index]}:index>=6?{ocr:{status:'completed'}}:{})};
    const response=await fetch(url+'/api/captures',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(event)});
    assert.equal(response.status,201,`fixture capture ${index}`);
  }
  window=new BrowserWindow({width:1360,height:1000,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
  const wc=window.webContents,requests=[],errors=[];
  wc.session.webRequest.onBeforeRequest((details,callback)=>{requests.push(details.url);callback({});});
  wc.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message);});
  const js=code=>wc.executeJavaScript(code);
  const recordsView=()=>until(()=>js(`(()=>{const button=Array.from(document.querySelectorAll('[aria-label="记录视图"] button')).find(button=>button.innerText==='全部记录');if(!button)return false;button.click();return true;})()`),'select individual record view');
  const clickNav=async label=>{await js(`Array.from(document.querySelectorAll('.sidebar button')).find(button=>button.innerText===${JSON.stringify(label)}).click()`);if(label==='采集记录')await recordsView();};
  await window.loadURL(url);
  await js(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({token}))});location.reload()`);
  await until(()=>js(`document.body.innerText.includes('已登录 ·')`),'authenticated app');
  await clickNav('采集记录');
  await until(()=>js(`document.querySelectorAll('.timeline-group .capture-card').length===24`),'first page after one click');
  assert(await js(`document.querySelector('.filter-count').innerText.includes('共 30 条')`));
  for(const label of ['OCR 待充电','OCR 已完成','OCR 未识别到文字','OCR 失败','OCR 待处理','OCR 状态未知'])assert(await js(`document.querySelector('.content').innerText.includes(${JSON.stringify(label)})`),label);
  await until(()=>js(`document.querySelectorAll('.timeline-group .capture-image img').length>0`),'thumbnail images');
  assert(requests.some(item=>item.includes('/api/capture-browser?')&&item.includes('limit=24')));
  assert(requests.some(item=>item.includes('/image?thumbnail=1')));
  assert(!requests.some(item=>/\/api\/capture-browser\/[^/?]+\/image$/.test(item)),'list must not fetch full images');
  writeFileSync(join(output,'records-desktop.png'),(await wc.capturePage()).toPNG());
  await js(`document.querySelectorAll('.timeline-group .capture-card')[1].click()`);
  await until(()=>js(`document.querySelector('[aria-label="OCR 全文"]')?.textContent.includes('全文末尾_SENTINEL')`),'full OCR in detail after one click');
  assert(requests.some(item=>item.endsWith(`/api/capture-browser/${ids[1]}/image`)));
  window.setSize(390,844);await sleep(200);
  assert(await js('document.documentElement.scrollWidth<=window.innerWidth'),'mobile detail fits');
  writeFileSync(join(output,'detail-mobile.png'),(await wc.capturePage()).toPNG());
  await js(`document.querySelector('[aria-label="关闭证据详情"]').click()`);
  window.setSize(1360,1000);await sleep(100);
  await js(`document.querySelector('.timeline-group .capture-card').click()`);
  await until(()=>js(`document.querySelector('.evidence-ocr-status')?.innerText.includes('OCR 待充电')`),'pending detail');
  const completion=await fetch(url+`/api/capture-browser/${ids[0]}/ocr`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({status:'completed',ocrText:'合成补做结果_AUTO_REFRESH'})});
  assert.equal(completion.status,200);
  await until(()=>js(`document.querySelector('[aria-label="OCR 全文"]')?.textContent==='合成补做结果_AUTO_REFRESH'`),'pending detail automatically refreshes after OCR sync');
  await js(`document.querySelector('[aria-label="关闭证据详情"]').click()`);
  await js(`Array.from(document.querySelectorAll('.load-more')).at(-1).scrollIntoView({block:'center'})`);
  await sleep(350);
  assert.equal(await js(`document.querySelectorAll('.timeline-group .capture-card').length`),24,'scrolling never loads another page');
  await js(`Array.from(document.querySelectorAll('[aria-label="采集记录分页"] button')).find(button=>button.innerText==='下一页').click()`);
  await until(()=>js(`document.querySelectorAll('.timeline-group .capture-card').length===6`),'only second page is retained');
  assert.equal(await js(`document.querySelectorAll('.timeline-group').length`),2);
  assert(await js(`document.querySelector('[aria-label="采集记录分页"]').innerText.includes('第 2 页')`));
  await js(`Array.from(document.querySelectorAll('[aria-label="采集记录分页"] button')).find(button=>button.innerText==='上一页').click()`);
  await until(()=>js(`document.querySelectorAll('.timeline-group .capture-card').length===24`),'previous page replaces second page');
  assert(await js(`Array.from(document.querySelectorAll('.timeline-group .capture-image img')).every(image=>getComputedStyle(image).objectFit==='contain')`),'previews preserve the entire frame');
  await js(`(()=>{const input=document.querySelector('[aria-label="查看某天的采集记录"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(selectedDay)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(()=>js(`document.querySelector('.filter-count').innerText.includes('共 26 条')`),'local day filter');
  await js(`window.scrollTo({top:0})`);
  window.setSize(390,844);await sleep(200);
  assert(await js('document.documentElement.scrollWidth<=window.innerWidth'),'mobile records fit');
  assert(await js(`document.querySelector('[aria-label="筛选设备"]').getBoundingClientRect().width>100`),'mobile device picker remains readable');
  writeFileSync(join(output,'records-mobile.png'),(await wc.capturePage()).toPNG());
  await js(`(()=>{const select=document.querySelector('[aria-label="筛选 OCR 状态"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'failed');select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(()=>js(`document.querySelector('.filter-count').innerText.includes('共 1 条')&&document.querySelectorAll('.timeline-group .capture-card').length===1`),'OCR status filter');
  window.setSize(1360,1000);await sleep(100);
  await clickNav('资料库');
  await until(()=>js(`document.querySelector('.archive-page')!==null`),'archive navigation after one click');
  await js(`Array.from(document.querySelectorAll('.segmented-nav button')).find(button=>button.innerText==='应用活动').click()`);
  await until(()=>js(`document.querySelector('.activity-panel')!==null`),'archive tab after one click');
  await js(`Array.from(document.querySelectorAll('.segmented-nav button')).find(button=>button.innerText==='全部记录').click()`);
  await recordsView();
  await until(()=>js(`document.querySelector('.timeline-group')!==null`),'records tab after one click');
  const mediaNow=Date.now(),mediaSession={sessionId:'fixture-media-session',appId:'fixture.player',appName:'合成播放器',playbackState:'playing',appVisibility:'background',playbackType:'local',title:'合成章节 · 海边的声音',artist:'合成作者',positionMs:0,durationMs:180000,playbackSpeed:1};
  const mediaFixtures=[
    {offset:90000,durationMs:45000,locked:true,session:mediaSession,collection:'content'},
    {offset:15000,durationMs:30000,locked:false,session:{...mediaSession,sessionId:'fixture-private-session',appVisibility:'foreground',title:undefined,artist:undefined},collection:'activity'},
    {offset:10000,durationMs:0,locked:true,status:'permission_required',collection:'content'},
    {offset:5000,durationMs:0,locked:true,session:{...mediaSession,playbackState:'paused'},collection:'content'},
  ];
  for(const item of mediaFixtures){
    const capturedAt=new Date(mediaNow-item.offset).toISOString();
    const event={id:randomUUID(),deviceId:'synthetic-capture-browser',deviceName:'合成测试设备',platform:'android',capturedAt,durationMs:item.durationMs,source:'media',appId:item.session?.appId??'dev.mote.media',appName:item.session?.appName??'媒体观察',windowTitle:'',ocrText:'',privacy:{mode:'none',redacted:false,excluded:false,collection:item.collection},metadata:{version:1,observedAt:capturedAt,collector:{method:'media_session'},state:{screenLocked:item.locked,screenInteractive:!item.locked},media:{status:item.status??'available',sessions:item.session?[item.session]:[]}}};
    const response=await fetch(url+'/api/captures',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(event)});
    assert.equal(response.status,201,`media fixture: ${await response.text()}`);
  }
  await clickNav('采集记录');
  await until(()=>js(`document.querySelector('[aria-label="筛选记录来源"]')!==null`),'media source filter');
  await js(`(()=>{const select=document.querySelector('[aria-label="筛选记录来源"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'media');select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(()=>js(`document.querySelector('.filter-count').innerText.includes('共 4 条')&&document.querySelectorAll('.timeline-group .capture-card').length===4`),'independent media source records');
  assert(await js(`document.querySelector('.content').innerText.includes('媒体采集等待授权')`));
  assert(await js(`document.querySelector('.content').innerText.includes('播放采样 45 秒')`));
  writeFileSync(join(output,'media-records-desktop.png'),(await wc.capturePage()).toPNG());
  await js(`Array.from(document.querySelectorAll('.timeline-group .capture-card')).find(card=>card.innerText.includes('播放采样 45 秒')).click()`);
  await until(()=>js(`document.querySelector('.media-snapshot')?.innerText.includes('合成章节 · 海边的声音')`),'media session evidence');
  assert(await js(`document.querySelector('.evidence-modal').innerText.includes('屏幕已锁定')&&document.querySelector('.evidence-modal').innerText.includes('后台应用')`));
  assert(await js(`!document.querySelector('.evidence-modal .capture-image')`),'media has no screenshot');
  window.setSize(390,844);await sleep(200);
  assert(await js('document.documentElement.scrollWidth<=window.innerWidth'),'mobile media evidence fits');
  writeFileSync(join(output,'media-detail-mobile.png'),(await wc.capturePage()).toPNG());
  await js(`document.querySelector('[aria-label="关闭证据详情"]').click()`);
  window.setSize(1360,1000);await sleep(100);
  await clickNav('资料库');
  await js(`document.querySelector('[aria-label="刷新资料"]').click()`);
  await js(`Array.from(document.querySelectorAll('.segmented-nav button')).find(button=>button.innerText==='媒体播放').click()`);
  await until(()=>js(`document.querySelector('.media-stats')?.innerText.includes('4 次状态观察')`),'media aggregates');
  assert.equal(await js(`document.querySelector('.media-stats>div:first-child strong').innerText`),'1 分钟 15 秒');
  assert(await js(`document.querySelector('.media-stats').innerText.includes('45 秒')`));
  assert(await js(`document.querySelector('.media-availability').innerText.includes('1 次等待授权')`));
  writeFileSync(join(output,'media-activity-desktop.png'),(await wc.capturePage()).toPNG());
  window.setSize(390,844);await sleep(200);
  assert(await js('document.documentElement.scrollWidth<=window.innerWidth'),'mobile media stats fit');
  writeFileSync(join(output,'media-activity-mobile.png'),(await wc.capturePage()).toPNG());
  window.setSize(1360,1000);await sleep(100);
  await clickNav('设备');
  await until(()=>js(`document.querySelector('.device-card .media-snapshot')!==null`),'recent media device state');
  assert(await js(`document.querySelector('.device-card .media-snapshot').innerText.includes('最近上报的媒体状态')`));
  assert.deepEqual(errors,[]);
  console.info('PASS: generated fixtures only; capture navigation/thumbnails/cursors/OCR, media source filter, locked/background playback evidence, independent playback totals, permission coverage, recent device metadata and desktop/mobile layout.');
})().then(()=>finish(0),error=>{console.error(error.stack);finish(1);});
