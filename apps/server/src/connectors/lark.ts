import {moteText} from '../i18n.js';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {FILE_PART_BYTES,calendarEventSchema,centralCalendarPluginCapabilitySchema,isCentralConnectorActionTarget,moteActionMarker,type ActionPluginProvider,type CalendarDraft,type ConnectorActionExecution,type ConnectorActionReceipt,type LarkStatus,type LarkSelection,type LarkJob,type LarkCalendar,type SourceItem,type SourceItemRecord} from '@mote/shared';
import {PrivateFile} from './private-file.js';
import {ConnectorError} from './types.js';
import type {LarkContext} from './lark-context.js';
import {createLarkRunner,larkJson,authorizationUrl,type LarkRunner,type LarkCommand} from './lark-cli.js';
import {LarkDocumentSync,documentSelectionSchema,documentScope,hasDocumentSelection,larkReference} from './lark-documents.js';
import {calendarBoundary} from './google.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export const LARK_SCOPES=['docx:document:readonly','wiki:wiki:readonly','search:docs:read'];
/** Event writes are a separate consent on the same Lark account. A broader
 * calendar grant or the three granular event scopes all satisfy it. */
export const LARK_CALENDAR_WRITE_SCOPES=Object.freeze(['calendar:calendar']);
export function larkCalendarWriteScopesOk(values:readonly string[]):boolean{
 const granted=new Set(values);
 return granted.has('calendar:calendar')||['calendar:calendar.event:create','calendar:calendar.event:update','calendar:calendar.event:delete'].every(scope=>granted.has(scope));
}
const centralCalendarCapability=centralCalendarPluginCapabilitySchema.parse({id:'calendar.manage',version:1,inputSchema:'calendar.event.v1',outputSchema:'calendar.receipt.v1',operations:['calendar.create','calendar.update','calendar.cancel','calendar.complete'],executionLocation:'central-connector',risk:'calendar-write',constraints:{writableCalendar:true,completeEvent:true,currentEvidence:true,unexpiredCreatesAndUpdates:true,noParticipants:true,existingMoteEventsOnly:true,completionInMoteOnly:true}});
const builtinIdentity={packageId:'mote.builtin.lark-calendar',releaseDigest:hash('mote.builtin.lark-calendar@1'),instanceId:'lark-calendar',instanceRevision:1,capabilityDigest:hash(JSON.stringify(centralCalendarCapability))};
function requiredScopeGroups(selection:LarkSelection){
  const groups=[['docx:document:readonly'],['wiki:wiki:readonly']];
  if(selection.documentDiscovery&&(selection.documentDiscovery.created||selection.documentDiscovery.edited||selection.documentDiscovery.opened))groups.push(['search:docs:read']);
  // Native folder listing accepts these alternatives. Request only the modern
  // read-only grant; an existing legacy or broader grant remains sufficient.
  if(selection.folders?.length)groups.push(['space:document:retrieve','drive:drive:readonly','drive:drive']);
  if(selection.calendarIds.length)groups.push(['calendar:calendar:readonly']);
  return groups;
}
function requiredScopes(selection:LarkSelection){return requiredScopeGroups(selection).map(group=>group[0]);}
function missingScopes(selection:LarkSelection,granted:ReadonlySet<string>){return requiredScopeGroups(selection).filter(group=>!group.some(scope=>granted.has(scope))).map(group=>group[0]);}
const now=()=>new Date().toISOString();
export const documentReference=(value:string)=>larkReference(value);
const selectionSchema=z.object({...documentSelectionSchema,calendarIds:z.array(z.string().min(1).max(1000)).max(10),pastDays:z.number().int().min(0).max(180),futureDays:z.number().int().min(1).max(180),timeZone:z.string().max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}}),autoSync:z.boolean()}).strict();
const defaults=():LarkSelection=>({documents:[],calendarIds:[],pastDays:30,futureDays:90,timeZone:'Asia/Shanghai',autoSync:true,documentDiscovery:{created:true,edited:true,opened:true,firstSyncDays:30}});
const savedSchema=z.object({version:z.literal(1),enabled:z.boolean(),selectionAuthorized:z.boolean().optional(),calendarWriteAuthorized:z.boolean().optional(),account:z.string().optional(),selection:selectionSchema,lastSyncAt:z.string().datetime().optional()}).strict();
type Saved=z.infer<typeof savedSchema>;
const eventSchema=z.object({event_id:z.string().min(1).max(1000),summary:z.string().max(2000).optional(),description:z.string().max(90000).optional(),status:z.string().optional(),start_time:z.object({timestamp:z.string().optional(),date:z.string().optional(),timezone:z.string().optional()}).optional(),end_time:z.object({timestamp:z.string().optional(),date:z.string().optional(),timezone:z.string().optional()}).optional(),location:z.object({name:z.string().optional()}).optional()});
function revision(item:Omit<SourceItem,'revision'>,prior?:SourceItemRecord):SourceItem{
  const {observedAt,...content}=item;
  const next=hash(JSON.stringify(content));
  // Include the previous revision when content returns to an earlier state (A -> B -> A).
  const old=prior?JSON.stringify({externalId:prior.externalId,title:prior.title,text:prior.text,kind:prior.kind,layer:prior.layer,deleted:prior.deleted,calendar:prior.calendar,document:prior.document,uri:prior.uri,mimeType:prior.mimeType}):'';
  const current=JSON.stringify({externalId:item.externalId,title:item.title,text:item.text,kind:item.kind,layer:item.layer,deleted:item.deleted,calendar:item.calendar,document:item.document,uri:item.uri,mimeType:item.mimeType});
  return {...item,revision:old===current?prior!.revision:hash(`${next}:${prior?.revision??''}`)};
}
export function larkEvent(raw:unknown,timeZone:string,prior?:SourceItemRecord):SourceItem{
  const e=eventSchema.parse(raw),deleted=e.status==='cancelled';
  const boundary=(t:typeof e.start_time)=>{if(t?.timestamp&&/^\d{1,12}$/.test(t.timestamp))return new Date(Number(t.timestamp)*1000).toISOString();if(t?.date)return calendarBoundary(t.date,t.timezone||timeZone);throw new ConnectorError('lark_event_time_invalid',502);};
  const calendar=deleted?prior?.calendar?{...prior.calendar,status:'cancelled' as const}:undefined:{start:boundary(e.start_time),end:boundary(e.end_time),allDay:Boolean(e.start_time?.date),timeZone:e.start_time?.timezone||timeZone,status:'confirmed' as const};
  return revision({externalId:e.event_id,observedAt:now(),title:e.summary??prior?.title??'',text:deleted?'':[e.summary,e.description,e.location?.name].filter(Boolean).join('\n\n'),kind:'calendar',layer:'snapshot',deleted,...(calendar?{calendar}:{})},prior);
}

export class LarkConnector{
  private saved:Saved={version:1,enabled:false,selection:defaults()};
  private file:PrivateFile<Saved>;
  private runner:LarkRunner;
  private snapshot:Pick<LarkStatus,'installed'|'configured'|'connected'|'missingScopes'|'accountName'|'version'|'error'>={installed:false,configured:false,connected:false,missingScopes:[]};
  private account?:string;
  private grantedScopes=new Set<string>();
  private job?:LarkJob;
  private active?:Promise<void>;
  private controller?:AbortController;
  private timer?:ReturnType<typeof setInterval>;
  private initialized=false;private syncIntervalMs?:number;
  private checking?:Promise<LarkStatus>;
  private closed=false;
  private disconnecting=false;
  private reading?:Promise<{calendars:LarkCalendar[]}>;
  private readController?:AbortController;
  constructor(private ctx:LarkContext,runner?:LarkRunner){const dir=ctx.directory;this.file=new PrivateFile(dir,'lark.json');this.runner=runner??createLarkRunner(dir);}
  async init(){const saved=await this.file.read();if(saved)this.saved=savedSchema.parse(saved);this.initialized=true;this.configureSyncInterval(this.ctx.syncIntervalMs??900000);}
  configureSyncInterval(intervalMs:number){
    const interval=Math.max(60000,intervalMs);
    if(this.timer&&this.syncIntervalMs===interval)return;
    if(this.timer)clearInterval(this.timer);this.timer=undefined;this.syncIntervalMs=interval;
    if(!this.initialized||this.closed)return;
    this.timer=setInterval(()=>{if(this.saved.enabled&&this.saved.selection.autoSync&&this.selectionAuthorized()&&!this.active&&!this.closed)try{this.startSync(undefined,true);}catch{}},interval);this.timer.unref();
  }
  status():LarkStatus{return {...this.snapshot,connected:this.snapshot.connected&&this.saved.enabled,calendarWriteAuthorized:this.saved.enabled&&this.saved.calendarWriteAuthorized===true,selection:structuredClone(this.saved.selection),syncIntervalSeconds:Math.floor((this.syncIntervalMs??900000)/1000),...(this.saved.account&&hasDocumentSelection(this.saved.selection)?{documentSync:this.documents().status()}:{}),...(this.job?{job:{...this.job}}:{}),...(this.saved.lastSyncAt?{lastSyncAt:this.saved.lastSyncAt}:{})};}
  async refresh(){
    if(this.closed)throw new ConnectorError('connector_closed',503);
    if(this.active||this.reading||this.disconnecting)return this.status();
    return this.checking??=this.probe().finally(()=>{this.checking=undefined;});
  }
  private async probe():Promise<LarkStatus>{
    try{const version=await this.runner({kind:'version'});const match=version.match(/\b(\d+\.\d+\.\d+)\b/);this.snapshot={installed:true,version:match?.[1],configured:false,connected:false,missingScopes:[]};}
    catch(e){this.snapshot={installed:false,configured:false,connected:false,missingScopes:[],error:this.code(e)};return this.status();}
    try{
      const data=larkJson(await this.runner({kind:'status'})),user=data.identities?.user;
      this.snapshot.configured=typeof data.appId==='string'&&data.appId.length>0;
      const granted=new Set<string>(typeof user?.scope==='string'?user.scope.split(/\s+/):[]);this.grantedScopes=granted;
      // A live provider check may withdraw Mote's stored write authorization,
      // but it never turns an ordinary read login into write authorization.
      if(this.saved.calendarWriteAuthorized===true&&!larkCalendarWriteScopesOk([...granted])){this.saved={...this.saved,calendarWriteAuthorized:false};await this.file.write(this.saved);}
      this.snapshot.missingScopes=missingScopes(this.saved.selection,granted);
      this.snapshot.connected=user?.available===true&&typeof user?.openId==='string';
      this.snapshot.accountName=typeof user?.userName==='string'?user.userName.slice(0,200):undefined;
      this.account=this.snapshot.connected?hash(`${data.appId}:${user.openId}`):undefined;
      if(this.saved.account&&this.account&&this.saved.account!==this.account){await this.pauseSources();this.saved={version:1,enabled:false,selection:defaults()};await this.file.write(this.saved);this.snapshot.error='lark_account_changed';}
    }catch(e){this.snapshot.error=this.code(e);this.account=undefined;}
    return this.status();
  }
  private code(error:unknown){return error instanceof ConnectorError?error.code:error instanceof z.ZodError?'lark_response_invalid':'lark_operation_failed';}
  private assertIdle(){if(this.closed)throw new ConnectorError('connector_closed',503);if(this.active||this.checking||this.reading||this.disconnecting)throw new ConnectorError('lark_busy',409);}
  private start(kind:LarkJob['kind'],work:(signal:AbortSignal,job:LarkJob)=>Promise<void>,documentsOnly=false):LarkJob{
    this.assertIdle();const job:LarkJob={id:randomUUID(),kind,state:'running'};this.job=job;const controller=new AbortController();this.controller=controller;
    this.active=Promise.resolve().then(()=>work(controller.signal,job)).then(()=>{job.state='completed';delete this.snapshot.error;}).catch(e=>{job.state=controller.signal.aborted?'cancelled':'failed';job.error=this.code(e);this.snapshot.error=job.error;if(kind==='sync')this.reportSources('error',job.error,documentsOnly);}).finally(()=>{delete job.authorizationUrl;delete job.expiresAt;this.active=undefined;this.controller=undefined;});
    return {...job};
  }
  private async run(command:LarkCommand,signal:AbortSignal){if(signal.aborted)throw new ConnectorError('lark_operation_cancelled',409);return this.runner(command,{signal});}
  startInstall(){return this.start('install',async signal=>{await this.run({kind:'install'},signal);await this.probe();if(!this.snapshot.installed)throw new ConnectorError('lark_cli_missing',503);});}
  startSetup(){return this.start('setup',async(signal,job)=>{
    await this.disable();let buffer='';
    await this.runner({kind:'setup'},{signal,onOutput:chunk=>{buffer=(buffer+chunk).slice(-20000);for(const line of buffer.split(/\r?\n/).slice(0,-1)){const url=line.trim();if(authorizationUrl(url)){job.authorizationUrl=url;job.expiresAt=new Date(Date.now()+600000).toISOString();job.state='waiting';}}}});
    await this.probe();if(!this.snapshot.configured)throw new ConnectorError('lark_not_configured',409);
  });}
  configure(raw:unknown){const input=z.object({appId:z.string().regex(/^cli_[A-Za-z0-9]+$/).max(100),secret:z.string().min(1).max(1000).refine(v=>!/[\r\n\0]/.test(v)),brand:z.enum(['feishu','lark'])}).strict().parse(raw);return this.start('configure',async signal=>{await this.disable();await this.run({kind:'configure',...input},signal);await this.probe();if(!this.snapshot.configured)throw new ConnectorError('lark_not_configured',409);});}
  login(calendar=false){return this.start('login',async(signal,job)=>{
    const priorEnabled=new Map(this.ctx.sources.listSources().map(source=>[source.id,source.enabled]));
    await this.disable();
    // Preserve write scopes already granted to this same account; a read
    // reauthorization must not silently drop them, but it never adds them and
    // never broadens the ordinary document/calendar read request.
    const preservedWrite=[...this.grantedScopes].filter(scope=>scope==='calendar:calendar'||scope.startsWith('calendar:calendar.event:'));
    const requested=[...new Set([...preservedWrite,...requiredScopes(this.saved.selection),...(calendar?['calendar:calendar:readonly']:[])])];
    await this.authorizeDevice(requested,signal,job);
    await this.probe();if(signal.aborted)throw new ConnectorError('lark_operation_cancelled',409);if(!this.snapshot.connected||!this.account)throw new ConnectorError('lark_login_incomplete',409);
    if(this.snapshot.missingScopes.length||calendar&&!this.grantedScopes.has('calendar:calendar:readonly'))throw new ConnectorError('lark_permission_required',403);
    const next={...this.saved,enabled:true,account:this.account};await this.file.write(next);this.saved=next;for(const [id,enabled] of priorEnabled)if(enabled&&(id===this.sourceId('docs')||this.saved.selection.calendarIds.some(calendar=>id===this.sourceId('calendar',calendar))))this.ctx.sources.update(id,{enabled:true});
  });}
  /** Separate write consent on the existing account. Read sources, selection
   * and archived material stay untouched. */
  startWriteAuthorization(){return this.start('login',async(signal,job)=>{
    const current=await this.probe();
    if(!current.connected||!this.saved.enabled||!this.account)throw new ConnectorError('lark_not_connected',401);
    const requested=[...new Set([...this.grantedScopes,...LARK_CALENDAR_WRITE_SCOPES])];
    await this.authorizeDevice(requested,signal,job);
    await this.probe();if(signal.aborted)throw new ConnectorError('lark_operation_cancelled',409);
    if(!this.snapshot.connected||!this.account)throw new ConnectorError('lark_login_incomplete',409);
    if(!larkCalendarWriteScopesOk([...this.grantedScopes]))throw new ConnectorError('lark_calendar_write_permission_required',403);
    const next={...this.saved,calendarWriteAuthorized:true};await this.file.write(next);this.saved=next;
  });}
  private async authorizeDevice(scopes:string[],signal:AbortSignal,job:LarkJob){
    const raw=larkJson(await this.run({kind:'login',scopes},signal));
    const data=z.object({verification_url:z.string().max(8000),device_code:z.string().min(1).max(4000),expires_in:z.number().positive().max(600)}).parse(raw);
    const url=authorizationUrl(data.verification_url);if(!url)throw new ConnectorError('lark_authorization_url_invalid',502);
    job.authorizationUrl=url;job.expiresAt=new Date(Date.now()+data.expires_in*1000).toISOString();job.state='waiting';
    const expires=AbortSignal.timeout(data.expires_in*1000);
    try{await this.run({kind:'complete',deviceCode:data.device_code},AbortSignal.any([signal,expires]));}catch(e){if(expires.aborted&&!signal.aborted)throw new ConnectorError('lark_authorization_expired',409);throw e;}
  }
  async cancel(){this.controller?.abort();await this.active;return this.status();}
  private sourceId(kind:'docs'|'calendar',id=''){return `lark-${kind}-${hash(`${this.saved.account}:${id}`).slice(0,24)}`;}
  private async pauseSources(){if(!this.saved.account)return;for(const id of [this.sourceId('docs'),...this.saved.selection.calendarIds.map(id=>this.sourceId('calendar',id))]){try{this.ctx.sources.update(id,{enabled:false});}catch{}}}
  private async disable(){await this.pauseSources();this.saved={...this.saved,enabled:false};await this.file.write(this.saved);}
  async disconnect(){if(this.disconnecting)throw new ConnectorError('lark_busy',409);this.disconnecting=true;try{this.readController?.abort();await this.reading?.catch(()=>{});await this.checking;await this.cancel();await this.disable();const next={...this.saved,calendarWriteAuthorized:false};await this.file.write(next);this.saved=next;return this.status();}finally{this.disconnecting=false;}}
  private async requireConnected(){await this.probe();if(!this.snapshot.connected||!this.saved.enabled||!this.account||this.account!==this.saved.account)throw new ConnectorError('lark_not_connected',409);}
  private async listCalendars(signal?:AbortSignal):Promise<LarkCalendar[]>{
    let token:string|undefined;const all:LarkCalendar[]=[];const seen=new Set<string>();
    for(let page=0;page<30;page++){
      const envelope=larkJson(await this.runner({kind:'calendars',pageToken:token},{signal}));
      const data=z.object({calendar_list:z.array(z.object({calendar_id:z.string().min(1),summary:z.string().optional(),type:z.string().optional(),role:z.string().optional(),is_deleted:z.boolean().optional()})),has_more:z.boolean(),page_token:z.string().optional()}).parse(envelope.data??envelope);
      all.push(...data.calendar_list.filter(c=>!c.is_deleted&&['reader','writer','owner'].includes(c.role??'')).map(c=>({id:c.calendar_id,name:c.summary??c.calendar_id,primary:c.type==='primary'})));
      if(!data.has_more)return all;
      if(!data.page_token||seen.has(data.page_token))throw new ConnectorError('lark_pagination_invalid',502);token=data.page_token;seen.add(token);
    }throw new ConnectorError('lark_calendar_limit',413);
  }
  async calendars(){this.assertIdle();const controller=new AbortController();this.readController=controller;this.reading=(async()=>{await this.requireConnected();return {calendars:await this.listCalendars(controller.signal)};})();try{return await this.reading;}finally{this.reading=undefined;this.readController=undefined;}}
  async select(raw:unknown){
    this.assertIdle();const input=selectionSchema.parse(raw);input.documents=[...new Set(input.documents)];input.calendarIds=[...new Set(input.calendarIds)];
    // Lock mutations through the same job gate, including validation reads.
    this.start('selection',async signal=>{
      await this.requireConnected();if(input.calendarIds.length){const allowed=new Set((await this.listCalendars(signal)).map(c=>c.id));if(input.calendarIds.some(id=>!allowed.has(id)))throw new ConnectorError('lark_calendar_not_available',400);}
      if(signal.aborted)throw new ConnectorError('lark_operation_cancelled',409);const previous=[...(hasDocumentSelection(this.saved.selection)?[this.sourceId('docs')]:[]),...this.saved.selection.calendarIds.map(id=>this.sourceId('calendar',id))];const next={...this.saved,selection:input,selectionAuthorized:true};await this.file.write(next);this.saved=next;this.snapshot.missingScopes=missingScopes(input,this.grantedScopes);this.registerSources();const retained=new Set([...(hasDocumentSelection(input)?[this.sourceId('docs')]:[]),...input.calendarIds.map(id=>this.sourceId('calendar',id))]);for(const id of previous)if(!retained.has(id)&&this.ctx.read.sourceExists(id))this.ctx.sources.update(id,{enabled:false});
    });
    await this.active;if(this.job?.state==='failed'||this.job?.state==='cancelled')throw new ConnectorError(this.job.error??'lark_operation_failed',400);return this.status();
  }
  private selectionAuthorized(){return this.saved.selectionAuthorized===true||this.saved.selection.documents.length>0||this.saved.selection.calendarIds.length>0;}
  private registerSources(){
    const add=(id:string,name:string,kind:'lark-docs'|'lark-calendar')=>{this.ctx.sources.register({id,name,kind,deviceId:'lark-server',platform:'import',retention:kind==='lark-docs'?'archive':'snapshot'});};
    if(hasDocumentSelection(this.saved.selection))add(this.sourceId('docs'),'飞书文档','lark-docs');
    for(const id of this.saved.selection.calendarIds)add(this.sourceId('calendar',id),`飞书日历 · ${id.slice(0,80)}`,'lark-calendar');
  }
  private reportSources(state:'syncing'|'error',code?:string,documentsOnly=false){if(!this.saved.account)return;for(const source of this.ctx.sources.listSources()){if(source.enabled&&(state!=='error'||source.status?.state==='syncing')&&(source.id===this.sourceId('docs')||!documentsOnly&&this.saved.selection.calendarIds.some(id=>source.id===this.sourceId('calendar',id))))this.ctx.sources.reportStatus(source.id,{state,...(code?{code}:{})});}}
  private documents(signal?:AbortSignal){
    const account=this.saved.account??'',selection=structuredClone(this.saved.selection),scope=documentScope(selection),sourceId=this.sourceId('docs');
    const authorize=()=>{if(signal?.aborted)throw new ConnectorError('lark_operation_cancelled',409);if(!this.saved.enabled||this.saved.account!==account||documentScope(this.saved.selection)!==scope)throw new ConnectorError('lark_document_scope_changed',409);if(!this.ctx.sources.getSource(sourceId).enabled)throw new ConnectorError('lark_source_paused',409);};
    return new LarkDocumentSync({documentState:this.ctx.documentState,sources:{getItem:this.ctx.sources.getItem}},account,sourceId,selection,command=>this.run(command,signal??new AbortController().signal),async()=>{
      authorize();const data=larkJson(await this.run({kind:'status'},signal??new AbortController().signal)),user=data.identities?.user;
      if(user?.available!==true||hash(`${data.appId}:${user.openId}`)!==account)throw new ConnectorError('lark_account_changed',409);
      authorize();
    },authorize);
  }
  startPreview(){return this.start('preview',async(signal,job)=>{
    await this.requireConnected();if(this.snapshot.missingScopes.length)throw new ConnectorError('lark_permission_required',403);this.registerSources();const documents=this.documents(signal);await documents.discover();job.result={imported:0,duplicates:0,discovered:documents.status().previewTotal??0};
  });}
  startSync(reference?:string,automatic=false){return this.start('sync',async(signal,job)=>{
    if(automatic&&(!this.selectionAuthorized()||hasDocumentSelection(this.saved.selection)&&!this.documents(signal).confirmed()&&!this.saved.selection.calendarIds.length))return;
    await this.requireConnected();if(this.snapshot.missingScopes.length)throw new ConnectorError('lark_permission_required',403);this.registerSources();this.reportSources('syncing',undefined,Boolean(reference));const result:NonNullable<LarkJob['result']>={imported:0,duplicates:0};job.result=result;
    const write=async(sourceId:string,item:SourceItem,bytes?:Buffer)=>{
      if(signal.aborted)throw new ConnectorError('lark_operation_cancelled',409);
      const authorize=()=>{if(signal.aborted||!this.saved.enabled||!this.ctx.sources.getSource(sourceId).enabled)throw new ConnectorError('lark_operation_cancelled',409);const documentId=item.document?.activity?.documentId??item.externalId;if(this.ctx.read.forgotten(sourceId,documentId))throw new ConnectorError('lark_document_forgotten',410);};
      let ack:{duplicate:boolean};
      if(bytes){
        if(!this.ctx.files)throw new ConnectorError('lark_file_archive_unavailable',503);if(this.ctx.sources.getSource(sourceId).retention!=='archive')throw new ConnectorError('lark_document_archive_required',409);
        const prior=this.ctx.sources.getItem(sourceId,item.externalId);
        if(prior?.revision===item.revision)ack={duplicate:true};
        else {
          const upload=this.ctx.files.begin({sourceId,previousRevision:prior?.revision??null,item,relativePath:`lark/${hash(item.externalId)}.md`,sizeBytes:bytes.length,sha256:hash(bytes.toString('utf8'))},authorize);
          if(upload.ack)ack=upload.ack;
          else {for(let part=0;part<Math.ceil(bytes.length/FILE_PART_BYTES);part++)this.ctx.files.part(upload.uploadId,part,bytes.subarray(part*FILE_PART_BYTES,Math.min(bytes.length,(part+1)*FILE_PART_BYTES)),authorize);ack=await this.ctx.files.commit(upload.uploadId,authorize,signal);}
        }
      }else ack=await this.ctx.sources.upsert(sourceId,item,authorize);
      result[ack.duplicate?'duplicates':'imported']++;return !ack.duplicate;
    };
    const docSource=this.sourceId('docs');let failure:string|undefined;
    if(hasDocumentSelection(this.saved.selection)&&this.ctx.sources.getSource(docSource).enabled){
      const documents=this.documents(signal);
      // Saving a range enables metadata preview, while the first explicit sync
      // confirms body collection. Timers never bypass that confirmation.
      if(!automatic||documents.confirmed()){
        const first=!documents.confirmed(),hasPreview=Boolean(documents.status().previewAt);if(!automatic)documents.confirm();
        try {if(!reference&&!(first&&hasPreview))await documents.discover();}catch(error){if(signal.aborted)throw error;failure=this.code(error);}
        const summary=await documents.archive((item,bytes)=>write(docSource,item,bytes),reference);
        const documentStatus=documents.status();
        if(this.saved.selection.documentDiscovery||this.saved.selection.folders||this.saved.selection.wikiRoots)Object.assign(result,summary,{discovered:documentStatus.previewTotal??0});
        if(documentStatus.failed)failure='lark_partial_failure';
        this.ctx.sources.reportStatus(docSource,{state:failure?'error':'idle',...(failure?{code:failure}:{lastSyncAt:now()})});
      }else this.ctx.sources.reportStatus(docSource,{state:'idle'});
    }
    const {pastDays,futureDays,timeZone}=this.saved.selection;
    const start=Math.floor(Date.now()/1000)-pastDays*86400,end=Math.floor(Date.now()/1000)+futureDays*86400;
    for(const calendarId of reference?[]:this.saved.selection.calendarIds){
      const sourceId=this.sourceId('calendar',calendarId);if(!this.ctx.sources.getSource(sourceId).enabled)continue;
      try{const events=new Map<string,unknown>();
        for(let from=start;from<end;from+=30*86400){const raw=larkJson(await this.run({kind:'events',calendarId,start:from,end:Math.min(end,from+30*86400)},signal));const data=z.object({items:z.array(eventSchema).max(5000)}).parse(raw.data??raw);for(const e of data.items)events.set(e.event_id,e);if(events.size>10000)throw new ConnectorError('lark_event_limit',413);}
        for(const [id,e] of events)await write(sourceId,larkEvent(e,timeZone,this.ctx.sources.getItem(sourceId,id)));
        this.ctx.sources.reportStatus(sourceId,{state:'idle',lastSyncAt:now()});
      }catch(error){if(signal.aborted)throw error;failure=this.code(error);this.ctx.sources.reportStatus(sourceId,{state:'error',code:failure});}
    }
    if(failure)throw new ConnectorError(failure,502);
    const next={...this.saved,lastSyncAt:now()};await this.file.write(next);this.saved=next;
  },Boolean(reference));}
  calendarActionProviders():ActionPluginProvider[]{
    if(!this.saved.enabled||this.saved.calendarWriteAuthorized!==true)return [];
    return this.saved.selection.calendarIds.map(calendarId=>({identity:builtinIdentity,name:moteText("飞书日历 · {0}", calendarId.slice(0,80)),capability:centralCalendarCapability,calendarId}));
  }
  disconnectWriteAuthorization(){return this.start('selection',async()=>{
    const next={...this.saved,calendarWriteAuthorized:false};await this.file.write(next);this.saved=next;
  });}
  async executeAction(request:ConnectorActionExecution):Promise<ConnectorActionReceipt>{
    if(this.closed)throw new ConnectorError('connector_closed',503);
    if(request.capability?.id!=='calendar.manage'||request.capability.version!==1)throw new ConnectorError('lark_calendar_action_unsupported',403);
    if(typeof request.operationId!=='string'||!request.operationId)throw new ConnectorError('lark_calendar_operation_required',400);
    const input=request.input;
    if(!input||!['calendar.create','calendar.update','calendar.cancel'].includes(input.kind))throw new ConnectorError(input?.kind==='calendar.complete'?'lark_calendar_completion_unsupported':'lark_calendar_action_unsupported',403);
    if(!isCentralConnectorActionTarget(input.target)||!input.target.calendarId)throw new ConnectorError('lark_calendar_target_required',400);
    const calendarId=input.target.calendarId;
    if(!this.saved.selection.calendarIds.includes(calendarId))throw new ConnectorError('lark_calendar_target_not_selected',403);
    await this.requireConnected();
    if(this.saved.calendarWriteAuthorized!==true||!larkCalendarWriteScopesOk([...this.grantedScopes]))throw new ConnectorError('lark_calendar_write_not_authorized',403);
    if(input.kind==='calendar.create'){
      const event=calendarEventSchema.parse(input.event),data=this.eventBody(event,request);
      const raw=larkJson(await this.runner({kind:'calendar-event-create',calendarId,data}));
      const id=raw?.data?.event?.event_id??raw?.event?.event_id;
      if(typeof id!=='string'||!id)throw new ConnectorError('lark_event_receipt_missing',502);
      return {status:'succeeded',externalId:id.slice(0,1000)};
    }
    const externalId=input.externalId;
    if(!externalId)throw new ConnectorError('lark_event_identity_required',400);
    if(input.kind==='calendar.update'){
      const event=calendarEventSchema.parse(input.event),data=this.eventBody(event,request);
      larkJson(await this.runner({kind:'calendar-event-update',calendarId,eventId:externalId,data}));
      return {status:'succeeded',externalId};
    }
    larkJson(await this.runner({kind:'calendar-event-delete',calendarId,eventId:externalId}));
    return {status:'succeeded',externalId};
  }
  private eventBody(event:CalendarDraft,request:ConnectorActionExecution){
    const description=[event.description,request.input.actionId?moteActionMarker(request.input.actionId):'',`[Mote-operation:${request.operationId}]`].filter(Boolean).join('\n\n').trim();
    const boundary=(value:string|null)=>event.allDay?{date:value,timezone:event.timeZone??'UTC'}:{timestamp:String(Math.floor(Date.parse(value!)/1000)),timezone:event.timeZone??'UTC'};
    return {summary:event.title,...(description?{description}:{}),start_time:boundary(event.start),end_time:boundary(event.end),...(event.location?{location:{name:event.location}}:{})};
  }
  async close(){this.closed=true;clearInterval(this.timer);this.timer=undefined;this.controller?.abort();this.readController?.abort();await this.reading?.catch(()=>{});await this.active;await this.checking;await this.file.flush();}
}
