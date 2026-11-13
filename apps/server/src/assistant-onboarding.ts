import {z} from 'zod';
import {queryScopeSchema,type FileCoverage,type QueryScope} from '@mote/shared';
import {AssistantFollowup} from './assistant-followup.js';
import {AssistantUnderstandingReader} from './assistant-understanding.js';
import {BackgroundModelAuthorization,type ModelConnection} from './background-model-authorization.js';
import {EvidenceReader} from './evidence-reader.js';
import {materialSourcePin,type MaterialSourcePin} from './material-source-pin.js';
import type {MaterialStore} from './materials.js';
import type {MemoryPipeline,MemoryJobDetail} from './memory-pipeline.js';
import type {SourceArchive} from './source-archive.js';
import {canonicalRecipeJson} from './recipe-contract.js';
import {retireTaskRecordsSql} from './task-evidence.js';
import {TaskRecords,type AssertTaskCurrent} from './task-records.js';
import {sha256,StoreError,type Store} from './store.js';

const startSchema=z.object({requestId:z.string().uuid(),scope:queryScopeSchema,
 materialRefs:z.array(z.string().regex(/^material:mat_[a-f0-9]{64}@[a-f0-9]{64}$/)).min(1).max(100),
}).strict().refine(input=>new Set(input.materialRefs).size===input.materialRefs.length,{message:'Material references must be distinct'});
type Start=z.infer<typeof startSchema>;
type Plan={input:Start;connections:ModelConnection[]};
type Selection={ref:string;pin:MaterialSourcePin;scope:QueryScope};
type Item={onboarding_id:string;position:number;material_id:string;selection_id:string;memory_job_id:string|null;processing_ref:string|null;
 followup_id:string|null;completed_ref:string|null;error_code:string|null};
const deps=(ids:readonly string[])=>({version:1 as const,complete:true as const,ids:[...new Set(ids)].sort()});
const finishedMemory=(job:MemoryJobDetail)=>job.status==='completed'&&job.outcome!=='input_invalidated'&&!job.invalidatedBatches&&!job.failedBatches&&
 !job.inputPlans.waiting&&!job.inputPlans.blocked&&!job.inputPlans.stale;

/** Owner-selected historical intake. Only selection metadata and child IDs live
 * here; original bodies, Memory and suggestions retain their existing owners.
 * The material organizer's poll calls tick; this is not another scheduler. */
export class AssistantOnboarding {
 private readonly tasks:TaskRecords;
 private readonly understanding:AssistantUnderstandingReader;
 private ticking?:Promise<void>;
 private closed=false;
 constructor(private readonly store:Store,private readonly materials:MaterialStore,private readonly reader:EvidenceReader,
  private readonly control:BackgroundModelAuthorization,private readonly memory:MemoryPipeline,private readonly followup:AssistantFollowup,
  private readonly connections:()=>ModelConnection[],private readonly assertCurrent:AssertTaskCurrent,
  private readonly requirements:(ref:string)=>readonly string[]|undefined=()=>undefined,private readonly archive?:SourceArchive){
  this.tasks=new TaskRecords(store);this.understanding=new AssistantUnderstandingReader(store,materials,reader);
  store.db.exec(`CREATE TABLE IF NOT EXISTS assistant_onboarding_items(
   onboarding_id TEXT NOT NULL REFERENCES task_records(id) ON DELETE CASCADE,position INTEGER NOT NULL,
   material_id TEXT NOT NULL REFERENCES material_heads(id) ON DELETE CASCADE,
   selection_id TEXT NOT NULL REFERENCES task_records(id),memory_job_id TEXT,processing_ref TEXT,followup_id TEXT,completed_ref TEXT,error_code TEXT,
   PRIMARY KEY(onboarding_id,position));
   CREATE INDEX IF NOT EXISTS assistant_onboarding_material ON assistant_onboarding_items(material_id);
   CREATE TRIGGER IF NOT EXISTS assistant_onboarding_forget BEFORE DELETE ON material_heads BEGIN
    ${retireTaskRecordsSql('SELECT selection_id FROM assistant_onboarding_items WHERE material_id=old.id')}
   END;`);
  store.registerStorage('assistant-onboarding',{assistant_onboarding_items:'length(CAST(onboarding_id AS BLOB))+length(CAST(material_id AS BLOB))+length(CAST(selection_id AS BLOB))+coalesce(length(CAST(memory_job_id AS BLOB)),0)+coalesce(length(CAST(processing_ref AS BLOB)),0)+coalesce(length(CAST(followup_id AS BLOB)),0)+coalesce(length(CAST(completed_ref AS BLOB)),0)+coalesce(length(CAST(error_code AS BLOB)),0)+128'});
 }
 private transaction<T>(run:()=>T):T{
  this.store.db.exec('SAVEPOINT assistant_onboarding_write');
  try{const result=run();this.store.reserveMetadata(0);this.store.db.exec('RELEASE assistant_onboarding_write');return result;}
  catch(error){this.store.db.exec('ROLLBACK TO assistant_onboarding_write; RELEASE assistant_onboarding_write');throw error;}
 }
 private task(id:string){const task=this.tasks.get(id);if(task.kind!=='assistant.onboarding')throw new StoreError('Onboarding not found',404);return task;}
 private plan(id:string){const task=this.task(id);return this.tasks.input<Plan>(id,task.revision,this.assertCurrent);}
 private items(id:string){return this.store.db.prepare('SELECT * FROM assistant_onboarding_items WHERE onboarding_id=? ORDER BY position').all(id) as Item[];}
 private memoryJob(id:string){
  try{return this.memory.get(id);}catch(error){if(error instanceof StoreError&&(error.statusCode===404||error.statusCode===409))return;throw error;}
 }
 private assertActive(id:string){if(this.closed||!['waiting','running'].includes(this.task(id).state))throw new StoreError('Onboarding is no longer active',409);}
 private view(item:Item,scope:QueryScope){
  const task=this.tasks.get(item.selection_id),selection=this.tasks.input<Selection>(task.id,task.revision,this.assertCurrent);
  const material=this.materials.get(item.material_id);
  if(!material||!this.reader.materialSourceCurrent(selection.pin,material.id))throw new StoreError('Selected original changed',409);
  this.understanding.read({ref:material.ref,scope:selection.scope,limit:1});
  return this.understanding.read({ref:material.ref,scope,limit:1});
 }
 start(raw:unknown){
  if(this.closed)throw new StoreError('Onboarding is unavailable',503);
  const input=startSchema.parse(raw),requestId='assistant-onboarding:'+input.requestId;
  const prior=this.store.db.prepare('SELECT id FROM task_records WHERE request_id=?').get(requestId);
  if(prior){
   // Cancelled selections stay terminal. Replaying their command cannot renew
   // permission; a new explicit start can reuse the Memory checkpoints.
   const task=this.task(String(prior.id));
   if(task.state==='cancelled'||task.state==='stale')throw new StoreError('Onboarding is no longer active; start a new selection',409);
   if(canonicalRecipeJson(this.plan(task.id).input)!==canonicalRecipeJson(input))throw new StoreError('Onboarding request ID was reused with different input',409);
   return this.get(task.id,input.scope);
  }
  this.memory.assertNewManualWork();
  const selections=input.materialRefs.map(ref=>{
   const view=this.understanding.read({ref,scope:input.scope,limit:1}),material=view.material;
   if(view.coverage.extraction.status!=='unsupported'&&!this.reader.materialPlanAllowed(material.id))throw new StoreError('Selected material is not allowed for understanding',409);
   const pin=materialSourcePin(this.store,this.materials,material,this.archive);
   // A source pin is independent of later extraction. For unknown organizers,
   // the existing material-revision pin deliberately refuses changed content.
   const ids=pin.kind==='source-item'?[pin.captureId]:pin.kind==='archive-group'?[]:view.disclosureDependencies.ids;
   return {material,selection:{ref,pin,scope:input.scope} satisfies Selection,ids};
  });
  const id=this.transaction(()=>{
   const task=this.tasks.create({operationId:requestId,requestId,kind:'assistant.onboarding',input:{input,connections:this.connections()} satisfies Plan,
    evidenceDependencies:deps([])},this.assertCurrent);
   // Existing manual historical permission, frozen to this owner's command and
   // model connections. No automatic receipts are created or reclassified.
   this.control.manual('onboarding:'+task.id,'manual',input.materialRefs,this.plan(task.id).connections);
   for(const [position,value] of selections.entries()){
    const selection=this.tasks.create({operationId:requestId,requestId:requestId+':'+position,kind:'assistant.onboarding.selection',input:value.selection,
     evidenceDependencies:deps(value.ids)},this.assertCurrent);
    this.store.db.prepare('INSERT INTO assistant_onboarding_items(onboarding_id,position,material_id,selection_id) VALUES(?,?,?,?)')
     .run(task.id,position,value.material.id,selection.id);
   }
   return this.tasks.setState(task.id,task.revision,'running').id;
  });
  void this.tick().catch(()=>{});return this.get(id,input.scope);
 }
 /** A projection rechecks every title, locator, count and child result under
  * the caller's current scope. A narrow read never exposes a wider run's totals. */
 get(id:string,rawScope:QueryScope){
  const scope=queryScopeSchema.parse(rawScope),task=this.task(id);
  const items=this.items(id).flatMap(item=>{
   let view:ReturnType<AssistantUnderstandingReader['read']>;
   try{view=this.view(item,scope);}catch(error){if(error instanceof StoreError&&(error.statusCode===404||error.statusCode===409))return [];throw error;}
   const job=item.memory_job_id?this.memoryJob(item.memory_job_id):undefined;
   const analysisChanged=item.followup_id&&['stale','cancelled'].includes(this.tasks.get(item.followup_id).state);
   const completed=item.completed_ref===view.material.ref&&!analysisChanged;
   const error=item.error_code??(item.memory_job_id&&!job?'memory_processing_unavailable':analysisChanged?'assistant_analysis_changed':view.coverage.extraction.status==='failed'?'extraction_failed':view.coverage.extraction.status==='unsupported'?'original_body_unavailable':undefined);
   const semantic:FileCoverage={status:error?'failed':completed&&view.coverage.extraction.status==='ready'?'ready':completed?'partial':job?.completedBatches?'partial':'pending',
    reason:error??(completed?'available_material_text_only':'understanding_incomplete')};
   return [{material:{ref:view.material.ref,title:view.material.title,sourceId:view.material.origin.sourceId},
    state:completed&&view.coverage.extraction.status==='ready'?'completed' as const:task.state==='cancelled'?'cancelled' as const:error?'failed' as const:'pending' as const,
    coverage:{sync:{status:'ready' as const,reason:'selected_synced_material_only'},extraction:view.coverage.extraction,semantic},
    ...(error?{reason:error}:{}),...(item.followup_id?{taskId:item.followup_id,...(completed?{result:this.followup.result(item.followup_id,scope)}:{})}:{}),
    ...(job?{memory:{id:job.id,status:job.status,completedBatches:job.completedBatches,totalBatches:job.totalBatches}}:{})}];
  });
  const coverage=(kind:'extraction'|'semantic')=>({total:items.length,completed:items.filter(item=>item.coverage[kind].status==='ready').length,
   partial:items.filter(item=>item.coverage[kind].status==='partial').length,pending:items.filter(item=>item.coverage[kind].status==='pending').length,
   failed:items.filter(item=>['failed','unsupported'].includes(item.coverage[kind].status)).length});
  return {id,revision:task.revision,state:task.state==='cancelled'?'cancelled':!items.length?'empty':items.every(item=>item.state==='completed')?'completed':items.every(item=>item.state!=='pending')?'failed':'pending',
   coverage:{sync:{completed:items.length,total:items.length,reason:'selected_synced_materials_only'},extraction:coverage('extraction'),semantic:coverage('semantic')},
   completed:items.filter(item=>item.state==='completed').length,pending:items.filter(item=>item.state==='pending').length,failed:items.filter(item=>item.state==='failed').length,
   cancelled:items.filter(item=>item.state==='cancelled').length,items};
 }
 private update(item:Item,values:Partial<Pick<Item,'memory_job_id'|'processing_ref'|'followup_id'|'completed_ref'|'error_code'>>){
  const entries=Object.entries(values);this.transaction(()=>this.store.db.prepare(`UPDATE assistant_onboarding_items SET ${entries.map(([key])=>key+'=?').join(',')} WHERE onboarding_id=? AND position=?`)
   .run(...entries.map(([,value])=>value!),item.onboarding_id,item.position));Object.assign(item,values);
 }
 private effectiveScope(id:string,plan:Plan):QueryScope{
  const ids=new Set<string>(),sources=new Set<string>();
  for(const item of this.items(id))try{
   const view=this.view(item,plan.input.scope);for(const evidenceId of view.disclosureDependencies.ids)ids.add(evidenceId);sources.add(view.material.origin.sourceId);
  }catch(error){if(!(error instanceof StoreError&&(error.statusCode===404||error.statusCode===409)))throw error;}
  if(ids.size>20000)throw new StoreError('Onboarding evidence exceeds the bounded selection',413);
  return {...plan.input.scope,kind:'selection',sourceIds:[...sources],evidenceIds:[...ids].sort()};
 }
 private async advance(item:Item,plan:Plan):Promise<boolean>{
  const id=item.onboarding_id,view=this.view(item,plan.input.scope),ref=view.material.ref;
  const current=()=>{this.assertActive(id);if(this.view(item,plan.input.scope).material.ref!==ref)throw new StoreError('Onboarding input changed',409);};
  if(item.processing_ref&&item.processing_ref!==ref){
   if(item.memory_job_id)this.memory.cancel(item.memory_job_id);
   if(item.followup_id)this.followup.cancel(item.followup_id);
   this.update(item,{memory_job_id:null,processing_ref:null,followup_id:null,completed_ref:null,error_code:null});
  }
  if(item.completed_ref===ref||item.error_code)return false;
  if(view.coverage.extraction.status==='failed'||view.coverage.extraction.status==='unsupported'){
   this.update(item,{processing_ref:ref,error_code:view.coverage.extraction.status==='failed'?'extraction_failed':'original_body_unavailable'});return false;
  }
  if(view.coverage.extraction.status==='pending')return false;
  const input=this.materials.input(ref,this.requirements(ref)??['material']);
  if(!input?.ready||!input.evidenceIds.length||!this.reader.materialAllowedForMemory(ref,undefined,input.required))return false;
  if(!item.memory_job_id){
   this.control.manualCommand('onboarding:'+id,plan.input.materialRefs,plan.connections,()=>this.transaction(()=>{
    current();const job=this.memory.create({evidenceIds:input.evidenceIds,contextTime:this.task(id).createdAt,timeZone:plan.input.scope.timeZone,
     originKey:'onboarding:'+sha256(JSON.stringify([item.selection_id,ref]))});
    this.update(item,{memory_job_id:job.id,processing_ref:ref});void this.memory.run(job.id).catch(()=>{});
   }));return true;
  }
  const job=this.memory.get(item.memory_job_id);
  if(!finishedMemory(job)){
   if(['failed','cancelled'].includes(job.status)||job.outcome==='input_invalidated'){
    this.update(item,{error_code:job.outcome==='input_invalidated'?'understanding_input_changed':job.status==='cancelled'?'understanding_cancelled':job.errorCode??'memory_processing_failed'});return false;
   }
   return true;
  }
  if(!item.followup_id){
   await this.followup.start({operationId:'onboarding:'+id,requestId:'onboarding:'+item.selection_id+':'+view.material.revision,
    materialRefs:[ref],scope:this.effectiveScope(id,plan),mode:{kind:'change'}},
    {identities:plan.input.materialRefs,connections:plan.connections},current,task=>this.update(item,{followup_id:task.id}));
   return true;
  }
  const progress=this.followup.progress(item.followup_id);
  const failed=progress.batch?.items.find(step=>['failed','blocked','stale','cancelled'].includes(step.state));
  if(progress.task.state==='stale'||progress.task.state==='cancelled'||failed){
   this.update(item,{error_code:failed?.error??'assistant_analysis_failed'});return false;
  }
  if(progress.batch?.task.state!=='succeeded')return true;
  await this.followup.finish(item.followup_id,current);current();this.update(item,{completed_ref:ref});return false;
 }
 tick():Promise<void>{
  if(this.closed)return Promise.resolve();
  return this.ticking??=(async()=>{
   const rows=this.store.db.prepare("SELECT id FROM task_records WHERE kind='assistant.onboarding' AND state IN ('waiting','running') ORDER BY created_at,id").all();
   for(const row of rows){
    if(this.closed)return;const id=String(row.id),plan=this.plan(id);
    for(const item of this.items(id)){
     try{this.assertActive(id);if(await this.advance(item,plan))break;}
     catch(error){
      if(this.closed||this.task(id).state==='cancelled')break;
      // Persist a bounded product reason, never provider text or source bodies.
      this.update(item,{error_code:error instanceof StoreError&&error.statusCode===413?'understanding_input_limit':'understanding_unavailable'});
     }
    }
    const items=this.items(id);
    if(!this.closed&&this.task(id).state==='running'&&items.length&&items.every(item=>{
     try{const view=this.view(item,plan.input.scope);return item.completed_ref===view.material.ref&&view.coverage.extraction.status==='ready';}catch{return false;}
    })){const task=this.task(id);this.tasks.saveResult(id,task.revision,{completed:items.length},deps([]),this.assertCurrent);}
   }
  })().finally(()=>{this.ticking=undefined;});
 }
 cancel(id:string,expectedRevision:number,scope:QueryScope){
  const task=this.task(id);if(task.revision!==expectedRevision)throw new StoreError('Onboarding changed; reload before cancelling',409);
  if(task.state==='cancelled')return this.get(id,scope);
  this.transaction(()=>{
   this.tasks.setState(id,task.revision,'cancelled');
   // Memory commits and cancellation share the existing executor transaction.
   for(const item of this.items(id))if(item.memory_job_id)this.memory.cancel(item.memory_job_id);
  });
  for(const item of this.items(id))if(item.followup_id)this.followup.cancel(item.followup_id);
  return this.get(id,scope);
 }
 async close(){this.closed=true;await this.ticking;}
}
