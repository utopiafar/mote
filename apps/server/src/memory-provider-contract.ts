import {z} from 'zod';
import {createHash} from 'node:crypto';
import {memorySchema,type Memory} from './memory-schema.js';

/** Host-issued namespace. There is deliberately no default owner or binding. */
export const memoryProviderNamespaceSchema=z.object({ownerId:z.string().min(1),instanceId:z.string().min(1),bindingRevision:z.number().int().positive()}).strict();
export type MemoryProviderNamespace=z.infer<typeof memoryProviderNamespaceSchema>;
export const memoryProviderKeySchema=z.object({memoryId:z.string().uuid(),version:z.number().int().positive(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type MemoryProviderKey=z.infer<typeof memoryProviderKeySchema>;
export const memoryProviderRecordSchema=z.object({namespace:memoryProviderNamespaceSchema,key:memoryProviderKeySchema,memory:memorySchema}).strict().superRefine((record,ctx)=>{
  if(record.key.memoryId!==record.memory.id||record.key.version!==record.memory.version||record.key.fingerprint!==record.memory.fingerprint)ctx.addIssue({code:'custom',message:'Memory key does not match the immutable record'});
});
export type MemoryProviderRecord=z.infer<typeof memoryProviderRecordSchema>;
export type MemoryProviderWrite=MemoryProviderRecord&{opId:string};
export type MemoryProviderRead={namespace:MemoryProviderNamespace;key:MemoryProviderKey};
export type MemoryProviderRemove=MemoryProviderRead&{opId:string};
export type MemoryProviderSearch={namespace:MemoryProviderNamespace;query:string;limit?:number;keys?:MemoryProviderKey[]};
export type MemoryProviderReceipt={opId:string;namespace:MemoryProviderNamespace;key:MemoryProviderKey;payloadDigest:string;externalId?:string;state:'applied'|'removed'|'unknown';currentRemoved?:boolean;historyRetained?:boolean;eraseVerified:boolean;recordedAt:string};
export type MemoryProviderHit=MemoryProviderRecord&{score?:number};
export type MemoryProviderHealth={providerId:string;version:string;ready:boolean;verified:{persistentCrud:boolean;scopedRetrieval:boolean;immutableRecords:boolean;idempotentReplay:boolean;history:boolean;physicalErase:boolean};problems:string[]};

/** Storage and retrieval only. Admission, source authorization and publication
 * fences remain in the host. Query agents receive a separate read-only facade. */
export interface MemoryProvider {
  put(input:MemoryProviderWrite):Promise<MemoryProviderReceipt>;
  read(input:MemoryProviderRead):Promise<Memory|null>;
  remove(input:MemoryProviderRemove):Promise<MemoryProviderReceipt>;
  search(input:MemoryProviderSearch):Promise<MemoryProviderHit[]>;
  export(input:{namespace:MemoryProviderNamespace}):Promise<MemoryProviderRecord[]>;
  health(input:{namespace:MemoryProviderNamespace}):Promise<MemoryProviderHealth>;
  recover(input:{namespace:MemoryProviderNamespace}):Promise<MemoryProviderHealth>;
  close():Promise<void>;
}
export class MemoryProviderError extends Error {
  constructor(public readonly code:'conflict'|'unavailable'|'invalid_record'|'unknown_result'|'closed',message:string){super(message);this.name='MemoryProviderError';}
}
export function memoryProviderKey(memory:Memory):MemoryProviderKey{return memoryProviderKeySchema.parse({memoryId:memory.id,version:memory.version,fingerprint:memory.fingerprint});}
/** Host validity and its update time can change without advancing a provider
 * version. Text, provenance, version, createdAt and all other body fields stay
 * in the immutable digest; native record validation still checks full JSON. */
export function memoryBodyDigest(memory:Memory):string{const {status:_,staleReason:__,updatedAt:___,...body}=memorySchema.parse(memory);return createHash('sha256').update(JSON.stringify(body)).digest('hex');}
export function withMemoryHostState(body:Memory,state:Pick<Memory,'status'|'staleReason'|'updatedAt'>):Memory{const {status:_,staleReason:__,updatedAt:___,...immutable}=body;return memorySchema.parse({...immutable,status:state.status,...(state.staleReason===undefined?{}:{staleReason:state.staleReason}),...(state.updatedAt===undefined?{}:{updatedAt:state.updatedAt})});}
