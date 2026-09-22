import {useMemo,useSyncExternalStore} from 'react';
import type {Api} from './api';
import {resources} from './resource-cache';
export function useResource<T>(api:Api,path:string){const resource=useMemo(()=>resources(api).get<T>(path),[api,path]);return {...useSyncExternalStore(resource.subscribe,resource.getSnapshot,resource.getSnapshot),refresh:resource.refresh};}
