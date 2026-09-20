import {isLoopback} from './file-processors.js';
import type {FileStore} from './files.js';
import type { Config } from './config.js';
import type { Store, Range } from './store.js';
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
  constructor(private store:Store,private config:Pick<Config,'embeddingModel'|'embeddingBaseUrl'|'embeddingApiKey'>,private diagnostics?:ServerDiagnostics,private files?:FileStore) {}
  get configured() {return Boolean(this.config.embeddingModel&&this.config.embeddingBaseUrl);}
  async embed(text:string):Promise<number[]> {
    const url=this.config.embeddingBaseUrl.replace(/\/$/,'')+'/embeddings';
    let response:Response;
    try{response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(this.config.embeddingApiKey?{Authorization:`Bearer ${this.config.embeddingApiKey}`}:{})},body:JSON.stringify({model:this.config.embeddingModel,input:text.slice(0,20000)}),signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(45000)]),redirect:'error'});}catch{throw new EmbeddingError('embedding_transport');}
    if(!response.ok){await response.body?.cancel();throw new EmbeddingError('embedding_http',response.status);}
    let data:{data?:{embedding?:number[]}[]};
    try {
      // A provider controls the complete body, including ignored JSON fields and decompressed bytes.
      const limit=2*1024*1024,reader=response.body?.getReader(),bytes=Buffer.allocUnsafe(limit);let size=0;
      if(!reader)throw new Error('Missing embedding response body');
      try {
        if(Number(response.headers.get('content-length'))>limit)throw new Error('Embedding response too large');
        for(;;){const {value,done}=await reader.read();if(done)break;if(size+value.byteLength>limit)throw new Error('Embedding response too large');bytes.set(value,size);size+=value.byteLength;}
        data=JSON.parse(bytes.subarray(0,size).toString('utf8')) as typeof data;
      }catch(error){await reader.cancel().catch(()=>{});throw error;}
      finally{reader.releaseLock();}
    }catch{throw new EmbeddingError('embedding_invalid');}
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
      if(item.source==='activity'||this.store.db.prepare('SELECT 1 FROM file_versions WHERE capture_id=?').get(item.id))continue;
      const task=async()=>{const vector=await this.embed([item.appName,item.windowTitle,item.ocrText,...(item.mood === undefined?[]:[`User-provided mood: ${item.mood}`])].join('\n'));if(!this.closing)this.store.indexed(item.id,vector,this.config.embeddingModel);return vector;};
      try {if(this.diagnostics)await this.diagnostics.measure('index','embedding',task,()=>({count:1}));else await task();}
      catch(e){if(!this.closing)this.store.indexFailed(item.id,e instanceof EmbeddingError?e.message:'Embedding operation failed');}
    }
    for(const item of this.files?.pendingIndex(this.config.embeddingModel,isLoopback(this.config.embeddingBaseUrl))??[]){
      if(this.closing)break;
      try{const vector=await this.embed(item.text);if(!this.closing)this.files!.indexed(item.id,vector,this.config.embeddingModel);}catch{if(!this.closing)this.files!.indexFailed(item.id);}
    }
    const counts=this.store.indexCounts();this.diagnostics?.record('queue.snapshot',{pending:counts.pending,failed:counts.failed});
  }
  async close() {this.closing=true;this.abort.abort();await this.current;}
  async search(args:Range&{query?:string}) {
    const lexical=[this.store.search(args),this.files?.search(args)??[]];
    let channels=lexical,degraded=false;let vectorCoverage:unknown;
    if(this.configured&&args.query&&args.source!=='activity'&&args.source!=='media'&&args.collection!=='activity'){
      try{
        const vector=await this.embed(args.query);
        const captures=this.store.vectorSearch(vector,this.config.embeddingModel,args),files=this.files?.vectorSearch(vector,this.config.embeddingModel,args)??[];
        vectorCoverage={captures:captures.coverage,files:'coverage' in files?files.coverage:null};channels=[...lexical,captures,files];
      }catch(error){if(this.closing)throw error;degraded=true;}
    }
    // Reciprocal rank fusion across independent channels; no file-table priority.
    const ranked=new Map<string,{record:(typeof lexical)[number][number];score:number}>();
    for(const channel of channels){const seen=new Set<string>();channel.forEach((record,index)=>{
      if(seen.has(record.id))return;seen.add(record.id);
      const previous=ranked.get(record.id);
      ranked.set(record.id,{record:previous?.record??record,score:(previous?.score??0)+1/(60+index+1)});
    });}
    const result=[...ranked.values()].sort((a,b)=>b.score-a.score||a.record.id.localeCompare(b.record.id)).slice(0,args.limit??50).map(({record})=>({...record,retrieval:{mode:channels===lexical?'lexical':'hybrid',degraded,...(vectorCoverage?{vectorCoverage}:{}),...(degraded?{reason:'embedding_unavailable'}:{})}}));
    // Preserve degradation even for an empty result, without changing the public array API.
    return Object.assign(result,{retrieval:{mode:channels===lexical?'lexical':'hybrid',degraded,...(vectorCoverage?{vectorCoverage}:{}),...(degraded?{reason:'embedding_unavailable'}:{})}});
  }
}
