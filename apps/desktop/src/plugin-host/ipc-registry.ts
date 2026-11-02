/** Restricted IPC registration owned by plugin scopes. Every invoke is checked
 * against the actual sender, main-frame identity, window role, calling
 * instance/capability and the provider's declared capability before a handler
 * may run; failure denies the call with no local write or native effect, and
 * disposal revokes only the channels that scope actually owns. */
export type WindowRole = 'main' | 'quick-note' | 'settings';

/** The verified facts about one invoke, produced by the real Electron adapter
 * (ipcMain event.sender / senderFrame / owning BrowserWindow role). */
export interface IpcCallerView {
  readonly senderId: number;
  readonly frameIsMain: boolean;
  /** Role assigned by the host for this sender; never self-reported. */
  readonly windowRole: WindowRole;
  /** The frame's actual URL, checked exactly like the existing trusted()
   * senderFrame.url comparison. */
  readonly frameUrl?: string;
}

export type IpcListener = (view: IpcCallerView, args: readonly unknown[]) => unknown;

/** Narrow adapter over ipcMain; tests substitute a recording fake. */
export interface IpcRouter {
  handle(channel: string, listener: IpcListener): void;
  removeHandler(channel: string): void;
}

export interface IpcServiceSpec {
  readonly channel: string;
  /** Capability the PROVIDING scope must hold to offer this service. */
  readonly capability: string;
  /** Allowed window roles; omitted means the main window only. */
  readonly windowRoles?: readonly WindowRole[];
  /** Capability the CALLING window/scope must hold; omitted = any registered
   * window of an allowed role may call. */
  readonly callerCapability?: string;
  /** Exact frame URLs allowed per window role; preserves the trusted()
   * senderFrame.url binding. A role absent here may never call. */
  readonly roleFrameUrls?: Partial<Record<WindowRole, readonly string[]>>;
  /** Default true: only the main frame may invoke plugin IPC. */
  readonly mainFrameOnly?: boolean;
}

export type IpcDenial = 'unknown-sender' | 'subframe' | 'wrong-window' | 'no-capability' | 'scope-revoked';
export type IpcInvokeResult = {readonly ok: true; readonly value: unknown} | {readonly ok: false; readonly denial: IpcDenial};

export interface ScopeAccess {
  readonly instanceId: string;
  readonly capabilities: ReadonlySet<string>;
  isRevoked(): boolean;
}

export interface WindowFacts {readonly role: WindowRole; readonly capabilities: ReadonlySet<string>}

/** Host-wide channel ownership: a conflicting scope never records or removes
 * another scope's handler. */
export class ChannelOwnership {
  #owners = new Map<string, string>();
  claim(channel: string, ownerId: string): boolean {
    const existing = this.#owners.get(channel);
    if (existing !== undefined && existing !== ownerId) return false;
    this.#owners.set(channel, ownerId);
    return true;
  }
  release(channel: string, ownerId: string): void {
    if (this.#owners.get(channel) === ownerId) this.#owners.delete(channel);
  }
}

export class IpcScope {
  readonly access: ScopeAccess;
  #router: IpcRouter;
  #windows: ReadonlyMap<number, WindowFacts>;
  #ownership: ChannelOwnership;
  #registrations = new Map<string, IpcServiceSpec>();

  constructor(access: ScopeAccess, router: IpcRouter, windows: ReadonlyMap<number, WindowFacts>, ownership: ChannelOwnership) {
    this.access = access;
    this.#router = router;
    this.#windows = windows;
    this.#ownership = ownership;
  }

  get channels(): readonly string[] { return [...this.#registrations.keys()]; }

  /** Claim channel ownership first so a conflicting scope never reaches the
   * router, and record the registration only after the handler is actually
   * installed — rollback can then never remove another plugin's handler. */
  register(spec: IpcServiceSpec, handler: IpcListener): void {
    if (this.#registrations.has(spec.channel) || !this.#ownership.claim(spec.channel, this.access.instanceId))
      throw new TypeError(`IPC channel already registered: ${spec.channel}`);
    try {
      this.#router.handle(spec.channel, (view, args) => this.#invoke(spec, view, handler, args));
    } catch (error) {
      this.#ownership.release(spec.channel, this.access.instanceId);
      throw error;
    }
    this.#registrations.set(spec.channel, spec);
  }

  /** The envelope awaits the handler so a nested promise never crosses the
   * structured-clone boundary; a rejected handler propagates through the
   * listener instead of masquerading as success. */
  async #invoke(spec: IpcServiceSpec, view: IpcCallerView, handler: IpcListener, args: readonly unknown[]): Promise<IpcInvokeResult> {
    const denial = this.#check(spec, view);
    if (denial) return {ok: false, denial};
    return {ok: true, value: await handler(view, args)};
  }

  #check(spec: IpcServiceSpec, view: IpcCallerView): IpcDenial | null {
    if (this.access.isRevoked()) return 'scope-revoked';
    const caller = this.#windows.get(view.senderId);
    if (caller === undefined) return 'unknown-sender';
    if (spec.mainFrameOnly !== false && !view.frameIsMain) return 'subframe';
    const allowedRoles = spec.windowRoles ?? ['main'];
    if (!allowedRoles.includes(caller.role) || caller.role !== view.windowRole) return 'wrong-window';
    if (spec.roleFrameUrls !== undefined) {
      const urls = spec.roleFrameUrls[caller.role];
      if (urls === undefined || view.frameUrl === undefined || !urls.includes(view.frameUrl)) return 'wrong-window';
    }
    if (!this.access.capabilities.has(spec.capability)) return 'no-capability';
    if (spec.callerCapability !== undefined && !caller.capabilities.has(spec.callerCapability)) return 'no-capability';
    return null;
  }

  /** Revoke only the channels this scope actually owns. */
  dispose(): void {
    for (const channel of this.#registrations.keys()) {
      this.#router.removeHandler(channel);
      this.#ownership.release(channel, this.access.instanceId);
    }
    this.#registrations.clear();
  }
}
