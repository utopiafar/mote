import {isStateExtension,samples as stateSamples} from '@mote/shared/state-series';
import { moteText } from './i18n.js';
import {textSearch} from './text-search.js';
import {fileSchema} from './file-schema.js';
import {systemEventText,sourceContentTime} from '@mote/shared';
import {memorySchema} from './memory-schema.js';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import {z} from 'zod';
import { sourceConnectionSchema, sourceItemSchema, captureSchema, captureOcrState, type CapturePreview, type OcrState, type CaptureInput, type CaptureRecord, type Heartbeat, type DeviceRecord, type Activity } from '@mote/shared';
import {privateDirectory,privateFile} from './private-storage.js';
import {mediaActivity,type MediaActivityRange} from './media-activity.js';
import {ArchivedFileStore} from './archived-files.js';
import {ContentEncryption,replaceContentFile} from './content-encryption.js';

export class StoreError extends Error { constructor(message:string, public statusCode=400) {super(message);} }
export const sha256 = (v:Buffer|string) => createHash('sha256').update(v).digest('hex');
export type Range = {after?:string;before?:string;deviceId?:string;appId?:string;source?:CaptureInput['source'];collection?:'content'|'activity';limit?:number;cursor?:string;ocrStatus?:OcrState['status']};
type Prepared = {input:CaptureInput;bytes?:Buffer;hash:string|null;fingerprint:string;receivedAt?:string};
type Row = {id:string;json:string;received_at:string;blob_hash:string|null;mime:string|null;index_status:CaptureRecord['indexingStatus'];summary:string|null};
// Media evidence is searchable without rewriting the original screenshot OCR.
function searchText(record:Pick<CaptureInput,'appId'|'appName'|'windowTitle'|'ocrText'|'mood'|'metadata'>) {
  return [record.appId,record.appName,record.windowTitle,record.ocrText,record.mood,
    ...Object.values(record.metadata?.notification??{}).flat(), ...Object.values(record.metadata?.deviceEvent??{}),
    ...(record.metadata?.media?.sessions??[]).flatMap(s=>[s.appId,s.appName,s.title,s.artist,s.album,s.displaySubtitle,s.mediaId])].filter(Boolean).join('\n');
}
export class Store {
  db:DatabaseSync;
  blobsDir:string;
  readonly contentEncryption:ContentEncryption;
  get key(){return this.contentEncryption.key;}
  constructor(public directory:string, private options:{dataKey?:string;contentEncryptionEnabled?:boolean;maxStorageBytes?:number;embeddingEnabled?:boolean}={}) {
    privateDirectory(directory);
    this.blobsDir=join(directory,'blobs'); privateDirectory(this.blobsDir);
    privateFile(join(directory,'mote.sqlite'),true);
    for(const suffix of ['-wal','-shm','-journal'])privateFile(join(directory,`mote.sqlite${suffix}`));
    this.db=new DatabaseSync(join(directory,'mote.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY, device_id TEXT NOT NULL, captured_at TEXT NOT NULL, received_at TEXT NOT NULL,
        json TEXT NOT NULL, fingerprint TEXT NOT NULL, blob_hash TEXT, mime TEXT, index_status TEXT NOT NULL,
        summary TEXT, embedding TEXT, embedding_model TEXT, index_error TEXT, attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS captures_time ON captures(captured_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS captures_device ON captures(device_id,captured_at DESC);
      CREATE INDEX IF NOT EXISTS captures_app ON captures(json_extract(json,'$.appId'),captured_at DESC);
      CREATE INDEX IF NOT EXISTS captures_source ON captures(json_extract(json,'$.source'),captured_at DESC);
      CREATE INDEX IF NOT EXISTS captures_collection ON captures(COALESCE(json_extract(json,'$.privacy.collection'),'content'),captured_at DESC);
      CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, mime TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS insights (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, operation TEXT NOT NULL, changed_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS changes_entity_operation ON changes(id,operation);
      CREATE TABLE IF NOT EXISTS capture_ocr_receipts (id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE, original_fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_connections (id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_versions (source_id TEXT NOT NULL,external_id TEXT NOT NULL,revision TEXT NOT NULL,capture_id TEXT NOT NULL UNIQUE,hash TEXT NOT NULL,PRIMARY KEY(source_id,external_id,revision));
      CREATE TABLE IF NOT EXISTS file_evidence_links(parent_id TEXT NOT NULL,capture_id TEXT NOT NULL,PRIMARY KEY(parent_id,capture_id));
      CREATE TABLE IF NOT EXISTS source_heads (source_id TEXT NOT NULL,external_id TEXT NOT NULL,capture_id TEXT NOT NULL,observed_at TEXT NOT NULL,deleted INTEGER NOT NULL,PRIMARY KEY(source_id,external_id));
      CREATE INDEX IF NOT EXISTS source_head_capture ON source_heads(capture_id);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY,created_at TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_dependencies (memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,evidence_id TEXT NOT NULL,PRIMARY KEY(memory_id,evidence_id));
      CREATE INDEX IF NOT EXISTS memory_dependencies_evidence ON memory_dependencies(evidence_id);
      CREATE TABLE IF NOT EXISTS memory_jobs (id TEXT PRIMARY KEY,created_at TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_batches (id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES memory_jobs(id) ON DELETE CASCADE,idx INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_batch_dependencies (batch_id TEXT NOT NULL REFERENCES memory_batches(id) ON DELETE CASCADE,evidence_id TEXT NOT NULL,PRIMARY KEY(batch_id,evidence_id));
      CREATE INDEX IF NOT EXISTS memory_batch_dependencies_evidence ON memory_batch_dependencies(evidence_id);
      CREATE TABLE IF NOT EXISTS memory_checkpoints (key TEXT PRIMARY KEY,evidence_id TEXT NOT NULL,completed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS conversations_updated ON conversations(updated_at DESC,id DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS captures_fts USING fts5(id UNINDEXED, text, tokenize='unicode61');
      PRAGMA user_version=1;`);
    fileSchema(this.db);
    // Materialized browsing projection: album navigation never reads OCR/metadata JSON or blobs.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capture_gallery (
        id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL, captured_at TEXT NOT NULL, app_id TEXT NOT NULL, app_name TEXT NOT NULL, has_image INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gallery_device_time ON capture_gallery(device_id,captured_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS gallery_app_time ON capture_gallery(device_id,app_id,captured_at DESC,id DESC);
      CREATE TRIGGER IF NOT EXISTS gallery_insert AFTER INSERT ON captures WHEN json_extract(NEW.json,'$.source')='screen' BEGIN
        INSERT INTO capture_gallery VALUES(NEW.id,NEW.device_id,NEW.captured_at,COALESCE(json_extract(NEW.json,'$.appId'),''),COALESCE(json_extract(NEW.json,'$.appName'),''),NEW.blob_hash IS NOT NULL);
      END;
    `);
    if(!this.db.prepare("SELECT 1 FROM settings WHERE key='gallery-v1'").get()) {
      this.db.exec(`BEGIN IMMEDIATE;
        INSERT OR IGNORE INTO capture_gallery SELECT id,device_id,captured_at,COALESCE(json_extract(json,'$.appId'),''),COALESCE(json_extract(json,'$.appName'),''),blob_hash IS NOT NULL FROM captures WHERE json_extract(json,'$.source')='screen';
        INSERT INTO settings(key,value) VALUES('gallery-v1','1'); COMMIT;`);
    }
    this.db.function('mote_ocr_status',{deterministic:true},json=>captureOcrState(JSON.parse(String(json))).status);
    this.db.function('mote_context_end',{deterministic:true},json=>{const c=JSON.parse(String(json));return new Date(c.stateSeries?.samples?.at(-1)?.at??sourceContentTime(c)).toISOString();});
    this.db.function('mote_context_time',{deterministic:true},json=>new Date(sourceContentTime(JSON.parse(String(json)))).toISOString());
    // Add precise dependency rows for archives written before this table existed.
    this.db.exec("INSERT OR IGNORE INTO memory_dependencies(memory_id,evidence_id) SELECT memories.id,entry.value FROM memories,json_each(memories.json,'$.evidenceIds') entry");
    this.db.exec(`INSERT OR IGNORE INTO memory_dependencies SELECT d.memory_id,c.capture_id FROM memory_dependencies d JOIN file_chunks c ON c.id=d.evidence_id;
      INSERT OR IGNORE INTO memory_batch_dependencies SELECT d.batch_id,c.capture_id FROM memory_batch_dependencies d JOIN file_chunks c ON c.id=d.evidence_id;`);
    try{this.contentEncryption=new ContentEncryption(directory,this.db,options);}catch(error){this.db.close();throw error;}
    this.db.function('mote_search_text',{deterministic:true},json=>searchText(JSON.parse(String(json))));
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS captures_trigram USING fts5(id UNINDEXED,text,tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS captures_trigram_insert AFTER INSERT ON captures BEGIN INSERT INTO captures_trigram(id,text) VALUES(new.id,mote_search_text(new.json)); END;
      CREATE TRIGGER IF NOT EXISTS captures_trigram_delete AFTER DELETE ON captures BEGIN DELETE FROM captures_trigram WHERE id=old.id; END;
      CREATE TRIGGER IF NOT EXISTS captures_trigram_update AFTER UPDATE OF json ON captures WHEN new.json!=old.json BEGIN DELETE FROM captures_trigram WHERE id=old.id; INSERT INTO captures_trigram(id,text) VALUES(new.id,mote_search_text(new.json)); END;`);
    if(!this.db.prepare("SELECT 1 FROM settings WHERE key='trigram-v1'").get())this.db.exec("BEGIN IMMEDIATE; INSERT INTO captures_trigram(id,text) SELECT id,mote_search_text(json) FROM captures; INSERT INTO settings VALUES('trigram-v1','1'); COMMIT");
    if(!this.db.prepare('SELECT value FROM settings WHERE key=? AND value=?').get('search_text_version','2')){
      this.db.exec('BEGIN IMMEDIATE');
      try{
        this.db.exec('DELETE FROM captures_fts; INSERT INTO captures_fts(id,text) SELECT id,mote_search_text(json) FROM captures');
        this.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('search_text_version','2');
        this.db.exec('COMMIT');
      }catch(error){this.db.exec('ROLLBACK');this.db.close();throw error;}
    }
    // Remove only orphan content-addressed files left by interrupted writes/transactions.
    this.sweep();
  }
  private record(row:Row):CaptureRecord {
    return {...JSON.parse(row.json),receivedAt:row.received_at,blobHash:row.blob_hash,imageMime:row.mime,indexingStatus:row.index_status,...(row.summary?{summary:row.summary}:{})};
  }
  private clauses(range:Range={}) {
    const clauses:string[]=["(id NOT IN (SELECT capture_id FROM source_versions) OR id IN (SELECT capture_id FROM source_heads WHERE deleted=0) OR id IN (SELECT capture_id FROM file_heads))"]; const values:(string|number)[]=[];
    if(range.after) {clauses.push('mote_context_end(json) >= ?');values.push(new Date(range.after).toISOString());}
    if(range.before) {clauses.push('mote_context_time(json) < ?');values.push(new Date(range.before).toISOString());}
    if(range.deviceId) {clauses.push('device_id = ?');values.push(range.deviceId);}
    if(range.appId!==undefined) {
      clauses.push("((json_extract(json,'$.source') != 'media' AND json_extract(json,'$.appId') = ?) OR (json_extract(json,'$.source') = 'media' AND EXISTS (SELECT 1 FROM json_each(captures.json,'$.metadata.media.sessions') AS session WHERE json_extract(session.value,'$.appId') = ?)))");
      values.push(range.appId,range.appId);
    }
    if(range.source) {clauses.push("json_extract(json,'$.source') = ?");values.push(range.source);}
    if(range.ocrStatus) {
      clauses.push('mote_ocr_status(json) = ?');
      values.push(range.ocrStatus);
    }
    if(range.collection==='activity')clauses.push("json_extract(json,'$.privacy.collection') = 'activity'");
    if(range.collection==='content')clauses.push("json_extract(json,'$.source') != 'activity' AND COALESCE(json_extract(json,'$.privacy.collection'),'content') = 'content'");
    if(range.cursor) {
      try {const c=JSON.parse(Buffer.from(range.cursor,'base64url').toString());if(typeof c.t!=='string'||typeof c.id!=='string')throw Error();clauses.push('(mote_context_time(json) < ? OR (mote_context_time(json) = ? AND id < ?))');values.push(c.t,c.t,c.id);}catch {throw new StoreError('Invalid pagination cursor');}
    }
    return {where:clauses.length?' WHERE '+clauses.join(' AND '):'',values};
  }
  async prepare(raw:unknown):Promise<Prepared> {
    const input=captureSchema.parse(raw); input.capturedAt=new Date(input.capturedAt).toISOString();
    if(input.stateSeries)for(const sample of input.stateSeries.samples)sample.at=new Date(sample.at).toISOString();
    if(Date.parse(input.stateSeries?.samples.at(-1)?.at??input.capturedAt)>Date.now()+86_400_000)throw new StoreError('Capture timestamp is more than one day in the future');
    let bytes:Buffer|undefined; let hash:string|null=null;
    if(input.imageBase64) {
      if(!/^[A-Za-z0-9+/]*={0,2}$/.test(input.imageBase64)||input.imageBase64.length%4!==0)throw new StoreError('Invalid base64 image');
      bytes=Buffer.from(input.imageBase64,'base64');
      if(bytes.length>8*1024*1024)throw new StoreError('Image exceeds 8 MiB',413);
      let meta:Metadata;
      try {meta=await sharp(bytes,{limitInputPixels:24_000_000}).metadata();}catch {throw new StoreError('Unreadable or oversized image');}
      const mime=({jpeg:'image/jpeg',png:'image/png',webp:'image/webp'} as Record<string,string>)[meta.format??''];
      if(mime!==input.imageMime || !meta.width || !meta.height || (meta.pages??1)>1)throw new StoreError('Image content does not match supported single-frame MIME');
      hash=sha256(bytes);
    }
    const {imageBase64:_,...metadata}=input;
    return {input,bytes,hash,fingerprint:sha256(JSON.stringify({...metadata,blobHash:hash}))};
  }
  private writeBlob(hash:string,bytes:Buffer) {
    const path=join(this.blobsDir,hash);
    if(existsSync(path))return;
    let stored=bytes;
    if(this.contentEncryption.enabled) {
      const nonce=randomBytes(12); const cipher=createCipheriv('aes-256-gcm',this.key!,nonce);
      const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);
      stored=Buffer.concat([Buffer.from('MOTE1'),nonce,cipher.getAuthTag(),ciphertext]);
    }
    const temp=join(this.blobsDir,`${hash}.${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(temp,stored,{mode:0o600}); renameSync(temp,path);
  }
  private insert(p:Prepared) {
    const prior=this.db.prepare('SELECT fingerprint,blob_hash,index_status,json,mime FROM captures WHERE id=?').get(p.input.id) as {fingerprint:string;blob_hash:string|null;index_status:string;json:string;mime:string|null}|undefined;
    if(prior) {
      if(p.input.stateSeries){const previous=JSON.parse(prior.json) as CaptureInput;
        if(isStateExtension(previous,p.input)){
          const json=JSON.stringify(p.input);this.reserveMetadata(Math.max(0,Buffer.byteLength(json)-Buffer.byteLength(prior.json)));
          this.db.prepare('UPDATE captures SET json=?,fingerprint=? WHERE id=?').run(json,p.fingerprint,p.input.id);
          return {id:p.input.id,duplicate:true,blobHash:null,indexingStatus:prior.index_status};
        }
        if(isStateExtension(p.input,previous))return {id:p.input.id,duplicate:true,blobHash:null,indexingStatus:prior.index_status};
      }
      const original=this.db.prepare('SELECT original_fingerprint FROM capture_ocr_receipts WHERE id=?').get(p.input.id) as {original_fingerprint:string}|undefined;
      if(prior.fingerprint!==p.fingerprint && original?.original_fingerprint!==p.fingerprint){
        const previous=captureSchema.innerType().parse({...JSON.parse(prior.json),imageMime:prior.mime??undefined});
        const immutable=(input:CaptureInput)=>{const {imageBase64:_,ocr:_ocr,ocrText:_text,...fields}=input;return JSON.stringify(fields);};
        // A portable archive contains the latest OCR, while a restored client may
        // still hold its original pending delivery. Only unchanged screenshot facts
        // and image bytes may replay; the completed text is never overwritten.
        const restoredPending=p.input.ocr?.status==='pending' && ['completed','failed'].includes(previous.ocr?.status??'')
          && p.hash===prior.blob_hash && immutable(p.input)===immutable(previous);
        if(!restoredPending)throw new StoreError('Event ID already exists with different content',409);
        this.db.prepare('INSERT OR IGNORE INTO capture_ocr_receipts(id,original_fingerprint) VALUES(?,?)').run(p.input.id,p.fingerprint);
      }
      return {id:p.input.id,duplicate:true,blobHash:prior.blob_hash,indexingStatus:prior.index_status};
    }
    if(this.db.prepare("SELECT seq FROM changes WHERE id=? AND operation='delete' LIMIT 1").get(p.input.id))throw new StoreError('This event was deleted; queued retries cannot restore it. Import into a fresh vault or create a new explicitly authorized event.',410);
    const {imageBase64:_,imageMime,...metadata}=p.input;
    const json=JSON.stringify(metadata);
    const known=p.hash ? this.db.prepare('SELECT hash FROM blobs WHERE hash=?').get(p.hash):null;
    const estimatedNewBytes=Buffer.byteLength(json)+(known?0:p.bytes?.length??0);
    if(this.options.maxStorageBytes && this.logicalBytes()+estimatedNewBytes>this.options.maxStorageBytes)throw new StoreError('Vault storage limit reached; free space or increase MOTE_MAX_STORAGE_MB',507);
    if(p.hash&&p.bytes) {
      this.writeBlob(p.hash,p.bytes);
      this.db.prepare('INSERT OR IGNORE INTO blobs(hash,bytes,mime) VALUES(?,?,?)').run(p.hash,p.bytes.length,imageMime!);
    }
    const status=this.options.embeddingEnabled&&p.input.source!=='activity'&&p.input.ocrText.trim()?'pending':'text_ready';
    const receivedAt=p.receivedAt??new Date().toISOString();
    this.db.prepare('INSERT INTO captures(id,device_id,captured_at,received_at,json,fingerprint,blob_hash,mime,index_status) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(p.input.id,p.input.deviceId,p.input.capturedAt,receivedAt,json,p.fingerprint,p.hash,imageMime??null,status);
    this.db.prepare('INSERT INTO captures_fts(id,text) VALUES(?,?)').run(p.input.id,searchText(p.input));
    this.db.prepare('INSERT INTO changes(id,operation,changed_at) VALUES(?,?,?)').run(p.input.id,'upsert',new Date().toISOString());
    const device=this.db.prepare('SELECT json FROM devices WHERE id=?').get(p.input.deviceId) as {json:string}|undefined;
    if(!device)this.heartbeat({deviceId:p.input.deviceId,deviceName:p.input.deviceName,platform:p.input.platform,status:'offline',queueDepth:0,lastCaptureAt:p.input.capturedAt,...(p.input.metadata?{metadata:p.input.metadata}:{})});
    return {id:p.input.id,duplicate:false,blobHash:p.hash,indexingStatus:status};
  }
  async ingest(raw:unknown,transaction?:(result:{id:string;duplicate:boolean})=>void) {
    const p=await this.prepare(raw);
    this.db.exec('BEGIN IMMEDIATE');
    try {const result=this.insert(p);transaction?.(result);this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');this.sweep();throw e;}
  }
  async importArchive(raw:unknown) {
    const archive=raw as {version?:number;captures?:unknown[];sources?:unknown[];sourceHeads?:unknown[];sourceVersions?:unknown[];memories?:unknown[];files?:unknown[];captureFiles?:unknown[]};
    if(archive?.version!==1||!Array.isArray(archive.captures)||archive.captures.length>20000)throw new StoreError('Expected Mote archive version 1 (maximum 20,000 records per import)');
    const connections=(archive.sources??[]).map(v=>{const {createdAt,updatedAt,status,...fields}=v as Record<string,unknown>;const value=sourceConnectionSchema.parse(fields);return {...value,createdAt:typeof createdAt==='string'?createdAt:new Date().toISOString(),updatedAt:typeof updatedAt==='string'?updatedAt:new Date().toISOString()};});
    if(connections.length>500)throw new StoreError('Too many source connections');
    const prepared:Prepared[]=[];
    for(const entry of archive.captures) {
      if(!entry||typeof entry!=='object'||Array.isArray(entry))throw new StoreError('Archive entries must be capture objects');
      const {blobHash,receivedAt,...capture}=entry as CaptureInput & {blobHash?:string|null;receivedAt?:string};
      const p=await this.prepare(capture);
      if(receivedAt!==undefined) {if(typeof receivedAt!=='string'||!Number.isFinite(Date.parse(receivedAt)))throw new StoreError('Invalid archive receivedAt timestamp');p.receivedAt=new Date(receivedAt).toISOString();}
      if(blobHash!==undefined&&blobHash!==p.hash)throw new StoreError('Archive image checksum mismatch');
      prepared.push(p);
    }
    const memoryEntries=z.array(memorySchema).max(100000).parse(archive.memories??[]);
    const archivedFiles=new ArchivedFileStore(this),portableFiles=archivedFiles.preparePortable(archive.files??[]);
    const fileLinks=z.array(z.object({captureId:z.string().uuid(),fileId:z.string().uuid()}).strict()).max(100000).parse(archive.captureFiles??[]);
    const captureIds=new Set(prepared.map(p=>p.input.id)),fileIds=new Set(portableFiles.map(p=>p.file.id));
    const knownFile=(id:string)=>fileIds.has(id)||Boolean(this.db.prepare('SELECT id FROM archived_files WHERE id=?').get(id));
    for(const link of fileLinks)if((!captureIds.has(link.captureId)&&!this.evidence([link.captureId]).length)||!knownFile(link.fileId))throw new StoreError('Portable attachment references a missing capture or file');
    if(archive.files!==undefined)for(const record of prepared){const document=record.input.provenance?.document;for(const id of [document?.fileId,...(document?.attachments??[]).map(a=>a.id)].filter((id):id is string=>Boolean(id))){if(!knownFile(id))throw new StoreError('Portable document references a missing original file');fileLinks.push({captureId:record.input.id,fileId:id});}}
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let imported=0,duplicates=0;
      archivedFiles.restorePortable(portableFiles);
      for(const p of prepared)this.insert(p).duplicate?duplicates++:imported++;
      for(const link of fileLinks)archivedFiles.attach(link.captureId,[link.fileId]);
      for(const c of connections){const prior=this.db.prepare('SELECT json FROM source_connections WHERE id=?').get(c.id) as {json:string}|undefined;if(prior){const original=JSON.parse(prior.json);if(original.deviceId!==c.deviceId||original.kind!==c.kind)throw new StoreError('Source identity conflict',409);}else this.db.prepare('INSERT INTO source_connections(id,json) VALUES(?,?)').run(c.id,JSON.stringify({...c,enabled:false}));}
      for(const rawVersion of archive.sourceVersions??[]){const v=rawVersion as Record<string,unknown>;if(typeof v.capture_id!=='string'||typeof v.source_id!=='string'||typeof v.external_id!=='string'||typeof v.revision!=='string'||typeof v.hash!=='string'||!(/^[a-f0-9]{64}$/.test(v.hash)))throw new StoreError('Invalid source revision');const e=this.evidence([v.capture_id])[0];if(!e?.provenance||e.provenance.sourceId!==v.source_id||e.provenance.externalId!==v.external_id||e.provenance.revision!==v.revision||!this.db.prepare('SELECT id FROM source_connections WHERE id=?').get(v.source_id))throw new StoreError('Source revision evidence mismatch');const p=e.provenance;const {observedAt:_,...semantic}=sourceItemSchema.parse({externalId:p.externalId,revision:p.revision,observedAt:e.capturedAt,modifiedAt:p.modifiedAt,title:e.windowTitle,text:p.deleted||p.layer==='reference'?'':e.ocrText,uri:p.uri,kind:e.source,layer:p.layer,mimeType:p.mimeType,calendar:p.calendar,deleted:p.deleted,metadata:p.metadata,document:p.document});if(sha256(JSON.stringify(semantic))!==v.hash)throw new StoreError('Source revision checksum mismatch');this.db.prepare('INSERT OR IGNORE INTO source_versions(source_id,external_id,revision,capture_id,hash) VALUES(?,?,?,?,?)').run(v.source_id,v.external_id,v.revision,v.capture_id,v.hash);}
      for(const rawHead of archive.sourceHeads??[]){const h=rawHead as Record<string,unknown>;if(typeof h.capture_id!=='string'||typeof h.source_id!=='string'||typeof h.external_id!=='string'||typeof h.observed_at!=='string'||!Number.isFinite(Date.parse(h.observed_at))||![0,1].includes(Number(h.deleted)))throw new StoreError('Invalid source pointer');const v=this.db.prepare('SELECT capture_id FROM source_versions WHERE source_id=? AND external_id=? AND capture_id=?').get(h.source_id,h.external_id,h.capture_id);if(!v)throw new StoreError('Source pointer has no revision');const e=this.evidence([h.capture_id])[0];if(!e||Date.parse(h.observed_at)!==Date.parse(e.capturedAt)||Number(h.deleted)!==Number(e.provenance?.deleted))throw new StoreError('Source pointer metadata mismatch');const priorHead=this.db.prepare('SELECT capture_id,observed_at FROM source_heads WHERE source_id=? AND external_id=?').get(h.source_id,h.external_id) as {capture_id:string;observed_at:string}|undefined;if(priorHead&&Date.parse(priorHead.observed_at)===Date.parse(h.observed_at)&&priorHead.capture_id!==h.capture_id)throw new StoreError('Equal observation times contain conflicting source heads',409);const moved=this.db.prepare('INSERT INTO source_heads(source_id,external_id,capture_id,observed_at,deleted) VALUES(?,?,?,?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET capture_id=excluded.capture_id,observed_at=excluded.observed_at,deleted=excluded.deleted WHERE excluded.observed_at>source_heads.observed_at').run(h.source_id,h.external_id,h.capture_id,new Date(h.observed_at).toISOString(),Number(h.deleted));if(moved.changes&&priorHead&&priorHead.capture_id!==h.capture_id){this.invalidateMemoryEvidence(priorHead.capture_id);this.db.prepare("INSERT INTO changes(id,operation,changed_at) VALUES(?,'supersede',?)").run(priorHead.capture_id,new Date().toISOString());}}
      for(const m of memoryEntries){if(m.evidenceIds.some(id=>!this.evidence([id]).length))throw new StoreError('Memory archive is missing supporting evidence');for(const e of m.evidence??[]){const record=this.evidence([e.id])[0];if(!m.evidenceIds.includes(e.id)||!record||(e.quote!==undefined&&(e.offset===undefined||e.length!==e.quote.length||record.ocrText.slice(e.offset,e.offset+e.length)!==e.quote)))throw new StoreError('Memory archive evidence quote mismatch');}this.db.prepare('INSERT OR IGNORE INTO memories(id,created_at,json) VALUES(?,?,?)').run(m.id,m.createdAt,JSON.stringify({...m,status:'stale',staleReason:'restored_archive'}));for(const id of m.evidenceIds)this.db.prepare('INSERT OR IGNORE INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(m.id,id);}
      // Merging individually valid archives must still respect the destination's total limits.
      if(Number(this.db.prepare('SELECT COUNT(*) AS n FROM source_connections').get()!.n)>500)throw new StoreError('Maximum 500 sources',413);
      if(Number(this.db.prepare('SELECT COUNT(*) AS n FROM memories').get()!.n)>100000)throw new StoreError('Memory limit reached',507);
      this.reserveMetadata(0);
      this.db.exec('COMMIT');return {imported,duplicates};
    }catch(e){this.db.exec('ROLLBACK');this.sweep();archivedFiles.sweepOrphans();throw e;}
  }
  list(range:Range={}) {
    const {where,values}=this.clauses(range);const limit=Math.min(200,Math.max(1,range.limit??50));
    const rows=this.db.prepare(`SELECT * FROM captures${where} ORDER BY mote_context_time(json) DESC,id DESC LIMIT ?`).all(...values,limit+1) as unknown as Row[];
    const {cursor:_cursor,...scope}=range;const totalScope=this.clauses(scope);
    const totalCount=Number((this.db.prepare(`SELECT COUNT(*) AS count FROM captures${totalScope.where}`).get(...totalScope.values) as {count:number}).count);
    const more=rows.length>limit;const items=rows.slice(0,limit).map(r=>this.record(r));const last=items.at(-1);
    return {items,nextCursor:more&&last?Buffer.from(JSON.stringify({t:new Date(sourceContentTime(last)).toISOString(),id:last.id})).toString('base64url'):null,totalCount};
  }
  evidence(ids:string[]) {return ids.slice(0,200).map(id=>this.db.prepare('SELECT * FROM captures WHERE id=?').get(id) as Row|undefined).filter((x):x is Row=>Boolean(x)).map(r=>this.record(r));}
  isCurrentEvidence(id:string):boolean {
    return Boolean(this.db.prepare('SELECT id FROM captures WHERE id=? AND (id NOT IN (SELECT capture_id FROM source_versions) OR id IN (SELECT capture_id FROM source_heads WHERE deleted=0))').get(id));
  }
  /** Called inside the evidence mutation transaction so in-flight extraction cannot revive old claims. */
  invalidateMemoryEvidence(id:string,deleted=false) {
    const excerpts=this.db.prepare('SELECT capture_id FROM file_evidence_links WHERE parent_id=?').all(id) as {capture_id:string}[];
    this.db.prepare('DELETE FROM file_evidence_links WHERE parent_id=?').run(id);
    for(const excerpt of excerpts){this.invalidateMemoryEvidence(excerpt.capture_id,deleted);this.db.prepare('UPDATE source_heads SET deleted=1 WHERE capture_id=?').run(excerpt.capture_id);if(deleted){this.db.prepare('DELETE FROM captures_fts WHERE id=?').run(excerpt.capture_id);this.db.prepare('DELETE FROM captures WHERE id=?').run(excerpt.capture_id);}}

    this.db.exec('DELETE FROM insights');
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='working_memories'").get())this.db.exec('DELETE FROM working_memories');
    if(deleted)this.db.prepare('DELETE FROM memories WHERE id IN (SELECT memory_id FROM memory_dependencies WHERE evidence_id=?)').run(id);
    else this.db.prepare("UPDATE memories SET json=json_set(json,'$.status','stale','$.staleReason','evidence_changed','$.updatedAt',?) WHERE id IN (SELECT memory_id FROM memory_dependencies WHERE evidence_id=?)").run(new Date().toISOString(),id);
    this.db.prepare('DELETE FROM memory_checkpoints WHERE evidence_id=? OR evidence_id IN (SELECT evidence_id FROM memory_batch_dependencies WHERE batch_id IN (SELECT batch_id FROM memory_batch_dependencies WHERE evidence_id=?))').run(id,id);
    this.db.prepare("UPDATE memory_batches SET json=json_set(json,'$.status','invalidated','$.errorCode',?) WHERE id IN (SELECT batch_id FROM memory_batch_dependencies WHERE evidence_id=?)").run(deleted?'evidence_deleted':'evidence_changed',id);
  }
  previews(range:Range={}) {
    const page=this.list(range);
    const items:CapturePreview[]=page.items.map(record=>({id:record.id,deviceId:record.deviceId,deviceName:record.deviceName,platform:record.platform,
      capturedAt:record.capturedAt,source:record.source,appId:record.appId,appName:record.appName,windowTitle:record.windowTitle.slice(0,300),
      ...(record.stateSeries?{stateSummary:{count:record.stateSeries.samples.length,lastAt:record.stateSeries.samples.at(-1)!.at}}:{}),durationMs:record.durationMs,hasImage:Boolean(record.blobHash),ocr:captureOcrState(record),
      sizeBytes:Buffer.byteLength(record.ocrText)+(record.blobHash?Number(this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(record.blobHash)?.bytes??0):Number(record.provenance?.metadata?.file?.sizeBytes??0)),
      ...(record.metadata?.media?{media:record.metadata.media}:{}),
      textPreview:(record.source==='media'?(record.metadata?.media?.sessions.map(s=>[s.title,s.artist,s.appName].filter(Boolean).join(' · ')).join(' / ')||({available:moteText("未观察到媒体会话"),disabled:moteText("媒体采集已关闭"),permission_required:moteText("媒体权限未授予"),unavailable:moteText("媒体信息暂不可用")}[record.metadata?.media?.status??'unavailable'])):record.source==='notification'||record.source==='device_event'?systemEventText(record.metadata):record.ocrText).slice(0,160)}));
    return {...page,items};
  }
  gallery(range:{after:string;before:string;deviceId?:string;appId?:string;cursor?:string;limit:number}, albums:boolean) {
    const filters=['captured_at>=?','captured_at<?',"(id NOT IN (SELECT capture_id FROM source_versions) OR id IN (SELECT capture_id FROM source_heads WHERE deleted=0) OR id IN (SELECT capture_id FROM file_heads))"];const args:(string|number)[]=[new Date(range.after).toISOString(),new Date(range.before).toISOString()];
    if(range.deviceId){filters.push('device_id=?');args.push(range.deviceId);}
    if(range.appId!==undefined){filters.push('app_id=?');args.push(range.appId);}
    let cursor: {at:string;id:string}|{after:string;deviceId:string;appId:string}|undefined;
    if(range.cursor){
      try{cursor=(albums?z.object({after:z.string().datetime(),deviceId:z.string(),appId:z.string()}):z.object({at:z.string().datetime(),id:z.string().uuid()})).strict().parse(JSON.parse(Buffer.from(range.cursor,'base64url').toString()));}
      catch{throw new StoreError('Invalid album cursor');}
    }
    const scope=`FROM capture_gallery WHERE ${filters.join(' AND ')}`;
    const totalCount=Number(this.db.prepare(`SELECT COUNT(*) AS n ${scope}`).get(...args)!.n);
    if(!albums){
      const position=cursor as {at:string;id:string}|undefined;
      const seek=position?' AND (captured_at<? OR (captured_at=? AND id<?))':'';
      const rows=this.db.prepare(`SELECT id,device_id AS deviceId,captured_at AS capturedAt,app_id AS appId,app_name AS appName,has_image AS hasImage ${scope}${seek} ORDER BY captured_at DESC,id DESC LIMIT ?`).all(...args,...(position?[position.at,position.at,position.id]:[]),range.limit+1);
      const items=rows.slice(0,range.limit).map(row=>({...row,source:'screen',hasImage:Boolean(row.hasImage)}));
      const last=items.at(-1) as {capturedAt:string;id:string}|undefined;
      return {items,totalCount,nextCursor:rows.length>range.limit&&last?Buffer.from(JSON.stringify({at:last.capturedAt,id:last.id})).toString('base64url'):null};
    }
    const bucket="CAST(strftime('%s',captured_at) AS INTEGER)/900";
    const group=`${scope} GROUP BY device_id,app_id,${bucket}`;
    const albumCount=Number(this.db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 ${group})`).get(...args)!.n);
    const position=cursor as {after:string;deviceId:string;appId:string}|undefined;
    const seek=position?` HAVING (${bucket}<? OR (${bucket}=? AND (device_id>? OR (device_id=? AND app_id>?))))`:'';
    const boundary=position?Math.floor(Date.parse(position.after)/900000):0;
    const rows=this.db.prepare(`SELECT id,device_id AS deviceId,app_id AS appId,app_name AS appName,MIN(captured_at) AS firstAt,MAX(captured_at) AS capturedAt,COUNT(*) AS count,SUM(has_image) AS imageCount ${group}${seek} ORDER BY ${bucket} DESC,device_id,app_id LIMIT ?`).all(...args,...(position?[boundary,boundary,position.deviceId,position.deviceId,position.appId]:[]),range.limit+1);
    const items=rows.slice(0,range.limit).map(row=>{const start=Math.floor(Date.parse(String(row.capturedAt))/900000)*900000;return {...row,after:new Date(start).toISOString(),before:new Date(start+900000).toISOString()};});
    const last=items.at(-1) as {after:string;deviceId:string;appId:string}|undefined;
    return {items,totalCount,albumCount,nextCursor:rows.length>range.limit&&last?Buffer.from(JSON.stringify({after:last.after,deviceId:last.deviceId,appId:last.appId})).toString('base64url'):null};
  }
  sessions(range:{after:string;before:string;deviceId?:string;cursor?:string;limit:number;sessionId?:string}) {
    const args:(string|number)[]=[new Date(range.after).toISOString(),new Date(range.before).toISOString()];
    if(range.deviceId)args.push(range.deviceId);
    // Partition before pagination. App switches remain boundaries even if the user
    // subsequently opens only one app's session; overlapping devices never mix.
    const cte=`WITH observed AS (
      SELECT *,LAG(app_id) OVER w AS previous_app,LAG(captured_at) OVER w AS previous_at
      FROM capture_gallery WHERE captured_at>=? AND captured_at<? ${range.deviceId?'AND device_id=?':''}
      WINDOW w AS (PARTITION BY device_id ORDER BY captured_at,id)
    ), segmented AS (
      SELECT *,SUM(CASE WHEN previous_at IS NULL OR app_id='' OR app_id!=previous_app OR
        (julianday(captured_at)-julianday(previous_at))*86400000>300000.1 THEN 1 ELSE 0 END)
        OVER (PARTITION BY device_id ORDER BY captured_at,id) AS segment FROM observed
    ), members AS (
      SELECT *,FIRST_VALUE(id) OVER (PARTITION BY device_id,segment ORDER BY captured_at,id) AS session_id FROM segmented
    )`;
    let position:{at:string;id:string}|undefined;
    if(range.cursor){try{position=z.object({at:z.string().datetime(),id:z.string().uuid()}).strict().parse(JSON.parse(Buffer.from(range.cursor,'base64url').toString()));}catch{throw new StoreError('Invalid session cursor');}}
    if(range.sessionId){
      const totalCount=Number(this.db.prepare(`${cte} SELECT COUNT(*) AS n FROM members WHERE session_id=?`).get(...args,range.sessionId)!.n);
      if(!totalCount)throw new StoreError('Session changed or is no longer available; refresh the session list',404);
      const rows=this.db.prepare(`${cte} SELECT id,device_id AS deviceId,captured_at AS capturedAt,app_id AS appId,app_name AS appName,has_image AS hasImage FROM members WHERE session_id=? ${position?'AND (captured_at<? OR (captured_at=? AND id<?))':''} ORDER BY captured_at DESC,id DESC LIMIT ?`).all(...args,range.sessionId,...(position?[position.at,position.at,position.id]:[]),range.limit+1);
      const items=rows.slice(0,range.limit).map(row=>({...row,source:'screen',hasImage:Boolean(row.hasImage)})),last=rows.slice(0,range.limit).at(-1);
      return {items,totalCount,nextCursor:rows.length>range.limit&&last?Buffer.from(JSON.stringify({at:last.capturedAt,id:last.id})).toString('base64url'):null};
    }
    const grouped=`, grouped AS (SELECT session_id AS id,device_id AS deviceId,app_id AS appId,app_name AS appName,MIN(captured_at) AS firstAt,MAX(captured_at) AS capturedAt,COUNT(*) AS count,SUM(has_image) AS imageCount FROM members GROUP BY device_id,segment)`;
    const counts=this.db.prepare(`${cte}${grouped} SELECT COUNT(*) AS sessionCount,COALESCE(SUM(count),0) AS totalCount FROM grouped`).get(...args)!;
    const rows=this.db.prepare(`${cte}${grouped} SELECT * FROM grouped ${position?'WHERE firstAt<? OR (firstAt=? AND id>?)':''} ORDER BY firstAt DESC,id LIMIT ?`).all(...args,...(position?[position.at,position.at,position.id]:[]),range.limit+1);
    const items=rows.slice(0,range.limit).map(row=>({...row,after:row.firstAt,before:new Date(Date.parse(String(row.capturedAt))+1).toISOString()})),last=rows.slice(0,range.limit).at(-1);
    return {items,...counts,gapMs:300000,nextCursor:rows.length>range.limit&&last?Buffer.from(JSON.stringify({at:last.firstAt,id:last.id})).toString('base64url'):null};
  }
  imageReference(id:string) {
    return this.db.prepare('SELECT device_id AS deviceId,blob_hash AS blobHash FROM captures WHERE id=?').get(id) as {deviceId:string;blobHash:string|null}|undefined;
  }
  completeOcr(id:string,update:{status:'completed'|'failed';ocrText:string}) {
    const row=this.db.prepare('SELECT * FROM captures WHERE id=?').get(id) as (Row&{fingerprint:string})|undefined;
    if(!row)throw new StoreError('Capture not found',404);
    const previous=JSON.parse(row.json) as CaptureInput;
    if(previous.source!=='screen'||!row.blob_hash)throw new StoreError('Only stored screenshots can receive OCR',409);
    if(previous.ocr?.status===update.status && previous.ocrText===update.ocrText) return {id,ocr:previous.ocr,duplicate:true};
    if(!['pending','failed'].includes(previous.ocr?.status??''))throw new StoreError('OCR is not awaiting completion',409);
    if(update.status==='failed'&&update.ocrText)throw new StoreError('Failed OCR cannot contain recognized text');
    const ocr={status:update.status,updatedAt:new Date().toISOString()};
    const next={...previous,ocrText:update.ocrText,ocr};
    const json=JSON.stringify(next);
    // Use the input schema's field order, matching prepare(), without needing to
    // decode the unchanged image again. Original ingest retries retain their receipt.
    const metadata=captureSchema.innerType().parse({...next,imageMime:row.mime});
    const fingerprint=sha256(JSON.stringify({...metadata,blobHash:row.blob_hash}));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.reserveMetadata(Math.max(0,Buffer.byteLength(json)-Buffer.byteLength(row.json)));
      this.db.prepare('INSERT OR IGNORE INTO capture_ocr_receipts(id,original_fingerprint) VALUES(?,?)').run(id,row.fingerprint);
      this.db.prepare('UPDATE captures SET json=?,fingerprint=?,index_status=?,embedding=NULL,embedding_model=NULL,summary=NULL,index_error=NULL,attempts=0 WHERE id=?')
        .run(json,fingerprint,this.options.embeddingEnabled&&update.ocrText.trim()?'pending':'text_ready',id);
      this.db.prepare('DELETE FROM captures_fts WHERE id=?').run(id);
      this.db.prepare('INSERT INTO captures_fts(id,text) VALUES(?,?)').run(id,searchText(next));
      this.invalidateMemoryEvidence(id);
      for(const operation of ['supersede','upsert'])this.db.prepare('INSERT INTO changes(id,operation,changed_at) VALUES(?,?,?)').run(id,operation,ocr.updatedAt);
      this.db.exec('COMMIT');return {id,ocr,duplicate:false};
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  search(range:Range&{query?:string}) {
    if(!range.query?.trim())return this.list(range).items;
    const {where,values}=this.clauses(range); const conjunction=where?' AND ':' WHERE ';
    const lexical=textSearch(range.query,{id:'captures.id',text:'mote_search_text(captures.json)',words:'captures_fts',trigrams:'captures_trigram'});
    // Apply the complete lexical/time/device scope before limiting results.
    const rows=this.db.prepare(`SELECT * FROM captures${where}${conjunction}${lexical.sql} ORDER BY mote_context_time(json) DESC,id DESC LIMIT ?`)
      .all(...values,...lexical.values,Math.min(range.limit??50,200)) as unknown as Row[];
    return rows.map(r=>this.record(r));
  }
  vectorSearch(vector:number[], model:string, range:Range={}) {
    const {where,values}=this.clauses(range);
    const rows=this.db.prepare(`SELECT * FROM captures${where}${where?' AND ':' WHERE '}embedding_model=? AND embedding IS NOT NULL`).all(...values,model) as unknown as (Row&{embedding:string})[];
    const norm=Math.sqrt(vector.reduce((s,n)=>s+n*n,0));
    return rows.map(row=>{const v=JSON.parse(row.embedding) as number[];const vn=Math.sqrt(v.reduce((s,n)=>s+n*n,0));return {row,score:v.length===vector.length&&vn&&norm?v.reduce((s,n,i)=>s+n*vector[i],0)/(vn*norm):-1};})
      .sort((a,b)=>b.score-a.score).slice(0,Math.min(range.limit??30,200)).map(r=>this.record(r.row));
  }
  image(id:string) {
    const row=this.db.prepare('SELECT blob_hash,mime FROM captures WHERE id=?').get(id) as {blob_hash:string|null;mime:string}|undefined;
    if(!row?.blob_hash)throw new StoreError('Image not found',404);
    return {bytes:this.readBlob(row.blob_hash),mime:row.mime};
  }
  private readBlob(hash:string) {
    const raw=readFileSync(join(this.blobsDir,hash));
    let bytes=raw;
    if(raw.subarray(0,5).toString()==='MOTE1') {
      if(!this.key)throw new StoreError('Encrypted image requires its original key',500);
      const decipher=createDecipheriv('aes-256-gcm',this.key,raw.subarray(5,17));decipher.setAuthTag(raw.subarray(17,33));
      bytes=Buffer.concat([decipher.update(raw.subarray(33)),decipher.final()]);
    }
    if(sha256(bytes)!==hash)throw new StoreError('Image checksum failed',500);
    return bytes;
  }
  decryptImage(hash:string):boolean {
    if(!/^[a-f0-9]{64}$/.test(hash))throw new StoreError('Invalid image hash');
    const path=join(this.blobsDir,hash);if(!existsSync(path))return false;
    const raw=readFileSync(path);if(raw.subarray(0,5).toString()!=='MOTE1')return false;
    const plain=this.readBlob(hash);replaceContentFile(path,plain);return true;
  }
  heartbeat(beat:Heartbeat) {
    const record:DeviceRecord={...beat,lastSeenAt:new Date().toISOString()};
    this.db.prepare('INSERT INTO devices(id,json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(beat.deviceId,JSON.stringify(record));return {ok:true};
  }
  captureReceived(deviceId:string) {
    // Receipt proves contact now, not that the screen is currently being captured.
    this.db.prepare("UPDATE devices SET json=json_set(json,'$.lastSeenAt',?) WHERE id=?").run(new Date().toISOString(),deviceId);
  }
  devices():DeviceRecord[] {return (this.db.prepare('SELECT json FROM devices').all() as {json:string}[]).map(r=>JSON.parse(r.json));}
  activity(range:Range={}):Activity {
    // Assign overlapping sample intervals once per device before applying content/app filters.
    // A filtered query must not reassign another app's already measured interval to its own samples.
    const extended:Range={deviceId:range.deviceId,after:range.after?new Date(Date.parse(range.after)-21600000).toISOString():undefined,before:range.before?new Date(Date.parse(range.before)+300000).toISOString():undefined};
    const {where,values}=this.clauses(extended);
    const rows=this.db.prepare(`SELECT * FROM captures${where} ORDER BY captured_at ASC,id ASC`).all(...values) as unknown as Row[];
    type Counts={durationMs:number;captures:number;activityEvents:number;contentCaptures:number};
    const apps=new Map<string,Counts&{appId:string;appName:string}>(),devices=new Map<string,Counts&{deviceId:string;deviceName:string}>(),ends=new Map<string,number>();
    const lower=range.after?Date.parse(range.after):-Infinity,upper=range.before?Date.parse(range.before):Infinity;
    let totalDurationMs=0,captures=0,activityEvents=0,contentCaptures=0;
    const observations=rows.flatMap(row=>{const c=this.record(row);return stateSamples(c).map(s=>({...c,capturedAt:s.at,durationMs:s.durationMs}));}).sort((a,b)=>a.capturedAt.localeCompare(b.capturedAt)||a.id.localeCompare(b.id));
    for(const c of observations) {
      if(c.source!=='screen'&&c.source!=='activity')continue;
      const t=Date.parse(c.capturedAt),end=Math.min(t,upper),start=Math.max(t-c.durationMs,lower,ends.get(c.deviceId)??-Infinity),durationMs=Math.max(0,end-start);
      if((t<lower||t>=upper)&&!durationMs)continue;
      if(durationMs>0)ends.set(c.deviceId,Math.max(ends.get(c.deviceId)??-Infinity,end));
      const activity=c.source==='activity';
      if(range.source&&c.source!==range.source||range.appId!==undefined&&c.appId!==range.appId||range.collection==='activity'&&!activity||range.collection==='content'&&(activity||c.privacy.collection==='activity'))continue;
      const appKey=JSON.stringify(c.appId?['id',c.appId]:['name',c.appName]);
      const app=apps.get(appKey)??{appId:c.appId,appName:c.appName||moteText("未识别应用"),durationMs:0,captures:0,activityEvents:0,contentCaptures:0};
      const d=devices.get(c.deviceId)??{deviceId:c.deviceId,deviceName:c.deviceName,durationMs:0,captures:0,activityEvents:0,contentCaptures:0};
      for(const bucket of [app,d]){bucket.durationMs+=durationMs;bucket.captures++;if(activity)bucket.activityEvents++;else bucket.contentCaptures++;}
      apps.set(appKey,app);devices.set(c.deviceId,d);totalDurationMs+=durationMs;captures++;if(activity)activityEvents++;else contentCaptures++;
    }
    return {apps:[...apps.values()].sort((a,b)=>b.durationMs-a.durationMs),devices:[...devices.values()],totalDurationMs,captures,activityEvents,contentCaptures};
  }
  mediaActivity(range:MediaActivityRange={}) {
    // Intervals end at capturedAt and can overlap the exclusive upper bound.
    // Snapshot metadata on screen/activity events never participates in media accounting.
    const {where,values}=this.clauses({deviceId:range.deviceId,source:'media',after:range.after,before:range.before?new Date(Date.parse(range.before)+60000).toISOString():undefined});
    // SQLite sorts interval starts before streaming; rich session metadata is parsed one row at a time.
    const rows=this.db.prepare(`SELECT * FROM captures${where} ORDER BY unixepoch(captured_at,'subsec')*1000-json_extract(json,'$.durationMs') ASC,captured_at ASC,id ASC`).iterate(...values);
    const record=this.record.bind(this);
    return mediaActivity((function*(){for(const row of rows)yield record(row as unknown as Row);})(),range);
  }
  reserveMetadata(bytes:number){if(this.options.maxStorageBytes&&this.logicalBytes()+bytes>this.options.maxStorageBytes)throw new StoreError('Vault storage limit reached',507);}
  logicalBytes() {
    const tables=new Set((this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name));
    const jsonTables=['captures','memories','source_connections','conversations','memory_jobs','memory_batches','archived_files','import_jobs','file_artifacts','file_reviews','insight_runs','query_runs','model_usage','model_prices','memory_lifecycle_settings','memory_lifecycle_state','working_memories','action_meta','action_proposals','action_targets'].filter(name=>tables.has(name));
    const bytes=Number((this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM blobs').get() as {n:number}).n);
    const files=tables.has('file_blobs')?Number(this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM file_blobs').get()!.n):0;
    const scalar=(sql:string)=>Number(this.db.prepare(sql).get()!.n);
    const nativeBytes=scalar('SELECT COALESCE(SUM(bytes),0) AS n FROM file_objects')
      +scalar('SELECT COALESCE(SUM(bytes),0) AS n FROM file_parts p JOIN file_uploads u ON u.id=p.upload_id WHERE u.ack IS NULL')
      +scalar('SELECT COALESCE(SUM(length(CAST(text AS BLOB))+COALESCE(length(embedding),0)),0) AS n FROM file_chunks')
      +scalar('SELECT COALESCE(SUM(length(CAST(manifest AS BLOB))),0) AS n FROM (SELECT manifest FROM file_versions UNION ALL SELECT manifest FROM file_uploads)');
    return bytes+files+nativeBytes+Number(this.db.prepare('SELECT COALESCE(SUM(length(CAST(json AS BLOB))),0) AS n FROM ('+jsonTables.map(name=>'SELECT json FROM '+name).join(' UNION ALL ')+')').get()!.n);
  }
  stats() {
    const counts=this.db.prepare("SELECT COUNT(*) AS captures, COUNT(blob_hash) AS imageCaptures, SUM(CASE WHEN json_extract(json,'$.source')='activity' THEN 1 ELSE 0 END) AS activityEvents, SUM(CASE WHEN json_extract(json,'$.source')='media' THEN 1 ELSE 0 END) AS mediaEvents, MIN(captured_at) AS firstCaptureAt,MAX(captured_at) AS lastCaptureAt FROM captures").get() as {captures:number;imageCaptures:number;activityEvents:number|null;mediaEvents:number|null;firstCaptureAt:string|null;lastCaptureAt:string|null};
    const blob=this.db.prepare('SELECT COUNT(*) AS blobs,COALESCE(SUM(bytes),0) AS imageBytes FROM blobs').get() as {blobs:number;imageBytes:number};
    const indexing=this.db.prepare('SELECT index_status AS status,COUNT(*) AS count FROM captures GROUP BY index_status').all();
    const filePaths:string[]=[];const fileRoot=join(this.directory,'files');if(existsSync(fileRoot))for(const entry of readdirSync(fileRoot,{recursive:true,withFileTypes:true}))if(entry.isFile())filePaths.push(join(entry.parentPath,entry.name));
    const physicalBytes=[...filePaths,join(this.directory,'mote.sqlite'),join(this.directory,'mote.sqlite-wal'),...readdirSync(this.blobsDir).map(p=>join(this.blobsDir,p))].reduce((n,p)=>n+(existsSync(p)?statSync(p).size:0),0);
    const fileBytes=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='file_blobs'").get()?Number(this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM file_blobs').get()!.n):0;
    return {...counts,activityEvents:counts.activityEvents??0,mediaEvents:counts.mediaEvents??0,...blob,fileBytes,bytes:physicalBytes,logicalBytes:this.logicalBytes(),maxBytes:this.options.maxStorageBytes??null,indexing,imagesEncrypted:this.contentEncryption.enabled};
  }
  exportArchive(maxBytes:number) {
    if(this.db.prepare('SELECT 1 FROM file_versions LIMIT 1').get())throw new StoreError(moteText("文件归档请使用 npm run backup 完整备份；JSON 导出不包含文件原件和转写。"),409);
    const stats=this.stats() as {logicalBytes:number;captures:number};
    const archivedFiles=new ArchivedFileStore(this);
    // Portable v1 embeds a blob for EACH observation. Account for expanded repetitions before allocation.
    const estimated=Number((this.db.prepare('SELECT COALESCE(SUM(length(CAST(c.json AS BLOB)) + 4 * ((COALESCE(b.bytes,0) + 2) / 3) + 240),0) AS n FROM captures c LEFT JOIN blobs b ON b.hash=c.blob_hash').get() as {n:number}).n)+archivedFiles.portableEstimate()+200;
    if(estimated>maxBytes||stats.captures>20000)throw new StoreError('Archive too large for HTTP export; use npm run backup for a consistent database backup',413);
    const rows=this.db.prepare('SELECT * FROM captures ORDER BY captured_at,id').all() as unknown as Row[];
    const captures=rows.map(row=>{const c=JSON.parse(row.json);return {...c,receivedAt:row.received_at,...(row.blob_hash?{imageMime:row.mime,imageBase64:this.readBlob(row.blob_hash).toString('base64')}:{}),blobHash:row.blob_hash};});
    const archive={version:1,exportedAt:new Date().toISOString(),captures,sources:(this.db.prepare('SELECT json FROM source_connections').all() as {json:string}[]).map(r=>JSON.parse(r.json)),sourceVersions:this.db.prepare('SELECT * FROM source_versions WHERE capture_id IN (SELECT id FROM captures)').all(),sourceHeads:this.db.prepare('SELECT * FROM source_heads WHERE capture_id IN (SELECT id FROM captures)').all(),memories:(this.db.prepare('SELECT json FROM memories').all() as {json:string}[]).map(r=>JSON.parse(r.json)),files:archivedFiles.exportPortable(),captureFiles:this.db.prepare('SELECT capture_id AS captureId,file_id AS fileId FROM capture_files ORDER BY capture_id,file_id').all()};
    if(Buffer.byteLength(JSON.stringify(archive))>maxBytes)throw new StoreError('Expanded archive exceeds the export limit; use npm run backup',413);
    return archive;
  }
  delete(id:string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result=this.db.prepare('DELETE FROM captures WHERE id=?').run(id);this.db.prepare('DELETE FROM captures_fts WHERE id=?').run(id);
      if(result.changes)this.db.prepare('INSERT INTO changes(id,operation,changed_at) VALUES(?,?,?)').run(id,'delete',new Date().toISOString());
      // Derived retrospectives can refer to removed evidence; invalidate, rather than retain stale personal facts.
      if(result.changes){this.invalidateMemoryEvidence(id,true);this.invalidateConversationAnswers();this.db.prepare('UPDATE source_heads SET deleted=1 WHERE capture_id=?').run(id);}
      this.db.exec('COMMIT');this.sweep();return {deleted:Number(result.changes)};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  prune(before:string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const removed=this.db.prepare('SELECT id FROM captures WHERE mote_context_end(json) < ? AND id NOT IN (SELECT capture_id FROM file_versions)').all(before) as {id:string}[];
      this.db.prepare("INSERT INTO changes(id,operation,changed_at) SELECT id,'delete',? FROM captures WHERE mote_context_end(json) < ? AND id NOT IN (SELECT capture_id FROM file_versions)").run(new Date().toISOString(),before);
      this.db.prepare('DELETE FROM captures_fts WHERE id IN (SELECT id FROM captures WHERE mote_context_end(json) < ? AND id NOT IN (SELECT capture_id FROM file_versions))').run(before);
      const result=this.db.prepare('DELETE FROM captures WHERE mote_context_end(json) < ? AND id NOT IN (SELECT capture_id FROM file_versions)').run(before);
      if(result.changes){for(const row of removed)this.invalidateMemoryEvidence(row.id,true);this.db.exec('UPDATE source_heads SET deleted=1 WHERE capture_id NOT IN (SELECT id FROM captures)');this.invalidateConversationAnswers();}this.db.exec('COMMIT');this.sweep();return Number(result.changes);
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  invalidateConversationAnswers() {
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='working_memories'").get())this.db.exec('DELETE FROM working_memories');
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='query_runs'").get()){
      for(const row of this.db.prepare('SELECT id,json FROM query_runs').all() as {id:string;json:string}[]){
        const run=JSON.parse(row.json);run.events=run.events.map(({message:_,...event}: {message?:string;[key:string]:unknown})=>event);
        this.db.prepare('UPDATE query_runs SET json=? WHERE id=?').run(JSON.stringify(run),row.id);
      }
    }
    // As with insights, a model reply may contain removed facts even without an
    // explicit citation. Keep authored questions, but never retain derived copies.
    const rows=this.db.prepare('SELECT id,json FROM conversations').all() as {id:string;json:string}[];
    for(const row of rows) {
      const value=JSON.parse(row.json) as {turns:{result:{answer:string;citations:unknown[];trace:unknown[];runId:string};evidenceDeleted?:boolean}[]};
      if(value.turns.every(turn=>turn.evidenceDeleted))continue;
      for(const turn of value.turns){turn.evidenceDeleted=true;turn.result={answer:moteText("原始资料已删除或到期，这条历史回答已清除。你可以继续提问，重新检索现有资料。"),citations:[],trace:[],runId:turn.result.runId};}
      this.db.prepare('UPDATE conversations SET json=? WHERE id=?').run(JSON.stringify(value),row.id);
    }
  }
  sweep() {
    this.db.exec('DELETE FROM blobs WHERE hash NOT IN (SELECT blob_hash FROM captures WHERE blob_hash IS NOT NULL)');
    const known=new Set((this.db.prepare('SELECT hash FROM blobs').all() as {hash:string}[]).map(r=>r.hash));
    for(const file of readdirSync(this.blobsDir))if((/^[a-f0-9]{64}$/.test(file)&&!known.has(file))||/^[a-f0-9]{64}\.[a-f0-9]+\.tmp$/.test(file))unlinkSync(join(this.blobsDir,file));
  }
  pending(limit=10) {return (this.db.prepare("SELECT * FROM captures WHERE index_status='pending' AND id NOT IN (SELECT capture_id FROM file_versions) AND json_extract(json,'$.source')!='activity' ORDER BY received_at LIMIT ?").all(limit) as unknown as Row[]).map(r=>this.record(r));}
  indexCounts() {
    const result={pending:0,failed:0,indexed:0,textReady:0};
    for(const row of this.db.prepare('SELECT index_status AS status,COUNT(*) AS count FROM captures GROUP BY index_status').all() as {status:string;count:number}[]) {
      if(row.status==='pending')result.pending=row.count;else if(row.status==='failed')result.failed=row.count;else if(row.status==='indexed')result.indexed=row.count;else if(row.status==='text_ready')result.textReady=row.count;
    }
    return result;
  }
  indexed(id:string,embedding:number[],model:string) {this.db.prepare("UPDATE captures SET embedding=?,embedding_model=?,index_status='indexed',index_error=NULL WHERE id=?").run(JSON.stringify(embedding),model,id);}
  indexFailed(id:string,error:string) {this.db.prepare("UPDATE captures SET index_status='failed',index_error=?,attempts=attempts+1 WHERE id=?").run(error.slice(0,500),id);}
  retryIndex() {this.db.exec('UPDATE file_chunks SET index_error=NULL');return {queued:Number(this.db.prepare("UPDATE captures SET index_status='pending' WHERE json_extract(json,'$.source')!='activity' AND length(trim(json_extract(json,'$.ocrText')))>0").run().changes)};}
  updates(cursor:number,limit=100) {
    const rows=this.db.prepare('SELECT seq,id,operation,changed_at FROM changes WHERE seq>? ORDER BY seq LIMIT ?').all(cursor,limit) as {seq:number;id:string;operation:string;changed_at:string}[];
    return {items:rows.map(r=>({...r,record:r.operation==='upsert'?this.evidence([r.id])[0]??null:null})),nextCursor:rows.at(-1)?.seq??cursor};
  }
  deletionRevision() {return Number((this.db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM changes WHERE operation IN ('delete','supersede')").get() as {n:number}).n);}
  saveInsight(result:unknown,id:string) {this.db.prepare('INSERT INTO insights(id,created_at,json) VALUES(?,?,?)').run(id,new Date().toISOString(),JSON.stringify(result));}
  insights() {return (this.db.prepare('SELECT id,created_at,json FROM insights ORDER BY created_at DESC LIMIT 30').all() as {id:string;created_at:string;json:string}[]).map(r=>({id:r.id,createdAt:r.created_at,...JSON.parse(r.json)}));}
  close() {this.db.close();}
}
