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
import {EvidenceExposurePolicy} from '../src/evidence-exposure.js';
import {usesLocalModel} from '../src/model-agent.js';

test('local-only file policy follows chunks, Material, Memory and segments for the actual model profile',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-file-content-policy-'));
 const config:Config={dataDir:directory,token:'generated-content-policy-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture-remote',modelBaseUrl:'https://synthetic.invalid',apiKey:'fixture',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let inspect:(reader:ContextReader)=>Promise<Record<string,unknown>>=async()=>({});
 const calls:{model:string;views:Record<string,unknown>}[]=[];
 const node=await buildApp(config,{createModelAgent:async(settings,reader)=>({configured:true,close:async()=>{},query:async()=>{
  const views=await inspect(reader);calls.push({model:settings.model,views});return {answer:'{"memories":[]}',citations:[],trace:[],runId:randomUUID()};
 }})});
 const settings=node.lifecycle.settings();for(const key of ['extraction','consolidation','insights','working'] as const)settings[key].enabled=false;node.lifecycle.configure(settings);
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 node.sources.register({id:'generated-files',name:'Generated files',kind:'local-files',deviceId:'fixture-device',platform:'import',retention:'archive'});
 const bytes=Buffer.from('Generated original recording');
 const upload=node.files.begin({sourceId:'generated-files',item:{externalId:'recording',revision:'v1',observedAt:'2026-09-20T00:00:00Z',title:'Generated recording.wav',kind:'file',layer:'original',text:'',mimeType:'audio/wav'},sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});
 node.files.part(upload.uploadId,0,bytes,()=>{});const parent=await node.files.commit(upload.uploadId,()=>{});
 const artifact=randomUUID(),chunk=randomUUID(),text='PRIVATE_GENERATED_ANCHOR recorded experience';
 node.store.db.prepare('INSERT INTO file_artifacts VALUES(?,?,?,?,?,?,1)').run(artifact,parent.id,'transcript','2026-09-20T00:00:00Z','fixture',JSON.stringify({complete:true,coverage:'full'}));
 node.store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,start_ms,end_ms,text,metadata) VALUES(?,?,?,?,?,?,?)').run(chunk,artifact,parent.id,0,1000,text,'{}');
 node.store.db.prepare("UPDATE file_jobs SET state='succeeded',local_only=1 WHERE capture_id=?").run(parent.id);
 while(await node.materialOrganizer.tick(100));
 const material=node.materials.get(materialId('generated-files','recording'))!,anchors=node.materials.evidenceIds(material.ref),record=node.materials.evidence(anchors).find(r=>r.ocrText===text)!;
 const memory=node.memories.extract({answer:JSON.stringify({memories:[{title:'Generated private Memory',statement:`Recorded experience [${record.id}]`,uncertainty:'Fixture',evidenceIds:[record.id],evidence:[{id:record.id,quote:text}]}]}),citations:[{id:record.id,capturedAt:record.capturedAt,appName:record.appName,excerpt:text}],trace:[],runId:'fixture'},'fixture').items[0];
 const segment=node.store.archive.save('generated-private-segment','generated-private-segment','1',{kind:'segment',text:'Generated private derived segment',metadata:{complete:true}},[{id:parent.id,fingerprint:node.store.archive.fingerprint(parent.id)!}],'fixture','1','fixture');
 const segmentRef=formatArtifactRef(segment.id,segment.revision);
 const excerpt=randomUUID();await node.store.ingest({id:excerpt,deviceId:'fixture-device',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-09-20T00:00:00Z',durationMs:0,ocrText:text});
 node.store.db.prepare('INSERT INTO file_evidence_links(parent_id,capture_id) VALUES(?,?)').run(parent.id,excerpt);
 inspect=async reader=>{
  const scope={deviceId:'fixture-device'};
  const [raw,chunks,materialEvidence,catalog,search,timeline,memories,segments,items,history,excerptEvidence]=await Promise.all([
   reader.evidence({ids:[parent.id],...scope}),reader.fileChunks!({id:parent.id,...scope}),reader.evidence({ids:[record.id],...scope}),reader.materialCatalog!(scope),reader.search({query:'PRIVATE_GENERATED_ANCHOR',...scope}),reader.timeline(scope),reader.memories!({id:memory.id,...scope}),reader.segments!({id:segmentRef,...scope}),reader.sourceItems!({sourceId:'generated-files',...scope}),reader.sourceHistory!({id:parent.id,...scope}),reader.evidence({ids:[excerpt],...scope}),
  ]);
  let materialText='';try{materialText=(await reader.materialRead!({ref:material.ref,...scope})).text;}catch(error){assert.match(String(error),/Material not found/);}
  return {raw:raw.length,chunks:chunks.length,materialEvidence:materialEvidence.length,catalog:catalog.items.length,search:search.length,timeline:Array.isArray(timeline)?timeline.length:timeline.items.length,memories:memories.items.length,segments:segments.items.length,items:items.items.length,history:history.length,excerpt:excerptEvidence.length,materialText};
 };
 const localSettings={...node.modelSettings.current(),provider:'custom' as const,protocol:'openai-completions' as const,baseUrl:'http://127.0.0.1:1234/v1',model:'fixture-local',reasoningEffort:'auto' as const,apiKey:'',allowUnauthenticatedLocal:true};
 assert.equal(usesLocalModel({...localSettings,provider:'codex',protocol:'codex-app-server'}),false,'local Codex transport does not mean local model execution');
 await node.modelSettings.updateProfile('local',{revision:node.modelSettings.view().revision,name:'Generated local model',settings:localSettings});
 await Promise.all([node.agent.query({question:'Generated read check',modelProfileId:'default'}),node.agent.query({question:'Generated read check',modelProfileId:'local'})]);
 const remote=calls.find(c=>c.model==='fixture-remote')!.views,local=calls.find(c=>c.model==='fixture-local')!.views;
 assert.deepEqual(remote,{raw:0,chunks:0,materialEvidence:0,catalog:0,search:0,timeline:0,memories:0,segments:0,items:0,history:0,excerpt:0,materialText:''});
 for(const key of ['raw','chunks','materialEvidence','catalog','search','timeline','memories','segments','items','history','excerpt'])assert.ok(Number(local[key])>0,key);
 assert.match(String(local.materialText),/PRIVATE_GENERATED_ANCHOR/);
 assert.ok(node.featureServices.evidenceReader.memorySelection().evidenceIds.every(id=>!anchors.includes(id)));
 const localPolicy=new EvidenceExposurePolicy([],()=>true);
 assert.ok(node.featureServices.evidenceReader.memorySelection({},20000,localPolicy).evidenceIds.includes(record.id));
 assert.throws(()=>node.memoryPipeline.create({evidenceIds:anchors}),/not allowed|not ready/);
 const localJob=node.memoryPipeline.create({evidenceIds:anchors,modelProfileId:'local'});assert.ok(localJob.totalBatches>0);node.memoryPipeline.cancel(localJob.id);
 const priorCalls=calls.length;await assert.rejects(node.agent.query({question:'Generated fixed evidence',evidenceIds:[record.id]}),/Local-only/);assert.equal(calls.length,priorCalls);
 const owner=await node.app.inject({url:'/api/captures/'+chunk,headers:{authorization:'Bearer '+config.token}});assert.equal(owner.statusCode,200);assert.equal(owner.json().ocrText,text);
 node.store.db.prepare('UPDATE file_jobs SET local_only=0 WHERE capture_id=?').run(parent.id);
 await node.agent.query({question:'Generated explicit central access'});assert.ok(Number(calls.at(-1)!.views.materialEvidence)>0,'current privacy state is checked without waiting for material rebuild');
 node.store.db.prepare('UPDATE file_jobs SET local_only=1 WHERE capture_id=?').run(parent.id);
 await node.agent.query({question:'Generated privacy restoration'});assert.deepEqual(calls.at(-1)!.views,remote);
 node.store.db.prepare('UPDATE file_jobs SET local_only=0 WHERE capture_id=?').run(parent.id);
 let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),held=new Promise<void>(resolve=>release=resolve);
 inspect=async()=>{enter();await held;return {};};
 const inFlight=node.memoryPipeline.create({evidenceIds:anchors}),running=node.memoryPipeline.run(inFlight.id);await entered;
 node.store.db.prepare('UPDATE file_jobs SET local_only=1 WHERE capture_id=?').run(parent.id);release();
 const finished=await running;assert.notEqual(finished.status,'completed');assert.equal(finished.memoryIds.length,0);
 assert.equal(node.store.db.prepare('SELECT COUNT(*) n FROM memory_checkpoints').get()!.n,0);
 await assert.rejects(node.memoryPipeline.retry(inFlight.id),/not allowed|not ready/);
 node.store.db.prepare('UPDATE file_jobs SET local_only=0 WHERE capture_id=?').run(parent.id);
 const gate=node.featureServices.agentGate,limit=gate.snapshot().limit;
 let unblock!:()=>void,allEntered!:()=>void,count=0;const blocked=new Promise<void>(resolve=>unblock=resolve),full=new Promise<void>(resolve=>allEntered=resolve);
 const occupying=Array.from({length:limit},()=>gate.run(async()=>{if(++count===limit)allEntered();await blocked;}));await full;
 const beforeQueued=calls.length,queued=node.agent.query({question:'Generated queued evidence',evidenceIds:[record.id]});
 try{assert.equal(gate.snapshot().waiting,1);node.store.db.prepare('UPDATE file_jobs SET local_only=1 WHERE capture_id=?').run(parent.id);}
 finally{unblock();}
 await Promise.all(occupying);await assert.rejects(queued,/Local-only/);assert.equal(calls.length,beforeQueued,'privacy is checked again after queue admission');
});
