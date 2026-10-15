import {createHash,randomBytes,randomUUID,scrypt,timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {ScopeError} from './baseline.js';
import type {IdentityVerifier,VerifiedIdentity,UserContext,UserContextAuthority} from './context.js';
import type {LoginConnections} from '../login-handoffs.js';

export class AuthError extends Error {
  constructor(readonly code:string,readonly statusCode:number){super(code);}
}
export const usernameSchema=z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/).transform(v=>v.toLowerCase());
export const passwordSchema=z.string().min(12).max(1024).refine(v=>Buffer.byteLength(v)<=1024);
export const durationSchema=z.union([z.literal(0),z.literal(86400000),z.literal(604800000),z.literal(2592000000)]);
export const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const secret=()=>randomBytes(32).toString('base64url');
const WINDOW=15*60000;
const SESSION=86400000; // A session cookie still has a server-side maximum lifetime.
type Kind='web'|'client'|'mcp-read'|'mcp-write';
type Account={user_id:string;username:string;password_salt:string;password_hash:string;administrator:number;disabled:number;authorization_epoch:number;created_at:number};
type Credential={id:string;user_id:string;kind:Kind;account_epoch:number;expires_at:number;revoked_at:number|null;csrf_hash:string|null;metadata:string;created_at:number;parent_id:string|null};
export type AccountSummary={userId:string;username:string;administrator:boolean;disabled:boolean;authorizationEpoch:number;createdAt:number};
const summary=(a:Account):AccountSummary=>({userId:a.user_id,username:a.username,administrator:Boolean(a.administrator),disabled:Boolean(a.disabled),authorizationEpoch:a.authorization_epoch,createdAt:a.created_at});
function derive(password:string,salt:string){return new Promise<Buffer>((resolve,reject)=>scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024},(e,result)=>e?reject(e):resolve(result)));}
async function passwordRecord(password:string){passwordSchema.parse(password);const salt=randomBytes(16).toString('hex');return {salt,hash:(await derive(password,salt)).toString('hex')};}

/** The account control plane and credential verifier share the epoch-5 SQLite
 * connection. No private archive repository or legacy owner token is consulted. */
export class Accounts implements IdentityVerifier {
  private activeHashes=0;
  private closed=false;
  constructor(private db:DatabaseSync,readonly deploymentId:string,private clock=Date.now){
    db.exec(`CREATE TABLE IF NOT EXISTS auth_accounts(
      user_id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,
      administrator INTEGER NOT NULL CHECK(administrator IN(0,1)),disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN(0,1)),
      authorization_epoch INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_credentials(
      id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES auth_accounts(user_id),kind TEXT NOT NULL CHECK(kind IN('web','client','mcp-read','mcp-write')),
      account_epoch INTEGER NOT NULL,token_hash TEXT NOT NULL UNIQUE,expires_at INTEGER NOT NULL,revoked_at INTEGER,
      csrf_hash TEXT,metadata TEXT NOT NULL,created_at INTEGER NOT NULL,parent_id TEXT REFERENCES auth_credentials(id));
      CREATE INDEX IF NOT EXISTS auth_credentials_user ON auth_credentials(user_id);
      CREATE TABLE IF NOT EXISTS auth_attempts(attempt_key TEXT PRIMARY KEY,started_at INTEGER NOT NULL,attempts INTEGER NOT NULL);`);
  }
  private transaction<T>(run:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=run();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  private account(userId:string){return this.db.prepare('SELECT * FROM auth_accounts WHERE user_id=?').get(userId) as Account|undefined;}
  private accountNamed(username:string){return this.db.prepare('SELECT * FROM auth_accounts WHERE username=?').get(username) as Account|undefined;}
  private credential(id:string){return this.db.prepare('SELECT * FROM auth_credentials WHERE id=?').get(id) as Credential|undefined;}
  private current(c:Credential|undefined){
    const a=c&&this.account(c.user_id);if(this.closed||!c||!a||a.disabled)return;
    const seen=new Set<string>();let linked:Credential|undefined=c;
    while(linked){if(seen.has(linked.id)||linked.user_id!==a.user_id||linked.revoked_at!==null||linked.expires_at<=this.clock()||linked.account_epoch!==a.authorization_epoch)return;seen.add(linked.id);if(!linked.parent_id)return {a,c};linked=this.credential(linked.parent_id);}
  }
  private identity(a:Account,c:Credential):VerifiedIdentity{return {deploymentId:this.deploymentId,userId:a.user_id,credentialId:c.id,authorizationEpoch:a.authorization_epoch,administrator:Boolean(a.administrator)};}
  async verify(token:string){const c=this.findToken(token);if(!c||!['web','client'].includes(c.kind))return;const v=this.current(c);return v?this.identity(v.a,v.c):undefined;}
  isCurrent(identity:Readonly<VerifiedIdentity>){const v=this.current(this.credential(identity.credentialId));return Boolean(v&&identity.deploymentId===this.deploymentId&&identity.userId===v.a.user_id&&identity.authorizationEpoch===v.a.authorization_epoch&&identity.administrator===Boolean(v.a.administrator)&&['web','client'].includes(v.c.kind));}
  /** Trusted durable-task adapters (M05) use the persisted account epoch, not a Web session. */
  assertAccountEnabled(userId:string,authorizationEpoch:number){const a=this.account(userId);if(this.closed||!a||a.disabled||a.authorization_epoch!==authorizationEpoch)throw new ScopeError('invalid_identity',401);}
  private findToken(token:string){if(!/^[A-Za-z0-9_-]{43}$/.test(token))return;return this.db.prepare('SELECT * FROM auth_credentials WHERE token_hash=?').get(digest(token)) as Credential|undefined;}
  private assertContext(context:UserContext,authority:UserContextAuthority){authority.assert(context);const c=this.credential(context.credentialId);if(!this.current(c))throw new ScopeError('invalid_identity',401);return c!;}
  self(context:UserContext,authority:UserContextAuthority){this.assertContext(context,authority);return {...summary(this.account(context.userId)!),deploymentId:this.deploymentId,credentialId:context.credentialId};}
  credentialInfo(context:UserContext,authority:UserContextAuthority){const c=this.assertContext(context,authority);let linked:Credential|undefined=c,deviceId:string|undefined;while(linked){const metadata=JSON.parse(linked.metadata);if(metadata.deviceId){if(deviceId&&deviceId!==metadata.deviceId)throw new ScopeError('invalid_identity',403);deviceId=metadata.deviceId;}linked=linked.parent_id?this.credential(linked.parent_id):undefined;}return {kind:c.kind,expiresAt:c.expires_at,...(deviceId?{deviceId}:{})};}
  assertCsrf(context:UserContext,authority:UserContextAuthority,value:unknown){const c=this.assertContext(context,authority);if(c.kind!=='web'||typeof value!=='string'||!c.csrf_hash||digest(value)!==c.csrf_hash)throw new AuthError('csrf_required',403);}
  /** Local operator bootstrap only, exposed by the stdin CLI, never HTTP. */
  async initialize(username:string,password:string){username=usernameSchema.parse(username);const record=await passwordRecord(password);return this.transaction(()=>{if(this.db.prepare('SELECT 1 FROM auth_accounts LIMIT 1').get())throw new AuthError('already_initialized',409);return this.insertAccount(username,record,true);});}
  private insertAccount(username:string,record:{salt:string;hash:string},administrator:boolean){
    if(this.accountNamed(username))throw new AuthError('username_unavailable',409);
    const userId=randomUUID();this.db.prepare('INSERT INTO auth_accounts(user_id,username,password_salt,password_hash,administrator,created_at) VALUES(?,?,?,?,?,?)').run(userId,username,record.salt,record.hash,Number(administrator),this.clock());return summary(this.account(userId)!);
  }
  async createAccount(context:UserContext,authority:UserContextAuthority,input:{username:string;password:string;administrator:boolean}){authority.assertAdministrator(context);const username=usernameSchema.parse(input.username),record=await passwordRecord(input.password);return this.transaction(()=>{authority.assertAdministrator(context);return this.insertAccount(username,record,input.administrator);});}
  listAccounts(context:UserContext,authority:UserContextAuthority){authority.assertAdministrator(context);return {items:(this.db.prepare('SELECT * FROM auth_accounts ORDER BY created_at,user_id').all() as Account[]).map(summary)};}
  private bump(a:Account){this.db.prepare('UPDATE auth_accounts SET authorization_epoch=authorization_epoch+1 WHERE user_id=?').run(a.user_id);this.db.prepare('UPDATE auth_credentials SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(this.clock(),a.user_id);}
  disable(context:UserContext,authority:UserContextAuthority,userId:string,disabled:boolean){return this.transaction(()=>{authority.assertAdministrator(context);const a=this.account(userId);if(!a)throw new AuthError('account_not_found',404);if(a.disabled===Number(disabled))return summary(a);
    if(disabled&&a.administrator&&Number(this.db.prepare('SELECT count(*) n FROM auth_accounts WHERE administrator=1 AND disabled=0').get()!.n)<=1)throw new AuthError('last_administrator',409);
    this.bump(a);this.db.prepare('UPDATE auth_accounts SET disabled=? WHERE user_id=?').run(Number(disabled),userId);return summary(this.account(userId)!);
  });}
  async resetPassword(context:UserContext,authority:UserContextAuthority,userId:string,password:string){authority.assertAdministrator(context);const record=await passwordRecord(password);return this.transaction(()=>{authority.assertAdministrator(context);const a=this.account(userId);if(!a)throw new AuthError('account_not_found',404);this.bump(a);this.db.prepare('UPDATE auth_accounts SET password_salt=?,password_hash=? WHERE user_id=?').run(record.salt,record.hash,userId);return {reset:true};});}
  private reserveAttempt(username:string,ip:string){
    const keys=[{key:digest('account:'+username),limit:5},{key:digest('address:'+ip),limit:20}];
    this.transaction(()=>{const now=this.clock();this.db.prepare('DELETE FROM auth_attempts WHERE started_at<=?').run(now-WINDOW);
      for(const {key,limit} of keys){const row=this.db.prepare('SELECT attempts FROM auth_attempts WHERE attempt_key=?').get(key);if(row&&Number(row.attempts)>=limit)throw new AuthError('login_throttled',429);}
      for(const {key} of keys)this.db.prepare('INSERT INTO auth_attempts VALUES(?,?,1) ON CONFLICT(attempt_key) DO UPDATE SET attempts=attempts+1').run(key,now);
    });
  }
  private async checkPassword(username:string,password:string,ip:string){
    if(this.closed)throw new AuthError('authentication_closed',503);
    if(this.activeHashes>=4)throw new AuthError('login_busy',429);
    this.reserveAttempt(username,ip);this.activeHashes++;
    const a=this.accountNamed(username);
    try{const result=await derive(password,a?.password_salt??'generated-unknown-account-salt');if(!a||!timingSafeEqual(result,Buffer.from(a.password_hash,'hex'))||a.disabled)throw new AuthError('invalid_login',401);return a;}
    finally{this.activeHashes--;}
  }
  async login(username:string,password:string,ip:string,kind:'web'|'client',durationMs:number){
    username=usernameSchema.parse(username);z.string().max(1024).parse(password);durationSchema.parse(durationMs);
    const a=await this.checkPassword(username,password,ip);
    return this.transaction(()=>{const current=this.account(a.user_id);if(!current||current.disabled||current.authorization_epoch!==a.authorization_epoch)throw new AuthError('invalid_login',401);
      const grant=this.issue(current,kind,durationMs,{});this.db.prepare('DELETE FROM auth_attempts WHERE attempt_key=?').run(digest('account:'+username));return grant;
    });
  }
  async changePassword(context:UserContext,authority:UserContextAuthority,currentPassword:string,password:string,ip:string){
    authority.assert(context);const a=this.account(context.userId)!;await this.checkPassword(a.username,z.string().max(1024).parse(currentPassword),ip);const record=await passwordRecord(password);
    return this.transaction(()=>{authority.assert(context);this.bump(a);this.db.prepare('UPDATE auth_accounts SET password_salt=?,password_hash=? WHERE user_id=?').run(record.salt,record.hash,a.user_id);return {changed:true};});
  }
  private issue(a:Account,kind:Kind,durationMs:number,metadata:Record<string,unknown>,parent?:Credential){
    if(this.closed||a.disabled)throw new AuthError('invalid_login',401);
    const token=secret(),csrfToken=kind==='web'?digest('csrf:'+token):undefined,id=randomUUID(),expiresAt=Math.min(this.clock()+(durationMs||SESSION),parent?.expires_at??Infinity);
    this.db.prepare('INSERT INTO auth_credentials VALUES(?,?,?,?,?,?,NULL,?,?,?,?)').run(id,a.user_id,kind,a.authorization_epoch,digest(token),expiresAt,csrfToken?digest(csrfToken):null,JSON.stringify(metadata),this.clock(),parent?.id??null);
    return {token,...(csrfToken?{csrfToken}:{}),credentialId:id,scope:'client' as const,deploymentId:this.deploymentId,userId:a.user_id,expiresAt};
  }
  exchangeWeb(token:string){const parent=this.findToken(token),v=this.current(parent);if(!v||!['web','client'].includes(v.c.kind))throw new ScopeError('invalid_identity',401);return this.issue(v.a,'web',Math.max(1,v.c.expires_at-this.clock()),{},v.c);}
  issueClient(context:UserContext,authority:UserContextAuthority,input:{serverUrl:string;label:string;deviceId?:string;deviceName?:string;platform?:string;durationMs:number}){authority.assert(context);durationSchema.parse(input.durationMs);const deviceId=this.credentialInfo(context,authority).deviceId;if(deviceId&&input.deviceId!==deviceId)throw new ScopeError('invalid_identity',403);return {...this.issue(this.account(context.userId)!,'client',input.durationMs,input,deviceId?this.credential(context.credentialId):undefined),serverUrl:input.serverUrl};}
  credentials(context:UserContext,authority:UserContextAuthority){authority.assert(context);return {items:(this.db.prepare('SELECT * FROM auth_credentials WHERE user_id=? ORDER BY created_at,id').all(context.userId) as Credential[]).map(c=>({id:c.id,kind:c.kind,createdAt:c.created_at,expiresAt:c.expires_at,revokedAt:c.revoked_at,...JSON.parse(c.metadata)}))};}
  revoke(context:UserContext,authority:UserContextAuthority,id:string){authority.assert(context);const c=this.db.prepare('SELECT id FROM auth_credentials WHERE id=? AND user_id=?').get(id,context.userId);if(!c)throw new AuthError('credential_not_found',404);this.db.prepare('UPDATE auth_credentials SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(this.clock(),id);return {revoked:true};}
  mintMcp(context:UserContext,authority:UserContextAuthority,input:{access:'read'|'write';sourceIds?:string[];label:string;durationMs:number}){authority.assert(context);if(this.credentialInfo(context,authority).deviceId)throw new ScopeError('invalid_identity',403);if(input.access==='write'&&!input.sourceIds?.length)throw new AuthError('source_scope_required',400);return {...this.issue(this.account(context.userId)!,input.access==='write'?'mcp-write':'mcp-read',durationSchema.parse(input.durationMs),{label:input.label,sourceIds:input.sourceIds??[]}),scope:input.access==='write'?'mcp-write' as const:'mcp-read' as const};}
  /** M11 consumes this restricted authorization; MCP tokens never authenticate
   * normal client routes, account administration or login approval. */
  mcpAuthorization(token:string){const c=this.findToken(token),v=this.current(c);if(!v||!['mcp-read','mcp-write'].includes(v.c.kind))return;
    const identity=Object.freeze(this.identity(v.a,v.c)),sourceIds=Object.freeze(JSON.parse(v.c.metadata).sourceIds as string[]);
    return Object.freeze({identity,write:v.c.kind==='mcp-write',sourceIds,assertCurrent:()=>{const current=this.current(this.credential(identity.credentialId));if(!current||current.a.user_id!==identity.userId||current.a.authorization_epoch!==identity.authorizationEpoch)throw new ScopeError('invalid_identity',401);}});
  }
  /** Adapt the existing one-use ticket and PKCE approval implementation. Each
   * adapter captures a trusted context; device IDs never select account identity. */
  handoffConnections(context:UserContext,authority:UserContextAuthority):LoginConnections{return {
    session:async(serverUrl,label,device,durationMs=2592000000)=>this.issueClient(context,authority,{serverUrl,label,...device,durationMs}),
    revoke:async id=>{this.db.prepare('UPDATE auth_credentials SET revoked_at=? WHERE id=? AND user_id=?').run(this.clock(),id,context.userId);},
    authenticate:header=>{const c=header?.startsWith('Bearer ')?this.findToken(header.slice(7)):undefined;return c?.user_id===context.userId&&this.current(c)&&c.kind==='client'?{id:c.id}:undefined;},
    assertActive:c=>{const current=this.current(this.credential(c.id));if(!current||current.a.user_id!==context.userId||current.c.kind!=='client')throw new ScopeError('invalid_identity',401);},
  };}
  close(){this.closed=true;}
}
