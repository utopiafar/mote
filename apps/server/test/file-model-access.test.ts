import {fixtureMemoryResult} from './fixtures/memory-result.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ContextReader} from '@mote/agent';
import {formatArtifactRef} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {sha256} from '../src/store.js';
import {materialId} from '../src/materials.js';
import {TURN_GROUP_PROMPT} from '../src/file-dialogue.js';

test('local file outputs are available to remote and local models across every evidence representation',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-file-content-policy-'));
 const config:Config={dataDir:directory,token:'generated-content-policy-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture-remote',modelBaseUrl:'https://synthetic.invalid',apiKey:'fixture',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let inspect:(reader:ContextReader)=>Promise<Record<string,unknown>>=async()=>({});
 const calls:{model:string;views:Record<string,unknown>}[]=[];
 const node=await buildApp(config,{createModelAgent:async(settings,reader)=>({configured:true,close:async()=>{},query:async()=>{
  const views=await inspect(reader);calls.push({model:settings.model,views});return {answer:'{"memories":[]}',citations:[],trace:[],runId:randomUUID()};
 }})});
 const settings=node.lifecycle.settings();for(const key of ['consolidation','insights','working'] as const)settings[key].enabled=false;node.lifecycle.configure(settings);
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 node.sources.register({id:'generated-files',name:'Generated files',kind:'local-files',deviceId:'fixture-device',platform:'import',retention:'archive'});
 const bytes=Buffer.from('Generated original recording');
 const upload=node.files.begin({sourceId:'generated-files',item:{externalId:'recording',revision:'v1',observedAt:'2026-09-20T00:00:00Z',title:'Generated recording.wav',kind:'file',layer:'original',text:'',mimeType:'audio/wav'},sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});
 node.files.part(upload.uploadId,0,bytes,()=>{});const parent=await node.files.commit(upload.uploadId,()=>{});
 const artifact=randomUUID(),chunk=randomUUID(),text='GENERATED_ANCHOR recorded experience';
 node.store.db.prepare('INSERT INTO file_artifacts VALUES(?,?,?,?,?,?,1)').run(artifact,parent.id,'transcript','2026-09-20T00:00:00Z','fixture',JSON.stringify({complete:true,coverage:'full'}));
 node.store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,start_ms,end_ms,text,metadata) VALUES(?,?,?,?,?,?,?)').run(chunk,artifact,parent.id,0,1000,text,'{}');
 node.store.db.prepare("UPDATE file_jobs SET state='succeeded' WHERE capture_id=?").run(parent.id);
 while(await node.materialOrganizer.tick(100));
 const material=node.materials.get(materialId('generated-files','recording'))!,anchors=node.materials.evidenceIds(material.ref),record=node.materials.evidence(anchors).find(r=>r.ocrText===text)!;
 const memory=node.memories.extract(fixtureMemoryResult(node.memories,{answer:JSON.stringify({memories:[{title:'Generated recording Memory',statement:`Recorded experience [${record.id}]`,uncertainty:'Fixture',evidenceIds:[record.id],evidence:[{id:record.id,quote:text}]}]}),citations:[{id:record.id,capturedAt:record.capturedAt,appName:record.appName,excerpt:text}],trace:[],runId:'fixture'}),'fixture').items[0];
 const segment=node.store.archive.save('generated-private-segment','generated-private-segment','1',{kind:'segment',text:'Generated recording derived segment',metadata:{complete:true}},[{id:parent.id,fingerprint:node.store.archive.fingerprint(parent.id)!}],'fixture','1','fixture');
 const segmentRef=formatArtifactRef(segment.id,segment.revision);
 const excerpt=randomUUID();await node.store.ingest({id:excerpt,deviceId:'fixture-device',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-09-20T00:00:00Z',durationMs:0,ocrText:text});
 node.store.db.prepare('INSERT INTO file_evidence_links(parent_id,capture_id) VALUES(?,?)').run(parent.id,excerpt);
 inspect=async reader=>{
  const scope={deviceId:'fixture-device'};
  const [raw,chunks,materialEvidence,catalog,search,timeline,memories,segments,items,history,excerptEvidence]=await Promise.all([
   reader.evidence({ids:[parent.id],...scope}),reader.fileChunks!({id:parent.id,...scope}),reader.evidence({ids:[record.id],...scope}),reader.materialCatalog!(scope),reader.search({query:'GENERATED_ANCHOR',...scope}),reader.timeline(scope),reader.memories!({id:memory.id,...scope}),reader.segments!({id:segmentRef,...scope}),reader.sourceItems!({sourceId:'generated-files',...scope}),reader.sourceHistory!({id:parent.id,...scope}),reader.evidence({ids:[excerpt],...scope}),
  ]);
  let materialText='';try{materialText=(await reader.materialRead!({ref:material.ref,...scope})).text;}catch(error){assert.match(String(error),/Material not found/);}
  return {raw:raw.length,chunks:chunks.length,materialEvidence:materialEvidence.length,catalog:catalog.items.length,search:search.length,timeline:Array.isArray(timeline)?timeline.length:timeline.items.length,memories:memories.items.length,segments:segments.items.length,items:items.items.length,history:history.length,excerpt:excerptEvidence.length,materialText};
 };
 const localSettings={...node.modelSettings.current(),provider:'custom' as const,protocol:'openai-completions' as const,baseUrl:'http://127.0.0.1:1234/v1',model:'fixture-local',reasoningEffort:'auto' as const,apiKey:'',allowUnauthenticatedLocal:true};
 await node.modelSettings.updateProfile('local',{revision:node.modelSettings.view().revision,name:'Generated local model',settings:localSettings});
 await Promise.all([node.agent.query({question:'Generated read check',modelProfileId:'env:deployment'}),node.agent.query({question:'Generated read check',modelProfileId:'local'})]);
 const remote=calls.find(c=>c.model==='fixture-remote')!.views,local=calls.find(c=>c.model==='fixture-local')!.views;
 assert.deepEqual(remote,local,'model location does not change content access');
 for(const key of ['raw','chunks','materialEvidence','catalog','search','timeline','memories','segments','items','history','excerpt'])assert.ok(Number(remote[key])>0,key);
 assert.match(String(remote.materialText),/GENERATED_ANCHOR/);
 assert.ok(node.featureServices.evidenceReader.memorySelection().evidenceIds.includes(record.id));
 for(const modelProfileId of ['env:deployment','local']){
  const job=node.memoryPipeline.create({evidenceIds:anchors,modelProfileId});assert.ok(job.totalBatches>0);node.memoryPipeline.cancel(job.id);
 }
 await node.agent.query({question:'Generated fixed evidence',evidenceIds:[record.id]});assert.ok(Number(calls.at(-1)!.views.materialEvidence)>0);
 const owner=await node.app.inject({url:'/api/captures/'+chunk,headers:{authorization:'Bearer '+config.token}});assert.equal(owner.statusCode,200);assert.equal(owner.json().ocrText,text);
 let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),held=new Promise<void>(resolve=>release=resolve);
 inspect=async()=>{enter();await held;return {};};
 const inFlight=node.memoryPipeline.create({evidenceIds:anchors}),running=node.memoryPipeline.run(inFlight.id);await entered;
 node.store.delete(parent.id);release();
 const finished=await running;assert.notEqual(finished.status,'completed');assert.equal(finished.memoryIds.length,0);
 assert.equal(node.store.db.prepare('SELECT COUNT(*) n FROM memory_checkpoints').get()!.n,0);
 const beforeRetry=calls.length,retry=await node.memoryPipeline.retry(inFlight.id);assert.equal(retry.status,'failed');assert.equal(retry.memoryIds.length,0);assert.equal(calls.length,beforeRetry,'deleted original prevents another model call');
});

test('native local dialogue routes grouping and summaries through the configured central file model',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-native-analysis-'));
 const config:Config={dataDir:directory,token:'generated-native-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'gpt-6.1-sol',modelProvider:'codex',modelProtocol:'codex-app-server',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 const modelCalls:{model:string;protocol:string;question:string}[]=[];
 let asrCalls=0;
 const node=await buildApp(config,{backgroundWorker:false,transcriptionProvider:{transcribe:async input=>{
  assert.equal(input.localOnly,true);asrCalls++;
  return {durationMs:2000,segments:[{startMs:0,endMs:1000,text:'Generated first voice'},{startMs:1000,endMs:2000,text:'Generated second voice'}]};
 }},createModelAgent:async(settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
  modelCalls.push({model:settings.model,protocol:settings.protocol,question:input.question});
  const timeline=await reader.timeline({}),records=Array.isArray(timeline)?timeline:timeline.items;
  assert.equal(records.length,2);
  return {answer:input.question===TURN_GROUP_PROMPT?JSON.stringify({groups:[[0],[1]]}):'Generated summary',citations:records.map(r=>({id:r.id,capturedAt:r.capturedAt,appName:r.appName,excerpt:r.ocrText})),trace:[],runId:randomUUID()};
 }})});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 node.processing.runtime.registry.register({id:'fixture.central-diarize',version:'1',name:'Generated speakers',stage:'diarize',localOnly:true,mediaTypes:['audio/'],process:async()=>({durationMs:2000,engine:'fixture',expectedSpeakers:2,observedSpeakers:2,overlapDetection:'unknown',segments:[{startMs:0,endMs:1000,speaker:'SPEAKER_0'},{startMs:1000,endMs:2000,speaker:'SPEAKER_1'}],samples:[]})});
 const view=node.processing.view(),policy=view.policy,profile=policy.profiles.find(p=>p.processorId==='audio.local-dialogue')!;
 profile.parameters={speakerCount:2,semanticTurns:true};profile.diarizationProcessor='fixture.central-diarize';profile.summarize=true;policy.services.find(s=>s.id==='asr-local')!.endpoint='http://127.0.0.1:19009/transcribe';
 node.processing.update({revision:view.revision,settings:view.settings,policy});
 node.sources.register({id:'generated-native',name:'Generated audio',kind:'local-files',deviceId:'generated',platform:'import',retention:'archive'});
 const bytes=Buffer.from('Generated audio fixture'),upload=node.files.begin({sourceId:'generated-native',item:{externalId:'audio',revision:'1',observedAt:'2026-10-06T00:00:00Z',kind:'file',layer:'original',text:'',mimeType:'audio/wav'},sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});
 node.files.part(upload.uploadId,0,bytes,()=>{});const original=await node.files.commit(upload.uploadId,()=>{});
 await node.processing.tick();
 const detail=node.files.detail(original.id);assert.equal(detail.job.state,'succeeded');assert.equal(detail.job.summary_state,'succeeded');assert.equal(asrCalls,1);
 assert.equal(modelCalls.length,2);assert.equal(modelCalls[0].question,TURN_GROUP_PROMPT);assert.ok(modelCalls.every(call=>call.model==='gpt-6.1-sol'&&call.protocol==='codex-app-server'));
 assert.ok(detail.artifacts.some(a=>a.kind==='dialogue'&&a.semanticGrouping===true));assert.ok(detail.artifacts.some(a=>a.kind==='summary'));assert.equal(node.files.pendingIndex('configured-embedding').length,2);
 assert.deepEqual(node.processing.explain(original.id).capabilities,{dialogue:true,summary:true});
});
