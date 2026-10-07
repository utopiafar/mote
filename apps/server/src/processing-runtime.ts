import {MaterialConsumerRegistry} from './material-consumers.js';
import {ExecutionEngine,ExecutionFailure,type ExecutionStep,type ExecutionState} from './execution-engine.js';
import type {ProcessingJobView} from '@mote/shared';
import {createHash} from 'node:crypto';
import {Context,type Plugin} from '@deepseek-ai/cordis';
import {z} from 'zod';
import {artifactOutput,type ArtifactOutput} from './evidence-archive.js';
import {parseMaterialRef,type MaterialReadPage,type MaterialStore} from './materials.js';
import {StoreError,type Store} from './store.js';
import {BackendPluginScope} from './backend-plugin-scope.js';
import {InstallationEpochs} from './installation-epochs.js';
import {removeRetiredBudgetState} from './retired-budget-migration.js';

const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)??'null').digest('hex');
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
export type ProcessingLane='extract'|'aggregate'|'semantic'|'memory';
export type ProcessingInput={id:string;fingerprint:string};
export type ProcessingMaterialInput={ref:string;offset:number;length:number};
export interface ContextProcessor {
  id:string;version:string;lane:ProcessingLane;
  deterministic?:boolean;
  produces?:{key:string;kind:string}[];
  /** All inputs are untrusted evidence. No Store or mutation capability is passed. */
  process(input:{observations:ReturnType<Store['evidence']>;materials:MaterialReadPage[];artifacts:{id:string;outputs:NonNullable<ReturnType<Store['archive']['get']>>[]}[];config:Record<string,unknown>;signal:AbortSignal;execution?:{operationId:string;jobId:string;stepId:string}}):Promise<ArtifactOutput[]>;
}
export class ContextProcessorRegistry {
  private processors=new Map<string,ContextProcessor>();
  readonly epochs=new InstallationEpochs();
  register(processor:ContextProcessor){
    if(!/^[a-zA-Z0-9_.-]{1,100}$/.test(processor.id)||!processor.version||!['extract','aggregate','semantic','memory'].includes(processor.lane)||this.processors.has(processor.id))throw Error('Invalid or duplicate context processor');
    if(processor.produces&&(processor.produces.length>16||new Set(processor.produces.map(v=>v.key)).size!==processor.produces.length||processor.produces.some(v=>!(/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(v.key))||!v.kind)))throw Error('Invalid processor product declaration');
    const revoke=this.epochs.install(processor.id);this.processors.set(processor.id,processor);return ()=>{revoke();if(this.processors.get(processor.id)===processor)this.processors.delete(processor.id);};
  }
  get(id:string){return this.processors.get(id);}
  list(){return [...this.processors.values()].map(({process,...metadata})=>metadata);}
}
declare module '@deepseek-ai/cordis' {interface Context {moteContextProcessors:ContextProcessorRegistry;}}
export class ProcessingFailure extends Error {constructor(readonly category:'transient'|'permanent'|'blocked',message:string=category){super(message);}}
const materialInputSchema=z.object({ref:z.string().regex(/^material:mat_[a-f0-9]{64}@[a-f0-9]{64}$/),offset:z.number().int().min(0).default(0),length:z.number().int().min(1).max(12000).default(4000)}).strict();
const productInputSchema=z.discriminatedUnion('authority',[
  z.object({authority:z.literal('material'),ref:materialInputSchema.shape.ref,key:z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,127}$/),offset:z.number().int().nonnegative().default(0),length:z.number().int().min(1).max(12000).default(4000)}).strict(),
  z.object({authority:z.literal('artifact'),id:z.string().regex(/^[a-f0-9]{64}$/),revision:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
const stepSchema=z.object({name:z.string().regex(/^[\w.-]{1,80}$/),processor:z.string().max(100),inputs:z.array(z.string().uuid()).max(100).default([]),materialInputs:z.array(materialInputSchema).max(32).default([]),productInputs:z.array(productInputSchema).max(32).default([]),dependsOn:z.array(z.string().max(80)).max(32).default([]),artifactInputs:z.array(z.object({id:z.string().length(64),revision:z.string().length(64)}).strict()).max(32).default([]),config:z.record(z.unknown()).default({})}).strict();
export type ProcessingStep=z.input<typeof stepSchema>;
const lanePolicy=z.object({concurrency:z.number().int().min(1).max(8),enabled:z.boolean().default(true)}).strict();
const policies=z.object({extract:lanePolicy,aggregate:lanePolicy,semantic:lanePolicy,memory:lanePolicy}).strict();
type ParentGrant={stepId:string;fence:string};
type ConsumerGrant={sourceId:string;bindingId:string;version:string;bindingFingerprint:string};
type Job={productInputs?:z.output<typeof productInputSchema>[];products?:Record<string,string>;consumerGrant?:ConsumerGrant;parentGrant?:ParentGrant;id:string;processor:string;version:string;lane:ProcessingLane;inputs:ProcessingInput[];materialInputs:ProcessingMaterialInput[];config:Record<string,unknown>;dependencies:string[];artifactInputs:{id:string;revision:string}[];outputs:string[]};
const lanes:ProcessingLane[]=['extract','aggregate','semantic','memory'];
/** Durable DAG with fenced commits and per-lane admission. Cordis owns plugin life;
 * this host owns retries, lineage, cancellation and transaction boundaries. */
export class ProcessingRuntime {
  readonly registry=new ContextProcessorRegistry();readonly consumers=new MaterialConsumerRegistry();
  consumerAllowed:(sourceId:string,bindingId:string)=>boolean=()=>false;readonly context:Context;private readonly pluginScope:BackendPluginScope;
  readonly ready:Promise<void>;readonly engine:ExecutionEngine;private owned:boolean;private stopping=false;
  private unregister:Array<()=>Promise<void>>=[];
  constructor(readonly store:Store,plugins:Plugin[]=[],private limits:Partial<Record<ProcessingLane,{concurrency:number;enabled?:boolean}>>={},private now=Date.now,engine?:ExecutionEngine,private materials?:MaterialStore,root?:Context){
    removeRetiredBudgetState(store);
    this.pluginScope=new BackendPluginScope(root);this.context=this.pluginScope.context;
    this.pluginScope.provide('moteContextProcessors',this.registry);this.pluginScope.provide('moteMaterialConsumers',this.consumers);
    store.db.exec(`CREATE TABLE IF NOT EXISTS processing_jobs(id TEXT PRIMARY KEY,lane TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,fence TEXT,error TEXT,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS processing_ready ON processing_jobs(lane,state,available_at);
      CREATE TABLE IF NOT EXISTS processing_dependencies(job_id TEXT NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,dependency_id TEXT NOT NULL REFERENCES processing_jobs(id),PRIMARY KEY(job_id,dependency_id));`);
    if(materials)store.archive.enableMaterialLineage();
    this.engine=engine??new ExecutionEngine(store,now);this.owned=!engine;
    for(const lane of lanes)this.unregister.push(this.engine.register({kind:'context-dag.'+lane,pool:lane,concurrency:()=>this.settings()[lane].concurrency,
      timeoutMs:lane==='semantic'?300000:120000,validate:step=>this.valid(this.job(step.id)),admit:step=>this.admit(this.job(step.id)),execute:(step,signal)=>this.process(this.job(step.id),signal,step),commit:(step,result)=>this.commit(this.job(step.id),result),project:step=>this.project(step),
      classify:error=>{const category=error instanceof ProcessingFailure?error.category:error instanceof z.ZodError?'permanent':error instanceof StoreError?(error.statusCode===409?'blocked':error.statusCode<500?'permanent':'transient'):'transient';return new ExecutionFailure(category,category);},
    }));
    this.unregister.push(this.engine.register({kind:'material-consumer.plan',pool:'material-consumer.plan',concurrency:()=>2,
      validate:step=>{const material=this.materials?.get(String(step.input.ref));return Boolean(material&&this.materials?.get(material.id)?.ref===material.ref&&this.consumerAllowed(material.origin.sourceId,String(step.input.bindingId)));},
      admit:step=>{
        const binding=this.consumers.get(String(step.input.bindingId));
        if(!binding||fingerprint(binding)!==step.input.bindingFingerprint)return new ExecutionFailure('blocked','consumer_binding_unavailable');
        const processor=this.registry.get(binding.processor);
        if(!processor||processor.version!==binding.processorVersion)return new ExecutionFailure('blocked','processor_version_unavailable');
        // Installing a binding is never permission to create a paid semantic task.
        if(!processor.deterministic||!['extract','aggregate'].includes(processor.lane))return new ExecutionFailure('blocked','consumer_authorization_required');
        const material=this.materials?.get(String(step.input.ref));
        if(!material||material.kind!==binding.accepts.kind||material.schemaVersion!==binding.accepts.schemaVersion)return new ExecutionFailure('blocked','consumer_input_contract_mismatch');
        const pin=this.materials?.input(material.ref,[binding.accepts.key]);
        if(!pin?.ready)return new ExecutionFailure(pin?.dependencies.some(dep=>dep.state==='pending')?'waiting':'blocked','consumer_product_unavailable',5000);
      },
      execute:async step=>({installationEpoch:this.consumers.epochs.get(String(step.input.bindingId))}),
      commit:(step,result)=>{
        const binding=this.consumers.get(String(step.input.bindingId));
        if(!binding||fingerprint(binding)!==step.input.bindingFingerprint||!this.consumers.epochs.matches(binding.id,(result as {installationEpoch:string}).installationEpoch))throw new ExecutionFailure('blocked','consumer_instance_unavailable');
        const material=this.materials!.get(String(step.input.ref))!,processor=this.registry.get(binding.processor);
        if(!processor||processor.version!==binding.processorVersion||!processor.deterministic||!['extract','aggregate'].includes(processor.lane))throw new ExecutionFailure('blocked','consumer_authorization_required');
        this.enqueue([{name:'consume',processor:binding.processor,productInputs:[{authority:'material',ref:material.ref,key:binding.accepts.key}],config:binding.config}],undefined,{sourceId:material.origin.sourceId,bindingId:binding.id,version:binding.version,bindingFingerprint:fingerprint(binding)});
      },
    }));
    const pluginScope=this.pluginScope;
    this.ready=(async()=>{for(const plugin of plugins)await pluginScope.install(plugin);})();void this.ready.catch(()=>{});
  }
  enqueue(raw:ProcessingStep[],parentGrant?:ParentGrant,consumerGrant?:ConsumerGrant){
    const steps=z.array(stepSchema).min(1).max(32).parse(raw),names=new Set(steps.map(s=>s.name));
    if(names.size!==steps.length)throw new StoreError('Duplicate workflow step',409);
    const visiting=new Set<string>(),visited=new Set<string>(),ordered:typeof steps=[];
    const visit=(name:string)=>{if(visited.has(name))return;if(visiting.has(name))throw new StoreError('Workflow dependency cycle',409);const step=steps.find(s=>s.name===name);if(!step)throw new StoreError('Missing workflow dependency',409);visiting.add(name);step.dependsOn.forEach(visit);visiting.delete(name);visited.add(name);ordered.push(step);};steps.forEach(s=>visit(s.name));
    const ids=new Map<string,string>(),jobs:Job[]=[];
    for(const step of ordered){
      const processor=this.registry.get(step.processor);if(!processor)throw new StoreError('Processor unavailable',409);
      if(JSON.stringify(step.config).length>16000)throw new StoreError('Processor configuration too large',413);
      for(const ref of step.artifactInputs)if(this.store.archive.revision(ref.id)!==ref.revision)throw new StoreError('Input artifact changed',409);
      for(const product of step.productInputs){if(product.authority==='artifact'){if(this.store.archive.revision(product.id)!==product.revision)throw new StoreError('Input product changed',409);}else if(!this.materials)throw new StoreError('Material products unavailable',409);else this.materials.product(product.ref,product.key,product);}
      if(step.materialInputs.length&&!this.materials)throw new StoreError('Material processor is unavailable',409);
      for(const ref of step.materialInputs){const {id,revision}=parseMaterialRef(ref.ref);if(this.materials?.get(id)?.revision!==revision)throw new StoreError('Input material changed',409);this.materials!.read(ref.ref,{offset:ref.offset,length:ref.length});}
      if(!step.inputs.length&&!step.materialInputs.length&&!step.artifactInputs.length&&!step.dependsOn.length&&!step.productInputs.length)throw new StoreError('Workflow needs execution inputs',400);
      const inputs=[...new Set(step.inputs)].sort().map(id=>{const version=this.store.archive.fingerprint(id);if(!version)throw new StoreError('Workflow evidence unavailable',409);return {id,fingerprint:version};});
      const config=canonical(step.config) as Record<string,unknown>,dependencies=step.dependsOn.map(n=>ids.get(n)!).sort();
      const id=fingerprint([processor.id,processor.version,inputs,step.materialInputs,config,dependencies,step.artifactInputs,...(step.productInputs.length?[step.productInputs]:[])]);ids.set(step.name,id);
      jobs.push({...(consumerGrant?{consumerGrant}:{}),...(step.productInputs.length?{productInputs:step.productInputs}:{}),...(parentGrant?{parentGrant}:{}),id,processor:processor.id,version:processor.version,lane:processor.lane,inputs,materialInputs:step.materialInputs,config,dependencies,artifactInputs:step.artifactInputs,outputs:[]});
    }
    const db=this.store.db,own=!db.isTransaction;db.exec(own?'BEGIN IMMEDIATE':'SAVEPOINT processing_enqueue');try{
      this.store.reserveMetadata(jobs.reduce((n,j)=>n+Buffer.byteLength(JSON.stringify(j))+1024,0));
      for(const job of jobs){db.prepare("INSERT OR IGNORE INTO processing_jobs(id,lane,state,json) VALUES(?,?,'waiting',?)").run(job.id,job.lane,JSON.stringify(job));
        // Saved products are reusable across recipes. An interrupted child can
        // only resume under a freshly authorized parent, never its old lease.
        const state=this.engine.get(job.id)?.state;
        if(parentGrant&&state&&state!=='running'&&state!=='succeeded'){
          db.prepare('UPDATE processing_jobs SET json=? WHERE id=?').run(JSON.stringify(job),job.id);
          if(['stale','cancelled','blocked','failed'].includes(state))this.engine.retry(job.id);
        }
      }
      const operationId='workflow:'+fingerprint(jobs.map(j=>j.id).sort());
      for(const job of jobs)this.engine.enqueue(operationId,'context-dag.'+job.lane,{jobId:job.id},{id:job.id,dependencies:job.dependencies});
      db.exec(own?'COMMIT':'RELEASE processing_enqueue');return Object.fromEntries(ids);
    }catch(error){if(own)db.exec('ROLLBACK');else db.exec('ROLLBACK TO processing_enqueue; RELEASE processing_enqueue');throw error;}
  }
  /** Only a configured source publication creates these durable, independently recoverable requests. */
  observeProducts(ref:string,bindingIds:readonly string[]){
    const material=this.materials?.get(ref);if(!material)throw new StoreError('Material unavailable',409);
    for(const bindingId of bindingIds){
      const binding=this.consumers.get(bindingId),bindingFingerprint=binding?fingerprint(binding):'unavailable';
      this.engine.enqueue('workflow:material:'+material.id,'material-consumer.plan',{ref,bindingId,bindingFingerprint},{id:fingerprint(['material-consumer.plan',ref,bindingId,bindingFingerprint]),generation:{slot:'consumer:'+bindingId,version:material.revision}});
    }
  }
  settings(){const saved=this.store.db.prepare("SELECT value FROM settings WHERE key='processing-policy'").get();return saved?policies.parse(JSON.parse(String(saved.value))):policies.parse(Object.fromEntries(lanes.map(lane=>[lane,{concurrency:this.limits[lane]?.concurrency??(lane==='aggregate'?2:1),enabled:this.limits[lane]?.enabled??true}])));}
  configure(input:unknown){
    const policy=policies.parse(input),db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
    try{
      db.prepare("INSERT INTO settings VALUES('processing-policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(policy));
      for(const row of db.prepare("SELECT e.id,p.lane FROM execution_steps e JOIN processing_jobs p ON p.id=e.id WHERE e.state='blocked' AND e.error='processing_disabled'").all())if(policy[row.lane as ProcessingLane].enabled)this.engine.retry(String(row.id),false);
      if(own)db.exec('COMMIT');return this.settings();
    }catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  view(args:{state?:string;cursor?:number;limit?:number}={}){
    const limit=Math.max(1,Math.min(args.limit??100,100)),clauses:string[]=[],values:(string|number)[]=[];
    if(args.state){clauses.push('state=?');values.push(args.state);}if(args.cursor!==undefined){clauses.push('rowid<?');values.push(args.cursor);}
    const rows=this.store.db.prepare(`SELECT rowid,id,lane,state,attempts,available_at,error,json FROM processing_jobs ${clauses.length?'WHERE '+clauses.join(' AND '):''} ORDER BY rowid DESC LIMIT ?`).all(...values,limit+1);
    const jobs = rows.slice(0,limit).map((row):ProcessingJobView => {
      const job=JSON.parse(String(row.json)) as Job;
      const state=String(row.state);
      return {id:String(row.id),engine:'context-dag' as const,title:job.processor,state,attempts:Number(row.attempts),lane:String(row.lane),reason:row.error?String(row.error):undefined,availableAt:Number(row.available_at),dependencies:job.dependencies,outputs:job.outputs,products:job.products,
        allowedActions:[...(['failed','blocked','cancelled'].includes(state)?['retry-step' as const]:[]),...(!['succeeded','cancelled'].includes(state)?['cancel' as const]:[])]};
    });
    return {jobs,limit,nextCursor:rows.length>limit?Number(rows[limit-1].rowid):null,settings:this.settings(),processors:this.registry.list(),consumers:this.consumers.list(),queues:this.store.db.prepare('SELECT lane,state,COUNT(*) AS count FROM processing_jobs GROUP BY lane,state').all(),delivery:'at_least_once; output commit is fenced; provider retries may incur additional cost'};}
  retry(id:string){this.job(id);const state=this.engine.get(id)?.state;if(!state||!['failed','blocked','cancelled'].includes(state))throw new StoreError('Workflow step cannot be retried in its current state',409);this.engine.retry(id);}
  cancel(id:string){this.job(id);const state=this.engine.get(id)?.state;if(!state||state==='succeeded'||state==='cancelled')throw new StoreError('Workflow step cannot be cancelled in its current state',409);this.engine.cancel(id);}
  private job(id:string):Job{const row=this.store.db.prepare('SELECT json FROM processing_jobs WHERE id=?').get(id);if(!row)throw new StoreError('Workflow step unavailable',404);return JSON.parse(String(row.json));}
  private project(step:ExecutionStep){
    this.store.db.prepare('UPDATE processing_jobs SET state=?,attempts=?,available_at=?,lease_until=0,fence=NULL,error=? WHERE id=?').run(step.state,step.attempts,step.availableAt,step.error??null,step.id);
  }
  /** All execution ownership is in the shared engine, including dependency admission. */
  async tick(){if(this.stopping)return;await this.ready;const ids=this.store.db.prepare("SELECT id FROM execution_steps WHERE (kind LIKE 'context-dag.%' OR kind='material-consumer.plan') AND (state='waiting' OR (state='running' AND lease_until<=?)) ORDER BY rowid LIMIT 1000").all(this.now()).map(row=>String(row.id));await this.engine.drain(ids);}
  private valid(job:Job){
    return !this.stopping&&(!job.consumerGrant||this.consumerAllowed(job.consumerGrant.sourceId,job.consumerGrant.bindingId)&&fingerprint(this.consumers.get(job.consumerGrant.bindingId))===job.consumerGrant.bindingFingerprint)&&(job.productInputs??[]).every(product=>{try{return product.authority==='artifact'?this.store.archive.revision(product.id)===product.revision:Boolean(this.materials?.product(product.ref,product.key,product));}catch{return false;}})&&(!job.parentGrant||job.outputs.length>0||this.engine.isCurrentInputAuthority(job.parentGrant.stepId))&&(job.artifactInputs??[]).every(ref=>this.store.archive.revision(ref.id)===ref.revision)&&(job.materialInputs??[]).every(ref=>{const {id,revision}=parseMaterialRef(ref.ref);return this.materials?.get(id)?.revision===revision;})&&job.inputs.every(i=>this.store.archive.fingerprint(i.id)===i.fingerprint)&&job.dependencies.every(dep=>{
      const parent=this.engine.get(dep);return parent?.state!=='succeeded'||this.job(dep).outputs.every(out=>this.store.archive.get(out));
    });
  }
  private inputs(job:Job){
    const productArtifacts=(job.productInputs??[]).filter((p):p is Extract<z.output<typeof productInputSchema>,{authority:'artifact'}>=>p.authority==='artifact');
    const artifacts=job.dependencies.map(dep=>this.job(dep)).map(parent=>({id:parent.id,outputs:parent.outputs.map(id=>this.store.archive.get(id)!)})).concat([...job.artifactInputs??[],...productArtifacts].map(ref=>({id:ref.id,outputs:[this.store.archive.get(ref.id)!]})));
    const materials=(job.materialInputs??[]).map(ref=>this.materials!.read(ref.ref,{offset:ref.offset,length:ref.length})).concat((job.productInputs??[]).flatMap(product=>product.authority==='material'?this.materials!.product(product.ref,product.key,product).pages:[]));
    return {observations:this.store.evidence(job.inputs.map(i=>i.id)),materials,artifacts};
  }
  private admit(job:Job){
    const processor=this.registry.get(job.processor);
    if(!processor||processor.version!==job.version)return new ExecutionFailure('blocked','processor_version_unavailable');
    if(job.consumerGrant&&(!processor.deterministic||processor.lane!==job.lane||!['extract','aggregate'].includes(processor.lane)))return new ExecutionFailure('blocked','consumer_authorization_required');
    if(!this.settings()[job.lane].enabled)return new ExecutionFailure('blocked','processing_disabled');
  }
  private async process(job:Job,signal:AbortSignal,step:ExecutionStep){
    const installationEpoch=this.registry.epochs.get(job.processor);
    const outputs=await this.registry.get(job.processor)!.process({...this.inputs(job),config:job.config,signal,execution:{operationId:step.operationId,jobId:job.id,stepId:step.id}});
    return {installationEpoch,outputs};
  }
  private commit(job:Job,result:unknown){
    const prepared=result as {installationEpoch?:string;outputs:unknown};
    if(!this.registry.epochs.matches(job.processor,prepared.installationEpoch))throw new ExecutionFailure('blocked','processor_instance_unavailable');
    if(this.registry.get(job.processor)?.version!==job.version)throw new ExecutionFailure('blocked','processor_version_unavailable');
    const outputs=z.array(artifactOutput).min(1).max(16).parse(prepared.outputs);if(JSON.stringify(outputs).length>200000)throw new ProcessingFailure('permanent','output_limit');
    const {artifacts}=this.inputs(job);
    const declarations=this.registry.get(job.processor)?.produces;
    if(declarations&&outputs.some(output=>!declarations.some(d=>d.key===output.metadata.productKey&&d.kind===output.kind))||declarations&&new Set(outputs.map(output=>output.metadata.productKey)).size!==outputs.length)throw new ProcessingFailure('permanent','product_contract_mismatch');
    const productRanges=(job.productInputs??[]).flatMap(product=>product.authority==='material'?this.materials!.product(product.ref,product.key,product).ranges:[]);
    job.outputs=outputs.map((output,index)=>{const artifactId=fingerprint([job.id,index]);this.store.archive.save(artifactId,job.id,job.id,output,job.inputs,job.processor,job.version,fingerprint(job.config),job.inputs.map(i=>i.id),artifacts.flatMap(a=>a.outputs.map(o=>({id:o.id,revision:o.revision}))),[...job.materialInputs??[],...productRanges]);return artifactId;});
    if(declarations)job.products=Object.fromEntries(outputs.map((output,index)=>[String(output.metadata.productKey),job.outputs[index]]));
    this.store.db.prepare('UPDATE processing_jobs SET json=? WHERE id=?').run(JSON.stringify(job),job.id);
  }
  async close(){if(this.owned)await this.engine.close();this.stopping=true;await Promise.all(this.unregister.splice(0).map(stop=>stop()));await this.ready.catch(()=>{});await this.pluginScope.close();}
}
