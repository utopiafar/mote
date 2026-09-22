import type {OperationChanges} from '@mote/shared';
import type {Api} from './api';
import {resources} from './resource-cache';
/** One bounded change subscription per authenticated session, shared by views. */
export class OperationFeed {
 private listeners=new Set<()=>void>();private controller?:AbortController;private timer?:ReturnType<typeof setTimeout>;private cursor=Number.MAX_SAFE_INTEGER;private error:unknown;
 constructor(private api:Api,private interval=1500){}
 getSnapshot=()=>this.error;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);if(this.listeners.size===1)void this.poll();return()=>{this.listeners.delete(listener);if(!this.listeners.size){this.controller?.abort();clearTimeout(this.timer);this.controller=undefined;}};};
 private async poll(){if(!this.listeners.size)return;const controller=new AbortController();this.controller=controller;let delay=this.interval;
  try{if(typeof document!=='undefined'&&document.hidden)return;const change=await this.api.request<OperationChanges>('/api/operations/changes?since='+this.cursor,{signal:controller.signal});if(controller.signal.aborted)return;
   this.cursor=change.cursor;this.error=undefined;const ids=new Set(change.ids);if(change.reset||ids.size)resources(this.api).invalidate(key=>affectedResource(key,ids,change.reset));
   if(change.hasMore)delay=50;
  }catch(error){if(!controller.signal.aborted){this.error=error;delay=3000;}}
  finally{if(!controller.signal.aborted){this.listeners.forEach(listener=>listener());this.timer=setTimeout(()=>void this.poll(),delay);}}
 }
}
const feeds=new WeakMap<Api,OperationFeed>();
export function operationFeed(api:Api){let feed=feeds.get(api);if(!feed){feed=new OperationFeed(api);feeds.set(api,feed);}return feed;}

export function affectedResource(key:string,ids:Set<string>,reset:boolean){
 const path=key.split('?')[0];
 if(path==='/api/operations')return true;
 if(path.startsWith('/api/operations/'))return reset||ids.has(decodeURIComponent(path.slice('/api/operations/'.length)));
 const kinds=new Set([...ids].map(id=>id.split(':')[0]));
 const changed=(...values:string[])=>reset||values.some(kind=>kinds.has(kind));
 if(/^\/api\/(memories|memory-jobs)(\/|$)/.test(path))return changed('memory','import','capture','file','workflow');
 if(/^\/api\/(files|capture-browser|captures|source-items|sources)(\/|$)/.test(path))return changed('file','capture','import');
 if(/^\/api\/(query-runs|conversations)(\/|$)/.test(path))return changed('query');
 if(/^\/api\/(insights|insight-runs)(\/|$)/.test(path))return changed('insight','workflow');
 if(/^\/api\/actions(\/|$)/.test(path))return reset||[...ids].some(id=>id.startsWith('workflow:actions:'));
 if(/^\/api\/imports(\/|$)/.test(path))return changed('import');
 return false;
}
