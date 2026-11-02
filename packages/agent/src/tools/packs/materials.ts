import {defineToolDescriptor, toolContractError, type ToolDescriptor} from '../descriptor.js';
import type {HostSessionPort} from '../host-session.js';
import type {ContextRange} from '../../context-contracts.js';
import {sourceSchema} from '@mote/shared';

/** Facts supplied by the parent A08 run; never a reader, grant or session. */
export interface ReadPackInputs {
  readonly timeZone?: string;
}

export const invalidPackArgument = (message: string) => toolContractError('invalid_tool_arguments', message);

export const rangeFields = {
  after: {type: 'string', description: 'Inclusive ISO timestamp lower bound'},
  before: {type: 'string', description: 'Exclusive ISO timestamp upper bound (records at this instant are excluded)'},
  deviceId: {type: 'string', description: 'Optional exact device identifier'},
  limit: {type: 'integer', description: 'Maximum records, from 1 to 100; default 30'},
};
export const filterFields = {
  ...rangeFields,
  source: {type: 'string', description: 'Exact source type: screen, ui_page, activity, media, notification, device_event, note, file, calendar, event, message, metric or memory'},
  appId: {type: 'string', description: 'Exact application identity discovered in evidence; not an intent or topic'},
  collection: {type: 'string', description: 'activity for app identity/time without contents; content for other permitted records'},
};
const materialCatalogFields = {
  query: {type: 'string', description: 'Literal search in published material text; prefer this for Coding conversations.'},
  ...rangeFields,
  sourceId: {type: 'string', description: 'Exact source ID, if known'},
  kind: {type: 'string', description: 'Exact registered material kind'},
  cursor: {type: 'string', description: 'Opaque cursor from the previous material_catalog page'},
};
const materialReadFields = {
  ref: {type: 'string', required: true, description: 'Exact pinned Material ref supplied as referenceMaterialRef or returned by material_catalog'},
  offset: {type: 'integer', description: 'UTF-16 body page offset; default 0'},
  length: {type: 'integer', description: 'Maximum body UTF-16 units, 1–12000; default 4000.'},
};

function iso(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw invalidPackArgument(`${field} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

/** Intersect the call with the Host-selected scope. This is transport/scope
 * validation only; the parent still performs fresh authority checks. */
export function scopedRange(port: HostSessionPort, args: Readonly<Record<string, unknown>>): ContextRange {
  const after = iso(args.after, 'after'), before = iso(args.before, 'before');
  const lower = iso(port.scope.after, 'after'), upper = iso(port.scope.before, 'before');
  const effectiveAfter = after && lower ? (after > lower ? after : lower) : after ?? lower;
  const effectiveBefore = before && upper ? (before < upper ? before : upper) : before ?? upper;
  if (effectiveAfter && effectiveBefore && effectiveAfter > effectiveBefore) throw invalidPackArgument('Time range is outside the requested scope');
  if (args.deviceId !== undefined && typeof args.deviceId !== 'string') throw invalidPackArgument('deviceId must be a string');
  if (port.scope.deviceId && args.deviceId !== undefined && args.deviceId !== port.scope.deviceId) throw invalidPackArgument('Device is outside the requested scope');
  const requestedLimit = args.limit === undefined ? (port.scope.limit ?? 30) : Number(args.limit);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) throw invalidPackArgument('limit must be a positive integer');
  const limit = Math.min(requestedLimit, 100);
  if (args.cursor !== undefined && (typeof args.cursor !== 'string' || !args.cursor || args.cursor.length > 4096)) throw invalidPackArgument('cursor must be a pagination token returned by timeline');
  const parsedSource = args.source === undefined ? undefined : sourceSchema.safeParse(args.source);
  if (parsedSource && !parsedSource.success) throw invalidPackArgument('Invalid source');
  const source = parsedSource?.data;
  if (args.appId !== undefined && (typeof args.appId !== 'string' || !args.appId.trim() || args.appId.length > 300)) throw invalidPackArgument('Invalid appId');
  if (args.collection !== undefined && args.collection !== 'content' && args.collection !== 'activity') throw invalidPackArgument('Invalid collection');
  return {
    after: effectiveAfter,
    before: effectiveBefore,
    deviceId: port.scope.deviceId ?? (args.deviceId as string | undefined),
    limit,
    ...(args.cursor === undefined ? {} : {cursor: args.cursor as string}),
    ...(source === undefined ? {} : {source}),
    ...(args.appId === undefined ? {} : {appId: args.appId as string}),
    ...(args.collection === undefined ? {} : {collection: args.collection as 'content' | 'activity'}),
  };
}

/** The parent Host owns pinned/discovered refs. This only rejects malformed
 * locators before a read; parent still verifies the exact pin. */
export const materialRefPattern = /^material:(mat_[a-f0-9]{64})@([a-f0-9]{64})$/;

export function createMaterialsPack(_input: ReadPackInputs = {}): readonly ToolDescriptor[] {
  return Object.freeze([
    defineToolDescriptor({
      apiVersion: '1', name: 'material_catalog', version: '1',
      description: 'Browse formal archived materials as bounded metadata only. Returns pinned revision refs, titles, source identity, time coverage, processing coverage, named artifact readiness and read costs; it does not expose bodies or original evidence IDs. Pending and partial materials remain queryable using the content available so far. Inspect artifact states and mention relevant processing gaps; they are not proof of completeness. Use material_read with an exact ref returned in this run to inspect a relevant page. Prefer this for Coding sessions and sampled screen segments. Missing results do not prove absence of original captures.',
      fields: materialCatalogFields, kind: 'metadata', exposure: 'native', requires: ['materialCatalog'],
      parse(args) {
        for (const key of ['sourceId', 'kind', 'query']) {
          if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key] || String(args[key]).length > 128)) throw invalidPackArgument(`Invalid ${key}`);
        }
        return args;
      },
      async execute(args, port) {
        const page = await port.read('materialCatalog', {
          ...scopedRange(port, args),
          sourceId: args.sourceId as string | undefined,
          kind: args.kind as string | undefined,
          query: args.query as string | undefined,
        });
        if (!page || !Array.isArray(page.items) || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || page.nextCursor.length > 4096))) throw invalidPackArgument('Invalid material catalog page');
        return page;
      },
    }),
    defineToolDescriptor({
      apiVersion: '1', name: 'material_read', version: '1',
      description: 'Read a pinned material page with bounded, freshly authorized sourceEvidence where exact source mapping exists. Cite only delivered sourceEvidence original IDs/ranges; body, originalRefs and private lineage alone grant no citations. Body and originals have independent UTF-16 offsets. Reuse sufficient sourceEvidence; use evidence for unresolved original ranges. Follow textRange.nextOffset; sourceCoverage.partial reports evidence gaps.',
      fields: materialReadFields, kind: 'originals', exposure: 'native', requires: ['materialRead'],
      parse(args) {
        if (typeof args.ref !== 'string' || !materialRefPattern.test(args.ref)) throw invalidPackArgument('Use the owner-selected pinned material ref or one returned by material_catalog in this run');
        const offset = args.offset ?? 0, length = args.length ?? 4000;
        if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(length) || Number(length) < 1 || Number(length) > 12000) throw invalidPackArgument('Invalid material read range');
        return {...args, offset: Number(offset), length: Number(length)};
      },
      async execute(args, port) {
        const page = await port.read('materialRead', {
          ...scopedRange(port, {}),
          ref: args.ref as string,
          offset: args.offset as number,
          length: args.length as number,
        });
        if (!page || typeof page !== 'object' || typeof page.text !== 'string' || !page.material || typeof page.textRange !== 'object') throw invalidPackArgument('Invalid material read page');
        return page;
      },
    }),
  ]);
}

export const materialsPack = createMaterialsPack;
