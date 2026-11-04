import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
import {FileStore} from '../src/files.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';
import {memoryBodyDigest,type MemoryProvider,type MemoryProviderNamespace} from '../src/memory-provider-contract.js';
import type {Memory} from '../src/memory-schema.js';
import {createMemoryPublication,type MemoryPublicationBindingPort} from '../src/plugins/memory-publication.js';

const namespace:MemoryProviderNamespace={ownerId:'generated-owner',instanceId:'generated-instance',bindingRevision:1};

function bindingPort(provider:MemoryProvider):MemoryPublicationBindingPort {
  const binding={planId:'instance:generated',generation:1,namespace};
  return {binding:()=>structuredClone(binding),provider:()=>provider,assertNewManualWork:()=>{},plugins:{references:()=>[]}} as MemoryPublicationBindingPort;
}

function generatedProvider(options:{holdPut?:boolean}={}){
  const records=new Map<string,Memory>();
  let puts=0,enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>enter=resolve),held=new Promise<void>(resolve=>release=resolve);
  const provider:MemoryProvider={
    async put(input){puts++;if(options.holdPut){enter();await held;}records.set(JSON.stringify(input.key),input.memory);if(options.holdPut)throw Error('Generated lost acknowledgement');return {opId:input.opId,namespace:input.namespace,key:input.key,payloadDigest:memoryBodyDigest(input.memory),state:'applied',eraseVerified:false,recordedAt:'2026-11-04T00:00:00Z'};},
    async read(input){return records.get(JSON.stringify(input.key))??null;},
    async export(){return [...records].map(([key,memory])=>({key:JSON.parse(key),memory}));},
    async remove(input){for(const key of [...records.keys()])if(JSON.stringify(JSON.parse(key))===JSON.stringify(input.key))records.delete(key);},
  } as MemoryProvider;
  return {provider,puts:()=>puts,entered,release};
}

function original(store:Store,sources:SourceStore,text:string){return sources.upsert('generated-files',{externalId:randomUUID(),revision:'1',observedAt:'2026-11-04T00:00:00Z',kind:'message',layer:'original',text});}

test('deleting evidence while a Memory publication is in flight retires its body, keeps reference identities and re-queues the late remote erase',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-deletion-plugin-'));
  const store=new Store(directory),sources=new SourceStore(store),files=new FileStore(store,sources),memories=new MemoryStore(store);
  sources.register({id:'generated-files',name:'Generated',kind:'local-files',deviceId:'generated',platform:'android',retention:'archive'});
  store.db.exec(`CREATE TABLE IF NOT EXISTS memory_plan_binding(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL); INSERT OR IGNORE INTO memory_plan_binding VALUES(1,'{"planId":"instance:generated","generation":1,"namespace":{"ownerId":"generated-owner","instanceId":"generated-instance","bindingRevision":1}}'); CREATE TABLE IF NOT EXISTS memory_provider_receipts(id TEXT PRIMARY KEY,json TEXT NOT NULL);`);
  const provider=generatedProvider({holdPut:true}),platform=createMemoryPublication({store,memories,bindings:bindingPort(provider.provider),
    evidenceDeletion:{captures:store,files,aliases:{resolve:()=>({virtual:false})}}});
  platform.prepare();platform.start();
  t.after(async()=>{provider.release();await platform.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const record=await original(store,sources,'Generated late publication body.'),memory=memories.extract(fixtureMemoryResult(memories,{answer:JSON.stringify({memories:[{title:'Generated late memory',statement:`Generated late conclusion [${record.id}]`,uncertainty:'Generated fixture',evidenceIds:[record.id]}]}),citations:[{id:record.id,capturedAt:record.capturedAt,appName:'Generated',excerpt:record.ocrText}],trace:[],runId:randomUUID()}),'fixture').items[0]!;

  const publishing=platform.port.owner.publish(memory.id,memory.version);
  const rejected=assert.rejects(publishing,/lost acknowledgement/);
  await provider.entered;
  store.delete(record.id);

  const write=store.db.prepare("SELECT id,json,state FROM memory_provider_writes WHERE json_extract(json,'$.key.memoryId')=?").get(memory.id)!;
  assert.equal(write.state,'submitted');
  assert.equal(JSON.parse(String(write.json)).memory,undefined,'the host retires the reviewed body while keeping the reconciliation identity');
  assert.equal(store.db.prepare('SELECT 1 FROM memories WHERE id=?').get(memory.id),undefined);
  const revocation=store.db.prepare('SELECT generation,json,state FROM memory_provider_evidence_revocations WHERE id=?').get(record.id)!;
  assert.equal(revocation.state,'submitted');
  assert.equal(JSON.parse(String(revocation.json)).evidenceId,record.id);
  assert.deepEqual(JSON.parse(String(revocation.json)).memoryIds,[memory.id]);
  assert.ok(platform.publication.pending()>0,'the deletion remains pending until the late remote write is actually observed and removed');

  provider.release();
  await rejected;
  const lateKey=JSON.parse(String(write.json)).key;
  const lateBody=await provider.provider.read({namespace,key:lateKey});
  assert.equal(lateBody&&memoryBodyDigest(lateBody),JSON.parse(String(write.json)).bodyDigest,'the provider committed the held write after host deletion');

  await platform.publication.reconcile();
  assert.equal(platform.publication.pending(),0,'the requeued erase settles only after the provider export is empty');
  assert.equal(await provider.provider.read({namespace,key:lateKey}),null);
  assert.equal(store.db.prepare('SELECT state FROM memory_provider_evidence_revocations WHERE id=?').get(record.id)?.state,'acknowledged');
  assert.ok(store.db.prepare('SELECT id FROM memory_provider_writes WHERE json_extract(json,\'$.key.memoryId\')=?').get(memory.id),'the reference identity remains after cleanup');
  assert.equal(provider.puts(),1,'reconciliation never replays a retired semantic write');

  platform.quiesce('disabled');
  assert.throws(()=>platform.evidenceDeletion,{statusCode:503});
  await platform.stop('disabled');
  platform.prepare();platform.start();
  const second=await original(store,sources,'Generated deletion after re-enable.');
  assert.deepEqual(platform.evidenceDeletion.capability(second.id),{available:true,kind:'capture'});
  assert.deepEqual(platform.evidenceDeletion.delete(second.id),{deleted:1});
  assert.equal(store.evidence([second.id]).length,0,'the same profile serves deletion after stop and re-enable');
});
