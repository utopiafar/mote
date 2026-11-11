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
  {
    repository: 'mote/official-notion-connector',
    tag: 'v0.1.0',
    localDirectory: 'official-plugins/notion',
    name: 'Notion 只读',
    description: '只读归档已选择的页面或数据库（官方连接器）',
    group: 'connectors',
    runtime: 'service',
    packageId: 'mote.official.notion',
  },
  {
    repository: 'mote/official-slack-connector',
    tag: 'v0.1.0',
    localDirectory: 'official-plugins/slack',
    name: 'Slack 归档',
    description: '个人 Slack 归档；发送需第二次授权并经行动平台逐条确认',
    group: 'connectors',
    runtime: 'service',
    packageId: 'mote.official.slack',
  },
  {
    repository: 'mote/official-feishu-session-connector',
    tag: 'v0.1.0',
    localDirectory: 'official-plugins/feishu-session',
    name: '飞书会话',
    description: '在已有飞书账号上归档已勾选会话；发送需第二次授权并经行动平台逐条确认',
    group: 'connectors',
    runtime: 'service',
    packageId: 'mote.official.feishu-session',
  },
  {
    repository: 'mote/official-markdown-export',
    tag: 'v0.1.0',
    localDirectory: 'official-plugins/markdown-export',
    name: 'Markdown / Obsidian 导出',
    description: '按游标把已选来源连续写入本地文件夹或 Obsidian vault（官方出站包）',
    group: 'outbound-processing',
    runtime: 'service',
    packageId: 'mote.official.markdown-export',
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
