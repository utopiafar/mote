import {createHash,randomUUID} from 'node:crypto';
import {constants,existsSync,lstatSync,openSync,closeSync,fstatSync,readFileSync,writeFileSync,fsyncSync,renameSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {FILE_PART_BYTES,FILE_MAX_BYTES} from '@mote/shared';
import {privateDirectory} from '../private-storage.js';
import {replaceContentFile} from '../content-encryption.js';
import {prepareAsset} from '../asset-work.js';
import {PrivateDataError,missing,type PrivateSql} from './private-data-sql.js';

export const bytesHash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export const identityHash=(value:unknown)=>bytesHash(Buffer.from(JSON.stringify(value)));
const digest=/^[a-f0-9]{64}$/;
const uuid=/^[a-f0-9-]{36}$/;
const conflict=()=>new PrivateDataError('conflict',409);
const sync=(path:string)=>{const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{fsyncSync(fd);}finally{closeSync(fd);}};
type ObjectRow={hash:string;bytes:number;parts:number};
export type Original={ref:string;sourceId:string;captureId:string;hash:string;bytes:number;mime:string;retention:'snapshot'|'archive'};

/** Scoped adapter for the original AssetStore's chunk layout, checksums, durable
 * replacement and worker. It never opens the legacy Store or another SQLite.
 * Paths are host generated and every ancestor below the admitted vault is checked.
 */
export class Originals{
 constructor(private readonly directory:string,private readonly deploymentId:string,private readonly sql:PrivateSql,private readonly assert:()=>void){}
 private trustedRoot(){privateDirectory(this.directory);const root=join(this.directory,'originals');privateDirectory(root);const user=join(root,identityHash([this.deploymentId,this.sql.userId]));privateDirectory(user);return user;}
 root(){this.assert();return this.trustedRoot();}
 private trustedArea(kind:'objects'|'uploads'|'work'){const path=join(this.trustedRoot(),kind);privateDirectory(path);return path;}
 area(kind:'objects'|'uploads'|'work'){this.assert();return this.trustedArea(kind);}
 private objectPath(hash:string){if(!digest.test(hash))throw missing();const path=join(this.area('objects'),hash);privateDirectory(path);return path;}
 uploadPath(id:string){if(!uuid.test(id))throw missing();const path=join(this.area('uploads'),id);privateDirectory(path);return path;}
 private readFile(path:string){
  this.assert();const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const info=fstatSync(fd);if(!info.isFile()||info.nlink!==1||process.getuid&&info.uid!==process.getuid())throw conflict();const bytes=readFileSync(fd);this.assert();return bytes;}finally{closeSync(fd);}
 }
 private get(hash:string):ObjectRow{const row=this.sql.get('SELECT hash,bytes,parts FROM ig_objects WHERE user_id=$user AND hash=?',hash);if(!row||Number(row.bytes)<0)throw missing();return row as ObjectRow;}
 put(bytes:Buffer){
  this.assert();if(bytes.length>FILE_MAX_BYTES)throw new PrivateDataError('invalid_data',413);
  const hash=bytesHash(bytes),old=this.sql.get('SELECT hash,bytes FROM ig_objects WHERE user_id=$user AND hash=?',hash);
  if(old&&Number(old.bytes)>=0){this.readObject(hash);return this.get(hash);}
  const parent=this.area('objects'),stage=join(parent,hash+'.'+randomUUID()+'.tmp');privateDirectory(stage);
  const checksums:string[]=[];
  try{
   for(let offset=0;offset<bytes.length;offset+=FILE_PART_BYTES){const part=bytes.subarray(offset,offset+FILE_PART_BYTES);checksums.push(bytesHash(part));replaceContentFile(join(stage,String(checksums.length-1))+'.plain',part);}
   sync(stage);this.assert();const destination=join(parent,hash);
   if(existsSync(destination)){this.verifyDirectory(destination,hash,bytes.length,checksums);}
   else {renameSync(stage,destination);sync(parent);}
   this.record(hash,bytes.length,checksums);return this.get(hash);
  }finally{rmSync(stage,{recursive:true,force:true});}
 }
 private verifyDirectory(path:string,hash:string,size:number,checksums:string[]){
  privateDirectory(path);const sum=createHash('sha256');let total=0;
  for(const [index,checksum] of checksums.entries()){const bytes=this.readFile(join(path,String(index)+'.plain'));if(bytesHash(bytes)!==checksum)throw conflict();sum.update(bytes);total+=bytes.length;}
  if(total!==size||sum.digest('hex')!==hash)throw conflict();
 }
 private record(hash:string,size:number,checksums:string[]){
  this.sql.run('INSERT INTO ig_objects VALUES($user,?,?,?) ON CONFLICT(user_id,hash) DO UPDATE SET bytes=excluded.bytes,parts=excluded.parts',hash,size,checksums.length);
  for(const [index,checksum] of checksums.entries())this.sql.run('INSERT INTO ig_parts VALUES($user,?,?,?) ON CONFLICT(user_id,hash,part) DO NOTHING',hash,index,checksum);
 }
 writePart(id:string,part:number,bytes:Buffer){
  const path=join(this.uploadPath(id),String(part)+'.plain');
  if(existsSync(path)){if(!this.readFile(path).equals(bytes))throw conflict();}
  else replaceContentFile(path,bytes);
  this.assert();
 }
 /** Uses the same bounded child worker as existing large-file intake. No SQL
  * transaction or user-selected path crosses the await. Pins protect GC. */
 async prepareUpload(id:string,size:number,hash:string,signal?:AbortSignal){
  this.assert();const parent=this.area('objects'),stage=join(parent,hash+'.'+randomUUID()+'.tmp');privateDirectory(stage);
  const release=this.pin(hash,true);
  try{
   const parts=this.sql.all('SELECT part,checksum,bytes FROM ig_upload_parts WHERE user_id=$user AND upload_id=? ORDER BY part',id).map(row=>({part:Number(row.part),hash:String(row.checksum),bytes:Number(row.bytes)}));
   if(parts.length!==Math.ceil(size/FILE_PART_BYTES))throw conflict();
   const result=await prepareAsset({directory:this.uploadPath(id),staging:stage,destinationRoot:parent,hash,bytes:size,partBytes:FILE_PART_BYTES,parts,encryption:{enabled:false}},signal);
   this.assert();if(result.hash!==hash)throw conflict();
   this.sql.transaction(()=>{
    this.assert();const destination=join(this.area('objects'),hash);
    if(existsSync(destination))this.verifyDirectory(destination,hash,size,result.checksums);
    else {renameSync(stage,destination);sync(parent);}
    this.record(hash,size,result.checksums);
   });
   return {hash,bytes:size,parts:parts.length,release};
  }catch(error){try{release();}catch{/* Revoked pins expire or are removed by lifecycle. */}throw error;}
  finally{rmSync(stage,{recursive:true,force:true});}
 }
 attach(sourceId:string,captureId:string,hash:string,mime:string,retention:'snapshot'|'archive'):Original{
  const id=identityHash([this.sql.userId,sourceId,captureId,hash,mime,retention]),prior=this.sql.get('SELECT hash,mime,retention FROM ig_originals WHERE user_id=$user AND source_id=? AND capture_id=?',sourceId,captureId);
  if(prior&&(prior.hash!==hash||prior.mime!==mime||prior.retention!==retention))throw conflict();
  this.sql.run('INSERT INTO ig_originals VALUES($user,?,?,?,?,?,?) ON CONFLICT(user_id,id) DO NOTHING',id,sourceId,captureId,hash,mime,retention);
  return this.original('original:'+id);
 }
 original(ref:string):Original{
  const id=ref.startsWith('original:')?ref.slice(9):'';if(!digest.test(id))throw missing();
  const row=this.sql.get('SELECT r.*,o.bytes FROM ig_originals r JOIN ig_objects o ON o.user_id=r.user_id AND o.hash=r.hash WHERE r.user_id=$user AND r.id=?',id);if(!row)throw missing();
  return {ref,sourceId:String(row.source_id),captureId:String(row.capture_id),hash:String(row.hash),bytes:Number(row.bytes),mime:String(row.mime),retention:row.retention as Original['retention']};
 }
 read(ref:string,range:{offset?:number;length?:number}={}){
  const original=this.original(ref),offset=range.offset??0,length=range.length??Math.min(FILE_PART_BYTES,original.bytes-offset);
  if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||length>FILE_PART_BYTES||offset>original.bytes||offset+length>original.bytes)throw new PrivateDataError('invalid_data',416);
  const chunks:Buffer[]=[];
  for(let position=offset;position<offset+length;){const index=Math.floor(position/FILE_PART_BYTES),part=this.readPart(original.hash,index),take=Math.min(part.length-position%FILE_PART_BYTES,offset+length-position);if(take<=0)throw conflict();chunks.push(part.subarray(position%FILE_PART_BYTES,position%FILE_PART_BYTES+take));position+=take;}
  this.assert();return {...original,offset,totalBytes:original.bytes,bytes:Buffer.concat(chunks),nextOffset:offset+length<original.bytes?offset+length:null};
 }
 private readPart(hash:string,index:number){
  const object=this.get(hash),row=this.sql.get('SELECT checksum FROM ig_parts WHERE user_id=$user AND hash=? AND part=?',hash,index);
  if(!row)throw missing();const bytes=this.readFile(join(this.objectPath(hash),String(index)+'.plain'));
  if(bytes.length!==Math.min(FILE_PART_BYTES,object.bytes-index*FILE_PART_BYTES)||bytesHash(bytes)!==row.checksum)throw conflict();return bytes;
 }
 readObject(hash:string){const object=this.get(hash),bytes=Buffer.concat(Array.from({length:object.parts},(_,index)=>this.readPart(hash,index)));if(bytesHash(bytes)!==hash)throw conflict();return bytes;}
 pin(hash:string,preparing=false){
  // Preparing pins may precede metadata; reserve the object row so a single
  // shared-DB owner reference protects it throughout worker execution.
  if(preparing&&!this.sql.get('SELECT hash FROM ig_objects WHERE user_id=$user AND hash=?',hash))this.sql.run('INSERT INTO ig_objects VALUES($user,?,-1,0)',hash);
  const id=randomUUID();this.sql.run('INSERT INTO ig_pins VALUES($user,?,?,?)',id,hash,Date.now()+86400000);
  return ()=>{this.sql.run('DELETE FROM ig_pins WHERE user_id=$user AND id=?',id);};
 }
 gc(){return this.sql.transaction(()=>{
  this.sql.run('DELETE FROM ig_pins WHERE user_id=$user AND expires<=?',Date.now());let removed=0;
  const parent=this.area('objects');
  for(const row of this.sql.all('SELECT hash FROM ig_objects o WHERE o.user_id=$user AND NOT EXISTS(SELECT 1 FROM ig_originals r WHERE r.user_id=o.user_id AND r.hash=o.hash) AND NOT EXISTS(SELECT 1 FROM ig_pins p WHERE p.user_id=o.user_id AND p.hash=o.hash)')){
   const hash=String(row.hash);if(!digest.test(hash))throw conflict();const path=join(parent,hash);if(existsSync(path)){privateDirectory(path);rmSync(path,{recursive:true});}this.sql.run('DELETE FROM ig_objects WHERE user_id=$user AND hash=?',hash);removed++;
  }
  for(const name of readdirSync(parent))if(digest.test(name)&&!this.sql.get('SELECT hash FROM ig_objects WHERE user_id=$user AND hash=?',name)){const path=join(parent,name);privateDirectory(path);rmSync(path,{recursive:true});}
  return {removed};
 });}
 cleanUpload(id:string){if(!uuid.test(id))throw missing();const path=join(this.trustedArea('uploads'),id);if(existsSync(path)){privateDirectory(path);rmSync(path,{recursive:true});}}
 cleanWork(id:string){if(!uuid.test(id))throw missing();const path=join(this.trustedArea('work'),id);if(existsSync(path)){privateDirectory(path);rmSync(path,{recursive:true});}}
 async workspace<T>(work:(workspace:{write(name:string,bytes:Buffer):void;read(name:string):Buffer})=>Promise<T>){
  const id=randomUUID(),root=this.area('work'),path=join(root,id);privateDirectory(path);this.sql.run('INSERT INTO ig_work VALUES($user,?,?)',id,Date.now()+86400000);
  const child=(name:string)=>{this.assert();if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)||name==='..')throw new PrivateDataError('invalid_data');privateDirectory(this.area('work'));privateDirectory(path);return join(path,name);};
  try{const result=await work(Object.freeze({write:(name:string,bytes:Buffer)=>{if(!Buffer.isBuffer(bytes)||bytes.length>FILE_MAX_BYTES)throw new PrivateDataError('invalid_data');const target=child(name);if(existsSync(target)){const info=lstatSync(target);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw conflict();}const fd=openSync(target,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);}finally{closeSync(fd);}},read:(name:string)=>this.readFile(child(name))}));this.assert();return result;}
  finally{this.cleanWork(id);try{this.sql.run('DELETE FROM ig_work WHERE user_id=$user AND id=?',id);}catch{/* A revoked metadata row is swept by lifecycle/recovery. */}}
 }
}
