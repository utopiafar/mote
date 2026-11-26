require('./fixture-background.cjs');
require('./fixture-language.cjs');
const assert = require('node:assert/strict');
const {readFileSync, writeFileSync, mkdirSync} = require('node:fs');
const {execFileSync} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {join, resolve} = require('node:path');
const {app, BrowserWindow, dialog, nativeTheme} = require('electron');

const [manifest, destination, mode = 'web'] = process.argv.slice(2);
assert.ok(manifest && destination && ['web','mac'].includes(mode));
const fixture = JSON.parse(readFileSync(manifest, 'utf8'));
assert.ok(fixture.generatedOnly && new URL(fixture.origin).hostname === '127.0.0.1');
const output = resolve(destination);
mkdirSync(output, {recursive: true, mode: 0o700});
app.setPath('userData', join(output, 'profile'));
const report = {mode, generatedOnly: true, cases: []};

function preview(window) {
  const contents = window.webContents;
  const js = code => contents.executeJavaScript(code, true);
  const frame = () => js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
  const wait = async (predicate, label, timeout = 4500) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await js(predicate);
      if (value) return value;
      await new Promise(done => setTimeout(done, 50));
    }
    throw Error(label);
  };
  const click = async (selector, label = undefined) => {
    const query = JSON.stringify(selector);
    const match = label === undefined ? 'true'
      : `node.textContent.trim()===${JSON.stringify(label)} || node.getAttribute('aria-label')===${JSON.stringify(label)}`;
    const success = await js(`(()=>{const item=[...document.querySelectorAll(${query})].find(node=>
      node.getClientRects().length&&!node.closest('[inert]')&&!node.disabled&&(${match}));
      if(!item)return false;item.focus({preventScroll:true});item.click();return true;})()`);
    assert.ok(success, selector + (label ? ' ' + label : ''));
  };
  const route = async collection => {
    if (await js(`(new URLSearchParams(location.hash.split('?')[1]).get('view')??'materials')===${JSON.stringify(collection)}`)) return;
    const link = `.library-view-link:has([data-collection-id="${collection}"])`;
    await wait(`Boolean(document.querySelector(${JSON.stringify(link)}))`, collection + ' link');
    if (collection === 'files' && await js('Boolean(document.querySelector(".library-secondary-views:not([open])"))')) {
      await click('.library-secondary-views summary');
    }
    await click(link);
    await wait(`new URLSearchParams(location.hash.split('?')[1]).get('view')===${JSON.stringify(collection)}`, collection + ' route');
  };
  const snap = async (name) => {
    await frame();
    const image = await contents.capturePage();
    assert.ok(!image.isEmpty(), 'Empty screenshot ' + name);
    const file = name + '.png';
    writeFileSync(join(output, file), image.toPNG());
    return file;
  };
  return {js, wait, click, route, snap, frame};
}

async function login(window) {
  const ui = preview(window);
  const res = await fetch(fixture.origin + '/api/login/session', {
    method: 'POST', headers: {authorization: 'Bearer ' + fixture.token, 'content-type': 'application/json'},
    body: JSON.stringify({serverUrl: fixture.origin, deviceId: randomUUID(), deviceName:'Generated visual browser', platform:'other', durationMs:0})
  });
  assert.equal(res.status, 200);
  const session = await res.json();
  await window.loadURL(fixture.origin);
  await ui.js(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({token:session.token,viewScope:randomUUID()}))});location.reload();void 0`);
}

async function suite(window) {
  assert.equal(window.isVisible(), false);
  const ui = preview(window);
  const {js, wait, click, route, snap} = ui;
  await wait('Boolean(document.querySelector("[data-session=ready]"))', 'Owner login', 14000);
  await js(`localStorage.setItem('mote.appearance.v1','light');dispatchEvent(new StorageEvent('storage',{key:'mote.appearance.v1'}));void 0`);
  await wait('Boolean(document.querySelector("[data-nav-item=library]"))', 'Main library navigation');
  await click('[data-nav-item=library]');
  await wait('Boolean(document.querySelector("[data-page=archive] .library-workspace"))', 'Library workspace');
  const catalogue = await (await fetch(fixture.origin+'/api/library/browse?limit=60', {headers:{authorization:'Bearer '+fixture.token}})).json();
  const currentMaterials = catalogue.items.filter(row => row.entryType === 'material').map(row => row.material);
  const materialCase = (key,kind,marker,title) => {
    const item=currentMaterials.find(item=>item.kind===kind&&(!title||item.title===title));
    assert.ok(item,key+' is published');
    return {key,title:item.title,marker,materialRef:item.ref};
  };
  const raw = new Set(['screenshot','page','notification','device-event','activity','media']);
  const fileEntries = new Set(['recording','image']);
  const checks = fixture.examples.map(example => {
    if (example.key === 'device-event') return {...example, marker: '熄屏'};
    if (example.key === 'document') {
      const current=currentMaterials.find(item=>item.kind==='mote.file'&&item.title===example.title);
      assert.ok(current);
      return {...example,materialRef:current.ref};
    }
    const id = example.materialRef?.split('@')[0];
    const current = id && currentMaterials.find(item => item.ref.split('@')[0] === id);
    if (current) return {...example, materialRef: current.ref};
    return example;
  }).concat([
    materialCase('screen-segment','mote.screen-segment','无障碍入口'),
    materialCase('structured-page','mote.ui-page-object','公共洗手间东侧'),
    materialCase('note-material','mote.note','周六回到西入口'),
    materialCase('screenshot-event','mote.capture-event','识别文字','步道路线图截图'),
    materialCase('page-event','mote.capture-event','公共洗手间东侧','步道网页资料'),
    materialCase('notification-material','mote.notification','折页校样'),
    materialCase('device-event-material','mote.state-series','熄屏','device_event'),
    materialCase('activity-material','mote.state-series','前台应用采样时长','导览编辑器'),
    materialCase('media-material','mote.state-series','路线实地回听','路线实地回听'),
    materialCase('image-material','mote.file','归档附件',fixture.examples.find(item=>item.key==='image').title),
    {...fixture.examples.find(item=>item.key==='document'),key:'document-file'},
  ]);
  fileEntries.add('document-file');
  const sizes = mode === 'mac' ? [[1360, 900]] : [[1360,900], [390,844]];
  for (const [width,height] of sizes) {
    window.setContentSize(width,height);
    for (const example of checks) {
      const filename = width + '-' + example.key;
      const entry = {key:example.key, width, path:'', interactions:[]};
      try {
        if (fileEntries.has(example.key)) {
          await route('files');
          entry.path = '资料库 / 文件与录音';
          const title = JSON.stringify(example.title);
          const query = `[...document.querySelectorAll('button.file-card')].find(el=>el.querySelector('strong')?.textContent.trim()===${title})`;
          await wait(`Boolean(${query})`, 'File list ' + example.title);
          await js(`(${query}).click();void 0`);
        } else if (raw.has(example.key)) {
          await route('records');
          entry.path = '资料库 / 原始采集记录';
          await wait('Boolean(document.querySelector(".library-time-list"))', 'Original capture list');
          const selector = 'button[data-reference="capture:'+example.captureId+'"]';
          if (!await js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) {
            await js(`document.querySelectorAll('.library-time-group:not([open])>summary').forEach(item=>item.click());void 0`);
          }
          await wait(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, 'Exact raw list row ' + example.key);
          await click(selector);
        } else {
          await route('materials');
          entry.path = '资料库 / 全部资料';
          const ref = example.materialRef ?? 'capture:' + example.captureId;
          const selector = '.library-record[data-reference="' + ref + '"]';
          const ready=`Boolean(document.querySelector(${JSON.stringify(selector)}))`;
          await wait('Boolean(document.querySelector(".library-materials .library-pagination"))','Loaded catalogue');
          if (!await js(ready)) {
            const next=await js('[...document.querySelectorAll(".library-materials .library-pagination button")].filter(el=>!el.disabled).map(el=>el.textContent.trim())');
            const move=next.includes('返回第一页')?'返回第一页':next.includes('下一页')?'下一页':undefined;
            if (move) await click('.library-materials .library-pagination button',move);
          }
          await wait(ready, 'Exact library row ' + example.title);
          await click(selector);
        }
        const needle = JSON.stringify(example.marker || example.title);
        const reader = '.evidence-reader';
        await wait(`[...document.querySelectorAll("${reader}")].some(el=>el.getClientRects().length&&el.innerText.includes(${needle}))`,
          'Reader body ' + example.key);
        if (['screen-segment','structured-page','screenshot-event','page-event','notification-material',
          'device-event-material','activity-material','media-material','image-material'].includes(example.key)) {
          assert.ok(await js(`Boolean(document.querySelector('.source-material-blocks')) &&
            !/original_image_reference|notificationKey|"captureId":|"adapterVersion":/.test(document.querySelector('.source-material-blocks').innerText)`),
          'Technical data must stay out of the readable body');
        }
        if (example.key === 'image-material') {
          assert.ok(await js('[...document.querySelectorAll(".source-material-view button")].some(button=>button.textContent.trim()==="查看文件详情")'));
        }
        if (example.key === 'image') {
          await click('.file-original button','查看原图');
          await wait('Boolean(document.querySelector(".file-original img")?.naturalWidth)','Authorized file image');
          entry.interactions.push('打开原图');
          await click('.original-image-controls button','原始尺寸');
          assert.ok(await js('Boolean(document.querySelector(".original-image-viewport.native-size"))'));
          entry.interactions.push('切换原始尺寸');
        }
        if (example.key === 'screenshot') {
          await wait('Boolean(document.querySelector(".original-image img")?.naturalWidth)','Capture original image');
          await click('.original-image-controls button','查看原图');
          entry.interactions.push('打开原图');
          await click('.original-image-controls button','原始尺寸');
          assert.ok(await js('Boolean(document.querySelector(".original-image-viewport.native-size"))'));
          await click('.original-image-controls button','收起原图');
          entry.interactions.push('原始尺寸并返回');
        }
        if (example.key === 'recording') {
          await click('.recording-file button','回听录音');
          await wait('Boolean(document.querySelector(".recording-file audio")?.readyState)', 'Authorized audio player');
          await js('document.querySelector(".recording-file audio").muted=true;document.querySelectorAll(".recording-turn .recording-time")[1].click();void 0');
          await wait('document.querySelector(".recording-file audio").currentTime>=2', 'Recording timestamp seek');
          await js('document.querySelector(".recording-file audio").play().then(()=>true)');
          assert.ok(await js('!document.querySelector(".recording-file audio").paused'));
          await js('document.querySelector(".recording-file audio").pause();void 0');
          entry.interactions.push('播放、暂停并跳到第二段');
        }
        entry.image = await snap(filename);
        if (example.key === 'image-material') {
          await click('.source-material-view button','查看文件详情');
          await wait('Boolean(document.querySelector(".evidence-back[aria-label=关闭证据详情]"))', 'File opened from its formal material');
          await wait('[...document.querySelectorAll(".file-original button")].some(button=>!button.disabled&&button.textContent.trim()==="查看原图")', 'Archived image is readable');
          await click('.file-original button','查看原图');
          await wait('Boolean(document.querySelector(".file-original img")?.naturalWidth)', 'Original opened from the formal image reader');
          entry.original = await snap(filename + '-original');
          await click('.evidence-back','关闭证据详情');
          await wait('!document.querySelector(".file-original")&&Boolean(document.querySelector(".source-material-view"))', 'Return to the formal image reader');
          entry.interactions.push('进入文件详情、打开原图并返回正式资料');
        }
        if (['recording','document-file'].includes(example.key)) {
          const body=example.key==='recording'?'.recording-transcript':'.file-detail';
          await click(body+' button',example.key==='recording'?'纠正文字':'纠正此段');
          await wait(`Boolean(document.querySelector(${JSON.stringify(body+' textarea')}))`,'Correction editor opened');
          await click(body+' button','取消');
          await wait(`!document.querySelector(${JSON.stringify(body+' textarea')})`,'Correction editor cancelled');
          entry.interactions.push('打开并取消纠正文对话');
        }
        if (await js('Boolean([...document.querySelectorAll(".reader-details-trigger")].find(el=>el.getClientRects().length))')) {
          await click('.reader-details-trigger');
          await wait('Boolean(document.querySelector(".reader-details-panel[role=dialog]"))', 'Source and processing panel');
          if (['note','page','email','calendar','reference','screen-segment','recording'].includes(example.key)) {
            entry.inspector = await snap(filename + '-source');
          }
          await click('.reader-details-panel button','关闭详情');
          await wait('!document.querySelector(".reader-details-panel[role=dialog]")&&document.activeElement?.classList.contains("reader-details-trigger")', 'Focus returns to the same reader');
          entry.interactions.push('来源与处理，关闭并恢复焦点');
        }
        await click('.evidence-back');
        await wait('!document.querySelector(".evidence-reader")?.getClientRects().length','Back to the list');
        entry.interactions.push('返回列表');
        entry.pass = true;
      } catch (error) {
        entry.pass = false;
        entry.error = String(error.message);
        entry.image = await snap(filename + '-failed').catch(()=>undefined);
        entry.visible = await js('document.body.innerText.slice(-1800)').catch(()=>undefined);
      }
      report.cases.push(entry);
      console.log((entry.pass ? 'PASS ' : 'FAIL ') + filename + (entry.error ? ' ' + entry.error : ''));
    }
  }
}

async function run() {
  let localCases;
  if (mode === 'mac') {
    process.env.MOTE_PROFILE = 'dev';
    process.env.MOTE_URL = fixture.origin;
    process.env.MOTE_TOKEN = fixture.token;
    localCases = await prepareMacProfile();
    dialog.showMessageBox=async options=>{throw Error('Mac fixture startup: '+options.detail);};
    require('../apps/desktop/package.json').moteDevelopment = true;
    require('../apps/desktop/dist/main.js');
  }
  await app.whenReady();
  nativeTheme.themeSource = 'light';
  if (mode === 'mac') {
    let window;
    for (let attempt=0;attempt<240&&!window;attempt++) {
      window = BrowserWindow.getAllWindows().find(value=>value.webContents.getURL().startsWith(fixture.origin+'/'));
      if(!window)await new Promise(done=>setTimeout(done,60));
    }
    assert.ok(window, 'The production Mac main window opened Central');
    await preview(window).wait('Boolean(window.moteDesktop?.deviceId)', 'Real Mac preload');
    await macLocalSuite(window,localCases);
    await suite(window);
  } else {
    const window = new BrowserWindow({show:false,width:1360,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
    await login(window);
    await suite(window);
  }
}

async function prepareMacProfile() {
  const sharp = require('sharp');
  const {defaultConfig,ConfigStore} = require('../apps/desktop/dist/config.js');
  const {QueueStorage} = require('../apps/desktop/dist/queue-storage.js');
  const {DurableQueue} = require('../apps/desktop/dist/queue.js');
  const {LocalSourceManager} = require('../apps/desktop/dist/source-manager.js');
  const {SourceAdapterRegistry,builtInSourceAdapters} = require('../apps/desktop/dist/source-adapters.js');
  const {DEFAULT_SOURCE_OPTIONS} = require('../apps/desktop/dist/source-types.js');
  const {ensureStorageFormat} = require('../apps/desktop/dist/storage-format.js');
  const {MeetingRecordingManager} = require('../apps/desktop/dist/meeting-recording.js');
  const directory = join(output,'profile-profiles','dev');
  const settings = {...defaultConfig(),deviceName:'生成验收 Mac',serverUrl:fixture.origin, token:fixture.token,
    syncMode:'manual',syncPaused:true};
  const secrets = {mode:'json', available:()=>true};
  await ensureStorageFormat(directory,['config.json','queue','local-sources']);
  await new ConfigStore(directory,secrets).save(settings);
  const storage = new QueueStorage(directory,'dev',settings.deviceId);
  const queue = new DurableQueue(await storage.open(''),settings);
  await queue.initialize();
  const cases=[];
  for (const original of fixture.localCaptures) {
    if (original.source==='device_event') continue;
    const {imageBase64,...event} = structuredClone(original);
    event.deviceId=settings.deviceId;
    event.deviceName=settings.deviceName;
    event.platform='macos';
    event.appId??='generated.visual.note';
    if (event.source==='activity') {
      delete event.ocrText;
      delete event.windowTitle;
    }
    if (event.source==='notification') event.metadata.collector.method='accessibility';
    const bytes = imageBase64 ? await sharp(Buffer.from(imageBase64,'base64')).jpeg().toBuffer() : undefined;
    if (bytes) {
      event.imageMime='image/jpeg';
      event.privacy.mode='local';
      event.privacy.reason='Generated visual fixture';
    }
    await queue.enqueue(event,bytes);
    const example=fixture.examples.find(row=>row.captureId===event.id);
    cases.push({...example, source:event.source, localKey:'queue:'+event.id});
  }
  await queue.flushCaptureStages();
  const folder=join(output,'generated-source');
  mkdirSync(folder,{recursive:true,mode:0o700});
  const fileCases=fixture.examples.filter(example=>['document','image','recording'].includes(example.key));
  let wavPath;
  for (const example of fileCases) {
    const target=join(folder,example.title);
    if (example.key==='document') {
      writeFileSync(target,example.marker);
    } else {
      const content=await fetch(fixture.origin+'/api/files/'+example.captureId+'/content',{headers:{authorization:'Bearer '+fixture.token}});
      assert.ok(content.ok, 'Generated archived '+example.key);
      writeFileSync(target,Buffer.from(await content.arrayBuffer()));
      if (example.key==='recording') wavPath=target;
    }
  }
  const builtIns=builtInSourceAdapters();
  const adapters=new SourceAdapterRegistry().register(builtIns.get('local-files'));
  const markerAt=new Date().toISOString();
  const staged=[
    {key:'calendar',kind:'local-calendar',title:'本机步道复走',marker:'约在西入口重新核对坡道图。',fields:{calendarId:'generated-calendar'},
      item:{kind:'calendar',calendar:{start:markerAt,end:new Date(Date.now()+3600000).toISOString(),allDay:false,status:'confirmed'}}},
    {key:'coding',kind:'coding-agent',title:'本机 Coding 会话',marker:'把西入口的注释放在路线说明下。',fields:{path:folder,agent:'codex'},
      item:{kind:'message'}},
  ];
  for (const example of staged) {
    const item={...example.item,externalId:'generated-'+example.key,title:example.title,text:example.marker,layer:'snapshot'};
    adapters.register({...builtIns.get(example.kind),watchesPath:false,scan:async()=>({version:1,scan:{items:[item],seen:[item.externalId],complete:true,skipped:0}})});
  }
  const manager=new LocalSourceManager(join(directory,'local-sources'),settings,'/fixture-no-helper',true,undefined,adapters);
  try {
    await manager.initialize();
    const sourceId=await manager.addFiles(folder,{...DEFAULT_SOURCE_OPTIONS,extensions:['.txt','.png','.wav']});
    await manager.sync(true);
    const addCase=(example,id,source)=>{
      const pending=manager.pendingContentSummaries().find(row=>row.sourceId===id&&row.item.title===example.title);
      assert.ok(pending,'The generated source staged '+example.key);
      cases.push({...example,source,localKey:'source:'+id+':'+pending.key});
    };
    for (const example of fileCases) {
      addCase(example.key==='document'?example:{...example,marker:'原件已保存在本机'},sourceId,'file');
    }
    for (const example of staged) {
      const options={...DEFAULT_SOURCE_OPTIONS,retention:'snapshot'};
      const id=await manager.addAdapterSource({name:'生成的'+example.title,kind:example.kind,...example.fields},options);
      await manager.sync(true);
      addCase(example,id,example.key);
      await manager.update(id,{...options,enabled:false});
    }
  } finally { await manager.close(); }
  assert.ok(wavPath);
  const audio=join(output,'generated-meeting.m4a');
  execFileSync('/usr/bin/afconvert',['-f','m4af','-d','aac',wavPath,audio]);
  const meeting=new MeetingRecordingManager({
    directory:join(directory,'local-sources','meetings'),connection:()=>settings,
    permissions:()=>({microphone:'granted',systemAudio:'granted'}),
    backend:{start:async({outputFile})=>({stop:async()=>{
      writeFileSync(outputFile,readFileSync(audio),{mode:0o600});
      return {filePath:outputFile,durationMs:6000,microphone:true,systemAudio:true,warnings:[]};
    }})},
  });
  try {
    await meeting.initialize();
    await meeting.acknowledgeNotice();
    await meeting.start();
    const {lastSession}=await meeting.stop();
    assert.equal(lastSession?.state,'completed');
    cases.push({key:'meeting',marker:'本机会议录音',source:'file',localKey:'meeting:'+lastSession.id,bytes:readFileSync(audio)});
  } finally {await meeting.close();}
  return cases;
}

async function macLocalSuite(central, cases) {
  const owner = preview(central);
  try {
    await owner.wait('Boolean(document.querySelector("[data-session=ready]"))','Mac owner login',14000);
    await owner.wait('Boolean(document.querySelector("[data-nav-item=library]"))','Mac library');
  } catch (error) {
    await owner.snap('mac-startup');
    throw error;
  }
  await owner.click('[data-nav-item=library]');
  await owner.wait('Boolean(document.querySelector("[data-local-device] button"))','Local device source');
  await owner.click('[data-local-device] button');
  await owner.wait('Boolean(document.querySelector("[data-local-capture-sync]"))','Local capture and sync entry');
  const local=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('file:'));
  assert.ok(local, 'Native Mac local window');
  await owner.click('[data-local-capture-sync]');
  const ui=preview(local);
  assert.equal(local.isVisible(),false);
  local.setContentSize(1140,820);
  await ui.wait('Boolean(document.querySelector("[data-page=capture-sync]:not([hidden])"))','Capture and sync window');
  await ui.click('[data-page=capture-sync] [data-nav=records]');
  for (const item of cases) {
    const entry={key:'local-'+item.key,width:1140,path:'采集与同步 / 本机记录',interactions:[]};
    try {
      const selector='button[data-content-key='+JSON.stringify(item.localKey)+']';
      await ui.wait(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, 'Local entry for '+item.key);
      await ui.click(selector);
      await ui.wait('Boolean(document.querySelector("#content-detail-dialog[open] #content-detail-status[aria-busy=false]"))','Local record read completed');
      if (item.source==='screen') {
        await ui.wait('Boolean(document.querySelector("#content-detail-image")?.naturalWidth)','Local screenshot image');
        await ui.click('#content-original summary');
        await ui.wait('!document.querySelector("#content-original").open','Collapse local image');
        await ui.click('#content-original summary');
        await ui.wait('Boolean(document.querySelector("#content-original[open] img")?.naturalWidth)','Reopen local screenshot');
        entry.interactions.push('收起并重新打开原图');
      }
      entry.image=await ui.snap(entry.key);
      const wording=item.source==='activity'?'应用活动':item.marker;
      assert.ok(await ui.js(`document.querySelector("#content-detail-dialog").innerText.includes(${JSON.stringify(wording)})`),'Local reader content '+item.key);
      await ui.click('#content-detail-inspect');
      await ui.wait('Boolean(document.querySelector("#content-processing[open]"))','Local inspector opened');
      entry.inspector=await ui.snap(entry.key+'-source');
      if (item.key==='meeting') {
        const saved=join(output,'saved-generated-meeting.m4a');
        const previous=dialog.showSaveDialog;
        dialog.showSaveDialog=async()=>({canceled:false,filePath:saved});
        try {
          await ui.click('#content-detail-save-original');
          const deadline=Date.now()+4500;
          while (Date.now()<deadline) {
            try {if(readFileSync(saved).equals(item.bytes))break;} catch (error) {if(error.code!=='ENOENT')throw error;}
            await new Promise(done=>setTimeout(done,50));
          }
          assert.deepEqual(readFileSync(saved),item.bytes);
          entry.interactions.push('保存原件并核对字节');
        } finally { dialog.showSaveDialog=previous; }
      }
      await ui.click('#content-detail-inspect');
      await ui.wait('!document.querySelector("#content-processing").open','Local inspector closed');
      entry.interactions.push('展开和收起来源与处理');
      await ui.click('#content-detail-close');
      await ui.wait('!document.querySelector("#content-detail-dialog").open','Local reader back');
      entry.interactions.push('返回本机记录');
      entry.pass=true;
    } catch (error) {
      entry.pass=false;
      entry.error=String(error.message);
      entry.image??=await ui.snap(entry.key+'-failed').catch(()=>undefined);
      if (await ui.js('Boolean(document.querySelector("#content-detail-dialog[open]"))')) await ui.click('#content-detail-close');
    }
    report.cases.push(entry);
    console.log((entry.pass?'PASS ':'FAIL ')+entry.key+(entry.error?' '+entry.error:''));
  }
  await owner.click('[data-nav-item=chat]');
}
app.on('window-all-closed', () => {});
run().catch(error=>{report.fatal=String(error.stack);console.error(error);}).finally(()=>{
  writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  app.exit(report.fatal || report.cases.some(row=>!row.pass) ? 1 : 0);
});
