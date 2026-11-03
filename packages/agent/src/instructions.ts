import type {ContextRecord,QueryInput} from './types.js';
import {ARCHIVE_RETRIEVAL_INSTRUCTIONS} from './tasks/query.js';
import {
  ARCHIVE_RECENCY_INSTRUCTIONS,
  ATTRIBUTION_CONTEXT_INSTRUCTIONS,
  BOUNDED_EVIDENCE_PROMPT,
  EVIDENCE_SECURITY_INSTRUCTIONS,
  MATERIAL_EVIDENCE_INSTRUCTIONS,
  SOURCE_TIME_INSTRUCTIONS,
  boundedSourceInstructions,
  hasUnknownSourceProtocol,
} from './tasks/evidence-rules.js';
import {WORKING_SYSTEM_PROMPT} from './tasks/working.js';
import {taskProfile} from './task-context.js';
import {hostControlInstructions} from './host-controls.js';

export {ATTRIBUTION_CONTEXT_INSTRUCTIONS,SOURCE_TIME_INSTRUCTIONS};

// One compact canonical evidence contract. Source-specific protocols are
// attached to actual returned evidence, never selected from question keywords.
export const SYSTEM_PROMPT=[EVIDENCE_SECURITY_INSTRUCTIONS,MATERIAL_EVIDENCE_INSTRUCTIONS,ARCHIVE_RETRIEVAL_INSTRUCTIONS,BOUNDED_EVIDENCE_PROMPT.slice(BOUNDED_EVIDENCE_PROMPT.indexOf('The host request')),ATTRIBUTION_CONTEXT_INSTRUCTIONS].join('\n');
export function systemInstructions(input:QueryInput,evidence:ContextRecord[]=[]):string {
 if(input.hostControlChannel){const {hostControlChannel:controls,...ordinary}=input;return systemInstructions(ordinary,evidence)+'\n'+hostControlInstructions(controls);}
 if(input.skill==='working-memory')return WORKING_SYSTEM_PROMPT+'\n'+SOURCE_TIME_INSTRUCTIONS+ATTRIBUTION_CONTEXT_INSTRUCTIONS;
 // Unknown source protocols retain the existing full rules. A restricted host
 // grant still has no obligation to discover newer archive originals.
 const full=taskProfile(input).retrieval==='archive'?SYSTEM_PROMPT:SYSTEM_PROMPT.replace(ARCHIVE_RECENCY_INSTRUCTIONS+'\n','');
 // Open archive sessions may retrieve any source later. Unknown source protocols
 // retain every rule rather than assuming the missing metadata means absence.
 if(input.evidenceIds===undefined||!evidence.length)return input.hostContextToolMode==='all-native'?full.replace('use capability_discover then capability_execute with its exact registered name/version and schema','invoke the supplied typed native capability directly'):full;
 if(hasUnknownSourceProtocol(evidence))return full;
 return boundedSourceInstructions(evidence);
}
