import { moteText } from '@mote/shared/i18n';
import { createHash } from 'node:crypto';
import { sourceWork } from './background';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { SourceDefinition, SourceItem, SourceRequest, SourceScan, ScannedItem } from './source-types';

export const sourceHash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export async function atomicSourceJson(path: string, value: unknown): Promise<void> { await sourceWork.run({ kind: 'json-write', path, value }); }

type QueueName = 'realtime' | 'history';
interface Known { contentHash: string; revision: string; item: ScannedItem }
interface State {
  version: 2;
  predecessors?: Record<string, string | null>;
  delivered?: Record<string, string>;
  collectedItems?: number;
  checkpoint?: import('./coding-agents').CodingCheckpoint;
  initialized?: boolean;
  baseline?: string[];
  policy?: string;
  known: Record<string, Known>;
  pendingRealtime: SourceItem[];
  pendingHistory: SourceItem[];
  lastSyncAt?: string;
}

const receiptId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const itemKey = (item: Pick<SourceItem, 'externalId' | 'revision'>) => `${item.externalId}\u0000${item.revision}`;

/** Durable outbox with a latency-sensitive queue and a resumable backfill queue. */
export class SourceSync {
  private data: State = { version: 2, known: {}, pendingRealtime: [], pendingHistory: [] };
  private readonly limits: { maxEvents: number; maxBytes: number; batchSize: number; concurrency: number };
  constructor(private readonly path: string, limits?: Partial<{ maxEvents: number; maxBytes: number; batchSize: number; concurrency: number }>) { this.limits = { maxEvents: 4000, maxBytes: 32 * 1024 * 1024, batchSize: 100, concurrency: 4, ...limits }; }

  async initialize(): Promise<void> {
    try {
      const value = await sourceWork.run<Record<string, unknown> | undefined>({ kind: 'json-read', path: this.path });
      if (value === undefined) return;
      if (value.version === 1) {
        const old = value as unknown as { known?: Record<string, Known>; pending?: SourceItem[]; [key: string]: unknown };
        if (!Array.isArray(old.pending) || old.pending.length > this.limits.maxEvents) throw new Error(moteText("来源同步状态超过本地队列上限，请恢复网络后重试"));
        this.data = { ...old, version: 2, known: old.known ?? {}, pendingRealtime: old.pending ?? [], pendingHistory: [] } as State;
        delete (this.data as State & { pending?: SourceItem[] }).pending;
        return;
      }
      const next = value as unknown as State;
      if (next.version !== 2 || !next.known || !Array.isArray(next.pendingRealtime) || !Array.isArray(next.pendingHistory)) throw new Error(moteText("来源同步状态无法读取，请保留文件后修复"));
      if (next.pendingRealtime.length + next.pendingHistory.length > this.limits.maxEvents) throw new Error(moteText("来源同步状态超过本地队列上限，请恢复网络后重试"));
      this.data = next;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }

  checkpoint() { return structuredClone(this.data.checkpoint); }
  initialized() { return Boolean(this.data.initialized); }
  private pendingItems(): SourceItem[] { return [...this.data.pendingRealtime, ...this.data.pendingHistory]; }
  status(): { pending: number; realtimePending: number; historyPending: number; items: number; lastSyncAt?: string; oldestPendingAt?: string } {
    const pending = this.pendingItems();
    return { oldestPendingAt: pending.reduce<string | undefined>((oldest, item) => !oldest || item.observedAt < oldest ? item.observedAt : oldest, undefined), pending: pending.length, realtimePending: this.data.pendingRealtime.length, historyPending: this.data.pendingHistory.length, items: this.data.collectedItems ?? Object.values(this.data.known).filter(v => !v.item.deleted).length, lastSyncAt: this.data.lastSyncAt };
  }
  async checkpointTo(path: string): Promise<void> { await atomicSourceJson(path, this.data); }

  async ensurePolicy(policy: string): Promise<void> {
    if (this.data.policy === policy) return;
    const next = { ...this.data, checkpoint: undefined, delivered: undefined, predecessors: undefined, policy, known: Object.fromEntries(Object.entries(this.data.known).map(([k, v]) => [k, { ...v, contentHash: '' }])), pendingRealtime: [], pendingHistory: [] } as State;
    await this.commit(next);
  }

  async stage(scan: SourceScan, trackDeletions: boolean, observedAt = new Date().toISOString(), initialSync: 'all' | 'new_only' = 'all', defaultQueue: QueueName = scan.queue ?? 'realtime'): Promise<number> {
    const next: State = { ...this.data, known: { ...this.data.known }, pendingRealtime: [...this.data.pendingRealtime], pendingHistory: [...this.data.pendingHistory] };
    let changes = 0;
    if (!scan.checkpoint && initialSync === 'new_only' && !next.initialized && Object.keys(next.known).length === 0) {
      next.baseline = [...new Set([...(next.baseline ?? []), ...scan.seen])]; next.initialized = scan.complete; await this.commit(next, this.limits.maxBytes); return 0;
    }
    if (initialSync === 'all') next.baseline = [];
    if (scan.complete) next.initialized = true;
    const baseline = new Set(next.baseline ?? []);
    const stage = (raw: ScannedItem) => {
      const { syncQueue, ...item } = raw;
      const key = sourceHash(item.externalId), previous = next.known[key], contentHash = sourceHash(JSON.stringify(item));
      if (previous?.contentHash === contentHash) return;
      const revision = sourceHash(contentHash + ':' + (previous?.revision ?? '')), queued: SourceItem = { ...item, revision, observedAt };
      if ((syncQueue ?? defaultQueue) === 'history') next.pendingHistory.push(queued); else next.pendingRealtime.push(queued);
      if (!scan.checkpoint) next.known[key] = { contentHash, revision, item: { ...item, text: '', localOriginalBase64: undefined } };
      changes++;
    };
    for (const [index, item] of scan.items.entries()) { if (index % 16 === 0) await yieldTurn(); if (!baseline.has(item.externalId)) stage(item); }
    if (trackDeletions && scan.complete) {
      const seen = new Set(scan.seen);
      for (const previous of Object.values(this.data.known)) {
        const item = previous.item;
        if (!previous.contentHash || item.deleted || seen.has(item.externalId)) continue;
        if (scan.scope && (!item.calendar || item.calendar.start >= scan.scope.end || item.calendar.end < scan.scope.start)) continue;
        stage({ ...item, localOriginalBase64: undefined, text: '', deleted: true, syncQueue: 'realtime', ...(item.kind === 'file' ? { metadata: { ...item.metadata, version: 1, file: { ...item.metadata?.file, deletionObservedAt: observedAt } } } : {}) });
      }
    }
    if (next.pendingRealtime.length + next.pendingHistory.length > this.limits.maxEvents) throw new Error(moteText("来源待同步队列已满（4000 项 / 32 MiB），请恢复网络后重试"));
    if (scan.checkpoint) { next.checkpoint = scan.checkpoint; next.collectedItems = (next.collectedItems ?? 0) + changes; }
    await this.commit(next, this.limits.maxBytes); return changes;
  }

  async syncScan(scan: SourceScan, trackDeletions: boolean, source: SourceDefinition, request: SourceRequest, signal?: AbortSignal, prepare?: () => Promise<void>): Promise<{ changes: number; state: 'ready' | 'paused' }> {
    let precedingError: unknown;
    if (this.status().pending) {
      try { await prepare?.(); if (await this.flush(source, request, signal) === 'paused') return { changes: 0, state: 'paused' }; } catch (error) { precedingError = error; }
    }
    signal?.throwIfAborted();
    const changes = await this.stage(scan, trackDeletions, undefined, source.initialSync, scan.queue ?? 'realtime');
    if (precedingError) throw precedingError;
    await prepare?.(); return { changes, state: await this.flush(source, request, signal) };
  }

  async flush(source: SourceDefinition, request: SourceRequest, signal?: AbortSignal): Promise<'ready' | 'paused'> {
    signal?.throwIfAborted();
    const registered = await request('/api/sources', source, 'POST', signal) as { id?: unknown; enabled?: unknown };
    if (!registered || registered.id !== source.id || typeof registered.enabled !== 'boolean') throw new Error(moteText("中央来源注册确认无效"));
    if (!registered.enabled) return 'paused';
    let realtimeBatches = 0;
    while (this.status().pending) {
      signal?.throwIfAborted();
      const queue: QueueName = !this.data.pendingRealtime.length || (this.data.pendingHistory.length > 0 && realtimeBatches >= 4) ? 'history' : 'realtime';
      const batches = this.takeBatches(queue);
      const outcomes = await Promise.all(batches.map(async batch => { try { return { batch, acks: await this.sendBatch(source, batch, request, signal) }; } catch (error) { return { batch, error }; } }));
      let failure: unknown;
      for (const outcome of outcomes) { if ('error' in outcome) { failure ??= outcome.error; continue; } await this.acknowledge(source, outcome.batch, outcome.acks); }
      if (failure) throw failure;
      if (queue === 'realtime') realtimeBatches += batches.length; else realtimeBatches = 0;
    }
    await this.commit({ ...this.data, lastSyncAt: new Date().toISOString() }); return 'ready';
  }

  private takeBatches(queue: QueueName): SourceItem[][] {
    const items = queue === 'realtime' ? this.data.pendingRealtime : this.data.pendingHistory;
    if (!items.length) return [];
    if (items[0]!.kind === 'file' && items[0]!.document?.fileIndex) return [[items[0]!]];
    const count = Math.min(this.limits.concurrency, Math.ceil(items.length / this.limits.batchSize)), batches: SourceItem[][] = [];
    for (let i = 0; i < count; i++) { const start = Math.floor(i * items.length / count), end = Math.floor((i + 1) * items.length / count); if (end > start) batches.push(items.slice(start, Math.min(end, start + this.limits.batchSize))); }
    return batches;
  }

  private async sendBatch(source: SourceDefinition, batch: SourceItem[], request: SourceRequest, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const first = batch[0]!;
    if (first.kind === 'file' && first.document?.fileIndex) return [await this.sendFile(source, first, request, signal)];
    const wire = batch.map(({ localOriginalBase64: _, ...item }) => item);
    // Keep the single-item route as a compatibility path for older central
    // nodes; only a real multi-item batch requires the new endpoint.
    if (wire.length === 1) return [this.validateAck(source, await request(`/api/sources/${encodeURIComponent(source.id)}/items`, wire[0], 'PUT', signal), wire[0])];
    const result = await request(`/api/sources/${encodeURIComponent(source.id)}/items/batch`, { items: wire }, 'POST', signal) as { receipts?: unknown };
    if (!result || !Array.isArray(result.receipts) || result.receipts.length !== batch.length) {
      // A mixed-version rollout can reach a central node without the batch
      // route. Fall back per item; a transport error itself is never hidden.
      const receipts: Record<string, unknown>[] = [];
      for (const item of wire) receipts.push(this.validateAck(source, await request(`/api/sources/${encodeURIComponent(source.id)}/items`, item, 'PUT', signal)));
      return receipts;
    }
    return result.receipts.map((receipt, index) => this.validateAck(source, receipt, wire[index]));
  }

  private async sendFile(source: SourceDefinition, item: SourceItem, request: SourceRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const { localOriginalBase64, ...wire } = item, key = sourceHash(item.externalId);
    let previousRevision = Object.hasOwn(this.data.predecessors ?? {}, item.revision) ? this.data.predecessors![item.revision] ?? '' : this.data.delivered?.[key];
    if (previousRevision === undefined) { const head = await request('/api/file-sync/v1/head?sourceId=' + encodeURIComponent(source.id) + '&externalId=' + encodeURIComponent(item.externalId), undefined, 'GET', signal) as { revision: string | null }; previousRevision = head.revision ?? ''; }
    if (!Object.hasOwn(this.data.predecessors ?? {}, item.revision)) await this.commit({ ...this.data, predecessors: { ...this.data.predecessors, [item.revision]: previousRevision || null } });
    const original = localOriginalBase64 ? Buffer.from(localOriginalBase64, 'base64') : undefined, manifest = { sourceId: source.id, previousRevision: previousRevision || null, item: wire, sizeBytes: item.metadata?.file?.sizeBytes ?? 0, ...(original ? { sha256: sourceHash(original) } : {}) };
    let ack: Record<string, unknown>;
    if (original) {
      const upload = await request('/api/file-sync/v1/uploads', manifest, 'POST', signal) as { uploadId: string; ack?: Record<string, unknown>; partBytes: number; parts: { part: number }[] };
      if (upload.ack) ack = upload.ack;
      else { if (upload.partBytes !== 4194304) throw Error('Unsupported file part size'); for (let offset = 0; offset < original.length; offset += upload.partBytes) { const part = offset / upload.partBytes; if (!upload.parts.some(p => p.part === part)) await request('/api/file-sync/v1/uploads/' + upload.uploadId + '/parts/' + part, original.subarray(offset, offset + upload.partBytes), 'PUT', signal); } ack = await request('/api/file-sync/v1/uploads/' + upload.uploadId + '/commit', {}, 'POST', signal) as Record<string, unknown>; }
    } else ack = await request('/api/file-sync/v1/revisions', manifest, 'PUT', signal) as Record<string, unknown>;
    return this.validateAck(source, ack, item);
  }

  private validateAck(source: SourceDefinition, ack: unknown, expected?: Pick<SourceItem, 'externalId' | 'revision'>): Record<string, unknown> {
    if (!ack || typeof ack !== 'object') throw new Error(moteText("中央来源条目确认不匹配，已保留待重试版本"));
    const value = ack as Record<string, unknown>;
    if (value.sourceId !== source.id || typeof value.externalId !== 'string' || typeof value.revision !== 'string' || typeof value.duplicate !== 'boolean' || typeof value.id !== 'string' || !receiptId.test(value.id) || expected && (value.externalId !== expected.externalId || value.revision !== expected.revision)) throw new Error(moteText("中央来源条目确认不匹配，已保留待重试版本"));
    return value;
  }

  private async acknowledge(_source: SourceDefinition, batch: SourceItem[], acks: Record<string, unknown>[]): Promise<void> {
    const acked = new Set(acks.map(ack => itemKey({ externalId: String(ack.externalId), revision: String(ack.revision) })));
    const expected = new Set(batch.map(itemKey));
    if (acked.size !== batch.length || [...expected].some(key => !acked.has(key))) throw new Error(moteText("中央批量来源确认不完整，已保留待重试版本"));
    const predecessors = { ...this.data.predecessors }, delivered = { ...this.data.delivered };
    for (const item of batch) { delete predecessors[item.revision]; delivered[sourceHash(item.externalId)] = item.revision; }
    const remove = new Set(batch.map(itemKey)), filter = (items: SourceItem[]) => items.filter(item => !remove.has(itemKey(item)));
    await this.commit({ ...this.data, predecessors, delivered, pendingRealtime: filter(this.data.pendingRealtime), pendingHistory: filter(this.data.pendingHistory) });
  }

  private async commit(next: State, maximum?: number): Promise<void> { await sourceWork.run({ kind: 'json-write', path: this.path, value: next, maximum }); this.data = next; }
}
