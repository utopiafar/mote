import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {diarizationSchema,transcriptSchema} from '@mote/shared';
import {FileOutputRegistry} from '../src/file-recipes.js';
import {FUNASR_PROTOCOL,FUNASR_SDK_VERSION,FUNASR_SDK_WHEEL_SHA256,FUNASR_PINS,FUNASR_MODEL_IDS,FUNASR_LIMITS,FUNASR_FAILURES,
  parseFunasrArchive,parseFunasrRequest,parseFunasrResponse,projectFunasrDiarization,projectFunasrDialogue,
  funasrTranscriptOutput,funasrDialogueOutput,type FunasrSuccess,type FunasrCheckpoint,type FunasrArchive,type FunasrRequest} from '../src/funasr-contract.js';

// The production Python serializer supplies every valid native message. No
// separately authored TS success fixture can hide producer/consumer drift.
const producer=spawnSync('python3',[fileURLToPath(new URL('../../../scripts/test_mote_asr_contract.py',import.meta.url)),'--emit'],
  {encoding:'utf8',maxBuffer:4*1024*1024,timeout:30_000});
assert.equal(producer.status,0,producer.stderr||String(producer.error));
const bundle=JSON.parse(producer.stdout);
const request=parseFunasrRequest(bundle.request);
const diarizeRequest=parseFunasrRequest(bundle.diarizeRequest);
const recognition=parseFunasrResponse(bundle.response,request) as FunasrSuccess;
const diarization=parseFunasrResponse(bundle.diarizeResponse,diarizeRequest);
assert.equal(diarization.status,'succeeded');
assert.equal(diarization.operation,'diarize');
if(diarization.status!=='succeeded'||diarization.operation!=='diarize')throw Error('Expected generated diarization');
const checkpoint=parseFunasrArchive(recognition.checkpoint,request);
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const archive=(cp:FunasrCheckpoint):FunasrArchive=>{const json=JSON.stringify(cp);return {json,sha256:hash(json)};};
const changed=(mutate:(cp:FunasrCheckpoint)=>void)=>{const cp=structuredClone(checkpoint);mutate(cp);return archive(cp);};

test('production Python bytes decode through FileOutputRegistry and retain raw text, every sentence and exact millisecond boundaries',()=>{
  assert.equal(bundle.protocol,FUNASR_PROTOCOL);assert.equal(bundle.sdkVersion,FUNASR_SDK_VERSION);
  assert.equal(bundle.sdkWheelSha256,FUNASR_SDK_WHEEL_SHA256);assert.deepEqual(bundle.pins,FUNASR_PINS);
  assert.deepEqual(bundle.modelIds,FUNASR_MODEL_IDS);assert.deepEqual(bundle.limits,FUNASR_LIMITS);
  const outputs=new FileOutputRegistry();outputs.register(funasrTranscriptOutput);
  const decoded=outputs.decode(funasrTranscriptOutput,JSON.parse(bundle.response));
  const transcript=transcriptSchema.parse(decoded.transcript);
  assert.equal(decoded.kind,'transcript');
  assert.deepEqual(transcript.segments.map(s=>[s.startMs,s.endMs]),[[0,20],[20,100],[100,101],[101,1000],[900,1000]]);
  assert.deepEqual(transcript.segments.map(s=>s.text),bundle.native.sentence_info.map((s:{text:string})=>s.text));
  assert.equal(transcript.durationMs,1000);assert.equal(transcript.coverage,'full');assert.equal(transcript.uncorrected,true);
  assert.ok(transcript.segments.every(s=>!Object.hasOwn(s,'words')));
  const payload=decoded.payload as FunasrSuccess;
  assert.equal(parseFunasrArchive(payload.checkpoint).text,bundle.native.text);
  assert.equal(payload.checkpoint.json,recognition.checkpoint.json);
});

test('native CAM results project to current dialogue and Diarization without fake sherpa provenance or SPEAKER_None',()=>{
  const outputs=new FileOutputRegistry();outputs.register(funasrDialogueOutput);
  const dialogue=outputs.decode(funasrDialogueOutput,JSON.parse(bundle.diarizeResponse)).transcript;
  assert.deepEqual(dialogue.segments.map(s=>s.speaker),['SPEAKER_0','SPEAKER_0','SPEAKER_UNKNOWN','SPEAKER_1','SPEAKER_1']);
  assert.equal(dialogue.segments[2].uncertain,true);
  assert.deepEqual(dialogue.segments.map(s=>[s.text,s.startMs,s.endMs]),checkpoint.sentences.map(s=>[s.text,s.startMs,s.endMs]));
  const result=diarizationSchema.parse(projectFunasrDiarization(checkpoint,diarization.diarization));
  assert.equal(result.observedSpeakers,2);assert.equal(result.expectedSpeakers,null);
  assert.equal(result.segments.length,3);assert.equal(result.segments[2].speaker,'SPEAKER_UNKNOWN');
  assert.equal(result.samples.length,2);assert.equal(result.overlapDetection,'unknown');
  assert.equal(Object.hasOwn(result,'modelProvenance'),false);assert.equal(Object.hasOwn(result,'estimate'),false);
  assert.equal(JSON.stringify(dialogue).includes('SPEAKER_None'),false);
});

test('silence is a complete empty projection for both zero and nonzero recording duration',()=>{
  const outputs=new FileOutputRegistry();outputs.register(funasrTranscriptOutput);outputs.register(funasrDialogueOutput);
  for(const fixture of bundle.empty){
    const response=parseFunasrResponse(fixture.response,parseFunasrRequest(fixture.request));
    assert.equal(response.status,'succeeded');
    const transcript=outputs.decode(funasrTranscriptOutput,JSON.parse(fixture.response)).transcript;
    assert.equal(transcript.durationMs,fixture.request.audioSha256===bundle.empty[0].request.audioSha256?0:1000);
    assert.deepEqual(transcript.segments,[]);assert.equal(transcript.coverage,'full');
    const result=parseFunasrResponse(fixture.diarizeResponse,parseFunasrRequest(fixture.diarizeRequest));
    assert.equal(result.status,'succeeded');assert.deepEqual(outputs.decode(funasrDialogueOutput,result).transcript.segments,[]);
  }
});

test('archived bytes, audio digest, model revision, dependency versions and settings must match the pinned request',()=>{
  assert.throws(()=>parseFunasrArchive({...recognition.checkpoint,json:recognition.checkpoint.json+' '},request),/digest mismatch/);
  const mutations:((r:FunasrRequest)=>void)[]=[r=>r.audioSha256=hash('another original'),
    r=>r.identity.models.asr.manifestSha256=hash('another model'),r=>r.identity.models.vad.revision=hash('another VAD'),
    r=>r.identity.settingsFingerprint=hash('different inference settings'),r=>r.identity.dependencies.torch='9.0.0',
    r=>r.identity.backend='mps',r=>r.identity.threads++,r=>r.maxAudioMs=999];
  for(const mutate of mutations){const expected=structuredClone(request);mutate(expected);assert.throws(()=>parseFunasrResponse(bundle.response,expected));}
  assert.throws(()=>parseFunasrArchive(changed(cp=>{(cp.identity.extract.version as string)='4';})),/Invalid literal/);
  for(const pin of ['recipe','diarize','align'] as const)
    assert.throws(()=>parseFunasrArchive(changed(cp=>{(cp.identity[pin].version as string)='0';})),/Invalid literal/);
  assert.throws(()=>parseFunasrArchive(changed(cp=>{(cp.identity.sdkVersion as string)='1.4.24';})),/Invalid literal/);
  assert.throws(()=>parseFunasrRequest({...bundle.request,protocol:'mote.funasr/0'}));
});

test('a re-diarization response must reference exactly the saved checkpoint and requested count options',()=>{
  const other=structuredClone(bundle.diarizeRequest);
  other.checkpoint=changed(cp=>cp.text+=' altered');
  assert.throws(()=>parseFunasrResponse(bundle.diarizeResponse,parseFunasrRequest(other)),/changed its recognition checkpoint/);
  other.checkpoint=bundle.diarizeRequest.checkpoint;other.speakers={mode:'exact',count:2};
  assert.throws(()=>parseFunasrResponse(bundle.diarizeResponse,parseFunasrRequest(other)),/Speaker declaration mismatch/);
  assert.throws(()=>parseFunasrResponse(bundle.diarizeResponse,request),/operation mismatch/);
});

test('invalid, reversed, nonfinite, out-of-range and partial recognition fails without sorting or clipping',()=>{
  const mutations:((cp:FunasrCheckpoint)=>void)[]=[cp=>cp.sentences[0].startMs=-1,cp=>cp.sentences[0].startMs=21,
    cp=>cp.sentences[2].startMs=19,cp=>cp.sentences[4].endMs=1001,
    cp=>cp.vad[0].endMs=0,cp=>cp.source.sampleCount=1,
    cp=>{(cp.complete as boolean)=false;},cp=>{(cp.timeUnit as string)='s';},
    cp=>cp.sentences[0].endMs=NaN,cp=>cp.sentences[0].endMs=Infinity,cp=>cp.sentences[0].endMs=-Infinity,
    cp=>cp.sentences=[],cp=>cp.text='\ud800',cp=>cp.recognitionChunks=[]];
  for(const mutate of mutations)assert.throws(()=>parseFunasrArchive(changed(mutate)));
  const gap=changed(cp=>{cp.vad=[{startMs:0,endMs:10},{startMs:30,endMs:1000}];cp.recognitionChunks.push({vadIndex:1,text:''});});
  assert.throws(()=>parseFunasrArchive(gap),/shared VAD basis/);
  const reversedVad=changed(cp=>{cp.vad=[{startMs:20,endMs:30},{startMs:0,endMs:10}];});
  assert.throws(()=>parseFunasrArchive(reversedVad),/timeline/);
});

test('fractional PCM milliseconds and zero-length model sentences remain exact, with no fabricated word timing',()=>{
  const cp=parseFunasrArchive(changed(value=>{value.sentences[0].endMs=.0625;value.sentences[2].endMs=100;}));
  assert.equal(cp.sentences[0].endMs,.0625);assert.equal(cp.sentences[2].startMs,cp.sentences[2].endMs);
  const outputs=new FileOutputRegistry();outputs.register(funasrTranscriptOutput);
  const projected=outputs.decode(funasrTranscriptOutput,{...recognition,checkpoint:archive(cp)}).transcript;
  assert.equal(projected.segments[0].endMs,.0625);assert.equal(projected.segments.length,5);
  assert.ok(projected.segments.every(s=>s.words===undefined));
});

test('oversize output rejects at byte, text, segment, VAD and acoustic budgets',()=>{
  assert.throws(()=>parseFunasrResponse(Buffer.alloc(FUNASR_LIMITS.wireBytes+1,32)),/byte limit/);
  assert.throws(()=>parseFunasrArchive({sha256:hash(''),json:' '.repeat(FUNASR_LIMITS.checkpointBytes+1)}));
  assert.throws(()=>parseFunasrArchive(changed(cp=>cp.text='中'.repeat(Math.floor(FUNASR_LIMITS.textBytes/3)+1))));
  assert.throws(()=>parseFunasrArchive(changed(cp=>cp.sentences=Array(FUNASR_LIMITS.sentences+1).fill(cp.sentences[0]))));
  assert.throws(()=>parseFunasrArchive(changed(cp=>cp.vad=Array(FUNASR_LIMITS.vad+1).fill(cp.vad[0]))));
  const response=JSON.parse(bundle.diarizeResponse);
  response.diarization.segments=Array(FUNASR_LIMITS.acousticSegments+1).fill(response.diarization.segments[0]);
  assert.throws(()=>parseFunasrResponse(response));
});

test('missing assignments, invented labels, invalid acoustics and invalid speaker previews cannot become a complete result',()=>{
  const mutations:((value:any)=>void)[]=[r=>r.diarization.assignments.pop(),r=>r.diarization.assignments[2]='SPEAKER_None',
    r=>r.diarization.assignments[2]=42,r=>r.diarization.assignments[4]=0,
    r=>r.diarization.segments[1].endMs=1001,r=>r.diarization.segments[1].startMs=-1,
    r=>r.diarization.segments.reverse(),r=>r.diarization.samples[0].wavBase64='bm90IHdhdg==',
    r=>r.diarization.samples[1].speaker=0,r=>r.diarization.samples[0].endMs=1001];
  for(const mutate of mutations){const response=JSON.parse(bundle.diarizeResponse);mutate(response);assert.throws(()=>parseFunasrResponse(response));}
});

test('unknown, explicit count and range stay distinct without a silhouette estimate',()=>{
  for(const speakers of [{mode:'unknown'},{mode:'exact',count:2},{mode:'range',min:2,max:4}]){
    const response=JSON.parse(bundle.diarizeResponse);response.diarization.speakers=speakers;
    const expected=parseFunasrRequest({...bundle.diarizeRequest,speakers});
    const parsed=parseFunasrResponse(response,expected);assert.equal(parsed.status,'succeeded');
    const projection=projectFunasrDiarization(checkpoint,response.diarization);
    assert.equal(projection.expectedSpeakers,speakers.mode==='exact'?2:null);
    assert.deepEqual(projection.declaredRange,speakers.mode==='range'?{min:2,max:4}:undefined);
    assert.equal(projection.estimate,undefined);
  }
  for(const speakers of [{mode:'unknown',count:2},{mode:'exact',count:0},{mode:'range',min:4,max:2},{mode:'range',min:2}])
    assert.throws(()=>parseFunasrRequest({...bundle.diarizeRequest,speakers}));
});

test('all production failure messages distinguish unstarted waits, terminated work, cancellation and unknown results',()=>{
  const codes=[];
  for(const wire of bundle.failures){
    const result=parseFunasrResponse(wire);assert.notEqual(result.status,'succeeded');
    if(result.status==='succeeded')throw Error('Expected failure');
    codes.push(result.code);assert.equal(result.status,FUNASR_FAILURES[result.code].status);
    assert.equal(result.execution,FUNASR_FAILURES[result.code].execution);
    assert.equal(result.retryAfterMs,result.code==='resource_busy'?5000:null);
  }
  assert.deepEqual(codes.sort(),Object.keys(FUNASR_FAILURES).sort());
  const unknown=JSON.parse(bundle.failures.find((wire:string)=>JSON.parse(wire).code==='response_unknown'));
  assert.throws(()=>parseFunasrResponse({...unknown,status:'cancelled'}));
  const outputs=new FileOutputRegistry();outputs.register(funasrTranscriptOutput);
  assert.throws(()=>outputs.decode(funasrTranscriptOutput,unknown),/complete stage output/);
});
