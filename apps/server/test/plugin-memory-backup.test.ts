import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,readFile,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
import {Store,sha256} from '../src/store.js';
import {MemoryStore,memoryEvidenceFingerprint} from '../src/memory.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {PluginCenter} from '../src/plugin-center.js';
import {GitHubPluginReleases,type PluginManifest,type PluginReleaseTransport} from '../src/plugin-release.js';
import {WorkerPluginRuntime} from '../src/plugin-runtime.js';
import {WorkerMemoryProvider} from '../src/worker-memory-provider.js';
import {memoryProviderKey,type MemoryProviderNamespace} from '../src/memory-provider-contract.js';
import {memorySchema,type Memory} from '../src/memory-schema.js';
import {restoreProfile,verifiedBackup} from '../../../scripts/profile-lib.mjs';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const backupScript=fileURLToPath(new URL('../../../scripts/backup.ts',import.meta.url));
const takeBackup=(source:string,out:string)=>execFileSync(process.execPath,[backupScript,'--data',source,'--out',out],{stdio:'pipe'});
// Generated worker payload with immutable records, exact receipt replay and
// durable tombstones: a removed key can never be recreated.
const generatedWorker=String.raw`
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export async function createMemoryProvider(configuration){
 let state;try{state=JSON.parse(await readFile(configuration.dataFile,'utf8'));}catch{state={records:[],receipts:{},removed:[]};}
 if(!state.removed)state.removed=[];
 await mkdir(dirname(configuration.lockFile),{recursive:true});await writeFile(configuration.lockFile,JSON.stringify({pid:process.pid}));
 const save=async()=>{await mkdir(dirname(configuration.dataFile),{recursive:true});await writeFile(configuration.dataFile,JSON.stringify(state));};
 const matches=(record,input)=>same(record.namespace,input.namespace)&&same(record.key,input.key);
 const keyTag=input=>JSON.stringify({namespace:input.namespace,key:input.key});
 const receipt=(input,status)=>({opId:input.opId,namespace:input.namespace,key:input.key,payloadDigest:hash({namespace:input.namespace,key:input.key,memory:input.memory}),state:status,eraseVerified:false,recordedAt:'2026-10-12T00:00:00Z',...(status==='removed'?{currentRemoved:true,historyRetained:true}:{})});
 return {
  async health(){return {providerId:'generated.backup-worker',version:'1.0.0',ready:true,verified:{persistentCrud:true,scopedRetrieval:true,immutableRecords:true,idempotentReplay:true,history:true,physicalErase:false},problems:[]};},
  async put(input){const prior=state.receipts[input.opId];if(prior){if(prior.fingerprint!==hash(input))throw Error('Generated intent conflict');return prior.value;}if(state.removed.includes(keyTag(input)))throw Error('Generated removed immutable key cannot be recreated');const existing=state.records.find(record=>matches(record,input));if(existing&&!same(existing.memory,input.memory))throw Error('Generated immutable conflict');if(!existing)state.records.push({namespace:input.namespace,key:input.key,memory:input.memory});const value=receipt(input,'applied');state.receipts[input.opId]={fingerprint:hash(input),value};await save();return value;},
  async read(input){if(state.removed.includes(keyTag(input)))return null;return state.records.find(record=>matches(record,input))?.memory??null;},
  async remove(input){const prior=state.receipts[input.opId];if(prior)return prior.value;const tag=keyTag(input);if(!state.removed.includes(tag))state.removed.push(tag);state.records=state.records.filter(record=>!matches(record,input));const value=receipt(input,'removed');state.receipts[input.opId]={fingerprint:hash(input),value};await save();return value;},
  async search(input){const records=state.records.filter(record=>same(record.namespace,input.namespace)&&!state.removed.includes(keyTag(record)));return records.filter(record=>!input.keys||input.keys.some(key=>same(key,record.key))).slice(0,input.limit??records.length);},
  async export(input){return state.records.filter(record=>same(record.namespace,input.namespace)&&!state.removed.includes(keyTag(record)));},
  async close(){await save();await rm(configuration.lockFile,{force:true});}
 };
}
`;

test('stopped-host CLI backup and fresh restore preserve generated plugin bodies, history, tombstones and fixed artifact',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-plugin-backup-')),source=join(directory,'source'),snapshot=join(directory,'snapshot'),target=join(directory,'restored'),store=new Store(source),memories=new MemoryStore(store),executor=new ExecutionEngine(store);
 const repository='generated-fixture/backup-worker',tag='v1.0.0',commit='a'.repeat(40),archive=zipSync({'worker.mjs':strToU8(generatedWorker)}),manifest:PluginManifest={schemaVersion:1,id:'generated.backup-worker',name:'Generated backup worker',version:'1.0.0',runtime:'worker',entry:'worker.mjs',archive:{asset:'worker.zip',sha256:sha256(archive)},capabilities:['repository','retrieval'],configuration:[{id:'dataFile',label:'Generated data file',type:'text',required:true},{id:'lockFile',label:'Generated provider lock',type:'text',required:true}],dependencies:[],access:['Generated fixture directory only']};
 const base=`https://github.com/${repository}/releases/download/${tag}/`,transport:PluginReleaseTransport=async url=>{
  if(url.endsWith('/releases/tags/'+tag))return {bytes:strToU8(JSON.stringify({tag_name:tag,draft:false,assets:[{name:'mote-plugin.json',browser_download_url:base+'mote-plugin.json'},{name:'worker.zip',browser_download_url:base+'worker.zip'}]}))};
  if(url.endsWith('/commits/'+tag))return {bytes:strToU8(JSON.stringify({sha:commit}))};
  if(url===base+'mote-plugin.json')return {bytes:strToU8(JSON.stringify(manifest))};
  if(url===base+'worker.zip')return {bytes:archive};
  throw Error('Unexpected generated release request');
 };
 const releases=new GitHubPluginReleases(join(source,'plugins/packages'),transport),plugins=new PluginCenter(store,executor,releases),instanceId=randomUUID(),runtimeRelative=`plugins/instances/${instanceId}/configuration-${sha256(instanceId)}`,dataFile=join(source,runtimeRelative,'provider.json'),lockFile=join(source,runtimeRelative,'provider.lock');
 let provider:WorkerMemoryProvider|undefined,restored:Store|undefined,restoredProvider:WorkerMemoryProvider|undefined,restoredPlugins:PluginCenter|undefined,restoredExecutor:ExecutionEngine|undefined;
 t.after(async()=>{await restoredProvider?.close();restored?.close();await provider?.close();await restoredPlugins?.close();await restoredExecutor?.close();await plugins.close();await executor.close();store.close();await rm(directory,{recursive:true,force:true});});
 const preview=await plugins.resolve({repository,tag}),installId=randomUUID();plugins.install({previewId:preview.id,expectedRevision:plugins.revision(),operationId:installId});await executor.drain(['plugin-install:'+installId]);
 const pkg=plugins.view().packages[0]!;assert.equal(pkg.state,'installed');plugins.configure(undefined,{packageId:pkg.id,name:'Generated backup provider',scope:'default',configuration:{dataFile,lockFile},expectedRevision:plugins.revision(),operationId:instanceId});
 const instance=plugins.instanceView(instanceId),packageRecord=plugins.packageForInstance(instanceId);provider=new WorkerMemoryProvider(new WorkerPluginRuntime(join(packageRecord.directory!,packageRecord.manifest.entry),instance.configuration,packageRecord.directory!));
 const namespace:MemoryProviderNamespace={ownerId:'mote-owner',instanceId,bindingRevision:2};
 const originalId=randomUUID(),at='2026-10-12T00:00:00Z';await store.ingest({id:originalId,deviceId:'generated-device',deviceName:'Generated',platform:'import',source:'message',capturedAt:at,durationMs:0,appId:'generated',appName:'Generated',ocrText:'Generated original telescope preference',privacy:{excluded:false,redacted:false,mode:'none'}});
 const first:Memory=memorySchema.parse({id:randomUUID(),version:1,title:'Generated telescope',statement:'The fixture uses a violet telescope.',uncertainty:'Generated only',status:'published',domain:'personal',tier:'episode',kind:'episodic',createdAt:at,evidenceIds:[originalId],evidence:[],model:'fixture',runId:'fixture',fingerprint:memoryEvidenceFingerprint(store.evidence([originalId])[0]),admission:{layer:'memory',reason:'Generated fixture',scope:'Generated only',attribution:'observed'}}),second=memorySchema.parse({...first,version:2,title:'Corrected generated telescope',statement:'The fixture uses an amber telescope.',fingerprint:hash('generated-correction')}),deleted=memorySchema.parse({...first,id:randomUUID(),fingerprint:hash('generated-deleted')});
 const firstReceipt=await provider.put({namespace,key:memoryProviderKey(first),memory:first,opId:randomUUID()});await provider.put({namespace,key:memoryProviderKey(second),memory:second,opId:randomUUID()});await provider.put({namespace,key:memoryProviderKey(deleted),memory:deleted,opId:randomUUID()});const deleteId=randomUUID(),deleteReceipt=await provider.remove({namespace,key:memoryProviderKey(deleted),opId:deleteId});
 store.db.prepare('INSERT INTO memories(id,created_at,json) VALUES(?,?,?)').run(second.id,at,JSON.stringify(second));store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(second.id,originalId);store.db.exec('CREATE TABLE memory_plan_binding(id INTEGER PRIMARY KEY,json TEXT NOT NULL)');store.db.prepare('INSERT INTO memory_plan_binding VALUES(1,?)').run(JSON.stringify({planId:'instance:'+instanceId,generation:2,namespace}));
 store.invalidateMemoryEvidence(originalId);const projected=memories.get(second.id);assert.equal(projected.status,'stale');assert.ok(projected.updatedAt);assert.equal(projected.version,second.version);
 assert.throws(()=>takeBackup(source,join(directory,'running-failure')),/Memory provider worker is still running/);await assert.rejects(lstat(join(directory,'running-failure')),{code:'ENOENT'});
 await provider.close();provider=undefined;takeBackup(source,snapshot);const checked=await verifiedBackup(snapshot);assert.ok(checked.names.includes(runtimeRelative+'/provider.json'),'the generated provider data file is part of the stopped backup');assert.ok(checked.names.includes('plugins/packages/'+preview.source.digest+'/mote-install-lock.json'));assert.ok(!checked.names.some(name=>name.endsWith('provider.lock')||name.includes('credentials')||name.includes('sdk-state')));
 await restoreProfile({meta:{runtime:'native'},dataDir:target,processFile:join(directory,'absent-process')},snapshot);restored=new Store(target);assert.deepEqual(new MemoryStore(restored).get(second.id),projected,'host history and invalidation state restore with the provider data');
 restoredPlugins=new PluginCenter(restored,restoredExecutor=new ExecutionEngine(restored),new GitHubPluginReleases(join(target,'plugins/packages')));const restoredPackage=restoredPlugins.packageForInstance(instanceId),restoredInstance=restoredPlugins.instanceView(instanceId);
 restoredProvider=new WorkerMemoryProvider(new WorkerPluginRuntime(join(restoredPackage.directory!,restoredPackage.manifest.entry),restoredInstance.configuration,restoredPackage.directory!));
 assert.deepEqual(await restoredProvider.read({namespace,key:memoryProviderKey(first)}),first);assert.deepEqual(await restoredProvider.read({namespace,key:memoryProviderKey(second)}),second);assert.equal(await restoredProvider.read({namespace,key:memoryProviderKey(deleted)}),null,'a deleted generated body restores as deleted');assert.deepEqual(await restoredProvider.remove({namespace,key:memoryProviderKey(deleted),opId:deleteId}),deleteReceipt,'the tombstone receipt is durable');await assert.rejects(restoredProvider.put({namespace,key:memoryProviderKey(deleted),memory:deleted,opId:randomUUID()}),{statusCode:502},'a tombstoned key cannot be recreated');
 const restoredDataFile=join(target,runtimeRelative,'provider.json');const history=JSON.parse(await readFile(restoredDataFile,'utf8'));assert.ok(history.receipts[firstReceipt.opId],'exact operation history survives restore');
 await restoredProvider.close();restoredProvider=undefined;
 assert.equal(restoredPlugins.packageForInstance(instanceId).directory,join(target,'plugins/packages',preview.source.digest));
 restored.db.prepare('UPDATE memory_plan_binding SET json=? WHERE id=1').run(JSON.stringify({planId:'mote.builtin',generation:3}));restoredPlugins.uninstall(pkg.id,{expectedRevision:restoredPlugins.revision(),operationId:randomUUID()});assert.equal(restoredPlugins.view().packages.length,0);
 assert.equal(restoredPlugins.packageForInstance(instanceId).directory,join(target,'plugins/packages',preview.source.digest),'retired provider history retains exact configuration and artifact lookup');
 const retiredSnapshot=join(directory,'retired-snapshot');takeBackup(target,retiredSnapshot);const retired=await verifiedBackup(retiredSnapshot);assert.ok(retired.names.includes(runtimeRelative+'/provider.json'));assert.ok(retired.names.includes('plugins/packages/'+preview.source.digest+'/mote-install-lock.json'),'retired provider history keeps its fixed artifact in complete backups');
 // Missing external data fails before producing an allegedly complete backup.
 await rm(join(target,'plugins/packages',preview.source.digest),{recursive:true});assert.throws(()=>takeBackup(target,join(directory,'missing-failure')),/ENOENT|artifact/);await assert.rejects(lstat(join(directory,'missing-failure')),{code:'ENOENT'});
});
