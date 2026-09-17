import { moteText } from '@mote/shared/i18n';
export type SourceRetention = 'snapshot' | 'reference' | 'archive';
export interface SourceDefinition {
  initialSync?: 'all' | 'new_only';
  id: string; name: string; kind: 'local-calendar' | 'local-files' | 'coding-agent'; deviceId: string;
  platform: 'macos' | 'import'; retention: SourceRetention; enabled: boolean;
}
export interface SourceItem {
  localOriginalBase64?: string;
  metadata?: import('@mote/shared').SourceMetadata;
  externalId: string; revision: string; observedAt: string; modifiedAt?: string;
  title: string; text: string; uri?: string; kind: 'calendar' | 'file' | 'message';
  document?: import('@mote/shared').SourceDocument;
  layer: 'snapshot'|'reference'|'original'; mimeType?: string; deleted?: boolean;
  calendar?: { start: string; end: string; allDay: boolean; timeZone?: string; status: 'confirmed' | 'tentative' | 'cancelled' };
}
export type ScannedItem = Omit<SourceItem, 'revision' | 'observedAt'>;
export interface SourceScan {
  checkpoint?: import('./coding-agents').CodingCheckpoint;
  items: ScannedItem[]; seen: string[]; complete: boolean; skipped: number;
  scope?: { start: string; end: string };
}
export interface SourceOptions {
  indexMode?: 'full'|'lightweight'; allowRead?:boolean;
  initialSync?: 'all' | 'new_only';
  retention: SourceRetention; intervalSeconds: number; trackDeletions: boolean;
  extensions: string[]; excludedPaths: string[]; redactLiterals: string[];
}
export interface LocalSource extends SourceDefinition, SourceOptions {
  path?: string; calendarId?: string; agent?: 'claude' | 'codex' | 'kimi';
}
export interface SourceStatus {
  source: LocalSource; state: 'idle' | 'syncing' | 'paused' | 'error' | 'permission_required';
  message: string; pending: number; lastSyncAt?: string; items: number; skipped: number;
}
export interface CalendarChoice { id: string; title: string }
export type SourceRequest = (path: string, body: unknown, method: 'GET' | 'POST' | 'PUT' | 'PATCH', signal?: AbortSignal) => Promise<unknown>;
export const DEFAULT_SOURCE_OPTIONS: SourceOptions = {
  initialSync: 'all', retention: 'snapshot', intervalSeconds: 300, trackDeletions: false,
  extensions: ['.md', '.txt', '.json', '.csv', '.ics', '.pdf', '.docx', '.wav', '.mp3', '.m4a'], excludedPaths: [], redactLiterals: [],
};
export function normalizeSourceOptions(input: unknown): SourceOptions {
  if (!input || typeof input !== 'object') throw new Error(moteText("来源配置无效"));
  const v = input as SourceOptions;
  if(v.initialSync!==undefined&&!['all','new_only'].includes(v.initialSync))throw new Error(moteText("首次同步范围无效"));
  if (!['snapshot', 'reference', 'archive'].includes(v.retention) || !Number.isInteger(v.intervalSeconds) || v.intervalSeconds < 30 || v.intervalSeconds > 3600 || typeof v.trackDeletions !== 'boolean') throw new Error(moteText("来源同步间隔为 30–3600 秒，保留方式为快照或引用"));
  const list = (value: unknown, max: number) => {
    if (!Array.isArray(value) || value.length > 100 || value.some(x => typeof x !== 'string' || x.length === 0 || x.length > max || /[\x00-\x1f]/.test(x))) throw new Error(moteText("来源过滤列表无效（最多 100 项）"));
    return [...new Set(value)] as string[];
  };
  const extensions = list(v.extensions, 20).map(s => s.toLowerCase());
  if (!extensions.length || extensions.some(x => !/^\.[a-z0-9]+$/.test(x))) throw new Error(moteText("请填写扩展名，例如 .md,.txt"));
  const excludedPaths = list(v.excludedPaths, 1000).map(s => s.replace(/\\/g, '/').replace(/\/$/, ''));
  if (excludedPaths.some(p => p.startsWith('/') || p.split('/').some(x => !x || x === '.' || x === '..'))) throw new Error(moteText("排除路径必须是所选目录内的相对路径"));
  if(v.retention==='archive'&&Array.isArray(v.redactLiterals)&&v.redactLiterals.length)throw new Error(moteText("原件归档不能应用文字遮盖，请选择内容索引。"));
  if(v.indexMode!==undefined&&!['full','lightweight'].includes(v.indexMode)||v.allowRead!==undefined&&typeof v.allowRead!=='boolean')throw new Error('Invalid file index policy');
  return {indexMode:v.indexMode??'full',allowRead:v.allowRead??false, initialSync:v.initialSync??'all', retention: v.retention, intervalSeconds: v.intervalSeconds, trackDeletions: v.trackDeletions, extensions, excludedPaths, redactLiterals: list(v.redactLiterals, 1000) };
}
export function redactSourceText(text: string, literals: string[]): string {
  for (const literal of [...literals].sort((a, b) => b.length - a.length)) text = text.split(literal).join(moteText("[已遮盖]"));
  return text;
}
