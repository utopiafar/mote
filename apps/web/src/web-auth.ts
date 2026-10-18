import {ApiError,createApi,readApiError,readApiJson,type WebConnection} from './api';
import {moteText,getLocale} from '@mote/shared/i18n';
import {clearSession} from './session';

export const authChangeKey='mote.web-auth-change';
export const authChangeEvent='mote:auth-changing';
export const durationForLifetime={session:0,'1d':86400000,'7d':604800000,'30d':2592000000};
let sequence:Promise<unknown>=Promise.resolve();
let authenticationIntent=0;
function announce(){
  const change=JSON.stringify({id:crypto.randomUUID()});
  try{globalThis.localStorage?.setItem(authChangeKey,change);}catch{/* Cookie/session fences work with blocked storage. */}
  globalThis.window?.dispatchEvent(new Event(authChangeEvent));
}
/** Serialize Cookie-changing responses, including a dialog closed while login is pending.
 * Web Locks additionally serialize tabs; every private request still pins its session ID. */
export function changeWebAuthentication<T>(action:(isCurrent:()=>boolean)=>Promise<T>,retire=true):Promise<T>{
  const intent=++authenticationIntent;
  const run=async()=>{
    const mutation=async()=>{if(retire){announce();clearSession();}try{const result=await action(()=>intent===authenticationIntent);if(!retire){announce();clearSession();}return result;}finally{if(retire)announce();}};
    return globalThis.navigator?.locks ? navigator.locks.request('mote.web-auth',mutation) : mutation();
  };
  const result=sequence.then(run,run);sequence=result.catch(()=>{});return result;
}
export async function publicAuth<T>(path:string,body?:unknown):Promise<T>{
  const response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',redirect:'error',headers:{'X-Mote-Protocol-Version':'2','Accept-Language':getLocale(),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw await readApiError(response);
  return readApiJson<T>(response);
}
export async function discoverWebSession():Promise<WebConnection|null>{
  try{
    const self=await publicAuth<Record<string,unknown>>('/api/auth/self');
    if(!self||typeof self!=='object'||Array.isArray(self)||!['deploymentId','userId','credentialId','csrfToken','username'].every(key=>typeof self[key]==='string'&&Boolean(self[key])) || typeof self.administrator!=='boolean')throw Error(moteText('中央响应格式无效，请刷新后重试。'));
    return {mode:'web',origin:location.origin,deploymentId:self.deploymentId as string,userId:self.userId as string,credentialId:self.credentialId as string,csrfToken:self.csrfToken as string,username:self.username as string,administrator:self.administrator,viewScope:self.credentialId as string,...(typeof self.expiresAt==='number'?{expiresAt:self.expiresAt}:{})};
  }catch(error){if(error instanceof ApiError&&error.status===401)return null;throw error;}
}
export function loginWeb(username:string,password:string,durationMs:number):Promise<WebConnection>{
  return changeWebAuthentication(async isCurrent=>{
    const grant=await publicAuth<{deploymentId:string;userId:string;credentialId:string}>('/api/auth/login',{username,password,durationMs,mode:'web'});
    if(!grant||typeof grant!=='object'||!['deploymentId','userId','credentialId'].every(key=>typeof grant[key as keyof typeof grant]==='string'&&Boolean(grant[key as keyof typeof grant])))throw Error(moteText('中央响应格式无效，请刷新后重试。'));
    if(!isCurrent())throw Error(moteText('登录会话已改变，请重新登录。'));
    const session=await discoverWebSession();
    if(!isCurrent())throw Error(moteText('登录会话已改变，请重新登录。'));
    if(!session)throw Error(moteText('无法确认登录会话，请刷新页面并重新登录。'));
    if(session.deploymentId!==grant.deploymentId||session.userId!==grant.userId||session.credentialId!==grant.credentialId)throw Error(moteText('登录会话已改变，请重新登录。'));
    return session;
  });
}
export function logoutWeb(connection:WebConnection):Promise<void>{
  return changeWebAuthentication(async()=>{await createApi(connection).request('/api/auth/logout',{method:'POST',body:'{}'});});
}
