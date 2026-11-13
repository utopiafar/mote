import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {transcriptSchema,type Transcript} from '@mote/shared';

/** A dialogue transform, never a human correction or a new ASR result. */
export const TRANSCRIPT_CLEANUP={id:'mote.transcript-cleanup',version:'1'} as const;
export const transcriptCleanupSettingsSchema=z.object({enabled:z.boolean().default(true)}).strict();
export type TranscriptCleanupSettings=z.infer<typeof transcriptCleanupSettingsSchema>;
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const precisionSchema=z.array(z.enum(['sentence','vad','unknown'])).max(50000);
export type TranscriptTimingPrecision=z.infer<typeof precisionSchema>[number];
const cleanupResultSchema=z.object({
  transcript:transcriptSchema,
  uncleanedTranscript:transcriptSchema,
  cleanup:z.object({
    id:z.literal(TRANSCRIPT_CLEANUP.id),version:z.literal(TRANSCRIPT_CLEANUP.version),enabled:z.boolean(),
    inputSha256:digest,outputSha256:digest,processingVersion:digest,
    sourcePrecisions:precisionSchema,
    /** One entry per original segment, including every collapsed duplicate.
     * Indices address uncleanedTranscript and transcript in this same payload. */
    sourceToDerived:z.array(z.number().int().min(0).max(49999)).max(50000),
  }).strict(),
}).strict();
export type TranscriptCleanupResult=z.infer<typeof cleanupResultSchema>;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const processingVersion=(inputSha256:string,enabled:boolean,sourcePrecisions:TranscriptTimingPrecision[])=>hash([TRANSCRIPT_CLEANUP,inputSha256,{enabled},sourcePrecisions]);
type Segment=Transcript['segments'][number];

/** Matching text alone (even inside overlapping time ranges) proves nothing.
 * Only adjacent, sentence-timed identical observations of the same positive interval
 * and known anonymous cluster can collapse. Unknown/uncertain/overlapping speech,
 * word timing differences and untimed evidence are deliberately left intact.
 * No normalization, fuzzy matching, substring deletion or identity inference. */
function sameObservation(a:Segment,b:Segment){
  return a.endMs>a.startMs&&!a.untimed&&!a.uncertain&&!a.overlap&&
    /^SPEAKER_[0-9]{1,5}$/.test(a.speaker??'')&&isDeepStrictEqual(a,b);
}
function uncorrected(transcript:Transcript){
  if(transcript.uncorrected!==true)throw Error('Transcript cleanup requires an uncorrected dialogue');
}

/** Always derive from the preserved speaker dialogue. Turning this off creates
 * an identity view of that input; it never reconstructs text from a cleaned or
 * human-edited view. The caller publishes a NEW dialogue artifact and retains
 * the payload through FileOutputRegistry. This function has no storage effects. */
export function cleanupTranscript(input:Transcript,settings:Partial<TranscriptCleanupSettings>={},timingPrecision?:readonly TranscriptTimingPrecision[]):TranscriptCleanupResult {
  const uncleanedTranscript=transcriptSchema.parse(input),{enabled}=transcriptCleanupSettingsSchema.parse(settings);
  // Public Transcript alone does not establish timing precision. Repeated
  // sentences inside one coarse VAD interval must not be mistaken for duplicates.
  const sourcePrecisions=precisionSchema.parse(timingPrecision??uncleanedTranscript.segments.map(()=>'unknown'));
  if(sourcePrecisions.length!==uncleanedTranscript.segments.length)throw Error('Every cleanup source segment requires timing precision');
  uncorrected(uncleanedTranscript);
  const segments:Segment[]=[],sourceToDerived:number[]=[];
  for(const [index,segment] of uncleanedTranscript.segments.entries()){
    if(!enabled||sourcePrecisions[index]!=='sentence'||sourcePrecisions[index-1]!=='sentence'||!segments.length||!sameObservation(segments.at(-1)!,segment))segments.push(structuredClone(segment));
    sourceToDerived.push(segments.length-1);
  }
  const transcript={...structuredClone(uncleanedTranscript),segments},inputSha256=hash(uncleanedTranscript);
  return {transcript,uncleanedTranscript,cleanup:{...TRANSCRIPT_CLEANUP,enabled,inputSha256,
    outputSha256:hash(transcript),processingVersion:processingVersion(inputSha256,enabled,sourcePrecisions),sourcePrecisions,sourceToDerived}};
}

/** Validate stored output without running the transform again. In particular,
 * review/export must never silently clean a human correction. Every source row
 * must map, in order, to an unchanged located segment in the derived view. */
export function parseTranscriptCleanup(value:unknown):TranscriptCleanupResult {
  const result=cleanupResultSchema.parse(value),{transcript,uncleanedTranscript,cleanup}=result;
  uncorrected(uncleanedTranscript);uncorrected(transcript);
  const require=(condition:boolean)=>{if(!condition)throw Error('Invalid transcript cleanup provenance');};
  require(cleanup.inputSha256===hash(uncleanedTranscript)&&cleanup.outputSha256===hash(transcript)&&
    cleanup.processingVersion===processingVersion(cleanup.inputSha256,cleanup.enabled,cleanup.sourcePrecisions));
  const {segments:_,...derivedMetadata}=transcript,{segments:__,...sourceMetadata}=uncleanedTranscript;
  require(isDeepStrictEqual(derivedMetadata,sourceMetadata));
  require(cleanup.sourceToDerived.length===uncleanedTranscript.segments.length);
  require(cleanup.sourcePrecisions.length===uncleanedTranscript.segments.length);
  let previous=-1;
  cleanup.sourceToDerived.forEach((target,index)=>{
    require(target===previous+1||target===previous&&cleanup.enabled&&index>0&&
      cleanup.sourcePrecisions[index]==='sentence'&&cleanup.sourcePrecisions[index-1]==='sentence'&&
      sameObservation(uncleanedTranscript.segments[index-1],uncleanedTranscript.segments[index]));
    require(isDeepStrictEqual(transcript.segments[target],uncleanedTranscript.segments[index]));
    previous=target;
  });
  require(previous===transcript.segments.length-1);
  return result;
}

/** Explicit settings revision over a saved output. The returned value is a new
 * derived version; the caller keeps the old artifact and publishes this one. */
export function withTranscriptCleanupSettings(value:unknown,settings:Partial<TranscriptCleanupSettings>){
  const source=parseTranscriptCleanup(value);
  return cleanupTranscript(source.uncleanedTranscript,settings,source.cleanup.sourcePrecisions);
}
