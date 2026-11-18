import { moteText } from '../i18n.js';
import {createHash,randomBytes} from 'node:crypto';
import {OAuth2Client,type Credentials} from 'google-auth-library';
import {calendarEventSchema,centralCalendarPluginCapabilitySchema,isCentralConnectorActionTarget,moteActionMarker,type ActionPluginProvider,type CalendarDraft,type ConnectorActionExecution,type ConnectorActionReceipt,type SourceItem,type SourceItemRecord} from '@mote/shared';
import {z} from 'zod';
import {PrivateFile} from './private-file.js';
import {ConnectorError} from './types.js';
import type {GoogleCalendarContext} from './google-context.js';

// Connecting and syncing only ever asks for these read scopes. Event writes use
// a separate authorization and a separate token below.
const readScopes=['https://www.googleapis.com/auth/calendar.calendarlist.readonly','https://www.googleapis.com/auth/calendar.events.readonly'];
const writeScope='https://www.googleapis.com/auth/calendar.events';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const centralCalendarCapability=centralCalendarPluginCapabilitySchema.parse({id:'calendar.manage',version:1,inputSchema:'calendar.event.v1',outputSchema:'calendar.receipt.v1',operations:['calendar.create','calendar.update','calendar.cancel','calendar.complete'],executionLocation:'central-connector',risk:'calendar-write',constraints:{writableCalendar:true,completeEvent:true,currentEvidence:true,unexpiredCreatesAndUpdates:true,noParticipants:true,existingMoteEventsOnly:true,completionInMoteOnly:true}});
const builtinIdentity={packageId:'mote.builtin.google-calendar',releaseDigest:hash('mote.builtin.google-calendar@1'),instanceId:'google-calendar',instanceRevision:1,capabilityDigest:hash(JSON.stringify(centralCalendarCapability))};
const now=()=>new Date().toISOString();
type Calendar={id:string;summary:string;timeZone?:string;primary?:boolean;accessRole?:string};
type CalendarListEntry=Calendar&{hidden?:boolean;deleted?:boolean};
type Event={id?:string;etag?:string;created?:string;updated?:string;summary?:string;description?:string;location?:string;status?:string;htmlLink?:string;recurrence?:string[];recurringEventId?:string;originalStartTime?:{date?:string;dateTime?:string};start?:{date?:string;dateTime?:string;timeZone?:string};end?:{date?:string;dateTime?:string;timeZone?:string}};
type Checkpoint={syncToken?:string;day?:string};
type WriteAuthorization={tokens:Credentials;scopes:string[];connectedAt:string};
type CalendarWriteGuard={authorize:()=>void;signal:AbortSignal};
type Saved={version:1;tokens:Credentials;calendars:Calendar[];checkpoints:Record<string,Checkpoint>;write?:WriteAuthorization};
type OAuth=Pick<OAuth2Client,'generateCodeVerifierAsync'|'generateAuthUrl'|'getToken'|'setCredentials'|'getAccessToken'|'credentials'>;
export interface GoogleDependencies {oauthFactory?:()=>OAuth;fetch?:typeof fetch;clock?:()=>number}
export const selectedCalendarsSchema=z.object({calendarIds:z.array(z.string().min(1).max(1000)).max(30).refine(ids=>new Set(ids).size===ids.length,'Calendar choices must be unique')}).strict();

function writableCalendar(calendar:Calendar):boolean {
  return calendar.accessRole==='owner'||calendar.accessRole==='writer'||calendar.accessRole==='writerWithoutPrivateAccess';
}

async function readJson<T>(response:Response):Promise<T> {
  const reader=response.body?.getReader(),chunks:Uint8Array[]=[];
  let bytes=0;
  if(reader)try{
    while(true){
      const part=await reader.read();
      if(part.done)break;
      bytes+=part.value.byteLength;
      if(bytes>8*1024*1024){
        await reader.cancel();
        throw new ConnectorError('google_response_too_large',413);
      }
      chunks.push(part.value);
    }
  }finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;}catch{throw new ConnectorError('google_response_invalid',502);}
}

async function writeCredentialRejected(response:Response):Promise<boolean> {
  if(response.status===401)return true;
  if(response.status!==403)return false;
  if(/\berror\s*=\s*"insufficient_scope"/i.test(response.headers.get('www-authenticate')??''))return true;
  const body=await readJson<{error?:{details?:{domain?:string;reason?:string}[]}}>(response).catch(()=>undefined);
  const details=body?.error?.details;
  return Array.isArray(details)&&details.some(detail=>detail?.domain==='googleapis.com'&&
    (detail.reason==='ACCESS_TOKEN_SCOPE_INSUFFICIENT'||detail.reason==='ACCOUNT_STATE_INVALID'));
}

/** Convert a calendar's date-only boundary in its IANA zone; never interpret it in server local time. */
export function calendarBoundary(date:string,timeZone:string):string {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new ConnectorError('google_event_time_invalid',502);
  const [year,month,day]=date.split('-').map(Number),target=Date.UTC(year,month-1,day);
  let guess=target;
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  for(let n=0;n<4;n++){
    const parts=Object.fromEntries(formatter.formatToParts(guess).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
    const rendered=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second),next=target-(rendered-guess);
    if(next===guess)return new Date(guess).toISOString();guess=next;
  }
  throw new ConnectorError('google_event_time_invalid',502);
}
function semantic(item:Partial<SourceItem>) {return JSON.stringify({externalId:item.externalId,title:item.title,text:item.text,mimeType:item.mimeType,kind:item.kind,layer:item.layer,deleted:item.deleted??false,calendar:item.calendar,uri:item.uri,modifiedAt:item.modifiedAt,metadata:item.metadata});}
export function googleItem(event:Event,calendar:Calendar,prior?:SourceItemRecord,reference=false):SourceItem {
  if(!event.id)throw new ConnectorError('google_event_invalid',502);
  const deleted=event.status==='cancelled',timeZone=event.start?.timeZone||calendar.timeZone||'UTC';
  const start=event.start?.dateTime||(event.start?.date?calendarBoundary(event.start.date,timeZone):undefined);
  const end=event.end?.dateTime||(event.end?.date?calendarBoundary(event.end.date,timeZone):undefined);
  if(!deleted&&(!start||!end||!Number.isFinite(Date.parse(start))||!Number.isFinite(Date.parse(end))))throw new ConnectorError('google_event_time_invalid',502);
  const text=[event.summary,event.description,event.location,...(event.recurrence??[])].filter(v=>typeof v==='string'&&v.length).join('\n\n');
  if(text.length>100000)throw new ConnectorError('google_event_too_large',413);
  const item:SourceItem={externalId:event.id,revision:'pending',observedAt:now(),title:(event.summary??prior?.title??'').slice(0,2000),text:deleted||reference?'':text,kind:'calendar',layer:reference?'reference':'snapshot',deleted,
    ...(event.updated??prior?.modifiedAt?{modifiedAt:event.updated??prior?.modifiedAt}:{}),
    ...(!deleted?{calendar:{start:start!,end:end!,allDay:Boolean(event.start?.date),timeZone,status:event.status==='tentative'?'tentative':'confirmed' as const}}:prior?.calendar?{calendar:{...prior.calendar,status:'cancelled' as const}}:{}),
  };
  const createdAt=event.created??prior?.metadata?.provider?.createdAt,updatedAt=event.updated??prior?.metadata?.provider?.updatedAt;
  if(createdAt||updatedAt)item.metadata={version:1,provider:{...(createdAt?{createdAt}:{}),...(updatedAt?{updatedAt}:{})}};
  // API links are references only. Never preserve query credentials or auto-fetch attachments.
  if(event.htmlLink)try{const url=new URL(event.htmlLink);if(url.protocol==='https:'&&!url.username&&!url.password){url.search='';url.hash='';item.uri=url.toString();}}catch{}
  const value=hash(semantic(item));item.revision=prior&&semantic(prior)===semantic(item)?prior.revision:hash(`${event.etag??value}\n${value}\n${prior?.revision??''}`);
  return item;
}

export class GoogleCalendarConnector {
  private saved:Saved={version:1,tokens:{},calendars:[],checkpoints:{}};
  private file:PrivateFile<Saved>;
  private pending=new Map<string,{verifier:string;expires:number;mode:'read'|'write'}>();
  private running?:Promise<{imported:number;duplicates:number;calendars:number}>;
  private sequence:Promise<unknown>=Promise.resolve();
  private closed=false;private timer?:ReturnType<typeof setInterval>;private abort=new AbortController();
  private calendarGeneration=0;private calendarAbort=new AbortController();private calendarChanging=0;
  private calendarWrites=new Set<Promise<ConnectorActionReceipt>>();
  private initialized=false;private syncIntervalMs?:number;
  private state:'idle'|'syncing'|'error'|'permission_required'='idle';private code?:string;private lastSyncAt?:string;
  private readonly fetcher:typeof fetch;private readonly clock:()=>number;
  constructor(private ctx:GoogleCalendarContext,private dependencies:GoogleDependencies={}) {
    this.file=new PrivateFile(ctx.directory,'google-calendar.json');
    this.fetcher=dependencies.fetch??fetch;this.clock=dependencies.clock??Date.now;
  }
  private serialize<T>(operation:()=>Promise<T>,{allowClosed=false}={}):Promise<T>{
    const result=this.sequence.catch(()=>{}).then(()=>{if(this.closed&&!allowClosed)throw new ConnectorError('connector_closed',503);return operation();});
    this.sequence=result.catch(()=>{});return result;
  }
  private invalidateCalendarActions(){this.calendarGeneration++;this.calendarAbort.abort();if(!this.closed)this.calendarAbort=new AbortController();}
  private changeCalendarScope<T>(operation:()=>Promise<T>):Promise<T>{
    this.invalidateCalendarActions();this.calendarChanging++;return this.serialize(operation).finally(()=>{this.calendarChanging--;});
  }
  /** Cancel preflight even if the upstream transport ignores abort.
   * Only the live generation may proceed to the write request. */
  private async calendarPreflight<T>(task:Promise<T>,signal:AbortSignal):Promise<T>{
    let cancel!:()=>void;
    try{return await Promise.race([task,new Promise<never>((_,reject)=>{cancel=()=>reject(new ConnectorError('google_calendar_scope_changed',409));signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();})]);}
    finally{signal.removeEventListener('abort',cancel);}
  }
  get configured(){const c=this.ctx.configuration;return Boolean(c?.googleClientId&&c.googleClientSecret&&c.googleRedirectUri);}
  status(){return {configured:this.configured,connected:Boolean(this.saved.tokens.refresh_token||this.saved.tokens.access_token),writeConnected:this.writeAuthorized(),selectedCalendarIds:this.saved.calendars.map(c=>c.id),state:this.state,...(this.code?{code:this.code}:{}),...(this.lastSyncAt?{lastSyncAt:this.lastSyncAt}:{})};}
  private writeAuthorized(){const write=this.saved.write;return Boolean(write&&(write.tokens.refresh_token||write.tokens.access_token)&&write.scopes.includes(writeScope));}
  async init(){
    const saved=await this.file.read();
    if(saved){if(saved.version!==1||!saved.tokens||!Array.isArray(saved.calendars)||!saved.checkpoints||saved.write&&(!saved.write.tokens||!Array.isArray(saved.write.scopes)))throw new ConnectorError('google_credentials_invalid',503);this.saved=saved;}
    this.initialized=true;this.configureSyncInterval(this.ctx.configuration?.syncIntervalMs??300000);
  }
  configureSyncInterval(intervalMs:number){
    const interval=Math.max(60000,intervalMs);
    if(this.timer&&this.syncIntervalMs===interval)return;
    if(this.timer)clearInterval(this.timer);this.timer=undefined;this.syncIntervalMs=interval;
    if(!this.initialized||this.closed||!this.configured)return;
    this.timer=setInterval(()=>{if(this.saved.calendars.length&&!this.closed)void this.sync().catch(()=>{});},interval);this.timer.unref();
  }
  private oauth():OAuth {
    if(!this.configured)throw new ConnectorError('google_not_configured',503);
    const config=this.ctx.configuration!;
    return this.dependencies.oauthFactory?.()??new OAuth2Client({clientId:config.googleClientId,clientSecret:config.googleClientSecret,redirectUri:config.googleRedirectUri,transporterOptions:{timeout:20000}});
  }
  async start(){
    if(this.closed)throw new ConnectorError('connector_closed',503);
    for(const [key,value] of this.pending)if(value.expires<this.clock())this.pending.delete(key);
    const oauth=this.oauth(),codes=await oauth.generateCodeVerifierAsync(),state=randomBytes(32).toString('base64url');
    if(this.closed)throw new ConnectorError('connector_closed',503);
    this.pending.set(state,{verifier:codes.codeVerifier,expires:this.clock()+600000,mode:'read'});
    return {authorizationUrl:oauth.generateAuthUrl({access_type:'offline',scope:readScopes,prompt:'consent',state,code_challenge:codes.codeChallenge,code_challenge_method:'S256' as never}),expiresIn:600};
  }
  /** A separate consent for event writes on the already connected account. */
  async startWrite(){
    if(this.closed)throw new ConnectorError('connector_closed',503);
    if(!this.status().connected)throw new ConnectorError('google_not_connected',401);
    for(const [key,value] of this.pending)if(value.expires<this.clock())this.pending.delete(key);
    const oauth=this.oauth(),codes=await oauth.generateCodeVerifierAsync(),state='google.write.'+randomBytes(32).toString('base64url');
    if(this.closed)throw new ConnectorError('connector_closed',503);
    this.pending.set(state,{verifier:codes.codeVerifier,expires:this.clock()+600000,mode:'write'});
    return {authorizationUrl:oauth.generateAuthUrl({access_type:'offline',scope:[writeScope],include_granted_scopes:true,prompt:'consent',state,code_challenge:codes.codeChallenge,code_challenge_method:'S256' as never}),expiresIn:600};
  }
  async callback(state:string,code:string){
    const request=this.pending.get(state);this.pending.delete(state);
    if(this.closed||!request||request.expires<this.clock())throw new ConnectorError('google_state_invalid',400);
    return this.changeCalendarScope(async()=>{
      let tokens:Credentials;
      try{({tokens}=await this.oauth().getToken({code,codeVerifier:request.verifier}));}catch{throw new ConnectorError('google_authorization_failed',400);}
      if(this.closed)throw new ConnectorError('connector_closed',503);
      if(!tokens.refresh_token)throw new ConnectorError('google_offline_access_required',400);
      const granted=new Set((tokens.scope??'').split(' '));
      if(request.mode==='write'){
        if(!granted.has(writeScope))throw new ConnectorError('google_write_scope_missing',403);
        // Keep the read token, selected calendars and checkpoints untouched.
        const next:Saved={...this.saved,write:{tokens,scopes:[...granted],connectedAt:now()}};await this.file.write(next);this.saved=next;return;
      }
      if(tokens.scope&&!readScopes.every(scope=>granted.has(scope)))throw new ConnectorError('google_scope_missing',403);
      // Connecting another account must not inherit the previous account's read
      // or write token, selected calendars or checkpoints.
      for(const previous of this.saved.calendars)this.ctx.sources.update(this.sourceId(previous.id),{enabled:false});
      const next:Saved={version:1,tokens,calendars:[],checkpoints:{}};await this.file.write(next);this.saved=next;this.state='idle';this.code=undefined;
    });
  }
  /** Owner-facing stop for Mote's write path. Google's own grant is unchanged. */
  disconnectWrite(){return this.changeCalendarScope(async()=>{if(this.saved.write){const {write:_,...next}=this.saved;await this.file.write(next as Saved);this.saved=next as Saved;}return this.status();});}
  calendarActionProviders():ActionPluginProvider[]{
    if(this.closed||this.calendarChanging||!this.status().connected||!this.writeAuthorized())return [];
    return this.saved.calendars.filter(writableCalendar).map(calendar=>({identity:builtinIdentity,name:moteText("Google 日历 · {0}", calendar.summary),capability:centralCalendarCapability,calendarId:calendar.id}));
  }
  executeAction(request:ConnectorActionExecution):Promise<ConnectorActionReceipt>{
    const task=this.performAction(request);this.calendarWrites.add(task);void task.then(()=>this.calendarWrites.delete(task),()=>this.calendarWrites.delete(task));return task;
  }
  private async performAction(request:ConnectorActionExecution):Promise<ConnectorActionReceipt>{
    if(this.closed)throw new ConnectorError('connector_closed',503);
    if(request.capability?.id!=='calendar.manage'||request.capability.version!==1)throw new ConnectorError('google_calendar_action_unsupported',403);
    if(typeof request.operationId!=='string'||!request.operationId)throw new ConnectorError('google_calendar_operation_required',400);
    const input=request.input;
    if(!input||!['calendar.create','calendar.update','calendar.cancel'].includes(input.kind))throw new ConnectorError(input?.kind==='calendar.complete'?'google_calendar_completion_unsupported':'google_calendar_action_unsupported',403);
    if(!isCentralConnectorActionTarget(input.target)||!input.target.calendarId)throw new ConnectorError('google_calendar_target_required',400);
    const calendarId=input.target.calendarId;
    // One explicit, already selected calendar. Never guess or fan out.
    const generation=this.calendarGeneration,signal=this.calendarAbort.signal,write=this.saved.write;
    const authorize=()=>{
      if(this.closed)throw new ConnectorError('connector_closed',503);
      if(signal.aborted||generation!==this.calendarGeneration||this.calendarChanging||this.saved.write!==write)throw new ConnectorError('google_calendar_scope_changed',409);
      const calendar=this.saved.calendars.find(value=>value.id===calendarId);
      if(!calendar)throw new ConnectorError('google_calendar_target_not_selected',403);
      if(!this.status().connected||!this.writeAuthorized())throw new ConnectorError('google_calendar_write_not_authorized',403);
      if(!writableCalendar(calendar))throw new ConnectorError('google_calendar_target_not_writable',403);
    };
    const guard={authorize,signal};
    if(input.kind==='calendar.create'){
      const event=calendarEventSchema.parse(input.event),body=this.eventBody(event,request);
      const created=await this.writeApi<{id?:string}>(calendarId,{method:'POST',body},guard);
      if(!created?.id)throw new ConnectorError('google_event_receipt_missing',502);
      return {status:'succeeded',externalId:created.id};
    }
    const externalId=input.externalId;
    if(!externalId)throw new ConnectorError('google_event_identity_required',400);
    if(input.kind==='calendar.update'){
      const event=calendarEventSchema.parse(input.event),body=this.eventBody(event,request);
      const updated=await this.writeApi<{id?:string}>(calendarId,{method:'PATCH',body,externalId},guard);
      return {status:'succeeded',externalId:updated?.id??externalId};
    }
    await this.writeApi(calendarId,{method:'DELETE',externalId},guard);
    return {status:'succeeded',externalId};
  }
  private eventBody(event:CalendarDraft,request:ConnectorActionExecution){
    const description=[event.description,request.input.actionId?moteActionMarker(request.input.actionId):'',`[Mote-operation:${request.operationId}]`].filter(Boolean).join('\n\n').trim();
    return {
      summary:event.title,
      ...(description?{description}:{}),
      ...(event.location?{location:event.location}:{}),
      start:event.allDay?{date:event.start}:{dateTime:event.start,timeZone:event.timeZone},
      end:event.allDay?{date:event.end}:{dateTime:event.end,timeZone:event.timeZone},
      ...(request.input.actionId?{extendedProperties:{private:{moteActionId:request.input.actionId,moteOperationId:request.operationId}}}:{}),
    };
  }
  private discardWriteAuthorization(write:WriteAuthorization,tokenType:'access_token'|'refresh_token',rejectedToken:string|null|undefined){
    // A dispatched request can report rejection while the connector is stopping.
    return this.serialize(async()=>{
      if(this.saved.write!==write||write.tokens[tokenType]!==rejectedToken)return;
      this.invalidateCalendarActions();
      delete this.saved.write;
      await this.file.write(this.saved);
    },{allowClosed:true});
  }
  private async writeApi<T=unknown>(calendarId:string,init:{method:'POST'|'PATCH'|'DELETE';body?:unknown;externalId?:string},guard:CalendarWriteGuard):Promise<T|undefined>{
    const {authorize,signal}=guard;
    authorize();
    const write=this.saved.write;if(!write)throw new ConnectorError('google_calendar_write_not_authorized',403);
    const credentials=write.tokens,oauth=this.oauth();oauth.setCredentials(credentials);
    let token:string|null|undefined;
    try{token=(await this.calendarPreflight(oauth.getAccessToken(),signal)).token;}
    catch(error){
      authorize();
      const reason=(error as {response?:{data?:{error?:unknown}}}|undefined)?.response?.data?.error;
      if(reason==='invalid_grant'||!credentials.refresh_token){
        await this.discardWriteAuthorization(write,'refresh_token',credentials.refresh_token);
        throw new ConnectorError('google_calendar_write_authorization_required',403);
      }
      throw new ConnectorError('google_calendar_write_failed',502);
    }
    authorize();
    const scope=oauth.credentials.scope;
    if(typeof scope==='string'&&!scope.split(/\s+/).includes(writeScope)){
      await this.discardWriteAuthorization(write,'refresh_token',credentials.refresh_token);
      throw new ConnectorError('google_calendar_write_authorization_required',403);
    }
    if(!token)throw new ConnectorError('google_calendar_write_failed',502);
    write.tokens={...credentials,...oauth.credentials,access_token:token,refresh_token:oauth.credentials.refresh_token??credentials.refresh_token};
    await this.file.write(this.saved);
    await this.serialize(async()=>{
      authorize();
      // CalendarList requires the read credential. Google still enforces the
      // event's permissions when it processes the mutation.
      const response=await this.calendarPreflight(this.readRequest(`users/me/calendarList/${encodeURIComponent(calendarId)}`,{},guard),signal);
      authorize();
      // A forbidden lookup can be specific to this calendar.
      if(response.status===403)throw new ConnectorError('google_calendar_write_permission_required',403);
      const entry=response.status===404?undefined:await this.calendarPreflight(this.readResponse<CalendarListEntry>(response),signal);
      authorize();
      const role=entry?.id===calendarId&&!entry.deleted&&typeof entry.accessRole==='string'?entry.accessRole:undefined;
      await this.saveCalendarRoles(new Map([[calendarId,role]]));
    });
    authorize();
    const path=`calendars/${encodeURIComponent(calendarId)}/events${init.externalId?'/'+encodeURIComponent(init.externalId):''}`;
    const url=new URL(`https://www.googleapis.com/calendar/v3/${path}`);
    const response=await this.fetcher(url,{method:init.method,headers:{Authorization:`Bearer ${token}`,...(init.body===undefined?{}:{'Content-Type':'application/json'})},...(init.body===undefined?{}:{body:JSON.stringify(init.body)}),redirect:'error',signal:AbortSignal.any([this.abort.signal,signal,AbortSignal.timeout(20000)])});
    if(await writeCredentialRejected(response))await this.discardWriteAuthorization(write,'access_token',token);
    if(response.status===401||response.status===403)throw new ConnectorError('google_calendar_write_permission_required',403);
    if([404,410].includes(response.status))throw new ConnectorError('google_calendar_event_not_found',404);
    if([429,503].includes(response.status))throw new ConnectorError('google_rate_limited',503);
    if(!response.ok)throw new ConnectorError('google_calendar_write_failed',502);
    if(init.method==='DELETE')return;
    const text=await response.text();if(!text)return;
    try{return JSON.parse(text) as T;}catch{throw new ConnectorError('google_response_invalid',502);}
  }
  private async readRequest(path:string,query:Record<string,string>,guard?:CalendarWriteGuard):Promise<Response> {
    if(this.closed)throw new ConnectorError('connector_closed',503);
    guard?.authorize();
    if(!this.saved.tokens.refresh_token&&!this.saved.tokens.access_token)throw new ConnectorError('google_not_connected',401);
    const oauth=this.oauth();oauth.setCredentials(this.saved.tokens);
    let token:string|null|undefined;
    try{token=(await oauth.getAccessToken()).token;}catch{guard?.authorize();this.state='permission_required';this.code='google_reauthorization_required';throw new ConnectorError(this.code,401);}
    if(this.closed)throw new ConnectorError('connector_closed',503);
    guard?.authorize();
    if(!token)throw new ConnectorError('google_reauthorization_required',401);
    this.saved.tokens={...this.saved.tokens,...oauth.credentials,refresh_token:oauth.credentials.refresh_token??this.saved.tokens.refresh_token};
    await this.file.write(this.saved);
    guard?.authorize();
    const url=new URL(`https://www.googleapis.com/calendar/v3/${path}`);for(const [key,value]of Object.entries(query))url.searchParams.set(key,value);
    const signals=[this.abort.signal,AbortSignal.timeout(20000)];if(guard)signals.push(guard.signal);
    return this.fetcher(url,{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.any(signals)});
  }
  private async readResponse<T>(response:Response):Promise<T> {
    if(!response.ok){if(response.status===410)throw new ConnectorError('google_sync_expired',410);if([401,403].includes(response.status)){this.state='permission_required';this.code='google_permission_required';throw new ConnectorError(this.code,response.status);}if([429,503].includes(response.status))throw new ConnectorError('google_rate_limited',503);throw new ConnectorError('google_request_failed',502);}
    return readJson<T>(response);
  }
  private async api<T>(path:string,query:Record<string,string>):Promise<T> {
    return this.readResponse<T>(await this.readRequest(path,query));
  }
  calendars(){return this.serialize(async()=>{
    const calendars=await this.refreshCalendarRoles();
    return {calendars:calendars.filter(c=>!c.hidden).map(c=>({id:c.id,summary:c.summary,timeZone:c.timeZone,primary:Boolean(c.primary),selected:this.saved.calendars.some(s=>s.id===c.id)}))};
  });}
  private async saveCalendarRoles(roles:ReadonlyMap<string,string|undefined>){
    let changed=false;
    for(const calendar of this.saved.calendars){
      if(!roles.has(calendar.id)||calendar.accessRole===roles.get(calendar.id))continue;
      calendar.accessRole=roles.get(calendar.id);
      changed=true;
    }
    if(changed)await this.file.write(this.saved);
  }
  private async refreshCalendarRoles(){
    const calendars=await this.listCalendars(),byId=new Map(calendars.map(c=>[c.id,c.accessRole]));
    await this.saveCalendarRoles(new Map(this.saved.calendars.map(c=>[c.id,byId.get(c.id)])));
    return calendars;
  }
  private async listCalendars(){
    const calendars:CalendarListEntry[]=[];let pageToken:string|undefined;
    for(let page=0;page<20;page++){
      // Include hidden entries when refreshing the roles of prior selections.
      const result=await this.api<{items?:CalendarListEntry[];nextPageToken?:string}>('users/me/calendarList',{maxResults:'250',showHidden:'true',...(pageToken?{pageToken}:{})});
      for(const c of result.items??[]){
        if(c?.deleted||typeof c?.id!=='string'||typeof c.summary!=='string')continue;
        calendars.push({...c,accessRole:typeof c.accessRole==='string'?c.accessRole:undefined});
      }
      pageToken=result.nextPageToken;if(!pageToken)return calendars;
    }
    throw new ConnectorError('google_calendar_limit',413);
  }
  async select(raw:unknown){const input=selectedCalendarsSchema.parse(raw);return this.changeCalendarScope(()=>this.selectCalendars(input));}
  private async selectCalendars(raw:unknown){
    const {calendarIds}=selectedCalendarsSchema.parse(raw);
    const available=await this.listCalendars();
    const selected=calendarIds.map(id=>{
      const c=available.find(calendar=>calendar.id===id&&!calendar.hidden);
      if(!c)throw new ConnectorError('google_calendar_not_found',404);
      return {id:c.id,summary:c.summary,timeZone:c.timeZone,primary:Boolean(c.primary),accessRole:c.accessRole};
    });
    for(const prior of this.saved.calendars)if(!calendarIds.includes(prior.id)){const sourceId=this.sourceId(prior.id);this.ctx.sources.update(sourceId,{enabled:false});}
    // Registration enables a genuinely new source. Saving selected calendars must
    // retain an existing source's owner pause, including after authorization changes.
    for(const calendar of selected){const id=this.sourceId(calendar.id);this.ctx.sources.register({id,name:moteText("日历 · {0}", calendar.summary).slice(0,200),kind:'google-calendar',deviceId:'google-calendar',platform:'import',retention:'snapshot',enabled:true});this.ctx.sources.update(id,{name:moteText("日历 · {0}", calendar.summary).slice(0,200)});}
    this.saved.calendars=selected;this.saved.checkpoints=Object.fromEntries(selected.flatMap(c=>this.saved.checkpoints[c.id]?[[c.id,this.saved.checkpoints[c.id]]]:[]));await this.file.write(this.saved);return this.status();
  }
  private sourceId(calendarId:string){return `google-${hash(calendarId).slice(0,24)}`;}
  sync(){
    if(this.closed)return Promise.reject(new ConnectorError('connector_closed',503));
    if(this.running)return this.running;
    this.running=this.serialize(()=>this.performSync()).finally(()=>{this.running=undefined;});return this.running;
  }
  private async performSync(){
    this.state='syncing';this.code=undefined;let imported=0,duplicates=0,calendars=0;
    try{
      if(!this.status().connected)throw new ConnectorError('google_not_connected',401);
      // CalendarList metadata can recover an older selection with no role.
      // A metadata failure must not interrupt event reads or checkpointing.
      if(this.writeAuthorized()&&this.saved.calendars.length)await this.refreshCalendarRoles().catch(()=>{});
      for(const calendar of this.saved.calendars){
        const sourceId=this.sourceId(calendar.id),source=this.ctx.sources.getSource(sourceId);if(!source.enabled)continue;
        this.ctx.sources.reportStatus(sourceId,{state:'syncing'});
        const day=new Date(this.clock()).toISOString().slice(0,10),checkpoint=this.saved.checkpoints[calendar.id]??{};
        const min=new Date(this.clock()-90*86400000).toISOString(),max=new Date(this.clock()+365*86400000).toISOString();
        let syncToken=checkpoint.day===day?checkpoint.syncToken:undefined,full=!syncToken;
        let fetched:Event[];let next:string|undefined;
        const read=async()=>{
          const events:Event[]=[];let pageToken:string|undefined;
          for(let page=0;page<100;page++){
            const query:Record<string,string>={maxResults:'250',singleEvents:'true',showDeleted:'true',...(syncToken?{syncToken}:{timeMin:min,timeMax:max}),...(pageToken?{pageToken}:{})};
            const result=await this.api<{items?:Event[];nextPageToken?:string;nextSyncToken?:string}>(`calendars/${encodeURIComponent(calendar.id)}/events`,query);
            events.push(...(result.items??[]));pageToken=result.nextPageToken;
            if(!pageToken)return {events,next:result.nextSyncToken};
          }throw new ConnectorError('google_event_limit',413);
        };
        try{const result=await read();fetched=result.events;next=result.next;}catch(error){if(!(error instanceof ConnectorError)||error.statusCode!==410)throw error;syncToken=undefined;full=true;const result=await read();fetched=result.events;next=result.next;}
        if(!next)throw new ConnectorError('google_checkpoint_missing',502);
        const seen=new Set<string>();
        for(const event of fetched){
          if(this.closed)throw new ConnectorError('connector_closed',503);
          if(!event.id)throw new ConnectorError('google_event_invalid',502);seen.add(event.id);
          const prior=this.ctx.sources.getItem(sourceId,event.id),item=googleItem(event,calendar,prior,source.retention==='reference');
          // Incremental feeds can include changes outside the selected rolling window. Keep revisions
          // of already collected items, while bounding collection of previously unseen instances.
          if(!prior&&!item.deleted&&item.calendar&&(Date.parse(item.calendar.end)<Date.parse(min)||Date.parse(item.calendar.start)>=Date.parse(max)))continue;
          const result=await this.ctx.sources.upsert(sourceId,item);result.duplicate?duplicates++:imported++;
        }
        if(full){
          let cursor:string|undefined;const missing:SourceItemRecord[]=[];
          do{const page=this.ctx.sources.listItems({sourceId,after:min,before:max,limit:200,cursor});missing.push(...page.items.filter(item=>!seen.has(item.externalId)));cursor=page.nextCursor??undefined;}while(cursor);
          for(const prior of missing){const item=googleItem({id:prior.externalId,status:'cancelled'},calendar,prior,source.retention==='reference');const result=await this.ctx.sources.upsert(sourceId,item);result.duplicate?duplicates++:imported++;}
        }
        this.saved.checkpoints[calendar.id]={syncToken:next,day};await this.file.write(this.saved);
        this.ctx.sources.reportStatus(sourceId,{state:'idle',lastSyncAt:now()});calendars++;
      }
      this.state='idle';this.code=undefined;this.lastSyncAt=now();return {imported,duplicates,calendars};
    }catch(error){this.code=error instanceof ConnectorError?error.code:'google_sync_failed';this.state=error instanceof ConnectorError&&[401,403].includes(error.statusCode)?'permission_required':'error';for(const c of this.saved.calendars)if(this.ctx.sources.getSource(this.sourceId(c.id)).enabled)this.ctx.sources.reportStatus(this.sourceId(c.id),{state:this.state,code:this.code});throw error instanceof ConnectorError?error:new ConnectorError('google_sync_failed',502);}
  }
  disconnect(){return this.changeCalendarScope(async()=>{for(const c of this.saved.calendars)this.ctx.sources.update(this.sourceId(c.id),{enabled:false});this.pending.clear();await this.file.clear();this.saved={version:1,tokens:{},calendars:[],checkpoints:{}};this.state='idle';this.code=undefined;return this.status();});}
  async close(){this.closed=true;this.invalidateCalendarActions();if(this.timer)clearInterval(this.timer);this.timer=undefined;this.pending.clear();this.abort.abort();await this.sequence;await Promise.allSettled([...this.calendarWrites]);await this.file.flush();}
}
