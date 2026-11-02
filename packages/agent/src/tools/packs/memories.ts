import {sourceContentTime} from '@mote/shared';
import {originalEvidenceReceipt} from '../../bridge.js';
import {CONTEXT_TOOLS} from '../../context-tools.js';
import {defineToolDescriptor, type ToolDescriptor, type ToolFields} from '../descriptor.js';
import type {HostSessionPort} from '../host-session.js';
import type {ContextRange, ContextRecord} from '../../context-contracts.js';
import {invalidPackArgument, scopedRange, type ReadPackInputs} from './materials.js';

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

function withoutSavedQuotes(items: unknown[]): unknown[] {
  return items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const entry = item as {evidence?: unknown};
    if (!Array.isArray(entry.evidence)) return item;
    return {...entry, evidence: entry.evidence.map(reference => {
      if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return reference;
      const {quote: _quote, ...rest} = reference as Record<string, unknown>;
      return rest;
    })};
  });
}

export function createMemoriesPack(input: ReadPackInputs = {}): readonly ToolDescriptor[] {
  const timeZone = input.timeZone ?? 'UTC', memory = spec('memories');
  return Object.freeze([
    defineToolDescriptor({
      apiVersion: '1', name: 'memories', version: '1', description: memory[1], fields: memory[2],
      kind: 'derived', exposure: 'native', requires: ['memories'],
      parse(args) {
        if (args.id !== undefined && (typeof args.id !== 'string' || args.id.length > 128)) invalidPackArgument('Invalid memory id');
        if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 500)) invalidPackArgument('Invalid memory query');
        if (args.tier !== undefined && !['episode', 'consolidated'].includes(String(args.tier))) invalidPackArgument('Invalid memory tier');
        if (args.kind !== undefined && !['episodic', 'semantic', 'procedural'].includes(String(args.kind))) invalidPackArgument('Invalid memory kind');
        if (args.layer !== undefined && !['observation', 'memory'].includes(String(args.layer))) invalidPackArgument('Invalid memory layer');
        if (args.includeHistory !== undefined && typeof args.includeHistory !== 'boolean') invalidPackArgument('Invalid memory history flag');
        if (args.includeEvidence !== undefined && typeof args.includeEvidence !== 'boolean') invalidPackArgument('Invalid memory evidence flag');
        if (args.includeEvidence === true && !args.id) invalidPackArgument('Select a memory id before requesting its original evidence');
        if (args.asOf !== undefined && (typeof args.asOf !== 'string' || !Number.isFinite(Date.parse(args.asOf)))) invalidPackArgument('Invalid memory validity time');
        return args;
      },
      async execute(args, port) {
        const id = args.id as string | undefined, includeEvidence = args.includeEvidence as boolean | undefined;
        const scope = scopedRange(port, args);
        const search = {
          includeHistory: id ? true : args.includeHistory as boolean | undefined,
          asOf: args.asOf as string | undefined,
          layer: id ? undefined : (args.layer ?? 'memory') as 'observation' | 'memory',
          query: args.query as string | undefined,
          tier: args.tier as 'episode' | 'consolidated' | undefined,
          kind: args.kind as 'episodic' | 'semantic' | 'procedural' | undefined,
        };
        port.assertCurrent();
        const result = await port.read('memories', {...scope, id, ...search, includeEvidence}) ?? {items: []};
        port.assertCurrent();
        const references = Array.isArray(result.references) ? result.references : [];
        const evidence = Array.isArray(result.evidence)
          ? result.evidence.filter(record => inScope(record, scope)).slice(0, 30).map(record => ({
            id: record.id, capturedAt: record.capturedAt, appName: record.appName, characters: String(record.ocrText ?? '').length,
          }))
          : [];
        const sourceEvidence: ContextRecord[] = [];
        if (includeEvidence === true && Array.isArray(result.items) && result.items.length) {
          const allowed = new Set(references.map(reference => reference.id));
          for (const span of (result.sourceSpans ?? []).slice(0, 3)) {
            const record = span.record, at = sourceContentTime(record);
            if (!allowed.has(record.id) || !Number.isFinite(Date.parse(at)) || !Number.isSafeInteger(span.offset) || span.offset < 0 ||
              !Number.isSafeInteger(span.length) || span.length < 1 || span.offset >= record.ocrText.length || !inScope(record, scope)) continue;
            sourceEvidence.push(originalEvidenceReceipt(record, span.offset, Math.min(span.length, 2000), timeZone));
          }
        }
        const partial = result.sourceCoverage?.partial === true || sourceEvidence.length < references.length ||
          (result.sourceSpans ?? []).length > sourceEvidence.length || (result.sourceSpans ?? []).some(span => span.length > 2000);
        const data = {
          items: Array.isArray(result.items) ? withoutSavedQuotes(result.items) : [],
          evidence: [...evidence, ...references],
          ...(includeEvidence === true ? {sourceEvidence, sourceCoverage: {
            references: result.sourceCoverage?.references ?? references.length, delivered: sourceEvidence.length, partial,
          }} : {}),
          coverage: {layer: 'derived_memories', scope: 'selected_summaries_only', originalSearchTool: 'search_context'},
        };
        return {source: 'untrusted_personal_context', data, pagination: {nextCursor: result.nextCursor ?? null}};
      },
    }),
  ]);
}
