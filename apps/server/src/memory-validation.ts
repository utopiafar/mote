import {CODING_MEMORY_CONTRACT} from './memory-schema.js';
const MEMORY_SCHEMA_FEEDBACK='Every candidate needs admission (layer observation|memory, reason, scope, attribution user|third_party|observed|inferred) and exact evidence quotes. Consolidated candidates must be layer memory and include only relatedMemoryIds actually used from supplied cards. Empty output is valid.';
export const validationFeedback={
  json:'The answer field must be a string containing one valid JSON object with a memories array. Do not put Markdown fences or prose around that JSON.',
  schema:MEMORY_SCHEMA_FEEDBACK+' Use exactly a memories array with at most 8 objects (at most 3 for coding-memory extraction). Each object requires string title, string statement, string uncertainty, and a nonempty evidenceIds array of complete UUIDs. Evidence entries require id and an exact quote. Omit offset and length by default; the host resolves a unique exact match. If supplied, offset must be absolute UTF-16 and length must equal the UTF-16 quote length. '+CODING_MEMORY_CONTRACT+' Do not add other keys.',
  coding_contract:CODING_MEMORY_CONTRACT,
  coding_scope:'The supplied originals lack a resolved host project identity. Keep the supported coding claim, but use coding.scope=session for limited/unresolved applicability, name the evidenced project in coding.applicability prose, and do not invent scopeRefs or repository/session identities.',
  citations:'Use complete supporting evidence UUIDs in inline [UUID] citations and declare those same IDs in the inner evidenceIds and outer citationIds. Every declared ID must have been retrieved in this same supplied scope.',
  scope:'Use only original evidence IDs and exact text segments supplied for this batch. Do not introduce other records, derived memories, or evidence outside the supplied ranges.',
  quote:'A quote did not exactly match the original text at its declared offset, or had no unique match. Copy an exact substring from the supplied original segment. Prefer omitting offset so the host resolves a unique exact match within the supplied ranges; never guess an offset. When supplied, offsets must be absolute UTF-16 offsets. If length is supplied, it must equal quote.length in UTF-16 code units.',
  quote_evidence_undeclared:'The evidence entry ID is not in this candidate’s evidenceIds. Use only this candidate’s declared, retrieved evidence.',
  quote_length_mismatch:'The declared length differs from quote.length in UTF-16 code units. Omit length; the host computes it.',
  quote_offset_mismatch:'The quote does not match at the declared absolute UTF-16 offset. Omit offset for unique exact matching, or use the correct absolute UTF-16 offset. Never paraphrase the quote.',
  quote_not_found:'The quote is not an exact substring of the original evidence. Copy from the supplied original, not from your previous answer. Preserve whitespace, newlines and the exact Unicode punctuation: curly double quotation marks U+201C/U+201D, curly single quotation marks U+2018/U+2019 and ASCII U+0022/U+0027 are different characters. JSON escaping must decode back to the original characters; it must not replace them. Use separate short exact evidence entries for disjoint supporting passages, even from one ID, rather than retyping a long intervening passage. Keep every substantive claim supported.',
  quote_ambiguous:'The quote matches multiple authorized positions. Use a longer unique exact quote or an explicit absolute UTF-16 offset.',
  quote_range:'A quote was outside its supplied evidence segment. Keep the entire quote within one supplied range and use an absolute UTF-16 offset in the full original text.',
  missing_quote:'When supplying evidence spans, include an exact matching quote for every ID in evidenceIds.',
} as const;
export type MemoryOutputValidationCode=keyof typeof validationFeedback;

/** Content-free locations and measurements, safe for ordinary diagnostics. Indices are zero-based. */
export type MemoryValidationDetails={candidateIndex?:number;spanIndex?:number;evidenceId?:string;declaredOffset?:number;declaredLength?:number;quoteLength?:number;sourceLength?:number;authorizedMatches?:number};
