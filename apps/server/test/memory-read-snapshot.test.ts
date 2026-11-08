import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store,StoreError} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {registerEvidenceRoutes} from '../src/evidence-routes.js';
import {MemoryBindings} from '../src/memory-bindings.js';
import {MemoryAutomation} from '../src/memory-automation.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {PluginCenter} from '../src/plugin-center.js';
import {GitHubPluginReleases} from '../src/plugin-release.js';
import {memoryProviderKey,type MemoryProvider,type MemoryProviderNamespace,type MemoryProviderRead,type MemoryProviderRecord,type MemoryProviderReceipt} from '../src/memory-provider-contract.js';
import {memorySchema,type Memory} from '../src/memory-schema.js';
import {memoryEvidenceFingerprint} from '../src/memory.js';

// The provider is the external service boundary; the snapshot path under test
// runs on real SQLite and real HTTP inject. Deeper provider verification stays
// in memory-provider-consumers.test.ts against the generated worker transport.
function generatedProvider(){
 const bodies=new Map<string,{namespace:MemoryProviderNamespace;key:MemoryProviderRead['key'];memory:Memory}>();
 const id=(input:{namespace:MemoryProviderNamespace;key:MemoryProviderRead['key']})=>JSON.stringify({namespace:input.namespace,key:input.key});
 const receipt=(input:{namespace:MemoryProviderNamespace;key:MemoryProviderRead['key'];opId:string},state:MemoryProviderReceipt['state']):MemoryProviderReceipt=>({opId:input.opId,namespace:input.namespace,key:input.key,payloadDigest:'generated',state,eraseVerified:true,recordedAt:new Date().toISOString()});
 const provider:MemoryProvider={
  put:async input=>{bodies.set(id(input),{namespace:input.namespace,key:input.key,memory:input.memory});return receipt(input,'applied');},
  read:async input=>bodies.get(id(input))?.memory??null,
  remove:async input=>{bodies.delete(id(input));return receipt(input,'removed');},
  search:async input=>(input.keys??[]).flatMap(key=>{const body=bodies.get(id({namespace:input.namespace,key}));return body?[{...body,score:1}]:[];}),
  export:async input=>[...bodies.values()].filter(record=>JSON.stringify(record.namespace)===JSON.stringify(input.namespace)) as MemoryProviderRecord[],
  health:async()=>({providerId:'generated',version:'1',ready:true,verified:{persistentCrud:true,scopedRetrieval:true,immutableRecords:true,idempotentReplay:true,history:true,physicalErase:true},problems:[]}),
  recover:async()=>({providerId:'generated',version:'1',ready:true,verified:{persistentCrud:true,scopedRetrieval:true,immutableRecords:true,idempotentReplay:true,history:true,physicalErase:true},problems:[]}),
  close:async()=>{},
 };
 return provider;
}

async function fixture(t:any,count=200){
 const directory=await mkdtemp(join(tmpdir(),'mote-read-snapshot-')),store=new Store(join(directory,'vault')),sources=new SourceStore(store),reader=new EvidenceReader(store,sources);
 const executor=new ExecutionEngine(store),plugins=new PluginCenter(store,executor,new GitHubPluginReleases(join(directory,'plugins'))),bindings=new MemoryBindings(store,reader.memories,new MemoryAutomation(store),plugins,executor);reader.memoryBindings=bindings;
 const app=Fastify();app.setErrorHandler((error,_req,reply)=>reply.code(error instanceof StoreError?error.statusCode:500).send({error:error.message}));registerEvidenceRoutes(app,reader);
 const namespace:MemoryProviderNamespace={ownerId:'generated-owner',instanceId:'generated-provider',bindingRevision:1},provider=generatedProvider();bindings.providerFactory=()=>provider;
 const bind=(ns=namespace)=>store.db.prepare('UPDATE memory_plan_binding SET json=? WHERE id=1').run(JSON.stringify({planId:'instance:'+ns.instanceId,generation:ns.bindingRevision,namespace:ns}));
 t.after(async()=>{await app.close();await bindings.close();await plugins.close();await executor.close();store.close();await rm(directory,{recursive:true,force:true});});
 const added:{memory:Memory;evidenceId:string}[]=[];
 const add=async(index:number)=>{
  const evidenceId=randomUUID(),now=new Date(Date.parse('2026-10-12T00:00:00Z')+index*1000).toISOString();
  await store.ingest({id:evidenceId,deviceId:'generated-device',deviceName:'Generated device',platform:'import',source:'message',capturedAt:now,durationMs:0,appId:'generated.notes',appName:'Generated Notes',ocrText:`Generated telescope observation ${index}.`,provenance:{sourceId:'generated-notes',externalId:evidenceId,revision:'1',layer:'original'},privacy:{excluded:false,redacted:false,mode:'none'}});
  const original=store.evidence([evidenceId])[0]!,memory=memorySchema.parse({id:randomUUID(),version:1,domain:'personal',tier:'episode',kind:'episodic',title:`Generated memory ${index}`,statement:`Generated telescope observation ${index} stays exact.`,uncertainty:'Generated fixture only',status:'published',createdAt:now,evidenceIds:[evidenceId],model:'fixture',runId:'fixture',fingerprint:memoryEvidenceFingerprint(original),admission:{layer:'memory',reason:'Generated fixture',scope:'Generated fixture only',attribution:'observed'},evidence:[{id:evidenceId,deviceId:original.deviceId,sourceId:'generated-notes',capturedAt:now,receivedAt:original.receivedAt,offset:0,length:original.ocrText.length,quote:original.ocrText,contentHash:memoryEvidenceFingerprint(original)}]});
  store.db.prepare('INSERT INTO memories(id,created_at,json) VALUES(?,?,?)').run(memory.id,now,JSON.stringify(memory));
  store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(memory.id,evidenceId);
  await provider.put({namespace,key:memoryProviderKey(memory),memory,opId:randomUUID()});
  const entry={memory,evidenceId};added.push(entry);return entry;
 };
 for(let index=0;index<count;index++)await add(index);
 return {app,store,reader,plugins,bindings,provider,namespace,bind,add,added};
}

// Counts the prepared-statement calls that distinguish a full-library read from
// a selected-id read. Other by-id statements (memory_catalog id=?, per-memory
// dependencies, evidence) are intentionally out of scope.
function statementLog(t:any,store:Store){
 const sql:string[]=[],original=store.db.prepare.bind(store.db);
 t.mock.method(store.db,'prepare',(query:string)=>{sql.push(query);return original(query);});
 const count=(needle:string)=>sql.filter(query=>query.startsWith(needle)).length;
 return {sql,fullMemories:()=>count('SELECT json FROM memories ORDER BY id'),byIdMemories:()=>count('SELECT json FROM memories WHERE id IN'),fullCatalog:()=>count('SELECT id,json FROM memory_catalog ORDER BY id'),byIdCatalog:()=>count('SELECT id,json FROM memory_catalog WHERE id IN')};
}

test('GET /api/memories/:id pins only the requested memory snapshot',async t=>{
 const f=await fixture(t,200),target=f.added[137]!,log=statementLog(t,f.store);
 const detail=await f.app.inject({url:'/api/memories/'+target.memory.id});
 assert.equal(detail.statusCode,200,detail.body);
 assert.deepEqual(detail.json(),target.memory);
 assert.equal(log.fullMemories(),0,'a single read must not parse the full memories table');
 assert.equal(log.byIdMemories(),1,'the pin reads exactly the selected id');
 assert.equal(log.fullCatalog(),0,'the metadata pin must not scan the full catalog');
 assert.equal(log.byIdCatalog(),1);
 // Host status metadata still projects onto the pinned body without re-reading.
 f.store.invalidateMemoryEvidence(target.evidenceId);
 const stale=f.reader.memories.get(target.memory.id);log.sql.length=0;
 const invalidated=await f.app.inject({url:'/api/memories/'+target.memory.id});
 assert.equal(invalidated.statusCode,200,invalidated.body);
 assert.deepEqual(invalidated.json(),stale,'host status metadata still projects onto the pinned body');
 assert.equal(log.fullMemories(),0);assert.equal(log.byIdMemories(),1);assert.equal(log.fullCatalog(),0);assert.equal(log.byIdCatalog(),1);
 // A different single read repeats the same by-id profile.
 log.sql.length=0;
 const other=await f.app.inject({url:'/api/memories/'+f.added[42]!.memory.id});
 assert.equal(other.statusCode,200,other.body);assert.deepEqual(other.json(),f.added[42]!.memory);
 assert.equal(log.fullMemories(),0);assert.equal(log.byIdMemories(),1);assert.equal(log.fullCatalog(),0);assert.equal(log.byIdCatalog(),1);
});

test('missing ids return 404 and an empty selection pins nothing',async t=>{
 const f=await fixture(t,200);
 const empty=f.bindings.retainSnapshot([]);
 assert.deepEqual(Object.keys(empty.catalog),[],'empty selection has no provider keys');
 assert.deepEqual(Object.keys(empty.lineage),[],'empty selection has no lineage');
 assert.deepEqual(Object.keys(empty.metadata),[],'empty selection has no catalog metadata');
 assert.deepEqual(Object.keys(empty.records??{}),[],'empty selection has no pinned bodies');
 empty.release();empty.release();
 const log=statementLog(t,f.store);
 const detail=await f.app.inject({url:'/api/memories/'+randomUUID()});
 assert.equal(detail.statusCode,404,detail.body);
 assert.equal(log.fullMemories(),0);assert.equal(log.byIdMemories(),1);assert.equal(log.fullCatalog(),0);assert.equal(log.byIdCatalog(),1);
});

test('a caller-owned snapshot is not released by the read and the no-argument snapshot still covers the library',async t=>{
 const f=await fixture(t,200),target=f.added[10]!;
 const full=f.bindings.retainSnapshot();
 assert.equal(Object.keys(full.catalog).length,200);
 assert.equal(Object.keys(full.lineage).length,200);
 assert.equal(Object.keys(full.metadata).length,200);
 assert.equal(Object.keys(full.records??{}).length,200,'the no-argument snapshot keeps every record');
 const log=statementLog(t,f.store);
 const value=await f.reader.memoryAsync('memory:'+target.memory.id,{},true,full);
 assert.deepEqual(value,target.memory);
 assert.equal(log.fullMemories(),0,'a retained snapshot replaces the snapshot read');
 assert.equal(log.byIdMemories(),0,'an external pin needs no internal retain');
 full.release();full.release();
 const scoped=f.bindings.retainSnapshot([target.memory.id]);
 assert.deepEqual(Object.keys(scoped.catalog),[target.memory.id]);
 assert.deepEqual(Object.keys(scoped.lineage),[target.memory.id]);
 assert.deepEqual(Object.keys(scoped.metadata),[target.memory.id]);
 assert.deepEqual(Object.keys(scoped.records??{}),[target.memory.id]);
 assert.deepEqual(scoped.catalog[target.memory.id],memoryProviderKey(target.memory));
 assert.equal(scoped.recordDigests[target.memory.id],full.recordDigests[target.memory.id]);
 scoped.release();
});

test('bound provider reads keep the pinned key, release ownership and late-revocation fences',async t=>{
 const f=await fixture(t,3);f.bind();
 const [corruptTarget,happyTarget,revokedTarget]=f.added;
 const retained=()=>f.plugins.references(f.namespace.instanceId).includes('Existing queries retain a read snapshot');
 const reads:MemoryProviderRead[]=[],storedRead=f.provider.read.bind(f.provider);
 f.provider.read=async input=>{reads.push(input);return storedRead(input);};
 const log=statementLog(t,f.store);
 const detail=await f.app.inject({url:'/api/memories/'+happyTarget!.memory.id});
 assert.equal(detail.statusCode,200,detail.body);assert.deepEqual(detail.json(),happyTarget!.memory);
 assert.equal(log.fullMemories(),0);assert.equal(log.byIdMemories(),1);
 assert.equal(reads.length,1,'the bound body is read once through the provider');
 assert.deepEqual(reads[0]!.key,memoryProviderKey(happyTarget!.memory),'the provider read uses the pinned revision key');
 assert.equal(retained(),false,'the owned pin is released after a successful read');

 const baseRead=f.provider.read;f.provider.read=async input=>({...(await baseRead(input))!,statement:'Corrupted generated provider body'});
 const corrupted=await f.app.inject({url:'/api/memories/'+corruptTarget!.memory.id});
 assert.equal(corrupted.statusCode,502,corrupted.body);
 assert.equal(retained(),false,'the owned pin is released after a failed read');
 f.provider.read=baseRead;

 const external=f.bindings.retainSnapshot();
 assert.equal(retained(),true);
 const pinned=await f.reader.memoryAsync('memory:'+happyTarget!.memory.id,{},true,external);
 assert.deepEqual(pinned,happyTarget!.memory);
 assert.equal(retained(),true,'the external pin survives the read');
 external.release();
 assert.equal(retained(),false);

 let entered!:()=>void,resume!:()=>void;const waiting=new Promise<void>(r=>entered=r),barrier=new Promise<void>(r=>resume=r);
 f.provider.read=async input=>{entered();await barrier;return storedRead(input);};
 const pending=f.app.inject({url:'/api/memories/'+revokedTarget!.memory.id});
 await waiting;
 assert.equal(retained(),true,'the in-flight read retains the provider instance');
 f.store.delete(revokedTarget!.evidenceId);
 resume();
 const fenced=await pending;
 assert.equal(fenced.statusCode,404,fenced.body);
 assert.equal(retained(),false,'the owned pin is released after the fenced read');
});
