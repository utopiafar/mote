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
export interface LarkBindingAuthorization {id:string;authorizationUrl:string;expiresAt:string}
/** Trusted host binding for the one existing Lark account. The official
 * package never spawns the CLI, reads its profile or accepts an arbitrary
 * method/path; this adapter owns all of that and only dispatches fixed IM
 * commands. Sending is reachable only through the connector action path. */
export interface LarkBinding {
  status():Promise<LarkBindingStatus>;
  startAuthorization(scopes:readonly string[]):Promise<LarkBindingAuthorization>;
  completeAuthorization(id:string,signal?:AbortSignal):Promise<LarkBindingStatus>;
  cancelAuthorization(id:string):Promise<void>;
  request(input:LarkBindingRequest):Promise<unknown>;
  listChats(input?:{pageToken?:string;pageSize?:number}):Promise<LarkImPage<LarkImChat>>;
  listMessages(input:{chatId:string;startTime?:string;endTime?:string;pageToken?:string;pageSize?:number}):Promise<LarkImPage<Record<string,unknown>>>;
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

  const status=async():Promise<LarkBindingStatus>=>{
    let installed=false,configured=false;
    try{
      await runner({kind:'version'});
      installed=true;
      const value=larkJson(await runner({kind:'status'})),user=value?.identities?.user;
      configured=typeof value?.appId==='string'&&value.appId.length>0;
      const connected=user?.available===true&&typeof user?.openId==='string';
      return {
        installed,configured,connected,
        ...(connected&&configured?{accountId:hash(`${value.appId}:${user.openId}`)}:{}),
        ...(connected&&typeof user?.userName==='string'?{accountName:user.userName.slice(0,200)}:{}),
        scopes:scopes(user?.scope),
      };
    }catch(error){
      return {installed,configured,connected:false,scopes:[],error:code(error)};
    }
  };

  const envelope=async(command:LarkCommand,runOptions?:{signal?:AbortSignal})=>{
    const value=larkJson(await runner(command,runOptions));
    return value?.data??value;
  };

  const request=async(input:LarkBindingRequest):Promise<unknown>=>{
    if(larkImRequestKind(input.method,input.path)!=='read')throw new ConnectorError('lark_im_path_blocked',403);
    const query=input.query??{};
    if(input.path===CHAT_PATH){
      allowedQuery(query,['page_token','page_size']);
      return envelope({kind:'im-chats',
        ...(query.page_token?{pageToken:String(query.page_token)}:{}),
        pageSize:boundedInt(query.page_size,100,1,100)});
    }
    allowedQuery(query,['container_id_type','container_id','start_time','end_time','sort_type','page_size','page_token']);
    if(query.container_id_type!=='chat')throw new ConnectorError('lark_im_input_invalid',400);
    const chatId=imId(text(query.container_id));
    if(query.sort_type!==undefined&&query.sort_type!=='ByCreateTimeAsc')throw new ConnectorError('lark_im_input_invalid',400);
    return envelope({kind:'im-messages',chatId,
      ...(optionalTime(query.start_time)?{startTime:String(query.start_time)}:{}),
      ...(optionalTime(query.end_time)?{endTime:String(query.end_time)}:{}),
      ...(query.page_token?{pageToken:String(query.page_token)}:{}),
      pageSize:boundedInt(query.page_size,50,1,50)});
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

  const listMessages=async(input:{chatId:string;startTime?:string;endTime?:string;pageToken?:string;pageSize?:number}):Promise<LarkImPage<Record<string,unknown>>>=>{
    const chatId=imId(input.chatId);
    const value=await request({method:'GET',path:MESSAGE_PATH,query:{
      container_id_type:'chat',container_id:chatId,
      ...(input.startTime?{start_time:optionalTime(input.startTime)}:{}),
      ...(input.endTime?{end_time:optionalTime(input.endTime)}:{}),
      sort_type:'ByCreateTimeAsc',page_size:boundedInt(input.pageSize,50,1,50),
      ...(input.pageToken?{page_token:input.pageToken}:{}),
    }}) as Record<string,unknown>;
    return {items:Array.isArray(value?.items)?value.items as Record<string,unknown>[]:[],hasMore:value?.has_more===true,...(text(value?.page_token)?{pageToken:text(value.page_token)}:{})};
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

  return {status,startAuthorization,completeAuthorization,cancelAuthorization:async id=>{pending.delete(id);},request,listChats,listMessages,sendMessage};
}
