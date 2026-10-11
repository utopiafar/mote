import type {QueryResult} from '@mote/shared';
import type {MemoryStore,MemoryExtractOptions,PreparedMemoryExtraction} from './memory.js';
import type {MemoryBindings} from './memory-bindings.js';
import {memoryProviderKey,memoryBodyDigest} from './memory-provider-contract.js';
import {ExecutionEngine,ExecutionFailure} from './execution-engine.js';
import {sha256,StoreError,type Store} from './store.js';
import type {Memory} from './memory-schema.js';
import {randomUUID} from 'node:crypto';

export type MemoryPublicationReceipt={operationId:string;binding:ReturnType<MemoryBindings['binding']>;prepared:PreparedMemoryExtraction;payloadHash:string};
/** Remote writes are staged before the ExecutionEngine's synchronous commit.
 * Their complete bodies and identities survive lost replies and host restarts.
 * Only a verified receipt can make a control record visible to query readers. */
export class MemoryPublication {
  private activeOwnerWork=0;
  private dispose?:()=>Promise<void>;
  private poll?:ReturnType<typeof setInterval>;
  revokeEvidence?:(ids:string[])=>Promise<void>;
  constructor(readonly store:Store,readonly memories:MemoryStore,readonly bindings:MemoryBindings,private executor?:ExecutionEngine){
    store.db.exec('CREATE TABLE IF NOT EXISTS memory_publications(id TEXT PRIMARY KEY,json TEXT NOT NULL,state TEXT NOT NULL);');
    store.db.exec('CREATE TABLE IF NOT EXISTS memory_publication_outputs(id TEXT PRIMARY KEY,json TEXT NOT NULL);');
    store.db.exec('CREATE TABLE IF NOT EXISTS memory_provider_writes(id TEXT PRIMARY KEY,parent_id TEXT NOT NULL,json TEXT NOT NULL,state TEXT NOT NULL,automatic INTEGER NOT NULL DEFAULT 0);');
    store.db.exec('CREATE TABLE IF NOT EXISTS memory_owner_mutations(id TEXT PRIMARY KEY,json TEXT NOT NULL,state TEXT NOT NULL);');
    store.db.exec('CREATE TABLE IF NOT EXISTS memory_provider_erases(id TEXT PRIMARY KEY,json TEXT NOT NULL,state TEXT NOT NULL);');
    store.db.exec('CREATE TABLE IF NOT EXISTS memory_provider_evidence_revocations(id TEXT PRIMARY KEY,generation INTEGER NOT NULL,json TEXT NOT NULL,state TEXT NOT NULL);');
    const references=bindings.plugins.references;
    bindings.plugins.references=id=>[...references(id),...(['memory_provider_writes','memory_provider_erases'].some(table=>Number(store.db.prepare("SELECT count(*) n FROM "+table+" WHERE state='submitted' AND json_extract(json,'$.namespace.instanceId')=?").get(id)!.n))||this.nativeCleanupPending(id)||this.evidenceRevocationRetains(id)?['Unresolved provider writes or erasures retain this instance']:[])];
    if(executor){this.dispose=executor.register({kind:'memory.provider-reconcile',pool:'plugin-control',concurrency:()=>1,validate:()=>true,execute:async()=>{await this.reconcile();if(this.pending())throw new ExecutionFailure('waiting','memory_provider_result_unknown',5000);},commit:()=>{}});this.scheduleReconcile();this.poll=setInterval(()=>this.scheduleReconcile(),5000);this.poll.unref();}
  }
  private hasTable(name:string){return Boolean(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));}
  private nativeCleanupPending(instanceId?:string){return this.hasTable('memory_engine_stage_cleanups')?Number(this.store.db.prepare("SELECT count(*) n FROM memory_engine_stage_cleanups WHERE state='pending'"+(instanceId?" AND json_extract(json,'$.provider.instanceId')=?":'')).get(...(instanceId?[instanceId]:[]))!.n):0;}
  private evidenceRevocationRetains(instanceId:string){
    const pending=this.store.db.prepare("SELECT json FROM memory_provider_evidence_revocations WHERE state='submitted'").all();if(!pending.length)return false;
    if(this.hasTable('memory_provider_configurations')&&this.store.db.prepare("SELECT 1 FROM memory_provider_configurations WHERE json_extract(json,'$.namespace.instanceId')=? AND json_extract(json,'$.package.hostAdapter')='mote.hindsight@1'").get(instanceId))return true;
    const memoryIds=new Set(pending.flatMap(row=>{const value=JSON.parse(String(row.json));return value.deleted?value.memoryIds as string[]:[];}));
    return ['memory_provider_receipts','memory_provider_writes'].some(table=>this.store.db.prepare('SELECT json FROM '+table).all().some(row=>{const value=JSON.parse(String(row.json));return value.namespace?.instanceId===instanceId&&memoryIds.has(value.key?.memoryId);}));
  }
  private scheduleReconcile(){if(!this.executor||!this.pending()||this.store.db.prepare("SELECT 1 FROM execution_steps WHERE kind='memory.provider-reconcile' AND state IN ('waiting','running')").get())return;const id='memory-provider-reconcile:'+randomUUID();this.executor.enqueue(id,'memory.provider-reconcile',{}, {id});void this.executor.tick().catch(()=>{});}
  private async write(operationId:string,memory:Memory,assertAuthority:()=>void,automatic=false){
    const binding=this.bindings.binding();if(!binding.namespace)return;
    const namespace=binding.namespace,provider=this.bindings.provider(namespace.instanceId,namespace),key=memoryProviderKey(memory),opId=operationId+':'+sha256(JSON.stringify({key,memory})),write={namespace,key,memory,opId};
    assertAuthority();const json=JSON.stringify(write);this.store.reserveMetadata(Buffer.byteLength(json));this.store.db.prepare("INSERT OR IGNORE INTO memory_provider_writes VALUES(?,?,?,'submitted',?)").run(opId,operationId,json,Number(automatic));
    // Submission is not completion. An interrupted transport keeps this intent
    // observable until a read/recovery proves the immutable body or its removal.
    try{await provider.put(write);const exact=await provider.read({namespace,key});if(!exact||memoryBodyDigest(exact)!==memoryBodyDigest(memory))throw new StoreError('The provider did not preserve a reviewed Memory body',502);}catch(error){this.scheduleReconcile();throw error;}
    this.store.db.prepare("UPDATE memory_provider_writes SET state='acknowledged' WHERE id=?").run(opId);assertAuthority();
  }
  async stageRecords(operationId:string,records:Memory[],assertAuthority:()=>void){for(const memory of records)await this.write(operationId,memory,assertAuthority);assertAuthority();}
  pending(automaticOnly=false){return Number(this.store.db.prepare("SELECT count(*) n FROM memory_provider_writes WHERE state='submitted'"+(automaticOnly?' AND automatic=1':'')).get()!.n)+(automaticOnly?0:this.activeOwnerWork+Number(this.store.db.prepare("SELECT count(*) n FROM memory_provider_erases WHERE state='submitted'").get()!.n)+Number(this.store.db.prepare("SELECT count(*) n FROM memory_provider_evidence_revocations WHERE state='submitted'").get()!.n)+this.nativeCleanupPending());}
  async withOwnerWork<T>(work:()=>Promise<T>){this.bindings.assertNewManualWork();this.activeOwnerWork++;try{return await work();}finally{this.activeOwnerWork--;}}
  private queueErases(memoryIds:readonly string[]){const namespaces=new Map<string,any>(),current=this.bindings.binding().namespace;if(current)namespaces.set(JSON.stringify(current),current);
    for(const table of ['memory_provider_receipts','memory_provider_writes'])for(const row of this.store.db.prepare('SELECT json FROM '+table).all()){const record=JSON.parse(String(row.json));if(record.namespace)namespaces.set(JSON.stringify(record.namespace),record.namespace);}
    for(const id of memoryIds)for(const namespace of namespaces.values()){const opId='owner-delete:'+id+':'+sha256(JSON.stringify(namespace)),json=JSON.stringify({namespace,memoryId:id});this.store.reserveMetadata(Buffer.byteLength(json));this.store.db.prepare("INSERT INTO memory_provider_erases VALUES(?,?,'submitted') ON CONFLICT(id) DO UPDATE SET state='submitted'").run(opId,json);}
  }
  async reconcile(){for(const row of this.store.db.prepare("SELECT id,generation,json FROM memory_provider_evidence_revocations WHERE state='submitted'").all()){
    const value=JSON.parse(String(row.json));try{if(!this.revokeEvidence&&this.hasTable('memory_provider_configurations')&&this.store.db.prepare("SELECT 1 FROM memory_provider_configurations WHERE json_extract(json,'$.package.hostAdapter')='mote.hindsight@1'").get())continue;
      await this.revokeEvidence?.([value.evidenceId]);const db=this.store.db;db.exec('SAVEPOINT memory_evidence_reconcile');try{if(value.deleted)this.queueErases(value.memoryIds??[]);db.prepare("UPDATE memory_provider_evidence_revocations SET state='acknowledged' WHERE id=? AND generation=? AND state='submitted'").run(row.id,row.generation);db.exec('RELEASE memory_evidence_reconcile');}catch(error){db.exec('ROLLBACK TO memory_evidence_reconcile; RELEASE memory_evidence_reconcile');throw error;}
    }catch{/* Source cleanup remains durable and retryable; publication is fenced already. */}
  }for(const row of this.store.db.prepare("SELECT id,json FROM memory_provider_writes WHERE state='submitted'").all()){
    const write=JSON.parse(String(row.json));try{const read=await this.bindings.provider(write.namespace.instanceId,write.namespace).read({namespace:write.namespace,key:write.key});if(read&&memoryBodyDigest(read)===memoryBodyDigest(write.memory)){
      this.store.db.prepare("UPDATE memory_provider_writes SET state='acknowledged' WHERE id=?").run(row.id);
      // An earlier empty export cannot acknowledge erasure of a write whose
      // remote commit became visible later. Re-arm its durable erase intent.
      for(const erase of this.store.db.prepare('SELECT id,json FROM memory_provider_erases').all()){const intent=JSON.parse(String(erase.json));if(intent.memoryId===write.key.memoryId&&JSON.stringify(intent.namespace)===JSON.stringify(write.namespace))this.store.db.prepare("UPDATE memory_provider_erases SET state='submitted' WHERE id=?").run(erase.id);}
    }}catch{/* Unknown remains visible; never retry a revoked write. */}
  }for(const row of this.store.db.prepare("SELECT id,json FROM memory_provider_erases WHERE state='submitted'").all()){
    const intent=JSON.parse(String(row.json));try{const provider=this.bindings.provider(intent.namespace.instanceId,intent.namespace),records=await provider.export({namespace:intent.namespace});for(const record of records)if(record.key.memoryId===intent.memoryId)await provider.remove({namespace:intent.namespace,key:record.key,opId:String(row.id)+':'+sha256(JSON.stringify(record.key))});
      const unresolved=this.store.db.prepare("SELECT json FROM memory_provider_writes WHERE state='submitted'").all().some(write=>{const value=JSON.parse(String(write.json));return value.key.memoryId===intent.memoryId&&JSON.stringify(value.namespace)===JSON.stringify(intent.namespace);});
      if(!unresolved&&!(await provider.export({namespace:intent.namespace})).some(record=>record.key.memoryId===intent.memoryId))this.store.db.prepare("UPDATE memory_provider_erases SET state='acknowledged' WHERE id=?").run(row.id);
    }catch{/* Erase remains visible and retryable after restart. */}
  }}
  retainedOutput<T>(operationId:string):T|undefined{if(!this.bindings.binding().namespace)return;const row=this.store.db.prepare('SELECT json FROM memory_publication_outputs WHERE id=?').get(operationId);return row?JSON.parse(String(row.json)):undefined;}
  retainOutput(operationId:string,output:unknown){if(!this.bindings.binding().namespace)return;const json=JSON.stringify(output);this.store.reserveMetadata(Buffer.byteLength(json));this.store.db.prepare('INSERT OR IGNORE INTO memory_publication_outputs VALUES(?,?)').run(operationId,json);}
  async stageExtract(operationId:string,result:QueryResult,model:string,options:MemoryExtractOptions,assertAuthority:()=>void,automatic=false):Promise<MemoryPublicationReceipt|undefined>{
    const binding=this.bindings.binding();if(!binding.namespace)return;
    assertAuthority();const payloadHash=sha256(JSON.stringify({result:result.answer,citations:result.citations,model,options}));
    let receipt:MemoryPublicationReceipt;const prior=this.store.db.prepare('SELECT json FROM memory_publications WHERE id=?').get(operationId);
    if(prior){receipt=JSON.parse(String(prior.json));if(receipt.payloadHash!==payloadHash||JSON.stringify(receipt.binding)!==JSON.stringify(binding))throw new StoreError('A staged publication has a different binding or reviewed result; recover it first',409);this.memories.assertPrepared(receipt.prepared,result);}
    else{receipt={operationId,binding,prepared:this.memories.prepareExtract(result,model,options),payloadHash};const json=JSON.stringify(receipt);this.store.reserveMetadata(Buffer.byteLength(json));this.store.db.prepare("INSERT INTO memory_publications VALUES(?,?,'staged')").run(operationId,json);}
    for(const memory of receipt.prepared.changed)await this.write(operationId,memory,assertAuthority,automatic);
    assertAuthority();this.memories.assertPrepared(receipt.prepared,result);this.store.db.prepare("UPDATE memory_publications SET state='verified' WHERE id=?").run(operationId);return receipt;
  }
  assert(receipt:MemoryPublicationReceipt|undefined,result:QueryResult){const binding=this.bindings.binding();if(!binding.namespace){if(receipt)throw new StoreError('Memory binding changed before publication',409);return;}
    if(!receipt||JSON.stringify(receipt.binding)!==JSON.stringify(binding)||this.store.db.prepare('SELECT state FROM memory_publications WHERE id=?').get(receipt.operationId)?.state!=='verified')throw new StoreError('Memory requires a verified provider publication receipt',409);
    this.memories.assertPrepared(receipt.prepared,result);
  }
  committed(receipt:MemoryPublicationReceipt|undefined){if(receipt)this.store.db.prepare("UPDATE memory_publications SET state='committed' WHERE id=? AND state='verified'").run(receipt.operationId);}
  private ownerMutation(id:string,create:()=>unknown){const prior=this.store.db.prepare('SELECT json,state FROM memory_owner_mutations WHERE id=?').get(id);if(prior)return {value:JSON.parse(String(prior.json)),state:String(prior.state)};const value=create(),json=JSON.stringify(value);this.store.reserveMetadata(Buffer.byteLength(json));this.store.db.prepare("INSERT INTO memory_owner_mutations VALUES(?,?,'staged')").run(id,json);return {value,state:'staged'};}
  async publish(id:string,version?:number){
    this.bindings.assertNewManualWork();if(!this.bindings.binding().namespace)return this.memories.publish(id,version);
    const operationId='owner-publish:'+id+':'+(version??this.memories.get(id).version);
    const intent=this.ownerMutation(operationId,()=>{
      const binding=this.bindings.binding(),before=this.store.db.prepare('SELECT id,json FROM memories').all(),at=new Date().toISOString();let result:Memory,changed:Memory[];
      this.store.db.exec('SAVEPOINT owner_publish');try{result=this.memories.publish(id,version,at);changed=this.store.db.prepare('SELECT id,json FROM memories').all().filter(row=>before.find(prior=>prior.id===row.id)?.json!==row.json).map(row=>JSON.parse(String(row.json)));}finally{this.store.db.exec('ROLLBACK TO owner_publish; RELEASE owner_publish');}
      return {binding,before:before.filter(row=>changed.some(memory=>memory.id===row.id)),at,result,changed};
    });const {binding,before,at,result,changed}=intent.value;
    if(intent.state==='committed')return result as Memory;
    const assert=()=>{if(JSON.stringify(binding)!==JSON.stringify(this.bindings.binding()))throw new StoreError('Memory binding changed before owner publication',409);for(const prior of before)if(this.store.db.prepare('SELECT json FROM memories WHERE id=?').get(prior.id)?.json!==prior.json)throw new StoreError('Memory changed before owner publication',409);if(result.evidenceIds.some((id:string)=>!this.memories.isCurrentEvidence(id)))throw new StoreError('Publication originals changed',409);};
    await this.stageRecords(operationId,changed,assert);const db=this.store.db;db.exec('BEGIN IMMEDIATE');try{assert();const saved=this.memories.publish(id,version,at);db.prepare("UPDATE memory_owner_mutations SET state='committed' WHERE id=?").run(operationId);db.exec('COMMIT');return saved;}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  async correct(id:string,input:unknown){
    this.bindings.assertNewManualWork();if(!this.bindings.binding().namespace)return this.memories.correct(id,input);
    const operationId='owner-correction:'+id+':'+sha256(JSON.stringify(input)),intent=this.ownerMutation(operationId,()=>({binding:this.bindings.binding(),identity:{noteId:randomUUID(),memoryId:randomUUID(),at:new Date().toISOString()}}));
    if(intent.state==='committed')return this.memories.get(intent.value.identity.memoryId);
    const binding=JSON.stringify(intent.value.binding),result=await this.memories.correct(id,input,async(records,assert)=>this.stageRecords(operationId,records,()=>{if(binding!==JSON.stringify(this.bindings.binding()))throw new StoreError('Memory binding changed before correction',409);assert();}),intent.value.identity,()=>this.store.db.prepare("UPDATE memory_owner_mutations SET state='committed' WHERE id=?").run(operationId));
    return result;
  }
  async delete(id:string){
    // Host tombstones revoke reads before touching an external service. All
    // retained binding generations get durable erase intents, including history.
    const result=this.memories.delete(id);this.queueErases([id]);
    await this.reconcile();this.scheduleReconcile();const pending=Number(this.store.db.prepare("SELECT count(*) n FROM memory_provider_erases WHERE json_extract(json,'$.memoryId')=? AND state='submitted'").get(id)!.n);return {...result,externalErase:pending?'pending':'acknowledged',physicalEraseVerified:false};
  }
  async close(){if(this.poll)clearInterval(this.poll);await this.dispose?.();}
}
