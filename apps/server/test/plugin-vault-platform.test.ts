import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Store} from '../src/store.js';
import {StoreDatabase} from '../src/sqlite-database.js';
import {MemoryStore} from '../src/memory.js';
import type {MemoryBindings} from '../src/memory-bindings.js';
import {createMemoryPublication,createMemoryPublicationFactory,memoryPublicationDeclaration} from '../src/plugins/memory-publication.js';
import {materialId,type MaterialDraft} from '../src/materials.js';
import {FileStore} from '../src/files.js';
import {AssetStore} from '../src/assets.js';
import {MaintenanceWorker} from '../src/maintenance.js';
import {setImmediate} from 'node:timers/promises';
import {sha256} from '../src/store.js';
import {PluginHost} from '@mote/plugin-host';
import type {PluginScope,ScopeIdentity,ServiceBinding} from '@mote/plugin-api/contracts';
import {createVaultPlatform,createVaultPlatformAssembly,createVaultPlatformFactory,vaultPlatformContribution,vaultPlatformDeclaration} from '../src/plugins/vault-platform.js';
import {centralServices,type CommitAuthority,type CommitAuthorization} from '../src/plugins/central-contracts.js';
import * as vaultExports from '../src/plugins/vault-platform.js';


const contender = (directory: string) => spawnSync(process.execPath,['--input-type=module','-e',`
  import {DatabaseSync} from 'node:sqlite';
  const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=0');
  try{db.exec('BEGIN IMMEDIATE');process.stdout.write('acquired');db.exec('ROLLBACK');}
  catch(error){if(error.errcode!==5)throw error;process.stdout.write('locked');}finally{db.close();}
`,join(directory,'mote.sqlite')],{encoding:'utf8',timeout:5000});

test('schema initialization failure closes its own transaction and permits the same profile to reopen', t => {
  const directory=mkdtempSync(join(tmpdir(),'mote-vault-init-'));
  new Store(directory).close();
  let opened:StoreDatabase|undefined;
  t.after(()=>{if(opened?.isOpen)opened.close();rmSync(directory,{recursive:true,force:true});});
  const failure=new Error('generated controlled schema failure'),exec=StoreDatabase.prototype.exec;
  StoreDatabase.prototype.exec=function(sql:string){
    if(sql.includes('CREATE TABLE IF NOT EXISTS settings')){
      opened=this;exec.call(this,'BEGIN IMMEDIATE');throw failure;
    }
    return exec.call(this,sql);
  };
  try{assert.throws(()=>new Store(directory),error=>error===failure);}
  finally{StoreDatabase.prototype.exec=exec;}
  assert.ok(opened,'the failure must occur after opening the actual database');
  assert.equal(opened.isOpen,false,'constructor failure must close its own SQLite connection');
  const probe=contender(directory);assert.equal(probe.status,0,probe.stderr);assert.equal(probe.stdout,'acquired');
  const restarted=new Store(directory);restarted.close();
});

test('a first-ever partial schema failure leaves the new profile restartable without a format migration',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-vault-new-init-')),exec=StoreDatabase.prototype.exec;
  const failure=new Error('generated new-vault schema failure');
  t.after(()=>{StoreDatabase.prototype.exec=exec;rmSync(directory,{recursive:true,force:true});});
  StoreDatabase.prototype.exec=function(sql:string){const result=exec.call(this,sql);if(sql.includes('CREATE TABLE IF NOT EXISTS settings'))throw failure;return result;};
  try{assert.throws(()=>new Store(directory),error=>error===failure);}finally{StoreDatabase.prototype.exec=exec;}
  assert.equal(contender(directory).stdout,'acquired');
  const restarted=new Store(directory);try{assert.equal(restarted.stats().captures,0);}finally{restarted.close();}
});

test('initialization and cleanup failures retain both errors without closing another connection',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-vault-cleanup-errors-')),sibling=new Store(directory);
  const failure=new Error('generated initialization failure'),cleanup=new Error('generated close failure');
  const exec=StoreDatabase.prototype.exec,close=StoreDatabase.prototype.close;let opened:StoreDatabase|undefined;
  t.after(()=>{StoreDatabase.prototype.exec=exec;StoreDatabase.prototype.close=close;if(opened?.isOpen)close.call(opened);sibling.close();rmSync(directory,{recursive:true,force:true});});
  StoreDatabase.prototype.exec=function(sql:string){if(sql.includes('CREATE TABLE IF NOT EXISTS settings')){opened=this;throw failure;}return exec.call(this,sql);};
  StoreDatabase.prototype.close=function(){if(this===opened)throw cleanup;return close.call(this);};
  try{assert.throws(()=>new Store(directory),error=>error instanceof AggregateError&&error.cause===failure&&error.errors[0]===failure&&error.errors[1]===cleanup);}
  finally{StoreDatabase.prototype.exec=exec;StoreDatabase.prototype.close=close;}
  assert.equal(sibling.db.isOpen,true);assert.ok(sibling.stats());
});

// C04 is deliberately absent: this generated, revocable external boundary fixture
// tests invocation/failure propagation only, not production provenance or grant policy.
function boundary(){
  const token=Object.freeze({fixture:'generated admission'}) as unknown as CommitAuthority;
  let current=true,checks=0;
  const authorization:CommitAuthorization={capture(){if(!current)throw Error('fixture grant revoked');return token;},assertCurrent(value){checks++;if(!current||value!==token)throw Error('fixture grant revoked');}};
  return {authorization,token,revoke(){current=false;},get checks(){return checks;}};
}
function consumer(name='generated-consumer'){
  const controller=new AbortController(),cleanups:(()=>unknown)[]=[];
  const scope:PluginScope={identity:{packageId:'generated.consumer',installationId:'generated-install',instanceId:name,activationId:'generated-activation',host:{kind:'central',id:'generated-host'}},signal:controller.signal,
    assertCurrent(){controller.signal.throwIfAborted();},defer(dispose){cleanups.push(dispose);}};
  return {scope,close(){controller.abort();for(const dispose of cleanups)dispose();}};
}
const draft=(text='Generated material text'):MaterialDraft=>({
  id:materialId('generated-source','generated-material'),kind:'coding.session',schemaVersion:1,title:'Generated material',
  origin:{sourceId:'generated-source',externalId:'generated-material'},
  members:[{id:'generated-member',kind:'source-item',ref:'source-item:generated-source:generated-item',revision:'v1'}],
  blocks:[{id:'generated-block',kind:'text',format:'plain',text,memberIds:['generated-member']}],
  coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'},
});

test('scoped real FileStore and MaterialStore retain IDs, revisions, encrypted bytes and accounting across restart',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-vault-restart-')),auth=boundary();
  const config={dataDir:directory,dataKey:'ab'.repeat(32),contentEncryptionEnabled:true,maxStorageBytes:2_000_000};
  let platform=createVaultPlatform(config,auth.authorization);const owner=consumer();
  t.after(async()=>{owner.close();await platform.close();rmSync(directory,{recursive:true,force:true});});
  await platform.prepare();await platform.start();let access=platform.repositoriesForAssembly(owner.scope);
  assert.equal('store' in access,false);assert.equal('db' in access.transactions,false);assert.equal('directory' in access.originals,false);
  const bytes=Buffer.from('Generated archived bytes'),original=access.originals.put({name:'generated.txt',bytes},auth.token);
  const portable=access.exportPortable(200_000);assert.equal(portable.files[0].id,original.id);
  assert.equal(access.content.snapshot().enabled,true);
  const encrypted=join(directory,'files','objects',original.hash,'0.aes');
  assert.ok(existsSync(encrypted));assert.notDeepEqual(readFileSync(encrypted),bytes);
  access.sources.register({id:'generated-source',name:'Generated source',kind:'local-files',deviceId:'generated-device',platform:'android',retention:'archive'},auth.token);
  const input=Buffer.from([12,0,255,5,4,3]);
  const upload=access.files.begin({sourceId:'generated-source',previousRevision:null,item:{externalId:'generated-item',revision:'v1',observedAt:'2026-11-02T00:00:00Z',title:'Generated file',kind:'file',layer:'original',text:'',mimeType:'application/octet-stream',deleted:false},relativePath:'generated.bin',sizeBytes:input.length,sha256:sha256(input)},auth.token);
  access.files.part(upload.uploadId,0,input,auth.token);const receipt=await access.files.commit(upload.uploadId,auth.token);
  assert.deepEqual(Buffer.concat([...access.files.bytes(receipt.id)]),input);
  const first=access.materials.publish(draft(),{},auth.token),second=access.materials.publish(draft('Generated revised text'),{expectedRevision:first.revision},auth.token);
  assert.notEqual(first.revision,second.revision);
  assert.equal(access.materials.read(first.ref).text,'Generated material text\n');
  access.transactions.transaction(auth.token,()=>{const probe=contender(directory);assert.equal(probe.status,0,probe.stderr);assert.equal(probe.stdout,'locked');});
  assert.equal(contender(directory).stdout,'acquired');
  const iterator=access.files.bytes(receipt.id)[Symbol.iterator]();assert.deepEqual(iterator.next().value,input);
  const before=access.stats();await platform.close();assert.throws(()=>access.stats(),/unavailable/);assert.throws(()=>iterator.next(),/unavailable/);
  platform=createVaultPlatform(config,auth.authorization);await platform.prepare();await platform.start();access=platform.repositoriesForAssembly(owner.scope);
  assert.deepEqual(access.originals.read(original.id),bytes);assert.deepEqual(Buffer.concat([...access.files.bytes(receipt.id)]),input);
  assert.equal(access.materials.get(first.ref)?.revision,first.revision);assert.equal(access.materials.get(second.id)?.revision,second.revision);
  assert.equal(access.materials.read(second.ref).text,'Generated revised text\n');
  const after=access.stats();
  for(const key of ['captures','blobs','imageBytes','fileBytes','assetBytes','logicalBytes','maxBytes','imagesEncrypted'] as const)assert.equal(after[key],before[key],key);
  assert.ok(auth.checks>0,'write methods must invoke the fixed external verifier');
});

test('release, scope revocation and quiesce isolate consumers while stop revokes all accesses without deleting data',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-vault-scopes-')),auth=boundary(),platform=createVaultPlatform({dataDir:directory},auth.authorization),a=consumer('a'),b=consumer('b');
  t.after(async()=>{a.close();b.close();await platform.close();rmSync(directory,{recursive:true,force:true});});
  await platform.prepare();await platform.start();const first=platform.repositoriesForAssembly(a.scope),second=platform.repositoriesForAssembly(b.scope);
  first.release();first.release();assert.throws(()=>first.stats(),/unavailable/);assert.ok(second.stats());
  await platform.quiesce('restart');assert.throws(()=>platform.repositoriesForAssembly(consumer('late').scope),/unavailable/);assert.ok(second.stats(),'accepted pin remains usable while quiescing');
  b.close();assert.throws(()=>second.stats());await platform.stop('disabled');await platform.dispose();
  assert.ok(existsSync(join(directory,'mote.sqlite')),'business disable must preserve the vault');assert.equal(contender(directory).stdout,'acquired');
});

test('fixed verifier rejection rolls back the actual Material write and quota failures do not publish an original',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-vault-fences-')),auth=boundary(),platform=createVaultPlatform({dataDir:directory,maxStorageBytes:100_000},auth.authorization),owner=consumer();
  t.after(async()=>{owner.close();await platform.close();rmSync(directory,{recursive:true,force:true});});
  await platform.prepare();await platform.start();const access=platform.repositoriesForAssembly(owner.scope);
  assert.throws(()=>access.originals.put({name:'too-large.bin',bytes:Buffer.alloc(100_001)},auth.token),{statusCode:507});
  const before=access.stats().logicalBytes;
  assert.throws(()=>access.transactions.transaction(auth.token,()=>{access.materials.publish(draft(),{},auth.token);auth.revoke();}),/fixture grant revoked/);
  assert.equal(access.materials.get(draft().id),undefined);assert.equal(access.stats().logicalBytes,before);
  assert.throws(()=>access.originals.put({name:'blocked.txt',bytes:Buffer.from('generated')},auth.token),/fixture grant revoked/);
});

test('closing waits for an accepted real FileStore result before closing its database',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-vault-drain-')),auth=boundary(),platform=createVaultPlatform({dataDir:directory},auth.authorization),owner=consumer();
  let release!:()=>void,entered!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),finishedWrite=new Promise<void>(resolve=>{entered=resolve;});
  const originalCommit=FileStore.prototype.commit,originalClose=StoreDatabase.prototype.close;
  let databaseClosed=false;
  t.after(async()=>{release();FileStore.prototype.commit=originalCommit;StoreDatabase.prototype.close=originalClose;owner.close();await platform.close();rmSync(directory,{recursive:true,force:true});});
  await platform.prepare();await platform.start();const access=platform.repositoriesForAssembly(owner.scope);
  access.sources.register({id:'generated-source',name:'Generated source',kind:'local-files',deviceId:'generated-device',platform:'android',retention:'archive'},auth.token);
  const bytes=Buffer.from('generated held receipt');
  const upload=access.files.begin({sourceId:'generated-source',previousRevision:null,item:{externalId:'generated-held',revision:'v1',observedAt:'2026-11-02T00:00:00Z',title:'Generated',kind:'file',layer:'original',text:'',mimeType:'text/plain',deleted:false},relativePath:'held.txt',sizeBytes:bytes.length,sha256:sha256(bytes)},auth.token);
  access.files.part(upload.uploadId,0,bytes,auth.token);
  // Delay only delivery after the real FileStore has committed; keep its real receipt.
  FileStore.prototype.commit=async function(...args){const result=await originalCommit.apply(this,args);entered();await held;return result;};
  StoreDatabase.prototype.close=function(){databaseClosed=true;return originalClose.call(this);};
  const receipt=access.files.commit(upload.uploadId,auth.token);await finishedWrite;FileStore.prototype.commit=originalCommit;
  let closed=false;const closing=platform.close().then(()=>{closed=true;});await setImmediate();
  assert.equal(databaseClosed,false);assert.equal(closed,false);release();
  const saved=await receipt;await closing;assert.ok(saved.id);assert.equal(databaseClosed,true);
});

for(const ending of ['graceful','scope-revoked','grant-revoked','explicit-stop'] as const) test(`accepted upload at pre-commit: ${ending} preserves its own admission boundary`,async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-vault-accepted-')),auth=boundary(),platform=createVaultPlatform({dataDir:directory},auth.authorization),owner=consumer();
  let release!:()=>void,entered!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),prepared=new Promise<void>(resolve=>{entered=resolve;}),put=AssetStore.prototype.putUpload;
  t.after(async()=>{release();AssetStore.prototype.putUpload=put;owner.close();await platform.close();rmSync(directory,{recursive:true,force:true});});
  await platform.prepare();await platform.start();const access=platform.repositoriesForAssembly(owner.scope);
  access.sources.register({id:'generated-source',name:'Generated source',kind:'local-files',deviceId:'generated-device',platform:'android',retention:'archive'},auth.token);
  const bytes=Buffer.from('generated accepted bytes');
  const upload=access.files.begin({sourceId:'generated-source',previousRevision:null,item:{externalId:'generated-accepted',revision:'v1',observedAt:'2026-11-02T00:00:00Z',title:'Generated',kind:'file',layer:'original',text:'',mimeType:'text/plain',deleted:false},relativePath:'accepted.txt',sizeBytes:bytes.length,sha256:sha256(bytes)},auth.token);
  access.files.part(upload.uploadId,0,bytes,auth.token);
  AssetStore.prototype.putUpload=async function(...args){const result=await put.apply(this,args);entered();await held;return result;};
  const receipt=access.files.commit(upload.uploadId,auth.token);await prepared;AssetStore.prototype.putUpload=put;
  if(ending==='scope-revoked')owner.close();if(ending==='grant-revoked')auth.revoke();
  const closing=ending==='explicit-stop'?platform.stop('revoked'):platform.close();assert.throws(()=>access.files.commit(upload.uploadId,auth.token),/unavailable/);
  const outcome=receipt.then(value=>({value,error:undefined}),error=>({value:undefined,error}));
  await setImmediate();release();const result=await outcome;await closing;
  const recovery=boundary(),recoveryOwner=consumer('recovery'),restarted=createVaultPlatform({dataDir:directory},recovery.authorization);
  try{
    await restarted.prepare();await restarted.start();const reopened=restarted.repositoriesForAssembly(recoveryOwner.scope);
    if(ending==='graceful'){assert.equal(result.error,undefined);assert.ok(result.value);assert.deepEqual(Buffer.concat([...reopened.files.bytes(result.value.id)]),bytes);}
    else{assert.ok(result.error);const retry=reopened.files.begin({sourceId:'generated-source',previousRevision:null,item:{externalId:'generated-accepted',revision:'v1',observedAt:'2026-11-02T00:00:00Z',title:'Generated',kind:'file',layer:'original',text:'',mimeType:'text/plain',deleted:false},relativePath:'accepted.txt',sizeBytes:bytes.length,sha256:sha256(bytes)},recovery.token);assert.equal(retry.ack,null,'revocation must not publish an upload acknowledgement');}
  }finally{recoveryOwner.close();await restarted.close();}
});

test('stop during asynchronous prepare prevents late repository assembly and releases the database',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-vault-prepare-stop-')),auth=boundary(),platform=createVaultPlatform({dataDir:directory},auth.authorization);
  t.after(async()=>{await platform.close();rmSync(directory,{recursive:true,force:true});});
  const preparing=platform.prepare(),stopping=platform.stop('revoked');await assert.rejects(async()=>{await preparing;},/unavailable/);await stopping;
  assert.equal(contender(directory).stdout,'acquired');const reopened=new Store(directory);reopened.close();
});

test('maintenance exits before the owning database closes',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-vault-maintenance-')),auth=boundary(),platform=createVaultPlatform({dataDir:directory,maintenance:true},auth.authorization);
  const closeWorker=MaintenanceWorker.prototype.close,closeDatabase=StoreDatabase.prototype.close,order:string[]=[];
  t.after(async()=>{MaintenanceWorker.prototype.close=closeWorker;StoreDatabase.prototype.close=closeDatabase;await platform.close();rmSync(directory,{recursive:true,force:true});});
  await platform.prepare();await platform.start();
  MaintenanceWorker.prototype.close=async function(){await closeWorker.call(this);order.push('maintenance-exited');};
  StoreDatabase.prototype.close=function(){order.push('database-closed');return closeDatabase.call(this);};
  await platform.close();assert.deepEqual(order,['maintenance-exited','database-closed']);assert.equal(contender(directory).stdout,'acquired');
});

test('repository initialization failure after Store creation releases its resources and permits clean restart',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-vault-repo-failure-')),auth=boundary();
  mkdirSync(join(directory,'files'));writeFileSync(join(directory,'files','objects'),'generated blocking fixture');
  const platform=createVaultPlatform({dataDir:directory},auth.authorization);
  t.after(async()=>{await platform.close();rmSync(directory,{recursive:true,force:true});});
  await assert.rejects(async()=>{await platform.prepare();});assert.equal(contender(directory).stdout,'acquired');
  rmSync(join(directory,'files','objects'));
  const restarted=createVaultPlatform({dataDir:directory},auth.authorization);
  try{await restarted.prepare();await restarted.start();assert.ok(restarted.repositoriesForAssembly(consumer().scope).stats());}finally{await restarted.close();}
});

test('trusted bootstrap assembly owns newly created storage and borrows injected storage without publishing it',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-vault-legacy-')),borrowedDirectory=mkdtempSync(join(tmpdir(),'mote-vault-borrowed-'));
  const owned=createVaultPlatformAssembly({dataDir:directory}),borrowedStore=new Store(borrowedDirectory),borrowed=createVaultPlatformAssembly({dataDir:borrowedDirectory},{store:borrowedStore});
  t.after(async()=>{await owned.close();await borrowed.close();borrowedStore.close();rmSync(directory,{recursive:true,force:true});rmSync(borrowedDirectory,{recursive:true,force:true});});
  await owned.prepare();const own=owned.store;assert.equal(own.db.isOpen,true);await owned.close();assert.equal(own.db.isOpen,false);assert.throws(()=>owned.store,/unavailable/);
  await borrowed.prepare();assert.equal(borrowed.store,borrowedStore);
  const service=borrowed.contentStorage;assert.equal(service.snapshot().enabled,false);
  assert.equal(borrowed.contentStorage,service,'the vault owns exactly one content storage service');
  await borrowed.close();assert.equal(borrowedStore.db.isOpen,true);assert.equal(borrowedStore.stats().captures,0);
  assert.throws(()=>borrowed.contentStorage,/unavailable/);
});

test('a missing C04 verifier cannot activate the scoped writer factory',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-vault-no-verifier-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  assert.throws(()=>Reflect.apply(createVaultPlatform,undefined,[{dataDir:directory}]),{statusCode:503});
  assert.equal(existsSync(join(directory,'mote.sqlite')),false);
});

test('H04 mounts the real restart factory and publishes a read-only content port, then drains it on close',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-vault-host-')),auth=boundary(),host=new PluginHost({kind:'central',id:'generated-host'});
  t.after(async()=>{await host.close();rmSync(directory,{recursive:true,force:true});});
  const identity:ScopeIdentity={packageId:'generated.vault',installationId:'generated-install',instanceId:'generated-vault',activationId:'generated-activation',host:{kind:'central',id:'generated-host'}};
  let readBinding:ServiceBinding|undefined;
  const factory=createVaultPlatformFactory({dataDir:directory},auth.authorization);
  const handle=await host.install({identity,restartRequired:true,contributions:[vaultPlatformDeclaration],factory:context=>factory({...context,provide:(id,contract,value,revision)=>{const binding=context.provide(id,contract,value,revision);if(contract.id===centralServices.contentRead.id)readBinding=binding;return binding;}})});
  const lease=await host.acquire(centralServices.contentRead,readBinding!);
  const reader=lease.value;assert.deepEqual(Object.keys(reader).sort(),['get','listForCapture','read']);assert.equal('put' in reader,false);
  assert.equal(vaultPlatformContribution.requires[0].id,centralServices.commitAuthorization.id);
  assert.deepEqual(vaultPlatformContribution.provides.map(service=>service.id),[centralServices.contentRead.id]);
  assert.equal('vaultRepositoryService' in vaultExports,false);
  for(const key of ['transaction','acquire','put','publish','files','materials','sources','exportPortable'])assert.equal(key in reader,false,key);
  await assert.rejects(host.acquire(centralServices.vault,{...readBinding!,service:centralServices.vault}),{code:'dependency_unavailable'});
  let retainedRead:((id:string)=>unknown)|undefined;
  const caller=await host.install({identity:{...identity,instanceId:'generated-caller',activationId:'generated-caller-activation'},contributions:[],requires:[readBinding!],factory:async context=>{
    const access=await context.services.acquire(centralServices.contentRead,readBinding!);retainedRead=access.value.listForCapture;
    return {prepare(){},start(){},quiesce(){},stop(){},dispose(){}};
  }});
  assert.deepEqual(retainedRead!('generated-capture'),[]);await caller.close('revoked');
  const foreign=consumer('still-active-foreign');
  try{assert.throws(()=>Reflect.apply(retainedRead!,undefined,['generated-capture',foreign.scope]),{code:'stale_scope'});}
  finally{foreign.close();}
  assert.deepEqual(reader.listForCapture('generated-capture'),[],'another live caller is unaffected');
  await handle.close('disabled');assert.throws(()=>lease.assertCurrent());assert.throws(()=>reader.listForCapture('generated-capture'));
  assert.equal(contender(directory).stdout,'acquired');
});

test('storage accounting keeps a stopped domain plugin\'s retained rows and plugin attribution on the same profile',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-vault-meters-')),host=new PluginHost({kind:'central',id:'generated-host'}),vault=createVaultPlatformAssembly({dataDir:directory});
  t.after(async()=>{await host.close();await vault.close();rmSync(directory,{recursive:true,force:true});});
  await vault.prepare();const store=vault.store,memories=new MemoryStore(store);
  const bindings={binding:()=>({planId:'instance:generated',generation:1,namespace:{ownerId:'generated-owner',instanceId:'generated',bindingRevision:1}}),plugins:{references:()=>[]},assertNewManualWork:()=>{}} as unknown as MemoryBindings;
  let activation=0;
  const enable=async()=>{
    const platform=createMemoryPublication({store,memories,bindings});
    const handle=await host.install({identity:{host:host.identity,packageId:'mote.memory-publication',installationId:'build:memory-publication@1.0.0',instanceId:'memory-publication',activationId:'generated-activation-'+(++activation)},contributions:[memoryPublicationDeclaration],factory:createMemoryPublicationFactory(platform)});
    return {platform,handle};
  };
  const retained=()=>store.storageBreakdown().plugins.find(group=>group.plugin==='memory-publication');
  let current=await enable();
  current.platform.stage.retainOutput('generated-retained',{privateDraft:'Generated retained projection body'},{evidenceIds:['generated-evidence']});
  const output=retained()?.tables.find(table=>table.name==='memory_publication_outputs');
  assert.ok(output&&output.bytes>0,'the plugin\'s real write is metered under its plugin identity');
  current.platform.quiesce('disabled');
  assert.throws(()=>current.platform.stage.retainOutput('generated-refused',{privateDraft:'Generated refused body'}),{statusCode:503});
  await current.handle.close('disabled');
  assert.deepEqual(retained()?.tables.find(table=>table.name==='memory_publication_outputs'),output,'stopping the plugin does not hide or reattribute retained rows');
  current=await enable();
  current.platform.stage.retainOutput('generated-reenabled',{privateDraft:'Generated re-enabled projection body'});
  assert.ok(retained()!.tables.find(table=>table.name==='memory_publication_outputs')!.bytes>output.bytes,'re-enable resumes writes without a second registration');
  await current.handle.close('disabled');
  const expected=store.storageBreakdown();
  assert.ok(expected.plugins.some(group=>group.plugin==='memory-publication'&&group.bytes>0));
  await vault.close();
  const reopened=new Store(directory);
  try{
    const resumed=reopened.storageBreakdown();
    assert.deepEqual(resumed,expected,'restart preserves exact per-plugin accounting without the plugin registering again');
    assert.ok(resumed.plugins.find(group=>group.plugin==='memory-publication')!.tables.some(table=>table.name==='memory_publication_outputs'&&table.bytes>0));
  }finally{reopened.close();}
});

function checkScopedTypes(access:import('../src/plugins/vault-platform.js').VaultRepositoryAccess,authority:CommitAuthority){
  // @ts-expect-error generic repository service is deliberately not exported for ordinary consumers
  vaultExports.vaultRepositoryService;
  // @ts-expect-error scoped repository access never exposes Store.db
  access.db.prepare('SELECT 1');
  // @ts-expect-error transaction callbacks receive no database capability
  access.transactions.transaction(authority,db=>db.exec('DELETE FROM captures'));
  // @ts-expect-error consumer-supplied validators are not domain authority references
  access.originals.put({name:'generated.txt',bytes:Buffer.from('generated')},{assertCurrent(){}});
}
void checkScopedTypes;
