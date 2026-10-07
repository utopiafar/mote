import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sourceItemSchema,captureSchema,formatArtifactRef} from '@mote/shared';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {ProcessingRuntime} from '../src/processing-runtime.js';
import {FileStore} from '../src/files.js';
import {sha256} from '../src/store.js';
import {memoryEvidenceFingerprint,type MemoryStore} from '../src/memory.js';
import type {CaptureRecord} from '@mote/shared';

async function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-attribution-')),store=new Store(directory),materials=new MaterialStore(store),sources=new SourceStore(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  sources.register({id:'fixture',name:'Generated documents',deviceId:'fixture-device',platform:'import',kind:'custom'});
  const item={externalId:'diary',revision:'1',observedAt:'2026-10-01T01:00:00.000Z',title:'Generated novel',text:'I crossed the desert. I love sand.',kind:'message',layer:'original'} as const;
  const receipt=await sources.upsert('fixture',item);
  const draft:MaterialDraft={id:materialId('fixture','diary'),kind:'mote.message',schemaVersion:1,title:item.title,origin:{sourceId:'fixture',externalId:'diary'},
    members:[{id:receipt.id,kind:'capture',ref:'capture:'+receipt.id}],blocks:[{id:'body',kind:'text',format:'plain',text:item.text,memberIds:[receipt.id]}],
    artifacts:[{key:'body',state:'ready',blockIds:['body']}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
  return {store,materials,sources,draft,item,receipt,reader:new EvidenceReader(store,sources,undefined,undefined,undefined,materials)};
}

test('unknown stays readable; owner correction changes all projections and fences prior evidence without touching originals',async t=>{
  const {store,materials,reader,draft,receipt}=await fixture(t),first=materials.publish(draft);
  assert.equal(first.attributionContext?.ownerRelation,'unknown');assert.equal(materials.input(first.ref,['body'])?.ready,true);
  const oldAnchors=materials.evidenceIds(first.ref),oldPin=materials.input(first.ref,['body'])!.fingerprint;
  const raw=store.evidence([receipt.id])[0],payloads=store.db.prepare('SELECT hash FROM material_block_payloads').all();
  const fileArtifacts=store.db.prepare('SELECT * FROM file_artifacts').all();let withdrawn=0;materials.onContextChanged=()=>withdrawn++;
  const corrected=materials.correctContext(first.id,first.revision,'third_party');
  assert.equal(withdrawn,1);assert.equal(corrected.attributionContext?.basis,'owner_material');assert.equal(corrected.attributionContext?.correction?.version,1);
  assert.equal(materials.read(corrected.ref).text,draft.blocks[0]!.kind==='text'?draft.blocks[0].text+'\n':'');
  assert.equal(materials.read(corrected.ref).spans[0].attributionContext.ownerRelation,'third_party');
  assert.equal(materials.evidence(materials.evidenceIds(corrected.ref))[0].attributionContext?.ownerRelation,'third_party');
  assert.equal(reader.context([raw])[0].attributionContext?.ownerRelation,'third_party');
  assert.equal(materials.get(first.ref),undefined);assert.ok(oldAnchors.every(id=>!materials.isCurrentEvidence(id)));
  assert.notEqual(materials.input(corrected.ref,['body'])!.fingerprint,oldPin);
  assert.deepEqual(store.evidence([receipt.id])[0],raw);assert.deepEqual(store.db.prepare('SELECT hash FROM material_block_payloads').all(),payloads);
  assert.deepEqual(store.db.prepare('SELECT * FROM file_artifacts').all(),fileArtifacts);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='execution_steps'").get()?.n,0);
  assert.throws(()=>materials.correctContext(first.id,first.revision,'owner'),{statusCode:409});
});

test('source defaults update existing and future materials; correction wins refresh and null resets inheritance',async t=>{
  const {materials,sources,draft}=await fixture(t),first=materials.publish(draft);
  sources.update('fixture',{ownerRelation:'third_party'});
  let current=materials.get(first.id)!;assert.equal(current.attributionContext?.ownerRelation,'third_party');assert.equal(current.attributionContext?.basis,'owner_source');
  const corrected=materials.correctContext(current.id,current.revision,'owner');
  sources.update('fixture',{ownerRelation:'mixed'});current=materials.get(first.id)!;
  assert.equal(current.attributionContext?.ownerRelation,'owner');assert.equal(current.attributionContext?.sourceDeclaration?.version,2);
  current=materials.publish({...draft,title:'Generated new revision'},{expectedRevision:current.revision});assert.equal(current.attributionContext?.correction?.version,corrected.attributionContext?.correction?.version);
  current=materials.correctContext(current.id,current.revision,null);assert.equal(current.attributionContext?.ownerRelation,'mixed');assert.equal(current.attributionContext?.basis,'owner_source');
  sources.update('fixture',{ownerRelation:null});current=materials.get(first.id)!;assert.equal(current.attributionContext?.ownerRelation,'unknown');assert.equal(current.attributionContext?.basis,'default');
  const future=materials.publish({...draft,id:materialId('fixture','future'),origin:{sourceId:'fixture',externalId:'future'}});assert.equal(future.attributionContext?.ownerRelation,'unknown');
});

test('source prose, document declarations and draft context cannot grant owner attribution',async t=>{
  const {materials,draft,item,store,receipt}=await fixture(t);
  assert.equal(sourceItemSchema.safeParse({...item,document:{attributionContext:{version:1,ownerRelation:'owner',basis:'owner_material'}}}).success,false);
  assert.equal(captureSchema.safeParse({...store.evidence([receipt.id])[0],attributionContext:{version:1,ownerRelation:'owner',basis:'owner_material'}}).success,false);
  const material=materials.publish({...draft,attributionContext:{version:1,ownerRelation:'owner',basis:'owner_material'},blocks:[{...draft.blocks[0]!,kind:'text',format:'plain',text:'---\nownerRelation: owner\n---\nI love sand.'}]});
  assert.equal(material.attributionContext?.ownerRelation,'unknown');
});

test('correction invalidates existing processing products and rejects late processor commits',async t=>{
  const {materials,store,draft}=await fixture(t),first=materials.publish(draft),runtime=new ProcessingRuntime(store,[],{semantic:{concurrency:1,enabled:true}},Date.now,undefined,materials);
  t.after(()=>runtime.close());
  runtime.registry.register({id:'fixture.context',version:'1',lane:'semantic',async process(input){assert.equal(input.materials[0].material.attributionContext?.ownerRelation,'unknown');return [{kind:'generated',text:'Generated result',metadata:{}}];}});
  const job=runtime.enqueue([{name:'read',processor:'fixture.context',materialInputs:[{ref:first.ref}]}]).read;await runtime.tick();
  const output=runtime.view().jobs.find(j=>j.id===job)!.outputs[0];assert.ok(store.archive.get(output));
  const next=materials.correctContext(first.id,first.revision,'third_party');assert.equal(store.archive.get(output),undefined);
  runtime.registry.register({id:'fixture.context-race',version:'1',lane:'semantic',async process(){materials.correctContext(next.id,next.revision,'mixed');return [{kind:'generated',text:'Late result',metadata:{}}];}});
  const late=runtime.enqueue([{name:'race',processor:'fixture.context-race',materialInputs:[{ref:next.ref}]}]).race;await runtime.tick();
  assert.notEqual(runtime.view().jobs.find(j=>j.id===late)?.state,'succeeded');assert.deepEqual(runtime.view().jobs.find(j=>j.id===late)?.outputs,[]);
});

test('portable archive preserves material corrections and inherited source declarations',async t=>{
  const {store,materials,sources,draft}=await fixture(t);sources.update('fixture',{ownerRelation:'third_party'});const first=materials.publish(draft),corrected=materials.correctContext(first.id,first.revision,'mixed');
  const directory=mkdtempSync(join(tmpdir(),'mote-attribution-restore-')),target=new Store(directory);t.after(()=>{target.close();rmSync(directory,{recursive:true,force:true});});
  await target.importArchive(store.exportArchive(2_000_000));const restored=new MaterialStore(target);
  assert.deepEqual(restored.get(first.id)?.attributionContext,corrected.attributionContext);
  assert.equal(restored.read(corrected.ref).spans[0].attributionContext.ownerRelation,'mixed');
});


test('context correction retains ASR chunks and confirmed speaker metadata',async t=>{
  const {store,materials,sources,draft:baseDraft}=await fixture(t),artifactId=randomUUID(),chunkId=randomUUID(),files=new FileStore(store,sources),bytes=Buffer.from('GENERATED AUDIO');
  sources.update('fixture',{retention:'archive'});
  const upload=files.begin({sourceId:'fixture',previousRevision:null,item:{externalId:'audio',revision:'1',observedAt:'2026-10-01T01:00:00.000Z',title:'Generated audio',text:'',kind:'file',layer:'original',mimeType:'audio/wav'},relativePath:'generated.wav',sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});files.part(upload.uploadId,0,bytes,()=>{});const receipt=await files.commit(upload.uploadId,()=>{});
  const draft={...baseDraft,id:materialId('fixture','audio'),origin:{sourceId:'fixture',externalId:'audio'},members:[{id:receipt.id,kind:'capture',ref:'capture:'+receipt.id}]};
  store.db.prepare('INSERT INTO file_artifacts(id,capture_id,kind,created_at,config_revision,json,current) VALUES(?,?,?,?,?,?,1)').run(artifactId,receipt.id,'transcript','2026-10-01T01:00:00.000Z','fixture',JSON.stringify({complete:true,coverage:'full'}));
  const speech=JSON.stringify({speaker:'speaker-1',speakerAttribution:{name:'Generated visitor',isOwner:false},text:'I crossed the desert.'});
  store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,start_ms,end_ms,text,metadata) VALUES(?,?,?,?,?,?,?)').run(chunkId,artifactId,receipt.id,0,1000,speech,JSON.stringify({speaker:'speaker-1'}));
  const first=materials.publish({...draft,blocks:[{id:'body',kind:'text',format:'json',text:speech,memberIds:[receipt.id],evidenceIds:[chunkId]}]});
  const artifacts=store.db.prepare('SELECT * FROM file_artifacts').all(),chunks=store.db.prepare('SELECT * FROM file_chunks').all();
  const corrected=materials.correctContext(first.id,first.revision,'third_party');
  assert.deepEqual(store.db.prepare('SELECT * FROM file_artifacts').all(),artifacts);assert.deepEqual(store.db.prepare('SELECT * FROM file_chunks').all(),chunks);
  assert.equal(materials.read(corrected.ref).text,speech+'\n');assert.equal(store.isCurrentEvidence(receipt.id),true);
  assert.equal(materials.input(corrected.ref,['body'])?.ready,true);
});

test('context correction does not revive invalidated material evidence pending reconstruction',async t=>{
  const {materials,store,draft}=await fixture(t),first=materials.publish(draft),anchor=materials.evidenceIds(first.ref)[0];
  store.invalidateMemoryEvidence(anchor);assert.equal(materials.get(first.id)?.coverage.reason,'source_evidence_changed');
  const corrected=materials.correctContext(first.id,first.revision,'owner');
  assert.equal(materials.get(corrected.id)?.coverage.reason,'source_evidence_changed');
  assert.ok(materials.evidenceIds(corrected.ref).every(id=>!materials.isCurrentEvidence(id)));
});


test('raw processing observations carry trusted context and corrections fence raw jobs and artifacts',async t=>{
  const {materials,store,draft,receipt}=await fixture(t),first=materials.publish(draft),runtime=new ProcessingRuntime(store,[],{semantic:{concurrency:1,enabled:true}},Date.now,undefined,materials);
  t.after(()=>runtime.close());
  runtime.registry.register({id:'fixture.raw-context',version:'1',lane:'semantic',async process(input){assert.equal(input.observations[0].attributionContext?.ownerRelation,'unknown');return [{kind:'generated',text:'Generated raw result',metadata:{}}];}});
  const job=runtime.enqueue([{name:'read',processor:'fixture.raw-context',inputs:[receipt.id]}]).read;await runtime.tick();
  const output=runtime.view().jobs.find(j=>j.id===job)!.outputs[0];assert.ok(store.archive.get(output));
  const next=materials.correctContext(first.id,first.revision,'third_party');assert.equal(store.archive.get(output),undefined);
  runtime.registry.register({id:'fixture.raw-context-race',version:'1',lane:'semantic',async process(input){assert.equal(input.observations[0].attributionContext?.ownerRelation,'third_party');materials.correctContext(next.id,next.revision,'mixed');return [{kind:'generated',text:'Late raw result',metadata:{}}];}});
  const late=runtime.enqueue([{name:'race',processor:'fixture.raw-context-race',inputs:[receipt.id]}]).race;await runtime.tick();
  assert.deepEqual(runtime.view().jobs.find(j=>j.id===late)?.outputs,[]);assert.notEqual(runtime.view().jobs.find(j=>j.id===late)?.state,'succeeded');
});


test('artifact retrieval exposes bounded per-original attribution contexts',async t=>{
  const {materials,store,sources,draft,receipt,reader,item}=await fixture(t);materials.publish(draft);
  const ids=[receipt.id];
  for(let i=1;i<4;i++){const externalId='related-'+i,received=await sources.upsert('fixture',{...item,externalId,text:'Generated related '+i});ids.push(received.id);
    const material=materials.publish({...draft,id:materialId('fixture',externalId),origin:{sourceId:'fixture',externalId},members:[{id:received.id,kind:'capture',ref:'capture:'+received.id}],blocks:[{id:'body',kind:'text',format:'plain',text:'Generated related '+i,memberIds:[received.id]}]});
    materials.correctContext(material.id,material.revision,i===1?'owner':'third_party');}
  const runtime=new ProcessingRuntime(store,[],{},Date.now,undefined,materials);t.after(()=>runtime.close());
  runtime.registry.register({id:'fixture.multi-context',version:'1',lane:'semantic',async process(){return [{kind:'generated',text:'Generated linked content',metadata:{}}];}});
  const job=runtime.enqueue([{name:'read',processor:'fixture.multi-context',inputs:ids}]).read;await runtime.tick();
  const output=store.archive.get(runtime.view().jobs.find(j=>j.id===job)!.outputs[0])!,artifact=reader.artifact(formatArtifactRef(output.id,output.revision))!;
  assert.equal(Object.keys(artifact.attributionContexts).length,4);assert.equal(artifact.attributionContexts[receipt.id].ownerRelation,'unknown');assert.equal(artifact.attributionContexts[ids[1]].ownerRelation,'owner');
  const segment=reader.segments({}).items.find(value=>value.id===output.id)!;assert.equal(segment.members.length,3);assert.equal(Object.keys(segment.attributionContexts).length,3);assert.equal(segment.membersTruncated,true);
});

test('source declaration reset retains a version fence against unknown-owner-unknown late results',async t=>{
  const {materials,store,sources,draft,receipt}=await fixture(t);materials.publish(draft);
  const runtime=new ProcessingRuntime(store,[],{},Date.now,undefined,materials);t.after(()=>runtime.close());
  runtime.registry.register({id:'fixture.reset-race',version:'1',lane:'semantic',async process(){sources.update('fixture',{ownerRelation:'owner'});sources.update('fixture',{ownerRelation:null});return [{kind:'generated',text:'Obsolete default-context result',metadata:{}}];}});
  const job=runtime.enqueue([{name:'read',processor:'fixture.reset-race',inputs:[receipt.id]}]).read;await runtime.tick();
  assert.deepEqual(runtime.view().jobs.find(j=>j.id===job)?.outputs,[]);const context=materials.get(draft.id)!.attributionContext!;
  assert.equal(context.ownerRelation,'unknown');assert.equal(context.sourceDeclaration?.ownerRelation,null);assert.equal(context.sourceDeclaration?.version,2);
});


test('shared originals reuse identical context and expose bounded complete lineage for conflicting Material corrections',async t=>{
  const {materials,store,sources,draft,receipt}=await fixture(t),raw=store.evidence([receipt.id])[0];
  const published=Array.from({length:35},(_,i)=>materials.publish({...draft,id:materialId('fixture','shared-'+i),origin:{sourceId:'fixture',externalId:'shared-'+i}}));
  assert.deepEqual(materials.contextForEvidence(raw),{version:1,ownerRelation:'unknown',basis:'default'});
  sources.update('fixture',{ownerRelation:'third_party'});
  const same=materials.contextForEvidence(raw);assert.equal(same.ownerRelation,'third_party');assert.equal(same.basis,'owner_source');assert.equal(same.materialDeclarations,undefined);
  const ordered=published.map(item=>materials.get(item.id)!).sort((a,b)=>a.id.localeCompare(b.id)),first=ordered[0],hidden=ordered.at(-1)!;
  const owner=materials.correctContext(first.id,first.revision,'owner'),conflict=materials.contextForEvidence(raw);
  assert.equal(conflict.ownerRelation,'unknown');assert.equal(conflict.basis,'default');assert.equal(conflict.materialDeclarations?.total,35);assert.equal(conflict.materialDeclarations?.items.length,32);
  assert.equal(conflict.materialDeclarations?.items[0].materialId,first.id);assert.equal(conflict.materialDeclarations?.items[0].ownerRelation,'owner');
  assert.equal(materials.read(owner.ref).material.attributionContext?.ownerRelation,'owner');
  assert.equal(materials.read(hidden.ref).material.attributionContext?.ownerRelation,'third_party');
  const hiddenOverride=materials.correctContext(hidden.id,hidden.revision,'mixed'),changed=materials.contextForEvidence(raw);
  assert.deepEqual(changed.materialDeclarations?.items,conflict.materialDeclarations?.items);assert.notEqual(changed.materialDeclarations?.digest,conflict.materialDeclarations?.digest);
  const reset=materials.correctContext(hidden.id,hiddenOverride.revision,null),resetContext=materials.contextForEvidence(raw);
  assert.equal(materials.read(reset.ref).material.attributionContext?.ownerRelation,'third_party');assert.notEqual(resetContext.materialDeclarations?.digest,changed.materialDeclarations?.digest);
  const runtime=new ProcessingRuntime(store,[],{},Date.now,undefined,materials);t.after(()=>runtime.close());
  runtime.registry.register({id:'fixture.shared-context-race',version:'1',lane:'semantic',async process(input){assert.equal(input.observations[0].attributionContext?.materialDeclarations?.total,35);materials.correctContext(hidden.id,reset.revision,'owner');return [{kind:'generated',text:'Stale shared-original interpretation',metadata:{}}];}});
  const job=runtime.enqueue([{name:'read',processor:'fixture.shared-context-race',inputs:[receipt.id]}]).read;await runtime.tick();
  assert.deepEqual(runtime.view().jobs.find(j=>j.id===job)?.outputs,[]);
});

test('raw attribution looks up linked originals by member reference and excludes retired parents',async t=>{
  const {materials,store,sources,draft,receipt,item}=await fixture(t);
  const original=materials.publish(draft),owner=materials.correctContext(original.id,original.revision,'owner');
  const middle=await sources.upsert('fixture',{...item,externalId:'middle'}),leaf=await sources.upsert('fixture',{...item,externalId:'leaf'});
  store.db.prepare('INSERT INTO file_evidence_links VALUES(?,?)').run(receipt.id,middle.id);
  store.db.prepare('INSERT INTO file_evidence_links VALUES(?,?)').run(middle.id,leaf.id);
  store.db.prepare('INSERT INTO file_evidence_links VALUES(?,?)').run(leaf.id,middle.id);
  const unrelated=await sources.upsert('fixture',{...item,externalId:'unrelated'});
  for(let i=0;i<32;i++)materials.publish({...draft,id:materialId('fixture','unrelated-'+i),origin:{sourceId:'fixture',externalId:'unrelated-'+i},
    members:[{id:unrelated.id,kind:'capture',ref:'capture:'+unrelated.id}],blocks:[{id:'body',kind:'text',format:'plain',text:item.text,memberIds:[unrelated.id]}]});
  const prepare=store.db.prepare.bind(store.db),queries:string[]=[];
  t.mock.method(store.db,'prepare',(sql:string)=>{if(sql.includes('WITH RECURSIVE originals'))queries.push(sql);return prepare(sql);});
  const raw=store.evidence([leaf.id])[0];
  assert.equal(materials.contextForEvidence(raw).ownerRelation,'owner','linked ancestors inherit the current owner correction even with a cycle');
  const parent=materials.publish({...draft,id:materialId('fixture','leaf'),origin:{sourceId:'fixture',externalId:'leaf'},
    members:[{id:leaf.id,kind:'capture',ref:'capture:'+leaf.id}],blocks:[{id:'body',kind:'text',format:'plain',text:item.text,memberIds:[leaf.id]}]});
  const thirdParty=materials.correctContext(parent.id,parent.revision,'third_party'),conflict=materials.contextForEvidence(raw);
  assert.equal(conflict.ownerRelation,'unknown');assert.equal(conflict.materialDeclarations?.total,2);
  materials.retire(owner.id,{expectedRevision:owner.revision});
  assert.equal(materials.contextForEvidence(raw).ownerRelation,'third_party');
  materials.retire(thirdParty.id,{expectedRevision:thirdParty.revision});
  assert.equal(materials.contextForEvidence(raw).ownerRelation,'unknown');
  assert.ok(queries.length>0);
  for(const sql of new Set(queries)){
    const plan=prepare('EXPLAIN QUERY PLAN '+sql).all(leaf.id).map(row=>String(row.detail));
    assert.ok(plan.some(detail=>detail.includes('SEARCH m')&&detail.includes('(kind=? AND ref=?)')),
      'each original must use the member-reference lookup instead of scanning all capture members: '+plan.join('; '));
  }
});


function semanticClaim(memories:MemoryStore,record:CaptureRecord,label:string,layer:'memory'|'observation'='memory',publish=false,expectedFingerprints?:Record<string,string>){
  const result={answer:JSON.stringify({memories:[{title:'Generated '+label,statement:'Generated '+label+' ['+record.id+']',uncertainty:'Generated fixture',admission:{layer,reason:'Generated review',scope:'Generated only',attribution:'observed'},evidenceIds:[record.id],evidence:[{id:record.id,quote:record.ocrText}]}]}),citations:[{id:record.id,capturedAt:record.capturedAt,appName:'Generated',excerpt:record.ocrText}],trace:[],runId:randomUUID()};
  const claim=memories.extract(result,'fixture',{expectedFingerprints}).items[0];return publish?memories.publish(claim.id,claim.version):claim;
}

test('Material correction stales raw, chunk and linked-excerpt semantic claims without retiring fresh originals',async t=>{
  const {store,materials,sources,draft,receipt}=await fixture(t),files=new FileStore(store,sources),bytes=Buffer.from('GENERATED ASR ORIGINAL');sources.update('fixture',{retention:'archive'});
  const upload=files.begin({sourceId:'fixture',previousRevision:null,item:{externalId:'audio',revision:'1',observedAt:'2026-10-01T01:00:00.000Z',title:'Generated audio',text:'',kind:'file',layer:'original',mimeType:'audio/wav'},relativePath:'generated.wav',sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});files.part(upload.uploadId,0,bytes,()=>{});const audio=await files.commit(upload.uploadId,()=>{});
  const artifactId=randomUUID(),chunkId=randomUUID(),transcript='Generated participant describes crossing a desert.';
  store.db.prepare('INSERT INTO file_artifacts(id,capture_id,kind,created_at,config_revision,json,current) VALUES(?,?,?,?,?,?,1)').run(artifactId,audio.id,'transcript','2026-10-01T01:00:00.000Z','fixture',JSON.stringify({complete:true,coverage:'full'}));
  store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,start_ms,end_ms,text,metadata) VALUES(?,?,?,?,?,?,?)').run(chunkId,artifactId,audio.id,0,1000,transcript,'{}');
  const excerpt=await sources.upsert('fixture',{externalId:'excerpt',revision:'1',observedAt:'2026-10-01T01:00:00.000Z',kind:'message',layer:'original',text:'Generated linked original excerpt.'});store.db.prepare('INSERT INTO file_evidence_links(parent_id,capture_id) VALUES(?,?)').run(audio.id,excerpt.id);
  const first=materials.publish({...draft,members:[...draft.members,{id:audio.id,kind:'capture',ref:'capture:'+audio.id}],blocks:[...draft.blocks,{id:'speech',kind:'text',format:'plain',text:transcript,memberIds:[audio.id],evidenceIds:[chunkId]}]});
  const reader=new EvidenceReader(store,sources,files,undefined,undefined,materials),memories=reader.memories;
  const raw=memories.readEvidence([receipt.id])[0],chunk=memories.readEvidence([chunkId])[0],linked=memories.readEvidence([excerpt.id])[0];
  const claims=[semanticClaim(memories,raw,'raw proposed'),semanticClaim(memories,raw,'raw published','memory',true),semanticClaim(memories,raw,'raw observation','observation',true),semanticClaim(memories,chunk,'chunk published','memory',true),semanticClaim(memories,linked,'linked proposed')];
  const oldFingerprint=memoryEvidenceFingerprint(raw),jobId=randomUUID(),batchId=randomUUID();store.db.prepare('INSERT INTO memory_jobs VALUES(?,?,?)').run(jobId,new Date().toISOString(),'{}');store.db.prepare('INSERT INTO memory_batches VALUES(?,?,?,?)').run(batchId,jobId,0,JSON.stringify({status:'running'}));
  for(const id of [receipt.id,chunkId]){store.db.prepare('INSERT INTO memory_batch_dependencies VALUES(?,?)').run(batchId,id);store.db.prepare('INSERT INTO memory_checkpoints VALUES(?,?,?)').run('fixture:'+id,id,new Date().toISOString());}
  const changes=store.db.prepare('SELECT COUNT(*) n FROM changes').get()!.n,artifacts=store.db.prepare('SELECT * FROM file_artifacts').all(),chunks=store.db.prepare('SELECT * FROM file_chunks').all();
  const corrected=materials.correctContext(first.id,first.revision,'third_party');
  for(const claim of claims){assert.equal(memories.get(claim.id).status,'stale');assert.throws(()=>memories.publish(claim.id),{statusCode:409});}
  assert.ok(materials.evidenceIds(corrected.ref).every(id=>materials.isCurrentEvidence(id)));assert.equal(files.isCurrentEvidence(chunkId),true);assert.equal(store.isCurrentEvidence(receipt.id),true);assert.equal(store.isCurrentEvidence(excerpt.id),true);
  assert.deepEqual(store.db.prepare('SELECT * FROM file_artifacts').all(),artifacts);assert.deepEqual(store.db.prepare('SELECT * FROM file_chunks').all(),chunks);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_evidence_links WHERE parent_id=?').get(audio.id)!.n,1);
  assert.equal(memories.readEvidence([excerpt.id])[0].attributionContext?.ownerRelation,'third_party');assert.notEqual(memoryEvidenceFingerprint(memories.readEvidence([receipt.id])[0]),oldFingerprint);assert.throws(()=>semanticClaim(memories,raw,'late raw result','memory',false,{[raw.id]:oldFingerprint}),{statusCode:409});
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM memory_checkpoints').get()!.n,0);assert.equal(JSON.parse(String(store.db.prepare('SELECT json FROM memory_batches WHERE id=?').get(batchId)!.json)).status,'invalidated');assert.equal(store.db.prepare('SELECT COUNT(*) n FROM changes').get()!.n,changes);
});

test('source default correction stales raw semantic claims even before a Material exists',async t=>{
  const {store,materials,sources,receipt,reader}=await fixture(t),raw=reader.memories.readEvidence([receipt.id])[0];
  const claims=[semanticClaim(reader.memories,raw,'unorganized proposed'),semanticClaim(reader.memories,raw,'unorganized published','memory',true),semanticClaim(reader.memories,raw,'unorganized observation','observation',true)];
  const before=store.db.prepare('SELECT COUNT(*) n FROM changes').get()!.n,oldFingerprint=memoryEvidenceFingerprint(raw);assert.equal(materials.list().items.length,0);
  sources.update('fixture',{ownerRelation:'third_party'});
  for(const claim of claims)assert.equal(reader.memories.get(claim.id).status,'stale');
  assert.equal(store.isCurrentEvidence(receipt.id),true);assert.equal(materials.list().items.length,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM changes').get()!.n,before);
  assert.notEqual(memoryEvidenceFingerprint(reader.memories.readEvidence([receipt.id])[0]),oldFingerprint);assert.throws(()=>semanticClaim(reader.memories,raw,'late unorganized result','memory',false,{[raw.id]:oldFingerprint}),{statusCode:409});
});


test('source correction before any Material withdraws generic semantic products and their downstream excerpt results',async t=>{
 const {store,materials,sources,receipt}=await fixture(t),reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials),runtime=new ProcessingRuntime(store,[],{},Date.now,undefined,materials);
 t.after(()=>runtime.close());
 const excerpt=await sources.upsert('fixture',{externalId:'generated-transcript-excerpt',revision:'1',observedAt:'2026-10-01T01:00:00Z',kind:'file',layer:'original',text:'Generated verbatim transcript',document:{contentRole:'transcript',timeBasis:'unknown'}});
 store.db.prepare('INSERT INTO file_evidence_links VALUES(?,?)').run(receipt.id,excerpt.id);
 runtime.registry.register({id:'fixture.before-material',version:'1',lane:'semantic',async process(){return [{kind:'generated',text:'Generated obsolete interpretation',metadata:{}}];}});
 const originals=runtime.enqueue([{name:'root',processor:'fixture.before-material',inputs:[receipt.id]},{name:'excerpt',processor:'fixture.before-material',inputs:[excerpt.id]}]);await runtime.tick();
 const output=(jobId:string)=>runtime.view().jobs.find(job=>job.id===jobId)!.outputs[0],root=output(originals.root),excerptResult=output(originals.excerpt);
 const downstream=runtime.enqueue([{name:'downstream',processor:'fixture.before-material',artifactInputs:[{id:root,revision:store.archive.get(root)!.revision}]}]).downstream;await runtime.tick();const descendant=output(downstream);
 assert.equal(materials.list().items.length,0);for(const id of [root,excerptResult,descendant])assert.ok(store.archive.get(id));
 sources.update('fixture',{ownerRelation:'third_party'});
 for(const id of [root,excerptResult,descendant])assert.equal(store.archive.get(id),undefined,'old semantic products cannot be queried under new attribution');
 assert.equal(reader.segments({}).items.length,0);assert.equal(store.db.prepare('SELECT count(*) n FROM artifacts_fts').get()!.n,0);
 assert.equal(store.evidence([excerpt.id])[0].ocrText,'Generated verbatim transcript');assert.equal(store.isCurrentEvidence(excerpt.id),true);
 assert.ok(store.db.prepare('SELECT 1 FROM file_evidence_links WHERE parent_id=? AND capture_id=?').get(receipt.id,excerpt.id));
 await runtime.tick();assert.equal(store.db.prepare('SELECT count(*) n FROM context_artifacts').get()!.n,0,'correction does not authorize automatic regeneration');
});
