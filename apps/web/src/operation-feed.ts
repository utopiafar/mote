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
   this.cursor=change.cursor;this.error=undefined;const ids=new Set(change.ids);if(change.reset||ids.size)resources(this.api).invalidate(key=>key==='/api/operations'||key.startsWith('/api/operations?')||key.startsWith('/api/operations/')&&(change.reset||ids.has(decodeURIComponent(key.slice('/api/operations/'.length).split('?')[0]))));
   if(change.hasMore)delay=50;
  }catch(error){if(!controller.signal.aborted){this.error=error;delay=3000;}}
  finally{if(!controller.signal.aborted){this.listeners.forEach(listener=>listener());this.timer=setTimeout(()=>void this.poll(),delay);}}
 }
}
const feeds=new WeakMap<Api,OperationFeed>();
export function operationFeed(api:Api){let feed=feeds.get(api);if(!feed){feed=new OperationFeed(api);feeds.set(api,feed);}return feed;}
