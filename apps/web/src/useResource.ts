import {useEffect,useMemo,useSyncExternalStore} from 'react';
import type {Api} from './api';
import {resources} from './resource-cache';
const emptySnapshot={loading:false};
const disabled={subscribe:(_listener:()=>void)=>()=>{},getSnapshot:()=>emptySnapshot,refresh:()=>{},poll:(_interval:number)=>()=>{}};
export function useResource<T>(api:Api,path:string|null,pollMs?:number){const resource=useMemo(()=>path?resources(api).get<T>(path):disabled,[api,path]);useEffect(()=>pollMs?resource.poll(pollMs):undefined,[resource,pollMs]);return {...useSyncExternalStore(resource.subscribe,resource.getSnapshot,resource.getSnapshot) as import('./resource-cache').ResourceSnapshot<T>,refresh:resource.refresh};}
