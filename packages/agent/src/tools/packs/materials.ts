import {attributionContextSchema, formatEvidenceRef, parseEvidenceRef, sourceContentTime, sourceSchema} from '@mote/shared';
import {originalEvidenceReceipt} from '../../bridge.js';
import {CONTEXT_TOOLS} from '../../context-tools.js';
import {defineToolDescriptor, toolContractError, type ToolDescriptor, type ToolFields} from '../descriptor.js';
import type {HostSessionPort} from '../host-session.js';
import type {ContextRange, ContextRecord} from '../../context-contracts.js';

/** Immutable run facts supplied by parent A08; never a grant or a reader. */
export interface ReadPackInputs {
  readonly timeZone?: string;
}

export const invalidPackArgument = (message: string): never => { throw toolContractError('invalid_tool_arguments', message); };

const pinnedMaterialRef = /^material:(mat_[a-f0-9]{64})@([a-f0-9]{64})$/;
const invalid = (message: string): never => {
  throw invalidPackArgument(message);
};
const splitsPair = (text: string, at: number) => at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]!) && /[\uDC00-\uDFFF]/.test(text[at]!);

function spec(name: string): readonly [string, string, ToolFields] {
  const entry = CONTEXT_TOOLS.find(([candidate]) => candidate === name);
  if (!entry) throw Error(`Missing context-tool schema for ${name}`);
  return entry as unknown as readonly [string, string, ToolFields];
}

function iso(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw invalid(`${field} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

/** Intersect with the Host-normalized effective scope. This narrows only; the
 * parent port still rechecks scope, registration and fresh authorization. */
export function scopedRange(port: HostSessionPort, args: Readonly<Record<string, unknown>>): ContextRange {
  const after = iso(args.after, 'after'), before = iso(args.before, 'before');
  const lower = iso(port.scope.after, 'after'), upper = iso(port.scope.before, 'before');
  const effectiveAfter = after && lower ? (after > lower ? after : lower) : after ?? lower;
  const effectiveBefore = before && upper ? (before < upper ? before : upper) : before ?? upper;
  if (effectiveAfter && effectiveBefore && effectiveAfter > effectiveBefore) throw invalid('Time range is outside the requested scope');
  if (args.deviceId !== undefined && typeof args.deviceId !== 'string') throw invalid('deviceId must be a string');
  if (port.scope.deviceId && args.deviceId !== undefined && args.deviceId !== port.scope.deviceId) throw invalid('Device is outside the requested scope');
  const requestedLimit = args.limit === undefined ? (port.scope.limit ?? 30) : Number(args.limit);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) throw invalid('limit must be a positive integer');
  if (args.cursor !== undefined && (typeof args.cursor !== 'string' || !args.cursor || args.cursor.length > 4096)) throw invalid('cursor must be a pagination token returned by timeline');
  const parsedSource = args.source === undefined ? undefined : sourceSchema.safeParse(args.source);
  if (parsedSource && !parsedSource.success) throw invalid('Invalid source');
  if (args.appId !== undefined && (typeof args.appId !== 'string' || !args.appId.trim() || args.appId.length > 300)) throw invalid('Invalid appId');
  if (args.collection !== undefined && args.collection !== 'content' && args.collection !== 'activity') throw invalid('Invalid collection');
  return {
    ...(effectiveAfter === undefined ? {} : {after: effectiveAfter}),
    ...(effectiveBefore === undefined ? {} : {before: effectiveBefore}),
    ...(port.scope.deviceId ?? (args.deviceId as string | undefined) ? {deviceId: port.scope.deviceId ?? args.deviceId as string} : {}),
    limit: Math.min(requestedLimit, port.scope.limit ?? requestedLimit, 100),
    ...(args.cursor === undefined ? {} : {cursor: args.cursor as string}),
    ...(parsedSource?.success ? {source: parsedSource.data} : {}),
    ...(args.appId === undefined ? {} : {appId: args.appId as string}),
    ...(args.collection === undefined ? {} : {collection: args.collection as 'content' | 'activity'}),
  };
}

function inScope(record: ContextRecord, scope: Readonly<ContextRange>): boolean {
  const at = sourceContentTime(record);
  return Number.isFinite(Date.parse(at)) && (!scope.deviceId || record.deviceId === scope.deviceId) &&
    (!scope.after || Date.parse(at) >= Date.parse(scope.after)) && (!scope.before || Date.parse(at) < Date.parse(scope.before));
}

function materialCatalogPage(value: unknown): {items: unknown[]; nextCursor: string | null} {
  const page = value as {items?: unknown; nextCursor?: unknown} | null;
  if (!page || !Array.isArray(page.items) || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || page.nextCursor.length > 4096))) invalid('Invalid material catalog page');
  return page as {items: unknown[]; nextCursor: string | null};
}

export function createMaterialReadPack(input: ReadPackInputs = {}): readonly ToolDescriptor[] {
  const timeZone = input.timeZone ?? 'UTC';
  const catalog = spec('material_catalog'), read = spec('material_read');
  return Object.freeze([
    defineToolDescriptor({
      apiVersion: '1', name: 'material_catalog', version: '1', description: catalog[1], fields: catalog[2],
      kind: 'derived', exposure: 'native', requires: ['materialCatalog'],
      parse(args) {
        for (const key of ['sourceId', 'kind', 'query']) {
          if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key] || String(args[key]).length > 128)) throw invalid(`Invalid ${key}`);
        }
        return args;
      },
      async execute(args, port) {
        port.assertCurrent();
        const page = materialCatalogPage(await port.read('materialCatalog', {
          ...scopedRange(port, args),
          sourceId: args.sourceId as string | undefined,
          kind: args.kind as string | undefined,
          query: args.query as string | undefined,
        }));
        port.assertCurrent();
        return {source: 'untrusted_personal_context', data: {items: page.items, nextCursor: page.nextCursor}};
      },
    }),
    defineToolDescriptor({
      apiVersion: '1', name: 'material_read', version: '1', description: read[1], fields: read[2],
      kind: 'derived', exposure: 'native', requires: ['materialRead', 'evidence'],
      parse(args) {
        if (typeof args.ref !== 'string' || !pinnedMaterialRef.test(args.ref)) invalid('Use the owner-selected pinned material ref or one returned by material_catalog in this run');
        const offset = args.offset ?? 0, length = args.length ?? 4000;
        if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(length) || Number(length) < 1 || Number(length) > 12000) invalid('Invalid material read range');
        return {...args, offset: Number(offset), length: Number(length)};
      },
      async execute(args, port) {
        const scope = scopedRange(port, {}), offset = args.offset as number, length = args.length as number;
        port.assertCurrent();
        const page = await port.read('materialRead', {...scope, ref: args.ref as string, offset, length});
        port.assertCurrent();
        const material = (page as {material?: unknown} | null)?.material as {ref?: unknown} | undefined;
        const text = (page as {text?: unknown} | null)?.text as string | undefined;
        const textRange = (page as {textRange?: {offset?: number; total?: number; nextOffset?: number | null}} | null)?.textRange;
        if (!material || material.ref !== args.ref || typeof text !== 'string' || text.length > length || !textRange ||
          textRange.offset !== offset || !Number.isSafeInteger(textRange.total) || Number(textRange.total) < offset + text.length ||
          textRange.nextOffset !== (offset + text.length < Number(textRange.total) ? offset + text.length : null) ||
          text.length === 0 && offset < Number(textRange.total) ||
          !Array.isArray((page as {spans?: unknown}).spans) || (page as {spans: unknown[]}).spans.length > 64 ||
          !Array.isArray((page as {originalRefs?: unknown}).originalRefs)) invalid('Invalid material read page');
        const textValue = text as string;
        const spans = ((page as {spans: unknown[]}).spans).map(value => {
          const span = value as Record<string, unknown>, pageRange = span.pageRange as {start?: unknown; end?: unknown} | undefined;
          const materialRange = span.materialRange as {start?: unknown; end?: unknown} | undefined;
          if (!span || typeof span.blockId !== 'string' || span.blockId.length > 128 || typeof span.kind !== 'string' ||
            !['text', 'asset'].includes(span.kind) || !Array.isArray(span.memberIds) || span.memberIds.length > 32 ||
            span.memberIds.some(id => typeof id !== 'string' || id.length > 128) || !pageRange || !materialRange ||
            !Number.isSafeInteger(pageRange.start) || !Number.isSafeInteger(pageRange.end) || Number(pageRange.start) < 0 ||
            Number(pageRange.end) < Number(pageRange.start) || Number(pageRange.end) > textValue.length ||
            !Number.isSafeInteger(materialRange.start) || !Number.isSafeInteger(materialRange.end) ||
            Number(materialRange.start) < 0 || Number(materialRange.end) < Number(materialRange.start)) invalid('Invalid material span');
          const pageBounds = pageRange as {start: number; end: number}, materialBounds = materialRange as {start: number; end: number};
          const attribution = attributionContextSchema.safeParse(span.attributionContext);
          const attributionMetadata = attribution.success
            ? (({ownerStatements: _owner, importStatements: _import, sourceContextStatements: _source, recordContextStatements: _record, ...metadata}) => metadata)(attribution.data)
            : undefined;
          return {
            blockId: span.blockId, kind: span.kind, ...(attributionMetadata ? {attributionContext: attributionMetadata} : {}),
            ...(typeof span.format === 'string' && span.format.length <= 128 ? {format: span.format} : {}),
            pageRange: {start: pageBounds.start, end: pageBounds.end},
            materialRange: {start: materialBounds.start, end: materialBounds.end}, memberIds: span.memberIds,
          };
        });
        const refs = [...new Set((page as {originalRefs: unknown[]}).originalRefs.slice(0, 30).map(ref => {
          const parsed = typeof ref === 'string' ? parseEvidenceRef(ref) : undefined;
          return parsed?.kind === 'capture' ? parsed.id : undefined;
        }))];
        if (refs.some(id => typeof id !== 'string' || !id || id.length > 300)) invalid('Invalid material original reference');
        const ids = refs as string[];
        let originals: ContextRecord[] = [];
        if (ids.length) {
          originals = await port.read('evidence', {...scope, ids});
          if (!Array.isArray(originals)) invalid('Material evidence reader returned invalid records');
          const valid = new Set(originals.filter(record => inScope(record, scope)).map(record => record.id));
          if (ids.some(id => !valid.has(id))) invalid('Material original is missing or outside the selected scope');
        }
        const total = Number.isSafeInteger((page as {originalRefsTotal?: unknown}).originalRefsTotal) && Number((page as {originalRefsTotal: number}).originalRefsTotal) >= ids.length
          ? Number((page as {originalRefsTotal: number}).originalRefsTotal) : ids.length;
        const sourceEvidence: ContextRecord[] = [];
        for (const span of ((page as {sourceSpans?: unknown}).sourceSpans as {record?: ContextRecord; offset?: unknown; length?: unknown}[] | undefined ?? []).slice(0, 30)) {
          const record = span.record;
          if (!record) continue;
          const fresh = originals.find(candidate => candidate.id === record.id);
          if (!fresh || fresh.contentLayer === 'L2_model_interpretation' || record.contentLayer === 'L2_model_interpretation' ||
            !Number.isSafeInteger(span.offset) || Number(span.offset) < 0 || !Number.isSafeInteger(span.length) || Number(span.length) < 1 ||
            Number(span.offset) + Number(span.length) > fresh.ocrText.length || splitsPair(fresh.ocrText, Number(span.offset)) ||
            splitsPair(fresh.ocrText, Number(span.offset) + Number(span.length)) || fresh.ocrText !== record.ocrText) continue;
          sourceEvidence.push(originalEvidenceReceipt(fresh, Number(span.offset), Number(span.length), timeZone));
        }
        const range = textRange as {offset: number; total: number; nextOffset: number | null};
        const originalRefsTruncated = Boolean((page as {originalRefsTruncated?: unknown}).originalRefsTruncated) || total > ids.length || (page as {originalRefs: unknown[]}).originalRefs.length > ids.length;
        const delivered = new Set(sourceEvidence.map(record => record.id));
        return {
          source: 'untrusted_personal_context',
          data: {
            material, text: textValue, textRange: {offset, total, nextOffset: range.nextOffset}, spans,
            originalRefs: ids.map(id => formatEvidenceRef('capture', id)), originalRefsTotal: total,
            originalRefsTruncated, sourceEvidence,
            sourceCoverage: {references: total, delivered: sourceEvidence.length, partial: total > delivered.size || Boolean((page as {originalRefsTruncated?: unknown}).originalRefsTruncated)},
            pagination: {requestedLength: length, returnedLength: textValue.length},
          },
        };
      },
    }),
  ]);
}
