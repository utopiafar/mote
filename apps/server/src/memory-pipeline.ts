import {memoryFeedbackBatchId,validMemoryFeedbackPlan,type MemoryFeedbackPlanner,type MemoryFeedbackRequest,type MemoryFeedbackPlan,type MemoryFeedbackGroup} from './memory-feedback.js';
import {decodeMemoryJob,encodeMemoryJob,decodeMemoryBatch,encodeMemoryBatch,installMemoryPrivateRetirement} from './memory-private-storage.js';
import {memoryWorkPackageSchema,memoryWorkInstruction,memoryWorkCandidateLimit,readMemoryWorkCoverage,type MemoryWorkPackage,type MemoryWorkMember,type MemoryWorkCoverage} from './memory-work-contract.js';
import type {MaterialInputPin,MaterialDependencyStatus} from './material-readiness.js';
import {MemoryInputPlans,manualMemoryInputPlanSchema,type ManualMemoryInputPlanRequest,type ManualMemoryInputPlan,type MemoryPlanSummary,type MemoryRecipeProgress} from './memory-input-plans.js';
import type {MaterialSourcePin} from './material-source-pin.js';
import {automaticMemoryGrantSchema,type AutomaticMemoryGrant} from './memory-input-authorization.js';
import {ExecutionEngine,ExecutionFailure,type ExecutionStep} from './execution-engine.js';
import {withExecutionCancellation} from './execution-cancellation.js';
import {requestLocale} from './i18n.js';
import {AgentResponseError,AgentTimeoutError,SYSTEM_PROMPT,skillCatalog,type QueryInput} from '@mote/agent';
import {memoryProfile} from './memory-profiles.js';
import {MemoryStrategies} from './memory-strategies.js';
import {defaultMemoryReviewStrategy} from './memory-review-policy.js';
import {memoryStrategyRefSchema,memoryStrategyPin,MEMORY_CANDIDATE_OUTPUT_CONTRACT,type MemoryStrategyRef,type MemoryRecipeBinding,type MemoryReviewStrategy} from './memory-strategy-contract.js';
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
import {formatMaterialRef} from './materials.js';
import {MemoryExtractionDrafts} from './memory-extraction-drafts.js';

export type MemoryValidationFailure={at:string;code:string;phase:'extract'|'review';attempt?:number;runId?:string;details?:MemoryValidationDetails};
export type MemoryValidationFailureEvent=MemoryValidationFailure&{jobId:string;batchId:string;batchIndex:number};

type Chunk=EvidenceRange&{strategy?:MemoryRecipeBinding;reviewFingerprint?:string;profile?:'personal'|'coding';profileVersion?:string;group?:string;fingerprint:string;key:string};
export type MemoryBatch={replanRound?:number;feedbackRound?:number;feedbackWorkId?:string;workerGoal?:string;workerInstruction?:string;contextRanges?:EvidenceRange[];coverage?:MemoryWorkMember[];reviewReceipt?:MemoryReviewReceipt;supersededBy?:string[];strategy?:MemoryRecipeBinding;configuration?:ModelConfiguration;id:string;index:number;status:'pending'|'running'|'completed'|'failed'|'invalidated';evidenceRanges:EvidenceRange[];attempts:number;memoryIds:string[];availableAt?:number;errorCode?:string;validationFailures?:MemoryValidationFailure[];phase?:'extract'|'review';stage?:string;startedAt?:string;lastActivityAt?:string;execution?:ExecutionEnvelope;splitDepth?:number;splitHistory?:{at:string;errorCode:'provider_timeout'|'memory_coverage_incomplete'|'memory_capacity_saturated';attempts:number;evidenceRanges:EvidenceRange[]}[]};
type BatchInputScope={planIds?:string[];materialInputs:MaterialInputPin[];materialRefs:Record<string,string>};
type StoredBatch=MemoryBatch&BatchInputScope&{artifactRefs?:{id:string;revision:string}[];chunks:Chunk[];contextChunks?:Chunk[];skillVersion?:string;resourceEvidenceIds?:string[]};
export type MemoryJob={authorizedChunks?:Chunk[];activationRequired:boolean;inputPlanVersion:1;inputPlans:MemoryPlanSummary;recipeProgress:MemoryRecipeProgress[];materialInputs?:MaterialInputPin[];batchCharacters?:number;automaticGrant?:AutomaticMemoryGrant;automaticGrants?:AutomaticMemoryGrant[];workPackage?:MemoryWorkPackage;contextTime:string;recipes?:MemoryStrategyRef[];configuration?:ModelConfiguration;artifactRefs?:{id:string;revision:string}[];materialRefs?:Record<string,string>;language?:'zh-CN'|'en';id:string;modelProfileId?:string;modelOverride?:string;importJobId?:string;originKey?:string;timeZone?:string;status:'queued'|'running'|'completed'|'failed'|'waiting_for_model'|'waiting_for_input'|'cancelled'|'paused'|'pausing';createdAt:string;updatedAt:string;evidenceIds:string[];skillVersion:string;totalBatches:number;completedBatches:number;failedBatches:number;skippedChunks:number;memoryIds:string[];memoryCount:number;availableAt?:number;errorCode?:string;queuePosition?:number;runningBatches?:number;pendingBatches?:number;lastSavedAt?:string;execution?:ExecutionEnvelope};
export type MemoryJobDetail=MemoryJob&{batches:MemoryBatch[]};
export type MemoryPipelineQuery={taskContext?:QueryInput['taskContext'];processingMaterialInputs?:QueryInput['processingMaterialInputs'];contextTime?:string;signal?:AbortSignal;language?:'zh-CN'|'en';modelProfileId?:string;modelOverride?:string;question:string;skill:'memory-extraction'|'coding-memory'|'memory-strategy';responseMode:'memory-extraction';evidenceIds:string[];evidenceRanges:EvidenceRange[];timeZone?:string;validateOutput?:QueryInput['validateOutput'];onProgress?:QueryInput['onProgress'];onTrace?:QueryInput['onTrace'];traceContext?:QueryInput['traceContext']};
export type ConversationPreparation={candidatePolicy?:{prompt:string;profile:'personal'|'coding';fingerprint:string};job:MemoryJob;ranges:EvidenceRange[];materialRefs:Record<string,string>;materialInputs:MaterialInputPin[];signal:AbortSignal;parentGrant:{stepId:string;fence:string}};
export type MemoryPipelineOptions={understand?:(input:ConversationPreparation)=>Promise<{id:string;revision:string}[]|undefined>;materialSourceCurrent?:(pin:MaterialSourcePin,materialId:string)=>boolean;materialPlanAllowed?:(materialId:string,profileId?:string)=>boolean;deletionEvidenceAllowedForMemory?:(id:string,profileId?:string)=>boolean;materialInput?:(ref:string,required:readonly string[])=> (MaterialInputPin&{ready:boolean;dependencies?:MaterialDependencyStatus[]})|undefined;materialRequirements?:(ref:string)=>string[]|undefined;automaticAllowed?:(job:MemoryJob)=>boolean;strategies?:MemoryStrategies;configuration?:(profileId?:string,modelOverride?:string)=>ModelConfiguration;executor?:ExecutionEngine;concurrency?:()=>number;onValidationFailure?:(event:MemoryValidationFailureEvent)=>void;requireAdmission?:boolean;review?:(input:MemoryPipelineQuery,result:QueryResult,strategy?:MemoryReviewStrategy)=>Promise<QueryResult>;materialAllowedForMemory?:(ref:string,profileId?:string,required?:readonly string[])=>boolean;evidenceAllowedForMemory?:(id:string,profileId?:string)=>boolean;store:Store;memories:MemoryStore;query:(input:MemoryPipelineQuery)=>Promise<QueryResult>;model:(profileId?:string)=>string;configured:(profileId?:string)=>boolean;skillVersion?:string;batchCharacters?:number|(()=>number)};

type ReadyInputScope={strategy?:MemoryRecipeBinding;ids:string[];inputs:MaterialInputPin[];refs:Record<string,string>;planIds?:string[]};
type BatchOutput={feedbackPlan?:MemoryFeedbackPlan;coverage?:MemoryWorkCoverage;subdivide?:'memory_coverage_incomplete'|'memory_capacity_saturated';strategy?:MemoryRecipeBinding;result:QueryResult;reviewReceipt?:MemoryReviewReceipt;model:string;profile:'personal'|'coding';skillVersion:string;ranges:EvidenceRange[];chunks:Chunk[]};

/** Jobs reference originals. Validated drafts have a separate private, dependency-bound stage store. */
export class MemoryPipeline {
  private feedbackPlanner?:MemoryFeedbackPlanner;
  private feedbackApplied?:(plan:MemoryFeedbackPlan,jobId:string)=>void;
  private feedbackCancel?:(jobId:string)=>void;
  setFeedbackPlanner(planner?:MemoryFeedbackPlanner,onApplied?:(plan:MemoryFeedbackPlan,jobId:string)=>void,onCancel?:(jobId:string)=>void){this.feedbackPlanner=planner;this.feedbackApplied=onApplied;this.feedbackCancel=onCancel;}
  readonly strategies:MemoryStrategies;
  private drafts:MemoryExtractionDrafts;
  private inputPlans:MemoryInputPlans;
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
      if(Number(counts.running)===0&&!this.inputBusy(job)&&(this.closed||['paused','cancelled','waiting_for_model','waiting_for_input','completed','failed'].includes(job.status)||Number(counts.pending)===0)){
        const done=this.completions.get(id);this.completions.delete(id);this.active.delete(id);done?.resolve(this.get(id));
      }
    }
  }
  private inputBusy(job:MemoryJob){if(this.closed)return false;return this.inputPlans.list(job.id).some(plan=>{const step=this.engine.get(plan.id);return step?.state==='running'||step?.state==='waiting'&&step.availableAt<=Date.now();});}
  private queuePosition(id:string){const row=this.store.db.prepare("SELECT count(*) n FROM memory_jobs WHERE json_extract(json,'$.status') IN ('queued','running') AND rowid<=(SELECT rowid FROM memory_jobs WHERE id=?)").get(id);return Number(row?.n)||undefined;}
  private steps(id:string){return this.store.db.prepare("SELECT id FROM execution_steps WHERE operation_id=? AND kind IN ('memory.batch','memory.input')").all('memory:'+id).map(row=>String(row.id));}
  pause(id:string){const job=this.storedJob(id);if(['queued','running','waiting_for_input'].includes(job.status)){job.status=Number(this.counts(id).running)>0?'pausing':'paused';this.saveJob(job);this.wake();}return this.get(id);}
  resume(id:string){const job=this.storedJob(id);if(!['paused','pausing'].includes(job.status))return;job.status='queued';this.saveJob(job);for(const plan of this.inputPlans.list(id)){const step=this.engine.get(plan.id);if(step?.state==='waiting'||step?.state==='blocked'&&['paused','pausing'].includes(step.error??''))this.engine.retry(plan.id,false);}this.prepare(id);void this.run(id).catch(()=>{});this.wake();}
  cancel(id:string){const job=this.storedJob(id);if(!['completed','cancelled'].includes(job.status)){job.status='cancelled';this.saveJob(job);for(const step of this.steps(id))this.engine.cancel(step);this.feedbackCancel?.(id);this.wake();}return this.get(id);}

  private closed=false;
  private batchBudget(){
    const value=typeof this.options.batchCharacters==='function'?this.options.batchCharacters():this.options.batchCharacters??12000;
    if(!Number.isSafeInteger(value)||value<256||value>12000)throw new StoreError('Memory batch budget must be 256–12000 characters');
    return value;
  }
  private unregister:Array<()=>Promise<void>>=[];
  constructor(private options:MemoryPipelineOptions){
    this.strategies=options.strategies??new MemoryStrategies();
    this.batchBudget();
    this.initializeCounts();
    this.initializePrivateStorage();
    this.drafts=new MemoryExtractionDrafts(this.store);
    this.inputPlans=new MemoryInputPlans(this.store);
    this.engine=options.executor??new ExecutionEngine(this.store);this.owned=!options.executor;
    this.recover();
    this.unregister.push(this.engine.register({kind:'memory.batch',pool:'memory.batch',concurrency:()=>this.options.concurrency?.()??1,maxAttempts:1,timeoutMs:3600000,
      resourceKeys:step=>(step.input.evidenceIds as string[]).map(id=>'memory-evidence:'+id),
      validate:step=>this.validateStep(step),validateGrant:step=>{try{const job=this.storedJob(String(step.input.jobId));if(['cancelled','paused'].includes(job.status))return false;this.assertAutomatic(job);return true;}catch{return false;}},admit:step=>{
        const job=this.storedJob(String(step.input.jobId));
        if(['paused','pausing'].includes(job.status))return new ExecutionFailure('blocked','paused');
        if(job.status==='cancelled'||this.closed)return new ExecutionFailure('blocked','cancelled');
        if(job.activationRequired&&!this.active.has(job.id))return new ExecutionFailure('blocked','awaiting_activation');
        // Lifecycle recovery must still honor its saved retry window and enablement.
        if(!this.options.configured(job.modelProfileId))return new ExecutionFailure('blocked','model_unconfigured');
        if(this.options.configuration){const current=this.options.configuration(job.modelProfileId,job.modelOverride);if(job.configuration&&job.configuration.fingerprint!==current.fingerprint)return new ExecutionFailure('blocked','configuration_changed');if(!job.configuration){job.configuration=structuredClone(current);this.store.reserveMetadata(Buffer.byteLength(JSON.stringify(current)));this.saveJob(job);}}
      },
      execute:(step,signal)=>{const fence=this.store.db.prepare('SELECT fence FROM execution_steps WHERE id=?').get(step.id)?.fence;return this.execute(String(step.input.jobId),String(step.input.batchId),signal,()=>typeof fence==='string'&&this.engine.isCurrentGrant(step.id,fence));},
      commit:(step,output)=>this.commitBatch(step,output as BatchOutput|undefined),
      project:step=>this.projectStep(step),
    }));
    this.unregister.push(this.engine.register({kind:'memory.input',pool:'memory.input',concurrency:()=>4,maxAttempts:1,timeoutMs:30000,
      validate:step=>{const plan=this.inputPlans.get(String(step.input.planId));return Boolean(plan&&this.options.materialSourceCurrent?.(plan.sourcePin,plan.materialId));},
      admit:step=>{const plan=this.inputPlans.get(String(step.input.planId))!,job=this.storedJob(plan.jobId);if(this.closed||['paused','pausing','cancelled'].includes(job.status))return new ExecutionFailure('blocked',this.closed?'awaiting_activation':job.status);const state=this.evaluatePlan(plan,job);if(state.state!=='ready')return new ExecutionFailure(state.state==='waiting'?'waiting':state.state==='stale'?'stale':'blocked',state.code,30000);},
      execute:async()=>undefined,commit:step=>this.bindInput(step),classify:error=>error instanceof StoreError&&error.statusCode===507?new ExecutionFailure('blocked','storage_full'):new ExecutionFailure('permanent',error instanceof StoreError&&error.statusCode===413?'memory_input_limit':'memory_input_failed'),project:step=>{if(this.store.db.prepare('SELECT 1 FROM memory_jobs WHERE id=?').get(String(step.input.jobId))){this.refreshJob(String(step.input.jobId));this.wake();}}
    }));
  }
  private initializePrivateStorage(){
    const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
    try{
      if(installMemoryPrivateRetirement(this.store))for(const row of db.prepare('SELECT id,json FROM memory_jobs').all()){
        const job=decodeMemoryJob(this.store,String(row.json));for(const id of new Set((job.evidenceIds??[]).flatMap(id=>this.options.memories.dependencyIds(id))))if(!db.prepare('SELECT 1 FROM memory_job_dependencies WHERE job_id=? AND evidence_id=?').get(job.id,id)){this.store.reserveMetadata(Buffer.byteLength(job.id)+Buffer.byteLength(id)+64);db.prepare('INSERT OR IGNORE INTO memory_job_dependencies VALUES(?,?)').run(job.id,id);}
      }
      if(own)db.exec('COMMIT');
    }catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}
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
`);
  }
  private get store(){return this.options.store;}
  private formalMaterialsEnabled(){return Boolean(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_evidence'").get());}
  /** SourceStore originals are intake evidence, not a Memory input. They must
   * enter through a published Material anchor with its declared dependencies. */
  private rawSourceItem(id:string):boolean {
    if(!this.formalMaterialsEnabled())return false;
    const record=this.options.memories.readEvidence([id])[0];
    const sourceId=record?.provenance?.sourceId,externalId=record?.provenance?.externalId;
    if(!sourceId||!externalId||record.source==='screen'||record.source==='ui_page')return false;
    return Boolean(this.store.db.prepare('SELECT 1 FROM source_connections WHERE id=?').get(sourceId));
  }
  private currentMaterialRef(id:string):string|undefined {
    if(!this.formalMaterialsEnabled())return;
    const row=this.store.db.prepare(`SELECT h.id,h.revision,h.retired FROM material_evidence e
      JOIN material_heads h ON h.id=e.material_id WHERE e.id=?`).get(id) as
      {id:string;revision:string;retired:number}|undefined;
    return row&&!row.retired?formatMaterialRef(row.id,row.revision):undefined;
  }
  private materialAdmission(ids:readonly string[],pinned?:Readonly<Record<string,string>>,profileId?:string,inputs:readonly MaterialInputPin[]=[]):Record<string,string> {
    const refs:Record<string,string>={};
    const byEvidence=new Map<string,MaterialInputPin[]>(),checked=new Map<MaterialInputPin,{ref:string;allowed:boolean}>();
    for(const input of inputs)for(const id of input.evidenceIds){const selected=byEvidence.get(id)??[];selected.push(input);byEvidence.set(id,selected);}
    for(const id of ids){
      if(this.options.evidenceAllowedForMemory&&!this.options.evidenceAllowedForMemory(id,profileId))throw new StoreError('Memory evidence is not allowed for this model',409);
      const ref=this.currentMaterialRef(id);
      if(!ref){
        if(this.rawSourceItem(id))throw new StoreError('Source item Memory requires a published Material',409);
        if(pinned?.[id])throw new StoreError('Memory Material changed',409);
        continue;
      }
      const selections=byEvidence.get(id)??[];
      const allowed=selections.length?selections.every(input=>{
        const prior=checked.get(input);if(prior?.ref===ref)return prior.allowed;
        const current=this.options.materialInput?.(ref,input.required);
        const allowed=Boolean(current?.ready&&current.materialId===input.materialId&&current.fingerprint===input.fingerprint&&
          this.options.materialAllowedForMemory?.(ref,profileId,input.required));
        checked.set(input,{ref,allowed});return allowed;
      }):this.options.materialAllowedForMemory?.(ref,profileId);
      if(!this.options.memories.isCurrentEvidence(id)||!allowed||
        pinned&&!selections.length&&pinned[id]!==ref)throw new StoreError('Memory Material dependency is not ready or changed',409);
      refs[id]=ref;
    }
    if(pinned&&Object.keys(pinned).length!==Object.keys(refs).length)throw new StoreError('Memory Material pin changed',409);
    return refs;
  }
  /** Manual extraction and consolidation use the same source-item boundary. */
  modelSnapshot(){
    if(!this.options.configured())throw new StoreError('Memory model is unavailable',409);
    const configuration=this.options.configuration?.();
    return {model:configuration?.model??this.options.model(),...(configuration?{configuration}: {})};
  }
  evidenceDependencies(ids:readonly string[]):string[]{return [...new Set(ids.flatMap(id=>this.options.memories.dependencyIds(id)))];}
  assertAdmissibleEvidence(ids:readonly string[],profileId?:string):void {this.materialAdmission(ids,undefined,profileId);}
  /** Historical deletion intent is permission-checked context, not a request to
   * admit raw originals as new Memory inputs. The candidate keeps normal admission. */
  assertDeletionEvidenceAllowed(ids:readonly string[],profileId?:string):void {
    for(const id of ids)if(!this.options.memories.readEvidence([id]).length||(this.options.deletionEvidenceAllowedForMemory??this.options.evidenceAllowedForMemory)&&!(this.options.deletionEvidenceAllowedForMemory??this.options.evidenceAllowedForMemory)!(id,profileId))throw new StoreError('Memory deletion evidence is unavailable to the selected model',409);
  }
  withAdmissibleEvidence<T>(ids:readonly string[],run:()=>T,profileId?:string):T {
    const db=this.store.db,own=!db.isTransaction;
    if(own)db.exec('BEGIN IMMEDIATE');
    try{this.materialAdmission(ids,undefined,profileId);const value=run();if(own)db.exec('COMMIT');return value;}
    catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  /** The artifact lifecycle handles current screenshots and authored
   * records. Source items have their own revision-pinned Material Memory queue. */
  intakeArtifactIds(ids:readonly string[]):string[] {
    return ids.filter(id=>{
      const artifact=this.store.archive.get(id);
      if(!artifact)return false;
      const evidenceIds=artifact.kind==='segment'?artifact.members:
        artifact.kind==='semantic'&&Array.isArray(artifact.metadata.evidenceRanges)?
          artifact.metadata.evidenceRanges.flatMap(range=>range&&typeof range==='object'&&'id' in range&&typeof range.id==='string'?[range.id]:[]):[];
      const images=Boolean(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='image_inputs'").get());
      return !evidenceIds.some(evidenceId=>this.rawSourceItem(evidenceId)||images&&this.store.db.prepare('SELECT 1 FROM image_inputs WHERE capture_id=?').get(evidenceId));
    });
  }
  private storedJob(id:string):MemoryJob {
    const row=this.store.db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(id) as {json:string}|undefined;
    if(!row)throw new StoreError('Memory job not found',404);const job=decodeMemoryJob(this.store,row.json);if(typeof job.activationRequired!=='boolean'||job.inputPlanVersion!==1||typeof job.contextTime!=='string'||!Array.isArray(job.materialInputs)||!job.materialRefs||typeof job.materialRefs!=='object'||Array.isArray(job.materialRefs))throw new StoreError('Unsupported Memory job structure',409);return job;
  }
  private batches(id:string):StoredBatch[]{return (this.store.db.prepare('SELECT json FROM memory_batches WHERE job_id=? ORDER BY idx').all(id) as {json:string}[]).map(row=>decodeMemoryBatch<StoredBatch>(this.store,row.json));}
  private batch(id:string):StoredBatch {const row=this.store.db.prepare('SELECT json FROM memory_batches WHERE id=?').get(id);if(!row)throw new StoreError('Memory batch not found',404);return decodeMemoryBatch<StoredBatch>(this.store,String(row.json));}
  private saveJob(job:MemoryJob){const {batches:_batches,inputPlans:_plans,recipeProgress:_recipes,memoryCount:_count,...value}=job as MemoryJobDetail;value.updatedAt=new Date().toISOString();const prior=this.store.db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(job.id),json=encodeMemoryJob(this.store,value,Boolean(prior&&JSON.parse(String(prior.json)).privateRetired));this.store.reserveMetadata(Math.max(0,Buffer.byteLength(json)-Buffer.byteLength(String(prior?.json??''))));this.store.db.prepare('UPDATE memory_jobs SET json=? WHERE id=?').run(json,job.id);}
  private saveBatch(batch:StoredBatch){const prior=this.store.db.prepare('SELECT json FROM memory_batches WHERE id=?').get(batch.id),json=encodeMemoryBatch(this.store,batch,Boolean(prior&&JSON.parse(String(prior.json)).privateRetired));this.store.reserveMetadata(Math.max(0,Buffer.byteLength(json)-Buffer.byteLength(String(prior?.json??''))));this.store.db.prepare('UPDATE memory_batches SET json=? WHERE id=?').run(json,batch.id);}
  private checkpoint(chunk:Chunk){return Boolean(this.store.db.prepare('SELECT key FROM memory_checkpoints WHERE key=?').get(chunk.key));}
  get(id:string):MemoryJobDetail {
    const job=this.storedJob(id),batches=this.batches(id),failedBatches=batches.filter(b=>b.status==='failed'||b.status==='invalidated').length;
    const memoryIds=[...new Set(batches.flatMap(b=>b.memoryIds))].filter(memoryId=>this.store.db.prepare('SELECT id FROM memories WHERE id=?').get(memoryId));
    const status=job.status==='completed'&&failedBatches?'failed':job.status==='queued'&&batches.some(b=>b.status==='running')?'running':job.status,attempts=batches.reduce((sum,b)=>sum+b.attempts,0);
    return {...job,...this.planView(id),status,queuePosition:this.queuePosition(id),runningBatches:batches.filter(b=>b.status==='running').length,pendingBatches:batches.filter(b=>b.status==='pending').length,lastSavedAt:(this.store.db.prepare("SELECT max(created_at) AS at FROM memories WHERE id IN (SELECT value FROM json_each(?))").get(JSON.stringify(memoryIds)) as {at?:string})?.at??undefined,totalBatches:batches.length,completedBatches:batches.filter(b=>b.status==='completed').length,failedBatches,memoryIds,memoryCount:memoryIds.length,
      execution:executionEnvelope({status:status==='paused'||status==='waiting_for_input'?'waiting':status==='pausing'?'running':status,attempts,errorCode:job.errorCode??batches.find(b=>b.errorCode)?.errorCode,availableAt:job.availableAt,updatedAt:job.updatedAt}),
      batches:batches.map(({chunks:_chunks,contextChunks:_contexts,resourceEvidenceIds:_resources,materialInputs:_inputs,materialRefs:_refs,...batch})=>({...batch,execution:executionEnvelope({status:batch.status==='pending'?'queued':batch.status==='completed'?'succeeded':batch.status==='invalidated'?'skipped':batch.status,attempts:batch.attempts,errorCode:batch.errorCode,availableAt:batch.availableAt})}))};
  }
  list(limit=30):MemoryJob[]{return this.jobSummaries(this.store.db.prepare("SELECT json_remove(json,'$.evidenceIds','$.memoryIds','$.artifactRefs','$.materialInputs','$.materialRefs','$.authorizedChunks') json FROM memory_jobs ORDER BY created_at DESC,id DESC LIMIT ?").all(Math.max(1,Math.min(limit,100))));}
  /** Stable keyset pagination, including jobs outside the latest default page. */
  page(args:{limit?:number;cursor?:string}={}):{items:MemoryJob[];nextCursor:string|null}{
    const limit=z.number().int().min(1).max(100).parse(args.limit??30);
    let cursor:{createdAt:string;id:string}|undefined;
    if(args.cursor!==undefined){
      try{
        if(!/^[A-Za-z0-9_-]{1,1000}$/.test(args.cursor))throw Error();
        cursor=z.object({createdAt:z.string().datetime({offset:true}),id:z.string().uuid()}).strict().parse(JSON.parse(Buffer.from(args.cursor,'base64url').toString('utf8')));
      }catch{throw new StoreError('Invalid Memory page cursor',400);}
    }
    const rows=this.store.db.prepare(`SELECT created_at,id,json_remove(json,'$.evidenceIds','$.memoryIds','$.artifactRefs','$.materialInputs','$.materialRefs','$.authorizedChunks') json FROM memory_jobs
      ${cursor?'WHERE created_at<? OR (created_at=? AND id<?)':''} ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(...(cursor?[cursor.createdAt,cursor.createdAt,cursor.id]:[]),limit+1);
    const selected=rows.slice(0,limit),last=selected.at(-1);
    return {items:this.jobSummaries(selected),nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({createdAt:String(last.created_at),id:String(last.id)})).toString('base64url'):null};
  }
  private jobSummaries(rows:Record<string,unknown>[]):MemoryJob[]{return rows.map(row=>{
    const job=decodeMemoryJob(this.store,String(row.json));
    const counts=this.counts(job.id);
    const memoryCount=Number(this.store.db.prepare("SELECT count(DISTINCT refs.value) AS n FROM memory_batches b, json_each(b.json,'$.memoryIds') refs WHERE b.job_id=? AND EXISTS (SELECT 1 FROM memories m WHERE m.id=refs.value)").get(job.id)?.n??0);
    return {...job,...this.planView(job.id),status:job.status==='completed'&&Number(counts.failed)>0?'failed':job.status,evidenceIds:[],memoryIds:[],memoryCount,totalBatches:Number(counts.total),completedBatches:Number(counts.completed??0),failedBatches:Number(counts.failed??0),runningBatches:Number(counts.running??0),pendingBatches:Number(counts.pending??0),queuePosition:this.queuePosition(job.id),execution:executionEnvelope({status:job.status==='paused'||job.status==='waiting_for_input'?'waiting':job.status==='pausing'?'running':job.status,attempts:Number(counts.attempts??0),errorCode:job.errorCode,availableAt:job.availableAt,updatedAt:job.updatedAt})};
  });}
  createFromArtifacts(artifactIds:string[],importJobId:string,batchCharacters=12000){
    const artifacts=artifactIds.map(id=>this.store.archive.get(id)).filter(a=>a?.kind==='semantic');
    const ranges=artifacts.flatMap(a=>z.array(z.object({id:z.string().uuid(),offset:z.number().int().min(0),length:z.number().int().min(1).max(12000)})).parse(a!.metadata.evidenceRanges??[]));
    if(!ranges.length)return undefined;
    return this.create({evidenceIds:[...new Set(ranges.map(r=>r.id))],evidenceRanges:ranges,artifactRefs:artifacts.map(a=>({id:a!.id,revision:a!.revision})),importJobId,batchCharacters});
  }
  create(raw:{manualPlans?:ManualMemoryInputPlanRequest[];automaticGrant?:AutomaticMemoryGrant;automaticGrants?:AutomaticMemoryGrant[];workPackage?:MemoryWorkPackage;contextTime?:string;recipes?:MemoryStrategyRef[];artifactRefs?:{id:string;revision:string}[];evidenceRanges?:EvidenceRange[];modelProfileId?:string;modelOverride?:string;evidenceIds:string[];importJobId?:string;originKey?:string;timeZone?:string;batchCharacters?:number}):MemoryJobDetail {
    if(this.closed)throw new StoreError('Memory pipeline is closed',503);
    const input=z.object({manualPlans:z.array(manualMemoryInputPlanSchema).min(1).max(2000).optional(),automaticGrant:automaticMemoryGrantSchema.optional(),automaticGrants:z.array(automaticMemoryGrantSchema).min(1).max(8).optional(),workPackage:memoryWorkPackageSchema.optional(),contextTime:z.string().datetime({offset:true}).optional(),recipes:z.array(memoryStrategyRefSchema).min(1).max(8).refine(values=>new Set(values.map(v=>v.id+'@'+v.version)).size===values.length,'Duplicate Memory recipe').optional(),artifactRefs:z.array(z.object({id:z.string().length(64),revision:z.string().length(64)})).max(2000).optional(),evidenceRanges:z.array(z.object({id:z.string().uuid(),offset:z.number().int().min(0),length:z.number().int().min(1).max(12000)})).max(10000).optional(),modelProfileId:modelProfileIdSchema.optional(),modelOverride:z.string().trim().min(1).max(512).refine(v=>!/[\u0000-\u001f\u007f]/.test(v)).optional(),originKey:z.string().max(200).optional(),batchCharacters:z.number().int().min(256).max(12000).optional(),evidenceIds:z.array(z.string().uuid()).max(20000),importJobId:z.string().max(200).optional(),timeZone:z.string().max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},'Invalid time zone').optional()}).strict().parse(raw);
    if(input.manualPlans)return this.createManual(input);
    if(input.workPackage&&!this.options.review)throw new StoreError('Memory work packages require independent review',409);
    if(!input.evidenceIds.length)throw new StoreError('No evidence in this range',409);
    const selectedRecipes=input.recipes?.map(ref=>{try{return this.strategies.resolve(ref);}catch{throw new StoreError('Memory recipe is unavailable',409);}});
    if(selectedRecipes&&!this.options.review)throw new StoreError('Memory recipes require the host review executor',409);
    const plans=(selectedRecipes??[undefined]).map(recipe=>{
      const pins=new Map<string,MaterialInputPin>();
      const selections=new Map<string,MaterialInputPin&{ready:boolean}>();
      const ids=[...new Set(input.evidenceIds)].filter(id=>{
        const ref=this.currentMaterialRef(id);let selection=ref?selections.get(ref):undefined;
        if(!selection){
          const required=recipe?.binding.requires??(ref&&this.options.materialInput&&true?this.options.materialRequirements?.(ref)??['material']:undefined);
          if(!required)return true;
          selection=ref?this.options.materialInput?.(ref,required):undefined;
          if(!ref||!selection?.ready)throw new StoreError('Memory recipe input is not ready',409);
          selections.set(ref,selection);
        }
        const {materialId,required:keys,fingerprint,evidenceIds}=selection;
        pins.set(materialId,{materialId,required:keys,fingerprint,evidenceIds});
        return evidenceIds.includes(id);
      });
      if(!ids.length)throw new StoreError('No evidence belongs to the selected Memory recipe inputs',409);
      const inputs=[...pins.values()],refs=this.materialAdmission(ids,undefined,input.modelProfileId,inputs);
      return {recipe,ids,inputs,refs};
    });
    const materialInputs=plans.flatMap(plan=>plan.inputs),materialRefs=Object.assign({},...plans.map(plan=>plan.refs)) as Record<string,string>;

    // Import completion may be replayed after a process interruption.
    if(input.importJobId){const prior=this.store.db.prepare("SELECT id FROM memory_jobs WHERE json_extract(json,'$.importJobId')=?").get(input.importJobId) as {id:string}|undefined;if(prior)return this.get(prior.id);}
    if(input.originKey){const prior=this.store.db.prepare("SELECT id FROM memory_jobs WHERE json_extract(json,'$.originKey')=?").get(input.originKey) as {id:string}|undefined;if(prior)return this.get(prior.id);}
    const jobTime=new Date().toISOString(),evaluationTime=input.contextTime??jobTime;
    const budget=input.batchCharacters??this.batchBudget(),evidenceIds=[...new Set(plans.flatMap(plan=>plan.ids))],now=jobTime;
    const job:MemoryJob={activationRequired:true,inputPlanVersion:1,inputPlans:{total:0,waiting:0,blocked:0,stale:0,completed:0},recipeProgress:[],memoryCount:0,materialInputs,batchCharacters:budget,automaticGrant:input.automaticGrant,automaticGrants:input.automaticGrants,workPackage:input.workPackage,contextTime:evaluationTime,recipes:input.recipes,artifactRefs:input.artifactRefs,materialRefs,language:requestLocale.getStore()??'zh-CN',id:randomUUID(),modelProfileId:input.modelProfileId,modelOverride:input.modelOverride,importJobId:input.importJobId,originKey:input.originKey,timeZone:input.timeZone,status:'queued',createdAt:now,updatedAt:now,evidenceIds,skillVersion:this.options.skillVersion??MEMORY_SKILL_VERSION,totalBatches:0,completedBatches:0,failedBatches:0,skippedChunks:0,memoryIds:[]};
    const {batches,skippedChunks,authorizedChunks}=this.makeBatches(job,plans.map(plan=>({...plan,strategy:plan.recipe?.binding})),input.evidenceRanges);
    if(job.workPackage)job.authorizedChunks=authorizedChunks;
    job.status=batches.length?'queued':'completed';job.totalBatches=batches.length;job.skippedChunks=skippedChunks;
    const own=!this.store.db.isTransaction;if(own)this.store.db.exec('BEGIN IMMEDIATE');
    try{
      this.materialAdmission(evidenceIds,materialRefs,input.modelProfileId,materialInputs);
      const jobJson=encodeMemoryJob(this.store,job),batchJson=batches.map(batch=>encodeMemoryBatch(this.store,batch));
      const dependencies=[...new Set(evidenceIds.flatMap(id=>this.options.memories.dependencyIds(id)))];
      this.store.reserveMetadata(Buffer.byteLength(jobJson)+batchJson.reduce((sum,json)=>sum+Buffer.byteLength(json),0)+dependencies.reduce((sum,id)=>sum+Buffer.byteLength(id)+Buffer.byteLength(job.id)+64,0));
      this.store.db.prepare('INSERT INTO memory_jobs(id,created_at,json) VALUES(?,?,?)').run(job.id,now,jobJson);
      for(const id of dependencies)this.store.db.prepare('INSERT OR IGNORE INTO memory_job_dependencies VALUES(?,?)').run(job.id,id);
      for(const batch of batches){this.store.db.prepare('INSERT INTO memory_batches(id,job_id,idx,json) VALUES(?,?,?,?)').run(batch.id,job.id,batch.index,batchJson[batches.indexOf(batch)]);for(const id of new Set(batch.chunks.flatMap(chunk=>this.options.memories.dependencyIds(chunk.id))))this.store.db.prepare('INSERT INTO memory_batch_dependencies(batch_id,evidence_id) VALUES(?,?)').run(batch.id,id);}
      if(own)this.store.db.exec('COMMIT');
    }catch(error){if(own)this.store.db.exec('ROLLBACK');throw error;}
    return this.get(job.id);
  }
  private makeBatches(job:MemoryJob,plans:ReadyInputScope[],evidenceRanges?:EvidenceRange[],startIndex=0){
    const budget=job.batchCharacters??this.batchBudget(),all:Chunk[]=[],authorizedChunks:Chunk[]=[],refsByEvidence=new Map<string,{id:string;revision:string}[]>();let skippedChunks=0;
    for(const ref of job.artifactRefs??[]){const artifact=this.store.archive.get(ref.id);if(!artifact||artifact.revision!==ref.revision)throw new StoreError('Semantic input changed',409);for(const range of (artifact.metadata.evidenceRanges??[]) as EvidenceRange[]){const refs=refsByEvidence.get(range.id)??[];if(!refs.some(r=>r.id===ref.id))refs.push(ref);refsByEvidence.set(range.id,refs);}}
    for(const plan of plans)for(const id of plan.ids){
      const record=this.options.memories.readEvidence([id])[0];if(!record||!this.options.memories.isCurrentEvidence(id))throw new StoreError('Memory input evidence is missing or superseded',409);
      if(!record.ocrText.length||record.provenance?.layer==='reference'||record.provenance?.document?.fileIndex?.coverage==='lightweight'){skippedChunks++;continue;}
      const fingerprint=memoryEvidenceFingerprint(record),profile=memoryProfile(record),selected=evidenceRanges?evidenceRanges.filter(r=>r.id===id):[{id,offset:0,length:record.ocrText.length}];
      for(const range of selected){if(range.offset+range.length>record.ocrText.length)throw new StoreError('Semantic evidence range changed',409);
        for(let offset=range.offset;offset<range.offset+range.length;){let end=Math.min(offset+budget,range.offset+range.length);if(end<record.ocrText.length&&/[\uD800-\uDBFF]/.test(record.ocrText[end-1])&&/[\uDC00-\uDFFF]/.test(record.ocrText[end]))end--;
          const reviewFingerprint=this.options.review?memoryStrategyPin(defaultMemoryReviewStrategy).fingerprint:undefined,strategy=plan.strategy;
          const chunk:Chunk={id,profile:profile.id,profileVersion:profile.version,strategy,reviewFingerprint:strategy?undefined:reviewFingerprint,group:JSON.stringify([strategy??null,profile.group]),offset,length:end-offset,fingerprint,key:sha256(JSON.stringify([id,fingerprint,offset,end-offset,strategy??(profile.id==='coding'?profile.version:job.skillVersion),strategy?[job.contextTime,job.timeZone??'UTC',job.language??'zh-CN']:reviewFingerprint]))};
          if(job.workPackage)chunk.key=sha256(JSON.stringify([chunk.key,'memory-work@1']));
          if(job.artifactRefs?.length)chunk.key=sha256(JSON.stringify([chunk.key,refsByEvidence.get(id)??[]]));
          authorizedChunks.push({...chunk});if(this.checkpoint(chunk))skippedChunks++;else all.push(chunk);if(all.length>10000)throw new StoreError('Memory input exceeds 10000 chunks; use smaller jobs',413);offset=end;
        }
      }
    }
    const groups:Chunk[][]=[];let group:Chunk[]=[],characters=0;for(const chunk of all){if(group.length&&(group[0].group!==chunk.group||characters+chunk.length>budget||group.length>=20)){groups.push(group);group=[];characters=0;}group.push(chunk);characters+=chunk.length;}if(group.length)groups.push(group);
    const batches:StoredBatch[]=groups.map((chunks,index)=>{
      const ids=new Set(chunks.map(c=>c.id)),selected=plans.filter(plan=>JSON.stringify(plan.strategy)===JSON.stringify(chunks[0].strategy)&&plan.ids.some(id=>ids.has(id)));
      const inputs=[...new Map(selected.flatMap(plan=>plan.inputs).filter(pin=>pin.evidenceIds.some(id=>ids.has(id))).map(pin=>[JSON.stringify(pin),pin])).values()];
      return {strategy:chunks[0].strategy,planIds:[...new Set(selected.flatMap(plan=>plan.planIds??[]))],materialInputs:inputs,materialRefs:Object.fromEntries(selected.flatMap(plan=>Object.entries(plan.refs)).filter(([id])=>ids.has(id))),artifactRefs:[...new Map(chunks.flatMap(c=>refsByEvidence.get(c.id)??[]).map(ref=>[ref.id,ref])).values()],id:randomUUID(),index:startIndex+index,status:'pending',chunks,evidenceRanges:chunks.map(({id,offset,length})=>({id,offset,length})),attempts:0,memoryIds:[]};
    });if(job.workPackage)for(const batch of batches)batch.coverage=this.workMembers(job,batch,batch.chunks);return {batches,skippedChunks,authorizedChunks};
  }
  private insertBatch(jobId:string,batch:StoredBatch){
    const json=encodeMemoryBatch(this.store,batch),dependencies=[...new Set([...batch.chunks,...(batch.contextChunks??[])].flatMap(c=>this.options.memories.dependencyIds(c.id)))];
    const newJobDependencies=dependencies.filter(id=>!this.store.db.prepare('SELECT 1 FROM memory_job_dependencies WHERE job_id=? AND evidence_id=?').get(jobId,id));
    this.store.reserveMetadata(Buffer.byteLength(json)+newJobDependencies.reduce((sum,id)=>sum+Buffer.byteLength(jobId)+Buffer.byteLength(id)+64,0));
    for(const id of newJobDependencies)this.store.db.prepare('INSERT OR IGNORE INTO memory_job_dependencies VALUES(?,?)').run(jobId,id);
    this.store.db.prepare('INSERT INTO memory_batches(id,job_id,idx,json) VALUES(?,?,?,?)').run(batch.id,jobId,batch.index,json);
    for(const id of dependencies)this.store.db.prepare('INSERT INTO memory_batch_dependencies(batch_id,evidence_id) VALUES(?,?)').run(batch.id,id);
  }
  private batchScope(_job:MemoryJob,batch:StoredBatch):BatchInputScope {
    if(!Array.isArray(batch.materialInputs)||!batch.materialRefs||typeof batch.materialRefs!=='object'||Array.isArray(batch.materialRefs))throw new StoreError('Memory batch requires frozen material inputs',409);
    return batch;
  }
  private sliceBatchScope(job:MemoryJob,batch:StoredBatch,chunks:Chunk[]):BatchInputScope{const scope=this.batchScope(job,batch),ids=new Set([...chunks,...(batch.contextChunks??[])].map(c=>c.id));return {materialInputs:scope.materialInputs.filter(pin=>pin.evidenceIds.some(id=>ids.has(id))),materialRefs:Object.fromEntries(Object.entries(scope.materialRefs).filter(([id])=>ids.has(id))),planIds:batch.planIds?.filter(id=>this.inputPlans.get(id)?.resolvedInput?.evidenceIds.some(evidenceId=>ids.has(evidenceId)))};}
  private workMembers(job:MemoryJob,batch:StoredBatch,chunks:Chunk[]):MemoryWorkMember[]{
    return chunks.map(chunk=>{const materialRef=batch.materialRefs[chunk.id],identity=job.workPackage?.inputs?.find(input=>input.ref===materialRef);
      // Coverage names the exact source range, while checkpoints and grants
      // retain their independent review-policy identities. Identical authorized
      // extraction inputs can therefore reuse a private draft across reviewers.
      return {key:sha256(JSON.stringify(['memory-member@1',chunk.id,chunk.offset,chunk.length,chunk.fingerprint,identity?.contextTime??job.contextTime])),id:chunk.id,offset:chunk.offset,length:chunk.length,fingerprint:chunk.fingerprint,materialRef,inputKey:identity?.inputKey,scope:identity?.scope,contextTime:identity?.contextTime,state:'pending',memoryIds:[]};});
  }
  private feedbackRequest(job:MemoryJob,batch:StoredBatch,targets:MemoryWorkMember[],coverage:MemoryWorkCoverage):MemoryFeedbackRequest {
    const compatible=(chunk:Chunk)=>JSON.stringify([chunk.strategy??null,chunk.profile,chunk.profileVersion,chunk.reviewFingerprint])===JSON.stringify([batch.chunks[0]?.strategy??null,batch.chunks[0]?.profile,batch.chunks[0]?.profileVersion,batch.chunks[0]?.reviewFingerprint]),all=this.workMembers(job,{...batch,materialRefs:job.materialRefs??{}},(job.authorizedChunks??this.batches(job.id).flatMap(batch=>batch.chunks)).filter(compatible)),wanted=new Set(coverage.flatMap(row=>row.contextRefs??[]));
    const targetKeys=new Set(targets.map(member=>member.key)),preferred=all.filter(member=>!targetKeys.has(member.key)&&(wanted.has(member.key)||wanted.has(member.id)||Boolean(member.materialRef&&wanted.has(member.materialRef)))),remaining=all.filter(member=>!targetKeys.has(member.key)&&!preferred.some(value=>value.key===member.key));
    return {jobId:job.id,batchId:batch.id,round:batch.feedbackRound??(batch.replanRound??0)+1,contextTime:job.contextTime,configuration:job.configuration,targets,authorized:[...targets,...preferred,...remaining].slice(0,64),coverage};
  }
  /** Read-only validation for durable feedback coordinators and linked products. */
  feedbackAllowed(request:MemoryFeedbackRequest):boolean {
    try{const job=this.storedJob(request.jobId),batch=this.batch(request.batchId);if(job.status==='cancelled'||request.round<1||request.round>2||request.authorized.length>64||request.targets.length>20||this.store.db.prepare("SELECT json_extract(json,'$.privateRetired') retired FROM memory_jobs WHERE id=?").get(job.id)?.retired)return false;
      this.assertAutomatic(job);this.assertConfiguration(job);
      const compatible=(chunk:Chunk)=>JSON.stringify([chunk.strategy??null,chunk.profile,chunk.profileVersion,chunk.reviewFingerprint])===JSON.stringify([batch.chunks[0]?.strategy??null,batch.chunks[0]?.profile,batch.chunks[0]?.profileVersion,batch.chunks[0]?.reviewFingerprint]),all=this.workMembers(job,{...batch,materialRefs:job.materialRefs??{}},(job.authorizedChunks??this.batches(job.id).flatMap(batch=>batch.chunks)).filter(compatible)),targets=this.workMembers(job,batch,batch.chunks);
      const same=(member:MemoryWorkMember,allowed:MemoryWorkMember)=>member.key===allowed.key&&member.id===allowed.id&&member.offset===allowed.offset&&member.length===allowed.length&&member.fingerprint===allowed.fingerprint;
      if(!request.targets.every(member=>targets.some(allowed=>same(member,allowed)))||!request.authorized.every(member=>all.some(allowed=>same(member,allowed))))return false;
      this.materialAdmission([...new Set(request.authorized.map(member=>member.id))],Object.fromEntries(Object.entries(job.materialRefs??{}).filter(([id])=>request.authorized.some(member=>member.id===id))),job.modelProfileId,(job.materialInputs??[]).filter(pin=>pin.evidenceIds.some(id=>request.authorized.some(member=>member.id===id))));
      return request.authorized.every(member=>{const record=this.options.memories.readEvidence([member.id])[0];return Boolean(record&&this.options.memories.isCurrentEvidence(member.id)&&memoryEvidenceFingerprint(record)===member.fingerprint);});
    }catch{return false;}
  }
  cancelFeedbackUnit(groupId:string){
    const root=memoryFeedbackBatchId(groupId),row=this.store.db.prepare('SELECT job_id FROM memory_batches WHERE id=?').get(root);if(!row)return;
    const pending=[root],seen=new Set<string>();while(pending.length){const id=pending.pop()!;if(seen.has(id))continue;seen.add(id);const batch=this.batch(id);if(batch.supersededBy?.length){pending.push(...batch.supersededBy);continue;}if(batch.status==='completed'||batch.status==='invalidated')continue;
      this.engine.cancel(id);this.store.db.prepare("UPDATE execution_steps SET state='blocked',error='memory_context_required',fence=NULL WHERE id=? AND state!='succeeded'").run(id);this.engine.project(id);
      const current=this.batch(id);if(current.coverage){current.coverage=current.coverage.map(member=>({...member,state:'needs_context',reason:'memory_branch_cancelled'}));this.saveBatch(current);}
    }this.refreshJob(String(row.job_id));this.wake();
  }
  private applyFeedback(job:MemoryJob,batch:StoredBatch,plan:MemoryFeedbackPlan,targetChunks:Chunk[],coverage:MemoryWorkCoverage){
    if(batch.supersededBy?.length)return;
    const request=this.feedbackRequest(job,batch,this.workMembers(job,batch,targetChunks),coverage);
    if(!this.feedbackAllowed(request)||!validMemoryFeedbackPlan(request,plan.groups))throw new ExecutionFailure('blocked','memory_context_required');
    const authorized=job.authorizedChunks??this.batches(job.id).flatMap(batch=>batch.chunks),byKey=new Map(this.workMembers(job,{...batch,materialRefs:job.materialRefs??{}},authorized).map((member,index)=>[member.key,authorized[index]])),targets=new Map(this.workMembers(job,batch,targetChunks).map((member,index)=>[member.key,targetChunks[index]]));
    let index=Number(this.store.db.prepare('SELECT coalesce(max(idx),-1)+1 n FROM memory_batches WHERE job_id=?').get(job.id)!.n);
    const children=plan.groups.map(group=>{
      const chunks=group.memberKeys.map(key=>targets.get(key)!),contextChunks=group.contextKeys.map(key=>byKey.get(key)!),ids=new Set([...chunks,...contextChunks].map(chunk=>chunk.id)),id=memoryFeedbackBatchId(group.id);
      const child:StoredBatch={id,index:index++,status:'pending',attempts:0,memoryIds:[],chunks,contextChunks,contextRanges:contextChunks.map(({id,offset,length})=>({id,offset,length})),evidenceRanges:chunks.map(({id,offset,length})=>({id,offset,length})),strategy:batch.strategy,materialInputs:(job.materialInputs??[]).filter(pin=>pin.evidenceIds.some(id=>ids.has(id))),materialRefs:Object.fromEntries(Object.entries(job.materialRefs??{}).filter(([id])=>ids.has(id))),artifactRefs:batch.artifactRefs,skillVersion:batch.skillVersion,replanRound:request.round,workerGoal:group.goal,workerInstruction:group.instruction,splitDepth:batch.splitDepth};
      child.coverage=this.workMembers(job,child,chunks);return child;
    });
    for(const child of children)this.insertBatch(job.id,child);
    batch.supersededBy=children.map(child=>child.id);batch.feedbackWorkId=plan.workId;this.saveBatch(batch);this.drafts.clear(batch.id);
    for(const child of children)this.engine.enqueue('memory:'+job.id,'memory.batch',{jobId:job.id,batchId:child.id,evidenceIds:[...new Set([...child.chunks,...(child.contextChunks??[])].map(chunk=>chunk.id))]},{id:child.id});
    this.feedbackApplied?.(plan,job.id);
  }
  private subdivide(job:MemoryJob,batch:StoredBatch,code:'memory_coverage_incomplete'|'memory_capacity_saturated'){
    if((batch.splitDepth??0)>=4)throw new ExecutionFailure('permanent',code);
    let groups:Chunk[][];
    if(batch.chunks.length>1){const middle=Math.ceil(batch.chunks.length/2);groups=[batch.chunks.slice(0,middle),batch.chunks.slice(middle)];}
    else {const chunk=batch.chunks[0];if(code==='memory_coverage_incomplete'||!chunk||chunk.length<512)throw new ExecutionFailure('permanent',code);
      const text=this.options.memories.readEvidence([chunk.id])[0]?.ocrText??'';let middle=chunk.offset+Math.floor(chunk.length/2);if(/[\uD800-\uDBFF]/.test(text[middle-1])&&/[\uDC00-\uDFFF]/.test(text[middle]))middle--;
      groups=[[{...chunk,length:middle-chunk.offset,key:sha256(JSON.stringify([chunk.key,chunk.offset,middle-chunk.offset]))}],[{...chunk,offset:middle,length:chunk.offset+chunk.length-middle,key:sha256(JSON.stringify([chunk.key,middle,chunk.offset+chunk.length-middle]))}]];
    }
    let index=Number(this.store.db.prepare('SELECT coalesce(max(idx),-1)+1 n FROM memory_batches WHERE job_id=?').get(job.id)!.n);
    const history=[...(batch.splitHistory??[]),{at:new Date().toISOString(),errorCode:code,attempts:batch.attempts,evidenceRanges:structuredClone(batch.evidenceRanges)}];
    const children=groups.map(chunks=>{const child:StoredBatch={...this.sliceBatchScope(job,batch,chunks),strategy:batch.strategy,replanRound:batch.replanRound,workerGoal:batch.workerGoal,workerInstruction:batch.workerInstruction,contextChunks:batch.contextChunks,contextRanges:batch.contextRanges,id:randomUUID(),index:index++,status:'pending',chunks,evidenceRanges:chunks.map(({id,offset,length})=>({id,offset,length})),attempts:0,memoryIds:[],artifactRefs:batch.artifactRefs,skillVersion:batch.skillVersion,splitDepth:(batch.splitDepth??0)+1,splitHistory:history};child.coverage=this.workMembers(job,child,chunks);return child;});
    for(const child of children)this.insertBatch(job.id,child);
    batch.supersededBy=children.map(child=>child.id);batch.coverage=this.workMembers(job,batch,batch.chunks).map(member=>({...member,state:'needs_context',reason:code}));this.saveBatch(batch);this.drafts.clear(batch.id);
    for(const planId of batch.planIds??[]){const plan=this.inputPlans.get(planId);if(plan?.batchIds){plan.batchIds=[...plan.batchIds.filter(id=>id!==batch.id),...children.filter(child=>child.planIds?.includes(planId)).map(child=>child.id)];this.inputPlans.put(plan);}}
    for(const child of children)this.engine.enqueue('memory:'+job.id,'memory.batch',{jobId:job.id,batchId:child.id,evidenceIds:[...new Set([...child.chunks,...(child.contextChunks??[])].map(chunk=>chunk.id))]},{id:child.id});
  }
  private admitBatch(job:MemoryJob,batch:StoredBatch){
    for(const id of batch.planIds??[]){const plan=this.inputPlans.get(id);if(!plan||!this.options.materialSourceCurrent?.(plan.sourcePin,plan.materialId))throw new StoreError('Memory original selection changed',409);}
    const scope=this.batchScope(job,batch);this.materialAdmission([...new Set([...batch.chunks,...(batch.contextChunks??[])].map(c=>c.id))],scope.materialRefs,job.modelProfileId,scope.materialInputs);
  }
  private evaluatePlan(plan:ManualMemoryInputPlanRequest,job:Pick<MemoryJob,'modelProfileId'>):{state:'ready';scope:ReadyInputScope;pin:MaterialInputPin}|{state:'waiting'|'blocked'|'stale';code:string}{
    if(!this.options.materialSourceCurrent?.(plan.sourcePin,plan.materialId))return {state:'stale',code:'evidence_changed'};
    try{this.strategies.resolvePinned(plan.strategy);}catch{return {state:'blocked',code:'memory_strategy_unavailable'};}
    if(!this.options.materialPlanAllowed?.(plan.materialId,job.modelProfileId))return {state:'blocked',code:'memory_authorization_revoked'};
    const selection=this.options.materialInput?.(plan.materialId,plan.required);
    if(!selection)return {state:'blocked',code:'memory_input_unavailable'};
    if(!selection.ready){const deps=selection.dependencies??[];return deps.some(d=>d.state==='failed')?{state:'blocked',code:'memory_input_failed'}:deps.some(d=>d.state==='unavailable')?{state:'blocked',code:'memory_input_unavailable'}:{state:'waiting',code:'memory_input_pending'};}
    if(plan.evidenceAllowList&&selection.evidenceIds.some(id=>!plan.evidenceAllowList!.includes(id)))return {state:'blocked',code:'memory_input_outside_selection'};
    const pin:MaterialInputPin={materialId:selection.materialId,required:selection.required,fingerprint:selection.fingerprint,evidenceIds:selection.evidenceIds};
    try{const refs=this.materialAdmission(pin.evidenceIds,undefined,job.modelProfileId,[pin]);return {state:'ready',pin,scope:{strategy:plan.strategy,ids:pin.evidenceIds,inputs:[pin],refs}};}catch{return {state:'blocked',code:'memory_authorization_revoked'};}
  }
  private createManual(input:Parameters<MemoryPipeline['create']>[0]):MemoryJobDetail {
    if(input.automaticGrant||input.automaticGrants||input.workPackage||input.artifactRefs||input.evidenceRanges)throw new StoreError('Manual input plans cannot change another processing grant',409);
    if(!this.options.review)throw new StoreError('Memory recipes require the host review executor',409);
    const now=new Date().toISOString(),job:MemoryJob={activationRequired:false,inputPlanVersion:1,inputPlans:{total:0,waiting:0,blocked:0,stale:0,completed:0},recipeProgress:[],memoryCount:0,materialInputs:[],materialRefs:{},id:randomUUID(),modelProfileId:input.modelProfileId,modelOverride:input.modelOverride,contextTime:input.contextTime??now,recipes:input.recipes,batchCharacters:input.batchCharacters??this.batchBudget(),language:requestLocale.getStore()??'zh-CN',timeZone:input.timeZone,status:'queued',createdAt:now,updatedAt:now,evidenceIds:[],skillVersion:this.options.skillVersion??MEMORY_SKILL_VERSION,totalBatches:0,completedBatches:0,failedBatches:0,skippedChunks:0,memoryIds:[]};
    if(this.options.configuration)job.configuration=structuredClone(this.options.configuration(job.modelProfileId,job.modelOverride));
    const plans=input.manualPlans!.map(request=>({...request,id:randomUUID(),jobId:job.id} as ManualMemoryInputPlan)),seen=new Set<string>();
    for(const plan of plans){const key=JSON.stringify([plan.materialId,plan.strategy.recipe]);if(seen.has(key))throw new StoreError('Duplicate Memory input plan');seen.add(key);this.strategies.resolvePinned(plan.strategy);if(plan.strategy.requires&&JSON.stringify(plan.required)!==JSON.stringify(plan.strategy.requires))throw new StoreError('Memory plan requirements differ from its recipe',409);}
    const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
    try{
      const states=plans.map(plan=>this.evaluatePlan(plan,job)),ready=states.flatMap((state,index)=>state.state==='ready'?[{...state.scope,planIds:[plans[index].id]}]:[]);
      const raw=[...new Set(input.evidenceIds)].filter(id=>!this.currentMaterialRef(id));
      for(const recipe of input.recipes??[]){const selected=this.strategies.resolve(recipe);if(raw.length&&!selected.binding.requires){const refs=this.materialAdmission(raw,undefined,job.modelProfileId);ready.push({strategy:selected.binding,ids:raw,inputs:[],refs,planIds:[]});}}
      const grouped=new Map<string,ReadyInputScope[]>();for(const scope of ready){const key=JSON.stringify(scope.strategy),items=grouped.get(key)??[];items.push(scope);grouped.set(key,items);}
      const made=this.makeBatches(job,[...grouped.values()].flat()),batches=made.batches;job.skippedChunks=made.skippedChunks;job.evidenceIds=[...new Set(ready.flatMap(plan=>plan.ids))];job.totalBatches=batches.length;
      this.store.reserveMetadata(Buffer.byteLength(JSON.stringify(job)));db.prepare('INSERT INTO memory_jobs VALUES(?,?,?)').run(job.id,now,JSON.stringify(job));
      for(const batch of batches)this.insertBatch(job.id,batch);
      for(const [index,plan] of plans.entries()){
        const state=states[index];if(state.state==='ready'){plan.resolvedInput=state.pin;plan.batchIds=batches.filter(batch=>batch.planIds?.includes(plan.id)).map(batch=>batch.id);}this.inputPlans.put(plan);
        this.engine.enqueue('memory:'+job.id,'memory.input',{jobId:job.id,planId:plan.id},{id:plan.id,initial:{state:state.state==='ready'?'succeeded':state.state==='waiting'?'waiting':state.state==='stale'?'stale':'blocked',attempts:0,availableAt:0,...(state.state==='ready'?{}:{error:state.code})}});
      }
      this.prepare(job.id);this.refreshJob(job.id);if(own)db.exec('COMMIT');
    }catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}
    return this.get(job.id);
  }
  private bindInput(step:ExecutionStep){
    const plan=this.inputPlans.get(String(step.input.planId));if(!plan||plan.batchIds!==undefined)return;
    const job=this.storedJob(plan.jobId);if(['paused','pausing','cancelled'].includes(job.status))throw new ExecutionFailure('blocked',job.status);
    const state=this.evaluatePlan(plan,job);if(state.state!=='ready')throw new ExecutionFailure(state.state==='stale'?'stale':state.state==='waiting'?'waiting':'blocked',state.code,30000);
    const nextIndex=Number(this.store.db.prepare('SELECT coalesce(max(idx),-1)+1 n FROM memory_batches WHERE job_id=?').get(job.id)!.n),made=this.makeBatches(job,[{...state.scope,planIds:[plan.id]}],undefined,nextIndex);
    const evidenceIds=[...new Set([...job.evidenceIds,...state.pin.evidenceIds])],previousChunks=Number(this.store.db.prepare("SELECT coalesce(sum(json_array_length(json,'$.chunks')),0) n FROM memory_batches WHERE job_id=?").get(job.id)!.n);
    if(evidenceIds.length>20000||previousChunks+made.batches.reduce((n,b)=>n+b.chunks.length,0)>10000||nextIndex+made.batches.length>10000)throw new StoreError('Memory job exceeds 10000 batches',413);
    for(const batch of made.batches)this.insertBatch(job.id,batch);
    plan.resolvedInput=state.pin;plan.batchIds=made.batches.map(batch=>batch.id);this.inputPlans.put(plan);
    const priorBytes=Buffer.byteLength(JSON.stringify(job));job.evidenceIds=evidenceIds;job.skippedChunks+=made.skippedChunks;job.status='queued';this.store.reserveMetadata(Math.max(0,Buffer.byteLength(JSON.stringify(job))-priorBytes));this.saveJob(job);this.prepare(job.id);
  }
  private planView(jobId:string){
    const empty=():MemoryPlanSummary=>({total:0,waiting:0,blocked:0,stale:0,completed:0}),inputPlans=empty(),recipes=new Map<string,MemoryRecipeProgress>(),batchById=new Map(this.batches(jobId).map(batch=>[batch.id,batch]));
    for(const plan of this.inputPlans.list(jobId)){
      const recipe={id:plan.strategy.recipe.id,version:plan.strategy.recipe.version},key=JSON.stringify(recipe),view=recipes.get(key)??{recipe,inputs:empty(),completedBatches:0,failedBatches:0,reasons:[]};recipes.set(key,view);
      const step=this.engine.get(plan.id),batches=(plan.batchIds??[]).flatMap(id=>batchById.get(id)?[batchById.get(id)!]:[]);
      const state=step?.state==='stale'||batches.some(b=>b.status==='invalidated')?'stale':step&&['blocked','failed','cancelled'].includes(step.state)||batches.some(b=>b.status==='failed')?'blocked':plan.batchIds!==undefined&&batches.every(b=>b.status==='completed')?'completed':'waiting';
      for(const counts of [inputPlans,view.inputs]){counts.total++;counts[state]++;}
      const code=step?.error??batches.find(b=>b.errorCode)?.errorCode;if(code&&view.reasons.length<8&&!view.reasons.some(reason=>reason.code===code&&reason.materialRef===plan.selectedRef))view.reasons.push({code,required:plan.required,materialRef:plan.selectedRef});
    }
    for(const view of recipes.values())for(const batch of batchById.values())if(batch.strategy?.recipe.id===view.recipe.id&&batch.strategy.recipe.version===view.recipe.version){if(batch.status==='completed')view.completedBatches++;if(['failed','invalidated'].includes(batch.status))view.failedBatches++;}
    return {inputPlans,recipeProgress:[...recipes.values()]};
  }
  /** Metadata-only recovery. Future-date waits are left to their bounded delay. */
  async tickInputs(){if(this.closed)return;
    for(const row of this.store.db.prepare("SELECT e.id,e.input FROM execution_steps e WHERE e.kind='memory.input' AND e.state IN ('waiting','blocked')").all()){
      const plan=this.inputPlans.get(String(row.id)),jobId=String((JSON.parse(String(row.input)) as {jobId:string}).jobId),job=this.storedJob(jobId);
      if(['paused','pausing','cancelled'].includes(job.status))continue;
      if(!plan||!this.options.materialSourceCurrent?.(plan.sourcePin,plan.materialId)){this.store.db.prepare("UPDATE execution_steps SET state='stale',fence=NULL,error='evidence_changed',updated_at=? WHERE id=? AND state IN ('waiting','blocked')").run(Date.now(),row.id);this.engine.project(String(row.id));}
    }
    await this.engine.tick();this.settle();
  }
  /** A source/processing event may wake original plans, never rescan a range. */
  wakeInputs(materialIds?:readonly string[]){
    const filter=materialIds?new Set(materialIds):undefined;
    for(const row of this.store.db.prepare("SELECT p.id,p.material_id FROM memory_input_plans p JOIN memory_jobs j ON j.id=p.job_id JOIN execution_steps e ON e.id=p.id WHERE e.state='waiting' AND json_extract(j.json,'$.status') NOT IN ('paused','pausing','cancelled','completed')").all())if(!filter||filter.has(String(row.material_id)))this.store.db.prepare("UPDATE execution_steps SET available_at=0 WHERE id=? AND state='waiting'").run(row.id);
    this.wake();
  }
  recover():void {
    if(this.active.size)return;
    this.store.db.exec("UPDATE memory_jobs SET json=json_set(json,'$.status','paused') WHERE json_extract(json,'$.status')='pausing'");
  }
  private prepare(id:string){
    const job=this.storedJob(id);if(['paused','pausing','cancelled','completed'].includes(job.status))return;
    for(const plan of this.inputPlans.list(id))if(!this.engine.get(plan.id))this.engine.enqueue('memory:'+id,'memory.input',{jobId:id,planId:plan.id},{id:plan.id,initial:{state:plan.batchIds===undefined?'waiting':'succeeded',attempts:0,availableAt:0}});
    for(const batch of this.batches(id)){
      if(!['pending','running'].includes(batch.status))continue;
      const stepId=this.engine.enqueue('memory:'+id,'memory.batch',{jobId:id,batchId:batch.id,evidenceIds:batch.resourceEvidenceIds??[...new Set([...batch.chunks,...(batch.contextChunks??[])].map(c=>c.id))]},{id:batch.id,initial:{state:batch.status==='running'?'running':'waiting',attempts:0,availableAt:0}});
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
  private assertRetryWindow(job:MemoryJob){
    // Input readiness checks have their own timer. Only a batch's provider
    // cooldown may delay an explicit recheck of another failed input plan.
    const delayed=this.store.db.prepare("SELECT json_extract(json,'$.availableAt') at,json_extract(json,'$.errorCode') code FROM memory_batches WHERE job_id=? AND json_extract(json,'$.status') IN ('failed','pending') ORDER BY json_extract(json,'$.availableAt') DESC LIMIT 1").get(job.id);
    const availableAt=Number(delayed?.at)||0;
    if(availableAt>Date.now())throw new ProviderFailure({category:'transient',code:typeof delayed?.code==='string'?delayed.code:'provider_unavailable',retryAfterMs:availableAt-Date.now()});
  }
  async retry(id:string):Promise<MemoryJobDetail> {
    if(this.active.has(id))return this.active.get(id)!;
    let job=this.storedJob(id);
    this.assertRetryWindow(job);
    if(job.status==='cancelled')throw new StoreError('Cancelled memory job cannot be retried',409);
    const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
      try{
      job=this.storedJob(id);
        if(job.status==='cancelled')throw new StoreError('Cancelled memory job cannot be retried',409);
      this.assertRetryWindow(job);
      const batches=this.batches(id);
      if(batches.some(batch=>{const fence=db.prepare("SELECT fence FROM execution_steps WHERE id=? AND state='running'").get(batch.id)?.fence;return typeof fence==='string'&&this.engine.isCurrentGrant(batch.id,fence);}))throw new StoreError('Memory job is already running',409);
      const previousConfiguration=job.configuration;
      if(this.options.configuration&&this.options.configured(job.modelProfileId)){job.configuration=structuredClone(this.options.configuration(job.modelProfileId,job.modelOverride));this.store.reserveMetadata(Buffer.byteLength(JSON.stringify(job.configuration)));}
      let nextIndex=Math.max(-1,...batches.map(batch=>batch.index))+1;
      for(const batch of batches)if(batch.status==='failed'&&batch.errorCode!=='memory_context_required'){
        try{this.admitBatch(job,batch);}catch{batch.status='invalidated';batch.errorCode='evidence_changed';this.saveBatch(batch);continue;}
        // Retry a measured deadline with less evidence, never by interpreting
        // its content. Keep original ranges/keys and cap subdivision at 2 levels.
        if(batch.errorCode==='provider_timeout'&&batch.phase!=='review'&&batch.chunks.length>1&&(batch.splitDepth??0)<2){
          const history=[...(batch.splitHistory??[]),{at:new Date().toISOString(),errorCode:'provider_timeout' as const,attempts:batch.attempts,evidenceRanges:structuredClone(batch.evidenceRanges)}];
          batch.resourceEvidenceIds??=[...new Set(batch.chunks.map(chunk=>chunk.id))];
          const remaining=batch.chunks.splice(Math.ceil(batch.chunks.length/2));
          batch.splitDepth=(batch.splitDepth??0)+1;batch.splitHistory=history;
          batch.evidenceRanges=batch.chunks.map(({id,offset,length})=>({id,offset,length}));
          const child:StoredBatch={...this.sliceBatchScope(job,batch,remaining),strategy:batch.strategy,replanRound:batch.replanRound,workerGoal:batch.workerGoal,workerInstruction:batch.workerInstruction,contextChunks:batch.contextChunks,contextRanges:batch.contextRanges,id:randomUUID(),index:nextIndex++,status:'pending',chunks:remaining,evidenceRanges:remaining.map(({id,offset,length})=>({id,offset,length})),attempts:0,memoryIds:[],artifactRefs:batch.artifactRefs,skillVersion:batch.skillVersion,splitDepth:batch.splitDepth,splitHistory:history};
          Object.assign(batch,this.sliceBatchScope(job,batch,batch.chunks));
          for(const planId of new Set([...(batch.planIds??[]),...(child.planIds??[])])){const plan=this.inputPlans.get(planId);if(plan?.batchIds){plan.batchIds=[...plan.batchIds.filter(id=>id!==batch.id),...(batch.planIds?.includes(planId)?[batch.id]:[]),...(child.planIds?.includes(planId)?[child.id]:[])];this.inputPlans.put(plan);}}
          this.store.reserveMetadata(Buffer.byteLength(JSON.stringify(child))+Buffer.byteLength(JSON.stringify(batch)));
          db.prepare('INSERT INTO memory_batches(id,job_id,idx,json) VALUES(?,?,?,?)').run(child.id,id,child.index,encodeMemoryBatch(this.store,child));
          db.prepare('DELETE FROM memory_batch_dependencies WHERE batch_id=?').run(batch.id);
          for(const part of [batch,child])for(const evidenceId of new Set([...part.chunks,...(part.contextChunks??[])].flatMap(chunk=>this.options.memories.dependencyIds(chunk.id))))db.prepare('INSERT INTO memory_batch_dependencies(batch_id,evidence_id) VALUES(?,?)').run(part.id,evidenceId);
        }
        batch.status='pending';delete batch.errorCode;this.saveBatch(batch);
      }
      job.status='queued';delete job.errorCode;this.saveJob(job);
      for(const plan of this.inputPlans.list(id)){
        const step=this.engine.get(plan.id);
        if(!step||!['waiting','blocked','failed'].includes(step.state)||plan.batchIds!==undefined)continue;
        this.engine.retry(plan.id);
      }
      if(own)db.exec('COMMIT');
    }catch(error){if(own)db.exec('ROLLBACK');throw error;}
    return this.run(id);
  }
  private validateStep(step:ExecutionStep){
    const row=this.store.db.prepare('SELECT json FROM memory_batches WHERE id=?').get(String(step.input.batchId));if(!row)return false;
    const batch=JSON.parse(String(row.json)) as StoredBatch;
    try{const job=this.storedJob(String(step.input.jobId));this.admitBatch(job,batch);}
    catch{return false;}
    return batch.status!=='invalidated'&&[...batch.chunks,...(batch.contextChunks??[])].every(chunk=>this.valid(chunk))&&(batch.artifactRefs??[]).every(ref=>this.store.archive.revision(ref.id)===ref.revision);
  }
  private projectStep(step:ExecutionStep){
    const id=String(step.input.jobId),batchId=String(step.input.batchId);
    if(!this.store.db.prepare('SELECT 1 FROM memory_batches WHERE id=?').get(batchId))return;
    const batch=this.batch(batchId),job=this.storedJob(id);
    if(batch.status==='invalidated'&&batch.coverage){batch.coverage=batch.coverage.map(member=>({...member,state:'stale',reason:batch.errorCode??'evidence_changed'}));this.saveBatch(batch);}
    if(batch.status!=='invalidated'){
      batch.status=step.state==='blocked'&&step.error==='memory_context_required'?'failed':step.state==='succeeded'?'completed':step.state==='running'?'running':step.state==='failed'?'failed':step.state==='stale'?'invalidated':'pending';
      if(batch.coverage&&!batch.supersededBy&&['failed','stale','cancelled'].includes(step.state))batch.coverage=batch.coverage.map(member=>({...member,state:step.state==='stale'?'stale':step.error==='memory_coverage_incomplete'?'needs_context':'failed',reason:step.error}));
      batch.errorCode=step.error==='input_changed'?'evidence_changed':step.error;
      batch.availableAt=['rate_limited','provider_unavailable','provider_timeout','provider_network'].includes(step.error??'')?step.availableAt:undefined;
      if(step.state==='running'){batch.phase='extract';batch.stage='starting';batch.startedAt=new Date().toISOString();batch.lastActivityAt=batch.startedAt;}
      this.saveBatch(batch);
    }
    if(step.state==='blocked'&&step.error==='memory_context_required'&&!['cancelled','paused','pausing'].includes(job.status)){job.status='waiting_for_input';job.errorCode='memory_context_required';this.saveJob(job);}
    if(step.state==='blocked'&&['semantic_processing_blocked','configuration_changed','model_unconfigured','provider_authentication','provider_endpoint','provider_redirect'].includes(step.error??'')&&!['cancelled','paused','pausing'].includes(job.status)){job.status='waiting_for_model';job.errorCode=step.error;this.saveJob(job);}
    else if(['waiting','running'].includes(step.state)&&job.status==='waiting_for_model'&&this.active.has(id)){job.status='queued';delete job.errorCode;this.saveJob(job);}
    this.refreshJob(id);this.wake();
  }
  private refreshJob(id:string){
    const job=this.storedJob(id),counts=this.counts(id);
    if(job.status==='pausing'&&Number(counts.running)===0)job.status='paused';
    {
      const steps=this.store.db.prepare("SELECT state,error,available_at FROM execution_steps WHERE operation_id=? AND kind='memory.input'").all('memory:'+id),inputWaiting=steps.some(step=>['waiting','running'].includes(String(step.state))),inputFailure=steps.some(step=>['blocked','failed','stale','cancelled'].includes(String(step.state)));
      const contextWaiting=Boolean(this.store.db.prepare("SELECT 1 FROM execution_steps WHERE operation_id=? AND kind='memory.batch' AND state='blocked' AND error='memory_context_required' LIMIT 1").get('memory:'+id));
      const runnable=this.store.db.prepare("SELECT 1 FROM memory_batches b LEFT JOIN execution_steps e ON e.id=b.id WHERE b.job_id=? AND json_extract(b.json,'$.status')='pending' AND (e.id IS NULL OR e.state IN ('waiting','running') OR (e.state='blocked' AND e.error='awaiting_activation')) LIMIT 1").get(id);
      if(!['cancelled','paused','pausing'].includes(job.status))job.status=Number(counts.running)>0?'running':runnable?'queued':inputWaiting||contextWaiting?'waiting_for_input':job.status==='waiting_for_model'&&Number(counts.pending)>0?'waiting_for_model':Number(counts.failed)>0||inputFailure?'failed':'completed';
      if(job.status==='waiting_for_input'){job.errorCode=contextWaiting?'memory_context_required':'memory_input_pending';job.availableAt=contextWaiting?undefined:Math.min(...steps.filter(step=>step.state==='waiting').map(step=>Number(step.available_at)||0));}
      else if(job.status!=='waiting_for_model'){job.errorCode=String(steps.find(step=>['blocked','failed','stale'].includes(String(step.state)))?.error??'')||undefined;delete job.availableAt;}
    }
    if(!['waiting_for_model','waiting_for_input'].includes(job.status))job.errorCode=job.errorCode||String(this.store.db.prepare("SELECT json_extract(json,'$.errorCode') error FROM memory_batches WHERE job_id=? AND json_extract(json,'$.status') IN ('failed','invalidated') LIMIT 1").get(id)?.error??'')||undefined;
    if(job.status!=='waiting_for_input')job.availableAt=Number(this.store.db.prepare("SELECT max(json_extract(json,'$.availableAt')) at FROM memory_batches WHERE job_id=? AND json_extract(json,'$.status') IN ('failed','pending')").get(id)?.at)||undefined;
    job.totalBatches=Number(counts.total);job.completedBatches=Number(counts.completed);job.failedBatches=Number(counts.failed);this.saveJob(job);
  }
  private assertStrategies(batch:StoredBatch){
    for(const chunk of batch.chunks){
      if(chunk.strategy){try{this.strategies.resolvePinned(chunk.strategy);}catch{throw new ExecutionFailure('permanent','memory_strategy_unavailable');}}
      else if(chunk.reviewFingerprint!==undefined&&chunk.reviewFingerprint!==(this.options.review?memoryStrategyPin(defaultMemoryReviewStrategy).fingerprint:undefined))throw new ExecutionFailure('stale','memory_strategy_changed');
    }
  }
  private assertConfiguration(job:MemoryJob){
    if(job.configuration&&this.options.configuration){let current:ModelConfiguration;try{current=this.options.configuration(job.modelProfileId,job.modelOverride);}catch{throw new ExecutionFailure('blocked','model_unconfigured');}if(current.fingerprint!==job.configuration.fingerprint)throw new ExecutionFailure('blocked','configuration_changed');}
  }
  private commitBatch(step:ExecutionStep,output:BatchOutput|undefined){
    if(!output)return;
    const job=this.storedJob(String(step.input.jobId));
    this.assertAutomatic(job);this.assertConfiguration(job);
    const batch=this.batch(String(step.input.batchId)),{result,model,profile,skillVersion,ranges,chunks}=output,processingChunks=[...chunks,...(batch.contextChunks??[])];
    if(output.feedbackPlan){this.applyFeedback(job,batch,output.feedbackPlan,chunks,output.coverage??[]);return;}
    if(output.subdivide){
      if(output.coverage)batch.coverage=this.workMembers(job,batch,chunks).map(member=>{const row=output.coverage!.find(row=>row.key===member.key);return {...member,state:row?.state??'needs_context',reason:row?.reason??output.subdivide,contextRefs:row?.contextRefs};});this.saveBatch(batch);
      this.subdivide(job,batch,output.subdivide);return;}
    const maxCandidates=job.workPackage?memoryWorkCandidateLimit(chunks.length):undefined;
    this.assertStrategies(batch);this.admitBatch(job,batch);
    this.options.memories.extract(result,model,{maxCandidates,strategy:output.strategy,profile,requireAdmission:this.options.requireAdmission,reviewReceipt:output.reviewReceipt,reviewRunId:output.reviewReceipt?output.reviewReceipt.reviewRunId:this.options.review?result.runId:undefined,skillVersion,evidenceRanges:ranges,expectedFingerprints:Object.fromEntries(processingChunks.map(c=>[c.id,c.fingerprint])),onSaved:items=>{
      for(const item of items)for(const ref of batch.artifactRefs??[])this.store.db.prepare('INSERT INTO memory_artifact_dependencies VALUES(?,?)').run(item.id,ref.id);
      batch.reviewReceipt=output.reviewReceipt;batch.memoryIds=items.map(m=>m.id);
      if(output.coverage)batch.coverage=this.workMembers(job,batch,chunks).map(member=>{const row=output.coverage!.find(row=>row.key===member.key)!;return {...member,state:row.state,memoryIds:row.candidateIndexes.map(index=>items[index]?.id).filter((id):id is string=>Boolean(id)),reason:row.reason,contextRefs:row.contextRefs};});
      this.saveBatch(batch);
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
  private assertAutomatic(job:MemoryJob){if((job.automaticGrant||job.automaticGrants?.length)&&!this.options.automaticAllowed?.(job))throw new ExecutionFailure('permanent','memory_authorization_revoked');}
  private async execute(id:string,batchId:string,signal:AbortSignal,currentGrant:()=>boolean):Promise<BatchOutput|undefined> {
    const assertGrant=()=>{signal.throwIfAborted();if(!currentGrant())throw new ExecutionFailure('waiting','interrupted');this.assertAutomatic(this.storedJob(id));};assertGrant();
    const observeCurrent=(update:()=>void):boolean=>{
      const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
      try{if(!currentGrant()||this.batch(batchId).status!=='running'){if(own)db.exec('COMMIT');return false;}update();if(own)db.exec('COMMIT');return true;}
      catch(error){if(own)db.exec('ROLLBACK');throw error;}
    };
    const job=this.storedJob(id),batch=this.batch(batchId),currentSkill=this.options.skillVersion??MEMORY_SKILL_VERSION;
    let chunks:Chunk[]=[];
    if(!observeCurrent(()=>{
      if(batch.chunks.every(c=>!c.strategy&&c.profile!=='coding')&&job.skillVersion!==currentSkill){batch.skillVersion=currentSkill;batch.chunks=batch.chunks.map(c=>({...c,key:sha256(JSON.stringify([c.id,c.fingerprint,c.offset,c.length,currentSkill,c.reviewFingerprint]))}));this.saveBatch(batch);}
      chunks=batch.chunks.filter(chunk=>!this.checkpoint(chunk));const currentJob=this.storedJob(id);currentJob.skippedChunks+=batch.chunks.length-chunks.length;this.saveJob(currentJob);
    }))throw new ExecutionFailure('waiting','interrupted');
    if(batch.chunks.some(chunk=>{const record=this.options.memories.readEvidence([chunk.id])[0];return !chunk.strategy&&record&&chunk.profile==='coding'&&chunk.profileVersion&&chunk.profileVersion!==memoryProfile(record).version;}))throw new ExecutionFailure('stale','skill_changed');
    if(!chunks.length)return;
    const processingChunks=[...chunks,...(batch.contextChunks??[])],ranges=processingChunks.map(({id,offset,length})=>({id,offset,length}));
    try{
        this.assertConfiguration(job);
        this.admitBatch(job,batch);
        this.assertStrategies(batch);
        if(job.configuration&&!observeCurrent(()=>{batch.configuration=structuredClone(job.configuration);this.store.reserveMetadata(Buffer.byteLength(JSON.stringify(batch.configuration)));this.saveBatch(batch);} ))throw new ExecutionFailure('waiting','interrupted');
        if(this.options.understand&&!batch.artifactRefs?.length){
          const fence=this.store.db.prepare('SELECT fence FROM execution_steps WHERE id=?').get(batch.id)?.fence;
          if(typeof fence!=='string')throw new ExecutionFailure('waiting','interrupted');
          const policy=chunks[0].strategy?this.strategies.resolvePinned(chunks[0].strategy):undefined;
          const candidatePolicy=policy?{prompt:policy.extract.prompt+'\n'+MEMORY_CANDIDATE_OUTPUT_CONTRACT,profile:'personal' as const,fingerprint:policy.binding.extract.fingerprint}:undefined;
          observeCurrent(()=>{batch.stage='understanding';batch.lastActivityAt=new Date().toISOString();this.saveBatch(batch);});
          const refs=await withExecutionCancellation(signal,()=>this.options.understand!({candidatePolicy,job,ranges,materialRefs:this.batchScope(job,batch).materialRefs,materialInputs:this.batchScope(job,batch).materialInputs,signal,parentGrant:{stepId:batch.id,fence}}));
          assertGrant();this.admitBatch(job,batch);
          if(refs?.length&&!observeCurrent(()=>{batch.artifactRefs=refs;this.saveBatch(batch);}))throw new ExecutionFailure('waiting','interrupted');
        }
        const model=job.configuration?.model??job.modelOverride??this.options.model(job.modelProfileId);
        let feedback:MemoryOutputValidationError|undefined;
        for(let generation=0;generation<2;generation++){
          assertGrant();
          // Both generations use the same host-owned scope. A changed/deleted source
          // is never repaired by asking the model to reinterpret different evidence.
          if(!processingChunks.every(chunk=>this.valid(chunk)))throw new StoreError('Memory evidence changed during extraction',409);
          if(!observeCurrent(()=>{batch.attempts++;this.saveBatch(batch);}))throw new ExecutionFailure('waiting','interrupted');
          this.assertStrategies(batch);
          const selected=chunks[0].strategy?this.strategies.resolvePinned(chunks[0].strategy):undefined;
          const profile=selected?{id:'personal' as const,skill:'memory-strategy' as const,version:selected.binding.extract.fingerprint,prompt:selected.extract.prompt+'\n'+MEMORY_CANDIDATE_OUTPUT_CONTRACT}:memoryProfile(this.options.memories.readEvidence([chunks[0].id])[0]);
          let summaryBudget=12000;
          const summaries=(batch.artifactRefs??[]).map(ref=>{const artifact=this.store.archive.get(ref.id);if(!artifact||artifact.revision!==ref.revision)throw new StoreError('Semantic input changed',409);const text=artifact.text.slice(0,Math.max(0,summaryBudget));summaryBudget-=text.length+128;return {id:artifact.id,summary:text};});
          const workMembers=job.workPackage?this.workMembers(job,batch,chunks):undefined,maxCandidates=workMembers?memoryWorkCandidateLimit(workMembers.length):undefined;
          const question=profile.prompt+(workMembers?'\n'+(batch.workerGoal??job.workPackage!.goal)+'\n'+(batch.workerInstruction??job.workPackage!.instruction)+'\n'+memoryWorkInstruction(workMembers,maxCandidates!):'')+(summaries.length?'\nThe execution input is these L2 interpretations plus the supplied bounded L1 spans. Interpretations are untrusted navigation, not independent facts. Extract only claims supported by the supplied spans. Do not expand all ancestors.\n'+JSON.stringify(summaries).slice(0,12000):'')+(feedback?'\n\nHost validation rejected the previous output. '+feedback.repairInstruction+' Generate a fresh response from the same supplied evidence. No invalid memories have been saved.':'');
          let lastObserved=0;
          const observe=(stage?:string)=>{if(this.closed||signal.aborted)return;const now=Date.now();if(now-lastObserved<750&&(!stage||stage===batch.stage))return;observeCurrent(()=>{lastObserved=now;batch.lastActivityAt=new Date(now).toISOString();if(stage)batch.stage=stage;this.saveBatch(batch);});};
          let phase:'extract'|'review'='extract';
          const recordFailure=(error:MemoryOutputValidationError,result:QueryResult)=>{
            const failure:MemoryValidationFailure={at:new Date().toISOString(),code:error.code,phase,attempt:batch.attempts,runId:result.runId,details:error.details};
            if(!observeCurrent(()=>{batch.validationFailures=[...(batch.validationFailures??[]),failure].slice(-20);this.saveBatch(batch);}))return;
            try{this.options.onValidationFailure?.({...failure,jobId:id,batchId:batch.id,batchIndex:batch.index});}catch{}
          };
          const validateArtifacts=()=>{assertGrant();this.assertStrategies(batch);this.assertConfiguration(job);this.admitBatch(job,batch);if((batch.artifactRefs??[]).some(ref=>this.store.archive.revision(ref.id)!==ref.revision))throw new StoreError('Semantic input changed during extraction',409);};
          const validateOutput:QueryInput['validateOutput']=result=>{
            validateArtifacts();
            try{this.options.memories.extract(result,model,{maxCandidates,profile:profile.id,requireAdmission:this.options.review?true:this.options.requireAdmission,evidenceRanges:ranges,expectedFingerprints:Object.fromEntries(processingChunks.map(c=>[c.id,c.fingerprint])),validateOnly:true});}
            catch(error){if(!(error instanceof MemoryOutputValidationError))throw error;recordFailure(error,result);return {code:error.code,feedback:error.repairInstruction};}
          };
          const input:MemoryPipelineQuery={...(workMembers?{taskContext:{turns:[],memoryWork:{package:{goal:batch.workerGoal??job.workPackage!.goal,instruction:batch.workerInstruction??job.workPackage!.instruction},contextMembers:this.workMembers(job,batch,batch.contextChunks??[]).map(({scope:_scope,...member})=>member),members:workMembers.map(({scope:_scope,...member})=>member),maxCandidates,instruction:memoryWorkInstruction(workMembers,maxCandidates!)}}}:{}),processingMaterialInputs:this.batchScope(job,batch).materialInputs,contextTime:job.contextTime,signal,validateOutput,onProgress:event=>observe(event.stage),onTrace:()=>observe(),language:job.language,modelProfileId:job.configuration?.profileId??job.modelProfileId,modelOverride:model,question,skill:profile.skill,responseMode:'memory-extraction',evidenceIds:[...new Set(processingChunks.map(c=>c.id))],evidenceRanges:ranges.map(range=>({...range})),timeZone:job.timeZone,traceContext:{operationId:'memory:'+id,jobId:id,batchId:batch.id,batchIndex:batch.index,attempt:batch.attempts,phase:'extract'}};
          const {processingMaterialInputs:_materialInputs,signal:_signal,validateOutput:_validate,onProgress:_progress,onTrace:_trace,traceContext:_context,...semanticInput}=input;
          const draftKey=sha256(JSON.stringify(['memory-extraction-draft@1',SYSTEM_PROMPT,skillCatalog().find(s=>s.id===profile.skill)?.version,profile.version,batch.skillVersion??job.skillVersion,job.configuration?.fingerprint,semanticInput,chunks.map(({id,offset,length,fingerprint})=>({id,offset,length,fingerprint})),this.options.memories.readEvidence(input.evidenceIds),batch.artifactRefs,Boolean(this.options.requireAdmission)]));
          let cached:QueryResult|undefined;
          if(!observeCurrent(()=>{batch.phase='extract';this.saveBatch(batch);if(this.options.review&&generation===0)cached=this.drafts.get(batch.id,draftKey,Boolean(selected));} ))throw new ExecutionFailure('waiting','interrupted');
          let result=cached??(generation===0&&!job.workPackage?this.reuseCandidates(batch,ranges):undefined)??await withExecutionCancellation(signal,()=>this.options.query(input));
          signal.throwIfAborted();
          try{
            validateArtifacts();
            if(this.options.review){
              if(workMembers)readMemoryWorkCoverage(result,workMembers,maxCandidates!,id=>this.options.memories.readEvidence([id])[0]?.ocrText);
              this.options.memories.extract(result,model,{maxCandidates,profile:profile.id,requireAdmission:true,evidenceRanges:ranges,expectedFingerprints:Object.fromEntries(processingChunks.map(c=>[c.id,c.fingerprint])),validateOnly:true});
              if(!observeCurrent(()=>{validateArtifacts();this.drafts.put(batch.id,draftKey,result,Boolean(selected));} ))throw new ExecutionFailure('waiting','interrupted');
              phase='review';batch.phase='review';observe('model');result=await withExecutionCancellation(signal,()=>this.options.review!(input,result,selected?.review));
              signal.throwIfAborted();
            }
            validateArtifacts();
            this.options.memories.extract(result,model,{maxCandidates,profile:profile.id,requireAdmission:this.options.requireAdmission,evidenceRanges:ranges,expectedFingerprints:Object.fromEntries(processingChunks.map(c=>[c.id,c.fingerprint])),validateOnly:true});
            const accounting=workMembers?readMemoryWorkCoverage(result,workMembers,maxCandidates!,id=>this.options.memories.readEvidence([id])[0]?.ocrText):undefined;
            if(accounting?.incomplete||accounting?.saturated)observeCurrent(()=>{batch.coverage=workMembers!.map(member=>{const row=accounting.coverage.find(row=>row.key===member.key);return {...member,state:row?.state==='needs_context'?'needs_context':'pending',reason:row?.reason,contextRefs:row?.contextRefs};});this.saveBatch(batch);});
            if(accounting?.coverage.some(row=>row.state==='needs_context')){
              if(!this.feedbackPlanner||(batch.replanRound??0)>=2)throw new ExecutionFailure('blocked','memory_context_required');
              const request=this.feedbackRequest(job,batch,workMembers!,accounting.coverage);
              if(!observeCurrent(()=>{batch.feedbackRound=request.round;batch.stage='planning';this.saveBatch(batch);}))throw new ExecutionFailure('waiting','interrupted');
              const feedbackPlan=await withExecutionCancellation(signal,()=>this.feedbackPlanner!(request,signal));validateArtifacts();
              if(!observeCurrent(()=>{batch.feedbackWorkId=feedbackPlan.workId;this.saveBatch(batch);}))throw new ExecutionFailure('waiting','interrupted');
              if(!feedbackPlan.groups.length)throw new ExecutionFailure('blocked','memory_context_required');
              if(!validMemoryFeedbackPlan(request,feedbackPlan.groups))throw new ExecutionFailure('blocked','memory_context_required');
              return {feedbackPlan,coverage:accounting.coverage,result,model,profile:profile.id,skillVersion:batch.skillVersion??job.skillVersion,ranges,chunks};
            }
            return {coverage:accounting?.coverage,subdivide:accounting?.saturated?'memory_capacity_saturated':accounting?.incomplete?'memory_coverage_incomplete':undefined,strategy:selected?.binding,result,reviewReceipt:memoryReviewReceipt(result),model,profile:profile.id,skillVersion:selected?`${selected.extract.id}@${selected.extract.version}`:profile.id==='coding'?profile.version:batch.skillVersion??job.skillVersion,ranges,chunks};
          }catch(error){if(error instanceof MemoryOutputValidationError){
              observeCurrent(()=>this.drafts.clear(batch.id));
              recordFailure(error,result);
            }if(generation===0&&error instanceof MemoryOutputValidationError){feedback=error;continue;}
            if(workMembers&&error instanceof MemoryOutputValidationError&&error.code==='coverage')return {subdivide:'memory_coverage_incomplete',result,model,profile:profile.id,skillVersion:batch.skillVersion??job.skillVersion,ranges,chunks};
            throw error;}
        }
    }catch(error){
      if(error instanceof AgentTimeoutError)throw new ExecutionFailure('transient','provider_timeout');
      throw error instanceof ExecutionFailure||error instanceof ProviderFailure?error:new ExecutionFailure(error instanceof StoreError&&error.statusCode===409?'stale':'permanent',signal.aborted?'cancelled':error instanceof StoreError&&error.statusCode===409?'evidence_changed':error instanceof StoreError&&error.statusCode===507?'storage_full':(error instanceof StoreError&&error.statusCode===502)||error instanceof AgentResponseError?'invalid_model_output':'model_failed');
    }
  }
  async close(){
    this.closed=true;
    if(this.owned)await this.engine.close();else if(!this.engine.closed){for(const id of this.active.keys())for(const step of this.steps(id))this.engine.cancel(step);}
    this.settle();await Promise.allSettled([...this.active.values()]);await Promise.all(this.unregister.splice(0).map(stop=>stop()));
  }
}
