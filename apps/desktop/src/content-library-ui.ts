import {getLocale,moteText} from '@mote/shared/i18n';
import type {DesktopApi,Status} from './contracts';
import type {ContentItem,ContentDetail} from './content-library';
import type {SyncContent} from './sync-content';
/** Home and Content share one evidence reader; no markup from evidence becomes UI. */
export function createContentLibraryUi(api:DesktopApi){
  const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
  const dialog=el<HTMLDialogElement>('content-detail-dialog');
  let generation=0,detailGeneration=0,status:Status|undefined,localOffset=0,remoteCursor:string|undefined,localMore=false,remoteMore=false;
  let items:ContentItem[]=[],selected:ContentItem|undefined,selectedButton:HTMLElement|undefined,chunkOffset=0,centralId:string|undefined;
  const sourceName=(source:ContentItem['source'])=>({screen:moteText('截图'),ui_page:moteText('页面内容采集'),note:moteText('随手记'),activity:moteText('应用活动'),notification:moteText('通知'),file:moteText('文件'),calendar:moteText('日历'),coding:moteText('编码对话')})[source]??moteText('内容');
  function renderFeed(id:string,rows:ContentItem[]){
    const root=el(id);root.replaceChildren();
    if(!rows.length){const empty=document.createElement('div');empty.className='content-empty';const title=document.createElement('strong');title.textContent=moteText('还没有内容，从一个小动作开始');const copy=document.createElement('p');copy.textContent=moteText('同步文件夹、导入文件、记录屏幕或写一条随手记。内容会先保存在本机。');empty.append(title,copy);root.append(empty);return;}
    for(const item of rows){const button=document.createElement('button');button.type='button';button.className='content-row';button.dataset.contentKey=item.key;
      const icon=document.createElement('span');icon.className='content-type';icon.textContent=sourceName(item.source);
      const copy=document.createElement('span');copy.className='content-row-copy';const title=document.createElement('strong');title.textContent=item.title||sourceName(item.source);const preview=document.createElement('span');preview.textContent=item.preview;const meta=document.createElement('small');meta.textContent=`${new Date(item.observedAt).toLocaleString(getLocale())} · ${item.sourceName??sourceName(item.source)}`;copy.append(title,preview,meta);
      const state=document.createElement('span');state.className='content-state';state.textContent=item.key.startsWith('capture:')?moteText('中央已收到'):item.error?moteText('需要处理'):moteText('本机已保存');button.append(icon,copy,state);button.addEventListener('click',()=>{selectedButton=button;selected=item;chunkOffset=0;el<HTMLDetailsElement>('content-original').open=false;void readSelected();});root.append(button);
    }
  }
  async function refresh(append=false){
    lastRefresh=Date.now();if(refreshTimer){clearTimeout(refreshTimer);refreshTimer=undefined;}
    const version=++generation;const scope=el<HTMLSelectElement>('content-scope').value;
    if(!append){localOffset=0;remoteCursor=undefined;localMore=false;remoteMore=false;items=[];}
    el('content-status').textContent=moteText('正在读取内容…');
    const local=scope==='received'||append&&!localMore?undefined:api.localContent(localOffset);
    const remote=scope==='local'||!status?.config.tokenConfigured||append&&!remoteMore?undefined:api.centralContent(remoteCursor);
    const [l,r]=await Promise.allSettled([local,remote]);if(version!==generation)return;
    const rows:ContentItem[]=[];let error='';
    if(l.status==='fulfilled'&&l.value){rows.push(...l.value.items);localMore=l.value.nextOffset!==undefined;localOffset=l.value.nextOffset??localOffset;}else if(l.status==='rejected')error=l.reason instanceof Error?l.reason.message:String(l.reason);
    if(r.status==='fulfilled'&&r.value){rows.push(...r.value.items);remoteMore=Boolean(r.value.nextCursor);remoteCursor=r.value.nextCursor;}else if(r.status==='rejected'){error=r.reason instanceof Error?r.reason.message:String(r.reason);items=items.filter(row=>!row.key.startsWith('capture:'));}
    const merged=new Map([...items,...rows].map(item=>[item.key,item]));items=[...merged.values()].sort((a,b)=>b.observedAt.localeCompare(a.observedAt)||a.key.localeCompare(b.key));
    const centralIds=new Set(items.filter(item=>item.key.startsWith('capture:')).map(item=>item.key.slice(8)));items=items.filter(item=>!item.key.startsWith('queue:')||!centralIds.has(item.key.slice(6)));
    renderFeed('content-feed',items);renderFeed('home-recent',items.slice(0,5));el('content-more').hidden=!localMore&&!remoteMore;
    el('content-status').textContent=error||(!status?.config.tokenConfigured?moteText('本机内容可离线阅读；连接中央后显示已归档内容。'):moteText('接收与整理分别进行，点开内容查看实际状态。'));
  }
  function stages(received:boolean,readiness:SyncContent['readiness']){
    const list=el('content-detail-stages');list.replaceChildren();
    const values=[moteText('本机已保存'),moteText('中央已收到'),moteText('正在整理'),moteText('已完整整理并建立索引')];
    values.forEach((label,index)=>{const item=document.createElement('li');item.textContent=label;item.className=index===0||index===1&&received||index===2&&(readiness==='pending'||readiness==='ready')||index===3&&readiness==='ready'?'completed':'waiting';list.append(item);});
  }
  async function readSelected(image=false){
    if(!selected)return;const version=++detailGeneration,item=selected;
    el('content-detail-title').textContent=item.title||sourceName(item.source);el('content-detail-source').textContent=`${sourceName(item.source)} · ${item.sourceName??''} · ${new Date(item.observedAt).toLocaleString(getLocale())}`;
    el('content-detail-range').hidden=true;el('content-detail-body').textContent='';el('content-detail-original-state').textContent='';el('content-detail-metadata').textContent='';el<HTMLImageElement>('content-detail-image').removeAttribute('src');el('content-detail-status').textContent=moteText('正在读取内容…');el('content-detail-next').hidden=true;el('content-detail-central').hidden=true;el('content-original').hidden=true;
    if(!dialog.open){dialog.showModal();el('content-detail-title').focus();}stages(item.key.startsWith('capture:'),'unknown');
    try{
      const result:ContentDetail|SyncContent=item.key.startsWith('capture:')?await api.centralContentDetail(item.key.slice(8),chunkOffset,image):await api.localContentDetail(item.key,image);
      if(version!==detailGeneration||!dialog.open)return;
      const remote='location'in result&&result.location==='central';const readiness='readiness'in result?result.readiness:undefined;
      stages(remote,readiness);centralId='captureId'in result?result.captureId:undefined;
      el('content-detail-body').textContent=result.text||(result.metadataOnly?moteText('此记录仅同步目录信息，未上传正文或原件。'):remote?moteText('正文尚未就绪，原件与来源信息仍可核对。'):moteText('原件已保存在本机，解析或识别会在中央进行。'));
      el('content-detail-range').hidden=!result.truncated;el('content-detail-range').textContent=result.truncated?moteText('当前显示正文前 100000 个字符；完整内容请在中央打开。'):'';
      el('content-detail-metadata').textContent=result.metadata??'';
      el('content-detail-original-state').textContent=result.retainsOriginal===undefined?'':result.retainsOriginal?(remote?moteText('原件保留在中央'):moteText('原件已保存在本机')):remote?moteText('中央未保留原件'):moteText('本机仅保留目录信息');
      el('content-detail-status').textContent=!remote?moteText('本机已保存；尚未收到中央接收确认。'):readiness==='ready'?moteText('资料已完整整理并建立索引'):readiness==='pending'?moteText('中央已收到，正在整理'):readiness==='failed'?moteText('中央已收到，整理需要处理'):readiness==='metadata'?moteText('仅目录信息；未读取正文'):moteText('中央已收到，整理状态待确认');
      el('content-original').hidden=!result.hasImage;if(result.image)el<HTMLImageElement>('content-detail-image').src=result.image;
      el('content-detail-central').hidden=!centralId;
      if('nextChunkOffset'in result&&result.nextChunkOffset!==undefined){el('content-detail-next').hidden=false;el('content-detail-next').dataset.offset=String(result.nextChunkOffset);}
    }catch(error){if(version!==detailGeneration||!dialog.open)return;el('content-detail-status').textContent=error instanceof Error?error.message:String(error);clearDetail();if(item.key.startsWith('capture:')){items=items.filter(row=>!row.key.startsWith('capture:'));renderFeed('content-feed',items);renderFeed('home-recent',items.slice(0,5));}}
  }
  function clearDetail(){el('content-detail-range').textContent='';el('content-detail-range').hidden=true;el('content-detail-original-state').textContent='';el('content-detail-body').textContent='';el('content-detail-metadata').textContent='';el('content-detail-source').textContent='';el('content-detail-title').textContent='';el<HTMLImageElement>('content-detail-image').removeAttribute('src');centralId=undefined;el<HTMLDetailsElement>('content-original').open=false;}
  function close(){detailGeneration++;dialog.close();clearDetail();selectedButton?.focus();}
  el('content-detail-close').addEventListener('click',close);dialog.addEventListener('cancel',()=>{detailGeneration++;clearDetail();});
  el('content-detail-refresh').addEventListener('click',()=>void readSelected(el<HTMLDetailsElement>('content-original').open));
  el('content-detail-next').addEventListener('click',()=>{chunkOffset=Number(el('content-detail-next').dataset.offset);void readSelected();});
  el('content-detail-central').addEventListener('click',()=>{if(centralId)void api.openCentral(undefined,centralId);});
  el<HTMLDetailsElement>('content-original').addEventListener('toggle',()=>{if(el<HTMLDetailsElement>('content-original').open&&!el<HTMLImageElement>('content-detail-image').src)void readSelected(true);});
  el('content-refresh').addEventListener('click',()=>void refresh());el('content-scope').addEventListener('change',()=>void refresh());el('content-more').addEventListener('click',()=>void refresh(true));
  let signature='',lastRefresh=0,refreshTimer:ReturnType<typeof setTimeout>|undefined;
  return {refresh,update(next:Status){const changed=status&&(status.authorizationGeneration!==next.authorizationGeneration||status.config.serverUrl!==next.config.serverUrl||status.config.tokenConfigured!==next.config.tokenConfigured||status.config.authSignedOut!==next.config.authSignedOut||status.config.authExpiresAt!==next.config.authExpiresAt||status.config.authSourceBinding!==next.config.authSourceBinding);const nextSignature=JSON.stringify([next.queueDepth,next.sync.pendingRecords,next.sync.lastUploadAt,next.sync.state]);const contentChanged=signature!==nextSignature;signature=nextSignature;status=next;if(changed){close();items=[];generation++;renderFeed('content-feed',[]);renderFeed('home-recent',[]);void refresh();}else if(contentChanged&&!refreshTimer){const delay=Math.max(0,3000-(Date.now()-lastRefresh));if(!delay)void refresh();else refreshTimer=setTimeout(()=>{refreshTimer=undefined;void refresh();},delay);}},close};
}
