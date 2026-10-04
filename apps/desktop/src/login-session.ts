import { createHash, randomBytes } from 'node:crypto';
import type { Config } from './contracts';
import { validateServerUrl } from './config';
import { moteText } from '@mote/shared/i18n';
import { readResponseText } from './response-body';
export type LoginSettings = {token?:string;authSignedOut?:boolean;authExpiresAt?:number;authSourceBinding?:string};
export function validSourceBinding(value:string|undefined):string|undefined {
  if(value!==undefined&&!/^[a-f0-9]{64}$/.test(value))throw Error('Invalid source checkpoint binding');return value;
}
export function sourceConnectionBinding(config:LoginSettings&{serverUrl:string}):string {
  return config.token ? createHash('sha256').update(config.serverUrl+':'+config.token).digest('hex') : validSourceBinding(config.authSourceBinding) ?? createHash('sha256').update(config.serverUrl+':').digest('hex');
}
export function connectionToken(config:LoginSettings,now=Date.now()):string|undefined {
  return !config.authSignedOut&&(!config.authExpiresAt||config.authExpiresAt>now)?config.token:undefined;
}
export function requireConnectionToken(config:LoginSettings):string {
  const token=connectionToken(config);if(!token)throw Error(moteText('请先登录中央节点，各页面会共用这次登录。'));return token;
}
export async function loginRequest(config:Pick<Config,'serverUrl'>,path:string,body:unknown,token?:string):Promise<any>{
  const response=await fetch(validateServerUrl(config.serverUrl)+path,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
  if(!response.ok){await response.body?.cancel();throw Error(moteText('中央请求失败（HTTP {0}），请稍后重试。',response.status));}
  return JSON.parse(await readResponseText(response,16384));
}
export function loginVerifier(){const verifier=randomBytes(32).toString('base64url');return {verifier,challenge:createHash('sha256').update(verifier).digest('hex')};}
