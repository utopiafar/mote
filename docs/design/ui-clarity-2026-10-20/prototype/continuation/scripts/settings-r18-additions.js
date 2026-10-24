// SETTINGS_R18_COMPLETION_START
const r18RetentionOptions=[['session','仅本次会话'],['7d','7 天'],['30d','30 天']];
const r18ImagePlans=[['default','跟随默认设置'],['archive','仅保存原件'],['local-ocr','本机 OCR（示例方案）']];
const r18AppSample={date:'2026-10-20',from:'09:00',to:'14:00',timezone:'Asia/Shanghai',device:'我的 Mac',platform:'Mac',rows:[{name:'编辑器',minutes:138},{name:'浏览器',minutes:66},{name:'笔记',minutes:32}],gaps:[{from:'09:45',to:'10:05',reason:'屏幕锁定'},{from:'11:20',to:'11:44',reason:'采集已暂停'},{from:'13:40',to:'14:00',reason:'设备未连接'}]};
function retentionLabel(value){return r18RetentionOptions.find(x=>x[0]===value)?.[1]||r18RetentionOptions[0][1];}
function importImagePlanLabel(value){return r18ImagePlans.find(x=>x[0]===value)?.[1]||r18ImagePlans[0][1];}
function importLocalDevice(){return state.surface==='android'?'Android':state.surface==='mac'?'Mac':'网页浏览器';}
function importOriginLabel(value){return value==='中央目录'?'中央目录':state.surface==='android'?'Android 本机文件':state.surface==='mac'?'Mac 本机文件':'本机文件（浏览器选择）';}
function currentImportImagePlan(){return state.imports.find(b=>b.id==='batch-current-'+state.importCounter)?.imageScheme||state.importImageScheme;}
function accountServiceSettings(){
 const chosen=state.accountRetentionDraft??state.accountRetention,dirty=chosen!==state.accountRetention;
 return '<section class="section card" aria-labelledby="account-service-heading"><h2 id="account-service-heading">当前服务与中央节点</h2><div class="grid two section"><div><h3>当前服务</h3><p><code data-user-content>'+esc(state.accountServiceUrl)+'</code></p></div><div><h3>中央节点</h3><p data-user-content>'+esc(state.accountNodeName)+'</p>'+tag('演示连接','purple')+'</div></div><p class="small muted">这里显示演示服务信息，不连接真实中央节点。</p></section>'+
 '<section class="section card" aria-labelledby="account-session-heading"><h2 id="account-session-heading">浏览器登录保留</h2><p>选择此浏览器的登录保留时间。</p><div class="fields section"><label class="field"><span>登录保留时间</span><select id="account-retention" class="field-input">'+r18RetentionOptions.map(([value,label])=>'<option value="'+value+'" '+(chosen===value?'selected':'')+'>'+label+'</option>').join('')+'</select></label><p class="small"><span>当前已保存</span> · <strong>'+retentionLabel(state.accountRetention)+'</strong></p><div class="form-actions">'+button('保存登录保留设置','save-account-retention','','primary')+'</div><p class="small muted">仅保存此原型中的选项，不创建或延长真实登录会话。</p>'+(dirty?'<p role="status" class="small">有未保存的登录保留修改。</p>':state.accountRetentionSaved?'<div class="notice good" role="status">登录保留设置已保存。重新打开仍显示此选项。</div>':'')+'</div></section>';
}
function importImageChoice(id,selected){return '<label class="field"><span>本次图片处理方案</span><select class="field-input" id="'+id+'">'+r18ImagePlans.map(([value,label])=>'<option value="'+value+'" '+(selected===value?'selected':'')+'>'+label+'</option>').join('')+'</select><small>只作用于这次导入中的图片，不改变全局图片设置。</small></label>';}
function importDetailsPage(){
 const b=state.imports.find(x=>x.id===state.page.split('/')[2]);
 if(!b)return heading('导入记录不在当前列表中','请返回上传与处理查看现有记录。',goButton('返回上传与处理','imports','primary'));
 const selected=state.importImageDrafts[b.id]??b.imageScheme??'default',dirty=selected!==(b.imageScheme||'default'),parser=b.parser||(b.kind==='audio'?'音频与转写':b.kind==='archive'?'文件夹与归档包':'自动识别'),save=b.saveMode||'保留原件和可阅读正文';
 return heading('导入详情','核对原文件与导入设置，单独管理本次图片处理方案。',goButton('返回上传与处理','imports','subtle'))+'<article class="reading" data-import-detail="'+b.id+'"><h2 data-user-content>'+esc(b.name)+'</h2><div class="grid two section"><div><h3>所选文件</h3><p data-user-content>'+esc(b.sourceFile||b.name)+'</p></div><div><h3>资料名称</h3><p data-user-content>'+esc(b.name)+'</p></div><div><h3>保存方式</h3><p>'+esc(save)+'</p></div><div><h3>解析方式</h3><p>'+esc(parser)+'</p></div><div><h3>来源设备</h3><p>'+esc(b.device||'工作台')+'</p></div></div><section class="section fields"><h3>图片处理方案</h3><p class="small"><span>当前已保存</span> · <strong>'+importImagePlanLabel(b.imageScheme||'default')+'</strong></p>'+importImageChoice('detail-image-scheme',selected)+'<div class="form-actions">'+button('保存本次图片方案','save-import-image-scheme','data-id="'+b.id+'"','primary')+'</div><p class="small muted">修改图片方案不会改变所选文件、资料名称、保存方式与解析器。</p>'+(dirty?'<p role="status" class="small">有未保存的图片方案修改。</p>':b.imageSchemeSaved?'<div class="notice good" role="status">本次图片方案已保存，其他导入与全局设置保持原样。</div>':'')+'</section><div class="actions section">'+(b.phase==='done'&&b.materialId?goButton('打开导入结果','material/'+b.materialId,'subtle'):b.phase==='review'?goButton('核对并继续','import/review/'+b.id,'subtle'):'')+'</div></article>';
}
function importedMaterialPlan(material){const b=state.imports.find(x=>x.materialId===material.id);return b?'<section class="evidence-box section"><h2>本次导入的图片方案</h2><p>'+importImagePlanLabel(b.imageScheme||'default')+'</p>'+goButton('查看导入详情与图片方案','import/details/'+b.id,'text')+'</section>':'';}
function r18MinutesBetween(from,to){const minutes=value=>{const [h,m]=value.split(':').map(Number);return h*60+m;};return minutes(to)-minutes(from);}
function r18Duration(minutes){const hours=Math.floor(minutes/60),rest=minutes%60;return hours?hours+'小时 '+rest+'分':minutes+'分';}
function applicationSamplingPage(){
 if(state.dataState==='empty')return heading('应用使用记录','回看所选设备上的应用与记录时段。')+'<div class="empty"><h2>还没有应用记录</h2><p>连接设备后，已采集时长、占比与采样范围会显示在这里。</p>'+goButton('连接设备','setup/device','primary')+'</div>';
 const sample=r18AppSample,total=sample.rows.reduce((sum,row)=>sum+row.minutes,0),windowMinutes=r18MinutesBetween(sample.from,sample.to),missing=sample.gaps.reduce((sum,gap)=>sum+r18MinutesBetween(gap.from,gap.to),0);
 return heading('应用使用记录','回看你使用过的前台应用，与 Mote 的后台工作分开查看。',goButton('Mote 后台工作','activity','subtle'))+'<section class="card" data-app-sample><h2>采样时间与设备</h2><div class="grid two section"><div><h3>采样时段</h3><p><time>'+sample.date+' '+sample.from+'–'+sample.to+'</time></p><p class="small muted">'+sample.timezone+'</p></div><div><h3>来源设备</h3><p data-user-content>'+esc(sample.device)+'</p><p class="small muted">'+sample.platform+'</p></div></div><div class="stat-row"><div class="stat"><strong>'+r18Duration(windowMinutes)+'</strong><span>采样窗口</span></div><div class="stat"><strong data-recorded-minutes="'+total+'">'+r18Duration(total)+'</strong><span>已采集应用时长</span></div><div class="stat"><strong data-missing-minutes="'+missing+'">'+r18Duration(missing)+'</strong><span>未采集时长</span></div></div></section><section class="card section"><h2>应用时长与占比</h2><p class="small muted">占比按各应用已采集时长除以全部应用已采集时长计算。</p>'+sample.rows.map(row=>{const percentage=total?row.minutes/total*100:0,label=state.language==='en'?translateUI(row.name)+': '+percentage.toFixed(2)+'% of recorded app time':row.name+'：'+percentage.toFixed(2)+'% 的已采集应用时长';return '<div class="task-row" data-app-minutes="'+row.minutes+'"><div class="task-main"><strong>'+row.name+'</strong><div class="progress" role="meter" aria-label="'+esc(label)+'" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+percentage.toFixed(2)+'"><span style="width:'+percentage+'%"></span></div></div><div><strong>'+percentage.toFixed(2)+'%</strong><p class="small muted">'+r18Duration(row.minutes)+'</p></div></div>';}).join('')+'<p class="small muted">未采集区间不作推算，也不计入占比分母。</p></section><section class="card section"><h2>未采集区间</h2><p class="small muted">以下区间没有前台应用采样，保留为空缺。</p>'+sample.gaps.map(gap=>'<div class="task-row"><div class="task-main"><strong>'+gap.from+'–'+gap.to+'</strong><p>'+gap.reason+'</p></div><span class="small muted">'+r18Duration(r18MinutesBetween(gap.from,gap.to))+'</span></div>').join('')+'</section>';
}
function settingsCompletionAction(action,el){
 const value=id=>document.getElementById(id)?.value||'';
 if(action==='save-account-retention'){const selected=value('account-retention');if(!r18RetentionOptions.some(x=>x[0]===selected))return true;state.accountRetention=selected;state.accountRetentionDraft=null;state.accountRetentionSaved=true;persist();notify('登录保留设置已保存（演示）。');return true;}
 if(action==='save-import-image-scheme'){const b=state.imports.find(x=>x.id===el.dataset.id);const selected=value('detail-image-scheme');if(!b||!r18ImagePlans.some(x=>x[0]===selected))return true;b.imageScheme=selected;b.imageSchemeSaved=true;delete state.importImageDrafts[b.id];persist();notify('本次图片方案已保存。文件、名称与解析器保持不变。');return true;}
 return false;
}
document.addEventListener('input',event=>{if(event.target.id==='import-name'){state.importName=event.target.value;persist();}});
document.addEventListener('change',event=>{
 const id=event.target.id,value=event.target.value;
 if(id==='account-retention'){state.accountRetentionDraft=value;state.toast='';persist();render();return;}
 if(id==='import-save')state.importSave=value;
 else if(id==='import-parser')state.importParser=value;
 else if(id==='import-image-scheme')state.importImageScheme=value;
 else if(id==='detail-image-scheme'){const batch=state.page.split('/')[2];if(batch)state.importImageDrafts[batch]=value;state.toast='';persist();render();return;}
 else return;
 persist();
});
// SETTINGS_R18_COMPLETION_END
