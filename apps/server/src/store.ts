import {systemEventText} from '@mote/shared';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import {z} from 'zod';
import { sourceConnectionSchema, sourceItemSchema, captureSchema, captureOcrState, type CapturePreview, type OcrState, type CaptureInput, type CaptureRecord, type Heartbeat, type DeviceRecord, type Activity } from '@mote/shared';
import {privateDirectory,privateFile} from './private-storage.js';
import {mediaActivity,type MediaActivityRange} from './media-activity.js';

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
  key?:Buffer;
  constructor(public directory:string, private options:{dataKey?:string;maxStorageBytes?:number;embeddingEnabled?:boolean}={}) {
    privateDirectory(directory);
    this.blobsDir=join(directory,'blobs'); privateDirectory(this.blobsDir);
    if(options.dataKey) {
      if(!/^[0-9a-f]{64}$/i.test(options.dataKey)) throw new Error('MOTE_DATA_KEY must be 64 hexadecimal characters');
      this.key=Buffer.from(options.dataKey,'hex');
    }
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
      CREATE TABLE IF NOT EXISTS capture_ocr_receipts (id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE, original_fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_connections (id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_versions (source_id TEXT NOT NULL,external_id TEXT NOT NULL,revision TEXT NOT NULL,capture_id TEXT NOT NULL UNIQUE,hash TEXT NOT NULL,PRIMARY KEY(source_id,external_id,revision));
      CREATE TABLE IF NOT EXISTS source_heads (source_id TEXT NOT NULL,external_id TEXT NOT NULL,capture_id TEXT NOT NULL,observed_at TEXT NOT NULL,deleted INTEGER NOT NULL,PRIMARY KEY(source_id,external_id));
      CREATE INDEX IF NOT EXISTS source_head_capture ON source_heads(capture_id);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY,created_at TEXT NOT NULL,json TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS captures_fts USING fts5(id UNINDEXED, text, tokenize='unicode61');
      PRAGMA user_version=1;`);
    this.db.function('mote_ocr_status',{deterministic:true},json=>captureOcrState(JSON.parse(String(json))).status);
    const marker=this.db.prepare('SELECT value FROM settings WHERE key=?').get('encryption') as {value:string}|undefined;
    const expected=this.key ? sha256(this.key) : 'none';
    if(marker && marker.value!==expected) {this.db.close();throw new Error('Vault encryption key mismatch. Restore the original MOTE_DATA_KEY; do not change keys on an existing vault.');}
    this.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run('encryption',expected);
    this.db.function('mote_search_text',{deterministic:true},json=>searchText(JSON.parse(String(json))));
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
    const clauses:string[]=["(id NOT IN (SELECT capture_id FROM source_versions) OR id IN (SELECT capture_id FROM source_heads WHERE deleted=0))"]; const values:(string|number)[]=[];
    if(range.after) {clauses.push('captured_at >= ?');values.push(new Date(range.after).toISOString());}
    if(range.before) {clauses.push('captured_at < ?');values.push(new Date(range.before).toISOString());}
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
      try {const c=JSON.parse(Buffer.from(range.cursor,'base64url').toString());if(typeof c.t!=='string'||typeof c.id!=='string')throw Error();clauses.push('(captured_at < ? OR (captured_at = ? AND id < ?))');values.push(c.t,c.t,c.id);}catch {throw new StoreError('Invalid pagination cursor');}
    }
    return {where:clauses.length?' WHERE '+clauses.join(' AND '):'',values};
  }
  async prepare(raw:unknown):Promise<Prepared> {
    const input=captureSchema.parse(raw); input.capturedAt=new Date(input.capturedAt).toISOString();
    if(Date.parse(input.capturedAt)>Date.now()+86_400_000)throw new StoreError('Capture timestamp is more than one day in the future');
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
    if(this.key) {
      const nonce=randomBytes(12); const cipher=createCipheriv('aes-256-gcm',this.key,nonce);
      const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);
      stored=Buffer.concat([Buffer.from('MOTE1'),nonce,cipher.getAuthTag(),ciphertext]);
    }
    const temp=join(this.blobsDir,`${hash}.${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(temp,stored,{mode:0o600}); renameSync(temp,path);
  }
  private insert(p:Prepared) {
    const prior=this.db.prepare('SELECT fingerprint,blob_hash,index_status,json,mime FROM captures WHERE id=?').get(p.input.id) as {fingerprint:string;blob_hash:string|null;index_status:string;json:string;mime:string|null}|undefined;
    if(prior) {
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
    const archive=raw as {version?:number;captures?:unknown[];sources?:unknown[];sourceHeads?:unknown[];sourceVersions?:unknown[];memories?:unknown[]};
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
    const memoryEntries=z.array(z.object({id:z.string().uuid(),title:z.string().max(160),statement:z.string().max(6000),uncertainty:z.string().max(2000),evidenceIds:z.array(z.string().uuid()).min(1).max(30),createdAt:z.string().datetime({offset:true}),status:z.enum(['proposed','published','stale']),model:z.string().max(200),runId:z.string().max(200),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(1000).parse(archive.memories??[]);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let imported=0,duplicates=0;
      for(const p of prepared)this.insert(p).duplicate?duplicates++:imported++;
      for(const c of connections){const prior=this.db.prepare('SELECT json FROM source_connections WHERE id=?').get(c.id) as {json:string}|undefined;if(prior){const original=JSON.parse(prior.json);if(original.deviceId!==c.deviceId||original.kind!==c.kind)throw new StoreError('Source identity conflict',409);}else this.db.prepare('INSERT INTO source_connections(id,json) VALUES(?,?)').run(c.id,JSON.stringify({...c,enabled:false}));}
      for(const rawVersion of archive.sourceVersions??[]){const v=rawVersion as Record<string,unknown>;if(typeof v.capture_id!=='string'||typeof v.source_id!=='string'||typeof v.external_id!=='string'||typeof v.revision!=='string'||typeof v.hash!=='string'||!(/^[a-f0-9]{64}$/.test(v.hash)))throw new StoreError('Invalid source revision');const e=this.evidence([v.capture_id])[0];if(!e?.provenance||e.provenance.sourceId!==v.source_id||e.provenance.externalId!==v.external_id||e.provenance.revision!==v.revision||!this.db.prepare('SELECT id FROM source_connections WHERE id=?').get(v.source_id))throw new StoreError('Source revision evidence mismatch');const p=e.provenance;const {observedAt:_,...semantic}=sourceItemSchema.parse({externalId:p.externalId,revision:p.revision,observedAt:e.capturedAt,modifiedAt:p.modifiedAt,title:e.windowTitle,text:p.deleted||p.layer==='reference'?'':e.ocrText,uri:p.uri,kind:e.source,layer:p.layer,mimeType:p.mimeType,calendar:p.calendar,deleted:p.deleted,metadata:p.metadata});if(sha256(JSON.stringify(semantic))!==v.hash)throw new StoreError('Source revision checksum mismatch');this.db.prepare('INSERT OR IGNORE INTO source_versions(source_id,external_id,revision,capture_id,hash) VALUES(?,?,?,?,?)').run(v.source_id,v.external_id,v.revision,v.capture_id,v.hash);}
      for(const rawHead of archive.sourceHeads??[]){const h=rawHead as Record<string,unknown>;if(typeof h.capture_id!=='string'||typeof h.source_id!=='string'||typeof h.external_id!=='string'||typeof h.observed_at!=='string'||!Number.isFinite(Date.parse(h.observed_at))||![0,1].includes(Number(h.deleted)))throw new StoreError('Invalid source pointer');const v=this.db.prepare('SELECT capture_id FROM source_versions WHERE source_id=? AND external_id=? AND capture_id=?').get(h.source_id,h.external_id,h.capture_id);if(!v)throw new StoreError('Source pointer has no revision');const e=this.evidence([h.capture_id])[0];if(!e||Date.parse(h.observed_at)!==Date.parse(e.capturedAt)||Number(h.deleted)!==Number(e.provenance?.deleted))throw new StoreError('Source pointer metadata mismatch');const priorHead=this.db.prepare('SELECT capture_id,observed_at FROM source_heads WHERE source_id=? AND external_id=?').get(h.source_id,h.external_id) as {capture_id:string;observed_at:string}|undefined;if(priorHead&&Date.parse(priorHead.observed_at)===Date.parse(h.observed_at)&&priorHead.capture_id!==h.capture_id)throw new StoreError('Equal observation times contain conflicting source heads',409);const moved=this.db.prepare('INSERT INTO source_heads(source_id,external_id,capture_id,observed_at,deleted) VALUES(?,?,?,?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET capture_id=excluded.capture_id,observed_at=excluded.observed_at,deleted=excluded.deleted WHERE excluded.observed_at>source_heads.observed_at').run(h.source_id,h.external_id,h.capture_id,new Date(h.observed_at).toISOString(),Number(h.deleted));if(moved.changes&&priorHead&&priorHead.capture_id!==h.capture_id){this.db.exec("DELETE FROM insights; UPDATE memories SET json=json_set(json,'$.status','stale')");this.db.prepare("INSERT INTO changes(id,operation,changed_at) VALUES(?,'supersede',?)").run(priorHead.capture_id,new Date().toISOString());}}
      for(const m of memoryEntries){if(m.evidenceIds.some(id=>!this.evidence([id]).length))throw new StoreError('Memory archive is missing supporting evidence');this.db.prepare('INSERT OR IGNORE INTO memories(id,created_at,json) VALUES(?,?,?)').run(m.id,m.createdAt,JSON.stringify({...m,status:'stale'}));}
      // Merging individually valid archives must still respect the destination's total limits.
      if(Number(this.db.prepare('SELECT COUNT(*) AS n FROM source_connections').get()!.n)>500)throw new StoreError('Maximum 500 sources',413);
      if(Number(this.db.prepare('SELECT COUNT(*) AS n FROM memories').get()!.n)>1000)throw new StoreError('Memory limit reached',507);
      this.reserveMetadata(0);
      this.db.exec('COMMIT');return {imported,duplicates};
    }catch(e){this.db.exec('ROLLBACK');this.sweep();throw e;}
  }
  list(range:Range={}) {
    const {where,values}=this.clauses(range);const limit=Math.min(200,Math.max(1,range.limit??50));
    const rows=this.db.prepare(`SELECT * FROM captures${where} ORDER BY captured_at DESC,id DESC LIMIT ?`).all(...values,limit+1) as unknown as Row[];
    const {cursor:_cursor,...scope}=range;const totalScope=this.clauses(scope);
    const totalCount=Number((this.db.prepare(`SELECT COUNT(*) AS count FROM captures${totalScope.where}`).get(...totalScope.values) as {count:number}).count);
    const more=rows.length>limit;const items=rows.slice(0,limit).map(r=>this.record(r));const last=items.at(-1);
    return {items,nextCursor:more&&last?Buffer.from(JSON.stringify({t:last.capturedAt,id:last.id})).toString('base64url'):null,totalCount};
  }
  evidence(ids:string[]) {return ids.slice(0,200).map(id=>this.db.prepare('SELECT * FROM captures WHERE id=?').get(id) as Row|undefined).filter((x):x is Row=>Boolean(x)).map(r=>this.record(r));}
  previews(range:Range={}) {
    const page=this.list(range);
    const items:CapturePreview[]=page.items.map(record=>({id:record.id,deviceId:record.deviceId,deviceName:record.deviceName,platform:record.platform,
      capturedAt:record.capturedAt,source:record.source,appId:record.appId,appName:record.appName,windowTitle:record.windowTitle.slice(0,300),
      durationMs:record.durationMs,hasImage:Boolean(record.blobHash),ocr:captureOcrState(record),
      ...(record.metadata?.media?{media:record.metadata.media}:{}),
      textPreview:(record.source==='media'?(record.metadata?.media?.sessions.map(s=>[s.title,s.artist,s.appName].filter(Boolean).join(' · ')).join(' / ')||({available:'未观察到媒体会话',disabled:'媒体采集已关闭',permission_required:'媒体权限未授予',unavailable:'媒体信息暂不可用'}[record.metadata?.media?.status??'unavailable'])):record.source==='notification'||record.source==='device_event'?systemEventText(record.metadata):record.ocrText).slice(0,160)}));
    return {...page,items};
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
      this.db.exec("DELETE FROM insights; UPDATE memories SET json=json_set(json,'$.status','stale')");
      for(const operation of ['supersede','upsert'])this.db.prepare('INSERT INTO changes(id,operation,changed_at) VALUES(?,?,?)').run(id,operation,ocr.updatedAt);
      this.db.exec('COMMIT');return {id,ocr,duplicate:false};
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  search(range:Range&{query?:string}) {
    if(!range.query?.trim())return this.list(range).items;
    const {where,values}=this.clauses(range); const conjunction=where?' AND ':' WHERE ';
    const query=range.query.trim().slice(0,1000); const terms=query.split(/\s+/).filter(Boolean).slice(0,12).map(s=>'"'+s.replaceAll('"','""')+'"').join(' OR ');
    // Generic lexical primitive. The Agent, never keyword intent routing, chooses search expressions.
    const ids=this.db.prepare(`SELECT id FROM captures_fts WHERE captures_fts MATCH ? ORDER BY rank LIMIT 500`).all(terms) as {id:string}[];
    const placeholders=ids.map(()=>'?').join(',');
    const rows=this.db.prepare(`SELECT * FROM captures${where}${conjunction}(instr(lower(mote_search_text(json)),lower(?))>0${ids.length?` OR id IN (${placeholders})`:''}) ORDER BY captured_at DESC,id DESC LIMIT ?`)
      .all(...values,query,...ids.map(i=>i.id),Math.min(range.limit??50,200)) as unknown as Row[];
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
    if(this.key) {
      if(raw.subarray(0,5).toString()!=='MOTE1')throw new StoreError('Invalid encrypted blob header',500);
      const decipher=createDecipheriv('aes-256-gcm',this.key,raw.subarray(5,17));decipher.setAuthTag(raw.subarray(17,33));
      bytes=Buffer.concat([decipher.update(raw.subarray(33)),decipher.final()]);
    }
    if(sha256(bytes)!==hash)throw new StoreError('Image checksum failed',500);
    return bytes;
  }
  heartbeat(beat:Heartbeat) {
    const record:DeviceRecord={...beat,lastSeenAt:new Date().toISOString()};
    this.db.prepare('INSERT INTO devices(id,json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(beat.deviceId,JSON.stringify(record));return {ok:true};
  }
  devices():DeviceRecord[] {return (this.db.prepare('SELECT json FROM devices').all() as {json:string}[]).map(r=>JSON.parse(r.json));}
  activity(range:Range={}):Activity {
    // Assign overlapping sample intervals once per device before applying content/app filters.
    // A filtered query must not reassign another app's already measured interval to its own samples.
    const extended:Range={deviceId:range.deviceId,after:range.after,before:range.before?new Date(Date.parse(range.before)+300000).toISOString():undefined};
    const {where,values}=this.clauses(extended);
    const rows=this.db.prepare(`SELECT * FROM captures${where} ORDER BY captured_at ASC,id ASC`).all(...values) as unknown as Row[];
    type Counts={durationMs:number;captures:number;activityEvents:number;contentCaptures:number};
    const apps=new Map<string,Counts&{appId:string;appName:string}>(),devices=new Map<string,Counts&{deviceId:string;deviceName:string}>(),ends=new Map<string,number>();
    const lower=range.after?Date.parse(range.after):-Infinity,upper=range.before?Date.parse(range.before):Infinity;
    let totalDurationMs=0,captures=0,activityEvents=0,contentCaptures=0;
    for(const row of rows) {
      const c=this.record(row);if(c.source!=='screen'&&c.source!=='activity')continue;
      const t=Date.parse(c.capturedAt),end=Math.min(t,upper),start=Math.max(t-c.durationMs,lower,ends.get(c.deviceId)??-Infinity),durationMs=Math.max(0,end-start);
      if((t<lower||t>=upper)&&!durationMs)continue;
      if(durationMs>0)ends.set(c.deviceId,Math.max(ends.get(c.deviceId)??-Infinity,end));
      const activity=c.source==='activity';
      if(range.source&&c.source!==range.source||range.appId!==undefined&&c.appId!==range.appId||range.collection==='activity'&&!activity||range.collection==='content'&&(activity||c.privacy.collection==='activity'))continue;
      const appKey=JSON.stringify(c.appId?['id',c.appId]:['name',c.appName]);
      const app=apps.get(appKey)??{appId:c.appId,appName:c.appName||'未识别应用',durationMs:0,captures:0,activityEvents:0,contentCaptures:0};
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
  logicalBytes() {return Number((this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM blobs').get() as {n:number}).n)+Number((this.db.prepare('SELECT COALESCE(SUM(length(CAST(json AS BLOB))),0) AS n FROM (SELECT json FROM captures UNION ALL SELECT json FROM memories UNION ALL SELECT json FROM source_connections)').get() as {n:number}).n);}
  stats() {
    const counts=this.db.prepare("SELECT COUNT(*) AS captures, COUNT(blob_hash) AS imageCaptures, SUM(CASE WHEN json_extract(json,'$.source')='activity' THEN 1 ELSE 0 END) AS activityEvents, SUM(CASE WHEN json_extract(json,'$.source')='media' THEN 1 ELSE 0 END) AS mediaEvents, MIN(captured_at) AS firstCaptureAt,MAX(captured_at) AS lastCaptureAt FROM captures").get() as {captures:number;imageCaptures:number;activityEvents:number|null;mediaEvents:number|null;firstCaptureAt:string|null;lastCaptureAt:string|null};
    const blob=this.db.prepare('SELECT COUNT(*) AS blobs,COALESCE(SUM(bytes),0) AS imageBytes FROM blobs').get() as {blobs:number;imageBytes:number};
    const indexing=this.db.prepare('SELECT index_status AS status,COUNT(*) AS count FROM captures GROUP BY index_status').all();
    const physicalBytes=[join(this.directory,'mote.sqlite'),join(this.directory,'mote.sqlite-wal'),...readdirSync(this.blobsDir).map(p=>join(this.blobsDir,p))].reduce((n,p)=>n+(existsSync(p)?statSync(p).size:0),0);
    return {...counts,activityEvents:counts.activityEvents??0,mediaEvents:counts.mediaEvents??0,...blob,bytes:physicalBytes,logicalBytes:this.logicalBytes(),maxBytes:this.options.maxStorageBytes??null,indexing,imagesEncrypted:Boolean(this.key)};
  }
  exportArchive(maxBytes:number) {
    const stats=this.stats() as {logicalBytes:number;captures:number};
    // Portable v1 embeds a blob for EACH observation. Account for expanded repetitions before allocation.
    const estimated=Number((this.db.prepare('SELECT COALESCE(SUM(length(CAST(c.json AS BLOB)) + 4 * ((COALESCE(b.bytes,0) + 2) / 3) + 240),0) AS n FROM captures c LEFT JOIN blobs b ON b.hash=c.blob_hash').get() as {n:number}).n)+200;
    if(estimated>maxBytes||stats.captures>20000)throw new StoreError('Archive too large for HTTP export; use npm run backup for a consistent database backup',413);
    const rows=this.db.prepare('SELECT * FROM captures ORDER BY captured_at,id').all() as unknown as Row[];
    const captures=rows.map(row=>{const c=JSON.parse(row.json);return {...c,receivedAt:row.received_at,...(row.blob_hash?{imageMime:row.mime,imageBase64:this.readBlob(row.blob_hash).toString('base64')}:{}),blobHash:row.blob_hash};});
    const archive={version:1,exportedAt:new Date().toISOString(),captures,sources:(this.db.prepare('SELECT json FROM source_connections').all() as {json:string}[]).map(r=>JSON.parse(r.json)),sourceVersions:this.db.prepare('SELECT * FROM source_versions WHERE capture_id IN (SELECT id FROM captures)').all(),sourceHeads:this.db.prepare('SELECT * FROM source_heads WHERE capture_id IN (SELECT id FROM captures)').all(),memories:(this.db.prepare('SELECT json FROM memories').all() as {json:string}[]).map(r=>JSON.parse(r.json))};
    if(Buffer.byteLength(JSON.stringify(archive))>maxBytes)throw new StoreError('Expanded archive exceeds the export limit; use npm run backup',413);
    return archive;
  }
  delete(id:string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result=this.db.prepare('DELETE FROM captures WHERE id=?').run(id);this.db.prepare('DELETE FROM captures_fts WHERE id=?').run(id);
      if(result.changes)this.db.prepare('INSERT INTO changes(id,operation,changed_at) VALUES(?,?,?)').run(id,'delete',new Date().toISOString());
      // Derived retrospectives can refer to removed evidence; invalidate, rather than retain stale personal facts.
      if(result.changes){this.db.exec('DELETE FROM insights; DELETE FROM memories');this.db.prepare('UPDATE source_heads SET deleted=1 WHERE capture_id=?').run(id);}
      this.db.exec('COMMIT');this.sweep();return {deleted:Number(result.changes)};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  prune(before:string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT INTO changes(id,operation,changed_at) SELECT id,'delete',? FROM captures WHERE captured_at < ?").run(new Date().toISOString(),before);
      this.db.prepare('DELETE FROM captures_fts WHERE id IN (SELECT id FROM captures WHERE captured_at < ?)').run(before);
      const result=this.db.prepare('DELETE FROM captures WHERE captured_at < ?').run(before);
      if(result.changes){this.db.exec('DELETE FROM insights; DELETE FROM memories; UPDATE source_heads SET deleted=1 WHERE capture_id NOT IN (SELECT id FROM captures)');}this.db.exec('COMMIT');this.sweep();return Number(result.changes);
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  sweep() {
    this.db.exec('DELETE FROM blobs WHERE hash NOT IN (SELECT blob_hash FROM captures WHERE blob_hash IS NOT NULL)');
    const known=new Set((this.db.prepare('SELECT hash FROM blobs').all() as {hash:string}[]).map(r=>r.hash));
    for(const file of readdirSync(this.blobsDir))if((/^[a-f0-9]{64}$/.test(file)&&!known.has(file))||/^[a-f0-9]{64}\.[a-f0-9]+\.tmp$/.test(file))unlinkSync(join(this.blobsDir,file));
  }
  pending(limit=10) {return (this.db.prepare("SELECT * FROM captures WHERE index_status='pending' AND json_extract(json,'$.source')!='activity' ORDER BY received_at LIMIT ?").all(limit) as unknown as Row[]).map(r=>this.record(r));}
  indexCounts() {
    const result={pending:0,failed:0,indexed:0,textReady:0};
    for(const row of this.db.prepare('SELECT index_status AS status,COUNT(*) AS count FROM captures GROUP BY index_status').all() as {status:string;count:number}[]) {
      if(row.status==='pending')result.pending=row.count;else if(row.status==='failed')result.failed=row.count;else if(row.status==='indexed')result.indexed=row.count;else if(row.status==='text_ready')result.textReady=row.count;
    }
    return result;
  }
  indexed(id:string,embedding:number[],model:string) {this.db.prepare("UPDATE captures SET embedding=?,embedding_model=?,index_status='indexed',index_error=NULL WHERE id=?").run(JSON.stringify(embedding),model,id);}
  indexFailed(id:string,error:string) {this.db.prepare("UPDATE captures SET index_status='failed',index_error=?,attempts=attempts+1 WHERE id=?").run(error.slice(0,500),id);}
  retryIndex() {return {queued:Number(this.db.prepare("UPDATE captures SET index_status='pending' WHERE json_extract(json,'$.source')!='activity' AND length(trim(json_extract(json,'$.ocrText')))>0").run().changes)};}
  updates(cursor:number,limit=100) {
    const rows=this.db.prepare('SELECT seq,id,operation,changed_at FROM changes WHERE seq>? ORDER BY seq LIMIT ?').all(cursor,limit) as {seq:number;id:string;operation:string;changed_at:string}[];
    return {items:rows.map(r=>({...r,record:r.operation==='upsert'?this.evidence([r.id])[0]??null:null})),nextCursor:rows.at(-1)?.seq??cursor};
  }
  deletionRevision() {return Number((this.db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM changes WHERE operation IN ('delete','supersede')").get() as {n:number}).n);}
  saveInsight(result:unknown,id:string) {this.db.prepare('INSERT INTO insights(id,created_at,json) VALUES(?,?,?)').run(id,new Date().toISOString(),JSON.stringify(result));}
  insights() {return (this.db.prepare('SELECT id,created_at,json FROM insights ORDER BY created_at DESC LIMIT 30').all() as {id:string;created_at:string;json:string}[]).map(r=>({id:r.id,createdAt:r.created_at,...JSON.parse(r.json)}));}
  close() {this.db.close();}
}
