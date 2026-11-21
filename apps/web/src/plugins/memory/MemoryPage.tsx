import React,{useContext,useEffect,useMemo,useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {Check,Circle,CircleAlert,CircleHelp,FolderHeart,LoaderCircle,RefreshCw,Search,Sparkles,Star,UserRound} from 'lucide-react';
import {errorMessage,type Api} from '../../api';
import {NavStateContext} from '../../use-nav-state';
import {useResource} from '../../useResource';
import {ManualMemoryWorkspace,installMemoryWorkspaceStyles} from './ManualMemoryWorkspace';
import {MemoryDetailPage,type Memory} from './Memories';
import {useMemoryJob} from './MemoryProgress';
import {refreshMemoryResources} from './memory-resources';

type Filter='all'|'standing'|'people'|'matters'|'preference'|'proposed';
type Page<T>={items:T[];nextCursor:string|null};
interface Commitment {
  id:string;
  personMemoryId:string|null;
  matterId:string|null;
  evidenceDependencies:{version:1;complete:true;ids:string[]};
}
interface ChatCard {ref:string;title:string;snippet?:string;kind?:string;status?:string}

const filters:readonly Filter[]=['all','standing','people','matters','preference','proposed'];
function filterLabel(id:Filter){
  return id==='all'?moteText('全部'):id==='standing'?moteText('常驻'):id==='people'?moteText('人物')
    :id==='matters'?moteText('事项'):id==='preference'?moteText('偏好'):moteText('待确认');
}

function newIdentifier(){return globalThis.crypto.randomUUID();}
function memoryPath(query:string,cursor?:string){
  return '/api/memories?'+new URLSearchParams({
    level:'detail',includeHistory:'false',includeStale:'false',layer:'memory',limit:'100',
    ...(query?{query}:{}),...(cursor?{cursor}:{}),
  });
}
function chatPath(query:string){
  return '/api/context/search?'+new URLSearchParams({query,limit:'30'});
}
function commitmentsPath(){
  return '/api/assistant/commitments?'+new URLSearchParams({scope:JSON.stringify({kind:'all'}),limit:'100'});
}

const owners=new WeakMap<Api,number>();let nextOwner=0;
function ownerKey(api:Api){let key=owners.get(api);if(key===undefined){key=++nextOwner;owners.set(api,key);}return key;}

/** The Memory page groups the existing owner reads into the prototype's
 * standing/person/matter/preference/pending views. Person and matter
 * membership comes from stored commitment references; it is never inferred
 * from prose. */
export function MemoryPage({api,onOpen}:{api:Api;onOpen:(ref:string)=>void}){
  return <MemoryPageOwner key={ownerKey(api)} api={api} onOpen={onOpen}/>;
}

function MemoryPageOwner({api,onOpen}:{api:Api;onOpen:(ref:string)=>void}){
  const state=useContext(NavStateContext);
  const revision=state?.revisions.memory,commitmentRevision=state?.revisions.commitments;
  const [draft,setDraft]=useState('');
  const [search,setSearch]=useState('');
  const [query,setQuery]=useState('');
  const [cursor,setCursor]=useState<string|undefined>();
  const [filter,setFilter]=useState<Filter>('all');
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [online,setOnline]=useState(()=>typeof navigator==='undefined'||navigator.onLine!==false);
  const [quick,setQuick]=useState<{text:string;noteId:string;jobId?:string;state:'saving'|'running'|'saved'|'failed'}>();
  const [manualEvidence,setManualEvidence]=useState<string[]>([]);
  const [manualMemoryIds,setManualMemoryIds]=useState<string[]>([]);
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const [pending,setPending]=useState<{id:string;action:'confirm'|'deny'}>();
  const [work,setWork]=useState<{token:number;open:boolean}>();
  const request=useRef<AbortController|undefined>(undefined);
  const alive=useRef(true);

  useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();};},[]);
  useEffect(()=>{if(typeof window==='undefined')return;const change=()=>setOnline(navigator.onLine!==false);window.addEventListener('online',change);window.addEventListener('offline',change);return()=>{window.removeEventListener('online',change);window.removeEventListener('offline',change);};},[]);
  useEffect(()=>{if(work?.open)installMemoryWorkspaceStyles();},[work?.open]);

  const list=useResource<Page<Memory>>(api,memoryPath('',cursor),undefined,revision);
  const commitments=useResource<Page<Commitment>>(api,commitmentsPath(),10000,commitmentRevision);
  const memorySearch=useResource<Page<Memory>>(api,query?memoryPath(query):null,undefined,revision);
  const chatSearch=useResource<Page<ChatCard>>(api,query?chatPath(query):null);
  const {job}=useMemoryJob(api,quick?.jobId);
  const items=useMemo(()=>list.error===undefined?list.data?.items??[]:[],[list.data,list.error]);
  const personIds=useMemo(()=>new Set((commitments.data?.items??[]).flatMap(item=>item.personMemoryId?[item.personMemoryId]:[])),[commitments.data]);
  const matterEvidence=useMemo(()=>new Set((commitments.data?.items??[]).filter(item=>item.matterId).flatMap(item=>item.evidenceDependencies.ids)),[commitments.data]);

  const typeOf=useMemo(()=>{
    const classify=(item:Memory):Filter=>item.status==='proposed'?'proposed'
      :item.contextPriority==='standing'?'standing'
      :personIds.has(item.id)?'people'
      :item.coding?.kind==='preference'?'preference'
      :item.evidenceIds?.some(id=>matterEvidence.has(id))?'matters':'all';
    return classify;
  },[personIds,matterEvidence]);
  const counts=useMemo(()=>{
    const values:Record<Filter,number>={all:items.length,standing:0,people:0,matters:0,preference:0,proposed:0};
    for(const item of items){const type=typeOf(item);if(type!=='all')values[type]++;}return values;
  },[items,typeOf]);
  const filtered=useMemo(()=>filter==='all'?items:items.filter(item=>typeOf(item)===filter),[items,filter,typeOf]);

  useEffect(()=>{if(!quick?.noteId||!job)return;if(job.status==='completed'){setManualMemoryIds(ids=>[...new Set([...ids,...job.memoryIds])]);setQuick(value=>value?{...value,state:'saved'}:value);refreshMemoryResources(api);}else if(job.status==='failed'||job.status==='cancelled'){setQuick(value=>value?{...value,state:'failed'}:value);}},[api,quick?.noteId,job?.id,job?.status]);
  useEffect(()=>{if(quick?.state!=='saved')return;const timer=setTimeout(()=>setQuick(undefined),1200);return()=>clearTimeout(timer);},[quick?.state]);
  useEffect(()=>{if(selectedId&&!items.some(item=>item.id===selectedId)&&list.data!==undefined&&!list.loading){const found=(memorySearch.data?.items??[]).some(item=>item.id===selectedId);if(!found)setSelectedId(null);}},[items,list.data,list.loading,memorySearch.data,selectedId]);

  const refresh=()=>{setError('');refreshMemoryResources(api,true);list.refresh();commitments.refresh();memorySearch.refresh();chatSearch.refresh();};
  const open=(id:string)=>{setError('');setNotice('');setSelectedId(id);};
  const clearSearch=()=>{setSearch('');setQuery('');};

  async function remember(event:React.FormEvent){
    event.preventDefault();
    const text=draft.trim(),value=text.replace(/\s+/g,' ');
    if(!value||request.current)return;
    const controller=new AbortController();request.current=controller;
    const noteId=newIdentifier(),at=new Date().toISOString();
    setQuick({text:value,noteId,state:'saving'});setError('');setNotice('');
    try{
      const saved=await api.request<{id?:string}>(`/api/notes`,{method:'POST',signal:controller.signal,body:JSON.stringify({
        client:'web',id:noteId,deviceId:'mote-web',deviceName:'Mote Web',platform:'import',capturedAt:at,text:value,
        metadata:{version:1,observedAt:at,collector:{method:'manual'},noteOrigin:{kind:'manual',text:value}},
      })});
      if(saved?.id!==noteId)throw Error(moteText('中央响应格式无效，请刷新后重试。'));
      setManualEvidence(ids=>[...new Set([...ids,noteId])]);
      const created=await api.request<{id?:string}>(`/api/memory-jobs`,{method:'POST',signal:controller.signal,body:JSON.stringify({evidenceIds:[noteId],timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone})});
      if(!created?.id)throw Error(moteText('中央响应格式无效，请刷新后重试。'));
      if(!alive.current||controller.signal.aborted)return;
      setDraft('');
      setCursor(undefined);
      setQuick({text:value,noteId,jobId:created.id,state:'running'});
      setNotice(moteText('已记住'));
      refresh();
    }catch(caught){
      if(!controller.signal.aborted&&alive.current){setQuick(value=>value?{...value,state:'failed'}:undefined);setError(errorMessage(caught));}
    }finally{if(request.current===controller)request.current=undefined;}
  }

  async function decide(item:Memory,action:'confirm'|'deny'){
    if(pending)return;
    setPending({id:item.id,action});setError('');setNotice('');
    try{
      if(action==='confirm')await api.request(`/api/memories/${encodeURIComponent(item.id)}/publish`,{method:'POST',body:JSON.stringify({version:item.version??1})});
      else await api.request(`/api/memories/${encodeURIComponent(item.id)}`,{method:'DELETE'});
      if(!alive.current)return;
      setNotice(action==='confirm'?moteText('已确认'):moteText('已标为不对'));
      refreshMemoryResources(api,true);list.refresh();memorySearch.refresh();
    }catch(caught){if(alive.current)setError(errorMessage(caught));}
    finally{if(alive.current)setPending(undefined);}
  }

  if(selectedId)return <MemoryDetailPage api={api} id={selectedId} scope={{}} onOpen={onOpen} onBack={()=>setSelectedId(null)}/>;

  const showSearch=Boolean(query);
  const memoryResults=memorySearch.error===undefined?memorySearch.data?.items??[]:[];
  const chatResults=(chatSearch.error===undefined?chatSearch.data?.items??[]:[]).filter(item=>!item.kind||item.kind==='message');
  const searchBusy=memorySearch.loading||chatSearch.loading;
  const visible=showSearch?memoryResults.filter(item=>filter==='all'||typeOf(item)===filter):filtered;
  const count=(id:Filter)=>String(counts[id])+(items.length&&list.data?.nextCursor&&id!=='all'?'+':'');
  const rowManual=(item:Memory)=>Boolean(item.correction)||manualMemoryIds.includes(item.id)||(item.evidenceIds??[]).some(id=>manualEvidence.includes(id));
  const quickLabel=quick?.state==='failed'?moteText('整理失败'):quick?.state==='saved'?moteText('已记住'):moteText('正在整理');

  return <section className="memory-page" aria-busy={list.loading&&list.data===undefined}>
    <style>{styles}</style>
    {work?.open?<ManualMemoryWorkspace api={api} active launch={{api,token:work.token,kind:'integrate'}} range={{}} onClose={()=>setWork(undefined)} onOpen={onOpen} onViewMemory={id=>{setWork(undefined);open(id);}}/>:<>
      <header className="memory-page-heading">
        <h1>{moteText('记忆')}</h1>
        <button type="button" className="text-button memory-page-tidy" onClick={()=>setWork({token:Date.now(),open:true})}><RefreshCw size={14}/>{moteText('重新整理')}</button>
      </header>
      <form className="memory-remember" onSubmit={event=>void remember(event)}>
        <label className="visually-hidden" htmlFor="memory-remember-input">{moteText('记住一件事')}</label>
        <input id="memory-remember-input" value={draft} onChange={event=>setDraft(event.target.value)} placeholder={moteText('记住一件事')} aria-label={moteText('记住一件事')} maxLength={500} autoComplete="off"/>
        <button className="button" type="submit" disabled={quick?.state==='saving'||quick?.state==='running'||!draft.trim()}>{quick?.state==='saving'||quick?.state==='running'?<LoaderCircle size={15} className="spin"/>:null}{moteText('记住')}</button>
      </form>
      <form className="memory-page-search" role="search" onSubmit={event=>{event.preventDefault();setQuery(search.trim());}}>
        <Search size={16} aria-hidden="true"/>
        <label className="visually-hidden" htmlFor="memory-page-search-input">{moteText('搜索记忆和聊天')}</label>
        <input id="memory-page-search-input" type="search" value={search} onChange={event=>setSearch(event.target.value)} placeholder={moteText('搜索记忆和聊天')} aria-label={moteText('搜索记忆和聊天')} maxLength={500} autoComplete="off"/>
        {query&&<button type="button" className="text-button" onClick={clearSearch}>{moteText('清除筛选')}</button>}
      </form>
      <nav className="memory-page-filters" aria-label={moteText('记忆')}>
        {filters.map(item=><button key={item} type="button" className={filter===item?'active':undefined} aria-pressed={filter===item} onClick={()=>setFilter(item)}>{filterLabel(item)} <span>{count(item)}</span></button>)}
      </nav>
      {!online&&<p className="notice" role="status">{moteText('当前离线')} <button type="button" className="text-button" onClick={refresh}>{moteText('重新读取')}</button></p>}
      {commitments.error!==undefined&&<p className="notice" role="status">{errorMessage(commitments.error)} <button type="button" className="text-button" onClick={commitments.refresh}>{moteText('重新读取')}</button></p>}
      {error&&<p className="error-banner" role="alert">{error} <button type="button" className="text-button" onClick={refresh}>{moteText('重新读取')}</button></p>}
      {notice&&<p className="notice" role="status">{notice}</p>}
      {quick&&<article className="memory-page-quick" data-state={quick.state}>
        {quick.state==='failed'?<CircleAlert size={16}/>:quick.state==='saved'?<Check size={16}/>:<LoaderCircle size={16} className="spin"/>}
        <span><strong>{quick.text}</strong><small>{moteText('手动')} · {quickLabel}</small></span>
      </article>}
      {list.loading&&list.data===undefined&&<p className="memory-page-empty" role="status">{moteText('正在读取…')}</p>}
      {list.error!==undefined&&list.data===undefined&&<div className="memory-page-empty" role="alert"><p>{errorMessage(list.error)}</p><button type="button" className="text-button" onClick={list.refresh}>{moteText('重新读取')}</button></div>}
      {list.error!==undefined&&list.data!==undefined&&<p className="notice" role="alert">{errorMessage(list.error)} <button type="button" className="text-button" onClick={list.refresh}>{moteText('重新读取')}</button></p>}
      {!showSearch&&list.error===undefined&&list.data!==undefined&&visible.length===0&&<p className="memory-page-empty">{items.length?moteText('没有这类记忆'):moteText('还没有记忆')}</p>}
      {!showSearch&&visible.map(item=><MemoryRow key={item.id} item={item} type={typeOf(item)} manual={rowManual(item)} pending={pending?.id===item.id?pending.action:undefined} onOpen={()=>open(item.id)} onConfirm={()=>void decide(item,'confirm')} onDeny={()=>void decide(item,'deny')}/>)}
      {!showSearch&&(cursor||list.data?.nextCursor)&&<div className="memory-page-next">
        {cursor&&<button type="button" className="text-button" onClick={()=>setCursor(undefined)}>{moteText('返回第一页')}</button>}
        {list.data?.nextCursor&&<button type="button" className="text-button" onClick={()=>setCursor(list.data!.nextCursor!)}>{moteText('下一页')}</button>}
      </div>}
      {showSearch&&<><section className="memory-page-group" aria-label={moteText('记忆')}>
        <h2>{moteText('记忆')}</h2>
        {searchBusy&&!memorySearch.data&&<p className="memory-page-empty" role="status">{moteText('正在读取…')}</p>}
        {memorySearch.error!==undefined&&<p className="notice" role="alert">{errorMessage(memorySearch.error)} <button type="button" className="text-button" onClick={memorySearch.refresh}>{moteText('重新读取')}</button></p>}
        {memorySearch.error===undefined&&memorySearch.data!==undefined&&visible.length===0&&<p className="memory-page-empty">{moteText('没有这类记忆')}</p>}
        {visible.map(item=><MemoryRow key={item.id} item={item} type={typeOf(item)} manual={rowManual(item)} pending={pending?.id===item.id?pending.action:undefined} onOpen={()=>open(item.id)} onConfirm={()=>void decide(item,'confirm')} onDeny={()=>void decide(item,'deny')}/>)}
      </section><section className="memory-page-group" aria-label={moteText('聊天')}>
        <h2>{moteText('聊天')}</h2>
        {searchBusy&&!chatSearch.data&&<p className="memory-page-empty" role="status">{moteText('正在读取…')}</p>}
        {chatSearch.error!==undefined&&<p className="notice" role="alert">{errorMessage(chatSearch.error)} <button type="button" className="text-button" onClick={chatSearch.refresh}>{moteText('重新读取')}</button></p>}
        {chatSearch.error===undefined&&chatSearch.data!==undefined&&chatResults.length===0&&<p className="memory-page-empty">{moteText('没有这类记忆')}</p>}
        {chatResults.map(item=><button key={item.ref} type="button" className="memory-page-chat" onClick={()=>onOpen(item.ref)}><Search size={14} aria-hidden="true"/><span><strong>{item.title}</strong>{item.snippet&&<small>{item.snippet}</small>}</span></button>)}
      </section></>}
    </>}
  </section>;
}

function MemoryRow({item,type,manual,pending,onOpen,onConfirm,onDeny}:{item:Memory;type:Filter;manual:boolean;pending?:'confirm'|'deny';onOpen:()=>void;onConfirm:()=>void;onDeny:()=>void}){
  const Icon=type==='people'?UserRound:type==='matters'?FolderHeart:type==='standing'?Star:type==='preference'?Sparkles:type==='proposed'?CircleHelp:Circle;
  const label=({all:'',standing:moteText('常驻'),people:moteText('人物'),matters:moteText('事项'),preference:moteText('偏好'),proposed:moteText('待确认')} as const)[type];
  const stale=item.status==='stale';
  const count=item.evidenceCount??item.evidenceIds?.length??item.evidence?.length??0;
  const inferred=item.admission?.attribution==='inferred';
  return <article className="memory-page-row" data-type={type}>
    <button type="button" className="memory-page-row-main" onClick={onOpen}>
      <Icon size={18} strokeWidth={1.6} aria-hidden="true"/>
      <span className="memory-page-row-copy">
        <strong>{item.title}{stale&&<small className="memory-page-state">{moteText('需要重验')}</small>}</strong>
        {!stale&&item.statement&&<span>{item.statement}</span>}
        <small>{inferred&&moteText('推断')}{inferred&&(count>0||manual)?' · ':''}{count>0&&moteText('{0} 份依据',count)}{count>0&&manual?' · ':''}{manual&&moteText('手动')}</small>
      </span>
      {label&&type!=='proposed'&&<span className="memory-page-kind">{label}</span>}
    </button>
    {type==='proposed'&&<div className="memory-page-pending">
      <button type="button" className="button" disabled={Boolean(pending)} onClick={onConfirm}>{pending==='confirm'?<LoaderCircle size={14} className="spin"/>:null}{moteText('确认')}</button>
      <button type="button" className="text-button" disabled={Boolean(pending)} onClick={onDeny}>{moteText('不对')}</button>
    </div>}
  </article>;
}

const styles=`
.memory-page{max-width:980px;margin:0 auto}
.memory-page-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 22px}
.memory-page-heading h1{margin:0;font-size:var(--mote-font-title);letter-spacing:var(--mote-letter-title);font-weight:var(--mote-weight-title)}
.memory-page-tidy{display:inline-flex;align-items:center;gap:6px;flex:none;color:var(--mote-muted);font-size:var(--mote-font-action)}
.memory-remember{display:flex;align-items:center;gap:12px;margin:0 0 12px;padding:8px 8px 8px 17px;border:1px solid var(--mote-control-border);border-radius:var(--mote-radius-container);background:var(--mote-surface)}
.memory-remember:focus-within{border-color:var(--mote-accent)}
.memory-remember input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--mote-ink);font:inherit;font-size:var(--mote-font-row);line-height:1.8}
.memory-remember input::placeholder{color:var(--mote-muted)}
.memory-remember .button{flex:none;display:inline-flex;align-items:center;gap:6px}
.memory-page-search{display:flex;align-items:center;gap:9px;min-height:46px;margin:0 0 16px;padding:0 14px;border:1px solid var(--mote-border);border-radius:var(--mote-radius-control);background:var(--mote-surface);color:var(--mote-muted)}
.memory-page-search:focus-within{border-color:var(--mote-accent)}
.memory-page-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--mote-ink);font:inherit;font-size:var(--mote-font-row)}
.memory-page-search input::placeholder{color:var(--mote-muted)}
.memory-page-filters{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 10px}
.memory-page-filters button{min-height:34px;padding:5px 13px;border:0;border-radius:var(--mote-radius-pill);background:var(--mote-sidebar);color:var(--mote-ink);font:inherit;font-size:var(--mote-font-action);cursor:pointer;white-space:nowrap}
.memory-page-filters button:hover{background:var(--mote-surface-hover)}
.memory-page-filters button.active{background:var(--mote-ink);color:var(--mote-surface)}
.memory-page-filters button span{opacity:.65;margin-left:2px}
.memory-page-row{display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--mote-hair)}
.memory-page-row-main{display:grid;grid-template-columns:22px minmax(0,1fr) auto;align-items:start;gap:12px;flex:1;min-width:0;padding:18px 4px;border:0;background:transparent;color:var(--mote-ink);text-align:left;font:inherit;cursor:pointer}
.memory-page-row-main>svg{color:var(--mote-muted);margin-top:2px}
.memory-page-row-copy{display:flex;flex-direction:column;gap:4px;min-width:0}
.memory-page-row-copy strong{font-size:var(--mote-font-row);font-weight:500;line-height:1.7;overflow-wrap:anywhere;display:flex;align-items:center;gap:8px}
.memory-page-row-copy>span{font-size:var(--mote-font-support);line-height:1.8;color:var(--mote-muted);overflow-wrap:anywhere}
.memory-page-row-copy small{font-size:var(--mote-font-meta);line-height:1.8;color:var(--mote-muted);overflow-wrap:anywhere}
.memory-page-state{border:1px solid var(--mote-hair);border-radius:var(--mote-radius-indicator);padding:1px 6px;font-size:10px;font-weight:400;color:var(--mote-warning)}
.memory-page-kind{font-size:var(--mote-font-support);color:var(--mote-muted);white-space:nowrap;padding-top:3px}
.memory-page-pending{display:flex;align-items:center;gap:10px;flex:none;padding-right:4px}
.memory-page-pending .button{display:inline-flex;align-items:center;gap:6px}
.memory-page-pending .text-button{color:var(--mote-muted)}
.memory-page-quick{display:flex;align-items:flex-start;gap:12px;margin:14px 0;padding:14px 17px;border:1px solid var(--mote-hair);border-radius:var(--mote-radius-container);background:var(--mote-surface)}
.memory-page-quick>svg{margin-top:2px;color:var(--mote-muted);flex:none}
.memory-page-quick span{display:flex;flex-direction:column;gap:3px;min-width:0}
.memory-page-quick strong{font-size:var(--mote-font-row);font-weight:500;line-height:1.7;overflow-wrap:anywhere}
.memory-page-quick small{font-size:var(--mote-font-meta);color:var(--mote-muted)}
.memory-page-empty{padding:38px 4px;color:var(--mote-muted);font-size:var(--mote-font-support);text-align:left}
.memory-page-group{margin:26px 0 0}
.memory-page-group h2{font-size:var(--mote-font-section);font-weight:var(--mote-weight-section);margin:0 0 4px;color:var(--mote-muted)}
.memory-page-chat{display:grid;grid-template-columns:18px minmax(0,1fr);align-items:start;gap:12px;width:100%;padding:15px 4px;border:0;border-bottom:1px solid var(--mote-hair);background:transparent;color:var(--mote-ink);text-align:left;font:inherit;cursor:pointer}
.memory-page-chat>svg{color:var(--mote-muted);margin-top:2px}
.memory-page-chat span{display:flex;flex-direction:column;gap:4px;min-width:0}
.memory-page-chat strong{font-size:var(--mote-font-row);font-weight:500;line-height:1.7;overflow-wrap:anywhere}
.memory-page-chat small{font-size:var(--mote-font-support);line-height:1.8;color:var(--mote-muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.memory-page-next{margin:18px 0 0;color:var(--mote-muted)}
@media(max-width:560px){.memory-page-heading{margin-bottom:16px}.memory-remember{padding-left:14px}.memory-page-row-main{grid-template-columns:20px minmax(0,1fr);gap:10px}.memory-page-kind{display:none}.memory-page-row{align-items:flex-start;flex-wrap:wrap}.memory-page-pending{padding:0 4px 14px 46px;margin-top:-6px}.memory-page-quick{padding:12px 14px}}
`;
