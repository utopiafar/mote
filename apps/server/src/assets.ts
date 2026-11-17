import {installSchemaPlan} from './schema-installation.js';
import {assetSchemaInstallation,assetReferenceSchemaInstallations} from './asset-evidence-schema.js';
import {createHash,createDecipheriv,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,renameSync,rmSync,readdirSync,statSync,openSync,closeSync,fsyncSync,unlinkSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {FILE_PART_BYTES,FILE_MAX_BYTES} from '@mote/shared';
import {privateDirectory,privateFile} from './private-storage.js';
import {StoreError,type Store} from './store.js';
import {prepareAsset} from './asset-work.js';
import {readAssetParts,writeAssetPart,assetPartLine,type AssetPart} from './asset-part-metadata.js';

export type Asset={hash:string;bytes:number;parts:number;format:'chunks'};
const hashOf=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const syncDirectory=(path:string)=>{const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}};
/** Buffer-returning consumers have a memory budget; streams do not share it. */
export const ASSET_BUFFER_MAX_BYTES=512*1024*1024;
/** Authoritative bytes, deduplication, references and GC. Observations retain independent domain IDs. */
export class AssetStore {
 readonly directory:string;
 private uploads=new Map<string,Promise<unknown>>();
 constructor(private store:Store){
  const root=join(store.directory,'files');privateDirectory(root);this.directory=join(root,'objects');privateDirectory(this.directory);
  installSchemaPlan(store.db,[assetSchemaInstallation]);
  this.connect();
 }
 /** Install fixed domain reference projections once, in the same transaction as domain writes. */
 connect(){
  const db=this.store.db;
  for(const {table,installation} of assetReferenceSchemaInstallations){
   if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
   installSchemaPlan(db,[installation]);
  }

 }
 private directories(){privateDirectory(this.store.directory);privateDirectory(join(this.store.directory,'files'));privateDirectory(this.directory);}
 get(hash:string):Asset{if(!/^[a-f0-9]{64}$/.test(hash))throw new StoreError('Invalid asset hash');const row=this.store.db.prepare('SELECT * FROM assets WHERE hash=?').get(hash);if(!row)throw new StoreError('Asset unavailable',404);if(row.format!=='chunks'||!Number.isSafeInteger(row.bytes)||Number(row.bytes)<0||Number(row.bytes)>FILE_MAX_BYTES||!Number.isSafeInteger(row.parts)||Number(row.parts)!==Math.ceil(Number(row.bytes)/FILE_PART_BYTES))throw new StoreError('Invalid asset metadata',500);return row as Asset;}
 /** Host-only availability projection. No payload read, checksum claim or new grant.
  * The original reader still decrypts and validates bytes when the owner opens it. */
 retained(hash:string){
  const asset=this.get(hash);
  if(asset.parts!==Math.ceil(asset.bytes/FILE_PART_BYTES))return false;
  for(let part=0;part<asset.parts;part++)if(!this.store.contentEncryption.exists(join(this.directory,hash,String(part))))return false;
  return true;
 }
 hold(hash:string){const id=randomUUID();this.store.db.prepare('INSERT INTO asset_pins VALUES(?,?,?)').run(id,hash,Date.now()+86400000);return ()=>{this.store.db.prepare('DELETE FROM asset_pins WHERE id=?').run(id);};}
 put(bytes:Buffer){return this.putParts([bytes],bytes.length);}
 /** Prepare immutable upload parts outside the event loop and outside SQLite.
  * The pin protects a deduplicated destination and staging from concurrent GC. */
 async putUpload(directory:string,parts:Iterable<AssetPart>,expectedBytes:number,expectedHash:string|undefined,signal?:AbortSignal):Promise<Asset & {release:()=>void}>{
  const key=expectedHash??directory,prior=this.uploads.get(key)??Promise.resolve(),next=prior.catch(()=>{}).then(()=>this.prepareUpload(directory,parts,expectedBytes,expectedHash,signal));
  this.uploads.set(key,next);try{return await next;}finally{if(this.uploads.get(key)===next)this.uploads.delete(key);}
 }
 private async prepareUpload(directory:string,parts:Iterable<AssetPart>,expectedBytes:number,expectedHash:string|undefined,signal?:AbortSignal):Promise<Asset & {release:()=>void}>{
  if(!Number.isSafeInteger(expectedBytes)||expectedBytes<0||expectedBytes>FILE_MAX_BYTES||expectedHash!==undefined&&!/^[a-f0-9]{64}$/.test(expectedHash))throw new StoreError('Invalid asset size or hash',413);
  if(this.store.db.isTransaction)throw new StoreError('Asset preparation cannot run inside a transaction',409);
  this.directories();signal?.throwIfAborted();
  const initialHash=expectedHash??'0'.repeat(64),staging=join(this.directory,initialHash+'.'+randomUUID()+'.tmp');let release=this.hold(initialHash);
  let retained=false;
  try{
   privateDirectory(staging);
   const input=openSync(join(staging,'input-parts'),'wx',0o600);let count=0;
   try{for(const part of parts){signal?.throwIfAborted();if(part.part!==count||!Number.isSafeInteger(part.part)||!Number.isSafeInteger(part.bytes)||part.bytes!==Math.min(FILE_PART_BYTES,expectedBytes-count*FILE_PART_BYTES)||!/^[a-f0-9]{64}$/.test(part.hash))throw new StoreError('Invalid asset part',409);writeAssetPart(input,part);count++;}fsyncSync(input);}finally{closeSync(input);}
   if(count!==Math.ceil(expectedBytes/FILE_PART_BYTES))throw new StoreError('Invalid asset part count',409);
   const encryption=this.store.contentEncryption;
   const enabled=encryption.enabled;
   const result=await prepareAsset({directory,staging,destinationRoot:this.directory,hash:expectedHash,bytes:expectedBytes,partBytes:FILE_PART_BYTES,encryption:{enabled,key:encryption.key?.toString('hex')}},signal);
   signal?.throwIfAborted();
   const actualHash=result.hash;if(!/^[a-f0-9]{64}$/.test(actualHash)||expectedHash&&actualHash!==expectedHash||result.parts!==count)throw new StoreError('Asset checksum mismatch',409);
   if(actualHash!==initialHash){const releaseInitial=release;release=this.hold(actualHash);releaseInitial();}
   const destination=join(this.directory,actualHash);
   if(encryption.enabled!==enabled)throw new StoreError('Content storage settings changed; retry commit',409);
   // Another writer or conversion may have changed the destination while the
   // worker ran. Retry, rather than synchronously scanning it on the HTTP thread.
   if(existsSync(destination)){
    const current=statSync(destination),verified=result.destination;
    if(!verified||current.dev!==verified.dev||current.ino!==verified.ino||current.mtimeMs!==verified.mtimeMs)throw new StoreError('Asset changed during preparation; retry commit',503);
   }else if(result.destination)throw new StoreError('Asset changed during preparation; retry commit',503);
   const db=this.store.db;db.exec('BEGIN IMMEDIATE');
   try{
    const old=db.prepare('SELECT bytes FROM assets WHERE hash=?').get(actualHash);
    if(old&&old.bytes!==expectedBytes)throw new StoreError('Asset size conflict',409);
    db.prepare("INSERT INTO assets VALUES(?,?,?,'chunks') ON CONFLICT(hash) DO UPDATE SET parts=excluded.parts,format='chunks'").run(actualHash,expectedBytes,count);
    const record=db.prepare('INSERT INTO asset_parts VALUES(?,?,?) ON CONFLICT(hash,part) DO UPDATE SET checksum=excluded.checksum');
    const metadata=createHash('sha256');let verified=0;
    for(const part of readAssetParts(join(staging,'verified-parts'))){if(part.bytes!==Math.min(FILE_PART_BYTES,expectedBytes-part.part*FILE_PART_BYTES))throw new StoreError('Invalid prepared part',409);metadata.update(assetPartLine(part));record.run(actualHash,part.part,part.hash);verified++;}
    if(verified!==count||metadata.digest('hex')!==result.metadataHash)throw new StoreError('Prepared part metadata changed',409);
    unlinkSync(join(staging,'input-parts'));unlinkSync(join(staging,'verified-parts'));
    if(!result.destination){renameSync(staging,destination);syncDirectory(this.directory);}
    db.exec('COMMIT');
   }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
   retained=true;return {hash:actualHash,bytes:expectedBytes,parts:count,format:'chunks',release};
  }finally{if(!retained)release();await rm(staging,{recursive:true,force:true});}
 }
 putParts(chunks:Iterable<Buffer>,expectedBytes:number,expectedHash?:string,authorize?:()=>void):Asset & {release:()=>void} {
  if(!Number.isSafeInteger(expectedBytes)||expectedBytes<0||expectedBytes>FILE_MAX_BYTES||expectedHash!==undefined&&!/^[a-f0-9]{64}$/.test(expectedHash))throw new StoreError('Invalid asset size or hash',413);
  authorize?.();
  this.directories();
  const staging=join(this.directory,(expectedHash??'0'.repeat(64))+'.'+randomUUID()+'.tmp');privateDirectory(staging);
  const digest=createHash('sha256');let size=0,part=0,pending=Buffer.alloc(0);const metadataPath=join(staging,'verified-parts');let metadataFd:number|undefined=openSync(metadataPath,'wx',0o600);
  // A single stored part has the same checksum as the complete asset.
  const singlePart=expectedBytes>0&&expectedBytes<=FILE_PART_BYTES;
  const write=(bytes:Buffer)=>{if(!singlePart)writeAssetPart(metadataFd!,{part,hash:hashOf(bytes),bytes:bytes.length});this.store.contentEncryption.write(join(staging,String(part++)),bytes);};
  try{
   for(const chunk of chunks){
    if(!Buffer.isBuffer(chunk)||size+chunk.length>expectedBytes)throw new StoreError('Asset exceeds declared size',409);
    size+=chunk.length;digest.update(chunk);let offset=0;
    if(pending.length){const take=Math.min(FILE_PART_BYTES-pending.length,chunk.length);pending=Buffer.concat([pending,chunk.subarray(0,take)]);offset=take;if(pending.length===FILE_PART_BYTES){write(pending);pending=Buffer.alloc(0);}}
    while(chunk.length-offset>=FILE_PART_BYTES){write(chunk.subarray(offset,offset+FILE_PART_BYTES));offset+=FILE_PART_BYTES;}
    if(offset<chunk.length)pending=Buffer.from(chunk.subarray(offset));
   }
   if(pending.length)write(pending);const hash=digest.digest('hex');
   if(size!==expectedBytes||expectedHash&&hash!==expectedHash)throw new StoreError('Asset checksum mismatch',409);
   if(singlePart)writeAssetPart(metadataFd!,{part:0,hash,bytes:size});fsyncSync(metadataFd!);closeSync(metadataFd!);metadataFd=undefined;
   authorize?.();const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');let release:(()=>void)|undefined,installed=false;
   try{
    authorize?.();
    const destination=join(this.directory,hash),old=db.prepare('SELECT * FROM assets WHERE hash=?').get(hash) as Asset|undefined;
    if(old&&old.bytes!==size)throw new StoreError('Asset size conflict',409);
    if(existsSync(destination))this.verify({hash,bytes:size,parts:part,format:'chunks'});
    db.prepare("INSERT INTO assets VALUES(?,?,?,'chunks') ON CONFLICT(hash) DO UPDATE SET parts=excluded.parts,format='chunks'").run(hash,size,part);
    for(const value of readAssetParts(metadataPath))db.prepare('INSERT INTO asset_parts VALUES(?,?,?) ON CONFLICT(hash,part) DO UPDATE SET checksum=excluded.checksum').run(hash,value.part,value.hash);
    unlinkSync(metadataPath);
    if(!existsSync(destination)){syncDirectory(staging);renameSync(staging,destination);installed=true;syncDirectory(this.directory);}
    release=this.hold(hash);authorize?.();if(own)db.exec('COMMIT');
   }catch(error){if(own){if(db.isTransaction){db.exec('ROLLBACK');}}release?.();if(installed)rmSync(join(this.directory,hash),{recursive:true,force:true});throw error;}
   return {hash,bytes:size,parts:part,format:'chunks',release:release!};
  }finally{if(metadataFd!==undefined)closeSync(metadataFd);rmSync(staging,{recursive:true,force:true});}
 }
 private part(asset:Asset,index:number){this.directories();const parent=join(this.directory,asset.hash);privateDirectory(parent);const path=join(parent,String(index)),selected=existsSync(path+'.plain')?path+'.plain':path+'.aes';privateFile(selected);if(statSync(selected).size>FILE_PART_BYTES+28)throw new StoreError('Asset part exceeds request resources',500);const bytes=this.store.contentEncryption.read(path);const expected=this.store.db.prepare('SELECT checksum FROM asset_parts WHERE hash=? AND part=?').get(asset.hash,index);if(expected&&hashOf(bytes)!==expected.checksum)throw new StoreError('Asset checksum mismatch',500);return bytes;}
 verify(asset:Asset){const digest=createHash('sha256');let total=0;for(const bytes of this.parts(asset)){total+=bytes.length;digest.update(bytes);}if(total!==asset.bytes||digest.digest('hex')!==asset.hash)throw new StoreError('Asset checksum mismatch',500);}
 private *parts(asset:Asset){for(let index=0;index<asset.parts;index++){const bytes=this.part(asset,index);if(bytes.length!==Math.min(FILE_PART_BYTES,asset.bytes-index*FILE_PART_BYTES))throw new StoreError('Asset part size mismatch',500);yield bytes;}}
 *bytes(hash:string,start=0,end?:number):Generator<Buffer>{
  const asset=this.get(hash);end??=asset.bytes-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end>=asset.bytes||start>end){if(asset.bytes===0&&start===0)return;throw new StoreError('Invalid asset range',416);}
  const release=this.hold(hash);
  try{for(let part=Math.floor(start/FILE_PART_BYTES);part<=Math.floor(end/FILE_PART_BYTES);part++){const bytes=this.part(asset,part);yield bytes.subarray(Math.max(0,start-part*FILE_PART_BYTES),Math.min(bytes.length,end-part*FILE_PART_BYTES+1));}
  }finally{release();}
 }
 read(hash:string){const asset=this.get(hash);if(asset.bytes>ASSET_BUFFER_MAX_BYTES)throw new StoreError('Asset exceeds the in-memory read budget; use the original stream',413);const bytes=Buffer.concat([...this.bytes(hash)],asset.bytes);if(hashOf(bytes)!==hash)throw new StoreError('Asset checksum mismatch',500);return bytes;}
 sweep(now=Date.now()){
  this.directories();
  const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
  try{
  this.store.db.prepare('DELETE FROM asset_pins WHERE expires<=?').run(now);
  let removed=0;
  for(const row of this.store.db.prepare('SELECT * FROM assets a WHERE NOT EXISTS(SELECT 1 FROM asset_references r WHERE r.hash=a.hash) AND NOT EXISTS(SELECT 1 FROM asset_pins p WHERE p.hash=a.hash)').all() as Asset[]){
   this.get(row.hash);
   this.store.db.prepare('DELETE FROM assets WHERE hash=?').run(row.hash);rmSync(join(this.directory,row.hash),{recursive:true,force:true});removed++;
  }
  for(const name of readdirSync(this.directory))if(/^[a-f0-9]{64}(?:\.[a-f0-9-]+\.tmp)?$/.test(name)&&!this.store.db.prepare('SELECT 1 FROM assets WHERE hash=?').get(name)&&!this.store.db.prepare('SELECT 1 FROM asset_pins WHERE hash=?').get(name.split('.')[0])){const path=join(this.directory,name);if(/^[a-f0-9]{64}$/.test(name)||now-statSync(path).mtimeMs>3600000)rmSync(path,{recursive:true,force:true});}
  if(own)db.exec('COMMIT');return removed;
  }catch(error){if(own){if(db.isTransaction){db.exec('ROLLBACK');}}throw error;}
 }
}
