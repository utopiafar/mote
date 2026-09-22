import {createHash,createDecipheriv,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,renameSync,rmSync,readdirSync,statSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {join} from 'node:path';
import {FILE_PART_BYTES,FILE_MAX_BYTES} from '@mote/shared';
import {privateDirectory,privateFile} from './private-storage.js';
import {StoreError,type Store} from './store.js';

export type Asset={hash:string;bytes:number;parts:number;format:'chunks'|'image-legacy'|'archive-legacy'};
const hashOf=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const syncDirectory=(path:string)=>{const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}};
/** Authoritative bytes, deduplication, references and GC. Observations retain independent domain IDs. */
export class AssetStore {
 readonly directory:string;
 constructor(private store:Store){
  const root=join(store.directory,'files');privateDirectory(root);this.directory=join(root,'objects');privateDirectory(this.directory);
  store.db.exec(`CREATE TABLE IF NOT EXISTS assets(hash TEXT PRIMARY KEY,bytes INTEGER NOT NULL,parts INTEGER NOT NULL,format TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS asset_parts(hash TEXT NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,part INTEGER NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(hash,part));
   CREATE TABLE IF NOT EXISTS asset_references(owner TEXT PRIMARY KEY,hash TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS asset_references_hash ON asset_references(hash);
   CREATE TABLE IF NOT EXISTS asset_pins(id TEXT PRIMARY KEY,hash TEXT NOT NULL,expires INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS asset_pins_hash ON asset_pins(hash,expires);`);
  this.connect();
 }
 /** Install fixed domain reference projections once, in the same transaction as domain writes. */
 connect(){
  const db=this.store.db;
  for(const [table,id,hash] of [
   ['file_versions',"'file:'||capture_id",'object_hash','chunks','0'],
   ['file_assets',"'artifact:'||artifact_id||':'||name",'object_hash','chunks','0'],
   ['captures',"'capture:'||id",'blob_hash','image-legacy','0'],
   ['archived_files',"'archive:'||id",'hash','archive-legacy','0'],
  ]){
   if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)||db.prepare('SELECT 1 FROM settings WHERE key=?').get('asset-refs-v1:'+table))continue;
   const qualify=(prefix:string)=>id.replace(/\b(capture_id|artifact_id|name|id)\b/g,`${prefix}.$1`);
   const own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
   try{
    db.exec(`INSERT OR REPLACE INTO asset_references SELECT ${id},${hash} FROM ${table} WHERE ${hash} IS NOT NULL;
     CREATE TRIGGER asset_${table}_insert AFTER INSERT ON ${table} WHEN new.${hash} IS NOT NULL BEGIN INSERT OR REPLACE INTO asset_references VALUES(${qualify('new')},new.${hash}); END;
     CREATE TRIGGER asset_${table}_delete AFTER DELETE ON ${table} BEGIN DELETE FROM asset_references WHERE owner=${qualify('old')}; END;
     CREATE TRIGGER asset_${table}_update AFTER UPDATE OF ${hash} ON ${table} BEGIN DELETE FROM asset_references WHERE owner=${qualify('old')}; INSERT OR REPLACE INTO asset_references SELECT ${qualify('new')},new.${hash} WHERE new.${hash} IS NOT NULL; END;`);
    db.prepare('INSERT INTO settings VALUES(?,?)').run('asset-refs-v1:'+table,'1');if(own)db.exec('COMMIT');
   }catch(error){if(own)db.exec('ROLLBACK');throw error;}
  }
  // Metadata migration preserves all IDs/hashes. Legacy readers remain until each object is rewritten.
  for(const [table,format,parts] of [['file_objects','chunks','parts'],['blobs','image-legacy','0'],['file_blobs','archive-legacy','0']]){
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)&&!db.prepare('SELECT 1 FROM settings WHERE key=?').get('asset-catalog-v1:'+table)){
    db.exec(`INSERT OR IGNORE INTO assets SELECT hash,bytes,${parts},'${format}' FROM ${table}`);
    db.prepare('INSERT INTO settings VALUES(?,?)').run('asset-catalog-v1:'+table,'1');
   }
  }
 }
 private directories(){privateDirectory(this.store.directory);privateDirectory(join(this.store.directory,'files'));privateDirectory(this.directory);}
 get(hash:string):Asset{if(!/^[a-f0-9]{64}$/.test(hash))throw new StoreError('Invalid asset hash');const row=this.store.db.prepare('SELECT * FROM assets WHERE hash=?').get(hash);if(!row)throw new StoreError('Asset unavailable',404);if(!['chunks','image-legacy','archive-legacy'].includes(String(row.format))||!Number.isSafeInteger(row.bytes)||Number(row.bytes)<0||Number(row.bytes)>FILE_MAX_BYTES||!Number.isSafeInteger(row.parts)||Number(row.parts)<0||Number(row.parts)>128)throw new StoreError('Invalid asset metadata',500);return row as Asset;}
 hold(hash:string){const id=randomUUID();this.store.db.prepare('INSERT INTO asset_pins VALUES(?,?,?)').run(id,hash,Date.now()+86400000);return ()=>{this.store.db.prepare('DELETE FROM asset_pins WHERE id=?').run(id);};}
 put(bytes:Buffer){return this.putParts([bytes],bytes.length,hashOf(bytes));}
 putParts(chunks:Iterable<Buffer>,expectedBytes:number,expectedHash?:string):Asset & {release:()=>void} {
  if(!Number.isSafeInteger(expectedBytes)||expectedBytes<0||expectedBytes>FILE_MAX_BYTES||expectedHash!==undefined&&!/^[a-f0-9]{64}$/.test(expectedHash))throw new StoreError('Invalid asset size or hash',413);
  this.directories();
  const staging=join(this.directory,(expectedHash??'0'.repeat(64))+'.'+randomUUID()+'.tmp');privateDirectory(staging);
  const digest=createHash('sha256');let size=0,part=0,pending=Buffer.alloc(0);const checksums:string[]=[];
  const write=(bytes:Buffer)=>{checksums.push(hashOf(bytes));this.store.contentEncryption.write(join(staging,String(part++)),bytes);};
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
   const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');let release:(()=>void)|undefined;
   try{
    const destination=join(this.directory,hash),old=db.prepare('SELECT * FROM assets WHERE hash=?').get(hash) as Asset|undefined;
    if(old&&old.bytes!==size)throw new StoreError('Asset size conflict',409);
    this.store.reserveMetadata(old?0:size);
    if(existsSync(destination))this.verify({hash,bytes:size,parts:part,format:'chunks'});
    else {syncDirectory(staging);renameSync(staging,destination);syncDirectory(this.directory);}
    db.prepare("INSERT INTO assets VALUES(?,?,?,'chunks') ON CONFLICT(hash) DO UPDATE SET parts=excluded.parts,format='chunks'").run(hash,size,part);
    for(const [index,checksum] of checksums.entries())db.prepare('INSERT INTO asset_parts VALUES(?,?,?) ON CONFLICT(hash,part) DO UPDATE SET checksum=excluded.checksum').run(hash,index,checksum);
    release=this.hold(hash);if(own)db.exec('COMMIT');
   }catch(error){if(own)db.exec('ROLLBACK');throw error;}
   return {hash,bytes:size,parts:part,format:'chunks',release:release!};
  }finally{rmSync(staging,{recursive:true,force:true});}
 }
 private legacy(asset:Asset){
  this.directories();privateDirectory(this.store.blobsDir);
  if(asset.format==='archive-legacy')return this.store.contentEncryption.read(join(this.store.directory,'files',asset.hash));
  const path=join(this.store.blobsDir,asset.hash);privateFile(path);const raw=readFileSync(path);
  if(raw.subarray(0,5).toString()!=='MOTE1')return raw;
  const key=this.store.contentEncryption.key;if(!key)throw new StoreError('Encrypted asset requires its original key',500);
  const decipher=createDecipheriv('aes-256-gcm',key,raw.subarray(5,17));decipher.setAuthTag(raw.subarray(17,33));return Buffer.concat([decipher.update(raw.subarray(33)),decipher.final()]);
 }
 readLegacyImage(hash:string){if(!/^[a-f0-9]{64}$/.test(hash))throw new StoreError('Invalid asset hash');const bytes=this.legacy({hash,bytes:0,parts:0,format:'image-legacy'});if(hashOf(bytes)!==hash)throw new StoreError('Asset checksum mismatch',500);return bytes;}
 private part(asset:Asset,index:number){this.directories();const parent=join(this.directory,asset.hash);privateDirectory(parent);const bytes=this.store.contentEncryption.read(join(parent,String(index)));const expected=this.store.db.prepare('SELECT checksum FROM asset_parts WHERE hash=? AND part=?').get(asset.hash,index);if(expected&&hashOf(bytes)!==expected.checksum)throw new StoreError('Asset checksum mismatch',500);return bytes;}
 verify(asset:Asset){const digest=createHash('sha256');let total=0;for(const bytes of asset.format==='chunks'?this.parts(asset):[this.legacy(asset)]){total+=bytes.length;digest.update(bytes);}if(total!==asset.bytes||digest.digest('hex')!==asset.hash)throw new StoreError('Asset checksum mismatch',500);}
 private *parts(asset:Asset){for(let index=0;index<asset.parts;index++){const bytes=this.part(asset,index);if(bytes.length!==Math.min(FILE_PART_BYTES,asset.bytes-index*FILE_PART_BYTES))throw new StoreError('Asset part size mismatch',500);yield bytes;}}
 *bytes(hash:string,start=0,end?:number):Generator<Buffer>{
  const asset=this.get(hash);end??=asset.bytes-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end>=asset.bytes||start>end){if(asset.bytes===0&&start===0)return;throw new StoreError('Invalid asset range',416);}
  const release=this.hold(hash);
  try{if(asset.format!=='chunks'){const bytes=this.legacy(asset);if(bytes.length!==asset.bytes||hashOf(bytes)!==hash)throw new StoreError('Asset checksum mismatch',500);yield bytes.subarray(start,end+1);return;}
   for(let part=Math.floor(start/FILE_PART_BYTES);part<=Math.floor(end/FILE_PART_BYTES);part++){const bytes=this.part(asset,part);yield bytes.subarray(Math.max(0,start-part*FILE_PART_BYTES),Math.min(bytes.length,end-part*FILE_PART_BYTES+1));}
  }finally{release();}
 }
 read(hash:string){const asset=this.get(hash),bytes=Buffer.concat([...this.bytes(hash)],asset.bytes);if(hashOf(bytes)!==hash)throw new StoreError('Asset checksum mismatch',500);return bytes;}
 migrate(hash:string){const asset=this.get(hash);if(asset.format==='chunks')return asset;const migrated=this.putParts(this.bytes(hash),asset.bytes,hash);migrated.release();return this.get(hash);}
 sweep(now=Date.now()){
  this.directories();privateDirectory(this.store.blobsDir);
  const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
  try{
  this.store.db.prepare('DELETE FROM asset_pins WHERE expires<=?').run(now);
  let removed=0;
  for(const row of this.store.db.prepare('SELECT * FROM assets a WHERE NOT EXISTS(SELECT 1 FROM asset_references r WHERE r.hash=a.hash) AND NOT EXISTS(SELECT 1 FROM asset_pins p WHERE p.hash=a.hash)').all() as Asset[]){
   this.get(row.hash);
   this.store.db.prepare('DELETE FROM assets WHERE hash=?').run(row.hash);rmSync(join(this.directory,row.hash),{recursive:true,force:true});this.store.contentEncryption.remove(join(this.store.directory,'files',row.hash));rmSync(join(this.store.blobsDir,row.hash),{force:true});removed++;
  }
  for(const name of readdirSync(this.directory))if(/^[a-f0-9]{64}(?:\.[a-f0-9-]+\.tmp)?$/.test(name)&&!this.store.db.prepare('SELECT 1 FROM assets WHERE hash=?').get(name)&&!this.store.db.prepare('SELECT 1 FROM asset_pins WHERE hash=?').get(name.split('.')[0])){const path=join(this.directory,name);if(/^[a-f0-9]{64}$/.test(name)||now-statSync(path).mtimeMs>3600000)rmSync(path,{recursive:true,force:true});}
  if(own)db.exec('COMMIT');return removed;
  }catch(error){if(own)db.exec('ROLLBACK');throw error;}
 }
}
