import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PluginHost} from '@mote/plugin-host';
import type {ServiceLease} from '@mote/plugin-api/contracts';
import {Store} from '../src/store.js';
import {MemoryStore} from '../src/memory.js';
import {memorySchema,type Memory} from '../src/memory-schema.js';
import type {MemoryBindings} from '../src/memory-bindings.js';
import {memoryBodyDigest,memoryProviderKey,type MemoryProvider,type MemoryProviderNamespace} from '../src/memory-provider-contract.js';
import {centralServices,checkCentralServiceDeclarations} from '../src/plugins/central-contracts.js';
import {
  createMemoryPublication,createMemoryPublicationFactory,memoryPublicationContribution,
  memoryPublicationDeclaration,type MemoryPublicationBindings,
} from '../src/plugins/memory-publication.js';

const namespace:MemoryProviderNamespace={ownerId:'generated-owner',instanceId:'generated-instance',bindingRevision:1};

function generatedMemory(statement:string):Memory{
  return memorySchema.parse({id:randomUUID(),version:1,fingerprint:randomUUID().replaceAll('-','').padEnd(64,'0'),createdAt:'2026-10-12T00:00:00Z',title:'Generated publication',statement,uncertainty:'Generated fixture only',status:'published',domain:'personal',tier:'episode',kind:'episodic',model:'fixture',runId:'fixture',evidenceIds:[randomUUID()],evidence:[],admission:{layer:'memory',reason:'Generated fixture',scope:'Generated fixture only',attribution:'observed'}});
}

function bindings(provider:MemoryProvider):MemoryBindings{
  const binding={planId:'instance:generated',generation:1,namespace};
  return {
    binding:()=>structuredClone(binding),
    provider:()=>provider,
    plugins:{references:()=>[]},
    assertNewManualWork:()=>{},
  } as unknown as MemoryBindings;
}

/** Backup stubs expose the same pinned snapshot shape the real binding mints;
 * `driftOnce` makes the post-export revision check observe one changed body. */
function backupBindings(provider:MemoryProvider,records:Memory[],options:{namespace?:MemoryProviderNamespace;driftOnce?:boolean}={}):MemoryBindings{
  const binding=options.namespace?{planId:'instance:generated',generation:1,namespace:options.namespace}:{planId:'mote.builtin',generation:1};
  const catalog=Object.fromEntries(records.map(memory=>[memory.id,memoryProviderKey(memory)])),recordDigests=Object.fromEntries(records.map(memory=>[memory.id,memoryBodyDigest(memory)])),metadata=Object.fromEntries(records.map(memory=>[memory.id,{status:memory.status,...(memory.staleReason===undefined?{}:{staleReason:memory.staleReason}),...(memory.updatedAt===undefined?{}:{updatedAt:memory.updatedAt})}]));
  let drift=options.driftOnce?1:0;
  return {
    binding:()=>structuredClone(binding),
    retainSnapshot(){
      const current=drift-- > 0?{...metadata,[records[0]!.id]:{...metadata[records[0]!.id],updatedAt:'2026-10-12T00:00:01Z'}}:metadata;
      return {binding:structuredClone(binding),catalog,recordDigests,metadata:current,records:options.namespace?undefined:Object.fromEntries(records.map(memory=>[memory.id,memory])),release(){}};
    },
    provider:()=>provider,
    plugins:{references:()=>[]},
    assertNewManualWork:()=>{},
  } as unknown as MemoryBindings;
}

async function generatedProvider(file:string,options:{loseAck?:boolean;tamper?:()=>boolean}={}){
  let puts=0;
  const state=async()=>{try{return JSON.parse(await readFile(file,'utf8')) as Record<string,Memory>;}catch{return {};}};
  const provider:MemoryProvider={
    async put(input){const records=await state();records[JSON.stringify(input.key)]=input.memory;await writeFile(file,JSON.stringify(records));puts++;if(options.loseAck)throw Error('Generated committed write lost acknowledgement');return {opId:input.opId,namespace:input.namespace,key:input.key,payloadDigest:memoryBodyDigest(input.memory),state:'applied',eraseVerified:false,recordedAt:'2026-10-12T00:00:00Z'};},
    async read(input){const value=(await state())[JSON.stringify(input.key)];return value&&options.tamper?.()?{...value,statement:'Generated substituted body under the same key'}:value??null;},
    async export(input){return Object.entries(await state()).map(([key,memory])=>({namespace:input.namespace,key:JSON.parse(key),memory}));},
    async remove(){},
  } as MemoryProvider;
  return {provider,puts:()=>puts};
}

test('lost remote acknowledgement stays an unknown submitted write until an exact digest is observed after restart, without a second semantic write or rollback',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-publication-plugin-ack-')),vault=join(directory,'vault'),stateFile=join(directory,'provider.json'),memory=generatedMemory('Generated lost acknowledgement body.');
  t.after(()=>rm(directory,{recursive:true,force:true}));
  let store=new Store(vault),memories=new MemoryStore(store),native=await generatedProvider(stateFile,{loseAck:true});
  let platform=createMemoryPublication({store,memories,bindings:bindings(native.provider)});
  platform.prepare();platform.start();
  const operationId='generated-lost-ack';
  // stageRecords is part of the publication implementation, not the stage port.
  await assert.rejects(()=>platform.publication.stageRecords(operationId,[memory],()=>{}),/lost acknowledgement/);
  const submitted=store.db.prepare("SELECT id,json,state FROM memory_provider_writes WHERE state='submitted'").get()!;
  assert.ok(submitted,'the remote intent remains visible after the lost reply');
  assert.equal(JSON.parse(String(submitted.json)).bodyDigest,memoryBodyDigest(memory));
  assert.equal(native.puts(),1,'the commit happened exactly once');
  assert.equal(platform.publication.pending(),1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM memories').get()!.n,0,'a submitted remote write is not host-visible');
  await platform.close();store.close();

  // Restart the host against the same profile. A divergent body under the
  // committed key must not acknowledge or roll back the write.
  store=new Store(vault);memories=new MemoryStore(store);
  native=await generatedProvider(stateFile,{tamper:()=>true});
  platform=createMemoryPublication({store,memories,bindings:bindings(native.provider)});
  platform.prepare();platform.start();
  await platform.publication.reconcile();
  assert.equal(store.db.prepare('SELECT state FROM memory_provider_writes WHERE id=?').get(submitted.id)?.state,'submitted','only the exact reviewed digest is accepted');
  assert.equal(native.puts(),0,'reconciliation never replays the semantic write');
  assert.equal(platform.publication.pending(),1);
  await platform.close();store.close();

  store=new Store(vault);memories=new MemoryStore(store);
  native=await generatedProvider(stateFile);
  platform=createMemoryPublication({store,memories,bindings:bindings(native.provider)});
  platform.prepare();platform.start();
  await platform.publication.reconcile();
  assert.equal(store.db.prepare('SELECT state FROM memory_provider_writes WHERE id=?').get(submitted.id)?.state,'acknowledged');
  assert.equal(platform.publication.pending(),0);
  assert.equal(native.puts(),0,'the recovered body is read, never written twice');
  assert.deepEqual(await bindings(native.provider).provider(namespace.instanceId,namespace).read({namespace,key:memoryProviderKey(memory)}),memory);
  await platform.close();store.close();
});

test('publication lifecycle quiesces new stages, re-enables on the same profile and keeps committed writes after process restart',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-publication-plugin-life-')),vault=join(directory,'vault'),stateFile=join(directory,'provider.json');
  t.after(()=>rm(directory,{recursive:true,force:true}));
  let store=new Store(vault),memories=new MemoryStore(store),native=await generatedProvider(stateFile);
  let platform=createMemoryPublication({store,memories,bindings:bindings(native.provider)});
  platform.prepare();platform.start();
  const first=generatedMemory('Generated lifecycle first body.');
  await platform.publication.stageRecords('generated-life-first',[first],()=>{});
  platform.quiesce('disabled');
  assert.throws(()=>platform.port.stage.retainOutput('generated-life-blocked',{}),{statusCode:503});
  await platform.stop('disabled');
  platform.prepare();platform.start();
  const second=generatedMemory('Generated lifecycle second body.');
  await platform.publication.stageRecords('generated-life-second',[second],()=>{});
  assert.equal(platform.publication.pending(),0);
  await platform.close();store.close();

  store=new Store(vault);memories=new MemoryStore(store);
  native=await generatedProvider(stateFile);
  platform=createMemoryPublication({store,memories,bindings:bindings(native.provider)});
  platform.prepare();platform.start();
  const provider=bindings(native.provider).provider(namespace.instanceId,namespace);
  for(const memory of [first,second])assert.deepEqual(await provider.read({namespace,key:memoryProviderKey(memory)}),memory);
  await platform.close();store.close();
});

test('a failed prepare releases the database lock and leaves no live publication or timer',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-publication-plugin-failed-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new Store(join(directory,'vault')),memories=new MemoryStore(store);
  const brokenBindings={binding:()=>({planId:'instance:generated',generation:1,namespace}),assertNewManualWork:()=>{},get plugins(){throw Error('Generated publication reference failure');}} as unknown as MemoryBindings;
  const platform=createMemoryPublication({store,memories,bindings:brokenBindings});
  t.after(async()=>{await platform.close();store.close();});
  assert.throws(()=>platform.prepare(),/Generated publication reference failure/);
  assert.equal(store.db.isTransaction,false,'prepare failure leaves no database lock');
  assert.throws(()=>platform.publication,/unavailable/);
  await platform.close();
});

test('the host factory provides separate stage and owner services and fences new work after quiesce',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-publication-plugin-host-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new Store(join(directory,'vault')),memories=new MemoryStore(store),native=await generatedProvider(join(directory,'provider.json'));
  const platform=createMemoryPublication({store,memories,bindings:bindings(native.provider)});
  t.after(async()=>{await platform.close();store.close();});
  const issues=checkCentralServiceDeclarations(
    [memoryPublicationContribution.provides[0]!,memoryPublicationContribution.provides[1]!].map(service=>({service:{id:service.id,apiVersion:service.apiVersion},provider:{scope:{host:{kind:'central' as const,id:'generated'},packageId:'mote.memory-publication',installationId:'generated',instanceId:'memory-publication',activationId:'generated'},contributionId:memoryPublicationContribution.id}})),
    [{consumer:'mote.memory',service:centralServices.memoryStagePublication},{consumer:'mote.memory',service:centralServices.memoryOwnerPublication}]);
  assert.deepEqual(issues,[]);
  const host=new PluginHost({kind:'central',id:'generated-memory-publication-host'});
  t.after(()=>host.close());
  let bindingsValue:MemoryPublicationBindings|undefined;
  const handle=await host.install({identity:{host:host.identity,packageId:'mote.memory-publication',installationId:randomUUID(),instanceId:randomUUID(),activationId:randomUUID()},contributions:[memoryPublicationDeclaration],factory:createMemoryPublicationFactory(platform,value=>{bindingsValue=value;})});
  const stage:ServiceLease<typeof platform.port.stage>=await host.acquire(centralServices.memoryStagePublication,bindingsValue!.stage);
  const owner=await host.acquire(centralServices.memoryOwnerPublication,bindingsValue!.owner);
  assert.equal(typeof stage.value.stageExtract,'function');
  assert.equal(typeof owner.value.publish,'function');
  assert.doesNotThrow(()=>stage.value.retainOutput('generated-accepted',{}));
  await handle.quiesce('upgrade');
  assert.throws(()=>stage.value.retainOutput('generated-blocked',{}),{statusCode:503});
  assert.throws(()=>owner.value.publish('generated-missing'),{statusCode:503});
  await handle.close('disabled');
  await stage.release();await owner.release();
});

test('the backup contribution exports every host body, survives quiesce and retries a whole failed export without omissions',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-publication-plugin-backup-host-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new Store(join(directory,'vault')),memories=new MemoryStore(store),native=await generatedProvider(join(directory,'provider.json'));
  const first=generatedMemory('Generated host backup first body.'),second=generatedMemory('Generated host backup second body.');
  const platform=createMemoryPublication({store,memories,bindings:backupBindings(native.provider,[first,second])});
  t.after(async()=>{await platform.close();store.close();});
  platform.prepare();platform.start();
  assert.deepEqual(await platform.backup.export(),[first,second],'host records export without an external provider');
  platform.quiesce('upgrade');
  assert.deepEqual(await platform.backup.export(),[first,second],'accepted backup reads survive quiesce');
  await platform.stop('disabled');
  assert.throws(()=>platform.backup.export(),{statusCode:503});
  platform.prepare();platform.start();
  assert.deepEqual(await platform.backup.export(),[first,second],'the same profile re-enables the backup contribution');

  const retryStore=new Store(join(directory,'retry-vault')),retryMemories=new MemoryStore(retryStore);
  const retry=createMemoryPublication({store:retryStore,memories:retryMemories,bindings:backupBindings(native.provider,[first,second],{driftOnce:true})});
  t.after(async()=>{await retry.close();retryStore.close();});
  retry.prepare();retry.start();
  await assert.rejects(retry.backup.export(),{statusCode:409},'a changed body invalidates the whole archive, never a partial export');
  assert.deepEqual(await retry.backup.export(),[first,second],'a fresh retry includes every host body');
});

test('the host factory provides the backup service for bound instance bodies and rejects a corrupt provider export',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-publication-plugin-backup-instance-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new Store(join(directory,'vault')),memories=new MemoryStore(store),native=await generatedProvider(join(directory,'provider.json'));
  const memory=generatedMemory('Generated instance backup body.'),instance:MemoryProviderNamespace={ownerId:'generated-owner',instanceId:'generated-backup-instance',bindingRevision:1},stale=memorySchema.parse({...memory,status:'stale',staleReason:'evidence_changed',updatedAt:'2026-10-12T00:00:00Z'});
  await native.provider.put({namespace:instance,key:memoryProviderKey(memory),memory,opId:randomUUID()});
  const platform=createMemoryPublication({store,memories,bindings:backupBindings(native.provider,[stale],{namespace:instance})});
  const host=new PluginHost({kind:'central',id:'generated-memory-backup-host'});
  t.after(async()=>{await host.close();await platform.close();store.close();});
  const backupService=memoryPublicationContribution.provides[2]!;
  assert.deepEqual(checkCentralServiceDeclarations(
    [{service:{id:backupService.id,apiVersion:backupService.apiVersion},provider:{scope:{host:{kind:'central' as const,id:'generated'},packageId:'mote.memory-publication',installationId:'generated',instanceId:'memory-publication',activationId:'generated'},contributionId:memoryPublicationContribution.id}}],
    [{consumer:'mote.storage',service:centralServices.memoryBackup}]),[],'the publication contribution registers the backup service for storage export');
  let bindingsValue:MemoryPublicationBindings|undefined;
  const handle=await host.install({identity:{host:host.identity,packageId:'mote.memory-publication',installationId:randomUUID(),instanceId:randomUUID(),activationId:randomUUID()},contributions:[memoryPublicationDeclaration],factory:createMemoryPublicationFactory(platform,value=>{bindingsValue=value;})});
  const backup=await host.acquire(centralServices.memoryBackup,bindingsValue!.backup);
  assert.deepEqual(await backup.value.export(),[stale],'the instance namespace reads the exact provider body and applies host state');
  await handle.quiesce('upgrade');
  assert.deepEqual(await backup.value.export(),[stale]);
  await handle.close('disabled');
  assert.throws(()=>backup.value.export());
  await backup.release();

  const corruptStore=new Store(join(directory,'corrupt-vault')),corruptMemories=new MemoryStore(corruptStore),originalExport=native.provider.export.bind(native.provider);
  native.provider.export=async input=>(await originalExport(input)).map(record=>({...record,memory:{...record.memory,statement:'Generated corrupt backup body'}}));
  const corrupt=createMemoryPublication({store:corruptStore,memories:corruptMemories,bindings:backupBindings(native.provider,[stale],{namespace:instance})});
  t.after(async()=>{await corrupt.close();corruptStore.close();});
  corrupt.prepare();corrupt.start();
  await assert.rejects(corrupt.backup.export(),{statusCode:502},'a provider body that differs from the pinned catalog is never exported');
  native.provider.export=originalExport;
  assert.deepEqual(await corrupt.backup.export(),[stale],'a whole retry after the corrupt reply restores every body');
});
