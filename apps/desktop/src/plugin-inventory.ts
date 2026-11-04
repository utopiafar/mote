/** Build-shipped Mac package inventory. One package owns each business
 * capability, IPC channel and durable job; the shell/window/appearance
 * transport stays an explicit host primitive. The same loader consumes the
 * development inventory and a packaged manifest so both produce one registry
 * projection instead of a second hard-coded path. */
import {
  askWorkspaceChannels, capabilityPublisherChannels, captureChannels, chromeChannels,
  customPageChannels, desktopJobIds, deviceSettingsChannels, hostChannels,
  libraryWorkspaceChannels, localStorageBackupChannels, notesChannels, pushChannels,
  sourcesChannels, systemToolsChannels, workHistoryWorkspaceChannels,
} from './desktop-ipc-channels';

export interface DesktopPluginPackage {
  readonly id: string;
  readonly capabilities: readonly string[];
  readonly channels: readonly string[];
  readonly jobs: readonly string[];
}

export interface DesktopNativeProvider {
  readonly packageId: string;
  readonly capability: string;
  readonly apiVersion: string;
  readonly osGrants: readonly string[];
}

export interface DesktopPluginInventory {
  readonly schemaVersion: 1;
  readonly platform: 'mac';
  readonly packages: readonly DesktopPluginPackage[];
  readonly hostPrimitives: readonly {readonly id: string; readonly channels: readonly string[]}[];
  readonly pushChannels: readonly string[];
  readonly nativeProviders: readonly DesktopNativeProvider[];
}

const values = (group: Readonly<Record<string, string>>): readonly string[] => Object.values(group);

const developmentInventory: DesktopPluginInventory = {
  schemaVersion: 1,
  platform: 'mac',
  packages: [
    {id: 'mote.notes', capabilities: ['notes.read', 'notes.write'], channels: values(notesChannels), jobs: [desktopJobIds.notesDraft]},
    {id: 'mote.library', capabilities: ['library.read', 'memory.read'], channels: values(libraryWorkspaceChannels), jobs: []},
    {id: 'mote.ask', capabilities: ['ask.command'], channels: values(askWorkspaceChannels), jobs: []},
    {id: 'mote.chrome', capabilities: ['chrome.read', 'chrome.manage'], channels: values(chromeChannels), jobs: [desktopJobIds.chromeNativeMessaging]},
    {id: 'mote.sources', capabilities: ['sources.read', 'sources.write'], channels: values(sourcesChannels), jobs: [desktopJobIds.sourcesManager]},
    {id: 'mote.capture', capabilities: ['capture.read', 'capture.write'], channels: values(captureChannels), jobs: [desktopJobIds.captureRuntime]},
    {id: 'mote.device-settings', capabilities: ['device-settings.read', 'device-settings.write'], channels: values(deviceSettingsChannels), jobs: []},
    {id: 'mote.work-history', capabilities: ['work-history.read'], channels: values(workHistoryWorkspaceChannels), jobs: []},
    {id: 'mote.local-storage-backup', capabilities: ['local-storage-backup.manage'], channels: values(localStorageBackupChannels), jobs: []},
    {id: 'mote.system-tools', capabilities: ['system-tools.read', 'system-tools.manage'], channels: values(systemToolsChannels), jobs: [desktopJobIds.systemToolsUpdater]},
    {id: 'mote.capability-publisher', capabilities: ['capability-publisher.manage'], channels: values(capabilityPublisherChannels), jobs: [desktopJobIds.capabilityPublication]},
    {id: 'mote.native-helper', capabilities: ['mote.native-helper'], channels: [], jobs: []},
  ],
  hostPrimitives: [
    {id: 'host.shell', channels: values(hostChannels)},
    {id: 'host.custom-pages', channels: values(customPageChannels)},
  ],
  pushChannels: values(pushChannels),
  nativeProviders: [
    {packageId: 'mote.native-helper', capability: 'mote.native-helper', apiVersion: '1', osGrants: ['screen', 'accessibility', 'calendar']},
  ],
};

/** Strict packaged/development loader. Duplicate ownership, an unknown native
 * provider package, an empty package or a non-`mote:` channel fails the whole
 * inventory; nothing is silently skipped. */
export function loadDesktopPluginInventory(input: unknown): DesktopPluginInventory {
  const value = record(input, 'manifest');
  if (value.schemaVersion !== 1) throw new TypeError('Unsupported plugin inventory schema');
  if (value.platform !== 'mac') throw new TypeError('Plugin inventory platform must be mac');
  const packages = array(value.packages, 'packages').map((entry, index) => parsePackage(entry, `packages[${index}]`));
  const hostPrimitives = array(value.hostPrimitives, 'hostPrimitives').map((entry, index) => {
    const primitive = record(entry, `hostPrimitives[${index}]`);
    return {id: token(primitive.id, `hostPrimitives[${index}].id`), channels: channels(primitive.channels, `hostPrimitives[${index}].channels`)};
  });
  const push = channels(value.pushChannels, 'pushChannels');
  const nativeProviders = array(value.nativeProviders, 'nativeProviders').map((entry, index) => {
    const provider = record(entry, `nativeProviders[${index}]`);
    return {
      packageId: token(provider.packageId, `nativeProviders[${index}].packageId`),
      capability: token(provider.capability, `nativeProviders[${index}].capability`),
      apiVersion: token(provider.apiVersion, `nativeProviders[${index}].apiVersion`),
      osGrants: tokens(provider.osGrants, `nativeProviders[${index}].osGrants`),
    };
  });
  const packageIds = new Set<string>(), capabilities = new Set<string>(), channelsOwned = new Map<string, string>(), jobs = new Set<string>();
  for (const pkg of packages) {
    if (packageIds.has(pkg.id)) throw new TypeError(`Duplicate plugin package ${pkg.id}`);
    packageIds.add(pkg.id);
    if (pkg.capabilities.length === 0) throw new TypeError(`Plugin ${pkg.id} declares no capability`);
    for (const capability of pkg.capabilities) {
      if (capabilities.has(capability)) throw new TypeError(`Capability ${capability} has more than one owner`);
      capabilities.add(capability);
    }
    for (const channel of pkg.channels) {
      const owner = channelsOwned.get(channel);
      if (owner !== undefined) throw new TypeError(`Channel ${channel} is owned by both ${owner} and ${pkg.id}`);
      channelsOwned.set(channel, pkg.id);
    }
    for (const job of pkg.jobs) {
      if (jobs.has(job)) throw new TypeError(`Job ${job} has more than one owner`);
      jobs.add(job);
    }
  }
  for (const primitive of hostPrimitives) for (const channel of primitive.channels) {
    const owner = channelsOwned.get(channel);
    if (owner !== undefined) throw new TypeError(`Channel ${channel} is owned by both ${owner} and ${primitive.id}`);
    channelsOwned.set(channel, primitive.id);
  }
  for (const channel of push) {
    if (channelsOwned.has(channel)) throw new TypeError(`Push channel ${channel} is also invokable`);
    channelsOwned.set(channel, 'host.push');
  }
  for (const provider of nativeProviders) {
    if (!packageIds.has(provider.packageId)) throw new TypeError(`Native provider package ${provider.packageId} is not installed`);
    if (!capabilities.has(provider.capability)) throw new TypeError(`Native provider ${provider.capability} has no package capability`);
  }
  return {
    schemaVersion: 1, platform: 'mac', packages, hostPrimitives, pushChannels: push, nativeProviders,
  };
}

export const defaultDesktopPluginInventory = loadDesktopPluginInventory(developmentInventory);

/** Project the packaged/default native providers into the build-native
 * registry. The registry remains the runtime authority; unknown packages or
 * non-mac platforms were already rejected by the loader. */
export function registerDesktopNativeProviders(
  registry: {register(input: unknown): unknown},
  inventory: DesktopPluginInventory,
  buildId: string,
): void {
  for (const provider of inventory.nativeProviders) registry.register({
    capability: provider.capability,
    apiVersion: provider.apiVersion,
    platform: 'mac',
    buildId,
    osGrants: provider.osGrants,
  });
}

function parsePackage(input: unknown, field: string): DesktopPluginPackage {
  const value = record(input, field);
  return {
    id: token(value.id, `${field}.id`),
    capabilities: tokens(value.capabilities, `${field}.capabilities`),
    channels: channels(value.channels, `${field}.channels`),
    jobs: tokens(value.jobs, `${field}.jobs`),
  };
}
function record(input: unknown, field: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
    throw new TypeError(`Invalid ${field}`);
  return input as Record<string, unknown>;
}
function array(input: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(input)) throw new TypeError(`Invalid ${field}`);
  return input;
}
function token(input: unknown, field: string): string {
  if (typeof input !== 'string' || !input.trim()) throw new TypeError(`Invalid ${field}`);
  return input;
}
function tokens(input: unknown, field: string): readonly string[] {
  return array(input, field).map((value, index) => token(value, `${field}[${index}]`));
}
function channels(input: unknown, field: string): readonly string[] {
  return tokens(input, field).map((value, index) => {
    if (!value.startsWith('mote:')) throw new TypeError(`Invalid ${field}[${index}]`);
    return value;
  });
}
