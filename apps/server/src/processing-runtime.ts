import {createHash,randomUUID} from 'node:crypto';
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
const stepSchema=z.object({name:z.string().regex(/^[\w.-]{1,80}$/),processor:z.string().max(100),inputs:z.array(z.string().uuid()).min(1).max(100),dependsOn:z.array(z.string().max(80)).max(32).default([]),artifactInputs:z.array(z.object({id:z.string().length(64),revision:z.string().length(64)}).strict()).max(32).default([]),config:z.record(z.unknown()).default({})}).strict();
export type ProcessingStep=z.input<typeof stepSchema>;
const lanePolicy=z.object({concurrency:z.number().int().min(1).max(8),dailyCalls:z.number().int().min(0).max(100000),dailyInputCharacters:z.number().int().min(0).max(1000000000).default(1200000)}).strict();
const policies=z.object({extract:lanePolicy,aggregate:lanePolicy,semantic:lanePolicy,memory:lanePolicy}).strict();
type Job={id:string;processor:string;version:string;lane:ProcessingLane;inputs:ProcessingInput[];config:Record<string,unknown>;dependencies:string[];artifactInputs:{id:string;revision:string}[];outputs:string[]};
const lanes:ProcessingLane[]=['extract','aggregate','semantic','memory'];
/** Durable DAG with fenced commits and per-lane admission. Cordis owns plugin life;
 * this host owns retries, budgets, lineage, cancellation and transaction boundaries. */
export class ProcessingRuntime {
  readonly registry=new ContextProcessorRegistry();readonly context=new Context();
  readonly ready:Promise<void>;private lanesRunning=new Map<ProcessingLane,Promise<void>>();private stopping=false;private active=new Map<string,AbortController>();private abort=new AbortController();
  constructor(readonly store:Store,plugins:Plugin[]=[],private limits:Partial<Record<ProcessingLane,{concurrency:number;dailyCalls:number;dailyInputCharacters?:number}>>={},private now=Date.now){
    this.context.provide('moteContextProcessors',this.registry);
    store.db.exec(`CREATE TABLE IF NOT EXISTS processing_jobs(id TEXT PRIMARY KEY,lane TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,fence TEXT,error TEXT,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS processing_ready ON processing_jobs(lane,state,available_at);
      CREATE TABLE IF NOT EXISTS processing_dependencies(job_id TEXT NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,dependency_id TEXT NOT NULL REFERENCES processing_jobs(id),PRIMARY KEY(job_id,dependency_id));
      CREATE TABLE IF NOT EXISTS processing_usage(day TEXT NOT NULL,lane TEXT NOT NULL,calls INTEGER NOT NULL,input_characters INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,lane));`);
    if(!store.db.prepare('PRAGMA table_info(processing_usage)').all().some(r=>r.name==='input_characters'))store.db.exec('ALTER TABLE processing_usage ADD COLUMN input_characters INTEGER NOT NULL DEFAULT 0');
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
      const artifactIds=step.artifactInputs.flatMap(ref=>{const artifact=this.store.archive.get(ref.id);if(!artifact||artifact.revision!==ref.revision)throw new StoreError('Input artifact changed',409);return artifact.members;});
      const inputs=[...new Set([...step.inputs,...artifactIds,...step.dependsOn.flatMap(name=>jobs.find(job=>job.id===ids.get(name))!.inputs.map(i=>i.id))])].sort().map(id=>{const version=this.store.archive.fingerprint(id);if(!version)throw new StoreError('Workflow evidence unavailable',409);return {id,fingerprint:version};});
      if(inputs.length>100)throw new StoreError('Workflow transitive input budget exceeds 100 observations',413);
      const config=canonical(step.config) as Record<string,unknown>,dependencies=step.dependsOn.map(n=>ids.get(n)!).sort();
      const id=fingerprint([processor.id,processor.version,inputs,config,dependencies,step.artifactInputs]);ids.set(step.name,id);
      jobs.push({id,processor:processor.id,version:processor.version,lane:processor.lane,inputs,config,dependencies,artifactInputs:step.artifactInputs,outputs:[]});
    }
    const db=this.store.db;db.exec('BEGIN IMMEDIATE');try{
      this.store.reserveMetadata(jobs.reduce((n,j)=>n+Buffer.byteLength(JSON.stringify(j))+1024,0));
      for(const job of jobs){db.prepare("INSERT OR IGNORE INTO processing_jobs(id,lane,state,json) VALUES(?,?,'waiting',?)").run(job.id,job.lane,JSON.stringify(job));for(const dep of job.dependencies)db.prepare('INSERT OR IGNORE INTO processing_dependencies VALUES(?,?)').run(job.id,dep);}
      db.exec('COMMIT');return Object.fromEntries(ids);
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  settings(){const saved=this.store.db.prepare("SELECT value FROM settings WHERE key='processing-policy'").get();return saved?policies.parse(JSON.parse(String(saved.value))):policies.parse(Object.fromEntries(lanes.map(lane=>[lane,{concurrency:this.limits[lane]?.concurrency??(lane==='aggregate'?2:1),dailyCalls:this.limits[lane]?.dailyCalls??(lane==='semantic'||lane==='memory'?100:10000),dailyInputCharacters:this.limits[lane]?.dailyInputCharacters??(lane==='semantic'||lane==='memory'?1200000:120000000)}])));}
  configure(input:unknown){const policy=policies.parse(input);this.store.db.prepare("INSERT INTO settings VALUES('processing-policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(policy));return this.settings();}
  view(){return {settings:this.settings(),processors:this.registry.list(),queues:this.store.db.prepare('SELECT lane,state,COUNT(*) AS count FROM processing_jobs GROUP BY lane,state').all(),usage:this.store.db.prepare('SELECT * FROM processing_usage ORDER BY day DESC LIMIT 28').all(),delivery:'at_least_once; output commit is fenced; provider retries may incur additional cost'};}
  retry(id:string){this.store.db.prepare("UPDATE processing_jobs SET state='waiting',attempts=0,available_at=0,error=NULL WHERE id=? AND state IN ('failed','blocked','cancelled')").run(id);}
  cancel(id:string){this.active.get(id)?.abort();this.store.db.prepare("UPDATE processing_jobs SET state='cancelled',fence=NULL,error='cancelled' WHERE id=? AND state!='succeeded'").run(id);}
  tick(){if(this.stopping)return Promise.resolve();return this.ready.then(()=>this.run());}
  private async run(){
    const db=this.store.db,now=this.now();
    db.prepare("UPDATE processing_jobs SET state=CASE WHEN attempts>=4 THEN 'failed' ELSE 'waiting' END,fence=NULL,error='lease_expired' WHERE state='running' AND lease_until<=?").run(now);
    // A terminal dependency blocks descendants explicitly instead of leaving an invisible queue.
    db.exec("UPDATE processing_jobs SET state='blocked',error='dependency_failed' WHERE state='waiting' AND EXISTS(SELECT 1 FROM processing_dependencies d JOIN processing_jobs p ON p.id=d.dependency_id WHERE d.job_id=processing_jobs.id AND p.state IN ('failed','cancelled','blocked','stale'))");
    const started:Promise<void>[]=[];
    for(const lane of lanes){
      if(this.stopping||this.lanesRunning.has(lane))continue;
      const task=(async()=>{
      const concurrency=this.settings()[lane].concurrency;
      const rows=db.prepare("SELECT id FROM processing_jobs j WHERE lane=? AND state='waiting' AND available_at<=? AND attempts<4 AND NOT EXISTS(SELECT 1 FROM processing_dependencies d JOIN processing_jobs p ON p.id=d.dependency_id WHERE d.job_id=j.id AND p.state!='succeeded') ORDER BY rowid LIMIT ?").all(lane,now,concurrency);
      await Promise.all(rows.map(row=>this.execute(String(row.id))));
      })().finally(()=>this.lanesRunning.delete(lane));
      this.lanesRunning.set(lane,task);started.push(task);
    }
    await Promise.all(started);
  }
  private async execute(id:string){
    const db=this.store.db,row=db.prepare("SELECT * FROM processing_jobs WHERE id=? AND state='waiting'").get(id);if(!row||this.stopping)return;
    const job=JSON.parse(String(row.json)) as Job,processor=this.registry.get(job.processor);
    if(!processor||processor.version!==job.version){db.prepare("UPDATE processing_jobs SET state='blocked',error='processor_version_unavailable' WHERE id=?").run(id);return;}
    const valid=()=>(job.artifactInputs??[]).every(ref=>this.store.archive.get(ref.id)?.revision===ref.revision)&&job.inputs.every(i=>this.store.archive.fingerprint(i.id)===i.fingerprint)&&job.dependencies.every(dep=>{
      const parent=db.prepare("SELECT json FROM processing_jobs WHERE id=? AND state='succeeded'").get(dep);return parent&&(JSON.parse(String(parent.json)) as Job).outputs.every(out=>this.store.archive.get(out));
    });
    if(!valid()){db.prepare("UPDATE processing_jobs SET state='stale',error='evidence_changed' WHERE id=?").run(id);return;}
    const now=this.now(),day=new Date(now).toISOString().slice(0,10),policy=this.settings()[job.lane],daily=policy.dailyCalls;
    const inputCharacters=this.store.evidence(job.inputs.map(i=>i.id)).reduce((n,r)=>n+r.ocrText.length,0);
    const fence=randomUUID();db.exec('BEGIN IMMEDIATE');
    try{
      const usage=db.prepare('SELECT calls,input_characters FROM processing_usage WHERE day=? AND lane=?').get(day,job.lane);
      if(inputCharacters>policy.dailyInputCharacters){db.prepare("UPDATE processing_jobs SET state='blocked',error='input_budget' WHERE id=?").run(id);db.exec('COMMIT');return;}
      if(Number(usage?.calls??0)>=daily||Number(usage?.input_characters??0)+inputCharacters>policy.dailyInputCharacters){db.prepare("UPDATE processing_jobs SET available_at=?,error='daily_budget' WHERE id=?").run(Date.parse(day)+86400000,id);db.exec('COMMIT');return;}
      db.prepare("UPDATE processing_jobs SET state='running',fence=?,attempts=attempts+1,lease_until=?,error=NULL WHERE id=?").run(fence,now+130000,id);
      db.prepare('INSERT INTO processing_usage(day,lane,calls,input_characters) VALUES(?,?,1,?) ON CONFLICT(day,lane) DO UPDATE SET calls=calls+1,input_characters=input_characters+excluded.input_characters').run(day,job.lane,inputCharacters);db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    const controller=new AbortController();this.active.set(id,controller);
    const signal=AbortSignal.any([this.abort.signal,controller.signal,AbortSignal.timeout(120000)]);
    let abortListener:(()=>void)|undefined;
    try{
      const artifacts=job.dependencies.map(dep=>JSON.parse(String(db.prepare('SELECT json FROM processing_jobs WHERE id=?').get(dep)!.json)) as Job).map(parent=>({id:parent.id,outputs:parent.outputs.map(id=>this.store.archive.get(id)!)})).concat((job.artifactInputs??[]).map(ref=>({id:ref.id,outputs:[this.store.archive.get(ref.id)!]})));
      const aborted=new Promise<never>((_,reject)=>{abortListener=()=>reject(new ProcessingFailure('transient','cancelled'));signal.addEventListener('abort',abortListener,{once:true});if(signal.aborted)abortListener();});
      const outputs=z.array(artifactOutput).min(1).max(16).parse(await Promise.race([processor.process({observations:this.store.evidence(job.inputs.map(i=>i.id)),artifacts,config:job.config,signal}),aborted]));
      if(JSON.stringify(outputs).length>200000)throw new ProcessingFailure('permanent','output_limit');
      if(this.stopping||signal.aborted||db.prepare('SELECT fence FROM processing_jobs WHERE id=?').get(id)?.fence!==fence)return;
      db.exec('BEGIN IMMEDIATE');try{
        if(!valid())throw new ProcessingFailure('permanent','evidence_changed');
        job.outputs=outputs.map((output,index)=>{const artifactId=fingerprint([id,index]);this.store.archive.save(artifactId,id,id,output,job.inputs,job.processor,job.version,fingerprint(job.config));return artifactId;});
        db.prepare("UPDATE processing_jobs SET state='succeeded',fence=NULL,json=? WHERE id=? AND fence=?").run(JSON.stringify(job),id,fence);db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
    }catch(error){
      const category=error instanceof ProcessingFailure?error.category:error instanceof z.ZodError?'permanent':error instanceof StoreError?(error.statusCode===409?'blocked':error.statusCode<500?'permanent':'transient'):'transient';
      const state=this.stopping?'waiting':category==='blocked'?'blocked':category==='permanent'||Number(row.attempts)>=3?'failed':'waiting';
      db.prepare('UPDATE processing_jobs SET state=?,error=?,available_at=?,fence=NULL WHERE id=? AND fence=?').run(state,this.stopping?'interrupted':category,now+Math.min(3600000,1000*2**Number(row.attempts)),id,fence);
    }finally{this.active.delete(id);if(abortListener)signal.removeEventListener('abort',abortListener);}
  }
  async close(){this.stopping=true;this.abort.abort();await Promise.allSettled([...this.lanesRunning.values()]);await this.ready.catch(()=>{});await this.context.fiber.dispose();}
}
