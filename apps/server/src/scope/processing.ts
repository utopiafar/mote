import {attachmentOriginalBinding,attachmentBinding} from './ingress-attachments.js';
import {fileOriginalGeneration} from './ingress-file-forget.js';
import {conversationRecords} from '../coding-dialogue-projection.js';
import {randomUUID} from 'node:crypto';
import {AgentTimeoutError,AgentResponseError,AgentConfigurationError} from '@mote/agent';
import type {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {transcriptSchema,diarizationSchema,fileProcessingSchema,sourceItemSchema,fileSpeakerAttributionSchema,fileDiarizationOptionsSchema,ProviderFailure,type TokenUsage} from '@mote/shared';
import {DOCUMENT_MIME_TYPES} from '@mote/shared/document-decoder';
import {FileProcessorRuntime,type ProcessorInput} from '../file-processors.js';
import {processorContract,processorSettingsFingerprint} from '../file-configuration.js';
import {isLoopback} from '../local-http.js';
import {defaultFileRecipe,defaultFileOutput,TRANSCRIPT_OUTPUT} from '../file-recipes.js';
import {alignDialogue} from '../file-dialogue.js';
import {formatWork} from '../format-work.js';
import {EXECUTION_POLICIES} from '../execution-policy.js';
import type {ExecutionStep} from '../execution-engine.js';
import {ExecutionFailure} from '../execution-engine.js';
import {StoreError} from '../execution-storage.js';
import {ScopeError} from './baseline.js';
import {PrivateSql,PrivateDataError,missing} from './private-data-sql.js';
import type {ScopedRuntime} from './http.js';
import type {UserContext} from './context.js';
import type {UserDataSubject,DomainLifecycle} from './lifecycle.js';
import type {Configurations} from './configuration.js';
import {TaskError,type TaskExecution,type TaskRun} from './task-execution.js';
import type {PrivateData} from './private-data.js';
import type {IngressHost} from './ingress.js';
import type {ScopedPluginHost} from './plugins.js';
import type {Original} from './originals.js';
import {identityHash} from './originals.js';
import {analyzeProcessing,evidenceId,analysisInputSchema,derivativeInputSchema,type AnalysisInput} from './processing-analysis.js';
import {processingInputSchema,processingSettingsSchema,defaultProcessingSettings,installProcessing,type ProcessingInput} from './processing-schema.js';
import {ProcessingPolicies} from './processing-policy.js';
import {policyPlanArchive,policyPlanArchiveSchema} from './processing-policy-archive.js';
import {importJobArchive} from './processing-import-archive.js';
import {validBase64} from '../base64.js';
import {processingReviews,processingReviewArchive} from './processing-reviews.js';
import {processingImports} from './processing-imports.js';
import type {ImportPythonPackConfig} from '../config.js';

export const PROCESSING_DOMAIN='processing';
const resultSchema=z.object({artifactId:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const failure=(error:unknown)=>error instanceof ExecutionFailure?error:error instanceof PrivateDataError&&error.code==='snapshot_input_expired'?new ExecutionFailure('blocked','snapshot_input_expired'):error instanceof AgentTimeoutError?new ExecutionFailure('transient','provider_timeout'):error instanceof AgentConfigurationError?new ExecutionFailure('blocked','processing_model_invalid'):error instanceof AgentResponseError||error instanceof SyntaxError||error instanceof z.ZodError?new ExecutionFailure('permanent','processing_output_invalid'):error instanceof ScopeError&&error.code==='scope_unavailable'?new ExecutionFailure('blocked','processing_model_unavailable'):error instanceof PrivateDataError||error instanceof ScopeError?new ExecutionFailure('stale','processing_input_changed'):error instanceof StoreError&&error.statusCode===409?new ExecutionFailure('blocked','processor_unavailable'):error instanceof StoreError&&[413,415,422].includes(error.statusCode)?new ExecutionFailure('permanent','unsupported_format'):new ExecutionFailure('permanent','processing_failed');
function sourceTranscript(item:z.infer<typeof sourceItemSchema>){const projected=item.document?.coding?conversationRecords([item]).map(record=>record.text).join(''):item.text,metadata=item.document?.originalMetadata??{},startMs=typeof metadata.startMs==='number'&&Number.isFinite(metadata.startMs)&&metadata.startMs>=0?metadata.startMs:0,endMs=typeof metadata.endMs==='number'&&Number.isFinite(metadata.endMs)&&metadata.endMs>=startMs?metadata.endMs:startMs,segments=[];for(let offset=0;offset<projected.length;){let end=Math.min(projected.length,offset+8000);if(end<projected.length&&/[\uD800-\uDBFF]/.test(projected[end-1]))end--;segments.push({startMs,endMs,text:projected.slice(offset,end),...(typeof metadata.speaker==='string'?{speaker:metadata.speaker.slice(0,100)}:{}),...(metadata.untimed===true?{untimed:true as const}:{}),...(typeof metadata.uncertain==='boolean'?{uncertain:metadata.uncertain}:{}),...(typeof metadata.overlap==='boolean'?{overlap:metadata.overlap}:{})});offset=end;}return {durationMs:endMs,segments,coverage:'full' as const,engine:'mote.source-original-v2'};}
type State={deleted:number;generation:number;settings:string};
const baseInput=(value:ProcessingInput)=>processingInputSchema.parse({policyPlanId:value.policyPlanId,originalRef:value.originalRef,generation:value.generation,originalGeneration:value.originalGeneration,attachmentGeneration:value.attachmentGeneration,fileGeneration:value.fileGeneration,diarizeFrom:value.diarizeFrom,settings:value.settings,plugin:value.plugin,parentTaskId:value.parentTaskId});
type Artifact={id:string;fingerprint:string;json:string;original_id:string};

/** The shared engine, Cordis processors/recipes and existing media transports
 * stay intact. Only this host can construct private inputs and publish them. */
export class ProcessingHost {
 readonly policies:ProcessingPolicies;
 readonly reviews:ReturnType<typeof processingReviews>;
 readonly importJobs:ReturnType<typeof processingImports>;
 readonly processors=new FileProcessorRuntime();
 private readonly unregister:Array<()=>void|Promise<void>>=[];
 private closed=false;
 private readonly active=new Set<string>();
 private readonly materialListeners=new Set<(run:TaskRun,material:Readonly<{id:string;revision:string}>)=>unknown>();
 /** Synchronous host-only handoff inside the same M05 success transaction. */
 onMaterialPublished(listener:(run:TaskRun,material:Readonly<{id:string;revision:string}>)=>unknown){if(this.closed)throw new ScopeError('invalid_identity',401);this.materialListeners.add(listener);return ()=>{this.materialListeners.delete(listener);};}
 private notifyMaterial(run:TaskRun,material:Readonly<{id:string;revision:string}>){for(const listener of this.materialListeners){run.grant.assert();const result=listener(run,Object.freeze({id:material.id,revision:material.revision}));if(result&&typeof (result as {then?:unknown}).then==='function'){void Promise.resolve(result).catch(()=>{});throw new ExecutionFailure('permanent','asynchronous_material_hook');}run.grant.assert();}}
 private readonly pluginStages=new WeakMap<TaskRun,{input:ProcessingInput;artifactId:string}>();
 constructor(private readonly runtime:ScopedRuntime,private readonly db:DatabaseSync,private readonly configuration:Configurations,private readonly execution:TaskExecution,private readonly ingress:IngressHost,private readonly plugins:ScopedPluginHost,sourcePacks:readonly ImportPythonPackConfig[]=[]){
  installProcessing(db);
  this.importJobs=processingImports(runtime,db,ingress,execution,this.processors.intake,(context,ref,operationId)=>{const {settings}=this.snapshot(context);return settings.enabled&&!settings.automatic&&!this.policies.bindPlan(context,ref)?.archiveOnly?this.submitSync(context,ref,operationId):undefined;},sourcePacks,(context,ref)=>this.forUser(context).status(ref));
  ingress.configureSnapshotRecovery({needed:(context,ref)=>{
   const sql=this.sql(context);if(this.state(sql).deleted||sql.get('SELECT id FROM mp_artifacts WHERE user_id=$user AND original_id=? AND complete=1 LIMIT 1',ref.slice(9)))return false;
   return sql.all('SELECT task_id FROM mp_admissions WHERE user_id=$user AND original_id=? AND task_id IS NOT NULL',ref.slice(9)).some(row=>{const task=execution.forUser(context).get(String(row.task_id));return task.state==='waiting'||task.state==='blocked'&&task.failure?.code==='snapshot_input_expired';});
  },restored:(context,ref)=>{
   const tasks=execution.forUser(context);for(const row of this.sql(context).all("SELECT u.task_id FROM user_tasks u JOIN execution_steps e ON e.id=u.task_id AND e.user_id=u.user_id WHERE u.user_id=$user AND e.user_id=$user AND json_extract(u.input,'$.originalRef')=? AND e.kind IN('processing.pipeline','processing.extract','processing.ocr','processing.asr') ORDER BY CASE e.kind WHEN 'processing.pipeline' THEN 1 ELSE 0 END",ref)){
    const task=tasks.get(String(row.task_id));if(task.state==='blocked'&&task.failure?.code==='snapshot_input_expired')tasks.retry(task.id);
   }
  }});
  configuration.registerDomain(PROCESSING_DOMAIN,subject=>({id:PROCESSING_DOMAIN,schema:processingSettingsSchema,defaultValue:defaultProcessingSettings(),resolve:raw=>raw,fields:Object.keys(defaultProcessingSettings()).map(path=>({path,effect:'next-request' as const})),prepare:next=>{
   const assert=()=>{'credentialId' in subject?runtime.authority.assert(subject):runtime.services.assertSubject(subject,'configuration',subject.purpose);},sql=new PrivateSql(db,subject.userId,assert),before=sql.get('SELECT * FROM mp_state WHERE user_id=$user') as State|undefined;
   const settings=JSON.stringify(processingSettingsSchema.parse(next));let published=false;
   return {apply:()=>{},publish:()=>sql.transaction(()=>{const current=sql.get('SELECT * FROM mp_state WHERE user_id=$user') as State|undefined;if(current?.settings!==settings){sql.run('INSERT INTO mp_state VALUES($user,0,?,?) ON CONFLICT(user_id) DO UPDATE SET generation=excluded.generation,settings=excluded.settings',(current?.generation??-1)+1,settings);published=true;}}),rollback:()=>{if(published){if(before)sql.run('UPDATE mp_state SET deleted=?,generation=?,settings=? WHERE user_id=$user',before.deleted,before.generation,before.settings);else sql.run('DELETE FROM mp_state WHERE user_id=$user');}},complete:()=>{if(published&&'credentialId' in subject)this.reconcilePolicies(subject);}};
  }}));
  this.policies=new ProcessingPolicies(runtime,db,configuration,this.processors,context=>this.fileSettings(this.sql(context),this.state(this.sql(context))),context=>this.reconcilePolicies(context));
  ingress.configureFileRetirement((context,refs)=>{for(const ref of refs)this.cancelFile(context,ref);});
  this.reviews=processingReviews(runtime,db,execution,{snapshot:(context,ref)=>this.fileTranscript(context,ref),read:(context,ref)=>{const input={originalRef:ref,...this.snapshot(context,ref)};if(!this.input(context,input,true).current)throw new PrivateDataError('conflict',409);},current:(userId,input)=>this.current(userId,input,true),io:(run,input,work)=>this.io(run,input,work,true),publish:(context,ref,artifactId,transcript,key)=>this.publishFileCorrection(context,ref,artifactId,transcript,key)});
  runtime.services.registerUser(PROCESSING_DOMAIN,{scope:'user',create:context=>this.forUser(context),lifecycle:this.lifecycle()});
  this.unregister.push(execution.register({kind:'processing.pipeline',pool:'processing.pipeline',concurrency:()=>4,policy:EXECUTION_POLICIES.orchestration,parseInput:value=>processingInputSchema.parse(value),authorizeInput:(context,input)=>{this.pipelineInput(context,processingInputSchema.parse(input));},validate:task=>this.current(task.ownership!.userId,task.input),admit:task=>processingInputSchema.parse(task.input).settings.enabled?undefined:new ExecutionFailure('blocked','processing_disabled'),execute:run=>this.pipeline(run),commit:(run,result)=>{this.publish(run,result);this.automaticDerivations(run,result);},classify:failure}));
  for(const kind of ['extract','ocr','asr'] as const)this.unregister.push(execution.register({kind:'processing.'+kind,pool:'processing.'+kind,concurrency:()=>2,policy:kind==='extract'?EXECUTION_POLICIES.deterministic:EXECUTION_POLICIES.localProcessing,...(kind==='extract'?{}:{modelFeature:kind,leaseModel:(context:UserContext,raw:Record<string,unknown>,operationId:string)=>this.policyModel(context,processingInputSchema.parse(raw),kind,operationId)}),parseInput:value=>processingInputSchema.parse(value),authorizeInput:(context,input)=>{const {original}=this.input(context,processingInputSchema.parse(input));if(this.kind(original)!==kind)throw new PrivateDataError('invalid_data');},prepareRetry:(context,task)=>this.prepareExtractionRetry(context,task),validate:task=>this.current(task.ownership!.userId,task.input),resources:input=>[{scope:'user',key:'processing:'+identityHash([input.originalRef,input.generation])}],execute:run=>this.extract(run,kind),commit:(run,value)=>{const input=processingInputSchema.parse(run.task.input),{sql,original,record}=this.input(run.context,input),result=resultSchema.parse(value);sql.run('UPDATE mp_artifacts SET complete=1 WHERE user_id=$user AND id=? AND original_id=?',result.artifactId,input.originalRef.slice(9));if(record.provenance?.layer==='snapshot'&&record.provenance?.document?.fileIndex&&!(input.settings.understandingEnabled&&original.mime.startsWith('image/')))this.ingress.forUser(run.context).releaseSnapshot(input.originalRef);},classify:failure}));
  this.unregister.push(execution.register({kind:'processing.derivatives',pool:'processing.derivatives',concurrency:()=>2,policy:EXECUTION_POLICIES.orchestration,parseInput:value=>derivativeInputSchema.parse(value),authorizeInput:(context,raw)=>this.analysisInput(context,derivativeInputSchema.parse(raw)),validate:task=>this.current(task.ownership!.userId,baseInput(task.input as ProcessingInput)),execute:async run=>{const input=derivativeInputSchema.parse(run.task.input),results=[];for(const mode of input.modes){this.analysisInput(run.context,input);const {modes,...base}=input,child=await execution.forUser(run.context).submit({kind:'processing.analysis',operationId:'derived:'+run.task.id+':'+mode,input:{...base,mode,parentTaskId:run.task.id}});run.checkpoint.write(mode,{taskId:child.id});results.push({mode,...await this.wait(run,child.id,()=>this.analysisInput(run.context,input))});}return {results};},classify:failure}));
  this.unregister.push(execution.register({kind:'processing.analysis',pool:'processing.analysis',concurrency:()=>2,policy:EXECUTION_POLICIES.modelCall,modelFeature:'file',leaseModel:(context,raw,operationId)=>this.policyModel(context,processingInputSchema.parse(baseInput(raw as ProcessingInput)),'file',operationId),parseInput:value=>analysisInputSchema.parse(value),authorizeInput:(context,raw)=>this.analysisInput(context,analysisInputSchema.parse(raw)),validate:task=>this.current(task.ownership!.userId,baseInput(task.input as ProcessingInput)),resources:input=>[{scope:'user',key:'processing:'+identityHash([input.originalRef,input.generation])}],execute:run=>this.analysis(run),commit:(run,value)=>{const input=analysisInputSchema.parse(run.task.input),{sql}=this.analysisInput(run.context,input),result=resultSchema.parse(value);sql.run('UPDATE mp_artifacts SET complete=1 WHERE user_id=$user AND id=?',result.artifactId);this.publish(run,value,baseInput(input),input);},classify:failure}));
  this.unregister.push(plugins.registerAdapter('processor',{
   bind:invocation=>{
    const source=ingress.bindSource(invocation.context,invocation.sourceIds,invocation.assertCurrent);
    return Object.freeze({readOriginal:source.readOriginal,pageOriginals:source.pageOriginals,stageExtraction:async(ref:string,value:unknown)=>{
     invocation.assertCurrent();source.readOriginal(ref,{length:0});const input=processingInputSchema.parse({originalRef:ref,...this.snapshot(invocation.context,ref),plugin:{snapshotId:invocation.snapshotId,parentTaskId:invocation.run.task.id}}),{original}=this.input(invocation.context,input);
     const decoded=this.processors.outputs.decode(TRANSCRIPT_OUTPUT,value).transcript;const result=await this.stage(invocation.run,input,original,identityHash(['plugin',invocation.packageId,invocation.component,invocation.configuration,invocation.run.task.input]),async()=>decoded,result=>transcriptSchema.parse(result));invocation.assertCurrent();this.pluginStages.set(invocation.run,{input,artifactId:result.artifactId});return {artifactId:result.artifactId};
    },processOriginal:async(ref:string)=>{
     invocation.assertCurrent();source.readOriginal(ref,{length:0});
     const task=await this.submit(invocation.context,ref,'plugin:'+invocation.run.task.id+':'+ref,{snapshotId:invocation.snapshotId,parentTaskId:invocation.run.task.id});
     return this.wait(invocation.run,task.id,invocation.assertCurrent);
    }});
   },validateResult:(value,invocation)=>{const result=resultSchema.parse(value),pending=this.pluginStages.get(invocation.run);if(pending&&pending.artifactId!==result.artifactId)throw new PrivateDataError('invalid_data');const ref=this.artifact(invocation.context,result.artifactId).originalRef,input=processingInputSchema.parse({originalRef:ref,...this.snapshot(invocation.context,ref),plugin:{snapshotId:invocation.snapshotId,parentTaskId:invocation.run.task.id}});this.input(invocation.context,pending?.input??input);return result;},commit:(value,invocation)=>{const pending=this.pluginStages.get(invocation.run);if(!pending)return;const {sql}=this.input(invocation.context,pending.input);sql.run('UPDATE mp_artifacts SET complete=1 WHERE user_id=$user AND id=?',pending.artifactId);this.publish(invocation.run,value,pending.input);},
  }));
  this.unregister.push(ingress.onAccepted((context,receipt,format,formats)=>{
   if(this.state(this.sql(context)).deleted)return;
   for(const item of receipt.captures)if(item.original)this.sql(context).run('INSERT INTO mp_original_formats VALUES($user,?,?) ON CONFLICT(user_id,original_id) DO NOTHING',item.original.ref.slice(9),formats[item.original.ref]??format);
   if(!this.state(this.sql(context)).deleted&&JSON.parse(this.state(this.sql(context)).settings).automatic)for(const item of receipt.captures)if(item.original&&!this.fileControl(context,item.original.ref).cancelled&&!((formats[item.original.ref]??format)==='source-item'&&this.sql(context).get("SELECT id FROM pd_captures WHERE user_id=$user AND id=? AND json_array_length(json,'$.provenance.document.attachments')>0 AND json_type(json,'$.provenance.document.attachmentOf') IS NULL",item.id))){
    // A no-model M05 coordinator is admitted synchronously inside the intake
    // transaction. It retains account authority after the request goes away.
    if(this.policies.bindPlan(context,item.original.ref)?.archiveOnly)continue;void this.submit(context,item.original.ref,'intake:'+receipt.id+':'+item.original.ref).catch(()=>{/* Durable admission state reports the failure. */});
   }
  }));
 }
 async ready(){await this.processors.ready;}
 private sql(context:UserContext){return new PrivateSql(this.db,context.userId,()=>{if(this.closed)throw new ScopeError('invalid_identity',401);this.runtime.authority.assert(context);});}
 private state(sql:PrivateSql):State{let row=sql.get('SELECT * FROM mp_state WHERE user_id=$user') as State|undefined;if(!row){sql.run('INSERT INTO mp_state VALUES($user,0,0,?)',JSON.stringify(defaultProcessingSettings()));row=sql.get('SELECT * FROM mp_state WHERE user_id=$user') as State;}return row;}
 private fileControl(context:UserContext,ref:string){const row=this.sql(context).get('SELECT generation,cancelled FROM mp_file_controls WHERE user_id=$user AND original_id=?',ref.slice(9));return {generation:Number(row?.generation??0),cancelled:!!row?.cancelled};}
 private fileSettings(sql:PrivateSql,state:State,ref?:string){const base=processingSettingsSchema.parse(JSON.parse(state.settings)),plan=ref?sql.get('SELECT p.json FROM mp_file_policy_bindings b JOIN mp_file_plans p ON p.user_id=b.user_id AND p.id=b.plan_id WHERE b.user_id=$user AND p.user_id=$user AND b.original_id=?',ref.slice(9)):undefined,saved=this.policies?this.policies.effective(base,plan?JSON.parse(String(plan.json)):undefined):base,row=ref?sql.get('SELECT json FROM mp_file_diarization WHERE user_id=$user AND original_id=?',ref.slice(9)):undefined;if(!row)return saved;const options=fileDiarizationOptionsSchema.parse(JSON.parse(String(row.json)));return processingSettingsSchema.parse({...saved,diarizationProcessor:options.processor,speakerCount:options.speakerCount,speakerMin:options.range?.min??null,speakerMax:options.range?.max??null});}
 private snapshot(context:UserContext,ref?:string){const sql=this.sql(context),state=this.state(sql);if(state.deleted)throw new ScopeError('invalid_identity',401);return {generation:state.generation,policyPlanId:ref?this.policies.current(context,ref)?.id:undefined,attachmentGeneration:ref?attachmentOriginalBinding(sql,ref)?.id:undefined,originalGeneration:ref?fileOriginalGeneration(sql,ref):0,fileGeneration:ref?this.fileControl(context,ref).generation:0,settings:this.fileSettings(sql,state,ref)};}
 private parent(sql:PrivateSql,id:string,completed=false){const row=sql.get('SELECT state FROM execution_steps WHERE user_id=$user AND id=?',id);if(!row||![...['waiting','running'],...(completed?['succeeded']:[])].includes(String(row.state)))throw new ScopeError('invalid_identity',401);}
 private prepareExtractionRetry(context:UserContext,task:ExecutionStep){
  const input=processingInputSchema.parse(task.input);if(!input.parentTaskId)return;const sql=this.sql(context);
  const parent=sql.get('SELECT e.kind,e.state,u.input,u.checkpoints FROM user_tasks u JOIN execution_steps e ON e.id=u.task_id AND e.user_id=u.user_id WHERE u.user_id=$user AND e.user_id=$user AND u.task_id=?',input.parentTaskId);
  if(!parent||!['waiting','running','blocked'].includes(String(parent.state)))throw new TaskError('task_retry_invalid',409);
  if(parent.state==='blocked'){
   const parentInput=processingInputSchema.parse(JSON.parse(String(parent.input))),checkpoint=JSON.parse(String(parent.checkpoints)).extraction;
   if(parent.kind!=='processing.pipeline'||checkpoint?.taskId!==task.id||identityHash(processingInputSchema.parse({...parentInput,parentTaskId:input.parentTaskId}))!==identityHash(input))throw new TaskError('task_retry_invalid',409);
   // Restore only the original coordinator and its original durable grant.
   // Source/configuration/plugin checks run before and after this nested retry;
   // M05 rolls it back with the child's acknowledgement if any check fails.
   this.input(context,parentInput);this.execution.forUser(context).retry(input.parentTaskId);
  }
  const {original}=this.input(context,input);if('processing.'+this.kind(original)!==task.kind)throw new TaskError('task_retry_invalid',409);
 }
 private input(context:UserContext,input:ProcessingInput,allowInactive=false){
  const sql=this.sql(context),state=this.state(sql),control=this.fileControl(context,input.originalRef);if(this.policies.current(context,input.originalRef)?.id!==input.policyPlanId||attachmentOriginalBinding(sql,input.originalRef)?.id!==input.attachmentGeneration||fileOriginalGeneration(sql,input.originalRef)!==(input.originalGeneration??0)||control.generation!==(input.fileGeneration??0)||control.cancelled&&!allowInactive)throw new ScopeError('invalid_identity',401);if(state.deleted||state.generation!==input.generation||identityHash(this.fileSettings(sql,state,input.originalRef))!==identityHash(input.settings)||!input.settings.enabled&&!allowInactive)throw new ScopeError('invalid_identity',401);
  if(input.diarizeFrom&&!sql.get("SELECT artifact_id FROM mp_file_steps WHERE user_id=$user AND original_id=? AND stage='extract' AND artifact_id=? AND generation<=?",input.originalRef.slice(9),input.diarizeFrom,input.fileGeneration??0))throw new ScopeError('invalid_identity',401);
  if(input.parentTaskId)this.parent(sql,input.parentTaskId);
  const plugin=input.plugin?this.plugins.domainGrant(context,input.plugin.snapshotId,'processor'):undefined;
  if(input.plugin)this.parent(sql,input.plugin.parentTaskId,true);
  const source=plugin?this.ingress.bindSource(context,plugin.sourceIds,plugin.assertCurrent):this.ingress.forUser(context),metadata=source.readOriginal(input.originalRef,{length:0}),original:Original={ref:metadata.ref,sourceId:metadata.sourceId,captureId:metadata.captureId,hash:metadata.hash,bytes:metadata.totalBytes,mime:metadata.mime,retention:metadata.retention,available:metadata.available};
  const capture=sql.get('SELECT json FROM pd_captures WHERE user_id=$user AND id=?',original.captureId);if(!capture)throw missing();
  const record=JSON.parse(String(capture.json));let current=true;if(record.provenance){const head=sql.get('SELECT capture_id FROM pd_source_heads WHERE user_id=$user AND source_id=? AND external_id=?',record.provenance.sourceId,record.provenance.externalId);current=!record.provenance.deleted&&head?.capture_id===original.captureId;if(!current&&!allowInactive)throw new ScopeError('invalid_identity',401);}
  return {sql,source,original,record,current,format:String(sql.get('SELECT format FROM mp_original_formats WHERE user_id=$user AND original_id=?',original.ref.slice(9))?.format??'file')};
 }
 private current(userId:string,raw:Record<string,unknown>,allowCancelled=false){try{const input=processingInputSchema.parse(raw),sql=new PrivateSql(this.db,userId,()=>{}),state=this.state(sql);const control=sql.get('SELECT generation,cancelled FROM mp_file_controls WHERE user_id=$user AND original_id=?',input.originalRef.slice(9));if(state.deleted||state.generation!==input.generation||sql.get('SELECT plan_id FROM mp_file_policy_bindings WHERE user_id=$user AND original_id=?',input.originalRef.slice(9))?.plan_id!==input.policyPlanId||attachmentOriginalBinding(sql,input.originalRef)?.id!==input.attachmentGeneration||fileOriginalGeneration(sql,input.originalRef)!==(input.originalGeneration??0)||Number(control?.generation??0)!==(input.fileGeneration??0)||control?.cancelled&&!allowCancelled)return false;if(input.parentTaskId)this.parent(sql,input.parentTaskId);if(input.plugin)this.parent(sql,input.plugin.parentTaskId,true);return true;}catch{return false;}}
 private kind(original:Pick<Original,'mime'>){return original.mime.startsWith('image/')?'ocr':original.mime.startsWith('audio/')?'asr':'extract';}
 private physicalState(context:UserContext,originalRef:string,exceptTask=''){
  const calls=this.sql(context).all("SELECT a.id,NOT EXISTS(SELECT 1 FROM task_external_retry_confirmations r WHERE r.user_id=c.user_id AND r.issuance_id=c.issuance_id) unacknowledged FROM task_external_calls c JOIN user_tasks u ON u.task_id=c.task_id AND u.user_id=c.user_id JOIN execution_steps e ON e.id=u.task_id AND e.user_id=u.user_id LEFT JOIN mp_activity a ON a.user_id=c.user_id AND c.request_key='processing:'||c.task_id||':'||a.id WHERE c.user_id=$user AND u.user_id=$user AND e.user_id=$user AND e.kind IN ('processing.extract','processing.ocr','processing.asr','processing.analysis','processing.review') AND c.task_id<>? AND c.state IN ('issued','unknown') AND json_extract(u.input,'$.originalRef')=?",exceptTask,originalRef);
  const live=(row:Record<string,unknown>)=>Boolean(row.id&&this.active.has(identityHash([context.userId,row.id])));return {live:calls.some(live),unknown:calls.some(row=>row.unacknowledged&&!live(row))};
 }
 private blockedCall(context:UserContext,ref:string,exceptTask=''){const state=this.physicalState(context,ref,exceptTask);return state.live||state.unknown;}

 private pipelineInput(context:UserContext,input:ProcessingInput){
  if(input.settings.enabled)return this.input(context,input);
  // Disabled automatic work retains a genuine blocked M05 coordinator. It can
  // be cancelled, but cannot run a child, borrow an old grant or ignore a head.
  const bound=this.input(context,input,true);if(!bound.current||this.fileControl(context,input.originalRef).cancelled)throw new ScopeError('invalid_identity',401);return bound;
 }

 private submitSync(context:UserContext,originalRef:string,operationId:string,plugin?:ProcessingInput['plugin'],diarizeFrom?:string,deferPhysical=false){
  this.pipelineInput(context,processingInputSchema.parse({originalRef,...this.snapshot(context,originalRef),...(plugin?{plugin}:{})}));
  if(!plugin&&this.policies.bindPlan(context,originalRef)?.archiveOnly)throw new TaskError('file_processing_archive_only',409);
  const input=processingInputSchema.parse({originalRef,...this.snapshot(context,originalRef),...(plugin?{plugin}:{}),...(diarizeFrom?{diarizeFrom}:{})});this.pipelineInput(context,input);
  const sql=this.sql(context),journal=new PrivateSql(this.db,context.userId,()=>{});if(!sql.get('SELECT task_id FROM mp_admissions WHERE user_id=$user AND original_id=? AND request_key=? AND task_id IS NOT NULL',originalRef.slice(9),operationId)&&!deferPhysical&&this.blockedCall(context,originalRef))throw new TaskError('external_result_unknown',409);sql.run("INSERT INTO mp_admissions VALUES($user,?,?,NULL,'pending') ON CONFLICT(user_id,original_id,request_key) DO UPDATE SET state='pending'",originalRef.slice(9),operationId);
  try{const task=this.execution.forUser(context).submitSync({kind:'processing.pipeline',operationId,input});journal.run("UPDATE mp_admissions SET task_id=?,state='admitted' WHERE user_id=$user AND original_id=? AND request_key=?",task.id,originalRef.slice(9),operationId);return task;}catch(error){journal.run("UPDATE mp_admissions SET state='failed' WHERE user_id=$user AND original_id=? AND request_key=?",originalRef.slice(9),operationId);throw error;}
 }
 private async submit(context:UserContext,originalRef:string,operationId:string,plugin?:ProcessingInput['plugin']){return this.submitSync(context,originalRef,operationId,plugin);}
 forUser(context:UserContext){this.runtime.authority.assert(context);return Object.freeze({
  submit:async(value:unknown)=>{const input=z.object({originalRef:z.string(),operationId:z.string().min(1).max(256)}).strict().parse(value);await this.configuration.forUser(context).view();if(this.fileControl(context,input.originalRef).cancelled)throw new TaskError('file_processing_cancelled',409);this.input(context,processingInputSchema.parse({originalRef:input.originalRef,...this.snapshot(context,input.originalRef)}));const plan=this.policies.bindPlan(context,input.originalRef);if(plan?.archiveOnly)return {saved:true,processingRequired:false};return this.submit(context,input.originalRef,input.operationId);},
  view:async()=>{await this.configuration.forUser(context).view();return {settings:this.snapshot(context).settings,processors:this.processors.registry.list(),...this.processors.recipes.list(),outputs:this.processors.outputs.list()};},
  derive:async(value:unknown)=>{const input=z.object({originalRef:z.string(),operationId:z.string().min(1).max(256),modes:z.array(z.enum(['summary','turns','image'])).min(1).max(3)}).strict().parse(value);await this.configuration.forUser(context).view();return this.submitDerivatives(context,input.originalRef,input.operationId,input.modes);},
  status:(ref:string)=>{const {sql,original,current}=this.input(context,{originalRef:ref,...this.snapshot(context,ref)},true),row=sql.get('SELECT p.*,h.revision AS current_revision,h.sequence,h.min_visible_sequence FROM mp_publications p JOIN pd_materials h ON h.user_id=p.user_id AND h.id=p.material_id WHERE p.user_id=$user AND h.user_id=$user AND p.original_id=? AND h.sequence>=h.min_visible_sequence',ref.slice(9)),processed=sql.get('SELECT id FROM mp_artifacts WHERE user_id=$user AND original_id=? AND complete=1 LIMIT 1',ref.slice(9));return {original,current,saved:true,processingRequired:!this.policies.current(context,ref)?.archiveOnly,appliedPolicy:this.policies.current(context,ref),processed:!!processed,indexed:!!row,...(row?{artifactId:String(row.artifact_id),materialId:String(row.material_id),revision:String(row.current_revision)}:{}),index:{material:!!row,memory:false},derivations:sql.all('SELECT d.kind,d.artifact_id AS artifactId,d.material_id AS materialId,h.revision FROM mp_derivations d JOIN pd_materials h ON h.user_id=d.user_id AND h.id=d.material_id WHERE d.user_id=$user AND h.user_id=$user AND d.original_id=? AND h.sequence>=h.min_visible_sequence ORDER BY d.kind',ref.slice(9))};},
  artifact:(id:string)=>this.artifact(context,id),
  fileStageIds:(ref:string)=>this.fileStageIds(context,ref),
  rawFileArtifact:(ref:string)=>this.rawFileArtifact(context,ref),
  fileDiarization:(ref:string)=>this.fileDiarization(context,ref),
  fileAsset:(ref:string,artifactId:string,name:string)=>this.fileAsset(context,ref,artifactId,name),
  reviewFile:(ref:string,value:unknown)=>this.reviews.forUser(context).propose(ref,value),
  fileCalendar:(ref:string)=>this.reviews.forUser(context).calendar(ref),
  fileReviews:(ref:string)=>this.reviews.forUser(context).list(ref),
  confirmFileReview:(ref:string,id:string,value:unknown)=>this.reviews.forUser(context).confirm(ref,id,value),
  cancellation:(ref:string)=>this.cancellation(context,ref),
  cancelFile:(ref:string)=>this.cancelFile(context,ref),
  retryFile:(ref:string,value:unknown)=>this.retryFile(context,ref,value),
  correctFile:(ref:string,value:unknown)=>this.correctFile(context,ref,value),
  nameFileSpeakers:(ref:string,value:unknown)=>this.nameFileSpeakers(context,ref,value),
  fileSpeakerNames:(ref:string,artifactId:string)=>this.fileSpeakerNames(context,ref,artifactId),
  originalFileArtifact:(ref:string,artifactId:string)=>this.originalFileArtifact(context,ref,artifactId),
 });}
 private cancellation(context:UserContext,ref:string){
  const sql=this.sql(context),control=this.fileControl(context,ref);this.input(context,{originalRef:ref,...this.snapshot(context,ref)},true);
  const work=sql.all("SELECT e.state FROM user_tasks u JOIN execution_steps e ON e.user_id=u.user_id AND e.id=u.task_id WHERE u.user_id=$user AND e.user_id=$user AND e.kind LIKE 'processing.%' AND json_extract(u.input,'$.originalRef')=?",ref);
  const calls=sql.all("SELECT a.id,NOT EXISTS(SELECT 1 FROM task_external_retry_confirmations r WHERE r.user_id=c.user_id AND r.issuance_id=c.issuance_id) unacknowledged FROM task_external_calls c JOIN user_tasks u ON u.task_id=c.task_id AND u.user_id=c.user_id LEFT JOIN mp_activity a ON a.user_id=c.user_id AND c.request_key='processing:'||c.task_id||':'||a.id WHERE c.user_id=$user AND u.user_id=$user AND json_extract(u.input,'$.originalRef')=? AND c.state IN ('issued','unknown')",ref);
  const live=calls.some(row=>row.id&&this.active.has(identityHash([context.userId,row.id])));
  return {canCancel:work.some(row=>['waiting','running','blocked','failed'].includes(String(row.state))),wait:live?'running' as const:calls.some(row=>row.unacknowledged)?'unknown' as const:null};
 }
 private cancelFile(context:UserContext,ref:string){
  const sql=this.sql(context);return sql.transaction(()=>{const before=this.cancellation(context,ref);if(!before.canCancel)return {state:this.fileControl(context,ref).cancelled?'cancelled':'completed',...before};
   const previous=this.fileControl(context,ref);if(previous.generation>=Number.MAX_SAFE_INTEGER)throw new PrivateDataError('conflict',409);
   for(const row of sql.all("SELECT e.id,e.state FROM user_tasks u JOIN execution_steps e ON e.user_id=u.user_id AND e.id=u.task_id WHERE u.user_id=$user AND e.user_id=$user AND e.kind LIKE 'processing.%' AND json_extract(u.input,'$.originalRef')=?",ref))if(!['succeeded','cancelled','stale'].includes(String(row.state)))this.execution.forUser(context).cancel(String(row.id));
   sql.run('INSERT INTO mp_file_controls VALUES($user,?,?,1) ON CONFLICT(user_id,original_id) DO UPDATE SET generation=excluded.generation,cancelled=1',ref.slice(9),previous.generation+1);
   return {state:'cancelled',...this.cancellation(context,ref)};
  });
 }
 private fileStageIds(context:UserContext,ref:string){
  const {sql}=this.input(context,{originalRef:ref,...this.snapshot(context,ref)},true),row=sql.get("SELECT r.artifact_id raw,d.artifact_id diarization FROM mp_file_steps r LEFT JOIN mp_file_steps d ON d.user_id=r.user_id AND d.original_id=r.original_id AND d.generation=r.generation AND d.stage='diarize' WHERE r.user_id=$user AND r.original_id=? AND r.stage='extract' ORDER BY r.generation DESC LIMIT 1",ref.slice(9));return {raw:row?String(row.raw):undefined,diarization:row?.diarization?String(row.diarization):undefined};
 }
 private rawFileArtifact(context:UserContext,ref:string){const id=this.fileStageIds(context,ref).raw;return id?this.artifact(context,id):undefined;}
 private fileDiarization(context:UserContext,ref:string){
  const id=this.fileStageIds(context,ref).diarization;if(!id)return;const artifact=this.artifact(context,id),{samples,...data}=diarizationSchema.parse(artifact.payload);return {id:artifact.id,...data,samples:samples.map(({wavBase64,...sample})=>sample)};
 }
 private fileAsset(context:UserContext,ref:string,artifactId:string,name:string){
  if(!/^speaker_samples\/SPEAKER_[0-9]{1,5}\.wav$/.test(name)||this.fileStageIds(context,ref).diarization!==artifactId)throw missing();
  const payload=diarizationSchema.parse(this.artifact(context,artifactId).payload),sample=payload.samples.find(sample=>'speaker_samples/'+sample.speaker+'.wav'===name);if(!sample)throw missing();return this.sampleBytes(sample.wavBase64);
 }
 private sampleBytes(value:string){const bytes=Buffer.from(value,'base64');if(!validBase64(value)||bytes.length>768*1024||bytes.subarray(0,4).toString()!=='RIFF'||bytes.subarray(8,12).toString()!=='WAVE')throw new ExecutionFailure('permanent','processing_sample_invalid');return bytes;}
 private async retryFile(context:UserContext,ref:string,value:unknown){
  await this.configuration.forUser(context).view();return this.retryFileSync(context,ref,value);
 }
 private retryFileSync(context:UserContext,ref:string,value:unknown){
  const request=z.object({operationId:z.string().min(1).max(128),stage:z.enum(['transcribe','diarize','summary']).default('transcribe'),confirmUnknown:z.boolean().default(false),diarization:z.object({artifactId:z.string().regex(/^[a-f0-9]{64}$/),options:fileDiarizationOptionsSchema.nullable()}).strict().optional()}).strict().parse(value);
  const sql=this.sql(context),digest=identityHash(request);return sql.transaction(()=>{
   this.input(context,{originalRef:ref,...this.snapshot(context,ref)},true);const prior=sql.get('SELECT digest,task_id FROM mp_file_retries WHERE user_id=$user AND original_id=? AND operation_id=?',ref.slice(9),request.operationId);
   if(prior){if(prior.digest!==digest)throw new PrivateDataError('conflict',409);this.execution.forUser(context).get(String(prior.task_id));return {queued:true,taskId:String(prior.task_id)};}
   const before=this.cancellation(context,ref);if(before.wait==='running'||sql.get("SELECT e.id FROM execution_steps e JOIN user_tasks u ON u.user_id=e.user_id AND u.task_id=e.id WHERE u.user_id=$user AND e.user_id=$user AND e.kind LIKE 'processing.%' AND e.state='running' AND json_extract(u.input,'$.originalRef')=? LIMIT 1",ref))throw new TaskError('file_processing_active',409);
   if(before.wait==='unknown'&&!request.confirmUnknown)throw new TaskError('external_result_unknown',409);
   const previous=this.fileControl(context,ref);if(previous.generation>=Number.MAX_SAFE_INTEGER)throw new PrivateDataError('conflict',409);
   const raw=request.stage==='diarize'?this.rawFileArtifact(context,ref):undefined;
   if(request.stage==='diarize'&&(!raw||!this.ingress.forUser(context).readOriginal(ref,{length:0}).mime.startsWith('audio/')))throw new PrivateDataError('conflict',409);
   if(request.diarization){if(request.stage!=='diarize'||request.diarization.artifactId!==raw?.id)throw new PrivateDataError('conflict',409);const options=request.diarization.options;if(options?.processor==='audio.diarize'&&options.range)throw new PrivateDataError('invalid_data');if(options)sql.run('INSERT INTO mp_file_diarization VALUES($user,?,?) ON CONFLICT(user_id,original_id) DO UPDATE SET json=excluded.json',ref.slice(9),JSON.stringify(options));else sql.run('DELETE FROM mp_file_diarization WHERE user_id=$user AND original_id=?',ref.slice(9));}
   for(const row of sql.all("SELECT e.id,e.state FROM user_tasks u JOIN execution_steps e ON e.user_id=u.user_id AND e.id=u.task_id WHERE u.user_id=$user AND e.user_id=$user AND e.kind LIKE 'processing.%' AND json_extract(u.input,'$.originalRef')=?",ref)){
    if(request.confirmUnknown)this.execution.acknowledgeExternalReplay(context,String(row.id));
    if(!['succeeded','cancelled','stale'].includes(String(row.state)))this.execution.forUser(context).cancel(String(row.id));
   }
   sql.run('INSERT INTO mp_file_controls VALUES($user,?,?,0) ON CONFLICT(user_id,original_id) DO UPDATE SET generation=excluded.generation,cancelled=0',ref.slice(9),previous.generation+1);
   const operation='file-retry:'+identityHash([ref,request.operationId]),task=request.stage==='summary'?this.submitDerivativesSync(context,ref,operation,['summary']):this.submitSync(context,ref,operation,undefined,raw?.id);
   sql.run('INSERT INTO mp_file_retries VALUES($user,?,?,?,?)',ref.slice(9),request.operationId,digest,task.id);sql.run("INSERT INTO mp_admissions VALUES($user,?,?,?,'admitted') ON CONFLICT(user_id,original_id,request_key) DO NOTHING",ref.slice(9),operation,task.id);
   return {queued:true,taskId:task.id};
  });
 }
 reprocessPolicies(context:UserContext,token:string,refs:readonly string[],assertPreview:()=>void){
  return this.sql(context).transaction(()=>{assertPreview();for(const ref of refs){this.policies.bindPlan(context,ref,true);this.retryFileSync(context,ref,{operationId:'policy-reprocess:'+token,stage:'transcribe',confirmUnknown:true});}return {queued:refs.length};});
 }
 private fileTranscript(context:UserContext,ref:string){
  const input=processingInputSchema.parse({originalRef:ref,...this.snapshot(context,ref)}),bound=this.input(context,input,true),{sql}=bound;
  if(!bound.current)throw new PrivateDataError('conflict',409);
  const row=sql.get('SELECT p.artifact_id,p.material_id,p.revision FROM mp_publications p JOIN pd_materials h ON h.user_id=p.user_id AND h.id=p.material_id AND h.revision=p.revision WHERE p.user_id=$user AND h.user_id=$user AND p.original_id=? AND h.sequence>=h.min_visible_sequence',ref.slice(9));
  if(!row)throw new PrivateDataError('conflict',409);
  const artifact=this.artifact(context,String(row.artifact_id));
  return {...bound,input,artifactId:artifact.id,materialId:String(row.material_id),materialRevision:String(row.revision),transcript:transcriptSchema.parse(artifact.payload)};
 }
 private fileSpeakerNames(context:UserContext,ref:string,artifactId:string):Record<string,z.infer<typeof fileSpeakerAttributionSchema>>{
  const {sql}=this.input(context,{originalRef:ref,...this.snapshot(context,ref)},true),row=sql.get('SELECT json FROM mp_file_annotations WHERE user_id=$user AND original_id=? AND artifact_id=?',ref.slice(9),artifactId);
  return row?z.record(fileSpeakerAttributionSchema).parse(JSON.parse(String(row.json))):{};
 }
 private originalFileArtifact(context:UserContext,ref:string,artifactId:string){
  const {sql}=this.input(context,{originalRef:ref,...this.snapshot(context,ref)},true),row=sql.get('SELECT raw_artifact_id FROM mp_file_annotations WHERE user_id=$user AND original_id=? AND artifact_id=?',ref.slice(9),artifactId),artifact=this.artifact(context,String(row?.raw_artifact_id??artifactId));
  if(artifact.originalRef!==ref)throw new PrivateDataError('conflict',409);return artifact;
 }
 private publishFileCorrection(context:UserContext,ref:string,expected:string,transcript:ReturnType<typeof transcriptSchema.parse>,key:unknown){
  const sql=this.sql(context),current=this.fileTranscript(context,ref);if(current.artifactId!==expected)throw new PrivateDataError('conflict',409);const parsed=transcriptSchema.parse(transcript),fingerprint=identityHash(key),artifactId=identityHash([context.userId,ref,fingerprint,parsed]);sql.run('INSERT INTO mp_artifacts VALUES($user,?,?,?,?,1) ON CONFLICT(user_id,id) DO NOTHING',artifactId,ref.slice(9),fingerprint,JSON.stringify(parsed));const names=this.fileSpeakerNames(context,ref,current.artifactId),raw=this.originalFileArtifact(context,ref,current.artifactId);sql.run('INSERT INTO mp_file_annotations VALUES($user,?,?,?,?) ON CONFLICT(user_id,original_id,artifact_id) DO NOTHING',ref.slice(9),artifactId,raw.id,JSON.stringify(names));this.publishArtifact(context,current.input,artifactId,undefined,true);sql.run("UPDATE mp_file_reviews SET status='stale' WHERE user_id=$user AND original_id=? AND status='proposed'",ref.slice(9));return {status:'accepted',artifactId};
 }
 private correctFile(context:UserContext,ref:string,value:unknown){
  const input=z.object({artifactId:z.string().regex(/^[a-f0-9]{64}$/),chunkId:z.string().uuid(),originalText:z.string().min(1).max(8000),correctedText:z.string().min(1).max(8000)}).strict().parse(value),sql=this.sql(context);
  return sql.transaction(()=>{
   const current=this.fileTranscript(context,ref);if(current.artifactId!==input.artifactId)throw new PrivateDataError('conflict',409);
   const index=current.transcript.segments.findIndex((_segment,index)=>evidenceId(context.userId,current.artifactId,index)===input.chunkId);
   if(index<0||current.transcript.segments[index].text!==input.originalText)throw new PrivateDataError('conflict',409);
   if(input.originalText===input.correctedText)return {status:'unchanged',artifactId:current.artifactId};
   const transcript=structuredClone(current.transcript);transcript.segments[index].text=input.correctedText;delete transcript.segments[index].words;delete transcript.uncorrected;
   return this.publishFileCorrection(context,ref,current.artifactId,transcript,['owner-file-correction-v1',current.artifactId,input.chunkId,input.originalText,input.correctedText]);
  });
 }
 private nameFileSpeakers(context:UserContext,ref:string,value:unknown){
  const input=z.object({artifactId:z.string().regex(/^[a-f0-9]{64}$/),names:z.record(z.string().regex(/^SPEAKER_[0-9]{1,5}$/),z.string().trim().min(1).max(100))}).strict().parse(value),sql=this.sql(context);
  return sql.transaction(()=>{
   const current=this.fileTranscript(context,ref);if(current.artifactId!==input.artifactId)throw new PrivateDataError('conflict',409);
   const known=new Set(current.transcript.segments.map(segment=>segment.speaker));if(Object.keys(input.names).length>16||Object.keys(input.names).some(label=>!known.has(label)))throw new PrivateDataError('invalid_data');
   const before=this.fileSpeakerNames(context,ref,current.artifactId),confirmationId=randomUUID(),confirmedAt=new Date().toISOString(),names=Object.fromEntries(Object.entries(input.names).map(([label,name])=>[label,before[label]?.name===name?before[label]:fileSpeakerAttributionSchema.parse({name,confirmedBy:'owner',confirmationId,confirmedAt})]));
   if(JSON.stringify(before)===JSON.stringify(names))return {saved:true};
   sql.run('INSERT INTO mp_file_annotations VALUES($user,?,?,?,?) ON CONFLICT(user_id,original_id,artifact_id) DO UPDATE SET json=excluded.json',ref.slice(9),current.artifactId,this.originalFileArtifact(context,ref,current.artifactId).id,JSON.stringify(names));
   this.publishArtifact(context,current.input,current.artifactId,undefined,true);
   return {saved:true};
  });
 }
 private artifact(context:UserContext,id:string){const sql=this.sql(context),row=sql.get('SELECT * FROM mp_artifacts WHERE user_id=$user AND id=?',id) as Artifact|undefined;if(!row)throw missing();const originalRef='original:'+row.original_id;const {record}=this.input(context,{originalRef,...this.snapshot(context,originalRef)},true),payload=JSON.parse(row.json);if(payload.engine==='mote.source-original-v1'&&record.provenance?.document?.coding)throw missing();return {id:row.id,originalRef,payload};}
 private stage(run:TaskRun,input:ProcessingInput,original:Original,key:string,work:()=>Promise<unknown>,parse:(value:unknown)=>unknown,record?:(sql:PrivateSql,artifactId:string)=>void,processorDependencies=false){
  // The named processor key already contains its exact declared dependencies.
  // Authentication still checks the whole current input before every cache read
  // and publication; downstream settings alone are not new raw-extraction input.
  const fingerprint=identityHash([run.task.kind,...(processorDependencies?['named-processor-dependencies-v1']:[input.settings,input.generation]),original.ref,original.hash,key,...(!processorDependencies&&input.policyPlanId?[{policyPlanId:input.policyPlanId}]:[]),run.model?{reference:run.model.lease.reference,provider:run.model.lease.provider,model:run.model.lease.model}:null,...(input.fileGeneration?[{fileGeneration:input.fileGeneration}]:[]),...(input.originalGeneration?[{originalGeneration:input.originalGeneration}]:[]),...(input.attachmentGeneration&&run.task.kind==='processing.analysis'?[{attachmentGeneration:input.attachmentGeneration}]:[])]);
  const read=()=>{const {sql}=this.input(run.context,input),row=sql.get('SELECT * FROM mp_artifacts WHERE user_id=$user AND original_id=? AND fingerprint=?',original.ref.slice(9),fingerprint) as Artifact|undefined;return row?{artifactId:row.id,payload:parse(JSON.parse(row.json))}:undefined;};
  return (async()=>{run.grant.assert();const cached=read();if(cached)return cached;const payload=parse(await work());run.grant.assert();this.input(run.context,input);const json=JSON.stringify(payload);if(Buffer.byteLength(json)>32*1024*1024)throw new ExecutionFailure('permanent','processing_output_too_large');
   const artifactId=identityHash([run.context.userId,original.ref,fingerprint,payload]);run.grant.commit(()=>{const {sql}=this.input(run.context,input);sql.run('INSERT INTO mp_artifacts(user_id,id,original_id,fingerprint,json) VALUES($user,?,?,?,?) ON CONFLICT(user_id,original_id,fingerprint) DO NOTHING',artifactId,original.ref.slice(9),fingerprint,json);record?.(sql,artifactId);});run.checkpoint.write(key,{artifactId});return read()!;
  })();
 }
 private async wait(run:TaskRun,id:string,assert:()=>void=()=>{}){
  for(;;){run.grant.assert();assert();const task=this.execution.forUser(run.context).get(id);if(task.state==='succeeded')return resultSchema.parse(task.result);if(['blocked','failed','cancelled','stale'].includes(task.state))throw new ExecutionFailure(task.state==='stale'||task.state==='cancelled'?'stale':task.state==='blocked'?'blocked':'permanent',task.failure?.code??'processing_child_failed');await delay(20,undefined,{signal:run.signal});}
 }
 /** A settings save is a fresh owner intent. It retires old domain grants and
  * admits a new shared-engine coordinator; it never retries an old task/grant. */
 private reconcilePolicies(context:UserContext){
  const sql=this.sql(context);for(const row of sql.all('SELECT DISTINCT original_id FROM mp_admissions WHERE user_id=$user AND task_id IS NOT NULL')){
   const ref='original:'+row.original_id,latest=sql.get("SELECT e.state,u.input FROM mp_admissions a JOIN execution_steps e ON e.user_id=a.user_id AND e.id=a.task_id JOIN user_tasks u ON u.user_id=e.user_id AND u.task_id=e.id WHERE a.user_id=$user AND e.user_id=$user AND u.user_id=$user AND a.original_id=? AND e.kind='processing.pipeline' ORDER BY e.updated_at DESC,e.id DESC LIMIT 1",row.original_id);
   if(!latest||!['waiting','running','blocked','failed'].includes(String(latest.state))||JSON.parse(String(latest.input)).plugin||this.fileControl(context,ref).cancelled)continue;
   try{sql.transaction(()=>{
    this.input(context,processingInputSchema.parse({originalRef:ref,...this.snapshot(context,ref)}),true);const before=this.policies.current(context,ref),after=this.policies.bindPlan(context,ref,true);if(before?.id===after?.id&&this.current(context.userId,JSON.parse(String(latest.input))))return;
    for(const task of sql.all("SELECT e.id FROM user_tasks u JOIN execution_steps e ON e.user_id=u.user_id AND e.id=u.task_id WHERE u.user_id=$user AND e.user_id=$user AND e.kind LIKE 'processing.%' AND e.state NOT IN('succeeded','cancelled','stale') AND json_extract(u.input,'$.originalRef')=?",ref))this.execution.forUser(context).cancel(String(task.id));
    if(!after?.archiveOnly)this.submitSync(context,ref,'policy-reconcile:'+randomUUID(),undefined,undefined,true);
   });}catch(error){
    // A source/account can retire concurrently. Its existing task stays fenced;
    // no credential or old authorization is reconstructed to force admission.
    if(!(error instanceof ScopeError||error instanceof PrivateDataError))throw error;
   }
  }
 }
 private policyModel(context:UserContext,input:ProcessingInput,feature:'ocr'|'asr'|'file',operationId:string){
  this.input(context,input);const plan=this.policies.current(context,input.originalRef),id=feature==='file'?plan?.profile.modelServiceId:plan?.profile.serviceId,service=plan?.services.find(service=>service.id===id);
  if(plan&&feature!=='file'&&!service)throw new PrivateDataError('scope_unavailable',503);
  return this.configuration.leaseReference(context,feature,operationId,service?.reference);
 }
 private async pipeline(run:TaskRun){
  const input=processingInputSchema.parse(run.task.input);await this.configuration.forUser(run.context).view();run.grant.assert();const {original}=this.input(run.context,input),recipe=this.policies.current(run.context,input.originalRef)?.profile.imageRecipe;if(recipe&&(recipe.id!=='mote.image'||recipe.version!=='1'))throw new ExecutionFailure('blocked','image_recipe_unavailable');
  for(;;){run.grant.assert();this.input(run.context,input);const state=this.physicalState(run.context,input.originalRef);if(state.live){await delay(20,undefined,{signal:run.signal});continue;}if(state.unknown)throw new ExecutionFailure('blocked','external_result_unknown');break;}
  const child=await this.execution.forUser(run.context).submit({kind:'processing.'+this.kind(original),operationId:'processing:'+run.task.id,input:{...input,parentTaskId:run.task.id}});run.checkpoint.write('extraction',{taskId:child.id});return this.wait(run,child.id,()=>{this.input(run.context,input);});
 }
 private async extract(run:TaskRun,kind:'extract'|'ocr'|'asr'){
  const input=processingInputSchema.parse(run.task.input),{source,original,record,format}=this.input(run.context,input);await this.processors.ready;run.grant.assert();
  let releaseOriginal:(()=>void)|undefined;
  // Snapshot bytes are admitted before external issuance; cached stages need no
  // expired bytes. All readers share one exact pin through provider completion.
  const holdOriginal=()=>{releaseOriginal??=this.ingress.forUser(run.context).holdOriginal(original.ref);};
  const bytes=async function*(host:ProcessingHost){holdOriginal();let offset=0;while(offset<original.bytes){run.grant.assert();host.input(run.context,input);const chunk=source.readOriginal(original.ref,{offset});if(!chunk.bytes.length)throw new ExecutionFailure('stale','processing_input_changed');yield chunk.bytes;offset+=chunk.bytes.length;}};
  let mediaCalled=false;
  const withSettings=async(settings:ReturnType<typeof fileProcessingSchema.parse>)=>{
   const profile=this.policies.current(run.context,input.originalRef)?.profile,processorId=profile?.processorId??(kind==='ocr'?'image.http':kind==='asr'?settings.audioProcessor:format.startsWith('processor:')?format.slice(10):format==='source-item'?'source.original':original.mime.startsWith('text/')||original.mime==='application/json'?'text.utf8':DOCUMENT_MIME_TYPES.includes(original.mime as any)?'document.generic':undefined);
   if(!processorId)throw new ExecutionFailure('permanent','unsupported_format');
   if(processorId==='source.original')return this.stage(run,input,original,'source.original.v2',async()=>{const parts:Buffer[]=[];for await(const chunk of bytes(this))parts.push(chunk);const item=sourceItemSchema.parse(JSON.parse(Buffer.concat(parts).toString('utf8')));return sourceTranscript(item);},value=>transcriptSchema.parse(value));
   const processor=this.processors.registry.get(processorId);if(format.startsWith('processor:')&&processor.localOnly!==true)throw new ExecutionFailure('blocked','deterministic_original_processor_required');if(processor.stage!=='extract'||!(processor.id==='text.utf8'&&original.mime==='application/json')&&!processor.mediaTypes.some(type=>type.endsWith('/')?original.mime.startsWith(type):original.mime===type))throw new ExecutionFailure('blocked','processor_media_mismatch');const {sourceId,...provenance}=record.provenance??{},sourceItem=record.provenance?sourceItemSchema.parse({...provenance,observedAt:record.capturedAt,title:record.windowTitle,text:record.ocrText,kind:record.source}):undefined;const request:ProcessorInput={sourceItem,...(profile?{parameters:profile.parameters}:{}),file:{id:original.captureId,title:record.title??record.provenance?.title??'Original',mimeType:original.mime,sizeBytes:original.bytes},settings,requestScope:identityHash([run.context.deploymentId,run.context.userId,run.task.id]),signal:processor.awaitResponseOnCancel?AbortSignal.timeout(settings.timeoutMs):AbortSignal.any([run.signal,AbortSignal.timeout(settings.timeoutMs)]),maxAudioMs:settings.maxAudioMinutes*60000,readOriginal:()=>bytes(this),decodeOriginal:async mimeType=>source.withWorkspace(async workspace=>{
    if(original.bytes>64*1024*1024)throw new StoreError('Document decoding limit',413);const parts:Buffer[]=[];for await(const chunk of bytes(this))parts.push(chunk);workspace.write('original',Buffer.concat(parts));return workspace.withFile('original',path=>formatWork({kind:'document',path,mimeType},run.signal));
   })};
   const output=defaultFileOutput(processor),recipe=input.diarizeFrom?{id:'mote.audio-dialogue',version:'2'}:defaultFileRecipe(processor),plan=this.processors.recipes.resolve(recipe,{semanticTurns:false}),artifacts=new Map<string,unknown>();
   const store=async(key:string,work:()=>Promise<unknown>,parse:(value:unknown)=>unknown,role?:'extract'|'diarize',dependencies:Record<string,string>={})=>{const dependencyProcessor=input.policyPlanId&&role==='diarize'?this.processors.registry.get(settings.diarizationProcessor):processor,revision=identityHash([key,plan.fingerprint,processorContract(dependencyProcessor),processorSettingsFingerprint(dependencyProcessor,settings,request.parameters??{}),request.sourceItem,...(input.policyPlanId?[dependencies]:[])]),reused=role==='extract'&&input.diarizeFrom?this.artifact(run.context,input.diarizeFrom):undefined,result=reused?{artifactId:reused.id,payload:parse(reused.payload)}:await this.stage(run,input,original,revision,work,parse,undefined,!!input.policyPlanId);run.grant.commit(()=>{const {sql}=this.input(run.context,input);if(role)sql.run('INSERT INTO mp_file_steps VALUES($user,?,?,?,?) ON CONFLICT(user_id,original_id,generation,stage) DO UPDATE SET artifact_id=excluded.artifact_id',original.ref.slice(9),input.fileGeneration??0,role,result.artifactId);});artifacts.set(result.artifactId,result.payload);return result.artifactId;};
   const final=await this.processors.recipes.run(recipe,{semanticTurns:false},(step,dependencies)=>({input:request,dependencies,readArtifact:id=>{if(!artifacts.has(id))throw new ExecutionFailure('stale','processing_checkpoint_unavailable');return artifacts.get(id);},transform:(type,execute)=>store(step.name,()=>execute(request.signal),value=>this.processors.outputs.decode(type,value).transcript,undefined,dependencies),builtin:async operation=>{
    if(operation==='extract')return store(step.name,()=>{holdOriginal();mediaCalled ||= kind!=='extract';return this.io(run,input,()=>processor.process(request));},value=>this.processors.outputs.decode(output,value).transcript,'extract',dependencies);
    if(operation==='diarize')return store(step.name,()=>{holdOriginal();mediaCalled=true;return this.io(run,input,()=>this.processors.registry.get(settings.diarizationProcessor).process(request));},value=>{const parsed=diarizationSchema.parse(value);for(const sample of parsed.samples){if(!/^SPEAKER_[0-9]{1,5}$/.test(sample.speaker))throw new ExecutionFailure('permanent','processing_sample_invalid');this.sampleBytes(sample.wavBase64);}return parsed;},'diarize',dependencies);
    if(operation==='align'){const raw=artifacts.get(dependencies.extract),diarization=artifacts.get(dependencies.diarize);return store(step.name,async()=>alignDialogue(transcriptSchema.parse(raw),diarizationSchema.parse(diarization)),value=>transcriptSchema.parse(value),undefined,dependencies);}
    throw new ExecutionFailure('blocked','processing_stage_unavailable');
   }}),id=>{run.grant.assert();this.input(run.context,input);if(!artifacts.has(id))throw new ExecutionFailure('stale','processing_checkpoint_unavailable');});return {artifactId:final,payload:transcriptSchema.parse(artifacts.get(final))};
  };
  try{
  let result:{artifactId:string;payload:unknown};
  if(kind==='extract')result=await withSettings(fileProcessingSchema.parse((({automatic,understandingEnabled,...settings})=>settings)(input.settings)));
  else{
   if(!run.model||run.model.lease.feature!==kind)throw new ExecutionFailure('blocked','processing_model_unavailable');const start=Date.now();
   result=await run.model.withModel(async model=>{if(model.protocol!=='mote-media')throw new ExecutionFailure('blocked','media_protocol_required');const {automatic,understandingEnabled,...saved}=input.settings;const settings=fileProcessingSchema.parse({...saved,endpoint:model.baseUrl,imageEndpoint:kind==='ocr'?model.baseUrl:'',apiKey:model.apiKey,allowRemote:!isLoopback(model.baseUrl),timeoutMs:Math.min(saved.timeoutMs,model.modelRequestTimeoutMs??saved.timeoutMs)});try{return await withSettings(settings);}catch(error){if(error instanceof ProviderFailure||error instanceof ExecutionFailure)throw error;if(run.signal.aborted)run.grant.assert();if(error&&typeof error==='object'&&['ECONNREFUSED','ECONNRESET','ETIMEDOUT','EPIPE','ENOTFOUND','EAI_AGAIN'].includes(String((error as NodeJS.ErrnoException).code)))throw new ProviderFailure({category:'transient',code:'provider_network'});if(error instanceof Error&&['TimeoutError','AbortError'].includes(error.name)&&!run.signal.aborted)throw new ProviderFailure({category:'transient',code:'provider_timeout'});throw failure(error);}});
   if(mediaCalled)run.model.recordUsage({status:'completed',durationMs:Date.now()-start});
  }
  run.grant.assert();this.input(run.context,input);return {artifactId:result.artifactId};
  }finally{releaseOriginal?.();}
 }
 private publish(run:TaskRun,value:unknown,fixedInput?:ProcessingInput,derived?:AnalysisInput){
  const input=fixedInput??processingInputSchema.parse(run.task.input),material=this.publishArtifact(run.context,input,resultSchema.parse(value).artifactId,derived);this.notifyMaterial(run,material);
  if(derived?.mode==='image'){const {record,original}=this.input(run.context,input);if(record.provenance?.layer==='snapshot'&&record.provenance?.document?.fileIndex)this.ingress.forUser(run.context).releaseSnapshot(original.ref);}
 }
 private publishArtifact(context:UserContext,input:ProcessingInput,artifactId:string,derived?:AnalysisInput,ownerEdit=false){
  const {sql,source,original,record,current}=this.input(context,input,ownerEdit),artifact=this.artifact(context,artifactId);if(!current)throw new PrivateDataError('conflict',409);const names=this.fileSpeakerNames(context,input.originalRef,artifactId);
  if(artifact.originalRef!==original.ref)throw new ExecutionFailure('stale','processing_input_changed');const transcript=transcriptSchema.parse(artifact.payload),externalId=(derived?'processed-'+derived.mode+':':'processed:')+original.captureId,id='mat_'+identityHash([original.sourceId,externalId]);
  const blocks=transcript.segments.flatMap((segment,index)=>{const parts=[];for(let offset=0;offset<segment.text.length;offset+=24000)parts.push({id:'text-'+index+'-'+offset,kind:'text',format:'plain',text:segment.text.slice(offset,offset+24000),memberIds:['original'],locator:{startMs:segment.startMs,endMs:segment.endMs,...(segment.speaker?{speaker:segment.speaker,...(names[segment.speaker]?{speakerAttribution:names[segment.speaker]}:{})}:{}),...(segment.uncertain!==undefined?{uncertain:segment.uncertain}:{}),...(segment.overlap!==undefined?{overlap:segment.overlap}:{}),...(segment.imageLocation?{imageLocation:segment.imageLocation}:{}),...(segment.documentLocation?{documentLocation:segment.documentLocation}:{})}});return parts;});
  // Source titles may legitimately be empty (for example mail without Subject).
  // Preserve canonical evidence and use the display fallback required by Material.
  const material=source.publishMaterial({id,kind:derived?derived.mode==='image'?'image-interpretation':derived.mode==='summary'?'summary':'transcript':original.mime.startsWith('audio/')?'transcript':'document',schemaVersion:1,title:(record.windowTitle||record.title||record.provenance?.title||'Processed original').slice(0,500),origin:{sourceId:original.sourceId,externalId},members:[{id:'original',kind:'capture',ref:'capture:'+original.captureId,...(input.attachmentGeneration?{locator:{attachmentGeneration:input.attachmentGeneration}}:{}),...(record.provenance?{revision:record.provenance.revision}:{})},...(attachmentBinding(sql,original.captureId)?[{id:'attachment-parent',kind:'capture',ref:'capture:'+attachmentBinding(sql,original.captureId)!.parentId}]:[]),...(derived?[{id:'extraction',kind:'material',ref:derived.materialId+'@'+derived.materialRevision,revision:derived.materialRevision}]:[])],blocks,coverage:{state:transcript.coverage==='partial'?'partial':'complete'},artifacts:[{key:derived?.mode??'extraction',state:'ready',revision:artifactId,blockIds:blocks.map(b=>b.id)},...(!derived&&record.provenance?.document?.coding?[{key:'coding-dialogue',state:'ready' as const,revision:'1',blockIds:blocks.map(b=>b.id)}]:[])],fidelity:{state:derived?.mode==='summary'?'summary-only':derived||original.mime.startsWith('image/')||original.mime.startsWith('audio/')?'derived':'lossless',limitations:transcript.warnings?.slice(0,20)??[]},retention:{original:'retained',policy:original.retention==='archive'?'keep':'allow-expiry'}});
  if(derived){sql.run('INSERT INTO mp_derivations VALUES($user,?,?,?,?,?) ON CONFLICT(user_id,original_id,kind) DO UPDATE SET artifact_id=excluded.artifact_id,material_id=excluded.material_id,revision=excluded.revision',original.ref.slice(9),derived.mode,artifactId,material.id,material.revision);return material;}
  sql.run('INSERT INTO mp_publications VALUES($user,?,?,?,?,?) ON CONFLICT(user_id,original_id) DO UPDATE SET generation=excluded.generation,artifact_id=excluded.artifact_id,material_id=excluded.material_id,revision=excluded.revision',original.ref.slice(9),input.generation,artifactId,material.id,material.revision);return material;
 }
 private analysisInput(context:UserContext,input:z.infer<typeof derivativeInputSchema>|AnalysisInput){const base=baseInput(input),bound=this.input(context,base),{sql}=bound,artifact=sql.get('SELECT json FROM mp_artifacts WHERE user_id=$user AND id=? AND original_id=? AND complete=1',input.artifactId,input.originalRef.slice(9)),publication=sql.get('SELECT p.artifact_id,m.revision,m.sequence,m.min_visible_sequence FROM mp_publications p JOIN pd_materials m ON m.user_id=p.user_id AND m.id=p.material_id WHERE p.user_id=$user AND m.user_id=$user AND p.original_id=? AND p.material_id=?',input.originalRef.slice(9),input.materialId);if(artifact&&bound.record.provenance?.document?.coding&&JSON.parse(String(artifact.json)).engine==='mote.source-original-v1')throw new PrivateDataError('conflict',409);if(!artifact||publication?.artifact_id!==input.artifactId||publication?.revision!==input.materialRevision||Number(publication.sequence)<Number(publication.min_visible_sequence))throw new ExecutionFailure('stale','processing_extraction_changed');return {...bound,transcript:transcriptSchema.parse(JSON.parse(String(artifact.json)))};}
 private submitDerivativesSync(context:UserContext,ref:string,operationId:string,modes:('summary'|'turns'|'image')[],fixed?:ProcessingInput){const input=fixed??{originalRef:ref,...this.snapshot(context,ref)},sql=this.input(context,input).sql,publication=sql.get('SELECT p.*,m.revision AS current_revision FROM mp_publications p JOIN pd_materials m ON m.user_id=p.user_id AND m.id=p.material_id WHERE p.user_id=$user AND m.user_id=$user AND p.original_id=?',ref.slice(9));if(!publication)throw new PrivateDataError('conflict',409);const value=derivativeInputSchema.parse({...input,artifactId:publication.artifact_id,materialId:publication.material_id,materialRevision:publication.current_revision,modes:[...new Set(modes)]});return this.execution.forUser(context).submitSync({kind:'processing.derivatives',operationId,input:value});}
 private async submitDerivatives(context:UserContext,ref:string,operationId:string,modes:('summary'|'turns'|'image')[],fixed?:ProcessingInput){return this.submitDerivativesSync(context,ref,operationId,modes,fixed);}
 private automaticDerivations(run:TaskRun,value:unknown){const input=processingInputSchema.parse(run.task.input),{original,sql}=this.input(run.context,input),modes:('summary'|'turns'|'image')[]=[];if(input.settings.summarize)modes.push('summary');if(input.settings.semanticTurns&&original.mime.startsWith('audio/'))modes.push('turns');if(input.settings.understandingEnabled&&original.mime.startsWith('image/'))modes.push('image');if(!modes.length)return;const operationId='derive:'+run.task.id;void this.submitDerivatives(run.context,input.originalRef,operationId,modes,input).catch(()=>{/* The task admission fails closed; saved extraction stays independently indexed. */});}
 private async analysis(run:TaskRun){const input=analysisInputSchema.parse(run.task.input),base=baseInput(input),bound=this.analysisInput(run.context,input),{source,original,transcript}=bound,data=run.services.get<PrivateData>('private-data'),material=data.material(input.materialId),sourceContext=data.sourceContext(original.sourceId),record={...bound.record,attributionContext:{...material.attributionContext,...(sourceContext.version?{sourceContextDeclarations:[{sourceId:original.sourceId,version:sourceContext.version,fingerprint:sourceContext.fingerprint}],sourceContextStatements:[{sourceId:original.sourceId,version:sourceContext.version,description:sourceContext.description}]}:{})}};
  const usage=()=>{const rows=this.sql(run.context).all('SELECT json FROM mp_artifact_usage WHERE user_id=$user AND task_id=?',run.task.id);if(!rows.length)return;const result:TokenUsage={requests:0,reportedRequests:0,inputTokens:0,outputTokens:0,totalTokens:0};for(const row of rows){const value=JSON.parse(String(row.json));for(const key of ['requests','reportedRequests','inputTokens','outputTokens','totalTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens'] as const)if(value[key]!==undefined)result[key]=(result[key]??0)+Number(value[key]);}return result;};
  const release=input.mode==='image'&&original.available!==false?this.ingress.forUser(run.context).holdOriginal(original.ref):undefined;
  try{return await this.io(run,base,()=>analyzeProcessing(run,input,{original,record,transcript,failure,assert:()=>{run.grant.assert();this.analysisInput(run.context,input);},workspace:work=>source.withWorkspace(work),readOriginal:async()=>{if(original.bytes>16*1024*1024)throw new ExecutionFailure('permanent','image_disclosure_limit');const parts:Buffer[]=[];for(let offset=0;offset<original.bytes;){run.grant.assert();this.analysisInput(run.context,input);const page=source.readOriginal(original.ref,{offset});parts.push(page.bytes);offset+=page.bytes.length;}return Buffer.concat(parts);},stage:async(key,work,readUsage)=>{const result=await this.stage(run,base,original,key,work,value=>transcriptSchema.parse(value),(sql,id)=>{const tokens=readUsage();if(tokens)sql.run('INSERT INTO mp_artifact_usage VALUES($user,?,?,?) ON CONFLICT(user_id,artifact_id,task_id) DO NOTHING',id,run.task.id,JSON.stringify(tokens));});return {artifactId:result.artifactId,payload:transcriptSchema.parse(result.payload)};},usage}));}finally{release?.();}
 }
 private lifecycle():DomainLifecycle{return {
  exportUser:async subject=>{const assert=()=>this.runtime.services.assertSubject(subject,PROCESSING_DOMAIN,'export'),sql=new PrivateSql(this.db,subject.userId,assert);return sql.transaction(()=>({domain:PROCESSING_DOMAIN,version:1,deploymentId:subject.deploymentId,userId:subject.userId,payload:{format:'mote-processing-v1',policyPlans:policyPlanArchive(sql).export(),imports:importJobArchive(sql).export(),reviews:processingReviewArchive(sql).export(),coverage:{artifacts:true,publications:true,activeAuthorization:false,excluded:['tasks','model-snapshots','workspaces','admission-history','partial-model-usage']},derivations:sql.all('SELECT original_id,kind,artifact_id,material_id,revision FROM mp_derivations WHERE user_id=$user'),formats:sql.all('SELECT original_id,format FROM mp_original_formats WHERE user_id=$user'),artifacts:sql.all('SELECT * FROM mp_artifacts WHERE user_id=$user').map(({user_id,...row})=>row),annotations:sql.all('SELECT original_id,artifact_id,raw_artifact_id,json FROM mp_file_annotations WHERE user_id=$user'),steps:sql.all('SELECT original_id,generation,stage,artifact_id FROM mp_file_steps WHERE user_id=$user'),diarization:sql.all('SELECT original_id,json FROM mp_file_diarization WHERE user_id=$user'),controls:sql.all('SELECT original_id,generation,cancelled FROM mp_file_controls WHERE user_id=$user'),publications:sql.all('SELECT * FROM mp_publications WHERE user_id=$user').map(({user_id,...row})=>row)}}));},
  deleteUser:async(subject,operationId)=>{const sql=new PrivateSql(this.db,subject.userId,()=>this.runtime.services.assertSubject(subject,PROCESSING_DOMAIN,'delete'));this.runtime.services.assertSubject(subject,PROCESSING_DOMAIN,'delete');this.policies.retire(subject.userId);sql.transaction(()=>{const state=this.state(sql);sql.run('UPDATE mp_state SET deleted=1,generation=? WHERE user_id=$user',state.generation+1);sql.run('DELETE FROM mp_import_jobs WHERE user_id=$user');sql.run('DELETE FROM mp_file_policy_bindings WHERE user_id=$user');sql.run('DELETE FROM mp_file_plans WHERE user_id=$user');sql.run('DELETE FROM mp_file_policies WHERE user_id=$user');sql.run('DELETE FROM mp_file_annotations WHERE user_id=$user');sql.run('DELETE FROM mp_file_calendar WHERE user_id=$user');sql.run('DELETE FROM mp_file_reviews WHERE user_id=$user');sql.run('DELETE FROM mp_file_steps WHERE user_id=$user');sql.run('DELETE FROM mp_file_diarization WHERE user_id=$user');sql.run('DELETE FROM mp_file_retries WHERE user_id=$user');sql.run('DELETE FROM mp_file_controls WHERE user_id=$user');sql.run('DELETE FROM mp_derivations WHERE user_id=$user');sql.run('DELETE FROM mp_publications WHERE user_id=$user');sql.run('DELETE FROM mp_artifacts WHERE user_id=$user');sql.run('DELETE FROM mp_restore WHERE user_id=$user');sql.run('DELETE FROM mp_admissions WHERE user_id=$user');sql.run('DELETE FROM mp_original_formats WHERE user_id=$user');});if(sql.get('SELECT id FROM mp_activity WHERE user_id=$user LIMIT 1'))return {status:'result_unknown',operationId};return {status:'complete',operationId};},
  importUser:(subject,archive,operationId)=>this.restore(subject,archive,operationId,true),
  restoreUser:async(subject,archive,operationId)=>{this.restore(subject,archive,operationId);},
 };}
 /** M16 can reconcile only a purpose-bound deletion journal after proving the
  * old request/worker stopped. Elapsed time is never physical erasure proof. */
 pendingErasure(subject:UserDataSubject){const sql=this.deletionSql(subject);return sql.all('SELECT id,state FROM mp_activity WHERE user_id=$user ORDER BY id').map(row=>({id:String(row.id),state:String(row.state),live:this.active.has(identityHash([subject.userId,row.id]))}));}
 settleErasure(subject:UserDataSubject,id:string,outcome:'stopped'){const sql=this.deletionSql(subject);if(outcome!=='stopped'||this.active.has(identityHash([subject.userId,id])))throw new PrivateDataError('conflict',409);sql.run('DELETE FROM mp_activity WHERE user_id=$user AND id=?',id);}
 private deletionSql(subject:UserDataSubject){const assert=()=>{this.runtime.services.assertSubject(subject,PROCESSING_DOMAIN,'delete');if('credentialId' in subject)throw new ScopeError('invalid_identity',403);};const sql=new PrivateSql(this.db,subject.userId,assert);if(!sql.get('SELECT deleted FROM mp_state WHERE user_id=$user')?.deleted)throw new PrivateDataError('conflict',409);return sql;}
 private async io<T>(run:TaskRun,input:ProcessingInput,work:()=>Promise<T>,ownerReview=false){
  const id=randomUUID(),key=identityHash([run.context.userId,id]),cleanup=new PrivateSql(this.db,run.context.userId,()=>{});let complete!:()=>unknown;
  run.external.begin('processing:'+run.task.id+':'+id,issuance=>{if(this.blockedCall(run.context,input.originalRef,run.task.id))throw new ExecutionFailure('blocked','external_result_unknown',undefined,{executionStarted:false});this.input(run.context,input,ownerReview).sql.run("INSERT INTO mp_activity VALUES($user,?,'active')",id);complete=this.execution.bindExternalCompletion(run.context,run.task.id,issuance);});this.active.add(key);let settled=false;
  // The exact transport completion may settle its issued fact after revoke;
  // it cannot restore the task grant or publish a private artifact.
  const finish=()=>{complete();settled=true;};
  try{const value=await work();finish();return value;}catch(error){
   const known=error instanceof ProviderFailure?(error.details.executionStarted===false||!['provider_timeout','provider_unavailable','provider_network'].includes(error.details.code)):error instanceof StoreError||error instanceof z.ZodError||error instanceof SyntaxError;
   if(known)finish();throw error;
  }finally{this.active.delete(key);if(settled)cleanup.run('DELETE FROM mp_activity WHERE user_id=$user AND id=?',id);else cleanup.run("UPDATE mp_activity SET state='unknown' WHERE user_id=$user AND id=?",id);}
 }
 private restore(subject:UserDataSubject,archive:Parameters<DomainLifecycle['restoreUser']>[1],operationId:string,merge=false){
  const sql=new PrivateSql(this.db,subject.userId,()=>this.runtime.services.assertSubject(subject,PROCESSING_DOMAIN,'restore'));
  if(archive.domain!==PROCESSING_DOMAIN||archive.version!==1||archive.userId!==subject.userId||archive.deploymentId!==subject.deploymentId)throw new PrivateDataError('invalid_data');
  // Portable processing data never renews tasks, snapshots or publication rights.
  // Until its canonical parents are restored, reject without any mutation.
  const payload=z.object({format:z.literal('mote-processing-v1'),policyPlans:policyPlanArchiveSchema.optional(),imports:z.unknown().optional(),reviews:z.unknown().optional(),coverage:z.object({artifacts:z.literal(true),publications:z.literal(true),activeAuthorization:z.literal(false),excluded:z.tuple([z.literal('tasks'),z.literal('model-snapshots'),z.literal('workspaces'),z.literal('admission-history'),z.literal('partial-model-usage')])}).strict(),derivations:z.array(z.object({original_id:z.string(),kind:z.enum(['summary','turns','image']),artifact_id:z.string(),material_id:z.string(),revision:z.string()}).strict()),formats:z.array(z.object({original_id:z.string().regex(/^[a-f0-9]{64}$/),format:z.string().refine(value=>['capture','source-item','file'].includes(value)||/^processor:[a-z][a-z0-9.-]{0,99}$/.test(value))}).strict()),artifacts:z.array(z.object({id:z.string(),original_id:z.string(),fingerprint:z.string(),json:z.string(),complete:z.number().int().min(0).max(1)}).strict()),steps:z.array(z.object({original_id:z.string().regex(/^[a-f0-9]{64}$/),generation:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),stage:z.enum(['extract','diarize']),artifact_id:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).default([]),diarization:z.array(z.object({original_id:z.string().regex(/^[a-f0-9]{64}$/),json:z.string().max(32768)}).strict()).default([]),controls:z.array(z.object({original_id:z.string().regex(/^[a-f0-9]{64}$/),generation:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),cancelled:z.number().int().min(0).max(1)}).strict()).default([]),annotations:z.array(z.object({original_id:z.string().regex(/^[a-f0-9]{64}$/),artifact_id:z.string().regex(/^[a-f0-9]{64}$/),raw_artifact_id:z.string().regex(/^[a-f0-9]{64}$/),json:z.string().max(32768)}).strict()).default([]),publications:z.array(z.object({original_id:z.string(),generation:z.number().int().nonnegative(),artifact_id:z.string(),material_id:z.string(),revision:z.string()}).strict())}).strict().parse(archive.payload);
  const digest=identityHash(payload);sql.transaction(()=>{if(sql.get('SELECT id FROM mp_activity WHERE user_id=$user LIMIT 1'))throw new PrivateDataError('conflict',409);const prior=sql.get('SELECT digest FROM mp_restore WHERE user_id=$user AND operation_id=?',operationId);if(prior){if(prior.digest!==digest)throw new PrivateDataError('conflict',409);return;}if(!merge&&sql.get('SELECT id FROM mp_artifacts WHERE user_id=$user LIMIT 1'))throw new PrivateDataError('conflict',409);
   if(new Set(payload.derivations.map(row=>JSON.stringify([row.original_id,row.kind]))).size!==payload.derivations.length||new Set(payload.formats.map(a=>a.original_id)).size!==payload.formats.length||new Set(payload.artifacts.map(a=>a.id)).size!==payload.artifacts.length||new Set(payload.publications.map(p=>p.original_id)).size!==payload.publications.length)throw new PrivateDataError('invalid_data');
   for(const row of payload.artifacts){const parsed=z.union([transcriptSchema,diarizationSchema]).parse(JSON.parse(row.json));if(!/^[a-f0-9]{64}$/.test(row.fingerprint)||!sql.get('SELECT id FROM ig_originals WHERE user_id=$user AND id=?',row.original_id)||row.id!==identityHash([subject.userId,'original:'+row.original_id,row.fingerprint,parsed]))throw new PrivateDataError('invalid_data');}
   for(const row of payload.formats)if(!sql.get('SELECT id FROM ig_originals WHERE user_id=$user AND id=?',row.original_id))throw new PrivateDataError('invalid_data');
   if(new Set(payload.controls.map(row=>row.original_id)).size!==payload.controls.length||payload.controls.some(row=>!sql.get('SELECT id FROM ig_originals WHERE user_id=$user AND id=?',row.original_id)))throw new PrivateDataError('invalid_data');
   if(new Set(payload.annotations.map(row=>JSON.stringify([row.original_id,row.artifact_id]))).size!==payload.annotations.length)throw new PrivateDataError('invalid_data');
   for(const row of payload.annotations){const artifact=payload.artifacts.find(item=>item.id===row.artifact_id&&item.original_id===row.original_id);if(!artifact||!payload.artifacts.some(item=>item.id===row.raw_artifact_id&&item.original_id===row.original_id))throw new PrivateDataError('invalid_data');const transcript=transcriptSchema.parse(JSON.parse(artifact.json)),known=new Set(transcript.segments.map(segment=>segment.speaker)),names=z.record(fileSpeakerAttributionSchema).parse(JSON.parse(row.json));if(Object.keys(names).length>16||Object.keys(names).some(label=>!known.has(label)||!/^SPEAKER_[0-9]{1,5}$/.test(label)))throw new PrivateDataError('invalid_data');}
   if(new Set(payload.steps.map(row=>JSON.stringify([row.original_id,row.generation,row.stage]))).size!==payload.steps.length||new Set(payload.diarization.map(row=>row.original_id)).size!==payload.diarization.length)throw new PrivateDataError('invalid_data');
   for(const row of payload.steps){const artifact=payload.artifacts.find(item=>item.id===row.artifact_id&&item.original_id===row.original_id);if(!artifact||row.generation>(payload.controls.find(control=>control.original_id===row.original_id)?.generation??0))throw new PrivateDataError('invalid_data');(row.stage==='extract'?transcriptSchema:diarizationSchema).parse(JSON.parse(artifact.json));}
   for(const row of payload.diarization){const options=fileDiarizationOptionsSchema.parse(JSON.parse(row.json));if(!sql.get('SELECT id FROM ig_originals WHERE user_id=$user AND id=?',row.original_id)||options.processor==='audio.diarize'&&options.range)throw new PrivateDataError('invalid_data');}
   for(const row of payload.publications){const parent=sql.get('SELECT source_id,capture_id FROM ig_originals WHERE user_id=$user AND id=?',row.original_id),expected=parent?'mat_'+identityHash([parent.source_id,'processed:'+parent.capture_id]):undefined;if(!payload.artifacts.some(a=>a.id===row.artifact_id&&a.original_id===row.original_id&&a.complete===1)||row.material_id!==expected||!sql.get("SELECT capture_id FROM pd_material_captures WHERE user_id=$user AND material_id=? AND revision=? AND capture_id=? AND member_id='original'",row.material_id,row.revision,String(parent?.capture_id??'')))throw new PrivateDataError('invalid_data');}
   for(const row of payload.derivations){const parent=sql.get('SELECT source_id,capture_id FROM ig_originals WHERE user_id=$user AND id=?',row.original_id);if(!parent||row.material_id!=='mat_'+identityHash([parent.source_id,'processed-'+row.kind+':'+parent.capture_id])||!payload.artifacts.some(a=>a.id===row.artifact_id&&a.original_id===row.original_id&&a.complete===1)||!sql.get("SELECT capture_id FROM pd_material_captures WHERE user_id=$user AND material_id=? AND revision=? AND capture_id=? AND member_id='original'",row.material_id,row.revision,String(parent.capture_id)))throw new PrivateDataError('invalid_data');}
   processingReviewArchive(sql).validate(payload.reviews,payload.artifacts);
   const restorePlans=policyPlanArchive(sql).preflight(payload.policyPlans,payload.controls);
   for(const row of payload.formats){const prior=sql.get('SELECT format FROM mp_original_formats WHERE user_id=$user AND original_id=?',row.original_id);if(prior&&prior.format!==row.format)throw new PrivateDataError('conflict',409);sql.run('INSERT INTO mp_original_formats VALUES($user,?,?) ON CONFLICT(user_id,original_id) DO NOTHING',row.original_id,row.format);}
   for(const row of payload.artifacts){const prior=sql.get('SELECT id,original_id,fingerprint,json,complete FROM mp_artifacts WHERE user_id=$user AND id=?',row.id);if(prior&&identityHash(prior)!==identityHash(row))throw new PrivateDataError('conflict',409);sql.run('INSERT INTO mp_artifacts VALUES($user,?,?,?,?,?) ON CONFLICT(user_id,id) DO NOTHING',row.id,row.original_id,row.fingerprint,row.json,row.complete);}
   for(const row of payload.steps)sql.run('INSERT INTO mp_file_steps VALUES($user,?,?,?,?) ON CONFLICT(user_id,original_id,generation,stage) DO NOTHING',row.original_id,row.generation,row.stage,row.artifact_id);
   for(const row of payload.diarization)sql.run('INSERT INTO mp_file_diarization VALUES($user,?,?) ON CONFLICT(user_id,original_id) DO NOTHING',row.original_id,row.json);
   for(const row of payload.controls)sql.run('INSERT INTO mp_file_controls VALUES($user,?,?,?) ON CONFLICT(user_id,original_id) DO NOTHING',row.original_id,row.generation,row.cancelled);
   for(const row of payload.annotations)sql.run('INSERT INTO mp_file_annotations VALUES($user,?,?,?,?) ON CONFLICT(user_id,original_id,artifact_id) DO NOTHING',row.original_id,row.artifact_id,row.raw_artifact_id,row.json);
   for(const row of payload.derivations)sql.run('INSERT INTO mp_derivations VALUES($user,?,?,?,?,?) ON CONFLICT(user_id,original_id,kind) DO NOTHING',row.original_id,row.kind,row.artifact_id,row.material_id,row.revision);
   restorePlans();
   processingReviewArchive(sql).restore(payload.reviews,payload.artifacts);
   const state=this.state(sql),generation=state.generation+(merge?0:1);for(const row of payload.publications)sql.run('INSERT INTO mp_publications VALUES($user,?,?,?,?,?) ON CONFLICT(user_id,original_id) DO NOTHING',row.original_id,generation,row.artifact_id,row.material_id,row.revision);
   importJobArchive(sql).restore(payload.imports,merge);
   if(!merge)sql.run('UPDATE mp_state SET deleted=0,generation=? WHERE user_id=$user',generation);sql.run('INSERT INTO mp_restore VALUES($user,?,?)',operationId,digest);
  });
 }
 async close(){if(this.closed)return;await this.reviews.close();await this.importJobs.close();this.closed=true;for(const dispose of this.unregister.reverse())await dispose();await this.processors.close();}
}
