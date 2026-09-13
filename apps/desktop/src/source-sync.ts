import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SourceDefinition, SourceItem, SourceRequest, SourceScan, ScannedItem } from './source-types';
export const sourceHash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export async function atomicSourceJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    if (process.platform !== 'win32') { const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  }
  finally { await rm(temporary, { force: true }); }
}
interface Known { contentHash: string; revision: string; item: ScannedItem }
interface State { policy?: string; version: 1; known: Record<string, Known>; pending: SourceItem[]; lastSyncAt?: string }
// All transitions are persisted before network I/O. Callers serialize one source at a time.
export class SourceSync {
  private data: State = { version: 1, known: {}, pending: [] };
  constructor(private readonly path: string, private readonly limits = { maxEvents: 4000, maxBytes: 32 * 1024 * 1024 }) {}
  async initialize(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as State;
      if (value.version !== 1 || !value.known || !Array.isArray(value.pending) || value.pending.length > 4000) throw new Error('来源同步状态无法读取，请保留文件后修复');
      this.data = value;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  status(): { pending: number; items: number; lastSyncAt?: string } {
    return { pending: this.data.pending.length, items: Object.values(this.data.known).filter(v => !v.item.deleted).length, lastSyncAt: this.data.lastSyncAt };
  }
  async ensurePolicy(policy: string): Promise<void> {
    if (this.data.policy === policy) return;
    await this.discardPendingForPolicyChange(policy);
  }
  private async discardPendingForPolicyChange(policy: string): Promise<void> {
    // A changed privacy policy must never upload a previously staged body.
    const next = { ...this.data, policy, known: Object.fromEntries(Object.entries(this.data.known).map(([k, v]) => [k, { ...v, contentHash: '' }])), pending: [] };
    await this.commit(next);
  }
  async stage(scan: SourceScan, trackDeletions: boolean, observedAt = new Date().toISOString()): Promise<number> {
    const next: State = structuredClone(this.data); let changes = 0;
    const stage = (item: ScannedItem) => {
      const key = sourceHash(item.externalId); const previous = next.known[key];
      const contentHash = sourceHash(JSON.stringify(item));
      if (previous?.contentHash === contentHash) return;
      const revision = sourceHash(contentHash + ':' + (previous?.revision ?? ''));
      next.pending.push({ ...item, revision, observedAt });
      // Persist only metadata for deletion detection; original text lives solely in the bounded pending queue.
      next.known[key] = { contentHash, revision, item: { ...item, text: '' } }; changes++;
    };
    for (const item of scan.items) stage(item);
    if (trackDeletions && scan.complete) {
      const seen = new Set(scan.seen);
      for (const previous of Object.values(this.data.known)) {
        const item = previous.item;
        // A policy-invalidated record is only a revision anchor, not evidence for deletion.
        if (!previous.contentHash || item.deleted || seen.has(item.externalId)) continue;
        if (scan.scope && (!item.calendar || item.calendar.start >= scan.scope.end || item.calendar.end < scan.scope.start)) continue;
        stage({ ...item, text: '', deleted: true });
      }
    }
    if (next.pending.length > this.limits.maxEvents || Buffer.byteLength(JSON.stringify(next)) > this.limits.maxBytes) throw new Error('来源待同步队列已满（4000 项 / 32 MiB），请恢复网络后重试');
    await this.commit(next); return changes;
  }
  async syncScan(scan: SourceScan, trackDeletions: boolean, source: SourceDefinition, request: SourceRequest, signal?: AbortSignal, prepare?: () => Promise<void>): Promise<{ changes: number; state: 'ready' | 'paused' }> {
    let precedingError: unknown;
    // A full queue must still drain when the node recovers. The caller has already completed a permission/privacy-safe scan.
    if (this.data.pending.length) {
      try {
        await prepare?.();
        if (await this.flush(source, request, signal) === 'paused') return { changes: 0, state: 'paused' };
      } catch (error) { precedingError = error; }
    }
    signal?.throwIfAborted();
    const changes = await this.stage(scan, trackDeletions);
    if (precedingError) throw precedingError; // Offline changes remain durable; avoid a second failing request in this cycle.
    await prepare?.();
    return { changes, state: await this.flush(source, request, signal) };
  }
  async flush(source: SourceDefinition, request: SourceRequest, signal?: AbortSignal): Promise<'ready' | 'paused'> {
    signal?.throwIfAborted();
    const registered = await request('/api/sources', source, 'POST', signal) as { id?: unknown; enabled?: unknown };
    if (!registered || registered.id !== source.id || typeof registered.enabled !== 'boolean') throw new Error('中央来源注册确认无效');
    if (!registered.enabled) return 'paused';
    while (this.data.pending.length) {
      signal?.throwIfAborted();
      const item = this.data.pending[0]!;
      const ack = await request(`/api/sources/${encodeURIComponent(source.id)}/items`, item, 'PUT', signal) as Record<string, unknown>;
      if (!ack || ack.sourceId !== source.id || ack.externalId !== item.externalId || ack.revision !== item.revision || typeof ack.duplicate !== 'boolean' || typeof ack.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ack.id)) throw new Error('中央来源条目确认不匹配，已保留待重试版本');
      await this.commit({ ...this.data, pending: this.data.pending.slice(1) });
    }
    await this.commit({ ...this.data, lastSyncAt: new Date().toISOString() }); return 'ready';
  }
  private async commit(next: State): Promise<void> { await atomicSourceJson(this.path, next); this.data = next; }
}
