import {CONTEXT_TOOLS} from '../../context-tools.js';
import {defineToolDescriptor, type ToolDescriptor, type ToolFields} from '../descriptor.js';
import {invalidPackArgument, scopedRange, type ReadPackInputs} from './materials.js';

function spec(name: string): readonly [string, string, ToolFields] {
  const entry = CONTEXT_TOOLS.find(([candidate]) => candidate === name);
  if (!entry) throw Error(`Missing context-tool schema for ${name}`);
  return entry as unknown as readonly [string, string, ToolFields];
}

function withoutSavedQuotes(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const page = result as {items?: unknown};
  if (!Array.isArray(page.items)) return result;
  return {...result, items: page.items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const entry = item as {evidence?: unknown};
    if (!Array.isArray(entry.evidence)) return item;
    return {...entry, evidence: entry.evidence.map(reference => {
      if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return reference;
      const {quote: _quote, ...rest} = reference as Record<string, unknown>;
      return rest;
    })};
  })};
}

export function createMemoryReadPack(_input: ReadPackInputs = {}): readonly ToolDescriptor[] {
  void _input;
  const memory = spec('memories');
  return Object.freeze([
    defineToolDescriptor({
      apiVersion: '1', name: 'memories', version: '1',
      description: memory[1],
      fields: memory[2], kind: 'derived', exposure: 'native', requires: ['memories'],
      parse(args) {
        if (args.id !== undefined && (typeof args.id !== 'string' || args.id.length > 128)) throw invalidPackArgument('Invalid memory id');
        if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 500)) throw invalidPackArgument('Invalid memory query');
        if (args.tier !== undefined && !['episode', 'consolidated'].includes(String(args.tier))) throw invalidPackArgument('Invalid memory tier');
        if (args.kind !== undefined && !['episodic', 'semantic', 'procedural'].includes(String(args.kind))) throw invalidPackArgument('Invalid memory kind');
        if (args.layer !== undefined && !['observation', 'memory'].includes(String(args.layer))) throw invalidPackArgument('Invalid memory layer');
        if (args.includeHistory !== undefined && typeof args.includeHistory !== 'boolean') throw invalidPackArgument('Invalid memory history flag');
        if (args.includeEvidence !== undefined && typeof args.includeEvidence !== 'boolean') throw invalidPackArgument('Invalid memory evidence flag');
        if (args.includeEvidence === true && !args.id) throw invalidPackArgument('Select a memory id before requesting its original evidence');
        if (args.asOf !== undefined && (typeof args.asOf !== 'string' || !Number.isFinite(Date.parse(args.asOf)))) throw invalidPackArgument('Invalid memory validity time');
        return args;
      },
      async execute(args, port) {
        const result = await port.read('memories', {
          ...scopedRange(port, args),
          id: args.id as string | undefined,
          includeHistory: args.includeHistory as boolean | undefined,
          includeEvidence: args.includeEvidence as boolean | undefined,
          asOf: args.asOf as string | undefined,
          query: args.query as string | undefined,
          layer: args.layer as 'observation' | 'memory' | undefined,
          tier: args.tier as 'episode' | 'consolidated' | undefined,
          kind: args.kind as 'episodic' | 'semantic' | 'procedural' | undefined,
        });
        return result ? withoutSavedQuotes(result) : {items: []};
      },
    }),
  ]);
}
