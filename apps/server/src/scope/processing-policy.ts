import {z} from 'zod';
import type {DatabaseSync} from 'node:sqlite';
import {fileTypePattern,processingProfileSchema} from '@mote/shared';
import {randomUUID} from 'node:crypto';
import {DOCUMENT_MIME_TYPES} from '@mote/shared/document-decoder';
import {validateProcessingProfiles} from '../file-policy-validation.js';
import type {FileProcessorRuntime} from '../file-processors.js';
import {processorContract} from '../file-configuration.js';
import {ConfigServiceError} from '../config-service.js';
import {effectiveProcessorParameters} from '../processor-parameters.js';
import type {Configurations} from './configuration.js';
import type {UserContext} from './context.js';
import type {ScopedRuntime} from './http.js';
import {PrivateSql,PrivateDataError,missing} from './private-data-sql.js';
import {processingSettingsSchema,type ProcessingSettings} from './processing-schema.js';
import {scopedFilePolicySchema,selectScopedFilePolicy,type ScopedFilePolicy} from './processing-policy-contract.js';
import {identityHash} from './originals.js';
import type {registerProcessingFiles} from './processing-files.js';

const domain='filePolicy',valueSchema=z.object({policy:scopedFilePolicySchema.nullable()}).strict();
const effectiveValueSchema=valueSchema.extend({connections:z.record(z.string().regex(/^[0-9a-f]{64}$/)).default({})});
const connectionKey=(reference:{kind:string;id:string})=>identityHash(reference);
const canonicalHash=(value:unknown)=>identityHash(JSON.parse(JSON.stringify(value,(_key,child)=>child&&typeof child==='object'&&!Array.isArray(child)?Object.fromEntries(Object.keys(child).sort().map(key=>[key,child[key]])):child)));
export type FilePolicyPlan=ReturnType<typeof selectScopedFilePolicy>&{id:string};
/** Existing M04 YAML transaction and M06 immutable metadata only. Endpoint/key
 * ownership remains exclusively in the complete personal/shared M04 reference. */
export class ProcessingPolicies {
 private readonly previews=new Map<string,{userId:string;epoch:number;revision:string;expires:number;items:{id:string;ref:string;proof:string}[]}>();
 constructor(private readonly runtime:ScopedRuntime,private readonly db:DatabaseSync,private readonly configuration:Configurations,private readonly processors:FileProcessorRuntime,private readonly settings:(context:UserContext)=>ProcessingSettings,changed:(context:UserContext)=>void){
  configuration.registerDomain(domain,subject=>({id:domain,schema:effectiveValueSchema.superRefine((next,issues)=>{
   if(!next.policy)return;const sql=new PrivateSql(db,subject.userId,()=>{'credentialId' in subject?runtime.authority.assert(subject):runtime.services.assertSubject(subject,'configuration',subject.purpose);}),before=sql.get('SELECT json FROM mp_file_policies WHERE user_id=$user');
   try{validateProcessingProfiles(next.policy,before?effectiveValueSchema.parse(JSON.parse(String(before.json))).policy?.profiles??[]:next.policy.profiles,processors.registry);}catch{issues.addIssue({code:'custom',message:'Invalid saved processor profile'});}
  }),defaultValue:{policy:null},resolve:(raw,document)=>{
   const next=valueSchema.parse(raw),connections:Record<string,string>={};
   if(next.policy){const models=configuration.resources.schema().parse(document?.models??{profiles:[],selections:{}});
    // Derive only fingerprints from M04's complete connection. Raw YAML keeps
    // references; endpoint/key material is never copied into a second store.
    for(const service of next.policy.services){const reference=service.reference;connections[connectionKey(reference)]=reference.kind==='shared'?canonicalHash({generation:configuration.resources.generation(reference.id)}):canonicalHash(models.profiles.find(profile=>profile.id===reference.id)?.settings??null);}
   }
   return {...next,connections};
  },fields:[{path:'policy',effect:'next-request'}],prepare:raw=>{
   const sql=new PrivateSql(db,subject.userId,()=>{'credentialId' in subject?runtime.authority.assert(subject):runtime.services.assertSubject(subject,'configuration',subject.purpose);}),before=sql.get('SELECT json FROM mp_file_policies WHERE user_id=$user'),next=effectiveValueSchema.parse(raw);
   if(next.policy)validateProcessingProfiles(next.policy,before?effectiveValueSchema.parse(JSON.parse(String(before.json))).policy?.profiles??[]:next.policy.profiles,processors.registry,{error:()=>new ConfigServiceError('config_invalid')});
   const json=JSON.stringify(next);let published=false;
   return {apply:()=>{},publish:()=>{sql.run('INSERT INTO mp_file_policies VALUES($user,?) ON CONFLICT(user_id) DO UPDATE SET json=excluded.json',json);published=true;},rollback:()=>{if(published){if(before)sql.run('UPDATE mp_file_policies SET json=? WHERE user_id=$user',before.json);else sql.run('DELETE FROM mp_file_policies WHERE user_id=$user');}},complete:()=>{if('credentialId' in subject&&next.policy&&before?.json!==json)changed(subject);}};
  }}));
 }
 private sql(context:UserContext){return new PrivateSql(this.db,context.userId,()=>this.runtime.authority.assert(context));}
 policy(context:UserContext):ScopedFilePolicy|null{const row=this.sql(context).get('SELECT json FROM mp_file_policies WHERE user_id=$user');return row?effectiveValueSchema.parse(JSON.parse(String(row.json))).policy:null;}
 current(context:UserContext,ref:string):FilePolicyPlan|undefined{const row=this.sql(context).get('SELECT p.id,p.json FROM mp_file_policy_bindings b JOIN mp_file_plans p ON p.user_id=b.user_id AND p.id=b.plan_id WHERE b.user_id=$user AND p.user_id=$user AND b.original_id=?',ref.slice(9));return row?{...JSON.parse(String(row.json)),id:String(row.id)}:undefined;}
 /** Called by trusted admission, never a presentation GET. A completed file keeps
  * its applied plan until explicit reprocessing chooses a replacement. */
 bindPlan(context:UserContext,ref:string,replace=false,override?:string){
  const prior=this.current(context,ref);if(prior&&!replace)return prior;const policy=this.policy(context);if(!policy)return prior;
  const sql=this.sql(context);if(!replace&&!prior&&(sql.get('SELECT task_id FROM mp_admissions WHERE user_id=$user AND original_id=? AND task_id IS NOT NULL LIMIT 1',ref.slice(9))||sql.get('SELECT artifact_id FROM mp_publications WHERE user_id=$user AND original_id=?',ref.slice(9))))return undefined;
  const row=sql.get('SELECT r.source_id,r.mime,f.format FROM ig_originals r JOIN mp_original_formats f ON f.user_id=r.user_id AND f.original_id=r.id WHERE r.user_id=$user AND f.user_id=$user AND r.id=?',ref.slice(9));if(!row)throw missing();
  if(row.format==='source-item'||String(row.format).startsWith('processor:'))return prior;
  const selected=selectScopedFilePolicy(policy,String(row.source_id),String(row.mime),override);
  if(!selected.archiveOnly){const processor=this.processors.registry.list().find(processor=>processor.id===selected.profile.processorId);if(processor)selected.profile.parameters=effectiveProcessorParameters(processor,selected.profile.parameters);
  }
  const stored=sql.get('SELECT json FROM mp_file_policies WHERE user_id=$user'),connections=stored?effectiveValueSchema.parse(JSON.parse(String(stored.json))).connections:{},selectedConnections=selected.services.map(service=>({reference:service.reference,fingerprint:connections[connectionKey(service.reference)]})).sort((a,b)=>connectionKey(a.reference).localeCompare(connectionKey(b.reference)));
  const id=identityHash({original:ref,fingerprint:selected.fingerprint,connections:selectedConnections,processor:selected.archiveOnly?'archive':this.processors.registry.list().filter(processor=>processor.id===selected.profile.processorId).map(processorContract),parameters:selected.profile.parameters}),json=JSON.stringify({...selected,connections:selectedConnections});
  sql.run('INSERT INTO mp_file_plans VALUES($user,?,?,?) ON CONFLICT(user_id,id) DO NOTHING',id,ref.slice(9),json);sql.run('INSERT INTO mp_file_policy_bindings VALUES($user,?,?) ON CONFLICT(user_id,original_id) DO UPDATE SET plan_id=excluded.plan_id',ref.slice(9),id);return this.current(context,ref)!;
 }
 effective(base:ProcessingSettings,plan?:FilePolicyPlan){if(!plan)return base;const p=plan.profile,parameters=p.parameters;return processingSettingsSchema.parse({...base,audioProcessor:p.processorId.startsWith('audio.')?p.processorId:base.audioProcessor,diarizationProcessor:p.diarizationProcessor,summarize:p.summarize,speakerCount:parameters.speakerCount??null,speakerMin:parameters.speakerMin??null,speakerMax:parameters.speakerMax??null,semanticTurns:parameters.semanticTurns===true});}
 private async previewPolicy(context:UserContext){
  const saved=this.policy(context);if(saved)return saved;const selected=(await this.configuration.forUser(context).models()).selections,settings=this.settings(context),services:ScopedFilePolicy['services']=[];
  for(const [feature,kind]of [['ocr','image'],['asr','asr'],['file','model']] as const){const reference=selected[feature];if(reference)services.push({id:'service.'+feature,name:'service.'+feature,kind,reference});}
  const profile=(id:string,processorId:string,serviceId?:string)=>processingProfileSchema.parse({id,name:id,processorId,parameters:{},summarize:false,...(services.some(service=>service.id===serviceId)?{serviceId}:{})});
  return scopedFilePolicySchema.parse({version:1,services,profiles:[profile('image','image.http','service.ocr'),profile('audio',settings.audioProcessor,'service.asr'),profile('text','text.utf8'),profile('document','document.generic'),profile('archive','archive')],rules:[{type:'image/*',profileId:'image'},{type:'audio/*',profileId:'audio'},{type:'text/*',profileId:'text'},...DOCUMENT_MIME_TYPES.map(type=>({type,profileId:'document'})),{type:'*/*',profileId:'archive'}]});
 }
 async view(context:UserContext){const user=this.configuration.forUser(context),view=await user.view();return {revision:String(view.revision),settings:this.settings(context),policy:await this.previewPolicy(context),policyConfigured:!!this.policy(context),models:await user.models(),execution:'central',runtime:'cordis',processors:this.processors.registry.list(),capabilities:{intake:this.processors.intake.list(),...this.processors.recipes.list(),outputs:this.processors.outputs.list(),image:this.processors.imageRecipes.list()}};}
 async save(context:UserContext,raw:unknown){const input=z.object({revision:z.string().regex(/^(0|[1-9][0-9]*)$/),settings:processingSettingsSchema,policy:scopedFilePolicySchema,models:z.object({profiles:z.array(z.unknown()),selections:z.record(z.unknown())}).strict().optional()}).strict().parse(raw),revision=Number(input.revision);if(!Number.isSafeInteger(revision))throw new PrivateDataError('conflict',409);validateProcessingProfiles(input.policy,(await this.previewPolicy(context)).profiles,this.processors.registry,{error:()=>new PrivateDataError('invalid_data',400)});await this.configuration.forUser(context).replaceViews({processing:input.settings,[domain]:{policy:input.policy},...(input.models?{models:input.models}:{})},revision);return this.view(context);}
 async match(context:UserContext,raw:unknown){const input=z.object({sourceId:z.string().min(1).max(128),mimeType:z.string().max(200)}).strict().parse(raw);await this.configuration.forUser(context).view();return selectScopedFilePolicy(await this.previewPolicy(context),input.sourceId,input.mimeType);}
 async preview(context:UserContext,raw:unknown,files:ReturnType<ReturnType<typeof registerProcessingFiles>>){
  const input=z.object({revision:z.string(),sourceId:z.string().max(128).optional(),type:fileTypePattern.default('*/*'),profileId:z.string().max(100).optional()}).strict().parse(raw),view=await this.configuration.forUser(context).view();if(input.revision!==String(view.revision))throw new PrivateDataError('conflict',409);const policy=await this.previewPolicy(context),now=Date.now();
  for(const [token,preview]of this.previews)if(preview.expires<now)this.previews.delete(token);const owned=[...this.previews].filter(([,preview])=>preview.userId===context.userId);if(owned.length>=20)this.previews.delete(owned[0]![0]);
  const items:{id:string;ref:string;proof:string;title:string;profileName:string;rule:ReturnType<typeof selectScopedFilePolicy>['rule']}[]=[];let cursor:string|undefined,scanned=0,skipped=0,bounded=false;
  do{const page=files.list({limit:100,type:input.type,...(input.sourceId?{sourceId:input.sourceId}:{}),...(cursor?{cursor}:{})});for(const file of page.items){if(scanned++>=1000){bounded=true;break;}const mime=file.item.mimeType;if(input.type!=='*/*'&&(input.type.endsWith('/*')?!mime.startsWith(input.type.slice(0,-1)):mime!==input.type))continue;const selected=selectScopedFilePolicy(policy,file.sourceId,mime);if(input.profileId&&selected.profile.id!==input.profileId)continue;
    if(selected.archiveOnly||!file.hasOriginal||file.job?.state==='running'||file.cancellation.wait==='running'){skipped++;continue;}if(items.length===100){bounded=true;break;}items.push({id:file.captureId,ref:file.originalRef,proof:files.proof(file.captureId),title:file.item.title,profileName:selected.profile.name,rule:selected.rule});
   }cursor=page.nextCursor??undefined;if(scanned>=1000&&cursor)bounded=true;if(items.length===100)bounded=true;
  }while(cursor&&!bounded);
  this.runtime.authority.assert(context);const token=randomUUID();this.previews.set(token,{userId:context.userId,epoch:context.authorizationEpoch,revision:String(view.revision),expires:now+600000,items:items.map(({id,ref,proof})=>({id,ref,proof}))});return {token,revision:String(view.revision),count:items.length,skipped,bounded,items:items.map(({ref,proof,...item})=>item)};
 }
 async reprocess(context:UserContext,raw:unknown,files:ReturnType<ReturnType<typeof registerProcessingFiles>>,queue:(token:string,refs:readonly string[],assertPreview:()=>void)=>{queued:number}){
  const {token}=z.object({token:z.string().uuid()}).strict().parse(raw),preview=this.previews.get(token),view=await this.configuration.forUser(context).view();if(!preview||preview.userId!==context.userId||preview.epoch!==context.authorizationEpoch||preview.expires<Date.now()||preview.revision!==String(view.revision))throw new PrivateDataError('conflict',409);
  const result=queue(token,preview.items.map(item=>item.ref),()=>{this.runtime.authority.assert(context);if(this.previews.get(token)!==preview)throw new PrivateDataError('conflict',409);for(const item of preview.items){try{if(files.proof(item.id)!==item.proof)throw new PrivateDataError('conflict',409);}catch(error){if(error instanceof PrivateDataError&&error.code==='not_found')throw new PrivateDataError('conflict',409);throw error;}}});this.previews.delete(token);return result;
 }
 retire(userId:string){for(const [token,preview]of this.previews)if(preview.userId===userId)this.previews.delete(token);}
}
