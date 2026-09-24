import { describe, expect, it } from 'vitest';
import { CaptureStageRegistry, builtInCaptureStages } from '../src/capture-stages';
import { SourceAdapterRegistry, type SourceAdapter, type SourceScanContext } from '../src/source-adapters';
import { DEFAULT_SOURCE_OPTIONS, type LocalSource, type SourceScan } from '../src/source-types';
import { event } from './fixtures';

function context(retention: 'reference' | 'snapshot' = 'snapshot'): SourceScanContext {
  const source: LocalSource = { ...DEFAULT_SOURCE_OPTIONS, id: 'local-00000000-0000-4000-8000-000000000001', kind: 'coding-agent', name: 'Synthetic', platform: 'macos', deviceId: 'synthetic', enabled: true, path: '/synthetic', agent: 'codex', retention };
  return { source, signal: new AbortController().signal, priorityPaths: [], fileLocations: new Map(), stateDirectory: '/synthetic', helperPath: '/synthetic', scope: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' } };
}
function adapter(scan: SourceScan): SourceAdapter {
  return { kind: 'coding-agent', version: 1, watchesPath: true, tracksDeletions: false, allowsArchive: false, validateConfiguration() {}, async scan() { return { version: 1, scan }; } };
}

describe('versioned desktop extension boundaries', () => {
  it('rejects duplicate source adapters and reference content before it reaches the durable outbox', async () => {
    const scan: SourceScan = { items: [{ externalId: 'synthetic:1', title: 'Generated', text: 'private fixture', kind: 'message', layer: 'snapshot' }], seen: ['synthetic:1'], complete: true, skipped: 0 };
    const registry = new SourceAdapterRegistry().register(adapter(scan));
    expect(() => registry.register(adapter(scan))).toThrow('duplicate');
    expect(registry.register({ ...adapter(scan), kind: 'plugin.synthetic' }).get('plugin.synthetic').kind).toBe('plugin.synthetic');
    await expect(registry.scan(context('reference'))).rejects.toThrow('Reference source');
    expect((await registry.scan(context())).items).toEqual(scan.items);
  });
  it('keeps state series as a versioned preprocessing stage', () => {
    const stages = builtInCaptureStages();
    expect(stages.versions()).toEqual([{ id: 'state-series', version: 1 }]);
    const base = event(), first = { ...base, source: 'activity' as const, imageMime: undefined, ocrText: undefined, ocr: undefined, durationMs: 0,
      privacy: { excluded: false as const, redacted: false, mode: 'none' as const, collection: 'activity' as const } };
    const committed = stages.consume([{event:first}]);
    const next = stages.consume([{event:{ ...first, id: '00000000-0000-4000-8000-000000000002', capturedAt: new Date(Date.parse(first.capturedAt) + 5000).toISOString() }}], committed.checkpoint);
    expect(next.outputs[0].event.id).toBe(first.id);
    expect(next.outputs[0].event.stateSeries?.samples).toHaveLength(2);
    expect(() => new CaptureStageRegistry().register({ id: 'state-series', version: 1, consume: inputs => ({outputs:[...inputs],held:false}) }).register({ id: 'state-series', version: 2, consume: inputs => ({outputs:[...inputs],held:false}) })).toThrow('duplicate');
  });
});
