import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigStore, defaultConfig } from '../src/config';
import { Collector } from '../src/collector';
import { DurableQueue } from '../src/queue';
import { QueueStorage } from '../src/queue-storage';
import { LocalSourceManager } from '../src/source-manager';
import { DEFAULT_SOURCE_OPTIONS } from '../src/source-types';
import { NoteDraftStore } from '../src/note-draft';
import { SettingsCoordinator, type SettingsDependencies } from '../src/settings-coordinator';
import type { Config } from '../src/contracts';
import { event, image, runtimeStatusReceipt } from './fixtures';
import { ConnectionController } from '../src/connection-controller';
import { ConnectionOnboarding } from '../src/connection';
import type { ConnectionStatus } from '../src/contracts/connection';
import { MOTE_PROTOCOL_RANGE } from '@mote/shared';

// Only the unavailable Electron system boundary is replaced; transactions, drafts,
// source checkpoints, queue bindings and the collector's settings lifecycle are real.
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { powerMonitor: new EventEmitter(), systemPreferences: { getMediaAccessStatus: () => 'granted' }, desktopCapturer: {}, nativeImage: {}, screen: {} };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture(unbound = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mote-settings-')));
  const profile = join(root, 'profile'); await mkdir(profile);
  const store = new ConfigStore(profile, { available: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString() });
  await store.save({ ...defaultConfig(), serverUrl: unbound ? '' : 'https://fixture.invalid', token: unbound ? undefined : 'generated-settings-owner-token-123456789', syncMode: 'manual' });
  let settings = await store.load(), recovery: string | undefined, loginItem = settings.openAtLogin;
  const storage = new QueueStorage(profile, 'test', settings.deviceId);
  const queue = new DurableQueue(await storage.open(''), settings); await queue.initialize();
  const notes = new NoteDraftStore(join(profile, 'notes')); await notes.initialize();
  const sources = new LocalSourceManager(join(profile, 'sources'), settings, '/unused', true); await sources.initialize();
  const collector = new Collector(settings, queue, '/unused', () => true, () => {}, undefined, undefined, sources);
  const dependencies: SettingsDependencies = {
    settings: () => settings, installSettings: value => { settings = value; }, store, collector, sources, queue, notes,
    defaultProfile: true, loginItems: { get: () => loginItem, set: value => { loginItem = value; } },
    running: () => collector.status().running, quitting: () => false, recoveryRequired: () => recovery,
    requireRecovery: message => { recovery = message; collector.requireRecovery(message); void sources.close(); },
    configureDiagnostics: vi.fn(async () => {}), clearStorageSelection: vi.fn(), connectionStatus: vi.fn(),
    relocate: updated => queue.relocate(updated.captureStorageDirectory || storage.defaultDirectory, storage, () => store.save(updated), async () => (await store.load()).captureStorageDirectory || storage.defaultDirectory),
  };
  const coordinator = new SettingsCoordinator(dependencies);
  const addPending = async () => {
    const file = join(root, 'generated.md'); await writeFile(file, 'Generated immutable settings regression evidence.');
    await sources.addFiles(file, DEFAULT_SOURCE_OPTIONS); await sources.sync();
    const capture = { ...event(), deviceId: settings.deviceId }; await queue.enqueue(capture, image); await queue.failed(capture.id, Date.now(), () => 0.5);
    const draft = { ...notes.get(), text: 'Generated prepared note', mood: '', revision: 1 };
    await expect(notes.submit(draft, settings, 'macos', { enqueue: async () => { throw Error('Generated interrupted note enqueue'); } })).rejects.toThrow('interrupted');
    return { capture, draft };
  };
  return { root, profile, store, storage, queue, notes, sources, collector, dependencies, coordinator, addPending, settings: () => settings, recovery: () => recovery, loginItem: () => loginItem,
    close: async () => { collector.shutdown(); await sources.close(); await rm(root, { recursive: true, force: true }); } };
}

it('rolls back a failed pre-commit save, retains queue/draft data and allows a later settings retry', async () => {
  const f = await fixture();
  try {
    await f.addPending();
    const previous = f.settings(), archive = await f.queue.exportArchive(), pending = structuredClone(f.sources.pendingContent());
    const updated = { ...previous, openAtLogin: !previous.openAtLogin, syncIntervalMinutes: previous.syncIntervalMinutes + 1 };
    vi.spyOn(f.store, 'save').mockRejectedValueOnce(Error('Generated disk failure before commit'));
    await expect(f.coordinator.paused(() => f.coordinator.apply(updated))).rejects.toThrow('before commit');
    expect(f.settings()).toBe(previous); expect(await f.store.load()).toEqual(previous); expect(f.loginItem()).toBe(previous.openAtLogin); expect(f.recovery()).toBeUndefined();
    expect(f.collector.status().config.syncIntervalMinutes).toBe(previous.syncIntervalMinutes);
    expect(await f.queue.exportArchive()).toEqual(archive); expect(f.sources.pendingContent()).toEqual(pending); expect(f.notes.hasPrepared()).toBe(true);
    await f.coordinator.paused(() => f.coordinator.apply(updated));
    expect(f.settings()).toBe(updated); expect(await f.store.load()).toEqual(updated); expect(f.dependencies.clearStorageSelection).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

it('preserves both real queue copies and enters recovery when config rename committed before reporting failure', async () => {
  const f = await fixture();
  try {
    await f.addPending();
    const external = join(f.root, 'external'); await mkdir(external);
    const source = f.queue.directory, target = await f.storage.candidate(external, source), archive = await f.queue.exportArchive();
    const updated = { ...f.settings(), captureStorageDirectory: target };
    const save = f.store.save.bind(f.store);
    vi.spyOn(f.store, 'save').mockImplementationOnce(async config => { await save(config); throw Error('Generated failure after durable config rename'); });
    await expect(f.coordinator.paused(() => f.coordinator.apply(updated))).rejects.toThrow('恢复');
    expect((await f.store.load()).captureStorageDirectory).toBe(target); expect(f.recovery()).toContain('恢复'); expect(f.recovery()).toContain('新旧副本均已保留');
    expect((await stat(source)).isDirectory()).toBe(true); expect((await stat(target)).isDirectory()).toBe(true);
    expect(await f.queue.exportArchive()).toEqual(archive); expect(f.notes.hasPrepared()).toBe(true);
    expect(f.collector.status().state).toBe('error'); expect(f.dependencies.clearStorageSelection).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('keeps exact pending source bodies, capture identity and prepared note through same-node reauthorization', async () => {
  const f = await fixture();
  try {
    const { capture, draft } = await f.addPending(), previous = f.settings(), pending = structuredClone(f.sources.pendingContent());
    const updated = { ...previous, token: 'generated-settings-replacement-token-123456789' };
    await f.coordinator.connectionChange(() => f.coordinator.commitConnection(updated, true, true), true, true);
    expect(f.queue.binding.matches(updated)).toBe(true); expect(f.sources.nodeBinding.matches(updated)).toBe(true);
    expect(f.sources.pendingContent()).toEqual(pending); expect(f.queue.recordForHistory(capture.id)?.event).toEqual(capture);
    expect(f.queue.recordForHistory(capture.id)?.nextAttemptAt).toBe(0); expect(f.notes.get()).toMatchObject({ ...draft, prepared: true });
    await expect(f.coordinator.connectionChange(() => f.coordinator.commitConnection({ ...updated, serverUrl: 'https://other.invalid' }))).rejects.toThrow('不能更换');
    expect(f.settings()).toBe(updated); expect(await f.store.load()).toEqual(updated);
    // A newly created note window/store sees the same durable prepared draft, then finishes it once.
    const reopened = new NoteDraftStore(join(f.profile, 'notes')); await reopened.initialize();
    const result = await reopened.submit(draft, updated, 'macos', f.queue);
    expect(result.id).toBe(draft.id); expect(f.queue.stats().depth).toBe(2);
    expect(await reopened.submit(draft, updated, 'macos', f.queue)).toEqual(result); expect(f.queue.stats().depth).toBe(2);
  } finally { await f.close(); }
});

it('binds an explicitly confirmed unbound backlog including an interrupted prepared note before saving credentials', async () => {
  const f = await fixture(true);
  try {
    const { draft } = await f.addPending();
    expect(f.coordinator.unboundBacklog()).toBe(true); expect(f.notes.hasUnboundPrepared()).toBe(true);
    const updated: Config = { ...f.settings(), serverUrl: 'https://fixture.invalid', token: 'generated-initial-settings-token-123456789' };
    const save = f.store.save.bind(f.store);
    vi.spyOn(f.store, 'save').mockImplementationOnce(async config => {
      expect(f.queue.binding.matches(updated)).toBe(true); expect(f.sources.nodeBinding.matches(updated)).toBe(true); expect(f.notes.hasUnboundPrepared()).toBe(false);
      await save(config);
    });
    await f.coordinator.connectionChange(() => f.coordinator.commitConnection(updated, false, true), false, true);
    const reopened = new NoteDraftStore(join(f.profile, 'notes')); await reopened.initialize();
    expect(reopened.get()).toMatchObject({ ...draft, prepared: true });
    await expect(reopened.submit(draft, { ...updated, serverUrl: 'https://other.invalid' }, 'macos', f.queue)).rejects.toThrow('原中央');
    expect((await reopened.submit(draft, updated, 'macos', f.queue)).id).toBe(draft.id);
  } finally { await f.close(); }
});

it('releases the real collector hold after source acquisition failure so a repeated operation can finish', async () => {
  const f = await fixture();
  try {
    const operation = vi.fn(async () => 'completed');
    vi.spyOn(f.sources, 'holdConnection').mockRejectedValueOnce(Error('Generated source hold failure'));
    await expect(f.coordinator.paused(operation)).rejects.toThrow('source hold failure'); expect(operation).not.toHaveBeenCalled();
    expect(await f.coordinator.paused(operation)).toBe('completed'); expect(operation).toHaveBeenCalledTimes(1);
    expect(f.collector.status().running).toBe(false); expect(f.recovery()).toBeUndefined();
  } finally { await f.close(); }
});

function connectionEntry(f: Awaited<ReturnType<typeof fixture>>) {
  let status: ConnectionStatus = { state: 'unchecked', message: 'Generated unchecked connection' };
  const onboarding = new ConnectionOnboarding((...args) => fetch(...args));
  const dependencies = {
    settings: f.settings, status: () => status, installStatus: (value: ConnectionStatus) => { status = value; },
    secretStorageAvailable: () => true, platform: 'macos' as const, coordinator: f.coordinator, onboarding,
  };
  const identity = (id = 'generated-granted-credential') => ({
    credential: { id, scope: 'owner', label: 'Generated owner client', deviceId: f.settings().deviceId },
    node: { version: '0.0.90', profile: 'test', protocol: MOTE_PROTOCOL_RANGE },
    capabilities: { ingest: true, ingressVersion: 2, ownSources: true, archiveRead: true },
  });
  const preview = () => onboarding.preview(JSON.stringify({ format: 'mote.connection', version: 1, code: 'x'.repeat(43), serverUrl: f.settings().serverUrl, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  return { controller: new ConnectionController(dependencies), dependencies, identity, preview, status: () => status };
}

it('confirms an invitation through the actual onboarding consumer and settings transaction without losing pending identities', async () => {
  const f = await fixture();
  try {
    const { draft } = await f.addPending(), pending = structuredClone(f.sources.pendingContent());
    const entry = connectionEntry(f), preview = entry.preview(), token = 'generated-invitation-owner-token-123456789';
    const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith('/redeem') ? { serverUrl: preview.serverUrl, token, credentialId: 'generated-granted-credential', scope: 'owner' } : entry.identity()));
    vi.stubGlobal('fetch', fetcher);
    await entry.controller.confirm(preview.id, preview.serverUrl, 'Generated renamed Mac');
    expect(f.settings().token).toBe(token); expect((await f.store.load()).deviceName).toBe('Generated renamed Mac');
    expect(f.queue.binding.matches(f.settings())).toBe(true); expect(f.sources.nodeBinding.matches(f.settings())).toBe(true);
    expect(f.sources.pendingContent()).toEqual(pending); expect(f.notes.get()).toMatchObject({ ...draft, prepared: true }); expect(entry.status().state).toBe('connected');
    await expect(entry.controller.confirm(preview.id, preview.serverUrl, 'Generated repeated click')).rejects.toThrow('确认');
    expect(fetcher).toHaveBeenCalledTimes(2); expect(f.settings().deviceName).toBe('Generated renamed Mac');
  } finally { await f.close(); }
});

it('leaves the saved connection untouched after invitation identity mismatch or unavailable secret storage', async () => {
  const f = await fixture();
  try {
    const previous = f.settings(), entry = connectionEntry(f), preview = entry.preview();
    const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith('/redeem') ? { serverUrl: preview.serverUrl, token: 'generated-rejected-owner-token-123456789', credentialId: 'generated-granted-credential', scope: 'owner' } : entry.identity('generated-other-credential')));
    vi.stubGlobal('fetch', fetcher);
    await expect(entry.controller.confirm(preview.id, preview.serverUrl, 'Generated failed name')).rejects.toThrow('身份确认不一致');
    expect(f.settings()).toBe(previous); expect(await f.store.load()).toEqual(previous); expect(f.queue.binding.matches(previous)).toBe(true);
    entry.dependencies.secretStorageAvailable = () => false;
    const next = entry.preview();
    await expect(entry.controller.confirm(next.id, next.serverUrl, 'Generated blocked name')).rejects.toThrow('加密存储不可用');
    expect(fetcher).toHaveBeenCalledTimes(2); expect(f.settings()).toBe(previous);
  } finally { await f.close(); }
});

it('ignores an old connection check after settings change, deduplicates a running check and recovers from a current failure', async () => {
  const f = await fixture();
  try {
    const entry = connectionEntry(f); let release!: (response: Response) => void;
    const self: Array<() => Response | Promise<Response>> = [() => new Promise<Response>(resolve => { release = resolve; }), () => Response.json({ error: 'unauthorized' }, { status: 401 }), () => Response.json(entry.identity())];
    const fetcher = vi.fn(async (url: string) => url.endsWith('/agent-runtime-settings') ? Response.json(runtimeStatusReceipt()) : self.shift()!());
    vi.stubGlobal('fetch', fetcher);
    const pending = entry.controller.test(); expect((await entry.controller.test()).state).toBe('checking'); expect(fetcher).toHaveBeenCalledTimes(1);
    f.dependencies.installSettings({ ...f.settings(), token: 'generated-new-check-token-123456789' });
    entry.dependencies.installStatus({ state: 'unchecked', message: 'Generated new connection' });
    release(Response.json(entry.identity()));
    expect((await pending).state).toBe('unchecked'); expect(entry.status().message).toBe('Generated new connection');
    expect((await entry.controller.test()).state).toBe('error');
    expect((await entry.controller.test()).state).toBe('connected'); expect(fetcher).toHaveBeenCalledTimes(5);
    expect(entry.status().message).toContain('已就绪'); expect(entry.status().message).toContain('generated-model');
  } finally { await f.close(); }
});
