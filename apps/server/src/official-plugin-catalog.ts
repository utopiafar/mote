import type {PluginCatalogEntry} from '@mote/shared';

/** A catalog entry may also name a fixed directory in this repository. Only
 * this server-side declaration can select a local artifact; resolve/install
 * requests still carry just {repository, tag}. */
export type OfficialPluginCatalogEntry=PluginCatalogEntry&{readonly localDirectory?:string};

/** Fixed artifacts for the official plugin catalog.
 * Free-form GitHub install stays under Settings → 运行与诊断.
 * Mem0 / Hindsight remain Memory recipes via the generic worker ABI; their
 * upstream releases must ship a Mote-compatible mote-plugin.json asset. */
export const OFFICIAL_PLUGIN_CATALOG: readonly OfficialPluginCatalogEntry[] = Object.freeze([
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
    repository: 'mote/official-fixture-connector',
    tag: 'v0.1.0',
    localDirectory: 'test-fixtures/official-fixture-connector',
    name: '官方连接器夹具',
    description: '验收用最小官方连接器：安装后在「添加来源」声明式出现入口',
    group: 'connectors',
    runtime: 'service',
    packageId: 'mote.official.fixture-connector',
  },
]);

/** Public catalog projection. A repository-relative artifact location stays
 * server-side; clients only receive the pinned synthetic identity. */
export function officialPluginCatalog(): PluginCatalogEntry[] {
  return OFFICIAL_PLUGIN_CATALOG.map(({localDirectory:_localDirectory,...entry})=>({...entry}));
}

/** Exact identity match for an in-repository official artifact. A wrong tag is
 * deliberately not matched: callers must reject it instead of falling through
 * to a same-named GitHub repository. */
export function officialLocalPluginEntry(repository:string,tag:string|undefined):(OfficialPluginCatalogEntry&{localDirectory:string})|undefined {
  return OFFICIAL_PLUGIN_CATALOG.find(value=>value.repository===repository&&value.localDirectory&&value.tag===tag) as (OfficialPluginCatalogEntry&{localDirectory:string})|undefined;
}

export function isOfficialLocalPluginRepository(repository:string):boolean {
  return OFFICIAL_PLUGIN_CATALOG.some(value=>value.repository===repository&&Boolean(value.localDirectory));
}
