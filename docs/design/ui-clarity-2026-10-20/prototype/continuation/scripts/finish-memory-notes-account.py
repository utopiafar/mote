from pathlib import Path
import json

root = Path(__file__).resolve().parents[1]
path = root / 'work/integration.html'
source = path.read_text()
changes = []

def replace(old, new, count=1):
    global source
    actual = source.count(old)
    if actual != count:
        raise ValueError(f'Expected {count} matches, got {actual}: {old[:100]}')
    source = source.replace(old, new)
    changes.append({'old': old, 'new': new})

def replace_line(prefix, new):
    matches = [line for line in source.splitlines() if line.lstrip().startswith(prefix.lstrip())]
    if len(matches) != 1:
        raise ValueError(f'Expected one line for {prefix}: {len(matches)}')
    replace(matches[0], new)

replace('const REV = 15;', 'const REV = 16;')
replace("let initialState = parameters.get('state') || 'populated';", "const originalMemorySeed = '偏好入口简洁、按任务组织的界面。复杂设置放在相关上下文里。';\nlet initialState = parameters.get('state') || 'populated';")
replace("noteSaved:null,importFile:''", "noteSaved:null,noteDraftId:null,noteQueued:null,noteQueue:[],noteNetwork:'online',noteSequence:0,authenticated:true,accountName:'林同学',loginName:'',accountError:'',originalMemoryHistory:[],memoryCorrectionDraft:null,importFile:''")

helpers = r'''
function originalMemoryText(){return state.memoryCorrected?state.memoryCorrection:originalMemorySeed;}

const demoAccountKey='mote-prototype-accounts-'+REV;
let demoAccounts={};
try{demoAccounts=JSON.parse(sessionStorage.getItem(demoAccountKey)||'{}');}catch(e){}
function rememberDemoAccount(){
 const copy=JSON.parse(JSON.stringify(state));
 copy.modal='';copy.toast='';copy.toastAction='';copy.accountError='';copy.loginName='';
 demoAccounts={...demoAccounts,[state.accountName]:copy};
 try{sessionStorage.setItem(demoAccountKey,JSON.stringify(demoAccounts));}catch(e){}
}
function loginPage(){return '<section class="auth-card card"><div class="brand"><span class="brand-icon">m</span>Mote</div><h1>进入你的工作台</h1><p>汇集个人资料，随时查找、提问并核对原文。</p><div class="notice"><div>这是登录交互演示。使用任意非空用户名，演示密码为 <code>mote-demo</code>。</div></div><div class="fields section">'+field('用户名','demo-username',state.loginName,'text')+field('密码','demo-password','','password')+(state.accountError?'<p role="alert" class="form-error">'+esc(state.accountError)+'</p>':'')+'<div class="form-actions">'+button('进入工作台','demo-login','','primary')+'</div></div><p class="small muted">新用户名进入空白工作台。重新使用原用户名可继续本次演示中保存的资料与草稿。</p></section>';}
function accountPage(){return '<div class="card"><div class="flex-spread"><div><h2 data-user-content>'+esc(state.accountName)+'</h2><p>个人工作台 · 当前会话</p></div>'+button('退出登录','logout-demo','','subtle')+'</div><p class="small muted">当前账号的资料、待同步笔记和草稿分别保留。</p></div><section class="section"><div class="section-head"><h2>已连接设备</h2>'+goButton('连接设备','setup/device','text')+'</div>'+(state.devices.length?state.devices.map(d=>'<div class="source-row">'+icon('screen')+'<div class="source-main"><h3 data-user-content>'+esc(d.name)+'</h3><p>'+esc(d.platform)+' · '+esc(d.status)+'</p></div>'+goButton('管理','devices','subtle')+'</div>').join(''):'<div class="empty"><h3>还没有连接设备</h3>'+goButton('连接第一台设备','setup/device','primary')+'</div>')+'</section>';}
function accountAction(action){
 if(action==='logout-demo'){showInfo('退出当前工作台','已保存内容和本机草稿会保留，重新进入原账号后可继续。','<div class="form-actions">'+button('确认退出','confirm-logout','','primary')+button('取消','close-modal','','subtle')+'</div>');return true;}
 if(action==='confirm-logout'){rememberDemoAccount();state.authenticated=false;state.loginName=state.accountName;state.accountError='';state.modal='';state.toast='';state.toastAction='';state.page='login';location.hash='#/login';persist();render();document.getElementById('demo-username')?.focus();return true;}
 if(action==='demo-login'){
  const name=document.getElementById('demo-username')?.value.trim()||'',password=document.getElementById('demo-password')?.value||'';
  state.loginName=name;
  if(!name||password!=='mote-demo'){state.accountError=!name?'请填写用户名。':'用户名或密码不正确，请重试。';persist();render();document.getElementById(name?'demo-password':'demo-username')?.focus();return true;}
  const ui={surface:state.surface,theme:state.theme,language:state.language};
  const saved=Object.hasOwn(demoAccounts,name)?JSON.parse(JSON.stringify(demoAccounts[name])):null;
  state=saved||{...JSON.parse(JSON.stringify(initialDefaults)),dataState:'empty',materials:[],sources:[],devices:[],imports:[],todos:[],askHistory:[],memoryDeleted:true,accessGrants:[],permission:'未授权'};
  Object.assign(state,ui,{authenticated:true,accountName:name,loginName:'',accountError:'',modal:'',toast:'',toastAction:'',page:'library'});
  location.hash='#/library';persist();render();focusMain();return true;
 }
 return false;
}

function currentNoteRecord(){
 const id=state.noteDraftId||state.noteSaved||('note-'+Date.now()+'-'+(++state.noteSequence));
 state.noteDraftId=id;
 return {id,title:state.note.trim().split('\n')[0].slice(0,36)||'带附件的笔记',type:'note',source:'随手记',date:'刚刚',preview:state.note.slice(0,80),text:state.note,attachments:[...state.attachments],body:state.note+(state.attachments.length?'\n附件：'+state.attachments.join('、'):''),device:state.surface==='web'?'网页':state.surface==='mac'?'Mac':'Android',origin:'我写的记录'};
}
function commitNoteRecord(note){
 const previous=state.materials.findIndex(m=>m.id===note.id);
 if(previous>=0)state.materials[previous]={...note};else state.materials.unshift({...note});
 state.noteQueue=state.noteQueue.filter(item=>item.id!==note.id);
 if(state.noteDraftId===note.id){state.noteSaved=note.id;state.noteQueued=null;state.noteDirty=false;}
}
function saveCurrentNote(){
 if(!state.note.trim()&&!state.attachments.length)return notify('先写一点内容或添加附件。');
 const note=currentNoteRecord();
 if(state.noteNetwork==='offline'){
  const item={...note,status:'pending'},index=state.noteQueue.findIndex(q=>q.id===note.id);
  if(index>=0)state.noteQueue[index]=item;else state.noteQueue.unshift(item);
  state.noteQueued=note.id;state.noteDirty=false;persist();return notify('已保存在本机待同步队列，恢复连接后可重试同步。');
 }
 commitNoteRecord(note);persist();return notify('笔记已保存到资料库。','material/'+note.id);
}
function pendingNoteList(){return state.noteQueue.length?'<section class="section" aria-label="待同步笔记"><div class="section-head"><h2>本机待同步</h2><span class="small muted">'+state.noteQueue.length+' 条</span></div>'+state.noteQueue.map(q=>'<article class="card section" data-queued-note="'+q.id+'"><div class="flex-spread"><h3 data-user-content>'+esc(q.title)+'</h3>'+tag(q.status==='failed'?'同步未完成':'等待同步','yellow')+'</div><p class="small">正文与附件已保留在本机，尚未写入资料库。</p><div class="actions">'+button('查看待同步副本','open-queued-note','data-id="'+q.id+'"','subtle')+button('继续编辑','edit-queued-note','data-id="'+q.id+'"','subtle')+button('重试同步','retry-note','data-id="'+q.id+'"','primary')+button('丢弃本机副本','discard-queued-note','data-id="'+q.id+'"','text')+'</div></article>').join('')+'</section>':'';}
function noteAction(action,el){
 if(action==='toggle-note-network'){state.noteNetwork=state.noteNetwork==='online'?'offline':'online';persist();render();return true;}
 const id=el?.dataset.id,q=state.noteQueue.find(item=>item.id===id);
 if(action==='retry-note'){
  if(!q)return true;
  if(state.noteNetwork==='offline'){q.status='failed';persist();notify('仍处于离线状态，正文和附件保留在本机。');return true;}
  commitNoteRecord(q);persist();notify('同步完成，正文与附件已保存到资料库。','material/'+q.id);return true;
 }
 if(action==='open-queued-note'&&q){showInfo('本机待同步副本','这份内容尚未写入资料库。','<h3 data-user-content>'+esc(q.title)+'</h3><div class="reading-body" data-user-content>'+q.body.split('\n').map(line=>'<p>'+esc(line)+'</p>').join('')+'</div>');return true;}
 if(action==='edit-queued-note'&&q){state.note=q.text;state.attachments=[...q.attachments];state.noteDraftId=q.id;state.noteSaved=state.materials.some(m=>m.id===q.id)?q.id:null;state.noteQueued=q.id;state.noteDirty=false;go('notes');return true;}
 if(action==='discard-queued-note'&&q){showInfo('丢弃这个本机副本？','仅移除尚未同步的副本。已经保存到资料库的版本和其他笔记保留。','<p data-user-content>'+esc(q.title)+'</p><div class="form-actions">'+button('确认丢弃本机副本','confirm-discard-note','data-id="'+q.id+'"','danger')+button('取消','close-modal','','subtle')+'</div>');return true;}
 if(action==='confirm-discard-note'&&q){state.noteQueue=state.noteQueue.filter(item=>item.id!==q.id);if(state.noteDraftId===q.id){const saved=state.materials.find(m=>m.id===q.id);state.note=saved?.text||'';state.attachments=[...(saved?.attachments||[])];state.noteSaved=saved?.id||null;state.noteDraftId=saved?.id||null;state.noteQueued=null;state.noteDirty=false;}state.modal='';persist();notify('本机待同步副本已丢弃，已保存资料保持不变。');return true;}
 return false;
}
'''
replace('function notesPage(){', helpers+'\nfunction notesPage(){')

replace_line('function notesPage(){', r'''function notesPage(){return heading('随手记','记下文字，也可以附上已有图片或音频。',goButton('笔记历史','library/notes','subtle'))+'<section class="reading"><div class="notice '+(state.noteNetwork==='offline'?'warn':'good')+'" role="status"><div>'+ (state.noteNetwork==='offline'?'离线 · 新内容先保存在本机待同步队列。':'连接正常 · 保存后可在资料库中找回。')+'</div></div><details class="section demo-controls"><summary>演示网络状态</summary><div class="actions card-foot">'+button(state.noteNetwork==='online'?'模拟离线':'恢复连接','toggle-note-network','','subtle')+'</div><p class="small muted">此开关只模拟笔记同步，便于查看离线保存与重试。</p></details><div class="fields section"><label class="field"><span>正文</span><textarea id="note-text" placeholder="有什么想记下来？">'+esc(state.note)+'</textarea><small>草稿保存在当前原型会话。</small></label><div class="actions">'+button(icon('plus')+' 图片与语音附件','attach','','subtle')+'</div><div class="attachments">'+state.attachments.map((a,i)=>'<span class="attachment">'+icon('file')+'<span data-user-content>'+esc(a)+'</span><button data-action="remove-attachment" data-index="'+i+'" aria-label="移除'+esc(a)+'">×</button></span>').join('')+'</div><div class="form-actions">'+button(state.noteNetwork==='offline'?'保存到本机待同步':'保存笔记','save-note','','primary')+'<span class="small muted">'+(state.noteDirty?'有修改待保存':state.noteQueued?'已保存本机待同步副本':state.noteSaved?'已保存到资料库':'草稿会随编辑保留')+'</span></div>'+(state.noteSaved?'<div class="notice good">'+icon('check')+'<div>资料库中已有保存版本。'+goButton('打开这条笔记','material/'+state.noteSaved,'text')+'</div></div>':'')+'</div>'+pendingNoteList()+'</section>';}''')

replace_line('function allMemoryHistory(){', r'''function allMemoryHistory(){return (!state.memoryDeleted?'<section class="card section" data-history-memory="original"><h3>产品设计偏好</h3><h4>初次整理</h4><p data-user-content>'+esc(originalMemorySeed)+'</p>'+(state.originalMemoryHistory||[]).map((value,index)=>'<h4>人工纠正 '+(index+1)+'</h4><p data-user-content>'+esc(value)+'</p>').join('')+goButton('查看依据 · 产品评审记录','material/m1','text')+'</section>':'')+(state.memoryExtracted?'<section class="card section" data-history-memory="generated"><h3>从资料整理的记忆</h3><p>依据：<span data-user-content>'+state.memoryFrom.map(id=>state.materials.find(m=>m.id===id)?.title||'已移除的资料').map(esc).join('、')+'</span></p>'+memoryTimeline()+'</section>':'')+(!state.memoryExtracted&&state.memoryDeleted?'<p class="empty">还没有记忆修改记录。</p>':'');}''')
replace("input:isNew?state.generatedMemoryText:(state.memoryCorrected?state.memoryCorrection:'偏好入口简洁、按任务组织的界面。')", "input:isNew?state.generatedMemoryText:originalMemoryText()")
replace("<p id=\"memory-text\">'+(state.memoryCorrected?esc(state.memoryCorrection):'偏好入口简洁、按任务组织的界面。复杂设置放在相关上下文里。')", "<p id=\"memory-text\" data-user-content>'+esc(originalMemoryText())")
replace("esc(state.memoryCorrection||'偏好入口简洁、按任务组织的界面。')", "esc(state.memoryCorrectionDraft??originalMemoryText())", count=2)
replace_line("  if(action==='export-memory')", r'''  if(action==='export-memory')return showInfo('导出记忆预览','包含当前完整内容与原文引用，可选取复制。','<div class="evidence-box"><h3>产品设计偏好</h3><p data-user-content>'+esc(originalMemoryText())+'</p><p>依据：产品评审记录</p></div>');''')
replace_line("  if(action==='save-correction')", r'''  if(action==='save-correction'){const content=value('memory-correction').trim();if(!content)return notify('请保留记忆内容。');state.memoryCorrection=content;state.memoryCorrected=true;state.originalMemoryHistory.push(content);state.memoryCorrectionDraft=null;state.modal='';persist();return notify('记忆已纠正，原始依据保留。');}''')
replace("<h3>本次采用的记忆内容</h3><p>'+esc(t.input)", "<h3>本次采用的记忆内容</h3><p data-user-content>'+esc(t.input)")
replace("<h3>整理结果 · 演示</h3><p>'+esc(t.result)", "<h3>整理结果 · 演示</h3><p data-user-content>'+esc(t.result)")
replace("<p class=\"generated-memory-result\">", "<p class=\"generated-memory-result\" data-user-content>")
replace("<h3>初次整理</h3><p>'+esc(state.generatedMemoryOriginal", "<h3>初次整理</h3><p data-user-content>'+esc(state.generatedMemoryOriginal")
replace("'<h3>人工纠正 '+(i+1)+'</h3><p>'+esc(x)", "'<h3>人工纠正 '+(i+1)+'</h3><p data-user-content>'+esc(x)")

replace(" if(coherentAction(action,el)||maintenanceAction(action,el))return;", " if(accountAction(action)||noteAction(action,el)||coherentAction(action,el)||maintenanceAction(action,el))return;")
replace_line("  if(action==='save-note')", "  if(action==='save-note')return saveCurrentNote();")
replace_line("  if(action==='logout-demo')return showInfo", "  // Account actions are handled by accountAction, including saved workspace restoration.")
replace_line("  if(action==='new-note')", "  if(action==='new-note'){state.note='';state.attachments=[];state.noteSaved=null;state.noteDraftId=null;state.noteQueued=null;state.noteDirty=false;return go('notes');}")
replace_line("  if(action==='edit-note')", "  if(action==='edit-note'){const m=state.materials.find(x=>x.id===el.dataset.id);state.note=m.text??m.body;state.noteSaved=m.id;state.noteDraftId=m.id;state.noteQueued=null;state.noteDirty=false;state.attachments=[...(m.attachments||[])];return go('notes');}")
replace("state.attachments.push(el.dataset.file);state.modal='';persist();", "state.attachments.push(el.dataset.file);state.noteDirty=true;state.modal='';persist();")
replace("state.attachments.splice(Number(el.dataset.index),1);persist();", "state.attachments.splice(Number(el.dataset.index),1);state.noteDirty=true;persist();")
replace("if(id==='generated-memory-text'){", "if(id==='demo-username'){state.loginName=e.target.value;persist();}if(id==='memory-correction'){state.memoryCorrectionDraft=e.target.value;persist();}if(id==='generated-memory-text'){")

replace_line(" if(id==='account'&&state.dataState==='empty')", " if(id==='account')return accountPage();")
replace_line(" if(id==='account')return '<div class=\"card\">", " // Both empty and populated account screens use the current account and device collection.")

replace("<span class=\"avatar\">林</span><span>林同学<small>", "<span class=\"avatar\" data-user-content>'+esc(state.accountName.slice(0,1))+'</span><span><span data-user-content>'+esc(state.accountName)+'</span><small>")
login_render = r'''
  if(!state.authenticated){
   html+='<div class="auth-shell"><main id="main" aria-label="登录工作台">'+loginPage()+'</main></div>';
   document.getElementById('prototype').innerHTML=html;localizeUI();
   if(focusId){const input=document.getElementById(focusId);if(input){input.focus();if(selection!==null&&input.setSelectionRange)try{input.setSelectionRange(selection,selection);}catch(e){}}}
   lastRenderedPage='login';return;
  }
'''
replace(" html+='<div class=\"app\">", login_render+" html+='<div class=\"app\">")
replace("p.startsWith('imports')?'返回上传与处理'", "p.startsWith('imports')?'返回上传与处理':p.startsWith('import')?'返回导入资料'")
replace("<div class=\"reading-body\">'+m.body", "<div class=\"reading-body\" data-user-content>'+m.body")
replace("document.addEventListener('keydown',e=>{const dialog=", "document.addEventListener('keydown',e=>{if(!state.authenticated&&e.key==='Enter'&&e.target.matches('#demo-username,#demo-password')){e.preventDefault();accountAction('demo-login');return;}const dialog=")
replace("const surface=state.surface,theme=state.theme,language=state.language;Object.assign", "const surface=state.surface,theme=state.theme,language=state.language,accountName=state.accountName,authenticated=state.authenticated;Object.assign")
replace("{surface,theme,language,dataState:v,page:'library'", "{surface,theme,language,accountName,authenticated,dataState:v,page:'library'")
replace("sessionStorage.removeItem('mote-prototype-'+REV);", "sessionStorage.removeItem('mote-prototype-'+REV);sessionStorage.removeItem(demoAccountKey);")

replace("button('演示未配置模型','mock-missing','','text')", "'<details class=\"demo-controls\"><summary>演示模型状态</summary><div class=\"actions card-foot\">'+button('演示未配置模型','mock-missing','','text')+'</div></details>'")
replace("'<strong>根据已保存的资料，有两件事值得跟进：</strong>", "'<p class=\"small muted\">示例回答 · 用于核对范围、引用与返回流程</p><strong>根据已保存的资料，有两件事值得跟进：</strong>")

replace('</style>', '.auth-shell{max-width:560px;margin:64px auto;padding:0 20px}.auth-card{padding:32px}.auth-card h1{font-size:25px;line-height:1.4}.form-error{color:var(--danger)}.demo-controls{font-size:12px;color:var(--muted)}.demo-controls summary{cursor:pointer}.demo-controls .actions{margin:8px 0}.reading-body[data-user-content]{overflow-wrap:anywhere}body.mobile .auth-shell{margin:24px auto;padding:0 16px}body.mobile .auth-card{padding:22px}\n</style>')

path.write_text(source)
(root/'reports/root-replacements.json').write_text(json.dumps(changes,ensure_ascii=False,indent=2))
print(json.dumps({'output':str(path),'replacements':len(changes),'bytes':len(source.encode())}))
