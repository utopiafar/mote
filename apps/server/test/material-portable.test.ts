import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';
import {MemoryStore} from '../src/memory.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';

function destination(t:TestContext){const directory=mkdtempSync(join(tmpdir(),'mote-portable-material-')),store=new Store(directory,{contentEncryptionEnabled:true,dataKey:'31'.repeat(32)});t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return {directory,store,materials:new MaterialStore(store)};}
async function fixture(t:TestContext){
  const f=destination(t),sources=new SourceStore(f.store),organizers=new MaterialOrganizerRuntime(f.store,f.materials);
  t.after(()=>organizers.close());sources.register({id:'generated',name:'Generated authored notes',kind:'custom',deviceId:'generated',platform:'import',retention:'archive'});
  const firstCapture=await sources.upsert('generated',{externalId:'decision',revision:'1',observedAt:'2026-10-01T00:00:00Z',title:'Generated decision',kind:'message',layer:'original',text:'Generated owner records a scoped deployment decision.'});
  while(await organizers.tick(100));const first=f.materials.get(materialId('generated','decision'))!;
  const memories=new MemoryStore(f.store,ids=>[...f.store.evidence(ids),...f.materials.evidence(ids)],id=>f.store.isCurrentEvidence(id)||f.materials.isCurrentEvidence(id));
  const save=()=>{const material=f.materials.get(first.id)!,record=f.materials.evidence(f.materials.evidenceIds(material.ref))[0];const item=memories.extract(fixtureMemoryResult(memories,{answer:JSON.stringify({memories:[{title:'Generated scoped decision',statement:'Generated authored decision ['+record.id+']',uncertainty:'Generated fixture',evidenceIds:[record.id]}]}),citations:[{id:record.id,capturedAt:record.capturedAt,appName:record.appName,excerpt:record.ocrText}],trace:[],runId:'generated-portable'}),'generated').items[0];return memories.publish(item.id,item.version);};
  const oldMemory=save();await sources.upsert('generated',{externalId:'decision',revision:'2',observedAt:'2026-10-02T00:00:00Z',title:'Generated decision',kind:'message',layer:'original',text:'Generated owner corrects the deployment decision with explicit scope.'});
  while(await organizers.tick(100));const latest=f.materials.get(first.id)!,memory=save();
  const asset=f.store.assets.put(Buffer.from('GENERATED_MATERIAL_ASSET')),blocks:MaterialDraft['blocks']=[];
  for(let index=0;index<latest.blockCount;index++){const stored=f.materials.block(latest.ref,index)!.block;blocks.push({id:stored.id,kind:'text',format:stored.format!,text:stored.text,memberIds:stored.memberIds,locator:stored.locator});}
  blocks.push({id:'generated-original',kind:'asset',hash:asset.hash,mimeType:'application/x-generated',memberIds:[firstCapture.id]});
  const assetMaterial=f.materials.publish({id:materialId('generated','independent-asset'),kind:'mote.message',schemaVersion:1,title:'Generated standalone asset',origin:{sourceId:'generated',externalId:'independent-asset'},members:[{id:firstCapture.id,kind:'capture',ref:'capture:'+firstCapture.id,revision:'1'}],blocks:[{id:'body',kind:'text',format:'plain',text:'Generated retained original asset',memberIds:[firstCapture.id]},blocks.at(-1)!],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});asset.release();
  return {...f,sources,organizers,first,latest,memories,memory,oldMemory,assetMaterial,assetHash:asset.hash};
}
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
function reseal(archive:any){const {checksum:_,...body}=archive.materials;archive.materials.checksum=sha256(JSON.stringify(canonical(body)));return archive;}
function empty(store:Store){assert.equal(store.db.prepare('SELECT COUNT(*) n FROM captures').get()!.n,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM material_heads').get()!.n,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM memories').get()!.n,0);assert.deepEqual(readdirSync(store.assets.directory),[]);}

test('portable archive restores formal revisions, exact anchors, assets and dependent Memories; repeat import is idempotent',async t=>{
  const source=await fixture(t),target=destination(t),archive=source.store.exportArchive(2_000_000);
  await target.store.importArchive(archive);
  assert.equal(target.materials.get(source.latest.id)?.ref,source.latest.ref);assert.equal(target.materials.read(source.first.ref).text,source.materials.read(source.first.ref).text);
  assert.deepEqual(target.materials.evidenceIds(source.latest.ref),source.materials.evidenceIds(source.latest.ref));assert.equal(target.store.assets.read(source.assetHash).toString(),'GENERATED_MATERIAL_ASSET');
  const memory=JSON.parse(String(target.store.db.prepare('SELECT json FROM memories WHERE id=?').get(source.memory.id)!.json));assert.equal(memory.status,'stale');assert.equal(memory.staleReason,'restored_archive');
  const proof=target.materials.evidence(memory.evidenceIds)[0];assert.equal(proof.ocrText.slice(memory.evidence[0].offset,memory.evidence[0].offset+memory.evidence[0].length),memory.evidence[0].quote);
  const indexEngine=new ExecutionEngine(target.store),index=target.materials.bindIndexEngine(indexEngine);try{await index.tick();assert.equal(target.materials.list({query:'corrects'}).items.length,1);}finally{await index.close();await indexEngine.close();}
  const before=target.store.db.prepare('SELECT COUNT(*) n FROM material_evidence').get()!.n;assert.equal((await target.store.importArchive(archive)).duplicates,archive.captures.length);assert.equal(target.store.db.prepare('SELECT COUNT(*) n FROM material_evidence').get()!.n,before);
});

test('portable archive preserves a deleted Memory rule quoting formal anchors and routing to their original lineage',async t=>{
  const source=await fixture(t);source.memories.delete(source.memory.id);const archive=source.store.exportArchive(2_000_000),target=destination(t);
  assert.ok(archive.memoryDeletions[0].dependencies.every(id=>archive.captures.some(capture=>capture.id===id)));
  assert.ok(archive.memoryDeletions[0].originalTexts.some(text=>archive.materials!.payloads.some(payload=>String(payload.text).includes(text))));
  await target.store.importArchive(archive);const restored=new MemoryStore(target.store,ids=>[...target.store.evidence(ids),...target.materials.evidence(ids)],id=>target.store.isCurrentEvidence(id)||target.materials.isCurrentEvidence(id));
  assert.deepEqual(restored.deletions.export(),source.memories.deletions.export());assert.equal(target.store.db.prepare('SELECT 1 FROM memories WHERE id=?').get(source.memory.id),undefined);
});

test('retired Material proof restores for stale Memory verification without reopening product reads',async t=>{
  const source=await fixture(t);source.materials.retire(source.latest.id,{expectedRevision:source.latest.revision});const target=destination(t);
  await target.store.importArchive(source.store.exportArchive(2_000_000));assert.equal(target.materials.get(source.latest.id),undefined);assert.throws(()=>target.materials.read(source.latest.ref),{statusCode:404});
  const stored=JSON.parse(String(target.store.db.prepare('SELECT json FROM memories WHERE id=?').get(source.memory.id)!.json));assert.equal(stored.status,'stale');assert.equal(target.materials.evidence(stored.evidenceIds).length,0);
});

for(const kind of ['checksum','payload','missing-anchor','missing-lineage','missing-memory-proof'] as const)test(`portable ${kind} corruption rolls back captures, formal material and original assets`,async t=>{
  const source=await fixture(t),target=destination(t),archive:any=structuredClone(source.store.exportArchive(2_000_000));
  if(kind==='checksum')archive.materials.heads[0].title='unrecognized';
  if(kind==='payload'){archive.materials.payloads[0].text+=' CORRUPTED';reseal(archive);}
  if(kind==='missing-anchor'){archive.materials.evidence=[];reseal(archive);}
  if(kind==='missing-lineage'){archive.materials.dependencies=[];reseal(archive);}
  if(kind==='missing-memory-proof'){archive.memories[0].evidenceIds=[randomUUID()];archive.memories[0].evidence=[];}
  await assert.rejects(target.store.importArchive(archive));empty(target.store);
});

test('divergent destination Material revision fails the entire import without overwriting its existing history',async t=>{
  const source=await fixture(t),target=destination(t),archive=source.store.exportArchive(2_000_000);
  await target.store.importArchive({...archive,materials:undefined,memories:[],memoryDeletions:[]});const capture=target.store.evidence(archive.captures.map(row=>row.id))[0];
  const conflicting=target.materials.publish({id:source.first.id,kind:'mote.message',schemaVersion:1,title:'Generated divergent local material',origin:{sourceId:'generated',externalId:'decision'},members:[{id:capture.id,kind:'capture',ref:'capture:'+capture.id}],blocks:[{id:'body',kind:'text',format:'plain',text:'Generated independent local projection',memberIds:[capture.id]}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
  await assert.rejects(target.store.importArchive(archive),{statusCode:409});assert.equal(target.materials.get(source.first.id)?.revision,conflicting.revision);assert.equal(target.store.db.prepare('SELECT COUNT(*) n FROM material_heads').get()!.n,1);assert.equal(target.store.db.prepare('SELECT COUNT(*) n FROM memories').get()!.n,0);assert.throws(()=>target.store.assets.get(source.assetHash),{statusCode:404});
});

test('older portable backups preserve a newer destination head, disabled search and retirement',async t=>{
  const source=await fixture(t),target=destination(t),archive=source.store.exportArchive(2_000_000);await target.store.importArchive(archive);
  const sources=new SourceStore(target.store);sources.update('generated',{enabled:true});await sources.upsert('generated',{externalId:'decision',revision:'3',observedAt:'2026-10-03T00:00:00Z',title:'Generated current decision',kind:'message',layer:'original',text:'GENERATED_NEWER_DESTINATION_PROOF'});
  const organizers=new MaterialOrganizerRuntime(target.store,target.materials);try{while(await organizers.tick(100));}finally{await organizers.close();}
  const current=target.materials.get(source.latest.id)!;assert.notEqual(current.revision,source.latest.revision);target.materials.setSearchable(current.id,false);
  await target.store.importArchive(archive);assert.equal(target.materials.get(current.id)?.revision,current.revision);assert.equal(target.materials.indexStatus(current.id).state,'disabled');assert.match(target.materials.read(current.ref).text,/GENERATED_NEWER_DESTINATION_PROOF/);
  target.materials.retire(current.id,{expectedRevision:current.revision});await target.store.importArchive(archive);assert.equal(target.materials.get(current.id),undefined);assert.equal(target.store.db.prepare('SELECT enabled FROM material_index_requests WHERE material_id=?').get(current.id)!.enabled,0);
});

test('resealed archives cannot reuse an old quote anchor for different current text',async t=>{
  const source=destination(t),target=destination(t),captureId=randomUUID();
  await source.store.ingest({id:captureId,deviceId:'generated',deviceName:'Generated',platform:'import',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,source:'message',ocrText:'Generated unchanged original source',privacy:{excluded:false,redacted:false,mode:'none'}});
  const draft:MaterialDraft={id:materialId('generated','anchor-proof'),kind:'mote.message',schemaVersion:1,title:'Generated projection',origin:{sourceId:'generated',externalId:'anchor-proof'},members:[{id:captureId,kind:'capture',ref:'capture:'+captureId}],blocks:[{id:'body',kind:'text',format:'plain',text:'Generated original projection',memberIds:[captureId]}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}};
  const first=source.materials.publish(draft),latest=source.materials.publish({...draft,blocks:[{...draft.blocks[0],kind:'text',format:'plain',text:'Generated corrected projection'}]},{expectedRevision:first.revision});
  const archive:any=structuredClone(source.store.exportArchive(2_000_000)),prior=archive.materials.blocks.find((row:any)=>row.revision===first.revision),current=archive.materials.blocks.find((row:any)=>row.revision===latest.revision),removed=current.anchor_id;
  current.anchor_id=prior.anchor_id;archive.materials.evidence=archive.materials.evidence.filter((row:any)=>row.id!==removed);archive.materials.dependencies=archive.materials.dependencies.filter((row:any)=>row.anchor_id!==removed);archive.materials.contexts=archive.materials.contexts.filter((row:any)=>row.anchor_id!==removed);reseal(archive);
  await assert.rejects(target.store.importArchive(archive),/divergent block proof/);empty(target.store);
});

test('deleted Memory proof beyond the first bounded anchor page restores completely',async t=>{
  const source=destination(t),target=destination(t),captureId=randomUUID();
  await source.store.ingest({id:captureId,deviceId:'generated',deviceName:'Generated',platform:'import',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,source:'message',ocrText:'Generated shared original',privacy:{excluded:false,redacted:false,mode:'none'}});
  const material=source.materials.publish({id:materialId('generated','many-anchors'),kind:'mote.message',schemaVersion:1,title:'Generated large projection',origin:{sourceId:'generated',externalId:'many-anchors'},members:[{id:captureId,kind:'capture',ref:'capture:'+captureId}],blocks:Array.from({length:205},(_,index)=>({id:'body-'+index,kind:'text' as const,format:'plain',text:'Generated exact quote '+index,memberIds:[captureId]})),coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
  const id=String(source.store.db.prepare('SELECT anchor_id FROM material_evidence_dependencies ORDER BY anchor_id DESC LIMIT 1').get()!.anchor_id),proof=source.materials.evidence([id])[0],memories=new MemoryStore(source.store,ids=>[...source.store.evidence(ids),...source.materials.evidence(ids)],id=>source.store.isCurrentEvidence(id)||source.materials.isCurrentEvidence(id));
  assert.ok(source.materials.evidenceIds(material.ref).includes(id));
  const item=memories.extract(fixtureMemoryResult(memories,{answer:JSON.stringify({memories:[{title:'Generated final page quote',statement:'Generated proof ['+id+']',uncertainty:'Generated fixture',evidenceIds:[id]}]}),citations:[{id,capturedAt:proof.capturedAt,appName:proof.appName,excerpt:proof.ocrText}],trace:[],runId:'generated-bounded-restore'}),'generated').items[0];memories.publish(item.id,item.version);memories.delete(item.id);
  await target.store.importArchive(source.store.exportArchive(2_000_000));assert.equal(target.store.db.prepare('SELECT COUNT(*) n FROM memory_deletions').get()!.n,1);assert.equal(target.store.db.prepare('SELECT 1 FROM memories WHERE id=?').get(item.id),undefined);
});
