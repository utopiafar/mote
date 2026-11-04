import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import type {registerMemoryDelegation} from '../memory-delegation.js';
import type {MemoryLifecycle} from '../memory-lifecycle.js';
import type {MemoryPipeline} from '../memory-pipeline.js';
import type {reviewMemory,MemoryDraftOrigin} from '../memory-review.js';
import type {MemoryReviewStrategy} from '../memory-strategy-contract.js';

/** C22 Memory runtime members. */
export interface MemoryRuntimeFeatureServices {
  memoryPipeline:MemoryPipeline;
  lifecycle:MemoryLifecycle;
  memoryDelegation:ReturnType<typeof registerMemoryDelegation>;
  reviewExtraction:(input:QueryInput,result:QueryResult,strategy?:MemoryReviewStrategy,draftOrigin?:MemoryDraftOrigin)=>ReturnType<typeof reviewMemory>;
  automaticMemoryScheduling:boolean;
}

export const memoryRuntimeFeatureServiceMembers = ['memoryPipeline','lifecycle','memoryDelegation','reviewExtraction','automaticMemoryScheduling'] as const satisfies readonly (keyof MemoryRuntimeFeatureServices)[];
