import { moteText } from './i18n.js';
import {createHash} from 'node:crypto';
import type {AgentProgress} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {Store,StoreError} from './store.js';
import {safeError} from './diagnostics.js';
import {executionEnvelope} from '@mote/shared/execution';
import {normalizeRun} from './execution.js';
import type {ExecutionEnvelope} from '@mote/shared/execution';

type Scope={after?:string;before?:string;deviceId?:string;timeZone?:string};
export interface InsightRun {
  id:string;status:'running'|'completed'|'failed';createdAt:string;updatedAt:string;
  scope:Scope;events:(AgentProgress&{at:string})[];resultRunId?:string;
  error?:{code:string;message:string};
  execution?:ExecutionEnvelope;
}
/** Durable progress contains fixed stages and tool counts, never prompts or model reasoning. */
export class InsightRuns {
  private pending=new Set<Promise<void>>();
  constructor(private readonly store:Store){
    store.db.exec('CREATE TABLE IF NOT EXISTS insight_runs(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,json TEXT NOT NULL)');
    for(const row of store.db.prepare("SELECT json FROM insight_runs WHERE json_extract(json,'$.status')='running'").all() as {json:string}[]){
      const run=JSON.parse(row.json) as InsightRun;
      this.save({...run,status:'failed',updatedAt:new Date().toISOString(),error:{code:'interrupted',message:moteText("中央节点重启中断了此次回顾，请重试。")}});
    }
  }
  private save(run:InsightRun){this.store.db.prepare('UPDATE insight_runs SET json=? WHERE id=?').run(JSON.stringify(run),run.id);}
  list():InsightRun[]{return (this.store.db.prepare("SELECT json FROM insight_runs ORDER BY json_extract(json,'$.createdAt') DESC,id LIMIT 20").all() as {json:string}[]).map(row=>normalizeRun(JSON.parse(row.json)));}
  get(id:string):InsightRun{
    const row=this.store.db.prepare('SELECT json FROM insight_runs WHERE id=?').get(id) as {json:string}|undefined;
    if(!row)throw new StoreError('Insight run not found',404);return normalizeRun(JSON.parse(row.json));
  }
  detail(id:string){
    const run=this.get(id);
    const row=run.resultRunId?this.store.db.prepare('SELECT json FROM insights WHERE id=?').get(run.resultRunId) as {json:string}|undefined:undefined;
    // Resolve the original on every read. Evidence deletion invalidates reports;
    // a completed job must never restore a cached answer from removed evidence.
    return {...run,...(row?{result:JSON.parse(row.json)}:{})};
  }
  start(id:string,input:Scope&{prompt?:string},work:(observe:(event:AgentProgress)=>void)=>Promise<QueryResult>):InsightRun{
    const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const existing=this.store.db.prepare('SELECT request_hash FROM insight_runs WHERE id=?').get(id);
    if(existing){if(existing.request_hash!==hash)throw new StoreError('Run ID already belongs to another request',409);return this.get(id);}
    if(this.pending.size)throw new StoreError('A personal review is already running',429);
    const {prompt:_,...scope}=input,at=new Date().toISOString();
    const run:InsightRun={id,status:'running',createdAt:at,updatedAt:at,scope,events:[{stage:'starting',at}],execution:{status:'running',attempts:1,allowedActions:['cancel']}};
    this.store.db.prepare("DELETE FROM insight_runs WHERE id IN (SELECT id FROM insight_runs WHERE json_extract(json,'$.status')!='running' ORDER BY json_extract(json,'$.createdAt') DESC LIMIT -1 OFFSET 99)").run();
    this.store.reserveMetadata(16384);
    this.store.db.prepare('INSERT INTO insight_runs VALUES(?,?,?)').run(id,hash,JSON.stringify(run));
    const initial=structuredClone(run);
    const observe=(event:AgentProgress)=>{
      if(run.status!=='running'||run.events.length>=80)return;
      // Explicit projection prevents future observers leaking free-form content.
      if(!['starting','model','tool','validating'].includes(event.stage))return;
      const next={stage:event.stage,...(event.phase?{phase:event.phase}:{}),...(event.tool?{tool:event.tool.slice(0,80)}:{}),...(Number.isSafeInteger(event.count)&&event.count!>=0?{count:event.count}:{}),at:new Date().toISOString()};
      run.events.push(next);run.updatedAt=next.at;this.save(run);
    };
    const task=Promise.resolve().then(()=>work(observe)).then(result=>{
      run.status='completed';run.execution={status:'succeeded',attempts:1,allowedActions:[]};run.resultRunId=result.runId;run.updatedAt=new Date().toISOString();this.save(run);
    }).catch(error=>{const safe=safeError(error);run.status='failed';run.error={code:safe.category,message:safe.message};run.execution=executionEnvelope({status:'failed',attempts:1,errorCode:safe.category});run.updatedAt=new Date().toISOString();this.save(run);});
    this.pending.add(task);void task.finally(()=>this.pending.delete(task)).catch(()=>{});
    return initial;
  }
  async close(){await Promise.allSettled([...this.pending]);}
}
