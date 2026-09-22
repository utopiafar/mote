import {ExecutionEngine,ExecutionFailure,type ExecutionStep,type ExecutionState} from './execution-engine.js';
import type {ProcessingJobView} from '@mote/shared';
import {createHash} from 'node:crypto';
import {Context,type Plugin} from '@deepseek-ai/cordis';
import {z} from 'zod';
import {artifactOutput,type ArtifactOutput} from './evidence-archive.js';
import {StoreError,type Store} from './store.js';

const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
export type ProcessingLane='extract'|'aggregate'|'semantic'|'memory';
export type ProcessingInput={id:string;fingerprint:string};
export interface ContextProcessor {
  id:string;version:string;lane:ProcessingLane;
  /** All inputs are untrusted evidence. No Store or mutation capability is passed. */
  process(input:{observations:ReturnType<Store['evidence']>;artifacts:{id:string;outputs:NonNullable<ReturnType<Store['archive']['get']>>[]}[];config:Record<string,unknown>;signal:AbortSignal}):Promise<ArtifactOutput[]>;
}
export class ContextProcessorRegistry {
  private processors=new Map<string,ContextProcessor>();
  register(processor:ContextProcessor){
    if(!/^[a-zA-Z0-9_.-]{1,100}$/.test(processor.id)||!processor.version||!['extract','aggregate','semantic','memory'].includes(processor.lane)||this.processors.has(processor.id))throw Error('Invalid or duplicate context processor');
    this.processors.set(processor.id,processor);return ()=>{if(this.processors.get(processor.id)===processor)this.processors.delete(processor.id);};
  }
  get(id:string){return this.processors.get(id);}
  list(){return [...this.processors.values()].map(({process,...metadata})=>metadata);}
}
declare module '@deepseek-ai/cordis' {interface Context {moteContextProcessors:ContextProcessorRegistry;}}
export class ProcessingFailure extends Error {constructor(readonly category:'transient'|'permanent'|'blocked',message:string=category){super(message);}}
const stepSchema=z.object({name:z.string().regex(/^[\w.-]{1,80}$/),processor:z.string().max(100),inputs:z.array(z.string().uuid()).max(100).default([]),dependsOn:z.array(z.string().max(80)).max(32).default([]),artifactInputs:z.array(z.object({id:z.string().length(64),revision:z.string().length(64)}).strict()).max(32).default([]),config:z.record(z.unknown()).default({})}).strict();
export type ProcessingStep=z.input<typeof stepSchema>;
const lanePolicy=z.object({concurrency:z.number().int().min(1).max(8),dailyCalls:z.number().int().min(0).max(100000),dailyInputCharacters:z.number().int().min(0).max(1000000000).default(1200000)}).strict();
const policies=z.object({extract:lanePolicy,aggregate:lanePolicy,semantic:lanePolicy,memory:lanePolicy}).strict();
type Job={id:string;processor:string;version:string;lane:ProcessingLane;inputs:ProcessingInput[];config:Record<string,unknown>;dependencies:string[];artifactInputs:{id:string;revision:string}[];outputs:string[]};
const lanes:ProcessingLane[]=['extract','aggregate','semantic','memory'];
/** Durable DAG with fenced commits and per-lane admission. Cordis owns plugin life;
 * this host owns retries, budgets, lineage, cancellation and transaction boundaries. */
export class ProcessingRuntime {
  readonly registry=new ContextProcessorRegistry();readonly context=new Context();
  readonly ready:Promise<void>;readonly engine:ExecutionEngine;private owned:boolean;private stopping=false;
  constructor(readonly store:Store,plugins:Plugin[]=[],private limits:Partial<Record<ProcessingLane,{concurrency:number;dailyCalls:number;dailyInputCharacters?:number}>>={},private now=Date.now,engine?:ExecutionEngine){
    this.context.provide('moteContextProcessors',this.registry);
    store.db.exec(`CREATE TABLE IF NOT EXISTS processing_jobs(id TEXT PRIMARY KEY,lane TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,fence TEXT,error TEXT,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS processing_ready ON processing_jobs(lane,state,available_at);
      CREATE TABLE IF NOT EXISTS processing_dependencies(job_id TEXT NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,dependency_id TEXT NOT NULL REFERENCES processing_jobs(id),PRIMARY KEY(job_id,dependency_id));
      CREATE TABLE IF NOT EXISTS processing_usage(day TEXT NOT NULL,lane TEXT NOT NULL,calls INTEGER NOT NULL,input_characters INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,lane));`);
    if(!store.db.prepare('PRAGMA table_info(processing_usage)').all().some(r=>r.name==='input_characters'))store.db.exec('ALTER TABLE processing_usage ADD COLUMN input_characters INTEGER NOT NULL DEFAULT 0');
    this.engine=engine??new ExecutionEngine(store,now);this.owned=!engine;
    for(const lane of lanes)this.engine.register({kind:'context-dag.'+lane,pool:lane,concurrency:()=>this.settings()[lane].concurrency,
      validate:step=>this.valid(this.job(step.id)),admit:step=>this.admit(this.job(step.id)),execute:(step,signal)=>this.process(this.job(step.id),signal),commit:(step,result)=>this.commit(this.job(step.id),result),project:step=>this.project(step),
      classify:error=>{const category=error instanceof ProcessingFailure?error.category:error instanceof z.ZodError?'permanent':error instanceof StoreError?(error.statusCode===409?'blocked':error.statusCode<500?'permanent':'transient'):'transient';return new ExecutionFailure(category,category);},
    });
    this.migrate();
    this.ready=(async()=>{for(const plugin of plugins)await this.context.plugin(plugin);})();void this.ready.catch(()=>{});
  }
  enqueue(raw:ProcessingStep[]){
    const steps=z.array(stepSchema).min(1).max(32).parse(raw),names=new Set(steps.map(s=>s.name));
    if(names.size!==steps.length)throw new StoreError('Duplicate workflow step',409);
    const visiting=new Set<string>(),visited=new Set<string>(),ordered:typeof steps=[];
    const visit=(name:string)=>{if(visited.has(name))return;if(visiting.has(name))throw new StoreError('Workflow dependency cycle',409);const step=steps.find(s=>s.name===name);if(!step)throw new StoreError('Missing workflow dependency',409);visiting.add(name);step.dependsOn.forEach(visit);visiting.delete(name);visited.add(name);ordered.push(step);};steps.forEach(s=>visit(s.name));
    const ids=new Map<string,string>(),jobs:Job[]=[];
    for(const step of ordered){
      const processor=this.registry.get(step.processor);if(!processor)throw new StoreError('Processor unavailable',409);
      if(JSON.stringify(step.config).length>16000)throw new StoreError('Processor configuration too large',413);
      for(const ref of step.artifactInputs)if(this.store.archive.revision(ref.id)!==ref.revision)throw new StoreError('Input artifact changed',409);
      if(!step.inputs.length&&!step.artifactInputs.length&&!step.dependsOn.length)throw new StoreError('Workflow needs execution inputs',400);
      const inputs=[...new Set(step.inputs)].sort().map(id=>{const version=this.store.archive.fingerprint(id);if(!version)throw new StoreError('Workflow evidence unavailable',409);return {id,fingerprint:version};});
      const config=canonical(step.config) as Record<string,unknown>,dependencies=step.dependsOn.map(n=>ids.get(n)!).sort();
      const id=fingerprint([processor.id,processor.version,inputs,config,dependencies,step.artifactInputs]);ids.set(step.name,id);
      jobs.push({id,processor:processor.id,version:processor.version,lane:processor.lane,inputs,config,dependencies,artifactInputs:step.artifactInputs,outputs:[]});
    }
    const db=this.store.db;db.exec('BEGIN IMMEDIATE');try{
      this.store.reserveMetadata(jobs.reduce((n,j)=>n+Buffer.byteLength(JSON.stringify(j))+1024,0));
      for(const job of jobs){db.prepare("INSERT OR IGNORE INTO processing_jobs(id,lane,state,json) VALUES(?,?,'waiting',?)").run(job.id,job.lane,JSON.stringify(job));for(const dep of job.dependencies)db.prepare('INSERT OR IGNORE INTO processing_dependencies VALUES(?,?)').run(job.id,dep);}
      const operationId='workflow:'+fingerprint(jobs.map(j=>j.id).sort());
      for(const job of jobs)this.engine.enqueue(operationId,'context-dag.'+job.lane,{jobId:job.id},{id:job.id,dependencies:job.dependencies});
      db.exec('COMMIT');return Object.fromEntries(ids);
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  settings(){const saved=this.store.db.prepare("SELECT value FROM settings WHERE key='processing-policy'").get();return saved?policies.parse(JSON.parse(String(saved.value))):policies.parse(Object.fromEntries(lanes.map(lane=>[lane,{concurrency:this.limits[lane]?.concurrency??(lane==='aggregate'?2:1),dailyCalls:this.limits[lane]?.dailyCalls??(lane==='semantic'||lane==='memory'?100:10000),dailyInputCharacters:this.limits[lane]?.dailyInputCharacters??(lane==='semantic'||lane==='memory'?1200000:120000000)}])));}
  configure(input:unknown){const policy=policies.parse(input);this.store.db.prepare("INSERT INTO settings VALUES('processing-policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(policy));return this.settings();}
  view(args:{state?:string;cursor?:number;limit?:number}={}){
    const limit=Math.max(1,Math.min(args.limit??100,100)),clauses:string[]=[],values:(string|number)[]=[];
    if(args.state){clauses.push('state=?');values.push(args.state);}if(args.cursor!==undefined){clauses.push('rowid<?');values.push(args.cursor);}
    const rows=this.store.db.prepare(`SELECT rowid,id,lane,state,attempts,available_at,error,json FROM processing_jobs ${clauses.length?'WHERE '+clauses.join(' AND '):''} ORDER BY rowid DESC LIMIT ?`).all(...values,limit+1);
    const jobs = rows.slice(0,limit).map((row):ProcessingJobView => {
      const job=JSON.parse(String(row.json)) as Job;
      const state=String(row.state);
      return {id:String(row.id),engine:'context-dag' as const,title:job.processor,state,attempts:Number(row.attempts),lane:String(row.lane),reason:row.error?String(row.error):undefined,availableAt:Number(row.available_at),dependencies:job.dependencies,outputs:job.outputs,
        allowedActions:[...(['failed','blocked','cancelled'].includes(state)?['retry-step' as const]:[]),...(!['succeeded','cancelled'].includes(state)?['cancel' as const]:[])]};
    });
    return {jobs,limit,nextCursor:rows.length>limit?Number(rows[limit-1].rowid):null,settings:this.settings(),processors:this.registry.list(),queues:this.store.db.prepare('SELECT lane,state,COUNT(*) AS count FROM processing_jobs GROUP BY lane,state').all(),usage:this.store.db.prepare('SELECT * FROM processing_usage ORDER BY day DESC LIMIT 28').all(),delivery:'at_least_once; output commit is fenced; provider retries may incur additional cost'};}
  retry(id:string){this.engine.retry(id);}
  cancel(id:string){this.engine.cancel(id);}
  private job(id:string):Job{const row=this.store.db.prepare('SELECT json FROM processing_jobs WHERE id=?').get(id);if(!row)throw new StoreError('Workflow step unavailable',404);return JSON.parse(String(row.json));}
  private project(step:ExecutionStep){
    this.store.db.prepare('UPDATE processing_jobs SET state=?,attempts=?,available_at=?,lease_until=0,fence=NULL,error=? WHERE id=?').run(step.state,step.attempts,step.availableAt,step.error??null,step.id);
  }
  private migrate(){
    const db=this.store.db;if(db.prepare("SELECT 1 FROM settings WHERE key='execution-dag-v1'").get())return;
    // Stable job IDs and artifact IDs survive the authority migration. One transaction
    // prevents a partially installed projection from losing the prior retry state.
    db.exec('BEGIN IMMEDIATE');try{
      let cursor=0;
      for(;;){const rows=db.prepare('SELECT rowid,* FROM processing_jobs WHERE rowid>? ORDER BY rowid LIMIT 500').all(cursor);if(!rows.length)break;
        for(const row of rows){const job=JSON.parse(String(row.json)) as Job;this.engine.enqueue('workflow:'+job.id,'context-dag.'+job.lane,{jobId:job.id},{id:job.id,initial:{state:String(row.state) as ExecutionState,attempts:Number(row.attempts),availableAt:Number(row.available_at),error:row.error?String(row.error):undefined}});cursor=Number(row.rowid);}
      }
      db.exec('INSERT OR IGNORE INTO execution_dependencies SELECT job_id,dependency_id FROM processing_dependencies');
      db.prepare("INSERT INTO settings VALUES('execution-dag-v1','1')").run();db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  /** All execution ownership is in the shared engine, including dependency admission. */
  async tick(){if(this.stopping)return;await this.ready;const ids=this.store.db.prepare("SELECT id FROM execution_steps WHERE kind LIKE 'context-dag.%' AND (state='waiting' OR (state='running' AND lease_until<=?)) ORDER BY rowid LIMIT 1000").all(this.now()).map(row=>String(row.id));await this.engine.drain(ids);}
  private valid(job:Job){
    return !this.stopping&&(job.artifactInputs??[]).every(ref=>this.store.archive.revision(ref.id)===ref.revision)&&job.inputs.every(i=>this.store.archive.fingerprint(i.id)===i.fingerprint)&&job.dependencies.every(dep=>{
      const parent=this.engine.get(dep);return parent?.state!=='succeeded'||this.job(dep).outputs.every(out=>this.store.archive.get(out));
    });
  }
  private inputs(job:Job){
    const artifacts=job.dependencies.map(dep=>this.job(dep)).map(parent=>({id:parent.id,outputs:parent.outputs.map(id=>this.store.archive.get(id)!)})).concat((job.artifactInputs??[]).map(ref=>({id:ref.id,outputs:[this.store.archive.get(ref.id)!]})));
    return {observations:this.store.evidence(job.inputs.map(i=>i.id)),artifacts};
  }
  private admit(job:Job){
    const processor=this.registry.get(job.processor);
    if(!processor||processor.version!==job.version)return new ExecutionFailure('blocked','processor_version_unavailable');
    const {observations,artifacts}=this.inputs(job),characters=observations.reduce((n,r)=>n+r.ocrText.length,0)+artifacts.reduce((n,a)=>n+a.outputs.reduce((m,o)=>m+o.text.length,0),0);
    const day=new Date(this.now()).toISOString().slice(0,10),policy=this.settings()[job.lane],db=this.store.db;
    const usage=db.prepare('SELECT calls,input_characters FROM processing_usage WHERE day=? AND lane=?').get(day,job.lane);
    if(characters>policy.dailyInputCharacters)return new ExecutionFailure('blocked','input_budget');
    if(Number(usage?.calls??0)>=policy.dailyCalls||Number(usage?.input_characters??0)+characters>policy.dailyInputCharacters)return new ExecutionFailure('waiting','daily_budget',Date.parse(day)+86400000-this.now());
    // Runs within the same claim transaction, so concurrent admissions cannot spend twice.
    db.prepare('INSERT INTO processing_usage(day,lane,calls,input_characters) VALUES(?,?,1,?) ON CONFLICT(day,lane) DO UPDATE SET calls=calls+1,input_characters=input_characters+excluded.input_characters').run(day,job.lane,characters);
  }
  private process(job:Job,signal:AbortSignal){return this.registry.get(job.processor)!.process({...this.inputs(job),config:job.config,signal});}
  private commit(job:Job,result:unknown){
    const outputs=z.array(artifactOutput).min(1).max(16).parse(result);if(JSON.stringify(outputs).length>200000)throw new ProcessingFailure('permanent','output_limit');
    const {artifacts}=this.inputs(job);
    job.outputs=outputs.map((output,index)=>{const artifactId=fingerprint([job.id,index]);this.store.archive.save(artifactId,job.id,job.id,output,job.inputs,job.processor,job.version,fingerprint(job.config),job.inputs.map(i=>i.id),artifacts.flatMap(a=>a.outputs.map(o=>({id:o.id,revision:o.revision}))));return artifactId;});
    this.store.db.prepare('UPDATE processing_jobs SET json=? WHERE id=?').run(JSON.stringify(job),job.id);
  }
  async close(){if(this.owned)await this.engine.close();this.stopping=true;await this.ready.catch(()=>{});await this.context.fiber.dispose();}
}
