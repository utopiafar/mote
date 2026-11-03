import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PluginHost} from '@mote/plugin-host';
import {Store} from '../src/store.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {SourceStore} from '../src/sources.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {centralServices} from '../src/plugins/central-contracts.js';
import {createMaterialRetrievalIndex,createMaterialRetrievalIndexFactory,materialRetrievalIndexContribution,materialRetrievalIndexDeclaration,type MaterialRetrievalIndexBindings} from '../src/plugins/material-retrieval-index.js';

const config={embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};

async function install(host:PluginHost,store:Store,materials:MaterialStore,executor:ExecutionEngine){
  const platform=createMaterialRetrievalIndex({store,config,executor,materials});let bindings:MaterialRetrievalIndexBindings|undefined;
  const handle=await host.install({
    identity:{host:host.identity,packageId:'generated.material-retrieval-index',installationId:randomUUID(),instanceId:randomUUID(),activationId:randomUUID()},
    contributions:[materialRetrievalIndexDeclaration],factory:createMaterialRetrievalIndexFactory(platform,value=>{bindings=value;}),
  });
  const retrievalLease=await host.acquire(centralServices.retrievalIndex,bindings!.retrievalIndex);
  const indexLease=await host.acquire(centralServices.materialIndex,bindings!.materialIndex);
  return {platform,handle,retrieval:retrievalLease.value,index:indexLease.value,async close(){await retrievalLease.release();await indexLease.release();await handle.close('disabled');}};
}

function draft(text='Generated searchable material body',externalId='generated-material',memberId?:string):MaterialDraft{
  return {id:materialId('generated-source',externalId),kind:'mote.message',schemaVersion:1,title:'Generated Material',
    origin:{sourceId:'generated-source',externalId,firstAt:'2026-11-01T00:00:00.000Z',lastAt:'2026-11-01T00:00:00.000Z'},
    members:[memberId?{id:'original',kind:'capture',ref:'capture:'+memberId}:{id:'original',kind:'source-item',ref:'source-item:generated-source:original',revision:'v1'}],
    blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:['original'],locator:{start:2,end:19}}],
    coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
}

async function ingest(store:Store,id:string,ocrText:string){
  await store.ingest({id,deviceId:'generated-device',deviceName:'Generated device',platform:'import',capturedAt:'2026-11-01T00:00:00Z',source:'note',ocrText,durationMs:0});
}

function profile(t:test.TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-retrieval-index-')),host=new PluginHost({kind:'central',id:'generated-retrieval-index-host'});
  let store=new Store(directory);
  t.after(async()=>{await host.close();if(store.db.isOpen)store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,host,get store(){return store;},reopen(){store.close();store=new Store(directory);return store;}};
}

test('EvidenceReader consumes leased index output: current revision and scope only, deleted excluded',async t=>{
  const f=profile(t),engine=new ExecutionEngine(f.store),materials=new MaterialStore(f.store);
  t.after(async()=>{await engine.close();});
  const current=await install(f.host,f.store,materials,engine);t.after(()=>current.close());
  const reader=new EvidenceReader(f.store,new SourceStore(f.store),undefined,current.retrieval,undefined,materials);
  t.after(()=>reader.dispose());
  const memberId=randomUUID();await ingest(f.store,memberId,'Generated member capture body');
  const input=draft('Generated searchable material body','generated-material',memberId),first=materials.publish(input);
  materials.setSearchable(input.id,true);
  await current.index.tick();
  assert.equal(materials.get(input.id)?.indexing.state,'indexed');
  const captureId=randomUUID();await ingest(f.store,captureId,'Generated searchable activity marker');
  const search=await reader.search({query:'searchable activity'});
  assert.equal(search.retrieval.mode,'lexical');assert.equal(search[0]?.id,captureId);
  assert.equal((await reader.search({query:'searchable activity',deviceId:'other-device'})).length,0);
  const page=reader.materialRead({ref:first.ref});
  assert.equal(page.material.ref,first.ref);assert.match(page.text,/searchable material body/);
  assert.deepEqual(page.originalRefs,['capture:'+memberId]);
  assert.equal(reader.materialCatalog({query:'searchable material'}).items[0]?.ref,first.ref);
  assert.equal(reader.materialCatalog({query:'searchable material',sourceId:'other-source'}).items.length,0);
  const second=materials.publish({...input,blocks:[{...input.blocks[0]!,text:'Generated replacement material body'}]},{expectedRevision:first.revision});
  await current.index.tick();
  assert.equal(reader.materialCatalog({query:'searchable material'}).items.length,0);
  assert.equal(reader.materialCatalog({query:'replacement material'}).items[0]?.ref,second.ref);
  assert.equal(materials.forget(input.id),true);
  assert.equal(reader.materialCatalog({query:'replacement material'}).items.length,0);
  assert.throws(()=>reader.materialRead({ref:second.ref}),{statusCode:404});
  assert.deepEqual(materialRetrievalIndexContribution.provides.map(service=>service.id).sort(),[centralServices.retrievalIndex.id,centralServices.materialIndex.id].sort());
});

test('quiesce rejects new work while reads survive; stop fences queued steps; re-activation and restart reconcile without duplicates',async t=>{
  const f=profile(t);let materials=new MaterialStore(f.store),engine=new ExecutionEngine(f.store);
  t.after(async()=>{await engine.close();});
  let current=await install(f.host,f.store,materials,engine);
  const input=draft('Generated journey searchable body'),first=materials.publish(input);
  materials.setSearchable(input.id,true);await current.index.tick();
  assert.equal(materials.get(input.id)?.indexing.state,'indexed');
  await current.handle.quiesce('upgrade');
  assert.throws(()=>current.index.tick(),{statusCode:503});
  assert.throws(()=>current.index.retry(input.id),{statusCode:503});
  assert.throws(()=>current.retrieval.tick(),{statusCode:503});
  assert.throws(()=>current.retrieval.retry(),{statusCode:503});
  assert.equal(current.retrieval.configured,false);
  const surviving=await current.retrieval.search({query:'journey'});
  assert.equal(surviving.retrieval.mode,'lexical');assert.equal(surviving.length,0);
  assert.equal(materials.list({query:'journey searchable'}).items[0]?.ref,first.ref);
  const second=materials.publish({...input,blocks:[{...input.blocks[0]!,text:'Generated second revision body'}]},{expectedRevision:first.revision});
  const request=f.store.db.prepare('SELECT revision,generation FROM material_index_requests WHERE material_id=?').get(input.id) as {revision:string;generation:number};
  const stepId=`material-index:${input.id}:${request.generation}`;
  engine.enqueue(`material-index:${input.id}`,'material.index',{materialId:input.id,revision:request.revision,generation:request.generation},{id:stepId,generation:{slot:'index',version:String(request.generation)}});
  await current.close();
  assert.equal(engine.get(stepId)?.state,'waiting');
  assert.throws(()=>current.index.tick());
  assert.throws(()=>{void current.retrieval.search({});});
  assert.equal(materials.list({query:'second revision'}).items.length,0);
  current=await install(f.host,f.store,materials,engine);
  await current.index.tick();
  assert.equal(engine.get(stepId)?.state,'succeeded');
  assert.equal(materials.get(input.id)?.indexing.state,'indexed');
  assert.equal(materials.list({query:'second revision'}).items[0]?.ref,second.ref);
  assert.equal(materials.list({query:'journey searchable'}).items.length,0);
  const third=materials.publish({...input,blocks:[{...input.blocks[0]!,text:'Generated third revision body'}]},{expectedRevision:second.revision});
  await current.close();await engine.close();
  const reopened=f.reopen();materials=new MaterialStore(reopened);engine=new ExecutionEngine(reopened);
  current=await install(f.host,reopened,materials,engine);
  await current.index.tick();
  assert.equal(materials.get(input.id)?.indexing.state,'indexed');
  const steps=f.store.db.prepare("SELECT state FROM execution_steps WHERE kind='material.index'").all() as {state:string}[];
  assert.equal(steps.length,3);assert.ok(steps.every(row=>row.state==='succeeded'));
  assert.equal(materials.list({query:'third revision'}).items[0]?.ref,third.ref);
  await current.close();
});

test('a failed index input stays visibly failed while independent inputs continue',async t=>{
  const f=profile(t),engine=new ExecutionEngine(f.store),materials=new MaterialStore(f.store);
  t.after(async()=>{await engine.close();});
  const current=await install(f.host,f.store,materials,engine);t.after(()=>current.close());
  const good=draft('Generated healthy searchable body','good-input'),broken=draft('Generated doomed searchable body','broken-input');
  const publishedGood=materials.publish(good);materials.publish(broken);
  materials.setSearchable(good.id,true);materials.setSearchable(broken.id,true);
  const prepare=f.store.db.prepare.bind(f.store.db);
  t.mock.method(f.store.db,'prepare',(sql:string,...args:unknown[])=>{
    const statement=prepare(sql,...args as []);
    if(!sql.includes('material_blocks'))return statement;
    return new Proxy(statement,{get:(target,property)=>{
      const value=Reflect.get(target,property);
      if(property!=='all')return typeof value==='function'?value.bind(target):value;
      return(...runArgs:unknown[])=>{if(runArgs[0]===broken.id)throw Error('Generated per-input index failure');return target.all(...runArgs as []);};
    }});
  });
  await current.index.tick();
  assert.equal(materials.get(good.id)?.indexing.state,'indexed');
  assert.equal(materials.get(broken.id)?.indexing.state,'failed');
  assert.equal(materials.get(broken.id)?.indexing.reason,'material_index_failed');
  assert.equal(materials.list({query:'healthy searchable'}).items[0]?.ref,publishedGood.ref);
  assert.equal(materials.list({query:'doomed searchable'}).items.length,0);
  assert.throws(()=>current.index.retry('generated-missing-material'),{statusCode:404});
  assert.equal(current.index.retry(broken.id).state,'pending');
  await current.index.tick();
  assert.equal(materials.get(broken.id)?.indexing.state,'failed');
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE kind='material.index' AND id LIKE ?").get(`material-index:${broken.id}:%`)!.n,1);
});

test('failed prepare rolls back its handler registrations so a clean activation succeeds',async t=>{
  const f=profile(t),engine=new ExecutionEngine(f.store),materials=new MaterialStore(f.store);
  t.after(async()=>{await engine.close();});
  const release=engine.register({kind:'material.index',pool:'material.index',concurrency:()=>1,validate:()=>false,execute:async()=>({}),commit:()=>{}});
  await assert.rejects(install(f.host,f.store,materials,engine),/Duplicate execution handler/);
  assert.equal(f.store.db.isOpen,true);
  await release();
  const current=await install(f.host,f.store,materials,engine);t.after(()=>current.close());
  const input=draft();materials.publish(input);materials.setSearchable(input.id,true);
  await current.index.tick();
  assert.equal(materials.get(input.id)?.indexing.state,'indexed');
});
