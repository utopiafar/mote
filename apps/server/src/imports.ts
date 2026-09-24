import { moteText } from './i18n.js';
import {randomUUID} from 'node:crypto';
import {readdir,lstat} from 'node:fs/promises';
import {constants,closeSync,createReadStream,createWriteStream,existsSync,fstatSync,lstatSync,openSync,readSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {formatWork} from './format-work.js';
import {createInterface} from 'node:readline';
import {importRecordSchema,type PreparedRecord} from './import-record.js';
export {importRecordSchema} from './import-record.js';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {z} from 'zod';
import {importRequestSchema,importReviewDecisionSchema,sourceItemSchema,type ArchivedFile,type ImportDispositions,type ImportJob,type ImportRequest,type ImportReviewDecision,type ImportReviewGate,type SourceItem} from '@mote/shared';
import {ArchivedFileStore,MAX_FILE_BYTES,archiveRelativePath} from './archived-files.js';
import {privateDirectory,privateFile} from './private-storage.js';
import {SourceStore} from './sources.js';
import {Store,StoreError,sha256} from './store.js';
import {ExecutionEngine,ExecutionFailure,type ExecutionGrant,type ExecutionStep} from './execution-engine.js';
import {executionEnvelope} from '@mote/shared/execution';
import {linkOperationParent} from './operation-projection.js';

const MAX_INPUT_BYTES=256*1024*1024,MAX_EXPANDED_BYTES=512*1024*1024,MAX_FILES=4000;
export type ImportPreparation={operationId?:string;signal?:AbortSignal;workspace:string;inputPaths:string[];instruction:string;previous?:{summary:string;error?:string}};
export type ImportPreparationResult={summary:string;recordsPath?:string;warnings?:string[];reviewDecision?:ImportReviewDecision};
export type ImportRuntime={executor?:ExecutionEngine;prepare?:(input:ImportPreparation)=>Promise<ImportPreparationResult>;sourcePacks?:ReadonlyMap<string,{revision:string;prepare:(input:ImportPreparation)=>Promise<ImportPreparationResult>}>;onImported?:(captureIds:string[],importJobId:string)=>Promise<{memoryJobId?:string}>};
type InternalJob=ImportJob&{processing?:'automatic'|'preview';sourcePackRevision?:string;archiveWarnings?:string[];createFingerprint?:string;preparationRevision?:number;originalsPending?:boolean;expansion?:{originalIds:string[];completedIds:string[]};parserMode?:'plain';workspace:string;inputs:{path:string;fileId:string}[];manifestHash?:string;failurePhase?:'prepare'|'import';memoryNotified?:boolean;blockedArchive?:boolean};
const responseSchema=z.object({summary:z.string().max(20000),recordsPath:z.string().max(4000).optional(),warnings:z.array(z.string().max(2000)).max(200).optional(),reviewDecision:importReviewDecisionSchema.optional()}).strict();
const message=(error:unknown)=>error instanceof Error?error.message.slice(0,2000):'Import failed';
const inside=(root:string,path:string)=>{const rel=relative(root,path);return rel===''||(!rel.startsWith(`..${sep}`)&&rel!=='..'&&!isAbsolute(rel));};
function reviewGate(job:InternalJob,decision:ImportReviewDecision|undefined,informationalWarnings=false):ImportReviewGate {
  if((job.processing??'preview')!=='automatic')return {decision:'confirmation',reason:'This import was requested for manual preview.'};
  if(!decision)return {decision:'confirmation',reason:'The parser did not provide a confidence and ambiguity assessment.'};
  if(decision.confidence!=='high'||decision.ambiguous)return {decision:'confirmation',reason:decision.reason??'The parser reported low confidence or ambiguity.'};
  if(!decision.reason)return {decision:'confirmation',reason:'The parser did not explain its high-confidence assessment.'};
  if(job.warnings.length&&!informationalWarnings)return {decision:'confirmation',reason:'Processing reported warnings; review the preview before publishing.'};
  if(!job.dispositions||job.dispositions.items.length!==job.files.length)return {decision:'confirmation',reason:'The parser did not account for every original file.'};
  if(job.dispositions.counts.unsupported||job.dispositions.counts.excluded||!job.dispositions.counts.parsed)return {decision:'confirmation',reason:'Some originals were not parsed as evidence.'};
  return {decision:'automatic',reason:'The parsed records passed host validation with high confidence and no ambiguity.'};
}

/** Deterministic formats decode locally; models map unfamiliar structures into reviewed records. */
export class ImportStore {
  private running=new Set<string>();
  private creating=new Map<string,{fingerprint:string;promise:Promise<ImportJob>}>();
  private executor:ExecutionEngine;
  private phaseWaiters=new Map<string,Set<()=>void>>();
  private isScheduled(id:string){return Boolean(this.store.db.prepare("SELECT 1 FROM execution_steps WHERE kind IN ('imports.prepare','imports.commit') AND json_extract(input,'$.jobId')=? AND state IN ('waiting','running') LIMIT 1").get(id));}
  readonly directory:string;
  constructor(public store:Store,public files:ArchivedFileStore,public sources:SourceStore,private runtime:ImportRuntime={}) {
    const directory=join(store.directory,'imports');privateDirectory(directory);this.directory=realpathSync(directory);
    store.db.exec('CREATE TABLE IF NOT EXISTS import_jobs(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,json TEXT NOT NULL)');
    store.db.exec('CREATE TABLE IF NOT EXISTS import_create_requests(request_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,job_id TEXT NOT NULL)');
    this.executor=runtime.executor??new ExecutionEngine(store);
    for(const phase of ['prepare','commit'] as const)this.executor.register({kind:`imports.${phase}`,pool:'imports',concurrency:()=>1,maxAttempts:1,timeoutMs:2147483647,validate:step=>{
      const row=store.db.prepare('SELECT json FROM import_jobs WHERE id=?').get(String(step.input.jobId)) as {json:string}|undefined;
      return Boolean(row&&step.input.phase===phase&&step.id===this.phaseId(JSON.parse(row.json) as InternalJob,phase));
    },execute:async(step,signal,grant)=>{
      const result=await (phase==='prepare'?this.prepareNow(String(step.input.jobId),grant,signal):this.confirmNow(String(step.input.jobId),grant,signal));
      if(['failed','unsupported','needs_configuration'].includes(result.status))throw new ExecutionFailure(result.status==='needs_configuration'?'blocked':'permanent',result.status==='needs_configuration'?'model_unconfigured':result.status==='unsupported'?'unsupported_format':'import_failed');return result;
    },commit:(_step,result)=>{const job=this.load((result as ImportJob).id);if(phase==='prepare'&&job.status==='awaiting_confirmation')this.admitPhase(job,'commit','blocked','awaiting_confirmation');},project:step=>this.projectPhase(step),classify:()=>new ExecutionFailure('permanent','import_failed')});
    // Paths are derived from this vault, never from a backed-up absolute workspace.
    for(const row of store.db.prepare('SELECT id,json FROM import_jobs').all() as {id:string;json:string}[]){
      const job=JSON.parse(row.json) as InternalJob;
      if(!z.string().uuid().safeParse(row.id).success||job.id!==row.id)throw new StoreError('Invalid import job identity in the database',500);
      const workspace=join(this.directory,row.id),relocated=job.workspace!==workspace;job.workspace=workspace;
      // A second reader/host must not revoke a live engine lease in the same vault.
      if(!relocated&&store.db.prepare("SELECT 1 FROM execution_steps WHERE kind IN ('imports.prepare','imports.commit') AND json_extract(input,'$.jobId')=? AND state='running' AND lease_until>? LIMIT 1").get(job.id,Date.now()))continue;
      let missingOriginals=false;
      try{job.inputs=job.files.map(file=>{const original=files.get(file.id);return {fileId:original.id,path:join(workspace,'inputs',archiveRelativePath(original.relativePath))};});}
      catch{missingOriginals=true;job.inputs=[];job.blockedArchive=true;const warning='Some archived originals are missing from this restored vault. Upload the original files again to analyze them.';if(!job.warnings.includes(warning))job.warnings=[...job.warnings,warning].slice(-200);}
      const missingPreview=(job.status==='awaiting_confirmation'||job.status==='importing'||job.failurePhase==='import')&&!existsSync(join(workspace,'prepared.jsonl'));
      if(job.status!=='completed'&&(relocated||missingPreview)){
        // The saved workspace/preview is intentionally absent from a backup.
        // Retire its runnable phases before admitting a new reviewed generation.
        store.db.prepare("UPDATE execution_steps SET state='stale',error='restored_preview_required',fence=NULL,lease_until=0,updated_at=? WHERE kind IN ('imports.prepare','imports.commit') AND json_extract(input,'$.jobId')=? AND state IN ('waiting','running','blocked')").run(Date.now(),job.id);
        job.preparationRevision=(job.preparationRevision??0)+1;job.status=job.blockedArchive?'failed':'queued';job.processingStatus=job.blockedArchive?'blocked':'archived';job.failurePhase='prepare';job.preview=undefined;job.dispositions=undefined;job.reviewDecision=undefined;job.reviewGate=undefined;job.manifestHash=undefined;
        job.progress={total:0,processed:0,imported:0,duplicates:0};
        if(missingOriginals)job.error='This backup is missing original files. Upload them again to continue.';
        else if(!job.blockedArchive)job.error='Restored backup: original files are retained. Analyze this import again and review a new preview before continuing.';
      }else if(job.status==='preparing'||job.status==='importing'){
        job.failurePhase=job.status==='importing'?'import':'prepare';job.status='failed';job.processingStatus='blocked';job.error='The server stopped during processing. Retry to resume.';
      }
      if(job.originalsPending){job.status='failed';job.processingStatus='blocked';job.blockedArchive=true;job.error='The server stopped before all originals were archived. Retained originals are safe; upload the complete input again.';}
      if(JSON.stringify(job)!==row.json)this.save(job);
      this.restoreOperation(job);
    }
  }
  private load(id:string):InternalJob{const row=this.store.db.prepare('SELECT json FROM import_jobs WHERE id=?').get(id) as {json:string}|undefined;if(!row)throw new StoreError('Import job not found',404);return JSON.parse(row.json);}
  private public(job:InternalJob):ImportJob{job.operationId=`import:${job.id}`;const operation=this.store.db.prepare('SELECT state FROM operation_progress WHERE id=? AND total>0').get(job.operationId);if(operation)job.execution=executionEnvelope({status:operation.state==='waiting'?'queued':operation.state,attempts:job.execution?.attempts??0,errorCode:job.status==='awaiting_confirmation'?'awaiting_confirmation':job.execution?.failure?.code});const {processing,sourcePackRevision,archiveWarnings,createFingerprint,preparationRevision,originalsPending,expansion,parserMode,workspace,inputs,manifestHash,failurePhase,memoryNotified,blockedArchive,...value}=job;return value;}
  private save(job:InternalJob){job.updatedAt=new Date().toISOString();const json=JSON.stringify(job),old=this.store.db.prepare('SELECT length(CAST(json AS BLOB)) AS bytes FROM import_jobs WHERE id=?').get(job.id) as {bytes:number}|undefined;this.store.reserveMetadata(Math.max(0,Buffer.byteLength(json)-(old?.bytes??0)));this.store.db.prepare('INSERT INTO import_jobs(id,created_at,updated_at,json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,json=excluded.json').run(job.id,job.createdAt,job.updatedAt,json);if(job.createFingerprint)this.store.db.prepare('INSERT OR IGNORE INTO import_create_requests(request_id,fingerprint,job_id) VALUES(?,?,?)').run(job.id,job.createFingerprint,job.id);}
  get(id:string):ImportJob{return this.public(this.load(id));}
  list():ImportJob[]{return (this.store.db.prepare('SELECT json FROM import_jobs ORDER BY created_at DESC LIMIT 100').all() as {json:string}[]).map(r=>this.public(JSON.parse(r.json)));}
  private createdRequest(requestId:string,fingerprint:string):ImportJob|undefined {
    const receipt=this.store.db.prepare('SELECT fingerprint,job_id FROM import_create_requests WHERE request_id=?').get(requestId) as {fingerprint:string;job_id:string}|undefined;
    const row=this.store.db.prepare('SELECT json FROM import_jobs WHERE id=?').get(receipt?.job_id??requestId) as {json:string}|undefined;
    const job=row?JSON.parse(row.json) as InternalJob:undefined;
    if((receipt||job)&&(receipt?.fingerprint??job?.createFingerprint)!==fingerprint)throw new StoreError('Import request ID already belongs to a different request',409);
    if(receipt&&!job)throw new StoreError('This import request was deleted; start a new import',410);
    return job?this.public(job):undefined;
  }
  async create(raw:unknown):Promise<ImportJob> {
    const request=importRequestSchema.parse(raw);
    if(!request.requestId)return this.createRequest(request);
    const fingerprint=sha256(JSON.stringify(request)),pending=this.creating.get(request.requestId);
    if(pending){if(pending.fingerprint!==fingerprint)throw new StoreError('Import request ID already belongs to a different request',409);return pending.promise;}
    const existing=this.createdRequest(request.requestId,fingerprint);if(existing)return existing;
    const promise=this.createRequest(request,fingerprint);this.creating.set(request.requestId,{fingerprint,promise});
    try{return await promise;}finally{if(this.creating.get(request.requestId)?.promise===promise)this.creating.delete(request.requestId);}
  }
  private async createRequest(request:ImportRequest,createFingerprint?:string):Promise<ImportJob> {
    const configuredPack=request.sourcePackId?this.runtime.sourcePacks?.get(request.sourcePackId):undefined;
    if(request.sourcePackId&&!configuredPack)throw new StoreError('Requested Python Source Pack is not installed on this node',409);
    if(request.sourcePackId&&request.instruction.trim())throw new StoreError('Python Source Packs use fixed parser code; use model analysis for freeform import instructions',409);
    if(Number((this.store.db.prepare('SELECT COUNT(*) AS n FROM import_jobs').get() as {n:number}).n)>=1000)throw new StoreError('Import job limit reached',413);
    const entries:{name:string;mimeType?:string;bytes?:Buffer;fileId?:string;path?:string;sizeBytes?:number;identity?:string}[]=[];let total=0;
    const add=(name:string,bytes:Buffer,mimeType?:string)=>{archiveRelativePath(name);total+=bytes.length;if(bytes.length>MAX_FILE_BYTES||total>MAX_INPUT_BYTES||entries.length>=MAX_FILES)throw new StoreError('Import exceeds file count or size limits (64 MiB per file, 256 MiB total)',413);entries.push({name,bytes,mimeType});};
    if(request.archivedFileIds){
      for(const id of request.archivedFileIds){const file=this.files.get(id);total+=file.sizeBytes;if(total>MAX_INPUT_BYTES)throw new StoreError('Import exceeds 256 MiB',413);entries.push({name:file.relativePath,mimeType:file.mimeType,fileId:id});}
    }else if(request.files){
      for(const file of request.files){if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.dataBase64))throw new StoreError('Invalid file base64');add(file.name,Buffer.from(file.dataBase64,'base64'),file.mimeType);}
    }else{
      const source=realpathSync(resolve(request.directory!)),vault=realpathSync(this.store.directory);
      if(inside(source,vault)||inside(vault,source))throw new StoreError('Choose a directory outside the Mote data directory');
      if(!lstatSync(source).isDirectory())throw new StoreError('Import path must be a directory');
      const walk=async(directory:string,depth:number):Promise<void>=>{if(depth>30)throw new StoreError('Directory nesting exceeds 30 levels',413);for(const name of (await readdir(directory)).sort()){
        const path=join(directory,name),info=await lstat(path,{bigint:true});if(info.isSymbolicLink())throw new StoreError('Directory imports cannot follow symbolic links');
        if(info.isDirectory())await walk(path,depth+1);else if(info.isFile()){
          const size=Number(info.size);if(size>MAX_FILE_BYTES||total+size>MAX_INPUT_BYTES||entries.length>=MAX_FILES)throw new StoreError('Directory exceeds import size limits',413);
          const name=archiveRelativePath(relative(source,path).split(sep).join('/'));entries.push({name,path,sizeBytes:size,identity:fileIdentity(info)});total+=size;
        }
      }};await walk(source,0);
    }
    if(!entries.length)throw new StoreError('No files were supplied');
    if(new Set(entries.map(e=>e.name)).size!==entries.length)throw new StoreError('File paths must be unique within an import');
    // Directory enumeration yields; another host may have accepted this request meanwhile.
    if(request.requestId){const existing=this.createdRequest(request.requestId,createFingerprint!);if(existing)return existing;}
    const now=new Date().toISOString(),id=request.requestId??randomUUID(),workspace=join(this.directory,id);privateDirectory(workspace);privateDirectory(join(workspace,'inputs'));
    const job:InternalJob={...(createFingerprint?{createFingerprint}:{}),...(request.sourcePackId?{sourcePackId:request.sourcePackId,sourcePackRevision:configuredPack!.revision}:{}),...(request.processing==='automatic'&&!request.sourcePackId&&!request.instruction.trim()&&entries.every(entry=>/\.(txt|md|markdown|csv|tsv|json|jsonl|ndjson|yaml|yml|log|ics|pdf|docx|xlsx)$/i.test(entry.name))?{parserMode:'plain' as const}:{}),processing:request.processing,id,name:request.name??(entries.length===1?basename(entries[0].name):moteText("导入 {0} 个文件", entries.length)),instruction:request.instruction,sourceId:'',status:'queued',processingStatus:'archived',createdAt:now,updatedAt:now,files:[],summary:'',warnings:[],archive:{files:0,bytes:0,expandedFiles:0},progress:{total:0,processed:0,imported:0,duplicates:0},captureIds:[],workspace,inputs:[]};
    const stage=(entry:{name:string;bytes?:Buffer;fileId?:string;mimeType?:string;path?:string;sizeBytes?:number;identity?:string})=>{
      if(job.inputs.length>=MAX_FILES)throw new StoreError('Expanded archive exceeds 4000 files',413);
      const path=join(workspace,'inputs',archiveRelativePath(entry.name));if(job.inputs.some(i=>i.path===path))throw new StoreError('Archive contains duplicate file paths');
      const description={name:entry.name,relativePath:entry.name,mimeType:entry.mimeType};const file=entry.fileId?this.files.get(entry.fileId):entry.path?this.files.putParts(description,readParts(entry.path,entry.identity),entry.sizeBytes!):this.files.put({...description,bytes:entry.bytes!});
      job.files.push(file);job.inputs.push({path,fileId:file.id});job.archive.files++;job.archive.bytes+=file.sizeBytes;
    };
    // Store every original first, even if extraction later fails.
    if(entries.every(entry=>entry.fileId)){for(const entry of entries)stage(entry);}
    else{
      job.originalsPending=true;job.blockedArchive=true;this.save(job);this.running.add(id);
      try{for(const entry of entries){stage(entry);this.save(job);await yieldTurn();}delete job.originalsPending;job.blockedArchive=false;}
      catch(error){job.status='failed';job.processingStatus='blocked';job.error='Original archiving stopped: '+message(error);this.save(job);throw error;}
      finally{this.running.delete(id);}
    }
    job.sourceId=`import.${sha256(JSON.stringify(job.files.map(f=>[f.relativePath,f.hash]).sort())).slice(0,32)}`;
    // An explicit new upload may be reviewed again after deletion; old queued revisions remain tombstoned.
    if(this.store.db.prepare('SELECT 1 FROM source_versions v LEFT JOIN captures c ON c.id=v.capture_id WHERE v.source_id=? AND c.id IS NULL LIMIT 1').get(job.sourceId))job.sourceId+=`.${id.slice(0,8)}`;
    job.expansion={originalIds:job.files.map(file=>file.id),completedIds:[]};this.save(job);
    await this.expand(job);this.restoreOperation(job);return this.public(this.load(job.id));
  }
  private async expand(job:InternalJob,grant?:ExecutionGrant){
    if(!job.expansion)return;this.running.add(job.id);
    const save=()=>grant?grant.commit(()=>this.save(job)):this.save(job);
    try{
      for(const originalId of job.expansion.originalIds){
        grant?.assert();
        if(job.expansion.completedIds.includes(originalId))continue;
        const original=this.files.get(originalId);let first:Buffer|undefined;for(const part of this.files.bytes(original.id)){first=part;break;}
        const isZip=first&&first.length>=4&&first[0]===0x50&&first[1]===0x4b&&((first[2]===3&&first[3]===4)||(first[2]===5&&first[3]===6));
        if(!isZip||/\.(docx|xlsx|pptx|odt|ods)$/i.test(original.relativePath))continue;
        const prefix=original.relativePath+'.contents/',source=job.inputs.find(i=>i.fileId===original.id)!;await this.materialize(source);
        const output=join(job.workspace,'expanded',randomUUID());
        try{
          const other=job.files.filter(file=>!job.expansion!.originalIds.includes(file.id)&&!file.relativePath.startsWith(prefix));
          const expanded=await formatWork({kind:'zip',path:source.path,output,maxBytes:MAX_EXPANDED_BYTES-other.reduce((sum,file)=>sum+file.sizeBytes,0),maxFiles:MAX_FILES-job.expansion.originalIds.length-other.length});
          let staged=0;for(const entry of expanded.files){
            const append=()=>{
              const relativePath=archiveRelativePath(prefix+entry.name),prior=job.files.find(file=>file.relativePath===relativePath);
              const file=this.files.putParts({name:relativePath,relativePath},readParts(entry.path),entry.bytes,grant?()=>grant.assert():undefined);
              if(prior){if(prior.hash!==file.hash||prior.id!==file.id)throw new StoreError('Expanded original changed during recovery',409);}
              else{job.files.push(file);job.inputs.push({path:join(job.workspace,'inputs',relativePath),fileId:file.id});job.archive.files++;job.archive.bytes+=file.sizeBytes;job.archive.expandedFiles++;}
              if(grant)this.save(job);
            };
            if(grant)grant.commit(append);else{append();if(++staged%25===0)save();}
            await yieldTurn();
          }
          job.expansion.completedIds.push(originalId);save();
        }finally{rmSync(output,{recursive:true,force:true});}
      }
      delete job.expansion;job.status='queued';job.processingStatus='archived';job.blockedArchive=false;job.error=undefined;save();
    }catch(error){
      if(grant)this.store.assets.sweep();
      if(error instanceof ExecutionFailure&&error.category==='stale')return;
      // A fenced per-file transaction may have rolled back after mutating this copy.
      if(grant)job=this.load(job.id);
      job.status='failed';job.processingStatus='blocked';job.failurePhase='prepare';job.blockedArchive=error instanceof StoreError&&error.statusCode===422;job.error=`Original files were saved, but archive expansion failed: ${message(error)}`;job.warnings=[...job.warnings,job.error].slice(-200);
      try{save();}catch(failure){if(!(failure instanceof ExecutionFailure&&failure.category==='stale'))throw failure;}
    }
    finally{rmSync(join(job.workspace,'inputs'),{recursive:true,force:true});this.running.delete(job.id);}
  }
  updateInstruction(id:string,instruction:string):ImportJob {
    z.string().max(12000).parse(instruction);const job=this.load(id);
    if(job.sourcePackId&&instruction.trim())throw new StoreError('Python Source Packs use fixed parser code; use model analysis for freeform import instructions',409);
    if(this.running.has(id)||this.isScheduled(id)||job.progress.processed>0||job.status==='completed')throw new StoreError('This import can no longer be reanalyzed',409);
    job.preparationRevision=(job.preparationRevision??0)+1;job.instruction=instruction;if(instruction.trim())delete job.parserMode;job.status='queued';job.processingStatus='archived';job.failurePhase='prepare';job.preview=undefined;job.dispositions=undefined;job.reviewDecision=undefined;job.reviewGate=undefined;job.manifestHash=undefined;job.progress.total=0;job.error=undefined;this.save(job);return this.public(job);
  }
  private async materialize(input:{path:string;fileId:string}){
    privateDirectory(dirname(input.path));privateFile(input.path,true);
    const fd=openSync(input.path,constants.O_WRONLY|constants.O_TRUNC|constants.O_NOFOLLOW);
    await pipeline(Readable.from(this.files.bytes(input.fileId)),createWriteStream(input.path,{fd,autoClose:true}));
  }
  private validateManifest(job:InternalJob,path:string,output:string,signal?:AbortSignal,expectedHash?:string,dispositions=false){return formatWork({kind:'manifest',workspace:job.workspace,path,output,inputs:job.inputs.map(input=>({...input,file:this.files.get(input.fileId)})),expectedHash,dispositions},signal);}
  private attempt(job:InternalJob):InternalJob {
    const parent=join(job.workspace,'attempts');privateDirectory(parent);
    const workspace=join(parent,randomUUID());privateDirectory(workspace);privateDirectory(join(workspace,'inputs'));
    return {...job,workspace,inputs:job.inputs.map(input=>({fileId:input.fileId,
      path:join(workspace,'inputs',archiveRelativePath(relative(join(job.workspace,'inputs'),input.path))) }))};
  }
  /** Parser output stays private to one worker until a fenced preview is published. */
  private async stagePrepared(job:InternalJob,attempt:InternalJob,path:string,signal?:AbortSignal){
    const mapping=new Map(attempt.inputs.map((input,index)=>[input.path,job.inputs[index]!.path]));
    const lines:string[]=[];
    for await(const record of this.validatedRecords(path,signal)){
      const canonical=(paths:string[])=>paths.map(value=>{const mapped=mapping.get(value);if(!mapped)throw new StoreError('Prepared record references an unknown input path',409);return mapped;});
      lines.push(JSON.stringify({...record,evidencePaths:canonical(record.evidencePaths),attachments:canonical(record.attachments)}));
    }
    const data=Buffer.from(lines.map(line=>line+'\n').join(''));
    if(data.length>32*1024*1024)throw new StoreError('Prepared manifest exceeds 32 MiB',413);
    const staged=join(job.workspace,`prepared-${randomUUID()}.tmp`);
    writeFileSync(staged,data,{flag:'wx',mode:0o600});
    return {staged,hash:sha256(data)};
  }
  private publishPrepared(job:InternalJob,grant:ExecutionGrant,staged:string){
    const path=join(job.workspace,'prepared.jsonl'),backup=join(job.workspace,`prepared-${randomUUID()}.bak`);
    let prior=false,published=false;
    try{grant.commit(()=>{
      if(existsSync(path)){renameSync(path,backup);prior=true;}
      renameSync(staged,path);published=true;this.save(job);
    });}
    catch(error){
      if(published)rmSync(path,{force:true});
      if(prior)renameSync(backup,path);
      throw error;
    }finally{rmSync(staged,{force:true});if(!prior||published)rmSync(backup,{force:true});}
  }
  private phaseFailure(id:string,phase:'prepare'|'import',grant:ExecutionGrant,signal:AbortSignal|undefined,error:unknown):ImportJob {
    if(signal?.aborted||error instanceof ExecutionFailure&&error.category==='stale')return this.public(this.load(id));
    try{return grant.commit(()=>{
      const job=this.load(id);job.status=phase==='prepare'&&error instanceof Error&&error.name==='AgentNotConfiguredError'?'needs_configuration':'failed';
      job.processingStatus='blocked';job.failurePhase=phase;job.error=message(error);this.save(job);return this.public(job);
    });}catch(failure){if(failure instanceof ExecutionFailure&&failure.category==='stale')return this.public(this.load(id));throw failure;}
  }
  private async *validatedRecords(path:string,signal?:AbortSignal):AsyncGenerator<PreparedRecord>{
    const stream=createReadStream(path,{fd:openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),autoClose:true,encoding:'utf8',highWaterMark:65536}),lines=createInterface({input:stream,crlfDelay:Infinity});
    try{for await(const line of lines){signal?.throwIfAborted();if(line.trim())yield JSON.parse(line) as PreparedRecord;}}finally{lines.close();stream.destroy();}
  }
  /** Format decoding only. No author, event time, intent or personal fact is inferred. */
  private async preparePlain(job:InternalJob,grant:ExecutionGrant,signal?:AbortSignal):Promise<ImportJob>{
    this.running.add(job.id);let attempt:InternalJob|undefined;
    try{
      grant.commit(()=>{job.status='preparing';job.processingStatus='analyzing';job.failurePhase='prepare';job.error=undefined;job.preview=undefined;job.dispositions=undefined;job.reviewDecision=undefined;job.reviewGate=undefined;job.manifestHash=undefined;this.save(job);});
      attempt=this.attempt(job);
      for(const input of attempt.inputs)await this.materialize(input);
      const decoded=await formatWork({kind:'plain',inputs:attempt.inputs.map(input=>({path:input.path,file:this.files.get(input.fileId)})),createdAt:job.createdAt,manifest:join(attempt.workspace,'prepared.jsonl')},signal);
      signal?.throwIfAborted();grant.assert();
      const prepared=await this.stagePrepared(job,attempt,join(attempt.workspace,'prepared.jsonl'),signal);
      job.manifestHash=prepared.hash;job.summary='Source document text archived directly; author and original dates remain unspecified.';job.warnings=decoded.warnings;
      job.preview={count:decoded.count,samples:decoded.samples};job.progress.total=decoded.count;job.status='awaiting_confirmation';job.processingStatus='preview_ready';
      job.dispositions={counts:{parsed:job.files.length,attachment:0,container:0,excluded:0,unsupported:0},items:job.files.map(file=>({fileId:file.id,path:file.relativePath,status:'parsed',reason:'Deterministic document decoder; no attribution or original date inferred'}))};
      job.reviewDecision=decoded.partial?
        {confidence:'low',ambiguous:false,reason:'Document decoding reported incomplete coverage; review the available text before publishing.'}:
        {confidence:'high',ambiguous:false,reason:'Deterministic document decoding preserved original text without inferred attribution or dates.'};
      // Full-coverage document decoders also report known fidelity limits (for
      // example DOCX page layout or unrecalculated XLSX formulas). Keep those
      // visible, but they do not make the extracted text ambiguous.
      job.reviewGate=reviewGate(job,job.reviewDecision,!decoded.partial);
      this.publishPrepared(job,grant,prepared.staged);return this.public(job);
    }catch(error){return this.phaseFailure(job.id,'prepare',grant,signal,error);}
    finally{if(attempt)rmSync(attempt.workspace,{recursive:true,force:true});this.running.delete(job.id);}
  }
  private async prepareNow(id:string,grant:ExecutionGrant,signal?:AbortSignal):Promise<ImportJob>{
    let job=this.load(id);if(this.running.has(id))throw new StoreError('Import is already processing',409);
    if(job.expansion&&!job.blockedArchive){grant.assert();await this.expand(job,grant);job=this.load(id);if(job.expansion)return this.public(job);}
    if(job.blockedArchive)return this.public(job);
    if(job.progress.processed>0||job.status==='completed')throw new StoreError('Saved records cannot be reanalyzed in the same job',409);
    if(job.parserMode==='plain')return this.preparePlain(job,grant,signal);
    const pack=job.sourcePackId?this.runtime.sourcePacks?.get(job.sourcePackId):undefined;
    if(job.sourcePackId&&(!pack||pack.revision!==job.sourcePackRevision))return grant.commit(()=>{job.status='needs_configuration';job.processingStatus='blocked';job.error='The pinned Python Source Pack is unavailable or has changed. Start a new import with the installed pack.';this.save(job);return this.public(job);});
    const prepare=pack?.prepare??this.runtime.prepare;
    if(!prepare)return grant.commit(()=>{job.status='needs_configuration';job.processingStatus='blocked';job.error='Configure a model or trusted Python Source Pack to analyze the archived files.';this.save(job);return this.public(job);});
    this.running.add(id);const previous=job.summary||job.error?{summary:job.summary,error:job.error}:undefined;
    let attempt:InternalJob|undefined;
    try{
      grant.commit(()=>{
        // Preserve archive warnings across attempts, while dropping parser warnings.
        job.archiveWarnings??=[...job.warnings];job.warnings=[...job.archiveWarnings];
        job.status='preparing';job.processingStatus='analyzing';job.error=undefined;job.preview=undefined;job.dispositions=undefined;job.reviewDecision=undefined;job.reviewGate=undefined;job.manifestHash=undefined;job.failurePhase='prepare';this.save(job);
      });
      attempt=this.attempt(job);
      // Restore model-readable copies so retries start from authoritative archived bytes.
      for(const input of attempt.inputs)await this.materialize(input);
      const result=responseSchema.parse(await prepare({operationId:`import:${id}`,signal,workspace:attempt.workspace,inputPaths:attempt.inputs.map(i=>i.path),instruction:job.instruction,previous}));
      signal?.throwIfAborted();grant.assert();job.summary=result.summary;job.warnings=[...job.warnings,...(result.warnings??[])].slice(-200);
      const path=result.recordsPath??join(attempt.workspace,'records.jsonl');
      if(!existsSync(resolve(attempt.workspace,path)))return grant.commit(()=>{job.status='unsupported';job.processingStatus='blocked';job.error='Original files are archived. No validated records were produced; revise the instructions or retry with a suitable parser.';this.save(job);return this.public(job);});
      const prepared=await this.validateManifest(attempt,path,join(attempt.workspace,'prepared.jsonl'),signal,undefined,true);signal?.throwIfAborted();grant.assert();
      job.dispositions=prepared.dispositions;job.warnings=[...job.warnings,...prepared.warnings].slice(-200);
      if(!prepared.count)return grant.commit(()=>{job.status='unsupported';job.processingStatus='blocked';job.error='Original files are archived. No validated records were produced; revise the instructions or retry with a suitable parser.';this.save(job);return this.public(job);});
      const canonical=await this.stagePrepared(job,attempt,join(attempt.workspace,'prepared.jsonl'),signal);
      job.manifestHash=canonical.hash;job.preview={count:prepared.count,samples:prepared.samples};job.progress.total=prepared.count;job.status='awaiting_confirmation';job.processingStatus='preview_ready';job.reviewDecision=result.reviewDecision;job.reviewGate=reviewGate(job,result.reviewDecision);
      this.publishPrepared(job,grant,canonical.staged);return this.public(job);
    }catch(error){return this.phaseFailure(id,'prepare',grant,signal,error);}
    finally{if(attempt)rmSync(attempt.workspace,{recursive:true,force:true});this.running.delete(id);}
  }
  private async confirmNow(id:string,grant:ExecutionGrant,signal?:AbortSignal):Promise<ImportJob>{
    const job=this.load(id);if(this.running.has(id))throw new StoreError('Import is already processing',409);
    if(job.status==='completed')return this.public(job);
    if(job.status!=='awaiting_confirmation'&&!(job.status==='failed'&&job.failurePhase==='import'))throw new StoreError('Analyze and review a preview before confirming the import',409);
    this.running.add(id);
    const validated=join(job.workspace,'validated-'+randomUUID()+'.jsonl');
    try{
      grant.commit(()=>{job.status='importing';job.processingStatus='saving';job.failurePhase='import';job.error=undefined;this.save(job);});
      const path=join(job.workspace,'prepared.jsonl');if(!job.manifestHash)throw new StoreError('The preview changed; analyze the files again before importing',409);
      await this.validateManifest(job,path,validated,signal,job.manifestHash);signal?.throwIfAborted();grant.assert();
      grant.commit(()=>this.sources.register({id:job.sourceId,name:job.name,kind:'upload',deviceId:'mote-import',platform:'import',retention:'archive',enabled:true}));
      let index=-1;for await(const record of this.validatedRecords(validated,signal)){
        index++;if(index<job.progress.processed)continue;signal?.throwIfAborted();grant.assert();const fileIds=[...record.evidencePaths,...record.attachments].map(path=>job.inputs.find(input=>input.path===path)!.fileId);
        await this.sources.upsert(job.sourceId,record.item,()=>grant.assert(),result=>{
          grant.assert();this.files.attach(result.id,fileIds);
          linkOperationParent(this.store,`import:${id}`,`capture:${result.id}`);linkOperationParent(this.store,`import:${id}`,`file:${result.id}`);
          if(result.duplicate)job.progress.duplicates++;else{job.progress.imported++;job.captureIds.push(result.id);}
          job.progress.processed=index+1;this.save(job);
        });
      }
      if(this.runtime.onImported&&job.captureIds.length&&!job.memoryNotified){
        grant.assert();const result=await this.runtime.onImported([...job.captureIds],job.id);
        grant.commit(()=>{job.memoryJobId=result.memoryJobId;if(result.memoryJobId)linkOperationParent(this.store,`import:${id}`,`memory:${result.memoryJobId}`);job.memoryNotified=true;this.save(job);});
      }
      return grant.commit(()=>{job.status='completed';job.processingStatus='saved';this.save(job);return this.public(job);});
    }catch(error){return this.phaseFailure(id,'import',grant,signal,error);}
    finally{rmSync(validated,{force:true});this.running.delete(id);}
  }
  private phaseId(job:InternalJob,phase:'prepare'|'commit'){
    // Expansion may append files while a prepare lease is active. Its source ID and
    // preparation revision stay fixed; a new reviewed preview always changes the commit ID.
    return sha256(JSON.stringify([`import:${job.id}`,phase,phase==='prepare'?[job.preparationRevision??0,job.sourceId,job.instruction,job.parserMode,job.sourcePackId,job.sourcePackRevision]:[job.preparationRevision??0,job.manifestHash??'legacy']]));
  }
  private admitPhase(job:InternalJob,phase:'prepare'|'commit',state:ExecutionStep['state']='waiting',error?:string){
    const id=this.phaseId(job,phase);return this.executor.enqueue(`import:${job.id}`,`imports.${phase}`,{jobId:job.id,phase},{id,generation:{slot:phase,version:id},initial:{state,attempts:['running','succeeded','failed'].includes(state)?1:0,availableAt:0,error},...(phase==='commit'?{dependencies:[this.phaseId(job,'prepare')]}:{})});
  }
  private restoreOperation(job:InternalJob){
    for(const row of this.store.db.prepare("SELECT id FROM execution_steps WHERE kind IN ('imports.prepare','imports.commit') AND json_extract(input,'$.jobId')=? AND state='running' AND lease_until<=?").all(job.id,Date.now()))this.executor.fail(String(row.id),'interrupted');
    const state=job.status==='awaiting_confirmation'||job.status==='completed'||job.failurePhase==='import'?'succeeded':job.status==='failed'?'failed':'blocked';
    this.admitPhase(job,'prepare',state,state==='blocked'?(job.status==='needs_configuration'?'model_unconfigured':job.status==='unsupported'?'unsupported_format':'awaiting_activation'):state==='failed'?'import_failed':undefined);
    if(job.status==='awaiting_confirmation'||job.status==='completed'||job.failurePhase==='import')this.admitPhase(job,'commit',job.status==='completed'?'succeeded':job.status==='failed'?'failed':'blocked',job.status==='failed'?'import_failed':job.status==='completed'?undefined:'awaiting_confirmation');
    for(const id of job.captureIds){linkOperationParent(this.store,`import:${job.id}`,`capture:${id}`);linkOperationParent(this.store,`import:${job.id}`,`file:${id}`);}
    if(job.memoryJobId)linkOperationParent(this.store,`import:${job.id}`,`memory:${job.memoryJobId}`);
  }
  private projectPhase(step:ExecutionStep){
    const id=String(step.input.jobId),job=this.load(id);job.operationId=`import:${id}`;
    if(step.id!==this.phaseId(job,step.input.phase as 'prepare'|'commit')){
      // A late projection from an obsolete preview cannot overwrite its successor.
      if(!['waiting','running'].includes(step.state)){const waiters=this.phaseWaiters.get(step.id);this.phaseWaiters.delete(step.id);for(const resolve of waiters??[])resolve();}
      return;
    }
    const status=step.state==='waiting'?'queued':step.state==='succeeded'?'completed':step.state==='stale'?'failed':step.state;
    job.execution=executionEnvelope({status,attempts:step.attempts,errorCode:step.error,availableAt:step.availableAt});
    if(this.executor.closed&&step.state==='waiting'){this.executor.fail(step.id,'interrupted');return;}
    if(['failed','cancelled','stale'].includes(step.state)&&!['failed','unsupported','needs_configuration'].includes(job.status)){job.status='failed';job.processingStatus='blocked';job.error=step.error==='interrupted'?'The server stopped during processing. Retry to resume.':'Import processing did not complete. Retry to resume.';}
    this.save(job);
    if(!['waiting','running'].includes(step.state)){const waiters=this.phaseWaiters.get(step.id);this.phaseWaiters.delete(step.id);for(const resolve of waiters??[])resolve();}
  }
  private async runPhase(id:string,phase:'prepare'|'commit'){
    if(this.isScheduled(id))throw new StoreError('Import is already processing',409);
    const job=this.load(id),stepId=this.admitPhase(job,phase),step=this.executor.get(stepId)!;
    if(step.state==='succeeded')return this.public(this.load(id));
    if(step.state!=='running')this.executor.retry(stepId,false);
    const done=new Promise<void>(resolve=>{let waiters=this.phaseWaiters.get(stepId);if(!waiters){waiters=new Set();this.phaseWaiters.set(stepId,waiters);}waiters.add(resolve);});
    void this.executor.tick().catch(()=>this.executor.fail(stepId,'import_failed'));await done;await this.executor.drain([stepId]);return this.public(this.load(id));
  }
  async prepare(id:string):Promise<ImportJob>{
    const job=this.load(id);if(job.progress.processed>0||job.status==='completed')throw new StoreError('Saved records cannot be reanalyzed in the same job',409);
    const result=await this.runPhase(id,'prepare');return result.status==='awaiting_confirmation'&&result.reviewGate?.decision==='automatic'?this.confirm(id):result;
  }
  async confirm(id:string):Promise<ImportJob>{
    const job=this.load(id);if(job.status==='completed')return this.public(job);
    if(job.status!=='awaiting_confirmation'&&!(job.status==='failed'&&job.failurePhase==='import'))throw new StoreError('Analyze and review a preview before confirming the import',409);
    return this.runPhase(id,'commit');
  }
  async retry(id:string):Promise<ImportJob>{const job=this.load(id);return job.failurePhase==='import'?this.confirm(id):this.prepare(id);}
  delete(id:string){
    const job=this.load(id);if(this.running.has(id)||this.isScheduled(id)||job.status==='preparing'||job.status==='importing')throw new StoreError('Wait for this import to stop before deleting it',409);
    const otherJobs=(this.store.db.prepare('SELECT json FROM import_jobs WHERE id!=?').all(id) as {json:string}[]).map(row=>JSON.parse(row.json) as InternalJob);
    const retainedSharedSource=otherJobs.some(other=>other.sourceId===job.sourceId);let captures=0;
    if(!retainedSharedSource){
      const records=this.store.db.prepare('SELECT capture_id FROM source_versions WHERE source_id=?').all(job.sourceId) as {capture_id:string}[];
      for(const record of records)captures+=this.store.delete(record.capture_id).deleted;
      this.store.db.prepare('DELETE FROM source_heads WHERE source_id=?').run(job.sourceId);
      this.store.db.prepare('DELETE FROM source_connections WHERE id=?').run(job.sourceId);
    }
    this.store.db.prepare('DELETE FROM execution_operation_steps WHERE operation_id=?').run(`import:${id}`);this.store.db.prepare('DELETE FROM operation_parents WHERE parent_id=?').run(`import:${id}`);
    this.store.db.prepare('DELETE FROM import_jobs WHERE id=?').run(id);rmSync(job.workspace,{recursive:true,force:true});
    const retained=new Set(otherJobs.flatMap(other=>other.files.map(file=>file.id))),removed=this.files.removeUnreferenced(job.files.map(file=>file.id),retained);
    return {deleted:true,captures,files:removed.files,bytes:removed.bytes,retainedSharedSource};
  }
}

const fileIdentity=(info:import('node:fs').BigIntStats)=>[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':');
function* readParts(path:string,expected?:string){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),buffer=Buffer.alloc(4*1024*1024);
 const check=()=>{const info=fstatSync(fd,{bigint:true});if(!info.isFile()||expected&&(fileIdentity(info)!==expected||realpathSync(path)!==path))throw new StoreError('Original file changed during import',409);};
 try{check();let size:number;while((size=readSync(fd,buffer,0,buffer.length,null))>0)yield buffer.subarray(0,size);check();}finally{closeSync(fd);}
}
