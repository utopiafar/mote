import {CONTEXT_TOOLS} from '../../context-tools.js';
import {defineToolDescriptor, toolContractError, type ToolDescriptor, type ToolFields} from '../descriptor.js';
import type {HostSessionPort} from '../host-session.js';
import type {ContextRange} from '../../context-contracts.js';
import {sourceSchema} from '@mote/shared';

/** Facts supplied by the parent A08 run; never a reader, grant or session. */
export interface ReadPackInputs {
  readonly timeZone?: string;
}

export const invalidPackArgument = (message: string) => toolContractError('invalid_tool_arguments', message);

function spec(name: string): readonly [string, string, ToolFields] {
  const entry = CONTEXT_TOOLS.find(([candidate]) => candidate === name);
  if (!entry) throw Error(`Missing context-tool schema for ${name}`);
  return entry as unknown as readonly [string, string, ToolFields];
}

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

export function createMaterialReadPack(_input: ReadPackInputs = {}): readonly ToolDescriptor[] {
  void _input;
  const catalog = spec('material_catalog'), read = spec('material_read');
  return Object.freeze([
    defineToolDescriptor({
      apiVersion: '1', name: 'material_catalog', version: '1',
      description: catalog[1],
      fields: catalog[2], kind: 'metadata', exposure: 'native', requires: ['materialCatalog'],
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
      description: read[1],
      fields: read[2], kind: 'originals', exposure: 'native', requires: ['materialRead'],
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
