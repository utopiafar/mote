import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {ConnectionError,type Connections} from '../connections.js';
import {PrivateFile} from './private-file.js';

const secretPattern=/^[A-Za-z0-9_-]{43}$/;
const hashPattern=/^[a-f0-9]{64}$/;
const scopeSchema=z.enum(['mote.read','mote.write']);
const ACCESS_TTL_MS=60*60*1000,REFRESH_TTL_MS=30*24*60*60*1000,REQUEST_TTL_MS=10*60*1000,CODE_TTL_MS=5*60*1000;
const MAX_CLIENTS=400,MAX_REFRESH_TOKENS=500,MAX_PENDING=50;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const token=()=>randomBytes(32).toString('base64url');

const clientSchema=z.object({
  clientId:z.string().regex(secretPattern),
  clientName:z.string().trim().min(1).max(120),
  redirectUris:z.array(z.string().min(1).max(2048)).min(1).max(10),
  createdAt:z.number().int().nonnegative(),
}).strict();
const refreshSchema=z.object({
  hash:z.string().regex(hashPattern),
  clientId:z.string().regex(secretPattern),
  credentialId:z.string().uuid(),
  write:z.boolean(),
  resource:z.string().min(1).max(2048),
  expiresAt:z.number().int().positive(),
}).strict();
const savedSchema=z.object({version:z.literal(1),clients:z.array(clientSchema).max(MAX_CLIENTS),refreshTokens:z.array(refreshSchema).max(MAX_REFRESH_TOKENS)}).strict();
export const mcpOAuthClientSchema=z.object({
  redirect_uris:z.array(z.string().min(1).max(2048)).min(1).max(10),
  client_name:z.string().max(200).optional(),
  token_endpoint_auth_method:z.literal('none').optional(),
  grant_types:z.array(z.string().min(1).max(64)).max(4).optional(),
  response_types:z.array(z.string().min(1).max(64)).max(4).optional(),
}).passthrough();

type SavedClient=z.infer<typeof clientSchema>;
type SavedRefresh=z.infer<typeof refreshSchema>;
type PendingStatus='pending'|'approved'|'rejected';
interface PendingAuthorization {
  readonly id:string;
  readonly key:string;
  readonly clientId:string;
  readonly clientName:string;
  readonly redirectUri:string;
  readonly state?:string;
  readonly codeChallenge:string;
  readonly resource:string;
  readonly write:boolean;
  readonly createdAt:number;
  readonly expiresAt:number;
  status:PendingStatus;
  code?:string;
  codeExpiresAt?:number;
}
interface CodeRecord {
  readonly pendingId:string;
  readonly clientId:string;
  readonly redirectUri:string;
  readonly codeChallenge:string;
  readonly resource:string;
  readonly write:boolean;
  readonly expiresAt:number;
}
export interface McpOAuthPolicy {enabled:boolean;writeEnabled:boolean;writeSourceIds:readonly string[]}
export interface McpOAuthOptions {
  readonly connections:Pick<Connections,'mintMcpOAuth'|'rotateMcpOAuth'|'revoke'>;
  readonly directory:string;
  readonly clock?:()=>number;
  readonly policy:()=>McpOAuthPolicy;
}
export interface McpOAuthClient {clientId:string;clientName:string;redirectUris:string[];createdAt:number}
export interface McpOAuthPending {id:string;clientName:string;redirectUri:string;write:boolean;createdAt:string;expiresAt:string}

/** OAuth protocol failures carry only fixed public descriptions. Raw request
 * values, codes and tokens never enter an error, log or response. */
export class McpOAuthError extends Error {
  constructor(readonly code:string,readonly statusCode:number,readonly description:string){super(code);this.name='McpOAuthError';}
}
const failure=(code:string,statusCode=400,description='The authorization request is invalid')=>new McpOAuthError(code,statusCode,description);

/** RFC 7591 redirect URIs include native loopback callbacks and installed-app
 * private schemes. Script and local-file schemes are never redirect targets. */
export function validRedirectUri(value:string){
  if(value.length>2048||/[\r\n\0]/.test(value))return false;
  try{
    const url=new URL(value);
    if(url.username||url.password||url.hash)return false;
    if(['javascript:','data:','file:','blob:','about:','vbscript:'].includes(url.protocol))return false;
    if(url.protocol==='http:')return ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    return /^[a-z][a-z0-9+.-]{1,31}:$/.test(url.protocol);
  }catch{return false;}
}
const clientName=(value:string|undefined)=>{
  const name=(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,120);
  return name||'MCP client';
};
const pkceMatches=(verifier:string,challenge:string)=>{
  const supplied=Buffer.from(createHash('sha256').update(verifier).digest('base64url')),expected=Buffer.from(challenge);
  return supplied.length===expected.length&&timingSafeEqual(supplied,expected);
};

/** Client registrations and refresh-token hashes live in one private file;
 * access tokens live as existing Connections hashes and raw authorization codes
 * stay in memory. Static MCP tokens are untouched. */
export class McpOAuthServer {
  private readonly file:PrivateFile<unknown>;
  private clobber=Promise.resolve();
  private clients=new Map<string,SavedClient>();
  private refreshTokens=new Map<string,SavedRefresh>();
  private readonly pending=new Map<string,PendingAuthorization>();
  private readonly pendingByKey=new Map<string,string>();
  private readonly codes=new Map<string,CodeRecord>();
  private loading:Promise<void>|undefined;
  private unavailable=false;
  private readonly clock:()=>number;
  constructor(private readonly options:McpOAuthOptions){
    this.file=new PrivateFile(options.directory,'mcp-oauth.json');this.clock=options.clock??Date.now;
  }
  private serialize<T>(work:()=>Promise<T>):Promise<T>{
    const run=this.clobber.then(work,work);this.clobber=run.then(()=>undefined,()=>undefined);return run;
  }
  private async ready(){
    if(!this.loading)this.loading=(async()=>{
      try{
        const raw=await this.file.read();
        if(raw===undefined)return;
        const saved=savedSchema.parse(raw);
        this.clients=new Map(saved.clients.map(client=>[client.clientId,client]));
        this.refreshTokens=new Map(saved.refreshTokens.map(refresh=>[refresh.hash,refresh]));
      }catch{this.unavailable=true;}
    })();
    await this.loading;
    if(this.unavailable)throw failure('temporarily_unavailable',503,'OAuth storage is unavailable');
  }
  private async persist(){
    const value={version:1 as const,clients:[...this.clients.values()],refreshTokens:[...this.refreshTokens.values()]};
    if(Buffer.byteLength(JSON.stringify(value))>2*1024*1024)throw failure('temporarily_unavailable',503,'OAuth storage is full');
    try{await this.file.write(value);}catch{throw failure('temporarily_unavailable',503,'OAuth storage is unavailable');}
  }
  private removePending(pending:PendingAuthorization){
    this.pending.delete(pending.id);
    if(this.pendingByKey.get(pending.key)===pending.id)this.pendingByKey.delete(pending.key);
    if(pending.code)this.codes.delete(digest(pending.code));
  }
  private prune(){
    const now=this.clock();
    for(const pending of [...this.pending.values()]){
      const expired=pending.status==='approved'?Boolean(pending.codeExpiresAt&&pending.codeExpiresAt<=now):pending.expiresAt<=now;
      if(expired)this.removePending(pending);
    }
    for(const [key,refresh] of this.refreshTokens)if(refresh.expiresAt<=now)this.refreshTokens.delete(key);
  }
  private summary(pending:PendingAuthorization):McpOAuthPending{
    return {id:pending.id,clientName:pending.clientName,redirectUri:pending.redirectUri,write:pending.write,createdAt:new Date(pending.createdAt).toISOString(),expiresAt:new Date(pending.expiresAt).toISOString()};
  }
  async register(raw:unknown){
    return this.serialize(async()=>{
      await this.ready();
      const parsed=mcpOAuthClientSchema.safeParse(raw);
      if(!parsed.success)throw failure('invalid_client_metadata',400,'Client metadata is invalid');
      const input=parsed.data;
      if(input.token_endpoint_auth_method!==undefined&&input.token_endpoint_auth_method!=='none')throw failure('invalid_client_metadata',400,'Only public clients are supported');
      if(input.grant_types&&(!input.grant_types.includes('authorization_code')||input.grant_types.some(grant=>!['authorization_code','refresh_token'].includes(grant))))throw failure('invalid_client_metadata',400,'Only authorization_code and refresh_token grants are supported');
      if(input.response_types&&input.response_types.some(response=>response!=='code'))throw failure('invalid_client_metadata',400,'Only the authorization code response is supported');
      const redirectUris=[...new Set(input.redirect_uris)];
      if(redirectUris.length!==input.redirect_uris.length||redirectUris.some(uri=>!validRedirectUri(uri)))throw failure('invalid_redirect_uri',400,'A redirect URI is not allowed');
      if(this.clients.size>=MAX_CLIENTS)throw failure('temporarily_unavailable',503,'Client registration is full');
      let clientId=token();
      while(this.clients.has(clientId))clientId=token();
      const client:SavedClient={clientId,clientName:clientName(input.client_name),redirectUris,createdAt:this.clock()};
      this.clients.set(clientId,client);
      try{await this.persist();}catch(error){this.clients.delete(clientId);throw error;}
      return {client_id:clientId,client_id_issued_at:Math.floor(client.createdAt/1000),client_name:client.clientName,redirect_uris:[...client.redirectUris],token_endpoint_auth_method:'none' as const,grant_types:['authorization_code','refresh_token'] as const,response_types:['code'] as const};
    });
  }
  async client(clientId:string):Promise<McpOAuthClient|undefined>{
    await this.ready();
    const client=this.clients.get(clientId);
    return client?{clientId:client.clientId,clientName:client.clientName,redirectUris:[...client.redirectUris],createdAt:client.createdAt}:undefined;
  }
  async authorize(input:{clientId:string;clientName:string;redirectUri:string;state?:string;codeChallenge:string;codeChallengeMethod:string;scope?:string;resource:string}){
    return this.serialize(async()=>{
      await this.ready();this.prune();
      const policy=this.options.policy();
      if(!policy.enabled)throw failure('mcp_disabled',503,'MCP is not enabled');
      if(input.codeChallengeMethod!=='S256'||!/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge))throw failure('invalid_request',400,'PKCE S256 is required');
      const scopes=(input.scope??'').split(' ').filter(Boolean);
      const parsedScopes=scopes.length?scopes:['mote.read'];
      if(parsedScopes.some(scope=>!scopeSchema.safeParse(scope).success))throw failure('invalid_scope',400,'The requested scope is not supported');
      const write=parsedScopes.includes('mote.write');
      if(write&&(!policy.writeEnabled||!policy.writeSourceIds.length))throw failure('invalid_scope',400,'MCP write access is not enabled');
      const key=digest(JSON.stringify([input.clientId,input.redirectUri,input.state??'',input.codeChallenge,input.resource,write]));
      const priorId=this.pendingByKey.get(key),prior=priorId?this.pending.get(priorId):undefined;
      if(prior){
        const expired=prior.status==='approved'?Boolean(prior.codeExpiresAt&&prior.codeExpiresAt<=this.clock()):prior.expiresAt<=this.clock();
        if(expired){this.removePending(prior);}
        else if(prior.status==='pending')return {kind:'pending' as const,...this.summary(prior)};
        else if(prior.status==='approved'&&prior.code)return {kind:'approved' as const,code:prior.code,redirectUri:prior.redirectUri,...(prior.state!==undefined?{state:prior.state}:{})};
        else if(prior.status==='rejected')return {kind:'rejected' as const,redirectUri:prior.redirectUri,...(prior.state!==undefined?{state:prior.state}:{})};
      }
      if([...this.pending.values()].filter(value=>value.status==='pending').length>=MAX_PENDING)throw failure('temporarily_unavailable',503,'Too many pending authorizations');
      const id=token(),now=this.clock();
      const pending:PendingAuthorization={id,key,clientId:input.clientId,clientName:input.clientName,redirectUri:input.redirectUri,...(input.state!==undefined?{state:input.state}:{}),codeChallenge:input.codeChallenge,resource:input.resource,write,createdAt:now,expiresAt:now+REQUEST_TTL_MS,status:'pending'};
      this.pending.set(id,pending);this.pendingByKey.set(key,id);
      return {kind:'pending' as const,...this.summary(pending)};
    });
  }
  async list(){
    await this.ready();this.prune();
    return [...this.pending.values()].filter(value=>value.status==='pending').sort((a,b)=>a.createdAt-b.createdAt).map(value=>this.summary(value));
  }
  async approve(id:string){
    return this.serialize(async()=>{
      await this.ready();this.prune();
      const policy=this.options.policy();
      if(!policy.enabled)throw failure('mcp_disabled',409,'MCP is not enabled');
      const pending=this.pending.get(id);
      if(!pending||pending.status!=='pending')throw failure('oauth_request_not_found',404,'The authorization request is not pending');
      if(pending.expiresAt<=this.clock()){this.removePending(pending);throw failure('oauth_request_expired',410,'The authorization request expired');}
      if(pending.write&&(!policy.writeEnabled||!policy.writeSourceIds.length))throw failure('mcp_write_disabled',409,'MCP write access is not enabled');
      pending.status='approved';pending.code=token();pending.codeExpiresAt=this.clock()+CODE_TTL_MS;
      this.codes.set(digest(pending.code),{pendingId:pending.id,clientId:pending.clientId,redirectUri:pending.redirectUri,codeChallenge:pending.codeChallenge,resource:pending.resource,write:pending.write,expiresAt:pending.codeExpiresAt});
      return {approved:true as const,...this.summary(pending)};
    });
  }
  async reject(id:string){
    return this.serialize(async()=>{
      await this.ready();this.prune();
      const pending=this.pending.get(id);
      if(!pending||pending.status!=='pending')throw failure('oauth_request_not_found',404,'The authorization request is not pending');
      pending.status='rejected';pending.code=undefined;pending.codeExpiresAt=undefined;
      return {rejected:true as const};
    });
  }
  async takeCode(input:{code:string;clientId:string;redirectUri:string;resource?:string;verifier:string}){
    await this.ready();this.prune();
    const key=digest(input.code),record=this.codes.get(key);
    if(!record)throw failure('invalid_grant',400,'The authorization code is invalid');
    // Authorization codes are single-use even when a later check fails.
    this.codes.delete(key);
    const pending=this.pending.get(record.pendingId);
    if(pending){
      this.pending.delete(pending.id);
      if(this.pendingByKey.get(pending.key)===pending.id)this.pendingByKey.delete(pending.key);
    }
    if(record.expiresAt<=this.clock()||record.clientId!==input.clientId||record.redirectUri!==input.redirectUri||record.resource!==(input.resource??record.resource))throw failure('invalid_grant',400,'The authorization code is invalid');
    if(!/^[A-Za-z0-9\-._~]{43,128}$/.test(input.verifier)||!pkceMatches(input.verifier,record.codeChallenge))throw failure('invalid_grant',400,'The PKCE verifier is invalid');
    return {clientId:record.clientId,redirectUri:record.redirectUri,resource:record.resource,write:record.write};
  }
  private refreshRecord(hash:string,clientId:string,credentialId:string,resource:string,write:boolean,expiresAt:number):SavedRefresh{
    return {hash,clientId,credentialId,resource,write,expiresAt};
  }
  private async issue(clientId:string,resource:string,write:boolean){
    await this.ready();this.prune();
    const policy=this.options.policy();
    if(!policy.enabled)throw failure('temporarily_unavailable',503,'MCP is not enabled');
    if(write&&(!policy.writeEnabled||!policy.writeSourceIds.length))throw failure('invalid_scope',400,'MCP write access is not enabled');
    const client=this.clients.get(clientId);
    if(!client)throw failure('invalid_client',400,'The client is not registered');
    const origin=new URL(resource).origin;
    let issued;
    try{
      issued=await this.options.connections.mintMcpOAuth({serverUrl:origin,label:client.clientName,access:write?'write':'read',expiresAt:new Date(this.clock()+ACCESS_TTL_MS).toISOString(),resource},{enabled:true,writeEnabled:policy.writeEnabled,writeSourceIds:policy.writeSourceIds});
    }catch(error){
      if(error instanceof ConnectionError)throw failure(error.code==='mcp_write_disabled'?'invalid_scope':'temporarily_unavailable',error.code==='mcp_write_disabled'?400:503,'MCP access is unavailable');
      throw failure('temporarily_unavailable',503,'MCP access is unavailable');
    }
    const refreshToken=token(),refresh=this.refreshRecord(digest(refreshToken),clientId,issued.credential.id,resource,write,this.clock()+REFRESH_TTL_MS);
    for(const [key,value] of this.refreshTokens)if(value.expiresAt<=this.clock())this.refreshTokens.delete(key);
    if(this.refreshTokens.size>=MAX_REFRESH_TOKENS){const oldest=[...this.refreshTokens.entries()].sort((a,b)=>a[1].expiresAt-b[1].expiresAt)[0];if(oldest)this.refreshTokens.delete(oldest[0]);}
    this.refreshTokens.set(refresh.hash,refresh);
    try{await this.persist();}catch(error){this.refreshTokens.delete(refresh.hash);await this.options.connections.revoke(issued.credential.id).catch(()=>{});throw error;}
    return {access_token:issued.token,token_type:'Bearer' as const,expires_in:ACCESS_TTL_MS/1000,scope:write?'mote.write' as const:'mote.read' as const,refresh_token:refreshToken};
  }
  async exchange(input:{clientId:string;code:string;redirectUri:string;resource?:string;verifier:string}){
    const code=await this.takeCode(input);
    if(code.clientId!==input.clientId)throw failure('invalid_grant',400,'The authorization code is invalid');
    return this.serialize(()=>this.issue(code.clientId,code.resource,code.write));
  }
  async refresh(input:{clientId:string;refreshToken:string;resource?:string}){
    return this.serialize(async()=>{
      await this.ready();this.prune();
      const key=digest(input.refreshToken),record=this.refreshTokens.get(key);
      if(!record||record.clientId!==input.clientId)throw failure('invalid_grant',400,'The refresh token is invalid');
      if(!this.clients.has(input.clientId))throw failure('invalid_client',400,'The client is not registered');
      if(input.resource!==undefined&&record.resource!==input.resource)throw failure('invalid_target',400,'The resource does not match');
      const policy=this.options.policy();
      if(!policy.enabled)throw failure('temporarily_unavailable',503,'MCP is not enabled');
      if(record.write&&(!policy.writeEnabled||!policy.writeSourceIds.length))throw failure('invalid_scope',400,'MCP write access is not enabled');
      let issued;
      try{
        issued=await this.options.connections.rotateMcpOAuth({credentialId:record.credentialId,write:record.write,expiresAt:new Date(this.clock()+ACCESS_TTL_MS).toISOString()},{enabled:true,writeEnabled:policy.writeEnabled,writeSourceIds:policy.writeSourceIds});
      }catch(error){
        if(error instanceof ConnectionError){
          if(error.code==='connection_revoked'||error.code==='connection_scope_denied'){this.refreshTokens.delete(key);await this.persist().catch(()=>{});throw failure('invalid_grant',400,'The refresh token is invalid');}
          if(error.code==='mcp_write_disabled')throw failure('invalid_scope',400,'MCP write access is not enabled');
        }
        throw failure('temporarily_unavailable',503,'MCP access is unavailable');
      }
      const refreshToken=token(),next=this.refreshRecord(digest(refreshToken),input.clientId,issued.credential.id,record.resource,record.write,this.clock()+REFRESH_TTL_MS);
      this.refreshTokens.delete(key);this.refreshTokens.set(next.hash,next);
      try{await this.persist();}catch(error){this.refreshTokens.delete(next.hash);this.refreshTokens.set(key,record);throw error;}
      return {access_token:issued.token,token_type:'Bearer' as const,expires_in:ACCESS_TTL_MS/1000,scope:record.write?'mote.write' as const:'mote.read' as const,refresh_token:refreshToken};
    });
  }
}
