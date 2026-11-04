import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import type {MemoryLifecycle} from '../memory-lifecycle.js';
import type {MemoryPipeline} from '../memory-pipeline.js';
import type {reviewMemory,MemoryDraftOrigin} from '../memory-review.js';
import type {MemoryReviewStrategy} from '../memory-strategy-contract.js';

/** C22 Memory runtime members. Delegation is registered by the phase-pipeline
 * plugin, not borrowed through FeatureServices. */
export interface MemoryRuntimeFeatureServices {
  memoryPipeline:MemoryPipeline;
  lifecycle:MemoryLifecycle;
  reviewExtraction:(input:QueryInput,result:QueryResult,strategy?:MemoryReviewStrategy,draftOrigin?:MemoryDraftOrigin)=>ReturnType<typeof reviewMemory>;
  automaticMemoryScheduling:boolean;
}

export const memoryRuntimeFeatureServiceMembers = ['memoryPipeline','lifecycle','reviewExtraction','automaticMemoryScheduling'] as const satisfies readonly (keyof MemoryRuntimeFeatureServices)[];
