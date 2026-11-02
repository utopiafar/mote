import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CustomPageBridge, bridgeContractVersion, BRIDGE_MAX_PENDING } from '../src/plugin-host/custom-page-bridge';

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
