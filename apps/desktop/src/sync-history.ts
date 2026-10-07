import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { moteText } from '@mote/shared/i18n';
import type { CaptureEvent, Config } from './contracts';
import type { SourceDefinition, SourceItem } from './source-types';
import { UploadSliceYield } from './upload-slice';
import { validateServerUrl } from './config';

export const syncSources = ['screen', 'ui_page', 'note', 'activity', 'notification', 'file', 'calendar', 'coding'] as const;
export type SyncSource = typeof syncSources[number];
export type SyncOutcome = 'sending' | 'received' | 'unconfirmed' | 'interrupted';
export interface SyncHistoryItem {
  key: string; source: SyncSource; title: string; observedAt: string;
  captureId?: string; sourceId?: string; versionKey?: string; layer?: string;
  outcome: SyncOutcome; code?: number; firstReceipt: boolean;
}
export interface SyncHistoryRun {
  id: string; startedAt: string; finishedAt?: string; trigger: 'automatic' | 'manual';
  outcome: 'sending' | 'received' | 'partial' | 'unconfirmed' | 'interrupted';
  bytes: number; total: number; received: number; unconfirmed: number; sources: SyncSource[];
}
export interface SyncHistoryQuery { day: string; days?: 1 | 7; offset?: number; source?: SyncSource; outcome?: 'received' | 'unconfirmed' }
export interface SyncHistoryPage {
  items: SyncHistoryRun[]; total: number; offset: number; nextOffset?: number;
  received: number; bytes: number; since: string;
  days: { day: string; received: number }[]; sources: { source: SyncSource; received: number }[];
}
export interface SyncHistoryContentQuery { runId: string; offset?: number; source?: SyncSource; outcome?: 'received' | 'unconfirmed' }
export interface SourceUploadObserver {
  attempt(source: SourceDefinition, items: SourceItem[]): void;
  settle(source: SourceDefinition, items: SourceItem[], acks: Record<string, unknown>[], rejected?: { item: SourceItem; status: number }[]): void;
  failed(source: SourceDefinition, items: SourceItem[], error: unknown): void;
}
type Connection = Pick<Config, 'serverUrl' | 'deviceId'>;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const sourceVersionKey = (item: Pick<SourceItem, 'externalId' | 'revision'>) => hash(`${item.externalId}\0${item.revision}`);
export function sourceHistoryItem(source: SourceDefinition, item: SourceItem): Omit<SyncHistoryItem, 'outcome' | 'firstReceipt'> {
  const versionKey = sourceVersionKey(item);
  return { key: hash(`${source.id}\0${versionKey}`), source: item.kind === 'message' ? 'coding' : item.kind,
    title: item.title.slice(0, 200), observedAt: item.observedAt, sourceId: source.id, versionKey, layer: item.layer };
}
export function captureHistoryItem(event: CaptureEvent): Omit<SyncHistoryItem, 'outcome' | 'firstReceipt'> {
  // Never persist captured text, notifications, filenames outside filtered source titles, or images here.
  return { key: event.id, source: event.source, title: event.appName.slice(0, 200), observedAt: event.capturedAt, captureId: event.id };
}
function scope(config: Connection): string { return hash(`${(config.serverUrl ? validateServerUrl(config.serverUrl) : '')}\0${config.deviceId}`); }
function offset(value: unknown): number { if (value === undefined) return 0; if (!Number.isSafeInteger(value) || Number(value) < 0) throw Error(moteText('分页参数无效')); return Number(value); }
function validSource(value: unknown): asserts value is SyncSource | undefined { if (value !== undefined && !syncSources.includes(value as SyncSource)) throw Error(moteText('记录来源无效')); }
function validOutcome(value: unknown): void { if (value !== undefined && value !== 'received' && value !== 'unconfirmed') throw Error(moteText('同步结果筛选无效')); }
export function historyRange(day: string, days: 1 | 7 = 1): { after: string; before: string; days: string[] } {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || ![1, 7].includes(days)) throw Error(moteText('请选择有效日期'));
  const [y, m, d] = day.split('-').map(Number), end = new Date(y, m - 1, d);
  if (y < 2000 || y > 2100 || end.getFullYear() !== y || end.getMonth() !== m - 1 || end.getDate() !== d) throw Error(moteText('请选择有效日期'));
  const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const dates = Array.from({ length: days }, (_, i) => new Date(y, m - 1, d - days + 1 + i));
  return { after: dates[0].toISOString(), before: new Date(y, m - 1, d + 1).toISOString(), days: dates.map(localDay) };
}
const PAGE_SIZE = 20;
const RETENTION = 30 * 86400000;

/** Receipt metadata only. Content remains in its authorized queue or central archive. */
export class SyncHistory {
  private db!: DatabaseSync;
  private active = new Map<string, number>();
  private lastPruned = 0;
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {}
  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    await chmod(this.path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, scope TEXT NOT NULL, started TEXT NOT NULL, finished TEXT, trigger TEXT NOT NULL, outcome TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS runs_scope_time ON runs(scope,started DESC,id);
      CREATE TABLE IF NOT EXISTS items (run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, key TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, observed TEXT NOT NULL, capture_id TEXT, source_id TEXT, version_key TEXT, layer TEXT, outcome TEXT NOT NULL, code INTEGER, first_receipt INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(run_id,key));
      CREATE INDEX IF NOT EXISTS items_run_source ON items(run_id,source,outcome);
      CREATE TABLE IF NOT EXISTS confirmed (scope TEXT NOT NULL, key TEXT NOT NULL, source TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(scope,key));
      CREATE INDEX IF NOT EXISTS confirmed_scope_time ON confirmed(scope,at,source);`);
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES(?,?)').run('since', new Date(this.now()).toISOString());
    this.db.exec("UPDATE items SET outcome='interrupted' WHERE outcome='sending'; UPDATE runs SET outcome='interrupted' WHERE finished IS NULL;");
    this.prune();
  }
  private transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  private prune(): void {
    const cutoff = new Date(this.now() - RETENTION).toISOString();
    this.transaction(() => { this.db.prepare('DELETE FROM runs WHERE started<? AND id NOT IN (SELECT run_id FROM items WHERE outcome=?)').run(cutoff, 'sending'); this.db.prepare('DELETE FROM confirmed WHERE at<?').run(cutoff); });
    this.lastPruned = this.now();
  }
  begin(config: Connection, trigger: 'automatic' | 'manual'): string {
    if (this.now() - this.lastPruned >= 3600000) this.prune();
    const id = randomUUID();
    this.db.prepare('INSERT INTO runs(id,scope,started,trigger,outcome) VALUES(?,?,?,?,?)').run(id, scope(config), new Date(this.now()).toISOString(), trigger, 'sending'); this.active.set(id, 0); return id;
  }
  addBytes(id: string, bytes: number): void { if (this.active.has(id)) this.active.set(id, this.active.get(id)! + bytes); }
  attempt(id: string, items: Omit<SyncHistoryItem, 'outcome' | 'firstReceipt'>[]): void {
    const insert = this.db.prepare("INSERT INTO items(run_id,key,source,title,observed,capture_id,source_id,version_key,layer,outcome) VALUES(?,?,?,?,?,?,?,?,?,'sending') ON CONFLICT(run_id,key) DO UPDATE SET outcome=CASE WHEN outcome='received' THEN outcome ELSE 'sending' END,code=NULL");
    this.transaction(() => { for (const item of items) insert.run(id, item.key, item.source, item.title, item.observedAt, item.captureId ?? null, item.sourceId ?? null, item.versionKey ?? null, item.layer ?? null); });
  }
  settle(id: string, key: string, received: boolean, captureId?: string, code?: number, interrupted = false): void {
    this.transaction(() => {
      const run = this.db.prepare('SELECT scope FROM runs WHERE id=?').get(id) as { scope: string } | undefined;
      const item = this.db.prepare('SELECT source,outcome FROM items WHERE run_id=? AND key=?').get(id, key) as { source: string; outcome: SyncOutcome } | undefined;
      if (!run || !item) return;
      // A queue cleanup failure cannot revoke a previously validated remote ACK.
      if (!received && item.outcome === 'received') return;
      const first = received ? Number(this.db.prepare('INSERT OR IGNORE INTO confirmed VALUES(?,?,?,?)').run(run.scope, key, item.source, new Date(this.now()).toISOString()).changes) : 0;
      this.db.prepare('UPDATE items SET outcome=?,capture_id=coalesce(?,capture_id),code=?,first_receipt=max(first_receipt,?) WHERE run_id=? AND key=?').run(received ? 'received' : interrupted ? 'interrupted' : 'unconfirmed', captureId ?? null, code ?? null, first, id, key);
      this.db.prepare('UPDATE runs SET bytes=? WHERE id=?').run(this.active.get(id) ?? 0, id);
    });
  }
  finish(id: string, interrupted = false): void {
    this.transaction(() => {
      this.db.prepare("UPDATE items SET outcome=? WHERE run_id=? AND outcome='sending'").run(interrupted ? 'interrupted' : 'unconfirmed', id);
      const row = this.db.prepare("SELECT count(*) total,sum(outcome='received') received FROM items WHERE run_id=?").get(id) as { total: number; received: number };
      if (!row.total) this.db.prepare('DELETE FROM runs WHERE id=?').run(id);
      else this.db.prepare('UPDATE runs SET finished=?,bytes=?,outcome=? WHERE id=?').run(new Date(this.now()).toISOString(), this.active.get(id) ?? 0, interrupted ? 'interrupted' : row.received === row.total ? 'received' : row.received ? 'partial' : 'unconfirmed', id);
    }); this.active.delete(id);
  }
  observer(id: string): SourceUploadObserver {
    return {
      attempt: (source, items) => this.attempt(id, items.map(item => sourceHistoryItem(source, item))),
      settle: (source, items, acks, rejected = []) => {
        for (const item of items) { const ack = acks.find(a => a.externalId === item.externalId && a.revision === item.revision), rejection = rejected.find(r => r.item.externalId === item.externalId && r.item.revision === item.revision); this.settle(id, sourceHistoryItem(source, item).key, Boolean(ack), ack ? String(ack.id) : undefined, rejection?.status); }
      },
      failed: (source, items, error) => { for (const item of items) this.settle(id, sourceHistoryItem(source, item).key, false, undefined, typeof (error as { httpStatus?: unknown })?.httpStatus === 'number' ? (error as { httpStatus: number }).httpStatus : undefined, (error as Error)?.name === 'AbortError' || error instanceof UploadSliceYield); },
    };
  }
  page(config: Connection, input: SyncHistoryQuery): SyncHistoryPage {
    const range = historyRange(input?.day, input?.days), start = offset(input.offset); validSource(input.source); validOutcome(input.outcome);
    const ownScope = scope(config), conditions = ['r.scope=?', 'r.started>=?', 'r.started<?', 'EXISTS(SELECT 1 FROM items i WHERE i.run_id=r.id)'], params: (string | number)[] = [ownScope, range.after, range.before];
    if (input.source) { conditions.push('EXISTS(SELECT 1 FROM items i WHERE i.run_id=r.id AND i.source=?)'); params.push(input.source); }
    if (input.outcome) { conditions.push(input.outcome === 'received' ? "r.outcome='received'" : "r.outcome IN ('partial','unconfirmed','interrupted')"); }
    const where = conditions.join(' AND '), total = Number(this.db.prepare(`SELECT count(*) n FROM runs r WHERE ${where}`).get(...params)!.n);
    const ids = this.db.prepare(`SELECT r.id FROM runs r WHERE ${where} ORDER BY r.started DESC,r.id DESC LIMIT ? OFFSET ?`).all(...params, PAGE_SIZE, start) as { id: string }[];
    const countRange = (after: string, before: string) => Number(this.db.prepare('SELECT count(*) n FROM confirmed WHERE scope=? AND at>=? AND at<?').get(ownScope, after, before)!.n);
    return { items: ids.map(({ id }) => this.run(config, id)), total, offset: start, ...(start + PAGE_SIZE < total ? { nextOffset: start + PAGE_SIZE } : {}),
      received: countRange(range.after, range.before), bytes: Number(this.db.prepare('SELECT coalesce(sum(bytes),0) n FROM runs WHERE scope=? AND started>=? AND started<?').get(ownScope, range.after, range.before)!.n), since: String(this.db.prepare("SELECT value FROM meta WHERE key='since'").get()!.value),
      days: range.days.map(day => { const d = historyRange(day); return { day, received: countRange(d.after, d.before) }; }),
      sources: this.db.prepare('SELECT source,count(*) received FROM confirmed WHERE scope=? AND at>=? AND at<? GROUP BY source').all(ownScope, range.after, range.before) as { source: SyncSource; received: number }[] };
  }
  run(config: Connection, id: string): SyncHistoryRun {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw Error(moteText('记录标识无效'));
    const row = this.db.prepare('SELECT * FROM runs WHERE id=? AND scope=?').get(id, scope(config)) as { id: string; started: string; finished: string | null; trigger: 'automatic' | 'manual'; outcome: SyncHistoryRun['outcome']; bytes: number } | undefined;
    if (!row) throw Error(moteText('同步凭据不存在或已过期'));
    const total = this.db.prepare("SELECT count(*) total,coalesce(sum(outcome='received'),0) received,coalesce(sum(outcome IN ('unconfirmed','interrupted')),0) unconfirmed FROM items WHERE run_id=?").get(id) as { total: number; received: number; unconfirmed: number };
    return { id, startedAt: row.started, finishedAt: row.finished ?? undefined, trigger: row.trigger, outcome: row.outcome, bytes: this.active.get(id) ?? row.bytes, ...total, sources: (this.db.prepare('SELECT DISTINCT source FROM items WHERE run_id=?').all(id) as { source: SyncSource }[]).map(r => r.source) };
  }
  contents(config: Connection, input: SyncHistoryContentQuery): { run: SyncHistoryRun; items: SyncHistoryItem[]; total: number; offset: number; nextOffset?: number } {
    const run = this.run(config, input?.runId), start = offset(input.offset); validSource(input.source); validOutcome(input.outcome);
    const where = ['run_id=?'], params: (string | number)[] = [run.id];
    if (input.source) { where.push('source=?'); params.push(input.source); }
    if (input.outcome) { where.push(input.outcome === 'received' ? "outcome='received'" : "outcome IN ('unconfirmed','interrupted')"); }
    const clause = where.join(' AND '), total = Number(this.db.prepare(`SELECT count(*) n FROM items WHERE ${clause}`).get(...params)!.n);
    const rows = this.db.prepare(`SELECT key,source,title,observed AS observedAt,capture_id AS captureId,source_id AS sourceId,version_key AS versionKey,layer,outcome,code,first_receipt AS firstReceipt FROM items WHERE ${clause} ORDER BY observed DESC,key LIMIT ? OFFSET ?`).all(...params, PAGE_SIZE, start);
    return { run, items: rows.map(row => ({ ...row, captureId: row.captureId ?? undefined, sourceId: row.sourceId ?? undefined, versionKey: row.versionKey ?? undefined, layer: row.layer ?? undefined, code: row.code ?? undefined, firstReceipt: Boolean(row.firstReceipt) })) as SyncHistoryItem[], total, offset: start, ...(start + PAGE_SIZE < total ? { nextOffset: start + PAGE_SIZE } : {}) };
  }
  item(config: Connection, runId: string, key: string): SyncHistoryItem { this.run(config, runId); if (typeof key !== 'string' || key.length > 128) throw Error(moteText('记录标识无效')); const row = this.db.prepare('SELECT * FROM items WHERE run_id=? AND key=?').get(runId, key); if (!row) throw Error(moteText('同步凭据不存在或已过期')); return { key: String(row.key), source: row.source as SyncSource, title: String(row.title), observedAt: String(row.observed), captureId: row.capture_id ? String(row.capture_id) : undefined, sourceId: row.source_id ? String(row.source_id) : undefined, versionKey: row.version_key ? String(row.version_key) : undefined, layer: row.layer ? String(row.layer) : undefined, outcome: row.outcome as SyncOutcome, code: row.code ? Number(row.code) : undefined, firstReceipt: Boolean(row.first_receipt) }; }
  receivedCapture(config: Connection, key: string): string | undefined { const row = this.db.prepare("SELECT i.capture_id FROM items i JOIN runs r ON r.id=i.run_id WHERE r.scope=? AND i.key=? AND i.outcome='received' AND i.capture_id IS NOT NULL ORDER BY r.started DESC LIMIT 1").get(scope(config),key); return row?.capture_id ? String(row.capture_id) : undefined; }
  close(): void { this.db.close(); }
}
