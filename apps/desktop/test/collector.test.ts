import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableQueue } from '../src/queue';
import { defaultConfig } from '../src/config';
import { captureAck } from './fixtures';
import { SyncHistory } from '../src/sync-history';
import * as localContent from '../src/local-content';
import {imageWork} from '../src/background';

const off={duration:false,screenshots:false,structured:false};
const activity={...off,duration:true};
const content={...off,screenshots:true};
const fixtureConfig=()=>({...defaultConfig(),defaultCollection:content,syncMode:'realtime' as const,syncIntervalMinutes:15,syncBatchSize:20,packedUpload:false});

const mocks = vi.hoisted(() => ({ notifications: vi.fn(), page: vi.fn(), capture: vi.fn(), foreground: vi.fn(), metadata: vi.fn(), idleState: vi.fn(), active: vi.fn(), ocr: vi.fn(), idle: vi.fn(), permission: vi.fn(), power: vi.fn() }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class GeneratedImage {
    constructor(readonly pixels: Buffer,readonly width=4,readonly height=4) {}
    getSize() { return {width:this.width,height:this.height}; }
    crop(region:{x:number;y:number;width:number;height:number}) {const pixels=Buffer.alloc(region.width*region.height*4);for(let y=0;y<region.height;y++)this.pixels.copy(pixels,y*region.width*4,((y+region.y)*this.width+region.x)*4,((y+region.y)*this.width+region.x+region.width)*4);return new GeneratedImage(pixels,region.width,region.height);}
    isEmpty() { return false; }
    toBitmap() { return Buffer.from(this.pixels); }
    toJPEG() { return Buffer.concat([Buffer.from([0xff, 0xd8]), this.pixels, Buffer.from([0xff, 0xd9])]); }
  }
  return {
    desktopCapturer: { getSources: mocks.capture },
    nativeImage: { createFromBitmap: (buffer: Buffer,options:{width:number;height:number}) => new GeneratedImage(buffer,options.width,options.height) },
    powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleTime: mocks.idle, getSystemIdleState: mocks.idleState }),
    screen: { getPrimaryDisplay: () => ({ id: 1, size: { width: 4, height: 4 }, bounds:{x:0,y:0,width:4,height:4}, scaleFactor: 2 }) },
    systemPreferences: { getMediaAccessStatus: mocks.permission },
  };
});
vi.mock('../src/native', () => ({ readVisibleNotifications:mocks.notifications, runHelper:mocks.page, activeApplication: mocks.active, foregroundApplication: mocks.foreground, recognizeText: mocks.ocr, readPowerState: mocks.power }));

vi.mock('../src/record-metadata', () => ({ collectRecordMetadata: mocks.metadata }));

import { Collector } from '../src/collector';
import { nativeImage, powerMonitor } from 'electron';

let directory: string;
let collector: Collector | undefined;
let syncHistory: SyncHistory | undefined;
const application = { appId: 'dev.mote.fixture', appName: 'Generated Fixture', pid: 1, visibleAppIds: ['dev.mote.fixture'], unknownVisibleWindows: false };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mote-pipeline-test-'));
  vi.clearAllMocks(); mocks.notifications.mockResolvedValue([]);
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
  syncHistory?.close(); syncHistory = undefined;
  (powerMonitor as unknown as EventEmitter).removeAllListeners();
  await rm(directory, { recursive: true, force: true }); vi.unstubAllGlobals();
});
async function makeCollector(extra: object = {}) {
  const config = { ...fixtureConfig(), token: 'synthetic-token', ...extra };
  const queue = new DurableQueue(directory, config); await queue.initialize();
  collector = new Collector(config, queue, '/fixture/no-real-helper', () => true, () => undefined);
  return { collector, queue };
}

it('records partial capture results and deduplicates a manual retry through the real collector', async () => {
  const { event } = await import('./fixtures');
  const config = { ...fixtureConfig(), token: 'generated-token', syncMode: 'manual' as const, packedUpload: true };
  const queue = new DurableQueue(directory, config); await queue.initialize();
  const notes = [0, 1].map(i => ({ ...event(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`), deviceId: config.deviceId, source: 'note' as const, imageMime: undefined, durationMs: 0, privacy: { excluded: false as const, redacted: false, mode: 'none' as const } }));
  for (const note of notes) await queue.enqueue(note);
  syncHistory = new SyncHistory(join(directory, 'history.sqlite')); await syncHistory.initialize();
  collector = new Collector(config, queue, '/fixture/no-real-helper', () => true, () => undefined, undefined, undefined, undefined, syncHistory);
  let first = true;
  vi.mocked(fetch).mockImplementation(async (_url, init) => {
    const body = JSON.parse(await new Response(init!.body).text());
    const results = body.captures.map((item: { id: string }, index: number) => first && index === 1 ? { id: item.id, status: 503 } : { ...captureAck(item.id), status: 201 }); first = false;
    return new Response(JSON.stringify({ results }));
  });
  await collector.upload(true);
  const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  expect(syncHistory.page(config, { day })).toMatchObject({ total: 1, received: 1, items: [expect.objectContaining({ outcome: 'partial' })] });
  expect(queue.stats().depth).toBe(1);
  // Explicit retry also clears the transport backoff while preserving the old receipt.
  await collector.retry();
  expect(syncHistory.page(config, { day })).toMatchObject({ total: 2, received: 2 });
  expect(queue.stats().depth).toBe(0);
});

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
 collector=new Collector(config,queue,'/fixture/no-real-helper',()=>true,()=>undefined,undefined,undefined,sources as any);
 await collector.upload(true);expect(queue.stats().depth).toBe(0);expect(new Set(sent).size).toBe(401);expect(phases.slice(0,4)).toEqual(['captures','source-part-0','captures','source-part-1']);expect(collector.status().sync.pendingRecords).toBe(0);
// This fixture performs 401 durable writes and ACKs; keep disk latency out of the ordering contract.
},120000);

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
    const { collector, queue } = await makeCollector({ appCollectionRules: {'dev.private': off} });
    await collector.start(); await collector.settleCapture();
    expect(mocks.capture).not.toHaveBeenCalled(); expect(queue.stats().depth).toBe(0);
  });
  it('discards the image if visible app identities change around screenshot acquisition', async () => {
    mocks.active.mockResolvedValueOnce(application).mockResolvedValueOnce({ ...application, visibleAppIds: ['dev.mote.fixture', 'dev.other'] });
    const { collector, queue } = await makeCollector();
    await collector.start(); await collector.settleCapture();
    expect(mocks.capture).toHaveBeenCalledTimes(1); expect(mocks.ocr).not.toHaveBeenCalled(); expect(queue.stats().depth).toBe(0);
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
  it('only pauses on battery when the user explicitly enables that optimization', async () => {
    const { collector, queue } = await makeCollector({ pauseOnBattery: true });
    await collector.start(); await collector.settleCapture();
    expect(mocks.power).toHaveBeenCalled(); expect(mocks.capture).not.toHaveBeenCalled(); expect(queue.stats().depth).toBe(0);
    expect(collector.status().message).toContain('电量暂停');
  });

});

describe.skipIf(process.platform !== 'darwin')('capture recovery after screen unlock and wake', () => {
  it.each([
    ['lock-screen', 'unlock-screen', content],
    ['suspend', 'resume', content],
    ['lock-screen', 'unlock-screen', activity],
    ['suspend', 'resume', activity],
  ] as const)('resumes immediately after %s/%s with %j without retaining the pause message', async (pause, resume, collection) => {
    const { collector, queue } = await makeCollector({ intervalMs: 300000, syncMode: 'manual', defaultCollection: collection });
    await collector.start(); await collector.settleCapture();
    (powerMonitor as unknown as EventEmitter).emit(pause);
    expect(collector.status().state).toBe('paused');
    (powerMonitor as unknown as EventEmitter).emit(resume);
    await collector.settleCapture();
    expect(queue.stats().depth).toBe(2);
    expect(collector.status()).toMatchObject({ running: true, state: 'capturing' });
    expect(collector.status().message).not.toMatch(/暂停|锁定|休眠/);
  });

  it.each(['idle', 'battery', 'system-lock'])('rechecks the %s pause condition on unlock', async condition => {
    mocks.power.mockResolvedValue({ onBattery: false, batteryPercent: 50, charging: true });
    const { collector, queue } = await makeCollector({ syncMode: 'manual', pauseOnBattery: condition === 'battery' });
    await collector.start(); await collector.settleCapture();
    const power = powerMonitor as unknown as EventEmitter;
    power.emit('lock-screen');
    if (condition === 'idle') mocks.idle.mockReturnValue(301);
    else if (condition === 'battery') mocks.power.mockResolvedValue({ onBattery: true, batteryPercent: 50, charging: false });
    else mocks.idleState.mockReturnValue('locked');
    power.emit('unlock-screen'); await collector.settleCapture();
    expect(collector.status()).toMatchObject({ running: true, state: 'paused' });
    expect(queue.stats().depth).toBe(1);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unlock-screen', 'resume'],
    ['resume', 'unlock-screen'],
  ])('waits for both lock and sleep to clear when %s arrives first', async (first, last) => {
    const { collector, queue } = await makeCollector({ intervalMs: 300000, syncMode: 'manual' });
    await collector.start(); await collector.settleCapture();
    const power = powerMonitor as unknown as EventEmitter;
    power.emit('lock-screen'); power.emit('suspend');
    power.emit(first); await collector.settleCapture();
    expect(queue.stats().depth).toBe(1);
    expect(collector.status().state).toBe('paused');
    power.emit(last); await collector.settleCapture();
    expect(queue.stats().depth).toBe(2);
    expect(collector.status().state).toBe('capturing');
  });

  it('discards a capture interrupted by locking and retries after it drains', async () => {
    let release!: (sources: unknown[]) => void;
    const sources = await mocks.capture(); mocks.capture.mockClear();
    mocks.capture.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const { collector, queue } = await makeCollector({ intervalMs: 300000, syncMode: 'manual' });
    await collector.start();
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledTimes(1));
    const power = powerMonitor as unknown as EventEmitter;
    power.emit('lock-screen'); power.emit('unlock-screen');
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    release(sources);
    await vi.waitFor(() => expect(queue.stats().depth).toBe(1));
    await collector.settleCapture();
    expect(mocks.capture).toHaveBeenCalledTimes(2);
    expect(collector.status().message).not.toMatch(/暂停|锁定|休眠/);
  });

  it.each(['stopped', 'settings', 'shutdown'])('does not restart a %s collector on unlock or wake', async mode => {
    const { collector, queue } = await makeCollector({ syncMode: 'manual' });
    await collector.start(); await collector.settleCapture();
    const power = powerMonitor as unknown as EventEmitter;
    power.emit('lock-screen'); power.emit('suspend');
    let releaseSettings: (() => Promise<void>) | undefined;
    if (mode === 'stopped') collector.stop();
    else if (mode === 'settings') releaseSettings = await collector.suspendForSettings();
    else collector.shutdown();
    try {
      power.emit('resume'); power.emit('unlock-screen');
      await collector.settleCapture();
      expect(collector.status().running).toBe(false);
      expect(queue.stats().depth).toBe(1);
      expect(mocks.capture).toHaveBeenCalledTimes(1);
    } finally {
      if (releaseSettings) { collector.stop(); await releaseSettings(); }
    }
  });
});

describe.skipIf(process.platform !== 'darwin')('per-application collection boundaries', () => {
  it('records activity without any screenshot, window enumeration, OCR, permission prompt or model even when screen access is denied', async () => {
    mocks.permission.mockReturnValue('denied');
    const { collector, queue } = await makeCollector({ appCollectionRules: { [application.appId]: activity } });
    await collector.start(); await collector.settleCapture();
    const archive = await queue.exportArchive(); expect(archive.records).toHaveLength(1); expect(archive.blobs).toEqual({});
    const event = archive.records[0].event;
    expect(event.source).toBe('activity'); expect(event.privacy.collection).toBe('activity'); expect(event.metadata?.capture).toEqual({ intervalMs: 15000 });
    for (const key of ['ocrText', 'title', 'windowTitle', 'imageMime', 'imageBase64', 'mood', 'provenance']) expect(event).not.toHaveProperty(key);
    expect(mocks.capture).not.toHaveBeenCalled(); expect(mocks.active).not.toHaveBeenCalled(); expect(mocks.ocr).not.toHaveBeenCalled();
  });
  it.each(['off', 'explicit off', 'unknown'])('records nothing for %s without reading content', async mode => {
    if (mode === 'unknown') mocks.foreground.mockRejectedValue(new Error('identity unavailable'));
    const { collector, queue } = await makeCollector({ defaultCollection: mode === 'off' ? off : content, appCollectionRules: mode === 'explicit off' ? {[application.appId]:off} : {} });
    await collector.start(); await collector.settleCapture();
    expect(queue.stats().depth).toBe(0); expect(mocks.capture).not.toHaveBeenCalled(); expect(mocks.active).not.toHaveBeenCalled(); expect(mocks.ocr).not.toHaveBeenCalled();
  });
  it.each(['activity', 'off', 'unknown'])('skips mixed-screen %s windows without downgrading to activity', async mode => {
    mocks.active.mockResolvedValue({ ...application, visibleAppIds: [application.appId, 'dev.restricted'], unknownVisibleWindows: mode === 'unknown' });
    const { collector, queue } = await makeCollector({ appCollectionRules: { 'dev.restricted': mode === 'activity' ? activity : off } });
    await collector.start(); await collector.settleCapture();
    expect(queue.stats().depth).toBe(0); expect(mocks.capture).not.toHaveBeenCalled();
  });
  it('breaks duration continuity across content/activity modes and unrecorded foreground apps', async () => {
    const { collector, queue } = await makeCollector({ defaultCollection: activity, appCollectionRules: { 'dev.off': off } });
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await collector.start(); await collector.settleCapture();
      const sample = async () => { clearTimeout((collector as any).timer); now += 15000; await (collector as any).capture(); };
      await sample();
      mocks.foreground.mockResolvedValue({ appId: 'dev.off', appName: 'Off fixture', pid: 2 }); await sample();
      mocks.foreground.mockResolvedValue(application); await sample();
      collector.stop(); await collector.settleCapture();
      const changed = { ...fixtureConfig(), token: 'synthetic-token', defaultCollection: content }; collector.updateConfig(changed); now += 15000; await collector.start(); await collector.settleCapture();
      const events = (await queue.exportArchive()).records.map(r => r.event);
      expect(events.flatMap(e=>e.stateSeries?.samples.map(s=>s.durationMs)??[e.durationMs])).toEqual([0,15000,0,0]);expect(events.map(e=>e.source)).toEqual(['activity','activity','activity','screen']);
    } finally { clock.mockRestore(); }
  });
  it('does not send metadata when disabled, and preserves the opted-in stored record after settings change', async () => {
    const { collector, queue } = await makeCollector({ defaultCollection: activity, metadataEnabled: false });
    await collector.start(); await collector.settleCapture();
    const record = (await queue.exportArchive()).records[0].event; expect(record.metadata).toMatchObject({captureObservation:{selected:activity}}); expect(record.metadata).not.toHaveProperty('device'); expect(mocks.metadata).not.toHaveBeenCalled();
    collector.stop(); const changed = { ...fixtureConfig(), token: 'synthetic-token', defaultCollection: off }; collector.updateConfig(changed);
    expect((await queue.exportArchive()).records[0].event).toEqual(record);
  });
  it('permission loss pauses only content and the next explicitly activity app still records', async () => {
    mocks.permission.mockReturnValue('denied');
    const { collector, queue } = await makeCollector({ appCollectionRules: { 'dev.activity': activity } });
    await collector.start(); await collector.settleCapture(); expect(collector.status().state).toBe('permission_required'); expect(collector.status().running).toBe(true);
    mocks.foreground.mockResolvedValue({ appId: 'dev.activity', appName: 'Activity fixture', pid: 2 }); clearTimeout((collector as any).timer); await (collector as any).capture();
    expect(queue.stats().depth).toBe(1); expect(mocks.capture).not.toHaveBeenCalled(); expect(mocks.active).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== 'darwin')('central OCR capture contract',()=>{
 it('stores new screenshots with local OCR disabled and performs no backfill calls',async()=>{
  const {collector,queue}=await makeCollector({metadataEnabled:false,syncMode:'manual'});await collector.start();await collector.settleCapture();collector.stop();
  const original=(await queue.exportArchive()).records[0].event;expect(original.ocr).toEqual({status:'disabled'});expect(original.ocrText).toBe('');expect(mocks.ocr).not.toHaveBeenCalled();
 });
});
describe.skipIf(process.platform !== 'darwin')('desktop and missing foreground under default privacy policy', () => {
  it('refuses unidentified foreground and windows even with screenshot selection', async () => {
    const unknown = { appId: 'dev.mote.unknown-foreground', appName: '无前台应用', pid: 0 };
    mocks.foreground.mockResolvedValue(unknown); mocks.active.mockResolvedValue({ ...unknown, visibleAppIds: [], unknownVisibleWindows: true });
    const { collector, queue } = await makeCollector({ syncMode: 'manual' }); await collector.start(); await collector.settleCapture();
    expect(queue.stats().depth).toBe(0); expect(mocks.capture).not.toHaveBeenCalled();
  });
  it('still refuses missing foreground when any user application restriction might apply', async () => {
    mocks.foreground.mockResolvedValue({ appId: 'dev.mote.unknown-foreground', appName: '无前台应用', pid: 0 });
    const { collector, queue } = await makeCollector({ appCollectionRules: {'dev.private': off} }); await collector.start(); await collector.settleCapture();
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
    const config = { ...fixtureConfig(), token: 'synthetic-token', syncMode: 'batch' as const, syncBatchSize: 2 };
    const queue = new DurableQueue(directory, config); await queue.initialize(); const capturedAt = new Date().toISOString();
    await queue.enqueue({ ...event(), capturedAt }, image);
    let sourcePending = 1;
    const flush = vi.fn(async () => { sourcePending = 0; });
    const sources = { pendingStats: () => ({ pendingRecords: sourcePending, oldestPendingAt: capturedAt, hasUpdates: false }), nodeBinding: { unbound: () => false }, flushPending: flush };
    collector = new Collector(config, queue, '/fixture/no-real-helper', () => true, () => undefined, undefined, undefined, sources as any);
    vi.mocked(fetch).mockImplementation(async (_url, init) => new Response(JSON.stringify(captureAck(JSON.parse(await new Response(init!.body).text()).id)), { status: 201 }));
    await collector.upload(); expect(fetch).toHaveBeenCalledTimes(1); expect(flush).toHaveBeenCalledTimes(1);
    expect(collector.status().sync).toMatchObject({ pendingRecords: 0, state: 'idle' });
  });
  it.skipIf(process.platform !== 'darwin')('captures generated activity locally before any URL or token is configured', async () => {
    const { collector, queue } = await makeCollector({ serverUrl: '', token: undefined, defaultCollection: activity });
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
    collector = new Collector(config, queue, '/fixture/no-real-helper', () => true, () => undefined, undefined, undefined, sources as any);
    await collector.upload(); expect(flush).not.toHaveBeenCalled(); expect(collector.status().sync).toMatchObject({ state: 'waiting', pendingRecords: 0 });
    now += 15 * 60000; await collector.upload(); expect(flush).toHaveBeenCalledTimes(1); expect(collector.status().sync.state).toBe('idle');
  } finally { clock.mockRestore(); }
});
it('caps only the heartbeat aggregate at the wire limit while local status keeps the full pending count', async () => {
  const config = { ...fixtureConfig(), token: 'synthetic-aggregate-token' };
  const queue = new DurableQueue(directory, config); await queue.initialize();
  const sources = { pendingStats: () => ({ pendingRecords: 1_000_020, pendingUpdates: 0, hasUpdates: false }), nodeBinding: { unbound: () => false } };
  collector = new Collector(config, queue, '/fixture/no-real-helper', () => true, () => undefined, undefined, undefined, sources as any);
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
  collector = new Collector(config, queue, '/fixture/no-real-helper', () => true, status => statuses.push(status), undefined, undefined, sources as any);
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
    collector.updateConfig({...fixtureConfig(),serverUrl:'',token:undefined});await release();
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
    const config = { ...fixtureConfig(), serverUrl: '', token: undefined, syncMode: 'manual' as const, intervalMs: 300000, masks: [{ x: 0, y: 0, width: 1, height: 1 }] };
    collector.updateConfig(config); await resume(); await collector.settleCapture();
    expect(collector.status().running).toBe(true);
    const stored = Object.values((await queue.exportArchive()).blobs).map(value => Buffer.from(value, 'base64')); expect(stored).toHaveLength(1);
    expect([...(await sharp(stored[0]).removeAlpha().raw().toBuffer())].every(value => value === 0)).toBe(true);
    expect((collector as unknown as { timer: { _idleTimeout: number } }).timer._idleTimeout).toBeGreaterThan(290000);
    await resume(); expect(mocks.capture).toHaveBeenCalledTimes(2);
  });
  it.each(['stopped', 'stop during save', 'shutdown during save'])('does not auto-start when %s', async mode => {
    const { collector } = await makeCollector({ syncMode: 'manual', defaultCollection: off });
    if (mode !== 'stopped') { await collector.start(); await collector.settleCapture(); }
    const resume = await collector.suspendForSettings();
    if (mode === 'stop during save') collector.stop();
    if (mode === 'shutdown during save') collector.shutdown();
    else collector.updateConfig({ ...fixtureConfig(), serverUrl: '' });
    await resume(); expect(collector.status().running).toBe(false); expect(mocks.capture).not.toHaveBeenCalled();
    if (mode === 'shutdown during save') { await expect(collector.start()).rejects.toThrow(); await collector.upload(true); await collector.retry(); expect(vi.mocked(fetch).mock.calls.filter(args => String(args[0]).includes('/api/captures'))).toHaveLength(0); }
  });
  it('holds uploads during settings and resumes the immutable queued capture after release',async()=>{
    const {collector,queue}=await makeCollector({syncMode:'manual',packedUpload:false});const {event,image}=await import('./fixtures');await queue.enqueue(event(),image);
    vi.mocked(fetch).mockImplementation(async()=>new Response(JSON.stringify(captureAck(event().id)),{status:200}));
    const resume=await collector.suspendForSettings();const before=vi.mocked(fetch).mock.calls.length;await collector.upload(true);expect(vi.mocked(fetch).mock.calls.length).toBe(before);
    await resume();await collector.upload(true);expect(queue.stats().depth).toBe(0);expect(collector.status().running).toBe(false);expect(mocks.ocr).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== 'darwin')('exact deduplication with generated images', () => {
  it('retains every repeated observation and its measured time through queue restart',async()=>{
    let at=Date.parse('2026-10-01T00:00:00Z');const clock=vi.spyOn(Date,'now').mockImplementation(()=>at);
    try{
      const {collector,queue}=await makeCollector({syncMode:'manual',imageDedupeMode:'exact',intervalMs:30000,defaultCollection:{...content,duration:true}});
      await collector.start();await collector.settleCapture();
      for(let i=0;i<4;i++){at+=30000;clearTimeout((collector as any).timer);await (collector as any).capture();}
      const archive=await queue.exportArchive();expect(Object.keys(archive.blobs)).toHaveLength(1);
      const samples=archive.records.filter(record=>record.event.source==='activity').flatMap(record=>record.event.stateSeries?.samples??[{at:record.event.capturedAt,durationMs:record.event.durationMs}]);
      expect(samples).toHaveLength(5);expect(samples.map(v=>v.at)).toEqual(Array.from({length:5},(_,i)=>new Date(Date.parse('2026-10-01T00:00:00Z')+i*30000).toISOString()));expect(samples.reduce((n,sample)=>n+sample.durationMs,0)).toBe(120000);
      const reopened=new DurableQueue(directory,fixtureConfig());await reopened.initialize();expect((await reopened.exportArchive()).records.filter(record=>record.event.source==='activity').flatMap(record=>record.event.stateSeries?.samples??[record.event])).toHaveLength(5);expect(mocks.ocr).not.toHaveBeenCalled();
    }finally{clock.mockRestore();}
  });
  it.each(['off', 'exact'])('honors %s mode and never merges different applications', async mode => {
    const { collector, queue } = await makeCollector({ syncMode: 'manual', imageDedupeMode: mode });
    await collector.start(); await collector.settleCapture();
    clearTimeout((collector as any).timer); await (collector as any).capture();
    expect(queue.stats().depth).toBe(mode==='exact'?1:2);
    mocks.active.mockResolvedValue({ ...application, appId: 'dev.mote.other' });
    mocks.foreground.mockResolvedValue({ ...application, appId: 'dev.mote.other' });
    clearTimeout((collector as any).timer); await (collector as any).capture();
    expect(queue.stats().depth).toBe(mode==='exact'?2:3);
  });
});

const pageRule={id:'generated-page',version:'1',formatVersion:3,platform:'macos',appId:application.appId,appVersion:'fixture',kind:'visible_text',fields:{body:{select:{role:'AXStaticText'},required:true,source:'text',cardinality:'many'}},required:[]};
const pageSnapshot={appId:application.appId,appVersion:'fixture',activity:'',truncated:false,nodes:[{id:'1',role:'AXStaticText',resourceId:'fixture-body',text:'GENERATED PAGE BODY',bounds:{x:0,y:0,width:100,height:20}}]};
describe.skipIf(process.platform!=='darwin')('independent collection channel journeys',()=>{
 it.each(Array.from({length:8},(_,bits)=>({duration:Boolean(bits&1),screenshots:Boolean(bits&2),structured:Boolean(bits&4)})))('honors every channel combination: %j',async selected=>{
  mocks.page.mockResolvedValue({snapshot:pageSnapshot});
  const {collector,queue}=await makeCollector({syncMode:'manual',defaultCollection:selected,uiPageRules:[pageRule]});
  await collector.start();await collector.settleCapture();
  const records=(await queue.exportArchive()).records.map(r=>r.event);
  expect(records.map(e=>e.source).sort()).toEqual([...(selected.duration?['activity']:[]),...(selected.screenshots?['screen']:[]),...(selected.structured?['ui_page']:[])].sort());
  expect(mocks.capture).toHaveBeenCalledTimes(Number(selected.screenshots));
  expect(mocks.page).toHaveBeenCalledTimes(Number(selected.structured));
  expect(mocks.active).toHaveBeenCalledTimes(selected.screenshots?2:0);expect(mocks.ocr).not.toHaveBeenCalled();
  if(records.length){expect(new Set(records.map(e=>e.metadata?.captureObservation?.id)).size).toBe(1);expect(records.every(e=>JSON.stringify(e.metadata?.captureObservation?.selected)===JSON.stringify(selected))).toBe(true);}
  expect(records.filter(e=>e.source!=='activity').every(e=>e.durationMs===0)).toBe(true);
  const reopened=new DurableQueue(directory,fixtureConfig());await reopened.initialize();expect((await reopened.exportArchive()).records.sort((a,b)=>a.event.id.localeCompare(b.event.id))).toEqual((await queue.exportArchive()).records.sort((a,b)=>a.event.id.localeCompare(b.event.id)));
 });
 it.each(['unsupported','failed','blocked'])('structured %s leaves an independently selected screenshot enabled',async status=>{
  mocks.page.mockResolvedValue({status});const {collector,queue}=await makeCollector({defaultCollection:{...content,structured:true},uiPageRules:[pageRule]});
  await collector.start();await collector.settleCapture();expect(mocks.capture).toHaveBeenCalledOnce();expect((await queue.exportArchive()).records.map(r=>r.event.source)).toEqual(['screen']);
 });
 it('keeps selected structure when screenshot permission is denied',async()=>{
  mocks.page.mockResolvedValue({snapshot:pageSnapshot});mocks.permission.mockReturnValue('denied');
  const {collector,queue}=await makeCollector({defaultCollection:{duration:true,screenshots:true,structured:true},uiPageRules:[pageRule]});await collector.start();await collector.settleCapture();
  expect((await queue.exportArchive()).records.map(r=>r.event.source).sort()).toEqual(['activity','ui_page']);expect(mocks.capture).not.toHaveBeenCalled();
 });
 it('discards late AX content after stop and never continues to screenshot reading',async()=>{
  let finish!:(value:unknown)=>void;const pending=new Promise(resolve=>finish=resolve);mocks.page.mockReturnValue(pending);
  const {collector,queue}=await makeCollector({defaultCollection:{...content,structured:true},uiPageRules:[pageRule]});await collector.start();
  while(!mocks.page.mock.calls.length)await new Promise(resolve=>setTimeout(resolve,1));collector.stop();finish({snapshot:pageSnapshot});await collector.settleCapture();
  expect(queue.stats().depth).toBe(0);expect(mocks.capture).not.toHaveBeenCalled();
 });
 it('drops private selected nodes while still taking the independently selected privacy-reviewed screenshot',async()=>{
  mocks.page.mockResolvedValue({snapshot:pageSnapshot});mocks.ocr.mockResolvedValue('Generated clear screenshot');
  const {collector,queue}=await makeCollector({defaultCollection:{...content,structured:true},uiPageRules:[pageRule],uploadGate:{enabled:true,blockedText:['GENERATED PAGE'],failureAction:'hold'}});
  await collector.start();await collector.settleCapture();expect((await queue.exportArchive()).records.map(r=>r.event.source)).toEqual(['screen']);expect(mocks.capture).toHaveBeenCalledOnce();
 });
 it('rejects a foreground switch after AX reading before saving content or reading pixels',async()=>{
  mocks.page.mockImplementation(async()=>{mocks.foreground.mockResolvedValue({...application,appId:'other'});return {snapshot:pageSnapshot};});
  const {collector,queue}=await makeCollector({defaultCollection:{...content,structured:true},uiPageRules:[pageRule]});await collector.start();await collector.settleCapture();expect(queue.stats().depth).toBe(0);expect(mocks.capture).not.toHaveBeenCalled();
 });
 it('counts each interval once when all three channels are selected',async()=>{
  mocks.page.mockResolvedValue({snapshot:pageSnapshot});const start=Date.parse('2026-10-05T00:00:00Z'),clock=vi.spyOn(Date,'now').mockReturnValue(start);
  try{
   const {collector,queue}=await makeCollector({syncMode:'manual',defaultCollection:{duration:true,screenshots:true,structured:true},uiPageRules:[pageRule]});await collector.start();await collector.settleCapture();
   for(let i=1;i<=2;i++){clock.mockReturnValue(start+i*15000);clearTimeout((collector as any).timer);await (collector as any).capture();}
   const records=(await queue.exportArchive()).records;expect(records.filter(r=>r.event.source==='ui_page')).toHaveLength(3);expect(records.filter(r=>r.event.source==='screen')).toHaveLength(3);
   expect(records.flatMap(r=>r.event.stateSeries?.samples??[{durationMs:r.event.durationMs}]).reduce((total,s)=>total+s.durationMs,0)).toBe(30000);
   expect(records.filter(r=>r.event.source!=='activity').every(r=>r.event.durationMs===0)).toBe(true);
  }finally{clock.mockRestore();}
 });
 it('does not autoenable notifications when structured collection is selected',async()=>{
  const {collector}=await makeCollector({defaultCollection:{...off,structured:true}});await collector.start();await collector.settleCapture();expect(mocks.notifications).not.toHaveBeenCalled();
 });
 it('applies literal notification text rules before persistence or upload',async()=>{
  mocks.notifications.mockResolvedValue(['GENERATED FORBIDDEN NOTIFICATION']);
  const {collector,queue}=await makeCollector({syncMode:'manual',notificationCollectionEnabled:true,defaultCollection:{...activity,structured:true},uploadGate:{enabled:true,blockedText:['FORBIDDEN'],failureAction:'hold'}});
  await collector.start();await collector.settleCapture();expect((await queue.exportArchive()).records.some(r=>r.event.metadata?.notification)).toBe(false);
  collector.stop();collector.updateConfig({...collector.status().config,token:'synthetic-token',uploadGate:{enabled:true,blockedText:[],failureAction:'hold'}} as any);await collector.start();await collector.settleCapture();
  expect((await queue.exportArchive()).records.find(r=>r.event.source==='notification')?.event.metadata?.notification?.text).toContain('FORBIDDEN');
 });
 it.each([false,true])('reads scoped WeChat OCR only with explicit consent=%s and no persisted screenshot',async enabled=>{
  const appId='com.tencent.xinWeChat';mocks.foreground.mockResolvedValue({...application,appId});mocks.active.mockResolvedValue({...application,appId,visibleAppIds:[appId]});
  mocks.page.mockResolvedValue({snapshot:{appId,appVersion:'4.1.15',activity:'',truncated:false,nodes:[{id:'list',resourceId:'chat_message_list',role:'AXList',text:'',bounds:{x:1,y:1,width:2,height:2}}]}});
  const {collector,queue}=await makeCollector({syncMode:'manual',defaultCollection:{...off,structured:true},structuredOcrEnabled:enabled});await collector.start();await collector.settleCapture();
  expect(mocks.capture).toHaveBeenCalledTimes(Number(enabled));expect(mocks.ocr).toHaveBeenCalledTimes(Number(enabled));
  const archive=await queue.exportArchive();expect(archive.blobs).toEqual({});expect(archive.records).toHaveLength(Number(enabled));
  if(enabled){expect(mocks.page.mock.calls.slice(1).every(call=>JSON.parse(call[2].toString()).requireUnoccludedRegion===true)).toBe(true);const page=archive.records[0].event.metadata?.uiPage;expect(page).toMatchObject({version:3,adapterId:'macos.wechat.local-ocr',status:'partial',objects:[{kind:'visible_text',fields:[{name:'text',values:[{source:'ocr'}]}]}]});const pixels=await sharp(mocks.ocr.mock.calls[0][1]).metadata();expect(pixels.width).toBe(2);expect(pixels.height).toBe(2);}
 });
 it.each(['before','after'])('rejects WeChat OCR when native occlusion proof is blocked %s pixel acquisition',async phase=>{
  const appId='com.tencent.xinWeChat';mocks.foreground.mockResolvedValue({...application,appId});mocks.active.mockResolvedValue({...application,appId,visibleAppIds:[appId]});
  const snapshot={appId,appVersion:'4.1.15',activity:'',truncated:false,nodes:[{id:'list',resourceId:'chat_message_list',role:'AXList',text:'',bounds:{x:1,y:1,width:2,height:2}}]};
  let proofs=0;mocks.page.mockImplementation(async(_path,_command,input:Buffer)=>{if(JSON.parse(input.toString()).requireUnoccludedRegion&&++proofs===(phase==='before'?1:2))return {status:'blocked'};return {snapshot};});
  const {collector,queue}=await makeCollector({defaultCollection:{...off,structured:true},structuredOcrEnabled:true});await collector.start();await collector.settleCapture();
  expect(mocks.capture).toHaveBeenCalledTimes(phase==='before'?0:1);expect(mocks.ocr).not.toHaveBeenCalled();expect(queue.stats().depth).toBe(0);
 });
 it.each([false,true])('requires a verified single Chrome window before screenshot pixels (safe=%s)',async screenshotSafe=>{
  const appId='com.google.Chrome';mocks.foreground.mockResolvedValue({...application,appId});mocks.active.mockResolvedValue({...application,appId,visibleAppIds:[appId]});
  const provider={sample:vi.fn(async()=>({status:'ok' as const,identity:'binding',screenshotSafe,pages:[]})),validate:vi.fn(async()=>true)};
  const config={...fixtureConfig(),syncMode:'manual' as const},queue=new DurableQueue(directory,config);await queue.initialize();collector=new Collector(config,queue,'/fixture',()=>true,()=>undefined,undefined,undefined,undefined,undefined,provider);await collector.start();await collector.settleCapture();
  expect(mocks.capture).toHaveBeenCalledTimes(Number(screenshotSafe));expect(queue.stats().depth).toBe(Number(screenshotSafe));
 });
 it('refuses screenshot pixels for visible background Chrome because its active page binding is unavailable',async()=>{
  mocks.active.mockResolvedValue({...application,visibleAppIds:[application.appId,'com.google.Chrome']});const {collector,queue}=await makeCollector();await collector.start();await collector.settleCapture();expect(mocks.capture).not.toHaveBeenCalled();expect(queue.stats().depth).toBe(0);
 });
 it.each(['unconfigured','disconnected','blocked'] as const)('explains missing Chrome structure while preserving selected duration (%s)',async failure=>{
  mocks.foreground.mockResolvedValue({...application,appId:'com.google.Chrome'});
  const provider={sample:vi.fn(async()=>({status:failure==='disconnected'?'disconnected' as const:'blocked' as const,pages:[]})),validate:vi.fn(async()=>false)};
  const config={...fixtureConfig(),syncMode:'manual' as const,defaultCollection:{...activity,structured:true},chromeOrigins:failure==='unconfigured'?[]:['https://fixture.example']};
  const queue=new DurableQueue(directory,config);await queue.initialize();collector=new Collector(config,queue,'/fixture',()=>true,()=>undefined,undefined,undefined,undefined,undefined,provider);
  await collector.start();await collector.settleCapture();
  expect(collector.status().message).toContain(failure==='unconfigured'?'允许的 Chrome 站点':failure==='disconnected'?'扩展尚未连接':'遮挡校验未通过');
  expect((await queue.exportArchive()).records.map(r=>r.event.source)).toEqual(['activity']);expect(mocks.capture).not.toHaveBeenCalled();
 });
 it('measures media only across valid matching playing observations and resets on pause, stale binding and restart',async()=>{
  const appId='com.google.Chrome',appName='Google Chrome';mocks.foreground.mockResolvedValue({...application,appId,appName});
  let state:'playing'|'paused'='playing',bound=true,mediaId='generated-a';
  const provider={sample:vi.fn(async()=>({status:'ok' as const,identity:'binding',pages:[],media:{status:'available' as const,sessions:[{sessionId:'stable-generated-player',mediaId,appId,appName,appVisibility:'foreground' as const,playbackType:'local' as const,playbackState:state,positionMs:999999}]}})),validate:vi.fn(async()=>bound)};
  const config={...fixtureConfig(),syncMode:'manual' as const,defaultCollection:{...activity,structured:true}},queue=new DurableQueue(directory,config);await queue.initialize();collector=new Collector(config,queue,'/fixture',()=>true,()=>undefined,undefined,undefined,undefined,undefined,provider);
  let now=Date.parse('2026-10-24T00:00:00.000Z');const clock=vi.spyOn(Date,'now').mockImplementation(()=>now);
  try{
   await collector.start();await collector.settleCapture();const next=async(gap=15000)=>{now+=gap;clearTimeout((collector as any).timer);await (collector as any).capture();};
   await next(15001);state='paused';await next();state='playing';await next();await next();bound=false;await next();bound=true;await next();mediaId='generated-b';await next();await next();await next(30001);await next();
   collector.stop();await collector.start();await collector.settleCapture();
   const media=(await queue.exportArchive()).records.filter(r=>r.event.source==='media');expect(media.map(r=>r.event.durationMs)).toEqual([0,15000,0,0,15000,0,0,15000,0,15000,0]);
   expect(mocks.capture).not.toHaveBeenCalled();expect(mocks.active).not.toHaveBeenCalled();
  }finally{clock.mockRestore();}
 });
 it.each([false,true])('validates Chrome binding and admits media with zero duration when duration=%s',async duration=>{
  mocks.foreground.mockResolvedValue({...application,appId:'com.google.Chrome'});
  const {namedPage}=await import('@mote/shared');const page=namedPage({...pageSnapshot,appId:'com.google.Chrome'},{id:'generated.browser',version:'1',kind:'article'},[{name:'body',values:[{text:'Generated browser content',source:'text'}]}],new Date().toISOString());
  const provider={sample:vi.fn(async(request:{observedAt:string})=>({status:'ok' as const,identity:'fixture-document',pages:[{...page,observations:{...page.observations,firstAt:request.observedAt,lastAt:request.observedAt}}],media:{status:'available' as const,sessions:[{sessionId:'generated-player',appId:'com.google.Chrome',appName:'Google Chrome',playbackState:'playing' as const,appVisibility:'foreground' as const,playbackType:'local' as const,title:'Generated video',positionMs:1000}]}})),validate:vi.fn(async()=>true)};
  const config={...fixtureConfig(),syncMode:'manual' as const,defaultCollection:{duration,screenshots:false,structured:true}};const queue=new DurableQueue(directory,config);await queue.initialize();
  collector=new Collector(config,queue,'/fixture',()=>true,()=>undefined,undefined,undefined,undefined,undefined,provider);await collector.start();await collector.settleCapture();
  const records=(await queue.exportArchive()).records;expect(records.some(r=>r.event.source==='media')).toBe(true);expect(records.find(r=>r.event.source==='media')?.event.durationMs).toBe(0);expect(provider.validate).toHaveBeenCalled();expect(mocks.capture).not.toHaveBeenCalled();
 });
});

it('a global send pause blocks explicit retries and heartbeat without changing the configured cadence',async()=>{
  const {event,image}=await import('./fixtures');const {collector,queue}=await makeCollector({syncMode:'manual'});await queue.enqueue(event(),image);
  await collector.setSyncPaused(true);await collector.retry();await (collector as any).sendHeartbeat(true);
  expect(fetch).not.toHaveBeenCalled();expect(queue.stats().depth).toBe(1);expect(collector.status().config).toMatchObject({syncMode:'manual',syncPaused:true});
  vi.mocked(fetch).mockImplementation(async (_url,init)=>new Response(JSON.stringify(captureAck(JSON.parse(await new Response(init!.body).text()).id)),{status:201}));
  await collector.setSyncPaused(false);expect(queue.stats().depth).toBe(1);await collector.retry();expect(queue.stats().depth).toBe(0);expect(collector.status().config.syncMode).toBe('manual');
});

it.skipIf(process.platform!=='darwin')('pausing sends preserves an active local recording and its measured sampling continuity',async()=>{
  const {collector,queue}=await makeCollector({syncMode:'manual',metadataEnabled:false,defaultCollection:activity,intervalMs:300000});
  await collector.start();await collector.settleCapture();const sample=(collector as any).lastSample,timer=(collector as any).timer;
  await collector.setSyncPaused(true);expect(collector.status().running).toBe(true);expect((collector as any).lastSample).toBe(sample);expect((collector as any).timer).toBe(timer);
  mocks.foreground.mockResolvedValue({appId:'dev.mote.generated.second',appName:'Generated second app',pid:2});
  await (collector as any).capture();await collector.settleCapture();expect(queue.stats().depth).toBeGreaterThanOrEqual(2);await collector.retry();await (collector as any).sendHeartbeat(true);expect(fetch).not.toHaveBeenCalled();expect(collector.status().running).toBe(true);
});

it('changes the non-secret authorization epoch when credentials change, including same node renewal',async()=>{
  const {collector}=await makeCollector();const generation=collector.status().authorizationGeneration;
  collector.updateConfig({...fixtureConfig(),token:'new-generated-token'});expect(collector.status().authorizationGeneration).toBe((generation??0)+1);
  expect(JSON.stringify(collector.status())).not.toContain('new-generated-token');
});


it.each([{packed:true,enabled:true},{packed:true,enabled:false},{packed:false,enabled:true},{packed:false,enabled:false}])('E reads each queued shared image once and preserves exact payload/counter bytes ($packed/$enabled)',async({packed,enabled})=>{
  const {event,image}=await import('./fixtures');
  const config={...fixtureConfig(),token:'generated-token',syncMode:'manual' as const,packedUpload:packed};
  const queue=new DurableQueue(directory,config);await queue.initialize();
  const events=[3,1,2].map(i=>event(`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`));
  for(const item of events)await queue.enqueue(item,image);
  expect(await readdir(join(directory,'blobs'))).toHaveLength(1);
  const diagnostics={status:()=>({enabled}),recordUpload:vi.fn(),close:async()=>{}};
  syncHistory=new SyncHistory(join(directory,'history.sqlite'));await syncHistory.initialize();
  collector=new Collector(config,queue,'/never-native',()=>true,()=>undefined,diagnostics as any,undefined,undefined,syncHistory);
  const payloads:string[]=[];
  vi.mocked(fetch).mockImplementation(async(_url,init)=>{const raw=await new Response(init!.body).text();payloads.push(raw);const body=JSON.parse(raw);return new Response(JSON.stringify(packed?{results:body.captures.map((item:any)=>({...captureAck(item.id),status:201}))}:captureAck(body.id)),{status:packed?200:201});});
  const reads=vi.spyOn(localContent,'readLocalContent'),hashes=vi.spyOn(imageWork,'run'),next=vi.spyOn(queue,'next');
  const originalToString=Buffer.prototype.toString;let base64=0;
  const encoding=vi.spyOn(Buffer.prototype,'toString').mockImplementation(function(this:Buffer,...args:Parameters<Buffer['toString']>){if(args[0]==='base64'&&this.equals(image))base64++;return originalToString.apply(this,args);});
  try{
    await collector.upload(true);
    expect(next).toHaveBeenCalledTimes(packed?0:3);
    expect(reads.mock.calls.filter(([path])=>String(path).includes('/blobs/'))).toHaveLength(3);
    expect(hashes.mock.calls.filter(([request])=>request.kind==='hash')).toHaveLength(3);
    expect(base64).toBe(enabled?6:3);
    expect(diagnostics.recordUpload.mock.calls.flat()).toEqual(enabled?events.map(item=>Buffer.byteLength(JSON.stringify({...item,imageBase64:originalToString.call(image,'base64')}))):[]);
    const sent=payloads.flatMap(raw=>{const body=JSON.parse(raw);return body.captures??[body];});
    expect(sent).toEqual(events.map(item=>({...item,imageBase64:originalToString.call(image,'base64')})));
    const d=new Date(),day=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    expect(syncHistory.page(config,{day}).items[0].bytes).toBe(payloads.reduce((sum,raw)=>sum+Buffer.byteLength(raw),0));
    expect(queue.stats().depth).toBe(0);expect(await readdir(join(directory,'blobs'))).toEqual([]);
  }finally{encoding.mockRestore();reads.mockRestore();hashes.mockRestore();next.mockRestore();}
});

it.each([0,1])('E preserves storage bookkeeping when packed image %i fails verification',async broken=>{
  const {event,image}=await import('./fixtures');const config={...fixtureConfig(),token:'generated-token',syncMode:'manual' as const,packedUpload:true};
  const queue=new DurableQueue(directory,config);await queue.initialize();
  const images=[image,Buffer.concat([image.subarray(0,-2),Buffer.from([1,2]),image.subarray(-2)])];
  const events=[event('00000000-0000-4000-8000-000000000001'),event('00000000-0000-4000-8000-000000000002')];
  for(let i=0;i<2;i++)await queue.enqueue(events[i],images[i]);
  const {imageHash}=await import('../src/queue');await writeFile(join(directory,'blobs',imageHash(images[broken])+'.jpg'),Buffer.from('Generated broken image'));
  const journal={record:vi.fn(async()=>{})};collector=new Collector(config,queue,'/never-native',()=>true,()=>undefined,undefined,journal as any);
  await collector.upload(true);expect(fetch).not.toHaveBeenCalled();expect(queue.stats().depth).toBe(2);
  expect(queue.recordForHistory(events[0].id)?.attempts).toBe(broken===0?0:1);
  expect(queue.recordForHistory(events[1].id)?.attempts).toBe(0);
  const starts=journal.record.mock.calls.filter(args=>args[0]==='UPLOAD'&&args[1]==='STARTED');expect(starts).toHaveLength(broken===0?0:1);
  if(broken===0)expect(journal.record).toHaveBeenCalledWith('QUEUE','STORAGE',{errorName:'Error'});
});


it('E retains missing receipts and held conflicts with shared blobs until explicit retry ACKs',async()=>{
  const {event,image}=await import('./fixtures');const {queue}=await makeCollector({syncMode:'manual',packedUpload:true});
  const records=[1,2,3,4].map(i=>event(`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`));
  for(const item of records)await queue.enqueue(item,image);
  vi.mocked(fetch).mockImplementationOnce(async()=>new Response(JSON.stringify({results:[{...captureAck(records[0].id),status:201},{id:records[1].id,status:409},{id:records[2].id,status:410}]})));
  await collector!.upload(true);expect(queue.stats()).toMatchObject({depth:3,blocked:2,eligibleDepth:1});
  expect(queue.recordForHistory(records[3].id)?.attempts).toBe(1);expect(await readdir(join(directory,'blobs'))).toHaveLength(1);
  vi.mocked(fetch).mockImplementation(async(_url,init)=>{const body=JSON.parse(await new Response(init!.body).text());return new Response(JSON.stringify({results:body.captures.map((item:any)=>({...captureAck(item.id),status:200}))}));});
  await collector!.retry();expect(queue.stats().depth).toBe(0);expect(await readdir(join(directory,'blobs'))).toEqual([]);
});

it.each([false,true])('E yields the 15-second slice with eligible work still waiting (%s)',async packed=>{
  const {event,image}=await import('./fixtures'),config={...fixtureConfig(),token:'generated-token',syncMode:'manual' as const,packedUpload:packed};
  const queue=new DurableQueue(directory,config);await queue.initialize();
  const original=event('00000000-0000-4000-8000-000000000001'),held=event('00000000-0000-4000-8000-000000000002'),fresh=event('00000000-0000-4000-8000-000000000003');
  await queue.enqueue(original,image);await queue.enqueue(held,image);await queue.blockSync(held.id,'Generated held record keeps the initial count limit above one');
  let elapsed=0,sourcePending=1,sourceVisited=false;const sent:string[]=[];
  vi.mocked(fetch).mockImplementation(async(_url,init)=>{const body=JSON.parse(await new Response(init!.body).text()),items=body.captures??[body];sent.push(...items.map((item:any)=>item.id));
    if(sent.length===1){fresh.capturedAt=new Date().toISOString();await queue.enqueue(fresh,image);}elapsed+=15001;
    return new Response(JSON.stringify(packed?{results:items.map((item:any)=>({...captureAck(item.id),status:201}))}:captureAck(body.id)),{status:packed?200:201});});
  const sources={nodeBinding:{unbound:()=>false},pendingStats:()=>({pendingRecords:sourcePending,eligibleRecords:sourcePending}),flushPending:async()=>{expect(sent).toEqual([original.id]);expect(queue.recordForHistory(fresh.id)).toBeDefined();sourcePending=0;sourceVisited=true;}};
  collector=new Collector(config,queue,'/never-native',()=>true,()=>undefined,undefined,undefined,sources as any);
  const clock=vi.spyOn(performance,'now').mockImplementation(()=>elapsed);
  try{await collector.upload(true);expect(sourceVisited).toBe(true);expect(queue.stats()).toMatchObject({depth:1,blocked:1});expect(sent).toEqual([original.id,fresh.id]);}finally{clock.mockRestore();}
});

it('E gives history its existing turn after 16 MiB of live-priority slices',async()=>{
  const {event}=await import('./fixtures'),config={...fixtureConfig(),token:'generated-token',syncMode:'manual' as const,packedUpload:true};
  const queue=new DurableQueue(directory,config);await queue.initialize();
  const pixels=Buffer.alloc(4_000_000);pixels[0]=255;pixels[1]=216;pixels[pixels.length-2]=255;pixels[pixels.length-1]=217;
  const generated=(i:number,at:string)=>({...event(`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`),capturedAt:at});
  const historical=Array.from({length:6},(_,i)=>generated(i+1,new Date(Date.UTC(2025,0,1+i)).toISOString()));
  for(const item of historical)await queue.enqueue(item,pixels);
  const sent:string[]=[];let sourcePending=1;
  vi.mocked(fetch).mockImplementation(async(_url,init)=>{const body=JSON.parse(await new Response(init!.body).text());expect(body.captures).toHaveLength(1);sent.push(body.captures[0].id);return new Response(JSON.stringify({results:[{...captureAck(body.captures[0].id),status:201}]}));});
  const sources={nodeBinding:{unbound:()=>false},pendingStats:()=>({pendingRecords:sourcePending,eligibleRecords:sourcePending}),flushPending:async(_signal:AbortSignal,between:()=>Promise<void>)=>{
    for(let i=0;i<4;i++){await queue.enqueue(generated(100+i,new Date().toISOString()),pixels);await between();}
    sourcePending=0;
  }};
  collector=new Collector(config,queue,'/never-native',()=>true,()=>undefined,undefined,undefined,sources as any);
  await collector.upload(true);
  expect(sent.slice(0,5)).toEqual([historical[0].id,...[100,101,102].map(i=>generated(i,'').id),historical[1].id]);
  expect(new Set(sent).size).toBe(10);expect(queue.stats().depth).toBe(0);
});
