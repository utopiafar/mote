import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {z} from 'zod';
import {connectionServerUrl,connectionUri,type ConnectionInvitation} from '@mote/shared';
import {PrivateFile} from './connectors/private-file.js';
import type {Store} from './store.js';
import type {SourceStore} from './sources.js';
import type {ConnectorConfig} from './connectors/types.js';

const deviceId=z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const label=z.string().trim().min(1).max(120);
const platform=z.enum(['android','macos','windows','linux','other']);
const timestamp=z.string().datetime();
const credentialSchema=z.object({id:z.string().uuid(),label,scope:z.enum(['collector','mcp-read','mcp-write']),createdAt:timestamp,revokedAt:timestamp.optional(),serverUrl:z.string().max(2048),hash:z.string().regex(/^[a-f0-9]{64}$/),deviceId:deviceId.optional(),deviceName:z.string().min(1).max(200).optional(),platform:platform.optional(),writeSourceIds:z.array(z.string().min(1).max(128)).max(500).optional()}).strict();
const savedSchema=z.object({version:z.literal(1),credentials:z.array(credentialSchema).max(500)}).strict();
export type ConnectionCredential=z.infer<typeof credentialSchema>;
type Saved=z.infer<typeof savedSchema>;
type InvitationRecord={serverUrl:string;label:string;expiresAt:number;authorizedDeviceId?:string};
export interface ConnectionFile {read():Promise<unknown>;write(value:Saved):Promise<void>}
export class ConnectionError extends Error {
  constructor(readonly code:string,readonly statusCode:number,readonly publicMessage:string){super(code);this.name='ConnectionError';}
}
const denied=()=>new ConnectionError('connection_scope_denied',403,'此连接仅可同步本设备资料；中央管理和浏览需要单独使用所有者令牌。');
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
function serverUrl(value:unknown){
  if(typeof value!=='string')throw new ConnectionError('connection_url_invalid',400,'请输入完整的 HTTPS 中央节点地址；本机回环地址可使用 HTTP。');
  try{return connectionServerUrl(value);}catch{throw new ConnectionError('connection_url_invalid',400,'请输入完整的 HTTPS 中央节点地址；地址不能包含账号、路径、查询或片段。');}
}
export class Connections {
  private credentials:ConnectionCredential[]=[];
  private invitations=new Map<string,InvitationRecord>();
  private sequence:Promise<unknown>=Promise.resolve();
  private closed=false;
  private file:ConnectionFile;
  private clock:()=>number;
  constructor(private store:Store,private sources:SourceStore,options?:{file?:ConnectionFile;clock?:()=>number}){
    this.file=options?.file??new PrivateFile<Saved>(join(store.directory,'connectors'),'client-connections.json');this.clock=options?.clock??Date.now;
  }
  async init(){
    try{const raw=await this.file.read();if(raw!==undefined){const saved=savedSchema.parse(raw);const ids=new Set(),hashes=new Set(),activeDevices=new Set();for(const c of saved.credentials){serverUrl(c.serverUrl);if(ids.has(c.id)||hashes.has(c.hash)||(c.scope==='collector'&&(!c.deviceId||!c.deviceName||!c.platform))||(c.scope==='mcp-write'&&!c.writeSourceIds?.length))throw Error();ids.add(c.id);hashes.add(c.hash);if(c.scope==='collector'&&!c.revokedAt){if(activeDevices.has(c.deviceId))throw Error();activeDevices.add(c.deviceId);}}this.credentials=saved.credentials;}}
    catch{throw new ConnectionError('connection_storage_invalid',503,'连接凭据文件无法读取，请保留数据并检查中央节点文件权限。');}
  }
  private serialize<T>(run:()=>Promise<T>):Promise<T>{const work=this.sequence.catch(()=>{}).then(()=>{if(this.closed)throw new ConnectionError('connection_closed',503,'中央节点正在关闭，请稍后重试。');return run();});this.sequence=work;return work;}
  private async persist(credentials:ConnectionCredential[]){
    // Reserve each record's revocation timestamp before issuing it, so a full store remains revocable.
    const reserved=credentials.map(c=>c.revokedAt?c:{...c,revokedAt:'2000-01-01T00:00:00.000Z'});
    if(credentials.length>500||Buffer.byteLength(JSON.stringify({version:1,credentials:reserved}))>2*1024*1024)throw new ConnectionError('connection_limit',409,'连接记录已达到数量或存储上限，请联系节点管理员。');
    try{await this.file.write({version:1,credentials});}catch{throw new ConnectionError('connection_storage_failed',503,'连接凭据未保存，操作未生效；请检查中央节点存储后重试。');}
    this.credentials=credentials;
  }
  private pruneInvitations(){for(const [key,value] of this.invitations)if(value.expiresAt<=this.clock())this.invitations.delete(key);}
  invite(raw:unknown){
    if(this.closed)throw new ConnectionError('connection_closed',503,'中央节点正在关闭，请稍后重试。');
    const input=z.object({serverUrl:z.string().max(2048),label,deviceId:deviceId.optional()}).strict().parse(raw),url=serverUrl(input.serverUrl);
    this.pruneInvitations();if(this.invitations.size>=50)throw new ConnectionError('invitation_limit',429,'有效邀请过多，请取消已有邀请或等待过期。');
    const code=randomBytes(32).toString('base64url'),expiresAt=this.clock()+10*60000;
    const invitation:ConnectionInvitation={format:'mote.connection',version:1,serverUrl:url,code,expiresAt:new Date(expiresAt).toISOString()};
    this.invitations.set(digest(code),{serverUrl:url,label:input.label,expiresAt,authorizedDeviceId:input.deviceId});
    return {invitation,uri:connectionUri(invitation,this.clock())};
  }
  cancelInvitation(raw:unknown){const {code}=z.object({code:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict().parse(raw);return this.serialize(async()=>{this.invitations.delete(digest(code));return {revoked:true as const};});}
  redeem(raw:unknown){
    const input=z.object({code:z.string().regex(/^[A-Za-z0-9_-]{43}$/),deviceId,deviceName:z.string().trim().min(1).max(200),platform}).strict().parse(raw);
    return this.serialize(async()=>{
      this.pruneInvitations();const key=digest(input.code),invitation=this.invitations.get(key);
      if(!invitation)throw new ConnectionError('invitation_invalid_or_expired',410,'邀请已使用、取消或过期，请在中央节点重新生成。');
      if(invitation.authorizedDeviceId&&invitation.authorizedDeviceId!==input.deviceId)throw new ConnectionError('invitation_device_mismatch',403,'此邀请已绑定另一台设备，请在中央节点确认设备后重新生成。');
      const known=this.credentials.some(c=>c.deviceId===input.deviceId)||Boolean(this.store.db.prepare('SELECT id FROM devices WHERE id=?').get(input.deviceId))||this.sources.listSources().some(s=>s.deviceId===input.deviceId);
      if(known&&!invitation.authorizedDeviceId)throw new ConnectionError('device_already_registered',409,'此设备 ID 已在中央登记；请由所有者选择该设备并生成绑定邀请。');
      const token=randomBytes(32).toString('base64url'),now=new Date(this.clock()).toISOString();
      const credential:ConnectionCredential={id:randomUUID(),label:invitation.label,scope:'collector',createdAt:now,serverUrl:invitation.serverUrl,hash:digest(token),deviceId:input.deviceId,deviceName:input.deviceName,platform:input.platform};
      const next=this.credentials.map(c=>c.scope==='collector'&&c.deviceId===input.deviceId&&!c.revokedAt?{...c,revokedAt:now}:c);
      await this.persist([...next,credential]);
      this.invitations.delete(key);
      return {serverUrl:invitation.serverUrl,token,credentialId:credential.id,scope:'collector' as const};
    });
  }
  authenticate(header:string|undefined):ConnectionCredential|undefined{
    if(this.closed||typeof header!=='string'||!/^Bearer [A-Za-z0-9_-]{43}$/.test(header))return;
    const hash=digest(header.slice(7));return this.credentials.find(c=>c.hash===hash&&!c.revokedAt);
  }
  assertActive(credential:ConnectionCredential){if(!this.credentials.some(c=>c.id===credential.id&&!c.revokedAt))throw new ConnectionError('connection_revoked',401,'此设备连接已撤销，请重新配对。');if(this.closed)throw new ConnectionError('connection_closed',503,'中央节点正在关闭，请稍后重试。');}
  publicCredential(c:ConnectionCredential){const {hash:_,writeSourceIds,...visible}=c;return {...visible,tokenHint:`…${c.id.slice(-8)}`,...(writeSourceIds?{writeSourceIds:[...writeSourceIds]}:{})};}
  inventory(config?:ConnectorConfig){return {items:this.credentials.map(c=>this.publicCredential(c)),mcp:{enabled:Boolean(config?.mcpEnabled),writeEnabled:Boolean(config?.mcpEnabled&&config.mcpWriteEnabled&&config.mcpWriteSourceIds?.length),writeSourceIds:config?.mcpWriteSourceIds??[]}};}
  revoke(id:string){z.string().uuid().parse(id);return this.serialize(async()=>{const found=this.credentials.find(c=>c.id===id);if(!found)throw new ConnectionError('connection_not_found',404,'未找到此连接。');if(!found.revokedAt)await this.persist(this.credentials.map(c=>c.id===id?{...c,revokedAt:new Date(this.clock()).toISOString()}:c));return {revoked:true as const,id};});}
  mintMcp(raw:unknown,config?:ConnectorConfig){
    const input=z.object({serverUrl:z.string().max(2048),label,access:z.enum(['read','write'])}).strict().parse(raw),url=serverUrl(input.serverUrl);
    if(!config?.mcpEnabled)throw new ConnectionError('mcp_disabled',409,'请先配置 MOTE_MCP_READ_TOKEN 并开启 MOTE_MCP_ENABLED，然后重启节点。');
    if(input.access==='write'&&(!config.mcpWriteEnabled||!config.mcpWriteSourceIds?.length))throw new ConnectionError('mcp_write_disabled',409,'请先配置 MOTE_MCP_WRITE_TOKEN、MOTE_MCP_WRITE_SOURCE_IDS，并开启 MOTE_MCP_WRITE_ENABLED 后重启节点。');
    const sourceIds=input.access==='write'?z.array(z.string().min(1).max(128)).min(1).max(500).parse([...new Set(config.mcpWriteSourceIds)]):undefined;
    return this.serialize(async()=>{
      const token=randomBytes(32).toString('base64url');const c:ConnectionCredential={id:randomUUID(),label:input.label,scope:input.access==='write'?'mcp-write':'mcp-read',createdAt:new Date(this.clock()).toISOString(),serverUrl:url,hash:digest(token),...(sourceIds?{writeSourceIds:sourceIds}:{})};
      await this.persist([...this.credentials,c]);return {credential:this.publicCredential(c),config:{mcpServers:{mote:{type:'http' as const,url:url+'/mcp',headers:{Authorization:`Bearer ${token}`}}}}};
    });
  }
  mcpAuthorization(header:string|undefined,config?:ConnectorConfig){
    const c=this.authenticate(header);if(!c||!['mcp-read','mcp-write'].includes(c.scope)||!config?.mcpEnabled)return;
    const write=c.scope==='mcp-write',sourceIds=write?(c.writeSourceIds??[]).filter(id=>config.mcpWriteSourceIds?.includes(id)):undefined;
    if(write&&(!config.mcpWriteEnabled||!sourceIds?.length))return;
    return {write,sourceIds,authorize:()=>this.assertActive(c)};
  }
  assertCollectorRoute(credential:ConnectionCredential,method:string,route:string){
    this.assertActive(credential);
    if(route==='/api/connections/self'&&['GET','HEAD'].includes(method))return;
    if(credential.scope!=='collector')throw denied();
    const permitted:Record<string,string[]>={'/api/captures':['POST'],'/api/notes':['POST'],'/api/devices/heartbeat':['POST'],'/api/sources':['GET','HEAD','POST'],'/api/sources/:id':['PATCH'],'/api/sources/:id/items':['GET','HEAD','PUT'],'/api/sources/:id/item':['GET','HEAD'],'/api/sources/:id/history':['GET','HEAD'],'/api/source-items':['GET','HEAD']};
    if(!permitted[route]?.includes(method))throw denied();
  }
  assertOwnDevice(c:ConnectionCredential,body:unknown){this.assertActive(c);if(!body||typeof body!=='object'||(body as {deviceId?:unknown}).deviceId!==c.deviceId)throw denied();}
  assertPlatform(c:ConnectionCredential,value:unknown){if(value!==(c.platform==='other'?'import':c.platform))throw denied();}
  assertOwnSource(c:ConnectionCredential,id:string){this.assertActive(c);if(this.sources.getSource(id).deviceId!==c.deviceId)throw denied();}
  assertCapture(c:ConnectionCredential,body:unknown){
    this.assertOwnDevice(c,body);const input=body as {id?:unknown;provenance?:unknown;platform?:unknown;source?:unknown};
    this.assertPlatform(c,input.platform);if(input.provenance!==undefined||!['screen','note','activity'].includes(String(input.source)))throw denied();
    if(typeof input.id==='string'){const prior=this.store.evidence([input.id])[0];if(prior&&prior.deviceId!==c.deviceId)throw denied();}
  }
  async close(){this.closed=true;this.invitations.clear();await this.sequence.catch(()=>{});}
}
