import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableQueue } from '../src/queue';
import type { NsfwGate } from '../src/contracts';
import { defaultConfig } from '../src/config';

const mocks = vi.hoisted(() => ({ capture: vi.fn(), foreground: vi.fn(), metadata: vi.fn(), idleState: vi.fn(), active: vi.fn(), ocr: vi.fn(), idle: vi.fn(), permission: vi.fn(), power: vi.fn() }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class GeneratedImage {
    constructor(readonly pixels: Buffer) {}
    getSize() { return { width: 4, height: 4 }; }
    isEmpty() { return false; }
    toBitmap() { return Buffer.from(this.pixels); }
    toJPEG() { return Buffer.concat([Buffer.from([0xff, 0xd8]), this.pixels, Buffer.from([0xff, 0xd9])]); }
  }
  return {
    desktopCapturer: { getSources: mocks.capture },
    nativeImage: { createFromBitmap: (buffer: Buffer) => new GeneratedImage(buffer) },
    powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleTime: mocks.idle, getSystemIdleState: mocks.idleState }),
    screen: { getPrimaryDisplay: () => ({ id: 1, size: { width: 4, height: 4 }, scaleFactor: 2 }) },
    systemPreferences: { getMediaAccessStatus: mocks.permission },
  };
});
vi.mock('../src/native', () => ({ activeApplication: mocks.active, foregroundApplication: mocks.foreground, recognizeText: mocks.ocr, readPowerState: mocks.power }));

vi.mock('../src/record-metadata', () => ({ collectRecordMetadata: mocks.metadata }));

import { Collector } from '../src/collector';
import { nativeImage, powerMonitor } from 'electron';

let directory: string;
let collector: Collector | undefined;
const application = { appId: 'dev.mote.fixture', appName: 'Generated Fixture', pid: 1, visibleAppIds: ['dev.mote.fixture'], unknownVisibleWindows: false };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mote-pipeline-test-'));
  vi.clearAllMocks();
  mocks.idle.mockReturnValue(0); mocks.idleState.mockReturnValue('active');
  mocks.foreground.mockResolvedValue({ appId: application.appId, appName: application.appName, pid: application.pid });
  mocks.metadata.mockResolvedValue({ version: 1, observedAt: '2026-09-14T01:00:00Z', collector: { version: 'synthetic' }, device: { osVersion: 'synthetic' }, state: { screenLocked: false } }); mocks.permission.mockReturnValue('granted');
  mocks.power.mockResolvedValue({ onBattery: true, batteryPercent: 50, charging: false });
  mocks.active.mockResolvedValue(application); mocks.ocr.mockResolvedValue('GENERATED SANITIZED TEXT');
  const generated = nativeImage.createFromBitmap(Buffer.alloc(64, 123), { width: 4, height: 4 });
  mocks.capture.mockResolvedValue([{ display_id: '1', thumbnail: generated }]);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/captures')) throw new Error('fixture offline');
    return new Response('{}', { status: 200 });
  }));
});
afterEach(async () => {
  collector?.stop(); await collector?.settleCapture(); collector?.shutdown(); collector = undefined;
  (powerMonitor as unknown as EventEmitter).removeAllListeners();
  await rm(directory, { recursive: true, force: true }); vi.unstubAllGlobals();
});
async function makeCollector(extra: object = {}, gate?: NsfwGate) {
  const config = { ...defaultConfig(), token: 'synthetic-token', nsfwEnabled: false, ...extra };
  const queue = new DurableQueue(directory, config); await queue.initialize();
  collector = new Collector(config, queue, '/fixture/no-real-helper', () => true, () => undefined, gate);
  return { collector, queue };
}

describe.skipIf(process.platform !== 'darwin')('collector pipeline with generated pixels and mocked native APIs', () => {
  it('applies masks before OCR, disk queue and network payload, without ever persisting source pixels', async () => {
    const { collector, queue } = await makeCollector({ masks: [{ x: 0, y: 0, width: 1, height: 0.5 }] });
    await collector.start(); await collector.settleCapture();
    const archive = await queue.exportArchive();
    expect(archive.records).toHaveLength(1);
    const stored = Buffer.from(Object.values(archive.blobs)[0], 'base64');
    const pixels = stored.subarray(2, -2);
    for (let i = 0; i < 32; i += 4) expect([...pixels.subarray(i, i + 4)]).toEqual([0, 0, 0, 255]);
    expect(pixels.subarray(32)).toEqual(Buffer.alloc(32, 123));
    expect(mocks.ocr.mock.calls[0][1]).toEqual(stored);
    expect(archive.records[0].event).not.toHaveProperty('windowTitle');
    expect(archive.records[0].event.durationMs).toBe(0);
    const call = vi.mocked(fetch).mock.calls.find(args => String(args[0]).endsWith('/api/captures'));
    expect(call).toBeDefined();
    expect(JSON.parse(call![1]!.body as string).imageBase64).toBe(stored.toString('base64'));
  });
  it('never requests screenshot pixels when an excluded app is visible behind the foreground app', async () => {
    mocks.active.mockResolvedValue({ ...application, visibleAppIds: ['dev.mote.fixture', 'dev.private'] });
    const { collector, queue } = await makeCollector({ excludedAppIds: ['dev.private'] });
    await collector.start(); await collector.settleCapture();
    expect(mocks.capture).not.toHaveBeenCalled(); expect(queue.stats().depth).toBe(0);
  });
  it('discards the image if visible app identities change around screenshot acquisition', async () => {
    mocks.active.mockResolvedValueOnce(application).mockResolvedValueOnce({ ...application, visibleAppIds: ['dev.mote.fixture', 'dev.other'] });
    const { collector, queue } = await makeCollector();
    await collector.start(); await collector.settleCapture();
    expect(mocks.capture).toHaveBeenCalledTimes(1); expect(mocks.ocr).not.toHaveBeenCalled(); expect(queue.stats().depth).toBe(0);
  });
  it('fails closed on malformed local-model approval before OCR and upload', async () => {
    const fakeFetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/review') ? { allow: true } : {}), { status: 200 }));
    vi.stubGlobal('fetch', fakeFetch);
    const { collector, queue } = await makeCollector({ privacyModelUrl: 'http://127.0.0.1:8787/review' });
    await collector.start(); await collector.settleCapture();
    expect(queue.stats().depth).toBe(0); expect(mocks.ocr).not.toHaveBeenCalled();
    expect(fakeFetch.mock.calls.some(args => args[0].endsWith('/api/captures'))).toBe(false);
  });
  it('pauses before capture while idle or locked and stops clearly if permissions are revoked', async () => {
    mocks.idle.mockReturnValue(301);
    const { collector, queue } = await makeCollector();
    await collector.start(); await collector.settleCapture();
    expect(mocks.capture).not.toHaveBeenCalled(); expect(queue.stats().depth).toBe(0);
    expect(collector.status().state).toBe('paused');
    (powerMonitor as unknown as EventEmitter).emit('lock-screen');
    expect(collector.status().message).toContain('锁定');
    collector.stop();
    expect(collector.status().running).toBe(false);
  });
  it.each(['deny', 'failure'])('does not OCR or persist images rejected by Qwen (%s)', async outcome => {
    const gate = { ensureReady: async () => {}, status: () => undefined, reset: () => {}, close: () => {}, classify: vi.fn(async () => { if (outcome === 'failure') throw new Error('synthetic inference timeout'); return { allow: false, blocked: true }; }) } as unknown as NsfwGate;
    const { collector, queue } = await makeCollector({ nsfwEnabled: true, masks: [{ x: 0, y: 0, width: 1, height: 1 }] }, gate);
    await collector.start(); await collector.settleCapture();
    expect(queue.stats().depth).toBe(0); expect(mocks.ocr).not.toHaveBeenCalled();
    const supplied = vi.mocked(gate.classify).mock.calls[0][0].bitmap;
    expect([...supplied.subarray(0, 4)]).toEqual([0,0,0,255]);
  });

  it('only pauses on battery when the user explicitly enables that optimization', async () => {
    const { collector, queue } = await makeCollector({ pauseOnBattery: true });
    await collector.start(); await collector.settleCapture();
    expect(mocks.power).toHaveBeenCalled(); expect(mocks.capture).not.toHaveBeenCalled(); expect(queue.stats().depth).toBe(0);
    expect(collector.status().message).toContain('电量暂停');
  });

});

describe.skipIf(process.platform !== 'darwin')('per-application collection boundaries', () => {
  it('records activity without any screenshot, window enumeration, OCR, permission prompt or model even when screen access is denied', async () => {
    mocks.permission.mockReturnValue('denied');
    const gate = { ensureReady: vi.fn(async () => { throw new Error('model absent'); }), status: () => undefined, reset: () => {}, close: () => {}, classify: vi.fn() } as unknown as NsfwGate;
    const { collector, queue } = await makeCollector({ nsfwEnabled: true, appCollectionRules: { [application.appId]: 'activity' } }, gate);
    await collector.start(); await collector.settleCapture();
    const archive = await queue.exportArchive(); expect(archive.records).toHaveLength(1); expect(archive.blobs).toEqual({});
    const event = archive.records[0].event;
    expect(event.source).toBe('activity'); expect(event.privacy.collection).toBe('activity'); expect(event.metadata?.capture).toEqual({ intervalMs: 15000 });
    for (const key of ['ocrText', 'title', 'windowTitle', 'imageMime', 'imageBase64', 'mood', 'provenance']) expect(event).not.toHaveProperty(key);
    expect(mocks.capture).not.toHaveBeenCalled(); expect(mocks.active).not.toHaveBeenCalled(); expect(mocks.ocr).not.toHaveBeenCalled(); expect(gate.ensureReady).not.toHaveBeenCalled(); expect(gate.classify).not.toHaveBeenCalled();
  });
  it.each(['off', 'legacy exclusion', 'unknown'])('records nothing for %s without reading content', async mode => {
    if (mode === 'unknown') mocks.foreground.mockRejectedValue(new Error('identity unavailable'));
    const { collector, queue } = await makeCollector({ defaultCollection: mode === 'off' ? 'off' : 'content', excludedAppIds: mode === 'legacy exclusion' ? [application.appId] : [] });
    await collector.start(); await collector.settleCapture();
    expect(queue.stats().depth).toBe(0); expect(mocks.capture).not.toHaveBeenCalled(); expect(mocks.active).not.toHaveBeenCalled(); expect(mocks.ocr).not.toHaveBeenCalled();
  });
  it.each(['activity', 'off', 'unknown'])('skips mixed-screen %s windows without downgrading to activity', async mode => {
    mocks.active.mockResolvedValue({ ...application, visibleAppIds: [application.appId, 'dev.restricted'], unknownVisibleWindows: mode === 'unknown' });
    const { collector, queue } = await makeCollector({ appCollectionRules: mode === 'unknown' ? {} : { 'dev.restricted': mode } });
    await collector.start(); await collector.settleCapture();
    expect(queue.stats().depth).toBe(0); expect(mocks.capture).not.toHaveBeenCalled();
  });
  it('breaks duration continuity across content/activity modes and unrecorded foreground apps', async () => {
    const { collector, queue } = await makeCollector({ defaultCollection: 'activity', appCollectionRules: { 'dev.off': 'off' } });
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await collector.start(); await collector.settleCapture();
      const sample = async () => { clearTimeout((collector as any).timer); now += 15000; await (collector as any).capture(); };
      await sample();
      mocks.foreground.mockResolvedValue({ appId: 'dev.off', appName: 'Off fixture', pid: 2 }); await sample();
      mocks.foreground.mockResolvedValue(application); await sample();
      collector.stop(); await collector.settleCapture();
      const changed = { ...defaultConfig(), token: 'synthetic-token', nsfwEnabled: false, defaultCollection: 'content' as const }; collector.updateConfig(changed); now += 15000; await collector.start(); await collector.settleCapture();
      const events = (await queue.exportArchive()).records.map(r => r.event);
      expect(events.map(e => e.durationMs)).toEqual([0, 15000, 0, 0]); expect(events.map(e => e.source)).toEqual(['activity','activity','activity','screen']);
    } finally { clock.mockRestore(); }
  });
  it('does not send metadata when disabled, and preserves the opted-in stored record after settings change', async () => {
    const { collector, queue } = await makeCollector({ defaultCollection: 'activity', metadataEnabled: false });
    await collector.start(); await collector.settleCapture();
    const record = (await queue.exportArchive()).records[0].event; expect(record).not.toHaveProperty('metadata'); expect(mocks.metadata).not.toHaveBeenCalled();
    collector.stop(); const changed = { ...defaultConfig(), token: 'synthetic-token', defaultCollection: 'off' as const }; collector.updateConfig(changed);
    expect((await queue.exportArchive()).records[0].event).toEqual(record);
  });
  it('permission loss pauses only content and the next explicitly activity app still records', async () => {
    mocks.permission.mockReturnValue('denied');
    const { collector, queue } = await makeCollector({ appCollectionRules: { 'dev.activity': 'activity' } });
    await collector.start(); await collector.settleCapture(); expect(collector.status().state).toBe('permission_required'); expect(collector.status().running).toBe(true);
    mocks.foreground.mockResolvedValue({ appId: 'dev.activity', appName: 'Activity fixture', pid: 2 }); clearTimeout((collector as any).timer); await (collector as any).capture();
    expect(queue.stats().depth).toBe(1); expect(mocks.capture).not.toHaveBeenCalled(); expect(mocks.active).not.toHaveBeenCalled();
  });
});

describe('capture and synchronization are independent', () => {
  it('leaves offline and manual queues untouched until an explicit configured sync, including heartbeats', async () => {
    const { event, image } = await import('./fixtures');
    const { collector, queue } = await makeCollector({ syncMode: 'manual' });
    await queue.enqueue({ ...event(), capturedAt: new Date().toISOString() }, image);
    await collector.upload(); await (collector as any).sendHeartbeat();
    expect(fetch).not.toHaveBeenCalled(); expect(collector.status().sync).toMatchObject({ state: 'manual', pendingRecords: 1 });
    vi.mocked(fetch).mockImplementation(async (_url, init) => new Response(JSON.stringify({ id: JSON.parse(init!.body as string).id }), { status: 201 }));
    await collector.retry(); expect(queue.stats().depth).toBe(0); expect(fetch).toHaveBeenCalledTimes(2);
    const finalHeartbeat = JSON.parse(vi.mocked(fetch).mock.calls.at(-1)![1]!.body as string);
    expect(finalHeartbeat.sync).toMatchObject({ mode: 'manual', state: 'idle', pendingRecords: 0 });
    expect(finalHeartbeat.sync).not.toHaveProperty('message');
    expect(collector.status().running).toBe(false); expect(collector.status().sync.state).toBe('manual');
  });
  it('does not attempt any network request with an empty URL or token and preserves queued notes/screens', async () => {
    const { event, image } = await import('./fixtures');
    const { collector, queue } = await makeCollector({ serverUrl: '', token: undefined });
    await queue.enqueue(event(), image); await collector.upload(); await collector.retry(); await (collector as any).sendHeartbeat();
    expect(fetch).not.toHaveBeenCalled(); expect(queue.stats().depth).toBe(1);
    expect(collector.status().sync).toMatchObject({ state: 'unconfigured', localBacklogUnbound: true, pendingRecords: 1 });
  });
  it('counts source versions with screenshots for one batch decision and drains both channels', async () => {
    const { event, image } = await import('./fixtures');
    const config = { ...defaultConfig(), token: 'synthetic-token', nsfwEnabled: false, syncMode: 'batch' as const, syncBatchSize: 2 };
    const queue = new DurableQueue(directory, config); await queue.initialize(); const capturedAt = new Date().toISOString();
    await queue.enqueue({ ...event(), capturedAt }, image);
    let sourcePending = 1;
    const flush = vi.fn(async () => { sourcePending = 0; });
    const sources = { pendingStats: () => ({ pendingRecords: sourcePending, oldestPendingAt: capturedAt, hasUpdates: false }), nodeBinding: { unbound: () => false }, flushPending: flush };
    collector = new Collector(config, queue, '/fixture/no-real-helper', () => true, () => undefined, undefined, undefined, undefined, sources as any);
    vi.mocked(fetch).mockImplementation(async (_url, init) => new Response(JSON.stringify({ id: JSON.parse(init!.body as string).id }), { status: 201 }));
    await collector.upload(); expect(fetch).toHaveBeenCalledTimes(1); expect(flush).toHaveBeenCalledTimes(1);
    expect(collector.status().sync).toMatchObject({ pendingRecords: 0, state: 'idle' });
  });
  it.skipIf(process.platform !== 'darwin')('captures generated activity locally before any URL or token is configured', async () => {
    const { collector, queue } = await makeCollector({ serverUrl: '', token: undefined, defaultCollection: 'activity' });
    await collector.start(); await collector.settleCapture();
    expect(queue.stats().depth).toBe(1); expect(collector.status().running).toBe(true); expect(fetch).not.toHaveBeenCalled();
  });
});
it('releases metadata-only source updates at their interval deadline while record count stays zero', async () => {
  const config = { ...defaultConfig(), token: 'synthetic-token', syncMode: 'interval' as const };
  const queue = new DurableQueue(directory, config); await queue.initialize();
  const initial = Date.now(); let now = initial; let pendingUpdates = 1;
  const flush = vi.fn(async () => { pendingUpdates = 0; });
  const sources = { pendingStats: () => ({ pendingRecords: 0, pendingUpdates, oldestUpdateAt: new Date(initial).toISOString(), hasUpdates: Boolean(pendingUpdates) }), nodeBinding: { unbound: () => false }, flushPending: flush };
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    collector = new Collector(config, queue, '/fixture/no-real-helper', () => true, () => undefined, undefined, undefined, undefined, sources as any);
    await collector.upload(); expect(flush).not.toHaveBeenCalled(); expect(collector.status().sync).toMatchObject({ state: 'waiting', pendingRecords: 0 });
    now += 15 * 60000; await collector.upload(); expect(flush).toHaveBeenCalledTimes(1); expect(collector.status().sync.state).toBe('idle');
  } finally { clock.mockRestore(); }
});
it('caps only the heartbeat aggregate at the wire limit while local status keeps the full pending count', async () => {
  const config = { ...defaultConfig(), token: 'synthetic-aggregate-token' };
  const queue = new DurableQueue(directory, config); await queue.initialize();
  const sources = { pendingStats: () => ({ pendingRecords: 1_000_020, pendingUpdates: 0, hasUpdates: false }), nodeBinding: { unbound: () => false } };
  collector = new Collector(config, queue, '/fixture/no-real-helper', () => true, () => undefined, undefined, undefined, undefined, sources as any);
  expect(collector.status().sync.pendingRecords).toBe(1_000_020);
  await (collector as any).sendHeartbeat();
  const call = vi.mocked(fetch).mock.calls.find(args => String(args[0]).endsWith('/api/devices/heartbeat'));
  expect(call).toBeDefined();
  expect(JSON.parse(call![1]!.body as string).sync.pendingRecords).toBe(1_000_000);
  expect(collector.status().sync.pendingRecords).toBe(1_000_020);
});
it('keeps held source records in local totals without repeatedly announcing or attempting uploads', async () => {
  const config = { ...defaultConfig(), token: 'synthetic-held-source-token' };
  const queue = new DurableQueue(directory, config); await queue.initialize(); const flush = vi.fn(); const statuses: any[] = [];
  const sources = { pendingStats: () => ({ pendingRecords: 4, eligibleRecords: 0, heldRecords: 4, pendingUpdates: 0, eligibleUpdates: 0, heldUpdates: 0, hasUpdates: false, heldReason: '本地来源已暂停，待传版本保留在本机' }), nodeBinding: { unbound: () => false }, flushPending: flush };
  collector = new Collector(config, queue, '/fixture/no-real-helper', () => true, status => statuses.push(status), undefined, undefined, undefined, sources as any);
  await collector.upload(); await collector.upload();
  expect(flush).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  expect(collector.status().sync).toMatchObject({ state: 'waiting', pendingRecords: 4, message: '本地来源已暂停，待传版本保留在本机' });
  expect(statuses.some(status => status.sync.state === 'uploading')).toBe(false);
});
it('does not reinterpret failed final heartbeats as failed or missing record uploads', async () => {
  const { event, image } = await import('./fixtures'); const { collector, queue } = await makeCollector({ syncMode: 'manual' });
  await queue.enqueue(event(), image);
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/heartbeat')) throw new Error('synthetic heartbeat outage');
    return new Response(JSON.stringify({ id: JSON.parse(init!.body as string).id }), { status: 201 });
  });
  await expect(collector.retry()).resolves.toBeUndefined(); expect(queue.stats().depth).toBe(0);
  expect(collector.status().lastUploadError).toBeUndefined(); expect(collector.status().lastUploadAt).toBeDefined();
});
