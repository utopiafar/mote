/* Platform presentation adapters. The original R19 actions remain the source of UI behavior. */
(() => {
  'use strict';
  const tr = (zh, en) => state.language === 'en' ? en : zh;
  const native = {menuOpen:false, routes:[], lastPage:'', popping:false};
  const isAndroid = () => state.surface === 'android';
  const isMac = () => state.surface === 'mac';
  const device = () => isAndroid() ? 'Android' : 'Mac';
  const action = (label, name, cls='', attrs='') => '<button type="button" class="'+cls+'" data-action="'+name+'" '+attrs+'>'+label+'</button>';
  const route = (label, page, cls='') => action(label,'go',cls,'data-page="'+page+'"');
  const localScreen = () => state.sources.find(s=>s.id==='screen');
  function screenState(){
    if(!localScreen())return tr('尚未开启','Not set up');
    if(state.permission!=='已授权')return tr('等待权限','Permission needed');
    if(state.sourcePaused.screen)return tr('已暂停','Paused');
    return tr('正在记录','Recording');
  }
  function folderState(){
    const rows=state.sources.filter(s=>sourceKind(s.id)==='folder');
    if(!rows.length)return tr('尚未连接','Not connected');
    const active=rows.filter(s=>!state.sourcePaused[s.id]);
    return active.length ? tr(active.length+' 个正在接收',active.length+' receiving') : tr('已暂停接收','Receiving paused');
  }
  function adaptAndroidFixtures(){
    if(!isAndroid())return false;
    let changed=false;
    for(const s of state.sources){
      if(s.id==='screen'&&s.title==='Mac 屏幕'){s.title='Android 屏幕';s.subtitle='Android · 已保存的应用范围';changed=true;}
      if(s.id==='folder'&&s.subtitle==='Mac · ~/Documents/研究资料'){s.subtitle='Android · Documents/研究资料';changed=true;}
      if(sourceKind(s.id)==='folder'&&s.subtitle.startsWith('Mac · ')){s.subtitle=s.subtitle.replace(/^Mac · /,'Android · ');changed=true;}
    }
    for(const m of state.materials){
      if(['folder','screen'].includes(m.sourceId)&&m.device==='Mac'){
        m.device='Android';m.deviceId='android';
        if(m.source==='Mac 屏幕')m.source='Android 屏幕';
        if(typeof m.origin==='string')m.origin=m.origin.replace('Mac 屏幕','Android 屏幕').replace('~/Documents/','Documents/');
        changed=true;
      }
    }
    return changed;
  }
  const originalSubtitle=sourceSubtitle;
  sourceSubtitle=function(s){const result=originalSubtitle(s);return isAndroid()&&s.id==='screen'?result.replace(/^Mac · /,'Android · '):result;};
  const originalAppNames=screenAppNames;
  const originalPlatformReset=resetPreviewData;
  resetPreviewData=function(value){state.nativeFolderDrafts={};return originalPlatformReset(value);};
  const androidApps={browser:['浏览器','Browser','记录所选浏览器中的屏幕内容','Record screen content in the selected browser'],editor:['笔记与文档','Notes & documents','记录阅读和编辑时的屏幕内容','Record screen content while reading or editing'],messaging:['即时通讯','Messaging','只纳入你允许的应用','Include only apps you allow']};
  screenAppNames=function(ids){return isAndroid()?ids.map(id=>androidApps[id]?tr(androidApps[id][0],androidApps[id][1]):id).join(state.language==='en'?', ':'、'):originalAppNames(ids);};
  function folderRouteKey(){return state.page.startsWith('setup/folder')?state.page:'';}
  function readFolderDraft(){
    const key=folderRouteKey();if((!isAndroid()&&!isMac())||!key||!document.getElementById('folder-path'))return;
    const draft={folderPath:document.getElementById('folder-path').value,name:document.getElementById('source-name')?.value||'',continuous:document.getElementById('continuous')?.checked!==false,saveMode:document.getElementById('save-mode')?.value||''};
    state.nativeFolderDrafts={...(state.nativeFolderDrafts||{}),[key]:draft};
    if(key==='setup/folder/new')state.newFolderDraft={...draft};persist();
  }

  function devicePanel(){
    const folders=state.sources.filter(s=>sourceKind(s.id)==='folder');
    const folderDescription=folders.length===1?tr('已连接：','Connected: ')+'<span data-user-content>'+esc(folders[0].title)+'</span>':folders.length>1?tr('已连接 '+folders.length+' 个文件夹，各自管理范围。',folders.length+' folders connected, each with its own scope.'):tr('选一个目录，保存之后的变化。','Choose a folder and keep later changes.');
    const manageFolder=folders.length===1?route(tr(state.sourcePaused[folders[0].id]?'恢复或管理此文件夹':'管理此文件夹',state.sourcePaused[folders[0].id]?'Resume or manage this folder':'Manage this folder'),sourceSetupRoute(folders[0].id),'btn primary'):folders.length>1?action(tr('查看已连接的 '+folders.length+' 个文件夹','View '+folders.length+' connected folders'),'native-folder-list','btn primary'):'';
    return '<section class="native-device-panel" aria-label="'+tr('本机收集','Collection on this device')+'"><div class="native-device-heading"><div><span class="native-overline">'+tr('这台设备','THIS DEVICE')+'</span><h2>'+tr('在这台 '+device()+' 上收集','Collect on this '+device())+'</h2></div><span class="tag">'+tr('范围由你选择','You choose the scope')+'</span></div><div class="native-source-grid">'+
      '<article class="native-source-card"><span class="native-source-icon">'+icon('screen')+'</span><div><h3>'+tr('屏幕记录','Screen recording')+'</h3><p>'+tr('只记录选定应用，随时暂停。','Record selected apps and pause any time.')+'</p><span class="native-source-state">'+screenState()+'</span></div>'+route(tr('选择屏幕范围','Choose screen scope'),'setup/screen','btn')+'</article>'+
      '<article class="native-source-card"><span class="native-source-icon">'+icon('folder')+'</span><div><h3>'+tr('文件夹同步','Folder sync')+'</h3><p>'+folderDescription+'</p><span class="native-source-state">'+folderState()+'</span></div>'+manageFolder+route(tr(folders.length?'连接另一个文件夹':'连接一个文件夹',folders.length?'Connect another folder':'Connect a folder'),'setup/folder/new','btn'+(folders.length?' text':''))+'</article></div><p class="native-device-foot">'+tr('保存后的内容进入资料库，可查找、提问并核对原文。','Saved content goes to your Library to search, ask about and verify.')+'</p></section>';
  }
  function macMenu(){
    return '<section class="native-menu-popover" aria-label="'+tr('菜单栏收集状态','Menu bar collection status')+'"><div class="native-popover-head"><strong>Mote</strong>'+action('×','native-menu-close','native-icon-button','aria-label="'+tr('关闭菜单','Close menu')+'"')+'</div><p>'+tr('这台 Mac 的收集状态','Collection on this Mac')+'</p><div class="native-menu-status"><span>'+tr('屏幕记录','Screen recording')+'</span><strong>'+screenState()+'</strong></div><div class="native-menu-status"><span>'+tr('文件夹同步','Folder sync')+'</span><strong>'+folderState()+'</strong></div><div class="native-menu-actions">'+(localScreen()?action(tr(state.sourcePaused.screen?'恢复屏幕记录':'暂停屏幕记录',state.sourcePaused.screen?'Resume screen recording':'Pause screen recording'),'pause-source','btn','data-id="screen"'):route(tr('设置屏幕范围','Set screen scope'),'setup/screen','btn'))+route(tr('管理本机来源','Manage local sources'),'sources','btn')+route(tr('写随手记','Quick note'),'notes','btn primary')+'</div><p class="small muted">'+tr('屏幕与文件夹各自控制。','Screen recording and folder sync have separate controls.')+'</p></section>';
  }
  function macChrome(){
    return '<div class="native-mac-system" data-native-chrome><div class="native-mac-menu-left"><span class="native-mac-symbol" aria-hidden="true">◈</span><strong>Mote</strong><span>'+tr('文件','File')+'</span><span>'+tr('显示','View')+'</span></div><div class="native-mac-menu-right">'+action('<span class="native-menu-mark">m</span><span>'+tr('收集状态','Collection')+'</span>','native-menu-toggle','native-tray-button','aria-expanded="'+native.menuOpen+'" aria-label="'+tr('Mote 菜单栏收集状态','Mote menu bar collection status')+'"')+'<span aria-hidden="true">09:41</span></div></div><div class="native-mac-titlebar" data-native-chrome><div class="native-traffic-lights" aria-hidden="true"><i></i><i></i><i></i></div><span class="native-window-title">Mote <span>· '+tr('个人资料库','Personal library')+'</span></span><div class="native-window-actions">'+action(icon('search')+'<span>⌘ K</span>','native-search','native-window-search','aria-label="'+tr('搜索资料，快捷键 Command K','Search materials, Command K')+'"')+'</div></div>'+(native.menuOpen?macMenu():'');
  }
  function mobileAppbar(){
    const top=['library','ask','sources','activity','today'].includes(state.page);
    const labels={library:tr('资料库','Library'),ask:tr('问一问','Ask'),sources:tr('来源','Sources'),activity:tr('活动','Activity'),today:tr('今天','Today')};
    return '<div class="native-android-appbar-left">'+(!top?action(icon('back'),'native-back','native-icon-button','aria-label="'+tr('返回上一页','Back')+'"'):'<span class="brand-icon" aria-hidden="true">m</span>')+'<span class="native-android-title">'+(top?(labels[state.page]||'Mote'):'Mote')+'</span></div><div class="native-android-appbar-right">'+action(icon('plus'),'add','native-icon-button','aria-label="'+tr('添加内容','Add content')+'" aria-haspopup="dialog"')+action(icon('more'),'compact-pages','native-icon-button','aria-label="'+tr('更多页面与设置','More pages and settings')+'" aria-haspopup="dialog"')+'</div>';
  }
  function androidStatusbar(){
    return '<div class="native-android-statusbar" data-native-chrome aria-hidden="true"><span>9:41</span><span class="native-camera-dot"></span><span class="native-device-indicators"><svg viewBox="0 0 35 14" width="35" height="14"><path d="M2 12h2V9H2zm5 0h2V6H7zm5 0h2V3h-2z" fill="currentColor"/><rect x="20" y="3" width="12" height="8" rx="2" fill="none" stroke="currentColor"/><path d="M33 5v4" stroke="currentColor"/><rect x="22" y="5" width="7" height="4" fill="currentColor"/></svg><span>84%</span></span></div>';
  }
  function setupAdaptation(){
    if(!['setup/screen','setup/folder','setup/folder/new'].includes(state.page)&&!state.page.startsWith('setup/folder/'))return;
    const fields=document.querySelector('main > .fields');
    if(!fields||fields.querySelector('.native-setup-context'))return;
    let title='',description='';
    if(state.page==='setup/screen'){
      title=isAndroid()?tr('Android · 屏幕录制权限','Android · screen capture permission'):tr('Mac · 屏幕录制权限','Mac · screen recording permission');
      description=isAndroid()?tr('先选择应用范围，再确认系统录屏授权。此处用“模拟允许 / 拒绝”预览两种状态。','Choose the apps, then confirm system screen capture permission. Use the demo allow/deny controls here to preview both states.'):tr('系统设置 → 隐私与安全性 → 屏幕录制。此处用模拟授权查看流程，应用范围由下方选择。','System Settings → Privacy & Security → Screen Recording. Preview permission states below, then choose the allowed apps.');
      if(isAndroid()){
        fields.querySelectorAll('[data-screen-app]').forEach(input=>{const labels=androidApps[input.dataset.screenApp],span=input.parentElement.querySelector('span');if(labels&&span)span.innerHTML=esc(tr(labels[0],labels[1]))+'<small>'+esc(tr(labels[2],labels[3]))+'</small>';});
      }
    }else{
      title=isAndroid()?tr('Android · 选择本机目录','Android · choose a local folder'):tr('Mac · 选择本机文件夹','Mac · choose a local folder');
      description=isAndroid()?tr('系统文件选择器只授予你选中目录的访问权限。下方路径用于预览；不读取手机文件。','The system folder picker grants access to the selected folder. The path below is a preview and does not read phone files.'):tr('通过 Finder 选择一个文件夹。同步范围与屏幕记录分别控制。','Choose one folder in Finder. Folder sync and screen recording have separate scopes.');
      if(isAndroid()){
        const key=folderRouteKey(),parts=state.page.split('/'),creating=parts[2]==='new',id=creating?'':parts[2]||'folder',existing=state.sources.find(s=>s.id===id);
        const titleEl=document.querySelector('main .page-heading h1'),descEl=document.querySelector('main .page-heading p');
        if(titleEl)titleEl.textContent=existing?tr('管理手机文件夹','Manage phone folder'):tr('连接手机文件夹','Connect a phone folder');
        if(descEl)descEl.textContent=existing?tr('核对这个目录的范围、保存方式与接收状态。','Review this folder’s scope, storage and receiving state.'):state.sources.some(s=>sourceKind(s.id)==='folder')?tr('再选一个手机目录，分别管理它的范围与同步状态。','Choose another phone folder and manage its scope and sync separately.'):tr('选择第一个手机目录，持续保存新文件与后续变化。','Choose your first phone folder and keep new files and later changes.');
        const path=document.getElementById('folder-path');
        if(path&&path.value==='~/Documents/研究资料')path.value='Documents/研究资料';
        const draft=state.nativeFolderDrafts?.[key];
        if(draft){if(path)path.value=draft.folderPath;const name=document.getElementById('source-name');if(name)name.value=draft.name;}
        if(path){path.placeholder=tr('选择手机上的一个目录','Choose a folder on this phone');const label=path.closest('label');const caption=label?.querySelector('span');if(caption)caption.textContent=tr('手机文件夹','Phone folder');const help=label?.querySelector('small');if(help)help.textContent=tr('只访问你选择的目录。','Only the selected folder is accessible.');if(label)label.insertAdjacentHTML('afterend',action(icon('folder')+' '+tr('选择手机文件夹','Choose phone folder'),'native-folder-picker','btn native-folder-picker'));}
        fields.querySelectorAll('p').forEach(p=>{if(p.textContent.includes('本机指这台电脑')||p.textContent.includes('local means this computer'))p.textContent=tr('中央指你的 Mote 工作台存储；本机指这台手机。保存方式决定两处是否保留原件。','Central means your Mote workspace storage; local means this phone. The save mode determines where originals are retained.');});
        if(!existing){const continuous=document.getElementById('continuous')?.closest('label')?.querySelector('small');if(continuous)continuous.textContent=tr('连接后接收这个目录的后续变化。暂停时保留已有资料。','Receive later changes after connecting. Pausing keeps saved materials.');}
      }else{
        const key=folderRouteKey(),parts=state.page.split('/'),creating=parts[2]==='new',id=creating?'':parts[2]||'folder',existing=state.sources.find(s=>s.id===id),draft=state.nativeFolderDrafts?.[key];
        const titleEl=document.querySelector('main .page-heading h1'),descEl=document.querySelector('main .page-heading p');
        if(titleEl)titleEl.textContent=existing?tr('管理 Mac 文件夹','Manage Mac folder'):tr('连接 Mac 文件夹','Connect a Mac folder');
        if(descEl)descEl.textContent=existing?tr('核对这个目录的范围、保存方式与接收状态。','Review this folder’s scope, storage and receiving state.'):state.sources.some(s=>sourceKind(s.id)==='folder')?tr('再选一个 Mac 文件夹，分别管理它的范围与同步状态。','Choose another Mac folder and manage its scope and sync separately.'):tr('选择第一个 Mac 文件夹，持续保存新文件与后续变化。','Choose your first Mac folder and keep new files and later changes.');
        const path=document.getElementById('folder-path'),name=document.getElementById('source-name');
        if(draft){if(path)path.value=draft.folderPath;if(name)name.value=draft.name;}
        else if(!existing){if(path)path.value='';if(name)name.value='';}
        if(path){path.placeholder=tr('选择这台 Mac 上的一个文件夹','Choose a folder on this Mac');const label=path.closest('label'),caption=label?.querySelector('span');if(caption)caption.textContent=tr('Mac 文件夹','Mac folder');const help=label?.querySelector('small');if(help)help.textContent=tr('仅同步所选文件夹；路径可在这里核对。','Sync only the selected folder; review its path here.');if(label)label.insertAdjacentHTML('afterend',action(icon('folder')+' '+tr('在 Finder 中选择','Choose in Finder'),'native-folder-picker','btn native-folder-picker'));}
        if(!existing){const continuous=document.getElementById('continuous')?.closest('label')?.querySelector('small');if(continuous)continuous.textContent=tr('连接后接收这个文件夹的后续变化。暂停时保留已有资料。','Receive later changes after connecting. Pausing keeps saved materials.');}
      }
    }
    fields.insertAdjacentHTML('afterbegin','<section class="native-setup-context"><span>'+icon(state.page==='setup/screen'?'shield':'folder')+'</span><div><h2>'+title+'</h2><p>'+description+'</p></div></section>');
  }
  function sourceControlFeedback(){
    if(!state.page.startsWith('setup/'))return;
    const parts=state.page.split('/'),kind=parts[1],id=kind==='folder'?(parts[2]||'folder'):kind;
    if(!['folder','screen'].includes(kind)||id==='new')return;
    const source=state.sources.find(s=>s.id===id),actions=document.querySelector('main > .fields > .form-actions');
    if(!source||!actions||document.querySelector('[data-native-source-feedback]'))return;
    if(state.setupSaved[id]){
      const savedText=state.language==='en'?translateUI(state.setupSaved[id]):state.setupSaved[id];
      document.querySelectorAll('main > .fields > .notice.good:not([data-source-receiving])').forEach(el=>{if(el.innerText.trim()===savedText)el.remove();});
    }
    const paused=!!state.sourcePaused[id],continuous=state.sourceConfigs?.[id]?.continuous!==false;
    const status=sourceStatus(id,source),label=state.language==='en'?translateUI(status):status;
    let message='',quiet=paused;
    if(kind==='folder'){
      message=paused?tr('当前暂停接收。已有资料仍可阅读，已保存的同步策略保留。','Receiving is paused. Saved materials remain readable, and the saved sync policy is retained.'):continuous?tr('正在按已保存的策略接收目录变化。可以单独暂停这个来源。','Receiving folder changes using the saved policy. You can pause this source separately.'):tr('已连接，暂不持续接收后续变化。调整同步策略并保存后生效。','Connected, with continuous receiving off. Change and save the sync policy to enable it.');
      quiet=paused||!continuous;
      const input=document.getElementById('continuous'),caption=input?.closest('label')?.querySelector('span');
      if(caption)caption.innerHTML=tr('同步策略：持续同步后续变化','Sync policy: continuously receive later changes')+'<small>'+tr('已保存的策略：'+(continuous?'持续同步':'不持续接收')+'。暂停时保留；修改勾选后点击“保存设置”生效。','Saved policy: '+(continuous?'continuous sync':'continuous receiving off')+'. Pausing retains this setting; changes take effect after Save settings.')+'</small>';
    }else{
      if(state.permission!=='已授权'){
        quiet=true;message=tr('当前不会记录屏幕。需要允许系统权限并保存应用范围。','Screen recording is off. Allow system permission and save the app scope first.')+(paused?tr(' 此来源也处于暂停状态。',' This source is also paused.'):'');
      }else message=paused?tr('当前暂停屏幕记录。已保存的应用范围和已有资料保留。','Screen recording is paused. The saved app scope and existing materials are retained.'):tr('正在按已保存的应用范围记录。修改应用勾选后需要保存范围。','Recording the saved app scope. Save the scope after changing app selections.');
    }
    actions.insertAdjacentHTML('beforebegin','<section class="native-source-feedback '+(quiet?'is-paused':'is-receiving')+'" data-native-source-feedback role="status" aria-live="polite"><div><span class="native-source-feedback-dot"></span><strong>'+tr('当前状态：','Current state: ')+esc(label)+'</strong></div><p>'+message+'</p></section>');
  }
  function refineExistingSourceLayout(){
    if((!isMac()&&!isAndroid())||!state.page.startsWith('setup/'))return;
    const parts=state.page.split('/'),kind=parts[1],id=kind==='folder'?(parts[2]||'folder'):kind;
    if(!['folder','screen'].includes(kind)||id==='new')return;
    const source=state.sources.find(s=>s.id===id),fields=document.querySelector('main > .fields'),feedback=fields?.querySelector('[data-native-source-feedback]');
    if(!source||!fields||!feedback||fields.querySelector('.native-current-source'))return;
    fields.classList.add('native-existing-source');
    const current=document.createElement('section');current.className='native-current-source';current.setAttribute('aria-label',tr('当前来源状态与范围','Current source state and scope'));
    const controls=document.createElement('div');controls.className='native-current-actions';
    const pause=fields.querySelector(':scope > .form-actions [data-action="pause-source"]'),browse=fields.querySelector(':scope > [data-action="browse-source"]');
    if(pause)controls.append(pause);if(browse)controls.append(browse);
    const scope=fields.querySelector(kind==='screen'?'[data-saved-screen-range]':':scope > .evidence-box');
    if(kind==='folder'&&scope){
      const cfg=state.sourceConfigs?.[id]||{},savedPath=cfg.folderPath||source.subtitle.replace(/^(Mac|Android) · /,'');
      scope.classList.add('native-saved-folder');
      scope.innerHTML='<h2>'+tr('已连接的文件夹','Connected folder')+'</h2><p data-user-content><strong>'+esc(source.title)+'</strong><span>'+esc(savedPath)+'</span></p>';
    }
    feedback.append(controls);current.append(feedback);if(scope)current.append(scope);
    fields.querySelector(':scope > [data-source-receiving]')?.remove();
    const context=fields.querySelector(':scope > .native-setup-context');
    if(context){
      const help=document.createElement('details');help.className='native-setup-help';
      help.innerHTML='<summary>'+tr(kind==='screen'?'权限与收集说明':'文件夹访问说明',kind==='screen'?'Permission and capture help':'Folder access help')+'</summary>';
      help.append(context);
      if(kind==='screen'&&state.permission==='已授权'){
        const permission=[...fields.querySelectorAll(':scope > .notice')].find(el=>el.querySelector('[data-action="allow-screen"]'));
        if(permission)help.append(permission);
      }
      fields.prepend(help);
    }
    fields.prepend(current);
    if(kind==='folder'){
      const path=fields.querySelector('#folder-path')?.closest('label');
      if(path)path.insertAdjacentHTML('beforebegin','<h2 class="native-edit-heading">'+tr('修改范围与保存设置','Edit scope and storage settings')+'</h2>');
    }
  }
  function refreshRelationshipSummary(panel){
    const id=panel.dataset.sourceContextId,details=panel.closest('.native-context-disclosure'),summary=details?.querySelector(':scope > summary');
    if(!summary)return;
    const saved=savedSourceContext(id),dirty=sourceContextDirty(id),hasSaved=!!(saved.ownerRelation||saved.contextDescription);
    const labels={'':['不声明','No declaration'],owner:['我的表达或经历','My own expression or experience'],third_party:['第三方内容','Third-party content'],mixed:['混合内容','Mixed content'],unknown:['归属未知','Ownership unknown']},label=labels[saved.ownerRelation]||labels[''];
    summary.querySelector('.native-context-saved-label').textContent=hasSaved?tr('已保存：','Saved: ')+tr(label[0],label[1])+(saved.contextDescription?tr(' · 已补充背景',' · background added'):''):tr('尚未声明，仍可查询与整理','No declaration yet; search and organize normally');
    const status=summary.querySelector('.native-context-save-status');status.textContent=dirty?tr('有未保存修改','Unsaved changes'):hasSaved?tr('已保存','Saved'):tr('选填','Optional');status.classList.toggle('has-draft',dirty);
  }
  function refineSourceRelationship(){
    document.querySelectorAll('main [data-source-context-id]').forEach(panel=>{
      if(panel.closest('.native-context-disclosure')){refreshRelationshipSummary(panel);return;}
      const details=document.createElement('details');details.className='native-context-disclosure';details.open=sourceContextDirty(panel.dataset.sourceContextId);
      details.innerHTML='<summary><span><strong>'+tr('内容关系与背景','Content relationship and background')+'</strong><small class="native-context-saved-label"></small></span><span class="native-context-save-status" role="status" aria-live="polite"></span></summary>';
      panel.before(details);details.append(panel);panel.querySelector(':scope > h2')?.remove();refreshRelationshipSummary(panel);
    });
  }
  function screenSaveRecovery(){
    if(state.page!=='setup/screen'||state.permission==='已授权')return;
    const save=document.querySelector('main [data-action="save-source"][data-kind="screen"]'),actions=save?.closest('.form-actions');
    if(!save?.disabled||!actions||document.querySelector('.native-permission-reminder'))return;
    save.setAttribute('aria-describedby','native-screen-save-reason');
    actions.insertAdjacentHTML('beforebegin','<section class="native-permission-reminder"><div><strong>'+tr('需要先允许屏幕录制','Allow screen recording first')+'</strong><p id="native-screen-save-reason">'+tr('屏幕权限尚未允许，当前不能保存记录范围。应用勾选已保留。','Screen permission is not allowed yet, so the recording scope cannot be saved. Your app selection is retained.')+'</p></div>'+action(tr('去查看屏幕权限','Review screen permission'),'native-permission-control','btn')+'</section>');
  }
  window.enhancePlatformUI=function(){
    document.body.dataset.surface=state.surface;
    if(!isMac()&&!isAndroid()){sourceControlFeedback();refineSourceRelationship();screenSaveRecovery();return;}
    if(adaptAndroidFixtures()){render();return;}
    const app=document.querySelector('.app');
    if(!app)return;
    const changedPage=native.lastPage!==state.page;
    if(changedPage){
      const completedFolder=native.lastPage==='setup/folder/new'&&state.page.startsWith('setup/folder/')&&state.page!=='setup/folder/new'&&state.sources.some(s=>sourceSetupRoute(s.id)===state.page);
      if(completedFolder&&state.nativeFolderDrafts)delete state.nativeFolderDrafts['setup/folder/new'];
      if(native.lastPage&&!native.popping&&!completedFolder)native.routes.push(native.lastPage);
      native.lastPage=state.page;native.popping=false;native.menuOpen=false;
    }
    document.querySelectorAll('[data-native-chrome],.native-menu-popover').forEach(el=>el.remove());
    if(isMac()){
      app.insertAdjacentHTML('beforebegin',macChrome());
      const nav=document.querySelector('.sidebar > nav');
      if(nav&&!document.querySelector('.native-mac-quick'))nav.insertAdjacentHTML('afterend','<div class="native-mac-quick"><span>'+tr('本机快捷操作','ON THIS MAC')+'</span>'+route(icon('note')+tr('写随手记','Quick note')+'<kbd>⌘ N</kbd>','notes','native-quick-link')+route(icon('folder')+tr('同步文件夹','Sync a folder'),'setup/folder/new','native-quick-link')+'</div>');
    }else{
      app.insertAdjacentHTML('beforebegin',androidStatusbar());
      const top=document.querySelector('.mobile-top');if(top)top.innerHTML=mobileAppbar();
      const bottom=document.querySelector('.bottom-nav');if(bottom)bottom.insertAdjacentHTML('beforeend','<div class="native-gesture-area" aria-hidden="true"><span></span></div>');
      const welcomePaths=document.querySelector('.welcome-paths'),welcomeExample=document.querySelector('.welcome-example');
      if(welcomePaths&&welcomeExample){welcomePaths.insertAdjacentElement('afterend',welcomeExample);welcomeExample.classList.add('native-later-example');}
      document.querySelectorAll('.source-row').forEach(row=>{const s=state.sources.find(s=>s.id===row.dataset.sourceId);const p=row.querySelector('.source-main p');if(p&&s&&sourceKind(s.id)==='folder')p.textContent='Android · '+(state.sourceConfigs?.[s.id]?.folderPath||s.subtitle.replace(/^(Mac|Android) · /,''));});
    }
    if(state.page==='sources'||state.page==='catalog'){
      const heading=document.querySelector('main > .page-heading');
      if(heading&&!document.querySelector('.native-device-panel'))heading.insertAdjacentHTML('afterend',devicePanel());
    }
    setupAdaptation();
    sourceControlFeedback();
    refineExistingSourceLayout();
    refineSourceRelationship();
    screenSaveRecovery();
    if((isAndroid()||isMac())&&!state.sources.some(s=>s.id==='folder'))document.querySelectorAll('[data-action="go"][data-page="setup/folder"]').forEach(el=>el.dataset.page='setup/folder/new');
    if(state.modal)document.querySelectorAll('[data-native-chrome],.native-menu-popover').forEach(el=>{el.inert=true;el.setAttribute('aria-hidden','true');});
    if(isAndroid()&&changedPage)window.scrollTo(0,0);
  };
  window.platformAction=function(name,el){
    if(!name.startsWith('native-'))return false;
    if(name==='native-permission-control'){
      const allow=document.querySelector('main [data-action="allow-screen"]'),help=allow?.closest('details'),permission=allow?.closest('.notice');
      if(help)help.open=true;
      if(permission){permission.classList.add('native-permission-focus');permission.scrollIntoView({block:'center'});}
      allow?.focus({preventScroll:true});return true;
    }
    if(name==='native-menu-toggle'){native.menuOpen=!native.menuOpen;render();return true;}
    if(name==='native-menu-close'){native.menuOpen=false;render();return true;}
    if(name==='native-folder-list'){
      go('sources');const folderIds=state.sources.filter(s=>sourceKind(s.id)==='folder').map(s=>s.id);const row=[...document.querySelectorAll('.source-row')].find(el=>folderIds.includes(el.dataset.sourceId));row?.scrollIntoView({block:'start'});return true;
    }
    if(name==='native-folder-picker'){
      readFolderDraft();
      const choices=isAndroid()?[['Documents/阅读资料','阅读资料','Reading materials'],['Download/收集夹','收集夹','Collected files']]:[['~/Documents/阅读资料','阅读资料','Reading materials'],['~/Desktop/收集夹','收集夹','Collected files']];
      const rows='<div class="native-folder-options">'+choices.map(([folder,zh,en])=>action(icon('folder')+'<span><strong>'+esc(tr(zh,en))+'</strong><small data-user-content>'+esc(folder)+'</small></span>','native-folder-selected','native-folder-option','data-folder="'+esc(folder)+'" data-name="'+esc(tr(zh,en))+'"')).join('')+'</div>';
      const picker=isMac()?'<div class="native-finder-picker"><aside><strong>'+tr('位置','Locations')+'</strong><span>'+icon('folder')+tr('文稿','Documents')+'</span><span>'+icon('screen')+tr('桌面','Desktop')+'</span></aside>'+rows+'</div>':rows;
      showInfo(tr('选择示例文件夹','Choose a sample folder'),isAndroid()?tr('Android 文件选择器 · 预览授权范围','Android folder picker · preview access scope'):tr('Finder · 预览所选文件夹','Finder · preview the selected folder'),'<p class="small muted">'+tr('选定一个目录后，Mote 只接收该目录中的变化。','Mote receives changes from the selected folder only.')+'</p>'+picker);return true;
    }
    if(name==='native-folder-selected'){
      const key=folderRouteKey(),draft={...(state.nativeFolderDrafts?.[key]||{}),folderPath:el.dataset.folder};
      if(!draft.name)draft.name=el.dataset.name;
      state.nativeFolderDrafts={...(state.nativeFolderDrafts||{}),[key]:draft};if(key==='setup/folder/new')state.newFolderDraft={...draft};
      state.modal='';persist();render();return true;
    }
    if(name==='native-search'){
      if(!state.materials.length){
        showInfo(tr('搜索资料','Search materials'),tr('这里会搜索你保存的正文与出处。','Search the text and sources you have saved.'),'<div class="native-search-empty">'+icon('search')+'<h3>'+tr('先保存一份内容，就能在这里找回','Save something first, then find it here')+'</h3><p>'+tr('记下一条想法，或导入手头的文件。保存后可按关键词搜索。','Write a thought or import a file. You can search its text after saving.')+'</p><div class="actions section">'+route(tr('写下第一条记录','Write my first note'),'notes','btn primary')+route(tr('导入已有文件','Import a file'),'import','btn')+'</div></div>');return true;
      }
      if(state.page!=='library')go('library');
      document.getElementById('material-search')?.focus();return true;
    }
    if(name==='native-back'){
      if(state.modal){state.modal='';render();return true;}
      const fallback=state.page.startsWith('setup/')?'sources':state.page.startsWith('material/')?(state.materialReturn||'library'):primaryPage();
      const dest=native.routes.pop()||fallback||'library';native.popping=true;go(dest);return true;
    }
    return false;
  };
  document.addEventListener('keydown',e=>{
    if(!isMac()||state.modal)return;
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();window.platformAction('native-search');}
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='n'){e.preventDefault();go('notes');}
    if(e.key==='Escape'&&native.menuOpen){native.menuOpen=false;render();}
  });
  for(const type of ['input','change'])document.addEventListener(type,e=>{if(['source-relation','source-context-description'].includes(e.target.id)){const panel=e.target.closest('[data-source-context-id]');if(panel)refreshRelationshipSummary(panel);}});
  document.addEventListener('input',e=>{if((isAndroid()||isMac())&&['folder-path','source-name'].includes(e.target.id))readFolderDraft();});
  document.addEventListener('change',e=>{if((isAndroid()||isMac())&&['continuous','save-mode'].includes(e.target.id))readFolderDraft();});
})();
