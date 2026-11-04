/** The Mac plugin host: plugin scopes own their business objects, IPC
 * surface and jobs. Window close keeps authorized durable work in the
 * background; an explicit quit drains it and disposes every scope. A failed
 * startup rolls back everything that scope registered without touching
 * other plugins or the durable queue. */
import {ChannelOwnership, IpcScope, type IpcRouter, type IpcServiceSpec, type IpcListener, type IpcCallerView, type IpcInvokeResult, type ScopeAccess, type WindowFacts, type WindowRole} from './ipc-registry.js';
import type {NativeProviderRegistry} from './native-registry.js';
import type {CustomPageFrameTarget, CustomPageFrameClaim, CustomPageFrameGrant, CustomPageFrameRevocation} from '../contracts/custom-page.js';

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

export interface CustomPageFrameLike {
  readonly frameTreeNodeId: number;
  readonly processId: number;
  readonly routingId: number;
  readonly url: string;
  readonly parent: CustomPageFrameLike | null;
  isDestroyed?(): boolean;
}

export interface CustomPageNavigationDetails {
  readonly url: string;
  readonly isMainFrame: boolean;
  readonly frame: CustomPageFrameLike | null;
}

interface PendingCustomPage extends CustomPageFrameTarget {
  readonly webContentsId: number;
  readonly epoch: number;
  frameTreeNodeId?: number;
}

interface ActiveCustomPage extends PendingCustomPage {
  readonly frameTreeNodeId: number;
  readonly processId: number;
  readonly routingId: number;
  readonly url: string;
}

const customPageToken = /^[\x21-\x7e]{1,256}$/;
const validToken = (value: unknown): value is string => typeof value === 'string' && customPageToken.test(value);
function parseUrl(url: unknown): URL | undefined {
  if (typeof url !== 'string' || !url.trim()) return undefined;
  try { return new URL(url); } catch { return undefined; }
}
function frameNonce(url: string): string | undefined {
  try { return new URL(url).searchParams.get('moteFrame') ?? undefined; } catch { return undefined; }
}
function matchesEntry(url: string, entryUrl: string): boolean {
  try {
    const actual = new URL(url), entry = new URL(entryUrl);
    if (actual.protocol !== entry.protocol || actual.host !== entry.host
      || actual.pathname !== entry.pathname || actual.hash !== entry.hash) return false;
    // Compare decoded query values without reserializing the remaining query:
    // `URLSearchParams` rewrites `%20` to `+`, which would reject a correctly
    // loaded encoded entry URL.
    const params = (value: URL) => [...value.searchParams].filter(([key]) => key !== 'moteFrame');
    const actualParams = params(actual), entryParams = params(entry);
    return actualParams.length === entryParams.length
      && actualParams.every(([key, value], index) => key === entryParams[index]![0] && value === entryParams[index]![1]);
  } catch { return false; }
}

/** Main-process-only custom page frame registry. A trusted host prepares a
 * nonce before creating the iframe; claim binds exactly one direct child whose
 * URL carries that nonce. frameTreeNodeId is the stable identity; process and
 * routing ids are observations only. Any child navigation of a bound frame is
 * denied and revokes its epoch. */
export class CustomPageFrameGuard {
  #pending = new Map<string, PendingCustomPage>();
  #active = new Map<string, ActiveCustomPage>();
  /** Deny-only tombstones for frames whose epoch was revoked. Cancelling one
   * navigation leaves the live document running, so every later navigation of
   * the same frame must stay blocked until the frame is destroyed. */
  #revoked = new Map<string, {webContentsId: number; frameTreeNodeId: number}>();
  #onRevoke?: (webContentsId: number, revocation: CustomPageFrameRevocation) => void;
  #epoch = 0;

  /** The trusted host subscribes here; revocations are pushed to the main
   * frame so the consumer can end the channel for the exact granted epoch. */
  setRevocationListener(listener: (webContentsId: number, revocation: CustomPageFrameRevocation) => void): void {
    this.#onRevoke = listener;
  }

  prepare(webContentsId: number, target: CustomPageFrameTarget): {epoch: number} {
    if (!validToken(target.instanceId) || !validToken(target.nonce) || !validToken(target.documentKey))
      throw new TypeError('Invalid custom page target');
    if (!parseUrl(target.entryUrl)) throw new TypeError('Invalid custom page entry URL');
    if ([...this.#pending.values(), ...this.#active.values()].some(value => value.nonce === target.nonce))
      throw new Error('Custom page nonce is already bound');
    const epoch = ++this.#epoch;
    this.#pending.set(webContentsId + ':' + target.nonce, {...target, webContentsId, epoch});
    return {epoch};
  }

  claim(webContentsId: number, claim: CustomPageFrameClaim, mainFrame: CustomPageFrameLike): CustomPageFrameGrant {
    if (!validToken(claim.instanceId) || !validToken(claim.nonce) || !validToken(claim.documentKey))
      throw new TypeError('Invalid custom page claim');
    const key = webContentsId + ':' + claim.nonce, pending = this.#pending.get(key);
    if (!pending || pending.instanceId !== claim.instanceId || pending.documentKey !== claim.documentKey)
      throw new Error('Custom page claim is not prepared');
    // The initial navigation must have pinned this pending entry to a frame.
    // An unpinned frame (for example about:blank/srcdoc, which emit no
    // pre-commit navigation event) is never treated as protected.
    if (pending.frameTreeNodeId === undefined)
      throw new Error('Custom page frame is not bound to a navigation');
    const frames = (mainFrame as CustomPageFrameLike & {framesInSubtree?: readonly CustomPageFrameLike[]}).framesInSubtree ?? [];
    const candidates = [...frames].filter(frame => frame.parent?.frameTreeNodeId === mainFrame.frameTreeNodeId
      && !frame.isDestroyed?.() && frameNonce(frame.url) === pending.nonce && matchesEntry(frame.url, pending.entryUrl));
    if (candidates.length !== 1) throw new Error('Custom page frame is ambiguous or missing');
    const frame = candidates[0]!;
    // A claim for any other frame is rejected rather than rebound.
    if (pending.frameTreeNodeId !== frame.frameTreeNodeId)
      throw new Error('Custom page frame does not match the bound navigation');
    this.#pending.delete(key);
    this.#active.set(webContentsId + ':' + frame.frameTreeNodeId, {
      ...pending, frameTreeNodeId: frame.frameTreeNodeId, processId: frame.processId, routingId: frame.routingId, url: frame.url,
    });
    return {frameTreeNodeId: frame.frameTreeNodeId, epoch: pending.epoch};
  }

  willNavigate(webContentsId: number, details: CustomPageNavigationDetails): boolean {
    if (details.isMainFrame) return false;
    if (!details.frame) return true;
    const frameTreeNodeId = details.frame.frameTreeNodeId;
    const frameKey = webContentsId + ':' + frameTreeNodeId;
    // A revoked frame stays blocked until it is destroyed. Cancelling one
    // navigation does not stop the live document from trying again.
    if (this.#revoked.has(frameKey)) return true;
    const active = this.#active.get(frameKey);
    if (active) {
      this.#active.delete(frameKey);
      this.#revoke(webContentsId, frameTreeNodeId, active);
      return true;
    }
    // A pending entry already pinned to this frame may keep only its first
    // (initial) navigation; every later navigation is denied and revoked.
    const bound = [...this.#pending.values()].find(value => value.webContentsId === webContentsId
      && value.frameTreeNodeId === frameTreeNodeId);
    if (bound) {
      this.#pending.delete(webContentsId + ':' + bound.nonce);
      this.#revoke(webContentsId, frameTreeNodeId, bound);
      return true;
    }
    const pending = [...this.#pending.values()].find(value => value.webContentsId === webContentsId
      && value.nonce === frameNonce(details.url) && matchesEntry(details.url, value.entryUrl));
    if (!pending) return false;
    if (pending.frameTreeNodeId === undefined) {
      pending.frameTreeNodeId = frameTreeNodeId;
      return false;
    }
    // A different frame reusing the prepared nonce is never allowed.
    this.#pending.delete(webContentsId + ':' + pending.nonce);
    this.#revoke(webContentsId, frameTreeNodeId, pending);
    return true;
  }

  #revoke(webContentsId: number, frameTreeNodeId: number,
    entry: {instanceId: string; nonce: string; documentKey: string; epoch: number}): void {
    this.#revoked.set(webContentsId + ':' + frameTreeNodeId, {webContentsId, frameTreeNodeId});
    this.#epoch++;
    this.#onRevoke?.(webContentsId, {
      instanceId: entry.instanceId, nonce: entry.nonce, documentKey: entry.documentKey, frameTreeNodeId, epoch: entry.epoch,
    });
  }

  /** Drop entries whose frame is gone. frameTreeNodeId is never reused, so a
   * destroyed frame cannot be rebound to a new document. */
  prune(webContentsId: number, mainFrame: CustomPageFrameLike & {framesInSubtree?: readonly CustomPageFrameLike[]}): void {
    const live = new Set((mainFrame.framesInSubtree ?? []).map(frame => frame.frameTreeNodeId));
    for (const [key, value] of this.#active)
      if (value.webContentsId === webContentsId && !live.has(value.frameTreeNodeId)) this.#active.delete(key);
    for (const [key, value] of this.#pending)
      if (value.webContentsId === webContentsId && value.frameTreeNodeId !== undefined && !live.has(value.frameTreeNodeId))
        this.#pending.delete(key);
    for (const [key, value] of this.#revoked)
      if (value.webContentsId === webContentsId && !live.has(value.frameTreeNodeId)) this.#revoked.delete(key);
  }

  /** Main reload/close: revoke pending and active entries, but keep revoked
   * frames blocked until `prune` observes that they are gone. */
  revokeWindow(webContentsId: number): void {
    for (const [key, value] of this.#pending) {
      if (value.webContentsId !== webContentsId) continue;
      this.#pending.delete(key);
      // A pinned pending frame may still be alive during reload; block it
      // before it can navigate to a replacement document.
      if (value.frameTreeNodeId !== undefined) this.#revoke(webContentsId, value.frameTreeNodeId, value);
    }
    for (const [key, value] of this.#active) {
      if (value.webContentsId !== webContentsId) continue;
      this.#active.delete(key);
      this.#revoke(webContentsId, value.frameTreeNodeId, value);
    }
    this.#epoch++;
  }

  /** Window teardown: every frame of this webContents is gone, so drop the
   * tombstones as well. */
  forgetWindow(webContentsId: number): void {
    for (const [key, value] of this.#pending) if (value.webContentsId === webContentsId) this.#pending.delete(key);
    for (const [key, value] of this.#active) if (value.webContentsId === webContentsId) this.#active.delete(key);
    for (const [key, value] of this.#revoked) if (value.webContentsId === webContentsId) this.#revoked.delete(key);
    this.#epoch++;
  }

  revokeAll(): void { this.#pending.clear(); this.#active.clear(); this.#revoked.clear(); this.#epoch++; }
}

export class DesktopPluginHost {
  #router: IpcRouter;
  #native: NativeProviderRegistry;
  #ownership = new ChannelOwnership();
  #windows = new Map<number, WindowFacts>();
  #customPages = new CustomPageFrameGuard();
  #scopes = new Map<string, InternalScope>();
  #mainWindowOpen = false;
  #quitPromise: Promise<void> | null = null;
  #closing = false;

  constructor(options: {router: IpcRouter; native: NativeProviderRegistry}) {
    this.#router = options.router;
    this.#native = options.native;
  }

  get native(): NativeProviderRegistry { return this.#native; }
  /** Read-only live view of the host's window table for the IPC adapter. */
  get windowFacts(): ReadonlyMap<number, WindowFacts> { return this.#windows; }
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
    this.forgetCustomPages(senderId);
    if (facts?.role === 'main') this.#mainWindowOpen = false;
  }

  /** Trusted main-frame prepare; the renderer then creates the iframe with a
   * unique `moteFrame=<nonce>` URL. No caller-provided frame identity is trusted. */
  prepareCustomPageFrame(webContentsId: number, target: CustomPageFrameTarget): {epoch: number} {
    return this.#customPages.prepare(webContentsId, target);
  }
  /** Bind exactly one direct child frame carrying the prepared nonce. */
  claimCustomPageFrame(webContentsId: number, claim: CustomPageFrameClaim, mainFrame: CustomPageFrameLike): CustomPageFrameGrant {
    return this.#customPages.claim(webContentsId, claim, mainFrame);
  }
  /** True means the caller must call preventDefault(). */
  customPageWillNavigate(webContentsId: number, details: CustomPageNavigationDetails): boolean {
    return this.#customPages.willNavigate(webContentsId, details);
  }
  /** Main reload or process loss revokes pending/bound epochs and keeps the
   * affected frames blocked until they are destroyed. */
  revokeCustomPages(webContentsId: number): void { this.#customPages.revokeWindow(webContentsId); }
  /** Window teardown drops every frame record for this webContents. */
  forgetCustomPages(webContentsId: number): void { this.#customPages.forgetWindow(webContentsId); }
  /** The trusted host ends the exact granted channel when a frame is revoked. */
  onCustomPageRevoked(listener: (webContentsId: number, revocation: CustomPageFrameRevocation) => void): void {
    this.#customPages.setRevocationListener(listener);
  }
  /** Frame destruction is observed lazily: a vanished frame is pruned so its
   * epoch can never be claimed again. */
  pruneCustomPages(webContentsId: number, mainFrame: CustomPageFrameLike): void { this.#customPages.prune(webContentsId, mainFrame); }

  createScope(options: {instanceId: string; capabilities: readonly string[]}): PluginScopeHandle {
    if (this.#closing) throw new TypeError('Host is shutting down');
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
  async startPlugin(scope: PluginScopeHandle, factory: (scope: PluginScopeHandle) => unknown): Promise<{started: true} | {started: false; error: unknown; rollbackErrors?: unknown[]}> {
    const internal = scopeInternals.get(scope);
    if (!internal) throw new TypeError('Unknown plugin scope');
    try {
      await factory(scope);
      return {started: true};
    } catch (error) {
      const rollbackErrors = this.#revokeScope(internal, {keepDurable: true});
      return {started: false, error, ...(rollbackErrors.length > 0 ? {rollbackErrors} : {})};
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
    // Fence new admission before snapshotting work: no new scopes, IPC calls
    // or jobs may enter while durable drains are awaited; already accepted
    // work keeps its resources until its drain completes.
    this.#closing = true;
    for (const scope of this.#scopes.values()) scope.revoked = true;
    const drains: Promise<unknown>[] = [];
    for (const scope of this.#scopes.values())
      for (const job of scope.jobs.values()) if (job.durable && job.drain) drains.push(Promise.resolve().then(job.drain));
    const results = await Promise.allSettled(drains);
    const cleanupErrors: unknown[] = [];
    for (const scope of this.#scopes.values()) cleanupErrors.push(...this.#revokeScope(scope, {keepDurable: false}));
    this.#scopes.clear();
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason);
    const errors = [...failed, ...cleanupErrors];
    if (errors.length > 0) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'quit cleanup failed');
  }

  /** Attempt all cleanup steps and report the collected errors; a scope with
   * leftover registrations stays tracked so the caller can retry. */
  stopScope(instanceId: string): unknown[] {
    const scope = this.#scopes.get(instanceId);
    if (!scope) return [];
    const errors = this.#revokeScope(scope, {keepDurable: false});
    if (errors.length === 0) this.#scopes.delete(instanceId);
    return errors;
  }

  /** Every cleanup step is attempted independently; failures are collected
   * and reported after cleanup so one throwing disposer never strands later
   * scopes or registrations. */
  #revokeScope(scope: InternalScope, options: {keepDurable: boolean}): unknown[] {
    const errors: unknown[] = [];
    scope.revoked = true;
    try { scope.ipc.dispose(); } catch (error) { errors.push(error); }
    for (const [id, job] of [...scope.jobs]) if (!(options.keepDurable && job.durable)) scope.jobs.delete(id);
    scope.controller.abort();
    for (const dispose of scope.disposers) {
      try { dispose(); } catch (error) { errors.push(error); }
    }
    scope.disposers.clear();
    return errors;
  }
}

/** Structural Electron surface so the adapter stays testable without
 * Electron: the real ipcMain satisfies it. */
export interface IpcMainEventLike {
  readonly sender: {readonly id: number; readonly mainFrame: unknown};
  readonly senderFrame: {readonly url: string} | null;
}
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainEventLike, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

/** Real ipcMain adapter: sender/frame identity comes from the event and the
 * role is mapped by the host's own window table — a renderer never reports
 * its role or capabilities. Invoke envelopes are unwrapped so renderer-facing
 * behavior (raw value or thrown denial) matches the existing handlers. */
export function electronIpcRouter(ipcMain: IpcMainLike, windows: () => ReadonlyMap<number, WindowFacts>): IpcRouter {
  return {
    handle(channel, listener) {
      ipcMain.handle(channel, async (event, ...args) => {
        const view: IpcCallerView = {
          senderId: event.sender.id,
          frameIsMain: event.senderFrame === event.sender.mainFrame,
          frameUrl: event.senderFrame?.url,
          windowRole: windows().get(event.sender.id)?.role ?? 'main',
        };
        const result = await listener(view, args) as IpcInvokeResult;
        if (!result.ok) throw new Error(`IPC denied: ${result.denial}`);
        return result.value;
      });
    },
    removeHandler(channel) { ipcMain.removeHandler(channel); },
  };
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
  /** Read-only inventory view for lifecycle tests and diagnostics. */
  get jobIds(): readonly string[] { return [...this.#jobs.keys()]; }
  registerIpc(spec: IpcServiceSpec, handler: IpcListener): void {
    if (this.#revoked()) throw new TypeError('Scope is revoked');
    this.#ipc.register(spec, handler);
  }
  registerJob(job: PluginJob): void {
    if (this.#revoked()) throw new TypeError('Scope is revoked');
    if (this.#jobs.has(job.id)) throw new TypeError(`Job already registered: ${job.id}`);
    this.#jobs.set(job.id, job);
  }
  defer(dispose: () => void): void { this.#disposers.add(dispose); }
}
