import { readFileSync,existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
dotenv.config({path:resolve('.env'),quiet:true});
export function apiClient() {
  const url=(process.env.MOTE_URL||'http://127.0.0.1:47832').replace(/\/$/,'');
  const parsed=new URL(url);
  if(parsed.protocol!=='https:' && !(parsed.protocol==='http:'&&(['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)||process.env.MOTE_ALLOW_INSECURE_HTTP==='1')))throw new Error('Remote HTTP requires MOTE_ALLOW_INSECURE_HTTP=1; prefer HTTPS');
  const path=resolve(process.env.MOTE_TOKEN_FILE||'data/access-token');
  const token=process.env.MOTE_TOKEN|| (existsSync(path)?readFileSync(path,'utf8').trim():'');
  if(!token)throw new Error('Set MOTE_TOKEN or MOTE_TOKEN_FILE; start the central node once to generate a token');
  return async function request(path:string,body?:unknown,method=body?'POST':'GET') {
    const response=await fetch(url+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(180000),redirect:'error'});
    if(!response.ok){const text=await response.text();throw new Error(`HTTP ${response.status}: ${text.slice(0,400)}`);}
    return response.json();
  };
}
