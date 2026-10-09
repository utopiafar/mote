import {recordingMemoryRecipe} from './recording-memory.js';
import {z} from 'zod';
import {StoreError} from '../store.js';
import {createHash,randomUUID} from 'node:crypto';
import {recordingSelectionSchema,type RecordingSelection,type RecordingStatus,type Transcript} from '@mote/shared';
import {ExecutionEngine,ExecutionFailure,type ExecutionStep,type ExecutionGrant} from '../execution-engine.js';
import {ArchivedFileStore} from '../archived-files.js';
import {PrivateFile} from './private-file.js';
import {ConnectorError,type ConnectorContext} from './types.js';
import type {ConnectorManifest} from './registry.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface RecordingAccount {id:string;name?:string;profile?:string}
export interface RecordingMetadata {id:string;title:string;createdAt?:string;recordedAt?:string;durationMs:number;uri?:string}
export interface RecordingProvider {
 id:string;version:string;
 account(signal?:AbortSignal):Promise<RecordingAccount>;
 discover(account:RecordingAccount,range:{start:string;end:string;cursor?:string},signal:AbortSignal):Promise<{ids:string[];next?:string}>;
 metadata(account:RecordingAccount,id:string,signal:AbortSignal):Promise<RecordingMetadata>;
 transcript(account:RecordingAccount,metadata:RecordingMetadata,signal:AbortSignal):Promise<{rawText:string;transcript:Transcript}>;
 media(account:RecordingAccount,metadata:RecordingMetadata,signal:AbortSignal):Promise<{mimeType:string;bytes:Buffer}>;
 close?():Promise<void>;
}
type Saved={version:1;account?:RecordingAccount;selection:RecordingSelection;epoch:string};
const savedSchema=z.object({version:z.literal(1),account:z.object({id:z.string().min(1).max(1000),name:z.string().max(500).optional(),profile:z.string().max(300).optional()}).strict().optional(),selection:recordingSelectionSchema,epoch:z.string().uuid()}).strict();
const defaults=():RecordingSelection=>({enabled:false,start:new Date(Date.now()-30*86400000).toISOString(),autoSync:true,backupAudio:true});
const phases=['discover','metadata','transcript','media'] as const;
type Phase=typeof phases[number];

/** Shared durable synchronization. Providers supply transport and decoding;
 * receipts, publication, recovery and cancellation remain host services. */
export class RecordingConnector {
 private saved:Saved={version:1,selection:defaults(),epoch:randomUUID()};
 private readonly file:PrivateFile<Saved>;
 readonly engine:ExecutionEngine;
 private readonly owned:boolean;
 private disposers:(()=>Promise<void>)[]=[];
 private timer?:ReturnType<typeof setInterval>;
 private closed=false;
 private error?:string;
 constructor(private ctx:ConnectorContext,readonly provider:RecordingProvider){
  new ArchivedFileStore(ctx.store);
  ctx.store.db.exec(`CREATE TABLE IF NOT EXISTS recording_media(source_id TEXT NOT NULL,external_id TEXT NOT NULL,file_id TEXT NOT NULL REFERENCES archived_files(id) ON DELETE CASCADE,PRIMARY KEY(source_id,external_id)); CREATE TABLE IF NOT EXISTS recording_cursors(source_id TEXT PRIMARY KEY,epoch TEXT NOT NULL,scanned_until TEXT NOT NULL,full_at INTEGER NOT NULL);`);
  this.file=new PrivateFile(ctx.config.connectors!.directory,`${provider.id}-recordings.json`);
  this.engine=ctx.sourcePipelines?.engine??new ExecutionEngine(ctx.store);this.owned=!ctx.sourcePipelines;
 }
 private sourceId(){return this.saved.account?`${this.provider.id}-recordings-${hash(this.saved.account.id).slice(0,24)}`:undefined;}
 private kind(phase:Phase){return `recording.${this.provider.id}.${phase}`;}
 private valid(step:ExecutionStep){return !this.closed&&this.saved.selection.enabled&&step.input.epoch===this.saved.epoch&&step.input.providerVersion===this.provider.version&&
  step.input.account===hash(this.saved.account?.id)&&Boolean(this.sourceId()&&this.ctx.sources.getSource(this.sourceId()!).enabled);}
 private authorize(step:ExecutionStep,grant:ExecutionGrant){grant.assert();if(!this.valid(step))throw new ExecutionFailure('stale','recording_binding_changed');}
 async init(){
  const value=await this.file.read();if(value)this.saved=savedSchema.parse(value);
  if(this.saved.account)this.registerSource();
  for(const phase of phases)this.disposers.push(this.engine.register({kind:this.kind(phase),pool:`recording.${phase}`,concurrency:()=>phase==='media'?1:2,
   timeoutMs:phase==='media'?300000:120000,maxAttempts:5,maxRecoveryWindowMs:24*3600000,
   validate:step=>this.valid(step),resourceKeys:step=>[`recording:${this.provider.id}:${step.input.account}:${step.input.id??'discovery'}:${phase}`],
   execute:async(step,signal,grant)=>{
    const started=Date.now();this.observe(phase,'started',step);
    try{this.authorize(step,grant);const current=await this.provider.account(signal);if(current.id!==this.saved.account!.id)throw new ExecutionFailure('blocked','recording_account_changed');
     const result=await this.execute(phase,step,signal,grant);this.observe(phase,'completed',step,{durationMs:Date.now()-started});return result;
    }catch(e){this.observe(phase,'failed',step,{durationMs:Date.now()-started});throw e;}
   },commit:(step,result)=>this.commit(phase,step,result),
   classify:error=>error instanceof ExecutionFailure?error:error instanceof z.ZodError?new ExecutionFailure('permanent','recording_contract_invalid'):error instanceof StoreError&&[400,409,410,413].includes(error.statusCode)?new ExecutionFailure('blocked','recording_archive_rejected'):error instanceof ConnectorError&&['lark_permission_required','lark_not_connected','lark_not_configured','lark_cli_missing','dingtalk_cli_missing','dingtalk_not_connected','dingtalk_permission_required'].includes(error.code)?new ExecutionFailure('blocked','recording_authorization_required'):
    new ExecutionFailure('transient','recording_provider_failed'),
  }));
  this.timer=setInterval(()=>{void this.tick().catch(()=>{this.error='recording_sync_failed';});},Math.max(1000,Math.min(this.ctx.config.connectors?.syncIntervalMs??300000,300000)));this.timer.unref();
  void this.engine.tick();
 }
 private observe(phase:Phase|'decode'|'publish',state:'started'|'completed'|'failed',step:ExecutionStep,extra:{count?:number;bytes?:number;durationMs?:number}={}){
  this.ctx.diagnostics?.record(`source.${state}`,{operation:`recording_${phase}`,attempt:step.attempts,...extra},state==='failed'?'warn':'info');
 }
 private registerSource(enable?:boolean){const id=this.sourceId()!;this.ctx.sources.register({id,name:`${this.provider.id} recordings`,kind:`${this.provider.id}.recordings`,deviceId:id,platform:'import',retention:'archive',enabled:enable??this.saved.selection.enabled});if(enable!==undefined)this.ctx.sources.update(id,{enabled:enable});if(this.ctx.sourcePipelines&&!this.ctx.store.db.prepare('SELECT 1 FROM source_pipeline_config WHERE source_id=?').get(id))this.ctx.sourcePipelines?.configure(id,{settleSeconds:0});if(enable===true&&this.ctx.memoryRecipeSettings&&!this.ctx.store.db.prepare('SELECT 1 FROM memory_recipe_settings WHERE source_id=?').get(id))this.ctx.memoryRecipeSettings?.configure({sourceId:id,recipes:[recordingMemoryRecipe]});}
  async connect(){if(this.closed)throw new ConnectorError('connector_closed');const account=await this.provider.account();
  this.cancel();if(this.sourceId())this.ctx.sources.update(this.sourceId()!,{enabled:false});const changed=this.saved.account?.id!==account.id;this.saved={...this.saved,account,selection:{...this.saved.selection,...(changed?{enabled:false}:{})},epoch:randomUUID()};await this.file.write(this.saved);this.registerSource(this.saved.selection.enabled);this.error=undefined;return this.status();}
  async select(raw:unknown){const selection=recordingSelectionSchema.parse(raw);if(!this.saved.account)throw new ConnectorError('recording_not_connected');
  if(Math.ceil((Date.parse(selection.end??new Date().toISOString())-Date.parse(selection.start))/(27*86400000))>240)throw new ConnectorError('recording_range_limit');
  this.cancel();this.saved={...this.saved,selection,epoch:randomUUID()};await this.file.write(this.saved);this.registerSource(selection.enabled);if(selection.enabled)this.sync();return this.status();}
 private cancel(){for(const phase of phases)this.engine.cancelKind(this.kind(phase));}
 async disconnect(){this.cancel();if(this.sourceId())this.ctx.sources.update(this.sourceId()!,{enabled:false});this.saved={...this.saved,account:undefined,selection:{...this.saved.selection,enabled:false},epoch:randomUUID()};await this.file.write(this.saved);return this.status();}
 private enqueue(phase:Phase,operationId:string,input:Record<string,unknown>){const bound={...input,epoch:this.saved.epoch,account:hash(this.saved.account!.id),providerVersion:this.provider.version};
  // A failed media backup is one durable work item across discovery rounds.
  // Do not multiply blocked downloads or reset their retry budget every poll.
  if(phase==='media'){
   // Reuse earlier transcript-dependent receipts too; upgrading must not multiply failed backups.
   const prior=this.ctx.store.db.prepare("SELECT id FROM execution_steps WHERE kind=? AND json_extract(input,'$.epoch')=? AND json_extract(input,'$.account')=? AND json_extract(input,'$.providerVersion')=? AND json_extract(input,'$.id')=? LIMIT 1").get(this.kind(phase),bound.epoch,bound.account,bound.providerVersion,String(input.id));
   if(prior)return this.engine.get(String(prior.id));
  }
  if(phase==='transcript'){
   const prior=this.ctx.store.db.prepare("SELECT id FROM execution_steps WHERE kind=? AND state IN ('waiting','running','failed','blocked') AND json_extract(input,'$.epoch')=? AND json_extract(input,'$.id')=? LIMIT 1").get(this.kind(phase),bound.epoch,String(input.id));
   if(prior)return this.engine.get(String(prior.id));
  }
  return this.engine.enqueue(operationId,this.kind(phase),bound,phase==='media'?{id:hash([this.kind(phase),bound])}:{});}
 sync(full=true){if(!this.saved.account||!this.saved.selection.enabled)throw new ConnectorError('recording_not_connected');
  const existing=Number(this.ctx.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE kind=? AND state IN ('waiting','running','blocked','failed') AND json_extract(input,'$.epoch')=?").get(this.kind('discover'),this.saved.epoch)!.n);if(existing)return this.status();
  const end=this.saved.selection.end??new Date().toISOString();const cursor=this.ctx.store.db.prepare('SELECT * FROM recording_cursors WHERE source_id=? AND epoch=?').get(this.sourceId()!,this.saved.epoch);
  const isFull=full||!cursor||Date.now()-Number(cursor.full_at)>86400000;
  const start=isFull?this.saved.selection.start:new Date(Math.max(Date.parse(this.saved.selection.start),Date.parse(String(cursor!.scanned_until))-7*86400000)).toISOString();
  if(Math.max(1,Math.ceil((Date.parse(end)-Date.parse(start))/(27*86400000)))>240)throw new ConnectorError('recording_range_limit');
  const operation='recording-sync:'+randomUUID();
  // Search APIs have bounded windows. Persist every window before starting IO.
  let from=Date.parse(start);const until=Date.parse(end);let windows=0;
  while(from<=until){if(++windows>240)throw new ConnectorError('recording_range_limit');const to=Math.min(until,from+27*86400000);
   this.enqueue('discover',operation,{start:new Date(from).toISOString(),end:new Date(to).toISOString(),page:0,runEnd:end,runFull:isFull});if(to===until)break;from=to;}
  void this.engine.tick();return this.status();
 }
 async tick(){if(this.closed)return;if(this.saved.account&&this.saved.selection.enabled&&this.saved.selection.autoSync){try{this.sync(false);}catch{this.error='recording_sync_failed';}}await this.engine.tick();}
 async drain(){for(let n=0;n<100;n++){const steps=this.ctx.store.db.prepare("SELECT id FROM execution_steps WHERE kind IN (SELECT value FROM json_each(?)) AND state IN ('waiting','running') AND available_at<=? LIMIT 100").all(JSON.stringify(phases.map(p=>this.kind(p))),Date.now()) as {id:string}[];if(!steps.length)return;await this.engine.drain(steps.map(s=>s.id));}}
 private async execute(phase:Phase,step:ExecutionStep,signal:AbortSignal,grant:ExecutionGrant):Promise<unknown>{
  const account=this.saved.account!,input=step.input,sourceId=this.sourceId()!,authorize=()=>{signal.throwIfAborted();this.authorize(step,grant);};
  if(phase==='discover'){const page=await this.provider.discover(account,{start:String(input.start),end:String(input.end),...(input.cursor?{cursor:String(input.cursor)}:{})},signal);
   if(page.ids.length>100||Number(input.page)>10000||page.next&&(page.next===input.cursor||Boolean(this.ctx.store.db.prepare("SELECT 1 FROM execution_steps WHERE operation_id=? AND kind=? AND json_extract(input,'$.start')=? AND json_extract(input,'$.cursor')=?").get(step.operationId,this.kind('discover'),String(input.start),page.next))))throw new ExecutionFailure('permanent','recording_pagination_invalid');
   this.observe(phase,'completed',step,{count:page.ids.length});return page;}
  const id=String(input.id);
  if(phase==='metadata'){const metadata=await this.provider.metadata(account,id,signal);if(metadata.id!==id||!Number.isFinite(metadata.durationMs)||metadata.durationMs<0)throw new ExecutionFailure('permanent','recording_identity_invalid');return metadata;}
  const metadata=input.metadata as unknown as RecordingMetadata;
  if(phase==='transcript'){
   const result=await this.provider.transcript(account,metadata,signal);if((await this.provider.account(signal)).id!==account.id)throw new ExecutionFailure('blocked','recording_account_changed');authorize();this.observe('decode','completed',step,{count:result.transcript.segments.length});
   if(!this.ctx.files)throw new ExecutionFailure('blocked','recording_storage_unavailable');
   const ack=await this.ctx.files.transcriptRevision(sourceId,{externalId:id,kind:'file',title:metadata.title,observedAt:new Date().toISOString(),deleted:false,
    ...(metadata.uri?{uri:metadata.uri}:{}),document:{contentRole:'transcript',...(metadata.recordedAt?{recordedAt:metadata.recordedAt,timeBasis:'recorded'}:{timeBasis:'unknown'})}},result.rawText,result.transcript,authorize);
   this.observe('publish','completed',step,{count:ack.duplicate?0:1});
   const prior=this.ctx.store.db.prepare('SELECT file_id FROM recording_media WHERE source_id=? AND external_id=?').get(sourceId,id);
   if(prior)grant.commit(()=>new ArchivedFileStore(this.ctx.store).attach(ack.id,[String(prior.file_id)]));
   return {captureId:ack.id,id};
  }
  // Media owns its durable receipt before any transcript exists. Both paths recheck deletion and grants.
  const requireAllowed=()=>{authorize();if(this.ctx.store.db.prepare('SELECT 1 FROM file_forgotten WHERE source_id=? AND external_id=?').get(sourceId,id))throw new ExecutionFailure('stale','recording_evidence_changed');};
  requireAllowed();
  const existing=this.ctx.store.db.prepare('SELECT file_id FROM recording_media WHERE source_id=? AND external_id=?').get(sourceId,id);
  if(existing)return {fileId:String(existing.file_id),id};
  const media=await this.provider.media(account,metadata,signal);if((await this.provider.account(signal)).id!==account.id)throw new ExecutionFailure('blocked','recording_account_changed');authorize();
  const archived=new ArchivedFileStore(this.ctx.store),file=archived.putRecordingMedia({name:`recording-${hash([sourceId,id])}.${({'audio/wav':'wav','audio/mp4':'m4a','audio/mpeg':'mp3','audio/flac':'flac','audio/ogg':'ogg'} as Record<string,string>)[media.mimeType]??'audio'}`,mimeType:media.mimeType,bytes:media.bytes},requireAllowed);
  this.observe(phase,'completed',step,{bytes:media.bytes.length});return {fileId:file.id,id};
 }
 private commit(phase:Phase,step:ExecutionStep,result:unknown){const value=result as any;
  if(phase==='discover'){
   for(const id of new Set<string>(value.ids))this.enqueue('metadata',step.operationId,{id,discovery:step.id});
   if(value.next)this.enqueue('discover',step.operationId,{start:step.input.start,end:step.input.end,cursor:value.next,page:Number(step.input.page)+1,runEnd:step.input.runEnd,runFull:step.input.runFull});
   else {const others=this.ctx.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE operation_id=? AND kind=? AND id!=? AND state!='succeeded'").get(step.operationId,this.kind('discover'),step.id);if(Number(others!.n)===0)this.ctx.store.db.prepare('INSERT INTO recording_cursors VALUES(?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET epoch=excluded.epoch,scanned_until=excluded.scanned_until,full_at=CASE WHEN excluded.full_at>0 THEN excluded.full_at ELSE recording_cursors.full_at END').run(this.sourceId()!,this.saved.epoch,String(step.input.runEnd),step.input.runFull?Date.now():0);}
  }else if(phase==='metadata'){
   const at=value.createdAt??value.recordedAt;if(at&&(Date.parse(at)<Date.parse(this.saved.selection.start)||this.saved.selection.end&&Date.parse(at)>Date.parse(this.saved.selection.end)))return;
   this.enqueue('transcript',step.operationId,{id:step.input.id,metadata:value,discovery:step.input.discovery});
   if(this.saved.selection.backupAudio)this.enqueue('media',step.operationId,{id:step.input.id,metadata:value});
  }else if(phase==='media'){
   if(this.ctx.store.db.prepare('SELECT 1 FROM file_forgotten WHERE source_id=? AND external_id=?').get(this.sourceId()!,value.id))throw new ExecutionFailure('stale','recording_evidence_changed');
   this.ctx.store.db.prepare('INSERT OR REPLACE INTO recording_media VALUES(?,?,?)').run(this.sourceId()!,value.id,value.fileId);
   const head=this.ctx.store.db.prepare('SELECT capture_id FROM file_heads WHERE source_id=? AND external_id=?').get(this.sourceId()!,value.id);
   if(head&&this.ctx.store.isCurrentEvidence(String(head.capture_id))){
    new ArchivedFileStore(this.ctx.store).attach(String(head.capture_id),[value.fileId]);
    this.ctx.store.db.prepare("INSERT INTO changes(id,operation,changed_at) VALUES(?,'upsert',?)").run(String(head.capture_id),new Date().toISOString());
   }
  }
 }
 status():RecordingStatus {
  const sourceId=this.sourceId(),all=phases.flatMap(phase=>this.engine.list({kind:this.kind(phase),limit:25}).items).filter(s=>s.input.epoch===this.saved.epoch);
  const transcripts=sourceId?Number(this.ctx.store.db.prepare('SELECT count(*) n FROM file_heads WHERE source_id=?').get(sourceId)!.n):0;
  const audio=sourceId?Number(this.ctx.store.db.prepare('SELECT count(*) n FROM recording_media WHERE source_id=?').get(sourceId)!.n):0;
  return {provider:this.provider.id,connected:Boolean(this.saved.account),accountName:this.saved.account?.name,sourceId,selection:this.saved.selection,
   steps:all.map(s=>({id:s.id,phase:s.kind.split('.').at(-1)!,state:s.state,attempts:s.attempts,...(s.error?{error:s.error}:{})})),
   counts:{transcripts,audio,pending:this.count(['running','waiting']),failed:this.count(['failed','blocked'])},...(this.error?{error:this.error}:{})};
 }
 items(){const sourceId=this.sourceId();if(!sourceId)return {items:[]};const rows=this.ctx.store.db.prepare('SELECT h.external_id,h.capture_id,m.file_id FROM file_heads h LEFT JOIN recording_media m ON m.source_id=h.source_id AND m.external_id=h.external_id JOIN captures c ON c.id=h.capture_id WHERE h.source_id=? ORDER BY c.received_at DESC LIMIT 30').all(sourceId) as {external_id:string;capture_id:string;file_id:string|null}[];return {items:rows.map(row=>{const item=this.ctx.sources.getItem(sourceId,row.external_id)!,audio=row.file_id?new ArchivedFileStore(this.ctx.store).get(row.file_id):undefined;return {captureId:row.capture_id,title:item.title,observedAt:item.observedAt,recordedAt:item.document?.recordedAt,...(audio?{audio:{id:audio.id,name:audio.name,mimeType:audio.mimeType}}:{})};})};}
 private count(states:string[]){return Number(this.ctx.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE kind IN (SELECT value FROM json_each(?)) AND state IN (SELECT value FROM json_each(?)) AND json_extract(input,'$.epoch')=?").get(JSON.stringify(phases.map(p=>this.kind(p))),JSON.stringify(states),this.saved.epoch)!.n);}
 retry(){const rows=this.ctx.store.db.prepare("SELECT id FROM execution_steps WHERE kind IN (SELECT value FROM json_each(?)) AND state IN ('failed','blocked') AND json_extract(input,'$.epoch')=?").all(JSON.stringify(phases.map(p=>this.kind(p))),this.saved.epoch) as {id:string}[];for(const row of rows)if(this.valid(this.engine.get(row.id)!))this.engine.retry(row.id);void this.engine.tick();return this.status();}
 async close(){this.closed=true;clearInterval(this.timer);for(const dispose of this.disposers)await dispose();if(this.owned)await this.engine.close();await this.provider.close?.();await this.file.flush();}
}

/** New providers use this same manifest; no new owner transport or task engine. */
export function recordingManifest(id:string,create:(ctx:ConnectorContext)=>RecordingProvider,options:Pick<RecordingStatus,'label'|'setup'>={}):ConnectorManifest{return {
 apiVersion:1,id:`${id}-recordings`,statusKey:`${id}-recordings`,sourceKinds:[{kind:`${id}.recordings`,capabilities:{lifecycle:'continuous',discovery:'provider-list',listening:'polling',readOriginal:'explicit-provider-read',synchronization:'revisions',externalWrite:false}}],
 create:ctx=>{
  ctx.store.db.exec('CREATE TABLE IF NOT EXISTS recording_media(source_id TEXT NOT NULL,external_id TEXT NOT NULL,file_id TEXT NOT NULL REFERENCES archived_files(id) ON DELETE CASCADE,PRIMARY KEY(source_id,external_id))');
  const provider=create(ctx);if(provider.id!==id)throw Error('Recording manifest and provider identity differ');const connector=new RecordingConnector(ctx,provider),status=()=>({...connector.status(),category:'recordings' as const,...options});return {status,init:()=>connector.init(),close:()=>connector.close(),configure:host=>{
   const path=`/api/connectors/${id}-recordings` as const;
   host.ownerRoute({method:'GET',path,handler:status});
   host.ownerRoute({method:'GET',path:`${path}/items`,handler:()=>connector.items()});
   host.ownerRoute({method:'POST',path:`${path}/connect`,handler:()=>connector.connect()});
   host.ownerRoute({method:'PUT',path:`${path}/selection`,handler:req=>connector.select(req.body)});
   host.ownerRoute({method:'POST',path:`${path}/sync`,handler:()=>connector.sync()});
   host.ownerRoute({method:'POST',path:`${path}/retry`,handler:()=>connector.retry()});
   host.ownerRoute({method:'DELETE',path,handler:()=>connector.disconnect()});
  }};
 },
};}
