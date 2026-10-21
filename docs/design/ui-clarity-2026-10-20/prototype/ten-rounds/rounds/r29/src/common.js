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
const nuBaseCoherentAction=coherentAction;
const nuAction=(label,action,kind='subtle',extra='')=>button(label,'nu-'+action,extra,kind);
go=function(page){if(state.surface==='web'&&page==='setup/folder'&&!state.sources.some(s=>s.id==='folder'))page='setup/folder/new';if(page!==state.page){state.toast='';state.toastAction='';if(state.page==='setup/device')state.nuSetupReturn='';}return nuBaseGo(page);};

function webScreenSetup(){
 const connected=state.devices.filter(d=>['Mac','Android'].includes(d.platform));
 const chosen=connected.find(d=>d.id===state.nuScreenTarget)||connected[0];
 const title=heading(nuText('设备的屏幕记录','Screen capture on your devices'),nuText('由设备采集，保存后在资料库中查找和使用。','Captured on your device, then available in your library.'),goButton(nuText('返回来源','Back to sources'),'sources','subtle'));
 if(!chosen)return title+'<section class="card reading device-first"><span class="step-number">1</span><h2>'+nuText('先连接一台 Mac 或 Android 设备','Connect a Mac or Android device first')+'</h2><p>'+nuText('屏幕记录需要设备上的 Mote 客户端和系统授权。连接后，这里会显示设备及记录状态。','Screen capture needs the Mote app and system permission on that device. Its connection and capture status will appear here.')+'</p><div class="actions section">'+nuAction(nuText('连接设备','Connect a device'),'connect-screen','primary')+goButton(nuText('先写一条记录','Start with a note'),'notes','subtle')+'</div></section>';
 const source=state.sources.find(s=>s.id==='screen'&&(s.deviceId||'mac')===chosen.id);
 return title+'<section class="card reading device-first"><div class="section-head"><div><p class="eyebrow">'+nuText('当前目标设备','CURRENT DEVICE')+'</p><h2 data-user-content>'+esc(chosen.name)+'</h2></div>'+tag(chosen.platform,'purple')+'</div>'+(connected.length>1?'<label class="field"><span>'+nuText('查看设备','View device')+'</span><select class="field-input" id="nu-screen-device">'+connected.map(d=>'<option value="'+esc(d.id)+'" '+(d.id===chosen.id?'selected':'')+'>'+esc(d.name)+'</option>').join('')+'</select></label>':'')+'<div class="notice section"><div><strong>'+nuText('应用范围与系统权限，在这台设备上设置','Set app scope and system permission on this device')+'</strong><p>'+nuText('打开设备上的 Mote → 来源 → 屏幕记录，选择应用并确认。你随时可以在该设备暂停。','Open Mote on the device → Sources → Screen capture. Choose apps and confirm. You can pause on the device at any time.')+'</p></div></div><section class="section"><h3>'+nuText('设备上报的记录状态','Capture status reported by the device')+'</h3><p>'+esc(source?sourceStatusMessage(source.id,source):nuText('还没有上报记录范围。完成设备端设置后，可以回来查看。','No capture scope has been reported yet. Return after setting it up on the device.'))+'</p>'+(source?'<p>'+nuText('已保存应用：','Saved apps: ')+esc(screenAppNames(savedScreenApps()))+'</p>':'')+'</section><div class="actions section">'+goButton(nuText('查看设备状态','View device status'),'devices','primary')+goButton(nuText('返回来源','Back to sources'),'sources','subtle')+'</div></section>';
}
function webFolderSetup(){
 const id=state.page.split('/')[2]||'folder',existing=state.sources.find(s=>s.id===id),config=state.sourceConfigs?.[id]||{};
 const nativeSource=existing&&config.location!=='workspace';
 if(nativeSource||(!existing&&state.nuFolderDevice)){
  const device=state.devices.find(d=>d.id===(existing?(existing.deviceId||'mac'):state.nuFolderDevice));
  const name=device?.name||nuText('来源所在的设备','The source device');
  return heading(nuText('设备上的文件夹','Folders on a device'),nuText('在对应设备选择目录，再由工作台汇集保存结果。','Choose the folder on that device. Saved results are collected in your workspace.'),goButton(nuText('返回来源','Back to sources'),'sources','subtle'))+'<section class="card reading device-first"><p class="eyebrow">'+nuText('目标设备','TARGET DEVICE')+'</p><h2 data-user-content>'+esc(name)+'</h2>'+(existing?'<p data-user-content>'+esc(existing.title)+'</p>':'')+'<div class="notice section"><div><strong>'+nuText('在设备上完成文件夹授权与范围设置','Choose the folder and grant access on the device')+'</strong><p>'+nuText('打开这台设备的 Mote → 来源 → 文件夹同步。选择一个目录，确认保存方式，随时可以在设备端暂停。','Open Mote on this device → Sources → Folder sync. Choose a folder and storage mode. You can pause it from that device at any time.')+'</p></div></div><div class="actions section">'+goButton(nuText('查看设备状态','View device status'),'devices','primary')+nuAction(nuText('改为工作台服务器目录','Use a workspace server folder'),'folder-server','subtle')+'</div></section>';
 }
 return nuBaseSetup();
}
setupPage=function(){if(state.surface==='web'){if(state.page==='setup/screen')return webScreenSetup();if(state.page.startsWith('setup/folder'))return webFolderSetup();}return nuBaseSetup();};
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
 if(action==='connect-device'&&['screen','folder'].includes(state.nuSetupReturn)){
  const intent=state.nuSetupReturn,target=el.dataset.device.toLowerCase();state.nuSetupReturn='';nuBaseDoAction(action,el);
  if(intent==='screen')state.nuScreenTarget=target;else state.nuFolderDevice=target;
  persist();go(intent==='screen'?'setup/screen':'setup/folder/new');return;
 }
 if(action==='save-source'&&state.surface==='web'&&el.dataset.kind==='folder'){
  const before=new Set(state.sources.map(s=>s.id)),requested=el.dataset.id;
  nuBaseDoAction(action,el);
  const source=state.sources.find(s=>!before.has(s.id)&&sourceKind(s.id)==='folder')||state.sources.find(s=>s.id===requested);
  if(source){const cfg=state.sourceConfigs[source.id]||{};state.sourceConfigs[source.id]={...cfg,location:'workspace'};source.subtitle='工作台服务器 · '+(cfg.folderPath||'');source.deviceId='workspace';persist();render();}
  return;
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
 const date=new Date(),now=date.toISOString(),day=date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');
 return {...record,createdAt:previous?.createdAt||now,updatedAt:now,saved:previous?.saved||day};
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
 const details='<dl class="original-metadata"><div><dt>'+nuText('内容来源','Content source')+'</dt><dd data-user-content>'+esc(source)+'</dd></div><div><dt>'+nuText(recorded?'保存时间（本地）':material.type==='calendar'?'事件时间':'记录时间',recorded?'Saved at (local time)':material.type==='calendar'?'Event time':'Recorded time')+'</dt><dd><time'+(recorded?' datetime="'+esc(recorded)+'"':'')+'>'+esc(when)+'</time></dd></div><div><dt>'+nuText('存入资料库日期','Added to the library')+'</dt><dd><time datetime="'+esc(materialSavedDate(material))+'">'+esc(materialSavedDate(material))+'</time></dd></div>'+(device?'<div><dt>'+nuText('保存端','Saved from')+'</dt><dd data-user-content>'+esc(device)+'</dd></div>':'')+'</dl>';
 box.querySelector('strong')?.insertAdjacentHTML('afterend',details);
}

function enhanceEvidenceDates(){
 if(state.page.startsWith('material/')){
  const material=state.materials.find(m=>m.id===state.page.split('/')[1]),meta=document.querySelector('.reading-meta');
  if(material&&meta){const dateSpan=meta.querySelectorAll(':scope > span')[1];if(dateSpan)dateSpan.textContent=nuText(material.type==='calendar'?'事件时间：':'记录时间：',material.type==='calendar'?'Event time: ':'Recorded time: ')+material.date;meta.insertAdjacentHTML('beforeend','<span class="material-saved-date">'+nuText('存入资料库：','Added to library: ')+'<time datetime="'+esc(materialSavedDate(material))+'">'+esc(materialSavedDate(material))+'</time></span>');}
 }
 const list=document.querySelector('.insight-sources > .actions'),report=state.insightReports.find(r=>r.id===state.currentInsightId);
 if(!list||!report)return;
 const materials=(report.ids||[]).map(id=>state.materials.find(m=>m.id===id)).filter(Boolean);
 list.classList.add('insight-evidence-list');
 list.innerHTML=materials.map(m=>'<article class="insight-evidence-row">'+goButton(m.title,'material/'+m.id,'text')+'<small>'+nuText('存入资料库：','Added to library: ')+'<time datetime="'+esc(materialSavedDate(m))+'">'+esc(materialSavedDate(m))+'</time>'+(m.type==='calendar'?'<span>'+nuText('事件时间：','Event time: ')+esc(m.date)+'</span>':'')+'</small></article>').join('');
 if(materials.some(m=>m.type==='calendar'))list.insertAdjacentHTML('beforebegin','<p class="small muted">'+nuText('纳入范围使用资料存入日期；日程另列事件发生时间。','Inclusion uses the date added to the library. Calendar items list their event time separately.')+'</p>');
}

function enhanceImportHandoff(){
 if(state.page!=='import'||state.importDone)return;
 const form=document.querySelector('main .reading');
 if(!form||form.querySelector('.import-mode-handoff'))return;
 form.querySelectorAll('[data-page="setup/folder"]').forEach(link=>{const holder=link.parentElement;if(holder?.classList.contains('section')&&holder.children.length===1)holder.remove();else link.remove();});
 form.insertAdjacentHTML('afterbegin','<section class="import-mode-handoff"><div><strong>'+nuText('这次导入，保存一份当前文件','This import saves the current files once')+'</strong><p>'+nuText('想自动收集以后的新增和修改？连接文件夹后会持续接收。','To keep future additions and edits automatically, connect the folder as a source.')+'</p></div>'+goButton(nuText('改为持续同步文件夹','Connect a folder instead'),'setup/folder/new','subtle')+'</section>');
}

function enhanceFolderSaveMode(){
 const select=document.getElementById('save-mode');
 if(!state.page.startsWith('setup/folder')||!select)return;
 const labels=[
  ['中央保留原件，本机按需清理',nuText('工作台保留原件，清理 Mote 暂存副本','Keep originals in the workspace; clear Mote staging copies')],
  ['本机与中央都保留',nuText('本机与工作台都保留 Mote 副本','Keep Mote copies locally and in the workspace')],
  ['仅保存引用',nuText('仅保存文件引用','Save file references only')]
 ];
 [...select.options].forEach((option,i)=>{if(labels[i]){option.value=labels[i][0];option.textContent=labels[i][1];}});
 select.setAttribute('aria-describedby','nu-save-mode-help');
 if(!document.getElementById('nu-save-mode-help'))select.insertAdjacentHTML('afterend','<small id="nu-save-mode-help" class="save-mode-helper" aria-live="polite"></small>');
 updateFolderSaveHelp();
}

function updateFolderSaveHelp(){
 const select=document.getElementById('save-mode'),help=document.getElementById('nu-save-mode-help');if(!select||!help)return;
 const descriptions=[
  nuText('工作台确认收到后，可清理 Mote 生成的待传副本。你选择的文件夹中的原文件保留。','After the workspace confirms receipt, Mote’s staging copies can be cleared. Original files in the folder you selected remain there.'),
  nuText('保留 Mote 的本机副本和工作台归档。你选择的文件夹中的原文件保持原样。','Keep Mote’s local copies and the workspace archive. Original files in your selected folder stay unchanged.'),
  nuText('只保存名称、位置等文件信息，不读取或上传正文。原文件留在原位置。','Save file details such as names and locations without reading or uploading their contents. The original files stay where they are.')
 ];
 help.textContent=descriptions[select.selectedIndex]||descriptions[0];
}

function enhanceWebFolderTarget(){
 if(state.surface!=='web')return;
 document.querySelectorAll('.source-row[data-source-id]').forEach(row=>{const id=row.dataset.sourceId,cfg=state.sourceConfigs?.[id];if(cfg?.location==='workspace'){const text=row.querySelector('.source-main p');if(text)text.textContent=nuText('工作台服务器 · ','Workspace server · ')+(cfg.folderPath||'');}});
 if(!state.page.startsWith('setup/folder'))return;
 const path=document.getElementById('folder-path'),fields=document.querySelector('.reading.fields');
 if(!path)return;
 const container=fields||path.closest('.fields')||path.parentElement.parentElement;
 const headingEl=document.querySelector('.page-heading h1'),description=document.querySelector('.page-heading p');
 const id=state.page.split('/')[2]||'folder',existing=state.sources.find(s=>s.id===id);
 if(headingEl)headingEl.textContent=nuText(existing?'管理工作台服务器文件夹':'连接工作台服务器文件夹',existing?'Manage a workspace server folder':'Connect a workspace server folder');
 if(description)description.textContent=nuText(existing?'查看这个服务器目录的范围、保存方式与接收状态。':'连接当前工作台服务器能访问的目录，持续保存后续变化。',existing?'Review this server folder’s scope, storage and receiving state.':'Connect a folder accessible to the current workspace server and keep later changes.');
 const caption=path.closest('label')?.querySelector('span');if(caption)caption.textContent=nuText('服务器文件夹路径','Server folder path');
 path.placeholder='/srv/mote/files/…';
 const small=path.closest('label')?.querySelector('small');if(small)small.textContent=nuText('这是工作台服务器上的目录，不是浏览器所在电脑的路径。','This is a folder on the workspace server, separate from the computer running this browser.');
 if(!existing&&path.value==='~/Documents/研究资料')path.value='';
 if(!container.querySelector('.workspace-folder-target'))container.insertAdjacentHTML('afterbegin','<section class="workspace-folder-target notice"><div><strong>'+nuText('目标：当前工作台服务器','Target: current workspace server')+'</strong><p>'+nuText('Mac 或手机上的文件夹需要在对应设备选择与授权。','Folders on a Mac or phone must be chosen and authorized on that device.')+'</p>'+nuAction(nuText('连接 Mac 或 Android 设备','Connect a Mac or Android device'),'connect-folder-device','text')+'</div></section>');
 if(!path.parentElement.querySelector('[data-action="nu-server-folder-example"]'))path.insertAdjacentHTML('afterend',nuAction(nuText('填入示例服务器目录','Use a sample server folder'),'server-folder-example','text'));
}

function clarifyFolderLocationCopy(){
 if(!state.page.startsWith('setup/folder'))return;
 const paragraphs=document.querySelectorAll('main p,main .notice');
 const phrases=['保存方式决定两处是否保留原件','The storage method determines whether each location retains originals.'];
 paragraphs.forEach(node=>{if(node.children.length>0)return;if(phrases.some(s=>node.textContent.includes(s)))node.textContent=nuText('工作台负责保存归档；设备端管理 Mote 的本机副本。文件夹中的原文件与 Mote 副本分别管理。','The workspace stores the archive; the device manages Mote’s local copies. Files in your selected folder are separate from Mote’s copies.');});
}

function enhanceGeneratedMemoryDraft(){
 const editor=document.getElementById('generated-memory-text');
 if(editor&&state.generatedMemoryDraft!=null)editor.value=state.generatedMemoryDraft;
 const badge=document.querySelector('[data-memory-id="generated"] > .flex-spread .tag');
 if(badge){const version=memoryVersions('generated').length;if(version>1){badge.textContent=nuText('已保存 · 版本 '+version,'Saved · Version '+version);badge.setAttribute('role','status');}}
}

coherentAction=function(action,el){
 if(action!=='save-generated-memory')return nuBaseCoherentAction(action,el);
 const editor=document.getElementById('generated-memory-text');
 const content=state.generatedMemoryDraft??editor?.value??state.generatedMemoryText??'';
 if(!content.trim()){notify(nuText('请保留记忆内容。','Keep some text in the memory.'));return true;}
 if(content!==state.generatedMemoryText){state.generatedMemoryHistory=state.generatedMemoryHistory||[];state.generatedMemoryHistory.push(content);recordMemoryVersion('generated',content);}
 state.generatedMemoryText=content;state.generatedMemoryDraft=null;state.modal='';persist();render();return true;
};

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
 enhanceEvidenceDates();
 enhanceGeneratedMemoryDraft();
 enhanceImportHandoff();
 enhanceFolderSaveMode();
 enhanceWebFolderTarget();
 clarifyFolderLocationCopy();
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
 if(action==='nu-connect-folder-device'){state.nuSetupReturn='folder';go('setup/device');return true;}
 if(action==='nu-folder-server'){state.nuFolderDevice='';go('setup/folder/new');return true;}
 if(action==='nu-server-folder-example'){const path=document.getElementById('folder-path'),name=document.getElementById('source-name');if(path){path.value='/srv/mote/files/阅读资料';path.dispatchEvent(new Event('input',{bubbles:true}));}if(name&&!name.value){name.value=nuText('服务器阅读资料','Server reading materials');name.dispatchEvent(new Event('input',{bubbles:true}));}path?.focus();return true;}
 if(action==='nu-connect-screen'){state.nuSetupReturn='screen';go('setup/device');return true;}
 if(action==='nu-example'){newcomerExample();return true;}
 if(action==='nu-start-note'){state.modal='';go('notes');return true;}
 if(action==='nu-help'){showInfo(nuText('开始使用 Mote','Getting started with Mote'),nuText('先保存，再查找和使用。','Save something, then find and use it.'),'<div class="nu-help-steps"><p><strong>1. '+nuText('保存内容','Save content')+'</strong><br>'+nuText('写随手记、导入文件，或连接持续同步的来源。','Write a note, import a file or connect a source.')+'</p><p><strong>2. '+nuText('找回原文','Find the original')+'</strong><br>'+nuText('在资料库搜索、筛选，并查看出处。','Search and filter your library, then check the source.')+'</p><p><strong>3. '+nuText('提问与回顾','Ask and reflect')+'</strong><br>'+nuText('用问一问核对答案；用记忆和洞察整理长期信息与阶段变化。','Ask questions, or use memories and insights to review what matters.')+'</p></div><div class="actions section">'+goButton(nuText('写一条记录','Write a note'),'notes','primary')+goButton(nuText('查看所有功能','All features'),'guide','subtle')+'</div>');return true;}
 return false;
}

render=function(){nuBaseRender();enhanceCommonUI();if(window.enhancePlatformUI)window.enhancePlatformUI();};
document.addEventListener('click',e=>{const el=e.target.closest('[data-action]');if(!el)return;const action=el.dataset.action;if(!action.startsWith('nu-')&&!action.startsWith('native-'))return;e.preventDefault();e.stopImmediatePropagation();if(window.platformAction&&window.platformAction(action,el))return;newcomerAction(action,el);},true);
document.addEventListener('change',e=>{if(e.target.id==='nu-screen-device'){state.nuScreenTarget=e.target.value;persist();render();}if(e.target.id==='save-mode')updateFolderSaveHelp();});
window.initializeMoteIteration=function(){state.surface=window.MOTE_SURFACE||state.surface;render();};
