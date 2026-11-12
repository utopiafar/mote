import type { WebContribution } from '../features/host';
import type { BuiltinWebPlugin } from './types';

/** One build-shipped Web package in the default inventory. The loader is the
 * only way the application obtains a plugin module: feature/bootstrap never
 * statically imports a page, collection or view implementation. */
export interface DefaultWebPluginSource {
  readonly packageId: string;
  readonly exportName: string;
  readonly load: () => Promise<Record<string, unknown>>;
}

/** First-install order from the previous registry. Loading stays lazy per
 * package so a disabled optional plugin is never imported by the shell. */
export const defaultWebPluginSources: readonly DefaultWebPluginSource[] = [
  { packageId: 'mote.agent-view', exportName: 'agentAccess', load: () => import('./agent-access') },
  { packageId: 'mote.assistant', exportName: 'assistant', load: () => import('./assistant') },
  { packageId: 'mote.notes', exportName: 'notes', load: () => import('./notes') },
  { packageId: 'mote.system', exportName: 'system', load: () => import('./system') },
  { packageId: 'mote.home', exportName: 'home', load: () => import('./home') },
  { packageId: 'mote.search', exportName: 'search', load: () => import('./search') },
  { packageId: 'mote.ask', exportName: 'ask', load: () => import('./ask') },
  { packageId: 'mote.devices', exportName: 'devices', load: () => import('./devices') },
  { packageId: 'mote.storage', exportName: 'storage', load: () => import('./maintenance') },
  { packageId: 'mote.sources', exportName: 'sources', load: () => import('./sources') },
  { packageId: 'mote.imports', exportName: 'intake', load: () => import('./intake') },
  { packageId: 'mote.work', exportName: 'work', load: () => import('./work') },
  { packageId: 'mote.processing', exportName: 'processing', load: () => import('./models-processing') },
  { packageId: 'mote.features', exportName: 'features', load: () => import('./features') },
  { packageId: 'mote.usage', exportName: 'usage', load: () => import('./maintenance') },
  { packageId: 'mote.insights', exportName: 'discovery', load: () => import('./discovery') },
  { packageId: 'mote.models', exportName: 'models', load: () => import('./models-processing') },
  { packageId: 'mote.coding', exportName: 'coding', load: () => import('./coding') },
  { packageId: 'mote.library', exportName: 'library', load: () => import('./library') },
  { packageId: 'mote.reader', exportName: 'reader', load: () => import('./reader') },
  { packageId: 'mote.connections', exportName: 'connections', load: () => import('./sources') },
  { packageId: 'mote.diagnostics', exportName: 'diagnostics', load: () => import('./diagnostics') },
  { packageId: 'mote.saved-record-views', exportName: 'savedRecordViews', load: () => import('./saved-record-views') },
  { packageId: 'mote.source-material-views', exportName: 'sourceMaterialViewsPlugin', load: () => import('./source-material') },
  { packageId: 'mote.owner-questions', exportName: 'ownerQuestions', load: () => import('./owner-questions') },
];

export function pluginContributions(plugin: BuiltinWebPlugin): WebContribution[] {
  return [
    ...(plugin.pages ?? []).map(entry => ({ surface: 'page' as const, entry })),
    ...(plugin.collections ?? []).map(entry => ({ surface: 'collection' as const, entry })),
    ...(plugin.home ?? []).map(entry => ({ surface: 'home' as const, entry })),
    ...(plugin.panels ?? []).map(entry => ({ surface: 'panel' as const, entry })),
    ...(plugin.renderers ?? []).map(entry => ({ surface: 'renderer' as const, entry })),
  ];
}

/** Load every default package through its declared loader. A package whose
 * module or export is missing fails the whole default inventory; it is never
 * skipped, and a package id mismatch cannot silently replace another owner. */
export async function loadDefaultWebPlugins(): Promise<readonly BuiltinWebPlugin[]> {
  const plugins: BuiltinWebPlugin[] = [];
  const owners = new Map<string, string>();
  const contributions = new Map<string, string>();
  for (const source of defaultWebPluginSources) {
    const module = await source.load();
    const plugin = parseBuiltinPlugin(module[source.exportName], source.packageId);
    if (owners.has(plugin.id)) throw new Error(`Duplicate default Web plugin: ${plugin.id}`);
    owners.set(plugin.id, plugin.id);
    for (const contribution of pluginContributions(plugin)) {
      const key = `${contribution.surface}:${contribution.entry.id}`;
      const previous = contributions.get(key);
      if (previous !== undefined) throw new Error(`Default Web contribution ${key} is owned by both ${previous} and ${plugin.id}`);
      contributions.set(key, plugin.id);
    }
    plugins.push(plugin);
  }
  return plugins;
}

function parseBuiltinPlugin(raw: unknown, packageId: string): BuiltinWebPlugin {
  if (!raw || typeof raw !== 'object' || typeof (raw as {id?: unknown}).id !== 'string')
    throw new TypeError(`Default Web plugin module ${packageId} does not export a builtin plugin`);
  const plugin = raw as BuiltinWebPlugin;
  if (plugin.id !== packageId)
    throw new TypeError(`Default Web plugin ${packageId} loaded package ${plugin.id}`);
  return plugin;
}
