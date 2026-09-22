import type {QueryResult} from '@mote/shared';

/** Process-local, bounded review reuse. Never persisted or shared across archives. */
export class MemoryReviewCache {
  private entries=new Map<string,{json:string;model?:string;expires:number;bytes:number}>();
  private bytes=0;
  constructor(private now=Date.now,private maxBytes=8*1024*1024,private maxEntries=128,private ttlMs=5*60_000){}
  get(key:string):{result:QueryResult;model?:string}|undefined {
    const entry=this.entries.get(key);if(!entry)return;
    if(entry.expires<=this.now()){this.remove(key);return;}
    this.entries.delete(key);this.entries.set(key,entry);
    return {result:JSON.parse(entry.json),model:entry.model};
  }
  put(key:string,result:QueryResult){
    // A reused verdict is not another model call or another usage receipt.
    const json=JSON.stringify({answer:result.answer,citations:result.citations,trace:[],runId:result.runId}),bytes=Buffer.byteLength(json);
    if(bytes>this.maxBytes)return;
    this.remove(key);
    while(this.entries.size&&(this.entries.size>=this.maxEntries||this.bytes+bytes>this.maxBytes))this.remove(this.entries.keys().next().value!);
    this.entries.set(key,{json,model:result.usage?.model,bytes,expires:this.now()+this.ttlMs});this.bytes+=bytes;
  }
  private remove(key:string){const entry=this.entries.get(key);if(entry){this.bytes-=entry.bytes;this.entries.delete(key);}}
  clear(){this.entries.clear();this.bytes=0;}
}
