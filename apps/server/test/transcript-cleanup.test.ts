import assert from 'node:assert/strict';
import test from 'node:test';
import {transcriptSchema,type Transcript} from '@mote/shared';
import {cleanupTranscript,parseTranscriptCleanup,withTranscriptCleanupSettings} from '../src/transcript-cleanup.js';

type Segment=Transcript['segments'][number];
const segment=(startMs:number,endMs:number,text:string,extra:Partial<Segment>={}):Segment=>({startMs,endMs,text,speaker:'SPEAKER_0',...extra});
const dialogue=(segments:Segment[]):Transcript=>({durationMs:120_000,uncorrected:true,coverage:'full',engine:'generated-asr',segments});
/** These generated observations explicitly have sentence-level timing. */
const clean=(input:Transcript,settings:{enabled?:boolean}={})=>cleanupTranscript(input,settings,input.segments.map(()=>'sentence'));

test('only identical observations of one speech interval collapse, and every original row remains located',()=>{
  const input=dialogue([segment(0,800,'不是不是不是。'),segment(1000,2000,'这笔是三十元。'),segment(1000,2000,'这笔是三十元。'),segment(5000,6000,'下一条。')]);
  const before=JSON.stringify(input),result=clean(input);
  assert.equal(JSON.stringify(input),before);
  assert.deepEqual(result.transcript.segments,[input.segments[0],input.segments[1],input.segments[3]]);
  assert.deepEqual(result.uncleanedTranscript,input);
  assert.deepEqual(result.cleanup.sourceToDerived,[0,1,1,2]);
  for(const [source,target] of result.cleanup.sourceToDerived.entries())assert.deepEqual(result.transcript.segments[target],input.segments[source]);
  assert.equal(result.transcript.uncorrected,true);
  assert.deepEqual(parseTranscriptCleanup(JSON.parse(JSON.stringify(result))),result);
  result.transcript.segments[0].text='Caller mutation';
  assert.equal(result.uncleanedTranscript.segments[0].text,'不是不是不是。');
  assert.equal(JSON.stringify(input),before);
});

for(const [name,rows] of [
  ['oral emphasis and a repeated utterance at a later time',[segment(0,1000,'不是不是不是。'),segment(1000,2000,'不是不是不是。')]],
  ['the same sentence much later',[segment(0,1000,'这个已经确认。'),segment(110_000,111_000,'这个已经确认。')]],
  ['different anonymous speakers saying the same sentence',[segment(0,1000,'我同意。'),segment(0,1000,'我同意。',{speaker:'SPEAKER_1'})]],
  ['a changed negation in the same interval',[segment(0,1000,'我不是同意。'),segment(0,1000,'我是同意。')]],
  ['a changed number in the same interval',[segment(0,1000,'费用三十元。'),segment(0,1000,'费用三十三元。')]],
  ['a changed name in the same interval',[segment(0,1000,'陈晨确认了。'),segment(0,1000,'陈辰确认了。')]],
  ['whitespace and punctuation differences',[segment(0,1000,'确认。'),segment(0,1000,' 确认！')]],
  ['a matching substring inside a second utterance',[segment(0,1000,'不是。'),segment(0,1000,'不是不是不是。')]],
  ['partial overlap without exact time evidence',[segment(0,1000,'同一段文本。'),segment(500,1500,'同一段文本。')]],
  ['nearly equal timing',[segment(0,1000,'同一段文本。'),segment(0.0625,1000,'同一段文本。')]],
] satisfies [string,Segment[]][])test(`cleanup preserves ${name}`,()=>{
  const input=dialogue(rows),result=clean(input);
  assert.deepEqual(result.transcript,input);
  assert.deepEqual(result.cleanup.sourceToDerived,[0,1]);
});

test('unknown clusters, uncertain/overlapping speech, untimed or zero-length rows never establish a duplicate',()=>{
  for(const extra of [{speaker:'SPEAKER_UNKNOWN'},{speaker:undefined},{speaker:'Generated same display name'},
    {uncertain:true},{overlap:true},{untimed:true}] satisfies Partial<Segment>[]){
    const row=segment(0,1000,'相同原文。',extra),input=dialogue([row,structuredClone(row)]);
    assert.deepEqual(clean(input).transcript,input);
  }
  const row=segment(20,20,'零长句段。');
  assert.deepEqual(clean(dialogue([row,row])).cleanup.sourceToDerived,[0,1]);
});

test('differing word evidence and nonadjacent observations are retained instead of repaired or reordered',()=>{
  const first=segment(0,1000,'确认。',{words:[{startMs:0,endMs:1000,text:'确认。',probability:0.9}]}),
    second=structuredClone(first);
  second.words![0].startMs=20;
  const input=dialogue([first,second,first]);
  assert.deepEqual(clean(input).transcript,input);
  const interleaved=dialogue([segment(0,1000,'确认。'),segment(0,1000,'别人的发言。',{speaker:'SPEAKER_1'}),segment(0,1000,'确认。')]);
  assert.deepEqual(clean(interleaved).transcript,interleaved);
});

test('disabling derives the complete speaker view from saved originals and creates a deterministic new version',()=>{
  const input=dialogue([segment(0,1000,'保留的重复。'),segment(0,1000,'保留的重复。')]),cleaned=clean(input),
    saved=JSON.stringify(cleaned),disabled=withTranscriptCleanupSettings(JSON.parse(saved),{enabled:false});
  assert.equal(cleaned.transcript.segments.length,1);
  assert.deepEqual(disabled.transcript,input);
  assert.deepEqual(disabled.cleanup.sourceToDerived,[0,1]);
  assert.notEqual(disabled.cleanup.processingVersion,cleaned.cleanup.processingVersion);
  assert.equal(disabled.cleanup.inputSha256,cleaned.cleanup.inputSha256);
  assert.equal(JSON.stringify(cleaned),saved);
  assert.deepEqual(withTranscriptCleanupSettings(disabled,{enabled:true}),cleaned);
  assert.deepEqual(clean(JSON.parse(JSON.stringify(input)),{}),cleaned);
  assert.deepEqual(clean(transcriptSchema.parse({...input,segments:input.segments.map(s=>({text:s.text,endMs:s.endMs,speaker:s.speaker,startMs:s.startMs}))})),cleaned);
});

test('cleanup rejects human-edited transcripts and invalid stored mappings rather than inventing provenance',()=>{
  const input=dialogue([segment(0,1000,'原句。'),segment(0,1000,'原句。'),segment(2000,3000,'另一句。')]),result=clean(input);
  const corrected={...input};delete corrected.uncorrected;
  assert.throws(()=>cleanupTranscript(corrected),/uncorrected/);
  for(const mutate of [
    (r:typeof result)=>r.cleanup.sourceToDerived.pop(),
    (r:typeof result)=>r.cleanup.sourceToDerived[1]=1,
    (r:typeof result)=>r.cleanup.sourceToDerived[2]=0,
    (r:typeof result)=>r.cleanup.enabled=false,
    (r:typeof result)=>r.cleanup.sourcePrecisions[1]='vad',
    (r:typeof result)=>r.transcript.segments[0].text='静默改写。',
    (r:typeof result)=>r.uncleanedTranscript.segments[1].speaker='SPEAKER_1',
    (r:typeof result)=>r.cleanup.processingVersion='0'.repeat(64),
  ]){const changed=structuredClone(result);mutate(changed);assert.throws(()=>parseTranscriptCleanup(changed));}
});

test('coarse VAD and missing timing precision cannot erase oral repetition even when timestamps and clusters coincide',()=>{
  const row=segment(0,1000,'不是。'),input=dialogue([row,row,row]);
  for(const precision of [undefined,['vad','vad','vad'] as const,['sentence','vad','sentence'] as const]){
    const result=cleanupTranscript(input,{},precision);
    assert.deepEqual(result.transcript,input);assert.deepEqual(result.cleanup.sourceToDerived,[0,1,2]);
    assert.deepEqual(parseTranscriptCleanup(result),result);
  }
  assert.throws(()=>cleanupTranscript(input,{},['sentence']),/Every cleanup source/);
  assert.notEqual(cleanupTranscript(input).cleanup.processingVersion,clean(input).cleanup.processingVersion);
});

test('silence, partial coverage, lower timing precision and warnings survive unchanged',()=>{
  const silent=cleanupTranscript({...dialogue([]),durationMs:0});
  assert.deepEqual(silent.cleanup.sourceToDerived,[]);assert.deepEqual(parseTranscriptCleanup(silent),silent);
  const input={...dialogue([segment(0,1000,'部分原文。')]),coverage:'partial' as const,warnings:['Generated missing interval warning.']};
  assert.deepEqual(cleanupTranscript(input).transcript,input);
});
