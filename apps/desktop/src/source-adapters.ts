import { join } from 'node:path';
import { sourceWork } from './background';
import { scanSourceFiles } from './source-files';
import { calendarHelper, decodeCalendarScan } from './source-calendar';
import { readSourceEvidence } from './file-evidence';
import type { CodingCheckpoint } from './coding-agents';
import type { LocalFileCheckpoint, LocalSource, SourceCheckpoint, SourceScan } from './source-types';

/** Adapter output is internal. The host owns policy, the durable outbox and transport. */
export interface SourceEmission { version: 1; scan: SourceScan }
export interface SourceScanContext {
  source: LocalSource;
  signal: AbortSignal;
  checkpoint?: SourceCheckpoint;
  fileCheckpoint?: LocalFileCheckpoint;
  priorityPaths: string[];
  fileLocations: Map<string, string>;
  stateDirectory: string;
  helperPath: string;
  scope: { start: string; end: string };
}
export interface SourceAdapter {
  readonly kind: LocalSource['kind'];
  readonly version: number;
  readonly watchesPath: boolean;
  readonly tracksDeletions: boolean;
  readonly allowsArchive: boolean;
  validateConfiguration(source: LocalSource): void;
  scan(context: SourceScanContext): Promise<SourceEmission>;
  readEvidence?(source: LocalSource, request: import('@mote/shared').FileReadRequest, locations: Map<string, string>, signal: AbortSignal): Promise<unknown>;
}

export class SourceAdapterRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();
  register(adapter: SourceAdapter): this {
    if (!/^[a-z][a-z0-9-]{0,63}(?:\.[a-z][a-z0-9-]{0,63})*$/.test(adapter.kind) || !Number.isSafeInteger(adapter.version) || adapter.version < 1 || this.adapters.has(adapter.kind)) throw new Error('Invalid or duplicate source adapter');
    this.adapters.set(adapter.kind, adapter);
    return this;
  }
  get(kind: LocalSource['kind']): SourceAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`Source adapter unavailable: ${kind}`);
    return adapter;
  }
  async scan(context: SourceScanContext): Promise<SourceScan> {
    const adapter = this.get(context.source.kind);
    adapter.validateConfiguration(context.source);
    const result = await adapter.scan(context);
    if (result.version !== 1 || !result.scan || !Array.isArray(result.scan.items) || !Array.isArray(result.scan.seen) || typeof result.scan.complete !== 'boolean') throw new Error('Invalid source adapter emission');
    // The host is the final privacy boundary before an adapter's data enters the outbox.
    for (const item of result.scan.items) {
      if (context.source.retention === 'reference' && (item.text !== '' || item.layer !== 'reference')) throw new Error('Reference source emitted content');
      if (context.source.retention !== 'archive' && item.layer === 'original') throw new Error('Source emitted an unauthorized original');
    }
    return result.scan;
  }
}

export function builtInSourceAdapters(): SourceAdapterRegistry {
  return new SourceAdapterRegistry()
    .register({ kind: 'coding-agent', version: 1, watchesPath: true, tracksDeletions: false, allowsArchive: false,
      validateConfiguration(source) { if (typeof source.path !== 'string' || !['claude', 'codex', 'kimi'].includes(source.agent ?? '')) throw new Error('Invalid coding agent source'); },
      async scan({ source, checkpoint }) {
        const scan = await sourceWork.run<SourceScan>({ kind: 'coding-scan', root: source.path!, provider: source.agent!, options: source, checkpoint: checkpoint as CodingCheckpoint | undefined });
        return { version: 1, scan };
      } })
    .register({ kind: 'local-files', version: 1, watchesPath: true, tracksDeletions: true, allowsArchive: true,
      validateConfiguration(source) { if (typeof source.path !== 'string') throw new Error('Invalid file source'); },
      readEvidence: readSourceEvidence,
      async scan({ source, signal, stateDirectory, fileLocations, fileCheckpoint, priorityPaths }) {
        const scan = await scanSourceFiles(source.path!, source, signal, join(stateDirectory, 'access-markers', source.id + '.json'), fileLocations, fileCheckpoint, priorityPaths, true);
        return { version: 1, scan };
      } })
    .register({ kind: 'local-calendar', version: 1, watchesPath: false, tracksDeletions: true, allowsArchive: false,
      validateConfiguration(source) { if (typeof source.calendarId !== 'string' || source.retention === 'archive') throw new Error('Invalid calendar source'); },
      async scan({ source, signal, helperPath, scope }) {
        const raw = await calendarHelper(helperPath, 'calendar-scan', { calendarId: source.calendarId, ...scope, includeText: source.retention !== 'reference' }, signal);
        return { version: 1, scan: decodeCalendarScan(raw, source, scope) };
      } });
}
