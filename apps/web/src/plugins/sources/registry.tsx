import type { PluginCenterView, RecordingStatus, SourceConnection } from '@mote/shared';
import { moteText } from '@mote/shared/i18n';
import type { LucideIcon } from 'lucide-react';
import { CalendarDays, FileText, Link2, Mail } from 'lucide-react';
import type { ReactNode } from 'react';
import { errorMessage, type Api } from '../../api';
import { McpImportSettings } from '../../McpImportSettings';
import { recordingSourceStatus } from '../../recording-status';
import { RecordingConnection } from '../../RecordingsSettings';
import { useResource } from '../../useResource';
import { Gmail } from './Gmail';
import { GoogleCalendarSettings } from './GoogleCalendarSettings';
import { LarkSettings } from './LarkSettings';
import { Loading } from '../../Loading';
import {BundledConnector} from './BundledConnector';
import {OfficialConnectorSettings,officialConnectorDefinitions,type OfficialProvider} from './OfficialConnectorSettings';

export type SourceCatalogStatus = Record<string, unknown> | null;

/** One source plugin contributes its catalog card, setup form and the exact
 * account-wide settings surface. The source directory only composes these
 * contributions; provider code stays in the owning plugin package. */
export interface SourcePlugin {
  readonly id: string;
  readonly packageId?: string;
  readonly kinds: readonly string[];
  /** Exact key in GET /api/connectors/status, when the plugin binds an account. */
  readonly binding?: string;
  readonly catalog?: {
    readonly title: () => string;
    readonly body: () => string;
    readonly note: () => string;
    readonly state: (context: SourcePluginStateContext) => string;
    readonly target: { readonly pageId: string; readonly href: string };
    readonly icon: LucideIcon;
    readonly setupChoice?: { readonly id: string; readonly title: () => string };
  };
  readonly setup?: {
    readonly id: string;
    readonly render: (context: SourcePluginSetupContext) => ReactNode;
  };
  readonly settings?: (context: SourcePluginSettingsContext) => ReactNode;
  readonly disconnectReview?: (context: SourcePluginSettingsContext) => readonly string[];
}

export interface SourcePluginStateContext {
  readonly catalog: SourceCatalogStatus;
  readonly sources: readonly SourceConnection[];
  readonly plugins?: PluginCenterView;
}

export interface SourcePluginSetupContext {
  readonly api: Api;
  readonly catalog: SourceCatalogStatus;
  readonly refresh: () => Promise<void>;
  readonly requested: boolean;
}

export interface SourcePluginSettingsContext {
  readonly api: Api;
  readonly source: SourceConnection;
  readonly catalog: SourceCatalogStatus;
  readonly refresh: () => Promise<void>;
  readonly onSources: () => void;
  readonly onOpen: (ref: string) => void;
}

export type SourcePluginConnectorStatus = {
  configured?: boolean;
  connected?: boolean;
  account?: string;
  state?: string;
  missingScopes?: string[];
  documentSync?: { sourceId?: string };
  sourceId?: string;
  category?: string;
  selected?:{sourceId:string}[];
  archiveAuthorized?:boolean;
  readScopesOk?:boolean;
};

const statusFor = (plugin: SourcePlugin, catalog: SourceCatalogStatus): SourcePluginConnectorStatus | undefined =>
  plugin.binding ? catalog?.[plugin.binding] as SourcePluginConnectorStatus | undefined : undefined;

/** Enabled, bound and authorization stay separate facts. A paused source is
 * never presented as unauthenticated, and a missing status stays unknown. */
export function sourcePluginState(plugin: SourcePlugin, context: SourcePluginStateContext): 'connected' | 'permission_required' | 'unauthenticated' | 'paused' | 'unknown' {
  const sources = context.sources.filter(source => plugin.kinds.includes(source.kind));
  if (sources.length > 0 && !sources.some(source => source.enabled)) return 'paused';
  const status = statusFor(plugin, context.catalog);
  if (!status) return 'unknown';
  if (status.state === 'permission_required' || Boolean(status.missingScopes?.length) || status.readScopesOk===false) return 'permission_required';
  if (plugin.packageId && status.archiveAuthorized===false) return 'unauthenticated';
  if (status.connected) return 'connected';
  return 'unauthenticated';
}

export function sourcePluginStateLabel(plugin: SourcePlugin, context: SourcePluginStateContext): string {
  return {
    connected: moteText('已连接'),
    permission_required: moteText('需要重新授权'),
    unauthenticated: moteText('尚未授权'),
    paused: moteText('已暂停'),
    unknown: moteText('待确认'),
  }[sourcePluginState(plugin, context)];
}

/** The source's account binding is only trusted when the plugin reports that
 * exact source; a status for another account never authorizes this visit. */
export function sourcePluginBound(plugin: SourcePlugin, source: SourceConnection, catalog: SourceCatalogStatus): boolean {
  const status = statusFor(plugin, catalog);
  if (!status) return false;
  if (plugin.packageId) return Boolean(status.connected&&status.selected?.some(item=>item.sourceId===source.id));
  if (plugin.binding?.endsWith('-recordings')) return status.sourceId === source.id;
  if (source.kind === 'lark-docs') return status.documentSync?.sourceId === source.id;
  return Boolean(status.connected);
}

const gmailPlugin: SourcePlugin = {
  id: 'mote.connector.gmail',
  kinds: ['gmail'],
  binding: 'gmail',
  catalog: {
    title: () => moteText('Gmail 邮件'),
    body: () => moteText('只读同步已选择的邮件'),
    note: () => moteText('只读接入；先准备 Google OAuth 配置。'),
    state: context => sourcePluginStateLabel(gmailPlugin, context),
    target: { pageId: 'sources', href: '#/connections?setup=gmail' },
    icon: Mail,
    setupChoice: { id: 'gmail', title: () => 'Gmail' },
  },
  setup: {
    id: 'gmail',
    render: ({ api, refresh, requested }) => requested?<BundledConnector api={api} id="gmail"><Gmail api={api} refresh={refresh} initiallyOpen/></BundledConnector>:null,
  },
  settings: ({ api, refresh }) => <BundledConnector api={api} id="gmail"><Gmail api={api} refresh={refresh} initiallyOpen/></BundledConnector>,
};

const googleCalendarPlugin: SourcePlugin = {
  id: 'mote.connector.google-calendar',
  kinds: ['google-calendar'],
  binding: 'google',
  catalog: {
    title: () => 'Google Calendar',
    body: () => moteText('只读同步已选择的日历'),
    note: () => moteText('只读接入；与 Mote 行动建议写入日历分开。'),
    state: context => sourcePluginStateLabel(googleCalendarPlugin, context),
    target: { pageId: 'sources', href: '#/connections?setup=google' },
    icon: CalendarDays,
    setupChoice: { id: 'google', title: () => 'Google Calendar' },
  },
  setup: {
    id: 'google',
    render: ({ api, catalog, refresh }) => <GoogleCalendarSettings api={api} status={catalog?.google as { configured: boolean; connected: boolean; writeConnected?: boolean; state: string; account?: string } | undefined} refresh={refresh}/>,
  },
  settings: ({ api, catalog, refresh }) => <GoogleCalendarSettings api={api} status={catalog?.google as { configured: boolean; connected: boolean; writeConnected?: boolean; state: string; account?: string } | undefined} refresh={refresh}/>,
};

const larkPlugin: SourcePlugin = {
  id: 'mote.connector.lark',
  kinds: ['lark-docs', 'lark-calendar'],
  binding: 'lark',
  catalog: {
    title: () => moteText('飞书文档与日历'),
    body: () => moteText('选择账号、历史范围和持续同步'),
    note: () => moteText('中央只读同步，默认回溯 30 天、每 15 分钟检查。与录音授权分开。'),
    state: context => sourcePluginStateLabel(larkPlugin, context),
    target: { pageId: 'lark', href: '#/connections/lark' },
    icon: FileText,
  },
  settings: ({ api, onSources }) => <LarkSettings api={api} onSources={onSources}/>,
  disconnectReview: () => [moteText('断开会停止读取并暂停这些来源，保留已归档资料。飞书端授权及 CLI 凭据仍保留，可在飞书中单独撤销。')],
};

const mcpPlugin: SourcePlugin = {
  id: 'mote.connector.mcp',
  kinds: ['mcp'],
  binding: 'mcp',
  catalog: {
    title: () => moteText('MCP 资料服务'),
    body: () => moteText('从服务已列出的可读资源中导入'),
    note: () => moteText('填写地址后选择资源，不自动调用外部写入工具。'),
    state: () => moteText('选择可读资源导入'),
    target: { pageId: 'sources', href: '#/connections?setup=mcp' },
    icon: Link2,
    setupChoice: { id: 'mcp', title: () => moteText('MCP 资料服务') },
  },
  setup: {
    id: 'mcp',
    render: ({ api, refresh }) => <McpImportSettings api={api} refresh={refresh}/>,
  },
};

function officialSourcePlugin(provider:OfficialProvider):SourcePlugin{
 const definition=officialConnectorDefinitions[provider];
 const plugin:SourcePlugin={id:definition.packageId,packageId:definition.packageId,kinds:[definition.kind],binding:definition.id,
  catalog:{title:definition.name,body:()=>moteText('只读归档已选择的内容，按原始身份保留版本。'),note:()=>moteText('安装不等于授权。请先在插件中心完成配置和启用，再连接账号并选择读取范围。'),
   state:context=>!context.plugins?moteText('待确认'):!context.plugins.sourceContributions?.some(item=>item.contributionId===definition.id)?moteText('尚未安装'):!context.catalog?.[definition.id]?moteText('已安装，待配置'):sourcePluginStateLabel(plugin,context),
   target:{pageId:'sources',href:'#/connections?setup='+definition.id},icon:provider==='notion'?FileText:Link2,setupChoice:{id:definition.id,title:definition.name}},
  setup:{id:definition.id,render:({api,refresh,requested})=>requested?<OfficialConnectorSettings api={api} provider={provider} refresh={refresh}/>:null},
  settings:({api,source,refresh})=><OfficialConnectorSettings api={api} provider={provider} sourceId={source.id} refresh={refresh}/>,
 };
 return plugin;
}
export const sourcePlugins: readonly SourcePlugin[] = [larkPlugin, gmailPlugin, googleCalendarPlugin, mcpPlugin,officialSourcePlugin('notion')];

export function sourcePluginForSetup(id: string): SourcePlugin | undefined {
  return sourcePlugins.find(plugin => plugin.setup?.id === id);
}

/** Recording providers are deployed independently; their plugin identity is
 * derived from the same provider/status-key contract as recordingManifest. */
export function recordingSourcePlugin(provider: string, status?: RecordingStatus): SourcePlugin {
  return {
    id: `mote.connector.${provider}-recordings`,
    kinds: [`${provider}.recordings`],
    binding: `${provider}-recordings`,
    settings: ({ api, source, catalog, onOpen }) => <RecordingSourceConnection api={api} sourceId={source.id} provider={provider} status={(catalog?.[`${provider}-recordings`] as RecordingStatus | undefined) ?? status} onOpen={onOpen}/>,
  };
}

export function sourcePluginFor(source: SourceConnection, catalog: SourceCatalogStatus): SourcePlugin | undefined {
  const recording = recordingSourceStatus(source, catalog);
  if (recording) return recordingSourcePlugin(recording.provider, recording.status);
  return sourcePlugins.find(plugin => plugin.kinds.includes(source.kind));
}

export function sourcePluginStatus(plugin: SourcePlugin, catalog: SourceCatalogStatus): SourcePluginConnectorStatus | undefined {
  return statusFor(plugin, catalog);
}

function RecordingSourceConnection({ api, sourceId, provider, status, onOpen }: { api: Api; sourceId: string; provider: string; status?: RecordingStatus; onOpen: (ref: string) => void }) {
  const page = useResource<RecordingStatus>(api, '/api/connectors/' + encodeURIComponent(provider) + '-recordings', 3000);
  if (page.error) return <div><p role="alert">{moteText('状态读取失败。')}</p><details className="source-final-diagnostics"><summary>{moteText('技术详情')}</summary><pre>{errorMessage(page.error)}</pre></details></div>;
  const current = page.data ?? status;
  if (!current) return <Loading/>;
  if (current.provider !== provider || current.sourceId !== sourceId) return <p role="status">{moteText('此来源未绑定当前录音账号')}</p>;
  return <div className="source-connection-embedded final-source-connector"><RecordingConnection api={api} provider={provider} onOpen={onOpen}/></div>;
}
