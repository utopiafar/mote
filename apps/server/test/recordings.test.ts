import {authorizeFixtureModels,fixtureTopicResult} from './fixtures/model-authorization.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import type {Config} from '../src/config.js';
import type {RecordingProvider} from '../src/connectors/recordings.js';
import {ExecutionFailure} from '../src/execution-engine.js';
import {feishuTranscript} from '../src/connectors/recording-formats.js';
import {createFeishuRecordings} from '../src/connectors/lark-recordings.js';
import {dingtalkTranscript,dwsArguments,createDingtalkRecordings} from '../src/connectors/dingtalk-recordings.js';
import {recordingFile} from '../src/connectors/recording-staging.js';
import type {QueryInput} from '@mote/agent';
import {ProviderFailure} from '@mote/shared';
import {planGeneratedMemory,generatedMemoryOutput} from './fixtures/memory-planning.js';
import {recordingMemoryRecipe} from '../src/connectors/recording-memory.js';
import {ConnectorError} from '../src/connectors/types.js';
import {createLarkRunner} from '../src/connectors/lark-cli.js';
const raw='Generated diary export\n\nOwner 00:00:00.000\nI felt proud of finishing a generated prototype.\n\nOwner 00:00:02.500\nI prefer quiet mornings for focused work.\n';
const selection={enabled:true,start:'2026-09-01T00:00:00Z',end:'2026-10-01T00:00:00Z',autoSync:false,backupAudio:true};
const wav=Buffer.concat([Buffer.from('RIFF0000WAVE'),Buffer.alloc(200)]);
async function fixture(t:import('node:test').TestContext,createProvider?:(directory:string)=>RecordingProvider){
 const directory=await mkdtemp(join(tmpdir(),'mote-recording-fixture-'));
 const state={account:'generated-owner',text:raw,ids:['r1','r1'],mediaFails:false,transcriptFails:false,pages:false,cycle:false,held:undefined as undefined|Promise<void>,switchAfterRead:false,modelFailurePhase:'extract' as 'extract'|'review',modelFailures:0,modelEntered:undefined as undefined|(()=>void),modelHeld:undefined as undefined|Promise<void>};
 const calls:{phase:string;id?:string;start?:string;end?:string}[]=[],models:QueryInput[]=[];
 const provider:RecordingProvider={id:'feishu',version:'generated@1',account:async()=>({id:state.account,name:'Generated owner'}),
  discover:async(_account,range)=>{calls.push({phase:'discover',...range});return {ids:range.cursor?['r2']:state.ids,...(state.cycle?{next:range.cursor==='a'?'b':'a'}:state.pages&&!range.cursor?{next:'second'}:{})};},
  metadata:async(_account,id)=>{calls.push({phase:'metadata',id});return {id,title:'Generated diary',recordedAt:'2026-09-20T00:00:00Z',durationMs:5000};},
  transcript:async()=>{calls.push({phase:'transcript'});if(state.held)await state.held;if(state.transcriptFails)throw new ExecutionFailure('blocked','generated_transcript_unavailable');if(state.switchAfterRead)state.account='another-generated-owner';return {rawText:state.text,transcript:feishuTranscript(state.text,5000)};},
  media:async()=>{calls.push({phase:'media'});if(state.mediaFails)throw new ExecutionFailure('blocked','generated_media_permission');return {mimeType:'audio/wav',bytes:wav};},
 };
 const activeProvider=createProvider?.(directory)??provider;
 const config:Config={dataDir:directory,token:'generated-recording-owner-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:true};
 let node:Awaited<ReturnType<typeof buildApp>>;
 const deps={backgroundWorker:false,connectorTesting:{recordings:[activeProvider]},agent:{configured:true,close:async()=>{},query:async(input:QueryInput)=>{
  const topic=fixtureTopicResult(input);if(topic)return topic;
  if(await planGeneratedMemory(input))return {answer:'Generated packages submitted.',citations:[],trace:[],runId:randomUUID()};
  models.push(input);if(input.traceContext?.phase===state.modelFailurePhase){state.modelEntered?.();if(state.modelHeld)await state.modelHeld;if(state.modelFailures>0){state.modelFailures--;throw new ProviderFailure({category:'transient',code:'provider_network',retryAfterMs:0});}}const evidence=node.memories.readEvidence(input.evidenceIds!)[0],id=evidence.id;
  return {answer:generatedMemoryOutput(input,[{domain:'personal',title:'Generated pride',statement:`Felt proud of a generated prototype [${id}]`,uncertainty:'Generated evidence only; speaker label unverified.',admission:{layer:'memory',reason:'Generated personal experience',scope:'Generated diary',attribution:'user'},evidenceIds:[id],evidence:[{id,quote:evidence.ocrText.trim()}]}]),citations:[{id,capturedAt:evidence.capturedAt,appName:evidence.appName,excerpt:''}],trace:[],runId:randomUUID()};
 }}};
 node=await buildApp(config,deps);await node.app.ready();await authorizeFixtureModels(node);
 const request=async(method:'GET'|'POST'|'PUT'|'DELETE',suffix='',payload?:unknown)=>{const res=await node.app.inject({method,url:'/api/connectors/'+activeProvider.id+'-recordings'+suffix,headers:{authorization:'Bearer '+config.token},...(payload?{payload}:{})});assert.equal(res.statusCode,200,res.body);return res.json();};
 const flush=async()=>{for(let n=0;n<30;n++){const steps=node.store.db.prepare("SELECT id FROM execution_steps WHERE kind LIKE ? AND state IN ('waiting','running') AND available_at<=? LIMIT 100").all('recording.'+activeProvider.id+'.%',Date.now()) as {id:string}[];if(!steps.length)break;await node.executor.drain(steps.map(s=>s.id));}await node.materialOrganizer.tick(100);await node.sourcePipelines.tick(100);};
 t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
 return {get node(){return node;},config,directory,state,calls,models,request,flush,async connect(){await request('POST','/connect');return request('PUT','/selection',selection);},async restart(){await node.app.close();node=await buildApp(config,deps);await node.app.ready();},async memory(){await node.sourcePipelines.drainMemory(node.memoryPipeline,true,100);await Promise.all(node.memoryPipeline.list().filter(j=>['queued','running'].includes(j.status)).map(j=>node.memoryPipeline.run(j.id)));}};
}

test('media backup survives missing transcripts and restart; later transcript attaches the existing original without downloading again',async t=>{
 const f=await fixture(t);f.state.transcriptFails=true;await f.connect();await f.flush();
 let status=await f.request('GET');assert.equal(status.counts.transcripts,0);assert.equal(status.counts.audio,1);assert.equal(status.counts.failed,1);
 const media=f.node.store.db.prepare('SELECT file_id FROM recording_media').get()!;assert.deepEqual(new ArchivedFileStore(f.node.store).read(String(media.file_id)),wav);
 await f.restart();f.state.transcriptFails=false;await f.request('POST','/retry');await f.flush();status=await f.request('GET');
 assert.equal(status.counts.transcripts,1);assert.equal(status.counts.audio,1);assert.equal(f.calls.filter(call=>call.phase==='media').length,1);
 const item=(await f.request('GET','/items')).items[0];assert.equal(item.audio.id,String(media.file_id));assert.ok(new ArchivedFileStore(f.node.store).listForCapture(item.captureId).some(file=>file.id===String(media.file_id)));
});
test('a running transcript does not hold the media resource',async t=>{
 const f=await fixture(t);let release!:()=>void;f.state.held=new Promise<void>(resolve=>release=resolve);await f.connect();
 try{
  for(let n=0;n<200;n++){await f.node.executor.tick();const status=await f.request('GET');if(status.counts.audio===1)break;await new Promise(resolve=>setTimeout(resolve,5));}
  const status=await f.request('GET');assert.equal(status.counts.transcripts,0);assert.equal(status.counts.audio,1);assert.ok(status.steps.some((step:any)=>step.phase==='transcript'&&step.state==='running'));
 }finally{release();}
 await f.flush();
});

test('metadata rate limits wait across restart, recover without owner retry and exhaust the existing finite budget',async t=>{
 let remaining=1,metadataCalls=0;
 const f=await fixture(t,()=>({id:'feishu',version:'generated-rate-limit@1',account:async()=>({id:'generated-owner'}),
  discover:async()=>({ids:['r1']}),
  metadata:async()=>{metadataCalls++;if(remaining-->0)throw new ConnectorError('lark_rate_limited',502);return {id:'r1',title:'Generated diary',recordedAt:'2026-09-20T00:00:00Z',durationMs:5000};},
  transcript:async()=>({rawText:raw,transcript:feishuTranscript(raw,5000)}),media:async()=>({mimeType:'audio/wav',bytes:wav}),
 }));
 const before=Date.now();await f.request('POST','/connect');await f.request('PUT','/selection',{...selection,start:'2026-09-10T00:00:00Z'});await f.flush();
 const row=()=>f.node.store.db.prepare("SELECT id,operation_id,state,attempts,error,available_at FROM execution_steps WHERE kind='recording.feishu.metadata' ORDER BY rowid DESC LIMIT 1").get()!;
 const waiting=row();assert.equal(waiting.state,'waiting');assert.equal(waiting.error,'recording_rate_limited');assert.equal(waiting.attempts,1);assert.ok(Number(waiting.available_at)>=before+60000);assert.equal((await f.request('GET')).counts.failed,0);
 await f.restart();await f.flush();assert.equal(row().available_at,waiting.available_at);assert.equal(row().attempts,1);assert.equal(metadataCalls,1,'restart respects the retained delay');
 // Advance only this generated receipt's eligibility after verifying the durable delay.
 f.node.store.db.prepare('UPDATE execution_steps SET available_at=0 WHERE id=?').run(waiting.id);await f.flush();
 assert.equal(row().state,'succeeded');assert.equal(row().attempts,2);assert.equal((await f.request('GET')).counts.transcripts,1);assert.equal((await f.request('GET')).counts.audio,1);assert.equal(f.models.length,0);
 const completed=await f.node.app.inject({method:'GET',url:'/api/operations/'+waiting.operation_id,headers:{authorization:'Bearer '+f.config.token}});assert.equal(completed.statusCode,200);assert.equal(completed.json().operation.state,'succeeded');
 remaining=10;await f.request('POST','/sync');await f.flush();const repeated=row();assert.equal(repeated.state,'waiting');assert.equal(repeated.attempts,1);
 for(let attempt=2;attempt<=3;attempt++){f.node.store.db.prepare('UPDATE execution_steps SET available_at=0 WHERE id=?').run(repeated.id);await f.flush();assert.equal(row().attempts,attempt);assert.equal(row().state,attempt===3?'failed':'waiting');assert.equal(row().error,'recording_rate_limited');}
 const calls=metadataCalls;await f.flush();assert.equal(metadataCalls,calls,'exhausted acquisition does not retry forever');assert.equal((await f.request('GET')).counts.failed,1);assert.equal((await f.request('GET')).counts.transcripts,1);assert.equal((await f.request('GET')).counts.audio,1);
});

test('recording intake produces complete material and Memory, bypasses ASR, preserves vendor deletion and deduplicates repeated history',async t=>{
 const f=await fixture(t);await f.connect();await f.flush();let status=await f.request('GET');assert.equal(status.counts.transcripts,1);assert.equal(status.counts.audio,1);assert.equal(status.counts.pending,0);
 const source=f.node.sources.getSource(status.sourceId),head=f.node.sources.getItem(source.id,'r1')!;
 assert.equal(head.document?.recordedAt,'2026-09-20T00:00:00Z');assert.notEqual(head.observedAt,head.document?.recordedAt);
 const material=f.node.materials.list({sourceId:source.id}).items[0];assert.equal(material.coverage.state,'complete');assert.equal(f.node.materials.input(material.ref,['extracted-text'])?.ready,true);
 assert.equal(f.node.store.db.prepare('SELECT state FROM file_jobs WHERE capture_id=?').get(head.captureId)?.state,'succeeded');
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE kind LIKE 'file.process%'").get()!.n,0);
 await f.memory();assert.ok(f.models.length>0);const jobs=f.node.memoryPipeline.list().map(j=>f.node.memoryPipeline.get(j.id));assert.ok(jobs.every(j=>j.status==='completed'));assert.ok(jobs.flatMap(j=>j.memoryIds).length>0);
 const modelCount=f.models.length,mediaCount=f.calls.filter(c=>c.phase==='media').length;
 await f.request('POST','/sync');await f.flush();await f.memory();assert.equal(f.node.sources.history(source.id,'r1').length,1);assert.equal(f.models.length,modelCount);assert.equal(f.calls.filter(c=>c.phase==='media').length,mediaCount);
 f.state.ids=[];await f.request('POST','/sync');await f.flush();assert.equal(f.node.sources.getItem(source.id,'r1')!.deleted,false);
 const audio=new ArchivedFileStore(f.node.store).listForCapture(head.captureId)[0];
 assert.equal(new ArchivedFileStore(f.node.store).read(audio.id).equals(wav),true);
 const playable=await f.node.app.inject({method:'GET',url:`/api/archived-files/${audio.id}/content`,headers:{authorization:'Bearer '+f.config.token}});assert.equal(playable.statusCode,200);assert.equal(playable.rawPayload.equals(wav),true);
 const denied=await f.node.app.inject({method:'GET',url:`/api/archived-files/${audio.id}/content`});assert.equal(denied.statusCode,401);
 await f.restart();await f.flush();await f.memory();assert.equal(f.models.length,modelCount);assert.equal((await f.request('GET')).counts.transcripts,1);
 const forbidden=await f.node.app.inject({method:'POST',url:'/api/connectors/feishu-recordings/sync'});assert.equal(forbidden.statusCode,401);
 await f.request('DELETE');assert.equal((await f.request('GET')).connected,false);assert.equal(f.node.sources.getSource(source.id).enabled,false);assert.equal(f.node.sources.history(source.id,'r1').length,1);
});

test('recording v3 carries scoped owner prose and full-range selection through formal intake and independent review',async t=>{
 const f=await fixture(t);await f.connect();const status=await f.request('GET'),sourceId=status.sourceId;
 const description='Generated recordings are my spoken diary; quoted people and navigation announcements are not my own experiences.';
 const updated=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+sourceId+'/context',headers:{authorization:'Bearer '+f.config.token},payload:{expectedVersion:0,description}});assert.equal(updated.statusCode,200,updated.body);
 assert.equal(f.node.memoryStrategies.resolve({id:'mote.recording-memory',version:'1'}).binding.extract.version,'1');assert.equal(f.node.memoryStrategies.resolve({id:'mote.recording-memory',version:'2'}).binding.extract.version,'2');assert.equal(recordingMemoryRecipe.version,'3');assert.equal(f.node.memoryStrategies.resolve(recordingMemoryRecipe).binding.workContract,'range-evaluation@1');
 await f.flush();await f.memory();const jobs=f.node.memoryPipeline.list().map(j=>f.node.memoryPipeline.get(j.id));
 assert.ok(jobs.length>0);assert.ok(jobs.every(j=>j.status==='completed'&&j.recipes?.every(r=>r.id===recordingMemoryRecipe.id&&r.version==='3')));
 assert.ok(f.models.some(input=>input.taskContext?.untrustedMemoryDraft),'independent reviewer sees the actual recording work');
 for(const input of f.models){
  const members=(input.taskContext?.memoryWork as {members:{attributionContext?:{ownerRelation:string;basis:string;sourceContextStatements?:{description:string}[]}}[]})?.members;assert.ok(members?.length);
  for(const member of members){assert.equal(member.attributionContext?.ownerRelation,'unknown');assert.equal(member.attributionContext?.basis,'default');assert.equal(member.attributionContext?.sourceContextStatements?.[0].description,description);}
  assert.match(input.question,/sourceContextStatements/);assert.match(input.question,/not a veto/);assert.match(input.question,/background\/navigation/);assert.match(input.question,/source creation\/start timestamp/);assert.equal((input.taskContext?.memoryWork as {workContract?:string})?.workContract,'range-evaluation@1');assert.doesNotMatch(input.question,/propose at most 8/);
 }
 const recipe3=f.node.memoryStrategies.resolve(recordingMemoryRecipe).binding,recipe1=f.node.memoryStrategies.resolve({id:recordingMemoryRecipe.id,version:'1'}).binding,recipe2=f.node.memoryStrategies.resolve({id:recordingMemoryRecipe.id,version:'2'}).binding;
 await f.restart();assert.deepEqual(f.node.memoryStrategies.resolve(recordingMemoryRecipe).binding,recipe3);assert.deepEqual(f.node.memoryStrategies.resolve({id:recordingMemoryRecipe.id,version:'1'}).binding,recipe1);assert.deepEqual(f.node.memoryStrategies.resolve({id:recordingMemoryRecipe.id,version:'2'}).binding,recipe2);
 assert.equal((await f.request('GET')).selection.autoSync,false);
});

test('independent audio failure does not block Memory; retry attaches audio without paid replay and revisions retain prior archive',async t=>{
 const f=await fixture(t);f.state.mediaFails=true;await f.connect();await f.flush();const status=await f.request('GET');assert.equal(status.counts.transcripts,1);assert.equal(status.counts.audio,0);assert.equal(status.counts.failed,1);
 await f.memory();const models=f.models.length;assert.ok(models>0);await f.request('POST','/sync');await f.flush();await f.memory();assert.equal((await f.request('GET')).counts.failed,1,'A new discovery round reuses the failed media receipt');assert.equal(f.calls.filter(c=>c.phase==='media').length,1);assert.equal(f.models.length,models);
 await f.restart();assert.equal((await f.request('GET')).counts.failed,1);f.state.mediaFails=false;await f.request('POST','/retry');await f.flush();await f.memory();assert.equal(f.models.length,models);assert.equal((await f.request('GET')).counts.audio,1);
 f.state.text=raw.replace('proud','happy');await f.request('POST','/sync');await f.flush();assert.equal(f.node.sources.history(status.sourceId,'r1').length,2);const heads=f.node.sources.history(status.sourceId,'r1');assert.ok(heads.every(h=>new ArchivedFileStore(f.node.store).listForCapture(h.captureId).length===1));
 await f.memory();assert.ok(f.models.length>models);
 const logs=f.node.diagnostics.recent(500);assert.ok(JSON.stringify(logs).includes('recording_transcript'));assert.ok(!JSON.stringify(logs).includes('quiet mornings'));assert.ok(!JSON.stringify(logs).includes('generated-owner'));
});

test('pagination covers all IDs, exact date bounds reject out-of-range metadata and cursor cycles are explicit failures',async t=>{
 const f=await fixture(t);f.state.pages=true;await f.connect();await f.flush();assert.equal((await f.request('GET')).counts.transcripts,2);assert.ok(f.calls.filter(c=>c.phase==='discover').every(c=>Date.parse(c.end!)-Date.parse(c.start!)<=27*86400000));
 await f.request('PUT','/selection',{...selection,start:'2026-09-25T00:00:00Z'});await f.flush();assert.equal((await f.request('GET')).counts.transcripts,2);
 f.state.pages=false;f.state.cycle=true;await f.request('PUT','/selection',selection);await f.flush();assert.ok((await f.request('GET')).steps.some((s:any)=>s.error==='recording_pagination_invalid'));
});

test('switching vendor account during a transcript read blocks publication; pausing revokes in-flight grants',async t=>{
 const f=await fixture(t);f.state.switchAfterRead=true;await f.connect();await f.flush();assert.equal((await f.request('GET')).counts.transcripts,0);assert.ok((await f.request('GET')).steps.some((s:any)=>s.error==='recording_account_changed'));
 f.state.switchAfterRead=false;let release!:()=>void;f.state.held=new Promise<void>(r=>{release=r;});const reconnected=await f.request('POST','/connect');assert.equal(reconnected.selection.enabled,false);await f.request('PUT','/selection',selection);
 for(let n=0;n<100&&!f.calls.some(c=>c.phase==='transcript'&&f.calls.filter(v=>v.phase==='transcript').length>1);n++)await new Promise(r=>setTimeout(r,5));
 await f.request('PUT','/selection',{...selection,enabled:false});release();await f.flush();assert.equal((await f.request('GET')).counts.transcripts,0);
});

test('export parsers preserve speaker/timeline, long speech, structured DingTalk paragraphs and reject incomplete data and unsafe paths',async t=>{
 const text='甲 00:00:00.040\n'+('x'.repeat(7999)+'😀').repeat(2)+'\n\n乙 00:00:02.000\nEnd\n';const parsed=feishuTranscript(text,4000)!;assert.ok(parsed.segments.length>2);assert.equal(parsed.segments[0].startMs,40);assert.equal(parsed.segments.at(-1)?.speaker,'乙');assert.ok(parsed.segments.every(s=>s.text.length<=8000));
 assert.throws(()=>feishuTranscript('not a transcript',100));assert.throws(()=>feishuTranscript('A 00:00:02.000\nText\nB 00:00:01.000\nText',4000));
 const dws=dingtalkTranscript({taskUuid:'generated',complete:true,paragraphList:[{nickName:'Unknown',paragraph:'Generated words',sentenceList:[{sentence:'Generated words'}]}]});assert.ok(dws.rawText.includes('Generated words'));assert.equal(dws.transcript!.segments[0].untimed,true);assert.equal(dws.transcript!.segments[0].text,'Generated words');assert.throws(()=>dingtalkTranscript({taskUuid:'generated',complete:false,paragraphList:[]}));
 const args=dwsArguments({kind:'search',start:selection.start,end:selection.end},'corp:user');assert.ok(args.includes('corp:user'));assert.ok(!args.includes('--query'));
 const dir=await mkdtemp(join(tmpdir(),'mote-export-contract-'));t.after(()=>rm(dir,{recursive:true,force:true}));await mkdir(join(dir,'safe'));await writeFile(join(dir,'outside'),'private fixture');await assert.rejects(recordingFile(join(dir,'safe'),'../outside',100));
});

test('vendor adapters retain source corpus dates and validate actual envelopes and controlled exports',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-feishu-format-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const provider=createFeishuRecordings(directory,async command=>{switch(command.kind){case 'status':return JSON.stringify({appId:'cli_generated',identities:{user:{available:true,openId:'generated'}}});case 'minutes-search':return JSON.stringify({ok:true,data:{items:[{token:'r1'}],has_more:false}});case 'minutes-metadata':return JSON.stringify({data:{minute:{token:'r1',title:'Generated',create_time:String(Date.parse('2026-09-20T00:00:00Z')),duration:'5000'}}});case 'minutes-transcript':return JSON.stringify({ok:true,data:{transcript:raw}});case 'minutes-media':await writeFile(resolve(directory,'lark-runtime',command.output),wav);return '{}';default:return '{}';}});
 const account=await provider.account(),signal=new AbortController().signal;assert.equal((await provider.discover(account,selection,signal)).ids[0],'r1');const metadata=await provider.metadata(account,'r1',signal);assert.equal(metadata.recordedAt,undefined);assert.ok(metadata.createdAt);assert.equal((await provider.transcript(account,metadata,signal)).transcript!.segments.length,2);assert.equal((await provider.media(account,metadata,signal)).mimeType,'audio/wav');
 const dws=createDingtalkRecordings(directory,async command=>command.kind==='status'?{authenticated:true,corp_id:'corp',user_id:'user'}:command.kind==='metadata'?{data:{taskUuid:'d1',basic:{result:{uuid:'d1',title:'Generated',startTime:Date.parse('2026-09-20T00:00:00Z'),duration:5000}}}}:command.kind==='search'?{data:{minutes:[{taskUuid:'d1'}],complete:true},meta:{pagination:{endpoint_exhausted:true}}}:{data:{taskUuid:'d1',complete:true,paragraphList:[{paragraph:'Generated'}]}});
 const da=await dws.account(),dm=await dws.metadata(da,'d1',signal);assert.equal(dm.title,'Generated');assert.equal(dm.createdAt,'2026-09-20T00:00:00.000Z');assert.equal(dm.durationMs,5000);assert.equal((await dws.discover(da,selection,signal)).ids[0],'d1');assert.ok((await dws.transcript(da,dm,signal)).transcript!.segments.length);
});

test('DingTalk primary text is lossless, retains genuine repeated paragraphs and has decoded paragraph locations',()=>{
 const speech='Generated "quote" \\ newline\n'+('x'.repeat(7999)+'😀').repeat(2),paragraph={paragraph:speech,nickName:'Unverified vendor label',paragraphId:7,sentenceList:[{sentence:speech,wordList:[{word:speech}]}]};
 const payload={taskUuid:'generated',complete:true,providerExtra:'Retain unknown original fields',paragraphList:[paragraph,{...paragraph,paragraphId:8}]};
 const result=dingtalkTranscript(payload,5000),segments=result.transcript!.segments;
 assert.deepEqual(JSON.parse(result.rawText),payload);
 assert.equal(segments.filter(s=>s.documentLocation!.rowNumber===1).map(s=>s.text).join(''),speech);
 assert.equal(segments.filter(s=>s.documentLocation!.rowNumber===2).map(s=>s.text).join(''),speech,'identical speech in another paragraph is a real retained occurrence');
 for(const row of [1,2]){let offset=0;for(const segment of segments.filter(s=>s.documentLocation!.rowNumber===row)){assert.equal(segment.documentLocation!.offset,offset);assert.equal(segment.documentLocation!.length,segment.text.length);assert.equal(speech.slice(offset,offset+segment.text.length),segment.text);assert.ok(segment.text.length<=8000);assert.equal(segment.speaker,'Unverified vendor label');assert.equal(segment.untimed,true);offset+=segment.text.length;}}
 assert.equal(result.transcript!.durationMs,5000);assert.equal(result.transcript!.coverage,'full');
 assert.throws(()=>dingtalkTranscript({taskUuid:'generated',complete:true,paragraphList:[{sentenceList:[{sentence:'Unknown primary format'}]}]}),(error:any)=>error.code==='recording_transcript_format_unsupported');
 assert.throws(()=>dingtalkTranscript({taskUuid:'generated',complete:true,paragraphList:[{paragraph:'   '}]}),(error:any)=>error.code==='recording_transcript_format_unsupported');
});

test('DingTalk actual connector intake keeps raw JSON, uses source corpus time, avoids redundant quote ambiguity and creates current revisions',async t=>{
 const sourceTime='2026-09-20T00:00:00.000Z',speech='I felt proud of finishing a generated prototype.',state={speech};
 const payload=()=>({taskUuid:'d1',complete:true,providerExtra:'Generated original metadata',paragraphList:[0,1].map(index=>({paragraphId:index+1,nickName:'Generated vendor label',paragraph:state.speech,sentenceList:[{sentence:state.speech,wordList:[{word:state.speech}]}]}))});
 const f=await fixture(t,directory=>createDingtalkRecordings(directory,async(command,profile)=>{
  if(command.kind==='status')return {authenticated:true,corp_id:'corp',user_id:'user'};
  assert.equal(profile,'corp:user');
  if(command.kind==='search')return {data:{minutes:[{taskUuid:'d1'}],complete:true},meta:{pagination:{endpoint_exhausted:true}}};
  if(command.kind==='metadata')return {data:{taskUuid:'d1',basic:{result:{taskUuid:'d1',title:'Generated corpus diary',startTime:Date.parse(sourceTime),duration:5000}}}};
  if(command.kind==='transcript')return {data:payload()};
  if(command.kind==='media'){await writeFile(resolve(directory,'dws-runtime',command.output),wav);return {data:{ok:true,succeeded:1,results:[{taskUuid:'d1'}]}};}
  throw Error('Unexpected generated command');
 }));
 await f.connect();await f.flush();const status=await f.request('GET'),head=f.node.sources.getItem(status.sourceId,'d1')!;
 assert.equal(status.counts.transcripts,1);assert.equal(status.counts.failed,0);assert.equal(head.document?.recordedAt,sourceTime);assert.equal(head.document?.timeBasis,'recorded');assert.equal(head.document?.occurredAt,undefined);assert.notEqual(head.observedAt,sourceTime);
 assert.equal(f.node.sources.listItems({sourceId:status.sourceId,after:sourceTime,before:'2026-09-21T00:00:00Z'}).items.length,1,'corpus date participates in normal source retrieval');
 const retained=JSON.parse(Buffer.concat([...f.node.files.bytes(head.captureId)]).toString());assert.deepEqual(JSON.parse(retained.rawText),payload());
 const chunks=f.node.files.chunks(head.captureId);assert.equal(chunks.length,2);assert.ok(chunks.every(chunk=>chunk.ocrText.includes(speech)&&!chunk.ocrText.includes('sentenceList')));
 const material=f.node.materials.list({sourceId:status.sourceId}).items[0],pin=f.node.materials.input(material.ref,['extracted-text'])!;
 assert.equal(pin.ready,true);assert.equal(pin.evidenceIds.length,2);assert.ok(!f.node.materials.read(material.ref).text.includes('sentenceList'));assert.ok(f.node.memories.readEvidence(pin.evidenceIds).every(record=>record.provenance?.document?.recordedAt===sourceTime));
 await f.memory();const initial=f.node.memoryPipeline.list().map(job=>f.node.memoryPipeline.get(job.id));assert.ok(initial.length);assert.ok(initial.every(job=>job.status==='completed'));assert.ok(initial.every(job=>job.batches.every(batch=>!batch.validationFailures?.some(failure=>failure.code==='quote_ambiguous'))));
 const oldMemoryIds=initial.flatMap(job=>job.memoryIds),modelCount=f.models.length;assert.ok(oldMemoryIds.length);
 await f.request('POST','/sync');await f.flush();await f.memory();assert.equal(f.models.length,modelCount);assert.equal(f.node.sources.history(status.sourceId,'d1').length,1);
 state.speech=speech.replace('proud','happy');await f.request('POST','/sync');await f.flush();assert.equal(f.node.sources.history(status.sourceId,'d1').length,2);assert.ok(oldMemoryIds.every(id=>f.node.memories.get(id).status==='stale'));assert.equal(Buffer.concat([...f.node.files.bytes(head.captureId)]).toString(),JSON.stringify(retained),'prior original asset is immutable');
 await f.memory();assert.ok(f.models.length>modelCount);await f.restart();await f.flush();await f.memory();assert.equal((await f.request('GET')).counts.transcripts,1);
});

test('DingTalk unsupported structure is retained as an explicit failure and retry publishes only a supported primary paragraph',async t=>{
 const state={paragraphs:[{unknownSpeech:'Generated original remains available'}] as Record<string,unknown>[]};
 const f=await fixture(t,directory=>createDingtalkRecordings(directory,async command=>{
  if(command.kind==='status')return {authenticated:true,corp_id:'corp',user_id:'user'};
  if(command.kind==='search')return {data:{minutes:[{taskUuid:'d1'}],complete:true}};
  if(command.kind==='metadata')return {data:{taskUuid:'d1',basic:{result:{taskUuid:'d1',title:'Generated unsupported diary',startTime:Date.parse('2026-09-20T00:00:00Z'),duration:5000}}}};
  if(command.kind==='transcript')return {data:{taskUuid:'d1',complete:true,paragraphList:state.paragraphs}};
  if(command.kind==='media'){await writeFile(resolve(directory,'dws-runtime',command.output),wav);return {data:{ok:true,succeeded:1,results:[{taskUuid:'d1'}]}};}
  throw Error('Unexpected generated command');
 }));
 await f.connect();await f.flush();await f.memory();let status=await f.request('GET');assert.equal(status.counts.transcripts,0);assert.equal(status.counts.failed,1);assert.equal(status.counts.empty,0);assert.equal(f.models.length,0);assert.ok(status.steps.some((step:any)=>step.error==='recording_transcript_format_unsupported'));
 const item=(await f.request('GET','/items?includeExports=true')).items[0];assert.equal(item.unsupported,true);assert.deepEqual(JSON.parse(new ArchivedFileStore(f.node.store).read(item.export.id).toString()).paragraphList,state.paragraphs);
 await f.restart();assert.equal((await f.request('GET')).counts.failed,1);state.paragraphs=[{paragraph:'I felt proud of finishing a generated prototype.',nickName:'Unverified'}];await f.request('POST','/retry');await f.flush();await f.memory();status=await f.request('GET');assert.equal(status.counts.transcripts,1);assert.equal(status.counts.failed,0);assert.ok(f.models.length>0);assert.ok(new ArchivedFileStore(f.node.store).read(item.export.id).toString().includes('unknownSpeech'));
});

test('a long provider transcript keeps every fine-grained segment in the material and Memory input beyond the ordinary 2000-block limit',async t=>{
 const f=await fixture(t);await f.request('POST','/connect');const status=await f.request('PUT','/selection',{...selection,enabled:false});
 f.node.sources.update(status.sourceId,{enabled:true});
 const segments=Array.from({length:2500},(_,n)=>({startMs:n,endMs:n+1,text:'Generated long recording segment '+n,speaker:'Unverified'}));
 const result=await f.node.files.transcriptRevision(status.sourceId,{externalId:'long',title:'Generated long recording',kind:'file',deleted:false,observedAt:new Date().toISOString(),document:{contentRole:'transcript',timeBasis:'unknown'}},'Generated original export',{durationMs:2500,segments,coverage:'full',engine:'generated'},()=>{});
 for(let n=0;n<35;n++)await f.node.materialOrganizer.tick(100);const material=f.node.materials.list({sourceId:status.sourceId}).items.find(m=>m.origin.externalId==='long')!;
 assert.ok(material,JSON.stringify(f.node.executor.list({limit:5})));assert.equal(material.coverage.state,'complete');assert.equal(material.blockCount,2502);const pin=f.node.materials.input(material.ref,['extracted-text'])!;assert.equal(pin.ready,true);assert.equal(pin.evidenceIds.length,2500);
 const chunk=f.node.store.db.prepare('SELECT count(*) n FROM file_chunks WHERE capture_id=?').get(result.id)!;assert.equal(chunk.n,2500);
 const reader=await f.request('GET','/items');assert.ok(reader.items.some((i:any)=>i.captureId===result.id));
});


test('empty exports remain available without full-text or Memory, survive restart, and later publish text without downloading audio again',async t=>{
 const f=await fixture(t);f.state.text='2026-09-20 08:00:00 CST|5s\n\nKeywords:\n';await f.connect();await f.flush();await f.memory();
 let status=await f.request('GET');assert.equal(status.counts.empty,1);assert.equal(status.counts.transcripts,0);assert.equal(status.counts.audio,1);assert.equal(status.counts.failed,0);assert.equal(f.models.length,0);
 assert.equal((await f.request('GET','/items')).items.length,0,'legacy clients receive only capture-backed records');
 const item=(await f.request('GET','/items?includeExports=true')).items[0];assert.equal(item.empty,true);assert.equal(item.captureId,undefined);assert.equal(new ArchivedFileStore(f.node.store).read(item.export.id).toString(),f.state.text);
 await f.restart();await f.request('POST','/sync');await f.flush();assert.equal((await f.request('GET')).counts.empty,1);assert.equal(f.calls.filter(c=>c.phase==='media').length,1);
 f.state.text=raw;await f.request('POST','/sync');await f.flush();await f.memory();status=await f.request('GET');assert.equal(status.counts.empty,0);assert.equal(status.counts.transcripts,1);assert.ok(f.models.length>0);assert.equal(f.calls.filter(c=>c.phase==='media').length,1);
 assert.equal(new ArchivedFileStore(f.node.store).read(item.export.id).toString(),'2026-09-20 08:00:00 CST|5s\n\nKeywords:\n');
});

test('successful empty native Feishu artifacts retain a zero-byte original across restart and ordinary text recovery',async t=>{
 let text='',downloads=0;
 const f=await fixture(t,directory=>createFeishuRecordings(directory,async command=>{
  switch(command.kind){
   case 'status':return JSON.stringify({appId:'cli_generated',identities:{user:{available:true,openId:'generated'}}});
   case 'minutes-search':return JSON.stringify({ok:true,data:{items:[{token:'r1'}],has_more:false}});
   case 'minutes-metadata':return JSON.stringify({ok:true,data:{minute:{token:'r1',title:'Generated',create_time:String(Date.parse('2026-09-20T00:00:00Z')),duration:'5000'}}});
   case 'minutes-transcript':return JSON.stringify({ok:true,data:{transcript:text}});
   case 'minutes-media':downloads++;await writeFile(resolve(directory,'lark-runtime',command.output),wav);return '{"ok":true}';
   default:return '{}';
  }
 }));
 await f.connect();await f.flush();await f.memory();let status=await f.request('GET');assert.equal(status.counts.empty,1);assert.equal(status.counts.transcripts,0);assert.equal(status.counts.audio,1);assert.equal(status.counts.failed,0);assert.equal(f.models.length,0);assert.equal(f.node.materials.list({sourceId:status.sourceId}).items.length,0);
 const item=(await f.request('GET','/items?includeExports=true')).items[0];assert.equal(item.empty,true);assert.equal(item.captureId,undefined);assert.equal(new ArchivedFileStore(f.node.store).read(item.export.id).length,0);
 await f.restart();await f.flush();await f.memory();assert.equal((await f.request('GET')).counts.empty,1);assert.equal(f.models.length,0);assert.equal(new ArchivedFileStore(f.node.store).read(item.export.id).length,0);
 text=raw;await f.request('POST','/sync');await f.flush();await f.memory();status=await f.request('GET');assert.equal(status.counts.empty,0);assert.equal(status.counts.transcripts,1);assert.equal(status.counts.audio,1);assert.equal(downloads,1);assert.ok(f.models.length>0);assert.equal(new ArchivedFileStore(f.node.store).read(item.export.id).length,0,'later speech does not erase the earlier empty original');
});

test('typed native transcript throttling survives restart, recovers automatically and retains finite exhaustion and unknown failures',async t=>{
 const cliDirectory=await mkdtemp(join(tmpdir(),'mote-transcript-throttle-')),binary=join(cliDirectory,'vendor'),control=join(cliDirectory,'control'),log=join(cliDirectory,'calls');t.after(()=>rm(cliDirectory,{recursive:true,force:true}));
 await writeFile(control,JSON.stringify({remaining:1,type:'rate'}));
 await writeFile(binary,`#!/usr/bin/env node
 const fs=require('node:fs'),args=process.argv.slice(2);if(args.includes('--version'))console.log('lark-cli 1.0.98');else{
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');const file=${JSON.stringify(control)},state=JSON.parse(fs.readFileSync(file,'utf8'));
 if(args[0]!=='api'){console.error('[minutes +detail] generated progress');console.log(JSON.stringify({ok:false,data:{minutes:[{minute_token:'r1',error:'Generated provider prose'}]}}));process.exitCode=1;}
 else if(state.remaining>0){state.remaining--;fs.writeFileSync(file,JSON.stringify(state));console.error(JSON.stringify({ok:false,error:state.type==='rate'?{type:'api',subtype:'rate_limit',code:99991400,retryable:true}:{type:'api',subtype:'unknown',retryable:true,message:'Generated rate limit prose is not a typed cause'}}));process.exitCode=1;}
 else console.log(JSON.stringify({ok:true,data:{transcript:${JSON.stringify(raw)}}}));}`,{mode:0o700});
 const f=await fixture(t,directory=>{const native=createLarkRunner(directory,{localProfile:true,binary});return createFeishuRecordings(directory,async(command,options)=>{
  switch(command.kind){
   case 'status':return JSON.stringify({appId:'cli_generated',identities:{user:{available:true,openId:'generated'}}});
   case 'minutes-search':return JSON.stringify({ok:true,data:{items:[{token:'r1'}],has_more:false}});
   case 'minutes-metadata':return JSON.stringify({ok:true,data:{minute:{token:'r1',title:'Generated',create_time:String(Date.parse('2026-09-20T00:00:00Z')),duration:'5000'}}});
   case 'minutes-transcript':return native(command,options);
   case 'minutes-media':await writeFile(resolve(directory,'lark-runtime',command.output),wav);return '{"ok":true}';
   default:return '{}';
  }
 });});
 const row=()=>f.node.store.db.prepare("SELECT id,state,attempts,error,available_at FROM execution_steps WHERE kind='recording.feishu.transcript' ORDER BY rowid DESC LIMIT 1").get()!;
 const before=Date.now();await f.request('POST','/connect');await f.request('PUT','/selection',{...selection,start:'2026-09-10T00:00:00Z'});await f.flush();const waiting=row();assert.equal(waiting.state,'waiting');assert.equal(waiting.error,'recording_rate_limited');assert.equal(waiting.attempts,1);assert.ok(Number(waiting.available_at)>=before+60000);assert.equal((await f.request('GET')).counts.audio,1);
 await f.restart();await f.flush();assert.equal(row().available_at,waiting.available_at);assert.equal((await readFile(log,'utf8')).trim().split('\n').length,1);
 f.node.store.db.prepare('UPDATE execution_steps SET available_at=0 WHERE id=?').run(waiting.id);await f.flush();await f.memory();assert.equal(row().state,'succeeded');assert.equal(row().attempts,2);assert.equal((await f.request('GET')).counts.transcripts,1);const models=f.models.length;
 await writeFile(control,JSON.stringify({remaining:10,type:'rate'}));await f.request('POST','/sync');await f.flush();const repeated=row();assert.equal(repeated.state,'waiting');assert.equal(repeated.attempts,1);
 for(let attempt=2;attempt<=3;attempt++){f.node.store.db.prepare('UPDATE execution_steps SET available_at=0 WHERE id=?').run(repeated.id);await f.flush();assert.equal(row().attempts,attempt);assert.equal(row().state,attempt===3?'failed':'waiting');assert.equal(row().error,'recording_rate_limited');}
 const calls=(await readFile(log,'utf8')).trim().split('\n').length;await f.flush();assert.equal((await readFile(log,'utf8')).trim().split('\n').length,calls);
 await writeFile(control,JSON.stringify({remaining:10,type:'unknown'}));await f.request('POST','/retry');await f.flush();assert.equal(row().state,'failed');assert.equal(row().attempts,1);assert.equal(row().error,'recording_provider_failed');await f.memory();assert.equal(f.models.length,models);assert.equal((await f.request('GET')).counts.audio,1);
});
test('format structure distinguishes empty intervals, unsupported text and incomplete vendor exports',()=>{
 assert.equal(feishuTranscript('',5000),null);assert.equal(feishuTranscript('A 00:00:00.000\n\n',5000),null);
 const partial=feishuTranscript('A 00:00:00.000\nWords\nB 00:00:02.000\n\nC 00:00:03.000\nMore',5000)!;
 assert.equal(partial.segments.length,2);assert.equal(partial.segments[0].endMs,2000);
 assert.throws(()=>feishuTranscript('Unknown nonempty export format',5000),(error:any)=>error.code==='recording_transcript_format_unsupported');
 assert.throws(()=>dingtalkTranscript({taskUuid:'generated',complete:false,paragraphList:[]}),(error:any)=>error.code==='recording_transcript_not_ready');
 assert.equal(dingtalkTranscript({taskUuid:'generated',complete:true,paragraphList:[]}).transcript,null);
});
test('old failures stay visible while all current recording steps paginate through the owner API',async t=>{
 const f=await fixture(t);f.state.transcriptFails=true;await f.connect();await f.flush();
 const old=(await f.request('GET')).steps.find((s:any)=>s.phase==='transcript');f.state.transcriptFails=false;f.state.ids=Array.from({length:35},(_,i)=>'generated-'+i);
 await f.request('POST','/sync');await f.flush();const status=await f.request('GET');assert.ok(status.steps.some((s:any)=>s.id===old.id&&s.state==='blocked'&&s.title==='Generated diary'));
 let cursor:number|null=null,all:any[]=[];do{const page=await f.request('GET','/steps?limit=7'+(cursor?'&cursor='+cursor:''));all.push(...page.items);cursor=page.nextCursor;}while(cursor);
 assert.equal(all.length,status.stepsTotal);assert.equal(new Set(all.map(s=>s.id)).size,all.length);assert.ok(all.some(s=>s.id===old.id));
 assert.equal((await f.node.app.inject({url:'/api/connectors/feishu-recordings/steps'})).statusCode,401);
});

test('Feishu adapter retains unsupported exports and only explicit upstream not-ready is transient',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-feishu-empty-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let response:unknown,content='Unknown generated export';
 const provider=createFeishuRecordings(directory,async command=>{if(command.kind!=='minutes-transcript')return '{}';if(response)return JSON.stringify(response);return JSON.stringify({ok:true,data:{transcript:content}});});
 const account={id:'generated'},metadata={id:'r1',title:'Generated',durationMs:5000},signal=new AbortController().signal;
 const unsupported=await provider.transcript(account,metadata,signal);assert.equal(unsupported.rawText,content);assert.equal(unsupported.formatError,'recording_transcript_format_unsupported');
 content='2026-09-20 08:00:00 CST|5s\n\nKeywords:\n';assert.equal((await provider.transcript(account,metadata,signal)).transcript,null);
 for(const body of [{code:2091003},{error:{code:2091003}}]){response=body;await assert.rejects(provider.transcript(account,metadata,signal),(error:any)=>error.code==='recording_transcript_not_ready'&&error.category==='transient');}
 response={data:{minutes:[]}};await assert.rejects(provider.transcript(account,metadata,signal),(error:any)=>error.code==='recording_contract_invalid'&&error.category==='permanent');
});


test('recording Material and downstream Memory recover a transient phase without replaying acquisition or completed extraction',async t=>{
 for(const phase of ['extract','review'] as const)await t.test(phase,async t=>{
  const f=await fixture(t);await f.connect();await f.flush();const status=await f.request('GET'),material=f.node.materials.list({sourceId:status.sourceId}).items[0];
  f.state.modelFailurePhase=phase;f.state.modelFailures=phase==='extract'?2:1;await f.memory();
  assert.equal(f.node.memoryPipeline.list().every(job=>job.status==='completed'),true);
  assert.equal(f.calls.filter(call=>call.phase==='transcript').length,1);assert.equal(f.calls.filter(call=>call.phase==='media').length,1);
  assert.equal(f.node.materials.list({sourceId:status.sourceId}).items[0].ref,material.ref);
  assert.equal(f.models.filter(input=>input.traceContext?.phase==='extract').length,phase==='extract'?3:1);
  assert.equal(f.models.filter(input=>input.traceContext?.phase==='review').length,phase==='review'?2:1);
  await f.memory();assert.equal(f.models.length,phase==='extract'?4:3,'completed downstream work is reused');
 });
});

test('held downstream Memory does not hold subsequent recording acquisition and Material publication',async t=>{
 const f=await fixture(t);await f.connect();await f.flush();let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(resolve=>entered=resolve);f.state.modelEntered=entered;f.state.modelHeld=new Promise<void>(resolve=>release=resolve);
 const memory=f.memory();await started;
 try{
  f.state.ids=['r1','r2'];await f.request('POST','/sync');await f.flush();const status=await f.request('GET');
  assert.equal(status.counts.transcripts,2);assert.equal(status.counts.audio,2);assert.equal(f.node.materials.list({sourceId:status.sourceId}).items.length,2);
  assert.ok(f.node.memoryPipeline.list().some(job=>job.status==='running'),'source publication completes while downstream model work is held');
 }finally{release();}
 await memory;await f.memory();assert.equal(f.node.memoryPipeline.list().every(job=>job.status==='completed'),true);
});
