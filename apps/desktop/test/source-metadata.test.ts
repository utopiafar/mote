import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAccessMarkers } from '../src/source-atime';
import { scanSourceFiles, observedFileMetadata } from '../src/source-files';
import { SourceSync } from '../src/source-sync';
import { decodeCalendarScan } from '../src/source-calendar';
import { DEFAULT_SOURCE_OPTIONS, type SourceScan } from '../src/source-types';
let directory: string;
beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'mote-file-metadata-'))); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const fixtureStat = (atimeMs: number, extra: object = {}) => ({ dev: 1, ino: 2, size: 20, birthtimeMs: 100, ctimeMs: 500, mtimeMs: 400, atimeMs, ...extra }) as Stats;
describe('observed file and calendar timestamps', () => {
  it('persists self-read atime markers across restart while reporting external changes as new observations', async () => {
    const path = join(directory, 'markers.json');
    let markers = new FileAccessMarkers(path); await markers.initialize();
    expect(markers.record('file:fixture', fixtureStat(1000), fixtureStat(2000))).toBe(1000); await markers.persist(true);
    markers = new FileAccessMarkers(path); await markers.initialize();
    expect(markers.record('file:fixture', fixtureStat(2000), fixtureStat(3000))).toBe(1000); await markers.persist(true);
    markers = new FileAccessMarkers(path); await markers.initialize();
    expect(markers.record('file:fixture', fixtureStat(4000), fixtureStat(5000))).toBe(4000); await markers.persist(true);
    markers = new FileAccessMarkers(path); await markers.initialize();
    expect(markers.record('file:fixture', fixtureStat(5000, { ino: 3 }), fixtureStat(6000, { ino: 3 }))).toBe(5000);
    expect(await readFile(path, 'utf8')).not.toContain('file:fixture');
  });
  it('separates birth, mtime, pre-read access and metadata-change times without creating versions for its own reads', async () => {
    const path = join(directory, 'fixture.md'); const markers = join(directory, '.markers.json');
    await writeFile(path, '合成元数据'); await utimes(path, new Date('2020-01-02T03:04:05Z'), new Date('2021-02-03T04:05:06Z'));
    const before = await stat(path);
    const scan = await scanSourceFiles(path, DEFAULT_SOURCE_OPTIONS, undefined, markers); const file = scan.items[0];
    expect(file.modifiedAt).toBe(before.mtime.toISOString()); expect(file.metadata?.file).toEqual({ sizeBytes: before.size, ...(Number.isFinite(before.birthtimeMs) && before.birthtimeMs > 0 && before.birthtimeMs !== before.ctimeMs ? { createdAt: new Date(before.birthtimeMs).toISOString() } : {}), accessedAt: new Date(before.atimeMs).toISOString(), metadataChangedAt: new Date(before.ctimeMs).toISOString() });
    const second = await scanSourceFiles(path, DEFAULT_SOURCE_OPTIONS, undefined, markers); expect(second.items).toEqual(scan.items);
    const engine = new SourceSync(join(directory, '.state.json')); await engine.initialize();
    expect(await engine.stage(scan, false)).toBe(1); expect(await engine.stage(second, false)).toBe(0);
    await utimes(path, new Date('2022-03-04T05:06:07Z'), before.mtime);
    const changed = await scanSourceFiles(path, DEFAULT_SOURCE_OPTIONS, undefined, markers);
    expect(changed.items[0].text).toBe(file.text); expect(changed.items[0].modifiedAt).toBe(file.modifiedAt); expect(changed.items[0].metadata?.file?.accessedAt).toBe('2022-03-04T05:06:07.000Z'); expect(await engine.stage(changed, false)).toBe(1);
  });
  it('only records deletion observation time after a complete scan and retains actual last file modification time', async () => {
    const path = join(directory, 'fixture.md'); await writeFile(path, 'synthetic original');
    const first = await scanSourceFiles(path, DEFAULT_SOURCE_OPTIONS); const enginePath = join(directory, '.state.json'); const engine = new SourceSync(enginePath); await engine.initialize(); await engine.stage(first, true);
    const absent: SourceScan = { items: [], seen: [], complete: false, skipped: 1 }; expect(await engine.stage(absent, true)).toBe(0);
    const observedAt = '2026-09-14T02:00:00Z'; expect(await engine.stage({ ...absent, complete: true }, true, observedAt)).toBe(1);
    const tombstone = JSON.parse(await readFile(enginePath, 'utf8')).pending.at(-1); expect(tombstone.deleted).toBe(true); expect(tombstone.metadata.file.deletionObservedAt).toBe(observedAt); expect(tombstone.modifiedAt).toBe(first.items[0].modifiedAt);
    expect(await engine.stage({ ...absent, complete: true }, true, '2026-09-15T02:00:00Z')).toBe(0);
  });
  it('keeps provider creation/update dates distinct from event occurrence times and validates unsupported values', () => {
    const event = { id: 'synthetic', title: 'fixture', text: '', start: '2026-09-14T01:00:00Z', end: '2026-09-14T02:00:00Z', allDay: false, status: 'confirmed', createdAt: '2020-01-01T00:00:00Z', modifiedAt: '2021-01-01T00:00:00Z' };
    const scope = { start: event.start, end: event.end };
    const scan = decodeCalendarScan({ permission: 'granted', complete: true, events: [event] }, DEFAULT_SOURCE_OPTIONS, scope);
    expect(scan.items[0].metadata?.provider).toEqual({ createdAt: event.createdAt, updatedAt: event.modifiedAt }); expect(scan.items[0].calendar?.start).toBe(event.start);
    expect(() => decodeCalendarScan({ permission: 'granted', complete: true, events: [{ ...event, createdAt: 'invalid' }] }, DEFAULT_SOURCE_OPTIONS, scope)).toThrow('格式无效');
  });
});

it('does not relabel ctime/epoch fallback or invalid creation time as a known birth time', () => {
  for (const birthtimeMs of [0, NaN, 500]) expect(observedFileMetadata(fixtureStat(1000, { birthtimeMs }), 1000)).not.toHaveProperty('createdAt');
  expect(observedFileMetadata(fixtureStat(1000), 1000).createdAt).toBe(new Date(100).toISOString());
});
