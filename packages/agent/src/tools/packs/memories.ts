import {defineToolDescriptor, type ToolDescriptor} from '../descriptor.js';
import {invalidPackArgument, rangeFields, scopedRange, type ReadPackInputs} from './materials.js';

const memoryFields = {
  ...rangeFields,
  cursor: {type: 'string'},
  includeHistory: {type: 'boolean'},
  includeEvidence: {type: 'boolean', description: 'With id only: include bounded, host-verified supporting original ranges for citation.'},
  asOf: {type: 'string'},
  query: {type: 'string', description: 'Literal full-text search terms. Chinese and English are supported; reformulate when needed.'},
  layer: {type: 'string', enum: ['observation', 'memory']},
  tier: {type: 'string', enum: ['episode', 'consolidated']},
  kind: {type: 'string', enum: ['episodic', 'semantic', 'procedural']},
  id: {type: 'string', description: 'Memory id from a previous overview'},
};

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

export function createMemoriesPack(_input: ReadPackInputs = {}): readonly ToolDescriptor[] {
  return Object.freeze([
    defineToolDescriptor({
      apiVersion: '1', name: 'memories', version: '1',
      description: 'Selected durable memories by default; set layer=observation on demand for task breadcrumbs and source/event summaries (what was requested, evidenced outcome and artifact/evidence locator). For daily recall of what appeared, was browsed or done, use layer=observation with explicit local-day after/before bounds and paginate. Event histories preserve displayed/browsed, planned, unpaid, paid, completed, cancelled and unknown outcomes without promoting them to owner preferences or article endorsement. Verify original proof where needed; incomplete capture/processing does not establish a complete day. Observations do not establish personal preferences. Progressive memory disclosure: omit id for short memory cards; pass a discovered id for its statement, uncertainty and original supporting evidence identifiers and read costs. Set includeEvidence=true with that id to receive up to three bounded original supporting ranges whose current permissions, fingerprint and quote were verified by the host. Only delivered sourceEvidence ranges are citable using their original record ids; a memory id or saved locator is never an original citation. Check sourceCoverage.partial and textRange before deciding whether deeper evidence reads are needed. Reuse sufficient delivered ranges without rereading them. Effective memories are model-derived and may be subjective or scoped, never independent facts. Current valid memories are returned by default. Set includeHistory=true to inspect superseded/expired history, or asOf to select validity at an ISO instant. Relations and versions describe unresolved conflicts or changes applied after model review and host validation. A correction/supersession replaces only the specified memory claim within its explicit scope, not every fact in its original source. Other original facts and uncertainty remain independently valid; inspect the original quotes before describing what was replaced. Stale memories are excluded. This searches selected derived summaries only. When no supporting memory is found, use search_context to search the original archive; a memory miss does not mean original evidence is absent.',
      fields: memoryFields, kind: 'derived', exposure: 'native', requires: ['memories'],
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

export const memoriesPack = createMemoriesPack;
