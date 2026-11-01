import {moteText,getLocale} from '@mote/shared/i18n';
import type {DesktopApi,Status} from './contracts';
import type {SourceStatus} from './contracts/sources';
import type {ContentItem} from './contracts/content';
import type {SourceContextState} from './source-context-outbox';
const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
function node<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,className?:string){const value=document.createElement(tag);if(text!==undefined)value.textContent=text;if(className)value.className=className;return value;}
const retention=(row:SourceStatus)=>row.source.retention==='reference'?moteText('仅文件目录'):row.source.retention==='archive'?moteText('保留原件'):moteText('提取正文，不保留原件');
const label=(row:SourceStatus)=>!row.source.enabled||row.state==='paused'?moteText('已暂停'):row.blocked?moteText('需要处理'):row.state==='permission_required'?moteText('需要权限'):row.state==='error'?moteText('需要处理'):row.state==='syncing'?moteText('正在同步'):!row.scanComplete?moteText('等待首次清点'):moteText('持续同步');
export function createSourceWorkspaceUi(api:DesktopApi,actions:{openDetail():boolean;edit(id:string):void;toggle(row:SourceStatus):Promise<void>;content():void;read(item:import('./contracts/content').ContentItem):void}){
 let rows:SourceStatus[]=[],status:Status|undefined,selected:string|undefined,revision=0,renderedContent='',renderedCard='',archiveStale=false,contextId:string|undefined,contextState:SourceContextState|undefined,contextBusy=false,contextEpoch=0,contextScope='';
 type ArchiveView={row:SourceStatus;root:HTMLElement;epoch:number;items:ContentItem[];pages:number;nextCursor?:string;denied:boolean;busy:boolean;again:boolean;moreQueued:boolean;rendered:string;nodes:Map<string,{signature:string;button:HTMLButtonElement}>};
 let archive:ArchiveView|undefined;
 const dialog=el<HTMLDialogElement>('source-context-dialog');
 const button=(text:string,action:()=>void,className='text-button')=>{const b=node('button',text,className);b.type='button';b.addEventListener('click',action);return b;};
 const sourceRow=(row:SourceStatus)=>{const b=button('',()=>open(row.source.id),'source-list-row source-card');const icon=node('span',row.source.kind==='coding-agent'?'⌘':row.source.kind==='local-calendar'?'▦':'▱','source-symbol');icon.setAttribute('aria-hidden','true');const copy=node('span',undefined,'source-list-copy');copy.append(node('strong',row.source.name),node('small',`${retention(row)} · ${row.scanComplete?moteText('{0} 项内容',row.items):moteText('等待首次清点')}`));const state=node('span',label(row),'source-state');state.dataset.state=!row.source.enabled?'paused':row.state;const arrow=node('span','›','chevron');arrow.setAttribute('aria-hidden','true');b.append(icon,copy,state,arrow);return b;};
 function renderRows(){const list=el('source-list');list.replaceChildren();const ongoing=rows.filter(row=>row.source.syncContinuously!==false);for(const row of ongoing)list.append(sourceRow(row));if(!ongoing.length)list.append(node('p',moteText('尚未连接本地来源。选择只包含你希望归档资料的目录。'),'helper source-empty'));}
 function renderStatus(){if(!status)return;const channels=[status.config.defaultCollection?.duration?moteText('记录时长'):'',status.config.defaultCollection?.screenshots?moteText('保存截图'):'',status.config.defaultCollection?.structured?moteText('结构化内容'):''].filter(Boolean);el('source-screen-summary').textContent=[channels.join('、')||moteText('按已保存的范围记录'),moteText('{0} 项应用规则',Object.keys(status.config.appCollectionRules??{}).length)].join(' · ');el('source-screen-state').textContent=status.running?moteText('采集中'):moteText('已停止');el('source-screen-state').dataset.state=status.running?'syncing':'paused';}
 async function pending(row:SourceStatus,root:HTMLElement,epoch:number){try{const page=await api.sourcePendingContent(row.source.id);if(epoch!==revision||selected!==row.source.id)return;root.replaceChildren();for(const item of page.items){const b=button('',()=>actions.read(item),'source-list-row');const copy=node('span',undefined,'source-list-copy');copy.append(node('strong',item.title),node('small',new Date(item.observedAt).toLocaleString(getLocale())));b.append(node('span','▤','source-symbol'),copy,node('span',moteText('本机待发送'),'source-state'),node('span','›','chevron'));root.append(b);}if(!page.items.length)root.append(node('p',moteText('没有待发送内容'),'helper'));if(page.nextOffset!==undefined)root.append(button(moteText('查看全部待发送内容'),actions.content));}catch{if(epoch===revision)root.replaceChildren(node('p',moteText('本机内容暂不可读取，请重试。'),'helper'),button(moteText('重试'),()=>void pending(row,root,epoch)));}}
 const archiveCurrent=(view:ArchiveView)=>archive===view&&view.epoch===revision&&selected===view.row.source.id;
 function renderArchive(view:ArchiveView){
  view.root.querySelector('.source-archive-error')?.remove();
  const signature=JSON.stringify([view.items,view.nextCursor,view.denied]);if(signature===view.rendered)return;
  view.rendered=signature;const focused=document.activeElement as HTMLElement|null,nodes=new Map<string,{signature:string;button:HTMLButtonElement}>(),children:HTMLElement[]=[];
  for(const item of view.items){
   const signature=JSON.stringify(item),previous=view.nodes.get(item.key);let entry=previous?.signature===signature?previous:undefined;
   if(!entry){const b=button('',()=>actions.read(item),'source-list-row'),copy=node('span',undefined,'source-list-copy');copy.append(node('strong',item.title),node('small',new Date(item.observedAt).toLocaleString(getLocale())));b.append(node('span','▤','source-symbol'),copy,node('span',moteText('中央已收到'),'source-state'),node('span','›','chevron'));entry={signature,button:b};}
   nodes.set(item.key,entry);children.push(entry.button);
  }
  if(!children.length)children.push(node('p',view.denied?moteText('无法访问采集记录，请检查中央连接权限'):moteText('暂无中央归档内容'),'helper'));
  if(view.nextCursor)children.push(button(moteText('加载更多'),()=>void archivedContent(view,true)));
  view.nodes=nodes;view.root.replaceChildren(...children);
  if(focused&&view.root.contains(focused))focused.focus({preventScroll:true});
 }
 async function archivedContent(view:ArchiveView,more=false){
  if(!archiveCurrent(view)||document.hidden)return;
  if(view.busy){if(more)view.moreQueued=true;else view.again=true;return;}
  if(more&&!view.nextCursor)return;
  if(!status?.config.tokenConfigured){view.root.replaceChildren(node('p',moteText('本机内容可离线阅读；连接中央后显示已归档内容。'),'helper'));return;}
  view.busy=true;if(!more)view.again=false;
  const loading=!view.items.length?node('p',moteText('正在读取…'),'helper'):undefined;if(loading)view.root.append(loading);
  try{
   const items:ContentItem[]=more?[...view.items]:[],target=more?1:Math.max(1,view.pages);let cursor=more?view.nextCursor:undefined,pages=0;
   for(let index=0;index<target;index++){
    if(index>0&&!cursor)break;
    if(index>0&&!detailVisible()){archiveStale=true;return;}
    const page=await api.sourceArchivedContent(view.row.source.id,cursor);if(!archiveCurrent(view))return;
    if(page.authorizationDenied){view.items=[];view.pages=0;view.nextCursor=undefined;view.denied=true;renderArchive(view);return;}
    items.push(...page.items);cursor=page.nextCursor;pages++;
   }
   view.items=items;view.pages=more?view.pages+pages:pages;view.nextCursor=cursor;view.denied=false;renderArchive(view);
  }catch{
   if(archiveCurrent(view)){view.root.querySelector('.source-archive-error')?.remove();const error=node('div',undefined,'source-archive-error');error.append(node('p',moteText('内容暂不可完整读取，请重试。'),'helper'),button(moteText('重试'),()=>void archivedContent(view,more)));view.root.append(error);}
  }finally{
   loading?.remove();view.busy=false;
   if(archiveCurrent(view)){
    if(!view.nextCursor)view.moreQueued=false;
    if(!detailVisible()){if(view.again||view.moreQueued)archiveStale=true;}
    else if(view.moreQueued&&view.nextCursor){view.moreQueued=false;void archivedContent(view,true);}
    else if(view.again){view.again=false;void archivedContent(view);}
   }
  }
 }
 const stateCard=(row:SourceStatus)=>{const state=node('section',undefined,'source-state-card'),stateText=node('span',label(row),'source-state');stateText.dataset.state=row.state;state.append(stateText,node('p',row.source.enabled?row.message:moteText('暂停检查和发送这个来源；待发内容仍留在本机。')));const controls=node('div',undefined,'actions');controls.append(button(row.source.enabled?moteText('暂停这个来源'):moteText('恢复这个来源'),()=>{const current=rows.find(item=>item.source.id===row.source.id);if(current)void actions.toggle(current);},'secondary'),button(moteText('编辑设置'),()=>actions.edit(row.source.id)));state.append(controls);return state;};
 const syncDetails=(row:SourceStatus,open:boolean)=>{const details=node('details',undefined,'source-detail-context source-detail-sync');details.open=open;details.append(node('summary',moteText('同步详情')));const facts=node('dl',undefined,'source-facts');for(const [key,value] of [[moteText('已清点'),row.scanComplete?String(row.items):moteText('尚未完成首次清点')],[moteText('已跳过'),String(row.skipped)],[moteText('中心保留什么'),retention(row)],[moteText('上次清点'),row.scanComplete?moteText('已完成')+' · '+moteText('时间')+'：'+moteText('未知'):moteText('尚未开始')]])facts.append(node('dt',key),node('dd',value));details.append(facts);return details;};
 const contentSignature=(row:SourceStatus)=>JSON.stringify({id:row.source.id,enabled:row.source.enabled,kind:row.source.kind,name:row.source.name,path:row.source.path,retention:row.source.retention,pending:row.pending,pendingContentRevision:row.pendingContentRevision,blocked:row.blocked,failures:row.failures,context:row.context,lastAcknowledgedAt:row.lastAcknowledgedAt,tokenConfigured:status?.config.tokenConfigured,authorizationGeneration:status?.authorizationGeneration});
 const cardSignature=(row:SourceStatus)=>JSON.stringify({state:row.state,message:row.message,items:row.items,skipped:row.skipped,scanComplete:row.scanComplete});
 const detailVisible=()=>!document.hidden&&!el('source-detail-body').closest('[hidden]');
 function renderDetail(force=false){if(document.hidden)return;const row=rows.find(row=>row.source.id===selected);if(!row)return;const content=contentSignature(row),card=cardSignature(row);if(!force&&(content===renderedContent&&card===renderedCard||!detailVisible()))return;
  if(!force&&content===renderedContent){renderedCard=card;const root=el('source-detail-body');root.querySelector('.source-state-card')?.replaceWith(stateCard(row));const sync=root.querySelector<HTMLDetailsElement>('.source-detail-sync');if(sync)sync.replaceWith(syncDetails(row,sync.open));return;}
  renderedContent=content;renderedCard=card;archiveStale=false;const epoch=++revision,root=el('source-detail-body'),contextOpen=root.querySelector<HTMLDetailsElement>('.source-detail-context:not(.source-detail-sync)')?.open;root.replaceChildren();root.append(node('p',moteText('这台 Mac')+' · '+(row.source.kind==='coding-agent'?moteText('本机编码对话'):row.source.kind==='local-calendar'?moteText('日历'):moteText('同步文件夹')),'helper'));const title=node('h1',row.source.name);title.dataset.pageTitle='';title.tabIndex=-1;root.append(title,node('p',row.source.path||moteText('所选系统日历'),'helper profile-path'));
 root.append(stateCard(row));
 const description=node('details',undefined,'source-detail-context');description.open=contextOpen??false;description.append(node('summary',moteText('资料说明')),node('p',row.context?.pending?.description??row.context?.snapshot.description??moteText('尚未填写'),'source-description'));if(row.context?.pending)description.append(node('p',row.context.conflict?moteText('中央说明已改变，请核对后保存。'):moteText('说明待同步'),'helper'));description.append(button(moteText('编辑'),()=>void openContext(row.source.id)));root.append(description);
 const section=node('section',undefined,'source-detail-section');section.append(node('h2',moteText('本机待发送 · {0}',row.pending)));const items=node('div',undefined,'source-list');section.append(items);root.append(section);void pending(row,items,epoch);
 if(row.blocked){const failures=node('section',undefined,'source-detail-section source-failures');failures.append(node('h2',moteText('本机待处理 {0} 项',row.blocked)));for(const failure of row.failures??[])failures.append(node('p',`${failure.title||failure.externalId} · ${failure.status===410?moteText('中央已删除此文件'):failure.status===409?moteText('文件版本冲突'):moteText('中央拒绝此文件（{0}）',failure.status)}`,'helper'));root.append(failures);}

 const archived=node('section',undefined,'source-detail-section'),heading=node('div',undefined,'section-heading');heading.append(node('h2',moteText('中央已归档')),button(moteText('查看中央资料'),()=>{archiveStale=true;void api.openCentral('library');}));const archivedRows=node('div',undefined,'source-list source-archived-list');archived.append(heading,archivedRows);root.append(archived);archive={row,root:archivedRows,epoch,items:[],pages:0,denied:false,busy:false,again:false,moreQueued:false,rendered:'',nodes:new Map()};void archivedContent(archive);
 root.append(syncDetails(row,false));
 }
 // Central deletions leave no local signal. Each window return rechecks the
 // archive once, even if a local update rendered it during the browser visit.
 // Hidden pages defer that read; unrelated source polls never rearm it.
 function revalidateArchive(){if(archive)void archivedContent(archive);}
 function consumeArchiveStale(awake=document.hasFocus()){if(archiveStale&&detailVisible()&&awake){archiveStale=false;revalidateArchive();}}
 document.defaultView?.addEventListener('focus',()=>{if(selected)archiveStale=true;consumeArchiveStale(true);});
 document.addEventListener('visibilitychange',()=>{if(document.hidden){archiveStale=true;return;}renderDetail();consumeArchiveStale(true);});
 // Returning from the content reader only changes the page's hidden attribute;
 // it must not depend on another successful source-status poll.
 const detailPage=el('source-detail-body').closest('[data-page]');
 if(detailPage&&document.defaultView)new document.defaultView.MutationObserver(()=>{if(!detailVisible()){archiveStale=true;return;}renderDetail();consumeArchiveStale(true);}).observe(detailPage,{attributes:true,attributeFilter:['hidden']});
 // Remote devices can delete while this window stays in front. Recheck only
 // the loaded archive pages, at most four rechecks per minute; hidden windows do not read.
 document.defaultView?.setInterval(()=>{if(selected&&detailVisible())revalidateArchive();},15000);
 function open(id:string){selected=id;renderedContent='';renderedCard='';renderDetail(true);actions.openDetail();}
 function lockContext(value:boolean){contextBusy=value;for(const id of ['source-context-save','source-context-refresh'])el<HTMLButtonElement>(id).disabled=value;}
 function displayContext(value:SourceContextState,preserveDraft=false){contextState=value;if(!preserveDraft)el<HTMLTextAreaElement>('source-context-description').value=value.pending?.description??value.snapshot.description;el('source-context-message').textContent=value.error?moteText('暂时无法核对中央说明。输入保留在这里，可稍后重试。'):value.conflict?moteText('中央说明已改变。你的输入已保留，请核对当前说明后再保存。'):value.pending?moteText('说明已保存在本机，按当前发送设置同步。'):moteText('说明独立于原文，用于理解这个来源的资料。');el('source-context-current').hidden=Boolean(value.error)||!value.conflict;el('source-context-current-text').textContent=value.error?'':value.snapshot.description||moteText('尚未填写');el<HTMLButtonElement>('source-context-save').disabled=contextBusy||Boolean(value.error);}
 function invalidateContext(){contextEpoch++;contextId=undefined;contextState=undefined;lockContext(false);el<HTMLTextAreaElement>('source-context-description').value='';el('source-context-current-text').textContent='';dialog.close();}
 function contextRequest(id:string){return {id,epoch:contextEpoch,scope:contextScope};}
 function contextCurrent(request:ReturnType<typeof contextRequest>){return contextId===request.id&&contextEpoch===request.epoch&&contextScope===request.scope;}
 async function openContext(id:string){invalidateContext();contextId=id;const request=contextRequest(id);el('source-context-message').textContent=moteText('正在读取…');el('source-context-current').hidden=true;dialog.showModal();lockContext(true);try{const value=await api.sourceContext(id);if(contextCurrent(request))displayContext(value);}catch{if(contextCurrent(request))el('source-context-message').textContent=moteText('暂时无法核对中央说明。输入保留在这里，可稍后重试。');}finally{if(contextCurrent(request)){lockContext(false);if(contextState)displayContext(contextState,true);}}}
 el('source-context-cancel').addEventListener('click',invalidateContext);dialog.addEventListener('cancel',invalidateContext);
 el('source-context-refresh').addEventListener('click',()=>void(async()=>{if(!contextId||contextBusy)return;const request=contextRequest(contextId);lockContext(true);try{const state=await api.sourceContext(request.id);if(contextCurrent(request))displayContext(state,true);}catch{if(contextCurrent(request))el('source-context-message').textContent=moteText('暂时无法核对中央说明。输入保留在这里，可稍后重试。');}finally{if(contextCurrent(request)){lockContext(false);if(contextState)displayContext(contextState,true);}}})());
 el('source-context-save').addEventListener('click',()=>void(async()=>{if(!contextId||!contextState||contextBusy)return;const request=contextRequest(contextId);lockContext(true);try{const state=await api.saveSourceContext(request.id,{expectedVersion:contextState.snapshot.version,description:el<HTMLTextAreaElement>('source-context-description').value});if(contextCurrent(request)){const row=rows.find(row=>row.source.id===request.id);if(row)row.context=state;renderDetail(true);invalidateContext();}}catch{if(contextCurrent(request))el('source-context-message').textContent=moteText('保存未完成，说明仍保留。请重新核对后重试。');}finally{if(contextCurrent(request))lockContext(false);}})());
 function clear(){revision++;selected=undefined;renderedContent='';renderedCard='';archiveStale=false;archive=undefined;invalidateContext();rows=[];el('source-detail-body').replaceChildren();renderRows();}

 return {open,update(nextRows:SourceStatus[]){rows=nextRows;renderRows();renderDetail();consumeArchiveStale();},status(next:Status){const scope=JSON.stringify([next.authorizationGeneration,next.config.serverUrl,next.config.tokenConfigured,next.config.authSignedOut,next.config.authExpiresAt]);if(scope!==contextScope){clear();contextScope=scope;}status=next;renderStatus();},clear};
}
