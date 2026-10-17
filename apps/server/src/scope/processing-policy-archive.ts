import {z} from 'zod';
import {fileTypePattern,matchesFileType,processingProfileSchema} from '@mote/shared';
import {processingServiceReferenceSchema} from './processing-policy-contract.js';
import {PrivateSql,PrivateDataError} from './private-data-sql.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const policyPlanArchiveSchema=z.object({version:z.literal(1),plans:z.array(z.object({id:hash,original_id:hash,json:z.string()}).strict()),bindings:z.array(z.object({original_id:hash,plan_id:hash}).strict())}).strict();
const bodySchema=z.object({
 rule:z.object({sourceId:z.string().min(1).max(128).optional(),type:fileTypePattern,profileId:processingProfileSchema.shape.id}).strict(),
 profile:processingProfileSchema,services:z.array(processingServiceReferenceSchema).max(100),fingerprint:hash,archiveOnly:z.boolean(),
 connections:z.array(z.object({reference:processingServiceReferenceSchema.shape.reference,fingerprint:hash.optional()}).strict()).max(100),
}).strict();
const invalid=()=>new PrivateDataError('invalid_data'),conflict=()=>new PrivateDataError('conflict',409),referenceKey=(value:unknown)=>JSON.stringify(value);
type Control={original_id:string;generation:number;cancelled:number};
/** Applied plans are immutable historical data. The current policy remains the
 * M04-owned YAML projection; its export is already in the configuration domain.
 * Processor contracts were not saved in old plan JSON, so its admission ID is
 * opaque history, not a freshly verified processor receipt or execution grant. */
export function policyPlanArchive(sql:PrivateSql){return {
 export:()=>({version:1 as const,plans:sql.all('SELECT id,original_id,json FROM mp_file_plans WHERE user_id=$user ORDER BY id'),bindings:sql.all('SELECT original_id,plan_id FROM mp_file_policy_bindings WHERE user_id=$user ORDER BY original_id')}),
 prepare:(raw:unknown,controls:Control[])=>{
  if(raw===undefined)return ()=>{}; // Existing processing-v1 archives predate plans.
  const value=policyPlanArchiveSchema.parse(raw),plans=new Map(value.plans.map(row=>[row.id,row]));
  if(plans.size!==value.plans.length||new Set(value.bindings.map(row=>row.original_id)).size!==value.bindings.length)throw invalid();
  for(const row of value.plans){
   const parent=sql.get('SELECT source_id,mime FROM ig_originals WHERE user_id=$user AND id=?',row.original_id);if(!parent)throw invalid();
   const body=bodySchema.parse(JSON.parse(row.json)),{profile,rule,services,connections}=body;
   if(rule.profileId!==profile.id||rule.sourceId!==undefined&&rule.sourceId!==parent.source_id||!matchesFileType(rule.type,String(parent.mime))||body.archiveOnly!==(profile.processorId==='archive'))throw invalid();
   const selected=[profile.serviceId,profile.modelServiceId].filter((id):id is string=>!!id),serviceIds=new Set(services.map(service=>service.id));
   if(serviceIds.size!==services.length||selected.some(id=>!serviceIds.has(id))||services.some(service=>!selected.includes(service.id))||profile.modelServiceId&&services.find(service=>service.id===profile.modelServiceId)?.kind!=='model')throw invalid();
   if(body.archiveOnly&&(selected.length||profile.summarize||Object.keys(profile.parameters).length))throw invalid();
   const references=services.map(service=>referenceKey(service.reference)).sort(),saved=connections.map(connection=>referenceKey(connection.reference)).sort();
   if(JSON.stringify(references)!==JSON.stringify(saved))throw invalid();
   const fingerprints=new Map<string,string|undefined>();for(const connection of connections){const key=referenceKey(connection.reference);if(fingerprints.has(key)&&fingerprints.get(key)!==connection.fingerprint)throw invalid();fingerprints.set(key,connection.fingerprint);}
   const prior=sql.get('SELECT original_id,json FROM mp_file_plans WHERE user_id=$user AND id=?',row.id);if(prior&&(prior.original_id!==row.original_id||prior.json!==row.json))throw conflict();
   if(!prior&&sql.get('SELECT original_id FROM mp_file_policy_bindings WHERE user_id=$user AND plan_id=? LIMIT 1',row.id))throw conflict();
  }
  const fresh=new Map<string,number>();
  for(const binding of value.bindings){
   if(plans.get(binding.plan_id)?.original_id!==binding.original_id)throw invalid();
   const current=sql.get('SELECT b.plan_id,p.original_id FROM mp_file_policy_bindings b LEFT JOIN mp_file_plans p ON p.user_id=b.user_id AND p.id=b.plan_id WHERE b.user_id=$user AND b.original_id=?',binding.original_id);
   if(current){if(current.original_id!==binding.original_id)throw conflict();continue;}
   const local=sql.get('SELECT generation,cancelled FROM mp_file_controls WHERE user_id=$user AND original_id=?',binding.original_id),tasks=sql.all("SELECT u.input,e.state FROM user_tasks u JOIN execution_steps e ON e.id=u.task_id AND e.user_id=u.user_id WHERE u.user_id=$user AND e.user_id=$user AND json_extract(u.input,'$.originalRef')=?",'original:'+binding.original_id).map(row=>({input:JSON.parse(String(row.input)),state:String(row.state)}));
   if(local){
    // Existing local controls win. Never make an unfinished historical task
    // executable by putting its missing plan binding back underneath it.
    if(!local.cancelled&&tasks.some(task=>task.state!=='succeeded'&&task.input.policyPlanId===binding.plan_id&&(task.input.fileGeneration??0)===local.generation))throw conflict();
   }else{
    const generations=[controls.find(control=>control.original_id===binding.original_id)?.generation??0,...tasks.map(task=>task.input.fileGeneration??0)];
    if(generations.some(value=>!Number.isSafeInteger(value)||value<0))throw invalid();const next=generations.reduce((maximum,value)=>Math.max(maximum,value),0)+1;if(!Number.isSafeInteger(next))throw invalid();fresh.set(binding.original_id,next);
   }
  }
  return ()=>{
   for(const row of value.plans)sql.run('INSERT INTO mp_file_plans VALUES($user,?,?,?) ON CONFLICT(user_id,id) DO NOTHING',row.id,row.original_id,row.json);
   for(const binding of value.bindings){
    if(fresh.has(binding.original_id))sql.run('INSERT INTO mp_file_controls VALUES($user,?,?,?) ON CONFLICT(user_id,original_id) DO UPDATE SET generation=excluded.generation',binding.original_id,fresh.get(binding.original_id)!,controls.find(control=>control.original_id===binding.original_id)?.cancelled??0);
    sql.run('INSERT INTO mp_file_policy_bindings VALUES($user,?,?) ON CONFLICT(user_id,original_id) DO NOTHING',binding.original_id,binding.plan_id);
   }
  };
 },
};}
