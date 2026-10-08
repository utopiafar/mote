import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {fileProcessingSchema,transcriptSchema,unknownAttributionContext,type CaptureInput,type CaptureRecord,type Transcript,type ProcessingService} from '@mote/shared';
import {Store,StoreError,sha256} from './store.js';
import {ExecutionEngine,ExecutionFailure,type ExecutionStep} from './execution-engine.js';
import {FileProcessing} from './file-processing.js';
import {processorSettingsFingerprint,processorContract} from './file-configuration.js';
import type {AppliedFilePolicy} from './file-policy.js';
import {ImageInputRegistry,ImageAttachmentIntake,installImageInputs,installImageSchema,screenImageSource,type ImageInputRow,type ImageOriginal} from './image-inputs.js';
import {DEFAULT_IMAGE_RECIPE,imageInterpretationSchema,type ImageInterpretation} from './image-recipes.js';
import {linkOperationParent} from './operation-projection.js';
import {imageOutput} from './evidence-image.js';
import {writeFileTranscriptChunks} from './file-transcript-chunks.js';
import {invalidateRetiredFileEvidence} from './evidence-dependencies.js';
import {perceptionSettingsSchema} from './perception.js';
import {MEDIA_CATALOG,type MediaAssets} from './media-assets.js';
import {requestLocalJson} from './local-http.js';
import type {MaterialMemoryWork} from './material-memory-work.js';
import type {MaterialStore} from './materials.js';

const settingsSchema=perceptionSettingsSchema.extend({understandingEnabled:z.boolean().default(true),profileId:z.string().max(100).optional()});
export type ImageSettings=z.infer<typeof settingsSchema>;
export type ImageUnderstanding={
 selection(service?:ProcessingService):{fingerprint:string;configured:boolean;receipt:Record<string,unknown>};
 run(input:{record:CaptureRecord;original:ImageOriginal;ocr?:Transcript;signal:AbortSignal;readImage(input:import('@mote/shared').ImageReadInput):Promise<import('@mote/shared').ImageReadResult>;operationId:string;service?:ProcessingService}):Promise<ImageInterpretation>;
};
type PlanStep={name:string;kind:string;stage:{id:string;version:string};dependsOn:string[]};
type JobRow={capture_id:string;kind:string;state:string;error:string|null;attempts:number;available_at:number;auto_eligible:number};
const historicalSchema=z.object({after:z.string().datetime({offset:true}).optional(),before:z.string().datetime({offset:true}).optional(),sourceId:z.string().max(128).optional(),mode:z.enum(['complete','recompute']).default('complete')}).strict();
const managedEndpoint=()=>process.env.MOTE_MEDIA_OCR_ENDPOINT??'http://127.0.0.1:9010/ocr';
/** One intake ledger and one executor for all accepted image originals. The
 * adapters only retain source-specific publication/retention semantics. */
export class ImageProcessing {
 readonly engine:ExecutionEngine;readonly inputs:ImageInputRegistry;
 private unregister:Array<()=>Promise<void>>=[];private disposeInputs:()=>void;
 private attachments:ImageAttachmentIntake;private closed=false;private workerReady=false;private checkedAt=0;private probe?:Promise<void>;
 private prepareCursor=0;
 private previews=new Map<string,{expires:number;watermark:number;query:z.infer<typeof historicalSchema>}>();
 constructor(private store:Store,private processing:FileProcessing,engine:ExecutionEngine,private options:{understanding?:ImageUnderstanding;mediaAssets?:MediaAssets;memoryWork?:MaterialMemoryWork;materials?:MaterialStore;probeOcr?:()=>Promise<boolean>}={}){
  this.engine=engine;this.inputs=processing.runtime.imageInputs;installImageSchema(store);
  this.disposeInputs=installImageInputs(store,processing.files,this.inputs);
  this.attachments=new ImageAttachmentIntake(store,processing.files);
  const db=store.db;
  if(!db.prepare("SELECT 1 FROM settings WHERE key='image-policy-migrated'").get()){
   const prior=db.prepare("SELECT value FROM settings WHERE key='perception'").get(),legacy=perceptionSettingsSchema.strip().parse(prior?JSON.parse(String(prior.value)):{});
   // Preserve explicit source/type rules; replace only the historical builtin
   // global archive fallback, which predates shared image defaults.
   if(this.processing.imageDefault().profile.processorId==='archive'&&(this.processing.view().revision==='initial'||Boolean(legacy.ocrEndpoint)))this.processing.configureImageDefault({endpoint:legacy.ocrEndpoint||managedEndpoint(),processorId:legacy.ocrProcessorId});
   db.prepare("INSERT INTO settings VALUES('image-policy-migrated','1')").run();
  }
  // Installing/upgrading reconstructs denied historical intentions, never scans
  // historical content with a model or grants new automatic Memory permission.
  db.exec(`INSERT OR IGNORE INTO image_inputs(capture_id,adapter,source_id,hash,mime,revision,auto_eligible,created_at)
   SELECT c.id,'mote.capture-image','screen:'||mote_image_device_hash(c.device_id),c.blob_hash,c.mime,c.fingerprint,0,CAST(strftime('%s',c.received_at) AS INTEGER)*1000
   FROM captures c LEFT JOIN perception_jobs p ON p.capture_id=c.id AND p.kind='ocr' WHERE c.blob_hash IS NOT NULL;
   INSERT OR IGNORE INTO image_inputs(capture_id,adapter,source_id,hash,mime,revision,override_id,auto_eligible,created_at)
   SELECT v.capture_id,'mote.file-image',v.source_id,coalesce(v.object_hash,json_extract(v.manifest,'$.sha256')),json_extract(v.manifest,'$.item.mimeType'),v.revision,json_extract(v.manifest,'$.processingProfileId'),0,CAST(strftime('%s',c.received_at) AS INTEGER)*1000
   FROM file_versions v JOIN captures c ON c.id=v.capture_id WHERE json_extract(v.manifest,'$.item.mimeType') LIKE 'image/%' AND coalesce(json_extract(v.manifest,'$.item.deleted'),0)=0;
   CREATE TABLE IF NOT EXISTS image_backfills(id TEXT PRIMARY KEY,query TEXT NOT NULL,watermark INTEGER NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,queued INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'waiting');`);
  processing.imageControl=this;
  const materials=this.materials();if(materials){
   const previous=materials.onContextChanged;materials.onContextChanged=(id,cause)=>{previous?.(id,cause);if(cause!=='derived')this.invalidateAttribution(id);};
   const priorSource=materials.onSourceContextChanged;materials.onSourceContextChanged=id=>{priorSource?.(id);for(const row of db.prepare('SELECT capture_id FROM image_inputs WHERE source_id=?').all(id))this.invalidateImageAttribution(String(row.capture_id));};
  }
  store.imageReceived=input=>this.receive(input);
  for(const kind of ['ocr','understanding','derived'])this.unregister.push(engine.register({kind:'images.'+kind,pool:'images.'+kind,concurrency:()=>this.settings().concurrency,timeoutMs:()=>this.processing.currentSettings().timeoutMs,
   resourceKeys:step=>['image-product:'+String(step.input.fingerprint)],validate:step=>this.valid(step),
   admit:step=>this.admit(step),execute:(step,signal)=>this.execute(step,signal),commit:(step,result)=>this.commit(step,result),project:step=>this.project(step),
   classify:error=>error instanceof StoreError&&error.statusCode===507?new ExecutionFailure('blocked','storage_full'):error instanceof z.ZodError?new ExecutionFailure('permanent','invalid_image_product'):error instanceof StoreError&&[400,413,415,422].includes(error.statusCode)?new ExecutionFailure('permanent','unsupported_image'):new ExecutionFailure('transient','image_processing_failed',30000),
  }));
 }
 private receive(input:CaptureInput){
  if(!this.options.memoryWork)return;
  const sourceId=screenImageSource(input.deviceId,sha256),db=this.store.db,now=new Date().toISOString();
  if(!db.prepare('SELECT 1 FROM source_connections WHERE id=?').get(sourceId)){
   const source={id:sourceId,name:input.deviceName||input.deviceId,kind:'custom',deviceId:input.deviceId,platform:input.platform,retention:'archive',enabled:true,createdAt:now,updatedAt:now};
   this.store.reserveMetadata(Buffer.byteLength(JSON.stringify(source))+256);db.prepare('INSERT INTO source_connections VALUES(?,?)').run(sourceId,JSON.stringify(source));
  }
  this.options.memoryWork.inputs.receive({sourceId,inputKey:input.id,captureId:input.id});
 }
 owns(id:string){return Boolean(this.store.db.prepare('SELECT 1 FROM image_inputs WHERE capture_id=?').get(id));}
 private row(id:string){return this.store.db.prepare('SELECT * FROM image_inputs WHERE capture_id=?').get(id) as ImageInputRow|undefined;}
 private original(row:ImageInputRow){return this.inputs.get(row.adapter)?.resolve(row);}
 private binding(row:ImageInputRow){return this.processing.imageConfiguration(row.source_id,row.mime,row.override_id??undefined,row.policy_json?JSON.parse(row.policy_json):undefined);}
 private recipe(row:ImageInputRow){const binding=this.binding(row);return {...this.processing.runtime.imageRecipes.resolve(binding.applied.profile.imageRecipe??DEFAULT_IMAGE_RECIPE,Boolean(row.understanding_enabled&&this.settings().understandingEnabled)),binding};}
 settings():ImageSettings{
  const row=this.store.db.prepare("SELECT value FROM settings WHERE key='perception'").get(),saved=settingsSchema.strip().parse(row?JSON.parse(String(row.value)):{}),applied=this.processing.imageDefault();
  const service=applied.services.find(s=>s.id===applied.profile.serviceId);
  return {...saved,ocrEndpoint:service?.endpoint??'',ocrProcessorId:applied.profile.processorId,profileId:applied.profile.id};
 }
 view(){return {settings:this.settings(),recent:this.store.db.prepare('SELECT j.capture_id AS id,j.kind,j.state,j.error,i.auto_eligible AS autoEligible FROM perception_jobs j JOIN image_inputs i ON i.capture_id=j.capture_id ORDER BY j.created_at DESC LIMIT 40').all(),jobs:this.store.db.prepare('SELECT j.kind,j.state,i.auto_eligible AS autoEligible,count(*) AS count FROM perception_jobs j JOIN image_inputs i ON i.capture_id=j.capture_id GROUP BY j.kind,j.state,i.auto_eligible').all(),inputs:this.inputs.list(),recipes:this.processing.runtime.imageRecipes.list(),backfills:this.store.db.prepare('SELECT id,state,queued,cursor,watermark FROM image_backfills ORDER BY rowid DESC LIMIT 20').all(),model:this.options.understanding?.selection(this.processing.imageConfiguration('', 'image/png').settings.analysisModel).receipt??null};}
 detail(id:string){
  const row=this.row(id);if(!row||!this.store.isCurrentEvidence(id))throw new StoreError('Image not found',404);
  const exists=(name:string)=>Boolean(this.store.db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name));
  const products=this.store.db.prepare('SELECT id,name,kind,json FROM image_products WHERE capture_id=? AND current=1').all(id).map(p=>{const value=JSON.parse(String(p.json));return {id:String(p.id),name:String(p.name),kind:String(p.kind),text:p.kind==='ocr'?transcriptSchema.parse(value.payload).segments.map(s=>s.text).join('\n'):String(value.payload.text),generatedAt:value.generatedAt,evidence:value.evidence,regions:value.payload.regions};});
  const jobs=this.store.db.prepare('SELECT kind AS name,state,error,attempts FROM perception_jobs WHERE capture_id=?').all(id);
  const materials=exists('material_members')?this.store.db.prepare(`SELECT DISTINCT h.id,r.state FROM material_members m JOIN material_heads h ON h.id=m.material_id AND h.revision=m.revision LEFT JOIN material_index_requests r ON r.material_id=h.id WHERE m.ref=? AND h.retired=0`).all('capture:'+id):[];
  const memory=exists('material_memory_requests')&&exists('memory_jobs')?materials.flatMap(m=>this.store.db.prepare('SELECT w.auto_authorized,w.error,j.json FROM material_memory_requests w LEFT JOIN memory_jobs j ON j.id=w.job_id WHERE w.material_id=?').all(m.id).map(w=>{const job=w.json?JSON.parse(String(w.json)):undefined;return {state:job?.status??(w.auto_authorized?'waiting':'not_scheduled'),count:job?.memoryCount??job?.memoryIds?.length??0,error:w.error};})):[];
  let policy;try{policy=this.binding(row).applied;}catch{policy=row.policy_json?JSON.parse(row.policy_json):null;}
  return {id,wait:this.processing.imageProcessorWait(id),original:{state:this.original(row)?'ready':'unavailable',hash:row.hash,mimeType:row.mime},policy,automatic:Boolean(row.auto_eligible),understandingEnabled:Boolean(row.understanding_enabled&&this.settings().understandingEnabled),products,jobs,materials:materials.map(m=>({id:m.id,state:m.state??'pending'})),memory};
 }
 configure(raw:unknown){
  const previous=this.settings(),next=settingsSchema.parse(raw);
  if(next.profileId!==previous.profileId&&next.profileId)this.processing.configureImageDefault({profileId:next.profileId});
  else if(next.ocrEndpoint!==previous.ocrEndpoint||next.ocrProcessorId!==previous.ocrProcessorId)this.processing.configureImageDefault({endpoint:next.ocrEndpoint,processorId:next.ocrProcessorId});
  // Service endpoints and credentials live solely in file processing policy.
  const {ocrEndpoint,ocrProcessorId,profileId,...saved}=next;
  this.store.db.prepare("INSERT INTO settings VALUES('perception',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(saved));
  for(const row of this.store.db.prepare("SELECT id FROM execution_steps WHERE kind LIKE 'images.%' AND state IN ('waiting','running','blocked','failed')").all()){
   const step=this.engine.get(String(row.id));if(step&&!this.valid(step))this.engine.cancel(step.id);
  }
  return this.view();
 }
 private fingerprint(row:ImageInputRow,step:PlanStep){
  const {binding,fingerprint:recipe}=this.recipe(row),settings=this.settings(),processor=this.processing.runtime.registry.get(binding.applied.profile.processorId);
  const dependencyProducts=step.dependsOn.map(name=>this.product(row.capture_id,name)?.fingerprint??null);
  const model=step.kind==='ocr'?null:this.options.understanding?.selection(binding.settings.analysisModel).fingerprint??'unconfigured';
  const record=this.store.evidence([row.capture_id])[0];
  const attribution=step.kind==='ocr'?undefined:this.materials()?.contextForEvidence(record);
  const meaningful=attribution&&(attribution.basis!=='default'||attribution.correction||attribution.sourceDeclaration||attribution.materialDeclarations);
  // Truly unknown/default context retains the pre-attribution cache identity.
  // Declaration and correction versions (including cleared values) fence ABA.
  const context=step.kind==='ocr'&&processor.reuseByContent===true&&this.processing.runtime.imageRecipes.get(step.stage).reuseByContent===true?null:{...this.context(record),...(meaningful?{attributionContext:attribution}:{})};
  return sha256(JSON.stringify([row.hash,row.mime,processorContract(processor),processor.output?this.processing.runtime.outputs.list():null,processorSettingsFingerprint(processor,binding.settings,binding.applied.profile.parameters),settings.providerRevision,
   binding.settings.imageEndpoint===managedEndpoint()?MEDIA_CATALOG.ocr.version:'',step.stage,step.kind==='ocr'?null:recipe,dependencyProducts,model,context]));
 }
 private materials(){return this.options.materials??this.processing.files.sources.pipelines?.materials;}
 /** Context correction retires interpretations, keeps reusable OCR, and waits
  * for an explicit historical retry instead of billing on a changed context. */
 private invalidateAttribution(materialId:string){
  const members=this.store.db.prepare('SELECT DISTINCT m.ref FROM material_members m JOIN material_heads h ON h.id=m.material_id AND h.revision=m.revision WHERE m.material_id=?').all(materialId);
  for(const member of members){const ref=String(member.ref);if(ref.startsWith('capture:'))this.invalidateImageAttribution(ref.slice(8));}
 }
 private invalidateImageAttribution(id:string){
  if(!this.owns(id))return;
  const db=this.store.db,row=this.row(id)!,semanticNames=new Set<string>(),ocrNames=new Set<string>();
  // This durable authority does not depend on installed recipe capabilities.
  // Reinstalling a missing stage cannot grant historical model work.
  db.prepare('UPDATE image_inputs SET semantic_withdrawn=1 WHERE capture_id=?').run(id);
  try{for(const stage of this.recipe(row).steps){
   if(stage.kind!=='ocr')semanticNames.add(stage.name);else ocrNames.add(stage.name);
   db.prepare("INSERT OR IGNORE INTO perception_jobs(capture_id,kind,state,created_at,error,auto_eligible) VALUES(?,?,?,?,?,1)").run(id,stage.name,stage.kind==='ocr'?'waiting':'cancelled',Date.now(),stage.kind==='ocr'?null:'attribution_context_changed');
  }}catch{/* Missing recipes remain unavailable; durable metadata still revokes known semantic steps. */}
  for(const product of db.prepare("SELECT name FROM image_products WHERE capture_id=? AND kind!='ocr' AND current=1").all(id))semanticNames.add(String(product.name));
  for(const raw of db.prepare("SELECT id FROM execution_steps WHERE operation_id=? AND kind IN ('images.understanding','images.derived')").all('image:'+id)){
   const step=this.engine.get(String(raw.id))!;semanticNames.add(String(step.input.name));
   if(!['succeeded','cancelled','stale'].includes(step.state)){
    // Cancellation is part of the correction transaction. Immediate local abort
    // would survive rollback and turn a failed correction into another paid retry.
    this.engine.cancel(step.id,false);
   }
  }
  db.prepare("UPDATE image_products SET current=0 WHERE capture_id=? AND kind!='ocr' AND current=1").run(id);
  for(const name of semanticNames)if(!ocrNames.has(name))db.prepare("UPDATE perception_jobs SET state='cancelled',error='attribution_context_changed' WHERE capture_id=? AND kind=?").run(id,name);
  this.projectFile(row);
 }
 private context(record:CaptureRecord){return {id:record.id,source:record.source,capturedAt:record.capturedAt,appName:record.appName,title:record.windowTitle,sourceVersion:record.provenance?{sourceId:record.provenance.sourceId,revision:record.provenance.revision,document:{contentRole:record.provenance.document?.contentRole,timeBasis:record.provenance.document?.timeBasis,recordedAt:record.provenance.document?.recordedAt,attachmentOf:record.provenance.document?.attachmentOf}}:undefined};}
 private product(id:string,name:string){return this.store.db.prepare('SELECT * FROM image_products WHERE capture_id=? AND name=? AND current=1 ORDER BY rowid DESC LIMIT 1').get(id,name);}
 private semanticWithdrawn(id:string){return Boolean(this.row(id)?.semantic_withdrawn);}
 private valid(step:ExecutionStep){
  if(this.closed)return false;if(step.kind!=='images.ocr'&&this.semanticWithdrawn(String(step.input.captureId)))return false;const row=this.row(String(step.input.captureId));if(!row||row.hash!==step.input.hash||row.generation!==step.input.generation||!this.store.isCurrentEvidence(row.capture_id))return false;
  try{const plan=this.recipe(row),stage=plan.steps.find(s=>s.name===step.input.name);return Boolean(stage&&this.fingerprint(row,stage)===step.input.fingerprint&&this.inputs.get(row.adapter)?.version===step.input.adapterVersion);}catch{return false;}
 }
 private admit(step:ExecutionStep){
  const row=this.row(String(step.input.captureId))!,settings=this.settings();
  if(!settings.enabled||!this.binding(row).settings.enabled)return new ExecutionFailure('blocked','processing_disabled');
  if(!this.original(row))return new ExecutionFailure('blocked',row.adapter==='mote.file-image'&&this.processing.files.detail(row.capture_id,false).item.layer==='snapshot'?'snapshot_input_expired':'original_missing');
  const plan=this.recipe(row),stage=plan.steps.find(s=>s.name===step.input.name)!;
  if(stage.kind==='ocr'){
   const url=plan.binding.settings.imageEndpoint;
   const processor=this.processing.runtime.registry.get(plan.binding.applied.profile.processorId);
   if(this.processing.imageProcessorWait(row.capture_id,'image-product:'+String(step.input.fingerprint)))return new ExecutionFailure('blocked','processor_still_running');
   if(processor.stage!=='extract'||!processor.mediaTypes.some(t=>t.endsWith('/')?row.mime.startsWith(t):t===row.mime||t.endsWith('/*')&&row.mime.startsWith(t.slice(0,-1))))return new ExecutionFailure('blocked','unsupported_format');
   if(processor.serviceKind&&!url)return new ExecutionFailure('blocked','provider_not_configured');
   if(url&&!settings.allowExternalProcessing&&!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))return new ExecutionFailure('blocked','external_processing_disabled');
   if(url===managedEndpoint()&&this.options.mediaAssets){if(!this.options.mediaAssets.ready('ocr'))return new ExecutionFailure('blocked','model_missing');if(!this.workerReady)return new ExecutionFailure('waiting','ocr_worker_unavailable',5000);}
  }else if(stage.kind==='understanding'&&!this.options.understanding?.selection(plan.binding.settings.analysisModel).configured)return new ExecutionFailure('blocked','model_unconfigured');
 }
 private project(step:ExecutionStep){
  const row=this.row(String(step.input.captureId));if(!row||row.generation!==step.input.generation)return;
  const state=step.state==='waiting'&&step.error==='image_processing_failed'?'failed':step.state;
  this.store.db.prepare('UPDATE perception_jobs SET state=?,attempts=?,available_at=?,error=? WHERE capture_id=? AND kind=?').run(state,step.attempts,step.availableAt,step.error??null,row.capture_id,String(step.input.name));
  this.projectFile(row);
 }
 private projectFile(row:ImageInputRow){
  if(row.adapter!=='mote.file-image')return;
  const jobs=this.store.db.prepare('SELECT kind,state,error FROM perception_jobs WHERE capture_id=?').all(row.capture_id),ocr=jobs.find(j=>j.kind==='ocr');
  const state=jobs.some(j=>j.state==='running')?'running':jobs.some(j=>j.state==='failed')?'failed':jobs.some(j=>j.state==='blocked')?'blocked':jobs.some(j=>j.state==='waiting')?'waiting':jobs.length&&jobs.every(j=>['succeeded','cancelled'].includes(String(j.state)))?(jobs.some(j=>j.error==='cancelled')?'cancelled':'succeeded'):'waiting';
  const error=jobs.find(j=>j.error)?.error??null;
  this.store.db.prepare("UPDATE file_jobs SET state=?,stage=?,error=?,summary_state='blocked' WHERE capture_id=?").run(state,ocr?.state==='succeeded'?'understanding':'ocr',error,row.capture_id);
  // Physical asset removal cannot roll back with a correction or executor
  // transaction. The next prepare pass releases committed terminal inputs.
  if(state==='succeeded'&&!this.store.db.isTransaction)this.processing.files.releaseSnapshotInput(row.capture_id);
 }
 private releaseCompletedSnapshotInputs(){
  if(this.store.db.isTransaction)return;
  const rows=this.store.db.prepare("SELECT s.capture_id FROM file_snapshot_inputs s JOIN image_inputs i ON i.capture_id=s.capture_id JOIN file_jobs j ON j.capture_id=s.capture_id WHERE j.state='succeeded'").all();
  for(const row of rows)this.processing.files.releaseSnapshotInput(String(row.capture_id));
 }
 private async refreshWorker(){
  if(this.probe)return this.probe;
  this.probe=(async()=>{
   const token=process.env.MOTE_MEDIA_WORKER_TOKEN;
   const check=async()=>{if(!token)return false;const url=new URL(managedEndpoint());url.pathname='/health';try{const value=await requestLocalJson(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(1200),limit:4096,requireOfflineExecution:false}) as {ocr?:boolean};return value.ocr===true;}catch{return false;}};
   this.workerReady=await (this.options.probeOcr??check)().catch(()=>false);this.checkedAt=Date.now();
   if(this.workerReady&&!this.closed)for(const job of this.store.db.prepare("SELECT id FROM execution_steps WHERE kind='images.ocr' AND error='ocr_worker_unavailable' AND state='waiting'").all())this.engine.retry(String(job.id),false);
  })().finally(()=>{this.probe=undefined;});return this.probe;
 }
 prepare(){
  if(this.closed)return [];
  this.releaseCompletedSnapshotInputs();
  if(Date.now()-this.checkedAt>=5000)void this.refreshWorker();
  void this.attachments.prepare();this.backfillBatch();
  const ids:string[]=[],db=this.store.db;
  const candidates=db.prepare(`SELECT i.rowid position,i.* FROM image_inputs i WHERE i.auto_eligible=1 AND (
    NOT EXISTS(SELECT 1 FROM perception_jobs j WHERE j.capture_id=i.capture_id)
    OR EXISTS(SELECT 1 FROM perception_jobs j WHERE j.capture_id=i.capture_id AND j.state IN ('waiting','blocked','failed','stale') AND j.attempts<4 AND j.available_at<=?)) AND i.rowid>? ORDER BY i.rowid LIMIT 200`);
  let rows=candidates.all(Date.now(),this.prepareCursor);
  if(!rows.length&&this.prepareCursor){this.prepareCursor=0;rows=candidates.all(Date.now(),0);}
  for(const raw of rows){
   this.prepareCursor=Number(raw.position);
   let row=raw as ImageInputRow;
   if(!this.store.isCurrentEvidence(row.capture_id))continue;
   try{
    if(!row.policy_json){const selected=this.binding(row).applied;db.prepare('UPDATE image_inputs SET policy_json=? WHERE capture_id=?').run(JSON.stringify(selected),row.capture_id);row={...row,policy_json:JSON.stringify(selected)};}
    const binding=this.binding(row);
    if(binding.applied.profile.processorId==='archive'){
     db.prepare("INSERT INTO perception_jobs(capture_id,kind,state,created_at) VALUES(?,'ocr','succeeded',?) ON CONFLICT(capture_id,kind) DO UPDATE SET state='succeeded',error=NULL").run(row.capture_id,Date.now());
     db.prepare("UPDATE file_jobs SET state='succeeded',stage='archive',error=NULL,summary_state='blocked',policy_json=? WHERE capture_id=?").run(row.policy_json,row.capture_id);continue;
    }
    const plan=this.recipe(row);
    for(const obsolete of db.prepare('SELECT kind FROM perception_jobs WHERE capture_id=?').all(row.capture_id))if(!plan.steps.some(s=>s.name===obsolete.kind))db.prepare("UPDATE perception_jobs SET state='cancelled',error='not_scheduled' WHERE capture_id=? AND kind=?").run(row.capture_id,obsolete.kind);
    for(const stage of plan.steps){
     if(stage.kind!=='ocr'&&this.semanticWithdrawn(row.capture_id)){db.prepare("INSERT INTO perception_jobs(capture_id,kind,state,created_at,error) VALUES(?,?,'cancelled',?,'attribution_context_changed') ON CONFLICT(capture_id,kind) DO UPDATE SET state='cancelled',error='attribution_context_changed'").run(row.capture_id,stage.name,Date.now());continue;}
     db.prepare("INSERT OR IGNORE INTO perception_jobs(capture_id,kind,state,created_at,auto_eligible) VALUES(?,?,'waiting',?,1)").run(row.capture_id,stage.name,Date.now());
     const job=db.prepare('SELECT * FROM perception_jobs WHERE capture_id=? AND kind=?').get(row.capture_id,stage.name) as JobRow;
     if(['succeeded','cancelled'].includes(job.state)||job.attempts>=4||job.available_at>Date.now())continue;
     if(!settingsSchema.parse(this.settings()).enabled){db.prepare("UPDATE perception_jobs SET state='blocked',error='processing_disabled' WHERE capture_id=? AND kind=?").run(row.capture_id,stage.name);continue;}
     if(!stage.dependsOn.every(name=>{const dependency=db.prepare('SELECT state FROM perception_jobs WHERE capture_id=? AND kind=?').get(row.capture_id,name);return dependency?.state==='succeeded'||stage.optionalDependencies?.includes(name)&&['blocked','failed','cancelled'].includes(String(dependency?.state));})){db.prepare("UPDATE perception_jobs SET state='blocked',error='dependency_failed' WHERE capture_id=? AND kind=?").run(row.capture_id,stage.name);continue;}
     const fingerprint=this.fingerprint(row,stage),input={captureId:row.capture_id,hash:row.hash,name:stage.name,generation:row.generation,fingerprint,adapterVersion:this.inputs.get(row.adapter)?.version??'',stage:stage.stage};
     linkOperationParent(this.store,(row.adapter==='mote.file-image'?'file:':'capture:')+row.capture_id,'image:'+row.capture_id);
     const stepId=this.engine.enqueue('image:'+row.capture_id,'images.'+stage.kind,input,{generation:{slot:stage.name,version:sha256(JSON.stringify([row.generation,fingerprint]))}}),step=this.engine.get(stepId)!;
     if(['blocked','stale','cancelled'].includes(step.state)&&!this.admit(step))this.engine.retry(stepId,false);
     ids.push(stepId);
    }
    this.projectFile(row);
   }catch{db.prepare("INSERT INTO perception_jobs(capture_id,kind,state,created_at,error) VALUES(?,'ocr','blocked',?,'processor_unavailable') ON CONFLICT(capture_id,kind) DO UPDATE SET state='blocked',error='processor_unavailable'").run(row.capture_id,Date.now());this.projectFile(row);}
  }
  return ids;
 }
 async tick(){await this.attachments.prepare();await this.refreshWorker();for(let i=0;i<32;i++){const ids=this.prepare();if(!ids.length)break;const before=ids.map(id=>this.engine.get(id)?.state);await this.engine.drain(ids);if(ids.every((id,index)=>this.engine.get(id)?.state===before[index]))break;}}
 private async execute(step:ExecutionStep,signal:AbortSignal){
  const row=this.row(String(step.input.captureId))!,original=this.original(row)!;
  const cached=row.reuse_allowed?this.store.db.prepare('SELECT json,id,capture_id FROM image_products WHERE fingerprint=? AND current=1 LIMIT 1').get(String(step.input.fingerprint)):undefined;
  if(cached)return {...JSON.parse(String(cached.json)),reuse:{productId:cached.id,captureId:cached.capture_id}};
  const plan=this.recipe(row),stage=this.processing.runtime.imageRecipes.get(step.input.stage as {id:string;version:string}),rawRecord=this.store.evidence([row.capture_id])[0];
  const record={...rawRecord,attributionContext:this.materials()?.contextForEvidence(rawRecord)??unknownAttributionContext()};
  const dependencies=Object.fromEntries(plan.steps.find(s=>s.name===step.input.name)!.dependsOn.map(name=>[name,this.product(row.capture_id,name)?JSON.parse(String(this.product(row.capture_id,name)!.json)).payload:undefined]));
  const readImage=async(input:Omit<import('@mote/shared').ImageReadInput,'id'>)=>{signal.throwIfAborted();const bytes:Buffer[]=[];for await(const part of original.read())bytes.push(part);return imageOutput(Buffer.concat(bytes),original.mimeType,{...input,id:row.capture_id},()=>this.valid(step));};
  const payload=await stage.run({record,hash:original.hash,mimeType:original.mimeType,dependencies,signal,readImage,
   ocr:async()=>{const processor=this.processing.runtime.registry.get(plan.binding.applied.profile.processorId);const raw=await this.processing.runImageProcessor(row.capture_id,'image-product:'+String(step.input.fingerprint),signal,()=>processor.process({file:{id:record.id,title:record.windowTitle||record.appName||'Image',mimeType:original.mimeType,sizeBytes:original.sizeBytes},parameters:plan.binding.applied.profile.parameters,settings:plan.binding.settings,maxAudioMs:0,signal,readOriginal:()=>original.read()}));return processor.output?this.processing.runtime.outputs.decode(processor.output,raw).transcript:transcriptSchema.parse(raw);},
   understand:async()=>{if(!this.options.understanding)throw new ExecutionFailure('blocked','model_unconfigured');return this.options.understanding.run({record,original,ocr:dependencies.ocr as Transcript|undefined,signal,readImage:input=>readImage(input),operationId:step.operationId,service:plan.binding.settings.analysisModel});},
  });
  if(stage.kind==='ocr'){const transcript=transcriptSchema.parse(payload);if(transcript.durationMs!==0||transcript.segments.map(s=>s.text).join('\n').length>100000)throw new StoreError('Invalid image OCR output',422);return {payload:transcript,kind:'ocr'};}
  const interpretation=imageInterpretationSchema.parse(payload),metadata=await readImage({view:'metadata'}),imageView=metadata.imageView!;
  if(interpretation.regions.some(r=>r.x+r.width>imageView.original.width||r.y+r.height>imageView.original.height))throw new StoreError('Image interpretation region is outside the original',422);
  return {payload:interpretation,kind:stage.kind,evidence:{ref:'capture:'+row.capture_id,revision:row.revision,original:imageView.original,coordinateSpace:imageView.coordinateSpace},model:stage.kind==='understanding'?this.options.understanding?.selection(plan.binding.settings.analysisModel).receipt:undefined};
 }
 private commit(step:ExecutionStep,raw:unknown){
  const row=this.row(String(step.input.captureId))!,result=raw as {payload:unknown;kind:string;[key:string]:unknown},db=this.store.db,id=randomUUID();
  // Reused products retain the computation receipt but bind to this independent
  // source observation. No context-sensitive product is shared by bytes alone.
  const json=JSON.stringify({...result,generatedAt:new Date().toISOString(),input:{captureId:row.capture_id,hash:row.hash,mimeType:row.mime,revision:row.revision}});
  this.store.reserveMetadata(Buffer.byteLength(json)+4096);
  db.prepare('UPDATE image_products SET current=0 WHERE capture_id=? AND name=?').run(row.capture_id,String(step.input.name));
  db.prepare('INSERT INTO image_products(id,capture_id,name,kind,fingerprint,json) VALUES(?,?,?,?,?,?)').run(id,row.capture_id,String(step.input.name),result.kind,String(step.input.fingerprint),json);
  if(result.kind==='ocr'){
   const transcript=transcriptSchema.parse(result.payload),text=transcript.segments.map(s=>s.text).join('\n');
   if(row.adapter==='mote.capture-image')this.store.savePerception(row.capture_id,'ocr',{id:randomUUID(),fingerprint:String(step.input.fingerprint),text,transcript,inputHash:row.hash,engine:this.binding(row).applied.profile.processorId,engineVersion:this.processing.runtime.registry.get(this.binding(row).applied.profile.processorId).version,configRevision:this.settings().providerRevision,generatedAt:new Date().toISOString()},false);
   else if(row.adapter==='mote.file-image'){
    db.prepare("UPDATE file_artifacts SET current=0 WHERE capture_id=? AND kind='image-text'").run(row.capture_id);
    const artifactId=randomUUID();db.prepare('INSERT INTO file_artifacts(id,capture_id,kind,created_at,config_revision,json,current) VALUES(?,?,?,?,?,?,1)').run(artifactId,row.capture_id,'image-text',new Date().toISOString(),String(step.input.fingerprint),JSON.stringify({transcript,complete:transcript.coverage!=='partial',coverage:transcript.coverage??'full',imageProductId:id,reuse:result.reuse,empty:transcript.segments.length===0}));
    writeFileTranscriptChunks(this.store,row.capture_id,artifactId,transcript,{kind:'image-text'});invalidateRetiredFileEvidence(this.store,row.capture_id);
    db.prepare('UPDATE file_jobs SET policy_json=?,config_revision=? WHERE capture_id=?').run(row.policy_json,String(step.input.fingerprint),row.capture_id);
    if(this.processing.files.detail(row.capture_id,false).item.layer==='snapshot'){this.processing.files.saveSnapshotText(row.capture_id,text);this.processing.files.publishSnapshotIndex(row.capture_id,text.length,text.length,this.binding(row).applied.profile.processorId,transcript.coverage==='partial',transcript.warnings);}
   }
  }
  this.store.invalidateConversationAnswers([row.capture_id]);
 }
 cancellation(id:string){return {canCancel:Boolean(this.store.db.prepare("SELECT 1 FROM perception_jobs WHERE capture_id=? AND state IN ('waiting','running','blocked','failed')").get(id)),wait:this.processing.imageProcessorWait(id)};}
 cancel(id:string,releaseInput=true){if(!this.owns(id))throw new StoreError('Image not found',404);for(const step of this.engine.list({operationId:'image:'+id,limit:100}).items)if(!['succeeded','stale','cancelled'].includes(step.state))this.engine.cancel(step.id);this.store.db.prepare("UPDATE perception_jobs SET state='cancelled',error='cancelled' WHERE capture_id=? AND state!='succeeded'").run(id);this.projectFile(this.row(id)!);if(releaseInput&&this.row(id)!.adapter==='mote.file-image')this.processing.files.releaseSnapshotInput(id);return {state:'cancelled'};}
 retry(id:string,recompute=true,confirmUnknown=false){
  const row=this.row(id);if(!row||!this.store.isCurrentEvidence(id))throw new StoreError('Image not found',404);
  const wait=this.processing.imageProcessorWait(id);if(wait==='running'||wait==='unknown'&&!confirmUnknown)throw new StoreError('Previous image processing has not finished or its completion is unknown',409);if(confirmUnknown)this.processing.clearImageProcessorWait(id);
  this.cancel(id,false);this.store.db.prepare('UPDATE image_inputs SET semantic_withdrawn=0 WHERE capture_id=?').run(id);this.store.db.prepare('UPDATE image_inputs SET auto_eligible=1,generation=generation+?,reuse_allowed=?,policy_json=NULL,understanding_enabled=? WHERE capture_id=?').run(Number(recompute),Number(!recompute),Number(this.settings().understandingEnabled),id);
  // Explicit completion grants a fresh budget to the unfinished current plan.
  // Successful OCR and superseded generations keep their existing receipts.
  if(!recompute)for(const pending of this.store.db.prepare("SELECT e.id FROM execution_steps e JOIN execution_operation_steps o ON o.step_id=e.id WHERE o.operation_id=? AND o.active=1 AND json_extract(e.input,'$.generation')=? AND e.state='cancelled'").all('image:'+id,row.generation))this.engine.retry(String(pending.id));
  this.store.db.prepare("UPDATE perception_jobs SET state='waiting',attempts=0,available_at=0,error=NULL,auto_eligible=1 WHERE capture_id=? AND (?=1 OR state!='succeeded')").run(id,Number(recompute));return {queued:true};
 }
 previewHistoricalOcr(raw:unknown={}){
  const query=historicalSchema.parse(raw),now=Date.now();for(const [token,entry] of this.previews)if(entry.expires<now)this.previews.delete(token);if(this.previews.size>=20)this.previews.delete(this.previews.keys().next().value!);
  const watermark=Number(this.store.db.prepare('SELECT coalesce(max(rowid),0) n FROM image_inputs').get()!.n),filter=this.historicalFilter(query),count=Number(this.store.db.prepare(`SELECT count(*) n FROM image_inputs i JOIN captures c ON c.id=i.capture_id WHERE i.rowid<=? ${filter.sql}`).get(watermark,...filter.values)!.n),token=randomUUID();
  this.previews.set(token,{query,watermark,expires:now+600000});return {token,count,bounded:false,mode:query.mode};
 }
 private historicalFilter(query:z.infer<typeof historicalSchema>){const values:(string|number)[]=[],clauses:string[]=[];if(query.after){clauses.push('c.captured_at>=?');values.push(query.after);}if(query.before){clauses.push('c.captured_at<?');values.push(query.before);}if(query.sourceId){clauses.push('i.source_id=?');values.push(query.sourceId);}if(query.mode==='complete')clauses.push("(i.auto_eligible=0 OR NOT EXISTS(SELECT 1 FROM perception_jobs j WHERE j.capture_id=i.capture_id) OR EXISTS(SELECT 1 FROM perception_jobs j WHERE j.capture_id=i.capture_id AND j.state!='succeeded'))");return {sql:clauses.length?'AND '+clauses.join(' AND '):'',values};}
 processHistoricalOcr(raw:unknown){const {token}=z.object({token:z.string().uuid()}).strict().parse(raw),preview=this.previews.get(token);if(!preview||preview.expires<Date.now())throw new StoreError('Image preview expired; refresh before processing',409);const id=randomUUID();this.store.reserveMetadata(Buffer.byteLength(JSON.stringify(preview.query))+512);this.store.db.prepare('INSERT INTO image_backfills(id,query,watermark) VALUES(?,?,?)').run(id,JSON.stringify(preview.query),preview.watermark);this.previews.delete(token);return {queued:true,jobId:id};}
 private backfillBatch(){
  for(const batch of this.store.db.prepare("SELECT * FROM image_backfills WHERE state='waiting' ORDER BY rowid LIMIT 1").all()){
   const query=historicalSchema.parse(JSON.parse(String(batch.query))),filter=this.historicalFilter(query),rows=this.store.db.prepare(`SELECT i.rowid position,i.capture_id FROM image_inputs i JOIN captures c ON c.id=i.capture_id WHERE i.rowid>? AND i.rowid<=? ${filter.sql} ORDER BY i.rowid LIMIT 200`).all(batch.cursor,batch.watermark,...filter.values),db=this.store.db;
   db.exec('BEGIN IMMEDIATE');try{let queued=0;for(const item of rows){if(!this.store.isCurrentEvidence(String(item.capture_id)))continue;try{this.retry(String(item.capture_id),query.mode==='recompute');queued++;}catch(error){if(!(error instanceof StoreError&&error.statusCode===409))throw error;db.prepare('UPDATE image_inputs SET auto_eligible=1 WHERE capture_id=?').run(item.capture_id);}}db.prepare('UPDATE image_backfills SET cursor=?,queued=queued+?,state=? WHERE id=?').run(rows.at(-1)?.position??batch.watermark,queued,rows.length<200?'succeeded':'waiting',batch.id);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
  }
 }
 async close(){if(this.closed)return;this.closed=true;this.store.imageReceived=undefined;this.processing.imageControl=undefined;await this.attachments.close();await Promise.all(this.unregister.splice(0).map(dispose=>dispose()));this.disposeInputs();await this.probe;}
}
