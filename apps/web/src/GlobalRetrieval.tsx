import {useEffect,useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from './api';
import {useResource} from './useResource';
import {LibraryBrowseLayout} from './LibraryBrowse';
export function GlobalRetrieval({onPage}:{onPage:(page:string)=>void}) {
 const [query,setQuery]=useState('');
 const input=useRef<HTMLInputElement>(null);
 useEffect(()=>{const key=(event:KeyboardEvent)=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();input.current?.focus();}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
 return <form className="global-retrieval" role="search" aria-label={moteText('搜索资料')} onSubmit={event=>{event.preventDefault();if(query.trim())window.location.hash='/search?query='+encodeURIComponent(query.trim());}}>
 <input ref={input} aria-label={moteText('搜索资料')} placeholder={moteText('搜索资料')} value={query} onChange={event=>setQuery(event.target.value)} maxLength={500}/><kbd aria-hidden="true">⌘ K</kbd>
 </form>;
}
export function SearchWorkspace({api,onOpen}:{api:Api;onOpen:(ref:string)=>void}) {
 const read=()=>new URLSearchParams(window.location.hash.split('?')[1]??'').get('query')??'';
 const [query,setQuery]=useState(read),[cursor,setCursor]=useState<string>(),[selected,setSelected]=useState<string>();
 useEffect(()=>{const sync=()=>{setQuery(read());setCursor(undefined);setSelected(undefined);};window.addEventListener('hashchange',sync);return()=>window.removeEventListener('hashchange',sync);},[]);
 const page=useResource<{items:{ref:string;title:string;snippet?:string;kind:string}[];nextCursor:string|null}>(api,query?'/api/context/search?'+new URLSearchParams({query,limit:'30',...(cursor?{cursor}:{})}):null);
 return <section className="search-workspace"><div className="page-heading"><h1>{moteText('搜索资料')}</h1><span>{query}</span></div><LibraryBrowseLayout api={api} reference={selected} onClose={()=>setSelected(undefined)} onOpen={onOpen}><div className="panel-pad">{page.error!==undefined&&<p role="alert">{errorMessage(page.error)}<button className="button" onClick={page.refresh}>{moteText('重新读取')}</button></p>}{page.loading&&!page.data&&<p role="status">{moteText('正在读取…')}</p>}{page.data?.items.map(item=><button className="library-record" key={item.ref} onClick={()=>setSelected(item.ref)}><span className="library-record-copy"><strong>{item.title}</strong><small>{item.snippet}</small></span></button>)}{page.data&&!page.data.items.length&&<p>{moteText('没有匹配的资料')}</p>}{(cursor||page.data?.nextCursor)&&<div className="filter-bar">{cursor&&<button className="button" onClick={()=>setCursor(undefined)}>{moteText('返回第一页')}</button>}{page.data?.nextCursor&&<button className="button" onClick={()=>setCursor(page.data!.nextCursor!)}>{moteText('下一页')}</button>}</div>}</div></LibraryBrowseLayout></section>;
}
