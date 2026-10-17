import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {transcriptSchema} from '@mote/shared';
import type {UserContext} from './context.js';
import {registerUserRoute,type ScopedRuntime} from './http.js';
import {PrivateSql,PrivateDataError,missing} from './private-data-sql.js';
import {identityHash} from './originals.js';
import {attachmentOriginalBinding} from './ingress-attachments.js';
import {fileOriginalGeneration} from './ingress-file-forget.js';
import {PROCESSING_DOMAIN,type ProcessingHost} from './processing.js';
import type {TaskExecution} from './task-execution.js';
import type {MemoryHost} from './memory.js';

/** Presentation of M03 originals, M05 tasks and M06/M07 receipts for the
 * existing capture-ID UI. No image ledger, worker or secondary pipeline. */
export function registerProcessingImages(runtime:ScopedRuntime,db:DatabaseSync,host:ProcessingHost,execution:TaskExecution){
 const bind=(context:UserContext,id:string)=>{
  const sql=new PrivateSql(db,context.userId,()=>runtime.authority.assert(context)),service=host.forUser(context);
  const row=sql.get("SELECT r.id FROM ig_originals r JOIN pd_sources s ON s.user_id=r.user_id AND s.id=r.source_id WHERE r.user_id=$user AND s.user_id=$user AND COALESCE(json_extract(s.json,'$.enabled'),1)=1 AND r.capture_id=?",id);if(!row)throw missing();
  const ref='original:'+row.id,status=service.status(ref);
  if(!status.original.mime.startsWith('image/')||!status.current)throw missing();
  const control=sql.get('SELECT generation,cancelled FROM mp_file_controls WHERE user_id=$user AND original_id=?',row.id);
  const proof=identityHash([context.deploymentId,context.userId,ref,status.original.hash,fileOriginalGeneration(sql,ref),control??null,status.appliedPolicy?.id??null,attachmentOriginalBinding(sql,ref)?.id??null]);
  return {sql,service,ref,status,proof};
 };
 const params=(value:unknown)=>z.object({id:z.string().uuid()}).parse(value).id;
 registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'GET',url:'/api/images/:id',handle:async({context,request})=>{
  await host.forUser(context).view();
  const {sql,service,ref,status,proof}=bind(context,params(request.params)),settings=(await service.view()).settings;
  const latest=sql.get('SELECT a.task_id FROM mp_admissions a WHERE a.user_id=$user AND a.original_id=? AND a.task_id IS NOT NULL ORDER BY a.rowid DESC LIMIT 1',ref.slice(9));
  const root=latest?sql.get("SELECT input FROM user_tasks WHERE user_id=$user AND task_id=?",latest.task_id):undefined;
  const rootInput=root?JSON.parse(String(root.input)):undefined;
  const tasks=rootInput?sql.all("SELECT e.id,json_extract(u.input,'$.mode') mode FROM user_tasks u JOIN execution_steps e ON e.user_id=u.user_id AND e.id=u.task_id WHERE u.user_id=$user AND e.user_id=$user AND json_extract(u.input,'$.originalRef')=? AND e.kind LIKE 'processing.%' AND COALESCE(json_extract(u.input,'$.fileGeneration'),0)=? AND COALESCE(json_extract(u.input,'$.originalGeneration'),0)=? AND json_extract(u.input,'$.generation')=? AND json_extract(u.input,'$.policyPlanId') IS ? AND json_extract(u.input,'$.attachmentGeneration') IS ? ORDER BY e.created_at DESC,e.id DESC",ref,Number(rootInput.fileGeneration??0),Number(rootInput.originalGeneration??0),Number(rootInput.generation),rootInput.policyPlanId??null,rootInput.attachmentGeneration??null).map(row=>({...execution.forUser(context).get(String(row.id)),mode:row.mode})):[];
  const jobs=['ocr',...(settings.understandingEnabled?['understanding']:[])].flatMap(name=>{
   const coordinator=tasks.find(task=>task.id===latest?.task_id),task=coordinator&&coordinator.state!=='succeeded'&& !tasks.some(t=>t.kind==='processing.ocr'&&t.state==='running')?coordinator:tasks.find(task=>name==='ocr'?task.kind==='processing.ocr':task.kind==='processing.analysis'&&task.mode==='image')??tasks.find(task=>task.kind==='processing.pipeline');
   return task?[{name,state:task.state,error:task.failure?.code??task.error??undefined}]:[];
  });
  const products=[...(status.artifactId?[{id:status.artifactId,name:'ocr',kind:'ocr'}]:[]),...status.derivations.filter(d=>d.kind==='image').map(d=>({id:d.artifactId,name:'understanding',kind:'image'}))].map(p=>({...p,text:transcriptSchema.parse(service.artifact(String(p.id)).payload).segments.map(s=>s.text).join('\n')}));
  // Exact material revision receipts only; a completed extraction alone never
  // implies Memory completion. Read the existing scoped M07 job for live state.
  const materials=[...(status.materialId?[{id:status.materialId,revision:status.revision!}]:[]),...status.derivations.map(d=>({id:d.materialId,revision:d.revision}))];
  const memoryService=runtime.services.forUser(context).get<ReturnType<MemoryHost['forUser']>>('memory');
  const memory=materials.flatMap(material=>sql.all('SELECT i.state,i.job_id FROM mm_intakes i WHERE i.user_id=$user AND i.material_id=? AND i.revision=? AND i.revoked=0',material.id,material.revision).map(receipt=>{
   if(!receipt.job_id)return {state:String(receipt.state)==='pending'?'waiting':String(receipt.state),count:0};
   const job=memoryService.job(String(receipt.job_id)),steps=Object.values(job.tasks),failure=steps.find(t=>['blocked','failed','cancelled','stale'].includes(t.state));
   const state=!job.current?'stale':job.state==='paused'?'paused':failure?.state??(job.state==='committed'?'completed':steps.some(t=>t.state==='running')?'running':job.state==='awaiting_context'?'waiting_for_input':'waiting');
   const batches=sql.all('SELECT prepared FROM mm_job_batches WHERE user_id=$user AND job_id=?',job.id),count=state==='completed'?batches.reduce((n,b)=>n+(b.prepared?JSON.parse(String(b.prepared)).items?.length??0:0),0):0;
   return {state,count,error:failure?.failure?.code};
  }));
  runtime.authority.assert(context);const current=bind(context,params(request.params));if(current.proof!==proof)throw new PrivateDataError('conflict',409);
  return {proof,original:{state:status.original.available===false?'unavailable':'ready'},automatic:settings.automatic||tasks.length>0,understandingEnabled:settings.understandingEnabled,policy:status.appliedPolicy,wait:service.cancellation(ref).wait,canCancel:service.cancellation(ref).canCancel,processingRequired:status.processingRequired,enabled:settings.enabled,jobs,products,materials:materials.map(m=>({id:m.id,state:'indexed'})),memory};
 }});
 for(const action of ['retry','cancel'] as const)registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'POST',url:'/api/images/:id/'+action,handle:async({context,request})=>{
  const id=params(request.params),input=z.object({proof:z.string().regex(/^[a-f0-9]{64}$/),...(action==='retry'?{operationId:z.string().uuid(),mode:z.enum(['complete','recompute']),confirmUnknown:z.boolean().default(false)}:{})}).strict().parse(request.body),owned=bind(context,id);
  const assertCurrent=()=>{if(bind(context,id).proof!==input.proof)throw new PrivateDataError('conflict',409);};
  if(action==='cancel'){assertCurrent();return owned.service.cancelFile(owned.ref);}
  const retry=input as typeof input&{operationId:string;mode:'complete'|'recompute';confirmUnknown:boolean};
  if(!owned.status.processingRequired)return {queued:false,processingRequired:false};
  return owned.service.retryFile(owned.ref,{operationId:retry.operationId,stage:retry.mode==='complete'?'image-complete':'transcribe',confirmUnknown:retry.confirmUnknown},assertCurrent);
 }});
}
