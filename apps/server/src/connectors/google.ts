import {createHash,randomBytes} from 'node:crypto';
import {OAuth2Client,type Credentials} from 'google-auth-library';
import type {SourceItem,SourceItemRecord} from '@mote/shared';
import {z} from 'zod';
import {PrivateFile} from './private-file.js';
import {ConnectorError,type ConnectorContext} from './types.js';

const scopes=['https://www.googleapis.com/auth/calendar.calendarlist.readonly','https://www.googleapis.com/auth/calendar.events.readonly'];
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const now=()=>new Date().toISOString();
type Calendar={id:string;summary:string;timeZone?:string;primary?:boolean};
type Event={id?:string;etag?:string;created?:string;updated?:string;summary?:string;description?:string;location?:string;status?:string;htmlLink?:string;recurrence?:string[];recurringEventId?:string;originalStartTime?:{date?:string;dateTime?:string};start?:{date?:string;dateTime?:string;timeZone?:string};end?:{date?:string;dateTime?:string;timeZone?:string}};
type Checkpoint={syncToken?:string;day?:string};
type Saved={version:1;tokens:Credentials;calendars:Calendar[];checkpoints:Record<string,Checkpoint>};
type OAuth=Pick<OAuth2Client,'generateCodeVerifierAsync'|'generateAuthUrl'|'getToken'|'setCredentials'|'getAccessToken'|'credentials'>;
export interface GoogleDependencies {oauthFactory?:()=>OAuth;fetch?:typeof fetch;clock?:()=>number}
export const selectedCalendarsSchema=z.object({calendarIds:z.array(z.string().min(1).max(1000)).max(30).refine(ids=>new Set(ids).size===ids.length,'Calendar choices must be unique')}).strict();

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
  private pending=new Map<string,{verifier:string;expires:number}>();
  private running?:Promise<{imported:number;duplicates:number;calendars:number}>;
  private sequence:Promise<unknown>=Promise.resolve();
  private closed=false;private timer?:ReturnType<typeof setInterval>;private abort=new AbortController();
  private state:'idle'|'syncing'|'error'|'permission_required'='idle';private code?:string;private lastSyncAt?:string;
  private readonly fetcher:typeof fetch;private readonly clock:()=>number;
  constructor(private ctx:ConnectorContext,private dependencies:GoogleDependencies={}) {
    this.file=new PrivateFile(ctx.config.connectors?.directory??`${ctx.config.dataDir}/connectors`,'google-calendar.json');
    this.fetcher=dependencies.fetch??fetch;this.clock=dependencies.clock??Date.now;
  }
  private serialize<T>(operation:()=>Promise<T>):Promise<T>{
    const result=this.sequence.catch(()=>{}).then(()=>{if(this.closed)throw new ConnectorError('connector_closed',503);return operation();});
    this.sequence=result.catch(()=>{});return result;
  }
  get configured(){const c=this.ctx.config.connectors;return Boolean(c?.googleClientId&&c.googleClientSecret&&c.googleRedirectUri);}
  status(){return {configured:this.configured,connected:Boolean(this.saved.tokens.refresh_token||this.saved.tokens.access_token),selectedCalendarIds:this.saved.calendars.map(c=>c.id),state:this.state,...(this.code?{code:this.code}:{}),...(this.lastSyncAt?{lastSyncAt:this.lastSyncAt}:{})};}
  async init(){
    const saved=await this.file.read();
    if(saved){if(saved.version!==1||!saved.tokens||!Array.isArray(saved.calendars)||!saved.checkpoints)throw new ConnectorError('google_credentials_invalid',503);this.saved=saved;}
    const interval=Math.max(60000,this.ctx.config.connectors?.syncIntervalMs??300000);
    if(this.configured){this.timer=setInterval(()=>{if(this.saved.calendars.length&&!this.closed)void this.sync().catch(()=>{});},interval);this.timer.unref();}
  }
  private oauth():OAuth {
    if(!this.configured)throw new ConnectorError('google_not_configured',503);
    const config=this.ctx.config.connectors!;
    return this.dependencies.oauthFactory?.()??new OAuth2Client({clientId:config.googleClientId,clientSecret:config.googleClientSecret,redirectUri:config.googleRedirectUri,transporterOptions:{timeout:20000}});
  }
  async start(){
    if(this.closed)throw new ConnectorError('connector_closed',503);
    for(const [key,value] of this.pending)if(value.expires<this.clock())this.pending.delete(key);
    if(this.pending.size>=10)throw new ConnectorError('google_authorization_busy',429);
    const oauth=this.oauth(),codes=await oauth.generateCodeVerifierAsync(),state=randomBytes(32).toString('base64url');
    if(this.closed)throw new ConnectorError('connector_closed',503);
    this.pending.set(state,{verifier:codes.codeVerifier,expires:this.clock()+600000});
    return {authorizationUrl:oauth.generateAuthUrl({access_type:'offline',scope:scopes,prompt:'consent',state,code_challenge:codes.codeChallenge,code_challenge_method:'S256' as never}),expiresIn:600};
  }
  async callback(state:string,code:string){
    const request=this.pending.get(state);this.pending.delete(state);
    if(this.closed||!request||request.expires<this.clock())throw new ConnectorError('google_state_invalid',400);
    return this.serialize(async()=>{
      let tokens:Credentials;
      try{({tokens}=await this.oauth().getToken({code,codeVerifier:request.verifier}));}catch{throw new ConnectorError('google_authorization_failed',400);}
      if(this.closed)throw new ConnectorError('connector_closed',503);
      // Connecting another account must not inherit the previous account's token or selected calendars.
      if(!tokens.refresh_token)throw new ConnectorError('google_offline_access_required',400);
      const granted=new Set((tokens.scope??'').split(' '));
      if(tokens.scope&&!scopes.every(scope=>granted.has(scope)))throw new ConnectorError('google_scope_missing',403);
      for(const previous of this.saved.calendars)this.ctx.sources.update(this.sourceId(previous.id),{enabled:false});
      const next:Saved={version:1,tokens,calendars:[],checkpoints:{}};await this.file.write(next);this.saved=next;this.state='idle';this.code=undefined;
    });
  }
  private async api<T>(path:string,query:Record<string,string>={}):Promise<T> {
    if(this.closed)throw new ConnectorError('connector_closed',503);
    if(!this.saved.tokens.refresh_token&&!this.saved.tokens.access_token)throw new ConnectorError('google_not_connected',401);
    const oauth=this.oauth();oauth.setCredentials(this.saved.tokens);
    let token:string|null|undefined;
    try{token=(await oauth.getAccessToken()).token;}catch{this.state='permission_required';this.code='google_reauthorization_required';throw new ConnectorError(this.code,401);}
    if(this.closed)throw new ConnectorError('connector_closed',503);
    if(!token)throw new ConnectorError('google_reauthorization_required',401);
    this.saved.tokens={...this.saved.tokens,...oauth.credentials,refresh_token:oauth.credentials.refresh_token??this.saved.tokens.refresh_token};
    await this.file.write(this.saved);
    const url=new URL(`https://www.googleapis.com/calendar/v3/${path}`);for(const [key,value]of Object.entries(query))url.searchParams.set(key,value);
    const response=await this.fetcher(url,{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(20000)])});
    if(!response.ok){if(response.status===410)throw new ConnectorError('google_sync_expired',410);if([401,403].includes(response.status)){this.state='permission_required';this.code='google_permission_required';throw new ConnectorError(this.code,response.status);}if([429,503].includes(response.status))throw new ConnectorError('google_rate_limited',503);throw new ConnectorError('google_request_failed',502);}
    const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let bytes=0;
    if(reader)try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>8*1024*1024){await reader.cancel();throw new ConnectorError('google_response_too_large',413);}chunks.push(part.value);}}finally{reader.releaseLock();}
    const text=Buffer.concat(chunks).toString('utf8');
    try{return JSON.parse(text) as T;}catch{throw new ConnectorError('google_response_invalid',502);}
  }
  calendars(){return this.serialize(()=>this.listCalendars());}
  private async listCalendars(){
    const calendars:Calendar[]=[];let pageToken:string|undefined;
    for(let page=0;page<20;page++){
      const result=await this.api<{items?:Calendar[];nextPageToken?:string}>('users/me/calendarList',{maxResults:'250',...(pageToken?{pageToken}:{})});
      for(const c of result.items??[])if(typeof c.id==='string'&&typeof c.summary==='string')calendars.push(c);
      pageToken=result.nextPageToken;if(!pageToken)return {calendars:calendars.map(c=>({id:c.id,summary:c.summary,timeZone:c.timeZone,primary:Boolean(c.primary),selected:this.saved.calendars.some(s=>s.id===c.id)}))};
    }
    throw new ConnectorError('google_calendar_limit',413);
  }
  select(raw:unknown){return this.serialize(()=>this.selectCalendars(raw));}
  private async selectCalendars(raw:unknown){
    const {calendarIds}=selectedCalendarsSchema.parse(raw);
    const available=(await this.listCalendars()).calendars,selected=calendarIds.map(id=>{const c=available.find(c=>c.id===id);if(!c)throw new ConnectorError('google_calendar_not_found',404);return {id:c.id,summary:c.summary,timeZone:c.timeZone,primary:c.primary};});
    for(const prior of this.saved.calendars)if(!calendarIds.includes(prior.id)){const sourceId=this.sourceId(prior.id);this.ctx.sources.update(sourceId,{enabled:false});}
    for(const calendar of selected){const id=this.sourceId(calendar.id);this.ctx.sources.register({id,name:`日历 · ${calendar.summary}`.slice(0,200),kind:'google-calendar',deviceId:'google-calendar',platform:'import',retention:'snapshot',enabled:true});this.ctx.sources.update(id,{enabled:true,name:`日历 · ${calendar.summary}`.slice(0,200)});}
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
      this.state='idle';this.lastSyncAt=now();return {imported,duplicates,calendars};
    }catch(error){this.code=error instanceof ConnectorError?error.code:'google_sync_failed';this.state=error instanceof ConnectorError&&[401,403].includes(error.statusCode)?'permission_required':'error';for(const c of this.saved.calendars)if(this.ctx.sources.getSource(this.sourceId(c.id)).enabled)this.ctx.sources.reportStatus(this.sourceId(c.id),{state:this.state,code:this.code});throw error instanceof ConnectorError?error:new ConnectorError('google_sync_failed',502);}
  }
  disconnect(){return this.serialize(async()=>{for(const c of this.saved.calendars)this.ctx.sources.update(this.sourceId(c.id),{enabled:false});this.pending.clear();await this.file.clear();this.saved={version:1,tokens:{},calendars:[],checkpoints:{}};this.state='idle';this.code=undefined;return this.status();});}
  async close(){this.closed=true;if(this.timer)clearInterval(this.timer);this.pending.clear();this.abort.abort();await this.sequence;await this.file.flush();}
}
