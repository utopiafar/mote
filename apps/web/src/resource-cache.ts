import {ApiError,type Api} from './api';
export type ResourceSnapshot<T>={data?:T;error?:unknown;loading:boolean};
/** Read resources belong to one authenticated Api instance. Aborted generations
 * cannot publish, even when the underlying transport ignores cancellation. */
export class Resource<T>{
 private snapshot:ResourceSnapshot<T>={loading:true};private listeners=new Set<()=>void>();private controller?:AbortController;private generation=0;private dirty=true;
 private pollers=new Map<number,number>();private timer?:ReturnType<typeof setTimeout>;
 constructor(readonly key:string,private api:Api){}
 getSnapshot=()=>this.snapshot;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);if(this.dirty)this.refresh();return()=>{this.listeners.delete(listener);if(!this.listeners.size)this.dirty=true;if(!this.listeners.size&&this.controller){this.controller.abort();this.controller=undefined;this.generation++;this.dirty=true;this.snapshot={...this.snapshot,loading:false};}};};
 get observed(){return this.listeners.size>0;}
 poll=(interval:number)=>{this.pollers.set(interval,(this.pollers.get(interval)??0)+1);this.schedule();return()=>{const count=this.pollers.get(interval)??0;if(count<=1)this.pollers.delete(interval);else this.pollers.set(interval,count-1);this.schedule();};};
 private schedule(){clearTimeout(this.timer);if(!this.pollers.size)return;this.timer=setTimeout(()=>{if(this.observed&&!this.snapshot.loading&&(typeof document==='undefined'||!document.hidden))this.refresh();this.schedule();},Math.max(250,Math.min(...this.pollers.keys())));}
 invalidate(){this.dirty=true;if(this.observed)this.refresh();}
 refresh=()=>{this.controller?.abort();const controller=new AbortController(),generation=++this.generation;this.controller=controller;this.dirty=false;this.publish({...this.snapshot,error:undefined,loading:true});
  void this.api.request<T>(this.key,{signal:controller.signal}).then(data=>{if(this.generation===generation&&!controller.signal.aborted)this.publish({data,loading:false});}).catch(error=>{if(this.generation===generation&&!controller.signal.aborted){this.dirty=true;this.publish({...(error instanceof ApiError&&[401,403,404,410].includes(error.status)?{}:this.snapshot),error,loading:false});}}).finally(()=>{if(this.controller===controller)this.controller=undefined;});
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

/** Event-driven reads share the same generation as mounted views. Each caller
 * releases its subscription on cancellation, without cancelling other readers. */
export function readResource<T>(api:Api,path:string,signal:AbortSignal):Promise<T>{
 if(signal.aborted)return Promise.reject(signal.reason??new DOMException('Aborted','AbortError'));
 const resource=resources(api).get<T>(path);
 return new Promise<T>((resolve,reject)=>{
  let unsubscribe:(()=>void)|undefined,done=false;
  const finish=(error:unknown,data?:T)=>{if(done)return;done=true;unsubscribe?.();signal.removeEventListener('abort',abort);if(error)reject(error);else resolve(data!);};
  const abort=()=>finish(signal.reason??new DOMException('Aborted','AbortError'));
  const update=()=>{const snapshot=resource.getSnapshot();if(!snapshot.loading){if(snapshot.error)finish(snapshot.error);else if(snapshot.data!==undefined)finish(undefined,snapshot.data);}};
  signal.addEventListener('abort',abort,{once:true});unsubscribe=resource.subscribe(update);if(done)unsubscribe();else update();
 });
}
