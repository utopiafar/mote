import {randomUUID} from 'node:crypto';
import {formatEvidenceRef,onboardingStartInputSchema,queryScopeSchema,type FileCoverage,type OnboardingCounts,type OnboardingStartInput,type OnboardingStartResult,type OnboardingState,type QueryScope} from '@mote/shared';
import type {AssistantFollowup} from './assistant-followup.js';
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
import {sha256,StoreError,type EvidenceStore as Store} from './evidence-store.js';
import type {OwnerQuestionsPort} from './plugins/central-contracts.js';
import {safeError,type ServerDiagnostics} from './diagnostics.js';

const materialLimit=100;
const dayMs=24*60*60*1000;
const sourceUnavailable='onboarding_source_unavailable';
type SourcePin={id:string;version:number|null};
type Plan={input:OnboardingStartInput;scope:QueryScope;sourcePins:SourcePin[];skippedSources:string[];identities:string[];connections:ModelConnection[]};
type Selection={pin:MaterialSourcePin};
type Item={onboarding_id:string;position:number;material_id:string;source_id:string;selection_id:string;memory_job_id:string|null;processing_ref:string|null;
 followup_id:string|null;completed_ref:string|null;error_code:string|null};
const deps=(ids:readonly string[])=>({version:1 as const,complete:true as const,ids:[...new Set(ids)].sort()});
const finishedMemory=(job:MemoryJobDetail)=>job.status==='completed'&&job.outcome!=='input_invalidated'&&!job.invalidatedBatches&&!job.failedBatches&&
 !job.inputPlans.waiting&&!job.inputPlans.blocked&&!job.inputPlans.stale;
const reviewedOwnerWait=(job:MemoryJobDetail)=>job.status==='waiting_for_input'&&job.errorCode==='memory_owner_input_required'&&
 job.totalBatches>0&&job.completedBatches===job.totalBatches&&job.outcome!=='input_invalidated'&&!job.invalidatedBatches&&!job.failedBatches&&
 !job.inputPlans.waiting&&!job.inputPlans.blocked&&!job.inputPlans.stale;

/** Owner-authorized historical intake. Only selection metadata and child IDs live
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
  private readonly requirements:(ref:string)=>readonly string[]|undefined=()=>undefined,private readonly archive?:SourceArchive,
  private readonly questions?:Pick<OwnerQuestionsPort,'page'>,private readonly diagnostics?:Pick<ServerDiagnostics,'record'>){
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
  this.memory.setProposalAuthority(jobId=>this.assertProposalSource(jobId));
  this.followup.setOnboardingAuthority((operationId,sourceIds)=>this.assertFollowupSources(operationId,sourceIds));
 }
 private transaction<T>(run:()=>T):T{
  this.store.db.exec('SAVEPOINT assistant_onboarding_write');
  try{const result=run();this.store.db.exec('RELEASE assistant_onboarding_write');return result;}
  catch(error){if(this.store.db.isTransaction){this.store.db.exec('ROLLBACK TO assistant_onboarding_write; RELEASE assistant_onboarding_write');}throw error;}
 }
 private task(id:string){const task=this.tasks.get(id);if(task.kind!=='assistant.onboarding')throw new StoreError('Onboarding not found',404);return task;}
 private plan(id:string){
  const task=this.task(id);
  const row=this.store.db.prepare("SELECT id FROM task_records WHERE request_id=? AND kind='assistant.onboarding.plan'").get(task.operationId+':plan');
  if(!row)throw new StoreError('Onboarding run is unavailable',409);
  const plan=this.tasks.get(String(row.id));
  return this.tasks.input<Plan>(plan.id,plan.revision,this.assertCurrent);
 }
 private items(id:string){
  return this.store.db.prepare(`SELECT i.*,h.source_id FROM assistant_onboarding_items i
   JOIN material_heads h ON h.id=i.material_id WHERE i.onboarding_id=? ORDER BY i.position`).all(id) as Item[];
 }
 /** Local organizers can have Material source IDs without a connector row. */
 private sourceVersion(id:string):number|null|undefined{
  try{
   const source=this.reader.sources.getSource(id);
   if(source.enabled&&source.retention!=='reference'&&source.status?.state!=='permission_required')return source.syncScopeVersion??0;
  }catch(error){if(error instanceof StoreError&&error.statusCode===404)return null;throw error;}
 }
 private skippedSources(plan:Plan,items:Item[]){
  return new Set([
   ...plan.skippedSources,
   ...plan.sourcePins.filter(pin=>this.sourceVersion(pin.id)!==pin.version).map(pin=>pin.id),
   ...items.filter(item=>item.error_code===sourceUnavailable).map(item=>item.source_id),
  ]);
 }
 private assertProposalSource(jobId:string){
  const item=this.store.db.prepare(`WITH RECURSIVE lineage(id,parent) AS (
   SELECT id,json_extract(json,'$.continuationOf') FROM memory_jobs WHERE id=?
   UNION SELECT m.id,json_extract(m.json,'$.continuationOf') FROM memory_jobs m JOIN lineage l ON l.parent=m.id
  ) SELECT i.onboarding_id,h.source_id,i.error_code FROM assistant_onboarding_items i
    JOIN lineage l ON l.id=i.memory_job_id JOIN material_heads h ON h.id=i.material_id`).get(jobId);
  if(!item)throw new StoreError('Onboarding material is unavailable',409);
  const id=String(item.onboarding_id),plan=this.plan(id),source=plan.sourcePins.find(pin=>pin.id===item.source_id);
  // Completed runs still own their reviewed questions and explicit replies.
  if(this.task(id).state==='cancelled'||!source||item.error_code===sourceUnavailable||this.sourceVersion(source.id)!==source.version)
   throw new StoreError('Onboarding source authorization changed',409);
 }
 private assertFollowupSources(operationId:string,sourceIds:readonly string[]){
  const id=operationId.slice('onboarding:'.length),plan=this.plan(id);
  const skipped=this.skippedSources(plan,this.items(id));
  if(sourceIds.some(sourceId=>skipped.has(sourceId)))
   throw new StoreError('Onboarding source authorization changed',409);
 }
 private memoryJob(id:string){
  try{return this.memory.get(id);}catch(error){if(error instanceof StoreError&&(error.statusCode===404||error.statusCode===409))return;throw error;}
 }
 /** Follow only the existing explicit owner-answer lineage. A continuation is
  * not a new selection or permission to cancel/reprocess the original job. */
 private memoryState(item:Item){
  const ids=item.memory_job_id?this.store.db.prepare(`WITH RECURSIVE family(id) AS (
   SELECT id FROM memory_jobs WHERE id=? UNION SELECT m.id FROM memory_jobs m JOIN family f ON json_extract(m.json,'$.continuationOf')=f.id
  ) SELECT id FROM family`).all(item.memory_job_id).map(row=>String(row.id)):[];
  const jobs=ids.flatMap(id=>{const job=this.memoryJob(id);return job?[job]:[];});
  const contextQuestions=[];
  for(const job of jobs){let cursor:string|undefined;
   if(this.questions)do{
    const page=this.questions.page({operationId:'memory:'+job.id,materialId:item.material_id,state:['open','deferred','closed'],limit:100,cursor});
    contextQuestions.push(...page.items);cursor=page.nextCursor??undefined;
   }while(cursor);
  }
  if(contextQuestions.length>100)throw new StoreError('Onboarding owner questions exceed the bounded review',413);
  contextQuestions.sort((a,b)=>a.id.localeCompare(b.id));
  const ownerQuestions=contextQuestions.filter(question=>question.state!=='closed');
  const complete=jobs.length>0&&jobs.length===ids.length&&jobs.every(finishedMemory)&&!ownerQuestions.length;
  const reviewed=complete||jobs.length>0&&jobs.length===ids.length&&jobs.every(job=>finishedMemory(job)||reviewedOwnerWait(job))&&ownerQuestions.length>0;
  return {jobs,job:jobs.at(-1),ownerQuestions,contextQuestions,complete,reviewed};
 }
 private assertActive(id:string){if(this.closed||!['waiting','running'].includes(this.task(id).state))throw new StoreError('Onboarding is no longer active',409);}
 private view(item:Item,scope:QueryScope,selectionScope:QueryScope){
  const material=this.materials.get(item.material_id);
  const task=this.tasks.get(item.selection_id);let selection:Selection;
  try{selection=this.tasks.input<Selection>(task.id,task.revision,this.assertCurrent);}
  catch(error){
   // An explicit owner declaration retires semantic task inputs, including the
   // old selection marker. Its retained dependency identities still pin the
   // original capture. Reconstruct only that pin under a linked continuation;
   // never restore retired prose or accept a replacement original/revision.
   if(!(error instanceof StoreError&&error.statusCode===409)||task.state!=='stale'||!material||
    !this.memoryState(item).jobs.some(job=>job.continuationOf&&Object.values(job.materialRefs).includes(material.ref)))throw error;
   const pin=materialSourcePin(this.store,this.materials,material,this.archive);
   if(pin.kind!=='source-item'||!this.store.db.prepare('SELECT 1 FROM task_evidence WHERE task_id=? AND evidence_id=?').get(task.id,pin.captureId)||
    !this.reader.materialSourceCurrent(pin,item.material_id))throw error;
   selection={pin};
  }
  if(!material||!this.reader.materialSourceCurrent(selection.pin,material.id))throw new StoreError('Selected original changed',409);
  const view=this.understanding.read({ref:material.ref,scope:selectionScope,limit:1});
  return scope===selectionScope?view:this.understanding.read({ref:material.ref,scope,limit:1});
 }
 start(raw:unknown,commandId:string=randomUUID()):OnboardingStartResult{
  if(this.closed)throw new StoreError('Onboarding is unavailable',503);
  const parsed=onboardingStartInputSchema.parse(raw);
  const input={...parsed,sources:[...parsed.sources].sort()},requestId='assistant-onboarding:'+commandId;
  const prior=this.store.db.prepare('SELECT id FROM task_records WHERE request_id=?').get(requestId);
  if(prior){
   // Cancelled selections stay terminal. Replaying their command cannot renew
   // permission; a new explicit start can reuse the Memory checkpoints.
   const task=this.task(String(prior.id));
   if(task.state==='cancelled'||task.state==='stale')throw new StoreError('Onboarding is no longer active; start a new selection',409);
   if(canonicalRecipeJson(this.plan(task.id).input)!==canonicalRecipeJson(input))throw new StoreError('Onboarding request ID was reused with different input',409);
   return {id:task.id,revision:task.revision};
  }
  const sourcePins:SourcePin[]=[],skippedSources:string[]=[];
  for(const id of input.sources){
   const version=this.sourceVersion(id);
   if(version===undefined||version===null&&!this.materials.list({sourceId:id,limit:1}).items.length)skippedSources.push(id);
   else sourcePins.push({id,version});
  }
  const now=Date.now(),scope:QueryScope={kind:'all',after:new Date(now-input.window.days*dayMs).toISOString(),before:new Date(now).toISOString()};
  const candidates=this.materials.list({sourceIds:sourcePins.map(pin=>pin.id),after:scope.after,before:scope.before,limit:materialLimit,order:'source'}).items;
  const selections=candidates.flatMap(material=>{
   let view:ReturnType<AssistantUnderstandingReader['read']>;
   try{view=this.understanding.read({ref:material.ref,scope,limit:1});}
   catch(error){if(error instanceof StoreError&&(error.statusCode===404||error.statusCode===409))return [];throw error;}
   if(view.coverage.extraction.status!=='unsupported'&&!this.reader.materialPlanAllowed(material.id))return [];
   const pin=materialSourcePin(this.store,this.materials,material,this.archive);
   // A source pin is independent of later extraction. For unknown organizers,
   // the existing material-revision pin deliberately refuses changed content.
   const ids=pin.kind==='source-item'?[pin.captureId]:pin.kind==='archive-group'?[]:view.disclosureDependencies.ids;
   return [{material,selection:{pin} satisfies Selection,ids}];
  });
  if(selections.length)this.memory.assertNewManualWork();
  const plan:Plan={input,scope,sourcePins,skippedSources,identities:selections.map(({material})=>sha256(material.ref)),connections:this.connections()};
  const task=this.transaction(()=>{
   const task=this.tasks.create({operationId:requestId,requestId,kind:'assistant.onboarding',input:{},
    evidenceDependencies:deps([])},this.assertCurrent);
   // The selection metadata remains readable for the cancelled progress view.
   this.tasks.create({operationId:requestId,requestId:requestId+':plan',kind:'assistant.onboarding.plan',input:plan,
    evidenceDependencies:deps([])},this.assertCurrent);
   // Existing manual historical permission, frozen to this owner's command and
   // model connections. No automatic receipts are created or reclassified.
   this.control.manual('onboarding:'+task.id,'manual',plan.identities,plan.connections);
   for(const [position,value] of selections.entries()){
    const selection=this.tasks.create({operationId:requestId,requestId:requestId+':'+position,kind:'assistant.onboarding.selection',input:value.selection,
     evidenceDependencies:deps(value.ids)},this.assertCurrent);
    this.store.db.prepare('INSERT INTO assistant_onboarding_items(onboarding_id,position,material_id,selection_id) VALUES(?,?,?,?)')
     .run(task.id,position,value.material.id,selection.id);
   }
   return this.tasks.setState(task.id,task.revision,'running');
  });
  void this.tick().catch(()=>{});
  return {id:task.id,revision:task.revision};
 }
 /** A projection rechecks every title, locator, count and child result under
  * the caller's current scope. A narrow read never exposes a wider run's totals. */
 get(id:string,rawScope:QueryScope={kind:'all'}){
  const scope=queryScopeSchema.parse(rawScope),task=this.task(id),plan=this.plan(id);
  const selected=this.items(id),skipped=this.skippedSources(plan,selected);
  const memories=new Set<string>(),ideas=new Set<string>(),feed=new Set<string>();
  const items=selected.flatMap(item=>{
   if(skipped.has(item.source_id))return [];
   let view:ReturnType<AssistantUnderstandingReader['read']>;
   try{view=this.view(item,scope,plan.scope);}catch(error){if(error instanceof StoreError&&(error.statusCode===404||error.statusCode===409))return [];throw error;}
   const memory=this.memoryState(item),job=memory.job;
   const analysisChanged=item.followup_id&&['stale','cancelled'].includes(this.tasks.get(item.followup_id).state);
   const analyzed=item.completed_ref===view.material.ref&&!analysisChanged;
   let analysisCurrent=Boolean(analyzed);
   if(analyzed&&item.followup_id)try{analysisCurrent=!this.followup.ownerContextChanged(item.followup_id,memory.contextQuestions.map(({id,revision})=>({id,revision})));}
   catch(error){if(!(error instanceof StoreError&&(error.statusCode===404||error.statusCode===409)))throw error;analysisCurrent=false;}
   let result:ReturnType<AssistantFollowup['result']>;
   if(analyzed&&item.followup_id)try{result=this.followup.result(item.followup_id,scope);}catch(error){if(!(error instanceof StoreError&&(error.statusCode===404||error.statusCode===409)))throw error;}
   const {kind,...bounds}=scope;
   for(const memoryId of new Set(memory.jobs.flatMap(job=>job.memoryIds))){
    if(this.reader.memoryPage({...bounds,id:formatEvidenceRef('memory',memoryId),includeHistory:true}).items.length)memories.add(memoryId);
   }
   if(result){
    const activityIds=new Set(result.activityIds);
    for(const cardId of result.cardIds)(activityIds.has(cardId)?feed:ideas).add(cardId);
   }
   const completed=analysisCurrent&&memory.complete;
   const error=item.error_code??(item.memory_job_id&&!job?'memory_processing_unavailable':analysisChanged?'assistant_analysis_changed':view.coverage.extraction.status==='failed'?'extraction_failed':view.coverage.extraction.status==='unsupported'?'original_body_unavailable':undefined);
   const reason=error??(memory.ownerQuestions.length?'memory_owner_input_required':undefined);
   const semantic:FileCoverage={status:error?'failed':completed&&view.coverage.extraction.status==='ready'?'ready':analyzed||job?.completedBatches?'partial':'pending',
    reason:reason??(completed?'available_material_text_only':'understanding_incomplete')};
   return [{material:{ref:view.material.ref,title:view.material.title,sourceId:view.material.origin.sourceId},
    state:completed&&view.coverage.extraction.status==='ready'?'completed' as const:task.state==='cancelled'?'cancelled' as const:error?'failed' as const:'pending' as const,
    coverage:{sync:{status:'ready' as const,reason:'selected_synced_material_only'},extraction:view.coverage.extraction,semantic},
    ...(reason?{reason}:{}),...(item.followup_id?{taskId:item.followup_id,...(result?{result}:{})}:{}),
    ownerQuestions:memory.ownerQuestions.map(question=>({id:question.id,revision:question.revision,prompt:question.prompt,reason:question.reason,state:question.state})),
    ...(job?{memory:{id:job.id,status:job.status,completedBatches:job.completedBatches,totalBatches:job.totalBatches}}:{})}];
  });
  const coverage=(kind:'extraction'|'semantic')=>({total:items.length,completed:items.filter(item=>item.coverage[kind].status==='ready').length,
   partial:items.filter(item=>item.coverage[kind].status==='partial').length,pending:items.filter(item=>item.coverage[kind].status==='pending').length,
   failed:items.filter(item=>['failed','unsupported'].includes(item.coverage[kind].status)).length});
  const skippedCount=scope.evidenceIds||scope.deviceId||scope.after||scope.before?0:
   [...skipped].filter(sourceId=>scope.kind==='all'||scope.sourceIds===undefined||scope.sourceIds.includes(sourceId)).length;
  const counts:OnboardingCounts={sources:new Set(items.map(item=>item.material.sourceId)).size,materials:items.length,memories:memories.size,ideas:ideas.size,feed:feed.size,
   ...(skippedCount?{skippedSources:skippedCount}:{})};
  const state:OnboardingState=task.state==='cancelled'?'cancelled':task.state==='succeeded'?'completed':
   task.state==='waiting'?'pending':task.state==='failed'||items.length>0&&items.every(item=>item.state!=='pending')&&items.some(item=>item.state==='failed')?'failed':'running';
  return {id,revision:task.revision,state,counts,
   coverage:{sync:{completed:items.length,total:items.length,reason:'selected_synced_materials_only'},extraction:coverage('extraction'),semantic:coverage('semantic')},
   completed:items.filter(item=>item.state==='completed').length,pending:items.filter(item=>item.state==='pending').length,failed:items.filter(item=>item.state==='failed').length,
   cancelled:items.filter(item=>item.state==='cancelled').length,items};
 }
 private update(item:Item,values:Partial<Pick<Item,'memory_job_id'|'processing_ref'|'followup_id'|'completed_ref'|'error_code'>>){
  const entries=Object.entries(values);this.transaction(()=>this.store.db.prepare(`UPDATE assistant_onboarding_items SET ${entries.map(([key])=>key+'=?').join(',')} WHERE onboarding_id=? AND position=?`)
   .run(...entries.map(([,value])=>value!),item.onboarding_id,item.position));Object.assign(item,values);
 }
 private effectiveScope(id:string,plan:Plan){
  const ids=new Set<string>(),sources=new Set<string>();
  const items=this.items(id),skipped=this.skippedSources(plan,items);
  for(const item of items){
   if(skipped.has(item.source_id))continue;
   try{
    const view=this.view(item,plan.scope,plan.scope);
    for(const evidenceId of view.disclosureDependencies.ids)ids.add(evidenceId);
    sources.add(view.material.origin.sourceId);
   }catch(error){if(!(error instanceof StoreError&&(error.statusCode===404||error.statusCode===409)))throw error;}
  }
  if(ids.size>20000)throw new StoreError('Onboarding evidence exceeds the bounded selection',413);
  const sourceIds=[...sources].sort();
  // The frozen Material set already enforces the time window. Its derived
  // text anchors can be dated at extraction, and device originals can lack a
  // connector source ID, so the exact evidence identities carry the grant.
  const scope:QueryScope={kind:'selection',evidenceIds:[...ids].sort(),
   ...(plan.sourcePins.some(pin=>pin.version===null&&sources.has(pin.id))?{}:{sourceIds})};
  return {scope,sourceIds};
 }
 private async advance(item:Item,plan:Plan):Promise<boolean>{
  const id=item.onboarding_id,view=this.view(item,plan.scope,plan.scope),ref=view.material.ref;
  const current=()=>{
   this.assertActive(id);
   const source=plan.sourcePins.find(pin=>pin.id===item.source_id);
   if(!source||this.sourceVersion(source.id)!==source.version||this.view(item,plan.scope,plan.scope).material.ref!==ref)
    throw new StoreError('Onboarding input changed',409);
  };
  if(item.processing_ref&&item.processing_ref!==ref){
   const continued=this.memoryState(item).jobs.some(job=>job.continuationOf&&Object.values(job.materialRefs).includes(ref));
   if(item.memory_job_id&&!continued)this.memory.cancel(item.memory_job_id);
   if(item.followup_id)this.followup.cancel(item.followup_id);
   this.update(item,{...(!continued?{memory_job_id:null}:{}),processing_ref:continued?ref:null,followup_id:null,completed_ref:null,error_code:null});
  }
  if(item.error_code){
   // A valid model result can outlive a transient read/write failure during
   // final publication. Revalidate it through the same guarded consumer; this
   // neither repeats model work nor revives a stale/cancelled execution.
   if(item.error_code!=='understanding_unavailable'||!item.followup_id)return false;
   const progress=this.followup.progress(item.followup_id);
   if(['stale','cancelled'].includes(progress.task.state)||progress.batch?.task.state!=='succeeded')return false;
   await this.followup.finish(item.followup_id,current);current();this.update(item,{completed_ref:ref,error_code:null});return false;
  }
  if(view.coverage.extraction.status==='failed'||view.coverage.extraction.status==='unsupported'){
   this.update(item,{processing_ref:ref,error_code:view.coverage.extraction.status==='failed'?'extraction_failed':'original_body_unavailable'});return false;
  }
  if(view.coverage.extraction.status==='pending')return false;
  const input=this.materials.input(ref,this.requirements(ref)??['material']);
  if(!input?.ready||!input.evidenceIds.length||!this.reader.materialAllowedForMemory(ref,undefined,input.required))return false;
  if(!item.memory_job_id){
   this.control.manualCommand('onboarding:'+id,plan.identities,plan.connections,()=>this.transaction(()=>{
    current();const job=this.memory.create({evidenceIds:input.evidenceIds,contextTime:this.task(id).createdAt,
     originKey:'onboarding:'+sha256(JSON.stringify([item.selection_id,ref]))},{proposalOnly:true});
    this.update(item,{memory_job_id:job.id,processing_ref:ref});void this.memory.run(job.id).catch(()=>{});
   }));return true;
  }
  const memory=this.memoryState(item),job=memory.job!;
  if(!memory.reviewed){
   if(['failed','cancelled'].includes(job.status)||job.outcome==='input_invalidated'){
    this.update(item,{error_code:job.outcome==='input_invalidated'?'understanding_input_changed':job.status==='cancelled'?'understanding_cancelled':job.errorCode??'memory_processing_failed'});return false;
   }
   return job.status==='waiting_for_input'&&job.errorCode==='memory_owner_input_required'?false:true;
  }
  const {scope,sourceIds}=this.effectiveScope(id,plan),ownerQuestions=memory.contextQuestions.map(({id,revision})=>({id,revision}));
  if(item.followup_id&&this.followup.ownerContextChanged(item.followup_id,ownerQuestions)){
   this.followup.cancel(item.followup_id);this.update(item,{followup_id:null,completed_ref:null});
  }
  if(item.completed_ref===ref&&item.followup_id){
   try{if(this.followup.result(item.followup_id,scope))return false;}catch(error){if(!(error instanceof StoreError&&(error.statusCode===404||error.statusCode===409)))throw error;}
   this.update(item,{followup_id:null,completed_ref:null});
  }
  if(!item.followup_id){
   await this.followup.start({operationId:'onboarding:'+id,requestId:'onboarding:'+sha256(JSON.stringify([item.selection_id,view.material.revision,ownerQuestions,scope])),
    materialRefs:[ref],scope,ownerQuestions,mode:{kind:'onboarding',sourceIds}},
    {identities:plan.identities,connections:plan.connections},current,task=>this.update(item,{followup_id:task.id}));
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
    if(this.closed)return;
    const id=String(row.id);
    let plan:Plan;
    try{plan=this.plan(id);}catch(error){if(error instanceof StoreError&&error.statusCode===409)continue;throw error;}
    const selected=this.items(id),skipped=this.skippedSources(plan,selected);
    const withdrawn=selected.filter(item=>skipped.has(item.source_id)&&item.error_code!==sourceUnavailable);
    if(withdrawn.length)this.transaction(()=>{
     for(const item of withdrawn){
      this.update(item,{error_code:sourceUnavailable});
      if(item.followup_id)this.followup.cancel(item.followup_id,{supersede:true});
     }
     for(const item of selected){
      if(skipped.has(item.source_id)||item.completed_ref||!item.followup_id)continue;
      // In-flight analysis may have considered the withdrawn source in context.
      this.followup.cancel(item.followup_id,{supersede:true});
      this.update(item,{followup_id:null,error_code:null});
     }
     for(const item of withdrawn)if(item.memory_job_id&&this.memoryJob(item.memory_job_id))this.memory.cancel(item.memory_job_id);
    });
    for(const item of selected){
     if(skipped.has(item.source_id))continue;
     try{this.assertActive(id);if(await this.advance(item,plan))break;}
     catch(error){
      if(this.closed||this.task(id).state==='cancelled')break;
      const failure=safeError(error);this.diagnostics?.record('agent.failed',{operation:'query',jobId:item.followup_id??item.memory_job_id??id,
       statusCode:failure.status,category:failure.category,...(failure.reason?{reason:failure.reason}:{})},'warn');
      // Persist a bounded product reason, never provider text or source bodies.
      this.update(item,{error_code:error instanceof StoreError&&error.statusCode===413?'understanding_input_limit':'understanding_unavailable'});
     }
    }
    const task=this.task(id);
    if(this.closed||task.state!=='running')continue;
    const progress=this.get(id),remaining=this.items(id).filter(item=>item.error_code!==sourceUnavailable);
    if(!remaining.length&&progress.counts.skippedSources){
     this.tasks.setState(id,task.revision,'failed');
    }else if(progress.items.length===remaining.length&&progress.items.every(item=>item.state==='completed')){
     this.tasks.saveResult(id,task.revision,{counts:progress.counts},deps([]),this.assertCurrent);
    }
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
