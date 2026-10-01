import {transcriptSchema,type Transcript} from '@mote/shared';
import {ExecutionFailure} from '../execution-engine.js';

/** Transport-format parsing only. Labels are vendor claims, never identities. */
export function feishuTranscript(rawText:string,durationMs:number):Transcript {
 const entries:{startMs:number;speaker?:string;text:string}[]=[];
 let current:typeof entries[number]|undefined;
 for(const line of rawText.replace(/\r\n/g,'\n').split('\n')){
  const match=/^(.*?)\s*(\d{2,}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\s*$/.exec(line);
  if(match){
   const startMs=((Number(match[2])*60+Number(match[3]))*60+Number(match[4]))*1000+Number((match[5]??'').padEnd(3,'0'));
   if(Number(match[3])>=60||Number(match[4])>=60)throw new ExecutionFailure('permanent','recording_timeline_invalid');
   current={startMs,...(match[1]!.trim()?{speaker:match[1]!.trim()}:{}),text:''};entries.push(current);
  }else if(current)current.text+=(current.text?'\n':'')+line;
 }
 if(!entries.length||entries.some(e=>!e.text.trim()))throw new ExecutionFailure('transient','recording_transcript_not_ready');
 const segments=entries.flatMap((entry,index)=>splitTranscriptText(entry.text.trim()).map(text=>({...entry,text,endMs:entries[index+1]?.startMs??durationMs,uncertain:true})));
 return transcriptSchema.parse({durationMs,segments,coverage:'full',engine:'feishu-export@1',uncorrected:true,warnings:['Vendor TXT export supplies start times. End times use the next start or media duration. Speaker labels are unverified. Export preamble is retained in the original asset.']});
}
export function splitTranscriptText(text:string):string[]{
 const parts:string[]=[];let from=0;
 while(from<text.length){let to=Math.min(text.length,from+8000);if(to<text.length&&/[\uD800-\uDBFF]/.test(text[to-1]!))to--;parts.push(text.slice(from,to));from=to;}
 return parts;
}
export function recordingMime(bytes:Buffer):string {
 const ascii=bytes.subarray(0,16).toString('ascii');
 if(ascii.startsWith('RIFF')&&ascii.slice(8,12)==='WAVE')return 'audio/wav';
 if(ascii.startsWith('fLaC'))return 'audio/flac';
 if(ascii.startsWith('OggS'))return 'audio/ogg';
 if(ascii.slice(4,8)==='ftyp')return 'audio/mp4';
 if(ascii.startsWith('ID3')||bytes[0]===0xff&&((bytes[1]??0)&0xe0)===0xe0)return 'audio/mpeg';
 throw new ExecutionFailure('permanent','recording_media_format_unsupported');
}
