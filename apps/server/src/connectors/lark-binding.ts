import {createHash,randomUUID} from 'node:crypto';
import {authorizationUrl,larkJson,type LarkCommand,type LarkRunner} from './lark-cli.js';
import {ConnectorError} from './types.js';

/** The read scopes an official IM connector asks for on the existing Lark
 * account. The generic message scope satisfies the base history API; the two
 * get-as-user scopes are required for group and p2p history respectively. */
export const LARK_IM_READ_SCOPES=Object.freeze([
  'im:chat:readonly',
  'im:message:readonly',
  'im:message.group_msg:get_as_user',
  'im:message.p2p_msg:get_as_user',
]);
/** User-identity sending needs both scopes: the base message scope and the
 * explicit send-as-user scope. */
export const LARK_IM_SEND_SCOPES=Object.freeze(['im:message','im:message.send_as_user']);
const CHAT_PATH='/open-apis/im/v1/chats';
const MESSAGE_PATH='/open-apis/im/v1/messages';
const MAX_TEXT=40000;

export interface LarkBindingStatus {
  installed:boolean;
  configured:boolean;
  connected:boolean;
  accountId?:string;
  accountName?:string;
  scopes:string[];
  error?:string;
}
export interface LarkImChat {id:string;type:'group'|'p2p';name:string}
export interface LarkImPage<T> {items:T[];hasMore:boolean;pageToken?:string}
export interface LarkBindingRequest {method:string;path:string;query?:Readonly<Record<string,string|number|undefined>>}
export type LarkImMessageInput=({chatId:string;threadId?:never;startTime?:string;endTime?:string}|{threadId:string;chatId?:never;startTime?:never;endTime?:never})&{pageToken?:string;pageSize?:number};
export interface LarkBindingAuthorization {id:string;authorizationUrl:string;expiresAt:string}
/** Trusted host binding for the one existing Lark account. The official
 * package never spawns the CLI, reads its profile or accepts an arbitrary
 * method/path; this adapter owns all of that and only dispatches fixed IM
 * commands. Sending is reachable only through the connector action path. */
export interface LarkBinding {
  status():Promise<LarkBindingStatus>;
  /** Synchronous currentness guard for the binding's last observed identity
   * and scopes, not a transaction over the third-party CLI credential store. */
  captureRead(input:{accountId:string;type?:'group'|'p2p'}):()=>void;
  /** One-shot notification of an observed identity change or confirmed loss
   * of required read scopes. Transient status errors do not withdraw a grant. */
  onReadInvalidated(input:{accountId:string;type:'group'|'p2p'},invalidate:()=>void):()=>void;
  startAuthorization(scopes:readonly string[]):Promise<LarkBindingAuthorization>;
  completeAuthorization(id:string,signal?:AbortSignal):Promise<LarkBindingStatus>;
  cancelAuthorization(id:string):Promise<void>;
  request(input:LarkBindingRequest,options?:{signal?:AbortSignal}):Promise<unknown>;
  listChats(input?:{pageToken?:string;pageSize?:number}):Promise<LarkImPage<LarkImChat>>;
  listMessages(input:LarkImMessageInput,options?:{signal?:AbortSignal;authorize?:()=>void}):Promise<LarkImPage<Record<string,unknown>>>;
  sendMessage(input:{chatId:string;text:string;uuid?:string}):Promise<{messageId:string;createTime?:string;content?:string}>;
}

const text=(value:unknown)=>typeof value==='string'?value:'';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const scopes=(value:unknown):string[]=>Array.isArray(value)?value.filter((scope):scope is string=>typeof scope==='string'):text(value).split(/\s+/).filter(Boolean);
const imId=(value:string)=>/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value)?value:(()=>{throw new ConnectorError('lark_im_input_invalid',400);})();
const code=(error:unknown)=>error instanceof ConnectorError?error.code:'lark_operation_failed';
const cleanName=(value:unknown)=>text(value).replace(/[\u0000-\u001f\u007f]+/g,' ').trim().slice(0,200);

/** The single read/send path allowlist. A GET can read chats or messages; the
 * send POST is named here only so the same classifier can prove that a read
 * request never reaches it. */
export function larkImRequestKind(method:string,pathname:string):'read'|'send'|undefined {
  const verb=String(method).toUpperCase();
  if(verb==='GET'&&(pathname===CHAT_PATH||pathname===MESSAGE_PATH))return 'read';
  if(verb==='POST'&&pathname===MESSAGE_PATH)return 'send';
  return undefined;
}
export function larkReadScopesOk(values:readonly string[]):boolean {
  const granted=new Set(values);
  return ['im:chat:readonly','im:chat:read','im:chat'].some(scope=>granted.has(scope))&&
    ['im:message:readonly','im:message','im:message.history:readonly'].some(scope=>granted.has(scope));
}
export function larkMessageScopesOk(type:'group'|'p2p',values:readonly string[]):boolean {
  const granted=new Set(values);
  if(granted.has('im:message'))return true;
  return granted.has(type==='p2p'?'im:message.p2p_msg:get_as_user':'im:message.group_msg:get_as_user');
}
export function larkSendScopesOk(values:readonly string[]):boolean {
  const granted=new Set(values);
  return granted.has('im:message')&&(granted.has('im:message.send_as_user')||granted.has('im:message:send_as_user'));
}
const boundedInt=(value:unknown,fallback:number,min:number,max:number)=>{
  if(value===undefined||value==='')return fallback;
  const number=Number(value);
  if(!Number.isInteger(number)||number<min||number>max)throw new ConnectorError('lark_im_input_invalid',400);
  return number;
};
const optionalTime=(value:unknown):string|undefined=>{
  if(value===undefined||value==='')return undefined;
  const raw=String(value);
  if(!/^\d{1,12}$/.test(raw))throw new ConnectorError('lark_im_input_invalid',400);
  return raw;
};
const allowedQuery=(query:Readonly<Record<string,string|number|undefined>>,keys:readonly string[])=>{
  for(const key of Object.keys(query))if(!keys.includes(key))throw new ConnectorError('lark_im_path_blocked',403);
};

/** Bind fixed IM operations to the host-owned Lark CLI profile. The caller is a
 * trusted official connector; it still cannot choose a CLI command or path. */
export function createLarkBinding(options:{runner:LarkRunner}):LarkBinding {
  const {runner}=options;
  const pending=new Map<string,{deviceCode:string;expiresAt:number;scopes:string[]}>();
  let observed:LarkBindingStatus|undefined,confirmed:LarkBindingStatus|undefined,generation=0;
  const readGenerations={base:0,group:0,p2p:0};
  const readers=new Set<{accountId:string;type:'group'|'p2p';invalidate:()=>void}>();
  const usable=(entry:LarkBindingStatus|undefined,type?:'group'|'p2p')=>Boolean(entry?.connected&&entry.configured&&entry.accountId&&larkReadScopesOk(entry.scopes)&&(!type||larkMessageScopesOk(type,entry.scopes)));
  const remember=(value:LarkBindingStatus,verified=true)=>{
    observed=value;
    if(verified){
      if(confirmed&&JSON.stringify([confirmed.connected,confirmed.configured,confirmed.accountId])!==JSON.stringify([value.connected,value.configured,value.accountId]))generation++;
      for(const type of ['base','group','p2p'] as const)if(usable(confirmed,type==='base'?undefined:type)&&!usable(value,type==='base'?undefined:type))readGenerations[type]++;
      confirmed=value;
      for(const reader of [...readers])if(reader.accountId!==value.accountId||!usable(value,reader.type)){
        readers.delete(reader);reader.invalidate();
      }
    }
    return value;
  };
  const captureRead=({accountId,type}:{accountId:string;type?:'group'|'p2p'})=>{
    if(!observed?.connected||!observed.configured||!observed.accountId)throw new ConnectorError('lark_not_connected',401);
    if(observed.accountId!==accountId)throw new ConnectorError('lark_im_scope_changed',409);
    if(!larkReadScopesOk(observed.scopes)||type&&!larkMessageScopesOk(type,observed.scopes))throw new ConnectorError('lark_im_not_authorized',403);
    const captured=generation,key=type??'base',readGeneration=readGenerations[key];
    return ()=>{if(captured!==generation||readGeneration!==readGenerations[key]||!usable(observed,type))throw new ConnectorError('lark_im_scope_changed',409);};
  };
  const onReadInvalidated=(input:{accountId:string;type:'group'|'p2p'},invalidate:()=>void)=>{
    const reader={...input,invalidate};readers.add(reader);
    return ()=>{readers.delete(reader);};
  };

  const status=async():Promise<LarkBindingStatus>=>{
    let installed=false,configured=false;
    try{
      await runner({kind:'version'});
      installed=true;
      const value=larkJson(await runner({kind:'status'})),user=value?.identities?.user;
      configured=typeof value?.appId==='string'&&value.appId.length>0;
      if(typeof user?.available!=='boolean'||user.available&&(!configured||typeof user.openId!=='string'||!user.openId||typeof user.scope!=='string'&&!(Array.isArray(user.scope)&&user.scope.every((entry:unknown)=>typeof entry==='string'))))throw new ConnectorError('lark_status_invalid',502);
      const connected=user?.available===true&&typeof user?.openId==='string';
      return remember({
        installed,configured,connected,
        ...(connected&&configured?{accountId:hash(`${value.appId}:${user.openId}`)}:{}),
        ...(connected&&typeof user?.userName==='string'?{accountName:user.userName.slice(0,200)}:{}),
        scopes:scopes(user?.scope),
      });
    }catch(error){
      return remember({installed,configured,connected:false,scopes:[],error:code(error)},false);
    }
  };

  const envelope=async(command:LarkCommand,runOptions?:{signal?:AbortSignal})=>{
    const value=larkJson(await runner(command,runOptions));
    return value?.data??value;
  };

  const request=async(input:LarkBindingRequest,runOptions?:{signal?:AbortSignal}):Promise<unknown>=>{
    if(larkImRequestKind(input.method,input.path)!=='read')throw new ConnectorError('lark_im_path_blocked',403);
    const query=input.query??{};
    if(input.path===CHAT_PATH){
      allowedQuery(query,['page_token','page_size']);
      return envelope({kind:'im-chats',
        ...(query.page_token?{pageToken:String(query.page_token)}:{}),
        pageSize:boundedInt(query.page_size,100,1,100)},runOptions);
    }
    allowedQuery(query,['container_id_type','container_id','start_time','end_time','sort_type','page_size','page_token']);
    if(!['chat','thread'].includes(String(query.container_id_type)))throw new ConnectorError('lark_im_input_invalid',400);
    const chatId=imId(text(query.container_id));
    if(query.container_id_type==='thread'){
      if(query.start_time!==undefined||query.end_time!==undefined||query.sort_type!==undefined&&query.sort_type!=='ByCreateTimeAsc')throw new ConnectorError('lark_im_input_invalid',400);
      return envelope({kind:'im-thread-messages',threadId:chatId,...(query.page_token?{pageToken:String(query.page_token)}:{}),pageSize:boundedInt(query.page_size,50,1,50)},runOptions);
    }
    if(query.sort_type!==undefined&&query.sort_type!=='ByCreateTimeAsc')throw new ConnectorError('lark_im_input_invalid',400);
    return envelope({kind:'im-messages',chatId,
      ...(optionalTime(query.start_time)?{startTime:String(query.start_time)}:{}),
      ...(optionalTime(query.end_time)?{endTime:String(query.end_time)}:{}),
      ...(query.page_token?{pageToken:String(query.page_token)}:{}),
      pageSize:boundedInt(query.page_size,50,1,50)},runOptions);
  };

  const listChats=async(input:{pageToken?:string;pageSize?:number}={}):Promise<LarkImPage<LarkImChat>>=>{
    const value=await request({method:'GET',path:CHAT_PATH,query:{...(input.pageToken?{page_token:input.pageToken}:{}),page_size:boundedInt(input.pageSize,100,1,100)}}) as Record<string,unknown>;
    const raw=Array.isArray(value?.items)?value.items:Array.isArray(value?.chats)?value.chats:[];
    const items:LarkImChat[]=[];
    for(const entry of raw as Record<string,unknown>[]){
      const id=text(entry?.chat_id);
      if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id))continue;
      const type: 'group'|'p2p'=text(entry?.chat_mode)==='p2p'||text(entry?.chat_type)==='p2p'?'p2p':'group';
      const name=cleanName(entry?.name)||cleanName(entry?.p2p_target_id)||id;
      items.push({id,type,name});
    }
    return {items,hasMore:value?.has_more===true,...(text(value?.page_token)?{pageToken:text(value.page_token)}:{})};
  };

  const listMessages=async(input:LarkImMessageInput,runOptions?:{signal?:AbortSignal;authorize?:()=>void}):Promise<LarkImPage<Record<string,unknown>>>=>{
    if(Boolean(input.chatId)===Boolean(input.threadId))throw new ConnectorError('lark_im_input_invalid',400);
    await status();
    const current=captureRead({accountId:observed?.accountId??''});
    runOptions?.authorize?.();
    let value:Record<string,unknown>;
    try{value=await request({method:'GET',path:MESSAGE_PATH,query:{
      container_id_type:input.threadId?'thread':'chat',container_id:imId(input.threadId??input.chatId!),
      ...(input.startTime!==undefined?{start_time:optionalTime(input.startTime)}:{}),
      ...(input.endTime!==undefined?{end_time:optionalTime(input.endTime)}:{}),
      sort_type:'ByCreateTimeAsc',page_size:boundedInt(input.pageSize,50,1,50),
      ...(input.pageToken?{page_token:input.pageToken}:{}),
    }},runOptions?.signal?{signal:runOptions.signal}:undefined) as Record<string,unknown>;
    }finally{
      // A page shares this observed lease during all of its source commits.
      // No per-message CLI probes, account store or credential copy is added.
      await status();current();runOptions?.authorize?.();
    }
    // The message/list contract returns page_token for has_more=true, otherwise
    // no continuation. Allow absent/null/empty terminal tokens, not a nonempty
    // token conflicting with false. The fixed CLI decodes RawBody into a map;
    // it does not apply the SDK model's omitempty to has_more or items: [].
    const token=value?.page_token;
    if(!Array.isArray(value?.items)||value.items.some(item=>!item||typeof item!=='object'||Array.isArray(item))||typeof value.has_more!=='boolean'||token!=null&&typeof token!=='string'||value.has_more&&(!token||typeof token!=='string')||!value.has_more&&Boolean(token))throw new ConnectorError('lark_im_response_invalid',502);
    return {items:value.items as Record<string,unknown>[],hasMore:value.has_more,...(value.has_more?{pageToken:token as string}:{})};
  };

  const startAuthorization=async(requested:readonly string[]):Promise<LarkBindingAuthorization>=>{
    const current=await status();
    if(!current.connected)throw new ConnectorError('lark_not_connected',401);
    if(!current.configured)throw new ConnectorError('lark_not_configured',409);
    const extra=[...new Set(requested.filter(scope=>typeof scope==='string'&&/^[a-z][a-z0-9._:-]{0,100}$/.test(scope)))];
    if(!extra.length)throw new ConnectorError('lark_im_input_invalid',400);
    // Request the union so an incremental IM grant never drops the document,
    // calendar or recording scopes already stored on this account.
    const union=[...new Set([...current.scopes,...extra])];
    const value=larkJson(await runner({kind:'login',scopes:union}));
    const url=authorizationUrl(text(value?.verification_url));
    const deviceCode=text(value?.device_code);
    if(!url||!deviceCode)throw new ConnectorError('lark_authorization_invalid',502);
    const ttl=Number(value?.expires_in),expiresAt=Date.now()+(Number.isFinite(ttl)&&ttl>0?Math.min(ttl,900):600)*1000,id=randomUUID();
    pending.set(id,{deviceCode,expiresAt,scopes:union});
    return {id,authorizationUrl:url,expiresAt:new Date(expiresAt).toISOString()};
  };

  const completeAuthorization=async(id:string,signal?:AbortSignal)=>{
    const entry=pending.get(id);
    if(!entry)throw new ConnectorError('lark_authorization_state_invalid',400);
    if(Date.now()>=entry.expiresAt){pending.delete(id);throw new ConnectorError('lark_authorization_expired',409);}
    const timeout=AbortSignal.timeout(Math.max(1,entry.expiresAt-Date.now()));
    try{
      await runner({kind:'complete',deviceCode:entry.deviceCode},{signal:signal?AbortSignal.any([signal,timeout]):timeout});
    }catch(error){
      pending.delete(id);
      if(error instanceof ConnectorError&&error.code==='lark_operation_cancelled')throw new ConnectorError(timeout.aborted?'lark_authorization_expired':'lark_authorization_cancelled',409);
      throw error;
    }
    pending.delete(id);
    const next=await status();
    if(!next.connected)throw new ConnectorError('lark_not_connected',401);
    return next;
  };

  const sendMessage=async(input:{chatId:string;text:string;uuid?:string})=>{
    const current=await status();
    if(!current.connected)throw new ConnectorError('lark_not_connected',401);
    if(!larkSendScopesOk(current.scopes))throw new ConnectorError('lark_send_not_authorized',403);
    const chatId=imId(text(input.chatId)),value=text(input.text).trim();
    if(!value||value.length>MAX_TEXT)throw new ConnectorError('lark_im_input_invalid',400);
    const data=await envelope({kind:'im-send',chatId,text:value,...(input.uuid?{uuid:text(input.uuid).slice(0,50)}:{})}) as Record<string,unknown>;
    const messageId=text(data?.message_id);
    if(!messageId)throw new ConnectorError('lark_send_failed',502);
    return {messageId,...(text(data?.create_time)?{createTime:text(data.create_time)}:{}),...(text((data?.body as Record<string,unknown>|undefined)?.content)?{content:text((data.body as Record<string,unknown>).content)}:{})};
  };

  return {status,captureRead,onReadInvalidated,startAuthorization,completeAuthorization,cancelAuthorization:async id=>{pending.delete(id);},request,listChats,listMessages,sendMessage};
}
