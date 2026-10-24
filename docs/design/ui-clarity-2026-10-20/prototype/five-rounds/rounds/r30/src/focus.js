/* R30+: focused task surfaces. Product semantics come from the independent contract. */
(() => {
  'use strict';
  const t=(zh,en)=>state.language==='en'?en:zh;
  const act=(label,name,kind='subtle',extra='')=>button(label,'focus-'+name,extra,kind);
  const route=(label,page,kind='subtle')=>goButton(label,page,kind);
  const native=()=>state.surface!=='web';
  const defaults=()=>({files:[],name:'',instruction:'',parser:'default',image:'default',save:'archive'});
  const parserOptions=[['default','默认格式处理或模型解析','Default format or model parsing'],['markdown@1.0.0','文档与笔记 · 1.0.0','Documents and notes · 1.0.0'],['chat@1.0.0','聊天导出 · 1.0.0','Chat export · 1.0.0'],['audio@1.0.0','音频与转写 · 1.0.0','Audio and transcription · 1.0.0']];
  const phaseLabels={queued:['原件已归档','Originals archived'],preparing:['正在理解资料','Preparing preview'],review:['等待你确认','Awaiting your confirmation'],importing:['正在保存记录','Saving records'],done:['记录已保存','Records saved'],failed:['需要重试','Retry needed'],cancelled:['已取消处理','Processing cancelled'],needs_configuration:['等待配置模型','Model configuration needed'],unsupported:['原件已保留 · 格式待处理','Originals retained · format unsupported'],paused:['上传已暂停','Upload paused'],uploading:['正在上传','Uploading'],throttled:['等待上传名额','Waiting for upload capacity'],stopping:['正在停止','Stopping']};
  const sampleFiles=[{name:'读书笔记.md',path:'读书笔记.md',bytes:2400},{name:'会议记录.txt',path:'项目/会议记录.txt',bytes:3600},{name:'访谈录音.wav',path:'录音/访谈录音.wav',bytes:43000},{name:'资料归档.zip',path:'资料归档.zip',bytes:18400}];
  function init(){
    state.focus=state.focus||{};
    const f=state.focus;
    f.importDraft=f.importDraft||defaults();f.importEdits=f.importEdits||{};
    f.details=f.details||{};f.sourceVersions=f.sourceVersions||{};f.sourceConflicts=f.sourceConflicts||{};f.attributionDrafts=f.attributionDrafts||{};
    state.importOrigin='电脑文件';
    // No central-local collector fixture can survive the superseded prototype.
    state.sources=state.sources.filter(s=>s.deviceId!=='workspace'&&state.sourceConfigs?.[s.id]?.location!=='workspace');
  }
  function select(label,id,options,value,help=''){
    return '<label class="field"><span>'+label+'</span><select id="'+id+'" class="field-input">'+options.map(([v,zh,en])=>'<option value="'+v+'" '+(v===value?'selected':'')+'>'+esc(t(zh,en||zh))+'</option>').join('')+'</select>'+(help?'<small>'+help+'</small>':'')+'</label>';
  }
  function disclosure(id,title,body,extra='',open=false){
    return '<details class="focus-disclosure" id="'+id+'" '+(open?'open':'')+'><summary><span>'+title+'</span>'+(extra?'<small>'+extra+'</small>':'')+'</summary><div class="focus-disclosure-body">'+body+'</div></details>';
  }
  function phase(job){const row=phaseLabels[job.phase]||phaseLabels.queued;return t(row[0],row[1]);}
  function filesOf(job){return job.files||[{name:job.sourceFile||job.name,path:job.sourceFile||job.name,bytes:2400}];}
  function parserLabel(id){const row=parserOptions.find(x=>x[0]===id);return row?t(row[1],row[2]):id||t('默认格式处理或模型解析','Default format or model parsing');}
  function imageLabel(id){return id==='archive'?t('仅保存原件','Archive originals only'):id==='local-ocr'?t('本机 OCR · 示例方案','Local OCR · sample profile'):t('跟随默认设置','Follow default');}
  function instructionField(id,value){
    return '<label class="field focus-context"><span>'+t('格式、作者与归属说明','Format, authors and ownership')+' <em>'+t('选填','Optional')+'</em></span><textarea id="'+id+'" class="field-input" rows="4" maxlength="12000" placeholder="'+t('例如：这是我的读书笔记；引文属于原作者。时间为北京时间，按每篇笔记分别理解。','For example: these are my reading notes; quotations belong to their authors. Times are Beijing time. Treat each note separately.')+'" data-user-content>'+esc(value)+'</textarea><small>'+t('帮助 Agent 理解资料的格式、时间、作者和背景。第三方与 AI 引文保留原角色。','Help the Agent understand format, dates, authors and background. Third-party and AI quotations keep their original roles.')+'</small><small class="focus-character-count">'+value.length+' / 12,000</small></label>';
  }
  function fileList(files,editable=false){
    return '<ul class="focus-file-list">'+files.map((f,i)=>'<li><span>'+icon('file')+'<span data-user-content><strong>'+esc(f.name)+'</strong><small>'+esc(f.path)+' · '+Number(f.bytes||0).toLocaleString()+' B</small></span></span>'+(editable?act(t('移除','Remove'),'remove-file','text','data-index="'+i+'" aria-label="'+t('移除 ','Remove ')+esc(f.name)+'"'):'')+'</li>').join('')+'</ul>';
  }
  function importForm(){
    const d=state.focus.importDraft,chosen=d.files.length>0;
    return heading(t('导入资料','Import materials'),t('保存这次选定的文件，让以后查找和提问有据可依。','Save the files you choose so you can find and ask about them later.'),route(t('导入记录','Import history'),'imports','text'))+
    '<section class="focus-task reading" aria-label="'+t('导入设置','Import settings')+'"><section class="focus-zone"><div class="focus-zone-title"><span class="focus-step">1</span><h2>'+t('选择资料','Choose materials')+'</h2></div>'+
    (chosen?fileList(d.files,true)+'<div class="actions">'+act(t('继续添加文件','Add more files'),'choose-files','text')+act(t('清空选择','Clear selection'),'clear-files','text')+'</div>':'<div class="focus-upload" id="focus-dropzone"><span>'+icon('upload')+'</span><p>'+t('文档、图片、音频、ZIP 或文件夹','Documents, images, audio, ZIP or folders')+'</p>'+act(t('选择文件','Choose files'),'choose-files','primary')+'<small>'+t('也可以拖放文件；本次导入不跟踪后续变化。','You can also drop files here. This import does not track later changes.')+'</small></div>')+
    (state.focus.importError?'<p class="form-error" role="alert">'+esc(state.focus.importError)+'</p>':'')+'</section>'+
    '<section class="focus-zone"><div class="focus-zone-title"><span class="focus-step">2</span><h2>'+t('补充理解资料所需的信息','Add context for understanding')+'</h2></div>'+instructionField('focus-import-instruction',d.instruction)+'</section>'+
    disclosure('focus-import-options',t('名称、解析与图片处理','Name, parsing and image processing'),field(t('资料名称（选填）','Material name (optional)'),'focus-import-name',d.name)+
      select(t('解析方式','Format parser'),'focus-import-parser',parserOptions,d.parser,t('解析方式负责格式处理；上面的说明负责资料背景与归属。','The parser handles the format; the explanation above describes background and ownership.'))+
      select(t('本次图片处理','Images in this import'),'focus-import-image',[['default','跟随默认设置','Follow default'],['archive','仅保存原件','Archive originals only'],['local-ocr','本机 OCR · 示例方案','Local OCR · sample profile']],d.image)+
      '<p class="small muted">'+t('原件先归档。仅保存原件不会标记为已完成识别。','Originals are archived first. Archive-only does not mean recognition is complete.')+'</p>',parserLabel(d.parser)+' · '+imageLabel(d.image))+
    '<div class="focus-submit">'+act(t('上传并查看预览','Upload and preview'),'submit-import','primary',chosen?'':'disabled')+route(t('稍后继续','Continue later'),'imports','text')+'</div></section>'+
    '<p class="focus-task-foot">'+t('想持续收集文件夹变化？','Want to keep later folder changes?')+' '+route(t('到采集端设置','Set up on a collector'),'setup/folder/new','text')+'</p>';
  }
  function importInstructions(job,editable=false){
    const saved=job.instruction??job.context??'';
    return '<section class="focus-saved-context"><h3>'+t('本次导入说明','Explanation for this import')+'</h3><p class="focus-pre" data-user-content>'+esc(saved||t('未填写。原件仍会保留，已提取的正文可以检索。','No explanation supplied. Originals are retained and extracted text can be searched.'))+'</p><p class="small muted">'+t('说明只在声明的范围内生效，第三方和 AI 引文不会整批归为你的表达。','The explanation applies within its stated scope; third-party and AI quotations are not relabelled as your own speech.')+'</p></section>'+
    (editable?disclosure('focus-revise-'+job.id,t('补充说明，重新理解资料','Revise context and regenerate preview'),instructionField('focus-revised-instruction',state.focus.importEdits[job.id]??saved)+act(t('重新生成预览','Regenerate preview'),'reprepare-import','primary','data-id="'+job.id+'"'),''):'' );
  }
  function importReview(job){
    return heading(t('核对资料的理解方式','Review the interpretation'),job.name,route(t('返回导入记录','Back to import history'),'imports','text'))+
    '<article class="reading focus-task" data-import-detail="'+job.id+'"><p class="focus-status">'+tag(t('原件已归档','Originals archived'),'green')+'<span>'+t('记录尚未保存','Records are not published yet')+'</span></p>'+
    '<section class="focus-zone"><h2>'+t('这次将保存什么','What will be saved')+'</h2><p>'+t('需要确认：示例资料含有引用与多位说话人，请核对范围后再保存。','Review needed: the sample contains quotations and several speakers. Check the scope before saving.')+'</p>'+
    '<div class="focus-preview"><span class="eyebrow">'+t('解析预览 · 演示内容','PREVIEW · SYNTHETIC CONTENT')+'</span><h3 data-user-content>'+esc(job.name)+'</h3><p>'+t('示例原文：“先核对资料来源，再继续整理。”','Sample text: “Check the sources before organizing the material.”')+'</p><p class="small muted">'+t('保留原说话人和出处；这里不执行真实模型解析。','Original speaker roles and provenance are retained. This preview does not call a real model.')+'</p></div>'+
    '<p class="small">'+t('预计记录：','Expected records: ')+filesOf(job).length+t(' · 附件：0 · 警告：请核对引用归属',' · Attachments: 0 · Warning: review quotation ownership')+'</p></section>'+
    '<section class="focus-zone">'+importInstructions(job,true)+'</section>'+
    disclosure('focus-review-options',t('核对文件与处理方式','Review files and processing'),fileList(filesOf(job))+'<dl class="focus-dl"><div><dt>'+t('解析方式','Parser')+'</dt><dd>'+esc(parserLabel(job.parser))+'</dd></div><div><dt>'+t('图片处理','Images')+'</dt><dd>'+esc(imageLabel(job.imageScheme))+'</dd></div></dl>'+act(t('修改文件或选项','Edit files or options'),'edit-import','text','data-id="'+job.id+'"'))+
    (job.confirmError?'<p role="alert" class="form-error">'+esc(job.confirmError)+'</p>':'')+
    '<div class="focus-submit">'+act(t('确认并保存记录','Confirm and save records'),'confirm-import','primary','data-id="'+job.id+'"')+route(t('稍后确认','Review later'),'imports','text')+'</div></article>';
  }
  function importDetail(job){
    const active=['queued','preparing','importing','uploading','throttled','stopping'].includes(job.phase);
    const canRevise=['review','failed','unsupported','needs_configuration','cancelled'].includes(job.phase);
    const files=filesOf(job);
    let next='';
    if(job.phase==='done')next=route(t('阅读导入结果','Read imported material'),'material/'+job.materialId,'primary');
    else if(job.phase==='review')next=route(t('核对并继续','Review and continue'),'import/review/'+job.id,'primary');
    else if(job.phase==='needs_configuration')next=act(t('配置模型后继续','Configure a model to continue'),'import-model','primary','data-id="'+job.id+'"');
    else if(['failed','cancelled','unsupported','paused'].includes(job.phase))next=act(t('继续这次导入','Continue this import'),'reprepare-import','primary','data-id="'+job.id+'"');
    else if(job.phase==='stopping')next='<p role="status">'+t('正在停止，等当前步骤结束后可以重试。','Stopping. Retry becomes available after the current step ends.')+'</p>';
    else next=act(t('查看解析预览（模拟完成）','View parsing preview (simulate completion)'),'reprepare-import','primary','data-id="'+job.id+'"');
    return heading(t('导入详情','Import detail'),job.name,route(t('返回导入记录','Back to import history'),'imports','text'))+
    '<article class="reading focus-task" data-import-detail="'+job.id+'"><section class="focus-zone"><div class="section-head"><h2>'+phase(job)+'</h2><span class="small muted">'+files.length+t(' 个文件',' files')+'</span></div>'+
    '<ol class="focus-progress"><li class="complete">'+t('原件已归档','Originals archived')+'</li><li class="'+(['review','done'].includes(job.phase)?'complete':'')+'">'+t('理解与核对','Interpret and review')+'</li><li class="'+(job.phase==='done'?'complete':'')+'">'+t('记录可阅读','Records readable')+'</li><li>'+t('记忆单独整理','Memory processed separately')+'</li></ol>'+
    '<p class="small muted">'+(job.phase==='done'?t('原件和正文已保留；索引和记忆的进度单独显示。','Originals and readable text are retained; indexing and memory have separate progress.'):t('原件保留在这次任务中，离开页面可以稍后继续。','Originals stay attached to this task. You can leave and continue later.'))+'</p>'+
    '<div class="actions section">'+next+(active&&job.phase!=='stopping'?act(t('取消处理','Cancel processing'),'cancel-import','text','data-id="'+job.id+'"'):'')+'</div></section>'+
    '<section class="focus-zone">'+importInstructions(job,canRevise)+'</section>'+
    disclosure('focus-import-files',t('原件与文件解析情况','Originals and file outcomes'),files.map(f=>'<div class="focus-file-outcome"><strong data-user-content>'+esc(f.path)+'</strong><span>'+Number(f.bytes||0).toLocaleString()+' B · '+(job.phase==='unsupported'?t('未支持 · 原件保留','Unsupported · original retained'):job.phase==='done'?t('已解析 · 1 条记录','Parsed · 1 record'):t('等待解析或确认','Waiting for parsing or confirmation'))+'</span>'+act(t('查看原件','View original'),'import-original','text','data-id="'+job.id+'" data-file="'+esc(f.name)+'"')+'</div>').join(''))+
    disclosure('focus-import-saved-options',t('解析、图片与处理进度','Parser, images and processing status'),'<dl class="focus-dl"><div><dt>'+t('解析方式','Parser')+'</dt><dd>'+esc(parserLabel(job.parser))+'</dd></div><div><dt>'+t('本次图片方案','Image profile')+'</dt><dd>'+esc(imageLabel(job.imageScheme))+'</dd></div><div><dt>'+t('索引','Index')+'</dt><dd>'+t(job.phase==='done'?'等待索引 · 正文可阅读':'等待记录','Awaiting '+(job.phase==='done'?'indexing · text is readable':'records'))+'</dd></div><div><dt>'+t('记忆','Memory')+'</dt><dd>'+t('未自动发起 · 可稍后手动整理','Not started automatically · organize later')+'</dd></div></dl>'+route(t('查看后台工作','View background work'),'activity','text'))+
    disclosure('focus-import-more',t('更多操作','More actions'),act(t('删除这次导入','Delete this import'),'delete-import','text','data-id="'+job.id+'" '+(active?'disabled':''))+'<p class="small muted">'+t('处理进行中不能删除。删除前会核对原件、记录与关联记忆的范围。','Deletion is disabled while work is in progress. Review originals, records and dependent memories before deleting.')+'</p>')+
    disclosure('focus-import-demo',t('预览不同处理状态','Preview processing states'),'<p class="small muted">'+t('以下仅用于验证原型中的恢复界面。','These controls only simulate recovery states in this prototype.')+'</p>'+select(t('演示状态','Demo state'),'focus-import-phase',Object.entries(phaseLabels).map(([id,l])=>[id,...l]),job.phase),'',false)+'</article>';
  }
  const oldImport=importPage;
  importPage=function(){
    init();
    const parts=state.page.split('/'),job=state.imports.find(b=>b.id===parts[2]);
    if(parts[1]==='review'&&job)return importReview(job);
    if(parts[1]==='details'&&job)return importDetail(job);
    return importForm();
  };
  importDetailsPage=function(){const job=state.imports.find(b=>b.id===state.page.split('/')[2]);return job?importDetail(job):importForm();};
  importsPage=function(){
    init();
    return heading(t('导入记录','Import history'),t('继续未完成的导入，或回看已经保存的资料。','Continue unfinished imports or revisit saved materials.'),act(t('导入资料','Import materials'),'new-import','primary'))+
    '<section class="focus-task" aria-label="'+t('导入任务列表','Import task list')+'">'+(state.imports.length?state.imports.map(b=>'<button class="focus-list-row" data-action="go" data-page="import/details/'+b.id+'"><span class="focus-list-icon">'+icon(b.phase==='done'?'check':'upload')+'</span><span><strong data-user-content>'+esc(b.name)+'</strong><small>'+filesOf(b).length+t(' 个文件 · ',' files · ')+phase(b)+'</small></span>'+icon('arrow')+'</button>').join(''):'<div class="empty"><h2>'+t('还没有导入记录','No imports yet')+'</h2><p>'+t('选一份文件，并补充帮助 Agent 理解它的说明。','Choose a file and add context that helps the Agent understand it.')+'</p>'+act(t('导入第一份资料','Import your first material'),'new-import','primary')+'</div>')+'</section>';
  };
  function collectorHandoff(){
    const id=state.page.split('/')[2]||'folder',source=state.sources.find(s=>s.id===id),device=state.devices.find(d=>d.id===(source?.deviceId||state.nuFolderDevice||'mac'));
    const title=source?t('文件夹来源','Folder source'):t('连接文件夹采集端','Connect a folder collector');
    return heading(title,t('文件夹由 Mac 或 Android 采集端选择和同步。','Folders are selected and synchronized by a Mac or Android collector.'),route(t('返回来源','Back to sources'),'sources','text'))+
    '<article class="reading focus-task"><section class="focus-zone"><span class="eyebrow">'+t('采集端 → 中央资料库','COLLECTOR → CENTRAL LIBRARY')+'</span><h2>'+t(device?'在「'+device.name+'」上选择文件夹':'先连接一台采集设备',device?'Choose a folder on “'+device.name+'”':'Connect a collector first')+'</h2><p>'+t('打开对应设备的 Mote → 来源 → 文件夹。选择本机范围后，中央接收资料，供你阅读、查找和提问。','Open Mote on that device → Sources → Folder. Choose a local scope. Central receives the material for reading, search and questions.')+'</p>'+
    (source?'<div class="focus-receipt"><strong data-user-content>'+esc(source.title)+'</strong><p>'+t('设备上报：','Reported by device: ')+esc(sourceStatusMessage(source.id,source))+'</p>'+act(t('浏览已接收资料','Browse received materials'),'browse-device-source','subtle','data-id="'+source.id+'"')+'</div>':'')+
    '<div class="actions section">'+(device?route(t('查看设备连接','View device connection'),'devices','primary'):act(t('连接 Mac 或 Android','Connect Mac or Android'),'connect-folder','primary'))+'</div></section>'+
    (source?sourceRelationshipFields(source.id):'')+
    '<div class="focus-task-foot">'+t('只想保存当前文件？','Only saving the current files?')+' '+route(t('一次导入资料','Import once'),'import','text')+'</div></article>';
  }
  const previousSetup=setupPage;
  setupPage=function(){init();if(state.surface==='web'&&state.page.startsWith('setup/folder'))return collectorHandoff();return previousSetup();};
  // The superseded central-folder enhancements are disabled, rather than hidden with CSS.
  enhanceWebFolderTarget=function(){};
  enhanceImportHandoff=function(){};
  const previousWelcome=newcomerWelcome;
  newcomerWelcome=function(){
    let html=previousWelcome();
    html=html.replaceAll('连接设备或工作台服务器的文件夹','由 Mac / Android 采集端同步').replaceAll('Connect a folder on a device or workspace server','Synced by a Mac / Android collector');
    return html;
  };
  // Historical A01 is explicitly superseded. No directory entry links to server scanning.
  const oldA01=DIRECTORY.find(x=>x.id==='A01');
  if(oldA01)Object.assign(oldA01,{title:'一次导入浏览器所选文件夹',purpose:'选择文件夹上传本次内容。持续同步在采集端设置。',path:'资料库 → 导入资料',go:'import',actions:['选择本机文件夹','填写资料说明','核对并保存']});
  if(CATALOG.directoryUnits){const unit=CATALOG.directoryUnits.find(x=>x.id==='A01');if(unit)Object.assign(unit,{title:'一次导入浏览器所选文件夹'});}
  const previousAction=doAction;
  doAction=function(action,el){
    if(action==='new-import'){state.focus.importDraft=defaults();state.focus.editImportId='';return go('import');}
    if(action==='save-source'&&state.surface==='web'&&el?.dataset.kind==='folder')return go('setup/folder/new');
    if(action==='save-model'&&state.focus?.returnImport){previousAction(action,el);return;}
    return previousAction(action,el);
  };
  function saveImportDraft(){
    const d=state.focus.importDraft;
    for(const [id,key] of [['focus-import-instruction','instruction'],['focus-import-name','name'],['focus-import-parser','parser'],['focus-import-image','image']]){
      const input=document.getElementById(id);if(input)d[key]=input.value;
    }
    persist();return d;
  }
  function addFiles(files){
    init();state.focus.importError='';
    if(!files.length){state.focus.importError=t('没有可导入的文件，请重新选择。','No importable files selected. Choose again.');return render();}
    state.focus.importDraft.files.push(...files);persist();state.modal='';render();
  }
  function commitImport(job){
    const id=job.materialId||'focus-material-'+job.id;
    job.phase='done';job.materialId=id;
    const material={id,title:job.name,type:filesOf(job).some(x=>x.name.endsWith('.wav'))?'audio':'file',source:'文件导入',date:'刚刚',device:importLocalDevice(),origin:filesOf(job).map(x=>x.path).join('、'),preview:'导入资料已保存，说明与原件可核对。',body:'示例原文：先核对资料来源，再继续整理。\n这是用于评审界面的合成资料；不执行真实模型理解。',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),saved:new Date().toISOString().slice(0,10),instruction:job.instruction,importId:job.id};
    const at=state.materials.findIndex(m=>m.id===id);if(at<0)state.materials.unshift(material);else state.materials[at]=material;
    persist();go('import/details/'+job.id);
  }
  function perform(action,el){
    init();const id=el?.dataset.id,job=state.imports.find(x=>x.id===id);
    if(action==='new-import'){state.focus.importDraft=defaults();state.focus.editImportId='';go('import');return;}
    if(action==='choose-files'){
      saveImportDraft();
      return showInfo(t('选择本次导入的资料','Choose materials for this import'),t('在原型里选择文件只记录名称与大小，不上传内容。','This prototype records filenames and sizes without uploading content.'),
      '<div class="fields">'+
      '<label class="field"><span>'+t('选择本机文件','Choose local files')+'</span><input type="file" id="focus-file-input" multiple></label>'+
      '<label class="field"><span>'+t('选择文件夹（本次上传）','Choose a folder (one-time upload)')+'</span><input type="file" id="focus-folder-input" multiple webkitdirectory></label>'+
      '<h3>'+t('或使用示例资料','Or use synthetic sample files')+'</h3><div class="focus-demo-files">'+sampleFiles.map((f,i)=>act(esc(f.name),'sample-file','subtle','data-index="'+i+'"')).join('')+act(t('全部示例文件','All sample files'),'sample-all','subtle')+'</div></div>');
    }
    if(action==='sample-file')return addFiles([{...sampleFiles[Number(el.dataset.index)]}]);
    if(action==='sample-all')return addFiles(sampleFiles.map(f=>({...f})));
    if(action==='remove-file'){state.focus.importDraft.files.splice(Number(el.dataset.index),1);persist();return render();}
    if(action==='clear-files'){state.focus.importDraft.files=[];persist();return render();}
    if(action==='submit-import'){
      const d=saveImportDraft();if(!d.files.length){state.focus.importError=t('先选择至少一个文件。','Choose at least one file.');return render();}
      if(d.instruction.length>12000){state.focus.importError=t('资料说明最多 12,000 字符。','Context must be at most 12,000 characters.');return render();}
      let b=state.imports.find(x=>x.id===state.focus.editImportId);
      if(!b){b={id:'focus-import-'+Date.now(),count:d.files.length};state.imports.unshift(b);}
      Object.assign(b,{name:d.name||d.files[0].name,instruction:d.instruction,parser:d.parser,imageScheme:d.image,files:d.files.map(f=>({...f})),phase:'review',sourceFile:d.files.map(f=>f.path).join('、'),device:importLocalDevice(),count:d.files.length,previewVersion:(b.previewVersion||0)+1});
      state.focus.editImportId='';persist();return go('import/review/'+b.id);
    }
    if(action==='edit-import'&&job){state.focus.importDraft={files:filesOf(job).map(f=>({...f})),name:job.name,instruction:job.instruction||'',parser:job.parser||'default',image:job.imageScheme||'default',save:'archive'};state.focus.editImportId=job.id;return go('import');}
    if(action==='reprepare-import'&&job){if(state.focus.importEdits[job.id]!=null)job.instruction=state.focus.importEdits[job.id];delete state.focus.importEdits[job.id];job.phase='review';job.previewVersion=(job.previewVersion||0)+1;persist();return go('import/review/'+job.id);}
    if(action==='confirm-import'&&job)return commitImport(job);
    if(action==='cancel-import'&&job){job.phase='cancelled';persist();return render();}
    if(action==='delete-import'&&job)return showInfo(t('删除这次导入？','Delete this import?'),job.name,
      '<p>'+t('会删除本次独占的原件、记录和依赖记忆；仍被其他任务引用的共享内容保留。外部原文件不受影响。','This removes originals, records and dependent memories used only by this import. Shared content referenced elsewhere and external original files remain.')+'</p><div class="actions section">'+act(t('确认删除这次导入','Confirm deletion'),'confirm-delete-import','danger','data-id="'+job.id+'"')+button(t('取消','Cancel'),'close-modal','','subtle')+'</div>');
    if(action==='confirm-delete-import'&&job){state.imports=state.imports.filter(x=>x.id!==job.id);state.materials=state.materials.filter(x=>x.id!==job.materialId);state.modal='';persist();return go('imports');}
    if(action==='import-original'&&job)return showInfo(t('已保留的原件','Retained original'),el.dataset.file,'<p data-user-content>'+esc(filesOf(job).find(f=>f.name===el.dataset.file)?.path||el.dataset.file)+'</p><p>'+t('合成文件预览。生产界面在这里打开或下载同一原件。','Synthetic file preview. The production UI opens or downloads this exact original here.')+'</p>'+importInstructions(job));
    if(action==='import-model'&&job){state.focus.returnImport=job.id;return go('settings/models');}
    if(action==='return-import'){const target=state.focus.returnImport;state.focus.returnImport='';return go('import/details/'+target);}
    if(action==='connect-folder'){state.nuSetupReturn='folder';return go('setup/device');}
    if(action==='browse-device-source'){state.sourceScopeId=id;return go('library');}
  }
  document.addEventListener('click',e=>{
    const el=e.target.closest('[data-action]');if(!el||!el.dataset.action.startsWith('focus-'))return;
    e.preventDefault();e.stopImmediatePropagation();if(el.disabled)return;perform(el.dataset.action.slice(6),el);
  },true);
  document.addEventListener('input',e=>{
    if(!e.target.id.startsWith('focus-'))return;init();
    if(['focus-import-instruction','focus-import-name'].includes(e.target.id)){
      saveImportDraft();const count=e.target.closest('label')?.querySelector('.focus-character-count');if(count)count.textContent=e.target.value.length+' / 12,000';
    }
    if(e.target.id==='focus-revised-instruction'){state.focus.importEdits[state.page.split('/')[2]]=e.target.value;persist();}
  });
  document.addEventListener('change',e=>{
    init();const id=e.target.id;
    if(['focus-import-parser','focus-import-image'].includes(id)){saveImportDraft();return;}
    if(['focus-file-input','focus-folder-input'].includes(id))return addFiles([...e.target.files].map(f=>({name:f.name,path:f.webkitRelativePath||f.name,bytes:f.size})));
    if(id==='focus-import-phase'){const job=state.imports.find(x=>x.id===state.page.split('/')[2]);if(job){job.phase=e.target.value;persist();render();}}
  });
  document.addEventListener('dragover',e=>{if(e.target.closest('#focus-dropzone'))e.preventDefault();});
  document.addEventListener('drop',e=>{if(!e.target.closest('#focus-dropzone'))return;e.preventDefault();addFiles([...e.dataTransfer.files].map(f=>({name:f.name,path:f.webkitRelativePath||f.name,bytes:f.size})));});
  const previousReset=resetPreviewData;
  resetPreviewData=function(value){state.focus={};return previousReset(value);};
  function refine(){
    init();document.body.classList.add('focus-ui');
    const main=document.querySelector('main');if(!main)return;
    if(state.page==='settings/models'&&state.focus.returnImport){
      main.insertAdjacentHTML('afterbegin','<aside class="notice"><div><strong>'+t('正在继续一项导入','Continuing an import')+'</strong><p>'+t('文件与说明已保留，配置后回到同一任务。','Files and context are retained. Return to the same task after configuration.')+'</p>'+act(t('返回这次导入','Return to this import'),'return-import','text')+'</div></aside>');
    }
    if(state.page.startsWith('material/')){
      const m=state.materials.find(x=>x.id===state.page.split('/')[1]),job=state.imports.find(x=>x.materialId===m?.id);
      if(job&&m?.instruction!=null){const body=main.querySelector('.reading-body');if(body)body.insertAdjacentHTML('afterend',disclosure('focus-material-import-context',t('本次导入说明','Import explanation'),importInstructions(job)+route(t('查看同一次导入','View this import'),'import/details/'+job.id,'text')));}
    }
    // Eliminate stale central-directory vocabulary from historical discovery entries.
    main.querySelectorAll('[data-id="A01"]').forEach(el=>{const title=el.querySelector('strong,h3');if(title)title.textContent=t('一次导入所选文件夹','Import a selected folder once');});
    main.querySelectorAll('details').forEach((d,i)=>{
      const key=state.page+'|'+(d.id||d.dataset.focusKey||('detail-'+i));
      d.dataset.focusKey=key;
      if(Object.hasOwn(state.focus.details,key))d.open=state.focus.details[key];
    });
    if(window.enhanceNativeSemantics)window.enhanceNativeSemantics();
  }
  document.addEventListener('toggle',e=>{const d=e.target;if(d.tagName!=='DETAILS'||!d.dataset.focusKey)return;init();state.focus.details[d.dataset.focusKey]=d.open;persist();},true);
  const previousRender=render;
  render=function(){init();previousRender();refine();};
  window.enhanceFocusUI=refine;
})();
