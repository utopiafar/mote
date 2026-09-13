import { DatabaseSync } from 'node:sqlite';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import { captureSchema, type CaptureInput, type CaptureRecord, type Heartbeat, type DeviceRecord, type Activity } from '@mote/shared';

export class StoreError extends Error { constructor(message:string, public statusCode=400) {super(message);} }
export const sha256 = (v:Buffer|string) => createHash('sha256').update(v).digest('hex');
type Range = {after?:string;before?:string;deviceId?:string;source?:CaptureInput['source'];limit?:number;cursor?:string};
type Prepared = {input:CaptureInput;bytes?:Buffer;hash:string|null;fingerprint:string;receivedAt?:string};
type Row = {id:string;json:string;received_at:string;blob_hash:string|null;mime:string|null;index_status:CaptureRecord['indexingStatus'];summary:string|null};
export class Store {
  db:DatabaseSync;
  blobsDir:string;
  key?:Buffer;
  constructor(public directory:string, private options:{dataKey?:string;maxStorageBytes?:number;embeddingEnabled?:boolean}={}) {
    mkdirSync(directory,{recursive:true,mode:0o700});
    this.blobsDir=join(directory,'blobs'); mkdirSync(this.blobsDir,{recursive:true,mode:0o700});
    if(options.dataKey) {
      if(!/^[0-9a-f]{64}$/i.test(options.dataKey)) throw new Error('MOTE_DATA_KEY must be 64 hexadecimal characters');
      this.key=Buffer.from(options.dataKey,'hex');
    }
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
      CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, mime TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS insights (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, operation TEXT NOT NULL, changed_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS captures_fts USING fts5(id UNINDEXED, text, tokenize='unicode61');
      PRAGMA user_version=1;`);
    const marker=this.db.prepare('SELECT value FROM settings WHERE key=?').get('encryption') as {value:string}|undefined;
    const expected=this.key ? sha256(this.key) : 'none';
    if(marker && marker.value!==expected) {this.db.close();throw new Error('Vault encryption key mismatch. Restore the original MOTE_DATA_KEY; do not change keys on an existing vault.');}
    this.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run('encryption',expected);
    // Remove only orphan content-addressed files left by interrupted writes/transactions.
    this.sweep();
  }
  private record(row:Row):CaptureRecord {
    return {...JSON.parse(row.json),receivedAt:row.received_at,blobHash:row.blob_hash,imageMime:row.mime,indexingStatus:row.index_status,...(row.summary?{summary:row.summary}:{})};
  }
  private clauses(range:Range={}) {
    const clauses:string[]=[]; const values:(string|number)[]=[];
    if(range.after) {clauses.push('captured_at >= ?');values.push(new Date(range.after).toISOString());}
    if(range.before) {clauses.push('captured_at < ?');values.push(new Date(range.before).toISOString());}
    if(range.deviceId) {clauses.push('device_id = ?');values.push(range.deviceId);}
    if(range.source) {clauses.push("json_extract(json,'$.source') = ?");values.push(range.source);}
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
    const prior=this.db.prepare('SELECT fingerprint,blob_hash,index_status FROM captures WHERE id=?').get(p.input.id) as {fingerprint:string;blob_hash:string|null;index_status:string}|undefined;
    if(prior) {
      if(prior.fingerprint!==p.fingerprint)throw new StoreError('Event ID already exists with different content',409);
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
    const status=this.options.embeddingEnabled&&p.input.ocrText.trim()?'pending':'text_ready';
    const receivedAt=p.receivedAt??new Date().toISOString();
    this.db.prepare('INSERT INTO captures(id,device_id,captured_at,received_at,json,fingerprint,blob_hash,mime,index_status) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(p.input.id,p.input.deviceId,p.input.capturedAt,receivedAt,json,p.fingerprint,p.hash,imageMime??null,status);
    this.db.prepare('INSERT INTO captures_fts(id,text) VALUES(?,?)').run(p.input.id,[p.input.appName,p.input.windowTitle,p.input.ocrText,p.input.mood??''].join('\n'));
    this.db.prepare('INSERT INTO changes(id,operation,changed_at) VALUES(?,?,?)').run(p.input.id,'upsert',new Date().toISOString());
    const device=this.db.prepare('SELECT json FROM devices WHERE id=?').get(p.input.deviceId) as {json:string}|undefined;
    if(!device)this.heartbeat({deviceId:p.input.deviceId,deviceName:p.input.deviceName,platform:p.input.platform,status:'offline',queueDepth:0,lastCaptureAt:p.input.capturedAt});
    return {id:p.input.id,duplicate:false,blobHash:p.hash,indexingStatus:status};
  }
  async ingest(raw:unknown) {
    const p=await this.prepare(raw);
    this.db.exec('BEGIN IMMEDIATE');
    try {const result=this.insert(p);this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');this.sweep();throw e;}
  }
  async importArchive(raw:unknown) {
    const archive=raw as {version?:number;captures?:unknown[]};
    if(archive?.version!==1||!Array.isArray(archive.captures)||archive.captures.length>20000)throw new StoreError('Expected Mote archive version 1 (maximum 20,000 records per import)');
    const prepared:Prepared[]=[];
    for(const entry of archive.captures) {
      if(!entry||typeof entry!=='object'||Array.isArray(entry))throw new StoreError('Archive entries must be capture objects');
      const {blobHash,receivedAt,...capture}=entry as CaptureInput & {blobHash?:string|null;receivedAt?:string};
      const p=await this.prepare(capture);
      if(receivedAt!==undefined) {if(typeof receivedAt!=='string'||!Number.isFinite(Date.parse(receivedAt)))throw new StoreError('Invalid archive receivedAt timestamp');p.receivedAt=new Date(receivedAt).toISOString();}
      if(blobHash!==undefined&&blobHash!==p.hash)throw new StoreError('Archive image checksum mismatch');
      prepared.push(p);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let imported=0,duplicates=0;
      for(const p of prepared)this.insert(p).duplicate?duplicates++:imported++;
      this.db.exec('COMMIT');return {imported,duplicates};
    }catch(e){this.db.exec('ROLLBACK');this.sweep();throw e;}
  }
  list(range:Range={}) {
    const {where,values}=this.clauses(range);const limit=Math.min(200,Math.max(1,range.limit??50));
    const rows=this.db.prepare(`SELECT * FROM captures${where} ORDER BY captured_at DESC,id DESC LIMIT ?`).all(...values,limit+1) as unknown as Row[];
    const more=rows.length>limit;const items=rows.slice(0,limit).map(r=>this.record(r));const last=items.at(-1);
    return {items,nextCursor:more&&last?Buffer.from(JSON.stringify({t:last.capturedAt,id:last.id})).toString('base64url'):null};
  }
  evidence(ids:string[]) {return ids.slice(0,200).map(id=>this.db.prepare('SELECT * FROM captures WHERE id=?').get(id) as Row|undefined).filter((x):x is Row=>Boolean(x)).map(r=>this.record(r));}
  search(range:Range&{query?:string}) {
    if(!range.query?.trim())return this.list(range).items;
    const {where,values}=this.clauses(range); const conjunction=where?' AND ':' WHERE ';
    const query=range.query.trim().slice(0,1000); const terms=query.split(/\s+/).filter(Boolean).slice(0,12).map(s=>'"'+s.replaceAll('"','""')+'"').join(' OR ');
    // Generic lexical primitive. The Agent, never keyword intent routing, chooses search expressions.
    const ids=this.db.prepare(`SELECT id FROM captures_fts WHERE captures_fts MATCH ? ORDER BY rank LIMIT 500`).all(terms) as {id:string}[];
    const placeholders=ids.map(()=>'?').join(',');
    const rows=this.db.prepare(`SELECT * FROM captures${where}${conjunction}(instr(lower(json_extract(json,'$.ocrText')),lower(?))>0 OR instr(lower(json_extract(json,'$.appName')),lower(?))>0 OR instr(lower(COALESCE(json_extract(json,'$.mood'),'')),lower(?))>0${ids.length?` OR id IN (${placeholders})`:''}) ORDER BY captured_at DESC,id DESC LIMIT ?`)
      .all(...values,query,query,query,...ids.map(i=>i.id),Math.min(range.limit??50,200)) as unknown as Row[];
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
    // Include intervals that began before the selected upper edge; clip every interval to query bounds.
    const extended={...range,after:range.after?new Date(Date.parse(range.after)).toISOString():undefined,before:range.before?new Date(Date.parse(range.before)+300000).toISOString():undefined};
    const {where,values}=this.clauses(extended);
    const rows=this.db.prepare(`SELECT * FROM captures${where} ORDER BY captured_at ASC,id ASC`).all(...values) as unknown as Row[];
    const apps=new Map<string,{appName:string;durationMs:number;captures:number}>();const devices=new Map<string,{deviceId:string;deviceName:string;durationMs:number;captures:number}>();const ends=new Map<string,number>();
    const lower=range.after?Date.parse(range.after):-Infinity,upper=range.before?Date.parse(range.before):Infinity;
    let totalDurationMs=0,captures=0;
    for(const row of rows) {
      const c=this.record(row);if(c.source!=='screen')continue;
      const t=Date.parse(c.capturedAt);const end=Math.min(t,upper);const start=Math.max(t-c.durationMs,lower,ends.get(c.deviceId)??-Infinity);const durationMs=Math.max(0,end-start);
      if(t<lower||t>=upper) {if(!durationMs)continue;}
      ends.set(c.deviceId,Math.max(ends.get(c.deviceId)??-Infinity,end));
      const app=apps.get(c.appName)||{appName:c.appName||'未识别应用',durationMs:0,captures:0};app.durationMs+=durationMs;app.captures++;apps.set(c.appName,app);
      const d=devices.get(c.deviceId)||{deviceId:c.deviceId,deviceName:c.deviceName,durationMs:0,captures:0};d.durationMs+=durationMs;d.captures++;devices.set(c.deviceId,d);
      totalDurationMs+=durationMs;captures++;
    }
    return {apps:[...apps.values()].sort((a,b)=>b.durationMs-a.durationMs),devices:[...devices.values()],totalDurationMs,captures};
  }
  logicalBytes() {return Number((this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM blobs').get() as {n:number}).n)+Number((this.db.prepare('SELECT COALESCE(SUM(length(CAST(json AS BLOB))),0) AS n FROM captures').get() as {n:number}).n);}
  stats() {
    const counts=this.db.prepare('SELECT COUNT(*) AS captures, COUNT(blob_hash) AS imageCaptures, MIN(captured_at) AS firstCaptureAt,MAX(captured_at) AS lastCaptureAt FROM captures').get() as {captures:number;imageCaptures:number;firstCaptureAt:string|null;lastCaptureAt:string|null};
    const blob=this.db.prepare('SELECT COUNT(*) AS blobs,COALESCE(SUM(bytes),0) AS imageBytes FROM blobs').get() as {blobs:number;imageBytes:number};
    const indexing=this.db.prepare('SELECT index_status AS status,COUNT(*) AS count FROM captures GROUP BY index_status').all();
    const physicalBytes=[join(this.directory,'mote.sqlite'),join(this.directory,'mote.sqlite-wal'),...readdirSync(this.blobsDir).map(p=>join(this.blobsDir,p))].reduce((n,p)=>n+(existsSync(p)?statSync(p).size:0),0);
    return {...counts,...blob,bytes:physicalBytes,logicalBytes:this.logicalBytes(),maxBytes:this.options.maxStorageBytes??null,indexing,imagesEncrypted:Boolean(this.key)};
  }
  exportArchive(maxBytes:number) {
    const stats=this.stats() as {logicalBytes:number;captures:number};
    // Portable v1 embeds a blob for EACH observation. Account for expanded repetitions before allocation.
    const estimated=Number((this.db.prepare('SELECT COALESCE(SUM(length(CAST(c.json AS BLOB)) + 4 * ((COALESCE(b.bytes,0) + 2) / 3) + 240),0) AS n FROM captures c LEFT JOIN blobs b ON b.hash=c.blob_hash').get() as {n:number}).n)+200;
    if(estimated>maxBytes||stats.captures>20000)throw new StoreError('Archive too large for HTTP export; use npm run backup for a consistent database backup',413);
    const rows=this.db.prepare('SELECT * FROM captures ORDER BY captured_at,id').all() as unknown as Row[];
    const captures=rows.map(row=>{const c=JSON.parse(row.json);return {...c,receivedAt:row.received_at,...(row.blob_hash?{imageMime:row.mime,imageBase64:this.readBlob(row.blob_hash).toString('base64')}:{}),blobHash:row.blob_hash};});
    const archive={version:1,exportedAt:new Date().toISOString(),captures};
    if(Buffer.byteLength(JSON.stringify(archive))>maxBytes)throw new StoreError('Expanded archive exceeds the export limit; use npm run backup',413);
    return archive;
  }
  delete(id:string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result=this.db.prepare('DELETE FROM captures WHERE id=?').run(id);this.db.prepare('DELETE FROM captures_fts WHERE id=?').run(id);
      if(result.changes)this.db.prepare('INSERT INTO changes(id,operation,changed_at) VALUES(?,?,?)').run(id,'delete',new Date().toISOString());
      // Derived retrospectives can refer to removed evidence; invalidate, rather than retain stale personal facts.
      if(result.changes)this.db.exec('DELETE FROM insights');
      this.db.exec('COMMIT');this.sweep();return {deleted:Number(result.changes)};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  prune(before:string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT INTO changes(id,operation,changed_at) SELECT id,'delete',? FROM captures WHERE captured_at < ?").run(new Date().toISOString(),before);
      this.db.prepare('DELETE FROM captures_fts WHERE id IN (SELECT id FROM captures WHERE captured_at < ?)').run(before);
      const result=this.db.prepare('DELETE FROM captures WHERE captured_at < ?').run(before);
      if(result.changes)this.db.exec('DELETE FROM insights');this.db.exec('COMMIT');this.sweep();return Number(result.changes);
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  sweep() {
    this.db.exec('DELETE FROM blobs WHERE hash NOT IN (SELECT blob_hash FROM captures WHERE blob_hash IS NOT NULL)');
    const known=new Set((this.db.prepare('SELECT hash FROM blobs').all() as {hash:string}[]).map(r=>r.hash));
    for(const file of readdirSync(this.blobsDir))if((/^[a-f0-9]{64}$/.test(file)&&!known.has(file))||/^[a-f0-9]{64}\.[a-f0-9]+\.tmp$/.test(file))unlinkSync(join(this.blobsDir,file));
  }
  pending(limit=10) {return (this.db.prepare("SELECT * FROM captures WHERE index_status='pending' ORDER BY received_at LIMIT ?").all(limit) as unknown as Row[]).map(r=>this.record(r));}
  indexed(id:string,embedding:number[],model:string) {this.db.prepare("UPDATE captures SET embedding=?,embedding_model=?,index_status='indexed',index_error=NULL WHERE id=?").run(JSON.stringify(embedding),model,id);}
  indexFailed(id:string,error:string) {this.db.prepare("UPDATE captures SET index_status='failed',index_error=?,attempts=attempts+1 WHERE id=?").run(error.slice(0,500),id);}
  retryIndex() {return {queued:Number(this.db.prepare("UPDATE captures SET index_status='pending' WHERE length(trim(json_extract(json,'$.ocrText')))>0").run().changes)};}
  updates(cursor:number,limit=100) {
    const rows=this.db.prepare('SELECT seq,id,operation,changed_at FROM changes WHERE seq>? ORDER BY seq LIMIT ?').all(cursor,limit) as {seq:number;id:string;operation:string;changed_at:string}[];
    return {items:rows.map(r=>({...r,record:r.operation==='upsert'?this.evidence([r.id])[0]??null:null})),nextCursor:rows.at(-1)?.seq??cursor};
  }
  deletionRevision() {return Number((this.db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM changes WHERE operation='delete'").get() as {n:number}).n);}
  saveInsight(result:unknown,id:string) {this.db.prepare('INSERT INTO insights(id,created_at,json) VALUES(?,?,?)').run(id,new Date().toISOString(),JSON.stringify(result));}
  insights() {return (this.db.prepare('SELECT id,created_at,json FROM insights ORDER BY created_at DESC LIMIT 30').all() as {id:string;created_at:string;json:string}[]).map(r=>({id:r.id,createdAt:r.created_at,...JSON.parse(r.json)}));}
  close() {this.db.close();}
}
