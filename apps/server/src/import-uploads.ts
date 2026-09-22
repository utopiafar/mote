import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {rmSync} from 'node:fs';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {Store,StoreError,sha256} from './store.js';
import {ArchivedFileStore,archiveRelativePath,MAX_FILE_BYTES} from './archived-files.js';
import {privateDirectory} from './private-storage.js';
const PART=4*1024*1024;
const manifestSchema=z.object({id:z.string().uuid().optional(),name:z.string().min(1).max(1000),sizeBytes:z.number().int().min(0).max(MAX_FILE_BYTES),mimeType:z.string().max(200).optional()}).strict();
type Manifest=z.infer<typeof manifestSchema>&{id:string;fileId?:string};
/** Bounded binary upload. Each acknowledged part is durable and checksum checked on replay. */
export class ImportUploads {
 private directory:string;
 constructor(private store:Store,private files:ArchivedFileStore){this.directory=join(store.directory,'import-uploads');privateDirectory(this.directory);store.db.exec('CREATE TABLE IF NOT EXISTS import_uploads(id TEXT PRIMARY KEY,expires INTEGER NOT NULL,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS import_upload_parts(upload_id TEXT NOT NULL REFERENCES import_uploads(id) ON DELETE CASCADE,part INTEGER NOT NULL,bytes INTEGER NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(upload_id,part))');}
 private load(id:string):Manifest{const row=this.store.db.prepare('SELECT json FROM import_uploads WHERE id=? AND expires>?').get(id,Date.now());if(!row)throw new StoreError('Upload expired or missing',404);return JSON.parse(String(row.json));}
 begin(raw:unknown){
  const input=manifestSchema.parse(raw),id=input.id??randomUUID();archiveRelativePath(input.name);
  const expired=this.store.db.prepare('SELECT id,json FROM import_uploads WHERE expires<=?').all(Date.now());
  if(expired.length){
   const retained=new Set<string>();
   if(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='import_jobs'").get())for(const row of this.store.db.prepare('SELECT json FROM import_jobs').all())for(const file of JSON.parse(String(row.json)).files??[])retained.add(file.id);
   for(const row of this.store.db.prepare('SELECT json FROM import_uploads WHERE expires>?').all(Date.now())){const fileId=JSON.parse(String(row.json)).fileId;if(fileId)retained.add(fileId);}
   for(const row of expired){const fileId=JSON.parse(String(row.json)).fileId;rmSync(join(this.directory,String(row.id)),{force:true,recursive:true});this.store.db.prepare('DELETE FROM import_uploads WHERE id=?').run(row.id);if(fileId)this.files.removeUnreferenced([fileId],retained);}
  }
  const prior=this.store.db.prepare('SELECT json FROM import_uploads WHERE id=?').get(id);
  if(prior){const {fileId:_,...manifest}=JSON.parse(String(prior.json));if(manifest.name!==input.name||manifest.sizeBytes!==input.sizeBytes||manifest.mimeType!==input.mimeType)throw new StoreError('Upload identity conflict',409);}
  else{if(Number(this.store.db.prepare("SELECT count(*) n FROM import_uploads WHERE json_extract(json,'$.fileId') IS NULL").get()!.n)>=64)throw new StoreError('Too many unfinished imports',429);this.store.reserveMetadata(2048);this.store.db.prepare('INSERT INTO import_uploads VALUES(?,?,?)').run(id,Date.now()+86400000,JSON.stringify({...input,id}));}
  const value=this.load(id);return {id,partBytes:PART,fileId:value.fileId,parts:this.store.db.prepare('SELECT part,bytes,hash FROM import_upload_parts WHERE upload_id=? ORDER BY part').all(id)};
 }
 part(id:string,part:number,bytes:Buffer){const manifest=this.load(id),expected=Math.min(PART,manifest.sizeBytes-part*PART);if(!Buffer.isBuffer(bytes)||!Number.isSafeInteger(part)||part<0||part>=Math.ceil(manifest.sizeBytes/PART)||bytes.length!==expected)throw new StoreError('Invalid import part');
  const hash=sha256(bytes),prior=this.store.db.prepare('SELECT hash FROM import_upload_parts WHERE upload_id=? AND part=?').get(id,part);if(prior){if(prior.hash!==hash)throw new StoreError('Import part conflicts',409);return {part,bytes:bytes.length,hash};}if(manifest.fileId)throw new StoreError('Upload already committed',409);
  this.store.reserveMetadata(bytes.length+128);const directory=join(this.directory,id);privateDirectory(directory);this.store.contentEncryption.write(join(directory,String(part)),bytes);this.store.db.prepare('INSERT INTO import_upload_parts VALUES(?,?,?,?)').run(id,part,bytes.length,hash);return {part,bytes:bytes.length,hash};
 }
 commit(id:string){const manifest=this.load(id);if(manifest.fileId)return this.files.get(manifest.fileId);
  const parts=this.store.db.prepare('SELECT part,bytes,hash FROM import_upload_parts WHERE upload_id=? ORDER BY part').all(id);if(parts.length!==Math.ceil(manifest.sizeBytes/PART))throw new StoreError('Import upload incomplete',409);
  const store=this.store,directory=this.directory;
  function* buffers(){for(const [index,part] of parts.entries()){if(Number(part.part)!==index)throw new StoreError('Missing import part',409);const bytes=store.contentEncryption.read(join(directory,id,String(index)));if(bytes.length!==part.bytes||sha256(bytes)!==part.hash)throw new StoreError('Import checksum mismatch',409);yield bytes;}}
  const file=this.files.putParts({name:manifest.name,mimeType:manifest.mimeType},buffers(),manifest.sizeBytes);
  this.store.db.prepare('UPDATE import_uploads SET json=? WHERE id=?').run(JSON.stringify({...manifest,fileId:file.id}),id);
  this.store.db.prepare('DELETE FROM import_upload_parts WHERE upload_id=?').run(id);rmSync(join(this.directory,id),{force:true,recursive:true});return file;
 }
}
export function registerImportUploads(app:FastifyInstance,store:Store,files:ArchivedFileStore){const uploads=new ImportUploads(store,files);app.post('/api/import-uploads',{bodyLimit:4096,config:{rateLimit:{max:600,timeWindow:'1 minute'}}},async req=>uploads.begin(req.body));app.put('/api/import-uploads/:id/parts/:part',{bodyLimit:PART,config:{rateLimit:{max:600,timeWindow:'1 minute'}}},async req=>{const {id,part}=z.object({id:z.string().uuid(),part:z.coerce.number().int().nonnegative()}).parse(req.params);return uploads.part(id,part,req.body as Buffer);});app.post('/api/import-uploads/:id/commit',{config:{rateLimit:{max:600,timeWindow:'1 minute'}}},async req=>uploads.commit(z.object({id:z.string().uuid()}).parse(req.params).id));}
