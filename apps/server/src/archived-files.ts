import {randomUUID} from 'node:crypto';
import {readdirSync,unlinkSync} from 'node:fs';
import {basename,join} from 'node:path';
import {z} from 'zod';
import type {ArchivedFile} from '@mote/shared';
import {privateDirectory} from './private-storage.js';
import {Store,StoreError,sha256} from './store.js';

export const MAX_FILE_BYTES=64*1024*1024;
const portableFileSchema=z.object({id:z.string().uuid(),hash:z.string().regex(/^[a-f0-9]{64}$/),name:z.string().min(1).max(1000),relativePath:z.string().min(1).max(1000),mimeType:z.string().min(1).max(200),sizeBytes:z.number().int().min(0).max(MAX_FILE_BYTES),createdAt:z.string().datetime({offset:true}),dataBase64:z.string().max(90_000_000)}).strict();
export type PreparedPortableFile={file:ArchivedFile;bytes:Buffer};
/** Structural path validation only; content interpretation belongs to the import agent. */
export function archiveRelativePath(raw:string):string {
  if(!raw||raw.length>1000||/[\u0000-\u001f]/.test(raw)||raw.includes('\\')||raw.startsWith('/')||/^[a-zA-Z]:/.test(raw))throw new StoreError('Invalid archive path');
  const parts=raw.split('/');if(parts.some(p=>!p||p==='.'||p==='..'))throw new StoreError('Archive paths must be relative and cannot traverse directories');
  return parts.join('/');
}
export class ArchivedFileStore {
  readonly directory:string;
  constructor(public store:Store){
    this.directory=join(store.directory,'files');privateDirectory(this.directory);
    store.db.exec(`CREATE TABLE IF NOT EXISTS file_blobs(hash TEXT PRIMARY KEY,bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS archived_files(id TEXT PRIMARY KEY,hash TEXT NOT NULL REFERENCES file_blobs(hash),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capture_files(capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,file_id TEXT NOT NULL REFERENCES archived_files(id),PRIMARY KEY(capture_id,file_id));`);
  }
  put(input:{name:string;mimeType?:string;bytes:Buffer;relativePath?:string}):ArchivedFile {
    if(input.bytes.length>MAX_FILE_BYTES)throw new StoreError('A file exceeds the 64 MiB limit',413);
    const relativePath=archiveRelativePath(input.relativePath??input.name),name=basename(relativePath),hash=sha256(input.bytes);
    const mimeType=input.mimeType?.trim()||'application/octet-stream';
    if(mimeType.length>200||/[\r\n\u0000]/.test(mimeType))throw new StoreError('Invalid file MIME type');
    const duplicate=this.store.db.prepare("SELECT json FROM archived_files WHERE hash=? AND json_extract(json,'$.relativePath')=? AND json_extract(json,'$.mimeType')=?").get(hash,relativePath,mimeType) as {json:string}|undefined;
    if(duplicate)return JSON.parse(duplicate.json);
    const value:ArchivedFile={id:randomUUID(),hash,name,relativePath,mimeType,sizeBytes:input.bytes.length,createdAt:new Date().toISOString()};
    const known=this.store.db.prepare('SELECT hash FROM file_blobs WHERE hash=?').get(hash);
    this.store.reserveMetadata((known?0:input.bytes.length)+Buffer.byteLength(JSON.stringify(value)));
    this.writeBytes(hash,input.bytes);
    this.store.db.exec('BEGIN IMMEDIATE');
    try{this.store.db.prepare('INSERT OR IGNORE INTO file_blobs(hash,bytes) VALUES(?,?)').run(hash,input.bytes.length);this.store.db.prepare('INSERT INTO archived_files(id,hash,json) VALUES(?,?,?)').run(value.id,hash,JSON.stringify(value));this.store.db.exec('COMMIT');}
    catch(error){this.store.db.exec('ROLLBACK');this.sweepOrphans();throw error;}
    return value;
  }
  private writeBytes(hash:string,original:Buffer){
    const path=join(this.directory,hash);
    if(!this.store.contentEncryption.exists(path))this.store.contentEncryption.write(path,original);
  }

  get(id:string):ArchivedFile {const row=this.store.db.prepare('SELECT json FROM archived_files WHERE id=?').get(id) as {json:string}|undefined;if(!row)throw new StoreError('Archived file not found',404);return JSON.parse(row.json);}
  read(id:string):Buffer {
    const file=this.get(id),original=this.store.contentEncryption.read(join(this.directory,file.hash));
    if(sha256(original)!==file.hash)throw new StoreError('Archived file checksum mismatch',500);return original;
  }
  decrypt(hash:string):boolean {
    if(!/^[a-f0-9]{64}$/.test(hash))throw new StoreError('Invalid file hash');
    return this.store.contentEncryption.decrypt(join(this.directory,hash),bytes=>{if(sha256(bytes)!==hash)throw new StoreError('Archived file checksum mismatch',500);});
  }

  attach(captureId:string,fileIds:string[]):void {
    if(!this.store.evidence([captureId]).length)throw new StoreError('Attachment evidence is missing',409);
    for(const id of new Set(fileIds)){this.get(id);this.store.db.prepare('INSERT OR IGNORE INTO capture_files(capture_id,file_id) VALUES(?,?)').run(captureId,id);}
  }
  listForCapture(captureId:string):ArchivedFile[]{return (this.store.db.prepare('SELECT f.json FROM archived_files f JOIN capture_files c ON c.file_id=f.id WHERE c.capture_id=? ORDER BY f.id').all(captureId) as {json:string}[]).map(r=>JSON.parse(r.json));}
  portableEstimate():number{return Number(this.store.db.prepare('SELECT COALESCE(SUM(length(CAST(f.json AS BLOB))+4*((b.bytes+2)/3)+100),0) AS n FROM archived_files f JOIN file_blobs b ON b.hash=f.hash').get()!.n);}
  exportPortable(){return (this.store.db.prepare('SELECT json FROM archived_files ORDER BY id').all() as {json:string}[]).map(row=>{const file=JSON.parse(row.json) as ArchivedFile;return {...file,dataBase64:this.read(file.id).toString('base64')};});}
  preparePortable(raw:unknown):PreparedPortableFile[]{
    if(!Array.isArray(raw)||raw.length>10000)throw new StoreError('Expected at most 10000 portable files');
    const seen=new Set<string>();let total=0;
    return raw.map(value=>{
      const parsed=portableFileSchema.parse(value),{dataBase64,...file}=parsed;
      archiveRelativePath(file.relativePath);
      if(file.name!==basename(file.relativePath)||/[\r\n\u0000]/.test(file.mimeType))throw new StoreError('Invalid portable file metadata');
      if(seen.has(file.id))throw new StoreError('Duplicate portable file ID');seen.add(file.id);
      if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64))throw new StoreError('Invalid portable file base64');
      const bytes=Buffer.from(dataBase64,'base64');total+=bytes.length;if(total>512*1024*1024)throw new StoreError('Portable files exceed 512 MiB',413);
      if(bytes.length!==file.sizeBytes||sha256(bytes)!==file.hash)throw new StoreError('Portable file checksum or size mismatch');
      const existing=this.store.db.prepare('SELECT json FROM archived_files WHERE id=?').get(file.id) as {json:string}|undefined;
      if(existing){const prior=JSON.parse(existing.json) as ArchivedFile;if((Object.keys(file) as (keyof ArchivedFile)[]).some(key=>file[key]!==prior[key]))throw new StoreError('Portable file ID already has different metadata',409);}
      return {file,bytes};
    });
  }
  /** Called inside the archive transaction; physical writes are swept if that transaction rolls back. */
  restorePortable(prepared:PreparedPortableFile[]){
    for(const {file,bytes}of prepared){
      if(this.store.db.prepare('SELECT id FROM archived_files WHERE id=?').get(file.id))continue;
      const known=this.store.db.prepare('SELECT hash FROM file_blobs WHERE hash=?').get(file.hash);this.store.reserveMetadata((known?0:bytes.length)+Buffer.byteLength(JSON.stringify(file)));
      this.writeBytes(file.hash,bytes);this.store.db.prepare('INSERT OR IGNORE INTO file_blobs(hash,bytes) VALUES(?,?)').run(file.hash,bytes.length);this.store.db.prepare('INSERT INTO archived_files(id,hash,json) VALUES(?,?,?)').run(file.id,file.hash,JSON.stringify(file));
    }
  }
  sweepOrphans(){
    const known=new Set((this.store.db.prepare('SELECT hash FROM file_blobs').all() as {hash:string}[]).map(row=>row.hash));
    for(const name of readdirSync(this.directory))if((/^[a-f0-9]{64}(?:\.plain|\.aes)?$/.test(name)&&!known.has(name.split('.')[0]))||/^[a-f0-9]{64}(?:\.plain|\.aes)?\.[a-f0-9-]+\.tmp$/.test(name))unlinkSync(join(this.directory,name));
  }
  removeUnreferenced(fileIds:string[],retained:Set<string>):{files:number;bytes:number}{
    let files=0,bytes=0;
    for(const id of new Set(fileIds)){
      if(retained.has(id)||this.store.db.prepare('SELECT 1 FROM capture_files WHERE file_id=? LIMIT 1').get(id))continue;
      const row=this.store.db.prepare('SELECT hash FROM archived_files WHERE id=?').get(id) as {hash:string}|undefined;if(!row)continue;
      this.store.db.prepare('DELETE FROM archived_files WHERE id=?').run(id);files++;
      if(!this.store.db.prepare('SELECT 1 FROM archived_files WHERE hash=? LIMIT 1').get(row.hash)){
        const blob=this.store.db.prepare('SELECT bytes FROM file_blobs WHERE hash=?').get(row.hash) as {bytes:number}|undefined;
        this.store.db.prepare('DELETE FROM file_blobs WHERE hash=?').run(row.hash);this.store.contentEncryption.remove(join(this.directory,row.hash));bytes+=blob?.bytes??0;
      }
    }
    return {files,bytes};
  }
}
