import { createHash } from 'node:crypto';
import { readFileSync,existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvironment } from '@mote/shared/environment';
const {env,baseDir,envFile}=loadEnvironment(fileURLToPath(new URL('../',import.meta.url)));
export const resolvedConnection={url:(env.MOTE_URL||`http://127.0.0.1:${env.MOTE_PORT||47832}`).replace(/\/$/,''),baseDir,envFile,profileDirectory:env.MOTE_ENV_FILE?baseDir:undefined,profile:env.MOTE_PROFILE||'legacy'};
export function apiClient() {
  const url=resolvedConnection.url;
  const parsed=new URL(url);
  if(parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error('Node URL cannot contain credentials, query parameters or fragments');
  if(parsed.protocol!=='https:' && !(parsed.protocol==='http:'&&(['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)||env.MOTE_ALLOW_INSECURE_HTTP==='1')))throw new Error('Remote HTTP requires MOTE_ALLOW_INSECURE_HTTP=1; prefer HTTPS');
  const path=resolve(baseDir,env.MOTE_TOKEN_FILE||`${env.MOTE_DATA_DIR||'data'}/access-token`);
  const token=env.MOTE_TOKEN|| (existsSync(path)?readFileSync(path,'utf8').trim():'');
  if(!token)throw new Error('Set MOTE_TOKEN or MOTE_TOKEN_FILE; start the central node once to generate a token');
  return Object.assign(async function request(path:string,body?:unknown,method=body?'POST':'GET',signal?:AbortSignal) {
    const response=await fetch(url+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':body instanceof Uint8Array?'application/octet-stream':'application/json'},...(body?{body:body instanceof Uint8Array?new Uint8Array(body):JSON.stringify(body)}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000),redirect:'error'});
    if(!response.ok){const text=await response.text();throw Object.assign(new Error(`HTTP ${response.status}: ${text.slice(0,400)}`),{httpStatus:response.status});}
    return response.json();
  }, { binding: createHash('sha256').update(url + '\0' + token).digest('hex') });
}
