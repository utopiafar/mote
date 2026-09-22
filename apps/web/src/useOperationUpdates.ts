import {useMemo,useSyncExternalStore} from 'react';
import type {Api} from './api';
import {operationFeed} from './operation-feed';
export function useOperationUpdates(api:Api){const feed=useMemo(()=>operationFeed(api),[api]);return useSyncExternalStore(feed.subscribe,feed.getSnapshot,feed.getSnapshot);}
