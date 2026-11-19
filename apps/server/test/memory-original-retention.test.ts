import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';
import {readCurrentMemoryPage} from '../src/current-memory.js';
import {EvidenceStore as Store,sha256} from '../src/evidence-store.js';
import {EvidenceExposurePolicy} from '../src/evidence-exposure.js';
import {releasedMemoryOriginal} from '../src/memory-original-retention.js';
import {materialId} from '../src/materials.js';
import type {QueryInput} from '@mote/agent';
import {parseAnswer} from '@mote/agent';
import {authorizeFixtureModels} from './fixtures/model-authorization.js';

async function fixture(t:TestContext,query?: (input:QueryInput)=>Promise<any>){
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-original-release-')),token='generated-owner-'+randomUUID();
 const config:ConfigurationPlatformOptions={path:(directory)+'/mote.yaml',privateCredential:{token:token,tokenPath:'fixture'},initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:2_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{enabled:false}}};
 const modelErrors:string[]=[];
 const boot=()=>buildApp({...config,...(query?{model:'generated'}:{})},{backgroundWorker:false,agent:{configured:Boolean(query),query:query?async input=>{try{return await query(input);}catch(error){modelErrors.push(error instanceof Error?error.stack??error.message:String(error));throw error;}}:async()=>{throw Error('No model in original-release fixtures');},async close(){}}});let node=await boot();
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+token},request=async(url:string,method='GET',payload?:unknown)=>node.app.inject({url,method:method as 'GET',headers,...(payload===undefined?{}:{payload})});
 const id=randomUUID(),text='The generated owner prefers quiet mornings for careful work.';
 const capture={id,deviceId:'generated-device',deviceName:'Generated device',platform:'import',source:'note',capturedAt:'2026-10-01T09:00:00Z',durationMs:0,appId:'generated.notes',appName:'Generated notes',ocrText:text};
 assert.equal((await request('/api/captures','POST',capture)).statusCode,201);
 async function publish(originalId:string){const memories=node.featureServices.evidenceReader.memories,original=memories.readEvidence([originalId])[0]!;assert.ok(original);const result=fixtureMemoryResult(memories,{answer:JSON.stringify({memories:[{title:'Generated preference',statement:'The owner prefers quiet mornings ['+originalId+']',uncertainty:'A generated preference, revisable by its owner.',evidenceIds:[originalId]}]}),citations:[{id:originalId,capturedAt:original.capturedAt,appName:original.appName,excerpt:original.ocrText}],trace:[],runId:randomUUID()}),draft=memories.extract(result,'generated').items[0]!;const published=await request('/api/memories/'+draft.id+'/publish','POST',{version:draft.version});assert.equal(published.statusCode,200,published.body);return {memory:published.json(),result};}
 const first=await publish(id);
 return {get node(){return node;},config,modelErrors,request,id,capture,...first,publish,async restart(){await node.app.close();node=await boot();}};
}

async function checkPortableAfterForget(store:Store){const directory=mkdtempSync(join(tmpdir(),'mote-release-forget-portable-')),copy=new Store(directory);try{await copy.importArchive(store.exportArchive(2_000_000));}finally{copy.close();rmSync(directory,{recursive:true,force:true});}}

test('owner original release preserves the published Memory for current use while original evidence remains unavailable after restart',async t=>{
 const f=await fixture(t);assert.equal((await readCurrentMemoryPage(f.node.featureServices.evidenceReader,{kind:'all'},{level:'detail'})).items.length,1);
 const removed=await f.request('/api/captures/'+f.id,'DELETE');assert.equal(removed.statusCode,200,removed.body);assert.deepEqual(removed.json(),{deleted:1});
 const retained=await f.request('/api/memories/'+f.memory.id);assert.equal(retained.statusCode,200,retained.body);assert.equal(retained.json().status,'published');
 assert.equal(retained.json().evidence[0].originalAvailable,false);assert.equal(retained.json().evidence[0].quote,undefined);assert.equal(retained.json().evidence[0].offset,undefined);
 const current=await readCurrentMemoryPage(f.node.featureServices.evidenceReader,{kind:'all'},{level:'detail'});assert.equal(current.items.length,1);assert.equal(current.items[0].id,f.memory.id);assert.equal(f.node.featureServices.evidenceReader.evidence(['capture:'+f.id]).length,0);
 await f.restart();assert.equal((await readCurrentMemoryPage(f.node.featureServices.evidenceReader,{kind:'all'},{level:'detail'})).items[0]?.id,f.memory.id);assert.equal((await f.request('/api/captures/'+f.id)).statusCode,404);
});

test('released Memory keeps device/time/app/collection scope and current exposure checks, and never delivers a raw quote to the Agent',async t=>{
 const f=await fixture(t);await f.request('/api/captures/'+f.id,'DELETE');const reader=f.node.featureServices.evidenceReader,agent=reader.agent({diagnostics:f.node.diagnostics});
 const inScope=await agent.memories!({id:f.memory.id,deviceId:f.capture.deviceId,after:'2026-10-01T00:00:00Z',before:'2026-10-02T00:00:00Z',includeEvidence:true});assert.equal(inScope.items.length,1);assert.deepEqual(inScope.sourceSpans,[]);assert.equal(inScope.sourceCoverage?.partial,true);
 for(const scope of [{deviceId:'different'},{after:'2026-10-02T00:00:00Z'},{before:'2026-10-01T00:00:00Z'},{appId:'different'},{collection:'activity' as const}])assert.equal((await reader.memoryPageAsync({...scope,level:'detail'})).items.length,0);
 const denied=reader.agent({diagnostics:f.node.diagnostics,exposurePolicy:new EvidenceExposurePolicy([{sourceKind:'note',allow:false}])});assert.equal((await denied.memories!({id:f.memory.id})).items.length,0);assert.deepEqual(await agent.evidence({ids:[f.id]}),[]);
 const metadata=JSON.stringify(releasedMemoryOriginal(f.node.store,f.id));assert.equal(metadata.includes(f.capture.ocrText),false);assert.equal(metadata.includes('quote'),false);
});

test('an explicit Memory delete after original release retains its rejection identity through restart and cannot be replayed into a publication',async t=>{
 const f=await fixture(t);await f.request('/api/captures/'+f.id,'DELETE');const removed=await f.request('/api/memories/'+f.memory.id,'DELETE');assert.equal(removed.statusCode,200,removed.body);assert.equal(removed.json().deleted,1);
 const intent=f.node.featureServices.evidenceReader.memories.deletions.export()[0];assert.ok(intent?.originKeys.length);assert.deepEqual(intent.originalTexts,[]);await f.restart();assert.equal((await f.request('/api/memories/'+f.memory.id)).statusCode,404);assert.equal(f.node.featureServices.evidenceReader.memories.deletions.export()[0]!.id,intent.id);assert.throws(()=>f.node.featureServices.evidenceReader.memories.extract(f.result,'generated'),{statusCode:409});
 assert.equal((await f.request('/api/captures','POST',f.capture)).statusCode,410,'the existing deleted-event replay fence is unchanged');
});

test('deleting the conclusion before releasing its original does not cascade away the refusal to regenerate it',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/api/memories/'+f.memory.id,'DELETE')).statusCode,200);const before=f.node.featureServices.evidenceReader.memories.deletions.export()[0]!;await f.request('/api/captures/'+f.id,'DELETE');await f.restart();const after=f.node.featureServices.evidenceReader.memories.deletions.export()[0]!;assert.equal(after.id,before.id);assert.deepEqual(after.originKeys,before.originKeys);assert.deepEqual(after.originalTexts,[]);assert.deepEqual(after.dependencies,before.dependencies);
});

for(const route of ['capture-chunk','file-history'] as const)test(`${route} ordinary owner release preserves complete published Memory, while later file forgetting revokes it without losing future-version semantics`,async t=>{
 const f=await fixture(t),sourceId='generated-file-source';f.node.sources.register({id:sourceId,name:'Generated file',kind:'local-files',deviceId:'generated-files',platform:'android',retention:'archive',enabled:true});
 const upload=async(revision:string,previousRevision:string|null)=>{const bytes=Buffer.from('Generated complete file '+revision),begun=f.node.files.begin({sourceId,previousRevision,item:{externalId:'generated-file',revision,observedAt:'2026-10-01T10:00:00Z',kind:'file',layer:'original',text:'',mimeType:'text/plain'},relativePath:'generated.txt',sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});f.node.files.part(begun.uploadId,0,bytes,()=>{});return f.node.files.commit(begun.uploadId,()=>{});};
 const file=await upload('v1',null),artifact=randomUUID(),chunk=randomUUID();f.node.store.db.prepare('INSERT INTO file_artifacts(id,capture_id,kind,created_at,config_revision,json,current) VALUES(?,?,?,?,?,?,1)').run(artifact,file.id,'text','2026-10-01T10:00:00Z','generated',JSON.stringify({complete:true}));f.node.store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,text,metadata) VALUES(?,?,?,?,?)').run(chunk,artifact,file.id,'Generated author prefers quiet mornings.','{}');
 const {memory}=await f.publish(chunk),projection=f.node.materials.publish({id:materialId(sourceId,'generated-projection'),kind:'mote.note',schemaVersion:1,title:'Generated file projection',origin:{sourceId,externalId:'generated-projection'},members:[{id:file.id,kind:'capture',ref:'capture:'+file.id}],blocks:[{id:'body',kind:'text',format:'plain',text:'Generated file-associated owner preference.',memberIds:[file.id]}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}}),projected=await f.publish(f.node.materials.evidenceIds(projection.ref)[0]);assert.ok((await readCurrentMemoryPage(f.node.featureServices.evidenceReader,{kind:'selection',sourceIds:[sourceId]},{level:'detail'})).items.some(value=>value.id===memory.id));
 const removed=await f.request(route==='capture-chunk'?'/api/captures/'+chunk:'/api/files/'+file.id,'DELETE');assert.equal(removed.statusCode,200,removed.body);assert.equal((await f.request('/api/memories/'+memory.id)).statusCode,200);assert.ok((await readCurrentMemoryPage(f.node.featureServices.evidenceReader,{kind:'selection',sourceIds:[sourceId]},{level:'detail'})).items.some(value=>value.id===memory.id));
 assert.equal(f.node.files.readableFile(chunk),undefined);
 if(route==='file-history'){
  f.node.store.db.exec(`CREATE TEMP TRIGGER generated_forget_failure BEFORE DELETE ON memories WHEN old.id='${memory.id}' BEGIN SELECT RAISE(ABORT,'generated forget failure');END;`);
  assert.throws(()=>f.node.files.forget(file.id),/generated forget failure/);assert.equal(f.node.files.syncHead(sourceId,'generated-file').forgotten,false);assert.equal((await f.request('/api/memories/'+memory.id)).statusCode,200);assert.ok(releasedMemoryOriginal(f.node.store,chunk)?.memoryFingerprints[memory.id]);f.node.store.db.exec('DROP TRIGGER generated_forget_failure');
 }
 await assert.rejects(()=>upload('v1',null),{statusCode:410});const future=await upload('v2','v1');assert.ok(future.id,'ordinary release still accepts a genuinely future version');assert.ok(!(await readCurrentMemoryPage(f.node.featureServices.evidenceReader,{kind:'selection',sourceIds:[sourceId]},{level:'detail'})).items.some(value=>value.id===memory.id),'a changed current source head still withdraws the former version from current Memory use');
 f.node.files.forget(file.id);assert.equal((await f.request('/api/memories/'+memory.id)).statusCode,404);assert.equal((await f.request('/api/memories/'+projected.memory.id)).statusCode,404);assert.ok(f.node.store.db.prepare("SELECT json FROM memory_provider_evidence_revocations WHERE json_type(json,'$.releasedOriginal')='object'").all().every(row=>!JSON.parse(String(row.json)).releasedOriginal.identity.origins.includes(file.id)),'file forgetting also clears released formal aliases through the existing immutable version lineage');await checkPortableAfterForget(f.node.store);assert.equal(f.node.files.syncHead(sourceId,'generated-file').forgotten,true);await f.restart();assert.equal((await f.request('/api/memories/'+memory.id)).statusCode,404);
});

test('the actual authored Material alias releases the original but preserves its published Memory; material privacy forgetting still finds it later',async t=>{
 const f=await fixture(t);await f.node.materialOrganizer.tick(100);const material=f.node.materials.list({kind:'mote.note'}).items.find(value=>value.origin.externalId===f.id)!;assert.ok(material);const anchor=f.node.materials.evidenceIds(material.ref,['record'])[0]!,{memory}=await f.publish(anchor);
 const removed=await f.request('/api/captures/'+anchor,'DELETE');assert.equal(removed.statusCode,200,removed.body);assert.equal((await f.request('/api/memories/'+memory.id)).statusCode,200);assert.ok((await readCurrentMemoryPage(f.node.featureServices.evidenceReader,{kind:'all'},{level:'detail'})).items.some(value=>value.id===memory.id));assert.equal(f.node.materials.get(material.ref),undefined);
 f.node.materials.forget(material.id);assert.equal((await f.request('/api/memories/'+memory.id)).statusCode,404);assert.equal((await f.request('/api/memories/'+f.memory.id)).statusCode,200,'the independent raw-supported card is outside the forgotten Material');await checkPortableAfterForget(f.node.store);await f.restart();assert.equal((await f.request('/api/memories/'+memory.id)).statusCode,404);
});

test('the real owner query and Agent bridge use retained Memory without acquiring an original citation or bypassing current permission',async t=>{
 let calls=0;const f=await fixture(t,async input=>{
  calls++;assert.ok(input.openingMemories?.some(value=>value.id===f.memory.id));assert.ok(input.contextEvidenceDependencies?.ids.includes(f.id));
  const {startBridge}=await import('../../../packages/agent/dist/bridge.js');const bridge=await startBridge(f.node.featureServices.evidenceReader.agent({diagnostics:f.node.diagnostics}),input,6);
  try{const response=await fetch(bridge.url+'/memories',{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify({id:f.memory.id,includeEvidence:true})});assert.equal(response.status,200);const packet=await response.json();assert.equal(packet.data.items[0].evidence[0].originalAvailable,false);assert.deepEqual(packet.data.sourceEvidence,[]);assert.equal(packet.data.sourceCoverage.partial,true);assert.throws(()=>parseAnswer(JSON.stringify({answer:'A fabricated exact original quotation ['+f.id+']',citationIds:[f.id]}),bridge.records));return {...parseAnswer(JSON.stringify({answer:'Generated advice based on retained scoped Memory.',citationIds:[]}),bridge.records),trace:[],runId:randomUUID(),evidenceDependencies:bridge.evidenceDependencies};}finally{await bridge.close();}
 });
 await authorizeFixtureModels(f.node);assert.equal((await f.request('/api/captures/'+f.id,'DELETE')).statusCode,200);const answer=await f.request('/api/query','POST',{question:'Give generated advice from available Memory.'});assert.equal(answer.statusCode,200,answer.body);assert.equal(calls,1);assert.deepEqual(answer.json().citations,[]);
 const reader=f.node.featureServices.evidenceReader;assert.equal(reader.contextDependenciesAllowed([f.id]),false,'a released original alone is not a new context grant');assert.equal(reader.contextDependenciesAllowed([f.memory.id,f.id]),true);assert.equal(reader.contextDependenciesAllowed([f.memory.id,f.id],new EvidenceExposurePolicy([{sourceKind:'note',allow:false}])),false);
 await f.request('/api/memories/'+f.memory.id,'DELETE');assert.equal(reader.contextDependenciesAllowed([f.memory.id,f.id]),false);
});

for(const deleted of [false,true])test(`portable released-original metadata ${deleted?'keeps rejection intent':'restores only stale Memory'} without original read or publication authority`,async t=>{
 const f=await fixture(t);if(deleted)await f.request('/api/memories/'+f.memory.id,'DELETE');await f.request('/api/captures/'+f.id,'DELETE');const archive=f.node.store.exportArchive(2_000_000);assert.equal(archive.memoryOriginalReleases.length,1);assert.equal(JSON.stringify(archive.memoryOriginalReleases).includes(f.capture.ocrText),false);
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-portable-release-')),destination=structuredClone(f.config);
 destination.path=join(directory,'mote.yaml');destination.initialDocument!.storage!.dataDir=directory;
 const target=await buildApp(destination,{backgroundWorker:false,agent:{configured:false,async query(){throw Error('No model in portable retention fixture');},async close(){}}});t.after(async()=>{await target.app.close();rmSync(directory,{recursive:true,force:true});});await target.store.importArchive(archive);
 assert.equal(target.store.evidence([f.id]).length,0);assert.equal((await readCurrentMemoryPage(target.featureServices.evidenceReader,{kind:'all'},{level:'detail'})).items.length,0);
 if(deleted){assert.equal(target.featureServices.evidenceReader.memories.deletions.export()[0]!.id,f.node.featureServices.evidenceReader.memories.deletions.export()[0]!.id);}else{const read=await target.app.inject({url:'/api/memories/'+f.memory.id,headers:{authorization:'Bearer '+f.config.privateCredential!.token}});assert.equal(read.statusCode,200,read.body);assert.equal(read.json().status,'stale');assert.equal(read.json().evidence[0].originalAvailable,false);assert.equal((await target.featureServices.evidenceReader.agent({diagnostics:target.diagnostics}).memories!({id:f.memory.id})).items.length,0);const publish=await target.app.inject({method:'POST',url:'/api/memories/'+f.memory.id+'/publish',headers:{authorization:'Bearer '+f.config.privateCredential!.token},payload:{version:f.memory.version}});assert.equal(publish.statusCode,409,publish.body);}
 const invalid=structuredClone(archive);(invalid.memoryOriginalReleases[0].release.record as any).ocrText='Generated forbidden original body';await assert.rejects(()=>target.store.importArchive(invalid));
});

test('a failed original deletion rolls back its retention receipt, Memory and rejection changes together',async t=>{
 const f=await fixture(t);f.node.store.db.exec(`CREATE TEMP TRIGGER generated_release_failure BEFORE DELETE ON captures WHEN old.id='${f.id}' BEGIN SELECT RAISE(ABORT,'generated release failure');END;`);assert.notEqual((await f.request('/api/captures/'+f.id,'DELETE')).statusCode,200);assert.equal(releasedMemoryOriginal(f.node.store,f.id),undefined);assert.equal(f.node.featureServices.evidenceReader.memories.get(f.memory.id).status,'published');assert.equal((await f.request('/api/captures/'+f.id)).statusCode,200);f.node.store.db.exec('DROP TRIGGER generated_release_failure');assert.equal((await f.request('/api/captures/'+f.id,'DELETE')).statusCode,200);
});


test('an owner correction after original release withdraws the old claim and its saved dependency context without reviving that original',async t=>{
 const f=await fixture(t);await f.request('/api/captures/'+f.id,'DELETE');const corrected=await f.request('/api/memories/'+f.memory.id+'/correct','POST',{version:f.memory.version,title:'Generated owner correction',statement:'Quiet mornings apply only to the generated writing task.',uncertainty:'Explicitly revised generated preference.'});assert.equal(corrected.statusCode,200,corrected.body);const next=corrected.json();assert.notEqual(next.id,f.memory.id);
 const current=await readCurrentMemoryPage(f.node.featureServices.evidenceReader,{kind:'all'},{level:'detail'});assert.ok(current.items.some(value=>value.id===next.id));assert.ok(!current.items.some(value=>value.id===f.memory.id));assert.equal(f.node.featureServices.evidenceReader.contextDependenciesAllowed([f.memory.id,f.id]),false);assert.equal(f.node.featureServices.evidenceReader.contextDependenciesAllowed([next.id,...next.evidenceIds]),true);assert.equal((await f.request('/api/captures/'+f.id)).statusCode,404);
 assert.equal((await f.request('/api/memories/'+next.id,'DELETE')).statusCode,200);assert.ok(f.node.featureServices.evidenceReader.memories.deletions.export()[0]!.dependencies.includes(f.id),'forgetting a corrected conclusion keeps both former and correction identities');await f.restart();assert.equal((await f.request('/api/memories/'+next.id)).statusCode,404);assert.equal(f.node.featureServices.evidenceReader.contextDependenciesAllowed([f.memory.id,f.id]),false);
});

test('the real owner source-forget command resolves released source identity after the original is gone and fences restart and old output',async t=>{
 const f=await fixture(t),sourceId='generated-retained-source',pipelineId='generated.retained-records',kind='generated.retained';
 const unregister=f.node.sourcePipelines.registry.register({id:pipelineId,version:'1',sourceKinds:[kind],storage:'records',index:'none',modelInput:'material'});t.after(unregister);
 f.node.sources.capabilities.register(kind,{lifecycle:'one-shot',discovery:'explicit-selection',listening:'none',readOriginal:'none',synchronization:'import-only',externalWrite:false});
 f.node.sources.register({id:sourceId,name:'Generated retained source',kind,deviceId:'generated-source-device',platform:'import',enabled:true});assert.equal((await f.request('/api/source-pipelines/'+sourceId,'PUT',{pipelineId,settleSeconds:0})).statusCode,200);
 const original=await f.node.sources.upsert(sourceId,{externalId:'generated-source-message',revision:'1',kind:'message',layer:'original',observedAt:'2026-10-01T09:00:00Z',text:'The generated owner prefers scoped written decisions.'}),published=await f.publish(original.id);await f.request('/api/captures/'+original.id,'DELETE');assert.ok((await readCurrentMemoryPage(f.node.featureServices.evidenceReader,{kind:'selection',sourceIds:[sourceId]},{level:'detail'})).items.some(value=>value.id===published.memory.id));
 const forgotten=await f.request('/api/source-pipelines/'+sourceId,'DELETE');assert.equal(forgotten.statusCode,200,forgotten.body);assert.equal(f.node.sources.getSource(sourceId).enabled,false);assert.equal(releasedMemoryOriginal(f.node.store,original.id),undefined);assert.equal((await f.request('/api/memories/'+published.memory.id)).statusCode,404);await f.restart();assert.equal((await f.request('/api/memories/'+published.memory.id)).statusCode,404);assert.throws(()=>f.node.featureServices.evidenceReader.memories.extract(published.result,'generated'),{statusCode:409});
});


for(const raw of [false,true])test(`an in-flight owner query using ${raw?'Memory plus delivered original':'only Memory'} ${raw?'rejects':'retains'} a late plain answer after ordinary original release`,async t=>{
 let delivered=false,calls=0;const f=await fixture(t,async input=>{
  calls++;
  const {startBridge}=await import('../../../packages/agent/dist/bridge.js');const bridge=await startBridge(f.node.featureServices.evidenceReader.agent({diagnostics:f.node.diagnostics}),input,6);
  try{
   const tool=async(name:string,args:unknown)=>{const result=await fetch(bridge.url+'/'+name,{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify(args)});assert.equal(result.status,200);return result.json();};
   const memory=await tool('memories',{id:f.memory.id});assert.equal(memory.data.items[0].id,f.memory.id);
   if(raw){const original=await tool('evidence',{ids:[f.id]});assert.equal(original.data[0].ocrText,f.capture.ocrText);delivered=true;}
   if(calls===1)assert.equal((await f.request('/api/captures/'+f.id,'DELETE')).statusCode,200);
   return {...parseAnswer(JSON.stringify({answer:'Generated late plain advice without any original quotation or citation.',citationIds:[]}),bridge.records),trace:[],runId:randomUUID(),evidenceDependencies:bridge.evidenceDependencies,originalEvidenceDependencies:{version:1,complete:true,ids:[]}};
  }finally{await bridge.close();}
 });
 await authorizeFixtureModels(f.node);const response=await f.request('/api/query','POST',{question:'Use the generated available Memory and evidence as needed.'});assert.equal(response.statusCode,raw?409:200,response.body+' '+JSON.stringify(f.node.store.db.prepare("SELECT json_extract(json,'$.status') status,json_extract(json,'$.error') error FROM query_runs").all()));assert.equal(delivered,raw);assert.equal((await f.request('/api/captures/'+f.id)).statusCode,404);assert.ok((await readCurrentMemoryPage(f.node.featureServices.evidenceReader,{kind:'all'},{level:'detail'})).items.some(value=>value.id===f.memory.id));
 if(!raw){
  assert.deepEqual(response.json().originalEvidenceDependencies,{version:1,complete:true,ids:[]});const conversationId=response.json().conversationId,turn=f.node.conversations.get(conversationId).turns[0];assert.ok(turn.historyEvidenceDependencies?.complete);assert.ok(turn.historyEvidenceDependencies?.ids.includes(f.memory.id));assert.ok(!turn.historyEvidenceDependencies?.ids.includes(f.id));
  await f.restart();const follow=await f.request('/api/query','POST',{question:'Continue from the generated retained Memory.',conversationId});assert.equal(follow.statusCode,200,follow.body);assert.equal(calls,2);assert.deepEqual(follow.json().originalEvidenceDependencies,{version:1,complete:true,ids:[]});
  assert.equal((await f.request('/api/memories/'+f.memory.id,'DELETE')).statusCode,200);assert.ok(f.node.conversations.get(conversationId).turns.every(value=>!value.result||value.evidenceDeleted),'explicit forgetting still withdraws saved Memory-only context');
 }
});


test('an actual attached image read is recorded only after pixel acknowledgement and cannot borrow Memory lineage after file release',async t=>{
 let target:{id:string;memoryId:string},pixels=false;const delivered:string[]=[];const f=await fixture(t,async input=>{
  const {startBridge}=await import('../../../packages/agent/dist/bridge.js');const bridge=await startBridge(f.node.featureServices.evidenceReader.agent({diagnostics:f.node.diagnostics,allowQueryImages:()=>true}),{...input,onEvidence:records=>{delivered.push(...records.map(record=>record.id));input.onEvidence?.(records);}},6);
  try{
   const tool=async(name:string,args:unknown)=>{const response=await fetch(bridge.url+'/'+name,{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify(args)});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;};
   await tool('memories',{id:target.memoryId});const metadata=await tool('read_image',{id:target.id,view:'metadata'});assert.equal(metadata.image,undefined);assert.equal(delivered.includes(target.id),false);assert.equal(bridge.records.has(target.id),false);
   const image=await tool('read_image',{id:target.id,view:'full'});assert.ok(image.image.data);assert.ok(image.imageDelivery);assert.equal(delivered.includes(target.id),false);bridge.imageDelivery(image.imageDelivery,true);pixels=true;assert.ok(delivered.includes(target.id));
   await f.request('/api/files/'+target.id,'DELETE');return {answer:'Generated late plain answer without an image citation.',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:bridge.evidenceDependencies,originalEvidenceDependencies:{version:1,complete:true,ids:[]}};
  }finally{await bridge.close();}
 });
 const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#224466'}}).png().toBuffer(),sourceId='generated-image-source';f.node.sources.register({id:sourceId,name:'Generated image source',kind:'upload',deviceId:'generated-image-device',platform:'import',retention:'archive'});const begun=f.node.files.begin({sourceId,item:{externalId:'image',revision:'1',observedAt:'2026-10-01T10:00:00Z',kind:'file',layer:'original',text:'',mimeType:'image/png'},sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});f.node.files.part(begun.uploadId,0,bytes,()=>{});const file=await f.node.files.commit(begun.uploadId,()=>{}),artifact=randomUUID(),chunk=randomUUID();
 f.node.store.db.prepare('INSERT INTO file_artifacts(id,capture_id,kind,created_at,config_revision,json,current) VALUES(?,?,?,?,?,?,1)').run(artifact,file.id,'text','2026-10-01T10:00:00Z','generated',JSON.stringify({complete:true}));f.node.store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,text,metadata) VALUES(?,?,?,?,?)').run(chunk,artifact,file.id,'Generated image-associated scoped owner preference.','{}');const published=await f.publish(chunk);target={id:file.id,memoryId:published.memory.id};await authorizeFixtureModels(f.node);await f.node.perception.save({revision:f.node.configService.revision,settings:{...f.node.perception.settings(),allowQueryImages:true}});
 const answer=await f.request('/api/query','POST',{question:'Use generated Memory and inspect the attached image.',attachmentIds:[file.id]});assert.equal(answer.statusCode,409,answer.body+' '+JSON.stringify(f.modelErrors));assert.equal(pixels,true);assert.equal((await f.request('/api/memories/'+target.memoryId)).statusCode,200);
});

for(const raw of [false,true])test(`explicit Memory forgetting rejects an in-flight ${raw?'Memory and original':'Memory-only'} answer even when the Agent claims an empty original receipt`,async t=>{
 const f=await fixture(t,async input=>{
  const {startBridge}=await import('../../../packages/agent/dist/bridge.js');const bridge=await startBridge(f.node.featureServices.evidenceReader.agent({diagnostics:f.node.diagnostics}),input,6);
  try{const tool=async(name:string,args:unknown)=>{const response=await fetch(bridge.url+'/'+name,{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify(args)});assert.equal(response.status,200);return response.json();};await tool('memories',{id:f.memory.id});if(raw)await tool('evidence',{ids:[f.id]});assert.equal((await f.request('/api/memories/'+f.memory.id,'DELETE')).statusCode,200);return {answer:'Generated late answer must not use a forgotten conclusion.',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:bridge.evidenceDependencies,originalEvidenceDependencies:{version:1,complete:true,ids:[]}};}finally{await bridge.close();}
 });await authorizeFixtureModels(f.node);assert.notEqual((await f.request('/api/query','POST',{question:'Use generated Memory.'})).statusCode,200);
});

test('the host overwrites a forged empty Agent original receipt with actual delivered original identities',async t=>{
 const f=await fixture(t,async input=>{
  const {startBridge}=await import('../../../packages/agent/dist/bridge.js');const bridge=await startBridge(f.node.featureServices.evidenceReader.agent({diagnostics:f.node.diagnostics}),input,6);
  try{for(const [name,args]of [['memories',{id:f.memory.id}],['evidence',{ids:[f.id]}]] as const){const response=await fetch(bridge.url+'/'+name,{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify(args)});assert.equal(response.status,200);await response.json();}return {answer:'Generated plain answer with no citation.',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:bridge.evidenceDependencies,originalEvidenceDependencies:{version:1,complete:true,ids:[]}};}finally{await bridge.close();}
 });await authorizeFixtureModels(f.node);const result=await f.request('/api/query','POST',{question:'Read generated Memory and the original.'});assert.equal(result.statusCode,200,result.body);assert.deepEqual(result.json().originalEvidenceDependencies,{version:1,complete:true,ids:[f.id]});const snapshot=f.node.conversations.historyContext(f.node.conversations.get(result.json().conversationId));assert.deepEqual(f.node.conversations.historyOriginalDependencies(snapshot).ids,[f.id]);
});


for(const raw of [false,true])test(`withdrawing a selected source read grant rejects an in-flight ${raw?'Memory and original':'Memory-only'} answer while retained owner archives stay intact`,async t=>{
 const sourceId='generated-query-scope';let target:{id:string;memoryId:string};const f=await fixture(t,async input=>{
  const {startBridge}=await import('../../../packages/agent/dist/bridge.js');const bridge=await startBridge(f.node.featureServices.evidenceReader.agent({diagnostics:f.node.diagnostics}),input,6);
  try{const tool=async(name:string,args:unknown)=>{const response=await fetch(bridge.url+'/'+name,{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify(args)});assert.equal(response.status,200);return response.json();};await tool('memories',{id:target.memoryId});if(raw)await tool('evidence',{ids:[target.id]});assert.equal((await f.request('/api/sources/'+sourceId,'PATCH',{enabled:false})).statusCode,200);return {answer:'Generated late answer after read grant withdrawal.',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:bridge.evidenceDependencies};}finally{await bridge.close();}
 });f.node.sources.register({id:sourceId,name:'Generated read scope',kind:'custom',deviceId:'generated-scope-device',platform:'import',enabled:true});const original=await f.node.sources.upsert(sourceId,{externalId:'message',revision:'1',observedAt:'2026-10-01T09:00:00Z',kind:'message',layer:'original',text:'Generated scoped owner preference.'}),published=await f.publish(original.id);target={id:original.id,memoryId:published.memory.id};await authorizeFixtureModels(f.node);const conversationId=(await f.request('/api/conversations/main')).json().id,admitted=await f.request('/api/conversations/messages','POST',{conversationId,clientRequestId:randomUUID(),question:'Use only the selected generated source.',scope:{kind:'selection',sourceIds:[sourceId]}});assert.equal(admitted.statusCode,202,admitted.body);let message:any;const deadline=Date.now()+10000;do{message=(await f.request('/api/conversations/'+conversationId+'/messages/'+admitted.json().id)).json();if(['completed','failed','cancelled'].includes(message.status))break;await new Promise(resolve=>setTimeout(resolve,10));}while(Date.now()<deadline);assert.equal(message.status,'failed',JSON.stringify(message)+' '+JSON.stringify(f.modelErrors));assert.equal((await f.request('/api/captures/'+target.id)).statusCode,200);assert.equal((await f.request('/api/memories/'+target.memoryId)).statusCode,200);
});

for(const release of ['archive','capture-then-archive'] as const)test(`completed Memory-only history survives ${release}, while raw, acknowledged-image and unknown roles remain strict`,async t=>{
 let mode:'memory'|'raw'|'image'|'unknown'='memory',fileId='',chunkId='',fileMemory:any,originalsReleased=false,acknowledged=false;
 const markers={memory:'Generated saved Memory-only answer.',raw:'Generated saved raw-bearing answer.',image:'Generated saved acknowledged-image answer.',unknown:'Generated saved answer with unknown original roles.'};
 const f=await fixture(t,async input=>{
  if(mode==='unknown')return {answer:markers.unknown,citations:[],trace:[],runId:randomUUID(),evidenceDependencies:input.contextEvidenceDependencies,originalEvidenceDependencies:{version:1,complete:true,ids:[]}};
  const {startBridge}=await import('../../../packages/agent/dist/bridge.js'),bridge=await startBridge(f.node.featureServices.evidenceReader.agent({diagnostics:f.node.diagnostics,allowQueryImages:()=>true}),input,6);
  try{
   const tool=async(name:string,args:unknown)=>{const response=await fetch(bridge.url+'/'+name,{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify(args)}),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
   for(const card of [f.memory,fileMemory]){const value=await tool('memories',{id:card.id});assert.equal(value.data.items[0]?.id,card.id);if(originalsReleased){assert.equal(value.data.items[0].evidence[0].originalAvailable,false);assert.equal(value.data.items[0].evidence[0].quote,undefined);}}
   if(mode==='raw'){const value=await tool('evidence',{ids:[chunkId]});assert.equal(value.data[0].id,chunkId);assert.match(value.data[0].ocrText,/Generated complete file owner/);}
   if(mode==='image'){const value=await tool('read_image',{id:fileId,view:'full'});assert.ok(value.image.data);assert.ok(value.imageDelivery);assert.equal(bridge.records.has(fileId),false);bridge.imageDelivery(value.imageDelivery,true);acknowledged=true;assert.equal(bridge.records.has(fileId),true);}
   return {answer:markers[mode],citations:[],trace:bridge.trace,runId:randomUUID(),evidenceDependencies:bridge.evidenceDependencies,imageReadReceipts:bridge.imageReadReceipts,originalEvidenceDependencies:{version:1,complete:true,ids:[]}};
  }finally{await bridge.close();}
 });
 const sourceId='generated-completed-role-file';assert.equal((await f.request('/api/sources','POST',{id:sourceId,name:'Generated completed role file',kind:'local-files',deviceId:'generated-role-device',platform:'macos',retention:'archive',enabled:true})).statusCode,200);
 const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#224466'}}).png().toBuffer(),fileRequest=(url:string,method:'POST'|'PUT',payload:unknown)=>f.node.app.inject({url,method,headers:{authorization:'Bearer '+f.config.privateCredential!.token,'x-mote-ingress-version':'2',...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})},payload});
 const admitted=await fileRequest('/api/file-sync/v1/uploads','POST',{sourceId,previousRevision:null,item:{externalId:'generated-completed-role-image',revision:'v1',observedAt:'2026-10-01T10:00:00Z',kind:'file',layer:'original',text:'',title:'generated.png',mimeType:'image/png'},relativePath:'generated.png',sizeBytes:bytes.length,sha256:sha256(bytes)});assert.equal(admitted.statusCode,200,admitted.body);const uploadId=admitted.json().uploadId;
 assert.equal((await fileRequest('/api/file-sync/v1/uploads/'+uploadId+'/parts/0','PUT',bytes)).statusCode,200);const committed=await fileRequest('/api/file-sync/v1/uploads/'+uploadId+'/commit','POST',{});assert.equal(committed.statusCode,200,committed.body);fileId=committed.json().id;chunkId=randomUUID();const artifact=randomUUID();
 f.node.store.db.prepare('INSERT INTO file_artifacts(id,capture_id,kind,created_at,config_revision,json,current) VALUES(?,?,?,?,?,?,1)').run(artifact,fileId,'text','2026-10-01T10:00:00Z','generated',JSON.stringify({complete:true}));f.node.store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,text,metadata) VALUES(?,?,?,?,?)').run(chunkId,artifact,fileId,'Generated complete file owner prefers scoped work periods.','{}');fileMemory=(await f.publish(chunkId)).memory;
 await authorizeFixtureModels(f.node);await f.node.perception.save({revision:f.node.configService.revision,settings:{...f.node.perception.settings(),allowQueryImages:true}});
 const conversations=new Map<string,string>();
 for(const selected of ['memory','raw','image','unknown'] as const){mode=selected;const response=await f.request('/api/query','POST',{question:'Generated completed '+selected+' context.',...(selected==='image'?{attachmentIds:[fileId]}:{})});assert.equal(response.statusCode,200,response.body+' '+f.modelErrors.join('\n'));const result=response.json(),conversationId=result.conversationId;conversations.set(selected,conversationId);
  if(selected==='memory'){assert.deepEqual(result.originalEvidenceDependencies,{version:1,complete:true,ids:[]});assert.deepEqual(new Set(f.node.conversations.get(conversationId).turns[0].historyEvidenceDependencies!.ids),new Set([f.memory.id,fileMemory.id]));}
  else if(selected==='raw'){assert.equal(result.originalEvidenceDependencies.complete,true);assert.ok(result.originalEvidenceDependencies.ids.includes(chunkId));assert.ok(result.originalEvidenceDependencies.ids.includes(fileId));}
  else if(selected==='image'){assert.ok(acknowledged);assert.ok(result.originalEvidenceDependencies.ids.includes(fileId));assert.equal(result.imageReadReceipts.length,1);}
  else assert.equal(result.originalEvidenceDependencies.complete,false,'an Agent-supplied empty set cannot upgrade an unobserved delivery receipt');
 }
 assert.equal(new Set(conversations.values()).size,4);
 assert.equal((await f.request('/api/captures/'+f.id,'DELETE')).statusCode,200);
 if(release==='capture-then-archive'){assert.equal((await f.request('/api/captures/'+chunkId,'DELETE')).statusCode,200);assert.ok(!f.node.conversations.get(conversations.get('memory')!).turns[0].evidenceDeleted);}
 else{
  f.node.store.db.exec(`CREATE TEMP TRIGGER generated_completed_history_failure BEFORE DELETE ON captures WHEN old.id='${fileId}' BEGIN SELECT RAISE(ABORT,'generated completed history failure');END;`);assert.notEqual((await f.request('/api/files/'+fileId,'DELETE')).statusCode,200);for(const id of conversations.values())assert.ok(!f.node.conversations.get(id).turns[0].evidenceDeleted,'a failed original release rolls back history invalidation');assert.equal((await f.request('/api/files/'+fileId+'/content')).statusCode,200);f.node.store.db.exec('DROP TRIGGER generated_completed_history_failure');
 }
 const removed=await f.request('/api/files/'+fileId,'DELETE');assert.equal(removed.statusCode,200,removed.body);originalsReleased=true;
 for(const card of [f.memory,fileMemory]){const detail=await f.request('/api/memories/'+card.id);assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().status,'published');assert.equal(detail.json().evidence[0].originalAvailable,false);assert.equal(detail.json().evidence[0].quote,undefined);}
 const preserved=f.node.conversations.get(conversations.get('memory')!);assert.ok(!preserved.turns[0].evidenceDeleted,'positive Memory-only history survives ordinary ancestor release');assert.equal(preserved.turns[0].result!.answer,markers.memory);assert.deepEqual(new Set(preserved.turns[0].historyEvidenceDependencies!.ids),new Set([f.memory.id,fileMemory.id]));
 for(const role of ['raw','image','unknown']){const history=f.node.conversations.get(conversations.get(role)!);assert.equal(history.turns[0].evidenceDeleted,true,role+' history retains its strict archive-deletion policy');assert.doesNotMatch(JSON.stringify(history),new RegExp(markers[role as keyof typeof markers]));assert.equal(f.node.conversations.historyContext(history).turns.length,0);}
 await f.restart();mode='memory';assert.equal((await f.request('/api/captures/'+f.id)).statusCode,404);assert.equal((await f.request('/api/files/'+fileId+'/content')).statusCode,404);const continued=await f.request('/api/query','POST',{question:'Continue the preserved generated Memory-only answer.',conversationId:conversations.get('memory')});assert.equal(continued.statusCode,200,continued.body+' '+f.modelErrors.join('\n'));assert.deepEqual(continued.json().originalEvidenceDependencies,{version:1,complete:true,ids:[]});
 for(const role of ['raw','image','unknown'])assert.equal(f.node.conversations.historyContext(f.node.conversations.get(conversations.get(role)!)).turns.length,0);
 f.node.files.forget(fileId);assert.equal((await f.request('/api/memories/'+fileMemory.id)).statusCode,404);assert.equal((await f.request('/api/memories/'+f.memory.id)).statusCode,200);assert.ok(f.node.conversations.get(conversations.get('memory')!).turns.every(turn=>!turn.result||turn.evidenceDeleted),'explicit file forgetting still withdraws every answer using that Memory');await f.restart();assert.equal(f.node.conversations.historyContext(f.node.conversations.get(conversations.get('memory')!)).turns.length,0);
});
