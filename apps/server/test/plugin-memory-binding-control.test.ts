import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {PluginCenter} from '../src/plugin-center.js';
import {GitHubPluginReleases} from '../src/plugin-release.js';
import {MemoryStore,memoryEvidenceFingerprint} from '../src/memory.js';
import {MemoryAutomation} from '../src/memory-automation.js';
import {MemoryPublication} from '../src/plugins/memory-publication.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {SourceStore} from '../src/sources.js';
import {MemoryInputAuthorization} from '../src/memory-input-authorization.js';
import {memorySchema,type Memory} from '../src/memory-schema.js';
import {memoryProviderKey,memoryBodyDigest,type MemoryProvider,type MemoryProviderNamespace,type MemoryProviderRecord,type MemoryProviderReceipt} from '../src/memory-provider-contract.js';
import {centralServices} from '../src/plugins/central-contracts.js';
import {
  createMemoryBindingControl,createMemoryBindingControlFactory,memoryBindingControlContribution,
  memoryBindingControlDeclaration,type MemoryBindingControlBindings,
} from '../src/plugins/memory-binding-control.js';
import {PluginHost} from '@mote/plugin-host';

const at='2026-11-04T10:00:00.000Z';

function directory(t:test.TestContext){
  const path=mkdtempSync(join(tmpdir(),'mote-memory-binding-control-'));
  t.after(()=>rmSync(path,{recursive:true,force:true}));
  return path;
}

function generatedProvider(){
  const bodies=new Map<string,{namespace:MemoryProviderNamespace;key:MemoryProviderRecord['key'];memory:Memory}>();
  let failRead=false;
  const id=(input:{namespace:MemoryProviderNamespace;key:MemoryProviderRecord['key']})=>JSON.stringify({namespace:input.namespace,key:input.key});
  const receipt=(input:{namespace:MemoryProviderNamespace;key:MemoryProviderRecord['key'];opId:string},state:MemoryProviderReceipt['state']):MemoryProviderReceipt=>({opId:input.opId,namespace:input.namespace,key:input.key,payloadDigest:'generated',state,eraseVerified:false,recordedAt:at});
  const health={providerId:'generated',version:'1',ready:true,verified:{persistentCrud:true,scopedRetrieval:true,immutableRecords:true,idempotentReplay:true,history:true,physicalErase:false},problems:[]};
  const provider:MemoryProvider={
    put:async input=>{bodies.set(id(input),{namespace:input.namespace,key:input.key,memory:input.memory});return receipt(input,'applied');},
    read:async input=>{if(failRead){failRead=false;throw Error('Generated unknown acknowledgement');}return bodies.get(id(input))?.memory??null;},
    remove:async input=>{bodies.delete(id(input));return receipt(input,'removed');},
    search:async input=>(input.keys??[]).flatMap(key=>{const body=bodies.get(id({namespace:input.namespace,key}));return body?[{...body,score:1}]:[];}),
    export:async input=>[...bodies.values()].filter(record=>JSON.stringify(record.namespace)===JSON.stringify(input.namespace)) as MemoryProviderRecord[],
    health:async()=>health,recover:async()=>health,close:async()=>{},
  };
  return {provider,failRead(){failRead=true;},body:(namespace:MemoryProviderNamespace,key:MemoryProviderRecord['key'])=>bodies.get(id({namespace,key}))?.memory??null};
}

function generatedPlugins(target:string){
  const references:string[]=[];
  const instance={id:target,name:'Generated target',scope:'default',revision:1,configuration:{modelProfileId:'generated-profile'},configurationSchema:[],configurationId:'generated-configuration-identity',secretStatus:{},desired:true,observed:'ready',issues:[],allowedActions:[],capabilities:[{id:'engine',state:'verified' as const}]};
  return {
    references:(_instanceId:string)=>references.slice(),
    view:()=>({revision:1,installation:{supported:true,runtime:'worker' as const,restartRequired:false},packages:[],instances:[instance],catalog:[]}),
    instanceView:(id:string)=>({...instance,id}),
  } as unknown as PluginCenter;
}

function addMemory(store:Store,index=0){
  const evidenceId=randomUUID(),now=new Date(Date.parse(at)+index*1000).toISOString();
  return (async()=>{
    await store.ingest({id:evidenceId,deviceId:'generated-device',deviceName:'Generated device',platform:'import',source:'message',capturedAt:now,durationMs:0,appId:'generated.notes',appName:'Generated Notes',ocrText:`Generated binding observation ${index}.`,provenance:{sourceId:'generated-notes',externalId:evidenceId,revision:'1',layer:'original'},privacy:{excluded:false,redacted:false,mode:'none'}});
    const original=store.evidence([evidenceId])[0]!,memory=memorySchema.parse({id:randomUUID(),version:1,domain:'personal',tier:'episode',kind:'episodic',title:`Generated binding memory ${index}`,statement:`Generated binding observation ${index} stays exact.`,uncertainty:'Generated fixture only',status:'published',createdAt:now,evidenceIds:[evidenceId],model:'fixture',runId:'fixture',fingerprint:memoryEvidenceFingerprint(original),admission:{layer:'memory',reason:'Generated fixture',scope:'Generated fixture only',attribution:'observed'},evidence:[{id:evidenceId,deviceId:original.deviceId,sourceId:'generated-notes',capturedAt:now,receivedAt:original.receivedAt,offset:0,length:original.ocrText.length,quote:original.ocrText,contentHash:memoryEvidenceFingerprint(original)}]});
    store.db.prepare('INSERT INTO memories(id,created_at,json) VALUES(?,?,?)').run(memory.id,now,JSON.stringify(memory));
    store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(memory.id,evidenceId);
    return {memory,evidenceId};
  })();
}

const stubPipeline=()=>({get:()=>({status:'queued',batches:[]}),cancel:()=>{}}) as unknown as Pick<import('../src/memory-pipeline.js').MemoryPipeline,'get'|'cancel'>;
const stubLifecycle=()=>({automaticAdmission:undefined as ((id:string)=>boolean)|undefined,view:()=>({extensions:[]}),cancel:()=>{},skipAutomaticBacklog:()=>{}}) as unknown as Pick<import('../src/memory-lifecycle.js').MemoryLifecycle,'view'|'cancel'|'skipAutomaticBacklog'|'automaticAdmission'>;

function platform(options:{store:Store;memories:MemoryStore;automation:MemoryAutomation;plugins:PluginCenter;executor:ExecutionEngine;publication?:()=>Pick<MemoryPublication,'pending'>}){
  const value=createMemoryBindingControl({store:options.store,automation:options.automation});
  value.attach({memories:options.memories,plugins:options.plugins,executor:options.executor,pipeline:stubPipeline,lifecycle:stubLifecycle,publication:options.publication??(()=>({pending:()=>0}))});
  return value;
}

test('prepare/activate/cancel replay keeps an unverified target out, releases only its own freeze, and re-enables after stop on the same profile',async t=>{
  const path=directory(t),target='generated-target';
  let store=new Store(path),executor=new ExecutionEngine(store),memories=new MemoryStore(store),automation=new MemoryAutomation(store),plugins=generatedPlugins(target),provider=generatedProvider();
  new MemoryInputAuthorization(store,()=>true);
  let current=platform({store,memories,automation,plugins,executor});current.prepare();current.start();
  const written=await addMemory(store),bindings=current.bindings;
  bindings.providerFactory=()=>provider.provider;
  t.after(async()=>{await current.close();if(store.db.isOpen){await executor.close();store.close();}});

  const prepare=(targetPlanId=('instance:'+target))=>{const operationId=randomUUID(),raw={operationId,expectedRevision:bindings.view().revision,targetPlanId,scope:'default',feeAcknowledged:true};current.port.prepare(raw);return {operationId,raw};};
  const drain=(operationId:string)=>executor.drain(['memory-prepare:'+operationId]);
  const first=prepare();
  assert.throws(()=>current.port.action('activate',{operationId:randomUUID(),expectedRevision:bindings.view().revision,preparationId:first.operationId}),{statusCode:409});
  assert.equal(bindings.binding().planId,'mote.builtin','an unverified target never becomes current');
  const revision=automation.state().revision;
  current.port.prepare(first.raw);assert.equal(automation.state().revision,revision,'the same prepare command replays without a second intent');
  await drain(first.operationId);assert.equal(current.port.view().preparation?.state,'verified');
  const activate={operationId:randomUUID(),expectedRevision:bindings.view().revision,preparationId:first.operationId};
  current.port.action('activate',activate);
  assert.equal(bindings.binding().planId,'instance:'+target);
  assert.equal(bindings.binding().namespace?.instanceId,target);
  const appliedRevision=automation.state().revision;current.port.action('activate',activate);assert.equal(automation.state().revision,appliedRevision,'the same activate command replays idempotently');

  const back=prepare('mote.builtin');await drain(back.operationId);
  assert.equal(automation.state().barrier,back.operationId);
  assert.throws(()=>automation.release(randomUUID()),{statusCode:409});
  assert.equal(automation.state().barrier,back.operationId,'a foreign holder cannot release this preparation');
  const cancel={operationId:randomUUID(),expectedRevision:bindings.view().revision,preparationId:back.operationId};
  current.port.action('cancel',cancel);
  assert.equal(automation.state().barrier,undefined,'cancel releases its own freeze');
  assert.equal(bindings.binding().planId,'instance:'+target,'cancel does not change the current binding');
  const cancelledRevision=automation.state().revision;current.port.action('cancel',cancel);assert.equal(automation.state().revision,cancelledRevision);

  const third=prepare('mote.builtin');await drain(third.operationId);
  automation.release(third.operationId);automation.freeze('generated-foreign-holder');
  current.port.action('cancel',{operationId:randomUUID(),expectedRevision:bindings.view().revision,preparationId:third.operationId});
  assert.equal(automation.state().barrier,'generated-foreign-holder','cancel never releases another operation\'s freeze');
  automation.release('generated-foreign-holder');

  assert.equal(current.accepting(),true);
  current.quiesce('disabled');
  assert.equal(current.accepting(),false);
  assert.throws(()=>current.port.prepare({operationId:randomUUID(),expectedRevision:bindings.view().revision,targetPlanId:'mote.builtin',scope:'default',feeAcknowledged:true}),{statusCode:503});
  assert.equal(current.port.view().preparation?.state,'cancelled','reads survive quiesce');
  await current.stop('disabled');
  assert.throws(()=>current.port.view(),{statusCode:503});
  assert.equal(bindings.binding().planId,'instance:'+target,'the durable binding survives stop');

  // Re-enable without a process restart against the same profile.
  current=platform({store,memories,automation,plugins,executor});current.prepare();current.start();
  assert.equal(current.port.binding().planId,'instance:'+target);
  const retained=current.bindings.retainSnapshot([written.memory.id]);
  assert.deepEqual(retained.catalog[written.memory.id],memoryProviderKey(written.memory));
  retained.release();
  await current.close();

  // Restart the process with the same profile; the binding and record remain.
  await executor.close();store.close();executor=new ExecutionEngine(store=new Store(path));memories=new MemoryStore(store);automation=new MemoryAutomation(store);plugins=generatedPlugins(target);new MemoryInputAuthorization(store,()=>true);
  current=platform({store,memories,automation,plugins,executor});
  current.prepare();current.start();
  assert.equal(current.port.binding().planId,'instance:'+target);
  const restored=current.port.view();
  assert.equal(restored.preparation?.state,'cancelled');
  assert.deepEqual(current.bindings.retainSnapshot([written.memory.id]).catalog[written.memory.id],memoryProviderKey(written.memory));
  await current.close();
});

test('real binding snapshots drive reader and publication with the exact namespace, retain unresolved references across restart, and refuse retirement until reconciliation',async t=>{
  const path=directory(t),instanceId='generated-binding-instance',packageId='generated.memory-binding@'+'b'.repeat(64),namespace:MemoryProviderNamespace={ownerId:'mote-owner',instanceId,bindingRevision:2};
  let store=new Store(path),executor=new ExecutionEngine(store),memories=new MemoryStore(store),automation=new MemoryAutomation(store),plugins=new PluginCenter(store,executor,new GitHubPluginReleases(join(path,'packages'))),provider=generatedProvider();
  const manifest={schemaVersion:1 as const,id:'generated.memory-binding',name:'Generated binding package',version:'1.0.0',runtime:'worker' as const,entry:'worker.mjs',archive:{asset:'worker.zip',sha256:'b'.repeat(64)},capabilities:['repository','retrieval'] as const,configuration:[],dependencies:[],access:['Generated fixture only']};
  store.db.prepare('INSERT INTO plugin_packages VALUES(?,?)').run(packageId,JSON.stringify({installationId:randomUUID(),previewId:randomUUID(),manifest,view:{id:packageId,name:manifest.name,version:manifest.version,source:{repository:'generated-fixture/binding',tag:'v1.0.0',commit:'a'.repeat(40),digest:'b'.repeat(64)},runtime:'worker',state:'installed',desired:false,observed:'installed',issues:[],instanceIds:[instanceId],allowedActions:[],operationId:randomUUID()}}));
  const instance={configurationId:'generated-configuration-identity',view:{id:instanceId,packageId,name:'Generated binding instance',scope:'default',revision:1,configurationSchema:[],configuration:{},secretStatus:{},capabilities:[{id:'engine',state:'verified'}],desired:false,observed:'disabled',issues:[],allowedActions:[]}};
  store.db.prepare('INSERT INTO plugin_instances VALUES(?,?)').run(instanceId,JSON.stringify(instance));
  new MemoryInputAuthorization(store,()=>true);const sources=new SourceStore(store),reader=new EvidenceReader(store,sources);
  let publication:MemoryPublication|undefined;
  let current=platform({store,memories,automation,plugins,executor,publication:()=>publication!});current.prepare();
  const bindings=current.bindings;bindings.providerFactory=()=>provider.provider;reader.memoryBindings=bindings;
  publication=new MemoryPublication(store,memories,bindings);current.start();
  t.after(async()=>{await publication?.close();await current.close();await plugins.close();if(store.db.isOpen){await executor.close();store.close();}});

  store.db.prepare('UPDATE memory_plan_binding SET json=? WHERE id=1').run(JSON.stringify({planId:'instance:'+instanceId,generation:2,namespace}));
  const written=await addMemory(store);
  publication.stageRecords('generated-publication',[written.memory],()=>{});
  const operation=JSON.parse(String(store.db.prepare("SELECT json FROM memory_provider_writes WHERE parent_id='generated-publication'").get()!.json)) as {namespace:MemoryProviderNamespace;key:ReturnType<typeof memoryProviderKey>};
  assert.deepEqual(operation.namespace,namespace);
  assert.deepEqual(operation.key,memoryProviderKey(written.memory));
  assert.equal(memoryBodyDigest(provider.body(namespace,operation.key)!),memoryBodyDigest(written.memory));
  const snapshot=bindings.retainSnapshot([written.memory.id]);
  assert.deepEqual(snapshot.binding.namespace,namespace);
  assert.equal(plugins.configurationIdentity(instanceId),'generated-configuration-identity');
  assert.equal(plugins.references(instanceId).includes('Existing queries retain a read snapshot'),true);
  const detailed=await reader.memoryAsync('memory:'+written.memory.id,{},true,snapshot);
  assert.deepEqual(detailed,written.memory);
  assert.equal(provider.body(namespace,memoryProviderKey(written.memory))?.statement,written.memory.statement,'the reader consumes the exact binding namespace');
  snapshot.release();
  assert.equal(plugins.references(instanceId).includes('Existing queries retain a read snapshot'),false);

  provider.failRead();
  await assert.rejects(publication.stageRecords('generated-unknown',[written.memory],()=>{}),/unknown acknowledgement/);
  assert.ok(plugins.references(instanceId).includes('Unresolved provider writes or erasures retain this instance'));
  assert.throws(()=>plugins.uninstall(packageId,{operationId:randomUUID(),expectedRevision:plugins.revision()}),/Disable and migrate/);
  assert.equal(plugins.view().packages.some(pkg=>pkg.id===packageId),true,'retirement keeps the package and its reference');

  // Restart the process; the durable write remains referenced until reconciled.
  await publication.close();await current.close();await plugins.close();await executor.close();store.close();
  store=new Store(path);executor=new ExecutionEngine(store);memories=new MemoryStore(store);automation=new MemoryAutomation(store);plugins=new PluginCenter(store,executor,new GitHubPluginReleases(join(path,'packages')));new MemoryInputAuthorization(store,()=>true);
  publication=undefined;
  current=platform({store,memories,automation,plugins,executor,publication:()=>publication!});
  current.prepare();const restartedBindings=current.bindings;restartedBindings.providerFactory=()=>provider.provider;
  publication=new MemoryPublication(store,memories,restartedBindings);current.start();
  assert.deepEqual(current.port.binding().namespace,namespace);
  assert.equal(plugins.configurationIdentity(instanceId),'generated-configuration-identity');
  assert.ok(plugins.references(instanceId).includes('Unresolved provider writes or erasures retain this instance'),'the unresolved reference survives restart');
  assert.throws(()=>plugins.uninstall(packageId,{operationId:randomUUID(),expectedRevision:plugins.revision()}),/Disable and migrate/);
  await publication.reconcile();
  assert.equal(publication.pending(),0);
  assert.equal(plugins.references(instanceId).includes('Unresolved provider writes or erasures retain this instance'),false);
  // Move the current binding off the instance before it can be retired.
  store.db.prepare('UPDATE memory_plan_binding SET json=? WHERE id=1').run(JSON.stringify({planId:'mote.builtin',generation:3}));
  assert.equal(plugins.references(instanceId).length,0);
  plugins.uninstall(packageId,{operationId:randomUUID(),expectedRevision:plugins.revision()});
  assert.equal(plugins.view().packages.some(pkg=>pkg.id===packageId),false);
});

test('the host factory provides the binding port, fences commands after quiesce and releases a failed prepare without a lock',async t=>{
  const path=directory(t),store=new Store(path),executor=new ExecutionEngine(store),memories=new MemoryStore(store),automation=new MemoryAutomation(store),plugins=generatedPlugins('generated-factory-target');
  new MemoryInputAuthorization(store,()=>true);
  const platform=createMemoryBindingControl({store,automation});platform.attach({memories,plugins,executor,pipeline:stubPipeline,lifecycle:stubLifecycle,publication:()=>({pending:()=>0})});
  const host=new PluginHost({kind:'central',id:'generated-memory-binding-host'});
  t.after(async()=>{await host.close();await executor.close();store.close();});
  let bindings:MemoryBindingControlBindings|undefined;
  const handle=await host.install({identity:{host:host.identity,packageId:'generated.memory-binding-control',installationId:randomUUID(),instanceId:randomUUID(),activationId:randomUUID()},
    contributions:[memoryBindingControlDeclaration],factory:createMemoryBindingControlFactory(platform,value=>{bindings=value;})});
  const lease=await host.acquire(centralServices.memoryBindingControl,bindings!.bindings);
  assert.equal(lease.value.binding().planId,'mote.builtin');
  assert.equal(memoryBindingControlContribution.provides.map(service=>service.id)[0],centralServices.memoryBindingControl.id);
  await handle.quiesce('upgrade');
  assert.throws(()=>lease.value.prepare({operationId:randomUUID(),expectedRevision:lease.value.view().revision,targetPlanId:'mote.builtin',scope:'default',feeAcknowledged:true}),{statusCode:503});
  assert.equal(lease.value.binding().planId,'mote.builtin');
  await handle.close('disabled');
  assert.throws(()=>lease.value.view(),{code:'dependency_unavailable'});
  await lease.release();

  const blocked=new Store(join(path,'failed'));
  const brokenExecutor={register(){throw new Error('Generated handler registration failure');}} as unknown as ExecutionEngine;
  const brokenPlatform=createMemoryBindingControl({store:blocked,automation:new MemoryAutomation(blocked)});
  brokenPlatform.attach({memories:new MemoryStore(blocked),plugins:generatedPlugins('generated-failed'),executor:brokenExecutor,pipeline:stubPipeline,lifecycle:stubLifecycle,publication:()=>({pending:()=>0})});
  assert.throws(()=>brokenPlatform.prepare(),/Generated handler registration failure/);
  assert.equal(blocked.db.isTransaction,false,'a failed prepare leaves no database lock');
  assert.throws(()=>brokenPlatform.bindings,{statusCode:503});
  await brokenPlatform.close();blocked.close();
});
