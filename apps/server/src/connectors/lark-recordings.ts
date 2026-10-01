import {resolve} from 'node:path';
import {z} from 'zod';
import {FILE_MAX_BYTES} from '@mote/shared';
import {ExecutionFailure} from '../execution-engine.js';
import {ConnectorError} from './types.js';
import {createLarkRunner,larkJson,LARK_VERSION,type LarkRunner} from './lark-cli.js';
import type {RecordingProvider} from './recordings.js';
import {feishuTranscript,recordingMime} from './recording-formats.js';
import {recordingStage,recordingFile} from './recording-staging.js';
const token=z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export function createFeishuRecordings(directory:string,provided?:LarkRunner):RecordingProvider {
 const root=resolve(directory,'lark-runtime'),runner=provided??createLarkRunner(directory,{localProfile:true});
 return {id:'feishu',version:`lark-cli@${LARK_VERSION}/export@1`,
  async account(signal){const value=larkJson(await runner({kind:'status'},{signal})),user=value.identities?.user;
   if(!user?.available||typeof user.openId!=='string'||typeof value.appId!=='string')throw new ConnectorError('lark_not_connected');
   return {id:`${value.appId}:${user.openId}`,...(typeof user.userName==='string'?{name:user.userName}:{})};
  },
  async discover(_account,range,signal){
   // Preserve timezone-aware bounds. Calendar-day truncation can lose
   // same-day records when the central node and vendor timezones differ.
   const value=larkJson(await runner({kind:'minutes-search',start:range.start,end:range.end,pageToken:range.cursor},{signal}));
   const page=z.object({items:z.array(z.object({token})).max(100),has_more:z.boolean(),page_token:z.string().optional()}).parse(value.data);
   if(page.has_more&&!page.page_token)throw new ExecutionFailure('permanent','recording_pagination_invalid');
   return {ids:page.items.map(i=>i.token),...(page.has_more?{next:page.page_token}:{})};
  },
  async metadata(_account,id,signal){token.parse(id);const value=larkJson(await runner({kind:'minutes-metadata',id},{signal}));
   const minute=z.object({token,title:z.string().max(500),create_time:z.string().regex(/^\d+$/),duration:z.string().regex(/^\d+$/),url:z.string().url().optional()}).parse(value.data?.minute);
   return {id:minute.token,title:minute.title,createdAt:new Date(Number(minute.create_time)).toISOString(),durationMs:Number(minute.duration),...(minute.url?{uri:minute.url}:{})};
  },
  async transcript(_account,metadata,signal){return recordingStage(root,async(directory,relativeDirectory)=>{
   const value=larkJson(await runner({kind:'minutes-transcript',id:metadata.id,outputDir:relativeDirectory},{signal}));
   const minutes=z.array(z.object({minute_token:token,artifacts:z.object({transcript_file:z.string()})})).parse(value.data?.minutes);
   const result=minutes.find(m=>m.minute_token===metadata.id);if(!result)throw new ExecutionFailure('transient','recording_transcript_not_ready');
   const exported=resolve(root,result.artifacts.transcript_file),rawText=(await recordingFile(directory,exported,16*1024*1024)).toString('utf8');
   return {rawText,transcript:feishuTranscript(rawText,metadata.durationMs)};
  });},
  async media(_account,metadata,signal){return recordingStage(root,async(directory,relativeDirectory)=>{
   const output=relativeDirectory+'/recording.bin';larkJson(await runner({kind:'minutes-media',id:metadata.id,output},{signal}));
   const bytes=await recordingFile(directory,'recording.bin',FILE_MAX_BYTES);return {bytes,mimeType:recordingMime(bytes)};
  });},
 };
}
