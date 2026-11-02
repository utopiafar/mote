import {fileEvidenceSchema,recordMetadataSchema} from '@mote/shared';
import {evidenceExcerpt,excerptSlice} from './evidence-ledger.js';
import {validateInlineCitations} from './citations.js';
import {AgentResponseError} from './types.js';
import type {ContextRecord} from './context-contracts.js';

/** Lossless wire normalization: some models emit literal newlines inside JSON
 * strings. Escape only those control bytes, without guessing keys or content. */
function escapeJsonStringControls(raw: string): string {
  let inside = false, escaped = false, normalized = '';
  for (const character of raw) {
    if (inside && !escaped && character.charCodeAt(0) < 0x20) {
      normalized += `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
      escaped = false;
      continue;
    }
    normalized += character;
    if (escaped) escaped = false;
    else if (inside && character === '\\') escaped = true;
    else if (character === '"') inside = !inside;
  }
  return normalized;
}

export function parseAnswer(raw: string, records: ReadonlyMap<string, ContextRecord>) {
  if (typeof raw !== 'string' || raw.length > 1_000_000)
    throw new AgentResponseError('The model response exceeds the answer size limit.', 'response_too_large');
  const clean = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/, "")
    .replace(/\n?```$/, "");
  let result: unknown;
  try {
    result = JSON.parse(escapeJsonStringControls(clean));
  } catch {
    throw new AgentResponseError(
      "The model did not return a valid evidence-backed response. Please retry.", 'invalid_json',
    );
  }
  const value = result as { answer?: unknown; citationIds?: unknown };
  if (
    !value ||
    typeof value.answer !== "string" ||
    !value.answer.trim() ||
    !Array.isArray(value.citationIds) ||
    value.citationIds.some((id) => typeof id !== "string")
  )
    throw new AgentResponseError(
      "The model response has an invalid answer or citation list.", 'invalid_shape',
    );
  const ids = [...new Set(value.citationIds as string[])];
  if (ids.some((id) => !records.has(id)))
    throw new AgentResponseError(
      "The model cited evidence that was not retrieved in this run.", 'unretrieved_citation',
    );
  validateInlineCitations(value.answer, ids, records.keys());
  return {
    answer: value.answer,
    citations: ids.map((id) => {
      const record = records.get(id)!;
      const {displayObservedAt:_, ...rawMetadata} = (record.metadata ?? {}) as Record<string,unknown>;
      const metadata = recordMetadataSchema.safeParse(rawMetadata);
      const mediaExcerpt = metadata.success ? metadata.data.media?.sessions.map(session => [session.title, session.artist, session.album, session.appName].filter(Boolean).join(' · ')).join(' / ') : undefined;
      return {
        id,
        capturedAt: record.capturedAt,
        appName: record.appName,
        excerpt: excerptSlice(evidenceExcerpt(record) || record.summary || mediaExcerpt || "",600),
        ...(typeof record.contentAt==='string'?{contentAt:record.contentAt}:{}),
        ...(fileEvidenceSchema.safeParse(record.fileEvidence).success?{fileEvidence:fileEvidenceSchema.parse(record.fileEvidence)}:{}),
        ...(record.provenance?{provenance:record.provenance as import('./types.js').Citation['provenance']}:{}),
      };
    }),
  };
}

