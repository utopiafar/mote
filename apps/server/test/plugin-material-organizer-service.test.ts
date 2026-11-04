import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PluginHost} from '@mote/plugin-host';
import {Store} from '../src/store.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {SourceStore} from '../src/sources.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {MaterialMemoryWork} from '../src/material-memory-work.js';
import {CAPTURE_RAW_READER_VERSION} from '../src/capture-raw-reader.js';
import {centralServices,type CommitAuthority,type CommitAuthorization} from '../src/plugins/central-contracts.js';
import {createMaterialOrganizerService,materialOrganizerServiceContribution} from '../src/plugins/material-organizer-service.js';
import {createMaterialRepository,createMaterialRepositoryFactory,materialRepositoryDeclaration,type MaterialRepositoryBindings} from '../src/plugins/material-repository.js';

const sourceId='generated-organizer-source',externalId='generated-item';
const item=(revision='1',text='Generated source item body')=>({externalId,revision,observedAt:'2026-11-03T01:00:00Z',title:'Generated item',text,kind:'message' as const,layer:'original' as const});

function authorization(){
  const token=Object.freeze({fixture:'generated organizer authority'}) as unknown as CommitAuthority;
  return {token,authorization:{capture:()=>token,assertCurrent(){}} satisfies CommitAuthorization};
}

async function installRepository(host:PluginHost,store:Store,authorization:CommitAuthorization){
  const platform=createMaterialRepository(store,authorization);let bindings:MaterialRepositoryBindings|undefined;
  const handle=await host.install({
    identity:{host:host.identity,packageId:'generated.material-repository',installationId:randomUUID(),instanceId:randomUUID(),activationId:randomUUID()},
    contributions:[materialRepositoryDeclaration],factory:createMaterialRepositoryFactory(platform,value=>{bindings=value;}),
  });
  const lease=await host.acquire(centralServices.materialRepository,bindings!.repository);
  return {platform,handle,repository:lease.value as MaterialStore,async close(){await lease.release();await handle.close('disabled');}};
}

function profile(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-material-organizer-service-')),host=new PluginHost({kind:'central',id:'generated-organizer-service-host'});
  const cleanup:Array<()=>Promise<unknown>|unknown>=[];
  let store=new Store(directory);
  t.after(async()=>{for(const close of cleanup.reverse())await close();await host.close();if(store.db.isOpen)store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,host,cleanup,get store(){return store;},reopen(){store.close();store=new Store(directory);return store;}};
}

function countedMemory(work:MaterialMemoryWork){
  let observes=0;
  return {memory:{observe:(...args:Parameters<MaterialMemoryWork['observe']>)=>{observes++;return work.observe(...args);},
    withdraw:(id:string)=>work.withdraw(id)},get observes(){return observes;}};
}

const noPoll=()=>()=>{};

test('a real source-item recipe output publishes through the leased repository and is read by EvidenceReader',async t=>{
  const f=profile(t),auth=authorization(),repository=await installRepository(f.host,f.store,auth.authorization);
  const materials=repository.repository,engine=new ExecutionEngine(f.store),work=new MaterialMemoryWork(f.store,materials);
  const memory=countedMemory(work),sources=new SourceStore(f.store,undefined,work.inputs);
  const platform=createMaterialOrganizerService({store:f.store,materials,executor:engine,memoryCandidates:memory.memory});
  f.cleanup.push(()=>engine.close(),()=>repository.close(),()=>work.dispose(),()=>platform.close());
  platform.prepare();platform.start(noPoll);
  sources.register({id:sourceId,name:'Generated source',kind:'custom',deviceId:'generated-device',platform:'import',retention:'archive'});
  const receipt=await sources.upsert(sourceId,item());
  assert.equal(await platform.tick(20),1);
  const id=materialId(sourceId,externalId),record=repository.repository.get(id);
  assert.ok(record);
  assert.equal(record.origin.sourceId,sourceId);assert.equal(record.origin.externalId,externalId);
  assert.equal(record.origin.deviceId,'generated-device');assert.equal(record.origin.firstAt,'2026-11-03T01:00:00.000Z');
  assert.equal(record.title,'Generated item');assert.equal(record.coverage.state,'complete');
  const page=repository.repository.read(record.ref);assert.match(page.text,/Generated source item body/);
  assert.equal(page.material.revision,record.revision);
  const members=repository.repository.members(record.ref);
  assert.deepEqual(members.items.map(member=>member.ref),[`capture:${receipt.id}`]);
  const reader=new EvidenceReader(f.store,new SourceStore(f.store),undefined,undefined,undefined,materials,undefined,platform.sourceItemRecipes);
  const read=reader.materialRead({ref:record.ref});
  assert.equal(read.material.revision,record.revision);assert.match(read.text,/Generated source item body/);
  assert.deepEqual(read.originalRefs,[`capture:${receipt.id}`]);reader.dispose();
  assert.deepEqual(materialOrganizerServiceContribution.requires.map(requirement=>requirement.id),[
    'mote.vault-platform',centralServices.execution.id,centralServices.materialRepository.id,centralServices.memoryCandidates.id]);

  platform.sourceItemRecipes.registry.uninstallComponent('mote.capture-raw-reader');
  await sources.upsert(sourceId,item('2','Generated unpublished revision'));
  await assert.rejects(platform.tick(20),/recipe|component/i);
  assert.equal(materials.get(id)?.revision,record.revision,'the failed epoch cannot replace the current head');
  platform.sourceItemRecipes.registry.installComponent({id:'mote.capture-raw-reader',version:CAPTURE_RAW_READER_VERSION,kind:'raw-reader'});
  await platform.tick(20);
  const revised=repository.repository.get(id)!;assert.notEqual(revised.revision,record.revision);
  assert.match(repository.repository.read(revised.ref).text,/Generated unpublished revision/);
  assert.equal(memory.observes,2);
});

test('deactivation fences in-flight backlog, recipe epochs rebuild only valid work, and a checkpoint replay is idempotent',async t=>{
  const f=profile(t),materials=new MaterialStore(f.store),engine=new ExecutionEngine(f.store),work=new MaterialMemoryWork(f.store,materials);
  const memory=countedMemory(work),sources=new SourceStore(f.store,undefined,work.inputs);
  sources.register({id:sourceId,name:'Generated source',kind:'custom',deviceId:'generated-device',platform:'import',retention:'archive'});
  let platform=createMaterialOrganizerService({store:f.store,materials,executor:engine,memoryCandidates:memory.memory});
  platform.prepare();platform.start(noPoll);
  const open=()=>{const current=createMaterialOrganizerService({store:f.store,materials,executor:engine,memoryCandidates:memory.memory});current.prepare();current.start(noPoll);return current;};
  const id=materialId(sourceId,externalId);
  const holdNextRead=(target:ReturnType<typeof createMaterialOrganizerService>)=>{
    const runtime=target.organizerForAssembly as unknown as {readSourceHead:(sourceId:string,externalId:string,signal:AbortSignal)=>Promise<unknown>};
    const read=runtime.readSourceHead.bind(target.organizerForAssembly);
    let release!:()=>void,entered!:()=>void;
    const held=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
    runtime.readSourceHead=async(...args)=>{const value=await read(...args);entered();await held;return value;};
    return {started,release};
  };

  await sources.upsert(sourceId,item());
  const firstHold=holdNextRead(platform),firstTick=platform.tick(20);await firstHold.started;
  platform.quiesce();firstHold.release();await firstTick;
  assert.equal(materials.get(id),undefined,'a deactivated generation cannot publish its late result');
  assert.ok(f.store.db.prepare("SELECT 1 FROM execution_steps WHERE kind='material.organizer' AND state='stale'").get());
  assert.throws(()=>platform.tick(20),{statusCode:503});
  await platform.stop();

  platform=open();
  await platform.tick(20);
  const first=materials.get(id);assert.ok(first);assert.match(materials.read(first.ref).text,/Generated source item body/);
  assert.equal(memory.observes,1);

  await sources.upsert(sourceId,item('2','Generated second revision'));
  const epochHold=holdNextRead(platform),epochTick=platform.tick(20);await epochHold.started;
  platform.sourceItemRecipes.registry.uninstallComponent('mote.capture-raw-reader');
  epochHold.release();await epochTick;
  assert.equal(materials.get(id)?.revision,first.revision,'a changed recipe epoch cannot publish the old result');
  platform.sourceItemRecipes.registry.installComponent({id:'mote.capture-raw-reader',version:CAPTURE_RAW_READER_VERSION,kind:'raw-reader'});
  await platform.tick(20);
  const second=materials.get(id)!;assert.notEqual(second.revision,first.revision);
  assert.match(materials.read(second.ref).text,/Generated second revision/);
  assert.equal(memory.observes,2,'only the valid replacement notifies Memory');

  let builds=0;const organizer=platform.organizerForAssembly.registry.get('mote.source-item')!,build=organizer.build;
  organizer.build=(...args)=>{builds++;return build(...args);};
  const steps=f.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE kind='material.organizer'").get()!.n;
  f.store.db.prepare("UPDATE settings SET value='0' WHERE key='material-organizer-cursor'").run();
  await platform.tick(20);
  assert.equal(builds,0,'a replayed checkpoint does not organize again');
  assert.equal(memory.observes,2,'a replayed checkpoint does not notify Memory again');
  assert.equal(materials.get(id)?.revision,second.revision);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE kind='material.organizer'").get()!.n,steps);

  await platform.close();await engine.close();work.dispose();
  const reopened=f.reopen();
  const restartedMaterials=new MaterialStore(reopened),restartedEngine=new ExecutionEngine(reopened),restartedWork=new MaterialMemoryWork(reopened,restartedMaterials);
  const restarted=createMaterialOrganizerService({store:reopened,materials:restartedMaterials,executor:restartedEngine,memoryCandidates:countedMemory(restartedWork).memory});
  try{
    restarted.prepare();restarted.start(noPoll);await restarted.tick(20);
    assert.equal(restartedMaterials.get(id)?.revision,second.revision);
    assert.match(restartedMaterials.read(second.ref).text,/Generated second revision/);
  }finally{await restarted.close();restartedWork.dispose();await restartedEngine.close();}
});

test('a failed prepare releases the shared SQLite transaction and allows a clean activation',async t=>{
  const f=profile(t),materials=new MaterialStore(f.store),engine=new ExecutionEngine(f.store),work=new MaterialMemoryWork(f.store,materials);
  const exec=f.store.db.exec.bind(f.store.db);let fail=true;
  t.mock.method(f.store.db,'exec',(sql:string,...args:unknown[])=>{
    if(fail&&sql.includes('CREATE TABLE IF NOT EXISTS material_organizer_inputs'))throw Error('Generated organizer prepare failure');
    return exec(sql,...args as []);
  });
  const failed=createMaterialOrganizerService({store:f.store,materials,executor:engine,memoryCandidates:work});
  assert.throws(()=>failed.prepare(),/Generated organizer prepare failure/);
  assert.equal(f.store.db.isOpen,true);assert.equal(f.store.db.isTransaction,false);
  fail=false;
  const platform=createMaterialOrganizerService({store:f.store,materials,executor:engine,memoryCandidates:work});
  platform.prepare();platform.start(noPoll);
  const sources=new SourceStore(f.store,undefined,work.inputs);
  sources.register({id:sourceId,name:'Generated source',kind:'custom',deviceId:'generated-device',platform:'import',retention:'archive'});
  await sources.upsert(sourceId,item());
  await platform.tick(20);
  assert.ok(materials.get(materialId(sourceId,externalId)));
  await platform.close();work.dispose();await engine.close();
});
