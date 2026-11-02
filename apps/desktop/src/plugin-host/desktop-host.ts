/** The Mac plugin host: plugin scopes own their business objects, IPC
 * surface and jobs. Window close keeps authorized durable work in the
 * background; an explicit quit drains it and disposes every scope. A failed
 * startup rolls back everything that scope registered without touching
 * other plugins or the durable queue. */
import {IpcScope, type IpcRouter, type IpcServiceSpec, type IpcListener, type ScopeAccess, type WindowRole} from './ipc-registry.js';
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

export class DesktopPluginHost {
  #router: IpcRouter;
  #native: NativeProviderRegistry;
  #windows = new Map<number, WindowRole>();
  #scopes = new Map<string, InternalScope>();
  #mainWindowOpen = false;
  #quit = false;

  constructor(options: {router: IpcRouter; native: NativeProviderRegistry}) {
    this.#router = options.router;
    this.#native = options.native;
  }

  get native(): NativeProviderRegistry { return this.#native; }
  get mainWindowOpen(): boolean { return this.#mainWindowOpen; }

  /** The host knows which senders belong to real windows and their roles. */
  registerWindow(senderId: number, role: WindowRole): void { this.#windows.set(senderId, role); if (role === 'main') this.#mainWindowOpen = true; }
  unregisterWindow(senderId: number): void { const role = this.#windows.get(senderId); this.#windows.delete(senderId); if (role === 'main') this.#mainWindowOpen = false; }

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
      capabilities: new Set(options.capabilities),
      isRevoked: () => scope.revoked,
    };
    scope.ipc = new IpcScope(access, this.#router, this.#windows);
    this.#scopes.set(scope.id, scope);
    return new PluginScopeHandle(scope);
  }

  /** Run a plugin factory inside its scope. Any startup failure revokes every
   * handler, job and subscription the scope registered; durable queue bytes
   * stay, other plugins keep running, and quit remains available. */
  async startPlugin(scope: PluginScopeHandle, factory: (scope: PluginScopeHandle) => unknown): Promise<{started: true} | {started: false; error: unknown}> {
    try {
      await factory(scope);
      return {started: true};
    } catch (error) {
      this.#revokeScope(scope.internal, {keepDurable: true});
      return {started: false, error};
    }
  }

  /** Closing the main window hides the UI but never stops background owners:
   * durable jobs and IPC keep serving until an explicit quit. */
  onMainWindowClosed(): void { this.#mainWindowOpen = false; }

  /** Explicit quit: drain durable jobs first, then dispose every scope. */
  async requestQuit(): Promise<void> {
    if (this.#quit) return;
    this.#quit = true;
    const drains: Promise<unknown>[] = [];
    for (const scope of this.#scopes.values())
      for (const job of scope.jobs.values()) if (job.durable && job.drain) drains.push(Promise.resolve().then(job.drain));
    await Promise.all(drains);
    for (const scope of this.#scopes.values()) this.#revokeScope(scope, {keepDurable: false});
    this.#scopes.clear();
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
  readonly internal: InternalScope;
  constructor(scope: InternalScope) { this.internal = scope; }
  get instanceId(): string { return this.internal.id; }
  get signal(): AbortSignal { return this.internal.controller.signal; }
  registerIpc(spec: IpcServiceSpec, handler: IpcListener): void {
    if (this.internal.revoked) throw new TypeError('Scope is revoked');
    this.internal.ipc.register(spec, handler);
  }
  registerJob(job: PluginJob): void {
    if (this.internal.jobs.has(job.id)) throw new TypeError(`Job already registered: ${job.id}`);
    this.internal.jobs.set(job.id, job);
  }
  defer(dispose: () => void): void { this.internal.disposers.add(dispose); }
}
