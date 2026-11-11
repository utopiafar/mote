import {renderReadableFailure} from './ui-diagnostic';
import {moteText,getLocale} from '@mote/shared/i18n';
import type {DesktopApi,Status} from './contracts';
import type {ContentItem} from './contracts/content';
import {showSkeleton,showLoadingLine} from './loading-ui';

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
  let version=0,active=false,next:number|undefined,reading=false,scope='',items:ContentItem[]=[];
  function render(){list.replaceChildren();for(const item of items){const row=document.createElement('button');row.type='button';row.className='content-row home-content-row';const icon=document.createElement('span');icon.className='home-content-symbol';icon.setAttribute('aria-hidden','true');icon.textContent=({note:'✎',screen:'▧',ui_page:'▤',activity:'◷',notification:'◌',media:'♫',file:'▤',calendar:'▦',coding:'⌘'} as Partial<Record<ContentItem['source'],string>>)[item.source]??'▤';const copy=document.createElement('span'),title=document.createElement('strong'),meta=document.createElement('small'),status=document.createElement('span');title.textContent=item.title;meta.textContent=[item.sourceName,new Date(item.observedAt).toLocaleString(getLocale())].filter(Boolean).join(' · ');copy.className='content-row-copy';copy.append(title,meta);status.className=item.error?'content-state needs-attention':'content-state';status.textContent=item.error?moteText('需要处理'):moteText('本机待发送');const arrow=document.createElement('span');arrow.className='chevron';arrow.setAttribute('aria-hidden','true');arrow.textContent='›';row.append(icon,copy,status,arrow);row.addEventListener('click',()=>open(item));list.append(row);}more.hidden=next===undefined;}
  async function refresh(append=false){if(!active||reading)return;const revision=++version;reading=true;if(items.length)showLoadingLine(state);else showSkeleton(state);more.disabled=true;
    try{const page=await api.localContent(append?next:0);if(revision!==version||!active)return;items=append?[...items,...page.items]:page.items;next=page.nextOffset;render();state.textContent=items.length?'':moteText('没有待发送内容');}
    catch(error){if(revision===version&&active)renderReadableFailure(state,moteText('内容暂不可完整读取，请重试。'),error instanceof Error?error.message:String(error));}
    finally{if(revision===version){reading=false;more.disabled=false;}}
  }
  more.addEventListener('click',()=>void refresh(true));pending.addEventListener('click',()=>void refresh());document.getElementById('work-refresh')!.addEventListener('click',()=>void refresh());
  return {show(){active=true;void refresh();},hide(){active=false;version++;reading=false;},update(status:Status){const nextScope=JSON.stringify([status.authorizationGeneration,status.config.serverUrl,status.config.tokenConfigured,status.queueDepth,status.sync.pendingRecords]);if(scope&&scope!==nextScope){version++;reading=false;items=[];list.replaceChildren();if(active)void refresh();}scope=nextScope;}};
}
