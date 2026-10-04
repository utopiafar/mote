import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId,type MaterialDraft,type MaterialAppendDraft} from '../src/materials.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {Operations} from '../src/operations.js';
import {randomUUID} from 'node:crypto';

function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-material-index-'));
  const store=new Store(directory),materials=new MaterialStore(store),engine=new ExecutionEngine(store);
  const index=materials.bindIndexEngine(engine);
  t.after(async()=>{await index.close();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,store,materials,engine,index};
}
function draft(externalId='generated-document'):MaterialDraft {
  return {id:materialId('generated-index-source',externalId),kind:'mote.message',schemaVersion:1,title:'Generated document',
    origin:{sourceId:'generated-index-source',externalId},members:[{id:'original',kind:'source-item',ref:'generated:original'}],
    blocks:[{id:'body',kind:'text',format:'plain',text:'Generated publication survives a failed search index',memberIds:['original']}],
    coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
}
const restoreFts=(store:Store)=>store.db.exec("CREATE VIRTUAL TABLE material_fts USING fts5(material_id UNINDEXED,text,content='',tokenize='trigram',contentless_delete=1)");

test('an actual organizer commits the readable Material even when FTS fails; index-only retry survives restart',async t=>{
  const {store,materials,engine,index,directory}=fixture(t),sources=new SourceStore(store);
  const organizers=new MaterialOrganizerRuntime(store,materials,[],engine);t.after(()=>organizers.close());
  sources.register({id:'generated-index-source',name:'Generated source',kind:'custom',deviceId:'fixture-device',platform:'import',retention:'archive'});
  await sources.upsert('generated-index-source',{externalId:'generated-document',revision:'1',observedAt:'2026-09-20T00:00:00Z',
    text:'Generated publication survives a failed search index',kind:'message',layer:'original'});
  store.db.exec('DROP TABLE material_fts');
  await organizers.tick();
  const id=materialId('generated-index-source','generated-document'),first=materials.get(id)!;
  assert.ok(first);assert.match(materials.read(first.ref).text,/publication survives/);
  assert.equal(first.indexing.state,'failed');assert.equal(first.indexing.reason,'material_index_failed');
  const organizer=store.db.prepare("SELECT id,state,attempts FROM execution_steps WHERE kind='material.organizer'").get()!;
  assert.equal(organizer.state,'succeeded');assert.equal(organizer.attempts,1);
  assert.equal(new Operations(store).page({kind:'material-index'}).items[0]?.state,'failed');
  assert.equal(store.db.prepare('SELECT count(*) n FROM material_searchable').get()!.n,0);
  restoreFts(store);await index.close();
  const reopened=new Store(directory),restarted=new MaterialStore(reopened),executor=new ExecutionEngine(reopened),retried=restarted.bindIndexEngine(executor);
  try{
    assert.equal(restarted.get(id)?.indexing.state,'failed');
    await retried.tick();assert.equal(restarted.get(id)?.indexing.state,'failed','failed indexes await an explicit retry');
    assert.equal(retried.retry(id).state,'pending');await retried.tick();
    assert.equal(restarted.get(id)?.ref,first.ref);assert.equal(restarted.get(id)?.indexing.state,'indexed');
    assert.equal(restarted.list({query:'publication survives'}).items[0]?.ref,first.ref);
    assert.deepEqual({...reopened.db.prepare('SELECT state,attempts FROM execution_steps WHERE id=?').get(organizer.id)},{state:'succeeded',attempts:1});
    assert.equal(new Operations(reopened).page({kind:'material-index'}).items[0]?.state,'succeeded');
  }finally{await retried.close();await executor.close();reopened.close();}
});

test('pending index requests recover on restart and a new revision withdraws old search matches before indexing',async t=>{
  const {store,materials,index,directory}=fixture(t),input=draft(),first=materials.publish(input);
  materials.setSearchable(input.id,true);assert.equal(materials.get(input.id)?.indexing.state,'pending');
  assert.equal(materials.list({query:'publication survives'}).items.length,0);
  await index.close();
  const reopened=new Store(directory),restarted=new MaterialStore(reopened),executor=new ExecutionEngine(reopened),recovered=restarted.bindIndexEngine(executor);
  try{
    await recovered.tick();assert.equal(restarted.list({query:'publication survives'}).items[0]?.ref,first.ref);
    const second=restarted.publish({...input,blocks:[{...input.blocks[0]!,text:'Generated replacement contains another searchable phrase'}]},
      {expectedRevision:first.revision});
    assert.equal(restarted.get(input.id)?.indexing.state,'pending');
    assert.equal(restarted.list({query:'publication survives'}).items.length,0);
    assert.match(restarted.read(first.ref).text,/publication survives/);assert.match(restarted.read(second.ref).text,/replacement contains/);
    await recovered.tick();assert.equal(restarted.list({query:'replacement contains'}).items[0]?.ref,second.ref);
    assert.equal(restarted.list({query:'publication survives'}).items.length,0);
    assert.equal(new Operations(reopened).detail('material-index:'+input.id).steps.filter(s=>s.current).length,1);
  }finally{await recovered.close();await executor.close();reopened.close();}
  assert.ok(store.db.prepare('SELECT 1 FROM material_revisions WHERE material_id=?').get(input.id));
});

test('disabling or deleting a material while an index is prepared fences its late search grant',async t=>{
  for(const action of ['disable','forget'] as const){
    const {materials,engine,index,store}=fixture(t),input=draft('late-'+action);materials.publish(input);materials.setSearchable(input.id,true);
    // drain starts execute synchronously but awaits its Promise before commit.
    const indexing=index.tick();if(action==='disable')materials.setSearchable(input.id,false);else materials.forget(input.id);
    await indexing;await yieldTurn();
    assert.equal(store.db.prepare('SELECT count(*) n FROM material_searchable WHERE material_id=?').get(input.id)!.n,0);
    assert.equal(engine.list({kind:'material.index'}).items[0]?.state,'stale');
    assert.equal(materials.list({query:'publication survives'}).items.length,0);
    if(action==='disable'){assert.equal(materials.get(input.id)?.indexing.state,'disabled');assert.throws(()=>index.retry(input.id),{statusCode:409});}
    else assert.equal(materials.get(input.id),undefined);
  }
});

test('Coding append publication survives a missing block index and retry builds only the new tail',async t=>{
  const {materials,store,index}=fixture(t),base=draft('coding-append');
  const coding:MaterialDraft={...base,kind:'mote.coding-session',members:[{id:'original',kind:'archive',ref:'archive:generated'}],
    blocks:[{id:'section-0',kind:'text',format:'markdown-fragment',text:'Generated immutable prefix ',memberIds:['original']}]};
  const first=materials.publish(coding,{codingSnapshot:{checkpoint:'first',appendEpoch:0,headCount:1}});
  materials.setSearchable(coding.id,true);await index.tick();
  const prefix=store.db.prepare('SELECT rowid FROM material_fts_blocks').get()!.rowid;
  // Replacing only the block FTS schema simulates a damaged/unavailable index.
  store.db.exec("DROP TABLE material_fts_blocks; CREATE VIRTUAL TABLE material_fts_blocks USING fts5(unexpected)");
  const append:MaterialAppendDraft={...coding,mode:'append',baseRevision:first.revision,reuseBlocks:1,
    blocks:[{id:'section-1',kind:'text',format:'markdown-fragment',text:'Generated appended searchable tail',memberIds:['original']}]};
  const second=materials.publish(append,{expectedRevision:first.revision,codingSnapshot:{checkpoint:'second',appendEpoch:0,headCount:2}});
  await index.tick();assert.equal(materials.get(coding.id)?.indexing.state,'failed');
  assert.equal(materials.read(second.ref).text,'Generated immutable prefix Generated appended searchable tail');
  assert.equal(materials.read(first.ref).text,'Generated immutable prefix ');
  store.db.exec("DROP TABLE material_fts_blocks; CREATE VIRTUAL TABLE material_fts_blocks USING fts5(text,content='',tokenize='trigram',contentless_delete=1)");
  index.retry(coding.id);await index.tick();assert.equal(materials.list({query:'searchable tail'}).items[0]?.ref,second.ref);
  assert.equal(store.db.prepare('SELECT count(*) n FROM material_fts_blocks').get()!.n,2);
  assert.ok(store.db.prepare('SELECT 1 FROM material_fts_blocks WHERE rowid=?').get(prefix));
  const third=materials.publish({...append,baseRevision:second.revision,reuseBlocks:2,blocks:[{id:'section-2',kind:'text',format:'markdown-fragment',
    text:' Another generated tail',memberIds:['original']}]},{expectedRevision:second.revision,codingSnapshot:{checkpoint:'third',appendEpoch:0,headCount:3}});
  await index.tick();assert.equal(store.db.prepare('SELECT count(*) n FROM material_fts_blocks').get()!.n,3);
  assert.equal(materials.get(coding.id)?.ref,third.ref);assert.ok(store.db.prepare('SELECT 1 FROM material_fts_blocks WHERE rowid=?').get(prefix));
});

test('privacy deletion commits with missing FTS, and pending cleanup cannot delete a reused row index',async t=>{
  const {materials,store,index}=fixture(t),captureId=randomUUID();
  await store.ingest({id:captureId,deviceId:'generated-device',deviceName:'Generated device',platform:'import',source:'note',
    capturedAt:'2026-09-20T00:00:00Z',durationMs:0,ocrText:'Generated deletable original'});
  const input=draft('privacy-delete');input.members=[{id:'original',kind:'capture',ref:'capture:'+captureId}];
  const first=materials.publish(input);materials.setSearchable(input.id,true);await index.tick();
  store.db.exec('DROP TABLE material_fts');
  assert.equal(store.delete(captureId).deleted,1);assert.equal(materials.get(first.ref),undefined);
  assert.equal(store.db.prepare('SELECT count(*) n FROM material_revisions').get()!.n,0);
  assert.ok(Number(store.db.prepare('SELECT count(*) n FROM material_index_garbage').get()!.n)>0);
  const replacement=draft('new-after-delete'),second=materials.publish({...replacement,blocks:[{...replacement.blocks[0]!,text:'Generated replacement searchable token'}]});
  materials.setSearchable(replacement.id,true);restoreFts(store);await index.tick();
  assert.equal(materials.list({query:'replacement searchable'}).items[0]?.ref,second.ref);
  materials.pruneIndexes();assert.equal(materials.list({query:'replacement searchable'}).items[0]?.ref,second.ref);
  assert.equal(store.db.prepare('SELECT count(*) n FROM material_index_garbage').get()!.n,0);
  store.db.exec('DROP TABLE material_fts');assert.equal(materials.forget(replacement.id),true);
  assert.equal(materials.get(second.ref),undefined);
});

test('a reused Coding block row replaces orphaned FTS before restoring search authority',async t=>{
  const {materials,store,index,engine}=fixture(t);
  const coding=(externalId:string,text:string):MaterialDraft=>({...draft(externalId),kind:'mote.coding-session',
    members:[{id:'original',kind:'archive',ref:'archive:generated'}],
    blocks:[{id:'section-0',kind:'text',format:'markdown-fragment',text,memberIds:['original']}]});
  const old=coding('old-coding','GeneratedOldSearchToken');
  materials.publish(old,{codingSnapshot:{checkpoint:'old',appendEpoch:0,headCount:1}});materials.setSearchable(old.id,true);await index.tick();
  const oldRow=store.db.prepare('SELECT id FROM material_block_versions').get()!.id;
  // Capture/privacy deletes can occur in a larger receive transaction; cleanup
  // must wait until after that authority transaction has committed.
  store.db.exec('BEGIN IMMEDIATE');materials.forget(old.id);store.db.exec('COMMIT');
  assert.equal(store.db.prepare('SELECT count(*) n FROM material_fts_blocks').get()!.n,1);
  const next=coding('new-coding','GeneratedNewSearchToken');
  materials.publish(next,{codingSnapshot:{checkpoint:'new',appendEpoch:0,headCount:1}});materials.setSearchable(next.id,true);
  assert.equal(store.db.prepare('SELECT id FROM material_block_versions').get()!.id,oldRow,'SQLite can reuse the deleted maximum primary key');
  index.retry(next.id);
  // The ordinary global pump can execute an admitted step before a projection
  // sweep. The garbage receipt must invalidate its reused physical index row.
  await engine.drain(engine.list({kind:'material.index',state:'waiting'}).items.map(step=>step.id));
  assert.equal(materials.list({query:'GeneratedNewSearchToken'}).items[0]?.id,next.id);
  assert.equal(materials.list({query:'GeneratedOldSearchToken'}).items.length,0);
  materials.pruneIndexes();assert.equal(materials.list({query:'GeneratedNewSearchToken'}).items[0]?.id,next.id);
});
