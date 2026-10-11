import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {createServer} from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Store,StoreError} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {ContextQuery} from '../src/context-query.js';
import {registerContextRoutes} from '../src/context-routes.js';
import {registerEvidenceRoutes} from '../src/evidence-routes.js';
import {Mem0MemoryProvider} from '../src/mem0-memory-provider.js';
import {MemoryBindings} from '../src/memory-bindings.js';
import {MemoryAutomation} from '../src/memory-automation.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {PluginCenter} from '../src/plugin-center.js';
import {GitHubPluginReleases} from '../src/plugin-release.js';
import {memoryProviderKey,type MemoryProviderNamespace} from '../src/memory-provider-contract.js';
import {memorySchema,type Memory} from '../src/memory-schema.js';
import {memoryEvidenceFingerprint} from '../src/memory.js';
import {ServerDiagnostics} from '../src/diagnostics.js';
import {EvidenceExposurePolicy} from '../src/evidence-exposure.js';
import {exportBoundMemories} from '../src/memory-provider-backup.js';

const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
async function fixture(t:any){
 const directory=await mkdtemp(join(tmpdir(),'mote-provider-consumer-')),store=new Store(join(directory,'vault')),sources=new SourceStore(store),reader=new EvidenceReader(store,sources);
 const executor=new ExecutionEngine(store),plugins=new PluginCenter(store,executor,new GitHubPluginReleases(join(directory,'plugins'))),bindings=new MemoryBindings(store,reader.memories,new MemoryAutomation(store),plugins,executor);reader.memoryBindings=bindings;
 // Constant embeddings verify real SDK/worker transport and host fences. A
 // separate opt-in run uses the pinned real MiniLM endpoint for retrieval.
 const endpoint=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),input=Array.isArray(body.input)?body.input:[body.input];res.setHeader('content-type','application/json');res.end(JSON.stringify({object:'list',data:input.map((_:unknown,index:number)=>({object:'embedding',index,embedding:[1,0,0]})),model:'transport-fixture'}));});
 await new Promise<void>(resolve=>endpoint.listen(0,'127.0.0.1',resolve));
 const real=process.env.MOTE_MEM0_TEST_EMBEDDING_CONFIG?JSON.parse(await readFile(process.env.MOTE_MEM0_TEST_EMBEDDING_CONFIG,'utf8')):undefined;
 const provider=new Mem0MemoryProvider({directory:join(directory,'mem0'),embedding:real?{baseUrl:real.baseUrl,apiKey:real.apiKey,model:real.model,dimension:real.dimension}:{baseUrl:`http://127.0.0.1:${(endpoint.address() as {port:number}).port}/v1`,apiKey:'generated-fixture',model:'transport-fixture',dimension:3}});
 bindings.providerFactory=()=>provider;
 const namespace:MemoryProviderNamespace={ownerId:'generated-owner',instanceId:'generated-mem0',bindingRevision:1};
 const bind=(ns=namespace)=>store.db.prepare('UPDATE memory_plan_binding SET json=? WHERE id=1').run(JSON.stringify({planId:'instance:'+ns.instanceId,generation:ns.bindingRevision,namespace:ns}));
 const app=Fastify();app.setErrorHandler((error,_req,reply)=>reply.code(error instanceof StoreError?error.statusCode:500).send({error:error.message}));registerEvidenceRoutes(app,reader);registerContextRoutes(app,new ContextQuery(store,sources,undefined,reader));
 const diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:false});await diagnostics.init();
 t.after(async()=>{await app.close();await diagnostics.close();await bindings.close();await plugins.close();await executor.close();await provider.close();store.close();endpoint.closeAllConnections();await new Promise<void>(resolve=>endpoint.close(()=>resolve()));await rm(directory,{recursive:true,force:true});});
 let index=0;
 const add=async(sourceId='generated-notes',title='Generated observatory')=>{
  const evidenceId=randomUUID(),now=`2026-10-12T00:${String(index++).padStart(2,'0')}:00Z`;
  await store.ingest({id:evidenceId,deviceId:'generated-device',deviceName:'Generated device',platform:'import',source:'message',capturedAt:now,durationMs:0,appId:'generated.notes',appName:'Generated Notes',ocrText:'A synthetic observatory has a violet telescope.',provenance:{sourceId,externalId:evidenceId,revision:'1',layer:'original'},privacy:{excluded:false,redacted:false,mode:'none'}});
  const original=store.evidence([evidenceId])[0],memory=memorySchema.parse({id:randomUUID(),version:1,domain:'personal',tier:'episode',kind:'episodic',title,statement:'The synthetic observatory uses a violet telescope.',uncertainty:'Generated fixture only',status:'published',createdAt:now,evidenceIds:[evidenceId],model:'fixture',runId:'fixture',fingerprint:memoryEvidenceFingerprint(original),admission:{layer:'memory',reason:'Generated fixture',scope:'Generated fixture only',attribution:'observed'},evidence:[{id:evidenceId,deviceId:original.deviceId,sourceId,capturedAt:now,receivedAt:original.receivedAt,offset:0,length:original.ocrText.length,quote:original.ocrText,contentHash:memoryEvidenceFingerprint(original)}]});
  store.db.prepare('INSERT INTO memories(id,created_at,json) VALUES(?,?,?)').run(memory.id,now,JSON.stringify(memory));store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(memory.id,evidenceId);
  await provider.put({namespace,key:memoryProviderKey(memory),memory,opId:randomUUID()});return {memory,evidenceId};
 };
 return {app,store,reader,provider,bindings,namespace,bind,add,diagnostics};
}

test('owner HTTP reads use real external bodies; provider failure cannot become SQL fallback',async t=>{
 const f=await fixture(t),{memory,evidenceId}=await f.add();f.bind();
 const detail=await f.app.inject({url:'/api/memories/'+memory.id});assert.equal(detail.statusCode,200,detail.body);assert.deepEqual(detail.json(),memory);
 const markdown=await f.app.inject({url:'/api/memories/'+memory.id+'/text'});assert.equal(markdown.statusCode,200,markdown.body);assert.match(markdown.body,/violet telescope/);
 const context=await f.app.inject({method:'POST',url:'/api/context/read',payload:{refs:['memory:'+memory.id]}});assert.equal(context.statusCode,200,context.body);assert.match(context.json().items[0].text,/violet telescope/);
 assert.deepEqual(await exportBoundMemories(f.bindings),[memory]);
 const nativeSearch=f.provider.search.bind(f.provider);f.provider.search=async input=>(await nativeSearch(input)).map(hit=>({...hit,memory:{...hit.memory,statement:'Generated corrupt provider result'}}));
 await assert.rejects(f.reader.memoryPageAsync({query:'observatory'},true),{statusCode:502},'a corrupt exact-key external search result cannot masquerade as no matching memory');f.provider.search=nativeSearch;
 await f.provider.remove({namespace:f.namespace,key:memoryProviderKey(memory),opId:randomUUID()});
 assert.equal((await f.app.inject({url:'/api/memories/'+memory.id})).statusCode,503);
 assert.equal((await f.app.inject({method:'POST',url:'/api/context/read',payload:{refs:['memory:'+memory.id]}})).statusCode,503);
 assert.equal((await f.app.inject({url:'/api/memories'})).json().items.length,1,'metadata remains available independently of provider body');
 assert.equal((await f.app.inject({url:'/api/captures/'+evidenceId})).statusCode,200,'original archive reads continue');
 await assert.rejects(exportBoundMemories(f.bindings),{statusCode:502});
});

test('one query pins namespace and body revision across cutover but rechecks a late source deletion',async t=>{
 const f=await fixture(t),{memory,evidenceId}=await f.add();f.bind();const context={},agent=f.reader.agent({diagnostics:f.diagnostics,currentGrantContext:()=>context});f.reader.retainMemorySnapshot(context);t.after(()=>f.reader.releaseMemorySnapshot(context));
 const originalRead=f.provider.read.bind(f.provider);let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(resolve=>entered=resolve),barrier=new Promise<void>(resolve=>release=resolve);
 f.provider.read=async input=>{entered();await barrier;return originalRead(input);};const first=agent.memories!({id:memory.id});await waiting;
 const next:Memory=memorySchema.parse({...memory,version:2,title:'Corrected generated observatory',statement:'The corrected synthetic observatory uses an amber telescope.',fingerprint:hash('generated-correction')});
 const namespace={...f.namespace,bindingRevision:2};await f.provider.put({namespace,key:memoryProviderKey(next),memory:next,opId:randomUUID()});f.store.db.prepare('UPDATE memories SET json=? WHERE id=?').run(JSON.stringify(next),memory.id);f.bind(namespace);release();
 assert.deepEqual((await first).items[0],memory);f.provider.read=originalRead;assert.deepEqual((await agent.memories!({id:memory.id})).items[0],memory,'later tools retain old query revision');
 assert.equal((await agent.memories!({})).items[0].title,memory.title,'metadata belongs to the same pinned version after current authorization checks');
 const fresh=await f.reader.memoryAsync('memory:'+memory.id,{},true);assert.deepEqual(fresh,next,'a new owner read uses the new binding');
 let enteredDelete!:()=>void,releaseDelete!:()=>void;const waitingDelete=new Promise<void>(resolve=>enteredDelete=resolve),deleteBarrier=new Promise<void>(resolve=>releaseDelete=resolve);
 f.provider.read=async input=>{enteredDelete();await deleteBarrier;return originalRead(input);};const revoked=agent.memories!({id:memory.id});await waitingDelete;f.store.delete(evidenceId);releaseDelete();assert.deepEqual((await revoked).items,[],'source deletion fences even a pinned successful external read');
});

test('external search and its cursor obey current host scope, exposure and exact catalog keys',async t=>{
 const f=await fixture(t),one=await f.add('allowed'),two=await f.add('restricted');f.bind();
 const first=await f.reader.memoryPageAsync({query:'observatory',level:'detail',limit:1},true);assert.equal(first.items.length,1);assert.ok(first.nextCursor);
 const next=await f.reader.memoryPageAsync({query:'observatory',level:'detail',limit:1,cursor:first.nextCursor!},true);assert.equal(next.items.length,1);assert.notEqual(next.items[0].id,first.items[0].id);assert.equal(next.nextCursor,null);
 assert.deepEqual((await f.reader.memoryPageAsync({query:'observatory',sourceId:'allowed',level:'detail'},true)).items.map(value=>value.id),[one.memory.id]);
 const restricted=f.reader.agent({diagnostics:f.diagnostics,exposurePolicy:new EvidenceExposurePolicy([{sourceId:'restricted',allow:false}])});assert.deepEqual((await restricted.memories!({query:'observatory'})).items.map(value=>value.id),[one.memory.id]);
 const clone=memorySchema.parse({...two.memory,version:2,fingerprint:hash('generated-index-revision')});await f.provider.put({namespace:f.namespace,key:memoryProviderKey(clone),memory:clone,opId:randomUUID()});f.store.db.prepare('UPDATE memories SET json=? WHERE id=?').run(JSON.stringify(clone),clone.id);
 await assert.rejects(f.reader.memoryPageAsync({query:'observatory',level:'detail',limit:1,cursor:first.nextCursor!},true),{statusCode:409});
 const pinned=await f.reader.memoryPageAsync({query:'observatory',level:'detail'},true);assert.equal(pinned.items.length,2);assert.equal(pinned.items.find(value=>value.id===clone.id)?.version,2);
});

test('real evidence invalidation projects host status and updatedAt without changing an immutable body',async t=>{
 const f=await fixture(t),{memory,evidenceId}=await f.add();f.bind();
 f.store.invalidateMemoryEvidence(evidenceId);
 const stale=f.reader.memories.get(memory.id);assert.equal(stale.status,'stale');assert.equal(stale.staleReason,'evidence_changed');assert.ok(stale.updatedAt);assert.equal(stale.version,memory.version);
 assert.deepEqual(await f.provider.read({namespace:f.namespace,key:memoryProviderKey(memory)}),memory,'the external immutable body remains unchanged');
 assert.deepEqual((await f.app.inject({url:'/api/memories/'+memory.id})).json(),stale,'owner reads project host invalidation without an external version mismatch');
 assert.deepEqual(await exportBoundMemories(f.bindings),[stale]);
 const snapshot=f.bindings.retainSnapshot();try{assert.equal(snapshot.metadata[memory.id].updatedAt,stale.updatedAt);}finally{snapshot.release();}
 const agent=f.reader.agent({diagnostics:f.diagnostics});assert.deepEqual((await agent.memories!({id:memory.id})).items,[],'current stale status fences agent reads');
 const originalExport=f.provider.export.bind(f.provider);let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(resolve=>entered=resolve),barrier=new Promise<void>(resolve=>release=resolve);
 f.provider.export=async input=>{entered();await barrier;return originalExport(input);};const pending=exportBoundMemories(f.bindings);await waiting;
 f.store.db.prepare('UPDATE memories SET json=? WHERE id=?').run(JSON.stringify(memory),memory.id);release();await assert.rejects(pending,{statusCode:409},'host-state changes during export require a fresh canonical projection');
});

test('a corrected dependency set cannot authorize pinned old-source titles or bodies after revocation',async t=>{
 const f=await fixture(t),old=await f.add('old-source','Old generated observatory'),replacement=await f.add('new-source','New generated original');f.store.db.prepare('DELETE FROM memories WHERE id=?').run(replacement.memory.id);f.bind();
 const context={},agent=f.reader.agent({diagnostics:f.diagnostics,currentGrantContext:()=>context});f.reader.retainMemorySnapshot(context);t.after(()=>f.reader.releaseMemorySnapshot(context));
 const next=memorySchema.parse({...old.memory,version:2,statement:'The corrected generated memory cites the new original.',evidenceIds:replacement.memory.evidenceIds,evidence:replacement.memory.evidence,fingerprint:hash('generated-new-dependency')}),namespace={...f.namespace,bindingRevision:2};
 await f.provider.put({namespace,key:memoryProviderKey(next),memory:next,opId:randomUUID()});f.store.db.prepare('DELETE FROM memory_dependencies WHERE memory_id=?').run(old.memory.id);f.store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(old.memory.id,replacement.evidenceId);f.store.db.prepare('UPDATE memories SET json=? WHERE id=?').run(JSON.stringify(next),old.memory.id);f.bind(namespace);
 assert.equal((await agent.memories!({id:old.memory.id})).items[0].title,old.memory.title,'the authorized old revision remains pinned');
 assert.deepEqual((await agent.memories!({id:old.memory.id,sourceId:'new-source'})).items,[],'current new-source scope cannot authorize old-source metadata');
 f.store.db.prepare("UPDATE captures SET json=json_set(json,'$.privacy.excluded',json('true')) WHERE id=?").run(old.evidenceId);
 assert.equal(f.reader.memories.get(next.id).status,'published','the new revision does not depend on the excluded original');
 assert.deepEqual((await agent.memories!({id:old.memory.id})).items,[],'excluded original fences pinned metadata');
 assert.equal(await f.reader.memoryAsync('memory:'+old.memory.id,{},false,f.reader.memorySnapshot(context)),undefined,'excluded original fences the pinned body');
 f.store.delete(old.evidenceId);assert.deepEqual((await agent.memories!({id:old.memory.id})).items,[],'old-source deletion still fences a current record with different dependencies');
 assert.deepEqual(await f.reader.memoryAsync('memory:'+next.id,{},true),next,'a fresh owner read remains bound to the valid new original');
});
