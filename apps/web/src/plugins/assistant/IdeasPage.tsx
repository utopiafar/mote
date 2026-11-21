import {
  CHAT_ABOUT_PARAM,formatAboutRef,pageHash,
  type AboutRef,type IdeaItem,type IdeasView,type QueryScope,type StartedIdea,
} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {CircleCheck,CircleHelp,ClipboardList,Lightbulb,LoaderCircle,Search,X} from 'lucide-react';
import React,{useContext,useState} from 'react';
import {ApiError,errorMessage,type Api} from '../../api';
import {Loading} from '../../Loading';
import {resources} from '../../resource-cache';
import {NavStateContext} from '../../use-nav-state';
import {useForegroundResources} from '../../useForegroundResources';
import {useResource} from '../../useResource';
import {all,scoped,taskLabel} from './common';

type Filter='all'|'yours'|'mine'|'started';
const ideaPath=scoped('/api/assistant/ideas',all);

/** A chat link carries only one typed reference; the chat reads it as scope.
 * CH2 will host this helper once its page exists. */
const chatHref=(ref:AboutRef)=>pageHash('chat',{[CHAT_ABOUT_PARAM]:formatAboutRef(ref)});
const aboutFor=(item:IdeaItem):AboutRef=>item.source==='owner-question'?{kind:'question',id:item.id}:{kind:'card',id:item.id};

function ideaIcon(item:IdeaItem){
  return item.source==='owner-question'||item.kind==='question'?CircleHelp
    :item.kind==='needs-info'?CircleHelp:Lightbulb;
}

export function IdeasPage({api,refresh}:{api:Api;refresh:()=>void}){
  const [filter,setFilter]=useState<Filter>('all');
  const [search,setSearch]=useState('');
  const [busy,setBusy]=useState<string|null>(null);
  const [commandError,setCommandError]=useState('');
  const revision=useContext(NavStateContext)?.revisions.cards;
  const read=useResource<IdeasView>(api,ideaPath,undefined,revision);
  useForegroundResources(api,[ideaPath]);
  const view=read.error===undefined?read.data:undefined;
  const loading=read.loading&&read.data===undefined;
  const mine=view?.mine??[],yours=view?.yours??[],started=view?.started??[];
  const counts={all:mine.length+yours.length+started.length,yours:yours.length,mine:mine.length,started:started.length};

  const afterCommand=()=>{
    resources(api).invalidate(key=>key.startsWith('/api/assistant/ideas'));
    refresh();
  };
  const run=async(key:string,command:()=>Promise<unknown>)=>{
    if(busy)return;
    setCommandError('');setBusy(key);
    try{await command();afterCommand();}
    catch(reason){
      setCommandError(errorMessage(reason));
      if(reason instanceof ApiError&&[403,404,409,410].includes(reason.status)){
        resources(api).invalidate(key=>key.startsWith('/api/assistant/ideas'));
        refresh();
      }
    }finally{setBusy(null);}
  };
  const start=(item:IdeaItem)=>run(item.id,async()=>{
    const card=await api.request<{taskScope:QueryScope|null}>('/api/assistant-cards/'+encodeURIComponent(item.id)+'?'+new URLSearchParams({scope:JSON.stringify(all)}));
    if(!card.taskScope)throw new ApiError(moteText('这张卡片暂时不能开始。'),409);
    await api.request('/api/assistant/tasks',{method:'POST',body:JSON.stringify({
      cardId:item.id,expectedRevision:item.revision,requestId:crypto.randomUUID(),goal:item.title,scope:card.taskScope,
    })});
  });
  const feedback=(item:IdeaItem,action:'later'|'ignore')=>run(item.id,async()=>{
    const until=new Date();
    until.setDate(until.getDate()+1);until.setHours(9,0,0,0);
    await api.request('/api/assistant-cards/'+encodeURIComponent(item.id)+'/feedback?'+new URLSearchParams({scope:JSON.stringify(all)}),{
      method:'POST',body:JSON.stringify({expectedRevision:item.revision,action,...(action==='later'?{until:until.toISOString()}:{})}),
    });
  });
  const ignoreAll=()=>view&&run('all',()=>api.request('/api/assistant/ideas/ignore-all',{
    method:'POST',body:JSON.stringify({upToSeq:view.watermark}),
  }));

  const needle=search.trim().toLocaleLowerCase();
  const visible=(items:IdeaItem[])=>!needle?items:items.filter(item=>(item.title+' '+(item.detail??'')).toLocaleLowerCase().includes(needle));
  const visibleStarted=(items:StartedIdea[])=>!needle?items:items.filter(item=>item.title.toLocaleLowerCase().includes(needle));
  const shown:Array<{group:'yours'|'mine'|'started';item:IdeaItem|StartedIdea}>=[
    ...(filter==='all'||filter==='yours'?visible(yours).map(item=>({group:'yours' as const,item})):[]),
    ...(filter==='all'||filter==='mine'?visible(mine).map(item=>({group:'mine' as const,item})):[]),
    ...(filter==='all'||filter==='started'?visibleStarted(started).map(item=>({group:'started' as const,item})):[]),
  ];

  return <section className="ideas-page" aria-busy={loading}>
    <style>{ideaStyles}</style>
    <div className="ideas-heading">
      <h1>{moteText('点子')}</h1>
      <button type="button" className="text-button ideas-ignore-all" disabled={!view||view.watermark===0||busy!==null} onClick={()=>void ignoreAll()}>
        {moteText('全部忽略')}
      </button>
    </div>
    <label className="ideas-search">
      <Search size={16} aria-hidden="true"/>
      <input type="search" value={search} maxLength={200} placeholder={moteText('搜索点子')} aria-label={moteText('搜索点子')}
        onChange={event=>setSearch(event.target.value)}/>
    </label>
    <div className="ideas-filters" role="group" aria-label={moteText('点子')}>
      {(['all','yours','mine','started'] as const).map(value=><button key={value} type="button" data-filter={value}
        className={filter===value?'active':undefined} aria-pressed={filter===value}
        onClick={()=>setFilter(value)}>
        {moteText(value==='all'?'全部':value==='yours'?'需要你':value==='mine'?'我来做':'已开始')} {counts[value]}
      </button>)}
    </div>
    {read.error!==undefined&&read.data!==undefined&&<p className="ideas-error" role="alert">{errorMessage(read.error)}
      <button type="button" className="text-button" onClick={read.refresh}>{moteText('重新读取')}</button></p>}
    {commandError&&<p className="ideas-error" role="alert">{commandError}</p>}
    {loading&&<Loading/>}
    {!loading&&read.error!==undefined&&read.data===undefined&&<p className="ideas-error" role="alert">{errorMessage(read.error)}
      <button type="button" className="text-button" onClick={read.refresh}>{moteText('重新读取')}</button></p>}
    {!loading&&view&&shown.length===0&&<p className="ideas-empty">{moteText('没有新点子')}</p>}
    {!loading&&shown.length>0&&<ul className="ideas-list">
      {shown.map(({group,item})=>group==='started'
        ?<StartedRow key={(item as StartedIdea).taskId} item={item as StartedIdea}/>
        :<IdeaRow key={(item as IdeaItem).id} item={item as IdeaItem} busy={busy!==null} pending={busy===(item as IdeaItem).id}
          onStart={()=>void start(item as IdeaItem)} onLater={()=>void feedback(item as IdeaItem,'later')}
          onIgnore={()=>void feedback(item as IdeaItem,'ignore')}/>)}
    </ul>}
  </section>;
}

function IdeaRow({item,busy,pending,onStart,onLater,onIgnore}:{item:IdeaItem;busy:boolean;pending:boolean;onStart:()=>void;onLater:()=>void;onIgnore:()=>void}){
  const [active,setActive]=useState(false);
  const Icon=ideaIcon(item);
  const actions=item.actions;
  return <li className="idea-row" data-idea-source={item.source} data-idea-kind={item.kind} data-card-id={item.id}
    data-actions={active?'visible':undefined}
    onMouseEnter={()=>setActive(true)} onMouseLeave={()=>setActive(false)}
    onFocusCapture={()=>setActive(true)}
    onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setActive(false);}}>
    <Icon className="idea-icon" size={17} strokeWidth={1.6} aria-hidden="true"/>
    <span className="idea-text">
      <span className="idea-title">{item.title}</span>
      {item.detail&&<span className="idea-detail">{item.detail}</span>}
    </span>
    <span className="idea-meta">
      {actions.includes('answer')&&<a className="idea-answer" href={chatHref(aboutFor(item))}>{moteText('回答')}</a>}
      <span className="idea-actions">
        {actions.includes('start')&&<button type="button" className="idea-start" disabled={busy} onClick={onStart}>{moteText('开始')}</button>}
        {actions.includes('later')&&<button type="button" className="idea-later" disabled={busy} onClick={onLater}>{moteText('稍后')}</button>}
        {actions.includes('ignore')&&<button type="button" className="idea-ignore" aria-label={moteText('忽略')} title={moteText('忽略')} disabled={busy} onClick={onIgnore}><X size={15} aria-hidden="true"/></button>}
        {pending&&<LoaderCircle className="spin" size={14} aria-hidden="true"/>}
      </span>
    </span>
  </li>;
}

function StartedRow({item}:{item:StartedIdea}){
  return <li className="idea-row" data-idea="started" data-task-id={item.taskId}>
    <ClipboardList className="idea-icon" size={17} strokeWidth={1.6} aria-hidden="true"/>
    <span className="idea-text">
      <span className="idea-title">{item.title}</span>
      <span className="idea-detail">{moteText('已开始')} · {item.progress??taskLabel(item.state)}</span>
    </span>
    <span className="idea-meta"><CircleCheck className="idea-check" size={18} strokeWidth={1.8} aria-hidden="true"/>
      <span className="visually-hidden">{moteText('已开始')}</span></span>
  </li>;
}

const ideaStyles=`
.ideas-page { max-width: 980px; margin: 0 auto; }
.ideas-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:18px; }
.ideas-heading h1 { margin:0; font-size:var(--mote-font-title); letter-spacing:var(--mote-letter-title); }
.ideas-search { display:flex; align-items:center; gap:9px; min-height:46px; margin-bottom:14px; padding:0 14px; border:1px solid var(--mote-border); border-radius:var(--mote-radius-control); background:var(--mote-surface); color:var(--mote-muted); }
.ideas-search:focus-within { border-color:var(--mote-accent); }
.ideas-search input { flex:1; min-width:0; border:0; outline:0; background:transparent; color:var(--mote-ink); font:inherit; font-size:var(--mote-font-row); }
.ideas-search input::placeholder { color:var(--mote-muted); }
.ideas-filters { display:flex; flex-wrap:wrap; align-items:center; gap:4px; margin-bottom:6px; }
.ideas-filters button { min-height:34px; padding:5px 12px; border:0; border-radius:var(--mote-radius-pill); background:transparent; color:var(--mote-muted); font:inherit; font-size:var(--mote-font-action); white-space:nowrap; cursor:pointer; }
.ideas-filters button:hover { color:var(--mote-ink); }
.ideas-filters button.active { background:var(--mote-ink); color:var(--mote-surface); }
.ideas-list { margin:0; padding:0; list-style:none; }
.idea-row { display:grid; grid-template-columns:20px minmax(0,1fr) auto; align-items:center; gap:10px; min-height:52px; padding:10px; border-bottom:1px solid var(--mote-hair); border-radius:var(--mote-radius-control); }
.idea-row:hover,.idea-row:focus-within { background:var(--mote-surface-hover); }
.idea-icon { color:var(--mote-muted); }
.idea-text { min-width:0; display:flex; flex-direction:column; gap:3px; }
.idea-title { font-size:var(--mote-font-row); line-height:1.5; }
.idea-detail { color:var(--mote-muted); font-size:var(--mote-font-meta); line-height:1.5; }
.idea-meta { display:flex; align-items:center; gap:6px; min-height:32px; }
.idea-answer { color:var(--mote-accent); font-size:var(--mote-font-action); text-decoration:none; white-space:nowrap; }
.idea-answer:hover { text-decoration:underline; text-underline-offset:3px; }
.idea-check { color:var(--mote-success); }
.idea-actions { display:flex; align-items:center; gap:4px; opacity:0; pointer-events:none; }
.idea-row[data-actions="visible"] .idea-actions { opacity:1; pointer-events:auto; }
.idea-actions button { display:inline-flex; align-items:center; justify-content:center; min-height:30px; padding:3px 8px; border:0; border-radius:var(--mote-radius-control); background:transparent; color:var(--mote-ink); font:inherit; font-size:var(--mote-font-action); cursor:pointer; }
.idea-actions button:hover { background:var(--mote-surface-sunken); }
.idea-actions .idea-start { min-width:56px; background:var(--mote-primary-background); color:var(--mote-primary-ink); }
.idea-actions .idea-start:hover { background:var(--mote-primary-hover); }
.idea-actions .idea-ignore { width:30px; padding:0; color:var(--mote-muted); }
.idea-actions button:disabled { opacity:.5; cursor:default; }
.ideas-empty { margin:48px 0; color:var(--mote-muted); font-size:var(--mote-font-row); }
.ideas-error { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:10px 0; color:var(--mote-danger); font-size:var(--mote-font-row); }
@media (max-width:640px) {
  .ideas-heading { align-items:flex-start; flex-direction:column; gap:10px; }
  .idea-row { grid-template-columns:18px minmax(0,1fr); row-gap:4px; }
  .idea-meta { grid-column:2; justify-self:start; }
}
`;
