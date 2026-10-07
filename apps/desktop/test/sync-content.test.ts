import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SyncHistory, captureHistoryItem, sourceHistoryItem } from '../src/sync-history';
import { syncContent } from '../src/sync-content';
import { defaultConfig } from '../src/config';
import { event } from './fixtures';
import type { SourceDefinition, SourceItem } from '../src/source-types';

vi.mock('../src/background', () => ({ previewWork: { run: vi.fn(async () => 'data:image/jpeg;base64,generated') }, sourceWork: { run: vi.fn() } }));
let directory: string, history: SyncHistory;
const config = { ...defaultConfig(), serverUrl: 'http://127.0.0.1:7331', token: 'generated-token', deviceId: event().deviceId };
const queue = { recordForHistory: vi.fn(), imageForBrowser: vi.fn() };
const sources = { pendingForHistory: vi.fn() };
beforeEach(async () => {
  vi.clearAllMocks(); directory = await mkdtemp(join(tmpdir(), 'mote-sync-content-'));
  history = new SyncHistory(join(directory, 'history.sqlite')); await history.initialize();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: event().id, deviceId: config.deviceId, ocrText: 'Generated archived content', metadata: {} }))));
});
afterEach(async () => { history.close(); await rm(directory, { recursive: true, force: true }); vi.unstubAllGlobals(); });
function receipt(received = true) {
  const item = captureHistoryItem({ ...event(), source: 'note', imageMime: undefined });
  const run = history.begin(config, 'manual'); history.attempt(run, [item]); history.settle(run, item.key, received, received ? item.captureId : undefined); history.finish(run);
  return { run, item };
}
const read = (run: string, key: string, offset?: number, connection = config) => syncContent(history, queue as any, sources as any, connection, run, key, offset);

it('reads centrally confirmed content with device authorization and bounded previews', async () => {
  const { run, item } = receipt();
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ id: item.captureId, deviceId: config.deviceId, ocrText: 'x'.repeat(150000) })));
  const result = await read(run, item.key); expect(result.location).toBe('central'); expect(result.text).toHaveLength(100000);
  const [url, init] = vi.mocked(fetch).mock.calls[0];
  expect(url).toBe(`${config.serverUrl}/api/capture-browser/${item.captureId}`);
  expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer generated-token' } });
  expect(queue.recordForHistory).not.toHaveBeenCalled();
});

it('rejects foreign scopes before network access and foreign response identities', async () => {
  const { run, item } = receipt();
  await expect(read(run, item.key, 0, { ...config, deviceId: 'another-device' })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ id: item.captureId, deviceId: 'another-device' })));
  await expect(read(run, item.key)).rejects.toThrow('当前设备');
  await expect(read(run, item.key, -1)).rejects.toThrow('分页');
});

it('returns retained local evidence for failures and resolves a later confirmed retry after cleanup', async () => {
  const { run, item } = receipt(false);
  queue.recordForHistory.mockReturnValueOnce({ event: { ...event(), ocrText: 'Generated local content' } });
  queue.imageForBrowser.mockResolvedValueOnce(undefined);
  expect(await read(run, item.key)).toMatchObject({ location: 'local', text: 'Generated local content' }); expect(fetch).not.toHaveBeenCalled();
  receipt(true); expect(await read(run, item.key)).toMatchObject({ location: 'central', text: 'Generated archived content' });
});

it('preserves receipt status when central content has expired', async () => {
  const { run, item } = receipt(); vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 410 }));
  await expect(read(run, item.key)).rejects.toThrow('清理');
  expect(history.item(config, run, item.key).outcome).toBe('received');
});

it('does not treat an attempted capture ID as a validated receipt after local cleanup', async () => {
  const { run, item } = receipt(false);
  await expect(read(run, item.key)).rejects.toThrow('本机副本');
  expect(fetch).not.toHaveBeenCalled();
});

it('shows notification body from declared metadata and only measured facts for activity', async () => {
  for (const source of ['notification', 'activity'] as const) {
    const item = captureHistoryItem({ ...event(), source });
    const run = history.begin(config, 'manual'); history.attempt(run, [item]); history.settle(run, item.key, true, item.captureId); history.finish(run);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ id: item.captureId, deviceId: config.deviceId, appName: 'Generated app', durationMs: 15000, ocrText: '', metadata: { notification: { title: 'Generated title', text: 'Generated notification' } } })));
    const content = await read(run, item.key);
    if (source === 'notification') expect(content.text).toBe('Generated title\nGenerated notification');
    else expect(JSON.parse(content.text)).toMatchObject({ appName: 'Generated app', durationMs: 15000 });
  }
});

const source: SourceDefinition = { id: 'generated-source', name: 'Generated source', kind: 'local-files', deviceId: config.deviceId, enabled: true, platform: 'macos', retention: 'archive' };
const file: SourceItem = { externalId: 'generated-file', revision: 'generated-revision', title: 'Generated file', text: '', kind: 'file', layer: 'original', observedAt: new Date().toISOString() };
function fileReceipt(item = file, received = true) {
  const metadata = sourceHistoryItem(source, item), run = history.begin(config, 'manual'); history.attempt(run, [metadata]); history.settle(run, metadata.key, received, received ? event().id : undefined); history.finish(run);
  return { run, key: metadata.key };
}
it('reads file chunks by page and distinguishes pending content from an empty completed file', async () => {
  const { run, key } = fileReceipt();
  vi.mocked(fetch).mockImplementation(async url => new Response(JSON.stringify(String(url).includes('/chunks')
    ? { items: [{ ocrText: 'Generated chunk' }], nextOffset: 100 }
    : { id: event().id, deviceId: config.deviceId, fileArchive: {}, provenance: { sourceId: source.id, document: { fileIndex: { status: 'ready' } } } })));
  expect(await read(run, key)).toMatchObject({ text: 'Generated chunk', nextChunkOffset: 100, processing: false });
  // A server must advance its cursor; an unchanged next offset is ignored.
  expect((await read(run, key, 100)).nextChunkOffset).toBeUndefined();
  for (const status of ['ready', 'pending']) {
    vi.mocked(fetch).mockImplementation(async url => new Response(JSON.stringify(String(url).includes('/chunks') ? { items: [] } : { id: event().id, deviceId: config.deviceId, fileArchive: {}, provenance: { sourceId: source.id, document: { fileIndex: { status } } } })));
    expect((await read(run, key)).processing).toBe(status === 'pending');
  }
});
it('previews only the retained source version, never reading the source path', async () => {
  const { run, key } = fileReceipt({ ...file, layer: 'reference' }, false);
  sources.pendingForHistory.mockReturnValueOnce({ ...file, layer: 'reference', text: '' });
  expect(await read(run, key)).toMatchObject({ location: 'local', metadataOnly: true });
  expect(fetch).not.toHaveBeenCalled();
  await expect(read(run, key)).rejects.toThrow('本机副本');
});
