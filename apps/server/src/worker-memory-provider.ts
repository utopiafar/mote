import {z} from 'zod';
import {memorySchema} from './memory-schema.js';
import {memoryProviderKeySchema,memoryProviderNamespaceSchema,memoryProviderRecordSchema,type MemoryProvider,type MemoryProviderHealth,type MemoryProviderWrite,type MemoryProviderRead,type MemoryProviderRemove,type MemoryProviderSearch} from './memory-provider-contract.js';
import {sha256,StoreError} from './store.js';
import type {PluginRuntime} from './plugin-runtime.js';

const receiptSchema=z.object({opId:z.string(),namespace:memoryProviderNamespaceSchema,key:memoryProviderKeySchema,payloadDigest:z.string().regex(/^[a-f0-9]{64}$/),externalId:z.string().optional(),state:z.enum(['applied','removed','unknown']),currentRemoved:z.boolean().optional(),historyRetained:z.boolean().optional(),eraseVerified:z.boolean(),recordedAt:z.string()}).strict();
export const providerHealthSchema=z.object({providerId:z.string(),version:z.string(),ready:z.boolean(),verified:z.object({persistentCrud:z.boolean(),scopedRetrieval:z.boolean(),immutableRecords:z.boolean(),idempotentReplay:z.boolean(),history:z.boolean(),physicalErase:z.boolean()}).strict(),problems:z.array(z.string())}).strict();
function same(value:unknown,expected:unknown){return JSON.stringify(value)===JSON.stringify(expected);}

/** Mandatory host validation at the executable adapter boundary. A provider ID
 * never grants scope or publication authority to the returned body. */
export class WorkerMemoryProvider implements MemoryProvider {
  constructor(private runtime:PluginRuntime){}
  async put(input:MemoryProviderWrite){memoryProviderRecordSchema.parse({namespace:input.namespace,key:input.key,memory:input.memory});const receipt=receiptSchema.parse(await this.runtime.call('put',input));
    if(receipt.opId!==input.opId||!same(receipt.namespace,input.namespace)||!same(receipt.key,input.key)||receipt.state!=='applied'||receipt.payloadDigest!==sha256(JSON.stringify({namespace:input.namespace,key:input.key,memory:input.memory})))throw new StoreError('The plugin did not verify the exact staged Memory write',502);return receipt;
  }
  async read(input:MemoryProviderRead){const result=await this.runtime.call('read',input);if(result===null)return null;const memory=memorySchema.parse(result);if(!same({memoryId:memory.id,version:memory.version,fingerprint:memory.fingerprint},input.key))throw new StoreError('The plugin returned a different Memory revision',502);return memory;}
  async remove(input:MemoryProviderRemove){const receipt=receiptSchema.parse(await this.runtime.call('remove',input));if(receipt.opId!==input.opId||!same(receipt.namespace,input.namespace)||!same(receipt.key,input.key)||receipt.state!=='removed'||!receipt.currentRemoved)throw new StoreError('Plugin deletion result requires reconciliation',502);return receipt;}
  async search(input:MemoryProviderSearch){const values=z.array(z.object({namespace:memoryProviderNamespaceSchema,key:memoryProviderKeySchema,memory:memorySchema,score:z.number().optional()}).strict()).parse(await this.runtime.call('search',input));for(const value of values){memoryProviderRecordSchema.parse({namespace:value.namespace,key:value.key,memory:value.memory});if(!same(value.namespace,input.namespace))throw new StoreError('The plugin returned Memory from another binding',502);}return values;}
  async export(input:{namespace:MemoryProviderRead['namespace']}){const values=z.array(memoryProviderRecordSchema).parse(await this.runtime.call('export',input));for(const value of values)if(!same(value.namespace,input.namespace))throw new StoreError('The plugin exported Memory from another binding',502);return values;}
  async health(input:{namespace:MemoryProviderRead['namespace']}):Promise<MemoryProviderHealth>{return providerHealthSchema.parse(await this.runtime.call('health',input));}
  recover(input:{namespace:MemoryProviderRead['namespace']}){return this.health(input);}
  close(){return this.runtime.close();}
}
