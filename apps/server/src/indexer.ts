import type { Config } from './config.js';
import type { Store } from './store.js';
import type { ServerDiagnostics } from './diagnostics.js';
import { randomUUID } from 'node:crypto';

class EmbeddingError extends Error {
  readonly statusCode=502;
  constructor(readonly code:'embedding_http'|'embedding_invalid'|'embedding_transport',readonly httpStatus?:number) {
    super(code==='embedding_http'?`Embedding provider returned HTTP ${httpStatus}`:code==='embedding_invalid'?'Embedding provider returned an invalid vector':'Embedding transport failed');
  }
}

export class Indexer {
  private current?:Promise<void>;
  private closing=false;
  private abort=new AbortController();
  constructor(private store:Store,private config:Pick<Config,'embeddingModel'|'embeddingBaseUrl'|'embeddingApiKey'>,private diagnostics?:ServerDiagnostics) {}
  get configured() {return Boolean(this.config.embeddingModel&&this.config.embeddingBaseUrl);}
  async embed(text:string):Promise<number[]> {
    const url=this.config.embeddingBaseUrl.replace(/\/$/,'')+'/embeddings';
    let response:Response;
    try{response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(this.config.embeddingApiKey?{Authorization:`Bearer ${this.config.embeddingApiKey}`}:{})},body:JSON.stringify({model:this.config.embeddingModel,input:text.slice(0,20000)}),signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(45000)]),redirect:'error'});}catch{throw new EmbeddingError('embedding_transport');}
    if(!response.ok){await response.body?.cancel();throw new EmbeddingError('embedding_http',response.status);}
    let data:{data?:{embedding?:number[]}[]};
    try{data=await response.json() as typeof data;}catch{throw new EmbeddingError('embedding_invalid');}
    const vector=data?.data?.[0]?.embedding;
    if(!Array.isArray(vector)||!vector.length||vector.length>16384||!vector.every(n=>Number.isFinite(n)))throw new EmbeddingError('embedding_invalid');
    return vector;
  }
  tick():Promise<void> {
    if(this.current)return this.current;
    if(this.closing||!this.configured)return Promise.resolve();
    this.current=(this.diagnostics?this.diagnostics.run(randomUUID(),()=>this.run()):this.run()).finally(()=>{this.current=undefined;});return this.current;
  }
  private async run() {
    for(const item of this.store.pending(8)) {
      if(this.closing)break;
      const task=async()=>{const vector=await this.embed([item.appName,item.windowTitle,item.ocrText,...(item.mood === undefined?[]:[`User-provided mood: ${item.mood}`])].join('\n'));if(!this.closing)this.store.indexed(item.id,vector,this.config.embeddingModel);return vector;};
      try {if(this.diagnostics)await this.diagnostics.measure('index','embedding',task,()=>({count:1}));else await task();}
      catch(e){if(!this.closing)this.store.indexFailed(item.id,e instanceof EmbeddingError?e.message:'Embedding operation failed');}
    }
    const counts=this.store.indexCounts();this.diagnostics?.record('queue.snapshot',{pending:counts.pending,failed:counts.failed});
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
