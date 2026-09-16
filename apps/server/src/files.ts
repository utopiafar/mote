import {createCipheriv,createDecipheriv,randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFileSync,existsSync,mkdirSync,writeFileSync,renameSync,rmSync,readdirSync,openSync,closeSync,fsyncSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {fileRevisionSchema,FILE_MAX_BYTES,FILE_PART_BYTES,type FileRevision,type CaptureRecord,fileEvidenceSchema} from '@mote/shared';
import type {ContextRecord,ContextRange} from '@mote/agent';
import {Store,StoreError,sha256} from './store.js';
import {SourceStore} from './sources.js';
import {privateDirectory,privateFile} from './private-storage.js';

type Upload={id:string;source_id:string;manifest:string;fingerprint:string;created_at:string;ack:string|null};
type Version={capture_id:string;source_id:string;external_id:string;revision:string;manifest:string;object_hash:string|null};
type Chunk={id:string;capture_id:string;artifact_id:string;start_ms:number|null;end_ms:number|null;text:string;metadata?:string};
const activeChunks="a.current=1 AND NOT EXISTS (SELECT 1 FROM file_artifacts preferred WHERE preferred.capture_id=a.capture_id AND preferred.current=1 AND ((preferred.kind='corrected-dialogue' AND a.kind!='corrected-dialogue') OR (preferred.kind='dialogue' AND a.kind IN ('transcript','text','image-text'))))";
const timestamp=()=>new Date().toISOString();
function durable(path:string,bytes:Buffer){writeFileSync(path,bytes,{mode:0o600,flag:'wx'});const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function syncDir(path:string){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}

/** Bounded, encrypted parts. No caller supplies a filesystem path. */
export class FileStore {
  readonly objects:string;
  readonly uploads:string;
  private pending=new Map<string,Promise<unknown>>();
  constructor(readonly store:Store,readonly sources:SourceStore){
    const root=join(store.directory,'files');privateDirectory(root);
    this.objects=join(root,'objects');this.uploads=join(root,'uploads');privateDirectory(this.objects);privateDirectory(this.uploads);
  }
  capabilities(){return {version:1,modes:['archive','reference'],partBytes:FILE_PART_BYTES,maxFileBytes:FILE_MAX_BYTES,initialSync:['all','new_only'],deletionPolicy:'retain_central'};}
  private seal(bytes:Buffer){if(!this.store.key)return bytes;const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.store.key,iv);return Buffer.concat([iv,c.update(bytes),c.final(),c.getAuthTag()]);}
  private unseal(bytes:Buffer){if(!this.store.key)return bytes;if(bytes.length<28)throw new StoreError('Invalid encrypted file part',500);const d=createDecipheriv('aes-256-gcm',this.store.key,bytes.subarray(0,12));d.setAuthTag(bytes.subarray(-16));return Buffer.concat([d.update(bytes.subarray(12,-16)),d.final()]);}
  async serialize<T>(key:string,action:()=>Promise<T>):Promise<T>{const prior=this.pending.get(key)??Promise.resolve();const next=prior.catch(()=>{}).then(action);this.pending.set(key,next);try{return await next;}finally{if(this.pending.get(key)===next)this.pending.delete(key);}}
  private allowed(input:FileRevision){
    const source=this.sources.getSource(input.sourceId);
    if(!source.enabled)throw new StoreError('Source paused',409);
    if(source.retention!=='archive'&&input.item.layer==='original')throw new StoreError('Source must explicitly select original archive retention',409);
    if(this.store.db.prepare('SELECT 1 FROM file_forgotten WHERE source_id=? AND external_id=?').get(input.sourceId,input.item.externalId))throw new StoreError('File was forgotten; explicitly allow this file before syncing again',410);
    const version=this.store.db.prepare('SELECT capture_id FROM source_versions WHERE source_id=? AND external_id=? AND revision=?').get(input.sourceId,input.item.externalId,input.item.revision) as {capture_id:string}|undefined;
    if(version&&!this.store.evidence([version.capture_id]).length)throw new StoreError('Revision was deleted',410);
  }
  begin(raw:unknown,authorize:(sourceId:string)=>void){
    const input=fileRevisionSchema.parse(raw);authorize(input.sourceId);this.allowed(input);
    if(input.item.layer!=='original'||input.item.deleted)throw new StoreError('Upload sessions require an original file');
    const manifest=JSON.stringify(input),fingerprint=sha256(manifest);
    const committed=this.store.db.prepare('SELECT * FROM file_versions WHERE source_id=? AND external_id=? AND revision=?').get(input.sourceId,input.item.externalId,input.item.revision) as Version|undefined;
    if(committed){if(committed.manifest!==manifest)throw new StoreError('Revision content conflicts',409);return {uploadId:committed.capture_id,partBytes:FILE_PART_BYTES,parts:[],ack:{id:committed.capture_id,captureId:committed.capture_id,sourceId:input.sourceId,externalId:input.item.externalId,revision:input.item.revision,objectId:committed.object_hash,sha256:input.sha256,sizeBytes:input.sizeBytes,duplicate:true}};}
    const old=this.store.db.prepare('SELECT * FROM file_uploads WHERE fingerprint=?').get(fingerprint) as Upload|undefined;
    if(old)return this.upload(old.id,authorize);
    if(Number(this.store.db.prepare('SELECT COUNT(*) AS n FROM file_uploads WHERE ack IS NULL').get()!.n)>=64)throw new StoreError('Too many unfinished file uploads',429);
    this.store.reserveMetadata(Buffer.byteLength(manifest)+4096);
    const id=randomUUID();privateDirectory(join(this.uploads,id));
    this.store.db.prepare('INSERT INTO file_uploads(id,source_id,manifest,fingerprint,created_at) VALUES(?,?,?,?,?)').run(id,input.sourceId,manifest,fingerprint,timestamp());
    return this.upload(id,authorize);
  }
  session(id:string,authorize:(sourceId:string)=>void):Upload{
    const row=this.store.db.prepare('SELECT * FROM file_uploads WHERE id=?').get(id) as Upload|undefined;
    if(!row)throw new StoreError('Upload session expired or missing',404);authorize(row.source_id);this.allowed(JSON.parse(row.manifest));return row;
  }
  upload(id:string,authorize:(sourceId:string)=>void){const row=this.session(id,authorize);return {uploadId:id,partBytes:FILE_PART_BYTES,parts:this.store.db.prepare('SELECT part,hash,bytes FROM file_parts WHERE upload_id=? ORDER BY part').all(id),ack:row.ack?JSON.parse(row.ack):null};}
  part(id:string,part:number,bytes:Buffer,authorize:(sourceId:string)=>void){
    const row=this.session(id,authorize);if(row.ack)throw new StoreError('Upload already committed',409);
    const input=JSON.parse(row.manifest) as FileRevision,n=Math.ceil(input.sizeBytes/FILE_PART_BYTES);
    if(!Number.isInteger(part)||part<0||part>=n||bytes.length!==Math.min(FILE_PART_BYTES,input.sizeBytes-part*FILE_PART_BYTES))throw new StoreError('Invalid file part size or offset');
    const hash=sha256(bytes),prior=this.store.db.prepare('SELECT hash FROM file_parts WHERE upload_id=? AND part=?').get(id,part) as {hash:string}|undefined;
    if(prior){if(prior.hash!==hash)throw new StoreError('Part content conflicts',409);return {part,hash,bytes:bytes.length};}
    this.store.reserveMetadata(bytes.length+128);
    const path=join(this.uploads,id,String(part)),temp=path+'.'+randomUUID()+'.tmp';
    try{durable(temp,this.seal(bytes));renameSync(temp,path);syncDir(join(this.uploads,id));this.store.db.prepare('INSERT INTO file_parts VALUES(?,?,?,?)').run(id,part,hash,bytes.length);}finally{rmSync(temp,{force:true});}
    return {part,hash,bytes:bytes.length};
  }
  async commit(id:string,authorize:(sourceId:string)=>void){return this.serialize('upload:'+id,async()=>{
    const row=this.session(id,authorize);if(row.ack)return JSON.parse(row.ack);
    const input=JSON.parse(row.manifest) as FileRevision,parts=this.store.db.prepare('SELECT part,hash,bytes FROM file_parts WHERE upload_id=? ORDER BY part').all(id) as {part:number;hash:string;bytes:number}[];
    if(parts.length!==Math.ceil(input.sizeBytes/FILE_PART_BYTES))throw new StoreError('Upload is incomplete',409);
    const total=createHash('sha256');let size=0;
    for(const [i,p] of parts.entries()){if(p.part!==i)throw new StoreError('Missing file part',409);const bytes=this.unseal(this.readPart(join(this.uploads,id),i));if(bytes.length!==p.bytes||sha256(bytes)!==p.hash)throw new StoreError('File part checksum failed',409);total.update(bytes);size+=bytes.length;}
    if(size!==input.sizeBytes||total.digest('hex')!==input.sha256)throw new StoreError('File checksum failed',409);
    const hash=input.sha256!,destination=join(this.objects,hash);
    if(!existsSync(destination)){
      const staging=destination+'.'+randomUUID()+'.tmp';privateDirectory(staging);
      try{for(const p of parts)durable(join(staging,String(p.part)),this.readPart(join(this.uploads,id),p.part));syncDir(staging);renameSync(staging,destination);syncDir(this.objects);}finally{rmSync(staging,{recursive:true,force:true});}
    }
    const ack=await this.revision(input,authorize,(captureId)=>{
      const value={id:captureId,captureId,sourceId:input.sourceId,externalId:input.item.externalId,revision:input.item.revision,objectId:hash,sha256:hash,sizeBytes:input.sizeBytes,duplicate:false};
      this.store.db.prepare('UPDATE file_uploads SET ack=? WHERE id=?').run(JSON.stringify(value),id);return value;
    });
    this.store.db.prepare('UPDATE file_uploads SET ack=? WHERE id=?').run(JSON.stringify(ack),id);rmSync(join(this.uploads,id),{recursive:true,force:true});return ack;
  });}
  async revision(raw:unknown,authorize:(sourceId:string)=>void,onCommit?:(id:string)=>unknown):Promise<any>{
    const input=fileRevisionSchema.parse(raw);return this.serialize('item:'+input.sourceId+':'+input.item.externalId,async()=>{
      authorize(input.sourceId);this.allowed(input);
      const prior=this.store.db.prepare('SELECT * FROM file_versions WHERE source_id=? AND external_id=? AND revision=?').get(input.sourceId,input.item.externalId,input.item.revision) as Version|undefined;
      if(prior){if(prior.manifest!==JSON.stringify(input))throw new StoreError('Revision content conflicts',409);return {id:prior.capture_id,captureId:prior.capture_id,sourceId:input.sourceId,externalId:input.item.externalId,revision:input.item.revision,objectId:prior.object_hash,sha256:input.sha256,sizeBytes:input.sizeBytes,duplicate:true};}
      if(this.store.db.prepare('SELECT 1 FROM source_versions WHERE source_id=? AND external_id=? AND revision=?').get(input.sourceId,input.item.externalId,input.item.revision))throw new StoreError('Revision belongs to a different ingestion protocol',409);
      const head=this.sources.getItem(input.sourceId,input.item.externalId);
      if((head?.revision??null)!==input.previousRevision)throw new StoreError('Revision predecessor mismatch; upload previous revision first',409);
      if(input.sha256&&!onCommit)throw new StoreError('Original bytes require an upload commit');
      this.store.reserveMetadata(Buffer.byteLength(JSON.stringify(input))+4096);
      let ack:unknown;
      await this.sources.upsert(input.sourceId,input.item,()=>{authorize(input.sourceId);this.allowed(input);},({id:captureId})=>{
        const previousFile=this.store.db.prepare('SELECT capture_id FROM file_heads WHERE source_id=? AND external_id=?').get(input.sourceId,input.item.externalId) as {capture_id:string}|undefined;
        if(!input.item.deleted&&previousFile&&previousFile.capture_id!==captureId)this.store.invalidateMemoryEvidence(previousFile.capture_id);
        const hash=input.item.deleted?null:input.sha256??null;
        if(hash)this.store.db.prepare('INSERT OR IGNORE INTO file_objects VALUES(?,?,?)').run(hash,input.sizeBytes,Math.ceil(input.sizeBytes/FILE_PART_BYTES));
        this.store.db.prepare('INSERT INTO file_versions VALUES(?,?,?,?,?,?)').run(captureId,input.sourceId,input.item.externalId,input.item.revision,JSON.stringify(input),hash);
        // File predecessors establish order even when a device clock moves backwards.
        this.store.db.prepare('UPDATE source_heads SET capture_id=?,observed_at=?,deleted=? WHERE source_id=? AND external_id=?').run(captureId,input.item.observedAt,Number(input.item.deleted),input.sourceId,input.item.externalId);
        if(input.item.deleted)this.store.db.prepare('UPDATE file_heads SET origin_missing=1 WHERE source_id=? AND external_id=?').run(input.sourceId,input.item.externalId);
        else this.store.db.prepare('INSERT INTO file_heads VALUES(?,?,?,0) ON CONFLICT(source_id,external_id) DO UPDATE SET capture_id=excluded.capture_id,origin_missing=0').run(input.sourceId,input.item.externalId,captureId);
        if(hash)this.store.db.prepare('INSERT INTO file_jobs(capture_id) VALUES(?)').run(captureId);
        ack=onCommit?.(captureId)??{id:captureId,captureId,sourceId:input.sourceId,externalId:input.item.externalId,revision:input.item.revision,duplicate:false};
      });return ack;
    });
  }
  version(id:string){const v=this.store.db.prepare('SELECT * FROM file_versions WHERE capture_id=?').get(id) as Version|undefined;if(!v)throw new StoreError('File not found',404);return v;}
  detail(id:string,includeArtifacts=true){
    const v=this.version(id),db=this.store.db,head=db.prepare('SELECT origin_missing FROM file_heads WHERE capture_id=?').get(id) as {origin_missing:number}|undefined;
    const artifacts=includeArtifacts?(db.prepare('SELECT id,kind,created_at,json FROM file_artifacts WHERE capture_id=? AND current=1 ORDER BY created_at').all(id) as {id:string;kind:string;created_at:string;json:string}[]).map(a=>{
      const {transcript,segments,...data}=JSON.parse(a.json);return {id:a.id,kind:a.kind,createdAt:a.created_at,...data,...(transcript?{durationMs:transcript.durationMs,segments:transcript.segments.length,warnings:transcript.warnings}:segments?{segments:Array.isArray(segments)?segments.length:segments}:{})};
    }):[];
    return {captureId:id,...JSON.parse(v.manifest),hasOriginal:!!v.object_hash,originMissing:!!head?.origin_missing,job:db.prepare('SELECT state,stage,attempts,error,summary_state,local_only FROM file_jobs WHERE capture_id=?').get(id)??null,artifacts,steps:includeArtifacts?db.prepare('SELECT step,processor,version,state,attempts,error FROM file_steps WHERE capture_id=? ORDER BY rowid').all(id):[]};
  }
  saveAsset(artifactId:string,name:string,mime:string,bytes:Buffer){
    if(!/^speaker_samples\/SPEAKER_[0-9]{1,2}\.wav$/.test(name)||bytes.length>768*1024)throw new StoreError('Invalid artifact asset');
    this.store.reserveMetadata(bytes.length+1024);const hash=sha256(bytes),destination=join(this.objects,hash);
    if(!existsSync(destination)){const temp=destination+'.'+randomUUID()+'.tmp';privateDirectory(temp);try{durable(join(temp,'0'),this.seal(bytes));syncDir(temp);renameSync(temp,destination);syncDir(this.objects);}finally{rmSync(temp,{force:true,recursive:true});}}
    this.store.db.prepare('INSERT OR IGNORE INTO file_objects VALUES(?,?,?)').run(hash,bytes.length,1);
    this.store.db.prepare('INSERT INTO file_assets VALUES(?,?,?,?)').run(artifactId,name,mime,hash);
  }
  asset(captureId:string,artifactId:string,name:string){
    this.version(captureId);const row=this.store.db.prepare('SELECT f.object_hash,f.mime FROM file_assets f JOIN file_artifacts a ON a.id=f.artifact_id WHERE a.capture_id=? AND a.id=? AND f.name=?').get(captureId,artifactId,name) as {object_hash:string;mime:string}|undefined;
    if(!row||!/^[a-f0-9]{64}$/.test(row.object_hash))throw new StoreError('Asset not found',404);
    return {mime:row.mime,bytes:this.unseal(this.readPart(join(this.objects,row.object_hash),0))};
  }

  list(args:ContextRange&{sourceId?:string;query?:string;mimePrefix?:string}={}){
    const clauses=['h.capture_id=v.capture_id','c.id=v.capture_id'],values:(string|number)[]=[];
    for(const [key,column] of [['sourceId','v.source_id'],['deviceId','c.device_id'],['after','c.captured_at'],['before','c.captured_at']] as const){if(args[key]){clauses.push(`${column} ${key==='after'?'>=':key==='before'?'<':'='} ?`);values.push(args[key]!);}}
    if(args.query){clauses.push("(instr(lower(json_extract(c.json,'$.windowTitle')),lower(?))>0 OR instr(lower(json_extract(v.manifest,'$.relativePath')),lower(?))>0)");values.push(args.query,args.query);}
    if(args.mimePrefix){clauses.push("instr(json_extract(v.manifest,'$.item.mimeType'),?)=1");values.push(args.mimePrefix);}
    const offset=Number(args.cursor??0);if(!Number.isSafeInteger(offset)||offset<0)throw new StoreError('Invalid cursor');
    const limit=Math.min(200,Math.max(1,args.limit??50)),rows=this.store.db.prepare(`SELECT v.capture_id FROM file_versions v,file_heads h,captures c WHERE ${clauses.join(' AND ')} ORDER BY c.captured_at DESC,c.id LIMIT ? OFFSET ?`).all(...values,limit+1,offset) as {capture_id:string}[];
    return {items:rows.slice(0,limit).map(r=>this.detail(r.capture_id,false)),nextCursor:rows.length>limit?String(offset+limit):null};
  }
  private readPart(directory:string,part:number){privateDirectory(directory);const path=join(directory,String(part));privateFile(path);return readFileSync(path);}
  *bytes(id:string,start=0,end?:number):Generator<Buffer>{const v=this.version(id);if(!v.object_hash)throw new StoreError('Original is not archived',404);if(!/^[a-f0-9]{64}$/.test(v.object_hash))throw new StoreError('Invalid object identifier',500);const m=JSON.parse(v.manifest) as FileRevision;end??=m.sizeBytes-1;
    if(start<0||end>=m.sizeBytes||start>end){if(m.sizeBytes===0&&start===0)return;throw new StoreError('Invalid byte range',416);}
    for(let p=Math.floor(start/FILE_PART_BYTES);p<=Math.floor(end/FILE_PART_BYTES);p++){this.version(id);const bytes=this.unseal(this.readPart(join(this.objects,v.object_hash),p));yield bytes.subarray(Math.max(0,start-p*FILE_PART_BYTES),Math.min(bytes.length,end-p*FILE_PART_BYTES+1));}
  }
  stream(id:string,start=0,end?:number){return Readable.from(this.bytes(id,start,end));}
  chunks(id:string,offset=0,limit=100){this.version(id);return (this.store.db.prepare(`SELECT c.* FROM file_chunks c JOIN file_artifacts a ON a.id=c.artifact_id WHERE c.capture_id=? AND ${activeChunks} ORDER BY c.start_ms,c.rowid LIMIT ? OFFSET ?`).all(id,Math.min(limit,200),offset) as Chunk[]).map(c=>this.chunkRecord(c));}
  private chunkRecord(c:Chunk):CaptureRecord & ContextRecord{const record=this.store.evidence([c.capture_id])[0],v=this.version(c.capture_id);return {...record,id:c.id,capturedAt:record.capturedAt,deviceId:record.deviceId,appName:record.appName,windowTitle:record.windowTitle,sourceType:'file',ocrText:((JSON.parse(c.metadata??'{}') as {speaker?:string}).speaker?`[${JSON.parse(c.metadata??'{}').speaker}] `:'')+c.text,durationMs:0,provenance:{...record.provenance!,layer:'derived'},fileEvidence:fileEvidenceSchema.parse({captureId:c.capture_id,revision:v.revision,artifactId:c.artifact_id,chunkId:c.id,...JSON.parse(c.metadata??'{}'),...(c.start_ms===null?{}:{startMs:c.start_ms,endMs:c.end_ms})})};}
  /** Only the preferred transcript/text of the retained current file revision is independent evidence. */
  isCurrentEvidence(id:string):boolean {
    return Boolean(this.store.db.prepare(`SELECT c.id FROM file_chunks c JOIN file_artifacts a ON a.id=c.artifact_id JOIN file_heads h ON h.capture_id=c.capture_id JOIN file_versions v ON v.capture_id=c.capture_id WHERE c.id=? AND ${activeChunks} AND a.kind IN ('text','image-text','transcript','dialogue','corrected-dialogue')`).get(id));
  }
  evidence(ids:string[]){return ids.flatMap(id=>{const c=this.store.db.prepare('SELECT c.* FROM file_chunks c JOIN file_artifacts a ON a.id=c.artifact_id WHERE c.id=? AND a.current=1').get(id) as Chunk|undefined;return c?[this.chunkRecord(c)]:[];});}
  search(args:ContextRange&{query?:string}){if(args.source&&args.source!=='file'||args.collection==='activity')return [];const q=args.query?.trim();if(!q)return [];
    const clauses=['h.capture_id=c.capture_id','a.id=c.artifact_id',activeChunks,'r.id=c.capture_id'],values:(string|number)[]=[];
    for(const [key,column] of [['appId',"json_extract(r.json,'$.appId')"],['deviceId','r.device_id'],['after','r.captured_at'],['before','r.captured_at']] as const)if(args[key]){clauses.push(`${column} ${key==='after'?'>=':key==='before'?'<':'='} ?`);values.push(args[key]!);}
    const base=`FROM file_chunks c,file_artifacts a,file_heads h,captures r WHERE ${clauses.join(' AND ')}`;
    let rows:Chunk[];try{rows=this.store.db.prepare(`SELECT c.* ${base} AND c.id IN (SELECT id FROM file_chunks_fts WHERE file_chunks_fts MATCH ?) LIMIT ?`).all(...values,q,Math.min(args.limit??30,100)) as Chunk[];}catch{rows=[];}
    if(!rows.length)rows=this.store.db.prepare(`SELECT c.* ${base} AND instr(lower(c.text),lower(?))>0 LIMIT ?`).all(...values,q,Math.min(args.limit??30,100)) as Chunk[];
    return rows.map(c=>this.chunkRecord(c));
  }
  pendingIndex(model:string,allowLocalOnly=false){return this.store.db.prepare(`SELECT c.id,c.text FROM file_chunks c JOIN file_artifacts a ON a.id=c.artifact_id JOIN file_jobs j ON j.capture_id=c.capture_id WHERE ${activeChunks} AND (?=1 OR j.local_only=0) AND c.index_error IS NULL AND (c.embedding IS NULL OR c.embedding_model!=?) ORDER BY c.rowid LIMIT 8`).all(Number(allowLocalOnly),model) as {id:string;text:string}[];}
  indexed(id:string,vector:number[],model:string){const json=JSON.stringify(vector);this.store.reserveMetadata(Buffer.byteLength(json));this.store.db.prepare('UPDATE file_chunks SET embedding=?,embedding_model=?,index_error=NULL WHERE id=? AND artifact_id IN (SELECT id FROM file_artifacts WHERE current=1)').run(json,model,id);}
  indexFailed(id:string){this.store.db.prepare("UPDATE file_chunks SET index_error='provider_failed' WHERE id=?").run(id);}
  vectorSearch(vector:number[],model:string,args:ContextRange){
    if(args.source&&args.source!=='file'||args.collection==='activity')return [];
    const clauses=['h.capture_id=c.capture_id','a.id=c.artifact_id',activeChunks,'r.id=c.capture_id','c.embedding_model=?','c.embedding IS NOT NULL'],values:(string|number)[]=[model];
    for(const [key,column] of [['appId',"json_extract(r.json,'$.appId')"],['deviceId','r.device_id'],['after','r.captured_at'],['before','r.captured_at']] as const)if(args[key]){clauses.push(`${column} ${key==='after'?'>=':key==='before'?'<':'='} ?`);values.push(args[key]!);}
    const rows=this.store.db.prepare(`SELECT c.* FROM file_chunks c,file_artifacts a,file_heads h,captures r WHERE ${clauses.join(' AND ')}`).iterate(...values);
    const norm=Math.hypot(...vector),best:{row:Chunk;score:number}[]=[],limit=Math.min(args.limit??30,100);
    for(const raw of rows){const row=raw as Chunk&{embedding:string},v=JSON.parse(row.embedding) as number[],vn=Math.hypot(...v);if(v.length!==vector.length||!vn||!norm)continue;
      const score=v.reduce((sum,n,i)=>sum+n*vector[i],0)/(vn*norm);best.push({row,score});best.sort((a,b)=>b.score-a.score);if(best.length>limit)best.pop();
    }
    return best.map(r=>this.chunkRecord(r.row));
  }
  forget(id:string){const v=this.version(id);this.store.db.prepare('INSERT OR IGNORE INTO file_forgotten VALUES(?,?)').run(v.source_id,v.external_id);const ids=this.store.db.prepare('SELECT capture_id FROM file_versions WHERE source_id=? AND external_id=?').all(v.source_id,v.external_id) as {capture_id:string}[];for(const r of ids)this.store.delete(r.capture_id);this.sweep();return {deleted:ids.length};}
  sweep(){
    for(const u of this.store.db.prepare('SELECT id FROM file_uploads WHERE ack IS NOT NULL OR created_at<?').all(new Date(Date.now()-7*86400000).toISOString()) as {id:string}[]){rmSync(join(this.uploads,u.id),{recursive:true,force:true});this.store.db.prepare('DELETE FROM file_uploads WHERE id=?').run(u.id);}
    this.store.db.exec('DELETE FROM file_objects WHERE hash NOT IN (SELECT object_hash FROM file_versions WHERE object_hash IS NOT NULL UNION SELECT object_hash FROM file_assets)');
    for(const name of readdirSync(this.objects)){const path=join(this.objects,name);if(Date.now()-statSync(path).mtimeMs<3600000)continue;if(!/^[a-f0-9]{64}(\.[a-f0-9-]+\.tmp)?$/.test(name))continue;if(!this.store.db.prepare('SELECT 1 FROM file_objects WHERE hash=?').get(name))rmSync(path,{recursive:true,force:true});}
  }
}
