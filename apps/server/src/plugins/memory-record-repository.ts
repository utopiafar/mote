import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,ServiceBinding,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import {MemoryStore} from '../memory.js';
import {memoryStorageSchema} from '../memory-storage-schema.js';
import {memorySchema} from '../memory-schema.js';
import {memoryBodyDigest,memoryProviderKey} from '../memory-provider-contract.js';
import {StoreError} from '../store.js';
import {centralServices} from './central-contracts.js';
import type {MemoryRecordHostState,MemoryRecordRead,MemoryRecordSnapshot,MemoryRecordSnapshots} from '../evidence-read-ports.js';

/** C21B owns the canonical Memory record storage: the `memories` rows, the
 * dependency/index triggers and the read-only `memory_catalog` projection.
 * The read/snapshot ports below serve already host-validated records; they are
 * not an evidence disclosure scope, so Agent and MCP audiences keep using the
 * evidence-context reader's scoped MemoryRead port.
 *
 * Wiring note: until K04 moves the materials read graph behind this factory,
 * `buildApp` still lets EvidenceReader construct its own MemoryStore and the
 * vault installs the same idempotent schema. This factory is the single owner
 * once installed; the acceptance test activates it through the real host. */
export const memoryRecordRepositoryContribution={
  id:'memory-record-repository',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.vault-platform',version:'1.0.0'}],
  provides:[centralServices.memoryRecords,centralServices.memoryRecordSnapshots].map(service=>({kind:'service' as const,id:service.id,apiVersion:service.apiVersion,cardinality:'single' as const})),
} as const satisfies ManifestContribution;
export const memoryRecordRepositoryDeclaration={id:memoryRecordRepositoryContribution.id,apiVersion:'1'} as const;
export const memoryRecordRepositoryReplacement='hot' as const;

export interface MemoryRecordRepositoryBindings {
  readonly records:ServiceBinding;
  readonly snapshots:ServiceBinding;
}

const unavailable=()=>new StoreError('Memory record repository is unavailable',503);

/** The only construction path for the record storage. The repository factory
 * uses it, and the transitional EvidenceReader borrows the same builder until
 * K04 injects the acquired port instead of a constructor. */
export function openMemoryRecords(store:MemoryStore['store'],readEvidence?:ConstructorParameters<typeof MemoryStore>[1],currentEvidence?:ConstructorParameters<typeof MemoryStore>[2]){
  memoryStorageSchema(store.db);
  return new MemoryStore(store,readEvidence,currentEvidence);
}

/** Owns the actual MemoryStore. Other domains borrow it through the host lease
 * (or the transitional `storeForAssembly` bridge) and never construct a second
 * record storage over the same vault. */
export function createMemoryRecordRepository(store:MemoryStore['store']){
  if(!store)throw unavailable();
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopped'='created';
  let memories:MemoryStore|undefined,closing:Promise<void>|undefined;
  const retained=new Set<MemoryRecordSnapshot>();
  const readable=()=>phase==='prepared'||phase==='active'||phase==='quiescing';
  const opened=()=>{
    if(!memories||!readable())throw unavailable();
    return memories;
  };
  const close=()=>closing??=(async()=>{
    phase='stopped';
    for(const snapshot of [...retained]){try{snapshot.release();}catch{}}
    retained.clear();
    memories=undefined;
  })();
  const snapshot=(ids?:readonly string[]):MemoryRecordSnapshot=>{
    opened();
    const db=store.db,none=ids!==undefined&&ids.length===0,rows=none?[]:ids?
      db.prepare(`SELECT json FROM memories WHERE id IN (${ids.map(()=>'?').join(',')}) ORDER BY id`).all(...ids):
      db.prepare('SELECT json FROM memories ORDER BY id').all();
    const records=rows.map(row=>memorySchema.parse(JSON.parse(String(row.json))));
    let released=false;
    const value:MemoryRecordSnapshot=Object.freeze({
      retainedAt:new Date().toISOString(),
      ids:Object.freeze(records.map(record=>record.id)),
      records:Object.freeze(Object.fromEntries(records.map(record=>[record.id,record]))),
      keys:Object.freeze(Object.fromEntries(records.map(record=>[record.id,memoryProviderKey(record)]))),
      digests:Object.freeze(Object.fromEntries(records.map(record=>[record.id,memoryBodyDigest(record)]))),
      hostStates:Object.freeze(Object.fromEntries(records.map(record=>[record.id,{status:record.status,...(record.staleReason===undefined?{}:{staleReason:record.staleReason}),...(record.updatedAt===undefined?{}:{updatedAt:record.updatedAt})} satisfies MemoryRecordHostState]))),
      release(){if(released)return;released=true;retained.delete(value);},
    });
    retained.add(value);
    return value;
  };
  const records:MemoryRecordRead=Object.freeze({
    memoryRecord:(id:string)=>opened().get(id),
    memoryRecordPage:(args?:Parameters<MemoryStore['page']>[0])=>opened().page(args),
    memoryRecordCount:()=>opened().count(),
    memoryRecordText:(id:string)=>opened().text(id),
  });
  const snapshots:MemoryRecordSnapshots=Object.freeze({
    retainMemoryRecordSnapshot:(ids?:readonly string[])=>snapshot(ids),
    releaseMemoryRecordSnapshot:(value:MemoryRecordSnapshot)=>{
      opened();
      retained.delete(value);
      value.release();
    },
  });
  return Object.freeze({
    /** Install the domain-owned schema and construct the single record storage.
     * Existing vault installations keep the same idempotent definitions until
     * the storage provider stops installing this domain's tables. */
    async prepare(){
      if(phase!=='created')throw unavailable();
      try{
        if(store.db.isTransaction)throw new StoreError('Memory record repository preparation requires an idle vault transaction',503);
        memories=openMemoryRecords(store);
        phase='prepared';
      }catch(error){
        try{await close();}
        catch(cleanup){throw new AggregateError([error,cleanup],'Memory record repository preparation and disposal failed',{cause:error});}
        throw error;
      }
    },
    start(){if(phase!=='prepared')throw unavailable();phase='active';},
    quiesce(_reason?:StopReason){if(phase==='active')phase='quiescing';},
    stop:async(_reason?:StopReason)=>{await close();},dispose:close,close,
    records,snapshots,
    /** Trusted composition bridge until the EvidenceReader/Pipeline consumers
     * acquire the repository port. Writes still go through the MemoryStore's
     * own validated transaction paths. */
    get storeForAssembly(){if(!memories||phase==='created'||phase==='stopped')throw unavailable();return memories;},
  });
}
export type MemoryRecordRepository=ReturnType<typeof createMemoryRecordRepository>;

export function createMemoryRecordRepositoryFactory(platform:MemoryRecordRepository,onStarted?:(bindings:MemoryRecordRepositoryBindings)=>void){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(()=>platform.close());
    return {
      prepare:platform.prepare,
      start(){
        platform.start();
        const records=context.provide(memoryRecordRepositoryContribution.id,centralServices.memoryRecords,platform.records);
        const snapshots=context.provide(memoryRecordRepositoryContribution.id,centralServices.memoryRecordSnapshots,platform.snapshots);
        onStarted?.({records,snapshots});
      },
      quiesce:(reason?:StopReason)=>platform.quiesce(reason),stop:(reason?:StopReason)=>platform.stop(reason),dispose:platform.dispose,
    };
  };
}
