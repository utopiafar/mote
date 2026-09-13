import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnvironment } from '@mote/shared/environment';

export const repositoryRoot=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
export class ConfigError extends Error {
  constructor(readonly field:string,message:string){super(message);this.name='ConfigError';}
}
export function configFromEnv() {
  let environment:ReturnType<typeof loadEnvironment>;
  try{environment=loadEnvironment(repositoryRoot);}catch{throw new ConfigError('MOTE_ENV_FILE','The selected environment file is missing, unreadable or invalid');}
  const {env,baseDir}=environment;
  const number=(name:string,fallback:number,min:number,max:number,integer=false)=>{
    const n=Number(env[name]??fallback);
    if(!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isInteger(n)))throw new ConfigError(name,`${name} must be ${integer?'an integer ':''}between ${min} and ${max}`);
    return n;
  };
  const flag=(name:string,fallback:boolean)=>{const value=env[name];if(value===undefined)return fallback;if(value!=='0'&&value!=='1')throw new ConfigError(name,`${name} must be 0 or 1`);return value==='1';};
  const profile=env.MOTE_PROFILE||'legacy';
  if(!/^[a-z][a-z0-9-]{0,31}$/.test(profile))throw new ConfigError('MOTE_PROFILE','MOTE_PROFILE must be a short lowercase profile name');
  if(profile!=='legacy'&&!env.MOTE_ENV_FILE&&!env.MOTE_DATA_DIR)throw new ConfigError('MOTE_DATA_DIR','Named server profiles require MOTE_ENV_FILE or an explicit MOTE_DATA_DIR');
  const dataDir=resolve(baseDir,env.MOTE_DATA_DIR??'data');
  const logLevel=env.MOTE_LOG_LEVEL||'info';
  if(!['debug','info','warn','error','silent'].includes(logLevel))throw new ConfigError('MOTE_LOG_LEVEL','MOTE_LOG_LEVEL must be debug, info, warn, error or silent');
  const modelReasoningEffort=env.MOTE_MODEL_REASONING_EFFORT||'high';
  if(!['off','low','high','max'].includes(modelReasoningEffort))throw new ConfigError('MOTE_MODEL_REASONING_EFFORT','MOTE_MODEL_REASONING_EFFORT must be off, low, high or max');
  const config={
    host:env.MOTE_HOST||'127.0.0.1',port:number('MOTE_PORT',47832,1,65535,true),dataDir,
    profile,tokenFromEnvironment:Boolean(env.MOTE_TOKEN?.trim()),
    dataKey:env.MOTE_DATA_KEY||undefined,
    modelReasoningEffort:modelReasoningEffort as 'off'|'low'|'high'|'max',modelMaxTokens:number('MOTE_MODEL_MAX_TOKENS',8192,256,32768,true),
    maxStorageBytes:number('MOTE_MAX_STORAGE_MB',10240,1,1_000_000)*1024*1024,
    maxExportBytes:number('MOTE_MAX_EXPORT_MB',64,1,256)*1024*1024,
    retentionDays:number('MOTE_RETENTION_DAYS',0,0,36500),
    insightIntervalHours:number('MOTE_INSIGHT_INTERVAL_HOURS',0,0,168),
    allowedOrigins:(env.MOTE_ALLOWED_ORIGINS??'http://localhost:5173,http://127.0.0.1:5173').split(',').map(s=>s.trim()).filter(Boolean),
    model:env.MOTE_MODEL||'',modelBaseUrl:env.MOTE_MODEL_BASE_URL||'https://api.deepseek.com',apiKey:env.MOTE_MODEL_API_KEY||'',allowUnauthenticatedLocal:flag('MOTE_MODEL_ALLOW_UNAUTHENTICATED_LOCAL',false),
    embeddingModel:env.MOTE_EMBEDDING_MODEL||'',embeddingBaseUrl:env.MOTE_EMBEDDING_BASE_URL||'',embeddingApiKey:env.MOTE_EMBEDDING_API_KEY||'',
    diagnosticsEnabled:flag('MOTE_DIAGNOSTICS_ENABLED',true),diagnosticsDebug:flag('MOTE_DEBUG',false),
    logLevel:logLevel as 'debug'|'info'|'warn'|'error'|'silent',
    logDirectory:env.MOTE_LOG_DIR?resolve(baseDir,env.MOTE_LOG_DIR):join(dataDir,'logs'),
    logMaxBytes:number('MOTE_LOG_MAX_MB',2,0.1,8)*1024*1024,
    logMaxFiles:number('MOTE_LOG_MAX_FILES',3,1,10,true),logMaxEntries:number('MOTE_LOG_MAX_ENTRIES',2000,100,5000,true),
  };
  if(config.embeddingModel&&!config.embeddingBaseUrl)throw new ConfigError('MOTE_EMBEDDING_BASE_URL','MOTE_EMBEDDING_BASE_URL is required when embedding is enabled');
  mkdirSync(dataDir,{recursive:true,mode:0o700});
  const tokenPath=join(dataDir,'access-token');let token=env.MOTE_TOKEN?.trim();
  if(!token) {
    if(existsSync(tokenPath))token=readFileSync(tokenPath,'utf8').trim();
    else {token=randomBytes(32).toString('hex');writeFileSync(tokenPath,token+'\n',{mode:0o600,flag:'wx'});}
  }
  if(token.length<24)throw new ConfigError('MOTE_TOKEN','MOTE_TOKEN must contain at least 24 characters');
  return {...config,token,tokenPath};
}
type EnvironmentConfig=ReturnType<typeof configFromEnv>;
type OptionalFields='modelReasoningEffort'|'modelMaxTokens'|'profile'|'tokenFromEnvironment'|'diagnosticsEnabled'|'diagnosticsDebug'|'logLevel'|'logDirectory'|'logMaxBytes'|'logMaxFiles'|'logMaxEntries';
export type Config=Omit<EnvironmentConfig,OptionalFields> & Partial<Pick<EnvironmentConfig,OptionalFields>>;
