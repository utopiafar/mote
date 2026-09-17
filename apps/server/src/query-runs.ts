import { moteText } from './i18n.js';
import {createHash} from 'node:crypto';
import type {AgentProgress} from '@mote/agent';
import {Store,StoreError} from './store.js';
import {safeError} from './diagnostics.js';
export interface QueryRun {
  id:string;status:'running'|'completed'|'failed';createdAt:string;updatedAt:string;
  evidenceRevision?:number;conversationId?:string;turnId?:string;events:(AgentProgress&{at:string})[];
  error?:{code:string;message:string};
}
/** Only identifiers and projected execution metadata; answers resolve from the conversation vault. */
export class QueryRuns {
  private pending=new Set<Promise<void>>();
  constructor(private store:Store){
    store.db.exec('CREATE TABLE IF NOT EXISTS query_runs(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,json TEXT NOT NULL)');
    for(const row of store.db.prepare("SELECT json FROM query_runs WHERE json_extract(json,'$.status')='running'").all() as {json:string}[]){const run=JSON.parse(row.json);this.save({...run,status:'failed',updatedAt:new Date().toISOString(),error:{code:'interrupted',message:moteText("中央节点重启中断了此次问答，请重新提问。")}});}
  }
  private save(run:QueryRun){this.store.db.prepare('UPDATE query_runs SET json=? WHERE id=?').run(JSON.stringify(run),run.id);}
  list():QueryRun[]{return (this.store.db.prepare("SELECT json FROM query_runs ORDER BY json_extract(json,'$.createdAt') DESC LIMIT 100").all() as {json:string}[]).map(r=>JSON.parse(r.json));}
  get(id:string):QueryRun{const row=this.store.db.prepare('SELECT json FROM query_runs WHERE id=?').get(id) as {json:string}|undefined;if(!row)throw new StoreError('Query run not found',404);return JSON.parse(row.json);}
  start(id:string,input:unknown,work:(observe:(event:AgentProgress)=>void)=>Promise<{conversationId:string;turnId:string}>){
    const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const existing=this.store.db.prepare('SELECT request_hash FROM query_runs WHERE id=?').get(id);
    if(existing){if(existing.request_hash!==hash)throw new StoreError('Run ID belongs to a different request',409);return this.get(id);}
    if(this.pending.size>=2)throw new StoreError('Two conversations are already running',429);
    const at=new Date().toISOString();const run:QueryRun={evidenceRevision:this.store.deletionRevision(),id,status:'running',createdAt:at,updatedAt:at,events:[],...((input as {conversationId?:string}).conversationId?{conversationId:(input as {conversationId:string}).conversationId}:{})};
    this.store.reserveMetadata(32768);
    this.store.db.prepare('INSERT INTO query_runs VALUES(?,?,?)').run(id,hash,JSON.stringify(run));
    const initial=structuredClone(run);
    const observe=(e:AgentProgress)=>{
      if(run.evidenceRevision!==this.store.deletionRevision())return;
      if(run.status!=='running'||!['starting','model','tool','validating'].includes(e.stage))return;
      const next:AgentProgress&{at:string}={stage:e.stage,at:new Date().toISOString(),...(typeof e.message==='string'?{message:e.message.slice(0,600)}:{}),...(e.tool?{tool:e.tool.slice(0,80)}:{}),...(e.phase?{phase:e.phase}:{}),...(Number.isSafeInteger(e.step)?{step:e.step}:{}),...(Number.isSafeInteger(e.count)?{count:e.count}:{})};
      run.events.push(next);if(run.events.length>120)run.events.shift();run.updatedAt=next.at;this.save(run);
    };
    const task=Promise.resolve().then(()=>work(observe)).then(result=>{Object.assign(run,{conversationId:result.conversationId,turnId:result.turnId,status:'completed'});}).catch(e=>{const safe=safeError(e);run.status='failed';run.error={code:safe.category,message:safe.message};}).finally(()=>{if(run.evidenceRevision!==this.store.deletionRevision())run.events=run.events.map(({message:_,...e})=>e);run.updatedAt=new Date().toISOString();this.save(run);});
    this.pending.add(task);void task.finally(()=>this.pending.delete(task)).catch(()=>{});return initial;
  }
  async close(){await Promise.allSettled([...this.pending]);}
}
