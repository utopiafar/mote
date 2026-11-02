import type {PluginErrorCode} from '@mote/plugin-api/contracts';

export class PluginHostError extends Error {
  constructor(readonly code: PluginErrorCode) { super('Plugin host operation is unavailable'); this.name = 'PluginHostError'; }
}
type Cleanup = () => unknown | Promise<unknown>;

/** Resource ownership shared by the generic host and legacy server adapters.
 * This is not a scheduler, persistent journal, authorization grant or code sandbox. */
export class PluginResourceScope {
  private readonly controller = new AbortController();
  private readonly disposers: Cleanup[] = [];
  private readonly retiring: Cleanup[] = [];
  private readonly pending = new Set<Promise<unknown>>();
  private readonly timers = new Set<ReturnType<typeof setInterval>>();
  private readonly observerErrors: unknown[] = [];
  private accepting = true;
  private disposed = false;
  private closing?: Promise<void>;
  readonly signal = this.controller.signal;

  constructor(private readonly onError: (error: unknown) => void = () => {}, private readonly errorMessage = 'Plugin resource disposal failed') {}
  get active() { return this.accepting; }
  assertCurrent() { if (this.signal.aborted || this.disposed) throw new PluginHostError('stale_scope'); }

  run<T>(work: (signal: AbortSignal) => T | Promise<T>): Promise<T | undefined> {
    if (!this.active) return Promise.resolve(undefined);
    const task = Promise.resolve().then(() => this.active ? work(this.signal) : undefined);
    return this.join(task);
  }
  /** Join already-admitted work without creating another admission or changing its fixed pin. */
  join<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), error => {
      this.pending.delete(task);
      try { this.onError(error); } catch (observerError) { this.observerErrors.push(observerError); }
    });
    return task;
  }
  /** Register immediately on acquisition. Tracked in-flight work may still register cleanup after stop. */
  defer(dispose: Cleanup) {
    if (this.disposed) throw new PluginHostError('stale_scope');
    this.disposers.push(dispose);
  }
  /** Remove published registrations only after resource cleanup and accepted work have settled. */
  retire(dispose: Cleanup) {
    if (this.disposed) throw new PluginHostError('stale_scope');
    this.retiring.push(dispose);
  }
  every(ms: number, work: (signal: AbortSignal) => unknown | Promise<unknown>) {
    if (!this.active) throw new PluginHostError('stale_scope');
    if (!Number.isFinite(ms) || ms <= 0) throw new RangeError('Invalid plugin timer interval');
    let running = false;
    const timer = setInterval(() => {
      if (!this.active || running) return;
      running = true;
      void this.run(work).catch(() => {}).finally(() => { running = false; });
    }, ms);
    (timer as unknown as {unref?: () => unknown}).unref?.();
    this.timers.add(timer);
    return () => { clearInterval(timer); this.timers.delete(timer); };
  }
  quiesce() {
    this.accepting = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
  }
  stop(reason: unknown = new PluginHostError('stale_scope')) {
    this.quiesce();
    if (!this.signal.aborted) this.controller.abort(reason);
  }
  close() {
    if (this.closing) return this.closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    // Publish the promise before abort listeners can reenter close().
    void this.dispose().then(resolve, reject);
    return this.closing;
  }
  private async dispose() {
    this.stop();
    const errors: unknown[] = [];
    const drain = async (list: Cleanup[]) => {
      while (list.length) try { await list.pop()!(); } catch (error) { errors.push(error); }
    };
    await drain(this.disposers);
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    // An accepted prepare/read can acquire a resource after cancellation; reclaim that resource too.
    while (this.disposers.length || this.retiring.length) { await drain(this.disposers); await drain(this.retiring); }
    errors.push(...this.observerErrors);
    this.disposed = true;
    if (errors.length) throw new AggregateError(errors, this.errorMessage);
  }
}
