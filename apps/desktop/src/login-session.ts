import { createHash, randomBytes } from 'node:crypto';
import type { Config } from './contracts';
import { validateServerUrl } from './config';
import { moteText } from '@mote/shared/i18n';
import { readResponseText } from './response-body';
import {accountKey,DESKTOP_PROTOCOL_HEADERS} from './account';
import {httpFailureMessage,responseFailureCode} from '@mote/shared';
export type LoginSettings = {account?:Config['account'];token?:string;authSignedOut?:boolean;authExpiresAt?:number;authSourceBinding?:string};
export function validSourceBinding(value:string|undefined):string|undefined {
  if(value!==undefined&&!/^[a-f0-9]{64}$/.test(value))throw Error('Invalid source checkpoint binding');return value;
}
export function sourceConnectionBinding(config:LoginSettings&{serverUrl:string}):string {
  return accountKey(config) ?? (config.token ? createHash('sha256').update(config.serverUrl+':'+config.token).digest('hex') : validSourceBinding(config.authSourceBinding) ?? createHash('sha256').update(config.serverUrl+':').digest('hex'));
}
export function connectionToken(config:LoginSettings,now=Date.now()):string|undefined {
  return !config.authSignedOut&&(!config.authExpiresAt||config.authExpiresAt>now)?config.token:undefined;
}
export function requireConnectionToken(config:LoginSettings):string {
  const token=connectionToken(config);if(!token)throw Error(moteText('请先登录中央节点，各页面会共用这次登录。'));return token;
}
export async function loginRequest(config:Pick<Config,'serverUrl'>,path:string,body:unknown,token?:string):Promise<any>{
  const response=await fetch(validateServerUrl(config.serverUrl)+path,{method:'POST',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000),headers:{...DESKTOP_PROTOCOL_HEADERS,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
  if(!response.ok){let code:string|undefined;try{code=responseFailureCode(JSON.parse(await readResponseText(response,16384)));}catch{}throw Error(httpFailureMessage(response.status,code));}
  const text=await readResponseText(response,16384);
  try{return JSON.parse(text);}catch{throw Error(httpFailureMessage(response.status,'invalid_response'));}
}
export function loginVerifier(){const verifier=randomBytes(32).toString('base64url');return {verifier,challenge:createHash('sha256').update(verifier).digest('hex')};}
