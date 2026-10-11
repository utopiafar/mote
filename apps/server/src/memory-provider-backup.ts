import {createHash} from 'node:crypto';
import type {MemoryBindings} from './memory-bindings.js';
import {MemoryProviderError,memoryProviderRecordSchema,memoryProviderNamespaceSchema,memoryBodyDigest,withMemoryHostState} from './memory-provider-contract.js';
import {memorySchema,type Memory} from './memory-schema.js';
import {StoreError} from './store.js';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const revision=(snapshot:ReturnType<MemoryBindings['retainSnapshot']>)=>digest({binding:snapshot.binding,catalog:snapshot.catalog,recordDigests:snapshot.recordDigests,metadata:snapshot.metadata});

/** Portable Mote bodies, resolved from the actual binding. Native provider
 * databases, retained SDK history and deployment credentials need their own
 * complete backup; this exporter makes no physical-erasure or restore claim. */
export async function exportBoundMemories(bindings:MemoryBindings):Promise<Memory[]>{
  const snapshot=bindings.retainSnapshot();
  try{
    const selected=new Map<string,Memory>();
    if(snapshot.binding.namespace){
      const namespace=snapshot.binding.namespace,expectedNamespace=JSON.stringify(memoryProviderNamespaceSchema.parse(namespace));
      const records=await bindings.provider(namespace.instanceId,namespace).export({namespace});
      for(const raw of records){
        const record=memoryProviderRecordSchema.parse(raw);
        if(JSON.stringify(record.namespace)!==expectedNamespace)throw new StoreError('Memory export crossed its bound namespace',502);
        const expected=snapshot.catalog[record.key.memoryId];
        if(!expected||JSON.stringify(record.key)!==JSON.stringify(expected))continue;
        if(selected.has(record.key.memoryId)||memoryBodyDigest(record.memory)!==snapshot.recordDigests[record.key.memoryId])throw new StoreError('Memory export does not match the pinned immutable catalog',502);
        selected.set(record.key.memoryId,withMemoryHostState(record.memory,snapshot.metadata[record.key.memoryId] as Pick<Memory,'status'|'staleReason'|'updatedAt'>));
      }
    }else for(const memory of Object.values(snapshot.records??{}))selected.set(memory.id,memorySchema.parse(memory));
    if(selected.size!==Object.keys(snapshot.catalog).length)throw new StoreError('Memory export is missing a bound history record',502);
    // A deletion, correction or binding change while the exporter awaited an
    // external service invalidates the whole archive, never a partial success.
    const current=bindings.retainSnapshot();try{if(revision(current)!==revision(snapshot))throw new StoreError('Memory changed during export; retry the archive',409);}finally{current.release();}
    return Object.keys(snapshot.catalog).map(id=>selected.get(id)!);
  }catch(error){if(error instanceof MemoryProviderError)throw new StoreError(error.message,error.code==='invalid_record'||error.code==='conflict'?502:503);throw error;}finally{snapshot.release();}
}
