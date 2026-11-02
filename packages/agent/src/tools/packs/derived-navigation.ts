import {sourceContentTime} from '@mote/shared';
import {CONTEXT_TOOLS} from '../../context-tools.js';
import {defineToolDescriptor, type ToolDescriptor, type ToolFields} from '../descriptor.js';
import {invalidPackArgument, scopedRange, type ReadPackInputs} from './materials.js';

/** Frozen run facts for navigation. The Host still checks every actual read. */
export interface DerivedNavigationInputs extends ReadPackInputs {
  readonly contextTime?: string;
  readonly incrementalEvidenceIds?: readonly string[];
}

function spec(name: string): readonly [string, string, ToolFields] {
  const entry = CONTEXT_TOOLS.find(([candidate]) => candidate === name);
  if (!entry) throw Error(`Missing context-tool schema for ${name}`);
  return entry as unknown as readonly [string, string, ToolFields];
}

export function createDerivedNavigationPack(input: DerivedNavigationInputs = {}): readonly ToolDescriptor[] {
  const incremental = Object.freeze([...(input.incrementalEvidenceIds ?? [])]);
  const index = spec('context_index'), segment = spec('segments'), change = spec('changes');
  return Object.freeze([
    defineToolDescriptor({
      apiVersion: '1', name: 'context_index', version: '1',
      description: index[1],
      fields: index[2], kind: 'metadata', exposure: 'native', requires: ['catalog'],
      parse(args) {
        if (args.path !== undefined && (typeof args.path !== 'string' || args.path.length > 100)) throw invalidPackArgument('Invalid context index arguments');
        if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 500)) throw invalidPackArgument('Invalid context index arguments');
        return args;
      },
      async execute(args, port) {
        return await port.read('catalog', {
          ...scopedRange(port, args),
          path: args.path as string | undefined,
          query: args.query as string | undefined,
        }) ?? {entries: [], coverage: 'unavailable'};
      },
    }),
    defineToolDescriptor({
      apiVersion: '1', name: 'segments', version: '1',
      description: segment[1],
      fields: segment[2], kind: 'derived', exposure: 'native', requires: ['segments'],
      parse(args) {
        if (args.id !== undefined && (typeof args.id !== 'string' || args.id.length > 1600)) throw invalidPackArgument('Invalid segment id');
        if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 500)) throw invalidPackArgument('Invalid segment query');
        return args;
      },
      async execute(args, port) {
        const page = await port.read('segments', {
          ...scopedRange(port, args),
          id: args.id as string | undefined,
          query: args.query as string | undefined,
        }) ?? {items: [], nextCursor: null};
        if (!page || !Array.isArray(page.items) || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) throw invalidPackArgument('Invalid segments page');
        return page;
      },
    }),
    defineToolDescriptor({
      apiVersion: '1', name: 'changes', version: '1',
      description: change[1],
      fields: change[2], kind: 'derived', exposure: 'native', requires: ['evidence'],
      parse(args) {
        if (args.view !== undefined && !['overview', 'text'].includes(String(args.view))) throw invalidPackArgument('Invalid changes view');
        if (args.cursor !== undefined && (typeof args.cursor !== 'string' || !/^(0|[1-9][0-9]*)$/.test(args.cursor))) throw invalidPackArgument('Invalid changes page');
        if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 30)) throw invalidPackArgument('Invalid changes page');
        return args;
      },
      async execute(args, port) {
        const offset = args.cursor === undefined ? 0 : Number(args.cursor), limit = Math.min(Number(args.limit ?? 30), 30);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw invalidPackArgument('Invalid changes page');
        if (!incremental.length) return {items: [], nextCursor: null, totalCount: 0};
        const selected = incremental.slice(offset, offset + limit);
        const records = await port.read('evidence', {...scopedRange(port, {}), ids: [...selected]});
        if (!Array.isArray(records)) throw invalidPackArgument('Changes evidence reader returned invalid records');
        const view = args.view ?? 'text';
        const items = view === 'overview'
          ? records.map(record => ({
            id: record.id, capturedAt: record.capturedAt, contentAt: sourceContentTime(record),
            appName: record.appName, sourceType: record.sourceType, characters: String(record.ocrText ?? '').length,
          }))
          : records;
        return {items, nextCursor: offset + limit < incremental.length ? String(offset + limit) : null, totalCount: incremental.length};
      },
    }),
  ]);
}
