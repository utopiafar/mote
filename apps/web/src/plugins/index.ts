import type { WebContribution } from '../features/host';
import type { BuiltinWebPlugin } from './types';
import { agentView } from './agent-view';
import { notes } from './notes';
import { system } from './system';
import { home } from './home';
import { search } from './search';
import { ask } from './ask';
import { devices } from './devices';
import { storage } from './storage';
import { sources } from './sources';
import { imports } from './imports';
import { activity } from './activity';
import { processing } from './processing';
import { features } from './features';
import { usage } from './usage';
import { insights } from './insights';
import { actions } from './actions';
import { models } from './models';
import { coding } from './coding';
import { materials } from './materials';
import { reader } from './reader';
import { connections } from './connections';
import { diagnostics } from './diagnostics';
import { capture } from './capture';
import { files } from './files';
import { media } from './media';
import { memory } from './memory';
import { savedRecordViews } from './saved-record-views';
import { sourceMaterialViewsPlugin } from './source-material';
import { ownerQuestions } from './owner-questions';

export type { BuiltinWebPlugin } from './types';

/** Built-in packages stay in the same first-install order the bootstrap used
 * before the registry was split per plugin, so contribution ordering does not
 * change when a plugin file is replaced. */
export const builtinPlugins: readonly BuiltinWebPlugin[] = [
  agentView,
  notes,
  system,
  home,
  search,
  ask,
  devices,
  storage,
  sources,
  imports,
  activity,
  processing,
  features,
  usage,
  insights,
  actions,
  models,
  coding,
  materials,
  reader,
  connections,
  diagnostics,
  capture,
  files,
  media,
  memory,
  savedRecordViews,
  sourceMaterialViewsPlugin,
  ownerQuestions,
];

export const builtinPages = builtinPlugins.flatMap(plugin => plugin.pages ?? []);

export function pluginContributions(plugin: BuiltinWebPlugin): WebContribution[] {
  return [
    ...(plugin.pages ?? []).map(entry => ({ surface: 'page' as const, entry })),
    ...(plugin.collections ?? []).map(entry => ({ surface: 'collection' as const, entry })),
    ...(plugin.home ?? []).map(entry => ({ surface: 'home' as const, entry })),
    ...(plugin.panels ?? []).map(entry => ({ surface: 'panel' as const, entry })),
    ...(plugin.renderers ?? []).map(entry => ({ surface: 'renderer' as const, entry })),
  ];
}
