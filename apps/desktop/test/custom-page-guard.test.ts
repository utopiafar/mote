import {describe, expect, it} from 'vitest';
import {
  CustomPageFrameGuard,
  DesktopPluginHost,
  type CustomPageFrameLike,
  type CustomPageFrameRevocation,
  type CustomPageNavigationDetails,
} from '../src/plugin-host/desktop-host.js';
import {NativeProviderRegistry} from '../src/plugin-host/native-registry.js';
import type {IpcRouter} from '../src/plugin-host/ipc-registry.js';

type Frame = CustomPageFrameLike & {framesInSubtree?: readonly CustomPageFrameLike[]};

const frame = (id: number, url: string, parent: CustomPageFrameLike | null, destroyed = false): Frame => ({
  frameTreeNodeId: id,
  processId: 4,
  routingId: id + 2,
  url,
  parent,
  isDestroyed: () => destroyed,
});

const mainFrame = (children: readonly CustomPageFrameLike[], destroyed = false): Frame => ({
  frameTreeNodeId: 1,
  processId: 4,
  routingId: 1,
  url: 'file:///index.html',
  parent: null,
  isDestroyed: () => destroyed,
  framesInSubtree: children,
});

const entry = 'http://127.0.0.1/entry.html';
const withNonce = (url: string, nonce: string) => url + (url.includes('?') ? '&' : '?') + 'moteFrame=' + nonce;

const target = (nonce: string, entryUrl = entry) => ({
  instanceId: 'inst-a',
  nonce,
  documentKey: 'key-a',
  entryUrl,
});

const claimOf = (nonce: string) => ({instanceId: 'inst-a', nonce, documentKey: 'key-a'});

const navigation = (id: number | null, url: string, isMainFrame = false): CustomPageNavigationDetails => ({
  url,
  isMainFrame,
  frame: id === null ? null : frame(id, url, null),
});

/** The initial iframe load pins the pending entry to the real direct child. */
const pin = (guard: CustomPageFrameGuard, id: number, nonce: string, entryUrl = entry) => {
  expect(guard.willNavigate(7, navigation(id, withNonce(entryUrl, nonce)))).toBe(false);
};

const makeHost = () => {
  const handlers = new Map<string, unknown>();
  const router: IpcRouter = {
    handle: (channel, listener) => { handlers.set(channel, listener); },
    removeHandler: channel => { handlers.delete(channel); },
  };
  return new DesktopPluginHost({router, native: new NativeProviderRegistry('mac')});
};

describe('custom page frame guard', () => {
  it('binds exactly the direct child that carries the prepared nonce', () => {
    const guard = new CustomPageFrameGuard();
    expect(guard.prepare(7, target('n1'))).toEqual({epoch: 1});
    pin(guard, 4, 'n1');

    const other = frame(9, entry, mainFrame([]));
    const bound = frame(4, withNonce(entry, 'n1'), mainFrame([]));
    const main = mainFrame([other, bound]);

    expect(guard.claim(7, claimOf('n1'), main)).toEqual({frameTreeNodeId: 4, epoch: 1});
    // The pending entry is consumed: a late claim cannot reactivate it.
    expect(() => guard.claim(7, claimOf('n1'), main)).toThrow(/not prepared/);
  });

  it('keeps the entry query string while removing only the guard nonce', () => {
    const guard = new CustomPageFrameGuard();
    const entryUrl = 'http://127.0.0.1/entry.html?x=1';
    guard.prepare(7, target('n1', entryUrl));
    pin(guard, 4, 'n1', entryUrl);
    const bound = frame(4, withNonce(entryUrl, 'n1'), mainFrame([]));
    expect(guard.claim(7, claimOf('n1'), mainFrame([bound]))).toEqual({frameTreeNodeId: 4, epoch: 1});
  });

  it('matches encoded entry query values without reserializing them', () => {
    const guard = new CustomPageFrameGuard();
    const entryUrl = 'https://example.test/entry?q=hello%20world&x=%7E';
    guard.prepare(7, target('n1', entryUrl));
    pin(guard, 4, 'n1', entryUrl);
    const bound = frame(4, withNonce(entryUrl, 'n1'), mainFrame([]));
    expect(guard.claim(7, claimOf('n1'), mainFrame([bound]))).toEqual({frameTreeNodeId: 4, epoch: 1});
  });

  it('allows the first navigation of a pending frame and still claims it', () => {
    const guard = new CustomPageFrameGuard();
    guard.prepare(7, target('n1'));
    pin(guard, 4, 'n1');
    const bound = frame(4, withNonce(entry, 'n1'), mainFrame([]));
    expect(guard.claim(7, claimOf('n1'), mainFrame([bound]))).toEqual({frameTreeNodeId: 4, epoch: 1});
  });

  it('denies every navigation of a frame that is still pending', () => {
    const guard = new CustomPageFrameGuard();
    guard.prepare(7, target('n1'));
    pin(guard, 4, 'n1');
    expect(guard.willNavigate(7, navigation(4, 'http://127.0.0.1/other.html'))).toBe(true);
    expect(guard.willNavigate(7, navigation(4, 'http://127.0.0.1/other.html'))).toBe(true);
    // The revoked pending entry cannot be claimed later.
    expect(() => guard.claim(7, claimOf('n1'), mainFrame([frame(4, withNonce(entry, 'n1'), mainFrame([]))])))
      .toThrow(/not prepared/);
  });

  it('keeps denying repeated navigation attempts after the first cancellation', () => {
    const guard = new CustomPageFrameGuard();
    guard.prepare(7, target('n1'));
    pin(guard, 4, 'n1');
    const bound = frame(4, withNonce(entry, 'n1'), mainFrame([]));
    guard.claim(7, claimOf('n1'), mainFrame([bound]));

    // The first cancellation leaves the original document running; it can
    // retry, so the frame must stay blocked.
    expect(guard.willNavigate(7, navigation(4, 'http://127.0.0.1/entry2.html'))).toBe(true);
    expect(guard.willNavigate(7, navigation(4, 'http://127.0.0.1/entry2.html'))).toBe(true);
    expect(guard.willNavigate(7, navigation(4, 'http://127.0.0.1/entry3.html'))).toBe(true);
    expect(() => guard.claim(7, claimOf('n1'), mainFrame([bound]))).toThrow(/not prepared/);
  });

  it('pushes the granted identity and epoch when a bound frame is revoked', () => {
    const guard = new CustomPageFrameGuard();
    const seen: {webContentsId: number; revocation: CustomPageFrameRevocation}[] = [];
    guard.setRevocationListener((webContentsId, revocation) => seen.push({webContentsId, revocation}));
    guard.prepare(7, target('n1'));
    pin(guard, 4, 'n1');
    guard.claim(7, claimOf('n1'), mainFrame([frame(4, withNonce(entry, 'n1'), mainFrame([]))]));

    expect(guard.willNavigate(7, navigation(4, 'http://127.0.0.1/entry2.html'))).toBe(true);
    expect(seen).toEqual([{webContentsId: 7, revocation: {
      instanceId: 'inst-a', nonce: 'n1', documentKey: 'key-a', frameTreeNodeId: 4, epoch: 1,
    }}]);
    // A repeated attempt is still denied but does not emit a second revocation.
    expect(guard.willNavigate(7, navigation(4, 'http://127.0.0.1/entry2.html'))).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('pushes a revocation for every bound frame when the window is revoked', () => {
    const guard = new CustomPageFrameGuard();
    const seen: string[] = [];
    guard.setRevocationListener((_webContentsId, revocation) => seen.push(revocation.nonce));
    guard.prepare(7, target('n1'));
    pin(guard, 4, 'n1');
    guard.claim(7, claimOf('n1'), mainFrame([frame(4, withNonce(entry, 'n1'), mainFrame([]))]));
    guard.revokeWindow(7);
    expect(seen).toEqual(['n1']);
  });

  it('denies and revokes any navigation of a bound frame, regardless of process/routing change', () => {
    const guard = new CustomPageFrameGuard();
    guard.prepare(7, target('n1'));
    pin(guard, 4, 'n1');
    const bound = frame(4, withNonce(entry, 'n1'), mainFrame([]));
    guard.claim(7, claimOf('n1'), mainFrame([bound]));

    // A cross-process navigation keeps frameTreeNodeId but changes process and
    // routing ids; identity must still match.
    const swapped: CustomPageNavigationDetails = {
      url: 'http://127.0.0.1/entry2.html',
      isMainFrame: false,
      frame: {frameTreeNodeId: 4, processId: 5, routingId: 9, url: 'http://127.0.0.1/entry2.html', parent: null},
    };
    expect(guard.willNavigate(7, swapped)).toBe(true);
    expect(guard.willNavigate(7, swapped)).toBe(true);
  });

  it('denies a null frame and a missing frame instead of guessing by URL', () => {
    const guard = new CustomPageFrameGuard();
    guard.prepare(7, target('n1'));
    expect(guard.willNavigate(7, navigation(null, withNonce(entry, 'n1')))).toBe(true);
    expect(() => guard.claim(7, claimOf('n1'), mainFrame([]))).toThrow(/not bound to a navigation/);
  });

  it('denies a claim when no navigation pinned the frame', () => {
    const guard = new CustomPageFrameGuard();
    guard.prepare(7, target('n1'));
    const bound = frame(4, withNonce(entry, 'n1'), mainFrame([]));
    expect(() => guard.claim(7, claimOf('n1'), mainFrame([bound]))).toThrow(/not bound to a navigation/);
  });

  it('rejects a nonce shared by more than one direct child', () => {
    const guard = new CustomPageFrameGuard();
    guard.prepare(7, target('n1'));
    pin(guard, 4, 'n1');
    const main = mainFrame([
      frame(4, withNonce(entry, 'n1'), mainFrame([])),
      frame(5, withNonce(entry, 'n1'), mainFrame([])),
    ]);
    expect(() => guard.claim(7, claimOf('n1'), main)).toThrow(/ambiguous or missing/);
  });

  it('does not treat a nested frame as a direct child', () => {
    const guard = new CustomPageFrameGuard();
    guard.prepare(7, target('n1'));
    pin(guard, 5, 'n1');
    const child = frame(4, entry, mainFrame([]));
    const nested = frame(5, withNonce(entry, 'n1'), child);
    expect(() => guard.claim(7, claimOf('n1'), mainFrame([child, nested]))).toThrow(/ambiguous or missing/);
  });

  it('rejects a destroyed direct child', () => {
    const guard = new CustomPageFrameGuard();
    guard.prepare(7, target('n1'));
    pin(guard, 4, 'n1');
    const dead = frame(4, withNonce(entry, 'n1'), mainFrame([]), true);
    expect(() => guard.claim(7, claimOf('n1'), mainFrame([dead]))).toThrow(/ambiguous or missing/);
  });

  it('rejects duplicate nonces and mismatched instance/document key', () => {
    const guard = new CustomPageFrameGuard();
    guard.prepare(7, target('n1'));
    expect(() => guard.prepare(7, target('n1'))).toThrow(/already bound/);
    const bound = frame(4, withNonce(entry, 'n1'), mainFrame([]));
    expect(() => guard.claim(7, {instanceId: 'inst-b', nonce: 'n1', documentKey: 'key-a'}, mainFrame([bound])))
      .toThrow(/not prepared/);
    expect(() => guard.claim(7, {instanceId: 'inst-a', nonce: 'n1', documentKey: 'key-b'}, mainFrame([bound])))
      .toThrow(/not prepared/);
  });

  it('revokes pending and bound epochs when the window is revoked', () => {
    const guard = new CustomPageFrameGuard();
    guard.prepare(7, target('n1'));
    pin(guard, 4, 'n1');
    const bound = frame(4, withNonce(entry, 'n1'), mainFrame([]));
    guard.claim(7, claimOf('n1'), mainFrame([bound]));

    guard.revokeWindow(7);
    // A revoked frame stays blocked until it is destroyed.
    expect(guard.willNavigate(7, navigation(4, withNonce(entry, 'n1')))).toBe(true);
    guard.prepare(7, target('n2'));
    expect(() => guard.claim(7, claimOf('n1'), mainFrame([bound]))).toThrow(/not prepared/);
  });

  it('forgets tombstones when the window is torn down', () => {
    const guard = new CustomPageFrameGuard();
    guard.prepare(7, target('n1'));
    pin(guard, 4, 'n1');
    guard.claim(7, claimOf('n1'), mainFrame([frame(4, withNonce(entry, 'n1'), mainFrame([]))]));
    expect(guard.willNavigate(7, navigation(4, 'http://127.0.0.1/entry2.html'))).toBe(true);
    guard.forgetWindow(7);
    // A fresh frame id is never the old frame.
    expect(guard.willNavigate(7, navigation(9, 'http://127.0.0.1/other.html'))).toBe(false);
  });

  it('prunes frames that vanished from the subtree', () => {
    const guard = new CustomPageFrameGuard();
    guard.prepare(7, target('n1'));
    pin(guard, 4, 'n1');
    guard.claim(7, claimOf('n1'), mainFrame([frame(4, withNonce(entry, 'n1'), mainFrame([]))]));

    guard.prune(7, mainFrame([]));
    // The vanished frame is no longer active; a new frame id is a new binding.
    expect(guard.willNavigate(7, navigation(4, withNonce(entry, 'n1')))).toBe(false);
  });

  it('lets the main frame navigate and never binds it', () => {
    const guard = new CustomPageFrameGuard();
    guard.prepare(7, target('n1'));
    expect(guard.willNavigate(7, navigation(1, withNonce(entry, 'n1'), true))).toBe(false);
  });

  it('rejects malformed prepare and claim payloads', () => {
    const guard = new CustomPageFrameGuard();
    expect(() => guard.prepare(7, {...target('n1'), entryUrl: 'not a url'})).toThrow(/entry URL/);
    expect(() => guard.prepare(7, {...target('n1'), nonce: 'bad\nnonce'})).toThrow(/target/);
    expect(() => guard.claim(7, {instanceId: 'inst-a', nonce: '', documentKey: 'key-a'}, mainFrame([])))
      .toThrow(/claim/);
  });

  it('forwards revocations through the desktop host listener', () => {
    const host = makeHost();
    const seen: {webContentsId: number; revocation: CustomPageFrameRevocation}[] = [];
    host.onCustomPageRevoked((webContentsId, revocation) => seen.push({webContentsId, revocation}));
    host.registerWindow(7, 'main');
    host.prepareCustomPageFrame(7, target('n1'));
    host.customPageWillNavigate(7, navigation(4, withNonce(entry, 'n1')));
    host.claimCustomPageFrame(7, claimOf('n1'), mainFrame([frame(4, withNonce(entry, 'n1'), mainFrame([]))]));
    expect(host.customPageWillNavigate(7, navigation(4, 'http://127.0.0.1/entry2.html'))).toBe(true);
    expect(seen).toEqual([{webContentsId: 7, revocation: {
      instanceId: 'inst-a', nonce: 'n1', documentKey: 'key-a', frameTreeNodeId: 4, epoch: 1,
    }}]);
  });

  it('wires prepare/claim/revoke through the desktop host and unregisterWindow', () => {
    const host = makeHost();
    host.registerWindow(7, 'main');
    expect(host.prepareCustomPageFrame(7, target('n1'))).toEqual({epoch: 1});
    expect(host.customPageWillNavigate(7, navigation(4, withNonce(entry, 'n1')))).toBe(false);
    const bound = frame(4, withNonce(entry, 'n1'), mainFrame([]));
    expect(host.claimCustomPageFrame(7, claimOf('n1'), mainFrame([bound]))).toEqual({frameTreeNodeId: 4, epoch: 1});
    expect(host.customPageWillNavigate(7, navigation(4, withNonce(entry, 'n1')))).toBe(true);

    host.prepareCustomPageFrame(7, target('n2'));
    host.unregisterWindow(7);
    expect(() => host.claimCustomPageFrame(7, claimOf('n2'), mainFrame([frame(5, withNonce(entry, 'n2'), mainFrame([]))])))
      .toThrow(/not prepared/);
  });
});
