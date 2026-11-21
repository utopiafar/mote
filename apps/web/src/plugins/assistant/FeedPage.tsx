import {formatEvidenceRef,parseEvidenceId,type FeedItem,type FeedPage as FeedPageData,type FeedWindow} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {BookOpen,Briefcase,Building2,CircleDot,House,List as ListIcon,Newspaper,Search,Sparkles} from 'lucide-react';
import React,{useContext,useEffect,useMemo,useRef,useState} from 'react';
import {ago,errorMessage,type Api} from '../../api';
import {Loading} from '../../Loading';
import {resources} from '../../resource-cache';
import {useForegroundResources} from '../../useForegroundResources';
import {useResource} from '../../useResource';
import {NavStateContext} from '../../use-nav-state';
import {all,scoped,useAssistantCapabilities} from './common';

const windows:readonly {value:FeedWindow;label:string}[]=[
  {value:'today',label:'今天'},
  {value:'3d',label:'3 天'},
  {value:'week',label:'本周'},
  {value:'earlier',label:'更早'},
];
const feedKinds='activity,briefing,artifact,discovery';

/** Model-supplied categories are display labels, not routing rules. Known
 * prototype labels get their matching icon; anything else keeps the generic
 * activity mark. */
function FeedIcon({item}:{item:FeedItem}){
  const Icon=item.kind==='discovery'?Sparkles
    :item.category==='工作'?Briefcase
    :item.category==='生活'?House
    :item.category==='资讯'?Newspaper
    :item.category==='回顾'?BookOpen
    :CircleDot;
  return <Icon size={17} strokeWidth={1.6} aria-hidden="true"/>;
}

/** The first evidence anchor that can actually open the reader. */
function evidenceTarget(item:FeedItem){
  for(const proof of item.evidence){
    if(proof.ref)return proof.ref;
    const id=parseEvidenceId(proof.id);
    if(id)return formatEvidenceRef('capture',id);
  }
  return undefined;
}

export function FeedPage({api,onOpen}:{api:Api;onOpen:(ref:string)=>void}){
  return <FeedContent key={feedOwner(api)} api={api} onOpen={onOpen}/>;
}
const owners=new WeakMap<Api,number>();let nextOwner=0;
function feedOwner(api:Api){if(!owners.has(api))owners.set(api,++nextOwner);return owners.get(api);}

function FeedContent({api,onOpen}:{api:Api;onOpen:(ref:string)=>void}){
  const [window,setWindow]=useState<FeedWindow>('3d');
  const [unread,setUnread]=useState(false);
  const [category,setCategory]=useState<string|undefined>(undefined);
  const [search,setSearch]=useState('');
  const [query,setQuery]=useState('');
  const [grouped,setGrouped]=useState(false);
  const [pending,setPending]=useState<string|null>(null);
  const [commandError,setCommandError]=useState('');
  const pendingGuard=useRef(false);
  const revision=useContext(NavStateContext)?.revisions.cards;
  const can=useAssistantCapabilities(api);
  const canMarkRead=can('http:POST:/api/assistant-cards/:id/feedback');

  useEffect(()=>{
    const timer=setTimeout(()=>setQuery(search.trim()),250);
    return ()=>clearTimeout(timer);
  },[search]);

  const path=useMemo(()=>scoped('/api/assistant-cards',all,{
    kinds:feedKinds,window,limit:'50',tz:Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(unread?{unread:'1'}:{}),...(category?{category}:{}),...(query?{q:query}:{}),
  }),[window,unread,category,query]);
  const read=useResource<FeedPageData>(api,path,undefined,revision);
  useForegroundResources(api,[path]);
  const items=read.error===undefined?read.data?.items:undefined;
  const loading=read.loading&&read.data===undefined;
  const categories=read.error===undefined?read.data?.categories??[]:[];

  useEffect(()=>{
    if(category&&read.data&&!read.data.categories.some(entry=>entry.name===category))setCategory(undefined);
  },[category,read.data]);

  const open=async(item:FeedItem)=>{
    setCommandError('');
    if(item.kind==='discovery'){
      location.hash='#/library/insights?'+new URLSearchParams({insight:item.id});
      return;
    }
    const target=evidenceTarget(item);
    if(target)onOpen(target);
    if(item.readAt||!canMarkRead||pendingGuard.current)return;
    pendingGuard.current=true;
    setPending(item.id);
    try{
      await api.request('/api/assistant-cards/'+encodeURIComponent(item.id)+'/feedback?'+new URLSearchParams({scope:JSON.stringify(all)}),{
        method:'POST',body:JSON.stringify({expectedRevision:item.revision,action:'read'}),
      });
      resources(api).invalidate(key=>key.startsWith('/api/assistant-cards?'));
    }catch(reason){
      setCommandError(errorMessage(reason));
      if(reason&&typeof reason==='object'&&'status'in reason&&[403,404,409,410].includes(Number((reason as {status:unknown}).status)))
        resources(api).invalidate(key=>key.startsWith('/api/assistant-cards?'));
    }finally{
      pendingGuard.current=false;
      setPending(null);
    }
  };

  const groups=useMemo(()=>{
    if(!items?.length)return [];
    const bySubject=new Map<string,FeedItem[]>();
    for(const item of items){
      const subject=item.subject?.trim()??'';
      const group=bySubject.get(subject);
      if(group)group.push(item);else bySubject.set(subject,[item]);
    }
    return [...bySubject].map(([subject,group])=>({subject,items:[...group].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||(a.id<b.id?1:a.id>b.id?-1:0))}))
      .sort((a,b)=>Date.parse(b.items[0].createdAt)-Date.parse(a.items[0].createdAt));
  },[items]);

  const resetList=()=>{setCommandError('');};
  const rows=(values:FeedItem[])=>values.map(item=><FeedRow key={item.id} item={item} pending={pending===item.id} onOpen={open} canMarkRead={canMarkRead}/>);

  return <section className="feed-page" aria-busy={loading}>
    <style>{feedStyles}</style>
    <div className="feed-heading">
      <h1>{moteText('动态')}</h1>
      <div className="feed-window" role="group" aria-label={moteText('动态')}>
        {windows.map(option=><button key={option.value} type="button" data-window={option.value}
          className={window===option.value?'active':undefined} aria-pressed={window===option.value}
          onClick={()=>{setWindow(option.value);resetList();}}>{moteText(option.label)}</button>)}
        <button type="button" className={unread?'feed-unread-toggle active':'feed-unread-toggle'} aria-pressed={unread}
          onClick={()=>{setUnread(value=>!value);resetList();}}>{moteText('未读')}</button>
      </div>
    </div>
    <label className="feed-search">
      <Search size={16} aria-hidden="true"/>
      <input type="search" value={search} maxLength={200} placeholder={moteText('搜索动态')} aria-label={moteText('搜索动态')}
        onChange={event=>setSearch(event.target.value)}/>
    </label>
    <div className="feed-toolbar">
      <div className="segmented-nav feed-categories" role="group" aria-label={moteText('动态')}>
        <button type="button" className={category===undefined?'active':undefined} aria-pressed={category===undefined}
          onClick={()=>{setCategory(undefined);resetList();}}>{moteText('全部')}</button>
        {categories.map(entry=><button key={entry.name} type="button" className={category===entry.name?'active':undefined}
          aria-pressed={category===entry.name} onClick={()=>{setCategory(entry.name);resetList();}}>{entry.name} {entry.count}</button>)}
      </div>
      <div className="feed-views" role="group" aria-label={moteText('动态')}>
        <button type="button" aria-label={moteText('列表')} title={moteText('列表')} aria-pressed={!grouped}
          className={!grouped?'active':undefined} onClick={()=>setGrouped(false)}><ListIcon size={17} aria-hidden="true"/></button>
        <button type="button" aria-label={moteText('按组织')} title={moteText('按组织')} aria-pressed={grouped}
          className={grouped?'active':undefined} onClick={()=>setGrouped(true)}><Building2 size={17} aria-hidden="true"/></button>
      </div>
    </div>
    {read.error!==undefined&&read.data!==undefined&&<p className="feed-error" role="alert">{errorMessage(read.error)}
      <button type="button" className="text-button" onClick={read.refresh}>{moteText('重新读取')}</button></p>}
    {commandError&&<p className="feed-error" role="alert">{commandError}</p>}
    {loading&&<Loading/>}
    {!loading&&read.error!==undefined&&read.data===undefined&&<p className="feed-error" role="alert">{errorMessage(read.error)}
      <button type="button" className="text-button" onClick={read.refresh}>{moteText('重新读取')}</button></p>}
    {!loading&&items&&items.length===0&&<p className="feed-empty">{moteText('没有新动态')}</p>}
    {!loading&&items&&items.length>0&&(grouped
      ?<div className="feed-groups">{groups.map(group=><section key={group.subject||'other'} className="feed-group" data-feed-group={group.subject||moteText('其他')}>
        <h2>{group.subject||moteText('其他')}</h2>
        <ul>{rows(group.items)}</ul>
      </section>)}</div>
      :<ul className="feed-list">{rows(items)}</ul>)}
  </section>;
}

function FeedRow({item,pending,onOpen,canMarkRead}:{item:FeedItem;pending:boolean;onOpen:(item:FeedItem)=>void;canMarkRead:boolean}){
  const unread=item.kind!=='discovery'&&!item.readAt;
  const target=item.kind==='discovery'?'discovery':evidenceTarget(item);
  const subject=item.subject?.trim();
  const action=item.action?.trim();
  const gist=item.gist?.trim()||item.title;
  const readable=item.kind==='discovery'||Boolean(target)||canMarkRead;
  return <li className="feed-row" data-kind={item.kind} data-unread={unread} data-card-id={item.id}>
    <button type="button" className="feed-row-button" disabled={pending||!readable} aria-busy={pending}
      onClick={()=>void onOpen(item)}>
      <span className="feed-unread" data-hidden={unread?undefined:'true'} aria-hidden="true"/>
      <FeedIcon item={item}/>
      <span className="feed-row-text">
        <span className="feed-row-line">
          {subject&&<span className="feed-subject">{subject}</span>}
          {action&&<span className="feed-action">{action}</span>}
          <span className={item.kind==='discovery'||target?'feed-gist feed-link':'feed-gist'}>{gist}</span>
        </span>
      </span>
      <time className="feed-time" dateTime={item.createdAt}>{ago(item.createdAt)}</time>
    </button>
    {unread&&<span className="visually-hidden">{moteText('未读')}</span>}
  </li>;
}

const feedStyles=`
.feed-page { max-width: 980px; margin: 0 auto; }
.feed-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:18px; }
.feed-heading h1 { margin:0; font-size:var(--mote-font-title); letter-spacing:var(--mote-letter-title); }
.feed-window { display:flex; align-items:center; gap:2px; padding:3px; border-radius:var(--mote-radius-pill); background:var(--mote-surface-sunken); }
.feed-window button { min-height:32px; padding:4px 12px; border:0; border-radius:var(--mote-radius-pill); color:var(--mote-muted); background:transparent; font:inherit; font-size:var(--mote-font-action); white-space:nowrap; cursor:pointer; }
.feed-window button:hover { color:var(--mote-ink); }
.feed-window button.active { color:var(--mote-ink); background:var(--mote-surface); font-weight:600; }
.feed-window .feed-unread-toggle { margin-left:4px; }
.feed-window .feed-unread-toggle.active { color:var(--mote-accent); }
.feed-search { display:flex; align-items:center; gap:9px; min-height:46px; margin-bottom:14px; padding:0 14px; border:1px solid var(--mote-border); border-radius:var(--mote-radius-control); background:var(--mote-surface); color:var(--mote-muted); }
.feed-search:focus-within { border-color:var(--mote-accent); }
.feed-search input { flex:1; min-width:0; border:0; outline:0; background:transparent; color:var(--mote-ink); font:inherit; font-size:var(--mote-font-row); }
.feed-search input::placeholder { color:var(--mote-muted); }
.feed-toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:6px; }
.feed-categories { border:0; background:transparent; padding:0; gap:4px; }
.feed-categories button { min-height:34px; padding:5px 12px; border-radius:var(--mote-radius-pill); white-space:nowrap; }
.feed-categories button.active { background:var(--mote-ink); color:var(--mote-surface); }
.feed-views { display:flex; gap:2px; flex:none; }
.feed-views button { display:grid; place-items:center; width:34px; height:34px; border:0; border-radius:var(--mote-radius-control); background:transparent; color:var(--mote-muted); cursor:pointer; }
.feed-views button:hover { color:var(--mote-ink); }
.feed-views button.active { color:var(--mote-ink); background:var(--mote-surface-sunken); }
.feed-list,.feed-group ul { margin:0; padding:0; list-style:none; }
.feed-row { border-bottom:1px solid var(--mote-hair); }
.feed-row-button { display:grid; grid-template-columns:8px 20px minmax(0,1fr) auto; align-items:center; gap:10px; width:100%; min-height:50px; padding:11px 4px; border:0; background:transparent; color:var(--mote-ink); text-align:left; font:inherit; cursor:pointer; }
.feed-row-button:hover { background:var(--mote-surface-hover); }
.feed-row-button:disabled { cursor:default; }
.feed-unread { width:7px; height:7px; border-radius:50%; background:var(--mote-accent); }
.feed-unread[data-hidden=true] { visibility:hidden; }
.feed-row-text { min-width:0; }
.feed-row-line { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; font-size:var(--mote-font-row); line-height:1.5; }
.feed-subject { font-weight:600; }
.feed-subject::after { content:' · '; color:var(--mote-muted); font-weight:400; }
.feed-action { color:var(--mote-muted); }
.feed-action::after { content:' '; }
.feed-gist.feed-link { text-decoration:underline; text-decoration-color:var(--mote-border); text-underline-offset:3px; }
.feed-row-button:hover .feed-gist.feed-link { text-decoration-color:var(--mote-accent); }
.feed-time { color:var(--mote-muted); font-size:var(--mote-font-meta); white-space:nowrap; }
.feed-group { margin-top:22px; }
.feed-group:first-child { margin-top:8px; }
.feed-group h2 { margin:0; padding:0 4px 8px; color:var(--mote-muted); font-size:var(--mote-font-section); font-weight:600; }
.feed-empty { margin:48px 0; color:var(--mote-muted); font-size:var(--mote-font-row); }
.feed-error { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:10px 0; color:var(--mote-danger); font-size:var(--mote-font-row); }
@media (max-width:640px) {
  .feed-heading { align-items:flex-start; flex-direction:column; gap:10px; }
  .feed-window { flex-wrap:wrap; }
  .feed-toolbar { align-items:flex-start; }
  .feed-categories { flex-wrap:wrap; }
  .feed-row-button { grid-template-columns:7px 18px minmax(0,1fr); row-gap:3px; }
  .feed-time { grid-column:3; justify-self:start; }
}
`;
