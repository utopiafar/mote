import {ContextToolError} from '../../tool-errors.js';
import {defineToolDescriptor, type ToolDescriptor} from '../descriptor.js';
import type {ContextRange} from '../../context-contracts.js';
import type {HostSessionPort} from '../host-session.js';

/** Options are frozen by the parent factory signature. Display timestamps are a
 * Host session projection, so the pack keeps the value for parity but never
 * re-projects records or grants citations. */
export interface SourceReadPackOptions {
  readonly timeZone?: string;
}

const invalid = (message: string): never => {
  throw new ContextToolError('invalid_tool_arguments', message, 'correct_arguments');
};

function dateValue(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid(`${field} must be an ISO timestamp`);
  return new Date(value as string).toISOString();
}

function contextId(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value || value.length > 1600 || /[\/\\]|:\/\/|\s/.test(value)) invalid(message);
  return value as string;
}

/** Intersect model arguments with the authorized scope. This narrows a request
 * and preserves the existing range/device errors; it never grants access. The
 * parent HostSessionPort still performs the fresh grant and discovery check. */
function scopedRange(args: Readonly<Record<string, unknown>>, scope: Readonly<ContextRange>): ContextRange {
  const after = dateValue(args.after, 'after'), before = dateValue(args.before, 'before');
  const lower = dateValue(scope.after, 'after'), upper = dateValue(scope.before, 'before');
  const effectiveAfter = after && lower ? (after > lower ? after : lower) : (after ?? lower);
  const effectiveBefore = before && upper ? (before < upper ? before : upper) : (before ?? upper);
  if (effectiveAfter && effectiveBefore && effectiveAfter > effectiveBefore) invalid('Time range is outside the requested scope');
  if (args.deviceId !== undefined && typeof args.deviceId !== 'string') invalid('deviceId must be a string');
  if (scope.deviceId && args.deviceId !== undefined && args.deviceId !== scope.deviceId) invalid('Device is outside the requested scope');
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1)) invalid('limit must be a positive integer');
  if (args.cursor !== undefined && (typeof args.cursor !== 'string' || !args.cursor || args.cursor.length > 4096)) invalid('cursor must be a pagination token returned by timeline');
  return {
    ...(effectiveAfter ? {after: effectiveAfter} : {}),
    ...(effectiveBefore ? {before: effectiveBefore} : {}),
    ...(scope.deviceId ?? (args.deviceId as string | undefined) ? {deviceId: scope.deviceId ?? args.deviceId as string} : {}),
    ...(args.limit !== undefined ? {limit: args.limit as number} : scope.limit !== undefined ? {limit: scope.limit} : {}),
    ...(args.cursor !== undefined ? {cursor: args.cursor as string} : {}),
  };
}

function parseRange(args: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const after = dateValue(args.after, 'after'), before = dateValue(args.before, 'before');
  if (args.deviceId !== undefined && typeof args.deviceId !== 'string') invalid('deviceId must be a string');
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1)) invalid('limit must be a positive integer');
  if (args.cursor !== undefined && (typeof args.cursor !== 'string' || !args.cursor || args.cursor.length > 4096)) invalid('cursor must be a pagination token returned by timeline');
  return Object.freeze({
    ...args,
    ...(after ? {after} : {}),
    ...(before ? {before} : {}),
  });
}

const rangeFields = {
  after: {type: 'string', description: 'Inclusive ISO timestamp lower bound'},
  before: {type: 'string', description: 'Exclusive ISO timestamp upper bound (records at this instant are excluded)'},
  deviceId: {type: 'string', description: 'Optional exact device identifier'},
  limit: {type: 'integer', description: 'Maximum records, from 1 to 100; default 30'},
} as const;

/** Source discovery, item browsing and immutable revision history. Every source
 * identity comes from the current scope or a previously discovered result. */
export function createSourceReadPack(options: SourceReadPackOptions = {}): readonly ToolDescriptor[] {
  void options.timeZone; // Host session projects display times; see above.
  return Object.freeze([
    defineToolDescriptor({
      apiVersion: '1',
      name: 'sources',
      version: '1',
      description: 'Discover connected context sources and their synchronization state. A source connection does not guarantee full coverage. No content is fetched from remote locations. query performs literal search over source names and owner-entered descriptions. Results are bounded previews with fixed sourceContextRef; open the complete statement with attribution_context, then browse source_items for evidence. Follow nextCursor with the same query and device.',
      kind: 'metadata',
      exposure: 'catalog',
      requires: ['sources'],
      fields: {
        ...rangeFields,
        query: {type: 'string'},
        cursor: {type: 'string'},
      },
      parse(args) {
        if (args.query !== undefined && (typeof args.query !== 'string' || (args.query as string).length > 500)) invalid('Invalid source query');
        return parseRange(args);
      },
      execute(args, port: HostSessionPort) {
        const range = scopedRange(args, port.scope);
        return port.read('sources', {...range, ...(args.query === undefined ? {} : {query: args.query as string})});
      },
    }),
    defineToolDescriptor({
      apiVersion: '1',
      name: 'source_items',
      version: '1',
      description: 'Browse current source revisions. Set includeDeleted=true to include removed or cancelled source tombstones; their empty body is not proof the event occurred. For calendars after/before overlap planned event times, not capture time; events are plans, never measured attendance. File snapshots are as-of copies; reference/shadow items retain metadata only and cannot establish unseen contents. Results contain original context ids, expandable with evidence. Follow nextCursor for more.',
      kind: 'originals',
      exposure: 'catalog',
      requires: ['sourceItems'],
      fields: {
        ...rangeFields,
        sourceId: {type: 'string', description: 'Exact source id from sources'},
        includeDeleted: {type: 'boolean', description: 'Include source-reported removal/cancellation tombstones; default false'},
        kind: {type: 'string', description: 'calendar, file, event, message, metric or memory'},
        cursor: {type: 'string', description: 'Returned pagination cursor'},
      },
      parse(args) {
        for (const field of ['sourceId', 'kind'] as const) {
          if (args[field] !== undefined && (typeof args[field] !== 'string' || (args[field] as string).length > 128)) invalid('Invalid source filter');
        }
        if (args.includeDeleted !== undefined && typeof args.includeDeleted !== 'boolean') invalid('includeDeleted must be boolean');
        return parseRange(args);
      },
      async execute(args, port: HostSessionPort) {
        const page = await port.read('sourceItems', {
          ...scopedRange(args, port.scope),
          ...(args.sourceId === undefined ? {} : {sourceId: args.sourceId as string}),
          ...(args.kind === undefined ? {} : {kind: args.kind as string}),
          ...(args.includeDeleted === undefined ? {} : {includeDeleted: args.includeDeleted as boolean}),
        });
        if (!page || !Array.isArray(page.items) || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) invalid('Context reader returned an invalid page');
        if (page.totalCount !== undefined && (!Number.isSafeInteger(page.totalCount) || page.totalCount < 0 || page.totalCount < page.items.length)) invalid('Context reader returned an invalid total count');
        return page;
      },
    }),
    defineToolDescriptor({
      apiVersion: '1',
      name: 'source_history',
      version: '1',
      description: 'Inspect immutable earlier revisions of a discovered source item. Pass its current context id from source_items/search/timeline. Use this to compare changes; current search hides superseded versions, which does not mean history is absent. Historical snapshots describe their own observation time, not the current truth.',
      kind: 'originals',
      exposure: 'catalog',
      requires: ['sourceHistory'],
      fields: {
        id: {type: 'string', required: true, description: 'Discovered context id for a versioned source item'},
      },
      parse(args) {
        return Object.freeze({id: contextId(args.id, 'Discover a source record before requesting history')});
      },
      async execute(args, port: HostSessionPort) {
        const records = await port.read('sourceHistory', {...scopedRange({}, port.scope), id: args.id as string});
        if (!Array.isArray(records)) invalid('Context reader returned invalid records');
        return records;
      },
    }),
  ]);
}
