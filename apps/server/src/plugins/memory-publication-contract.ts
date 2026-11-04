import type {QueryResult} from '@mote/shared';
import type {MemoryExtractOptions,PreparedMemoryExtraction} from '../memory.js';
import type {Memory} from '../memory-schema.js';
import type {MemoryProviderNamespace} from '../memory-provider-contract.js';

export type MemoryPublicationDependencies={evidenceIds?:readonly string[];memoryIds?:readonly string[]};
export type MemoryPublicationReceipt={operationId:string;binding:{planId:string;generation:number;namespace?:MemoryProviderNamespace};prepared:PreparedMemoryExtraction;payloadHash:string};

/** Reviewed stages can retain and verify a publication, without owner commands
 * or access to provider discovery, reconciliation and lifecycle state. */
export interface MemoryStagePublication {
  retainedOutput<T>(operationId:string):T|undefined;
  retainOutput(operationId:string,output:unknown,dependencies?:MemoryPublicationDependencies):void;
  stageExtract(operationId:string,result:QueryResult,model:string,options:MemoryExtractOptions,assertAuthority:()=>void,automatic?:boolean):Promise<MemoryPublicationReceipt|undefined>;
  assert(receipt:MemoryPublicationReceipt|undefined,result:QueryResult):void;
  committed(receipt:MemoryPublicationReceipt|undefined):void;
}
export type MemoryOwnerDeletionResult={deleted:number;externalErase:'pending'|'acknowledged';physicalEraseVerified:false};
/** Owner HTTP commands retain their existing authorization and response bodies. */
export interface MemoryOwnerPublication {
  withOwnerWork<T>(work:()=>Promise<T>):Promise<T>;
  publish(id:string,version?:number):Promise<Memory>;
  correct(id:string,input:unknown):Promise<Memory>;
  delete(id:string):Promise<MemoryOwnerDeletionResult>;
}
