import {authorizeFixtureModels,fixtureTopicResult} from './fixtures/model-authorization.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout,setImmediate} from 'node:timers/promises';
import {Store,sha256} from '../src/store.js';
import {ImportAttributionStore} from '../src/import-attribution.js';
import {ImportStore} from '../src/imports.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {ProcessingRuntime} from '../src/processing-runtime.js';
import {memoryEvidenceFingerprint} from '../src/memory.js';
import {ContentStorageService} from '../src/content-storage.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {MemoryWorkMember} from '../src/memory-work-contract.js';
import {generatedMemoryOutput} from './fixtures/memory-planning.js';

const original={externalId:'entry',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',title:'Generated entry',text:'I planned a walk. The visitor said, "I prefer staying home."'} as const;
const note='  This diary is mine. The visitor and quoted AI remain separate actors.\nUse only the original narrator scope.  ';
function fixture(t:TestContext,encrypted=false){
  const directory=mkdtempSync(join(tmpdir(),'mote-import-context-'));let store=new Store(directory,{dataKey:'ab'.repeat(32),contentEncryptionEnabled:encrypted});
  const cleanup:Array<()=>Promise<void>>=[];t.after(async()=>{for(const close of cleanup.reverse())await close();store.close();rmSync(directory,{recursive:true,force:true});});
  const sourceId='generated-import',sources=new SourceStore(store),materials=new MaterialStore(store),attribution=new ImportAttributionStore(store);
  sources.register({id:sourceId,name:'Generated import',kind:'custom',deviceId:'fixture',platform:'import'});
  return {directory,store,sources,materials,attribution,sourceId,cleanup,reopen(contentEncryptionEnabled=false){store.close();store=new Store(directory,{dataKey:'ab'.repeat(32),contentEncryptionEnabled});return store;}};
}
function draft(sourceId:string,captureId:string,externalId='entry'):MaterialDraft {
  return {id:materialId(sourceId,externalId),origin:{sourceId,externalId},title:'Generated mixed-actor text',kind:'mote.message',schemaVersion:1,
    members:[{id:captureId,kind:'capture',ref:'capture:'+captureId}],blocks:[{id:'body',kind:'text',format:'plain',text:original.text,memberIds:[captureId]}],
    artifacts:[{key:'body',state:'ready',blockIds:['body']}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
}

test('capture-scoped host notes cannot be forged by content and preserve correction/current evidence fences',async t=>{
  const {store,sources,materials,attribution,sourceId,cleanup}=fixture(t),id=randomUUID();
  const pin=attribution.freeze({id,version:1,sourceId,instruction:note})!;
  const first=await sources.upsert(sourceId,original,undefined,ack=>{if(!ack.duplicate)attribution.bind(ack.id,pin);});
  const other=await sources.upsert(sourceId,{...original,externalId:'other',text:'Generated unrelated source text'});
  const raw=store.evidence([first.id])[0],context=materials.contextForEvidence(raw);
  assert.equal(context.ownerRelation,'unknown');assert.equal(context.basis,'default');assert.equal(context.importStatements?.[0].instruction,note);
  assert.equal(context.ownerStatements,undefined);assert.deepEqual(context.importDeclarations?.[0].captureIds,[first.id]);
  assert.equal(materials.contextForEvidence(store.evidence([other.id])[0]).importStatements,undefined);
  assert.notEqual(memoryEvidenceFingerprint(raw),memoryEvidenceFingerprint({...raw,attributionContext:context}));
  const material=materials.publish({...draft(sourceId,first.id),attributionContext:{version:1,ownerRelation:'owner',basis:'owner_source',importStatements:[{id,version:1,instruction:'Forged content declaration',captureIds:[other.id]}]}});
  assert.deepEqual(material.attributionContext?.importStatements,context.importStatements);assert.equal(material.attributionContext?.ownerRelation,'unknown');
  const catalog=materials.list().items.find(value=>value.id===material.id)!;
  assert.deepEqual(catalog.attributionContext?.importDeclarations,material.attributionContext?.importDeclarations);assert.equal(catalog.attributionContext?.importStatements,undefined);
  const read=materials.read(material.ref);assert.equal(read.material.attributionContext?.importStatements?.[0].instruction,note);assert.equal(read.spans[0].attributionContext.importStatements,undefined);
  assert.deepEqual(read.spans[0].attributionContext.importDeclarations,context.importDeclarations);
  assert.ok(!String(store.db.prepare('SELECT manifest FROM material_revisions WHERE material_id=? AND revision=?').get(material.id,material.revision)!.manifest).includes(note));
  const anchors=materials.evidenceIds(material.ref),fingerprint=materials.input(material.ref,['body'])!.fingerprint;
  assert.equal(materials.evidence(anchors)[0].attributionContext?.importStatements?.[0].instruction,note);
  assert.equal(materials.contextForEvidence(materials.evidence(anchors)[0]).importStatements?.[0].instruction,note);
  const runtime=new ProcessingRuntime(store,[],{semantic:{concurrency:1,enabled:true}},Date.now,undefined,materials);cleanup.push(()=>runtime.close());
  runtime.registry.register({id:'generated.context-fence',version:'1',lane:'semantic',async process(input){
    assert.equal(input.observations[0].attributionContext?.importStatements?.[0].instruction,note);
    materials.correctContext(material.id,material.revision,'third_party');return [{kind:'generated',text:'Late generated result',metadata:{}}];
  }});
  const job=runtime.enqueue([{name:'late',processor:'generated.context-fence',inputs:[first.id]}]).late;await runtime.tick();
  assert.notEqual(runtime.view().jobs.find(value=>value.id===job)?.state,'succeeded');
  const corrected=materials.get(material.id)!;assert.equal(corrected.attributionContext?.ownerRelation,'third_party');assert.equal(corrected.attributionContext?.importStatements?.[0].instruction,note);
  assert.notEqual(materials.input(corrected.ref,['body'])!.fingerprint,fingerprint);assert.equal(materials.get(material.ref),undefined);assert.ok(anchors.every(anchor=>!materials.isCurrentEvidence(anchor)));
  assert.equal(materials.contextForEvidence(raw).ownerRelation,'third_party');assert.equal(store.evidence([first.id])[0].ocrText,original.text);
  assert.throws(()=>attribution.freeze({id,version:1,sourceId,instruction:'Changed frozen context'}),{statusCode:409});
});

test('compiled declaration lineage reads freshly bind originals, rollback, deletion and reopened storage',async t=>{
  const f=fixture(t),{store,sources,attribution,sourceId}=f,id=randomUUID(),pin=attribution.freeze({id,version:1,sourceId,instruction:note})!;
  const originalCapture=await sources.upsert(sourceId,original),other=await sources.upsert(sourceId,{...original,externalId:'other'});
  const prepare=store.db.prepare.bind(store.db);let lineagePrepares=0;
  store.db.prepare=sql=>{if(sql.startsWith('WITH RECURSIVE declaration_originals(id) AS ('))lineagePrepares++;return prepare(sql);};
  assert.deepEqual(attribution.identities([originalCapture.id]),[]);
  attribution.bind(originalCapture.id,pin);
  assert.deepEqual(attribution.identities([originalCapture.id]),[{...pin,captureIds:[originalCapture.id]}]);
  assert.deepEqual(attribution.identities([other.id]),[],'parameters cannot retain the previous original');
  store.db.exec('BEGIN IMMEDIATE');store.db.prepare('DELETE FROM capture_import_declarations WHERE capture_id=?').run(originalCapture.id);
  assert.deepEqual(attribution.identities([originalCapture.id]),[],'transactional removal is immediately visible');
  store.db.exec('ROLLBACK');await setImmediate();
  assert.deepEqual(attribution.identities([originalCapture.id]),[{...pin,captureIds:[originalCapture.id]}],'a later call rereads rollback state');
  store.db.exec('CREATE INDEX declaration_statement_fixture ON import_owner_declarations(source_id)');
  assert.deepEqual(attribution.identities([originalCapture.id]),[{...pin,captureIds:[originalCapture.id]}]);
  assert.equal(lineagePrepares,1,'the fixed query compiles once, without retaining its results');
  const reopened=f.reopen(),fresh=new ImportAttributionStore(reopened);
  assert.throws(()=>attribution.identities([originalCapture.id]),'old compiled handles cannot survive their closed connection');
  assert.deepEqual(fresh.identities([originalCapture.id]),[{...pin,captureIds:[originalCapture.id]}]);
  reopened.delete(originalCapture.id);assert.deepEqual(fresh.identities([originalCapture.id]),[]);
});

test('real import duplicates retain the first context through restart and deleted import history',async t=>{
  const {directory,store,sources,materials,cleanup}=fixture(t),files=new ArchivedFileStore(store);
  const runtime={prepare:async({workspace,inputPaths}:{workspace:string;inputPaths:string[]})=>{writeFileSync(join(workspace,'records.jsonl'),JSON.stringify({item:original,evidencePaths:inputPaths})+'\n');return {summary:'Generated exact original'};}};
  const imports=new ImportStore(store,files,sources,runtime),request={files:[{name:'generated.custom',dataBase64:Buffer.from(original.text).toString('base64')}]};
  cleanup.push(()=>imports.stop());const first=await imports.create({...request,instruction:note});await imports.prepare(first.id);const done=await imports.confirm(first.id);
  const capture=store.evidence(done.captureIds)[0],firstMaterial=materials.publish(draft(done.sourceId,capture.id));
  const duplicate=await imports.create({...request,instruction:'The text belongs to a visitor; this newer note must not replace earlier scope.'});await imports.prepare(duplicate.id);const again=await imports.confirm(duplicate.id);
  assert.equal(again.sourceId,done.sourceId);assert.equal(again.progress.duplicates,1);assert.equal(again.progress.imported,0);assert.deepEqual(again.captureIds,[]);
  assert.equal(materials.get(firstMaterial.id)?.revision,firstMaterial.revision);assert.equal(materials.contextForEvidence(capture).importStatements?.[0].instruction,note);
  const restored=new ImportStore(store,files,sources,runtime);cleanup.push(()=>restored.stop());assert.equal((await restored.confirm(first.id)).progress.imported,1);
  assert.equal(imports.delete(first.id).retainedSharedSource,true);assert.equal(materials.contextForEvidence(capture).importStatements?.[0].instruction,note);
  assert.equal(store.db.prepare('SELECT count(*) n FROM import_owner_declarations').get()!.n,2);
  // The duplicate's unbound note is removed with its own history. The original
  // capture then disappears because no remaining import references the source.
  assert.equal(restored.delete(duplicate.id).retainedSharedSource,false);
  assert.equal(store.evidence([capture.id]).length,0);assert.equal(store.db.prepare('SELECT count(*) n FROM import_owner_declarations').get()!.n,0);
  assert.ok(directory);
});

test('portable restore preserves exact note scope without intake grants and rejects divergent proof atomically',async t=>{
  const {store,sources,materials,attribution,sourceId}=fixture(t),id=randomUUID(),pin=attribution.freeze({id,version:3,sourceId,instruction:note})!;
  const receipt=await sources.upsert(sourceId,original,undefined,result=>attribution.bind(result.id,pin)),material=materials.publish(draft(sourceId,receipt.id));
  const directory=mkdtempSync(join(tmpdir(),'mote-import-context-restore-')),target=new Store(directory);t.after(()=>{target.close();rmSync(directory,{recursive:true,force:true});});
  const archive=store.exportArchive(2_000_000);await target.importArchive(archive);
  const restored=new MaterialStore(target);assert.deepEqual(restored.get(material.id)?.attributionContext,material.attributionContext);
  assert.equal(restored.contextForEvidence(target.evidence([receipt.id])[0]).importStatements?.[0].instruction,note);
  assert.equal(target.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='memory_input_authorizations'").get()!.n,0);
  const altered=structuredClone(archive);altered.materials!.importAttribution!.declarations[0].instruction='Changed portable note';
  await assert.rejects(target.importArchive(altered),/checksum mismatch/);
  assert.deepEqual(restored.get(material.id)?.attributionContext,material.attributionContext);
  store.delete(receipt.id);assert.equal(store.db.prepare('SELECT count(*) n FROM capture_import_declarations').get()!.n,0);assert.equal(store.db.prepare('SELECT count(*) n FROM import_owner_declarations').get()!.n,0);
});

test('portable import rejects unbound private declarations and rolls back original and context restoration',async t=>{
  const {store,sources,materials,attribution,sourceId}=fixture(t),pin=attribution.freeze({id:randomUUID(),version:1,sourceId,instruction:note})!;
  const receipt=await sources.upsert(sourceId,original,undefined,result=>attribution.bind(result.id,pin)),material=materials.publish(draft(sourceId,receipt.id));
  const archive=store.exportArchive(2_000_000),altered=structuredClone(archive);
  const unbound={id:randomUUID(),version:1,sourceId,instruction:'Generated private note without any original capture'};
  altered.materials!.importAttribution!.declarations.push({...unbound,fingerprint:sha256(JSON.stringify(unbound))});
  const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
  const {checksum:_,...body}=altered.materials!;altered.materials!.checksum=sha256(JSON.stringify(canonical(body)));
  const directory=mkdtempSync(join(tmpdir(),'mote-import-context-unbound-restore-')),target=new Store(directory);t.after(()=>{target.close();rmSync(directory,{recursive:true,force:true});});
  const restored=new MaterialStore(target);
  await assert.rejects(target.importArchive(altered),/missing its original capture scope/);
  assert.equal(target.db.isTransaction,false);
  for(const table of ['captures','source_connections','source_versions','source_heads','material_heads','import_owner_declarations','capture_import_declarations'])
    assert.equal(target.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,0,`${table} must roll back`);
  await target.importArchive(archive);
  assert.equal(target.evidence([receipt.id])[0].ocrText,original.text);
  assert.deepEqual(restored.get(material.id)?.attributionContext,material.attributionContext);
  assert.equal(target.db.prepare('SELECT count(*) n FROM import_owner_declarations').get()!.n,1);
  assert.equal(target.db.prepare('SELECT count(*) n FROM capture_import_declarations').get()!.n,1);
});

test('encrypted note conversion and restart follow managed private storage policy',async t=>{
  const f=fixture(t),id=randomUUID(),pin=f.attribution.freeze({id,version:1,sourceId:f.sourceId,instruction:note})!;
  const ack=await f.sources.upsert(f.sourceId,original,undefined,result=>f.attribution.bind(result.id,pin));
  assert.match(String(f.store.db.prepare('SELECT json FROM import_owner_declarations').get()!.json),/^json:/);
  f.store.contentEncryption.setEnabled(true);let store=f.reopen(true),materials=new MaterialStore(store);
  assert.match(String(store.db.prepare('SELECT json FROM import_owner_declarations').get()!.json),/^aes:/);
  assert.equal(materials.contextForEvidence(store.evidence([ack.id])[0]).importStatements?.[0].instruction,note);
  store.contentEncryption.setEnabled(false);
  const service=new ContentStorageService(store,new FileStore(store,new SourceStore(store)),new ArchivedFileStore(store));service.start();
  for(let i=0;i<1000&&service.snapshot().job.state==='running';i++)await setImmediate();assert.equal(service.snapshot().job.failed,0);
  assert.match(String(store.db.prepare('SELECT json FROM import_owner_declarations').get()!.json),/^json:/);
  store=f.reopen();materials=new MaterialStore(store);assert.equal(materials.contextForEvidence(store.evidence([ack.id])[0]).importStatements?.[0].instruction,note);
  store.delete(ack.id);assert.equal(store.db.prepare('SELECT count(*) n FROM import_owner_declarations').get()!.n,0);
});

test('a combined Material keeps separate original scopes and replacement text does not inherit old import context',async t=>{
  const {store,sources,materials,attribution,sourceId}=fixture(t),firstPin=attribution.freeze({id:randomUUID(),version:1,sourceId,instruction:note})!,secondPin=attribution.freeze({id:randomUUID(),version:1,sourceId,instruction:'Generated visitor transcript; no speaker identity is established.'})!;
  const first=await sources.upsert(sourceId,original,undefined,result=>attribution.bind(result.id,firstPin)),second=await sources.upsert(sourceId,{...original,externalId:'visitor'},undefined,result=>attribution.bind(result.id,secondPin));
  const base={...draft(sourceId,first.id),members:[{id:'generated-local-member',kind:'capture',ref:'capture:'+first.id}],blocks:[{id:'body',kind:'text' as const,format:'plain',text:original.text,memberIds:['generated-local-member']}]},both=materials.publish({...base,members:[...base.members,{id:second.id,kind:'capture',ref:'capture:'+second.id}],blocks:[...base.blocks,{id:'visitor',kind:'text',format:'plain',text:original.text,memberIds:[second.id]}]});
  assert.equal(both.attributionContext?.importStatements?.length,2);
  const spans=materials.read(both.ref).spans;assert.equal(spans.length,2);assert.deepEqual(spans[0].attributionContext.importDeclarations?.map(value=>value.id),[firstPin.id]);assert.deepEqual(spans[1].attributionContext.importDeclarations?.map(value=>value.id),[secondPin.id]);
  assert.deepEqual(materials.contextForEvidence(store.evidence([first.id])[0]).importStatements?.map(statement=>statement.id),[firstPin.id]);
  assert.deepEqual(materials.contextForEvidence(store.evidence([second.id])[0]).importStatements?.map(statement=>statement.id),[secondPin.id]);
  for(const anchor of materials.evidenceIds(both.ref))assert.equal(materials.contextForEvidence(materials.evidence([anchor])[0]).importStatements?.length,1);
  const replacement=await sources.upsert(sourceId,{...original,revision:'2',text:'Generated replacement with unknown authorship'});
  const current=materials.publish({...draft(sourceId,replacement.id),blocks:[{id:'body',kind:'text',format:'plain',text:'Generated replacement with unknown authorship',memberIds:[replacement.id]}]},{expectedRevision:materials.get(base.id)!.revision});
  assert.equal(current.attributionContext?.importStatements,undefined);assert.equal(current.attributionContext?.ownerRelation,'unknown');
});

test('media intake and excerpt lineage preserve exact capture statements without mapping equal speaker labels',async t=>{
  const {store,sources,materials,cleanup}=fixture(t),files=new ArchivedFileStore(store),fileStore=new FileStore(store,sources);
  const imports=new ImportStore(store,files,sources,{fileStore,prepare:async()=>{throw Error('Generated media-only intake must not use a parsing model');}});
  cleanup.push(()=>imports.stop());const first=await imports.create({instruction:note,processing:'automatic',files:[{name:'first.mp3',dataBase64:Buffer.from('ID3generated first media').toString('base64')}]});
  const done=await imports.prepare(first.id);assert.equal(done.status,'completed');assert.equal(done.captureIds.length,1);
  const originalId=done.captureIds[0],artifactId=randomUUID(),chunkId=randomUUID();
  // Generated transcript fixtures exercise host lineage, not real ASR accuracy.
  store.db.prepare('INSERT INTO file_artifacts(id,capture_id,kind,created_at,config_revision,json,current) VALUES(?,?,?,?,?,?,1)').run(artifactId,originalId,'transcript','2026-10-01T00:00:00Z','generated',JSON.stringify({complete:true,coverage:'full'}));
  store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,start_ms,end_ms,text,metadata) VALUES(?,?,?,?,?,?,?)').run(chunkId,artifactId,originalId,0,1000,'SPEAKER00: I planned a walk.',JSON.stringify({speaker:'SPEAKER00'}));
  const second=await imports.create({instruction:'Generated visitor recording; speaker labels do not identify the owner.',processing:'automatic',files:[{name:'second.mp3',dataBase64:Buffer.from('ID3generated second media').toString('base64')}]});
  const other=await imports.prepare(second.id);assert.equal(other.status,'completed');
  const raw=store.evidence([originalId])[0],context=materials.contextForEvidence({...raw,id:chunkId,ocrText:'SPEAKER00: I planned a walk.'});
  assert.equal(context.importStatements?.[0].instruction,note);assert.deepEqual(context.importStatements?.[0].captureIds,[originalId]);assert.equal(context.ownerRelation,'unknown');
  assert.equal(materials.contextForEvidence(store.evidence(other.captureIds)[0]).importStatements?.[0].instruction,other.instruction);
  const excerpt=await sources.upsert(done.sourceId,{...original,externalId:'excerpt',text:'SPEAKER00: I planned a walk.'});
  store.db.prepare('INSERT INTO file_evidence_links VALUES(?,?)').run(originalId,excerpt.id);
  assert.equal(materials.contextForEvidence(store.evidence([excerpt.id])[0]).importStatements?.[0].id,first.id);
  const repeated=await imports.create({instruction:'Different later context',processing:'automatic',files:[{name:'first.mp3',dataBase64:Buffer.from('ID3generated first media').toString('base64')}]});
  const duplicate=await imports.prepare(repeated.id);assert.equal(duplicate.progress.duplicates,1);assert.equal(duplicate.progress.imported,0);
  assert.equal(materials.contextForEvidence(raw).importStatements?.[0].instruction,note);
});

test('HTTP import publishes a fully declared prefix before completion; restart does not grant it again',{timeout:60000},async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-import-context-http-'));
  const config:Config={dataDir:directory,token:'generated-import-context-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:2_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
  let node:Awaited<ReturnType<typeof buildApp>>,importId='',calls=0,reviewedPrefix=false,release!:()=>void;
  const paused=new Promise<void>(resolve=>release=resolve),prefix='  Generated exact owner context\n',instruction=prefix+'甲'.repeat(12000-prefix.length-2)+'  ',upsert=SourceStore.prototype.upsert;
  assert.equal(instruction.length,12000);
  t.mock.method(SourceStore.prototype,'upsert',async function(this:SourceStore,...args:Parameters<SourceStore['upsert']>){if(args[1].externalId==='generated-tail')await paused;return upsert.apply(this,args);});
  const dependencies={backgroundWorker:true,prepareImport:async({workspace,inputPaths}:{workspace:string;inputPaths:string[]})=>{
    writeFileSync(join(workspace,'records.jsonl'),['generated-prefix','generated-tail'].map(externalId=>JSON.stringify({item:{...original,externalId},evidencePaths:inputPaths})).join('\n')+'\n');return {summary:'Generated independent original items'};
  },agent:{configured:true,close:async()=>{},query:async(input:import('@mote/agent').QueryInput)=>{
    const topic=fixtureTopicResult(input);if(topic)return topic;calls++;const members=(input.taskContext?.memoryWork as {members?:MemoryWorkMember[]}|undefined)?.members;assert.ok(members?.length);
    for(const member of members){const context=member.attributionContext;assert.equal(context.ownerRelation,'unknown');assert.equal(context.basis,'default');assert.equal(context.importStatements?.[0].instruction,instruction);assert.deepEqual(context.importStatements?.[0].captureIds,[member.inputKey]);}
    if(input.traceContext?.phase==='review'&&!reviewedPrefix){reviewedPrefix=true;assert.equal(node.imports.get(importId).status,'importing');release();}
    return {answer:generatedMemoryOutput(input),citations:[],trace:[],runId:'generated-context-'+calls};
  }}};
  node=await buildApp(config,dependencies);await node.app.ready();await authorizeFixtureModels(node);t.after(async()=>{release();await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const headers={authorization:'Bearer '+config.token},created=await node.app.inject({method:'POST',url:'/api/imports',headers,payload:{instruction,files:[{name:'generated.custom',dataBase64:Buffer.from(original.text).toString('base64')}]}});
  assert.equal(created.statusCode,202,created.body);importId=created.json().id;
  for(let i=0;i<200&&node.imports.get(importId).status!=='awaiting_confirmation';i++)await setTimeout(20);
  assert.equal(node.imports.get(importId).status,'awaiting_confirmation');
  const confirmation=await node.app.inject({method:'POST',url:`/api/imports/${importId}/confirm`,headers});assert.equal(confirmation.statusCode,202,confirmation.body);
  for(let i=0;i<400;i++){const job=node.imports.get(importId);if(job.status==='completed'&&node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n===2)break;assert.notEqual(job.status,'failed',job.error);await setTimeout(100);}
  assert.equal(reviewedPrefix,true);const completed=node.imports.get(importId);assert.equal(completed.status,'completed');assert.equal(node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,2);
  assert.equal(calls,4);const before=calls;await node.app.close();node=await buildApp(config,{...dependencies,backgroundWorker:false});await node.app.ready();
  for(const capture of node.store.evidence(completed.captureIds))assert.equal(node.materials.contextForEvidence(capture).importStatements?.[0].instruction,instruction);
  await node.materialOrganizer.tick(100);await node.sourcePipelines.tick(100);await node.sourcePipelines.drainMemory(node.memoryPipeline,true,100);
  assert.equal(calls,before);assert.equal(node.store.db.prepare('SELECT count(*) n FROM capture_import_declarations').get()!.n,2);
});
