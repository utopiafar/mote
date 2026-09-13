import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableQueue } from '../src/queue';
import type { NsfwGate } from '../src/contracts';
import { defaultConfig } from '../src/config';

const mocks = vi.hoisted(() => ({ capture: vi.fn(), active: vi.fn(), ocr: vi.fn(), idle: vi.fn(), permission: vi.fn(), power: vi.fn() }));
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
    powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleTime: mocks.idle }),
    screen: { getPrimaryDisplay: () => ({ id: 1, size: { width: 4, height: 4 } }) },
    systemPreferences: { getMediaAccessStatus: mocks.permission },
  };
});
vi.mock('../src/native', () => ({ activeApplication: mocks.active, recognizeText: mocks.ocr, readPowerState: mocks.power }));

import { Collector } from '../src/collector';
import { nativeImage, powerMonitor } from 'electron';

let directory: string;
let collector: Collector | undefined;
const application = { appId: 'dev.mote.fixture', appName: 'Generated Fixture', pid: 1, visibleAppIds: ['dev.mote.fixture'], unknownVisibleWindows: false };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mote-pipeline-test-'));
  vi.clearAllMocks();
  mocks.idle.mockReturnValue(0); mocks.permission.mockReturnValue('granted');
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
