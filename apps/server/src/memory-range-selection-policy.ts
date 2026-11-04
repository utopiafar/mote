import {SOURCE_TIME_INSTRUCTIONS} from '@mote/agent';
import {CONTEXT_READING_PERSONAL_POLICY} from './bounded-personal-memory-policy.js';
import {CODING_MEMORY_REVIEW_POLICY} from './coding-memory-review-policy.js';
import {DAILY_EVENT_EXTRACTION_PROMPT,DAILY_EVENT_REVIEW_POLICY} from './daily-event-memory-policy.js';
import {MEMORY_EXTRACTION_PROMPT} from './memory.js';
import type {MemoryExtractionStrategy,MemoryReviewStrategy} from './memory-strategy-contract.js';

export const RANGE_SELECTION_PERSONAL_RECIPE={id:'mote.personal-memory',version:'5'} as const;
export const RANGE_SELECTION_CODING_RECIPE={id:'mote.coding-memory',version:'3'} as const;
export const RANGE_SELECTION_DAILY_RECIPE={id:'mote.daily-event-memory',version:'2'} as const;

/** These are new immutable definitions. Old policy text and fingerprints stay intact. */
const selectionPolicy=`Assess every supplied authorized target range in full, then select useful standalone Memory or observation candidates under this policy. The complete originals remain searchable. Do not enumerate every useful fact, create a candidate per paragraph, fill a quota, or manufacture a result for coverage. Preserve meaningful positive context and consequential details in coherent supported candidates; avoid repetitive cards. Deliberate selection can omit potentially useful details after full assessment. Selection is not incomplete evaluation and candidate count is not a completeness signal. Return no_candidates only after assessing the full range and selecting no additional candidate. Independently review the full ranges even when the draft has no candidates; correct unsupported claims, material omissions within selected claims, and the semantic selection. If inspection is unfinished or evidence/output is truncated, return incomplete with a concrete reason, never checked or no_candidates. Do not report semantic capacity saturation or request recursive splitting merely to enumerate more candidates. Existing resource limits, exact proof and target/context coverage remain host guarantees.`;

// Combine selection with the immutable v4 interpretation policy under new versions.
const personalPolicy=CONTEXT_READING_PERSONAL_POLICY.replace(
 'Then use checked for supported products or no_candidates for a precise reason there is no additional supported product;',
 'Then use checked for selected supported products or no_candidates for a precise reason no additional supported product was selected under this policy;',
);
export const rangeSelectionPersonalExtractionStrategy:MemoryExtractionStrategy={
 id:'mote.personal-extraction',version:'3',input:'memory-evidence@1',output:'memory-candidates@1',permissions:['evidence.read'],
 prompt:personalPolicy+'\n'+SOURCE_TIME_INSTRUCTIONS+'\n'+selectionPolicy,
};
export const rangeSelectionPersonalReviewStrategy:MemoryReviewStrategy={
 id:'mote.personal-review',version:'5',input:'memory-candidates@1',output:'memory-candidates@1',permissions:['evidence.read'],
 policy:'Independently review the complete fallible draft against every target original range and the exact authorized context needed to interpret it. Re-evaluate narrator correspondence, temporal frames, continuations, modality, semantic selection and coverage from originals; the draft and the extractor\'s context choices are not approval requirements. Use context_evidence yourself for unresolved material gaps. Correct unsupported claims and preserve material supported details within selected candidates. Return the complete corrected selected-candidate JSON, not approval prose.\n'+personalPolicy+'\n'+SOURCE_TIME_INSTRUCTIONS+'\n'+selectionPolicy,
};

export const rangeSelectionContextExtractionStrategy:MemoryExtractionStrategy={
 id:'mote.selected-context-extraction',version:'1',input:'memory-evidence@1',output:'memory-candidates@1',permissions:['evidence.read'],
 prompt:MEMORY_EXTRACTION_PROMPT
  .replace('Inspect every supplied original evidence segment and propose at most 8 useful, distinct memories.','Inspect every supplied original evidence segment and select useful, distinct memories under the supplied policy.')
  .replace('If no supported memory exists, return an empty list.','After full range assessment, return an empty list when no additional memory is selected under the supplied policy.')+'\n'+selectionPolicy,
};
export const rangeSelectionCodingReviewStrategy:MemoryReviewStrategy={
 id:'mote.coding-review',version:'3',input:'memory-candidates@1',output:'memory-candidates@1',permissions:['evidence.read'],
 policy:CODING_MEMORY_REVIEW_POLICY.replace('Empty output is appropriate only when the originals do not support a useful Coding product; it is not a substitute for preserving a supported positive.','Empty output is appropriate only after assessing the full ranges and selecting no additional useful Coding product; it is not a substitute for preserving meaningful supported positive context.')+'\n'+selectionPolicy,
};

function dailySelectionPolicy(policy:string){return policy
 .replace('Do not omit a supported distinct event merely because original search could find it.','Select useful dated events for recall; original search retains the complete captured history.')
 .replace('Read every authorized input: a distinct identifiable display/browse/plan/action is a positive event; zero is valid for empty, unreadable or non-event content, not as a substitute for reviewing ordinary events. If the supplied scope exceeds the output capacity, declare saturation/incomplete coverage through the supplied work contract and leave the exact target unfinished; never silently drop events to fit or assume automatic subdivision.','Assess every authorized target range and select useful identifiable display/browse/plan/action events. Zero is valid after full assessment and no additional event selection; unreadable or unassessed targets remain incomplete. Deliberate event selection does not promise every event appears in Memory. Never label unread input or truncated output as complete evaluation.')
 .replace('Restore supported ordinary events omitted by the draft.','Correct the draft selection and preserve consequential supported details within selected events.')+'\n'+selectionPolicy;}
export const rangeSelectionDailyExtractionStrategy:MemoryExtractionStrategy={
 id:'mote.daily-event-extraction',version:'2',input:'memory-evidence@1',output:'memory-candidates@1',permissions:['evidence.read'],
 prompt:dailySelectionPolicy(DAILY_EVENT_EXTRACTION_PROMPT),
};
export const rangeSelectionDailyReviewStrategy:MemoryReviewStrategy={
 id:'mote.daily-event-review',version:'2',input:'memory-candidates@1',output:'memory-candidates@1',permissions:['evidence.read'],
 policy:dailySelectionPolicy(DAILY_EVENT_REVIEW_POLICY),
};
