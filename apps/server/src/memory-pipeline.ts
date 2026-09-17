import {requestLocale} from './i18n.js';
import {memoryProfile} from './memory-profiles.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {modelProfileIdSchema} from './model-settings.js';
import type {QueryResult} from '@mote/shared';
import {Store,StoreError,sha256} from './store.js';
import {MemoryStore,MemoryOutputValidationError,MEMORY_EXTRACTION_PROMPT,MEMORY_SKILL_VERSION,memoryEvidenceFingerprint,type EvidenceRange} from './memory.js';

type Chunk=EvidenceRange&{profile?:'personal'|'coding';profileVersion?:string;group?:string;fingerprint:string;key:string};
export type MemoryBatch={id:string;index:number;status:'pending'|'running'|'completed'|'failed'|'invalidated';evidenceRanges:EvidenceRange[];attempts:number;memoryIds:string[];errorCode?:string};
type StoredBatch=MemoryBatch&{chunks:Chunk[]};
export type MemoryJob={language?:'zh-CN'|'en';id:string;modelProfileId?:string;modelOverride?:string;importJobId?:string;originKey?:string;timeZone?:string;status:'queued'|'running'|'completed'|'failed'|'waiting_for_model'|'cancelled';createdAt:string;updatedAt:string;evidenceIds:string[];skillVersion:string;totalBatches:number;completedBatches:number;failedBatches:number;skippedChunks:number;memoryIds:string[];errorCode?:string};
export type MemoryJobDetail=MemoryJob&{batches:MemoryBatch[]};
export type MemoryPipelineQuery={language?:'zh-CN'|'en';modelProfileId?:string;modelOverride?:string;question:string;skill:'memory-extraction'|'coding-memory';responseMode:'memory-extraction';evidenceIds:string[];evidenceRanges:EvidenceRange[];timeZone?:string};
export type MemoryPipelineOptions={store:Store;memories:MemoryStore;query:(input:MemoryPipelineQuery)=>Promise<QueryResult>;model:(profileId?:string)=>string;configured:(profileId?:string)=>boolean;skillVersion?:string;batchCharacters?:number};

/** Durable work references original evidence; jobs never persist extra copies of private text. */
export class MemoryPipeline {
  private active=new Map<string,Promise<MemoryJobDetail>>();
  private queue:Promise<unknown>=Promise.resolve();
  private closed=false;
  private budget:number;
  constructor(private options:MemoryPipelineOptions){
    this.budget=options.batchCharacters??12000;
    if(!Number.isSafeInteger(this.budget)||this.budget<256||this.budget>12000)throw new StoreError('Memory batch budget must be 256–12000 characters');
    this.recover();
  }
  private get store(){return this.options.store;}
  private storedJob(id:string):MemoryJob {
    const row=this.store.db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(id) as {json:string}|undefined;
    if(!row)throw new StoreError('Memory job not found',404);return JSON.parse(row.json);
  }
  private batches(id:string):StoredBatch[]{return (this.store.db.prepare('SELECT json FROM memory_batches WHERE job_id=? ORDER BY idx').all(id) as {json:string}[]).map(row=>JSON.parse(row.json));}
  private saveJob(job:MemoryJob){const {batches:_batches,...value}=job as MemoryJobDetail;value.updatedAt=new Date().toISOString();this.store.db.prepare('UPDATE memory_jobs SET json=? WHERE id=?').run(JSON.stringify(value),job.id);}
  private saveBatch(batch:StoredBatch){this.store.db.prepare('UPDATE memory_batches SET json=? WHERE id=?').run(JSON.stringify(batch),batch.id);}
  private checkpoint(chunk:Chunk){return Boolean(this.store.db.prepare('SELECT key FROM memory_checkpoints WHERE key=?').get(chunk.key));}
  get(id:string):MemoryJobDetail {
    const job=this.storedJob(id),batches=this.batches(id),failedBatches=batches.filter(b=>b.status==='failed'||b.status==='invalidated').length;
    const memoryIds=[...new Set(batches.flatMap(b=>b.memoryIds))].filter(memoryId=>this.store.db.prepare('SELECT id FROM memories WHERE id=?').get(memoryId));
    return {...job,status:job.status==='completed'&&failedBatches?'failed':job.status,totalBatches:batches.length,completedBatches:batches.filter(b=>b.status==='completed').length,failedBatches,memoryIds,
      batches:batches.map(({chunks:_chunks,...batch})=>batch)};
  }
  list(limit=30):MemoryJob[]{return (this.store.db.prepare('SELECT id FROM memory_jobs ORDER BY created_at DESC,id DESC LIMIT ?').all(Math.max(1,Math.min(limit,100))) as {id:string}[]).map(row=>{const {batches:_batches,...job}=this.get(row.id);return job;});}
  create(raw:{modelProfileId?:string;modelOverride?:string;evidenceIds:string[];importJobId?:string;originKey?:string;timeZone?:string;batchCharacters?:number}):MemoryJobDetail {
    if(this.closed)throw new StoreError('Memory pipeline is closed',503);
    const input=z.object({modelProfileId:modelProfileIdSchema.optional(),modelOverride:z.string().trim().min(1).max(512).refine(v=>!/[\u0000-\u001f\u007f]/.test(v)).optional(),originKey:z.string().max(200).optional(),batchCharacters:z.number().int().min(256).max(12000).optional(),evidenceIds:z.array(z.string().uuid()).min(1).max(20000),importJobId:z.string().max(200).optional(),timeZone:z.string().max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},'Invalid time zone').optional()}).strict().parse(raw);
    // Import completion may be replayed after a process interruption.
    if(input.importJobId){const prior=this.store.db.prepare("SELECT id FROM memory_jobs WHERE json_extract(json,'$.importJobId')=?").get(input.importJobId) as {id:string}|undefined;if(prior)return this.get(prior.id);}
    if(input.originKey){const prior=this.store.db.prepare("SELECT id FROM memory_jobs WHERE json_extract(json,'$.originKey')=?").get(input.originKey) as {id:string}|undefined;if(prior)return this.get(prior.id);}
    const budget=input.batchCharacters??this.budget;
    const evidenceIds=[...new Set(input.evidenceIds)],skillVersion=this.options.skillVersion??MEMORY_SKILL_VERSION,all:Chunk[]=[];
    let skippedChunks=0;
    for(const id of evidenceIds){
      const record=this.options.memories.readEvidence([id])[0];
      if(!record||!this.options.memories.isCurrentEvidence(id))throw new StoreError('Memory input evidence is missing or superseded',409);
      if(!record.ocrText.length||record.provenance?.layer==='reference'||record.provenance?.document?.fileIndex?.coverage==='lightweight'){skippedChunks++;continue;}
      const fingerprint=memoryEvidenceFingerprint(record),profile=memoryProfile(record);
      for(let offset=0;offset<record.ocrText.length;){
        let end=Math.min(offset+budget,record.ocrText.length);
        if(end<record.ocrText.length&&/[\uD800-\uDBFF]/.test(record.ocrText[end-1])&&/[\uDC00-\uDFFF]/.test(record.ocrText[end]))end--;
        const chunk:Chunk={id,profile:profile.id,profileVersion:profile.version,group:profile.group,offset,length:end-offset,fingerprint,key:sha256(JSON.stringify([id,fingerprint,offset,end-offset,profile.id==='coding'?profile.version:skillVersion]))};
        if(this.checkpoint(chunk))skippedChunks++;else all.push(chunk);
        if(all.length>10000)throw new StoreError('Memory input exceeds 10000 chunks; use smaller jobs',413);
        offset=end;
      }
    }
    const groups:Chunk[][]=[];let group:Chunk[]=[],characters=0;
    for(const chunk of all){if(group.length&&(group[0].group!==chunk.group||characters+chunk.length>budget||group.length>=20)){groups.push(group);group=[];characters=0;}group.push(chunk);characters+=chunk.length;}
    if(group.length)groups.push(group);
    const now=new Date().toISOString(),job:MemoryJob={language:requestLocale.getStore()??'zh-CN',id:randomUUID(),modelProfileId:input.modelProfileId,modelOverride:input.modelOverride,importJobId:input.importJobId,originKey:input.originKey,timeZone:input.timeZone,status:groups.length?'queued':'completed',createdAt:now,updatedAt:now,evidenceIds,skillVersion,totalBatches:groups.length,completedBatches:0,failedBatches:0,skippedChunks,memoryIds:[]};
    const batches:StoredBatch[]=groups.map((chunks,index)=>({id:randomUUID(),index,status:'pending',chunks,evidenceRanges:chunks.map(({id,offset,length})=>({id,offset,length})),attempts:0,memoryIds:[]}));
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
    this.store.db.exec("UPDATE memory_batches SET json=json_set(json,'$.status','pending','$.errorCode','interrupted') WHERE json_extract(json,'$.status')='running'; UPDATE memory_jobs SET json=json_set(json,'$.status','queued','$.errorCode','interrupted') WHERE json_extract(json,'$.status')='running'");
  }
  run(id:string):Promise<MemoryJobDetail> {
    if(this.closed)return Promise.reject(new StoreError('Memory pipeline is closed',503));
    const existing=this.active.get(id);if(existing)return existing;
    this.storedJob(id);
    const task=this.queue.catch(()=>{}).then(()=>this.execute(id));
    this.active.set(id,task);this.queue=task;
    void task.finally(()=>this.active.delete(id)).catch(()=>{});return task;
  }
  async retry(id:string):Promise<MemoryJobDetail> {
    if(this.active.has(id))return this.active.get(id)!;
    const job=this.storedJob(id);
    for(const batch of this.batches(id))if(batch.status==='failed'){batch.status='pending';delete batch.errorCode;this.saveBatch(batch);}
    job.status='queued';delete job.errorCode;this.saveJob(job);return this.run(id);
  }
  private valid(chunk:Chunk):boolean {const record=this.options.memories.readEvidence([chunk.id])[0];return Boolean(record&&this.options.memories.isCurrentEvidence(chunk.id)&&memoryEvidenceFingerprint(record)===chunk.fingerprint);}
  private async execute(id:string):Promise<MemoryJobDetail> {
    let job=this.storedJob(id);
    if(job.status==='completed'||job.status==='cancelled'||this.closed)return this.get(id);
    if(!this.options.configured(job.modelProfileId)){job.status='waiting_for_model';job.errorCode='model_unconfigured';this.saveJob(job);return this.get(id);}
    job.status='running';delete job.errorCode;this.saveJob(job);
    for(const original of this.batches(id)){
      if(this.closed)break;
      // Re-read after each await: source edits/deletions may invalidate queued batches.
      const batch=this.batches(id).find(b=>b.id===original.id)!;
      if(batch.status!=='pending')continue;
      if(batch.chunks.some(chunk=>{const record=this.options.memories.readEvidence([chunk.id])[0];return record&&chunk.profile==='coding'&&chunk.profileVersion&&chunk.profileVersion!==memoryProfile(record).version;})){batch.status='invalidated';batch.errorCode='skill_changed';this.saveBatch(batch);continue;}
      if(!batch.chunks.every(chunk=>this.valid(chunk))){batch.status='invalidated';batch.errorCode='evidence_changed';this.saveBatch(batch);continue;}
      const chunks=batch.chunks.filter(chunk=>!this.checkpoint(chunk));
      job=this.storedJob(id);job.skippedChunks+=batch.chunks.length-chunks.length;this.saveJob(job);
      if(!chunks.length){batch.status='completed';delete batch.errorCode;this.saveBatch(batch);continue;}
      if(!this.options.configured(job.modelProfileId)){job.status='waiting_for_model';job.errorCode='model_unconfigured';this.saveJob(job);return this.get(id);}
      batch.status='running';delete batch.errorCode;this.saveBatch(batch);
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
          const question=profile.prompt+(feedback?'\n\nHost validation rejected the previous output. '+feedback.repairInstruction+' Generate a fresh response from the same supplied evidence. No invalid memories have been saved.':'');
          const result=await this.options.query({language:job.language,modelProfileId:job.modelProfileId,modelOverride:job.modelOverride,question,skill:profile.skill,responseMode:'memory-extraction',evidenceIds:[...new Set(chunks.map(c=>c.id))],evidenceRanges:ranges.map(range=>({...range})),timeZone:job.timeZone});
          if(this.closed){batch.status='pending';batch.errorCode='interrupted';this.saveBatch(batch);break;}
          try{
            this.options.memories.extract(result,model,{profile:profile.id,skillVersion:profile.id==='coding'?profile.version:job.skillVersion,evidenceRanges:ranges,expectedFingerprints:Object.fromEntries(chunks.map(c=>[c.id,c.fingerprint])),onSaved:items=>{
              batch.status='completed';batch.memoryIds=items.map(m=>m.id);delete batch.errorCode;
              this.saveBatch(batch);
              for(const chunk of chunks)this.store.db.prepare('INSERT OR IGNORE INTO memory_checkpoints(key,evidence_id,completed_at) VALUES(?,?,?)').run(chunk.key,chunk.id,new Date().toISOString());
            }});
            break;
          }catch(error){if(generation===0&&error instanceof MemoryOutputValidationError){feedback=error;continue;}throw error;}
        }
      }catch(error){
        const current=this.batches(id).find(b=>b.id===batch.id)!;
        if(current.status!=='invalidated'){
          batch.status=this.closed?'pending':error instanceof StoreError&&error.statusCode===409?'invalidated':'failed';
          batch.errorCode=this.closed?'interrupted':error instanceof StoreError&&error.statusCode===409?'evidence_changed':error instanceof StoreError&&error.statusCode===507?'storage_full':error instanceof StoreError&&error.statusCode===502?'invalid_model_output':'model_failed';
          this.saveBatch(batch);
        }
      }
    }
    const detail=this.get(id);job=this.storedJob(id);
    job.status=this.closed?'queued':detail.failedBatches?'failed':detail.completedBatches===detail.totalBatches?'completed':'queued';
    job.errorCode=detail.batches.find(b=>b.errorCode)?.errorCode;
    this.saveJob(job);return this.get(id);
  }
  async close(){this.closed=true;await Promise.allSettled([...this.active.values()]);}
}
