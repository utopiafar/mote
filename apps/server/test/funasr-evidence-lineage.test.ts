import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Plugin} from '@deepseek-ai/cordis';
import {fileProcessingSchema,type Transcript} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {FileProcessing} from '../src/file-processing.js';
import {FileReviews} from '../src/file-reviews.js';
import {MaterialStore} from '../src/materials.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';
import {MemoryStore,memoryEvidenceFingerprint} from '../src/memory.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {cleanedDialogueOutput} from '../src/file-dialogue.js';
import {cleanupTranscript,TRANSCRIPT_CLEANUP} from '../src/transcript-cleanup.js';
import {FUNASR_PINS,funasrTranscriptOutput,parseFunasrResponse} from '../src/funasr-contract.js';
import {fixtureFilePolicy} from './fixtures/file-policy.js';
import {fixtureMemoryPipeline,fixtureMemoryResult} from './fixtures/memory-result.js';

// The model boundary is generated, but the bytes are serialized by the same
// production Python contract used by the FunASR worker. FileStore, publication,
// chunks, Material, search, Memory and Ask consumers below are the real modules.
const producer=spawnSync('python3',['-c',`
import base64,copy,json
import mote_asr_contract as c
from test_mote_asr_contract import generated_identity,generated_source,generated_preview
source=generated_source()
request={'protocol':c.PROTOCOL,'operation':'recognize','audioSha256':source['audioSha256'],'maxAudioMs':1000,'identity':generated_identity()}
rows=[(0,200,'不是不是不是。',0),(0,200,'不是不是不是。',0),(200,210,'嗯。',0),
      (250,500,'使用扣迪斯。',0),(250,500,'使用扣迪斯。',0),(250,500,'使用扣迪士。',0),
      (250,500,'使用扣迪斯。',1),(450,700,'重叠发言。',1),(600,1000,'一百块。',1)]
native={'text':'  原始识别全文：'+''.join(row[2] for row in rows)+'  ',
        'sentence_info':[{'start':start,'end':end,'text':text} for start,end,text,_ in rows]}
recognition=c.recognize_to_checkpoint(request,source,request['identity'],{'value':[[0,1000]]},native,[{'text':native['text']}])
archive=json.loads(recognition)['checkpoint']
def diarize(flip):
  diarize_request={**request,'operation':'diarize','checkpoint':archive,'speakers':{'mode':'unknown'}}
  speakers=copy.deepcopy(native['sentence_info'])
  for sentence,row in zip(speakers,rows): sentence['spk']=(1-row[3]) if flip else row[3]
  segments=[[0,.5,1],[.25,1,0]] if flip else [[0,.5,0],[.25,1,1]]
  result=c.speakers_from_sdk(c.read_checkpoint(archive),diarize_request['speakers'],speakers,segments,
    [{'speaker':0,'startMs':0,'endMs':20,'wavBase64':generated_preview()},
     {'speaker':1,'startMs':250,'endMs':300,'wavBase64':generated_preview()}])
  return c.diarize_from_checkpoint(diarize_request,source,request['identity'],lambda cp,options:result)
print(c.serialize({'recognition':recognition,'diarization':diarize(False),'rediarization':diarize(True),'native':native}))
`],{cwd:fileURLToPath(new URL('../../../scripts/',import.meta.url)),encoding:'utf8',timeout:30_000,maxBuffer:4*1024*1024});
assert.equal(producer.status,0,producer.stderr||String(producer.error));
const generated=JSON.parse(producer.stdout) as {recognition:unknown;diarization:unknown;rediarization:unknown;native:{sentence_info:{text:string}[]}};
const wave=Buffer.alloc(32044);
wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(16000,24);wave.writeUInt32LE(32000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(32000,40);

const expectedTexts=['不是不是不是。','嗯。','使用扣迪斯。','使用扣迪士。','使用扣迪斯。','重叠发言。','一百块。'];
const expectedSpeakers=['SPEAKER_0','SPEAKER_0','SPEAKER_0','SPEAKER_0','SPEAKER_1','SPEAKER_1','SPEAKER_1'];
const expectedTimes=[[0,200],[200,210],[250,500],[250,500],[250,500],[450,700],[600,1000]];
type Fixture={
  id:string;store:Store;sources:SourceStore;files:FileStore;processing:FileProcessing;reviews:FileReviews;memories:MemoryStore;reader:EvidenceReader;
  setCleanup(enabled:boolean):void;rediarize():void;cleanupCount():number;settle(id?:string):Promise<void>;
  upload(revision:string,previousRevision:string|null,observedAt?:string):Promise<string>;
  holdRecognition():{started:Promise<void>;release:()=>void};
};
async function fixture(t:TestContext):Promise<Fixture>{
  const directory=mkdtempSync(join(tmpdir(),'mote-funasr-evidence-lineage-')),store=new Store(directory,{dataKey:'79'.repeat(32),contentEncryptionEnabled:true}),sources=new SourceStore(store),files=new FileStore(store,sources);
  let processing:FileProcessing|undefined,cleanupEnabled=true,diarization:'diarization'|'rediarization'='diarization',held:{started:()=>void;gate:Promise<void>;release:()=>void}|undefined;
  const counts={recognize:0,diarize:0,cleanup:0};
  t.after(async()=>{try{await processing?.close();}finally{if(store.db.isOpen)store.close();rmSync(directory,{recursive:true,force:true});}});
  sources.register({id:'generated-audio',name:'Generated audio',kind:'local-files',deviceId:'generated-phone',platform:'android',retention:'archive'});
  const plugin:Plugin={name:'generated-funasr-evidence-boundary',inject:['moteFileProcessors'],apply(ctx){ctx.effect(()=>{
    const disposes=[
      ctx.moteFileProcessors.register({id:'generated.funasr',version:'1',name:'Generated FunASR boundary',stage:'extract',mediaTypes:['audio/'],dialogue:true,allowSummary:false,
        parameters:[{key:'speakerCount',label:'Generated exact people',type:'number',nullable:true,default:null,min:1,max:16,integer:true},
          {key:'speakerMin',label:'Generated minimum',type:'number',nullable:true,default:null,min:1,max:16,integer:true},
          {key:'speakerMax',label:'Generated maximum',type:'number',nullable:true,default:null,min:1,max:16,integer:true},
          {key:'deduplicate',label:'Generated cleanup',type:'boolean',default:true},
          {key:'transcriptCleanup',label:'Generated cleanup switch',type:'boolean',default:true},
          {key:'semanticTurns',label:'Generated turns',type:'boolean',default:false}],
        dependencies:{settings:['endpoint','apiKey'],parameters:[]},output:funasrTranscriptOutput,recipe:FUNASR_PINS.recipe,
        async process(input){counts.recognize++;const parts:Buffer[]=[];for await(const part of input.readOriginal())parts.push(part);assert.deepEqual(Buffer.concat(parts),wave);
          if(held){const gate=held;held=undefined;gate.started();await gate.gate;}return JSON.parse(String(generated.recognition));}}),
      ctx.moteFileProcessors.register({id:'generated.cam',version:'1',name:'Generated CAM boundary',stage:'diarize',mediaTypes:['audio/'],dependencies:{settings:[],parameters:[]},
        async process(input){counts.diarize++;const response=parseFunasrResponse(generated[diarization]);assert.equal(response.status,'succeeded');
          if(response.status!=='succeeded'||response.operation!=='diarize')throw Error('Expected generated diarization');
          assert.equal(input.recognition?.sha256,response.checkpoint.sha256);return JSON.parse(String(generated[diarization]));}}),
    ];
    return ()=>disposes.reverse().forEach(dispose=>dispose());
  });}};
  const cleanup={id:TRANSCRIPT_CLEANUP.id,version:TRANSCRIPT_CLEANUP.version,output:cleanedDialogueOutput,
    process:(input:{transcript:Transcript;checkpoint:{sentences:{precision:'sentence'|'vad'|'unknown'}[]}})=>{counts.cleanup++;return cleanupTranscript(input.transcript,{enabled:cleanupEnabled},input.checkpoint.sentences.map(sentence=>sentence.precision));}};
  processing=new FileProcessing(files,{transcribe:async()=>{throw Error('The default ASR transport is outside this fixture');}},undefined,{plugins:[plugin],dialogueCleanup:cleanup});
  await processing.runtime.ready;
  const settings=fileProcessingSchema.parse({...processing.currentSettings(),audioProcessor:'generated.funasr',diarizationProcessor:'generated.cam',speakerCount:null,speakerMin:null,speakerMax:null,semanticTurns:false,summarize:false});
  const policyFor=(cleanup:boolean)=>{const policy=fixtureFilePolicy(settings,processing!.runtime.registry);policy.profiles.find(profile=>profile.processorId==='generated.funasr')!.parameters.transcriptCleanup=cleanup;return policy;};
  processing.update({revision:processing.view().revision,settings,policy:policyFor(true)});
  const manifest=(revision:string,previousRevision:string|null,observedAt='2026-11-14T00:00:00Z')=>({sourceId:'generated-audio',previousRevision,item:{externalId:'generated.wav',revision,observedAt,title:'Generated conversation.wav',kind:'file',layer:'original' as const,text:'',mimeType:'audio/wav',deleted:false},sizeBytes:wave.length,sha256:sha256(wave)});
  const upload=async(revision:string,previousRevision:string|null,observedAt?:string)=>{const session=files.begin(manifest(revision,previousRevision,observedAt),()=>{});files.part(session.uploadId,0,wave,()=>{});return String((await files.commit(session.uploadId,()=>{})).id);};
  const id=await upload('1',null);
  const settle=async(target=id)=>{for(const until=Date.now()+15_000;Date.now()<until;){await processing!.tick();await new Promise<void>(resolve=>setImmediate(resolve));const job=files.detail(target).job;if(!['running','waiting'].includes(job.state)||job.state==='waiting'&&job.error)return;}assert.fail('Generated FunASR file work did not settle: '+JSON.stringify(files.detail(target).job));};
  const memories=new MemoryStore(store,ids=>[...store.evidence(ids),...files.evidence(ids)],evidenceId=>files.isCurrentEvidence(evidenceId)||store.isCurrentEvidence(evidenceId));
  const reader=new EvidenceReader(store,sources,files);
  return {id,store,sources,files,processing,reviews:new FileReviews(files,processing),memories,reader,
    setCleanup:enabled=>{cleanupEnabled=enabled;processing!.update({revision:processing!.view().revision,settings:processing!.currentSettings(),policy:policyFor(enabled)});},rediarize:()=>{diarization='rediarization';},cleanupCount:()=>counts.cleanup,settle,upload,
    holdRecognition:()=>{let started!:()=>void,release!:()=>void;const began=new Promise<void>(resolve=>started=resolve),gate=new Promise<void>(resolve=>release=resolve);held={started,gate,release};return {started:began,release};}};
}
function resultFor(id:string,quote:string){return {answer:JSON.stringify({memories:[{title:'Generated speech memory',statement:`Recorded speech [${id}]`,uncertainty:'Generated fixture',evidenceIds:[id]}]}),citations:[{id,capturedAt:'2026-11-14T00:00:00Z',appName:'Generated conversation',excerpt:quote}],trace:[],runId:'generated-funasr-lineage'};}
function saveMemory(memories:MemoryStore,record:{id:string;ocrText:string;capturedAt:string;appName:string}){
  const memory=memories.extract(fixtureMemoryResult(memories,resultFor(record.id,record.ocrText)),'fixture').items[0];
  memories.publish(memory.id);return memory;
}
async function material(f:Fixture){
  const materials=new MaterialStore(f.store),organizers=new MaterialOrganizerRuntime(f.store,materials);
  const tick=async()=>{for(let count=0;count<20;count++)if(!(await organizers.tick(100)))return;};
  await tick();const found=materials.list({kind:'mote.file'}).items.find(item=>item.kind==='mote.file');
  return {materials,organizers,tick,found};
}

test('standard FunASR publication exposes one current text view with capture, revision, artifact, chunk, time and anonymous speaker',async t=>{
  const f=await fixture(t);await f.settle();
  const chunks=f.files.chunks(f.id);
  assert.deepEqual(chunks.map(chunk=>chunk.fileEvidence!.artifactId),Array(7).fill(chunks[0].fileEvidence!.artifactId));
  assert.deepEqual(chunks.map(chunk=>chunk.fileEvidence!.speaker),expectedSpeakers);
  assert.deepEqual(chunks.map(chunk=>[chunk.fileEvidence!.startMs,chunk.fileEvidence!.endMs]),expectedTimes);
  assert.deepEqual(chunks.map(chunk=>chunk.fileEvidence!.chunkId),chunks.map(chunk=>chunk.id));
  assert.ok(chunks.every(chunk=>chunk.fileEvidence!.captureId===f.id&&chunk.fileEvidence!.revision==='1'));
  assert.equal(new Set(chunks.map(chunk=>chunk.id)).size,7,'same-time and blank-adjacent turns keep distinct evidence');
  assert.ok(chunks.every(chunk=>chunk.fileEvidence!.speakerAttribution===undefined),'automatic clusters are not owner identities');
  const dialogue=f.processing.artifact(chunks[0].fileEvidence!.artifactId);
  assert.equal(dialogue.output.type.id,'mote.cleaned-dialogue');
  assert.equal(dialogue.transcript.uncorrected,true);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM file_artifacts WHERE capture_id=? AND kind='corrected-dialogue'").get(f.id)!.n,0,'automatic output is not owner-confirmed text');
  assert.deepEqual(dialogue.transcript.segments.map((segment:any)=>segment.text),expectedTexts);
  const rawArtifactId=String(f.store.db.prepare("SELECT id FROM file_artifacts WHERE capture_id=? AND kind='transcript' AND current=1").get(f.id)!.id);
  const raw=f.processing.artifact(rawArtifactId);
  assert.equal(raw.transcript.segments.length,9);
  const rawChunk=String(f.store.db.prepare('SELECT id FROM file_chunks WHERE artifact_id=? LIMIT 1').get(rawArtifactId).id);
  assert.equal(f.files.isCurrentEvidence(rawChunk),false,'the untouched raw transcript is history, not a second current fact');
  assert.equal(f.files.searchPage({query:'使用扣迪斯',limit:100}).items.length,2,'only the current dialogue enters search');
  assert.equal(f.files.searchPage({query:'重叠发言',limit:100}).items[0]?.fileEvidence!.overlap,undefined);
  assert.equal(f.files.searchPage({query:'嗯',limit:100}).items.length,1);
  const {materials,organizers,tick,found}=await material(f);
  try{
    assert.ok(found);const text=materials.read(found!.ref).text;
    for(const expected of expectedTexts)assert.match(text,new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    const blocks=[];for(let index=0;index<20;index++){const block=materials.block(found!.ref,index)?.block;if(!block)break;if(block.locator?.chunkId)blocks.push(block);}
    assert.equal(blocks.length,7);
    assert.deepEqual(blocks.map(block=>block.locator!.startMs),expectedTimes.map(([start])=>start));
    assert.deepEqual(blocks.map(block=>block.locator!.chunkId),chunks.map(chunk=>chunk.id));
    assert.match(text,/"speaker":"SPEAKER_0"/);
    await tick();
  }finally{await organizers.close();}
});

test('anonymous clusters and owner names stay traceable in Ask and Memory without pretending the owner spoke',async t=>{
  const f=await fixture(t);await f.settle();
  const anonymous=f.files.chunks(f.id)[0],anonymousMemory=saveMemory(f.memories,anonymous);
  assert.equal(anonymousMemory.evidence![0].fileEvidence?.speaker,'SPEAKER_0');
  assert.equal(anonymousMemory.evidence![0].fileEvidence?.speakerAttribution,undefined);
  assert.equal(anonymousMemory.evidence![0].fileEvidence?.captureId,f.id);
  assert.equal(anonymousMemory.evidence![0].fileEvidence?.chunkId,anonymous.id);
  const asked=f.reader.chunks({id:'capture:'+f.id});
  assert.equal(asked[0].fileEvidence?.speaker,'SPEAKER_0');
  assert.equal(asked[0].fileEvidence?.speakerAttribution,undefined);
  const artifactId=anonymous.fileEvidence!.artifactId;
  f.reviews.nameSpeakers(f.id,{artifactId,names:{SPEAKER_0:'Generated 甲',SPEAKER_1:'Generated 乙'}});
  const named=f.files.chunks(f.id);
  assert.equal(named[0].fileEvidence!.speakerAttribution!.name,'Generated 甲');
  assert.equal(named[0].fileEvidence!.speakerAttribution!.confirmedBy,'owner');
  assert.equal(named[0].ocrText,'[SPEAKER_0] 不是不是不是。','naming never rewrites the recognized speech');
  const namedMemory=saveMemory(f.memories,named[0]);
  const evidence=namedMemory.evidence![0];
  assert.equal(evidence.fileEvidence?.speaker,'SPEAKER_0');
  assert.equal(evidence.fileEvidence?.speakerAttribution?.name,'Generated 甲');
  assert.notEqual(evidence.fileEvidence?.speaker,'owner');
  t.diagnostic(JSON.stringify({chunk:named[0].fileEvidence,memoryEvidence:evidence.fileEvidence}));
  assert.deepEqual(f.reader.chunks({id:'capture:'+f.id}).map(record=>record.fileEvidence!.speakerAttribution?.name??null),['Generated 甲','Generated 甲','Generated 甲','Generated 甲','Generated 乙','Generated 乙','Generated 乙']);
  const {materials,organizers,found}=await material(f);
  try{
    assert.ok(found);const text=materials.read(found!.ref).text;
    assert.match(text,/"speakerAttribution":\{"name":"Generated 甲"/);
    assert.match(text,/"speaker":"SPEAKER_1"/);
  }finally{await organizers.close();}
});

test('cleanup revisions keep a single indexed text and preserve unchanged chunk, name and Memory evidence',async t=>{
  const f=await fixture(t);await f.settle();
  const stable=f.files.chunks(f.id)[2],artifactId=stable.fileEvidence!.artifactId;
  f.reviews.nameSpeakers(f.id,{artifactId,names:{SPEAKER_0:'Generated 甲',SPEAKER_1:'Generated 乙'}});
  const before=f.files.chunks(f.id).find(chunk=>chunk.id===stable.id)!;
  const memory=saveMemory(f.memories,before),fingerprint=memoryEvidenceFingerprint(before);
  const oldDialogue=f.processing.artifact(artifactId),oldJson=JSON.stringify(oldDialogue);
  const rawArtifactId=String(f.store.db.prepare("SELECT id FROM file_artifacts WHERE capture_id=? AND kind='transcript' AND current=1").get(f.id)!.id);
  const rawChunkId=String(f.store.db.prepare('SELECT id FROM file_chunks WHERE artifact_id=? LIMIT 1').get(rawArtifactId).id);
  f.setCleanup(false);f.processing.retry(f.id,'transcribe',true);await f.settle();
  assert.equal(f.cleanupCount(),2);
  const disabled=f.files.chunks(f.id);
  assert.equal(disabled.length,9);
  assert.deepEqual(disabled.map(chunk=>chunk.fileEvidence!.speaker),['SPEAKER_0','SPEAKER_0','SPEAKER_0','SPEAKER_0','SPEAKER_0','SPEAKER_0','SPEAKER_1','SPEAKER_1','SPEAKER_1']);
  assert.equal(f.files.searchPage({query:'不是不是不是',limit:100}).items.length,2,'raw duplicates appear once each in the identity view');
  assert.equal(f.files.isCurrentEvidence(rawChunkId),false,'raw transcript remains historical');
  const kept=disabled.find(chunk=>chunk.id===stable.id)!;
  assert.equal(kept.fileEvidence!.speakerAttribution!.name,'Generated 甲','unchanged speech keeps its owner confirmation through cleanup');
  assert.equal(memoryEvidenceFingerprint(kept),fingerprint,'unchanged text, location, speaker and confirmation keep the same evidence fingerprint');
  assert.equal(f.memories.get(memory.id).status,'published');
  assert.equal(JSON.stringify(f.processing.artifact(artifactId)),oldJson,'the disabled revision did not rewrite retained cleanup evidence');
});

test('an owner text correction keeps untouched FunASR evidence and invalidates only the edited segment',async t=>{
  const f=await fixture(t);await f.settle();
  const before=f.files.chunks(f.id),artifactId=before[0].fileEvidence!.artifactId;
  f.reviews.nameSpeakers(f.id,{artifactId,names:{SPEAKER_0:'Generated 甲',SPEAKER_1:'Generated 乙'}});
  const named=f.files.chunks(f.id),stable=named[2],edited=named[5];
  const oldDialogue=JSON.stringify(f.processing.artifact(artifactId));
  const stableMemory=saveMemory(f.memories,stable),editedMemory=saveMemory(f.memories,edited);
  const corrected=f.reviews.correct(f.id,{artifactId,chunkId:edited.id,originalText:edited.ocrText.replace(/^\[SPEAKER_\d+\] /,''),correctedText:'重叠发言，继续。'});
  assert.equal(corrected.status,'accepted');
  const after=f.files.chunks(f.id);
  assert.equal(after.length,7);
  assert.equal(after[2].id,stable.id,'the unedited segment keeps its chunk, location and confirmed name');
  assert.equal(after[2].fileEvidence!.speakerAttribution!.name,'Generated 甲');
  assert.equal(after[2].fileEvidence!.startMs,stable.fileEvidence!.startMs);
  assert.equal(after[2].fileEvidence!.endMs,stable.fileEvidence!.endMs);
  assert.notEqual(after[5].id,edited.id);
  assert.equal(after[5].fileEvidence!.speakerAttribution!.name,'Generated 乙','a text-only correction keeps the acoustic confirmation');
  assert.equal(after[5].ocrText,'[SPEAKER_1] 重叠发言，继续。');
  assert.equal(f.files.isCurrentEvidence(edited.id),false);
  assert.equal(f.memories.get(stableMemory.id).status,'published');
  assert.equal(f.memories.get(editedMemory.id).status,'stale');
  assert.throws(()=>f.memories.publish(editedMemory.id),{statusCode:409});
  const latest=f.files.detail(f.id).artifacts.find((artifact:any)=>artifact.kind==='corrected-dialogue');
  assert.ok(latest,'an owner correction is stored as confirmed text, never as a second automatic dialogue');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM file_artifacts WHERE capture_id=? AND kind='corrected-dialogue'").get(f.id)!.n,1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM file_artifacts WHERE capture_id=? AND kind='dialogue' AND current=1").get(f.id)!.n,1);
  assert.equal(JSON.stringify(f.processing.artifact(artifactId)),oldDialogue,'the original derived dialogue is not rewritten');
  assert.deepEqual(f.reader.chunks({id:'capture:'+f.id}).map(record=>record.fileEvidence!.speakerAttribution?.name??null),['Generated 甲','Generated 甲','Generated 甲','Generated 甲','Generated 乙','Generated 乙','Generated 乙']);
  assert.match(f.files.searchPage({query:'重叠发言，继续',limit:100}).items[0].ocrText,/继续/);
});

test('renaming or clearing a speaker invalidates only the dependent label and removes old names from Ask',async t=>{
  const f=await fixture(t);await f.settle();
  const chunks=f.files.chunks(f.id),artifactId=chunks[0].fileEvidence!.artifactId;
  f.reviews.nameSpeakers(f.id,{artifactId,names:{SPEAKER_0:'Generated 甲',SPEAKER_1:'Generated 乙'}});
  const named=f.files.chunks(f.id),first=saveMemory(f.memories,named[0]),other=saveMemory(f.memories,named[4]);
  f.reviews.nameSpeakers(f.id,{artifactId,names:{SPEAKER_0:'Generated 丙',SPEAKER_1:'Generated 乙'}});
  const renamed=f.files.chunks(f.id);
  assert.equal(renamed[0].fileEvidence!.speakerAttribution!.name,'Generated 丙');
  assert.equal(renamed[4].fileEvidence!.speakerAttribution!.name,'Generated 乙');
  assert.equal(f.memories.get(first.id).status,'stale');
  assert.equal(f.memories.get(other.id).status,'published','an unaffected speaker keeps its Memory');
  assert.equal(f.memories.list().length,1);
  assert.ok(f.reader.chunks({id:'capture:'+f.id}).every(record=>record.fileEvidence!.speakerAttribution?.name!=='Generated 甲'));
  assert.throws(()=>f.memories.publish(first.id),{statusCode:409});
  f.reviews.nameSpeakers(f.id,{artifactId,names:{}});
  const cleared=f.files.chunks(f.id);
  assert.deepEqual(cleared.map(chunk=>chunk.id),renamed.map(chunk=>chunk.id),'clearing names does not replace speech evidence');
  assert.ok(cleared.every(chunk=>chunk.fileEvidence!.speakerAttribution===undefined));
  assert.equal(f.memories.get(other.id).status,'stale','withdrawing the remaining confirmation invalidates its Memory');
  assert.ok(f.reader.chunks({id:'capture:'+f.id}).every(record=>record.fileEvidence!.speakerAttribution===undefined));
});

test('re-diarization retires old names, old chunk identities and every dependent Memory while keeping raw history',async t=>{
  const f=await fixture(t);await f.settle();
  const before=f.files.chunks(f.id),artifactId=before[0].fileEvidence!.artifactId;
  f.reviews.nameSpeakers(f.id,{artifactId,names:{SPEAKER_0:'Generated 甲',SPEAKER_1:'Generated 乙'}});
  const memory=saveMemory(f.memories,f.files.chunks(f.id)[0]);
  const oldArtifactJson=JSON.stringify(f.processing.artifact(artifactId));
  f.rediarize();f.processing.retry(f.id,'diarize');await f.settle();
  const after=f.files.chunks(f.id);
  assert.deepEqual(after.map(chunk=>chunk.fileEvidence!.speaker),['SPEAKER_1','SPEAKER_1','SPEAKER_1','SPEAKER_1','SPEAKER_0','SPEAKER_0','SPEAKER_0']);
  assert.notEqual(after[0].fileEvidence!.artifactId,artifactId);
  assert.ok(after.every(chunk=>chunk.fileEvidence!.speakerAttribution===undefined),'a new acoustic result cannot inherit names from the old clusters');
  const unchangedBefore=before.find(chunk=>chunk.fileEvidence!.speaker==='SPEAKER_1'&&chunk.fileEvidence!.startMs===250&&chunk.ocrText.includes('使用扣迪斯'))!;
  const unchangedAfter=after.find(chunk=>chunk.fileEvidence!.speaker==='SPEAKER_1'&&chunk.fileEvidence!.startMs===250&&chunk.ocrText.includes('使用扣迪斯'))!;
  assert.equal(unchangedAfter.id,unchangedBefore.id,'identical text, location and label keep the chunk identity even when the acoustic basis changed');
  assert.ok(after.some(chunk=>!before.some(old=>old.id===chunk.id)),'changed labels receive new evidence identities');
  assert.equal(f.files.isCurrentEvidence(unchangedAfter.id),true);
  assert.ok(before.some(chunk=>f.files.isCurrentEvidence(chunk.id)===false),'changed speech retires its old evidence identity');
  assert.equal(f.memories.get(memory.id).status,'stale');
  assert.equal(f.memories.list().length,0);
  assert.throws(()=>f.memories.publish(memory.id),{statusCode:409});
  assert.equal(JSON.stringify(f.processing.artifact(artifactId)),oldArtifactJson,'historical dialogue remains readable unchanged');
  f.reviews.nameSpeakers(f.id,{artifactId:after[0].fileEvidence!.artifactId,names:{SPEAKER_1:'Generated 丙'}});
  assert.equal(f.files.chunks(f.id)[0].fileEvidence!.speakerAttribution!.name,'Generated 丙');
  assert.doesNotThrow(()=>saveMemory(f.memories,f.files.chunks(f.id)[0]));
});

test('a new original revision fences a late extraction and a late Memory result without reviving the retired revision',async t=>{
  const f=await fixture(t);const hold=f.holdRecognition(),first=f.processing.tick();await hold.started;
  const next=await f.upload('2','1','2026-11-14T01:00:00Z');
  hold.release();await first;await f.settle(f.id);
  const stale=f.files.detail(f.id);
  assert.equal(stale.job.state,'stale');assert.equal(stale.job.error,'input_changed');
  assert.equal(stale.artifacts.length,0);assert.equal(f.files.chunks(f.id).length,0,'a late extraction cannot publish into the superseded revision');
  assert.equal(f.files.readableFile(f.id),undefined,'the retired revision is not a current Ask file');
  const found=f.files.searchPage({query:'使用扣迪斯',limit:100}).items;
  assert.ok(found.length>0&&found.every(chunk=>chunk.fileEvidence!.captureId===next),'search only exposes the current original');
  assert.equal(f.memories.list({includeStale:true}).length,0);
  await f.settle(next);
  const current=f.files.chunks(next);
  assert.equal(current.length,7);assert.ok(current.every(chunk=>f.files.isCurrentEvidence(chunk.id)));
  assert.equal(f.files.readableFile(next),next);
  assert.equal(f.files.searchPage({query:'使用扣迪斯',limit:100}).items.length,2);
  let enter!:()=>void,finish!:(value:ReturnType<typeof resultFor>)=>void;const entered=new Promise<void>(resolve=>enter=resolve);
  const pipeline=fixtureMemoryPipeline({store:f.store,memories:f.memories,models:{model:()=> 'fixture',configured:()=>true},phases:{query:async()=>{enter();return new Promise(resolve=>finish=resolve);}}});t.after(()=>pipeline.close());
  const job=pipeline.create({evidenceIds:[current[0].id]}),running=pipeline.run(job.id);await entered;
  const third=await f.upload('3','2','2026-11-14T02:00:00Z');
  finish(resultFor(current[0].id,current[0].ocrText));const done=await running;
  assert.equal(done.status,'failed');assert.equal(done.batches[0].status,'invalidated');
  assert.equal(f.memories.list({includeStale:true}).length,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_checkpoints').get()!.n,0);
  assert.equal(f.files.isCurrentEvidence(current[0].id),false);
  await f.settle(third);
  assert.ok(f.files.chunks(third).every(chunk=>f.files.isCurrentEvidence(chunk.id)));
});

test('deleting a recording while extraction is in flight drops the late result and its dependents',async t=>{
  const f=await fixture(t);const hold=f.holdRecognition(),tick=f.processing.tick();await hold.started;
  f.files.forget(f.id);hold.release();await tick;
  assert.throws(()=>f.files.version(f.id),{statusCode:404});
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM file_chunks').get()!.n,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM file_artifacts').get()!.n,0);
  assert.equal(f.files.searchPage({query:'使用扣迪斯',limit:100}).items.length,0);
});
