import {MEMORY_EXTRACTION_PROMPT} from './memory.js';
import {CONSOLIDATION_RELATION_POLICY} from './memory-policy.js';
import type {MemoryIntegrationStrategy,MemoryReviewStrategy} from './memory-strategy-contract.js';
import {defaultMemoryReviewStrategy} from './memory-review-policy.js';

/** The current product policy is replaceable; evidence and commit rules are not. */
export const defaultMemoryIntegrationStrategy:MemoryIntegrationStrategy={
  id:'mote.context-integration',version:'2',input:'memory-cards@1',output:'memory-candidates@1',permissions:['memory.read','evidence.read'],
  prompt:MEMORY_EXTRACTION_PROMPT+'\nIntegrate the supplied selected Memory cards by revisiting their originals. Different extraction strategies do not by themselves establish different facts. Avoid another card when current memories already express the supported facts and relationships. Preserve meaningful differences in attribution, dates, applicability and uncertainty; repeated events are not transport duplicates. Propose only an evidenced useful synthesis, contradiction or scoped replacement. Preserve unrelated facts and owner corrections.\n'+CONSOLIDATION_RELATION_POLICY,
};
export const defaultMemoryIntegrationRecipe={id:'mote.memory-integration',version:'2'};
export const defaultMemoryIntegrationReview:MemoryReviewStrategy={...defaultMemoryReviewStrategy,id:'mote.integration-review',permissions:['memory.read','evidence.read']};
