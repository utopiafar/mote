import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Mem0MemoryProvider} from '../src/mem0-memory-provider.js';
import {memoryProviderKey,type MemoryProviderNamespace} from '../src/memory-provider-contract.js';
import {memorySchema,type Memory} from '../src/memory-schema.js';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function fixture(version=1,id=randomUUID()):Memory{const evidenceId=randomUUID(),now='2026-10-12T00:00:00Z',statement='Generated fixture: the synthetic observatory uses a violet telescope.';return memorySchema.parse({id,version,domain:'personal',tier:'episode',kind:'episodic',title:'Generated observatory',statement,uncertainty:'Generated fixture only',evidenceIds:[evidenceId],evidence:[{id:evidenceId,capturedAt:now,receivedAt:now,quote:statement,contentHash:hash(statement)}],createdAt:now,status:'published',model:'fixture',runId:'fixture',fingerprint:hash(id+version),admission:{layer:'memory',reason:'Generated fixture',scope:'Generated fixture only',attribution:'observed'}});}
async function setup(){
 const directory=await mkdtemp(join(tmpdir(),'mote-mem0-worker-fixture-'));let calls=0;
 // Constant vectors exercise transport/persistence/fences only. Semantic
 // ranking is validated separately with the pinned real MiniLM endpoint.
 const token=randomUUID(),server=createServer(async(req,res)=>{if(req.headers.authorization!=='Bearer '+token){res.writeHead(401).end();return;}let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),texts=Array.isArray(body.input)?body.input:[body.input];calls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({object:'list',data:texts.map((_:unknown,index:number)=>({object:'embedding',index,embedding:[1,0,0]})),model:'constant-transport-fixture'}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const realConfig=process.env.MOTE_MEM0_TEST_EMBEDDING_CONFIG?JSON.parse(await readFile(process.env.MOTE_MEM0_TEST_EMBEDDING_CONFIG,'utf8')):undefined;
 const config={directory,embedding:realConfig?{baseUrl:realConfig.baseUrl,apiKey:realConfig.apiKey,model:realConfig.model,dimension:realConfig.dimension}:{baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,apiKey:token,model:'constant-transport-fixture',dimension:3}};
 let provider=new Mem0MemoryProvider(config);const namespace:MemoryProviderNamespace={ownerId:'generated-owner',instanceId:'generated-mem0',bindingRevision:1};
 return {directory,namespace,get provider(){return provider;},calls:()=>calls,async restart(){await provider.close();provider=new Mem0MemoryProvider(config);},async close(){await provider.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}};
}
test('mem0 worker preserves complete immutable history across restart and scoped read/search/export',async()=>{
 const env=await setup();try{
  const first=fixture(),second=fixture(2,first.id),key=memoryProviderKey(first),nextKey=memoryProviderKey(second),opId=randomUUID();
  const receipt=await env.provider.put({namespace:env.namespace,key,memory:first,opId});
  const replay=await env.provider.put({namespace:{bindingRevision:1,instanceId:env.namespace.instanceId,ownerId:env.namespace.ownerId},key,memory:first,opId});assert.equal(replay.externalId,receipt.externalId);
  await assert.rejects(env.provider.put({namespace:env.namespace,key,memory:{...first,statement:'Changed immutable body'},opId}),{code:'conflict'});
  await env.provider.put({namespace:env.namespace,key:nextKey,memory:second,opId:randomUUID()});await env.restart();
  assert.deepEqual(await env.provider.read({namespace:env.namespace,key}),first);assert.deepEqual(await env.provider.read({namespace:env.namespace,key:nextKey}),second);
  assert.equal(await env.provider.read({namespace:{...env.namespace,ownerId:'another-generated-owner'},key}),null);
  assert.equal((await env.provider.search({namespace:{...env.namespace,bindingRevision:2},query:'observatory'})).length,0);
  assert.equal((await env.provider.export({namespace:env.namespace})).length,2);
  assert.deepEqual((await env.provider.search({namespace:env.namespace,query:'telescope',keys:[nextKey],limit:1})).map(hit=>hit.key),[nextKey]);
  await assert.rejects(env.provider.read({namespace:env.namespace,key:{...key,fingerprint:hash('wrong-generation')}}),{code:'conflict'});
  const removeId=randomUUID(),removed=await env.provider.remove({namespace:env.namespace,key,opId:removeId});assert.equal(removed.currentRemoved,true);assert.equal(removed.historyRetained,true);assert.equal(removed.eraseVerified,false);
  assert.deepEqual(await env.provider.remove({namespace:{bindingRevision:1,ownerId:env.namespace.ownerId,instanceId:env.namespace.instanceId},key:{version:key.version,fingerprint:key.fingerprint,memoryId:key.memoryId},opId:removeId}),removed);await env.restart();assert.equal(await env.provider.read({namespace:env.namespace,key}),null);assert.deepEqual(await env.provider.read({namespace:env.namespace,key:nextKey}),second);
  await assert.rejects(env.provider.put({namespace:env.namespace,key,memory:first,opId:randomUUID()}),{code:'conflict'});
 }finally{await env.close();}
});
test('mem0 startup reconciles an injected post-write/pre-receipt crash state without another add',async()=>{
 const env=await setup();try{
  const memory=fixture(),key=memoryProviderKey(memory),opId=randomUUID(),receipt=await env.provider.put({namespace:env.namespace,key,memory,opId});await env.provider.close();
  // Durable failure fixture: the external write exists but its local receipt
  // and key mapping were not committed. Reopening still uses the real worker.
  const db=new DatabaseSync(join(env.directory,'operations.db'));db.prepare("UPDATE provider_operations SET state='intent',receipt=NULL WHERE op_id=?").run(opId);db.prepare('DELETE FROM provider_records').run();db.close();
  await env.restart();const before=env.calls(),recovered=await env.provider.put({namespace:env.namespace,key,memory,opId});assert.equal(recovered.externalId,receipt.externalId);assert.equal(env.calls(),before);assert.deepEqual(await env.provider.read({namespace:env.namespace,key}),memory);
  const health=await env.provider.recover({namespace:env.namespace});assert.equal(health.ready,true);assert.equal(health.verified.physicalErase,false);assert.equal(health.verified.idempotentReplay,true);
 }finally{await env.close();}
});
test('mem0 detects tampered canonical metadata and never returns or deletes the substituted body',async()=>{
 const env=await setup();try{
  const memory=fixture(),key=memoryProviderKey(memory),receipt=await env.provider.put({namespace:env.namespace,key,memory,opId:randomUUID()});await env.provider.close();
  const db=new DatabaseSync(join(env.directory,'vectors.db')),row=db.prepare('SELECT payload FROM vectors WHERE id=?').get(receipt.externalId!);const payload=JSON.parse(String(row!.payload));payload.mote_record.memory.statement='Tampered generated fixture body';db.prepare('UPDATE vectors SET payload=? WHERE id=?').run(JSON.stringify(payload),receipt.externalId!);db.close();
  await env.restart();await assert.rejects(env.provider.read({namespace:env.namespace,key}),{code:'invalid_record'});await assert.rejects(env.provider.remove({namespace:env.namespace,key,opId:randomUUID()}),{code:'invalid_record'});
 }finally{await env.close();}
});
test('closing a real mem0 worker blocked on embeddings has a bounded deadline and preserves unknown intent',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-mem0-close-deadline-'));let entered!:()=>void;const embeddingStarted=new Promise<void>(resolve=>entered=resolve);
 const server=createServer(async(req,_res)=>{for await(const _chunk of req){}entered();/* Generated fixture deliberately never responds. */});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const config={directory,embedding:{baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,model:'generated-hanging-endpoint',dimension:3,apiKey:'generated-only'}},provider=new Mem0MemoryProvider(config),namespace={ownerId:'generated-owner',instanceId:'generated-close-test',bindingRevision:1},memory=fixture(),opId=randomUUID();
 const pending=provider.put({namespace,key:memoryProviderKey(memory),memory,opId});const rejected=assert.rejects(pending,{code:'unknown_result'});
 try{
  await embeddingStarted;const started=Date.now(),first=provider.close(),second=provider.close();assert.equal(second,first,'concurrent close callers share completion');await first;assert.ok(Date.now()-started<8000,'close deadline includes the hung embedding request');await rejected;
  await assert.rejects(provider.read({namespace,key:memoryProviderKey(memory)}),{code:'closed'});
  const journal=new DatabaseSync(join(directory,'operations.db'),{readOnly:true});try{assert.equal(journal.prepare('SELECT state FROM provider_operations WHERE op_id=?').get(opId)?.state,'intent','termination cannot turn an unacknowledged operation into success');}finally{journal.close();}
 }finally{await provider.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});
