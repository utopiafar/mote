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
import {planGeneratedMemory,generatedMemoryOutput} from './fixtures/memory-planning.js';
const raw='Generated diary export\n\nOwner 00:00:00.000\nI felt proud of finishing a generated prototype.\n\nOwner 00:00:02.500\nI prefer quiet mornings for focused work.\n';
const selection={enabled:true,start:'2026-09-01T00:00:00Z',end:'2026-10-01T00:00:00Z',autoSync:false,backupAudio:true};
const wav=Buffer.concat([Buffer.from('RIFF0000WAVE'),Buffer.alloc(200)]);
async function fixture(t:import('node:test').TestContext){
 const directory=await mkdtemp(join(tmpdir(),'mote-recording-fixture-'));
 const state={account:'generated-owner',text:raw,ids:['r1','r1'],mediaFails:false,transcriptFails:false,pages:false,cycle:false,held:undefined as undefined|Promise<void>,switchAfterRead:false};
 const calls:{phase:string;id?:string;start?:string;end?:string}[]=[],models:QueryInput[]=[];
 const provider:RecordingProvider={id:'feishu',version:'generated@1',account:async()=>({id:state.account,name:'Generated owner'}),
  discover:async(_account,range)=>{calls.push({phase:'discover',...range});return {ids:range.cursor?['r2']:state.ids,...(state.cycle?{next:range.cursor==='a'?'b':'a'}:state.pages&&!range.cursor?{next:'second'}:{})};},
  metadata:async(_account,id)=>{calls.push({phase:'metadata',id});return {id,title:'Generated diary',recordedAt:'2026-09-20T00:00:00Z',durationMs:5000};},
  transcript:async()=>{calls.push({phase:'transcript'});if(state.held)await state.held;if(state.transcriptFails)throw new ExecutionFailure('blocked','generated_transcript_unavailable');if(state.switchAfterRead)state.account='another-generated-owner';return {rawText:state.text,transcript:feishuTranscript(state.text,5000)};},
  media:async()=>{calls.push({phase:'media'});if(state.mediaFails)throw new ExecutionFailure('blocked','generated_media_permission');return {mimeType:'audio/wav',bytes:wav};},
 };
 const config:Config={dataDir:directory,token:'generated-recording-owner-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:true};
 let node:Awaited<ReturnType<typeof buildApp>>;
 const deps={backgroundWorker:false,connectorTesting:{recordings:[provider]},agent:{configured:true,close:async()=>{},query:async(input:QueryInput)=>{
  if(await planGeneratedMemory(input))return {answer:'Generated packages submitted.',citations:[],trace:[],runId:randomUUID()};
  models.push(input);const evidence=node.memories.readEvidence(input.evidenceIds!)[0],id=evidence.id;
  return {answer:generatedMemoryOutput(input,[{domain:'personal',title:'Generated pride',statement:`Felt proud of a generated prototype [${id}]`,uncertainty:'Generated evidence only; speaker label unverified.',admission:{layer:'memory',reason:'Generated personal experience',scope:'Generated diary',attribution:'user'},evidenceIds:[id],evidence:[{id,quote:evidence.ocrText.trim()}]}]),citations:[{id,capturedAt:evidence.capturedAt,appName:evidence.appName,excerpt:''}],trace:[],runId:randomUUID()};
 }}};
 node=await buildApp(config,deps);await node.app.ready();
 const request=async(method:'GET'|'POST'|'PUT'|'DELETE',suffix='',payload?:unknown)=>{const res=await node.app.inject({method,url:'/api/connectors/feishu-recordings'+suffix,headers:{authorization:'Bearer '+config.token},...(payload?{payload}:{})});assert.equal(res.statusCode,200,res.body);return res.json();};
 const flush=async()=>{for(let n=0;n<30;n++){const steps=node.store.db.prepare("SELECT id FROM execution_steps WHERE kind LIKE 'recording.feishu.%' AND state IN ('waiting','running') AND available_at<=? LIMIT 100").all(Date.now()) as {id:string}[];if(!steps.length)break;await node.executor.drain(steps.map(s=>s.id));}await node.materialOrganizer.tick(100);await node.sourcePipelines.tick(100);};
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
 const text='甲 00:00:00.040\n'+('x'.repeat(7999)+'😀').repeat(2)+'\n\n乙 00:00:02.000\nEnd\n';const parsed=feishuTranscript(text,4000);assert.ok(parsed.segments.length>2);assert.equal(parsed.segments[0].startMs,40);assert.equal(parsed.segments.at(-1)?.speaker,'乙');assert.ok(parsed.segments.every(s=>s.text.length<=8000));
 assert.throws(()=>feishuTranscript('not a transcript',100));assert.throws(()=>feishuTranscript('A 00:00:02.000\nText\nB 00:00:01.000\nText',4000));
 const dws=dingtalkTranscript({taskUuid:'generated',complete:true,paragraphList:[{speakerNick:'Unknown',words:[{text:'Generated words'}]}]});assert.ok(dws.rawText.includes('Generated words'));assert.equal(dws.transcript.segments[0].untimed,true);assert.throws(()=>dingtalkTranscript({taskUuid:'generated',complete:false,paragraphList:[]}));
 const args=dwsArguments({kind:'search',start:selection.start,end:selection.end},'corp:user');assert.ok(args.includes('corp:user'));assert.ok(!args.includes('--query'));
 const dir=await mkdtemp(join(tmpdir(),'mote-export-contract-'));t.after(()=>rm(dir,{recursive:true,force:true}));await mkdir(join(dir,'safe'));await writeFile(join(dir,'outside'),'private fixture');await assert.rejects(recordingFile(join(dir,'safe'),'../outside',100));
});

test('Feishu CLI adapter validates actual envelopes and reads only controlled exports; creation time is not a recording date',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-feishu-format-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const provider=createFeishuRecordings(directory,async command=>{switch(command.kind){case 'status':return JSON.stringify({appId:'cli_generated',identities:{user:{available:true,openId:'generated'}}});case 'minutes-search':return JSON.stringify({ok:true,data:{items:[{token:'r1'}],has_more:false}});case 'minutes-metadata':return JSON.stringify({data:{minute:{token:'r1',title:'Generated',create_time:String(Date.parse('2026-09-20T00:00:00Z')),duration:'5000'}}});case 'minutes-transcript':{const path=resolve(directory,'lark-runtime',command.outputDir,'transcript.txt');await writeFile(path,raw);return JSON.stringify({data:{minutes:[{minute_token:'r1',artifacts:{transcript_file:path}}]}});}case 'minutes-media':await writeFile(resolve(directory,'lark-runtime',command.output),wav);return '{}';default:return '{}';}});
 const account=await provider.account(),signal=new AbortController().signal;assert.equal((await provider.discover(account,selection,signal)).ids[0],'r1');const metadata=await provider.metadata(account,'r1',signal);assert.equal(metadata.recordedAt,undefined);assert.ok(metadata.createdAt);assert.equal((await provider.transcript(account,metadata,signal)).transcript.segments.length,2);assert.equal((await provider.media(account,metadata,signal)).mimeType,'audio/wav');
 const dws=createDingtalkRecordings(directory,async command=>command.kind==='status'?{authenticated:true,corp_id:'corp',user_id:'user'}:command.kind==='metadata'?{data:{taskUuid:'d1',basic:{result:{uuid:'d1',title:'Generated'}}}}:command.kind==='search'?{data:{minutes:[{taskUuid:'d1'}],complete:true},meta:{pagination:{endpoint_exhausted:true}}}:{data:{taskUuid:'d1',complete:true,paragraphList:[{text:'Generated'}]}});
 const da=await dws.account();assert.equal((await dws.metadata(da,'d1',signal)).title,'Generated');assert.equal((await dws.discover(da,selection,signal)).ids[0],'d1');assert.ok((await dws.transcript(da,{id:'d1',title:'Generated',durationMs:0},signal)).transcript.segments.length);
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
