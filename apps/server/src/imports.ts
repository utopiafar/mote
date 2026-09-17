import { moteText } from './i18n.js';
import {randomUUID} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {unzipSync} from 'fflate';
import {z} from 'zod';
import {importRequestSchema,sourceItemSchema,type ArchivedFile,type ImportDispositions,type ImportJob,type SourceItem} from '@mote/shared';
import {ArchivedFileStore,MAX_FILE_BYTES,archiveRelativePath} from './archived-files.js';
import {privateDirectory,privateFile} from './private-storage.js';
import {SourceStore} from './sources.js';
import {Store,StoreError,sha256} from './store.js';

const MAX_INPUT_BYTES=256*1024*1024,MAX_EXPANDED_BYTES=512*1024*1024,MAX_FILES=4000,MAX_MANIFEST_BYTES=32*1024*1024,MAX_RECORDS=10000;
export type ImportPreparation={workspace:string;inputPaths:string[];instruction:string;previous?:{summary:string;error?:string}};
export type ImportPreparationResult={summary:string;recordsPath?:string;warnings?:string[]};
export type ImportRuntime={prepare?:(input:ImportPreparation)=>Promise<ImportPreparationResult>;onImported?:(captureIds:string[],importJobId:string)=>Promise<{memoryJobId?:string}>};
type PreparedRecord={item:SourceItem;evidencePaths:string[];attachments:string[]};
type InternalJob=ImportJob&{workspace:string;inputs:{path:string;fileId:string}[];manifestHash?:string;failurePhase?:'prepare'|'import';memoryNotified?:boolean;blockedArchive?:boolean};
export const importRecordSchema=z.object({item:sourceItemSchema,evidencePaths:z.array(z.string().min(1).max(4000)).min(1).max(100),attachments:z.array(z.string().min(1).max(4000)).max(100).default([])}).strict();
const responseSchema=z.object({summary:z.string().max(20000),recordsPath:z.string().max(4000).optional(),warnings:z.array(z.string().max(2000)).max(200).optional()}).strict();
const dispositionsSchema=z.object({items:z.array(z.object({path:z.string().min(1).max(4000),status:z.enum(['parsed','attachment','container','excluded','unsupported']),reason:z.string().min(1).max(1000)}).strict()).max(MAX_FILES)}).strict();
const message=(error:unknown)=>error instanceof Error?error.message.slice(0,2000):'Import failed';
const inside=(root:string,path:string)=>{const rel=relative(root,path);return rel===''||(!rel.startsWith(`..${sep}`)&&rel!=='..'&&!isAbsolute(rel));};

/** The model interprets formats; this service owns bytes, validation, confirmation, and retries. */
export class ImportStore {
  private running=new Set<string>();
  readonly directory:string;
  constructor(public store:Store,public files:ArchivedFileStore,public sources:SourceStore,private runtime:ImportRuntime={}) {
    const directory=join(store.directory,'imports');privateDirectory(directory);this.directory=realpathSync(directory);
    store.db.exec('CREATE TABLE IF NOT EXISTS import_jobs(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,json TEXT NOT NULL)');
    // Paths are derived from this vault, never from a backed-up absolute workspace.
    for(const row of store.db.prepare('SELECT id,json FROM import_jobs').all() as {id:string;json:string}[]){
      const job=JSON.parse(row.json) as InternalJob;
      if(!z.string().uuid().safeParse(row.id).success||job.id!==row.id)throw new StoreError('Invalid import job identity in the database',500);
      const workspace=join(this.directory,row.id),relocated=job.workspace!==workspace;job.workspace=workspace;
      let missingOriginals=false;
      try{job.inputs=job.files.map(file=>{const original=files.get(file.id);return {fileId:original.id,path:join(workspace,'inputs',archiveRelativePath(original.relativePath))};});}
      catch{missingOriginals=true;job.inputs=[];job.blockedArchive=true;const warning='Some archived originals are missing from this restored vault. Upload the original files again to analyze them.';if(!job.warnings.includes(warning))job.warnings=[...job.warnings,warning].slice(-200);}
      const missingPreview=(job.status==='awaiting_confirmation'||job.status==='importing'||job.failurePhase==='import')&&!existsSync(join(workspace,'prepared.jsonl'));
      if(job.status!=='completed'&&(relocated||missingPreview)){
        job.status=job.blockedArchive?'failed':'queued';job.processingStatus=job.blockedArchive?'blocked':'archived';job.failurePhase='prepare';job.preview=undefined;job.dispositions=undefined;job.manifestHash=undefined;
        job.progress={total:0,processed:0,imported:0,duplicates:0};
        if(missingOriginals)job.error='This backup is missing original files. Upload them again to continue.';
        else if(!job.blockedArchive)job.error='Restored backup: original files are retained. Analyze this import again and review a new preview before continuing.';
      }else if(job.status==='preparing'||job.status==='importing'){
        job.failurePhase=job.status==='importing'?'import':'prepare';job.status='failed';job.processingStatus='blocked';job.error='The server stopped during processing. Retry to resume.';
      }
      if(JSON.stringify(job)!==row.json)this.save(job);
    }
  }
  private load(id:string):InternalJob{const row=this.store.db.prepare('SELECT json FROM import_jobs WHERE id=?').get(id) as {json:string}|undefined;if(!row)throw new StoreError('Import job not found',404);return JSON.parse(row.json);}
  private public(job:InternalJob):ImportJob{const {workspace,inputs,manifestHash,failurePhase,memoryNotified,blockedArchive,...value}=job;return value;}
  private save(job:InternalJob){job.updatedAt=new Date().toISOString();const json=JSON.stringify(job),old=this.store.db.prepare('SELECT length(CAST(json AS BLOB)) AS bytes FROM import_jobs WHERE id=?').get(job.id) as {bytes:number}|undefined;this.store.reserveMetadata(Math.max(0,Buffer.byteLength(json)-(old?.bytes??0)));this.store.db.prepare('INSERT INTO import_jobs(id,created_at,updated_at,json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,json=excluded.json').run(job.id,job.createdAt,job.updatedAt,json);}
  get(id:string):ImportJob{return this.public(this.load(id));}
  list():ImportJob[]{return (this.store.db.prepare('SELECT json FROM import_jobs ORDER BY created_at DESC LIMIT 100').all() as {json:string}[]).map(r=>this.public(JSON.parse(r.json)));}
  async create(raw:unknown):Promise<ImportJob> {
    const request=importRequestSchema.parse(raw);
    if(Number((this.store.db.prepare('SELECT COUNT(*) AS n FROM import_jobs').get() as {n:number}).n)>=1000)throw new StoreError('Import job limit reached',413);
    const entries:{name:string;mimeType?:string;bytes:Buffer}[]=[];let total=0;
    const add=(name:string,bytes:Buffer,mimeType?:string)=>{archiveRelativePath(name);total+=bytes.length;if(bytes.length>MAX_FILE_BYTES||total>MAX_INPUT_BYTES||entries.length>=MAX_FILES)throw new StoreError('Import exceeds file count or size limits (64 MiB per file, 256 MiB total)',413);entries.push({name,bytes,mimeType});};
    if(request.files){
      for(const file of request.files){if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.dataBase64))throw new StoreError('Invalid file base64');add(file.name,Buffer.from(file.dataBase64,'base64'),file.mimeType);}
    }else{
      const source=realpathSync(resolve(request.directory!)),vault=realpathSync(this.store.directory);
      if(inside(source,vault)||inside(vault,source))throw new StoreError('Choose a directory outside the Mote data directory');
      if(!lstatSync(source).isDirectory())throw new StoreError('Import path must be a directory');
      const walk=(directory:string,depth:number)=>{if(depth>30)throw new StoreError('Directory nesting exceeds 30 levels',413);for(const name of readdirSync(directory).sort()){
        const path=join(directory,name),info=lstatSync(path);if(info.isSymbolicLink())throw new StoreError('Directory imports cannot follow symbolic links');
        if(info.isDirectory())walk(path,depth+1);else if(info.isFile()){if(info.size>MAX_FILE_BYTES||total+info.size>MAX_INPUT_BYTES)throw new StoreError('Directory exceeds import size limits',413);add(relative(source,path).split(sep).join('/'),readFileSync(path));}
      }};walk(source,0);
    }
    if(!entries.length)throw new StoreError('No files were supplied');
    if(new Set(entries.map(e=>e.name)).size!==entries.length)throw new StoreError('File paths must be unique within an import');
    const now=new Date().toISOString(),id=randomUUID(),workspace=join(this.directory,id);privateDirectory(workspace);privateDirectory(join(workspace,'inputs'));
    const job:InternalJob={id,name:request.name??(entries.length===1?basename(entries[0].name):moteText("导入 {0} 个文件", entries.length)),instruction:request.instruction,sourceId:'',status:'queued',processingStatus:'archived',createdAt:now,updatedAt:now,files:[],summary:'',warnings:[],archive:{files:0,bytes:0,expandedFiles:0},progress:{total:0,processed:0,imported:0,duplicates:0},captureIds:[],workspace,inputs:[]};
    const stage=(entry:{name:string;bytes:Buffer;mimeType?:string},expanded=false)=>{
      if(job.inputs.length>=MAX_FILES)throw new StoreError('Expanded archive exceeds 4000 files',413);
      const path=join(workspace,'inputs',archiveRelativePath(entry.name));if(job.inputs.some(i=>i.path===path))throw new StoreError('Archive contains duplicate file paths');
      const file=this.files.put({name:entry.name,relativePath:entry.name,mimeType:entry.mimeType,bytes:entry.bytes});
      privateDirectory(dirname(path));writeFileSync(path,entry.bytes,{mode:0o600,flag:'wx'});job.files.push(file);job.inputs.push({path,fileId:file.id});job.archive.files++;job.archive.bytes+=file.sizeBytes;if(expanded)job.archive.expandedFiles++;
    };
    // Store every original first, even if extraction later fails.
    for(const entry of entries)stage(entry);
    job.sourceId=`import.${sha256(JSON.stringify(job.files.map(f=>[f.relativePath,f.hash]).sort())).slice(0,32)}`;
    // An explicit new upload may be reviewed again after deletion; old queued revisions remain tombstoned.
    if(this.store.db.prepare('SELECT 1 FROM source_versions v LEFT JOIN captures c ON c.id=v.capture_id WHERE v.source_id=? AND c.id IS NULL LIMIT 1').get(job.sourceId))job.sourceId+=`.${id.slice(0,8)}`;
    this.save(job);
    try{
      let expandedBytes=0;
      for(const entry of entries){
        const isZip=entry.bytes.length>=4&&entry.bytes[0]===0x50&&entry.bytes[1]===0x4b&&((entry.bytes[2]===3&&entry.bytes[3]===4)||(entry.bytes[2]===5&&entry.bytes[3]===6));
        // Office packages have their own generic decoders; exposing every XML part is unnecessary.
        if(!isZip||/\.(docx|xlsx|pptx|odt|ods)$/i.test(entry.name))continue;
        const seen=new Set<string>();
        const expanded=unzipSync(entry.bytes,{filter:file=>{
          const name=file.name.endsWith('/')?file.name.slice(0,-1):file.name;archiveRelativePath(name);
          if(seen.has(name))throw new StoreError('ZIP contains duplicate paths');seen.add(name);
          if(file.name.endsWith('/'))return false;
          expandedBytes+=file.originalSize;
          if(file.originalSize>MAX_FILE_BYTES||expandedBytes>MAX_EXPANDED_BYTES||job.inputs.length+seen.size>MAX_FILES)throw new StoreError('ZIP exceeds expanded file limits',413);
          return true;
        }});
        for(const [name,bytes]of Object.entries(expanded))stage({name:`${entry.name}.contents/${name}`,bytes:Buffer.from(bytes)},true);
      }
      this.save(job);
    }catch(error){job.status='failed';job.processingStatus='blocked';job.failurePhase='prepare';job.blockedArchive=true;job.error=`Original files were saved, but archive expansion failed: ${message(error)}`;job.warnings.push(job.error);this.save(job);}
    rmSync(join(workspace,'inputs'),{recursive:true,force:true});
    return this.public(job);
  }
  updateInstruction(id:string,instruction:string):ImportJob {
    z.string().max(12000).parse(instruction);const job=this.load(id);
    if(this.running.has(id)||job.progress.processed>0||job.status==='completed')throw new StoreError('This import can no longer be reanalyzed',409);
    job.instruction=instruction;job.status='queued';job.processingStatus='archived';job.failurePhase='prepare';job.preview=undefined;job.dispositions=undefined;job.manifestHash=undefined;job.progress.total=0;job.error=undefined;this.save(job);return this.public(job);
  }
  private resolveInput(job:InternalJob,path:string):{path:string;file:ArchivedFile}{
    const candidate=resolve(job.workspace,path),input=job.inputs.find(i=>i.path===candidate);
    if(!input||!inside(join(job.workspace,'inputs'),candidate))throw new StoreError('Manifest references a file outside the supplied inputs');
    const file=this.files.get(input.fileId);
    if(existsSync(candidate)){
      if(lstatSync(candidate).isSymbolicLink()||realpathSync(candidate)!==candidate)throw new StoreError('Manifest input must be an original regular file');
      if(sha256(readFileSync(candidate))!==file.hash)throw new StoreError('An input file changed during analysis; retry from the archived original');
    }
    return {path:candidate,file};
  }
  private readManifest(job:InternalJob,path:string):PreparedRecord[]{
    const absolute=resolve(job.workspace,path);
    if(!inside(job.workspace,absolute)||lstatSync(absolute).isSymbolicLink()||realpathSync(absolute)!==absolute)throw new StoreError('Records manifest must be a regular file inside the import workspace');
    const info=lstatSync(absolute);if(!info.isFile()||info.size>MAX_MANIFEST_BYTES)throw new StoreError('Records manifest exceeds 32 MiB',413);
    const lines=readFileSync(absolute,'utf8').split(/\r?\n/).filter(line=>line.trim());if(lines.length>MAX_RECORDS)throw new StoreError('Records manifest exceeds 10000 records',413);
    const identities=new Set<string>();
    return lines.map((line,index)=>{
      let value:unknown;try{value=JSON.parse(line);}catch{throw new StoreError(`Invalid JSON on manifest line ${index+1}`);}
      const parsed=importRecordSchema.safeParse(value);if(!parsed.success)throw new StoreError(`Invalid record on manifest line ${index+1}: ${parsed.error.issues.map(i=>i.message).join('; ').slice(0,300)}`);
      const record=parsed.data,key=JSON.stringify([record.item.externalId,record.item.revision]);if(identities.has(key))throw new StoreError(`Duplicate record identity on manifest line ${index+1}`);identities.add(key);
      const evidence=record.evidencePaths.map(p=>this.resolveInput(job,p)),attachments=record.attachments.map(p=>this.resolveInput(job,p));
      // Source identity, originals, and attachment IDs are assigned by Mote, never trusted from model text.
      const supplied=record.item as SourceItem&{document?:Record<string,unknown>};
      const item=sourceItemSchema.parse({...record.item,document:{...supplied.document,fileId:evidence[0].file.id,path:evidence[0].file.relativePath,attachments:attachments.map(a=>({id:a.file.id,name:a.file.name,path:a.file.relativePath,mimeType:a.file.mimeType}))}});
      return {item,evidencePaths:evidence.map(e=>e.path),attachments:attachments.map(a=>a.path)};
    });
  }
  private readDispositions(job:InternalJob):ImportDispositions|undefined{
    const path=join(job.workspace,'dispositions.json');if(!existsSync(path)){job.warnings.push('The analysis did not provide a per-file disposition list. Unlisted files must not be assumed to have been parsed.');return;}
    privateFile(path);if(lstatSync(path).size>8*1024*1024)throw new StoreError('File disposition manifest is too large',413);
    const parsed=dispositionsSchema.parse(JSON.parse(readFileSync(path,'utf8'))),seen=new Set<string>();
    const counts:ImportDispositions['counts']={parsed:0,attachment:0,container:0,excluded:0,unsupported:0};
    const items=parsed.items.map(item=>{const input=this.resolveInput(job,item.path);if(seen.has(input.path))throw new StoreError('Disposition manifest lists a file more than once');seen.add(input.path);counts[item.status]++;return {fileId:input.file.id,path:input.file.relativePath,status:item.status,reason:item.reason};});
    if(seen.size!==job.inputs.length)throw new StoreError('Disposition manifest must account for every supplied file');
    if(counts.unsupported)job.warnings.push(`${counts.unsupported} archived file(s) remain unsupported and were not fully parsed.`);
    return {counts,items};
  }
  async prepare(id:string):Promise<ImportJob>{
    const job=this.load(id);if(this.running.has(id))throw new StoreError('Import is already processing',409);
    if(job.blockedArchive)return this.public(job);
    if(job.progress.processed>0||job.status==='completed')throw new StoreError('Saved records cannot be reanalyzed in the same job',409);
    if(!this.runtime.prepare){job.status='needs_configuration';job.processingStatus='blocked';job.error='Configure a model to analyze the archived files.';this.save(job);return this.public(job);}
    this.running.add(id);const previous=job.summary||job.error?{summary:job.summary,error:job.error}:undefined;
    job.status='preparing';job.processingStatus='analyzing';job.error=undefined;job.preview=undefined;job.dispositions=undefined;job.manifestHash=undefined;job.failurePhase='prepare';this.save(job);
    try{
      for(const output of ['records.jsonl','dispositions.json'])rmSync(join(job.workspace,output),{force:true});
      // Restore model-readable copies so retries start from authoritative archived bytes.
      for(const input of job.inputs){privateDirectory(dirname(input.path));if(existsSync(input.path))privateFile(input.path);writeFileSync(input.path,this.files.read(input.fileId),{mode:0o600});}
      const result=responseSchema.parse(await this.runtime.prepare({workspace:job.workspace,inputPaths:job.inputs.map(i=>i.path),instruction:job.instruction,previous}));
      job.summary=result.summary;job.warnings=[...job.warnings,...(result.warnings??[])].slice(-200);
      job.dispositions=this.readDispositions(job);
      const path=result.recordsPath??join(job.workspace,'records.jsonl');
      const records=existsSync(resolve(job.workspace,path))?this.readManifest(job,path):[];
      if(job.dispositions){
        const roles=new Map(job.dispositions.items.map(item=>[item.fileId,item.status]));
        for(const record of records){
          for(const path of record.evidencePaths)if(roles.get(this.resolveInput(job,path).file.id)!=='parsed')throw new StoreError('Evidence paths must be marked parsed in the file disposition list');
          for(const path of record.attachments)if(!['parsed','attachment'].includes(roles.get(this.resolveInput(job,path).file.id)??''))throw new StoreError('Excluded or unsupported files cannot be silently attached to evidence');
        }
      }
      if(!records.length){job.status='unsupported';job.processingStatus='blocked';job.error='Original files are archived. No validated records were produced; revise the instructions or retry with a suitable parser.';this.save(job);return this.public(job);}
      const serialized=records.map(r=>JSON.stringify(r)).join('\n')+'\n',previewPath=join(job.workspace,'prepared.jsonl');privateFile(previewPath,true);writeFileSync(previewPath,serialized,{mode:0o600});job.manifestHash=sha256(serialized);
      job.preview={count:records.length,samples:records.slice(0,12).map(r=>({title:r.item.title,text:r.item.text.slice(0,1800),kind:r.item.kind,attachmentCount:r.attachments.length}))};job.progress.total=records.length;job.status='awaiting_confirmation';job.processingStatus='preview_ready';this.save(job);return this.public(job);
    }catch(error){job.status=error instanceof Error&&error.name==='AgentNotConfiguredError'?'needs_configuration':'failed';job.processingStatus='blocked';job.error=message(error);this.save(job);return this.public(job);}
    finally{rmSync(join(job.workspace,'inputs'),{recursive:true,force:true});this.running.delete(id);}
  }
  async confirm(id:string):Promise<ImportJob>{
    const job=this.load(id);if(this.running.has(id))throw new StoreError('Import is already processing',409);
    if(job.status==='completed')return this.public(job);
    if(job.status!=='awaiting_confirmation'&&!(job.status==='failed'&&job.failurePhase==='import'))throw new StoreError('Analyze and review a preview before confirming the import',409);
    this.running.add(id);job.status='importing';job.processingStatus='saving';job.failurePhase='import';job.error=undefined;this.save(job);
    try{
      const path=join(job.workspace,'prepared.jsonl');privateFile(path);if(!job.manifestHash||sha256(readFileSync(path))!==job.manifestHash)throw new StoreError('The preview changed; analyze the files again before importing',409);
      const records=this.readManifest(job,path);
      this.sources.register({id:job.sourceId,name:job.name,kind:'upload',deviceId:'mote-import',platform:'import',retention:'archive',enabled:true});
      for(let index=job.progress.processed;index<records.length;index++){
        const record=records[index],fileIds=[...record.evidencePaths,...record.attachments].map(p=>this.resolveInput(job,p).file.id);
        await this.sources.upsert(job.sourceId,record.item,undefined,result=>{
          this.files.attach(result.id,fileIds);
          if(result.duplicate)job.progress.duplicates++;else{job.progress.imported++;job.captureIds.push(result.id);}
          job.progress.processed=index+1;this.save(job);
        });
      }
      if(this.runtime.onImported&&job.captureIds.length&&!job.memoryNotified){const result=await this.runtime.onImported([...job.captureIds],job.id);job.memoryJobId=result.memoryJobId;job.memoryNotified=true;}
      job.status='completed';job.processingStatus='saved';this.save(job);return this.public(job);
    }catch(error){const saved=this.load(id);saved.status='failed';saved.processingStatus='blocked';saved.error=message(error);this.save(saved);return this.public(saved);}
    finally{this.running.delete(id);}
  }
  async retry(id:string):Promise<ImportJob>{const job=this.load(id);return job.failurePhase==='import'?this.confirm(id):this.prepare(id);}
  delete(id:string){
    const job=this.load(id);if(this.running.has(id)||job.status==='preparing'||job.status==='importing')throw new StoreError('Wait for this import to stop before deleting it',409);
    const otherJobs=(this.store.db.prepare('SELECT json FROM import_jobs WHERE id!=?').all(id) as {json:string}[]).map(row=>JSON.parse(row.json) as InternalJob);
    const retainedSharedSource=otherJobs.some(other=>other.sourceId===job.sourceId);let captures=0;
    if(!retainedSharedSource){
      const records=this.store.db.prepare('SELECT capture_id FROM source_versions WHERE source_id=?').all(job.sourceId) as {capture_id:string}[];
      for(const record of records)captures+=this.store.delete(record.capture_id).deleted;
      this.store.db.prepare('DELETE FROM source_heads WHERE source_id=?').run(job.sourceId);
      this.store.db.prepare('DELETE FROM source_connections WHERE id=?').run(job.sourceId);
    }
    this.store.db.prepare('DELETE FROM import_jobs WHERE id=?').run(id);rmSync(job.workspace,{recursive:true,force:true});
    const retained=new Set(otherJobs.flatMap(other=>other.files.map(file=>file.id))),removed=this.files.removeUnreferenced(job.files.map(file=>file.id),retained);
    return {deleted:true,captures,files:removed.files,bytes:removed.bytes,retainedSharedSource};
  }
}
