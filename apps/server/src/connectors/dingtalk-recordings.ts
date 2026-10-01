import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {z} from 'zod';
import {FILE_MAX_BYTES,transcriptSchema} from '@mote/shared';
import {ExecutionFailure} from '../execution-engine.js';
import {ConnectorError} from './types.js';
import type {RecordingProvider,RecordingAccount} from './recordings.js';
import {recordingMime,splitTranscriptText} from './recording-formats.js';
import {recordingStage,recordingFile} from './recording-staging.js';
export const DWS_VERSION='1.0.62';
type DwsCommand={kind:'status'|'version'}|{kind:'search';start:string;end:string;cursor?:string}|{kind:'metadata'|'transcript';id:string}|{kind:'media';id:string;output:string};
export type DwsRunner=(command:DwsCommand,profile:string|undefined,signal?:AbortSignal)=>Promise<unknown>;
const idSchema=z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export function dwsArguments(command:DwsCommand,profile?:string):string[]{
 const prefix=profile?['--profile',profile]:[];
 switch(command.kind){
  case 'version':return ['version','--format','json'];
  case 'status':return [...prefix,'auth','status','--readonly','--format','json'];
  case 'search':return [...prefix,'minutes','+search','--scope','mine','--start',command.start,'--end',command.end,'--limit','30',...(command.cursor?['--cursor',command.cursor]:[]),'--format','json'];
  case 'metadata':return [...prefix,'minutes','+detail','--id',command.id,'--artifacts','basic','--format','json'];
  case 'transcript':return [...prefix,'minutes','+transcript','--id',command.id,'--page-limit','1000','--format','json'];
  case 'media':return [...prefix,'minutes','+download','--id',command.id,'--output',command.output,'--format','json'];
 }
}
/** Fixed read-only commands. The exact org:user profile is pinned on connect. */
export function createDwsRunner(root:string):DwsRunner{return async(command,profile,signal)=>{
 return new Promise((ok,fail)=>{
  const env:NodeJS.ProcessEnv={};for(const key of ['PATH','HOME','USERPROFILE','SystemRoot','TMPDIR','LANG','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'])if(process.env[key])env[key]=process.env[key];
  const child=spawn('dws',dwsArguments(command,profile),{cwd:root,env:{...env,NO_COLOR:'1'},shell:false,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
  let output='',size=0,settled=false;
  const stop=()=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
  const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error)return fail(error);try{const value=JSON.parse(output);if(value.ok===false||value.success===false||value.error)throw new ConnectorError('dingtalk_response_invalid',502);ok(value);}catch{fail(new ConnectorError('dingtalk_response_invalid',502));}};
  const abort=()=>{stop();finish(new ConnectorError('dingtalk_operation_cancelled'));},timer=setTimeout(()=>{stop();finish(new ConnectorError('dingtalk_operation_timeout',504));},300000);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>{size+=Buffer.byteLength(chunk);if(size>16*1024*1024){stop();finish(new ConnectorError('dingtalk_output_too_large'));}else output+=chunk;});child.stderr.on('data',()=>{});
  child.on('error',(error:NodeJS.ErrnoException)=>finish(new ConnectorError(error.code==='ENOENT'?'dingtalk_cli_missing':'dingtalk_process_failed',503)));
  child.on('close',code=>finish(code?new ConnectorError('dingtalk_command_failed',502):undefined));
 });
};}
function data(value:any){if(value?.ok===false||value?.success===false||value?.error)throw new ExecutionFailure('transient','recording_provider_failed');return value?.data??value;}
/** Preserve complete vendor paragraph JSON. Until a timestamp contract is
 * verified against a real account, expose text as untimed evidence. */
export function dingtalkTranscript(raw:unknown){
 const value=z.object({taskUuid:idSchema,complete:z.literal(true),paragraphList:z.array(z.record(z.unknown())).min(1).max(50000)}).parse(raw);
 const rawText=JSON.stringify(value),segments=value.paragraphList.flatMap(p=>splitTranscriptText(JSON.stringify(p)).map(text=>({startMs:0,endMs:0,text,untimed:true as const,...(typeof p.speakerNick==='string'&&p.speakerNick.length<=100?{speaker:p.speakerNick}:{}),uncertain:true})));
 return {rawText,transcript:transcriptSchema.parse({durationMs:0,segments,coverage:'full',engine:'dingtalk-paragraph-json@1',uncorrected:true,warnings:['Complete vendor paragraphs retained as structured text. Timing and speaker identity are unverified.']})};
}
export function createDingtalkRecordings(directory:string,provided?:DwsRunner):RecordingProvider {
 const root=resolve(directory,'dws-runtime'),runner=provided??createDwsRunner(root);
 const call=async(command:DwsCommand,account:RecordingAccount|undefined,signal?:AbortSignal)=>data(await runner(command,account?.profile,signal));
 return {id:'dingtalk',version:`dws@${DWS_VERSION}/paragraph-json@1`,
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
   return {id,title:typeof basic.title==='string'?basic.title:id,durationMs:0};
  },
  async transcript(account,metadata,signal){const value=await call({kind:'transcript',id:metadata.id},account,signal);if(value.taskUuid!==metadata.id)throw new ExecutionFailure('permanent','recording_identity_invalid');return dingtalkTranscript(value);},
  async media(account,metadata,signal){return recordingStage(root,async(directory,relativeDirectory)=>{
   const output=relativeDirectory+'/recording.bin',receipt=await call({kind:'media',id:metadata.id,output},account,signal);
   if(receipt.ok!==true||receipt.succeeded!==1)throw new ExecutionFailure('transient','recording_media_not_ready');
   if(!Array.isArray(receipt.results)||receipt.results.length!==1||receipt.results[0]?.taskUuid!==metadata.id)throw new ExecutionFailure('permanent','recording_identity_invalid');
   const bytes=await recordingFile(directory,'recording.bin',FILE_MAX_BYTES);return {bytes,mimeType:recordingMime(bytes)};
  });},
 };
}
