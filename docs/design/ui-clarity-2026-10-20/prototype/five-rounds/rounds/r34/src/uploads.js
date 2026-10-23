/* R34: browser-local upload queue, separate from retained Central imports. */
(function(){
  'use strict';
  const t=(zh,en)=>state.language==='en'?en:zh;
  const copy=x=>JSON.parse(JSON.stringify(x));
  const handles=new Set(); // File bytes are session-bound; metadata survives navigation/reload.
  const B=(label,action,kind='subtle',attrs='')=>button(label,'uq-'+action,attrs,kind);
  const G=(label,page,kind='text')=>goButton(label,page,kind);
  const labels={queued:['等待上传','Queued'],uploading:['正在上传','Uploading'],submitting:['正在提交 · 等待中央回执','Submitting · awaiting Central receipt'],throttled:['等待上传名额 · 获得名额后自动继续','Waiting for capacity · resumes when available'],paused:['上传已暂停','Paused'],failed:['上传失败 · 可以重试','Failed · retry available'],submitted:['中央已接收 · 等待核对','Central received · awaiting review']};
  const D=(id,title,body)=>'<details class="focus-disclosure" id="uq-'+id+'"><summary>'+title+'</summary><div class="focus-disclosure-body">'+body+'</div></details>';
  function init(){
    state.uq||={items:[],demoMode:'normal',migrated:false};
    if(!state.uq.migrated){
      for(const old of state.imports.filter(x=>['paused','uploading','throttled'].includes(x.phase))){
        const files=copy(old.files||[{name:old.name,path:old.sourceFile||old.name,bytes:0}]);
        state.uq.items.push({id:old.id,name:old.name,files,instruction:old.instruction||old.context||'',parser:old.parser||'default',image:old.imageScheme||'default',phase:old.phase,progress:0,synthetic:false,notice:t('已恢复队列信息，请重新选择同一批文件。','Queue metadata restored. Reselect the same files.')});
      }
      state.imports=state.imports.filter(x=>!['paused','uploading','throttled'].includes(x.phase));
      state.uq.migrated=true;
    }
    return state.uq;
  }
  function item(id){return init().items.find(x=>x.id===id);}
  function field(q){return 'data-id="'+esc(q.id)+'"';}
  function total(q){return q.files.reduce((n,f)=>n+Number(f.bytes||0),0);}
  function bytes(n){return Number(n).toLocaleString()+' B';}
  function received(q){return q.phase==='submitted';}
  function retained(q){return state.imports.some(x=>x.id===q.id);}
  function available(q){return received(q)||q.phase==='submitting'||handles.has(q.id);}
  function save(){persist();render();}
  function newItem(d,id){return{id:id||'upload-'+Date.now(),name:d.name||d.files[0].name,files:copy(d.files),instruction:d.instruction,parser:d.parser,image:d.image,phase:'queued',progress:0,synthetic:d.files.every(f=>!!f.outcome),notice:''};}
  window.focusEnqueueUpload=function(d){
    const a=init(),mode=a.demoMode;if(mode==='normal')return false;
    const id=state.focus.editImportId||undefined,q=newItem(d,id),old=item(q.id);
    q.phase=mode==='missing'?'paused':mode;q.progress=mode==='uploading'?.35:0;
    if(mode!=='missing')handles.add(q.id);
    if(old)Object.assign(old,q);else a.items.unshift(q);
    state.focus.editImportId='';a.demoMode='normal';persist();go('imports/queue');return true;
  };
  window.focusTrackSubmitted=function(job,d){
    const a=init(),old=item(job.id),q=newItem(d,job.id);q.phase='submitted';q.progress=1;
    if(old)Object.assign(old,q);else a.items.unshift(q);
  };
  function finish(q){
    let job=state.imports.find(x=>x.id===q.id);if(!job){job={id:q.id};state.imports.unshift(job);}
    Object.assign(job,{name:q.name,instruction:q.instruction,parser:q.parser,imageScheme:q.image,files:copy(q.files),phase:'review',sourceFile:q.files.map(f=>f.path).join('、'),device:importLocalDevice(),count:q.files.length,previewVersion:(job.previewVersion||0)+1});
    q.phase='submitted';q.progress=1;q.notice=t('中央接收回执已到达。下一步核对资料的理解方式。','Central receipt arrived. Review the interpretation next.');handles.delete(q.id);save();
  }
  function fileDetails(q){
    return q.files.map(f=>'<div class="uq-file"><strong>'+esc(f.path||f.name)+'</strong><small>'+(f.bytes?bytes(Math.round(f.bytes*q.progress))+' / '+bytes(f.bytes):t('文件大小待重新选择后确认','Size available after reselecting files'))+'</small></div>').join('')+'<h3>'+t('提交时的资料说明','Context supplied with this submission')+'</h3><p class="focus-pre" data-user-content>'+esc(q.instruction||t('未填写','Not supplied'))+'</p><p class="small">'+t('提交 ID：','Submission ID: ')+esc(q.id)+'</p>';
  }
  function row(q){
    const missing=!available(q),n=total(q),done=received(q),job=state.imports.find(x=>x.id===q.id);
    let next='';
    if(done)next=retained(q)?G(t(job?.phase==='review'?'核对已接收资料':'查看已接收资料',job?.phase==='review'?'Review received materials':'Open received materials'),(job?.phase==='review'?'import/review/':'import/details/')+q.id,'primary'):'<p>'+t('导入记录已被单独删除；本地队列不再提供归档链接。','The import was separately deleted; no archive link remains in this queue.')+'</p>';
    else if(missing)next=B(t('重新选择文件','Reselect files'),'reselect','primary',field(q));
    else if(['paused','failed'].includes(q.phase))next=B(t(q.phase==='failed'?'重试同一提交':'继续上传',q.phase==='failed'?'Retry same submission':'Continue upload'),'continue','primary',field(q));
    else if(['uploading','queued','throttled'].includes(q.phase))next=B(t('暂停上传','Pause upload'),'pause','subtle',field(q));
    else if(q.phase==='submitting')next='<p class="uq-note">'+t('正在等待这次提交的回执，请勿重复提交。','Waiting for this submission’s receipt; do not submit it twice.')+'</p>';
    const demo=done?'':D('states-'+q.id,t('预览上传回执','Preview upload receipts'),'<p class="uq-note">'+t('以下只模拟界面状态，不上传真实文件。','These controls simulate UI states without uploading files.')+'</p><div class="uq-controls">'+B(t('收到下一段回执','Receive next receipt'),'advance','text',field(q)+(missing?' disabled':''))+B(t('模拟上传失败','Simulate failure'),'fail','text',field(q))+B(t('模拟名额不足','Simulate no capacity'),'throttle','text',field(q))+B(t('模拟文件已失效','Simulate lost files'),'lose','text',field(q))+'</div>');
    return '<section class="uq-item" data-phase="'+q.phase+'" data-queue-id="'+esc(q.id)+'"><div class="uq-item-head"><div><h2 data-user-content>'+esc(q.name)+'</h2><p>'+(done&&job?.phase==='done'?t('中央已接收 · 记录已保存','Central received · records saved'):t(...labels[q.phase]))+'</p></div><span>'+q.files.length+t(' 个文件',' files')+'</span></div>'+
      '<progress max="1" value="'+q.progress+'" aria-label="'+esc(q.name)+' '+t('上传进度','upload progress')+'"></progress><p class="uq-note">'+(n?bytes(Math.round(n*q.progress))+' / '+bytes(n)+' · '+Math.round(q.progress*100)+'%':t('文件大小尚未恢复','File sizes have not been restored'))+'</p>'+
      (missing?'<p class="notice warn" role="status">'+t('本机文件已不可用。说明和提交 ID 已保留，重新选择同一批文件后继续。','Local files are unavailable. Context and submission ID remain; reselect the same files to continue.')+'</p>':'')+
      (q.notice&&(!done||job?.phase==='review')?'<p class="uq-note" role="status">'+esc(q.notice)+'</p>':'')+'<div class="actions">'+next+'</div>'+D('details-'+q.id,t('文件、资料说明与更多操作','Files, context and more actions'),fileDetails(q)+(q.phase==='submitting'?'<p class="uq-note">'+t('等待提交回执后可移除本地队列项。','Wait for the receipt before removing the local entry.')+'</p>':B(t('移除本地队列项','Remove local queue item'),'remove','text',field(q))))+demo+'</section>';
  }
  function queuePage(){const a=init();return heading(t('本地上传队列','Local upload queue'),t('继续本机待上传的文件。接收完成后，再核对解析结果。','Continue local uploads, then review the interpretation after reception.'),G(t('返回导入记录','Back to import history'),'imports'))+'<article class="reading focus-task">'+(a.items.length?a.items.map(row).join(''):'<div class="uq-empty"><h2>'+t('没有待上传的文件','No queued files')+'</h2>'+G(t('选择资料','Choose materials'),'import','primary')+'</div>')+'</article><p class="reading uq-note">'+t('文件正文依赖当前浏览器会话；刷新或关闭后可能需要重新选择。队列中保留文件信息和资料说明。移除队列项不会删除中央已归档的原件。','File bytes depend on this browser session; reloading or closing may require reselecting them. File metadata and context remain. Removing a queue item does not delete originals already archived in Central.')+'</p>';}
  const priorImports=importsPage;
  importsPage=function(){init();if(state.page==='imports/queue')return queuePage();const pending=init().items.filter(q=>!received(q)).length;return priorImports().replace('<section class="focus-task"','<p class="focus-task-foot">'+G(t('本地上传队列','Local upload queue')+(pending?' · '+pending+t(' 项待继续',' pending'):''),'imports/queue')+'</p><section class="focus-task"');};
  const priorImport=importPage;
  importPage=function(){init();const html=priorImport();if(state.page!=='import')return html;const a=init();return html.replace('<div class="focus-submit">',D('conditions',t('预览上传恢复状态','Preview upload recovery states'),'<p class="uq-note">'+t('仅用于检查原型。默认直接展示合成接收回执。','Prototype checks only. The default shows a synthetic receipt immediately.')+'</p><label class="field"><span>'+t('提交后的演示状态','Demo state after submitting')+'</span><select id="uq-demo-mode" class="field-input">'+[['normal','正常接收','Normal receipt'],['queued','排队等待','Queued'],['uploading','上传中','Uploading'],['throttled','名额不足','Throttled'],['failed','上传失败','Failed'],['missing','需要重新选择文件','Files unavailable']].map(([id,zh,en])=>'<option value="'+id+'" '+(a.demoMode===id?'selected':'')+'>'+t(zh,en)+'</option>').join('')+'</select></label>')+'<div class="focus-submit">');};
  const priorReset=resetPreviewData;
  resetPreviewData=function(value){state.uq=null;state.ax=null;handles.clear();return priorReset(value);};
  document.addEventListener('change',e=>{
    if(e.target.id==='uq-demo-mode'){init().demoMode=e.target.value;persist();return;}
    if(e.target.id!=='uq-reselect-input')return;
    const q=item(e.target.dataset.id);if(!q)return;const chosen=[...e.target.files];
    const match=chosen.length===q.files.length&&q.files.every(f=>chosen.some(g=>(g.webkitRelativePath||g.name)===(f.path||f.name)&&(!f.bytes||g.size===f.bytes)));
    if(!match){document.getElementById('uq-reselect-error').textContent=t('文件名称、路径或大小与这次提交不一致。请重新选择原文件；原说明和提交 ID 已保留。','Names, paths or sizes differ. Reselect the originals; context and submission ID remain.');return;}
    q.files.forEach(f=>{f.bytes=chosen.find(g=>(g.webkitRelativePath||g.name)===(f.path||f.name)).size;});handles.add(q.id);q.phase='paused';q.notice=t('原文件已重新选择，可以继续同一提交。','Original files reselected. Continue the same submission.');state.modal='';save();
  });
  document.addEventListener('click',e=>{
    const el=e.target.closest('[data-action^="uq-"]');if(!el||el.disabled)return;e.preventDefault();e.stopImmediatePropagation();
    const action=el.dataset.action.slice(3),q=item(el.dataset.id);if(!q)return;
    if(action==='reselect')return showInfo(t('重新选择这批文件','Reselect these files'),q.name,'<p>'+t('文件名称、相对路径和大小应与原提交一致。资料说明保持原样。','Names, relative paths and sizes must match the original submission. Context stays unchanged.')+'</p>'+fileDetails(q)+'<label class="field"><span>'+t(q.files.some(f=>(f.path||f.name).includes('/'))?'选择原文件夹':'选择原文件',q.files.some(f=>(f.path||f.name).includes('/'))?'Choose the original folder':'Choose original files')+'</span><input type="file" multiple '+(q.files.some(f=>(f.path||f.name).includes('/'))?'webkitdirectory':'')+' id="uq-reselect-input" data-id="'+esc(q.id)+'"></label><p role="alert" id="uq-reselect-error"></p>'+(q.synthetic?B(t('重新使用同一批示例文件','Reselect the same synthetic files'),'sample-reselect','subtle',field(q)):'')+button(t('稍后处理','Later'),'close-modal','','text'));
    if(action==='sample-reselect'){handles.add(q.id);q.phase='paused';q.notice=t('同一批示例文件已就绪，说明保持原样。','The same synthetic files are ready; context is unchanged.');state.modal='';return save();}
    if(action==='remove')return showInfo(t('移除本地队列项？','Remove the local queue item?'),q.name,'<p>'+t('只移除本机的队列信息。已经接收的中央原件、导入记录和资料不会删除。','Only this local queue entry is removed. Received Central originals, imports and material are retained.')+'</p><div class="actions">'+B(t('确认移除本地项','Remove local item'),'confirm-remove','danger',field(q))+button(t('取消','Cancel'),'close-modal','','text')+'</div>');
    if(action==='confirm-remove'){init().items=init().items.filter(x=>x.id!==q.id);handles.delete(q.id);state.modal='';return save();}
    q.notice='';
    if(action==='lose'){handles.delete(q.id);q.phase='paused';return save();}
    if(action==='pause'){q.phase='paused';return save();}
    if(action==='fail'){q.phase='failed';q.notice=t('合成回执：传输中断。重试沿用同一提交 ID。','Synthetic receipt: transfer interrupted. Retry uses the same submission ID.');return save();}
    if(action==='throttle'){q.phase='throttled';return save();}
    if(!available(q)){q.notice=t('请先重新选择文件。','Reselect files first.');return save();}
    if(action==='continue'){q.phase='uploading';return save();}
    if(action==='advance'){if(q.phase==='submitting')return finish(q);if(q.phase==='uploading'){q.progress=1;q.phase='submitting';}else q.phase='uploading';return save();}
  },true);
})();
