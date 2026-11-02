import {sourceContentTime} from '@mote/shared';
import {originalEvidenceReceipt} from '../../bridge.js';
import {CONTEXT_TOOLS} from '../../context-tools.js';
import {defineToolDescriptor, type ToolDescriptor, type ToolFields} from '../descriptor.js';
import type {HostSessionPort} from '../host-session.js';
import type {ContextRange, ContextRecord} from '../../context-contracts.js';
import {invalidPackArgument, scopedRange, type ReadPackInputs} from './materials.js';

/** Frozen run facts for navigation. The Host still checks every actual read. */
export interface DerivedNavigationInputs extends ReadPackInputs {
  readonly contextTime?: string;
  readonly incrementalEvidenceIds?: readonly string[];
  /** Parent chooses overview for a structured scheduled-insight run; text otherwise. */
  readonly defaultChangesView?: 'overview' | 'text';
}

function spec(name: string): readonly [string, string, ToolFields] {
  const entry = CONTEXT_TOOLS.find(([candidate]) => candidate === name);
  if (!entry) throw Error(`Missing context-tool schema for ${name}`);
  return entry as unknown as readonly [string, string, ToolFields];
}

function inScope(record: ContextRecord, scope: Readonly<ContextRange>): boolean {
  const at = sourceContentTime(record);
  return Number.isFinite(Date.parse(at)) && (!scope.deviceId || record.deviceId === scope.deviceId) &&
    (!scope.after || Date.parse(at) >= Date.parse(scope.after)) && (!scope.before || Date.parse(at) < Date.parse(scope.before));
}

export function createDerivedNavigationPack(input: DerivedNavigationInputs = {}): readonly ToolDescriptor[] {
  const timeZone = input.timeZone ?? 'UTC';
  const incremental = Object.freeze([...(input.incrementalEvidenceIds ?? [])]);
  const defaultView = input.defaultChangesView ?? 'text';
  if (!['overview', 'text'].includes(defaultView)) throw invalidPackArgument('Invalid default changes view');
  const index = spec('context_index'), segment = spec('segments'), change = spec('changes');
  return Object.freeze([
    defineToolDescriptor({
      apiVersion: '1', name: 'context_index', version: '1', description: index[1], fields: index[2],
      kind: 'derived', exposure: 'catalog', requires: ['catalog'],
      parse(args) {
        if (args.path !== undefined && (typeof args.path !== 'string' || args.path.length > 100)) invalidPackArgument('Invalid context index arguments');
        if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 500)) invalidPackArgument('Invalid context index arguments');
        return args;
      },
      async execute(args, port) {
        port.assertCurrent();
        const value = await port.read('catalog', {
          ...scopedRange(port, args), path: args.path as string | undefined, query: args.query as string | undefined,
        }) ?? {entries: [], coverage: 'unavailable'};
        port.assertCurrent();
        return {source: 'untrusted_personal_context', data: value};
      },
    }),
    defineToolDescriptor({
      apiVersion: '1', name: 'segments', version: '1', description: segment[1], fields: segment[2],
      kind: 'derived', exposure: 'catalog', requires: ['segments'],
      parse(args) {
        if (args.id !== undefined && (typeof args.id !== 'string' || args.id.length > 1600)) invalidPackArgument('Invalid segment id');
        if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 500)) invalidPackArgument('Invalid segment query');
        return args;
      },
      async execute(args, port) {
        const scope = scopedRange(port, args);
        port.assertCurrent();
        const page = await port.read('segments', {...scope, id: args.id as string | undefined, query: args.query as string | undefined}) ?? {items: [], nextCursor: null};
        port.assertCurrent();
        if (!page || !Array.isArray(page.items) || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) invalidPackArgument('Invalid segments page');
        const items = page.items.filter(item => (!scope.deviceId || item.deviceId === scope.deviceId) &&
          (!scope.after || typeof item.firstAt === 'string' && Date.parse(item.firstAt) >= Date.parse(scope.after!)) &&
          (!scope.before || typeof item.lastAt === 'string' && Date.parse(item.lastAt) < Date.parse(scope.before!)));
        return {source: 'untrusted_personal_context', data: {...page, items}, pagination: {nextCursor: page.nextCursor}};
      },
    }),
    defineToolDescriptor({
      apiVersion: '1', name: 'changes', version: '1', description: change[1], fields: change[2],
      kind: 'derived', exposure: 'catalog', requires: ['evidence'],
      parse(args) {
        if (args.view !== undefined && !['overview', 'text'].includes(String(args.view))) invalidPackArgument('Invalid changes view');
        if (args.cursor !== undefined && (typeof args.cursor !== 'string' || !/^(0|[1-9][0-9]*)$/.test(args.cursor))) invalidPackArgument('Invalid changes page');
        if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 30)) invalidPackArgument('Invalid changes page');
        return args;
      },
      async execute(args, port) {
        const view = (args.view as 'overview' | 'text' | undefined) ?? defaultView;
        if (!['overview', 'text'].includes(view)) invalidPackArgument('Invalid changes view');
        const offset = args.cursor === undefined ? 0 : Number(args.cursor);
        const requested = Math.min(Number(args.limit ?? 30), 30);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(requested) || requested < 1) invalidPackArgument('Invalid changes page');
        if (!incremental.length) return {source: 'untrusted_personal_context', data: [], pagination: {nextCursor: null, totalCount: 0}};
        const scope = scopedRange(port, {});
        const pageLimit = Math.min(requested, scope.limit ?? requested);
        const selected = incremental.slice(offset, offset + pageLimit);
        port.assertCurrent();
        const records = await port.read('evidence', {...scope, ids: [...selected]});
        port.assertCurrent();
        if (!Array.isArray(records)) invalidPackArgument('Changes evidence reader returned invalid records');
        const scoped = (records as ContextRecord[]).filter(record => selected.includes(record.id) && inScope(record, scope));
        const data = view === 'overview'
          ? scoped.map(record => ({
            id: record.id, capturedAt: record.capturedAt, contentAt: sourceContentTime(record),
            appName: record.appName, sourceType: record.sourceType, characters: String(record.ocrText ?? '').length,
          }))
          : scoped.map(record => originalEvidenceReceipt(record, 0, 600, timeZone));
        return {source: 'untrusted_personal_context', data, pagination: {
          nextCursor: offset + pageLimit < incremental.length ? String(offset + pageLimit) : null,
          totalCount: incremental.length,
        }};
      },
    }),
  ]);
}
