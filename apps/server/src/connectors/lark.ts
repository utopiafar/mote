import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {LarkStatus,LarkSelection,LarkJob,LarkCalendar,SourceItem,SourceItemRecord} from '@mote/shared';
import {PrivateFile} from './private-file.js';
import {ConnectorError,type ConnectorContext} from './types.js';
import {createLarkRunner,larkJson,authorizationUrl,type LarkRunner,type LarkCommand} from './lark-cli.js';
import {calendarBoundary} from './google.js';

export const LARK_SCOPES=['docx:document:readonly','wiki:wiki:readonly','calendar:calendar:readonly'];
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const now=()=>new Date().toISOString();
export function documentReference(value:string):string{
  if(/^[a-zA-Z0-9]{8,100}$/.test(value))return value;
  try{const u=new URL(value);if(!authorizationUrl(value)||!/^\/(docx|wiki)\/[a-zA-Z0-9]{8,100}\/?$/.test(u.pathname))throw Error();return `${u.origin}${u.pathname.replace(/\/$/,'')}`;}catch{throw new ConnectorError('lark_document_invalid');}
}
const selectionSchema=z.object({documents:z.array(z.string().trim().min(1).max(4000).transform(documentReference)).max(30),calendarIds:z.array(z.string().min(1).max(1000)).max(10),pastDays:z.number().int().min(0).max(180),futureDays:z.number().int().min(1).max(180),timeZone:z.string().max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}}),autoSync:z.boolean()}).strict();
const defaults=():LarkSelection=>({documents:[],calendarIds:[],pastDays:30,futureDays:90,timeZone:'Asia/Shanghai',autoSync:false});
const savedSchema=z.object({version:z.literal(1),enabled:z.boolean(),account:z.string().optional(),selection:selectionSchema,lastSyncAt:z.string().datetime().optional()}).strict();
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
  private job?:LarkJob;
  private active?:Promise<void>;
  private controller?:AbortController;
  private timer?:ReturnType<typeof setInterval>;
  private checking?:Promise<LarkStatus>;
  private closed=false;
  private disconnecting=false;
  private reading?:Promise<{calendars:LarkCalendar[]}>;
  private readController?:AbortController;
  constructor(private ctx:ConnectorContext,runner?:LarkRunner){const dir=ctx.config.connectors?.directory??`${ctx.config.dataDir}/connectors`;this.file=new PrivateFile(dir,'lark.json');this.runner=runner??createLarkRunner(dir);}
  async init(){const saved=await this.file.read();if(saved)this.saved=savedSchema.parse(saved);this.timer=setInterval(()=>{if(this.saved.enabled&&this.saved.selection.autoSync&&!this.active&&!this.closed)try{this.startSync();}catch{}},Math.max(60000,this.ctx.config.connectors?.syncIntervalMs??900000));this.timer.unref();}
  status():LarkStatus{return {...this.snapshot,connected:this.snapshot.connected&&this.saved.enabled,selection:structuredClone(this.saved.selection),...(this.job?{job:{...this.job}}:{}),...(this.saved.lastSyncAt?{lastSyncAt:this.saved.lastSyncAt}:{})};}
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
      const granted=new Set(typeof user?.scope==='string'?user.scope.split(/\s+/):[]);
      this.snapshot.missingScopes=LARK_SCOPES.filter(s=>!granted.has(s));
      this.snapshot.connected=user?.available===true&&typeof user?.openId==='string';
      this.snapshot.accountName=typeof user?.userName==='string'?user.userName.slice(0,200):undefined;
      this.account=this.snapshot.connected?hash(`${data.appId}:${user.openId}`):undefined;
      if(this.saved.account&&this.account&&this.saved.account!==this.account){await this.pauseSources();this.saved={version:1,enabled:false,selection:defaults()};await this.file.write(this.saved);this.snapshot.error='lark_account_changed';}
    }catch(e){this.snapshot.error=this.code(e);this.account=undefined;}
    return this.status();
  }
  private code(error:unknown){return error instanceof ConnectorError?error.code:error instanceof z.ZodError?'lark_response_invalid':'lark_operation_failed';}
  private assertIdle(){if(this.closed)throw new ConnectorError('connector_closed',503);if(this.active||this.checking||this.reading||this.disconnecting)throw new ConnectorError('lark_busy',409);}
  private start(kind:LarkJob['kind'],work:(signal:AbortSignal,job:LarkJob)=>Promise<void>):LarkJob{
    this.assertIdle();const job:LarkJob={id:randomUUID(),kind,state:'running'};this.job=job;const controller=new AbortController();this.controller=controller;
    this.active=Promise.resolve().then(()=>work(controller.signal,job)).then(()=>{job.state='completed';delete this.snapshot.error;}).catch(e=>{job.state=controller.signal.aborted?'cancelled':'failed';job.error=this.code(e);this.snapshot.error=job.error;if(kind==='sync')this.reportSources('error',job.error);}).finally(()=>{delete job.authorizationUrl;delete job.expiresAt;this.active=undefined;this.controller=undefined;});
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
  login(){return this.start('login',async(signal,job)=>{
    await this.disable();
    const raw=larkJson(await this.run({kind:'login',scopes:LARK_SCOPES},signal));
    const data=z.object({verification_url:z.string().max(8000),device_code:z.string().min(1).max(4000),expires_in:z.number().positive().max(600)}).parse(raw);
    const url=authorizationUrl(data.verification_url);if(!url)throw new ConnectorError('lark_authorization_url_invalid',502);
    job.authorizationUrl=url;job.expiresAt=new Date(Date.now()+data.expires_in*1000).toISOString();job.state='waiting';
    const expires=AbortSignal.timeout(data.expires_in*1000);
    try{await this.run({kind:'complete',deviceCode:data.device_code},AbortSignal.any([signal,expires]));}catch(e){if(expires.aborted&&!signal.aborted)throw new ConnectorError('lark_authorization_expired',409);throw e;}
    await this.probe();if(signal.aborted)throw new ConnectorError('lark_operation_cancelled',409);if(!this.snapshot.connected||!this.account)throw new ConnectorError('lark_login_incomplete',409);
    if(this.snapshot.missingScopes.length)throw new ConnectorError('lark_permission_required',403);
    const next={...this.saved,enabled:true,account:this.account};await this.file.write(next);this.saved=next;this.registerSources(true);
  });}
  async cancel(){this.controller?.abort();await this.active;return this.status();}
  private sourceId(kind:'docs'|'calendar',id=''){return `lark-${kind}-${hash(`${this.saved.account}:${id}`).slice(0,24)}`;}
  private async pauseSources(){if(!this.saved.account)return;for(const id of [this.sourceId('docs'),...this.saved.selection.calendarIds.map(id=>this.sourceId('calendar',id))]){try{this.ctx.sources.update(id,{enabled:false});}catch{}}}
  private async disable(){await this.pauseSources();this.saved={...this.saved,enabled:false};await this.file.write(this.saved);}
  async disconnect(){if(this.disconnecting)throw new ConnectorError('lark_busy',409);this.disconnecting=true;try{this.readController?.abort();await this.reading?.catch(()=>{});await this.checking;await this.cancel();await this.disable();return this.status();}finally{this.disconnecting=false;}}
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
      if(signal.aborted)throw new ConnectorError('lark_operation_cancelled',409);await this.pauseSources();const next={...this.saved,selection:input};await this.file.write(next);this.saved=next;this.registerSources(true);
    });
    await this.active;if(this.job?.state==='failed'||this.job?.state==='cancelled')throw new ConnectorError(this.job.error??'lark_operation_failed',400);return this.status();
  }
  private registerSources(enable=false){
    const add=(id:string,name:string,kind:'lark-docs'|'lark-calendar')=>{this.ctx.sources.register({id,name,kind,deviceId:'lark-server',platform:'import',retention:'snapshot'});if(enable)this.ctx.sources.update(id,{enabled:true});};
    if(this.saved.selection.documents.length)add(this.sourceId('docs'),'飞书文档','lark-docs');
    for(const id of this.saved.selection.calendarIds)add(this.sourceId('calendar',id),`飞书日历 · ${id.slice(0,80)}`,'lark-calendar');
  }
  private reportSources(state:'syncing'|'error',code?:string){if(!this.saved.account)return;for(const source of this.ctx.sources.listSources()){if(source.enabled&&(source.id===this.sourceId('docs')||this.saved.selection.calendarIds.some(id=>source.id===this.sourceId('calendar',id))))this.ctx.sources.reportStatus(source.id,{state,...(code?{code}:{})});}}
  startSync(){return this.start('sync',async(signal,job)=>{
    await this.requireConnected();this.registerSources();this.reportSources('syncing');const result={imported:0,duplicates:0};job.result=result;
    const write=async(sourceId:string,item:SourceItem)=>{if(signal.aborted)throw new ConnectorError('lark_operation_cancelled',409);const ack=await this.ctx.sources.upsert(sourceId,item);result[ack.duplicate?'duplicates':'imported']++;};
    const docSource=this.sourceId('docs');
    for(const ref of this.saved.selection.documents){
      if(!this.ctx.sources.getSource(docSource).enabled)continue;
      const raw=larkJson(await this.run({kind:'document',document:ref},signal));
      const doc=z.object({document_id:z.string().min(1).max(1000),revision_id:z.union([z.number(),z.string()]),title:z.string().max(2000).optional(),content:z.string().max(100000)}).parse((raw.data??raw).document);
      const prior=this.ctx.sources.getItem(docSource,doc.document_id);
      await write(docSource,revision({externalId:doc.document_id,observedAt:now(),title:doc.title??ref,text:doc.content,kind:'file',layer:'snapshot',deleted:false,mimeType:'text/markdown',...(ref.startsWith('https:')?{uri:ref}:{}),document:{timeBasis:'unknown',contentRole:'authored',originalMetadata:{provider:'lark',documentId:doc.document_id,revisionId:doc.revision_id}}},prior));
    }
    const {pastDays,futureDays,timeZone}=this.saved.selection;
    const start=Math.floor(Date.now()/1000)-pastDays*86400,end=Math.floor(Date.now()/1000)+futureDays*86400;
    for(const calendarId of this.saved.selection.calendarIds){
      const sourceId=this.sourceId('calendar',calendarId);if(!this.ctx.sources.getSource(sourceId).enabled)continue;const events=new Map<string,unknown>();
      // instance_view has no page cursor. Query bounded windows and never infer deletion from absence.
      for(let from=start;from<end;from+=30*86400){
        const raw=larkJson(await this.run({kind:'events',calendarId,start:from,end:Math.min(end,from+30*86400)},signal));
        const data=z.object({items:z.array(eventSchema).max(5000)}).parse(raw.data??raw);
        for(const e of data.items)events.set(e.event_id,e);
        if(events.size>10000)throw new ConnectorError('lark_event_limit',413);
      }
      for(const [id,e] of events)await write(sourceId,larkEvent(e,timeZone,this.ctx.sources.getItem(sourceId,id)));
      this.ctx.sources.reportStatus(sourceId,{state:'idle',lastSyncAt:now()});
    }
    if(this.saved.selection.documents.length)this.ctx.sources.reportStatus(docSource,{state:'idle',lastSyncAt:now()});
    const next={...this.saved,lastSyncAt:now()};await this.file.write(next);this.saved=next;job.result=result;
  });}
  async close(){this.closed=true;clearInterval(this.timer);this.controller?.abort();this.readController?.abort();await this.reading?.catch(()=>{});await this.active;await this.checking;await this.file.flush();}
}
