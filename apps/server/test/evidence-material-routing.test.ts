import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {SourceItemRecipeCatalog} from '../src/source-item-recipe.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {ServerDiagnostics} from '../src/diagnostics.js';

async function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-material-query-routing-'));
  const store=new Store(directory),sources=new SourceStore(store),materials=new MaterialStore(store);
  const recipes=new SourceItemRecipeCatalog(store,'1');
  const diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:false});await diagnostics.init();
  t.after(async()=>{await diagnostics.close();store.close();rmSync(directory,{recursive:true,force:true});});
  sources.register({id:'fixture-query-routing',name:'Generated source',kind:'custom',deviceId:'fixture-device',platform:'import',retention:'archive'});
  return {store,sources,materials,recipes,diagnostics};
}

function publish(materials:MaterialStore,externalId:string,captureId:string,kind:'message'|'file',text:string,processed?:string){
  const id=materialId('fixture-query-routing',externalId);
  const blocks:MaterialDraft['blocks']=[{id:'source-record',kind:'text',format:'plain',text,memberIds:[captureId]}];
  if(processed)blocks.push({id:'processed',kind:'text',format:'plain',text:processed,memberIds:[captureId]});
  const material=materials.publish({id,kind:`mote.${kind}`,schemaVersion:1,title:`Generated ${externalId}`,
    origin:{sourceId:'fixture-query-routing',externalId,deviceId:'fixture-device'},blocks,
    members:[{id:captureId,kind:'capture',ref:`capture:${captureId}`}],coverage:{state:'complete'},
    fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
  materials.setSearchable(id,true);
  return material;
}

test('published source-item Material replaces raw discovery while a new head keeps raw fallback',async t=>{
  const {sources,materials,recipes,diagnostics,store}=await fixture(t);
  const first=await sources.upsert('fixture-query-routing',{externalId:'doc-1',revision:'v1',observedAt:'2026-09-20T00:00:00.000Z',
    text:'GENERATED_SHARED_SOURCE',kind:'message',layer:'original'});
  let memory=false;
  const reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials,undefined,recipes);
  const agent=reader.agent({diagnostics,currentOperation:()=>memory?'memory':'query'});
  assert.deepEqual((await agent.search({query:'GENERATED_SHARED_SOURCE'})).map(row=>row.id),[first.id]);
  assert.deepEqual((await agent.sourceItems!({sourceId:'fixture-query-routing'})).items.map(row=>row.id),[first.id]);
  assert.deepEqual((await agent.timeline({limit:10}) as {items:{id:string}[]}).items.map(row=>row.id),[first.id]);

  const material=publish(materials,'doc-1',first.id,'message','GENERATED_SHARED_SOURCE','GENERATED_PROCESSED_ONLY');
  const anchors=new Set(materials.evidenceIds(material.ref));assert.equal(anchors.size,2);
  const shared=await agent.search({query:'GENERATED_SHARED_SOURCE'});
  assert.equal(shared.length,1);assert.ok(anchors.has(shared[0].id));assert.notEqual(shared[0].id,first.id);
  assert.deepEqual((shared.retrieval as {materialCatalog?:{matchedRefs:string[]}}).materialCatalog?.matchedRefs,[material.ref]);
  const processed=await agent.search({query:'GENERATED_PROCESSED_ONLY'});
  assert.equal(processed.length,1,'processed text is discoverable even when raw search has no hit');
  assert.ok(anchors.has(processed[0].id));assert.match(processed[0].ocrText,/GENERATED_PROCESSED_ONLY/);
  const listed=(await agent.sourceItems!({sourceId:'fixture-query-routing'})).items;
  assert.equal(listed.length,1);assert.ok(anchors.has(listed[0].id));
  assert.equal(listed[0].provenance?.externalId,'doc-1');
  const timeline=await agent.timeline({limit:10}) as {items:{id:string}[]};
  assert.deepEqual(timeline.items.map(row=>row.id),[listed[0].id]);
  assert.equal((await agent.evidence({ids:[first.id]}))[0].id,first.id,'exact expansion retains the original');
  assert.deepEqual((await agent.sourceHistory!({id:listed[0].id})).map(row=>row.id),[first.id]);

  memory=true;
  assert.deepEqual(await agent.evidence({ids:[first.id,listed[0].id]}),[],'Memory cannot use raw or Material without named dependencies');
  assert.equal((await agent.search({query:'GENERATED_SHARED_SOURCE'})).length,0);
  memory=false;
  const second=await sources.upsert('fixture-query-routing',{externalId:'doc-1',revision:'v2',observedAt:'2026-09-20T00:01:00.000Z',
    text:'GENERATED_NEW_VERSION',kind:'message',layer:'original'});
  assert.deepEqual((await agent.search({query:'GENERATED_NEW_VERSION'})).map(row=>row.id),[second.id]);
  assert.deepEqual((await agent.sourceItems!({sourceId:'fixture-query-routing'})).items.map(row=>row.id),[second.id]);
  assert.deepEqual((await agent.timeline({limit:10}) as {items:{id:string}[]}).items.map(row=>row.id),[second.id]);
});

test('file Material card preserves source filters, exact expansion and raw pagination cursor',async t=>{
  const {sources,materials,recipes,diagnostics,store}=await fixture(t);
  const older=await sources.upsert('fixture-query-routing',{externalId:'older-file',revision:'v1',observedAt:'2026-09-20T00:00:00.000Z',
    text:'GENERATED_OLDER_FILE',kind:'file',layer:'original'});
  const newer=await sources.upsert('fixture-query-routing',{externalId:'newer-file',revision:'v1',observedAt:'2026-09-20T00:01:00.000Z',
    text:'GENERATED_NEWER_FILE',kind:'file',layer:'original'});
  const material=publish(materials,'newer-file',newer.id,'file','GENERATED_NEWER_FILE');
  const anchor=materials.evidenceIds(material.ref)[0];assert.ok(anchor);
  const reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials,undefined,recipes);
  const agent=reader.agent({diagnostics});
  const search=await agent.search({query:'GENERATED_NEWER_FILE',source:'file'});
  assert.deepEqual(search.map(row=>row.id),[anchor]);assert.equal(search[0].source,'file');
  assert.deepEqual((await agent.evidence({ids:[anchor],source:'file'})).map(row=>row.id),[anchor]);
  assert.deepEqual((await agent.sourceHistory!({id:anchor,source:'file'})).map(row=>row.id),[newer.id]);
  assert.deepEqual((await agent.search({query:'GENERATED_NEWER_FILE',source:'message'})).map(row=>row.id),[]);
  assert.deepEqual((await agent.search({query:'GENERATED_NEWER_FILE',deviceId:'another-device'})).map(row=>row.id),[]);

  const first=await agent.timeline({source:'file',limit:1}) as {items:{id:string}[];nextCursor:string|null};
  assert.deepEqual(first.items.map(row=>row.id),[anchor]);assert.ok(first.nextCursor);
  const second=await agent.timeline({source:'file',limit:1,cursor:first.nextCursor!}) as {items:{id:string}[];nextCursor:string|null};
  assert.deepEqual(second.items.map(row=>row.id),[older.id]);assert.equal(second.nextCursor,null);
  const sourceFirst=await agent.sourceItems!({sourceId:'fixture-query-routing',kind:'file',limit:1}) as {items:{id:string}[];nextCursor:string|null};
  assert.deepEqual(sourceFirst.items.map(row=>row.id),[anchor]);assert.ok(sourceFirst.nextCursor);
  const sourceSecond=await agent.sourceItems!({sourceId:'fixture-query-routing',kind:'file',limit:1,cursor:sourceFirst.nextCursor!}) as {items:{id:string}[];nextCursor:string|null};
  assert.deepEqual(sourceSecond.items.map(row=>row.id),[older.id]);
});
