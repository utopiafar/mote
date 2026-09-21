import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, renameSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { encodeLocalContent, decodeLocalContent } from './local-content';

export type StatePatch = { section: string; key: string; value?: unknown };
const maps = new Set(['known', 'delivered', 'predecessors']);
export function sourceStatePatch(previous: Record<string, unknown>, next: Record<string, unknown>): StatePatch[] {
  const changes: StatePatch[] = [];
  for (const section of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (previous[section] === next[section]) continue;
    if (maps.has(section)) {
      const before = (previous[section] ?? {}) as Record<string, unknown>, after = (next[section] ?? {}) as Record<string, unknown>;
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (before[key] !== after[key]) changes.push({ section, key, value: after[key] });
      }
    } else changes.push({ section: 'state', key: section, value: next[section] });
  }
  return changes;
}
/** The outbox, delivered revisions and scan checkpoint commit together. JSON is only a migration input. */
export function sourceState(path: string, patches?: StatePatch[], maximum?: number): Record<string, unknown> | undefined {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const databasePath = path + '.sqlite', migrating = existsSync(path);
  const legacy = migrating ? JSON.parse(decodeLocalContent(readFileSync(path)).toString()) : undefined;
  const db = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS entries(section TEXT NOT NULL,key TEXT NOT NULL,value BLOB NOT NULL,PRIMARY KEY(section,key));');
    if (legacy && !db.prepare('SELECT 1 FROM entries LIMIT 1').get()) apply(sourceStatePatch({}, legacy));
    // Rename only after the transaction is durable; an interrupted migration reopens the committed database.
    if (legacy) renameSync(path, path + '.pre-sqlite');
    if (patches) { apply(patches); return; }
    const state: Record<string, unknown> = { known: {}, pendingRealtime: [], pendingHistory: [] };
    let count = 0;
    for (const row of db.prepare('SELECT section,key,value FROM entries').iterate()) {
      const section = String(row.section), key = String(row.key), value = JSON.parse(decodeLocalContent(Buffer.from(row.value as Uint8Array)).toString());
      if (section === 'state') state[key] = value;
      else { (state[section] ??= {}); (state[section] as Record<string, unknown>)[key] = value; }
      count++;
    }
    return count ? state : undefined;
  } finally { db.close(); }
  function apply(changes: StatePatch[]) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const put = db.prepare('INSERT INTO entries VALUES(?,?,?) ON CONFLICT(section,key) DO UPDATE SET value=excluded.value'), remove = db.prepare('DELETE FROM entries WHERE section=? AND key=?');
      for (const change of changes) {
        if (change.value === undefined) remove.run(change.section, change.key);
        else put.run(change.section, change.key, encodeLocalContent(JSON.stringify(change.value)));
      }
      // The catalog is not unsent data. Only the actual pending bodies consume the outbox byte allowance.
      const bytes = Number(db.prepare("SELECT coalesce(sum(length(value)),0) bytes FROM entries WHERE section='state' AND key IN ('pendingRealtime','pendingHistory')").get()!.bytes);
      if (maximum !== undefined && bytes > maximum) throw new Error('来源待同步队列已满，请恢复网络后重试');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
}
