import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CustomPageBridge, bridgeContractVersion, BRIDGE_MAX_PENDING } from '../src/plugin-host/custom-page-bridge';

const frame = { postMessage(env: unknown) { posted.push(env); } };
const posted: unknown[] = [];
let visible = true;
const base = {
  instanceId: 'inst:one', nonce: 'n-9', frame,
  generation: () => generation, visible: () => visible, declared: ['read', 'command'],
  invoke: async (m: string, p: unknown) => { calls.push([m, p]); return 'value-' + m; },
  post: (e: unknown) => posted.push(e),
};
let generation = 1, calls: [string, unknown][] = [];
const env = (over: object = {}) => ({ contractVersion: bridgeContractVersion, nonce: 'n-9', instanceId: 'inst:one', generation, requestId: 'r1', kind: 'request', method: 'read', ...over });
const event = (data: unknown, source = frame) => ({ data, source }) as MessageEvent;

test('foreign source, forged nonce, guessed instance and stale generation never reach the invoker', async () => {
  const bridge = new CustomPageBridge(base);
  assert.equal(await bridge.accept(event(env(), { postMessage: () => {} })), false, 'wrong source');
  assert.equal(await bridge.accept(event(env({ nonce: 'x' }))), false, 'forged nonce');
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
  release(); await first;
  assert.equal(calls.length, 1, 'the duplicate never invoked');
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

test('checkpoints are host-bounded only — oversized writes are rejected', () => {
  assert.throws(() => CustomPageBridge.checkpoint('x'.repeat(200), null), /budget/);
  assert.throws(() => CustomPageBridge.checkpoint('id', 'y'.repeat(70000)), /budget/);
  assert.equal(CustomPageBridge.checkpoint('id', {a: 1}).id, 'id');
});
