import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const repositoryRoot=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
dotenv.config({path:join(repositoryRoot,'.env'),quiet:true});
const number=(name:string,fallback:number,min:number,max:number)=>{const n=Number(process.env[name]??fallback);if(!Number.isFinite(n)||n<min||n>max)throw new Error(`${name} must be between ${min} and ${max}`);return n;};
export function configFromEnv() {
  const dataDir=resolve(repositoryRoot,process.env.MOTE_DATA_DIR??'data');
  mkdirSync(dataDir,{recursive:true,mode:0o700});
  const tokenPath=join(dataDir,'access-token');let token=process.env.MOTE_TOKEN?.trim();
  if(!token) {
    if(existsSync(tokenPath))token=readFileSync(tokenPath,'utf8').trim();
    else {token=randomBytes(32).toString('hex');writeFileSync(tokenPath,token+'\n',{mode:0o600,flag:'wx'});}
  }
  if(token.length<24)throw new Error('MOTE_TOKEN must contain at least 24 characters');
  const host=process.env.MOTE_HOST||'127.0.0.1';
  const config={
    host, port:number('MOTE_PORT',47832,1,65535),dataDir,token,tokenPath,
    dataKey:process.env.MOTE_DATA_KEY||undefined,
    maxStorageBytes:number('MOTE_MAX_STORAGE_MB',10240,1,1_000_000)*1024*1024,
    maxExportBytes:number('MOTE_MAX_EXPORT_MB',64,1,256)*1024*1024,
    retentionDays:number('MOTE_RETENTION_DAYS',0,0,36500),
    insightIntervalHours:number('MOTE_INSIGHT_INTERVAL_HOURS',0,0,168),
    allowedOrigins:(process.env.MOTE_ALLOWED_ORIGINS??'http://localhost:5173,http://127.0.0.1:5173').split(',').map(s=>s.trim()).filter(Boolean),
    model:process.env.MOTE_MODEL||'',modelBaseUrl:process.env.MOTE_MODEL_BASE_URL||'https://api.deepseek.com',apiKey:process.env.MOTE_MODEL_API_KEY||'',allowUnauthenticatedLocal:process.env.MOTE_MODEL_ALLOW_UNAUTHENTICATED_LOCAL==='1',
    embeddingModel:process.env.MOTE_EMBEDDING_MODEL||'',embeddingBaseUrl:process.env.MOTE_EMBEDDING_BASE_URL||'',embeddingApiKey:process.env.MOTE_EMBEDDING_API_KEY||'',
  };
  if(config.embeddingModel&&!config.embeddingBaseUrl)throw new Error('MOTE_EMBEDDING_BASE_URL is required when embedding is enabled');
  return config;
}
export type Config=ReturnType<typeof configFromEnv>;
