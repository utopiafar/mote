/** FIFO admission; lowering capacity never interrupts existing work. */
export class ConcurrencyGate {
  private active=0;
  private waiting:{start:()=>void;reject:(error:Error)=>void;signal?:AbortSignal;abort:()=>void}[]=[];
  private closed=false;
  constructor(private limit:number){}
  snapshot(){return {active:this.active,waiting:this.waiting.length,limit:this.limit};}
  configure(limit:number){if(!Number.isInteger(limit)||limit<1)throw Error('Invalid concurrency');this.limit=limit;this.drain();}
  private drain(){while(!this.closed&&this.active<this.limit&&this.waiting.length){const next=this.waiting.shift()!;next.signal?.removeEventListener('abort',next.abort);next.start();}}
  run<T>(task:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
    if(this.closed)return Promise.reject(new Error('Execution queue closed'));
    if(signal?.aborted)return Promise.reject(signal.reason??new DOMException('Cancelled','AbortError'));
    return new Promise<T>((resolve,reject)=>{
      const entry={signal,reject,abort:()=>{const at=this.waiting.indexOf(entry);if(at>=0){this.waiting.splice(at,1);reject(signal?.reason??new DOMException('Cancelled','AbortError'));}},start:()=>{
        this.active++;Promise.resolve().then(()=>{signal?.throwIfAborted();return task();}).then(resolve,reject).finally(()=>{this.active--;this.drain();});
      }};
      signal?.addEventListener('abort',entry.abort,{once:true});this.waiting.push(entry);this.drain();
    });
  }
  close(){this.closed=true;for(const entry of this.waiting.splice(0)){entry.signal?.removeEventListener('abort',entry.abort);entry.reject(new Error('Execution queue closed'));}}
}
