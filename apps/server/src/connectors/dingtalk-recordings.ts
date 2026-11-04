import {spawn} from 'node:child_process';
import {dwsRecordingAuthorization} from '../plugins/recording-authorization.js';
import {cliReleases,managedCliBinary} from './cli-runtime.mjs';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {z} from 'zod';
import {FILE_MAX_BYTES,transcriptSchema} from '@mote/shared';
import {ExecutionFailure} from '../execution-engine.js';
import {ConnectorError} from './types.js';
import type {RecordingProvider,RecordingAccount} from './recordings.js';
import {recordingMime,splitTranscriptText} from './recording-formats.js';
import {recordingStage,recordingFile} from './recording-staging.js';
export const DWS_VERSION=cliReleases.dingtalk.version;
export type DwsCommand={kind:'status'|'version'|'login'}|{kind:'search';start:string;end:string;cursor?:string}|{kind:'metadata'|'transcript';id:string}|{kind:'media';id:string;output:string};
export type DwsRunner=(command:DwsCommand,profile:string|undefined,signal?:AbortSignal,onOutput?:(chunk:string)=>void)=>Promise<unknown>;
const idSchema=z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export function dwsArguments(command:DwsCommand,profile?:string):string[]{
 const prefix=profile?['--profile',profile]:[];
 switch(command.kind){
  case 'login':return ['auth','login','--device','--no-browser','--format','json'];
  case 'version':return ['version','--format','json'];
  case 'status':return [...prefix,'auth','status','--readonly','--format','json'];
  case 'search':return [...prefix,'minutes','+search','--scope','mine','--start',command.start,'--end',command.end,'--limit','30',...(command.cursor?['--cursor',command.cursor]:[]),'--format','json'];
  case 'metadata':return [...prefix,'minutes','+detail','--id',command.id,'--artifacts','basic','--format','json'];
  case 'transcript':return [...prefix,'minutes','+transcript','--id',command.id,'--page-limit','1000','--format','json'];
  case 'media':return [...prefix,'minutes','+download','--id',command.id,'--output',command.output,'--format','json'];
 }
}
/** Fixed read-only commands. The exact org:user profile is pinned on connect. */
export function createDwsRunner(root:string,options:{binary?:string}={}):DwsRunner{const execute:DwsRunner=async(command,profile,signal,onOutput)=>{
 await mkdir(root,{recursive:true,mode:0o700});
 return new Promise((ok,fail)=>{
  const env:NodeJS.ProcessEnv={};for(const key of ['PATH','HOME','USERPROFILE','SystemRoot','TMPDIR','LANG','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'])if(process.env[key])env[key]=process.env[key];
  let executable:string;try{executable=options.binary??managedCliBinary('dingtalk');}catch{fail(new ConnectorError('dingtalk_cli_platform_unsupported',503));return;}
  const child=spawn(executable,dwsArguments(command,profile),{cwd:root,env:{...env,NO_COLOR:'1',DWS_NO_UPDATE_CHECK:'1'},shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
  let output='',size=0,settled=false,terminal:ConnectorError|undefined;
  const stop=()=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
  const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error)return fail(error);try{if(command.kind==='login'){ok({completed:true});return;}const value=JSON.parse(output);if(value.ok===false||value.success===false||value.error)throw new ConnectorError('dingtalk_response_invalid',502);ok(value);}catch{fail(new ConnectorError('dingtalk_response_invalid',502));}};
  const abort=()=>{terminal??=new ConnectorError('dingtalk_operation_cancelled');stop();},timer=setTimeout(()=>{terminal??=new ConnectorError('dingtalk_operation_timeout',504);stop();},command.kind==='login'?610000:300000);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const publish=(chunk:string)=>{if(command.kind==='login'&&!terminal)try{onOutput?.(chunk);}catch{terminal=new ConnectorError('dingtalk_operation_cancelled');stop();}};child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>{if(terminal)return;size+=Buffer.byteLength(chunk);if(size>16*1024*1024){terminal=new ConnectorError('dingtalk_output_too_large');stop();}else output+=chunk;publish(chunk);});child.stderr.on('data',chunk=>{publish(String(chunk));});
  child.on('error',(error:NodeJS.ErrnoException)=>finish(new ConnectorError(error.code==='ENOENT'?'dingtalk_cli_missing':'dingtalk_process_failed',503)));
  child.on('close',code=>finish(terminal??(code?new ConnectorError('dingtalk_command_failed',502):undefined)));
 });
};let verified:Promise<void>|undefined;return async(command,profile,signal,onOutput)=>{if(command.kind!=='version')await(verified??=execute({kind:'version'},undefined,signal).then(value=>{const v=value as any;if(String(v?.version??v?.data?.version).replace(/^v/,'')!==DWS_VERSION)throw new ConnectorError('dingtalk_cli_version_unsupported',503);}).catch(error=>{verified=undefined;throw error;}));return execute(command,profile,signal,onOutput);};}
function data(value:any){if(value?.ok===false||value?.success===false||value?.error)throw new ExecutionFailure('permanent','recording_provider_failed');return value?.data??value;}
/** Preserve the vendor JSON as the original; expose its primary paragraph text
 * once. Sentence/word copies are transport detail, not additional speech. */
export function dingtalkTranscript(raw:unknown,durationMs=0){
 const value=z.object({taskUuid:idSchema,complete:z.boolean(),paragraphList:z.array(z.record(z.unknown())).max(50000)}).parse(raw);
 if(!value.complete)throw new ExecutionFailure('transient','recording_transcript_not_ready');
 const rawText=JSON.stringify(raw);if(!value.paragraphList.length)return {rawText,transcript:null};
 const segments=value.paragraphList.flatMap((paragraph,index)=>{
  const parsed=z.object({paragraph:z.string().min(1).refine(text=>Boolean(text.trim())),nickName:z.string().max(100).optional()}).safeParse(paragraph);
  if(!parsed.success)throw new ExecutionFailure('permanent','recording_transcript_format_unsupported');
  let offset=0;
  return splitTranscriptText(parsed.data.paragraph).map(text=>{
   // Row addresses the paragraph in the retained JSON; offsets address its
   // decoded primary text, not JSON escapes or redundant sentence copies.
   const documentLocation={rowNumber:index+1,offset,length:text.length};offset+=text.length;
   return {startMs:0,endMs:0,text,untimed:true as const,...(parsed.data.nickName?{speaker:parsed.data.nickName}:{}),uncertain:true,documentLocation};
  });
 });
 return {rawText,transcript:transcriptSchema.parse({durationMs,segments,coverage:'full',engine:'dingtalk-paragraph-text@2',uncorrected:true,warnings:['Primary vendor paragraph text retained once; complete original JSON remains archived. Paragraph locations address decoded primary text. Media segment timing and speaker identity are unverified.']})};
}
export function createDingtalkRecordings(directory:string,provided?:DwsRunner):RecordingProvider {
 const root=resolve(directory,'dws-runtime'),runner=provided??createDwsRunner(root);
 const call=async(command:DwsCommand,account:RecordingAccount|undefined,signal?:AbortSignal)=>data(await runner(command,account?.profile,signal));
 return {id:'dingtalk',authorization:dwsRecordingAuthorization(runner),version:`dws@${DWS_VERSION}/paragraph-text@2`,
  async account(signal){return recordingStage(root,async()=>{const status=await call({kind:'status'},undefined,signal);
   if(status.authenticated!==true||typeof status.corp_id!=='string'||typeof status.user_id!=='string'||!status.corp_id||!status.user_id)throw new ConnectorError('dingtalk_not_connected');
   const profile=`${status.corp_id}:${status.user_id}`;return {id:profile,profile,...(typeof status.user_name==='string'?{name:status.user_name}:{})};
  });},
  async discover(account,range,signal){const raw=await runner({kind:'search',...range},account.profile,signal),page=z.object({minutes:z.array(z.object({taskUuid:idSchema})).max(100),complete:z.boolean()}).parse(data(raw));
   const next=(raw as any)?.meta?.pagination?.next_token;if(!page.complete&&typeof next!=='string')throw new ExecutionFailure('permanent','recording_pagination_invalid');
   return {ids:page.minutes.map(m=>m.taskUuid),...(!page.complete?{next}:{})};
  },
  async metadata(account,id,signal){idSchema.parse(id);const detail=await call({kind:'metadata',id},account,signal);
   // +detail returns a task-keyed bundle, and basic retains its result envelope.
   const bundle=detail[id]??detail.results?.find((m:any)=>m.taskUuid===id)??detail;
   const basic=bundle.basic?.result??bundle.basic;
   if(!basic||!(basic.taskUuid===id||basic.uuid===id))throw new ExecutionFailure('permanent','recording_identity_invalid');
   // Owner policy uses the source timestamp as the corpus date. The current
   // account contract reports startTime and duration in milliseconds.
   const timing=z.object({startTime:z.number().int().positive().max(8_640_000_000_000_000).optional(),duration:z.number().int().safe().nonnegative().optional()}).parse(basic);
   return {id,title:typeof basic.title==='string'?basic.title:id,durationMs:timing.duration??0,...(timing.startTime!==undefined?{createdAt:new Date(timing.startTime).toISOString()}:{})};
  },
  async transcript(account,metadata,signal){const value=await call({kind:'transcript',id:metadata.id},account,signal);if(value.taskUuid!==metadata.id)throw new ExecutionFailure('permanent','recording_identity_invalid');
   try{return dingtalkTranscript(value,metadata.durationMs);}catch(error){if(error instanceof z.ZodError||error instanceof ExecutionFailure&&error.code==='recording_transcript_format_unsupported')return {rawText:JSON.stringify(value),transcript:null,formatError:'recording_transcript_format_unsupported'};throw error;}
  },
  async media(account,metadata,signal){return recordingStage(root,async(directory,relativeDirectory)=>{
   const output=relativeDirectory+'/recording.bin',receipt=await call({kind:'media',id:metadata.id,output},account,signal);
   if(receipt.ok!==true||receipt.succeeded!==1)throw new ExecutionFailure('transient','recording_media_not_ready');
   if(!Array.isArray(receipt.results)||receipt.results.length!==1||receipt.results[0]?.taskUuid!==metadata.id)throw new ExecutionFailure('permanent','recording_identity_invalid');
   const bytes=await recordingFile(directory,'recording.bin',FILE_MAX_BYTES);return {bytes,mimeType:recordingMime(bytes)};
  });},
 };
}
