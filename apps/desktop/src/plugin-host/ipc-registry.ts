/** Restricted IPC registration owned by plugin scopes. Every invoke is checked
 * against the actual sender, main-frame identity, window role, declaring
 * instance and capability before a handler may run; failure denies the call
 * with no local write or native effect, and disposal revokes every handler,
 * subscription and timer the scope registered. */
export type WindowRole = 'main' | 'quick-note' | 'settings';

/** The verified facts about one invoke, produced by the real Electron adapter
 * (ipcMain event.sender / senderFrame / owning BrowserWindow role). */
export interface IpcCallerView {
  readonly senderId: number;
  readonly frameIsMain: boolean;
  readonly windowRole: WindowRole;
}

export type IpcListener = (view: IpcCallerView, args: readonly unknown[]) => unknown;

/** Narrow adapter over ipcMain; tests substitute a recording fake. */
export interface IpcRouter {
  handle(channel: string, listener: IpcListener): void;
  removeHandler(channel: string): void;
}

export interface IpcServiceSpec {
  readonly channel: string;
  /** Capability the caller's scope must actually hold. */
  readonly capability: string;
  /** Allowed window roles; a call from any other role is denied. */
  readonly windowRoles?: readonly WindowRole[];
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

/** A registered plugin scope's IPC surface. The host owns the windows table;
 * unregistered senders are never trusted. */
export class IpcScope {
  readonly access: ScopeAccess;
  #router: IpcRouter;
  #windows: ReadonlyMap<number, WindowRole>;
  #registrations = new Map<string, IpcServiceSpec>();

  constructor(access: ScopeAccess, router: IpcRouter, windows: ReadonlyMap<number, WindowRole>) {
    this.access = access;
    this.#router = router;
    this.#windows = windows;
  }

  get channels(): readonly string[] { return [...this.#registrations.keys()]; }

  register(spec: IpcServiceSpec, handler: IpcListener): void {
    if (this.#registrations.has(spec.channel)) throw new TypeError(`IPC channel already registered: ${spec.channel}`);
    this.#registrations.set(spec.channel, spec);
    this.#router.handle(spec.channel, (view, args) => this.#invoke(spec, view, handler, args));
  }

  #invoke(spec: IpcServiceSpec, view: IpcCallerView, handler: IpcListener, args: readonly unknown[]): IpcInvokeResult {
    const denial = this.#check(spec, view);
    if (denial) return {ok: false, denial};
    return {ok: true, value: handler(view, args)};
  }

  #check(spec: IpcServiceSpec, view: IpcCallerView): IpcDenial | null {
    if (this.access.isRevoked()) return 'scope-revoked';
    const role = this.#windows.get(view.senderId);
    if (role === undefined) return 'unknown-sender';
    if (spec.mainFrameOnly !== false && !view.frameIsMain) return 'subframe';
    if (spec.windowRoles && !spec.windowRoles.includes(role)) return 'wrong-window';
    if (role !== view.windowRole) return 'wrong-window';
    if (!this.access.capabilities.has(spec.capability)) return 'no-capability';
    return null;
  }

  /** Revoke every handler this scope registered; other scopes keep theirs. */
  dispose(): void {
    for (const channel of this.#registrations.keys()) this.#router.removeHandler(channel);
    this.#registrations.clear();
  }
}
