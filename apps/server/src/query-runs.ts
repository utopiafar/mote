import {ProviderFailure} from '@mote/shared';
import { moteText } from './i18n.js';
import {createHash} from 'node:crypto';
import type {AgentProgress} from '@mote/agent';
import {Store,StoreError} from './store.js';
import {normalizeRun} from './execution.js';
import {safeError} from './diagnostics.js';
import type {ExecutionEnvelope} from '@mote/shared/execution';
import {RunExecution,runEnvelope,type RunExecutionOptions,type RunDeadline,type RunExecutionContext} from './run-execution.js';
import type {ExecutionStep} from './execution-engine.js';
type QueryReceipt={conversationId:string;turnId:string};
type QueryWork<T extends QueryReceipt=QueryReceipt>=(observe:(event:AgentProgress)=>void,signal:AbortSignal,execution:RunExecutionContext)=>Promise<T|(()=>T)>;
export interface QueryRun {
  id:string;operationId?:string;status:'running'|'completed'|'failed'|'cancelled';createdAt:string;updatedAt:string;
  evidenceRevision?:number;conversationId?:string;turnId?:string;events:(AgentProgress&{at:string})[];
  error?:{code:string;message:string};availableAt?:number;
  execution?:ExecutionEnvelope;
}
/** Only identifiers and projected execution metadata; answers resolve from the conversation vault. */
export class QueryRuns {
  private execution:RunExecution;
  constructor(private store:Store,options:RunExecutionOptions={}){
    store.db.exec('CREATE TABLE IF NOT EXISTS query_runs(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,json TEXT NOT NULL)');
    this.execution=new RunExecution(store,'query',{
      exists:id=>Boolean(store.db.prepare('SELECT 1 FROM query_runs WHERE id=?').get(id)),
      project:(id,step)=>this.project(id,step),
      commit:(id,result)=>{const run=this.raw(id);Object.assign(run,typeof result==='function'?result():result);this.save(run);},
      failure:(id,error)=>{const run=this.raw(id),saved=(error&&typeof error==='object'?(error as {conversation?:{conversationId:string;turnId:string}}).conversation:undefined);if(saved)Object.assign(run,saved);const safe=safeError(error);run.error={code:error instanceof ProviderFailure?safe.reason??safe.category:safe.category,message:safe.message};run.availableAt=error instanceof ProviderFailure&&error.details.retryAfterMs!==undefined?Date.now()+error.details.retryAfterMs:undefined;this.save(run);},
    },options);
    for(const row of store.db.prepare('SELECT json FROM query_runs').all() as {json:string}[]){const run=JSON.parse(row.json) as QueryRun;this.execution.restore(run.id,{state:run.status==='completed'?'succeeded':run.status,attempts:run.execution?.attempts,createdAt:run.createdAt,updatedAt:run.updatedAt,error:run.error?.code,availableAt:run.availableAt});}
  }
  private raw(id:string):QueryRun{const row=this.store.db.prepare('SELECT json FROM query_runs WHERE id=?').get(id) as {json:string}|undefined;if(!row)throw new StoreError('Query run not found',404);return JSON.parse(row.json);}
  private save(run:QueryRun){this.store.db.prepare('UPDATE query_runs SET json=? WHERE id=?').run(JSON.stringify(run),run.id);}
  private project(id:string,step:ExecutionStep){
    if(!this.store.db.prepare('SELECT 1 FROM query_runs WHERE id=?').get(id))return;
    const run=this.raw(id),before=JSON.stringify(run);run.operationId=`query:${id}`;run.status=step.state==='succeeded'?'completed':step.state==='cancelled'?'cancelled':['waiting','running'].includes(step.state)?'running':'failed';
    if(step.error==='interrupted')run.error={code:'interrupted',message:moteText('中央节点重启中断了此次问答，请重新提问。')};
    else if(step.error==='timeout')run.error={code:'timeout',message:moteText('模型执行超时，请重试。')};
    run.execution=runEnvelope({...step,error:run.error?.code??step.error,availableAt:run.availableAt??step.availableAt});
    if(run.evidenceRevision!==this.store.deletionRevision())run.events=run.events.map(({message:_,...event})=>event);
    run.updatedAt=new Date(Math.max(Date.parse(run.updatedAt),Number(this.store.db.prepare('SELECT updated_at FROM execution_steps WHERE id=?').get(step.id)!.updated_at))).toISOString();if(JSON.stringify(run)!==before)this.save(run);
  }
  cancel(id:string){const run=this.get(id);if(run.status==='running')this.execution.cancel(id);return this.get(id);}
  list():QueryRun[]{return (this.store.db.prepare("SELECT id FROM query_runs ORDER BY json_extract(json,'$.createdAt') DESC LIMIT 100").all() as {id:string}[]).map(row=>this.get(row.id));}
  get(id:string):QueryRun{this.execution.sync(id);const run=this.raw(id);return this.execution.step(id)?run:normalizeRun(run);}
  start(id:string,input:unknown,work:QueryWork,deadline:RunDeadline={}){
    const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const existing=this.store.db.prepare('SELECT request_hash FROM query_runs WHERE id=?').get(id);
    if(existing){if(existing.request_hash!==hash)throw new StoreError('Run ID belongs to a different request',409);return this.get(id);}
    if(Number(this.store.db.prepare("SELECT count(*) n FROM query_runs WHERE json_extract(json,'$.status')='running'").get()!.n)>=1000)throw new StoreError('Conversation queue is full',429);
    const at=new Date().toISOString(),run:QueryRun={evidenceRevision:this.store.deletionRevision(),id,operationId:`query:${id}`,status:'running',createdAt:at,updatedAt:at,events:[],...((input as {conversationId?:string}).conversationId?{conversationId:(input as {conversationId:string}).conversationId}:{})};
    const observe=(event:AgentProgress)=>{
      this.execution.sync(id);const current=this.raw(id);if(current.evidenceRevision!==this.store.deletionRevision()||current.status!=='running'||!['starting','model','tool','validating'].includes(event.stage))return;
      const next:AgentProgress&{at:string}={stage:event.stage,at:new Date().toISOString(),...(typeof event.message==='string'?{message:event.message.slice(0,600)}:{}),...(event.tool?{tool:event.tool.slice(0,80)}:{}),...(event.phase?{phase:event.phase}:{}),...(Number.isSafeInteger(event.step)?{step:event.step}:{}),...(Number.isSafeInteger(event.count)?{count:event.count}:{})};
      current.events.push(next);if(current.events.length>120)current.events.shift();current.updatedAt=next.at;this.save(current);
    };
    this.execution.start(id,(signal,execution)=>work(observe,signal,execution),deadline,()=>{this.store.reserveMetadata(32768);this.store.db.prepare('INSERT INTO query_runs VALUES(?,?,?)').run(id,hash,JSON.stringify(run));});return this.get(id);
  }
  async perform<T extends {conversationId:string;turnId:string}>(id:string,input:unknown,work:QueryWork<T>,deadline:RunDeadline={}):Promise<T>{
    let result:T|undefined,error:unknown;
    this.start(id,input,async(observe,signal,execution)=>{try{const prepared=await work(observe,signal,execution);return ()=>{result=typeof prepared==='function'?prepared():prepared;return {conversationId:result.conversationId,turnId:result.turnId};};}catch(value){error=value;throw value;}},deadline);
    await this.execution.wait(id);if(!this.store.db.prepare('SELECT 1 FROM query_runs WHERE id=?').get(id))throw new StoreError('Query was deleted while running',409);if(this.get(id).status==='completed'&&result)return result;throw error??new StoreError(this.get(id).error?.message??'Query did not complete',this.get(id).error?.code==='timeout'?504:409);
  }
  async close(){await this.execution.close();}
}
