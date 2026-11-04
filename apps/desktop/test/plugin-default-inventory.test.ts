import {describe, expect, it} from 'vitest';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DesktopPluginHost} from '../src/plugin-host/desktop-host.js';
import {NativeProviderRegistry} from '../src/plugin-host/native-registry.js';
import type {IpcRouter} from '../src/plugin-host/ipc-registry.js';
import {
  askWorkspaceChannels, captureChannels, capabilityPublisherChannels, chromeChannels,
  customPageChannels, desktopJobIds, deviceSettingsChannels, hostChannels,
  libraryWorkspaceChannels, localStorageBackupChannels, notesChannels, pushChannels,
  sourcesChannels, systemToolsChannels, workHistoryWorkspaceChannels,
} from '../src/desktop-ipc-channels.js';
import {
  defaultDesktopPluginInventory, loadDesktopPluginInventory, registerDesktopNativeProviders,
} from '../src/plugin-inventory.js';

const allGroups = {
  askWorkspaceChannels, captureChannels, capabilityPublisherChannels, chromeChannels,
  customPageChannels, deviceSettingsChannels, hostChannels, libraryWorkspaceChannels,
  localStorageBackupChannels, notesChannels, pushChannels, sourcesChannels,
  systemToolsChannels, workHistoryWorkspaceChannels,
};
const allChannels = [...new Set(Object.values(allGroups).flatMap(group => Object.values(group)))];

/** Missing entries are failures, never skipped: the build inventory must
 * account for every channel the preload/plugin groups expose. */
function assertComplete(inventory: ReturnType<typeof loadDesktopPluginInventory>): void {
  const owners = new Map<string, string>();
  for (const pkg of inventory.packages) for (const channel of pkg.channels) {
    if (owners.has(channel)) throw new Error(`channel ${channel} has more than one owner`);
    owners.set(channel, pkg.id);
  }
  for (const primitive of inventory.hostPrimitives) for (const channel of primitive.channels) {
    if (owners.has(channel)) throw new Error(`channel ${channel} has more than one owner`);
    owners.set(channel, primitive.id);
  }
  for (const channel of inventory.pushChannels) {
    if (owners.has(channel)) throw new Error(`push channel ${channel} is also invokable`);
    owners.set(channel, 'host.push');
  }
  const missing = allChannels.filter(channel => !owners.has(channel));
  if (missing.length > 0) throw new Error(`default inventory is missing: ${missing.join(', ')}`);
  const unexpected = [...owners.keys()].filter(channel => !allChannels.includes(channel));
  if (unexpected.length > 0) throw new Error(`default inventory owns unknown channels: ${unexpected.join(', ')}`);
}

function recordingRouter() {
  const handlers = new Set<string>();
  const router: IpcRouter = {
    handle(channel) {
      if (handlers.has(channel)) throw new Error(`duplicate channel ${channel}`);
      handlers.add(channel);
    },
    removeHandler(channel) { handlers.delete(channel); },
  };
  return {router, handlers};
}

describe('default Mac plugin inventory', () => {
  it('packaged manifest enters the native registry and UI consumer with the development result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mote-plugin-inventory-'));
    try {
      const manifestPath = join(directory, 'mote-plugin.json');
      await writeFile(manifestPath, JSON.stringify(defaultDesktopPluginInventory), {mode: 0o600});
      const packaged = loadDesktopPluginInventory(JSON.parse(await readFile(manifestPath, 'utf8')));
      expect(packaged).toEqual(defaultDesktopPluginInventory);
      assertComplete(packaged);

      const preload = await readFile(new URL('../src/preload.ts', import.meta.url), 'utf8');
      expect(preload).not.toMatch(/mote:/, 'preload must consume inventory channels, not raw literals');
      expect(preload).toContain("from './desktop-ipc-channels'");

      const registry = new NativeProviderRegistry('mac');
      registerDesktopNativeProviders(registry, packaged, 'generated-build');
      expect(registry.list().map(provider => `${provider.capability}@${provider.apiVersion}`))
        .toEqual(defaultDesktopPluginInventory.nativeProviders.map(provider => `${provider.capability}@${provider.apiVersion}`));
      for (const provider of packaged.nativeProviders)
        expect(registry.satisfies({capability: provider.capability, apiVersion: provider.apiVersion, platforms: ['mac'], fallback: 'none'})).toBe(true);

      const loadedChannels = new Set([
        ...packaged.packages.flatMap(pkg => pkg.channels),
        ...packaged.hostPrimitives.flatMap(primitive => primitive.channels),
        ...packaged.pushChannels,
      ]);
      expect(loadedChannels).toEqual(new Set(allChannels));
      for (const channel of allChannels)
        expect([...packaged.packages.flatMap(pkg => pkg.channels), ...packaged.hostPrimitives.flatMap(p => p.channels), ...packaged.pushChannels].filter(value => value === channel))
          .toHaveLength(1);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  it('missing or duplicate ownership fails the loader instead of being skipped', () => {
    const withoutNotes = structuredClone(defaultDesktopPluginInventory) as unknown as {packages: {channels: string[]}[]};
    withoutNotes.packages = withoutNotes.packages.filter(pkg => !pkg.channels.includes(notesChannels.draft));
    expect(() => assertComplete(loadDesktopPluginInventory(withoutNotes))).toThrow(new RegExp(notesChannels.draft));

    const duplicate = structuredClone(defaultDesktopPluginInventory) as unknown as {packages: {channels: string[]}[]};
    duplicate.packages[0]!.channels.push(notesChannels.draft);
    duplicate.packages[1]!.channels.push(notesChannels.draft);
    expect(() => loadDesktopPluginInventory(duplicate)).toThrow(/owned by both/);

    const unknownProvider = structuredClone(defaultDesktopPluginInventory) as unknown as {nativeProviders: {packageId: string}[]};
    unknownProvider.nativeProviders[0]!.packageId = 'mote.not-installed';
    expect(() => loadDesktopPluginInventory(unknownProvider)).toThrow(/not installed/);

    const missingCapability = structuredClone(defaultDesktopPluginInventory) as unknown as {packages: {capabilities: string[]}[]};
    missingCapability.packages[0]!.capabilities = [];
    expect(() => loadDesktopPluginInventory(missingCapability)).toThrow(/declares no capability/);
  });

  it('stopping a package scope withdraws every inventory channel and durable job', async () => {
    const {router, handlers} = recordingRouter();
    const host = new DesktopPluginHost({router, native: new NativeProviderRegistry('mac')});
    const capabilities = [...new Set(defaultDesktopPluginInventory.packages.flatMap(pkg => pkg.capabilities))];
    host.registerWindow(7, 'main', capabilities);
    for (const pkg of defaultDesktopPluginInventory.packages) {
      let disposed = 0;
      const scope = host.createScope({instanceId: pkg.id, capabilities: pkg.capabilities});
      const started = await host.startPlugin(scope, plugin => {
        for (const channel of pkg.channels)
          plugin.registerIpc({channel, capability: pkg.capabilities[0]!}, () => channel);
        for (const job of pkg.jobs) plugin.registerJob({id: job});
        plugin.defer(() => disposed++);
      });
      expect(started).toEqual({started: true});
      for (const channel of pkg.channels) expect(handlers.has(channel)).toBe(true);
      expect(scope.jobIds).toEqual(pkg.jobs);
      expect(host.stopScope(pkg.id)).toEqual([]);
      for (const channel of pkg.channels) expect(handlers.has(channel)).toBe(false);
      expect(scope.jobIds).toEqual([]);
      expect(disposed).toBe(1);
    }
    expect(handlers.size).toBe(0);
  });
});
