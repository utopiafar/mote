import type { Config } from './config.js';
import type { Store } from './store.js';

export class Indexer {
  private current?:Promise<void>;
  private closing=false;
  private abort=new AbortController();
  constructor(private store:Store,private config:Pick<Config,'embeddingModel'|'embeddingBaseUrl'|'embeddingApiKey'>) {}
  get configured() {return Boolean(this.config.embeddingModel&&this.config.embeddingBaseUrl);}
  async embed(text:string):Promise<number[]> {
    const url=this.config.embeddingBaseUrl.replace(/\/$/,'')+'/embeddings';
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(this.config.embeddingApiKey?{Authorization:`Bearer ${this.config.embeddingApiKey}`}:{})},body:JSON.stringify({model:this.config.embeddingModel,input:text.slice(0,20000)}),signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(45000)]),redirect:'error'});
    if(!response.ok)throw new Error(`Embedding provider returned HTTP ${response.status}`);
    const data=await response.json() as {data?:{embedding?:number[]}[]};const vector=data.data?.[0]?.embedding;
    if(!Array.isArray(vector)||!vector.length||vector.length>16384||!vector.every(n=>Number.isFinite(n)))throw new Error('Embedding provider returned an invalid vector');
    return vector;
  }
  tick():Promise<void> {
    if(this.current)return this.current;
    if(this.closing||!this.configured)return Promise.resolve();
    this.current=this.run().finally(()=>{this.current=undefined;});return this.current;
  }
  private async run() {
    for(const item of this.store.pending(8)) {
      if(this.closing)break;
      try {const vector=await this.embed([item.appName,item.windowTitle,item.ocrText,...(item.mood === undefined?[]:[`User-provided mood: ${item.mood}`])].join('\n'));this.store.indexed(item.id,vector,this.config.embeddingModel);}
      catch(e){if(!this.closing)this.store.indexFailed(item.id,e instanceof Error?e.message:'Embedding failed');}
    }
  }
  async close() {this.closing=true;this.abort.abort();await this.current;}
  async search(args:{query?:string;after?:string;before?:string;deviceId?:string;limit?:number}) {
    if(!this.configured||!args.query)return this.store.search(args);
    const vector=await this.embed(args.query);
    const semantic=this.store.vectorSearch(vector,this.config.embeddingModel,args);const lexical=this.store.search(args);
    // Interleave two retrieval primitives; semantic interpretation remains entirely with the Agent.
    const results=new Map();for(let i=0;i<Math.max(semantic.length,lexical.length);i++){if(semantic[i])results.set(semantic[i].id,semantic[i]);if(lexical[i])results.set(lexical[i].id,lexical[i]);}
    return [...results.values()].slice(0,args.limit??50);
  }
}
