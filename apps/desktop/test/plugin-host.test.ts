import {describe, expect, it} from 'vitest';
import {DesktopPluginHost} from '../src/plugin-host/desktop-host.js';
import {NativeProviderRegistry} from '../src/plugin-host/native-registry.js';
import type {IpcCallerView, IpcRouter} from '../src/plugin-host/ipc-registry.js';

const makeRouter = () => {
  const handlers = new Map<string, (view: IpcCallerView, args: readonly unknown[]) => unknown>();
  const removed: string[] = [];
  const router: IpcRouter = {
    handle: (channel, listener) => { handlers.set(channel, listener); },
    removeHandler: channel => { handlers.delete(channel); removed.push(channel); },
  };
  return {
    router, removed,
    invoke: (channel: string, view: IpcCallerView, args: readonly unknown[] = []) => handlers.get(channel)?.(view, args),
    has: (channel: string) => handlers.has(channel),
  };
};

const hostWith = () => {
  const fake = makeRouter();
  const host = new DesktopPluginHost({router: fake.router, native: new NativeProviderRegistry('mac')});
  return {host, router: fake};
};

describe('restricted IPC authorization', () => {
  it('denies fake senders, subframes, wrong roles and missing capabilities without running handlers', () => {
    const {host, router} = hostWith();
    host.registerWindow(7, 'main');
    host.registerWindow(8, 'quick-note');
    const scope = host.createScope({instanceId: 'inst-notes', capabilities: ['notes.write']});
    let calls = 0;
    scope.registerIpc({channel: 'notes.save', capability: 'notes.write', windowRoles: ['main']}, () => { calls++; return 'saved'; });

    expect(router.invoke('notes.save', {senderId: 99, frameIsMain: true, windowRole: 'main'}))
      .toEqual({ok: false, denial: 'unknown-sender'});
    expect(router.invoke('notes.save', {senderId: 7, frameIsMain: false, windowRole: 'main'}))
      .toEqual({ok: false, denial: 'subframe'});
    expect(router.invoke('notes.save', {senderId: 8, frameIsMain: true, windowRole: 'quick-note'}))
      .toEqual({ok: false, denial: 'wrong-window'});
    expect(calls).toBe(0);

    const weak = host.createScope({instanceId: 'inst-weak', capabilities: ['other.cap']});
    weak.registerIpc({channel: 'weak.call', capability: 'notes.write'}, () => { calls++; });
    expect(router.invoke('weak.call', {senderId: 7, frameIsMain: true, windowRole: 'main'}))
      .toEqual({ok: false, denial: 'no-capability'});
    expect(calls).toBe(0);

    expect(router.invoke('notes.save', {senderId: 7, frameIsMain: true, windowRole: 'main'}))
      .toEqual({ok: true, value: 'saved'});
    expect(calls).toBe(1);
  });
});

describe('startup rollback and lifecycle', () => {
  it('revokes a half-initialized scope, keeps durable bytes and other plugins, and quit still works', async () => {
    const {host, router} = hostWith();
    host.registerWindow(7, 'main');
    const ok = host.createScope({instanceId: 'inst-ok', capabilities: ['cap.a']});
    ok.registerIpc({channel: 'ok.call', capability: 'cap.a'}, () => 'fine');

    const failing = host.createScope({instanceId: 'inst-bad', capabilities: ['cap.b']});
    let disposerRan = 0;
    const outcome = await host.startPlugin(failing, scope => {
      scope.registerIpc({channel: 'bad.call', capability: 'cap.b'}, () => 'never');
      scope.registerJob({id: 'transient'});
      scope.registerJob({id: 'upload-queue', durable: true});
      scope.defer(() => { disposerRan++; });
      throw new Error('half init');
    });

    expect(outcome.started).toBe(false);
    expect(router.has('bad.call')).toBe(false);
    expect(router.removed).toContain('bad.call');
    expect(router.has('ok.call')).toBe(true);
    expect(disposerRan).toBe(1);
    // Durable bytes survive rollback: the durable job is still tracked for drain.
    expect(failing.internal.jobs.has('upload-queue')).toBe(true);
    expect(failing.internal.jobs.has('transient')).toBe(false);
    expect(router.invoke('bad.call', {senderId: 7, frameIsMain: true, windowRole: 'main'})).toBeUndefined();
    expect(router.invoke('ok.call', {senderId: 7, frameIsMain: true, windowRole: 'main'})).toEqual({ok: true, value: 'fine'});

    await host.requestQuit();
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
    // Background keeps serving; nothing is revoked or drained by window close.
    expect(router.invoke('d.call', {senderId: 7, frameIsMain: true, windowRole: 'main'})).toEqual({ok: true, value: 'alive'});
    expect(drained).toBe(0);

    await host.requestQuit();
    expect(drained).toBe(1);
    expect(router.has('d.call')).toBe(false);
    expect(router.invoke('d.call', {senderId: 7, frameIsMain: true, windowRole: 'main'})).toBeUndefined();
  });
});
