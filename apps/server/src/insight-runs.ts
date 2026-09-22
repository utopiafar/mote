import {ProviderFailure} from '@mote/shared';
import { moteText } from './i18n.js';
import {createHash} from 'node:crypto';
import type {AgentProgress} from '@mote/agent';
import {createInsightSnapshot,assertInsightSnapshot} from './insight-snapshots.js';
import type {InsightSnapshot,QueryResult} from '@mote/shared';
import {Store,StoreError} from './store.js';
import {normalizeRun} from './execution.js';
import {safeError} from './diagnostics.js';
import type {ExecutionEnvelope} from '@mote/shared/execution';
import {RunExecution,runEnvelope,type RunExecutionOptions,type RunDeadline} from './run-execution.js';
import type {ExecutionStep} from './execution-engine.js';

type Scope={after?:string;before?:string;deviceId?:string;timeZone?:string};
export interface InsightRun {
  id:string;operationId?:string;status:'running'|'completed'|'failed'|'cancelled';createdAt:string;updatedAt:string;
  scope:Scope;snapshot?:InsightSnapshot;events:(AgentProgress&{at:string})[];resultRunId?:string;
  error?:{code:string;message:string};availableAt?:number;
  execution?:ExecutionEnvelope;
}
/** Durable progress contains fixed stages and tool counts, never prompts or model reasoning. */
export class InsightRuns {
  private execution:RunExecution;
  private commitGuards=new Map<string,()=>void>();
  constructor(private readonly store:Store,options:RunExecutionOptions={}){
    store.db.exec('CREATE TABLE IF NOT EXISTS insight_runs(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,json TEXT NOT NULL)');
    this.execution=new RunExecution(store,'insight',{
      exists:id=>Boolean(store.db.prepare('SELECT 1 FROM insight_runs WHERE id=?').get(id)),
      project:(id,step)=>this.project(id,step),
      commit:(id,result)=>{this.commitGuards.get(id)?.();const run=this.raw(id);if(run.snapshot)this.assertSnapshot(run.snapshot);const output=result as QueryResult;if(!this.store.db.prepare('SELECT 1 FROM insights WHERE id=?').get(output.runId))this.store.saveInsight({...output,...(run.snapshot?{snapshot:run.snapshot}:{})},output.runId);run.resultRunId=output.runId;this.save(run);},
      failure:(id,error)=>{const run=this.raw(id),safe=safeError(error);run.error={code:error instanceof ProviderFailure?safe.reason??safe.category:safe.category,message:safe.message};run.availableAt=error instanceof ProviderFailure&&error.details.retryAfterMs!==undefined?Date.now()+error.details.retryAfterMs:undefined;this.save(run);},
    },options);
    for(const row of store.db.prepare('SELECT json FROM insight_runs').all() as {json:string}[]){const run=JSON.parse(row.json) as InsightRun;this.execution.restore(run.id,{state:run.status==='completed'?'succeeded':run.status,attempts:run.execution?.attempts,createdAt:run.createdAt,updatedAt:run.updatedAt,error:run.error?.code,availableAt:run.availableAt});}
  }
  private save(run:InsightRun){this.store.db.prepare('UPDATE insight_runs SET json=? WHERE id=?').run(JSON.stringify(run),run.id);}
  private raw(id:string):InsightRun{const row=this.store.db.prepare('SELECT json FROM insight_runs WHERE id=?').get(id) as {json:string}|undefined;if(!row)throw new StoreError('Insight run not found',404);return JSON.parse(row.json);}
  private project(id:string,step:ExecutionStep){
    if(!this.store.db.prepare('SELECT 1 FROM insight_runs WHERE id=?').get(id))return;
    const run=this.raw(id),before=JSON.stringify(run);run.operationId=`insight:${id}`;run.status=step.state==='succeeded'?'completed':step.state==='cancelled'?'cancelled':['waiting','running'].includes(step.state)?'running':'failed';
    if(step.error==='interrupted')run.error={code:'interrupted',message:moteText('中央节点重启中断了此次回顾，请重试。')};
    else if(step.error==='snapshot_changed')run.error={code:'snapshot_changed',message:moteText('所选范围的资料已变化，请生成新的洞察版本。')};
    else if(step.error==='timeout')run.error={code:'timeout',message:moteText('模型执行超时，请重试。')};
    run.execution=runEnvelope({...step,error:run.error?.code??step.error,availableAt:run.availableAt??step.availableAt});run.updatedAt=new Date(Math.max(Date.parse(run.updatedAt),Number(this.store.db.prepare('SELECT updated_at FROM execution_steps WHERE id=?').get(step.id)!.updated_at))).toISOString();if(JSON.stringify(run)!==before)this.save(run);
  }
  list():InsightRun[]{return (this.store.db.prepare("SELECT id FROM insight_runs ORDER BY json_extract(json,'$.createdAt') DESC,id LIMIT 20").all() as {id:string}[]).map(row=>this.get(row.id));}
  get(id:string):InsightRun{this.execution.sync(id);const run=this.raw(id);return this.execution.step(id)?run:normalizeRun(run);}
  cancel(id:string){const run=this.get(id);if(run.status==='running')this.execution.cancel(id);return this.get(id);}
  detail(id:string){
    const run=this.get(id),row=run.resultRunId?this.store.db.prepare('SELECT json FROM insights WHERE id=?').get(run.resultRunId) as {json:string}|undefined:undefined;
    return {...run,...(row?{result:JSON.parse(row.json)}:{})};
  }
  start(id:string,input:Scope&{prompt?:string},work:(observe:(event:AgentProgress)=>void,signal:AbortSignal,snapshot:InsightSnapshot)=>Promise<QueryResult>,deadline:RunDeadline={}):InsightRun{
    const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex'),existing=this.store.db.prepare('SELECT request_hash FROM insight_runs WHERE id=?').get(id);
    if(existing){if(existing.request_hash!==hash)throw new StoreError('Run ID already belongs to another request',409);return this.get(id);}
    if(this.store.db.prepare("SELECT 1 FROM insight_runs WHERE json_extract(json,'$.status')='running' LIMIT 1").get())throw new StoreError('A personal review is already running',429);
    const {prompt:_,...scope}=input,at=new Date().toISOString(),run:InsightRun={id,operationId:`insight:${id}`,status:'running',createdAt:at,updatedAt:at,scope,events:[{stage:'starting',at}]};
    const observe=(event:AgentProgress)=>{
      this.execution.sync(id);const current=this.raw(id);if(current.status!=='running'||current.events.length>=80||!['starting','model','tool','validating'].includes(event.stage))return;
      const next={stage:event.stage,...(event.phase?{phase:event.phase}:{}),...(event.tool?{tool:event.tool.slice(0,80)}:{}),...(Number.isSafeInteger(event.count)&&event.count!>=0?{count:event.count}:{}),at:new Date().toISOString()};
      current.events.push(next);current.updatedAt=next.at;this.save(current);
    };
    this.execution.start(id,signal=>work(observe,signal,structuredClone(run.snapshot!)),deadline,()=>{run.snapshot=createInsightSnapshot(this.store,id,input);this.store.reserveMetadata(16384+Buffer.byteLength(JSON.stringify(run.snapshot)));this.store.db.prepare('INSERT INTO insight_runs VALUES(?,?,?)').run(id,hash,JSON.stringify(run));});return this.get(id);
  }
  async perform(id:string,input:Scope&{prompt?:string},work:(observe:(event:AgentProgress)=>void,signal:AbortSignal,snapshot:InsightSnapshot)=>Promise<QueryResult>,deadline:RunDeadline&{beforeCommit?:()=>void}={}):Promise<QueryResult>{
    let result:QueryResult|undefined,error:unknown;
    if(deadline.beforeCommit)this.commitGuards.set(id,deadline.beforeCommit);
    try{
    this.start(id,input,async(observe,signal,snapshot)=>{try{result=await work(observe,signal,snapshot);return result;}catch(value){error=value;throw value;}},deadline);
    await this.execution.wait(id);if(this.get(id).status==='completed'&&result)return result;throw error??new StoreError(this.get(id).error?.message??'Review did not complete',this.get(id).error?.code==='timeout'?504:409);
    }finally{this.commitGuards.delete(id);}
  }
  assertSnapshot(snapshot:InsightSnapshot){assertInsightSnapshot(this.store,snapshot);}
  async close(){await this.execution.close();}
}
