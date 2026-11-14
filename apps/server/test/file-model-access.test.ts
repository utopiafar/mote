import {authorizeFixtureModels,withFixtureOwnerModelWork,fixtureTopicResult} from './fixtures/model-authorization.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ContextReader} from '@mote/agent';
import {formatArtifactRef} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {sha256} from '../src/store.js';
import {materialId} from '../src/materials.js';
import {TURN_GROUP_PROMPT,readDialogueCleanup} from '../src/file-dialogue.js';
import {mediaModelIdentities} from '../src/media-assets.js';
import {FUNASR_PROTOCOL,parseFunasrRequest,parseFunasrResponse,type FunasrRequest} from '../src/funasr-contract.js';
import {createServer} from 'node:http';
import {fixtureFilePolicy} from './fixtures/file-policy.js';

test('local file outputs are available to remote and local models across every evidence representation',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-file-content-policy-'));
 const config:Config={dataDir:directory,token:'generated-content-policy-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture-remote',modelBaseUrl:'https://synthetic.invalid',apiKey:'fixture',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let inspect:(reader:ContextReader)=>Promise<Record<string,unknown>>=async()=>({});
 const calls:{model:string;views:Record<string,unknown>}[]=[];
 const node=await buildApp(config,{createModelAgent:async(settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
  const topic=fixtureTopicResult(input);if(topic)return topic;
  const views=await inspect(reader);calls.push({model:settings.model,views});return {answer:'{"memories":[]}',citations:[],trace:[],runId:randomUUID()};
 }})});
 const settings=node.lifecycle.settings();for(const key of ['consolidation','insights','working'] as const)settings[key].enabled=false;await node.lifecycle.save({revision:node.configService.revision,settings});
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
 const dependencies=[parent.id,chunk,record.id,excerpt],hostReader=node.featureServices.evidenceReader;
 assert.equal(hostReader.contextDependenciesAllowed(dependencies),dependencies.every(id=>hostReader.deletionContextAllowed(id)),'batch metadata checks preserve file, attachment-parent and Material permission semantics');
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
 await withFixtureOwnerModelWork(node,()=>Promise.all([node.agent.query({question:'Generated read check',modelProfileId:'env:deployment'}),node.agent.query({question:'Generated read check',modelProfileId:'local'})]));
 const remote=calls.find(c=>c.model==='fixture-remote')!.views,local=calls.find(c=>c.model==='fixture-local')!.views;
 assert.deepEqual(remote,local,'model location does not change content access');
 for(const key of ['raw','chunks','materialEvidence','catalog','search','timeline','memories','segments','items','history','excerpt'])assert.ok(Number(remote[key])>0,key);
 assert.match(String(remote.materialText),/GENERATED_ANCHOR/);
 assert.ok(node.featureServices.evidenceReader.memorySelection().evidenceIds.includes(record.id));
 for(const modelProfileId of ['env:deployment','local']){
  const job=await withFixtureOwnerModelWork(node,async()=>node.memoryPipeline.create({evidenceIds:anchors,modelProfileId}));assert.ok(job.totalBatches>0);node.memoryPipeline.cancel(job.id);
 }
 await withFixtureOwnerModelWork(node,()=>node.agent.query({question:'Generated fixed evidence',evidenceIds:[record.id]}));assert.ok(Number(calls.at(-1)!.views.materialEvidence)>0);
 const owner=await node.app.inject({url:'/api/captures/'+chunk,headers:{authorization:'Bearer '+config.token}});assert.equal(owner.statusCode,200);assert.equal(owner.json().ocrText,text);
 let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),held=new Promise<void>(resolve=>release=resolve);
 inspect=async()=>{enter();await held;return {};};
 const {inFlight,running}=await withFixtureOwnerModelWork(node,async()=>{const inFlight=node.memoryPipeline.create({evidenceIds:anchors});return {inFlight,running:node.memoryPipeline.run(inFlight.id)};});await entered;
 node.store.delete(parent.id);release();
 const finished=await running;assert.notEqual(finished.status,'completed');assert.equal(finished.memoryIds.length,0);
 assert.equal(node.store.db.prepare('SELECT COUNT(*) n FROM memory_checkpoints').get()!.n,0);
 const beforeRetry=calls.length,retry=await node.memoryPipeline.retry(inFlight.id);assert.equal(retry.status,'failed');assert.equal(retry.memoryIds.length,0);assert.equal(calls.length,beforeRetry,'deleted original prevents another model call');
});

test('native local dialogue routes grouping and summaries through the configured central file model',async t=>{
 // Generate the unavailable inference boundary with the production Python
 // serializers; keep the default processors, recipe, cleanup and HTTP client.
 const producer=spawnSync('python3',['-c',String.raw`
import base64,io,json,sys,wave
import mote_asr_contract as c
from test_mote_asr_contract import generated_identity,generated_source
identity=generated_identity();identity['models']=json.load(sys.stdin)
source=generated_source(2000)
request={'protocol':c.PROTOCOL,'operation':'recognize','audioSha256':source['audioSha256'],'maxAudioMs':2000,'identity':identity}
rows=[{'start':0,'end':1000,'text':'Generated first voice'},{'start':1000,'end':2000,'text':'Generated second voice'}]
native={'text':'\n'.join(row['text'] for row in rows),'sentence_info':rows}
recognition=c.recognize_to_checkpoint(request,source,identity,{'value':[[0,2000]]},native,[{'text':native['text']}])
diarize_request={**request,'operation':'diarize','checkpoint':json.loads(recognition)['checkpoint'],'speakers':{'mode':'exact','count':2}}
result=c.speakers_from_sdk(c.read_checkpoint(diarize_request['checkpoint']),diarize_request['speakers'],
                         [{**row,'spk':index} for index,row in enumerate(rows)],[[0,1,0],[1,2,1]],[])
diarization=c.diarize_from_checkpoint(diarize_request,source,identity,lambda cp,options:result)
audio=io.BytesIO()
with wave.open(audio,'wb') as wav:
 wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000);wav.writeframes(b'\0\0'*32000)
print(c.serialize({'identity':identity,'recognition':recognition,'diarization':diarization,'audio':base64.b64encode(audio.getvalue()).decode()}))
 `],{cwd:fileURLToPath(new URL('../../../scripts/',import.meta.url)),input:JSON.stringify(mediaModelIdentities('dialogue')),encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
 assert.equal(producer.status,0,producer.stderr||String(producer.error));
 const generated=JSON.parse(producer.stdout),bytes=Buffer.from(generated.audio,'base64'),requests:FunasrRequest[]=[],workerErrors:unknown[]=[];
 const directory=mkdtempSync(join(tmpdir(),'mote-native-analysis-'));
 const worker=createServer((req,res)=>{void(async()=>{
  assert.equal(req.headers.authorization,'Bearer generated-native-worker-token');
  res.setHeader('Content-Type','application/json');res.setHeader('X-Mote-Execution','local');
  if(req.url==='/health'){res.end(JSON.stringify({protocol:FUNASR_PROTOCOL,execution:'local',asr:true,diarization:true,identity:generated.identity}));return;}
  assert.ok(req.url==='/transcribe'||req.url==='/diarize');assert.equal(req.headers['x-mote-offline'],'1');
  const parts:Buffer[]=[];for await(const part of req)parts.push(Buffer.from(part));
  const body=Buffer.concat(parts);assert.equal(body.length,Number(req.headers['content-length']));
  const form=await new Response(body,{headers:{'content-type':String(req.headers['content-type'])}}).formData();
  const request=parseFunasrRequest(String(form.get('request'))),audio=form.get('audio');
  assert.ok(audio instanceof Blob);assert.deepEqual(Buffer.from(await audio.arrayBuffer()),bytes);assert.equal(request.audioSha256,sha256(bytes));
  assert.equal(request.operation,req.url==='/transcribe'?'recognize':'diarize');requests.push(request);
  const response=generated[request.operation==='recognize'?'recognition':'diarization'];
  parseFunasrResponse(response,request);
  res.setHeader('X-Mote-Receipt-Id',String(req.headers['x-mote-request-id']));res.end(response);
 })().catch(error=>{workerErrors.push(error);res.writeHead(500).end();});});
 let closeNode=async()=>{};
 t.after(async()=>{try{await closeNode();}finally{worker.closeAllConnections();await new Promise<void>(resolve=>worker.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});}assert.deepEqual(workerErrors,[],'native worker boundary assertions must surface');});
 await new Promise<void>(resolve=>worker.listen(0,'127.0.0.1',resolve));
 const config:Config={dataDir:directory,token:'generated-native-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-deployment-fallback',modelProvider:'codex',modelProtocol:'codex-app-server',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 const modelCalls:{model:string;protocol:string;question:string;evidence:string[]}[]=[];
 const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
  const timeline=await reader.timeline({}),records=Array.isArray(timeline)?timeline:timeline.items;
  modelCalls.push({model:settings.model,protocol:settings.protocol,question:input.question,evidence:records.map(record=>record.ocrText)});
  assert.equal(records.length,2);
  return {answer:input.question===TURN_GROUP_PROMPT?JSON.stringify({groups:[[0],[1]]}):'Generated summary',citations:records.map(r=>({id:r.id,capturedAt:r.capturedAt,appName:r.appName,excerpt:r.ocrText})),trace:[],runId:randomUUID()};
 }})});
 closeNode=async()=>{await node.app.close();};
 const selected=node.modelSettings.view();await node.modelSettings.updateDefaults({revision:selected.revision,defaults:selected.defaults,defaultModels:{file:'gpt-6.1-sol',memory:'generated-memory-model',chat:'generated-chat-model'}});
 const view=node.processing.view(),policy=view.policy,profile=policy.profiles.find(p=>p.processorId==='audio.local-dialogue')!;
 profile.parameters={speakerCount:2,semanticTurns:true};profile.summarize=true;
 Object.assign(policy.services.find(s=>s.id==='asr-local')!,{endpoint:`http://127.0.0.1:${(worker.address() as {port:number}).port}/transcribe`,apiKey:'generated-native-worker-token'});
 await node.processing.save({revision:view.revision,settings:view.settings,policy});
 await authorizeFixtureModels(node);
 node.sources.register({id:'generated-native',name:'Generated audio',kind:'local-files',deviceId:'generated',platform:'import',retention:'archive'});
 const upload=node.files.begin({sourceId:'generated-native',item:{externalId:'audio',revision:'1',observedAt:'2026-10-06T00:00:00Z',kind:'file',layer:'original',text:'',mimeType:'audio/wav'},sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});
 node.files.part(upload.uploadId,0,bytes,()=>{});const original=await node.files.commit(upload.uploadId,()=>{});
 await node.processing.tick();
 const detail=node.files.detail(original.id);assert.equal(detail.job.state,'succeeded',JSON.stringify(detail.job));assert.equal(detail.job.summary_state,'succeeded');
 assert.deepEqual(requests.map(request=>request.operation),['recognize','diarize']);
 const recognition=parseFunasrResponse(generated.recognition);assert.equal(recognition.status,'succeeded');
 if(recognition.status!=='succeeded'||requests[1].operation!=='diarize')assert.fail('Expected saved recognition and native diarization');
 assert.deepEqual(requests[1].checkpoint,recognition.checkpoint,'diarization consumes the exact recognition checkpoint');
 assert.equal(modelCalls.length,2);assert.equal(modelCalls[0].question,TURN_GROUP_PROMPT);assert.ok(modelCalls.every(call=>call.model==='gpt-6.1-sol'&&call.protocol==='codex-app-server'));
 assert.deepEqual(modelCalls[0].evidence.map(text=>{const turn=JSON.parse(text);return [turn.turnIndex,turn.text,turn.speaker];}),[[0,'Generated first voice','SPEAKER_0'],[1,'Generated second voice','SPEAKER_1']]);
 assert.deepEqual(modelCalls[1].evidence,['[SPEAKER_0] Generated first voice','[SPEAKER_1] Generated second voice']);
 const cleanup=node.store.db.prepare("SELECT json FROM file_artifacts WHERE capture_id=? AND json_extract(json,'$.output.type.id')='mote.cleaned-dialogue'").get(original.id);
 assert.ok(cleanup);assert.equal(readDialogueCleanup(JSON.parse(String(cleanup.json)))!.cleanup.enabled,true);
 assert.ok(detail.artifacts.some(a=>a.kind==='dialogue'&&a.semanticGrouping===true));assert.ok(detail.artifacts.some(a=>a.kind==='summary'));assert.equal(node.files.pendingIndex('configured-embedding').length,2);
 assert.deepEqual(node.processing.explain(original.id).capabilities,{dialogue:true,summary:true});
});

for(const stage of ['summary','semantic grouping'] as const)test(`file ${stage} rejection reaches the real Agent repair conversation before publication`,{timeout:30000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-summary-citation-repair-')),requests:any[]=[];let citationId='';
 const provider=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;requests.push(JSON.parse(raw));
  citationId=node.files.chunks(original.id)[0].id;
  const first=requests.length===1,empty=requests.length===2;
  const answer=stage==='summary'?(empty?'Generated uncited summary':`Generated cited summary [${citationId}]`):JSON.stringify({groups:empty?[[1]]:[[0]]});
  const delta=first?{role:'assistant',tool_calls:[{index:0,id:'generated-discovery',type:'function',function:{name:'search_context',arguments:'{"query":"generated"}'}}]}:{role:'assistant',content:JSON.stringify({answer,citationIds:stage==='summary'&&empty?[]:[citationId]})};
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})}\n\n`);res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:first?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);
 });
 await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const config:Config={dataDir:directory,token:'generated-summary-repair-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-summary',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`,apiKey:'generated',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,agentTimeoutMs:20000};
 const node=await buildApp(config,{backgroundWorker:false});await node.app.ready();
 t.after(async()=>{await node.app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});});
 if(stage==='semantic grouping'){
  node.processing.runtime.registry.register({id:'fixture.repair-audio',version:'1',name:'Generated audio',stage:'extract',serviceKind:'asr',localOnly:true,dialogue:true,mediaTypes:['audio/'],parameters:[{key:'semanticTurns',label:'Generated grouping',type:'boolean',default:false}],process:async()=>({durationMs:1000,segments:[{startMs:0,endMs:1000,text:'Generated audio grouping evidence'}]})});
  node.processing.runtime.registry.register({id:'fixture.repair-diarizer',version:'1',name:'Generated diarization',stage:'diarize',localOnly:true,mediaTypes:['audio/'],process:async()=>({durationMs:1000,engine:'generated',expectedSpeakers:null,observedSpeakers:1,overlapDetection:'unknown',segments:[{startMs:0,endMs:1000,speaker:'SPEAKER_0'}],samples:[]})});
 }
 const settings={...node.processing.currentSettings(),enabled:true,summarize:stage==='summary',...(stage==='semantic grouping'?{audioProcessor:'fixture.repair-audio',diarizationProcessor:'fixture.repair-diarizer',semanticTurns:true}:{})};await node.processing.save({revision:node.processing.view().revision,settings,policy:fixtureFilePolicy(settings,node.processing.runtime.registry)});
 await authorizeFixtureModels(node);node.featureRoutes.stop();
 node.sources.register({id:'generated-summary-repair',name:'Generated summary repair',kind:'local-files',deviceId:'generated',platform:'import',retention:'archive'});
 const bytes=Buffer.from('Generated cited summary evidence'),upload=node.files.begin({sourceId:'generated-summary-repair',item:{externalId:stage==='summary'?'generated.txt':'generated.wav',revision:'1',observedAt:'2026-10-15T00:00:00Z',kind:'file',layer:'original',text:'',mimeType:stage==='summary'?'text/plain':'audio/wav'},sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});
 node.files.part(upload.uploadId,0,bytes,()=>{});const original=await node.files.commit(upload.uploadId,()=>{});
 await node.processing.tick();
 const detail=node.files.detail(original.id);assert.equal(detail.job.state,'succeeded');assert.equal(requests.length,3,'one evidence discovery, one rejected answer and one in-session correction');
 const messages=requests[2].messages,correction=messages.filter((message:any)=>message.role==='user').at(-1).content;
 assert.match(typeof correction==='string'?correction:JSON.stringify(correction),stage==='summary'?/invalid_summary_citations/:/invalid_semantic_grouping/);assert.ok(messages.some((message:any)=>message.role==='tool'),'repair preserves the discovered evidence');
 if(stage==='summary'){
  assert.equal(detail.job.summary_state,'succeeded');const summary=detail.artifacts.find(artifact=>artifact.kind==='summary')!;assert.deepEqual(summary.sections[0].citationIds,[citationId]);assert.equal(summary.sections[0].answer,`Generated cited summary [${citationId}]`);
  assert.equal(node.store.db.prepare('SELECT count(*) n FROM file_summary_pages').get()!.n,1);
 }else assert.ok(detail.artifacts.some(artifact=>artifact.kind==='dialogue'&&artifact.semanticGrouping===true));
 assert.equal(node.store.db.prepare('SELECT count(*) n FROM file_processor_waits').get()!.n,0);
});
