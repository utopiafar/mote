import {createContext,useCallback,useMemo,useSyncExternalStore} from 'react';
import type {NavState} from '@mote/shared';
import type {Api} from './api';
import {Resource,type ResourceSnapshot} from './resource-cache';

const emptySnapshot:ResourceSnapshot<NavState>={loading:false};
const getEmptySnapshot=()=>emptySnapshot;
export const NavStateContext=createContext<NavState|undefined>(undefined);

/** One foreground read per shell. Page consumers can compare revisions from
 * NavStateContext without fetching the navigation state again. */
export function useNavState(api:Api|null):NavState|undefined {
  const resource=useMemo(()=>api?new Resource<NavState>('/api/nav-state',api):null,[api]);
  const subscribe=useCallback((listener:()=>void)=>{
    if(!resource)return ()=>{};
    let release:(()=>void)|undefined;
    const visibilityChanged=()=>{
      if(document.hidden){
        release?.();
        release=undefined;
      }else if(!release){
        const unsubscribe=resource.subscribe(listener);
        const stopPolling=resource.poll(30_000);
        release=()=>{stopPolling();unsubscribe();};
      }
    };
    document.addEventListener('visibilitychange',visibilityChanged);
    visibilityChanged();
    return ()=>{
      document.removeEventListener('visibilitychange',visibilityChanged);
      release?.();
    };
  },[resource]);
  return useSyncExternalStore(subscribe,resource?.getSnapshot??getEmptySnapshot,getEmptySnapshot).data;
}
