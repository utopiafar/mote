import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {sourceItemSchema,captureSchema} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {SourceContextStore} from '../src/source-context.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {FileStore} from '../src/files.js';
import {ProcessingRuntime} from '../src/processing-runtime.js';
import {ContentStorageService} from '../src/content-storage.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

const description='  Generated phone calls in which I am usually one participant.\nThe other speaker’s views are theirs; uncertain speakers stay unknown.  ';
const item={externalId:'generated-call',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',title:'Generated conversation',text:'Generated speaker 1: I plan to walk. Generated speaker 2: I prefer staying in.'} as const;
function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-source-context-'));let store=new Store(directory,{dataKey:'ab'.repeat(32)});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const sources=new SourceStore(store),materials=new MaterialStore(store),sourceId='generated-files';
  sources.register({id:sourceId,name:'Generated old audio folder',kind:'local-files',deviceId:'generated-device',platform:'android',retention:'archive',initialSync:'new_only',enabled:false});
  return {directory,store,sources,materials,sourceId,reopen(){store.close();store=new Store(directory,{dataKey:'ab'.repeat(32)});return store;}};
}
function draft(sourceId:string,captureId:string,externalId=item.externalId):MaterialDraft{
  return {id:materialId(sourceId,externalId),kind:'mote.message',schemaVersion:1,title:item.title,origin:{sourceId,externalId},
    members:[{id:captureId,kind:'capture',ref:'capture:'+captureId}],blocks:[{id:'body',kind:'text',format:'plain',text:item.text,memberIds:[captureId]}],
    artifacts:[{key:'body',state:'ready',blockIds:['body']}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
}
const reseal=(archive:{materials?:unknown})=>{const section=archive.materials as Record<string,unknown>,{checksum:_,...body}=section;const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;section.checksum=sha256(JSON.stringify(canonical(body)));};

test('source context preserves old settings and exact private prose; collector/draft content cannot grant a declaration',async t=>{
  const {sources,store,materials,sourceId}=fixture(t),old=sources.getSource(sourceId);
  assert.deepEqual(sources.contexts.current(sourceId),{sourceId,version:0,description:''});assert.equal(sources.contexts.identity(sourceId),undefined);
  const saved=sources.updateContext(sourceId,{expectedVersion:0,description});assert.equal(saved.version,1);assert.equal(saved.description,description);
  const pin=sources.contexts.identity(sourceId)!;assert.equal(pin.fingerprint,saved.fingerprint);
  const current=sources.getSource(sourceId);for(const key of ['name','kind','deviceId','platform','retention','initialSync','enabled'] as const)assert.equal(current[key],old[key]);
  assert.deepEqual(current.sourceContext,{version:1,fingerprint:saved.fingerprint});
  assert.ok(!JSON.stringify(current).includes(description));assert.ok(!String(store.db.prepare('SELECT json FROM source_connections WHERE id=?').get(sourceId)!.json).includes(description));
  assert.throws(()=>sources.register({id:'generated-forged',name:'Generated forged source',kind:'custom',platform:'import',deviceId:'generated-device',sourceContext:{version:1,fingerprint:saved.fingerprint}}),{statusCode:403});
  assert.equal(sourceItemSchema.safeParse({...item,sourceContext:{description}}).success,false);
  sources.update(sourceId,{enabled:true});const receipt=await sources.upsert(sourceId,item),raw=store.evidence([receipt.id])[0];
  assert.equal(captureSchema.safeParse({...raw,attributionContext:{version:1,ownerRelation:'owner',basis:'owner_source',sourceContextStatements:[{sourceId,version:1,description:'Forged statement'}]}}).success,false);
  const formal=materials.publish({...draft(sourceId,receipt.id),attributionContext:{version:1,ownerRelation:'owner',basis:'owner_source',sourceContextStatements:[{sourceId,version:1,description:'Forged statement'}]}});
  assert.equal(formal.attributionContext?.ownerRelation,'unknown');assert.equal(formal.attributionContext?.sourceContextStatements?.[0].description,description);
  assert.deepEqual(formal.attributionContext?.sourceContextDeclarations,[pin]);assert.equal(materials.contextForEvidence(raw).sourceContextStatements?.[0].description,description);
  assert.equal(materials.list().items[0].attributionContext?.sourceContextStatements,undefined);
  assert.deepEqual(materials.read(formal.ref).spans[0].attributionContext.sourceContextDeclarations,[pin]);assert.equal(materials.read(formal.ref).spans[0].attributionContext.sourceContextStatements,undefined);
  assert.equal(materials.evidence(materials.evidenceIds(formal.ref))[0].attributionContext?.sourceContextStatements?.[0].description,description);
  assert.ok(!String(store.db.prepare('SELECT manifest FROM material_revisions WHERE material_id=?').get(formal.id)!.manifest).includes(description));
  sources.register({id:'generated-unrelated',name:'Generated other source',kind:'custom',deviceId:'generated-device',platform:'import'});
  const other=await sources.upsert('generated-unrelated',item);assert.equal(materials.contextForEvidence(store.evidence([other.id])[0]).sourceContextStatements,undefined);
  assert.equal(store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='memory_input_authorizations'").get()!.n,0);
});

test('context edits apply to existing and future materials, keep corrections, fence late results and clear with a fresh version',async t=>{
  const {sources,store,materials,sourceId}=fixture(t);sources.update(sourceId,{enabled:true});
  const receipt=await sources.upsert(sourceId,item),raw=store.evidence([receipt.id])[0],first=materials.publish(draft(sourceId,receipt.id));
  const oldPayloads=store.db.prepare('SELECT * FROM material_block_payloads').all(),oldAnchors=materials.evidenceIds(first.ref);
  const next=sources.updateContext(sourceId,{expectedVersion:0,description}),current=materials.get(first.id)!;
  assert.notEqual(current.revision,first.revision);assert.equal(materials.get(first.ref),undefined);assert.ok(oldAnchors.every(id=>!materials.isCurrentEvidence(id)));
  assert.equal(current.attributionContext?.sourceContextStatements?.[0].description,description);assert.deepEqual(store.evidence([receipt.id])[0],raw);assert.deepEqual(store.db.prepare('SELECT * FROM material_block_payloads').all(),oldPayloads);
  assert.deepEqual(sources.updateContext(sourceId,{expectedVersion:0,description}),next,'lost response retry returns the acknowledged version');assert.equal(materials.get(first.id)!.revision,current.revision);
  assert.throws(()=>sources.updateContext(sourceId,{expectedVersion:0,description:'Conflicting concurrent description'}),{statusCode:409});
  const corrected=materials.correctContext(current.id,current.revision,'third_party');
  const changed=sources.updateContext(sourceId,{expectedVersion:1,description:'Generated revised call description'}),after=materials.get(first.id)!;
  assert.equal(after.attributionContext?.ownerRelation,'third_party');assert.deepEqual(after.attributionContext?.correction,corrected.attributionContext?.correction);
  assert.equal(after.attributionContext?.sourceContextDeclarations?.[0].version,2);assert.equal(sources.contexts.getAtVersion(sourceId,1,next.fingerprint)?.description,description);
  const future=await sources.upsert(sourceId,{...item,externalId:'future'}),futureMaterial=materials.publish(draft(sourceId,future.id,'future'));
  assert.deepEqual(futureMaterial.attributionContext?.sourceContextStatements,[{sourceId,version:2,description:changed.description}]);
  const runtime=new ProcessingRuntime(store,[],{},Date.now,undefined,materials);t.after(()=>runtime.close());
  runtime.registry.register({id:'fixture.source-description-race',version:'1',lane:'semantic',async process(input){
    assert.equal(input.observations[0].attributionContext?.sourceContextStatements?.[0].version,2);
    sources.updateContext(sourceId,{expectedVersion:2,description:''});return [{kind:'generated',text:'Obsolete interpretation',metadata:{}}];
  }});
  const job=runtime.enqueue([{name:'race',processor:'fixture.source-description-race',inputs:[receipt.id]}]).race;await runtime.tick();
  assert.notEqual(runtime.view().jobs.find(value=>value.id===job)?.state,'succeeded');assert.deepEqual(runtime.view().jobs.find(value=>value.id===job)?.outputs,[]);
  const cleared=sources.contexts.current(sourceId);assert.equal(cleared.version,3);assert.equal(cleared.description,'');assert.ok(cleared.fingerprint);
  assert.deepEqual(materials.get(first.id)?.attributionContext?.sourceContextStatements,[{sourceId,version:3,description:''}]);
  assert.equal(sources.contexts.getAtVersion(sourceId,2,changed.fingerprint)?.description,changed.description);
  assert.equal(store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='memory_input_authorizations'").get()!.n,0,'metadata updates do not grant historic paid work');
});

test('a failed semantic withdrawal rolls back the source declaration and its existing material revision together',async t=>{
  const {sources,store,materials,sourceId}=fixture(t);sources.update(sourceId,{enabled:true});const receipt=await sources.upsert(sourceId,item),first=materials.publish(draft(sourceId,receipt.id));
  sources.pipelines={materials} as NonNullable<SourceStore['pipelines']>;
  materials.onSourceContextChanged=()=>{throw Error('Generated withdrawal failure');};
  assert.throws(()=>sources.updateContext(sourceId,{expectedVersion:0,description}),/Generated withdrawal failure/);
  assert.equal(store.db.isTransaction,false);assert.deepEqual(sources.contexts.current(sourceId),{sourceId,version:0,description:''});assert.equal(sources.getSource(sourceId).sourceContext,undefined);
  assert.equal(store.db.prepare('SELECT count(*) n FROM source_context_declarations').get()!.n,0);assert.equal(materials.get(first.id)?.revision,first.revision);assert.ok(materials.evidenceIds(first.ref).every(id=>materials.isCurrentEvidence(id)));
});

test('default unknown description-only processing inputs retain legacy identity and fence changes before any Material exists',async t=>{
  const {sources,store,materials,sourceId}=fixture(t);sources.update(sourceId,{enabled:true});const receipt=await sources.upsert(sourceId,item);
  const runtime=new ProcessingRuntime(store,[],{},Date.now,undefined,materials);t.after(()=>runtime.close());let changeWhileRunning=false,calls=0;
  runtime.registry.register({id:'fixture.description-only-race',version:'1',lane:'semantic',async process(input){
    calls++;assert.equal(input.observations[0].attributionContext?.basis,'default');assert.equal(input.observations[0].attributionContext?.ownerRelation,'unknown');
    if(changeWhileRunning){assert.equal(input.observations[0].attributionContext?.sourceContextDeclarations?.[0].version,1);sources.updateContext(sourceId,{expectedVersion:1,description:'Generated changed while processing'});}
    return [{kind:'generated',text:'Generated interpretation',metadata:{}}];
  }});
  const enqueue=()=>runtime.enqueue([{name:'fixture',processor:'fixture.description-only-race',inputs:[receipt.id]}]).fixture,legacy=enqueue();
  const legacyJob=JSON.parse(String(store.db.prepare('SELECT json FROM processing_jobs WHERE id=?').get(legacy)!.json));
  assert.equal(legacyJob.contextInputs[0].fingerprint,sha256('null'));await runtime.tick();assert.equal(runtime.view().jobs.find(job=>job.id===legacy)?.state,'succeeded');assert.equal(enqueue(),legacy);
  sources.updateContext(sourceId,{expectedVersion:0,description:'Generated initial recording description'});const next=enqueue();assert.notEqual(next,legacy);changeWhileRunning=true;await runtime.tick();
  const stale=runtime.view().jobs.find(job=>job.id===next)!;assert.equal(stale.state,'stale');assert.equal(stale.reason,'input_changed');assert.deepEqual(stale.outputs,[]);
  assert.equal(materials.list().items.length,0);assert.equal(store.isCurrentEvidence(receipt.id),true);assert.equal(calls,2);assert.equal(store.db.prepare('SELECT count(*) n FROM context_artifacts').get()!.n,0);
});

test('source description correction retains OCR/ASR and speaker evidence without reuploading files',async t=>{
  const {sources,store,materials,sourceId}=fixture(t);sources.update(sourceId,{enabled:true});
  const files=new FileStore(store,sources),bytes=Buffer.from('GENERATED AUDIO FIXTURE'),artifactId=randomUUID(),chunkId=randomUUID();
  const upload=files.begin({sourceId,previousRevision:null,item:{...item,externalId:'audio',kind:'file',text:'',mimeType:'audio/wav'},relativePath:'generated-call.wav',sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});files.part(upload.uploadId,0,bytes,()=>{});const receipt=await files.commit(upload.uploadId,()=>{});
  store.db.prepare('INSERT INTO file_artifacts(id,capture_id,kind,created_at,config_revision,json,current) VALUES(?,?,?,?,?,?,1)').run(artifactId,receipt.id,'transcript','2026-10-01T00:00:00Z','fixture',JSON.stringify({complete:true,coverage:'full'}));
  store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,start_ms,end_ms,text,metadata) VALUES(?,?,?,?,?,?,?)').run(chunkId,artifactId,receipt.id,0,1000,'Generated transcript',JSON.stringify({speaker:'speaker-1',speakerAttribution:{name:'Generated visitor',isOwner:false}}));
  const formal=materials.publish({...draft(sourceId,receipt.id,'audio'),blocks:[{id:'body',kind:'text',format:'plain',text:'Generated transcript',memberIds:[receipt.id],evidenceIds:[chunkId]}]});
  const chunks=store.db.prepare('SELECT * FROM file_chunks').all(),artifacts=store.db.prepare('SELECT * FROM file_artifacts').all(),versions=store.db.prepare('SELECT * FROM source_versions').all();
  sources.updateContext(sourceId,{expectedVersion:0,description});
  assert.deepEqual(store.db.prepare('SELECT * FROM file_chunks').all(),chunks);assert.deepEqual(store.db.prepare('SELECT * FROM file_artifacts').all(),artifacts);assert.deepEqual(store.db.prepare('SELECT * FROM source_versions').all(),versions);
  assert.equal(materials.read(materials.get(formal.id)!.ref).text,'Generated transcript\n');assert.equal(materials.input(formal.id,['body'])?.ready,true);
});

test('portable backups retain source-only descriptions and version history; older backup preserves newer local context',async t=>{
  const {sources,store,sourceId}=fixture(t);const first=sources.updateContext(sourceId,{expectedVersion:0,description}),archive=store.exportArchive(2_000_000);
  assert.equal(archive.captures.length,0);assert.equal(archive.materials?.sourceContext?.declarations.length,1);
  const targetDirectory=mkdtempSync(join(tmpdir(),'mote-source-context-restore-')),target=new Store(targetDirectory);t.after(()=>{target.close();rmSync(targetDirectory,{recursive:true,force:true});});
  await target.importArchive(archive);const restoredSources=new SourceStore(target);assert.deepEqual(restoredSources.contexts.current(sourceId),first);
  const current=restoredSources.updateContext(sourceId,{expectedVersion:1,description:'Generated newer destination context'});
  await target.importArchive(archive);assert.deepEqual(restoredSources.contexts.current(sourceId),current);
  assert.equal(restoredSources.contexts.getAtVersion(sourceId,1,first.fingerprint)?.description,description);
  const tampered=structuredClone(archive);tampered.materials!.sourceContext!.declarations[0].description='Tampered exact owner note';reseal(tampered);
  await assert.rejects(target.importArchive(tampered),/Invalid portable source context/);assert.deepEqual(restoredSources.contexts.current(sourceId),current);
  const missing=structuredClone(archive);delete missing.materials!.sourceContext;reseal(missing);
  const emptyDirectory=mkdtempSync(join(tmpdir(),'mote-source-context-missing-')),empty=new Store(emptyDirectory);t.after(()=>{empty.close();rmSync(emptyDirectory,{recursive:true,force:true});});
  await assert.rejects(empty.importArchive(missing),/missing or changed/);assert.equal(empty.db.prepare('SELECT count(*) n FROM source_connections').get()!.n,0);
});

test('portable materials restore their exact source declaration versions without paid intake grants',async t=>{
  const {sources,store,materials,sourceId}=fixture(t);sources.update(sourceId,{enabled:true});const receipt=await sources.upsert(sourceId,item);sources.updateContext(sourceId,{expectedVersion:0,description});
  const first=materials.publish(draft(sourceId,receipt.id));sources.updateContext(sourceId,{expectedVersion:1,description:'Generated corrected metadata'});const current=materials.get(first.id)!,archive=store.exportArchive(2_000_000);
  const directory=mkdtempSync(join(tmpdir(),'mote-source-context-material-restore-')),target=new Store(directory);t.after(()=>{target.close();rmSync(directory,{recursive:true,force:true});});
  await target.importArchive(archive);const restored=new MaterialStore(target);assert.deepEqual(restored.get(current.id)?.attributionContext,current.attributionContext);assert.equal(restored.get(first.ref),undefined);
  assert.equal(new SourceContextStore(target).getAtVersion(sourceId,1)?.description,description);assert.equal(target.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='memory_input_authorizations'").get()!.n,0);
  const changed=structuredClone(archive);const manifestRow=changed.materials!.revisions.find(row=>row.revision===current.revision)!;const manifest=JSON.parse(String(manifestRow.manifest));manifest.attributionContext.sourceContextDeclarations[0].sourceId='generated-unrelated';manifestRow.manifest=JSON.stringify(manifest);reseal(changed);
  await assert.rejects(target.importArchive(changed),/unrelated or missing source scope/);assert.deepEqual(restored.get(current.id)?.attributionContext,current.attributionContext);
});

test('private source descriptions follow encryption, restart and explicit bulk decryption',async t=>{
  const f=fixture(t),saved=f.sources.updateContext(f.sourceId,{expectedVersion:0,description});
  assert.match(String(f.store.db.prepare('SELECT json FROM source_context_declarations').get()!.json),/^json:/);
  f.store.contentEncryption.setEnabled(true);let store=f.reopen();const contexts=new SourceContextStore(store);
  assert.match(String(store.db.prepare('SELECT json FROM source_context_declarations').get()!.json),/^aes:/);assert.deepEqual(contexts.current(f.sourceId),saved);
  store.contentEncryption.setEnabled(false);const service=new ContentStorageService(store,new FileStore(store,new SourceStore(store)),new ArchivedFileStore(store));service.start();
  for(let i=0;i<1000&&service.snapshot().job.state==='running';i++)await setImmediate();assert.equal(service.snapshot().job.failed,0);await service.close();
  assert.match(String(store.db.prepare('SELECT json FROM source_context_declarations').get()!.json),/^json:/);store=f.reopen();assert.deepEqual(new SourceContextStore(store).current(f.sourceId),saved);
});

test('source context HTTP accepts paired owners, enforces version conflicts and rejects non-owner control-plane access',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-source-context-http-')),config:Config={dataDir:directory,token:'generated-owner-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:10_000_000,maxExportBytes:2_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',connectors:{directory:join(directory,'connectors'),mcpEnabled:true,mcpReadToken:'generated-static-read-mcp-token-123456789',mcpWriteEnabled:true,mcpWriteToken:'generated-static-write-mcp-token-123456789',mcpWriteSourceIds:['generated-api-source']}};
  const {app}=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No live model in generated fixtures');},close:async()=>{}}});t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const owner={authorization:'Bearer '+config.token},invite=await app.inject({method:'POST',url:'/api/connections/invitations',headers:owner,payload:{serverUrl:'http://127.0.0.1:47832',label:'Generated Android'}});
  const redeem=await app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invite.json().invitation.code,deviceId:'generated-android',deviceName:'Generated phone',platform:'android'}});assert.equal(redeem.statusCode,200);
  const paired={authorization:'Bearer '+redeem.json().token};assert.equal(redeem.json().scope,'owner');
  const source={id:'generated-api-source',name:'Generated calls',kind:'local-files',platform:'android',deviceId:'generated-android',retention:'archive'};
  assert.equal((await app.inject({method:'POST',url:'/api/sources',headers:paired,payload:source})).statusCode,200);
  const url='/api/sources/'+source.id+'/context';assert.equal((await app.inject(url)).statusCode,401);
  const initial=await app.inject({url,headers:paired});assert.deepEqual(initial.json(),{sourceId:source.id,version:0,description:''});
  const first=await app.inject({method:'PATCH',url,headers:paired,payload:{expectedVersion:0,description}});assert.equal(first.statusCode,200);assert.equal(first.json().description,description);
  assert.deepEqual((await app.inject({method:'PATCH',url,headers:paired,payload:{expectedVersion:0,description}})).json(),first.json());
  assert.equal((await app.inject({method:'PATCH',url,headers:paired,payload:{expectedVersion:0,description:'Concurrent edit'}})).statusCode,409);
  assert.equal((await app.inject({method:'PATCH',url,headers:paired,payload:{expectedVersion:1,description,ownerRelation:'owner'}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/sources',headers:paired,payload:{...source,id:'forged-api-source',sourceContext:{version:1,fingerprint:first.json().fingerprint}}})).statusCode,403);
  for(const access of ['read','write']){const minted=await app.inject({method:'POST',url:'/api/connections/mcp',headers:owner,payload:{serverUrl:'http://127.0.0.1:47832',label:'Generated MCP',access}});assert.equal(minted.statusCode,200);for(const method of ['GET','PATCH'] as const){const reply=await app.inject({method,url,headers:minted.json().config.mcpServers.mote.headers,...(method==='PATCH'?{payload:{expectedVersion:1,description:'Forbidden collector instruction'}}:{})});assert.equal(reply.statusCode,403);}}
  assert.deepEqual((await app.inject({url,headers:owner})).json(),first.json());
});
