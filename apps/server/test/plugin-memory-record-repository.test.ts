import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PluginHost} from '@mote/plugin-host';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {PluginCenter} from '../src/plugin-center.js';
import {GitHubPluginReleases} from '../src/plugin-release.js';
import {MemoryAutomation} from '../src/memory-automation.js';
import {MemoryBindings} from '../src/memory-bindings.js';
import {memoryBodyDigest,memoryProviderKey} from '../src/memory-provider-contract.js';
import type {QueryResult} from '@mote/shared';
import type {MemoryStore} from '../src/memory.js';
import {centralServices} from '../src/plugins/central-contracts.js';
import {
  createMemoryRecordRepository,createMemoryRecordRepositoryFactory,memoryRecordRepositoryContribution,
  memoryRecordRepositoryDeclaration,type MemoryRecordRepositoryBindings,
} from '../src/plugins/memory-record-repository.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';

function profile(t:test.TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-record-repository-')),vault=join(directory,'vault');
  let host=new PluginHost({kind:'central',id:'generated-memory-record-host'}),store=new Store(vault);
  t.after(async()=>{await host.close();if(store.db.isOpen)store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,host,get store(){return store;},
    async restart(){await host.close();store.close();host=new PluginHost({kind:'central',id:'generated-memory-record-host'});store=new Store(vault);return {host,store};}};
}

async function install(host:PluginHost,store:Store){
  const platform=createMemoryRecordRepository(store);let bindings:MemoryRecordRepositoryBindings|undefined;
  const handle=await host.install({
    identity:{host:host.identity,packageId:'generated.memory-record-repository',installationId:randomUUID(),instanceId:randomUUID(),activationId:randomUUID()},
    contributions:[memoryRecordRepositoryDeclaration],factory:createMemoryRecordRepositoryFactory(platform,value=>{bindings=value;}),
  });
  const recordsLease=await host.acquire(centralServices.memoryRecords,bindings!.records);
  const snapshotsLease=await host.acquire(centralServices.memoryRecordSnapshots,bindings!.snapshots);
  return {platform,handle,records:recordsLease.value,snapshots:snapshotsLease.value,async close(){await recordsLease.release();await snapshotsLease.release();await handle.close('disabled');}};
}

async function evidence(store:Store,text:string){
  const id=randomUUID(),at='2026-11-01T00:00:00.000Z';
  await store.ingest({id,deviceId:'generated-device',deviceName:'Generated device',platform:'import',source:'message',capturedAt:at,durationMs:0,appId:'generated.notes',appName:'Generated Notes',ocrText:text,
    provenance:{sourceId:'generated-notes',externalId:id,revision:'1',layer:'original'},privacy:{excluded:false,redacted:false,mode:'none'}});
  return store.evidence([id])[0]!;
}

function extraction(record:ReturnType<Store['evidence']>[number],memories:MemoryStore,runId=randomUUID()):QueryResult {
  return fixtureMemoryResult(memories,{
    answer:JSON.stringify({memories:[{title:'Generated record',statement:`Generated statement [${record.id}]`,uncertainty:'Generated fixture only',evidenceIds:[record.id],evidence:[{id:record.id,quote:record.ocrText}]}]}),
    citations:[{id:record.id,capturedAt:record.capturedAt,appName:'Generated',excerpt:record.ocrText}],trace:[],runId});
}

test('repository owns record lifecycle: write, read and revise survive re-enable and restart, and a closed repository fails visibly',async t=>{
  const f=profile(t),current=await install(f.host,f.store);
  assert.deepEqual(memoryRecordRepositoryContribution.provides.map(service=>service.id).sort(),[centralServices.memoryRecordSnapshots.id,centralServices.memoryRecords.id].sort());
  const record=await evidence(f.store,'Generated telescope observation stays exact.'),saved=current.platform.storeForAssembly.extract(extraction(record,current.platform.storeForAssembly),'fixture').items[0]!;
  assert.equal(current.records.memoryRecord(saved.id).status,'proposed');
  assert.equal(current.records.memoryRecordCount(),1);
  const revised=current.platform.storeForAssembly.publish(saved.id,saved.version);
  assert.equal(revised.id,saved.id);assert.equal(revised.version,2);assert.equal(revised.status,'published');assert.ok(revised.updatedAt);
  assert.equal(current.records.memoryRecordText(saved.id).includes(saved.statement),true);
  const before=current.snapshots.retainMemoryRecordSnapshot([saved.id]);
  assert.deepEqual(before.ids,[saved.id]);assert.equal(before.keys[saved.id]!.version,2);assert.equal(before.hostStates[saved.id]!.status,'published');

  await current.handle.quiesce('upgrade');
  assert.equal(current.records.memoryRecord(saved.id).id,saved.id);
  await current.close();
  assert.throws(()=>current.platform.records.memoryRecord(saved.id),{statusCode:503});
  assert.throws(()=>current.platform.snapshots.retainMemoryRecordSnapshot([saved.id]),{statusCode:503});
  assert.throws(()=>current.platform.storeForAssembly,{statusCode:503});
  assert.throws(()=>current.records.memoryRecord(saved.id),{code:'stale_scope'});
  assert.equal(before.records[saved.id]!.statement,saved.statement);

  // Re-enabling installs a new activation against the same profile; retained
  // bodies do not need a process restart.
  const enabled=await install(f.host,f.store),replayed=enabled.records.memoryRecord(saved.id);
  assert.equal(replayed.version,2);assert.equal(replayed.fingerprint,saved.fingerprint);assert.equal(replayed.statement,saved.statement);
  await enabled.close();

  // A full restart must preserve the identity, revision, body and host state.
  const restarted=await f.restart(),after=await install(restarted.host,restarted.store),restored=after.records.memoryRecord(saved.id);
  assert.deepEqual({id:restored.id,version:restored.version,status:restored.status,title:restored.title,statement:restored.statement,updatedAt:restored.updatedAt,model:restored.model},
    {id:saved.id,version:2,status:'published',title:saved.title,statement:saved.statement,updatedAt:revised.updatedAt,model:'fixture'});
  assert.deepEqual(after.snapshots.retainMemoryRecordSnapshot([saved.id]).digests[saved.id],before.digests[saved.id]);
  await after.close();
});

test('a failed record transaction and an unavailable prepare leave no partial records or leaked lock; the visible error is the failure',async t=>{
  const f=profile(t),current=await install(f.host,f.store),memories=current.platform.storeForAssembly;
  const record=await evidence(f.store,'Generated transaction observation.'),result=extraction(record,memories);
  const staged=memories.prepareExtract(result,'fixture'),tampered={...staged,items:staged.items.map(item=>({...item,title:'Altered staged body'}))};
  assert.throws(()=>memories.extract(result,'fixture',{prepared:tampered}),{statusCode:409});
  assert.equal(memories.count(),0);
  assert.equal(Number(f.store.db.prepare('SELECT count(*) n FROM memory_catalog').get()!.n),0);
  assert.equal(Number(f.store.db.prepare('SELECT count(*) n FROM memory_dependencies').get()!.n),0);
  assert.equal(f.store.db.isTransaction,false);
  const committed=memories.extract(result,'fixture').items[0]!;
  assert.equal(memories.count(),1);
  assert.throws(()=>current.records.memoryRecord(randomUUID()),{statusCode:404});

  // A prepare that fails inside a caller transaction must not claim or break it.
  const store=new Store(f.directory+'/generated-failure'),blocked=createMemoryRecordRepository(store);
  store.db.exec('BEGIN IMMEDIATE');
  await assert.rejects(blocked.prepare(),{statusCode:503});
  assert.equal(store.db.isTransaction,true);
  store.db.exec('ROLLBACK');
  assert.throws(()=>blocked.storeForAssembly,{statusCode:503});
  // The same closure stays failed and no lease is handed out.
  await assert.rejects(blocked.prepare());
  await blocked.close();
  assert.equal(store.db.isTransaction,false);store.close();
  assert.equal(committed.id,memories.get(committed.id).id);
});

test('repository output is consumed by MemoryBindings and the read-only catalog with identical key, body digest and host state',async t=>{
  const f=profile(t),current=await install(f.host,f.store),memories=current.platform.storeForAssembly;
  const first=await evidence(f.store,'Generated first observation.'),second=await evidence(f.store,'Generated second observation.');
  const a=memories.extract(extraction(first,memories),'fixture').items[0]!,b=memories.extract(extraction(second,memories),'fixture').items[0]!;
  memories.publish(a.id,a.version);
  const executor=new ExecutionEngine(f.store),plugins=new PluginCenter(f.store,executor,new GitHubPluginReleases(join(f.directory,'packages')));
  const bindings=new MemoryBindings(f.store,memories,new MemoryAutomation(f.store),plugins,executor);
  t.after(async()=>{await bindings.close();await plugins.close();await executor.close();});
  const snapshot=bindings.retainSnapshot();
  try{
    for(const id of [a.id,b.id]){
      const record=current.records.memoryRecord(id),catalog=JSON.parse(String(f.store.db.prepare('SELECT json FROM memory_catalog WHERE id=?').get(id)!.json)) as {status:string;version:number;revision:string;title:string};
      assert.deepEqual(snapshot.catalog[id],memoryProviderKey(record));
      assert.equal(snapshot.recordDigests[id],memoryBodyDigest(record));
      assert.deepEqual({status:snapshot.metadata[id]!.status,updatedAt:snapshot.metadata[id]!.updatedAt},{status:record.status,updatedAt:record.updatedAt});
      assert.equal(catalog.status,record.status);assert.equal(catalog.version,record.version);assert.equal(catalog.revision,record.fingerprint);assert.equal(catalog.title,record.title);
    }
    // The local repository snapshot projects the same immutable facts.
    const local=current.snapshots.retainMemoryRecordSnapshot([a.id,b.id]);
    try{for(const id of [a.id,b.id]){assert.deepEqual(local.keys[id],snapshot.catalog[id]);assert.equal(local.digests[id],snapshot.recordDigests[id]);assert.equal(local.hostStates[id]!.status,snapshot.metadata[id]!.status);assert.equal(local.hostStates[id]!.updatedAt,snapshot.metadata[id]!.updatedAt);}}finally{local.release();}
  }finally{snapshot.release();}
  await current.close();
  assert.throws(()=>current.platform.records.memoryRecordPage(),{statusCode:503});
  assert.throws(()=>current.platform.snapshots.retainMemoryRecordSnapshot(),{statusCode:503});
});
