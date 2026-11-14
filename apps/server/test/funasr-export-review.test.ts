import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import type {Plugin} from '@deepseek-ai/cordis';
import {fileProcessingSchema,transcriptSchema} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {FileProcessing} from '../src/file-processing.js';
import {FileReviews,latestFileTranscript} from '../src/file-reviews.js';
import {fileExportEntries,exportTar} from '../src/file-export.js';
import {cleanedDialogueOutput,prepareFunasrDialogue,readDialogueCleanup} from '../src/file-dialogue.js';
import {funasrTranscriptOutput,parseFunasrArchive,parseFunasrResponse} from '../src/funasr-contract.js';
import {fixtureFilePolicy} from './fixtures/file-policy.js';

// Model boundaries only: the actual Python producer serializes both stages.
// The same bytes feed the output registry, durable FileProcessing publication,
// real SQLite/chunks, FileReviews and export. No handwritten TS success envelope.
const producer=spawnSync('python3',['-c',`
import base64,copy,json
import mote_asr_contract as c
from test_mote_asr_contract import generated_identity,generated_source,generated_preview
source=generated_source()
request={'protocol':c.PROTOCOL,'operation':'recognize','audioSha256':source['audioSha256'],'maxAudioMs':1000,'identity':generated_identity()}
rows=[(0,200,'不是不是不是。',0),(0,200,'不是不是不是。',0),
      (250,500,'使用扣迪斯。',0),(250,500,'使用扣迪斯。',0),
      (250,500,'使用扣迪士。',0),(250,500,'使用扣迪斯。',1),(600,1000,'一百块。',1)]
native={'text':'  原始识别全文：'+''.join(row[2] for row in rows)+'  ',
        'sentence_info':[{'start':s,'end':e,'text':text} for s,e,text,_ in rows]}
recognition=c.recognize_to_checkpoint(request,source,request['identity'],{'value':[[0,1000]]},native,[{'text':native['text']}])
archive=json.loads(recognition)['checkpoint']
diarize_request={**request,'operation':'diarize','checkpoint':archive,'speakers':{'mode':'unknown'}}
speakers=copy.deepcopy(native['sentence_info'])
for sentence,row in zip(speakers,rows): sentence['spk']=row[3]
result=c.speakers_from_sdk(c.read_checkpoint(archive),diarize_request['speakers'],speakers,[[0,.5,0],[.25,1,1]],
                         [{'speaker':0,'startMs':0,'endMs':20,'wavBase64':generated_preview()}])
diarization=c.diarize_from_checkpoint(diarize_request,source,request['identity'],lambda cp,options:result)
coarse_recognition=c.recognize_to_checkpoint(request,source,request['identity'],{'value':[[0,1000]]},native,[{'text':native['text']}],precision='vad')
coarse_request={**diarize_request,'checkpoint':json.loads(coarse_recognition)['checkpoint']}
coarse_diarization=c.diarize_from_checkpoint(coarse_request,source,request['identity'],lambda cp,options:result)
print(c.serialize({'recognition':recognition,'diarization':diarization,'coarseDiarization':coarse_diarization,'native':native}))
`],{cwd:fileURLToPath(new URL('../../../scripts/',import.meta.url)),encoding:'utf8',timeout:30_000,maxBuffer:4*1024*1024});
assert.equal(producer.status,0,producer.stderr||String(producer.error));
const generated=JSON.parse(producer.stdout),nativeResponse=parseFunasrResponse(generated.diarization);
if(nativeResponse.status!=='succeeded'||nativeResponse.operation!=='diarize')throw Error('Expected generated diarization');
const checkpoint=parseFunasrArchive(nativeResponse.checkpoint);
const wave=Buffer.alloc(32044);
wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(16000,24);wave.writeUInt32LE(32000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(32000,40);
assert.equal(sha256(wave),checkpoint.source.audioSha256);

async function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-funasr-export-review-')),store=new Store(directory,{dataKey:'68'.repeat(32),contentEncryptionEnabled:true}),sources=new SourceStore(store),files=new FileStore(store,sources);
  let processing:FileProcessing|undefined;
  t.after(async()=>{try{await processing?.close();}finally{if(store.db.isOpen)store.close();rmSync(directory,{recursive:true,force:true});}});
  sources.register({id:'generated-audio',name:'Generated audio',kind:'local-files',deviceId:'generated-phone',platform:'android',retention:'archive'});
  const upload=files.begin({sourceId:'generated-audio',item:{externalId:'generated.wav',revision:'1',observedAt:'2026-10-01T00:00:00Z',title:'Generated conversation.wav',kind:'file',layer:'original',text:'',mimeType:'audio/wav',deleted:false},sizeBytes:wave.length,sha256:sha256(wave)},()=>{});
  files.part(upload.uploadId,0,wave,()=>{});const {id}=await files.commit(upload.uploadId,()=>{});
  const counts={recognize:0,diarize:0,cleanup:0,review:0};
  const plugin:Plugin={name:'generated-cleanup-producer',inject:['moteFileProcessors','moteFileOutputs','moteFileRecipes'],apply(ctx){ctx.effect(()=>{
    const disposes=[ctx.moteFileOutputs.register(cleanedDialogueOutput)];
    disposes.push(ctx.moteFileProcessors.register({id:'generated.funasr',version:'1',name:'Generated FunASR boundary',stage:'extract',mediaTypes:['audio/'],dialogue:true,allowSummary:false,
      parameters:[{key:'transcriptCleanup',label:'Generated cleanup setting',type:'boolean',default:true}],
      dependencies:{settings:[],parameters:[]},output:funasrTranscriptOutput,recipe:{id:'generated.audio-cleanup',version:'1'},
      async process(input){counts.recognize++;const parts:Buffer[]=[];for await(const part of input.readOriginal())parts.push(part);assert.deepEqual(Buffer.concat(parts),wave);return JSON.parse(generated.recognition);}}));
    disposes.push(ctx.moteFileProcessors.register({id:'generated.cam',version:'1',name:'Generated CAM boundary',stage:'diarize',mediaTypes:['audio/'],dependencies:{settings:[],parameters:[]},async process(input){counts.diarize++;assert.equal(input.recognition?.sha256,nativeResponse.checkpoint.sha256);return JSON.parse(generated.diarization);}}));
    disposes.push(ctx.moteFileRecipes.registerStage({id:'generated.dialogue-cleanup',version:'1',run:context=>context.transform(cleanedDialogueOutput,async()=>{
      counts.cleanup++;
      const stored=context.readArtifact(context.dependencies.extract) as {output:{payload:unknown}},response=parseFunasrResponse(stored.output.payload);
      assert.equal(response.status,'succeeded');if(response.status!=='succeeded')throw Error('Expected stored recognition');
      assert.equal(response.checkpoint.json,nativeResponse.checkpoint.json);
      return prepareFunasrDialogue(generated.diarization,{enabled:context.input.parameters?.transcriptCleanup!==false});
    })}));
    disposes.push(ctx.moteFileRecipes.registerRecipe({id:'generated.audio-cleanup',version:'1',steps:[
      {name:'extract',stage:{id:'mote.extract',version:'1'},dependsOn:[]},
      {name:'diarize',stage:{id:'mote.diarize',version:'1'},dependsOn:['extract']},
      {name:'cleanup',stage:{id:'generated.dialogue-cleanup',version:'1'},dependsOn:['extract','diarize']},
    ],output:'cleanup'}));
    return ()=>disposes.reverse().forEach(dispose=>dispose());
  });}};
  processing=new FileProcessing(files,{transcribe:async()=>{throw Error('The default ASR is outside this fixture');}},undefined,{plugins:[plugin],analyze:async records=>{
    counts.review++;
    const target=records.map(record=>JSON.parse(record.ocrText)).find(row=>row.text==='使用扣迪士。');assert.ok(target);
    return {answer:JSON.stringify({suggestions:[{chunkId:target.chunkId,original:'扣迪士',replacement:'扣迪斯',reason:'Generated owner review candidate.'}]}),citations:[{id:target.chunkId}]};
  }});
  const runtime=processing;await runtime.runtime.ready;
  const settings=fileProcessingSchema.parse({...runtime.currentSettings(),audioProcessor:'generated.funasr',diarizationProcessor:'generated.cam',speakerCount:null,summarize:false});
  const save=(enabled?:boolean)=>{
    const policy=fixtureFilePolicy(settings,runtime.runtime.registry);
    if(enabled!==undefined)policy.profiles.find(p=>p.processorId==='generated.funasr')!.parameters.transcriptCleanup=enabled;
    runtime.update({revision:runtime.view().revision,settings,policy});
  };
  save();
  const json=(artifactId:string)=>String(store.db.prepare('SELECT json FROM file_artifacts WHERE capture_id=? AND id=?').get(id,artifactId)!.json);
  const current=(kind:string)=>{const row=store.db.prepare('SELECT id,json FROM file_artifacts WHERE capture_id=? AND kind=? AND current=1 ORDER BY rowid DESC LIMIT 1').get(id,kind)!;return {id:String(row.id),json:String(row.json),data:JSON.parse(String(row.json))};};
  return {id,store,files,processing:runtime,reviews:new FileReviews(files,runtime),counts,save,json,current};
}
const exported=(files:FileStore,id:string)=>new Map(fileExportEntries(files,id).map(entry=>[entry.name,entry.bytes]));
const read=(entries:Map<string,Buffer>,name:string)=>{assert.ok(entries.has(name),name);return JSON.parse(entries.get(name)!.toString());};

test('the production VAD-precision serializer cannot authorize deletion of repeated utterances in the same coarse interval',()=>{
  const output=prepareFunasrDialogue(generated.coarseDiarization);
  assert.deepEqual(output.transcript,output.uncleanedTranscript);
  assert.deepEqual(output.transcript.segments.map(s=>s.text),checkpoint.sentences.map(s=>s.text));
  assert.deepEqual(output.cleanup.sourceToDerived,[0,1,2,3,4,5,6]);
});

test('production FunASR bytes publish one uncorrected dialogue view while preserving the full raw checkpoint and speaker result',async t=>{
  const f=await fixture(t);await f.processing.tick();assert.equal(f.files.detail(f.id).job.state,'succeeded');
  const raw=f.current('transcript'),dialogue=f.current('dialogue'),cleanup=readDialogueCleanup(dialogue.data)!;
  assert.equal(raw.data.output.payload.checkpoint.json,nativeResponse.checkpoint.json);
  assert.deepEqual(parseFunasrArchive(raw.data.output.payload.checkpoint),checkpoint);
  assert.deepEqual(raw.data.transcript.segments.map((s:{text:string})=>s.text),generated.native.sentence_info.map((s:{text:string})=>s.text));
  assert.equal(cleanup.uncleanedTranscript.segments.length,7);assert.equal(cleanup.transcript.segments.length,5);
  assert.deepEqual(cleanup.cleanup.sourceToDerived,[0,0,1,1,2,3,4]);
  assert.equal(cleanup.transcript.segments[0].text,'不是不是不是。');
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM file_artifacts WHERE capture_id=? AND kind='corrected-dialogue'").get(f.id)!.n,0);
  const chunks=f.files.chunks(f.id);assert.equal(chunks.length,5);assert.ok(chunks.every(c=>c.fileEvidence?.artifactId===dialogue.id));
  assert.deepEqual(new Set(f.files.pendingIndex('generated-model').map(c=>c.id)),new Set(chunks.map(c=>c.id)));
  const found=f.files.searchPage({query:'扣迪斯',limit:100}).items;
  assert.equal(found.length,2);assert.ok(found.every(c=>c.fileEvidence?.artifactId===dialogue.id));
  const entries=exported(f.files,f.id),manifest=read(entries,'manifest.json');
  assert.equal(manifest.selectedTranscript.artifactId,dialogue.id);assert.equal(manifest.selectedTranscript.kind,'dialogue');
  assert.deepEqual(read(entries,'dialogue.original.json'),cleanup.uncleanedTranscript);
  assert.deepEqual(read(entries,'dialogue.derived.json'),cleanup.transcript);
  assert.deepEqual(read(entries,'dialogue.cleanup.json'),cleanup.cleanup);
  assert.equal(read(entries,`artifacts/${raw.id}.json`).data.output.payload.checkpoint.json,nativeResponse.checkpoint.json);
  assert.equal(parseFunasrArchive(read(entries,`artifacts/${raw.id}.json`).data.output.payload.checkpoint).text,generated.native.text);
  const locations=read(entries,'locations.json');assert.deepEqual(locations.segments.map((s:{chunkId:string})=>s.chunkId),chunks.map(c=>c.id));
  assert.deepEqual(locations.segments.map((s:{startMs:number;endMs:number})=>[s.startMs,s.endMs]),cleanup.transcript.segments.map(s=>[s.startMs,s.endMs]));
  assert.ok(entries.has('speaker_samples/SPEAKER_0.wav'));assert.match(entries.get('diarization.rttm')!.toString(),/SPEAKER_1/);
  t.diagnostic(JSON.stringify({processingVersion:cleanup.cleanup.processingVersion,enabled:cleanup.cleanup.enabled,sourceToDerived:cleanup.cleanup.sourceToDerived,rawSegments:7,derivedSegments:chunks.length}));
});

test('an explicit cleanup setting revision restores every saved speaker row without recognizing again or rewriting history',async t=>{
  const f=await fixture(t);await f.processing.tick();const raw=f.current('transcript'),first=f.current('dialogue');
  f.save(false);
  assert.equal(f.current('dialogue').id,first.id,'changing the default does not automatically reprocess history');
  f.processing.retry(f.id,'transcribe',true);await f.processing.tick();assert.equal(f.files.detail(f.id).job.state,'succeeded');
  const second=f.current('dialogue'),off=readDialogueCleanup(second.data)!,on=readDialogueCleanup(first.data)!;
  assert.notEqual(second.id,first.id);assert.notEqual(off.cleanup.processingVersion,on.cleanup.processingVersion);
  assert.deepEqual(off.transcript,on.uncleanedTranscript);assert.deepEqual(off.cleanup.sourceToDerived,[0,1,2,3,4,5,6]);
  assert.equal(f.json(first.id),first.json);assert.equal(f.json(raw.id),raw.json);
  assert.deepEqual(f.counts,{recognize:1,diarize:1,cleanup:2,review:0});
  assert.equal(f.files.chunks(f.id).length,7);assert.equal(f.files.pendingIndex('generated-model').length,7);
  const entries=exported(f.files,f.id),manifest=read(entries,'manifest.json');
  assert.equal(manifest.selectedTranscript.artifactId,second.id);assert.equal(manifest.cleanupVersions.length,2);
  assert.equal(read(entries,`artifacts/${first.id}.json`).current,false);
  assert.deepEqual(read(entries,`artifacts/${first.id}.json`).data,first.data);
});

for(const manual of [true,false])test(`${manual?'direct manual edits':'confirmed term proposals'} keep intentional duplicates and distinct anonymous clusters without rerunning cleanup`,async t=>{
  const f=await fixture(t);await f.processing.tick();const raw=f.current('transcript'),dialogue=f.current('dialogue'),before=f.files.chunks(f.id);
  f.reviews.nameSpeakers(f.id,{artifactId:dialogue.id,names:{SPEAKER_0:'Generated same display name',SPEAKER_1:'Generated same display name'}});
  const named=f.files.chunks(f.id),proposal=await f.reviews.propose(f.id,{kind:'terms'}),stale=await f.reviews.propose(f.id,{kind:'terms'}),
    target=before.find(c=>c.ocrText.includes('扣迪士'))!;
  if(manual)f.reviews.correct(f.id,{artifactId:dialogue.id,chunkId:target.id,originalText:'使用扣迪士。',correctedText:'使用扣迪斯。'});
  else f.reviews.confirm(f.id,proposal.id,{action:'accept',selected:[proposal.suggestions[0].id]});
  const after=f.files.chunks(f.id),current=latestFileTranscript(f.files,f.id),corrected=f.current('corrected-dialogue');
  assert.equal(after.length,5);assert.equal(current.kind,'corrected-dialogue');assert.equal(current.transcript.uncorrected,undefined);
  assert.deepEqual(current.transcript.segments.slice(1,3).map(s=>s.text),['使用扣迪斯。','使用扣迪斯。'],'human intent cannot silently collapse even identical time/cluster/text');
  assert.deepEqual(after.map(c=>c.fileEvidence!.speaker),before.map(c=>c.fileEvidence!.speaker));
  assert.deepEqual(after.map(c=>c.fileEvidence!.speakerAttribution),named.map(c=>c.fileEvidence!.speakerAttribution));
  assert.equal(corrected.data.inputArtifact,dialogue.id);assert.equal(corrected.data.inputProcessingVersion,readDialogueCleanup(dialogue.data)!.cleanup.processingVersion);
  assert.equal(f.json(raw.id),raw.json);assert.equal(f.json(dialogue.id),dialogue.json);
  assert.deepEqual(f.counts,{recognize:1,diarize:1,cleanup:1,review:2});
  assert.throws(()=>f.reviews.confirm(f.id,stale.id,{action:'accept',selected:[stale.suggestions[0].id]}),{statusCode:409});
  const entries=exported(f.files,f.id),manifest=read(entries,'manifest.json');
  assert.equal(manifest.selectedTranscript.artifactId,corrected.id);assert.equal(manifest.selectedTranscript.kind,'corrected-dialogue');
  assert.equal(read(entries,'dialogue.corrected.json').inputArtifact,dialogue.id);
  assert.deepEqual(read(entries,'dialogue.original.json'),readDialogueCleanup(dialogue.data)!.uncleanedTranscript);
  assert.deepEqual(read(entries,'原始转写.json'),raw.data.transcript);
  const locations=read(entries,'locations.json');assert.ok(locations.segments.every((s:{artifactId:string})=>s.artifactId===corrected.id));
  assert.equal(f.files.pendingIndex('generated-model').length,5);
});

test('export retains historical human lineage and cleanup maps, writes valid archive bytes, and enforces the size limit',async t=>{
  const f=await fixture(t);await f.processing.tick();const dialogue=f.current('dialogue'),target=f.files.chunks(f.id).at(-1)!;
  f.reviews.correct(f.id,{artifactId:dialogue.id,chunkId:target.id,originalText:'一百块。',correctedText:'一百零一块。'});
  const first=f.current('corrected-dialogue'),next=f.files.chunks(f.id).at(-1)!;
  f.reviews.correct(f.id,{artifactId:first.id,chunkId:next.id,originalText:'一百零一块。',correctedText:'一百零二块。'});
  const entries=fileExportEntries(f.files,f.id),manifest=JSON.parse(entries.find(e=>e.name==='manifest.json')!.bytes.toString());
  assert.equal(manifest.artifacts.find((a:{id:string})=>a.id===first.id).current,false);
  assert.equal(JSON.parse(entries.find(e=>e.name===`artifacts/${first.id}.json`)!.bytes.toString()).data.inputArtifact,dialogue.id);
  const parts:Buffer[]=[];for await(const part of exportTar(entries))parts.push(part);
  const tar=gunzipSync(Buffer.concat(parts));let offset=0;
  for(const entry of entries){const header=tar.subarray(offset,offset+512),size=parseInt(header.subarray(124,136).toString(),8);assert.equal(header.subarray(0,100).toString().replace(/\0.*$/s,''),entry.name);assert.equal(size,entry.bytes.length);assert.deepEqual(tar.subarray(offset+512,offset+512+size),entry.bytes);offset+=512+Math.ceil(size/512)*512;}
  assert.throws(()=>fileExportEntries(f.files,f.id,entries.reduce((total,e)=>total+e.bytes.length,0)-1),{statusCode:413});
  assert.equal(f.files.detail(f.id).hasOriginal,true);
});

test('review and export reject a projection detached from its stored cleanup evidence',async t=>{
  const f=await fixture(t);await f.processing.tick();const dialogue=f.current('dialogue'),broken=structuredClone(dialogue.data);
  broken.transcript.segments[0].text='Different published text';
  assert.throws(()=>readDialogueCleanup(broken),/does not match/);
  f.store.db.prepare('UPDATE file_artifacts SET json=? WHERE id=?').run(JSON.stringify(broken),dialogue.id);
  assert.throws(()=>latestFileTranscript(f.files,f.id),/does not match/);
  assert.throws(()=>fileExportEntries(f.files,f.id),/does not match/);
  assert.deepEqual(transcriptSchema.parse(JSON.parse(f.json(f.current('transcript').id)).transcript).segments.map(s=>s.text),checkpoint.sentences.map(s=>s.text));
});

test('exporting current and retained processing versions never discloses an internal cache donor receipt',async t=>{
  const f=await fixture(t);await f.processing.tick();const first=f.current('dialogue');
  f.save(false);f.processing.retry(f.id,'transcribe',true);await f.processing.tick();
  const donor='generated-private-donor-origin',receipt={captureId:donor,artifactId:donor+'-artifact',title:'Generated private donor title'};
  f.store.db.prepare("UPDATE file_artifacts SET json=json_set(json,'$.reuse',json(?)) WHERE capture_id=?").run(JSON.stringify(receipt),f.id);
  const retainedBefore=f.json(first.id),entries=exported(f.files,f.id);
  assert.ok(![...entries.values()].some(bytes=>bytes.includes(donor)));
  assert.equal(read(entries,`artifacts/${first.id}.json`).data.reuse,undefined);
  assert.equal(f.json(first.id),retainedBefore,'export filters disclosure without rewriting retained evidence');
  assert.deepEqual(read(entries,`artifacts/${first.id}.json`).data.output.payload,first.data.output.payload);
});
