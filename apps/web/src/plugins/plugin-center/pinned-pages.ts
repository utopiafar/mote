import {useEffect,useSyncExternalStore} from 'react';
import type {PinnedNavPage,ServerConfiguration} from '@mote/shared';
import {createApi,type Api} from '../../api';
import type {PageEntry} from '../../features/types';
import {readStoredSession} from '../../session';

export type PinnablePage=Pick<PageEntry,'id'|'label'|'featureId'|'navItem'>;

/** The owner configuration domain that stores sidebar pins. The web shell
 * reads it directly; plugin packages never receive the full document. */
export const pinnedPagesPath='/api/configuration';

/** Owner-config projection. A missing domain is an older configuration and
 * means no pinned pages, not an error. */
export function pinnedPageIds(config:Pick<ServerConfiguration,'domains'>|undefined):readonly string[]{
 const domain=config?.domains?.find(entry=>entry.id==='ui'),value=domain?.effective;
 if(!value||typeof value!=='object'||Array.isArray(value))return [];
 const ids=(value as {pinnedPages?:unknown}).pinnedPages;
 return Array.isArray(ids)?ids.filter((id):id is string=>typeof id==='string'&&Boolean(id)):[];
}

/** Only pages executable in this host and not already an official navigation
 * item can become sidebar pins. A persisted id for an uninstalled package
 * resolves to nothing, so the sidebar neither renders it nor reports an
 * error. */
export function pinnedNavPages(ids:readonly string[],pages:readonly PinnablePage[],enabledPackages:ReadonlySet<string>):PinnedNavPage[]{
 const seen=new Set<string>(),result:PinnedNavPage[]=[];
 for(const id of ids){
  if(seen.has(id))continue;
  const page=pages.find(entry=>entry.id===id);
  if(!page||page.navItem||!enabledPackages.has(page.featureId))continue;
  seen.add(id);
  result.push({pageId:id,label:page.label??id,packageId:page.featureId});
 }
 return result;
}

/** Persist the exact list through the owner configuration domain. The caller
 * supplies the current document revision, so a concurrent save conflicts
 * instead of overwriting it. */
export async function savePinnedPages(api:Api,revision:number,pinnedPages:readonly string[]):Promise<ServerConfiguration>{
 const view=await api.request<ServerConfiguration>('/api/configuration/ui',{method:'PUT',body:JSON.stringify({revision,value:{pinnedPages}})});
 refreshPinnedPages();
 return view;
}

/** One cached snapshot for the desktop rail and the compact menu. A failed or
 * unauthenticated read keeps the list empty; the page itself remains usable. */
const listeners=new Set<()=>void>();
let state:{token:string;ids:readonly string[]}={token:'',ids:[]};
let loading='',activeToken='';
const originOf=()=>typeof window==='undefined'?'':window.location.origin;
function publish(token:string,ids:readonly string[]):void{
 state={token,ids};
 for(const listener of listeners)listener();
}
function requestPinned(token:string):void{
 activeToken=token;
 if(!token){publish('',[]);return;}
 if(state.token!==token)publish(token,[]);
 if(loading===token)return;
 const connection=(()=>{try{return readStoredSession(originOf());}catch{return null;}})();
 if(!connection||connection.token!==token)return;
 loading=token;
 void createApi(connection).request<ServerConfiguration>(pinnedPagesPath).then(config=>{
  if(loading===token&&state.token===token)publish(token,pinnedPageIds(config));
 }).catch(()=>{
  if(loading===token&&state.token===token)publish(token,[]);
 }).finally(()=>{if(loading===token)loading='';});
}
function subscribe(listener:()=>void):()=>void{
 listeners.add(listener);
 return()=>{listeners.delete(listener);};
}
function snapshot():readonly string[]{return state.ids;}

/** Refresh the shell after a pin change without duplicating reads. */
export function refreshPinnedPages():void{
 loading='';
 let token=activeToken;
 if(!token)try{token=readStoredSession(originOf())?.token??'';}catch{token='';}
 requestPinned(token);
}

export function usePinnedPageIds():readonly string[]{
 let token='';
 try{token=readStoredSession(originOf())?.token??'';}catch{token='';}
 useEffect(()=>{requestPinned(token);},[token]);
 return useSyncExternalStore(subscribe,snapshot,snapshot);
}
