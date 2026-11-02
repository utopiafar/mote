import {sourceContentTime} from '@mote/shared';
import {defineToolDescriptor, type ToolDescriptor} from '../descriptor.js';
import {filterFields, invalidPackArgument, rangeFields, scopedRange, type ReadPackInputs} from './materials.js';

/** Frozen run facts for navigation. The Host still checks every actual read. */
export interface DerivedNavigationInputs extends ReadPackInputs {
  readonly contextTime?: string;
  readonly incrementalEvidenceIds?: readonly string[];
}

const contextIndexFields = {...rangeFields, path: {type: 'string'}, query: {type: 'string'}};
const segmentFields = {...filterFields, id: {type: 'string'}, query: {type: 'string'}, cursor: {type: 'string'}};
const changesFields = {view: {type: 'string', enum: ['overview', 'text']}, cursor: {type: 'string'}, limit: {type: 'number'}};

export function createDerivedNavigationPack(input: DerivedNavigationInputs = {}): readonly ToolDescriptor[] {
  const incremental = Object.freeze([...(input.incrementalEvidenceIds ?? [])]);
  return Object.freeze([
    defineToolDescriptor({
      apiVersion: '1', name: 'context_index', version: '1',
      description: 'Read the virtual /context directory or search source names/descriptions, memory and processed episode layers together with query. Returns bounded metadata, previews, revisions, coverage and expansion costs; never original bodies. Use paths /context/memory, /context/episodes or /context/sources. Expand selected IDs using memories or segments. Direct original search is appropriate for fresh or exact facts; this index is not proof of absence.',
      fields: contextIndexFields, kind: 'metadata', exposure: 'native', requires: ['catalog'],
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
      description: 'Browse bounded processed activity segments after memory cards. These are exact-text reductions with original members and times, not inferred tasks or independent facts. Pass its returned ref as id to pin the segment revision; use evidence on member ids to verify facts. Raw sampled screenshots are omitted from default search and timeline discovery, so use published segments or materials to locate them. Missing or pending segments never mean no original evidence exists.',
      fields: segmentFields, kind: 'derived', exposure: 'native', requires: ['segments'],
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
      description: 'Inspect the host-selected incremental snapshot in pages. Scheduled insights default to lightweight overview metadata (not citable); use evidence for selected originals. view=text explicitly reads bounded original text. Do not exhaust the entire snapshot unless the task requires full coverage. No time filter is implied: late arrivals can refer to much earlier dates. Empty outside scheduled insight runs. Discovered IDs can be expanded with evidence; use search_context and memories for related history.',
      fields: changesFields, kind: 'derived', exposure: 'native', requires: ['evidence'],
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

export const derivedNavigationPack = createDerivedNavigationPack;
