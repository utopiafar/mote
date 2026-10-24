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
  const sampleFiles=[{name:'读书笔记.md',path:'读书笔记.md',bytes:2400,outcome:'parsed'},{name:'会议记录.txt',path:'项目/会议记录.txt',bytes:3600,outcome:'parsed'},{name:'访谈录音.wav',path:'录音/访谈录音.wav',bytes:43000,outcome:'processing'},{name:'资料归档.zip',path:'资料归档.zip',bytes:18400,outcome:'container',children:['归档/研究方法.md','归档/阅读记录.md']}];
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
  const outcomes={parsed:['已解析','Parsed'],processing:['处理中','Processing'],attachment:['作为附件保留','Retained as attachment'],container:['归档容器','Archive container'],excluded:['已排除','Excluded'],unsupported:['格式未支持','Unsupported format']};
  function outcomeOf(file,job){
    if(job.phase==='unsupported')return 'unsupported';
    if(job.imageScheme==='archive'&&/\.(png|jpe?g|webp)$/i.test(file.name))return 'attachment';
    return file.outcome||(/\.(zip)$/i.test(file.name)?'container':/\.(wav|mp3|m4a)$/i.test(file.name)?'processing':'parsed');
  }
  function recordCount(job){return filesOf(job).reduce((n,f)=>n+(outcomeOf(f,job)==='parsed'?1:outcomeOf(f,job)==='container'?(f.children?.length||0):0),0);}
  function dirtyExplanation(job){return state.focus.importEdits[job.id]!=null&&state.focus.importEdits[job.id]!== (job.instruction??job.context??'');}
  function confirmationGate(){
    const job=state.imports.find(x=>x.id===state.page.split('/')[2]);if(!job)return;
    const button=document.querySelector('[data-action="focus-confirm-import"]');if(!button)return;
    const dirty=dirtyExplanation(job);button.disabled=dirty;
    const old=document.getElementById('focus-preview-stale');
    if(dirty&&!old)button.closest('.focus-submit').insertAdjacentHTML('beforebegin','<p class="notice warn" role="status" id="focus-preview-stale">'+t('说明已修改，请先重新生成预览，再确认保存。','The explanation changed. Regenerate the preview before confirming.')+'</p>');
    if(!dirty&&old)old.remove();
    if(dirty)button.setAttribute('aria-describedby','focus-preview-stale');else button.removeAttribute('aria-describedby');
  }
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
    (editable?disclosure('focus-revise-'+job.id,t('补充说明，重新理解资料','Revise context and regenerate preview'),instructionField('focus-revised-instruction',state.focus.importEdits[job.id]??saved)+'<div class="actions">'+act(t('重新生成预览','Regenerate preview'),'reprepare-import','primary','data-id="'+job.id+'"')+act(t('放弃本次说明修改','Discard explanation changes'),'discard-import-explanation','text','data-id="'+job.id+'"')+'</div>',''):'' );
  }
  function importReview(job){
    return heading(t('核对资料的理解方式','Review the interpretation'),job.name,route(t('返回导入记录','Back to import history'),'imports','text'))+
    '<article class="reading focus-task" data-import-detail="'+job.id+'"><p class="focus-status">'+tag(t('原件已归档','Originals archived'),'green')+'<span>'+t('记录尚未保存','Records are not published yet')+'</span></p>'+
    '<section class="focus-zone"><h2>'+t('这次将保存什么','What will be saved')+'</h2><p>'+t('需要确认：示例资料含有引用与多位说话人，请核对范围后再保存。','Review needed: the sample contains quotations and several speakers. Check the scope before saving.')+'</p>'+
    '<div class="focus-preview"><span class="eyebrow">'+t('解析预览 · 演示内容','PREVIEW · SYNTHETIC CONTENT')+'</span><h3 data-user-content>'+esc(job.name)+'</h3><div class="focus-speaker-preview" aria-label="'+t('引用角色预览','Quotation role preview')+'"><p><span>'+t('我','Me')+'</span>'+t('先核对资料来源，再继续整理。','Check the sources before organizing the material.')+'</p><p><span>'+t('供应商 · 引用','Vendor · quotation')+'</span>'+t('“我们建议下周交付。”','“We suggest delivery next week.”')+'</p><p><span>AI · '+t('引用','quotation')+'</span>'+t('“可以先列出待核对的问题。”','“You could list questions to verify first.”')+'</p></div><p class="small muted">'+t('来源限定观察：这份资料记录了交付建议；供应商和 AI 的话不记作你的承诺。固定合成预览，不执行真实模型解析。','Source-scoped observation: this material records a delivery suggestion; vendor and AI speech are not your commitments. Fixed synthetic preview, with no live model parsing.')+'</p></div>'+
    '<p class="small">'+t('预计可读记录：','Expected readable records: ')+recordCount(job)+t(' · 其他文件的处理状态逐项保留 · 请核对引用归属',' · Other file outcomes are retained individually · review quotation ownership')+'</p></section>'+
    '<section class="focus-zone">'+importInstructions(job,true)+'</section>'+
    disclosure('focus-review-options',t('核对文件与处理方式','Review files and processing'),fileList(filesOf(job))+'<dl class="focus-dl"><div><dt>'+t('解析方式','Parser')+'</dt><dd>'+esc(parserLabel(job.parser))+'</dd></div><div><dt>'+t('图片处理','Images')+'</dt><dd>'+esc(imageLabel(job.imageScheme))+'</dd></div></dl>'+act(t('修改文件或选项','Edit files or options'),'edit-import','text','data-id="'+job.id+'"'))+
    (job.confirmError?'<p role="alert" class="form-error">'+esc(job.confirmError)+'</p>':'')+
    (dirtyExplanation(job)?'<p class="notice warn" role="status" id="focus-preview-stale">'+t('说明已修改，请先重新生成预览，再确认保存。','The explanation changed. Regenerate the preview before confirming.')+'</p>':'')+
    '<div class="focus-submit">'+act(t('确认并保存记录','Confirm and save records'),'confirm-import','primary','data-id="'+job.id+'" '+(dirtyExplanation(job)?'disabled aria-describedby="focus-preview-stale"':''))+route(t('稍后确认','Review later'),'imports','text')+'</div></article>';
  }
  function importDetail(job){
    const active=['queued','preparing','importing','uploading','throttled','stopping'].includes(job.phase);
    const canRevise=['review','failed','unsupported','needs_configuration','cancelled'].includes(job.phase);
    const files=filesOf(job);
    let next='';
    if(job.phase==='done')next=job.materialId?route(t('阅读导入结果','Read imported material'),'material/'+job.materialId,'primary'):'<p>'+t('原件已保留，暂无可读记录。请查看每个文件的处理原因。','Originals retained; no readable record yet. Inspect each file’s processing reason.')+'</p>';
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
    disclosure('focus-import-files',t('原件与文件解析情况','Originals and file outcomes'),files.map((f,i)=>{
      const outcome=outcomeOf(f,job),l=outcomes[outcome];
      const reason={parsed:t('正文已提取；确认后可阅读。','Text extracted; readable after confirmation.'),processing:t('原件已收到，转写或识别仍在等待。','Original received; transcription or recognition is pending.'),container:t('ZIP 作为容器保留，子文件分别生成记录。','ZIP is retained as a container; child files become separate records.'),attachment:t('原件作为附件保留，不计为独立可读记录。','Original retained as an attachment, not a standalone readable record.'),excluded:t('按本次范围排除，不计入已完成记录。','Excluded by the selected scope; not counted as a completed record.'),unsupported:t('格式暂未支持，原件保留供重试或下载。','Format unsupported; original retained for retry or download.')}[outcome];
      return '<div class="focus-file-outcome"><strong data-user-content>'+esc(f.path)+'</strong><span>'+Number(f.bytes||0).toLocaleString()+' B · '+t(l[0],l[1])+'</span><p>'+reason+'</p>'+(f.children?'<ul>'+f.children.map(p=>'<li data-user-content>'+esc(p)+'</li>').join('')+'</ul>':'')+act(t('查看原件','View original'),'import-original','text','data-id="'+job.id+'" data-file="'+esc(f.name)+'"')+'</div>';
    }).join('')+'<p class="small">'+t('已生成记录：','Published records: ')+(job.recordIds?.length||0)+t(' · 重复：0 · 容器与未完成文件不冒充记录',' · Duplicates: 0 · Containers and unfinished files are not counted as records')+'</p>')+
    (job.recordIds?.length?disclosure('focus-import-records',t('这次导入的记录','Records from this import'),job.recordIds.map(mid=>route(esc(state.materials.find(m=>m.id===mid)?.title||mid),'material/'+mid,'text')).join('')):'')+
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
    if(dirtyExplanation(job))return notify(t('请先根据新说明重新生成预览。草稿已保留。','Regenerate the preview using your revised explanation. Your draft is retained.'));
    const rows=filesOf(job).flatMap(f=>outcomeOf(f,job)==='parsed'?[{name:f.name,path:f.path}]:outcomeOf(f,job)==='container'?(f.children||[]).map(path=>({name:path.split('/').pop(),path})):[]);
    job.phase='done';job.recordIds=[];
    rows.forEach((f,i)=>{
      const id='focus-material-'+job.id+'-'+i;job.recordIds.push(id);
      const material={id,title:rows.length===1?job.name:f.name,type:'file',source:'文件导入',date:'刚刚',device:importLocalDevice(),origin:f.path,preview:'导入资料已保存，说明与原件可核对。',body:'我：先核对资料来源，再继续整理。\n供应商（引用）：“我们建议下周交付。”\nAI（引用）：“可以先列出待核对的问题。”\n来源限定观察：这份资料记录了交付建议；供应商和 AI 的话不是我的承诺。\n这是用于评审界面的固定合成资料，不执行真实模型理解。',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),saved:new Date().toISOString().slice(0,10),instruction:job.instruction,importId:job.id};
      const at=state.materials.findIndex(m=>m.id===id);if(at<0)state.materials.unshift(material);else state.materials[at]=material;
    });
    job.materialId=job.recordIds[0]||'';
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
    if(action==='discard-import-explanation'&&job){delete state.focus.importEdits[job.id];persist();return render();}
    if(action==='confirm-import'&&job)return commitImport(job);
    if(action==='cancel-import'&&job){job.phase='cancelled';persist();return render();}
    if(action==='delete-import'&&job)return showInfo(t('删除这次导入？','Delete this import?'),job.name,
      '<p>'+t('会删除本次独占的原件、记录和依赖记忆；仍被其他任务引用的共享内容保留。外部原文件不受影响。','This removes originals, records and dependent memories used only by this import. Shared content referenced elsewhere and external original files remain.')+'</p><div class="actions section">'+act(t('确认删除这次导入','Confirm deletion'),'confirm-delete-import','danger','data-id="'+job.id+'"')+button(t('取消','Cancel'),'close-modal','','subtle')+'</div>');
    if(action==='confirm-delete-import'&&job){state.imports=state.imports.filter(x=>x.id!==job.id);const ids=new Set(job.recordIds||[job.materialId]);const shared=new Set(state.imports.flatMap(x=>x.recordIds||[x.materialId]));state.materials=state.materials.filter(x=>!ids.has(x.id)||shared.has(x.id));state.modal='';persist();return go('imports');}
    if(action==='import-original'&&job)return showInfo(t('已保留的原件','Retained original'),el.dataset.file,'<p data-user-content>'+esc(filesOf(job).find(f=>f.name===el.dataset.file)?.path||el.dataset.file)+'</p><p>'+t('合成文件预览。生产界面在这里打开或下载同一原件。','Synthetic file preview. The production UI opens or downloads this exact original here.')+'</p>'+importInstructions(job));
    if(action==='import-model'&&job){state.focus.returnImport=job.id;return go('settings/models');}
    if(action==='return-import'){const target=state.focus.returnImport,job=state.imports.find(x=>x.id===target);if(job&&state.cs?.assignments?.import&&state.cs.assignments.import!=='未分配')job.phase='review';state.focus.returnImport='';persist();return go('import/details/'+target);}
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
    if(e.target.id==='focus-revised-instruction'){state.focus.importEdits[state.page.split('/')[2]]=e.target.value;persist();confirmationGate();}
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
      const m=state.materials.find(x=>x.id===state.page.split('/')[1]),job=state.imports.find(x=>x.id===m?.importId||x.materialId===m?.id);
      if(job&&m?.instruction!=null){const body=main.querySelector('.reading-body');if(body)body.insertAdjacentHTML('afterend',disclosure('focus-material-import-context',t('本次导入说明','Import explanation'),importInstructions(job)+route(t('查看同一次导入','View this import'),'import/details/'+job.id,'text')));}
    }
    // Eliminate stale central-directory vocabulary from historical discovery entries.
    main.querySelectorAll('[data-id="A01"]').forEach(el=>{const title=el.querySelector('strong,h3');if(title)title.textContent=t('一次导入所选文件夹','Import a selected folder once');});
    if(window.enhanceNativeSemantics)window.enhanceNativeSemantics();
    if(window.enhanceCentralSemantics)window.enhanceCentralSemantics();
    if(window.enhanceContextAndSources)window.enhanceContextAndSources();
    main.querySelectorAll('details').forEach((d,i)=>{
      const key=state.page+'|'+(d.id||('detail-'+i));
      d.dataset.focusKey=key;
      if(Object.hasOwn(state.focus.details,key))d.open=state.focus.details[key];
    });
  }
  document.addEventListener('toggle',e=>{const d=e.target;if(d.tagName!=='DETAILS'||!d.dataset.focusKey)return;init();state.focus.details[d.dataset.focusKey]=d.open;persist();},true);
  const previousRender=render;
  render=function(){init();previousRender();refine();};
  window.enhanceFocusUI=refine;
})();

/* R31: source prose, attribution and focused discovery. Separate from format parsing. */
(() => {
  const t=(zh,en)=>state.language==='en'?en:zh;
  const b=(label,action,kind='subtle',attrs='')=>button(label,'cx-'+action,attrs,kind);
  const r=(label,page,kind='text')=>goButton(label,page,kind);
  const labels={'':['不声明','No declaration'],owner:['我的表达或经历','My expression or experience'],third_party:['第三方内容','Third-party content'],mixed:['混合内容','Mixed content'],unknown:['归属未知','Unknown attribution'],inherit:['跟随来源','Follow source']};
  const label=v=>t(...(labels[v]||labels.unknown));
  function ensure(){state.focus=state.focus||{};for(const key of ['sourceVersions','sourceConflicts','sourceExpected','attributionDrafts','attributionSaved','newDescriptions'])state.focus[key]=state.focus[key]||{};}
  function contextPanel(id){
    ensure();const saved=savedSourceContext(id),draft=sourceContextDraft(id),dirty=sourceContextDirty(id),version=state.focus.sourceVersions[id]||1,conflict=state.focus.sourceConflicts[id];
    return '<section class="card section focus-context-panel" data-source-context-id="'+esc(id)+'"><h2>'+t('资料说明与归属','Source context and attribution')+'</h2>'+
    '<p class="small muted">'+t('用于理解这个来源已有和未来的资料。修改不会自动重转写或重算历史记忆。','Used to understand existing and future material from this source. Changes do not automatically retranscribe or rebuild past memories.')+'</p>'+
    '<div class="focus-context-ack"><span>'+t('中央已确认 · 版本 ','Central acknowledged · version ')+version+'</span><strong>'+label(saved.ownerRelation)+'</strong>'+(saved.contextDescription?'<p class="focus-pre" data-user-content>'+esc(saved.contextDescription)+'</p>':'<p>'+t('尚未填写说明','No description saved')+'</p>')+'</div>'+
    '<label class="field"><span>'+t('来源背景说明（选填）','Source description (optional)')+'</span><textarea class="field-input" id="source-context-description" maxlength="12000" rows="4" data-user-content placeholder="'+t('可说明格式、时间、作者、背景，以及哪些内容属于你。','Describe format, time, authors, background and what belongs to you.')+'">'+esc(draft.contextDescription)+'</textarea><small>'+t('最多 12,000 字符。单份资料的声明优先于来源声明。','Up to 12,000 characters. A material-specific declaration takes precedence.')+'</small></label>'+
    '<label class="field"><span>'+t('内容与你的关系','How the content relates to you')+'</span><select id="source-relation" class="field-input">'+sourceRelationOptions.map(([v])=>'<option value="'+v+'" '+(draft.ownerRelation===v?'selected':'')+'>'+label(v)+'</option>').join('')+'</select><small>'+t('不声明或归属未知也可以阅读、检索和整理。','Unspecified or unknown attribution does not block reading, search or organization.')+'</small></label>'+
    (conflict?'<div class="notice warn" role="alert"><div><strong>'+t('资料说明已有新版本，草稿已保留','The description changed; your draft is retained')+'</strong><p>'+t('中央版本 ','Central version ')+conflict.version+'</p><p class="focus-pre" data-user-content>'+esc(conflict.description)+'</p><div class="actions">'+b(t('放弃修改并重新加载','Discard draft and reload'),'context-reload','subtle','data-id="'+id+'"')+(state.surface==='android'?b(t('保留本机说明并保存','Keep local description and save'),'context-keep-local','subtle','data-id="'+id+'"'):'')+'</div></div></div>':'')+
    '<p class="small" role="status" data-source-context-status>'+t(dirty?'有未保存修改，离开后可继续。':'当前内容已保存。',dirty?'Unsaved changes; you can leave and continue later.':'Current content is saved.')+'</p>'+
    '<div class="actions card-foot">'+button(t('保存资料说明与归属','Save context and attribution'),'save-source-context','data-id="'+id+'" '+(!dirty?'disabled':''),'primary')+button(t('放弃修改','Discard changes'),'discard-source-context','data-id="'+id+'" '+(!dirty?'disabled':''),'text')+'</div>'+
    '<details id="cx-context-demo-'+id+'" class="focus-disclosure demo-controls"><summary>'+t('预览说明版本冲突','Preview a description conflict')+'</summary><div class="focus-disclosure-body">'+b(t('模拟另一端更新了说明','Simulate an update from another device'),'context-conflict','subtle','data-id="'+id+'"')+'</div></details></section>';
  }
  sourceRelationshipFields=contextPanel;
  const oldSetup=setupPage;
  setupPage=function(){
    if(state.page.startsWith('setup/context/')){const id=state.page.split('/')[2];return heading(t('中央资料说明','Central source context'),t('描述资料的含义，不改变采集范围。','Describe what material means without changing collection scope.'),r(t('返回来源','Back to sources'),'sources'))+'<div class="reading focus-task">'+contextPanel(id)+'</div>';}
    return oldSetup();
  };
  const oldDo=doAction;
  doAction=function(action,el){
    ensure();
    if(action==='save-source-context'){
      const id=el.dataset.id;if(state.focus.sourceConflicts[id]){persist();render();return;}
      const draft=sourceContextDraft(id);if(draft.contextDescription.length>12000)return notify(t('资料说明最多 12,000 字符。','Description limit: 12,000 characters.'));
      state.focus.sourceVersions[id]=(state.focus.sourceVersions[id]||1)+1;
      return oldDo(action,el);
    }
    if(action==='save-source'&&state.surface==='android'&&el?.dataset.kind==='folder'){
      const text=document.getElementById('cx-new-source-description')?.value,before=new Set(state.sources.map(s=>s.id));const result=oldDo(action,el);
      if(text!=null){const source=state.sources.find(s=>!before.has(s.id))||state.sources.find(s=>s.id===el.dataset.id);if(source){state.sourceConfigs[source.id]={...(state.sourceConfigs[source.id]||{}),contextDescription:text};state.focus.sourceVersions[source.id]=1;delete state.focus.newDescriptions['setup/folder/new'];persist();render();}}
      return result;
    }
    return oldDo(action,el);
  };
  function attributionPanel(m){
    ensure();const saved=state.focus.attributionSaved[m.id]||m.ownerRelation||'inherit',draft=state.focus.attributionDrafts[m.id]??saved,source=savedSourceContext(m.sourceId||'').ownerRelation||'unknown',effective=saved==='inherit'?source:saved;
    return '<details class="focus-disclosure" id="cx-material-attribution"><summary><span>'+t('作者与内容归属','Authorship and attribution')+'</span><small>'+label(effective)+'</small></summary><div class="focus-disclosure-body"><p>'+t('当前生效：','Effective attribution: ')+'<strong>'+label(effective)+'</strong> · '+t(saved==='inherit'?'来自来源声明或默认值':'来自这份资料的单独修正',saved==='inherit'?'from source declaration or default':'from this material’s override')+'</p><label class="field"><span>'+t('修正这份资料的归属','Correct attribution for this material')+'</span><select id="cx-material-relation" class="field-input">'+['inherit','owner','third_party','mixed','unknown'].map(v=>'<option value="'+v+'" '+(draft===v?'selected':'')+'>'+label(v)+'</option>').join('')+'</select><small>'+t('单份资料修正优先于来源声明。第三方引文仍保留各自角色。','A material correction overrides the source declaration. Quotations keep their individual roles.')+'</small></label><div class="actions">'+b(t('保存归属修正','Save attribution correction'),'save-attribution','primary','data-id="'+m.id+'"')+b(t('放弃修改','Discard changes'),'discard-attribution','text','data-id="'+m.id+'"')+'</div></div></details>';
  }
  function sourceRow(s){
    const local=sourceKind(s.id)==='folder'||s.id==='screen',status=sourceStatus(s.id,s);
    return '<div class="focus-source-row" data-source-id="'+esc(s.id)+'"><span class="focus-source-symbol">'+icon(sourceKind(s.id)==='folder'?'folder':s.id==='screen'?'screen':'sources')+'</span><div><strong data-user-content>'+esc(s.title)+'</strong><p>'+esc(sourceSubtitle(s))+'</p><small>'+t('当前状态：','Status: ')+esc(state.language==='en'?translateUI(status):status)+'</small></div>'+r(t(local&&state.surface==='web'?'查看状态与资料':'管理',local&&state.surface==='web'?'View state and materials':'Manage'),sourceSetupRoute(s.id),'subtle')+'</div>';
  }
  sourcesPage=function(){
    const local=state.sources.filter(s=>sourceKind(s.id)==='folder'||s.id==='screen'),online=state.sources.filter(s=>!local.includes(s));
    return heading(t('来源','Sources'),t('管理内容从哪里来，采集范围在对应设备设置。','Manage where content comes from. Set collection scope on the relevant device.'),r(t('连接来源','Connect a source'),'catalog','primary'))+
    '<div class="focus-sources">'+
    (state.surface!=='web'?'<section class="focus-zone"><div class="section-head"><h2>'+t('这台 '+(state.surface==='mac'?'Mac':'Android'),'This '+(state.surface==='mac'?'Mac':'Android'))+'</h2>'+r(t('本机设置','Device settings'),'settings/native','text')+'</div>'+
      (local.length?local.map(sourceRow).join(''):'<div class="focus-source-row"><span class="focus-source-symbol">'+icon('screen')+'</span><div><strong>'+t('屏幕记录','Screen recording')+'</strong><p>'+t('只记录你选择的应用','Record only the apps you choose')+'</p></div>'+r(t('选择范围','Choose scope'),'setup/screen','subtle')+'</div><div class="focus-source-row"><span class="focus-source-symbol">'+icon('folder')+'</span><div><strong>'+t('文件夹同步','Folder sync')+'</strong><p>'+t('保留所选文件夹的后续变化','Keep later changes in a selected folder')+'</p></div>'+r(t('选择文件夹','Choose a folder'),'setup/folder/new','subtle')+'</div>')+
      (local.length?'<div class="actions section">'+r(t('再连接一个本机来源','Add another local source'),'catalog')+'</div>':'')+'</section>':
      '<section class="focus-zone"><div class="section-head"><h2>'+t('采集端上报的来源','Sources reported by collectors')+'</h2>'+r(t('设备连接','Device connections'),'devices')+'</div>'+(local.length?local.map(sourceRow).join(''):'<p class="muted">'+t('连接 Mac 或 Android 后，这里显示设备的来源和接收状态。','After connecting Mac or Android, device sources and received status appear here.')+'</p>'+r(t('连接采集端','Connect a collector'),'setup/device','subtle'))+'</section>')+
    '<section class="focus-zone"><h2>'+t('在线资料来源','Online sources')+'</h2>'+(online.length?online.map(sourceRow).join(''):'<p class="muted">'+t('按需连接文档、邮件、日历或录音。','Connect documents, email, calendars or recordings when needed.')+'</p>'+r(t('查看可连接的来源','Browse supported sources'),'catalog','subtle'))+'</section>'+
    '<div class="focus-source-tools">'+r(t('导入已有文件','Import existing files'),'import')+r(t('对外授权','Access for other assistants'),'access')+(state.surface!=='web'?r(t('设备连接','Device connection'),'devices'):'')+'</div></div>';
  };
  function catalogRow(title,description,page,ic='sources'){
    return '<button class="focus-list-row" data-action="go" data-page="'+page+'"><span class="focus-list-icon">'+icon(ic)+'</span><span><strong>'+title+'</strong><small>'+description+'</small></span>'+icon('arrow')+'</button>';
  }
  catalogPage=function(){
    const platform=state.surface==='mac'?'Mac':state.surface==='android'?'Android':t('采集端','a collector');
    return heading(t('连接资料来源','Connect a source'),t('选择内容来源，再确认范围。','Choose the source, then confirm its scope.'),r(t('返回来源','Back to sources'),'sources'))+
    '<div class="reading focus-task"><section class="focus-zone"><h2>'+t('手机与电脑','Phones and computers')+'</h2>'+
    catalogRow(t('文件夹同步','Folder sync'),t('由 '+platform+' 选择本机范围，持续同步变化','Choose a local scope on '+platform+' and sync later changes'),'setup/folder/new','folder')+
    catalogRow(t('屏幕与应用记录','Screen and app records'),t('由 Mac / Android 选择范围与系统权限','Choose scope and system permission on Mac / Android'),'setup/screen','screen')+
    catalogRow(t('Coding Agent 会话','Coding Agent conversations'),t('由 Mac 采集 Claude Code、Codex 与 Kimi 会话','Collected on Mac from Claude Code, Codex and Kimi'),'setup/coding','message-circle')+'</section>'+
    '<details class="focus-disclosure" id="cx-catalog-online" open><summary>'+t('文档、邮件与日历','Documents, email and calendars')+'</summary><div class="focus-disclosure-body">'+
    catalogRow(t('飞书文档与日历','Lark documents and calendars'),t('选择文档、文件夹和日历范围','Choose document, folder and calendar scopes'),'setup/lark')+
    catalogRow('Gmail',t('保存邮件正文、发件人和时间','Archive mail body, sender and time'),'setup/gmail','mail')+
    catalogRow('Google Calendar',t('只读归档所选日历','Read-only archive of selected calendars'),'setup/google','calendar')+'</div></details>'+
    '<details class="focus-disclosure" id="cx-catalog-recordings"><summary>'+t('录音与转写','Recordings and transcripts')+'</summary><div class="focus-disclosure-body">'+
    catalogRow(t('飞书录音','Lark recordings'),t('单独授权录音与音频归档','Separate authorization for recordings and audio'),'setup/feishu-recording','audio')+
    catalogRow(t('钉钉录音','DingTalk recordings'),t('导入已有录音与厂商转写','Import existing recordings and vendor transcripts'),'setup/dingtalk-recording','audio')+'</div></details>'+
    '<details class="focus-disclosure" id="cx-catalog-other"><summary>'+t('文件与其他资料服务','Files and other services')+'</summary><div class="focus-disclosure-body">'+
    catalogRow(t('一次导入资料','Import material once'),t('选择文件、文件夹或 ZIP，并补充说明','Choose files, a folder or ZIP and add context'),'import','upload')+
    catalogRow(t('MCP 资料服务','MCP resource service'),t('列出可读资源，选择后导入','List readable resources and import selected items'),'setup/mcp')+
    catalogRow(t('外部或 NAS 引用','External or NAS reference'),t('保留名称与位置，不自动读取正文','Keep the name and location without reading the body'),'setup/nas','folder')+'</div></details></div>';
  };
  newcomerWelcome=function(){
    return '<section class="welcome focus-welcome"><div class="welcome-lead"><div class="welcome-copy"><p class="welcome-eyebrow">'+t('Mote · 个人资料与记忆库','Mote · Your personal knowledge and memory library')+'</p><h1>'+t('把资料收好，<br>需要时有据可查。','Keep your material.<br>Find answers with evidence.')+'</h1><p class="welcome-description">'+t('保存文件、想法和设备记录。以后搜索或提问，沿着出处回到原文。','Save files, thoughts and device records. Search or ask later, then follow the evidence to the original.')+'</p><div class="welcome-actions">'+r(t('导入第一份资料','Import your first material'),'import','primary')+r(t('写随手记','Write a note'),'notes','subtle')+'</div><p class="welcome-hint">'+t('从一份资料开始，再按需连接更多来源。','Start with one material, then connect more sources when needed.')+'</p></div><article class="welcome-example"><div class="example-top"><span>'+t('以后可以这样问','ASK LATER')+'</span>'+icon('message-circle')+'</div><div class="example-query"><strong>'+t('“上次讨论决定了什么？”','“What did we decide last time?”')+'</strong><p>'+t('从自己的资料中找答案，点引用核对原文。','Find the answer in your materials and inspect the cited original.')+'</p></div>'+button(t('看一个使用例子','See an example'),'nu-example','','text')+'</article></div><div class="focus-welcome-more"><div><strong>'+t('让内容持续积累','Keep collecting useful context')+'</strong><p>'+t(state.surface==='web'?'Mac / Android 采集本机内容；中央负责接收与整理。':'在这台设备选择范围，保存后汇集到中央资料库。',state.surface==='web'?'Mac / Android collect local content; Central receives and organizes it.':'Choose the scope on this device and send saved content to your Central library.')+'</p></div>'+r(t('选择可连接的来源','Choose sources'),'catalog','subtle')+'</div><p class="focus-welcome-recall">'+t('资料保留原文；记忆整理长期信息；洞察用于阶段回顾。','Materials keep originals; memories organize lasting information; insights review a period of time.')+'</p></section>';
  };
  document.addEventListener('change',e=>{
    if(e.target.id==='cx-material-relation'){ensure();state.focus.attributionDrafts[state.page.split('/')[1]]=e.target.value;persist();}
  });
  document.addEventListener('input',e=>{
    if(e.target.id==='cx-new-source-description'){ensure();state.focus.newDescriptions[state.page]=e.target.value;persist();}
  });
  document.addEventListener('click',e=>{
    const el=e.target.closest('[data-action]');if(!el||!el.dataset.action.startsWith('cx-'))return;
    e.preventDefault();e.stopImmediatePropagation();ensure();const id=el.dataset.id,a=el.dataset.action;
    if(a==='cx-context-conflict'){state.focus.sourceConflicts[id]={version:(state.focus.sourceVersions[id]||1)+1,description:t('另一端保存的说明：访谈中的回答属于受访者，时间为 UTC+8。','Description saved on another device: interview answers belong to the interviewee; times use UTC+8.')};persist();return render();}
    if(a==='cx-context-reload'){const c=state.focus.sourceConflicts[id];if(c){state.sourceConfigs[id]={...(state.sourceConfigs[id]||{}),contextDescription:c.description};state.focus.sourceVersions[id]=c.version;delete state.sourceContextDrafts[id];delete state.focus.sourceConflicts[id];persist();render();}return;}
    if(a==='cx-context-keep-local'){const c=state.focus.sourceConflicts[id],d=sourceContextDraft(id);state.sourceConfigs[id]={...(state.sourceConfigs[id]||{}),...d};state.focus.sourceVersions[id]=(c?.version||state.focus.sourceVersions[id]||1)+1;delete state.sourceContextDrafts[id];delete state.focus.sourceConflicts[id];persist();return render();}
    if(a==='cx-save-attribution'){state.focus.attributionSaved[id]=state.focus.attributionDrafts[id] ?? state.focus.attributionSaved[id] ?? (state.materials.find(m=>m.id===id)?.ownerRelation || 'inherit');delete state.focus.attributionDrafts[id];persist();return render();}
    if(a==='cx-discard-attribution'){delete state.focus.attributionDrafts[id];persist();return render();}
  },true);
  window.enhanceContextAndSources=function(){
    ensure();const main=document.querySelector('main');if(!main)return;
    if(state.page==='sources'){
      main.querySelectorAll('.native-device-panel,.web-capture-context').forEach(el=>el.remove());
    }
    if(state.page==='setup/folder/new'&&state.surface==='android'&&!document.getElementById('cx-new-source-description')){
      const actions=main.querySelector('[data-action="save-source"]')?.closest('.form-actions');
      if(actions)actions.insertAdjacentHTML('beforebegin','<label class="field"><span>'+t('资料说明（选填）','Material description (optional)')+'</span><textarea id="cx-new-source-description" maxlength="12000" rows="4" data-user-content>'+esc(state.focus.newDescriptions[state.page]||'')+'</textarea><small>'+t('说明格式、时间、作者、背景与内容归属。中央确认后用于已有和未来资料。','Describe format, time, authors, background and ownership. Used for existing and future materials after Central acknowledgment.')+'</small></label>');
    }
    if(state.page.startsWith('material/')&&!main.querySelector('#cx-material-attribution')){
      const m=state.materials.find(x=>x.id===state.page.split('/')[1]),body=main.querySelector('.reading-body');
      if(m&&body)body.insertAdjacentHTML('afterend',attributionPanel(m));
    }
    if(state.page.startsWith('setup/folder')&&state.surface==='mac'){
      main.querySelectorAll('.native-context-disclosure').forEach(d=>{
        if(!d.querySelector('[data-source-context-id]'))return;
        const id=d.querySelector('[data-source-context-id]').dataset.sourceContextId;
        d.outerHTML='<section class="focus-task-foot">'+t('资料背景与归属在中央保存。','Background and attribution are saved in Central.')+' '+r(t('打开中央资料说明','Open Central source context'),'setup/context/'+id)+'</section>';
      });
    }
  };
})();
