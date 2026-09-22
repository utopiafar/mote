import {ProviderFailure,providerHttpFailure,type TokenUsage} from '@mote/shared';
import {ExecutionEngine,ExecutionFailure,type ExecutionStep} from './execution-engine.js';
import {withExecutionCancellation} from './execution-cancellation.js';
import {sha256} from './store.js';
import {isLoopback} from './file-processors.js';
import type {FileStore} from './files.js';
import type { Config } from './config.js';
import type { Store, Range } from './store.js';
import type { ServerDiagnostics } from './diagnostics.js';
import { randomUUID } from 'node:crypto';

class EmbeddingError extends ProviderFailure {
  constructor(readonly code:'embedding_http'|'embedding_invalid'|'embedding_transport',readonly httpStatus?:number,retryAfter?:string|null) {
    super(code==='embedding_http'?providerHttpFailure(httpStatus!,retryAfter):{category:code==='embedding_invalid'?'permanent':'transient',code},code==='embedding_http'?`Embedding provider returned HTTP ${httpStatus}`:code==='embedding_invalid'?'Embedding provider returned an invalid vector':'Embedding transport failed');
  }
}

export class Indexer {
  private current?:Promise<void>;
  private closing=false;
  private abort=new AbortController();
  readonly engine:ExecutionEngine;private owned:boolean;private unregister:(()=>void)[]=[];
  constructor(private store:Store,private config:Pick<Config,'embeddingModel'|'embeddingBaseUrl'|'embeddingApiKey'>,private diagnostics?:ServerDiagnostics,private files?:FileStore,private admission?:(input:{bytes:number;operationId?:string})=>{finish:(usage?:TokenUsage,failed?:boolean)=>void},private options:{executor?:ExecutionEngine;operationId?:()=>string|undefined}={}) {
    this.engine=options.executor??new ExecutionEngine(store);this.owned=!options.executor;
    for(const kind of ['capture','file'] as const)this.unregister.push(this.engine.register({kind:'embedding.'+kind,pool:'embedding',concurrency:()=>2,timeoutMs:45000,
      validate:step=>this.valid(step),admit:()=>this.closing?new ExecutionFailure('blocked','indexer_closed'):!this.configured?new ExecutionFailure('blocked','embedding_not_configured'):undefined,
      execute:async(step,signal)=>{const combined=AbortSignal.any([signal,this.abort.signal]);return withExecutionCancellation(combined,async()=>{const text=this.inputText(step);return this.performEmbedding(text,45000,combined,step.operationId);});},
      commit:(step,result)=>{const id=String(step.input.evidenceId);if(kind==='capture')this.store.indexed(id,result as number[],this.config.embeddingModel);else this.files!.indexed(id,result as number[],this.config.embeddingModel);},
      project:step=>this.project(step),classify:error=>this.closing?new ExecutionFailure('waiting','interrupted'):new ExecutionFailure('permanent','embedding_invalid'),
    }));
  }
  private modelFingerprint(){return sha256(JSON.stringify([this.config.embeddingModel,this.config.embeddingBaseUrl]));}
  private fileInput(id:string){if(!this.files?.isCurrentEvidence(id))return;const row=this.store.db.prepare('SELECT c.id,c.capture_id,c.text,c.metadata,c.start_ms,c.end_ms,v.revision,j.local_only FROM file_chunks c JOIN file_versions v ON v.capture_id=c.capture_id JOIN file_jobs j ON j.capture_id=c.capture_id WHERE c.id=?').get(id);if(!row||row.local_only&&!isLoopback(this.config.embeddingBaseUrl))return;return {id,captureId:String(row.capture_id),text:String(row.text),fingerprint:sha256(JSON.stringify([row.capture_id,row.text,row.metadata,row.start_ms,row.end_ms,row.revision]))};}
  private valid(step:ExecutionStep){if(step.input.modelFingerprint!==this.modelFingerprint())return false;const id=String(step.input.evidenceId);return step.kind==='embedding.file'?this.fileInput(id)?.fingerprint===step.input.fingerprint:this.store.archive.fingerprint(id)===step.input.fingerprint;}
  private inputText(step:ExecutionStep){const id=String(step.input.evidenceId);if(step.kind==='embedding.file')return this.fileInput(id)!.text;const item=this.store.evidence([id])[0];return [item.appName,item.windowTitle,item.ocrText,...(item.mood===undefined?[]:[`User-provided mood: ${item.mood}`])].join('\n');}
  private project(step:ExecutionStep){
    if(!this.valid(step))return;
    const id=String(step.input.evidenceId),retry=step.state==='waiting',failed=['failed','blocked','cancelled','stale'].includes(step.state)||retry&&!!step.error&&step.error!=='interrupted';
    if(step.kind==='embedding.capture'){
      if(failed)this.store.db.prepare("UPDATE captures SET index_status='failed',index_error=?,attempts=? WHERE id=?").run(step.error??'embedding_failed',step.attempts,id);
      else if(retry)this.store.db.prepare("UPDATE captures SET index_status='pending',index_error=NULL WHERE id=?").run(id);
    }else if(failed)this.store.db.prepare('UPDATE file_chunks SET index_error=? WHERE id=?').run(step.error??'embedding_failed',id);
  }
  private enqueue(kind:'capture'|'file',id:string,captureId:string,fingerprint:string){
    const input={evidenceId:id,fingerprint,modelFingerprint:this.modelFingerprint()},stepId='embedding:'+sha256(JSON.stringify([kind,input]));
    this.engine.enqueue((kind==='file'?'file:':'capture:')+captureId,'embedding.'+kind,input,{id:stepId,generation:{slot:'embedding:'+id,version:stepId}});
    return stepId;
  }

  retry(){const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');try{const result=this.store.retryIndex();for(const row of db.prepare("SELECT id FROM execution_steps WHERE kind IN ('embedding.capture','embedding.file') AND state!='running'").all())this.engine.retry(String(row.id));if(own)db.exec('COMMIT');return result;}catch(error){if(own)db.exec('ROLLBACK');throw error;}}
  get configured() {return Boolean(this.config.embeddingModel&&this.config.embeddingBaseUrl);}
  private queryCache=new Map<string,{at:number;vector:number[]}>();
  async embed(text:string,timeoutMs=45000,signal?:AbortSignal,operationId?:string):Promise<number[]> {
    const id='embedding-query:'+randomUUID(),selectedParent=operationId??this.options.operationId?.(),parent=selectedParent??'embedding:'+randomUUID(),external=AbortSignal.any([this.abort.signal,...(signal?[signal]:[])]),deadline=AbortSignal.timeout(timeoutMs);let value:number[]|undefined;
    try{return await this.engine.runStep({id,operationId:parent,kind:'embedding.query',pool:'embedding.query',optional:!!selectedParent,input:{requestHash:sha256(text),modelFingerprint:this.modelFingerprint()},signal:external,timeoutMs,
      validate:()=>!this.closing&&!external.aborted,
      execute:async requestSignal=>{try{return await withExecutionCancellation(AbortSignal.any([requestSignal,deadline]),()=>this.performEmbedding(text,timeoutMs,AbortSignal.any([requestSignal,deadline]),parent));}catch(error){if(deadline.aborted&&!external.aborted)throw new ProviderFailure({category:'permanent',code:'embedding_timeout'});throw error;}},commit:result=>{value=result as number[];},read:()=>value,project:()=>{},
    });}catch(error){
      const step=this.engine.get(id);
      // Query vectors are single attempts: retain the observed cause, never leave
      // an in-memory question queued for replay after lexical fallback.
      if(step&&['waiting','running'].includes(step.state)){
        if(external.aborted)this.engine.cancel(id);
        else this.engine.fail(id,error instanceof ProviderFailure?error.details.code:error instanceof ExecutionFailure&&error.code!=='step_pending'?error.code:deadline.aborted?'embedding_timeout':'embedding_capacity');
      }
      throw error;
    }
  }
  private async performEmbedding(text:string,timeoutMs:number,signal:AbortSignal,operationId:string):Promise<number[]>{
    const task=async()=>{
    const receipt=this.admission?.({bytes:Buffer.byteLength(text.slice(0,20000)),operationId});
    try{const result=await this.requestEmbedding(text,timeoutMs,signal);receipt?.finish(result.usage);return result.vector;}catch(error){receipt?.finish(undefined,true);throw error;}
    };
    return this.diagnostics?this.diagnostics.measure('index','embedding',task,()=>({count:1})):task();
  }
  private async requestEmbedding(text:string,timeoutMs:number,signal?:AbortSignal) {
    const url=this.config.embeddingBaseUrl.replace(/\/$/,'')+'/embeddings';
    let response:Response;
    try{response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(this.config.embeddingApiKey?{Authorization:`Bearer ${this.config.embeddingApiKey}`}:{})},body:JSON.stringify({model:this.config.embeddingModel,input:text.slice(0,20000)}),signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]),redirect:'error'});}catch{throw new EmbeddingError('embedding_transport');}
    if(!response.ok){await response.body?.cancel();throw new EmbeddingError('embedding_http',response.status,response.headers.get('retry-after'));}
    let data:{data?:{embedding?:number[]}[];usage?:{prompt_tokens?:number;total_tokens?:number}};
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
    const count=data.usage?.prompt_tokens,total=data.usage?.total_tokens;
    const usage:TokenUsage|undefined=Number.isSafeInteger(count)&&count!>=0&&total===count?{requests:1,reportedRequests:1,inputTokens:count!,outputTokens:0,totalTokens:count!,cacheReadTokens:0,cacheWriteTokens:0}:undefined;
    return {vector,usage};
  }
  tick():Promise<void> {
    if(this.current)return this.current;
    if(this.closing||!this.configured)return Promise.resolve();
    this.current=(this.diagnostics?this.diagnostics.run(randomUUID(),()=>this.run()):this.run()).finally(()=>{this.current=undefined;});return this.current;
  }
  private async run() {
    for(const item of this.store.pending(8)){const fingerprint=this.store.archive.fingerprint(item.id);if(fingerprint)this.enqueue('capture',item.id,item.id,fingerprint);}
    for(const item of this.files?.pendingIndex(this.config.embeddingModel,isLoopback(this.config.embeddingBaseUrl))??[]){const current=this.fileInput(item.id);if(current)this.enqueue('file',item.id,current.captureId,current.fingerprint);}
    const ids=this.store.db.prepare("SELECT id FROM execution_steps WHERE kind IN ('embedding.capture','embedding.file') AND state IN ('waiting','running') ORDER BY rowid LIMIT 200").all().map(row=>String(row.id));await this.engine.drain(ids);for(const id of ids)this.engine.project(id);
    const counts=this.store.indexCounts();this.diagnostics?.record('queue.snapshot',{pending:counts.pending,failed:counts.failed});
  }
  async close() {this.closing=true;this.abort.abort();if(this.owned)await this.engine.close();await this.current;for(const unregister of this.unregister)unregister();this.unregister=[];}
  async search(args:Range&{query?:string;signal?:AbortSignal}) {
    const lexical=[this.store.search(args),this.files?.search(args)??[]];
    let channels=lexical,degraded=false;let vectorCoverage:unknown;
    if(this.configured&&args.query&&args.source!=='activity'&&args.source!=='media'&&args.collection!=='activity'){
      try{
        const key=this.config.embeddingModel+"\n"+args.query,cached=this.queryCache.get(key);
        const vector=cached&&Date.now()-cached.at<60000?cached.vector:await this.embed(args.query,1200,args.signal);
        if(!cached||cached.vector!==vector){if(this.queryCache.size>=128)this.queryCache.delete(this.queryCache.keys().next().value!);this.queryCache.set(key,{at:Date.now(),vector});}
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
