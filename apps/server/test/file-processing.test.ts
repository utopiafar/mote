import {ServerDiagnostics} from '../src/diagnostics.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import sharp from 'sharp';
import {type Plugin} from '@deepseek-ai/cordis';
import {type Transcript,diarizationSchema,transcriptSchema,fileProcessingSchema} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {FileProcessing} from '../src/file-processing.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {FileProcessorRuntime} from '../src/file-processors.js';
import {alignDialogue,applySemanticGroups} from '../src/file-dialogue.js';
import {FileReviews} from '../src/file-reviews.js';
import {Conversations} from '../src/conversations.js';
import {fileExportEntries,exportTar} from '../src/file-export.js';
import {MemoryStore,memoryEvidenceFingerprint} from '../src/memory.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';
import {MaterialMemoryWork} from '../src/material-memory-work.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {evidenceDependents} from '../src/evidence-dependencies.js';
import {sourceMaterialView} from '../src/source-material-view.js';

const raw:Transcript={durationMs:3000,segments:[{startMs:0,endMs:1000,text:'使用扣迪斯插件。',words:[{startMs:0,endMs:300,text:'使用'},{startMs:300,endMs:700,text:'扣迪斯'},{startMs:700,endMs:1000,text:'插件。'}]},{startMs:1500,endMs:2500,text:'嗯，对，尚未完成。'}]};
const wave=Buffer.alloc(32044);wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(16000,24);wave.writeUInt32LE(32000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(32000,40);
const diary=diarizationSchema.parse({durationMs:3000,engine:'synthetic',expectedSpeakers:2,observedSpeakers:2,overlapDetection:'unknown',segments:[{startMs:0,endMs:1100,speaker:'SPEAKER_0'},{startMs:1400,endMs:2600,speaker:'SPEAKER_1'}],samples:[{speaker:'SPEAKER_0',startMs:0,endMs:1000,wavBase64:wave.toString('base64')}]});
async function fixture(t:any,options:any={}){
 const dir=mkdtempSync(join(tmpdir(),'mote-processing-')),store=new Store(dir,{dataKey:'41'.repeat(32),contentEncryptionEnabled:true}),sources=new SourceStore(store),files=new FileStore(store,sources);
 sources.register({id:'phone',name:'Synthetic phone',kind:'local-files',deviceId:'phone',platform:'android',retention:'archive'});
 const bytes=options.file?.bytes??wave,filename=options.file?.name??'fixture.wav';
 const manifest={sourceId:'phone',item:{externalId:filename,revision:'1',observedAt:new Date().toISOString(),title:options.file?.name??'Synthetic interview.wav',kind:'file',layer:'original',text:'',mimeType:options.file?.mimeType??'audio/wav',deleted:false},sizeBytes:bytes.length,sha256:sha256(bytes)};
 const begun=files.begin(manifest,()=>{});files.part(begun.uploadId,0,bytes,()=>{});const ack=await files.commit(begun.uploadId,()=>{});let asrCalls=0,diaryCalls=0,summaries=0,disposed=false;
 const plugin:Plugin={name:'fixture-diarizer',inject:['moteFileProcessors'],apply(ctx){ctx.effect(()=>{const dispose=ctx.moteFileProcessors.register({id:'fixture.diarize',name:'Synthetic diarizer',version:'1',stage:'diarize',localOnly:true,mediaTypes:['audio/'],async process(){diaryCalls++;if(options.failFirst&&diaryCalls===1)throw Error('generated failure');return options.diarization??diary;}});return()=>{disposed=true;dispose();};});}};
 const diagnostics=new ServerDiagnostics({directory:join(dir,'logs'),debug:true});await diagnostics.init();
 const instances:FileProcessing[]=[];const createProcessing=(executor?:ExecutionEngine)=>{const instance=new FileProcessing(files,{transcribe:async()=>{asrCalls++;return options.transcribe?options.transcribe():raw;}},async()=>{summaries++;throw Error('Unexpected cloud summary');},{executor,plugins:[plugin],analyze:options.analyze,diagnostics});instances.push(instance);return instance;};const processing=createProcessing();
 await processing.runtime.ready;
 processing.update({revision:processing.view().revision,settings:{...processing.view().settings,enabled:true,audioProcessor:'audio.local-dialogue',diarizationProcessor:'fixture.diarize',speakerCount:2,summarize:true,...options.settings}});
 t.after(async()=>{for(const instance of instances)await instance.close();await diagnostics.close();store.close();rmSync(dir,{recursive:true,force:true});});
 return {dir,store,sources,files,processing,createProcessing,diagnostics,id:ack.id,counts:()=>({asrCalls,diaryCalls,summaries,disposed})};
}

test('unverified acoustic labels can outnumber bounded speaker previews without losing the transcript',async t=>{
 const data={...diary,expectedSpeakers:null,observedSpeakers:48,segments:Array.from({length:48},(_,i)=>({startMs:i*50,endMs:(i+1)*50,speaker:'SPEAKER_'+i})),samples:diary.samples,warnings:['Generated labels are not confirmed people.']};
 assert.doesNotThrow(()=>diarizationSchema.parse(data));
 assert.throws(()=>diarizationSchema.parse({...data,observedSpeakers:101}));
 assert.throws(()=>diarizationSchema.parse({...data,samples:Array(17).fill(diary.samples[0])}));
 const f=await fixture(t,{diarization:data,settings:{speakerCount:null}});await f.processing.tick();
 const detail=f.files.detail(f.id);assert.equal(detail.job.state,'succeeded');
 const artifact=detail.artifacts.find((a:any)=>a.kind==='diarization')!;assert.equal(artifact.observedSpeakers,48);
 assert.ok(detail.artifacts.some((a:any)=>a.kind==='transcript'));assert.ok(f.files.chunks(f.id).length>0);
 assert.equal(f.counts().asrCalls,1);assert.equal(f.counts().diaryCalls,1);
});

test('actual Cordis registration and disposal; local pipeline checkpoints resume without repeating ASR',async t=>{
 const f=await fixture(t,{failFirst:true});await f.processing.tick();assert.equal(f.files.detail(f.id).job.state,'failed');assert.equal(f.files.detail(f.id).artifacts.filter((a:any)=>a.kind==='transcript').length,1);
 // Reconstruct the engine and Cordis runtime, leaving the persisted checkpoint in place.
 await f.processing.close();const resumed=f.createProcessing();await resumed.runtime.ready;
 f.store.db.prepare("UPDATE execution_steps SET available_at=0 WHERE kind='files.pipeline'").run();f.store.db.prepare('UPDATE file_jobs SET available_at=0').run();await resumed.tick();assert.equal(f.files.detail(f.id).job.state,'succeeded');assert.deepEqual(f.counts(),{asrCalls:1,diaryCalls:2,summaries:0,disposed:true});
 const chunks=f.files.chunks(f.id);assert.equal(chunks.length,2);assert.equal(chunks[0].ocrText,'[SPEAKER_0] 使用扣迪斯插件。');assert.equal(chunks[1].fileEvidence?.speaker,'SPEAKER_1');
 assert.equal(f.files.pendingIndex('cloud-model').length,0);assert.equal(f.files.pendingIndex('local-model',true).length,2);
 await f.processing.close();assert.equal(f.counts().disposed,true);assert.equal(f.processing.runtime.registry.list().length,0);
});

test('diarization retries invalidate corrected downstream content while preserving raw extraction',async t=>{
 const f=await fixture(t);await f.processing.tick();const before=f.files.detail(f.id).artifacts.find((a:any)=>a.kind==='transcript')!.id;
 f.processing.retry(f.id,'diarize');await f.processing.tick();assert.equal(f.files.detail(f.id).job.state,'succeeded');assert.equal(f.counts().asrCalls,1);assert.equal(f.counts().diaryCalls,2);assert.equal(f.files.detail(f.id).artifacts.find((a:any)=>a.kind==='transcript')!.id,before);
});

test('alignment preserves Chinese characters, anonymous overlap/unknown markers, and grouping cannot rewrite or omit evidence',()=>{
 const result=alignDialogue(raw,diary);assert.equal(result.segments[0].text,raw.segments[0].text);assert.equal(result.segments[1].text,raw.segments[1].text);assert.ok(result.warnings?.length);
 const overlap=alignDialogue(raw,{...diary,segments:[...diary.segments,{startMs:0,endMs:1000,speaker:'SPEAKER_1'}]});assert.ok(overlap.segments[0].overlap);assert.ok(overlap.segments[0].uncertain);
 assert.equal(alignDialogue(raw,{...diary,segments:[]}).segments[0].speaker,'SPEAKER_UNKNOWN');
 assert.throws(()=>applySemanticGroups(result,[[1],[0]]));assert.throws(()=>applySemanticGroups(result,[[0]]));assert.throws(()=>applySemanticGroups(result,[[0,1]]));assert.deepEqual(applySemanticGroups(result,[[0],[1]]).segments,result.segments);
 assert.throws(()=>transcriptSchema.parse({...raw,segments:[{...raw.segments[0],words:[{startMs:900,endMs:100,text:'bad'}]}]}));
});

test('export contains raw and speaker transcripts, valid tar headers, encrypted samples, and forget cascades derived state',async t=>{
 const f=await fixture(t);await f.processing.tick();const entries=fileExportEntries(f.files,f.id);
 for(const name of ['原始转写_未校正.md','带说话人_未校正完整记录.csv','diarization.rttm','diarization.json','diarization.csv','speaker_samples/SPEAKER_0.wav'])assert.ok(entries.some(e=>e.name===name),name);
 const parts:Buffer[]=[];for await(const part of exportTar(entries))parts.push(part);const tar=gunzipSync(Buffer.concat(parts));let offset=0;
 for(const entry of entries){const header=tar.subarray(offset,offset+512);assert.equal(header.subarray(0,100).toString().replace(/\0.*$/s,''),entry.name);const length=parseInt(header.subarray(124,136).toString(),8);assert.equal(length,entry.bytes.length);assert.deepEqual(tar.subarray(offset+512,offset+512+length),entry.bytes);offset+=512+Math.ceil(length/512)*512;}
 const hash=String(f.store.db.prepare('SELECT object_hash FROM file_assets').get()!.object_hash);assert.notDeepEqual(readFileSync(join(f.files.objects,hash,'0.aes')),wave);
 assert.throws(()=>f.files.asset(f.id,f.files.detail(f.id).artifacts.find((a:any)=>a.kind==='diarization')!.id,'../original'),{statusCode:404});
 f.files.forget(f.id);for(const table of ['file_steps','file_assets','file_reviews','file_chunks'])assert.equal(f.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n,0);
});

test('term proposals require exact cited text and explicit selection; correction preserves raw export and rejects stale proposals',async t=>{
 const f=await fixture(t,{analyze:async(records:any[],_prompt:string,_settings:any,local:boolean)=>{assert.equal(local,true);const chunk=JSON.parse(records[0].ocrText);return {answer:JSON.stringify({suggestions:[{chunkId:chunk.chunkId,original:'扣迪斯',replacement:'Cordis',reason:'请确认框架名称'}]}),citations:[{id:chunk.chunkId}]};}});await f.processing.tick();const reviews=new FileReviews(f.files,f.processing),proposal=await reviews.propose(f.id,{kind:'terms'}),other=await reviews.propose(f.id,{kind:'terms'});
 assert.match(f.files.chunks(f.id)[0].ocrText,/扣迪斯/);assert.throws(()=>reviews.confirm(f.id,proposal.id,{action:'accept'}));
 const before=f.files.chunks(f.id)[0];reviews.nameSpeakers(f.id,{artifactId:before.fileEvidence!.artifactId,names:{SPEAKER_0:'Generated Alice'}});const attribution=f.files.chunks(f.id)[0].fileEvidence!.speakerAttribution;
 const suggestion=proposal.suggestions[0];reviews.confirm(f.id,proposal.id,{action:'accept',selected:[suggestion.id]});assert.match(f.files.chunks(f.id)[0].ocrText,/Cordis/);assert.throws(()=>reviews.confirm(f.id,other.id,{action:'accept',selected:[other.suggestions[0].id]}),{statusCode:409});
 assert.deepEqual(f.files.chunks(f.id)[0].fileEvidence!.speakerAttribution,attribution,'text-only correction preserves the actual owner confirmation');
 const entries=fileExportEntries(f.files,f.id);assert.match(entries.find(e=>e.name==='原始转写_未校正.md')!.bytes.toString(),/扣迪斯/);assert.match(entries.find(e=>e.name==='带说话人_已确认校正记录.md')!.bytes.toString(),/Cordis/);
 f.processing.retry(f.id,'diarize');await f.processing.tick();assert.match(f.files.chunks(f.id)[0].ocrText,/扣迪斯/);assert.equal(f.files.chunks(f.id)[0].fileEvidence!.speakerAttribution,undefined,'new acoustic separation cannot inherit old label identities');
});

for(const manual of [false,true])test(`confirmed ${manual?'manual':'model'} text correction preserves unrelated raw and formal memories and invalidates only replaced speech`,async t=>{
 const f=await fixture(t,{analyze:async(records:any[])=>{const chunk=JSON.parse(records[0].ocrText);return {answer:JSON.stringify({suggestions:[{chunkId:chunk.chunkId,original:'扣迪斯',replacement:'Cordis',reason:'Generated exact correction'}]}),citations:[{id:chunk.chunkId}]};}});
 await f.processing.tick();const reviews=new FileReviews(f.files,f.processing),artifactId=f.files.chunks(f.id)[0].fileEvidence!.artifactId;
 reviews.nameSpeakers(f.id,{artifactId,names:{SPEAKER_0:'Generated Alice',SPEAKER_1:'Generated Bob'}});
 const materials=new MaterialStore(f.store),work=new MaterialMemoryWork(f.store,materials),organizers=new MaterialOrganizerRuntime(f.store,materials,[],undefined,work);
 try{
  while(await organizers.tick(100));const material=materials.get(materialId('phone','fixture.wav'))!;
  const raw=f.files.chunks(f.id),formal=materials.evidence(materials.evidenceIds(material.ref)).filter(r=>JSON.parse(r.ocrText).speaker);
  const memories=new MemoryStore(f.store,ids=>[...f.files.evidence(ids),...materials.evidence(ids)],id=>f.files.isCurrentEvidence(id)||materials.isCurrentEvidence(id));
  const save=(record:typeof raw[number]|typeof formal[number])=>memories.publish(memories.extract({answer:JSON.stringify({memories:[{title:'Generated correction fixture',statement:`Generated speech [${record.id}]`,uncertainty:'Fixture',evidenceIds:[record.id],evidence:[{id:record.id,quote:record.ocrText}]}]}),citations:[{id:record.id,capturedAt:record.capturedAt,appName:record.appName,excerpt:record.ocrText}],trace:[],runId:'generated-text-correction'},'fixture').items[0].id);
  const savedRaw=raw.map(save),savedFormal=formal.map(save),stableFingerprint=memoryEvidenceFingerprint(raw[1]);
  const conversations=new Conversations(f.store),answers=raw.map(record=>conversations.append(undefined,{question:'Generated question'},{answer:'Generated answer '+record.id,citations:[],trace:[],runId:'generated',evidenceDependencies:{version:1,complete:true,ids:[record.id]}}));
  const derivedAnswers=[formal.map(record=>record.id),[savedFormal[0].id],[savedFormal[1].id]].map(ids=>conversations.append(undefined,{question:'Generated derived read without citations'},{answer:'Generated derived answer',citations:[],trace:[],runId:'generated',evidenceDependencies:{version:1,complete:true,ids}}));
  if(manual){const text=String(f.store.db.prepare('SELECT text FROM file_chunks WHERE id=?').get(raw[0].id)!.text);reviews.correct(f.id,{artifactId,chunkId:raw[0].id,originalText:text,correctedText:text.replace('扣迪斯','Cordis')});}
  else{const proposal=await reviews.propose(f.id,{kind:'terms'});reviews.confirm(f.id,proposal.id,{action:'accept',selected:[proposal.suggestions[0].id]});}
  const after=f.files.chunks(f.id);
  assert.equal(after[1].id,raw[1].id,'the unedited segment keeps its immutable evidence identity');
  assert.equal(memoryEvidenceFingerprint(after[1]),stableFingerprint);
  assert.equal(conversations.get(answers[0].conversationId).turns[0].evidenceDeleted,true);
  assert.equal(conversations.get(derivedAnswers[0].conversationId).turns[0].evidenceDeleted,true,'aggregate material read depends on the changed segment even without citations');
  assert.equal(conversations.get(derivedAnswers[1].conversationId).turns[0].evidenceDeleted,true,'derived memory read retains its segment lineage');
  assert.equal(conversations.get(derivedAnswers[2].conversationId).turns[0].result?.answer,'Generated derived answer');
  assert.equal(conversations.get(answers[1].conversationId).turns[0].result?.answer,'Generated answer '+raw[1].id);
  assert.notEqual(after[0].id,raw[0].id);assert.match(after[0].ocrText,/Cordis/);
  assert.equal(memories.get(savedRaw[0].id).status,'stale');assert.equal(memories.get(savedFormal[0].id).status,'stale');
  assert.equal(memories.get(savedRaw[1].id).status,'published');assert.equal(memories.get(savedFormal[1].id).status,'published');
  assert.deepEqual(after.map(r=>r.fileEvidence!.speakerAttribution),raw.map(r=>r.fileEvidence!.speakerAttribution));
  assert.throws(()=>materials.read(material.ref),{statusCode:409});assert.equal(work.readyForMemory(material.ref),false);
  while(await organizers.tick(100));const corrected=materials.get(material.id)!;
  assert.ok(materials.evidenceIds(corrected.ref).includes(formal[1].id));assert.equal(materials.isCurrentEvidence(formal[0].id),false);
  assert.equal(memories.get(savedFormal[1].id).status,'published');assert.match(materials.read(corrected.ref).text,/Cordis/);
  assert.match(materials.read(material.ref).text,/扣迪斯/);
  const entries=fileExportEntries(f.files,f.id);assert.match(entries.find(e=>e.name==='原始转写_未校正.md')!.bytes.toString(),/扣迪斯/);
 }finally{await organizers.close();}
});

test('a model cannot inject corrections outside cited chunks or guess a speaker name',async t=>{
 const f=await fixture(t,{analyze:async(records:any[])=>({answer:JSON.stringify({suggestions:[{chunkId:records[0].id,original:'not in evidence',replacement:'rewrite',reason:'bad'}]}),citations:[{id:records[0].id}]})});await f.processing.tick();const reviews=new FileReviews(f.files,f.processing);
 await assert.rejects(reviews.propose(f.id,{kind:'terms'}),{statusCode:502});assert.equal(reviews.list(f.id).items.length,0);
 const artifact=f.files.detail(f.id).artifacts.find((a:any)=>a.kind==='dialogue')!;assert.throws(()=>reviews.nameSpeakers(f.id,{artifactId:artifact.id,names:{SPEAKER_9:'Unknown'}}));reviews.nameSpeakers(f.id,{artifactId:artifact.id,names:{SPEAKER_0:'用户确认名'}});assert.ok(fileExportEntries(f.files,f.id).some(e=>e.name==='已确认说话人.json'));
});

test('confirmed speaker identities reach evidence without rewriting speech and only invalidate changed labels',async t=>{
 const f=await fixture(t);await f.processing.tick();const reviews=new FileReviews(f.files,f.processing),raw=f.files.chunks(f.id),artifactId=raw[0].fileEvidence!.artifactId;
 const save=(names:Record<string,string>)=>reviews.nameSpeakers(f.id,{artifactId,names});
 save({SPEAKER_0:'Generated Alice',SPEAKER_1:'Generated Bob'});
 const named=f.files.chunks(f.id);assert.deepEqual(named.map(r=>r.ocrText),raw.map(r=>r.ocrText));assert.deepEqual(named.map(r=>r.id),raw.map(r=>r.id));
 assert.equal(named[0].fileEvidence!.speakerAttribution!.name,'Generated Alice');assert.equal(named[0].fileEvidence!.speakerAttribution!.confirmedBy,'owner');
 assert.deepEqual(f.files.evidence(named.map(r=>r.id)).map(r=>r.fileEvidence),named.map(r=>r.fileEvidence));
 const memories=new MemoryStore(f.store,ids=>[...f.store.evidence(ids),...f.files.evidence(ids)],id=>f.files.isCurrentEvidence(id)||f.store.isCurrentEvidence(id));
 const saved=named.map(r=>memories.extract({answer:JSON.stringify({memories:[{title:'Generated attribution',statement:`Recorded speech [${r.id}]`,uncertainty:'Generated fixture',evidenceIds:[r.id],evidence:[{id:r.id,quote:r.ocrText}]}]}),citations:[{id:r.id,capturedAt:r.capturedAt,appName:r.appName,excerpt:r.ocrText}],trace:[],runId:'generated-attribution'},'fixture').items[0]);
 for(const memory of saved)memories.publish(memory.id);
 save({SPEAKER_0:'Generated Carol',SPEAKER_1:'Generated Bob'});
 const renamed=f.files.chunks(f.id);assert.notEqual(memoryEvidenceFingerprint(renamed[0]),memoryEvidenceFingerprint(named[0]));assert.equal(memoryEvidenceFingerprint(renamed[1]),memoryEvidenceFingerprint(named[1]));
 assert.equal(memories.get(saved[0].id).status,'stale');assert.equal(memories.get(saved[1].id).status,'published');assert.throws(()=>memories.publish(saved[0].id),{statusCode:409});
 const count=f.store.db.prepare("SELECT COUNT(*) n FROM file_artifacts WHERE kind='speaker-names'").get()!.n;
 save({SPEAKER_0:'Generated Carol',SPEAKER_1:'Generated Bob'});assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM file_artifacts WHERE kind='speaker-names'").get()!.n,count,'re-saving unchanged names is idempotent');
 save({SPEAKER_0:'Generated Carol'});assert.equal(f.files.chunks(f.id)[1].fileEvidence!.speakerAttribution,undefined);assert.equal(memories.get(saved[1].id).status,'stale');
 assert.deepEqual(f.files.chunks(f.id).map(r=>r.ocrText),raw.map(r=>r.ocrText));
});

test('speaker correction during Memory extraction fences the late response and clears checkpoints',async t=>{
 const f=await fixture(t);await f.processing.tick();const reviews=new FileReviews(f.files,f.processing),record=f.files.chunks(f.id)[0];
 reviews.nameSpeakers(f.id,{artifactId:record.fileEvidence!.artifactId,names:{SPEAKER_0:'Generated Alice'}});
 const memories=new MemoryStore(f.store,ids=>[...f.store.evidence(ids),...f.files.evidence(ids)],id=>f.files.isCurrentEvidence(id)||f.store.isCurrentEvidence(id));
 let enter!:()=>void,finish!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),release=new Promise<void>(resolve=>finish=resolve);
 const pipeline=new MemoryPipeline({store:f.store,memories,configured:()=>true,model:()=> 'fixture',query:async()=>{enter();await release;return {answer:JSON.stringify({memories:[{title:'Old attribution',statement:`Old speaker [${record.id}]`,uncertainty:'Generated',evidenceIds:[record.id],evidence:[{id:record.id,quote:record.ocrText}]}]}),citations:[{id:record.id,capturedAt:record.capturedAt,appName:record.appName,excerpt:record.ocrText}],trace:[],runId:'generated-old-attribution'};}});
 t.after(()=>pipeline.close());const job=pipeline.create({evidenceIds:[record.id]}),running=pipeline.run(job.id);await entered;
 reviews.nameSpeakers(f.id,{artifactId:record.fileEvidence!.artifactId,names:{SPEAKER_0:'Generated Carol'}});finish();
 const done=await running;assert.equal(done.status,'failed');assert.equal(done.batches[0].status,'invalidated');assert.equal(memories.list({includeStale:true}).length,0);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_checkpoints').get()!.n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_extraction_drafts').get()!.n,0);
 assert.equal(pipeline.create({evidenceIds:[record.id]}).totalBatches,1,'corrected attribution remains eligible for fresh extraction');
});

test('formal audio material preserves anonymous and confirmed speakers and republishes corrections',async t=>{
 const f=await fixture(t);await f.processing.tick();
 const materials=new MaterialStore(f.store),work=new MaterialMemoryWork(f.store,materials),organizers=new MaterialOrganizerRuntime(f.store,materials,[],undefined,work);
 const reviews=new FileReviews(f.files,f.processing),raw=f.files.chunks(f.id),artifactId=raw[0].fileEvidence!.artifactId;
 const id=materialId('phone','fixture.wav');
 const publish=async()=>{while(await organizers.tick(100));return materials.get(id)!;};
 try{
  const anonymous=await publish(),anonymousEvidence=materials.evidence(materials.evidenceIds(anonymous.ref));
  assert.ok(anonymousEvidence.some(record=>JSON.parse(record.ocrText).speaker==='SPEAKER_0'));
  assert.ok(anonymousEvidence.every(record=>JSON.parse(record.ocrText).speakerAttribution===undefined));
  reviews.nameSpeakers(f.id,{artifactId,names:{SPEAKER_0:'Generated Alice',SPEAKER_1:'Generated Bob'}});
  const named=await publish();assert.notEqual(named.revision,anonymous.revision);assert.equal(work.readyForMemory(named.ref),true);
  const namedRecords=materials.evidence(materials.evidenceIds(named.ref)),dialogue=namedRecords.map(record=>JSON.parse(record.ocrText)).filter(value=>value.speaker);
  assert.deepEqual(dialogue.map(value=>value.text),raw.map(record=>record.ocrText.replace(/^\[SPEAKER_\d+\] /,'')));
  assert.deepEqual(dialogue.map(value=>value.speakerAttribution),f.files.chunks(f.id).map(record=>record.fileEvidence!.speakerAttribution));
  const memories=new MemoryStore(f.store,ids=>materials.evidence(ids),anchor=>materials.isCurrentEvidence(anchor));
  const record=namedRecords.find(record=>JSON.parse(record.ocrText).speaker==='SPEAKER_0')!;
  const memory=memories.extract({answer:JSON.stringify({memories:[{title:'Generated owner experience',statement:`Generated speech [${record.id}]`,uncertainty:'Fixture',evidenceIds:[record.id],evidence:[{id:record.id,quote:record.ocrText}]}]}),citations:[{id:record.id,capturedAt:record.capturedAt,appName:record.appName,excerpt:record.ocrText}],trace:[],runId:'generated-material-speaker'},'fixture').items[0];
  memories.publish(memory.id);
  const other=namedRecords.find(record=>JSON.parse(record.ocrText).speaker==='SPEAKER_1')!;
  const otherFingerprint=memoryEvidenceFingerprint(other);
  const otherMemory=memories.extract({answer:JSON.stringify({memories:[{title:'Unchanged speaker',statement:`Generated speech [${other.id}]`,uncertainty:'Fixture',evidenceIds:[other.id],evidence:[{id:other.id,quote:other.ocrText}]}]}),citations:[{id:other.id,capturedAt:other.capturedAt,appName:other.appName,excerpt:other.ocrText}],trace:[],runId:'generated-unchanged-speaker'},'fixture').items[0];
  memories.publish(otherMemory.id);
  assert.ok(evidenceDependents(f.store,{kind:'file_chunk',id:raw[0].id}).some(node=>node.kind==='material_evidence'&&node.id===record.id));
  reviews.nameSpeakers(f.id,{artifactId,names:{SPEAKER_0:'Generated Carol',SPEAKER_1:'Generated Bob'}});
  assert.equal(memories.get(memory.id).status,'stale','old formal attribution is invalid immediately, before rebuilding');
  assert.equal(materials.isCurrentEvidence(record.id),false);
  assert.equal(materials.isCurrentEvidence(other.id),true);
  assert.equal(memories.get(otherMemory.id).status,'published');
  assert.equal(materials.get(id)?.coverage.reason,'source_evidence_changed');
  assert.equal(work.readyForMemory(named.ref),false);
  assert.throws(()=>materials.read(named.ref),{statusCode:409},'current whole-body read cannot expose old names while rebuilding');
  const corrected=await publish();assert.notEqual(corrected.revision,named.revision);assert.equal(work.readyForMemory(named.ref),false);
  assert.equal(memories.get(memory.id).status,'stale');assert.equal(materials.isCurrentEvidence(record.id),false);
  assert.equal(materials.isCurrentEvidence(other.id),true,'unaffected block anchor survives publication');
  assert.equal(memories.get(otherMemory.id).status,'published');
  assert.equal(memoryEvidenceFingerprint(materials.evidence([other.id])[0]),otherFingerprint);
  assert.ok(materials.evidenceIds(corrected.ref).includes(other.id));
  const reader=new EvidenceReader(f.store,f.sources,f.files,undefined,undefined,materials);
  assert.equal(reader.evidence([record.id]).length,0);
  assert.ok(reader.evidence([other.id])[0].provenance!.uri!.startsWith(corrected.ref+'#'));
  assert.ok(materials.read(named.ref).text.includes('Generated Alice'),'pinned history remains distinguishable from current state');
  const correctedDialogue=materials.evidence(materials.evidenceIds(id)).map(record=>JSON.parse(record.ocrText)).filter(value=>value.speaker);
  assert.equal(correctedDialogue[0].speakerAttribution.name,'Generated Carol');assert.equal(correctedDialogue[1].speakerAttribution.name,'Generated Bob');
  assert.deepEqual(correctedDialogue.map(value=>value.text),dialogue.map(value=>value.text));
  reviews.nameSpeakers(f.id,{artifactId,names:{SPEAKER_0:'Generated Carol',SPEAKER_1:'Generated Bob'}});assert.equal((await publish()).revision,corrected.revision);
  reviews.nameSpeakers(f.id,{artifactId,names:{SPEAKER_0:'Generated Carol'}});
  assert.equal(memories.get(otherMemory.id).status,'stale','withdrawing confirmation invalidates that speaker immediately');
  await publish();assert.equal(materials.evidence(materials.evidenceIds(id)).map(r=>JSON.parse(r.ocrText)).find(r=>r.speaker==='SPEAKER_1').speakerAttribution,undefined);
 }finally{await organizers.close();}
});

for(const correction of ['speaker','text'] as const)test(`formal ${correction} correction fences a late Memory result before organizer rebuild`,async t=>{
 const f=await fixture(t,{analyze:async(records:any[])=>{const chunk=JSON.parse(records[0].ocrText);return {answer:JSON.stringify({suggestions:[{chunkId:chunk.chunkId,original:'扣迪斯',replacement:'Cordis',reason:'Generated exact correction'}]}),citations:[{id:chunk.chunkId}]};}});await f.processing.tick();
 const materials=new MaterialStore(f.store),work=new MaterialMemoryWork(f.store,materials),organizers=new MaterialOrganizerRuntime(f.store,materials,[],undefined,work);
 const reviews=new FileReviews(f.files,f.processing),artifactId=f.files.chunks(f.id)[0].fileEvidence!.artifactId;
 reviews.nameSpeakers(f.id,{artifactId,names:{SPEAKER_0:'Generated Alice'}});
 const proposal=correction==='text'?await reviews.propose(f.id,{kind:'terms'}):undefined;
 while(await organizers.tick(100));
 const material=materials.get(materialId('phone','fixture.wav'))!;
 const record=materials.evidence(materials.evidenceIds(material.ref)).find(r=>JSON.parse(r.ocrText).speaker==='SPEAKER_0')!;
 const memories=new MemoryStore(f.store,ids=>materials.evidence(ids),id=>materials.isCurrentEvidence(id));
 let enter!:()=>void,finish!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),release=new Promise<void>(resolve=>finish=resolve);
 const pipeline=new MemoryPipeline({store:f.store,memories,configured:()=>true,model:()=> 'fixture',materialAllowedForMemory:ref=>work.readyForMemory(ref),query:async()=>{enter();await release;return {answer:JSON.stringify({memories:[{title:'Old formal attribution',statement:`Old speaker [${record.id}]`,uncertainty:'Generated',evidenceIds:[record.id],evidence:[{id:record.id,quote:record.ocrText}]}]}),citations:[{id:record.id,capturedAt:record.capturedAt,appName:record.appName,excerpt:record.ocrText}],trace:[],runId:'generated-old-formal-attribution'};}});
 try{
  const job=pipeline.create({evidenceIds:[record.id]}),running=pipeline.run(job.id);await entered;
  if(proposal)reviews.confirm(f.id,proposal.id,{action:'accept',selected:[proposal.suggestions[0].id]});
  else reviews.nameSpeakers(f.id,{artifactId,names:{SPEAKER_0:'Generated Carol'}});
  finish();
  const done=await running;assert.equal(done.status,'failed');assert.equal(done.batches[0].status,'invalidated');
  assert.equal(memories.list({includeStale:true}).length,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_checkpoints').get()!.n,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_extraction_drafts').get()!.n,0);
  assert.throws(()=>pipeline.create({evidenceIds:[record.id]}));
 }finally{finish();await pipeline.close();await organizers.close();}
});

test('repeated text corrections retain simultaneous segment order and remove only obsolete word alignment',async t=>{
 let original='扣迪斯',replacement='Cordis';
 const transcript:Transcript={durationMs:3000,segments:[raw.segments[0],{startMs:0,endMs:1000,text:'尚未完成。',words:[{startMs:0,endMs:1000,text:'尚未完成。'}]}]};
 const f=await fixture(t,{settings:{audioProcessor:'audio.http',summarize:false},transcribe:async()=>transcript,analyze:async(records:any[])=>{const chunk=JSON.parse(records[0].ocrText);return {answer:JSON.stringify({suggestions:[{chunkId:chunk.chunkId,original,replacement,reason:'Generated correction'}]}),citations:[{id:chunk.chunkId}]};}});
 await f.processing.tick();const reviews=new FileReviews(f.files,f.processing),initial=f.files.chunks(f.id),initialArtifact=initial[0].fileEvidence!.artifactId;
 const before=f.processing.artifact(initialArtifact).transcript as Transcript;assert.ok(before.segments[0].words?.length);assert.ok(before.segments[1].words?.length);
 for(const word of ['Cordis','Mote']){
  replacement=word;const proposal=await reviews.propose(f.id,{kind:'terms'});reviews.confirm(f.id,proposal.id,{action:'accept',selected:[proposal.suggestions[0].id]});
  const chunks=f.files.chunks(f.id),after=f.processing.artifact(chunks[0].fileEvidence!.artifactId).transcript as Transcript;
  assert.deepEqual(chunks.map(c=>c.ocrText.replace(/^\[SPEAKER_\w+\] /,'')),after.segments.map(s=>s.text));
  assert.equal(chunks[1].id,initial[1].id);assert.ok(chunks[0].ocrText.includes(word));
  assert.equal(after.segments[0].words,undefined);assert.deepEqual(after.segments[1].words,before.segments[1].words);
  original=word;
 }
 assert.equal(f.processing.artifact(initialArtifact).transcript.segments[0].text,before.segments[0].text);
});

test('document text correction retains original locations without inventing audio times or replacing unchanged formal blocks',async t=>{
 const f=await fixture(t,{file:{name:'generated.txt',mimeType:'text/plain',bytes:Buffer.from('Wrong '+ 'generated '.repeat(1800))},settings:{summarize:false},
  analyze:async(records:any[])=>{const chunk=JSON.parse(records[0].ocrText);return {answer:JSON.stringify({suggestions:[{chunkId:chunk.chunkId,original:'Wrong',replacement:'Right',reason:'Generated correction'}]}),citations:[{id:chunk.chunkId}]};}});
 await f.processing.tick();const before=f.files.chunks(f.id);assert.ok(before.length>1);
 const materials=new MaterialStore(f.store),organizers=new MaterialOrganizerRuntime(f.store,materials);
 try{
  while(await organizers.tick(100));const material=materials.get(materialId('phone','generated.txt'))!;
  const anchors=materials.evidence(materials.evidenceIds(material.ref)),stable=anchors.find(r=>r.ocrText===before.at(-1)!.ocrText)!;assert.ok(stable);
  assert.equal(stable.provenance?.document?.contentRole,'other');
  const reviews=new FileReviews(f.files,f.processing),proposal=await reviews.propose(f.id,{kind:'terms'});
  reviews.confirm(f.id,proposal.id,{action:'accept',selected:[proposal.suggestions[0].id]});
  const after=f.files.chunks(f.id);assert.equal(after.length,before.length);assert.equal(after.at(-1)!.id,before.at(-1)!.id);
  assert.deepEqual(after.map(r=>r.fileEvidence!.documentLocation),before.map(r=>r.fileEvidence!.documentLocation));
  assert.ok(after.every(r=>r.fileEvidence!.startMs===undefined&&r.fileEvidence!.endMs===undefined));
  while(await organizers.tick(100));assert.equal(materials.isCurrentEvidence(stable.id),true);
  assert.equal(materials.evidence([stable.id])[0]?.provenance?.document?.contentRole,'other','corrected document text is not an audio transcript');
  assert.ok(materials.evidenceIds(material.id).includes(stable.id));assert.match(materials.read(material.id).text,/Right/);
 }finally{await organizers.close();}
});

for(const change of ['geometry','text'] as const)test(`image ${change} changes preserve unrelated evidence and carry original-pixel locations through file and Material reads`,async t=>{
 const location=(x:number,y:number)=>({width:128,height:600,polygon:[[x,y],[x+30,y],[x+30,y+12],[x,y+12]] as [number,number][]});
 const transcript:Transcript={durationMs:0,segments:[{startMs:0,endMs:0,text:'Same words',imageLocation:location(8,40)},{startMs:0,endMs:0,text:'Same words',imageLocation:location(75,300)}]};
 const bytes=await sharp({create:{width:128,height:600,channels:3,background:'#ffffff'}}).png().toBuffer();
 const f=await fixture(t,{file:{name:'generated.png',mimeType:'image/png',bytes},settings:{imageProcessor:'image.http',imageEndpoint:'http://127.0.0.1:9008/ocr',summarize:false},
  analyze:async(records:any[])=>{const chunk=JSON.parse(records[0].ocrText);return {answer:JSON.stringify({suggestions:[{chunkId:chunk.chunkId,original:'Same words',replacement:'Corrected first line',reason:'Generated correction'}]}),citations:[{id:chunk.chunkId}]};}});
 let calls=0;f.processing.runtime.registry.get('image.http').process=async()=>{calls++;return structuredClone(transcript);};
 await f.processing.tick();assert.equal(calls,1);const before=f.files.chunks(f.id);
 assert.equal(before.length,2);assert.notEqual(before[0].id,before[1].id,'repeated words in different regions remain distinct evidence');
 assert.deepEqual(before.map(r=>r.fileEvidence!.imageLocation),transcript.segments.map(s=>s.imageLocation));
 assert.ok(before.every(r=>r.fileEvidence!.startMs===undefined&&r.fileEvidence!.speaker===undefined));
 const materials=new MaterialStore(f.store),work=new MaterialMemoryWork(f.store,materials),organizers=new MaterialOrganizerRuntime(f.store,materials,[],undefined,work);
 try{
  while(await organizers.tick(100));const first=materials.get(materialId('phone','generated.png'))!;
  const anchors=materials.evidence(materials.evidenceIds(first.ref)).filter(r=>JSON.parse(r.ocrText).imageLocation);
  assert.equal(anchors.length,2);assert.deepEqual(anchors.map(r=>JSON.parse(r.ocrText).imageLocation),transcript.segments.map(s=>s.imageLocation));
  assert.deepEqual(materials.block(first.ref,1)!.block.locator!.imageLocation,transcript.segments[0].imageLocation);
  const view=sourceMaterialView(materials,first.id,{revision:first.revision});
  assert.deepEqual(view.items.filter(i=>i.type==='text').map(i=>i.text),['Same words','Same words']);
  assert.ok(view.items.every(i=>!i.speaker&&!i.confirmedName&&i.startMs===undefined));
  const memories=new MemoryStore(f.store,ids=>materials.evidence(ids),id=>materials.isCurrentEvidence(id));
  const saved=anchors.map(r=>memories.publish(memories.extract({answer:JSON.stringify({memories:[{title:'Generated image fixture',statement:`Generated text [${r.id}]`,uncertainty:'Fixture',evidenceIds:[r.id],evidence:[{id:r.id,quote:r.ocrText}]}]}),citations:[{id:r.id,capturedAt:r.capturedAt,appName:r.appName,excerpt:r.ocrText}],trace:[],runId:'generated-image'},'fixture').items[0].id));
  if(change==='geometry'){transcript.segments[0].imageLocation=location(12,45);f.processing.retry(f.id);await f.processing.tick();assert.equal(calls,2);}
  else {const reviews=new FileReviews(f.files,f.processing),proposal=await reviews.propose(f.id,{kind:'terms'});reviews.confirm(f.id,proposal.id,{action:'accept',selected:[proposal.suggestions[0].id]});assert.equal(calls,1);}
  const after=f.files.chunks(f.id);assert.notEqual(after[0].id,before[0].id);assert.equal(after[1].id,before[1].id);
  assert.deepEqual(after.map(r=>r.fileEvidence!.imageLocation),transcript.segments.map(s=>s.imageLocation));
  assert.equal(memories.get(saved[0].id).status,'stale');assert.equal(memories.get(saved[1].id).status,'published');
  while(await organizers.tick(100));assert.equal(materials.isCurrentEvidence(anchors[1].id),true);
  const second=materials.get(first.id)!;assert.notEqual(second.ref,first.ref);
  assert.equal(JSON.parse(materials.block(first.ref,1)!.block.text).text,'Same words','historical OCR stays readable');
  assert.deepEqual(JSON.parse(materials.block(first.ref,1)!.block.text).imageLocation,before[0].fileEvidence!.imageLocation);
  assert.deepEqual(JSON.parse(materials.block(second.ref,1)!.block.text).imageLocation,after[0].fileEvidence!.imageLocation);
 }finally{await organizers.close();}
});

test('local semantic grouping blocks without a local model and never invokes the default summarizer',async t=>{
 const f=await fixture(t,{settings:{semanticTurns:true}});await f.processing.tick();assert.equal(f.files.detail(f.id).job.state,'blocked');assert.equal(f.counts().summaries,0);assert.ok(f.files.detail(f.id).artifacts.some((a:any)=>a.kind==='dialogue'));
});

test('local settings redact all credentials and reject remote destinations',async t=>{
 const f=await fixture(t);f.processing.update({revision:f.processing.view().revision,settings:{...f.processing.view().settings,apiKey:'cloud-test-secret',localModelApiKey:'local-test-secret',localWorkerApiKey:'worker-test-secret'}});assert.ok(!JSON.stringify(f.processing.view()).includes('test-secret'));
 for(const field of ['localEndpoint','localModelEndpoint'])assert.throws(()=>fileProcessingSchema.parse({[field]:'https://example.test/api',allowRemote:true}));
 assert.throws(()=>f.processing.update({revision:f.processing.view().revision,settings:{...f.processing.view().settings,localEndpoint:'http://127.0.0.1:12345/transcribe'}}),{statusCode:409});
});

test('Cordis rejects duplicate registrations and missing deployment modules',async()=>{
 const runtime=new FileProcessorRuntime();await runtime.ready;assert.throws(()=>runtime.registry.register(runtime.registry.get('text.utf8')));await runtime.close();
 const missing=new FileProcessorRuntime(undefined,[],['/no-such-generated-mote-plugin.mjs']);await assert.rejects(missing.ready);await missing.close();
});

test('calendar association is model-proposed, requires evidence from both sides, and rejects a superseded event',async t=>{
 let eventId='';const f=await fixture(t,{analyze:async(records:any[])=>({answer:JSON.stringify({calendarId:eventId,confidence:'medium',reason:'合成录音时间与候选一致，尚需确认',alternatives:[]}),citations:[{id:records[0].id},{id:eventId}]})});
 f.sources.register({id:'calendar',name:'Synthetic schedule',kind:'custom',deviceId:'phone',platform:'import',retention:'snapshot'});
 const now=new Date().toISOString(),event={externalId:'interview',revision:'1',observedAt:now,title:'Synthetic session',kind:'calendar',layer:'snapshot',text:'Synthetic planned session',calendar:{start:now,end:new Date(Date.now()+3600000).toISOString(),allDay:false,timeZone:'UTC',status:'confirmed'}};
 eventId=(await f.sources.upsert('calendar',event)).id;await f.processing.tick();const reviews=new FileReviews(f.files,f.processing),proposal=await reviews.propose(f.id,{kind:'calendar'});assert.equal(f.files.detail(f.id).artifacts.some((a:any)=>a.kind==='calendar-link'),false);
 reviews.confirm(f.id,proposal.id,{action:'accept'});assert.ok(fileExportEntries(f.files,f.id).some(e=>e.name==='已确认场次.json'));
 const second=await reviews.propose(f.id,{kind:'calendar'});await f.sources.upsert('calendar',{...event,revision:'2',observedAt:new Date(Date.now()+1000).toISOString(),title:'Changed session'});assert.throws(()=>reviews.confirm(f.id,second.id,{action:'accept'}),{statusCode:409});
});

test('changing defaults cannot send completed local-only transcripts into a cloud summary',async t=>{
 const f=await fixture(t);await f.processing.tick();f.processing.update({revision:f.processing.view().revision,settings:{...f.processing.view().settings,audioProcessor:'audio.http',summarize:true}});await f.processing.tick();assert.equal(f.counts().summaries,0);assert.equal(f.files.detail(f.id).job.local_only,1);
});


test('file diagnostics trace retries and checkpoint reuse without original content or provider errors',async t=>{
 const f=await fixture(t,{failFirst:true});await f.processing.tick();
 f.store.db.prepare("UPDATE execution_steps SET available_at=0 WHERE kind='files.pipeline'").run();f.store.db.prepare('UPDATE file_jobs SET available_at=0').run();await f.processing.tick();
 const events=f.diagnostics.events().items;
 assert.ok(events.some(e=>e.event==='file.step.started'&&e.operation==='extract'&&e.level==='debug'));
 assert.ok(events.some(e=>e.event==='file.step.failed'&&e.operation==='diarize'&&e.level==='error'));
 assert.ok(events.some(e=>e.event==='file.failed'&&e.attempt===1&&e.retryAfterMs===30000));
 assert.ok(events.some(e=>e.event==='file.cached'&&e.operation==='extract'));
 assert.ok(events.some(e=>e.event==='file.completed'&&e.attempt===2));
 assert.ok(events.some(e=>e.event==='file.blocked'&&e.category==='local_only'));
 assert.ok(events.filter(e=>e.operation==='extract').every(e=>e.jobId===f.id&&e.requestId));
 const serialized=JSON.stringify(events);for(const privateText of ['Synthetic interview','generated failure','使用扣迪斯','fixture.diarize'])assert.ok(!serialized.includes(privateText));
});


test('shared engine shutdown fences an uncooperative file provider and resumes the durable program',async t=>{
 let begin!:()=>void,release!:(v:Transcript)=>void,calls=0;const started=new Promise<void>(r=>begin=r);
 const f=await fixture(t,{transcribe:()=>{if(++calls===1){begin();return new Promise<Transcript>(r=>release=r);}return raw;}});
 await f.processing.close();const engine=new ExecutionEngine(f.store),processing=f.createProcessing(engine);await processing.runtime.ready;
 const ids=processing.prepare(),run=engine.drain(ids);await started;
 await engine.close();await run;await processing.close();
 assert.equal(engine.get(ids[0])!.state,'waiting');assert.equal(f.files.detail(f.id).artifacts.length,0);
 const resumed=f.createProcessing();await resumed.tick();assert.equal(f.files.detail(f.id).job.state,'succeeded');
 release({...raw,segments:[{startMs:0,endMs:1000,text:'Late synthetic result must not replace committed output'}]});await new Promise(r=>setImmediate(r));
 assert.equal(calls,2);assert.equal(f.files.detail(f.id).artifacts.filter((a:any)=>a.kind==='transcript').length,1);assert.ok(!JSON.stringify(f.files.chunks(f.id)).includes('Late synthetic'));
 const steps=resumed.engine.list({operationId:'file:'+f.id,limit:100}).items;assert.equal(steps.find(s=>s.kind==='files.pipeline')!.state,'succeeded');assert.equal(steps.filter(s=>s.kind.startsWith('file-step.')).length,3);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM file_usage').get()!.n,0);
});

test('old daily usage does not limit new audio processing',async t=>{
 const f=await fixture(t),day=new Date().toISOString().slice(0,10);
 f.store.db.prepare('INSERT INTO file_usage VALUES(?,?)').run(day,24*60*60000);
 await f.processing.tick();assert.equal(f.files.detail(f.id).job.state,'succeeded');assert.equal(f.counts().asrCalls,1);
});
test('configurable per-file audio limit rejects incomplete long results',async t=>{
 const f=await fixture(t,{settings:{maxAudioMinutes:1},transcribe:()=>({...raw,durationMs:61000})});
 await f.processing.tick();assert.equal(f.files.detail(f.id).job.state,'failed');assert.equal(f.files.detail(f.id).job.error,'processing_limit');assert.equal(f.counts().asrCalls,1);assert.equal(f.counts().diaryCalls,0);
});


test('manual correction uses exact stored text, is idempotent and rejects stale or foreign segments without model calls',async t=>{
 let modelCalls=0;
 const f=await fixture(t,{settings:{summarize:false},analyze:async()=>{modelCalls++;throw Error('No model allowed');}});await f.processing.tick();
 const reviews=new FileReviews(f.files,f.processing),before=f.files.chunks(f.id),artifactId=before[0].fileEvidence!.artifactId;
 const originalText=String(f.store.db.prepare('SELECT text FROM file_chunks WHERE id=?').get(before[0].id)!.text),input={artifactId,chunkId:before[0].id,originalText,correctedText:originalText};
 const artifact=f.processing.artifact(artifactId),count=()=>f.store.db.prepare('SELECT COUNT(*) n FROM file_artifacts').get()!.n;
 const initialCount=count();assert.equal(reviews.correct(f.id,input).status,'unchanged');assert.equal(count(),initialCount);
 assert.throws(()=>reviews.correct(f.id,{...input,chunkId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}),{statusCode:409});
 assert.throws(()=>reviews.correct(f.id,{...input,originalText:originalText+' '}),{statusCode:409});
 reviews.correct(f.id,{...input,correctedText:'[SPEAKER_0] Generated owner correction'});
 assert.throws(()=>reviews.correct(f.id,{...input,correctedText:'Late correction'}),{statusCode:409});
 const after=f.files.chunks(f.id),next=f.processing.artifact(after[0].fileEvidence!.artifactId);
 assert.equal(after[1].id,before[1].id);assert.notEqual(after[0].id,before[0].id);
 assert.equal(next.transcript.segments[0].text,'[SPEAKER_0] Generated owner correction');assert.equal(next.transcript.segments[0].words,undefined);
 assert.deepEqual(f.processing.artifact(artifactId),artifact);assert.equal(modelCalls,0);assert.equal(f.counts().summaries,0);
 assert.deepEqual(Buffer.concat([...f.files.bytes(f.id)]),wave);
});

test('manual correction route rejects device credentials and validates owner segment identity',async t=>{
 const f=await fixture(t,{settings:{summarize:false}});await f.processing.tick();
 const {default:Fastify}=await import('fastify'),{registerFileRoutes}=await import('../src/file-routes.js');
 const app=Fastify();t.after(()=>app.close());
 registerFileRoutes(app,f.files,f.processing,{} as any,()=>{},req=>req.headers['x-generated-device']?'generated-device':undefined,{evidence:()=>[{}]} as any);
 const before=f.files.chunks(f.id)[0],originalText=String(f.store.db.prepare('SELECT text FROM file_chunks WHERE id=?').get(before.id)!.text);
 const payload={artifactId:before.fileEvidence!.artifactId,chunkId:before.id,originalText,correctedText:'Generated manual correction'};
 const request={method:'POST' as const,url:'/api/files/'+f.id+'/corrections',payload};
 assert.equal((await app.inject({...request,headers:{'x-generated-device':'true'}})).statusCode,403);
 assert.equal((await app.inject({...request,payload:{...payload,originalText:'stale'}})).statusCode,409);
 assert.equal((await app.inject(request)).statusCode,200);
 assert.equal((await app.inject(request)).statusCode,409);
});
