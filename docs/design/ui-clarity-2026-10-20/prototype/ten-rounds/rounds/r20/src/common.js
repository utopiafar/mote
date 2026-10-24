/* Shared UI iteration layer. R19 stays frozen; every round snapshots this file. */
'use strict';
const nuText=(zh,en)=>state.language==='en'?en:zh;
const nuBaseRender=render;
const nuBaseLibrary=libraryPage;
const nuBaseNotes=notesPage;
const nuBaseAsk=askPage;
const nuBaseReset=resetPreviewData;
const nuAction=(label,action,kind='subtle',extra='')=>button(label,'nu-'+action,extra,kind);

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
 '<button class="welcome-source" data-action="go" data-page="setup/folder">'+icon('folder')+'<span><strong>'+nuText('同步文件夹','Sync a folder')+'</strong><small>'+nuText(native?'持续保存所选文件夹的新内容':'连接设备或中央端的文件夹',native?'Keep new files from a chosen folder':'Connect a device or central folder')+'</small></span>'+icon('arrow')+'</button>'+
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
 const note=state.page==='notes'&&document.querySelector('.reading');
 if(note&&!state.materials.length&&!note.querySelector('.first-note-helper'))note.insertAdjacentHTML('afterbegin','<div class="first-note-helper"><span class="step-number">1</span><div><strong>'+nuText('从一句想记住的话开始','Start with something worth remembering')+'</strong><p>'+nuText('保存后到资料库找回，也可以基于这条记录提问。','Find it in your library after saving, or ask a question about it.')+'</p></div></div>');
 const setting=document.querySelector('.sidebar-bottom');
 if(setting&&!setting.querySelector('[data-action="nu-help"]'))setting.insertAdjacentHTML('afterbegin',nuAction(icon('guide')+' '+nuText('开始使用','Getting started'),'help','text','class="nu-help"'));
}

function newcomerAction(action){
 if(action==='nu-example'){newcomerExample();return true;}
 if(action==='nu-start-note'){state.modal='';go('notes');return true;}
 if(action==='nu-help'){showInfo(nuText('开始使用 Mote','Getting started with Mote'),nuText('先保存，再查找和使用。','Save something, then find and use it.'),'<div class="nu-help-steps"><p><strong>1. '+nuText('保存内容','Save content')+'</strong><br>'+nuText('写随手记、导入文件，或连接持续同步的来源。','Write a note, import a file or connect a source.')+'</p><p><strong>2. '+nuText('找回原文','Find the original')+'</strong><br>'+nuText('在资料库搜索、筛选，并查看出处。','Search and filter your library, then check the source.')+'</p><p><strong>3. '+nuText('提问与回顾','Ask and reflect')+'</strong><br>'+nuText('用问一问核对答案；用记忆和洞察整理长期信息与阶段变化。','Ask questions, or use memories and insights to review what matters.')+'</p></div><div class="actions section">'+goButton(nuText('写一条记录','Write a note'),'notes','primary')+goButton(nuText('查看所有功能','All features'),'guide','subtle')+'</div>');return true;}
 return false;
}

render=function(){nuBaseRender();enhanceCommonUI();if(window.enhancePlatformUI)window.enhancePlatformUI();};
document.addEventListener('click',e=>{const el=e.target.closest('[data-action]');if(!el)return;const action=el.dataset.action;if(!action.startsWith('nu-')&&!action.startsWith('native-'))return;e.preventDefault();e.stopImmediatePropagation();if(window.platformAction&&window.platformAction(action,el))return;newcomerAction(action,el);},true);
window.initializeMoteIteration=function(){state.surface=window.MOTE_SURFACE||state.surface;render();};
