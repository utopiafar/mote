import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, renameSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { encodeLocalContent, decodeLocalContent } from './local-content';

export type StatePatch = { section: string; key: string; value?: unknown };
const maps = new Set(['known', 'delivered', 'predecessors', 'quarantined']);
const queues = new Set(['pendingRealtime', 'pendingHistory']);
const queueKey = (value: any) => JSON.stringify([value.externalId, value.revision]);
export function sourceStatePatch(previous: Record<string, unknown>, next: Record<string, unknown>): StatePatch[] {
  const changes: StatePatch[] = [];
  for (const section of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (previous[section] === next[section]) continue;
    if (queues.has(section)) {
      const before = new Map(((previous[section] ?? []) as unknown[]).map(item => [queueKey(item), item]));
      const after = new Map(((next[section] ?? []) as unknown[]).map(item => [queueKey(item), item]));
      for (const [key, value] of after) if (before.get(key) !== value) changes.push({ section, key, value });
      for (const key of before.keys()) if (!after.has(key)) changes.push({ section, key });
    } else if (section === 'checkpoint') {
      const catalog = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && 'catalog' in value ? (value as {catalog:Record<string,unknown>}).catalog : {};
      const metadata = (value: unknown): unknown => value && typeof value === 'object' && 'catalog' in value ? {...value,catalog:{}} : value;
      const before=catalog(previous.checkpoint),after=catalog(next.checkpoint);
      if(JSON.stringify(metadata(previous.checkpoint))!==JSON.stringify(metadata(next.checkpoint)))changes.push({section:'state',key:'checkpoint',value:metadata(next.checkpoint)});
      if(before!==after)for(const key of new Set([...Object.keys(before),...Object.keys(after)]))if(JSON.stringify(before[key])!==JSON.stringify(after[key]))changes.push({section:'catalog',key,value:after[key]});
    } else if (maps.has(section)) {
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
    // Older SQLite states stored whole outbox arrays. Migrate once, atomically,
    // retaining insertion order while subsequent ACKs delete only their own rows.
    for (const section of queues) {
      const row=db.prepare("SELECT value FROM entries WHERE section='state' AND key=?").get(section);
      if(row){const values=JSON.parse(decodeLocalContent(Buffer.from(row.value as Uint8Array)).toString());apply([...sourceStatePatch({}, {[section]:values}),{section:'state',key:section}]);}
    }
    // Upgrade an earlier SQLite checkpoint once: directory entries are individual rows,
    // so committing a scan shard never rewrites its entire previously enumerated catalog.
    const checkpointRow=db.prepare("SELECT value FROM entries WHERE section='state' AND key='checkpoint'").get();
    if(checkpointRow){const checkpoint=JSON.parse(decodeLocalContent(Buffer.from(checkpointRow.value as Uint8Array)).toString());
      if(checkpoint?.catalog&&Object.keys(checkpoint.catalog).length)apply(sourceStatePatch({}, {checkpoint}));
    }
    if (patches) { apply(patches); return; }
    const state: Record<string, unknown> = { known: {}, pendingRealtime: [], pendingHistory: [] };
    let count = 0;const catalog:Record<string,unknown>={};
    for (const row of db.prepare('SELECT section,key,value FROM entries ORDER BY rowid').iterate()) {
      const section = String(row.section), key = String(row.key), value = JSON.parse(decodeLocalContent(Buffer.from(row.value as Uint8Array)).toString());
      if (section === 'catalog') catalog[key]=value;
      else if (section === 'state') state[key] = value;
      else if (queues.has(section)) (state[section] as unknown[]).push(value);
      else { (state[section] ??= {}); (state[section] as Record<string, unknown>)[key] = value; }
      count++;
    }
    if(state.checkpoint&&typeof state.checkpoint==='object'&&'catalog' in state.checkpoint)(state.checkpoint as {catalog:Record<string,unknown>}).catalog=catalog;
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
      const bytes = Number(db.prepare("SELECT coalesce(sum(length(value)),0) bytes FROM entries WHERE section IN ('pendingRealtime','pendingHistory','quarantined') OR (section='state' AND key IN ('pendingRealtime','pendingHistory'))").get()!.bytes);
      if (maximum !== undefined && bytes > maximum) throw new Error('来源待同步队列已满，请恢复网络后重试');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
}
