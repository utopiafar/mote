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

  function devicePanel(){
    return '<section class="native-device-panel" aria-label="'+tr('本机收集','Collection on this device')+'"><div class="native-device-heading"><div><span class="native-overline">'+tr('这台设备','THIS DEVICE')+'</span><h2>'+tr('在这台 '+device()+' 上收集','Collect on this '+device())+'</h2></div><span class="tag">'+tr('范围由你选择','You choose the scope')+'</span></div><div class="native-source-grid">'+
      '<article class="native-source-card"><span class="native-source-icon">'+icon('screen')+'</span><div><h3>'+tr('屏幕记录','Screen recording')+'</h3><p>'+tr('只记录选定应用，随时暂停。','Record selected apps and pause any time.')+'</p><span class="native-source-state">'+screenState()+'</span></div>'+route(tr('选择屏幕范围','Choose screen scope'),'setup/screen','btn')+'</article>'+
      '<article class="native-source-card"><span class="native-source-icon">'+icon('folder')+'</span><div><h3>'+tr('文件夹同步','Folder sync')+'</h3><p>'+tr('选一个目录，保存之后的变化。','Choose a folder and keep later changes.')+'</p><span class="native-source-state">'+folderState()+'</span></div>'+route(tr('连接一个文件夹','Connect a folder'),'setup/folder/new','btn')+'</article></div><p class="native-device-foot">'+tr('保存后的内容进入资料库，可查找、提问并核对原文。','Saved content goes to your library to search, ask about and verify.')+'</p></section>';
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
    if(!['setup/screen','setup/folder/new'].includes(state.page)&&!state.page.startsWith('setup/folder/'))return;
    const fields=document.querySelector('main > .fields');
    if(!fields||fields.querySelector('.native-setup-context'))return;
    let title='',description='';
    if(state.page==='setup/screen'){
      title=isAndroid()?tr('Android · 屏幕录制权限','Android · screen capture permission'):tr('Mac · 屏幕录制权限','Mac · screen recording permission');
      description=isAndroid()?tr('先选择应用范围，再确认系统录屏授权。此处用“模拟允许 / 拒绝”预览两种状态。','Choose the apps, then confirm system screen capture permission. Use the demo allow/deny controls here to preview both states.'):tr('系统设置 → 隐私与安全性 → 屏幕录制。此处用模拟授权查看流程，应用范围由下方选择。','System Settings → Privacy & Security → Screen Recording. Preview permission states below, then choose the allowed apps.');
    }else{
      title=isAndroid()?tr('Android · 选择本机目录','Android · choose a local folder'):tr('Mac · 选择本机文件夹','Mac · choose a local folder');
      description=isAndroid()?tr('系统文件选择器只授予你选中目录的访问权限。下方路径用于预览；不读取手机文件。','The system folder picker grants access to the selected folder. The path below is a preview and does not read phone files.'):tr('通过 Finder 选择一个文件夹。同步范围与屏幕记录分别控制。','Choose one folder in Finder. Folder sync and screen recording have separate scopes.');
      if(isAndroid()){
        const path=document.getElementById('folder-path');
        if(path&&path.value==='~/Documents/研究资料')path.value='Documents/研究资料';
        fields.querySelectorAll('p').forEach(p=>{if(p.textContent.includes('本机指这台电脑'))p.textContent=tr('中央指你的 Mote 工作台存储；本机指这台手机。保存方式决定两处是否保留原件。','Central means your Mote workspace storage; local means this phone. The save mode determines where originals are retained.');});
      }
    }
    fields.insertAdjacentHTML('afterbegin','<section class="native-setup-context"><span>'+icon(state.page==='setup/screen'?'shield':'folder')+'</span><div><h2>'+title+'</h2><p>'+description+'</p></div></section>');
  }
  window.enhancePlatformUI=function(){
    document.body.dataset.surface=state.surface;
    if(!isMac()&&!isAndroid())return;
    if(adaptAndroidFixtures()){render();return;}
    const app=document.querySelector('.app');
    if(!app)return;
    if(native.lastPage!==state.page){
      if(native.lastPage&&!native.popping)native.routes.push(native.lastPage);
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
      document.querySelectorAll('.source-row').forEach(row=>{const s=state.sources.find(s=>s.id===row.dataset.sourceId);const p=row.querySelector('.source-main p');if(p&&s&&sourceKind(s.id)==='folder')p.textContent='Android · '+(state.sourceConfigs?.[s.id]?.folderPath||s.subtitle.replace(/^(Mac|Android) · /,''));});
    }
    if(state.page==='sources'||state.page==='catalog'){
      const heading=document.querySelector('main > .page-heading');
      if(heading&&!document.querySelector('.native-device-panel'))heading.insertAdjacentHTML('afterend',devicePanel());
    }
    setupAdaptation();
    if(state.modal)document.querySelectorAll('[data-native-chrome],.native-menu-popover').forEach(el=>{el.inert=true;el.setAttribute('aria-hidden','true');});
  };
  window.platformAction=function(name,el){
    if(!name.startsWith('native-'))return false;
    if(name==='native-menu-toggle'){native.menuOpen=!native.menuOpen;render();return true;}
    if(name==='native-menu-close'){native.menuOpen=false;render();return true;}
    if(name==='native-search'){
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
})();
