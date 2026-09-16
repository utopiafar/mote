import {ServerDiagnostics} from '../src/diagnostics.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {type Plugin} from '@deepseek-ai/cordis';
import {type Transcript,diarizationSchema,transcriptSchema,fileProcessingSchema} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {FileProcessing} from '../src/file-processing.js';
import {FileProcessorRuntime} from '../src/file-processors.js';
import {alignDialogue,applySemanticGroups} from '../src/file-dialogue.js';
import {FileReviews} from '../src/file-reviews.js';
import {fileExportEntries,exportTar} from '../src/file-export.js';

const raw:Transcript={durationMs:3000,segments:[{startMs:0,endMs:1000,text:'使用扣迪斯插件。',words:[{startMs:0,endMs:300,text:'使用'},{startMs:300,endMs:700,text:'扣迪斯'},{startMs:700,endMs:1000,text:'插件。'}]},{startMs:1500,endMs:2500,text:'嗯，对，尚未完成。'}]};
const wave=Buffer.alloc(32044);wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(16000,24);wave.writeUInt32LE(32000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(32000,40);
const diary=diarizationSchema.parse({durationMs:3000,engine:'synthetic',expectedSpeakers:2,observedSpeakers:2,overlapDetection:'unknown',segments:[{startMs:0,endMs:1100,speaker:'SPEAKER_0'},{startMs:1400,endMs:2600,speaker:'SPEAKER_1'}],samples:[{speaker:'SPEAKER_0',startMs:0,endMs:1000,wavBase64:wave.toString('base64')}]});
async function fixture(t:any,options:any={}){
 const dir=mkdtempSync(join(tmpdir(),'mote-processing-')),store=new Store(dir,{dataKey:'41'.repeat(32),contentEncryptionEnabled:true}),sources=new SourceStore(store),files=new FileStore(store,sources);
 sources.register({id:'phone',name:'Synthetic phone',kind:'local-files',deviceId:'phone',platform:'android',retention:'archive'});
 const manifest={sourceId:'phone',item:{externalId:'fixture.wav',revision:'1',observedAt:new Date().toISOString(),title:'Synthetic interview.wav',kind:'file',layer:'original',text:'',mimeType:'audio/wav',deleted:false},sizeBytes:wave.length,sha256:sha256(wave)};
 const begun=files.begin(manifest,()=>{});files.part(begun.uploadId,0,wave,()=>{});const ack=await files.commit(begun.uploadId,()=>{});let asrCalls=0,diaryCalls=0,summaries=0,disposed=false;
 const plugin:Plugin={name:'fixture-diarizer',inject:['moteFileProcessors'],apply(ctx){ctx.effect(()=>{const dispose=ctx.moteFileProcessors.register({id:'fixture.diarize',name:'Synthetic diarizer',version:'1',stage:'diarize',localOnly:true,mediaTypes:['audio/'],async process(){diaryCalls++;if(options.failFirst&&diaryCalls===1)throw Error('generated failure');return diary;}});return()=>{disposed=true;dispose();};});}};
 const diagnostics=new ServerDiagnostics({directory:join(dir,'logs'),debug:true});await diagnostics.init();
 const processing=new FileProcessing(files,{transcribe:async()=>{asrCalls++;return raw;}},async()=>{summaries++;throw Error('Unexpected cloud summary');},{plugins:[plugin],analyze:options.analyze,diagnostics});
 await processing.runtime.ready;
 processing.update({revision:processing.view().revision,settings:{...processing.view().settings,enabled:true,audioProcessor:'audio.local-dialogue',diarizationProcessor:'fixture.diarize',speakerCount:2,summarize:true,...options.settings}});
 t.after(async()=>{await processing.close();await diagnostics.close();store.close();rmSync(dir,{recursive:true,force:true});});
 return {dir,store,sources,files,processing,diagnostics,id:ack.id,counts:()=>({asrCalls,diaryCalls,summaries,disposed})};
}

test('actual Cordis registration and disposal; local pipeline checkpoints resume without repeating ASR',async t=>{
 const f=await fixture(t,{failFirst:true});await f.processing.tick();assert.equal(f.files.detail(f.id).job.state,'failed');assert.equal(f.files.detail(f.id).artifacts.filter((a:any)=>a.kind==='transcript').length,1);
 // Simulate restart, leaving its persisted checkpoint in place.
 f.store.db.prepare('UPDATE file_jobs SET available_at=0').run();await f.processing.tick();assert.equal(f.files.detail(f.id).job.state,'succeeded');assert.deepEqual(f.counts(),{asrCalls:1,diaryCalls:2,summaries:0,disposed:false});
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
 const suggestion=proposal.suggestions[0];reviews.confirm(f.id,proposal.id,{action:'accept',selected:[suggestion.id]});assert.match(f.files.chunks(f.id)[0].ocrText,/Cordis/);assert.throws(()=>reviews.confirm(f.id,other.id,{action:'accept',selected:[other.suggestions[0].id]}),{statusCode:409});
 const entries=fileExportEntries(f.files,f.id);assert.match(entries.find(e=>e.name==='原始转写_未校正.md')!.bytes.toString(),/扣迪斯/);assert.match(entries.find(e=>e.name==='带说话人_已确认校正记录.md')!.bytes.toString(),/Cordis/);
 f.processing.retry(f.id,'diarize');await f.processing.tick();assert.match(f.files.chunks(f.id)[0].ocrText,/扣迪斯/);
});

test('a model cannot inject corrections outside cited chunks or guess a speaker name',async t=>{
 const f=await fixture(t,{analyze:async(records:any[])=>({answer:JSON.stringify({suggestions:[{chunkId:records[0].id,original:'not in evidence',replacement:'rewrite',reason:'bad'}]}),citations:[{id:records[0].id}]})});await f.processing.tick();const reviews=new FileReviews(f.files,f.processing);
 await assert.rejects(reviews.propose(f.id,{kind:'terms'}),{statusCode:502});assert.equal(reviews.list(f.id).items.length,0);
 const artifact=f.files.detail(f.id).artifacts.find((a:any)=>a.kind==='dialogue')!;assert.throws(()=>reviews.nameSpeakers(f.id,{artifactId:artifact.id,names:{SPEAKER_9:'Unknown'}}));reviews.nameSpeakers(f.id,{artifactId:artifact.id,names:{SPEAKER_0:'用户确认名'}});assert.ok(fileExportEntries(f.files,f.id).some(e=>e.name==='已确认说话人.json'));
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
 f.store.db.prepare('UPDATE file_jobs SET available_at=0').run();await f.processing.tick();
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
