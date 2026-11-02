/** The Mac plugin host: plugin scopes own their business objects, IPC
 * surface and jobs. Window close keeps authorized durable work in the
 * background; an explicit quit drains it and disposes every scope. A failed
 * startup rolls back everything that scope registered without touching
 * other plugins or the durable queue. */
import {ChannelOwnership, IpcScope, type IpcRouter, type IpcServiceSpec, type IpcListener, type ScopeAccess, type WindowFacts, type WindowRole} from './ipc-registry.js';
import type {NativeProviderRegistry} from './native-registry.js';

export interface PluginJob {
  readonly id: string;
  /** Durable jobs keep running while the window is hidden and are drained on
   * explicit quit; their queued bytes are never dropped by rollback. */
  readonly durable?: boolean;
  readonly drain?: () => Promise<unknown>;
}

interface InternalScope {
  readonly id: string;
  readonly controller: AbortController;
  ipc: IpcScope;
  readonly jobs: Map<string, PluginJob>;
  readonly disposers: Set<() => void>;
  revoked: boolean;
}

/** Internal scope state is never exposed through the handle a plugin holds:
 * the host maps handles to internals privately, so a plugin cannot mutate
 * its own grants or bypass revocation. */
const scopeInternals = new WeakMap<PluginScopeHandle, InternalScope>();

const readonlySet = (values: readonly string[]): ReadonlySet<string> => {
  const backing = new Set(values);
  return {
    has: (value: string) => backing.has(value),
    get size() { return backing.size; },
    forEach: (fn: (v: string, k: string, s: ReadonlySet<string>) => void) => backing.forEach((v, k) => fn(v, k, backing)),
    entries: () => backing.entries(),
    keys: () => backing.keys(),
    values: () => backing.values(),
    [Symbol.iterator]: () => backing[Symbol.iterator](),
  } as ReadonlySet<string>;
};

export class DesktopPluginHost {
  #router: IpcRouter;
  #native: NativeProviderRegistry;
  #ownership = new ChannelOwnership();
  #windows = new Map<number, WindowFacts>();
  #scopes = new Map<string, InternalScope>();
  #mainWindowOpen = false;
  #quitPromise: Promise<void> | null = null;

  constructor(options: {router: IpcRouter; native: NativeProviderRegistry}) {
    this.#router = options.router;
    this.#native = options.native;
  }

  get native(): NativeProviderRegistry { return this.#native; }
  get mainWindowOpen(): boolean { return this.#mainWindowOpen; }

  /** The host knows which senders belong to real windows, their roles and the
   * capabilities each window/scope is authorized to exercise as a caller. */
  registerWindow(senderId: number, role: WindowRole, capabilities: readonly string[] = []): void {
    this.#windows.set(senderId, {role, capabilities: readonlySet(capabilities)});
    if (role === 'main') this.#mainWindowOpen = true;
  }
  unregisterWindow(senderId: number): void {
    const facts = this.#windows.get(senderId);
    this.#windows.delete(senderId);
    if (facts?.role === 'main') this.#mainWindowOpen = false;
  }

  createScope(options: {instanceId: string; capabilities: readonly string[]}): PluginScopeHandle {
    if (this.#scopes.has(options.instanceId)) throw new TypeError('Plugin scope already exists');
    const scope: InternalScope = {
      id: options.instanceId,
      controller: new AbortController(),
      jobs: new Map(),
      disposers: new Set(),
      revoked: false,
    } as InternalScope;
    const access: ScopeAccess = {
      instanceId: scope.id,
      capabilities: readonlySet(options.capabilities),
      isRevoked: () => scope.revoked,
    };
    scope.ipc = new IpcScope(access, this.#router, this.#windows, this.#ownership);
    this.#scopes.set(scope.id, scope);
    const handle = new PluginScopeHandle(scope.id, scope.controller.signal, scope.ipc, scope.jobs, scope.disposers, () => scope.revoked);
    scopeInternals.set(handle, scope);
    return handle;
  }

  /** Run a plugin factory inside its scope. Any startup failure revokes every
   * handler, job and subscription the scope registered; durable queue bytes
   * stay, other plugins keep running, and quit remains available. */
  async startPlugin(scope: PluginScopeHandle, factory: (scope: PluginScopeHandle) => unknown): Promise<{started: true} | {started: false; error: unknown}> {
    const internal = scopeInternals.get(scope);
    if (!internal) throw new TypeError('Unknown plugin scope');
    try {
      await factory(scope);
      return {started: true};
    } catch (error) {
      this.#revokeScope(internal, {keepDurable: true});
      return {started: false, error};
    }
  }

  /** Closing the main window hides the UI but never stops background owners:
   * durable jobs and IPC keep serving until an explicit quit. */
  onMainWindowClosed(): void { this.#mainWindowOpen = false; }

  /** Explicit quit: settle every durable drain, then dispose every scope even
   * when drains fail. All callers observe one shared completion; a failed
   * drain is reported after cleanup, never left permanently latched. */
  requestQuit(): Promise<void> {
    this.#quitPromise ??= this.#doQuit();
    return this.#quitPromise;
  }

  async #doQuit(): Promise<void> {
    const drains: Promise<unknown>[] = [];
    for (const scope of this.#scopes.values())
      for (const job of scope.jobs.values()) if (job.durable && job.drain) drains.push(Promise.resolve().then(job.drain));
    const results = await Promise.allSettled(drains);
    for (const scope of this.#scopes.values()) this.#revokeScope(scope, {keepDurable: false});
    this.#scopes.clear();
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length > 0) throw failed.length === 1 ? failed[0]!.reason : new AggregateError(failed.map(f => f.reason), 'durable drains failed');
  }

  stopScope(instanceId: string): void {
    const scope = this.#scopes.get(instanceId);
    if (!scope) return;
    this.#revokeScope(scope, {keepDurable: false});
    this.#scopes.delete(instanceId);
  }

  #revokeScope(scope: InternalScope, options: {keepDurable: boolean}): void {
    scope.revoked = true;
    scope.ipc.dispose();
    for (const [id, job] of [...scope.jobs]) if (!(options.keepDurable && job.durable)) scope.jobs.delete(id);
    scope.controller.abort();
    for (const dispose of scope.disposers) dispose();
    scope.disposers.clear();
  }
}

/** What a plugin factory sees: its own scope, never the host or other scopes. */
export class PluginScopeHandle {
  #id: string;
  #signal: AbortSignal;
  #ipc: IpcScope;
  #jobs: Map<string, PluginJob>;
  #disposers: Set<() => void>;
  #revoked: () => boolean;

  constructor(id: string, signal: AbortSignal, ipc: IpcScope, jobs: Map<string, PluginJob>, disposers: Set<() => void>, revoked: () => boolean) {
    this.#id = id; this.#signal = signal; this.#ipc = ipc; this.#jobs = jobs; this.#disposers = disposers; this.#revoked = revoked;
  }
  get instanceId(): string { return this.#id; }
  get signal(): AbortSignal { return this.#signal; }
  registerIpc(spec: IpcServiceSpec, handler: IpcListener): void {
    if (this.#revoked()) throw new TypeError('Scope is revoked');
    this.#ipc.register(spec, handler);
  }
  registerJob(job: PluginJob): void {
    if (this.#jobs.has(job.id)) throw new TypeError(`Job already registered: ${job.id}`);
    this.#jobs.set(job.id, job);
  }
  defer(dispose: () => void): void { this.#disposers.add(dispose); }
}
