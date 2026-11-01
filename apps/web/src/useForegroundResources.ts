import {useEffect} from 'react';
import type {Api} from './api';
import {resources} from './resource-cache';

const pending=new WeakSet<object>();
/** Recheck only the caller's mounted Api/keys; shared readers coalesce one hint. */
export function useForegroundResources(api:Api,paths:readonly (string|null|undefined)[]){
 const keys=JSON.stringify([...new Set(paths.filter((path):path is string=>typeof path==='string'&&path.length>0))]);
 useEffect(()=>{
  const entries=(JSON.parse(keys) as string[]).map(path=>resources(api).get(path));
  if(!entries.length)return;
  let hidden=document.hidden;
  const visibility=()=>{
   if(hidden===document.hidden)return;hidden=document.hidden;if(hidden)return;
   for(const resource of entries){if(pending.has(resource))continue;pending.add(resource);
    queueMicrotask(()=>{pending.delete(resource);if(!document.hidden&&resource.observed)resource.invalidate();});
   }
  };
  document.addEventListener('visibilitychange',visibility);
  return()=>document.removeEventListener('visibilitychange',visibility);
 },[api,keys]);
}
