import {ExecutionEngine,ExecutionFailure,type ExecutionStep} from './execution-engine.js';
import {withExecutionCancellation} from './execution-cancellation.js';
import {requestLocale} from './i18n.js';
import {AgentResponseError,AgentTimeoutError,type QueryInput} from '@mote/agent';
import {memoryProfile} from './memory-profiles.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {modelProfileIdSchema} from './model-settings.js';
import {ProviderFailure,executionEnvelope,type ExecutionEnvelope,type QueryResult} from '@mote/shared';
import {Store,StoreError,sha256} from './store.js';
import {MemoryStore,MemoryOutputValidationError,MEMORY_EXTRACTION_PROMPT,MEMORY_SKILL_VERSION,memoryEvidenceFingerprint,type EvidenceRange} from './memory.js';

import type {MemoryValidationDetails} from './memory-validation.js';
import type {ModelConfiguration} from './model-configuration.js';
import {semanticProductsSchema} from './semantic-extraction.js';
import {memoryReviewReceipt} from './memory-review.js';
import type {MemoryReviewReceipt} from './memory-schema.js';

export type MemoryValidationFailure={at:string;code:string;phase:'extract'|'review';attempt?:number;runId?:string;details?:MemoryValidationDetails};
export type MemoryValidationFailureEvent=MemoryValidationFailure&{jobId:string;batchId:string;batchIndex:number};

type Chunk=EvidenceRange&{profile?:'personal'|'coding';profileVersion?:string;group?:string;fingerprint:string;key:string};
export type MemoryBatch={configuration?:ModelConfiguration;id:string;index:number;status:'pending'|'running'|'completed'|'failed'|'invalidated';evidenceRanges:EvidenceRange[];attempts:number;memoryIds:string[];availableAt?:number;errorCode?:string;validationFailures?:MemoryValidationFailure[];phase?:'extract'|'review';stage?:string;startedAt?:string;lastActivityAt?:string;execution?:ExecutionEnvelope;splitDepth?:number;splitHistory?:{at:string;errorCode:'provider_timeout';attempts:number;evidenceRanges:EvidenceRange[]}[]};
type StoredBatch=MemoryBatch&{artifactRefs?:{id:string;revision:string}[];chunks:Chunk[];skillVersion?:string;resourceEvidenceIds?:string[]};
export type MemoryJob={configuration?:ModelConfiguration;artifactRefs?:{id:string;revision:string}[];language?:'zh-CN'|'en';id:string;modelProfileId?:string;modelOverride?:string;importJobId?:string;originKey?:string;timeZone?:string;status:'queued'|'running'|'completed'|'failed'|'waiting_for_model'|'cancelled'|'paused'|'pausing';createdAt:string;updatedAt:string;evidenceIds:string[];skillVersion:string;totalBatches:number;completedBatches:number;failedBatches:number;skippedChunks:number;memoryIds:string[];availableAt?:number;errorCode?:string;queuePosition?:number;runningBatches?:number;pendingBatches?:number;lastSavedAt?:string;execution?:ExecutionEnvelope};
export type MemoryJobDetail=MemoryJob&{batches:MemoryBatch[]};
export type MemoryPipelineQuery={contextTime?:string;signal?:AbortSignal;language?:'zh-CN'|'en';modelProfileId?:string;modelOverride?:string;question:string;skill:'memory-extraction'|'coding-memory';responseMode:'memory-extraction';evidenceIds:string[];evidenceRanges:EvidenceRange[];timeZone?:string;validateOutput?:QueryInput['validateOutput'];onProgress?:QueryInput['onProgress'];onTrace?:QueryInput['onTrace'];traceContext?:QueryInput['traceContext']};
export type MemoryPipelineOptions={configuration?:(profileId?:string,modelOverride?:string)=>ModelConfiguration;executor?:ExecutionEngine;concurrency?:()=>number;onValidationFailure?:(event:MemoryValidationFailureEvent)=>void;requireAdmission?:boolean;review?:(input:MemoryPipelineQuery,result:QueryResult)=>Promise<QueryResult>;store:Store;memories:MemoryStore;query:(input:MemoryPipelineQuery)=>Promise<QueryResult>;model:(profileId?:string)=>string;configured:(profileId?:string)=>boolean;skillVersion?:string;batchCharacters?:number};

type BatchOutput={result:QueryResult;reviewReceipt?:MemoryReviewReceipt;model:string;profile:'personal'|'coding';skillVersion:string;ranges:EvidenceRange[];chunks:Chunk[]};

/** Durable work references original evidence; jobs never persist extra copies of private text. */
export class MemoryPipeline {
  private active=new Map<string,Promise<MemoryJobDetail>>();
  readonly engine:ExecutionEngine;
  private owned:boolean;
  private completions=new Map<string,{resolve:(job:MemoryJobDetail)=>void;reject:(error:unknown)=>void}>();
  private scheduled=false;
  /** Notify completion observers and ask the shared engine to fill available slots. */
  wake(){if(this.scheduled)return;this.scheduled=true;queueMicrotask(()=>{this.scheduled=false;this.settle();if(!this.closed)void this.engine.tick().catch(error=>{for(const done of this.completions.values())done.reject(error);this.completions.clear();this.active.clear();});});}
  private settle(){
    for(const id of this.active.keys()){
      this.refreshJob(id);const job=this.storedJob(id),counts=this.counts(id);
      if(Number(counts.running)===0&&(this.closed||['paused','cancelled','waiting_for_model','completed','failed'].includes(job.status)||Number(counts.pending)===0)){
        const done=this.completions.get(id);this.completions.delete(id);this.active.delete(id);done?.resolve(this.get(id));
      }
    }
  }
  private queuePosition(id:string){const row=this.store.db.prepare("SELECT count(*) n FROM memory_jobs WHERE json_extract(json,'$.status') IN ('queued','running') AND rowid<=(SELECT rowid FROM memory_jobs WHERE id=?)").get(id);return Number(row?.n)||undefined;}
  private steps(id:string){return this.store.db.prepare("SELECT id FROM execution_steps WHERE operation_id=? AND kind='memory.batch'").all('memory:'+id).map(row=>String(row.id));}
  pause(id:string){const job=this.storedJob(id);if(['queued','running'].includes(job.status)){job.status=Number(this.counts(id).running)>0?'pausing':'paused';this.saveJob(job);this.wake();}return this.get(id);}
  resume(id:string){const job=this.storedJob(id);if(!['paused','pausing'].includes(job.status))return;job.status='queued';this.saveJob(job);this.prepare(id);void this.run(id).catch(()=>{});this.wake();}
  cancel(id:string){const job=this.storedJob(id);if(!['completed','cancelled'].includes(job.status)){job.status='cancelled';this.saveJob(job);for(const step of this.steps(id))this.engine.cancel(step);this.wake();}return this.get(id);}

  private closed=false;
  private budget:number;
  constructor(private options:MemoryPipelineOptions){
    this.budget=options.batchCharacters??12000;
    if(!Number.isSafeInteger(this.budget)||this.budget<256||this.budget>12000)throw new StoreError('Memory batch budget must be 256–12000 characters');
    this.initializeCounts();
    this.engine=options.executor??new ExecutionEngine(this.store);this.owned=!options.executor;
    this.recover();
    this.engine.register({kind:'memory.batch',pool:'memory.batch',concurrency:()=>this.options.concurrency?.()??1,maxAttempts:1,timeoutMs:3600000,
      resourceKeys:step=>(step.input.evidenceIds as string[]).map(id=>'memory-evidence:'+id),
      validate:step=>this.validateStep(step),admit:step=>{
        const job=this.storedJob(String(step.input.jobId));
        if(['paused','pausing'].includes(job.status))return new ExecutionFailure('blocked','paused');
        if(job.status==='cancelled'||this.closed)return new ExecutionFailure('blocked','cancelled');
        // Lifecycle recovery must still honor its saved retry window and enablement.
        if(!this.active.has(job.id))return new ExecutionFailure('blocked','awaiting_activation');
        if(!this.options.configured(job.modelProfileId))return new ExecutionFailure('blocked','model_unconfigured');
        if(this.options.configuration){const current=this.options.configuration(job.modelProfileId,job.modelOverride);if(job.configuration&&job.configuration.fingerprint!==current.fingerprint)return new ExecutionFailure('blocked','configuration_changed');if(!job.configuration){job.configuration=structuredClone(current);this.store.reserveMetadata(Buffer.byteLength(JSON.stringify(current)));this.saveJob(job);}}
      },
      execute:(step,signal)=>{const fence=this.store.db.prepare('SELECT fence FROM execution_steps WHERE id=?').get(step.id)?.fence;return this.execute(String(step.input.jobId),String(step.input.batchId),signal,()=>typeof fence==='string'&&this.engine.isCurrentGrant(step.id,fence));},
      commit:(step,output)=>this.commitBatch(step,output as BatchOutput|undefined),
      project:step=>this.projectStep(step),
    });
  }
  private counts(id:string){return this.store.db.prepare('SELECT * FROM memory_job_counts WHERE job_id=?').get(id)??{total:0,completed:0,failed:0,running:0,pending:0,attempts:0};}
  private initializeCounts(){
    const db=this.store.db;
    const status=(v:string)=>`json_extract(${v}.json,'$.status')`;
    const delta=(v:string,sign:string)=>`UPDATE memory_job_counts SET total=total${sign}1,completed=completed${sign}(${status(v)}='completed'),failed=failed${sign}(${status(v)} IN ('failed','invalidated')),running=running${sign}(${status(v)}='running'),pending=pending${sign}(${status(v)}='pending'),attempts=attempts${sign}coalesce(json_extract(${v}.json,'$.attempts'),0) WHERE job_id=${v}.job_id;`;
    db.exec(`CREATE INDEX IF NOT EXISTS memory_batches_ready ON memory_batches(job_id,json_extract(json,'$.status'),idx);
      CREATE TABLE IF NOT EXISTS memory_job_counts(job_id TEXT PRIMARY KEY REFERENCES memory_jobs(id) ON DELETE CASCADE,total INTEGER NOT NULL DEFAULT 0,completed INTEGER NOT NULL DEFAULT 0,failed INTEGER NOT NULL DEFAULT 0,running INTEGER NOT NULL DEFAULT 0,pending INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TRIGGER IF NOT EXISTS batch_count_insert AFTER INSERT ON memory_batches BEGIN INSERT OR IGNORE INTO memory_job_counts(job_id) VALUES(new.job_id); ${delta('new','+')} END;
      CREATE TRIGGER IF NOT EXISTS batch_count_delete AFTER DELETE ON memory_batches BEGIN ${delta('old','-')} END;
      CREATE TRIGGER IF NOT EXISTS batch_count_update AFTER UPDATE OF json ON memory_batches BEGIN ${delta('old','-')} ${delta('new','+')} END;
      INSERT INTO memory_job_counts SELECT job_id,count(*),sum(json_extract(json,'$.status')='completed'),sum(json_extract(json,'$.status') IN ('failed','invalidated')),sum(json_extract(json,'$.status')='running'),sum(json_extract(json,'$.status')='pending'),sum(coalesce(json_extract(json,'$.attempts'),0)) FROM memory_batches WHERE job_id NOT IN (SELECT job_id FROM memory_job_counts) GROUP BY job_id;`);
  }
  private get store(){return this.options.store;}
  private storedJob(id:string):MemoryJob {
    const row=this.store.db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(id) as {json:string}|undefined;
    if(!row)throw new StoreError('Memory job not found',404);return JSON.parse(row.json);
  }
  private batches(id:string):StoredBatch[]{return (this.store.db.prepare('SELECT json FROM memory_batches WHERE job_id=? ORDER BY idx').all(id) as {json:string}[]).map(row=>JSON.parse(row.json));}
  private batch(id:string):StoredBatch {const row=this.store.db.prepare('SELECT json FROM memory_batches WHERE id=?').get(id);if(!row)throw new StoreError('Memory batch not found',404);return JSON.parse(String(row.json));}
  private saveJob(job:MemoryJob){const {batches:_batches,...value}=job as MemoryJobDetail;value.updatedAt=new Date().toISOString();this.store.db.prepare('UPDATE memory_jobs SET json=? WHERE id=?').run(JSON.stringify(value),job.id);}
  private saveBatch(batch:StoredBatch){this.store.db.prepare('UPDATE memory_batches SET json=? WHERE id=?').run(JSON.stringify(batch),batch.id);}
  private checkpoint(chunk:Chunk){return Boolean(this.store.db.prepare('SELECT key FROM memory_checkpoints WHERE key=?').get(chunk.key));}
  get(id:string):MemoryJobDetail {
    const job=this.storedJob(id),batches=this.batches(id),failedBatches=batches.filter(b=>b.status==='failed'||b.status==='invalidated').length;
    const memoryIds=[...new Set(batches.flatMap(b=>b.memoryIds))].filter(memoryId=>this.store.db.prepare('SELECT id FROM memories WHERE id=?').get(memoryId));
    const status=job.status==='completed'&&failedBatches?'failed':job.status==='queued'&&batches.some(b=>b.status==='running')?'running':job.status,attempts=batches.reduce((sum,b)=>sum+b.attempts,0);
    return {...job,status,queuePosition:this.queuePosition(id),runningBatches:batches.filter(b=>b.status==='running').length,pendingBatches:batches.filter(b=>b.status==='pending').length,lastSavedAt:(this.store.db.prepare("SELECT max(created_at) AS at FROM memories WHERE id IN (SELECT value FROM json_each(?))").get(JSON.stringify(memoryIds)) as {at?:string})?.at??undefined,totalBatches:batches.length,completedBatches:batches.filter(b=>b.status==='completed').length,failedBatches,memoryIds,
      execution:executionEnvelope({status:status==='paused'?'waiting':status==='pausing'?'running':status,attempts,errorCode:job.errorCode??batches.find(b=>b.errorCode)?.errorCode,availableAt:job.availableAt,updatedAt:job.updatedAt}),
      batches:batches.map(({chunks:_chunks,resourceEvidenceIds:_resources,...batch})=>({...batch,execution:executionEnvelope({status:batch.status==='pending'?'queued':batch.status==='completed'?'succeeded':batch.status==='invalidated'?'skipped':batch.status,attempts:batch.attempts,errorCode:batch.errorCode,availableAt:batch.availableAt})}))};
  }
  list(limit=30):MemoryJob[]{return this.store.db.prepare("SELECT json_remove(json,'$.evidenceIds','$.memoryIds','$.artifactRefs') json FROM memory_jobs ORDER BY created_at DESC,id DESC LIMIT ?").all(Math.max(1,Math.min(limit,100))).map(row=>{
    const job=JSON.parse(String(row.json)) as MemoryJob;
    const counts=this.counts(job.id);
    return {...job,status:job.status==='completed'&&Number(counts.failed)>0?'failed':job.status,evidenceIds:[],memoryIds:[],totalBatches:Number(counts.total),completedBatches:Number(counts.completed??0),failedBatches:Number(counts.failed??0),runningBatches:Number(counts.running??0),pendingBatches:Number(counts.pending??0),queuePosition:this.queuePosition(job.id),execution:executionEnvelope({status:job.status==='paused'?'waiting':job.status==='pausing'?'running':job.status,attempts:Number(counts.attempts??0),errorCode:job.errorCode,availableAt:job.availableAt,updatedAt:job.updatedAt})};
  });}
  createFromArtifacts(artifactIds:string[],importJobId:string,batchCharacters=12000){
    const artifacts=artifactIds.map(id=>this.store.archive.get(id)).filter(a=>a?.kind==='semantic');
    const ranges=artifacts.flatMap(a=>z.array(z.object({id:z.string().uuid(),offset:z.number().int().min(0),length:z.number().int().min(1).max(12000)})).parse(a!.metadata.evidenceRanges??[]));
    if(!ranges.length)return undefined;
    return this.create({evidenceIds:[...new Set(ranges.map(r=>r.id))],evidenceRanges:ranges,artifactRefs:artifacts.map(a=>({id:a!.id,revision:a!.revision})),importJobId,batchCharacters});
  }
  create(raw:{artifactRefs?:{id:string;revision:string}[];evidenceRanges?:EvidenceRange[];modelProfileId?:string;modelOverride?:string;evidenceIds:string[];importJobId?:string;originKey?:string;timeZone?:string;batchCharacters?:number}):MemoryJobDetail {
    if(this.closed)throw new StoreError('Memory pipeline is closed',503);
    const input=z.object({artifactRefs:z.array(z.object({id:z.string().length(64),revision:z.string().length(64)})).max(2000).optional(),evidenceRanges:z.array(z.object({id:z.string().uuid(),offset:z.number().int().min(0),length:z.number().int().min(1).max(12000)})).max(10000).optional(),modelProfileId:modelProfileIdSchema.optional(),modelOverride:z.string().trim().min(1).max(512).refine(v=>!/[\u0000-\u001f\u007f]/.test(v)).optional(),originKey:z.string().max(200).optional(),batchCharacters:z.number().int().min(256).max(12000).optional(),evidenceIds:z.array(z.string().uuid()).min(1).max(20000),importJobId:z.string().max(200).optional(),timeZone:z.string().max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},'Invalid time zone').optional()}).strict().parse(raw);
    // Import completion may be replayed after a process interruption.
    if(input.importJobId){const prior=this.store.db.prepare("SELECT id FROM memory_jobs WHERE json_extract(json,'$.importJobId')=?").get(input.importJobId) as {id:string}|undefined;if(prior)return this.get(prior.id);}
    if(input.originKey){const prior=this.store.db.prepare("SELECT id FROM memory_jobs WHERE json_extract(json,'$.originKey')=?").get(input.originKey) as {id:string}|undefined;if(prior)return this.get(prior.id);}
    const budget=input.batchCharacters??this.budget;
    const evidenceIds=[...new Set(input.evidenceIds)],skillVersion=this.options.skillVersion??MEMORY_SKILL_VERSION,all:Chunk[]=[];
    const refsByEvidence=new Map<string,{id:string;revision:string}[]>();
    for(const ref of input.artifactRefs??[]){const artifact=this.store.archive.get(ref.id);if(!artifact||artifact.revision!==ref.revision)throw new StoreError('Semantic input changed',409);for(const range of (artifact.metadata.evidenceRanges??[]) as EvidenceRange[]){const refs=refsByEvidence.get(range.id)??[];if(!refs.some(r=>r.id===ref.id))refs.push(ref);refsByEvidence.set(range.id,refs);}}
    let skippedChunks=0;
    for(const id of evidenceIds){
      const record=this.options.memories.readEvidence([id])[0];
      if(!record||!this.options.memories.isCurrentEvidence(id))throw new StoreError('Memory input evidence is missing or superseded',409);
      if(!record.ocrText.length||record.provenance?.layer==='reference'||record.provenance?.document?.fileIndex?.coverage==='lightweight'){skippedChunks++;continue;}
      const fingerprint=memoryEvidenceFingerprint(record),profile=memoryProfile(record);
      const selected=input.evidenceRanges?input.evidenceRanges.filter(r=>r.id===id):[{id,offset:0,length:record.ocrText.length}];
      for(const range of selected){
      if(range.offset+range.length>record.ocrText.length)throw new StoreError('Semantic evidence range changed',409);
      for(let offset=range.offset;offset<range.offset+range.length;){
        let end=Math.min(offset+budget,range.offset+range.length);
        if(end<record.ocrText.length&&/[\uD800-\uDBFF]/.test(record.ocrText[end-1])&&/[\uDC00-\uDFFF]/.test(record.ocrText[end]))end--;
        const chunk:Chunk={id,profile:profile.id,profileVersion:profile.version,group:profile.group,offset,length:end-offset,fingerprint,key:sha256(JSON.stringify([id,fingerprint,offset,end-offset,profile.id==='coding'?profile.version:skillVersion]))};
        if(input.artifactRefs?.length)chunk.key=sha256(JSON.stringify([chunk.key,refsByEvidence.get(id)??[]]));
        if(this.checkpoint(chunk))skippedChunks++;else all.push(chunk);
        if(all.length>10000)throw new StoreError('Memory input exceeds 10000 chunks; use smaller jobs',413);
        offset=end;
      }}
    }
    const groups:Chunk[][]=[];let group:Chunk[]=[],characters=0;
    for(const chunk of all){if(group.length&&(group[0].group!==chunk.group||characters+chunk.length>budget||group.length>=20)){groups.push(group);group=[];characters=0;}group.push(chunk);characters+=chunk.length;}
    if(group.length)groups.push(group);
    const now=new Date().toISOString(),job:MemoryJob={artifactRefs:input.artifactRefs,language:requestLocale.getStore()??'zh-CN',id:randomUUID(),modelProfileId:input.modelProfileId,modelOverride:input.modelOverride,importJobId:input.importJobId,originKey:input.originKey,timeZone:input.timeZone,status:groups.length?'queued':'completed',createdAt:now,updatedAt:now,evidenceIds,skillVersion,totalBatches:groups.length,completedBatches:0,failedBatches:0,skippedChunks,memoryIds:[]};
    const batches:StoredBatch[]=groups.map((chunks,index)=>({artifactRefs:[...new Map(chunks.flatMap(c=>refsByEvidence.get(c.id)??[]).map(ref=>[ref.id,ref])).values()],id:randomUUID(),index,status:'pending',chunks,evidenceRanges:chunks.map(({id,offset,length})=>({id,offset,length})),attempts:0,memoryIds:[]}));
    const own=!this.store.db.isTransaction;if(own)this.store.db.exec('BEGIN IMMEDIATE');
    try{
      this.store.reserveMetadata(Buffer.byteLength(JSON.stringify(job))+batches.reduce((sum,b)=>sum+Buffer.byteLength(JSON.stringify(b)),0));
      this.store.db.prepare('INSERT INTO memory_jobs(id,created_at,json) VALUES(?,?,?)').run(job.id,now,JSON.stringify(job));
      for(const batch of batches){this.store.db.prepare('INSERT INTO memory_batches(id,job_id,idx,json) VALUES(?,?,?,?)').run(batch.id,job.id,batch.index,JSON.stringify(batch));for(const id of new Set(batch.chunks.flatMap(c=>this.options.memories.dependencyIds(c.id))))this.store.db.prepare('INSERT INTO memory_batch_dependencies(batch_id,evidence_id) VALUES(?,?)').run(batch.id,id);}
      if(own)this.store.db.exec('COMMIT');
    }catch(error){if(own)this.store.db.exec('ROLLBACK');throw error;}
    return this.get(job.id);
  }
  recover():void {
    if(this.active.size)return;
    // Legacy running projections without an execution record are restartable intake.
    this.store.db.exec("UPDATE memory_batches SET json=json_set(json,'$.status','pending','$.errorCode','interrupted') WHERE json_extract(json,'$.status')='running' AND NOT EXISTS(SELECT 1 FROM execution_steps WHERE kind='memory.batch' AND json_extract(input,'$.batchId')=memory_batches.id); UPDATE memory_jobs SET json=json_set(json,'$.status','queued','$.errorCode','interrupted') WHERE json_extract(json,'$.status')='running' AND NOT EXISTS(SELECT 1 FROM execution_steps WHERE kind='memory.batch' AND json_extract(input,'$.jobId')=memory_jobs.id); UPDATE memory_jobs SET json=json_set(json,'$.status','paused') WHERE json_extract(json,'$.status')='pausing'");
  }
  private prepare(id:string){
    const job=this.storedJob(id);if(['paused','pausing','cancelled','completed'].includes(job.status))return;
    for(const batch of this.batches(id)){
      if(!['pending','running'].includes(batch.status))continue;
      const stepId=this.engine.enqueue('memory:'+id,'memory.batch',{jobId:id,batchId:batch.id,evidenceIds:batch.resourceEvidenceIds??[...new Set(batch.chunks.map(c=>c.id))]},{id:batch.id,initial:{state:batch.status==='running'?'running':'waiting',attempts:0,availableAt:0}});
      const state=this.engine.get(stepId)!.state;if(['failed','blocked','cancelled'].includes(state))this.engine.retry(stepId);
    }
  }
  run(id:string):Promise<MemoryJobDetail> {
    if(this.closed)return Promise.reject(new StoreError('Memory pipeline is closed',503));
    const existing=this.active.get(id);if(existing)return existing;
    const job=this.storedJob(id);if(job.status==='waiting_for_model'){job.status='queued';delete job.errorCode;this.saveJob(job);}
    let resolve!:(job:MemoryJobDetail)=>void,reject!:(error:unknown)=>void;
    const task=new Promise<MemoryJobDetail>((yes,no)=>{resolve=yes;reject=no;});
    this.completions.set(id,{resolve,reject});this.active.set(id,task);
    try{this.prepare(id);}catch(error){this.completions.delete(id);this.active.delete(id);reject(error);}
    this.wake();return task;
  }
  async retry(id:string):Promise<MemoryJobDetail> {
    if(this.active.has(id))return this.active.get(id)!;
    let job=this.storedJob(id);
    if(job.availableAt&&job.availableAt>Date.now())throw new ProviderFailure({category:'transient',code:job.errorCode??'provider_unavailable',retryAfterMs:job.availableAt-Date.now()});
    if(job.status==='cancelled')throw new StoreError('Cancelled memory job cannot be retried',409);
    const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
    try{
      job=this.storedJob(id);
      if(job.status==='cancelled')throw new StoreError('Cancelled memory job cannot be retried',409);
      if(job.availableAt&&job.availableAt>Date.now())throw new ProviderFailure({category:'transient',code:job.errorCode??'provider_unavailable',retryAfterMs:job.availableAt-Date.now()});
      const batches=this.batches(id);
      if(batches.some(batch=>{const fence=db.prepare("SELECT fence FROM execution_steps WHERE id=? AND state='running'").get(batch.id)?.fence;return typeof fence==='string'&&this.engine.isCurrentGrant(batch.id,fence);}))throw new StoreError('Memory job is already running',409);
      if(this.options.configuration&&this.options.configured(job.modelProfileId)){job.configuration=structuredClone(this.options.configuration(job.modelProfileId,job.modelOverride));this.store.reserveMetadata(Buffer.byteLength(JSON.stringify(job.configuration)));}
      let nextIndex=Math.max(-1,...batches.map(batch=>batch.index))+1;
      for(const batch of batches)if(batch.status==='failed'){
        // Retry a measured deadline with less evidence, never by interpreting
        // its content. Keep original ranges/keys and cap subdivision at 2 levels.
        if(batch.errorCode==='provider_timeout'&&batch.chunks.length>1&&(batch.splitDepth??0)<2){
          const history=[...(batch.splitHistory??[]),{at:new Date().toISOString(),errorCode:'provider_timeout' as const,attempts:batch.attempts,evidenceRanges:structuredClone(batch.evidenceRanges)}];
          batch.resourceEvidenceIds??=[...new Set(batch.chunks.map(chunk=>chunk.id))];
          const remaining=batch.chunks.splice(Math.ceil(batch.chunks.length/2));
          batch.splitDepth=(batch.splitDepth??0)+1;batch.splitHistory=history;
          batch.evidenceRanges=batch.chunks.map(({id,offset,length})=>({id,offset,length}));
          const child:StoredBatch={id:randomUUID(),index:nextIndex++,status:'pending',chunks:remaining,evidenceRanges:remaining.map(({id,offset,length})=>({id,offset,length})),attempts:0,memoryIds:[],artifactRefs:batch.artifactRefs,skillVersion:batch.skillVersion,splitDepth:batch.splitDepth,splitHistory:history};
          this.store.reserveMetadata(Buffer.byteLength(JSON.stringify(child))+Buffer.byteLength(JSON.stringify(batch)));
          db.prepare('INSERT INTO memory_batches(id,job_id,idx,json) VALUES(?,?,?,?)').run(child.id,id,child.index,JSON.stringify(child));
          db.prepare('DELETE FROM memory_batch_dependencies WHERE batch_id=?').run(batch.id);
          for(const part of [batch,child])for(const evidenceId of new Set(part.chunks.flatMap(chunk=>this.options.memories.dependencyIds(chunk.id))))db.prepare('INSERT INTO memory_batch_dependencies(batch_id,evidence_id) VALUES(?,?)').run(part.id,evidenceId);
        }
        batch.status='pending';delete batch.errorCode;this.saveBatch(batch);
      }
      job.status='queued';delete job.errorCode;this.saveJob(job);if(own)db.exec('COMMIT');
    }catch(error){if(own)db.exec('ROLLBACK');throw error;}
    return this.run(id);
  }
  private validateStep(step:ExecutionStep){
    const row=this.store.db.prepare('SELECT json FROM memory_batches WHERE id=?').get(String(step.input.batchId));if(!row)return false;
    const batch=JSON.parse(String(row.json)) as StoredBatch;
    return batch.status!=='invalidated'&&batch.chunks.every(chunk=>this.valid(chunk))&&(batch.artifactRefs??[]).every(ref=>this.store.archive.revision(ref.id)===ref.revision);
  }
  private projectStep(step:ExecutionStep){
    const id=String(step.input.jobId),batchId=String(step.input.batchId);
    if(!this.store.db.prepare('SELECT 1 FROM memory_batches WHERE id=?').get(batchId))return;
    const batch=this.batch(batchId),job=this.storedJob(id);
    if(batch.status!=='invalidated'){
      batch.status=step.state==='succeeded'?'completed':step.state==='running'?'running':step.state==='failed'?'failed':step.state==='stale'?'invalidated':'pending';
      batch.errorCode=step.error==='input_changed'?'evidence_changed':step.error;
      batch.availableAt=['rate_limited','provider_unavailable','provider_timeout','provider_network'].includes(step.error??'')?step.availableAt:undefined;
      if(step.state==='running'){batch.phase='extract';batch.stage='starting';batch.startedAt=new Date().toISOString();batch.lastActivityAt=batch.startedAt;}
      this.saveBatch(batch);
    }
    if(step.state==='blocked'&&['model_token_budget','model_cost_budget','budget_price_required','budget_unbounded_runtime','model_budget_unavailable','configuration_changed','model_unconfigured','provider_authentication','provider_endpoint','provider_redirect'].includes(step.error??'')&&!['cancelled','paused','pausing'].includes(job.status)){job.status='waiting_for_model';job.errorCode=step.error;this.saveJob(job);}
    else if(['waiting','running'].includes(step.state)&&job.status==='waiting_for_model'&&this.active.has(id)){job.status='queued';delete job.errorCode;this.saveJob(job);}
    this.refreshJob(id);this.wake();
  }
  private refreshJob(id:string){
    const job=this.storedJob(id),counts=this.counts(id);
    if(job.status==='pausing'&&Number(counts.running)===0)job.status='paused';
    if(!['cancelled','paused','pausing','waiting_for_model'].includes(job.status))job.status=Number(counts.running)>0?'running':Number(counts.pending)>0?'queued':Number(counts.failed)>0?'failed':'completed';
    if(job.status!=='waiting_for_model')job.errorCode=String(this.store.db.prepare("SELECT json_extract(json,'$.errorCode') error FROM memory_batches WHERE job_id=? AND json_extract(json,'$.status') IN ('failed','invalidated') LIMIT 1").get(id)?.error??'')||undefined;
    job.availableAt=Number(this.store.db.prepare("SELECT max(json_extract(json,'$.availableAt')) at FROM memory_batches WHERE job_id=? AND json_extract(json,'$.status') IN ('failed','pending')").get(id)?.at)||undefined;
    job.totalBatches=Number(counts.total);job.completedBatches=Number(counts.completed);job.failedBatches=Number(counts.failed);this.saveJob(job);
  }
  private assertConfiguration(job:MemoryJob){
    if(job.configuration&&this.options.configuration){let current:ModelConfiguration;try{current=this.options.configuration(job.modelProfileId,job.modelOverride);}catch{throw new ExecutionFailure('blocked','model_unconfigured');}if(current.fingerprint!==job.configuration.fingerprint)throw new ExecutionFailure('blocked','configuration_changed');}
  }
  private commitBatch(step:ExecutionStep,output:BatchOutput|undefined){
    if(!output)return;
    this.assertConfiguration(this.storedJob(String(step.input.jobId)));
    const batch=this.batch(String(step.input.batchId)),{result,model,profile,skillVersion,ranges,chunks}=output;
    this.options.memories.extract(result,model,{profile,requireAdmission:this.options.requireAdmission,reviewReceipt:output.reviewReceipt,reviewRunId:output.reviewReceipt?output.reviewReceipt.reviewRunId:this.options.review?result.runId:undefined,skillVersion,evidenceRanges:ranges,expectedFingerprints:Object.fromEntries(chunks.map(c=>[c.id,c.fingerprint])),onSaved:items=>{
      for(const item of items)for(const ref of batch.artifactRefs??[])this.store.db.prepare('INSERT INTO memory_artifact_dependencies VALUES(?,?)').run(item.id,ref.id);
      batch.memoryIds=items.map(m=>m.id);this.saveBatch(batch);
      for(const chunk of chunks)this.store.db.prepare('INSERT OR IGNORE INTO memory_checkpoints(key,evidence_id,completed_at) VALUES(?,?,?)').run(chunk.key,chunk.id,new Date().toISOString());
    }});
  }
  /** Reuse validated unified candidates only when every touched candidate fits this exact batch. */
  private reuseCandidates(batch:StoredBatch,ranges:EvidenceRange[]):QueryResult|undefined {
    if(!batch.artifactRefs?.length)return;
    const artifacts=batch.artifactRefs.map(ref=>this.store.archive.get(ref.id));
    if(artifacts.some(a=>!a||a.metadata.productsVersion!==1))return;
    const candidates=artifacts.flatMap(a=>semanticProductsSchema.shape.memoryCandidates.parse(a!.metadata.memoryCandidates));
    const selected:typeof candidates=[];
    for(const candidate of candidates){
      if(!candidate.evidenceIds.some(id=>ranges.some(r=>r.id===id)))continue;
      if(!candidate.evidence?.length)return;
      const covered=candidate.evidence.every(span=>{const text=this.options.memories.readEvidence([span.id])[0]?.ocrText??'',offset=span.offset??text.indexOf(span.quote);return offset>=0&&ranges.some(r=>r.id===span.id&&r.offset<=offset&&offset+span.quote.length<=r.offset+r.length);});
      if(!covered)return;
      if(!selected.some(c=>JSON.stringify(c)===JSON.stringify(candidate)))selected.push(candidate);
    }
    if(selected.length>8)return;
    const ids=[...new Set(selected.flatMap(c=>c.evidenceIds))];
    return {answer:JSON.stringify({memories:selected}),runId:'semantic-reuse:'+batch.id,trace:[],citations:ids.map(id=>{const r=this.options.memories.readEvidence([id])[0];return {id,capturedAt:r.capturedAt,appName:r.appName,excerpt:''};})};
  }
  private valid(chunk:Chunk):boolean {const record=this.options.memories.readEvidence([chunk.id])[0];return Boolean(record&&this.options.memories.isCurrentEvidence(chunk.id)&&memoryEvidenceFingerprint(record)===chunk.fingerprint);}
  private async execute(id:string,batchId:string,signal:AbortSignal,currentGrant:()=>boolean):Promise<BatchOutput|undefined> {
    const assertGrant=()=>{signal.throwIfAborted();if(!currentGrant())throw new ExecutionFailure('waiting','interrupted');};assertGrant();
    const observeCurrent=(update:()=>void):boolean=>{
      const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
      try{if(!currentGrant()||this.batch(batchId).status!=='running'){if(own)db.exec('COMMIT');return false;}update();if(own)db.exec('COMMIT');return true;}
      catch(error){if(own)db.exec('ROLLBACK');throw error;}
    };
    const job=this.storedJob(id),batch=this.batch(batchId),currentSkill=this.options.skillVersion??MEMORY_SKILL_VERSION;
    let chunks:Chunk[]=[];
    if(!observeCurrent(()=>{
      if(batch.chunks.every(c=>c.profile!=='coding')&&job.skillVersion!==currentSkill){batch.skillVersion=currentSkill;batch.chunks=batch.chunks.map(c=>({...c,key:sha256(JSON.stringify([c.id,c.fingerprint,c.offset,c.length,currentSkill]))}));this.saveBatch(batch);}
      chunks=batch.chunks.filter(chunk=>!this.checkpoint(chunk));const currentJob=this.storedJob(id);currentJob.skippedChunks+=batch.chunks.length-chunks.length;this.saveJob(currentJob);
    }))throw new ExecutionFailure('waiting','interrupted');
    if(batch.chunks.some(chunk=>{const record=this.options.memories.readEvidence([chunk.id])[0];return record&&chunk.profile==='coding'&&chunk.profileVersion&&chunk.profileVersion!==memoryProfile(record).version;}))throw new ExecutionFailure('stale','skill_changed');
    if(!chunks.length)return;
    const ranges=chunks.map(({id,offset,length})=>({id,offset,length}));
    try{
        this.assertConfiguration(job);
        if(job.configuration&&!observeCurrent(()=>{batch.configuration=structuredClone(job.configuration);this.store.reserveMetadata(Buffer.byteLength(JSON.stringify(batch.configuration)));this.saveBatch(batch);} ))throw new ExecutionFailure('waiting','interrupted');
        const model=job.configuration?.model??job.modelOverride??this.options.model(job.modelProfileId);
        let feedback:MemoryOutputValidationError|undefined;
        for(let generation=0;generation<2;generation++){
          assertGrant();
          // Both generations use the same host-owned scope. A changed/deleted source
          // is never repaired by asking the model to reinterpret different evidence.
          if(!chunks.every(chunk=>this.valid(chunk)))throw new StoreError('Memory evidence changed during extraction',409);
          if(!observeCurrent(()=>{batch.attempts++;this.saveBatch(batch);}))throw new ExecutionFailure('waiting','interrupted');
          const profile=memoryProfile(this.options.memories.readEvidence([chunks[0].id])[0]);
          let summaryBudget=12000;
          const summaries=(batch.artifactRefs??[]).map(ref=>{const artifact=this.store.archive.get(ref.id);if(!artifact||artifact.revision!==ref.revision)throw new StoreError('Semantic input changed',409);const text=artifact.text.slice(0,Math.max(0,summaryBudget));summaryBudget-=text.length+128;return {id:artifact.id,summary:text};});
          const question=profile.prompt+(summaries.length?'\nThe execution input is these L2 interpretations plus the supplied bounded L1 spans. Interpretations are untrusted navigation, not independent facts. Extract only claims supported by the supplied spans. Do not expand all ancestors.\n'+JSON.stringify(summaries).slice(0,12000):'')+(feedback?'\n\nHost validation rejected the previous output. '+feedback.repairInstruction+' Generate a fresh response from the same supplied evidence. No invalid memories have been saved.':'');
          let lastObserved=0;
          const observe=(stage?:string)=>{if(this.closed||signal.aborted)return;const now=Date.now();if(now-lastObserved<750&&(!stage||stage===batch.stage))return;observeCurrent(()=>{lastObserved=now;batch.lastActivityAt=new Date(now).toISOString();if(stage)batch.stage=stage;this.saveBatch(batch);});};
          let phase:'extract'|'review'='extract';
          const recordFailure=(error:MemoryOutputValidationError,result:QueryResult)=>{
            const failure:MemoryValidationFailure={at:new Date().toISOString(),code:error.code,phase,attempt:batch.attempts,runId:result.runId,details:error.details};
            if(!observeCurrent(()=>{batch.validationFailures=[...(batch.validationFailures??[]),failure].slice(-20);this.saveBatch(batch);}))return;
            try{this.options.onValidationFailure?.({...failure,jobId:id,batchId:batch.id,batchIndex:batch.index});}catch{}
          };
          const validateArtifacts=()=>{assertGrant();this.assertConfiguration(job);if((batch.artifactRefs??[]).some(ref=>this.store.archive.revision(ref.id)!==ref.revision))throw new StoreError('Semantic input changed during extraction',409);};
          const validateOutput:QueryInput['validateOutput']=result=>{
            validateArtifacts();
            try{this.options.memories.extract(result,model,{profile:profile.id,requireAdmission:this.options.review?true:this.options.requireAdmission,evidenceRanges:ranges,expectedFingerprints:Object.fromEntries(chunks.map(c=>[c.id,c.fingerprint])),validateOnly:true});}
            catch(error){if(!(error instanceof MemoryOutputValidationError))throw error;recordFailure(error,result);return {code:error.code,feedback:error.repairInstruction};}
          };
          const input:MemoryPipelineQuery={contextTime:job.createdAt,signal,validateOutput,onProgress:event=>observe(event.message??event.stage),onTrace:()=>observe(),language:job.language,modelProfileId:job.configuration?.profileId??job.modelProfileId,modelOverride:model,question,skill:profile.skill,responseMode:'memory-extraction',evidenceIds:[...new Set(chunks.map(c=>c.id))],evidenceRanges:ranges.map(range=>({...range})),timeZone:job.timeZone,traceContext:{operationId:'memory:'+id,jobId:id,batchId:batch.id,batchIndex:batch.index,attempt:batch.attempts,phase:'extract'}};
          let result=(generation===0?this.reuseCandidates(batch,ranges):undefined)??await withExecutionCancellation(signal,()=>this.options.query(input));
          signal.throwIfAborted();
          try{
            validateArtifacts();
            if(this.options.review){
              this.options.memories.extract(result,model,{profile:profile.id,requireAdmission:true,evidenceRanges:ranges,expectedFingerprints:Object.fromEntries(chunks.map(c=>[c.id,c.fingerprint])),validateOnly:true});
              phase='review';batch.phase='review';observe('model');result=await withExecutionCancellation(signal,()=>this.options.review!(input,result));
              signal.throwIfAborted();
            }
            validateArtifacts();
            this.options.memories.extract(result,model,{profile:profile.id,requireAdmission:this.options.requireAdmission,evidenceRanges:ranges,expectedFingerprints:Object.fromEntries(chunks.map(c=>[c.id,c.fingerprint])),validateOnly:true});
            return {result,reviewReceipt:memoryReviewReceipt(result),model,profile:profile.id,skillVersion:profile.id==='coding'?profile.version:batch.skillVersion??job.skillVersion,ranges,chunks};
          }catch(error){if(error instanceof MemoryOutputValidationError){
              recordFailure(error,result);
            }if(generation===0&&error instanceof MemoryOutputValidationError){feedback=error;continue;}throw error;}
        }
    }catch(error){
      if(error instanceof AgentTimeoutError)throw new ExecutionFailure('transient','provider_timeout');
      throw error instanceof ExecutionFailure||error instanceof ProviderFailure?error:new ExecutionFailure(error instanceof StoreError&&error.statusCode===409?'stale':'permanent',signal.aborted?'cancelled':error instanceof StoreError&&error.statusCode===409?'evidence_changed':error instanceof StoreError&&error.statusCode===507?'storage_full':(error instanceof StoreError&&error.statusCode===502)||error instanceof AgentResponseError?'invalid_model_output':'model_failed');
    }
  }
  async close(){
    this.closed=true;
    if(this.owned)await this.engine.close();else if(!this.engine.closed){for(const id of this.active.keys())for(const step of this.steps(id))this.engine.cancel(step);}
    this.settle();await Promise.allSettled([...this.active.values()]);
  }
}
