import {withExecutionCancellation} from './execution-cancellation.js';
import {requestLocale} from './i18n.js';
import {AgentResponseError,type QueryInput} from '@mote/agent';
import {memoryProfile} from './memory-profiles.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {modelProfileIdSchema} from './model-settings.js';
import {executionEnvelope,type ExecutionEnvelope,type QueryResult} from '@mote/shared';
import {Store,StoreError,sha256} from './store.js';
import {MemoryStore,MemoryOutputValidationError,MEMORY_EXTRACTION_PROMPT,MEMORY_SKILL_VERSION,memoryEvidenceFingerprint,type EvidenceRange} from './memory.js';

import type {MemoryValidationDetails} from './memory-validation.js';

export type MemoryValidationFailure={at:string;code:string;phase:'extract'|'review';attempt?:number;runId?:string;details?:MemoryValidationDetails};
export type MemoryValidationFailureEvent=MemoryValidationFailure&{jobId:string;batchId:string;batchIndex:number};

type Chunk=EvidenceRange&{profile?:'personal'|'coding';profileVersion?:string;group?:string;fingerprint:string;key:string};
export type MemoryBatch={id:string;index:number;status:'pending'|'running'|'completed'|'failed'|'invalidated';evidenceRanges:EvidenceRange[];attempts:number;memoryIds:string[];errorCode?:string;validationFailures?:MemoryValidationFailure[];phase?:'extract'|'review';stage?:string;startedAt?:string;lastActivityAt?:string;execution?:ExecutionEnvelope};
type StoredBatch=MemoryBatch&{artifactRefs?:{id:string;revision:string}[];chunks:Chunk[];skillVersion?:string};
export type MemoryJob={artifactRefs?:{id:string;revision:string}[];language?:'zh-CN'|'en';id:string;modelProfileId?:string;modelOverride?:string;importJobId?:string;originKey?:string;timeZone?:string;status:'queued'|'running'|'completed'|'failed'|'waiting_for_model'|'cancelled'|'paused'|'pausing';createdAt:string;updatedAt:string;evidenceIds:string[];skillVersion:string;totalBatches:number;completedBatches:number;failedBatches:number;skippedChunks:number;memoryIds:string[];errorCode?:string;queuePosition?:number;runningBatches?:number;pendingBatches?:number;lastSavedAt?:string;execution?:ExecutionEnvelope};
export type MemoryJobDetail=MemoryJob&{batches:MemoryBatch[]};
export type MemoryPipelineQuery={signal?:AbortSignal;language?:'zh-CN'|'en';modelProfileId?:string;modelOverride?:string;question:string;skill:'memory-extraction'|'coding-memory';responseMode:'memory-extraction';evidenceIds:string[];evidenceRanges:EvidenceRange[];timeZone?:string;validateOutput?:QueryInput['validateOutput'];onProgress?:QueryInput['onProgress'];onTrace?:QueryInput['onTrace'];traceContext?:QueryInput['traceContext']};
export type MemoryPipelineOptions={concurrency?:()=>number;onValidationFailure?:(event:MemoryValidationFailureEvent)=>void;requireAdmission?:boolean;review?:(input:MemoryPipelineQuery,result:QueryResult)=>Promise<QueryResult>;store:Store;memories:MemoryStore;query:(input:MemoryPipelineQuery)=>Promise<QueryResult>;model:(profileId?:string)=>string;configured:(profileId?:string)=>boolean;skillVersion?:string;batchCharacters?:number};

/** Durable work references original evidence; jobs never persist extra copies of private text. */
export class MemoryPipeline {
  private active=new Map<string,Promise<MemoryJobDetail>>();
  private aborts=new Map<string,AbortController>();
  private completions=new Map<string,{resolve:(job:MemoryJobDetail)=>void;reject:(error:unknown)=>void}>();
  private ready:string[]=[];
  private running=new Map<string,{jobId:string;keys:string[]}>();
  private workers=new Set<Promise<unknown>>();
  private scheduled=false;
  wake(){if(this.scheduled)return;this.scheduled=true;queueMicrotask(()=>{this.scheduled=false;this.dispatch();});}
  private dispatch(){
    for(const id of [...this.ready]){
      if([...this.running.values()].some(run=>run.jobId===id))continue;
      const job=this.storedJob(id),counts=this.counts(id);
      if(this.closed||['paused','pausing','cancelled','waiting_for_model','completed'].includes(job.status)||Number(counts.pending)===0){
        if(job.status==='pausing'){const value=this.storedJob(id);value.status='paused';this.saveJob(value);}
        this.ready=this.ready.filter(value=>value!==id);this.active.delete(id);this.aborts.delete(id);const done=this.completions.get(id);this.completions.delete(id);done?.resolve(this.get(id));
      }
    }
    if(this.closed)return;
    const limit=this.options.concurrency?.()??1;
    while(this.running.size<limit){
      const locked=new Set([...this.running.values()].flatMap(run=>run.keys));
      let selected:{id:string;batch:StoredBatch}|undefined;
      for(const id of this.ready){
        if(['paused','pausing','cancelled','waiting_for_model','completed'].includes(this.storedJob(id).status))continue;
        const row=this.store.db.prepare("SELECT json FROM memory_batches WHERE job_id=? AND json_extract(json,'$.status')='pending' AND NOT EXISTS(SELECT 1 FROM json_each(memory_batches.json,'$.chunks') c WHERE json_extract(c.value,'$.id') IN (SELECT value FROM json_each(?))) ORDER BY idx LIMIT 1").get(id,JSON.stringify([...locked]));
        const batch=row?JSON.parse(String(row.json)) as StoredBatch:undefined;
        if(batch){selected={id,batch};break;}
      }
      if(!selected)break;
      const {id,batch}=selected;
      this.ready=this.ready.filter(value=>value!==id);this.ready.push(id);
      this.running.set(batch.id,{jobId:id,keys:batch.chunks.map(c=>c.id)});
      const worker=this.execute(id,batch.id).catch(error=>{this.completions.get(id)?.reject(error);this.completions.delete(id);this.active.delete(id);this.ready=this.ready.filter(value=>value!==id);}).finally(()=>{this.running.delete(batch.id);this.workers.delete(worker);this.wake();});
      this.workers.add(worker);
    }
  }
  pause(id:string){const job=this.storedJob(id);if(['queued','running'].includes(job.status)){job.status=[...this.running.values()].some(r=>r.jobId===id)?'pausing':'paused';this.saveJob(job);this.wake();}return this.get(id);}
  resume(id:string){const job=this.storedJob(id);if(!['paused','pausing'].includes(job.status))return;job.status='queued';this.saveJob(job);void this.run(id).catch(()=>{});this.wake();}
  cancel(id:string){const job=this.storedJob(id);if(!['completed','cancelled'].includes(job.status)){job.status='cancelled';this.saveJob(job);this.aborts.get(id)?.abort();this.wake();}return this.get(id);}

  private closed=false;
  private budget:number;
  constructor(private options:MemoryPipelineOptions){
    this.budget=options.batchCharacters??12000;
    if(!Number.isSafeInteger(this.budget)||this.budget<256||this.budget>12000)throw new StoreError('Memory batch budget must be 256–12000 characters');
    this.initializeCounts();
    this.recover();
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
    return {...job,status,queuePosition:this.ready.includes(id)?this.ready.indexOf(id)+1:undefined,runningBatches:batches.filter(b=>b.status==='running').length,pendingBatches:batches.filter(b=>b.status==='pending').length,lastSavedAt:(this.store.db.prepare("SELECT max(created_at) AS at FROM memories WHERE id IN (SELECT value FROM json_each(?))").get(JSON.stringify(memoryIds)) as {at?:string})?.at??undefined,totalBatches:batches.length,completedBatches:batches.filter(b=>b.status==='completed').length,failedBatches,memoryIds,
      execution:executionEnvelope({status:status==='paused'?'waiting':status==='pausing'?'running':status,attempts,errorCode:job.errorCode??batches.find(b=>b.errorCode)?.errorCode,updatedAt:job.updatedAt}),
      batches:batches.map(({chunks:_chunks,...batch})=>({...batch,execution:executionEnvelope({status:batch.status==='pending'?'queued':batch.status==='completed'?'succeeded':batch.status==='invalidated'?'skipped':batch.status,attempts:batch.attempts,errorCode:batch.errorCode})}))};
  }
  list(limit=30):MemoryJob[]{return this.store.db.prepare("SELECT json_remove(json,'$.evidenceIds','$.memoryIds','$.artifactRefs') json FROM memory_jobs ORDER BY created_at DESC,id DESC LIMIT ?").all(Math.max(1,Math.min(limit,100))).map(row=>{
    const job=JSON.parse(String(row.json)) as MemoryJob;
    const counts=this.counts(job.id);
    return {...job,status:job.status==='completed'&&Number(counts.failed)>0?'failed':job.status,evidenceIds:[],memoryIds:[],totalBatches:Number(counts.total),completedBatches:Number(counts.completed??0),failedBatches:Number(counts.failed??0),runningBatches:Number(counts.running??0),pendingBatches:Number(counts.pending??0),queuePosition:this.ready.includes(job.id)?this.ready.indexOf(job.id)+1:undefined,execution:executionEnvelope({status:job.status==='paused'?'waiting':job.status==='pausing'?'running':job.status,attempts:Number(counts.attempts??0),errorCode:job.errorCode,updatedAt:job.updatedAt})};
  });}
  createFromArtifacts(artifactIds:string[],importJobId:string,batchCharacters=12000){
    const artifacts=artifactIds.map(id=>this.store.archive.get(id)).filter(a=>a?.kind==='semantic');
    const ranges=artifacts.flatMap(a=>z.array(z.object({id:z.string().uuid(),offset:z.number().int().min(0),length:z.number().int().min(1).max(1200)})).parse(a!.metadata.evidenceRanges??[]));
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
    this.store.db.exec('BEGIN IMMEDIATE');
    try{
      this.store.reserveMetadata(Buffer.byteLength(JSON.stringify(job))+batches.reduce((sum,b)=>sum+Buffer.byteLength(JSON.stringify(b)),0));
      this.store.db.prepare('INSERT INTO memory_jobs(id,created_at,json) VALUES(?,?,?)').run(job.id,now,JSON.stringify(job));
      for(const batch of batches){this.store.db.prepare('INSERT INTO memory_batches(id,job_id,idx,json) VALUES(?,?,?,?)').run(batch.id,job.id,batch.index,JSON.stringify(batch));for(const id of new Set(batch.chunks.flatMap(c=>this.options.memories.dependencyIds(c.id))))this.store.db.prepare('INSERT INTO memory_batch_dependencies(batch_id,evidence_id) VALUES(?,?)').run(batch.id,id);}
      this.store.db.exec('COMMIT');
    }catch(error){this.store.db.exec('ROLLBACK');throw error;}
    return this.get(job.id);
  }
  recover():void {
    if(this.active.size)return;
    this.store.db.exec("UPDATE memory_batches SET json=json_set(json,'$.status','pending','$.errorCode','interrupted') WHERE json_extract(json,'$.status')='running'; UPDATE memory_jobs SET json=json_set(json,'$.status','queued','$.errorCode','interrupted') WHERE json_extract(json,'$.status')='running'; UPDATE memory_jobs SET json=json_set(json,'$.status','paused') WHERE json_extract(json,'$.status')='pausing'");
  }
  run(id:string):Promise<MemoryJobDetail> {
    if(this.closed)return Promise.reject(new StoreError('Memory pipeline is closed',503));
    const existing=this.active.get(id);if(existing)return existing;
    this.storedJob(id);
    let resolve!:(job:MemoryJobDetail)=>void,reject!:(error:unknown)=>void;
    const task=new Promise<MemoryJobDetail>((yes,no)=>{resolve=yes;reject=no;});
    this.aborts.set(id,new AbortController());this.completions.set(id,{resolve,reject});this.active.set(id,task);this.ready.push(id);this.wake();return task;
  }

  async retry(id:string):Promise<MemoryJobDetail> {
    if(this.active.has(id))return this.active.get(id)!;
    const job=this.storedJob(id);
    if(job.status==='cancelled')throw new StoreError('Cancelled memory job cannot be retried',409);
    for(const batch of this.batches(id))if(batch.status==='failed'){batch.status='pending';delete batch.errorCode;this.saveBatch(batch);}
    job.status='queued';delete job.errorCode;this.saveJob(job);return this.run(id);
  }
  private valid(chunk:Chunk):boolean {const record=this.options.memories.readEvidence([chunk.id])[0];return Boolean(record&&this.options.memories.isCurrentEvidence(chunk.id)&&memoryEvidenceFingerprint(record)===chunk.fingerprint);}
  private async execute(id:string,batchId:string):Promise<void> {
    const signal=this.aborts.get(id)!.signal;
    let job=this.storedJob(id);
    if(job.status==='completed'||['cancelled','paused','pausing'].includes(job.status)||this.closed)return;
    if(!this.options.configured(job.modelProfileId)){job.status='waiting_for_model';job.errorCode='model_unconfigured';this.saveJob(job);return;}
    job.status='running';delete job.errorCode;this.saveJob(job);
    for(const original of [this.batch(batchId)]){
      if(this.closed)break;
      // Re-read after each await: source edits/deletions may invalidate queued batches.
      const batch=this.batch(original.id);
      if(batch.status!=='pending')continue;
      const currentSkill=this.options.skillVersion??MEMORY_SKILL_VERSION;
      if(batch.chunks.every(c=>c.profile!=='coding')&&job.skillVersion!==currentSkill){
        batch.skillVersion=currentSkill;
        batch.chunks=batch.chunks.map(c=>({...c,key:sha256(JSON.stringify([c.id,c.fingerprint,c.offset,c.length,currentSkill]))}));
        this.saveBatch(batch);
      }
      if(batch.chunks.some(chunk=>{const record=this.options.memories.readEvidence([chunk.id])[0];return record&&chunk.profile==='coding'&&chunk.profileVersion&&chunk.profileVersion!==memoryProfile(record).version;})){batch.status='invalidated';batch.errorCode='skill_changed';this.saveBatch(batch);continue;}
      if(!batch.chunks.every(chunk=>this.valid(chunk))){batch.status='invalidated';batch.errorCode='evidence_changed';this.saveBatch(batch);continue;}
      const chunks=batch.chunks.filter(chunk=>!this.checkpoint(chunk));
      job=this.storedJob(id);job.skippedChunks+=batch.chunks.length-chunks.length;this.saveJob(job);
      if(!chunks.length){batch.status='completed';delete batch.errorCode;this.saveBatch(batch);continue;}
      if(!this.options.configured(job.modelProfileId)){job.status='waiting_for_model';job.errorCode='model_unconfigured';this.saveJob(job);return;}
      batch.status='running';batch.phase='extract';batch.stage='starting';batch.startedAt=new Date().toISOString();batch.lastActivityAt=batch.startedAt;delete batch.errorCode;this.saveBatch(batch);
      const ranges=chunks.map(({id,offset,length})=>({id,offset,length}));
      try{
        const model=job.modelOverride??this.options.model(job.modelProfileId);
        let feedback:MemoryOutputValidationError|undefined;
        for(let generation=0;generation<2;generation++){
          // Both generations use the same host-owned scope. A changed/deleted source
          // is never repaired by asking the model to reinterpret different evidence.
          if(!chunks.every(chunk=>this.valid(chunk)))throw new StoreError('Memory evidence changed during extraction',409);
          batch.attempts++;this.saveBatch(batch);
          const profile=memoryProfile(this.options.memories.readEvidence([chunks[0].id])[0]);
          let summaryBudget=12000;
          const summaries=(batch.artifactRefs??[]).map(ref=>{const artifact=this.store.archive.get(ref.id);if(!artifact||artifact.revision!==ref.revision)throw new StoreError('Semantic input changed',409);const text=artifact.text.slice(0,Math.max(0,summaryBudget));summaryBudget-=text.length+128;return {id:artifact.id,summary:text};});
          const question=profile.prompt+(summaries.length?'\nThe execution input is these L2 interpretations plus the supplied bounded L1 spans. Interpretations are untrusted navigation, not independent facts. Extract only claims supported by the supplied spans. Do not expand all ancestors.\n'+JSON.stringify(summaries).slice(0,12000):'')+(feedback?'\n\nHost validation rejected the previous output. '+feedback.repairInstruction+' Generate a fresh response from the same supplied evidence. No invalid memories have been saved.':'');
          let lastObserved=0;
          const observe=(stage?:string)=>{if(this.closed||signal.aborted)return;const now=Date.now();if(now-lastObserved<750&&(!stage||stage===batch.stage))return;const current=this.batch(batch.id);if(current.status!=='running')return;lastObserved=now;batch.lastActivityAt=new Date(now).toISOString();if(stage)batch.stage=stage;this.saveBatch(batch);};
          let phase:'extract'|'review'='extract';
          const recordFailure=(error:MemoryOutputValidationError,result:QueryResult)=>{
            const failure:MemoryValidationFailure={at:new Date().toISOString(),code:error.code,phase,attempt:batch.attempts,runId:result.runId,details:error.details};
            batch.validationFailures=[...(batch.validationFailures??[]),failure].slice(-20);this.saveBatch(batch);
            try{this.options.onValidationFailure?.({...failure,jobId:id,batchId:batch.id,batchIndex:batch.index});}catch{}
          };
          const validateArtifacts=()=>{signal.throwIfAborted();if((batch.artifactRefs??[]).some(ref=>this.store.archive.revision(ref.id)!==ref.revision))throw new StoreError('Semantic input changed during extraction',409);};
          const validateOutput:QueryInput['validateOutput']=result=>{
            validateArtifacts();
            try{this.options.memories.extract(result,model,{profile:profile.id,requireAdmission:this.options.review?true:this.options.requireAdmission,evidenceRanges:ranges,expectedFingerprints:Object.fromEntries(chunks.map(c=>[c.id,c.fingerprint])),validateOnly:true});}
            catch(error){if(!(error instanceof MemoryOutputValidationError))throw error;recordFailure(error,result);return {code:error.code,feedback:error.repairInstruction};}
          };
          const input:MemoryPipelineQuery={signal,validateOutput,onProgress:event=>observe(event.message??event.stage),onTrace:()=>observe(),language:job.language,modelProfileId:job.modelProfileId,modelOverride:model,question,skill:profile.skill,responseMode:'memory-extraction',evidenceIds:[...new Set(chunks.map(c=>c.id))],evidenceRanges:ranges.map(range=>({...range})),timeZone:job.timeZone,traceContext:{jobId:id,batchId:batch.id,batchIndex:batch.index,attempt:batch.attempts,phase:'extract'}};
          let result=await withExecutionCancellation(signal,()=>this.options.query(input));
          if(this.closed){batch.status='pending';batch.errorCode='interrupted';this.saveBatch(batch);break;}
          try{
            validateArtifacts();
            if(this.options.review){
              this.options.memories.extract(result,model,{profile:profile.id,requireAdmission:true,evidenceRanges:ranges,expectedFingerprints:Object.fromEntries(chunks.map(c=>[c.id,c.fingerprint])),validateOnly:true});
              phase='review';batch.phase='review';observe('model');result=await withExecutionCancellation(signal,()=>this.options.review!(input,result));
              if(this.closed){batch.status='pending';batch.errorCode='interrupted';this.saveBatch(batch);break;}
            }
            validateArtifacts();
            this.options.memories.extract(result,model,{profile:profile.id,requireAdmission:this.options.requireAdmission,reviewRunId:this.options.review?result.runId:undefined,skillVersion:profile.id==='coding'?profile.version:batch.skillVersion??job.skillVersion,evidenceRanges:ranges,expectedFingerprints:Object.fromEntries(chunks.map(c=>[c.id,c.fingerprint])),onSaved:items=>{
              for(const item of items)for(const ref of batch.artifactRefs??[])this.store.db.prepare('INSERT INTO memory_artifact_dependencies VALUES(?,?)').run(item.id,ref.id);
              batch.status='completed';batch.memoryIds=items.map(m=>m.id);delete batch.errorCode;
              this.saveBatch(batch);
              for(const chunk of chunks)this.store.db.prepare('INSERT OR IGNORE INTO memory_checkpoints(key,evidence_id,completed_at) VALUES(?,?,?)').run(chunk.key,chunk.id,new Date().toISOString());
            }});
            break;
          }catch(error){if(error instanceof MemoryOutputValidationError){
              recordFailure(error,result);
            }if(generation===0&&error instanceof MemoryOutputValidationError){feedback=error;continue;}throw error;}
        }
      }catch(error){
        const current=this.batch(batch.id);
        if(current.status!=='invalidated'){
          batch.status=this.closed||signal.aborted?'pending':error instanceof StoreError&&error.statusCode===409?'invalidated':'failed';
          batch.errorCode=this.closed?'interrupted':signal.aborted?'cancelled':error instanceof StoreError&&error.statusCode===409?'evidence_changed':error instanceof StoreError&&error.statusCode===507?'storage_full':(error instanceof StoreError&&error.statusCode===502)||error instanceof AgentResponseError?'invalid_model_output':'model_failed';
          this.saveBatch(batch);
        }
      }
    }
    const counts=this.counts(id);job=this.storedJob(id);
    if(!['cancelled','paused','pausing','waiting_for_model'].includes(job.status))job.status=this.closed?'queued':Number(counts.pending)+Number(counts.running)>0?'queued':Number(counts.failed)>0?'failed':'completed';
    job.errorCode=String(this.store.db.prepare("SELECT json_extract(json,'$.errorCode') error FROM memory_batches WHERE job_id=? AND json_extract(json,'$.status') IN ('failed','invalidated') LIMIT 1").get(id)?.error??'')||undefined;
    job.totalBatches=Number(counts.total);job.completedBatches=Number(counts.completed);job.failedBatches=Number(counts.failed);
    this.saveJob(job);return;
  }
  async close(){this.closed=true;for(const abort of this.aborts.values())abort.abort();this.wake();await Promise.allSettled([...this.active.values(),...this.workers]);}
}
