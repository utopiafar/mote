/** PluginViewSession is the host-owned view-session object a plugin page
 * consumes: lifecycle-gated reads and polling, durable leases, per-owner
 * draft/return tickets, snapshot restore and explicit write-ack handling.
 * Storage is injected by the host; plugin draft schemas stay plugin-owned. */
import {
  ViewLifetime, draftSurvivesTransition, resolveWriteAck,
  type DraftScope, type SaveOutcome, type WriteAck,
} from '@mote/shared/plugin-view-lifetime';

export interface ViewSnapshot {readonly scroll?: number; readonly filter?: unknown; readonly more?: unknown; readonly focus?: string}
export interface DraftWriter {
  save(key: string, value: unknown): Promise<SaveOutcome>;
  load(key: string): Promise<unknown | null>;
  clear(key: string): Promise<void>;
}
export interface ViewScheduler {schedule(tick: () => void, intervalMs: number): unknown; cancel(handle: unknown): void}
export const realtimeScheduler: ViewScheduler = {
  schedule: (tick, ms) => setInterval(tick, ms),
  cancel: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class PluginViewSession {
  readonly lifetime = new ViewLifetime();
  #scope: DraftScope;
  #ownerKey: string;
  #writer: DraftWriter;
  #scheduler: ViewScheduler;
  #drafts = new Map<string, Map<string, {scope: DraftScope; value: unknown; dirty: boolean}>>();
  #snapshots = new Map<string, ViewSnapshot>();
  #polls = new Set<{handle: unknown | null; tick: () => void; intervalMs: number}>();
  #pendingWrites = new Set<string>();
  #saveFailure = false;
  #inflightFlush: Promise<SaveOutcome> | null = null;

  constructor(options: {scope?: DraftScope; ownerKey: string; writer: DraftWriter; scheduler?: ViewScheduler}) {
    this.#scope = options.scope ?? 'view';
    this.#ownerKey = options.ownerKey;
    this.#writer = options.writer;
    this.#scheduler = options.scheduler ?? realtimeScheduler;
    this.lifetime.onDispose(() => { for (const poll of this.#polls) this.#stopPoll(poll); this.#polls.clear(); });
  }

  get ownerKey(): string { return this.#ownerKey; }
  get saveFailed(): boolean { return this.#saveFailure; }
  get pendingWrites(): ReadonlySet<string> { return this.#pendingWrites; }

  /** View-scoped read: issued only while visible; the response is applied only
   * if its generation is still current, so a late response after suspend or an
   * owner switch can never render. */
  async requestRead<T>(execute: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void): Promise<'applied' | 'stale' | 'skipped'> {
    if (this.lifetime.state !== 'visible') return 'skipped';
    const generation = this.lifetime.generation;
    const value = await execute(this.lifetime.viewSignal);
    if (!this.lifetime.admits(generation)) return 'stale';
    apply(value);
    return 'applied';
  }

  /** Poll while visible; suspend clears the interval so no new read fires. */
  poll(execute: (signal: AbortSignal) => Promise<unknown>, apply: (value: unknown) => void, intervalMs: number, onError?: (error: unknown) => void): () => void {
    const entry = {handle: null as unknown, intervalMs, tick: () => {
      // Gate by the issuing generation and signal: an abort or stale error from
      // an earlier epoch never reaches this owner's error path.
      const generation = this.lifetime.generation;
      const signal = this.lifetime.viewSignal;
      void this.requestRead(execute, apply).catch(error => {
        if (signal.aborted || !this.lifetime.admits(generation)) return;
        onError?.(error);
      });
    }};
    const start = () => { if (this.lifetime.state === 'visible' && entry.handle === null) entry.handle = this.#scheduler.schedule(entry.tick, intervalMs); };
    this.#polls.add(entry);
    start();
    const stop = this.lifetime.onDispose(() => this.#polls.delete(entry));
    return () => { this.#stopPoll(entry); this.#polls.delete(entry); stop(); };
  }
  #stopPoll(entry: {handle: unknown | null}): void {
    if (entry.handle !== null) { this.#scheduler.cancel(entry.handle); entry.handle = null; }
  }

  /** Separately authorized durable work (upload, capture transport): unaffected
   * by suspend, cancelled only on dispose. */
  keepDurable(execute: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
    return execute(this.lifetime.durableSignal);
  }

  snapshotView(key: string, snapshot: ViewSnapshot): void { this.#snapshots.set(key, {...snapshot}); }
  restoreView(key: string): ViewSnapshot | null { const v = this.#snapshots.get(key); return v ? {...v} : null; }

  /** The current owner's draft partition; another owner's drafts are never
   * readable or writable from here. */
  #draftMap(): Map<string, {scope: DraftScope; value: unknown; dirty: boolean}> {
    let map = this.#drafts.get(this.#ownerKey);
    if (!map) { map = new Map(); this.#drafts.set(this.#ownerKey, map); }
    return map;
  }

  /** Draft write staged under this session's owner partition. */
  saveDraft(key: string, value: unknown): void {
    this.#draftMap().set(key, {scope: this.#scope, value, dirty: true});
  }
  draft(key: string): unknown | null { return this.#draftMap().get(key)?.value ?? null; }

  /** Persisted draft addresses are qualified by scope and owner so two
   * owners never overwrite the same storage slot. */
  #storageKey(key: string): string { return `${this.#scope}:${this.#ownerKey}:${key}`; }

  /** Flushes are serialized per session: a second suspend/owner-switch joins
   * the in-flight flush instead of racing out-of-order saves. */
  async #flushDrafts(): Promise<SaveOutcome> {
    if (this.#inflightFlush) return this.#inflightFlush;
    const flush = this.#flushUntilClean();
    this.#inflightFlush = flush;
    try { return await flush; } finally { this.#inflightFlush = null; }
  }

  /** Flush dirty drafts through the host writer, repeating until the current
   * owner's entries are clean: an edit racing a pending save is never marked
   * persisted. Any failure is an explicit outcome: the caller must show the
   * failure or block the lossy transition. */
  async #flushUntilClean(): Promise<SaveOutcome> {
    for (;;) {
      const dirty = [...this.#draftMap()].filter(([, draft]) => draft.dirty && draft.scope !== 'view');
      if (dirty.length === 0) { this.#saveFailure = false; return {ok: true}; }
      for (const [key, draft] of dirty) {
        const outcome = await this.#writer.save(this.#storageKey(key), draft.value);
        if (!outcome.ok) { this.#saveFailure = true; return outcome; }
        draft.dirty = false;
      }
    }
  }

  /** Hydrate a draft persisted under this owner's partition. A staged unsaved
   * value always wins over the in-flight load. View-scoped drafts are session
   * memory only: they are never persisted and never revive in a new view. */
  async loadDraft(key: string): Promise<unknown | null> {
    const owner = this.#ownerKey;
    const map = this.#draftMap();
    const staged = map.get(key);
    if (staged?.dirty) return staged.value;
    if (this.#scope === 'view') return staged?.value ?? null;
    const persisted = await this.#writer.load(this.#storageKey(key));
    if (this.#ownerKey !== owner) return null;
    const current = map.get(key);
    if (current?.dirty) return current.value;
    if (persisted !== null && persisted !== undefined) {
      if (!current) map.set(key, {scope: this.#scope, value: persisted, dirty: false});
      return persisted;
    }
    return current?.value ?? null;
  }

  /** Suspend ordering: save drafts, release reads, then hide. A failed save
   * blocks the transition instead of silently losing the draft. */
  async suspend(): Promise<SaveOutcome> {
    const outcome = await this.#flushDrafts();
    if (!outcome.ok) return outcome;
    for (const poll of this.#polls) this.#stopPoll(poll);
    this.lifetime.suspend();
    return {ok: true};
  }

  /** Resume: new generation, view restores; polling restarts. */
  resume(): void {
    this.lifetime.show();
    for (const poll of this.#polls) if (poll.handle === null) poll.handle = this.#scheduler.schedule(poll.tick, poll.intervalMs);
  }

  /** Owner switch: save this owner's drafts first (failure blocks), then clear
   * display state, grants and every registered poll (owner-captured callbacks
   * must be re-registered by the new owner). Drafts stay partitioned under
   * their own owner. A suspended view stays suspended; only resume() shows. */
  async switchOwner(nextOwnerKey: string): Promise<SaveOutcome> {
    const outcome = await this.#flushDrafts();
    if (!outcome.ok) return outcome;
    for (const map of this.#drafts.values())
      for (const [key, draft] of map) if (!draftSurvivesTransition(draft.scope, 'owner-switch')) map.delete(key);
    for (const poll of [...this.#polls]) { this.#stopPoll(poll); this.#polls.delete(poll); }
    this.#snapshots.clear();
    this.#ownerKey = nextOwnerKey;
    const wasVisible = this.lifetime.state === 'visible';
    this.lifetime.suspend();
    if (wasVisible) this.lifetime.show();
    return {ok: true};
  }

  /** Record a write acknowledgement: an unknown result holds the original
   * request identity for reconciliation; it is never silently replayed. */
  resolveWrite(requestId: string, ack: WriteAck): 'commit' | 'fail' | 'hold' {
    const resolution = resolveWriteAck(ack);
    if (resolution === 'hold') { this.#pendingWrites.add(requestId); return 'hold'; }
    this.#pendingWrites.delete(requestId);
    return resolution;
  }
}
