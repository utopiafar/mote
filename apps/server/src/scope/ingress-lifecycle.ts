import type {DatabaseSync} from 'node:sqlite';
import {existsSync,rmSync} from 'node:fs';
import {z} from 'zod';
import {FILE_MAX_BYTES} from '@mote/shared';
import type {ScopedRuntime} from './http.js';
import type {DomainLifecycle,UserDataSubject,LifecyclePurpose} from './lifecycle.js';
import {PrivateSql,PrivateDataError} from './private-data-sql.js';
import {Originals,identityHash,bytesHash} from './originals.js';
import {storedCaptureSchema} from './capture-original.js';
const domain='ingress',hash=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().min(1).max(256);
const original=z.object({id:hash,source_id:id,capture_id:z.string().uuid(),hash,mime:z.string().max(200),retention:z.enum(['archive','snapshot'])}).strict();
const scope=z.object({capture_id:z.string().uuid(),source_id:id}).strict();
const object=z.object({hash,bytes:z.string().max(Math.ceil(FILE_MAX_BYTES/3)*4)}).strict();
const coverage={originals:true,captureScopes:true,devices:true,excluded:['upload-staging','active-authorizations','pins','tickets','workspaces','receipt-history']} as const;
const payloadSchema=z.object({format:z.literal('mote-ingress-v1'),coverage:z.unknown().refine(value=>JSON.stringify(value)===JSON.stringify(coverage)),originals:z.array(original),scopes:z.array(scope),objects:z.array(object),devices:z.array(z.object({id,json:z.string()}).strict())}).strict();
const invalid=()=>new PrivateDataError('invalid_data');

/** M16 composes this with private-data and execution. Physical failure is
 * retryable uncertainty, never a successful empty deletion/export. Portable
 * restore does not renew an account epoch or resume an upload authorization. */
export function ingressLifecycle(runtime:ScopedRuntime,db:DatabaseSync,directory:string):DomainLifecycle{
 const bound=(subject:UserDataSubject,purpose:LifecyclePurpose)=>{
  const assert=()=>runtime.services.assertSubject(subject,domain,purpose),sql=new PrivateSql(db,subject.userId,assert);
  return {sql,assert,originals:new Originals(directory,subject.deploymentId,sql,assert)};
 };
 return {
  exportUser:async subject=>{
   const {sql,originals}=bound(subject,'export');return sql.transaction(()=>{
    const rows=sql.all('SELECT id,source_id,capture_id,hash,mime,retention FROM ig_originals WHERE user_id=$user ORDER BY id');
    const hashes=[...new Set(rows.map(row=>String(row.hash)))];
    return {domain,version:1,deploymentId:subject.deploymentId,userId:subject.userId,payload:{format:'mote-ingress-v1',coverage,originals:rows,scopes:sql.all('SELECT capture_id,source_id FROM ig_capture_scopes WHERE user_id=$user ORDER BY capture_id'),objects:hashes.map(hash=>({hash,bytes:originals.readObject(hash).toString('base64')})),devices:sql.all('SELECT id,json FROM ig_devices WHERE user_id=$user ORDER BY id')}};
   });
  },
  deleteUser:async(subject,operationId)=>{
   const {sql,originals,assert}=bound(subject,'delete');sql.transaction(()=>{
    sql.run('INSERT INTO ig_state VALUES($user,1) ON CONFLICT(user_id) DO UPDATE SET deleted=1');
    for(const table of ['ig_originals','ig_capture_scopes','ig_uploads','ig_batches','ig_devices','ig_pins','ig_work'])sql.run(`DELETE FROM ${table} WHERE user_id=$user`);
   });
   // A live or interrupted child can still own filesystem work. A crashed
   // activity requires M16 reconciliation; elapsed time is not erasure proof.
   if(sql.get('SELECT id FROM ig_activity WHERE user_id=$user LIMIT 1'))return {status:'result_unknown',operationId};
   try{assert();const path=originals.root();if(existsSync(path))rmSync(path,{recursive:true});assert();}
   catch{return {status:'result_unknown',operationId};}
   sql.transaction(()=>{sql.run('DELETE FROM ig_objects WHERE user_id=$user');sql.run('DELETE FROM ig_restore WHERE user_id=$user');});
   return {status:'complete',operationId};
  },
  restoreUser:async(subject,archive,operationId)=>{
   const {sql,originals}=bound(subject,'restore');
   if(archive.domain!==domain||archive.version!==1||archive.userId!==subject.userId||archive.deploymentId!==subject.deploymentId)throw invalid();
   const payload=payloadSchema.parse(archive.payload),digest=identityHash(payload);
   // Complete validation precedes writes. M02 restores canonical parents first.
   const objects=new Map(payload.objects.map(item=>{const bytes=Buffer.from(item.bytes,'base64');if(bytes.toString('base64')!==item.bytes||bytes.length>FILE_MAX_BYTES||bytesHash(bytes)!==item.hash)throw invalid();return [item.hash,bytes] as const;}));
   if(objects.size!==payload.objects.length||new Set(payload.originals.map(row=>row.id)).size!==payload.originals.length||new Set(payload.originals.map(row=>JSON.stringify([row.source_id,row.capture_id]))).size!==payload.originals.length||new Set(payload.scopes.map(row=>row.capture_id)).size!==payload.scopes.length||new Set(payload.devices.map(row=>row.id)).size!==payload.devices.length)throw invalid();
   const scopes=new Map(payload.scopes.map(row=>[row.capture_id,row.source_id]));
   for(const row of [...payload.scopes,...payload.originals]){
    const parent=sql.get('SELECT json FROM pd_captures WHERE user_id=$user AND id=?',row.capture_id);
    if(!sql.get('SELECT id FROM pd_sources WHERE user_id=$user AND id=?',row.source_id)||!parent)throw invalid();
    const capture=storedCaptureSchema.parse(JSON.parse(String(parent.json))),canonicalSource=capture.provenance?.sourceId??capture.ingressSourceId;
    if(canonicalSource!==row.source_id||!capture.provenance&&scopes.get(row.capture_id)!==row.source_id)throw invalid();
    if('hash' in row&&'mime' in row&&capture.originalImage&&(capture.originalImage.hash!==row.hash||capture.originalImage.mime!==row.mime))throw invalid();
   }
   for(const row of payload.originals)if(!objects.has(row.hash)||row.id!==identityHash([subject.userId,row.source_id,row.capture_id,row.hash,row.mime,row.retention]))throw invalid();
   if(new Set(payload.originals.map(row=>row.hash)).size!==objects.size)throw invalid();
   for(const row of payload.devices){const device=JSON.parse(row.json);if(device.id!==row.id||typeof device.name!=='string'||!['android','macos','windows','linux','import'].includes(device.platform))throw invalid();}
   sql.transaction(()=>{
    const prior=sql.get('SELECT digest FROM ig_restore WHERE user_id=$user AND operation_id=?',operationId);if(prior){if(prior.digest!==digest)throw new PrivateDataError('conflict',409);return;}
    if(sql.get('SELECT id FROM ig_originals WHERE user_id=$user LIMIT 1')||sql.get('SELECT capture_id FROM ig_capture_scopes WHERE user_id=$user LIMIT 1')||sql.get('SELECT id FROM ig_uploads WHERE user_id=$user LIMIT 1')||sql.get('SELECT id FROM ig_devices WHERE user_id=$user LIMIT 1'))throw new PrivateDataError('conflict',409);
    for(const bytes of objects.values())originals.put(bytes);
    for(const row of payload.originals)sql.run('INSERT INTO ig_originals VALUES($user,?,?,?,?,?,?)',row.id,row.source_id,row.capture_id,row.hash,row.mime,row.retention);
    for(const row of payload.scopes)sql.run('INSERT INTO ig_capture_scopes VALUES($user,?,?)',row.capture_id,row.source_id);
    for(const row of payload.devices)sql.run('INSERT INTO ig_devices VALUES($user,?,?)',row.id,row.json);
    sql.run('INSERT INTO ig_state VALUES($user,0) ON CONFLICT(user_id) DO UPDATE SET deleted=0');sql.run('INSERT INTO ig_restore VALUES($user,?,?)',operationId,digest);
   });
  },
 };
}
