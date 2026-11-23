import {modelPrompt} from './model-prompt.js';
import { moteText } from './i18n.js';
import {type Transcript,type Diarization,transcriptSchema} from '@mote/shared';
import {isDeepStrictEqual} from 'node:util';
import {parseFunasrResponse,parseFunasrArchive,projectFunasrDialogue} from './funasr-contract.js';
import type {FileOutputType,FileDialogueCleanup} from './file-recipes.js';
import {cleanupTranscript,parseTranscriptCleanup,TRANSCRIPT_CLEANUP,type TranscriptCleanupSettings} from './transcript-cleanup.js';

/** ASR-03 registers this through the existing output registry and publishes it
 * as dialogue. The native recognition checkpoint remains in the extract output;
 * this payload retains the untouched speaker projection and its full mapping. */
export const cleanedDialogueOutput:FileOutputType={id:'mote.cleaned-dialogue',version:'1',kind:'dialogue',
  parse:parseTranscriptCleanup,project:value=>parseTranscriptCleanup(value).transcript};
/** The default recipe enables this transform only when deduplicate is on.
 * Preserve the checkpoint's actual timing precision when deriving its mapping. */
export const funasrDialogueCleanup:FileDialogueCleanup={...TRANSCRIPT_CLEANUP,output:cleanedDialogueOutput,
  process({transcript,checkpoint,signal}){
    signal.throwIfAborted();
    return cleanupTranscript(transcript,{},checkpoint.sentences.map(sentence=>sentence.precision));
  }};
export function prepareFunasrDialogue(value:unknown,settings:Partial<TranscriptCleanupSettings>={}){
  const response=parseFunasrResponse(value);
  if(response.status!=='succeeded'||response.operation!=='diarize')throw Error('Expected complete FunASR dialogue');
  const checkpoint=parseFunasrArchive(response.checkpoint);
  return cleanupTranscript(projectFunasrDialogue(checkpoint,response.diarization),settings,checkpoint.sentences.map(s=>s.precision));
}
/** The one current artifact envelope, shared by review and export consumers.
 * A plain transcript from another current output type needs no cleanup reader. */
export function readDialogueCleanup(artifact:{transcript?:unknown;output?:{type?:{id?:string;version?:string};payload?:unknown}}){
  if(artifact.output?.type?.id!==cleanedDialogueOutput.id)return undefined;
  if(artifact.output.type.version!==cleanedDialogueOutput.version)throw Error('Dialogue cleanup output is unavailable');
  const result=parseTranscriptCleanup(artifact.output.payload);
  if(!isDeepStrictEqual(transcriptSchema.parse(artifact.transcript),result.transcript))throw Error('Dialogue projection does not match its cleanup payload');
  return result;
}

/** Acoustic/time alignment only. It never identifies people or corrects recognized text. */
export function alignDialogue(raw:Transcript,diarization:Diarization):Transcript {
  type Segment=Transcript['segments'][number];
  const units:(Segment&{sentence:number;word:boolean})[]=[];
  const timeline=[...diarization.segments].sort((a,b)=>a.startMs-b.startMs);
  let cursor=0,active:typeof timeline=[],overlappingWordTimings=false,outsideSentenceWordTimings=false;
  for(const [sentenceIndex,sentence] of raw.segments.entries()){
    const words=sentence.words;
    // Valid ASR sentences may overlap. Expanding an earlier sentence into words
    // that start after the next sentence would reverse the derived timeline.
    // Keep that whole sentence and disclose the lower attribution precision;
    // never sort recognized words, shift timestamps or modify the raw input.
    const matchingWords=!!words?.length&&words.map(w=>w.text).join('').trim()===sentence.text.trim();
    const next=raw.segments[sentenceIndex+1],overlapping=Boolean(matchingWords&&next&&words!.at(-1)!.startMs>next.startMs);
    const outsideSentence=Boolean(words?.some(word=>word.startMs<sentence.startMs||word.endMs>sentence.endMs+1));
    const timingConflict=overlapping||outsideSentence;
    overlappingWordTimings ||= overlapping;outsideSentenceWordTimings ||= outsideSentence;
    const isWords=matchingWords&&!timingConflict;
    const parts=isWords?words!:[sentence];
    for(const word of parts){
      while(cursor<timeline.length&&timeline[cursor].startMs<word.endMs)active.push(timeline[cursor++]);
      active=active.filter(s=>s.endMs>word.startMs);
      const relevant=active.filter(s=>s.startMs<word.endMs),scores=new Map<string,number>();
      for(const s of relevant)scores.set(s.speaker,(scores.get(s.speaker)??0)+Math.max(0,Math.min(word.endMs,s.endMs)-Math.max(word.startMs,s.startMs)));
      const ranked=[...scores].sort((a,b)=>b[1]-a[1]),width=Math.max(1,word.endMs-word.startMs);
      const overlap=relevant.some((a,i)=>relevant.slice(i+1).some(b=>a.speaker!==b.speaker&&Math.min(a.endMs,b.endMs,word.endMs)-Math.max(a.startMs,b.startMs,word.startMs)>20));
      const uncertain=timingConflict||!ranked.length||ranked[0][1]/width<0.5||(ranked.length>1&&ranked[1][1]>=ranked[0][1]*0.8)||overlap;
      units.push({startMs:word.startMs,endMs:word.endMs,text:word.text,speaker:ranked[0]?.[0]??'SPEAKER_UNKNOWN',uncertain,overlap,sentence:sentenceIndex,word:isWords});
    }
  }
  const turns:Segment[]=[];let previous:typeof units[number]|undefined;
  for(const unit of units){
    if(!unit.text)continue;const last=turns.at(-1);
    const separator=previous?.sentence===unit.sentence&&unit.word?'':'\n';
    if(last&&last.speaker===unit.speaker&&last.uncertain===unit.uncertain&&last.overlap===unit.overlap&&unit.startMs-last.endMs<=1200&&last.text.length+unit.text.length+separator.length<=8000){
      last.text+=separator+unit.text;last.endMs=Math.max(last.endMs,unit.endMs);
    }else {const {sentence,word,...segment}=unit;turns.push(segment);}
    previous=unit;
  }
  return transcriptSchema.parse({durationMs:raw.durationMs,segments:turns,uncorrected:true,engine:'mote-time-alignment-v2',warnings:[...diarization.warnings,
    ...(overlappingWordTimings?[moteText("部分词级时间与相邻片段重叠，已保留整句并标记说话人不确定；原始转写未改动。")]:[]),
    ...(outsideSentenceWordTimings?[moteText("部分词级时间超出句子范围，已保留整句并标记说话人不确定；原始转写未改动。")]:[]),
    ...(diarization.overlapDetection==='unknown'?[moteText("重叠检测范围未知。未标记处仍可能有重叠说话。")]:[])]});
}

/** A model may group adjacent turns, but cannot rewrite text, relabel a speaker, omit or reorder a span. */
export function applySemanticGroups(transcript:Transcript,groups:number[][]):Transcript {
  const flattened=groups.flat();if(flattened.length!==transcript.segments.length||flattened.some((n,i)=>n!==i))throw new Error('Semantic groups must preserve every turn in order');
  const segments=groups.map(group=>{
    if(!group.length)throw new Error('Empty semantic group');const rows=group.map(i=>transcript.segments[i]);
    if(rows.some(r=>r.speaker!==rows[0].speaker||r.overlap!==rows[0].overlap||r.uncertain!==rows[0].uncertain))throw new Error('Semantic grouping cannot change speaker attribution');
    return {...rows[0],endMs:Math.max(...rows.map(r=>r.endMs)),text:rows.map(r=>r.text).join('\n')};
  });return transcriptSchema.parse({...transcript,segments,engine:'mote-semantic-grouping-v1'});
}
export const TURN_GROUP_PROMPT=modelPrompt('turnGrouping');
