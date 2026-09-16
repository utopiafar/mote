import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnvironment } from '@mote/shared/environment';
import type { ConfigurationSource, ServerConfiguration } from '@mote/shared';
import { MODEL_PROTOCOLS, MODEL_REASONING_EFFORTS, modelProvider } from '@mote/shared/models';
import { validateModelOptions } from '@mote/agent';

export interface ConfigurationContext {
  envFile: string | null;
  baseDir: string;
  hostConfigFile: string | null;
  runtime: ServerConfiguration['runtime'];
  publicUrl: string | null;
  storageKind: ServerConfiguration['storage']['kind'];
  storageSource: string | null;
  storageMount: string | null;
  tunnelEnabled: boolean;
  tunnelProvider: string | null;
  tunnelProtocol: 'auto' | 'http2' | 'quic';
  sources: Record<string, ConfigurationSource>;
}

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
  const text=(name:string,fallback='')=>{const value=env[name]??fallback;if(value.length>4096||/[\r\n\0]/.test(value))throw new ConfigError(name,`${name} must be a bounded single-line value`);return value;};
  const endpoint=(name:string,fallback='',publicAddress=false)=>{
    const value=text(name)||fallback;if(!value)return '';
    let url:URL;try{url=new URL(value);}catch{throw new ConfigError(name,`${name} must be an absolute HTTP(S) URL`);}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new ConfigError(name,`${name} must be HTTP(S) without URL credentials, query or fragment`);
    if(publicAddress&&url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new ConfigError(name,`${name} requires HTTPS outside loopback`);
    if(publicAddress&&url.pathname!=='/')throw new ConfigError(name,`${name} must be an origin without a path prefix`);
    return value;
  };
  const choice=<T extends string>(name:string,values:readonly T[],fallback:T):T=>{const value=text(name)||fallback;if(!values.includes(value as T))throw new ConfigError(name,`${name} has an unsupported value`);return value as T;};
  const profile=env.MOTE_PROFILE||'legacy';
  if(!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(profile))throw new ConfigError('MOTE_PROFILE','MOTE_PROFILE must be a short lowercase profile name');
  if(profile!=='legacy'&&!env.MOTE_ENV_FILE&&!env.MOTE_DATA_DIR)throw new ConfigError('MOTE_DATA_DIR','Named server profiles require MOTE_ENV_FILE or an explicit MOTE_DATA_DIR');
  const dataDir=resolve(baseDir,env.MOTE_DATA_DIR??'data');
  const logLevel=env.MOTE_LOG_LEVEL||'info';
  if(!['debug','info','warn','error','silent'].includes(logLevel))throw new ConfigError('MOTE_LOG_LEVEL','MOTE_LOG_LEVEL must be debug, info, warn, error or silent');
  const modelProviderId=text('MOTE_MODEL_PROVIDER','deepseek');
  const preset=modelProvider(modelProviderId);
  if(!preset)throw new ConfigError('MOTE_MODEL_PROVIDER','Choose a supported provider or custom');
  const modelProtocol=choice('MOTE_MODEL_PROTOCOL',MODEL_PROTOCOLS,preset.protocol);
  const modelReasoningEffort=choice('MOTE_MODEL_REASONING_EFFORT',MODEL_REASONING_EFFORTS,modelProtocol==='deepseek'?'high':'auto');
  const jsonObject=(name:string):Record<string,unknown>=>{
    const value=env[name];if(!value)return {};
    try{if(Buffer.byteLength(value)>16384)throw new Error();const parsed:unknown=JSON.parse(value);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();return parsed as Record<string,unknown>;}
    catch{throw new ConfigError(name,`${name} must be a JSON object up to 16 KiB`);}
  };
  const modelHeaders=jsonObject('MOTE_MODEL_HEADERS') as Record<string,string>,modelExtraBody=jsonObject('MOTE_MODEL_EXTRA_BODY');
  let fileProcessorModules:string[]=[];
  try{fileProcessorModules=JSON.parse(env.MOTE_FILE_PROCESSOR_PLUGINS??'[]');if(!Array.isArray(fileProcessorModules)||fileProcessorModules.length>30||fileProcessorModules.some(s=>typeof s!=='string'||s.length>2000))throw Error();}catch{throw new ConfigError('MOTE_FILE_PROCESSOR_PLUGINS','Use a JSON array of trusted installed plugin modules');}
  const config={
    fileProcessorModules,
    host:env.MOTE_HOST||'127.0.0.1',port:number('MOTE_PORT',47832,1,65535,true),dataDir,
    profile,tokenFromEnvironment:Boolean(env.MOTE_TOKEN?.trim()),
    updateRepository:text('MOTE_UPDATE_REPOSITORY','utopiafar/mote'),updateChannel:choice('MOTE_UPDATE_CHANNEL',['stable','preview'] as const,'stable'),
    dataKey:text('MOTE_DATA_KEY')||undefined,contentEncryptionEnabled:flag('MOTE_CONTENT_ENCRYPTION',false),
    modelProvider:modelProviderId,modelProtocol,modelHeaders,modelExtraBody,
    modelReasoningEffort,modelMaxTokens:number('MOTE_MODEL_MAX_TOKENS',8192,1,128000,true),
    modelTimeoutMs:number('MOTE_MODEL_TIMEOUT_MS',120000,5000,600000,true),
    maxStorageBytes:number('MOTE_MAX_STORAGE_MB',10240,1,1_000_000)*1024*1024,
    maxExportBytes:number('MOTE_MAX_EXPORT_MB',64,1,256)*1024*1024,
    retentionDays:number('MOTE_RETENTION_DAYS',0,0,36500),
    insightIntervalHours:number('MOTE_INSIGHT_INTERVAL_HOURS',0,0,168),
    allowedOrigins:(env.MOTE_ALLOWED_ORIGINS??'http://localhost:5173,http://127.0.0.1:5173').split(',').map(s=>s.trim()).filter(Boolean),
    model:text('MOTE_MODEL'),modelBaseUrl:endpoint('MOTE_MODEL_BASE_URL',preset.baseUrl),apiKey:text('MOTE_MODEL_API_KEY'),allowUnauthenticatedLocal:flag('MOTE_MODEL_ALLOW_UNAUTHENTICATED_LOCAL',preset.allowUnauthenticatedLocal??false),
    embeddingModel:text('MOTE_EMBEDDING_MODEL'),embeddingBaseUrl:endpoint('MOTE_EMBEDDING_BASE_URL'),embeddingApiKey:text('MOTE_EMBEDDING_API_KEY'),
    connectors:{directory:join(dataDir,'connectors'),mcpEnabled:flag('MOTE_MCP_ENABLED',false),mcpReadToken:text('MOTE_MCP_READ_TOKEN'),mcpWriteEnabled:flag('MOTE_MCP_WRITE_ENABLED',false),mcpWriteToken:text('MOTE_MCP_WRITE_TOKEN'),mcpWriteSourceIds:text('MOTE_MCP_WRITE_SOURCE_IDS').split(',').map(s=>s.trim()).filter(Boolean),googleClientId:text('MOTE_GOOGLE_CLIENT_ID'),googleClientSecret:text('MOTE_GOOGLE_CLIENT_SECRET'),googleRedirectUri:endpoint('MOTE_GOOGLE_REDIRECT_URI'),syncIntervalMs:number('MOTE_CONNECTOR_SYNC_INTERVAL_SECONDS',900,60,86400,true)*1000,allowLocalMcp:flag('MOTE_MCP_ALLOW_LOCAL',false)},
    diagnosticsEnabled:flag('MOTE_DIAGNOSTICS_ENABLED',true),diagnosticsDebug:flag('MOTE_DEBUG',false),
    logLevel:logLevel as 'debug'|'info'|'warn'|'error'|'silent',
    logDirectory:env.MOTE_LOG_DIR?resolve(baseDir,env.MOTE_LOG_DIR):join(dataDir,'logs'),
    logMaxBytes:number('MOTE_LOG_MAX_MB',2,0.1,8)*1024*1024,
    logMaxFiles:number('MOTE_LOG_MAX_FILES',3,1,10,true),logMaxEntries:number('MOTE_LOG_MAX_ENTRIES',2000,100,5000,true),
  };
  try{validateModelOptions({provider:config.modelProvider,protocol:config.modelProtocol,baseUrl:config.modelBaseUrl,model:config.model,reasoningEffort:config.modelReasoningEffort,maxTokens:config.modelMaxTokens,headers:modelHeaders,extraBody:modelExtraBody});}
  catch{throw new ConfigError('MOTE_MODEL_PROTOCOL','Model protocol, endpoint or advanced parameters are invalid');}
  const c=config.connectors;
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(config.updateRepository))throw new ConfigError('MOTE_UPDATE_REPOSITORY','Use a GitHub owner/repository identifier');
  if(c.mcpEnabled&&c.mcpReadToken.length<32)throw new ConfigError('MOTE_MCP_READ_TOKEN','Enabled MCP requires a distinct random token of at least 32 characters');
  if(c.mcpWriteEnabled&&(!c.mcpEnabled||c.mcpWriteToken.length<32||c.mcpWriteToken===c.mcpReadToken))throw new ConfigError('MOTE_MCP_WRITE_TOKEN','MCP write requires enabled MCP and a distinct token of at least 32 characters');
  if(c.mcpWriteSourceIds.some(id=>!(/^[a-zA-Z0-9_.:-]{1,128}$/.test(id)))||(c.mcpWriteEnabled&&!c.mcpWriteSourceIds.length))throw new ConfigError('MOTE_MCP_WRITE_SOURCE_IDS','Choose one or more exact source IDs for MCP writes');
  if(c.googleRedirectUri){const u=new URL(c.googleRedirectUri);if((u.protocol!=='https:'&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname))||u.pathname!=='/oauth/google/callback')throw new ConfigError('MOTE_GOOGLE_REDIRECT_URI','Use HTTPS outside loopback and the exact /oauth/google/callback path');}
  if([c.googleClientId,c.googleClientSecret,c.googleRedirectUri].some(Boolean)&&![c.googleClientId,c.googleClientSecret,c.googleRedirectUri].every(Boolean))throw new ConfigError('MOTE_GOOGLE_CLIENT_ID','Google authorization requires client id, client secret and redirect URI together');
  if(config.dataKey&&!/^[0-9a-f]{64}$/i.test(config.dataKey))throw new ConfigError('MOTE_DATA_KEY','MOTE_DATA_KEY must contain exactly 64 hexadecimal characters');
  if(config.embeddingModel&&!config.embeddingBaseUrl)throw new ConfigError('MOTE_EMBEDDING_BASE_URL','MOTE_EMBEDDING_BASE_URL is required when embedding is enabled');
  for(const origin of config.allowedOrigins) {
    let parsed:URL;try{parsed=new URL(origin);}catch{throw new ConfigError('MOTE_ALLOWED_ORIGINS','Allowed origins must be absolute HTTP(S) origins');}
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash||parsed.pathname!=='/')throw new ConfigError('MOTE_ALLOWED_ORIGINS','Allowed origins cannot contain paths, credentials, query or fragment');
  }
  const runtime=choice('MOTE_RUNTIME',['native','docker','unknown'] as const,'unknown');
  const configuration:ConfigurationContext={
    envFile:environment.envFile??null,baseDir,hostConfigFile:text('MOTE_CONFIG_FILE')||null,runtime,
    publicUrl:endpoint('MOTE_PUBLIC_URL','',true)||null,
    storageKind:choice('MOTE_STORAGE_KIND',['local-directory','docker-volume','bind-mount','unknown'] as const,runtime==='native'?'local-directory':'unknown'),
    storageSource:text('MOTE_STORAGE_SOURCE')||null,storageMount:text('MOTE_STORAGE_MOUNT')||null,
    tunnelEnabled:flag('MOTE_TUNNEL_ENABLED',false),tunnelProvider:text('MOTE_TUNNEL_PROVIDER')||null,
    tunnelProtocol:choice('MOTE_TUNNEL_PROTOCOL',['auto','http2','quic'] as const,'auto'),
    sources:Object.fromEntries(Object.keys(env).filter(name=>name.startsWith('MOTE_')).map(name=>[name,process.env[name]!==undefined?'environment':'env-file'])),
  };
  for(const name of ['MOTE_PROFILE','MOTE_LOG_LEVEL','MOTE_MODEL_REASONING_EFFORT','MOTE_MODEL_BASE_URL','MOTE_RUNTIME','MOTE_STORAGE_KIND','MOTE_TUNNEL_PROTOCOL'])if(!env[name])delete configuration.sources[name];
  const suppliedToken=text('MOTE_TOKEN').trim();
  if(suppliedToken&&suppliedToken.length<24)throw new ConfigError('MOTE_TOKEN','MOTE_TOKEN must contain at least 24 characters');
  mkdirSync(dataDir,{recursive:true,mode:0o700});
  const tokenPath=join(dataDir,'access-token');let token=suppliedToken;
  if(!token) {
    if(existsSync(tokenPath))token=readFileSync(tokenPath,'utf8').trim();
    else {token=randomBytes(32).toString('hex');writeFileSync(tokenPath,token+'\n',{mode:0o600,flag:'wx'});}
  }
  if(token.length<24)throw new ConfigError('MOTE_TOKEN','MOTE_TOKEN must contain at least 24 characters');
  if(/[\r\n\0]/.test(token))throw new ConfigError('MOTE_TOKEN','MOTE_TOKEN must be a single-line credential');
  if([c.mcpReadToken,c.mcpWriteToken].filter(Boolean).includes(token))throw new ConfigError('MOTE_MCP_READ_TOKEN','MCP tokens must be distinct from the node owner token');
  return {...config,token,tokenPath,configuration};
}
type EnvironmentConfig=ReturnType<typeof configFromEnv>;
type OptionalFields='contentEncryptionEnabled'|'fileProcessorModules'|'modelProvider'|'modelProtocol'|'modelHeaders'|'modelExtraBody'|'updateRepository'|'updateChannel'|'connectors'|'configuration'|'modelReasoningEffort'|'modelMaxTokens'|'modelTimeoutMs'|'profile'|'tokenFromEnvironment'|'diagnosticsEnabled'|'diagnosticsDebug'|'logLevel'|'logDirectory'|'logMaxBytes'|'logMaxFiles'|'logMaxEntries';
export type Config=Omit<EnvironmentConfig,OptionalFields> & Partial<Pick<EnvironmentConfig,OptionalFields>>;
