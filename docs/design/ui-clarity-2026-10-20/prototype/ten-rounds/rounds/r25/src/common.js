/* Shared UI iteration layer. R19 stays frozen; every round snapshots this file. */
'use strict';
const nuText=(zh,en)=>state.language==='en'?en:zh;
const nuBaseRender=render;
const nuBaseLibrary=libraryPage;
const nuBaseNotes=notesPage;
const nuBaseAsk=askPage;
const nuBaseReset=resetPreviewData;
const nuBaseGo=go;
const nuBaseSetup=setupPage;
const nuBaseDoAction=doAction;
const nuBaseMaterialRow=materialRow;
const nuBaseDevices=devicesPage;
const nuBaseNoteRecord=currentNoteRecord;
const nuAction=(label,action,kind='subtle',extra='')=>button(label,'nu-'+action,extra,kind);
go=function(page){if(page!==state.page){state.toast='';state.toastAction='';if(state.page==='setup/device')state.nuSetupReturn='';}return nuBaseGo(page);};

function webScreenSetup(){
 const connected=state.devices.filter(d=>['Mac','Android'].includes(d.platform));
 const chosen=connected.find(d=>d.id===state.nuScreenTarget)||connected[0];
 const title=heading(nuText('设备的屏幕记录','Screen capture on your devices'),nuText('由设备采集，保存后在资料库中查找和使用。','Captured on your device, then available in your library.'),goButton(nuText('返回来源','Back to sources'),'sources','subtle'));
 if(!chosen)return title+'<section class="card reading device-first"><span class="step-number">1</span><h2>'+nuText('先连接一台 Mac 或 Android 设备','Connect a Mac or Android device first')+'</h2><p>'+nuText('屏幕记录需要设备上的 Mote 客户端和系统授权。连接后，这里会显示设备及记录状态。','Screen capture needs the Mote app and system permission on that device. Its connection and capture status will appear here.')+'</p><div class="actions section">'+nuAction(nuText('连接设备','Connect a device'),'connect-screen','primary')+goButton(nuText('先写一条记录','Start with a note'),'notes','subtle')+'</div></section>';
 const source=state.sources.find(s=>s.id==='screen'&&(s.deviceId||'mac')===chosen.id);
 return title+'<section class="card reading device-first"><div class="section-head"><div><p class="eyebrow">'+nuText('当前目标设备','CURRENT DEVICE')+'</p><h2 data-user-content>'+esc(chosen.name)+'</h2></div>'+tag(chosen.platform,'purple')+'</div>'+(connected.length>1?'<label class="field"><span>'+nuText('查看设备','View device')+'</span><select class="field-input" id="nu-screen-device">'+connected.map(d=>'<option value="'+esc(d.id)+'" '+(d.id===chosen.id?'selected':'')+'>'+esc(d.name)+'</option>').join('')+'</select></label>':'')+'<div class="notice section"><div><strong>'+nuText('应用范围与系统权限，在这台设备上设置','Set app scope and system permission on this device')+'</strong><p>'+nuText('打开设备上的 Mote → 来源 → 屏幕记录，选择应用并确认。你随时可以在该设备暂停。','Open Mote on the device → Sources → Screen capture. Choose apps and confirm. You can pause on the device at any time.')+'</p></div></div><section class="section"><h3>'+nuText('设备上报的记录状态','Capture status reported by the device')+'</h3><p>'+esc(source?sourceStatusMessage(source.id,source):nuText('还没有上报记录范围。完成设备端设置后，可以回来查看。','No capture scope has been reported yet. Return after setting it up on the device.'))+'</p>'+(source?'<p>'+nuText('已保存应用：','Saved apps: ')+esc(screenAppNames(savedScreenApps()))+'</p>':'')+'</section><div class="actions section">'+goButton(nuText('查看设备状态','View device status'),'devices','primary')+goButton(nuText('返回来源','Back to sources'),'sources','subtle')+'</div></section>';
}
setupPage=function(){return state.surface==='web'&&state.page==='setup/screen'?webScreenSetup():nuBaseSetup();};
devicesPage=function(){
 let html=nuBaseDevices();
 const replacements=[
  ['设备与记录状态',nuText('设备连接与采集状态','Device connection and capture status')],
  ['工作台是资料汇集的位置。设备决定记录哪些本机内容；来源管理决定每种内容怎样接入。',nuText('工作台汇集各设备保存的资料。设备连接授权允许同步到当前工作台；屏幕录制权限需在设备的系统设置中单独开启。','Your workspace collects saved materials from your devices. Device connection authorization allows workspace sync; screen recording needs a separate permission in the device’s system settings.')],
  ['重新授权这台设备',nuText('更新设备连接授权','Renew device connection authorization')],
  ['授权已更新',nuText('设备连接授权已更新','Device connection authorization renewed')],
  ['未在记录 · 等待授权',nuText('未在记录 · 等待系统屏幕权限','Not recording · waiting for system screen permission')],
  ['未在记录 · 权限已拒绝',nuText('未在记录 · 系统屏幕权限被拒绝','Not recording · system screen permission denied')],
  ['向中央发送已暂停',nuText('向工作台同步已暂停','Sync to this workspace is paused')],
  ['向中央发送已开启',nuText('向工作台同步已开启','Sync to this workspace is on')],
  ['资料正文可阅读，记忆整理单独进行。',nuText('资料保存后即可阅读。长期要点会在后台整理为记忆。','Saved materials are ready to read. Longer-term facts are organized into memories in the background.')]
 ];
 for(const [from,to] of replacements)html=html.split(from).join(to);
 return html;
};
doAction=function(action,el){
 if(action==='connect-device'&&state.nuSetupReturn==='screen'){
  const target=el.dataset.device.toLowerCase();state.nuSetupReturn='';nuBaseDoAction(action,el);state.nuScreenTarget=target;persist();go('setup/screen');return;
 }
 return nuBaseDoAction(action,el);
};
materialRow=function(material){
 const html=nuBaseMaterialRow(material),query=(state.search||'').trim();
 if(!query)return html;
 const body=String(material.body||''),at=body.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
 if(at<0)return html;
 const start=Math.max(0,at-8),end=Math.min(body.length,at+query.length+85);
 const excerpt=(start?'…':'')+esc(body.slice(start,at))+'<mark>'+esc(body.slice(at,at+query.length))+'</mark>'+esc(body.slice(at+query.length,end))+(end<body.length?'…':'');
 return html.replace(/<span class="material-preview">[\s\S]*?<\/span>/,'<span class="material-preview material-match"><span class="match-label">'+nuText('正文命中','Found in the note')+'</span><span data-user-content>'+excerpt+'</span></span>');
};
currentNoteRecord=function(){
 const record=nuBaseNoteRecord(),previous=state.materials.find(m=>m.id===record.id)||state.noteQueue.find(m=>m.id===record.id);
 const now=new Date().toISOString();
 return {...record,createdAt:previous?.createdAt||now,updatedAt:now};
};

function enhanceOriginalEvidence(){
 const material=state.original;
 if(state.modal!=='original'||!material||material.type==='screen')return;
 const box=document.querySelector('.modal .evidence-box');
 if(!box||box.querySelector('.original-metadata'))return;
 const recorded=material.updatedAt||material.createdAt;
 let when=material.date||nuText('未提供','Not provided');
 if(recorded&&!Number.isNaN(new Date(recorded).getTime()))when=new Intl.DateTimeFormat(state.language==='en'?'en-GB':'zh-CN',{dateStyle:'medium',timeStyle:'short'}).format(new Date(recorded));
 else if(when==='刚刚')when=nuText('刚刚（示例记录）','Just now (sample record)');
 const source=material.source||material.origin||nuText('未提供','Not provided');
 const device=material.device==='网页'?nuText('网页工作台','Web workspace'):material.device;
 const details='<dl class="original-metadata"><div><dt>'+nuText('内容来源','Content source')+'</dt><dd data-user-content>'+esc(source)+'</dd></div><div><dt>'+nuText(recorded?'保存时间（本地）':'记录时间',recorded?'Saved at (local time)':'Recorded time')+'</dt><dd><time'+(recorded?' datetime="'+esc(recorded)+'"':'')+'>'+esc(when)+'</time></dd></div>'+(device?'<div><dt>'+nuText('保存端','Saved from')+'</dt><dd data-user-content>'+esc(device)+'</dd></div>':'')+'</dl>';
 box.querySelector('strong')?.insertAdjacentHTML('afterend',details);
}

function newcomerWelcome(){
 const native=state.surface!=='web';
 return '<section class="welcome" aria-labelledby="welcome-title">'+
 '<div class="welcome-lead"><div class="welcome-copy"><p class="welcome-eyebrow">Mote · '+nuText('个人资料与记忆库','Your personal knowledge and memory library')+'</p>'+
 '<h1 id="welcome-title">'+nuText('让日常记录，<br>随时找得到。','Keep your daily notes.<br>Find them when they matter.')+'</h1>'+
 '<p class="welcome-description">'+nuText('保存文件、想法和设备记录。以后随时搜索、提问，沿着出处核对原文。','Save files, thoughts and device records. Search or ask later, then check the original source.')+'</p>'+
 '<div class="welcome-actions">'+goButton(nuText('写下第一条记录','Write your first note'),'notes','primary')+goButton(nuText('导入已有文件','Import a file'),'import','subtle')+'</div>'+
 '<p class="welcome-hint">'+nuText('可以先记一条想法，再按需连接来源。','Start with a thought. Connect sources when you need them.')+'</p></div>'+
 '<article class="welcome-example" aria-label="'+nuText('使用方式示例','Example workflow')+'"><div class="example-top"><span class="tag purple">'+nuText('一个使用例子','One way to use Mote')+'</span>'+icon('library')+'</div><div class="example-input"><span class="example-label">'+nuText('保存','SAVE')+'</span><p>'+nuText('读书笔记、一次会议、一个想法','A reading note, a meeting, an idea')+'</p></div><div class="example-line"></div><div class="example-query"><span class="example-label">'+nuText('以后问','ASK LATER')+'</span><strong>'+nuText('“上次讨论决定了什么？”','“What did we decide last time?”')+'</strong><p>'+nuText('从自己的资料中找答案，点引用回看原文。','Find the answer in your materials. Follow a citation back to the original.')+'</p></div>'+nuAction(nuText('看一份示例资料','See an example'),'example','text')+'</article></div>'+
 '<section class="welcome-paths" aria-label="'+nuText('更多开始方式','More ways to begin')+'"><div class="section-head"><h2>'+nuText('也可以持续收集','Or collect continuously')+'</h2>'+goButton(nuText('浏览所有来源','Browse all sources'),'catalog','text')+'</div><div class="welcome-source-grid">'+
 '<button class="welcome-source" data-action="go" data-page="setup/folder">'+icon('folder')+'<span><strong>'+nuText('同步文件夹','Sync a folder')+'</strong><small>'+nuText(native?'持续保存所选文件夹的新内容':'连接设备或工作台服务器的文件夹',native?'Keep new files from a chosen folder':'Connect a folder on a device or workspace server')+'</small></span>'+icon('arrow')+'</button>'+
 '<button class="welcome-source" data-action="go" data-page="setup/screen">'+icon('screen')+'<span><strong>'+nuText('记录屏幕','Capture your screen')+'</strong><small>'+nuText(native?'自己选择应用与记录范围':'由 Mac / Android 客户端采集',native?'Choose the apps and recording scope':'Captured by the Mac / Android app')+'</small></span>'+icon('arrow')+'</button>'+
 '<button class="welcome-source" data-action="go" data-page="catalog">'+icon('sources')+'<span><strong>'+nuText('连接在线来源','Connect online sources')+'</strong><small>'+nuText('文档、邮件、日历和更多','Documents, email, calendars and more')+'</small></span>'+icon('arrow')+'</button></div></section>'+
 '<div class="welcome-boundary">'+icon('shield')+'<p>'+nuText('你决定保存哪些内容。连接来源前可查看范围，之后也能单独暂停。','You choose what to save. Review a source’s scope before connecting, and pause it at any time.')+'</p></div></section>';
}

libraryPage=function(){
 if(!state.materials.length&&!state.sourceScopeId&&!state.search&&state.page==='library')return newcomerWelcome();
 return nuBaseLibrary();
};

function newcomerExample(){
 showInfo(nuText('保存之后，能这样找回','Here is what you can do after saving'),nuText('示例资料 · 与你的内容分开','Sample material · separate from your own content'),
 '<article class="nu-example-document"><span class="tag">'+nuText('随手记 · 示例','Note · Sample')+'</span><h3>'+nuText('周末读书会的决定','Weekend reading group decision')+'</h3><p>'+nuText('我们决定周六下午三点在社区图书馆见面。每个人带来一段最喜欢的书摘，先分享，再讨论。','We decided to meet at the community library on Saturday at 3 pm. Everyone will bring a favourite passage to share and discuss.')+'</p><div class="notice"><div><strong>'+nuText('以后搜“图书馆”，或问“读书会几点开始？”','Later, search “library” or ask “When does the reading group start?”')+'</strong><p>'+nuText('回答会保留引用，你可以回到这段原文。','The answer includes a citation so you can return to this note.')+'</p></div></div></article><div class="actions section">'+nuAction(nuText('记下自己的第一条','Write my first note'),'start-note','primary')+'</div>');
}

function enhanceCommonUI(){
 document.body.dataset.surface=state.surface;
 document.body.dataset.round=String(window.MOTE_ROUND||REV);
 const control=document.getElementById('preview-surface');
 if(control){control.value=state.surface;control.disabled=true;control.title=nuText('此文件为独立平台预览','This is a dedicated platform preview');}
 const lab=document.querySelector('.lab-left');
 if(lab)lab.innerHTML='<span class="dot"></span><span>Mote · '+({web:'Web',mac:'Mac',android:'Android'})[state.surface]+' · R'+(window.MOTE_ROUND||REV)+'</span><span class="muted">'+nuText('交互原型 · 演示数据','Interactive prototype · demo data')+'</span>';
 if(!state.authenticated)return;
 const main=document.querySelector('main');
 enhanceOriginalEvidence();
 const toast=document.querySelector('.toast');
 if(toast&&document.body.classList.contains('mobile')&&main){toast.classList.add('inline-toast');main.prepend(toast);}
 const answer=document.querySelector('.message.answer');
 if(answer&&!answer.querySelector('.answer-demo-label'))answer.insertAdjacentHTML('afterbegin','<p class="answer-demo-label"><span class="tag purple">'+nuText('示例回答','Sample answer')+'</span><span>'+nuText('打开引用，可核对原文','Open a citation to verify the original')+'</span></p>');
 const note=state.page==='notes'&&document.querySelector('.reading');
 if(note&&state.noteSaved&&!state.noteDirty&&state.noteNetwork==='online'){
  if(toast&&state.toastAction==='material/'+state.noteSaved)toast.remove();
  note.querySelector(':scope > .notice[role="status"]')?.remove();
  const small=note.querySelector('.fields > .form-actions > .small');if(small)small.hidden=true;
  const feedback=note.querySelector('.fields > .notice.good');
  if(feedback){feedback.classList.add('first-save-result');feedback.innerHTML=icon('check')+'<div><strong>'+nuText('已保存到资料库','Saved to your library')+'</strong><p>'+nuText('可以搜索这条记录，也可以带着问题使用它。','Find this note with search, or ask a question about it.')+'</p><div class="actions">'+goButton(nuText('打开这条笔记','Open this note'),'material/'+state.noteSaved,'text')+button(nuText('基于笔记提问','Ask about this note'),'ask-material','data-id="'+esc(state.noteSaved)+'"','subtle')+'</div></div>';}
 }
 if(note&&!state.materials.length&&!note.querySelector('.first-note-helper'))note.insertAdjacentHTML('afterbegin','<div class="first-note-helper"><span class="step-number">1</span><div><strong>'+nuText('从一句想记住的话开始','Start with something worth remembering')+'</strong><p>'+nuText('保存后到资料库找回，也可以基于这条记录提问。','Find it in your library after saving, or ask a question about it.')+'</p></div></div>');
 const setting=document.querySelector('.sidebar-bottom');
 if(setting&&!setting.querySelector('[data-action="nu-help"]'))setting.insertAdjacentHTML('afterbegin',nuAction(icon('guide')+' '+nuText('开始使用','Getting started'),'help','text'));
}

function newcomerAction(action){
 if(action==='nu-connect-screen'){state.nuSetupReturn='screen';go('setup/device');return true;}
 if(action==='nu-example'){newcomerExample();return true;}
 if(action==='nu-start-note'){state.modal='';go('notes');return true;}
 if(action==='nu-help'){showInfo(nuText('开始使用 Mote','Getting started with Mote'),nuText('先保存，再查找和使用。','Save something, then find and use it.'),'<div class="nu-help-steps"><p><strong>1. '+nuText('保存内容','Save content')+'</strong><br>'+nuText('写随手记、导入文件，或连接持续同步的来源。','Write a note, import a file or connect a source.')+'</p><p><strong>2. '+nuText('找回原文','Find the original')+'</strong><br>'+nuText('在资料库搜索、筛选，并查看出处。','Search and filter your library, then check the source.')+'</p><p><strong>3. '+nuText('提问与回顾','Ask and reflect')+'</strong><br>'+nuText('用问一问核对答案；用记忆和洞察整理长期信息与阶段变化。','Ask questions, or use memories and insights to review what matters.')+'</p></div><div class="actions section">'+goButton(nuText('写一条记录','Write a note'),'notes','primary')+goButton(nuText('查看所有功能','All features'),'guide','subtle')+'</div>');return true;}
 return false;
}

render=function(){nuBaseRender();enhanceCommonUI();if(window.enhancePlatformUI)window.enhancePlatformUI();};
document.addEventListener('click',e=>{const el=e.target.closest('[data-action]');if(!el)return;const action=el.dataset.action;if(!action.startsWith('nu-')&&!action.startsWith('native-'))return;e.preventDefault();e.stopImmediatePropagation();if(window.platformAction&&window.platformAction(action,el))return;newcomerAction(action,el);},true);
document.addEventListener('change',e=>{if(e.target.id==='nu-screen-device'){state.nuScreenTarget=e.target.value;persist();render();}});
window.initializeMoteIteration=function(){state.surface=window.MOTE_SURFACE||state.surface;render();};
