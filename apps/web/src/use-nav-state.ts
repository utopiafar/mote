import {createContext,useCallback,useMemo,useSyncExternalStore} from 'react';
import {moteText} from '@mote/shared/i18n';
import type {NavState} from '@mote/shared';
import {ApiError,type Api} from './api';
import {invalidateNavigationResources} from './resource-cache';

export const NAV_STATE_POLL_MS=30_000;
export type NavStateRead={value:NavState|undefined;loading:boolean;error:unknown;refresh:()=>void};
const emptySnapshot:NavStateRead=Object.freeze({value:undefined,loading:false,error:undefined,refresh:()=>{}});
const getEmptySnapshot=()=>emptySnapshot;
export const NavStateContext=createContext<NavState|undefined>(undefined);

/** One NV2 read is shared by the sidebar badges and cache invalidation. It
 * sends the last ETag so an unchanged snapshot costs a bodyless 304, and it
 * stops scheduling while the tab is hidden. A failed read retries itself on
 * the next visible tick; it never falls back to reloading every collection. */
class NavStateReader {
 private snapshot:NavStateRead;
 private listeners=new Set<()=>void>();
 private etag?:string;
 private controller?:AbortController;
 private timer?:ReturnType<typeof setTimeout>;
 constructor(private api:Api){
  this.snapshot={value:undefined,loading:false,error:undefined,refresh:this.refresh};
 }
 getSnapshot=()=>this.snapshot;
 subscribe=(listener:()=>void)=>{
  this.listeners.add(listener);
  if(this.listeners.size===1)this.start();
  return ()=>{this.listeners.delete(listener);if(!this.listeners.size)this.stop();};
 };
 private start(){document.addEventListener('visibilitychange',this.visibility);this.visibility();}
 private stop(){
  document.removeEventListener('visibilitychange',this.visibility);
  clearTimeout(this.timer);this.controller?.abort();this.controller=undefined;
 }
 private visibility=()=>{
  if(document.hidden){clearTimeout(this.timer);this.controller?.abort();this.controller=undefined;return;}
  if(this.listeners.size)void this.read();
 };
 refresh=()=>{if(this.listeners.size&&!document.hidden)void this.read();};
 private schedule(){
  clearTimeout(this.timer);
  if(!this.listeners.size||document.hidden)return;
  this.timer=setTimeout(()=>{if(this.listeners.size&&!document.hidden)void this.read();},NAV_STATE_POLL_MS);
 }
 private publish(value:NavStateRead){this.snapshot=value;this.listeners.forEach(listener=>listener());}
 private async read(){
  if(this.controller)return;
  const controller=this.controller=new AbortController(),previous=this.snapshot.value;
  if(!previous)this.publish({...this.snapshot,loading:true,error:undefined});
  try{
   const response=await this.api.raw('/api/nav-state',{signal:controller.signal,...(this.etag?{headers:{'If-None-Match':this.etag}}:{})});
   if(controller.signal.aborted)return;
   if(response.status===304){
    if(this.snapshot.loading||this.snapshot.error!==undefined)this.publish({...this.snapshot,loading:false,error:undefined});
    return;
   }
   const raw=await response.json() as unknown;
   if(controller.signal.aborted)return;
   if(!raw||typeof raw!=='object'||typeof (raw as NavState).revisions!=='object'||typeof (raw as NavState).badges!=='object')throw new ApiError(moteText('中央响应格式无效，请刷新后重试。'),502,undefined,'invalid_response');
   const value=raw as NavState;
   invalidateNavigationResources(this.api,previous,value);
   const etag=response.headers.get('ETag');
   if(etag)this.etag=etag;
   this.publish({value,loading:false,error:undefined,refresh:this.refresh});
  }catch(error){
   if(this.controller===controller&&!controller.signal.aborted)this.publish({value:previous,loading:false,error,refresh:this.refresh});
  }finally{
   if(this.controller===controller){this.controller=undefined;this.schedule();}
  }
 }
}
const readers=new WeakMap<Api,NavStateReader>();
export function navStateReader(api:Api){let reader=readers.get(api);if(!reader){reader=new NavStateReader(api);readers.set(api,reader);}return reader;}

export function useNavStateRead(api:Api|null):NavStateRead {
 const reader=useMemo(()=>api?navStateReader(api):null,[api]);
 const subscribe=useCallback((listener:()=>void)=>reader?reader.subscribe(listener):()=>{},[reader]);
 return useSyncExternalStore(subscribe,reader?.getSnapshot??getEmptySnapshot,getEmptySnapshot);
}

/** One foreground read per shell. Page consumers can compare revisions from
 * NavStateContext without fetching the navigation state again. */
export function useNavState(api:Api|null):NavState|undefined {
 return useNavStateRead(api).value;
}
