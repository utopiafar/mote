import {modelConfigService} from './fixtures/model-config-service.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
import {PluginHost} from '@mote/plugin-host';
import {Store,sha256} from '../src/store.js';
import {MemoryStore} from '../src/memory.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {PluginCenter} from '../src/plugin-center.js';
import {GitHubPluginReleases,type PluginManifest} from '../src/plugin-release.js';
import {MemoryBindings} from '../src/memory-bindings.js';
import {MemoryPublication} from '../src/memory-publication.js';
import {MemoryAutomation} from '../src/memory-automation.js';
import {ModelSettingsStore} from '../src/model-settings.js';
import {UsageLedger} from '../src/usage.js';
import {memorySchema} from '../src/memory-schema.js';
import {memoryProviderKey,memoryBodyDigest,type MemoryProviderNamespace} from '../src/memory-provider-contract.js';
import {centralServices,checkCentralServiceDeclarations} from '../src/plugins/central-contracts.js';
import {
  createMemoryProviderAdapters,createMemoryProviderAdaptersFactory,memoryProviderAdaptersContribution,
  memoryProviderAdaptersDeclaration,type MemoryProviderAdaptersBindings,
} from '../src/plugins/memory-provider-adapters.js';

// A generated compatible worker release exercises the actual PluginCenter
// install, the plugin's own probe handler and real WorkerMemoryProvider
// receipts. It is not a claim about a real third-party package or engine.
const worker=String.raw`import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export async function createMemoryProvider(config){
 const path=config.directory+'/records.json';let state={records:[],ops:{}};if(config.mode!=='volatile')try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const save=()=>config.mode==='volatile'?Promise.resolve():writeFile(path,JSON.stringify(state));
 const result=(input,status)=>({opId:input.opId,namespace:input.namespace,key:input.key,payloadDigest:hash({namespace:input.namespace,key:input.key,...(status==='applied'?{memory:input.memory}:{})}),state:status,eraseVerified:false,recordedAt:'2026-10-12T00:00:00Z',...(status==='removed'?{currentRemoved:true}: {})});
 return {
  async health(){return {providerId:'generated.plugin',version:'1.0.0',ready:true,verified:{persistentCrud:true,scopedRetrieval:true,immutableRecords:true,idempotentReplay:true,history:true,physicalErase:true},problems:[]};},
  async put(input){const payload=hash(input),prior=state.ops[input.opId];if(prior){if(prior.payload!==payload)throw Error('op_conflict');return prior.receipt;}const priorRecord=state.records.find(r=>same(r.namespace,input.namespace)&&same(r.key,input.key));if(priorRecord&&!same(priorRecord.memory,input.memory))throw Error('immutable_conflict');if(!priorRecord)state.records.push({namespace:input.namespace,key:input.key,memory:input.memory});const receipt=result(input,'applied');state.ops[input.opId]={payload,receipt};await save();return receipt;},
  async read(input){return state.records.find(r=>same(r.namespace,input.namespace)&&same(r.key,input.key))?.memory??null;},
  async search(input){return state.records.filter(r=>same(r.namespace,input.namespace)&&(input.keys===undefined||input.keys.some(k=>same(k,r.key)))).slice(0,input.limit??10);},
  async export(input){return state.records.filter(r=>same(r.namespace,input.namespace));},
  async remove(input){const payload=hash(input),prior=state.ops[input.opId];if(prior){if(prior.payload!==payload)throw Error('op_conflict');return prior.receipt;}state.records=state.records.filter(r=>!(same(r.namespace,input.namespace)&&same(r.key,input.key)));const receipt=result(input,'removed');state.ops[input.opId]={payload,receipt};await save();return receipt;},
  async close(){}
 };
}`;
const repo='generated/adapters-plugin',tag='v1.0.0',base=`https://github.com/${repo}/releases/download/${tag}/`;
const archive=zipSync({'provider.mjs':strToU8(worker)}),digest=createHash('sha256').update(archive).digest('hex');
const manifest:PluginManifest={schemaVersion:1,id:'generated.adapter',name:'Generated compatible adapter',version:'1.0.0',runtime:'worker',entry:'provider.mjs',archive:{asset:'adapter.zip',sha256:digest},capabilities:['repository','retrieval','engine'],configuration:[{id:'directory',label:'Generated private storage',type:'text',required:true},{id:'mode',label:'Fixture mode',type:'text',required:true}],dependencies:[],access:['Generated fixture directory']};

async function buildStack(directory:string){
  const vault=join(directory,'vault'),store=new Store(vault),executor=new ExecutionEngine(store);
  const releases=new GitHubPluginReleases(join(vault,'plugins/packages'),async url=>({bytes:url.endsWith('/releases/tags/'+tag)?strToU8(JSON.stringify({tag_name:tag,draft:false,assets:[{name:'mote-plugin.json',browser_download_url:base+'mote-plugin.json'},{name:'adapter.zip',browser_download_url:base+'adapter.zip'}]})):url.endsWith('/commits/'+tag)?strToU8(JSON.stringify({sha:'a'.repeat(40)})):url===base+'mote-plugin.json'?strToU8(JSON.stringify(manifest)):url===base+'adapter.zip'?archive:(()=>{throw Error('Unexpected generated release request');})()}));
  const plugins=new PluginCenter(store,executor,releases),models=new ModelSettingsStore({configService:modelConfigService(join(directory,'model-settings'),{provider:'custom',protocol:'openai-completions',baseUrl:'https://generated.invalid/v1',model:'generated-unused',reasoningEffort:'auto',maxTokens:1024,modelRequestTimeoutMs:5000,agentTimeoutMs:5000,allowUnauthenticatedLocal:false,apiKey:'',headers:{},extraBody:{}}),prepare:async()=>({activate(){},async dispose(){}}),probe:async()=>{throw Error('A storage canary must not call a model');}});
  await models.initialize();
  const platform=createMemoryProviderAdapters({directory:join(vault,'plugins/instances'),plugins,models,usage:new UsageLedger(store)});
  return {store,executor,releases,plugins,models,platform};
}

async function installProvider(plugins:PluginCenter,executor:ExecutionEngine,stateDirectory:string){
  const preview=await plugins.resolve({repository:repo,tag}),installId=randomUUID();
  plugins.install({previewId:preview.id,expectedRevision:plugins.revision(),operationId:installId});
  await executor.drain(['plugin-install:'+installId]);
  const instanceId=randomUUID();
  plugins.configure(undefined,{packageId:plugins.view().packages[0].id,name:'Generated persistent provider',scope:'default',configuration:{directory:stateDirectory,mode:'persistent'},expectedRevision:plugins.revision(),operationId:instanceId});
  return instanceId;
}

function generatedMemory(statement:string){
  return memorySchema.parse({id:randomUUID(),version:1,fingerprint:createHash('sha256').update(statement).digest('hex'),createdAt:'2026-10-12T00:00:00Z',title:'Generated memory',statement,uncertainty:'Generated transport fixture',status:'published',domain:'personal',tier:'episode',kind:'episodic',model:'fixture',runId:'fixture',evidenceIds:[randomUUID()],evidence:[],admission:{layer:'memory',reason:'Generated',scope:'Generated only',attribution:'observed'}});
}

test('the host factory provides the adapter port, fences new work after quiesce and releases a failed prepare',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-provider-adapters-host-'));
  const stack=await buildStack(directory);
  t.after(async()=>{await stack.plugins.close();await stack.executor.close();await stack.models.close();stack.store.close();await rm(directory,{recursive:true,force:true});});
  const issues=checkCentralServiceDeclarations(
    [{service:{id:memoryProviderAdaptersContribution.provides[0].id,apiVersion:memoryProviderAdaptersContribution.provides[0].apiVersion},provider:{scope:{host:{kind:'central',id:'generated'},packageId:'mote.memory-provider-adapters',installationId:'generated',instanceId:'memory-provider-adapters',activationId:'generated'},contributionId:memoryProviderAdaptersContribution.id}}],
    [{consumer:'mote.memory',service:{id:centralServices.memoryProviderAdapters.id,apiVersion:centralServices.memoryProviderAdapters.apiVersion}}]);
  assert.deepEqual(issues,[]);
  const host=new PluginHost({kind:'central',id:'generated-memory-adapters-host'});
  t.after(()=>host.close());
  let bindings:MemoryProviderAdaptersBindings|undefined;
  const handle=await host.install({identity:{host:host.identity,packageId:'mote.memory-provider-adapters',installationId:randomUUID(),instanceId:randomUUID(),activationId:randomUUID()},
    contributions:[memoryProviderAdaptersDeclaration],factory:createMemoryProviderAdaptersFactory(stack.platform,value=>{bindings=value;})});
  const lease=await host.acquire(centralServices.memoryProviderAdapters,bindings!.bindings);
  assert.equal(lease.value.configurationAllowed('model-profile','generated-missing'),false);
  await handle.quiesce('upgrade');
  assert.throws(()=>lease.value.probe('generated-instance',new AbortController().signal),{statusCode:503});
  assert.throws(()=>lease.value.engine('generated-instance'),{statusCode:503});
  await handle.close('disabled');
  assert.throws(()=>lease.value.provider('generated-instance'),{code:'dependency_unavailable'});
  await lease.release();

  const blocked=new Store(join(directory,'failed-vault'));
  const brokenPlugins={store:{db:{exec(){throw new Error('Generated adapter table failure');}}}} as unknown as PluginCenter;
  const brokenPlatform=createMemoryProviderAdapters({directory:join(directory,'failed-instances'),plugins:brokenPlugins,models:stack.models,usage:new UsageLedger(blocked)});
  assert.throws(()=>brokenPlatform.prepare(),/Generated adapter table failure/);
  assert.equal(blocked.db.isTransaction,false,'a failed prepare leaves no database lock');
  assert.throws(()=>brokenPlatform.adapters,{statusCode:503});
  await brokenPlatform.close();blocked.close();
});

test('worker receipts stay durable through quiesce, reactivation and a process restart',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-provider-adapters-life-')),stateDirectory=join(directory,'plugin-state');await mkdir(stateDirectory,{mode:0o700});
  let stack=await buildStack(directory);
  const closeStack=async()=>{await stack.platform.close();await stack.plugins.close();await stack.executor.close();await stack.models.close();stack.store.close();};
  t.after(async()=>{await closeStack().catch(()=>{});await rm(directory,{recursive:true,force:true});});
  stack.platform.prepare();stack.platform.start();
  const instanceId=await installProvider(stack.plugins,stack.executor,stateDirectory);
  const checkId=randomUUID();
  stack.plugins.action(instanceId,'check',{expectedRevision:stack.plugins.instanceView(instanceId).revision,operationId:checkId});
  await stack.executor.drain(['plugin-check:'+checkId]);
  const checked=stack.plugins.instanceView(instanceId);
  assert.equal(checked.capabilities.find(c=>c.id==='repository')?.state,'verified','the installed probe handler verifies the real worker');
  assert.equal(checked.capabilities.find(c=>c.id==='engine')?.state,'unsupported','worker selfclaims never enable engine');

  const namespace:MemoryProviderNamespace={ownerId:'generated-owner',instanceId,bindingRevision:3},memory=generatedMemory('Generated durable provider record.');
  const receipt=await stack.platform.port.provider(instanceId,namespace).put({namespace,key:memoryProviderKey(memory),memory,opId:randomUUID()});
  assert.equal(receipt.state,'applied');
  assert.equal(receipt.payloadDigest,sha256(JSON.stringify({namespace,key:receipt.key,memory})));

  stack.platform.quiesce('disabled');
  assert.throws(()=>stack.platform.port.probe(instanceId,new AbortController().signal),{statusCode:503});
  assert.throws(()=>stack.platform.port.engine(instanceId),{statusCode:503});
  assert.equal(memoryBodyDigest((await stack.platform.port.provider(instanceId,namespace).read({namespace,key:memoryProviderKey(memory)}))!),memoryBodyDigest(memory),'drain reads keep serving during quiesce');
  await stack.platform.stop('disabled');
  assert.throws(()=>stack.platform.port.provider(instanceId),{statusCode:503});

  // Re-enable without a process restart against the same profile.
  stack.platform.prepare();stack.platform.start();
  assert.deepEqual(await stack.platform.port.provider(instanceId,namespace).read({namespace,key:memoryProviderKey(memory)}),memory,'the fixed worker configuration reloads its durable record');
  const second=generatedMemory('Generated post-reactivation record.');
  await stack.platform.port.provider(instanceId,namespace).put({namespace,key:memoryProviderKey(second),memory:second,opId:randomUUID()});
  await closeStack();

  // Restart the process with the same profile; both committed records remain.
  stack=await buildStack(directory);
  stack.platform.prepare();stack.platform.start();
  for(const expected of [memory,second]){
    const body=await stack.platform.port.provider(instanceId,namespace).read({namespace,key:memoryProviderKey(expected)});
    assert.deepEqual(body,expected);
    assert.equal(memoryBodyDigest(body!),memoryBodyDigest(expected));
  }
});

test('bindings and publication consume the real adapter receipt with an immutable body digest',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-provider-adapters-receipt-')),stateDirectory=join(directory,'plugin-state');await mkdir(stateDirectory,{mode:0o700});
  const stack=await buildStack(directory);
  t.after(async()=>{await stack.platform.close();await stack.plugins.close();await stack.executor.close();await stack.models.close();stack.store.close();await rm(directory,{recursive:true,force:true});});
  stack.platform.prepare();stack.platform.start();
  const instanceId=await installProvider(stack.plugins,stack.executor,stateDirectory);
  const memories=new MemoryStore(stack.store),automation=new MemoryAutomation(stack.store),bindings=new MemoryBindings(stack.store,memories,automation,stack.plugins,stack.executor);
  bindings.providerFactory=(id,namespace)=>stack.platform.port.provider(id,namespace);
  const publication=new MemoryPublication(stack.store,memories,bindings,stack.executor);
  t.after(()=>publication.close());
  const namespace:MemoryProviderNamespace={ownerId:'generated-owner',instanceId,bindingRevision:7},memory=generatedMemory('Generated receipt-verified memory.'),key=memoryProviderKey(memory),opId=randomUUID();

  const receipt=await bindings.stageMigrationRecord!(namespace,memory,opId,()=>{});
  assert.equal(receipt.opId,opId);
  assert.equal(receipt.state,'applied');
  assert.equal(receipt.payloadDigest,sha256(JSON.stringify({namespace,key,memory})),'the transport receipt is consumed, not synthesized');
  assert.equal(stack.store.db.prepare('SELECT state FROM memory_provider_writes WHERE id=?').get(opId)?.state,'acknowledged');
  const body=await bindings.provider(instanceId,namespace).read({namespace,key});
  assert.equal(memoryBodyDigest(body!),memoryBodyDigest(memory),'the provider preserved the reviewed body exactly');

  // A divergent body under the committed key is rejected by the worker and the
  // submitted intent stays visible; reconcile never rolls the committed body back.
  const divergent={...memory,statement:'Generated divergent body under the same key.'};
  await assert.rejects(()=>bindings.stageMigrationRecord!(namespace,divergent,randomUUID(),()=>{}),{statusCode:502});
  const pending=stack.store.db.prepare("SELECT count(*) n FROM memory_provider_writes WHERE state='submitted'").get()!.n;
  assert.ok(pending>0);
  await publication.reconcile();
  assert.equal(stack.store.db.prepare('SELECT state FROM memory_provider_writes WHERE id=?').get(opId)?.state,'acknowledged','the committed write is not treated as a rollback');
  assert.deepEqual(await bindings.provider(instanceId,namespace).read({namespace,key}),memory);
});

test('a submitted provider write reconciles to its committed body and durable erase intents survive restart',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-provider-adapters-durable-')),stateDirectory=join(directory,'plugin-state');await mkdir(stateDirectory,{mode:0o700});
  let stack=await buildStack(directory);
  const closeStack=async()=>{await stack.platform.close();await stack.plugins.close();await stack.executor.close();await stack.models.close();stack.store.close();};
  t.after(async()=>{await closeStack().catch(()=>{});await rm(directory,{recursive:true,force:true});});
  stack.platform.prepare();stack.platform.start();
  const instanceId=await installProvider(stack.plugins,stack.executor,stateDirectory);
  let bindings=new MemoryBindings(stack.store,new MemoryStore(stack.store),new MemoryAutomation(stack.store),stack.plugins,stack.executor);
  bindings.providerFactory=(id,namespace)=>stack.platform.port.provider(id,namespace);
  let publication=new MemoryPublication(stack.store,new MemoryStore(stack.store),bindings,stack.executor);
  const namespace:MemoryProviderNamespace={ownerId:'generated-owner',instanceId,bindingRevision:11},memory=generatedMemory('Generated lost-acknowledgement record.'),key=memoryProviderKey(memory),opId=randomUUID();

  // The provider committed the write; its reply was lost before acknowledgement.
  await stack.platform.port.provider(instanceId,namespace).put({namespace,key,memory,opId});
  const lostWrite={namespace,key,memory,opId,bodyDigest:memoryBodyDigest(memory),hostPublished:false},lostJson=JSON.stringify(lostWrite);
  stack.store.reserveMetadata(Buffer.byteLength(lostJson));
  stack.store.db.prepare("INSERT INTO memory_provider_writes VALUES(?,?,?,'submitted',?)").run(opId,'generated-parent',lostJson,0);
  await publication.reconcile();
  assert.equal(stack.store.db.prepare('SELECT state FROM memory_provider_writes WHERE id=?').get(opId)?.state,'acknowledged','an observed committed body is acknowledged, never rolled back');

  // A durable erase intent survives a shutdown before its physical removal ran.
  const eraseId='owner-delete:'+memory.id+':'+sha256(JSON.stringify(namespace)),eraseJson=JSON.stringify({namespace,memoryId:memory.id,key});
  stack.store.reserveMetadata(Buffer.byteLength(eraseJson));
  stack.store.db.prepare('INSERT INTO memory_provider_erases VALUES(?,?,\'submitted\')').run(eraseId,eraseJson);
  await publication.close();await closeStack();

  stack=await buildStack(directory);
  stack.platform.prepare();stack.platform.start();
  bindings=new MemoryBindings(stack.store,new MemoryStore(stack.store),new MemoryAutomation(stack.store),stack.plugins,stack.executor);
  bindings.providerFactory=(id,ns)=>stack.platform.port.provider(id,ns);
  publication=new MemoryPublication(stack.store,new MemoryStore(stack.store),bindings,stack.executor);
  await publication.reconcile();
  assert.equal(stack.store.db.prepare('SELECT state FROM memory_provider_erases WHERE id=?').get(eraseId)?.state,'acknowledged','the prepared erase recovered and completed after shutdown');
  assert.equal(await bindings.provider(instanceId,namespace).read({namespace,key}),null);
  await publication.close();
});
