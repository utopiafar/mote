import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableQueue } from '../src/queue';
import type { NsfwGate } from '../src/contracts';
import { defaultConfig } from '../src/config';
import { captureAck } from './fixtures';

const fixtureConfig=()=>({...defaultConfig(),syncMode:'realtime' as const,syncIntervalMinutes:15,syncBatchSize:20,packedUpload:false});

const mocks = vi.hoisted(() => ({ page: vi.fn(), capture: vi.fn(), foreground: vi.fn(), metadata: vi.fn(), idleState: vi.fn(), active: vi.fn(), ocr: vi.fn(), idle: vi.fn(), permission: vi.fn(), power: vi.fn() }));
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
vi.mock('../src/native', () => ({ runHelper:mocks.page, activeApplication: mocks.active, foregroundApplication: mocks.foreground, recognizeText: mocks.ocr, readPowerState: mocks.power }));

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
  collector?.stop(); await collector?.settleCapture(); collector?.shutdown();
  // Background encoders add async boundaries; wait for the final uploader before removing fixture files.
  if (collector) { const release = await collector.holdConnection(); release(); }
  collector = undefined;
  (powerMonitor as unknown as EventEmitter).removeAllListeners();
  await rm(directory, { recursive: true, force: true }); vi.unstubAllGlobals();
});
async function makeCollector(extra: object = {}, gate?: NsfwGate) {
  const config = { ...fixtureConfig(), token: 'synthetic-token', nsfwEnabled: false, ...extra };
  const queue = new DurableQueue(directory, config); await queue.initialize();
  collector = new Collector(config, queue, '/fixture/no-real-helper', () => true, () => undefined, gate);
  return { collector, queue };
}

it('one manual flush drains 400 historical notes while admitting a new note between source upload slices',async()=>{
 const {event}=await import('./fixtures'),config={...fixtureConfig(),token:'synthetic-token',syncMode:'manual' as const,packedUpload:true};
 const queue=new DurableQueue(directory,config);await queue.initialize();
 const note=(i:number,capturedAt:string)=>({...event(`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`),source:'note' as const,imageMime:undefined,durationMs:0,ocrText:'Generated note '+i,capturedAt,privacy:{excluded:false as const,redacted:false,mode:'none' as const}});
 for(let i=0;i<400;i++)await queue.enqueue(note(i,new Date(Date.UTC(2025,0,1+i)).toISOString()));
 const sent:string[]=[],phases:string[]=[];let sourcePending=1;
 vi.mocked(fetch).mockImplementation(async (_url,init)=>{const body=JSON.parse(await new Response(init!.body).text()),items=body.captures??[body];sent.push(...items.map((v:{id:string})=>v.id));phases.push('captures');return new Response(JSON.stringify(body.captures?{results:items.map((v:{id:string})=>({...captureAck(v.id),status:201}))}:captureAck(body.id)),{status:body.captures?200:201});});
 const fresh=note(999,new Date().toISOString());
 const sources={nodeBinding:{unbound:()=>false},pendingStats:()=>({pendingRecords:sourcePending,eligibleRecords:sourcePending}),flushPending:async(_signal:AbortSignal,between:()=>Promise<void>)=>{
   phases.push('source-part-0');fresh.capturedAt=new Date().toISOString();await queue.enqueue(fresh);await between();
   expect(sent).toContain(fresh.id);expect(sent.indexOf(fresh.id)).toBe(25);phases.push('source-part-1');await between();sourcePending=0;
 }};
 collector=new Collector(config,queue,'/fixture/no-real-helper',()=>true,()=>undefined,undefined,undefined,undefined,sources as any);
 await collector.upload(true);expect(queue.stats().depth).toBe(0);expect(new Set(sent).size).toBe(401);expect(phases.slice(0,4)).toEqual(['captures','source-part-0','captures','source-part-1']);expect(collector.status().sync.pendingRecords).toBe(0);
},30000);

describe.skipIf(process.platform !== 'darwin')('collector pipeline with generated pixels and mocked native APIs', () => {
  it('applies masks before OCR, disk queue and network payload, without ever persisting source pixels', async () => {
    const { collector, queue } = await makeCollector({ uploadGate:{enabled:true,blockedText:['never-matches'],failureAction:'hold'},masks: [{ x: 0, y: 0, width: 1, height: 0.5 }] });
    await collector.start(); await collector.settleCapture();
    const archive = await queue.exportArchive();
    expect(archive.records).toHaveLength(1);
    const stored = Buffer.from(Object.values(archive.blobs)[0], 'base64');
    const pixels = await sharp(stored).removeAlpha().raw().toBuffer();
    for (const value of pixels.subarray(0, 24)) expect(value).toBeLessThan(12);
    for (const value of pixels.subarray(24)) expect(Math.abs(value - 123)).toBeLessThan(12);
    expect(mocks.ocr.mock.calls[0][1]).toEqual(stored);
    expect(archive.records[0].event).not.toHaveProperty('windowTitle');
    expect(archive.records[0].event.durationMs).toBe(0);
    const call = vi.mocked(fetch).mock.calls.find(args => String(args[0]).endsWith('/api/captures'));
    expect(call).toBeDefined();
    expect(JSON.parse(await new Response(call![1]!.body).text()).imageBase64).toBe(stored.toString('base64'));
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
  it('does not invoke legacy local visual review endpoints', async () => {
    const fakeFetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/review') ? { allow: true } : {}), { status: 200 }));
    vi.stubGlobal('fetch', fakeFetch);
    const { collector, queue } = await makeCollector({ privacyModelUrl: 'http://127.0.0.1:8787/review' });
    await collector.start(); await collector.settleCapture();
    expect(mocks.ocr).not.toHaveBeenCalled();
    expect(fakeFetch.mock.calls.some(args => args[0].includes('/review'))).toBe(false);
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
  it.each(['deny', 'failure'])('holds legacy Qwen execution even when its stored setting is enabled (%s)', async outcome => {
    const gate = { ensureReady: async () => {}, status: () => undefined, reset: () => {}, close: () => {}, classify: vi.fn(async () => { if (outcome === 'failure') throw new Error('synthetic inference timeout'); return { allow: false, blocked: true }; }) } as unknown as NsfwGate;
    const { collector, queue } = await makeCollector({ nsfwEnabled: true, masks: [{ x: 0, y: 0, width: 1, height: 1 }] }, gate);
    await collector.start(); await collector.settleCapture();
    expect(queue.stats().depth).toBe(1); expect(mocks.ocr).not.toHaveBeenCalled();expect(gate.classify).not.toHaveBeenCalled();
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
    const { collector, queue } = await makeCollector({ appCollectionRules: { 'dev.restricted': mode === 'unknown' ? 'off' : mode } });
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
      const changed = { ...fixtureConfig(), token: 'synthetic-token', nsfwEnabled: false, defaultCollection: 'content' as const }; collector.updateConfig(changed); now += 15000; await collector.start(); await collector.settleCapture();
      const events = (await queue.exportArchive()).records.map(r => r.event);
      expect(events.flatMap(e=>e.stateSeries?.samples.map(s=>s.durationMs)??[e.durationMs])).toEqual([0,15000,0,0]);expect(events.map(e=>e.source)).toEqual(['activity','screen']);
    } finally { clock.mockRestore(); }
  });
  it('does not send metadata when disabled, and preserves the opted-in stored record after settings change', async () => {
    const { collector, queue } = await makeCollector({ defaultCollection: 'activity', metadataEnabled: false });
    await collector.start(); await collector.settleCapture();
    const record = (await queue.exportArchive()).records[0].event; expect(record).not.toHaveProperty('metadata'); expect(mocks.metadata).not.toHaveBeenCalled();
    collector.stop(); const changed = { ...fixtureConfig(), token: 'synthetic-token', defaultCollection: 'off' as const }; collector.updateConfig(changed);
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

describe.skipIf(process.platform !== 'darwin')('deferred OCR from sanitized durable images', () => {
  it('leaves new screenshots for central OCR even when legacy local options are set', async () => {
    const { collector, queue } = await makeCollector({ ocrEnabled:true, ocrOnlyWhileCharging: true, metadataEnabled: false, syncMode: 'manual' });
    await collector.start(); await collector.settleCapture(); collector.stop();
    const original = (await queue.exportArchive()).records[0].event;
    expect(original.ocr).toEqual({ status: 'disabled' });
    expect(original.metadata).toBeUndefined(); expect(original.ocrText).toBe(''); expect(mocks.ocr).not.toHaveBeenCalled();
    mocks.power.mockResolvedValue({ onBattery: false, charging: false });
    await collector.processPendingOcr();
    const result = (await queue.exportArchive()).records[0];
    expect(result.event).toEqual(original); expect(result.ocrResult).toBeUndefined();
    expect(collector.status().running).toBe(false); expect(mocks.capture).toHaveBeenCalledTimes(1);
  });
  it('ACKs the immutable screenshot before OCR patching and keeps the image until the patch ACK', async () => {
    const { event, image } = await import('./fixtures');
    const { collector, queue } = await makeCollector({ ocrEnabled:true, ocrOnlyWhileCharging: true, syncMode: 'manual' });
    const original = { ...event(), ocrText: undefined, ocr: { status: 'pending' as const, reason: 'charging' as const } };
    await queue.enqueue(original, image);
    const calls: { url: string; body: any }[] = [];
    vi.mocked(fetch).mockImplementation(async (url, init) => { calls.push({ url: String(url), body: JSON.parse(await new Response(init!.body).text()) }); return new Response(JSON.stringify(String(url).endsWith('/ocr')?{id:original.id}:captureAck(original.id)), { status: 200 }); });
    await collector.retry();
    expect(queue.stats()).toMatchObject({ depth: 1, eligibleDepth: 0, waitingOcr: 1 }); expect(await queue.next()).toBeUndefined();
    expect(await queue.imageForBrowser(original.id)).toEqual(image);
    mocks.power.mockResolvedValue({ onBattery: false }); await collector.processPendingOcr();
    expect((await queue.exportArchive()).records[0].event).toEqual(original);
    await collector.retry();
    expect(queue.stats().depth).toBe(0);
    const captureCall = calls.find(c => c.url.endsWith('/api/captures'))!;
    expect(captureCall.body.ocr.status).toBe('pending'); expect(captureCall.body.ocrText).toBeUndefined();
    const patch = calls.find(c => c.url.endsWith(`/api/capture-browser/${original.id}/ocr`))!;
    expect(patch.body).toEqual({ status: 'completed', ocrText: 'GENERATED SANITIZED TEXT' });
  });
  it('aborts backfill when unplugged without losing the saved screenshot or original ID', async () => {
    const { event, image } = await import('./fixtures'); const { collector, queue } = await makeCollector({ ocrEnabled:true, ocrOnlyWhileCharging: true, syncMode: 'manual' });
    const original = { ...event(), ocrText: undefined, ocr: { status: 'pending' as const, reason: 'charging' as const } }; await queue.enqueue(original, image);
    mocks.power.mockResolvedValue({ onBattery: false });
    mocks.ocr.mockImplementationOnce((_path: string, _image: Buffer, signal: AbortSignal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('fixture unplugged')), { once: true }); }));
    const processing = collector.processPendingOcr(); await vi.waitFor(() => expect(mocks.ocr).toHaveBeenCalled());
    (powerMonitor as unknown as EventEmitter).emit('on-battery'); await processing;
    expect((await queue.exportArchive()).records[0]).toMatchObject({ event: original });
    expect((await queue.exportArchive()).records[0].ocrResult).toBeUndefined(); expect(await queue.imageForBrowser(original.id)).toEqual(image);
  });
  it('restores pending backfill and retries a failing item without starving later images', async () => {
    const { event, image } = await import('./fixtures'); const first = { ...event(), ocrText: undefined, ocr: { status: 'pending' as const } };
    const second = { ...first, id: 'f50650f0-fb31-4215-90cd-c96dc62d5e93' };
    const { queue } = await makeCollector({ syncMode: 'manual' }); await queue.enqueue(first, image); await queue.enqueue(second, image); await queue.acknowledge(first.id); await queue.acknowledge(second.id);
    collector!.shutdown();
    const cfg = { ...fixtureConfig(), ocrEnabled:true,token: 'synthetic-token', syncMode: 'manual' as const };
    const restored = new DurableQueue(directory, cfg); await restored.initialize();
    collector = new Collector(cfg, restored, '/fixture/no-real-helper', () => true, () => undefined);
    mocks.ocr.mockRejectedValueOnce(new Error('synthetic OCR failure')).mockResolvedValue('SECOND FIXTURE');
    await collector.processPendingOcr(); await collector.processPendingOcr();
    const records = (await restored.exportArchive()).records;
    expect(records[0].ocrRetryAt).toBeGreaterThan(Date.now()); expect(records[0].ocrResult).toBeUndefined(); expect(records[1].ocrResult).toBe('SECOND FIXTURE');
  });
  it('blocks automatic OCR retries when the central record is gone, retaining a visible local copy', async () => {
    const { event, image } = await import('./fixtures'); const { collector, queue } = await makeCollector();
    const original = { ...event(), ocrText: undefined, ocr: { status: 'pending' as const } };
    await queue.enqueue(original, image); await queue.acknowledge(original.id); await queue.saveOcr(original.id, 'FIXTURE TEXT');
    vi.mocked(fetch).mockResolvedValue(new Response('{"error":"capture_not_found"}', { status: 404 }));
    await collector.upload(true); expect(queue.stats().blocked).toBe(1); expect(await queue.next()).toBeUndefined();
    const attempts = vi.mocked(fetch).mock.calls.length; await collector.upload(); expect(vi.mocked(fetch).mock.calls).toHaveLength(attempts);
    expect((await queue.exportArchive()).records[0].syncError).toContain('中央已删除'); expect(await queue.imageForBrowser(original.id)).toEqual(image);
  });
  it('blocks a permanent OCR conflict but still uploads later healthy records in the same flush', async () => {
    const { event, image } = await import('./fixtures'); const { collector, queue } = await makeCollector({ syncMode: 'manual' });
    const original = { ...event(), ocrText: undefined, ocr: { status: 'pending' as const } };
    const later = { ...event('f50650f0-fb31-4215-90cd-c96dc62d5e93'), capturedAt: new Date(Date.parse(original.capturedAt) + 1000).toISOString() };
    await queue.enqueue(original, image); await queue.acknowledge(original.id); await queue.saveOcr(original.id, 'DIFFERENT OCR'); await queue.enqueue(later, image);
    vi.mocked(fetch).mockImplementation(async (url, init) => String(url).endsWith('/ocr') ? new Response('{}', { status: 409 }) : new Response(JSON.stringify(captureAck(JSON.parse(await new Response(init!.body).text()).id)), { status: 200 }));
    await collector.upload(true);
    expect(queue.contains(original.id)).toBe(true); expect(queue.contains(later.id)).toBe(false); expect(queue.stats().blocked).toBe(1);
    expect((await queue.exportArchive()).records[0].syncError).toContain('保留中央原文字');
  });
});

describe.skipIf(process.platform !== 'darwin')('desktop and missing foreground under default privacy policy', () => {
  it('captures an unidentified foreground and window when no application is restricted', async () => {
    const unknown = { appId: 'dev.mote.unknown-foreground', appName: '无前台应用', pid: 0 };
    mocks.foreground.mockResolvedValue(unknown); mocks.active.mockResolvedValue({ ...unknown, visibleAppIds: [], unknownVisibleWindows: true });
    const { collector, queue } = await makeCollector({ syncMode: 'manual' }); await collector.start(); await collector.settleCapture();
    expect(queue.stats().depth).toBe(1); expect(mocks.capture).toHaveBeenCalledTimes(1);
  });
  it('still refuses missing foreground when any user application restriction might apply', async () => {
    mocks.foreground.mockResolvedValue({ appId: 'dev.mote.unknown-foreground', appName: '无前台应用', pid: 0 });
    const { collector, queue } = await makeCollector({ excludedAppIds: ['dev.private'] }); await collector.start(); await collector.settleCapture();
    expect(queue.stats().depth).toBe(0); expect(mocks.capture).not.toHaveBeenCalled();
  });
});

describe('capture and synchronization are independent', () => {
  it('leaves offline and manual queues untouched until an explicit configured sync, including heartbeats', async () => {
    const { event, image } = await import('./fixtures');
    const { collector, queue } = await makeCollector({ syncMode: 'manual' });
    await queue.enqueue({ ...event(), capturedAt: new Date().toISOString() }, image);
    await collector.upload(); await (collector as any).sendHeartbeat();
    expect(fetch).not.toHaveBeenCalled(); expect(collector.status().sync).toMatchObject({ state: 'manual', pendingRecords: 1 });
    vi.mocked(fetch).mockImplementation(async (_url, init) => new Response(JSON.stringify(captureAck(JSON.parse(await new Response(init!.body).text()).id)), { status: 201 }));
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
    const config = { ...fixtureConfig(), token: 'synthetic-token', nsfwEnabled: false, syncMode: 'batch' as const, syncBatchSize: 2 };
    const queue = new DurableQueue(directory, config); await queue.initialize(); const capturedAt = new Date().toISOString();
    await queue.enqueue({ ...event(), capturedAt }, image);
    let sourcePending = 1;
    const flush = vi.fn(async () => { sourcePending = 0; });
    const sources = { pendingStats: () => ({ pendingRecords: sourcePending, oldestPendingAt: capturedAt, hasUpdates: false }), nodeBinding: { unbound: () => false }, flushPending: flush };
    collector = new Collector(config, queue, '/fixture/no-real-helper', () => true, () => undefined, undefined, undefined, undefined, sources as any);
    vi.mocked(fetch).mockImplementation(async (_url, init) => new Response(JSON.stringify(captureAck(JSON.parse(await new Response(init!.body).text()).id)), { status: 201 }));
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
  const config = { ...fixtureConfig(), token: 'synthetic-token', syncMode: 'interval' as const };
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
  const config = { ...fixtureConfig(), token: 'synthetic-aggregate-token' };
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
  const config = { ...fixtureConfig(), token: 'synthetic-held-source-token' };
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
    return new Response(JSON.stringify(captureAck(JSON.parse(await new Response(init!.body).text()).id)), { status: 201 });
  });
  await expect(collector.retry()).resolves.toBeUndefined(); expect(queue.stats().depth).toBe(0);
  expect(collector.status().lastUploadError).toBeUndefined(); expect(collector.status().lastUploadAt).toBeDefined();
});

describe.skipIf(process.platform !== 'darwin')('immediate settings with generated capture only', () => {
  it('cancels a stalled central heartbeat before applying local settings', async () => {
    const {collector}=await makeCollector({metadataEnabled:false});
    let requestSignal:AbortSignal|undefined;
    vi.stubGlobal('fetch',vi.fn((_url,init)=>new Promise((_resolve,reject)=>{
      requestSignal=init.signal;requestSignal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
    })));
    const heartbeat=(collector as any).sendHeartbeat(true);
    await vi.waitFor(()=>expect(requestSignal).toBeDefined());
    const hold=collector.suspendForSettings();
    await vi.waitFor(()=>expect(requestSignal!.aborted).toBe(true),{timeout:500});
    const release=await hold;await heartbeat;expect(collector.connectionActivity().inFlight).toBe(false);
    collector.updateConfig({...fixtureConfig(),serverUrl:'',token:undefined,nsfwEnabled:false});await release();
  });

  it('waits for an old capture, discards it, applies the new mask and timer, then resumes only prior running intent', async () => {
    let release!: (value: unknown) => void;
    mocks.capture.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const { collector, queue } = await makeCollector({ syncMode: 'manual' });
    await collector.start(); await vi.waitFor(() => expect(release).toBeDefined());
    let held = false; const holding = collector.suspendForSettings().then(releaseHold => { held = true; return releaseHold; });
    await new Promise(resolve => setTimeout(resolve, 35)); expect(held).toBe(false);
    release([{ display_id: '1', thumbnail: nativeImage.createFromBitmap(Buffer.alloc(64, 77), { width: 4, height: 4 }) }]);
    const resume = await holding; expect(queue.stats().depth).toBe(0); expect(collector.status().running).toBe(false);
    const config = { ...fixtureConfig(), serverUrl: '', token: undefined, nsfwEnabled: false, syncMode: 'manual' as const, intervalMs: 300000, masks: [{ x: 0, y: 0, width: 1, height: 1 }] };
    collector.updateConfig(config); await resume(); await collector.settleCapture();
    expect(collector.status().running).toBe(true);
    const stored = Object.values((await queue.exportArchive()).blobs).map(value => Buffer.from(value, 'base64')); expect(stored).toHaveLength(1);
    expect([...(await sharp(stored[0]).removeAlpha().raw().toBuffer())].every(value => value === 0)).toBe(true);
    expect((collector as unknown as { timer: { _idleTimeout: number } }).timer._idleTimeout).toBeGreaterThan(290000);
    await resume(); expect(mocks.capture).toHaveBeenCalledTimes(2);
  });
  it.each(['stopped', 'stop during save', 'shutdown during save'])('does not auto-start when %s', async mode => {
    const { collector } = await makeCollector({ syncMode: 'manual', defaultCollection: 'off' });
    if (mode !== 'stopped') { await collector.start(); await collector.settleCapture(); }
    const resume = await collector.suspendForSettings();
    if (mode === 'stop during save') collector.stop();
    if (mode === 'shutdown during save') collector.shutdown();
    else collector.updateConfig({ ...fixtureConfig(), serverUrl: '', nsfwEnabled: false });
    await resume(); expect(collector.status().running).toBe(false); expect(mocks.capture).not.toHaveBeenCalled();
    if (mode === 'shutdown during save') { await expect(collector.start()).rejects.toThrow(); await collector.upload(true); await collector.retry(); expect(vi.mocked(fetch).mock.calls.filter(args => String(args[0]).includes('/api/captures'))).toHaveLength(0); }
  });
  it('holds OCR/upload across settings and permits pending OCR to continue after release even while capture stays stopped', async () => {
    const { collector, queue } = await makeCollector({ ocrEnabled:true,syncMode: 'manual', ocrOnlyWhileCharging: true });
    const { event, image } = await import('./fixtures');
    await queue.enqueue({ ...event(), ocrText: undefined, ocr: { status: 'pending', reason: 'charging' } }, image);
    mocks.power.mockResolvedValue({ onBattery: false });
    const resume = await collector.suspendForSettings();
    await collector.processPendingOcr(); await collector.upload(true); expect(mocks.ocr).not.toHaveBeenCalled();
    await resume(); await vi.waitFor(async () => expect((await queue.exportArchive()).records[0].ocrResult).toBe('GENERATED SANITIZED TEXT'));
    expect(collector.status().running).toBe(false); expect(mocks.capture).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== 'darwin')('exact deduplication with generated images', () => {
  it.each(['off', 'exact'])('honors %s mode and never merges different applications', async mode => {
    const { collector, queue } = await makeCollector({ syncMode: 'manual', imageDedupeMode: mode });
    await collector.start(); await collector.settleCapture();
    clearTimeout((collector as any).timer); await (collector as any).capture();
    expect(queue.stats().depth).toBe(mode === 'exact' ? 1 : 2);
    mocks.active.mockResolvedValue({ ...application, appId: 'dev.mote.other' });
    mocks.foreground.mockResolvedValue({ ...application, appId: 'dev.mote.other' });
    clearTimeout((collector as any).timer); await (collector as any).capture();
    expect(queue.stats().depth).toBe(mode === 'exact' ? 2 : 3);
  });
});

const pageRule={id:'generated-page',version:'1',platform:'macos',appId:application.appId,select:{role:'AXStaticText'},required:[],complete:true};
const pageSnapshot={appId:application.appId,appVersion:'fixture',activity:'',truncated:false,nodes:[{id:'1',role:'AXStaticText',resourceId:'fixture-body',text:'GENERATED PAGE BODY',bounds:{x:0,y:0,width:100,height:20}}]};
describe.skipIf(process.platform!=='darwin')('UI page collection privacy and screenshot decisions',()=>{
 it('stores a complete page with no screenshot permission, image or OCR; survives restart',async()=>{
  mocks.page.mockResolvedValue({snapshot:pageSnapshot});mocks.permission.mockReturnValue('denied');
  const {collector,queue}=await makeCollector({syncMode:'manual',uiPageMode:'ui_preferred',uiPageRules:[pageRule]});await collector.start();await collector.settleCapture();
  const archive=await queue.exportArchive();expect(archive.records).toHaveLength(1);expect(archive.blobs).toEqual({});expect(archive.records[0].event.source).toBe('ui_page');expect(archive.records[0].event.ocrText).toBe('GENERATED PAGE BODY');
  expect(mocks.capture).not.toHaveBeenCalled();expect(mocks.ocr).not.toHaveBeenCalled();
  const reopened=new DurableQueue(directory,fixtureConfig());await reopened.initialize();expect((await reopened.next())?.record.event.metadata?.uiPage?.adapterId).toBe(pageRule.id);
 });
 it.each(['off','activity'])('does not read nodes for %s privacy',async collection=>{
  const {collector}=await makeCollector({uiPageMode:'hybrid',uiPageRules:[pageRule],appCollectionRules:{[application.appId]:collection}});await collector.start();await collector.settleCapture();expect(mocks.page).not.toHaveBeenCalled();
 });
 it('never falls back to pixels after a page privacy rejection',async()=>{
  mocks.page.mockResolvedValue({snapshot:pageSnapshot});const {collector,queue}=await makeCollector({uiPageMode:'hybrid',uiPageRules:[pageRule],uploadGate:{enabled:true,blockedText:['GENERATED'],failureAction:'hold'}});await collector.start();await collector.settleCapture();expect(mocks.capture).not.toHaveBeenCalled();expect(queue.stats().depth).toBe(0);
 });
 it('rejects a foreground switch after node reading',async()=>{
  mocks.page.mockImplementation(async()=>{mocks.foreground.mockResolvedValue({...application,appId:'other'});return {snapshot:pageSnapshot};});const {collector,queue}=await makeCollector({uiPageMode:'hybrid',uiPageRules:[pageRule]});await collector.start();await collector.settleCapture();expect(queue.stats().depth).toBe(0);expect(mocks.capture).not.toHaveBeenCalled();
 });
 it.each(['ui_preferred','hybrid'])('keeps screenshots for partial pages in %s',async mode=>{
  mocks.page.mockResolvedValue({snapshot:pageSnapshot});const {collector,queue}=await makeCollector({uiPageMode:mode,uiPageRules:[{...pageRule,complete:false}]});await collector.start();await collector.settleCapture();expect(mocks.capture).toHaveBeenCalledTimes(1);expect((await queue.exportArchive()).records.map(r=>r.event.source).sort()).toEqual(['screen','ui_page']);
 });
 it('page_only does not capture pixels for unsupported pages',async()=>{
  mocks.page.mockResolvedValue({status:'unsupported'});const {collector,queue}=await makeCollector({uiPageMode:'page_only',uiPageRules:[pageRule]});await collector.start();await collector.settleCapture();expect(mocks.capture).not.toHaveBeenCalled();expect(queue.stats().depth).toBe(0);
 });
});
