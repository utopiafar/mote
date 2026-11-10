import type {PluginCatalogEntry} from '@mote/shared';

/** Mainline-signed fixed artifacts for the official plugin catalog.
 * Free-form GitHub install stays under Settings → 运行与诊断.
 * Mem0 / Hindsight remain Memory recipes via the generic worker ABI; their
 * upstream releases must ship a Mote-compatible mote-plugin.json asset. */
export const OFFICIAL_PLUGIN_CATALOG: readonly PluginCatalogEntry[] = Object.freeze([
  {
    repository: 'mem0ai/mem0',
    tag: 'ts-v3.3.1',
    name: 'Mem0',
    description: '外部正文与检索模块（官方 Memory 配方）',
    group: 'memory',
    runtime: 'worker',
    packageId: 'mote.mem0',
  },
  {
    repository: 'vectorize-io/hindsight',
    tag: 'v0.10.2',
    name: 'Hindsight',
    description: '外部完整引擎（官方 Memory 配方）',
    group: 'memory',
    runtime: 'worker',
    packageId: 'mote.hindsight',
  },
  {
    repository: 'utopiafar/mote-official-fixture-connector',
    tag: 'v0.1.0',
    name: '官方连接器夹具',
    description: '验收用最小官方连接器：安装后在「添加来源」声明式出现入口',
    group: 'connectors',
    runtime: 'service',
    packageId: 'mote.official.fixture-connector',
  },
]);

export function officialPluginCatalog(): PluginCatalogEntry[] {
  return OFFICIAL_PLUGIN_CATALOG.map(entry => ({...entry}));
}
