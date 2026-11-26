import {useEffect,useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import type {Api} from '../../api';
import type {PageEntry,PageProps} from '../../features/types';
import type {BuiltinWebPlugin} from '../types';
import {SearchController} from './controller';
import {SearchWorkspace} from './SearchWorkspace';

export {SearchWorkspace} from './SearchWorkspace';
export {SearchCache,SearchController,clearSearchCache,emptySearchSnapshot,emptySearchState,searchCache} from './controller';
export type {SearchControllerOptions,SearchDevicePage,SearchMemoryPage,SearchSnapshot,SearchSnapshot as SearchResultSnapshot,SearchState,SearchState as SearchQueryState} from './controller';

export function GlobalRetrieval() {
  const [query,setQuery]=useState('');
  const input=useRef<HTMLInputElement>(null);
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{
      const field=input.current;
      if(!field||field.closest('[inert]')||event.defaultPrevented||!(event.metaKey||event.ctrlKey)||event.key.toLowerCase()!=='k')return;
      event.preventDefault();
      field.focus();
    };
    window.addEventListener('keydown',key);
    return ()=>window.removeEventListener('keydown',key);
  },[]);
  return <form className="global-retrieval" role="search" aria-label={moteText('搜索资料')} onSubmit={event=>{event.preventDefault();if(query.trim())window.location.hash='/search?query='+encodeURIComponent(query.trim());}}>
  <input ref={input} type="search" aria-label={moteText('搜索资料')} placeholder={moteText('搜索资料')} value={query} onChange={event=>setQuery(event.target.value)} maxLength={500}/><kbd aria-hidden="true">⌘ K</kbd>
  </form>;
}

const searchStyles=new URL('../../library.css?no-inline',import.meta.url).href;
function SearchStyles(){return <link rel="stylesheet" href={searchStyles} precedence="default"/>;}

export const pages:PageEntry[]=[
  {id:'search',route:'search',label:moteText('搜索资料'),featureId:'mote.search',render:({api,onOpen}:PageProps)=><><SearchStyles/><SearchWorkspace api={api} onOpen={onOpen}/></>},
];

/** The search package owns the topbar entry, the search page query/filter/
 * pagination state and the owner-scoped result cache. */
export const search:BuiltinWebPlugin={id:'mote.search',pages};

/** Plugin factory: activate creates the controller (query state, owner cache,
 * hash/visibility subscriptions) and returns it; dispose releases the same
 * instance and clears its cache. */
export function createSearchPlugin(options:{api:Api}) {
  let controller:SearchController|undefined;
  return {
    id:'mote.search' as const,
    get controller():SearchController|undefined{return controller;},
    activate():SearchController{controller??=new SearchController({api:options.api});controller.start();return controller;},
    deactivate():void{controller?.stop();},
    dispose():void{controller?.dispose();controller=undefined;},
  };
}

export type SearchPlugin=ReturnType<typeof createSearchPlugin>;
