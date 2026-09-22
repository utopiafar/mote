import {isDeepStrictEqual} from 'node:util';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {OAuth2Client,type Credentials} from 'google-auth-library';
import type {SourceItem} from '@mote/shared';
import sanitizeHtml from 'sanitize-html';
import {ArchivedFileStore} from '../archived-files.js';
import {PrivateFile} from './private-file.js';
import {ConnectorError,type ConnectorContext} from './types.js';
import type {GoogleDependencies} from './google.js';

export const gmailScope='https://www.googleapis.com/auth/gmail.readonly';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
type Part={mimeType?:string;filename?:string;headers?:{name:string;value:string}[];body?:{data?:string;attachmentId?:string;size?:number};parts?:Part[]};
type Message={id:string;threadId?:string;historyId?:string;internalDate?:string;labelIds?:string[];payload?:Part};
type State={version:1;tokens:Credentials;account?:string;historyId?:string;full?:{epoch:string;anchor:string;pageToken?:string};deltaPage?:string};
type History={messages?:{id:string}[];messagesAdded?:{message:{id:string}}[];messagesDeleted?:{message:{id:string}}[];labelsAdded?:{message:{id:string}}[];labelsRemoved?:{message:{id:string}}[]};

/** MIME structure is transport metadata. Message text remains untrusted evidence, never instructions. */
export function gmailItems(message:Message,observedAt:string,reference=false):SourceItem[] {
  if(!/^[a-zA-Z0-9_-]{1,200}$/.test(message.id))throw new ConnectorError('gmail_message_invalid',502);
  const headers=message.payload?.headers??[];
  const header=(name:string)=>headers.find(h=>h.name.toLowerCase()===name)?.value;
  const bodies:string[]=[],attachments:{name:string;mimeType?:string}[]=[];
  let nodes=0;
  const visit=(part:Part,depth:number):void=>{
    if(++nodes>1000||depth>20)throw new ConnectorError('gmail_mime_limit',413);
    if(part.filename){if(attachments.length<100)attachments.push({name:part.filename.slice(0,1000),mimeType:part.mimeType?.slice(0,200)});return;}
    if(part.mimeType==='multipart/alternative'){
      const chosen=part.parts?.find(p=>p.mimeType==='text/plain')??part.parts?.find(p=>p.mimeType==='text/html');
      if(chosen){visit(chosen,depth+1);return;}
    }
    if(part.body?.data&&['text/plain','text/html'].includes(part.mimeType??'')){
      const text=Buffer.from(part.body.data,'base64url').toString('utf8');
      bodies.push(part.mimeType==='text/html'?sanitizeHtml(text,{allowedTags:[],allowedAttributes:{},nonTextTags:['style','script','textarea','option']}):text);
    }
    for(const child of part.parts??[])visit(child,depth+1);
  };
  if(message.payload)visit(message.payload,0);
  const text=bodies.join('\n\n');if(text.length>3_200_000)throw new ConnectorError('gmail_message_too_large',413);
  const parts=Math.max(1,Math.ceil(text.length/32000)),date=header('date'),recordedAt=date&&Number.isFinite(Date.parse(date))?new Date(date).toISOString():undefined;
  const receivedAt=message.internalDate&&Number.isFinite(Number(message.internalDate))?new Date(Number(message.internalDate)).toISOString():undefined;
  return Array.from({length:reference?1:parts},(_,part)=>{
    const item:SourceItem={externalId:`${message.id}:${part}`,revision:'pending',observedAt,title:(header('subject')??'').slice(0,2000),text:reference?'':text.slice(part*32000,(part+1)*32000),
      kind:'message',layer:reference?'reference':'snapshot',deleted:false,mimeType:'text/plain',uri:`https://mail.google.com/mail/u/0/#all/${message.id}`,
      document:{contentRole:'other',...(recordedAt?{recordedAt,timeBasis:'recorded' as const}:{timeBasis:'unknown' as const}),attachments,
        originalMetadata:{provider:'gmail',messageId:message.id,threadId:message.threadId??'',labels:(message.labelIds??[]).slice(0,100),from:(header('from')??'').slice(0,2000),to:(header('to')??'').slice(0,2000),cc:(header('cc')??'').slice(0,2000),...(receivedAt?{receivedAt}:{}),part,parts:reference?1:parts,totalCharacters:text.length,attachmentsCollected:false}}};
    item.revision=hash(JSON.stringify({...item,observedAt:undefined,revision:undefined}));return item;
  });
}

/** Read-only Gmail source: bounded pages, durable checkpoints, replay-safe source revisions. */
export class GmailConnector {
  private saved:State={version:1,tokens:{}};
  private file:PrivateFile<State>;
  private archives:ArchivedFileStore;
  private pending=new Map<string,{verifier:string;expires:number}>();
  private sequence:Promise<unknown>=Promise.resolve();
  private running?:Promise<{imported:number;duplicates:number;hasMore:boolean}>;
  private abort=new AbortController();private closed=false;private timer?:ReturnType<typeof setInterval>;
  private state:'idle'|'syncing'|'error'|'permission_required'='idle';private code?:string;private lastSyncAt?:string;
  constructor(private ctx:ConnectorContext,private dependencies:GoogleDependencies={}){
    this.archives=new ArchivedFileStore(ctx.store);
    this.file=new PrivateFile(ctx.config.connectors?.directory??`${ctx.config.dataDir}/connectors`,'gmail.json');
    ctx.store.db.exec('CREATE TABLE IF NOT EXISTS gmail_sync_members(source_id TEXT NOT NULL,message_id TEXT NOT NULL,epoch TEXT NOT NULL,PRIMARY KEY(source_id,message_id))');
  }
  private get clock(){return this.dependencies.clock??Date.now;}
  get configured(){const c=this.ctx.config.connectors;return Boolean(c?.googleClientId&&c.googleClientSecret&&c.googleRedirectUri);}
  private get sourceId(){return `gmail-${hash(this.saved.account??'').slice(0,24)}`;}
  status(){return {configured:this.configured,connected:Boolean(this.saved.account&&this.saved.tokens.refresh_token),account:this.saved.account,state:this.state,code:this.code,lastSyncAt:this.lastSyncAt,hasMore:Boolean(this.saved.full||this.saved.deltaPage),readOnly:true,attachmentsCollected:false};}
  private serialize<T>(fn:()=>Promise<T>){const result=this.sequence.catch(()=>{}).then(()=>{this.check();return fn();});this.sequence=result.catch(()=>{});return result;}
  private check(){if(this.closed||this.abort.signal.aborted)throw new ConnectorError('connector_closed',503);}
  private oauth(){if(!this.configured)throw new ConnectorError('google_not_configured',503);const c=this.ctx.config.connectors!;return this.dependencies.oauthFactory?.()??new OAuth2Client({clientId:c.googleClientId,clientSecret:c.googleClientSecret,redirectUri:c.googleRedirectUri,transporterOptions:{timeout:20000}});}
  async init(){const saved=await this.file.read();if(saved){if(saved.version!==1||!saved.tokens)throw new ConnectorError('gmail_credentials_invalid',503);this.saved=saved;}
    if(this.configured){this.timer=setInterval(()=>{if(this.saved.account)void this.sync().catch(()=>{});},Math.max(60000,this.ctx.config.connectors?.syncIntervalMs??300000));this.timer.unref();}}
  async start(){this.check();for(const [key,value]of this.pending)if(value.expires<this.clock())this.pending.delete(key);if(this.pending.size>=10)throw new ConnectorError('gmail_authorization_busy',429);
    const oauth=this.oauth(),codes=await oauth.generateCodeVerifierAsync(),state=`gmail.${randomBytes(32).toString('base64url')}`;this.check();this.pending.set(state,{verifier:codes.codeVerifier,expires:this.clock()+600000});
    return {authorizationUrl:oauth.generateAuthUrl({access_type:'offline',scope:[gmailScope],prompt:'consent',state,code_challenge:codes.codeChallenge,code_challenge_method:'S256' as never}),expiresIn:600};}
  callback(state:string,code:string){const request=this.pending.get(state);this.pending.delete(state);if(!request||request.expires<this.clock())return Promise.reject(new ConnectorError('gmail_state_invalid',400));
    return this.serialize(async()=>{
      let tokens:Credentials;try{({tokens}=await this.oauth().getToken({code,codeVerifier:request.verifier}));}catch{throw new ConnectorError('gmail_authorization_failed',400);}
      this.check();if(!tokens.refresh_token)throw new ConnectorError('google_offline_access_required',400);
      if(!tokens.scope?.split(' ').includes(gmailScope))throw new ConnectorError('gmail_scope_missing',403);
      const previous=this.saved;this.saved={version:1,tokens};
      try{
        const profile=await this.api<{emailAddress:string}>('profile');
        if(typeof profile.emailAddress!=='string'||profile.emailAddress.length>320)throw new ConnectorError('gmail_profile_invalid',502);
        this.check();this.saved.account=profile.emailAddress.toLowerCase();await this.file.write(this.saved);
        if(previous.account&&previous.account!==this.saved.account)this.ctx.sources.update(`gmail-${hash(previous.account).slice(0,24)}`,{enabled:false});
        this.ctx.sources.register({id:this.sourceId,name:`Gmail · ${this.saved.account}`.slice(0,200),kind:'gmail',deviceId:this.sourceId,platform:'import',retention:'snapshot',enabled:true});
        this.ctx.sources.update(this.sourceId,{enabled:true});this.state='idle';this.code=undefined;
      }catch(error){this.saved=previous;await this.file.write(previous);throw error;}
    });}
  private async api<T>(path:string,query:Record<string,string>={}):Promise<T>{
    this.check();const oauth=this.oauth();oauth.setCredentials(this.saved.tokens);let token:string|null|undefined;
    try{token=(await oauth.getAccessToken()).token;}catch{throw new ConnectorError('gmail_permission_required',401);}
    this.check();if(!token)throw new ConnectorError('gmail_permission_required',401);
    this.saved.tokens={...this.saved.tokens,...oauth.credentials,refresh_token:oauth.credentials.refresh_token??this.saved.tokens.refresh_token};
    const url=new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);for(const [k,v]of Object.entries(query))url.searchParams.set(k,v);
    const response=await (this.dependencies.fetch??fetch)(url,{method:'GET',headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(20000)])});
    if(!response.ok)throw new ConnectorError([401,403].includes(response.status)?'gmail_permission_required':response.status===404?'gmail_not_found':response.status===429?'gmail_rate_limited':'gmail_request_failed',response.status);
    const reader=response.body?.getReader();let bytes=0;const chunks:Uint8Array[]=[];
    try{if(reader)while(true){const p=await reader.read();if(p.done)break;bytes+=p.value.length;if(bytes>8*1024*1024){await reader.cancel();throw new ConnectorError('gmail_response_too_large',413);}chunks.push(p.value);}}finally{reader?.releaseLock();}
    this.check();try{return JSON.parse(Buffer.concat(chunks).toString()) as T;}catch{throw new ConnectorError('gmail_response_invalid',502);}
  }
  private async removeMessage(id:string){
    const rows=this.ctx.store.db.prepare('SELECT external_id FROM source_heads WHERE source_id=? AND substr(external_id,1,?)=? AND deleted=0').all(this.sourceId,id.length+1,`${id}:`) as {external_id:string}[];
    for(const row of rows){const prior=this.ctx.sources.getItem(this.sourceId,row.external_id);if(prior){const {captureId,sourceId,receivedAt,current,...item}=prior;await this.ctx.sources.upsert(this.sourceId,{...item,text:'',deleted:true,observedAt:new Date(this.clock()).toISOString(),revision:hash(`deleted:${prior.revision}`)});}}
    this.ctx.store.db.prepare('DELETE FROM gmail_sync_members WHERE source_id=? AND message_id=?').run(this.sourceId,id);
  }
  private async collect(id:string,epoch:string){
    if(!/^[a-zA-Z0-9_-]{1,200}$/.test(id))throw new ConnectorError('gmail_message_invalid',502);
    let message:Message;try{message=await this.api<Message>(`messages/${encodeURIComponent(id)}`,{format:'full'});}catch(error){if(error instanceof ConnectorError&&error.statusCode===404){await this.removeMessage(id);return {imported:0,duplicates:0};}throw error;}
    if(message.id!==id)throw new ConnectorError('gmail_message_identity_mismatch',502);
    const source=this.ctx.sources.getSource(this.sourceId);if(!source.enabled)throw new ConnectorError('gmail_source_paused',409);
    const items=gmailItems(message,new Date(this.clock()).toISOString(),source.retention==='reference');
    const original=source.retention==='reference'?undefined:this.archives.put({name:`gmail-${id}.json`,mimeType:'application/json',bytes:Buffer.from(JSON.stringify(message))});
    if(original)for(const item of items)item.document={...item.document,fileId:original.id};
    for(const item of items){const prior=this.ctx.sources.getItem(this.sourceId,item.externalId);const semantic=(v:SourceItem)=>({title:v.title,text:v.text,layer:v.layer,deleted:v.deleted,document:v.document,uri:v.uri});item.revision=prior&&isDeepStrictEqual(semantic(prior),semantic(item))?prior.revision:hash(`${item.revision}:${prior?.revision??''}`);}
    const result=await this.ctx.sources.upsertBatch(this.sourceId,items,()=>{this.check();if(!this.ctx.sources.getSource(this.sourceId).enabled)throw new ConnectorError('gmail_source_paused',409);},receipt=>{if(original)this.archives.attach(receipt.id,[original.id]);});
    // Remove obsolete tail chunks when a provider revision becomes shorter.
    for(const row of this.ctx.store.db.prepare('SELECT external_id FROM source_heads WHERE source_id=? AND substr(external_id,1,?)=? AND deleted=0').all(this.sourceId,id.length+1,`${id}:`) as {external_id:string}[]){if(!items.some(i=>i.externalId===row.external_id)){const prior=this.ctx.sources.getItem(this.sourceId,row.external_id)!;const {captureId,sourceId,receivedAt,current,...item}=prior;await this.ctx.sources.upsert(this.sourceId,{...item,text:'',deleted:true,revision:hash(`deleted:${prior.revision}`)});}}
    this.ctx.store.db.prepare('INSERT INTO gmail_sync_members VALUES(?,?,?) ON CONFLICT(source_id,message_id) DO UPDATE SET epoch=excluded.epoch').run(this.sourceId,id,epoch);
    return {imported:result.receipts.filter(r=>!r.duplicate).length,duplicates:result.receipts.filter(r=>r.duplicate).length};
  }
  sync(){if(this.running)return this.running;this.running=this.serialize(()=>this.performSync()).finally(()=>{this.running=undefined;});return this.running;}
  private async performSync(){
    if(!this.saved.account)throw new ConnectorError('gmail_not_connected',401);
    if(!this.ctx.sources.getSource(this.sourceId).enabled)return {imported:0,duplicates:0,hasMore:false};
    this.state='syncing';this.code=undefined;let imported=0,duplicates=0;
    this.ctx.sources.reportStatus(this.sourceId,{state:'syncing'});
    try{
      if(!this.saved.historyId&&!this.saved.full){const profile=await this.api<{historyId:string}>('profile');if(!/^\d+$/.test(profile.historyId))throw new ConnectorError('gmail_checkpoint_missing',502);this.saved.full={epoch:randomUUID(),anchor:profile.historyId};await this.file.write(this.saved);}
      if(this.saved.full){
        const full=this.saved.full,result=await this.api<{messages?:{id:string}[];nextPageToken?:string}>('messages',{maxResults:'100',includeSpamTrash:'true',...(full.pageToken?{pageToken:full.pageToken}:{})});
        if(!Array.isArray(result.messages??[])||(result.messages?.length??0)>100)throw new ConnectorError('gmail_page_invalid',502);
        for(const {id}of result.messages??[]){const counts=await this.collect(id,full.epoch);imported+=counts.imported;duplicates+=counts.duplicates;}
        if(result.nextPageToken)full.pageToken=result.nextPageToken;
        else{
          const stale=this.ctx.store.db.prepare('SELECT message_id FROM gmail_sync_members WHERE source_id=? AND epoch!=?').all(this.sourceId,full.epoch) as {message_id:string}[];
          for(const {message_id}of stale)await this.removeMessage(message_id);
          this.saved.historyId=full.anchor;delete this.saved.full;
        }
      }else{
        let result:{history?:History[];nextPageToken?:string;historyId?:string};
        try{result=await this.api('history',{startHistoryId:this.saved.historyId!,maxResults:'100',...(this.saved.deltaPage?{pageToken:this.saved.deltaPage}:{})});}
        catch(error){if(error instanceof ConnectorError&&error.statusCode===404){delete this.saved.historyId;delete this.saved.deltaPage;await this.file.write(this.saved);this.state='idle';this.ctx.sources.reportStatus(this.sourceId,{state:'idle',code:'gmail_history_expired'});return {imported,duplicates,hasMore:true};}throw error;}
        const ids=new Set<string>();for(const h of result.history??[])for(const id of [...(h.messages??[]).map(m=>m.id),...[...(h.messagesAdded??[]),...(h.messagesDeleted??[]),...(h.labelsAdded??[]),...(h.labelsRemoved??[])].map(m=>m.message.id)])ids.add(id);
        if(ids.size>1000)throw new ConnectorError('gmail_history_limit',413);
        for(const id of ids){const counts=await this.collect(id,'incremental');imported+=counts.imported;duplicates+=counts.duplicates;}
        if(result.nextPageToken)this.saved.deltaPage=result.nextPageToken;
        else{if(!result.historyId||!/^\d+$/.test(result.historyId))throw new ConnectorError('gmail_checkpoint_missing',502);this.saved.historyId=result.historyId;delete this.saved.deltaPage;}
      }
      this.check();await this.file.write(this.saved);this.state='idle';this.lastSyncAt=new Date(this.clock()).toISOString();this.ctx.sources.reportStatus(this.sourceId,{state:'idle',lastSyncAt:this.lastSyncAt});
      return {imported,duplicates,hasMore:Boolean(this.saved.full||this.saved.deltaPage)};
    }catch(error){this.code=error instanceof ConnectorError?error.code:'gmail_sync_failed';this.state=error instanceof ConnectorError&&[401,403].includes(error.statusCode)?'permission_required':'error';this.ctx.sources.reportStatus(this.sourceId,{state:this.state,code:this.code});throw error instanceof ConnectorError?error:new ConnectorError(this.code,502);}
  }
  async disconnect(){this.abort.abort();return this.serializeDisconnect();}
  private async serializeDisconnect(){await this.sequence.catch(()=>{});this.checkClosed();if(this.saved.account)this.ctx.sources.update(this.sourceId,{enabled:false});this.pending.clear();await this.file.clear();this.saved={version:1,tokens:{}};this.abort=new AbortController();this.state='idle';this.code=undefined;return this.status();}
  private checkClosed(){if(this.closed)throw new ConnectorError('connector_closed',503);}
  async close(){this.closed=true;this.abort.abort();if(this.timer)clearInterval(this.timer);this.pending.clear();await this.sequence;await this.file.flush();}
}
