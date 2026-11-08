import type {QueryInput} from '@mote/agent';
import type {CaptureRecord,QueryResult} from '@mote/shared';
import type {Memory} from './memory-schema.js';
import type {MemoryProviderNamespace} from './memory-provider-contract.js';

export type MemoryEngineDraftContext={phase:'extract'|'integrate';opId:string;evidenceIds:string[];checkpointId?:string;cleanupGeneration?:string;relatedMemories?:Memory[];assertAuthority?:()=>void;provider?:{instanceId:string;configurationIdentity:string;namespace:MemoryProviderNamespace}};
export type MemoryEngineDraftPin=Omit<MemoryEngineDraftContext,'relatedMemories'|'assertAuthority'>;
export function memoryEngineDraftPin(context:MemoryEngineDraftContext):MemoryEngineDraftPin{const {relatedMemories:_,assertAuthority:__,...pin}=context;return structuredClone(pin);}

/** Semantic transport only. The host owns durable pins and cleanup recovery. */
export type MemoryNativeStageAdapter={
  prepare?:(input:QueryInput,context:MemoryEngineDraftContext)=>Promise<QueryResult|undefined>;
  settle?:(context:MemoryEngineDraftPin)=>Promise<void>;
};
export interface MemoryNativeStagePort {
  prepare(input:QueryInput,context:MemoryEngineDraftContext):Promise<QueryResult|undefined>;
  settle(context:MemoryEngineDraftContext|MemoryEngineDraftPin):Promise<void>;
  abandon(context:MemoryEngineDraftContext|MemoryEngineDraftPin):void;
}
export type MemoryEngineEvidence=CaptureRecord|{record:CaptureRecord;offset:number;length:number};
export type MemoryEnginePrepare={namespace:MemoryProviderNamespace;opId:string;phase:'extract'|'integrate';evidence:MemoryEngineEvidence[];relatedMemories?:Memory[];signal?:AbortSignal};
/** Engine-mode semantic transport supplied by an installed engine adapter.
 * No engine ships with the host; the worker ABI covers repository and
 * retrieval only. Cleanup belongs to the same retained adapter. */
export interface MemoryEngine {
  prepare(input:MemoryEnginePrepare):Promise<QueryResult>;
  discardPrepared?(input:{namespace:MemoryProviderNamespace;opId:string;phase:'extract'|'integrate'}):Promise<void>;
  erasePreparedEvidence?(evidenceIds:readonly string[]):Promise<void>;
}
