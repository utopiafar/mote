import {modelConfigService} from './fixtures/model-config-service.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {zipSync,strToU8} from 'fflate';
import {Store,sha256} from '../src/store.js';
import {MemoryStore,memoryEvidenceFingerprint} from '../src/memory.js';
import {memorySchema} from '../src/memory-schema.js';
import {memoryProviderKey,type MemoryProviderNamespace} from '../src/memory-provider-contract.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {PluginCenter} from '../src/plugin-center.js';
import {GitHubPluginReleases,type PluginManifest,type PluginReleaseTransport} from '../src/plugin-release.js';
import {MemoryAdapters} from '../src/memory-adapters.js';
import {MemoryBindings} from '../src/memory-bindings.js';
import {MemoryAutomation} from '../src/memory-automation.js';
import {MemoryPublication} from '../src/plugins/memory-publication.js';
import {ModelSettingsStore} from '../src/model-settings.js';
import {createMemoryProvider} from '../../../examples/worker-plugin/main.mjs';

// Self-contained generated worker payload: immutable records, exact opId
// replay, deletion history and scoped retrieval over one private JSON file.
const generatedWorker=String.raw`
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export async function createMemoryProvider(configuration){
 let state;try{state=JSON.parse(await readFile(configuration.dataFile,'utf8'));}catch{state={records:[],receipts:{}};}
 const save=async()=>{await mkdir(dirname(configuration.dataFile),{recursive:true});await writeFile(configuration.dataFile,JSON.stringify(state));};
 const matches=(record,input)=>same(record.namespace,input.namespace)&&same(record.key,input.key);
 const selected=input=>state.records.filter(record=>same(record.namespace,input.namespace));
 const receipt=(input,status)=>({opId:input.opId,namespace:input.namespace,key:input.key,payloadDigest:hash({namespace:input.namespace,key:input.key,memory:input.memory}),state:status,eraseVerified:false,recordedAt:'2026-10-12T00:00:00Z',...(status==='removed'?{currentRemoved:true,historyRetained:true}:{})});
 return {
  async health(){return {providerId:'generated.configuration-worker',version:'1.0.0',ready:true,verified:{persistentCrud:true,scopedRetrieval:true,immutableRecords:true,idempotentReplay:true,history:true,physicalErase:false},problems:[]};},
  async put(input){const prior=state.receipts[input.opId];if(prior){if(prior.fingerprint!==hash(input))throw Error('Generated intent conflict');return prior.value;}const existing=state.records.find(record=>matches(record,input));if(existing&&!same(existing.memory,input.memory))throw Error('Generated immutable conflict');if(!existing)state.records.push({namespace:input.namespace,key:input.key,memory:input.memory});const value=receipt(input,'applied');state.receipts[input.opId]={fingerprint:hash(input),value};await save();return value;},
  async read(input){return state.records.find(record=>matches(record,input))?.memory??null;},
  async remove(input){const prior=state.receipts[input.opId];if(prior)return prior.value;state.records=state.records.filter(record=>!matches(record,input));const value=receipt(input,'removed');state.receipts[input.opId]={fingerprint:hash(input),value};await save();return value;},
  async search(input){const records=selected(input);return records.filter(record=>!input.keys||input.keys.some(key=>same(key,record.key))).slice(0,input.limit??records.length);},
  async export(input){return selected(input);},
  async close(){await save();}
 };
}
`;
function generatedRelease(){
 const repository='generated-fixture/configuration-worker',tag='v1.0.0',commit='a'.repeat(40),archive=zipSync({'worker.mjs':strToU8(generatedWorker)});
 const manifest:PluginManifest={schemaVersion:1,id:'generated.configuration-worker',name:'Generated configuration worker',version:'1.0.0',runtime:'worker',entry:'worker.mjs',archive:{asset:'worker.zip',sha256:sha256(archive)},capabilities:['repository','retrieval'],configuration:[{id:'dataFile',label:'Generated data file',type:'text',required:true}],dependencies:[],access:['Generated fixture directory only']};
 const base=`https://github.com/${repository}/releases/download/${tag}/`,transport:PluginReleaseTransport=async url=>{
  if(url.endsWith('/releases/tags/'+tag))return {bytes:strToU8(JSON.stringify({tag_name:tag,draft:false,assets:[{name:'mote-plugin.json',browser_download_url:base+'mote-plugin.json'},{name:'worker.zip',browser_download_url:base+'worker.zip'}]}))};
  if(url.endsWith('/commits/'+tag))return {bytes:strToU8(JSON.stringify({sha:commit}))};
  if(url===base+'mote-plugin.json')return {bytes:strToU8(JSON.stringify(manifest))};
  if(url===base+'worker.zip')return {bytes:archive};
  throw Error('Unexpected generated release request');
 };
 return {repository,tag,transport};
}

test('generated provider history erasure returns to configuration A after migration, reconfiguration B and adapter restart',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-adapter-configurations-')),vault=join(directory,'vault'),store=new Store(vault),memories=new MemoryStore(store),executor=new ExecutionEngine(store),release=generatedRelease();
 const releases=new GitHubPluginReleases(join(vault,'plugins/packages'),release.transport),plugins=new PluginCenter(store,executor,releases);
 const models=new ModelSettingsStore({configService:modelConfigService(join(directory,'models'),{provider:'custom',protocol:'openai-completions',baseUrl:'https://generated.invalid/v1',model:'generated-unused',reasoningEffort:'auto',maxTokens:1024,modelRequestTimeoutMs:5000,agentTimeoutMs:5000,allowUnauthenticatedLocal:false,apiKey:'',headers:{},extraBody:{}}),prepare:async()=>({activate(){},async dispose(){}}),probe:async()=>{throw Error('No model should run in this storage journey');}});await models.initialize();
 let adapters=new MemoryAdapters(join(vault,'plugins/instances'),plugins,models);const bindings=new MemoryBindings(store,memories,new MemoryAutomation(store),plugins,executor),publication=new MemoryPublication(store,memories,bindings);
 bindings.providerFactory=(id,ns)=>adapters.provider(id,ns);plugins.probe=(id,signal)=>adapters.probe(id,signal);plugins.configurationAllowed=(field,value)=>adapters.configurationAllowed(field.type,value);
 t.after(async()=>{await publication.close();await bindings.close();await adapters.close();await plugins.close();await executor.close();await models.close();store.close();await rm(directory,{recursive:true,force:true});});
 const preview=await plugins.resolve({repository:release.repository,tag:release.tag}),installId=randomUUID();plugins.install({previewId:preview.id,expectedRevision:plugins.revision(),operationId:installId});await executor.drain(['plugin-install:'+installId]);const packageId=plugins.view().packages[0]!.id,instanceId=randomUUID(),dataFileA=join(vault,'plugins/instances',instanceId,'configuration-'+sha256(instanceId),'provider.json');
 plugins.configure(undefined,{packageId,name:'Generated A',scope:'default',configuration:{dataFile:dataFileA},expectedRevision:plugins.revision(),operationId:instanceId});const identityA=plugins.configurationIdentity(instanceId);
 const check=async()=>{const operationId=randomUUID();plugins.action(instanceId,'check',{operationId,expectedRevision:plugins.instanceView(instanceId).revision});await executor.drain(['plugin-check:'+operationId]);assert.equal(plugins.instanceView(instanceId).observed,'ready');plugins.action(instanceId,'enable',{operationId:randomUUID(),expectedRevision:plugins.instanceView(instanceId).revision});};await check();
 const evidenceId=randomUUID(),at='2026-10-12T00:00:00Z';await store.ingest({id:evidenceId,deviceId:'generated-device',deviceName:'Generated',platform:'import',source:'message',capturedAt:at,durationMs:0,appId:'generated',appName:'Generated',ocrText:'Generated observatory uses a violet telescope.',privacy:{excluded:false,redacted:false,mode:'none'}});
 const memory=memorySchema.parse({id:randomUUID(),version:1,title:'Generated observatory',statement:'The fixture uses a violet telescope.',uncertainty:'Generated only',status:'published',domain:'personal',tier:'episode',kind:'episodic',createdAt:at,evidenceIds:[evidenceId],evidence:[],model:'fixture',runId:'fixture',fingerprint:memoryEvidenceFingerprint(store.evidence([evidenceId])[0]),admission:{layer:'memory',reason:'Generated',scope:'Generated fixture',attribution:'observed'}});store.db.prepare('INSERT INTO memories(id,created_at,json) VALUES(?,?,?)').run(memory.id,at,JSON.stringify(memory));store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(memory.id,evidenceId);
 const dependent=memorySchema.parse({...memory,id:randomUUID(),title:'Generated second dependent'});store.db.prepare('INSERT INTO memories(id,created_at,json) VALUES(?,?,?)').run(dependent.id,at,JSON.stringify(dependent));store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(dependent.id,evidenceId);
 const migrate=async(targetPlanId:string)=>{const operationId=randomUUID();bindings.prepare({targetPlanId,scope:'default',feeAcknowledged:true,operationId,expectedRevision:bindings.view().revision});await executor.drain(['memory-prepare:'+operationId]);assert.equal(bindings.view().preparation?.state,'verified');bindings.action('activate',{preparationId:operationId,operationId:randomUUID(),expectedRevision:bindings.view().revision});};
 await migrate('instance:'+instanceId);const namespaceA=bindings.binding().namespace!;assert.deepEqual(await adapters.provider(instanceId,namespaceA).read({namespace:namespaceA,key:memoryProviderKey(memory)}),memory);await migrate('mote.builtin');
 plugins.action(instanceId,'disable',{operationId:randomUUID(),expectedRevision:plugins.instanceView(instanceId).revision});const identityB=randomUUID(),dataFileB=join(vault,'plugins/instances',instanceId,'configuration-'+sha256(identityB),'provider.json');plugins.configure(instanceId,{name:'Generated B',scope:'default',configuration:{dataFile:dataFileB},expectedRevision:plugins.instanceView(instanceId).revision,operationId:identityB});assert.notEqual(identityA,plugins.configurationIdentity(instanceId));await check();
 const namespaceB:MemoryProviderNamespace={...namespaceA,bindingRevision:namespaceA.bindingRevision+10},other=memorySchema.parse({...memory,id:randomUUID(),title:'Independent generated B'});await adapters.provider(instanceId,namespaceB).put({namespace:namespaceB,key:memoryProviderKey(other),memory:other,opId:randomUUID()});
 await adapters.close();adapters=new MemoryAdapters(join(vault,'plugins/instances'),plugins,models);
 const erased=await publication.delete(memory.id);assert.equal(erased.externalErase,'acknowledged');assert.equal(erased.physicalEraseVerified,false);assert.equal(await adapters.provider(instanceId,namespaceA).read({namespace:namespaceA,key:memoryProviderKey(memory)}),null,'A body is actually removed after new B configuration and process restart');assert.deepEqual(await adapters.provider(instanceId,namespaceB).read({namespace:namespaceB,key:memoryProviderKey(other)}),other,'B unrelated body survives');
 store.delete(evidenceId);assert.throws(()=>memories.get(dependent.id),/not found/);assert.equal(store.db.prepare('SELECT state FROM memory_provider_evidence_revocations WHERE id=?').get(evidenceId)?.state,'submitted');
 publication.revokeEvidence=async ids=>{assert.deepEqual(ids,[evidenceId]);throw Error('Generated unavailable native cleanup');};await publication.reconcile();assert.equal(publication.pending()>0,true);assert.deepEqual(await adapters.provider(instanceId,namespaceA).read({namespace:namespaceA,key:memoryProviderKey(dependent)}),dependent,'unknown native source cleanup keeps an honest durable intent');
 const generation=Number(store.db.prepare('SELECT generation FROM memory_provider_evidence_revocations WHERE id=?').get(evidenceId)!.generation);publication.revokeEvidence=async()=>{store.invalidateSemanticEvidence(evidenceId);};await publication.reconcile();assert.equal(store.db.prepare('SELECT state FROM memory_provider_evidence_revocations WHERE id=?').get(evidenceId)?.state,'submitted','a late old cleanup ACK cannot acknowledge a newer revocation generation');assert.equal(Number(store.db.prepare('SELECT generation FROM memory_provider_evidence_revocations WHERE id=?').get(evidenceId)!.generation),generation+1);
 publication.revokeEvidence=async()=>{};await publication.reconcile();assert.equal(store.db.prepare('SELECT state FROM memory_provider_evidence_revocations WHERE id=?').get(evidenceId)?.state,'acknowledged');assert.equal(await adapters.provider(instanceId,namespaceA).read({namespace:namespaceA,key:memoryProviderKey(dependent)}),null,'actual source deletion erases its formerly published native dependent');assert.equal(publication.pending(),0);
 const rows=store.db.prepare('SELECT json FROM memory_provider_configurations').all().map(row=>JSON.parse(String(row.json)));assert.equal(rows.find(row=>row.namespace.bindingRevision===namespaceA.bindingRevision).identity,identityA);assert.equal(rows.find(row=>row.namespace.bindingRevision===namespaceB.bindingRevision).identity,identityB);
 assert.throws(()=>adapters.provider(instanceId,{...namespaceA,instanceId:'another-instance'}),/different plugin instance/);
});

test('a separate maintenance process source deletion survives complete host close and clears generated provider bodies on restart',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-source-outbox-restart-')),vault=join(directory,'vault'),native=join(directory,'native'),namespace={ownerId:'generated-owner',instanceId:'generated-native',bindingRevision:2};
 let now=Date.now();
 const open=async()=>{const store=new Store(vault),memories=new MemoryStore(store),executor=new ExecutionEngine(store,()=>now),plugins=new PluginCenter(store,executor,new GitHubPluginReleases(join(vault,'plugins/packages'))),bindings=new MemoryBindings(store,memories,new MemoryAutomation(store),plugins,executor),provider=await createMemoryProvider({dataFile:join(native,'provider.json')});bindings.providerFactory=()=>provider;return {store,memories,executor,plugins,bindings,provider};};
 type Host=Awaited<ReturnType<typeof open>>;
 const close=async(host:Host,publication:MemoryPublication)=>{await publication.close();await host.bindings.close();await host.provider.close();await host.plugins.close();await host.executor.close();host.store.close();};
 let host=await open(),publication=new MemoryPublication(host.store,host.memories,host.bindings);t.after(async()=>{await close(host,publication);await rm(directory,{recursive:true,force:true});});
 const evidenceId=randomUUID(),at='2026-10-12T00:00:00Z';await host.store.ingest({id:evidenceId,deviceId:'generated-device',deviceName:'Generated',platform:'import',source:'message',capturedAt:at,durationMs:0,appId:'generated',appName:'Generated',ocrText:'Generated native outbox telescope fixture.',privacy:{excluded:false,redacted:false,mode:'none'}});
 const memory=memorySchema.parse({id:randomUUID(),version:1,title:'Generated telescope',statement:'The outbox fixture uses a telescope.',uncertainty:'Generated only',status:'published',domain:'personal',tier:'episode',kind:'episodic',createdAt:at,evidenceIds:[evidenceId],evidence:[],model:'fixture',runId:'fixture',fingerprint:memoryEvidenceFingerprint(host.store.evidence([evidenceId])[0]),admission:{layer:'memory',reason:'Generated',scope:'Generated fixture',attribution:'observed'}});host.store.db.prepare('INSERT INTO memories(id,created_at,json) VALUES(?,?,?)').run(memory.id,at,JSON.stringify(memory));host.store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(memory.id,evidenceId);host.store.db.prepare('UPDATE memory_plan_binding SET json=? WHERE id=1').run(JSON.stringify({planId:'instance:'+namespace.instanceId,generation:2,namespace}));await publication.stageRecords('generated-publication',[memory],()=>{});
 host.store.db.exec("CREATE TRIGGER generated_delete_failure BEFORE DELETE ON captures BEGIN SELECT RAISE(ABORT,'generated rollback fixture'); END;");assert.throws(()=>host.store.delete(evidenceId),/generated rollback fixture/);host.store.db.exec('DROP TRIGGER generated_delete_failure');assert.equal(host.store.db.prepare('SELECT state FROM memory_provider_evidence_revocations WHERE id=?').get(evidenceId),undefined,'failed original deletion rolls back its external cleanup outbox');assert.deepEqual(host.memories.get(memory.id),memory);assert.deepEqual(await host.provider.read({namespace,key:memoryProviderKey(memory)}),memory);
 // A real separate process changes only the generated vault while the host is
 // still open. There is no in-process mutation callback to notify this host.
 const script=`import {Store} from ${JSON.stringify(new URL('../src/store.ts',import.meta.url).href)};import {MemoryStore} from ${JSON.stringify(new URL('../src/memory.ts',import.meta.url).href)};const store=new Store(${JSON.stringify(vault)});new MemoryStore(store);store.delete(${JSON.stringify(evidenceId)});store.close();`;
 execFileSync(process.execPath,['--import','tsx','--input-type=module','--eval',script],{stdio:'pipe'});assert.equal(host.store.db.prepare('SELECT state FROM memory_provider_evidence_revocations WHERE id=?').get(evidenceId)?.state,'submitted');assert.deepEqual(await host.provider.read({namespace,key:memoryProviderKey(memory)}),memory,'external bytes survive until durable reconciliation actually runs');
 // Use the actual dispatcher for the failed attempt as well as recovery.
 // A controlled provider outage must retain its exact durable erase intent.
 let eraseCalls=0;t.mock.method(host.provider,'remove',async()=>{eraseCalls++;throw Error('Generated provider erasure unavailable');});
 await publication.close();publication=new MemoryPublication(host.store,host.memories,host.bindings,host.executor);
 const failedSteps=host.store.db.prepare("SELECT id FROM execution_steps WHERE kind='memory.provider-reconcile' AND state IN ('waiting','running')").all().map(row=>String(row.id));assert.equal(failedSteps.length,1);await host.executor.drain(failedSteps);
 assert.equal(eraseCalls,1);assert.equal(publication.pending(),1);assert.deepEqual(await host.provider.read({namespace,key:memoryProviderKey(memory)}),memory,'failed physical erasure retains the real generated body');
 const erase=host.store.db.prepare("SELECT id,json,state FROM memory_provider_erases WHERE state='submitted'").get()!;assert.ok(erase);assert.equal(JSON.parse(String(erase.json)).memoryId,memory.id);
 const failed=host.executor.get(failedSteps[0])!;assert.equal(failed.state,'waiting');assert.equal(failed.error,'memory_provider_result_unknown');assert.equal(failed.attempts,0,'provider uncertainty is a wait, not a spent processing attempt');
 await close(host,publication);now+=5001;host=await open();publication=new MemoryPublication(host.store,host.memories,host.bindings,host.executor);
 assert.deepEqual(host.store.db.prepare('SELECT id,json,state FROM memory_provider_erases WHERE id=?').get(erase.id),erase,'complete restart retains the exact retry identity');
 const steps=host.store.db.prepare("SELECT id FROM execution_steps WHERE kind='memory.provider-reconcile' AND state IN ('waiting','running')").all().map(row=>String(row.id));assert.deepEqual(steps,failedSteps);await host.executor.drain(steps);
 assert.equal(host.store.db.prepare('SELECT state FROM memory_provider_erases WHERE id=?').get(erase.id)?.state,'acknowledged');assert.equal(host.executor.get(steps[0])?.state,'succeeded');
 assert.equal(host.store.db.prepare('SELECT state FROM memory_provider_evidence_revocations WHERE id=?').get(evidenceId)?.state,'acknowledged');assert.equal(await host.provider.read({namespace,key:memoryProviderKey(memory)}),null);assert.equal(publication.pending(),0);assert.throws(()=>host.memories.get(memory.id),/not found/);
});
