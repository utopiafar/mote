import {createHmac,timingSafeEqual,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {captureSchema,sourceItemSchema,sourceIdSchema,sourceConnectionSchema,fileRevisionSchema,FILE_PART_BYTES,type CaptureInput,type SourceItem} from '@mote/shared';
import type {UserContext,UserContextAuthority} from './context.js';
import type {ScopedRuntime} from './http.js';
import {ScopeError} from './baseline.js';
import {PrivateSql,PrivateDataError,missing} from './private-data-sql.js';
import {PrivateData} from './private-data.js';
import {materialDraftSchema} from './material-model.js';
import {Originals,identityHash,bytesHash,type Original} from './originals.js';
import {installIngress,ingressActivity} from './ingress-schema.js';
import {ingressLifecycle} from './ingress-lifecycle.js';
import type {UserDataSubject} from './lifecycle.js';

export const INGRESS_DOMAIN='ingress';
const batchId=z.string().min(1).max(256);
const conflict=()=>new PrivateDataError('conflict',409);
export const strictBase64=(value:string)=>{if(value.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw new PrivateDataError('invalid_data');const bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value)throw new PrivateDataError('invalid_data');return bytes;};
const captureId=(sourceId:string,item:SourceItem)=>{const digest=identityHash([sourceId,item.externalId,item.revision]);return `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;};
export type IngressReceipt={version:3;id:string;deploymentId:string;userId:string;sourceId:string;batchId:string;state:'received';captures:{id:string;duplicate:boolean;original?:Original}[]};
export interface SourceCapability {
 receiveCaptures(sourceId:string,batchId:string,values:unknown[]):IngressReceipt;
 receiveSourceItems(sourceId:string,batchId:string,values:unknown[]):IngressReceipt;
 readOriginal(ref:string,range?:{offset?:number;length?:number}):ReturnType<Originals['read']>;
 pageOriginals(sourceId:string,after?:string,limit?:number):{items:Original[];nextCursor:string|null};
 publishMaterial(draft:unknown,expectedRevision?:string):ReturnType<PrivateData['publishMaterial']>;
 withWorkspace<T>(work:(workspace:{write(name:string,bytes:Buffer):void;read(name:string):Buffer})=>Promise<T>):Promise<T>;
}

/** Only the host retains this registrar. Plugins receive bindSource's frozen
 * facade, never an authority, context, SQL connection or arbitrary path. */
export class IngressHost{
 readonly key:string;
 private readonly active=new Set<string>();
 constructor(private readonly runtime:ScopedRuntime,private readonly db:DatabaseSync,private readonly directory:string){
  this.key=installIngress(db);
  runtime.services.registerUser(INGRESS_DOMAIN,{scope:'user',create:context=>this.forUser(context),lifecycle:ingressLifecycle(runtime,db,directory)});
 }
 private deletionSql(subject:UserDataSubject){
  const assert=()=>{this.runtime.services.assertSubject(subject,INGRESS_DOMAIN,'delete');if('credentialId' in subject)throw new ScopeError('invalid_identity',403);};
  const sql=new PrivateSql(this.db,subject.userId,assert);if(!sql.get('SELECT deleted FROM ig_state WHERE user_id=$user')?.deleted)throw conflict();return sql;
 }
 /** M16 may reconcile a crashed local activity only after independently
  * observing that its old process/worker has stopped. This cannot read data,
  * renew an upload/task grant, or settle a known live operation. */
 pendingErasure(subject:UserDataSubject){return this.deletionSql(subject).all('SELECT id FROM ig_activity WHERE user_id=$user ORDER BY id').map(row=>({id:String(row.id),live:this.active.has(identityHash([subject.userId,row.id]))}));}
 settleErasure(subject:UserDataSubject,id:string,outcome:'stopped'){
  const sql=this.deletionSql(subject);if(outcome!=='stopped'||this.active.has(identityHash([subject.userId,id])))throw conflict();sql.run('DELETE FROM ig_activity WHERE user_id=$user AND id=?',id);
 }
 bindSource(context:UserContext,sourceIds:readonly string[],assertCurrent:()=>void):SourceCapability{
  const ids=Object.freeze([...new Set(z.array(sourceIdSchema).min(1).parse(sourceIds))]);
  const service=this.forUser(context,ids,assertCurrent);
  return Object.freeze({receiveCaptures:service.receiveCaptures,receiveSourceItems:service.receiveSourceItems,readOriginal:service.readOriginal,pageOriginals:service.pageOriginals,publishMaterial:service.publishMaterial,withWorkspace:service.withWorkspace});
 }
 forUser(context:UserContext,sourceIds?:readonly string[],assertCurrent:()=>void=()=>{}){
  const authority:UserContextAuthority=this.runtime.authority;const base=()=>{authority.assert(context);assertCurrent();},state=new PrivateSql(this.db,context.userId,base);
  const assert=()=>{base();if(state.get('SELECT deleted FROM ig_state WHERE user_id=$user')?.deleted)throw new ScopeError('invalid_identity',401);};
  assert();const sql=new PrivateSql(this.db,context.userId,assert),originals=new Originals(this.directory,context.deploymentId,sql,assert);
  const data=()=>this.runtime.services.forUser(context).get<PrivateData>('private-data');
  const deviceId=authority.isTask(context)?undefined:this.runtime.accounts?.credentialInfo(context,authority).deviceId;
  const source=(id:string)=>{
   assert();sourceIdSchema.parse(id);if(sourceIds&&!sourceIds.includes(id))throw missing();const result=data().source(id);
   if(deviceId&&result.deviceId!==deviceId)throw missing();if(!result.enabled)throw conflict();return result;
  };
  const original=(ref:string)=>{assert();const result=originals.original(ref);source(result.sourceId);return result;};
  const during=async<T>(work:()=>Promise<T>)=>{assert();const activity=ingressActivity(this.db,context.userId),key=identityHash([context.userId,activity.id]);this.active.add(key);try{return await work();}finally{this.active.delete(key);activity.finish();}};
  const receipt=(sourceId:string,id:string,captures:IngressReceipt['captures']):IngressReceipt=>({version:3,id:identityHash([context.deploymentId,context.userId,sourceId,id]),deploymentId:context.deploymentId,userId:context.userId,sourceId,batchId:id,state:'received',captures});
  const checkReceipt=(value:IngressReceipt)=>{source(value.sourceId);for(const item of value.captures){data().capture(item.id);if(item.original)original(item.original.ref);}return value;};
  const batch=(sourceId:string,id:string,payload:unknown,write:()=>IngressReceipt)=>sql.transaction(()=>{
   source(sourceId);batchId.parse(id);const digest=identityHash(payload),previous=sql.get('SELECT digest,receipt FROM ig_batches WHERE user_id=$user AND source_id=? AND batch_id=?',sourceId,id);
   if(previous){if(previous.digest!==digest)throw conflict();return checkReceipt(JSON.parse(String(previous.receipt)));}
   const result=write();sql.run('INSERT INTO ig_batches VALUES($user,?,?,?,?)',sourceId,id,digest,JSON.stringify(result));assert();return result;
  });
  const service={
   registerSource:(value:unknown)=>{assert();const input=sourceConnectionSchema.parse(value);if(sourceIds&&!sourceIds.includes(input.id)||deviceId&&input.deviceId!==deviceId)throw new ScopeError('invalid_identity',403);return sql.transaction(()=>data().registerSource(input));},
   registerDevice:(value:unknown)=>{const input=z.object({id:sourceIdSchema,name:z.string().min(1).max(200),platform:z.enum(['android','macos','windows','linux','import'])}).strict().parse(value);if(sourceIds||deviceId&&input.id!==deviceId)throw new ScopeError('invalid_identity',403);return sql.transaction(()=>{sql.run('INSERT INTO ig_devices VALUES($user,?,?) ON CONFLICT(user_id,id) DO UPDATE SET json=excluded.json',input.id,JSON.stringify(input));return input;});},
   devices:()=>{if(deviceId||sourceIds)throw new ScopeError('invalid_identity',403);return {items:sql.all('SELECT json FROM ig_devices WHERE user_id=$user ORDER BY id').map(row=>JSON.parse(String(row.json)))};},
   receiveCaptures:(sourceId:string,id:string,values:unknown[])=>{
    const inputs=z.array(captureSchema).min(1).max(500).parse(values);
    return batch(sourceId,id,inputs,()=>{
     const binding=source(sourceId),images=new Map<string,string>();
     if(binding.retention==='reference')throw conflict();
     for(const input of inputs){
      if(input.deviceId!==binding.deviceId||input.platform!==binding.platform||input.provenance)throw conflict();
      const prior=sql.get('SELECT source_id FROM ig_capture_scopes WHERE user_id=$user AND capture_id=?',input.id);if(prior&&prior.source_id!==sourceId)throw conflict();
      if(input.imageBase64)images.set(input.id,originals.put(strictBase64(input.imageBase64)).hash);
     }
     const acks=data().receiveCaptures(inputs,{sourceId,verify:(input:CaptureInput)=>{if(images.get(input.id)!==bytesHash(strictBase64(input.imageBase64!)))throw conflict();}});
     const captures=acks.map((ack,index)=>{
      sql.run('INSERT INTO ig_capture_scopes VALUES($user,?,?) ON CONFLICT(user_id,capture_id) DO NOTHING',ack.id,sourceId);
      const hash=images.get(ack.id);return {...ack,...(hash?{original:originals.attach(sourceId,ack.id,hash,inputs[index].imageMime!,binding.retention==='archive'?'archive':'snapshot')}:{})};
     });return receipt(sourceId,id,captures);
    });
   },
   receiveSourceItems:(sourceId:string,id:string,values:unknown[])=>{
    const items=z.array(sourceItemSchema).min(1).max(500).parse(values);
    return batch(sourceId,id,items,()=>{
     const binding=source(sourceId),archived=new Map<string,string>();
     if(binding.retention==='archive')for(const item of items)archived.set(captureId(sourceId,item),originals.put(Buffer.from(JSON.stringify(item))).hash);
     const acks=data().receiveSourceItems(sourceId,items,binding.retention==='archive'?{verify:item=>{if(archived.get(captureId(sourceId,item))!==identityHash(item))throw conflict();}}:undefined).receipts;
     return receipt(sourceId,id,acks.map(ack=>({...ack,...(archived.has(ack.id)?{original:originals.attach(sourceId,ack.id,archived.get(ack.id)!,'application/json','archive')}:{})})));
    });
   },
   readOriginal:(ref:string,range?:{offset?:number;length?:number})=>{original(ref);const result=originals.read(ref,range);assert();return result;},
   holdOriginal:(ref:string)=>{const value=original(ref);return originals.pin(value.hash);},
   releaseSnapshot:(ref:string)=>sql.transaction(()=>{const value=original(ref);if(value.retention!=='snapshot')throw new ScopeError('invalid_identity',403);sql.run('DELETE FROM ig_originals WHERE user_id=$user AND id=?',ref.slice(9));}),
   pageOriginals:(sourceId:string,after='',limit=50)=>{
    source(sourceId);if(after&&!/^[a-f0-9]{64}$/.test(after)||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new PrivateDataError('invalid_data');
    const rows=sql.all('SELECT id FROM ig_originals WHERE user_id=$user AND source_id=? AND id>? ORDER BY id LIMIT ?',sourceId,after,limit+1),items=rows.slice(0,limit).map(row=>original('original:'+row.id));
    return {items,nextCursor:rows.length>limit?String(rows[limit-1].id):null};
   },
   publishMaterial:(value:unknown,expectedRevision?:string)=>sql.transaction(()=>{
    const draft=materialDraftSchema.parse(value);source(draft.origin.sourceId);
    const requireCapture=(id:string)=>{const capture=data().capture(id),binding=capture.provenance?.sourceId??sql.get('SELECT source_id FROM ig_capture_scopes WHERE user_id=$user AND capture_id=?',id)?.source_id;if(typeof binding!=='string')throw missing();source(binding);};
    for(const member of draft.members){
     if(member.kind==='capture'&&member.ref.startsWith('capture:'))requireCapture(member.ref.slice(8));
     else if(member.kind==='material'){
      const input=data().material(member.ref);source(input.origin.sourceId);
      for(const row of sql.all('SELECT source_id FROM pd_material_sources WHERE user_id=$user AND material_id=? AND revision=?',input.id,input.revision))source(String(row.source_id));
     }else throw new PrivateDataError('scope_unavailable',503);
    }
    const checkAttribution=(value:any)=>{if(value?.sourceDeclaration)source(value.sourceDeclaration.sourceId);for(const entry of [...(value?.sourceContextDeclarations??[]),...(value?.sourceContextStatements??[])])source(entry.sourceId);};
    checkAttribution(draft.attributionContext);for(const block of draft.blocks)if(block.kind==='text')checkAttribution(block.evidenceContext?.attributionContext);
    const result=data().publishMaterial(draft,expectedRevision);assert();return result;
   }),
   withWorkspace:<T>(work:(workspace:{write(name:string,bytes:Buffer):void;read(name:string):Buffer})=>Promise<T>)=>during(()=>originals.workspace(work)),
   beginUpload:(sourceId:string,value:unknown)=>sql.transaction(()=>{
    const input=z.object({batchId,revision:fileRevisionSchema}).strict().parse(value),binding=source(sourceId),manifest=input.revision;
    if(/^[\\/]|^[a-zA-Z]:/.test(manifest.relativePath)||manifest.relativePath.split(/[\\/]/).some(part=>part==='..'||part.includes('\0')))throw new PrivateDataError('invalid_data');
    if(manifest.sourceId!==sourceId||manifest.item.kind!=='file'||manifest.item.text||binding.retention==='reference'&&manifest.item.layer!=='reference'||binding.retention!=='reference'&&manifest.item.layer==='reference')throw conflict();
    const digest=identityHash(manifest),previous=sql.get('SELECT * FROM ig_uploads WHERE user_id=$user AND source_id=? AND request_key=?',sourceId,input.batchId);
    if(previous){if(previous.manifest_hash!==digest||previous.authorization_epoch!==context.authorizationEpoch||Number(previous.expires)<=Date.now())throw conflict();if(previous.receipt)checkReceipt(JSON.parse(String(previous.receipt)));return {id:String(previous.id),deploymentId:context.deploymentId,userId:context.userId,sourceId,partBytes:FILE_PART_BYTES,parts:sql.all('SELECT part,checksum,bytes FROM ig_upload_parts WHERE user_id=$user AND upload_id=? ORDER BY part',String(previous.id)),...(previous.receipt?{receipt:JSON.parse(String(previous.receipt))}:{})};}
    const id=randomUUID();sql.run('INSERT INTO ig_uploads VALUES($user,?,?,?,?,?,?,?,NULL)',id,sourceId,input.batchId,digest,JSON.stringify(manifest),context.authorizationEpoch,Date.now()+86400000);
    return {id,deploymentId:context.deploymentId,userId:context.userId,sourceId,partBytes:FILE_PART_BYTES,parts:[]};
   }),
   uploadPart:(id:string,part:number,value:unknown)=>sql.transaction(()=>{
    const row=upload(id),manifest=fileRevisionSchema.parse(JSON.parse(String(row.manifest))),input=z.object({bytes:z.string().max(Math.ceil(FILE_PART_BYTES/3)*4),checksum:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(value),bytes=strictBase64(input.bytes);
    if(row.receipt||!manifest.sha256||manifest.item.deleted||!Number.isSafeInteger(part)||part<0||part>=Math.ceil(manifest.sizeBytes/FILE_PART_BYTES)||bytes.length!==Math.min(FILE_PART_BYTES,manifest.sizeBytes-part*FILE_PART_BYTES)||bytesHash(bytes)!==input.checksum)throw conflict();
    const prior=sql.get('SELECT checksum,bytes FROM ig_upload_parts WHERE user_id=$user AND upload_id=? AND part=?',id,part);if(prior&&(prior.checksum!==input.checksum||prior.bytes!==bytes.length))throw conflict();
    originals.writePart(id,part,bytes);sql.run('INSERT INTO ig_upload_parts VALUES($user,?,?,?,?) ON CONFLICT(user_id,upload_id,part) DO NOTHING',id,part,input.checksum,bytes.length);return {part,checksum:input.checksum,bytes:bytes.length};
   }),
   commitUpload:async(id:string)=>during(async()=>{
    const row=upload(id);if(row.receipt)return checkReceipt(JSON.parse(String(row.receipt)));
    const manifest=fileRevisionSchema.parse(JSON.parse(String(row.manifest))),hasBytes=!!manifest.sha256&&!manifest.item.deleted;
    const prepared=hasBytes?await originals.prepareUpload(id,manifest.sizeBytes,manifest.sha256!):undefined;
    let received=false;try{const result=sql.transaction(()=>{
     const current=upload(id);if(current.receipt)return checkReceipt(JSON.parse(String(current.receipt)));
     const binding=source(String(current.source_id)),head=data().sourceItem(binding.id,manifest.item.externalId);
     if((head?.revision??null)!==manifest.previousRevision&&head?.revision!==manifest.item.revision)throw conflict();
     const ack=data().receiveSourceItems(binding.id,[manifest.item],binding.retention==='archive'?{verify:()=>{if(hasBytes&&!prepared)throw conflict();}}:undefined).receipts[0];
     const reference=prepared?originals.attach(binding.id,ack.id,prepared.hash,manifest.item.mimeType??'application/octet-stream',binding.retention==='archive'?'archive':'snapshot'):undefined;
     const result=receipt(binding.id,String(current.request_key),[{...ack,...(reference?{original:reference}:{})}]);sql.run('UPDATE ig_uploads SET receipt=? WHERE user_id=$user AND id=?',JSON.stringify(result),id);assert();return result;
    });received=true;return result;}finally{try{prepared?.release();}catch{/* Revoked pins expire or are removed by lifecycle. */}if(received)originals.cleanUpload(id);}
   }),
   uploadReceipt:(id:string)=>{const row=upload(id);return row.receipt?checkReceipt(JSON.parse(String(row.receipt))):{state:'pending',id,deploymentId:context.deploymentId,userId:context.userId};},
   batchReceipt:(sourceId:string,id:string)=>{source(sourceId);const row=sql.get('SELECT receipt FROM ig_batches WHERE user_id=$user AND source_id=? AND batch_id=?',sourceId,id);if(!row)throw missing();return checkReceipt(JSON.parse(String(row.receipt)));},
   ticket:(ref:string,mode:'download'|'play'='download')=>{original(ref);if(!['download','play'].includes(mode))throw new PrivateDataError('invalid_data');const body=Buffer.from(JSON.stringify({v:3,deployment:context.deploymentId,user:context.userId,credential:context.credentialId,epoch:context.authorizationEpoch,ref,mode,expires:Date.now()+300000})).toString('base64url');return {ticket:body+'.'+createHmac('sha256',this.key).update(body).digest('base64url'),expiresIn:300};},
   verifyTicket:(ref:string,ticket:string)=>{
    try{const [body,signature,...extra]=ticket.split('.'),actual=Buffer.from(signature??'','base64url'),expected=createHmac('sha256',this.key).update(body??'').digest();if(extra.length||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error();const value=JSON.parse(Buffer.from(body,'base64url').toString());if(value.v!==3||value.deployment!==context.deploymentId||value.user!==context.userId||value.credential!==context.credentialId||value.epoch!==context.authorizationEpoch||value.ref!==ref||value.expires<=Date.now())throw Error();original(ref);return value.mode as 'play'|'download';}catch{throw missing();}
   },
   gc:()=>{if(sourceIds||deviceId)throw new ScopeError('invalid_identity',403);return sql.transaction(()=>{
    if(sql.get('SELECT id FROM ig_activity WHERE user_id=$user LIMIT 1'))throw conflict();
    for(const row of sql.all('SELECT id FROM ig_uploads WHERE user_id=$user AND (expires<=? OR authorization_epoch<>?)',Date.now(),context.authorizationEpoch)){originals.cleanUpload(String(row.id));sql.run('DELETE FROM ig_uploads WHERE user_id=$user AND id=?',String(row.id));}
    for(const row of sql.all('SELECT id FROM ig_work WHERE user_id=$user AND expires<=?',Date.now())){originals.cleanWork(String(row.id));sql.run('DELETE FROM ig_work WHERE user_id=$user AND id=?',String(row.id));}
    return originals.gc();
   });},
  };
  function upload(id:string){assert();if(!/^[a-f0-9-]{36}$/.test(id))throw missing();const row=sql.get('SELECT * FROM ig_uploads WHERE user_id=$user AND id=?',id);if(!row)throw missing();source(String(row.source_id));if(row.authorization_epoch!==context.authorizationEpoch||Number(row.expires)<=Date.now())throw conflict();return row;}
  return Object.freeze(service);
 }
}
export type UserIngress=ReturnType<IngressHost['forUser']>;
