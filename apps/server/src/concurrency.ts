/** Bounded admission; FIFO by default, round-robin between explicit host operation keys. */
export class ConcurrencyGate {
  private active=0;
  private waiting:{key?:string;start:()=>void;reject:(error:Error)=>void;signal?:AbortSignal;abort:()=>void}[]=[];
  private closed=false;
  private sequence=0;
  private served=new Map<string,number>();
  private activeKeys=new Map<string,number>();
  private clean(key?:string){if(key&&!this.activeKeys.has(key)&&!this.waiting.some(entry=>entry.key===key))this.served.delete(key);}
  constructor(private limit:number){}
  snapshot(){return {active:this.active,waiting:this.waiting.length,limit:this.limit};}
  configure(limit:number){if(!Number.isInteger(limit)||limit<1)throw Error('Invalid concurrency');this.limit=limit;this.drain();}
  private drain(){while(!this.closed&&this.active<this.limit&&this.waiting.length){let at=0;for(let i=1;i<this.waiting.length;i++){const key=this.waiting[i].key,first=this.waiting[at].key;if(key&&first&&(this.served.get(key)??0)<(this.served.get(first)??0))at=i;}const next=this.waiting.splice(at,1)[0];next.signal?.removeEventListener('abort',next.abort);next.start();}}
  run<T>(task:()=>Promise<T>,signal?:AbortSignal,key?:string):Promise<T>{
    if(this.closed)return Promise.reject(new Error('Execution queue closed'));
    if(signal?.aborted)return Promise.reject(signal.reason??new DOMException('Cancelled','AbortError'));
    return new Promise<T>((resolve,reject)=>{
      const entry={key,signal,reject,abort:()=>{const at=this.waiting.indexOf(entry);if(at>=0){this.waiting.splice(at,1);this.clean(key);reject(signal?.reason??new DOMException('Cancelled','AbortError'));}},start:()=>{
        this.active++;if(key){this.served.set(key,++this.sequence);this.activeKeys.set(key,(this.activeKeys.get(key)??0)+1);}Promise.resolve().then(()=>{signal?.throwIfAborted();return task();}).then(resolve,reject).finally(()=>{this.active--;if(key){const remaining=this.activeKeys.get(key)!-1;if(remaining)this.activeKeys.set(key,remaining);else this.activeKeys.delete(key);this.clean(key);}this.drain();});
      }};
      signal?.addEventListener('abort',entry.abort,{once:true});this.waiting.push(entry);this.drain();
    });
  }
  close(){this.closed=true;for(const entry of this.waiting.splice(0)){entry.signal?.removeEventListener('abort',entry.abort);entry.reject(new Error('Execution queue closed'));}this.served.clear();}
}
