import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { CustomPageBridge, bridgeContractVersion, BRIDGE_MAX_PENDING } from '../src/plugin-host/custom-page-bridge';
import { WebFeatureHost } from '../src/features/host';
import { bootstrapPlugins } from '../src/plugin-host/bootstrap';
import type { InstanceSnapshot } from '../src/plugin-host/contributions';
import { CustomPageMount, customPageDeclarations, type CustomPageManifest } from '../src/plugin-host/custom-page-navigation';

const posted: unknown[] = [];
let visible = true, alive = true;
const base = {
  instanceId: 'inst:one', nonce: 'n-9', documentKey: 'doc-1', documentAlive: () => alive,
  generation: () => generation, visible: () => visible, declared: ['read', 'command'],
  invoke: async (m: string, p: unknown) => { calls.push([m, p]); return 'value-' + m; },
  post: (e: unknown) => posted.push(e),
};
let generation = 1, calls: [string, unknown][] = [];
const env = (over: object = {}) => ({ contractVersion: bridgeContractVersion, nonce: 'n-9', documentKey: 'doc-1', instanceId: 'inst:one', generation, requestId: 'r1', kind: 'request', method: 'read', ...over });
const event = (data: unknown) => ({ data }) as {data?: unknown};

test('forged channel fields, guessed instance and stale generation never reach the invoker', async () => {
  const bridge = new CustomPageBridge(base);
  assert.equal(await bridge.accept(event({kind: 'request'})), false, 'malformed envelope');
  assert.equal(await bridge.accept(event(env({ nonce: 'x' }))), false, 'forged nonce');
  assert.equal(await bridge.accept(event(env({ documentKey: 'doc-2' }))), false, 'a replaced document never inherits the key');
  assert.equal(await bridge.accept(event(env({ instanceId: 'inst:two' }))), false, 'guessed instance');
  assert.equal(await bridge.accept(event(env({ generation: 2 }))), false, 'stale generation');
  assert.equal(await bridge.accept(event(env({ contractVersion: '9' }))), false);
  assert.equal(calls.length, 0, 'nothing reached the invoker');
});

test('a declared request invokes once and the response lands under the issuing generation', async () => {
  const bridge = new CustomPageBridge(base);
  assert.equal(await bridge.accept(event(env())), true);
  assert.deepEqual(calls, [['read', undefined]]);
  const reply = posted.at(-1) as { kind: string; method: string; payload: string; generation: number };
  assert.equal(reply.kind, 'response'); assert.equal(reply.payload, 'value-read'); assert.equal(reply.generation, 1);
});

test('undeclared methods, oversized payloads and request budgets are dropped', async () => {
  const bridge = new CustomPageBridge(base);
  assert.equal(await bridge.accept(event(env({ method: 'exec' }))), false, 'undeclared method');
  assert.equal(await bridge.accept(event(env({ payload: 'x'.repeat(70000) }))), false, 'oversized payload');
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const slow = new CustomPageBridge({ ...base, invoke: async () => { await gate; } });
  const accepted = [];
  for (let i = 0; i < BRIDGE_MAX_PENDING + 2; i++) accepted.push(slow.accept(event(env({ requestId: 'r' + i }))));
  release();
  const results = await Promise.all(accepted);
  assert.equal(results.filter(Boolean).length, BRIDGE_MAX_PENDING, 'request concurrency budget enforced');
});

test('hide refuses new reads, revoke kills the bridge and a stale channel can never invoke', async () => {
  calls = []; posted.length = 0;
  const bridge = new CustomPageBridge(base);
  bridge.hide();
  assert.equal(await bridge.accept(event(env())), false, 'hidden view reads nothing');
  visible = false;
  bridge.show();
  assert.equal(await bridge.accept(event(env())), false, 'a suspended lifetime still refuses reads');
  visible = true;
  assert.equal(await bridge.accept(event(env())), true, 'a visible lifetime admits again');
  bridge.revoke();
  assert.equal(await bridge.accept(event(env())), false, 'a revoked bridge never invokes');
  assert.equal(calls.length, 1, 'only the visible-era request invoked');
});

test('a late result in an old generation never posts back', async () => {
  posted.length = 0;
  let release!: (v: unknown) => void; const gate = new Promise(r => { release = r; });
  const bridge = new CustomPageBridge({ ...base, invoke: async () => { await gate; return 'late'; } });
  const done = bridge.accept(event(env()));
  generation = 2; // generation advanced while the request was in flight
  release(null);
  assert.equal(await done, true);
  assert.equal(posted.filter((p: any) => p.kind === 'response').length, 0, 'stale-generation response dropped');
});

test('duplicate pending requestIds and non-request kinds never invoke', async () => {
  calls = []; posted.length = 0;
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const slow = new CustomPageBridge({ ...base, invoke: async () => { calls.push(['read', undefined]); await gate; } });
  const first = slow.accept(event(env({requestId: 'dup'})));
  assert.equal(await slow.accept(event(env({requestId: 'dup'}))), false, 'a pending requestId is rejected, not overwritten');
  // Same id in a new generation is a new request — the pending key is
  // (generation, requestId), not the bare id.
  generation += 1;
  const second = slow.accept(event(env({requestId: 'dup'})));
  release(); await first;
  assert.equal(await second, true, 'a new-generation request with the same id is admitted');
  generation = 1;
  assert.equal(calls.length, 2, 'each admitted request invoked once; the same-generation duplicate never invoked');
  const bridge = new CustomPageBridge(base);
  for (const kind of ['response', 'event'] as const)
    assert.equal(await bridge.accept(event(env({kind, requestId: 'k-' + kind}))), false, kind + ' carries no request authority');
});

test('the total allowance renews per generation', async () => {
  calls = [];
  const bridge = new CustomPageBridge(base);
  assert.equal(await bridge.accept(event(env())), true);
  generation = 2; // a new view generation opens a fresh allowance
  assert.equal(await bridge.accept(event(env({requestId: 'g2'}))), true);
});

test('strict wire: binary, cyclic, BigInt, non-JSON and oversized fields are refused without throwing', async () => {
  calls = [];
  const bridge = new CustomPageBridge(base);
  const cyclic: {self?: unknown} = {}; cyclic.self = cyclic;
  const cases: [unknown, string][] = [
    [env({payload: {buffer: new ArrayBuffer(1 << 20)}}), 'ArrayBuffer inside a real envelope'],
    [env({payload: cyclic}), 'cyclic payload inside a real envelope'],
    [env({payload: {big: BigInt(1)}}), 'BigInt inside a real envelope'],
    [env({payload: {fn: () => 1}}), 'function inside a real envelope'],
    ['raw string', 'non-envelope value'],
    [env({requestId: 'x'.repeat(400)}), 'oversized requestId'],
    [env({payload: {blob: new Uint8Array(4)}}), 'typed-array inside a real envelope'],
    [env({payload: {limit: undefined}}), 'nested undefined is not a wire value'],
    [env({payload: [1, undefined, 3]}), 'sparse array slot is not a wire value'],
    [env({extraField: new ArrayBuffer(8)}), 'binary extra field is not a wire value'],
    [env({extraField: 'x'.repeat(70000)}), 'extra field cannot bypass the wire budget'],
  ];
  for (const [data, what] of cases)
    assert.equal(await bridge.accept(event(data)), false, what);
  assert.equal(calls.length, 0, 'no case invoked');
  // Legitimate deep nesting within the byte budget is admitted — no
  // artificial depth restriction on JSON payloads.
  const deep = {a:{b:{c:{d:{e:{f:{g:{h:{i:1}}}}}}}}};
  assert.equal(await bridge.accept(event(env({requestId: 'deep', payload: deep}))), true, 'deeply-nested valid JSON is admitted');
});

test('a rejected invoke posts one correlated bounded failure and releases the slot', async () => {
  calls = []; posted.length = 0;
  const bridge = new CustomPageBridge({...base, invoke: async () => { throw new Error('failure-' + 'x'.repeat(400)); }});
  assert.equal(await bridge.accept(event(env())), true, 'rejection resolves accept — no unhandled rejection');
  const reply = posted.at(-1) as {kind: string; ok: boolean; error: string; requestId: string};
  assert.equal(reply.kind, 'response'); assert.equal(reply.ok, false);
  assert.equal(reply.requestId, 'r1');
  assert.equal(reply.error, 'invoke_failed', 'stable public failure — no internal message leaks');
  assert.equal(await bridge.accept(event(env())), true, 'the pending slot was released');
});

test('a late failure after revocation or generation change never posts', async () => {
  posted.length = 0;
  let release!: () => void; const gate = new Promise<void>((_, reject) => { release = () => reject(new Error('late')); });
  const bridge = new CustomPageBridge({...base, invoke: async () => { await gate; }});
  const done = bridge.accept(event(env()));
  bridge.revoke(); release();
  assert.equal(await done, true);
  assert.equal(posted.length, 0, 'revoked-channel failure is suppressed');
});

test('a request built solely from the channel handshake is admitted — epoch other than 1', async () => {
  calls = [];
  const epoch = 7;
  const bridge = new CustomPageBridge({...base, generation: () => epoch});
  // The handshake delivers contractVersion, nonce, documentKey,
  // instanceId and the granted epoch — nothing else is needed.
  const handshake = {contractVersion: '1', nonce: 'n-9', documentKey: 'doc-1', instanceId: 'inst:one', generation: epoch, kind: 'channel'};
  const request = {...env(), contractVersion: handshake.contractVersion, nonce: handshake.nonce, documentKey: handshake.documentKey, instanceId: handshake.instanceId, generation: handshake.generation, requestId: 'first', kind: 'request' as const, method: 'read'};
  assert.equal(await bridge.accept(event(request)), true);
  assert.deepEqual(calls, [['read', undefined]]);
});

test('checkpoints are host-bounded only — oversized writes are rejected', () => {
  assert.throws(() => CustomPageBridge.checkpoint('x'.repeat(200), null), /budget/);
  assert.throws(() => CustomPageBridge.checkpoint('id', 'y'.repeat(70000)), /budget/);
  assert.equal(CustomPageBridge.checkpoint('id', {a: 1}).id, 'id');
});

// --- U08A: manifest custom pages mount into navigation ------------------------

const manifest: CustomPageManifest = {
  id: 'generated.custom', name: 'Generated custom',
  contributions: [{id: 'generated.custom.page', surface: 'page', runtime: 'host', entry: 'page.html'}],
};
const declarations = () => customPageDeclarations(manifest, {
  resolveEntry: entry => 'https://plugins.test/generated/' + entry,
  declared: () => ['read'],
  invoke: async method => 'ok-' + method,
});
const customInstance = (): InstanceSnapshot => ({
  packageId: 'generated.custom', installationId: 'ext:custom', instanceId: 'inst:custom',
  desired: 'active', compatible: true, loader: 'external', contributions: [], customPages: declarations(),
});
const mountBridge = (instanceId = 'inst:custom', nonce = 'mount-nonce', documentKey = 'mount-doc') => {
  const calls: [string, unknown][] = [];
  const bridge = new CustomPageBridge({
    instanceId, nonce, documentKey, documentAlive: () => true, generation: () => 1,
    visible: () => true, declared: ['read'],
    invoke: async (method, payload) => { calls.push([method, payload]); return 'ok-' + method; },
    post: () => {},
  });
  const request = () => ({data: {
    contractVersion: bridgeContractVersion, nonce, documentKey, instanceId,
    generation: 1, requestId: 'r-mount', kind: 'request', method: 'read',
  }});
  return {bridge, calls, request};
};

test('a manifest custom page mounts into navigation and opens its declared bridge', async () => {
  assert.equal(declarations().length, 1, 'the executable page contribution projects');
  assert.equal(customPageDeclarations({...manifest, contributions: [{id: 'generated.declarative', surface: 'page', runtime: 'host'}]}, {
    resolveEntry: () => 'https://plugins.test/should-not-load',
  }).length, 0, 'a declarative page without an entry document is not a custom page');
  const host = new WebFeatureHost();
  const {reports, scopes} = await bootstrapPlugins(host, [customInstance()]);
  assert.deepEqual(reports[0]!.outcome, {observed: 'mounted'}, 'a host-owned custom page needs no external bundle loader');
  const page = host.pages()[0]!;
  assert.equal(page.id, 'inst:custom/generated.custom.page', 'the page key is instance-qualified');
  assert.equal(page.route, 'plugin/inst%3Acustom/generated.custom.page');
  assert.equal(page.label, 'Generated custom');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {value: {location: {href: 'https://host.test/'}}, configurable: true});
  try {
    const markup = renderToStaticMarkup(page.render({} as never));
    assert.match(markup, /class="plugin-custom-page"/, 'navigation renders the host-owned CustomPluginPage');
    assert.match(markup, /src="https:\/\/plugins.test\/generated\/page.html"/, 'the isolated entry URL is the resolved manifest entry');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
  const mount = scopes.get('inst:custom')!.customPages!.mounts.get('generated.custom.page')!;
  const {bridge, calls, request} = mountBridge();
  mount.attach(bridge);
  assert.equal(mount.active, bridge, 'the issued channel is owned by the mounted page');
  assert.equal(await bridge.accept(request()), true);
  assert.deepEqual(calls, [['read', undefined]], 'the declared bridge request reaches the host invoker');
});

test('unmounting the page or uninstalling its plugin closes the bridge', async () => {
  const host = new WebFeatureHost();
  const {scopes} = await bootstrapPlugins(host, [customInstance()]);
  const scope = scopes.get('inst:custom')!;
  const mount = scope.customPages!.mounts.get('generated.custom.page')!;
  const first = mountBridge();
  mount.attach(first.bridge);
  mount.unmount();
  assert.equal(mount.active, null, 'navigation unmount clears the issue slot');
  assert.equal(await first.bridge.accept(first.request()), false, 'an unmounted page bridge never invokes');

  const second = mountBridge('inst:custom', 'uninstall-nonce', 'uninstall-doc');
  mount.attach(second.bridge);
  await scope.rollback();
  assert.equal(host.pages().length, 0, 'uninstall withdraws the navigable entry');
  assert.equal(mount.active, null, 'scope rollback closes the live bridge');
  assert.equal(await second.bridge.accept(second.request()), false, 'a rolled-back page bridge never invokes');
});

test('revocation clears the live bridge and fences a late claim', async () => {
  const mount = new CustomPageMount();
  const first = mountBridge('inst:custom', 'revoked-nonce', 'revoked-doc');
  mount.attach(first.bridge);
  mount.revoke();
  assert.equal(mount.revoked, true);
  assert.equal(mount.active, null, 'revocation clears the issued bridge');
  assert.equal(await first.bridge.accept(first.request()), false);

  const late = mountBridge('inst:custom', 'late-nonce', 'late-doc');
  mount.attach(late.bridge);
  assert.equal(mount.active, null, 'a late claim never rebuilds the channel');
  assert.equal(await late.bridge.accept(late.request()), false);
});
