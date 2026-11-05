import {describeCaptureSelection} from './app-capture-ui';
import {getLocale,moteText} from '@mote/shared/i18n';
import type {Status} from './contracts';
import type {BackupFileIdentity} from './contracts/operations';

type DiagnosticRead={scope:string;ticket:number;read:boolean};
const diagnosticReads=new WeakMap<HTMLElement,DiagnosticRead>();
const diagnosticScope=(status:Status)=>JSON.stringify([status.authorizationGeneration,status.config.deviceId,status.config.serverUrl,status.config.tokenConfigured,status.config.authSignedOut,status.config.authExpiresAt,status.config.authSourceBinding]);
function renderDiagnosticFacts(status:Status,root:Document):void {
 const currentFacts=root.getElementById('diagnostics-current-facts');if(!currentFacts)return;
 const scope=diagnosticScope(status);let state=diagnosticReads.get(currentFacts);
 if(!state){state={scope,ticket:0,read:false};diagnosticReads.set(currentFacts,state);}else if(state.scope!==scope){state.scope=scope;state.ticket++;state.read=false;}
 const diagnostics=status.diagnostics,sample=diagnostics?.latest;currentFacts.replaceChildren();currentFacts.hidden=!state.read||!sample;
 if(currentFacts.hidden||!sample||!diagnostics)return;
 const count=root.createElement('p');count.className='helper';count.textContent=diagnostics.enabled?moteText('诊断开启 · {0} 条数值样本',diagnostics.sampleCount):moteText('诊断关闭');
 const facts=root.createElement('dl');facts.className='maintenance-facts';
 const values=[[moteText('最近采样'),new Date(sample.at).toLocaleString(getLocale(),{hour12:false})],[moteText('本机诊断'),moteText('主进程 RSS {0} MiB · 累计 CPU {1} s',(sample.rssBytes/1048576).toFixed(1),((sample.cpuUserMicros+sample.cpuSystemMicros)/1000000).toFixed(1))]];
 for(const[label,text]of values){const term=root.createElement('dt'),value=root.createElement('dd');term.textContent=label;value.textContent=text;facts.append(term,value);}currentFacts.append(count,facts);
}
/** Called before the existing sample IPC; only its successful, current ACK may disclose facts. */
export function beginDiagnosticFactsRefresh(root:Document=document):(status:Status)=>void {
 const currentFacts=root.getElementById('diagnostics-current-facts'),state=currentFacts&&diagnosticReads.get(currentFacts);
 if(!currentFacts||!state)return()=>{};
 const ticket=++state.ticket,scope=state.scope;
 return status=>{if(diagnosticReads.get(currentFacts)!==state||state.ticket!==ticket||state.scope!==scope||diagnosticScope(status)!==scope||!status.diagnostics?.latest||status.diagnostics.error)return;state.read=true;renderDiagnosticFacts(status,root);};
}

/** Rearranges existing controls without copying their values or changing their owners. */
export function mountSettingsWorkspace(root:Document=document):void {
  const id=(name:string)=>root.getElementById(name)!;
  const element=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,className?:string)=>{const node=root.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;};
  const page=(name:string,title:string,form=false)=>{
    const node=element('section',undefined,'page settings-workspace'+(form?' settings-page':''));node.dataset.page=name;node.hidden=true;
    const header=element('header',undefined,'page-header'),heading=element('h1',title);heading.tabIndex=-1;heading.dataset.pageTitle='';header.append(heading);node.append(header);
    (form?id('settings-fields'):id('main-content')).append(node);return node;
  };
  const list=()=>element('div',undefined,'settings-menu');
  const row=(target:string,title:string,description?:string,summaryId?:string)=>{
    const button=element('button',undefined,'settings-row');button.type='button';button.dataset.nav=target;
    const copy=element('span',undefined,'settings-row-copy');copy.append(element('strong',title));if(description){const summary=element('span',description);if(summaryId)summary.id=summaryId;copy.append(summary);}button.append(copy,element('span','›','chevron'));return button;
  };
  const heading=(text:string)=>element('h2',text,'settings-group-label');
  const landing=root.querySelector<HTMLElement>('[data-page="settings"]')!;
  const preferences=page('preferences',moteText('外观与语言'));
  const appearance=id('appearance').closest('label')!,language=id('language').closest('label')!;preferences.append(appearance,language);
  const preferenceActions=element('div',undefined,'actions spaced');
  const apply=element('button',moteText('应用偏好'),'primary');apply.id='preferences-apply';apply.type='button';
  const reset=element('button',moteText('还原修改'),'secondary');reset.id='preferences-reset';reset.type='button';preferenceActions.append(apply,reset);preferences.append(preferenceActions);
  const runtime=element('details',undefined,'disclosure spaced');runtime.append(element('summary',moteText('运行环境')),id('environment'));const credentials=element('p',undefined,'helper');credentials.id='preferences-credentials';runtime.append(credentials);preferences.append(runtime);
  const guide=id('home-feature-guide').closest('.home-feature-guide')!,feedback=id('open-feedback');
  const direct=list();direct.append(row('capture-sync',moteText('采集与同步')),row('permissions',moteText('系统权限'),moteText('辅助功能、屏幕录制')),row('connection',moteText('连接与存储'),moteText('中央、连接邀请与设备名称'),'settings-connection-summary'));
  const central=list(),centralButton=row('',moteText('模型与服务、自动处理'),moteText('在中央工作台配置'));delete centralButton.dataset.nav;centralButton.id='settings-central-models';centralButton.lastElementChild!.textContent='↗';central.append(centralButton);
  landing.replaceChildren(element('header',undefined,'page-header'));const h1=element('h1',moteText('设置'));h1.tabIndex=-1;h1.dataset.pageTitle='';landing.firstElementChild!.append(h1);landing.append(element('p',moteText('这台 Mac'),'page-subtitle'),direct,heading(moteText('中央设置')),central,heading(moteText('此 Mac')),row('mac-options',moteText('偏好与本机维护'),moteText('外观、采集高级设置、诊断与更新')),guide);
  const options=page('mac-options',moteText('此 Mac 设置')),optionsList=list();optionsList.append(row('preferences',moteText('外观与语言'),moteText('此设备偏好')),row('capture',moteText('采集高级设置'),moteText('频率、电源、画质与本机队列')),row('chrome',moteText('Chrome 页面采集'),moteText('扩展与本机桥接')),row('developer',moteText('帮助与诊断'),moteText('本机日志与安全支持包')),row('about',moteText('关于 Mote'),moteText('版本与更新')),row('activity',moteText('本机统计')),row('statistics',moteText('本机状态详情')));options.append(optionsList);
  const about=root.querySelector('[data-page="about"]')!;about.classList.add('maintenance-about');about.querySelector('.about-brand')!.remove();
  const identity=element('dl',undefined,'maintenance-facts');for(const [label,key] of [[moteText('客户端'),'about-client'],[moteText('当前版本'),'about-version'],[moteText('运行环境'),'about-runtime']]){const value=element('dd');value.id=key;identity.append(element('dt',label),value);}about.insertBefore(identity,id('app-updates'));
  const updates=id('app-updates');updates.querySelector('.section-title h2')!.id='about-update-heading';updates.querySelector('.section-title p')!.remove();const channel=id('update-channel').closest('label')!;updates.insertBefore(channel,updates.querySelector('.form-grid'));updates.querySelector('.form-grid')!.replaceWith(id('update-version'),id('update-message'));id('update-version').classList.add('visually-hidden');
  id('update-reveal').className='secondary';id('update-install').before(id('update-reveal'));const installDetails=updates.querySelector('details')!;const closeNote=about.querySelector('.page-footnote')!;installDetails.append(closeNote);
  feedback.textContent='GitHub · '+moteText('反馈')+' ↗';const feedbackGroup=element('section',undefined,'about-feedback');feedbackGroup.append(element('h2',moteText('反馈')),feedback);about.append(feedbackGroup);

  const connection=root.querySelector<HTMLElement>('[data-page="connection"]')!;connection.querySelector('[data-page-title]')!.textContent=moteText('连接与存储');
  const summary=element('section',undefined,'panel connection-storage-summary');summary.append(element('h2',moteText('这台 Mac')));const facts=element('h2');facts.id='connection-storage-facts';summary.append(facts,element('p',moteText('确认上传后，待传副本会释放。来源文件夹里的原文件保留。'),'helper'));const contentActions=element('div',undefined,'actions spaced');const pendingAction=element('button',moteText('查看待发内容'),'primary');pendingAction.type='button';pendingAction.dataset.nav='work';const centralContent=element('button',moteText('查看中央资料'),'secondary');centralContent.type='button';centralContent.id='connection-central-content';contentActions.append(pendingAction,centralContent);summary.append(contentActions);const connectionList=list();connectionList.append(row('backup',moteText('备份与恢复'),moteText('本机待传队列')),row('storage',moteText('更换存储位置'),moteText('迁移本机记录与图片')));connection.insertBefore(summary,connection.children[1]??null);connection.insertBefore(connectionList,summary.nextSibling);const connectionDetails=element('details',undefined,'disclosure connection-details');connectionDetails.id='connection-details';connectionDetails.open=true;connectionDetails.append(element('summary',moteText('连接设置')));for(const panel of Array.from(connection.querySelectorAll<HTMLElement>(':scope>.panel:not(.connection-storage-summary)')))connectionDetails.append(panel);connection.append(connectionDetails);const manual=root.querySelector<HTMLElement>('[data-page=connection].settings-page')!;connectionDetails.append(manual);manual.removeAttribute('data-page');manual.classList.remove('page');manual.hidden=false;for(const control of Array.from(manual.querySelectorAll('input,select,textarea,button'))){control.setAttribute('form','settings');for(const type of ['input','change'])control.addEventListener(type,()=>id('settings').dispatchEvent(new Event(type,{bubbles:true})));}
  const backup=page('backup',moteText('备份与恢复'));const backupCard=element('section',undefined,'panel');backupCard.append(element('p',moteText('这台 Mac 尚未上传的记录'),'helper'));const backupFacts=element('div',undefined,'backup-count');backupFacts.id='backup-facts';backupCard.append(backupFacts,element('p',moteText('导出为电脑端队列 JSON，包含待传事件及关联图片。'),'helper'));const actions=element('div',undefined,'actions spaced');const restoreLink=element('button',moteText('从备份恢复'),'secondary');restoreLink.type='button';restoreLink.dataset.nav='restore';actions.append(id('export'),restoreLink);backupCard.append(actions);const details=element('details',undefined,'disclosure spaced');details.append(element('summary',moteText('备份包含什么')),element('p',moteText('当前待传事件及其关联图片。来源文件使用独立的传输队列。')),element('p',moteText('不包含 Central 归档、来源文件原件、未提交草稿、设置或登录凭据。')),element('p',moteText('备份文件包含个人资料，请保存在自己的位置。')));const metadataExport=id('export-metadata');metadataExport.textContent=moteText('仅导出本机元数据 JSON');details.append(metadataExport);backup.append(backupCard,details);const backupLinks=list();backupLinks.append(row('storage',moteText('本机存储位置')));backupLinks.append(id('export-central'));backup.append(backupLinks);
  const other=element('details',undefined,'disclosure spaced');other.append(element('summary',moteText('其他导出与本机目录')));const otherActions=element('div',undefined,'actions spaced');otherActions.append(id('data-folder'));other.append(otherActions);backup.append(other);
  const restore=page('restore',moteText('从备份恢复')),restoreCard=element('section',undefined,'panel');restoreCard.id='restore-selection';restoreCard.append(element('h2',moteText('选择电脑端队列 JSON')),element('p',moteText('选定后导入当前待传队列，并按当前连接与发送设置处理。'),'helper'));const target=element('dd');target.id='restore-send-target';const restoreFacts=element('dl',undefined,'maintenance-facts');restoreFacts.append(element('dt',moteText('发送到')),target);restoreCard.append(restoreFacts);const policy=element('dd');policy.id='restore-send-policy';restoreFacts.append(element('dt',moteText('发送状态')),policy);const pause=element('button',moteText('暂停全部发送'),'secondary');pause.id='restore-pause';pause.type='button';id('import').textContent=moteText('选择备份文件');id('import').className='primary';restoreCard.append(id('import'),pause);restore.append(restoreCard);page('export-result',moteText('导出待上传队列'));const result=element('section',undefined,'panel backup-operation');result.id='backup-operation';result.hidden=true;result.setAttribute('aria-live','polite');restore.append(result);
  const oldStorage=root.querySelector('.storage-tools')!;oldStorage.remove();
  const scopePanel=id('default-collection').closest('.panel')!;const scopeSection=element('section',undefined,'page settings-page');scopeSection.dataset.page='screen';scopeSection.hidden=true;scopeSection.append(scopePanel);id('settings-fields').prepend(scopeSection);
  const storage=page('storage',moteText('本机存储位置'),true),storagePanel=id('capture-directory').closest('.panel')!;
  const storageHeader=storagePanel.querySelector('.section-title')!;storageHeader.replaceChildren(element('p',moteText('当前保存位置'),'helper'));const storageName=element('h2');storageName.id='storage-location-name';storageHeader.append(storageName);const storageCount=element('p',undefined,'helper');storageCount.id='storage-location-count';storageHeader.append(storageCount);
  const actualDirectory=element('details',undefined,'disclosure storage-actual-directory');actualDirectory.append(element('summary',moteText('查看实际目录')),id('capture-directory').closest('label')!);storageHeader.after(actualDirectory);storage.append(storagePanel,id('storage-restart'));
  const capture=root.querySelector('[data-page="capture"] [data-page-title]');if(capture)capture.textContent=moteText('采集高级设置');const advanced=id('capture-advanced');advanced.replaceWith(...Array.from(advanced.children).filter(node=>node.tagName!=='SUMMARY'));
  const sampling=id('interval').closest('.panel')!,power=id('login').closest('.panel')!;sampling.querySelector('h2')!.textContent=moteText('采样与运行');sampling.querySelector('.section-title p')!.remove();for(const child of Array.from(power.children))if(!child.classList.contains('section-title'))sampling.append(child);power.remove();
  const imageSettings=id('jpeg-quality').closest('.panel')!,dedupe=id('image-dedupe').closest('.panel')!;imageSettings.querySelector('h2')!.textContent=moteText('画质与去重');imageSettings.querySelector('.section-title p')!.remove();imageSettings.append(imageSettings.querySelector('[data-nav=compression]')!);imageSettings.append(...Array.from(dedupe.children));dedupe.remove();
  const imagePresets=id('image-preset').closest('.panel')!,presetDetails=element('details',undefined,'disclosure spaced');presetDetails.append(element('summary',moteText('图像清晰度')),imagePresets);imageSettings.append(presetDetails);

  const diagnostics=root.querySelector('[data-page="developer"] [data-page-title]');if(diagnostics)diagnostics.textContent=moteText('帮助与诊断');const diagnosticDetails=id('diagnostics-enabled').closest('details')!;diagnosticDetails.replaceWith(...Array.from(diagnosticDetails.children).filter(node=>node.tagName!=='SUMMARY'));
  const diagnosticPanel=id('diagnostics-enabled').closest('.panel')!;
  const diagnosticHeading=diagnosticPanel.querySelector('.section-title')!;
  const numericDetails=element('details',undefined,'disclosure spaced');numericDetails.id='diagnostics-more';numericDetails.append(element('summary',moteText('更多')),diagnosticHeading,id('diagnostics-detail'));const currentFacts=element('section');currentFacts.id='diagnostics-current-facts';currentFacts.hidden=true;currentFacts.setAttribute('aria-live','polite');
  const diagnosticField=id('diagnostic-interval').closest('label')!;diagnosticField.classList.remove('narrow-field');diagnosticField.querySelector('span')!.textContent=moteText('采样间隔（秒）');
  const saveDiagnostics=element('button',moteText('保存诊断设置'),'primary');saveDiagnostics.id='diagnostics-save';saveDiagnostics.type='submit';
  const saveActions=element('div',undefined,'actions spaced');saveActions.append(saveDiagnostics,id('diagnostics-sample'));diagnosticPanel.insertBefore(saveActions,diagnosticField.nextSibling);saveActions.after(currentFacts);
  const exportGroup=element('section',undefined,'diagnostic-exports');exportGroup.append(element('h2',moteText('导出与日志')));const hours=element('label');hours.append(element('span',moteText('时间范围')),id('log-export-hours'));exportGroup.append(hours);const exports=element('div',undefined,'actions spaced');exports.append(id('events-open'),id('diagnostics-export'),id('support-export'));exportGroup.append(exports,element('p',moteText('仅导出到你选择的位置，不发送给任何人。'),'helper spaced'),id('events-viewer'),numericDetails);diagnosticPanel.querySelector(':scope>.actions:not(.spaced)')?.remove();diagnosticPanel.append(exportGroup);
  root.querySelector('[data-page=developer] .page-header .tag')?.remove();


}

export function renderSettingsWorkspace(status:Status,root:Document=document):void {
  const set=(id:string,text:string)=>{const node=root.getElementById(id);if(node)node.textContent=text;};
  const pending=status.queueDepth;
  set('capture-default-summary',describeCaptureSelection(status.config.defaultCollection));
  const backup=root.getElementById('backup-facts');if(backup){backup.replaceChildren(root.createTextNode(pending.toLocaleString()));const unit=root.createElement('small');unit.textContent=moteText('条');backup.append(unit);}set('restore-send-target',status.config.serverUrl||moteText('尚未连接中央，先保存在本机'));set('restore-send-policy',status.config.syncPaused?moteText('发送已暂停'):status.sync.message);(root.getElementById('restore-pause') as HTMLButtonElement).hidden=Boolean(status.config.syncPaused);
  set('connection-storage-facts',moteText('{0} 项待发送',status.sync.pendingRecords));
  const connected=Boolean(status.config.serverUrl&&status.config.tokenConfigured),connectionDetails=root.getElementById('connection-details') as HTMLDetailsElement;if(connectionDetails.dataset.connected!==String(connected)){connectionDetails.dataset.connected=String(connected);connectionDetails.open=!connected;}
  set('about-runtime',(status.environment?.profile??'')+(status.environment?.defaultProfile?moteText('（原日常目录）'):moteText(' · 独立数据')));
  set('preferences-credentials',status.credentialStorage==='json'?moteText('Dev 凭据保存在私有本地文件。'):moteText('凭据由操作系统保护。'));
  renderDiagnosticFacts(status,root);
}

export function showBackupOperation(kind:'import'|'export',phase:'working'|'canceled'|'complete'|'error',message:string,root:Document=document,file?:BackupFileIdentity):void {
  const panel=root.getElementById('backup-operation')!;root.querySelector('[data-page="'+(kind==='import'?'restore':'export-result')+'"]')!.append(panel);panel.hidden=kind==='import'&&phase==='canceled';const selection=root.getElementById('restore-selection')!;if(kind==='import')selection.hidden=phase!=='canceled';panel.dataset.phase=phase;panel.setAttribute('aria-busy',String(phase==='working'));panel.replaceChildren();
  const state=root.createElement('span');state.className='backup-operation-state';state.textContent=kind==='import'?(phase==='working'?moteText('正在导入到本机'):phase==='complete'?moteText('已导入本机'):phase==='canceled'?moteText('已取消'):moteText('导入尚未完成')):phase==='working'?moteText('正在导出…'):phase==='complete'?moteText('导出文件已生成'):phase==='canceled'?moteText('已取消'):moteText('导出未完成，请重试');
  const heading=root.createElement('h2');heading.textContent=kind==='import'?(phase==='working'?moteText('校验并保存记录'):phase==='complete'?moteText('记录已回来'):moteText('导入尚未完成')):phase==='working'?moteText('正在整理待上传队列'):phase==='complete'?moteText('已保存到所选位置'):phase==='canceled'?moteText('已取消'):moteText('备份未能生成');
  panel.append(state,heading);
  if(file&&phase!=='canceled'){
    const card=root.createElement('div');card.className='backup-operation-file';card.setAttribute('aria-label',moteText('本次选择的备份'));
    const symbol=root.createElement('span');symbol.className='backup-file-symbol';symbol.textContent='▤';symbol.setAttribute('aria-hidden','true');
    const copy=root.createElement('span'),name=root.createElement('strong'),path=root.createElement('small');name.textContent=file.name;path.textContent=file.path;copy.append(name,path);
    if(file.sizeBytes!==undefined){const size=root.createElement('small');size.textContent=`${file.sizeBytes.toLocaleString(getLocale())} bytes`;copy.append(size);}card.append(symbol,copy);panel.append(card);
  }else if(phase==='working'){const pending=root.createElement('p');pending.className='helper';pending.textContent=moteText('目标位置尚未确认');panel.append(pending);}
  const text=root.createElement('p');text.textContent=message;panel.append(text);
  if(phase==='working'){const progress=root.createElement('progress');progress.setAttribute('aria-label',heading.textContent);panel.append(progress);}
  if(phase==='complete'&&kind==='import'){const note=root.createElement('p');note.className='helper';note.textContent=moteText('导入没有改变原来的发送设置。');panel.append(note);}
  if(kind==='export'&&(phase==='complete'||phase==='error')){const note=root.createElement('p');note.className='helper';note.textContent=phase==='complete'?moteText('导出没有清空本机内容。'):moteText('本机记录保留，请检查目标位置后重试。');panel.append(note);}
  if(phase==='error'&&kind==='import'){
    const note=root.createElement('p');note.className='helper';note.textContent=moteText('重新选择同一份备份后重试。');panel.append(note);
    const actions=root.createElement('div');actions.className='actions';
    const retry=root.createElement('button');retry.type='button';retry.className='primary';retry.textContent=moteText('重新选择备份');retry.addEventListener('click',()=>root.getElementById('import')!.click());
    const content=root.createElement('button');content.type='button';content.className='secondary';content.textContent=moteText('检查本机内容');content.addEventListener('click',()=>root.querySelector<HTMLButtonElement>('.main-nav [data-nav="records"]')!.click());actions.append(retry,content);panel.append(actions);
  }
  if(phase==='complete'){
    const actions=root.createElement('div');actions.className='actions';
    const done=root.createElement('button');done.type='button';done.className='primary';done.textContent=kind==='import'?moteText('检查本机内容'):moteText('完成');done.addEventListener('click',()=>root.querySelector<HTMLButtonElement>(kind==='import'?'.main-nav [data-nav="records"]':'[data-nav="backup"]')!.click());actions.append(done);
    if(kind==='import'){const sending=root.createElement('button');sending.type='button';sending.className='secondary';sending.textContent=moteText('同步与活动');sending.addEventListener('click',()=>root.querySelector<HTMLButtonElement>('aside [data-nav="work"]')!.click());actions.append(sending);}panel.append(actions);
  }
  if(phase==='error'&&kind==='export'){const retry=root.createElement('button');retry.type='button';retry.className='primary';retry.textContent=moteText('重新导出');retry.addEventListener('click',()=>root.getElementById('export')!.click());panel.append(retry);}
  for(const id of ['export','import'])(root.getElementById(id) as HTMLButtonElement).disabled=phase==='working';
}
