import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,readFile,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {zipSync,strToU8} from 'fflate';
import {Store,sha256} from '../src/store.js';
import {MemoryStore,memoryEvidenceFingerprint} from '../src/memory.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {PluginCenter} from '../src/plugin-center.js';
import {GitHubPluginReleases} from '../src/plugin-release.js';
import {Mem0MemoryProvider} from '../src/mem0-memory-provider.js';
import {memoryProviderKey,type MemoryProviderNamespace} from '../src/memory-provider-contract.js';
import {memorySchema,type Memory} from '../src/memory-schema.js';
import {restoreProfile,verifiedBackup} from '../../../scripts/profile-lib.mjs';
import {canonicalNativeExport} from '../../../scripts/plugin-memory-backup.mjs';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const backupScript=fileURLToPath(new URL('../../../scripts/backup.ts',import.meta.url));
const takeBackup=(source:string,out:string)=>execFileSync(process.execPath,[backupScript,'--data',source,'--out',out],{stdio:'pipe'});

test('stopped-host CLI backup and fresh restore preserve real mem0 bodies, history, tombstones and fixed artifact',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-mem0-backup-')),source=join(directory,'source'),snapshot=join(directory,'snapshot'),target=join(directory,'restored'),store=new Store(source),memories=new MemoryStore(store),executor=new ExecutionEngine(store);
 // Generated transport fixtures exercise the actual fixed-release installer;
 // this test does not claim an internet GitHub installation was performed.
 const commit='a'.repeat(40),archive=zipSync({'generated-upstream/README.md':strToU8('Generated upstream release provenance fixture')});
 const releases=new GitHubPluginReleases(join(source,'plugins/packages'),async url=>({bytes:url.endsWith('/releases/tags/ts-v3.3.1')?strToU8(JSON.stringify({tag_name:'ts-v3.3.1',draft:false,assets:[]})):url.endsWith('/commits/ts-v3.3.1')?strToU8(JSON.stringify({sha:commit})):url.endsWith('/zipball/'+commit)?archive:(()=>{throw Error('Unexpected generated release request');})()}));
 const plugins=new PluginCenter(store,executor,releases),endpoint=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),input=Array.isArray(body.input)?body.input:[body.input];res.setHeader('content-type','application/json');res.end(JSON.stringify({object:'list',data:input.map((_:unknown,index:number)=>({object:'embedding',index,embedding:[1,0,0]})),model:'transport-fixture'}));});
 await new Promise<void>(resolve=>endpoint.listen(0,'127.0.0.1',resolve));
 const configuration={embeddingBaseUrl:`http://127.0.0.1:${(endpoint.address() as {port:number}).port}/v1`,embeddingModel:'transport-fixture',embeddingDimension:3},instanceId=randomUUID();
 let provider:Mem0MemoryProvider|undefined,restored:Store|undefined,restoredProvider:Mem0MemoryProvider|undefined;
 t.after(async()=>{await restoredProvider?.close();restored?.close();await provider?.close();await plugins.close();await executor.close();store.close();endpoint.closeAllConnections();await new Promise<void>(resolve=>endpoint.close(()=>resolve()));await rm(directory,{recursive:true,force:true});});
 const preview=await plugins.resolve({repository:'mem0ai/mem0'}),installId=randomUUID();plugins.install({previewId:preview.id,expectedRevision:plugins.revision(),operationId:installId});await executor.drain(['plugin-install:'+installId]);
 const pkg=plugins.view().packages[0];assert.equal(pkg.state,'installed');plugins.configure(undefined,{packageId:pkg.id,name:'Generated Mem0',scope:'default',configuration,expectedRevision:plugins.revision(),operationId:instanceId});
 const namespace:MemoryProviderNamespace={ownerId:'mote-owner',instanceId,bindingRevision:2},runtimeRelative=`plugins/instances/${instanceId}/configuration-${sha256(plugins.configurationIdentity(instanceId))}`;
 provider=new Mem0MemoryProvider({directory:join(source,runtimeRelative),embedding:{baseUrl:configuration.embeddingBaseUrl,model:configuration.embeddingModel,dimension:3,apiKey:'generated-fixture'}});
 const originalId=randomUUID(),at='2026-10-12T00:00:00Z';await store.ingest({id:originalId,deviceId:'generated-device',deviceName:'Generated',platform:'import',source:'message',capturedAt:at,durationMs:0,appId:'generated',appName:'Generated',ocrText:'Generated original telescope preference',privacy:{excluded:false,redacted:false,mode:'none'}});
 const first:Memory=memorySchema.parse({id:randomUUID(),version:1,title:'Generated telescope',statement:'The fixture uses a violet telescope.',uncertainty:'Generated only',status:'published',domain:'personal',tier:'episode',kind:'episodic',createdAt:at,evidenceIds:[originalId],evidence:[],model:'fixture',runId:'fixture',fingerprint:memoryEvidenceFingerprint(store.evidence([originalId])[0]),admission:{layer:'memory',reason:'Generated fixture',scope:'Generated only',attribution:'observed'}}),second=memorySchema.parse({...first,version:2,title:'Corrected generated telescope',statement:'The fixture uses an amber telescope.',fingerprint:hash('generated-correction')}),deleted=memorySchema.parse({...first,id:randomUUID(),fingerprint:hash('generated-deleted')});
 const firstReceipt=await provider.put({namespace,key:memoryProviderKey(first),memory:first,opId:randomUUID()});await provider.put({namespace,key:memoryProviderKey(second),memory:second,opId:randomUUID()});await provider.put({namespace,key:memoryProviderKey(deleted),memory:deleted,opId:randomUUID()});const deleteId=randomUUID(),deleteReceipt=await provider.remove({namespace,key:memoryProviderKey(deleted),opId:deleteId});
 store.db.prepare('INSERT INTO memories(id,created_at,json) VALUES(?,?,?)').run(second.id,at,JSON.stringify(second));store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(second.id,originalId);store.db.exec('CREATE TABLE memory_plan_binding(id INTEGER PRIMARY KEY,json TEXT NOT NULL)');store.db.prepare('INSERT INTO memory_plan_binding VALUES(1,?)').run(JSON.stringify({planId:'instance:'+instanceId,generation:2,namespace}));
 store.invalidateMemoryEvidence(originalId);const projected=memories.get(second.id);assert.equal(projected.status,'stale');assert.ok(projected.updatedAt);assert.equal(projected.version,second.version);
 assert.deepEqual(canonicalNativeExport({namespace},[projected],await provider.export({namespace}),[]).memories,[projected],'native export applies real host invalidation timestamps without weakening native body checks');
 assert.throws(()=>takeBackup(source,join(directory,'running-failure')),/Memory provider worker is still running/);await assert.rejects(lstat(join(directory,'running-failure')),{code:'ENOENT'});
 await provider.close();takeBackup(source,snapshot);const checked=await verifiedBackup(snapshot);assert.ok(checked.names.includes(runtimeRelative+'/history.db'));assert.ok(checked.names.includes(runtimeRelative+'/operations.db'));assert.ok(checked.names.includes('memory-provider-export.json'));assert.ok(!checked.names.some(name=>name.endsWith('provider.lock')||name.includes('credentials')||name.includes('sdk-state')));
 const canonical=JSON.parse(await readFile(join(snapshot,'memory-provider-export.json'),'utf8'));assert.deepEqual(canonical.memories,[projected]);
 await restoreProfile({meta:{runtime:'native'},dataDir:target,processFile:join(directory,'absent-process')},snapshot);restored=new Store(target);assert.deepEqual(new MemoryStore(restored).get(second.id),projected);
 restoredProvider=new Mem0MemoryProvider({directory:join(target,runtimeRelative),embedding:{baseUrl:configuration.embeddingBaseUrl,model:configuration.embeddingModel,dimension:3,apiKey:'generated-fixture'}});
 assert.deepEqual(await restoredProvider.read({namespace,key:memoryProviderKey(first)}),first);assert.deepEqual(await restoredProvider.read({namespace,key:memoryProviderKey(second)}),second);assert.equal(await restoredProvider.read({namespace,key:memoryProviderKey(deleted)}),null);assert.deepEqual(await restoredProvider.remove({namespace,key:memoryProviderKey(deleted),opId:deleteId}),deleteReceipt);await assert.rejects(restoredProvider.put({namespace,key:memoryProviderKey(deleted),memory:deleted,opId:randomUUID()}),{code:'conflict'});
 const history=new DatabaseSync(join(target,runtimeRelative,'history.db'),{readOnly:true});try{assert.ok(Number(history.prepare('SELECT count(*) n FROM memory_history WHERE memory_id=?').get(firstReceipt.externalId!)!.n)>0);}finally{history.close();}
 await restoredProvider.close();const restoredExecutor=new ExecutionEngine(restored),restoredPlugins=new PluginCenter(restored,restoredExecutor,new GitHubPluginReleases(join(target,'plugins/packages')));try{
  assert.equal(restoredPlugins.packageForInstance(instanceId).directory,join(target,'plugins/packages',preview.source.digest));
  restored.db.prepare('UPDATE memory_plan_binding SET json=? WHERE id=1').run(JSON.stringify({planId:'mote.builtin',generation:3}));restoredPlugins.uninstall(pkg.id,{expectedRevision:restoredPlugins.revision(),operationId:randomUUID()});assert.equal(restoredPlugins.view().packages.length,0);
  assert.equal(restoredPlugins.packageForInstance(instanceId).directory,join(target,'plugins/packages',preview.source.digest),'retired native history retains exact configuration and artifact lookup');
  const retiredSnapshot=join(directory,'retired-snapshot');takeBackup(target,retiredSnapshot);const retired=await verifiedBackup(retiredSnapshot);assert.ok(retired.names.includes(runtimeRelative+'/history.db'));assert.ok(retired.names.includes('plugins/packages/'+preview.source.digest+'/mote-install-lock.json'),'retired SDK history keeps its fixed native artifact in complete backups');
 }finally{await restoredPlugins.close();await restoredExecutor.close();}
 // Missing external data fails before producing an allegedly complete backup.
 await rm(join(target,runtimeRelative,'vectors.db'));assert.throws(()=>takeBackup(target,join(directory,'missing-failure')),/Memory provider database is missing/);await assert.rejects(lstat(join(directory,'missing-failure')),{code:'ENOENT'});
});
