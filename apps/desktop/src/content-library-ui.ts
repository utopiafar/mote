import {getLocale,moteText} from '@mote/shared/i18n';
import {appendDiagnostic,renderReadableFailure} from './ui-diagnostic';
import type {DesktopApi,Status} from './contracts';
import type {ContentItem,ContentDetail,CentralContentPage} from './content-library';
import type {SyncContent} from './sync-content';
import {showSkeleton} from './loading-ui';
/** Local content and its evidence reader; no markup from evidence becomes UI. */
export function createContentLibraryUi(api:DesktopApi,openMemories?:()=>void,reader?:{open():void;close():void}){
  const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
  const dialog=el<HTMLDialogElement>('content-detail-dialog');
  const releaseDialog=document.getElementById('content-release-dialog') as HTMLDialogElement|null;
  let releaseTarget:{key:string;generation:number}|undefined;
  const cancelRelease=()=>{releaseTarget=undefined;if(releaseDialog?.open)releaseDialog.close();};
  document.getElementById('content-memories')?.addEventListener('click',()=>openMemories?.());
  let generation=0,detailGeneration=0,status:Status|undefined,localOffset=0,remoteCursor:string|undefined,localMore=false,remoteMore=false;
  let archiveGeneration=0,archiveAuthorizationDenied=false,detailIsCentral=false;
  let archiveRequest=0,archiveResponse=0,archiveConflict=0;
  let archiveConfirmation:{scope:number}|undefined;
  let loadedScope='',deferredContent=false;
  let items:ContentItem[]=[],selected:ContentItem|undefined,selectedButton:HTMLElement|undefined,chunkOffset=0,centralId:string|undefined;
  const sourceName=(source:ContentItem['source'])=>({screen:moteText('截图'),ui_page:moteText('页面内容采集'),note:moteText('记录'),activity:moteText('应用活动'),notification:moteText('通知'),media:moteText('媒体状态'),file:moteText('文件'),calendar:moteText('日历'),coding:moteText('编码对话')} as Partial<Record<ContentItem['source'],string>>)[source]??moteText('内容');
  function renderFeed(id:string,rows:ContentItem[]){
    const root=el(id);root.replaceChildren();
    if(!rows.length){const empty=document.createElement('div');empty.className='content-empty';const title=document.createElement('strong');title.textContent=moteText('还没有内容，从一个小动作开始');const copy=document.createElement('p');copy.textContent=moteText('同步文件夹、导入文件、记录屏幕或写一条记录。内容会先保存在本机。');empty.append(title,copy);root.append(empty);return;}
    for(const item of rows){const button=document.createElement('button');button.type='button';button.className='content-row';button.dataset.contentKey=item.key;
      const icon=document.createElement('span');icon.className='content-type';icon.textContent=sourceName(item.source);
      const copy=document.createElement('span');copy.className='content-row-copy';const title=document.createElement('strong');title.textContent=item.title||sourceName(item.source);const meta=document.createElement('small');const time=document.createElement('time');time.dateTime=item.observedAt;time.textContent=new Date(item.observedAt).toLocaleString(getLocale());const source=document.createElement('span');source.className='content-source-name';source.textContent=item.sourceName??sourceName(item.source);meta.append(time,document.createTextNode(' · '),source);
      {
        const observed=new Date(item.observedAt),today=observed.toDateString()===new Date().toDateString();
        time.textContent=(today?moteText('今天')+' ':'')+observed.toLocaleString(getLocale(),{...(!today?{month:'short',day:'numeric'} as const:{}),hour:'2-digit',minute:'2-digit',hour12:false});
        source.textContent=item.source==='note'?sourceName(item.source):item.sourceName??sourceName(item.source);meta.replaceChildren(source,document.createTextNode(' · '),time);copy.append(title,meta);
      }
      const state=document.createElement('span');state.className=(item.error||item.localContentRelease?.pending)&&!item.key.startsWith('capture:')?'content-state needs-attention':'content-state';state.classList.toggle('received',item.key.startsWith('capture:')||Boolean(item.archiveAcknowledgment));state.title=item.archiveAcknowledgment?.origin??'';state.textContent=item.localContentRelease?moteText('中心已接收')+' · '+moteText(item.localContentRelease.pending?'需要处理':'本机副本已清理'):item.archiveAcknowledgment?moteText('中心已接收'):item.key.startsWith('capture:')?moteText('中心已接收'):item.error?moteText('需要处理'):moteText('本机待发送');
      {
        button.classList.add('home-content-row');icon.className='home-content-symbol';icon.setAttribute('aria-hidden','true');icon.textContent=({note:'✎',screen:'▧',ui_page:'▤',activity:'◷',notification:'◌',media:'♫',file:'▤',calendar:'▦',coding:'⌘'} as Partial<Record<ContentItem['source'],string>>)[item.source]??'▤';
        const arrow=document.createElement('span');arrow.className='chevron';arrow.setAttribute('aria-hidden','true');arrow.textContent='›';button.append(icon,copy,state,arrow);
      }
      button.addEventListener('click',()=>{selectedButton=button;selected=item;detailIsCentral=item.key.startsWith('capture:');chunkOffset=0;el<HTMLDetailsElement>('content-original').open=false;void readSelected();});root.append(button);
    }
  }
  function mergeRows(rows:ContentItem[]){
    const sorted=[...new Map(rows.map(item=>[item.key,item])).values()].sort((a,b)=>b.observedAt.localeCompare(a.observedAt)||a.key.localeCompare(b.key));
    const centralIds=new Set(sorted.filter(item=>item.key.startsWith('capture:')).map(item=>item.key.slice(8)));
    return sorted.filter(item=>!item.key.startsWith('queue:')||!centralIds.has(item.key.slice(6)));
  }
  function denyArchive(){
    archiveAuthorizationDenied=true;archiveGeneration++;remoteMore=false;remoteCursor=undefined;
    items=items.filter(row=>!row.key.startsWith('capture:'));renderFeed('content-feed',items);if(!items.length)el('content-feed').replaceChildren();
    el('content-more').hidden=!localMore;
    el('content-status').textContent=moteText('无法访问采集记录，请检查中央连接权限');el('content-status').classList.remove('visually-hidden');el('content-status').setAttribute('aria-busy','false');
    if(dialog.open&&(selected?.key.startsWith('capture:')||detailIsCentral))close();
  }
  function confirmArchive(repeat=false){
    if(!repeat)archiveConflict++;
    const scope=archiveGeneration;if(archiveConfirmation?.scope===scope)return;
    const confirmation=archiveConfirmation={scope},request=++archiveRequest,conflict=archiveConflict;
    void(async()=>{
      try{
        const page=await api.centralContent();if(scope!==archiveGeneration)return;
        // A fresh check is causally after the conflicting observations. If a
        // still newer success arrived while it ran, confirm that pair again.
        if(page.authorizationDenied?archiveResponse>request:archiveConflict!==conflict){archiveConfirmation=undefined;confirmArchive(true);return;}
        archiveResponse=Math.max(archiveResponse,request);
        if(page.authorizationDenied)denyArchive();else archiveAuthorizationDenied=false;
      }catch{if(scope===archiveGeneration)denyArchive();}
      finally{if(archiveConfirmation===confirmation)archiveConfirmation=undefined;}
    })();
  }
  // Display generations can be superseded by a local-only read. That does not
  // replace an in-flight Central authorization check. Conflicting response
  // order needs a fresh check; old scopes and pre-denial data stay invalid.
  function observeArchive(result:PromiseSettledResult<CentralContentPage|undefined>,request:number|undefined,scope:number):boolean{
    if(request===undefined||scope!==archiveGeneration||result.status!=='fulfilled'||!result.value)return false;
    if(request<=archiveResponse){if(result.value.authorizationDenied)confirmArchive();return false;}
    archiveResponse=request;
    if(result.value.authorizationDenied){denyArchive();return true;}
    archiveAuthorizationDenied=false;return false;
  }
  async function refresh(append=false){
    if(document.hidden){deferredContent=true;return;}
    lastRefresh=Date.now();if(refreshTimer){clearTimeout(refreshTimer);refreshTimer=undefined;}
    const version=++generation,archiveVersion=archiveGeneration;const scope=el<HTMLSelectElement>('content-scope').value,query=el<HTMLInputElement>('content-search').value;
    const scopeKey=JSON.stringify([scope,query.trim()]),previous=loadedScope===scopeKey?items:[];
    if(!append){localOffset=0;remoteCursor=undefined;localMore=false;remoteMore=false;items=[];}
    showSkeleton(el('content-status'),moteText('正在读取内容…'));
    el('content-status').setAttribute('aria-busy','true');
    if(!append&&!previous.length){
      // No complete result exists for this read yet; an old empty result is not proof.
      el('content-feed').replaceChildren();
      el('content-status').classList.remove('visually-hidden');
    }
    const local=scope==='received'||append&&!localMore?undefined:api.localContent(localOffset,query);
    const request=scope==='local'||!status?.config.tokenConfigured||append&&!remoteMore?undefined:++archiveRequest;
    let denied=false;
    const remote=request!==undefined?api.centralContent(remoteCursor,query).then(value=>{denied=observeArchive({status:'fulfilled',value},request,archiveVersion);return value;}):undefined;
    const [l,r]=await Promise.allSettled([local,remote]);if(version!==generation)return;
    const ignoredDenial=r.status==='fulfilled'&&r.value?.authorizationDenied&&!denied;
    const discarded=r.status==='fulfilled'&&r.value&&!r.value.authorizationDenied&&archiveVersion!==archiveGeneration;
    const rows:ContentItem[]=[];let error='';
    if(l.status==='fulfilled'&&l.value){rows.push(...l.value.items);localMore=l.value.nextOffset!==undefined;localOffset=l.value.nextOffset??localOffset;}else if(l.status==='rejected'){rows.push(...previous.filter(row=>!row.key.startsWith('capture:')));error=moteText('内容暂不可完整读取，重试。');}
    if(r.status==='fulfilled'&&r.value){
      if(denied||discarded&&archiveAuthorizationDenied){
        error=moteText('无法访问采集记录，请检查中央连接权限');
      }else if(ignoredDenial||discarded){if(!archiveAuthorizationDenied&&archiveVersion===archiveGeneration)rows.push(...previous.filter(row=>row.key.startsWith('capture:')));error=moteText('内容暂不可完整读取，重试。');}
      else if(archiveVersion===archiveGeneration&&!r.value.authorizationDenied){rows.push(...r.value.items);remoteMore=Boolean(r.value.nextCursor);remoteCursor=r.value.nextCursor;}
    }else if(r.status==='rejected'){if(archiveVersion===archiveGeneration&&!archiveAuthorizationDenied)rows.push(...previous.filter(row=>row.key.startsWith('capture:')));error=moteText('内容暂不可完整读取，重试。');}
    if(scope!=='local'&&archiveAuthorizationDenied)error=moteText('无法访问采集记录，请检查中央连接权限');
    items=mergeRows([...items,...rows]);loadedScope=scopeKey;renderFeed('content-feed',items);
    if(error&&!items.length)el('content-feed').replaceChildren();
    el('content-more').hidden=!localMore&&!remoteMore;
    el('content-status').textContent=error||(!status?.config.tokenConfigured?moteText('本机内容可离线阅读；连接中央后显示已归档内容。'):moteText('接收与整理分别进行，点开内容查看实际状态。'));
    el('content-status').classList.toggle('visually-hidden',!error);
    const diagnostics=[l,r].flatMap(result=>result.status==='rejected'?[result.reason instanceof Error?result.reason.message:String(result.reason)]:[]);
    if(error&&diagnostics.length)appendDiagnostic(el('content-status'),diagnostics.join('\n\n'));
    if(!items.length&&query.trim()&&!error)el('content-feed').textContent=moteText('没有符合条件的内容');
    el('content-status').setAttribute('aria-busy','false');
  }
  function stages(received:boolean,readiness:SyncContent['readiness']){
    const list=el('content-detail-stages');list.replaceChildren();
    const values=[moteText('本机已保存'),moteText('中央已收到'),moteText('正在整理'),moteText('已完整整理并建立索引')];
    values.forEach((label,index)=>{const item=document.createElement('li');item.textContent=label;item.className=index===0||index===1&&received||index===2&&(readiness==='pending'||readiness==='ready')||index===3&&readiness==='ready'?'completed':'waiting';list.append(item);});
  }
  async function readSelected(image=false){
    if(!selected)return;const version=++detailGeneration,archiveVersion=archiveGeneration,request=++archiveRequest,item=selected;
    el('content-detail-status').setAttribute('aria-busy','true');
    el('content-detail-title').textContent=item.title||sourceName(item.source);el('content-detail-source').textContent=sourceName(item.source);el('content-detail-facts').textContent=[item.sourceName,new Date(item.observedAt).toLocaleString(getLocale()),item.archiveAcknowledgment?moteText('中央已收到')+' '+new Date(item.archiveAcknowledgment.at).toLocaleString(getLocale()):undefined,item.archiveAcknowledgment?.origin].filter(Boolean).join(' · ');
    el('content-detail-range').hidden=true;el('content-detail-body').textContent='';el('content-detail-description').textContent='';el('content-description-section').hidden=true;el('content-detail-original-state').textContent='';el('content-detail-metadata').textContent='';el<HTMLImageElement>('content-detail-image').removeAttribute('src');showSkeleton(el('content-detail-status'),moteText('正在读取内容…'));el('content-detail-next').hidden=true;el('content-detail-central').hidden=true;el('content-original').hidden=true;
    if(!dialog.open){el<HTMLDetailsElement>('content-processing').open=false;if(reader){dialog.show();reader.open();}else dialog.showModal();el('content-detail-title').focus();}stages(item.key.startsWith('capture:')||Boolean(item.archiveAcknowledgment),'unknown');
    try{
      const result:ContentDetail|SyncContent=item.key.startsWith('capture:')?await api.centralContentDetail(item.key.slice(8),chunkOffset,image):await api.localContentDetail(item.key,image);
      if(version!==detailGeneration||!dialog.open)return;
      const remote='location'in result&&result.location==='central',released='localContentRelease'in result?result.localContentRelease:undefined;
      const releaseButton=document.getElementById('content-detail-release') as HTMLButtonElement|null,saveButton=document.getElementById('content-detail-save-original') as HTMLButtonElement|null;
      if(releaseButton)releaseButton.hidden=!('canRelease'in result&&result.canRelease);if(saveButton){saveButton.hidden=!('canSaveOriginal'in result&&result.canSaveOriginal);saveButton.textContent=moteText(released?'从中央另存原件':'保存原件');}
      if(released){el('content-detail-title').textContent=sourceName(item.source);selected={...item,title:sourceName(item.source),preview:'',localContentRelease:released};}const readiness='readiness'in result?result.readiness:undefined;
      // A receipt resolved from a local row must also respect a denial observed while it was loading.
      if(remote&&(archiveAuthorizationDenied||archiveVersion!==archiveGeneration)){close();return;}
      if(remote)observeArchive({status:'fulfilled',value:{items:[]}},request,archiveVersion);
      detailIsCentral=remote;
      const bytes='sizeBytes'in result?result.sizeBytes:undefined;el('content-detail-source').textContent=[sourceName(item.source),remote?moteText('中央已收到'):item.localContentRelease?(item.localContentRelease.pending?moteText('需要处理'):moteText('本机副本已清理')):item.archiveAcknowledgment?moteText('原件已保留'):moteText('本机待传副本'),typeof bytes==='number'?bytes<1024?bytes+' B':bytes<1024*1024?(bytes/1024).toFixed(1)+' KiB':(bytes/1024/1024).toFixed(1)+' MiB':''].filter(Boolean).join(' · ');
      stages(remote||Boolean(item.archiveAcknowledgment),readiness);centralId='captureId'in result?result.captureId:undefined;
      el('content-detail-body').textContent=result.text||(released?(released.pending?moteText('本机副本清理尚未完成；请重试，尚存输入不会用于重新上传。'):moteText('本机原件不在此设备，连接原中央后可按当前权限读取。')):result.metadataOnly?moteText('此记录仅同步目录信息，未上传正文或原件。'):remote?moteText('正文尚未就绪，原件与来源信息仍可核对。'):moteText('原件已保存在本机，解析或识别会在中央进行。'));
      el('content-detail-range').hidden=!result.truncated;el('content-detail-range').textContent=result.truncated?moteText('当前显示正文前 100000 个字符；完整内容在中央打开。'):'';
      el('content-detail-description').textContent=result.description??'';el('content-description-section').hidden=!result.description;
      el('content-detail-metadata').textContent=result.metadata??'';
      el('content-detail-original-state').textContent=released?(released.pending?moteText('本机副本清理尚未完成；请重试，尚存输入不会用于重新上传。'):moteText('本机原件不在此设备，连接原中央后可按当前权限读取。')):result.retainsOriginal===undefined?'':result.retainsOriginal?(remote?moteText('原件保留在中央'):moteText('原件已保存在本机')):remote?moteText('中央未保留原件'):moteText('本机仅保留目录信息');
      el('content-detail-status').textContent=!remote?(item.archiveAcknowledgment?moteText('中央已收到')+' · '+item.archiveAcknowledgment.origin:moteText('本机已保存；尚未收到中央接收确认。')):readiness==='ready'?moteText('资料已完整整理并建立索引'):readiness==='pending'?moteText('中央已收到，正在整理'):readiness==='failed'?moteText('中央已收到，整理需要处理'):readiness==='metadata'?moteText('仅目录信息；未读取正文'):moteText('中央已收到，整理状态待确认');
      el('content-original').hidden=!result.hasImage;if(result.image)el<HTMLImageElement>('content-detail-image').src=result.image;
      el('content-detail-central').hidden=!centralId;
      if('nextChunkOffset'in result&&result.nextChunkOffset!==undefined){el('content-detail-next').hidden=false;el('content-detail-next').dataset.offset=String(result.nextChunkOffset);}
    }catch(error){if(version!==detailGeneration||!dialog.open)return;renderReadableFailure(el('content-detail-status'),moteText('内容暂不可完整读取，重试。'),error instanceof Error?error.message:String(error));clearDetail();el('content-detail-title').textContent=moteText('内容暂不可用');if(item.localContentRelease){el('content-detail-facts').textContent=[item.sourceName,new Date(item.observedAt).toLocaleString(getLocale()),item.archiveAcknowledgment?.origin].filter(Boolean).join(' · ');el('content-detail-original-state').textContent=moteText(item.localContentRelease.pending?'本机副本清理尚未完成；请重试，尚存输入不会用于重新上传。':'本机原件不在此设备，连接原中央后可按当前权限读取。');}el<HTMLDetailsElement>('content-processing').open=true;if(item.key.startsWith('capture:')){items=items.filter(row=>!row.key.startsWith('capture:'));renderFeed('content-feed',items);}}
    finally{if(version===detailGeneration&&dialog.open)el('content-detail-status').setAttribute('aria-busy','false');}
  }
  function clearDetail(){document.getElementById('content-detail-release')?.setAttribute('hidden','');document.getElementById('content-detail-save-original')?.setAttribute('hidden','');el('content-detail-facts').textContent='';el('content-detail-description').textContent='';el('content-description-section').hidden=true;el('content-detail-range').textContent='';el('content-detail-range').hidden=true;el('content-detail-original-state').textContent='';el('content-detail-body').textContent='';el('content-detail-metadata').textContent='';el('content-detail-source').textContent='';el('content-detail-title').textContent='';el<HTMLImageElement>('content-detail-image').removeAttribute('src');centralId=undefined;detailIsCentral=false;el<HTMLDetailsElement>('content-original').open=false;}
  function close(returnToOrigin=true){cancelRelease();detailGeneration++;const wasOpen=dialog.open,button=selectedButton;dialog.close();clearDetail();selected=undefined;selectedButton=undefined;if(wasOpen&&returnToOrigin){reader?.close();button?.focus();}}
  el('content-detail-close').addEventListener('click',()=>close());dialog.addEventListener('cancel',()=>{cancelRelease();detailGeneration++;clearDetail();selected=undefined;selectedButton=undefined;reader?.close();});
  el('content-detail-refresh').addEventListener('click',()=>void readSelected(el<HTMLDetailsElement>('content-original').open));
  document.getElementById('content-detail-release')?.addEventListener('click',()=>{if(!selected||!releaseDialog)return;releaseTarget={key:selected.key,generation:detailGeneration};releaseDialog.showModal();});
  document.getElementById('content-release-cancel')?.addEventListener('click',cancelRelease);
  releaseDialog?.addEventListener('cancel',cancelRelease);
  document.getElementById('content-release-confirm')?.addEventListener('click',()=>void(async()=>{
    const target=releaseTarget;releaseTarget=undefined;releaseDialog?.close();if(!target||target.key!==selected?.key||target.generation!==detailGeneration)return;
    const version=++detailGeneration;clearDetail();items=items.filter(item=>item.key!==target.key);renderFeed('content-feed',items);
    try{await api.releaseLocalContent(target.key);if(version!==detailGeneration)return;close();window.dispatchEvent(new window.CustomEvent('mote-local-content-released'));await refresh();}
    catch(error){if(version!==detailGeneration||!dialog.open)return;await readSelected();window.dispatchEvent(new window.CustomEvent('mote-local-content-released'));void refresh();if(dialog.open)renderReadableFailure(el('content-detail-status'),moteText('操作失败'),error instanceof Error?error.message:String(error));}
  })());
  document.getElementById('content-detail-save-original')?.addEventListener('click',()=>void(async()=>{if(!selected)return;const key=selected.key,version=detailGeneration;try{await api.saveLocalContentOriginal(key);}catch(error){if(version===detailGeneration&&selected?.key===key)renderReadableFailure(el('content-detail-status'),moteText('操作失败'),error instanceof Error?error.message:String(error));}})());

  el('content-detail-next').addEventListener('click',()=>{chunkOffset=Number(el('content-detail-next').dataset.offset);void readSelected();});
  el('content-detail-central').addEventListener('click',()=>{if(centralId)void api.openCentral(undefined,centralId);});
  el<HTMLDetailsElement>('content-original').addEventListener('toggle',()=>{if(el<HTMLDetailsElement>('content-original').open&&!el<HTMLImageElement>('content-detail-image').src)void readSelected(true);});
  el('content-refresh').addEventListener('click',()=>void refresh());el('content-scope').addEventListener('change',()=>void refresh());el('content-more').addEventListener('click',()=>void refresh(true));
  let searchTimer:ReturnType<typeof setTimeout>|undefined;
  el('content-search').addEventListener('input',()=>{generation++;if(searchTimer)clearTimeout(searchTimer);searchTimer=setTimeout(()=>{searchTimer=undefined;void refresh();},180);});
  let signature='',lastRefresh=0,refreshTimer:ReturnType<typeof setTimeout>|undefined;
  // A tray-hidden window starts no new reads. When it returns, only the
  // currently visible surface catches up, once; navigating elsewhere later
  // performs its own normal read.
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){
      if(refreshTimer){clearTimeout(refreshTimer);refreshTimer=undefined;deferredContent=true;}
      return;
    }
    if(refreshTimer){clearTimeout(refreshTimer);refreshTimer=undefined;}
    if(deferredContent){deferredContent=false;void refresh();}
  });
  return {open(item:ContentItem){cancelRelease();selectedButton=undefined;selected=item;detailIsCentral=item.key.startsWith('capture:');chunkOffset=0;el<HTMLDetailsElement>('content-original').open=false;void readSelected();},refresh,update(next:Status){const changed=status&&(status.authorizationGeneration!==next.authorizationGeneration||status.config.serverUrl!==next.config.serverUrl||status.config.tokenConfigured!==next.config.tokenConfigured||status.config.authSignedOut!==next.config.authSignedOut||status.config.authExpiresAt!==next.config.authExpiresAt||status.config.authSourceBinding!==next.config.authSourceBinding);const nextSignature=JSON.stringify([next.queueDepth,next.queueBytes,next.sync.pendingRecords,next.sync.lastUploadAt,next.sync.state]);const contentChanged=signature!==nextSignature;signature=nextSignature;status=next;if(changed){close();items=[];loadedScope='';generation++;archiveGeneration++;archiveAuthorizationDenied=false;renderFeed('content-feed',[]);void refresh();}else if(contentChanged&&!refreshTimer){const delay=Math.max(0,3000-(Date.now()-lastRefresh));if(!delay)void refresh();else refreshTimer=setTimeout(()=>{refreshTimer=undefined;void refresh();},delay);}},close};
}
