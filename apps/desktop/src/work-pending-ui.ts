import {desktopIcon,desktopContentIcon} from './desktop-icon';
import {renderReadableFailure} from './ui-diagnostic';
import {moteText,getLocale} from '@mote/shared/i18n';
import type {DesktopApi,Status} from './contracts';
import {localContentPageSize,type ContentItem} from './contracts/content';
import {showSkeleton,showLoadingLine} from './loading-ui';
import {updateListChildren} from './list-children';

/** Reads the same complete local queue index as Content; each row opens the shared reader. */
export function createWorkPendingUi(api:DesktopApi,open:(item:ContentItem)=>void,receipts:()=>void){
  const root=document.querySelector<HTMLElement>('[data-page="work"]')!;
  const tabs=document.createElement('div');tabs.className='work-delivery-tabs';const pending=document.createElement('button');pending.type='button';pending.className='text-button';pending.textContent=moteText('待发送');pending.setAttribute('aria-pressed','true');const history=document.createElement('button');history.type='button';history.className='text-button';history.id='work-receipts';history.textContent=moteText('接收历史');history.addEventListener('click',receipts);tabs.append(pending,history);root.insertBefore(tabs,root.children[1]);
  const wrapper=document.getElementById('home-sync-details') as HTMLDetailsElement;wrapper.open=false;wrapper.querySelector('summary')!.textContent=moteText('更多');
  const notice=document.createElement('div');notice.className='work-delivery-notice';notice.append(document.getElementById('sync-state')!);root.insertBefore(notice,wrapper);
  const actions=document.createElement('div');actions.className='actions work-delivery-actions';document.getElementById('retry')!.className='primary';actions.append(document.getElementById('pause-sending')!,document.getElementById('retry')!);
  const section=document.querySelector<HTMLElement>('.work-local')!,list=document.createElement('div');list.className='work-pending-list';list.id='work-pending-list';const state=document.createElement('p');state.className='helper';state.id='work-pending-state';state.setAttribute('role','status');const more=document.createElement('button');more.type='button';more.className='secondary';more.textContent=moteText('加载更多');more.hidden=true;more.id='work-pending-more';section.append(state,list,more);
  // Keep every existing connection, transfer and Central-work tool in the explicit secondary disclosure.
  const heading=section.querySelector('.section-heading')!;wrapper.append(heading);
  for(const id of ['work-local-state','work-local-pending','work-local-jobs'])wrapper.append(document.getElementById(id)!);
  for(let next=section.nextElementSibling;next;){const following=next.nextElementSibling;wrapper.append(next);next=following;}
  wrapper.append(document.getElementById('work-refresh')!);root.append(section,actions,wrapper);
  let version=0,active=false,reading=false,stale=false,scope='',queue='';
  let items:ContentItem[]=[],next:number|undefined,visibleLimit=localContentPageSize;
  function createRow(item:ContentItem){
    const row=document.createElement('button'),icon=document.createElement('span'),copy=document.createElement('span');
    const title=document.createElement('strong'),meta=document.createElement('small'),status=document.createElement('span');
    const arrow=document.createElement('span');
    row.type='button';
    row.className='content-row home-content-row';
    icon.className='home-content-symbol';
    icon.append(desktopContentIcon(document,item.source));
    copy.className='content-row-copy';
    copy.append(title,meta);
    status.className='content-state';
    arrow.className='chevron';
    arrow.append(desktopIcon(document,'chevron-right',true));
    row.append(icon,copy,status,arrow);
    const view={row,title,meta,status,item};
    row.addEventListener('click',()=>open(view.item));
    return view;
  }
  let rows=new Map<string,ReturnType<typeof createRow>>();
  function render(){
    const current=new Map<string,ReturnType<typeof createRow>>();
    for(const item of items){
      const view=rows.get(item.key)??createRow(item);
      view.item=item;
      const meta=[item.sourceName,new Date(item.observedAt).toLocaleString(getLocale())].filter(Boolean).join(' · ');
      const status=item.error?moteText('需要处理'):moteText('本机待发送');
      if(view.title.textContent!==item.title)view.title.textContent=item.title;
      if(view.meta.textContent!==meta)view.meta.textContent=meta;
      if(view.status.textContent!==status)view.status.textContent=status;
      view.status.classList.toggle('needs-attention',Boolean(item.error));
      current.set(item.key,view);
    }
    rows=current;
    updateListChildren(list,Array.from(rows.values(),view=>view.row));
    more.hidden=next===undefined;
  }
  async function refresh(append=false){
    if(!active||reading||(append&&next===undefined))return;
    const revision=++version;
    reading=true;
    stale=false;
    if(items.length)showLoadingLine(state);else showSkeleton(state);
    more.disabled=true;
    try{
      const limit=visibleLimit+(append?localContentPageSize:0);
      const page=await api.localContent(0,undefined,true,limit);
      if(revision!==version||!active)return;
      items=page.items;
      next=page.nextOffset;
      visibleLimit=limit;
      render();
      state.textContent=items.length?'':moteText('没有待发送内容');
    }catch(error){
      if(revision!==version||!active)return;
      renderReadableFailure(state,moteText('内容暂不可完整读取，重试。'),error instanceof Error?error.message:String(error));
      const retry=document.createElement('button');
      retry.type='button';retry.className='text-button';retry.textContent=moteText('重试');
      retry.addEventListener('click',()=>void refresh(append));
      state.append(' ',retry);
    }finally{
      if(revision===version){
        reading=false;
        more.disabled=false;
        if(stale)void refresh();
      }
    }
  }
  more.addEventListener('click',()=>void refresh(true));pending.addEventListener('click',()=>void refresh());document.getElementById('work-refresh')!.addEventListener('click',()=>void refresh());
  return {
    show(){active=true;void refresh();},
    hide(){active=false;version++;reading=false;},
    update(status:Status){
      const nextScope=JSON.stringify([status.authorizationGeneration,status.config.serverUrl,status.config.tokenConfigured,status.config.authSignedOut,status.config.authExpiresAt]);
      const nextQueue=JSON.stringify([status.queueDepth,status.sync.pendingRecords]);
      if(scope&&scope!==nextScope){
        version++;reading=false;stale=false;items=[];next=undefined;visibleLimit=localContentPageSize;
        render();state.replaceChildren();
        if(active)void refresh();
      }else if(queue&&queue!==nextQueue&&active){
        if(reading)stale=true;else void refresh();
      }
      scope=nextScope;queue=nextQueue;
    },
  };
}
