import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import type {RecordingAuthorizationStatus,RecordingEnvironment} from '@mote/shared';
import {ConnectorError} from '../connectors/types.js';
import type {RecordingConnector,RecordingBindingGrant} from '../connectors/recordings.js';

export type AuthorizationProgress={authorizationUrl:string;expiresAt?:string};
export interface RecordingAuthorizationPort {
 check(signal:AbortSignal):Promise<RecordingEnvironment>;
 setup?(signal:AbortSignal,progress:(value:AuthorizationProgress)=>void):Promise<void>;
 configure?(value:unknown,signal:AbortSignal):Promise<void>;
 login(signal:AbortSignal,progress:(value:AuthorizationProgress)=>void):Promise<void>;
}
const requestSchema=z.object({operationId:z.string().uuid(),expectedRevision:z.string().uuid(),payload:z.unknown().optional()}).strict();
/** The current non-replayable authorization belongs to this server lifetime.
 * Polling cannot mint another vendor device grant. No vendor secrets are saved. */
export class RecordingAuthorization {
 private revision=randomUUID();private receipt?:RecordingAuthorizationStatus['task'];private commandHash?:string;
 private controller?:AbortController;private active?:Promise<void>;private closed=false;private environment?:RecordingEnvironment;private checks=new Map<AbortController,Promise<unknown>>();
 constructor(private connector:RecordingConnector,private port:RecordingAuthorizationPort){}
 status():RecordingAuthorizationStatus{return {revision:this.revision,...(this.environment?{environment:{...this.environment}}:{}),...(this.receipt?{task:{...this.receipt}}:{})};}
 async check(){if(this.closed)throw new ConnectorError('connector_closed',503);const revision=this.revision,controller=new AbortController();const pending=this.port.check(controller.signal);this.checks.set(controller,pending);try{const environment=await pending;if(!this.closed&&revision===this.revision)this.environment=environment;return this.status();}finally{this.checks.delete(controller);}}

 start(kind:'setup'|'configure'|'login',raw:unknown){
  const request=requestSchema.parse(raw),fingerprint=createHash('sha256').update(JSON.stringify([kind,request.payload??{}])).digest('hex');
  if(this.closed)throw new ConnectorError('connector_closed',503);
  if(this.receipt?.id===request.operationId){if(fingerprint!==this.commandHash)throw new ConnectorError('recording_authorization_conflict',409);return this.status();}
  if(request.expectedRevision!==this.revision)throw new ConnectorError('recording_authorization_changed',409);
  if(this.active)throw new ConnectorError('recording_authorization_busy',409);
  if(kind!=='login'&&!this.port[kind])throw new ConnectorError('connector_operation_invalid',400);
  const revision=this.revision=randomUUID(),controller=this.controller=new AbortController();
  const task=this.receipt={id:request.operationId,kind,state:'running' as const} as NonNullable<RecordingAuthorizationStatus['task']>;this.commandHash=fingerprint;
  const assertCurrent=()=>{controller.signal.throwIfAborted();if(this.closed||revision!==this.revision||this.receipt!==task)throw new ConnectorError('recording_authorization_changed',409);};
  const grant:RecordingBindingGrant={signal:controller.signal,assertCurrent};
  const progress=(value:AuthorizationProgress)=>{assertCurrent();Object.assign(task,value,{state:'waiting'});};
  this.active=Promise.resolve().then(async()=>{
   if(kind==='setup'||kind==='configure'){await this.drainChecks();assertCurrent();await this.connector.retireAuthorization(grant);}
   assertCurrent();
   if(kind==='setup')await this.port.setup!(controller.signal,progress);
   else if(kind==='configure')await this.port.configure!(request.payload,controller.signal);
   else {await this.port.login(controller.signal,progress);assertCurrent();await this.connector.connect(grant);}
   assertCurrent();this.environment=await this.port.check(controller.signal);assertCurrent();task.state='completed';
  }).catch(error=>{if(this.receipt!==task)return;task.state=controller.signal.aborted?'cancelled':'failed';task.error=controller.signal.aborted?'recording_authorization_cancelled':error instanceof ConnectorError?error.code:error instanceof z.ZodError?'recording_authorization_invalid':'recording_authorization_failed';}).finally(()=>{delete task.authorizationUrl;delete task.expiresAt;if(this.receipt===task){this.active=undefined;this.controller=undefined;}});
  return this.status();
 }
 private async drainChecks(){for(const controller of this.checks.keys())controller.abort();await Promise.allSettled(this.checks.values());}
 async cancel(raw?:unknown){if(raw!==undefined){const target=z.object({expectedRevision:z.string().uuid(),taskId:z.string().uuid()}).strict().parse(raw);if(target.expectedRevision!==this.revision||target.taskId!==this.receipt?.id)throw new ConnectorError('recording_authorization_changed',409);}this.revision=randomUUID();this.controller?.abort();if(this.receipt&&['running','waiting'].includes(this.receipt.state)){this.receipt.state='cancelled';delete this.receipt.authorizationUrl;delete this.receipt.expiresAt;}await Promise.all([this.active,this.drainChecks()]);return this.status();}
 async close(){this.closed=true;await this.cancel();}
}

import {authorizationOutput} from '../connectors/authorization-output.js';
import {authorizationUrl,larkJson,LARK_VERSION,type LarkRunner} from '../connectors/lark-cli.js';
import {cliReleases} from '../connectors/cli-runtime.mjs';
import type {DwsRunner} from '../connectors/dingtalk-recordings.js';
const DWS_VERSION=cliReleases.dingtalk.version;
const recordingScopes=['minutes:minutes.basic:read','minutes:minutes.artifacts:read','minutes:minutes.media:export','minutes:minutes.search:read'];
const configureSchema=z.object({appId:z.string().regex(/^cli_[A-Za-z0-9]+$/).max(100),secret:z.string().min(1).max(1000).refine(value=>!/[\r\n\0]/.test(value)),brand:z.enum(['feishu','lark'])}).strict();
export function larkRecordingAuthorization(runner:LarkRunner):RecordingAuthorizationPort{return {
 async check(signal){let installed=false,version:string|undefined;try{version=(await runner({kind:'version'},{signal})).match(/\b\d+\.\d+\.\d+\b/)?.[0];installed=true;if(version!==LARK_VERSION)throw new ConnectorError('lark_cli_version_unsupported',503);const status=larkJson(await runner({kind:'status'},{signal}));return {installed,version,configured:typeof status.appId==='string'&&Boolean(status.appId)};}catch(error){return {installed,version,configured:false,error:error instanceof ConnectorError?error.code:'recording_environment_check_failed'};}},
 async setup(signal,progress){await runner({kind:'setup'},{signal,onOutput:authorizationOutput('lark',authorizationUrl=>progress({authorizationUrl}))});},
 async configure(value,signal){await runner({kind:'configure',...configureSchema.parse(value)},{signal});},
 async login(signal,progress){const raw=larkJson(await runner({kind:'login',scopes:recordingScopes},{signal})),value=z.object({verification_url:z.string(),device_code:z.string().min(1).max(4000),expires_in:z.number().positive().max(600)}).parse(raw),url=authorizationUrl(value.verification_url);if(!url)throw new ConnectorError('lark_authorization_url_invalid',502);
  progress({authorizationUrl:url,expiresAt:new Date(Date.now()+value.expires_in*1000).toISOString()});const expires=AbortSignal.timeout(value.expires_in*1000);try{await runner({kind:'complete',deviceCode:value.device_code},{signal:AbortSignal.any([signal,expires])});}catch(error){if(expires.aborted&&!signal.aborted)throw new ConnectorError('lark_authorization_expired',409);throw error;}
 },
};}
export function dwsRecordingAuthorization(runner:DwsRunner):RecordingAuthorizationPort{return {
 async check(signal){let installed=false,version:string|undefined;try{const result=await runner({kind:'version'},undefined,signal) as any;version=String(result?.version??result?.data?.version).replace(/^v/,'');installed=true;if(version!==DWS_VERSION)throw new ConnectorError('dingtalk_cli_version_unsupported',503);return {installed,version,configured:true};}catch(error){return {installed,version,configured:false,error:error instanceof ConnectorError?error.code:'recording_environment_check_failed'};}},
 async login(signal,progress){await runner({kind:'login'},undefined,signal,authorizationOutput('dingtalk',authorizationUrl=>progress({authorizationUrl})));},
};}
