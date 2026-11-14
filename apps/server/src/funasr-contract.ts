/** Current FunASR domain contract. This does not register a worker or a recipe.
 * ASR-03 must install these new pins together; never relabel an old pinned job.
 * SDK source: https://pypi.org/project/funasr/1.4.25/ (wheel digest below).
 * auto_model.py sentence_info uses text and millisecond start/end. Nano's
 * model-level timestamps use seconds: convert at that SDK boundary explicitly.
 * We retain sentence/VAD precision, without inventing token or word timings.
 */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {transcriptSchema,diarizationSchema,type Transcript,type Diarization} from '@mote/shared';
import type {FileOutputType} from './file-recipes.js';

export const FUNASR_PROTOCOL='mote.funasr/1';
/** POST /transcribe or /diarize; multipart `request` UTF-8 JSON (<=32 MiB)
 * and `audio` original octets (<=512 MiB). Reuse existing execution/auth headers.
 */
export const FUNASR_HTTP={recognize:'/transcribe',diarize:'/diarize',requestPart:'request',audioPart:'audio',audioBytes:512*1024*1024} as const;
export const FUNASR_SDK_VERSION='1.4.25';
export const FUNASR_SDK_WHEEL_SHA256='11ab7bd8c7574a94579b83a9f8fe837af46be6229462da5f3004a04a017cee75';
export const FUNASR_PINS={
  recipe:{id:'mote.audio-dialogue',version:'3'},
  extract:{id:'audio.local-dialogue',version:'5'},
  diarize:{id:'audio.diarize',version:'4'},
  align:{id:'mote.funasr-align',version:'1'},
} as const;
export const FUNASR_LIMITS={wireBytes:32*1024*1024,checkpointBytes:16*1024*1024,textBytes:4*1024*1024,
  durationMs:86_400_000,vad:50_000,sentences:50_000,acousticSegments:100_000,samples:16,sampleBytes:768*1024} as const;
export const FUNASR_MODEL_IDS={asr:'FunAudioLLM/Fun-ASR-Nano-2512',vad:'iic/speech_fsmn_vad_zh-cn-16k-common-pytorch',
  speaker:'iic/speech_campplus_sv_zh-cn_16k-common',punctuation:'iic/punc_ct-transformer_cn-en-common-vocab471067-large'} as const;
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const ms=z.number().finite().min(0).max(FUNASR_LIMITS.durationMs);
const model=(id:string)=>z.object({id:z.literal(id),revision:z.string().regex(/^[a-f0-9]{40,64}$/),manifestSha256:digest}).strict();
const ref=<I extends string,V extends string>(value:{id:I;version:V})=>z.object({id:z.literal(value.id),version:z.literal(value.version)}).strict();
export const funasrIdentitySchema=z.object({
  sdkVersion:z.literal(FUNASR_SDK_VERSION),sdkWheelSha256:z.literal(FUNASR_SDK_WHEEL_SHA256),
  recipe:ref(FUNASR_PINS.recipe),extract:ref(FUNASR_PINS.extract),diarize:ref(FUNASR_PINS.diarize),align:ref(FUNASR_PINS.align),
  // Loaded worker inference settings; excludes host connection/task settings
  // and per-request person-count overrides. Retained unchanged across stages.
  settingsFingerprint:digest,
  models:z.object({asr:model(FUNASR_MODEL_IDS.asr),vad:model(FUNASR_MODEL_IDS.vad),speaker:model(FUNASR_MODEL_IDS.speaker),punctuation:model(FUNASR_MODEL_IDS.punctuation)}).strict(),
  dependencies:z.record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,99}$/)).refine(v=>Object.keys(v).length>0&&Object.keys(v).length<=32&&Object.keys(v).every(k=>/^[a-z][a-z0-9_-]{0,63}$/.test(k))),
  backend:z.enum(['cpu','mps','cuda']),threads:z.number().int().min(1).max(32),
}).strict();
export type FunasrIdentity=z.infer<typeof funasrIdentitySchema>;
export const funasrSourceSchema=z.object({
  audioSha256:digest,pcmSha256:digest,sampleRate:z.literal(16000),sampleCount:z.number().int().min(0).max(1_382_400_000),durationMs:ms,
  // Full normalization, with no trimming, concatenation or offset shift.
  timeline:z.literal('original'),
}).strict().refine(s=>s.durationMs===s.sampleCount/16,'Duration must match normalized PCM frames');
export type FunasrSource=z.infer<typeof funasrSourceSchema>;
const interval=z.object({startMs:ms,endMs:ms}).strict();
const utf8Text=z.string().refine(s=>Buffer.from(s,'utf8').toString('utf8')===s,'Invalid Unicode text');
const sentence=z.object({startMs:ms,endMs:ms,text:utf8Text.refine(s=>s.length>0&&s.length<=8000),precision:z.enum(['sentence','vad'])}).strict();
export const funasrSpeakersSchema=z.discriminatedUnion('mode',[
  z.object({mode:z.literal('unknown')}).strict(),
  z.object({mode:z.literal('exact'),count:z.number().int().min(1).max(16)}).strict(),
  z.object({mode:z.literal('range'),min:z.number().int().min(1).max(16),max:z.number().int().min(1).max(16)}).strict(),
]).refine(v=>v.mode!=='range'||v.min<=v.max,'Invalid speaker range');
export type FunasrSpeakers=z.infer<typeof funasrSpeakersSchema>;
const checkpointSchema=z.object({protocol:z.literal(FUNASR_PROTOCOL),kind:z.literal('recognition'),timeUnit:z.literal('ms'),complete:z.literal(true),
  source:funasrSourceSchema,identity:funasrIdentitySchema,text:utf8Text.refine(s=>Buffer.byteLength(s)<=FUNASR_LIMITS.textBytes),
  vad:z.array(interval).max(FUNASR_LIMITS.vad),sentences:z.array(sentence).max(FUNASR_LIMITS.sentences),
  recognitionChunks:z.array(z.object({vadIndex:z.number().int().min(0).max(FUNASR_LIMITS.vad-1),text:utf8Text.refine(s=>Buffer.byteLength(s)<=FUNASR_LIMITS.textBytes)}).strict()).max(FUNASR_LIMITS.vad),
}).strict();
export type FunasrCheckpoint=z.infer<typeof checkpointSchema>;
const archiveSchema=z.object({sha256:digest,json:z.string().refine(s=>Buffer.byteLength(s)<=FUNASR_LIMITS.checkpointBytes)}).strict();
export type FunasrArchive=z.infer<typeof archiveSchema>;
const speaker=z.number().int().min(0).max(99999).nullable();
const acoustic=z.object({startMs:ms,endMs:ms,speaker}).strict();
const diarizationResultSchema=z.object({timeUnit:z.literal('ms'),speakers:funasrSpeakersSchema,
  assignments:z.array(speaker).max(FUNASR_LIMITS.sentences),segments:z.array(acoustic).max(FUNASR_LIMITS.acousticSegments),
  samples:z.array(z.object({speaker:z.number().int().min(0).max(99999),startMs:ms,endMs:ms,wavBase64:z.string().max(1024*1024)}).strict()).max(FUNASR_LIMITS.samples),
}).strict();
export type FunasrDiarizationResult=z.infer<typeof diarizationResultSchema>;
const baseRequest={protocol:z.literal(FUNASR_PROTOCOL),audioSha256:digest,maxAudioMs:ms.min(1),identity:funasrIdentitySchema};
const requestSchema=z.discriminatedUnion('operation',[
  z.object({...baseRequest,operation:z.literal('recognize')}).strict(),
  z.object({...baseRequest,operation:z.literal('diarize'),checkpoint:archiveSchema,speakers:funasrSpeakersSchema}).strict(),
]);
export type FunasrRequest=z.infer<typeof requestSchema>;
// These map to existing execution states/facts. Only the worker owner can prove
// child termination. A lost connection/restart must use response_unknown.
export const FUNASR_FAILURES={
  model_missing:{status:'blocked',execution:'not_started'},component_missing:{status:'blocked',execution:'not_started'},worker_not_ready:{status:'blocked',execution:'not_started'},
  resource_busy:{status:'waiting',execution:'not_started'},invalid_input:{status:'failed',execution:'not_started'},contract_mismatch:{status:'failed',execution:'not_started'},
  unsupported_input:{status:'failed',execution:'terminated'},
  inference_failed:{status:'failed',execution:'terminated'},inference_timeout:{status:'failed',execution:'terminated'},output_limit:{status:'failed',execution:'terminated'},constraint_unsatisfied:{status:'failed',execution:'terminated'},
  cancelled:{status:'cancelled',execution:'terminated'},response_unknown:{status:'unknown',execution:'unknown'},
} as const;
const successSchema=z.discriminatedUnion('operation',[
  z.object({protocol:z.literal(FUNASR_PROTOCOL),operation:z.literal('recognize'),status:z.literal('succeeded'),checkpoint:archiveSchema}).strict(),
  z.object({protocol:z.literal(FUNASR_PROTOCOL),operation:z.literal('diarize'),status:z.literal('succeeded'),checkpoint:archiveSchema,diarization:diarizationResultSchema}).strict(),
]);
export type FunasrSuccess=z.infer<typeof successSchema>;
const failureSchema=z.object({protocol:z.literal(FUNASR_PROTOCOL),operation:z.enum(['recognize','diarize']),
  status:z.enum(['blocked','waiting','failed','cancelled','unknown']),code:z.enum(Object.keys(FUNASR_FAILURES) as [keyof typeof FUNASR_FAILURES,...(keyof typeof FUNASR_FAILURES)[]]),
  execution:z.enum(['not_started','terminated','unknown']),retryAfterMs:z.number().int().min(1).max(60_000).nullable(),
}).strict().refine(v=>v.status===FUNASR_FAILURES[v.code].status&&v.execution===FUNASR_FAILURES[v.code].execution&&(v.code==='resource_busy'?v.retryAfterMs!==null:v.retryAfterMs===null),'Inconsistent worker failure');
export type FunasrFailure=z.infer<typeof failureSchema>;
export class FunasrContractError extends Error {constructor(message:string){super(message);this.name='FunasrContractError';}}
function requireContract(value:unknown,message:string):asserts value {if(!value)throw new FunasrContractError(message);}
function boundedJson(value:unknown):unknown {
  if(typeof value==='string'||Buffer.isBuffer(value)){
    requireContract(Buffer.byteLength(value)<=FUNASR_LIMITS.wireBytes,'Worker message exceeds byte limit');
    const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }
  const json=JSON.stringify(value);
  requireContract(json!==undefined&&Buffer.byteLength(json)<=FUNASR_LIMITS.wireBytes,'Worker message exceeds byte limit');
  return value;
}
function timeline(segments:readonly {startMs:number;endMs:number}[],duration:number,positive:boolean,disjoint=false){
  let lastStart=0,lastEnd=0;
  for(const s of segments){
    requireContract((positive?s.endMs>s.startMs:s.endMs>=s.startMs)&&s.endMs<=duration&&s.startMs>=lastStart&&(!disjoint||s.startMs>=lastEnd),'Invalid or unordered timeline');
    lastStart=s.startMs;lastEnd=s.endMs;
  }
}
/** Validate the exact archived UTF-8 bytes, not a reserialized approximation. */
export function parseFunasrArchive(value:unknown,expected?:Pick<FunasrRequest,'audioSha256'|'identity'|'maxAudioMs'>):FunasrCheckpoint {
  const archive=archiveSchema.parse(value);
  requireContract(createHash('sha256').update(archive.json).digest('hex')===archive.sha256,'Checkpoint digest mismatch');
  const checkpoint=checkpointSchema.parse(JSON.parse(archive.json)),{source,vad,sentences}=checkpoint;
  timeline(vad,source.durationMs,true,true);timeline(sentences,source.durationMs,false);
  requireContract(checkpoint.recognitionChunks.length===vad.length&&checkpoint.recognitionChunks.every((chunk,i)=>chunk.vadIndex===i),'Incomplete VAD recognition coverage');
  requireContract(Boolean(checkpoint.text.trim())===(sentences.length>0),'Text and sentence coverage disagree');
  // A sentence can span several regions from this SAME VAD. Preserve overlap.
  const covered=(time:number)=>{let lo=0,hi=vad.length;while(lo<hi){const mid=(lo+hi)>>>1;if(vad[mid].startMs<=time)lo=mid+1;else hi=mid;}return lo>0&&vad[lo-1].endMs>=time;};
  for(const s of sentences)requireContract(covered(s.startMs)&&covered(s.endMs),'Sentence is outside its shared VAD basis');
  if(expected){
    requireContract(source.audioSha256===expected.audioSha256,'Archived audio digest mismatch');
    requireContract(isDeepStrictEqual(checkpoint.identity,expected.identity),'Pinned model/settings identity mismatch');
    requireContract(source.durationMs<=expected.maxAudioMs,'Audio duration exceeds request budget');
  }
  return checkpoint;
}
export function parseFunasrRequest(value:unknown):FunasrRequest {
  const request=requestSchema.parse(boundedJson(value));
  if(request.operation==='diarize')parseFunasrArchive(request.checkpoint,request);
  return request;
}
function validateDiarization(result:FunasrDiarizationResult,cp:FunasrCheckpoint){
  requireContract(result.assignments.length===cp.sentences.length,'Every sentence requires one speaker assignment');
  timeline(result.segments,cp.source.durationMs,true);
  const labels=new Set(result.segments.flatMap(s=>s.speaker===null?[]:[s.speaker]));
  const evidence=new Map<number,{starts:number[];ends:number[]}>();
  for(const s of result.segments){
    if(s.speaker===null)continue;
    const index=evidence.get(s.speaker)??{starts:[],ends:[]};
    index.starts.push(s.startMs);index.ends.push(Math.max(index.ends.at(-1)??0,s.endMs));evidence.set(s.speaker,index);
  }
  result.assignments.forEach((label,i)=>{
    if(label===null)return;
    const index=evidence.get(label),s=cp.sentences[i];requireContract(index,'Sentence speaker has no acoustic evidence');
    let lo=0,hi=index.starts.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(s.endMs>s.startMs?index.starts[mid]<s.endMs:index.starts[mid]<=s.endMs)lo=mid+1;else hi=mid;}
    requireContract(lo>0&&index.ends[lo-1]>s.startMs,'Sentence speaker has no overlapping acoustic evidence');
  });
  const previews=new Set<number>();
  for(const sample of result.samples){
    timeline([sample],cp.source.durationMs,true);
    requireContract(labels.has(sample.speaker)&&!previews.has(sample.speaker),'Invalid speaker preview');previews.add(sample.speaker);
    const bytes=Buffer.from(sample.wavBase64,'base64');
    requireContract(bytes.length<=FUNASR_LIMITS.sampleBytes&&bytes.toString('base64')===sample.wavBase64&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE','Invalid bounded WAV preview');
  }
}
export function parseFunasrResponse(value:unknown,expected?:FunasrRequest):FunasrSuccess|FunasrFailure {
  const raw=boundedJson(value);
  if(raw&&typeof raw==='object'&&'status' in raw&&raw.status!=='succeeded'){
    const failure=failureSchema.parse(raw);if(expected)requireContract(failure.operation===expected.operation,'Worker operation mismatch');return failure;
  }
  const response=successSchema.parse(raw),cp=parseFunasrArchive(response.checkpoint,expected);
  if(expected){
    requireContract(response.operation===expected.operation,'Worker operation mismatch');
    if(expected.operation==='diarize')requireContract(response.checkpoint.sha256===expected.checkpoint.sha256,'Diarization changed its recognition checkpoint');
  }
  if(response.operation==='diarize'){
    validateDiarization(response.diarization,cp);
    if(expected?.operation==='diarize')requireContract(isDeepStrictEqual(response.diarization.speakers,expected.speakers),'Speaker declaration mismatch');
  }
  return response;
}
const label=(speaker:number|null)=>speaker===null?'SPEAKER_UNKNOWN':`SPEAKER_${speaker}`;
export function projectFunasrTranscript(cp:FunasrCheckpoint):Transcript {
  return transcriptSchema.parse({durationMs:cp.source.durationMs,coverage:'full',uncorrected:true,engine:'Fun-ASR-Nano-2512 / FunASR '+FUNASR_SDK_VERSION,
    segments:cp.sentences.map(({precision:_,...s})=>s)});
}
export function projectFunasrDialogue(cp:FunasrCheckpoint,result:FunasrDiarizationResult):Transcript {
  validateDiarization(result,cp);
  return transcriptSchema.parse({...projectFunasrTranscript(cp),segments:cp.sentences.map(({precision:_,...s},i)=>({...s,speaker:label(result.assignments[i]),...(result.assignments[i]===null?{uncertain:true}:{})}))});
}
export function projectFunasrDiarization(cp:FunasrCheckpoint,result:FunasrDiarizationResult):Diarization {
  validateDiarization(result,cp);
  return diarizationSchema.parse({durationMs:cp.source.durationMs,engine:'CAM++ / FunASR '+FUNASR_SDK_VERSION,
    expectedSpeakers:result.speakers.mode==='exact'?result.speakers.count:null,
    ...(result.speakers.mode==='range'?{declaredRange:{min:result.speakers.min,max:result.speakers.max}}:{}),
    observedSpeakers:new Set(result.segments.flatMap(s=>s.speaker===null?[]:[s.speaker])).size,
    overlapDetection:'unknown',segments:result.segments.map(s=>({...s,speaker:label(s.speaker)})),samples:result.samples.map(s=>({...s,speaker:label(s.speaker)})),
    warnings:result.assignments.some(s=>s===null)?['Some sentences have no speaker assignment.']:[],
  });
}
function success(value:unknown,operation:FunasrSuccess['operation']){
  const parsed=parseFunasrResponse(value);requireContract(parsed.status==='succeeded'&&parsed.operation===operation,'Expected complete stage output');return parsed;
}
/** Register through the existing FileOutputRegistry; the payload retains full
 * text, source/model manifests, VAD and recognition bytes in the artifact envelope.
 * Model provenance belongs there: never synthesize sherpa fields or silhouette.
 */
export const funasrTranscriptOutput:FileOutputType={id:'mote.funasr-transcript',version:'1',kind:'transcript',
  parse:value=>success(value,'recognize'),project:value=>projectFunasrTranscript(parseFunasrArchive(success(value,'recognize').checkpoint))};
export const funasrDialogueOutput:FileOutputType={id:'mote.funasr-dialogue',version:'1',kind:'dialogue',parse:value=>success(value,'diarize'),
  project:value=>{const response=success(value,'diarize');requireContract(response.operation==='diarize','Expected diarization');return projectFunasrDialogue(parseFunasrArchive(response.checkpoint),response.diarization);}};
