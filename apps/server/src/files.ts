import {z} from 'zod';
import {textSearch} from './text-search.js';
import {randomUUID} from 'node:crypto';
import {rmSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {fileRevisionSchema,FILE_MAX_BYTES,FILE_PART_BYTES,executionEnvelope,transcriptSchema,type SourceItem,type Transcript,type FileRevision,type CaptureRecord,type ArchivedFile,fileEvidenceSchema} from '@mote/shared';
import {writeFileTranscriptChunks} from './file-transcript-chunks.js';
import type {ContextRecord,ContextRange} from '@mote/agent';
import {Store,StoreError,sha256,type Range} from './store.js';
import {SourceStore} from './sources.js';
import {privateDirectory} from './private-storage.js';
import {readFileSpeakerAttributions} from './file-speaker-attribution.js';
import {fileAttachmentAvailable} from './file-attachments.js';

type Upload={id:string;source_id:string;manifest:string;fingerprint:string;created_at:string;ack:string|null};
type Version={capture_id:string;source_id:string;external_id:string;revision:string;manifest:string;object_hash:string|null};
type Chunk={id:string;capture_id:string;artifact_id:string;start_ms:number|null;end_ms:number|null;text:string;metadata?:string};
const activeChunks="a.current=1 AND NOT EXISTS (SELECT 1 FROM file_artifacts preferred WHERE preferred.capture_id=a.capture_id AND preferred.current=1 AND ((preferred.kind='corrected-dialogue' AND a.kind!='corrected-dialogue') OR (preferred.kind='dialogue' AND a.kind IN ('transcript','text','image-text'))))";
const timestamp=()=>new Date().toISOString();

/** Bounded parts using the configured content write policy. No caller supplies a filesystem path. */
export class FileStore {
  readonly objects:string;
  readonly uploads:string;
  private pending=new Map<string,Promise<unknown>>();
  private readonly closing=new AbortController();
  constructor(readonly store:Store,readonly sources:SourceStore){
    const root=join(store.directory,'files');privateDirectory(root);
    this.objects=join(root,'objects');this.uploads=join(root,'uploads');privateDirectory(this.objects);privateDirectory(this.uploads);
  }
  capabilities(){return {version:1,manifestBatch:100,modes:['archive','reference','index'],partBytes:FILE_PART_BYTES,maxFileBytes:FILE_MAX_BYTES,initialSync:['all','new_only'],deletionPolicy:'retain_central'};}
  async serialize<T>(key:string,action:()=>Promise<T>):Promise<T>{const prior=this.pending.get(key)??Promise.resolve();const next=prior.catch(()=>{}).then(action);this.pending.set(key,next);try{return await next;}finally{if(this.pending.get(key)===next)this.pending.delete(key);}}
  private allowed(input:FileRevision){
    const source=this.sources.getSource(input.sourceId);
    if(source.retention==='reference'&&input.item.layer!=='reference')throw new StoreError('This source accepts references only',409);
    if(!source.enabled)throw new StoreError('Source paused',409);
    if(source.retention!=='archive'&&input.item.layer==='original')throw new StoreError('Source must explicitly select original archive retention',409);
    if(this.store.db.prepare('SELECT 1 FROM file_forgotten WHERE source_id=? AND external_id=?').get(input.sourceId,input.item.externalId))throw new StoreError('File was forgotten; explicitly allow this file before syncing again',410);
    const version=this.store.db.prepare('SELECT capture_id FROM source_versions WHERE source_id=? AND external_id=? AND revision=?').get(input.sourceId,input.item.externalId,input.item.revision) as {capture_id:string}|undefined;
    if(version&&!this.store.evidence([version.capture_id]).length)throw new StoreError('Revision was deleted',410);
  }
  async manifestBatch(raw:unknown,authorize:(sourceId:string)=>void){
    // Predecessor discovery is part of this protocol; retries reuse the persisted immutable manifest.
    const batch=z.object({items:z.array(z.record(z.unknown())).min(1).max(100)}).strict().parse(raw);
    const normalized=batch.items.map(entry=>{
      const sourceId=z.string().parse(entry.sourceId),item=z.object({externalId:z.string(),revision:z.string()}).passthrough().parse(entry.item);
      authorize(sourceId);
      const prior=this.store.db.prepare('SELECT manifest FROM file_versions WHERE source_id=? AND external_id=? AND revision=?').get(sourceId,item.externalId,item.revision);
      const previousRevision=entry.previousRevision===undefined?(prior?JSON.parse(String(prior.manifest)).previousRevision:this.sources.getItem(sourceId,item.externalId)?.revision??null):entry.previousRevision;
      return fileRevisionSchema.parse({...entry,previousRevision});
    });
    // The common metadata path is one durable transaction for the whole batch.
    // Sorted item locks serialize with legacy single-file writers without a lock cycle.
    const keys=normalized.map(input=>'item:'+input.sourceId+':'+input.item.externalId);
    if(normalized.every(input=>input.sourceId===normalized[0].sourceId&&input.item.layer!=='original'&&!input.sha256)&&new Set(keys).size===keys.length){
      const locked=async(index:number):Promise<any>=>index<keys.length?this.serialize([...keys].sort()[index],()=>locked(index+1)):commit();
      const commit=async()=>{
        const fresh=normalized.every(input=>!this.store.db.prepare('SELECT 1 FROM source_versions WHERE source_id=? AND external_id=? AND revision=?').get(input.sourceId,input.item.externalId,input.item.revision));
        if(!fresh)return null;
        const validate=()=>{for(const input of normalized){authorize(input.sourceId);this.allowed(input);if((this.sources.getItem(input.sourceId,input.item.externalId)?.revision??null)!==input.previousRevision)throw new StoreError('Revision predecessor mismatch',409);}};
        try{
          validate();this.store.reserveMetadata(normalized.reduce((n,input)=>n+Buffer.byteLength(JSON.stringify(input))+4096,0));
          const result=await this.sources.upsertBatch(normalized[0].sourceId,normalized.map(input=>input.item),validate,(ack,index)=>this.commitMetadata(normalized[index],ack.id));
          return {results:result.receipts.map(ack=>({externalId:ack.externalId,revision:ack.revision,state:'accepted',ack}))};
        }catch(error){if(error instanceof StoreError)return null;throw error;}
      };
      const committed=await locked(0);if(committed)return committed;
    }
    const results=[];
    for(const input of normalized){
      try{const ack=input.sha256&&!input.item.deleted?this.begin(input,authorize):await this.revision(input,authorize);results.push({externalId:input.item.externalId,revision:input.item.revision,state:'uploadId' in ack?'missing_original':ack.duplicate?'existing':'accepted',...('uploadId' in ack?{upload:ack}:{ack})});}
      catch(error){if(!(error instanceof StoreError))throw error;results.push({externalId:input.item.externalId,revision:input.item.revision,state:'rejected',status:error.statusCode});}
    }
    return {results};
  }
  begin(raw:unknown,authorize:(sourceId:string)=>void){
    const input=fileRevisionSchema.parse(raw);authorize(input.sourceId);this.allowed(input);
    if(!input.sha256||!['original','snapshot'].includes(input.item.layer)||input.item.deleted)throw new StoreError('Upload sessions require an original file');
    const manifest=JSON.stringify(input),fingerprint=sha256(manifest);
    const committed=this.store.db.prepare('SELECT * FROM file_versions WHERE source_id=? AND external_id=? AND revision=?').get(input.sourceId,input.item.externalId,input.item.revision) as Version|undefined;
    if(committed){if(committed.manifest!==manifest)throw new StoreError('Revision content conflicts',409);if(!this.needsSnapshotInput(committed))return {uploadId:committed.capture_id,partBytes:FILE_PART_BYTES,parts:[],ack:{id:committed.capture_id,captureId:committed.capture_id,sourceId:input.sourceId,externalId:input.item.externalId,revision:input.item.revision,objectId:committed.object_hash,sha256:input.sha256,sizeBytes:input.sizeBytes,duplicate:true}};}
    const old=this.store.db.prepare('SELECT * FROM file_uploads WHERE fingerprint=?').get(fingerprint) as Upload|undefined;
    if(old){
      if(old.ack&&committed&&this.needsSnapshotInput(committed)){
        if(Number(this.store.db.prepare('SELECT COUNT(*) AS n FROM file_uploads WHERE ack IS NULL').get()!.n)>=64)throw new StoreError('Too many unfinished file uploads',429);
        this.store.db.prepare('DELETE FROM file_parts WHERE upload_id=?').run(old.id);
        this.store.db.prepare('UPDATE file_uploads SET ack=NULL,created_at=? WHERE id=?').run(timestamp(),old.id);
        rmSync(join(this.uploads,old.id),{recursive:true,force:true});privateDirectory(join(this.uploads,old.id));
      }
      return this.upload(old.id,authorize);
    }
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
    const path=join(this.uploads,id,String(part));
    this.store.contentEncryption.write(path,bytes);this.store.db.prepare('INSERT INTO file_parts VALUES(?,?,?,?)').run(id,part,hash,bytes.length);
    return {part,hash,bytes:bytes.length};
  }
  async close(){this.closing.abort();await Promise.allSettled([...this.pending.values()]);}
  /** Trusted provider intake: retain the original export and publish existing
   * transcript segments atomically, without scheduling ASR or model work here. */
  async transcriptRevision(sourceId:string,item:Omit<SourceItem,'revision'|'text'|'layer'>,rawText:string,rawTranscript:Transcript,authorize:()=>void){return this.serialize('transcript:'+sourceId+':'+item.externalId,async()=>{
    const transcript=transcriptSchema.parse(rawTranscript);
    if(!transcript.segments.length||transcript.coverage!=='full')throw new StoreError('Provider transcript is incomplete',409);
    const bytes=Buffer.from(JSON.stringify({version:1,rawText,transcript}));
    if(bytes.length>16*1024*1024)throw new StoreError('Provider transcript exceeds limit',413);
    const hash=sha256(bytes),head=this.sources.getItem(sourceId,item.externalId);
    const prior=head&&this.store.db.prepare('SELECT manifest,object_hash FROM file_versions WHERE capture_id=?').get(head.captureId);
    if(head&&!head.deleted&&this.store.isCurrentEvidence(head.captureId)&&prior?.object_hash===hash&&head.title===item.title&&head.uri===item.uri&&head.document?.recordedAt===item.document?.recordedAt&&head.document?.timeBasis===item.document?.timeBasis&&head.document?.contentRole===item.document?.contentRole){authorize();return {id:head.captureId,duplicate:true};}
    const revision=sha256(JSON.stringify([hash,item.title,item.uri,item.document,head?.revision??null]));
    const asset=this.store.assets.put(bytes);
    try{return await this.revision({sourceId,relativePath:`recordings/${sha256(item.externalId)}.json`,previousRevision:head?.revision??null,
      item:{...item,revision,text:'',layer:'original',mimeType:'application/json'},sha256:hash,sizeBytes:bytes.length},()=>authorize(),captureId=>{
      const artifactId=randomUUID();
      this.store.db.prepare('INSERT INTO file_artifacts(id,capture_id,kind,created_at,config_revision,json,current) VALUES(?,?,?,?,?,?,1)')
        .run(artifactId,captureId,'transcript',timestamp(),`provider:${transcript.engine??'unknown'}`,JSON.stringify({transcript,complete:true,coverage:'full',providerSupplied:true}));
      writeFileTranscriptChunks(this.store,captureId,artifactId,transcript,{kind:'transcript'});
      this.store.db.prepare("UPDATE file_jobs SET state='succeeded',stage='complete' WHERE capture_id=?").run(captureId);
      return {id:captureId,duplicate:false};
    });}finally{asset.release();}
  });}
  async commit(id:string,authorize:(sourceId:string)=>void,signal?:AbortSignal){return this.serialize('upload:'+id,async()=>{
    const cancellation=AbortSignal.any([this.closing.signal,...(signal?[signal]:[])]);cancellation.throwIfAborted();
    const row=this.session(id,authorize);if(row.ack)return JSON.parse(row.ack);
    const input=JSON.parse(row.manifest) as FileRevision,parts=this.store.db.prepare('SELECT part,hash,bytes FROM file_parts WHERE upload_id=? ORDER BY part').all(id) as {part:number;hash:string;bytes:number}[];
    if(parts.length!==Math.ceil(input.sizeBytes/FILE_PART_BYTES))throw new StoreError('Upload is incomplete',409);
    const hash=input.sha256!;
    const {release}=await this.store.assets.putUpload(join(this.uploads,id),parts,input.sizeBytes,hash,cancellation);
    try{
    this.session(id,authorize);cancellation.throwIfAborted();
    const ack=await this.revision(input,sourceId=>{cancellation.throwIfAborted();authorize(sourceId);},(captureId)=>{
      const value={id:captureId,captureId,sourceId:input.sourceId,externalId:input.item.externalId,revision:input.item.revision,objectId:hash,sha256:hash,sizeBytes:input.sizeBytes,duplicate:false};
      this.store.db.prepare('UPDATE file_uploads SET ack=? WHERE id=?').run(JSON.stringify(value),id);return value;
    });
    this.store.db.prepare('UPDATE file_uploads SET ack=? WHERE id=?').run(JSON.stringify(ack),id);await rm(join(this.uploads,id),{recursive:true,force:true});return ack;
    }finally{release();}
  });}
  async revision(raw:unknown,authorize:(sourceId:string)=>void,onCommit?:(id:string)=>unknown):Promise<any>{
    const input=fileRevisionSchema.parse(raw);return this.serialize('item:'+input.sourceId+':'+input.item.externalId,async()=>{
      authorize(input.sourceId);this.allowed(input);
      const prior=this.store.db.prepare('SELECT * FROM file_versions WHERE source_id=? AND external_id=? AND revision=?').get(input.sourceId,input.item.externalId,input.item.revision) as Version|undefined;
      if(prior){
        if(prior.manifest!==JSON.stringify(input))throw new StoreError('Revision content conflicts',409);
        if(onCommit&&this.needsSnapshotInput(prior)){
          this.store.reserveMetadata(512);const own=!this.store.db.isTransaction;if(own)this.store.db.exec('BEGIN IMMEDIATE');
          try{
            this.store.db.prepare('INSERT INTO file_snapshot_inputs VALUES(?,?,?) ON CONFLICT(capture_id) DO UPDATE SET object_hash=excluded.object_hash,expires=excluded.expires').run(prior.capture_id,input.sha256!,Date.now()+86400000);
            // Resupply never undoes an explicit cancellation. A retry clears that state separately.
            this.store.db.prepare("UPDATE file_jobs SET state='waiting',attempts=0,available_at=0,error=NULL WHERE capture_id=? AND error='snapshot_input_expired' AND state='blocked'").run(prior.capture_id);
            const ack=onCommit(prior.capture_id);if(own)this.store.db.exec('COMMIT');return ack;
          }catch(error){if(own)this.store.db.exec('ROLLBACK');throw error;}
        }
        return {id:prior.capture_id,captureId:prior.capture_id,sourceId:input.sourceId,externalId:input.item.externalId,revision:input.item.revision,objectId:prior.object_hash,sha256:input.sha256,sizeBytes:input.sizeBytes,duplicate:true};
      }
      if(this.store.db.prepare('SELECT 1 FROM source_versions WHERE source_id=? AND external_id=? AND revision=?').get(input.sourceId,input.item.externalId,input.item.revision))throw new StoreError('Revision belongs to a different ingestion protocol',409);
      const head=this.sources.getItem(input.sourceId,input.item.externalId);
      if((head?.revision??null)!==input.previousRevision)throw new StoreError('Revision predecessor mismatch; upload previous revision first',409);
      if(input.sha256&&!onCommit)throw new StoreError('Original bytes require an upload commit');
      this.store.reserveMetadata(Buffer.byteLength(JSON.stringify(input))+4096);
      let ack:unknown;
      await this.sources.upsert(input.sourceId,input.item,()=>{authorize(input.sourceId);this.allowed(input);},({id:captureId})=>{
        this.commitMetadata(input,captureId);
        ack=onCommit?.(captureId)??{id:captureId,captureId,sourceId:input.sourceId,externalId:input.item.externalId,revision:input.item.revision,duplicate:false};
      });return ack;
    });
  }
  /** Owner intake reuses retained bytes and the same file revision transaction as
   * collector uploads. No transcription or semantic attribution happens here. */
  async archivedRevision(file:ArchivedFile,sourceId:string,mimeType:string,observedAt:string,authorize:()=>void,onCommit?:(id:string)=>void){
    const externalId='file:'+file.relativePath,revision=sha256(JSON.stringify([file.hash,mimeType])),head=this.sources.getItem(sourceId,externalId);
    let input:FileRevision={sourceId,relativePath:file.relativePath,previousRevision:head?.revision===revision?null:head?.revision??null,
      item:{externalId,revision,kind:'file',layer:'original',title:file.name,text:'',mimeType,observedAt,deleted:false,
        document:{fileId:file.id,path:file.relativePath,contentRole:'other',timeBasis:'unknown'}},sha256:file.hash,sizeBytes:file.sizeBytes};
    const prior=this.store.db.prepare('SELECT manifest FROM file_versions WHERE source_id=? AND external_id=? AND revision=?').get(sourceId,externalId,revision);
    if(prior)input=JSON.parse(String(prior.manifest));
    const release=this.store.assets.hold(file.hash);
    try{
      if(this.store.assets.get(file.hash).bytes!==file.sizeBytes)throw new StoreError('Archived media byte size changed',409);
      return await this.revision(input,authorize,id=>{onCommit?.(id);return {id,captureId:id,sourceId,externalId,revision,duplicate:false};});
    }finally{release();}
  }
  private commitMetadata(input:FileRevision,captureId:string){
        const previousFile=this.store.db.prepare('SELECT capture_id FROM file_heads WHERE source_id=? AND external_id=?').get(input.sourceId,input.item.externalId) as {capture_id:string}|undefined;
        if(!input.item.deleted&&previousFile&&previousFile.capture_id!==captureId)this.store.invalidateMemoryEvidence(previousFile.capture_id);
        const hash=input.item.deleted||input.item.layer!=='original'?null:input.sha256??null;
        if(hash)this.store.db.prepare('INSERT OR IGNORE INTO file_objects VALUES(?,?,?)').run(hash,input.sizeBytes,Math.ceil(input.sizeBytes/FILE_PART_BYTES));
        this.store.db.prepare('INSERT INTO file_versions VALUES(?,?,?,?,?,?)').run(captureId,input.sourceId,input.item.externalId,input.item.revision,JSON.stringify(input),hash);
        // File predecessors establish order even when a device clock moves backwards.
        this.store.db.prepare('UPDATE source_heads SET capture_id=?,observed_at=?,deleted=? WHERE source_id=? AND external_id=?').run(captureId,input.item.observedAt,Number(input.item.deleted),input.sourceId,input.item.externalId);
        if(input.item.deleted)this.store.db.prepare('UPDATE file_heads SET origin_missing=1 WHERE source_id=? AND external_id=?').run(input.sourceId,input.item.externalId);
        else this.store.db.prepare('INSERT INTO file_heads VALUES(?,?,?,0) ON CONFLICT(source_id,external_id) DO UPDATE SET capture_id=excluded.capture_id,origin_missing=0').run(input.sourceId,input.item.externalId,captureId);
        if(input.sha256&&!input.item.deleted&&input.item.layer==='snapshot')this.store.db.prepare('INSERT INTO file_snapshot_inputs VALUES(?,?,?)').run(captureId,input.sha256,Date.now()+86400000);
        if(input.sha256&&!input.item.deleted)this.store.db.prepare('INSERT INTO file_jobs(capture_id) VALUES(?)').run(captureId);
  }
  private needsSnapshotInput(v:Version){
    const input=JSON.parse(v.manifest) as FileRevision;
    if(input.item.layer!=='snapshot'||!input.sha256||this.sources.getItem(v.source_id,v.external_id)?.revision!==v.revision)return false;
    const job=this.store.db.prepare('SELECT state,error,config_revision FROM file_jobs WHERE capture_id=?').get(v.capture_id);
    if(!job||['succeeded','cancelled'].includes(String(job.state)))return false;
    if(this.store.db.prepare('SELECT 1 FROM file_snapshot_inputs WHERE capture_id=? AND expires>?').get(v.capture_id,Date.now()))return false;
    if(job.state==='blocked'&&job.error==='snapshot_input_expired')return true;
    // A crash after extraction publication can finish the pipeline using its durable artifact.
    return !this.store.db.prepare("SELECT 1 FROM file_steps s JOIN file_artifacts a ON a.id=s.artifact_id WHERE s.capture_id=? AND s.step='extract' AND s.state='succeeded' AND a.config_revision=? AND json_extract(a.json,'$.snapshot')=1").get(v.capture_id,job.config_revision);
  }
  /** Deterministic transport requests only; clients reapply their current source/privacy grants. */
  snapshotRecovery(sourceId:string){
    const source=this.sources.getSource(sourceId);if(!source.enabled||source.retention!=='snapshot')return {items:[]};
    const rows=this.store.db.prepare("SELECT v.* FROM file_versions v JOIN file_heads h ON h.capture_id=v.capture_id JOIN file_jobs j ON j.capture_id=v.capture_id WHERE v.source_id=? AND h.origin_missing=0 AND json_extract(v.manifest,'$.item.layer')='snapshot' AND json_extract(v.manifest,'$.sha256') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM file_snapshot_inputs i WHERE i.capture_id=v.capture_id AND i.expires>?) AND (j.state='waiting' OR j.state='blocked' AND j.error='snapshot_input_expired') ORDER BY v.rowid LIMIT 200").all(sourceId,Date.now()) as Version[];
    return {items:rows.filter(v=>this.needsSnapshotInput(v)).map(v=>{const m=JSON.parse(v.manifest) as FileRevision;return {captureId:v.capture_id,externalId:v.external_id,revision:v.revision,sha256:m.sha256!,sizeBytes:m.sizeBytes,observedAt:m.item.observedAt};})};
  }
  beginSnapshotRecovery(id:string,authorize:(sourceId:string)=>void){
    const v=this.version(id);authorize(v.source_id);const manifest=JSON.parse(v.manifest) as FileRevision;this.allowed(manifest);
    const source=this.sources.getSource(v.source_id);
    if(source.retention!=='snapshot'||manifest.item.layer!=='snapshot'||!manifest.sha256||this.sources.getItem(v.source_id,v.external_id)?.revision!==v.revision)throw new StoreError('Snapshot input recovery is not current or authorized',409);
    return this.begin(manifest,authorize);
  }
  version(id:string){const v=this.store.db.prepare('SELECT * FROM file_versions WHERE capture_id=?').get(id) as Version|undefined;if(!v)throw new StoreError('File not found',404);return v;}
  detail(id:string,includeArtifacts=true){
    const v=this.version(id),db=this.store.db,head=db.prepare('SELECT origin_missing FROM file_heads WHERE capture_id=?').get(id) as {origin_missing:number}|undefined;
    const artifacts=includeArtifacts?(db.prepare('SELECT id,kind,created_at,json FROM file_artifacts WHERE capture_id=? AND current=1 ORDER BY created_at').all(id) as {id:string;kind:string;created_at:string;json:string}[]).map(a=>{
      const {transcript,segments,output,...data}=JSON.parse(a.json);return {id:a.id,kind:a.kind,createdAt:a.created_at,...data,...(output?{output:{type:output.type}}:{}),...(transcript?{durationMs:transcript.durationMs,segments:transcript.segments.length,warnings:transcript.warnings}:segments?{segments:Array.isArray(segments)?segments.length:segments}:{})};
    }):[];
    const rawJob=db.prepare('SELECT state,stage,attempts,error,summary_state,local_only,available_at AS availableAt,config_revision AS inputVersion FROM file_jobs WHERE capture_id=?').get(id) as ({state:string;stage:string;attempts:number;error:string|null;summary_state:string;local_only:number;availableAt:number;inputVersion:string|null}|undefined);
    const rawSteps=includeArtifacts?db.prepare('SELECT step,processor,version,state,attempts,error,updated_at AS updatedAt FROM file_steps WHERE capture_id=? ORDER BY rowid').all(id) as {step:string;processor:string;version:string;state:string;attempts:number;error:string|null;updatedAt:string}[]:[];
    const job=rawJob?{...rawJob,execution:executionEnvelope({state:rawJob.state,attempts:rawJob.attempts,errorCode:rawJob.error??undefined,availableAt:rawJob.availableAt,inputVersion:rawJob.inputVersion??undefined})}:null;
    const steps=rawSteps.map(step=>({...step,execution:executionEnvelope({state:step.state,attempts:step.attempts,errorCode:step.error??undefined,definitionVersion:step.version,updatedAt:step.updatedAt})}));
    const manifest=JSON.parse(v.manifest),index=this.store.evidence([id])[0]?.provenance?.document?.fileIndex;if(index&&manifest.item.layer==='snapshot')manifest.item.document={...manifest.item.document,fileIndex:index};
    return {captureId:id,...manifest,hasOriginal:!!v.object_hash,originMissing:!!head?.origin_missing,job,artifacts,steps};
  }
  saveAsset(artifactId:string,name:string,mime:string,bytes:Buffer){
    if(!/^speaker_samples\/SPEAKER_[0-9]{1,2}\.wav$/.test(name)||bytes.length>768*1024)throw new StoreError('Invalid artifact asset');
    this.store.reserveMetadata(bytes.length+1024);const asset=this.store.assets.put(bytes),hash=asset.hash;
    try{
    this.store.db.prepare('INSERT OR IGNORE INTO file_objects VALUES(?,?,?)').run(hash,bytes.length,1);
    this.store.db.prepare('INSERT INTO file_assets VALUES(?,?,?,?)').run(artifactId,name,mime,hash);
    }finally{asset.release();}
  }
  asset(captureId:string,artifactId:string,name:string){
    this.version(captureId);const row=this.store.db.prepare('SELECT f.object_hash,f.mime FROM file_assets f JOIN file_artifacts a ON a.id=f.artifact_id WHERE a.capture_id=? AND a.id=? AND f.name=?').get(captureId,artifactId,name) as {object_hash:string;mime:string}|undefined;
    if(!row||!/^[a-f0-9]{64}$/.test(row.object_hash))throw new StoreError('Asset not found',404);
    return {mime:row.mime,bytes:this.store.assets.read(row.object_hash)};
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
  *bytes(id:string,start=0,end?:number):Generator<Buffer>{const v=this.version(id);if(!v.object_hash)throw new StoreError('Original is not archived',404);
    for(const bytes of this.store.assets.bytes(v.object_hash,start,end)){this.version(id);yield bytes;}
  }
  /** Host-only temporary input; query original tools continue to use bytes(). */
  *processingBytes(id:string){const v=this.version(id);if(v.object_hash){yield* this.bytes(id);return;}const input=this.store.db.prepare('SELECT object_hash,expires FROM file_snapshot_inputs WHERE capture_id=?').get(id);if(!input||Number(input.expires)<=Date.now())throw new StoreError('Snapshot processing input expired',410);for(const bytes of this.store.assets.bytes(String(input.object_hash))){if((!this.sources.getSource(v.source_id).enabled||this.sources.getSource(v.source_id).retention==='reference')||this.sources.getItem(v.source_id,v.external_id)?.revision!==v.revision)throw new StoreError('Snapshot source or version changed',409);yield bytes;}}
  releaseSnapshotInput(id:string){if(this.store.db.prepare('DELETE FROM file_snapshot_inputs WHERE capture_id=?').run(id).changes)this.store.assets.sweep();}
  publishSnapshotIndex(id:string,total:number,length:number,parser:string,partial=false,warnings:string[]=[]){const capture=this.store.evidence([id])[0];if(!capture?.provenance?.document?.fileIndex)return;const index={...capture.provenance.document.fileIndex,status:'ready',parser,totalCharacters:total,length,coverage:total>length||partial?'lightweight':total?'full':'none',...(warnings.length?{warnings}:{} )};this.store.db.prepare("UPDATE captures SET json=json_set(json,'$.provenance.document.fileIndex',json(?)) WHERE id=?").run(JSON.stringify(index),id);}
  saveSnapshotText(id:string,text:string){const index=JSON.parse(this.version(id).manifest).item.document?.fileIndex;if(!index?.allowRead)return;const asset=this.store.assets.put(Buffer.from(text));try{this.store.db.prepare('INSERT OR REPLACE INTO file_snapshot_text VALUES(?,?)').run(id,asset.hash);}finally{asset.release();}}
  stream(id:string,start=0,end?:number){return Readable.from(this.bytes(id,start,end));}
  chunks(id:string,offset=0,limit=100){this.version(id);return (this.store.db.prepare(`SELECT c.* FROM file_chunks c JOIN file_artifacts a ON a.id=c.artifact_id WHERE c.capture_id=? AND ${activeChunks} ORDER BY c.start_ms,c.ordinal,c.rowid LIMIT ? OFFSET ?`).all(id,Math.min(limit,200),offset) as Chunk[]).map(c=>this.chunkRecord(c));}
  speakerAttributions(captureId:string,artifactId:string){
    return readFileSpeakerAttributions(this.store,captureId,artifactId);
  }
  private chunkRecord(c:Chunk):CaptureRecord & ContextRecord{
    const record=this.store.evidence([c.capture_id])[0],v=this.version(c.capture_id),metadata=JSON.parse(c.metadata??'{}'),attribution=metadata.speaker?this.speakerAttributions(c.capture_id,c.artifact_id)[metadata.speaker]:undefined;
    return {...record,id:c.id,capturedAt:record.capturedAt,deviceId:record.deviceId,appName:record.appName,windowTitle:record.windowTitle,sourceType:'file',ocrText:(metadata.speaker?`[${metadata.speaker}] `:'')+c.text,durationMs:0,provenance:{...record.provenance!,layer:'derived'},fileEvidence:fileEvidenceSchema.parse({captureId:c.capture_id,revision:v.revision,artifactId:c.artifact_id,chunkId:c.id,...metadata,...(attribution?{speakerAttribution:attribution}:{}),...(c.start_ms===null?{}:{startMs:c.start_ms,endMs:c.end_ms})})};
  }
  /** Only the preferred transcript/text of the retained current file revision is independent evidence. */
  isCurrentEvidence(id:string):boolean {
    if(!fileAttachmentAvailable(this.store,id))return false;
    return Boolean(this.store.db.prepare(`SELECT c.id FROM file_chunks c JOIN file_artifacts a ON a.id=c.artifact_id JOIN file_heads h ON h.capture_id=c.capture_id JOIN file_versions v ON v.capture_id=c.capture_id WHERE c.id=? AND ${activeChunks} AND a.kind IN ('text','image-text','transcript','dialogue','corrected-dialogue')`).get(id));
  }
  evidence(ids:string[]){return ids.flatMap(id=>{const c=this.store.db.prepare('SELECT c.* FROM file_chunks c JOIN file_artifacts a ON a.id=c.artifact_id WHERE c.id=? AND a.current=1').get(id) as Chunk|undefined;return c?[this.chunkRecord(c)]:[];});}
  search(args:ContextRange&{query?:string}){return this.searchPage(args).items;}
  searchPage(args:ContextRange&{query?:string;sourceId?:string;projectKey?:string;repositoryKey?:string;provider?:string;sessionId?:string}){
    const empty={items:[] as (CaptureRecord & ContextRecord)[],nextCursor:null as string|null};
    if(args.source&&args.source!=='file'||args.collection==='activity'||!args.query?.trim())return empty;
    const clauses=['h.capture_id=c.capture_id','a.id=c.artifact_id',activeChunks,'r.id=c.capture_id'],values:(string|number)[]=[];
    for(const [key,column] of [['appId',"json_extract(r.json,'$.appId')"],['deviceId','r.device_id'],['after','r.context_at'],['before','r.context_at'],['sourceId',"json_extract(r.json,'$.provenance.sourceId')"],['projectKey',"json_extract(r.json,'$.provenance.document.coding.projectKey')"],['repositoryKey',"json_extract(r.json,'$.provenance.document.coding.repositoryKey')"],['provider',"json_extract(r.json,'$.provenance.document.coding.provider')"],['sessionId',"json_extract(r.json,'$.provenance.document.coding.sessionId')"]] as const)if(args[key]){clauses.push(`${column} ${key==='after'?'>=':key==='before'?'<':'='} ?`);values.push(args[key]!);}
    if(args.cursor){let p:{t:string;id:string};try{p=z.object({t:z.string().datetime(),id:z.string().uuid()}).strict().parse(JSON.parse(Buffer.from(args.cursor,'base64url').toString()));}catch{throw new StoreError('Invalid file search cursor');}clauses.push('(r.context_at<? OR (r.context_at=? AND c.id<?))');values.push(p.t,p.t,p.id);}
    const lexical=textSearch(args.query!,{id:'c.id',text:'c.text',words:'file_chunks_fts',trigrams:'file_chunks_trigram'}),limit=Math.max(1,Math.min(args.limit??30,200));
    const rows=this.store.db.prepare(`SELECT c.*,r.context_at AS context_at FROM file_chunks c,file_artifacts a,file_heads h,captures r WHERE ${clauses.join(' AND ')} AND ${lexical.sql} ORDER BY r.context_at DESC,c.id DESC LIMIT ?`).all(...values,...lexical.values,limit+1) as (Chunk & {context_at:string})[];
    const selected=rows.slice(0,limit),last=selected.at(-1);
    return {items:selected.map(c=>this.chunkRecord(c)),nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({t:last.context_at,id:last.id})).toString('base64url'):null};
  }
  pendingIndex(model:string,allowLocalOnly=false){return this.store.db.prepare(`SELECT c.id,c.text FROM file_chunks c JOIN file_artifacts a ON a.id=c.artifact_id JOIN file_jobs j ON j.capture_id=c.capture_id WHERE ${activeChunks} AND (?=1 OR j.local_only=0) AND c.index_error IS NULL AND (c.embedding IS NULL OR c.embedding_model!=?) ORDER BY c.rowid LIMIT 8`).all(Number(allowLocalOnly),model) as {id:string;text:string}[];}
  indexed(id:string,vector:number[],model:string){const json=JSON.stringify(vector);this.store.reserveMetadata(Buffer.byteLength(json));this.store.db.prepare('UPDATE file_chunks SET embedding=?,embedding_model=?,index_error=NULL WHERE id=? AND artifact_id IN (SELECT id FROM file_artifacts WHERE current=1)').run(json,model,id);}
  indexFailed(id:string){this.store.db.prepare("UPDATE file_chunks SET index_error='provider_failed' WHERE id=?").run(id);}
  vectorQuery(model:string,args:Range){
    if(args.source&&args.source!=='file'||args.collection==='activity')return;
    const clauses=['h.capture_id=c.capture_id','a.id=c.artifact_id',activeChunks,'r.id=c.capture_id','c.embedding_model=?','c.embedding IS NOT NULL'],values:(string|number)[]=[model];
    for(const [key,column] of [['appId',"json_extract(r.json,'$.appId')"],['deviceId','r.device_id'],['after','r.context_end'],['before','r.context_at'],['sourceId',"json_extract(r.json,'$.provenance.sourceId')"],['projectKey',"json_extract(r.json,'$.provenance.document.coding.projectKey')"],['repositoryKey',"json_extract(r.json,'$.provenance.document.coding.repositoryKey')"],['provider',"json_extract(r.json,'$.provenance.document.coding.provider')"],['sessionId',"json_extract(r.json,'$.provenance.document.coding.sessionId')"]] as const)if(args[key]){clauses.push(`${column} ${key==='after'?'>=':key==='before'?'<':'='} ?`);values.push(key==='after'||key==='before'?new Date(args[key]!).toISOString():args[key]!);}
    return {sql:`SELECT c.id,c.embedding FROM file_chunks c,file_artifacts a,file_heads h,captures r WHERE ${clauses.join(' AND ')}`,values};
  }

  forget(id:string){const v=this.version(id);this.store.db.prepare('INSERT OR IGNORE INTO file_forgotten VALUES(?,?)').run(v.source_id,v.external_id);const ids=this.store.db.prepare('SELECT capture_id FROM file_versions WHERE source_id=? AND external_id=?').all(v.source_id,v.external_id) as {capture_id:string}[];for(const r of ids)this.store.delete(r.capture_id);this.sweep();return {deleted:ids.length};}
  sweepSnapshotInputs(){
    const db=this.store.db;
    const stale=`capture_id NOT IN (SELECT h.capture_id FROM file_heads h JOIN source_connections s ON s.id=h.source_id WHERE json_extract(s.json,'$.enabled')=1 AND json_extract(s.json,'$.retention')!='reference' AND h.origin_missing=0)`;
    const removed=db.prepare(`DELETE FROM file_snapshot_inputs WHERE expires<=? OR ${stale}`).run(Date.now()).changes;
    const retired=db.prepare(`DELETE FROM file_snapshot_text WHERE ${stale}`).run().changes;if(removed||retired)this.store.assets.sweep();
  }
  sweep(){this.sweepSnapshotInputs();

    for(const u of this.store.db.prepare('SELECT id FROM file_uploads WHERE ack IS NOT NULL OR created_at<?').all(new Date(Date.now()-7*86400000).toISOString()) as {id:string}[]){rmSync(join(this.uploads,u.id),{recursive:true,force:true});this.store.db.prepare('DELETE FROM file_uploads WHERE id=?').run(u.id);}
    this.store.db.exec('DELETE FROM file_objects WHERE hash NOT IN (SELECT object_hash FROM file_versions WHERE object_hash IS NOT NULL UNION SELECT object_hash FROM file_assets)');
    this.store.assets.sweep();
  }
}
