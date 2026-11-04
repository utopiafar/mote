import {EXECUTION_POLICIES} from '../execution-policy.js';
import {recordingResources,type RecordingContext} from './recording-context.js';
import {z} from 'zod';
import {StoreError} from '../store.js';
import {createHash,randomUUID} from 'node:crypto';
import {recordingSelectionSchema,type RecordingSelection,type RecordingStatus,type Transcript} from '@mote/shared';
import {ExecutionEngine,ExecutionFailure,type ExecutionStep,type ExecutionGrant} from '../execution-engine.js';
import {PrivateFile} from './private-file.js';
import {ConnectorError,type ConnectorContext} from './types.js';
import type {RecordingAuthorizationPort} from '../plugins/recording-authorization.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface RecordingAccount {id:string;name?:string;profile?:string}
export interface RecordingMetadata {id:string;title:string;createdAt?:string;recordedAt?:string;durationMs:number;uri?:string}
export interface RecordingProvider {
 id:string;version:string;authorization?:RecordingAuthorizationPort;
 account(signal?:AbortSignal):Promise<RecordingAccount>;
 discover(account:RecordingAccount,range:{start:string;end:string;cursor?:string},signal:AbortSignal):Promise<{ids:string[];next?:string}>;
 metadata(account:RecordingAccount,id:string,signal:AbortSignal):Promise<RecordingMetadata>;
 transcript(account:RecordingAccount,metadata:RecordingMetadata,signal:AbortSignal):Promise<{rawText:string;transcript:Transcript|null;formatError?:'recording_transcript_format_unsupported'|'recording_timeline_invalid'}>;
 media(account:RecordingAccount,metadata:RecordingMetadata,signal:AbortSignal):Promise<{mimeType:string;bytes:Buffer}>;
 close?():Promise<void>;
}
export type RecordingBindingGrant={signal:AbortSignal;assertCurrent:()=>void};
type Saved={version:1;account?:RecordingAccount;selection:RecordingSelection;epoch:string};
const savedSchema=z.object({version:z.literal(1),account:z.object({id:z.string().min(1).max(1000),name:z.string().max(500).optional(),profile:z.string().max(300).optional()}).strict().optional(),selection:recordingSelectionSchema,epoch:z.string().uuid()}).strict();
const defaults=():RecordingSelection=>({enabled:false,start:new Date(Date.now()-30*86400000).toISOString(),autoSync:true,backupAudio:true});
const phases=['discover','metadata','transcript','media'] as const;
type Phase=typeof phases[number];

/** Shared durable synchronization. Providers supply transport and decoding;
 * receipts, publication, recovery and cancellation remain host services. */
class RecordingRuntime {
 private saved:Saved={version:1,selection:defaults(),epoch:randomUUID()};
 private readonly file:PrivateFile<Saved>;
 private readonly execution:RecordingContext['engine'];
 private disposers:(()=>Promise<void>)[]=[];
 private timer?:ReturnType<typeof setInterval>;
 private initialized=false;private syncIntervalMs?:number;
 private closed=false;private closePromise?:Promise<void>;private tasks=new Set<Promise<unknown>>();
 private error?:string;private bindingRevision=0;private bindingController=new AbortController();private bindingMutations:Promise<unknown>=Promise.resolve();
 constructor(private ctx:RecordingContext,readonly provider:RecordingProvider){
  this.file=new PrivateFile(ctx.directory,`${provider.id}-recordings.json`);
  this.execution=ctx.engine;
 }
 private sourceId(){return this.saved.account?`${this.provider.id}-recordings-${hash(this.saved.account.id).slice(0,24)}`:undefined;}
 private kind(phase:Phase){return `recording.${this.provider.id}.${phase}`;}
 private valid(step:ExecutionStep){return !this.closed&&this.saved.selection.enabled&&step.input.epoch===this.saved.epoch&&step.input.providerVersion===this.provider.version&&
  step.input.account===hash(this.saved.account?.id)&&Boolean(this.sourceId()&&this.ctx.sources.getSource(this.sourceId()!).enabled);}
 private authorize(step:ExecutionStep,grant:ExecutionGrant){if(this.closed)throw new ExecutionFailure('stale','recording_binding_changed');grant.assert();if(!this.valid(step))throw new ExecutionFailure('stale','recording_binding_changed');}
 async init(){
  if(this.closed)throw new ConnectorError('connector_closed',503);
  const value=await this.file.read();if(this.closed)throw new ConnectorError('connector_closed',503);if(value)this.saved=savedSchema.parse(value);
  if(this.saved.account)this.registerSource();
  for(const phase of phases)this.disposers.push(this.execution.register({kind:this.kind(phase),pool:`recording.${phase}`,concurrency:()=>phase==='media'?1:2,
   policy:EXECUTION_POLICIES.networkAcquisition,timeoutMs:null,
   validate:step=>this.valid(step),resourceKeys:step=>[`recording:${this.provider.id}:${step.input.account}:${step.input.id??'discovery'}:${phase}`],
   execute:(step,signal,grant)=>{
    const task=(async()=>{
     const started=Date.now();this.observe(phase,'started',step);
     try{signal.throwIfAborted();this.authorize(step,grant);const current=await this.provider.account(signal);signal.throwIfAborted();this.authorize(step,grant);if(current.id!==this.saved.account!.id)throw new ExecutionFailure('blocked','recording_account_changed');
      const result=await this.execute(phase,step,signal,grant);this.observe(phase,'completed',step,{durationMs:Date.now()-started});return result;
     }catch(e){this.observe(phase,'failed',step,{durationMs:Date.now()-started});throw e;}
    })();
    this.tasks.add(task);void task.finally(()=>this.tasks.delete(task)).catch(()=>{});return task;
   },commit:(step,result)=>this.commit(phase,step,result),
   // Vendor throttling uses the existing finite acquisition budget. Keep its
   // code distinct from the engine's unbounded capacity-admission waits.
   classify:error=>error instanceof ExecutionFailure?error:error instanceof z.ZodError?new ExecutionFailure('permanent','recording_contract_invalid'):error instanceof StoreError&&[400,409,410,413].includes(error.statusCode)?new ExecutionFailure('blocked','recording_archive_rejected'):error instanceof ConnectorError&&error.code==='lark_rate_limited'?new ExecutionFailure('transient','recording_rate_limited',60000):error instanceof ConnectorError&&['lark_operation_timeout','dingtalk_operation_timeout'].includes(error.code)?new ExecutionFailure('transient','provider_timeout'):error instanceof ConnectorError&&error.code==='recording_transcript_not_ready'?new ExecutionFailure('transient','recording_transcript_not_ready'):error instanceof ConnectorError&&['lark_permission_required','lark_not_connected','lark_not_configured','lark_cli_missing','dingtalk_cli_missing','dingtalk_not_connected','dingtalk_permission_required'].includes(error.code)?new ExecutionFailure('blocked','recording_authorization_required'):
    new ExecutionFailure('permanent','recording_provider_failed'),
  }));
  this.initialized=true;this.configureSyncInterval(this.ctx.syncIntervalMs??300000);
  void this.execution.tick();
 }
 configureSyncInterval(intervalMs:number){
  // This wake also drives durable retries; retain the existing five-minute ceiling.
  const interval=Math.max(1000,Math.min(intervalMs,300000));
  if(this.timer&&this.syncIntervalMs===interval)return;
  if(this.timer)clearInterval(this.timer);this.timer=undefined;this.syncIntervalMs=interval;
  if(!this.initialized||this.closed)return;
  this.timer=setInterval(()=>{void this.tick().catch(()=>{this.error='recording_sync_failed';});},interval);this.timer.unref();
 }
 private observe(phase:Phase|'decode'|'publish',state:'started'|'completed'|'failed',step:ExecutionStep,extra:{count?:number;bytes?:number;durationMs?:number}={}){
  this.ctx.diagnostics?.record(`source.${state}`,{operation:`recording_${phase}`,attempt:step.attempts,...extra},state==='failed'?'warn':'info');
 }
 private registerSource(enable?:boolean){const id=this.sourceId()!;this.ctx.sources.register({id,name:`${this.provider.id} recordings`,kind:`${this.provider.id}.recordings`,deviceId:id,platform:'import',retention:'archive',enabled:enable??this.saved.selection.enabled});if(enable!==undefined)this.ctx.sources.update(id,{enabled:enable});this.ctx.configureDefaults(id,enable);}

 private serialBinding<T>(work:()=>Promise<T>):Promise<T>{const pending=this.bindingMutations.catch(()=>{}).then(work);this.bindingMutations=pending;return pending;}
 private bindingGrant(external?:RecordingBindingGrant){const revision=this.bindingRevision;return ()=>{if(this.closed||revision!==this.bindingRevision)throw new ConnectorError('recording_binding_changed',409);external?.signal.throwIfAborted();external?.assertCurrent();};}
 private async saveBinding(next:Saved,assertCurrent:()=>void){
  const prior=this.saved,revision=this.bindingRevision;assertCurrent();
  try{await this.file.write(next);assertCurrent();const priorSource=this.sourceId();if(priorSource)this.ctx.sources.update(priorSource,{enabled:false});this.saved=next;if(next.account)this.registerSource(next.selection.enabled);}
  catch(error){const failedSource=this.sourceId();this.saved=prior;if(failedSource)try{this.ctx.sources.update(failedSource,{enabled:false});}catch{}const priorSource=this.sourceId();if(priorSource)this.ctx.sources.update(priorSource,{enabled:false});
   try{await this.file.write(prior);}catch{this.closed=true;this.bindingController.abort();this.cancel();await this.file.clear();throw new ConnectorError('recording_binding_write_failed',503);}
   if(!this.closed&&revision===this.bindingRevision&&priorSource)this.ctx.sources.update(priorSource,{enabled:prior.selection.enabled});throw error;
  }
 }

 connect(grant?:RecordingBindingGrant){const assertCurrent=this.bindingGrant(grant),signal=grant?AbortSignal.any([grant.signal,this.bindingController.signal]):this.bindingController.signal;return this.serialBinding(async()=>{assertCurrent();const account=await this.provider.account(signal);assertCurrent();
  this.cancel();const changed=this.saved.account?.id!==account.id;
  await this.saveBinding({...this.saved,account,selection:{...this.saved.selection,...(changed?{enabled:false}:{})},epoch:randomUUID()},assertCurrent);assertCurrent();this.error=undefined;return this.status();});}
 select(raw:unknown){const selection=recordingSelectionSchema.parse(raw),assertCurrent=this.bindingGrant();return this.serialBinding(async()=>{assertCurrent();if(!this.saved.account)throw new ConnectorError('recording_not_connected');
  if(Math.ceil((Date.parse(selection.end??new Date().toISOString())-Date.parse(selection.start))/(27*86400000))>240)throw new ConnectorError('recording_range_limit');
  this.cancel();await this.saveBinding({...this.saved,selection,epoch:randomUUID()},assertCurrent);if(selection.enabled)this.sync();return this.status();});}
 private cancel(){for(const phase of phases)this.execution.cancelKind(this.kind(phase));}
 retireAuthorization(grant:RecordingBindingGrant){this.bindingRevision++;this.bindingController.abort();this.bindingController=new AbortController();this.cancel();const assertCurrent=this.bindingGrant(grant);return this.serialBinding(async()=>{assertCurrent();await this.saveBinding({...this.saved,selection:{...this.saved.selection,enabled:false},epoch:randomUUID()},assertCurrent);});}
 disconnect(){this.bindingRevision++;this.bindingController.abort();this.bindingController=new AbortController();this.cancel();const assertCurrent=this.bindingGrant();return this.serialBinding(async()=>{assertCurrent();await this.saveBinding({...this.saved,account:undefined,selection:{...this.saved.selection,enabled:false},epoch:randomUUID()},assertCurrent);return this.status();});}
 private enqueue(phase:Phase,operationId:string,input:Record<string,unknown>){const bound={...input,epoch:this.saved.epoch,account:hash(this.saved.account!.id),providerVersion:this.provider.version};
  // A failed media backup is one durable work item across discovery rounds.
  // Do not multiply blocked downloads or reset their retry budget every poll.
  if(phase==='media'){
   // Reuse earlier transcript-dependent receipts too; upgrading must not multiply failed backups.
   const prior=this.ctx.work.mediaAttempt(this.kind(phase),bound.epoch,bound.account,bound.providerVersion,String(input.id));
   if(prior)return this.execution.get(prior);
  }
  if(phase==='transcript'){
   const prior=this.ctx.work.transcriptAttempt(this.kind(phase),bound.epoch,String(input.id));
   if(prior)return this.execution.get(prior);
  }
  return this.execution.enqueue(operationId,this.kind(phase),bound,phase==='media'?{id:hash([this.kind(phase),bound])}:{});}
 sync(full=true){if(this.closed)throw new ConnectorError('connector_closed',503);if(!this.saved.account||!this.saved.selection.enabled)throw new ConnectorError('recording_not_connected');
  const existing=this.ctx.work.activeDiscovery(this.kind('discover'),this.saved.epoch);if(existing)return this.status();
  const end=this.saved.selection.end??new Date().toISOString();const cursor=this.ctx.state.cursor(this.sourceId()!,this.saved.epoch);
  const isFull=full||!cursor||Date.now()-Number(cursor.full_at)>86400000;
  const start=isFull?this.saved.selection.start:new Date(Math.max(Date.parse(this.saved.selection.start),Date.parse(String(cursor!.scanned_until))-7*86400000)).toISOString();
  if(Math.max(1,Math.ceil((Date.parse(end)-Date.parse(start))/(27*86400000)))>240)throw new ConnectorError('recording_range_limit');
  const operation='recording-sync:'+randomUUID();
  // Search APIs have bounded windows. Persist every window before starting IO.
  let from=Date.parse(start);const until=Date.parse(end);let windows=0;
  while(from<=until){if(++windows>240)throw new ConnectorError('recording_range_limit');const to=Math.min(until,from+27*86400000);
   this.enqueue('discover',operation,{start:new Date(from).toISOString(),end:new Date(to).toISOString(),page:0,runEnd:end,runFull:isFull});if(to===until)break;from=to;}
  void this.execution.tick();return this.status();
 }
 async tick(){if(this.closed)return;if(this.saved.account&&this.saved.selection.enabled&&this.saved.selection.autoSync){try{this.sync(false);}catch{this.error='recording_sync_failed';}}await this.execution.tick();}
 async drain(){for(let n=0;n<100;n++){if(this.closed)return;const steps=this.ctx.work.dueSteps(phases.map(p=>this.kind(p)),Date.now());if(!steps.length)return;await this.execution.drain(steps);}}
 private async execute(phase:Phase,step:ExecutionStep,signal:AbortSignal,grant:ExecutionGrant):Promise<unknown>{
  const account=this.saved.account!,input=step.input,sourceId=this.sourceId()!,authorize=()=>{signal.throwIfAborted();this.authorize(step,grant);};
  if(phase==='discover'){const page=await this.provider.discover(account,{start:String(input.start),end:String(input.end),...(input.cursor?{cursor:String(input.cursor)}:{})},signal);authorize();
   if(page.ids.length>100||Number(input.page)>10000||page.next&&(page.next===input.cursor||this.ctx.work.hasPage(step.operationId,this.kind('discover'),String(input.start),page.next)))throw new ExecutionFailure('permanent','recording_pagination_invalid');
   this.observe(phase,'completed',step,{count:page.ids.length});return page;}
  const id=String(input.id);
  if(phase==='metadata'){const metadata=await this.provider.metadata(account,id,signal);authorize();if(metadata.id!==id||!Number.isFinite(metadata.durationMs)||metadata.durationMs<0)throw new ExecutionFailure('permanent','recording_identity_invalid');return metadata;}
  const metadata=input.metadata as unknown as RecordingMetadata;
  if(phase==='transcript'){
   const result=await this.provider.transcript(account,metadata,signal);authorize();if((await this.provider.account(signal)).id!==account.id)throw new ExecutionFailure('blocked','recording_account_changed');authorize();this.observe('decode','completed',step,{count:result.transcript?.segments.length??0});
   if(this.ctx.state.forgotten(sourceId,id))throw new ExecutionFailure('stale','recording_evidence_changed');
   if(!result.transcript||result.formatError){
    const requireAllowed=()=>{authorize();if(this.ctx.state.forgotten(sourceId,id))throw new ExecutionFailure('stale','recording_evidence_changed');};
    // Preserve the export without creating full-text evidence or a Memory input.
    const bytes=Buffer.from(result.rawText),file=this.ctx.archives.putParts({name:`recording-export-${hash([sourceId,id])}.txt`,mimeType:'text/plain'},[bytes],bytes.length,requireAllowed);
    if(result.formatError){grant.commit(()=>this.ctx.state.exportReceipt(sourceId,id,file.id,metadata,new Date().toISOString(),'unsupported'));throw new ExecutionFailure('permanent',result.formatError);}
    return {id,empty:true,fileId:file.id,metadata,observedAt:new Date().toISOString()};
   }
   if(!this.ctx.files)throw new ExecutionFailure('blocked','recording_storage_unavailable');
   // The owner's corpus-date policy accepts source creation time as an authored
   // time anchor. It does not assign the described events an occurrence date.
   const corpusTime=metadata.recordedAt??metadata.createdAt;
   const ack=await this.ctx.files.transcriptRevision(sourceId,{externalId:id,kind:'file',title:metadata.title,observedAt:new Date().toISOString(),deleted:false,
    ...(metadata.uri?{uri:metadata.uri}:{}),document:{contentRole:'transcript',...(corpusTime?{recordedAt:corpusTime,timeBasis:'recorded'}:{timeBasis:'unknown'})}},result.rawText,result.transcript,authorize);authorize();
   this.observe('publish','completed',step,{count:ack.duplicate?0:1});
   const prior=this.ctx.state.media(sourceId,id);
   if(prior)grant.commit(()=>this.ctx.archives.attach(ack.id,[prior]));
   return {captureId:ack.id,id};
  }
  // Media owns its durable receipt before any transcript exists. Both paths recheck deletion and grants.
  const requireAllowed=()=>{authorize();if(this.ctx.state.forgotten(sourceId,id))throw new ExecutionFailure('stale','recording_evidence_changed');};
  requireAllowed();
  const existing=this.ctx.state.media(sourceId,id);
  if(existing)return {fileId:existing,id};
  const media=await this.provider.media(account,metadata,signal);authorize();if((await this.provider.account(signal)).id!==account.id)throw new ExecutionFailure('blocked','recording_account_changed');authorize();
  const file=this.ctx.archives.putRecordingMedia({name:`recording-${hash([sourceId,id])}.${({'audio/wav':'wav','audio/mp4':'m4a','audio/mpeg':'mp3','audio/flac':'flac','audio/ogg':'ogg'} as Record<string,string>)[media.mimeType]??'audio'}`,mimeType:media.mimeType,bytes:media.bytes},requireAllowed);
  this.observe(phase,'completed',step,{bytes:media.bytes.length});return {fileId:file.id,id};
 }
 private commit(phase:Phase,step:ExecutionStep,result:unknown){const value=result as any;
  if(phase==='transcript'){
   if(this.ctx.state.forgotten(this.sourceId()!,value.id))throw new ExecutionFailure('stale','recording_evidence_changed');
   if(value.empty)this.ctx.state.exportReceipt(this.sourceId()!,value.id,value.fileId,value.metadata,value.observedAt,'empty');
   else this.ctx.state.dropExport(this.sourceId()!,value.id);
  }else if(phase==='discover'){
   for(const id of new Set<string>(value.ids))this.enqueue('metadata',step.operationId,{id,discovery:step.id});
   if(value.next)this.enqueue('discover',step.operationId,{start:step.input.start,end:step.input.end,cursor:value.next,page:Number(step.input.page)+1,runEnd:step.input.runEnd,runFull:step.input.runFull});
   else {const others=this.ctx.work.remainingDiscovery(step.operationId,this.kind('discover'),step.id);if(others===0)this.ctx.state.advanceCursor(this.sourceId()!,this.saved.epoch,String(step.input.runEnd),step.input.runFull?Date.now():0);}
  }else if(phase==='metadata'){
   const at=value.createdAt??value.recordedAt;if(at&&(Date.parse(at)<Date.parse(this.saved.selection.start)||this.saved.selection.end&&Date.parse(at)>Date.parse(this.saved.selection.end)))return;
   this.enqueue('transcript',step.operationId,{id:step.input.id,metadata:value,discovery:step.input.discovery});
   if(this.saved.selection.backupAudio)this.enqueue('media',step.operationId,{id:step.input.id,metadata:value});
  }else if(phase==='media'){
   if(this.ctx.state.forgotten(this.sourceId()!,value.id))throw new ExecutionFailure('stale','recording_evidence_changed');
   this.ctx.state.publishMedia(this.sourceId()!,value.id,value.fileId);
  }
 }
 status():RecordingStatus {
  const sourceId=this.sourceId(),all=this.steps({limit:100,problemsFirst:true}).items;
  const counts=sourceId?this.ctx.state.counts(sourceId):{transcripts:0,audio:0,empty:0};
  return {provider:this.provider.id,connected:Boolean(this.saved.account),accountName:this.saved.account?.name,sourceId,selection:this.saved.selection,
   steps:all,stepsTotal:this.count(['waiting','running','succeeded','failed','blocked','cancelled','stale']),
   counts:{...counts,pending:this.count(['running','waiting']),failed:this.count(['failed','blocked'])},...(this.error?{error:this.error}:{})};
 }
 steps(args:{cursor?:number;limit?:number;problemsFirst?:boolean}={}){
  const limit=Math.max(1,Math.min(args.limit??50,100));
  const rows=this.ctx.work.steps(phases.map(p=>this.kind(p)),this.saved.epoch,{...args,limit});
  return {items:rows.slice(0,limit).map(row=>{const s=this.execution.get(String(row.id))!;return {id:s.id,phase:s.kind.split('.').at(-1)!,state:s.state,attempts:s.attempts,availableAt:s.availableAt,...(s.input.metadata?{title:(s.input.metadata as unknown as RecordingMetadata).title}:{}),...(s.error?{error:s.error}:{})};}),nextCursor:rows.length>limit?Number(rows[limit-1]!.rowid):null};
 }
 items(includeExports=false){
  const sourceId=this.sourceId();if(!sourceId)return {items:[]};
  const archived=this.ctx.archives;
  const rows=this.ctx.state.transcripts(sourceId);
  const full=rows.map(row=>{const item=this.ctx.sources.getItem(sourceId,row.external_id)!;return {id:row.external_id,captureId:row.capture_id,title:item.title,observedAt:item.observedAt,recordedAt:item.document?.recordedAt,...(row.file_id?{audio:archived.get(row.file_id)}:{})};});
  if(!includeExports)return {items:full};
  const empty=this.ctx.state.exports(sourceId).map(row=>{const metadata=JSON.parse(String(row.metadata)) as RecordingMetadata;return {id:String(row.external_id),title:metadata.title,observedAt:String(row.observed_at),recordedAt:metadata.recordedAt,empty:row.state==='empty',unsupported:row.state==='unsupported',export:archived.get(String(row.file_id)),...(row.audio_id?{audio:archived.get(String(row.audio_id))}:{})};});
  return {items:[...empty,...full.filter(item=>!empty.some(receipt=>receipt.id===item.id))].sort((a,b)=>b.observedAt.localeCompare(a.observedAt)).slice(0,30)};
 }
 private count(states:string[]){return this.ctx.work.count(phases.map(p=>this.kind(p)),states,this.saved.epoch);}
 retry(){if(this.closed)throw new ConnectorError('connector_closed',503);const ids=this.ctx.work.retryableSteps(phases.map(p=>this.kind(p)),this.saved.epoch);for(const id of ids)if(this.valid(this.execution.get(id)!))this.execution.retry(id,true);void this.execution.tick();return this.status();}
 close(){
  if(this.closePromise)return this.closePromise;
  this.closed=true;this.closePromise=Promise.resolve().then(()=>this.finishClose());
  this.bindingRevision++;this.bindingController.abort();clearInterval(this.timer);this.timer=undefined;
  return this.closePromise;
 }
 private async finishClose(){
  const errors:unknown[]=[];
  await this.bindingMutations.catch(()=>{});
  const retired=await Promise.allSettled(this.disposers.map(dispose=>Promise.resolve().then(dispose)));
  for(const result of retired)if(result.status==='rejected')errors.push(result.reason);
  // Unregister interrupts logical engine work. Provider resources remain live
  // until the actual issued calls and their callbacks have physically settled.
  await Promise.allSettled([...this.tasks]);
  for(const dispose of [()=>this.ctx.closeEngine(),()=>this.provider.close?.(),()=>this.file.flush()])try{await dispose();}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(errors,'Recording connector cleanup failed');
 }
}

/** The trusted extension composition entry keeps its established constructor
 * and engine API. Processing uses only the projected runtime capabilities. */
export class RecordingConnector extends RecordingRuntime {
 readonly engine:ExecutionEngine;
 constructor(context:ConnectorContext,provider:RecordingProvider){
  const resources=recordingResources(context);
  super(resources.context,provider);
  this.engine=resources.engine;
 }
}
