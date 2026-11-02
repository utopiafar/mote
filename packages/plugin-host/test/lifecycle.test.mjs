import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, connect} from 'node:net';
import {Context} from '@deepseek-ai/cordis';
import {serviceContract, pluginSnapshotSchema} from '@mote/plugin-api/contracts';
import {PluginHost, PluginResourceScope} from '@mote/plugin-host';

const hostId = {kind: 'central', id: 'generated-host-1'};
const identity = name => ({host: hostId, packageId: 'fixture.plugin', installationId: 'fixture-install', instanceId: name, activationId: name + '-activation'});
const lifecycle = (overrides = {}) => ({prepare() {}, start() {}, quiesce() {}, stop() {}, dispose() {}, ...overrides});
const reader = serviceContract('fixture.reader', '1');
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const hasFailure = (error, target) => error === target || error instanceof AggregateError && error.errors.some(item => hasFailure(item, target));
function roundTrip(port) {
  return new Promise((resolve, reject) => {
    const socket = connect({host: '127.0.0.1', port}); let text = '';
    socket.on('data', bytes => { text += bytes.toString(); }); socket.on('end', () => resolve(text)); socket.on('error', reject);
  });
}
async function networkPlugin(host, name) {
  let binding, server, ticks = 0;
  const firstTick = gate();
  const handle = await host.install({identity: identity(name), contributions: [reader], factory: async context => {
    server = createServer(socket => { context.scope.defer(() => { socket.destroy(); }); socket.end(name); });
    context.scope.defer(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    context.scope.every(1, () => { ticks++; firstTick.resolve(); });
    binding = context.provide(reader.id, reader, Object.freeze({port: server.address().port, name}));
    return lifecycle();
  }});
  await firstTick.promise;
  return {handle, binding, server, ticks: () => ticks};
}

test('two real plugins own independent listeners/timers and closing one leaves its sibling callable', {timeout: 5000}, async t => {
  const root = new Context(), host = new PluginHost(hostId, root);
  root.provide('fixtureUnrelated', {alive: true});
  t.after(async () => { await host.close(); await root.fiber.dispose(); });
  const a = await networkPlugin(host, 'one'), b = await networkPlugin(host, 'two');
  let consumerLease, consumerClosed = 0;
  await host.install({identity: identity('network-consumer'), contributions: [], requires: [a.binding], factory: async context => {
    consumerLease = await context.services.acquire(reader, a.binding);
    context.scope.defer(() => { consumerClosed++; });
    return lifecycle();
  }});
  assert.equal(await roundTrip(consumerLease.value.port), 'one');
  const leaseA = await host.acquire(reader, a.binding), leaseB = await host.acquire(reader, b.binding);
  assert.equal(await roundTrip(leaseA.value.port), 'one'); assert.equal(await roundTrip(leaseB.value.port), 'two');
  await a.handle.close(); const stopped = a.ticks();
  assert.equal(a.server.listening, false); assert.equal(leaseA.signal.aborted, true);
  assert.equal(consumerLease.signal.aborted, true); assert.equal(consumerClosed, 1);
  assert.throws(() => leaseA.assertCurrent(), {code: 'dependency_unavailable'});
  assert.equal(await roundTrip(leaseB.value.port), 'two'); assert.equal(a.ticks(), stopped);
  assert.equal(b.server.listening, true); assert.ok(b.ticks() > 0);
  const snapshot = pluginSnapshotSchema.parse(JSON.parse(JSON.stringify(host.snapshot())));
  assert.equal(snapshot.contributions.length, 1); assert.equal(snapshot.contributions[0].identity.scope.instanceId, 'two');
  await leaseA.release(); await leaseB.release();
  await host.close(); assert.equal(root.get('fixtureUnrelated').alive, true);
});

test('optional provider loss revokes its lease while the consumer remains active', async t => {
  const host = new PluginHost(hostId); let binding, optionalLease, consumerSignal;
  t.after(() => host.close());
  const provider = await host.install({identity: identity('optional-provider'), contributions: [reader], factory: context => {
    binding = context.provide(reader.id, reader, {read() { return 'generated'; }}); return lifecycle();
  }});
  await host.install({identity: identity('optional-consumer'), contributions: [], optional: [binding], factory: async context => {
    consumerSignal = context.scope.signal; optionalLease = await context.services.acquire(reader, binding); return lifecycle();
  }});
  assert.equal(optionalLease.value.read(), 'generated'); await provider.close();
  assert.equal(optionalLease.signal.aborted, true); assert.equal(consumerSignal.aborted, false);
  assert.throws(() => optionalLease.value.read(), {code: 'dependency_unavailable'});
});

test('install pins the admitted factory instead of reading a mutated definition during async startup', async t => {
  const host = new PluginHost(hostId); let selected = '';
  t.after(() => host.close());
  const definition = {identity: identity('pinned-factory'), contributions: [], factory() { selected = 'admitted'; return lifecycle(); }};
  const installing = host.install(definition);
  definition.factory = () => { selected = 'mutated'; return lifecycle(); };
  await installing; assert.equal(selected, 'admitted');
});

test('partially initialized provider closes its actual listener and preserves the primary failure', {timeout: 5000}, async t => {
  const host = new PluginHost(hostId), failure = Error('generated prepare failure'); let server;
  t.after(() => host.close());
  await assert.rejects(host.install({identity: identity('partial'), contributions: [reader], factory: async context => {
    server = createServer();
    context.scope.defer(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    context.provide(reader.id, reader, {read() { return 'must-not-publish'; }});
    return lifecycle({prepare() { throw failure; }});
  }}), error => hasFailure(error, failure));
  assert.equal(server.listening, false); assert.equal(host.snapshot().contributions.length, 0);
});

test('stop fences an uncooperative late call and stops real required consumers without affecting siblings', {timeout: 5000}, async t => {
  const host = new PluginHost(hostId), entered = gate(), held = gate(); let binding, consumerSignal, committed = 0, consumerClosed = 0;
  t.after(async () => { held.resolve(); await host.close(); });
  const provider = await host.install({identity: identity('writer'), contributions: [reader], factory: context => {
    binding = context.provide(reader.id, reader, {async write() { entered.resolve(); await held.promise; context.scope.assertCurrent(); committed++; return 'late'; }});
    return lifecycle();
  }});
  await host.install({identity: identity('consumer'), contributions: [], requires: [binding], factory: context => {
    consumerSignal = context.scope.signal; context.scope.defer(() => { consumerClosed++; }); return lifecycle();
  }});
  const lease = await host.acquire(reader, binding), cached = lease.value.write;
  const late = cached(); const rejected = assert.rejects(late, error => error.code === 'stale_scope');
  await entered.promise; const closing = provider.close('revoked');
  assert.equal(provider.signal.aborted, true); assert.equal(consumerSignal.aborted, true);
  assert.throws(() => cached(), {code: 'stale_scope'});
  held.resolve(); await rejected; await closing;
  assert.equal(committed, 0); assert.equal(consumerClosed, 1);
  await lease.release();
});

test('quiesce rejects new acquisitions while an accepted fixed lease can drain, release only invalidates itself', async t => {
  const host = new PluginHost(hostId); let binding, calls = 0, closes = 0;
  t.after(() => host.close());
  const provider = await host.install({identity: identity('pin'), contributions: [reader], factory: context => {
    binding = context.provide(reader.id, reader, Object.freeze({read() { return ++calls; }}), 4);
    return lifecycle({dispose() { closes++; }});
  }});
  const first = await host.acquire(reader, binding), second = await host.acquire(reader, binding), cached = first.value.read;
  await provider.quiesce();
  assert.equal(first.signal.aborted, false); first.assertCurrent(); assert.equal(first.value.read(), 1);
  await assert.rejects(host.acquire(reader, binding), {code: 'dependency_unavailable'});
  const releasing = first.release(); assert.equal(first.release(), releasing); await releasing;
  assert.throws(() => cached(), {code: 'stale_scope'}); assert.equal(second.value.read(), 2); assert.equal(closes, 0);
  await second.release(); await provider.close(); assert.equal(closes, 1);
});

test('exact API and provider revision are checked and undeclared dependencies cannot be acquired', async t => {
  const host = new PluginHost(hostId); let binding;
  t.after(() => host.close());
  await host.install({identity: identity('exact'), contributions: [reader], factory: context => {
    binding = context.provide(reader.id, reader, {read() {}}, 2); return lifecycle();
  }});
  await assert.rejects(host.acquire(serviceContract(reader.id, '2'), binding), {code: 'api_incompatible'});
  await assert.rejects(host.acquire(reader, {...binding, revision: 3}), {code: 'conflict'});
  await assert.rejects(host.install({identity: identity('undeclared'), contributions: [], factory: async context => {
    await context.services.acquire(reader, binding); return lifecycle();
  }}), error => error.code === 'permission_denied');
});

test('host close joins in-flight factory setup, reclaims late registered resources and cannot publish after stop', {timeout: 5000}, async () => {
  const host = new PluginHost(hostId), entered = gate(), held = gate(); let disposed = 0, signal;
  const installing = host.install({identity: identity('held-setup'), contributions: [reader], factory: async context => {
    signal = context.scope.signal; entered.resolve(); await held.promise;
    context.scope.defer(() => { disposed++; }); context.provide(reader.id, reader, {read() {}}); return lifecycle();
  }});
  const rejected = assert.rejects(installing, error => error.code === 'stale_scope');
  await entered.promise; const closing = host.close(); assert.equal(host.close(), closing); assert.equal(signal.aborted, true);
  held.resolve(); await rejected; await closing;
  assert.equal(disposed, 1); assert.equal(host.snapshot().contributions.length, 0);
});

test('resource close is reentrant/idempotent, preserves cleanup errors, and retires after accepted work', async () => {
  const scope = new PluginResourceScope(), held = gate(), events = []; let reentrant;
  scope.signal.addEventListener('abort', () => { reentrant = scope.close(); });
  const work = scope.run(async () => { events.push('running'); await held.promise; scope.defer(() => { events.push('late-resource'); }); events.push('settled'); });
  await Promise.resolve();
  const first = Error('generated first'), second = Error('generated second');
  scope.defer(() => { events.push('first'); throw first; }); scope.defer(() => { events.push('second'); throw second; });
  scope.retire(() => { events.push('retired'); });
  const closing = scope.close(); assert.equal(reentrant, closing); assert.equal(scope.close(), closing);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(events, ['running', 'second', 'first']);
  held.resolve(); await work;
  await assert.rejects(closing, error => error instanceof AggregateError && error.errors.length === 2 && hasFailure(error, first) && hasFailure(error, second));
  assert.deepEqual(events, ['running', 'second', 'first', 'settled', 'late-resource', 'retired']);
});
