import {useEffect,useMemo,useRef,useSyncExternalStore} from 'react';
import type {Api} from './api';
import {Resource,resources} from './resource-cache';
const emptySnapshot={loading:false};
const disabled={subscribe:(_listener:()=>void)=>()=>{},getSnapshot:()=>emptySnapshot,refresh:()=>{},invalidate:()=>{},observed:false,poll:(_interval:number)=>()=>{}};
const pendingRevisions=new WeakSet<object>();
function invalidateRevision(resource:{invalidate:()=>void}){
 if(pendingRevisions.has(resource))return;
 pendingRevisions.add(resource);
 queueMicrotask(()=>{pendingRevisions.delete(resource);resource.invalidate();});
}
export function useResource<T>(api:Api|null,path:string|null,pollMs?:number,revision?:unknown,continuityKey?:string,isolated=false){
 const resource=useMemo(()=>api&&path?(isolated?new Resource<T>(path,api):resources(api).get<T>(path)):disabled,[api,path,isolated]);
 useEffect(()=>pollMs?resource.poll(pollMs):undefined,[resource,pollMs]);
 const previous=useRef({resource,revision});
 const alreadyObserved=resource.observed;
 useEffect(()=>{
  const before=previous.current;previous.current={resource,revision};
  // Subscription reads a newly selected, unobserved resource. Revision hints
  // also revalidate an already shared resource, coalescing with slow reads.
  if(!Object.is(before.revision,revision)&&(before.resource===resource||alreadyObserved))invalidateRevision(resource);
 },[resource,revision]);
 const snapshot=useSyncExternalStore(resource.subscribe,resource.getSnapshot,resource.getSnapshot) as import('./resource-cache').ResourceSnapshot<T>;
 const retained=useRef<{api:Api;key:string;data:T}|undefined>(undefined);
 if(continuityKey===undefined||retained.current?.api!==api||retained.current?.key!==continuityKey||snapshot.error!==undefined)retained.current=undefined;
 let data=snapshot.data;
 // A caller may identify the same explicit time-range selection while its
 // clock endpoints advance. This is display continuity only: reads still use
 // the new URL, and identities, errors and new selections discard old content.
 if(api&&continuityKey!==undefined&&snapshot.error===undefined){
  if(data!==undefined)retained.current={api,key:continuityKey,data};
  else if(snapshot.loading)data=retained.current?.data;
  else retained.current=undefined;
 }
 return {...snapshot,data,refresh:resource.refresh};
}
