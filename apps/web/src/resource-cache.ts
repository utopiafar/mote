import type {Api} from './api';
export type ResourceSnapshot<T>={data?:T;error?:unknown;loading:boolean};
/** Read resources belong to one authenticated Api instance. Aborted generations
 * cannot publish, even when the underlying transport ignores cancellation. */
export class Resource<T>{
 private snapshot:ResourceSnapshot<T>={loading:false};private listeners=new Set<()=>void>();private controller?:AbortController;private generation=0;private dirty=true;
 constructor(readonly key:string,private api:Api){}
 getSnapshot=()=>this.snapshot;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);if(this.dirty)this.refresh();return()=>{this.listeners.delete(listener);if(!this.listeners.size&&this.controller){this.controller.abort();this.controller=undefined;this.generation++;this.dirty=true;this.snapshot={...this.snapshot,loading:false};}};};
 get observed(){return this.listeners.size>0;}
 invalidate(){this.dirty=true;if(this.observed)this.refresh();}
 refresh=()=>{this.controller?.abort();const controller=new AbortController(),generation=++this.generation;this.controller=controller;this.dirty=false;this.publish({...this.snapshot,error:undefined,loading:true});
  void this.api.request<T>(this.key,{signal:controller.signal}).then(data=>{if(this.generation===generation&&!controller.signal.aborted)this.publish({data,loading:false});}).catch(error=>{if(this.generation===generation&&!controller.signal.aborted){this.dirty=true;this.publish({...this.snapshot,error,loading:false});}}).finally(()=>{if(this.controller===controller)this.controller=undefined;});
 };
 private publish(value:ResourceSnapshot<T>){this.snapshot=value;this.listeners.forEach(listener=>listener());}
}
export class ResourceCache {
 private entries=new Map<string,Resource<unknown>>();
 constructor(private api:Api){}
 get<T>(key:string):Resource<T>{let entry=this.entries.get(key);if(!entry){for(const [old,value] of this.entries){if(this.entries.size<100)break;if(!value.observed)this.entries.delete(old);}entry=new Resource(key,this.api);this.entries.set(key,entry);}return entry as Resource<T>;}
 invalidate(matches:(key:string)=>boolean){for(const [key,entry] of this.entries)if(matches(key))entry.invalidate();}
}
const caches=new WeakMap<Api,ResourceCache>();
export function resources(api:Api){let cache=caches.get(api);if(!cache){cache=new ResourceCache(api);caches.set(api,cache);}return cache;}
