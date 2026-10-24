from pathlib import Path
import hashlib
import json


ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'dist/r17.html'
TARGET = ROOT / 'work/source-r18.html'
text = BASE.read_text()
baseline_sha = hashlib.sha256(text.encode()).hexdigest()
assert baseline_sha == '290534ad7b054e1349ca836e13e7c30d3913860964479517052c8523031d7c6c'
changes = []


def replace(old, new, purpose):
    global text
    count = text.count(old)
    if count != 1:
        raise ValueError(f'{purpose}: expected one match, got {count}: {old[:150]}')
    text = text.replace(old, new, 1)
    changes.append({'purpose': purpose, 'old': old, 'new': new})


replace('const initialDefaults=JSON.parse(JSON.stringify(state));',
        "Object.assign(state,{deviceFilter:'all',captureDateFilter:'all',snippetGrouping:'session',sourceContextDrafts:{},sendPaused:false});\nconst initialDefaults=JSON.parse(JSON.stringify(state));",
        'Independent defaults; preserve the initial state and merge anchor')
replace("{id:'m6',sourceId:'screen',title:",
        "{id:'m6',sourceId:'screen',capturedAt:'2026-10-18T11:08:00',captureSessionId:'screen-session-1',captureApplication:'browser',title:",
        'Explicit synthetic capture metadata on the existing m6 record; no extra material or reassigned source')

replace('function sourceMaterialCount(id){',
        "const sourceSyncTask={id:'source-lark-sync',sourceId:'lark'};\nfunction sourceTaskTitle(){return state.sources.find(s=>s.id===sourceSyncTask.sourceId)?.title||sourceChoices.find(s=>s.id===sourceSyncTask.sourceId)?.title||sourceSyncTask.sourceId;}\nfunction sourceMaterialCount(id){",
        'One stable source identity for the existing authorization task')
replace("'<div class=\"task-row\"><span class=\"task-state\">'+icon(state.taskRetried?'check':'sources')",
        "'<div class=\"task-row\" data-task-id=\"'+sourceSyncTask.id+'\" data-task-source-id=\"'+sourceSyncTask.sourceId+'\"><span class=\"task-state\">'+icon(state.taskRetried?'check':'sources')",
        'Expose stable task/source identity on the existing activity card')
replace("'</div><p>'+(state.taskRetried?'授权恢复已完成。来源已恢复同步，后续内容会继续保存。'",
        "'</div><p>当前来源：'+sourceUserText(sourceTaskTitle())+'</p><p data-task-source-count>'+sourceMaterialCount(sourceSyncTask.sourceId)+' 份已保存资料</p><p>'+(state.taskRetried?'授权恢复已完成。来源已恢复同步，后续内容会继续保存。'",
        'Show the actual source name and saved material count in activity')
replace("button('重新授权并继续','authorize-task','','primary')+goButton('查看已保存资料','library','text'):goButton('查看资料','library','text')",
        "button('重新授权并继续','authorize-task','','primary')+button('查看已保存资料','browse-source','data-id=\"'+sourceSyncTask.sourceId+'\"','text'):button('查看资料','browse-source','data-id=\"'+sourceSyncTask.sourceId+'\"','text')",
        'Keep both pre-authorization and recovery activity links inside their source')
replace("function taskDetailPage(){\n return heading('工作详情','飞书来源同步 · 查看输入、状态与恢复方式。'",
        "function taskDetailPage(){\n const sourceId=sourceSyncTask.sourceId,count=sourceMaterialCount(sourceId);\n return heading('工作详情','来源同步 · 查看输入、状态与恢复方式。'",
        'Derive task detail from the same stable source identity')
replace("'<div class=\"grid two\"><section class=\"card\"><div class=\"flex-spread\"><h2>飞书文档与日历</h2>'+tag(state.taskRetried?'授权已恢复'",
        "'<div class=\"grid two\" data-task-source-id=\"'+sourceId+'\"><section class=\"card\"><div class=\"flex-spread\"><h2 data-user-content>'+esc(sourceTaskTitle())+'</h2>'+tag(state.taskRetried?'授权已恢复'",
        'Protect the current source name while retaining task structure')
replace("'</div><p>最近一次读取：今天 09:20 · 已归档的 12 份资料仍可阅读。</p><div class=\"divider\"></div><h3>当前结果</h3><p>'",
        "'</div><p>最近一次读取：今天 09:20</p><p data-task-source-count>'+count+' 份已保存资料</p>'+(count?'<p>这些资料保留在此来源范围内，可以继续阅读。</p>':'<p>此来源尚无已保存资料。其他来源的内容保持各自范围。</p>')+'<div class=\"divider\"></div><h3>当前结果</h3><p>'",
        'Replace fabricated archived count with the actual material collection')
replace("goButton('查看来源设置','setup/lark','text')+goButton('查看已保存资料','library','text')",
        "goButton('查看来源设置',sourceSetupRoute(sourceId),'text')+button('查看已保存资料','browse-source','data-id=\"'+sourceId+'\"','text')",
        'Task detail view and settings both use the same source')
replace("if(action==='authorize-task'){state.sourceReturn=state.page;return go('setup/lark');}",
        "if(action==='authorize-task'){state.sourceReturn=state.page;return go(sourceSetupRoute(sourceSyncTask.sourceId));}",
        'Keep authorization and the adjoining source browse action aligned')

replace('function filteredMaterials(){', r'''function materialDeviceId(m){return m.deviceId||({Mac:'mac',Android:'android','网页':'web','中央':'central','工作台':'central'})[m.device]||m.device||'unknown';}
function materialDeviceLabel(id){return ({mac:'Mac',android:'Android',web:'网页',central:'中央',unknown:'设备未注明'})[id]||state.devices.find(d=>d.id===id)?.name||state.materials.find(m=>materialDeviceId(m)===id)?.device||id;}
function materialDeviceFilter(){
 const ids=[...new Set([...state.materials.map(materialDeviceId),...state.devices.map(d=>d.id)])];
 return '<select id="device-filter" class="field-input" aria-label="按设备筛选"><option value="all">全部设备</option>'+ids.map(id=>'<option '+(!['mac','android','web','central','unknown'].includes(id)?'data-user-content ':'')+'value="'+esc(id)+'" '+(state.deviceFilter===id?'selected':'')+'>'+esc(materialDeviceLabel(id))+'</option>').join('')+'</select>';
}
function captureDate(m){return (m.capturedAt||materialSavedDate(m)).slice(0,10);}
function filteredMaterials(){''',
        'Device filter uses actual record/device identities, not source-name heuristics')
replace("m=>(!state.sourceScopeId||m.sourceId===state.sourceScopeId)&&(state.dateFilter==='全部时间'",
        "m=>(!state.sourceScopeId||m.sourceId===state.sourceScopeId)&&(state.deviceFilter==='all'||materialDeviceId(m)===state.deviceFilter)&&(state.filter!=='snippets'||state.captureDateFilter==='all'||captureDate(m)===state.captureDateFilter)&&(state.dateFilter==='全部时间'",
        'Apply device scope consistently to all material and raw views')
replace("state.dateFilter!=='全部时间'?esc(state.dateFilter):''].filter(Boolean).join(' · ');}",
        "state.dateFilter!=='全部时间'?esc(state.dateFilter):'',state.deviceFilter!=='all'?'<span>'+esc(materialDeviceLabel(state.deviceFilter))+'</span>':'',state.filter==='snippets'&&state.captureDateFilter!=='all'?'采集日期：'+sourceUserText(state.captureDateFilter):''].filter(Boolean).join(' · ');}",
        'Include device and capture date in visible filter scope')
replace("state.dateFilter!=='全部时间'?state.dateFilter:''].filter(Boolean).join(' · ');}",
        "state.dateFilter!=='全部时间'?state.dateFilter:'',state.deviceFilter!=='all'?materialDeviceLabel(state.deviceFilter):'',state.filter==='snippets'&&state.captureDateFilter!=='all'?state.captureDateFilter:''].filter(Boolean).join(' · ');}",
        'Compact filter summary preserves the new scopes')
replace("const rows=filteredMaterials(),filtering=!!state.sourceScopeId||!!state.search||state.sourceFilter!=='all'||state.typeFilter!=='all'||state.dateFilter!=='全部时间',desc=",
        "const rows=filteredMaterials(),filtering=!!state.sourceScopeId||!!state.search||state.sourceFilter!=='all'||state.typeFilter!=='all'||state.dateFilter!=='全部时间'||state.deviceFilter!=='all'||state.filter==='snippets'&&state.captureDateFilter!=='all',desc=",
        'Show empty/filter feedback whenever the new controls narrow results')
replace("snippets:'按时间和应用回看屏幕中的片段。'", "snippets:'按采集日期、设备、连续会话或应用相册回看屏幕片段。'", 'Explain the actual grouping and filter axes')
replace("'+sourceFilterOptions()+'</select><select id=\"type-filter\"", "'+sourceFilterOptions()+'</select>'+materialDeviceFilter()+'<select id=\"type-filter\"", 'Add a device control beside the existing source and type controls')
replace('可以清除关键词、类型或时间筛选。', '可以清除关键词、设备、类型或时间筛选。', 'Source-empty advice covers the active device filter')

replace('function libraryView(rows,filtering){', r'''function captureApplicationLabel(m){return ({browser:'浏览器',editor:'编辑器',messaging:'即时通讯'})[m.captureApplication]||'应用未注明';}
function captureTime(m){return m.capturedAt?m.capturedAt.slice(11,16):(m.date.match(/\d{1,2}:\d{2}/)?.[0]||'');}
function captureRecordCard(m,kind='raw'){
 return '<article class="card section" data-capture-id="'+esc(m.id)+'"><div class="flex-spread"><h3 data-user-content>'+esc(m.title)+'</h3>'+tag(kind==='raw'?'原始记录':'屏幕片段','purple')+'</div><p><time datetime="'+esc(m.capturedAt||captureDate(m))+'">'+esc(captureDate(m)+' '+captureTime(m))+'</time> · <span>'+esc(materialDeviceLabel(materialDeviceId(m)))+'</span> · <span>'+esc(captureApplicationLabel(m))+'</span></p><div class="evidence-box section"><strong>采集到的原始文字</strong><p data-user-content>'+esc(m.body)+'</p></div><div class="actions card-foot">'+button('打开原始内容','original','data-id="'+m.id+'"','primary')+button('阅读整理后的资料','open-material','data-id="'+m.id+'"','text')+button('删除这条原始记录','delete-record','data-id="'+m.id+'"','text')+'</div></article>';
}
function snippetLibraryView(records){
 const dates=[...new Set(state.materials.filter(m=>m.type==='screen'&&!state.deletedRecords.includes(m.id)).map(captureDate))].sort().reverse(),groups=new Map();
 records.forEach(m=>{const key=[captureDate(m),materialDeviceId(m),state.snippetGrouping==='application'?(m.captureApplication||'unknown'):(m.captureSessionId||m.id)].join('|');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(m);});
 const controls='<div class="grid two section"><label class="field"><span>采集日期</span><select id="capture-date-filter" class="field-input"><option value="all">全部采集日期</option>'+dates.map(date=>'<option value="'+esc(date)+'" '+(state.captureDateFilter===date?'selected':'')+'>'+esc(date)+'</option>').join('')+'</select></label><label class="field"><span>片段分组</span><select id="snippet-grouping" class="field-input"><option value="session" '+(state.snippetGrouping==='session'?'selected':'')+'>连续会话</option><option value="application" '+(state.snippetGrouping==='application'?'selected':'')+'>应用相册</option></select></label></div>';
 const header='<div class="section-head"><p role="status" data-snippet-count>'+groups.size+' 组 · '+records.length+' 条片段</p>'+goButton('调整记录范围','setup/screen','text')+'</div>';
 return controls+header+(records.length?[...groups].map(([key,items],index)=>{const first=items[0],times=items.map(captureTime).filter(Boolean).sort(),range=times[0]===times[times.length-1]?times[0]:times[0]+'–'+times[times.length-1];return '<section class="card section" data-capture-group="'+esc(key)+'" data-grouping="'+state.snippetGrouping+'"><div class="flex-spread"><h3><span>'+(state.snippetGrouping==='session'?'连续会话 '+(index+1):'应用相册')+'</span> · <span>'+esc(captureApplicationLabel(first))+'</span></h3>'+tag(items.length+' 条片段','purple')+'</div><p><time>'+esc(captureDate(first))+'</time> · <span>'+esc(materialDeviceLabel(materialDeviceId(first)))+'</span> · <span>'+esc(range)+'</span></p><p class="small muted">'+(state.snippetGrouping==='session'?'同一设备上连续会话内的记录按时间排列。':'同一日期、设备与应用的记录放在一个相册中。')+'</p>'+items.map(m=>captureRecordCard(m,'snippet')).join('')+'</section>';}).join(''):'<div class="empty"><h2>这个范围没有截图片段</h2><p>调整采集日期、设备或其他筛选后再查看。</p>'+button('清除筛选','clear-filters','','subtle')+'</div>');
}
function libraryView(rows,filtering){''',
        'Group existing screenshot evidence by explicit session or app plus date and device')
old = '''  if(['raw','snippets'].includes(state.filter)){
   const records=rows.filter(m=>m.type==='screen'&&!state.deletedRecords.includes(m.id));
   return '<div class="section-head"><p>'+records.length+' 条记录 · 浏览器 · 10月18日</p>'+goButton('调整记录范围','setup/screen','text')+'</div>'+(records.length?records.map(m=>'<div class="card"><div class="flex-spread"><h3>'+esc(m.title)+'</h3>'+tag(state.filter==='raw'?'原始记录':'屏幕片段','purple')+'</div><p>'+esc(m.date)+' · '+esc(m.device)+' · 浏览器</p><div class="evidence-box section"><strong>浏览器页面文字</strong><p>'+esc(m.body)+'</p></div><div class="actions card-foot">'+button('打开原始内容','original','data-id="'+m.id+'"','primary')+goButton('阅读整理后的资料','material/'+m.id,'text')+button('删除这条原始记录','delete-record','data-id="'+m.id+'"','text')+'</div></div>').join(''):'<div class="empty"><h2>这个范围没有原始记录</h2><p>可更改筛选，或连接屏幕记录来源。</p></div>');
  }'''
new = '''  if(['raw','snippets'].includes(state.filter)){
   const records=rows.filter(m=>m.type==='screen'&&!state.deletedRecords.includes(m.id));
   if(state.filter==='snippets')return snippetLibraryView(records);
   return '<div class="section-head"><p role="status">'+records.length+' 条记录</p>'+goButton('调整记录范围','setup/screen','text')+'</div>'+(records.length?records.map(m=>captureRecordCard(m)).join(''):'<div class="empty"><h2>这个范围没有原始记录</h2><p>可更改设备、来源或时间筛选，或连接屏幕记录来源。</p>'+button('清除筛选','clear-filters','','subtle')+'</div>');
  }'''
replace('\n'.join(line[1:] for line in old.split('\n')), new, 'Raw records share real metadata and evidence links without a hardcoded list date/app')
replace("body='<div class=\"evidence-box\"><strong>'+esc(state.original?.title||'原始资料')+'</strong><p>'+esc(state.original?.origin||'示例来源')+'</p><p>'+esc(state.original?.body||'')+'</p></div>';}",
        "body='<div class=\"evidence-box\"><strong data-user-content>'+esc(state.original?.title||'原始资料')+'</strong><p data-user-content>'+esc(state.original?.origin||'示例来源')+'</p>'+(state.original?.type==='screen'?'<p><span>采集时间：</span><time>'+esc(captureDate(state.original)+' '+captureTime(state.original))+'</time></p><p><span>设备：</span><span>'+esc(materialDeviceLabel(materialDeviceId(state.original)))+'</span> · <span>'+esc(captureApplicationLabel(state.original))+'</span></p>':'')+'<p data-user-content>'+esc(state.original?.body||'')+'</p></div>';}",
        'Original evidence displays the exact capture metadata and protects its content')

replace('function connectedSourceFields(id,choice,cfg){', r'''const sourceRelationOptions=[['','不声明'],['owner','我的表达或经历'],['third_party','第三方内容'],['mixed','混合内容'],['unknown','归属未知']];
function savedSourceContext(id){const cfg=state.sourceConfigs?.[id]||{};return {ownerRelation:cfg.ownerRelation||'',contextDescription:cfg.contextDescription||''};}
function sourceContextDraft(id){return state.sourceContextDrafts[id]||savedSourceContext(id);}
function sourceContextDirty(id){return JSON.stringify(sourceContextDraft(id))!==JSON.stringify(savedSourceContext(id));}
function sourceRelationshipFields(id){
 const saved=savedSourceContext(id),draft=sourceContextDraft(id),dirty=sourceContextDirty(id);
 return '<section class="card section" data-source-context-id="'+esc(id)+'"><h2>内容与你的关系</h2><p class="small muted">声明帮助模型区分你的表达、第三方内容和混合引用；归属未知也能查询和整理。</p><p class="small muted">来源声明应用于已有和新资料；单份资料的声明优先。修改说明不会自动重新转写或重算历史记忆。</p><div class="evidence-box section" data-source-context-saved><h3>已保存的来源关系</h3><p>'+esc(sourceRelationOptions.find(([value])=>value===saved.ownerRelation)?.[1]||'不声明')+'</p>'+(saved.contextDescription?'<p data-user-content>'+esc(saved.contextDescription)+'</p>':'<p class="small muted">尚未填写来源背景说明。</p>')+'</div><label class="field section"><span>内容关系</span><select id="source-relation" class="field-input">'+sourceRelationOptions.map(([value,label])=>'<option value="'+value+'" '+(draft.ownerRelation===value?'selected':'')+'>'+label+'</option>').join('')+'</select></label><label class="field"><span>来源背景说明（选填）</span><textarea id="source-context-description" class="field-input" rows="3" data-user-content>'+esc(draft.contextDescription)+'</textarea><small>可说明格式、时间、作者，以及哪些内容属于你。</small></label><p role="status" data-source-context-status>'+(dirty?'关系修改尚未保存，离开后可以回来继续。':'当前关系与已保存设置一致。')+'</p><div class="actions card-foot">'+button('保存内容关系','save-source-context','data-id="'+esc(id)+'" '+(dirty?'':'disabled'),'primary')+button('放弃关系修改','discard-source-context','data-id="'+esc(id)+'" '+(dirty?'':'disabled'),'text')+'</div></section>';
}
function updateSourceContextDraft(target){
 if(!['source-relation','source-context-description'].includes(target.id))return;
 const panel=target.closest('[data-source-context-id]');if(!panel)return;
 const id=panel.dataset.sourceContextId;
 state.sourceContextDrafts[id]={ownerRelation:panel.querySelector('#source-relation').value,contextDescription:panel.querySelector('#source-context-description').value};
 const dirty=sourceContextDirty(id),label=dirty?'关系修改尚未保存，离开后可以回来继续。':'当前关系与已保存设置一致。';
 panel.querySelector('[data-source-context-status]').textContent=state.language==='en'?translateUI(label):label;
 panel.querySelectorAll('[data-action="save-source-context"],[data-action="discard-source-context"]').forEach(button=>button.disabled=!dirty);
 persist();
}
function connectedSourceFields(id,choice,cfg){''',
        'Independent source-level relationship editor with saved context and resumable drafts')
replace("+(kind==='folder'&&existing?'<div class=\"section\">'+goButton('连接另一个文件夹','setup/folder/new','text')+'</div>':'')+'</div>';",
        "+(kind==='folder'&&existing?'<div class=\"section\">'+goButton('连接另一个文件夹','setup/folder/new','text')+'</div>':'')+(existing?sourceRelationshipFields(id):'')+'</div>';",
        'Expose the relation editor for each exact connected source')
replace('<span>持续同步后续变化<small>这是恢复接收后的策略。暂停时不接收新变化，已保存内容仍保留。</small>',
        "<span>持续同步后续变化<small>'+(creating?'这是连接后的同步方式。':'这是恢复接收后的策略。')+'暂停时不接收新变化，已保存内容仍保留。</small>",
        'New folder setup describes connection policy; existing folders describe recovery policy')
replace(" if(action==='discard-screen-draft')", r''' if(action==='save-source-context'){
  const id=el.dataset.id,draft=sourceContextDraft(id);if(!state.sources.some(s=>s.id===id))return;
  state.sourceConfigs={...state.sourceConfigs,[id]:{...(state.sourceConfigs?.[id]||{}),...draft}};delete state.sourceContextDrafts[id];persist();return notify('这个来源的内容关系已保存。');
 }
 if(action==='discard-source-context'){delete state.sourceContextDrafts[el.dataset.id];persist();return render();}
 if(action==='discard-screen-draft')''',
        'Save/discard context independently of source intake, authorization and screen scope')
replace("document.addEventListener('input',e=>{if(state.page==='setup/folder/new'",
        "document.addEventListener('input',e=>updateSourceContextDraft(e.target));\ndocument.addEventListener('input',e=>{if(state.page==='setup/folder/new'",
        'Persist only source-context inputs without rerendering or losing cursor/focus')

replace('function devicesPage(){', r'''function sendPauseStatus(showActive=false){
 if(!state.sendPaused&&!showActive)return '';
 return '<section class="notice '+(state.sendPaused?'warn':'good')+' section" data-send-status="'+(state.sendPaused?'paused':'active')+'"><div><strong>'+(state.sendPaused?'本机继续保留，向中央发送已暂停':'向中央发送已开启')+'</strong><p>'+(state.sendPaused?'各设备继续按本机设置保留内容，待发送内容会在恢复后继续同步。':'允许发送的本机内容会按各来源的设置同步到中央。')+'</p><p>屏幕采集、单个来源接收、向中央发送分别控制，状态独立保留。</p><div class="actions">'+button(state.sendPaused?'恢复全部发送':'暂停全部发送',state.sendPaused?'resume-all':'pause-all','','subtle')+'</div></div></section>';
}
function devicesPage(){''',
        'Separate global send scope from screen capture and per-source intake')
replace("button(icon('plus')+' 连接来源','source-add','','primary'))+'<div class=\"notice\">",
        "button(icon('plus')+' 连接来源','source-add','','primary'))+sendPauseStatus()+'<div class=\"notice\">",
        'Persistently expose paused transport and recovery in sources')
replace("goButton('连接设备','setup/device','primary'))+'<div class=\"notice\"><div>工作台是资料汇集的位置。",
        "goButton('连接设备','setup/device','primary'))+sendPauseStatus()+'<div class=\"notice\"><div>工作台是资料汇集的位置。",
        'Persistently expose paused transport and recovery in devices')
replace("<h3>同步状态</h3><p>待发送 '+d.pending+' 项 · 最近接收刚刚<br>资料正文可阅读，记忆整理单独进行。</p>",
        "<h3>同步状态</h3><p>'+(state.sendPaused?'向中央发送已暂停':'向中央发送已开启')+'</p><p>待发送 '+d.pending+' 项</p><p>资料正文可阅读，记忆整理单独进行。</p>",
        'Device sync state reflects transport pause without changing capture status or mock pending count')
replace("+button('暂停全部发送','pause-all','','subtle')+'</div>';",
        "+'</div>'+sendPauseStatus(true);",
        'Privacy displays current send state and the appropriate pause/resume action')
replace(" if(action==='pause-all')return showInfo('暂停全部发送','各端继续保留本机内容，恢复发送后再同步。',button('暂停发送演示','generic-save','','primary'));",
        " if(action==='pause-all')return showInfo('暂停全部发送','各端继续保留本机内容，恢复发送后再同步。','<p>屏幕采集、单个来源接收、向中央发送分别控制，状态独立保留。</p><div class=\"form-actions\">'+button('确认暂停全部发送','confirm-pause-all','','primary')+button('取消','close-modal','','subtle')+'</div>');\n if(action==='confirm-pause-all'){state.sendPaused=true;state.modal='';persist();return notify('向中央发送已暂停，本机内容继续保留。');}\n if(action==='resume-all'){state.sendPaused=false;persist();return notify('向中央发送已恢复。屏幕采集和各来源接收保持原有状态。');}",
        'Replace generic-save with confirmed, persistent send pause and explicit recovery')

# Keep each reset/edit separate from the surrounding large dispatch function.
for action in ['clear-filters', 'browse-source', 'clear-source-scope', 'clear-source-filters']:
    old = "if(action==='"+action+"'){"
    replace(old, old+"state.deviceFilter='all';state.captureDateFilter='all';", 'Clear new scopes through '+action)
replace("state.sourceScopeId='';return go('library/'+f);", "state.sourceScopeId='';state.deviceFilter='all';state.captureDateFilter='all';return go('library/'+f);", 'Collection switch resets device and capture-date scope consistently')
replace("if(id==='source-filter'){state.sourceScopeId=", "if(id==='device-filter'){state.deviceFilter=v;persist();render();}if(id==='capture-date-filter'){state.captureDateFilter=v;persist();render();}if(id==='snippet-grouping'){state.snippetGrouping=v;persist();render();}if(id==='source-filter'){state.sourceScopeId=", 'Wire the three actual filter/group controls using stable values')

strings = {
 '来源同步 · 查看输入、状态与恢复方式。':'Source sync · Review inputs, status, and recovery options.',
 '最近一次读取：今天 09:20':'Last read: Today at 09:20',
 '这些资料保留在此来源范围内，可以继续阅读。':'These materials remain readable within this source.',
 '此来源尚无已保存资料。其他来源的内容保持各自范围。':'This source has no saved materials yet. Other sources retain their own material scopes.',
 '按设备筛选':'Filter by device', '全部设备':'All devices', '设备未注明':'Device unspecified', '网页':'Web', '中央':'Central',
 '采集日期：':'Capture date: ',
 '采集时间：':'Captured at: ', '设备：':'Device: ',
 '按采集日期、设备、连续会话或应用相册回看屏幕片段。':'Review screen snippets by capture date, device, continuous session, or app album.',
 '可以清除关键词、设备、类型或时间筛选。':'Clear the keyword, device, type, or time filters.',
 '应用未注明':'App unspecified', '采集到的原始文字':'Original captured text',
 '采集日期':'Capture date', '全部采集日期':'All capture dates', '片段分组':'Group snippets',
 '连续会话':'Continuous sessions', '应用相册':'App albums',
 '同一设备上连续会话内的记录按时间排列。':'Records from a continuous session on one device are ordered by time.',
 '同一日期、设备与应用的记录放在一个相册中。':'Records from the same date, device, and app appear in one album.',
 '这个范围没有截图片段':'No screenshot snippets in this scope',
 '调整采集日期、设备或其他筛选后再查看。':'Adjust the capture date, device, or other filters to see snippets.',
 '可更改设备、来源或时间筛选，或连接屏幕记录来源。':'Change the device, source, or time filters, or connect a screen recording source.',
 '不声明':'No declaration', '我的表达或经历':'My expression or experience', '第三方内容':'Third-party content', '混合内容':'Mixed content', '归属未知':'Ownership unknown',
 '内容与你的关系':'How this content relates to you',
 '声明帮助模型区分你的表达、第三方内容和混合引用；归属未知也能查询和整理。':'A declaration helps models distinguish your expression, third-party content, and mixed quotations. Content with unknown ownership remains available for questions and organization.',
 '来源声明应用于已有和新资料；单份资料的声明优先。修改说明不会自动重新转写或重算历史记忆。':'Source declarations apply to existing and new materials; a material-specific declaration takes precedence. Editing this description does not automatically transcribe content again or rebuild earlier memories.',
 '已保存的来源关系':'Saved source relationship', '尚未填写来源背景说明。':'No source background description has been saved.',
 '内容关系':'Content relationship', '来源背景说明（选填）':'Source background description (optional)',
 '可说明格式、时间、作者，以及哪些内容属于你。':'Describe the format, time, author, and which content is yours.',
 '关系修改尚未保存，离开后可以回来继续。':'Relationship changes are not saved yet. You can leave and return to continue.',
 '当前关系与已保存设置一致。':'The current relationship matches the saved settings.',
 '保存内容关系':'Save content relationship', '放弃关系修改':'Discard relationship changes',
 '这个来源的内容关系已保存。':'The content relationship for this source has been saved.',
 '这是连接后的同步方式。暂停时不接收新变化，已保存内容仍保留。':'This is the sync policy after connecting. While paused, no new changes are received and saved content is retained.',
 '本机继续保留，向中央发送已暂停':'Content stays on the device; sending to Central is paused',
 '向中央发送已开启':'Sending to Central is enabled', '向中央发送已暂停':'Sending to Central is paused',
 '各设备继续按本机设置保留内容，待发送内容会在恢复后继续同步。':'Each device keeps content according to its local settings. Pending content will sync after sending resumes.',
 '允许发送的本机内容会按各来源的设置同步到中央。':'Local content allowed for sending syncs to Central according to each source’s settings.',
 '屏幕采集、单个来源接收、向中央发送分别控制，状态独立保留。':'Screen capture, intake from each source, and sending to Central have separate controls and retain independent states.',
 '恢复全部发送':'Resume all sending', '确认暂停全部发送':'Confirm pause for all sending',
 '向中央发送已暂停，本机内容继续保留。':'Sending to Central is paused. Local content is retained.',
 '向中央发送已恢复。屏幕采集和各来源接收保持原有状态。':'Sending to Central has resumed. Screen capture and source intake retain their previous states.'
}
dynamic = [
 {'pattern':r'^(\d+) 组 · (\d+) 条片段$', 'template':'{0} groups · {1} snippets'},
 {'pattern':r'^连续会话 (\d+)$', 'template':'Continuous session {0}'},
 {'pattern':r'^(\d+) 条片段$', 'template':'{0} snippet(s)'}
]
replace('function translateUI(text,depth=0){',
        'Object.assign(englishLabels,'+json.dumps(strings,ensure_ascii=False,separators=(',',':'))+');\nfunction translateUI(text,depth=0){',
        'Static English labels for source, device, capture grouping and send scope')
replace(' let m;\n', ' let m;\n'+r'''  if((m=key.match(/^(\d+) 组 · (\d+) 条片段$/)))return m[1]+' group'+(m[1]==='1'?'':'s')+' · '+m[2]+' snippet'+(m[2]==='1'?'':'s');
  if((m=key.match(/^连续会话 (\d+)$/)))return 'Continuous session '+m[1];
  if((m=key.match(/^(\d+) 条片段$/)))return m[1]+' snippet'+(m[1]==='1'?'':'s');
''', 'English templates for computed group, session and evidence counts')

TARGET.write_text(text)
(ROOT / 'reports/source-r18-replacements.json').write_text(json.dumps({
 'base':'dist/r17.html', 'base_sha256':baseline_sha, 'target':'work/source-r18.html',
 'target_sha256':hashlib.sha256(text.encode()).hexdigest(), 'apply':'sequential; each old must match once', 'replacements':changes
},ensure_ascii=False,indent=2)+'\n')
(ROOT / 'reports/source-r18-new-strings.json').write_text(json.dumps({'static':strings,'dynamic':dynamic},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'target':str(TARGET),'replacements':len(changes),'bytes':len(text.encode()),'sha256':hashlib.sha256(text.encode()).hexdigest()},ensure_ascii=False))
