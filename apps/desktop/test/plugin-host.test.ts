import {describe, expect, it} from 'vitest';
import {DesktopPluginHost, electronIpcRouter} from '../src/plugin-host/desktop-host.js';
import {ChannelOwnership, IpcScope as IpcScopeAdapter, type ScopeAccess} from '../src/plugin-host/ipc-registry.js';
import {NativeProviderRegistry} from '../src/plugin-host/native-registry.js';
import type {IpcCallerView, IpcInvokeResult, IpcRouter} from '../src/plugin-host/ipc-registry.js';

const makeRouter = () => {
  const handlers = new Map<string, (view: IpcCallerView, args: readonly unknown[]) => unknown>();
  const removed: string[] = [];
  const router: IpcRouter = {
    handle: (channel, listener) => { if (handlers.has(channel)) throw new Error('duplicate'); handlers.set(channel, listener); },
    removeHandler: channel => { handlers.delete(channel); removed.push(channel); },
  };
  return {
    router, removed,
    invoke: (channel: string, view: IpcCallerView, args: readonly unknown[] = []) =>
      handlers.get(channel)?.(view, args) as Promise<IpcInvokeResult> | undefined,
    has: (channel: string) => handlers.has(channel),
  };
};

const hostWith = () => {
  const fake = makeRouter();
  const host = new DesktopPluginHost({router: fake.router, native: new NativeProviderRegistry('mac')});
  return {host, router: fake};
};

const MAIN = (senderId = 7): IpcCallerView => ({senderId, frameIsMain: true, windowRole: 'main'});

describe('restricted IPC authorization', () => {
  it('denies fake senders, subframes, wrong roles and missing capabilities without running handlers', async () => {
    const {host, router} = hostWith();
    host.registerWindow(7, 'main');
    host.registerWindow(8, 'quick-note');
    const scope = host.createScope({instanceId: 'inst-notes', capabilities: ['notes.write']});
    let calls = 0;
    scope.registerIpc({channel: 'notes.save', capability: 'notes.write', windowRoles: ['main']}, () => { calls++; return 'saved'; });

    expect(await router.invoke('notes.save', {senderId: 99, frameIsMain: true, windowRole: 'main'}))
      .toEqual({ok: false, denial: 'unknown-sender'});
    expect(await router.invoke('notes.save', {senderId: 7, frameIsMain: false, windowRole: 'main'}))
      .toEqual({ok: false, denial: 'subframe'});
    expect(await router.invoke('notes.save', {senderId: 8, frameIsMain: true, windowRole: 'quick-note'}))
      .toEqual({ok: false, denial: 'wrong-window'});
    expect(calls).toBe(0);

    const weak = host.createScope({instanceId: 'inst-weak', capabilities: ['other.cap']});
    weak.registerIpc({channel: 'weak.call', capability: 'notes.write'}, () => { calls++; });
    expect(await router.invoke('weak.call', MAIN()))
      .toEqual({ok: false, denial: 'no-capability'});
    expect(calls).toBe(0);

    expect(await router.invoke('notes.save', MAIN())).toEqual({ok: true, value: 'saved'});
    expect(calls).toBe(1);
  });

  it('omitted windowRoles allow only the main window and callerCapability binds the caller', async () => {
    const {host, router} = hostWith();
    host.registerWindow(7, 'main', ['notes.write']);
    host.registerWindow(8, 'quick-note');
    const scope = host.createScope({instanceId: 'inst-notes', capabilities: ['notes.write']});
    scope.registerIpc({channel: 'notes.save', capability: 'notes.write'}, () => 'saved');
    // No windowRoles declared: only the main-window role may call.
    expect(await router.invoke('notes.save', {senderId: 8, frameIsMain: true, windowRole: 'quick-note'}))
      .toEqual({ok: false, denial: 'wrong-window'});

    scope.registerIpc({channel: 'notes.secret', capability: 'notes.write', callerCapability: 'notes.write'}, () => 'secret');
    // The quick-note window lacks the caller capability even on its main frame.
    expect(await router.invoke('notes.secret', {senderId: 8, frameIsMain: true, windowRole: 'quick-note'}))
      .toEqual({ok: false, denial: 'wrong-window'});
    const admin = hostWith();
    admin.host.registerWindow(7, 'main');
    const s = admin.host.createScope({instanceId: 'x', capabilities: ['cap']});
    s.registerIpc({channel: 'x.admin', capability: 'cap', callerCapability: 'admin'}, () => 'no');
    expect(await admin.router.invoke('x.admin', MAIN())).toEqual({ok: false, denial: 'no-capability'});
  });

  it('awaits async handlers so replies cross the structured-clone boundary', async () => {
    const {host, router} = hostWith();
    host.registerWindow(7, 'main');
    const scope = host.createScope({instanceId: 'inst-async', capabilities: ['cap']});
    scope.registerIpc({channel: 'async.get', capability: 'cap'}, async () => 'resolved');
    const result = await router.invoke('async.get', MAIN());
    expect(result).toEqual({ok: true, value: 'resolved'});
    scope.registerIpc({channel: 'async.fail', capability: 'cap'}, async () => { throw new Error('handler failed'); });
    await expect(router.invoke('async.fail', MAIN())).rejects.toThrow('handler failed');
  });

  it('a conflicting registration never removes another scope handler', async () => {
    const {host, router} = hostWith();
    host.registerWindow(7, 'main');
    const a = host.createScope({instanceId: 'inst-a', capabilities: ['cap']});
    a.registerIpc({channel: 'shared.call', capability: 'cap'}, () => 'A');
    const b = host.createScope({instanceId: 'inst-b', capabilities: ['cap']});
    const outcome = await host.startPlugin(b, scope => {
      expect(() => scope.registerIpc({channel: 'shared.call', capability: 'cap'}, () => 'B')).toThrow('already registered');
      throw new Error('startup failed');
    });
    expect(outcome.started).toBe(false);
    expect(await router.invoke('shared.call', MAIN())).toEqual({ok: true, value: 'A'}, 'the first owner keeps its handler');
    expect(router.removed).not.toContain('shared.call');
  });
});

describe('startup rollback and lifecycle', () => {
  it('revokes a half-initialized scope, keeps durable jobs for drain, other plugins and quit survive', async () => {
    const {host, router} = hostWith();
    host.registerWindow(7, 'main');
    const ok = host.createScope({instanceId: 'inst-ok', capabilities: ['cap.a']});
    ok.registerIpc({channel: 'ok.call', capability: 'cap.a'}, () => 'fine');

    const failing = host.createScope({instanceId: 'inst-bad', capabilities: ['cap.b']});
    let disposerRan = 0, drained = 0;
    const outcome = await host.startPlugin(failing, scope => {
      scope.registerIpc({channel: 'bad.call', capability: 'cap.b'}, () => 'never');
      scope.registerJob({id: 'transient'});
      scope.registerJob({id: 'upload-queue', durable: true, drain: async () => { drained++; }});
      scope.defer(() => { disposerRan++; });
      throw new Error('half init');
    });

    expect(outcome.started).toBe(false);
    expect(router.has('bad.call')).toBe(false);
    expect(router.removed).toContain('bad.call');
    expect(router.has('ok.call')).toBe(true);
    expect(disposerRan).toBe(1);
    expect(await router.invoke('ok.call', MAIN())).toEqual({ok: true, value: 'fine'});

    await host.requestQuit();
    expect(drained).toBe(1);
    expect(router.has('ok.call')).toBe(false);
  });

  it('main-window close keeps durable background work; explicit quit drains then disposes', async () => {
    const {host, router} = hostWith();
    host.registerWindow(7, 'main');
    const scope = host.createScope({instanceId: 'inst-durable', capabilities: ['cap.d']});
    scope.registerIpc({channel: 'd.call', capability: 'cap.d'}, () => 'alive');
    let drained = 0;
    scope.registerJob({id: 'upload-queue', durable: true, drain: async () => { drained++; }});

    host.onMainWindowClosed();
    expect(host.mainWindowOpen).toBe(false);
    expect(await router.invoke('d.call', MAIN())).toEqual({ok: true, value: 'alive'});
    expect(drained).toBe(0);

    await host.requestQuit();
    expect(drained).toBe(1);
    expect(router.has('d.call')).toBe(false);
  });

  it('a failed drain still disposes every scope and reports through the shared quit promise', async () => {
    const {host, router} = hostWith();
    host.registerWindow(7, 'main');
    const scope = host.createScope({instanceId: 'inst-q', capabilities: ['cap']});
    scope.registerIpc({channel: 'q.call', capability: 'cap'}, () => 'x');
    let drained = 0;
    scope.registerJob({id: 'ok-drain', durable: true, drain: async () => { drained++; }});
    scope.registerJob({id: 'bad-drain', durable: true, drain: async () => { throw new Error('store closed'); }});

    const quitting = host.requestQuit();
    await expect(quitting).rejects.toThrow('store closed');
    expect(drained).toBe(1, 'other drains still ran');
    expect(router.has('q.call')).toBe(false, 'cleanup completes despite drain failure');
    expect(await router.invoke('q.call', MAIN())).toBeUndefined();
    await expect(host.requestQuit()).rejects.toThrow('store closed');
  });

  it('a scope handle cannot widen its own grants', () => {
    const {host} = hostWith();
    const scope = host.createScope({instanceId: 'inst-iso', capabilities: ['cap.a']});
    const mutable = scope as unknown as Record<string, unknown>;
    expect(mutable.internal).toBeUndefined();
    // Nothing reachable from the handle can add 'cap.b'.
    expect(JSON.stringify(Object.getOwnPropertyNames(scope))).not.toContain('capabilities');
  });
});

describe('real ipcMain adapter seam', () => {
  it('maps sender/frame/role from real event facts and unwraps envelopes', async () => {
    const {host} = hostWith();
    host.registerWindow(7, 'main');
    const registered = new Map<string, (event: {sender: {id: number; mainFrame: unknown}; senderFrame: {url: string} | null}, ...args: unknown[]) => unknown>();
    const removed: string[] = [];
    const ipcMain = {
      handle: (channel: string, listener: never) => { registered.set(channel, listener); },
      removeHandler: (channel: string) => { registered.delete(channel); removed.push(channel); },
    };
    const router = electronIpcRouter(ipcMain, () => host.windowFacts);
    const access: ScopeAccess = {instanceId: 'inst-real', capabilities: new Set(['cap']), isRevoked: () => false};
    const ipc = new IpcScopeAdapter(access, router, host.windowFacts, new ChannelOwnership());
    ipc.register({channel: 'real.call', capability: 'cap', roleFrameUrls: {main: ['file:///index.html']}}, () => 'real-value');
    const mainFrame = {url: 'file:///index.html'};
    const event = {sender: {id: 7, mainFrame}, senderFrame: mainFrame};
    // The renderer receives the raw value, not an envelope.
    await expect(registered.get('real.call')!(event)).resolves.toBe('real-value');
    // A forged sender or wrong URL is denied before the handler runs.
    const forged = {sender: {id: 99, mainFrame}, senderFrame: mainFrame};
    await expect(registered.get('real.call')!(forged)).rejects.toThrow('IPC denied');
    await expect(registered.get('real.call')!({sender: {id: 7, mainFrame}, senderFrame: {url: 'file:///evil.html'}})).rejects.toThrow('IPC denied');
  });
});

describe('cleanup ordering', () => {
  it('a throwing disposer never strands later disposers, scopes or the quit latch', async () => {
    const {host, router} = hostWith();
    host.registerWindow(7, 'main');
    const a = host.createScope({instanceId: 'inst-d1', capabilities: ['cap']});
    a.registerIpc({channel: 'd1.call', capability: 'cap'}, () => 'a');
    const order: string[] = [];
    a.defer(() => { order.push('a1'); throw new Error('disposer blew'); });
    a.defer(() => { order.push('a2'); });
    const b = host.createScope({instanceId: 'inst-d2', capabilities: ['cap']});
    b.registerIpc({channel: 'd2.call', capability: 'cap'}, () => 'b');
    await expect(host.requestQuit()).rejects.toThrow('disposer blew');
    expect(order).toEqual(['a1', 'a2']);
    expect(router.has('d1.call')).toBe(false);
    expect(router.has('d2.call')).toBe(false);
    // The shared quit promise reports the same failure, not a stuck latch.
    await expect(host.requestQuit()).rejects.toThrow('disposer blew');
  });

  it('quit fences admission before draining: no invokes, jobs or new scopes', async () => {
    const {host, router} = hostWith();
    host.registerWindow(7, 'main');
    const scope = host.createScope({instanceId: 'inst-f', capabilities: ['cap']});
    scope.registerIpc({channel: 'f.call', capability: 'cap'}, () => 'x');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    scope.registerJob({id: 'slow', durable: true, drain: async () => { await gate; }});
    const quitting = host.requestQuit();
    // While the drain is pending, admission is already closed.
    expect(await router.invoke('f.call', MAIN())).toEqual({ok: false, denial: 'scope-revoked'});
    expect(() => scope.registerJob({id: 'late'})).toThrow('Scope is revoked');
    expect(() => host.createScope({instanceId: 'inst-late', capabilities: []})).toThrow('shutting down');
    release();
    await quitting;
    expect(router.has('f.call')).toBe(false);
  });

  it('a role absent from roleFrameUrls is denied even on the main frame', async () => {
    const {host, router} = hostWith();
    host.registerWindow(7, 'main');
    host.registerWindow(8, 'quick-note');
    const scope = host.createScope({instanceId: 'inst-url', capabilities: ['cap']});
    let calls = 0;
    scope.registerIpc({channel: 'url.call', capability: 'cap', windowRoles: ['main', 'quick-note'], roleFrameUrls: {main: ['file:///index.html']}}, () => { calls++; });
    const frame = {url: 'file:///index.html'};
    expect(await router.invoke('url.call', {senderId: 8, frameIsMain: true, windowRole: 'quick-note', frameUrl: frame.url}))
      .toEqual({ok: false, denial: 'wrong-window'});
    expect(calls).toBe(0);
    expect(await router.invoke('url.call', {senderId: 7, frameIsMain: true, windowRole: 'main', frameUrl: 'file:///index.html'}))
      .toEqual({ok: true, value: undefined});
  });
});

describe('stopScope', () => {
  it('reports cleanup errors and keeps the scope retryable', async () => {
  const {host, router} = hostWith();
  host.registerWindow(7, 'main');
  const scope = host.createScope({instanceId: 'inst-retry', capabilities: ['cap']});
  scope.registerIpc({channel: 'r.one', capability: 'cap'}, () => 1);
  scope.registerIpc({channel: 'r.two', capability: 'cap'}, () => 2);
  // First removal throws; the other channel must still be attempted.
  const original = router.router.removeHandler;
  let failedOnce = false;
  router.router.removeHandler = channel => {
    if (channel === 'r.one' && !failedOnce) { failedOnce = true; throw new Error('remove failed'); }
    original(channel);
  };
  const errors = host.stopScope('inst-retry');
  expect(errors.length).toBe(1);
  expect(router.has('r.two')).toBe(false);
  expect(router.has('r.one')).toBe(true, 'failed removal stays registered for retry');
  expect(host.stopScope('inst-retry')).toEqual([], 'retry finishes and releases the scope');
  expect(router.has('r.one')).toBe(false);
});
});
